// The paid relayer: relay balances (docs/design/relay-balance.md, binding contract
// docs/design/relay-balance-contract.md §3 and §4).
//
// A user tops up a per-account relay balance with a plain BTC payment to a fresh
// deposit address of the relayer's pool key Q. Once the deposit has its
// confirmations the relayer credits it (value minus the cost of later spending
// it). A signed submit then carries that user's private transfer in a carrier
// funded from pool coins, and charges the exact carrier fee plus a margin to the
// balance before the signature is released. The operator never pays any part of
// a user's transaction (I-PAY):
//
//   I0 provenance  assertProvenance(): only credited deposit coins and outputs of
//                  the relayer's own journaled transactions are ever signed. No
//                  address is ever listed; coins anyone else sends are invisible.
//   I1 coverage    signPoolTx(), the only signing call site in this file: outputs
//                  pay only the OP_RETURN and the change key C, the fee is read
//                  from the final transaction and charged to the balance (or, for
//                  fan-outs, to the margin account), and the pool coins must still
//                  cover every balance, reservation and the margin.
//   I2 books       checkBooks(): every block, the books add up and the pool covers
//                  them, or the relayer halts (no new signature) until they do.
//
// There is no free mode, no budget the operator funds, and no command that adds
// coins to the pool other than a credited deposit. A broadcast transaction is
// never replaced or accelerated: a stuck user pays the fee with the same envelope.
//
// A TRANSACT envelope does not depend on its carrier (extDataHash covers only the
// body), so anyone can carry it. The relayer is non-custodial (the proof locks
// every byte) but it is trusted for liveness, and it knows which account sent
// which relayed transfer, the IP and the time. Every state change that precedes a
// broadcast is journaled to disk first (tmp file, fsync, rename).
//
// Relay timing (docs/design/batch-contract.md §3): "block" goes with the next
// block, "fast" at once; "batch" (Hourly batch, 6 blocks) and "batch10" (10-hour
// batch, 60 blocks) are anchored at their epoch start S and released together at
// S + E. An item whose balance is short or whose fee is above the cap at release
// becomes "missed" (nothing charged); the rest of its epoch goes out on time.
//
// Mining claims (docs/design/mining.md §9, binding contract mining-contract.md §9): once
// the indexer applies mining at the next block, the relayer also carries MINE_SCRIPT claims
// bound to its change key C (bindScriptHash = sha256(C.script)), in "block" or "fast" mode
// only. The work is checked in the indexer's Argon2 worker pool (idx.pow), never on this
// thread. A claim's carrier pays the service-fee outputs that the relayer's own indexer
// requires for that asset (never anything from the request), funded from confirmed C coins
// only; its change is not spent until it confirms. The claim is debited miner fee + service
// fees + margin before the signature (I-PAY extended); `serviceOut` in the books counts the
// service fees paid. A claim is signed only while tip <= ref + 9 and re-broadcast only while
// tip <= ref + 11.
//
// Privacy of the pool (docs/design/privacy-trace-test.md L1, L2, L5):
//   L1 lineage     every unspent pool coin carries `mix`, the opaque tags (HMAC under a key derived
//                  from the pool secret) of the distinct depositing accounts its value descends
//                  from. A merge takes fresh deposits together with a pool coin of other accounts
//                  when one exists (mergePlan, shared with fundingCoins so the published cover is
//                  what the next merge delivers). A carrier spends only a coin whose lineage holds
//                  at least `minMix` + 1 accounts (MURKLE_RELAY_MIN_MIX = k), whoever sends: the
//                  rule does not depend on the sender, so the coin a carrier spends says nothing
//                  about whether its sender is in its lineage (a sender in it still has k others). Without such a
//                  coin the pool is "thin": submit answers 409 pool_thin unless the signed request
//                  says `linkable: true`. Housekeeping is still paid from the margin only (I-PAY
//                  unchanged). A spent coin's tags are dropped once its spender confirms.
//   L2 files       a settled item is saved without its cost, submit height, mode, anchor or any
//                  other per-item amount (persistedItem). Accounts are stored under an opaque key
//                  (HMAC of the account id), never the id, so the files do not give the ids from
//                  which deposit addresses follow; a deposit the pool still holds keeps only its
//                  tweak. A credit whose deposit is gone, once wallets stop warning about it (5
//                  relayed transfers landed since, or `creditKeepBlocks` deep), is settled
//                  (relay-books.mjs settleCredit): it no longer says whose it was, so Σ credits −
//                  balance cannot be formed per account from the files.
//   L5 shape       every input signals RBF (0xfffffffd), one fee rule (whole sat/vB x ceil(vsize)),
//                  merge inputs and fan-out / claim change positions are random; the OP_RETURN
//                  stays output 0.
//
// Emergencies (relay-balance.md §9, server/relay-evacuate.mjs): a HOLD file in the relay directory
// (written by `murkle relayer evacuate` and the other operator tools) freezes a running relayer: it
// refuses every new send and credit at once (503 relayer_evacuating, pool_unfunded or maintenance),
// releases its queued items when the hold is an evacuation, saves once, writes HOLD.ack and never
// writes its files again until it is restarted without the hold (nor, while the hold is in place,
// over a file a tool wrote). Balances are never touched. After a rotation the relayer refuses
// sends and credits (pool_unfunded) until the operator has refilled the new pool and I2 holds
// again (a held coin counts only once it is in a block); a payment to a deposit address of a
// retired pool key is recorded (409 deposit_retired) and credited only once the operator has swept
// it into the pool and the pool covers it.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash, createHmac, randomBytes, randomInt } from "node:crypto";
import { dirname, join, resolve as resolvePath } from "node:path";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import { FEE_HEADROOM, NETWORK as BTC_NETWORK, RBF_SEQUENCE, btcAccount, dustLimit, feeFor, feeOf, planCarrierTx, signInputs } from "../src/btc/funding.mjs";
import { isNullOutpoint, parseBlock, parseRawTx } from "../src/btc/block.mjs";
import { CheckError, checkInclusion } from "../src/verify-tx.mjs";
import { MAGIC, OP, VERSION, decodeEnvelope, envelopeLen, findEnvelope, headerOp, opReturnScript } from "../src/envelope.mjs";
import { ANCHOR_WINDOW, UNDO_DEPTH } from "../src/indexer.mjs";
import { feeOutputsPaid, meetsTarget, requiredFeeOutputs, targetOf } from "../src/mine.mjs";
import {
  BATCH_MODES, DEFAULT_CAPS, DEFAULT_PER_IP, DEFAULT_SAFETY, EPOCH_BLOCKS,
  epochKey, epochStart, isBatchMode, isMode, lastReleaseHeight, releaseHeight,
} from "../src/relay-batch.mjs";
import { MINE_SLACK, MINE_WINDOW, NETWORK, env } from "../src/params.mjs";
import { concat, equal, hex, readU64le, unhex } from "../src/bytes.mjs";
import {
  DEPOSIT_CONFIRMATIONS, MAX_DEPOSIT_INDEX, RELAY_ENDPOINTS, RELAY_SIGN_TAG, REQUEST_FIELDS,
  accountIdOf, depositAddress, depositKeyOfTweak, depositSecretOfTweak, depositTweak, parseAccountPub, parseOutpoint, requestDigest,
  tweakHex, verifyRequest,
} from "../src/relay-account.mjs";
import { BooksError, RelayBooks, costFor, marginFor, sweepCostFor } from "./relay-books.mjs";
import { readRelayerKey } from "./retired-relay.mjs";

export const STATE_VERSION = 2;
const DUST = 330;
const MAX_CHAIN_DEPTH = 20; // unconfirmed ancestors we stack on our own change (mempool limit is 25)
const MAX_DESCENDANTS = 24; // carriers below one unconfirmed fan-out (mempool limit: 25 with the fan-out)
const CHAIN_LEN = MAX_CHAIN_DEPTH + 1; // carriers one confirmed coin can fund in one block (depths 0..20)
const RECENT_EPOCHS = 24; // per batch length, in info().batch.recent
const BLOCK_SECONDS = 600;
const MAX_BROADCAST_ATTEMPTS = 3;
const KEEP_RAW_CONFS = 6;
const PRUNE_FINAL_AFTER = 1008;
const REORG_DEPTH = 6; // credits shallower than this are re-checked every tick
const VANISHED_TICKS = 2; // consecutive 404 answers before a credited deposit is reversed
const MAX_MERGE_INPUTS = 50; // deposits merged into C by one housekeeping transaction
const MERGE_ROOM = 10; // merge a fresh deposit at once while change coins fund fewer than waiting + 10 carriers
const MIX_CAP = 64; // lineage tags kept per coin: a full set proves at least 64 accounts (minMix is at most 32)
// Wallets warn about a top-up until this many relayed transfers have landed since it (web
// session.js RECENT_DEPOSIT_LANDED, CLI RECENT_LANDED); a credit is settled after that (L2).
const RECENT_LANDED = 5;
const MIX_LABEL = "murkle/relay-mix/v1"; // the lineage tag key is HMAC(pool secret, MIX_LABEL)
const ACCOUNT_LABEL = "murkle/relay-account-key/v1"; // books keys: HMAC(HMAC(pool secret, ACCOUNT_LABEL), account id)
/**
 * Files of the relay directory besides pool.key, change.key and relayer.json (relay-balance.md §9):
 * HOLD (an operator tool asks a running relayer to freeze; JSON { reason, nonce, at }), HOLD.ack
 * (the relayer froze; { nonce, pid, at, height }), account-tags.key (after a rotation: the books and
 * lineage keys of the first pool key, so every account keeps its stored key) and retired/g<N>/
 * (the keys and the last state of a rotated-out generation).
 */
export const RELAY_FILES = Object.freeze({ hold: "HOLD", ack: "HOLD.ack", tags: "account-tags.key", retired: "retired" });
export const HOLD_REASONS = Object.freeze(["evacuate", "maintenance"]);
/** The one nSequence every input this software builds carries (L5), from src/btc/funding.mjs. */
export { RBF_SEQUENCE };
/** The one fee rule (L5, src/btc/funding.mjs feeFor): a whole sat/vB rate (rounded up) times the vsize rounded up. */
export const feeAt = (rate, vsize) => Number(feeFor(Math.ceil(Number(rate)), vsize));
export const MAX_REPLAYS = 100_000; // remembered submit signatures; beyond this a submit answers busy
const CREDIT_MISS_CACHE = 10_000; // explorer "unknown txid" answers remembered (this block, at most a minute)
const HOUR = 3600_000;
const REPLAY_MS = 1_200_000; // submit signatures are remembered for 1,200 s (twice the clock skew)
// A TRANSACT (471 bytes) or a MINE_SCRIPT claim (511 bytes).
const ENVELOPE_HEX = new RegExp(`^(?:[0-9a-f]{${envelopeLen(OP.TRANSACT) * 2}}|[0-9a-f]{${envelopeLen(OP.MINE_SCRIPT) * 2}})$`);
const ASSET_OFFSET = MAGIC.length + 2 + 4; // MINE / MINE_SCRIPT: header, refHeight u32, then publicAsset u64
const MINE_MODES = new Set(["block", "fast"]); // batch modes would land after the 12-block window
const isMineItem = (i) => i.kind === "mine";
/** A PowError of src/pow-pool.mjs (a failed, dead, busy or closed worker): never a verdict. */
const isPowError = (e) => e?.name === "PowError" || /^POW_/.test(String(e?.code ?? ""));
const HEX32 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f]{32}$/;
const FINAL = new Set(["accepted", "rejected", "expired", "dropped", "missed"]);
const IN_FLIGHT = new Set(["queued", "signing", "broadcast"]);
// The exact signed key sets come from the shared module, so the wallet, the CLI and the relayer agree.
const SUBMIT_KEYS = [...REQUEST_FIELDS[RELAY_ENDPOINTS.submit]].sort();
// A submit is the base key set, or the base plus the signed boolean `linkable` (L1: the sender
// accepts that a thin pool ties the carrier's input to few depositors, possibly only itself);
// both come from the shared module (REQUEST_FIELDS, OPTIONAL_REQUEST_FIELDS).
const SUBMIT_BASE = SUBMIT_KEYS.filter((k) => k !== "linkable");
const SUBMIT_LINKABLE = [...SUBMIT_BASE, "linkable"].sort();
const ACCOUNT_KEYS = [...REQUEST_FIELDS[RELAY_ENDPOINTS.account]].sort();
const CREDIT_KEYS = ["accountPub", "n", "outpoint"];
const isWaiting = (i) => i.status === "queued" || i.status === "signing"; // still needs its carrier sent
// Held until its releaseAt and sent whole with its epoch: every batch item, and an item an
// older relayer accepted in a retired length ("batch12"), which keeps the releaseAt and
// lastRelease its 202 promised. Next-block and fast items have no releaseAt.
const isHeld = (i) => i.releaseAt != null;
const sameKeys = (o, keys) => o && typeof o === "object" && !Array.isArray(o) && Object.keys(o).sort().join() === keys.join();
const isNotFound = (e) => /\b404\b|not found|no such/i.test(String(e?.message ?? e));
/** signPoolTx refused (books, I0 or I1) rather than failed (a save, a bug). */
const refusal = (e) => e instanceof BooksError || /^I[01]: /.test(String(e?.message));
/** Runs a books call whose reference may already be settled; "unknown_ref" is not an error here. */
function known(fn) {
  try {
    return fn();
  } catch (e) {
    if (e instanceof BooksError && e.code === "unknown_ref") return null;
    throw e;
  }
}

/**
 * The fee-level settings that differ per network (mainnet-readiness.md §4.7). Mainnet fees are one
 * to three orders of magnitude above signet's, so the caps, the deposit floor, the margin floor, the
 * fan-out coin size and the penalties scale with them. Same model on both: users prepay, I-PAY (the
 * operator never pays a user's fee) and the books are unchanged, and there is no free mode. Every
 * MURKLE_* override still applies on top.
 */
export const NETWORK_DEFAULTS = Object.freeze({
  signet: Object.freeze({
    maxFeeRate: 5,
    maxFeePerTx: 3000,
    marginMinSats: 50,
    minDepositSats: 2000,
    invalidProofSats: 50,
    fanoutTarget: 24,
    fanoutValue: 13_000, // one full chain of 21 carriers at 1 sat/vB
    fanoutMinCarriers: 120, // fan out when confirmed coins fund fewer carriers than this in one block
    invalidPowSats: 20, // margin penalty for refused work
    minMix: 3, // a carrier's coin descends from at least 3 + 1 accounts: 3 others, whoever sends (L1)
  }),
  mainnet: Object.freeze({
    maxFeeRate: 50, // above it sends answer fee_high instead of charging users spike fees
    maxFeePerTx: 45_000, // a claim carrier: 684 vB x ceil(50 x 1.25) = 43,092
    marginMinSats: 300, // housekeeping (merges, fan-outs) is paid from the margin at mainnet rates
    // sweepCostFor(50) = 2,875 plus two transfer carriers at the 50 sat/vB cap (597 vB x 50 = 29,850
    // + 10% margin = 32,835 each): 68,545, rounded up. A minimum deposit always pays two sends.
    minDepositSats: 70_000,
    invalidProofSats: 500, // the penalty stays meaningful against verification cost
    fanoutTarget: 8, // less user money parked in fan-out coins
    fanoutValue: 130_000, // one chain of 21 carriers at about 10 sat/vB
    fanoutMinCarriers: 40,
    invalidPowSats: 200,
    minMix: 5,
  }),
});
const NET_DEFAULTS = NETWORK_DEFAULTS[NETWORK];

/**
 * Defaults of this network (signet values unchanged). `keyPath` and `statePath` name the retired
 * v1 files: read-only, never pool money.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  relayMode: null,
  relayDir: `data/${NETWORK}/relay-balance`,
  keyPath: `data/${NETWORK}/relayer.key`,
  statePath: `data/${NETWORK}/relayer.json`,
  maxFeeRate: NET_DEFAULTS.maxFeeRate,
  maxFeePerTx: NET_DEFAULTS.maxFeePerTx,
  maxRelaysPerBlock: 40,
  maxQueue: 120,
  safetyBlocks: DEFAULT_SAFETY.batch, // 24: Next-block, fast and Hourly batch
  batch10SafetyBlocks: DEFAULT_SAFETY.batch10, // 12: the 10-hour batch may go out until S + 88
  maxBatchPerEpoch: DEFAULT_CAPS.batch, // 40 per Hourly batch; 0 turns it off
  maxBatch10PerEpoch: DEFAULT_CAPS.batch10, // 120 per 10-hour batch; 0 turns it off
  batchPerIp: DEFAULT_PER_IP, // 3 per IP prefix, per epoch, per length
  maxIndexerLag: 2,
  marginPct: 10,
  marginMinSats: NET_DEFAULTS.marginMinSats,
  minDepositSats: NET_DEFAULTS.minDepositSats,
  depositConfirmations: null, // null: DEPOSIT_CONFIRMATIONS[NETWORK]
  batchHeadroom: 2,
  suggestSends: 10,
  invalidProofSats: NET_DEFAULTS.invalidProofSats,
  invalidPerHour: 10,
  accountPerHour: 120,
  creditLookupsPerMinute: 30, // explorer lookups by credit() per minute, all IPs together
  verifyConcurrency: 2,
  verifyMaxPerSec: 10,
  fanoutTarget: NET_DEFAULTS.fanoutTarget,
  fanoutValue: NET_DEFAULTS.fanoutValue, // signet: one full chain of 21 carriers at 1 sat/vB
  fanoutMinConfirmed: 6,
  fanoutMinCarriers: NET_DEFAULTS.fanoutMinCarriers, // fan out when confirmed coins fund fewer carriers than this in one block
  trustProxy: false,
  bodyLimit: 4096,
  bodyTimeoutMs: 10_000,
  estVsize: 597,
  // Mining claims (mining-contract.md §9.1). Off until mining is active at the next block.
  mineEnabled: true,
  mineFeeHeadroom: FEE_HEADROOM, // L5: the one headroom (src/btc/funding.mjs). carrier rate = ceil(next-block rate x headroom): a carrier is never accelerated, so it pays up front
  mineEstVsize: 684, // one P2TR input, the OP_RETURN, one service-fee output, change
  invalidPowSats: NET_DEFAULTS.invalidPowSats, // margin penalty for refused work
  // L1: k. A carrier spends only a coin descending from at least k + 1 depositing accounts, so
  // every sender has at least k others there; 0 turns L1 off (merges take deposits only, a lone
  // deposit merges at once: the behaviour before lineage was tracked) and relay info then says
  // coverOk: false. Mainnet refuses 0.
  minMix: NET_DEFAULTS.minMix,
  // L2: a credit is settled (no account left on it) once its deposit has left the pool and 5
  // relayed transfers have landed since it, or at the latest once it is this many blocks deep
  // (one day: how long wallets look back for a recent top-up).
  creditKeepBlocks: 144,
  powQueueMax: 64, // Argon2 pool tasks waiting before a claim answers busy
  mempoolLookupsPerTick: 50, // raw transactions read per tick to count mempool claims (cap_reached)
  // Credit a deposit only from a block the indexer applied (header-verified, A-9) at the height the
  // source names, with the transaction proven inside it, and count its depth from the indexer's
  // height. Signet keeps the earlier behaviour (the source's word) unless it is switched on.
  verifyDeposits: NETWORK !== "signet",
});

// The free relayer's settings are not read any more: there is no budget the operator funds,
// no proof of work and no accept bucket. These MURKLE_* names change nothing.
export const RETIRED_ENV = Object.freeze(["DAILY_BUDGET_SATS", "POW_BASE_BITS", "POW_MAX_EXTRA", "POW_BUDGET_EXTRA", "ACCEPT_PER_HOUR", "ACCEPT_PER_DAY", "REJECT_PER_HOUR", "HOT_FLOOR_SATS"]);
const ENV_NAMES = {
  enabled: "RELAYER",
  relayMode: "RELAY_MODE",
  relayDir: "RELAY_DIR",
  keyPath: "RELAY_KEY_PATH",
  statePath: "RELAY_STATE_PATH",
  maxFeeRate: "MAX_FEE_RATE",
  maxFeePerTx: "MAX_FEE_PER_TX",
  maxRelaysPerBlock: "MAX_RELAYS_PER_BLOCK",
  maxQueue: "MAX_QUEUE",
  safetyBlocks: "SAFETY_BLOCKS",
  batch10SafetyBlocks: "BATCH10_SAFETY_BLOCKS",
  maxBatchPerEpoch: "MAX_BATCH_PER_EPOCH",
  maxBatch10PerEpoch: "MAX_BATCH10_PER_EPOCH",
  batchPerIp: "BATCH_PER_IP",
  maxIndexerLag: "MAX_INDEXER_LAG",
  marginPct: "RELAY_MARGIN_PCT",
  marginMinSats: "RELAY_MARGIN_MIN_SATS",
  minDepositSats: "RELAY_MIN_DEPOSIT_SATS",
  depositConfirmations: "RELAY_DEPOSIT_CONFS",
  batchHeadroom: "RELAY_BATCH_HEADROOM",
  suggestSends: "RELAY_SUGGEST_SENDS",
  invalidProofSats: "RELAY_INVALID_PROOF_SATS",
  invalidPerHour: "RELAY_INVALID_PER_HOUR",
  accountPerHour: "RELAY_ACCOUNT_PER_HOUR",
  creditLookupsPerMinute: "RELAY_CREDIT_LOOKUPS_PER_MIN",
  verifyConcurrency: "VERIFY_CONCURRENCY",
  verifyMaxPerSec: "VERIFY_MAX_PER_SEC",
  fanoutTarget: "FANOUT_TARGET",
  fanoutValue: "FANOUT_VALUE",
  fanoutMinConfirmed: "FANOUT_MIN_CONFIRMED",
  fanoutMinCarriers: "FANOUT_MIN_CARRIERS",
  trustProxy: "TRUST_PROXY",
  bodyLimit: "BODY_LIMIT",
  estVsize: "EST_VSIZE",
  mineEnabled: "RELAY_MINE_ENABLED",
  mineFeeHeadroom: "RELAY_MINE_FEE_HEADROOM",
  mineEstVsize: "RELAY_MINE_EST_VSIZE",
  invalidPowSats: "RELAY_INVALID_POW_SATS",
  minMix: "RELAY_MIN_MIX",
  powQueueMax: "RELAY_POW_QUEUE",
  mempoolLookupsPerTick: "RELAY_MEMPOOL_LOOKUPS",
  verifyDeposits: "RELAY_VERIFY_DEPOSITS",
};
const NUMERIC = new Set(["depositConfirmations"]); // null defaults that are numbers when set

/**
 * MURKLE_* overrides on top of DEFAULTS, and the problems found reading them (never throws).
 * `read(name)` returns the raw string or undefined. `enabled` only records that MURKLE_RELAYER
 * asked for a relayer; relayerStartup() decides.
 */
export function readConfig(read = env) {
  const config = { ...DEFAULTS, enabled: false };
  const problems = [];
  for (const [key, name] of Object.entries(ENV_NAMES)) {
    const raw = read(name);
    if (raw === undefined || raw === "") continue;
    const dflt = DEFAULTS[key];
    if (typeof dflt === "boolean") config[key] = !/^(0|false|no|off)$/i.test(raw);
    else if (typeof dflt === "number" || NUMERIC.has(key)) {
      const n = Number(raw);
      if (!/^\s*\d+(\.\d+)?\s*$/.test(raw) || !Number.isFinite(n) || n < 0) problems.push(`MURKLE_${name} must be a non-negative number`);
      else config[key] = n;
    } else config[key] = raw;
  }
  return { config, problems };
}

/** As readConfig, but throws on the first problem. */
export function configFromEnv(read = env) {
  const { config, problems } = readConfig(read);
  if (problems.length) throw new Error(problems[0]);
  return config;
}

const whole = (v, lo, hi = Infinity) => Number.isSafeInteger(v) && v >= lo && v <= hi;

const RELAY_NETWORK_NAMES = ["signet", "mainnet"];
/** The network a relay directory path names (a path segment "signet" or "mainnet"), or null. */
export function relayDirNetwork(dir) {
  const named = String(dir ?? "").split(/[\\/]+/).filter((seg) => RELAY_NETWORK_NAMES.includes(seg.toLowerCase()));
  return named.length ? named.at(-1).toLowerCase() : null;
}

/** The problems with a relay balance configuration ([] when it is valid). */
export function balanceProblems(c) {
  const p = [];
  const range = (key, name, lo, hi = Infinity) => {
    if (!whole(c[key], lo, hi)) p.push(hi === Infinity ? `MURKLE_${name} must be a whole number of at least ${lo}` : `MURKLE_${name} must be a whole number from ${lo} to ${hi}`);
  };
  if (typeof c.relayDir !== "string" || !c.relayDir.trim()) p.push("MURKLE_RELAY_DIR must name a directory");
  else {
    const other = relayDirNetwork(c.relayDir);
    if (other && other !== NETWORK) p.push(`MURKLE_RELAY_DIR ${c.relayDir} is a ${other} directory, but this relayer runs on ${NETWORK}: set it to this network's data directory (e.g. /var/lib/murkle/${NETWORK}/relay-balance)`);
  }
  if (NETWORK === "mainnet" && c.verifyDeposits === false) p.push("MURKLE_RELAY_VERIFY_DEPOSITS cannot be turned off on mainnet: deposits are credited only from header-verified blocks");
  if (!(Number.isFinite(c.maxFeeRate) && c.maxFeeRate > 0)) p.push("MURKLE_MAX_FEE_RATE must be above 0");
  range("maxFeePerTx", "MAX_FEE_PER_TX", 1);
  range("marginPct", "RELAY_MARGIN_PCT", 0, 100);
  range("marginMinSats", "RELAY_MARGIN_MIN_SATS", 1);
  const floor = Number.isFinite(c.maxFeeRate) && c.maxFeeRate > 0 ? sweepCostFor(c.maxFeeRate) + DUST : DUST;
  if (!whole(c.minDepositSats, floor + 1)) p.push(`MURKLE_RELAY_MIN_DEPOSIT_SATS must be a whole number above ${floor} (the cost of spending a deposit at the fee cap, plus dust)`);
  const confs = DEPOSIT_CONFIRMATIONS[NETWORK];
  if (c.depositConfirmations !== null && c.depositConfirmations !== undefined && !whole(c.depositConfirmations, confs)) {
    p.push(`MURKLE_RELAY_DEPOSIT_CONFS must be a whole number of at least ${confs} on ${NETWORK}`);
  }
  range("batchHeadroom", "RELAY_BATCH_HEADROOM", 1, 10);
  range("suggestSends", "RELAY_SUGGEST_SENDS", 1, 100);
  range("invalidProofSats", "RELAY_INVALID_PROOF_SATS", 0);
  range("invalidPerHour", "RELAY_INVALID_PER_HOUR", 1);
  range("accountPerHour", "RELAY_ACCOUNT_PER_HOUR", 1);
  range("creditLookupsPerMinute", "RELAY_CREDIT_LOOKUPS_PER_MIN", 1, 600);
  range("safetyBlocks", "SAFETY_BLOCKS", 1, 94);
  range("batch10SafetyBlocks", "BATCH10_SAFETY_BLOCKS", 1, 40);
  if (!(Number.isFinite(c.mineFeeHeadroom) && c.mineFeeHeadroom >= 1 && c.mineFeeHeadroom <= 4)) p.push("MURKLE_RELAY_MINE_FEE_HEADROOM must be a number from 1 to 4");
  range("mineEstVsize", "RELAY_MINE_EST_VSIZE", 300, 10_000);
  range("invalidPowSats", "RELAY_INVALID_POW_SATS", 0);
  range("minMix", "RELAY_MIN_MIX", 0, Math.floor(MIX_CAP / 2));
  if (NETWORK === "mainnet" && c.minMix === 0) p.push("MURKLE_RELAY_MIN_MIX must be at least 1 on mainnet: 0 ties relayed sends to their top-up addresses");
  if (!whole(c.creditKeepBlocks, REORG_DEPTH, 100_000)) p.push(`creditKeepBlocks must be a whole number from ${REORG_DEPTH} to 100000`);
  range("powQueueMax", "RELAY_POW_QUEUE", 1);
  range("mempoolLookupsPerTick", "RELAY_MEMPOOL_LOOKUPS", 0, 10_000);
  return p;
}

const STARTUP_PREFIX =
  "refusing to start the relayer: MURKLE_RELAYER=1 needs MURKLE_RELAY_MODE=balance and a valid relay balance configuration (docs/design/relay-balance.md). There is no free mode.";
const KEEPS_RUNNING = "The indexer keeps running.";

/**
 * Whether the server may start the paid relayer (contract §4.1, rule R6): only with
 * MURKLE_RELAYER=1, MURKLE_RELAY_MODE=balance and a valid balance configuration. Never throws.
 * Returns { start, requested, config, problems, message }.
 */
export function relayerStartup(read = env) {
  const { config, problems: parsed } = readConfig(read);
  if (!config.enabled) {
    return { start: false, requested: false, config, problems: [], message: "Relayer off. Wallets pay the fee themselves or copy the envelope." };
  }
  if (config.relayMode !== "balance") {
    return { start: false, requested: true, config, problems: ["MURKLE_RELAY_MODE is not balance"], message: `${STARTUP_PREFIX} ${KEEPS_RUNNING}` };
  }
  const problems = [...parsed, ...balanceProblems(config)];
  if (problems.length) return { start: false, requested: true, config, problems, message: `${STARTUP_PREFIX} ${problems.join("; ")}. ${KEEPS_RUNNING}` };
  return {
    start: true, requested: true, config, problems: [],
    message: "Relayer on: relay balances (docs/design/relay-balance.md). Users prepay; the operator never pays a user's fee.",
  };
}

// HTTP status per error code (contract §4.4).
export const ERROR_STATUS = Object.freeze({
  malformed: 400, bad_outpoint: 400, not_transact: 400, public_value: 400,
  bad_signature: 401, stale_request: 401,
  balance_low: 402,
  deposit_unknown: 404,
  already_credited: 409, credit_in_progress: 409, deposit_unconfirmed: 409, replayed: 409, pool_thin: 409, deposit_retired: 409,
  duplicate_nullifier: 409, nullifier_spent: 409, nullifier_pending: 409,
  too_large: 413,
  deposit_mismatch: 422, deposit_small: 422, deposit_own: 422,
  anchor_unknown: 422, anchor_stale: 422, proof_invalid: 422, anchor_not_boundary: 422, epoch_closed: 422,
  rate_limited: 429,
  disabled: 503, halted: 503, fee_high: 503, pool_low: 503, indexer_behind: 503, busy: 503,
  block_full: 503, queue_full: 503, batch_full: 503, batch_disabled: 503,
  // Emergencies (relay-balance.md §9).
  relayer_evacuating: 503, pool_unfunded: 503, maintenance: 503,
  // Mining claims (mining-contract.md §9.4).
  mine_mode: 400,
  bind_stale: 409, solution_claimed: 409, solution_pending: 409, cap_reached: 409,
  expired: 422, stale_work: 422, pow_invalid: 422, mine_unsupported: 422, mine_rejected: 422,
  mine_disabled: 503,
});

// "What happened. What to do." (visual.md §2; contract §4.4).
export const MESSAGES = Object.freeze({
  malformed: "The request is not a valid relay request. Update the wallet and try again.",
  bad_outpoint: "That is not a deposit outpoint. It must be a 64-character lowercase txid, a colon and the output number.",
  not_transact: "The relayer carries private transfers and mining claims bound to its change address. Mints and launches are paid from your own BTC wallet.",
  public_value: "This envelope moves public value, which a private transfer never does. Build the transfer again.",
  bad_signature: "The request signature does not match this account. Update the wallet and try again.",
  stale_request: "The request is too old or from the future. Check this device's clock and try again.",
  balance_low: "Your relay balance does not cover this send. Top up, or pay the fee yourself.",
  deposit_unknown: "The explorer does not know this deposit yet. Wait a minute and try again.",
  already_credited: "This deposit was already credited to another relay account or address number.",
  credit_in_progress: "This deposit is being credited right now. Try again in a few seconds.",
  deposit_unconfirmed: "The deposit needs more confirmations before it is credited.",
  replayed: "This exact request was already received. Send it again from the wallet.",
  pool_thin: "Too few people have topped up the relay pool, so this send's input would tie it to your top-up address. Pay the fee yourself, or confirm to send it linkable.",
  duplicate_nullifier: "The envelope spends the same note twice. Build the transfer again.",
  nullifier_spent: "These notes are already spent on Bitcoin. Sync your wallet; the transfer may already have landed.",
  nullifier_pending: "These notes are already in the relay queue. Wait for that transfer to settle.",
  too_large: "The request body is too large. Send only the envelope and its signature.",
  deposit_mismatch: "This output does not pay that deposit address of your relay account.",
  deposit_small: "This deposit is below the minimum, so it is not credited.",
  deposit_own: "This output belongs to the relayer's own transaction and is never credited.",
  anchor_unknown: "The envelope is anchored to a block the indexer does not know. Sync and prove again.",
  anchor_stale: "The envelope is anchored too far back to be carried safely. Prove it again from the current block.",
  proof_invalid: "The proof does not verify against this envelope. Build the transfer again.",
  anchor_not_boundary: "A batch transfer must be anchored to the block that opened its batch. Update the wallet and prove again.",
  epoch_closed: "This batch closed while your transfer was being proved. Prove it again for the next batch.",
  rate_limited: "Too many submissions from your network. Wait and try again, or pay the fee yourself.",
  disabled: "No relayer runs on this server. Pay the fee yourself, or copy the envelope so anyone can carry it.",
  halted: "The relayer stopped itself because its books do not add up. Pay the fee yourself or copy the envelope; your balance is kept.",
  fee_high: "Bitcoin fees are above the relayer's cap right now, so it does not take sends. Pay the fee yourself or copy the envelope.",
  pool_low: "The relayer cannot fund more carriers in this block. Try the next block, or pay the fee yourself.",
  indexer_behind: "The relayer's indexer is catching up with Bitcoin. Try again in a few minutes.",
  busy: "The relayer is busy checking other proofs. Try again in a few seconds.",
  block_full: "The relayer has taken enough transfers for this block. Try after the next block.",
  queue_full: "The relay queue is full. Try again after the next block.",
  batch_full: "This batch is full. Send with the next block, or try the next batch.",
  batch_disabled: "The relayer is not taking this batch length right now. Send with the next block instead.",
  relayer_evacuating: "The relayer is moving its coins to safety and takes no sends or top-ups right now. Your balance is kept in full. Pay the fee yourself, or copy the envelope.",
  pool_unfunded: "The relayer moved to new keys and takes no sends or top-ups until its operator has refilled the new pool. Your balance is kept in full. Pay the fee yourself, or copy the envelope.",
  maintenance: "The relayer is paused for maintenance. Your balance is kept. Try again later, or pay the fee yourself.",
  deposit_retired: "This top-up paid a deposit address the relayer has retired. It is credited once the operator has moved it into the new pool; you need to do nothing. Never pay an old deposit address again.",
  mine_mode: "A mining claim goes with the next block or at once. Batch modes land after the claim's 12-block window.",
  bind_stale: "The relayer's change address changed. Prove the claim again for the new address; your solution still counts.",
  solution_claimed: "This solution was already claimed. Mine a new one.",
  solution_pending: "This solution is already in the relay queue.",
  cap_reached: "The supply is mined out, counting claims already on their way. Nothing was charged.",
  expired: "This solution's 12-block window is too close to its end for the relayer to carry it. Mine a new one.",
  stale_work: "Difficulty jumped since this solution's block, so it no longer counts. Mine a new one.",
  pow_invalid: "The work in this claim does not meet the token's difficulty. A small penalty was taken from your relay balance.",
  mine_unsupported: "The relayer cannot carry claims of this token: a fee address belongs to the relayer. Pay the fee yourself.",
  mine_rejected: "This claim cannot land.", // sent as "This claim cannot land: <reason>." with { reason }
  mine_disabled: "The relayer is not taking mining claims right now. Pay the fee yourself.",
});
// busy from the credit lookup bucket (takeCreditLookup).
const CREDIT_BUSY_MESSAGE = "The relayer is looking up many deposits right now. Try again in a minute.";
// rate_limited from the per-epoch batch bucket (batch-contract §3.3).
const BATCH_IP_MESSAGE = "Your network has sent the most transfers allowed in this batch. Try the next batch, or send with the next block.";
// Status reasons of a missed item (its reservation is returned: nothing was charged).
export const MISSED_REASON = Object.freeze({
  balance_low: "your relay balance did not cover the fee when it was due; nothing was charged",
  fee_high: "fees were above the relayer's cap when it was due; nothing was charged",
  pool_thin: "too few people had topped up the relay pool to send it without tying it to your top-up address; nothing was charged",
  relayer_evacuating: "the relayer stopped taking sends to move its coins to safety before it was due; nothing was charged and your balance is kept",
});

export class RelayError extends Error {
  constructor(code, extra = {}, message = MESSAGES[code] ?? code) {
    super(message);
    this.code = code;
    this.status = ERROR_STATUS[code] ?? 500;
    this.extra = extra;
  }
  toJSON() {
    return { error: { code: this.code, message: this.message, ...this.extra } };
  }
}

// Indexer reasons of a MINE / MINE_SCRIPT claim that answer mine_rejected (mining-contract.md §9.4).
const MINE_REJECTED = /^(unknown asset|asset is not mined|mining not started|mining closed|mining ended|reward differs from terms|unknown reference block)\b/;

/** Maps an Indexer.checkTx rejection reason (or a MINE check's reason) to a relay error code. */
export function codeForReason(reason) {
  const r = String(reason);
  if (/solution already claimed/.test(r)) return "solution_claimed";
  if (/supply cap reached/.test(r)) return "cap_reached";
  if (/reference outside window/.test(r)) return "expired";
  if (/insufficient work/.test(r)) return "pow_invalid";
  if (MINE_REJECTED.test(r)) return "mine_rejected";
  if (/public value/.test(r)) return "public_value";
  if (/anchor outside window/.test(r)) return "anchor_stale";
  if (/unknown anchor/.test(r)) return "anchor_unknown";
  if (/duplicate nullifier/.test(r)) return "duplicate_nullifier";
  if (/already spent/.test(r)) return "nullifier_spent";
  if (/verify|proof/.test(r)) return "proof_invalid";
  if (/proof-carrying/.test(r)) return "not_transact";
  return "malformed";
}

/** The RelayError for a MINE check's reason; mine_rejected names the reason. */
export function mineRefusal(reason) {
  const code = codeForReason(reason);
  if (code === "mine_rejected") return new RelayError(code, { reason: String(reason) }, `This claim cannot land: ${reason}.`);
  return new RelayError(code);
}

/** Async mutex: tick (sync + reconcile + flush) and fast-mode flushes never interleave. */
export class Mutex {
  constructor() {
    this.tail = Promise.resolve();
  }
  run(fn) {
    const result = this.tail.then(() => fn());
    this.tail = result.catch(() => {});
    return result;
  }
}

class Semaphore {
  constructor(n) {
    this.free = n;
    this.waiting = [];
  }
  async acquire() {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
  }
}

/**
 * Rate-limit bucket identity: IPv4 /24 or IPv6 /56, with IPv4-mapped IPv6 treated
 * as IPv4. Only an HMAC of this prefix under a daily in-memory key is ever kept.
 */
export function ipPrefix(ip) {
  let a = String(ip ?? "").trim().toLowerCase();
  if (a.startsWith("[")) a = a.slice(1, a.indexOf("]") > 0 ? a.indexOf("]") : undefined);
  a = a.split("%")[0];
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(":"));
  if (a.includes(":") && a.includes(".")) a = a.slice(a.lastIndexOf(":") + 1); // ::ffff:1.2.3.4
  const v4 = a.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return `4:${Number(v4[1])}.${Number(v4[2])}.${Number(v4[3])}`;
  const halves = a.split("::");
  if (halves.length <= 2 && a.includes(":")) {
    const head = halves[0] ? halves[0].split(":") : [];
    const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
    const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
    if (groups.length === 8 && groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) {
      const g = groups.map((x) => parseInt(x, 16));
      return `6:${g[0].toString(16)}:${g[1].toString(16)}:${g[2].toString(16)}:${(g[3] >> 8).toString(16)}`;
    }
  }
  return `?:${a}`;
}

/** The client address: last X-Forwarded-For hop behind a trusted proxy, else the socket peer. */
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers?.["x-forwarded-for"];
    const hops = String(Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket?.remoteAddress ?? "";
}

const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/**
 * The union of lineage tag lists, sorted, at most MIX_CAP tags (the lowest; tags are uniform
 * HMAC outputs, so this keeps no account's tag on purpose). A capped set still proves at least
 * MIX_CAP distinct accounts, more than any minMix allows.
 */
/**
 * What a 202 adds for L1: `linkable: true` when the signed request accepted a linkable send, and
 * `thin: true` when no coin hid the sender among minMix others at acceptance (its carrier can then
 * be tied to few depositors, possibly only the sender). Both absent otherwise.
 */
const linkableBody = (req) => ({ ...(req.linkable === true ? { linkable: true } : {}), ...(req.thin === true ? { thin: true } : {}) });

/** `tx` with its output `from` moved to position `to` (same inputs, same amounts): L5's random change slot. */
export function withChangeAt(tx, from, to) {
  if (from === to) return tx;
  const outs = Array.from({ length: tx.outputsLength }, (_, v) => tx.getOutput(v));
  const [moved] = outs.splice(from, 1);
  outs.splice(to, 0, moved);
  const out = new btc.Transaction({ allowUnknownOutputs: true });
  for (let i = 0; i < tx.inputsLength; i++) out.addInput(tx.getInput(i));
  for (const o of outs) out.addOutput({ script: o.script, amount: o.amount });
  return out;
}

export function unionMix(lists) {
  const all = new Set();
  for (const l of lists) for (const t of l ?? []) all.add(t);
  return [...all].sort().slice(0, MIX_CAP);
}

// What a settled item (broadcast or final: its account link is gone) keeps on disk (L2): its
// status answer, and nothing the public carrier itself does not show. While its carrier may still
// be sent again (broadcast, or raw bytes kept for a reorg) it also keeps what the re-send, the
// expiry and the claim cap need, all readable from those raw bytes anyway.
const SETTLED_KEEP = ["id", "status", "kind", "txid", "height", "broadcastHeight", "ledgerSeq", "finalHeight", "reason", "code"];
const RESEND_KEEP = ["raw", "nullifiers", "anchor", "ref", "asset", "solutionId", "fee", "serviceSats", "fanout"];

/**
 * An item as the state file holds it. Queued and journaled items are written whole: they still
 * need their account, envelope and reservation. A settled item drops its cost, submit height,
 * mode, batch schedule, reservation, coin and every other per-item amount, so that no saved field
 * ties a carrier to the account that paid it (credits − Σ costs = balance no longer re-attributes).
 */
export function persistedItem(item) {
  if (item.status === "queued" || item.status === "signing") return item;
  const keep = item.status === "broadcast" || item.raw ? [...SETTLED_KEEP, ...RESEND_KEEP] : SETTLED_KEEP;
  const out = {};
  for (const k of keep) if (item[k] !== undefined) out[k] = item[k];
  return out;
}

/** Loads a key file (64 lowercase hex chars), creating it with mode 0600 (flag wx) on first start. */
export function loadOrCreateKey(path) {
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8").trim();
    if (!HEX32.test(text)) throw new Error(`${path} must hold 64 lowercase hex chars`);
    return unhex(text);
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key.toString("hex"), { mode: 0o600, flag: "wx" });
  return new Uint8Array(key);
}

/**
 * tmp file, fsync, rename, then fsync of the directory: after a power loss the
 * file is the old or the new version, never a torn one. Windows cannot open a
 * directory for fsync; flushing the renamed file is the closest it allows.
 */
export function writeDurable(path, text, mode = undefined) {
  const tmp = path + ".tmp";
  const flush = (target, flags, data) => {
    const fd = openSync(target, flags, flags === "w" ? mode : undefined);
    try {
      if (data) writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  flush(tmp, "w", text);
  renameSync(tmp, path);
  if (process.platform === "win32") flush(path, "r+");
  else flush(dirname(path), "r");
}

/** Size, mtime and inode of a file, as one string (null when it does not exist): enough to tell another writer's rename. */
function fileStat(path) {
  try {
    const st = statSync(path);
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return null;
  }
}

const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * Starts the paid relayer (contract §4.1): new pool and change keys in `relayDir`, never the
 * retired relayer.key, and a version-2 state file there. Throws with a one-line reason.
 */
export async function startPaidRelayer({ idx, esplora, config, root = process.cwd(), lock = new Mutex(), log = console, now, fastDelayMs }) {
  const c = { ...DEFAULTS, ...config };
  const dir = resolvePath(root, c.relayDir);
  const files = { pool: resolvePath(dir, "pool.key"), change: resolvePath(dir, "change.key"), state: resolvePath(dir, "relayer.json") };
  const oldKey = resolvePath(root, c.keyPath);
  const oldState = resolvePath(root, c.statePath);
  for (const p of Object.values(files)) {
    if (samePath(p, oldKey) || samePath(p, oldState)) throw new Error(`${p} is a file of the retired free relayer; set MURKLE_RELAY_DIR to a new directory.`);
  }
  if (samePath(dir, dirname(oldKey)) && (existsSync(resolvePath(dir, "relayer.key")) || existsSync(resolvePath(dir, "relayer.json")))) {
    throw new Error(`${dir} holds the retired free relayer's files; set MURKLE_RELAY_DIR to a new directory.`);
  }
  const pool = loadOrCreateKey(files.pool);
  const change = loadOrCreateKey(files.change);
  if (equal(pool, change) || equal(schnorr.getPublicKey(pool), schnorr.getPublicKey(change))) throw new Error("the pool key and the change key are the same key.");
  if (existsSync(oldKey)) {
    let old;
    try {
      old = readRelayerKey(oldKey);
    } catch (e) {
      throw new Error(`cannot read the retired key to compare it (${e.message}).`);
    }
    const oldPub = schnorr.getPublicKey(old);
    for (const [name, k] of [["pool", pool], ["change", change]]) {
      if (equal(k, old) || equal(schnorr.getPublicKey(k), oldPub)) throw new Error(`the new ${name} key equals the retired relayer key; it is never pool money again.`);
    }
  }
  const tagKeys = readTagKeys(resolvePath(dir, RELAY_FILES.tags));
  const relayer = new Relayer({ idx, esplora, poolKey: pool, changeKey: change, tagKeys, config: { ...c, statePath: files.state }, lock, log, now, fastDelayMs });
  // An operator tool holds this directory (relay-balance.md §9): start frozen. Nothing is re-sent,
  // signed or written; the relay info still publishes the keys and the refusal code.
  const hold = relayer.readHold();
  if (hold) {
    relayer.freezeAtStart(hold);
    return relayer;
  }
  await relayer.recover();
  relayer.checkBooks();
  relayer.save();
  relayer.watchHold(c.holdPollMs);
  return relayer;
}

/**
 * The books and lineage keys a rotated relayer keeps from its first pool key (RELAY_FILES.tags:
 * JSON { account, mix }, 64 lowercase hex characters each), or null when the file is absent (no
 * rotation yet: both keys come from pool.key).
 */
export function readTagKeys(path) {
  if (!path || !existsSync(path)) return null;
  let saved;
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  if (!HEX32.test(String(saved?.account ?? "")) || !HEX32.test(String(saved?.mix ?? ""))) throw new Error(`${path} must hold { account, mix }, 64 lowercase hex characters each`);
  return { account: unhex(saved.account), mix: unhex(saved.mix) };
}

export class Relayer {
  /**
   * @param idx        the in-process Indexer (shared with the HTTP server)
   * @param esplora    { feeRate, broadcast, txStatus, rawTx } (src/btc/esplora.mjs or a fake); never `utxos`
   * @param poolKey    32-byte pool secret q (deposit addresses are Q + t·G)
   * @param changeKey  32-byte change secret c (every change and fan-out output pays C)
   * @param config     DEFAULTS overrides; `statePath` only when given (null keeps state in memory)
   * @param now        clock (ms), injectable for tests
   * @param fastDelayMs  delay before a fast-mode flush (default 0: at once)
   * @param tagKeys    after a rotation: { account, mix } (32 bytes each), the books and lineage keys
   *                   of the first pool key (readTagKeys), so every account keeps its stored key
   */
  constructor({ idx, esplora, poolKey, changeKey, config = {}, lock = new Mutex(), now = Date.now, fastDelayMs, log = console, tagKeys = null } = {}) {
    if (!(poolKey instanceof Uint8Array) || poolKey.length !== 32 || !(changeKey instanceof Uint8Array) || changeKey.length !== 32) {
      throw new Error("the paid relayer needs its own pool key and change key (startPaidRelayer)");
    }
    this.idx = idx;
    this.esplora = esplora;
    // statePath is used only when the caller names it: never a default (the v1 file).
    this.config = { ...DEFAULTS, ...config, statePath: Object.hasOwn(config, "statePath") ? config.statePath : null };
    const problems = balanceProblems({ ...this.config, relayDir: this.config.relayDir || "." });
    if (problems.length) throw new Error(problems.join("; "));
    this.lock = lock;
    this.now = now;
    this.log = log;
    this.fastDelayMs = fastDelayMs ?? (() => 0);
    this.poolSecret = Uint8Array.from(poolKey);
    this.Q = schnorr.getPublicKey(this.poolSecret);
    this.poolHex = hex(this.Q);
    this.poolScript = btc.p2tr(this.Q, undefined, BTC_NETWORK).script; // the script bytes do not depend on the network
    this.changeSecret = Uint8Array.from(changeKey);
    this.change = btcAccount(this.changeSecret);
    if (equal(this.Q, this.change.pub)) throw new Error("the pool key and the change key are the same key");
    this.changeHex = hex(this.change.pub);
    this.address = this.change.address; // C: every change output; the published relayer address
    // What a relayed MINE_SCRIPT claim commits to: sha256(C.script) (mining.md §9).
    this.bindScriptHash = new Uint8Array(createHash("sha256").update(this.change.script).digest());
    this.chainTip = idx.height;
    // nextBlockRate: mempool.space's fastestFee (or the client's feeRate), read only while mining is active.
    this.cache = { feeRate: null, nextBlockRate: null };
    this.ticked = false;
    this.pending = new Map(); // nullifier -> item id, or a validating token
    this.buckets = new Map(); // HMAC(dayKey, ipPrefix) -> { batch: { epochKey: count }, calls: [ms] }
    this.dayKey = randomBytes(32);
    this.day = utcDay(now());
    this.replays = new Map(); // sha256(sig) -> expiry ms, in insertion (= expiry) order
    this.creditLookups = []; // ms of credit()'s explorer lookups in the last minute (all IPs)
    this.creditMiss = new Map(); // txid -> { height, at }: the explorer did not know it (remembered for this block, at most a minute)
    this.invalid = new Map(); // account id -> [ms] of invalid proofs in the last hour
    this.suspect = new Map(); // coin key -> height: a broadcast said it is missing; not picked this block
    this.vanished = new Map(); // deposit txid -> consecutive 404 answers
    this.provenIn = new Map(); // deposit txid -> block hash its inclusion was proven in (verifyDeposits)
    this.timers = new Map();
    this.verify = new Semaphore(this.config.verifyConcurrency);
    this.verifyStarts = [];
    this.blockMark = idx.height;
    this.acceptedThisBlock = 0; // Next-block and fast acceptances at this tip (block_full)
    this.perCache = null; // { rate, fee } of one carrier
    this.pendingSolutions = new Map(); // solutionId hex -> item id, or a validating token
    this.powBusy = new Set(); // account ids with a PoW check in flight (one per account)
    this.mempoolClaims = new Map(); // mempool txid -> { asset, solutionIdHex, reward, env } | null: checked claims only (best effort, cap_reached)
    // L1: lineage tags are HMAC(mixKey, the account's books key), never the account id itself.
    // L2: the books store each account under HMAC(accountKeyKey, id), never under its id.
    // Both come from the pool secret, or after a rotation from the first pool secret (tagKeys):
    // balances belong to account keys, not to a pool key, so a rotation keeps every stored key.
    if (tagKeys) {
      if (!(tagKeys.account instanceof Uint8Array) || tagKeys.account.length !== 32 || !(tagKeys.mix instanceof Uint8Array) || tagKeys.mix.length !== 32) {
        throw new Error("tagKeys must be { account, mix }, 32 bytes each");
      }
      this.mixKey = Buffer.from(tagKeys.mix);
      this.accountKeyKey = Buffer.from(tagKeys.account);
    } else {
      this.mixKey = createHmac("sha256", this.poolSecret).update(MIX_LABEL).digest();
      this.accountKeyKey = createHmac("sha256", this.poolSecret).update(ACCOUNT_LABEL).digest();
    }
    // Emergencies (relay-balance.md §9): frozen = a HOLD was seen and acted on, so nothing is written
    // until a restart; holdSeen refuses new sends the moment the file is seen, before the freeze runs.
    this.frozen = false;
    this.holdSeen = null;
    this.holdTimer = null;
    this.saveGuard = null; // an operator tool's check that nobody else wrote the state file meanwhile
    this.freezing = false; // freeze()'s one save under a HOLD
    this.savedStat = null; // the state file as this relayer last wrote it (save(): never overwrite a tool's write)
    this.state = this.load();
    // isOwnScript: every deposit script credited or handed out (no account attached to any).
    this.ownScripts = new Set(this.state.ownScripts ?? []);
    for (const item of Object.values(this.state.items)) {
      if (!IN_FLIGHT.has(item.status)) continue;
      item.nullifiers.forEach((n) => this.pending.set(n, item.id));
      if (isMineItem(item) && item.solutionId) this.pendingSolutions.set(item.solutionId, item.id);
    }
    this.snap = this.snapshot();
  }

  // ---------------------------------------------------------------- state

  booksKeys() {
    return {
      network: NETWORK, poolKey: this.poolHex, changeKey: this.changeHex, marginPct: this.config.marginPct, marginMinSats: this.config.marginMinSats,
      accountKey: (id) => this.accountKeyOf(id),
    };
  }

  /** L2: the opaque key the books store account `idHex` under (64 hex characters). */
  accountKeyOf(idHex) {
    return createHmac("sha256", this.accountKeyKey).update(String(idHex)).digest("hex");
  }

  load() {
    const path = this.config.statePath;
    const h = this.idx.height;
    const fresh = {
      version: STATE_VERSION, network: NETWORK, keys: { pool: this.poolHex, change: this.changeHex },
      books: null, coins: {}, items: {}, ledger: [], lastReconciled: h, lastReconciledHash: null, lastFlushHeight: h, halted: null,
    };
    if (!path || !existsSync(path)) {
      this.books = new RelayBooks(this.booksKeys());
      return fresh;
    }
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved?.version !== STATE_VERSION) throw new Error(`${path} is a version ${saved?.version} relayer state; the paid relayer reads only version ${STATE_VERSION} (the v1 file stays read-only).`);
    if (saved.network !== NETWORK) throw new Error(`${path} belongs to ${saved.network}, not ${NETWORK}.`);
    if (saved.keys?.pool !== this.poolHex || saved.keys?.change !== this.changeHex) throw new Error(`${path} was written for other keys than the key files next to it.`);
    if (saved.accountsKeyed !== true) this.keyAccounts(saved);
    this.books = RelayBooks.restore(saved.books, this.booksKeys());
    const state = { ...fresh, ...saved, books: null };
    for (const item of Object.values(state.items)) {
      if (isBatchMode(item.mode) && (item.releaseAt == null || item.lastRelease == null)) Object.assign(item, this.schedule(item.mode, item.anchor));
    }
    return state;
  }

  /**
   * L2, once, in memory, for a state written before accounts were keyed (the next save writes the
   * new shape): every account id in the books and in queued items becomes its opaque key; a
   * deposit coin the pool holds gets its tweak (all a spend needs); the deposit scripts credited
   * or handed out are listed without accounts (isOwnScript); and every lineage tag, which was
   * HMAC(mixKey, id), becomes HMAC(mixKey, key), so old and new tags of one account stay equal.
   */
  keyAccounts(saved) {
    const books = saved.books ?? {};
    const ids = new Set([...Object.keys(books.accounts ?? {}), ...Object.values(books.credits ?? {}).map((c) => c?.id)]);
    for (const r of [...Object.values(books.reservations ?? {}), ...Object.values(books.charges ?? {})]) ids.add(r?.id);
    for (const item of Object.values(saved.items ?? {})) ids.add(item?.account);
    ids.delete(undefined);
    const keyOf = new Map([...ids].map((id) => [id, HEX32.test(String(id)) ? this.accountKeyOf(id) : id]));
    const scripts = new Set(saved.ownScripts ?? []);
    const add = (id, n) => {
      try {
        scripts.add(hex(depositAddress(this.Q, unhex(id), n, NETWORK).script));
      } catch {}
    };
    for (const [key, c] of Object.entries(books.credits ?? {})) {
      if (!c?.id || !HEX32.test(c.id)) continue;
      add(c.id, c.n);
      const coin = saved.coins?.[key];
      if (coin?.kind === "deposit" && !coin.tweak) coin.tweak = tweakHex(depositTweak(this.Q, unhex(c.id), c.n));
    }
    for (const [id, a] of Object.entries(books.accounts ?? {})) if (HEX32.test(id)) add(id, a?.nextIndex ?? 0);
    const tags = new Map([...keyOf].map(([id, key]) => [this.mixTag(id), this.mixTag(key)]));
    for (const coin of Object.values(saved.coins ?? {})) {
      if (Array.isArray(coin?.mix)) coin.mix = unionMix([coin.mix.map((t) => tags.get(t) ?? t)]);
    }
    const rekey = (o) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [keyOf.get(k) ?? k, v])) : o);
    const reid = (o) => (o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v && v.id !== undefined ? { ...v, id: keyOf.get(v.id) ?? v.id } : v])) : o);
    saved.books = { ...books, accounts: rekey(books.accounts), credits: reid(books.credits), reservations: reid(books.reservations), charges: reid(books.charges) };
    for (const item of Object.values(saved.items ?? {})) if (item?.account) item.account = keyOf.get(item.account) ?? item.account;
    saved.ownScripts = [...scripts].sort();
    saved.accountsKeyed = true;
  }

  /** isOwnScript's list gains a deposit script (credited or handed out). */
  addOwnScript(script) {
    this.ownScripts.add(typeof script === "string" ? script : hex(script));
  }

  /**
   * Atomic, durable write (writeDurable) of the state and the books. Never holds an IP or a bucket
   * key. Settled items are written through persistedItem (L2), in id order (random), so neither a
   * per-item charge nor the order of submits reaches the file.
   */
  save() {
    const path = this.config.statePath;
    // Frozen by an operator's HOLD: the operator tool owns the files now (relay-balance.md §9).
    if (!path || this.frozen) return;
    // A HOLD in place: the running relayer writes once more, in freeze() and only while the file is
    // still the one it last wrote. Any other save is refused (the HOLD is acted on at once), so a
    // relayer that has not seen the HOLD yet never overwrites what an operator tool wrote.
    if (!this.saveGuard && this.readHold()) {
      if (!this.freezing) {
        this.checkHold()?.catch((e) => this.log.error?.(`relayer: freeze failed (${e?.name ?? "Error"})`));
        return;
      }
      if (this.savedStat && fileStat(path) !== this.savedStat) {
        this.log.error?.(`relayer: ${path} was written by another process after the HOLD; this relayer does not overwrite it`);
        return;
      }
    }
    mkdirSync(dirname(path), { recursive: true });
    const items = {};
    for (const id of Object.keys(this.state.items).sort()) items[id] = persistedItem(this.state.items[id]);
    const text = JSON.stringify({ ...this.state, items, books: this.books.toJSON(), ownScripts: [...this.ownScripts].sort(), accountsKeyed: true });
    this.saveGuard?.before(path);
    writeDurable(path, text);
    this.saveGuard?.after(path, text);
    if (!this.saveGuard) this.savedStat = fileStat(path);
  }

  close() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this.holdTimer) clearInterval(this.holdTimer);
    this.holdTimer = null;
  }

  // ------------------------------------------------------------- emergencies

  /** The relay directory (the state file's directory), or null for a relayer kept in memory. */
  relayDir() {
    return this.config.statePath ? dirname(this.config.statePath) : null;
  }

  /** The HOLD an operator tool wrote ({ reason, nonce, at }), or null. A malformed one still holds (as maintenance). */
  readHold() {
    const dir = this.relayDir();
    const path = dir ? join(dir, RELAY_FILES.hold) : null;
    if (!path || !existsSync(path)) return null;
    let hold = null;
    try {
      hold = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      hold = null;
    }
    const reason = HOLD_REASONS.includes(hold?.reason) ? hold.reason : "maintenance";
    return { reason, nonce: typeof hold?.nonce === "string" ? hold.nonce : null };
  }

  /**
   * The refusal every send and credit gets while the operator handles an emergency, or null:
   * pool_unfunded after a rotation until the new pool covers the books (I2), relayer_evacuating
   * from the moment an evacuation's HOLD is seen until the rotation, maintenance for any other HOLD.
   */
  stopCode() {
    if (this.state.rotation && !this.state.rotation.funded) return "pool_unfunded";
    const reason = this.holdSeen?.reason ?? null;
    if (this.state.evacuation || reason === "evacuate") return "relayer_evacuating";
    if (this.frozen || this.holdSeen) return "maintenance";
    return null;
  }

  /**
   * Looks for a HOLD (every second while running, and on every tick). Seen: new sends and credits
   * are refused at once (stopCode), then under the lock (after any flush in progress) the relayer
   * freezes. Returns the freeze's promise, or null when there is no HOLD.
   */
  checkHold() {
    if (this.frozen) return null;
    const hold = this.readHold();
    if (!hold) return null;
    this.holdSeen ??= hold;
    return this.lock.run(() => this.freeze(hold));
  }

  /**
   * Freezes a running relayer for an operator tool: an evacuation releases every queued item first
   * (missed, relayer_evacuating: its reservation goes back, nothing is charged; items already sent
   * keep their status), then the state is saved once, the relayer stops writing and HOLD.ack says so.
   */
  freeze(hold) {
    if (this.frozen) return;
    if (hold.reason === "evacuate") this.enterEvacuation();
    this.freezing = true;
    try {
      this.save();
    } finally {
      this.freezing = false;
    }
    this.frozen = true;
    this.holdSeen = hold;
    this.close();
    this.writeAck(hold);
    this.log.warn?.(`relayer frozen by the operator (${hold.reason}): no sends, no credits and no writes until it is restarted without ${RELAY_FILES.hold}`);
  }

  /** startPaidRelayer with a HOLD in place: frozen from the start, nothing re-sent or written. */
  freezeAtStart(hold) {
    this.frozen = true;
    this.holdSeen = hold;
    this.checkBooks(); // in memory only: the halt shows in health and info
    this.writeAck(hold);
    this.log.warn?.(`relayer started frozen: ${RELAY_FILES.hold} is in place (${hold.reason}); it takes no sends or credits and writes nothing`);
  }

  writeAck(hold) {
    const dir = this.relayDir();
    if (!dir) return;
    try {
      writeDurable(join(dir, RELAY_FILES.ack), JSON.stringify({ nonce: hold.nonce ?? null, pid: process.pid, at: this.now(), height: this.idx.height }));
    } catch (e) {
      this.log.error?.(`relayer: cannot write ${RELAY_FILES.ack} (${e?.code ?? e?.name ?? "Error"})`);
    }
  }

  /** Polls for a HOLD every `ms` (default 1000) while the relayer runs. */
  watchHold(ms = 1000) {
    if (this.holdTimer || !this.relayDir()) return;
    this.holdTimer = setInterval(() => {
      this.checkHold()?.catch((e) => this.log.error?.(`relayer: freeze failed (${e?.name ?? "Error"})`));
    }, ms ?? 1000);
    this.holdTimer.unref?.();
  }

  /**
   * An evacuation starts (idempotent): the state records it, and every queued item is released
   * (missed with relayer_evacuating: its reservation goes back, nothing is charged). Journaled and
   * broadcast items are left to the evacuation (server/relay-evacuate.mjs) and keep their status.
   */
  enterEvacuation() {
    this.state.evacuation ??= { since: this.idx.height, at: this.now(), sweeps: [], mix: [] };
    for (const item of this.items) if (item.status === "queued") this.miss(item, "relayer_evacuating");
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    return this.state.evacuation;
  }

  /** A pool refill or a sweep of retired deposits is in a block once its output to C is: its ledger row says so. */
  settleOwnEntries() {
    for (const entry of this.state.ledger) {
      if ((entry.kind !== "refund" && entry.kind !== "retired-sweep") || entry.outcome !== "pending") continue;
      const out = Object.values(this.state.coins).find((c) => c.parent === entry.txid && c.confirmed);
      if (out) Object.assign(entry, { outcome: "accepted", height: out.height ?? null });
    }
  }

  /** The retired generation whose deposit address n of account `id` pays `script`, or null. */
  retiredMatch(script, id, n) {
    for (const g of this.state.retired ?? []) {
      try {
        if (equal(depositAddress(unhex(g.pool), id, n, NETWORK).script, script)) return g;
      } catch {}
    }
    return null;
  }

  /**
   * Deposits to retired addresses swept into the pool (`murkle relayer sweep-retired`) are credited
   * once their sweep is confirmed: value − sweepCost, as any deposit. The sweep's fee was an
   * operator cost (relay-balance.md §9). Their records then forget the account. -> credits made
   */
  creditRetired({ force = false } = {}) {
    let n = 0;
    for (const [key, rec] of Object.entries(this.state.retiredDeposits ?? {})) {
      if (rec.status !== "swept" || !this.retiredSweepConfirmed(rec)) continue;
      // Never a credit the pool cannot cover (I2): when the sweep's fee went beyond the margin
      // (an operator liability), the deposit waits until the operator has refilled the pool
      // (murkle relayer refund-pool), so no user's send is ever refused for it. `force`: the
      // rotation, whose refill covers every credit (rotate()).
      if (!force && this.poolUnspent() < this.books.liabilities() + rec.value) {
        if (!rec.short) this.log.warn?.(`relayer: a swept deposit to a retired address waits for the operator to refill the pool (murkle relayer refund-pool) before it is credited (${key})`);
        rec.short = true;
        continue;
      }
      const out = this.state.coins[`${rec.sweepTxid}:0`];
      try {
        this.books.credit({ key, id: rec.account, n: rec.n, value: rec.value, sweepCost: this.sweepCost(), height: rec.height, byKey: true });
      } catch (e) {
        if (!(e instanceof BooksError && e.code === "already_credited")) throw e;
      }
      this.state.retiredDeposits[key] = { generation: rec.generation, value: rec.value, status: "credited", sweepTxid: rec.sweepTxid };
      const entry = this.state.ledger.find((l) => l.kind === "retired-sweep" && l.txid === rec.sweepTxid);
      if (entry && entry.outcome === "pending") Object.assign(entry, { outcome: "accepted", height: out?.height ?? entry.height ?? null });
      n += 1;
    }
    return n;
  }

  /** Whether the sweep that moved a retired deposit into the pool is in a block (its output, or its sweep record, says so). */
  retiredSweepConfirmed(rec) {
    if (this.state.coins[`${rec.sweepTxid}:0`]?.confirmed) return true;
    return (this.state.retiredSweeps ?? []).some((s) => s.status === "confirmed" && s.txid === rec.sweepTxid);
  }

  /**
   * Deposits to retired addresses swept but not credited yet: { value } the books will owe once
   * they are credited, { incoming } what their unconfirmed sweeps will add to the pool (poolUnspent
   * leaves them out until they confirm). refund-pool's shortfall counts both.
   */
  retiredOutstanding() {
    let value = 0;
    const sweeps = new Set();
    for (const rec of Object.values(this.state.retiredDeposits ?? {})) {
      if (rec.status !== "swept") continue;
      value += rec.value;
      sweeps.add(rec.sweepTxid);
    }
    let incoming = 0;
    for (const txid of sweeps) {
      const c = this.state.coins[`${txid}:0`];
      if (c && c.hold && !c.confirmed && c.status === "unspent") incoming += c.value;
    }
    return { value, incoming };
  }

  get items() {
    return Object.values(this.state.items);
  }

  /** Waiting Next-block and fast items (MAX_QUEUE, info().queue, /api/state). Batch items have their own caps. */
  queuedCount() {
    return this.items.filter((i) => isWaiting(i) && !isHeld(i)).length;
  }

  /** Waiting items of one batch epoch: `mode` anchored at `start`. */
  batchQueued(mode, start) {
    return this.items.filter((i) => isWaiting(i) && i.mode === mode && i.anchor === start).length;
  }

  /** Every waiting item, any mode: each one still needs a coin. */
  queuedAll() {
    return this.items.filter(isWaiting).length;
  }

  safetyFor(mode) {
    return mode === "batch10" ? this.config.batch10SafetyBlocks : this.config.safetyBlocks;
  }

  capFor(mode) {
    return mode === "batch10" ? this.config.maxBatch10PerEpoch : this.config.maxBatchPerEpoch;
  }

  /** Release height and relayer deadline of a batch item anchored at `anchor`. */
  schedule(mode, anchor) {
    return { releaseAt: releaseHeight(anchor, mode), lastRelease: lastReleaseHeight(anchor, mode, this.safetyFor(mode)) };
  }

  /** Rolls the UTC day: a new HMAC key for the rate-limit buckets. */
  checkDay() {
    const day = utcDay(this.now());
    if (day === this.day) return;
    this.day = day;
    this.dayKey = randomBytes(32);
    this.buckets.clear();
  }

  /** acceptedThisBlock counts per indexer tip. A new tip also takes the published batch snapshot. */
  blockCount() {
    if (this.blockMark !== this.idx.height) {
      this.blockMark = this.idx.height;
      this.acceptedThisBlock = 0;
      this.snap = this.snapshot();
    }
    return this.acceptedThisBlock;
  }

  /**
   * Each length's current epoch and its waiting count, as of the moment the relayer saw the
   * indexer reach this tip: a live count would show anyone polling it when each batch
   * transfer was submitted.
   */
  snapshot() {
    const h = Math.max(0, this.idx.height);
    const out = {};
    for (const mode of BATCH_MODES) {
      const start = epochStart(h, mode);
      out[mode] = { start, queued: this.batchQueued(mode, start) };
    }
    return out;
  }

  /** The published waiting count of `mode`'s epoch at `start` (the snapshot; 0 for another epoch). */
  publishedQueued(mode, start) {
    this.blockCount();
    const s = this.snap[mode];
    return s && s.start === start ? s.queued : 0;
  }

  topHeight() {
    return Math.max(this.idx.height, this.chainTip ?? this.idx.height);
  }

  /** Oldest anchor a submit in `mode` may have: its deadline (anchor + 100 - safety) must not have passed. */
  minAnchor(mode = "block") {
    return this.topHeight() - (ANCHOR_WINDOW - this.safetyFor(mode));
  }

  depositConfirmations() {
    return this.config.depositConfirmations ?? DEPOSIT_CONFIRMATIONS[NETWORK];
  }

  sweepCost() {
    return sweepCostFor(this.config.maxFeeRate);
  }

  marginOpts() {
    return { marginPct: this.config.marginPct, marginMinSats: this.config.marginMinSats };
  }

  /** What one send costs the balance at the current rate (fee plus margin), or null while unknown. */
  quote() {
    const per = this.cache.feeRate === null ? null : this.perCarrier(this.cache.feeRate);
    return per === null ? null : costFor(per, this.marginOpts());
  }

  /** Fee rate above the cap, or one carrier above the per-tx cap. */
  feeHigh() {
    const per = this.perCarrier(this.cache.feeRate);
    return this.cache.feeRate > this.config.maxFeeRate || (per !== null && per > this.config.maxFeePerTx);
  }

  /**
   * First failing global gate (step 1) for `mode`, or null when submissions are accepted:
   * disabled, halted, indexer_behind, busy, fee_high, then block_full / queue_full, or
   * batch_disabled for a batch length.
   */
  gateCode(mode = "block") {
    const c = this.config;
    this.checkDay();
    if (!c.enabled) return "disabled";
    const stop = this.stopCode();
    if (stop) return stop;
    if (this.state.halted) return "halted";
    if (this.idx.height < (this.chainTip ?? 0) - c.maxIndexerLag) return "indexer_behind";
    if (!this.ticked || this.cache.feeRate === null || this.perCarrier(this.cache.feeRate) === null) return "busy";
    if (this.feeHigh()) return "fee_high";
    if (isBatchMode(mode)) {
      if (this.capFor(mode) === 0) return "batch_disabled";
    } else {
      if (this.blockCount() >= c.maxRelaysPerBlock) return "block_full";
      if (this.queuedCount() >= c.maxQueue) return "queue_full";
    }
    return null;
  }

  gateError(code, mine = false) {
    if (code === "fee_high") return new RelayError(code, { feeRate: mine ? this.cache.nextBlockRate : this.cache.feeRate, maxFeeRate: this.config.maxFeeRate });
    return new RelayError(code);
  }

  /** Fee of one carrier at `feeRate` (every TRANSACT envelope has the same size), or null if it cannot be priced. */
  perCarrier(feeRate) {
    if (feeRate === null || feeRate === undefined) return null;
    if (this.perCache?.rate !== feeRate) {
      let fee = null;
      try {
        fee = Math.max(1, this.carrierFee(new Uint8Array(envelopeLen(OP.TRANSACT)), feeRate));
      } catch {
        fee = null; // e.g. a fractional rate planCarrierTx refuses: no carrier can be built either
      }
      this.perCache = { rate: feeRate, fee };
    }
    return this.perCache.fee;
  }

  /** The fee planCarrierTx charges for `envelope` (plus `outputs`) on one P2TR input with a change output to C. */
  carrierFee(envelope, feeRate, outputs = []) {
    const probe = { txid: "00".repeat(32), vout: 0, value: 1e10 };
    return Number(planCarrierTx({ account: this.change, utxos: [probe], envelope, outputs, feeRate, changeScript: this.change.script, order: "given", sequence: RBF_SEQUENCE }).fee);
  }

  // ---------------------------------------------------------------- coins

  /** Txids of every transaction the relayer made: the ledger and the items (journaled or sent). */
  ownTxids() {
    const out = new Set(this.state.ledger.map((l) => l.txid));
    for (const i of this.items) if (i.txid) out.add(i.txid);
    // The operator's refills of a rotated pool (`murkle relayer refund-pool`, relay-balance.md §9).
    for (const r of this.state.refunds ?? []) out.add(r.txid);
    return out;
  }

  /**
   * Σ value of the coins the relayer holds: unspent or reserved (I2's poolUnspent). A held coin (an
   * operator's pool refill, a sweep of retired deposits: relay-balance.md §9) counts only once it is
   * in a block: an unconfirmed one can still be replaced or evicted, and I2 must never rest on it.
   */
  poolUnspent() {
    let s = 0;
    for (const c of Object.values(this.state.coins)) {
      if (c.hold && !c.confirmed) continue;
      if (c.status === "unspent" || c.status === "reserved") s += c.value;
    }
    return s;
  }

  /** Txids of our fan-outs not confirmed yet. */
  pendingFanouts() {
    return new Set(this.state.ledger.filter((l) => l.kind === "fanout" && l.outcome === "pending").map((l) => l.txid));
  }

  /** Coins a new transaction may spend: unspent, sent (not only journaled), not suspected missing. */
  spendableCoins() {
    const out = [];
    for (const [key, c] of Object.entries(this.state.coins)) {
      if (c.status !== "unspent" || c.unsent || this.suspect.has(key)) continue;
      if (c.kind === "deposit" && (c.reorged || !c.confirmed)) continue; // back in the mempool after a reorg: frozen
      // Change of a carrier with a service-fee output: its recipient could pin an unconfirmed
      // chain on that output (mining.md §8.8), so it is spent only once it confirms.
      if (c.thirdParty && !c.confirmed) continue;
      // A sweep of retired deposit addresses: the old key is compromised, so the sweep may still be
      // replaced; nothing is chained on it before it confirms (relay-balance.md §9).
      if (c.hold && !c.confirmed) continue;
      const at = key.lastIndexOf(":");
      out.push({ key, txid: key.slice(0, at), vout: Number(key.slice(at + 1)), ...c });
    }
    return out;
  }

  depthOf(coin) {
    return coin.confirmed ? 0 : coin.depth;
  }

  /** The unconfirmed fan-out a coin descends from, or null. */
  rootOf(coin, pending = this.pendingFanouts()) {
    if (coin.confirmed) return null;
    return coin.root && pending.has(coin.root) ? coin.root : null;
  }

  /** Carriers that may still go below the unconfirmed fan-out `root` (24 minus those already sent). */
  descendantsLeft(root) {
    const below = this.items.filter((i) => i.fanout === root && (i.status === "signing" || i.status === "broadcast")).length;
    return Math.max(0, MAX_DESCENDANTS - below);
  }

  /** Fee of a merge of `n` inputs into one output to C at `rate` (maybeMerge), by the one fee rule. */
  mergeFee(n, rate) {
    return feeAt(rate, 11 + 57.5 * n + 43);
  }

  /**
   * How many of `available` deposits one merge may take now: at most MAX_MERGE_INPUTS, no more
   * than maxFeePerTx allows at `rate`, and no more than the available margin pays for. Each
   * credit puts only its own input's sweepCost in the margin, not the merge's 54 vB overhead,
   * so a lone deposit cannot pay for its own merge at 3 sat/vB or more (audit V2-16).
   */
  mergeRoom(available, rate = this.cache.feeRate, extra = 0) {
    if (rate === null || rate === undefined || !(rate > 0) || this.feeHigh()) return 0;
    const cap = Math.min(this.config.maxFeePerTx, this.books.availableMargin());
    // `extra`: pool coins the merge also spends (its partner, L1); they count toward every limit.
    let n = Math.min(MAX_MERGE_INPUTS - extra, available, Math.floor((this.config.maxFeePerTx / Math.ceil(rate) - 54) / 57.5) - extra);
    while (n > 0 && this.mergeFee(n + extra, rate) > cap) n -= 1;
    return Math.max(0, n);
  }

  /**
   * Coins that can fund carriers in this block: C's change coins, plus the one output the merge
   * maybeMerge would sign (mergePlan: the same deposits, the same partner, the same rules), in
   * place of the partner coin that merge spends. `pending`: sends not queued yet to count as
   * waiting (1 for a submit being checked: the merge that follows its acceptance). A deposit no
   * merge can take yet funds nothing: counting it answered 202 to sends that then waited for a
   * merge that never came and expired (audit V2-16), and counting its lineage published cover no
   * merge delivered.
   */
  fundingCoins(coins = this.spendableCoins(), { pending = 0 } = {}) {
    let out = coins.filter((u) => u.kind === "change");
    const plan = this.mergePlan(coins, { pending });
    if (plan) {
      if (plan.partner) out = out.filter((u) => u.key !== plan.partner.key);
      out.push({ key: "(merge)", kind: "change", value: plan.value, confirmed: false, depth: 1, root: null, mix: plan.mix });
    }
    return out;
  }

  /**
   * The merge maybeMerge signs now, or null (relay-balance.md §5, L1). Deterministic, so the
   * cover fundingCoins publishes is the cover the merge delivers:
   * - deposits: credited, confirmed, and credited before this block unless the change coins
   *   cannot fund the waiting carriers plus MERGE_ROOM more;
   * - partner (L1, minMix > 0): the confirmed change coin adding the most accounts outside those
   *   deposits (mergePartner), dropped when the margin cannot pay for its input too;
   * - at most mergeRoom inputs: one deposit per account first, accounts outside the partner's
   *   lineage first, then the oldest credit, then the outpoint;
   * - never one account's deposits alone (with no partner) unless a queued send has no coin
   *   without them; with minMix 0 (L1 off) deposits merge alone, at once, as before.
   * `pending`: sends to count as waiting besides the queued ones (for a submit being checked, the
   * merge that follows its acceptance).
   * -> { inputs (deposits, then the partner), partner, fee, value, mix }
   */
  mergePlan(coins = this.spendableCoins(), { pending = 0 } = {}) {
    const c = this.config;
    const rate = this.cache.feeRate;
    if (rate === null || rate === undefined || this.feeHigh()) return null;
    const change = coins.filter((u) => u.kind === "change");
    const capacity = this.capacity(change);
    const waiting = this.queuedAll() + pending;
    const low = capacity < waiting + MERGE_ROOM;
    const h = this.idx.height;
    const eligible = coins.filter((u) => u.kind === "deposit" && u.confirmed && (low || !(u.creditedAt >= h)));
    if (!eligible.length) return null;
    const tagOf = (u) => this.mixOf(u.key, u)[0] ?? u.key;
    const tags = new Set(eligible.map(tagOf));
    let partner = c.minMix > 0 ? this.mergePartner(tags, change) : null;
    // A margin that pays for the deposits but not for the partner's input too: the deposits go
    // without it (still never alone, below), rather than wait for more margin.
    if (partner && this.mergeRoom(eligible.length, rate, 1) === 0) partner = null;
    const inPartner = new Set(partner ? this.mixOf(partner.key, partner) : []);
    const rank = new Map();
    const ranked = [...eligible]
      .sort((a, b) => (a.creditedAt ?? 0) - (b.creditedAt ?? 0) || (a.height ?? 0) - (b.height ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map((u) => {
        const t = tagOf(u);
        rank.set(t, (rank.get(t) ?? 0) + 1);
        return { u, r: rank.get(t), inside: inPartner.has(t) ? 1 : 0 };
      });
    // Stable: within one rank, accounts the partner does not hold yet first, else oldest first.
    ranked.sort((a, b) => a.r - b.r || a.inside - b.inside);
    const deposits = ranked.map((x) => x.u).slice(0, this.mergeRoom(eligible.length, rate, partner ? 1 : 0));
    if (!deposits.length) return null;
    const accounts = new Set(deposits.map(tagOf)).size;
    // (With minMix 0 every coin covers every send, so a lone merge still adds capacity at once.)
    if (!partner && accounts < 2 && c.minMix > 0 && !(capacity < waiting)) return null;
    const inputs = [...deposits, ...(partner ? [partner] : [])];
    const fee = this.mergeFee(inputs.length, rate);
    const total = inputs.reduce((sum, u) => sum + u.value, 0);
    if (fee > c.maxFeePerTx || total - fee < DUST) return null;
    return { inputs, partner, fee, value: total - fee, mix: unionMix(inputs.map((u) => this.mixOf(u.key, u))) };
  }

  // ------------------------------------------------------- lineage (L1)

  /** The opaque lineage tag of an account: 16 hex chars of HMAC(mixKey, its books key). */
  mixTag(acct) {
    return createHmac("sha256", this.mixKey).update(String(acct)).digest("hex").slice(0, 16);
  }

  /**
   * The lineage of a coin: a credited deposit descends from its own account; a change coin from
   * the accounts recorded when it was made (none for a coin made before lineage was tracked,
   * which never counts as cover).
   */
  mixOf(key, coin) {
    if (coin?.kind === "deposit") {
      let credit = null;
      try {
        credit = this.books.isCredited(key);
      } catch {
        credit = null;
      }
      return credit && !credit.reversed && !credit.settled ? [this.mixTag(credit.id)] : [];
    }
    return Array.isArray(coin?.mix) ? coin.mix : [];
  }

  /**
   * Whether a coin of lineage `mix` may carry a send (L1): at least k + 1 accounts (k = minMix),
   * so whoever sends, at least k others are in it. The same for every sender, so a carrier tells
   * nothing about whether its sender is in its coin's lineage. minMix 0: always.
   */
  covers(mix) {
    const k = this.config.minMix;
    return !(k > 0) || mix.length >= k + 1;
  }

  /**
   * True when no coin that can fund carriers (change coins and the output of the merge maybeMerge
   * makes, fundingCoins) covers a send: the pool is thin, for every sender alike. A submit being
   * checked passes fundingCoins with pending 1.
   */
  thinFor(coins = this.fundingCoins()) {
    if (!(this.config.minMix > 0)) return false;
    return !coins.some((u) => u.kind === "change" && this.covers(this.mixOf(u.key, u)));
  }

  /**
   * Accounts that have had a deposit credited: a public aggregate. Counted from the accounts'
   * address counters, so it survives settled credits (which no longer name an account).
   */
  depositorCount() {
    let n = 0;
    for (const a of this.books.accounts.values()) if (a.nextIndex > 0) n += 1;
    return n;
  }

  /**
   * info().balance.mix: { k, coverOk, depositors }. coverOk: a coin with at least k + 1 accounts
   * can fund a carrier now (the rule every send meets, whoever sends); always false with k = 0,
   * where no lineage is enforced at all.
   */
  mixInfo() {
    const k = this.config.minMix;
    return { k, coverOk: k > 0 && !this.thinFor(this.fundingCoins(undefined, { pending: 1 })), depositors: this.depositorCount() };
  }

  /**
   * The pool coin a merge takes along with fresh deposits whose accounts are `tags` (L1): a
   * confirmed change coin whose lineage holds accounts outside `tags`, the one adding the most,
   * then the widest lineage, then the lowest outpoint (deterministic: fundingCoins and
   * maybeMerge must agree), or null when there is none.
   */
  mergePartner(tags, change) {
    let best = null;
    let bestAdd = 0;
    for (const u of change) {
      if (!u.confirmed || u.key === "(merge)") continue;
      const mix = this.mixOf(u.key, u);
      const add = mix.filter((t) => !tags.has(t)).length;
      if (add === 0) continue;
      const wider = best && mix.length > this.mixOf(best.key, best).length;
      const same = best && mix.length === this.mixOf(best.key, best).length;
      if (!best || add > bestAdd || (add === bestAdd && (wider || (same && u.key < best.key)))) {
        best = u;
        bestAdd = add;
      }
    }
    return best;
  }

  /**
   * Carriers the pool can fund in one block (batch-contract §3.6), from the coin set only
   * (by default fundingCoins(): change coins and the output of a merge the margin pays now). A
   * coin at chain depth d funds min(21 - d, floor((value - 330) / fee)) chained carriers;
   * confirmed coins are depth 0. Every coin below one unconfirmed fan-out shares that
   * fan-out's 24 descendants.
   */
  capacity(coins = this.fundingCoins(), feeRate = this.cache.feeRate) {
    const per = this.perCarrier(feeRate);
    if (!per) return 0;
    const pending = this.pendingFanouts();
    let total = 0;
    const under = new Map(); // fan-out txid -> carriers its coins could fund
    for (const u of coins) {
      const depth = this.depthOf(u);
      if (depth === undefined || depth === null) continue;
      const run = Math.max(0, Math.min(CHAIN_LEN - depth, Math.floor((Number(u.value) - DUST) / per)));
      const root = this.rootOf(u, pending);
      if (root) under.set(root, (under.get(root) ?? 0) + run);
      else total += run;
    }
    for (const [root, run] of under) total += Math.min(run, this.descendantsLeft(root));
    return total;
  }

  /**
   * A carrier's coin (relay-balance.md §5): a change coin of C, never a deposit (deposits reach
   * C only through a merge, maybeMerge), chosen uniformly at random (crypto RNG) among the
   * confirmed coins that cover `need`; else among our own unconfirmed change, at most 20 deep
   * and, below an unconfirmed fan-out, only while it has room for one more descendant.
   * With `cover` (a user's send, L1) only coins whose lineage holds minMix + 1 accounts count (the
   * same coins for every sender); a `linkable` send that finds none takes the usable coin with the
   * widest lineage instead. Without `cover` (housekeeping checks) lineage is not looked at.
   */
  pickCoin(coins, need, { cover = false, linkable = false } = {}) {
    const pending = this.pendingFanouts();
    const room = (u) => {
      const root = this.rootOf(u, pending);
      return !root || this.descendantsLeft(root) > 0;
    };
    const usable = (u) => u.kind === "change" && u.value >= need && (u.confirmed || ((this.depthOf(u) ?? Infinity) <= MAX_CHAIN_DEPTH && room(u)));
    const anyOf = (list) => (list.length ? list[randomInt(list.length)] : null);
    const pick = (fits) => anyOf(fits.filter((u) => u.confirmed)) ?? anyOf(fits.filter((u) => !u.confirmed));
    let fits = coins.filter(usable);
    if (!cover) return pick(fits);
    const covered = fits.filter((u) => this.covers(this.mixOf(u.key, u)));
    if (covered.length || !linkable) return pick(covered);
    // Linkable: the widest lineage there is (the sender accepted that it may be narrow).
    const score = (u) => this.mixOf(u.key, u).length;
    const best = Math.max(-1, ...fits.map(score));
    fits = fits.filter((u) => score(u) === best);
    return pick(fits);
  }

  /** The script and internal key a coin is spent with: a deposit address of its account, or C. */
  spendInfo(key, coin) {
    if (coin.kind === "deposit") {
      const credit = this.books.isCredited(key);
      if (!credit || credit.reversed) throw new Error(`I0: ${key} is not a credited deposit`);
      // L2: the coin keeps the deposit's tweak, never its account id (keyAccounts, credit()).
      if (!HEX32.test(String(coin.tweak ?? ""))) throw new Error(`I0: ${key} has no deposit tweak`);
      const key32 = depositKeyOfTweak(this.Q, coin.tweak);
      return { script: btc.p2tr(key32, undefined, BTC_NETWORK).script, tapInternalKey: key32, secret: () => depositSecretOfTweak(this.poolSecret, coin.tweak) };
    }
    if (coin.kind === "change") return { script: this.change.script, tapInternalKey: this.change.pub, secret: () => this.changeSecret };
    throw new Error(`I0: ${key} is of an unknown kind`);
  }

  /** A coin as planCarrierTx takes it, with its own script and internal key. */
  utxoOf(coin) {
    const { script, tapInternalKey } = this.spendInfo(coin.key, coin);
    return { txid: coin.txid, vout: coin.vout, value: coin.value, script, tapInternalKey };
  }

  // ------------------------------------------------------------- I-PAY

  /**
   * I0/I1, outputs: a carrier pays output 0 = OP_RETURN with exactly its envelope; after it,
   * the outputs that do not pay C are exactly `feeOutputs`, in their order (script and amount:
   * the service-fee outputs the indexer requires for a mining claim, none for a transfer), and
   * every other output pays C (the change may sit at any position after 0, L5); a housekeeping
   * transaction pays every output to C. Q's script and deposit scripts are never paid.
   */
  assertOutputs(tx, kind, envelope, feeOutputs = []) {
    if (!tx.outputsLength) throw new Error("I1: a transaction with no outputs");
    if (feeOutputs.length && kind !== "carrier") throw new Error("I1: only a claim's carrier pays service fees");
    if (tx.outputsLength < 1 + feeOutputs.length) throw new Error("I1: a carrier without its service-fee outputs");
    for (const o of feeOutputs) if (this.isOwnScript(o.script)) throw new Error("I1: a service-fee output pays the relayer's own key");
    let next = 0; // the next required service-fee output
    for (let v = 0; v < tx.outputsLength; v++) {
      const script = tx.getOutput(v).script;
      if (kind === "carrier" && v === 0) {
        if (!envelope || !equal(script, opReturnScript(envelope))) throw new Error("I1: output 0 is not the item's envelope");
        continue;
      }
      if (equal(script, this.change.script)) continue;
      const want = kind === "carrier" ? feeOutputs[next] : undefined;
      if (!want) throw new Error(`I1: output ${v} does not pay the change key`);
      if (!equal(script, want.script) || BigInt(tx.getOutput(v).amount) !== BigInt(want.amount)) throw new Error(`I1: output ${v} is not the required service-fee output`);
      next += 1;
    }
    if (next !== feeOutputs.length) throw new Error("I1: a carrier without its service-fee outputs");
  }

  /**
   * The service-fee outputs a carrier of `envelope` must pay: none for a transfer; for a
   * MINE_SCRIPT claim, requiredFeeOutputs of its asset from this relayer's own indexer.
   */
  feeOutputsForEnvelope(envelope) {
    if (!envelope || headerOp(envelope) !== OP.MINE_SCRIPT) return [];
    let env;
    try {
      env = decodeEnvelope(envelope);
    } catch {
      throw new Error("I1: the claim's envelope does not decode");
    }
    const outs = this.feeOutputsOf(env.publicAsset);
    if (!outs) throw new Error("I1: a claim of an asset the indexer does not know as mined");
    return outs;
  }

  /**
   * I0, provenance: every input is in the coin set, unspent, and either a credited deposit
   * (not reversed) or change of a transaction in the relayer's journal.
   */
  assertProvenance(inputs) {
    const own = this.ownTxids();
    const seen = new Set();
    for (const u of inputs) {
      const key = `${u.txid}:${u.vout}`;
      const coin = this.state.coins[key];
      if (seen.has(key)) throw new Error(`I0: ${key} spent twice`);
      seen.add(key);
      if (!coin || coin.status !== "unspent") throw new Error(`I0: ${key} is not an unspent pool coin`);
      if (coin.kind === "deposit") {
        const credit = this.books.isCredited(key);
        if (!credit || credit.reversed) throw new Error(`I0: ${key} is not a credited deposit`);
      } else if (coin.kind === "change") {
        if (!coin.parent || !own.has(coin.parent) || coin.parent !== u.txid) throw new Error(`I0: ${key} is not change of the relayer's own transaction`);
      } else throw new Error(`I0: ${key} is of an unknown kind`);
    }
  }

  /**
   * The only function that signs (I-PAY, contract §3). `tx` is the final unsigned transaction,
   * `inputs` its coins in input order, `ref` the item id for a carrier or null for housekeeping
   * (paid from the margin account). `journal(signed, { fee, cost, service })` records the
   * transaction on its item or ledger entry; everything is saved in one durable write before
   * this returns, so before any broadcast. `feeOutputs`, when given, must be exactly the
   * service-fee outputs the indexer requires for `envelope` (feeOutputsForEnvelope): they are
   * derived from the envelope here, never taken from the caller. Throws
   * BooksError("balance_low" | "margin_low") or Error("I0…"/"I1…").
   */
  signPoolTx({ tx, inputs, ref, kind, envelope, feeOutputs, journal }) {
    if ((kind === "carrier") !== Boolean(ref)) throw new Error("I1: a carrier is charged to its item, housekeeping to the margin");
    // 1. Outputs: the envelope, the required service-fee outputs (mining claims), the rest to C.
    const required = kind === "carrier" ? this.feeOutputsForEnvelope(envelope) : [];
    if (feeOutputs !== undefined && (feeOutputs.length !== required.length
      || feeOutputs.some((o, k) => !equal(o.script, required[k].script) || BigInt(o.amount) !== BigInt(required[k].amount)))) {
      throw new Error("I1: the fee outputs are not the ones the indexer requires for this envelope");
    }
    this.assertOutputs(tx, kind, envelope, required);
    // 2. Provenance. A carrier never spends a deposit (it would sit one hop from the payer's address).
    this.assertProvenance(inputs);
    if (kind === "carrier" && inputs.some((u) => this.state.coins[`${u.txid}:${u.vout}`]?.kind !== "change")) throw new Error("I0: a carrier spends only change of C, never a deposit");
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      const u = inputs[i];
      if (!u || hex(input.txid) !== u.txid || input.index !== u.vout || Number(input.witnessUtxo?.amount) !== this.state.coins[`${u.txid}:${u.vout}`].value) {
        throw new Error(`I0: input ${i} is not the coin it names`);
      }
    }
    // 3. The fee, from the final transaction's amounts; what leaves the pool is exactly the
    // fee plus the service-fee outputs (spent = Σ inputs − Σ outputs to C).
    const fee = feeOf(tx);
    if (!(fee > 0) || fee > this.config.maxFeePerTx) throw new Error(`I1: fee ${fee} is outside 1..${this.config.maxFeePerTx}`);
    const service = required.reduce((s, o) => s + Number(o.amount), 0);
    let inSum = 0;
    for (const u of inputs) inSum += this.state.coins[`${u.txid}:${u.vout}`].value;
    let toC = 0;
    for (let v = 0; v < tx.outputsLength; v++) if (equal(tx.getOutput(v).script, this.change.script)) toC += Number(tx.getOutput(v).amount);
    if (inSum - toC !== fee + service) throw new Error(`I1: ${inSum - toC} sats leave the pool, not the fee ${fee} plus service fees ${service}`);
    // 4. Charge it (fee + service + margin for a carrier) before anything is signed.
    let charge = null;
    if (kind === "carrier") charge = this.books.settle(ref, { fee, service });
    else this.books.payHousekeeping(fee);
    const undo = () => (kind === "carrier" ? this.rereserve(ref) : this.books.refundHousekeeping(fee));
    // 5. The pool still covers every balance, reservation and the margin.
    if (this.poolUnspent() - inSum + toC < this.books.liabilities()) {
      undo();
      this.halt(["the pool coins would fall below balances, reservations and margin"]);
      throw new Error("I1: pool check failed");
    }
    // 6. Sign each input with its own key.
    let signed;
    try {
      signed = signInputs(tx, inputs.map((u) => this.spendInfo(`${u.txid}:${u.vout}`, this.state.coins[`${u.txid}:${u.vout}`]).secret()));
    } catch (e) {
      undo();
      throw e;
    }
    // 7. Spend the inputs, add the change, journal, save: all before any broadcast. Every new
    // change coin descends from the accounts of all the inputs (L1 lineage, opaque tags).
    const mix = unionMix(inputs.map((u) => this.mixOf(`${u.txid}:${u.vout}`, this.state.coins[`${u.txid}:${u.vout}`])));
    const pending = this.pendingFanouts();
    let depth = 0;
    let root = null;
    for (const u of inputs) {
      const coin = this.state.coins[`${u.txid}:${u.vout}`];
      depth = Math.max(depth, this.depthOf(coin) ?? MAX_CHAIN_DEPTH);
      root ??= this.rootOf(coin, pending);
      coin.status = "spent";
      coin.spentBy = signed.txid;
    }
    if (kind === "fanout") root = signed.txid;
    for (let v = 0; v < tx.outputsLength; v++) {
      const out = tx.getOutput(v);
      if (!equal(out.script, this.change.script)) continue;
      this.state.coins[`${signed.txid}:${v}`] = {
        value: Number(out.amount), kind: "change", parent: signed.txid, status: "unspent", confirmed: false, depth: depth + 1, root, unsent: true, mix,
        ...(required.length ? { thirdParty: true } : {}), // not spent before it confirms (spendableCoins)
      };
    }
    journal?.(signed, { fee, cost: charge?.cost ?? null, root, service });
    this.save();
    return { ...signed, fee, cost: charge?.cost ?? null, ...(service ? { service } : {}) };
  }

  /** Coins spent by `txid` go back to unspent (suspected missing this block); its outputs are forgotten. */
  revertCoins(txid) {
    if (!txid) return;
    for (const [key, c] of Object.entries(this.state.coins)) {
      if (c.parent === txid) {
        if (c.status === "spent") this.halt([`a dropped transaction's output ${key} was already spent`], { sticky: true });
        delete this.state.coins[key];
      } else if (c.status === "spent" && c.spentBy === txid) {
        c.status = "unspent";
        delete c.spentBy;
        this.suspect.set(key, this.idx.height);
      }
    }
  }

  /** I2 (contract §3): the books add up and the pool covers them, or the relayer halts. */
  checkBooks() {
    const r = this.books.checkI2({ poolUnspent: this.poolUnspent() });
    if (!r.ok) this.halt(r.problems);
    else if (this.state.halted && !this.state.halted.sticky) {
      this.log.warn?.("relayer: the books add up again; taking sends");
      this.state.halted = null;
    }
    return r;
  }

  halt(problems, { sticky = false } = {}) {
    const prev = this.state.halted;
    const all = [...new Set([...(prev?.problems ?? []), ...problems])];
    this.state.halted = { height: this.idx.height, problems: all, ...(sticky || prev?.sticky ? { sticky: true } : {}) };
    this.log.error?.(`relayer halted (no new transactions are signed): ${problems.join("; ")}`);
  }

  // ------------------------------------------------------------ rate limit

  bucketFor(ip) {
    const key = createHmac("sha256", this.dayKey).update(ipPrefix(ip)).digest("hex");
    let b = this.buckets.get(key);
    if (!b) this.buckets.set(key, (b = { batch: {}, calls: [] }));
    const now = this.now();
    b.calls = b.calls.filter((t) => t > now - HOUR);
    // Per-epoch batch counts; an epoch that has closed no longer limits anything.
    for (const k of Object.keys(b.batch)) {
      const at = k.lastIndexOf(":");
      if (this.idx.height >= releaseHeight(Number(k.slice(at + 1)), k.slice(0, at))) delete b.batch[k];
    }
    return b;
  }

  /** Account reads and credits per IP prefix per hour (accountPerHour). Throws rate_limited. */
  countCall(ip) {
    const b = this.bucketFor(ip);
    if (b.calls.length >= this.config.accountPerHour) {
      throw new RelayError("rate_limited", { retryAfter: Math.max(1, Math.ceil((b.calls[0] + HOUR - this.now()) / 1000)) });
    }
    b.calls.push(this.now());
  }

  invalidFor(idHex) {
    const now = this.now();
    const list = (this.invalid.get(idHex) ?? []).filter((t) => t > now - HOUR);
    if (list.length) this.invalid.set(idHex, list);
    else this.invalid.delete(idHex);
    return list;
  }

  /**
   * A submit signature seen in the last 1,200 s is a replay (409). Records this one. Entries
   * are kept in insertion order, which is expiry order, so expiry stops at the first live one
   * (constant time per call, not a walk of the whole map); a full map answers busy.
   */
  checkReplay(sig) {
    const now = this.now();
    for (const [k, until] of this.replays) {
      if (until > now) break;
      this.replays.delete(k);
    }
    const k = createHash("sha256").update(sig).digest("hex");
    if (this.replays.has(k)) throw new RelayError("replayed");
    if (this.replays.size >= MAX_REPLAYS) throw new RelayError("busy");
    this.replays.set(k, now + REPLAY_MS);
  }

  /**
   * Explorer lookups that credit() may make (contract §4.2 step 6): at most
   * creditLookupsPerMinute in total, whatever the IP, so unsigned credit calls with made-up
   * txids cannot use up the explorer quota the indexer syncs with. Throws busy.
   */
  takeCreditLookup() {
    const now = this.now();
    while (this.creditLookups.length && this.creditLookups[0] <= now - 60_000) this.creditLookups.shift();
    if (this.creditLookups.length >= this.config.creditLookupsPerMinute) {
      throw new RelayError("busy", { retryAfter: Math.max(1, Math.ceil((this.creditLookups[0] + 60_000 - now) / 1000)) }, CREDIT_BUSY_MESSAGE);
    }
    this.creditLookups.push(now);
  }

  // ---------------------------------------------------------------- submit

  /** Wraps one endpoint: RelayErrors become their answers; anything else is logged by name only. */
  async answer(what, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RelayError) return { status: e.status, body: e.toJSON() };
      // Never the message: it may quote the request. The name and the code are enough.
      this.log.error?.(`relay ${what} failed: internal error (${e?.name ?? "Error"}${e?.code ? ` ${e.code}` : ""})`);
      const busy = new RelayError("busy");
      return { status: busy.status, body: busy.toJSON() };
    }
  }

  /**
   * POST /api/relay/submit (contract §4.2), steps 0-9 in order; the first failure answers and
   * nothing mutates before step 9 (except the replay record and an invalid-proof penalty).
   * `rawBody` is the already size-capped request body text. Returns { status, body }.
   */
  submit(rawBody, ip) {
    return this.answer("submit", async () => {
      if (this.holdSeen === null && !this.frozen) this.checkHold()?.catch(() => {}); // an operator's HOLD refuses at once
      const req = parseSubmit(rawBody); // 0
      // A mining claim (header op MINE_SCRIPT) takes the claim path (mining-contract.md §9.3).
      const head = unhex(req.envelope);
      const claim = equal(head.subarray(0, MAGIC.length), MAGIC) && head[MAGIC.length] === VERSION && headerOp(head) === OP.MINE_SCRIPT;
      const gate = this.gateCode(claim && isBatchMode(req.mode) ? "block" : req.mode); // 1
      if (gate) throw this.gateError(gate);
      const mineGate = claim ? this.mineGateCode() : null; // mine_disabled until mining is active at the next block
      if (mineGate) throw this.gateError(mineGate, true);
      const auth = this.verifySubmit(req.body); // 2
      if (!auth.ok) throw new RelayError(auth.code, auth.code === "stale_request" ? { serverTime: Math.floor(this.now() / 1000) } : {});
      this.checkReplay(req.body.sig);
      if (claim) return await this.acceptClaim(req, head, auth.idHex); // 3
      // 3. The balance, before any proof work.
      const batch = isBatchMode(req.mode);
      const quote = this.quote();
      const need = quote * (batch ? this.config.batchHeadroom : 1);
      // A credit whose deposit went back to the mempool does not count until it confirms again.
      const balance = Math.max(0, this.books.account(auth.idHex).balance - this.frozenSats(this.books.keyOf(auth.idHex)));
      if (balance < need) throw new RelayError("balance_low", { balance, needed: need, perSend: quote });
      // 3b. Cover (L1): a coin whose lineage holds minMix + 1 accounts, or consent.
      req.thin = this.checkCover(req.linkable);
      // 4. Rate limits: invalid proofs per account (the per-IP batch bucket is checked at 6b).
      const bad = this.invalidFor(auth.idHex);
      if (bad.length >= this.config.invalidPerHour) throw new RelayError("rate_limited", { retryAfter: Math.max(1, Math.ceil((bad[0] + HOUR - this.now()) / 1000)) });
      const bucket = this.bucketFor(ip);
      return await this.validateAndAccept(req, { bucket, idHex: auth.idHex, need });
    });
  }

  /**
   * L1 cover for a send: whether the pool is thin (thinFor, the same for every sender). A thin
   * pool refuses with 409 pool_thin unless the signed request said `linkable: true`; then the
   * send goes on and its carrier takes the widest coin there is. Returns the thin flag.
   */
  checkCover(linkable) {
    const thin = this.thinFor(this.fundingCoins(undefined, { pending: 1 }));
    if (thin && linkable !== true) throw new RelayError("pool_thin", { k: this.config.minMix, depositors: this.depositorCount() });
    return thin;
  }

  /**
   * Step 2 for a submit: the shared verifyRequest, which takes the base key set or the base plus
   * the signed boolean `linkable` (OPTIONAL_REQUEST_FIELDS): accountPub, t, sig, the clock skew,
   * then a BIP340 signature over the request digest of every field but sig.
   * -> { ok: true, id, idHex } | { ok: false, code }
   */
  verifySubmit(body) {
    return verifyRequest({ endpoint: RELAY_ENDPOINTS.submit, network: NETWORK, poolKey: this.Q, body, now: this.now });
  }

  async validateAndAccept(req, { bucket, idHex, need }) {
    const idx = this.idx;
    const batch = isBatchMode(req.mode);
    // 5. Strict decode; only zero-public-value TRANSACT.
    const bytes = unhex(req.envelope);
    if (!equal(bytes.subarray(0, MAGIC.length), MAGIC) || bytes[MAGIC.length] !== VERSION) throw new RelayError("malformed");
    if (headerOp(bytes) !== OP.TRANSACT) throw new RelayError("not_transact");
    let env;
    try {
      env = decodeEnvelope(bytes);
    } catch {
      throw new RelayError("malformed");
    }
    if (env.publicAmount !== 0n || env.publicAsset !== 0n) throw new RelayError("public_value");

    // Nullifiers: dedupe by nullifier (not by bytes), then claim synchronously.
    const nullifiers = env.nullifiers.map(String);
    if (nullifiers[0] === nullifiers[1]) throw new RelayError("duplicate_nullifier");
    if (nullifiers.some((n) => idx.nullifiers.has(n))) throw new RelayError("nullifier_spent");
    if (nullifiers.some((n) => this.pending.has(n))) throw new RelayError("nullifier_pending");
    const token = `validating:${randomBytes(8).toString("hex")}`;
    nullifiers.forEach((n) => this.pending.set(n, token));
    let accepted = false;
    try {
      // 6. Freshness.
      if (!idx.roots.has(env.anchor) || env.anchor > idx.height) throw new RelayError("anchor_unknown");
      // Per length: a 10-hour item has until S + 100 - BATCH10_SAFETY_BLOCKS, whatever SAFETY_BLOCKS is.
      if (env.anchor < this.minAnchor(req.mode)) throw new RelayError("anchor_stale");
      const root = String(idx.roots.get(env.anchor));
      // 6b. Batch modes: the epoch and its caps; every mode: coins for one more carrier.
      this.checkRoom(req.mode, env.anchor, bucket);

      // 7. Full consensus check, bounded in parallelism and rate.
      const verdict = await this.verified(() => idx.checkTx(env, { inputs: [], outputs: [] }, idx.height + 1));
      if (verdict !== true) {
        const code = codeForReason(verdict);
        if (code === "proof_invalid") {
          // An invalid proof costs a small fee to the margin and counts toward the per-account limit.
          this.books.penalize(idHex, this.config.invalidProofSats);
          this.invalid.set(idHex, [...this.invalidFor(idHex), this.now()]);
          this.save();
        }
        throw new RelayError(code);
      }

      // 8. A block may have landed (or rolled back) during the await.
      if (nullifiers.some((n) => idx.nullifiers.has(n))) throw new RelayError("nullifier_spent");
      if (String(idx.roots.get(env.anchor)) !== root) throw new RelayError("anchor_unknown");
      const gate = this.gateCode(req.mode); // block, queue, batches and fees may have moved meanwhile
      if (gate) throw this.gateError(gate);
      this.checkRoom(req.mode, env.anchor, bucket);
      req.thin = this.checkCover(req.linkable); // coins may have moved during the proof check
      const id = randomBytes(16).toString("hex");
      try {
        this.books.reserve(id, idHex, need); // a parallel submit may have taken the balance
      } catch (e) {
        if (e instanceof BooksError && e.code === "balance_low") throw new RelayError("balance_low", { balance: this.books.account(idHex).balance, needed: need, perSend: this.quote() });
        throw e;
      }

      // 9. Accept, persist, then answer.
      const item = {
        id, status: "queued", nullifiers, anchor: env.anchor, root, mode: req.mode,
        acceptedHeight: idx.height, envelope: req.envelope, account: this.books.keyOf(idHex), reservation: need, attempts: 0,
        ...(req.linkable === true ? { linkable: true } : {}),
        ...(batch ? this.schedule(req.mode, env.anchor) : {}),
      };
      // An epoch accepted under other safety settings keeps its earliest deadline: promise that one.
      if (batch) item.lastRelease = this.deadlineOf(item);
      this.state.items[id] = item;
      nullifiers.forEach((n) => this.pending.set(n, id));
      this.blockCount();
      if (batch) {
        const k = epochKey(req.mode, env.anchor);
        bucket.batch[k] = (bucket.batch[k] ?? 0) + 1;
      } else {
        this.acceptedThisBlock += 1;
      }
      this.save();
      accepted = true;
      if (req.mode === "fast") this.scheduleFast(id);
      const balance = this.books.account(idHex).balance;
      // `thin`: no coin hid this account among minMix others when it was accepted, so its carrier
      // can be tied to few depositors (it was sent only because the request said linkable).
      const body = { id, status: "queued", anchor: env.anchor, deadline: env.anchor + ANCHOR_WINDOW, reservedSats: need, balance, ...linkableBody(req) };
      if (!batch) return { status: 202, body: { ...body, flush: req.mode === "fast" ? "fast" : "next-block" } };
      return {
        status: 202,
        body: {
          ...body, flush: req.mode, mode: req.mode, epochBlocks: EPOCH_BLOCKS[req.mode],
          // The published count (as of this block) plus this one: a live count would time other submits.
          releaseAt: item.releaseAt, lastRelease: item.lastRelease, epochQueued: this.publishedQueued(req.mode, env.anchor) + 1,
        },
      };
    } finally {
      if (!accepted) nullifiers.forEach((n) => this.pending.get(n) === token && this.pending.delete(n));
    }
  }

  /**
   * Step 6b (batch-contract §3.2), run again at step 8: for a batch length, the anchor opens an
   * epoch that is still open and the epoch and this network's share of it have room; for every
   * mode, the pool coins can fund every waiting carrier plus this one (pool_low).
   */
  checkRoom(mode, anchor, bucket) {
    if (isBatchMode(mode)) {
      const e = EPOCH_BLOCKS[mode];
      const h = this.idx.height;
      if (anchor % e !== 0) throw new RelayError("anchor_not_boundary", { epochBlocks: e });
      if (h >= anchor + e) {
        const start = epochStart(h, mode);
        throw new RelayError("epoch_closed", { mode, epochStart: start, releaseAt: start + e });
      }
      if (this.batchQueued(mode, anchor) >= this.capFor(mode)) throw new RelayError("batch_full", { releaseAt: anchor + e });
      if ((bucket.batch[epochKey(mode, anchor)] ?? 0) >= this.config.batchPerIp) {
        throw new RelayError("rate_limited", { retryAfter: (anchor + e - h) * BLOCK_SECONDS }, BATCH_IP_MESSAGE);
      }
    }
    if (this.queuedAll() + 1 > this.capacity(this.fundingCoins(undefined, { pending: 1 }))) throw new RelayError("pool_low");
  }

  /** Runs one Groth16 check under the concurrency semaphore and the per-second cap. */
  async verified(fn) {
    const now = this.now();
    this.verifyStarts = this.verifyStarts.filter((t) => t > now - 1000);
    if (this.verifyStarts.length >= this.config.verifyMaxPerSec) throw new RelayError("busy");
    this.verifyStarts.push(now);
    await this.verify.acquire();
    try {
      return await fn();
    } finally {
      this.verify.release();
    }
  }

  scheduleFast(id) {
    const t = setTimeout(() => {
      this.timers.delete(id);
      this.lock.run(() => this.flush({ only: [id] })).catch((e) => this.log.error?.(`fast flush failed (${e?.name ?? "Error"})`));
    }, this.fastDelayMs());
    t.unref?.();
    this.timers.set(id, t);
  }

  // --------------------------------------------------------- mining claims

  /** Claims are taken only with mineEnabled, and while the indexer applies mining at the next block. */
  mineActive() {
    return Boolean(this.config.enabled && this.config.mineEnabled) && typeof this.idx.miningActive === "function" && this.idx.miningActive(this.idx.height + 1) === true;
  }

  /** The indexer's Argon2 worker pool (idx.pow) when it is one: the relayer never hashes on its own thread. */
  powPool() {
    const p = this.idx.pow;
    return p && typeof p.hash === "function" && Number.isFinite(p.queued) ? p : null;
  }

  /** The rate a claim's carrier pays: ceil(next-block rate x mineFeeHeadroom), or null while unknown. */
  mineFeeRate() {
    const next = this.cache.nextBlockRate;
    return next === null || next === undefined ? null : Math.max(1, Math.ceil(next * this.config.mineFeeHeadroom));
  }

  /** The quoted miner fee of one claim's carrier (mineEstVsize at the carrier rate), or null. */
  mineCarrierFee(rate = this.mineFeeRate()) {
    return rate === null ? null : Math.ceil(this.config.mineEstVsize * rate);
  }

  /** After gateCode: mine_disabled (mining off, or no worker pool), busy (no rate yet) or fee_high, else null. */
  mineGateCode() {
    if (!this.mineActive() || !this.powPool()) return "mine_disabled";
    const fee = this.mineCarrierFee();
    if (fee === null) return "busy";
    if (this.cache.nextBlockRate > this.config.maxFeeRate || fee > this.config.maxFeePerTx) return "fee_high";
    return null;
  }

  /** Last tip at which a claim's carrier is signed: ref + 12 - 1 - 2 (ref + 9). */
  mineDeadline(ref) {
    return ref + MINE_WINDOW - 1 - MINE_SLACK;
  }

  /** Last tip at which a journaled claim's carrier is broadcast again: ref + 11 (it lands at ref + 12 at the latest). */
  mineLastResend(ref) {
    return ref + MINE_WINDOW - 1;
  }

  /**
   * The service-fee outputs a carrier of `assetId`'s claims pays, from this relayer's own
   * indexer (its asset terms and MINE_FEE), never from a request: [{ script, amount (bigint),
   * sats (number) }] in requiredFeeOutputs order, each raised to its dust limit as planCarrierTx
   * raises it. null when the indexer knows no mined asset `assetId`.
   */
  feeOutputsOf(assetId) {
    let id;
    try {
      id = BigInt(assetId);
    } catch {
      return null;
    }
    if (this.idx.assets.get(id)?.kind !== "pow" || typeof this.idx.requiredFeeOutputs !== "function") return null;
    return this.idx.requiredFeeOutputs(id).map(({ script, sats }) => {
      const s = Uint8Array.from(script);
      const dust = dustLimit(s);
      const amount = BigInt(sats) < dust ? dust : BigInt(sats);
      return { script: s, amount, sats: Number(amount) };
    });
  }

  /** What one claim of `assetId` costs the balance now: { fee (estimate), service, margin, total }, or null while unpriced. */
  mineQuote(assetId) {
    const fee = this.mineCarrierFee();
    if (fee === null) return null;
    const service = (this.feeOutputsOf(assetId) ?? []).reduce((s, o) => s + o.sats, 0);
    const margin = marginFor(fee, this.marginOpts());
    return { fee, service, margin, total: fee + service + margin };
  }

  /**
   * True for the change key C, the pool key Q and every deposit script the relayer credited or
   * handed out. A claim whose fee output would pay one of them is refused (mine_unsupported):
   * the pool would pay itself, or a deposit could be credited. Indexes are never enumerated:
   * nextIndex is chosen by the user (a credit at n moves it to n + 1, up to 2^31), so walking
   * 0 … nextIndex could cost billions of derivations on the main loop. A deposit address that
   * was neither credited nor handed out cannot be credited later as a fee output either:
   * credit() refuses an output of the relayer's own carriers and any deposit that pays a
   * required fee script (isFeeScript).
   */
  isOwnScript(script) {
    if (equal(script, this.change.script) || equal(script, this.poolScript)) return true;
    return this.ownScripts.has(hex(script));
  }

  /** True when `script` is a service-fee script some mined asset requires (MINE_FEE and every treasury). */
  isFeeScript(script) {
    const want = hex(script);
    if (requiredFeeOutputs({ claimFeeSats: 0n }, this.idx.mineFee ?? null).some((o) => hex(o.script) === want)) return true;
    for (const a of this.idx.assets?.values?.() ?? []) {
      if (a.kind !== "pow") continue;
      if ((this.feeOutputsOf(a.id) ?? []).some((o) => hex(o.script) === want)) return true;
    }
    return false;
  }

  /**
   * Claims of `assetId` on their way (mining.md §6.4), as Map<solutionId hex, reward (bigint)>:
   * this relayer's claim items without a verdict (queued, signing or broadcast; with `sent`,
   * only signing or broadcast), other than `except`, each with the reward of its own reference
   * block, plus the mempool claims of that asset it does not carry itself that could still land
   * at the next block (refreshMempoolClaims checked their fee outputs and work; the cheap rules
   * run again here). Each solution counts once.
   */
  inFlightClaims(assetId, { except = null, sent = false } = {}) {
    const id = String(assetId);
    const seen = new Map();
    for (const i of this.items) {
      if (!isMineItem(i) || i.asset !== id || i.id === except || !IN_FLIGHT.has(i.status) || (sent && i.status === "queued")) continue;
      let reward;
      try {
        reward = BigInt(this.idx.rewardAt(i.asset, i.ref));
      } catch {
        continue; // the token is no longer known (a reorg removed its launch): nothing can land
      }
      seen.set(i.solutionId, reward);
    }
    const own = this.ownTxids();
    const H = this.idx.height + 1;
    for (const [txid, c] of this.mempoolClaims) {
      if (!c || c.asset !== id || own.has(txid) || seen.has(c.solutionIdHex)) continue;
      if (this.idx.mineStatic(c.env, H) !== true || this.idx.mineState(c.env) !== true) continue;
      seen.set(c.solutionIdHex, c.reward);
    }
    return seen;
  }

  /** How many claims of `assetId` are on their way (inFlightClaims). */
  pendingClaims(assetId, opts) {
    return this.inFlightClaims(assetId, opts).size;
  }

  /** Σ reward of the claims of `assetId` on their way (inFlightClaims), as a bigint. */
  pendingReward(assetId, opts) {
    let sum = 0n;
    for (const r of this.inFlightClaims(assetId, opts).values()) sum += r;
    return sum;
  }

  /** mine_rejected with a reason of the relayer's own (not an indexer reason). */
  mineRejected(reason) {
    return new RelayError("mine_rejected", { reason }, `This claim cannot land: ${reason}.`);
  }

  /**
   * Step 7 (and again at step 10): the cheap MINE rules at the next block (mineStatic,
   * mineState), the relayer's signing deadline, a solution or nullifiers already in its queue,
   * and the cap counting claims in flight. `self` is the caller's own pending marker.
   * Returns { claim, asset, nullifiers }; throws a RelayError.
   */
  claimChecks(env, { self = null } = {}) {
    const idx = this.idx;
    let verdict = idx.mineStatic(env, idx.height + 1);
    if (verdict !== true) throw mineRefusal(verdict);
    verdict = idx.mineState(env);
    if (verdict !== true) throw mineRefusal(verdict);
    if (this.topHeight() > this.mineDeadline(env.refHeight)) throw new RelayError("expired");
    const claim = idx.claimOf(env);
    if (!claim) throw mineRefusal("unknown reference block");
    const holder = this.pendingSolutions.get(claim.solutionIdHex);
    if (holder !== undefined && holder !== self) throw new RelayError("solution_pending");
    const asset = idx.assets.get(env.publicAsset);
    // The cap counts each claim in flight at the reward of its own reference block (a halving may lie between them).
    if (asset.issued + this.pendingReward(asset.id) + env.publicAmount > asset.maxSupply) throw new RelayError("cap_reached");
    const nullifiers = env.nullifiers.map(String);
    if (nullifiers.some((n) => this.pending.has(n) && this.pending.get(n) !== self)) throw new RelayError("nullifier_pending");
    return { claim, asset, nullifiers };
  }

  /**
   * Pool coins for one more claim carrier (pool_low otherwise): every waiting carrier plus this
   * one, and a confirmed C coin per waiting claim that covers its fee, its service fees and the
   * change. A claim's change waits for a confirmation, so a confirmed coin funds one claim per block.
   */
  checkClaimRoom(quote) {
    if (this.queuedAll() + 1 > this.capacity(this.fundingCoins(undefined, { pending: 1 }))) throw new RelayError("pool_low");
    const need = quote.fee + quote.service + DUST;
    const coins = this.spendableCoins().filter((u) => u.kind === "change" && u.confirmed && u.value >= need).length;
    const waiting = this.items.filter((i) => isMineItem(i) && isWaiting(i)).length;
    if (waiting + 1 > coins) throw new RelayError("pool_low");
  }

  /**
   * Step 8: rule 11 at the next block, idx.minePow, whose Argon2 runs in the indexer's worker
   * pool (powPool() made sure idx.pow is one). Returns the powHash hex (read from the memo
   * minePow fills, so the hash is computed once). Work that meets D(ref) but not the stale
   * bound is stale_work (an honest miner overtaken by a difficulty jump: no penalty); other
   * refused work is pow_invalid, with the invalidPowSats penalty and a count toward
   * invalidPerHour. A worker failure is busy, never a verdict, and costs nothing.
   */
  async checkWork(env, claim, idHex) {
    if (!this.powPool()) throw new RelayError("mine_disabled");
    const memo = new Map();
    let verdict;
    let hash;
    try {
      verdict = await this.idx.minePow(env, this.idx.height + 1, { memo });
      hash = await memo.get(claim.solutionIdHex);
    } catch (e) {
      if (isPowError(e)) throw new RelayError("busy");
      throw e;
    }
    if (verdict === true) return hex(hash);
    if (verdict !== "insufficient work") throw mineRefusal(verdict);
    if (hash && meetsTarget(hash, targetOf(this.idx.difficultyAt(env.publicAsset, env.refHeight)))) throw new RelayError("stale_work");
    this.books.penalize(idHex, this.config.invalidPowSats);
    this.invalid.set(idHex, [...this.invalidFor(idHex), this.now()]);
    this.save();
    throw new RelayError("pow_invalid");
  }

  /**
   * POST /api/relay/submit for a MINE_SCRIPT claim (mining-contract.md §9.3), steps 4-10, after
   * the gates, the signature and the replay record. Bad work never reaches the proof check.
   * Nothing mutates before acceptance except the replay record and the penalties.
   */
  async acceptClaim(req, bytes, idHex) {
    const idx = this.idx;
    // 4. The balance covers the claim: carrier fee (estimate) + the asset's service fees + margin.
    const quote = this.mineQuote(readU64le(bytes, ASSET_OFFSET));
    if (!quote) throw new RelayError("busy");
    const balance = Math.max(0, this.books.account(idHex).balance - this.frozenSats(this.books.keyOf(idHex)));
    if (balance < quote.total) throw new RelayError("balance_low", { balance, needed: quote.total, perSend: quote.total });
    // 4b. Cover (L1), as for a transfer: a thin pool needs the signed `linkable`.
    req.thin = this.checkCover(req.linkable);
    // 5. Limits: refused work and invalid proofs per account, one PoW check per account, the pool queue.
    const bad = this.invalidFor(idHex);
    if (bad.length >= this.config.invalidPerHour) throw new RelayError("rate_limited", { retryAfter: Math.max(1, Math.ceil((bad[0] + HOUR - this.now()) / 1000)) });
    if (this.powBusy.has(idHex)) throw new RelayError("busy");
    const pool = this.powPool();
    if (!pool) throw new RelayError("mine_disabled");
    if (pool.queued >= this.config.powQueueMax) throw new RelayError("busy");
    // 6. Strict decode, the mode, the bind to C, and fee scripts that are not the relayer's own.
    let env;
    try {
      env = decodeEnvelope(bytes);
    } catch {
      throw new RelayError("malformed");
    }
    if (env.op !== OP.MINE_SCRIPT) throw new RelayError("malformed");
    if (!MINE_MODES.has(req.mode)) throw new RelayError("mine_mode");
    if (!equal(env.bindScriptHash, this.bindScriptHash)) throw new RelayError("bind_stale", { bindScriptHash: hex(this.bindScriptHash) });
    const feeOutputs = this.feeOutputsOf(env.publicAsset);
    if (feeOutputs?.some((o) => this.isOwnScript(o.script))) throw new RelayError("mine_unsupported");
    // 7. The cheap rules, the deadline, the queue, the cap with claims in flight, pool coins.
    const { claim, nullifiers } = this.claimChecks(env);
    this.checkClaimRoom(quote);
    const ref = env.refHeight;
    const sol = claim.solutionIdHex;
    const root = String(idx.roots.get(ref));
    const refHash = idx.hashes.get(ref) ?? null;
    const token = `validating:${randomBytes(8).toString("hex")}`;
    this.pendingSolutions.set(sol, token);
    nullifiers.forEach((n) => this.pending.set(n, token));
    let accepted = false;
    try {
      // 8. Work, in the worker pool.
      this.powBusy.add(idHex);
      let powHash;
      try {
        powHash = await this.checkWork(env, claim, idHex);
      } finally {
        this.powBusy.delete(idHex);
      }
      // 9. The proof, under the existing verify limits; an invalid one costs the existing penalty.
      const verdict = await this.verified(() => idx.mineProof(env));
      if (verdict !== true) {
        this.books.penalize(idHex, this.config.invalidProofSats);
        this.invalid.set(idHex, [...this.invalidFor(idHex), this.now()]);
        this.save();
        throw new RelayError("proof_invalid");
      }
      // 10. A block may have landed or rolled back during the awaits: everything again.
      if ((idx.hashes.get(ref) ?? null) !== refHash || String(idx.roots.get(ref)) !== root) throw this.mineRejected("the reference block was replaced");
      const gate = this.gateCode(req.mode);
      if (gate) throw this.gateError(gate);
      const mineGate = this.mineGateCode();
      if (mineGate) throw this.gateError(mineGate, true);
      this.claimChecks(env, { self: token });
      const now = this.mineQuote(env.publicAsset);
      if (!now) throw new RelayError("busy");
      this.checkClaimRoom(now);
      req.thin = this.checkCover(req.linkable);
      const id = randomBytes(16).toString("hex");
      try {
        this.books.reserve(id, idHex, now.total);
      } catch (e) {
        if (e instanceof BooksError && e.code === "balance_low") throw new RelayError("balance_low", { balance: this.books.account(idHex).balance, needed: now.total, perSend: now.total });
        throw e;
      }
      const item = {
        id, kind: "mine", status: "queued", mode: req.mode, anchor: ref, ref, root, refHash,
        asset: String(env.publicAsset), solutionId: sol, powHash, nullifiers,
        serviceOutputs: (feeOutputs ?? []).map((o) => ({ script: hex(o.script), sats: o.sats })), serviceSats: now.service,
        acceptedHeight: idx.height, envelope: req.envelope, account: this.books.keyOf(idHex), reservation: now.total, attempts: 0,
        ...(req.linkable === true ? { linkable: true } : {}),
      };
      this.state.items[id] = item;
      nullifiers.forEach((n) => this.pending.set(n, id));
      this.pendingSolutions.set(sol, id);
      this.blockCount();
      this.acceptedThisBlock += 1;
      this.save();
      accepted = true;
      if (req.mode === "fast") this.scheduleFast(id);
      return {
        status: 202,
        body: {
          id, status: "queued", kind: "mine", ref, lastBroadcast: this.mineDeadline(ref), deadline: ref + MINE_WINDOW, solutionId: sol,
          reservedSats: now.total, serviceSats: String(now.service), balance: this.books.account(idHex).balance, flush: req.mode === "fast" ? "fast" : "next-block",
          ...linkableBody(req),
        },
      };
    } finally {
      if (!accepted) {
        nullifiers.forEach((n) => this.pending.get(n) === token && this.pending.delete(n));
        if (this.pendingSolutions.get(sol) === token) this.pendingSolutions.delete(sol);
      }
    }
  }

  /**
   * Re-checks of a claim item before its carrier is signed (mining-contract.md §9.5): null to
   * go on, "wait" (an Argon2 worker failed: try next block), or [status, reason] to finalize
   * it (its reservation is released). After a reorg of its reference block every rule runs
   * again (the work in the pool, the proof).
   */
  async claimPrecheck(item) {
    const idx = this.idx;
    const deadline = this.mineDeadline(item.ref);
    if (this.topHeight() > deadline) return ["expired", `it could not be sent before block ${deadline}, the end of its 12-block window less 3 blocks`];
    if (item.nullifiers.some((n) => idx.nullifiers.has(n))) return ["dropped", "notes already spent by another transaction"];
    if (idx.claimed?.has(item.solutionId)) return ["dropped", "this solution was already claimed"];
    let env;
    try {
      env = decodeEnvelope(unhex(item.envelope));
    } catch {
      return ["dropped", "the claim no longer decodes"];
    }
    const H = idx.height + 1;
    const verdict = idx.mineStatic(env, H);
    if (verdict !== true) return ["dropped", `no longer valid: ${verdict}`];
    if ((idx.hashes.get(item.ref) ?? null) !== item.refHash || String(idx.roots.get(item.ref)) !== item.root) {
      // The reference block was reorganized: the work and the proof are checked again.
      const claim = idx.claimOf(env);
      if (!claim) return ["dropped", "no longer valid after a reorg: unknown reference block"];
      let hash;
      try {
        hash = await this.powPool()?.hash(claim.password);
      } catch (e) {
        if (isPowError(e)) return "wait";
        throw e;
      }
      if (!hash) return "wait";
      if (!meetsTarget(hash, targetOf(idx.effectiveDifficulty(env.publicAsset, item.ref, H)))) return ["dropped", "no longer valid after a reorg: insufficient work"];
      const proof = await idx.mineProof(env);
      if (proof !== true) return ["dropped", `no longer valid after a reorg: ${proof}`];
      // A new reference hash is a new challenge, so a new solution id.
      if (claim.solutionIdHex !== item.solutionId) {
        const holder = this.pendingSolutions.get(claim.solutionIdHex);
        if (holder !== undefined && holder !== item.id) return ["dropped", "this solution is already in the relay queue"];
        if (this.pendingSolutions.get(item.solutionId) === item.id) this.pendingSolutions.delete(item.solutionId);
        this.pendingSolutions.set(claim.solutionIdHex, item.id);
      }
      Object.assign(item, { root: String(idx.roots.get(item.ref)), refHash: idx.hashes.get(item.ref) ?? null, powHash: hex(hash), solutionId: claim.solutionIdHex });
    }
    return this.claimLastCheck(item);
  }

  /**
   * The synchronous part, run again right before signing: the deadline, the solution claimed,
   * the cap counting claims already sent (signing or broadcast, ours and the mempool's), and
   * the stale bound against D_eff at the next block (stale_work).
   */
  claimLastCheck(item) {
    const idx = this.idx;
    const deadline = this.mineDeadline(item.ref);
    if (this.topHeight() > deadline) return ["expired", `it could not be sent before block ${deadline}, the end of its 12-block window less 3 blocks`];
    if (idx.claimed?.has(item.solutionId)) return ["dropped", "this solution was already claimed"];
    const asset = idx.assets.get(BigInt(item.asset));
    if (asset?.kind !== "pow") return ["dropped", "the token is no longer known"];
    const reward = BigInt(idx.rewardAt(asset.id, item.ref));
    if (asset.issued + this.pendingReward(asset.id, { except: item.id, sent: true }) + reward > asset.maxSupply) {
      return ["dropped", "the supply is mined out, counting claims already on their way"];
    }
    if (!meetsTarget(unhex(item.powHash), targetOf(idx.effectiveDifficulty(asset.id, item.ref, idx.height + 1)))) {
      return ["dropped", "difficulty jumped since this solution's block, so it no longer counts (stale_work)"];
    }
    return null;
  }

  /** The mempool txids, from the client's mempoolTxids() or GET /mempool/txids; null when it has neither. */
  async mempoolTxids() {
    const e = this.esplora;
    if (typeof e.mempoolTxids === "function") return e.mempoolTxids();
    if (typeof e.request === "function") return (await e.request("/mempool/txids")).json();
    return null;
  }

  /**
   * The claim a mempool transaction carries, when it could land at the next block: it decodes as
   * MINE / MINE_SCRIPT, passes the cheap rules (mineStatic, mineState) with a known reference
   * block, and pays every required service-fee output. Returns { asset, solutionIdHex, reward,
   * env, password, ref } or null. The work is checked by the caller (refreshMempoolClaims), in
   * the pool. Junk (undecodable, unknown reference, unpaid fee) never counts toward the cap.
   */
  claimInTx(tx) {
    const payload = findEnvelope(tx);
    if (!payload) return null;
    const op = headerOp(payload);
    if (op !== OP.MINE && op !== OP.MINE_SCRIPT) return null;
    let env;
    try {
      env = decodeEnvelope(payload);
    } catch {
      return null;
    }
    const idx = this.idx;
    if (idx.mineStatic(env, idx.height + 1) !== true || idx.mineState(env) !== true) return null;
    const claim = idx.claimOf(env);
    if (!claim) return null;
    const asset = idx.assets.get(env.publicAsset);
    if (!feeOutputsPaid(asset, tx, idx.mineFee ?? null).ok) return null;
    return { asset: String(env.publicAsset), solutionIdHex: claim.solutionIdHex, reward: env.publicAmount, env, password: claim.password, ref: env.refHeight };
  }

  /**
   * claimInTx plus rule 11 in the worker pool against D_eff at the next block. A claim without
   * enough work is null (it never lands); a worker failure throws (looked up again next tick).
   */
  async mempoolClaimOf(tx) {
    const c = this.claimInTx(tx);
    if (!c) return null;
    const pool = this.powPool();
    if (!pool) return null;
    const hash = await pool.hash(c.password);
    if (!(hash instanceof Uint8Array) || !meetsTarget(hash, targetOf(this.idx.effectiveDifficulty(c.asset, c.ref, this.idx.height + 1)))) return null;
    return { asset: c.asset, solutionIdHex: c.solutionIdHex, reward: c.reward, env: c.env };
  }

  /**
   * Mempool claims for the in-flight count (pendingClaims): the mempool listing, then at most
   * mempoolLookupsPerTick raw transactions not seen before (cached by txid until they leave the
   * mempool). Best effort: any failure keeps the last view. Only while mining is active.
   */
  async refreshMempoolClaims() {
    if (!this.mineActive() || !(this.config.mempoolLookupsPerTick > 0) || ![...this.idx.assets.values()].some((a) => a.kind === "pow")) {
      this.mempoolClaims.clear();
      return;
    }
    let txids;
    try {
      txids = await this.mempoolTxids();
    } catch (e) {
      this.log.warn?.(`relayer: mempool listing unavailable (${e?.name ?? "Error"})`);
      return;
    }
    if (!Array.isArray(txids)) return;
    const live = new Set(txids);
    for (const t of this.mempoolClaims.keys()) if (!live.has(t)) this.mempoolClaims.delete(t);
    const own = this.ownTxids();
    let budget = this.config.mempoolLookupsPerTick;
    for (const txid of txids) {
      if (budget <= 0) break;
      if (this.mempoolClaims.has(txid) || own.has(txid) || !HEX32.test(String(txid))) continue;
      budget -= 1;
      try {
        this.mempoolClaims.set(txid, await this.mempoolClaimOf(parseRawTx(await this.esplora.rawTx(txid), txid)));
      } catch {
        // Gone already, no answer, or an Argon2 worker failed: looked up again next tick.
      }
    }
  }

  /** info().mine (mining-contract.md §9.2). */
  mineInfo() {
    const c = this.config;
    const on = this.mineActive() && Boolean(this.powPool());
    const code = on ? this.gateCode("block") ?? this.mineGateCode() : "mine_disabled";
    const rate = this.mineFeeRate();
    const fee = this.mineCarrierFee(rate);
    return {
      enabled: on, code, bindScriptHash: on ? hex(this.bindScriptHash) : null, modes: ["fast", "block"], slack: MINE_SLACK,
      estVsize: c.mineEstVsize, feeRate: rate, carrierFeeSats: fee, marginSats: fee === null ? null : marginFor(fee, this.marginOpts()), invalidPowSats: c.invalidPowSats,
    };
  }

  // ------------------------------------------------------------- accounts

  /** POST /api/relay/account { accountPub, t, sig } (signed): the balance, reserved sats, next deposit address and credits. */
  account(rawBody, ip) {
    return this.answer("account", async () => {
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new RelayError("malformed");
      }
      if (!sameKeys(body, ACCOUNT_KEYS)) throw new RelayError("malformed");
      // A balance read is answered during an evacuation or a rotation too: every balance is kept.
      this.gateAccounts({ read: true });
      this.countCall(ip);
      const auth = verifyRequest({ endpoint: RELAY_ENDPOINTS.account, network: NETWORK, poolKey: this.Q, body, now: this.now });
      if (!auth.ok) throw new RelayError(auth.code, auth.code === "stale_request" ? { serverTime: Math.floor(this.now() / 1000) } : {});
      const a = this.books.account(auth.idHex);
      return {
        status: 200,
        body: {
          accountId: auth.idHex, balance: a.balance, reserved: a.reserved, nextIndex: a.nextIndex,
          depositAddress: depositAddress(this.Q, auth.id, a.nextIndex, NETWORK).address,
          credits: this.books.credits(auth.idHex),
        },
      };
    });
  }

  /** Account reads and credits: disabled, the emergency codes (stopCode; a `read` passes them), halted. */
  gateAccounts({ read = false } = {}) {
    if (!this.config.enabled) throw new RelayError("disabled");
    if (this.holdSeen === null && !this.frozen) this.checkHold()?.catch(() => {});
    const stop = this.stopCode();
    if (stop) {
      if (read) return;
      throw new RelayError(stop);
    }
    if (this.state.halted) throw new RelayError("halted");
  }

  /**
   * POST /api/relay/credit { outpoint, accountPub, n } (not signed: it can only credit a deposit
   * to the account it pays). Contract §4.2: the key is claimed in memory before any await, and
   * the credit, its coin and the claim's end are one durable write.
   */
  credit(rawBody, ip) {
    return this.answer("credit", async () => {
      // 1. Strict parse.
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new RelayError("malformed");
      }
      if (!sameKeys(body, CREDIT_KEYS)) throw new RelayError("malformed");
      let op;
      try {
        op = parseOutpoint(body.outpoint);
      } catch {
        throw new RelayError("bad_outpoint");
      }
      let pub;
      try {
        pub = parseAccountPub(body.accountPub);
      } catch {
        throw new RelayError("malformed");
      }
      const n = body.n;
      if (!Number.isSafeInteger(n) || n < 0 || n > MAX_DEPOSIT_INDEX) throw new RelayError("malformed");
      const id = accountIdOf(pub);
      const idHex = hex(id);
      // 2. Gate and rate limit.
      this.gateAccounts();
      this.countCall(ip);
      // 3. Already credited: the same answer again, or another account's.
      const done = this.books.isCredited(op.key);
      if (done) {
        if (!done.settled && done.id === this.books.keyOf(idHex) && done.n === n && !done.reversed) return { status: 200, body: this.creditBody(op.key, done, true) };
        throw new RelayError("already_credited");
      }
      // A deposit to a retired address already recorded: the same answer until the operator sweeps it.
      const late = this.state.retiredDeposits?.[op.key];
      if (late && late.status !== "credited") {
        if (late.account !== this.books.keyOf(idHex) || late.n !== n) throw new RelayError("already_credited");
        throw new RelayError("deposit_retired", { status: late.status, value: late.value });
      }
      // 4. Claim before any await.
      if (!this.books.claim(op.key)) throw new RelayError("credit_in_progress", { retryAfter: 5 });
      try {
        // 5. Never an output of the relayer's own transactions.
        if (this.ownTxids().has(op.txid) || Object.values(this.state.coins).some((c) => c.parent === op.txid)) throw new RelayError("deposit_own");
        // 6. The output, from raw bytes checked against the txid. A txid the explorer did not
        // know in this block (within the last minute) is answered from memory; lookups are capped globally.
        const miss = this.creditMiss.get(op.txid);
        if (miss && miss.height === this.idx.height && this.now() - miss.at < 60_000) throw new RelayError("deposit_unknown");
        this.takeCreditLookup();
        let tx;
        try {
          tx = parseRawTx(await this.esplora.rawTx(op.txid), op.txid);
        } catch (e) {
          if (isNotFound(e)) {
            if (this.creditMiss.size >= CREDIT_MISS_CACHE) this.creditMiss.clear();
            this.creditMiss.set(op.txid, { height: this.idx.height, at: this.now() });
            throw new RelayError("deposit_unknown");
          }
          throw new RelayError("busy");
        }
        const out = tx.outputs[op.vout];
        if (!out) throw new RelayError("deposit_unknown");
        // 7. It pays deposit address n of this account (and never the change key).
        const dep = depositAddress(this.Q, id, n, NETWORK);
        // Address n of this account under a retired pool key (relay-balance.md §9): recorded below,
        // credited only once the operator has swept it into the pool.
        const retired = equal(out.script, dep.script) ? null : this.retiredMatch(out.script, id, n);
        if ((!retired && !equal(out.script, dep.script)) || equal(out.script, this.change.script)) throw new RelayError("deposit_mismatch");
        // A deposit address that is also a service-fee script would let any claim carrier top
        // up this account: never credited (isOwnScript relies on it).
        if (this.isFeeScript(out.script)) throw new RelayError("deposit_own", {}, "This address receives mining service fees, so deposits to it are never credited.");
        // 8. At least the minimum.
        const value = Number(out.value);
        if (value < this.config.minDepositSats) throw new RelayError("deposit_small", { minDepositSats: this.config.minDepositSats });
        // 9. Confirmations.
        this.takeCreditLookup();
        let st;
        try {
          st = await this.esplora.txStatus(op.txid);
        } catch (e) {
          if (isNotFound(e)) throw new RelayError("deposit_unknown");
          throw new RelayError("busy");
        }
        const coinbase = tx.inputs.length === 1 && isNullOutpoint(tx.inputs[0].outpoint);
        const needed = coinbase ? 100 : this.depositConfirmations();
        let confirmations;
        if (this.config.verifyDeposits) {
          // Only a block the indexer applied (its header verified from a pinned checkpoint), with
          // the transaction proven inside it; depth from the indexer's height, never the source's tip.
          const where = this.onVerifiedChain(st);
          if (where === "other") throw new RelayError("deposit_unknown");
          if (where !== "ok") throw new RelayError("deposit_unconfirmed", { confirmations: 0, needed });
          confirmations = Math.max(0, this.idx.height - st.block_height + 1);
          if (confirmations < needed) throw new RelayError("deposit_unconfirmed", { confirmations, needed });
          this.takeCreditLookup();
          let inside;
          try {
            inside = await this.proveInclusion(op.txid, st);
          } catch {
            throw new RelayError("busy");
          }
          if (!inside) throw new RelayError("deposit_unknown");
        } else {
          confirmations = st?.confirmed && Number.isSafeInteger(st.block_height) ? Math.max(0, this.topHeight() - st.block_height + 1) : 0;
          if (confirmations < needed) throw new RelayError("deposit_unconfirmed", { confirmations, needed });
        }
        // A halt or a parallel credit of the same key cannot have happened in between (the claim),
        // but the gate may have changed during the awaits.
        this.gateAccounts();
        if (retired) {
          // Never credited from a key a thief may hold: recorded (opaque account key and its tweak
          // under the retired key), swept by the operator, credited once that sweep confirms.
          this.state.retiredDeposits ??= {};
          this.state.retiredDeposits[op.key] = {
            generation: retired.generation, value, height: st.block_height, account: this.books.keyOf(idHex), n,
            tweak: tweakHex(depositTweak(unhex(retired.pool), id, n)), status: "waiting", seenAt: this.idx.height,
          };
          this.save();
          this.log.warn?.(`relayer: a deposit paid a retired address (generation ${retired.generation}); it waits for murkle relayer sweep-retired`);
          throw new RelayError("deposit_retired", { status: "waiting", value });
        }
        // 10. Credit, coin and save: one durable write.
        const rec = this.books.credit({ key: op.key, id: idHex, n, value, sweepCost: this.sweepCost(), height: st.block_height });
        // creditedAt: merged into C from the next block on (maybeMerge); height: where it confirmed (checkCredits).
        // tweak: all a merge needs to spend it (L2: never the account id).
        this.state.coins[op.key] = { value, kind: "deposit", status: "unspent", confirmed: true, height: st.block_height, creditedAt: this.idx.height, tweak: tweakHex(depositTweak(this.Q, id, n)) };
        // isOwnScript: this deposit's script and the address the account is handed next.
        this.addOwnScript(dep.script);
        this.addOwnScript(depositAddress(this.Q, id, this.books.account(idHex).nextIndex, NETWORK).script);
        this.save();
        this.checkBooks();
        return { status: 200, body: this.creditBody(op.key, rec, false) };
      } finally {
        this.books.unclaim(op.key);
      }
    });
  }

  /**
   * Where a confirmed status sits against the indexer's applied (header-verified) chain:
   * "ok" (the block the indexer applied at that height), "ahead" (not applied yet, or no valid
   * height), "other" (the indexer applied another block there: not on the verified chain).
   */
  onVerifiedChain(st) {
    if (!st?.confirmed || !Number.isSafeInteger(st.block_height) || st.block_height > this.idx.height) return "ahead";
    const applied = this.idx.hashes.get(st.block_height);
    if (!applied) return "ahead";
    return String(st.block_hash ?? "").toLowerCase() === applied ? "ok" : "other";
  }

  /**
   * Whether `txid` is inside the block the indexer applied at st.block_height: a merkle path to
   * that block's header (which must hash to the applied block), else the raw block itself.
   * Throws when the source cannot answer.
   */
  async proveInclusion(txid, st) {
    const hash = this.idx.hashes.get(st.block_height);
    if (!hash) return false;
    if (this.provenIn.get(txid) === hash) return true;
    let inside = null;
    if (typeof this.esplora.merkleProof === "function" && typeof this.esplora.blockHeader === "function") {
      try {
        const proof = await this.esplora.merkleProof(txid);
        if (proof?.block_height !== st.block_height) inside = false;
        else {
          checkInclusion({ txid, proof, headerHex: String(await this.esplora.blockHeader(hash)).trim(), blockHash: hash });
          inside = true;
        }
      } catch (e) {
        if (e instanceof CheckError) inside = false;
        // anything else (no proof endpoint, a network error): the raw block below
      }
    }
    if (inside === null) {
      const block = parseBlock(await this.esplora.rawBlock(hash));
      inside = block.hash === hash && block.txs.some((t) => t.txid === txid);
    }
    if (inside) {
      if (this.provenIn.size >= 10_000) this.provenIn.clear();
      this.provenIn.set(txid, hash);
    }
    return inside;
  }

  creditBody(key, rec, already) {
    return { credited: true, already, outpoint: key, n: rec.n, value: rec.value, sweepCost: rec.sweepCost, amount: rec.amount, height: rec.height };
  }

  // ------------------------------------------------------------ public views

  status(id) {
    if (!ID.test(String(id))) return null;
    const item = this.state.items[id];
    if (!item) return null;
    const status = item.status === "signing" ? "queued" : item.status;
    // A settled item read back from disk has no cost, anchor or mode any more (persistedItem, L2):
    // the answer then leaves them out. The cost is still answered while the item is in memory.
    const mine = isMineItem(item);
    const windowKnown = mine ? Number.isSafeInteger(item.ref) : Number.isSafeInteger(item.anchor);
    return {
      status,
      ...(item.txid && status !== "queued" && status !== "missed" ? { txid: item.txid } : {}),
      ...(item.height != null ? { height: item.height } : {}),
      ...(status === "missed" ? { code: item.code } : {}),
      ...(item.reason ? { reason: item.reason } : {}),
      ...(item.broadcastHeight != null && status !== "queued" ? { broadcastHeight: item.broadcastHeight, ...(Number.isSafeInteger(item.cost) ? { cost: item.cost } : {}) } : {}),
      ...(Number.isSafeInteger(item.anchor) ? { anchor: item.anchor } : {}),
      ...(windowKnown ? { deadline: this.windowEnd(item) } : {}),
      ...(isBatchMode(item.mode) ? { mode: item.mode, releaseAt: item.releaseAt, lastRelease: item.lastRelease } : {}),
      ...(mine ? {
        kind: "mine",
        ...(Number.isSafeInteger(item.ref) ? { ref: item.ref, lastBroadcast: this.mineDeadline(item.ref) } : {}),
        ...(item.solutionId ? { solutionId: item.solutionId } : {}),
        ...(item.serviceSats != null ? { serviceSats: String(item.serviceSats) } : {}),
      } : {}),
      ...(status === "queued" && item.linkable ? { linkable: true } : {}),
    };
  }

  /** The last height at which an item's carrier can still count: anchor + 100, or ref + 12 for a claim. */
  windowEnd(item) {
    return isMineItem(item) ? item.ref + MINE_WINDOW : item.anchor + ANCHOR_WINDOW;
  }

  stats() {
    const h = this.idx.height;
    const carriers = this.state.ledger.filter((l) => l.kind === "carrier");
    const count = (outcome) => carriers.filter((l) => l.outcome === outcome).length;
    const landed = new Map();
    for (const l of carriers) if (l.outcome === "accepted" && l.height != null && l.height > h - 144) landed.set(l.height, (landed.get(l.height) ?? 0) + 1);
    return {
      relayed144: carriers.filter((l) => l.outcome === "accepted" && l.height > h - 144).length,
      landed144: [...landed].sort((a, b) => a[0] - b[0]),
      accepted: count("accepted"),
      rejected: count("rejected"),
      expired: count("expired"),
      missed: this.items.filter((i) => i.status === "missed").length,
      satsSpent: this.state.ledger.filter((l) => l.outcome !== "dropped").reduce((s, l) => s + l.fee, 0),
    };
  }

  info() {
    const c = this.config;
    const code = this.gateCode("block");
    const per = this.perCarrier(this.cache.feeRate);
    const perSend = this.quote();
    const sweep = this.sweepCost();
    return {
      enabled: c.enabled,
      mode: "balance",
      code,
      reason: code ? MESSAGES[code] : null,
      network: NETWORK,
      ops: ["TRANSACT"],
      address: this.address,
      height: this.idx.height,
      chainTip: this.chainTip,
      pow: null,
      selfPay: true,
      anchor: { window: ANCHOR_WINDOW, safety: c.safetyBlocks, minAnchor: this.minAnchor() },
      fees: { feeRate: this.cache.feeRate, maxFeeRate: c.maxFeeRate, estVsize: c.estVsize, carrierFeeSats: per, maxFeePerTx: c.maxFeePerTx },
      balance: {
        poolKey: this.poolHex, changeAddress: this.address, signTag: RELAY_SIGN_TAG,
        marginPct: c.marginPct, marginMinSats: c.marginMinSats, perSendSats: perSend, batchHeadroom: c.batchHeadroom,
        minDepositSats: c.minDepositSats, depositConfirmations: this.depositConfirmations(), sweepCostSats: sweep,
        suggestSends: c.suggestSends,
        suggestedTopUpSats: perSend === null ? null : Math.max(c.minDepositSats, Math.ceil((c.suggestSends * perSend + sweep) / 1000) * 1000),
        // L1: k = minMix; coverOk = a coin descending from at least k + 1 accounts can fund a carrier
        // (the same answer for every sender; false when k is 0); depositors = accounts ever credited.
        mix: this.mixInfo(),
        // Emergencies (relay-balance.md §9): whether top-ups are taken now (false while the relayer
        // evacuates, is paused or waits for its new pool), the key generation (0 until the first
        // rotation) and the pool keys of rotated-out generations, whose deposit addresses wallets
        // must never show or pay again. Balances belong to account keys, not to a pool key.
        depositsOpen: !this.stopCode(),
        generation: this.state.generation ?? 0,
        retiredPoolKeys: (this.state.retired ?? []).map((g) => g.pool),
      },
      queue: { queued: this.queuedCount(), max: c.maxQueue },
      stats: this.stats(),
      defaultMode: "block",
      batch: this.batchInfo(),
      mine: this.mineInfo(),
      docs: "docs/design/relay-balance.md",
    };
  }

  /**
   * For GET /api/health and the monitor: whether the relayer is configured on, whether it halted
   * itself (I2: its books do not add up), the current gate code and the halt problems. Reads
   * state only; never throws.
   */
  health() {
    const halted = this.state?.halted ?? null;
    let code = null;
    let stop = null;
    try {
      stop = this.stopCode();
      code = this.gateCode("block");
    } catch {
      code = null;
    }
    // An evacuation, a pause or an unfunded pool after a rotation counts as a halt (the monitor's
    // relayer_halted alert), with its own code.
    return {
      enabled: Boolean(this.config.enabled),
      halted: Boolean(halted || stop),
      code: stop ?? (halted ? "halted" : code),
      problems: halted ? [...(halted.problems ?? [])] : [],
    };
  }

  /** The epoch of `mode` that contains the indexer tip, with its waiting count as of this block (snapshot()). */
  currentEpoch(mode) {
    const start = epochStart(Math.max(0, this.idx.height), mode);
    return { start, ...this.schedule(mode, start), queued: this.publishedQueued(mode, start) };
  }

  /** info().batch (batch-contract §3.8). Counts are what the relayer reports; Audit the relayer checks them. */
  batchInfo() {
    const c = this.config;
    const modes = {};
    for (const mode of BATCH_MODES) {
      modes[mode] = {
        epochBlocks: EPOCH_BLOCKS[mode], maxPerEpoch: this.capFor(mode), safety: this.safetyFor(mode),
        enabled: Boolean(c.enabled) && this.capFor(mode) > 0, current: this.currentEpoch(mode),
      };
    }
    return { perIp: c.batchPerIp, modes, recent: this.recentBatches() };
  }

  /** The current epoch of each length, for /api/state. */
  batchSummary() {
    const out = {};
    for (const mode of BATCH_MODES) {
      const { start, releaseAt, queued } = this.currentEpoch(mode);
      out[mode] = { start, releaseAt, queued };
    }
    return out;
  }

  /**
   * Released epochs from the carrier ledger, newest first, at most 24 per length:
   * `released` counts carriers that went out (not dropped), `landed` the
   * [height, count] of those with a verdict (accepted or rejected).
   */
  recentBatches() {
    const rows = new Map();
    for (const l of this.state.ledger) {
      if (l.kind !== "carrier" || !l.epoch || l.outcome === "dropped") continue;
      let row = rows.get(l.epoch);
      if (!row) {
        const at = l.epoch.lastIndexOf(":");
        const mode = l.epoch.slice(0, at);
        if (!isBatchMode(mode)) continue; // a retired length ("batch12")
        const start = Number(l.epoch.slice(at + 1));
        rows.set(l.epoch, (row = { mode, start, releaseAt: releaseHeight(start, mode), released: 0, landed: new Map() }));
      }
      row.released += 1;
      if ((l.outcome === "accepted" || l.outcome === "rejected") && l.height != null) row.landed.set(l.height, (row.landed.get(l.height) ?? 0) + 1);
    }
    const list = [...rows.values()].map((r) => ({ ...r, landed: [...r.landed].sort((a, b) => a[0] - b[0]) }));
    const newest = (a, b) => b.start - a.start || b.releaseAt - a.releaseAt;
    return BATCH_MODES.flatMap((m) => list.filter((r) => r.mode === m).sort(newest).slice(0, RECENT_EPOCHS)).sort(newest);
  }

  /** Transparency ledger, newest first. Never contains relay ids, accounts, costs or IPs. */
  ledgerView({ limit = 100, before } = {}) {
    const n = Math.max(1, Math.min(500, Number(limit) || 100));
    const ledger = this.state.ledger;
    const carriers = ledger.filter((l) => l.kind === "carrier");
    const items = ledger
      .filter((l) => before === undefined || before === null || l.seq < Number(before))
      .slice(-n)
      .reverse()
      .map(({ seq, kind, txid, vsize, fee, feeRate, broadcastHeight, height, outcome, reason, serviceSats }) => ({
        seq, kind, txid, vsize, fee, feeRate, broadcastHeight, height: height ?? null, outcome, reason: reason ?? null,
        // A claim's carrier also paid service-fee outputs (not part of `fee`).
        ...(serviceSats ? { serviceSats } : {}),
      }));
    return {
      address: this.address,
      totals: {
        carriers: carriers.length,
        accepted: carriers.filter((l) => l.outcome === "accepted").length,
        wasted: carriers.filter((l) => l.outcome === "rejected").length,
        satsSpent: ledger.filter((l) => l.outcome !== "dropped").reduce((s, l) => s + l.fee, 0),
        fanoutSats: ledger.filter((l) => (l.kind === "fanout" || l.kind === "merge") && l.outcome !== "dropped").reduce((s, l) => s + l.fee, 0),
      },
      items,
    };
  }

  // -------------------------------------------------------------- the tick

  /**
   * Called by the server after each sync + save, under the shared lock: refresh the fee rate,
   * reconcile verdicts, follow the relayer's own transactions and recent credits, fan out,
   * flush on a new block, prune, check the books (I2), persist.
   */
  async onTick({ chainTip } = {}) {
    if (chainTip !== undefined && chainTip !== null) this.chainTip = chainTip;
    // Frozen by an operator's HOLD (or one seen now): nothing is reconciled, signed or written.
    if (this.frozen || this.readHold()) {
      if (!this.frozen) await this.freeze(this.holdSeen ?? this.readHold());
      return;
    }
    this.checkDay();
    this.blockCount(); // a new tip takes its snapshot before the flush changes anything
    for (const [k, h] of this.suspect) if (h < this.idx.height) this.suspect.delete(k);
    await this.refreshCache();
    this.reconcile();
    await this.refreshMempoolClaims();
    await this.reconcileFanouts();
    await this.followCoins();
    this.creditRetired();
    this.settleOwnEntries();
    await this.checkCredits();
    this.pruneCoins();
    this.checkBooks();
    if (this.config.enabled && !this.state.halted && !this.stopCode() && this.cache.feeRate !== null) {
      await this.maybeMerge();
      await this.maybeFanout();
      // A Fast item whose timer already fired but found no coin goes now (after a merge), not next block.
      const fast = this.items.filter((i) => i.status === "queued" && i.mode === "fast" && !this.timers.has(i.id)).map((i) => i.id);
      if (fast.length) await this.flush({ only: fast });
    }
    if (this.idx.height < this.state.lastFlushHeight) this.state.lastFlushHeight = this.idx.height;
    if (this.config.enabled && this.idx.height > this.state.lastFlushHeight) {
      await this.flush();
      this.state.lastFlushHeight = this.idx.height;
    }
    this.prune();
    this.checkBooks();
    if (this.cache.feeRate !== null) this.ticked = true;
    this.save();
  }

  async refreshCache() {
    try {
      this.cache.feeRate = await this.esplora.feeRate();
    } catch (e) {
      this.log.warn?.(`relayer: fee rate unavailable (${e?.name ?? "Error"})`);
    }
    if (!this.mineActive()) return;
    try {
      this.cache.nextBlockRate = await this.nextBlockRate();
    } catch (e) {
      this.log.warn?.(`relayer: next-block fee rate unavailable (${e?.name ?? "Error"})`);
    }
  }

  /**
   * The next-block rate a claim's carrier is priced from (mining-contract.md §9.1): mempool.space's
   * /v1/fees/recommended fastestFee when the client is mempool.space-like (requestUrl, a base
   * ending in /api), else the client's feeRate(). Whole sat/vB, at least 1. Throws when unknown.
   */
  async nextBlockRate() {
    const e = this.esplora;
    // A chain source with its own next-block estimate (Esplora: fastestFee; Bitcoin Core:
    // estimatesmartfee 2) answers first; it never guesses on mainnet (it throws instead).
    if (typeof e.nextBlockFeeRate === "function") {
      const rate = Number(await e.nextBlockFeeRate());
      if (!Number.isFinite(rate) || rate < 0) throw new Error("the chain source gave no next-block fee rate");
      return Math.max(1, Math.ceil(rate));
    }
    if (typeof e.requestUrl === "function" && /\/api$/.test(String(e.base ?? ""))) {
      const fees = await (await e.requestUrl(e.base.replace(/\/api$/, "/api/v1") + "/fees/recommended", "/v1/fees/recommended")).json();
      const rate = Number(fees?.fastestFee);
      if (!Number.isFinite(rate) || rate < 0) throw new Error("no fastestFee in /v1/fees/recommended");
      return Math.max(1, Math.ceil(rate));
    }
    return e.feeRate();
  }

  /** Releases an item's pending nullifiers and its reservation or unsent charge, and sets a final status. */
  finalize(item, status, { reason, height } = {}) {
    const was = item.status;
    item.status = status;
    if (reason) item.reason = reason;
    if (height !== undefined) item.height = height;
    item.finalHeight = this.idx.height;
    item.nullifiers.forEach((n) => this.pending.get(n) === item.id && this.pending.delete(n));
    if (item.solutionId && this.pendingSolutions.get(item.solutionId) === item.id) this.pendingSolutions.delete(item.solutionId);
    // Nothing is charged for an item that never reached the network: a queued item's
    // reservation goes back, a signed one's charge is refunded and its coins come back.
    if (was === "queued") known(() => this.books.release(item.id));
    else if (was === "signing") {
      known(() => this.books.refundCharge(item.id));
      this.revertCoins(item.txid);
    }
    item.reservation = 0;
    delete item.account;
    delete item.envelope;
    // Accepted / rejected carriers keep their raw bytes until 6 confirmations
    // (reorg rebroadcast); an expired, dropped or missed one is never sent again.
    if (status === "expired" || status === "dropped" || status === "missed") delete item.raw;
    const timer = this.timers.get(item.id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(item.id);
    }
    const entry = this.ledgerEntry(item);
    if (entry) {
      entry.outcome = status;
      entry.height = item.height ?? null;
      entry.reason = item.reason ?? null;
    }
  }

  /** A batch or Next-block item that could not be paid when it was due (contract §4.5): final, nothing charged. */
  miss(item, code) {
    item.code = code;
    this.finalize(item, "missed", { reason: MISSED_REASON[code] });
  }

  ledgerEntry(item) {
    return item.ledgerSeq === undefined ? null : this.state.ledger.find((l) => l.seq === item.ledgerSeq) ?? null;
  }

  /**
   * Verdicts from the indexer log (relayer.md §4.6): accepted / rejected by
   * txid; expired when the indexer is past anchor + W with no verdict; a
   * verdict that disappeared (reorg) sends the item back to broadcast.
   */
  reconcile() {
    const idx = this.idx;
    // A journaled ("signing") carrier is watched too: its broadcast answer may have been lost.
    const watched = this.items.filter((i) => i.txid && (i.status === "signing" || i.status === "broadcast" || i.status === "expired" || ((i.status === "accepted" || i.status === "rejected") && i.raw)));
    // A sync can roll back and re-apply in one tick, so idx.height never drops below
    // lastReconciled; a changed hash there means blocks were replaced: rescan the undo window.
    const last = this.state.lastReconciled;
    const reorged = (idx.hashes.get(last) ?? null) !== (this.state.lastReconciledHash ?? null);
    const floor = Math.min(reorged ? last - UNDO_DEPTH : last, ...watched.filter((i) => i.height != null).map((i) => i.height - 1));
    const byTxid = new Map();
    for (let k = idx.log.length - 1; k >= 0 && idx.log[k].height > floor; k--) {
      if (!byTxid.has(idx.log[k].txid)) byTxid.set(idx.log[k].txid, idx.log[k]);
    }

    for (const item of watched) {
      const verdict = byTxid.get(item.txid);
      if (item.status === "signing") {
        // It landed although no broadcast answer said so: it reached the network, its charge is final.
        if (!verdict) continue;
        this.markBroadcast(item);
      }
      if (item.status === "broadcast") {
        if (verdict) this.finalize(item, verdict.ok ? "accepted" : "rejected", { height: verdict.height, reason: verdict.ok ? undefined : verdict.reason });
        // Expiry is judged on the indexer, not the chain tip: past anchor + W (a claim: ref + 12)
        // the indexer has seen every block in which the carrier could still have counted.
        else if (idx.height > this.windowEnd(item)) {
          this.finalize(item, "expired", { reason: isMineItem(item) ? "not confirmed within the claim's 12-block window" : "not confirmed before the anchor window closed" });
        }
      } else if (item.status === "expired") {
        // Wasted only if it confirms later; record the late verdict in the ledger.
        const entry = this.ledgerEntry(item);
        if (verdict && entry && entry.height == null) {
          entry.height = verdict.height;
          entry.outcome = verdict.ok ? "accepted" : "rejected";
          entry.reason = verdict.reason ?? null;
        }
      } else if (!verdict) {
        this.reopen(item);
      } else if (verdict.height !== item.height) {
        item.height = verdict.height;
        const entry = this.ledgerEntry(item);
        if (entry) entry.height = verdict.height;
      }
    }

    for (const item of this.items) {
      if ((item.status === "accepted" || item.status === "rejected") && item.raw && idx.height >= item.height + KEEP_RAW_CONFS - 1) delete item.raw;
    }
    this.state.lastReconciled = idx.height;
    this.state.lastReconciledHash = idx.hashes.get(idx.height) ?? null;
  }

  /** Reorg: a carrier's block was rolled back. Back to broadcast, and send the same raw tx again. */
  reopen(item) {
    item.status = "broadcast";
    item.height = null;
    delete item.reason;
    delete item.finalHeight;
    item.nullifiers.forEach((n) => this.pending.has(n) || this.pending.set(n, item.id));
    if (isMineItem(item) && !this.pendingSolutions.has(item.solutionId)) this.pendingSolutions.set(item.solutionId, item.id);
    const entry = this.ledgerEntry(item);
    if (entry) {
      entry.outcome = "pending";
      entry.height = null;
      entry.reason = null;
    }
    for (const c of Object.values(this.state.coins)) {
      if (c.parent === item.txid && c.confirmed) Object.assign(c, { confirmed: false, depth: 1 });
    }
    // A claim is never broadcast after ref + 11: reconcile() expires it once its window closes.
    if (!this.mayResend(item)) return;
    this.esplora.broadcast(item.raw).catch((e) => this.log.warn?.(`relayer: resend after reorg failed (${e?.name ?? "Error"})`));
  }

  /** Whether an item's journaled bytes may be broadcast (again) now: a claim only while tip <= ref + 11. */
  mayResend(item) {
    return !isMineItem(item) || this.topHeight() <= this.mineLastResend(item.ref);
  }

  /**
   * The explorer's status of `txid`: null when it does not know the txid (404), undefined when it
   * gave no answer. Esplora and mempool.space answer GET /tx/<txid>/status with 200
   * { confirmed: false } for a txid they have never seen; only GET /tx/<txid> answers 404 (audit
   * V2-15). So the status is read from the transaction itself whenever the client can fetch it
   * (Esplora.tx); txStatus is the fallback for a client without it.
   */
  async statusOf(txid) {
    try {
      if (typeof this.esplora.tx === "function") {
        const tx = await this.esplora.tx(txid);
        return tx && typeof tx.status === "object" && tx.status ? tx.status : undefined;
      }
      return await this.esplora.txStatus(txid);
    } catch (e) {
      return /\b404\b|not found|no such/i.test(String(e?.message ?? e)) ? null : undefined;
    }
  }

  async reconcileFanouts() {
    for (const entry of this.state.ledger) {
      if ((entry.kind !== "fanout" && entry.kind !== "merge") || entry.outcome !== "pending") continue;
      let st = await this.statusOf(entry.txid);
      if (st === null && entry.raw) {
        // Unknown to the explorer: never sent (a crash before the broadcast) or
        // evicted. Send the same bytes again; drop it once its input is gone.
        const result = await this.broadcastRaw(entry.raw);
        if (result === "ok") st = { confirmed: false };
        else if ((result === "spent" || result.startsWith("refused: ")) && (st = await this.statusOf(entry.txid)) === null) {
          this.dropHousekeeping(entry, result === "spent" ? `the ${entry.kind}'s input was spent elsewhere` : `the network refused the ${entry.kind}`);
          continue;
        }
      }
      if (!st) continue; // no answer, or a broadcast error: look again next tick
      // Sent before a crash cut maybeFanout short: its outputs may be spent now.
      if (entry.unsent) this.fanoutSent(entry);
      if (st.confirmed) {
        entry.outcome = "accepted";
        entry.height = st.block_height ?? null;
        delete entry.raw;
      }
    }
  }

  /**
   * A housekeeping transaction proven never to have reached the network (an explicit refusal or
   * a spent input, for a txid the explorer does not know): its coins come back, its fee to the
   * margin. Never called on an unknown broadcast outcome (I-PAY).
   */
  dropHousekeeping(entry, reason) {
    entry.outcome = "dropped";
    entry.reason = reason;
    delete entry.raw;
    delete entry.unsent;
    this.revertCoins(entry.txid);
    this.books.refundHousekeeping(entry.fee);
  }

  /**
   * Confirmations of the relayer's own change, from the status of each unconfirmed parent
   * transaction (one explorer call per transaction per tick), never from an address listing.
   */
  async followCoins() {
    const parents = new Set();
    for (const c of Object.values(this.state.coins)) if (c.kind === "change" && !c.confirmed && !c.unsent) parents.add(c.parent);
    for (const txid of parents) {
      const st = await this.statusOf(txid);
      if (!st?.confirmed) continue;
      for (const c of Object.values(this.state.coins)) {
        if (c.parent === txid) Object.assign(c, { confirmed: true, depth: 0, root: null, height: st.block_height ?? null });
      }
    }
  }

  /**
   * Reorgs of credited deposits (contract §4.5): a credit less than 6 blocks deep (counted from
   * the height it is confirmed at now, not the one it was credited at) is looked up each tick,
   * and so is one whose deposit went back to the mempool, for as long as it stays there.
   * - Back in the mempool ({ confirmed: false }): its coin is frozen (reorged, unconfirmed, never
   *   spent) and its account gets no new signature for that amount (frozenSats) until the
   *   deposit is confirmed again with the confirmations a credit needs.
   * - Confirmed at another height: its depth counts from the new height.
   * - 404 on two ticks in a row: reversed and its coin forgotten. A reversed coin the relayer
   *   already spent halts it for good.
   */
  async checkCredits() {
    const verify = Boolean(this.config.verifyDeposits);
    const top = verify ? this.idx.height : this.topHeight();
    const shallow = new Map(); // txid -> [credit keys]
    for (const [key, c] of Object.entries(this.books.toJSON().credits)) {
      if (c.reversed || c.height == null) continue;
      const coin = this.state.coins[key];
      if (!coin?.reorged && (coin?.height ?? c.height) + REORG_DEPTH - 1 <= top) continue;
      const txid = key.slice(0, key.indexOf(":"));
      shallow.set(txid, [...(shallow.get(txid) ?? []), key]);
    }
    for (const txid of this.vanished.keys()) if (!shallow.has(txid)) this.vanished.delete(txid);
    for (const [txid, keys] of shallow) {
      const st = await this.statusOf(txid);
      if (st !== null) {
        this.vanished.delete(txid);
        let view = st;
        // verifyDeposits: "confirmed" counts only in a block the indexer applied, with the
        // transaction proven inside it; anything else keeps the coin frozen.
        if (verify && st && st.confirmed) {
          let inside = false;
          try {
            inside = this.onVerifiedChain(st) === "ok" && (await this.proveInclusion(txid, st));
          } catch {
            inside = undefined; // the source could not answer: nothing changes this tick
          }
          if (inside === undefined) continue;
          if (!inside) view = { confirmed: false, unverified: true };
        }
        if (view) for (const key of keys) this.followDeposit(key, view, top);
        continue;
      }
      const seen = (this.vanished.get(txid) ?? 0) + 1;
      this.vanished.set(txid, seen);
      if (seen < VANISHED_TICKS) continue;
      this.vanished.delete(txid);
      for (const key of keys) {
        this.books.reverseCredit(key);
        const coin = this.state.coins[key];
        if (coin?.status === "spent") this.halt([`spent a reversed deposit ${key}`], { sticky: true });
        delete this.state.coins[key];
        this.log.warn?.(`relayer: a credited deposit left the chain and was reversed (${key})`);
      }
    }
  }

  /** checkCredits: one credited deposit's coin against the explorer's status of its transaction. */
  followDeposit(key, st, top) {
    const coin = this.state.coins[key];
    if (coin?.kind !== "deposit") return;
    if (!st.confirmed) {
      if (!coin.reorged) {
        this.log.warn?.(st.unverified
          ? `relayer: a credited deposit is not in a block of the verified chain; frozen until it is (${key})`
          : `relayer: a credited deposit is back in the mempool; frozen until it confirms again (${key})`);
      }
      Object.assign(coin, { reorged: true, confirmed: false });
      return;
    }
    if (Number.isSafeInteger(st.block_height)) coin.height = st.block_height;
    if (coin.reorged && Number.isSafeInteger(st.block_height) && top - st.block_height + 1 >= this.depositConfirmations()) {
      delete coin.reorged;
      coin.confirmed = true;
    }
  }

  /**
   * Sats of an account's credits whose deposit is back in the mempool (checkCredits): not
   * spendable until it confirms again. `acct` is the account's books key (books.keyOf).
   */
  frozenSats(acct) {
    let s = 0;
    for (const [key, coin] of Object.entries(this.state.coins)) {
      if (coin.kind !== "deposit" || !coin.reorged) continue;
      const credit = this.books.isCredited(key);
      if (credit && !credit.reversed && !credit.settled && credit.id === acct) s += credit.amount;
    }
    return s;
  }

  /** Spent coins are kept until the transaction that spent them is 6 blocks deep. */
  pruneCoins() {
    const heights = new Map();
    for (const l of this.state.ledger) if (l.height != null && (l.outcome === "accepted" || l.outcome === "rejected")) heights.set(l.txid, l.height);
    for (const [key, c] of Object.entries(this.state.coins)) {
      const h = c.status === "spent" ? heights.get(c.spentBy) : undefined;
      if (h !== undefined && this.idx.height >= h + KEEP_RAW_CONFS - 1) delete this.state.coins[key];
      // L1: a spent coin's lineage is needed only if its spender is undone; once that spender is
      // in a block, its tags go (a reorg that brings the coin back leaves it without cover).
      else if (h !== undefined && c.mix) delete c.mix;
    }
    this.settleCredits();
  }

  /**
   * L2: a credit forgets its account (books.settleCredit) once its deposit has left the pool
   * (merged, and the merge pruned 6 blocks deep; or reversed), it is past any reorg, and wallets
   * no longer warn about it: RECENT_LANDED relayed transfers have landed since it, or it is
   * creditKeepBlocks deep. Until then the account read still lists it, because the wallets'
   * "recent top-up" warning needs its height; while that warning stands, the top-up's timing
   * already ties a send to it in public.
   */
  settleCredits() {
    const top = this.idx.height;
    const landed = this.state.ledger.filter((l) => l.kind === "carrier" && l.outcome === "accepted" && l.height != null).map((l) => l.height);
    for (const [key, c] of this.books.creditMap) {
      if (c.settled || this.state.coins[key]) continue;
      if (!c.reversed) {
        if (c.height == null || c.height > top - REORG_DEPTH) continue;
        const quiet = landed.filter((h) => h > c.height).length >= RECENT_LANDED;
        if (!quiet && c.height > top - this.config.creditKeepBlocks) continue;
      }
      this.books.settleCredit(key);
    }
  }

  /** Drops items final for more than 1008 blocks. The ledger is kept. */
  prune() {
    for (const item of this.items) {
      if (FINAL.has(item.status) && !item.raw && item.finalHeight !== undefined && item.finalHeight < this.idx.height - PRUNE_FINAL_AFTER) {
        delete this.state.items[item.id];
      }
    }
  }

  // -------------------------------------------------------------- flush

  /**
   * Carries due items (contract §4.5, batch-contract §3.5): in random order, each in its own
   * 1-in / OP_RETURN / change carrier. A batch item waits until the indexer reaches its
   * releaseAt; then its whole epoch goes out in the same shuffled pass as the Next-block
   * items. An epoch is held whole only when the relayer cannot send at all (fee rate unknown,
   * too few pool coins); above the fee cap, or when one account's balance is short, an item
   * becomes "missed" and the rest go on. Journaled signing items are re-sent with the same raw
   * bytes, never re-signed, so one envelope can never ride in two different carriers.
   */
  async flush({ only } = {}) {
    if (!only) {
      for (const item of this.items.filter((i) => i.status === "signing")) await this.sendJournaled(item);
    }
    if (this.state.halted || this.stopCode()) return; // no new signature until the books add up again (or during an emergency)
    const h = this.idx.height;
    // Fast-mode timers (`only`) never touch batch items.
    const due = this.items.filter((i) => i.status === "queued" && (only ? only.includes(i.id) && !isHeld(i) : !isHeld(i) || h >= i.releaseAt));
    if (!due.length) return;
    const feeRate = this.cache.feeRate;
    if (feeRate === null || this.perCarrier(feeRate) === null) {
      this.log.warn?.("relayer: fee rate unknown; every due item waits for the next block");
      return;
    }
    const over = this.feeHigh();
    const singles = [];
    const epochs = new Map(); // epochKey -> its due items
    for (const item of due) {
      if ((await this.precheck(item)) !== "go") {
        this.save();
        continue;
      }
      // A claim is priced at the next-block rate: above the cap it is missed (nothing charged).
      if (isMineItem(item) ? this.mineGateCode() === "fee_high" : over) {
        this.miss(item, "fee_high");
        this.save();
        continue;
      }
      // A deposit of this account went back to the mempool: no signature for money that may not exist.
      const frozen = item.account ? this.frozenSats(item.account) : 0;
      const price = isMineItem(item) ? this.mineQuote(item.asset)?.total : this.quote();
      if (frozen && this.books.accountByKey(item.account).balance + (item.reservation ?? 0) - frozen < (price ?? Infinity)) {
        this.miss(item, "balance_low");
        this.save();
        continue;
      }
      if (!isHeld(item)) {
        singles.push(item);
        continue;
      }
      const k = epochKey(item.mode, item.anchor);
      epochs.set(k, [...(epochs.get(k) ?? []), item]);
    }
    // Whole or held, oldest anchor first, only for want of coins. Next-block items take their coins first.
    const groups = [...epochs.values()].sort((a, b) => a[0].anchor - b[0].anchor || a[0].lastRelease - b[0].lastRelease);
    let capacityLeft = groups.length ? this.capacity() - singles.length : 0;
    const released = [];
    for (const group of groups) {
      const k = epochKey(group[0].mode, group[0].anchor);
      if (group.length > capacityLeft) {
        this.log.warn?.(`relayer: batch ${k} (${group.length}) held whole until the next block: too few pool coins`);
        continue;
      }
      capacityLeft -= group.length;
      released.push(group);
    }
    const going = [...singles, ...released.flat()];
    // A cold pool (no change coin yet, fresh deposits): merge them now, so nothing waits for the next tick.
    if (going.length && this.pickCoin(this.spendableCoins(), this.perCarrier(feeRate) + DUST) === null) await this.maybeMerge();
    for (const item of shuffle(going)) {
      if (item.status !== "queued") continue;
      let retried = false;
      for (;;) {
        const outcome = await this.carry(item);
        if (outcome === "spent-input" && !retried) {
          retried = true;
          continue;
        }
        break;
      }
      this.save();
    }
    for (const group of released) {
      const left = group.filter((i) => i.status === "queued" || i.status === "signing").length;
      if (left) this.log.warn?.(`relayer: batch ${epochKey(group[0].mode, group[0].anchor)} went out split: ${left} of ${group.length} not broadcast`);
    }
  }

  /**
   * Last block an item may be broadcast at. A batch item (isHeld) keeps the lastRelease its 202
   * promised (a restart with other safety settings does not move it), and its epoch
   * shares the earliest one, so an epoch still expires whole. Others: anchor + 100 - 24.
   */
  deadlineOf(item) {
    if (isMineItem(item)) return this.mineDeadline(item.ref); // ref + 9: the last tip a claim is signed at
    if (!isHeld(item)) return item.anchor + ANCHOR_WINDOW - this.config.safetyBlocks;
    let d = item.lastRelease ?? item.anchor + ANCHOR_WINDOW - this.safetyFor(item.mode);
    for (const i of this.items) {
      if (i.lastRelease != null && i.mode === item.mode && i.anchor === item.anchor && isWaiting(i)) d = Math.min(d, i.lastRelease);
    }
    return d;
  }

  /** "go", "wait" (a claim whose re-check could not run: next block), or the item was finalized (dropped / expired). Never broadcasts. */
  async precheck(item) {
    const idx = this.idx;
    if (isMineItem(item)) {
      const out = await this.claimPrecheck(item);
      if (out === null) return "go";
      if (out === "wait") return "wait";
      this.finalize(item, out[0], { reason: out[1] });
      return out[0];
    }
    if (item.nullifiers.some((n) => idx.nullifiers.has(n))) {
      this.finalize(item, "dropped", { reason: "notes already spent by another transaction" });
      return "dropped";
    }
    if (String(idx.roots.get(item.anchor)) !== item.root) {
      // The anchor block was reorganized: the proof must be checked again.
      let verdict;
      try {
        verdict = await idx.checkTx(decodeEnvelope(unhex(item.envelope)), { inputs: [], outputs: [] }, idx.height + 1);
      } catch (e) {
        verdict = e.message;
      }
      if (verdict !== true) {
        this.finalize(item, "dropped", { reason: `no longer valid after a reorg: ${verdict}` });
        return "dropped";
      }
      item.root = String(idx.roots.get(item.anchor));
    }
    const deadline = this.deadlineOf(item);
    if (this.topHeight() > deadline) {
      const reason = isHeld(item) ? `the batch could not be sent before block ${deadline}` : "it could not be sent before the anchor got too old";
      this.finalize(item, "expired", { reason });
      return "expired";
    }
    return "go";
  }

  /**
   * Builds, charges (signPoolTx), journals and broadcasts one carrier. Returns "sent", "held",
   * "missed", "spent-input" or "error".
   */
  async carry(item) {
    const claim = isMineItem(item);
    // A claim pays the next-block rate with headroom (never accelerated later); a transfer the relayer's rate.
    const feeRate = claim ? this.mineFeeRate() : this.cache.feeRate;
    if (feeRate === null) return "held";
    if (claim) {
      // Right before signing: the deadline, the solution, the cap with claims already sent, the stale bound.
      const late = this.claimLastCheck(item);
      if (late) {
        this.finalize(item, late[0], { reason: late[1] });
        return "missed";
      }
    }
    const envelope = unhex(item.envelope);
    let coin;
    let plan;
    let outputs;
    try {
      // A claim's service-fee outputs, from this relayer's own indexer (I0); none for a transfer.
      outputs = this.feeOutputsForEnvelope(envelope).map((o) => ({ script: o.script, amount: o.amount }));
      const service = outputs.reduce((s, o) => s + Number(o.amount), 0);
      // Priced exactly as planCarrierTx prices it, so the chosen coin always keeps its change output.
      // A claim's carrier is a leaf on a confirmed coin (mining.md §8.8).
      const coins = claim ? this.spendableCoins().filter((u) => u.confirmed) : this.spendableCoins();
      // L1: only a coin whose lineage holds minMix + 1 accounts (the same coins whoever sends),
      // unless the signed request accepted a linkable send (then the widest lineage there is).
      const cover = Boolean(item.account);
      coin = this.pickCoin(coins, this.carrierFee(envelope, feeRate, outputs) + service + DUST, { cover, linkable: item.linkable === true });
      if (!coin) {
        if (cover && item.linkable !== true && this.thinFor()) {
          // No coin covers it at all (not merely none large enough now): missed, nothing charged.
          this.miss(item, "pool_thin");
          return "missed";
        }
        this.log.warn?.(`relayer: no ${claim ? "confirmed " : ""}pool coin large enough; the item stays queued`);
        return "held";
      }
      plan = planCarrierTx({ account: this.change, utxos: [this.utxoOf(coin)], envelope, outputs, feeRate, changeScript: this.change.script, order: "given", sequence: RBF_SEQUENCE });
      // L5: a claim's change takes a random slot after the OP_RETURN, as a self-paid claim's does.
      if (outputs.length && plan.changeIndex !== null) plan = { ...plan, tx: withChangeAt(plan.tx, plan.changeIndex, 1 + randomInt(outputs.length + 1)) };
    } catch (e) {
      this.log.warn?.(`relayer: cannot build a carrier (${e?.name ?? "Error"})`);
      return "held";
    }
    try {
      this.signPoolTx({
        tx: plan.tx, inputs: [coin], ref: item.id, kind: "carrier", envelope, feeOutputs: outputs,
        journal: (signed, { fee, cost, root, service }) => {
          Object.assign(item, { status: "signing", raw: signed.hex, txid: signed.txid, vsize: signed.vsize, fee, feeRate, cost, outpoint: coin.key, attempts: 0 });
          if (claim) item.serviceSats = service;
          if (root) item.fanout = root; // counts toward that fan-out's descendants
          else delete item.fanout;
        },
      });
    } catch (e) {
      if (e instanceof BooksError && e.code === "balance_low") {
        this.miss(item, "balance_low");
        return "missed";
      }
      if (!refusal(e)) {
        // A failed journal save: nothing that is not on disk may ever be broadcast, so the
        // signature is forgotten in memory too (refund, reservation back, coins back), and the tick stops.
        if (item.status === "signing") this.unsign(item);
        throw e;
      }
      this.log.warn?.(`relayer: carrier not signed (${e instanceof BooksError ? e.code : String(e?.message ?? "").split(":")[0] || "error"})`);
      return "held";
    }

    const result = await this.broadcastRaw(item.raw);
    if (result === "ok") {
      this.markBroadcast(item);
      return "sent";
    }
    if (result === "chain") {
      // Valid, but the mempool's chain limits refuse it for now: journaled, resent next flush.
      this.log.warn?.("relayer: carrier held by mempool chain limits; it is resent after the next block");
      return "held";
    }
    if (result === "spent") {
      // Our view of that coin was wrong: forget the never-accepted transaction (nothing is
      // charged), keep the reservation, and try once more with another coin.
      this.unsign(item);
      return "spent-input";
    }
    return (await this.failedBroadcast(item, result)) ? "sent" : "error";
  }

  /**
   * A journaled ("signing") carrier whose broadcast answered neither "ok", "spent" nor
   * "chain". The explorer is asked for its txid first: if it knows it (mempool or block), the
   * carrier reached the network and is broadcast (its charge is final). Only an explicit
   * refusal by the node, for a txid the explorer does not know, counts as an attempt (after
   * 3 the item is dropped and refunded: it never reached the network). Any other answer (5xx,
   * 429, a dropped connection, no status answer) leaves the outcome unknown: the bytes may be
   * in a mempool already, so the item stays journaled and charged and the same bytes are sent
   * again next block. A carrier that may be on the network is never refunded (I-PAY).
   * Returns true when the item is now broadcast.
   */
  async failedBroadcast(item, result) {
    const st = await this.statusOf(item.txid);
    if (st) {
      this.markBroadcast(item);
      return true;
    }
    // A refusal proves nothing for bytes whose earlier answer was lost (unknownOutcome): they may
    // be in another node's mempool, so it is not an attempt and never leads to a refund.
    if (st === null && String(result).startsWith("refused: ") && !item.unknownOutcome) {
      this.countAttempt(item, result);
      return false;
    }
    item.unknownOutcome = true;
    this.log.warn?.(`relayer: broadcast outcome unknown; the carrier stays journaled and is sent again (${String(result).slice(0, 120)})`);
    return false;
  }

  /** Undoes a carrier that was signed but never reached the network: refund, re-reserve, coins back. */
  unsign(item) {
    this.revertCoins(item.txid);
    for (const k of ["raw", "txid", "vsize", "fee", "feeRate", "cost", "outpoint", "fanout"]) delete item[k];
    item.status = "queued";
    if (!this.rereserve(item.id)) this.miss(item, "balance_low");
  }

  /** A charge that will not be paid after all: refunded, and the item's reservation taken again. */
  rereserve(ref) {
    const item = this.state.items[ref];
    known(() => this.books.refundCharge(ref));
    try {
      this.books.reserve(ref, item.account, item.reservation, { byKey: true });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * "ok" (accepted or already known: in the mempool, or confirmed, including Bitcoin Core
   * 28+'s "Transaction outputs already in utxo set"), "spent" (input missing, or spent by
   * another transaction), "chain" (mempool ancestor, descendant or cluster limits: valid, try
   * again later), "refused: <text>" (the node answered and refused it: it did not enter that
   * mempool) or the error text of an answer that never came (5xx, 429, a dropped
   * connection, a timeout): the bytes may have reached the network (isUnknownOutcome).
   */
  async broadcastRaw(raw) {
    try {
      await this.esplora.broadcast(raw);
      return "ok";
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (/already known|already in (the )?(mempool|block ?chain)|txn-already|already have|already in (the )?utxo ?set|outputs already/i.test(msg)) return "ok";
      if (/missingorspent|missing-inputs|missing inputs|inputs-missing|txn-mempool-conflict|rejecting replacement/i.test(msg)) return "spent";
      if (/too-long-mempool-chain|too many (unconfirmed )?(ancestors|descendants)|exceeds (ancestor|descendant|cluster)|too-large-cluster|cluster (size )?limit/i.test(msg)) return "chain";
      if (/RPC error|\/tx: 4(?!29)\d\d\b/i.test(msg)) return `refused: ${msg}`;
      return msg;
    }
  }

  /** The carrier reached the network: the charge is final and the item forgets its account. */
  markBroadcast(item) {
    item.status = "broadcast";
    item.broadcastHeight = this.idx.height;
    this.books.confirmCharge(item.id);
    delete item.account;
    delete item.unknownOutcome;
    item.reservation = 0;
    delete item.envelope; // kept only while queued
    for (const c of Object.values(this.state.coins)) if (c.parent === item.txid) delete c.unsent;
    if (item.ledgerSeq === undefined) {
      item.ledgerSeq = this.nextSeq();
      this.state.ledger.push({
        seq: item.ledgerSeq, kind: "carrier", txid: item.txid, vsize: item.vsize, fee: item.fee, feeRate: item.feeRate,
        broadcastHeight: item.broadcastHeight, height: null, outcome: "pending", reason: null,
        // Internal: groups batch carriers for info().batch.recent; ledgerView() never shows it.
        ...(isBatchMode(item.mode) ? { epoch: epochKey(item.mode, item.anchor) } : {}),
        // A claim's carrier: the service-fee outputs it paid besides the miner fee.
        ...(isMineItem(item) ? { serviceSats: item.serviceSats } : {}),
      });
    }
  }

  countAttempt(item, error) {
    item.attempts = (item.attempts ?? 0) + 1;
    this.log.warn?.(`relayer: broadcast failed (${item.attempts}/${MAX_BROADCAST_ATTEMPTS}): ${String(error).slice(0, 120)}`);
    if (item.attempts >= MAX_BROADCAST_ATTEMPTS) this.finalize(item, "dropped", { reason: "the carrier could not be broadcast" });
  }

  nextSeq() {
    const last = this.state.ledger[this.state.ledger.length - 1];
    return last ? last.seq + 1 : 1;
  }

  /** A broadcast carrier that never reached a block and whose input is gone: its fee (and a claim's service fees) go to the margin. */
  dropSent(item, reason) {
    this.revertCoins(item.txid);
    if (item.fee) this.books.reclaim(item.fee, isMineItem(item) ? { service: item.serviceSats ?? 0 } : undefined);
    this.finalize(item, "dropped", { reason });
  }

  /**
   * A claim's journaled carrier past ref + 11 is never broadcast again (mining-contract.md D10).
   * Known to the explorer (it reached the network): broadcast, its charge final, and
   * reconcile() gives the verdict or expires it. Never reached the network (the explorer does
   * not know it and no earlier answer was lost): expired, its charge refunded and its coin back.
   * A lost earlier answer: charged, never refunded (I-PAY), expired once the window has closed.
   */
  async retireClaim(item) {
    if (item.status !== "signing") return;
    const st = await this.statusOf(item.txid);
    if (st || (item.unknownOutcome && this.idx.height > this.windowEnd(item))) this.markBroadcast(item);
    else if (st === null && !item.unknownOutcome) this.finalize(item, "expired", { reason: "it could not be broadcast before the end of its 12-block window" });
    this.save();
  }

  /** Re-sends a journaled raw transaction (startup, or after a failed broadcast). */
  async sendJournaled(item) {
    if (!this.mayResend(item)) return this.retireClaim(item);
    const result = await this.broadcastRaw(item.raw);
    if (result === "ok") {
      if (item.status === "signing") this.markBroadcast(item);
    } else if (item.status === "signing" && item.unknownOutcome) {
      // An earlier answer was lost, so these bytes may be in some mempool even when this node
      // refuses them now or the explorer does not know the txid (evicted on one node, kept on
      // another). Such a carrier is never refunded or dropped (I-PAY, audit V2-17): it stays
      // journaled and charged and is sent again next block. Once the anchor window has closed it
      // can no longer count, so it is marked broadcast (its charge final) and reconcile() expires it.
      const st = await this.statusOf(item.txid);
      if (st || this.idx.height >= this.windowEnd(item)) this.markBroadcast(item);
      else this.log.warn?.(`relayer: a carrier whose earlier outcome is unknown stays journaled (${String(result).slice(0, 120)})`);
    } else if (result === "spent") {
      // Either it confirmed already (fine) or its input was spent elsewhere.
      // With no answer from the explorer, it stays as it is until the next resend.
      const st = await this.statusOf(item.txid);
      if (st) {
        if (item.status === "signing") this.markBroadcast(item);
      } else if (st === null) {
        if (item.status === "signing") this.finalize(item, "dropped", { reason: "the carrier's input was spent elsewhere" });
        else this.dropSent(item, "the carrier's input was spent elsewhere");
      }
    } else if (result === "chain") {
      // Waits for its unconfirmed parents; no attempt is used, but never past the anchor window.
      // The node refused it outright (it is not in that mempool); a txid the explorer knows is broadcast.
      if (item.status === "signing" && this.idx.height >= this.windowEnd(item)) {
        const st = await this.statusOf(item.txid);
        if (st) this.markBroadcast(item);
        else if (st === null) this.finalize(item, "dropped", { reason: "the carrier could not be broadcast" });
      }
    } else if (item.status === "signing") {
      await this.failedBroadcast(item, result);
    }
    this.save();
  }

  /** Startup (relayer.md §4.6): resend every journaled or broadcast carrier. */
  async recover() {
    for (const item of this.items.filter((i) => (i.status === "signing" || i.status === "broadcast") && i.raw)) {
      await this.sendJournaled(item);
    }
    for (const item of this.items.filter((i) => i.status === "queued" && i.mode === "fast")) this.scheduleFast(item.id);
  }

  // -------------------------------------------------------------- fan-out

  /**
   * Keeps enough confirmed coins for parallel carriers: when fewer than
   * FANOUT_MIN_CONFIRMED confirmed coins hold 2 x MAX_FEE_PER_TX, or the confirmed
   * coins fund fewer than FANOUT_MIN_CARRIERS carriers in one block (a batch
   * release), split the largest into up to FANOUT_TARGET x FANOUT_VALUE plus change,
   * all to C. Only a coin one chain of 21 carriers cannot use up is split. Built only
   * from coin-set coins and paid from the margin account (signPoolTx with no item):
   * with too little margin there is no fan-out. Listed in the ledger.
   */
  async maybeFanout() {
    const c = this.config;
    if (c.fanoutTarget < 2 || this.cache.feeRate === null || this.feeHigh()) return;
    if (this.state.ledger.some((l) => l.kind === "fanout" && l.outcome === "pending")) return;
    const per = this.perCarrier(this.cache.feeRate);
    if (!per) return;
    const confirmed = this.spendableCoins().filter((u) => u.confirmed && u.kind === "change");
    const fewCoins = confirmed.filter((u) => u.value >= 2 * c.maxFeePerTx).length < c.fanoutMinConfirmed;
    if (!fewCoins && this.capacity(confirmed) >= c.fanoutMinCarriers) return;
    const [largest] = confirmed.sort((a, b) => b.value - a.value);
    if (!largest || Math.floor((largest.value - DUST) / per) <= CHAIN_LEN) return;
    const rate = this.cache.feeRate;
    const vsizeFor = (n) => 11 + 57.5 + 43 * (n + 1);
    let n = c.fanoutTarget;
    while (n >= 1 && largest.value < n * c.fanoutValue + feeAt(rate, vsizeFor(n)) + DUST) n -= 1;
    if (n < 1) return;
    const fee = feeAt(rate, vsizeFor(n));
    // One output only pays when its change is a second coin that funds a carrier.
    if (n === 1 && largest.value - c.fanoutValue - fee < per + DUST) return;
    if (fee > c.maxFeePerTx) return;

    const { script, tapInternalKey } = this.utxoOf(largest);
    const tx = new btc.Transaction();
    tx.addInput({ txid: largest.txid, index: largest.vout, witnessUtxo: { script, amount: BigInt(largest.value) }, tapInternalKey, sequence: RBF_SEQUENCE });
    const amounts = Array(n).fill(c.fanoutValue);
    const change = largest.value - n * c.fanoutValue - fee;
    // L5: the change output takes a random slot among the equal outputs.
    if (change >= DUST) amounts.splice(randomInt(n + 1), 0, change);
    for (const a of amounts) tx.addOutput({ script: this.change.script, amount: BigInt(a) });

    let entry;
    try {
      this.signPoolTx({
        tx, inputs: [largest], ref: null, kind: "fanout",
        journal: (signed, { fee: paid }) => {
          entry = {
            seq: this.nextSeq(), kind: "fanout", txid: signed.txid, vsize: signed.vsize, fee: paid, feeRate: rate,
            broadcastHeight: this.idx.height, height: null, outcome: "pending", reason: null, raw: signed.hex, unsent: true,
          };
          this.state.ledger.push(entry);
        },
      });
    } catch (e) {
      if (!refusal(e)) {
        // A failed journal save: forget the unsaved fan-out in memory too, then stop the tick.
        if (entry) {
          this.state.ledger = this.state.ledger.filter((l) => l !== entry);
          this.revertCoins(entry.txid);
          this.books.refundHousekeeping(entry.fee);
        }
        throw e;
      }
      // margin_low: the margin account cannot pay it yet, which is normal; try again next tick.
      if (!(e instanceof BooksError && e.code === "margin_low")) this.log.warn?.(`relayer: no fan-out (${e instanceof BooksError ? e.code : String(e?.message ?? "").split(":")[0] || "error"})`);
      return;
    }
    await this.sendHousekeeping(entry);
    this.save();
  }

  /**
   * First broadcast of a journaled fan-out or merge. "ok", or a txid the explorer knows: sent.
   * An explicit refusal or a spent input for a txid the explorer does not know: dropped (its
   * coins back, its fee to the margin). Anything else (a lost answer, 5xx, mempool chain
   * limits, no status answer) keeps it pending with its raw bytes and its outputs unsent, and
   * reconcileFanouts() decides on the next tick: the bytes may already be on the network.
   */
  async sendHousekeeping(entry) {
    const result = await this.broadcastRaw(entry.raw);
    if (result === "ok") return this.fanoutSent(entry);
    const st = await this.statusOf(entry.txid);
    if (st) return this.fanoutSent(entry);
    if (st === null && (result === "spent" || result.startsWith("refused: "))) {
      this.dropHousekeeping(entry, result === "spent" ? `the ${entry.kind}'s input was spent elsewhere` : `the network refused the ${entry.kind}`);
      return;
    }
    this.log.warn?.(`relayer: ${entry.kind} broadcast outcome unknown; it stays pending (${String(result).slice(0, 120)})`);
  }

  /**
   * Deposits reach C only through a merge (relay-balance.md §5): no carrier ever spends a
   * deposit, so a carrier's input is never one hop from the address that paid it. A merge
   * spends credited, confirmed deposit coins (at most MAX_MERGE_INPUTS, chosen by mergePlan) into
   * one output to C, paid from the margin account (each credit put its sweepCost there), with
   * no more inputs than maxFeePerTx allows at the current rate. Carriers then pick at random
   * among all of C's coins (pickCoin). A deposit is merged at the first tick after the block
   * it was credited in, so deposits of one block share a merge, or at once while the change
   * coins cannot fund the waiting carriers plus MERGE_ROOM more: a relayed send never waits
   * for a merge beyond one tick (a Fast item held for want of a coin goes right after the
   * merge, in the same tick). Margin too low: next tick.
   * L1: a merge also spends one confirmed pool coin of other accounts when there is one (its
   * input fee is paid from the margin like the rest), so the output descends from more accounts
   * than the deposits'. With no such coin, deposits of two or more accounts merge together;
   * a lone account's deposits merge only while a queued send has no coin without them. With
   * minMix 0 (L1 off) merges take deposits only, at once, as before. Which coins go is
   * mergePlan's deterministic choice (so the cover published before the merge is the cover it
   * delivers); their order in the transaction is random, and every input signals RBF (L5).
   */
  async maybeMerge() {
    // L1: never a deposit alone; the deposits go with a pool coin of other accounts when there is
    // one, else with deposits of other accounts (mergePlan, the plan fundingCoins publishes).
    const plan = this.mergePlan(this.spendableCoins());
    if (!plan) return;
    const rate = this.cache.feeRate;
    const inputs = shuffle([...plan.inputs]); // L5: random input order
    const total = inputs.reduce((s, u) => s + u.value, 0);
    const fee = plan.fee;
    const tx = new btc.Transaction();
    for (const u of inputs) {
      const { script, tapInternalKey } = this.utxoOf(u);
      tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script, amount: BigInt(u.value) }, tapInternalKey, sequence: RBF_SEQUENCE });
    }
    tx.addOutput({ script: this.change.script, amount: BigInt(total - fee) });
    let entry;
    try {
      this.signPoolTx({
        tx, inputs, ref: null, kind: "merge",
        journal: (signed, { fee: paid }) => {
          entry = {
            seq: this.nextSeq(), kind: "merge", txid: signed.txid, vsize: signed.vsize, fee: paid, feeRate: rate,
            broadcastHeight: this.idx.height, height: null, outcome: "pending", reason: null, raw: signed.hex, unsent: true,
          };
          this.state.ledger.push(entry);
        },
      });
    } catch (e) {
      if (!refusal(e)) {
        if (entry) {
          this.state.ledger = this.state.ledger.filter((l) => l !== entry);
          this.revertCoins(entry.txid);
          this.books.refundHousekeeping(entry.fee);
        }
        throw e;
      }
      if (!(e instanceof BooksError && e.code === "margin_low")) this.log.warn?.(`relayer: no merge (${e instanceof BooksError ? e.code : String(e?.message ?? "").split(":")[0] || "error"})`);
      return;
    }
    await this.sendHousekeeping(entry);
    this.save();
  }

  /** A fan-out reached the network: carriers may chain on its outputs. */
  fanoutSent(entry) {
    delete entry.unsent;
    for (const c of Object.values(this.state.coins)) if (c.parent === entry.txid) delete c.unsent;
  }
}

/** Step 0: JSON shape, the exact key set and hex formats; anything else is `malformed`. */
export function parseSubmit(rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new RelayError("malformed");
  }
  if (
    !(sameKeys(body, SUBMIT_BASE) || sameKeys(body, SUBMIT_LINKABLE)) ||
    typeof body.envelope !== "string" || !ENVELOPE_HEX.test(body.envelope) ||
    !isMode(body.mode) || // "block", "fast", "batch" (Hourly batch) or "batch10" (10-hour batch); "batch12" is malformed
    (Object.hasOwn(body, "linkable") && typeof body.linkable !== "boolean")
  ) {
    throw new RelayError("malformed");
  }
  return { envelope: body.envelope, mode: body.mode, linkable: body.linkable === true, body };
}

/**
 * The digest a submit's sig signs: the shared requestDigest (RELAY_SIGN_TAG, endpoint, network,
 * Q, sha256 of the canonical body, where the boolean `linkable` is JSON true / false).
 */
export function submitDigest(poolKey, fields) {
  return requestDigest({ endpoint: RELAY_ENDPOINTS.submit, network: NETWORK, poolKey, fields });
}

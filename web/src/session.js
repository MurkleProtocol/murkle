// Browser wallet session: keys from a BIP-39 phrase unlocked from the vault, a
// verified view of the indexer, and the mint / send / launch flows. Everything
// secret stays here: the indexer only serves public data, and notes are found by
// trial decryption in this browser.
//
// Leak-free by construction: the wallet only downloads data every wallet
// downloads in full (outputs, nullifiers, the bulk log, assets). It never asks
// our server or mempool.space about one of its own txids or nullifiers. The only
// per-item call is /api/relay/status/:id for envelopes the relayer already holds.
//
// Module API (other pages use currentSession() read-only)
//   currentSession() -> Session | null
//   hasVault(), hasLegacy(), unlock(password), createWallet(phrase, password),
//   migrateWallet(password), lock(reason?), forgetWallet(), revealPhrase(password),
//   revealLegacyPhrase(password), forgetLegacy(), changePassword(old, next),
//   onSessionChange(fn) -> off   fn(type): "unlock", "lock", "idle-lock", "elsewhere-lock"
//                                (another tab changed or removed the wallet), "forget", "sync",
//                                "relay" (relay info loaded or failed), ...
//   mintPayment(asset) -> { price, paid, raised }   what a mint pays its treasury (pure)
//   streamerMode(), setStreamerMode(on), onStreamerChange(fn) -> off
//   autoLockMinutes(), setAutoLock(minutes)        5 | 15 | 60 | 0 (never); default 15
//   newPhrase(), phraseCheck(text), isValidPhrase(text), normalizePhrase(text)
//   formatUnits(v, div), parseUnits(text, div)
//   lockedNullifiers(history, height, nullifierSet)   wallet invariant W-1 (pure)
//   deriveStatus(entry, ctx)                          history status from bulk data (pure)
//   NOT_IN_BATCH                                      error code: notes newer than the batch boundary
//   batchPhase(entry, height)                         where a batch send stands, for display (pure)
//   relayStranded(entry)                              a relayed send no relayer will send (relaying closed)
//   relayStuck(entry, height)                         a relayed carrier broadcast 6+ blocks ago, not landed
//   retryChoices(entry, height)                       the retry buttons an entry offers (pure)
//   Session: relayModePref, selfModePref, defaultMode(to), batchPlan(mode, { asset, amount }),
//            send({ ..., mode }), retry(entry, { via, mode }); relay timing per batch-contract.md §4
//   Relay balance (docs/design/relay-balance-contract.md §5.3):
//            relayAccount -> { pubHex, idHex }   (the secret never leaves the session)
//            relayBalance -> null | { balance, reserved, nextIndex, credits, at }; loadRelayBalance({ signal })
//            depositIndex, depositAddress(n) -> { n, address }, checkDeposits({ older })
//            topUpOpen (the top-up sheet sets it), relayWork (the last automatic relay step, a promise)
//            events: "relay" (info), "relay-balance" (balance, deposits, pending)
//   Mining (docs/design/mining-contract.md §10.1):
//            minePayer: the built-in MINING key (feeKeysOf mineFeeKey), apart from localPayer (transfers,
//            top-ups); its coins never pay a transfer or a top-up. checkMineBtc(), prepareCoins(n),
//            moveBetweenKeys({ from, amount, confirm }) (asks first: it links the two addresses)
//            assetList merges /api/assets with /api/mine (kind "mint" | "pow"); mineInfo = the last /api/mine
//            prepareMine(asset) -> draft (fresh outputs every call), claimMine({ ... }) -> history entry (W-M)
//            mergeAssets, mineQuote, mineWindowLeft, deriveMineStatus, mineFeeOutputs (pure)
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { secp256k1 } from "@noble/curves/secp256k1";
import * as snarkjs from "snarkjs";
import { MerkleTree, toField } from "../../src/core.mjs";
import { deriveKeys, encodeAddress, decodeAddress } from "../../src/keys.mjs";
import { Wallet, anchorAt } from "../../src/wallet.mjs";
import { DEFAULT_SAFETY, EPOCH_BLOCKS, OVERDUE_AFTER, batchSchedule, isBatchMode, isMode, leafCountAt, savedMode } from "../../src/relay-batch.mjs";
import { OP, decodeEnvelope, encodeDeploy, encodeDeployPow, scriptHashOf } from "../../src/envelope.mjs";
import { decodeProof } from "../../src/proof-codec.mjs";
import { FEE_HEADROOM, carrierAmountOf, dustLimit, headroomRate, pickBindUtxo, planCarrierTx, planSplitTx, scriptOf, signLocal } from "../../src/btc/funding.mjs";
import { feeKeysOf } from "../../src/keys.mjs";
import { LABELS, MINE_FEE, MINE_SLACK, MINE_WINDOW, STALE_FACTOR } from "../../src/params.mjs";
import { challengeOf, checkFeePolicy, meetsTarget, passwordOf, requiredFeeOutputs, rewardAt, solutionIdOf, targetOf } from "../../src/mine.mjs";
import { hex, unhex, outpointOf, randomBytes } from "../../src/bytes.mjs";
import { DEPOSIT_CONFIRMATIONS, btcNetwork, depositAddress as depositAddressOf, relayAccount } from "../../src/relay-account.mjs";
import * as api from "./api.js";
import { ARTIFACT_SHA256, BRAND, NETWORK, PRE_GENESIS, STORAGE_PREFIX, label } from "./config.js";
import { LocalPayer, UnisatPayer, RelayPayer, RBF_SEQUENCE } from "./payers.js";
import { accountBalance, creditDeposit, missedText, relayFailure, relayOpen, relayRotation, setRelayRoute, submitEnvelope } from "./relay.js";
import { candidateNotes, crowdCheck } from "./privacy.js";
import * as keystore from "./keystore.js";
import { setWalletStatus, setRootStatus } from "./ui/status.js";
import { eta, int } from "./ui/format.js";

export const ANCHOR_WINDOW = 100; // src/indexer.mjs: an envelope is valid until block anchor + 100
// The relayer refuses anchors older than max(height, tip) - 76 (relayer.md §4.5).
const RELAY_ANCHOR_SLACK = 70;
// A launch has no anchor: call it dropped when no block has carried it for a day.
const DEPLOY_DROP_AFTER = 144;
// relay-balance.md §5: below this many relayed transfers landed since the newest top-up
// confirmed, the Send screen warns that a relayed send can be tied to the paying address.
export const RECENT_DEPOSIT_LANDED = 5;
export const AUTO_LOCK_CHOICES = [5, 15, 60, 0];
export const DEFAULT_AUTO_LOCK = 15;

const VAULT_KEY = keystore.vaultKey(STORAGE_PREFIX);
const KEY = {
  payer: keystore.payerKey(STORAGE_PREFIX), // plain: "local" | "unisat" (mints, launches, self-paid sends)
  route: `${STORAGE_PREFIX}.route`, // plain: "self" | "copy" | "relay" (private sends; "relay" pays from the relay balance)
  relayMode: `${STORAGE_PREFIX}.relayMode`, // plain: "block" | "fast" (relay timing for payments)
  selfMode: `${STORAGE_PREFIX}.selfMode`, // plain: any relay timing (merges and refreshes)
  streamer: `${STORAGE_PREFIX}.streamer`, // plain flag, so the lock screen respects it too
  lockAll: `${STORAGE_PREFIX}.lockAll`, // plain: a fresh value on every manual lock, so the other tabs lock too
};
// Cross-tab lock (navigator.locks) held while a send selects, proves and reserves its notes (W-1).
const SPEND_LOCK = `${STORAGE_PREFIX}.spend`;

// Settings > Network activity lists hosts from the browser's resource timing log;
// the default buffer (250 entries) would drop older requests on a long session.
try {
  globalThis.performance?.setResourceTimingBufferSize?.(5000);
} catch {}

/* ---------- storage ---------- */

const memory = new Map();
/** localStorage, or null where the page can't reach it at all (blocked site data, tests). */
function localStore() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
export const STORAGE_FULL = "This browser didn't save the wallet: its storage for this site is full or blocked. Nothing was sent. Free up browser storage, then try again.";
/**
 * localStorage when the page can reach it; an in-memory stand-in only when it can't at all
 * (blocked site data, tests). A write that localStorage refuses (storage full) throws
 * STORAGE_FULL: it never goes to memory instead, or the vault this tab believes it wrote
 * would differ from the stored one, and the next pull() would drop the new entries.
 * setPref: the same write for plain, non-secret prefs, best effort (kept for this page on failure).
 */
export const storage = {
  getItem(k) {
    if (memory.has(k)) return memory.get(k);
    try {
      return localStore()?.getItem(k) ?? null;
    } catch {
      return null;
    }
  },
  setItem(k, v) {
    const ls = localStore();
    if (!ls) return void memory.set(k, String(v));
    try {
      ls.setItem(k, v);
    } catch (e) {
      throw Object.assign(new Error(STORAGE_FULL), { code: "storage_full", cause: e });
    }
    memory.delete(k);
  },
  setPref(k, v) {
    try {
      storage.setItem(k, v);
    } catch {
      memory.set(k, String(v));
    }
  },
  removeItem(k) {
    try {
      localStore()?.removeItem(k);
    } catch {}
    memory.delete(k);
  },
};

/**
 * Runs fn while no other tab of this wallet runs it (navigator.locks); where the browser
 * has no Web Locks, it just runs. Sends select, prove and reserve their notes inside it.
 */
function spendLock(fn) {
  const locks = globalThis.navigator?.locks;
  return typeof locks?.request === "function" ? locks.request(SPEND_LOCK, fn) : fn();
}

/* ---------- phrases and amounts ---------- */

export const normalizePhrase = (p) => String(p ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
export const newPhrase = () => generateMnemonic(wordlist, 256);
export const isValidPhrase = (p) => {
  const w = normalizePhrase(p);
  return w.split(" ").length === 24 && validateMnemonic(w, wordlist);
};

const WORDS = new Set(wordlist);
/** Live import validation: { count, unknown: [words], valid, message }. */
export function phraseCheck(text) {
  const words = normalizePhrase(text).split(" ").filter(Boolean);
  const unknown = words.filter((w) => !WORDS.has(w));
  const valid = words.length === 24 && !unknown.length && validateMnemonic(words.join(" "), wordlist);
  let message;
  if (!words.length) message = "Paste or type your 24 words, separated by spaces.";
  else if (unknown.length) message = `Not in the word list: ${unknown.slice(0, 3).join(", ")}${unknown.length > 3 ? "…" : ""}. Check the spelling.`;
  else if (words.length < 24) message = `${words.length} of 24 words.`;
  else if (words.length > 24) message = `${words.length} words: a ${BRAND} phrase has exactly 24.`;
  else if (!valid) message = "24 known words, but the checksum fails. One word is probably wrong or out of order.";
  else message = "24 valid words";
  return { count: words.length, unknown, valid, message };
}

/**
 * Six-word fingerprint of a shielded address (sha256 -> 6 × 11 bits -> BIP-39
 * words), so two people can confirm an address by reading it aloud. A display
 * aid, not a checksum replacement: the bech32m checksum still guards typos.
 */
export function addressWords(address) {
  const h = sha256(new TextEncoder().encode(String(address).trim()));
  let bits = 0n;
  for (let i = 0; i < 9; i++) bits = (bits << 8n) | BigInt(h[i]);
  const out = [];
  for (let i = 0; i < 6; i++) out.push(wordlist[Number((bits >> BigInt(72 - 11 * (i + 1))) & 2047n)]);
  return out;
}

/** Base-unit integer -> decimal string with `div` decimals. */
export function formatUnits(v, div) {
  const s = BigInt(v).toString().padStart(div + 1, "0");
  if (!div) return s;
  const frac = s.slice(-div).replace(/0+$/, "");
  return frac ? `${s.slice(0, -div)}.${frac}` : s.slice(0, -div);
}
export function parseUnits(text, div) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text).trim().replace(/,/g, ""));
  if (!m || (m[2] ?? "").length > div) throw new Error(`Invalid amount: at most ${div} decimal places.`);
  return BigInt(m[1] + (m[2] ?? "").padEnd(div, "0"));
}

/**
 * What one mint of `asset` pays its treasury: the price, raised to the treasury's
 * dust limit when below it (planCarrierTx does the same; nodes refuse smaller outputs).
 */
export function mintPayment(asset) {
  const price = BigInt(asset?.priceSats ?? 0);
  if (price <= 0n || !asset?.treasury) return { price, paid: price > 0n ? price : 0n, raised: false };
  const dust = dustLimit(unhex(asset.treasury));
  return price < dust ? { price, paid: dust, raised: true } : { price, paid: price, raised: false };
}

/* ---------- history: pure rules (tested in test/payers.test.mjs) ---------- */

// Statuses whose notes stay reserved (W-1): the envelope may still be carried by anyone.
// "copied": proved here and copied out (Send > Copy envelope); whoever holds it may carry it.
export const LOCK_STATUSES = new Set(["mempool", "relaying", "failed", "dropped", "copied"]);
export const FINAL_STATUSES = new Set(["accepted", "rejected", "expired", "legacy"]);

/**
 * Wallet invariant W-1 (relayer.md §2): an envelope that has been handed to anyone
 * stays valid until block anchor + 100, because anyone can re-carry it. Until then,
 * or until its nullifiers are spent, its notes may only be used to retry that same
 * transfer (same notes, so the same nullifiers). Returns the reserved nullifiers.
 */
export function lockedNullifiers(history, height, nullifierSet) {
  const out = new Set();
  for (const h of history ?? []) {
    // W-M (mining.md §8.1): notes rolled into a claim stay reserved while it may still land,
    // that is until it lands, fails for good, or its 12-block window (lockUntil) has passed.
    if (h.kind === "mine") {
      if (!h.spends?.length || !MINE_PENDING.has(h.status)) continue;
      if (Number.isSafeInteger(h.lockUntil) && height > h.lockUntil) continue;
      if (h.spends.every((n) => nullifierSet.has(String(n)))) continue;
      for (const n of h.spends) out.add(String(n));
      continue;
    }
    if (h.era === "legacy" || !h.spends?.length || !LOCK_STATUSES.has(h.status)) continue;
    if (h.anchor === null || h.anchor === undefined || height > h.anchor + ANCHOR_WINDOW) continue;
    if (h.spends.every((n) => nullifierSet.has(String(n)))) continue;
    for (const n of h.spends) out.add(String(n));
  }
  return out;
}

/**
 * Status of one history entry from data every wallet downloads in full:
 *   ctx = { height, nullifiers: Set, outputs: Map(commitment -> { txid, height }),
 *           log: Map(txid -> { ok, reason, height }), assets: [...], relay: status | null }
 * accepted  its output commitments are in the pool, or every spend is published, or
 *           (launch) the ticker's deployTxid is this txid
 * rejected  the bulk log has a failed verdict for its txid
 * expired   tip > anchor + 100 and not accepted: the envelope can never land, notes unlock
 * relaying / failed   relayer status for envelopes it holds
 * copied    proved and copied out by the user, not seen on Bitcoin yet
 * mempool   handed to Bitcoin, no verdict yet
 */
export function deriveStatus(entry, ctx) {
  if (entry.era === "legacy") return { status: "legacy" };
  const { height, nullifiers = new Set(), outputs = new Map(), log = new Map(), assets = [], relay = null } = ctx;
  const txids = [...new Set([entry.txid, ...(entry.txids ?? [])].filter(Boolean))];
  const verdict = txids.map((t) => log.get(t)).find(Boolean) ?? null;

  if (entry.kind === "deploy") {
    const a = assets.find((x) => x.ticker === entry.ticker);
    if (a && txids.includes(a.deployTxid)) return { status: "accepted", height: a.deployHeight ?? verdict?.height ?? null, reason: null };
    if (verdict && !verdict.ok) return { status: "rejected", reason: verdict.reason ?? "Rejected by the indexer.", height: verdict.height };
    if (verdict?.ok) return { status: "accepted", height: verdict.height, reason: null };
    if (entry.sentHeight != null && height > entry.sentHeight + DEPLOY_DROP_AFTER) {
      return { status: "dropped", reason: `No block carried it within ${DEPLOY_DROP_AFTER} blocks.` };
    }
    return { status: "mempool" };
  }

  const hit = (entry.commitments ?? []).map((c) => outputs.get(String(c))).find(Boolean);
  if (hit) return { status: "accepted", txid: hit.txid ?? entry.txid ?? null, height: hit.height ?? null, reason: null };
  if (entry.spends?.length && entry.spends.every((n) => nullifiers.has(String(n)))) return { status: "accepted", reason: null };
  if (verdict && !verdict.ok) return { status: "rejected", reason: verdict.reason ?? "Rejected by the indexer.", height: verdict.height };
  if (entry.anchor != null && height > entry.anchor + ANCHOR_WINDOW) {
    return { status: "expired", reason: "Not included before its anchor window closed. The notes are free again." };
  }
  if (entry.via === "relay" && relay) {
    switch (relay.status) {
      case "queued":
        return { status: "relaying", relayStatus: "queued" };
      case "broadcast":
      case "accepted": {
        const out = { status: "relaying", relayStatus: relay.status, txid: relay.txid ?? entry.txid ?? null };
        if (Number.isSafeInteger(relay.broadcastHeight)) out.broadcastHeight = relay.broadcastHeight;
        if (Number.isSafeInteger(relay.cost)) out.cost = relay.cost;
        return out;
      }
      // The relayer did not send it when it was due (balance short, fees above its cap, or its
      // pool too thin to send it unlinkable): its reservation went back to the balance and it is
      // never sent later on its own. pool_thin offers the explicit "send it linkable" retry.
      case "missed": {
        const code = relay.code === "fee_high" || relay.code === "pool_thin" ? relay.code : "balance_low";
        return { status: "failed", relayStatus: "missed", missedCode: code, reason: missedText(code), ...(code === "pool_thin" ? { failCode: "pool_thin" } : {}) };
      }
      case "rejected":
        return { status: "rejected", reason: relay.reason ?? "Rejected by the indexer.", txid: relay.txid ?? entry.txid ?? null };
      default:
        return { status: "failed", relayStatus: relay.status, reason: relay.reason ?? "The relayer dropped this transfer." };
    }
  }
  return { status: entry.status === "failed" || entry.status === "relaying" || entry.status === "copied" ? entry.status : "mempool" };
}

/* ---------- relay timing: pure rules (tested in test/batch-session.test.mjs) ---------- */

/** Error code: a batch send whose notes arrived after its batch's boundary block. */
export const NOT_IN_BATCH = "NOT_IN_BATCH";

// Every batch entry records these; an entry missing them gets them from its anchor.
const releaseOf = (h) => h.releaseAt ?? h.anchor + EPOCH_BLOCKS[h.mode];
const lastReleaseOf = (h) => h.lastRelease ?? h.anchor + ANCHOR_WINDOW - DEFAULT_SAFETY[h.mode];

/**
 * While relaying is closed (relay.js relayOpen: no relay-balance relayer on this server),
 * no relayer sends anything, so a relayed send still recorded as "relaying" whose carrier
 * never went out is held by nobody. The next sync asks the server, which answers
 * "dropped"; until then the wallet already says so and offers paying the fee yourself or
 * copying the envelope. A carrier already broadcast is not stranded: it may still land.
 */
export function relayStranded(entry, open = relayOpen()) {
  if (open || entry?.kind !== "send" || entry.via !== "relay" || entry.status !== "relaying") return false;
  return entry.relayStatus !== "broadcast" && entry.relayStatus !== "accepted";
}

/** Whether /api/state (`state.relay`) says a relayer with relay balances runs on this server. */
export const relayAnnounced = (state) => state?.relay?.enabled === true && state.relay.mode === "balance";

/** Why a stranded send failed when the server does not know its relay id (stage 0). */
export const STRANDED_REASON = "No relayer holds this transfer any more. Pay the fee yourself or copy the envelope.";

/**
 * Where a relayed batch send stands at `height`, for display only (its status stays
 * "relaying" until it lands, W-1): "scheduled" before its batch goes out, "releasing"
 * while it goes out, "overdue" when late but still within the relayer's deadline,
 * "missed" past it, "landed", "failed". While relaying is closed, a batch send no
 * relayer will send is "stranded" at any height (relayStranded). null for anything else.
 */
export function batchPhase(entry, height) {
  if (entry?.kind !== "send" || !isBatchMode(entry.mode)) return null;
  const { status } = entry;
  if (status === "accepted") return "landed";
  if (status === "failed" || status === "rejected" || status === "expired" || status === "dropped") return "failed";
  if (status !== "relaying") return null;
  if (relayStranded(entry)) return "stranded";
  const releaseAt = releaseOf(entry);
  if (height < releaseAt) return "scheduled";
  if (entry.relayStatus === "broadcast" || entry.relayStatus === "accepted" || height < releaseAt + OVERDUE_AFTER) return "releasing";
  return height <= lastReleaseOf(entry) ? "overdue" : "missed";
}

/** The relayer's last block for a batch send (its 202 lastRelease, or the default from the anchor). */
export const lastReleaseFor = (entry) => lastReleaseOf(entry);

/**
 * A batch send the relayer is late with ("overdue") or has missed: its status stays
 * "relaying" (W-1), but it needs the user, as a failed send does. So does any relayed
 * send no relayer will send while relaying is closed (relayStranded), at any height.
 */
export function batchLate(entry, height) {
  if (relayStranded(entry)) return true;
  if (height == null) return false;
  const phase = batchPhase(entry, height);
  return phase === "overdue" || phase === "missed";
}

/** Blocks after its broadcast before a relayed carrier that has not landed counts as stuck. */
export const STUCK_AFTER = 6;

/**
 * A relayed send whose carrier the relayer broadcast at least STUCK_AFTER blocks ago and
 * that has not landed. The relayer never bumps a carrier (relay-balance.md §2): the user
 * can pay the fee themselves with the same envelope, and the relayed fee stays spent if
 * the relayer's carrier is also mined.
 */
export function relayStuck(entry, height) {
  if (entry?.kind !== "send" || entry.via !== "relay" || entry.status !== "relaying" || entry.relayStatus !== "broadcast") return false;
  const from = entry.broadcastHeight ?? entry.sentHeight;
  return Number.isSafeInteger(height) && Number.isSafeInteger(from) && height >= from + STUCK_AFTER;
}

/**
 * The retry buttons an entry offers at `height`: "relay" (same notes, through the
 * relayer), "next-batch", "next-block", "self" (pay the fee yourself), "copy" (the
 * envelope). An overdue batch is still held by the relayer, which would refuse a relay
 * retry (nullifier_pending). Views drop "copy" once the envelope is gone, and every
 * relay choice while relaying is unavailable (relay.js relayOpen). A copied envelope,
 * and a relayed send no relayer will send (relayStranded), offer paying the fee
 * yourself and copying the envelope. A send the relayer missed (status "missed": its
 * balance or the fee cap) offers the next batch (batch modes), the next block, paying
 * the fee yourself and copying; a stuck carrier (relayStuck) only the last two.
 */
export function retryChoices(entry, height) {
  if (entry?.kind !== "send") return [];
  if (entry.status === "copied" || relayStranded(entry)) return ["self", "copy"];
  if (entry.status === "failed" && entry.relayStatus === "missed") return isBatchMode(entry.mode) ? ["next-batch", "next-block", "self", "copy"] : ["next-block", "self", "copy"];
  if (relayStuck(entry, height)) return ["self", "copy"];
  const phase = batchPhase(entry, height);
  if (phase === null) return entry.status === "failed" ? ["relay", "self", "copy"] : [];
  if ((phase === "failed" && entry.status === "failed") || phase === "missed") return ["next-batch", "next-block", "self", "copy"];
  if (phase === "overdue") return ["self", "copy"];
  return [];
}

/* ---------- mining: pure rules (tested in test/mine-web.test.mjs) ---------- */

// W-M statuses in which a claim may still land: its solution is spent on one route, and the
// notes it rolled stay reserved (lockedNullifiers) until lockUntil = ref + 12.
export const MINE_PENDING = new Set(["proving", "submitted"]);
export const MINE_FINAL = new Set(["landed", "rejected", "expired", "dropped"]);
/** Carrier size used for quotes: one P2TR input, one service-fee output and change (mining.md §4.1). */
export const MINE_EST_VSIZE = 684;
/**
 * A self-paid claim pays the next-block rate times this, up front: it is never bumped (§8.8).
 * The one headroom of every route that pays one (L5): funding.mjs FEE_HEADROOM, via headroomRate.
 */
export const MINE_FEE_HEADROOM = FEE_HEADROOM;

/**
 * The wallet's asset list: /api/assets (paid-mint rows, kept as they are) plus the mined
 * assets of /api/mine (`kind: "pow"`, `id` = the asset id), so balances, the portfolio and
 * Send work for mined tokens too. A mined row never replaces a listed one.
 */
export function mergeAssets(assets, mined) {
  const list = Array.isArray(assets) ? [...assets] : [];
  const ids = new Set(list.map((a) => String(a.id)));
  for (const m of Array.isArray(mined?.assets) ? mined.assets : []) {
    const id = String(m.asset ?? m.id ?? "");
    if (!/^\d+$/.test(id) || ids.has(id)) continue;
    ids.add(id);
    list.push({ ...m, id, kind: "pow" });
  }
  return list;
}

/**
 * The service-fee outputs a claim of `asset` pays: [{ script (Uint8Array), sats (bigint),
 * amount (bigint, raised to the dust limit), role }]. The platform's output comes from the
 * pinned MINE_FEE. The deployer's part (claimFeeSats, treasury) is read from the indexer's
 * view, so it is accepted only within the pinned fee policy (checkFeePolicy, the rule every
 * indexer applies to a DEPLOY_POW): terms outside it cannot be a launch any honest indexer
 * accepted, and the wallet refuses to pay them (code "fee_policy"). Under the owner's
 * constants that means claimFeeSats must be 0 and the treasury is never paid.
 */
export function mineFeeOutputs(asset, fee = MINE_FEE) {
  let claimFeeSats;
  let treasury;
  try {
    claimFeeSats = BigInt(asset?.claimFeeSats ?? 0);
    treasury = asset?.treasury ? unhex(String(asset.treasury)) : new Uint8Array();
  } catch {
    throw mineError("fee_policy", "The indexer sent unreadable fee terms for this token. Nothing was paid. Switch indexer if this repeats.");
  }
  const bad = checkFeePolicy(claimFeeSats, treasury, fee);
  if (bad) {
    throw mineError("fee_policy", `The indexer says this token's claims pay its launcher ${claimFeeSats} sats, which the pinned fee policy forbids (${bad.replace(/^malformed: /, "")}). Nothing was paid. Switch indexer (Settings): this one may be wrong or hostile.`);
  }
  const terms = claimFeeSats > 0n ? { claimFeeSats, treasury } : { claimFeeSats: 0n };
  return requiredFeeOutputs(terms, fee).map((o) => ({ ...o, amount: carrierAmountOf(o.script, o.sats) }));
}

/**
 * What one claim costs now, by route (mining.md §12.1): { route, feeSats, serviceSats, marginSats, total }.
 *   relay   info.mine.carrierFeeSats + service + info.mine.marginSats (the relayer's quote)
 *   key / unisat   684 vB x ceil(next-block rate x 1.25) + service
 * null while the rate (or the relayer's quote) is unknown.
 */
export function mineQuote({ route, feeRate = null, relayMine = null, serviceSats = 0n }) {
  const service = BigInt(serviceSats);
  if (route === "relay") {
    const fee = relayMine?.carrierFeeSats;
    const margin = relayMine?.marginSats ?? 0;
    if (!Number.isSafeInteger(fee) || fee < 0) return null;
    return { route, feeSats: BigInt(fee), serviceSats: service, marginSats: BigInt(margin), total: BigInt(fee) + service + BigInt(margin) };
  }
  if (!Number.isFinite(Number(feeRate)) || Number(feeRate) <= 0) return null;
  const fee = BigInt(MINE_EST_VSIZE * headroomRate(feeRate));
  return { route, feeSats: fee, serviceSats: service, marginSats: 0n, total: fee + service };
}

/**
 * Blocks a found solution still has before it can no longer be paid for on `route`, at tip
 * `tip` (negative: too late). A claim lands at H <= ref + 12. The relayer signs only while
 * tip <= ref + 9 (MINE_SLACK); a self-paid claim is refused once fewer than two blocks
 * remain, since it lands at the earliest in the next block.
 */
export function mineWindowLeft(ref, tip, route) {
  const last = route === "relay" ? ref + MINE_WINDOW - 1 - MINE_SLACK : ref + MINE_WINDOW - 2;
  return last - tip;
}

/**
 * Status of a mining claim entry (kind "mine") from data every wallet downloads in full,
 * plus the relayer's status for one it holds:
 *   landed    its output commitments are in the pool
 *   rejected  the bulk log (or the relayer) has a failed verdict for its carrier
 *   expired   tip > lockUntil (ref + 12) and not landed: it can never land; rolled notes come free
 *   dropped   the relayer dropped it before paying for it (the charge came back)
 *   submitted handed to Bitcoin or the relayer, no verdict yet; proving: still being proved
 */
export function deriveMineStatus(entry, ctx = {}) {
  const { height = 0, outputs = new Map(), log = new Map(), relay = null } = ctx;
  const hit = (entry.commitments ?? []).map((c) => outputs.get(String(c))).find(Boolean);
  if (hit) return { status: "landed", txid: hit.txid ?? entry.txid ?? null, height: hit.height ?? null, reason: null };
  const txids = [...new Set([entry.txid, ...(entry.txids ?? [])].filter(Boolean))];
  const verdict = txids.map((t) => log.get(t)).find(Boolean) ?? null;
  if (verdict && !verdict.ok) return { status: "rejected", reason: verdict.reason ?? "Rejected by the indexer.", height: verdict.height };
  if (MINE_FINAL.has(entry.status)) return { status: entry.status };
  if (Number.isSafeInteger(entry.lockUntil) && height > entry.lockUntil) {
    return { status: "expired", reason: "Not included within its 12-block window. Its notes can be spent again." };
  }
  if (entry.via === "relay" && relay) {
    switch (relay.status) {
      case "queued":
      case "signing":
      case "broadcast":
      case "accepted":
        return { status: "submitted", relayStatus: relay.status, ...(relay.txid ? { txid: relay.txid } : {}) };
      case "rejected":
        return { status: "rejected", reason: relay.reason ?? "Rejected by the indexer.", txid: relay.txid ?? entry.txid ?? null };
      default: {
        // Charged only when its carrier reached the network (the relayer then reports when and
        // what it cost): a carrier that was broadcast and later vanished, or one that was not
        // confirmed within the window, keeps its charge (I-PAY: a broadcast claim is never refunded).
        const reached = relay.broadcastHeight != null || relay.cost != null;
        const why = relay.reason ? `${String(relay.reason).replace(/[.\s]+$/, "")}. ` : "";
        return reached
          ? { status: "dropped", relayStatus: relay.status, reason: `${why}The relayer sent this claim to Bitcoin${Number.isSafeInteger(relay.cost) ? ` and charged ${int(relay.cost)} sats` : " and charged its fee"}, but it did not land.` }
          : { status: "dropped", relayStatus: relay.status, reason: `${why}The relayer dropped this claim before paying for it, so nothing was charged.` };
      }
    }
  }
  return { status: entry.status === "proving" ? "proving" : "submitted" };
}

/** A refusal before anything leaves the browser: { code } plus a message for the page. */
const mineError = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra });

/**
 * The mining key's coins held by pending claims (W-M): each pending entry's bound coin and,
 * once signed, every coin its carrier spends. "txid:vout" strings.
 */
export function busyMineCoins(history) {
  const busy = new Set();
  for (const h of history ?? []) {
    if (h.kind !== "mine" || !MINE_PENDING.has(h.status)) continue;
    if (h.coin) busy.add(h.coin);
    for (const c of h.inputs ?? []) busy.add(c);
  }
  return busy;
}

/**
 * True only when a self-paid carrier certainly did not reach the network: the explorer answered
 * the broadcast with a 4xx (the node refused it) AND does not know the txid (404). Anything else
 * (a timeout, a 5xx, a lost answer, an explorer that knows the txid) may mean it is in the mempool.
 */
export async function carrierRefused(err, txid, esplora = api.esplora) {
  if (!/:\s*4\d\d\b/.test(String(err?.message ?? ""))) return false;
  try {
    await esplora.tx(txid);
    return false; // the explorer knows it: in the mempool or mined
  } catch (e) {
    return /:\s*404\b/.test(String(e?.message ?? ""));
  }
}

/** The next-block fee rate: mempool.space's fastestFee where it answers, else the backend's estimate. */
export async function nextBlockRate(esplora = api.esplora) {
  try {
    if (typeof esplora.requestUrl === "function" && /\/api$/.test(esplora.base ?? "")) {
      const fees = await (await esplora.requestUrl(esplora.base.replace(/\/api$/, "/api/v1") + "/fees/recommended", "/v1/fees/recommended")).json();
      const rate = Number(fees?.fastestFee);
      if (Number.isFinite(rate) && rate > 0) return Math.max(1, Math.ceil(rate));
    }
  } catch {
    // Not mempool.space, or it failed: the plain estimate below.
  }
  return esplora.feeRate();
}

function notInBatch(plan, height) {
  const text = `The note this send needs arrived after block ${int(plan.start)}, so it can join the batch that starts at block ${int(plan.eligibleAt)} (${eta(plan.eligibleAt - height)}). Or send it with the next block now.`;
  return Object.assign(new Error(text), { code: NOT_IN_BATCH, mode: plan.mode, start: plan.start, eligibleAt: plan.eligibleAt });
}

/* ---------- artifacts: pinned and checked before any proof ---------- */

let artifacts = null;
let vkey = null;

async function sha256Hex(bytes) {
  if (globalThis.crypto?.subtle) return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  return hex(sha256(bytes));
}

const PIN_ERROR = PRE_GENESIS
  ? "Proving key does not match the fingerprint pinned in this build. Don't use this server: reload, or switch indexer (Settings, or /verify#indexer)."
  : "Proving key does not match the one anchored on Bitcoin. Don't use this server: reload, or switch indexer (Settings, or /verify#indexer).";

/** Downloads the wasm and zkey once per page, hashes them and compares with the pins. */
export async function loadArtifacts() {
  if (artifacts) return { ...artifacts, cached: true };
  const [wasm, zkey] = await Promise.all([api.artifact("transaction.wasm"), api.artifact("transaction.zkey")]);
  const [hw, hz] = await Promise.all([sha256Hex(wasm), sha256Hex(zkey)]);
  if ((ARTIFACT_SHA256?.wasm && hw !== ARTIFACT_SHA256.wasm) || (ARTIFACT_SHA256?.zkey && hz !== ARTIFACT_SHA256.zkey)) throw new Error(PIN_ERROR);
  artifacts = { wasm, zkey, bytes: wasm.length + zkey.length };
  return { ...artifacts, cached: false };
}

async function loadVkey() {
  if (vkey) return vkey;
  const bytes = await api.artifact("verification_key.json", { as: "bytes" });
  if (ARTIFACT_SHA256?.vkey && (await sha256Hex(bytes)) !== ARTIFACT_SHA256.vkey) throw new Error(PIN_ERROR);
  vkey = JSON.parse(new TextDecoder().decode(bytes));
  return vkey;
}

/** Groth16 check of an envelope this browser just built, against the pinned key (~20 ms). */
export async function verifyEnvelope(envelope, root) {
  const env = decodeEnvelope(envelope);
  const signals = [root, toField(env.publicAmount), env.publicAsset, env.extDataHash, ...env.nullifiers, ...env.commitments].map(String);
  return snarkjs.groth16.verify(await loadVkey(), signals, decodeProof(env.proof));
}

/* ---------- events ---------- */

const listeners = new Set();
export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(type) {
  for (const fn of [...listeners]) {
    try {
      fn(type, session);
    } catch (e) {
      console.error(e);
    }
  }
}

/** A pending top-up as stored in prefs.relay.pending (no undefined fields, so it seals and compares cleanly). */
/** Address numbers below the last one shown that the wallet looks at under each retired pool key (all of them with `older`). */
const RETIRED_SCAN = 4;

const pendingRow = ({ n, outpoint = null, txid, value, height = null, since = null }) =>
  outpoint ? { n, outpoint, value, height: height ?? null, since: since ?? null } : { n, outpoint: null, txid, value, height: null, since: since ?? null };

/* ---------- the session ---------- */

const localId = () => hex(randomBytes(8));
// Legacy entries have no id; they never change, so their JSON identifies them.
const entryId = (h) => h.id ?? JSON.stringify(h);
const idsOf = (history) => new Set(history.map(entryId));
// JSON with sorted keys: the same data compares equal whatever order its fields were set in.
const canon = (v) =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
/** A copy of the note tree that a sync can grow while the view on screen keeps the original. */
const copyTree = (t) => Object.assign(Object.create(Object.getPrototypeOf(t)), t, { layers: t.layers.map((m) => new Map(m)) });
const NOT_ADDRESS = `That isn't a valid ${BRAND} address. Check it and paste it again.`;
const LOCKED = "The wallet is locked. Unlock it and try again.";
/** The code on a sync's root mismatch error: the same indexer state gives the same mismatch. */
export const ROOT_MISMATCH = "root-mismatch";
// What to do about a root that doesn't match (a sync, or the tree at a batch boundary).
const SYNC_AGAIN = "Sync again, or switch indexer (Settings, or /verify#indexer).";
const CHANGED_ELSEWHERE = "This wallet was changed in another tab (new password, or removed), so this tab locked itself. Unlock it again to continue.";
export const NOTES_TAKEN = "Another tab just used these notes for a send, so nothing was sent from here. Wait for that send to finish, then try again.";
const isUserCancel = (e) => e?.code === 4001 || /reject|cancel|denied/i.test(e?.message ?? "");
/** The anchor of a stored envelope (hex), or null when it doesn't decode. */
function anchorOf(envelopeHex) {
  try {
    return decodeEnvelope(unhex(envelopeHex)).anchor;
  } catch {
    return null;
  }
}

/** Runs fn as a proving-sheet step: onStep({ id, status, detail, ms }). */
async function step(onStep, id, fn, detail = null) {
  const t0 = Date.now();
  onStep({ id, status: "running", detail });
  try {
    const out = await fn();
    onStep({ id, status: "ok", ms: Date.now() - t0, detail: out?.detail ?? detail });
    return out;
  } catch (e) {
    onStep({ id, status: "fail", ms: Date.now() - t0, detail: e.message });
    throw e;
  }
}

export class Session {
  /** The relay account (src/relay-account.mjs): signs balance reads and relayed sends. Never exposed. */
  #relay;
  /** The deposit check in flight (checkDeposits), or null. */
  #depositCheck = null;

  /** { phrase, key, data, vault } from the unlock step. The phrase itself is not kept. */
  constructor({ phrase, key = null, data = keystore.emptyData(), vault = null }) {
    const words = normalizePhrase(phrase);
    const entropy = mnemonicToEntropy(words, wordlist);
    // LABELS.btcFee: murkle/btc-fee on signet (unchanged), murkle/mainnet/btc-fee on mainnet (SPEC.md §2).
    const feeKey = hkdf(sha256, entropy, undefined, LABELS.btcFee, 32);
    if (!secp256k1.utils.isValidSecretKey(feeKey)) throw new Error("This phrase gives an unusable fee key. Generate another phrase.");
    // Self-paid mining claims use their own key (mining.md §12.1): never the key above, which
    // pays transfers and top-ups, so the claims of this wallet never share an address with them.
    let mineFeeKey = null;
    try {
      mineFeeKey = feeKeysOf(entropy).mineFeeKey;
    } catch {
      mineFeeKey = null;
    }
    this.#relay = relayAccount(entropy, NETWORK);
    this.key = key;
    this.vault = vault;
    this.keys = deriveKeys(entropy);
    this.wallet = new Wallet(this.keys, null);
    this.address = encodeAddress(this.wallet.address);
    this.localPayer = new LocalPayer(feeKey);
    this.minePayer = mineFeeKey && secp256k1.utils.isValidSecretKey(mineFeeKey) ? new LocalPayer(mineFeeKey) : null;
    this.mineBtc = null; // { sats, at } of the mining key, only after an explicit check
    this.mineInfo = null; // the last GET /api/mine
    this.mineHeld = new Set(); // notes rolled into found solutions not yet recorded (W-M before the entry exists)
    this.relayPayer = new RelayPayer();
    this.unisat = null;
    this.unisatOff = null; // removes the accountsChanged listener
    this.data = { ...keystore.emptyData(), ...data };
    this.history = Array.isArray(this.data.history) ? this.data.history : [];
    this.prefs = this.data.prefs ?? {};
    this.view = null;
    this.state = null;
    this.assetList = [];
    this.log = new Map(); // txid -> { ok, reason, height, opName }
    this.logItems = []; // compact bulk log, for privacy counts
    this.logCursor = 0;
    this.lastSync = null;
    this.btc = null; // { sats, at } only after an explicit check
    this.relayInfo = null;
    this.relayBalance = null; // { balance, reserved, nextIndex, credits, at } after a signed read
    this.relayDeposits = []; // the last checkDeposits() result, for the top-up sheet
    this.topUpOpen = false; // the top-up sheet is open: deposits are looked up once per block
    this.relayWork = Promise.resolve(); // the last automatic relay step (tests await it)
    this.relayTickHeight = null;
    this.busy = 0;
    this.syncing = null;
    this.closed = false;
    // The vault JSON this tab last read or wrote, the history ids and the data it held:
    // how pull() tells another tab's writes apart from this tab's own changes, and how
    // persist() skips writing what is already stored.
    this.stored = vault ? JSON.stringify(vault) : null;
    this.storedIds = idsOf(this.history);
    this.storedData = vault ? canon(this.data) : null;
    entropy.fill(0);
  }

  /**
   * Seals history and prefs into the vault (new nonce) and writes it, after folding in
   * other tabs' writes. No write when the vault already holds exactly this data (say, a
   * status another tab derived from the same block and wrote first).
   */
  persist(prefs = null) {
    if (this.closed) throw new Error(LOCKED);
    if (!this.key || !this.vault) return;
    this.pull();
    if (prefs) Object.assign(this.prefs, prefs);
    this.data = { ...this.data, history: this.history, prefs: this.prefs };
    const data = canon(this.data);
    if (data === this.storedData) return;
    const vault = keystore.withData(this.vault, this.key, this.data);
    this.stored = keystore.writeVault(storage, STORAGE_PREFIX, vault); // throws STORAGE_FULL when refused
    this.vault = vault;
    this.storedIds = idsOf(this.history);
    this.storedData = data;
  }

  /**
   * Another tab may have written the vault since this one last did. Folds those
   * writes in and returns true when that changed this tab's history or prefs, false
   * otherwise. Locks this session and throws when the wallet was removed, replaced
   * or re-keyed there.
   */
  pull() {
    if (!this.key || !this.vault) return false;
    const raw = storage.getItem(VAULT_KEY);
    if (raw === this.stored) return false;
    const before = canon([this.history, this.prefs]);
    if (this.absorb(raw)) return canon([this.history, this.prefs]) !== before;
    if (session === this) lock("elsewhere");
    else this.dispose();
    throw new Error(CHANGED_ELSEWHERE);
  }

  /**
   * Merges a vault written by another tab with the same password. Entries new
   * there are added, entries it removed go, and an entry it changed through
   * record/update (higher rev) replaces this tab's copy in place. False when the
   * vault is gone, belongs to another wallet or was re-encrypted.
   */
  absorb(raw) {
    let vault = null;
    try {
      vault = JSON.parse(raw);
    } catch {}
    if (!vault?.kdf || vault.kdf.salt !== this.vault.kdf?.salt) return false;
    let data;
    try {
      data = keystore.openData(this.key, vault);
    } catch {
      return false;
    }
    const theirs = new Map((data.history ?? []).map((h) => [entryId(h), h]));
    const mine = new Map(this.history.map((h) => [entryId(h), h]));
    // Only here: new in this tab (keep) or removed there (drop). Only there: new there, or removed here.
    const next = this.history.filter((h) => theirs.has(entryId(h)) || !this.storedIds.has(entryId(h)));
    for (const [id, t] of theirs) {
      const m = mine.get(id);
      if (!m) {
        if (!this.storedIds.has(id)) next.push(t);
      } else if ((t.rev ?? 0) > (m.rev ?? 0)) {
        for (const k of Object.keys(m)) if (!(k in t)) delete m[k];
        Object.assign(m, t);
      }
    }
    next.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
    this.history = next;
    this.prefs = { ...this.prefs, ...data.prefs };
    this.data = { ...this.data, ...data, history: this.history, prefs: this.prefs };
    this.vault = vault;
    this.stored = raw;
    this.storedIds = new Set(theirs.keys());
    this.storedData = canon(data);
    // Notes the other tab handed out are reserved here too (W-1).
    if (this.view) this.wallet.locked = lockedNullifiers(this.history, this.view.height, this.view.nullifiers);
    return true;
  }

  dispose() {
    this.closed = true;
    this.dropUnisat(); // the extension's listener would keep this session alive
    this.#relay?.secret?.fill?.(0);
    this.relayBalance = null;
    this.relayDeposits = [];
    this.key?.fill?.(0);
    this.key = null;
    this.vault = null;
    this.history = [];
    this.data = keystore.emptyData();
    this.view = null;
    this.wallet.notes = [];
  }

  /* ----- preferences (plain keys; not secret) ----- */

  get payerPref() {
    // Wallets migrated by an earlier build kept the old choice only in the vault prefs.
    return (storage.getItem(KEY.payer) ?? this.prefs?.payer) === "unisat" ? "unisat" : "local";
  }
  set payerPref(kind) {
    storage.setPref(KEY.payer, kind === "unisat" ? "unisat" : "local");
  }
  /**
   * How private sends go: "self" (pay the fee yourself, always the default), "copy" (copy
   * the envelope), or "relay" (from the relay balance) once the user chose it, and only
   * while a relay-balance relayer runs (relay.js relayOpen); otherwise it reads "self".
   * The Send form also falls back to "self" while the balance can't pay (routeState).
   */
  get routePref() {
    const v = storage.getItem(KEY.route);
    if (v === "copy") return v;
    return v === "relay" && relayOpen() ? "relay" : "self";
  }
  set routePref(v) {
    storage.setPref(KEY.route, v === "copy" ? "copy" : v === "relay" ? "relay" : "self");
  }
  /** Relay timing for payments: "block" (default) or "fast". A batch pick is never stored. */
  get relayModePref() {
    return storage.getItem(KEY.relayMode) === "fast" ? "fast" : "block";
  }
  set relayModePref(v) {
    if (v === "block" || v === "fast") storage.setPref(KEY.relayMode, v);
  }
  /**
   * Relay timing for merges and refreshes (sends to this wallet): any mode, default the
   * hourly batch. A saved "batch12" (the retired 12-hour batch) reads as the 10-hour batch.
   */
  get selfModePref() {
    const v = savedMode(storage.getItem(KEY.selfMode));
    return isMode(v) ? v : "batch";
  }
  set selfModePref(v) {
    if (isMode(v)) storage.setPref(KEY.selfMode, v);
  }
  /** The relay timing a send to `to` starts on. */
  defaultMode(to) {
    return String(to ?? "").trim() === this.address ? this.selfModePref : this.relayModePref;
  }

  /** The payer for mints, launches and self-paid sends. */
  ownPayer() {
    if (this.payerPref === "unisat") {
      if (!this.unisat) throw new Error("Choose a fee payer: built-in key or Unisat. Unisat is selected but not connected; connect it in Settings.");
      return this.unisat;
    }
    return this.localPayer;
  }

  async connectUnisat() {
    const payer = await new UnisatPayer().connect();
    if (this.closed) throw new Error(LOCKED); // locked during the Unisat popup
    // Another Unisat account would pay from coins a mint isn't bound to: connect again.
    this.unisatOff?.();
    this.unisatOff = payer.onAccountChange(() => {
      if (this.unisat !== payer) return;
      this.dropUnisat();
      emit("payer");
    });
    this.unisat = payer;
    this.payerPref = "unisat";
    emit("payer");
    return this.unisat;
  }

  dropUnisat() {
    this.unisatOff?.();
    this.unisatOff = null;
    this.unisat = null;
  }

  /** Built-in key balance from mempool.space. Only on explicit request or right before paying. */
  async checkBtc() {
    const sats = await this.localPayer.balance(api.esplora);
    this.btc = { sats, at: Date.now() };
    emit("btc");
    return sats;
  }

  /** Relay info (GET /api/relay/info, the same for every wallet); opens or closes the relay route. */
  async loadRelayInfo() {
    try {
      this.relayInfo = await api.relay.info();
    } catch (e) {
      this.relayInfo = { enabled: false, reason: "network", error: e.message };
    }
    setRelayRoute(this.relayInfo);
    emit("relay");
    return this.relayInfo;
  }

  /* ----- relay balance (relay-balance-contract.md §5.3) ----- */

  /** The public half of the relay account. The secret never leaves this session. */
  get relayAccount() {
    return { pubHex: this.#relay.pubHex, idHex: this.#relay.idHex };
  }

  /** prefs.relay of the relayer in use, sealed in the vault: { depositIndex, pending: [{ n, outpoint, value, height }], poolKey }, or null. */
  get relayPrefs() {
    return this.#relayRec();
  }

  /** The pool key of the relayer the relay info is from, or null. */
  #poolKey() {
    const k = this.relayInfo?.balance?.poolKey;
    return typeof k === "string" && k ? k : null;
  }

  /**
   * Deposit addresses come from a relayer's pool key, so top-ups are tracked per relayer:
   * prefs.relay holds the record of the relayer last used (its poolKey), and the records
   * of others wait in prefs.relayBy[poolKey]. A deposit made to one relayer is never
   * looked up, credited or dropped at another. A record without poolKey predates this
   * and belongs to the relayer in use.
   */
  #relayRec() {
    const r = this.prefs?.relay ?? null;
    const pk = this.#poolKey();
    if (!r || !pk || !r.poolKey || r.poolKey === pk) return r;
    return this.prefs?.relayBy?.[pk] ?? null;
  }

  /** Folds other tabs' writes in, then stores the relay record of the relayer in use with `patch` applied. */
  #saveRelay(patch) {
    this.pull();
    const pk = this.#poolKey();
    let cur = this.prefs.relay ?? null;
    if (cur && pk && cur.poolKey && cur.poolKey !== pk) {
      const by = { ...(this.prefs.relayBy ?? {}), [cur.poolKey]: cur };
      cur = by[pk] ?? null;
      delete by[pk];
      this.prefs.relayBy = by;
    }
    this.prefs.relay = { depositIndex: 0, pending: [], ...(cur ?? {}), ...patch, ...(pk ? { poolKey: pk } : {}) };
    this.persist();
  }

  /**
   * The deposit address number the next top-up goes to: one past the highest address
   * that has received a payment, as this wallet or the relayer knows it. An unpaid
   * address is never skipped, so a restore only needs the relayer's nextIndex.
   */
  get depositIndex() {
    const r = this.#relayRec() ?? {};
    const paid = [...(r.pending ?? []), ...(this.relayBalance?.credits ?? [])].map((x) => x.n).filter(Number.isSafeInteger);
    return Math.max(Number.isSafeInteger(r.depositIndex) ? r.depositIndex : 0, this.relayBalance?.nextIndex ?? 0, paid.length ? Math.max(...paid) + 1 : 0);
  }

  /** Relay info of a relay-balance relayer, or throws (nothing about the account is looked up then). */
  #openInfo() {
    const i = this.relayInfo;
    if (!relayOpen() || !i?.balance?.poolKey) throw Object.assign(new Error(relayFailure({ code: "disabled" }).message), { code: "disabled" });
    return i;
  }

  /**
   * Deposit address number `n` of this wallet's relay account: { n, address }. Derived here,
   * never asked for, and always on this wallet's network (config.js), whatever the relayer reports.
   */
  depositAddress(n = this.depositIndex) {
    const i = this.#openInfo();
    // While the relayer evacuates its coins, is paused or waits for its new pool, no address is
    // shown at all: its pool key may be in someone else's hands (relay-balance.md §9).
    const rot = relayRotation(i);
    if (!rot.depositsOpen) throw Object.assign(new Error(relayFailure({ code: rot.code }).message), { code: rot.code });
    const d = depositAddressOf(i.balance.poolKey, this.#relay.id, n, NETWORK);
    if (!d.address.startsWith(`${btcNetwork(NETWORK).bech32}1`)) throw new Error(`The deposit address isn't a ${NETWORK} address. Nothing was paid.`);
    return { n, address: d.address };
  }

  /**
   * The signed balance read. The relayer's deposit address for nextIndex must equal this
   * wallet's own derivation, or nothing is stored and it throws.
   */
  async loadRelayBalance({ signal } = {}) {
    if (this.closed) throw new Error(LOCKED);
    const i = this.#openInfo();
    const b = await accountBalance({ account: this.#relay, info: i, signal });
    if (this.closed) throw new Error(LOCKED);
    let mine = null;
    try {
      mine = depositAddressOf(i.balance.poolKey, this.#relay.id, b?.nextIndex, NETWORK).address;
    } catch {}
    if (!mine || b.depositAddress !== mine || (b.accountId != null && b.accountId !== this.#relay.idHex)) {
      throw new Error("The relayer's deposit address doesn't match this wallet. Nothing was paid.");
    }
    const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
    this.relayBalance = { balance: num(b.balance), reserved: num(b.reserved), nextIndex: num(b.nextIndex), credits: Array.isArray(b.credits) ? b.credits : [], at: Date.now() };
    // A wallet restored from its words learns of its balance here: read it on every unlock from now on.
    if (!this.#relayRec() && (this.relayBalance.balance + this.relayBalance.reserved > 0 || this.relayBalance.nextIndex > 0)) {
      this.#saveRelay({ depositIndex: this.relayBalance.nextIndex });
    }
    emit("relay-balance");
    return this.relayBalance;
  }

  /** The chain tip as this wallet knows it (for deposit confirmations). */
  #tip() {
    return Math.max(this.view?.height ?? 0, this.state?.chainTip ?? 0, this.relayInfo?.chainTip ?? 0, this.relayInfo?.height ?? 0);
  }

  /**
   * Looks for payments to deposit address depositIndex, to every address with a payment
   * still waiting, and to every older one with `older`, on mempool.space; then asks the
   * relayer to credit each one with enough confirmations. A payment seen at depositIndex
   * moves the next top-up to a fresh address.
   * -> [{ n, outpoint, value, confirmations, needed, state: "waiting" | "credited" | "small" | "refused", code?, amount? }]
   */
  async checkDeposits({ older = false, signal } = {}) {
    // One look at a time (the sheet's Check now and the block tick may meet): a plain check
    // joins one in flight; a check of older addresses waits for it, then runs.
    const running = this.#depositCheck;
    if (running && !older) return running;
    if (running) await running.catch(() => {});
    const run = this.#checkDeposits({ older, signal });
    this.#depositCheck = run;
    try {
      return await run;
    } finally {
      if (this.#depositCheck === run) this.#depositCheck = null;
    }
  }

  async #checkDeposits({ older, signal }) {
    if (this.closed) throw new Error(LOCKED);
    const i = this.#openInfo();
    const rot = relayRotation(i);
    // Top-ups closed (an evacuation, a pause, a pool not refilled yet): nothing is looked up or
    // credited; the balance is still read (every balance is kept).
    if (!rot.depositsOpen) {
      this.relayDeposits = [];
      try {
        await this.loadRelayBalance({ signal });
      } catch (e) {
        if (this.closed) throw e;
      }
      emit("relay-balance");
      return [];
    }
    const needed = Math.max(1, i.balance.depositConfirmations ?? DEPOSIT_CONFIRMATIONS[NETWORK] ?? 1);
    const min = i.balance.minDepositSats ?? 0;
    const tip = this.#tip();
    const credited = new Set((this.relayBalance?.credits ?? []).map((c) => c.outpoint));
    const r = this.#relayRec() ?? {};
    // Keyed by outpoint; a payment whose output is not known yet (Unisat) by its txid.
    const keyOf = (p) => p.outpoint ?? `tx:${p.txid}`;
    const pending = new Map((r.pending ?? []).map((p) => [keyOf(p), { ...p }]));
    const seen = new Set();
    let index = this.depositIndex;
    const top = index;
    const ns = older ? Array.from({ length: top + 1 }, (_, k) => k) : [...new Set([top, ...[...pending.values()].map((p) => p.n)])].sort((a, b) => a - b);
    for (const n of ns) {
      const { address } = this.depositAddress(n);
      for (const u of (await api.esplora.utxos(address)) ?? []) {
        const outpoint = `${u.txid}:${u.vout}`;
        if (n >= index) index = n + 1;
        seen.add(outpoint);
        pending.delete(`tx:${u.txid}`);
        // Credited already (by another device or tab, or before a reply was saved): it leaves pending.
        if (credited.has(outpoint)) {
          pending.delete(outpoint);
          continue;
        }
        const height = u.status?.confirmed && Number.isSafeInteger(u.status.block_height) ? u.status.block_height : null;
        pending.set(outpoint, { ...(pending.get(outpoint) ?? {}), n, outpoint, txid: undefined, value: Number(u.value), height, since: pending.get(outpoint)?.since ?? tip });
      }
    }
    if (this.closed) throw new Error(LOCKED);
    // A pending payment the relayer has credited already (it may be spent by now, so no scan sees it) leaves too.
    for (const [key, p] of pending) if (p.outpoint && credited.has(p.outpoint)) pending.delete(key);
    const out = [];
    for (const [key, p] of pending) {
      const confirmations = p.height != null && tip >= p.height ? tip - p.height + 1 : 0;
      const row = { n: p.n, outpoint: p.outpoint ?? null, value: p.value, confirmations, needed };
      // A payment never seen for a day (replaced, or never broadcast) stops being looked for.
      if (p.height == null && !seen.has(p.outpoint) && Number.isSafeInteger(p.since) && tip - p.since > 144) {
        pending.delete(key);
        continue;
      }
      if (Number.isSafeInteger(p.value) && p.value < min) {
        out.push({ ...row, state: "small" });
        pending.delete(key);
        continue;
      }
      if (!p.outpoint || confirmations < needed) {
        out.push({ ...row, state: "waiting" });
        continue;
      }
      try {
        const c = await creditDeposit({ outpoint: p.outpoint, accountPub: this.#relay.pubHex, n: p.n, signal });
        out.push({ ...row, state: "credited", amount: c?.amount ?? null, already: Boolean(c?.already) });
        pending.delete(key);
      } catch (e) {
        const code = e?.code ?? null;
        if (code === "deposit_small") {
          out.push({ ...row, state: "small", code });
          pending.delete(key);
        } else if (code === "deposit_mismatch" || code === "deposit_own" || code === "already_credited" || code === "bad_outpoint") {
          out.push({ ...row, state: "refused", code, message: relayFailure(e).message });
          pending.delete(key);
        } else {
          // Not confirmed for the relayer yet, the explorer is behind, or the relayer is busy: next block.
          const conf = code === "deposit_unconfirmed" && Number.isSafeInteger(e.confirmations) ? { confirmations: e.confirmations, needed: e.needed ?? needed } : {};
          out.push({ ...row, ...conf, state: "waiting", code });
        }
      }
      if (this.closed) throw new Error(LOCKED);
    }
    const next = { depositIndex: index, pending: [...pending.values()].map(pendingRow) };
    // Nothing is stored for a wallet that found nothing: it stays one that never topped up.
    if (canon(next) !== canon({ depositIndex: r.depositIndex ?? 0, pending: (r.pending ?? []).map(pendingRow) })) this.#saveRelay(next);
    // Top-ups this wallet paid to an address of a pool key the relayer has since retired.
    for (const pk of rot.retired) out.push(...(await this.#creditRetired(pk, { needed, older, signal })));
    this.relayDeposits = out;
    try {
      await this.loadRelayBalance({ signal });
    } catch (e) {
      if (this.closed) throw e;
    }
    emit("relay-balance");
    return out;
  }

  /**
   * Payments to an address of a pool key the relayer retired (relay-balance.md §9): those still
   * pending in that key's record, and any payment found at the address numbers this wallet showed
   * under that key, made from anywhere (another wallet, an exchange): the record's last one and
   * the few below it, every one with `older`. No address of that key is shown again. Each confirmed
   * payment is asked to be credited: the relayer records it and answers deposit_retired until its
   * operator has moved the coin into the new pool, then credits it; a credited or refused one
   * leaves the record. -> rows as #checkDeposits gives them, with `retired: true`
   */
  async #creditRetired(pk, { needed, older = false, signal }) {
    this.pull();
    const recOf = () => (this.prefs?.relay?.poolKey === pk ? this.prefs.relay : this.prefs?.relayBy?.[pk]) ?? null;
    const rec = recOf() ?? {};
    const tip = this.#tip();
    const credited = new Set((this.relayBalance?.credits ?? []).map((c) => c.outpoint));
    const keyOf = (p) => p.outpoint ?? `tx:${p.txid}`;
    const pending = new Map((rec.pending ?? []).map((p) => [keyOf(p), { ...p }]));
    const seen = new Set();
    // The address number this wallet showed last under that key; a wallet restored since has no
    // record of it, and the account's numbers carried over, so its current one bounds them.
    const last = Number.isSafeInteger(rec.depositIndex) ? rec.depositIndex : this.depositIndex;
    const top = older ? Math.max(last, this.depositIndex) : last;
    const ns = new Set([...(rec.pending ?? []).map((p) => p.n).filter(Number.isSafeInteger)]);
    for (let n = older ? 0 : Math.max(0, last - RETIRED_SCAN); n <= top; n++) ns.add(n);
    for (const n of [...ns].sort((x, y) => x - y)) {
      const d = depositAddressOf(pk, this.#relay.id, n, NETWORK);
      if (!d.address.startsWith(`${btcNetwork(NETWORK).bech32}1`)) continue;
      for (const u of (await api.esplora.utxos(d.address)) ?? []) {
        const outpoint = `${u.txid}:${u.vout}`;
        seen.add(outpoint);
        pending.delete(`tx:${u.txid}`);
        if (credited.has(outpoint)) {
          pending.delete(outpoint);
          continue;
        }
        const height = u.status?.confirmed && Number.isSafeInteger(u.status.block_height) ? u.status.block_height : null;
        pending.set(outpoint, { ...(pending.get(outpoint) ?? {}), n, outpoint, txid: undefined, value: Number(u.value), height, since: pending.get(outpoint)?.since ?? tip });
      }
      if (this.closed) throw new Error(LOCKED);
    }
    const out = [];
    for (const [key, p] of pending) {
      const confirmations = p.height != null && tip >= p.height ? tip - p.height + 1 : 0;
      const row = { n: p.n, outpoint: p.outpoint ?? null, value: p.value, confirmations, needed, retired: true };
      if (p.outpoint && credited.has(p.outpoint)) {
        pending.delete(key);
        continue;
      }
      // A payment never seen for a day (replaced, or never broadcast) stops being looked for.
      if (p.height == null && !seen.has(p.outpoint) && Number.isSafeInteger(p.since) && tip - p.since > 144) {
        pending.delete(key);
        continue;
      }
      // Asked for once it is confirmed (or when it was saved before this wallet tracked heights).
      if (!p.outpoint || (p.height != null && confirmations < needed) || (p.height == null && seen.has(p.outpoint))) {
        out.push({ ...row, state: "waiting" });
        continue;
      }
      try {
        const c = await creditDeposit({ outpoint: p.outpoint, accountPub: this.#relay.pubHex, n: p.n, signal });
        out.push({ ...row, state: "credited", amount: c?.amount ?? null, already: Boolean(c?.already) });
        pending.delete(key);
      } catch (e) {
        const code = e?.code ?? null;
        if (code === "deposit_mismatch" || code === "deposit_own" || code === "already_credited" || code === "bad_outpoint" || code === "deposit_small") {
          out.push({ ...row, state: "refused", code, message: relayFailure(e).message });
          pending.delete(key);
        } else out.push({ ...row, state: "waiting", code, message: code === "deposit_retired" ? relayFailure(e).message : undefined });
      }
      if (this.closed) throw new Error(LOCKED);
    }
    const next = [...pending.values()].map(pendingRow);
    this.pull();
    const cur = recOf();
    if (cur) {
      if (canon(next) !== canon((cur.pending ?? []).map(pendingRow))) {
        cur.pending = next;
        this.persist();
      }
    } else if (next.length) {
      this.prefs.relayBy = { ...(this.prefs.relayBy ?? {}), [pk]: { depositIndex: last, pending: next, poolKey: pk } };
      this.persist();
    }
    return out;
  }

  /**
   * A top-up this wallet just paid to deposit address `n` (built-in key or Unisat): it is
   * looked for, and credited, once per block until it is, and the next top-up goes to a
   * fresh address. `vout` is null when the wallet that paid does not say (Unisat).
   */
  recordTopUp({ n, txid, vout = null, value }) {
    if (!Number.isSafeInteger(n) || !/^[0-9a-f]{64}$/.test(String(txid))) throw new Error("Not a top-up this wallet can track.");
    const r = this.#relayRec() ?? {};
    const p = { n, outpoint: Number.isSafeInteger(vout) ? `${txid}:${vout}` : null, txid: Number.isSafeInteger(vout) ? undefined : txid, value, height: null, since: this.#tip() };
    const rest = (r.pending ?? []).filter((x) => (x.outpoint ?? `tx:${x.txid}`) !== (p.outpoint ?? `tx:${txid}`));
    this.#saveRelay({ depositIndex: Math.max(this.depositIndex, n + 1), pending: [...rest, pendingRow(p)] });
    emit("relay-balance");
  }

  /**
   * After each sync, at most once per new block (relay-balance-contract.md §5.3): credit
   * waiting deposits while a payment is pending or the top-up sheet is open, else read
   * the balance on unlock (once prefs.relay exists) and while it holds anything. A wallet
   * that never topped up makes no account or deposit lookups.
   */
  async #relayTick() {
    const h = this.view?.height;
    if (h == null || this.closed || this.relayTickHeight === h) return;
    const r = this.#relayRec();
    const deposits = Boolean(r?.pending?.length) || this.topUpOpen;
    const b = this.relayBalance;
    const read = (r && !b) || (b && b.balance + b.reserved > 0);
    if (!deposits && !read) return;
    this.relayTickHeight = h;
    if (!this.relayInfo || this.relayInfo.error) await this.loadRelayInfo();
    if (!relayOpen() || this.closed) return;
    if (deposits) await this.checkDeposits();
    else await this.loadRelayBalance();
  }

  /** Runs the automatic relay step in the background; relayWork settles when it is done. */
  relayTick() {
    this.relayWork = this.#relayTick().catch(() => {});
    return this.relayWork;
  }

  /* ----- sync ----- */

  sync() {
    this.syncing ??= this.#sync().finally(() => (this.syncing = null));
    return this.syncing;
  }

  async #sync(retry = true) {
    if (this.closed) throw new Error(LOCKED); // a page still up after a lock: nothing to download
    const t0 = Date.now();
    const state = await api.state({ fresh: true });
    // The next view is built off to the side and swapped in once its root checks out: a
    // repaint meanwhile, and a failed or mismatched sync, keep the last verified view.
    const cur = this.view;
    const base = retry && cur && state.outputs >= cur.outputs.length && state.startHeight === cur.startHeight ? cur : null;
    const have = base ? base.outputs.length : 0;
    const fresh = state.outputs > have ? await api.outputs({ from: have, to: state.outputs }) : [];
    const next = base
      ? { ...base, tree: fresh.length ? copyTree(base.tree) : base.tree, outputs: fresh.length ? base.outputs.slice() : base.outputs }
      : { startHeight: state.startHeight, tree: new MerkleTree(), outputs: [], nullifiers: new Set(), height: 0 };
    for (const o of fresh) {
      next.tree.insert(BigInt(o.commitment));
      next.outputs.push({ ...o, commitment: BigInt(o.commitment), ciphertext: unhex(o.ciphertext) });
    }
    const localRoot = next.tree.root().toString();
    const check = { root: state.root, localRoot, height: state.height, commitments: state.outputs, ms: Date.now() - t0 };
    if (localRoot !== state.root) {
      // An incremental view can go stale after a reorg; rebuild once from scratch before calling it a mismatch.
      if (have > 0) return this.#sync(false);
      setRootStatus({ state: "mismatch", ...check });
      throw Object.assign(new Error(`Root mismatch: the tree rebuilt in your browser differs from the indexer's. ${SYNC_AGAIN}`), { code: ROOT_MISMATCH });
    }
    next.height = state.height;
    next.nullifiers = new Set(await api.nullifiers());
    const [assets, mined] = await Promise.all([api.assets({ fresh: true }), api.mine({ fresh: true }).catch(() => null)]);
    await this.pullLog();
    if (this.closed) throw new Error(LOCKED); // locked meanwhile: no notes are decrypted again
    this.view = next;
    this.assetList = mergeAssets(assets, mined);
    this.mineInfo = mined && Array.isArray(mined.assets) ? mined : null;
    this.state = state;
    this.wallet.scan(next);
    this.wallet.locked = lockedNullifiers(this.history, next.height, next.nullifiers);
    setRootStatus({ state: "match", ...check, error: null });
    this.pull();
    // The relay route opens with relay info, which the first sync after a page load has not
    // read yet. A relayed send still in flight needs it before the history is read: else a
    // scheduled batch send would be looked up before its release, and shown as stranded.
    if (!relayOpen() && relayAnnounced(state) && (!this.relayInfo || this.relayInfo.error) && this.history.some((h) => h.via === "relay" && h.relayId && !FINAL_STATUSES.has(h.status))) {
      await this.loadRelayInfo();
      if (this.closed) throw new Error(LOCKED);
    }
    await this.refreshHistory();
    this.wallet.locked = lockedNullifiers(this.history, next.height, next.nullifiers);
    this.lastSync = Date.now();
    emit("sync");
    this.relayTick();
  }

  /**
   * The indexer changed (Settings, /verify#indexer): nothing read from the old one stays.
   * Its verdicts, log cursor and relay info (pool key, deposit addresses) are dropped, and
   * the relay route closes until the new server's relay info is read.
   */
  indexerChanged() {
    this.log.clear();
    this.logItems = [];
    this.logCursor = 0;
    this.logBase = api.indexerBase();
    this.relayInfo = null;
    this.relayBalance = null;
    this.relayDeposits = [];
    this.relayTickHeight = null;
    this.view = null;
    setRelayRoute(null);
    emit("relay");
  }

  /** Bulk log download from the last cursor; filtered locally, never per txid. */
  async pullLog() {
    // The log is per indexer (like pool-data.js): one read from another server starts over.
    if (this.logBase !== undefined && this.logBase !== api.indexerBase()) {
      this.log.clear();
      this.logItems = [];
      this.logCursor = 0;
    }
    this.logBase = api.indexerBase();
    let from = this.logCursor;
    for (let guard = 0; guard < 10_000; guard++) {
      const page = await api.log({ from, limit: 500 });
      if (page.total != null && page.total < this.logCursor) {
        // The indexer rolled back past our cursor: start over.
        this.log.clear();
        this.logItems = [];
        this.logCursor = from = 0;
        continue;
      }
      for (const e of page.items ?? []) {
        const c = { height: e.height, txid: e.txid, ok: e.ok, opName: e.opName, reason: e.reason ?? null };
        this.logItems.push(c);
        if (e.txid) this.log.set(e.txid, c);
      }
      from += (page.items ?? []).length;
      this.logCursor = from;
      if (page.next === null || page.next === undefined || !(page.items ?? []).length) break;
      from = page.next;
    }
  }

  async refreshHistory() {
    const outputs = new Map(this.view.outputs.map((o) => [o.commitment.toString(), o]));
    const ctx = { height: this.view.height, nullifiers: this.view.nullifiers, outputs, log: this.log, assets: this.assetList };
    let changed = false;
    // Open, or announced by /api/state while relay info could not be read: a relayer runs and
    // will send scheduled batch items at their release, so none is looked up or stranded early.
    const open = relayOpen() || relayAnnounced(this.state);
    for (const h of this.history) {
      if (h.era === "legacy") continue;
      if (h.kind === "mine") {
        changed = (await this.#refreshClaim(h, ctx)) || changed;
        continue;
      }
      let next = deriveStatus(h, ctx);
      // A scheduled batch send: bulk data only until its batch goes out (no per-id call).
      // While relaying is closed no batch goes out, so the server is asked at once: it
      // answers "dropped" for every id the retired relayer held (paid-relay.md §12).
      const waiting = open && isBatchMode(h.mode) && this.view.height < releaseOf(h);
      if (h.via === "relay" && h.relayId && !waiting && !FINAL_STATUSES.has(next.status)) {
        try {
          next = deriveStatus(h, { ...ctx, relay: await api.relay.status(h.relayId) });
        } catch (e) {
          // 404: the relayer pruned or never kept it; the bulk data still decides. While
          // relaying is closed nobody else holds it either, so it fails (notes stay reserved).
          if (e?.status !== 404) next = { status: h.status };
          else if (next.status === "relaying" && relayStranded(h, open)) next = { status: "failed", relayStatus: "dropped", reason: STRANDED_REASON };
        }
      }
      for (const [k, v] of Object.entries(next)) {
        if (v !== undefined && h[k] !== v) {
          h[k] = v;
          changed = true;
        }
      }
      if (h.txid && !(h.txids ?? []).includes(h.txid)) h.txids = [...(h.txids ?? []), h.txid];
      // The envelope is kept only while a retry or a copy may still be needed.
      if (h.envelope && (h.status === "accepted" || h.status === "expired" || h.status === "rejected")) {
        delete h.envelope;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** refreshHistory for one mining claim entry (W-M): true when it changed. */
  async #refreshClaim(h, ctx) {
    let next = deriveMineStatus(h, ctx);
    if (h.via === "relay" && h.relayId && !MINE_FINAL.has(next.status)) {
      try {
        next = deriveMineStatus(h, { ...ctx, relay: await api.relay.status(h.relayId) });
      } catch {
        // Unknown to the relayer (pruned) or unreachable: the bulk data decides.
      }
    }
    let changed = false;
    for (const [k, v] of Object.entries(next)) {
      if (v !== undefined && h[k] !== v) {
        h[k] = v;
        changed = true;
      }
    }
    if (h.txid && !(h.txids ?? []).includes(h.txid)) {
      h.txids = [...(h.txids ?? []), h.txid];
      changed = true;
    }
    return changed;
  }

  /* ----- reads used by the views ----- */

  asset(idOrTicker) {
    const k = String(idOrTicker).toUpperCase();
    return this.assetList.find((a) => a.id === String(idOrTicker) || a.ticker === k) ?? null;
  }

  available(assetId) {
    const id = BigInt(assetId);
    return this.wallet.notes.filter((n) => !n.spent && n.asset === id && !this.wallet.locked.has(String(n.nullifier))).reduce((s, n) => s + n.amount, 0n);
  }

  /** Assets with this wallet's balance; held ones first. */
  assets() {
    return this.assetList
      .map((a) => ({ ...a, balance: this.wallet.balance(BigInt(a.id)), available: this.available(a.id), open: a.status === "live" }))
      .sort((x, y) => (y.balance > 0n) - (x.balance > 0n));
  }

  /** Unspent notes with their public context (height, txid, mint origin). */
  notes() {
    const own = new Map(this.history.filter((h) => h.kind === "mint").flatMap((h) => (h.commitments ?? []).map((c) => [String(c), h])));
    return this.wallet.notes
      .filter((n) => !n.spent)
      .map((n) => {
        const o = this.view?.outputs[n.leafIndex];
        const a = this.assetList.find((x) => x.id === n.asset.toString());
        return {
          ...n, height: o?.height ?? null, txid: o?.txid ?? null, commitment: o?.commitment?.toString() ?? null,
          ticker: a?.ticker ?? "?", div: a?.divisibility ?? 0, mint: own.has(o?.commitment?.toString()),
          locked: this.wallet.locked.has(String(n.nullifier)),
        };
      });
  }

  /** History plus notes received from others (found by trial decryption, never reported anywhere). */
  activity() {
    const ownCommitments = new Set(this.history.flatMap((h) => (h.commitments ?? []).map(String)));
    const received = [];
    for (const n of this.wallet.notes) {
      const o = this.view?.outputs[n.leafIndex];
      if (!o || ownCommitments.has(o.commitment.toString())) continue;
      const a = this.assetList.find((x) => x.id === n.asset.toString());
      received.push({
        id: `r${n.leafIndex}`, kind: "receive", status: "accepted", txid: o.txid, height: o.height, ticker: a?.ticker ?? "?",
        amount: n.amount.toString(), div: a?.divisibility ?? 0, leafIndex: n.leafIndex, spent: n.spent,
      });
    }
    const all = [...this.history, ...received];
    const h = (x) => x.height ?? (x.status === "accepted" ? 0 : Infinity);
    return all.sort((a, b) => h(b) - h(a) || (b.time ?? 0) - (a.time ?? 0));
  }

  /** Mints and launches paid from `address`, for the linkage warning. */
  paidFrom(address) {
    return this.history.filter((h) => (h.kind === "mint" || h.kind === "deploy") && h.payerAddress === address && h.status !== "rejected");
  }

  /**
   * What a send through `via` would link (features #2, relayer.md §4.8). Returns
   * [{ kind: "linked" | "recent-mint" | "recent-deposit", address, ticker, height, landedSince }].
   */
  linkage(via) {
    const height = this.view?.height ?? 0;
    if (via === "relay") {
      const out = [];
      const recent = this.history.find((h) => h.kind === "mint" && h.status === "accepted" && h.height != null && height - h.height < 3);
      if (recent) out.push({ kind: "recent-mint", ticker: recent.ticker, height: recent.height });
      // relay-balance.md §5: while few relayed transfers have landed since the newest top-up
      // confirmed, a relayed send now is easy to tie to the address that paid it.
      const heights = (this.relayBalance?.credits ?? []).map((c) => c?.height).filter(Number.isSafeInteger);
      // landed144 covers the relayer's last 144 blocks only: the count is exact, and the
      // top-up recent, only for a credit inside that window. An older one is never warned about.
      const top = Number.isSafeInteger(this.relayInfo?.height) ? this.relayInfo.height : height;
      if (heights.length && Math.max(...heights) >= top - 144) {
        const newest = Math.max(...heights);
        const landed = this.relayInfo?.stats?.landed144;
        const landedSince = Array.isArray(landed) ? landed.filter(([h]) => h > newest).reduce((s, [, c]) => s + (Number(c) || 0), 0) : 0;
        if (landedSince < RECENT_DEPOSIT_LANDED) out.push({ kind: "recent-deposit", height: newest, landedSince });
      }
      return out;
    }
    let address;
    try {
      address = this.ownPayer().address;
    } catch {
      return [];
    }
    return this.paidFrom(address).map((h) => ({ kind: "linked", address, ticker: h.ticker, height: h.height ?? null, what: h.kind }));
  }

  /**
   * The effective crowd of a relayed or batch send (privacy-trace-test.md L3), from public
   * data this wallet already holds: candidate notes are the value-bearing leaves of other
   * people in the tree at the proof's anchor (`leaves`: the tree size there; the tip's by
   * default, a batch plan's `leaves` for a batch), this wallet's own notes excluded; the batch
   * crowd is the relayer's published waiting count plus this transfer (`queued`: that count
   * for the batch this send joins; by default relay info's current one). -> crowdCheck()
   * result, or null before the first sync. Advice only: nothing is blocked on it.
   */
  sendCrowd({ mode = "block", leaves, queued } = {}) {
    const view = this.view;
    if (!view) return null;
    const own = (this.wallet?.notes ?? []).map((n) => n.leafIndex);
    const candidates = candidateNotes({ outputs: view.outputs, leaves: leaves ?? view.outputs.length, log: this.log, own });
    if (queued === undefined && isBatchMode(mode)) {
      queued = null;
      const c = this.relayInfo?.batch?.modes?.[mode]?.current;
      if (c && Number.isSafeInteger(c.queued)) queued = c.queued;
    }
    return crowdCheck({ candidates, mode, queued });
  }

  /**
   * The batch a send in `mode` ("batch" | "batch10") would join now, from the current
   * view (no network): { mode, epochBlocks, start, releaseAt, lastRelease, deadline,
   * leaves, eligible, eligibleAt, reason }. reason: null, "too-new" (only notes that
   * arrived after block `start` cover the amount; they can join the batch from
   * `eligibleAt`) or "short" (balance or the 2-note limit). Without asset and amount
   * only the boundary is checked. lastRelease is the default; the relayer's 202 replaces
   * it. null before the first sync.
   */
  batchPlan(mode, { asset, amount } = {}) {
    const view = this.view;
    if (!view) return null;
    const { epochBlocks, start, releaseAt, lastRelease, deadline } = batchSchedule(view.height, mode);
    const leaves = leafCountAt(view.outputs, start);
    // Just after genesis there is no root for the boundary yet: only the next batch works.
    let reason = start < view.startHeight - 1 ? "too-new" : null;
    if (asset != null && amount != null && BigInt(amount) > 0n) {
      try {
        this.wallet.selectNotes(BigInt(asset.id ?? asset), BigInt(amount), { maxLeaf: leaves });
      } catch (e) {
        reason = e?.code === "NOTE_TOO_NEW" ? (reason ?? "too-new") : "short";
      }
    }
    return { mode, epochBlocks, start, releaseAt, lastRelease, deadline, leaves, eligible: reason === null, eligibleAt: releaseAt, reason };
  }

  /* ----- writes ----- */

  record(entry) {
    const e = { id: localId(), time: Date.now(), sentHeight: this.view?.height ?? null, ...entry };
    this.history.unshift(e);
    try {
      this.persist();
    } catch (err) {
      this.history = this.history.filter((h) => h !== e);
      throw err;
    }
    emit("history");
    return e;
  }

  update(entry, patch) {
    Object.assign(entry, patch);
    entry.rev = (entry.rev ?? 0) + 1; // newer than another tab's copy when the two merge
    this.persist();
    emit("history");
  }

  /** Folds in other tabs' writes and reserves what they handed out (W-1), before notes are selected. */
  #freshLocks() {
    this.pull();
    if (this.view) this.wallet.locked = lockedNullifiers(this.history, this.view.height, this.view.nullifiers);
  }

  /**
   * Records a new send (W-1) only when no other entry, another tab's included, already
   * reserves any of its notes; else throws NOTES_TAKEN before anything leaves the browser.
   */
  #reserve(fields) {
    this.pull();
    const v = this.view;
    const taken = lockedNullifiers(this.history, v?.height ?? 0, v?.nullifiers ?? new Set());
    if ((fields.spends ?? []).some((n) => taken.has(String(n)))) {
      if (v) this.wallet.locked = taken;
      throw Object.assign(new Error(NOTES_TAKEN), { code: "notes_taken" });
    }
    return this.record(fields);
  }

  async #prepare(onStep) {
    if (!this.wallet.artifacts) {
      const a = await step(onStep, "keys", async () => {
        const r = await loadArtifacts();
        return { ...r, detail: r.cached ? "cached" : `${(r.bytes / 1e6).toFixed(1)} MB, fingerprint matches` };
      });
      this.wallet.artifacts = { wasm: a.wasm, zkey: a.zkey };
    } else {
      onStep({ id: "keys", status: "ok", detail: "cached", ms: 0 });
    }
    await step(onStep, "sync", async () => {
      await this.sync();
      return { detail: `root matches at #${this.view.height.toLocaleString("en-US")}` };
    });
  }

  /** root: the root the proof is checked against (value or function), the tip's by default. */
  async #proveAndCheck(onStep, build, { root = () => this.view.tree.root(), detail = null } = {}) {
    const envelope = await step(onStep, "prove", build, detail);
    await step(onStep, "verify", async () => {
      if (!(await verifyEnvelope(envelope, typeof root === "function" ? root() : root))) {
        throw new Error("The proof built in your browser didn't verify, so nothing was sent. Sync and try again.");
      }
      return { detail: "Groth16, pinned key" };
    });
    return envelope;
  }

  /** Signs (local key) or hands to Unisat, then broadcasts. Marks `handed` once bytes leave the browser. */
  async #carrySelf(onStep, payer, { envelope, outputs = [], utxos, firstInput, flags = {} }) {
    const feeRate = await api.esplora.feeRate();
    if (payer.kind === "unisat") {
      onStep({ id: "sign", status: "running", detail: "Confirm in Unisat" });
      try {
        await payer.checkAccount(); // before anything leaves the browser
        flags.handed = true;
        const r = await payer.carry({ envelope, outputs, feeRate });
        onStep({ id: "sign", status: "ok", detail: "Signed in Unisat" });
        onStep({ id: "broadcast", status: "ok", detail: "In mempool" });
        return r;
      } catch (e) {
        if (isUserCancel(e)) flags.handed = false;
        onStep({ id: "sign", status: "fail", detail: e.message });
        throw e;
      }
    }
    const signed = await step(onStep, "sign", async () => {
      // L5: the same layout policy as every other route (RBF_SEQUENCE, random input order and change slot).
      const { tx, fee } = planCarrierTx({ account: payer.account, utxos: utxos ?? (await payer.utxos(api.esplora)), envelope, outputs, firstInput, feeRate, sequence: RBF_SEQUENCE });
      return { ...signLocal(tx, payer.key), fee: Number(fee), detail: `${Number(fee).toLocaleString("en-US")} sats at ${feeRate} sat/vB` };
    });
    flags.handed = true;
    const { txid } = await step(onStep, "broadcast", async () => ({ txid: await api.esplora.broadcast(signed.hex), detail: "In mempool" }));
    return { txid, fee: signed.fee, vsize: signed.vsize };
  }

  /**
   * Private send. via "self" (default): your own payer pays the fee and the transfer is
   * linked to its address on Bitcoin. via "copy": prove and record it (W-1), hand it to
   * nobody; the user copies the envelope and anyone can carry it. via "relay": a relayer
   * carries it, charged to the wallet's relay balance (relay-balance.md), only while a
   * relay-balance relayer runs.
   * mode: relay timing, "block" | "fast" | "batch" | "batch10" (default defaultMode(to));
   * a self-paid send is recorded as "block". A batch send proves against the tree at
   * the first block of its batch. linkable: true is the user's explicit consent to a relayed
   * send that a thin relay pool ties to their top-up address (privacy-trace-test.md L1);
   * without it such a send is refused with code "pool_thin" before or at the relayer. The
   * entry records it (linkable: true), so no screen calls that send's sender hidden.
   * Returns the history entry.
   */
  async send({ asset, amount, to, via = this.routePref, mode, linkable = false, onStep = () => {}, signal } = {}) {
    let recipient;
    try {
      recipient = decodeAddress(String(to).trim());
    } catch {
      throw new Error(NOT_ADDRESS);
    }
    if (amount <= 0n) throw new Error("Amount must be greater than zero.");
    mode = via === "relay" ? (mode ?? this.defaultMode(to)) : "block";
    if (!isMode(mode)) throw new Error(`Unknown relay timing: ${mode}.`);
    linkable = via === "relay" && linkable === true;
    this.busy++;
    try {
      await this.#prepare(onStep);
      if (isBatchMode(mode)) return await this.#sendBatch({ asset, amount, to, recipient, mode, linkable, onStep, signal });
      if (via === "copy") return await this.#sendCopy({ asset, amount, to, recipient, onStep });
      const payer = via === "relay" ? this.relayPayer : this.ownPayer();
      const assetId = BigInt(asset.id);
      // One tab at a time from note selection to the reserving entry (W-1 across tabs).
      const { entry, envelope } = await spendLock(async () => {
        this.#freshLocks();
        await step(onStep, "select", async () => {
          const { picked } = this.wallet.selectNotes(assetId, amount);
          return { detail: `${picked.length} ${picked.length === 1 ? "note" : "notes"}` };
        });
        const envelope = await this.#proveAndCheck(onStep, () => this.wallet.transfer(this.view, { asset: assetId, amount, to: recipient }));
        const env = decodeEnvelope(envelope);
        // W-1: the entry exists before the envelope leaves the browser, so its notes stay reserved.
        const entry = this.#reserve({
          kind: "send", via: via === "relay" ? "relay" : payer.kind === "unisat" ? "unisat" : "self", mode,
          ticker: asset.ticker, assetId: String(asset.id), amount: amount.toString(), div: asset.divisibility, to: String(to).trim(),
          spends: envelope.spends, commitments: env.commitments.map(String), anchor: env.anchor, envelope: hex(envelope), print: hex(env.proof.slice(0, 32)),
          payerAddress: via === "relay" ? null : payer.address, status: via === "relay" ? "relaying" : "mempool",
          ...(linkable ? { linkable: true } : {}),
        });
        return { entry, envelope };
      });
      await this.#handOut(entry, envelope, { via, payer, mode, linkable, onStep, signal });
      return entry;
    } finally {
      this.busy--;
    }
  }

  /**
   * send() via "copy": proves and checks the transfer, then records it as "copied" with
   * its envelope, so its notes stay reserved (W-1) until it lands or its window closes.
   * Nothing leaves this browser; the view hands the envelope to the clipboard.
   */
  #sendCopy(args) {
    return spendLock(() => this.#sendCopyLocked(args));
  }

  async #sendCopyLocked({ asset, amount, to, recipient, onStep }) {
    const assetId = BigInt(asset.id);
    this.#freshLocks();
    await step(onStep, "select", async () => {
      const { picked } = this.wallet.selectNotes(assetId, amount);
      return { detail: `${picked.length} ${picked.length === 1 ? "note" : "notes"}` };
    });
    const envelope = await this.#proveAndCheck(onStep, () => this.wallet.transfer(this.view, { asset: assetId, amount, to: recipient }));
    const env = decodeEnvelope(envelope);
    const entry = this.#reserve({
      kind: "send", via: "copy", mode: "block",
      ticker: asset.ticker, assetId: String(asset.id), amount: amount.toString(), div: asset.divisibility, to: String(to).trim(),
      spends: envelope.spends, commitments: env.commitments.map(String), anchor: env.anchor, envelope: hex(envelope), print: hex(env.proof.slice(0, 32)),
      payerAddress: null, status: "copied", deadline: env.anchor + ANCHOR_WINDOW,
    });
    this.wallet.locked = lockedNullifiers(this.history, this.view.height, this.view.nullifiers);
    onStep({ id: "ready", status: "ok", detail: `Valid until block ${int(env.anchor + ANCHOR_WINDOW)}` });
    return entry;
  }

  /** send() in a batch mode, after keys and sync (batch-contract §4.3). */
  async #sendBatch({ asset, amount, to, recipient, mode, linkable = false, onStep, signal }) {
    const assetId = BigInt(asset.id);
    // One tab at a time from note selection to the reserving entry (W-1 across tabs).
    const { entry, envelope } = await spendLock(async () => {
      this.#freshLocks();
      const { plan, anchor, root } = await step(onStep, "select", async () => {
        const b = await this.#batchAnchor(mode, { asset: assetId, amount });
        const { picked } = this.wallet.selectNotes(assetId, amount, { maxLeaf: b.plan.leaves });
        return { ...b, detail: `${picked.length} ${picked.length === 1 ? "note" : "notes"} · tree at block ${int(b.plan.start)}` };
      });
      const envelope = await this.#proveAndCheck(onStep, () => this.wallet.transfer(this.view, { asset: assetId, amount, to: recipient, anchor }), { root });
      const env = decodeEnvelope(envelope);
      // W-1: the entry exists before the envelope leaves the browser, so its notes stay reserved.
      const entry = this.#reserve({
        kind: "send", via: "relay", mode, epochBlocks: plan.epochBlocks, releaseAt: plan.releaseAt, lastRelease: plan.lastRelease,
        ticker: asset.ticker, assetId: String(asset.id), amount: amount.toString(), div: asset.divisibility, to: String(to).trim(),
        spends: envelope.spends, commitments: env.commitments.map(String), anchor: env.anchor, envelope: hex(envelope), print: hex(env.proof.slice(0, 32)),
        payerAddress: null, status: "relaying",
        ...(linkable ? { linkable: true } : {}),
      });
      return { entry, envelope };
    });
    await this.#handOut(entry, envelope, { via: "relay", payer: this.relayPayer, mode, linkable, onStep, signal });
    return entry;
  }

  /**
   * The tree at the first block of `mode`'s current batch, checked against the indexer's
   * root for that block: { plan, anchor, root }. The roots come in one request for the
   * last 144 blocks, the same for both lengths and any boundary, so it doesn't single
   * out the block. `inputs` (same notes as before) must all be in that tree. Throws
   * NOT_IN_BATCH when the notes are newer than the boundary, and the usual selection
   * error when the amount can't be sent at all.
   */
  async #batchAnchor(mode, { asset, amount, inputs = null }, rebuilt = false) {
    const view = this.view;
    const plan = this.batchPlan(mode, inputs ? {} : { asset, amount });
    let tooNew = plan.reason === "too-new";
    if (plan.reason === "short") this.wallet.selectNotes(asset, amount, { maxLeaf: plan.leaves });
    if (inputs && !tooNew) {
      try {
        this.wallet.notesFor(asset, amount, inputs, { maxLeaf: plan.leaves });
      } catch (e) {
        if (e?.code !== "NOTE_TOO_NEW") throw e;
        tooNew = true;
      }
    }
    if (tooNew) throw notInBatch(plan, view.height);
    const anchor = anchorAt(view, plan.start);
    const root = anchor.tree.root();
    const rows = await api.roots({ from: Math.max(view.startHeight - 1, view.height - 143), to: view.height });
    const hit = (rows ?? []).find(([h]) => Number(h) === plan.start);
    if (!hit || String(hit[1]) !== root.toString()) {
      // An incremental sync keeps output heights from before a reorg that re-mined the same
      // outputs later (the tip root can't tell); the tree at S then counts the wrong leaves.
      // Rebuild the view from scratch once before calling it a mismatch.
      if (hit && !rebuilt) {
        await this.#rebuild();
        return this.#batchAnchor(mode, { asset, amount, inputs }, true);
      }
      throw new Error(`The pool at block ${int(plan.start)} doesn't match the indexer's root. ${SYNC_AGAIN}`);
    }
    return { plan, anchor, root };
  }

  /** A sync that downloads every output again (nothing reused from the cached view), after any sync in flight. */
  async #rebuild() {
    await this.syncing?.catch(() => {});
    this.syncing = this.#sync(false).finally(() => (this.syncing = null));
    return this.syncing;
  }

  /** Takes a new envelope for `entry` (same notes), keeping the newest anchor so the lock covers every version. */
  #adopt(entry, envelope, extra = {}) {
    const env = decodeEnvelope(envelope);
    this.update(entry, {
      envelope: hex(envelope), anchor: Math.max(entry.anchor, env.anchor),
      commitments: [...new Set([...(entry.commitments ?? []), ...env.commitments.map(String)])], ...extra,
    });
  }

  /**
   * epoch_closed: the batch closed while proving. Syncs, then proves the same notes
   * (same nullifiers) at the new boundary. The refusal's epochStart says which block
   * the relayer has reached; one more sync when this view is still behind it.
   */
  async #reproveBatch(entry, mode, onStep, refusal) {
    const assetId = BigInt(entry.assetId);
    const amount = BigInt(entry.amount);
    let ctx;
    const envelope = await this.#proveAndCheck(
      onStep,
      async () => {
        await this.sync();
        if (Number.isSafeInteger(refusal?.epochStart) && this.view.height < refusal.epochStart) await this.sync();
        ctx = await this.#batchAnchor(mode, { asset: assetId, amount, inputs: entry.spends });
        return this.wallet.transfer(this.view, { asset: assetId, amount, to: decodeAddress(entry.to), inputs: entry.spends, anchor: ctx.anchor });
      },
      { root: () => ctx.root, detail: "The batch closed while proving. Proving again for the next batch." },
    );
    this.#adopt(entry, envelope, { epochBlocks: ctx.plan.epochBlocks, releaseAt: ctx.plan.releaseAt, lastRelease: ctx.plan.lastRelease });
    return envelope;
  }

  async #handOut(entry, envelope, { via, payer, mode, linkable = false, onStep, signal }) {
    const flags = { handed: false };
    const batch = via === "relay" && isBatchMode(mode);
    try {
      if (via === "relay") {
        const carry = (env) =>
          payer.carry({
            envelope: env, mode, linkable, signal, account: this.#relay,
            onStep: (s) => {
              if (s.id === "submit" && s.status === "running") flags.handed = true;
              onStep(s);
            },
          });
        let r;
        try {
          r = await carry(envelope);
        } catch (e) {
          // Once per hand-out: a second epoch_closed, or any other failure, marks it failed below.
          if (!batch || e?.code !== "epoch_closed") throw e;
          r = await carry(await this.#reproveBatch(entry, mode, onStep, e));
        }
        const patch = { relayId: r.relayId, deadline: r.deadline ?? entry.anchor + ANCHOR_WINDOW, status: "relaying", reason: null };
        if (batch) Object.assign(patch, { releaseAt: r.releaseAt ?? entry.releaseAt, lastRelease: r.lastRelease ?? entry.lastRelease, epochQueued: r.epochQueued ?? null });
        this.update(entry, patch);
        // The reservation came off the balance: read it again (in the background).
        this.relayWork = this.loadRelayBalance().catch(() => {});
        const detail = batch ? `Scheduled for the batch after block ${int(entry.releaseAt)}` : r.flush === "fast" ? "Fast mode: about a minute" : "Goes out with the next block, with other transfers";
        onStep({ id: "queued", status: "ok", detail });
      } else {
        const r = await this.#carrySelf(onStep, payer, { envelope, flags });
        this.update(entry, { txid: r.txid, txids: [...new Set([...(entry.txids ?? []), r.txid])], fee: r.fee, status: "mempool", reason: null });
      }
      this.wallet.locked = lockedNullifiers(this.history, this.view.height, this.view.nullifiers);
    } catch (e) {
      // A retried entry was handed out before (retry() clears relayId), so it always stays (W-1).
      if (!flags.handed && !entry.relayId && !entry.txid && !entry.retries) {
        // Nothing left this browser: drop the entry so the notes are free again.
        this.history = this.history.filter((h) => h !== entry);
        this.persist();
        emit("history");
      } else {
        const msg = via === "relay" ? relayFailure(e).message : e.message;
        // pool_thin: Activity offers the explicit "send it linkable" retry (privacy-trace-test.md L1).
        this.update(entry, { status: "failed", reason: msg, failCode: via === "relay" && e?.code === "pool_thin" ? "pool_thin" : null });
        e.entry = entry;
      }
      throw e;
    }
  }

  /**
   * Retry a failed or stuck send without ever paying twice (W-1): the same envelope
   * while it is still fresh enough for the route, otherwise a new proof over exactly
   * the same notes (so the same nullifiers: at most one version can land). A batch
   * mode joins the current batch: the envelope is reused only when it is already
   * anchored at that batch's first block. Retry choices (retryChoices): "relay" and
   * "next-batch" -> { via: "relay" }, "next-block" -> { via: "relay", mode: "block" },
   * "self" -> { via: "self" }. An entry saved as "batch12" (the retired 12-hour batch)
   * retries in the 10-hour batch. linkable (default: what the entry was sent with) is the
   * consent send() takes, for a relayed retry while the relay pool is thin.
   */
  async retry(entry, { via = entry.via === "relay" ? "relay" : "self", mode = savedMode(entry.mode) ?? "block", linkable = entry.linkable === true, onStep = () => {}, signal } = {}) {
    if (entry.kind !== "send") throw new Error("Only private sends can be retried here.");
    if (via !== "relay") mode = "block"; // self-paid sends ignore relay timing
    linkable = via === "relay" && linkable === true;
    if (!isMode(mode)) throw new Error(`Unknown relay timing: ${mode}.`);
    const batch = via === "relay" && isBatchMode(mode);
    this.busy++;
    try {
      await this.#prepare(onStep);
      if (entry.spends.every((n) => this.view.nullifiers.has(String(n)))) {
        await this.refreshHistory();
        throw new Error("These notes are already spent: the transfer has landed. Nothing was sent.");
      }
      const assetId = BigInt(entry.assetId);
      const amount = BigInt(entry.amount);
      const reuse = () => {
        onStep({ id: "select", status: "ok", detail: "same notes, same envelope" });
        onStep({ id: "prove", status: "skip", detail: "reusing the envelope already handed out" });
        onStep({ id: "verify", status: "skip" });
        return unhex(entry.envelope);
      };
      let envelope;
      let timing = null; // the batch this retry joins
      if (batch) {
        const plan = this.batchPlan(mode);
        if (entry.envelope && entry.mode === mode && anchorOf(entry.envelope) === plan.start) {
          envelope = reuse();
          timing = plan;
        } else {
          let ctx;
          await step(onStep, "select", async () => {
            ctx = await this.#batchAnchor(mode, { asset: assetId, amount, inputs: entry.spends });
            return { detail: `same notes as before · tree at block ${int(ctx.plan.start)}` };
          });
          envelope = await this.#proveAndCheck(onStep, () => this.wallet.transfer(this.view, { asset: assetId, amount, to: decodeAddress(entry.to), inputs: entry.spends, anchor: ctx.anchor }), { root: ctx.root });
          this.#adopt(entry, envelope);
          timing = ctx.plan;
        }
      } else {
        const age = this.view.height - entry.anchor;
        const limit = via === "relay" ? RELAY_ANCHOR_SLACK : ANCHOR_WINDOW - 2;
        if (entry.envelope && age <= limit) {
          envelope = reuse();
        } else {
          await step(onStep, "select", async () => ({ detail: "same notes as before" }));
          envelope = await this.#proveAndCheck(onStep, () => this.wallet.transfer(this.view, { asset: assetId, amount, to: decodeAddress(entry.to), inputs: entry.spends }));
          this.#adopt(entry, envelope);
        }
      }
      const payer = via === "relay" ? this.relayPayer : this.ownPayer();
      this.update(entry, {
        via: via === "relay" ? "relay" : payer.kind === "unisat" ? "unisat" : "self",
        payerAddress: via === "relay" ? entry.payerAddress ?? null : payer.address, relayId: null, retries: (entry.retries ?? 0) + 1, failCode: null,
        status: via === "relay" ? "relaying" : "mempool", relayStatus: null,
        mode, epochBlocks: timing?.epochBlocks ?? null, releaseAt: timing?.releaseAt ?? null, lastRelease: timing?.lastRelease ?? null, epochQueued: null,
        ...(linkable ? { linkable: true } : {}),
      });
      await this.#handOut(entry, envelope, { via, payer, mode, linkable, onStep, signal });
      return entry;
    } finally {
      this.busy--;
    }
  }

  /* ----- mining (mining-contract.md §10.1) ----- */

  /** Mining key balance from mempool.space. Only on explicit request or right before paying. */
  async checkMineBtc() {
    if (!this.minePayer) throw new Error("This wallet has no usable mining key.");
    const sats = await this.minePayer.balance(api.esplora);
    this.mineBtc = { sats, at: Date.now() };
    emit("btc");
    return sats;
  }

  /** A mined asset as listed by the last sync (kind "pow"), or null. */
  minedAsset(idOrTicker) {
    const a = this.asset(idOrTicker);
    return a?.kind === "pow" ? a : null;
  }

  /**
   * A fresh claim draft for `asset` (a GET /api/mine/:asset view) at this wallet's tip
   * (mining.md §4.3, §12.1): new output blindings, ciphertexts, dummy inputs and so a new
   * challenge on every call. Up to two of the wallet's notes of the asset are rolled in,
   * except notes reserved by a pending claim or held by a found solution. The draft also
   * carries the difficulty its work must meet (D at the reference block) and the asset's
   * divisibility and ticker for the page.
   */
  prepareMine(asset, { refHash = null, roll = true } = {}) {
    if (this.closed) throw new Error(LOCKED);
    const v = this.view;
    if (!v) throw new Error("Sync the wallet first.");
    const ref = v.height;
    const tip = asset?.tip ?? null;
    const hash = refHash ?? (tip?.height === ref ? tip.hash : null);
    if (!/^[0-9a-f]{64}$/.test(String(hash ?? ""))) throw mineError("refhash", `No block hash for block ${int(ref)} yet. Wait for the next poll.`);
    if (!tip || tip.height !== ref) throw mineError("behind", "The wallet and the indexer are at different blocks. Mining resumes after the next sync.");
    const terms = { reward: BigInt(asset.baseReward ?? asset.reward), halvingInterval: asset.halvingInterval ?? 0, mineStart: asset.mineStart, startHeight: asset.startHeight ?? 0, deployHeight: asset.deployHeight };
    const reward = rewardAt(terms, ref);
    if (reward <= 0n) throw mineError("ended", `Mining ${asset.ticker} has ended: the reward is 0.`);
    // Notes held by a found solution that has no entry yet stay out of this draft too.
    const keep = this.wallet.locked;
    this.wallet.locked = new Set([...keep, ...this.mineHeld]);
    let draft;
    try {
      draft = this.wallet.prepareClaim(v, { asset: BigInt(asset.asset ?? asset.id), reward, refHeight: ref, refHash: hash, roll });
    } finally {
      this.wallet.locked = keep;
    }
    Object.defineProperty(draft, "meta", {
      value: { difficulty: BigInt(asset.difficulty), ticker: asset.ticker, div: asset.divisibility ?? 0, assetId: String(asset.asset ?? asset.id) },
      enumerable: false,
    });
    return draft;
  }

  /** W-M before the entry exists: the notes a found solution rolled stay out of the next draft. */
  holdDraft(draft) {
    for (const n of draft?.rolled ?? []) this.mineHeld.add(String(n));
  }
  releaseDraft(draft) {
    for (const n of draft?.rolled ?? []) this.mineHeld.delete(String(n));
  }

  /**
   * The claim lifecycle after a worker found `nonce` for `draft` (mining-contract.md §10.1):
   *   check   the reference Argon2id (referenceHash: hex password -> Promise<hex>, run in a Web
   *           Worker) must equal the worker's powHash, else code "pow_mismatch" (the page then
   *           disables its fast path); the reference block hash from mempool.space must equal
   *           the one the challenge used ("refhash"); then the 12-block window ("expired"), the
   *           stale bound ("stale_work"), the target ("insufficient") and the supply cap with
   *           claims in flight ("cap_reached"), from a fresh GET /api/mine/:asset.
   *   bind    relay: info.mine.bindScriptHash; key: a coin of the mining key chosen now (never one
   *           bound to another pending claim); unisat: sha256 of the connected account's script
   *   record  the W-M entry, before proving: one solution, one route
   *   prove, verify (Groth16 against R[ref]), then submit (relay) or sign and broadcast (key, unisat)
   * route: "relay" | "key" | "unisat". Every refusal before the hand-out throws with a code and
   * leaves no entry; nothing has been paid. linkable: the user's consent to relay while the
   * relay pool is thin (the claim's carrier is then tied to the top-up address by its input,
   * privacy-trace-test.md L1); without it the relayer refuses with "pool_thin". Returns the history entry.
   */
  async claimMine({ draft, nonce, powHash, route, referenceHash, linkable = false, onStep = () => {}, signal } = {}) {
    if (this.closed) throw new Error(LOCKED);
    if (!draft?.meta) throw new Error("Not a claim draft from prepareMine.");
    if (!["relay", "key", "unisat"].includes(route)) throw new Error(`Unknown claim route: ${route}.`);
    const nonceHex = String(nonce ?? "").toLowerCase();
    if (!/^[0-9a-f]{16}$/.test(nonceHex)) throw new Error("A nonce is 8 bytes of hex.");
    const { ticker, div, assetId } = draft.meta;
    const ref = draft.refHeight;
    const solutionId = hex(solutionIdOf(draft.challenge, unhex(nonceHex)));
    this.busy++;
    try {
      // 1. check, before anything is paid or recorded
      const fresh = await step(onStep, "check", async () => {
        const pw = hex(passwordOf(draft.challenge, unhex(nonceHex)));
        const reference = String(await referenceHash(pw)).toLowerCase();
        if (reference !== String(powHash).toLowerCase()) {
          throw mineError("pow_mismatch", "This browser's fast hash disagreed with the reference implementation, so the solution was not used and nothing was paid. Mining continues in slow mode.");
        }
        const btcHash = String(await api.esplora.blockHash(ref)).toLowerCase();
        const again = challengeOf({ asset: draft.asset, refHeight: ref, refHash: btcHash, reward: draft.reward, commitments: draft.commitments });
        if (btcHash !== draft.refHash || hex(again) !== hex(draft.challenge)) {
          throw mineError("refhash", `The indexer's hash of block ${int(ref)} differs from mempool.space's. Nothing was paid. Switch indexer if this repeats.`);
        }
        const view = await api.mineAsset(assetId, { signal });
        const tip = view?.tip?.height;
        if (!Number.isSafeInteger(tip)) throw mineError("indexer", "The indexer did not report its tip. Nothing was paid.");
        if (view.status !== "mining") throw mineError("closed", `${ticker} is not open for mining now (${String(view.status).replace("-", " ")}). Nothing was paid.`);
        if (mineWindowLeft(ref, tip, route) < 0) throw mineError("expired", "This solution's 12-block window is too close to its end to pay for a claim now. Nothing was paid; the workers already search a new block.");
        // D_eff at the next block: max(D(ref), D(tip) / 4), D(tip) being the indexer's current difficulty.
        const dRef = draft.meta.difficulty;
        const dTip = BigInt(view.difficulty);
        const stale = dTip / BigInt(STALE_FACTOR);
        const dEff = dRef > stale ? dRef : stale;
        if (!meetsTarget(unhex(reference), targetOf(dEff))) {
          if (meetsTarget(unhex(reference), targetOf(dRef))) throw mineError("stale_work", "Difficulty jumped. Solutions found before the jump may no longer count; the wallet checks before paying. Nothing was paid.");
          throw mineError("insufficient", "This solution does not meet the difficulty. Nothing was paid.");
        }
        // Claims on their way count at their own rewards (pendingReward; a halving may lie between them).
        const pending = Number.isSafeInteger(view.pendingClaims) ? view.pendingClaims : 0;
        const pendingReward = /^\d+$/.test(String(view.pendingReward ?? "")) ? BigInt(view.pendingReward) : draft.reward * BigInt(pending);
        if (BigInt(view.issued) + pendingReward + draft.reward > BigInt(view.maxSupply)) {
          throw mineError("cap_reached", "The supply is mined out, counting claims already on their way. Nothing was paid.");
        }
        // Notes this draft rolled must still be unspent and not reserved by another claim or send.
        this.#freshLocks();
        const taken = draft.rolled.find((n) => this.view?.nullifiers.has(String(n)) || this.wallet.locked.has(String(n)));
        if (taken) throw mineError("notes_taken", "A note this claim rolls in was used meanwhile, so the solution was not used and nothing was paid.");
        if (this.history.some((h) => h.kind === "mine" && h.solutionId === solutionId)) throw mineError("solution_taken", "This solution was already handed out once (W-M). Nothing more was paid.");
        return { view, detail: `D ${int(dEff)} met, ${mineWindowLeft(ref, tip, route) + 1} blocks left` };
      });

      // 2. bind for the chosen route
      let bind;
      let coin = null;
      let payer = null;
      let utxos = null; // the mining key's coins a self-paid carrier may spend (none held by another pending claim)
      // The fee outputs, within the pinned fee policy (fee_policy: nothing paid, no entry).
      const feeOutputs = mineFeeOutputs(fresh.view);
      await step(onStep, "bind", async () => {
        if (route === "relay") {
          const info = await this.loadRelayInfo();
          const m = info?.mine;
          if (!relayOpen() || m?.enabled !== true || !/^[0-9a-f]{64}$/.test(String(m?.bindScriptHash ?? ""))) {
            throw mineError("relay_off", "The relayer is not taking mining claims right now. Pay the fee yourself.");
          }
          const quote = mineQuote({ route, relayMine: m, serviceSats: feeOutputs.reduce((s, o) => s + o.sats, 0n) });
          const bal = this.relayBalance?.balance;
          if (quote && Number.isSafeInteger(bal) && BigInt(bal) < quote.total) {
            throw mineError("balance_low", `Your relay balance is ${int(bal)} sats; a claim needs about ${int(quote.total)}. Top up, or pay the fee yourself.`);
          }
          bind = { bindScriptHash: unhex(m.bindScriptHash) };
          return { detail: "bound to the relayer's change address" };
        }
        if (route === "unisat") {
          if (!this.unisat) throw mineError("unisat", "Connect Unisat in Settings, or pick another route.");
          await this.unisat.checkAccount();
          payer = this.unisat;
          bind = { bindScriptHash: scriptHashOf(payer.account.script) };
          return { detail: "bound to your Unisat address" };
        }
        if (!this.minePayer) throw mineError("no_key", "This wallet has no usable mining key.");
        payer = this.minePayer;
        const all = await payer.utxos(api.esplora);
        this.mineBtc = { sats: all.reduce((s, u) => s + u.value, 0), at: Date.now() };
        // A coin bound to, or spent by, another pending claim is never bound or spent again
        // (W-M): not as this claim's first input, and not as an extra input that funds it.
        const busy = busyMineCoins(this.history);
        utxos = all.filter((u) => !busy.has(`${u.txid}:${u.vout}`));
        if (!utxos.length) throw mineError("no_coins", "Every coin of your mining key is bound to a pending claim. Add BTC to it, or prepare coins so several claims can be in flight.");
        coin = pickBindUtxo(utxos);
        bind = { bindOutpoint: outpointOf(coin.txid, coin.vout) };
        return { detail: `${int(this.mineBtc.sats)} sats on the mining key` };
      });

      // 3. W-M: the entry exists before proving, so the solution goes out once, by one route.
      const entry = await spendLock(async () => {
        this.pull();
        if (this.history.some((h) => h.kind === "mine" && h.solutionId === solutionId)) throw mineError("solution_taken", "This solution was already handed out once (W-M). Nothing more was paid.");
        const taken = lockedNullifiers(this.history, this.view?.height ?? 0, this.view?.nullifiers ?? new Set());
        if (draft.rolled.some((n) => taken.has(String(n)))) throw Object.assign(new Error(NOTES_TAKEN), { code: "notes_taken" });
        return this.record({
          kind: "mine", via: route === "key" ? "self" : route, ticker, assetId, amount: draft.reward.toString(), reward: draft.reward.toString(), div,
          ref, anchor: ref, lockUntil: ref + MINE_WINDOW, solutionId, commitments: draft.commitments.map(String), spends: draft.rolled.map(String),
          coin: coin ? `${coin.txid}:${coin.vout}` : null, payerAddress: payer?.address ?? null, status: "proving",
          ...(route === "relay" && linkable === true ? { linkable: true } : {}),
        });
      });
      this.releaseDraft(draft);
      this.wallet.locked = lockedNullifiers(this.history, this.view.height, this.view.nullifiers);

      const flags = { handed: false };
      try {
        // 4. prove and self-verify against R[ref]
        const root = this.view.height === ref ? this.view.tree.root() : anchorAt(this.view, ref).tree.root();
        if (!this.wallet.artifacts) {
          const a = await step(onStep, "keys", async () => {
            const r = await loadArtifacts();
            return { ...r, detail: r.cached ? "cached" : `${(r.bytes / 1e6).toFixed(1)} MB, fingerprint matches` };
          });
          this.wallet.artifacts = { wasm: a.wasm, zkey: a.zkey };
        } else onStep({ id: "keys", status: "ok", detail: "cached", ms: 0 });
        let envelope = await this.#proveAndCheck(onStep, () => this.wallet.finalizeClaim(draft, bind, unhex(nonceHex)), { root });

        // 5. hand it out
        if (route === "relay") {
          const submit = (env) =>
            submitEnvelope(env, {
              mode: "block", linkable: linkable === true, account: this.#relay, signal,
              onStep: (s) => {
                if (s.status === "running") flags.handed = true;
                onStep(s);
              },
            });
          let r;
          try {
            r = await submit(envelope);
          } catch (e) {
            // The relayer's change address changed: prove again for it; the solution stays the same.
            if (e?.code !== "bind_stale" || !/^[0-9a-f]{64}$/.test(String(e.bindScriptHash ?? ""))) throw e;
            flags.handed = false;
            envelope = await this.#proveAndCheck(onStep, () => this.wallet.finalizeClaim(draft, { bindScriptHash: unhex(e.bindScriptHash) }, unhex(nonceHex)), { root });
            r = await submit(envelope);
          }
          this.update(entry, { status: "submitted", relayId: r.id, deadline: r.deadline ?? entry.lockUntil, reason: null });
          this.relayWork = this.loadRelayBalance().catch(() => {});
          onStep({ id: "queued", status: "ok", detail: "Goes out with the next block" });
        } else {
          const feeRate = headroomRate(await nextBlockRate());
          const outputs = feeOutputs.map((o) => ({ script: o.script, amount: o.amount }));
          let r;
          if (route === "unisat") {
            onStep({ id: "sign", status: "running", detail: "Confirm in Unisat" });
            try {
              await payer.checkAccount();
              flags.handed = true;
              r = await payer.carry({ envelope, outputs, feeRate });
            } catch (e) {
              if (isUserCancel(e)) flags.handed = false;
              onStep({ id: "sign", status: "fail", detail: e.message });
              throw e;
            }
            onStep({ id: "sign", status: "ok", detail: "Signed in Unisat" });
            onStep({ id: "broadcast", status: "ok", detail: "In mempool" });
          } else {
            const signed = await step(onStep, "sign", async () => {
              // RBF stays possible (the first input keeps the bind), but the rate is next-block up front.
              // Only coins no other pending claim holds can fund it (utxos, from the bind step).
              const { tx, fee } = planCarrierTx({ account: payer.account, utxos, envelope, outputs, firstInput: coin, feeRate, sequence: RBF_SEQUENCE });
              const inputs = [];
              for (let i = 0; i < tx.inputsLength; i++) inputs.push(`${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`);
              return { ...signLocal(tx, payer.key), fee: Number(fee), inputs, detail: `${int(Number(fee))} sats at ${feeRate} sat/vB` };
            });
            // W-M: the txid and the coins it spends are recorded before the carrier leaves, so a
            // broadcast whose answer is lost is followed by its txid, and its coins stay busy.
            this.update(entry, { txid: signed.txid, txids: [signed.txid], inputs: signed.inputs, fee: signed.fee });
            flags.handed = true;
            flags.txid = signed.txid;
            const { txid } = await step(onStep, "broadcast", async () => ({ txid: await api.esplora.broadcast(signed.hex), detail: "In mempool" }));
            r = { txid, fee: signed.fee };
          }
          this.update(entry, { status: "submitted", txid: r.txid, txids: r.txid ? [r.txid] : [], fee: r.fee ?? null, reason: null });
        }
        this.wallet.locked = lockedNullifiers(this.history, this.view.height, this.view.nullifiers);
        return entry;
      } catch (e) {
        if (!flags.handed) {
          // Nothing left this browser: no entry, so the notes and the solution can be used again.
          this.history = this.history.filter((h) => h !== entry);
          this.persist();
          emit("history");
        } else {
          // It left this browser. Dropped (notes and coin usable again) only when it certainly
          // cannot land: a relay 4xx (the relayer queued nothing), or a node that refused the
          // carrier while the explorer does not know its txid. A timeout, a 5xx or a Unisat
          // push error may come after the carrier reached the network, so the claim stays
          // pending: its notes and coin stay locked until it lands or its window ends (W-M).
          let definite = false;
          if (route === "relay") definite = Number(e?.status) >= 400 && Number(e?.status) < 500;
          else if (route === "key" && flags.txid) definite = await carrierRefused(e, flags.txid);
          if (definite) {
            this.update(entry, { status: "dropped", reason: route === "relay" ? relayFailure(e).message : e.message });
          } else {
            const msg = route === "relay" ? relayFailure(e).message : String(e?.message ?? e);
            this.update(entry, {
              status: "submitted",
              reason: `${msg.replace(/[.\s]+$/, "")}. The claim may still have reached the network, so its notes${entry.coin ? " and its coin" : ""} stay locked until it lands or block ${int(entry.lockUntil)} passes.`,
            });
          }
          e.entry = entry;
        }
        this.wallet.locked = lockedNullifiers(this.history, this.view.height, this.view.nullifiers);
        throw e;
      }
    } catch (e) {
      this.releaseDraft(draft);
      throw e;
    } finally {
      this.busy--;
    }
  }

  /**
   * "Prepare coins" (mining.md §8.6): splits the mining key's coins into `n` coins of `value`
   * sats each, so that n self-paid claims can be in flight at once. Signed here, then broadcast.
   * -> { txid, fee, n, value }
   */
  async prepareCoins(n, { value = null, feeRate = null } = {}) {
    if (this.closed) throw new Error(LOCKED);
    if (!this.minePayer) throw new Error("This wallet has no usable mining key.");
    // The split pays the ordinary rate; each coin is sized for one claim carrier on its own,
    // which pays ceil(next-block rate x 1.25) (mineQuote), as murkle mine --prepare-coins sizes them.
    const rate = feeRate ?? (await api.esplora.feeRate());
    const service = mineFeeOutputs({}).reduce((s, o) => s + o.amount, 0n);
    let each = value != null ? BigInt(value) : null;
    if (each === null) {
      const quote = mineQuote({ route: "key", feeRate: await nextBlockRate(), serviceSats: service });
      if (!quote) throw new Error("No fee estimate right now. Try again in a minute.");
      each = quote.total + 330n;
    }
    const utxos = await this.minePayer.utxos(api.esplora);
    const { tx, fee } = planSplitTx({ account: this.minePayer.account, utxos, n, value: each, feeRate: rate });
    const signed = signLocal(tx, this.minePayer.key);
    const txid = await api.esplora.broadcast(signed.hex);
    this.mineBtc = null;
    emit("btc");
    return { txid, fee: Number(fee), n, value: each };
  }

  /**
   * Moves `amount` sats between the transfer key and the mining key. It links the two
   * addresses on Bitcoin, so it refuses (code "confirm_move") until called with confirm: true.
   * from: "transfer" (localPayer -> mining key) | "mine" (mining key -> localPayer).
   */
  async moveBetweenKeys({ from, amount, confirm = false } = {}) {
    if (this.closed) throw new Error(LOCKED);
    if (!this.minePayer) throw new Error("This wallet has no usable mining key.");
    if (from !== "transfer" && from !== "mine") throw new Error("Move from the transfer key or from the mining key.");
    if (!confirm) {
      throw mineError("confirm_move", "Moving coins between your transfer key and your mining key links the two addresses on Bitcoin: anyone can then tie your claims to the transfers that key pays for. Confirm to move them anyway.");
    }
    const [src, dst] = from === "transfer" ? [this.localPayer, this.minePayer] : [this.minePayer, this.localPayer];
    const r = await src.pay({ api: api.esplora, to: dst.address, amount: BigInt(amount) });
    this.btc = null;
    this.mineBtc = null;
    emit("btc");
    return r;
  }

  /** Public mint into a private note. Mints are always paid from your own Bitcoin address. */
  async mint(asset, { onStep = () => {} } = {}) {
    this.busy++;
    try {
      await this.#prepare(onStep);
      const payer = this.ownPayer();
      const fresh = this.asset(asset.id) ?? asset;
      if (fresh.status !== "live") throw new Error(`${fresh.ticker} isn't open for minting right now (${String(fresh.status).replace("-", " ")}).`);
      // Audit A-6: bind the mint to something only this payer can spend. The local key
      // picks its own first input; Unisat picks inputs itself, so bind to its script.
      let utxos;
      let firstInput;
      let binding;
      await step(onStep, "payer", async () => {
        if (payer.kind === "unisat") {
          await payer.checkAccount();
          binding = { bindScriptHash: scriptHashOf(payer.account.script) };
          return { detail: "Unisat picks the coins" };
        }
        utxos = await payer.utxos(api.esplora);
        this.btc = { sats: utxos.reduce((s, u) => s + u.value, 0), at: Date.now() };
        if (!utxos.length) throw new Error(`Your built-in address has no ${NETWORK === "signet" ? "signet BTC" : "BTC"}. Add BTC to it, then mint again.`);
        firstInput = pickBindUtxo(utxos);
        binding = { bindOutpoint: outpointOf(firstInput.txid, firstInput.vout) };
        return { detail: `${this.btc.sats.toLocaleString("en-US")} sats available` };
      });
      const envelope = await this.#proveAndCheck(onStep, () =>
        this.wallet.mint(this.view, { asset: BigInt(fresh.id), mintAmount: BigInt(fresh.mintAmount), ...binding }),
      );
      const env = decodeEnvelope(envelope);
      // A price below the treasury's dust limit is paid at that limit: record what was paid.
      const { price, paid, raised } = mintPayment(fresh);
      const outputs = price > 0n ? [{ script: unhex(fresh.treasury), amount: paid }] : [];
      const flags = {};
      const r = await this.#carrySelf(onStep, payer, { envelope, outputs, utxos, firstInput, flags });
      return this.record({
        kind: "mint", via: payer.kind === "unisat" ? "unisat" : "self", txid: r.txid, txids: [r.txid], ticker: fresh.ticker, assetId: String(fresh.id),
        amount: String(fresh.mintAmount), div: fresh.divisibility, commitments: env.commitments.map(String), anchor: env.anchor, print: hex(env.proof.slice(0, 32)),
        fee: r.fee, price: paid.toString(), ...(raised ? { listPrice: price.toString(), priceNote: "raised to the dust limit" } : {}),
        payerAddress: payer.address, status: "mempool",
      });
    } finally {
      this.busy--;
    }
  }

  /** Public launch (DEPLOY). Never relayed: free launches would allow ticker squatting. */
  async deploy(terms, { onStep = () => {} } = {}) {
    this.busy++;
    try {
      await step(onStep, "sync", async () => {
        await this.sync();
        return { detail: `#${this.view.height.toLocaleString("en-US")}` };
      });
      if (this.assetList.some((a) => a.ticker === terms.ticker)) throw new Error(`Ticker ${terms.ticker} is already taken.`);
      const payer = this.ownPayer();
      const envelope = encodeDeploy({ ...terms, treasury: terms.treasury ? scriptOf(terms.treasury) : new Uint8Array() });
      const r = await this.#carrySelf(onStep, payer, { envelope, flags: {} });
      return this.record({ kind: "deploy", via: payer.kind === "unisat" ? "unisat" : "self", txid: r.txid, txids: [r.txid], ticker: terms.ticker, fee: r.fee, payerAddress: payer.address, status: "mempool" });
    } finally {
      this.busy--;
    }
  }

  /**
   * Mined launch (DEPLOY_POW, mining.md §3): public and never relayed, like DEPLOY. The ticker
   * namespace is shared with paid mints. Under the current rules the claim fee is 0 and there
   * is no treasury (the platform's service fee is a consensus constant, not a term).
   */
  async deployPow(terms, { onStep = () => {} } = {}) {
    this.busy++;
    try {
      await step(onStep, "sync", async () => {
        await this.sync();
        return { detail: `#${this.view.height.toLocaleString("en-US")}` };
      });
      if (this.assetList.some((a) => a.ticker === terms.ticker)) throw new Error(`Ticker ${terms.ticker} is already taken.`);
      const payer = this.ownPayer();
      const envelope = encodeDeployPow({ ...terms, treasury: terms.treasury ?? new Uint8Array() });
      const r = await this.#carrySelf(onStep, payer, { envelope, flags: {} });
      return this.record({ kind: "deploy", pow: true, via: payer.kind === "unisat" ? "unisat" : "self", txid: r.txid, txids: [r.txid], ticker: terms.ticker, fee: r.fee, payerAddress: payer.address, status: "mempool" });
    } finally {
      this.busy--;
    }
  }
}

/* ---------- vault lifecycle ---------- */

let session = null;
export const currentSession = () => session;

export const hasVault = () => Boolean(keystore.readVault(storage, STORAGE_PREFIX));
export const hasLegacy = () => Boolean(keystore.legacyPhrase(storage));

function start(s) {
  session?.dispose();
  session = s;
  setWalletStatus({ state: "unlocked", address: s.address, lock: () => lock("manual") });
  armIdle();
  emit("unlock");
  return s;
}

/** Unlocks the stored vault. Throws keystore.WrongPassword ("Wrong password"). */
export async function unlock(password) {
  const vault = keystore.readVault(storage, STORAGE_PREFIX);
  if (!vault) throw new Error("No wallet is stored in this browser. Create one or restore it from your 24 words.");
  const { phrase, key, data } = await keystore.unlockVault(vault, password);
  // A leftover plaintext copy of the same wallet goes now; a different one stays for the user to decide.
  const legacy = keystore.legacyPhrase(storage);
  if (legacy && normalizePhrase(legacy) === normalizePhrase(phrase)) {
    for (const k of Object.values(keystore.LEGACY_KEYS)) storage.removeItem(k);
  }
  return start(new Session({ phrase, key, data, vault }));
}

/** New vault from a phrase (create or import), written and read back before use. */
export async function createWallet(phrase, password) {
  const words = normalizePhrase(phrase);
  if (!isValidPhrase(words)) throw new Error("That isn't a valid 24-word recovery phrase.");
  // Once a vault exists the plaintext wallet could never be migrated, so it goes first.
  if (hasLegacy()) throw new Error("This browser still holds an older wallet whose recovery phrase isn't encrypted. Open the wallet and protect it with a password first.");
  if (hasVault()) throw new Error("This browser already has a wallet. Remove it in Settings first.");
  const s = new Session({ phrase: words }); // fails early on an unusable phrase
  const { vault, key } = await keystore.createVault(words, password);
  if (hasVault()) throw new Error("This browser already has a wallet. Remove it in Settings first."); // made in another tab meanwhile
  keystore.writeVault(storage, STORAGE_PREFIX, vault);
  const back = keystore.readVault(storage, STORAGE_PREFIX);
  const check = await keystore.unlockVault(back, password);
  if (check.phrase !== words) throw new Error("The encrypted copy didn't verify. Try again.");
  s.key = key;
  s.vault = back;
  s.stored = JSON.stringify(back);
  return start(s);
}

/** Migrates the zkpool-era plaintext wallet (features #1): see keystore.migrateLegacy. */
export async function migrateWallet(password) {
  const { vault, key, phrase, data } = await keystore.migrateLegacy(storage, password, { prefix: STORAGE_PREFIX });
  return start(new Session({ phrase, key, data, vault }));
}

/** Drops the session, the derived key and the decrypted data. */
export function lock(reason = "manual") {
  stopIdle();
  // Lock now (header menu, Settings) locks the wallet in every tab: the others see this key
  // change (storage event) and lock with "peer". Idle locks stay per tab.
  if (reason === "manual") storage.setPref(KEY.lockAll, `${Date.now()}.${hex(randomBytes(4))}`);
  if (!session) return;
  session.dispose();
  session = null;
  setWalletStatus({ state: hasVault() || hasLegacy() ? "locked" : "none", address: null, lock: undefined });
  setRootStatus({ state: "indexer" });
  emit(reason === "idle" ? "idle-lock" : reason === "elsewhere" ? "elsewhere-lock" : "lock");
}

/** Removes the wallet from this browser. The 24 words are the only way back. */
export function forgetWallet() {
  lock("forget");
  storage.removeItem(keystore.vaultKey(STORAGE_PREFIX));
  for (const k of [KEY.payer, KEY.route, KEY.relayMode, KEY.selfMode, ...Object.values(keystore.LEGACY_KEYS)]) storage.removeItem(k);
  setWalletStatus({ state: "none", address: null, lock: undefined });
  emit("forget");
}

/** The recovery phrase, after the password is entered again. Refused in streamer mode. */
export async function revealPhrase(password) {
  if (streamerMode()) throw new Error("Streamer mode is on. Turn it off before showing your recovery phrase.");
  const vault = keystore.readVault(storage, STORAGE_PREFIX);
  return (await keystore.unlockVault(vault, password)).phrase;
}

/**
 * The zkpool-era plaintext phrase still stored beside a vault (a different wallet:
 * unlock() removes a copy of the same one). Same care as revealPhrase: the vault
 * password first, refused in streamer mode.
 */
export async function revealLegacyPhrase(password) {
  if (streamerMode()) throw new Error("Streamer mode is on. Turn it off before showing a recovery phrase.");
  const vault = keystore.readVault(storage, STORAGE_PREFIX);
  if (!vault) throw new Error("No wallet is stored in this browser.");
  await keystore.unlockVault(vault, password);
  const phrase = keystore.legacyPhrase(storage);
  if (!phrase) throw new Error("The older phrase is no longer stored in this browser.");
  return phrase;
}

/** Deletes that plaintext phrase, its history and payer. Only beside a vault: alone, it is the only copy. */
export function forgetLegacy() {
  if (!hasVault()) throw new Error("Protect this wallet with a password first; the plaintext phrase is its only copy.");
  for (const k of Object.values(keystore.LEGACY_KEYS)) storage.removeItem(k);
}

/** Re-encrypts the vault under a new password, then re-seals the data with the new key. */
export async function changePassword(oldPassword, newPassword) {
  if (!session) throw new Error("Unlock the wallet first.");
  const s = session;
  s.pull(); // start from everything other tabs wrote
  const before = s.stored;
  const { vault, key } = await keystore.changePassword(JSON.parse(before), oldPassword, newPassword);
  // The key derivation takes a while. This tab's own writes meanwhile, and other tabs'
  // writes it has folded in, are in s.history and get re-sealed below; any other would be lost.
  if (session !== s) throw new Error(LOCKED);
  if (storage.getItem(VAULT_KEY) !== s.stored) {
    throw new Error("The wallet changed in another tab meanwhile, so the password was not changed. Try again.");
  }
  // This session switches to the new key in the same step, so its own next write isn't taken for another tab's.
  s.key?.fill?.(0);
  s.key = key;
  const data = { ...s.data, history: s.history, prefs: s.prefs }; // not the data as of `before`
  s.vault = keystore.withData(vault, key, data);
  s.stored = keystore.writeVault(storage, STORAGE_PREFIX, s.vault);
  s.storedData = canon(data);
  await keystore.unlockVault(keystore.readVault(storage, STORAGE_PREFIX), newPassword);
  s.persist();
}

/**
 * What another tab wrote (a storage event: e.key, or null when storage was cleared):
 *   the vault       fold its changes in now, so the notes it handed out are reserved here
 *                   too (repaint only when that changed something here); lock instead when
 *                   it removed or re-keyed the wallet
 *   lockAll         Lock now in another tab: lock this one too
 *   streamer        streamer mode turned on or off there: mask or unmask here at once
 */
export function onOtherTab(e) {
  if (e.key === KEY.streamer || e.key === null) {
    applyStreamer();
    const on = streamerMode();
    for (const fn of [...streamerFns]) fn(on);
  }
  if (!session) return;
  if (e.key === KEY.lockAll) return lock("peer");
  if (e.key !== null && e.key !== VAULT_KEY) return;
  try {
    if (session.pull()) emit("history");
  } catch {} // pull() has locked this tab
}
if (typeof addEventListener === "function") addEventListener("storage", onOtherTab);
// Switching indexer (Settings, /verify#indexer) drops what the session read from the old one.
api.onIndexerChange(() => session?.indexerChanged());

/* ---------- streamer mode ---------- */

const streamerFns = new Set();
export const streamerMode = () => storage.getItem(KEY.streamer) === "1";
function applyStreamer() {
  if (typeof document !== "undefined") document.documentElement.dataset.streamer = streamerMode() ? "on" : "off";
}
export function setStreamerMode(on) {
  storage.setPref(KEY.streamer, on ? "1" : "0");
  applyStreamer();
  for (const fn of [...streamerFns]) fn(Boolean(on));
}
export function onStreamerChange(fn) {
  streamerFns.add(fn);
  return () => streamerFns.delete(fn);
}
applyStreamer();

/* ---------- auto-lock ---------- */

let lastActivity = Date.now();
let idleTimer = null;
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"];
const touch = () => (lastActivity = Date.now());

export function autoLockMinutes() {
  const m = session?.prefs?.autoLockMin;
  return AUTO_LOCK_CHOICES.includes(m) ? m : DEFAULT_AUTO_LOCK;
}

export function setAutoLock(minutes) {
  if (!session || !AUTO_LOCK_CHOICES.includes(minutes)) return;
  session.persist({ autoLockMin: minutes }); // applied after other tabs' writes are folded in
  touch();
  armIdle();
}

function armIdle() {
  stopIdle();
  if (typeof document === "undefined" || !session) return;
  touch();
  for (const t of ACTIVITY_EVENTS) document.addEventListener(t, touch, { passive: true, capture: true });
  // A timestamp check rather than one long timeout: hidden tabs throttle timers.
  idleTimer = setInterval(() => {
    const m = autoLockMinutes();
    if (!session || !m) return;
    if (Date.now() - lastActivity < m * 60_000) return;
    if (session.busy) return touch(); // never lock in the middle of proving or broadcasting
    lock("idle");
  }, 10_000);
}

function stopIdle() {
  clearInterval(idleTimer);
  idleTimer = null;
  if (typeof document !== "undefined") for (const t of ACTIVITY_EVENTS) document.removeEventListener(t, touch, { capture: true });
}

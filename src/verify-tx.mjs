// Proof X-ray engine (visual.md 6.4). Re-checks one protocol
// transaction from raw Bitcoin data and reports every step with where its input
// came from, so a page can never show a green verdict without naming its sources:
//   BTC  data served by an Esplora API (mempool.space), checked against its hashes
//   YOU  computed locally (this process or browser), nothing else to trust
//   IDX  our indexer's claim
//
// Isomorphic: Node (tests, CLI) and browsers. Everything external is injected
// through `ctx`, and snarkjs is loaded lazily only when a proof is checked.
import { sha256 } from "@noble/hashes/sha256";
import { isNullOutpoint, parseRawTx } from "./btc/block.mjs";
import { ATTEST_KIND, OP, OP_NAME, decodeEnvelope, findEnvelope, headerOp, isMint, scriptHashOf } from "./envelope.mjs";
import { decodeProof, PROOF_LEN } from "./proof-codec.mjs";
import { toField } from "./core.mjs";
import { bigToBytes, concat, equal, hex, readU32le, unhex } from "./bytes.mjs";
import { ACTIVATIONS, ARTIFACT_SHA256, D_MAX, GENESIS_TXID, MANIFEST_SHA256, MINE_FEE, MINE_WINDOW, NETWORK, activationHeight } from "./params.mjs";
import * as mining from "./mine.mjs";
import { CHECKPOINTS, RULES, checkPow, decodeHeader, maxPlausibleHeight, maxTargetAt, minRetargetTarget, nearestCheckpoint, targetFromBits, workOfTarget } from "./btc/headers.mjs";

// Same values as src/indexer.mjs (a test pins them). Copied rather than imported
// because the indexer pulls snarkjs in eagerly, and this module must stay light.
export const ANCHOR_WINDOW = 100;
export const MIN_ANCHOR_DEPTH = 1;
// Mining ops, as src/envelope.mjs numbers them (a test pins them). Below the "mining"
// activation height every replayer treats them as unknown ops (SPEC §12, D6).
export const OP_MINE = 7;
export const OP_MINE_SCRIPT = 8;
export const OP_DEPLOY_POW = 9;
const MINING_OPS = new Set([OP_MINE, OP_MINE_SCRIPT, OP_DEPLOY_POW]);
const isMineOp = (op) => op === OP_MINE || op === OP_MINE_SCRIPT;

export const SOURCES = ["BTC", "YOU", "IDX"];
const TXID = /^[0-9a-f]{64}$/;
const NF = new Intl.NumberFormat("en-US");
const int = (n) => NF.format(typeof n === "bigint" ? n : Number(n));
const short = (h, a = 4, b = 4) => (String(h).length > a + b + 1 ? `${String(h).slice(0, a)}…${String(h).slice(-b)}` : String(h));
const dsha = (b) => sha256(sha256(b));
const rev = (b) => Uint8Array.from(b).reverse();
const ms = (v) => (v < 1000 ? `${Math.max(0, Math.round(v))} ms` : `${(v / 1000).toFixed(1)} s`);
const plural = (n, one, many = `${one}s`) => `${int(n)} ${Number(n) === 1 ? one : many}`;

/**
 * A check that failed for a reason worth showing as-is. `rule`: a rule or
 * consistency check ran on checked data and failed, a real result. Otherwise it
 * is a data problem (input missing, unreachable or inconsistent with its hash)
 * that says nothing about the rules or the indexer's verdict.
 */
export class CheckError extends Error {
  constructor(message, { rule = false, source = null } = {}) {
    super(message);
    this.rule = rule;
    this.source = source;
  }
}
const fail = (msg) => {
  throw new CheckError(msg);
};
// The transaction breaks a rule this engine checks itself.
const violation = (msg, source = null) => {
  throw new CheckError(msg, { rule: true, source });
};

/* ---------------------------------------------------------------- planning */

const HEAD = [
  ["fetch", "Raw transaction fetched", "BTC"],
  ["txid", "Bytes hash to this txid", "YOU"],
  ["status", "Mined", "BTC"],
  ["inclusion", "Included in block", "BTC"],
  ["envelope", "Envelope found and decoded strictly", "YOU"],
];
const PROOF_HEAD = [
  ["extdata", "Binding hash recomputed", "YOU"],
  ["points", "Proof points valid", "YOU"],
  ["vkey", "Verification key matches the pinned fingerprint", "YOU"],
];
const PROOF_TAIL = [
  ["root", "Anchor root", "IDX"],
  ["groth16", "Groth16 pairing check", "YOU"],
];
const MINT_ROWS = [
  ["terms", "Token terms read from the deploy transaction", "BTC"],
  ["bound", "First input is the bound coin", "BTC"],
  ["treasury", "Treasury paid in this transaction", "BTC"],
];
const MINE_ROWS = [
  ["terms", "Mining terms read from the deploy transaction", "BTC"],
  ["window", `Reference block inside the ${MINE_WINDOW}-block window`, "YOU"],
  ["refhash", "Reference block hash", "BTC"],
  ["work", "Work recomputed (Argon2id)", "YOU"],
  ["difficulty", "Difficulty the work must meet", "IDX"],
  ["bound", "First input is the bound coin", "BTC"],
  ["fees", "Service fee paid in this transaction", "BTC"],
];
const INDEXER = ["indexer", "Indexer verdict", "IDX"];
const BOUND_SCRIPT = ["bound", "Spends from the bound address", "BTC"];

/**
 * The rows a verification of `opName` will produce, in order, before any of
 * them runs (so a UI can show them as pending). Unknown op: the TRANSACT plan.
 */
export function planSteps(opName = "TRANSFER") {
  const rows = [...HEAD];
  const op = opName === "TRANSACT" ? "TRANSFER" : opName;
  if (op === "DEPLOY" || op === "DEPLOY_POW") rows.push(["deploy", "Terms valid", "YOU"]);
  else if (op === "ATTEST") rows.push(["attest", "Attested hash matches the pinned manifest", "YOU"]);
  else if (op === "MINT" || op === "MINT_SCRIPT") rows.push(...PROOF_HEAD, ...MINT_ROWS.map((r) => (r[0] === "bound" && op === "MINT_SCRIPT" ? BOUND_SCRIPT : r)), ...PROOF_TAIL);
  else if (op === "MINE" || op === "MINE_SCRIPT") rows.push(...PROOF_HEAD, ...MINE_ROWS.map((r) => (r[0] === "bound" && op === "MINE_SCRIPT" ? BOUND_SCRIPT : r)), ...PROOF_TAIL);
  else rows.push(...PROOF_HEAD, ...PROOF_TAIL);
  rows.push(INDEXER);
  return rows.map(([id, label, source]) => ({ id, label, source }));
}

/* ------------------------------------------------------- pure Bitcoin checks */

/** Splits an 80-byte header and checks its hash against its own nBits target. */
export function headerFields(header) {
  const h = typeof header === "string" ? unhex(header.trim()) : Uint8Array.from(header);
  if (h.length !== 80) throw new CheckError(`block header is ${h.length} bytes, expected 80`);
  const bits = readU32le(h, 72);
  // Compact target as Bitcoin Core decodes it: a negative or overflowing encoding is no target.
  const compact = targetFromBits(bits);
  const target = compact.negative || compact.overflow ? 0n : compact.target;
  const hashBytes = dsha(h);
  const hashInt = BigInt("0x" + hex(rev(hashBytes)));
  return {
    bytes: h,
    hash: hex(rev(hashBytes)),
    prevHash: hex(rev(h.subarray(4, 36))),
    merkleRoot: h.slice(36, 68), // internal byte order
    time: readU32le(h, 68),
    bits,
    target,
    meetsTarget: target > 0n && hashInt <= target,
  };
}

/**
 * Folds an Esplora merkle-proof ({ merkle: display-order hex[], pos }) over the
 * txid and returns the resulting merkle root in internal byte order.
 */
export function merkleRootFromProof(txid, merkle, pos) {
  if (!Array.isArray(merkle)) throw new CheckError("merkle proof has no path");
  if (!Number.isInteger(pos) || pos < 0) throw new CheckError("merkle proof has no valid position");
  if (pos >= 2 ** merkle.length) throw new CheckError("merkle position does not fit the path length");
  let node = rev(unhex(txid));
  let index = pos;
  for (const sibling of merkle) {
    if (!TXID.test(String(sibling))) throw new CheckError("merkle proof contains a malformed hash");
    const s = rev(unhex(sibling));
    node = index % 2 ? dsha(concat(s, node)) : dsha(concat(node, s));
    index = Math.floor(index / 2);
  }
  return node;
}

/** Throws a CheckError unless `txid` sits at `proof.pos` under `headerHex`, whose hash is `blockHash`. */
export function checkInclusion({ txid, proof, headerHex, blockHash }) {
  const header = headerFields(headerHex);
  if (header.hash !== blockHash) fail(`The served header hashes to ${short(header.hash, 8, 8)}, not to block ${short(blockHash, 8, 8)}.`);
  if (!header.meetsTarget) fail("The header hash is above its own difficulty target.");
  const root = merkleRootFromProof(txid, proof.merkle, proof.pos);
  if (!equal(root, header.merkleRoot)) fail("The merkle path does not lead to the merkle root in the block header.");
  return header;
}

/* ------------------------------------------------------ header chain (A-9) */

/**
 * Below this many hashes a forged header chain is cheap: 2^72 double-SHA256 is roughly 1/256 of
 * a mainnet block at 2026 difficulty (about 2^80), weeks of one current ASIC. A receipt says the
 * data source "cannot cheaply forge proof of work" only when the difficulty bounds it checked
 * demand at least this much work.
 */
export const STRONG_FORGE_WORK = 2n ** 72n;

const log2Of = (n) => (n > 0n ? n.toString(2).length - 1 : 0);

/**
 * What a receipt still trusts about the chain (the "A-9:" clause), per network. `hc` is the
 * header check's result: on mainnet the strong wording needs a replay-verified header (level
 * "checkpoint") or difficulty bounds that demand at least STRONG_FORGE_WORK (hc.strong).
 */
export function chainTrustClause(network = NETWORK, hc = null) {
  if (network !== "mainnet") return "signet blocks are valid by a signature that is not checked, and signet proof of work is nearly free";
  if (hc && (hc.level === "checkpoint" || hc.strong === true)) return "the data source can hide blocks but cannot cheaply forge proof of work; your own node removes it";
  if (hc && Number.isInteger(hc.minWorkLog2)) {
    return `the difficulty bounds this far from a pinned checkpoint are weak, so the data source could forge this block with about 2^${hc.minWorkLog2} hashes; your own node or your replay of the pool removes it`;
  }
  return "only the header's own proof of work was checked, which the data source can forge cheaply; your own node or your replay of the pool removes it";
}

/**
 * Builds ctx.headerCheck for verifyTx (docs/design/mainnet-readiness.md §3.6). Levels, best first:
 *   checkpoint  (YOU) the user's own replay verified this block's header from a pinned checkpoint
 *   linked      (BTC) up to `depth` headers above it link to it, meet their own targets and the
 *               difficulty bounds from the nearest pinned checkpoint
 *   bounded     (BTC) its own target is within the bounds from the nearest pinned checkpoint
 *   own-target  (BTC) only its own target (no checkpoint for this network)
 * A header that breaks the bounds, contradicts a pinned checkpoint at its height or sits at a
 * height no honest chain from the checkpoint can have reached by now, and headers above it that
 * do not link or lack their work, throw a CheckError (a data problem: the source served them).
 * A source that cannot answer only lowers the level.
 *
 * The bounds grow 4x per retarget period away from the checkpoint, so far from it they demand
 * little work. With proof-of-work rules the result carries minWorkLog2 (log2 of the least work
 * the checked headers needed under the bounds) and strong (that work >= STRONG_FORGE_WORK);
 * chainTrustClause words the receipt from them.
 *   source            Esplora-like: headers(from, count), tipHeight()
 *   replayHeaderAt(h) -> { hash, baseHeight, linkedAbove? } | null   the user's own verified chain
 *   rules, checkpoints  default: the network's (tests pass their own)
 *   now()             unix seconds for the height ceiling (default: the wall clock)
 */
export function makeHeaderCheck({ network = NETWORK, rules = RULES[network], source = null, replayHeaderAt = null, checkpoints = CHECKPOINTS[network], depth = 6, now = () => Math.floor(Date.now() / 1000) } = {}) {
  const pinnedAt = new Map((checkpoints ?? []).map((c) => [c.height, String(c.hash).toLowerCase()]));
  const pinned = (h, x) => {
    const want = pinnedAt.get(h);
    if (want !== undefined && want !== x.hash) {
      throw new CheckError(`Block #${int(h)} is pinned as ${short(want, 8, 8)} in this release, but the data source served a header for ${short(x.hash, 8, 8)}.`);
    }
  };
  return async ({ height, hash, header }) => {
    if (typeof replayHeaderAt === "function") {
      let own = null;
      try {
        own = await replayHeaderAt(height);
      } catch {
        own = null;
      }
      if (own && own.hash === hash) {
        return {
          level: "checkpoint",
          source: "YOU",
          linkedAbove: Number(own.linkedAbove ?? 0),
          detail: `header chain verified by your replay from pinned checkpoint #${int(own.baseHeight)} (proof of work and difficulty rules)`,
        };
      }
    }
    const d = decodeHeader(header?.bytes ?? header);
    if (d.hash !== hash) throw new CheckError(`The served header hashes to ${short(d.hash, 8, 8)}, not to block ${short(hash, 8, 8)}.`);
    pinned(height, d);
    const cp = rules ? nearestCheckpoint(network, height, checkpoints) : null;
    if (!cp) return { level: "own-target", source: "BTC", linkedAbove: 0, detail: "header meets its own difficulty target" };
    const cpName = `pinned checkpoint #${int(cp.height)}`;
    const ceiling = maxPlausibleHeight(rules, cp, Number(now()));
    if (height > ceiling) {
      throw new CheckError(`The data source places this block at #${int(height)}, but a ${network} chain from ${cpName} cannot have reached past about #${int(ceiling)} by now: the height is not credible.`);
    }
    const pow = rules.validity === "pow";
    let minWork = 0n;
    const bounded = (h, x) => {
      try {
        checkPow(x, rules);
      } catch (e) {
        throw new CheckError(`The header of block #${int(h)} is not valid ${network} proof of work (${e.message}).`);
      }
      const max = maxTargetAt(rules, cp, h);
      if (targetFromBits(x.bits).target > max) {
        throw new CheckError(`The header of block #${int(h)} claims an easier target than any valid ${network} block there can have (bounds from ${cpName}): the data source served a header without the required work.`);
      }
      minWork += workOfTarget(max);
    };
    // With proof-of-work rules: how much work the bounds demanded of the checked headers.
    const strength = (what) => {
      if (!pow) return { extra: "", fields: {} };
      const n = log2Of(minWork);
      const strong = minWork >= STRONG_FORGE_WORK;
      return {
        extra: strong ? `; forging ${what} takes at least about 2^${n} hashes` : `; these bounds are weak this far from the checkpoint: forging ${what} takes only about 2^${n} hashes`,
        fields: { minWorkLog2: n, strong },
      };
    };
    bounded(height, d);
    let tip = null;
    let above = [];
    if (source && typeof source.headers === "function" && typeof source.tipHeight === "function") {
      try {
        tip = Number(await source.tipHeight());
        const k = Math.max(0, Math.min(depth, tip - height));
        above = k > 0 ? (await source.headers(height + 1, k)).map((b) => decodeHeader(b)) : [];
      } catch {
        above = []; // the source could not answer: fall back to the header's own bounds
      }
    }
    if (above.length) {
      let prev = d;
      above.forEach((x, i) => {
        const h = height + 1 + i;
        if (x.prevHash !== prev.hash) throw new CheckError(`The header of block #${int(h)} served by the data source does not link to block #${int(h - 1)}.`);
        pinned(h, x);
        bounded(h, x);
        if (h % rules.interval !== 0) {
          if (x.bits !== prev.bits) throw new CheckError(`The header of block #${int(h)} changes the difficulty inside a retarget period.`);
        } else {
          // Core's exact range: at most 4x easier, and at least the GetCompact re-encoding of a
          // quarter of the old target (which can be slightly below a quarter).
          const a = targetFromBits(prev.bits).target;
          const b = targetFromBits(x.bits).target;
          if (b > a * 4n || b < minRetargetTarget(rules, a)) throw new CheckError(`The header of block #${int(h)} changes the difficulty by more than a factor of 4 at a retarget.`);
        }
        prev = x;
      });
      const n = above.length;
      const s = strength("them");
      return {
        level: "linked",
        source: "BTC",
        linkedAbove: n,
        detail: `${plural(n, "header")} above it link to it, each with valid proof of work within the difficulty bounds from ${cpName}${s.extra}`,
        ...s.fields,
      };
    }
    const s = strength("it");
    return { level: "bounded", source: "BTC", linkedAbove: 0, detail: `its proof of work is within the difficulty bounds from ${cpName}; no headers above it were checked${s.extra}`, ...s.fields };
  };
}

/** Runs ctx.headerCheck; a throw is a data failure of the step (the source served bad headers). */
async function runHeaderCheck(ctx, args) {
  if (typeof ctx.headerCheck !== "function") return null;
  let r;
  try {
    r = await ctx.headerCheck(args);
  } catch (e) {
    fail(e instanceof CheckError ? e.message : `The header check could not finish: ${e?.message ?? e}.`);
  }
  return r && typeof r.detail === "string" ? r : null;
}

/**
 * Serialized size, weight and virtual size of a raw transaction. Bounds-checked: the
 * bytes may come straight from an untrusted data source, so a count that claims more
 * items than the remaining bytes could hold, or any read past the end, throws a
 * CheckError at once instead of looping over a huge declared count.
 */
export function txSizes(bytes) {
  const b = Uint8Array.from(bytes);
  const truncated = () => fail("The served bytes are not a valid transaction: truncated data.");
  let o = 4;
  const need = (n) => {
    if (!(o + n <= b.length)) truncated();
  };
  const varint = () => {
    need(1);
    const n = b[o++];
    if (n < 0xfd) return n;
    const len = n === 0xfd ? 2 : n === 0xfe ? 4 : 8;
    need(len);
    let v = 0;
    for (let i = 0; i < len; i++) v += b[o + i] * 2 ** (8 * i);
    o += len;
    return v;
  };
  // A count of items that each take at least `min` bytes must fit in what is left.
  const count = (min) => {
    const n = varint();
    if (n * min > b.length - o) truncated();
    return n;
  };
  const skip = (n) => {
    need(n);
    o += n;
  };
  need(0);
  const segwit = b[4] === 0 && b[5] === 1;
  if (segwit) skip(2);
  const nIn = count(41); // outpoint 36, script length 1, sequence 4
  for (let i = 0; i < nIn; i++) {
    skip(36);
    skip(varint());
    skip(4);
  }
  const nOut = count(9); // value 8, script length 1
  for (let i = 0; i < nOut; i++) {
    skip(8);
    skip(varint());
  }
  const witStart = o;
  if (segwit) for (let i = 0; i < nIn; i++) for (let k = count(1); k > 0; k--) skip(varint());
  const witLen = segwit ? o - witStart + 2 : 0; // marker and flag count as witness bytes
  const size = b.length;
  const base = size - witLen;
  const weight = base * 3 + size;
  return { size, base, weight, vsize: Math.ceil(weight / 4) };
}

/* -------------------------------------------------- indexer verdict compare */

// Indexer rejection reasons this engine checks itself. Any other reason (spent
// nullifiers, caps, tickers) depends on pool history, which a single
// transaction check cannot see.
const CHECKED_REASONS = [
  /^malformed/,
  /^TRANSACT must not move public value/,
  /^MINT not bound/,
  /^mint amount differs/,
  /^mint closed/,
  /^underpaid/,
  /^anchor outside window/,
  /^duplicate nullifier in envelope/,
  /^invalid proof encoding/,
  /^proof does not verify/,
  /^not a proof-carrying operation/,
  // Mining claims: the window, the terms, the work against the token's floor, the bind and
  // the service fee are all checked here from Bitcoin data.
  /^insufficient work/,
  /^reference outside window/,
  /^underpaid service fee/,
  /^MINE not bound/,
  /^reward differs from terms/,
  /^mining not started/,
  /^mining closed/,
  /^mining ended/,
];

// Per operation, the rules that depend on pool history (an accepted verdict on them is the
// indexer's word unless the user's own replay judged the transaction too).
const HISTORY_RULES = {
  TRANSFER: "the history rules (spent nullifiers) rest",
  MINT: "the history rules (spent nullifiers, mint cap) rest",
  MINT_SCRIPT: "the history rules (spent nullifiers, mint cap) rest",
  DEPLOY: "the history rule (the ticker was still free) rests",
  MINE: "the history rules (spent nullifiers, claimed solutions, supply cap) rest",
  MINE_SCRIPT: "the history rules (spent nullifiers, claimed solutions, supply cap) rest",
  DEPLOY_POW: "the history rule (the ticker was still free) rests",
};

/** "checked" if this engine re-checks the rule behind an indexer rejection, else "history". */
export function classifyReason(reason) {
  return CHECKED_REASONS.some((re) => re.test(String(reason ?? ""))) ? "checked" : "history";
}

/* ------------------------------------------------------------------ engine */

let snarkjsPromise = null;
async function defaultGroth16Verify(vkey, signals, proof) {
  snarkjsPromise ??= import("snarkjs");
  const snarkjs = await snarkjsPromise;
  return snarkjs.groth16.verify(vkey, signals, proof);
}

class Run {
  constructor({ onStep, now }) {
    this.onStep = onStep;
    this.now = now;
    this.steps = [];
    this.failed = null;
  }

  emit(step) {
    const i = this.steps.findIndex((s) => s.id === step.id);
    if (i >= 0) this.steps[i] = step;
    else this.steps.push(step);
    try {
      this.onStep?.({ ...step });
    } catch {
      // A UI listener failing must never change a verification result.
    }
  }

  skip(id, label, source, detail) {
    this.emit({ id, label, source, ok: null, status: "skip", detail, fault: null, ms: null });
  }

  /**
   * Runs one check. `fn` returns { ok?, detail, label?, source?, fault?, value };
   * ok defaults to true, ok null marks the step skipped. A throw is a failure:
   * a rule failure for violation(), a data failure for anything else.
   * Once a check fails, later checks are skipped; the caller decides which
   * steps still run regardless (only the indexer comparison).
   */
  async step(id, label, source, fn, { always = false } = {}) {
    if (this.failed && !always) {
      this.skip(id, label, source, "Skipped: an earlier check failed.");
      return undefined;
    }
    const t0 = this.now();
    this.emit({ id, label, source, ok: null, status: "running", detail: null, fault: null, ms: null });
    let r;
    try {
      r = (await fn()) ?? {};
    } catch (e) {
      r = e instanceof CheckError
        ? { ok: false, detail: e.message, fault: e.rule ? "rule" : "data", source: e.source ?? undefined }
        : { ok: false, detail: `${e?.message ?? e}`, fault: "data" };
    }
    const ok = r.ok === undefined ? true : r.ok;
    const step = {
      id,
      label: r.label ?? label,
      source: r.source ?? source,
      ok,
      status: ok === null ? "skip" : ok ? "ok" : "fail",
      detail: r.detail ?? null,
      fault: ok === false ? (r.fault ?? "data") : null,
      ms: ok === null ? null : this.now() - t0,
    };
    if (ok === false && !this.failed) this.failed = id;
    this.emit(step);
    return r.value;
  }
}

const notFound = (e) => /: 404\b/.test(String(e?.message ?? ""));

/**
 * Verifies the protocol transaction `txid`.
 *
 * ctx:
 *   esplora               Esplora-like client: base, txHex, txStatus, merkleProof, blockHeader, tipHeight
 *   vkeyBytes()           raw bytes of verification_key.json (from /artifacts or disk)
 *   pinnedVkeySha256      default: ARTIFACT_SHA256.vkey from src/pins.json
 *   manifestSha256        default: MANIFEST_SHA256
 *   genesisTxid           default: GENESIS_TXID
 *   anchorRoot(height)    -> { root, source: "YOU"|"IDX", kind: "replay"|"rebuild"|"indexer", detail?, mismatch? } | null
 *   assetInfo(assetId)    -> { deployTxid, ticker, ... } | null  (the indexer's asset list)
 *   indexerVerdict(txid, { height }) -> log entry | null
 *   replayVerdict(txid, { height })  -> log entry from the user's OWN replay of the pool, or null when
 *                         no replay covers that block (optional). With it, history rules (spent
 *                         nullifiers, mint cap, ticker) become a browser result too.
 *   groth16Verify(vkey, publicSignals, proof) -> boolean   default: snarkjs, loaded lazily
 *   powHash(password) -> Promise<Uint8Array(32)>  Argon2id of a mining claim; default src/mine.mjs
 *                         powHash (pages pass a Web Worker, never the main thread)
 *   blockHash(height) -> Promise<hex>   reference block hash; default esplora.blockHash
 *   mineDifficulty(assetId, ref, height, { txid }) -> { dEff, source: "YOU"|"IDX", detail? } | null
 *                         the D_eff a claim had to meet: the user's own replay first, else the
 *                         indexer's log entry (IDX). Default: the indexer's log entry
 *   activations           default ACTIVATIONS (src/pins.json): below the "mining" height, ops 7 - 9
 *                         are unknown ops, as every replayer treats them
 *   mineFee               default MINE_FEE (src/params.mjs), the service-fee constants
 *   headerCheck({ height, hash, header }) -> { level, source, linkedAbove, detail }   optional (A-9):
 *                         how far the block's header is checked beyond its own target (makeHeaderCheck);
 *                         used for the inclusion row and a mining claim's reference block
 *   network               default NETWORK: picks the "A-9:" clause of what is still trusted
 *   onStep(step)          called with every row as it starts and settles
 *   onPlan(opName)        called once the envelope's op is known, before its op-specific rows
 *   now()                 clock in ms (default performance.now)
 *
 * Every step is { id, label, ok (true|false|null), status, source, detail, fault, ms }.
 * fault, on a failed step only: "rule" (this browser saw a rule broken, a real
 * result) or "data" (input missing or inconsistent: the check couldn't finish).
 * Returns { txid, ok, verdict, failedAt, steps, ... } (see the end of this function). Also:
 *   rootSource        "replay" | "rebuild" | "indexer": where the anchor root came from
 *   rootMismatch      true: the indexer's root contradicts its own commitments (verdict "mismatch")
 *   untrustedRootFail true: the proof failed only against a root the indexer supplied (fault "data")
 *   historyFrom       "IDX" | "YOU": who vouched for the history rules behind the indexer's verdict
 */
export async function verifyTx(txid, ctx = {}) {
  const now = ctx.now ?? (() => globalThis.performance?.now?.() ?? Date.now());
  const run = new Run({ onStep: ctx.onStep, now });
  const t0 = now();
  const esplora = ctx.esplora;
  const want = String(txid ?? "").trim().toLowerCase();
  const out = { txid: want, op: null, opName: null, payload: null, env: null, tx: null, raw: null, sizes: null, status: null, header: null };

  if (!TXID.test(want)) {
    await run.step("fetch", "Raw transaction fetched", "BTC", () => fail("Not a txid. A txid is 64 hexadecimal characters."));
    return finish();
  }
  const base = String(esplora?.base ?? "").replace(/^https?:\/\//, "");

  // 1. Raw bytes, straight from the chain source.
  await run.step("fetch", "Raw transaction fetched", "BTC", async () => {
    let h;
    try {
      h = String(await esplora.txHex(want)).trim();
    } catch (e) {
      if (notFound(e)) fail("mempool.space has no transaction with this txid. Check the txid, or wait a minute if it was just broadcast.");
      fail(`Couldn't reach mempool.space (${e.message}). Try again in a minute.`);
    }
    if (!/^([0-9a-f]{2})+$/i.test(h)) fail("mempool.space returned something that isn't raw transaction hex.");
    out.raw = unhex(h.toLowerCase());
    // Bounds-checked (hostile hex must never hang the page). Bytes that don't parse are the
    // next step's finding ("not a valid transaction"), so the fetch itself still succeeded.
    try {
      out.sizes = txSizes(out.raw);
    } catch {
      out.sizes = null;
      return { detail: `${base}/tx/${short(want)}/hex · ${int(out.raw.length)} bytes` };
    }
    return { detail: `${base}/tx/${short(want)}/hex · ${int(out.sizes.size)} bytes · ${int(out.sizes.vsize)} vB` };
  });

  // 2. The bytes really are this transaction.
  await run.step("txid", "Bytes hash to this txid", "YOU", () => {
    let parsed;
    try {
      parsed = parseRawTx(out.raw);
    } catch (e) {
      fail(`The served bytes are not a valid transaction: ${e.message}.`);
    }
    if (parsed.txid !== want) fail(`The bytes hash to ${short(parsed.txid, 8, 8)}, not to the requested txid. The data source served a different transaction.`);
    out.tx = parsed;
    return { detail: `double SHA-256 of the transaction = ${short(want, 8, 8)}` };
  });

  // 3. Where it is: a block, or the mempool.
  await run.step("status", "Mined", "BTC", async () => {
    // The bytes were just fetched by this txid, so the explorer knows it: { confirmed: false }
    // means the mempool here. (/status answers that for an unknown txid too, never a 404.)
    const st = await esplora.txStatus(want);
    let tip = null;
    try {
      tip = await esplora.tipHeight();
    } catch {
      tip = null;
    }
    out.status = { confirmed: Boolean(st?.confirmed), height: st?.block_height ?? null, hash: st?.block_hash ?? null, time: st?.block_time ?? null, tip };
    if (!out.status.confirmed) return { label: "In mempool", detail: "Not in a block yet. Inclusion and the indexer's verdict wait for one." };
    if (!Number.isInteger(out.status.height) || !TXID.test(String(out.status.hash ?? ""))) fail("mempool.space reported a block without a valid height and hash.");
    out.status.confirmations = tip != null && tip >= out.status.height ? tip - out.status.height + 1 : null;
    const conf = out.status.confirmations != null ? ` · ${plural(out.status.confirmations, "confirmation")}` : "";
    return { label: `Mined in #${int(out.status.height)}`, detail: `block ${short(out.status.hash, 8, 8)}${conf}` };
  });

  // 4. Inclusion: merkle path -> header merkle root; header -> block hash and its own target.
  if (!run.failed && out.status && !out.status.confirmed) {
    run.skip("inclusion", "Included in block", "BTC", "Skipped: the transaction is not in a block yet.");
  } else {
    await run.step("inclusion", "Included in block", "BTC", async () => {
      const proof = await esplora.merkleProof(want);
      if (proof?.block_height !== out.status.height) fail(`The merkle proof is for block #${proof?.block_height}, but the transaction status says #${out.status.height}.`);
      const headerHex = await esplora.blockHeader(out.status.hash);
      out.header = checkInclusion({ txid: want, proof, headerHex, blockHash: out.status.hash });
      out.position = proof.pos;
      const path = `merkle path of ${plural(proof.merkle.length, "hash", "hashes")} rebuilds the header's merkle root`;
      const hc = await runHeaderCheck(ctx, { height: out.status.height, hash: out.status.hash, header: out.header });
      out.headerCheck = hc;
      const trust = `A-9: ${chainTrustClause(ctx.network ?? NETWORK, hc)}`;
      if (!hc) return { detail: `${path} · header meets its own difficulty target · header from ${base || "the data source"}, proof-of-work chain not checked · ${trust}` };
      return { detail: `${path} · ${hc.detail} · ${trust}`, source: hc.source === "YOU" ? "YOU" : undefined };
    });
  }

  // 5. The envelope, decoded strictly.
  await run.step("envelope", "Envelope found and decoded strictly", "YOU", () => {
    const payload = findEnvelope(out.tx);
    if (!payload) {
      out.verdictHint = "not-protocol";
      violation("No protocol envelope in this transaction.");
    }
    out.payload = payload;
    out.op = headerOp(payload);
    out.opName = OP_NAME[out.op] ?? "UNKNOWN";
    // The activation rule runs on the header before strict decoding, as in the indexer (D6).
    if (MINING_OPS.has(out.op) && payload[3] === 0 && !miningActive()) {
      out.opName = "UNKNOWN";
      violation(`Malformed envelope: unknown op ${out.op}. Mining is not active at this height, so every replayer ignores it.`);
    }
    let env;
    try {
      env = decodeEnvelope(payload);
    } catch (e) {
      violation(`Malformed envelope: ${e.message}. Every replayer ignores it.`);
    }
    out.env = env;
    const name = OP_NAME[env.op];
    if (env.op === OP.DEPLOY || env.op === OP_DEPLOY_POW) return { detail: `${name} · ${int(payload.length)} bytes · ticker ${env.ticker}` };
    if (env.op === OP.ATTEST) return { detail: `ATTEST · ${int(payload.length)} bytes · kind ${attestKindName(env.kind)}` };
    if (env.op === OP.TRANSACT && (env.publicAmount !== 0n || env.publicAsset !== 0n)) violation("This TRANSACT moves public value, which the rules forbid.");
    if (env.nullifiers[0] === env.nullifiers[1]) violation("Both nullifiers are equal: the envelope tries to spend one note twice.");
    if (isMineOp(env.op)) return { detail: `${name} · ${int(payload.length)} bytes · reference block #${int(env.anchor)}` };
    return { detail: `${name === "TRANSFER" ? "TRANSACT" : name} · ${int(payload.length)} bytes · anchor #${int(env.anchor)}` };
  });

  const env = out.env;
  if (out.opName) {
    try {
      ctx.onPlan?.(out.opName);
    } catch {
      // A UI listener failing must never change a verification result.
    }
  }
  if (env && env.op === OP.DEPLOY) {
    await run.step("deploy", "Terms valid", "YOU", () => ({ detail: deploySummary(env) }));
  } else if (env && env.op === OP_DEPLOY_POW) {
    await run.step("deploy", "Terms valid", "YOU", () => checkDeployPow(env));
  } else if (env && env.op === OP.ATTEST) {
    out.attest = (await run.step("attest", "Attested hash matches the pinned manifest", "YOU", () => checkAttest(env, want, ctx))) ?? null;
  } else if (env && (env.op === OP.TRANSACT || isMint(env.op) || isMineOp(env.op))) {
    await proofSteps(env);
  } else if (!env && out.verdictHint !== "not-protocol") {
    // Plan the rest of the rows as skipped so the transcript stays complete.
    for (const s of planSteps(out.opName ?? "TRANSFER").slice(HEAD.length, -1)) run.skip(s.id, s.label, s.source, "Skipped: an earlier check failed.");
  }

  await run.step(...INDEXER, () => compareIndexer(), { always: true });
  return finish();

  /* ---------- proof-carrying ops ---------- */

  async function proofSteps(env) {
    const bodyLen = out.payload.length - PROOF_LEN;
    await run.step("extdata", "Binding hash recomputed", "YOU", () => {
      const h = bigToBytes(env.extDataHash, 32);
      return { detail: `extDataHash 0x${short(hex(h), 8, 6)} from the ${int(bodyLen)} body bytes; the proof commits to it` };
    });
    out.proof = await run.step("points", "Proof points valid", "YOU", () => {
      try {
        return { value: decodeProof(env.proof), detail: "A, B and C canonical · on the curve · B in the G2 subgroup · no point at infinity" };
      } catch (e) {
        return violation(`Invalid proof encoding: ${e.message}.`);
      }
    });
    const vkey = await run.step("vkey", "Verification key matches the pinned fingerprint", "YOU", async () => {
      const pin = String(ctx.pinnedVkeySha256 ?? ARTIFACT_SHA256?.vkey ?? "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(pin)) fail("No verification key is pinned in this build.");
      if (typeof ctx.vkeyBytes !== "function") fail("No verification key source was provided.");
      const bytes = await ctx.vkeyBytes();
      const got = hex(sha256(bytes));
      if (got !== pin) fail(`The served key hashes to ${short(got, 8, 4)}, but this build pins ${short(pin, 8, 4)}. Don't trust results from this key.`);
      let parsed;
      try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        fail("The verification key is not valid JSON.");
      }
      return { value: parsed, detail: `sha256 ${short(got, 8, 4)} matches the fingerprint pinned in this build` };
    });
    if (isMint(env.op)) await mintSteps(env);
    else if (isMineOp(env.op)) await mineSteps(env);

    const root = await run.step("root", "Anchor root", "IDX", async () => {
      const a = env.anchor;
      const h = out.status?.confirmed ? out.status.height : null;
      // A claim's anchor is its reference block, already checked against the mining window.
      if (h !== null && !isMineOp(env.op) && (a < h - ANCHOR_WINDOW || a > h - MIN_ANCHOR_DEPTH)) {
        // The envelope's anchor against mempool.space's block height: no indexer input.
        violation(`Anchor #${int(a)} is outside the window for block #${int(h)} (the last ${ANCHOR_WINDOW} blocks before it).`, "BTC");
      }
      if (typeof ctx.anchorRoot !== "function") fail("No source for the anchor root was provided.");
      const r = await ctx.anchorRoot(a);
      if (!r || r.root === null || r.root === undefined) fail(`No root is known for anchor #${int(a)}: neither the indexer nor a local replay has it.`);
      const age = h !== null ? `${plural(h - a, "block")} before inclusion · window ${isMineOp(env.op) ? MINE_WINDOW : ANCHOR_WINDOW} · ` : "";
      const src = r.detail ?? (r.kind === "replay" ? "from your own replay" : "reported by our indexer");
      // The indexer's root contradicts its own commitments: a real finding, and one against
      // the indexer, not the transaction. Whatever the indexer says about the transaction,
      // the result is a mismatch (never "agrees", never "Proof failed": no proof was checked).
      if (r.mismatch) {
        out.rootMismatch = true;
        out.disagree = true;
        return { ok: false, fault: "rule", source: r.source ?? "YOU", detail: `#${int(a)} · ${src}` };
      }
      out.rootSource = r.kind ?? (r.source === "YOU" ? "replay" : "indexer");
      out.root = BigInt(r.root);
      return { source: r.source ?? "IDX", value: out.root, detail: `#${int(a)} · ${age}${src}` };
    });

    await run.step("groth16", "Groth16 pairing check", "YOU", async () => {
      const signals = [root, toField(env.publicAmount), env.publicAsset, env.extDataHash, ...env.nullifiers, ...env.commitments].map(String);
      const t = now();
      const verify = ctx.groth16Verify ?? defaultGroth16Verify;
      let ok;
      try {
        ok = await verify(vkey, signals, out.proof);
      } catch (e) {
        fail(`Couldn't run the pairing check: ${e?.message ?? e}. Try again.`);
      }
      out.proofMs = now() - t;
      if (!ok && out.rootSource !== "replay") {
        // Only a root from the user's own replay makes this a browser result. A root the
        // indexer reported, or rebuilt from the indexer's own commitments, may itself be
        // wrong: the proof failing against it says nothing certain about the transaction.
        out.untrustedRootFail = true;
        const whose = out.rootSource === "rebuild" ? "rebuilt from our indexer's commitments" : "reported by our indexer";
        fail(`The proof does not verify against the anchor root ${whose}. That root is the indexer's word, so this is no verdict on the transaction: replay the pool yourself (Verify the Pool) to check the root, then verify again.`);
      }
      if (!ok) violation("The proof does not verify against the pinned key for these exact envelope bytes.");
      return { detail: `valid · ${ms(out.proofMs)}` };
    });
  }

  /** The bind check of MINT / MINT_SCRIPT and MINE / MINE_SCRIPT (`what`: "mint" or "claim"). */
  async function boundStep(env, byOutpoint, what) {
    const first = out.tx.inputs[0]?.outpoint;
    if (byOutpoint) {
      await run.step("bound", "First input is the bound coin", "BTC", () => {
        if (!first) violation("The transaction has no inputs.");
        if (!equal(first, env.bindOutpoint)) violation(`The first input spends ${outpointText(first)}, but the envelope is bound to ${outpointText(env.bindOutpoint)}. A copied ${what} gets nothing.`);
        return { detail: `first input ${outpointText(first)} is the coin the envelope names` };
      });
    } else {
      await run.step("bound", "Spends from the bound address", "BTC", async () => {
        if (!first) violation("The transaction has no inputs.");
        // Mirrors the indexer (SPEC: Coinbase): a coinbase spends no coin, so it has no payer to bind to.
        if (isNullOutpoint(first)) violation(`The first input is a coinbase's null outpoint: a coinbase spends no coin, so this ${what} has no payer to bind to.`);
        const prevTxid = hex(rev(first.slice(0, 32)));
        const vout = readU32le(first, 32);
        let prev;
        try {
          prev = parseRawTx(await esplora.txHex(prevTxid), prevTxid);
        } catch (e) {
          fail(`Couldn't check the spent output ${short(prevTxid)}:${vout}: ${e.message}.`);
        }
        const script = prev.outputs[vout]?.script;
        if (!script) fail(`Output ${short(prevTxid)}:${vout} does not exist.`);
        if (!equal(scriptHashOf(script), env.bindScriptHash)) violation(`The first input does not spend from the address this ${what} is bound to. A copied ${what} gets nothing.`);
        return { detail: `first input spends ${short(prevTxid)}:${vout}; that output's script hashes to the bound address (its transaction bytes checked against their txid)` };
      });
    }
  }

  async function mintSteps(env) {
    const terms = await run.step("terms", "Token terms read from the deploy transaction", "BTC", () => deployTerms(env));
    out.terms = terms ?? null;
    await boundStep(env, env.op === OP.MINT, "mint");
    await run.step("treasury", "Treasury paid in this transaction", "BTC", () => {
      if (!terms) fail("Unknown terms.");
      const paid = terms.treasury.length
        ? out.tx.outputs.filter((o) => equal(o.script, terms.treasury)).reduce((s, o) => s + BigInt(o.value), 0n)
        : 0n;
      out.treasuryPaid = paid;
      if (terms.priceSats === 0n) return { label: "Free mint", detail: "These terms ask no treasury payment." };
      if (paid < terms.priceSats) violation(`Pays ${int(paid)} sats to the treasury; the terms ask ${int(terms.priceSats)}.`);
      return { label: `Treasury paid ${int(paid)} sats in this transaction`, detail: `price ${int(terms.priceSats)} sats · read from this transaction's outputs` };
    });
  }

  /**
   * MINT terms come from the DEPLOY transaction itself: the asset id is
   * (deploy height << 32 | tx index), so the deploy's merkle proof must put it
   * at exactly that height and position. The indexer only names the txid.
   */
  /**
   * The deploy envelope of asset `id`, from the transaction the indexer names, checked to sit at
   * exactly the block and position the id encodes. -> { d, deployTxid, height, index } or, when
   * the indexer names no deploy, { unknown: step result }. `checkOp(d, deployTxid)` runs right
   * after decoding and throws for an envelope of the wrong kind.
   */
  async function deployOf(id, checkOp) {
    const height = Number(id >> 32n);
    const index = Number(id & 0xffffffffn);
    const info = typeof ctx.assetInfo === "function" ? await ctx.assetInfo(id) : null;
    const deployTxid = String(info?.deployTxid ?? "").toLowerCase();
    if (!TXID.test(deployTxid)) {
      return { unknown: { ok: false, source: "IDX", detail: `Unknown token: the indexer lists no deploy for asset ${id} (block #${int(height)}, position ${index}).` } };
    }
    let d;
    try {
      const raw = parseRawTx(await esplora.txHex(deployTxid), deployTxid);
      const payload = findEnvelope(raw);
      d = payload && decodeEnvelope(payload);
    } catch (e) {
      fail(`The deploy transaction ${short(deployTxid)} failed to check: ${e.message}.`);
    }
    checkOp(d, deployTxid);
    const st = await esplora.txStatus(deployTxid);
    const proof = await esplora.merkleProof(deployTxid);
    if (!st?.confirmed || proof.block_height !== height || proof.pos !== index || st.block_height !== height) {
      fail(`The deploy ${short(deployTxid)} is not at block #${int(height)}, position ${index}, where asset ${id} must be written.`);
    }
    checkInclusion({ txid: deployTxid, proof, headerHex: await esplora.blockHeader(st.block_hash), blockHash: st.block_hash });
    return { d, deployTxid, height, index };
  }

  async function deployTerms(env) {
    const id = env.publicAsset;
    const at = await deployOf(id, (d, deployTxid) => {
      if (d?.op === OP_DEPLOY_POW) violation(`Asset ${id} is a mined token (its deploy ${short(deployTxid)} is a DEPLOY_POW): asset is mined. Mined tokens are issued only by MINE claims.`);
      if (!d || d.op !== OP.DEPLOY) fail(`Transaction ${short(deployTxid)} carries no DEPLOY envelope.`);
    });
    if (at.unknown) return at.unknown;
    const { d, deployTxid, height, index } = at;
    if (env.publicAmount !== d.mintAmount) violation(`Mints ${env.publicAmount} units; the terms say ${d.mintAmount} per mint.`);
    // The mint window depends only on the terms and the block height, so it is checked here.
    const mined = out.status?.confirmed ? out.status.height : null;
    let windowNote = "";
    if (mined !== null) {
      if (mined < d.startHeight || (d.endHeight !== 0 && mined > d.endHeight)) {
        violation(`Mined in #${int(mined)}, outside the mint window of the terms (blocks ${d.startHeight ? "#" + int(d.startHeight) : "any"} to ${d.endHeight ? "#" + int(d.endHeight) : "open"}): the mint was closed.`);
      }
      windowNote = " · mint window open";
    }
    out.deployTxid = deployTxid;
    return {
      value: d,
      detail: `${d.ticker} · ${int(d.mintAmount)} per mint · ${int(d.priceSats)} sats · deploy ${short(deployTxid)} at #${int(height)}, position ${index} · amount matches${windowNote}`,
    };
  }

  /* ---------- mining claims (mining.md §5.2) ---------- */

  /** The height whose rules apply: the including block, or the next block for a mempool transaction. */
  function ruleHeight() {
    if (out.status?.confirmed) return out.status.height;
    return Number.isInteger(out.status?.tip) ? out.status.tip + 1 : null;
  }

  /** Whether the mining rules apply at ruleHeight(); an unknown height with a pinned activation: yes. */
  function miningActive() {
    const at = activationHeight("mining", ctx.activations ?? ACTIVATIONS);
    if (at === null || at === undefined) return false;
    const h = ruleHeight();
    return h === null || h >= at;
  }

  function mineFee() {
    return ctx.mineFee !== undefined ? ctx.mineFee : MINE_FEE;
  }

  function feeTo(script, fee) {
    const h = typeof script === "string" ? script : hex(script);
    if (fee && h === String(fee.platformScript).toLowerCase()) return `the platform address${fee.platformAddress ? " " + short(fee.platformAddress, 8, 6) : ""}`;
    return `the deployer's treasury (script ${short(h, 8, 6)})`;
  }

  /** DEPLOY_POW: the structural rules were applied by the strict decoder; the fee policy and the end height here. */
  function checkDeployPow(d) {
    const why = mining.checkFeePolicy(d.claimFeeSats, d.treasury, mineFee());
    if (why) violation(`The terms break the service-fee rule: ${why.replace(/^malformed: /, "")}.`);
    let start = "";
    if (out.status?.confirmed) {
      const mineStart = mining.mineStartOf({ startHeight: d.startHeight, deployHeight: out.status.height });
      if (d.endHeight !== 0 && d.endHeight < mineStart) violation(`Mining would end at #${int(d.endHeight)}, before it starts at #${int(mineStart)}: end before mining start.`);
      start = ` · mining from #${int(mineStart)}`;
    }
    return { detail: `${deployPowSummary(d)}${start}` };
  }

  /**
   * MINE terms come from the DEPLOY_POW transaction itself, at the block and position the asset
   * id encodes. The reference block must lie in the mining period and the claimed amount must
   * be the reward the terms pay at that block.
   */
  async function mineTerms(env) {
    const id = env.publicAsset;
    const ref = env.anchor;
    const at = await deployOf(id, (d, deployTxid) => {
      if (d?.op === OP.DEPLOY) violation(`Asset ${id} is a paid-mint token (its deploy ${short(deployTxid)} is a DEPLOY): asset is not mined.`);
      if (!d || d.op !== OP_DEPLOY_POW) fail(`Transaction ${short(deployTxid)} carries no DEPLOY_POW envelope.`);
    });
    if (at.unknown) return at.unknown;
    const { d, deployTxid, height, index } = at;
    const asset = { ...d, deployHeight: height };
    asset.mineStart = mining.mineStartOf(asset);
    if (ref < asset.mineStart) violation(`References block #${int(ref)}, before mining starts at #${int(asset.mineStart)}: mining not started.`);
    if (d.endHeight !== 0 && ref > d.endHeight) violation(`References block #${int(ref)}, after mining ends at #${int(d.endHeight)}: mining closed.`);
    const reward = mining.rewardAt(asset, ref);
    if (reward === 0n) violation(`The reward at block #${int(ref)} has halved to 0: mining ended.`);
    if (env.publicAmount !== reward) violation(`Claims ${int(env.publicAmount)} units; the terms pay ${int(reward)} at block #${int(ref)}: reward differs from terms.`);
    out.deployTxid = deployTxid;
    return {
      value: asset,
      detail: `${d.ticker} · reward ${int(reward)} at #${int(ref)} · minimum difficulty ${int(d.minDifficulty)} · mining from #${int(asset.mineStart)} · deploy ${short(deployTxid)} at #${int(height)}, position ${index} · reward matches`,
    };
  }

  /** D_eff for this claim: ctx.mineDifficulty, else the indexer's own log entry (IDX), else null. */
  async function difficultyOf(env, ref, height) {
    if (typeof ctx.mineDifficulty === "function") return ctx.mineDifficulty(env.publicAsset, ref, height, { txid: want });
    if (typeof ctx.indexerVerdict !== "function") return null;
    const v = await ctx.indexerVerdict(want, { height });
    if (!v?.ok || v.difficulty === undefined || v.difficulty === null) return null;
    return { dEff: v.difficulty, source: "IDX" };
  }

  async function mineSteps(env) {
    const ref = env.anchor;
    const H = out.status?.confirmed ? out.status.height : null;
    const terms = await run.step("terms", "Mining terms read from the deploy transaction", "BTC", () => mineTerms(env));
    out.terms = terms ?? null;

    await run.step("window", `Reference block inside the ${MINE_WINDOW}-block window`, "YOU", () => {
      if (H === null) return { ok: null, detail: `Not in a block yet: it must land by block #${int(ref + MINE_WINDOW)}, ${MINE_WINDOW} blocks after its reference block #${int(ref)}.` };
      if (ref < H - MINE_WINDOW || ref > H - 1) {
        violation(`Reference block #${int(ref)} is outside the window for block #${int(H)} (the ${MINE_WINDOW} blocks before it): reference outside window.`, "BTC");
      }
      return { detail: `#${int(ref)} · ${plural(H - ref, "block")} before inclusion · window ${MINE_WINDOW}` };
    });

    const refHash = await run.step("refhash", "Reference block hash", "BTC", async () => {
      const read = typeof ctx.blockHash === "function" ? ctx.blockHash : (h) => esplora.blockHash(h);
      let h;
      try {
        h = String(await read(ref)).trim().toLowerCase();
      } catch (e) {
        fail(`Couldn't read the hash of block #${int(ref)}: ${e?.message ?? e}.`);
      }
      if (!TXID.test(h)) fail(`The hash served for block #${int(ref)} is not 64 hexadecimal characters.`);
      let note = "";
      let hc = null;
      if (typeof esplora?.blockHeader === "function") {
        const header = headerFields(await esplora.blockHeader(h));
        if (header.hash !== h) fail(`The served header hashes to ${short(header.hash, 8, 8)}, not to block ${short(h, 8, 8)}.`);
        if (!header.meetsTarget) fail("The reference block's header is above its own difficulty target.");
        note = " · its header hashes to it and meets its own difficulty target";
        hc = await runHeaderCheck(ctx, { height: ref, hash: h, header });
        out.refHeaderCheck = hc;
      }
      const trust = `A-9: ${chainTrustClause(ctx.network ?? NETWORK, hc)}`;
      if (!hc) return { value: h, detail: `block #${int(ref)} · ${short(h, 8, 8)}${note} · proof-of-work chain not checked · ${trust}` };
      return { value: h, detail: `block #${int(ref)} · ${short(h, 8, 8)}${note} · ${hc.detail} · ${trust}` };
    });

    const work = await run.step("work", "Work recomputed (Argon2id)", "YOU", async () => {
      const c = mining.claimPreimage({ asset: env.publicAsset, refHeight: ref, refHash, reward: env.publicAmount, commitments: env.commitments, nonce: env.nonce });
      out.solutionId = c.solutionIdHex;
      const hash = typeof ctx.powHash === "function" ? ctx.powHash : mining.powHash;
      const t = now();
      let h;
      try {
        h = await hash(c.password);
      } catch (e) {
        fail(`Couldn't compute Argon2id: ${e?.message ?? e}. Try again; this says nothing about the claim.`);
      }
      if (!(h instanceof Uint8Array) || h.length !== 32) fail("The Argon2id worker returned something that isn't a 32-byte hash.");
      out.powMs = now() - t;
      out.powHash = hex(h);
      const floor = BigInt(terms.minDifficulty);
      if (!mining.meetsTarget(h, mining.targetOf(floor))) {
        violation(`The hash ${short(out.powHash, 8, 6)} does not meet even the token's minimum difficulty ${int(floor)}: insufficient work. Work done for another reference block or other outputs gives another hash.`);
      }
      return {
        value: h,
        detail: `Argon2id (4 MiB, 1 pass) of the challenge and nonce · hash ${short(out.powHash, 8, 6)} · solution ${short(c.solutionIdHex, 8, 6)} · ${ms(out.powMs)} · meets the token's minimum difficulty ${int(floor)}`,
      };
    });

    await run.step("difficulty", "Difficulty the work must meet", "IDX", async () => {
      if (H === null) return { ok: null, detail: "Not in a block yet: the difficulty depends on the block that includes it." };
      const d = await difficultyOf(env, ref, H);
      if (!d) {
        out.workUnchecked = true;
        return { ok: null, detail: "No difficulty to compare: neither your own replay nor the indexer's log has one for this claim. The work met the token's minimum difficulty." };
      }
      const own = d.source === "YOU";
      if (!own) out.workUnchecked = true;
      let dEff;
      try {
        dEff = BigInt(d.dEff);
      } catch {
        fail("The difficulty source returned something that isn't a whole number.");
      }
      const floor = BigInt(terms.minDifficulty);
      if (dEff < floor || dEff > D_MAX) fail(`The ${own ? "replayed" : "indexer's"} difficulty ${int(dEff)} is outside this token's range (${int(floor)} to ${int(D_MAX)}).`);
      out.difficulty = dEff;
      if (!mining.meetsTarget(work, mining.targetOf(dEff))) {
        if (own) violation(`The work does not meet the difficulty ${int(dEff)} your own replay computed for this claim: insufficient work.`, "YOU");
        out.untrustedWorkFail = true;
        fail(`The work does not meet the difficulty ${int(dEff)} our indexer logged for this claim. That figure is the indexer's word: replay the pool yourself (Verify the Pool) to compute it, then verify again.`);
      }
      const src = d.detail ?? (own ? "computed by your own replay of the pool" : "reported by our indexer's log; your browser didn't compute it (replay the pool to check it yourself)");
      return { source: own ? "YOU" : "IDX", value: dEff, detail: `D_eff ${int(dEff)} · the work meets it · ${src}` };
    });

    await boundStep(env, env.op === OP_MINE, "claim");

    await run.step("fees", "Service fee paid in this transaction", "BTC", () => {
      const fee = mineFee();
      const asset = { claimFeeSats: terms.claimFeeSats, treasury: terms.treasury };
      const need = mining.requiredFeeOutputs(asset, fee);
      if (!need.length) return { label: "No service fee", detail: "These terms and this network ask no service fee." };
      const paid = mining.feeOutputsPaid(asset, out.tx, fee);
      out.servicePaid = paid.paid;
      if (!paid.ok) {
        const s0 = paid.short[0];
        violation(`Pays ${int(s0.paid)} sats to ${feeTo(s0.script, fee)}; the rule asks ${int(s0.need)}: underpaid service fee.`);
      }
      return {
        label: `Service fee paid ${int(paid.paid)} sats in this transaction`,
        detail: `${need.map((g) => `${int(g.sats)} sats to ${feeTo(g.script, fee)}`).join(" · ")} · read from this transaction's outputs`,
      };
    });
  }

  /* ---------- the indexer's verdict, compared ---------- */

  async function compareIndexer() {
    if (!out.status) return { ok: null, detail: "No verdict to compare: the transaction couldn't be loaded." };
    if (!out.status.confirmed) return { ok: null, detail: "Waiting for a block. The indexer judges transactions once they are mined." };
    if (typeof ctx.indexerVerdict !== "function") return { ok: null, detail: "No indexer was asked." };
    let v;
    try {
      v = await ctx.indexerVerdict(want, { height: out.status?.height ?? null });
    } catch (e) {
      return { ok: null, detail: `Couldn't read the indexer's log: ${e.message}` };
    }
    out.indexer = v ?? null;
    const failedStep = run.failed ? run.steps.find((s) => s.id === run.failed) : null;
    if (!v) {
      if (out.verdictHint === "not-protocol") return { ok: true, detail: "No entry, as expected: there is no envelope to judge." };
      return { ok: null, detail: "The indexer has no verdict for this transaction yet. It may still be catching up." };
    }
    const at = Number.isInteger(v.height) ? ` at #${int(v.height)}` : "";
    const said = v.ok ? `Accepted by the indexer${at}` : `Rejected by the indexer${at}: ${v.reason ?? "no reason given"}`;
    if (out.rootMismatch) {
      // Caught in the root step: the indexer's root contradicts its own commitments. No
      // verdict it gives can "agree" with a browser that never got to check the proof.
      return { ok: false, detail: `${said}, but its anchor root differs from your rebuild of its own commitments, so your browser couldn't check the proof. Do not trust this indexer.` };
    }
    if (out.untrustedRootFail) {
      // The proof failed only against a root the indexer supplied. An indexer that accepted
      // the transaction contradicts its own root; a rejection can't be confirmed from here.
      if (v.ok) {
        out.disagree = true;
        return { ok: false, detail: `${said}, but the proof does not verify against the anchor root this same indexer supplied. Do not trust this indexer.` };
      }
      return { ok: null, detail: `${said}. Your browser checked the proof only against the indexer's own anchor root, so it can't confirm this: replay the pool yourself (Verify the Pool) and verify again.` };
    }
    if (out.untrustedWorkFail) {
      // The work failed only the difficulty the indexer itself logged for this claim.
      if (v.ok) {
        out.disagree = true;
        return { ok: false, detail: `${said}, but the work does not meet the difficulty this same indexer logged for the claim. Do not trust this indexer.` };
      }
      return { ok: null, detail: `${said}. Your browser checked the work only against the indexer's own difficulty, so it can't confirm this: replay the pool yourself (Verify the Pool) and verify again.` };
    }
    if (failedStep) {
      // Only a rule this browser saw broken can contradict the indexer. Missing or bad
      // input data (a fetch, the key, the proof library) says nothing about its verdict.
      if (failedStep.fault !== "rule") {
        return { ok: null, detail: `${said}. Your browser couldn't finish its own checks ("${failedStep.label}" didn't get usable data), so this comparison is inconclusive.` };
      }
      if (v.ok) {
        out.disagree = true;
        return { ok: false, detail: `${said}, but your browser's check "${failedStep.label}" failed. Do not trust this indexer.` };
      }
      return { ok: true, detail: `${said}. Agrees with your browser.` };
    }
    // Rules that depend on pool history, which a single-transaction check can't see.
    const history = HISTORY_RULES[out.opName] ?? null;
    const mine = await replayVerdict();
    if (mine) {
      // The user's own replay of the pool judged it: a real browser result for history rules too.
      out.historyFrom = "YOU";
      if (Boolean(mine.ok) !== Boolean(v.ok)) {
        out.disagree = true;
        const own = mine.ok ? "accepts it" : `rejects it: ${mine.reason ?? "no reason given"}`;
        return { ok: false, detail: `${said}, but your own replay of the pool ${own}. Do not trust this indexer.` };
      }
      if (v.ok) return { detail: `Accepted${at} · agrees with your browser and with your own replay of the pool` };
      if (classifyReason(v.reason) === "checked" && !workUnknown(v.reason)) {
        out.disagree = true;
        return { ok: false, detail: `${said}. Your browser checked that rule and it passed. Do not trust this indexer.` };
      }
      out.rejectedByHistory = true;
      return { ok: true, detail: `Rejected${at}: ${v.reason}. Your own replay of the pool rejects it too: ${mine.reason ?? "no reason given"}.` };
    }
    if (v.ok) {
      if (!history) return { detail: `Accepted${at} · agrees with your browser` };
      // Not "agrees": the history rules were never checked here, they are the indexer's word.
      out.historyFrom = "IDX";
      return { detail: `Accepted${at} · agrees with every rule your browser checked; ${history} on the indexer's log (replay the pool to check those too)` };
    }
    if (classifyReason(v.reason) === "checked" && !workUnknown(v.reason)) {
      out.disagree = true;
      return { ok: false, detail: `${said}. Your browser checked that rule and it passed. Do not trust this indexer.` };
    }
    // Neither confirmed nor refuted here: the verdict is the indexer's alone.
    out.rejectedByHistory = true;
    out.historyFrom = "IDX";
    return { ok: null, detail: `Rejected${at}: ${v.reason}. That rule depends on pool history, which your browser can't see; it checked everything else and it passed.` };
  }

  /** True when the indexer blames the work but this browser never learned D_eff itself. */
  function workUnknown(reason) {
    return Boolean(out.workUnchecked) && /^insufficient work/.test(String(reason ?? ""));
  }

  /** The user's own replay's log entry for this transaction, when a replay covers its block. */
  async function replayVerdict() {
    if (typeof ctx.replayVerdict !== "function") return null;
    try {
      const e = await ctx.replayVerdict(want, { height: out.status.height });
      return e && typeof e === "object" && "ok" in e ? e : null;
    } catch {
      return null;
    }
  }

  function finish() {
    const failed = run.steps.find((s) => s.status === "fail") ?? null;
    let verdict;
    if (out.disagree) verdict = "mismatch";
    else if (out.verdictHint === "not-protocol") verdict = "not-protocol";
    else if (failed) verdict = failed.id === "fetch" ? "not-found" : "failed";
    else if (out.status && !out.status.confirmed) verdict = "mempool";
    else if (out.rejectedByHistory) verdict = "rejected";
    else verdict = "verified";
    return {
      ...out,
      ok: !failed,
      verdict,
      failedAt: failed?.id ?? null,
      steps: run.steps.map((s) => ({ ...s })),
      totalMs: now() - t0,
    };
  }
}

function attestKindName(kind) {
  return { [ATTEST_KIND.GENESIS]: "genesis", [ATTEST_KIND.CHECKPOINT]: "checkpoint (reserved)", [ATTEST_KIND.RELEASE]: "release (reserved)" }[kind] ?? String(kind);
}

function checkAttest(env, txid, ctx) {
  const h = hex(env.hash);
  if (env.kind !== ATTEST_KIND.GENESIS) {
    return { label: "Attestation decoded", detail: `${attestKindName(env.kind)} · hash ${short(h, 8, 4)} · nothing interprets this kind yet, and it never changes the pool` };
  }
  const manifest = String(ctx.manifestSha256 ?? MANIFEST_SHA256 ?? "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(manifest)) fail("No circuit manifest is pinned in this build.");
  // Anyone may post an ATTEST and every replayer logs it, so another hash breaks no rule.
  if (h !== manifest) {
    return {
      label: "Attestation names another manifest",
      value: { pinned: false },
      detail: `genesis · names manifest ${short(h, 8, 4)}, not the ${short(manifest, 8, 4)} pinned in this build · anyone can post one; it carries no authority and never changes the pool`,
    };
  }
  const genesis = String(ctx.genesisTxid === undefined ? (GENESIS_TXID ?? "") : (ctx.genesisTxid ?? "")).toLowerCase();
  const pinned = genesis && genesis === txid ? " · this is the genesis transaction pinned in this build" : genesis ? " · not the pinned genesis transaction" : " · no genesis is pinned yet (pre-genesis)";
  return { value: { pinned: true }, detail: `hash ${short(h, 8, 4)} = circuit manifest pinned in this build${pinned}` };
}

function deploySummary(d) {
  const window = d.startHeight || d.endHeight ? ` · blocks ${d.startHeight ? "#" + int(d.startHeight) : "now"} to ${d.endHeight ? "#" + int(d.endHeight) : "open"}` : "";
  return `${d.ticker} · ${d.divisibility} decimals · ${int(d.mintAmount)} × ${int(d.mintCap)} mints · ${int(d.priceSats)} sats each${window}`;
}

function deployPowSummary(d) {
  const window = d.startHeight || d.endHeight ? ` · start ${d.startHeight ? "#" + int(d.startHeight) : "at the deploy block"}, end ${d.endHeight ? "#" + int(d.endHeight) : "open"}` : "";
  const halving = d.halvingInterval ? ` · halving every ${plural(d.halvingInterval, "block")}` : "";
  const fee = d.claimFeeSats ? ` · deployer fee ${int(d.claimFeeSats)} sats` : "";
  return `${d.ticker} · ${d.divisibility} decimals · mined · ${int(d.reward)} per claim · max supply ${int(d.maxSupply)}${halving} · ${int(d.targetPerSpan)} claims per ${int(d.span)} blocks · difficulty ${int(d.initialDifficulty)}, floor ${int(d.minDifficulty)}${fee}${window}`;
}

function outpointText(op) {
  return `${short(hex(rev(op.slice(0, 32))))}:${readU32le(op, 32)}`;
}

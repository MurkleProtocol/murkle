/**
 * Proof X-ray in the browser: wires src/verify-tx.mjs to mempool.space (directly, never through
 * us), the pinned verification key, and an explicit anchor-root source.
 *
 * Root source, best first:
 *   1. your own replay (Verify the Pool) covers the anchor, and its block
 *      there is still the chain's (replay.js replayRootAt)            -> YOU, "replay"
 *   2. rebuild here from the indexer's commitments, compared with its root -> IDX, "rebuild"
 *      (both come from the indexer: a match shows they agree, not that they are Bitcoin's;
 *      a mismatch is your browser catching the indexer, so it fails as YOU)
 *   3. the indexer's /api/roots                                       -> IDX, "indexer"
 * The indexer's roots come from the full list in fixed pages (pool-data rootsAll), never a
 * request for one height: the anchor would tell our indexer which transaction you opened.
 *
 * API
 *   verifyInBrowser(txid, { onStep, onPlan }) -> Promise<result>    see src/verify-tx.mjs
 *   planSteps(opName)                                       re-exported
 *   vkeyBytes() -> Promise<Uint8Array>                       served key bytes, cached
 *   anchorRoot(height) -> Promise<root source | null>
 *   replayVerdict(txid, { height }) -> Promise<entry | null>  your own replay's log entry, when it
 *                                                   covers that block (replay.js replayVerdictAt)
 *   leafIndexOf(commitment) -> Promise<{ leafIndex, height } | null>   from the bulk list
 *   REBUILD_LIMIT                                           above this many outputs, no rebuild
 *   powHashInWorker(password) -> Promise<Uint8Array(32)>   a mining claim's Argon2id, computed in
 *                                                   a Web Worker (pow.worker.js), never on this page's
 *                                                   main thread; a worker failure rejects, never a verdict
 *   mineDifficulty(assetId, ref, height, { txid, entry }) -> Promise<{ dEff, source, detail } | null>
 *                                                   the D_eff a claim had to meet: your own replay's log
 *                                                   entry (YOU), else the indexer's (IDX, its word only)
 *   headerCheck({ height, hash, header }) -> Promise<{ level, source, linkedAbove, detail }>   (A-9)
 *                                                   how far a block's header is checked, best first:
 *                                                   "checkpoint" your own replay verified the header chain
 *                                                   from a pinned checkpoint (YOU); "linked" up to 6 headers
 *                                                   above it from mempool.space link and carry their work;
 *                                                   "bounded" its own work is within the bounds from the
 *                                                   nearest pinned checkpoint; "own-target" nothing more
 */
import { makeHeaderCheck, verifyTx, planSteps } from "../../../src/verify-tx.mjs";
import { hex, unhex } from "../../../src/bytes.mjs";
import * as api from "../api.js";
import { ARTIFACT_SHA256, GENESIS_TXID, MANIFEST_SHA256, NETWORK } from "../config.js";
import { int } from "../ui/format.js";
import { rebuildRoots } from "./rebuild.js";
import { replayHeaderAt, replayRootAt, replayVerdictAt } from "./replay.js";
import { assetById, commitmentsAll, rootsAll, verdictOf } from "./pool-data.js";
import { vkeyBytes } from "./artifacts.js";

export { planSteps, vkeyBytes };
export const REBUILD_LIMIT = 50_000;

async function indexerRoot(height, { fresh = false } = {}) {
  try {
    let r = await rootsAll({ fresh });
    if (!fresh && height > r.height) r = await rootsAll({ fresh: true });
    return r.roots.get(height) ?? null;
  } catch {
    return null;
  }
}

export async function anchorRoot(height) {
  const replay = await replayRootAt(height).catch(() => null);
  if (replay !== null) return { root: replay, source: "YOU", kind: "replay", detail: "from your own replay of raw Bitcoin blocks" };
  let reported = await indexerRoot(height);
  try {
    let data = await commitmentsAll();
    // The cached list must reach the anchor, or the rebuild would miss leaves.
    if (data.height < height) data = await commitmentsAll({ fresh: true });
    const { rows } = data;
    if (data.height >= height && rows.length <= REBUILD_LIMIT) {
      const leaves = [];
      for (const [c, h] of rows) if (h <= height) leaves.push(c);
      const { roots, ms } = await rebuildRoots(leaves, [leaves.length]);
      const local = roots[0];
      const n = `${int(leaves.length)} ${leaves.length === 1 ? "commitment" : "commitments"}`;
      if (reported === null) return { root: local, source: "IDX", kind: "rebuild", detail: `rebuilt in your browser from ${n} served by our indexer (it reports no root to compare)` };
      // A cached page may predate a reorg: re-read once before calling it a mismatch.
      if (local !== String(reported)) reported = (await indexerRoot(height, { fresh: true })) ?? reported;
      if (local !== String(reported)) {
        return { root: local, source: "YOU", kind: "rebuild", mismatch: true, detail: `your rebuild from ${n} differs from the root our indexer reports. Do not trust this indexer.` };
      }
      return { root: local, source: "IDX", kind: "rebuild", detail: `rebuilt in your browser from ${n} served by our indexer in ${Math.round(ms)} ms · matches its root (only a replay checks them against Bitcoin)` };
    }
  } catch {
    // Fall through to the indexer's own claim.
  }
  if (reported !== null) return { root: reported, source: "IDX", kind: "indexer", detail: "reported by our indexer; your browser hasn't rebuilt it" };
  return null;
}

/** The user's own replay's verdict, so the history rules become a browser result; null without one. */
export function replayVerdict(txid, { height = null } = {}) {
  return replayVerdictAt(txid, { height }).catch(() => null);
}

export async function leafIndexOf(commitment) {
  const want = BigInt(commitment);
  const { rows } = await commitmentsAll();
  for (let i = 0; i < rows.length; i++) if (BigInt(rows[i][0]) === want) return { leafIndex: i, height: rows[i][1] };
  return null;
}

/* ---------- mining claims ---------- */

// One module Worker computes every Argon2id hash these pages need (mining.md §8.5). Requests
// queue in it; a crash, an error event or a silent worker rejects them all and the next
// request starts a fresh worker. A rejection is a data failure in the transcript, never a verdict.
const POW_TIMEOUT_MS = 60_000;
let powWorker = null;
let powSeq = 0;
const powWaiting = new Map();

function dropPowWorker(error) {
  const w = powWorker;
  powWorker = null;
  try {
    w?.terminate();
  } catch {
    // Already gone.
  }
  for (const p of powWaiting.values()) p.reject(error);
  powWaiting.clear();
}

function powWorkerOf() {
  if (powWorker) return powWorker;
  if (typeof Worker !== "function") throw new Error("This browser can't run Web Workers, so it can't recompute the work without freezing the page.");
  const w = new Worker(new URL("./pow.worker.js", import.meta.url), { type: "module" });
  w.onmessage = (e) => {
    const m = e.data ?? {};
    const p = powWaiting.get(m.id);
    if (!p) return;
    powWaiting.delete(m.id);
    if (typeof m.powHash === "string" && /^[0-9a-f]{64}$/.test(m.powHash)) p.resolve(unhex(m.powHash));
    else p.reject(new Error(m.error ? String(m.error) : "The Argon2id worker returned no hash."));
  };
  w.onerror = (e) => {
    e?.preventDefault?.();
    dropPowWorker(new Error(e?.message || "The Argon2id worker failed."));
  };
  powWorker = w;
  return w;
}

export function powHashInWorker(password, { timeoutMs = POW_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (!(password instanceof Uint8Array) || password.length !== 40) {
      reject(new TypeError("an Argon2id password is 40 bytes"));
      return;
    }
    let w;
    try {
      w = powWorkerOf();
    } catch (e) {
      reject(e);
      return;
    }
    const id = ++powSeq;
    const timer = setTimeout(() => {
      if (powWaiting.has(id)) dropPowWorker(new Error("The Argon2id worker did not answer in time."));
    }, timeoutMs);
    const done = (fn) => (v) => {
      clearTimeout(timer);
      fn(v);
    };
    powWaiting.set(id, { resolve: done(resolve), reject: done(reject) });
    try {
      w.postMessage({ id, password: hex(password) });
    } catch (e) {
      powWaiting.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

const OWN_DIFFICULTY = "computed by your own replay of raw Bitcoin blocks";
const IDX_DIFFICULTY = "reported by our indexer's log; your browser didn't compute it (replay the pool to check it yourself)";

/**
 * The D_eff a claim had to meet: the user's own replay's log entry for it (YOU), else the public
 * log entry (`entry` when the caller already holds it, else the bulk log filtered here; IDX).
 * Accepted entries carry `difficulty`; anything else gives null.
 */
export async function mineDifficulty(assetId, ref, height, { txid = null, entry = null } = {}) {
  if (!txid) return null;
  const own = await replayVerdictAt(txid, { height }).catch(() => null);
  if (own?.ok && own.difficulty != null) return { dEff: BigInt(own.difficulty), source: "YOU", detail: OWN_DIFFICULTY };
  const v = entry && entry.txid === txid ? entry : await verdictOf(txid, { height }).catch(() => null);
  if (v?.ok && v.difficulty != null) return { dEff: BigInt(v.difficulty), source: "IDX", detail: IDX_DIFFICULTY };
  return null;
}

/* ---------- block headers (A-9) ---------- */

/** The receipt's header check: your own replay's verified chain first, else headers from mempool.space. */
export const headerCheck = makeHeaderCheck({
  network: NETWORK,
  source: api.esplora,
  replayHeaderAt: (height) => replayHeaderAt(height).catch(() => null),
});

export function verifyInBrowser(txid, { onStep, onPlan } = {}) {
  return verifyTx(txid, {
    esplora: api.esplora,
    vkeyBytes,
    pinnedVkeySha256: ARTIFACT_SHA256?.vkey ?? null,
    manifestSha256: MANIFEST_SHA256,
    genesisTxid: GENESIS_TXID,
    anchorRoot,
    assetInfo: (id) => assetById(id),
    indexerVerdict: (t, { height }) => verdictOf(t, { height }),
    replayVerdict,
    powHash: (password) => powHashInWorker(password),
    blockHash: (h) => api.esplora.blockHash(h),
    mineDifficulty,
    headerCheck,
    network: NETWORK,
    onStep,
    onPlan,
  });
}

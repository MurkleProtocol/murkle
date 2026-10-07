/**
 * Verify the Pool, main-thread side: plans a replay, drives the replay
 * Worker, and compares the result with our indexer digest by digest.
 *
 * API
 *   replayPlan() -> Promise<plan>
 *       { key, startHeight, genesis, preGenesis, tip, blocks, avgBlockBytes, estBytes,
 *         saved: { height } | null }   the download estimate comes from mempool.space block sizes
 *       plus, when only a replay of an older digest format is saved: formatChanged: true,
 *       restartNote (REPLAY_RESTART_NOTE, for /verify to show) and oldKeys (deleted on start)
 *   replayKey(startHeight, v = DIGEST_V)    the IndexedDB key; it includes the digest version, so a
 *       release that changes the digest format (mining: v2) restarts saved replays once
 *   class PoolReplay
 *       new PoolReplay({ onProgress, onDone, onPaused, onError })
 *       .start(plan)   .pause()   .running
 *   compareReplay(plan) -> Promise<result>
 *       { ok, height, local, remote, firstDivergence?, component?, text? } compared at the highest
 *       height both sides have. Saves the result next to the snapshot. Throws, saving nothing,
 *       when the indexer can't be read: a failed request is never reported as a difference.
 *   resetReplay(plan) -> Promise<void>        forget the saved replay
 *   loadReplay({ fresh }) -> Promise<{ key, snapshot, spentBy: Map, result } | null>
 *   loadReplaySnapshot() -> Promise<snapshot | null>   Indexer.snapshot() of the last replay
 *       (for a wallet that syncs from your own replay: outputs, nullifiers, roots and assets from raw blocks)
 *   replayRootAt(height) -> Promise<string | null>     decimal root after `height`, or null; null too
 *       when the replay's block at `height` is no longer the chain's (a reorg since the replay),
 *       or the chain's block there can't be read
 *   replaySpentBy(nullifier) -> Promise<string | null> txid that spent a nullifier (decimal)
 *   replayVerdictAt(txid, { height }) -> Promise<entry | null>   the log entry your own replay
 *       wrote for txid in block `height`; null when the replay doesn't cover that block, the block
 *       is no longer the chain's, or the replay has no entry for it there
 *   replayHeaderAt(height) -> Promise<{ hash, baseHeight, linkedAbove } | null>   the block hash at
 *       `height` in your own replay's verified header chain (A-9: linkage, proof of work and the
 *       difficulty rules from a pinned checkpoint); null when the replay doesn't cover it or was
 *       saved before header verification (a v1 record)
 *   replayHeaderStatus() -> HeaderStatus | null   the saved replay's header chain (after loadReplay)
 *
 * The replay worker verifies every block's header before applying it and saves its header chain
 * next to the snapshot ({ v: 2, ..., headers }); progress messages carry
 * headers: { tipHeight, baseHeight, workHex, rules }, and a header failure ends the run with an
 * error whose `code` is the HeaderError code (e.g. "less-work"), never with a verdict.
 */
import * as api from "../api.js";
import { ARTIFACT_SHA256, ESPLORA_API, GENESIS_TXID, ACTIVATION_HEIGHT, MANIFEST_SHA256, NETWORK, PRE_GENESIS, STORAGE_PREFIX, PARAMS } from "../config.js";
import { kvDel, kvGet, kvSet } from "./idb.js";
import { firstDivergence, diagnose, remoteRead } from "./digest-diff.js";
import { logAll as remoteLogAll, logAt as remoteLogAt } from "./pool-data.js";
import { vkeyBytes } from "./artifacts.js";
import { RULES, decodeHeader } from "../../../src/btc/headers.mjs";

const DIGEST_V = PARAMS.DIGEST_V ?? 1;
const digestVersionAt = (h) => (typeof PARAMS.digestVersionAt === "function" ? PARAMS.digestVersionAt(h) : 1);

/** Why a saved replay starts over after an upgrade (shown on /verify). */
export const REPLAY_RESTART_NOTE = "The verifier's digest format changed in this release; the replay starts over once.";

export function replayKey(startHeight, v = DIGEST_V) {
  return `${STORAGE_PREFIX}.replay.v${v}.${PRE_GENESIS ? `pre-genesis-${startHeight}` : GENESIS_TXID}`;
}

/** Saved replays of older digest formats for this start height: [key] (they can't be resumed). */
async function olderReplays(startHeight) {
  const found = [];
  for (let v = 1; v < DIGEST_V; v++) {
    const k = replayKey(startHeight, v);
    const rec = await kvGet(k).catch(() => undefined);
    if (rec?.snapshot) found.push(k);
  }
  return found;
}

async function averageBlockBytes(tip) {
  try {
    const res = await fetch(`${ESPLORA_API}/blocks/${tip}`);
    const list = await res.json();
    const sizes = list.map((b) => Number(b.size)).filter((n) => n > 0);
    return sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : null;
  } catch {
    return null;
  }
}

export async function replayPlan() {
  let startHeight = ACTIVATION_HEIGHT;
  let fromIndexer = false;
  if (PRE_GENESIS) {
    // No genesis is pinned yet, so the start height is the indexer's. Said so in the UI.
    const s = await api.state();
    startHeight = s.startHeight;
    fromIndexer = true;
  }
  const tip = await api.esplora.tipHeight();
  const key = replayKey(startHeight);
  const saved = await loadReplay({ key }).catch(() => null);
  const oldKeys = saved ? [] : await olderReplays(startHeight);
  const from = saved?.snapshot?.height != null ? saved.snapshot.height + 1 : startHeight;
  const blocks = Math.max(0, tip - from + 1);
  const avgBlockBytes = await averageBlockBytes(tip);
  return {
    key,
    startHeight,
    startFromIndexer: fromIndexer,
    genesis: PRE_GENESIS ? null : { txid: GENESIS_TXID, manifestSha256: MANIFEST_SHA256 },
    preGenesis: PRE_GENESIS,
    tip,
    blocks,
    totalBlocks: Math.max(0, tip - startHeight + 1),
    avgBlockBytes,
    estBytes: avgBlockBytes ? Math.round(avgBlockBytes * blocks) : null,
    saved: saved?.snapshot ? { height: saved.snapshot.height, result: saved.result ?? null } : null,
    ...(oldKeys.length ? { formatChanged: true, restartNote: REPLAY_RESTART_NOTE, oldKeys } : {}),
  };
}

export class PoolReplay {
  constructor(handlers = {}) {
    this.h = handlers;
    this.worker = null;
    this.running = false;
  }

  async start(plan) {
    if (this.running) return;
    this.running = true;
    try {
      const bytes = await vkeyBytes();
      this.worker ??= new Worker(new URL("./replay.worker.js", import.meta.url), { type: "module" });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => this.onMessage({ type: "error", message: e.message || "The replay worker failed to start." });
      cache = null;
      // A replay of an older digest format can't be resumed: drop it once the new one starts.
      for (const k of plan.oldKeys ?? []) {
        kvDel(k).catch(() => {});
        kvDel(`${k}.result`).catch(() => {});
      }
      this.worker.postMessage({
        type: "start",
        key: plan.key,
        startHeight: plan.startHeight,
        genesis: plan.genesis,
        vkeyBytes: bytes,
        pin: ARTIFACT_SHA256?.vkey ?? null,
        esploraBase: ESPLORA_API,
        network: NETWORK,
      });
    } catch (e) {
      this.onMessage({ type: "error", message: e.message });
    }
  }

  pause() {
    this.worker?.postMessage({ type: "pause" });
  }

  onMessage(m) {
    if (m.type === "progress") return this.h.onProgress?.(m);
    this.running = false;
    cache = null;
    if (m.type === "done") this.h.onDone?.(m);
    else if (m.type === "paused") this.h.onPaused?.(m);
    else this.h.onError?.(Object.assign(new Error(m.message), { code: m.code ?? null }));
  }

  destroy() {
    this.worker?.terminate();
    this.worker = null;
    this.running = false;
  }
}

/* ---------- saved replay ---------- */

let cache = null;
let cacheKey = null;

export async function loadReplay({ key = null, fresh = false } = {}) {
  let k = key;
  if (!k) {
    if (PRE_GENESIS) {
      const s = await api.state();
      k = replayKey(s.startHeight);
    } else k = replayKey(ACTIVATION_HEIGHT);
  }
  if (!fresh && cache && cacheKey === k) return cache;
  const rec = await kvGet(k);
  const result = await kvGet(`${k}.result`).catch(() => undefined);
  if (!rec?.snapshot) return null;
  cacheKey = k;
  const headers = rec.v >= 2 && rec.headers && typeof rec.headers === "object" ? rec.headers : null;
  cache = { key: k, snapshot: rec.snapshot, spentBy: new Map(rec.spentBy ?? []), result: result ?? null, roots: new Map(rec.snapshot.roots), hashes: new Map(rec.snapshot.hashes ?? []), headers };
  return cache;
}

export async function resetReplay(plan) {
  cache = null;
  await kvDel(plan.key).catch(() => {});
  await kvDel(`${plan.key}.result`).catch(() => {});
}

export async function loadReplaySnapshot() {
  return (await loadReplay().catch(() => null))?.snapshot ?? null;
}

/**
 * The replay's root after block `height`, only while that block is still the chain's: the
 * saved replay stops at the tip it reached, and a reorg since then would leave it holding
 * the old fork's root (a valid transfer would then fail its proof check here). Null sends
 * the caller to the next root source. `replay` and `blockHash` are for tests.
 */
export async function replayRootAt(height, { replay = null, blockHash = (h) => api.esplora.blockHash(h) } = {}) {
  const r = replay ?? (await loadReplay().catch(() => null));
  if (!r) return null;
  const root = r.roots.get(height) ?? null;
  const saved = r.hashes?.get(height) ?? null;
  if (root === null || !saved) return null;
  let live = null;
  try {
    live = String(await blockHash(height)).trim();
  } catch {
    return null;
  }
  return live === saved ? root : null;
}

/**
 * The user's own replay's verdict on `txid`, mined in block `height`: what the verifier engine
 * calls ctx.replayVerdict. With it, the history rules (spent nullifiers, mint cap, a free ticker)
 * are a browser result. Same reorg guard as replayRootAt. `replay` and `blockHash` are for tests.
 */
export async function replayVerdictAt(txid, { height = null, replay = null, blockHash = (h) => api.esplora.blockHash(h) } = {}) {
  if (!Number.isInteger(height)) return null;
  const r = replay ?? (await loadReplay().catch(() => null));
  const snap = r?.snapshot;
  if (!snap || height > snap.height || height < snap.startHeight) return null;
  const saved = r.hashes?.get(height) ?? null;
  if (!saved) return null;
  try {
    if (String(await blockHash(height)).trim() !== saved) return null;
  } catch {
    return null;
  }
  const want = String(txid ?? "").toLowerCase();
  const log = snap.log ?? [];
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.height < height) break;
    if (e.height === height && e.txid === want) return e;
  }
  return null;
}

/**
 * The block hash at `height` in the saved replay's verified header chain. Inside the saved header
 * window it is the header's own hash; below it (down to the base checkpoint) the replay's block
 * hash, which the replay only stored after that block's header verified. `replay` is for tests.
 */
export async function replayHeaderAt(height, { replay = null } = {}) {
  if (!Number.isInteger(height)) return null;
  const r = replay ?? (await loadReplay().catch(() => null));
  const hs = r?.headers;
  if (!hs || !r.snapshot) return null;
  const baseHeight = hs.base?.height;
  const top = Math.min(Number(hs.height), Number(r.snapshot.height));
  if (!Number.isInteger(baseHeight) || height < baseHeight || height > top) return null;
  let hash = null;
  if (height === baseHeight) hash = String(hs.base.hash);
  else if (Number.isInteger(hs.from) && height >= hs.from) {
    const i = (height - hs.from) * 160;
    const slice = String(hs.headersHex ?? "").slice(i, i + 160);
    if (slice.length === 160) hash = decodeHeader(slice).hash;
  }
  hash ??= r.hashes?.get(height) ?? null;
  if (!hash) return null;
  const own = r.hashes?.get(height);
  if (own && own !== hash) return null; // the replay and its header chain disagree: claim nothing
  return { hash, baseHeight, linkedAbove: Number(hs.height) - height };
}

/** The saved replay's header chain as a HeaderStatus, or null (no replay loaded, or a v1 record). */
export function replayHeaderStatus() {
  const hs = cache?.headers;
  if (!hs) return null;
  const network = hs.network ?? NETWORK;
  return {
    verified: true,
    network,
    rules: RULES[network]?.validity ?? null,
    base: { height: hs.base?.height ?? null, hash: hs.base?.hash ?? null },
    tipHeight: hs.height,
    tipHash: hs.hash,
    headers: Math.floor(String(hs.headersHex ?? "").length / 160),
    workHex: hs.workHex,
    lastError: null,
  };
}

export async function replaySpentBy(nullifier) {
  const r = await loadReplay().catch(() => null);
  if (!r || !r.snapshot.nullifiers.includes(String(nullifier))) return null;
  return r.spentBy.get(String(nullifier)) ?? null;
}

/* ---------- comparison with the indexer ---------- */

export async function compareReplay(plan) {
  const r = await loadReplay({ key: plan.key, fresh: true });
  if (!r) throw new Error("No saved replay to compare. Run Verify the Pool first.");
  const snap = r.snapshot;
  const digests = new Map(snap.digests);
  const hashes = new Map(snap.hashes);
  const state = await api.state({ fresh: true });
  const height = Math.min(snap.height, state.height);
  const out = { at: Date.now(), localHeight: snap.height, indexerHeight: state.height, height };
  if (height < snap.startHeight) {
    Object.assign(out, { ok: false, component: "missing", text: "There is no block both sides have processed yet." });
  } else {
    const local = digests.get(height) ?? null;
    // A failed request throws (the caller says "couldn't compare"); only a 404 means missing.
    const remoteRow = await remoteRead(() => api.digest(height));
    const remote = remoteRow?.digest ?? null;
    Object.assign(out, { ok: local !== null && local === remote, local, remote });
    if (!out.ok) {
      const remoteAt = async (h) => (await remoteRead(() => api.digests({ from: h, to: h })))?.[0]?.[1] ?? null;
      const first = await firstDivergence({ lo: snap.startHeight, hi: height, localAt: (h) => digests.get(h) ?? null, remoteAt });
      out.firstDivergence = first;
      if (first !== null) {
        const roots = r.roots;
        // The log cached at page load may end before the diverging block.
        await remoteLogAll({ fresh: true });
        const d = await diagnose({
          height: first,
          local: {
            hashAt: (h) => hashes.get(h) ?? null,
            rootAt: (h) => roots.get(h) ?? null,
            logAt: (h) => snap.log.filter((e) => e.height === h),
          },
          remote: {
            digestAt: (h) => remoteRead(() => api.digest(h)),
            logAt: (h) => remoteLogAt(h),
          },
        });
        Object.assign(out, { component: d.component, text: d.text });
        // A divergence exactly where the digest format changes is a release difference, not a transaction.
        const [va, vb] = [digestVersionAt(first - 1), digestVersionAt(first)];
        if (va !== vb) Object.assign(out, { component: "version", text: `Digest version changes at #${first} (v${va} -> v${vb}): the other side runs a different release.` });
      }
      // /api/digest names its version from v2 on; a different one at the compared height is a release difference too.
      const remoteV = remoteRow?.version ?? 1;
      const localV = digestVersionAt(height);
      if (remote !== null && remoteV !== localV) Object.assign(out, { component: "version", text: `At #${height} this replay computes digest v${localV} and the indexer v${remoteV}: the two sides run different releases.` });
    }
  }
  if (snap.protocol !== state.protocol) Object.assign(out, { ok: false, component: "version", text: "Version mismatch: this replay and the indexer run different protocol versions." });
  await kvSet(`${plan.key}.result`, out).catch(() => {});
  cache = null;
  return out;
}

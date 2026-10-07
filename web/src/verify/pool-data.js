/**
 * Bulk pool data from our indexer, cached for the page session. Privacy rule (api.js): never
 * ask our indexer about one transaction, nullifier or commitment. Every list here is the full
 * public list that every wallet downloads anyway, filtered in this browser.
 *
 * API
 *   commitmentsAll({ fresh }) -> Promise<{ rows: [[commitment, height]], outputs, height, root }>
 *       pinned to one /api/state snapshot (to = state.outputs), so the rows match its root.
 *   logAll({ fresh }) -> Promise<entry[]>        the whole log, fetched in pages, extended
 *                                                incrementally on later calls
 *   logAt(height) -> Promise<entry[]>            entries of one block, filtered locally
 *   verdictOf(txid) -> Promise<entry | null>     the last log entry for txid, filtered locally
 *   nullifiersAll({ fresh }) -> Promise<Set<string>>   decimal strings
 *   outputsAll({ fresh }) -> Promise<output[]>   full outputs (leafIndex, commitment, ciphertext,
 *                                                height, txid); large, used only on demand
 *   assetById(id) -> Promise<asset | null>       from /api/assets
 *   rootsAll({ fresh }) -> Promise<{ roots: Map<height, decimal root>, height }>
 *       every root from the indexer's start to its tip, in fixed pages of ROOTS_PAGE heights,
 *       so the requests are the same whichever transaction a page checks. Cached for 20 s.
 */
import * as api from "../api.js";

// Every cache below holds one indexer's data. Switching indexer (api.setIndexerBase) starts
// them over; a load still in flight keeps writing into the old set only.
let c = null;
function caches() {
  const base = api.indexerBase();
  if (c?.base !== base) c = { base, log: [], roots: new Map(), rootsHeight: null };
  return c;
}

export function commitmentsAll({ fresh = false } = {}) {
  const k = caches();
  if (!fresh && k.commitP && Date.now() - k.commitAt < 20_000) return k.commitP;
  k.commitAt = Date.now();
  k.commitP = (async () => {
    const s = await api.state({ fresh: true });
    const rows = s.outputs > 0 ? await api.commitments({ from: 0, to: s.outputs }) : [];
    return { rows, outputs: s.outputs, height: s.height, root: s.root };
  })().catch((e) => {
    k.commitP = null;
    throw e;
  });
  return k.commitP;
}

export function logAll({ fresh = false } = {}) {
  const k = caches();
  if (k.logP && !fresh) return k.logP;
  const log = k.log;
  k.logP = (async () => {
    let from = log.length;
    for (let guard = 0; guard < 10_000; guard++) {
      const page = await api.log({ from, limit: 500 });
      for (const e of page.items ?? []) if (e.seq === undefined || e.seq >= log.length) log.push(e);
      if (page.next === null || page.next === undefined || !(page.items ?? []).length) break;
      from = page.next;
    }
    return log;
  })().catch((e) => {
    k.logP = null;
    throw e;
  });
  return k.logP;
}

export async function logAt(height) {
  return (await logAll()).filter((e) => e.height === height);
}

export async function verdictOf(txid, { height = null } = {}) {
  let entries = await logAll();
  // Refresh once when the transaction's block is newer than what we hold.
  const last = entries.at(-1);
  if (height !== null && (!last || last.height < height)) entries = await logAll({ fresh: true });
  for (let i = entries.length - 1; i >= 0; i--) if (entries[i].txid === txid) return entries[i];
  return null;
}

export function nullifiersAll({ fresh = false } = {}) {
  const k = caches();
  if (!fresh && k.nullP && Date.now() - k.nullAt < 20_000) return k.nullP;
  k.nullAt = Date.now();
  k.nullP = api.nullifiers().then((list) => new Set(list.map(String))).catch((e) => {
    k.nullP = null;
    throw e;
  });
  return k.nullP;
}

export function outputsAll({ fresh = false } = {}) {
  const k = caches();
  if (k.outP && !fresh) return k.outP;
  k.outP = api.outputs({ from: 0 }).catch((e) => {
    k.outP = null;
    throw e;
  });
  return k.outP;
}

// Same as the server's MAX_RANGE for /api/roots. Pages count from the indexer's start
// height, never from a height a page cares about.
export const ROOTS_PAGE = 2000;
export function rootsAll({ fresh = false } = {}) {
  const k = caches();
  if (!fresh && k.rootsP && Date.now() - k.rootsAt < 20_000) return k.rootsP;
  k.rootsAt = Date.now();
  k.rootsP = (async () => {
    const s = await api.state({ fresh: true });
    const lo = Number.isInteger(s.startHeight) ? s.startHeight - 1 : Math.max(0, s.height - ROOTS_PAGE + 1);
    // Re-read from a page before the last tip seen, so a short reorg can't leave stale roots.
    const redo = k.rootsHeight === null ? lo : Math.max(lo, k.rootsHeight - 100);
    for (let from = lo + Math.floor((redo - lo) / ROOTS_PAGE) * ROOTS_PAGE; from <= s.height; from += ROOTS_PAGE) {
      for (const [h, r] of await api.roots({ from, to: from + ROOTS_PAGE - 1 })) k.roots.set(Number(h), String(r));
    }
    for (const h of k.roots.keys()) if (h > s.height) k.roots.delete(h);
    k.rootsHeight = s.height;
    return { roots: k.roots, height: s.height };
  })().catch((e) => {
    k.rootsP = null;
    throw e;
  });
  return k.rootsP;
}

/**
 * The token with this id: a paid-mint row of /api/assets, else a mined row of /api/mine
 * (normalized to carry `id`). Every row carries `kind`: "mint" or "pow".
 */
export async function assetById(id) {
  const list = await api.assets();
  const row = list.find((a) => String(a.id) === String(id));
  if (row) return { ...row, kind: row.kind ?? "mint" };
  if (typeof api.mine !== "function") return null;
  let mined;
  try {
    mined = await api.mine();
  } catch {
    return null; // an indexer without mining (or a failed read): no mined token to name
  }
  const m = (mined?.assets ?? []).find((a) => String(a.asset ?? a.id) === String(id));
  return m ? { ...m, id: String(m.asset ?? m.id), kind: "pow" } : null;
}

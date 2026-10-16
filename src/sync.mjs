// Catches an Indexer up with the chain through an Esplora API, rolling back
// first if the chain we indexed has been reorganised. Runs in Node and browsers.
//
// With a HeaderChain (src/btc/headers.mjs, audit A-9) every block above the pinned base
// checkpoint has its header verified (linkage, proof of work, difficulty rule, timestamps,
// version, checkpoints) before the indexer applies it, and a reorg is followed only to a
// branch with strictly more work. The header check never changes block data, so it cannot
// change a verdict or a digest; it can only refuse a block (the run stops, nothing is applied).
import { parseBlock } from "./btc/block.mjs";
import { decodeHeader } from "./btc/headers.mjs";

export const SYNC_PREFETCH = 4; // default raw blocks in flight
export const SYNC_PREFETCH_MAX = 16;
export const HEADER_PAGE = 20; // hashes fetched per header page (2 Esplora requests)
export const PAGE_MIN_BLOCKS = 8; // runs shorter than this use blockHash per block (server steady state)

/**
 * The prefetch setting: undefined, null or "" give SYNC_PREFETCH; a whole number from 1 to
 * SYNC_PREFETCH_MAX (a number or a decimal string) gives itself; anything else throws.
 */
export function parsePrefetch(v) {
  if (v === undefined || v === null || v === "") return SYNC_PREFETCH;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1 || n > SYNC_PREFETCH_MAX) {
    throw new Error(`MURKLE_SYNC_PREFETCH must be a whole number from 1 to ${SYNC_PREFETCH_MAX}, not ${v}`);
  }
  return n;
}

/**
 * @param to optional last height to apply (default: the current tip).
 * @param onBlock (height, tip, { hash, bytes, envelopes }) after each block.
 * @param headers optional HeaderChain; null keeps the unverified behaviour exactly.
 * @param prefetch raw blocks downloaded ahead (1 to 16, default 4); used only with `headers`. Blocks
 *   are still checked and applied one at a time, in order.
 * @returns the chain tip seen at the start of the run.
 */
export async function syncIndexer(idx, api, { onBlock, to, headers = null, prefetch } = {}) {
  // MINT_SCRIPT needs the scriptPubKey of the coin a transaction spends.
  idx.prevoutScript ??= (outpoint) => api.prevoutScript(outpoint);
  if (headers) return syncVerified(idx, api, headers, { onBlock, to, k: parsePrefetch(prefetch) });
  let h = idx.height;
  while (idx.hashes.has(h) && (await api.blockHash(h)) !== idx.hashes.get(h)) h--;
  if (h < idx.height) idx.rollbackTo(h);

  const tip = await api.tipHeight();
  const last = to === undefined ? tip : Math.min(tip, to);
  for (let height = idx.height + 1; height <= last; height++) {
    const hash = await api.blockHash(height);
    const raw = await api.rawBlock(hash);
    const block = parseBlock(raw);
    if (block.hash !== hash) throw new Error(`block ${height}: hash mismatch`);
    const prev = idx.hashes.get(height - 1);
    if (prev && block.prevHash !== prev) throw new Error(`reorg at ${height} during sync; run again`);
    const logBefore = idx.log.length;
    await idx.applyBlock({ height, hash, prevHash: block.prevHash, txs: block.txs });
    onBlock?.(height, tip, { hash, bytes: raw.length, envelopes: idx.log.length - logBefore });
  }
  return tip;
}

/**
 * syncIndexer with header verification (docs/design/mainnet-readiness.md §3.4):
 * 1. align the header chain with the indexer (catch up to idx.height, compare hashes); a
 *    disagreement rolls the indexer back to the last height both agree on;
 * 2. a reorg: find the fork against the source, let the header chain take the source's branch
 *    only if it has strictly more work (else HeaderError "less-work" and the indexer is NOT
 *    rolled back), then roll the indexer back to the fork;
 * 3. every new block's header is appended to the chain (verified) before the block is applied.
 * 3a. downloads run ahead: up to `k` raw blocks are fetched while earlier ones are checked and
 *    applied in order. Their hashes come from header pages (unverified; they only name the
 *    download), so every check of step 3 still runs per block, in the same order.
 */
async function syncVerified(idx, api, headers, { onBlock, to, k }) {
  const base = headers.base.height;
  const { mismatchAt } = await headers.alignTo(idx, api);
  if (mismatchAt !== null && mismatchAt <= idx.height) idx.rollbackTo(mismatchAt - 1);

  const tip = await api.tipHeight();
  const top = Math.min(headers.height, tip);
  let f = top;
  while (f > base && headers.has(f) && (await api.blockHash(f)) !== headers.hashAt(f)) f--;
  if (f < top) {
    // offer() refuses a fork point outside the held window, and a lower- or equal-work branch.
    await headers.offer(api, f);
    if (idx.height > f) idx.rollbackTo(f);
  }
  // Heights below the base checkpoint are not header-checked: the plain walk-back covers them.
  if (idx.height < base) {
    let h = idx.height;
    while (idx.hashes.has(h) && (await api.blockHash(h)) !== idx.hashes.get(h)) h--;
    if (h < idx.height) idx.rollbackTo(h);
  }

  const last = to === undefined ? tip : Math.min(tip, to);
  const first = idx.height + 1;
  if (last < first) return tip;
  const feed = blockFeed(api, { from: first, to: last, k, pages: typeof api.headers === "function" && last - first + 1 >= PAGE_MIN_BLOCKS });
  try {
    for (let height = first; height <= last; height++) {
      const { hash, raw } = await feed.take(height);
      const block = parseBlock(raw);
      if (block.hash !== hash) throw new Error(`block ${height}: hash mismatch`);
      const prev = idx.hashes.get(height - 1);
      if (prev && block.prevHash !== prev) throw new Error(`reorg at ${height} during sync; run again`);
      // Verified (or matched against the verified chain) before anything is applied.
      if (height >= base) headers.append(height, block.header);
      const logBefore = idx.log.length;
      await idx.applyBlock({ height, hash, prevHash: block.prevHash, txs: block.txs });
      onBlock?.(height, tip, { hash, bytes: raw.length, envelopes: idx.log.length - logBefore });
    }
  } finally {
    feed.close();
  }
  return tip;
}

/** The effective prefetch window of a source, kept across feeds so a 429 backoff outlives one call. */
const windows = new WeakMap(); // api -> { k, kEff, calm, seen }
function windowFor(api, k) {
  const throttled = api?.throttled ?? 0;
  if (api === null || typeof api !== "object") return { k, kEff: k, calm: 0, seen: throttled };
  let w = windows.get(api);
  if (!w || w.k !== k) {
    w = { k, kEff: k, calm: 0, seen: throttled };
    windows.set(api, w);
  }
  return w;
}

/**
 * Serves { hash, raw } for heights from..to to strictly ascending take() calls, with up to `k`
 * raw blocks downloading ahead (at most `k` fetched but not yet taken, so memory is k x 4 MB).
 * With `pages` the hashes come from api.headers(from, n) pages, which only name what to
 * download: the caller still checks every block against its hash and the chain. A failed or
 * short page falls back to api.blockHash; a failed download throws from take() at its own
 * height. Every 429 the source counts (api.throttled) halves the window (minimum 1) and it
 * grows back by one per 16 blocks; that state is kept per source across feeds, so the next chunk
 * or tick of a throttled source does not start at full width. close() aborts what is still running.
 */
export function blockFeed(api, { from, to, k, pages }) {
  let next = from; // lowest height not yet taken
  const slots = new Map(); // height -> promise, started and not taken; always next..next+size-1
  const hashes = new Map(); // height -> hash, from header pages
  let pageAt = from;
  let page = null; // the page in flight, if any (never rejects)
  let pagesOff = !pages;
  const win = windowFor(api, k); // survives across feeds (browser chunks, server ticks)
  let closed = false;
  const ac = new AbortController();
  const stats = { pages: 0, blockHash: 0, raw: 0, get window() { return win.kEff; } };

  const startPage = () => {
    const lo = pageAt;
    const n = Math.min(HEADER_PAGE, to - lo + 1);
    stats.pages += 1;
    page = (async () => {
      try {
        const list = (await api.headers(lo, n)).slice(0, n);
        if (!list.length) {
          pagesOff = true;
          return;
        }
        list.forEach((bytes, i) => hashes.set(lo + i, decodeHeader(bytes).hash));
        pageAt = lo + list.length;
        if (list.length < n) pagesOff = true; // the tip: the rest via blockHash
      } catch {
        pagesOff = true; // any page failure: fall back, never fatal
      } finally {
        page = null;
      }
    })();
  };

  const hashFor = async (x) => {
    for (;;) {
      if (closed) throw new Error("blockFeed: closed");
      if (hashes.has(x)) return hashes.get(x);
      if (pagesOff || x < pageAt) {
        stats.blockHash += 1;
        return api.blockHash(x);
      }
      if (page === null) startPage();
      await page;
    }
  };

  const fill = () => {
    const t = api.throttled;
    if (typeof t === "number" && t > win.seen) {
      win.seen = t;
      win.kEff = Math.max(1, win.kEff >> 1);
      win.calm = 0;
    }
    while (slots.size < win.kEff) {
      const x = next + slots.size;
      if (x > to) break;
      const p = (async () => {
        const hash = await hashFor(x);
        if (closed) throw new Error("blockFeed: closed");
        stats.raw += 1;
        return { hash, raw: await api.rawBlock(hash, { signal: ac.signal }) };
      })();
      p.catch(() => {}); // no unhandled rejection if it is never taken
      slots.set(x, p);
    }
    if (!pagesOff && page === null && pageAt <= Math.min(to, next + 2 * k)) startPage(); // keep hashes ahead
  };

  return {
    stats,
    async take(h) {
      if (h !== next) throw new Error("blockFeed: out of order");
      fill();
      const p = slots.get(h);
      if (!p) throw new Error(`blockFeed: no block at ${h}`);
      slots.delete(h);
      const r = await p; // rethrows this height's fetch error
      next = h + 1;
      hashes.delete(h);
      if (++win.calm >= 16 && win.kEff < k) {
        win.kEff += 1;
        win.calm = 0;
      }
      if (k > 1) fill(); // refill before the caller parses and applies; k = 1 downloads one block at a time, as before
      return r;
    },
    close() {
      closed = true;
      ac.abort();
      slots.clear();
      hashes.clear();
    },
  };
}

/**
 * Compares this indexer's per-height digests with another source's, in
 * batches over [from, to]. `fetchDigests(from, to)` returns [[height, hex]].
 * Returns { ok: true, upTo } or { ok: false, height, local, remote } for the
 * first height whose digests differ or that only one side has. An empty range
 * (to < from, or a non-numeric bound) compares nothing and returns
 * { ok: false, empty: true }, never a vacuous OK.
 */
export async function compareDigests(idx, fetchDigests, { from = idx.startHeight, to = idx.height, batch = 2000 } = {}) {
  if (!(Number.isInteger(from) && Number.isInteger(to) && to >= from)) return { ok: false, empty: true, from, to };
  let upTo = from - 1;
  for (let lo = from; lo <= to; lo += batch) {
    const hi = Math.min(to, lo + batch - 1);
    const remote = new Map((await fetchDigests(lo, hi)).map(([h, d]) => [Number(h), d]));
    for (let h = lo; h <= hi; h++) {
      const local = idx.digestAt(h);
      const theirs = remote.get(h) ?? null;
      if (local === null || theirs === null || local !== theirs) return { ok: false, height: h, local, remote: theirs };
      upTo = h;
    }
  }
  return { ok: true, upTo };
}

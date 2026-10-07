// Catches an Indexer up with the chain through an Esplora API, rolling back
// first if the chain we indexed has been reorganised. Runs in Node and browsers.
//
// With a HeaderChain (src/btc/headers.mjs, audit A-9) every block above the pinned base
// checkpoint has its header verified (linkage, proof of work, difficulty rule, timestamps,
// version, checkpoints) before the indexer applies it, and a reorg is followed only to a
// branch with strictly more work. The header check never changes block data, so it cannot
// change a verdict or a digest; it can only refuse a block (the run stops, nothing is applied).
import { parseBlock } from "./btc/block.mjs";

/**
 * @param to optional last height to apply (default: the current tip).
 * @param onBlock (height, tip, { hash, bytes, envelopes }) after each block.
 * @param headers optional HeaderChain; null keeps the unverified behaviour exactly.
 * @returns the chain tip seen at the start of the run.
 */
export async function syncIndexer(idx, api, { onBlock, to, headers = null } = {}) {
  // MINT_SCRIPT needs the scriptPubKey of the coin a transaction spends.
  idx.prevoutScript ??= (outpoint) => api.prevoutScript(outpoint);
  if (headers) return syncVerified(idx, api, headers, { onBlock, to });
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
 */
async function syncVerified(idx, api, headers, { onBlock, to }) {
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
  for (let height = idx.height + 1; height <= last; height++) {
    const hash = await api.blockHash(height);
    const raw = await api.rawBlock(hash);
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
  return tip;
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

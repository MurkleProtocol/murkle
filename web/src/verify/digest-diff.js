/**
 * Comparing a local replay with an indexer. Digests are cumulative (rolling
 * accumulators plus the root), so once two replays diverge they stay diverged: the first
 * diverging height can be found by binary search, one tiny request per step.
 *
 * API (pure; every source is injected, so node tests drive it with real Indexers)
 *   firstDivergence({ lo, hi, localAt(h), remoteAt(h) }) -> Promise<number | null>
 *       First height in [lo, hi] whose digests differ (or that only one side has), assuming
 *       they agree below it. null when they agree at hi.
 *   diagnose({ height, local, remote }) -> Promise<{ component, height, text }>
 *       local:  { hashAt(h), rootAt(h), logAt(h) -> [{ txid, ok, op }] }
 *       remote: { digestAt(h) -> { blockHash, root } | null, logAt(h) -> entries }
 *       component: "missing" | "chain" | "root" | "log" | "nullifiers-or-assets"
 *   remoteRead(fn, { tries = 2, pauseMs = 500 }) -> Promise<value | null>
 *       runs one remote read: a 404 is "nothing there" (null); any other error is retried,
 *       then thrown, so a failed request never counts as a differing digest.
 */

export async function remoteRead(fn, { tries = 2, pauseMs = 500 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e?.status === 404) return null;
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
}

export async function firstDivergence({ lo, hi, localAt, remoteAt }) {
  const same = async (h) => {
    const a = await localAt(h);
    const b = await remoteAt(h);
    return a != null && b != null && a === b;
  };
  if (hi < lo || (await same(hi))) return null;
  let good = lo - 1; // highest height known to agree (lo - 1: none yet)
  let bad = hi; // lowest height known to differ
  while (bad - good > 1) {
    const mid = Math.floor((good + bad) / 2);
    if (await same(mid)) good = mid;
    else bad = mid;
  }
  return bad;
}

const key = (e) => `${e.txid}:${e.ok ? 1 : 0}:${e.op}`;

export async function diagnose({ height, local, remote }) {
  const r = await remote.digestAt(height);
  if (!r) return { component: "missing", height, text: `The indexer has no digest for block #${height}. It may be behind, or it started at a different height.` };
  const hash = await local.hashAt(height);
  if (hash && r.blockHash && hash !== r.blockHash) {
    return { component: "chain", height, text: `The indexer followed a different block at #${height}. One side is on another chain, or hasn't processed a reorg yet.` };
  }
  const root = await local.rootAt(height);
  if (root != null && r.root != null && String(root) !== String(r.root)) {
    return { component: "root", height, text: `The note tree differs after block #${height}: an output was added, removed or changed.` };
  }
  const mine = (await local.logAt(height)).map(key);
  const theirs = (await remote.logAt(height)).map(key);
  if (mine.length !== theirs.length || mine.some((k, i) => k !== theirs[i])) {
    const i = mine.findIndex((k, j) => k !== theirs[j]);
    const at = i >= 0 ? (mine[i] ?? theirs[i]).split(":")[0] : null;
    return {
      component: "log",
      height,
      text: `The list of protocol transactions or their verdicts differs in block #${height}${at ? ` (first at tx ${at.slice(0, 8)}…)` : ""}.`,
    };
  }
  return { component: "nullifiers-or-assets", height, text: `Same root and same log at #${height}, so the spent-nullifier set or the token table differs.` };
}

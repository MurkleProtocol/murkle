/**
 * Root Match for the shell (visual.md 6.3): rebuilds the note tree in this browser from the
 * indexer's bulk commitment list and compares the root with the one the indexer reports for
 * the same snapshot. app.js loads this module and calls checkRoot() on idle.
 *
 * API
 *   checkRoot({ api }) -> Promise<{ root, localRoot, height, commitments, ms }>
 *       root and localRoot are decimal strings, as /api/state serves them.
 */
import { rebuildRoots } from "./rebuild.js";
import { commitmentsAll } from "./pool-data.js";

export async function checkRoot() {
  const t0 = performance.now();
  const { rows, height, root } = await commitmentsAll({ fresh: true });
  const { roots } = await rebuildRoots(rows.map((r) => r[0]), [rows.length]);
  return { root: String(root), localRoot: roots[0], height, commitments: rows.length, ms: performance.now() - t0 };
}

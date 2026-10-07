/**
 * Note-tree rebuilds in the browser: the root of the first `count` commitments, computed level
 * by level (about one Poseidon hash per leaf instead of 32), so 10,000 leaves take a fraction
 * of a second. Runs in a module Worker when one is available, inline otherwise.
 *
 * API
 *   zeros(levels) -> bigint[]                   empty-subtree hashes, as in src/core.mjs
 *   rootOfLeaves(leaves, levels = 32) -> bigint
 *   rootsAtCounts(leaves, counts) -> string[]  decimal roots of each prefix (pure; used by the worker)
 *   rebuildRoots(leaves, counts) -> Promise<{ roots: string[], ms, where: "worker" | "inline" }>
 *       leaves: decimal strings or bigints in leaf order.
 */
import { poseidon2 } from "poseidon-lite";
import { TREE_LEVELS } from "../../../src/core.mjs";

const zeroCache = new Map();
export function zeros(levels = TREE_LEVELS) {
  if (!zeroCache.has(levels)) {
    const z = [0n];
    for (let i = 0; i < levels; i++) z.push(poseidon2([z[i], z[i]]));
    zeroCache.set(levels, z);
  }
  return zeroCache.get(levels);
}

export function rootOfLeaves(leaves, levels = TREE_LEVELS) {
  const z = zeros(levels);
  let layer = leaves.map((v) => BigInt(v));
  for (let level = 0; level < levels; level++) {
    if (!layer.length) return z[levels];
    const next = new Array(Math.ceil(layer.length / 2));
    for (let i = 0; i < next.length; i++) next[i] = poseidon2([layer[2 * i], layer[2 * i + 1] ?? z[level]]);
    layer = next;
  }
  return layer[0];
}

export function rootsAtCounts(leaves, counts) {
  return counts.map((n) => rootOfLeaves(leaves.slice(0, n)).toString());
}

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker !== null) return worker;
  try {
    worker = new Worker(new URL("./rebuild.worker.js", import.meta.url), { type: "module" });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.roots);
    };
    worker.onerror = () => {
      // A worker that fails to start: settle everything inline from now on.
      for (const [id, p] of pending) {
        pending.delete(id);
        p.fallback();
      }
      worker = false;
    };
  } catch {
    worker = false;
  }
  return worker;
}

export async function rebuildRoots(leaves, counts) {
  const t0 = performance.now();
  const list = leaves.map(String);
  const inline = () => rootsAtCounts(list, counts);
  const w = typeof Worker === "function" ? getWorker() : false;
  if (!w) return { roots: inline(), ms: performance.now() - t0, where: "inline" };
  const roots = await new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, fallback: () => resolve(inline()) });
    w.postMessage({ id, leaves: list, counts });
  });
  return { roots, ms: performance.now() - t0, where: "worker" };
}

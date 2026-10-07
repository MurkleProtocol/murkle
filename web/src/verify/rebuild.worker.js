// Module Worker: rebuilds note-tree roots off the main thread (see rebuild.js).
import { rootsAtCounts } from "./rebuild.js";

self.onmessage = (e) => {
  const { id, leaves, counts } = e.data;
  try {
    self.postMessage({ id, roots: rootsAtCounts(leaves, counts) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};

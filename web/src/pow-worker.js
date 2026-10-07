// Module worker that grinds the relay anti-spam proof (src/relay-pow.mjs)
// off the main thread. Several workers split the nonce space: worker i tries
// counters i, i + step, i + 2·step, … The page terminates the others once one
// finds a nonce.
//
// in:  { envelope (hex), block (hex), bits, start, step }
// out: { progress: tries } every slice, then { nonce, tries }
import { grind } from "../../src/relay-pow.mjs";

const SLICE = 50_000;

self.onmessage = (e) => {
  const { envelope, block, bits, start = 0, step = 1 } = e.data;
  let tries = 0;
  for (let s = start; ; s += SLICE * step) {
    const r = grind({ envelope, block, bits, start: s, step, limit: SLICE });
    if (r) {
      self.postMessage({ nonce: r.nonce, tries: tries + r.tries });
      return;
    }
    tries += SLICE;
    self.postMessage({ progress: tries });
  }
};

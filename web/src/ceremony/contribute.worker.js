// Web Worker: runs one ceremony contribution off the page's main thread.
// In:  { prev: Uint8Array, name, entropy }   (entropy only ever lives in this message and in snarkjs)
// Out: { type: "log", message } ... then { type: "done", zkey, contributionHash } or { type: "error", message }
import * as snarkjs from "snarkjs";
import { contributeZkey } from "./core.js";

self.onmessage = async (e) => {
  const { prev, name, entropy } = e.data ?? {};
  try {
    const r = await contributeZkey(snarkjs, prev, {
      name,
      entropy,
      onLog: (message) => self.postMessage({ type: "log", message }),
    });
    self.postMessage({ type: "done", zkey: r.zkey, contributionHash: r.contributionHash }, [r.zkey.buffer]);
  } catch (err) {
    self.postMessage({ type: "error", message: err?.message ?? String(err) });
  }
};

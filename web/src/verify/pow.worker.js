// Argon2id for the verifier pages, off the main thread (mining.md §8.5): a module Worker that
// recomputes one claim's proof-of-work hash with src/mine.mjs (hash-wasm after its self-test in
// this worker, the noble reference otherwise). It never decides a verdict; a failure is an error.
//
// Messages in:  { id, password: hex80 }
// Messages out: { id, powHash: hex64, impl } | { id, error: "message" }
import { fastPathState, powHash } from "../../../src/mine.mjs";

const HEX80 = /^[0-9a-f]{80}$/;
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));

self.onmessage = async (e) => {
  const { id, password } = e.data ?? {};
  try {
    if (!HEX80.test(String(password ?? ""))) throw new Error("password must be 80 lowercase hex characters");
    const hash = await powHash(fromHex(password));
    self.postMessage({ id, powHash: toHex(hash), impl: fastPathState().impl });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
};

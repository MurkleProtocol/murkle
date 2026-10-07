// Node worker_threads side of src/pow-pool.mjs. Runs the Argon2 self-test on start, then
// answers one task at a time:
//   -> { type: "ready", ok, impl: "hash-wasm" | "noble" | null }
//   <- { id, type: "hash", passwords: [hex80, …] }      -> { id, ok: true, hashes: [hex64, …] }
//   <- { id, type: "grind", challenge, target, nonceStart, count } -> { id, ok: true, nonce, powHash, tried }
//   any failure                                          -> { id, ok: false, error }
import { parentPort } from "node:worker_threads";
import { hex, unhex } from "./bytes.mjs";
import { grindRange, powHash, selfTest } from "./mine.mjs";

const st = await selfTest().catch(() => ({ ok: false, impl: null }));
parentPort.postMessage({ type: "ready", ok: st.ok, impl: st.impl });

let chain = Promise.resolve();
parentPort.on("message", (msg) => {
  chain = chain.then(() => handle(msg));
});

async function handle(msg) {
  const id = msg?.id;
  try {
    if (!st.ok) throw new Error("Argon2 self-test failed");
    if (msg.type === "hash") {
      const hashes = [];
      for (const p of msg.passwords) hashes.push(hex(await powHash(unhex(p))));
      parentPort.postMessage({ id, ok: true, hashes });
      return;
    }
    if (msg.type === "grind") {
      const r = await grindRange({ challenge: unhex(msg.challenge), target: msg.target, nonceStart: unhex(msg.nonceStart), count: msg.count });
      parentPort.postMessage({ id, ok: true, nonce: r.nonce ? hex(r.nonce) : null, powHash: r.powHash ? hex(r.powHash) : null, tried: r.tried });
      return;
    }
    throw new Error(`unknown task ${msg?.type}`);
  } catch (e) {
    parentPort.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
}

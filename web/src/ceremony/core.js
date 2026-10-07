// The contribution itself, shared by the browser worker (contribute.worker.js) and Node
// (scripts/ceremony/contribute.mjs and the tests). No DOM, no node: imports.
//
// API
//   freshEntropy(extraText = "") -> string   64 bytes from crypto.getRandomValues as hex, plus the
//                                            optional text; snarkjs mixes in 64 more random bytes
//   contributeZkey(snarkjs, prev, { name, entropy, onLog }) -> { zkey: Uint8Array, contributionHash }
//     prev: the downloaded key (Uint8Array); runs snarkjs `zkey contribute` on in-memory files.
//     contributionHash: 128 lowercase hex, the blake2b-512 value snarkjs prints.
//
// The secret of a contribution exists only inside snarkjs while it runs. Nothing here stores,
// sends or shows the entropy.

export function freshEntropy(extraText = "") {
  const b = new Uint8Array(64);
  globalThis.crypto.getRandomValues(b);
  let hex = "";
  for (const x of b) hex += x.toString(16).padStart(2, "0");
  b.fill(0);
  return extraText ? `${hex}:${extraText}` : hex;
}

export async function contributeZkey(snarkjs, prev, { name, entropy, onLog = () => {} } = {}) {
  if (!(prev instanceof Uint8Array) || prev.length < 64) throw new Error("no key to contribute to");
  if (typeof name !== "string" || !name) throw new Error("a contribution needs the name you joined with");
  if (typeof entropy !== "string" || entropy.length < 64) throw new Error("entropy missing");
  const out = { type: "mem" };
  const say = (m) => onLog(String(m));
  const logger = { info: say, warn: say, error: say, debug() {} };
  const hash = await snarkjs.zKey.contribute({ type: "mem", data: prev }, out, name, entropy, logger);
  if (!(hash instanceof Uint8Array) || hash.length !== 64 || !(out.data instanceof Uint8Array)) {
    throw new Error("snarkjs did not produce a contribution");
  }
  let contributionHash = "";
  for (const x of hash) contributionHash += x.toString(16).padStart(2, "0");
  return { zkey: out.data, contributionHash };
}

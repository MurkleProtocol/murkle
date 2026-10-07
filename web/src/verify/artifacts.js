/**
 * Proving artifacts as served by /artifacts, hashed in this browser and compared with the
 * fingerprints pinned in this build (src/pins.json) and recorded at build time (facts.json).
 *
 * API
 *   ARTIFACT_LIST    [{ name, file, pinKey, factsKey, auto, what }]
 *   vkeyBytes() -> Promise<Uint8Array>             cached served verification key bytes
 *   sha256Hex(bytes) -> Promise<string>            WebCrypto when available, noble otherwise
 *   fingerprint(name) -> Promise<{ name, bytes, sha256, pinned, facts, matchesPin, matchesFacts, ms }>
 */
import { sha256 } from "@noble/hashes/sha256";
import * as api from "../api.js";
import { ARTIFACT_SHA256, MANIFEST_SHA256 } from "../config.js";
import facts from "../facts.json";

export const ARTIFACT_LIST = [
  { name: "vkey", file: "verification_key.json", pinKey: "vkey", factsKey: "vkey", auto: true, what: "Verification key: what every proof is checked against." },
  { name: "manifest", file: "manifest.json", pinKey: null, factsKey: null, auto: true, what: "Build manifest: the hashes of every artifact, anchored by the genesis attestation." },
  { name: "wasm", file: "transaction.wasm", pinKey: "wasm", factsKey: "wasm", auto: false, what: "Witness generator: compiled from the circuit; anyone can rebuild it with circom 2.2.2." },
  { name: "zkey", file: "transaction.zkey", pinKey: "zkey", factsKey: "zkey", auto: false, what: "Proving key: from the single-party development setup (A-8)." },
];

let vkeyP = null;
export function vkeyBytes() {
  vkeyP ??= api.artifact("verification_key.json", { as: "bytes" }).catch((e) => {
    vkeyP = null;
    throw e;
  });
  return vkeyP;
}

const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(bytes) {
  if (globalThis.crypto?.subtle) return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
  return toHex(sha256(bytes));
}

export async function fingerprint(name) {
  const a = ARTIFACT_LIST.find((x) => x.name === name);
  if (!a) throw new Error(`Unknown artifact ${name}.`);
  const t0 = performance.now();
  const bytes = a.name === "vkey" ? await vkeyBytes() : await api.artifact(a.file, { as: "bytes" });
  const hash = await sha256Hex(bytes);
  const pinned = a.name === "manifest" ? MANIFEST_SHA256 ?? null : ARTIFACT_SHA256?.[a.pinKey] ?? null;
  const fromFacts = a.name === "manifest" ? facts.manifest?.sha256 ?? null : facts.artifacts?.[a.factsKey]?.sha256 ?? null;
  return {
    name,
    file: a.file,
    bytes: bytes.length,
    sha256: hash,
    pinned,
    facts: fromFacts,
    matchesPin: pinned ? hash === pinned : null,
    matchesFacts: fromFacts ? hash === fromFacts : null,
    ms: performance.now() - t0,
  };
}

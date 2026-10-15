#!/usr/bin/env node
// Generates test/fixtures/gpu-vectors.json: 32 deterministic MURK passwords with their Argon2id tags,
// the vectors the GPU miner is tested against (docs/design/mining.md section 12.2, gpu/README.md).
// Every tag is computed with @noble/hashes (the reference) and checked against hash-wasm (the fast
// path) before the file is written. The first 16 entries are copied into src/gpu.mjs
// (GPU_SELF_TEST_VECTORS); test/gpu-protocol.test.mjs checks that copy against the file.
//
// Usage: node scripts/gpu-vectors.mjs [--check] [--print-embedded]
//   --check            do not write; exit 1 when the file on disk differs from a fresh run
//   --print-embedded   print the first 16 entries as the GPU_SELF_TEST_VECTORS source
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { concat, hex, u32le, u64le } from "../src/bytes.mjs";
import { fastPathState, passwordOf, powHash, powHashReference, selfTest } from "../src/mine.mjs";

export const VECTORS_FILE = fileURLToPath(new URL("../test/fixtures/gpu-vectors.json", import.meta.url));
export const EMBEDDED_COUNT = 16;
const LABEL = new TextEncoder().encode("murkle/gpu-vectors/v1");
const U64 = (1n << 64n) - 1n;

/** Deterministic bytes: sha256(label || block counter), block after block. */
function stream() {
  let n = 0;
  return (len) => {
    const out = new Uint8Array(len);
    for (let o = 0; o < len; o += 32) out.set(sha256(concat(LABEL, u32le(n++))).subarray(0, Math.min(32, len - o)), o);
    return out;
  };
}

/** The 32 passwords, in order: nonce edge cases, all-zero and all-ones, then random ones. */
export function vectorPasswords() {
  const next = stream();
  const out = [];
  const add = (name, challenge, nonce) => out.push({ name, password: passwordOf(challenge, u64le(nonce)) });
  const edges = [["nonce-0", 0n], ["nonce-1", 1n], ["nonce-u32-max", 0xffffffffn], ["nonce-2^32", 1n << 32n], ["nonce-2^63", 1n << 63n], ["nonce-u64-max", U64]];
  for (const [name, nonce] of edges) add(name, next(32), nonce);
  add("all-zero", new Uint8Array(32), 0n);
  add("all-ones", new Uint8Array(32).fill(0xff), U64);
  for (let i = 0; out.length < 32; i++) {
    const b = next(8);
    add(`random-${i}`, next(32), new DataView(b.buffer).getBigUint64(0, true));
  }
  return out;
}

export async function buildVectors() {
  const st = await selfTest();
  if (!st.ok || fastPathState().impl !== "hash-wasm") throw new Error("hash-wasm must pass its self-test to generate the GPU vectors");
  const vectors = [];
  for (const { name, password } of vectorPasswords()) {
    const tag = powHashReference(password);
    const fast = await powHash(password);
    if (hex(tag) !== hex(fast)) throw new Error(`noble and hash-wasm disagree on ${name}`);
    vectors.push({ name, password: hex(password), tag: hex(tag) });
  }
  return {
    format: "murkle-gpu-vectors/1",
    argon2: { type: "argon2id", version: 19, memoryKiB: 4096, passes: 1, lanes: 1, tagLength: 32, salt: "murkle/mine/salt" },
    generatedBy: "@noble/hashes 1.8.0 argon2id (reference), each tag checked against hash-wasm 4.12.0",
    vectors,
  };
}

const embedded = (file) =>
  file.vectors
    .slice(0, EMBEDDED_COUNT)
    .map((v) => `  Object.freeze({\n    name: "${v.name}",\n    password: "${v.password}",\n    powHash: "${v.tag}",\n  }),`)
    .join("\n");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const file = await buildVectors();
  const text = `${JSON.stringify(file, null, 2)}\n`;
  if (args.includes("--print-embedded")) console.log(embedded(file));
  else if (args.includes("--check")) {
    let disk = "";
    try {
      disk = readFileSync(VECTORS_FILE, "utf8");
    } catch {
      // missing file: reported below
    }
    if (disk !== text) {
      console.error("test/fixtures/gpu-vectors.json is missing or out of date; run: node scripts/gpu-vectors.mjs");
      process.exit(1);
    }
    console.log("test/fixtures/gpu-vectors.json is up to date");
  } else {
    writeFileSync(VECTORS_FILE, text);
    console.log(`wrote ${file.vectors.length} vectors to test/fixtures/gpu-vectors.json`);
  }
}

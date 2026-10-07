import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import { bn254 } from "@noble/curves/bn254";
import { MerkleTree, buildTxInput, pubkeyOf, randomField } from "../src/core.mjs";
import { encodeProof, decodeProof, PROOF_LEN } from "../src/proof-codec.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const ASSET = (840000n << 32n) | 7n;

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

let proof, publicSignals;

test("a real proof survives the 128-byte round trip and still verifies", async () => {
  const input = buildTxInput({
    tree: new MerkleTree(), asset: ASSET, inputs: [],
    outputs: [{ amount: 5n, pubkey: pubkeyOf(randomField()), blinding: randomField() }],
    publicAmount: 5n, publicAsset: ASSET, extDataHash: randomField(),
  });
  ({ proof, publicSignals } = await snarkjs.groth16.fullProve(input, "build/transaction_js/transaction.wasm", "build/dev/transaction.zkey"));
  const bytes = encodeProof(proof);
  assert.equal(bytes.length, PROOF_LEN);
  const back = decodeProof(bytes);
  assert.deepEqual([back.pi_a, back.pi_b, back.pi_c], [proof.pi_a, proof.pi_b, proof.pi_c]);
  assert.equal(await snarkjs.groth16.verify(VKEY, publicSignals, back), true);
});

test("rejects the point at infinity and off-curve x", () => {
  const bytes = encodeProof(proof);
  const inf = Uint8Array.from(bytes);
  inf[0] |= 0x40;
  assert.throws(() => decodeProof(inf), /infinity/);
  // x with no square root of x^3 + 3: walk until one is found.
  const bad = Uint8Array.from(bytes);
  for (let i = 0; i < 50; i++) {
    bad[31] = i;
    try { decodeProof(bad); } catch { return; }
  }
  assert.fail("no invalid x found");
});

test("rejects non-canonical coordinates (x >= p)", () => {
  const bytes = encodeProof(proof);
  bytes.fill(0x3f, 0, 1);
  bytes.fill(0xff, 1, 32);
  assert.throws(() => decodeProof(bytes));
});

test("rejects a G2 point that is on the curve but outside the prime-order subgroup", () => {
  // snarkjs' own validity check (on-curve only) would accept this point.
  const G2 = bn254.G2.ProjectivePoint ?? bn254.G2.Point;
  const { Fp2 } = bn254.fields;
  const B2 = (() => { const { x, y } = G2.BASE.toAffine(); return Fp2.sub(Fp2.sqr(y), Fp2.mul(Fp2.sqr(x), x)); })();
  let x0 = 1n, point;
  for (;;) {
    const x = Fp2.fromBigTuple([x0++, 1n]);
    let y;
    try { y = Fp2.sqrt(Fp2.add(Fp2.mul(Fp2.sqr(x), x), B2)); } catch { continue; }
    point = { x, y };
    if (!G2.fromAffine(point).isTorsionFree()) break;
  }
  const bytes = encodeProof({
    ...proof,
    pi_b: [[point.x.c0, point.x.c1], [point.y.c0, point.y.c1], [1n, 0n]],
  });
  assert.throws(() => decodeProof(bytes), /subgroup/);
});

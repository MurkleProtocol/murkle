// End-to-end circuit tests: real Groth16 proofs against the dev setup.
// Run `npm run circuit:build` first.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import { MerkleTree, buildTxInput, pubkeyOf, randomField, toField, FIELD } from "../src/core.mjs";

const WASM = "build/transaction_js/transaction.wasm";
const ZKEY = "build/dev/transaction.zkey";
const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));

const ASSET = (840000n << 32n) | 7n; // asset id = (deploy height, tx index)
const OTHER_ASSET = (840001n << 32n) | 1n;

const party = () => {
  const sk = randomField();
  return { sk, pk: pubkeyOf(sk) };
};
const alice = party();
const bob = party();
const tree = new MerkleTree();

async function prove(input) {
  const t = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const ms = Date.now() - t;
  return { proof, publicSignals, ms };
}

const rejects = (input) => assert.rejects(snarkjs.groth16.fullProve(input, WASM, ZKEY));

// Applies an accepted transaction to the tree the way the indexer will.
const apply = (input) => input.outputCommitment.map((c) => tree.insert(BigInt(c)));

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

let aliceNote, bobNote, aliceChange;

test("mint: 100 units of ASSET enter the pool as a private note for Alice", async () => {
  const out = { amount: 100n, pubkey: alice.pk, blinding: randomField() };
  const input = buildTxInput({
    tree, asset: ASSET, inputs: [], outputs: [out],
    publicAmount: 100n, publicAsset: ASSET, extDataHash: randomField(),
  });
  const { proof, publicSignals, ms } = await prove(input);
  assert.equal(await snarkjs.groth16.verify(VKEY, publicSignals, proof), true);
  console.log(`  proving time: ${ms} ms`);

  // Public signal order is the indexer's contract with the circuit.
  assert.deepEqual(publicSignals, [
    input.root, input.publicAmount, input.publicAsset, input.extDataHash,
    ...input.inputNullifier, ...input.outputCommitment,
  ]);

  const [leaf] = apply(input);
  aliceNote = { amount: 100n, sk: alice.sk, blinding: out.blinding, leafIndex: leaf };
});

test("mint rejects inflation (output > publicAmount)", async () => {
  await rejects(buildTxInput({
    tree, asset: ASSET, inputs: [], outputs: [{ amount: 101n, pubkey: alice.pk, blinding: randomField() }],
    publicAmount: 100n, publicAsset: ASSET, extDataHash: randomField(),
  }));
});

test("mint rejects minting one asset while naming another", async () => {
  await rejects(buildTxInput({
    tree, asset: OTHER_ASSET, inputs: [], outputs: [{ amount: 100n, pubkey: alice.pk, blinding: randomField() }],
    publicAmount: 100n, publicAsset: ASSET, extDataHash: randomField(),
  }));
});

test("private transfer: Alice pays Bob 60, keeps 40 change; asset stays hidden", async () => {
  const toBob = { amount: 60n, pubkey: bob.pk, blinding: randomField() };
  const change = { amount: 40n, pubkey: alice.pk, blinding: randomField() };
  const input = buildTxInput({
    tree, asset: ASSET, inputs: [aliceNote], outputs: [toBob, change], extDataHash: randomField(),
  });
  assert.equal(input.publicAsset, "0");
  const { proof, publicSignals } = await prove(input);
  assert.equal(await snarkjs.groth16.verify(VKEY, publicSignals, proof), true);

  // A proof must not verify against a different envelope.
  const tampered = [...publicSignals];
  tampered[3] = randomField().toString();
  assert.equal(await snarkjs.groth16.verify(VKEY, tampered, proof), false);

  const [l0, l1] = apply(input);
  bobNote = { amount: 60n, sk: bob.sk, blinding: toBob.blinding, leafIndex: l0 };
  aliceChange = { amount: 40n, sk: alice.sk, blinding: change.blinding, leafIndex: l1 };
});

test("transfer rejects spending someone else's note", async () => {
  const stolen = { ...bobNote, sk: alice.sk };
  await rejects(buildTxInput({
    tree, asset: ASSET, inputs: [stolen], outputs: [{ amount: 60n, pubkey: alice.pk, blinding: randomField() }],
    extDataHash: randomField(),
  }));
});

test("transfer rejects the same note used as both inputs", async () => {
  await rejects(buildTxInput({
    tree, asset: ASSET, inputs: [bobNote, bobNote], outputs: [{ amount: 120n, pubkey: bob.pk, blinding: randomField() }],
    extDataHash: randomField(),
  }));
});

test("transfer rejects a negative output disguised as a huge field element", async () => {
  await rejects(buildTxInput({
    tree, asset: ASSET, inputs: [bobNote],
    outputs: [
      { amount: FIELD - 10n, pubkey: alice.pk, blinding: randomField() },
      { amount: 70n, pubkey: bob.pk, blinding: randomField() },
    ],
    extDataHash: randomField(),
  }));
});

test("transfer rejects a note claimed under the wrong asset", async () => {
  await rejects(buildTxInput({
    tree, asset: OTHER_ASSET, inputs: [bobNote], outputs: [{ amount: 60n, pubkey: bob.pk, blinding: randomField() }],
    extDataHash: randomField(),
  }));
});

test("unshield: Bob withdraws 60, but cannot sweep Alice's change with his key", async () => {
  const input = buildTxInput({
    tree, asset: ASSET, inputs: [bobNote], outputs: [],
    publicAmount: -60n, publicAsset: ASSET, extDataHash: randomField(),
  });
  assert.equal(input.publicAmount, toField(-60n).toString());
  const { proof, publicSignals } = await prove(input);
  assert.equal(await snarkjs.groth16.verify(VKEY, publicSignals, proof), true);

  // Bob cannot also withdraw Alice's change with his own key.
  await rejects(buildTxInput({
    tree, asset: ASSET, inputs: [bobNote, { ...aliceChange, sk: bob.sk }], outputs: [],
    publicAmount: -100n, publicAsset: ASSET, extDataHash: randomField(),
  }));
});

// Regression tests for audit findings (audit/REPORT.md).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FIELD } from "../src/core.mjs";
import { OP, encodeTxBody, encodeDeploy, decodeEnvelope, envelopeLen } from "../src/envelope.mjs";
import { parseBlock } from "../src/btc/block.mjs";

const ct = () => new Uint8Array(95);
const txEnvelope = (nullifiers) =>
  new Uint8Array([
    ...encodeTxBody({ op: OP.TRANSACT, anchor: 1, nullifiers, commitments: [1n, 2n], ciphertexts: [ct(), ct()] }),
    ...new Uint8Array(128),
  ]);

test("A-1: a nullifier aliased as n + r is rejected at parse time (no second spend of the same note)", () => {
  assert.doesNotThrow(() => decodeEnvelope(txEnvelope([5n, 6n])));
  assert.throws(() => decodeEnvelope(txEnvelope([5n + FIELD, 6n])), /non-canonical/);
});

test("A-2: DEPLOY rejects a mintAmount that MINT's i64 publicAmount cannot carry", () => {
  const terms = { ticker: "BIG", divisibility: 0, mintCap: 1, priceSats: 0n, treasury: new Uint8Array() };
  assert.doesNotThrow(() => encodeDeploy({ ...terms, mintAmount: (1n << 63n) - 1n }));
  assert.throws(() => encodeDeploy({ ...terms, mintAmount: 1n << 63n }), /i64/);
});

test("MINT_SCRIPT carries a 32-byte payer script hash and is 503 bytes", () => {
  const bindScriptHash = new Uint8Array(32).fill(9);
  const body = encodeTxBody({ op: OP.MINT_SCRIPT, anchor: 1, publicAsset: 5n, publicAmount: 10n, bindScriptHash, nullifiers: [1n, 2n], commitments: [3n, 4n], ciphertexts: [ct(), ct()] });
  const env = decodeEnvelope(new Uint8Array([...body, ...new Uint8Array(128)]));
  assert.equal(body.length + 128, envelopeLen(OP.MINT_SCRIPT));
  assert.equal(envelopeLen(OP.MINT_SCRIPT), 503);
  assert.deepEqual(env.bindScriptHash, bindScriptHash);
  assert.throws(() => encodeTxBody({ op: OP.MINT_SCRIPT, anchor: 1, nullifiers: [1n, 2n], commitments: [3n, 4n], ciphertexts: [ct(), ct()] }), /bindScriptHash/);
});

test("A-3: a block whose transactions do not match the header merkle root is rejected", () => {
  const raw = Buffer.from(readFileSync("test/fixtures/signet-324500.bin"));
  raw[raw.length - 1] ^= 1; // last tx's locktime: structure intact, txid changes
  assert.throws(() => parseBlock(raw), /merkle root mismatch/);
});

test("the mrk magic keeps every envelope size: TRANSACT 471, MINT 507, MINT_SCRIPT 503, ATTEST 38", () => {
  assert.deepEqual(
    [OP.TRANSACT, OP.MINT, OP.MINT_SCRIPT, OP.ATTEST].map(envelopeLen),
    [471, 507, 503, 38],
  );
  const env = txEnvelope([5n, 6n]);
  assert.equal(new TextDecoder().decode(env.subarray(0, 3)), "mrk");
  assert.equal(env.length, 471);
  const old = Uint8Array.from(env);
  old.set(new TextEncoder().encode("zkp"), 0);
  assert.throws(() => decodeEnvelope(old), /bad magic/);
});

// Full protocol flow on synthetic blocks: deploy -> paid mints -> private
// transfer -> wallet discovery, plus replay, tampering, cap and reorg cases.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { deriveKeys } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf, ANCHOR_WINDOW } from "../src/indexer.mjs";
import { encodeDeploy, opReturnScript, findEnvelope, scriptHashOf } from "../src/envelope.mjs";
import { hex } from "../src/bytes.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const START = 900000;
const TREASURY = new Uint8Array([0x51, 0x20, ...randomBytes(32)]); // P2TR script
const PRICE = 5000n;
const MINT_AMOUNT = 1000n;

const idx = new Indexer({ vkey: VKEY, startHeight: START });
const alice = new Wallet(deriveKeys(randomBytes(32)));
const bob = new Wallet(deriveKeys(randomBytes(32)));
const carol = new Wallet(deriveKeys(randomBytes(32)));
let ASSET;

const coinbase = { txid: "coinbase", inputs: [], outputs: [] };
const carrier = (envelope, extra = [], firstInput = randomBytes(36)) => ({
  txid: randomBytes(32).toString("hex"),
  inputs: [{ outpoint: firstInput }],
  outputs: [{ script: opReturnScript(envelope), value: 0n }, ...extra],
});
// A MINT proven against a fresh UTXO, carried by the transaction that spends it.
async function mintTx(wallet, extra) {
  const utxo = randomBytes(36);
  const env = await wallet.mint(idx, { asset: ASSET, mintAmount: MINT_AMOUNT, bindOutpoint: utxo });
  return carrier(env, extra, utxo);
}
const pay = (sats) => [{ script: TREASURY, value: sats }];
const mine = (txs) => idx.applyBlock({ height: idx.height + 1, txs: [coinbase, ...txs] });
const verdict = (tx) => idx.log.find((l) => l.txid === tx.txid);

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test("DEPLOY registers an asset id = (height, tx index); a duplicate ticker is rejected", async () => {
  const deploy = carrier(encodeDeploy({ ticker: "ZKTEST", divisibility: 0, mintAmount: MINT_AMOUNT, mintCap: 2, priceSats: PRICE, treasury: TREASURY }));
  await mine([deploy]);
  ASSET = assetIdOf(START, 1);
  assert.equal(idx.assets.get(ASSET).ticker, "ZKTEST");

  const dup = carrier(encodeDeploy({ ticker: "ZKTEST", divisibility: 0, mintAmount: 1n, mintCap: 1, priceSats: 0n, treasury: new Uint8Array() }));
  await mine([dup]);
  assert.match(verdict(dup).reason, /already deployed/);
});

test("paid MINT is accepted; an underpaid one in the same block is rejected", async () => {
  const ok = await mintTx(alice, pay(PRICE));
  const cheap = await mintTx(carol, pay(PRICE - 1n));
  await mine([ok, cheap]);
  assert.equal(verdict(ok).ok, true);
  assert.match(verdict(cheap).reason, /underpaid/);
  assert.equal(alice.scan(idx).balance(ASSET), MINT_AMOUNT);
  assert.equal(carol.scan(idx).balance(ASSET), 0n);
});

test("A-6: a MINT copied from the mempool into another transaction is rejected; the original still lands", async () => {
  const original = await mintTx(bob, pay(PRICE));
  // The attacker spends their own UTXO, pays the treasury, and gets mined first.
  const copy = carrier(findEnvelope(original), pay(PRICE));
  await mine([copy, original]);
  assert.match(verdict(copy).reason, /not bound/);
  assert.equal(verdict(original).ok, true);
  assert.equal(bob.scan(idx).balance(ASSET), MINT_AMOUNT);
});

test("the mint cap is enforced in block order", async () => {
  const late = await mintTx(carol, pay(PRICE));
  await mine([late]);
  assert.match(verdict(late).reason, /cap reached/);
  assert.equal(idx.assets.get(ASSET).minted, 2);
  assert.equal(idx.assets.get(ASSET).pool, 2n * MINT_AMOUNT);
});

test("A-6 (MINT_SCRIPT): a mint bound to the payer's script lands; a copy funded from another address does not", async () => {
  await mine([carrier(encodeDeploy({ ticker: "ZKSCRIPT", divisibility: 0, mintAmount: 50n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() }))]);
  const asset = idx.tickers.get("ZKSCRIPT");
  const payerScript = new Uint8Array([0x00, 0x14, ...randomBytes(20)]);
  const prevouts = new Map();
  idx.prevoutScript = async (outpoint) => prevouts.get(hex(outpoint));

  const env = await carol.mint(idx, { asset, mintAmount: 50n, bindScriptHash: scriptHashOf(payerScript) });
  const own = randomBytes(36);
  const other = randomBytes(36);
  prevouts.set(hex(own), payerScript);
  prevouts.set(hex(other), new Uint8Array([0x00, 0x14, ...randomBytes(20)]));
  const copy = carrier(env, [], other);
  const original = carrier(env, [], own);
  await mine([copy, original]); // the copy is mined first
  assert.match(verdict(copy).reason, /not bound to this payer/);
  assert.equal(verdict(original).ok, true);
  assert.equal(carol.scan(idx).balance(asset), 50n);
});

let transferTx, rootAfterTransfer, transferBlock;

test("private transfer: Bob discovers 600 from Alice, Alice keeps 400 change", async () => {
  alice.scan(idx);
  transferTx = carrier(await alice.transfer(idx, { asset: ASSET, amount: 600n, to: bob.address }));
  transferBlock = { height: idx.height + 1, txs: [coinbase, transferTx] };
  await idx.applyBlock(transferBlock);
  assert.equal(verdict(transferTx).ok, true, verdict(transferTx).reason);
  rootAfterTransfer = idx.tree.root();

  assert.equal(alice.scan(idx).balance(ASSET), 400n);
  assert.equal(bob.scan(idx).balance(ASSET), 1600n);
  assert.equal(alice.notes.filter((n) => n.spent).length, 1);
});

test("replaying the same envelope is rejected as a double spend", async () => {
  const replay = { ...transferTx, txid: randomBytes(32).toString("hex") };
  await mine([replay]);
  assert.match(verdict(replay).reason, /already spent/);
});

test("flipping one ciphertext byte breaks the proof binding", async () => {
  bob.scan(idx);
  const env = await bob.transfer(idx, { asset: ASSET, amount: 100n, to: alice.address });
  env[200] ^= 1; // inside noteCiphertext[0]
  const tampered = carrier(env);
  await mine([tampered]);
  assert.match(verdict(tampered).reason, /does not verify/);
});

test("an infinity-flagged proof point is rejected before verification", async () => {
  const env = await bob.transfer(idx, { asset: ASSET, amount: 100n, to: alice.address });
  env[env.length - 128] |= 0x40;
  const bad = carrier(env);
  await mine([bad]);
  assert.match(verdict(bad).reason, /invalid proof encoding/);
});

test("reorg: rolling back the transfer block restores balances and root; re-applying is identical", async () => {
  const rootBefore = idx.roots.get(transferBlock.height - 1);
  idx.rollbackTo(transferBlock.height - 1);
  assert.equal(idx.tree.root(), rootBefore);
  assert.equal(alice.scan(idx).balance(ASSET), 1000n);
  assert.equal(bob.scan(idx).balance(ASSET), 1000n);

  await idx.applyBlock(transferBlock);
  assert.equal(idx.tree.root(), rootAfterTransfer);
  assert.equal(bob.scan(idx).balance(ASSET), 1600n);
});

test("snapshot -> JSON -> restore reproduces the exact state", async () => {
  const restored = Indexer.restore(JSON.parse(JSON.stringify(idx.snapshot())), { vkey: VKEY });
  assert.equal(restored.tree.root(), idx.tree.root());
  assert.equal(restored.height, idx.height);
  assert.deepEqual([...restored.nullifiers], [...idx.nullifiers]);
  assert.equal(restored.assets.get(ASSET).minted, 2);
  assert.equal(new Wallet(bob.keys).scan(restored).balance(ASSET), bob.scan(idx).balance(ASSET));
});

test("an envelope anchored more than W blocks ago is rejected", async () => {
  bob.scan(idx);
  const env = await bob.transfer(idx, { asset: ASSET, amount: 50n, to: alice.address });
  for (let i = 0; i < ANCHOR_WINDOW; i++) await mine([]);
  const stale = carrier(env);
  await mine([stale]);
  assert.match(verdict(stale).reason, /anchor outside window/);
});

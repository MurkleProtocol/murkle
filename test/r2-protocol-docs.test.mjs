// Protocol and docs fixes, second review round: a MINT_SCRIPT carried in a coinbase (whose only
// input is the null outpoint) is rejected as "MINT not bound to this payer"
// without a prevout lookup, so no replayer stalls on that block. Plain MINT,
// DEPLOY and TRANSACT in a coinbase keep their usual verdicts.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { deriveKeys } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { encodeDeploy, opReturnScript, scriptHashOf } from "../src/envelope.mjs";
import { isNullOutpoint, parseBlock } from "../src/btc/block.mjs";
import { hex, outpointOf } from "../src/bytes.mjs";
import { Relayer } from "../server/relayer.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const hash32 = () => randomBytes(32).toString("hex");
const NULL_OUTPOINT = Uint8Array.from([...new Uint8Array(32), 0xff, 0xff, 0xff, 0xff]);

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const opReturn = (envelope) => ({ script: opReturnScript(envelope), value: 0n });
/** A coinbase as parseBlock returns it: one input, the null outpoint. */
const coinbase = (envelope) => ({ txid: hash32(), inputs: [{ outpoint: NULL_OUTPOINT }], outputs: envelope ? [opReturn(envelope)] : [] });
const carrier = (envelope, first = randomBytes(36)) => ({ txid: hash32(), inputs: [{ outpoint: first }], outputs: [opReturn(envelope)] });

test("isNullOutpoint matches only the null outpoint, which is every real coinbase's only input", () => {
  assert.equal(isNullOutpoint(NULL_OUTPOINT), true);
  assert.equal(isNullOutpoint(Buffer.from(NULL_OUTPOINT)), true);
  assert.equal(isNullOutpoint(new Uint8Array(36)), false, "zero txid, vout 0");
  assert.equal(isNullOutpoint(outpointOf("00".repeat(32), 0xfffffffe)), false);
  assert.equal(isNullOutpoint(randomBytes(36)), false);
  assert.equal(isNullOutpoint(NULL_OUTPOINT.subarray(0, 35)), false);
  assert.equal(isNullOutpoint(undefined), false);

  const block = parseBlock(readFileSync("test/fixtures/signet-324500.bin"));
  assert.equal(block.txs[0].inputs.length, 1);
  assert.equal(isNullOutpoint(block.txs[0].inputs[0].outpoint), true, "the fixture's coinbase");
  assert.ok(block.txs.slice(1).every((t) => t.inputs.every((i) => !isNullOutpoint(i.outpoint))));
});

test("23: a coinbase MINT_SCRIPT is rejected without a prevout lookup and the block applies; MINT, DEPLOY and TRANSACT in a coinbase are unaffected", async () => {
  const START = 700000;
  const idx = new Indexer({ vkey: VKEY, startHeight: START });
  const payerScript = new Uint8Array([0x00, 0x14, ...randomBytes(20)]);
  const payerCoin = randomBytes(36);
  const lookups = [];
  // Answers like Esplora: the null outpoint's "transaction" never resolves.
  idx.prevoutScript = async (outpoint) => {
    lookups.push(hex(outpoint));
    if (hex(outpoint) === hex(payerCoin)) return payerScript;
    throw new Error(`prevout ${hex(outpoint)} not found`);
  };
  const entry = (tx) => idx.log.find((l) => l.txid === tx.txid);

  // DEPLOY in a coinbase: accepted, asset id (height, index 0).
  const deployCb = coinbase(encodeDeploy({ ticker: "CBASE", divisibility: 0, mintAmount: 50n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() }));
  await idx.applyBlock({ height: START, hash: hash32(), txs: [deployCb] });
  assert.equal(entry(deployCb).ok, true);
  const ASSET = assetIdOf(START, 0);
  assert.equal(idx.assets.get(ASSET).ticker, "CBASE");

  // MINT_SCRIPT in a coinbase: rejected, no lookup, and the rest of the block applies.
  const carol = new Wallet(deriveKeys(randomBytes(32)));
  const env = await carol.mint(idx, { asset: ASSET, mintAmount: 50n, bindScriptHash: scriptHashOf(payerScript) });
  const mintCb = coinbase(env);
  const later = carrier(encodeDeploy({ ticker: "AFTER", divisibility: 0, mintAmount: 1n, mintCap: 1, priceSats: 0n, treasury: new Uint8Array() }));
  const rejectedBefore = idx.stats.rejected;
  await idx.applyBlock({ height: START + 1, hash: hash32(), txs: [mintCb, later] });
  assert.deepEqual(lookups, [], "the null outpoint is never looked up");
  assert.equal(idx.height, START + 1);
  assert.ok(idx.digestAt(START + 1));
  assert.deepEqual(
    { ok: entry(mintCb).ok, opName: entry(mintCb).opName, reason: entry(mintCb).reason },
    { ok: false, opName: "MINT_SCRIPT", reason: "MINT not bound to this payer" },
  );
  assert.equal(idx.stats.rejected, rejectedBefore + 1);
  assert.equal(idx.assets.get(ASSET).minted, 0);
  assert.equal(idx.nullifiers.size, 0);
  assert.equal(entry(later).ok, true, "a later transaction in the same block still applies");

  // The same envelope from the payer's own coin lands: the coinbase copy consumed nothing.
  const own = carrier(env, payerCoin);
  await idx.applyBlock({ height: START + 2, hash: hash32(), txs: [coinbase(), own] });
  assert.equal(entry(own).ok, true, entry(own).reason);
  assert.deepEqual(lookups, [hex(payerCoin)]);
  assert.equal(carol.scan(idx).balance(ASSET), 50n);

  // Plain MINT in a coinbase: its bound coin is not the first input, so it is rejected, with no lookup.
  const bound = randomBytes(36);
  const mint = await new Wallet(deriveKeys(randomBytes(32))).mint(idx, { asset: ASSET, mintAmount: 50n, bindOutpoint: bound });
  const plainCb = coinbase(mint);
  await idx.applyBlock({ height: START + 3, hash: hash32(), txs: [plainCb] });
  assert.equal(entry(plainCb).ok, false);
  assert.equal(entry(plainCb).reason, "MINT not bound to this transaction");
  assert.equal(lookups.length, 1);

  // TRANSACT in a coinbase: accepted as from any other carrier.
  const bob = new Wallet(deriveKeys(randomBytes(32)));
  const transferCb = coinbase(await carol.transfer(idx, { asset: ASSET, amount: 20n, to: bob.address }));
  await idx.applyBlock({ height: START + 4, hash: hash32(), txs: [transferCb] });
  assert.equal(entry(transferCb).ok, true, entry(transferCb).reason);
  assert.equal(bob.scan(idx).balance(ASSET), 20n);
  assert.equal(carol.scan(idx).balance(ASSET), 30n);
  assert.equal(lookups.length, 1);
});

test("23: replayers with and without a prevout resolver agree on a coinbase MINT_SCRIPT", async () => {
  const START = 710000;
  const ASSET = assetIdOf(START, 1);
  const deploy = carrier(encodeDeploy({ ticker: "AGREE", divisibility: 0, mintAmount: 7n, mintCap: 3, priceSats: 0n, treasury: new Uint8Array() }));
  const b0 = { height: START, hash: hash32(), txs: [coinbase(), deploy] };
  const a = new Indexer({ vkey: VKEY, startHeight: START });
  const b = new Indexer({ vkey: VKEY, startHeight: START });
  a.prevoutScript = async () => {
    throw new Error("GET /tx/0000000000000000000000000000000000000000000000000000000000000000/hex: 404");
  };
  await a.applyBlock(b0);
  await b.applyBlock(b0);
  const env = await new Wallet(deriveKeys(randomBytes(32))).mint(a, { asset: ASSET, mintAmount: 7n, bindScriptHash: scriptHashOf(new Uint8Array([0x51, 0x20, ...randomBytes(32)])) });
  const b1 = { height: START + 1, hash: hash32(), txs: [coinbase(env)] };
  await a.applyBlock(b1);
  await b.applyBlock(b1);
  assert.equal(a.digestAt(START + 1), b.digestAt(START + 1));
  assert.deepEqual(a.log.at(-1), b.log.at(-1));
  assert.equal(a.log.at(-1).reason, "MINT not bound to this payer");
});

// The design docs state what the code does (round 2 verifier notes).
test("relayer.md 'Explorer errors' names every answer statusOf counts as not found", async () => {
  const statusOf = (err) => Relayer.prototype.statusOf.call({ esplora: { txStatus: async () => { throw err; } } }, "ab".repeat(32));
  assert.equal(await statusOf(new Error("GET /tx/x/status: 404 Transaction not found")), null);
  assert.equal(await statusOf(new Error("Transaction not found")), null, "no status code");
  assert.equal(await statusOf(new Error("no such transaction")), null);
  assert.equal(await statusOf(new Error("GET /tx/x/status: 429 Too Many Requests")), undefined);
  assert.equal(await statusOf(new Error("GET /tx/x/status: 503 Service Unavailable")), undefined);
  assert.equal(await statusOf(new TypeError("fetch failed")), undefined);
  const para = readFileSync("docs/design/relayer.md", "utf8").split("\n").find((l) => l.startsWith("**Explorer errors.**"));
  for (const s of ["404", '"not found"', '"no such"', "429", "5xx", "network"]) assert.ok(para.includes(s), s);
  assert.doesNotMatch(readFileSync("docs/design/relayer.md", "utf8"), /[Oo]nly a 404/);
});

test("visual.md lists both /api/roots forms; the receipt uses pages only", () => {
  const md = readFileSync("docs/design/visual.md", "utf8");
  assert.match(md, /`GET \/api\/roots\?from&to`: at most 2000 heights/);
  assert.match(md, /`GET \/api\/roots\?height=H`[^\n]*the receipt never does/);
  for (const f of ["web/src/views/receipt.js", "web/src/verify/engine.js", "web/src/verify/pool-data.js"]) {
    assert.doesNotMatch(readFileSync(f, "utf8"), /roots\?height/, f);
  }
});

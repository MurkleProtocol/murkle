import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseBlock, parseRawTx } from "../src/btc/block.mjs";
import { Esplora } from "../src/btc/esplora.mjs";
import { btcAccount, planCarrierTx, signLocal } from "../src/btc/funding.mjs";
import { outpointOf } from "../src/bytes.mjs";

test("parses a real signet block: hash and every txid match the explorer", () => {
  const raw = readFileSync("test/fixtures/signet-324500.bin");
  const expected = JSON.parse(readFileSync("test/fixtures/signet-324500.json", "utf8"));
  const block = parseBlock(raw);
  assert.equal(block.hash, expected.hash);
  assert.deepEqual(block.txs.map((t) => t.txid), expected.txids);
});

test("outpointOf matches the input encoding found in a real block", () => {
  const block = parseBlock(readFileSync("test/fixtures/signet-324500.bin"));
  const tx = block.txs[1];
  const { outpoint } = tx.inputs[0];
  const txid = Buffer.from(outpoint.slice(0, 32)).reverse().toString("hex");
  const vout = Buffer.from(outpoint.slice(32)).readUInt32LE();
  assert.deepEqual(outpointOf(txid, vout), outpoint);
});

test("rejects a truncated block", () => {
  const raw = readFileSync("test/fixtures/signet-324500.bin");
  assert.throws(() => parseBlock(raw.subarray(0, raw.length - 1)));
});

// A signed segwit (P2TR) transaction built offline: txid known from the signer.
function signedTx() {
  const key = randomBytes(32);
  const account = btcAccount(key);
  const utxo = { txid: randomBytes(32).toString("hex"), vout: 1, value: 50_000 };
  const { tx } = planCarrierTx({ account, utxos: [utxo], envelope: new Uint8Array([1, 2, 3]), feeRate: 1 });
  return { ...signLocal(tx, key), account, utxo };
}

test("parseRawTx recomputes the txid of a segwit transaction and checks it", () => {
  const { hex: raw, txid, account, utxo } = signedTx();
  const tx = parseRawTx(raw, txid);
  assert.equal(tx.txid, txid);
  assert.deepEqual(tx.inputs[0].outpoint, outpointOf(utxo.txid, utxo.vout));
  assert.deepEqual(tx.outputs.at(-1).script, account.script);
  assert.deepEqual(parseRawTx(Buffer.from(raw, "hex")).txid, txid);
  assert.throws(() => parseRawTx(raw, "00".repeat(32)), /txid mismatch/);
  assert.throws(() => parseRawTx(raw + "00"), /trailing bytes/);
  assert.throws(() => parseRawTx(raw.slice(0, -2)), /truncated/);
});

test("prevoutScript reads /tx/:txid/hex and rejects bytes that do not hash to the outpoint's txid (A-9)", async () => {
  const real = signedTx();
  const other = signedTx();
  const served = new Map([[real.txid, real.hex]]);
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const m = String(url).match(/\/tx\/([0-9a-f]{64})\/hex$/);
    const body = m && served.get(m[1]);
    return body ? new Response(body) : new Response("not found", { status: 404 });
  };
  try {
    const api = new Esplora("https://esplora.invalid/api");
    const script = await api.prevoutScript(outpointOf(real.txid, 1));
    assert.deepEqual(script, real.account.script);
    assert.equal(calls[0], `https://esplora.invalid/api/tx/${real.txid}/hex`);
    assert.deepEqual(await api.rawTx(real.txid), Uint8Array.from(Buffer.from(real.hex, "hex")));

    // A source that answers with another transaction's bytes is caught.
    const forged = randomBytes(32).toString("hex");
    served.set(forged, other.hex);
    await assert.rejects(api.prevoutScript(outpointOf(forged, 1)), /txid mismatch/);
    await assert.rejects(api.rawTx(forged), /txid mismatch/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

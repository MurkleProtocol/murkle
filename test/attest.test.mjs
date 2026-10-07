// ATTEST (op 0x05): strict 38-byte encoding, and an indexer that logs it but
// never lets it touch pool state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Indexer } from "../src/indexer.mjs";
import { ATTEST_KIND, ATTEST_LEN, OP, decodeEnvelope, encodeAttest, encodeDeploy, envelopeLen, opReturnScript } from "../src/envelope.mjs";
import { MAGIC } from "../src/params.mjs";
import { hex } from "../src/bytes.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const HASH = new Uint8Array(32).map((_, i) => i + 1);
const txid = () => randomBytes(32).toString("hex");
const carrier = (envelope) => ({ txid: txid(), inputs: [{ outpoint: randomBytes(36) }], outputs: [{ script: opReturnScript(envelope), value: 0n }] });

test("ATTEST round-trips in exactly 38 bytes under the mrk magic", () => {
  const bytes = encodeAttest({ kind: ATTEST_KIND.GENESIS, hash: HASH });
  assert.equal(bytes.length, 38);
  assert.equal(ATTEST_LEN, 38);
  assert.equal(envelopeLen(OP.ATTEST), 38);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 3)), "mrk");
  assert.deepEqual(bytes.subarray(0, 5), new Uint8Array([...MAGIC, 0, 5]));
  const env = decodeEnvelope(bytes);
  assert.equal(env.op, OP.ATTEST);
  assert.equal(env.kind, 1);
  assert.deepEqual(env.hash, HASH);
  // Hex input encodes identically.
  assert.deepEqual(encodeAttest({ kind: 1, hash: hex(HASH) }), bytes);
});

test("reserved kinds 2 (checkpoint) and 3 (release) decode; unknown kinds are malformed", () => {
  for (const kind of [2, 3]) assert.equal(decodeEnvelope(encodeAttest({ kind, hash: HASH })).kind, kind);
  const bad = encodeAttest({ kind: 1, hash: HASH });
  for (const kind of [0, 4, 255]) {
    bad[5] = kind;
    assert.throws(() => decodeEnvelope(bad), /unknown attest kind/);
  }
  assert.throws(() => encodeAttest({ kind: 9, hash: HASH }), /unknown attest kind/);
});

test("wrong length and trailing bytes are rejected", () => {
  const ok = encodeAttest({ kind: 1, hash: HASH });
  assert.throws(() => decodeEnvelope(ok.subarray(0, 37)), /length/);
  assert.throws(() => decodeEnvelope(new Uint8Array([...ok, 0])), /length/);
  assert.throws(() => encodeAttest({ kind: 1, hash: HASH.subarray(0, 31) }), /32 bytes/);
});

test("the indexer logs an ATTEST as ok and never changes root, nullifiers or assets", async () => {
  const idx = new Indexer({ vkey: VKEY, startHeight: 1000 });
  const deploy = carrier(encodeDeploy({ ticker: "ATT", divisibility: 0, mintAmount: 1n, mintCap: 1, priceSats: 0n, treasury: new Uint8Array() }));
  await idx.applyBlock({ height: 1000, txs: [deploy] });
  const before = { root: idx.tree.root(), nullifiers: idx.nullifiers.size, assets: JSON.stringify(idx.snapshot().assets), outputs: idx.outputs.length };

  const att = carrier(encodeAttest({ kind: ATTEST_KIND.CHECKPOINT, hash: HASH }));
  const broken = encodeAttest({ kind: 1, hash: HASH });
  broken[5] = 7;
  const bad = carrier(broken);
  await idx.applyBlock({ height: 1001, txs: [{ txid: txid(), inputs: [], outputs: [] }, att, bad] });

  assert.equal(idx.tree.root(), before.root);
  assert.equal(idx.roots.get(1001), before.root);
  assert.equal(idx.nullifiers.size, before.nullifiers);
  assert.equal(idx.outputs.length, before.outputs);
  assert.equal(JSON.stringify(idx.snapshot().assets), before.assets);

  const [okEntry, badEntry] = idx.log.slice(-2);
  assert.deepEqual(okEntry, { seq: 1, height: 1001, index: 1, txid: att.txid, op: 5, opName: "ATTEST", ok: true, kind: 2, hash: hex(HASH) });
  assert.equal(badEntry.ok, false);
  assert.equal(badEntry.op, 5);
  assert.match(badEntry.reason, /^malformed: unknown attest kind/);
  assert.equal(idx.stats.accepted.attest, 1);
  assert.equal(idx.stats.rejected, 1);
});

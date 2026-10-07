// State digest v1: deterministic across replayers, exactly restored by
// rollback (accumulators, stats, log seq), and carried by snapshot v2.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { deriveKeys } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { ATTEST_KIND, encodeAttest, encodeDeploy, opReturnScript } from "../src/envelope.mjs";
import { compareDigests } from "../src/sync.mjs";
import { hex } from "../src/bytes.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const START = 700000;
// The v1 rules on every height: these blocks lie above the pinned mining activation height
// (src/pins.json), so the default table would switch them to digest v2 and snapshot v3.
const V1 = [{ name: "mining", height: null, digestV: 2 }];
const TREASURY = new Uint8Array([0x51, 0x20, ...randomBytes(32)]);
const PRICE = 1000n;
const ASSET = assetIdOf(START, 1);
const hash32 = () => randomBytes(32).toString("hex");

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const coinbase = () => ({ txid: hash32(), inputs: [], outputs: [] });
const carrier = (envelope, extra = [], first = randomBytes(36)) => ({
  txid: hash32(),
  inputs: [{ outpoint: first }],
  outputs: [{ script: opReturnScript(envelope), value: 0n }, ...extra],
});
const pay = (sats) => [{ script: TREASURY, value: sats }];

/** Everything the digest and the rollback journal must restore, in comparable form. */
const fingerprint = (idx) => ({
  height: idx.height,
  digest: idx.digestAt(idx.height),
  digests: [...idx.digests],
  logAcc: hex(idx.logAcc),
  nullAcc: hex(idx.nullAcc),
  assetsHash: hex(idx.assetsHash()),
  stats: JSON.stringify(idx.stats),
  log: JSON.stringify(idx.log),
  assets: JSON.stringify(idx.snapshot().assets),
  root: idx.tree.root(),
  nullifiers: [...idx.nullifiers].sort(),
});

// One chain, built once (proofs are slow), replayed by several indexers.
const blocks = [];
let reference;

test("build a chain: deploy, paid mint, underpaid mint, attest, malformed envelope, mint to cap", async () => {
  reference = new Indexer({ vkey: VKEY, startHeight: START, activations: V1 });
  const minter = new Wallet(deriveKeys(randomBytes(32)));
  const add = async (txs) => {
    const block = { height: reference.height + 1, hash: hash32(), txs: [coinbase(), ...txs] };
    await reference.applyBlock(block);
    blocks.push(block);
  };
  const mint = async (sats) => {
    const utxo = randomBytes(36);
    const env = await minter.mint(reference, { asset: ASSET, mintAmount: 10n, bindOutpoint: utxo });
    return carrier(env, pay(sats), utxo);
  };

  await add([carrier(encodeDeploy({ ticker: "DGST", divisibility: 0, mintAmount: 10n, mintCap: 2, priceSats: PRICE, treasury: TREASURY }))]);
  await add([await mint(PRICE + 5n), await mint(PRICE - 1n)]);
  const garbage = encodeAttest({ kind: 1, hash: new Uint8Array(32) }).subarray(0, 20);
  await add([carrier(encodeAttest({ kind: ATTEST_KIND.CHECKPOINT, hash: randomBytes(32) })), carrier(garbage)]);
  await add([await mint(PRICE)]);
  await add([await mint(PRICE * 3n)]); // cap reached: rejected, sats burned
  await add([]);

  const a = reference.assets.get(ASSET);
  assert.equal(a.deployHeight, START);
  assert.equal(a.firstMintHeight, START + 1);
  assert.equal(a.soldOutHeight, START + 3);
  assert.equal(a.treasurySats, 2n * PRICE + 5n);
  assert.equal(a.rejectedMints, 2);
  assert.equal(a.burnedSats, PRICE - 1n + PRICE * 3n);
  assert.deepEqual(a.mintsByHeight, [[START + 1, 1], [START + 3, 1]]);
  assert.deepEqual(reference.stats.accepted, { deploy: 1, mint: 2, transact: 0, attest: 1 });
  assert.equal(reference.stats.rejected, 3);
  assert.deepEqual(reference.stats.outputsByHeight, [[START + 1, 2], [START + 3, 2]]);
  assert.deepEqual(reference.log.map((l) => l.seq), reference.log.map((_, i) => i));
  assert.equal(reference.digests.size, blocks.length);

  // Log entries: MINT shows asset, ticker and amount; the DEPLOY shows its asset id.
  const deployEntry = reference.log[0];
  assert.deepEqual([deployEntry.opName, deployEntry.asset, deployEntry.ticker], ["DEPLOY", ASSET.toString(), "DGST"]);
  const mintEntry = reference.log[1];
  assert.deepEqual([mintEntry.opName, mintEntry.ok, mintEntry.asset, mintEntry.ticker, mintEntry.amount, mintEntry.index], ["MINT", true, ASSET.toString(), "DGST", "10", 1]);
  assert.match(reference.log[2].reason, /underpaid/);
});

test("digest is deterministic: an independent replay of the same blocks gets identical digests", async () => {
  const other = new Indexer({ vkey: VKEY, startHeight: START, activations: V1 });
  for (const b of blocks) await other.applyBlock(b);
  assert.deepEqual([...other.digests], [...reference.digests]);
  assert.match(other.digestAt(START + 2), /^[0-9a-f]{64}$/);
  assert.equal(other.digestAt(START - 1), null);
  assert.deepEqual(await compareDigests(other, async (a, b) => [...reference.digests].filter(([h]) => h >= a && h <= b), { batch: 2 }), {
    ok: true,
    upTo: reference.height,
  });
});

test("a changed block hash or a different envelope changes the digest from that height on", async () => {
  const forked = new Indexer({ vkey: VKEY, startHeight: START, activations: V1 });
  for (const [i, b] of blocks.entries()) {
    // Same transactions, but block 2's ATTEST is swapped for a different hash.
    const txs = i === 2 ? [b.txs[0], carrier(encodeAttest({ kind: 2, hash: randomBytes(32) })), b.txs[2]] : b.txs;
    await forked.applyBlock({ ...b, txs });
  }
  assert.equal(forked.digestAt(START + 1), reference.digestAt(START + 1));
  assert.notEqual(forked.digestAt(START + 2), reference.digestAt(START + 2));
  const res = await compareDigests(forked, async (a, b) => [...reference.digests].filter(([h]) => h >= a && h <= b));
  assert.deepEqual([res.ok, res.height], [false, START + 2]);

  const rehashed = new Indexer({ vkey: VKEY, startHeight: START, activations: V1 });
  await rehashed.applyBlock({ ...blocks[0], hash: hash32() });
  assert.notEqual(rehashed.digestAt(START), reference.digestAt(START));
});

test("rollback restores digest, accumulators, stats and log seq exactly; reapplying is identical", async () => {
  const idx = new Indexer({ vkey: VKEY, startHeight: START, activations: V1 });
  for (const b of blocks.slice(0, 2)) await idx.applyBlock(b);
  const at2 = fingerprint(idx);
  for (const b of blocks.slice(2)) await idx.applyBlock(b);
  const atEnd = fingerprint(idx);
  assert.deepEqual(atEnd, fingerprint(reference));

  idx.rollbackTo(START + 1);
  assert.deepEqual(fingerprint(idx), at2);
  assert.equal(idx.log.at(-1).seq, idx.log.length - 1);

  for (const b of blocks.slice(2)) await idx.applyBlock(b);
  assert.deepEqual(fingerprint(idx), atEnd);
});

test("snapshot v2 round-trips through JSON, keeps every digest and continues identically; v1 is refused", async () => {
  const idx = new Indexer({ vkey: VKEY, startHeight: START, activations: V1 });
  for (const b of blocks.slice(0, 3)) await idx.applyBlock(b);
  const snap = JSON.parse(JSON.stringify(idx.snapshot()));
  assert.equal(snap.version, 2);
  assert.equal(snap.protocol, "murkle");
  const restored = Indexer.restore(snap, { vkey: VKEY, activations: V1 });
  assert.deepEqual(fingerprint(restored), fingerprint(idx));

  // The restored indexer applies the rest of the chain, and can still roll back across the restore point.
  for (const b of blocks.slice(3)) await restored.applyBlock(b);
  assert.deepEqual(fingerprint(restored), fingerprint(reference));
  restored.rollbackTo(START + 1);
  for (const b of blocks.slice(2)) await restored.applyBlock(b);
  assert.deepEqual(fingerprint(restored), fingerprint(reference));

  assert.throws(() => Indexer.restore({ ...snap, version: 1 }, { vkey: VKEY, activations: V1 }), /unsupported snapshot version/);
  assert.throws(() => Indexer.restore({ ...snap, protocol: "zkpool" }, { vkey: VKEY, activations: V1 }), /another protocol/);
  // A tampered accumulator no longer matches the stored digest.
  assert.throws(() => Indexer.restore({ ...snap, acc: { ...snap.acc, nullAcc: "00".repeat(32) } }, { vkey: VKEY, activations: V1 }), /digest mismatch/);
});

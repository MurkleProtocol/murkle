// Genesis rule: the activation block must carry the pinned ATTEST over the
// manifest hash, and persisted state from another genesis is archived.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Indexer } from "../src/indexer.mjs";
import { ATTEST_KIND, encodeAttest, opReturnScript } from "../src/envelope.mjs";
import { loadIndexer, saveIndexer } from "../src/store-node.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const START = 500000;
const MANIFEST = randomBytes(32).toString("hex");
const hash32 = () => randomBytes(32).toString("hex");
const tx = (envelope) => ({
  txid: hash32(),
  inputs: [{ outpoint: randomBytes(36) }],
  outputs: envelope ? [{ script: opReturnScript(envelope), value: 0n }] : [],
});
const genesisTx = (kind = ATTEST_KIND.GENESIS, hash = MANIFEST) => tx(encodeAttest({ kind, hash }));
const coinbase = () => tx(null);

const fresh = (g) => new Indexer({ vkey: VKEY, startHeight: START, genesis: { txid: g.txid, manifestSha256: MANIFEST } });

test("genesis present: the activation block applies and logs the ATTEST", async () => {
  const g = genesisTx();
  const idx = fresh(g);
  await idx.applyBlock({ height: START, hash: hash32(), txs: [coinbase(), g] });
  assert.equal(idx.height, START);
  assert.deepEqual(
    { op: idx.log[0].op, kind: idx.log[0].kind, hash: idx.log[0].hash, ok: idx.log[0].ok, txid: idx.log[0].txid },
    { op: 5, kind: 1, hash: MANIFEST, ok: true, txid: g.txid },
  );
  // Only the activation block is checked.
  await idx.applyBlock({ height: START + 1, hash: hash32(), txs: [coinbase()] });
  assert.equal(idx.height, START + 1);
});

test("genesis absent: replay halts with 'genesis mismatch' and state is untouched", async () => {
  const g = genesisTx();
  const idx = fresh(g);
  await assert.rejects(idx.applyBlock({ height: START, txs: [coinbase(), genesisTx()] }), /^Error: genesis mismatch$/);
  assert.equal(idx.height, START - 1);
  assert.equal(idx.log.length, 0);
  assert.equal(idx.digests.size, 0);
});

test("genesis with the wrong hash or kind halts replay", async () => {
  const wrongHash = genesisTx(ATTEST_KIND.GENESIS, hash32());
  await assert.rejects(fresh(wrongHash).applyBlock({ height: START, txs: [coinbase(), wrongHash] }), /genesis mismatch/);

  const wrongKind = genesisTx(ATTEST_KIND.RELEASE);
  await assert.rejects(fresh(wrongKind).applyBlock({ height: START, txs: [coinbase(), wrongKind] }), /genesis mismatch/);

  const noEnvelope = tx(null);
  await assert.rejects(fresh(noEnvelope).applyBlock({ height: START, txs: [noEnvelope] }), /genesis mismatch/);
});

test("the genesis option must be well-formed hex", () => {
  assert.throws(() => new Indexer({ vkey: VKEY, startHeight: START, genesis: { txid: "abc", manifestSha256: MANIFEST } }), /hex/);
});

test("loadIndexer archives a snapshot from another genesis or start height instead of using it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murkle-genesis-"));
  try {
    const path = join(dir, "state.json");
    const g = genesisTx();
    const idx = fresh(g);
    await idx.applyBlock({ height: START, hash: hash32(), txs: [coinbase(), g] });
    saveIndexer(path, idx);
    const quiet = { onArchive: () => {} };

    // Same genesis and start: the snapshot is reused.
    const same = await loadIndexer(path, { vkey: VKEY, startHeight: START, genesis: { txid: g.txid, manifestSha256: MANIFEST }, ...quiet });
    assert.equal(same.height, START);
    assert.equal(same.digestAt(START), idx.digestAt(START));

    // Another genesis: archived, fresh indexer at the requested start.
    const other = await loadIndexer(path, { vkey: VKEY, startHeight: START, genesis: { txid: hash32(), manifestSha256: MANIFEST }, ...quiet });
    assert.equal(other.height, START - 1);
    assert.equal(existsSync(path), false);
    assert.equal(readdirSync(join(dir, "archive")).length, 1);

    // A v1 snapshot is archived too, never restored.
    writeFileSync(path, JSON.stringify({ version: 1, startHeight: START }));
    const v1 = await loadIndexer(path, { vkey: VKEY, startHeight: START + 5, ...quiet });
    assert.equal(v1.startHeight, START + 5);
    assert.equal(readdirSync(join(dir, "archive")).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The pinned mining activation height (src/pins.json, 325,138 on signet) at the boundary: the
// snapshot layout and digest version switch exactly there, a node below it keeps loading and
// saving its version 2 state, and a node that ran past it on the release before the pin
// (Indexer.restoreRewound, loadIndexer) rolls back to the block before it instead of resyncing.
//
// Synthetic blocks at the real heights; the one live input is a copy of data/signet/state.json
// (read and copied to a temporary directory, never written), skipped when it is absent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { encodeDeploy, encodeDeployPow, opReturnScript } from "../src/envelope.mjs";
import { concat } from "../src/bytes.mjs";
import * as P from "../src/params.mjs";
import { loadIndexer, saveIndexer } from "../src/store-node.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const H = P.MINING_HEIGHT;
const NULL_OUTPOINT = concat(new Uint8Array(32), new Uint8Array([255, 255, 255, 255]));
const OFF = [{ name: "mining", height: null, digestV: 2 }];
const mining = (height) => [{ name: "mining", height, digestV: 2 }];

const h32 = () => randomBytes(32).toString("hex");
const coinbase = () => ({ txid: h32(), inputs: [{ outpoint: NULL_OUTPOINT }], outputs: [] });
const carrier = (envelope) => ({ txid: h32(), inputs: [{ outpoint: new Uint8Array(randomBytes(36)) }], outputs: [{ script: opReturnScript(envelope), value: 0n }] });
const deployPow = (ticker) => carrier(encodeDeployPow({
  ticker, divisibility: 0, reward: 1000n, maxSupply: 10n ** 12n, span: 24, targetPerSpan: 24, initialDifficulty: 256n, minDifficulty: 256n,
}));
const deployPaid = (ticker) => carrier(encodeDeploy({ ticker, divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() }));
const json = (v) => JSON.parse(JSON.stringify(v));

/** Blocks from `from` to `to`: a paid DEPLOY at H - 2 and a DEPLOY_POW at H - 1 and at H + 1. */
function chain(from, to) {
  const blocks = [];
  for (let height = from; height <= to; height++) {
    const txs = [coinbase()];
    if (height === H - 2) txs.push(deployPaid("PAIDPIN"));
    if (height === H - 1) txs.push(deployPow("EARLYPIN"));
    if (height === H + 1) txs.push(deployPow("MINEDPIN"));
    blocks.push({ height, hash: h32(), txs });
  }
  return blocks;
}

async function replay(blocks, activations) {
  const idx = new Indexer({ vkey: VKEY, startHeight: blocks[0].height, ...(activations ? { activations } : {}) });
  for (const b of blocks) await idx.applyBlock(b);
  return idx;
}

const state = (idx) => ({
  height: idx.height,
  digests: [...idx.digests],
  log: JSON.stringify(idx.log),
  snap: JSON.stringify({ ...idx.snapshot(), undo: undefined }),
  undoLast: JSON.stringify(idx.snapshot().undo.at(-1)),
  root: String(idx.tree.root()),
});

test("the pinned table: an integer height above genesis, accepted by every Indexer that replays from genesis", () => {
  assert.ok(Number.isSafeInteger(H) && H > P.ACTIVATION_HEIGHT, `pinned ${H}`);
  assert.doesNotThrow(() => new Indexer({ vkey: VKEY, startHeight: P.ACTIVATION_HEIGHT, genesis: P.GENESIS }));
  assert.doesNotThrow(() => new Indexer({ vkey: VKEY, startHeight: H + 100 }), "a replay may start above it (murkle audit --from)");
  const idx = new Indexer({ vkey: VKEY, startHeight: P.ACTIVATION_HEIGHT, genesis: P.GENESIS });
  assert.equal(idx.miningHeight, H);
  assert.deepEqual([idx.miningActive(H - 1), idx.miningActive(H)], [false, true]);
  assert.deepEqual([idx.digestVersionAt(H - 1), idx.digestVersionAt(H)], [1, 2]);
});

test("at the pinned height: snapshot v2 and digest v1 up to H - 1, snapshot v3 and digest v2 exactly from H; a v2 state below H restores and continues", async () => {
  const blocks = chain(H - 4, H + 2);
  const below = blocks.filter((b) => b.height < H);
  const idx = await replay(below);
  const snap = json(idx.snapshot());
  assert.deepEqual([snap.version, snap.digestVersion, snap.height], [2, 1, H - 1]);
  assert.equal(snap.activations, undefined, "the v2 layout");
  // Below H every digest and verdict equal the pre-mining rules', and the early DEPLOY_POW is an unknown op.
  const off = await replay(below, OFF);
  assert.deepEqual([...idx.digests], [...off.digests]);
  assert.deepEqual(idx.log, off.log);
  const early = idx.log.find((l) => l.txid === blocks.find((b) => b.height === H - 1).txs[1].txid);
  assert.deepEqual([early.ok, early.opName, early.reason], [false, "UNKNOWN", "malformed: unknown op 9"]);

  // The node restarts below H on the pinned release: its v2 state loads as it is (no resync).
  const restored = Indexer.restore(snap, { vkey: VKEY });
  assert.deepEqual(state(restored), state(idx));
  assert.equal(Indexer.restoreRewound(snap, { vkey: VKEY }).height, H - 1);

  // It reaches H: digest v2 and snapshot v3 exactly there, and the DEPLOY_POW at H + 1 launches.
  for (const b of blocks.filter((x) => x.height >= H)) {
    await restored.applyBlock(b);
    await idx.applyBlock(b);
  }
  assert.deepEqual(state(restored), state(idx));
  const fresh = await replay(blocks);
  assert.deepEqual(state(restored), state(fresh));
  const offAll = await replay(blocks, OFF);
  for (const h of [H, H + 1, H + 2]) assert.notEqual(restored.digestAt(h), offAll.digestAt(h), `v2 at ${h}`);
  assert.equal(restored.assets.get(assetIdOf(H + 1, 1))?.kind, "pow");
  restored.rollbackTo(H);
  const atH = json(restored.snapshot());
  assert.deepEqual([atH.version, atH.digestVersion, atH.height], [3, 2, H]);
  assert.deepEqual(atH.activations, mining(H));
  restored.rollbackTo(H - 1);
  assert.equal(restored.snapshot().version, 2, "rolled back below H: the v2 layout again");
  assert.equal(restored.digestAt(H - 1), off.digestAt(H - 1));
});

test("restoreRewound: a v2 state written past the pinned height by the release before it rolls back to H - 1 and continues as a fresh replay", async () => {
  const blocks = chain(H - 6, H + 4);
  const old = await replay(blocks, OFF); // the release before the pin: mining unscheduled
  const snap = json(old.snapshot());
  assert.deepEqual([snap.version, snap.height], [2, H + 4]);
  assert.throws(() => Indexer.restore(snap, { vkey: VKEY }), /snapshot activations differ/);

  const idx = Indexer.restoreRewound(snap, { vkey: VKEY });
  assert.equal(idx.height, H - 1);
  for (let h = H - 6; h < H; h++) assert.equal(idx.digestAt(h), old.digestAt(h), `digest at ${h} kept`);
  assert.equal(idx.digestAt(H), null);
  assert.ok(idx.log.every((l) => l.height < H));
  for (const b of blocks.filter((x) => x.height >= H)) await idx.applyBlock(b);
  const fresh = await replay(blocks);
  assert.deepEqual(state(idx), state(fresh));
  assert.equal(idx.assets.get(assetIdOf(H + 1, 1))?.kind, "pow", "the launch after H, an unknown op under the old release, is accepted now");

  // Under the table it was written with, it restores as it is; a journal that does not reach H - 1 cannot rewind.
  assert.equal(Indexer.restoreRewound(snap, { vkey: VKEY, activations: OFF }).height, H + 4);
  const short = { ...snap, undo: snap.undo.slice(-(H + 4 - (H - 1)) + 1) };
  assert.throws(() => Indexer.restoreRewound(short, { vkey: VKEY }), /snapshot activations differ/);
  assert.equal(Indexer.restoreRewound({ ...snap, undo: snap.undo.slice(-(H + 4 - (H - 1))) }, { vkey: VKEY }).height, H - 1, "exactly deep enough");
  // Other errors are not rewound.
  assert.throws(() => Indexer.restoreRewound({ ...snap, version: 1 }, { vkey: VKEY }), /unsupported snapshot version/);
  assert.throws(() => Indexer.restoreRewound({ ...snap, acc: { ...snap.acc, logAcc: "11".repeat(32) } }, { vkey: VKEY }), /digest mismatch/);
});

test("restoreRewound: a v3 state written under a later activation height rolls back to the block before the earlier one", async () => {
  const start = 1_100_000;
  const blocks = [];
  for (let height = start; height <= start + 12; height++) blocks.push({ height, hash: h32(), txs: [coinbase(), ...(height === start + 6 ? [deployPow("LATERPIN")] : [])] });
  const late = await replay(blocks, mining(start + 9));
  const snap = json(late.snapshot());
  assert.equal(snap.version, 3);
  const idx = Indexer.restoreRewound(snap, { vkey: VKEY, activations: mining(start + 5) });
  assert.equal(idx.height, start + 4);
  for (const b of blocks.filter((x) => x.height > start + 4)) await idx.applyBlock(b);
  assert.deepEqual(state(idx), state(await replay(blocks, mining(start + 5))));
  assert.equal(idx.assets.get(assetIdOf(start + 6, 1))?.kind, "pow");
});

test("loadIndexer: a v2 state.json past the pinned height is rolled back, not archived; below it, it loads as it is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murkle-pin-"));
  try {
    const blocks = chain(P.ACTIVATION_HEIGHT, H + 3);
    const old = new Indexer({ vkey: VKEY, startHeight: P.ACTIVATION_HEIGHT, activations: OFF });
    for (const b of blocks) await old.applyBlock(b);
    const path = join(dir, "state.json");
    saveIndexer(path, old);
    const said = [];
    const idx = await loadIndexer(path, { vkey: VKEY, startHeight: P.ACTIVATION_HEIGHT, onArchive: (m) => said.push(["archive", m]), onRewind: (m) => said.push(["rewind", m]) });
    assert.equal(idx.height, H - 1);
    assert.deepEqual(said.map(([k]) => k), ["rewind"]);
    assert.match(said[0][1], new RegExp(`rolled back from ${H + 3} to ${H - 1}`));
    assert.ok(!existsSync(join(dir, "archive")), "nothing archived");
    // Saved below H it is a v2 file again, and it loads without a rewind.
    saveIndexer(path, idx);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 2);
    const again = await loadIndexer(path, { vkey: VKEY, startHeight: P.ACTIVATION_HEIGHT, onArchive: (m) => said.push(["archive", m]), onRewind: (m) => said.push(["rewind", m]) });
    assert.equal(again.height, H - 1);
    assert.equal(said.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the live signet state (a copy of data/signet/state.json) loads under the pinned release without a resync", async (t) => {
  const live = join("data", P.NETWORK, "state.json");
  if (!existsSync(live)) return t.skip("no data/signet/state.json here");
  const dir = mkdtempSync(join(tmpdir(), "murkle-live-"));
  try {
    const path = join(dir, "state.json");
    copyFileSync(live, path);
    const snap = JSON.parse(readFileSync(path, "utf8"));
    if (snap.version === 2 && snap.height - (H - 1) > snap.undo.length) {
      return t.skip(`the live state is ${snap.height - (H - 1)} blocks past ${H - 1}, deeper than its undo journal: a restart resyncs`);
    }
    const said = [];
    const idx = await loadIndexer(path, { vkey: VKEY, onArchive: (m) => said.push(["archive", m]), onRewind: (m) => said.push(["rewind", m]) });
    assert.ok(!said.some(([k]) => k === "archive"), JSON.stringify(said));
    assert.deepEqual(readdirSync(dir), ["state.json"], "nothing archived");
    assert.equal(idx.startHeight, P.ACTIVATION_HEIGHT);
    if (snap.height < H || snap.version === 3) {
      assert.equal(idx.height, snap.height, "below the pinned height, or written by the pinned release: loaded as it is");
      assert.deepEqual(said, []);
    } else {
      assert.equal(idx.height, H - 1, "written past the pinned height by the release before it: rolled back to the block before it");
      assert.deepEqual(said.map(([k]) => k), ["rewind"]);
    }
    for (const [h, d] of snap.digests) if (h <= idx.height) assert.equal(idx.digestAt(h), d, `digest at ${h}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

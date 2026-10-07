// Batch relay timing, core modules (docs/design/batch-contract.md §1, §2, §8):
// epoch arithmetic, tree copies, anchorAt, bounded note selection, and real
// proofs anchored at an hourly and at a 10-hour boundary, replayed by the indexer.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as snarkjs from "snarkjs";
import * as RB from "../src/relay-batch.mjs";
import { MerkleTree, randomField, toField } from "../src/core.mjs";
import { deriveKeys } from "../src/keys.mjs";
import { Wallet, anchorAt } from "../src/wallet.mjs";
import { Indexer, ANCHOR_WINDOW } from "../src/indexer.mjs";
import { ANCHOR_WINDOW as VERIFY_WINDOW } from "../src/verify-tx.mjs";
import { OP, decodeEnvelope, encodeDeploy, opReturnScript } from "../src/envelope.mjs";
import { decodeProof } from "../src/proof-codec.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const TOO_NEW = "the notes that cover this amount arrived after the batch boundary";
const isTooNew = (e) => e.code === "NOTE_TOO_NEW" && e.message === TOO_NEW;

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

/* ---------- 1-4: src/relay-batch.mjs ---------- */

test("constants: the window mirrors the indexer, two fixed epoch lengths, every 60-boundary is a 6-boundary", () => {
  assert.equal(RB.ANCHOR_WINDOW, ANCHOR_WINDOW);
  assert.equal(RB.ANCHOR_WINDOW, VERIFY_WINDOW);
  assert.deepEqual(RB.MODES, ["fast", "block", "batch", "batch10"]);
  assert.deepEqual(RB.BATCH_MODES, ["batch", "batch10"]);
  assert.deepEqual(RB.EPOCH_BLOCKS, { batch: 6, batch10: 60 });
  assert.deepEqual(RB.DEFAULT_SAFETY, { batch: 24, batch10: 12 });
  assert.deepEqual(RB.DEFAULT_CAPS, { batch: 40, batch10: 120 });
  assert.equal(RB.DEFAULT_PER_IP, 3);
  assert.equal(RB.OVERDUE_AFTER, 3);
  for (const o of [RB.MODES, RB.BATCH_MODES, RB.EPOCH_BLOCKS, RB.DEFAULT_SAFETY, RB.DEFAULT_CAPS]) assert.ok(Object.isFrozen(o));

  for (const m of RB.MODES) assert.equal(RB.isMode(m), true, m);
  for (const m of ["Batch", "BLOCK", "", null, undefined, 6, "batch6", "later", "batch12"]) assert.equal(RB.isMode(m), false, String(m));
  assert.deepEqual(RB.MODES.filter(RB.isBatchMode), ["batch", "batch10"]);
  for (const m of ["fast", "block", "Batch", null, undefined, "batch12"]) assert.equal(RB.isBatchMode(m), false, String(m));
  assert.equal(RB.epochBlocks("batch"), 6);
  assert.equal(RB.epochBlocks("batch10"), 60);

  for (let h = 0; h <= 60 * 6; h++) {
    if (RB.isBoundary(h, "batch10")) assert.ok(RB.isBoundary(h, "batch"), `60-boundary ${h} is a 6-boundary`);
    assert.ok(RB.epochStart(h, "batch10") <= RB.epochStart(h, "batch"));
  }
  // Per-length slack between release and the relayer deadline (contract §0), and between
  // release and the end of the anchor window (time for a slow carrier to confirm).
  assert.equal(RB.lastReleaseHeight(0, "batch") - RB.releaseHeight(0, "batch"), 70);
  assert.equal(RB.lastReleaseHeight(0, "batch10") - RB.releaseHeight(0, "batch10"), 28);
  assert.equal(RB.deadlineHeight(0) - RB.releaseHeight(0, "batch10"), 40);

  // A mode id an older wallet saved: the retired 12-hour batch reads as the 10-hour batch.
  assert.equal(RB.savedMode("batch12"), "batch10");
  for (const m of [...RB.MODES, "later", "toString", "", null, undefined]) assert.equal(RB.savedMode(m), m, String(m));

  // Pure and dependency-free: safe to import from the server, the browser and the CLI.
  const src = readFileSync("src/relay-batch.mjs", "utf8");
  assert.doesNotMatch(src, /^\s*import\b/m);
  assert.doesNotMatch(src, /\r/);
});

test("epochStart, isBoundary, nextBoundary, releaseHeight, lastReleaseHeight at fixed heights, both lengths", () => {
  // [height, start, boundary, next] for each length.
  const rows = {
    batch: [
      [0, 0, true, 6], [5, 0, false, 6], [6, 6, true, 12], [59, 54, false, 60], [60, 60, true, 66], [61, 60, false, 66],
      [71, 66, false, 72], [72, 72, true, 78], [73, 72, false, 78],
      [324_660, 324_660, true, 324_666], [324_696, 324_696, true, 324_702], [324_700, 324_696, false, 324_702], [324_720, 324_720, true, 324_726],
    ],
    batch10: [
      [0, 0, true, 60], [5, 0, false, 60], [6, 0, false, 60], [59, 0, false, 60], [60, 60, true, 120], [61, 60, false, 120],
      [72, 60, false, 120], [119, 60, false, 120], [120, 120, true, 180],
      [324_659, 324_600, false, 324_660], [324_660, 324_660, true, 324_720], [324_661, 324_660, false, 324_720],
      [324_696, 324_660, false, 324_720], [324_700, 324_660, false, 324_720], [324_719, 324_660, false, 324_720], [324_720, 324_720, true, 324_780],
    ],
  };
  for (const [mode, list] of Object.entries(rows)) {
    const E = RB.EPOCH_BLOCKS[mode];
    const safety = RB.DEFAULT_SAFETY[mode];
    for (const [h, start, boundary, next] of list) {
      const at = `${mode} @ ${h}`;
      assert.equal(RB.epochStart(h, mode), start, at);
      assert.equal(RB.isBoundary(h, mode), boundary, at);
      assert.equal(RB.nextBoundary(h, mode), next, at);
      assert.equal(RB.releaseHeight(h, mode), h + E, at);
      assert.equal(RB.lastReleaseHeight(h, mode), h + 100 - safety, at);
      assert.equal(RB.deadlineHeight(h), h + 100, at);
    }
  }
  // The default length is the hourly batch.
  assert.equal(RB.epochStart(324_700), 324_696);
  assert.equal(RB.isBoundary(324_696), true);
  assert.equal(RB.nextBoundary(324_700), 324_702);
  assert.equal(RB.releaseHeight(324_696), 324_702);
  // An explicit safety overrides the default (the relayer passes its config).
  assert.equal(RB.lastReleaseHeight(324_660, "batch10", 24), 324_736);
  assert.equal(RB.lastReleaseHeight(324_660, "batch10", 0), 324_760);
  assert.equal(RB.epochKey("batch", 324_696), "batch:324696");
  assert.notEqual(RB.epochKey("batch", 324_660), RB.epochKey("batch10", 324_660));
});

test("non-batch modes throw TypeError; bad heights and bad safety throw RangeError", () => {
  for (const mode of ["fast", "block", "Batch", null, "batch6", 6, "batch12"]) {
    const notBatch = (e) => e instanceof TypeError && e.message === `not a batch mode: ${mode}`;
    assert.throws(() => RB.epochBlocks(mode), notBatch);
    assert.throws(() => RB.epochStart(12, mode), notBatch);
    assert.throws(() => RB.isBoundary(12, mode), notBatch);
    assert.throws(() => RB.nextBoundary(12, mode), notBatch);
    assert.throws(() => RB.releaseHeight(12, mode), notBatch);
    assert.throws(() => RB.lastReleaseHeight(12, mode), notBatch);
    assert.throws(() => RB.batchSchedule(12, mode), notBatch);
  }
  assert.throws(() => RB.epochBlocks(), TypeError);
  assert.throws(() => RB.lastReleaseHeight(12), TypeError, "lastReleaseHeight has no default mode");

  for (const h of [-1, 1.5, NaN, Infinity, -Infinity, "6", 2 ** 53, null, undefined, 6n]) {
    for (const mode of RB.BATCH_MODES) {
      assert.throws(() => RB.epochStart(h, mode), RangeError, `epochStart(${String(h)})`);
      assert.throws(() => RB.isBoundary(h, mode), RangeError);
      assert.throws(() => RB.nextBoundary(h, mode), RangeError);
      assert.throws(() => RB.releaseHeight(h, mode), RangeError);
      assert.throws(() => RB.lastReleaseHeight(h, mode), RangeError);
      assert.throws(() => RB.batchSchedule(h, mode), RangeError);
    }
    assert.throws(() => RB.deadlineHeight(h), RangeError);
    assert.throws(() => RB.leafCountAt([], h), RangeError);
  }
  for (const safety of [-1, 101, 1.5, NaN, "12", null]) {
    assert.throws(() => RB.lastReleaseHeight(60, "batch10", safety), RangeError, String(safety));
  }
});

test("leafCountAt counts outputs at or below a height (binary search over leaf order)", () => {
  const out = (...hs) => hs.map((height, leafIndex) => ({ leafIndex, height }));
  assert.equal(RB.leafCountAt([], 0), 0);
  assert.equal(RB.leafCountAt([], 900_000), 0);
  const o = out(10, 10, 12, 12, 12, 15);
  const want = { 0: 0, 9: 0, 10: 2, 11: 2, 12: 5, 13: 5, 14: 5, 15: 6, 16: 6, 1_000_000: 6 };
  for (const [h, n] of Object.entries(want)) assert.equal(RB.leafCountAt(o, Number(h)), n, `at ${h}`);
  assert.equal(RB.leafCountAt(out(7), 6), 0, "below the only output");
  assert.equal(RB.leafCountAt(out(7), 7), 1, "the output's own block counts");

  // Random non-decreasing heights against a linear count.
  for (let round = 0; round < 50; round++) {
    const hs = [];
    let h = Math.floor(Math.random() * 20);
    const n = Math.floor(Math.random() * 40);
    for (let i = 0; i < n; i++) hs.push((h += Math.random() < 0.4 ? 0 : 1 + Math.floor(Math.random() * 3)));
    const rows = out(...hs);
    for (let q = 0; q <= h + 2; q++) assert.equal(RB.leafCountAt(rows, q), hs.filter((x) => x <= q).length);
  }
});

test("batchSchedule at tip 324,700 matches the contract example for both lengths", () => {
  assert.deepEqual(RB.batchSchedule(324_700, "batch"), {
    mode: "batch", epochBlocks: 6, start: 324_696, releaseAt: 324_702, landsAt: 324_703, lastRelease: 324_772, deadline: 324_796,
  });
  assert.deepEqual(RB.batchSchedule(324_700, "batch10"), {
    mode: "batch10", epochBlocks: 60, start: 324_660, releaseAt: 324_720, landsAt: 324_721, lastRelease: 324_748, deadline: 324_760,
  });
  // A send made on the boundary block itself is anchored at that block; one block earlier, at the previous one.
  assert.equal(RB.batchSchedule(324_720, "batch10").start, 324_720);
  assert.equal(RB.batchSchedule(324_719, "batch10").start, 324_660);
  assert.equal(RB.batchSchedule(324_700, "batch10", { safety: 24 }).lastRelease, 324_736);
  assert.equal(RB.batchSchedule(324_700, "batch10", { safety: null }).lastRelease, 324_748);

  for (const mode of RB.BATCH_MODES) {
    const E = RB.EPOCH_BLOCKS[mode];
    for (let h = 0; h < 400; h++) {
      const s = RB.batchSchedule(h, mode);
      assert.ok(s.start <= h && h < s.releaseAt && s.start % E === 0, `${mode} @ ${h}`);
      assert.equal(s.releaseAt, s.start + E);
      assert.equal(s.landsAt, s.releaseAt + 1);
      assert.equal(s.deadline - s.start, ANCHOR_WINDOW);
      assert.ok(s.releaseAt < s.lastRelease && s.lastRelease < s.deadline, "the release fits inside the window");
      assert.equal(s.deadline - s.lastRelease, RB.DEFAULT_SAFETY[mode]);
    }
  }
});

/* ---------- 5: MerkleTree.copy / truncate ---------- */

const treeOf = (leaves) => {
  const t = new MerkleTree();
  for (const l of leaves) t.insert(l);
  return t;
};

test("MerkleTree.copy is independent both ways; copy().truncate(n) is the tree of the first n leaves", () => {
  const leaves = Array.from({ length: 9 }, () => randomField());
  const a = treeOf(leaves);
  const rootA = a.root();
  const b = a.copy();
  assert.ok(b instanceof MerkleTree);
  assert.equal(b.levels, a.levels);
  assert.equal(b.size, a.size);
  assert.equal(b.root(), rootA);
  assert.equal(b.zeros, a.zeros, "zeros are shared");
  assert.notEqual(b.layers, a.layers);
  b.layers.forEach((m, i) => assert.notEqual(m, a.layers[i], `layer ${i} is a fresh Map`));

  const extraB = randomField();
  b.insert(extraB);
  assert.equal(a.root(), rootA, "growing the copy leaves the original alone");
  assert.equal(a.size, 9);
  assert.equal(b.root(), treeOf([...leaves, extraB]).root());
  const extraA = randomField();
  a.insert(extraA);
  assert.equal(b.root(), treeOf([...leaves, extraB]).root(), "growing the original leaves the copy alone");
  assert.equal(a.root(), treeOf([...leaves, extraA]).root());
  a.truncate(9);
  assert.equal(a.root(), rootA);
  assert.equal(b.size, 10);

  for (let n = 0; n <= leaves.length; n++) {
    const want = treeOf(leaves.slice(0, n));
    const got = a.copy().truncate(n);
    assert.equal(got.size, n);
    assert.equal(got.root(), want.root(), `root of the first ${n} leaves`);
    for (let i = 0; i < n; i++) assert.deepEqual(got.path(i), want.path(i), `path ${i} of ${n}`);
    // A truncated copy keeps growing like the real tree.
    const next = randomField();
    got.insert(next);
    want.insert(next);
    assert.equal(got.root(), want.root());
  }
  assert.equal(a.root(), rootA, "copies never touched the original");

  const t = a.copy();
  assert.equal(t.truncate(4), t, "truncate returns this");
  assert.equal(t.truncate(0), t, "truncate(0) returns this too");
  assert.equal(t.root(), new MerkleTree().root());
  assert.throws(() => t.truncate(1), /cannot truncate forward/);

  // A shallow tree, every prefix.
  const small = new MerkleTree(4);
  const sl = Array.from({ length: 16 }, () => randomField());
  sl.forEach((l) => small.insert(l));
  for (let n = 0; n <= 16; n++) {
    const want = new MerkleTree(4);
    sl.slice(0, n).forEach((l) => want.insert(l));
    assert.equal(small.copy().truncate(n).root(), want.root());
  }
});

/* ---------- shared chain for 6 and 8 ---------- */

// B is a 60-boundary (and a 6-boundary); H is an hourly boundary that is not a 60-boundary.
const B = 864_000;
const H = 863_994;
const START = 863_985;
const MINT = 1000n;
const coinbase = { txid: "coinbase", inputs: [], outputs: [] };
const carrier = (envelope, firstInput = randomBytes(36)) => ({
  txid: randomBytes(32).toString("hex"),
  inputs: [{ outpoint: firstInput }],
  outputs: [{ script: opReturnScript(envelope), value: 0n }],
});
const NO_TX = { inputs: [], outputs: [] };

const idx = new Indexer({ vkey: VKEY, startHeight: START });
const W = Object.fromEntries(["alice", "bob", "carol", "dave", "erin", "george"].map((n) => [n, new Wallet(deriveKeys(randomBytes(32)))]));
let ASSET;
const mine = (txs = []) => idx.applyBlock({ height: idx.height + 1, txs: [coinbase, ...txs] });
const mineTo = async (h) => {
  while (idx.height < h) await mine();
};
const verdict = (tx) => idx.log.find((l) => l.txid === tx.txid);
async function mintTx(wallet) {
  const utxo = randomBytes(36);
  return carrier(await wallet.mint(idx, { asset: ASSET, mintAmount: MINT, bindOutpoint: utxo }), utxo);
}
const scanAll = () => Object.values(W).forEach((w) => w.scan(idx));
/** Groth16 check against a given root, as the web wallet's verifyEnvelope does. */
async function verifiesAgainst(envelope, root) {
  const env = decodeEnvelope(envelope);
  const signals = [root, toField(env.publicAmount), env.publicAsset, env.extDataHash, ...env.nullifiers, ...env.commitments].map(String);
  return snarkjs.groth16.verify(VKEY, signals, decodeProof(env.proof));
}

// Outputs (2 leaves per envelope) at several heights around H and B:
//   863986 alice (0,1) · 863988 bob (2,3) · 863990 george (4,5) · H = 863994 none
//   863995 alice again (6,7) · B = 864000 dave (8,9)
before(async () => {
  await mine([carrier(encodeDeploy({ ticker: "BATCHT", divisibility: 0, mintAmount: MINT, mintCap: 100, priceSats: 0n, treasury: new Uint8Array() }))]);
  ASSET = idx.tickers.get("BATCHT");
  await mine([await mintTx(W.alice)]); // 863986
  await mine();
  await mine([await mintTx(W.bob)]); // 863988
  await mine();
  await mine([await mintTx(W.george)]); // 863990
  await mineTo(H);
  await mine([await mintTx(W.alice)]); // 863995
  assert.equal(idx.height, 863_995);
  assert.equal(idx.outputs.length, 8);
  scanAll();
});

/* ---------- 6: anchorAt ---------- */

test("anchorAt rebuilds the root of every height in the window from the outputs, without touching the live tree", () => {
  const rootNow = idx.tree.root();
  const sizeNow = idx.tree.size;
  for (let h = START - 1; h <= idx.height; h++) {
    const a = anchorAt(idx, h);
    assert.equal(a.height, h);
    assert.equal(a.leaves, idx.outputs.filter((o) => o.height <= h).length);
    assert.equal(a.tree.size, a.leaves);
    assert.equal(a.tree.root(), idx.roots.get(h), `root at ${h}`);
  }
  const atH = anchorAt(idx, H);
  assert.equal(atH.leaves, 6);
  assert.notEqual(atH.tree, idx.tree, "a later output means a truncated copy");
  assert.equal(idx.tree.root(), rootNow, "view.tree unchanged");
  assert.equal(idx.tree.size, sizeNow);

  // Nothing came after the anchor: the live tree itself, no copy.
  assert.equal(anchorAt(idx, idx.height).tree, idx.tree);
});

test("anchorAt works on a web-style view built from /api/outputs rows, and refuses heights it cannot rebuild", () => {
  const view = { startHeight: START, height: idx.height, tree: new MerkleTree(), outputs: [], nullifiers: new Set() };
  for (const o of idx.outputs) {
    view.tree.insert(o.commitment);
    view.outputs.push({ commitment: o.commitment, height: o.height, txid: o.txid });
  }
  for (const h of [START - 1, 863_988, H, idx.height]) assert.equal(anchorAt(view, h).tree.root(), idx.roots.get(h));
  assert.equal(anchorAt(view, idx.height).tree, view.tree);

  assert.throws(() => anchorAt(view, view.height + 1), RangeError, "above the synced height");
  assert.throws(() => anchorAt(view, START - 2), RangeError, "before the pool's first root");
  assert.throws(() => anchorAt(view, -1), RangeError);
  assert.throws(() => anchorAt(view, 1.5), RangeError);
  // Outputs claiming more leaves than the tree holds.
  const short = { ...view, tree: view.tree.copy().truncate(4) };
  assert.throws(() => anchorAt(short, H), RangeError);
  // Without startHeight (a bare view) only the other checks apply.
  const bare = { height: view.height, tree: view.tree, outputs: view.outputs };
  assert.equal(anchorAt(bare, 0).tree.size, 0);
});

/* ---------- 7: bounded note selection ---------- */

const note = (amount, nullifier, leafIndex, extra = {}) => ({ asset: 7n, amount, nullifier: BigInt(nullifier), leafIndex, spent: false, ...extra });

test("spendable, maxSendable and selectNotes with maxLeaf; NOTE_TOO_NEW only after INSUFFICIENT and NOTE_LIMIT", () => {
  const w = new Wallet(deriveKeys(randomBytes(32)));
  w.notes = [
    note(500n, 1, 0), note(400n, 2, 3), // existed at the boundary (6 leaves)
    note(1000n, 3, 8), note(900n, 4, 9), // arrived after it
    note(50n, 5, 1, { spent: true }), note(70n, 6, 2, { asset: 8n }),
  ];
  const amounts = (list) => list.map((n) => n.amount);
  assert.deepEqual(amounts(w.spendable(7n)), [1000n, 900n, 500n, 400n]);
  assert.deepEqual(amounts(w.spendable(7n, {})), [1000n, 900n, 500n, 400n]);
  assert.deepEqual(amounts(w.spendable(7n, { maxLeaf: undefined })), [1000n, 900n, 500n, 400n]);
  assert.deepEqual(amounts(w.spendable(7n, { maxLeaf: null })), [1000n, 900n, 500n, 400n]);
  assert.deepEqual(amounts(w.spendable(7n, { maxLeaf: 6 })), [500n, 400n]);
  assert.deepEqual(amounts(w.spendable(7n, { maxLeaf: 3 })), [500n], "leafIndex < maxLeaf, strictly");
  assert.deepEqual(amounts(w.spendable(7n, { maxLeaf: 0 })), []);
  assert.equal(w.maxSendable(7n), 1900n);
  assert.equal(w.maxSendable(7n, { maxLeaf: 6 }), 900n);
  assert.equal(w.maxSendable(7n, { maxLeaf: 3 }), 500n);
  assert.equal(w.maxSendable(7n, { maxLeaf: 0 }), 0n);

  assert.deepEqual(amounts(w.selectNotes(7n, 800n).picked), [1000n]);
  const bounded = w.selectNotes(7n, 800n, { maxLeaf: 6 });
  assert.deepEqual(amounts(bounded.picked), [500n, 400n]);
  assert.equal(bounded.total, 900n);
  assert.deepEqual(amounts(w.selectNotes(7n, 800n, { maxLeaf: Infinity }).picked), [1000n]);
  assert.throws(() => w.selectNotes(7n, 950n, { maxLeaf: 6 }), isTooNew);
  assert.throws(() => w.selectNotes(7n, 1n, { maxLeaf: 0 }), isTooNew);
  // Today's errors come first, unchanged.
  assert.throws(() => w.selectNotes(7n, 5000n, { maxLeaf: 6 }), (e) => e.code === "INSUFFICIENT" && /^insufficient balance: 1900 < 5000$/.test(e.message));
  assert.throws(() => w.selectNotes(7n, 2000n, { maxLeaf: 6 }), (e) => e.code === "NOTE_LIMIT" && /at most 2 notes/.test(e.message));
  assert.throws(() => w.selectNotes(7n, 2000n), (e) => e.code === "NOTE_LIMIT");
  assert.throws(() => w.selectNotes(7n, 1n, { maxLeaf: 0 }), (e) => e.code !== "INSUFFICIENT");

  // Older notes would need three inputs while one newer note covers it: still "too new".
  w.notes.push(note(300n, 7, 4));
  assert.deepEqual(amounts(w.selectNotes(7n, 1000n).picked), [1000n]);
  assert.throws(() => w.selectNotes(7n, 1000n, { maxLeaf: 6 }), isTooNew);

  // Locked notes stay out with or without the bound.
  w.locked = new Set(["1"]);
  assert.deepEqual(amounts(w.spendable(7n, { maxLeaf: 6 })), [400n, 300n]);
  assert.equal(w.maxSendable(7n, { maxLeaf: 6 }), 700n);
  assert.throws(() => w.selectNotes(7n, 800n, { maxLeaf: 6 }), isTooNew);

  // Notes without a leaf index (older tests and fakes) behave as today when no bound is given.
  const legacy = new Wallet(deriveKeys(randomBytes(32)));
  legacy.notes = [{ asset: 7n, amount: 10n, nullifier: 1n, spent: false }];
  assert.equal(legacy.maxSendable(7n), 10n);
  assert.equal(legacy.selectNotes(7n, 10n).total, 10n);
});

test("notesFor with maxLeaf: a retry input that arrived after the boundary is NOTE_TOO_NEW; today's errors first", () => {
  const w = new Wallet(deriveKeys(randomBytes(32)));
  w.notes = [note(500n, 1, 0), note(400n, 2, 3), note(1000n, 3, 8), note(50n, 5, 1, { spent: true })];
  w.locked = new Set(["1", "3"]); // W-1: locked notes are exactly what a retry may use
  assert.equal(w.notesFor(7n, 100n, [1n], { maxLeaf: 6 }).total, 500n);
  assert.equal(w.notesFor(7n, 100n, ["1", "2"], { maxLeaf: 6 }).total, 900n);
  assert.equal(w.notesFor(7n, 100n, [3n]).total, 1000n, "no bound: as today");
  assert.equal(w.notesFor(7n, 100n, [3n], { maxLeaf: 9 }).total, 1000n);
  assert.throws(() => w.notesFor(7n, 100n, [3n], { maxLeaf: 8 }), isTooNew);
  assert.throws(() => w.notesFor(7n, 100n, [1n, 3n], { maxLeaf: 6 }), isTooNew);
  assert.throws(() => w.notesFor(7n, 100n, [{ nullifier: 3n }], { maxLeaf: 6 }), isTooNew);
  assert.throws(() => w.notesFor(7n, 100n, [5n], { maxLeaf: 0 }), /already spent/);
  assert.throws(() => w.notesFor(7n, 5000n, [3n], { maxLeaf: 0 }), /insufficient balance in retry inputs/);
  assert.throws(() => w.notesFor(7n, 1n, ["999"], { maxLeaf: 0 }), /not a note of this wallet/);
  assert.throws(() => w.notesFor(7n, 1n, [], { maxLeaf: 6 }), /one or two input notes/);
});

test("buildEnvelope refuses a malformed anchor, inputs outside the anchor tree, and a live tree that grew after anchorAt", async () => {
  const w = new Wallet(deriveKeys(randomBytes(32)));
  const base = { op: OP.TRANSACT, asset: 7n, outputs: [{ amount: 1n, to: w.address }] };
  const input = (leafIndex) => ({ amount: 1n, blinding: 1n, leafIndex });
  const view = { height: 10, tree: treeOf([1n, 2n, 3n]), outputs: [1, 2, 3].map((c, i) => ({ commitment: BigInt(c), height: 8 + i })) };
  await assert.rejects(w.buildEnvelope(view, { ...base, inputs: [], anchor: { height: 9 } }), TypeError);
  await assert.rejects(w.buildEnvelope(view, { ...base, inputs: [], anchor: { tree: view.tree } }), TypeError);
  const at9 = anchorAt(view, 9);
  assert.equal(at9.leaves, 2);
  await assert.rejects(w.buildEnvelope(view, { ...base, inputs: [input(2)], anchor: at9 }), isTooNew);
  await assert.rejects(w.transfer(view, { asset: 7n, amount: 1n, to: w.address, inputs: [1n], anchor: at9 }), /not a note of this wallet/);

  const live = anchorAt(view, 10);
  assert.equal(live.tree, view.tree);
  view.tree.insert(4n); // a later block grew the shared tree
  await assert.rejects(w.buildEnvelope(view, { ...base, inputs: [input(0)], anchor: live }), /changed since it was taken; anchor again/);
});

/* ---------- 8: real proofs anchored at batch boundaries ---------- */

let hourly; // alice -> carol, anchored at H, lands at H + 7
const ten = {}; // anchored at B: bob (lands B + 61), dave (B + 100), george (refused at B + 101)

test("hourly: a transfer anchored at H proves against R[H] with the notes that existed then, and lands at H + 7", async () => {
  const { alice, carol } = W;
  const rootNow = idx.tree.root();
  const anchor = anchorAt(idx, H);
  assert.equal(anchor.tree.root(), idx.roots.get(H));
  assert.equal(anchor.leaves, 6);

  // Alice's second note (leaf 6 or 7: outputs are shuffled, L4) arrived after H: 1,500 needs it, so it is too new for this batch.
  assert.equal(alice.balance(ASSET), 2000n);
  assert.equal(alice.maxSendable(ASSET), 2000n);
  assert.equal(alice.maxSendable(ASSET, { maxLeaf: anchor.tree.size }), 1000n);
  await assert.rejects(alice.transfer(idx, { asset: ASSET, amount: 1500n, to: carol.address, anchor }), isTooNew);
  const newer = alice.notes.find((n) => n.leafIndex >= anchor.leaves);
  assert.ok(newer && newer.leafIndex <= 7);
  await assert.rejects(alice.transfer(idx, { asset: ASSET, amount: 1n, to: carol.address, inputs: [newer.nullifier], anchor }), isTooNew);

  hourly = await alice.transfer(idx, { asset: ASSET, amount: 300n, to: carol.address, anchor });
  const env = decodeEnvelope(hourly);
  assert.equal(env.op, OP.TRANSACT);
  assert.equal(env.anchor, H, "the header names the epoch start");
  assert.equal(hourly.spends.length, 1);
  assert.equal(hourly.spends[0], String(alice.notes.find((n) => n.leafIndex < 2).nullifier), "her first note (leaf 0 or 1)");
  assert.equal(await verifiesAgainst(hourly, idx.roots.get(H)), true, "verifies against R[H]");
  assert.equal(await verifiesAgainst(hourly, idx.tree.root()), false, "not against the tip root");
  assert.equal(idx.tree.root(), rootNow, "proving never touched the live tree");

  await mineTo(B - 1);
  await mine([await mintTx(W.dave)]); // B: outputs on the boundary block itself
  assert.equal(await idx.checkTx(env, NO_TX, H + 7), true);
  const tx = carrier(hourly);
  const erinMint = await mintTx(W.erin); // after B
  await mine([tx, erinMint]); // H + 7 = B + 1
  assert.equal(idx.height, H + 7);
  assert.equal(verdict(tx).ok, true, verdict(tx).reason);
  scanAll();
  assert.equal(carol.balance(ASSET), 300n);
  assert.equal(alice.balance(ASSET), 1700n);
});

test("10-hour: transfers anchored at a 60-boundary pass at B + 61 and B + 100 and are refused at B + 101", async () => {
  const { bob, carol, dave, george, erin } = W;
  const anchor = anchorAt(idx, B);
  assert.equal(anchor.leaves, 10, "dave's outputs on block B count");
  assert.equal(anchor.tree.root(), idx.roots.get(B));
  assert.notEqual(anchor.tree, idx.tree);
  const rootNow = idx.tree.root();

  ten.bob = await bob.transfer(idx, { asset: ASSET, amount: 100n, to: carol.address, anchor });
  ten.dave = await dave.transfer(idx, { asset: ASSET, amount: 50n, to: carol.address, anchor }); // note from block B itself
  ten.george = await george.transfer(idx, { asset: ASSET, amount: 10n, to: carol.address, anchor });
  for (const [who, e] of Object.entries(ten)) {
    assert.equal(decodeEnvelope(e).anchor, B, who);
    assert.equal(await verifiesAgainst(e, idx.roots.get(B)), true, who);
  }
  assert.equal(idx.tree.root(), rootNow);
  // Erin's note arrived after B.
  await assert.rejects(erin.transfer(idx, { asset: ASSET, amount: 1n, to: carol.address, anchor }), isTooNew);

  const env = (who) => decodeEnvelope(ten[who]);
  // Consensus knows no batch lengths: the same anchor is also fine at B + 7.
  assert.equal(await idx.checkTx(env("bob"), NO_TX, B + 7), true);
  await mineTo(B + 60);
  assert.equal(await idx.checkTx(env("bob"), NO_TX, B + 61), true);
  const tBob = carrier(ten.bob);
  await mine([tBob]); // B + 61
  assert.equal(verdict(tBob).ok, true, verdict(tBob).reason);

  assert.equal(await idx.checkTx(env("george"), NO_TX, B + 100), true);
  assert.equal(await idx.checkTx(env("george"), NO_TX, B + 101), "anchor outside window");
  await mineTo(B + 99);
  const tDave = carrier(ten.dave);
  await mine([tDave]); // B + 100: the last block of the window
  assert.equal(verdict(tDave).ok, true, verdict(tDave).reason);
  const tGeorge = carrier(ten.george);
  await mine([tGeorge]); // B + 101
  assert.equal(verdict(tGeorge).ok, false);
  assert.equal(verdict(tGeorge).reason, "anchor outside window");

  scanAll();
  assert.equal(carol.balance(ASSET), 450n);
  assert.equal(george.balance(ASSET), MINT, "the refused transfer moved nothing");
  assert.equal(bob.balance(ASSET), 900n);
  assert.equal(dave.balance(ASSET), 950n);
});

test("no anchor keeps today's tip anchor; inputs plus an anchor reproduce the same nullifiers", async () => {
  const { carol, erin, george } = W;
  scanAll();
  const tip = await erin.transfer(idx, { asset: ASSET, amount: 5n, to: carol.address });
  const env = decodeEnvelope(tip);
  assert.equal(env.anchor, idx.height);
  assert.equal(await verifiesAgainst(tip, idx.tree.root()), true);
  assert.equal(await idx.checkTx(env, NO_TX, idx.height + 1), true);

  // George's refused transfer, proved again at another boundary with the same note.
  const S = RB.epochStart(idx.height, "batch");
  assert.ok(S > B);
  const again = await george.transfer(idx, { asset: ASSET, amount: 10n, to: carol.address, inputs: ten.george.spends, anchor: anchorAt(idx, S) });
  const first = decodeEnvelope(ten.george);
  const second = decodeEnvelope(again);
  assert.equal(second.anchor, S);
  // Real inputs come first; a one-note spend pads with a random dummy nullifier.
  const n = ten.george.spends.length;
  assert.equal(n, 1);
  assert.deepEqual(second.nullifiers.slice(0, n), first.nullifiers.slice(0, n), "same notes, same nullifiers");
  assert.deepEqual(second.nullifiers.slice(0, n).map(String), ten.george.spends);
  assert.deepEqual(again.spends, ten.george.spends);
  assert.notDeepEqual(second.commitments, first.commitments, "fresh output blindings");
  assert.equal(await idx.checkTx(second, NO_TX, idx.height + 1), true);

  // Bob's landed transfer, proved again with its own inputs: it can never pay twice.
  const bobAgain = await W.bob.transfer(idx, { asset: ASSET, amount: 100n, to: carol.address, inputs: ten.bob.spends, anchor: anchorAt(idx, B) }).catch((e) => e);
  assert.match(bobAgain.message, /already spent/);
});

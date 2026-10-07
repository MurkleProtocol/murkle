// Relay timing in the relayer (docs/design/batch-contract.md §3 and §8,
// "relayer"), with relay balances (docs/design/relay-balance-contract.md §4.5): the
// Hourly batch ("batch", 6 blocks) and the 10-hour batch ("batch10", 60 blocks).
// Every submit code with its status and extras, the caps that keep batches apart
// from the Next-block queue, release at S + E in one shuffled flush, the 2x batch
// reservation and the exact charge at release, missed items (fee cap, short balance),
// whole-epoch holds only when the relayer cannot send at all (too few pool coins), the
// per-length deadlines, restart, a reorg of the boundary block, info().batch and
// /api/state, coin capacity and fan-out, and privacy.
//
// Synthetic blocks and fake esplora instances (test/fixtures/relay-harness.mjs):
// nothing touches a network and nothing is ever broadcast for real. Real Groth16
// proofs carry the end-to-end paths (both lengths land and Bob finds the notes; the
// reorg). The cap and timing tests use synthetic TRANSACT envelopes, which the test
// indexer checks by every rule except Groth16: a synthetic proof holds only against the
// root it was made for, so a reorg of its anchor block still breaks it.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveKeys } from "../src/keys.mjs";
import { Wallet, anchorAt } from "../src/wallet.mjs";
import { assetIdOf } from "../src/indexer.mjs";
import { decodeEnvelope, encodeDeploy, opReturnPayload } from "../src/envelope.mjs";
import { addressOf } from "../src/btc/funding.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { hex } from "../src/bytes.mjs";
import { epochStart, nextBoundary } from "../src/relay-batch.mjs";
import { DEFAULTS, ERROR_STATUS, MESSAGES, Relayer, configFromEnv, parseSubmit } from "../server/relayer.mjs";
import { createApp } from "../server/indexer-server.mjs";
import {
  FakeEsplora, TestIndexer, fundAccount, makePaidRelayer, newAccount, ownCarrier, poolCoins, signedSubmit, synth as synthAt, txOf,
} from "./fixtures/relay-harness.mjs";

const START = 864_000; // a 60-block boundary, so also a 6-block one
const TEST_IP = "203.0.113.77";
const SAME_24 = "203.0.113.200";
const OTHER_IP = "198.51.100.20";
const ipNo = (i) => `198.18.${i}.1`; // one /24 per submitter
const DIR = mkdtempSync(join(tmpdir(), "murkle-batch-relayer-"));
const hash32 = () => randomBytes(32).toString("hex");
const silent = { warn() {}, error() {}, log() {} };
const relayers = [];
const fakes = [];
const responses = []; // every submit response body, for the privacy check
const statePaths = [];
const QUOTE = 658; // one carrier at 1 sat/vB (598) plus its margin (60)
const BATCH = 2 * QUOTE; // a batch submit reserves twice the quote

// The messages batch-contract §3.3 fixes, word for word (and pool_low, relay-balance-contract §4.4).
const MSG = {
  anchor_not_boundary: "A batch transfer must be anchored to the block that opened its batch. Update the wallet and prove again.",
  epoch_closed: "This batch closed while your transfer was being proved. Prove it again for the next batch.",
  batch_full: "This batch is full. Send with the next block, or try the next batch.",
  batch_disabled: "The relayer is not taking this batch length right now. Send with the next block instead.",
  rate_limited: "Your network has sent the most transfers allowed in this batch. Try the next batch, or send with the next block.",
  pool_low: "The relayer cannot fund more carriers in this block. Try the next block, or pay the fee yourself.",
  block_full: "The relayer has taken enough transfers for this block. Try after the next block.",
  balance_low: MESSAGES.balance_low,
};

after(async () => {
  relayers.forEach((r) => r.close());
  rmSync(DIR, { recursive: true, force: true });
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

// ------------------------------------------------------------------ chain

const idx = new TestIndexer({ startHeight: START });
const alice = new Wallet(deriveKeys(randomBytes(32)));
const bob = new Wallet(deriveKeys(randomBytes(32)));
const ASSET = assetIdOf(START, 1);
let notes; // Alice's minted notes, by leaf order

const synth = (anchor = idx.height) => synthAt(idx, anchor);
const coinbase = () => ({ txid: hash32(), inputs: [], outputs: [] });

async function mine(txs = []) {
  const height = idx.height + 1;
  await idx.applyBlock({ height, hash: hash32(), txs: [coinbase(), ...txs] });
  for (const f of fakes) {
    f.confirm(txs.map((t) => t.txid), height);
    f.tip = Math.max(f.tip, height);
  }
  return height;
}
const tick = (r, chainTip = idx.height) => r.onTick({ chainTip });
/** Mines empty blocks up to `h`, ticking every relayer in `rs` at each height. */
async function advanceTo(h, rs = []) {
  while (idx.height < h) {
    await mine();
    for (const r of rs) await tick(r);
  }
}
/** The relayer's unconfirmed transactions, ready for a block. */
const mempoolTxs = (f) => [...f.mempool].map((id) => parseRawTx(f.txs.get(id)));
/** Carriers (TRANSACT OP_RETURN, no fan-outs) in broadcast order. */
const carried = (f) => f.accepted.map(txOf).filter((tx) => opReturnPayload(tx.getOutput(0).script)?.length === 471);
const payloadOf = (tx) => hex(opReturnPayload(tx.getOutput(0).script));
const sameSet = (a, b, msg) => assert.deepEqual([...a].sort(), [...b].sort(), msg);

/** A real transfer of 100 from one of Alice's notes (explicit inputs: full control over nullifiers). */
async function transferFrom(note, { anchor } = {}) {
  alice.scan(idx);
  return alice.transfer(idx, { asset: ASSET, amount: 100n, to: bob.address, inputs: [note.nullifier], ...(anchor ? { anchor } : {}) });
}

/**
 * A paid relayer with its own fake esplora, after its first tick, and a relay account (r.payer)
 * whose deposits became the pool coins `coins` at C (each a credited deposit merged into C). `margin` sats are
 * moved from that balance to the margin account (as penalties do), for fan-out tests.
 */
async function newRelayer(config = {}, { coins = Array(10).fill(50_000), esplora = new FakeEsplora(), log = silent, dir = mkdtempSync(join(DIR, "r-")), margin = 0, payer = newAccount() } = {}) {
  if (!fakes.includes(esplora)) fakes.push(esplora);
  esplora.tip = Math.max(esplora.tip, idx.height);
  const r = await makePaidRelayer({ idx, esplora, dir, config: { fanoutTarget: 24, ...config }, log, fastDelayMs: () => 60_000 });
  relayers.push(r);
  statePaths.push(join(dir, "relay-balance", "relayer.json"));
  r.payer = payer;
  r.dir = dir;
  await tick(r);
  // Carriers never spend a deposit: each coin is a deposit merged into C on its own, and confirmed.
  if (coins.length) {
    const { merges } = await poolCoins({ relayer: r, esplora, values: coins, account: payer, height: idx.height });
    // The setup merges are not broadcasts a test counts.
    const setup = new Set(merges.map((m) => esplora.txs.get(m.txid)));
    esplora.calls = esplora.calls.filter((raw) => !setup.has(raw));
    esplora.accepted = esplora.accepted.filter((raw) => !setup.has(raw));
  }
  if (margin) r.books.penalize(payer.idHex, margin);
  await tick(r);
  return r;
}

async function submit(r, envelope, { mode = "block", ip = TEST_IP, account = r.payer } = {}) {
  const out = await r.submit(signedSubmit(account, r.info(), envelope, mode), ip);
  responses.push(JSON.stringify(out.body));
  return out;
}
const accept = async (r, envelope, opts) => {
  const out = await submit(r, envelope, opts);
  assert.equal(out.status, 202, JSON.stringify(out.body));
  return out.body;
};
function expectError(out, status, code, extra = {}) {
  assert.equal(out.status, status, `${code}: ${JSON.stringify(out.body)}`);
  assert.deepEqual(out.body, { error: { code, message: MSG[code], ...extra } });
}
const noValidating = (r) => [...r.pending.values()].every((v) => !String(v).startsWith("validating"));
const other = (mode) => (mode === "batch" ? "batch10" : "batch");
const E = { batch: 6, batch10: 60 };
const acct = (r, a = r.payer) => r.books.account(a.idHex);
const MERGE_FEE = 112; // a one-deposit merge at 1 sat/vB: each pool coin v is a deposit of v + 112 (poolCoins)

// ------------------------------------------------------------------ tests

test("parseSubmit takes the four modes and refuses the retired batch12; config names and defaults; BATCH10_SAFETY_BLOCKS must be 1..40", () => {
  const body = (mode) => JSON.stringify({ envelope: "ab".repeat(471), accountPub: "11".repeat(32), t: 1, sig: "22".repeat(64), ...(mode === undefined ? {} : { mode }) });
  for (const mode of ["block", "fast", "batch", "batch10"]) assert.equal(parseSubmit(body(mode)).mode, mode);
  assert.throws(() => parseSubmit(body()), (e) => e.code === "malformed", "the mode is signed, so it is required");
  for (const mode of ["batch6", "Batch", "hourly", "batch24", "batch12", "", 6, ["batch"], { mode: "batch" }]) {
    assert.throws(() => parseSubmit(body(mode)), (e) => e.code === "malformed" && e.status === 400, JSON.stringify(mode));
  }

  assert.deepEqual(
    [DEFAULTS.maxBatchPerEpoch, DEFAULTS.maxBatch10PerEpoch, DEFAULTS.batchPerIp, DEFAULTS.batch10SafetyBlocks, DEFAULTS.safetyBlocks, DEFAULTS.batchHeadroom],
    [40, 120, 3, 12, 24, 2],
  );
  assert.deepEqual([DEFAULTS.fanoutValue, DEFAULTS.fanoutMinCarriers, DEFAULTS.fanoutTarget, DEFAULTS.fanoutMinConfirmed, "hotFloorSats" in DEFAULTS], [13_000, 120, 24, 6, false]);
  const env = { MAX_BATCH_PER_EPOCH: "12", MAX_BATCH10_PER_EPOCH: "0", BATCH_PER_IP: "1", BATCH10_SAFETY_BLOCKS: "20", FANOUT_VALUE: "15000", FANOUT_MIN_CARRIERS: "60", RELAY_BATCH_HEADROOM: "3" };
  const cfg = configFromEnv((name) => env[name]);
  assert.deepEqual(
    [cfg.maxBatchPerEpoch, cfg.maxBatch10PerEpoch, cfg.batchPerIp, cfg.batch10SafetyBlocks, cfg.fanoutValue, cfg.fanoutMinCarriers, cfg.batchHeadroom],
    [12, 0, 1, 20, 15_000, 60, 3],
  );
  // The 12-hour batch's names are gone: they are not read, and they set nothing.
  const old = configFromEnv((name) => ({ MAX_BATCH12_PER_EPOCH: "0", BATCH12_SAFETY_BLOCKS: "20" })[name]);
  assert.deepEqual([old.maxBatch10PerEpoch, old.batch10SafetyBlocks, "maxBatch12PerEpoch" in old, "batch12SafetyBlocks" in old], [120, 12, false, false]);
  assert.throws(() => configFromEnv((n) => (n === "BATCH_PER_IP" ? "-1" : undefined)), /MURKLE_BATCH_PER_IP/);

  // A 10-hour batch is released at S + 60, so its deadline S + 100 - safety allows a safety of at most 40.
  const keys = { poolKey: new Uint8Array(32).fill(7), changeKey: new Uint8Array(32).fill(9) };
  const make = (batch10SafetyBlocks) => new Relayer({ idx, esplora: new FakeEsplora(), ...keys, config: { statePath: null, batch10SafetyBlocks }, log: silent });
  for (const bad of [0, 41, 100, 12.5, -1, "12"]) assert.throws(() => make(bad), /BATCH10_SAFETY_BLOCKS must be a whole number from 1 to 40/, String(bad));
  for (const ok of [1, 12, 26, 40]) assert.equal(make(ok).safetyFor("batch10"), ok);
  assert.equal(make(40).schedule("batch10", START).lastRelease, START + 60, "no slack, but still valid");
  assert.deepEqual(make(12).schedule("batch10", START), { releaseAt: START + 60, lastRelease: START + 88 }, "28 blocks of slack, 40 before the window ends");
  assert.equal(make(12).safetyFor("batch"), 24);
  const makeHourly = (safetyBlocks) => new Relayer({ idx, esplora: new FakeEsplora(), ...keys, config: { statePath: null, safetyBlocks }, log: silent });
  for (const bad of [0, 95, 101, 24.5, "24"]) assert.throws(() => makeHourly(bad), /SAFETY_BLOCKS must be a whole number from 1 to 94/, String(bad));
  assert.equal(makeHourly(94).schedule("batch", START).lastRelease, START + 6, "no slack, but still valid");

  assert.deepEqual(
    [ERROR_STATUS.anchor_not_boundary, ERROR_STATUS.epoch_closed, ERROR_STATUS.batch_full, ERROR_STATUS.batch_disabled, ERROR_STATUS.rate_limited, ERROR_STATUS.pool_low, ERROR_STATUS.balance_low],
    [422, 422, 503, 503, 429, 503, 402],
  );
  assert.equal("hot_wallet_low" in ERROR_STATUS, false);
});

test("setup: a free token and six real notes for Alice", async () => {
  await mine([ownCarrier(encodeDeploy({ ticker: "HOURS", divisibility: 0, mintAmount: 100n, mintCap: 1000, priceSats: 0n, treasury: new Uint8Array() }))]);
  const mints = [];
  for (let i = 0; i < 6; i++) {
    const bind = randomBytes(36);
    mints.push(ownCarrier(await alice.mint(idx, { asset: ASSET, mintAmount: 100n, bindOutpoint: bind }), bind));
  }
  await mine(mints);
  notes = alice.scan(idx).notes.sort((a, b) => a.leafIndex - b.leafIndex);
  assert.equal(notes.length, 6);
  assert.equal(alice.balance(ASSET), 600n);
  assert.equal(idx.height, START + 1);
});

test("the retired 12-hour mode \"batch12\" is refused as malformed, even at a 72-block boundary; nothing is reserved or queued", async () => {
  const r = await newRelayer();
  const anchor = idx.height - (idx.height % 72); // START, a boundary of the old 12-hour batch too
  const before = acct(r);
  const out = await submit(r, synth(anchor), { mode: "batch12" });
  assert.equal(out.status, 400);
  assert.equal(out.body.error.code, "malformed");
  assert.deepEqual([r.queuedAll(), r.pending.size], [0, 0]);
  assert.deepEqual(acct(r), before);
  assert.deepEqual(Object.keys(r.info().batch.modes), ["batch", "batch10"]);
  assert.deepEqual(Object.keys(r.batchSummary()), ["batch", "batch10"]);
  // The same envelope in a current length goes through, and reserves twice the quote.
  const body = await accept(r, synth(anchor), { mode: "batch10" });
  assert.deepEqual([body.releaseAt, body.reservedSats, acct(r).reserved], [anchor + 60, BATCH, BATCH]);
});

test("each code, with its status and extras, for both lengths", async () => {
  for (const mode of ["batch", "batch10"]) {
    const e = E[mode];
    const S = nextBoundary(idx.height, mode);
    await advanceTo(S);
    const rFull = await newRelayer({ maxBatchPerEpoch: 1, maxBatch10PerEpoch: 1 });
    const rIp = await newRelayer({ batchPerIp: 1 });
    const rOff = await newRelayer({ [mode === "batch" ? "maxBatchPerEpoch" : "maxBatch10PerEpoch"]: 0 });
    const rLow = await newRelayer({}, { coins: [3000] }); // 2,824: one batch reservation (1,316) fits twice, not three times
    const rCap = await newRelayer({ batchHeadroom: 1 }, { coins: [2000, 2000] }); // two coins of 2 carriers each at 1 sat/vB
    // A payment to the pool key nobody credited funds nothing: the relayer never sees it.
    rCap.esplora.pay([{ script: rCap.poolScript, value: 100_000 }]);
    await tick(rCap);
    await mine(); // S + 1: inside the epoch
    const h = idx.height;
    const otherStart = epochStart(h, other(mode));

    // anchor_not_boundary: for the 10-hour batch, an hourly boundary is not enough.
    const off = mode === "batch" ? S + 1 : S - 6;
    expectError(await submit(rIp, synth(off), { mode }), 422, "anchor_not_boundary", { epochBlocks: e });
    // epoch_closed: anchored at the previous boundary.
    expectError(await submit(rIp, synth(S - e), { mode }), 422, "epoch_closed", { mode, epochStart: S, releaseAt: S + e });

    // batch_full (cap 1); a Next-block submit still goes through.
    assert.equal((await accept(rFull, synth(S), { mode })).epochQueued, 1);
    expectError(await submit(rFull, synth(S), { mode }), 503, "batch_full", { releaseAt: S + e });
    assert.equal((await accept(rFull, synth(h))).flush, "next-block");
    assert.ok(noValidating(rFull));

    // batch_disabled (cap 0) for this length only.
    expectError(await submit(rOff, synth(S), { mode }), 503, "batch_disabled");
    assert.equal(rOff.info().batch.modes[mode].enabled, false);
    assert.equal((await accept(rOff, synth(otherStart), { mode: other(mode) })).flush, other(mode));

    // Per-IP (cap 1): the same /24 is refused; another /24, and the same IP in the other length, are not.
    await accept(rIp, synth(S), { mode });
    expectError(await submit(rIp, synth(S), { mode, ip: SAME_24 }), 429, "rate_limited", { retryAfter: (S + e - h) * 600 });
    await accept(rIp, synth(S), { mode, ip: OTHER_IP });
    await accept(rIp, synth(otherStart), { mode: other(mode) });
    assert.equal(rIp.batchQueued(mode, S), 2);

    // balance_low from reservations: 2,824 - 1,316 - 1,316 = 192 < 1,316.
    await accept(rLow, synth(S), { mode });
    await accept(rLow, synth(S), { mode, ip: OTHER_IP });
    expectError(await submit(rLow, synth(S), { mode, ip: ipNo(40) }), 402, "balance_low", { balance: 192, needed: BATCH, perSend: QUOTE });
    assert.deepEqual(acct(rLow), { balance: 192, reserved: 2 * BATCH, nextIndex: 1 });

    // pool_low from coin capacity: two 2,000-sat deposits fund 4 carriers; the uncredited 100,000 sats fund none.
    assert.equal(rCap.capacity(), 4);
    await accept(rCap, synth(h)); // a Next-block item counts too
    await accept(rCap, synth(S), { mode });
    await accept(rCap, synth(S), { mode, ip: OTHER_IP });
    await accept(rCap, synth(S), { mode, ip: ipNo(41) });
    expectError(await submit(rCap, synth(S), { mode, ip: ipNo(42) }), 503, "pool_low");
    for (const r of [rFull, rIp, rOff, rLow, rCap]) assert.ok(noValidating(r));

    // The tip reaches the next boundary while the proof is checked: epoch_closed at step 8, nothing kept.
    await advanceTo(S + e - 1);
    const rRace = await newRelayer();
    const before = acct(rRace);
    const real = idx.checkTx;
    idx.checkTx = async (...args) => {
      const verdict = await real.apply(idx, args);
      await mine();
      return verdict;
    };
    try {
      expectError(await submit(rRace, synth(S), { mode }), 422, "epoch_closed", { mode, epochStart: S + e, releaseAt: S + 2 * e });
    } finally {
      idx.checkTx = real;
    }
    assert.deepEqual([rRace.queuedAll(), rRace.pending.size], [0, 0]);
    assert.deepEqual(acct(rRace), before, "nothing reserved");
  }
});

test("batch items count toward neither MAX_QUEUE nor block_full", async () => {
  const S = nextBoundary(idx.height, "batch");
  await advanceTo(S);
  const r = await newRelayer({ maxQueue: 1, maxRelaysPerBlock: 1, batchPerIp: 5 });
  const S10 = epochStart(S, "batch10");
  await accept(r, synth(S), { mode: "batch" });
  await accept(r, synth(S), { mode: "batch" });
  await accept(r, synth(S10), { mode: "batch10" });
  assert.deepEqual([r.queuedCount(), r.info().queue.queued, r.queuedAll(), r.batchQueued("batch", S), r.batchQueued("batch10", S10)], [0, 0, 3, 2, 1]);
  assert.equal(r.acceptedThisBlock, 0);
  assert.equal(r.gateCode("block"), null);

  assert.equal((await accept(r, synth(S))).flush, "next-block", "a Next-block submit is not crowded out by batches");
  assert.equal(r.gateCode("block"), "block_full");
  expectError(await submit(r, synth(S)), 503, "block_full");
  await accept(r, synth(S), { mode: "batch" }); // block_full and queue_full do not apply to batches
  r.config.maxRelaysPerBlock = 40;
  assert.equal(r.gateCode("block"), "queue_full");
  assert.equal(r.gateCode("batch"), null);
  await mine();
  assert.equal(r.blockCount(), 0, "block_full counts per block");
});

let MAIN; // the relayer of the release test
let MAIN_STATE;

test("same anchor S: hourly items go at S+6 with the queued Next-block items in one flush, 10-hour items at S+60; real proofs land; exact charges", async () => {
  const S = nextBoundary(idx.height, "batch10");
  await advanceTo(S);
  const R = (MAIN = await newRelayer({ fanoutTarget: 0 }));
  MAIN_STATE = join(R.dir, "relay-balance", "relayer.json");
  const F = R.esplora;
  const H = [await transferFrom(notes[0]), await transferFrom(notes[1])]; // proven at the tip, S
  const T1 = await transferFrom(notes[2]);
  assert.equal(decodeEnvelope(H[0]).anchor, S);
  const hourly = [...H, synth(S), synth(S), synth(S)];
  const ten = [T1, synth(S)];
  const ids = { batch: [], batch10: [] };
  let n = 0;
  const start = acct(R).balance;
  for (const env of hourly) {
    const body = await accept(R, env, { mode: "batch", ip: ipNo(n++) });
    assert.match(body.id, /^[0-9a-f]{32}$/);
    assert.deepEqual({ ...body, id: "-", balance: "-" }, {
      id: "-", status: "queued", anchor: S, deadline: S + 100, flush: "batch", reservedSats: BATCH, balance: "-",
      mode: "batch", epochBlocks: 6, releaseAt: S + 6, lastRelease: S + 76, epochQueued: 1,
    }, "the count published at this block (none yet) plus this one");
    ids.batch.push(body.id);
  }
  for (const env of ten) {
    const body = await accept(R, env, { mode: "batch10", ip: ipNo(n++) });
    assert.deepEqual({ ...body, id: "-", balance: "-" }, {
      id: "-", status: "queued", anchor: S, deadline: S + 100, flush: "batch10", reservedSats: BATCH, balance: "-",
      mode: "batch10", epochBlocks: 60, releaseAt: S + 60, lastRelease: S + 88, epochQueued: 1,
    });
    ids.batch10.push(body.id);
  }
  assert.deepEqual(acct(R), { balance: start - 7 * BATCH, reserved: 7 * BATCH, nextIndex: 10 });
  assert.deepEqual(R.status(ids.batch[0]), { status: "queued", anchor: S, deadline: S + 100, mode: "batch", releaseAt: S + 6, lastRelease: S + 76 });
  assert.deepEqual(R.status(ids.batch10[0]), { status: "queued", anchor: S, deadline: S + 100, mode: "batch10", releaseAt: S + 60, lastRelease: S + 88 });
  const saved = JSON.parse(readFileSync(MAIN_STATE, "utf8")).items[ids.batch10[0]];
  assert.deepEqual([saved.mode, saved.anchor, saved.releaseAt, saved.lastRelease], ["batch10", S, S + 60, S + 88]);

  // S+1 .. S+5: no batch item goes; a Next-block item submitted at S+3 goes on its own at S+4.
  let N1, N2;
  for (let h = S + 1; h <= S + 5; h++) {
    await mine();
    await tick(R);
    assert.deepEqual(carried(F).map(payloadOf), h >= S + 4 ? [hex(N1)] : [], `block ${h}`);
    if (h === S + 3) await accept(R, (N1 = synth(h)));
    if (h === S + 5) await accept(R, (N2 = synth(h)));
  }

  // S+6: the fast-mode path never takes a batch item; the tick's flush takes the whole epoch and N2.
  await mine();
  await R.flush({ only: [ids.batch[0]] });
  assert.equal(carried(F).length, 1);
  await tick(R);
  const wave = carried(F).slice(1);
  sameSet(wave.map(payloadOf), [...hourly, N2].map(hex), "every hourly item and the queued Next-block item, in one flush");
  for (const tx of wave) {
    assert.equal(tx.inputsLength, 1);
    assert.equal(tx.getInput(0).sequence, 0xfffffffd, "L5: RBF signalled on every input, as every route does");
    assert.equal(tx.outputsLength, 2);
    assert.equal(addressOf(tx.getOutput(1).script), R.address, "change goes to the relayer's change key C");
  }
  for (const id of ids.batch) assert.equal(R.status(id).status, "broadcast");
  for (const id of ids.batch10) assert.equal(R.status(id).status, "queued");
  // Each hourly item was charged its exact cost; the rest of its 2x reservation came back.
  assert.deepEqual(acct(R), { balance: start - 2 * BATCH - 7 * QUOTE, reserved: 2 * BATCH, nextIndex: 10 });
  assert.ok(ids.batch.every((id) => R.status(id).cost === QUOTE));
  assert.deepEqual(R.state.ledger.filter((l) => l.epoch).map((l) => l.epoch), Array(5).fill(`batch:${S}`));
  assert.ok(R.ledgerView().items.every((l) => !("epoch" in l)), "the epoch tag stays internal");

  // S+7: they land together; the real proofs verify; Bob finds both notes.
  assert.equal(await mine(mempoolTxs(F)), S + 7);
  await tick(R);
  const st = R.status(ids.batch[0]);
  assert.deepEqual({ ...st, txid: "-" }, { status: "accepted", txid: "-", height: S + 7, broadcastHeight: S + 6, cost: QUOTE, anchor: S, deadline: S + 100, mode: "batch", releaseAt: S + 6, lastRelease: S + 76 });
  assert.ok(ids.batch.every((id) => R.status(id).status === "accepted"));
  assert.deepEqual(R.info().batch.recent, [{ mode: "batch", start: S, releaseAt: S + 6, released: 5, landed: [[S + 7, 5]] }]);
  assert.equal(bob.scan(idx).balance(ASSET), 200n);

  // The 10-hour epoch waits through S+59. At S+30 one more joins, proven then against the tree at S.
  let T2;
  for (let h = S + 8; h <= S + 59; h++) {
    await mine();
    await tick(R);
    if (h === S + 30) {
      T2 = await transferFrom(notes[3], { anchor: anchorAt(idx, S) });
      assert.equal(decodeEnvelope(T2).anchor, S, "an ordinary TRANSACT with an older anchor");
      assert.equal((await accept(R, T2, { mode: "batch10", ip: ipNo(n++) })).epochQueued, 3);
    }
  }
  assert.equal(carried(F).length, 7, "nothing more before S + 60");
  await mine(); // S + 60
  await tick(R);
  sameSet(carried(F).slice(7).map(payloadOf), [...ten, T2].map(hex));
  assert.equal(await mine(mempoolTxs(F)), S + 61);
  await tick(R);
  for (const id of ids.batch10) assert.deepEqual([R.status(id).status, R.status(id).height], ["accepted", S + 61]);
  assert.deepEqual(R.info().batch.recent, [
    { mode: "batch10", start: S, releaseAt: S + 60, released: 3, landed: [[S + 61, 3]] },
    { mode: "batch", start: S, releaseAt: S + 6, released: 5, landed: [[S + 7, 5]] },
  ]);
  assert.equal(bob.scan(idx).balance(ASSET), 400n);
  assert.deepEqual(acct(R), { balance: start - 10 * QUOTE, reserved: 0, nextIndex: 10 });
  assert.equal(R.pending.size, 0);
  assert.equal(R.checkBooks().ok, true);
});

test("at release: above the cap every item is missed (nothing charged); a short balance misses only its own item, the rest go on time", async () => {
  const S = nextBoundary(idx.height, "batch");
  await advanceTo(S);
  const rFee = await newRelayer({ fanoutTarget: 0 });
  const rShort = await newRelayer({ fanoutTarget: 0 });
  const all = [rFee, rShort];
  const epoch = new Map(all.map((r) => [r, []]));
  for (let i = 0; i < 3; i++) epoch.get(rFee).push((await accept(rFee, synth(S), { mode: "batch", ip: ipNo(i) })).id);
  // rShort: two well-funded accounts and one whose balance covers the reservation, not the cost at 3 sat/vB.
  const short = newAccount();
  await fundAccount({ relayer: rShort, esplora: rShort.esplora, account: short, sats: 2000 });
  epoch.get(rShort).push((await accept(rShort, synth(S), { mode: "batch", ip: ipNo(0) })).id);
  epoch.get(rShort).push((await accept(rShort, synth(S), { mode: "batch", ip: ipNo(1) })).id);
  const shortId = (await accept(rShort, synth(S), { mode: "batch", ip: ipNo(2), account: short })).id;
  await advanceTo(S + 5, all);
  assert.ok(all.every((r) => carried(r.esplora).length === 0));

  // At S+6: rFee is above the cap; rShort is at 3 sat/vB, 1,794 + 180 = 1,974 a carrier.
  rFee.esplora.fee = 6;
  rShort.esplora.fee = 3;
  await mine();
  for (const r of all) await tick(r);
  const status = (r, ids) => ids.map((id) => r.status(id).status);
  assert.deepEqual(status(rFee, epoch.get(rFee)), ["missed", "missed", "missed"]);
  assert.ok(epoch.get(rFee).every((id) => rFee.status(id).code === "fee_high"));
  assert.deepEqual(acct(rFee), { balance: 10 * (50_000 + MERGE_FEE - 288), reserved: 0, nextIndex: 10 }, "nothing charged");
  assert.equal(carried(rFee.esplora).length, 0);
  assert.deepEqual(status(rShort, epoch.get(rShort)), ["broadcast", "broadcast"], "the rest of the epoch went out on time");
  assert.deepEqual([rShort.status(shortId).status, rShort.status(shortId).code], ["missed", "balance_low"]);
  assert.deepEqual(acct(rShort, short), { balance: 1712, reserved: 0, nextIndex: 1 }, "its reservation came back");
  assert.deepEqual(acct(rShort), { balance: 10 * (50_000 + MERGE_FEE - 288) - 2 * 1974, reserved: 0, nextIndex: 10 }, "the others paid the exact cost at release");
  // A top-up afterwards never sends the missed item.
  await fundAccount({ relayer: rShort, esplora: rShort.esplora, account: short, sats: 9000 });
  rShort.esplora.fee = 1;
  await advanceTo(S + 9, [rShort]);
  assert.equal(rShort.status(shortId).status, "missed");
  assert.equal(carried(rShort.esplora).length, 2);
  for (const r of all) assert.equal(r.checkBooks().ok, true);
});

test("too few pool coins hold an epoch whole, the Next-block item still goes; the next block it goes whole, a network error splits it and the journal resends", async () => {
  const S = nextBoundary(idx.height, "batch");
  await advanceTo(S);
  const logs = [];
  const capture = { warn: (m) => logs.push(m), error() {}, log() {} };
  const r = await newRelayer({ fanoutTarget: 0 }, { coins: [2000, 2000, 2000, 2000], log: capture });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await accept(r, synth(S), { mode: "batch", ip: ipNo(i) })).id);
  await advanceTo(S + 5, [r]);
  const nb = (await accept(r, synth(S + 5))).id;
  // At S+6, 3 sat/vB (under the cap): a 2,000-sat coin funds no carrier (1,794 + 330 > 2,000).
  r.esplora.fee = 3;
  await mine();
  await tick(r);
  const status = () => ids.map((id) => r.status(id).status);
  assert.deepEqual(status(), ["queued", "queued", "queued"], "the epoch waits whole");
  assert.equal(r.status(nb).status, "queued", "the Next-block item has no coin either: it waits");
  assert.ok(logs.some((m) => m.includes(`batch batch:${S} (3) held whole until the next block: too few pool coins`)));
  // A top-up brings a coin; back at 2 sat/vB the Next-block item goes first, the epoch whole after it.
  r.esplora.fee = 2;
  await fundAccount({ relayer: r, esplora: r.esplora, account: r.payer, sats: 50_000 });
  await tick(r); // same height: the deposit is merged into C (no flush between blocks)
  const calls = r.esplora.calls.length;
  r.esplora.failNext = new Error("socket hang up");
  await mine();
  await tick(r);
  assert.equal(r.esplora.calls.length - calls, 4, "all four were attempted in the same flush");
  assert.deepEqual([...status(), r.status(nb).status].sort(), ["broadcast", "broadcast", "broadcast", "queued"], "signing is reported as queued");
  await mine();
  await tick(r);
  assert.deepEqual([...status(), r.status(nb).status], ["broadcast", "broadcast", "broadcast", "broadcast"], "the journaled carrier is resent next block");
  assert.equal(r.checkBooks().ok, true);
});

test("deadlines: an hourly epoch held past S+76 and a 10-hour epoch held past S+88 expire whole, unbroadcast, nothing charged", async () => {
  const S = nextBoundary(idx.height, "batch10");
  await advanceTo(S);
  // Two 2,000-sat deposits: at 4 sat/vB (under the cap) they fund no carrier, so the epoch is held, never missed.
  const r6 = await newRelayer({ fanoutTarget: 0 }, { coins: [2000, 2000] });
  const r60 = await newRelayer({ fanoutTarget: 0 }, { coins: [2000, 2000] });
  const ids6 = [(await accept(r6, synth(S), { mode: "batch" })).id, (await accept(r6, synth(S), { mode: "batch", ip: OTHER_IP })).id];
  const ids60 = [(await accept(r60, synth(S), { mode: "batch10" })).id, (await accept(r60, synth(S), { mode: "batch10", ip: OTHER_IP })).id];
  r6.esplora.fee = 4;
  const st = (r, ids) => ids.map((id) => r.status(id).status);
  for (let h = S + 1; h <= S + 89; h++) {
    if (h === S + 60) r60.esplora.fee = 4;
    await mine();
    await tick(r6);
    await tick(r60);
    if (h === S + 76) assert.deepEqual(st(r6, ids6), ["queued", "queued"], "S+76 is the last block it may go out");
    if (h === S + 77) assert.deepEqual(st(r6, ids6), ["expired", "expired"]);
    if (h === S + 59) assert.deepEqual(st(r60, ids60), ["queued", "queued"]);
    if (h === S + 88) assert.deepEqual(st(r60, ids60), ["queued", "queued"], "S+88 is the last block it may go out");
  }
  assert.deepEqual(st(r60, ids60), ["expired", "expired"]);
  assert.equal(r6.status(ids6[0]).reason, `the batch could not be sent before block ${S + 76}`);
  assert.equal(r60.status(ids60[1]).reason, `the batch could not be sent before block ${S + 88}`);
  for (const r of [r6, r60]) {
    assert.equal(r.esplora.calls.length, 0, "never broadcast");
    assert.deepEqual([acct(r).reserved, acct(r).balance, r.pending.size, r.state.ledger.filter((l) => l.kind !== "merge").length], [0, 2 * (2000 + MERGE_FEE - 288), 0, 0]);
  }
});

test("restart between acceptance and release: items reload with mode, releaseAt, lastRelease and reservations and go at the right height", async () => {
  const S = nextBoundary(idx.height, "batch10");
  await advanceTo(S);
  const r1 = await newRelayer({ fanoutTarget: 0 });
  const F = r1.esplora;
  const hourly = [synth(S), synth(S)];
  const ten = synth(S);
  const ids = [];
  for (const env of hourly) ids.push((await accept(r1, env, { mode: "batch", ip: ipNo(ids.length) })).id);
  ids.push((await accept(r1, ten, { mode: "batch10" })).id);
  r1.close();
  // An item saved before the batch fields existed gets them back from its anchor and mode.
  const path = join(r1.dir, "relay-balance", "relayer.json");
  const file = JSON.parse(readFileSync(path, "utf8"));
  delete file.items[ids[0]].releaseAt;
  delete file.items[ids[0]].lastRelease;
  writeFileSync(path, JSON.stringify(file));

  const r2 = await makePaidRelayer({ idx, esplora: F, dir: r1.dir, config: { fanoutTarget: 0 }, log: silent });
  relayers.push(r2);
  r2.payer = r1.payer;
  assert.deepEqual(ids.map((id) => r2.status(id)), [
    { status: "queued", anchor: S, deadline: S + 100, mode: "batch", releaseAt: S + 6, lastRelease: S + 76 },
    { status: "queued", anchor: S, deadline: S + 100, mode: "batch", releaseAt: S + 6, lastRelease: S + 76 },
    { status: "queued", anchor: S, deadline: S + 100, mode: "batch10", releaseAt: S + 60, lastRelease: S + 88 },
  ]);
  assert.equal(acct(r2).reserved, 3 * BATCH);
  assert.equal(r2.pending.size, 6);
  await tick(r2);
  await advanceTo(S + 5, [r2]);
  assert.equal(F.calls.length, 0);
  await advanceTo(S + 6, [r2]);
  sameSet(carried(F).map(payloadOf), hourly.map(hex));
  await mine(mempoolTxs(F));
  await tick(r2);
  await advanceTo(S + 59, [r2]);
  assert.equal(carried(F).length, 2);
  await advanceTo(S + 60, [r2]);
  assert.deepEqual(carried(F).slice(2).map(payloadOf), [hex(ten)]);
  assert.equal(acct(r2).reserved, 0);
});

test("reorg of block S: the precheck verifies again and drops what no longer holds (nothing charged); the same notes join the next batch", async () => {
  const S = nextBoundary(idx.height, "batch");
  await advanceTo(S);
  const r = await newRelayer({ fanoutTarget: 0 });
  const real = await transferFrom(notes[4]); // proven at S, against R[S]
  const fake = synth(S);
  const before = acct(r).balance;
  const ids = [(await accept(r, real, { mode: "batch" })).id, (await accept(r, fake, { mode: "batch", ip: OTHER_IP })).id];
  const rootAtS = String(idx.roots.get(S));

  // Block S replaced by a block with the same (empty) contents: R[S] is unchanged, both stay queued.
  idx.rollbackTo(S - 1);
  await mine();
  assert.equal(String(idx.roots.get(S)), rootAtS);
  await tick(r);
  assert.deepEqual(ids.map((id) => r.status(id).status), ["queued", "queued"]);

  // Replaced again, now with a transfer in it: R[S] changes and neither proof holds.
  idx.rollbackTo(S - 1);
  await mine([ownCarrier(synth(S - 1))]);
  assert.notEqual(String(idx.roots.get(S)), rootAtS);
  await advanceTo(S + 6, [r]);
  for (const id of ids) {
    assert.equal(r.status(id).status, "dropped");
    assert.match(r.status(id).reason, /^no longer valid after a reorg: proof does not verify/);
  }
  assert.equal(r.esplora.calls.length, 0);
  assert.deepEqual([acct(r).reserved, acct(r).balance, r.pending.size], [0, before, 0]);

  // Retry in the next batch: the same note, proven again at the new boundary, same nullifiers.
  const again = await transferFrom(notes[4]);
  assert.deepEqual(again.spends, real.spends);
  assert.equal(decodeEnvelope(again).anchor, S + 6);
  assert.equal((await accept(r, again, { mode: "batch" })).releaseAt, S + 12);
});

test("info().batch, batchSummary() and recent (with a split landing); /api/state, /api/relay/info and status over HTTP", async () => {
  const S = nextBoundary(idx.height, "batch");
  await advanceTo(S);
  const S10 = epochStart(S, "batch10");
  const r = await newRelayer({ fanoutTarget: 0 });
  const F = r.esplora;
  const ids = [];
  // Published once per block: within the block the submits happen in, nothing public moves.
  const before = JSON.stringify([r.info().batch, r.batchSummary(), r.info().code, r.info().queue]);
  for (let i = 0; i < 3; i++) ids.push((await accept(r, synth(S), { mode: "batch", ip: ipNo(i) })).id);
  const id10 = (await accept(r, synth(S10), { mode: "batch10" })).id;
  assert.equal(JSON.stringify([r.info().batch, r.batchSummary(), r.info().code, r.info().queue]), before, "no live count");
  assert.deepEqual([r.batchQueued("batch", S), acct(r).reserved], [3, 4 * BATCH], "the relayer itself counts them at once");
  await mine(); // S + 1: the snapshot of the new block shows them
  assert.deepEqual(r.info().batch, {
    perIp: 3,
    modes: {
      batch: { epochBlocks: 6, maxPerEpoch: 40, safety: 24, enabled: true, current: { start: S, releaseAt: S + 6, lastRelease: S + 76, queued: 3 } },
      batch10: { epochBlocks: 60, maxPerEpoch: 120, safety: 12, enabled: true, current: { start: S10, releaseAt: S10 + 60, lastRelease: S10 + 88, queued: 1 } },
    },
    recent: [],
  });
  assert.deepEqual(r.batchSummary(), { batch: { start: S, releaseAt: S + 6, queued: 3 }, batch10: { start: S10, releaseAt: S10 + 60, queued: 1 } });
  assert.equal(r.info().queue.queued, 0);

  await advanceTo(S + 6, [r]);
  assert.equal(carried(F).length, 3);
  assert.deepEqual(r.info().batch.modes.batch.current, { start: S + 6, releaseAt: S + 12, lastRelease: S + 82, queued: 0 });
  assert.deepEqual(r.info().batch.recent, [{ mode: "batch", start: S, releaseAt: S + 6, released: 3, landed: [] }]);
  // A miner leaves one carrier out of S+7: the batch lands split, and recent says so.
  const txs = mempoolTxs(F);
  await mine(txs.slice(0, 2));
  await tick(r);
  await mine(txs.slice(2));
  await tick(r);
  assert.deepEqual(r.info().batch.recent, [{ mode: "batch", start: S, releaseAt: S + 6, released: 3, landed: [[S + 7, 2], [S + 8, 1]] }]);

  const app = createApp({ idx, relayer: r, webDist: join(DIR, "no-dist"), log: silent });
  const stub = createApp({ idx, relayer: { config: { enabled: true }, queuedCount: () => 0, info: () => ({}) }, webDist: join(DIR, "no-dist"), log: silent });
  const none = createApp({ idx, webDist: join(DIR, "no-dist"), log: silent });
  const listen = async (a) => {
    await new Promise((done) => a.server.listen(0, "127.0.0.1", done));
    return `http://127.0.0.1:${a.server.address().port}`;
  };
  const [base, stubBase, noneBase] = [await listen(app), await listen(stub), await listen(none)];
  try {
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.deepEqual(state.relay, { enabled: true, mode: "balance", queued: 0, defaultMode: "block", batch: r.batchSummary() });
    assert.equal(state.relay.batch.batch10.queued, 1);
    const info = await (await fetch(`${base}/api/relay/info`)).json();
    assert.deepEqual(info.batch, JSON.parse(JSON.stringify(r.info().batch)));
    const st = await (await fetch(`${base}/api/relay/status/${id10}`)).json();
    assert.deepEqual([st.mode, st.releaseAt, st.lastRelease], ["batch10", S10 + 60, S10 + 88]);
    const late = ids.find((id) => r.status(id).height === S + 8);
    const st6 = await (await fetch(`${base}/api/relay/status/${late}`)).json();
    assert.deepEqual([st6.status, st6.height, st6.mode, st6.releaseAt], ["accepted", S + 8, "batch", S + 6]);

    // A signed batch submit over HTTP.
    const env = synth(idx.height - (idx.height % 6));
    const res = await fetch(`${base}/api/relay/submit`, { method: "POST", headers: { "content-type": "application/json" }, body: signedSubmit(r.payer, r.info(), env, "batch") });
    const body = await res.json();
    responses.push(JSON.stringify(body));
    assert.equal(res.status, 202, JSON.stringify(body));
    assert.deepEqual([body.flush, body.mode, body.epochBlocks, body.epochQueued, body.reservedSats], ["batch", "batch", 6, 1, BATCH]);

    // A relayer without batchSummary (the server test's stub), and no relayer at all.
    const stubState = await fetch(`${stubBase}/api/state`);
    assert.equal(stubState.status, 200);
    assert.deepEqual((await stubState.json()).relay, { enabled: true, mode: "balance", queued: 0, defaultMode: "block", batch: null });
    assert.deepEqual((await (await fetch(`${noneBase}/api/state`)).json()).relay, { enabled: false, mode: null, queued: 0, defaultMode: "block", batch: null });
  } finally {
    for (const a of [app, stub, none]) await new Promise((done) => a.server.close(done));
  }
});

test("coin capacity and fan-out: 7,000 + 3 x 10,000 fund 59 carriers with no split; only a coin one chain cannot use up is split, paid from the margin", async () => {
  // Four deposits: 59 carriers at 1 sat/vB, and nothing worth splitting.
  const today = await newRelayer({}, { coins: [7000, 10_000, 10_000, 10_000] });
  assert.equal(today.capacity(), 59);
  assert.equal(today.esplora.accepted.length, 0);
  assert.equal(today.state.ledger.filter((l) => l.kind !== "merge").length, 0, "nothing but the merges that brought the deposits to C");

  // Capacity counts our unconfirmed change by its depth, nothing of unknown depth.
  const change = { key: `${hash32()}:1`, value: 50_000, confirmed: false };
  assert.equal(today.capacity([change]), 0, "unknown depth");
  assert.equal(today.capacity([{ ...change, depth: 5 }]), 16);
  assert.equal(today.capacity([{ ...change, depth: 21 }]), 0);
  const coin = { key: `${hash32()}:0`, value: 10_000, confirmed: true };
  assert.equal(today.capacity([coin]), 16);
  assert.equal(today.capacity([coin], 2), 8, "1,196 sats per carrier at 2 sat/vB");
  assert.equal(today.capacity([coin], null), 0);
  // A coin a broadcast just said is missing is not counted this block.
  const [{ key: first }] = today.spendableCoins();
  today.suspect.set(first, idx.height);
  assert.ok(today.capacity() < 59);
  today.suspect.clear();

  // A lone 10,000-sat coin is never split (one chain uses it up in a block).
  const small = await newRelayer({}, { coins: [10_000] });
  assert.equal(small.esplora.accepted.length, 0);
  // Even when FANOUT_VALUE would allow it: 12,000 sats fund 19 carriers, one chain; 20,000 fund 32.
  const lowValue = await newRelayer({ fanoutValue: 5000 }, { coins: [12_000] });
  assert.equal(lowValue.esplora.accepted.length, 0);
  const worth = await newRelayer({ fanoutValue: 5000 }, { coins: [20_000], margin: 100 });
  assert.equal(worth.esplora.accepted.length, 1);
  const w0 = txOf(worth.esplora.accepted[0]);
  assert.ok(Array.from({ length: w0.outputsLength }, (_, v) => w0.getOutput(v).amount).includes(5000n));

  // One 100,000-sat coin: split into 7 x 13,000 plus change, once the margin account can pay it.
  const big = await newRelayer({}, { coins: [100_000] });
  assert.equal(big.esplora.accepted.length, 0, "the margin (one sweep cost, 288, less its merge, 112) cannot pay 413 sats");
  big.books.penalize(big.payer.idHex, 312);
  await tick(big);
  assert.equal(big.esplora.accepted.length, 1);
  const tx = txOf(big.esplora.accepted[0]);
  assert.equal(tx.inputsLength, 1);
  // L5: the change takes a random slot among the outputs, so compare the amounts as a set.
  const sorted = (t) => Array.from({ length: t.outputsLength }, (_, v) => Number(t.getOutput(v).amount)).sort((a, b) => a - b);
  assert.deepEqual(sorted(tx), [...Array(7).fill(13_000), 100_000 - 91_000 - 413].sort((a, b) => a - b));
  assert.equal(big.ledgerView().items[0].kind, "fanout");
  assert.equal(big.books.toJSON().margin, 488 - 413);
  big.esplora.confirm([tx.id], idx.height);
  await tick(big);
  assert.equal(big.ledgerView().items[0].outcome, "accepted");
  assert.equal(big.capacity(), 7 * 21 + 13);
  assert.equal(big.esplora.accepted.length, 1, "enough coins and capacity now: no second fan-out");

  // Enough coins by count, too little capacity for a release: the capacity trigger splits the big coin.
  const thin = await newRelayer({}, { coins: [...Array(6).fill(7000), 200_000] });
  assert.equal(thin.esplora.accepted.length, 1);
  const split = txOf(thin.esplora.accepted[0]);
  assert.deepEqual(sorted(split), [...Array(15).fill(13_000), 200_000 - 195_000 - 757].sort((a, b) => a - b));

  // Enough coins and capacity: nothing to do.
  const plenty = await newRelayer({}, { coins: Array(8).fill(50_000) });
  assert.equal(plenty.capacity(), 168);
  assert.equal(plenty.esplora.accepted.length, 0);
  for (const r of [today, worth, big, thin, plenty]) assert.equal(r.checkBooks().ok, true);
});

test("an unconfirmed fan-out's coins share its 24 descendants: capacity, the coin check and the release respect Core's limits", async () => {
  const S = nextBoundary(idx.height, "batch");
  await advanceTo(S);
  const esplora = new FakeEsplora();
  esplora.limits = true;
  const r = await newRelayer({ verifyMaxPerSec: 100 }, { coins: [100_000], esplora, margin: 312 });
  const fan = r.state.ledger.find((l) => l.kind === "fanout");
  assert.equal(fan.outcome, "pending");
  await tick(r);
  assert.equal(r.capacity(), 24, "7 x 13,000 plus change would fund 153 carriers, but only 24 fit below one unconfirmed parent");
  const ids = [];
  for (let i = 0; i < 24; i++) ids.push((await accept(r, synth(S), { mode: "batch", ip: ipNo(i) })).id);
  expectError(await submit(r, synth(S), { mode: "batch", ip: ipNo(30) }), 503, "pool_low");
  await advanceTo(S + 6, [r]); // the fan-out is still unconfirmed at the release
  assert.deepEqual(ids.map((id) => r.status(id).status), Array(24).fill("broadcast"), "the whole epoch went out, nothing refused");
  assert.ok(r.items.every((i) => (i.attempts ?? 0) === 0));
  assert.equal(r.capacity(), 0, "no room left below it");
  assert.equal(r.pickCoin(r.spendableCoins(), 1000), null, "nor a coin to chain on");
  // It confirms: the limit no longer applies; the chains continue from their depth.
  esplora.confirm([fan.txid], idx.height);
  await tick(r);
  assert.ok(r.capacity() > 24);
  assert.equal(r.checkBooks().ok, true);
});

test("a mempool chain-limit refusal holds the carrier, journaled, without using an attempt", async () => {
  const r = await newRelayer({ fanoutTarget: 0 });
  const id = (await accept(r, synth(idx.height))).id;
  const chain = () => new Error("sendrawtransaction RPC error: too-long-mempool-chain, too many descendants for tx ab [limit: 25]");
  r.esplora.failNext = chain();
  assert.equal(await r.broadcastRaw("00"), "chain");
  const item = () => r.items.find((i) => i.id === id);
  for (let k = 0; k < 4; k++) {
    r.esplora.failNext = chain();
    await mine();
    await tick(r);
    assert.deepEqual([item().status, item().attempts], ["signing", 0], `block ${k}`);
  }
  await mine();
  await tick(r);
  assert.equal(r.status(id).status, "broadcast", "sent once the mempool takes it");
  assert.equal(r.status(id).cost, QUOTE, "charged once");
});

test("fan-out of a coin worth one to two chains: 25,000 sats become 13,000 plus 11,845 (40 carriers, not 21)", async () => {
  const one = await newRelayer({}, { coins: [25_000] });
  assert.equal(one.esplora.accepted.length, 1);
  const tx = txOf(one.esplora.accepted[0]);
  assert.deepEqual(Array.from({ length: tx.outputsLength }, (_, v) => Number(tx.getOutput(v).amount)).sort((a, b) => a - b), [13_000, 25_000 - 13_000 - 155].sort((a, b) => a - b));
  await tick(one);
  assert.equal(one.capacity(), 24, "while it is unconfirmed: its descendant limit");
  one.esplora.confirm([tx.id], idx.height);
  await tick(one);
  assert.equal(one.capacity(), 21 + 19);
  // Four deposits plus a 25,000-sat one: split too.
  const topUp = await newRelayer({}, { coins: [7000, 10_000, 10_000, 10_000, 25_000] });
  assert.equal(topUp.esplora.accepted.length, 1);
  // A coin whose change would fund no carrier stays whole: 13,600 - 13,000 - 155 < 598 + 330.
  const close = await newRelayer({}, { coins: [13_600] });
  assert.equal(close.esplora.accepted.length, 0);
});

test("the 10-hour freshness gate follows BATCH10_SAFETY_BLOCKS: SAFETY_BLOCKS 50 still takes a 10-hour submit at S+59", async () => {
  const S = nextBoundary(idx.height, "batch10");
  await advanceTo(S + 59);
  const r = await newRelayer({ safetyBlocks: 50 });
  await tick(r, idx.height + 2); // the chain tip 2 blocks ahead of the indexer (MAX_INDEXER_LAG)
  const body = await accept(r, synth(S), { mode: "batch10" });
  assert.deepEqual([body.releaseAt, body.lastRelease], [S + 60, S + 88]);
  assert.equal(r.minAnchor("batch10"), idx.height + 2 - 88);
  // Next-block sends keep SAFETY_BLOCKS: the same anchor is too old for them.
  assert.equal(r.minAnchor(), idx.height + 2 - 50);
  const stale = await submit(r, synth(S));
  assert.equal(stale.body.error.code, "anchor_stale");
});

/** A copy of a relayer's directory (keys and state), reopened with other settings. */
async function reopenCopy(r, name, config) {
  const dir = join(DIR, name);
  mkdirSync(join(dir, "relay-balance"), { recursive: true });
  for (const f of ["pool.key", "change.key", "relayer.json"]) copyFileSync(join(r.dir, "relay-balance", f), join(dir, "relay-balance", f));
  const again = await makePaidRelayer({ idx, esplora: r.esplora, dir, config: { fanoutTarget: 0, ...config }, log: silent });
  relayers.push(again);
  statePaths.push(join(dir, "relay-balance", "relayer.json"));
  again.payer = r.payer;
  again.dir = dir;
  return again;
}

test("a restart with other safety settings keeps the lastRelease each 10-hour item was promised", async () => {
  const S = nextBoundary(idx.height, "batch10");
  await advanceTo(S);
  // Two 2,000-sat deposits: at 4 sat/vB they fund no carrier, so the epoch is held to its deadline.
  const r1 = await newRelayer({ fanoutTarget: 0 }, { coins: [2000, 2000, 2000] });
  const id = (await accept(r1, synth(S), { mode: "batch10" })).id;
  assert.equal(r1.status(id).lastRelease, S + 88);
  r1.close();
  const late = await reopenCopy(r1, "promise-late", { batch10SafetyBlocks: 40 }); // its own deadline would be S + 60
  const early = await reopenCopy(r1, "promise-early", { batch10SafetyBlocks: 1 }); // its own deadline would be S + 99
  await tick(late);
  await tick(early);
  // A new item in the same epoch, under the new setting, is promised the epoch's deadline.
  const id2 = (await accept(early, synth(S), { mode: "batch10", ip: OTHER_IP })).id;
  assert.equal(early.status(id2).lastRelease, S + 88);
  r1.esplora.fee = 4; // under the cap, but no coin can fund a carrier: the epoch is held until its deadline
  await advanceTo(S + 88, [late, early]);
  assert.deepEqual([late.status(id).status, early.status(id).status, early.status(id2).status], ["queued", "queued", "queued"], "S+88 is still within the promise");
  assert.equal(late.status(id).lastRelease, S + 88);
  await advanceTo(S + 89, [late, early]);
  for (const r of [late, early]) assert.deepEqual([r.status(id).status, r.status(id).reason], ["expired", `the batch could not be sent before block ${S + 88}`]);
  assert.equal(early.status(id2).status, "expired", "the epoch expires whole");
  assert.equal(r1.esplora.calls.length, 0);
});

test("an item an older relayer queued in the retired 12-hour batch keeps the releaseAt and lastRelease it was promised; it never goes with the next block", async () => {
  // As the old relayer saved one: anchored at a 72-block boundary (here not a 60-block one),
  // releaseAt S + 72, lastRelease S + 88. No submit can make one now ("batch12" is malformed).
  let S = idx.height;
  while (S % 72 !== 0 || S % 60 === 0) S++;
  await advanceTo(S);
  const reopenLegacy = async (name, coins) => {
    const r1 = await newRelayer({ fanoutTarget: 0 }, { coins });
    const envs = [synth(S), synth(S)];
    const ids = [];
    for (const env of envs) ids.push((await accept(r1, env, { ip: ipNo(ids.length) })).id);
    r1.close();
    const path = join(r1.dir, "relay-balance", "relayer.json");
    const file = JSON.parse(readFileSync(path, "utf8"));
    for (const id of ids) Object.assign(file.items[id], { mode: "batch12", releaseAt: S + 72, lastRelease: S + 88 });
    writeFileSync(path, JSON.stringify(file));
    const r = await reopenCopy(r1, `legacy-${name}`, {});
    await tick(r);
    return { r, F: r1.esplora, envs, ids };
  };
  const A = await reopenLegacy("a", Array(4).fill(50_000));
  const B = await reopenLegacy("b", [2000, 2000]);
  B.F.fee = 4; // under the cap, but B's coins fund no carrier: its epoch is held until its deadline
  const st = ({ r, ids }) => ids.map((id) => r.status(id).status);
  for (const x of [A, B]) {
    assert.deepEqual(st(x), ["queued", "queued"]);
    assert.deepEqual([x.r.info().queue.queued, x.r.queuedAll()], [0, 2], "not in the Next-block queue, but each still needs a coin");
  }
  // A Next-block item accepted now goes with the next block; the held items stay.
  const next = synth(S);
  await accept(A.r, next);
  await advanceTo(S + 1, [A.r, B.r]);
  assert.deepEqual(carried(A.F).map(payloadOf), [hex(next)]);
  await advanceTo(S + 71, [A.r, B.r]);
  assert.equal(carried(A.F).length, 1, "nothing more before S + 72");
  assert.deepEqual(st(A), ["queued", "queued"]);
  await advanceTo(S + 72, [A.r, B.r]);
  sameSet(carried(A.F).slice(1).map(payloadOf), A.envs.map(hex), "both go out together at S + 72");
  assert.deepEqual(st(A), ["broadcast", "broadcast"]);
  assert.ok(A.r.info().batch.recent.every((row) => row.mode !== "batch12"), "no retired length in info().batch.recent");
  // B: held by too few coins until S + 88 (not S + 76, the Next-block deadline), then expired whole.
  await advanceTo(S + 88, [A.r, B.r]);
  assert.deepEqual(st(B), ["queued", "queued"], "S+88 is still within the promise");
  await advanceTo(S + 89, [A.r, B.r]);
  assert.deepEqual(st(B), ["expired", "expired"]);
  assert.equal(B.r.status(B.ids[0]).reason, `the batch could not be sent before block ${S + 88}`);
  assert.equal(B.F.calls.length, 0, "never broadcast");
  assert.deepEqual([acct(B.r).reserved, B.r.pending.size], [0, 0]);
});

test("privacy: no response and no relayer.json holds a client IP; the ledger view has no epoch tag", () => {
  const ips = [TEST_IP, SAME_24, OTHER_IP, ...Array.from({ length: 43 }, (_, i) => ipNo(i))];
  const prefixes = ips.map((ip) => ip.split(".").slice(0, 3).join(".") + ".");
  assert.ok(responses.length > 50);
  for (const path of statePaths) {
    assert.ok(existsSync(path), path);
    const text = readFileSync(path, "utf8");
    for (const p of prefixes) assert.ok(!text.includes(p), `${path} mentions ${p}`);
    assert.ok(!/bucket|dayKey|"batch":\{/.test(text), "no rate-limit state is persisted");
  }
  for (const p of prefixes) assert.ok(responses.every((r) => !r.includes(p)), `a response mentions ${p}`);
  const saved = JSON.parse(readFileSync(MAIN_STATE, "utf8"));
  assert.ok(saved.ledger.some((l) => l.epoch), "batch carriers carry the internal epoch tag");
  const view = JSON.stringify(MAIN.ledgerView({ limit: 500 }));
  assert.ok(!view.includes("epoch"));
  for (const id of Object.keys(MAIN.state.items)) assert.ok(!view.includes(id), "no relay id in the ledger");
});

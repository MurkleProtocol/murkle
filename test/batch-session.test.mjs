// Batch relay timing, wallet session (docs/design/batch-contract.md §4, tests §8 "wallet"):
// the batch plan; batch sends proved against the tree at the epoch start with one roots
// request; NOT_IN_BATCH; the one automatic re-prove on epoch_closed; history fields,
// polling, phases and retry choices; timing preferences; the relay client, payer and
// ApiError fields; the audit of batch counts; the privacy nudge and the "relay" event.
// Real proofs over synthetic blocks served by an in-process indexer on port 0; the
// relayer is a fake client. Nothing is broadcast and no real wallet is touched.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const api = await import("../web/src/api.js");
const S = await import("../web/src/session.js");
// These tests drive relayed batch sends, their phases and relay polling. The relay route is open
// only while a relayer with relay balances runs (docs/design/relay-balance.md): the fake relayer
// below reports one (mode "balance" with a pool key), and this file opens the route up front.
const { RELAY_ROUTE } = await import("../web/src/relay.js");
RELAY_ROUTE.open = true;
const { RelayPayer } = await import("../web/src/payers.js");
const { submitEnvelope, relayFailure, auditRelayer } = await import("../web/src/relay.js");
const { noteTier } = await import("../web/src/privacy.js");
const { STORAGE_PREFIX } = await import("../web/src/config.js");
const B = await import("../src/relay-batch.mjs");
const { Indexer, assetIdOf } = await import("../src/indexer.mjs");
const { Wallet } = await import("../src/wallet.mjs");
const { deriveKeys, encodeAddress } = await import("../src/keys.mjs");
const { OP, decodeEnvelope, encodeDeploy, encodeTxBody, opReturnScript } = await import("../src/envelope.mjs");
const { hex, unhex } = await import("../src/bytes.mjs");
const { relayAccount, verifyRequest } = await import("../src/relay-account.mjs");
const { schnorr } = await import("@noble/curves/secp256k1");
/** The fake relayer's pool key Q (relay info balance.poolKey) and a relay account to sign with. */
const POOL = Buffer.from(schnorr.getPublicKey(randomBytes(32))).toString("hex");
const ACCOUNT = relayAccount(new Uint8Array(randomBytes(32)), "signet");
const { createApp } = await import("../server/indexer-server.mjs");

/* ---------- fetch: every URL the wallet asks for, and a hook to fake one answer ---------- */

const realFetch = globalThis.fetch;
const seen = [];
let hook = null; // (url, init) -> Response | null
globalThis.fetch = async (url, init) => {
  seen.push(String(url));
  return hook?.(String(url), init) ?? realFetch(url, init);
};
after(async () => {
  globalThis.fetch = realFetch;
  api.setIndexerBase("");
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});
const rootsCalls = () => seen.filter((u) => u.includes("/api/roots"));

/* ---------- a synthetic chain served over HTTP ---------- */

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const START = 899_990; // 900,000 opens both an hourly and a 10-hour batch
const h32 = () => randomBytes(32).toString("hex");
const silent = { warn() {}, error() {}, log() {} };
const carrierOf = (payload, first = randomBytes(36)) => ({ txid: h32(), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(payload), value: 0n }] });

/** WAL deployed at START; a 500-unit mint to `keys` in each block of `mints`; served on port 0. */
async function chain(keys, mints = []) {
  const idx = new Indexer({ vkey: VKEY, startHeight: START, genesis: null });
  const mine = (txs = []) => idx.applyBlock({ height: idx.height + 1, hash: h32(), txs: [{ txid: h32(), inputs: [], outputs: [] }, ...txs] });
  await mine([carrierOf(encodeDeploy({ ticker: "WAL", divisibility: 0, mintAmount: 500n, mintCap: 50, priceSats: 0n, treasury: new Uint8Array() }))]);
  const minter = new Wallet(keys);
  const asset = assetIdOf(START, 1);
  const app = createApp({ idx, log: silent });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  api.setIndexerBase(base);
  return {
    idx, app, asset, base,
    async to(h) {
      while (idx.height < h) {
        if (mints.includes(idx.height + 1)) {
          const bind = randomBytes(36);
          await mine([carrierOf(await minter.mint(idx, { asset, mintAmount: 500n, bindOutpoint: bind }), bind)]);
        } else await mine();
      }
      app.publish();
    },
    /** True when the envelope (hex) would be accepted in block `height`. */
    accepts: async (envHex, height) => (await idx.checkTx(decodeEnvelope(unhex(envHex)), { inputs: [], outputs: [] }, height)) === true,
    close: () => new Promise((r) => app.server.close(r)),
  };
}

/* ---------- a fake relayer behind RelayPayer ---------- */

const closed = (epochStart, mode = "batch") =>
  new api.ApiError("This batch closed while your transfer was being proved. Prove it again for the next batch.", {
    status: 422, code: "epoch_closed", mode, epochStart, releaseAt: epochStart + B.EPOCH_BLOCKS[mode],
  });

function batchInfo(enabled = { batch: true, batch10: true }) {
  return { perIp: 3, modes: { batch: { epochBlocks: 6, maxPerEpoch: 40, safety: 24, enabled: enabled.batch }, batch10: { epochBlocks: 60, maxPerEpoch: 120, safety: 12, enabled: enabled.batch10 } } };
}

/** `script`: per submit, a function that may throw or return a body; default: a 202 as the relayer gives it. */
function fakeRelay(script = [], { batch = batchInfo() } = {}) {
  const calls = { info: 0, submits: [] };
  const queued = new Map();
  return {
    calls,
    async info() {
      calls.info++;
      return {
        enabled: true, mode: "balance", code: null, reason: null, network: "signet", address: "tb1prelayer",
        balance: { poolKey: POOL, perSendSats: 657, batchHeadroom: 2, minDepositSats: 2000, depositConfirmations: 1 }, ...(batch ? { batch } : {}),
      };
    },
    async submit(body) {
      calls.submits.push(body);
      const out = await script.shift()?.(body);
      if (out) return out;
      const { anchor } = decodeEnvelope(unhex(body.envelope));
      const id = h32().slice(0, 32);
      if (!B.isBatchMode(body.mode)) return { id, status: "queued", anchor, deadline: anchor + 100, flush: body.mode === "fast" ? "fast" : "next-block" };
      const key = B.epochKey(body.mode, anchor);
      queued.set(key, (queued.get(key) ?? 0) + 1);
      return {
        id, status: "queued", anchor, deadline: anchor + 100, flush: body.mode, mode: body.mode, epochBlocks: B.epochBlocks(body.mode),
        releaseAt: B.releaseHeight(anchor, body.mode), lastRelease: B.lastReleaseHeight(anchor, body.mode), epochQueued: queued.get(key),
      };
    },
  };
}

function session(client) {
  const s = new S.Session({ phrase: S.newPhrase() });
  if (client) s.relayPayer = new RelayPayer({ client });
  return s;
}
const bobAddr = encodeAddress(new Wallet(deriveKeys(randomBytes(32))).address);
const recorder = () => {
  const steps = [];
  const onStep = (e) => steps.push(e);
  const last = (id, status = "ok") => steps.filter((e) => e.id === id && e.status === status).at(-1);
  return { steps, onStep, last };
};
const decoded = (body) => decodeEnvelope(unhex(body.envelope));
const nullifiersOf = (body) => decoded(body).nullifiers.map(String);
/** The real spends are in the envelope (a 1-note transfer pads with a random dummy nullifier). */
const carries = (body, spends) => spends.length > 0 && spends.every((n) => nullifiersOf(body).includes(n));
// The wallet's note from the mint whose two outputs hold `leaf` (L4 shuffles a note and its padding).
const leafNote = (s, leaf) => s.wallet.notes.find((n) => n.leafIndex >> 1 === leaf >> 1);

/** A structurally valid TRANSACT envelope (the proof bytes are not checked client-side). */
function transact(anchor = 100) {
  const body = encodeTxBody({
    op: OP.TRANSACT, anchor, publicAmount: 0n, nullifiers: [11n, 12n], commitments: [21n, 22n],
    ciphertexts: [new Uint8Array(95).fill(1), new Uint8Array(95).fill(2)],
  });
  const env = new Uint8Array(body.length + 128);
  env.set(body);
  return env;
}

/* ---------- 1. batchPlan ---------- */

test("1: batchPlan for both lengths: boundaries, eligible, too-new with eligibleAt, short", () => {
  const s = session();
  assert.equal(s.batchPlan("batch"), null, "no plan before the first sync");
  const asset = 7n;
  // Leaves: 0 at 899,991 (300), 1 at 900,004 (400), 2 at 900,007 (someone else's).
  s.view = { startHeight: START, height: 900_008, outputs: [{ height: 899_991 }, { height: 900_004 }, { height: 900_007 }], nullifiers: new Set() };
  s.wallet.notes = [
    { asset, amount: 300n, leafIndex: 0, nullifier: 1n, spent: false },
    { asset, amount: 400n, leafIndex: 1, nullifier: 2n, spent: false },
  ];
  assert.deepEqual(s.batchPlan("batch"), {
    mode: "batch", epochBlocks: 6, start: 900_006, releaseAt: 900_012, lastRelease: 900_082, deadline: 900_106,
    leaves: 2, eligible: true, eligibleAt: 900_012, reason: null,
  });
  assert.deepEqual(s.batchPlan("batch10"), {
    mode: "batch10", epochBlocks: 60, start: 900_000, releaseAt: 900_060, lastRelease: 900_088, deadline: 900_100,
    leaves: 1, eligible: true, eligibleAt: 900_060, reason: null,
  });
  assert.equal(s.batchPlan("batch", { asset: { id: "7" }, amount: 350n }).eligible, true, "the 400 note is in the tree at 900,006");
  const tooNew = s.batchPlan("batch10", { asset: { id: "7" }, amount: 350n });
  assert.deepEqual([tooNew.eligible, tooNew.reason, tooNew.eligibleAt, tooNew.leaves], [false, "too-new", 900_060, 1]);
  assert.deepEqual(s.batchPlan("batch10", { asset, amount: 300n }).reason, null, "an id works as well as an asset");
  assert.equal(s.batchPlan("batch", { asset, amount: 800n }).reason, "short", "balance");
  s.wallet.notes.push({ asset, amount: 50n, leafIndex: 2, nullifier: 3n, spent: false });
  assert.equal(s.batchPlan("batch", { asset, amount: 720n }).reason, "short", "the 2-note limit");
  s.wallet.locked = new Set(["2"]);
  assert.equal(s.batchPlan("batch", { asset, amount: 400n }).reason, "short", "locked notes don't count (W-1)");
  s.wallet.locked = new Set();
  // Just after genesis: no root for the 10-hour boundary yet.
  s.view = { ...s.view, startHeight: 900_005 };
  const early = s.batchPlan("batch10");
  assert.deepEqual([early.eligible, early.reason, early.eligibleAt], [false, "too-new", 900_060]);
  assert.equal(s.batchPlan("batch").eligible, true);
  // On a boundary block itself the batch starts there.
  s.view = { ...s.view, startHeight: START, height: 900_060 };
  assert.deepEqual([s.batchPlan("batch").start, s.batchPlan("batch10").start, s.batchPlan("batch10").releaseAt], [900_060, 900_060, 900_120]);
  // One block before it, the 10-hour batch from 900,000 is still open.
  s.view = { ...s.view, height: 900_059 };
  assert.deepEqual([s.batchPlan("batch").start, s.batchPlan("batch10").start, s.batchPlan("batch10").releaseAt], [900_054, 900_000, 900_060]);
  assert.throws(() => s.batchPlan("block"), TypeError);
  assert.throws(() => s.batchPlan("batch12"), TypeError, "the retired 12-hour batch is no batch mode");
});

/* ---------- 2, 5, 7. batch sends end to end ---------- */

test("2/5: batch and 10-hour sends: one roots request, proof against the root at S, entry fields, polling from releaseAt", async (t) => {
  for (const k of ["relayMode", "selfMode"]) S.storage.removeItem(`${STORAGE_PREFIX}.${k}`);
  const relay = fakeRelay();
  const s = session(relay);
  const c = await chain(s.keys, [899_991, 900_003, 900_004]);
  t.after(c.close);
  await c.to(900_008);
  await s.sync();
  const asset = s.asset("WAL");

  // 10-hour first: only the note minted at 899,991 is in the tree at 900,000.
  seen.length = 0;
  const r10 = recorder();
  const e10 = await s.send({ asset, amount: 120n, to: bobAddr, via: "relay", mode: "batch10", onStep: r10.onStep });
  assert.deepEqual(rootsCalls(), [`${c.base}/api/roots?from=899989&to=900008`], "exactly one roots request, the same range for any boundary");
  assert.equal(relay.calls.submits.length, 1);
  const [b10] = relay.calls.submits;
  assert.equal(b10.mode, "batch10");
  assert.equal(decoded(b10).anchor, 900_000);
  assert.ok(e10.spends.includes(String(leafNote(s, 0).nullifier)), "spends the note that existed at 900,000");
  assert.equal(await c.accepts(b10.envelope, 900_009), true, "valid against R[900,000] in the next block");
  assert.equal(await c.accepts(b10.envelope, 900_061), true, "and when the 10-hour batch lands");
  assert.equal(r10.last("select").detail, "1 note · tree at block 900,000");
  assert.equal(r10.last("verify").detail, "Groth16, pinned key");
  assert.equal(r10.last("submit").detail, "Scheduled for the batch after block 900,060");
  assert.equal(r10.last("queued").detail, "Scheduled for the batch after block 900,060");
  assert.ok(seen.every((u) => !u.includes(String(e10.spends[0]))), "no request names a nullifier");
  for (const [k, v] of Object.entries({
    kind: "send", via: "relay", mode: "batch10", epochBlocks: 60, releaseAt: 900_060, lastRelease: 900_088, anchor: 900_000,
    deadline: 900_100, epochQueued: 1, status: "relaying", envelope: b10.envelope, payerAddress: null, amount: "120", to: bobAddr,
  })) assert.equal(e10[k], v, k);
  assert.ok(e10.relayId);
  assert.ok(carries(b10, e10.spends));
  const locked = S.lockedNullifiers(s.history, s.view.height, s.view.nullifiers);
  assert.ok(e10.spends.every((n) => locked.has(n) && s.wallet.locked.has(n)), "W-1: the spends are reserved");

  // Hourly: S = 900,006; the first note is reserved, the later ones are in the tree at S.
  seen.length = 0;
  const r1 = recorder();
  const e1 = await s.send({ asset, amount: 120n, to: bobAddr, via: "relay", mode: "batch", onStep: r1.onStep });
  assert.deepEqual(rootsCalls(), [`${c.base}/api/roots?from=899989&to=900008`]);
  const b1 = relay.calls.submits[1];
  assert.deepEqual([b1.mode, decoded(b1).anchor], ["batch", 900_006]);
  assert.equal(await c.accepts(b1.envelope, 900_013), true, "valid against R[900,006] when the hourly batch lands");
  assert.deepEqual([e1.mode, e1.epochBlocks, e1.releaseAt, e1.lastRelease, e1.anchor, e1.deadline], ["batch", 6, 900_012, 900_082, 900_006, 900_106]);
  assert.equal(r1.last("select").detail, "1 note · tree at block 900,006");
  assert.ok(!e1.spends.some((n) => e10.spends.includes(n)));

  // A root that doesn't match the tree at S: nothing is recorded, nothing is sent.
  const before = s.history.length;
  hook = (url) => (url.includes("/api/roots") ? Response.json([[900_006, "12345"]]) : null);
  t.after(() => (hook = null));
  await assert.rejects(
    s.send({ asset, amount: 100n, to: bobAddr, via: "relay", mode: "batch" }),
    { message: "The pool at block 900,006 doesn't match the indexer's root. Sync again, or switch indexer (Settings, or /verify#indexer)." },
  );
  hook = (url) => (url.includes("/api/roots") ? Response.json([]) : null);
  await assert.rejects(s.send({ asset, amount: 100n, to: bobAddr, via: "relay", mode: "batch" }), /doesn't match the indexer's root/);
  hook = null;
  assert.equal(s.history.length, before);
  assert.equal(relay.calls.submits.length, 2);

  // A merge (a send to this wallet) without a mode goes with the hourly batch (selfModePref).
  const merge = await s.send({ asset, amount: 50n, to: s.address, via: "relay" });
  assert.deepEqual([merge.mode, relay.calls.submits[2].mode, decoded(relay.calls.submits[2]).anchor], ["batch", "batch", 900_006]);

  // Polling: bulk data only before releaseAt, then one status call per entry.
  const status = api.relay.status;
  const asked = [];
  api.relay.status = async (id) => (asked.push(id), { status: "queued", anchor: 900_006, deadline: 900_106 });
  t.after(() => (api.relay.status = status));
  await s.sync();
  assert.deepEqual(asked, [], "no relay-status call before releaseAt");
  assert.deepEqual([S.batchPhase(e1, s.view.height), S.batchPhase(e10, s.view.height)], ["scheduled", "scheduled"]);
  await c.to(900_012);
  await s.sync();
  assert.deepEqual(asked.sort(), [e1.relayId, merge.relayId].sort(), "hourly entries polled from 900,012; the 10-hour one is not");
  assert.deepEqual([e1.status, e1.relayStatus, S.batchPhase(e1, 900_012), S.batchPhase(e10, 900_012)], ["relaying", "queued", "releasing", "scheduled"]);
  assert.ok(e10.spends.every((n) => s.wallet.locked.has(n)) && e1.spends.every((n) => s.wallet.locked.has(n)));
});

/* ---------- 3. note too new ---------- */

test("2b: a reorg that mines the boundary block's outputs again a block later: the batch send rebuilds the view once", async (t) => {
  const relay = fakeRelay();
  const s = session(relay);
  const idx = new Indexer({ vkey: VKEY, startHeight: START, genesis: null });
  const mine = (txs = []) => idx.applyBlock({ height: idx.height + 1, hash: h32(), txs: [{ txid: h32(), inputs: [], outputs: [] }, ...txs] });
  await mine([carrierOf(encodeDeploy({ ticker: "WAL", divisibility: 0, mintAmount: 500n, mintCap: 50, priceSats: 0n, treasury: new Uint8Array() }))]);
  const asset = assetIdOf(START, 1);
  const minter = new Wallet(s.keys);
  const mintTx = async () => {
    const bind = randomBytes(36);
    return carrierOf(await minter.mint(idx, { asset, mintAmount: 500n, bindOutpoint: bind }), bind);
  };
  const app = createApp({ idx, log: silent });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => app.server.close(r)));
  api.setIndexerBase(`http://127.0.0.1:${app.server.address().port}`);
  while (idx.height < 899_994) await mine();
  await mine([await mintTx()]); // 899,995: in every tree
  while (idx.height < 899_999) await mine();
  const boundary = await mintTx();
  await mine([boundary]); // 900,000, the hourly boundary S
  await mine();
  app.publish();
  await s.sync();
  const root = s.view.tree.root().toString();

  // Replaced in one tick: an empty 900,000', the same mint in 900,001', then 900,002.
  idx.rollbackTo(899_999);
  await mine();
  await mine([boundary]);
  await mine();
  app.publish();
  await s.sync();
  const real = idx.outputs.map((o) => o.height);
  assert.equal(s.view.tree.root().toString(), root, "the tip root can't tell the difference");
  assert.notDeepEqual(s.view.outputs.map((o) => o.height), real, "the incremental view kept the old heights");

  seen.length = 0;
  const e = await s.send({ asset: s.asset("WAL"), amount: 100n, to: bobAddr, via: "relay", mode: "batch" });
  assert.deepEqual(s.view.outputs.map((o) => o.height), real, "rebuilt from scratch");
  assert.equal(rootsCalls().length, 2, "one roots request, and one more after the rebuild");
  const [body] = relay.calls.submits;
  assert.equal(decoded(body).anchor, 900_000);
  assert.equal(e.anchor, 900_000);
  assert.equal(await idx.checkTx(decodeEnvelope(unhex(body.envelope)), { inputs: [], outputs: [] }, 900_007), true, "valid against the indexer's R[900,000]");
});

/* ---------- 3. note too new ---------- */

test("3: a note newer than the boundary: NOT_IN_BATCH with eligibleAt and the exact text; nothing recorded or sent", async (t) => {
  const relay = fakeRelay();
  const s = session(relay);
  const c = await chain(s.keys, [899_995, 900_007]);
  t.after(c.close);
  await c.to(900_008);
  await s.sync();
  const asset = s.asset("WAL");
  assert.deepEqual(
    (({ eligible, reason, start, eligibleAt }) => ({ eligible, reason, start, eligibleAt }))(s.batchPlan("batch", { asset, amount: 600n })),
    { eligible: false, reason: "too-new", start: 900_006, eligibleAt: 900_012 },
  );
  seen.length = 0;
  const r = recorder();
  const err = await s.send({ asset, amount: 600n, to: bobAddr, via: "relay", mode: "batch", onStep: r.onStep }).catch((e) => e);
  assert.equal(err.code, S.NOT_IN_BATCH);
  assert.deepEqual([err.mode, err.start, err.eligibleAt], ["batch", 900_006, 900_012]);
  assert.equal(
    err.message,
    "The note this send needs arrived after block 900,006, so it can join the batch that starts at block 900,012 (about 40 min). Or send it with the next block now.",
  );
  assert.equal(r.last("select", "fail").detail, err.message);
  assert.equal(s.history.length, 0, "nothing recorded");
  assert.deepEqual(relay.calls.submits, [], "nothing sent");
  assert.deepEqual(rootsCalls(), [], "not even the roots request");
  // Not enough at all: the usual selection error, not NOT_IN_BATCH.
  const short = await s.send({ asset, amount: 2000n, to: bobAddr, via: "relay", mode: "batch" }).catch((e) => e);
  assert.notEqual(short.code, S.NOT_IN_BATCH);
  assert.match(short.message, /insufficient balance/);
  // The 10-hour batch from 900,000 can't take the newer note either; the next one can.
  const e10 = await s.send({ asset, amount: 600n, to: bobAddr, via: "relay", mode: "batch10" }).catch((e) => e);
  assert.deepEqual([e10.code, e10.start, e10.eligibleAt], [S.NOT_IN_BATCH, 900_000, 900_060]);
  assert.match(e10.message, /starts at block 900,060 \(about 9 h\)/);
  // Next block takes it now.
  const now = await s.send({ asset, amount: 600n, to: bobAddr, via: "relay", mode: "block" });
  assert.deepEqual([now.mode, now.anchor, now.releaseAt, relay.calls.submits.length], ["block", 900_008, undefined, 1]);
});

/* ---------- 4, 6. epoch_closed and retries ---------- */

test("4/6: epoch_closed re-proves once with the same notes; a second leaves a failed, locked entry; retry next batch / next block", async (t) => {
  const steps = [];
  const script = [];
  const relay = fakeRelay(script);
  const s = session(relay);
  const c = await chain(s.keys, [899_991, 899_992]);
  t.after(c.close);
  await c.to(900_010);
  await s.sync();
  const asset = s.asset("WAL");

  // The tip reaches 900,012 while the first proof (S = 900,006) is with the relayer.
  script.push(async () => {
    await c.to(900_012);
    throw closed(900_012);
  });
  seen.length = 0;
  const entry = await s.send({ asset, amount: 100n, to: bobAddr, via: "relay", mode: "batch", onStep: (e) => steps.push(e) });
  const [first, second] = relay.calls.submits;
  assert.equal(relay.calls.submits.length, 2);
  assert.deepEqual([decoded(first).anchor, decoded(second).anchor], [900_006, 900_012]);
  assert.ok(carries(first, entry.spends) && carries(second, entry.spends), "same notes, so the same nullifiers");
  assert.equal(entry.anchor, 900_012, "the newest anchor");
  assert.deepEqual([entry.releaseAt, entry.lastRelease, entry.status, entry.envelope], [900_018, 900_088, "relaying", second.envelope]);
  assert.equal(new Set(entry.commitments).size, 4, "both versions' commitments are tracked");
  assert.equal(rootsCalls().length, 2, "one roots request per proof");
  assert.equal(steps.filter((e) => e.id === "prove" && e.status === "ok").length, 2);
  assert.ok(steps.some((e) => e.id === "prove" && e.status === "running" && e.detail === "The batch closed while proving. Proving again for the next batch."));
  assert.equal(await c.accepts(second.envelope, 900_019), true);

  // Closed twice: the entry stays, failed, and its notes stay reserved (W-1).
  script.push(async () => {
    throw closed(900_012);
  }, async () => {
    throw closed(900_012);
  });
  const err = await s.send({ asset, amount: 100n, to: bobAddr, via: "relay", mode: "batch" }).catch((e) => e);
  assert.equal(err.code, "epoch_closed");
  const failed = err.entry;
  assert.ok(s.history.includes(failed));
  assert.equal(failed.status, "failed");
  assert.equal(failed.reason, "This batch closed while your transfer was being proved. Prove it again for the next batch.");
  assert.equal(relay.calls.submits.length, 4);
  assert.ok(carries(relay.calls.submits[2], failed.spends) && carries(relay.calls.submits[3], failed.spends));
  const locked = S.lockedNullifiers(s.history, s.view.height, s.view.nullifiers);
  assert.ok(failed.spends.every((n) => locked.has(n) && s.wallet.locked.has(n)));
  assert.deepEqual(S.retryChoices(failed, s.view.height), ["next-batch", "next-block", "self", "copy"]);

  // Retry in the next batch: proved again at the current boundary (900,018), same nullifiers.
  await c.to(900_019);
  const r = recorder();
  await s.retry(failed, { via: "relay", onStep: r.onStep });
  const again = relay.calls.submits[4];
  assert.deepEqual([again.mode, decoded(again).anchor], ["batch", 900_018]);
  assert.ok(carries(again, failed.spends));
  assert.deepEqual([failed.anchor, failed.releaseAt, failed.lastRelease, failed.mode, failed.status, failed.retries], [900_018, 900_024, 900_094, "batch", "relaying", 1]);
  assert.equal(r.last("select").detail, "same notes as before · tree at block 900,018");
  assert.equal(await c.accepts(again.envelope, 900_025), true);

  // Refused again inside the same batch (say batch_full): the envelope for this boundary is reused.
  s.update(failed, { status: "failed" });
  const r2 = recorder();
  await s.retry(failed, { via: "relay", onStep: r2.onStep });
  assert.equal(relay.calls.submits[5].envelope, again.envelope);
  assert.equal(r2.last("prove", "skip").detail, "reusing the envelope already handed out");

  // Send at the next block: the same envelope while its age is at most 70 blocks.
  s.update(failed, { status: "failed" });
  await s.retry(failed, { via: "relay", mode: "block" });
  const nb = relay.calls.submits[6];
  assert.deepEqual([nb.mode, nb.envelope], ["block", again.envelope]);
  assert.deepEqual([failed.mode, failed.epochBlocks, failed.releaseAt, failed.lastRelease, failed.epochQueued], ["block", null, null, null, null]);
  assert.equal(S.batchPhase(failed, s.view.height), null, "a Next-block entry has no batch phase");

  // Past 70 blocks the next-block retry proves again at the tip, with the same notes.
  await c.to(900_089);
  s.update(failed, { status: "failed" });
  await s.retry(failed, { via: "relay", mode: "block" });
  const late = relay.calls.submits[7];
  assert.deepEqual([late.mode, decoded(late).anchor], ["block", 900_089]);
  assert.ok(carries(late, failed.spends));

  // An entry an older wallet saved as "batch12" (the retired 12-hour batch): no batch phase,
  // today's three buttons, and a relay retry goes with the 10-hour batch, same notes.
  s.update(failed, { status: "failed", mode: "batch12" });
  assert.equal(S.batchPhase(failed, s.view.height), null);
  assert.deepEqual(S.retryChoices(failed, s.view.height), ["relay", "self", "copy"]);
  await s.retry(failed, { via: "relay" });
  const legacy = relay.calls.submits[8];
  assert.deepEqual([legacy.mode, decoded(legacy).anchor], ["batch10", 900_060]);
  assert.ok(carries(legacy, failed.spends));
  assert.deepEqual([failed.mode, failed.epochBlocks, failed.releaseAt, failed.lastRelease, failed.status], ["batch10", 60, 900_120, 900_148, "relaying"]);
});

/* ---------- 6. phases and retry choices (pure) ---------- */

test("6: batchPhase and retryChoices across heights and statuses", () => {
  const hourly = { kind: "send", via: "relay", mode: "batch", anchor: 100, releaseAt: 106, lastRelease: 176, status: "relaying" };
  const phase = (e, hs) => hs.map((h) => S.batchPhase(e, h));
  assert.deepEqual(phase(hourly, [100, 105, 106, 108, 109, 176, 177]), ["scheduled", "scheduled", "releasing", "releasing", "overdue", "overdue", "missed"]);
  assert.deepEqual(phase({ ...hourly, relayStatus: "broadcast" }, [109, 200]), ["releasing", "releasing"]);
  assert.deepEqual(phase({ ...hourly, relayStatus: "accepted" }, [150]), ["releasing"]);
  const ten = { kind: "send", via: "relay", mode: "batch10", anchor: 120, releaseAt: 180, lastRelease: 208, status: "relaying" };
  assert.deepEqual(phase(ten, [179, 180, 182, 183, 208, 209]), ["scheduled", "releasing", "releasing", "overdue", "overdue", "missed"]);
  const { releaseAt, lastRelease, ...bare } = ten;
  assert.deepEqual(phase(bare, [179, 180, 183, 208, 209]), ["scheduled", "releasing", "overdue", "overdue", "missed"], "derived from the anchor when missing");
  assert.equal(S.batchPhase({ ...hourly, status: "accepted" }, 300), "landed");
  for (const st of ["failed", "rejected", "expired", "dropped"]) assert.equal(S.batchPhase({ ...hourly, status: st }, 120), "failed", st);
  assert.equal(S.batchPhase({ ...hourly, status: "mempool" }, 120), null);
  assert.equal(S.batchPhase({ ...hourly, mode: "block" }, 120), null);
  assert.equal(S.batchPhase({ ...hourly, kind: "mint" }, 120), null);
  assert.equal(S.batchPhase(null, 1), null);

  const choices = (e, h) => S.retryChoices(e, h);
  assert.deepEqual(choices({ ...hourly, mode: "block", status: "failed" }, 120), ["relay", "self", "copy"], "today's three for Next block");
  assert.deepEqual(choices({ ...hourly, mode: undefined, status: "failed" }, 120), ["relay", "self", "copy"], "older entries without a mode");
  assert.deepEqual(choices({ ...hourly, mode: "fast", status: "relaying" }, 120), []);
  assert.deepEqual(choices({ ...hourly, status: "failed" }, 120), ["next-batch", "next-block", "self", "copy"]);
  assert.deepEqual(choices(hourly, 177), ["next-batch", "next-block", "self", "copy"], "missed");
  assert.deepEqual(choices(hourly, 150), ["self", "copy"], "overdue: the relayer still holds it");
  for (const h of [100, 107]) assert.deepEqual(choices(hourly, h), [], "scheduled / releasing");
  for (const st of ["accepted", "rejected", "expired"]) assert.deepEqual(choices({ ...hourly, status: st }, 120), [], st);
  assert.deepEqual(choices({ kind: "mint", status: "failed" }, 1), []);
});

/* ---------- 7. preferences ---------- */

test("7: defaultMode, relayModePref and selfModePref; a batch pick for a payment is not stored", async () => {
  const RELAY = `${STORAGE_PREFIX}.relayMode`;
  const SELF = `${STORAGE_PREFIX}.selfMode`;
  S.storage.removeItem(RELAY);
  S.storage.removeItem(SELF);
  const s = session();
  assert.deepEqual([s.relayModePref, s.selfModePref], ["block", "batch"]);
  assert.deepEqual([s.defaultMode(s.address), s.defaultMode(`  ${s.address}\n`), s.defaultMode(bobAddr), s.defaultMode(undefined)], ["batch", "batch", "block", "block"]);
  s.relayModePref = "fast";
  assert.deepEqual([s.relayModePref, S.storage.getItem(RELAY), s.defaultMode(bobAddr)], ["fast", "fast", "fast"]);
  for (const v of ["batch", "batch10", "batch12", "nonsense"]) {
    s.relayModePref = v;
    assert.equal(S.storage.getItem(RELAY), "fast", `${v} is not stored for payments`);
  }
  s.relayModePref = "block";
  assert.equal(s.relayModePref, "block");
  for (const v of ["batch10", "block", "fast", "batch"]) {
    s.selfModePref = v;
    assert.deepEqual([s.selfModePref, s.defaultMode(s.address)], [v, v]);
  }
  s.selfModePref = "hourly";
  assert.equal(S.storage.getItem(SELF), "batch", "unknown values are ignored");
  S.storage.setItem(RELAY, "batch");
  S.storage.setItem(SELF, "weird");
  assert.deepEqual([s.relayModePref, s.selfModePref], ["block", "batch"], "bad stored values fall back to the defaults");
  // "batch12" saved by an older wallet (the retired 12-hour batch): the 10-hour batch for
  // merges and refreshes, the default for payments; no error either way.
  S.storage.setItem(SELF, "batch12");
  S.storage.setItem(RELAY, "batch12");
  assert.deepEqual([s.selfModePref, s.defaultMode(s.address), s.relayModePref, s.defaultMode(bobAddr)], ["batch10", "batch10", "block", "block"]);
  s.selfModePref = "batch";
  s.selfModePref = "batch12";
  assert.equal(S.storage.getItem(SELF), "batch", "the old id is never written");
  S.storage.setItem(SELF, "batch10");
  S.forgetWallet();
  assert.deepEqual([S.storage.getItem(RELAY), S.storage.getItem(SELF)], [null, null], "removed with the wallet");
  await assert.rejects(s.send({ asset: { id: "7" }, amount: 1n, to: bobAddr, via: "relay", mode: "slow" }), /Unknown relay timing: slow\./);
  await assert.rejects(s.retry({ kind: "send", via: "relay", spends: ["1"] }, { mode: "later" }), /Unknown relay timing: later\./);
  assert.equal(s.busy, 0, "refused before any work");
});

/* ---------- 8. relay client, payer and ApiError ---------- */

test("8: relayFailure codes, submitEnvelope mode and detail, RelayPayer.carry fields, ApiError extras", async (t) => {
  for (const code of ["batch_full", "batch_disabled", "epoch_closed"]) assert.equal(relayFailure({ code }).retryable, true, code);
  assert.equal(relayFailure({ code: "anchor_not_boundary" }).retryable, false);
  assert.deepEqual(
    ["anchor_not_boundary", "epoch_closed", "batch_full", "batch_disabled"].map((code) => relayFailure({ code }).message),
    [
      "A batch transfer must be anchored to the block that opened its batch. Update the wallet and prove again.",
      "This batch closed while your transfer was being proved. Prove it again for the next batch.",
      "This batch is full. Send with the next block, or try the next batch.",
      "The relayer is not taking this batch length right now. Send with the next block instead.",
    ],
  );
  assert.equal(relayFailure({ code: "rate_limited", message: "Your network has sent the most transfers allowed in this batch." }).message, "Your network has sent the most transfers allowed in this batch.", "the server's text wins");

  // Mode passes through; the submit step says when it goes out.
  const env = transact(900_006);
  const client = fakeRelay();
  const steps = [];
  const res = await submitEnvelope(env, { mode: "batch", client, account: ACCOUNT, onStep: (e) => steps.push(e) });
  const [body] = client.calls.submits;
  assert.equal(body.mode, "batch");
  assert.deepEqual(Object.keys(body).sort(), ["accountPub", "envelope", "mode", "sig", "t"], "a signed body, no proof of work");
  assert.equal(verifyRequest({ endpoint: "/api/relay/submit", network: "signet", poolKey: POOL, body }).ok, true);
  assert.equal(steps.find((e) => e.id === "submit" && e.status === "ok").detail, "Scheduled for the batch after block 900,012");
  assert.equal(res.releaseAt, 900_012);
  await submitEnvelope(env, { mode: "batch10", client, account: ACCOUNT, onStep: (e) => steps.push(e) });
  assert.equal(client.calls.submits[1].mode, "batch10");
  assert.equal(steps.filter((e) => e.id === "submit" && e.status === "ok").at(-1).detail, "Scheduled for the batch after block 900,066");
  await submitEnvelope(env, { mode: "block", client, account: ACCOUNT, onStep: (e) => steps.push(e) });
  assert.equal(steps.filter((e) => e.id === "submit" && e.status === "ok").at(-1).detail, "Queued for the next block");

  // A length the relayer isn't taking is refused before the envelope leaves.
  for (const info of [{ batch: batchInfo({ batch: true, batch10: false }) }, { batch: null }]) {
    const off = fakeRelay([], info);
    await assert.rejects(submitEnvelope(env, { mode: "batch10", client: off, account: ACCOUNT }), { code: "batch_disabled", message: /not taking this batch length/ });
    assert.equal(off.calls.submits.length, 0);
  }

  // RelayPayer.carry: every 202 field, absent ones undefined.
  const carried = await new RelayPayer({ client: fakeRelay(), account: ACCOUNT }).carry({ envelope: env, mode: "batch" });
  assert.match(carried.relayId, /^[0-9a-f]{32}$/);
  assert.deepEqual({ ...carried, relayId: "x" }, {
    relayId: "x", status: "queued", anchor: 900_006, deadline: 900_106, flush: "batch", mode: "batch",
    releaseAt: 900_012, lastRelease: 900_082, epochBlocks: 6, epochQueued: 1, reservedSats: null, balance: null, txid: null, fee: null,
  });
  const plain = await new RelayPayer({ client: fakeRelay() }).carry({ envelope: env, account: ACCOUNT });
  assert.deepEqual([plain.flush, plain.mode, plain.releaseAt, plain.lastRelease, plain.epochBlocks, plain.epochQueued], ["next-block", undefined, undefined, undefined, undefined, undefined]);

  // ApiError keeps every field of the server's error object except message.
  api.setIndexerBase("http://127.0.0.1:9");
  t.after(() => (hook = null));
  hook = (url) =>
    url.endsWith("/api/relay/submit")
      ? Response.json({ error: { code: "epoch_closed", message: "This batch closed while your transfer was being proved. Prove it again for the next batch.", mode: "batch", epochStart: 900_012, releaseAt: 900_018 } }, { status: 422 })
      : null;
  const e = await api.relay.submit({ envelope: hex(env) }).catch((x) => x);
  assert.ok(e instanceof api.ApiError);
  assert.deepEqual([e.name, e.status, e.code, e.mode, e.epochStart, e.releaseAt], ["ApiError", 422, "epoch_closed", "batch", 900_012, 900_018]);
  assert.match(e.message, /^This batch closed/);
  hook = () => Response.json({ error: { code: "anchor_not_boundary", message: "m", epochBlocks: 6, status: 1, name: "x", path: "/evil" } }, { status: 422 });
  const e2 = await api.relay.submit({}).catch((x) => x);
  assert.deepEqual([e2.epochBlocks, e2.status, e2.name, e2.path, e2.message], [6, 422, "ApiError", "/api/relay/submit", "m"], "the server can't overwrite the error's own fields");
  hook = () => Response.json({ error: { code: "rate_limited", message: "slow down", retryAfter: 3600 } }, { status: 429 });
  const e3 = await api.relay.submit({}).catch((x) => x);
  assert.deepEqual([e3.code, e3.retryAfter, e3.bits], ["rate_limited", 3600, null]);
});

/* ---------- 9. audit of batch counts ---------- */

test("9: auditRelayer batches: matching counts, a mismatch with its note, hourly and 10-hour told apart, older epochs skipped", () => {
  const R = "tb1prelayer";
  let n = 0;
  const carrier = (anchor, height) => ({
    txid: `c${++n}`, fee: 597, status: { confirmed: true, block_height: height },
    vin: [{ prevout: { scriptpubkey_address: R } }],
    vout: [{ scriptpubkey_type: "op_return", scriptpubkey: hex(opReturnScript(transact(anchor))), value: 0 }, { scriptpubkey_address: R, value: 1000 }],
  });
  const fanout = { txid: "f1", fee: 900, status: { confirmed: true, block_height: 900_005 }, vin: [{ prevout: { scriptpubkey_address: R } }], vout: [{ scriptpubkey_address: R }, { scriptpubkey_address: R }] };
  const pending = { ...carrier(900_066, 0), status: { confirmed: false } };
  const txs = [
    ...[1, 2].map(() => carrier(900_000, 900_061)), // 10-hour, anchor 900,000
    ...[1, 2].map(() => carrier(900_006, 900_013)), // hourly, anchor 900,006
    ...[1, 2, 3].map(() => carrier(900_000, 900_007)), // hourly, anchor 900,000 (also a 10-hour boundary)
    carrier(900_008, 900_009), // a Next-block send: no batch
    pending,
    fanout,
  ];
  const ledger = txs.map((x) => ({ txid: x.txid, fee: x.fee }));
  const recent = [
    { mode: "batch", start: 900_066, releaseAt: 900_072, released: 1, landed: [] }, // released, not landed yet
    { mode: "batch10", start: 900_000, releaseAt: 900_060, released: 2, landed: [[900_061, 2]] },
    { mode: "batch", start: 900_006, releaseAt: 900_012, released: 2, landed: [[900_013, 2]] },
    { mode: "batch", start: 900_000, releaseAt: 900_006, released: 3, landed: [[900_007, 3]] },
    { mode: "batch", start: 899_994, releaseAt: 900_000, released: 1, landed: [[900_001, 1]] }, // before the oldest fetched tx (900,005)
  ];
  const ok = auditRelayer({ address: R, txs, ledger, batch: { perIp: 3, modes: {}, recent } });
  assert.equal(ok.matched, ok.total, "the per-transaction audit is unchanged");
  assert.deepEqual(ok.batches, {
    rows: [
      { mode: "batch10", start: 900_000, reported: 2, onChain: 2, ok: true, note: null },
      { mode: "batch", start: 900_006, reported: 2, onChain: 2, ok: true, note: null },
      { mode: "batch", start: 900_000, reported: 3, onChain: 3, ok: true, note: null },
    ],
    matched: 3, total: 3, skipped: 2,
  });
  assert.deepEqual(auditRelayer({ address: R, txs, ledger, batch: recent }).batches, ok.batches, "the recent list itself works too");
  assert.deepEqual(auditRelayer({ address: R, txs, ledger }).batches, { rows: [], matched: 0, total: 0, skipped: 0 });

  // The relayer over-reports one epoch, and reports another as landing in two blocks.
  const lying = [
    { mode: "batch", start: 900_006, releaseAt: 900_012, released: 3, landed: [[900_013, 3]] },
    { mode: "batch", start: 900_000, releaseAt: 900_006, released: 3, landed: [[900_007, 2], [900_008, 1]] },
    { mode: "batch10", start: 900_000, releaseAt: 900_060, released: 1, landed: [[900_061, 1]] },
  ];
  const bad = auditRelayer({ address: R, txs, ledger, batch: lying }).batches;
  assert.deepEqual([bad.matched, bad.total, bad.skipped], [0, 3, 0]);
  assert.deepEqual(bad.rows.map((r) => r.note), [
    "Bitcoin shows 2 carriers for this batch; the relayer reports 3.",
    "Bitcoin shows 3 carriers for this batch; the relayer reports 3.",
    "Bitcoin shows 2 carriers for this batch; the relayer reports 1.",
  ]);
  // Carriers the relayer doesn't report at all.
  const silentEpoch = auditRelayer({ address: R, txs, ledger, batch: [{ mode: "batch", start: 900_006, releaseAt: 900_012, released: 2, landed: [] }] }).batches;
  assert.deepEqual([silentEpoch.total, silentEpoch.rows[0].ok, silentEpoch.rows[0].onChain], [1, false, 2]);

  // The oldest fetched block may be cut mid-page: a shortfall there is skipped, not flagged.
  const cut = auditRelayer({ address: R, txs: txs.filter((x) => x !== fanout).slice(0, 6), ledger, batch: [{ mode: "batch", start: 900_000, released: 3, landed: [[900_007, 3]] }] }).batches;
  assert.deepEqual([cut.total, cut.skipped], [0, 1]);
  // Nothing fetched: nothing can be checked.
  assert.deepEqual(auditRelayer({ address: R, txs: [], ledger, batch: recent }).batches, { rows: [], matched: 0, total: 0, skipped: 5 });
  // An hourly epoch held past S+60 still counts when S opens no 10-hour batch.
  const held = auditRelayer({ address: R, txs: [...txs, carrier(900_006, 900_067)], ledger, batch: [{ mode: "batch", start: 900_006, released: 3, landed: [[900_013, 2], [900_067, 1]] }] }).batches;
  assert.deepEqual([held.matched, held.total], [1, 1]);
  // One that opens a 10-hour batch counts only up to S+60: a landing at S+61 belongs to the 10-hour batch.
  const at60 = auditRelayer({ address: R, txs: [...txs, carrier(900_000, 900_060)], ledger, batch: [{ mode: "batch", start: 900_000, released: 4, landed: [[900_007, 3], [900_060, 1]] }] }).batches;
  assert.deepEqual([at60.matched, at60.total], [1, 1]);
  // A relayer report that still names the retired 12-hour batch is not checked.
  assert.deepEqual(auditRelayer({ address: R, txs, ledger, batch: [{ mode: "batch12", start: 900_000, released: 2, landed: [[900_073, 2]] }] }).batches, { rows: [], matched: 0, total: 0, skipped: 0 });
});

/* ---------- 10. privacy nudge, "relay" event ---------- */

test("10: the hourly batch nudge for relayed sends that aren't batched; tiers unchanged; loadRelayInfo emits relay", async (t) => {
  const NUDGE = " Or send it with the hourly batch: it lands together with the other hourly-batch transfers from that hour.";
  const weak = { notesAfter: 10, transfersSince: 3, blocks: 5, mint: false, leaves: 60 };
  const strong = { notesAfter: 500, transfersSince: 50, blocks: 500, mint: false, leaves: 600 };
  for (const mode of [undefined, "block", "fast"]) assert.ok(noteTier(weak, { route: "relay", mode }).advice.endsWith(NUDGE), String(mode));
  for (const mode of ["batch", "batch10"]) {
    const a = noteTier(weak, { route: "relay", mode }).advice;
    assert.ok(a && !a.includes("hourly batch"), mode);
  }
  for (const route of ["self", "self-linked", "unisat"]) assert.ok(!(noteTier(weak, { route, mode: "block" }).advice ?? "").includes("hourly batch"), route);
  for (const ctx of [weak, strong, { ...weak, mint: true, blocks: 1 }]) {
    const tiers = [undefined, "block", "fast", "batch", "batch10"].map((mode) => noteTier(ctx, { route: "relay", mode }).tier);
    assert.equal(new Set(tiers).size, 1, "the mode never changes the tier");
  }
  assert.equal(noteTier(strong, { route: "relay", mode: "block" }).advice, null);

  const s = session();
  const events = [];
  const off = S.onSessionChange((type) => events.push(type));
  t.after(() => {
    off();
    hook = null;
  });
  api.setIndexerBase("http://127.0.0.1:9");
  hook = (url) => (url.endsWith("/api/relay/info") ? Response.json({ enabled: true, batch: batchInfo() }) : null);
  await s.loadRelayInfo();
  assert.deepEqual([events, s.relayInfo.batch.modes.batch.maxPerEpoch], [["relay"], 40]);
  hook = () => Response.json({ error: { code: "x", message: "down" } }, { status: 500 });
  await s.loadRelayInfo();
  assert.deepEqual([events, s.relayInfo.enabled, s.relayInfo.reason], [["relay", "relay"], false, "network"], "emitted on failure too");
});

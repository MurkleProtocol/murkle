// Mining, web track (docs/design/mining-contract.md §10, tests §13 "web"): the worker protocol
// (start, progress, found, stop; the slow-mode and refusal messages), workers restarting on a
// new tip and after each solution, the reference re-check disabling a fast path that disagrees,
// W-M persisted in the wallet history, the mining key apart from the transfer key, the copy per
// route, /app/mine routed, the launch form's defaults and suggested difficulty, the mined token
// page, the explorer's claim rows and auditRelayer on a MINE carrier.
//
// Runs on a fake DOM, fake storage and a fake indexer, relayer and mempool.space. Nothing is
// broadcast, no browser wallet is opened, no recovery phrase or password is written to a file.
// One claim per route is proved for real (build/dev artifacts) and its Argon2 is real (noble).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

// Public pages import their CSS; under node it is an empty module.
register(
  "data:text/javascript," +
    encodeURIComponent(`export async function load(url, ctx, next) { if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true }; return next(url, ctx); }`),
);

/* ---------- a minimal DOM ---------- */

class FakeEl {
  constructor(markup = "") {
    this.markup = String(markup);
    this.sel = new Map();
    this.ls = {};
    this.attrs = {};
    this.dataset = {};
    this.html = "";
    this.hidden = false;
    this.value = "";
    this.placeholder = "";
    this.textContent = "";
    const set = new Set();
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)) };
  }
  get innerHTML() {
    return this.html;
  }
  set innerHTML(v) {
    this.html = String(v);
  }
  querySelector(s) {
    if (!this.sel.has(s)) this.sel.set(s, new FakeEl());
    return this.sel.get(s);
  }
  querySelectorAll() {
    return [];
  }
  addEventListener(t, fn) {
    (this.ls[t] ??= []).push(fn);
  }
  removeEventListener(t, fn) {
    this.ls[t] = (this.ls[t] ?? []).filter((f) => f !== fn);
  }
  contains() {
    return true;
  }
  append() {}
  replaceChildren() {}
  remove() {}
  focus() {}
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
}
globalThis.Node = FakeEl;
globalThis.Element = FakeEl;
globalThis.document = {
  createElement() {
    const t = { content: null };
    Object.defineProperty(t, "innerHTML", { set(v) { const el = new FakeEl(v); t.content = { childNodes: [el], firstChild: el }; } });
    return t;
  },
  body: new FakeEl(),
  documentElement: new FakeEl(),
  activeElement: null,
  hidden: true,
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
  hasFocus: () => true,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.scrollTo = () => {};
globalThis.scrollY = 0;
globalThis.matchMedia = (q) => ({ matches: q.includes("reduced-motion"), addEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
const url = new URL("https://murkle.example/app/mine");
globalThis.location = {
  get href() { return url.href; },
  get origin() { return url.origin; },
  get pathname() { return url.pathname; },
  get search() { return url.search; },
  get hash() { return url.hash; },
};
globalThis.history = { state: null, pushState() {}, replaceState() {} };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} }, hardwareConcurrency: 8 } });

/* ---------- a fake indexer, relayer and mempool.space ---------- */

const reply = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": typeof body === "string" ? "text/plain" : "application/json" } });
const net = { calls: [], routes: new Map(), broadcasts: [], submits: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input), "http://indexer.test");
  const method = init.method ?? "GET";
  net.calls.push(`${method} ${u.pathname}`);
  for (const [re, fn] of net.routes) {
    const m = u.pathname.match(re);
    if (m) return fn({ u, m, method, init });
  }
  return reply(404, { error: { code: "not_found", message: "Not found." } });
};
after(() => (globalThis.fetch = realFetch));

const S = await import("../web/src/session.js");
const R = await import("../web/src/relay.js");
const api = await import("../web/src/api.js");
const keystore = await import("../web/src/keystore.js");
const { STORAGE_PREFIX } = await import("../web/src/config.js");
const { esc } = await import("../web/src/ui/dom.js");
const { closeAllSheets } = await import("../web/src/ui/sheet.js");
const SHARED = await import("../web/src/views/app-shared.js");
const MINEVIEW = await import("../web/src/views/app-mine.js");
const LAUNCH = await import("../web/src/views/app-launch.js");
const WORKER = await import("../web/src/mine-worker.js");
const { matchPath } = await import("../web/src/router.js");
const mine = await import("../src/mine.mjs");
const { MINE_FEE, MINE_WINDOW, MIN_DIFFICULTY } = await import("../src/params.mjs");
const { feeKeysOf } = await import("../src/keys.mjs");
const { OP, decodeEnvelope, encodeTxBody, opReturnScript, opReturnPayload, NONCE_LEN } = await import("../src/envelope.mjs");
const { hex, unhex, outpointOf } = await import("../src/bytes.mjs");
const { MerkleTree } = await import("../src/core.mjs");
const funding = await import("../src/btc/funding.mjs");
const btc = await import("@scure/btc-signer");
const { sha256 } = await import("@noble/hashes/sha256");
const { hkdf } = await import("@noble/hashes/hkdf");
const { mnemonicToEntropy } = await import("@scure/bip39");
const { wordlist } = await import("@scure/bip39/wordlists/english");

after(async () => {
  closeAllSheets();
  // snarkjs keeps its curve's worker threads alive until told otherwise.
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};
const has = (markup, text) => String(markup).includes(esc(text));

/* ---------- a mined asset as GET /api/mine/:asset reports it ---------- */

const ASSET = 1_395_864_371_200_007n; // 325,000 << 32 | 7
const PLATFORM = MINE_FEE.platformScript;
function minedView(over = {}) {
  const tipHeight = over.tipHeight ?? 330_000;
  return {
    asset: ASSET.toString(), kind: "pow", ticker: "ORE", divisibility: 0, status: "mining", deployTxid: "ab".repeat(32), deployHeight: 325_000, bodyHash: "cd".repeat(32),
    mineStart: 325_144, startHeight: 0, endHeight: 0, span: 24, targetPerSpan: 24, reward: "50", baseReward: "50", halvingInterval: 0, nextHalving: null,
    difficulty: "1", staleFloor: "0", target: "f".repeat(64), initialDifficulty: "1200000", minDifficulty: "75000", issued: "1000", maxSupply: "1050000",
    claims: 20, rejectedClaims: 2, feeSats: "10000", burnedFeeSats: "1000", claimFeeSats: "0", treasury: null, treasuryAddress: null,
    feeOutputs: [{ script: PLATFORM, address: MINE_FEE.platformAddress, sats: "500", role: "platform" }], firstClaimHeight: 325_150, claims144: 20,
    flags: { lowFloor: false, recipientDiscount: true },
    tip: { height: tipHeight, hash: over.tipHash ?? "00".repeat(30) + "0abc" }, window: 12, staleFactor: 4, pendingClaims: 0, hashrateEstimate: 2000,
    series: { difficulty: [[tipHeight - 2, "1200000"], [tipHeight - 1, "1150000"]], claims: [[tipHeight - 1, 2]] },
    ...over,
  };
}

/* ======================================================================================= */
/* 1. the worker protocol                                                                  */
/* ======================================================================================= */

/** A stand-in for src/mine.mjs: selfTest result, and a grind that finds at the `findAt`-th hash. */
function stubMine({ self = { ok: true, impl: "hash-wasm" }, findAt = Infinity, throwAt = Infinity } = {}) {
  let tried = 0;
  const calls = { disabled: [], grinds: [] };
  return {
    calls,
    selfTest: async () => self,
    counterOf: mine.counterOf,
    async grindRange({ challenge, target, nonceStart, count }) {
      calls.grinds.push({ challenge: hex(unhex(typeof challenge === "string" ? challenge : hex(challenge))), target, nonceStart, count });
      if (tried + count >= throwAt) throw Object.assign(new Error("Argon2 failed: out of memory"), { code: "POW_FAILED" });
      if (tried + count >= findAt) {
        const i = findAt - tried - 1;
        tried = findAt;
        return { nonce: mine.nonceOf(BigInt(nonceStart) + BigInt(i)), powHash: new Uint8Array(32).fill(7), tried: i + 1 };
      }
      tried += count;
      return { nonce: null, powHash: null, tried: count };
    },
    powHashReference: (pw) => sha256(pw),
    disableFastPath: (r) => calls.disabled.push(r),
  };
}

test("worker: ready after the self-test, progress while grinding, found once, then idle; stop ends a search", async () => {
  const out = [];
  let clock = 0;
  const m = stubMine({ findAt: 40 });
  const w = WORKER.createMiner({ mine: m, post: (x) => out.push(x), now: () => (clock += 300), yieldNow: tick, slice: 4 });
  await w.ready;
  assert.deepEqual(out[0], { type: "ready", ok: true, impl: "hash-wasm" });
  const challenge = "11".repeat(32);
  await w.onMessage({ type: "start", id: 3, challenge, target: "00".repeat(31) + "ff", nonceStart: "0100000000000000", step: 1, progressMs: 1000 });
  const found = out.filter((x) => x.type === "found");
  assert.equal(found.length, 1, "one solution, then the worker idles");
  assert.equal(found[0].id, 3, "found echoes the search id");
  assert.match(found[0].nonce, /^[0-9a-f]{16}$/);
  assert.equal(found[0].powHash, "07".repeat(32));
  assert.equal(found[0].hashes, 40);
  assert.equal(mine.counterOf(unhex(found[0].nonce)), 1n + 39n, "nonces step by 1 from nonceStart (u64 LE counter)");
  const progress = out.filter((x) => x.type === "progress");
  assert.ok(progress.length >= 1 && progress.every((p) => p.hashes > 0 && p.ms > 0 && p.id === 3));
  assert.equal(progress.reduce((s, p) => s + p.hashes, 0), 40, "every hash is counted once");
  assert.equal(m.calls.grinds[0].challenge, challenge);
  assert.equal(w.state().running, false);

  // A search that never finds: stop ends it; nothing more is posted after the stop.
  const out2 = [];
  const w2 = WORKER.createMiner({ mine: stubMine(), post: (x) => out2.push(x), now: () => (clock += 600), yieldNow: tick });
  await w2.ready;
  const run = w2.onMessage({ type: "start", challenge, target: "00".repeat(32), step: 1, progressMs: 1000 });
  await settle(6);
  assert.equal(w2.state().running, true);
  w2.onMessage({ type: "stop" });
  await run;
  const n = out2.length;
  await settle(6);
  assert.equal(out2.length, n, "silent after stop");
  assert.ok(out2.some((x) => x.type === "progress"));
  assert.ok(!out2.some((x) => x.type === "found"));

  // A new start replaces a running search (a new tip).
  const out3 = [];
  const m3 = stubMine({ findAt: 1_000_000 });
  const w3 = WORKER.createMiner({ mine: m3, post: (x) => out3.push(x), now: () => (clock += 10), yieldNow: tick });
  await w3.ready;
  const a = w3.onMessage({ type: "start", id: 1, challenge, target: "00".repeat(32), nonceStart: "0000000000000000" });
  await settle(3);
  const b = w3.onMessage({ type: "start", id: 2, challenge: "22".repeat(32), target: "00".repeat(32), nonceStart: "0000000000000000" });
  await settle(3);
  w3.onMessage({ type: "stop" });
  await Promise.all([a, b]);
  assert.ok(m3.calls.grinds.some((g) => g.challenge === "22".repeat(32)), "the second challenge is searched");
  const last = m3.calls.grinds.at(-1);
  assert.equal(last.challenge, "22".repeat(32), "the first search ended");
});

test("worker: slow mode and refusal (the §12 strings); an Argon2 error is an error, never 'no solution'; bad input refused", async () => {
  assert.equal(WORKER.WORKER_TEXT.slow, "Slow mode: this browser's fast hash failed its test.");
  assert.equal(WORKER.WORKER_TEXT.off, "This browser computed a test hash wrong; mining is off.");
  assert.equal(SHARED.MINE_TEXT.slow, WORKER.WORKER_TEXT.slow);
  assert.equal(SHARED.MINE_TEXT.off, WORKER.WORKER_TEXT.off);

  const slow = [];
  const ws = WORKER.createMiner({ mine: stubMine({ self: { ok: true, impl: "noble" } }), post: (x) => slow.push(x) });
  assert.deepEqual(await ws.ready, { ok: true, impl: "noble" });
  assert.deepEqual(slow[0], { type: "ready", ok: true, impl: "noble" });
  assert.equal(MINEVIEW.fastPathNote(slow[0]), "Slow mode: this browser's fast hash failed its test.");

  const off = [];
  const wo = WORKER.createMiner({ mine: stubMine({ self: { ok: false, impl: null } }), post: (x) => off.push(x) });
  await wo.ready;
  assert.deepEqual(off[0], { type: "ready", ok: false, impl: null });
  await wo.onMessage({ type: "start", challenge: "11".repeat(32), target: "ff".repeat(32), nonceStart: "0000000000000000" });
  assert.deepEqual(off[1], { type: "error", message: "This browser computed a test hash wrong; mining is off." }, "a failed reference never mines");
  assert.equal(MINEVIEW.fastPathNote(off[0]), "This browser computed a test hash wrong; mining is off.");
  assert.equal(MINEVIEW.fastPathNote({ ok: true, impl: "hash-wasm" }), null);

  const err = [];
  const we = WORKER.createMiner({ mine: stubMine({ throwAt: 8 }), post: (x) => err.push(x), yieldNow: tick });
  await we.ready;
  await we.onMessage({ type: "start", challenge: "11".repeat(32), target: "00".repeat(32), nonceStart: "0000000000000000" });
  assert.deepEqual(err.at(-1), { type: "error", message: "Argon2 failed: out of memory" });
  assert.ok(!err.some((x) => x.type === "found"));

  const bad = [];
  const wb = WORKER.createMiner({ mine: stubMine(), post: (x) => bad.push(x) });
  await wb.ready;
  await wb.onMessage({ type: "start", challenge: "11", target: "ff".repeat(32) });
  await wb.onMessage({ type: "start", challenge: "11".repeat(32), target: "ff".repeat(32), step: 2 });
  await wb.onMessage({ type: "nope" });
  assert.deepEqual(bad.slice(1).map((x) => x.type), ["error", "error", "error"]);
});

test("worker with the real src/mine.mjs: the self-test, a found solution equal to the reference, verify, disable", async (t) => {
  t.after(() => mine.__testing.reset());
  mine.__testing.reset();
  const out = [];
  const w = WORKER.createMiner({ post: (x) => out.push(x), yieldNow: tick });
  const r = await w.ready;
  assert.deepEqual(r, { ok: true, impl: "hash-wasm" }, "hash-wasm passes its vectors in node");
  const challenge = hex(mine.challengeOf({ asset: ASSET, refHeight: 330_000, refHash: "00".repeat(30) + "0abc", reward: 50n, commitments: [1n, 2n] }));
  // Target 2^256 - 1 (difficulty 1): the first nonce is a solution; its hash must be the reference's.
  await w.onMessage({ type: "start", id: "j1", challenge, target: mine.targetHex(1n), nonceStart: "0500000000000000" });
  const f = out.find((x) => x.type === "found");
  assert.equal(f.nonce, "0500000000000000");
  const pw = mine.passwordOf(unhex(challenge), unhex(f.nonce));
  assert.equal(f.powHash, hex(mine.powHashReference(pw)), "the fast path and the reference agree");
  // verify: the reference in the worker.
  await w.onMessage({ type: "verify", id: 9, password: hex(pw) });
  assert.deepEqual(out.at(-1), { type: "verified", id: 9, powHash: f.powHash });
  await w.onMessage({ type: "verify", id: 10, password: "00" });
  assert.equal(out.at(-1).id, 10);
  assert.ok(out.at(-1).error);
  // disable: the page's re-check disagreed; the worker reports noble from now on.
  await w.onMessage({ type: "disable", reason: "test" });
  assert.deepEqual(out.at(-1), { type: "ready", ok: true, impl: "noble" });
  assert.equal(mine.fastPathState().disabled, "test");

  // A fast path that fails its vectors: the worker starts in slow mode.
  mine.__testing.reset();
  mine.__testing.setImpls({ fast: async () => new Uint8Array(32) });
  const slow = [];
  const w2 = WORKER.createMiner({ post: (x) => slow.push(x) });
  assert.deepEqual(await w2.ready, { ok: true, impl: "noble" });
  assert.equal(MINEVIEW.fastPathNote(slow[0]), SHARED.MINE_TEXT.slow);
});

/* ======================================================================================= */
/* 2. the page's controller: restarts on a new tip and after each solution                  */
/* ======================================================================================= */

function fakeWorkers() {
  const all = [];
  const spawn = () => {
    const w = { posts: [], terminated: false, onmessage: null, postMessage(m) { this.posts.push(m); }, terminate() { this.terminated = true; } };
    w.emit = (data) => w.onmessage({ data });
    all.push(w);
    return w;
  };
  return { all, spawn };
}

test("controller: every worker gets the challenge at its own random nonce; a solution stops all, is handed over, then a NEW challenge; a new tip restarts", async () => {
  const { all, spawn } = fakeWorkers();
  let n = 0;
  const prepared = [];
  const found = [];
  let clock = 0;
  const ctl = new MINEVIEW.MineController({
    spawn,
    prepare: async () => {
      n += 1;
      const p = { draft: { n }, challenge: String(n).padStart(2, "0").repeat(32), target: "0f".repeat(32) };
      prepared.push(p);
      return p;
    },
    onFound: (f) => found.push(f),
    now: () => clock,
  });
  await ctl.start(3);
  assert.equal(all.length, 3);
  const starts = all.map((w) => w.posts.filter((m) => m.type === "start").at(-1));
  assert.ok(starts.every((m) => m.challenge === prepared[0].challenge && m.target === prepared[0].target && m.step === 1 && m.progressMs === 1000));
  assert.equal(new Set(starts.map((m) => m.nonceStart)).size, 3, "each worker starts at its own random nonce");
  assert.ok(starts.every((m) => /^[0-9a-f]{16}$/.test(m.nonceStart)));

  // Progress: this tab's hashrate is the last 10 s of reports over the time they cover (here
  // 1 s after Start: three workers at 1,000 H/s, not 3,000 hashes spread over 10 s).
  for (const w of all) w.emit({ type: "progress", hashes: 1000, ms: 1000, id: starts[0].id });
  assert.equal(ctl.hashrate(), 3000);
  clock = 11_000;
  assert.equal(ctl.hashrate(), 0, "older than 10 s: dropped");

  // A solution from worker 1: all stop, handed over with ITS draft, then a fresh challenge.
  const id1 = starts[0].id;
  all[1].emit({ type: "found", id: id1, nonce: "0102030405060708", powHash: "aa".repeat(32), hashes: 77 });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { draft: prepared[0].draft, nonce: "0102030405060708", powHash: "aa".repeat(32), hashes: 77 });
  assert.ok(all.every((w) => w.posts.some((m) => m.type === "stop")), "every worker stopped");
  await settle();
  assert.equal(prepared.length, 2, "prepare ran again after the solution");
  const second = all.map((w) => w.posts.filter((m) => m.type === "start").at(-1));
  assert.ok(second.every((m) => m.challenge === prepared[1].challenge && m.id !== id1), "restarted on the new challenge");
  // A late solution of the old challenge is ignored (never claimed against the new one).
  all[2].emit({ type: "found", id: id1, nonce: "0000000000000001", powHash: "bb".repeat(32), hashes: 1 });
  assert.equal(found.length, 1);

  // A new tip: the page calls restart(): one more fresh challenge.
  await ctl.restart();
  assert.equal(prepared.length, 3);
  assert.ok(all.every((w) => w.posts.filter((m) => m.type === "start").at(-1).challenge === prepared[2].challenge));

  // More threads: the new worker joins the current challenge; fewer: workers are terminated.
  ctl.setThreads(4);
  assert.equal(all.length, 4);
  assert.equal(all[3].posts.find((m) => m.type === "start").challenge, prepared[2].challenge);
  ctl.setThreads(2);
  assert.equal(ctl.workers.length, 2);
  assert.ok(all[3].terminated && all[2].terminated);

  // A prepare that fails (the wallet is behind) pauses with its reason, no start.
  const before = all[0].posts.length;
  ctl.prepare = async () => {
    throw new Error("Waiting for the wallet and the indexer to reach the same block.");
  };
  await ctl.restart();
  assert.equal(ctl.paused, "Waiting for the wallet and the indexer to reach the same block.");
  assert.ok(!all[0].posts.slice(before).some((m) => m.type === "start"));
  ctl.stop();
  assert.equal(ctl.running, false);
  ctl.terminate();
});

test("controller: the reference re-check runs in a worker; a disagreeing fast path is disabled in every worker; a refusing worker stops mining", async () => {
  const { all, spawn } = fakeWorkers();
  const ctl = new MINEVIEW.MineController({ spawn, prepare: async () => ({ draft: {}, challenge: "11".repeat(32), target: "ff".repeat(32) }) });
  await ctl.start(2);
  const p = ctl.verify("ab".repeat(40));
  const req = all[0].posts.find((m) => m.type === "verify");
  assert.equal(req.password, "ab".repeat(40));
  all[0].emit({ type: "verified", id: req.id, powHash: "cd".repeat(32) });
  assert.equal(await p, "cd".repeat(32));
  const p2 = ctl.verify("ab".repeat(40));
  const req2 = all[0].posts.filter((m) => m.type === "verify").at(-1);
  all[0].emit({ type: "verified", id: req2.id, error: "boom" });
  await assert.rejects(p2, /boom/);

  // The claim's check reported pow_mismatch: the page disables the fast path everywhere.
  const r = MINEVIEW.onClaimError(Object.assign(new Error("disagreed"), { code: "pow_mismatch" }), ctl);
  assert.equal(r.status, "failed");
  for (const w of all) assert.deepEqual(w.posts.at(-1), { type: "disable", reason: "the reference re-check disagreed" });
  assert.equal(ctl.note, SHARED.MINE_TEXT.slow);
  assert.deepEqual(MINEVIEW.onClaimError(Object.assign(new Error("x"), { code: "stale_work" }), ctl), { status: "stale", message: SHARED.MINE_TEXT.surge });

  all[1].emit({ type: "ready", ok: false, impl: null });
  assert.equal(ctl.running, false, "a worker whose reference failed stops mining");
  assert.equal(ctl.note, SHARED.MINE_TEXT.off);
  ctl.terminate();
});

test("page helpers: threads, live figures, near-cap, default route, quotes and windows", () => {
  assert.deepEqual(MINEVIEW.threadRange(8), { min: 1, max: 7, value: 4 });
  assert.deepEqual(MINEVIEW.threadRange(1), { min: 1, max: 1, value: 1 });
  assert.deepEqual(MINEVIEW.threadRange(0), { min: 1, max: 1, value: 1 });
  const f = MINEVIEW.liveFigures({ hashrate: 1000, difficulty: "600000" });
  assert.equal(f.perSolution, 600);
  assert.ok(Math.abs(f.nextBlock - (1 - Math.exp(-1))) < 1e-12);
  assert.deepEqual(MINEVIEW.liveFigures({ hashrate: 0, difficulty: 5 }), { perSolution: null, nextBlock: 0 });
  assert.equal(MINEVIEW.roughDuration(600), "about 10 min");
  assert.equal(MINEVIEW.rateText(250), "250 H/s");
  assert.equal(MINEVIEW.rateText(80_000), "80.0 kH/s");

  assert.equal(MINEVIEW.nearCap(minedView()), false);
  // 50 left, 2 claims in the last 3 blocks: 50 < 50 x 3.
  assert.equal(MINEVIEW.nearCap(minedView({ issued: "1049950" })), true);
  assert.equal(MINEVIEW.nearCap(minedView({ issued: "1049000", pendingClaims: 18 })), true, "claims in flight count");

  // Quotes (mining.md §12.1): 684 vB at ceil(rate x 1.25) + service; relay = the relayer's quote.
  assert.deepEqual(S.mineQuote({ route: "key", feeRate: 2, serviceSats: 500n }), { route: "key", feeSats: 2052n, serviceSats: 500n, marginSats: 0n, total: 2552n });
  assert.deepEqual(S.mineQuote({ route: "relay", relayMine: { carrierFeeSats: 1368, marginSats: 137 }, serviceSats: 500n }).total, 2005n);
  assert.equal(S.mineQuote({ route: "relay", relayMine: null }), null);
  assert.equal(S.mineQuote({ route: "key", feeRate: null }), null);
  const outs = S.mineFeeOutputs(minedView());
  assert.deepEqual(outs.map((o) => [hex(o.script), o.sats, o.amount, o.role]), [[PLATFORM, 500n, 500n, "platform"]], "from the pinned MINE_FEE, not the server");
  assert.deepEqual(S.mineFeeOutputs({ ...minedView(), feeOutputs: [{ script: "51" + "20" + "00".repeat(32), sats: "1" }] }).map((o) => hex(o.script)), [PLATFORM], "a server's feeOutputs are ignored");

  // The relayer signs while tip <= ref + 9; a self-paid claim needs two blocks left.
  assert.equal(S.mineWindowLeft(100, 109, "relay"), 0);
  assert.equal(S.mineWindowLeft(100, 110, "relay"), -1);
  assert.equal(S.mineWindowLeft(100, 110, "key"), 0);
  assert.equal(S.mineWindowLeft(100, 111, "key"), -1);

  // Relay is the default only while it runs, takes claims and the balance covers one.
  R.RELAY_ROUTE.open = true;
  try {
    const m = { enabled: true, carrierFeeSats: 1368, marginSats: 137 };
    assert.equal(MINEVIEW.defaultRoute({ relayMine: m, balance: { balance: 5000 }, serviceSats: 500n }), "relay");
    assert.equal(MINEVIEW.defaultRoute({ relayMine: m, balance: { balance: 2004 }, serviceSats: 500n }), "key");
    assert.equal(MINEVIEW.defaultRoute({ relayMine: { ...m, enabled: false }, balance: { balance: 5000 } }), "key");
    assert.equal(MINEVIEW.defaultRoute({ relayMine: m, balance: null }), "key");
  } finally {
    R.RELAY_ROUTE.open = false;
  }
  assert.equal(MINEVIEW.defaultRoute({ relayMine: { enabled: true, carrierFeeSats: 1 }, balance: { balance: 1e9 } }), "key", "relaying off: never the default");
});

/* ======================================================================================= */
/* 3. session: keys, assets, W-M                                                           */
/* ======================================================================================= */

test("the mining key differs from the transfer key; mining coins never pay transfers or top-ups", () => {
  const phrase = S.newPhrase();
  const s = new S.Session({ phrase });
  const entropy = mnemonicToEntropy(phrase, wordlist);
  const { feeKey, mineFeeKey } = feeKeysOf(entropy);
  assert.equal(hex(s.localPayer.key), hex(hkdf(sha256, entropy, undefined, "murkle/btc-fee", 32)), "the transfer key is byte-identical to before");
  assert.equal(hex(s.localPayer.key), hex(feeKey));
  assert.equal(hex(s.minePayer.key), hex(mineFeeKey));
  assert.notEqual(s.minePayer.address, s.localPayer.address);
  assert.equal(s.minePayer.address, funding.btcAccount(mineFeeKey).address);
  assert.equal(s.ownPayer(), s.localPayer, "transfers, mints and launches pay from the transfer key");
  // Only the mining code reaches the mining key: no transfer, top-up or deposit view does.
  for (const f of ["web/src/views/app-send.js", "web/src/views/topup.js", "web/src/views/deposit.js", "web/src/views/app-activity.js", "web/src/views/app-settings.js", "web/src/payers.js", "web/src/relay.js"]) {
    assert.ok(!src(f).includes("minePayer"), `${f} never touches the mining key`);
  }
  // Methods of Session (two-space indent) whose body names the mining key.
  const uses = new Set();
  let cur = null;
  for (const line of src("web/src/session.js").split("\n")) {
    const m = line.match(/^ {2}(?:async |get |set |static )?(#?\w+)\(/);
    if (m) cur = m[1];
    if (line.includes("minePayer") && cur) uses.add(cur);
  }
  assert.deepEqual([...uses].sort(), ["checkMineBtc", "claimMine", "constructor", "moveBetweenKeys", "prepareCoins"], "the session reaches the mining key only in mining code");
});

test("moving coins between the two keys asks first", async () => {
  const s = new S.Session({ phrase: S.newPhrase() });
  await assert.rejects(s.moveBetweenKeys({ from: "transfer", amount: 1000 }), (e) => e.code === "confirm_move" && /links the two addresses/.test(e.message));
  await assert.rejects(s.moveBetweenKeys({ from: "elsewhere", amount: 1, confirm: true }), /transfer key or from the mining key/);
});

test("assetList merges /api/assets with /api/mine (kind kept); a mined row never replaces a listed one", () => {
  const paid = [{ id: "7", ticker: "ABC", status: "live", kind: "mint" }];
  const merged = S.mergeAssets(paid, { assets: [minedView(), { ...minedView(), asset: "7", ticker: "DUP" }, { ...minedView(), asset: "x" }] });
  assert.equal(merged.length, 2);
  assert.equal(merged[0], paid[0], "paid rows are kept as they are");
  assert.equal(merged[1].id, ASSET.toString());
  assert.equal(merged[1].kind, "pow");
  assert.equal(merged[1].ticker, "ORE");
  assert.deepEqual(S.mergeAssets(paid, null), paid);
  assert.deepEqual(S.mergeAssets(null, null), []);
});

test("W-M rules: pending claims reserve their rolled notes until ref + 12; statuses from bulk data and the relayer", () => {
  const e = { kind: "mine", id: "m1", via: "self", ref: 100, lockUntil: 112, spends: ["5", "6"], commitments: ["91", "92"], status: "submitted", txid: "aa".repeat(32) };
  assert.deepEqual([...S.lockedNullifiers([e], 105, new Set())], ["5", "6"]);
  assert.deepEqual([...S.lockedNullifiers([e], 112, new Set())], ["5", "6"]);
  assert.deepEqual([...S.lockedNullifiers([e], 113, new Set())], [], "past the window: free again");
  assert.deepEqual([...S.lockedNullifiers([{ ...e, status: "proving" }], 105, new Set())], ["5", "6"]);
  for (const st of ["landed", "expired", "rejected", "dropped"]) assert.deepEqual([...S.lockedNullifiers([{ ...e, status: st }], 105, new Set())], [], st);
  assert.deepEqual([...S.lockedNullifiers([e], 105, new Set(["5", "6"]))], [], "spent: nothing to reserve");
  assert.deepEqual([...S.lockedNullifiers([{ ...e, spends: [] }], 105, new Set())], []);

  const ctx = { height: 105, outputs: new Map(), log: new Map() };
  assert.deepEqual(S.deriveMineStatus(e, ctx), { status: "submitted" });
  assert.equal(S.deriveMineStatus(e, { ...ctx, outputs: new Map([["92", { txid: "bb".repeat(32), height: 104 }]]) }).status, "landed");
  assert.deepEqual(S.deriveMineStatus(e, { ...ctx, log: new Map([[e.txid, { ok: false, reason: "supply cap reached", height: 104 }]]) }), { status: "rejected", reason: "supply cap reached", height: 104 });
  assert.equal(S.deriveMineStatus(e, { ...ctx, height: 113 }).status, "expired");
  assert.equal(S.deriveMineStatus({ ...e, status: "landed" }, { ...ctx, height: 200 }).status, "landed", "final stays final");
  const r = { ...e, via: "relay", relayId: "r1", txid: undefined };
  assert.deepEqual(S.deriveMineStatus(r, { ...ctx, relay: { status: "queued" } }), { status: "submitted", relayStatus: "queued" });
  assert.equal(S.deriveMineStatus(r, { ...ctx, relay: { status: "broadcast", txid: "cc".repeat(32) } }).txid, "cc".repeat(32));
  assert.equal(S.deriveMineStatus(r, { ...ctx, relay: { status: "dropped" } }).status, "dropped");
  assert.equal(S.deriveMineStatus(r, { ...ctx, relay: { status: "rejected", reason: "insufficient work" } }).reason, "insufficient work");
  // Relayed claims never offer "pay the fee myself" (it would link the two).
  assert.deepEqual(S.retryChoices({ ...r, status: "submitted" }, 105), []);
  // Status chips.
  assert.match(String(SHARED.statusChip({ ...e, status: "landed" })), /Landed/);
  assert.match(String(SHARED.statusChip({ ...e, status: "proving" })), /Proving/);
  assert.match(String(SHARED.statusChip({ ...r, status: "submitted" })), /With the relayer/);
  assert.match(String(SHARED.statusChip({ ...e, status: "expired" })), /Expired/);
});

/* ---------- a real claim, end to end on a fake chain ---------- */

const TIP0 = 330_000;
const BLOCK_HASH = (h) => sha256(new TextEncoder().encode(`block ${h}`)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
const WASM = readFileSync("build/transaction_js/transaction.wasm");
const ZKEY = readFileSync("build/dev/transaction.zkey");
const VKEY = readFileSync("build/dev/verification_key.json");
const POOL_KEY = "02".repeat(32).slice(0, 64);

/** Installs the fake chain: the mined view at `chain.tip`, block hashes, the mining key's coins, fees, broadcast, relayer. */
function installChain(chain) {
  net.routes.clear();
  net.routes.set(/\/block-height\/(\d+)$/, ({ m }) => reply(200, chain.hashOf(Number(m[1]))));
  net.routes.set(/\/v1\/fees\/recommended$/, () => reply(200, { fastestFee: 2, halfHourFee: 1 }));
  net.routes.set(/\/fee-estimates$/, () => reply(200, { 1: 2, 3: 1 }));
  net.routes.set(/\/address\/([a-z0-9]+)\/utxo$/, ({ m }) => {
    chain.utxoAsks.push(m[1]);
    return reply(200, chain.utxos.get(m[1]) ?? []);
  });
  net.routes.set(/\/api\/tx$/, ({ method, init }) => {
    assert.equal(method, "POST");
    net.broadcasts.push(init.body);
    return reply(200, btc.Transaction.fromRaw(Buffer.from(init.body, "hex"), { allowUnknownOutputs: true }).id);
  });
  net.routes.set(/^\/api\/mine\/(\w+)$/, () => reply(200, chain.view()));
  net.routes.set(/^\/api\/mine$/, () => reply(200, { activation: { height: 325_000, active: true }, tip: chain.view().tip, assets: [chain.view()] }));
  net.routes.set(/^\/artifacts\/verification_key\.json$/, () => new Response(VKEY, { status: 200 }));
  net.routes.set(/^\/api\/relay\/info$/, () => reply(200, chain.relayInfo()));
  net.routes.set(/^\/api\/relay\/submit$/, ({ init }) => {
    const body = JSON.parse(init.body);
    net.submits.push(body);
    return chain.onSubmit(body);
  });
}

test("a claim end to end (built-in mining key): re-check, bind a mining-key coin, W-M entry in the vault, prove, sign, broadcast; then landed", async (t) => {
  const phrase = S.newPhrase();
  const s = await S.createWallet(phrase, "correct horse battery staple 1");
  t.after(() => S.forgetWallet());
  s.wallet.artifacts = { wasm: WASM, zkey: ZKEY };

  // The wallet owns one note of ORE (a reward that landed before), so the claim rolls it in.
  const view0 = { startHeight: 324_592, tree: new MerkleTree(), outputs: [], nullifiers: new Set(), height: TIP0 - 1 };
  s.view = view0;
  const seed = s.prepareMine(minedView({ tipHeight: TIP0 - 1, tipHash: BLOCK_HASH(TIP0 - 1) }), { roll: false });
  const view = { ...view0, tree: new MerkleTree(), outputs: [], height: TIP0 };
  seed.commitments.forEach((c, i) => {
    view.tree.insert(c);
    view.outputs.push({ commitment: c, ciphertext: seed.ciphertexts[i], leafIndex: i, txid: "11".repeat(32), height: TIP0 });
  });
  s.view = view;
  s.wallet.scan(view);
  assert.equal(s.wallet.balance(ASSET), 50n);

  const coin = { txid: "77".repeat(32), vout: 1, value: 100_000, status: { confirmed: true, block_height: TIP0 - 5 } };
  const chain = {
    tip: TIP0, utxoAsks: [], utxos: new Map([[s.minePayer.address, [coin]]]),
    hashOf: (h) => BLOCK_HASH(h),
    view: () => minedView({ tipHeight: chain.tip, tipHash: BLOCK_HASH(chain.tip) }),
    relayInfo: () => ({ enabled: false }),
    onSubmit: () => reply(500, {}),
  };
  installChain(chain);

  // Two drafts on one tip share no commitment or nullifier; a found solution's notes stay out of the next one.
  const asset = chain.view();
  const d1 = s.prepareMine(asset);
  assert.equal(d1.rolled.length, 1, "the owned note is rolled in");
  assert.equal(d1.reward, 50n);
  assert.equal(d1.meta.difficulty, 1n);
  s.holdDraft(d1);
  const d2 = s.prepareMine(asset);
  assert.deepEqual(d2.rolled, [], "held by the found solution: not rolled twice");
  for (const c of d2.commitments) assert.ok(!d1.commitments.includes(c));
  for (const n of d2.nullifiers) assert.ok(!d1.nullifiers.includes(n));
  assert.notEqual(hex(d1.challenge), hex(d2.challenge));

  // The worker's solution: at difficulty 1 any nonce is one. Its hash is the reference's.
  const nonce = "0900000000000000";
  const pw = mine.passwordOf(d1.challenge, unhex(nonce));
  const powHash = hex(mine.powHashReference(pw));
  const referenceHash = async (p) => hex(mine.powHashReference(unhex(p)));

  // A fast path that disagrees with the reference: refused before anything is paid or recorded.
  const before = net.calls.length;
  await assert.rejects(s.claimMine({ draft: d1, nonce, powHash: "00".repeat(32), route: "key", referenceHash }), (e) => e.code === "pow_mismatch");
  assert.equal(s.history.filter((h) => h.kind === "mine").length, 0);
  assert.ok(!net.calls.slice(before).some((c) => c.includes("/utxo") || c.includes("/api/tx")), "nothing looked up or paid");
  // The indexer's block hash differs from mempool.space's: refused, nothing paid.
  chain.hashOf = (h) => (h === TIP0 ? "ee".repeat(32) : BLOCK_HASH(h));
  await assert.rejects(s.claimMine({ draft: d1, nonce, powHash, route: "key", referenceHash }), (e) => e.code === "refhash");
  chain.hashOf = (h) => BLOCK_HASH(h);
  // Too close to the end of the window for a self-paid claim.
  chain.tip = TIP0 + MINE_WINDOW - 1;
  await assert.rejects(s.claimMine({ draft: d1, nonce, powHash, route: "key", referenceHash }), (e) => e.code === "expired");
  chain.tip = TIP0;
  s.holdDraft(d1); // a refusal releases the draft's notes; the page holds a found solution again on retry

  const steps = [];
  const entry = await s.claimMine({ draft: d1, nonce, powHash, route: "key", referenceHash, onStep: (x) => steps.push(`${x.id}:${x.status}`) });
  for (const id of ["check", "bind", "prove", "verify", "sign", "broadcast"]) assert.ok(steps.includes(`${id}:ok`), `${id} ran`);
  assert.equal(entry.kind, "mine");
  assert.equal(entry.status, "submitted");
  assert.equal(entry.via, "self");
  assert.equal(entry.ref, TIP0);
  assert.equal(entry.lockUntil, TIP0 + 12);
  assert.equal(entry.solutionId, hex(mine.solutionIdOf(d1.challenge, unhex(nonce))));
  assert.deepEqual(entry.spends, d1.rolled);
  assert.deepEqual(entry.commitments, d1.commitments.map(String));
  assert.equal(entry.coin, `${coin.txid}:${coin.vout}`);
  assert.equal(entry.payerAddress, s.minePayer.address);
  assert.ok(!chain.utxoAsks.includes(s.localPayer.address), "the transfer key's coins were never looked up");

  // W-M is persisted in the vault, and the rolled note is reserved.
  const stored = keystore.openData(s.key, keystore.readVault(S.storage, STORAGE_PREFIX));
  const saved = stored.history.find((h) => h.id === entry.id);
  assert.deepEqual([saved.kind, saved.status, saved.solutionId, saved.lockUntil, saved.spends], ["mine", "submitted", entry.solutionId, TIP0 + 12, d1.rolled]);
  assert.ok(s.wallet.locked.has(d1.rolled[0]));
  assert.equal(s.available(ASSET), 0n);

  // The carrier: OP_RETURN with a MINE bound to the chosen coin, the platform's 500 sats, change to the mining key.
  assert.equal(net.broadcasts.length, 1);
  const tx = btc.Transaction.fromRaw(Buffer.from(net.broadcasts[0], "hex"), { allowUnknownOutputs: true });
  assert.equal(hex(tx.getInput(0).txid), coin.txid);
  assert.equal(tx.getInput(0).index, coin.vout);
  assert.equal(tx.getInput(0).sequence, 0xfffffffd, "RBF stays possible");
  const env = decodeEnvelope(opReturnPayload(tx.getOutput(0).script));
  assert.equal(env.op, OP.MINE);
  assert.equal(env.refHeight, TIP0);
  assert.equal(env.publicAmount, 50n);
  assert.equal(env.publicAsset, ASSET);
  assert.equal(hex(env.nonce), nonce);
  assert.equal(hex(env.bindOutpoint), hex(outpointOf(coin.txid, coin.vout)), "bound to the coin it spends first");
  // L5: the change takes a random slot after the OP_RETURN; the fee output is the other one.
  assert.equal(tx.outputsLength, 3);
  const changeAt = [1, 2].filter((v) => funding.addressOf(tx.getOutput(v).script) === s.minePayer.address);
  assert.equal(changeAt.length, 1, "one change output back to the mining key");
  const feeAt = 3 - changeAt[0];
  assert.equal(hex(tx.getOutput(feeAt).script), PLATFORM);
  assert.equal(tx.getOutput(feeAt).amount, 500n);

  // One solution, one route: the same solution again is refused (W-M).
  s.holdDraft(d1);
  await assert.rejects(s.claimMine({ draft: d1, nonce, powHash, route: "key", referenceHash }), (e) => e.code === "solution_taken" || e.code === "notes_taken");
  assert.equal(net.broadcasts.length, 1);
  assert.equal(s.history.filter((h) => h.kind === "mine").length, 1);
  // A coin bound to a pending claim is never bound again.
  const d3 = s.prepareMine(asset);
  await assert.rejects(s.claimMine({ draft: d3, nonce, powHash: hex(mine.powHashReference(mine.passwordOf(d3.challenge, unhex(nonce)))), route: "key", referenceHash }), (e) => e.code === "no_coins");

  // It lands: its commitments appear in the pool.
  s.view = { ...view, outputs: [...view.outputs, ...[0, 1].map((o) => ({ commitment: d1.commitments[o], ciphertext: d1.ciphertexts[o], leafIndex: 2 + o, txid: tx.id, height: TIP0 + 1 }))], height: TIP0 + 1 };
  await s.refreshHistory();
  assert.equal(entry.status, "landed");
  assert.equal(entry.txid, tx.id);
  assert.deepEqual([...S.lockedNullifiers(s.history, TIP0 + 1, new Set(d1.rolled))], []);
});

test("a relayed claim: bound to the relayer's change key, re-proved once on bind_stale with the same solution; no self-pay fallback", async (t) => {
  const phrase = S.newPhrase();
  const s = await S.createWallet(phrase, "correct horse battery staple 2");
  t.after(() => S.forgetWallet());
  t.after(() => R.setRelayRoute(null));
  s.wallet.artifacts = { wasm: WASM, zkey: ZKEY };
  s.view = { startHeight: 324_592, tree: new MerkleTree(), outputs: [], nullifiers: new Set(), height: TIP0 };
  const { schnorr } = await import("@noble/curves/secp256k1");
  const poolKey = Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(5))).toString("hex");
  const oldBind = "aa".repeat(32);
  const newBind = "bb".repeat(32);
  const chain = {
    tip: TIP0, utxoAsks: [], utxos: new Map(), hashOf: BLOCK_HASH,
    view: () => minedView({ tipHeight: chain.tip, tipHash: BLOCK_HASH(chain.tip) }),
    relayInfo: () => ({
      enabled: true, mode: "balance", network: "signet", code: null,
      balance: { poolKey, perSendSats: 657 },
      mine: { enabled: true, code: null, bindScriptHash: oldBind, modes: ["fast", "block"], slack: 2, estVsize: 684, feeRate: 2, carrierFeeSats: 1368, marginSats: 137, invalidPowSats: 20 },
    }),
    onSubmit: (body) => {
      const env = decodeEnvelope(unhex(body.envelope));
      if (hex(env.bindScriptHash) === oldBind) return reply(409, { error: { code: "bind_stale", message: "The relayer's change address changed.", bindScriptHash: newBind } });
      return reply(202, { id: "ef".repeat(16), status: "queued", kind: "mine", ref: env.refHeight, lastBroadcast: env.refHeight + 9, deadline: env.refHeight + 12, solutionId: "00", reservedSats: 2005, serviceSats: "500", balance: 3000 });
    },
  };
  installChain(chain);
  await s.loadRelayInfo();
  assert.equal(R.relayOpen(), true);

  const broadcastsBefore = net.broadcasts.length;
  const asset = chain.view();
  const d = s.prepareMine(asset);
  s.holdDraft(d);
  const nonce = "0100000000000000";
  const powHash = hex(mine.powHashReference(mine.passwordOf(d.challenge, unhex(nonce))));
  const entry = await s.claimMine({ draft: d, nonce, powHash, route: "relay", referenceHash: async (p) => hex(mine.powHashReference(unhex(p))) });
  assert.equal(net.submits.length >= 2, true);
  const [first, second] = net.submits.slice(-2).map((b) => decodeEnvelope(unhex(b.envelope)));
  assert.equal(first.op, OP.MINE_SCRIPT);
  assert.equal(hex(first.bindScriptHash), oldBind);
  assert.equal(hex(second.bindScriptHash), newBind, "re-proved for the new change address");
  assert.equal(hex(mine.solutionIdOf(mine.challengeOf({ asset: second.publicAsset, refHeight: second.refHeight, refHash: BLOCK_HASH(TIP0), reward: second.publicAmount, commitments: second.commitments }), second.nonce)), entry.solutionId, "the solution is unchanged");
  assert.equal(net.submits.at(-1).mode, "block");
  assert.equal(net.submits.at(-1).accountPub, s.relayAccount.pubHex, "signed by this wallet's relay account");
  assert.deepEqual([entry.via, entry.status, entry.relayId, entry.deadline], ["relay", "submitted", "ef".repeat(16), TIP0 + 12]);
  assert.equal(entry.payerAddress, null);
  assert.deepEqual(S.retryChoices(entry, TIP0 + 1), [], "no pay-the-fee-myself while it is pending");
  assert.equal(net.broadcasts.length, broadcastsBefore, "nothing broadcast from this wallet");
});

/* ======================================================================================= */
/* 4. copy, routing, launch, token page, explorer, relayer audit                            */
/* ======================================================================================= */

const NEVER = [/\banonymous\b/i, /\buntraceable\b/i, /\btrustless\b/i, /\bmixer\b/i, /\bfree\b/i, /\bsponsor/i, /fair launch guaranteed/i];

test("copy per route: the relay sentence never says the relayer cannot see tokens; every §12 string is exact and clean", async () => {
  const relay = SHARED.mineCopy("relay", { ticker: "ORE", reward: "50 ORE", feeSats: 500n });
  const key = SHARED.mineCopy("key", { ticker: "ORE", reward: "50 ORE", feeSats: 500n, phone: true });
  assert.equal(relay[0], "The reward goes to a private note. Chain observers see relay claims of ORE for 50 ORE each, not who received them. The relayer can link the address you top up from to every claim it carries for you, including the token and the reward. While few people relay claims, the claims right after your top-up are easy to tie to it. Top up before you start mining.");
  assert.equal(key[0], "Claims are public: token, reward and the paying address. Anyone can add up what this address mined, and the transfers it pays for later.");
  assert.equal(SHARED.mineCopy("unisat")[0], key[0]);
  for (const lines of [relay, key]) {
    assert.ok(lines.includes("A single GPU or a server miner can be thousands of times faster than this tab. Anyone can rent many computers."));
    assert.ok(lines.includes("Every claim pays a Bitcoin fee and a service fee of 500 sats to the Murkle platform address. Its own claims cost it 500 sats less."));
    assert.ok(lines.includes("Bitcoin miners choose what goes into blocks and in what order. They can delay a claim until it expires."));
    assert.ok(lines.includes("A claim must land within 12 blocks of the block it references."));
    assert.ok(lines.includes("The fee recipient can block a fee bump, so the wallet pays a next-block rate up front."));
    assert.ok(lines.includes("Test coins, no value."));
    for (const l of lines) assert.ok(!/cannot see/i.test(l), "the transfer relay sentence is never shown for mining");
  }
  assert.ok(key.includes("Mining keeps the processor busy: expect battery drain and heat."));
  assert.equal(SHARED.MINE_TEXT.nearCap, "Supply is nearly mined out. A claim that lands after the cap is rejected; its Bitcoin fee and its service fee are still spent.");
  assert.equal(SHARED.MINE_TEXT.surge, "Difficulty jumped. Solutions found before the jump may no longer count; the wallet checks before paying.");
  assert.equal(SHARED.MINE_TEXT.noise, "Difficulty is noisy: with few solutions per span, emission runs a few percent above target.");
  assert.equal(SHARED.MINE_TEXT.burst, "After a quiet period or a hashrate jump, the first block can carry many claims.");
  // Every string, in every new or changed web file, passes the repository guards and the never-say list.
  const { readdirSync } = await import("node:fs");
  void readdirSync;
  const strip = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const english = src("test/english.test.mjs");
  const lists = [...english.matchAll(/const (BANNED|FREE_RELAY) = \[([\s\S]*?)\n\];/g)].flatMap((m) => [...m[2].matchAll(/^\s*(\/.+\/[a-z]*),?$/gm)].map((x) => eval(x[1])));
  assert.ok(lists.length >= 20, "read the english.test.mjs lists");
  const allCopy = [...Object.values(SHARED.MINE_TEXT).map((v) => (typeof v === "function" ? v({ ticker: "ORE", reward: "50", sats: 500n, recipient: SHARED.MINE_RECIPIENT }) : v)), ...LAUNCH.POW_DISCLOSURES()];
  for (const f of ["web/src/views/app-mine.js", "web/src/mine-worker.js", "web/src/views/app-launch.js", "web/src/views/token.js", "web/src/views/explorer.js", "web/src/views/app-shared.js", "web/src/session.js", "web/src/relay.js"]) {
    const code = strip(src(f));
    for (const re of lists) assert.ok(!re.test(code), `${f}: ${re}`);
  }
  for (const f of ["web/src/views/app-mine.js", "web/src/mine-worker.js"]) {
    const code = strip(src(f));
    for (const re of NEVER) assert.ok(!re.test(code), `${f}: ${re}`);
    assert.ok(!new RegExp("[\u0400-\u04FF]").test(src(f)));
  }
  for (const s of allCopy) {
    for (const re of [...lists, ...NEVER]) assert.ok(!re.test(s), `${s} :: ${re}`);
  }
});

test("/app/mine is routed, with Mine next to Mint in the rail and the phone tab bar", () => {
  const app = src("web/src/app.js");
  assert.match(app, /\["\/app\/mint", "app-mint", "app", "Mint"\],\n {2}\["\/app\/mine", "app-mine", "app", "Mine"\],/);
  assert.match(app, /\["\/app\/mint", "mint", "Mint"\],\n {2}\["\/app\/mine", "block", "Mine"\],/);
  assert.match(app, /tab\("\/app\/mint", "mint", "Mint"\)\}\$\{tab\("\/app\/mine", "block", "Mine"\)\}/);
  assert.deepEqual(matchPath("/app/mine", "/app/mine"), {});
  assert.equal(typeof MINEVIEW.render, "function");
  assert.match(src("web/src/styles/pages.css"), /\.tabbar\.mine-tabs6 \{ grid-template-columns: repeat\(6, 1fr\); \}/);
});

test("launch form: Mined defaults, the suggested difficulty and floor, the DEPLOY_POW bytes, and every bound", async () => {
  const base = { ...LAUNCH.POW_FORM_DEFAULTS, ticker: "ore", decimals: "0" };
  const r = LAUNCH.buildPowTerms(base, { height: 330_000 });
  assert.deepEqual(r.errors, {});
  assert.equal(r.span, 24);
  assert.equal(r.targetPerSpan, 24, "1 solution per block x span 24");
  assert.equal(r.hashrate, 2000);
  assert.equal(r.suggested, 1_200_000n, "2,000 H/s x 600 s x 24 / 24");
  assert.equal(r.initialDifficulty, 1_200_000n);
  assert.equal(r.minDifficulty, 75_000n, "initial / 16");
  assert.deepEqual([r.startMode, r.startHeight, r.mineStart], ["now", 0, 330_001], "Start mining now (the default): the launch block itself");
  assert.equal(r.terms.claimFeeSats, 0n);
  assert.equal(r.terms.treasury.length, 0);
  const env = decodeEnvelope(r.envelope);
  assert.equal(env.op, OP.DEPLOY_POW);
  assert.deepEqual([env.ticker, env.reward, env.maxSupply, env.span, env.targetPerSpan, env.initialDifficulty, env.minDifficulty, env.claimFeeSats, env.treasury.length, env.startHeight, env.endHeight],
    ["ORE", 50n, 1_050_000n, 24, 24, 1_200_000n, 75_000n, 0n, 0, 0, 0]);
  assert.equal(r.blocksToMineOut, 21_000);

  const err = (over, opts = { height: 330_000 }) => LAUNCH.buildPowTerms({ ...base, ...over }, opts).errors;
  assert.match(err({ perBlock: "0.5" }).perBlock, /at least 0\.67 per block/);
  assert.equal(LAUNCH.buildPowTerms({ ...base, perBlock: "0.75" }, { height: 1 }).targetPerSpan, 18);
  assert.match(err({ perBlock: "101" }).perBlock, /At most 100 per block/);
  assert.match(err({ span: "11" }).span, /12 to 432/);
  assert.match(err({ span: "433" }).span, /12 to 432/);
  assert.match(err({ initial: "255" }).initial, new RegExp(`from ${MIN_DIFFICULTY}`));
  assert.match(err({ floor: "255" }).floor, /at least 256/);
  assert.match(err({ initial: "1000", floor: "2000" }).floor, /above the initial/);
  assert.equal(LAUNCH.buildPowTerms({ ...base, initial: "4096" }, { height: 1 }).minDifficulty, 256n, "floor never below 256");
  assert.match(err({ reward: "0" }).reward, /greater than zero/);
  assert.match(err({ maxSupply: "10" }).maxSupply, /at least one reward/);
  // Start after N blocks: startHeight = tip + 1 + N, counted from the current tip.
  const later = LAUNCH.buildPowTerms({ ...base, start: "after", startAfter: "144" }, { height: 330_000 });
  assert.deepEqual(later.errors, {});
  assert.deepEqual([later.startMode, later.startAfter, later.startHeight, later.mineStart], ["after", 144, 330_145, 330_145]);
  assert.equal(decodeEnvelope(later.envelope).startHeight, 330_145);
  assert.equal(LAUNCH.buildPowTerms({ ...base, start: "now", startAfter: "144" }, { height: 330_000 }).terms.startHeight, 0, "now ignores the count");
  assert.match(err({ start: "after", startAfter: "0" }).startAfter, /at least 1\. To start at the launch block, pick Start mining now\./);
  assert.match(err({ start: "after", startAfter: "1.5" }).startAfter, /whole number of blocks/);
  assert.match(err({ start: "after", startAfter: "" }).startAfter, /whole number of blocks/);
  assert.match(err({ start: "after", startAfter: "10" }, { height: null }).startAfter, /Waiting for the current block height/);
  assert.deepEqual(err({ start: "now" }, { height: null }), {}, "now needs no tip");
  assert.match(err({ start: "after", startAfter: String(2 ** 32) }).startAfter, /past 4294967295/);
  assert.match(err({ start: "330145" }).start, /Pick when mining starts: now, or after a number of blocks\./);
  assert.match(err({ start: "after", startAfter: "100", end: "330050" }).end, /before mining starts \(block 330,101\)/);
  assert.equal(err({ start: "after", startAfter: "100", end: "330101" }).end, undefined);
  assert.deepEqual(LAUNCH.START_OPTIONS.map((o) => o.label), ["Start mining now", "Start after N blocks"]);
  assert.equal(LAUNCH.START_HINT, "Starting now favours whoever is ready first; a delay gives everyone time to see the terms.");
  assert.match(LAUNCH.startText(r, 330_000), /^Mining opens at the launch block itself \(block 330,001 if it lands in the next block\)\. Its hash is unknown until it is mined/);
  assert.match(LAUNCH.startText(later, 330_000), /^First usable block 330,145, .*: 144 blocks after the next block\. The count runs from the current tip: if the launch confirms later, the start block stays 330,145 and the delay is shorter\.$/);
  assert.equal(LAUNCH.opensText(r), "Mining opens at the launch block itself: claims can reference it from the next block on.");
  assert.equal(LAUNCH.opensText(later), "Mining opens at block 330,145 as you set, or at the launch block if it confirms at or after that block.");
  for (const t of [LAUNCH.START_HINT, LAUNCH.startText(r, 330_000), LAUNCH.startText(later, 330_000), LAUNCH.opensText(r), LAUNCH.opensText(later)]) for (const re of NEVER) assert.doesNotMatch(t, re);
  assert.match(err({ hashrate: "0" }).hashrate, /greater than zero/);
  assert.match(err({ ticker: "ORE" }, { height: 1, taken: new Set(["ORE"]) }).ticker, /already taken/);
  assert.ok(LAUNCH.buildPowTerms({ ...base, maxSupply: "1050010" }, { height: 1 }).leftover === 10n, "a max supply that is no multiple of the reward is pointed out");
  assert.deepEqual(LAUNCH.POW_DISCLOSURES().slice(0, 2), [SHARED.MINE_TEXT.noise, SHARED.MINE_TEXT.burst]);
  assert.ok(LAUNCH.POW_DISCLOSURES().includes(SHARED.MINE_TEXT.fee({ sats: 500n, recipient: SHARED.MINE_RECIPIENT })), "the recipient's discount is disclosed");

  // The form itself: ?kind=pow opens Mined, with the platform fee stated and the claim fee fixed at 0.
  const s = new S.Session({ phrase: S.newPhrase() });
  s.view = { height: 330_000 };
  s.btc = { sats: 10_000, at: Date.now() };
  installChain({ hashOf: BLOCK_HASH, utxoAsks: [], utxos: new Map(), view: () => minedView(), relayInfo: () => ({}), onSubmit: () => reply(500, {}) });
  const root = new FakeEl();
  const off = LAUNCH.launchView(root, s, new URLSearchParams("kind=pow"));
  try {
    const page = String(root.innerHTML);
    assert.match(page, /Launch a mined token/);
    assert.match(page, /name="pow-reward"/);
    assert.match(page, /value="2000"[^>]*name="pow-hashrate"/);
    assert.match(page, /value="24"[^>]*name="pow-span"/);
    assert.ok(has(page, "Claim fee to you"));
    assert.ok(has(page, "fixed by the current rules"));
    assert.ok(has(page, SHARED.MINE_TEXT.noise) && has(page, SHARED.MINE_TEXT.burst));
    assert.ok(has(page, SHARED.MINE_TEXT.fee({ sats: 500n, recipient: SHARED.MINE_RECIPIENT })));
    assert.match(String(root.querySelector("[data-preview]").innerHTML), /DEPLOY_POW ENVELOPE/);
    // Exactly two start choices, the trade-off next to them, and the count field only for "after".
    assert.match(page, /data-name="pow-start" data-value="now"/);
    assert.ok(has(page, "Start mining now") && has(page, "Start after N blocks"));
    assert.equal((page.match(/class="seg-opt"[^>]*data-value="(now|after)"/g) ?? []).length, 2);
    assert.ok(has(page, LAUNCH.START_HINT));
    assert.match(page, /data-pow-after hidden/);
    assert.match(page, /name="pow-startAfter"/);
    assert.ok(!/at least 144 blocks|144 blocks after the launch/.test(page), "no mandatory lead in the copy");
    assert.equal(root.querySelector("[data-pow-after]").hidden, true);
    assert.match(String(root.querySelector("[data-eta=pow-start]").textContent), /Mining opens at the launch block itself \(block 330,001/);
    for (const fn of root.ls["seg-change"]) fn({ detail: { name: "pow-start", value: "after" } });
    assert.equal(root.querySelector("[data-pow-after]").hidden, false, "the count field shows for Start after N blocks");
    assert.match(String(root.querySelector("[data-eta=pow-start]").textContent), /First usable block 330,145, .*144 blocks after the next block/);
    for (const fn of root.ls.input) fn({ target: { name: "pow-startAfter", value: "12" } });
    assert.match(String(root.querySelector("[data-eta=pow-start]").textContent), /First usable block 330,013/);
    for (const fn of root.ls["seg-change"]) fn({ detail: { name: "pow-start", value: "now" } });
    assert.equal(root.querySelector("[data-pow-after]").hidden, true);
    // Typing a ticker makes the terms complete; the CTA names the mined launch.
    for (const fn of root.ls.input) fn({ target: { name: "ticker", value: "ORE" } });
    assert.match(String(root.querySelector("[data-cta]").innerHTML), /Launch mined token/);
    assert.match(String(root.querySelector("[data-pow-diff]").textContent), /Suggested initial difficulty 1,200,000 for 2,000 H\/s/);
    // Switching to Paid mint shows the old form, unchanged.
    for (const fn of root.ls["seg-change"]) fn({ detail: { name: "launch-kind", value: "mint" } });
    assert.match(String(root.innerHTML), /name="perMint"/);
    assert.ok(!/name="pow-reward"/.test(String(root.innerHTML)));
  } finally {
    off();
  }
});

test("token page: a kind \"pow\" asset renders the mined page (terms, difficulty, estimate, charts, flags, fairness), never a recipient", async () => {
  const TOKEN = await import("../web/src/views/token.js");
  const v = minedView({ flags: { lowFloor: true, recipientDiscount: true } });
  const feed = [
    { height: 329_999, txid: "12".repeat(32), ok: true, opName: "MINE", asset: v.asset, amount: "50", ref: 329_995, difficulty: "1150000" },
    { height: 329_998, txid: "13".repeat(32), ok: false, opName: "MINE_SCRIPT", asset: v.asset, amount: "50", ref: 329_990, reason: "insufficient work" },
  ];
  const page = String(TOKEN.minedPageHTML(v, { height: 330_000, feed, walletReady: true }));
  for (const text of ["ORE", "Mined", "Mining", "Reward now", "Next halving", "Difficulty now", "Stale floor", "Target per block", "an estimate from the work counted in the last 144 blocks", "DIFFICULTY PER BLOCK", "CLAIMS PER BLOCK", "Rejected claims", "Service fees paid", "Mining start", "Low floor", "Recipient mines cheaper", "LIVE CLAIMS", "insufficient work", "ref #329,995 · D 1,150,000"]) {
    assert.ok(has(page, text), text);
  }
  assert.ok(has(page, SHARED.MINE_TEXT.fee({ sats: 500n, recipient: SHARED.MINE_RECIPIENT })), "the recipient's discount is disclosed");
  assert.ok(has(page, SHARED.MINE_TEXT.gpu));
  // The start as the launch chose it: this one waited 144 blocks after its launch block.
  assert.ok(has(page, "144 blocks after the launch"));
  assert.ok(has(page, "Everyone could read the terms for 144 blocks before the first usable block."));
  const nowPage = String(TOKEN.minedPageHTML({ ...v, mineStart: 325_000 }, { height: 330_000, feed: [] }));
  assert.ok(has(nowPage, "the launch block itself"));
  assert.ok(has(nowPage, "Mining opened at the launch block itself. Nobody could know its hash before it was mined, but whoever was ready first had an edge."));
  assert.ok(!has(nowPage, "Everyone could read the terms for"));
  assert.equal(TOKEN.startLead({ mineStart: 325_001, deployHeight: 325_000 }), "1 block after the launch");
  assert.match(page, /href="\/app\/mine\?t=ORE"/);
  assert.match(page, /class="mine-line"/, "the difficulty chart is drawn");
  assert.ok(!/cannot see/i.test(page));
  assert.ok(!page.includes(MINE_FEE.platformAddress) || page.includes("platform"), "the platform is named, never a miner");
  const closed = String(TOKEN.minedPageHTML({ ...v, status: "mined-out" }, { height: 330_000, feed: [] }));
  assert.match(closed, /Mining is closed/);
  assert.match(closed, /Every reward under the cap is claimed\./);

  // The route itself: /api/assets/ORE says kind "pow", the page asks /api/mine/ORE.
  installChain({ hashOf: BLOCK_HASH, utxoAsks: [], utxos: new Map(), view: () => v, relayInfo: () => ({}), onSubmit: () => reply(500, {}) });
  net.routes.set(/^\/api\/assets\/ORE$/, () => reply(200, { id: v.asset, ticker: "ORE", kind: "pow" }));
  net.routes.set(/^\/api\/state$/, () => reply(200, { height: 330_000, startHeight: 324_592, root: "0", outputs: 0, nullifiers: 0 }));
  net.routes.set(/^\/api\/log$/, () => reply(200, { items: feed.slice().reverse(), next: null, total: 2 }));
  const root = new FakeEl();
  const off = TOKEN.render(root, { ticker: "ORE" });
  try {
    await settle(30);
    const out = String(root.innerHTML);
    assert.match(out, /mine-tk/);
    assert.ok(has(out, "Difficulty now"));
    assert.ok(net.calls.includes("GET /api/mine/ORE"));
  } finally {
    off?.();
  }
});

test("explorer: a claim shows token, reward, reference block and difficulty, never a recipient; DEPLOY_POW is a launch; a Mined filter", async () => {
  const EX = await import("../web/src/views/explorer.js");
  const assets = new Map([[ASSET.toString(), { ...minedView(), id: ASSET.toString() }]]);
  const claim = { opName: "MINE_SCRIPT", ok: true, asset: ASSET.toString(), ticker: "ORE", amount: "50", ref: 329_990, difficulty: "1200000", height: 330_000 };
  const cell = String(EX.exPublicData(claim, assets));
  assert.match(cell, /\+50/);
  assert.match(cell, /href="\/t\/ORE"/);
  assert.ok(has(cell, "ref #329,990 · D 1,200,000"));
  assert.match(cell, /redact/, "the recipient is a redaction bar");
  assert.equal(EX.exOp(claim), "MINE");
  const deploy = { opName: "DEPLOY_POW", ok: true, asset: ASSET.toString(), ticker: "ORE", height: 325_000 };
  assert.equal(EX.exOp(deploy), "DEPLOY");
  assert.ok(has(String(EX.exPublicData(deploy, assets)), "mined · 50 per claim · max 1,050,000"));
  assert.equal(EX.exMatches(claim, "mined"), true);
  assert.equal(EX.exMatches(claim, "mints"), false);
  assert.equal(EX.exMatches(deploy, "launches"), true);
  assert.equal(EX.exMatches({ ...claim, ok: false }, "rejected"), true);
  assert.equal(EX.exMatches({ opName: "MINT", ok: true }, "mined"), false);
  assert.ok(EX.EX_FILTERS.some((f) => f.value === "mined"));
});

test("auditRelayer: a MINE_SCRIPT carrier bound to the relayer, paying exactly the asset's service fee, is a \"mine\" row and ok", () => {
  const C = funding.btcAccount(new Uint8Array(32).fill(9));
  const body = encodeTxBody({
    op: OP.MINE_SCRIPT, anchor: 330_000, publicAsset: ASSET, publicAmount: 50n, bindScriptHash: sha256(C.script), nonce: new Uint8Array(NONCE_LEN),
    nullifiers: [1n, 2n], commitments: [3n, 4n], ciphertexts: [new Uint8Array(95), new Uint8Array(95)],
  });
  const envelope = new Uint8Array(body.length + 128);
  envelope.set(body);
  const op = { scriptpubkey: hex(opReturnScript(envelope)), scriptpubkey_type: "op_return", value: 0 };
  const fee = { scriptpubkey: PLATFORM, scriptpubkey_type: "v1_p2tr", scriptpubkey_address: MINE_FEE.platformAddress, value: 500 };
  const change = { scriptpubkey: hex(C.script), scriptpubkey_type: "v1_p2tr", scriptpubkey_address: C.address, value: 50_000 };
  const txOf = (id, vout) => ({ txid: id, fee: 1368, status: { confirmed: true, block_height: 330_001 }, vin: [{ prevout: { scriptpubkey_address: C.address } }], vout });
  const ledger = [{ txid: "a1".repeat(32), fee: 1368, kind: "carrier" }, { txid: "a2".repeat(32), fee: 1368 }, { txid: "a3".repeat(32), fee: 1368 }];
  const mineList = { assets: [minedView()] };
  const res = R.auditRelayer({
    address: C.address, ledger, mine: mineList,
    txs: [txOf("a1".repeat(32), [op, fee, change]), txOf("a2".repeat(32), [op, { ...fee, value: 400 }, change]), txOf("a3".repeat(32), [op, fee, { ...fee, scriptpubkey: hex(funding.btcAccount(new Uint8Array(32).fill(8)).script), scriptpubkey_address: "elsewhere" }, change])],
  });
  assert.deepEqual(res.rows.map((r) => [r.kind, r.ok]), [["mine", true], ["mine", false], ["mine", false]]);
  assert.match(res.rows[1].note, /service fee/);
  // Without the mined asset list the claim is flagged, not waved through.
  const bare = R.auditRelayer({ address: C.address, ledger, txs: [txOf("a1".repeat(32), [op, fee, change])] });
  assert.deepEqual(bare.rows.map((r) => [r.kind, r.ok]), [["mine", false]]);
  // A claim bound to someone else is not the relayer's: "other", flagged as before.
  const otherBody = encodeTxBody({ op: OP.MINE_SCRIPT, anchor: 330_000, publicAsset: ASSET, publicAmount: 50n, bindScriptHash: new Uint8Array(32).fill(1), nonce: new Uint8Array(8), nullifiers: [1n, 2n], commitments: [3n, 4n], ciphertexts: [new Uint8Array(95), new Uint8Array(95)] });
  const otherEnv = new Uint8Array(otherBody.length + 128);
  otherEnv.set(otherBody);
  const other = R.auditRelayer({ address: C.address, ledger, mine: mineList, txs: [txOf("a1".repeat(32), [{ ...op, scriptpubkey: hex(opReturnScript(otherEnv)) }, fee, change])] });
  assert.deepEqual(other.rows.map((r) => [r.kind, r.ok]), [["other", false]]);
});

test("line endings of the web track's files are kept (contract §1.2), and the new files are LF", () => {
  const raw = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "latin1");
  for (const f of ["web/src/session.js", "web/src/app.js", "web/src/views/app-launch.js", "web/src/views/explorer.js", "web/src/views/app-shared.js", "web/src/relay.js", "web/src/styles/pages.css"]) {
    const s = raw(f);
    assert.equal((s.match(/\r\n/g) ?? []).length, (s.match(/\n/g) ?? []).length, `${f} stays CRLF`);
  }
  for (const f of ["web/src/router.js", "web/src/views/token.js", "web/src/api.js", "web/src/views/app-activity.js", "web/src/mine-worker.js", "web/src/views/app-mine.js", "test/mine-web.test.mjs"]) {
    const s = raw(f);
    assert.ok(!s.includes("\r"), `${f} stays LF`);
    assert.ok(s.endsWith("\n"), `${f} ends with a newline`);
  }
});

/* ======================================================================================= */
/* fix round (mining review)                                                               */
/* ======================================================================================= */

/** A wallet that owns one ORE note at TIP0 (so each claim rolls it in), on the fake chain. */
async function walletWithNote(t, password, coins) {
  S.forgetWallet(); // one wallet per browser storage
  const s = await S.createWallet(S.newPhrase(), password);
  t.after(() => S.forgetWallet());
  s.wallet.artifacts = { wasm: WASM, zkey: ZKEY };
  const view0 = { startHeight: 324_592, tree: new MerkleTree(), outputs: [], nullifiers: new Set(), height: TIP0 - 1 };
  s.view = view0;
  const seed = s.prepareMine(minedView({ tipHeight: TIP0 - 1, tipHash: BLOCK_HASH(TIP0 - 1) }), { roll: false });
  const view = { ...view0, tree: new MerkleTree(), outputs: [], height: TIP0 };
  seed.commitments.forEach((c, i) => {
    view.tree.insert(c);
    view.outputs.push({ commitment: c, ciphertext: seed.ciphertexts[i], leafIndex: i, txid: "11".repeat(32), height: TIP0 });
  });
  s.view = view;
  s.wallet.scan(view);
  const chain = {
    tip: TIP0, utxoAsks: [], utxos: new Map([[s.minePayer.address, coins]]), hashOf: (h) => BLOCK_HASH(h),
    view: () => minedView({ tipHeight: chain.tip, tipHash: BLOCK_HASH(chain.tip) }),
    relayInfo: () => ({ enabled: false }),
    onSubmit: () => reply(500, {}),
  };
  installChain(chain);
  return { s, chain };
}
const solve = (d, nonce = "0900000000000000") => ({ draft: d, nonce, powHash: hex(mine.powHashReference(mine.passwordOf(d.challenge, unhex(nonce)))), referenceHash: async (p) => hex(mine.powHashReference(unhex(p))) });
const confirmedCoin = (txid, vout, value) => ({ txid, vout, value, status: { confirmed: true, block_height: TIP0 - 5 } });
/** Replaces the fake route with the same pattern (installChain's), so the new one answers. */
function setRoute(re, fn) {
  for (const k of [...net.routes.keys()]) if (k.source === re.source) net.routes.delete(k);
  net.routes.set(re, fn);
}

test("W-M after the hand-out: a broadcast with no answer (5xx) or a Unisat push error keeps the claim pending, its notes and coin locked, with the txid it computed; only a node refusal the explorer confirms frees them", async (t) => {
  const X = confirmedCoin("71".repeat(32), 0, 100_000);
  const { s, chain } = await walletWithNote(t, "correct horse battery staple 11", [X]);
  // 1. mempool.space answers 503 to POST /tx: the carrier may be in the mempool anyway.
  setRoute(/\/api\/tx$/, ({ init }) => {
    net.broadcasts.push(init.body);
    return reply(503, "upstream timeout");
  });
  const d1 = s.prepareMine(chain.view());
  assert.equal(d1.rolled.length, 1);
  s.holdDraft(d1);
  const err = await s.claimMine({ ...solve(d1), route: "key" }).catch((e) => e);
  assert.ok(err instanceof Error && err.entry, `the error carries the entry (${err?.code}: ${err?.message})`);
  const e1 = err.entry;
  const sent = btc.Transaction.fromRaw(Buffer.from(net.broadcasts.at(-1), "hex"), { allowUnknownOutputs: true });
  assert.equal(e1.status, "submitted", "pending, not dropped");
  assert.equal(e1.txid, sent.id, "the txid was recorded before the broadcast");
  assert.match(e1.reason, /may still have reached the network/);
  assert.deepEqual(e1.inputs, [`${X.txid}:${X.vout}`]);
  assert.ok(S.lockedNullifiers(s.history, TIP0 + 1, new Set()).has(d1.rolled[0]), "its rolled note stays locked");
  assert.ok(S.busyMineCoins(s.history).has(`${X.txid}:${X.vout}`), "its coin stays busy");
  const d2 = s.prepareMine(chain.view());
  assert.deepEqual(d2.rolled, [], "the next draft does not roll the same note");
  // Its verdict is followed by the txid it computed: the carrier did land.
  s.view = { ...s.view, outputs: [...s.view.outputs, ...[0, 1].map((o) => ({ commitment: d1.commitments[o], ciphertext: d1.ciphertexts[o], leafIndex: 2 + o, txid: sent.id, height: TIP0 + 1 }))], height: TIP0 + 1 };
  await s.refreshHistory();
  assert.equal(e1.status, "landed");

  // 2. The node refused it (400) and the explorer does not know the txid: dropped, everything free.
  const v2 = await walletWithNote(t, "correct horse battery staple 12", [confirmedCoin("72".repeat(32), 1, 100_000)]);
  setRoute(/\/api\/tx$/, ({ init }) => {
    net.broadcasts.push(init.body);
    return reply(400, "sendrawtransaction RPC error: bad-txns-inputs-missingorspent");
  });
  setRoute(/\/api\/tx\/([0-9a-f]{64})$/, () => reply(404, "Transaction not found"));
  const d3 = v2.s.prepareMine(v2.chain.view());
  v2.s.holdDraft(d3);
  const err2 = await v2.s.claimMine({ ...solve(d3), route: "key" }).catch((e) => e);
  assert.equal(err2.entry.status, "dropped");
  assert.equal(S.lockedNullifiers(v2.s.history, TIP0 + 1, new Set()).size, 0, "a certain refusal frees the notes");
  assert.equal(S.busyMineCoins(v2.s.history).size, 0);

  // 3. A 400 while the explorer knows the txid (it is in the mempool after all): pending.
  const v3 = await walletWithNote(t, "correct horse battery staple 13", [confirmedCoin("73".repeat(32), 0, 100_000)]);
  setRoute(/\/api\/tx$/, ({ init }) => {
    net.broadcasts.push(init.body);
    return reply(400, "sendrawtransaction RPC error: txn-mempool-conflict");
  });
  setRoute(/\/api\/tx\/([0-9a-f]{64})$/, ({ m }) => reply(200, { txid: m[1], status: { confirmed: false } }));
  const d4 = v3.s.prepareMine(v3.chain.view());
  v3.s.holdDraft(d4);
  const err3 = await v3.s.claimMine({ ...solve(d4), route: "key" }).catch((e) => e);
  assert.equal(err3.entry.status, "submitted");
  assert.ok(S.lockedNullifiers(v3.s.history, TIP0 + 1, new Set()).has(d4.rolled[0]));

  // 4. Unisat signed, then its push failed: no txid to follow, still pending until ref + 12.
  const v4 = await walletWithNote(t, "correct horse battery staple 14", []);
  const uniScript = funding.btcAccount(new Uint8Array(32).fill(9)).script;
  v4.s.unisat = {
    kind: "unisat", address: funding.addressOf(uniScript), account: { script: uniScript }, checkAccount: async () => {},
    carry: async () => {
      throw new Error("Unisat could not push the transaction: network error");
    },
  };
  const d5 = v4.s.prepareMine(v4.chain.view());
  v4.s.holdDraft(d5);
  const err4 = await v4.s.claimMine({ ...solve(d5), route: "unisat" }).catch((e) => e);
  assert.equal(err4.entry.status, "submitted");
  assert.match(err4.entry.reason, /may still have reached the network/);
  assert.ok(S.lockedNullifiers(v4.s.history, TIP0 + 12, new Set()).has(d5.rolled[0]), "locked through ref + 12");
  assert.equal(S.lockedNullifiers(v4.s.history, TIP0 + 13, new Set()).size, 0, "free after the window");
  // A user cancel in Unisat is not a hand-out: no entry at all.
  v4.s.unisat.carry = async () => {
    throw Object.assign(new Error("User rejected the request."), { code: 4001 });
  };
  const d6 = v4.s.prepareMine(v4.chain.view());
  v4.s.holdDraft(d6);
  const err5 = await v4.s.claimMine({ ...solve(d6, "0a00000000000000"), route: "unisat" }).catch((e) => e);
  assert.equal(err5.entry, undefined);
  assert.equal(v4.s.history.filter((h) => h.kind === "mine").length, 1);
});

test("self-paid claims pay fee outputs only within the pinned fee policy: an indexer that asks for a launcher fee is refused before anything is paid", async (t) => {
  const attacker = hex(funding.btcAccount(new Uint8Array(32).fill(3)).script);
  // The pure helper.
  assert.deepEqual(S.mineFeeOutputs({ claimFeeSats: "0", treasury: attacker }).map((o) => [hex(o.script), o.amount]), [[PLATFORM, 500n]], "the treasury of a 0-fee token is never paid");
  assert.throws(() => S.mineFeeOutputs({ claimFeeSats: "500000", treasury: attacker }), (e) => e.code === "fee_policy" && /forbids/.test(e.message));
  assert.throws(() => S.mineFeeOutputs({ claimFeeSats: "zz" }), (e) => e.code === "fee_policy");
  // A policy that allows a launcher fee (a later network): within it, the treasury is paid first.
  const open = { ...MINE_FEE, deployerMaxSats: 10_000n };
  assert.deepEqual(S.mineFeeOutputs({ claimFeeSats: "1000", treasury: attacker }, open).map((o) => [hex(o.script), o.amount]), [[attacker, 1000n], [PLATFORM, 500n]]);
  assert.throws(() => S.mineFeeOutputs({ claimFeeSats: "500000", treasury: attacker }, open), (e) => e.code === "fee_policy");

  // In a claim: refused at the fee step, no entry, no coin looked up, nothing broadcast.
  const { s, chain } = await walletWithNote(t, "correct horse battery staple 15", [confirmedCoin("74".repeat(32), 0, 1_000_000)]);
  chain.view = () => minedView({ tipHeight: chain.tip, tipHash: BLOCK_HASH(chain.tip), claimFeeSats: "500000", treasury: attacker });
  const before = net.broadcasts.length;
  const d = s.prepareMine(chain.view());
  s.holdDraft(d);
  const err = await s.claimMine({ ...solve(d), route: "key" }).catch((e) => e);
  assert.equal(err.code, "fee_policy");
  assert.equal(s.history.filter((h) => h.kind === "mine").length, 0);
  assert.equal(net.broadcasts.length, before);
  assert.deepEqual(chain.utxoAsks, [], "no coin was even looked up");
  // The page then offers the Claim button again (nothing was handed out).
  assert.equal(MINEVIEW.onClaimError(err, null).status, "found");
});

test("a self-paid claim never funds itself with a coin another pending claim holds; Prepare coins sizes each coin for one claim at the claim rate", async (t) => {
  const X = confirmedCoin("75".repeat(32), 0, 100_000); // bound to a claim still proving
  const Y = confirmedCoin("76".repeat(32), 0, 1_000); // too small alone
  const Z = confirmedCoin("77".repeat(32), 2, 50_000);
  const { s, chain } = await walletWithNote(t, "correct horse battery staple 16", [X, Y, Z]);
  s.history.push({ kind: "mine", id: "other", via: "self", status: "proving", ref: TIP0, lockUntil: TIP0 + 12, spends: [], commitments: [], coin: `${X.txid}:${X.vout}`, at: Date.now() });
  const d = s.prepareMine(chain.view());
  s.holdDraft(d);
  const entry = await s.claimMine({ ...solve(d), route: "key" });
  const tx = btc.Transaction.fromRaw(Buffer.from(net.broadcasts.at(-1), "hex"), { allowUnknownOutputs: true });
  const ins = [];
  for (let i = 0; i < tx.inputsLength; i++) ins.push(`${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`);
  assert.ok(!ins.includes(`${X.txid}:${X.vout}`), "the busy coin is never spent");
  assert.notEqual(entry.coin, `${X.txid}:${X.vout}`);
  assert.deepEqual(entry.inputs, ins, "the coins it spent are recorded");
  for (const c of ins) assert.ok(S.busyMineCoins(s.history).has(c));

  // Prepare coins: fastestFee 2 (claims pay ceil(2 x 1.25) = 3 sat/vB), halfHourFee 1 (the split itself).
  const v = await walletWithNote(t, "correct horse battery staple 17", [confirmedCoin("78".repeat(32), 0, 100_000)]);
  const r = await v.s.prepareCoins(3);
  assert.equal(r.value, 684n * 3n + 500n + 330n, "one claim carrier at the claim rate, the service fee and the change dust");
  const split = btc.Transaction.fromRaw(Buffer.from(net.broadcasts.at(-1), "hex"), { allowUnknownOutputs: true });
  const values = [];
  for (let i = 0; i < split.outputsLength; i++) values.push(split.getOutput(i).amount);
  assert.equal(values.filter((x) => x === 2882n).length, 3);
  assert.ok(2882n >= S.mineQuote({ route: "key", feeRate: 2, serviceSats: 500n }).total, "a prepared coin pays one claim on its own");
});

test("the in-flight cap in the wallet counts pendingReward (each claim at its own reward) when the indexer reports it", async (t) => {
  const { s, chain } = await walletWithNote(t, "correct horse battery staple 18", [confirmedCoin("79".repeat(32), 0, 100_000)]);
  // 1,000 issued of 1,100; one claim in flight from before a halving (100), this one 50: 1,150 > 1,100.
  chain.view = () => minedView({ tipHeight: chain.tip, tipHash: BLOCK_HASH(chain.tip), issued: "1000", maxSupply: "1100", pendingClaims: 1, pendingReward: "100" });
  const d = s.prepareMine(chain.view());
  s.holdDraft(d);
  const err = await s.claimMine({ ...solve(d), route: "key" }).catch((e) => e);
  assert.equal(err.code, "cap_reached", "count x reward (2 x 50 = 100) would have let it through");
  assert.equal(MINEVIEW.onClaimError(err, null).status, "failed", "final");
  // nearCap uses the same sum.
  assert.equal(MINEVIEW.nearCap({ ...chain.view(), series: { claims: [] } }), true);
  assert.equal(MINEVIEW.nearCap({ ...chain.view(), maxSupply: "100000", series: { claims: [] } }), false);
});

test("relayer statuses after a broadcast say the claim was charged; only claims that never reached the network say nothing was charged", () => {
  const r = { kind: "mine", id: "m", via: "relay", relayId: "r1", ref: 100, lockUntil: 112, spends: [], commitments: ["1"], status: "submitted" };
  const ctx = { height: 105, outputs: new Map(), log: new Map() };
  const vanished = S.deriveMineStatus(r, { ...ctx, relay: { status: "dropped", reason: "the carrier's input was spent elsewhere", broadcastHeight: 101, cost: 2105 } });
  assert.equal(vanished.status, "dropped");
  assert.match(vanished.reason, /charged 2,105 sats, but it did not land/);
  assert.doesNotMatch(vanished.reason, /nothing was charged/);
  const expired = S.deriveMineStatus(r, { ...ctx, relay: { status: "expired", broadcastHeight: 102, cost: 2105 } });
  assert.match(expired.reason, /charged 2,105 sats/);
  const missed = S.deriveMineStatus(r, { ...ctx, relay: { status: "missed", code: "balance_low", reason: "your relay balance did not cover the fee when it was due; nothing was charged" } });
  assert.match(missed.reason, /nothing was charged/);
  const dropped = S.deriveMineStatus(r, { ...ctx, relay: { status: "dropped", reason: "the carrier could not be broadcast" } });
  assert.match(dropped.reason, /before paying for it, so nothing was charged/);
});

test("the page: a refusal before the hand-out keeps the solution claimable (another route, a retry); final refusals do not; a wallet sync before the view reloads it instead of pausing the workers", () => {
  for (const code of ["balance_low", "relay_off", "no_coins", "unisat", "indexer", "notes_taken", "fee_policy", undefined]) {
    const r = MINEVIEW.onClaimError(Object.assign(new Error("Some refusal."), code ? { code } : {}), null);
    assert.equal(r.status, "found", String(code));
    assert.match(r.message, /Nothing was paid: claim again, or pick another route\./);
  }
  for (const code of ["insufficient", "cap_reached", "closed", "solution_taken", "expired"]) assert.equal(MINEVIEW.onClaimError(Object.assign(new Error("x"), { code }), null).status, "failed", code);
  // Handed out (a W-M entry exists): never offered again.
  assert.equal(MINEVIEW.onClaimError(Object.assign(new Error("x"), { code: "balance_low", entry: { id: "e" } }), null).status, "failed");
  assert.equal(MINEVIEW.syncAction(330_001, 330_000), "reload", "the wallet is ahead of the view: reload it, keep the workers on the old challenge");
  assert.equal(MINEVIEW.syncAction(330_001, 330_001), "restart");
  assert.equal(MINEVIEW.syncAction(null, 330_001), "reload");
});

test("hashrate: right after Start it is not diluted over 10 s, and a stopped or restarted search reports the hashes it computed", async () => {
  // The worker: a slice in flight when the search is restarted is still reported, with the old id.
  const out = [];
  let release;
  const slow = {
    selfTest: async () => ({ ok: true, impl: "hash-wasm" }),
    counterOf: mine.counterOf,
    grindRange: ({ count }) => new Promise((res) => (release = () => res({ nonce: null, powHash: null, tried: count }))),
    powHashReference: (pw) => sha256(pw),
    disableFastPath() {},
  };
  let clock = 0;
  const w = WORKER.createMiner({ mine: slow, post: (x) => out.push(x), now: () => (clock += 100), yieldNow: tick, slice: 8 });
  await w.ready;
  const a = w.onMessage({ type: "start", id: 1, challenge: "11".repeat(32), target: "00".repeat(32), nonceStart: "0000000000000000", progressMs: 60_000 });
  await settle(4);
  const first = release;
  const b = w.onMessage({ type: "start", id: 2, challenge: "22".repeat(32), target: "00".repeat(32), nonceStart: "0000000000000000", progressMs: 60_000 });
  first();
  await a;
  await settle(4);
  assert.deepEqual(out.filter((x) => x.type === "progress").map((p) => [p.id, p.hashes]), [[1, 8]], "the replaced search's last slice is counted");
  w.onMessage({ type: "stop" });
  release();
  await b;
  assert.deepEqual(out.filter((x) => x.type === "progress").map((p) => [p.id, p.hashes]), [[1, 8], [2, 8]], "a stop reports the last slice too");

  // The controller counts reports of its earlier challenges, and divides by the time covered.
  const { all, spawn } = fakeWorkers();
  let now = 50_000;
  const ctl = new MINEVIEW.MineController({ spawn, prepare: async () => ({ draft: {}, challenge: "11".repeat(32), target: "ff".repeat(32) }), now: () => now });
  await ctl.start(2);
  const id1 = all[0].posts.find((m) => m.type === "start").id;
  now += 2000;
  for (const x of all) x.emit({ type: "progress", hashes: 500, ms: 1000, id: id1 });
  assert.equal(ctl.hashrate(), 500, "1,000 hashes in the 2 s since Start");
  await ctl.restart();
  for (const x of all) x.emit({ type: "progress", hashes: 100, ms: 200, id: id1 }); // flushed by the restart
  assert.equal(ctl.hashrate(), 600);
  now += 20_000;
  assert.equal(ctl.hashrate(), 0);
  ctl.terminate();
});

test("launch form: an end block that a slightly late launch would make invalid is refused, and the confirm-by block is stated", () => {
  const base = { ...LAUNCH.POW_FORM_DEFAULTS, ticker: "ORE", reward: "50", maxSupply: "1050000" };
  const at = { height: 330_000 };
  // Starting now, the launch lands at 330,001 at the earliest and must confirm by the end block; the form leaves END_MARGIN blocks of delay.
  assert.match(LAUNCH.buildPowTerms({ ...base, end: "330001" }, at).errors.end, /Set the end at block 330,007 or later\. The launch must confirm by block 330,001 \(the end block\), or it is rejected and its fee is spent\./);
  assert.match(LAUNCH.buildPowTerms({ ...base, end: "330000" }, at).errors.end, /before mining starts \(block 330,001\)/);
  assert.match(LAUNCH.buildPowTerms({ ...base, end: "330006" }, at).errors.end, /330,007 or later/);
  const ok = LAUNCH.buildPowTerms({ ...base, end: "330007" }, at);
  assert.equal(ok.errors.end, undefined);
  assert.equal(ok.confirmBy, 330_007);
  assert.equal(LAUNCH.confirmByText(330_151), "The launch must confirm by block 330,151 (the end block), or it is rejected and its fee is spent.");
  assert.equal(LAUNCH.buildPowTerms({ ...base }, at).confirmBy, null, "no end, no deadline");
  assert.equal(LAUNCH.END_MARGIN, 6);
  for (const re of NEVER) assert.doesNotMatch(LAUNCH.confirmByText(330_151), re);
  // The review sheet and the end field's caption both carry it.
  const src2 = src("web/src/views/app-launch.js");
  assert.match(src2, /r\.confirmBy !== null \? callout\(confirmByText\(r\.endHeight\), "warn"\)/);
  assert.match(src2, /end > 0 \? confirmByText\(end\)/);
  assert.doesNotMatch(src2, /MINE_LEAD/);
});

test("mined token page: the privacy line discloses that self-paid claims show the paying address", async () => {
  const TOKEN = await import("../web/src/views/token.js");
  assert.equal(TOKEN.MINED_PRIVACY_TEXT, "A claim is a public Bitcoin transaction that shows the token, the reward and how it was paid. The reward goes to a private note. Self-paid claims show the paying address, so anyone can add up what that address mined; relayed claims show only the relayer.");
  const page = String(TOKEN.minedPageHTML(minedView(), { height: 330_000, feed: [] }));
  assert.ok(has(page, TOKEN.MINED_PRIVACY_TEXT));
  assert.doesNotMatch(page, /nobody can see who received it/);
});

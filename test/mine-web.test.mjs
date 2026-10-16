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
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";

// Public pages import their CSS; under node it is an empty module. The landing imports facts.json without
// an import attribute (Vite allows it): served as a module here, for web/src files only.
register(
  "data:text/javascript," +
    encodeURIComponent(`import { readFileSync } from "node:fs"; import { fileURLToPath } from "node:url"; export async function load(url, ctx, next) { if (url.endsWith(".css")) return { format: "module", source: "", shortCircuit: true }; if (url.endsWith(".json") && url.includes("/web/src/") && ctx.importAttributes?.type !== "json") return { format: "module", source: "export default " + readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true }; return next(url, ctx); }`),
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

test("capWarning: at most 10 claims left, or at most 3 times the average claims per block over 144 blocks; claims in flight count", () => {
  const left = (n, over = {}) => minedView({ issued: String(1_050_000 - 50 * n), ...over }); // reward 50
  assert.equal(MINEVIEW.capWarning(null), null);
  assert.equal(MINEVIEW.capWarning(minedView()), null, "plenty left");
  // Always at 10 claims or fewer, however quiet.
  const ten = MINEVIEW.capWarning(left(10));
  assert.equal(ten, "Only 10 ORE claims are left under the supply cap. Claims beyond the cap in the same block are not credited, and their Bitcoin fee and service fee are lost.");
  assert.match(MINEVIEW.capWarning(left(1)), /^Only 1 ORE claim is left under the supply cap\./);
  assert.equal(MINEVIEW.capWarning(left(11)), null, "11 left and a quiet chain: no warning");
  // Busy blocks: the series is the last 144 blocks, mining began long ago, so the average is claims / 144.
  const busy = (perBlock) => ({ series: { claims: [[330_000 - 1, perBlock * 144]] } });
  assert.match(MINEVIEW.capWarning(left(120, busy(40))), /^Only 120 ORE claims are left under the supply cap, and recent blocks carried about 40 claims each\. /, "120 <= 3 x 40");
  assert.equal(MINEVIEW.capWarning(left(121, busy(40))), null, "121 > 3 x 40");
  assert.equal(MINEVIEW.capWarning(left(100, busy(30))), null, "100 > 3 x 30");
  assert.notEqual(MINEVIEW.capWarning(left(90, busy(30))), null, "90 <= 3 x 30");
  // Claims older than 144 blocks are not counted.
  assert.equal(MINEVIEW.capWarning(left(100, { series: { claims: [[330_000 - 200, 99_999]] } })), null);
  // Mining began 5 blocks ago: the average is over those 5 blocks.
  assert.notEqual(MINEVIEW.capWarning(left(100, { mineStart: 329_996, series: { claims: [[329_999, 200]] } })), null, "200 claims in 5 blocks = 40 per block");
  // Claims in flight leave fewer: 15 left less 6 in flight is 9.
  assert.match(MINEVIEW.capWarning(left(15, { pendingClaims: 6 })), /^Only 9 ORE claims are left/);
  assert.match(MINEVIEW.capWarning(left(15, { pendingReward: "300" })), /^Only 9 ORE claims are left/, "pendingReward wins");
  // The page gates the claim on it, before anything is checked or paid.
  const page = src("web/src/views/app-mine.js");
  const claimFn = page.slice(page.indexOf("async function claim(sol) {"), page.indexOf("/* ----- data ----- */"));
  assert.ok(claimFn.indexOf("capWarning(view)") > 0 && claimFn.indexOf("capWarning(view)") < claimFn.indexOf("s.claimMine("), "the warning comes before the claim");
  assert.match(claimFn, /sol\.capSeen = true;[^]*return paint\(\);/, "automatic claiming stops at the warning; the second click goes on");
  assert.match(page, /"Claim anyway"/);
});

test("the mined token page hides the stale floor on a network without a stale bound (staleFactor null)", async () => {
  const TOKEN = await import("../web/src/views/token.js");
  const page = (over) => String(TOKEN.minedPageHTML(minedView(over), { height: 330_000, feed: [] }));
  assert.ok(has(page({}), "Stale floor"), "signet: the floor is shown");
  assert.ok(has(page({}), "difficulty now / 4: older work must meet at least this"));
  const main = page({ staleFactor: null, staleFloor: null });
  assert.ok(!has(main, "Stale floor"), "mainnet: D_eff is D(ref), there is no floor to show");
  assert.ok(has(main, "Difficulty now"));
});

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

/* ======================================================================================= */
/* public mining pages: /mine, the landing's Mine block, /mints, the wallet gate           */
/* ======================================================================================= */

// A FakeEl whose children are FakeEls with closest() and replaceWith(): enough for the landing, the create and restore pages.
class DeepEl extends FakeEl {
  querySelector(s) {
    if (!this.sel.has(s)) this.sel.set(s, new DeepEl());
    return this.sel.get(s);
  }
  closest() {
    return new DeepEl();
  }
  replaceWith(node) {
    this.replacedWith = String(node?.markup ?? "");
  }
}

const int_ = (n) => BigInt(n).toLocaleString("en-US");

/** MURK as /api/mine reports it on mainnet: 1,000 per claim, 21,000,000 in all, one claim so far. */
const murk = (over = {}) =>
  minedView({
    asset: "4171813403754743", ticker: "MURK", divisibility: 8, status: "mining", deployHeight: 971_326, mineStart: 971_326, reward: "100000000000", baseReward: "100000000000",
    difficulty: "3600000", initialDifficulty: "3600000", minDifficulty: "3600000", issued: "100000000000", maxSupply: "2100000000000000", claims: 1, rejectedClaims: 0, claims144: 0,
    ...over,
  });
const mineRoutes = (assets, { rate = 3, fail = false } = {}) => {
  net.routes.clear();
  net.routes.set(/^\/api\/mine$/, () => (fail ? reply(500, { error: { code: "internal", message: "boom" } }) : reply(200, { activation: { height: 971_317, active: true }, tip: { height: 971_582, hash: "00".repeat(32) }, assets })));
  net.routes.set(/^\/api\/assets$/, () => reply(200, []));
  net.routes.set(/^\/api\/state$/, () => reply(200, { height: 971_582, startHeight: 971_317, root: "0", outputs: 0, nullifiers: 0 }));
  net.routes.set(/\/v1\/fees\/recommended$/, () => reply(200, { fastestFee: rate, halfHourFee: rate }));
};
/** The indexer client caches /api/mine for 15 s: ask fresh once so the page under test reads these routes. */
const freshMine = () => api.mine({ fresh: true });
const withUrl = async (pathname, search, fn) => {
  const before = [url.pathname, url.search];
  url.pathname = pathname;
  url.search = search;
  try {
    return await fn();
  } finally {
    [url.pathname, url.search] = before;
  }
};

test("public mined-token helpers: claims of the total, the featured token, the cost of a claim, the speed note", async () => {
  const M = await import("../web/src/share/mined.js");
  const m = murk();
  assert.equal(M.claimsTotal(m), 21_000);
  assert.equal(M.claimsText(m), "1 of 21,000");
  assert.equal(M.claimsText({ ...m, halvingInterval: 100, claims: 3 }), "3", "with halvings the total moves: only the count is shown");
  assert.equal(M.rewardText(m), "1,000 MURK");
  assert.equal(M.supplyText(m), "1,000 of 21,000,000 MURK");
  assert.equal(M.issuedShareText(m), "under 0.1%");
  assert.equal(M.issuedShareText({ ...m, issued: "1050000000000000" }), "50%");
  assert.equal(M.mineHref("MURK"), "/app/mine?t=MURK");
  assert.equal(M.mineHref("A B"), "/app/mine?t=A%20B");
  // Featured: an open token over one opening soon, then the most claims, then the newest.
  const a = murk({ ticker: "AAA", asset: "1", claims: 5, deployHeight: 10 });
  const b = murk({ ticker: "BBB", asset: "2", claims: 9, deployHeight: 20 });
  const c = murk({ ticker: "CCC", asset: "3", claims: 99, status: "mining-soon" });
  const d = murk({ ticker: "DDD", asset: "4", claims: 500, status: "mined-out" });
  assert.equal(M.featuredMined([a, b, c, d]).ticker, "BBB");
  assert.equal(M.featuredMined([murk({ ticker: "NEW", asset: "5", claims: 9, deployHeight: 30 }), b]).ticker, "NEW", "the newest wins a tie on claims");
  assert.equal(M.featuredMined([c, d]).ticker, "CCC", "a token opening soon is featured when none is open");
  assert.equal(M.featuredMined([d]), null, "a mined-out token is not put forward");
  assert.equal(M.featuredMined([]), null);
  assert.deepEqual(M.rankMined([d, c, a, b]).map((x) => x.ticker), ["BBB", "AAA", "CCC", "DDD"]);
  assert.equal(M.minedClaims([a, b, d]), 514);
  // The cost of a claim: 684 vB at the rate, plus the service fee from the app's own params.
  assert.equal(M.CLAIM_VSIZE, S.MINE_EST_VSIZE, "the page prices a claim with the wallet's size");
  assert.equal(M.serviceSats(), MINE_FEE.platformSats);
  const est = M.feeEstimate({ rate: 5 });
  assert.equal(est.networkSats, 684n * 5n);
  assert.equal(est.serviceSats, MINE_FEE.platformSats);
  assert.equal(est.totalSats, 684n * 5n + MINE_FEE.platformSats);
  assert.equal(M.feeEstimate({ rate: 4.2 }).rate, 5, "a fractional rate rounds up");
  assert.equal(M.feeEstimate({ rate: null }), null);
  assert.equal(M.feeEstimate({ rate: 0 }), null);
  // Speed: difficulty / hash rate, a desktop tab at about 1,000 H/s; no word about limits.
  assert.equal(M.durationText(3600), "about 1 hour");
  assert.equal(M.durationText(7200), "about 2 hours");
  assert.equal(M.durationText(600), "about 10 minutes");
  assert.equal(M.durationText(20), "about 20 seconds");
  const note = M.speedNote(m);
  assert.match(note, /Expected time per solution = difficulty \/ hash rate\./);
  assert.match(note, /difficulty 3,600,000, a desktop browser tab \(about 1,000 hashes per second\) needs about 1 hour per solution/);
  assert.match(note, /GPUs and servers are faster/);
  assert.match(note, /difficulty adjusts to the work/);
  assert.doesNotMatch(note, /limit|per day|per block/i);
  assert.match(M.speedNote(null), /^Expected time per solution/);
});

test("fetchMined reads /api/mine; mined rows keep the paid-mint card layout with a Mine button", async () => {
  const M = await import("../web/src/share/mined.js");
  mineRoutes([murk(), { ...murk(), ticker: "" }]);
  const list = await M.fetchMined({ fresh: true });
  assert.deepEqual(list.map((x) => x.ticker), ["MURK"], "a row without a ticker is dropped");
  const card = String(M.minedCard(murk(), { walletReady: false }));
  for (const text of ["MURK", "MINING", "Reward", "Difficulty", "Claims", "1 of 21,000", "Mine MURK", "1,000 of 21,000,000 MURK"]) assert.ok(has(card, text), text);
  assert.match(card, /href="\/t\/MURK"/);
  assert.match(card, /href="\/app\/mine\?t=MURK"/);
  const soon = String(M.minedCard(murk({ status: "mining-soon", mineStart: 971_999 }), {}));
  assert.ok(!soon.includes("/app/mine"), "no Mine button before the token opens");
  assert.ok(has(soon, "Mining opens at #971,999."));
  assert.ok(has(String(M.minedCard(murk({ status: "mined-out" }), {})), "Every reward under the cap is claimed."));
});

test("/mine is routed and in the top nav between Mints and Explorer, in the phone tab bar and the footer", () => {
  const app = src("web/src/app.js");
  assert.match(app, /\["\/mints", "mints", "public", "Mints"\],\n {2}\["\/mine", "mine", "public", "Mine"\],\n {2}\["\/t\/:ticker", "token", "public", "Token"\],/);
  assert.match(app, /const NAV = \[\n {2}\["\/mints", "Mints"\],\n {2}\["\/mine", "Mine"\],\n {2}\["\/explorer", "Explorer"\],/);
  // Phone, public bar: Mints, Mine, Wallet (centre), Explorer, More: five tabs, two each side of the centre. Verify moves into More.
  assert.match(app, /tab\("\/mints", "coins", "Mints"\)\}\$\{tab\("\/mine", "pick", "Mine"\)\}\$\{tab\("\/app", "wallet", "Wallet", false, true\)\}\$\{tab\("\/explorer", "block", "Explorer"\)\}\$\{more\}/);
  assert.match(app, /\[link\("\/verify", "proof", "Verify"\), link\("\/security", "seal", "Security"\)/);
  assert.match(app, /\["\/mine", "Mine"\], \["\/explorer", "Explorer"\], \["\/app", "Wallet"\]/);
  // The wallet's own bar and rail are unchanged: Mine stays next to Mint there.
  assert.match(app, /tab\("\/app\/mint", "mint", "Mint"\)\}\$\{tab\("\/app\/mine", "block", "Mine"\)\}/);
  assert.deepEqual(matchPath("/mine", "/mine"), {});
  assert.equal(matchPath("/mine", "/app/mine"), null);
  assert.match(src("web/src/ui/icons.js"), /\n {2}pick: `/, "the pickaxe icon exists");
});

test("/mine page: hero, the featured token with live numbers, the other tokens, four steps, the cost of a claim and the speed note", async () => {
  const MINE = await import("../web/src/views/mine.js");
  const other = murk({ ticker: "ORE", asset: "7", claims: 0, issued: "0", maxSupply: "1000", divisibility: 0, reward: "50", baseReward: "50", difficulty: "1200000", deployHeight: 900_000 });
  mineRoutes([other, murk()], { rate: 4 });
  await freshMine();
  const root = new FakeEl();
  const off = MINE.render(root, {}, new URLSearchParams());
  try {
    await settle(30);
    const page = String(root.innerHTML);
    for (const text of ["Mine tokens", "in your browser.", "Start mining", "How it works", "Four steps", "COST OF ONE CLAIM", "Bitcoin network fee", "Service fee to the platform", "HOW FAST"]) assert.ok(has(page, text), text);
    for (const [, title, text] of MINE.HOW_STEPS) assert.ok(has(page, title) && has(page, text), title);
    assert.deepEqual(MINE.HOW_STEPS.map((x) => x[1]), ["Open a wallet", "Fund the mining address", "Press Mine and leave the tab open", "Each solution is a claim"]);
    assert.ok(has(page, "A claim is a Bitcoin transaction you pay. The token's reward lands in your wallet as a private note."));
    // The featured token: MURK (the most claims among the open ones), with its live numbers.
    const card = String(root.querySelector("[data-featured-slot]").innerHTML);
    assert.match(card, /data-ticker="MURK"/);
    for (const text of ["MURK", "1 of 21,000", "claims mined", "1,000 of 21,000,000 MURK issued", "Reward per claim", "1,000 MURK", "Difficulty", "3,600,000", "Status", "Mining now", "Deployed at block", "#971,326", "MINING", "Start mining"]) assert.ok(has(card, text), text);
    assert.match(card, /href="\/app\/mine\?t=MURK"/, "Start mining preselects the ticker");
    assert.match(card, /role="progressbar"[^>]*aria-valuemax="21000000"[^>]*aria-valuenow="1000"/);
    // The other mined token is listed with its own Mine button.
    const others = String(root.querySelector("[data-others-grid]").innerHTML);
    assert.match(others, /data-ticker="ORE"/);
    assert.match(others, /href="\/app\/mine\?t=ORE"/);
    assert.equal(root.querySelector("[data-others]").hidden, false);
    // The cost: about 680 vB at the page's rate (684 x 4), plus the service fee read from the params.
    const cost = String(root.querySelector("[data-cost]").innerHTML);
    assert.ok(has(cost, `~${int_(684 * 4)} sats`), "network fee at the fetched rate");
    assert.ok(has(cost, `${int_(MINE_FEE.platformSats)} sats`), "the service fee comes from MINE_FEE");
    assert.ok(has(cost, `~${int_(684n * 4n + MINE_FEE.platformSats)} sats`), "the total");
    assert.ok(has(cost, "about 680 vB at 4 sat/vB"));
    const speed = String(root.querySelector("[data-speed-slot]").innerHTML);
    assert.ok(has(speed, "Expected time per solution = difficulty / hash rate."));
    assert.ok(has(speed, "needs about 1 hour per solution"));
    assert.ok(net.calls.includes("GET /api/mine"));
  } finally {
    off?.();
  }
  // No wallet bundle is needed to read the page.
  const imports = src("web/src/views/mine.js").split("\n").filter((l) => l.startsWith("import") || l.startsWith("} from")).join("\n");
  assert.ok(!/session\.js|app-shared\.js|app-mine\.js/.test(imports), imports);
});

test("/mine page: empty state without a mined token, a soon token is not mineable, and a list that fails says so", async () => {
  const MINE = await import("../web/src/views/mine.js");
  mineRoutes([]);
  await freshMine();
  let root = new FakeEl();
  let off = MINE.render(root, {}, new URLSearchParams());
  try {
    await settle(30);
    const slot = String(root.querySelector("[data-featured-slot]").innerHTML);
    assert.ok(has(slot, "No token is being mined on this network right now."));
    assert.match(slot, /href="\/app\/launch\?kind=pow"/);
    assert.equal(root.querySelector("[data-others]").hidden, true);
    assert.ok(!slot.includes("Start mining"));
  } finally {
    off?.();
  }
  mineRoutes([murk({ status: "mining-soon", mineStart: 972_500 })]);
  await freshMine();
  root = new FakeEl();
  off = MINE.render(root, {}, new URLSearchParams());
  try {
    await settle(30);
    const slot = String(root.querySelector("[data-featured-slot]").innerHTML);
    assert.ok(has(slot, "Mining opens soon") && has(slot, "Mining opens at #972,500."));
    assert.ok(!slot.includes('href="/app/mine?t=MURK"'), "no Start mining link before it opens");
  } finally {
    off?.();
  }
  // A failing list (the client's 15 s cache aged out first).
  mineRoutes([murk()], { fail: true });
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  root = new FakeEl();
  off = MINE.render(root, {}, new URLSearchParams());
  try {
    await settle(60);
    const slot = String(root.querySelector("[data-featured-slot]").innerHTML);
    assert.ok(has(slot, "The mining list didn't load: boom") && has(slot, "Try again"), slot.slice(0, 200));
  } finally {
    Date.now = realNow;
    off?.();
  }
});

test("/mints lists mined tokens (Mining now) with a Mine button each, so it never says No open mints while one is mined", async () => {
  const MINTS = await import("../web/src/views/mints.js");
  const soon = murk({ ticker: "SOON", asset: "8", status: "mining-soon", claims: 0, mineStart: 972_000 });
  const done = murk({ ticker: "DONE", asset: "9", status: "mined-out" });
  const all = [murk(), soon, done];
  // The pure filter: each filter shows its own statuses, best first; a ticker query narrows.
  assert.deepEqual(MINTS.filterMined(all, { filter: "open" }).map((x) => x.ticker), ["MURK"]);
  assert.deepEqual(MINTS.filterMined(all, { filter: "upcoming" }).map((x) => x.ticker), ["SOON"]);
  assert.deepEqual(MINTS.filterMined(all, { filter: "soldout" }).map((x) => x.ticker), ["DONE"]);
  assert.deepEqual(MINTS.filterMined(all, { filter: "all" }).map((x) => x.ticker), ["MURK", "SOON", "DONE"]);
  assert.deepEqual(MINTS.filterMined(all, { filter: "all", query: "$mu" }).map((x) => x.ticker), ["MURK"]);
  mineRoutes(all);
  await freshMine();
  await api.assets({ fresh: true });
  const root = new FakeEl();
  const off = MINTS.render(root, {}, new URLSearchParams());
  try {
    await settle(30);
    const mining = String(root.querySelector("[data-mining-grid]").innerHTML);
    assert.match(mining, /data-ticker="MURK"/);
    assert.ok(!mining.includes('data-ticker="SOON"') && !mining.includes('data-ticker="DONE"'), "Open shows only the tokens being mined");
    assert.match(mining, /href="\/t\/MURK"/);
    assert.match(mining, /href="\/app\/mine\?t=MURK"/);
    assert.ok(has(mining, "Mine MURK"));
    assert.equal(root.querySelector("[data-mining]").hidden, false);
    assert.equal(root.querySelector("[data-mining-head]").textContent, "MINING NOW");
    assert.ok(!String(root.querySelector("[data-grid]").innerHTML).includes("No open mints"), "paid mints are only one of the two kinds");
    assert.match(String(root.querySelector("[data-count]").textContent), /^1 token · 3 on this pool$/);
  } finally {
    off?.();
  }
  // With nothing mined and nothing paid, the old empty line stays.
  mineRoutes([]);
  await freshMine();
  const root2 = new FakeEl();
  const off2 = MINTS.render(root2, {}, new URLSearchParams());
  try {
    await settle(30);
    assert.ok(has(String(root2.querySelector("[data-grid]").innerHTML), "No open mints right now."));
    assert.equal(root2.querySelector("[data-mining]").hidden, true);
  } finally {
    off2?.();
  }
  assert.ok(src("web/src/views/mints.js").includes('href: "/mine"'), "the page links to /mine");
});

test("landing: the Mine block shows the featured mined token and is hidden without one; the strip counts claims; the hero says mine", async () => {
  globalThis.IntersectionObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const M = await import("../web/src/share/mined.js");
  // The block's markup: ticker, claims of the total, a slim bar, the reward, Start mining and How mining works.
  const block = String(M.mineBlock(murk(), { walletReady: false }));
  for (const text of ["MINE IN YOUR BROWSER", "$MURK", "1 of 21,000", "claims mined", "Reward per claim", "1,000 MURK", "Start mining", "How mining works →"]) assert.ok(has(block, text), text);
  assert.match(block, /href="\/app\/mine\?t=MURK"/);
  assert.match(block, /href="\/mine" data-link/);
  assert.match(block, /role="progressbar"/);
  assert.equal(String(M.mineBlock(null)), "", "no mined token: no block");
  const soon = String(M.mineBlock(murk({ status: "mining-soon", mineStart: 972_500 })));
  assert.ok(!soon.includes("/app/mine?t=") && has(soon, "Mining opens at #972,500."));
  // Rendered on the page.
  const LANDING = await import("../web/src/views/landing.js");
  for (const [assets, shown] of [[[murk()], true], [[], false]]) {
    mineRoutes(assets);
    await freshMine();
    const root = new DeepEl();
    const off = LANDING.render(root);
    try {
      await settle(40);
      const slot = root.querySelector("[data-mine]");
      assert.equal(slot.hidden, !shown, shown ? "the block is visible with a mined token" : "the block is hidden without one");
      if (shown) {
        assert.ok(has(String(slot.innerHTML), "1 of 21,000"));
        assert.match(String(slot.innerHTML), /href="\/app\/mine\?t=MURK"/);
      } else assert.equal(String(slot.innerHTML), "");
      const page = String(root.innerHTML);
      assert.ok(has(page, "Launch, mint or mine tokens on Bitcoin L1 in public"), "the hero says mine");
      assert.ok(page.indexOf("data-mine") < page.indexOf("data-strip"), "the block sits right under the hero, above the stats strip");
      // The strip's last tile counts mining claims while a mined token exists, and mints otherwise.
      const strip = root.querySelector("[data-strip]");
      const tile = strip.querySelector('[data-k="mined"]');
      if (shown) {
        assert.equal(tile.replacedWith, undefined, "the claims tile stays");
        assert.equal(strip.querySelector('[data-k="mined"] [data-v]').dataset.to, "1");
      } else {
        assert.match(String(tile.replacedWith), /data-k="mints"/, "no mined token: the tile goes back to mints");
      }
      assert.ok(has(page, "Claims mined"));
      // Phones: the hero buttons carry a Start mining link too, only while a token is open.
      const cta = root.querySelector("[data-hero-mine]");
      assert.ok(page.includes("data-hero-mine"));
      assert.ok(page.indexOf("data-hero-mine") > page.indexOf("Open wallet") && page.indexOf("data-hero-mine") < page.indexOf("Verify a live proof"));
      if (shown) {
        assert.equal(cta.hidden, false);
        assert.match(String(cta.innerHTML), /href="\/app\/mine\?t=MURK"/);
        assert.ok(has(String(cta.innerHTML), "Start mining"));
      } else {
        assert.equal(cta.hidden, true);
        assert.equal(String(cta.innerHTML), "");
      }
      // The launch board below: with no paid mint open, it points at the mined token instead of "No open mints".
      const board = String(root.querySelector("[data-board]")?.innerHTML ?? "");
      if (shown) {
        assert.ok(has(board, "No paid mints are open right now. MURK is open for mining in your browser."), "the launch board points at the mined token");
        assert.ok(!has(board, "No open mints right now."));
        assert.match(board, /href="\/app\/mine\?t=MURK"/);
      } else assert.ok(has(board, "No open mints right now."), "nothing mined: the board keeps its empty state");
    } finally {
      off?.();
    }
  }
  const landing = src("web/src/views/landing.js");
  assert.match(landing, /fetchMined\(\{ fresh: true \}\)/);
  assert.match(landing, /const LAST_TILE = \{ mined: \["mined", "Claims mined", "IDX"\], mints: \["mints", "Mints", "IDX"\] \};/);
  assert.match(landing, /el\.hidden = !f;/);
});

test("/mints: a failing /api/mine says so instead of No open mints; /mine and the landing rebuild only when something shown changed; the nav keeps its room", async () => {
  const MINTS = await import("../web/src/views/mints.js");
  const MINE = await import("../web/src/views/mine.js");
  const STATUS = await import("../web/src/ui/status.js");
  // /mints: the mined list fails while paid mints load (the client's 15 s cache aged out first).
  mineRoutes([murk()], { fail: true });
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  const root = new FakeEl();
  const off = MINTS.render(root, {}, new URLSearchParams());
  try {
    await settle(60);
    assert.equal(root.querySelector("[data-mining]").hidden, false, "the Mining section stays to carry the note");
    assert.equal(root.querySelector("[data-mining-note]").hidden, false);
    assert.ok(!String(root.querySelector("[data-grid]").innerHTML).includes("No open mints"), "no No open mints line while the mined list is unknown");
  } finally {
    Date.now = realNow;
    off?.();
  }
  const mints = src("web/src/views/mints.js");
  assert.ok(mints.includes("The mined tokens didn't load.") && mints.includes('action: "mn-retry"'));
  // /mine: a wallet status event that changes nothing shown does not rebuild the card (keyboard focus stays); one that does, does.
  mineRoutes([murk()]);
  await freshMine();
  let sets = 0;
  const page = new FakeEl();
  const slot = page.querySelector("[data-featured-slot]");
  let inner = "";
  Object.defineProperty(slot, "innerHTML", { get: () => inner, set: (v) => ((inner = String(v)), sets++) });
  const off2 = MINE.render(page, {}, new URLSearchParams());
  try {
    await settle(40);
    assert.ok(has(inner, "1 of 21,000"));
    const n = sets;
    STATUS.setWalletStatus({ state: "locked" });
    STATUS.setWalletStatus({ state: "locked" });
    assert.equal(sets, n, "nothing shown changed: no rebuild");
    STATUS.setWalletStatus({ state: "unlocked" });
    assert.equal(sets, n + 1, "the button kind follows the wallet: one rebuild");
  } finally {
    STATUS.setWalletStatus({ state: "none" });
    off2?.();
  }
  assert.match(src("web/src/views/landing.js"), /const key = JSON\.stringify\(\[f, walletReady\]\);\n\s+if \(key === mineKey\) return;/);
  // The top bar: the nav never shrinks, and the search box waits for 1180 px (an icon button stands in) so five items fit from 768 px.
  const pages = src("web/src/styles/pages.css");
  assert.match(pages, /\.nav \{ display: none; align-self: stretch; flex: none; \}/);
  assert.match(pages, /@media \(min-width: 1180px\) \{ \.top-search \{ display: block; \} \.search-btn \{ display: none; \} \}/);
});

test("wallet gate: returnPath keeps only same-site wallet pages; a visitor without a wallet gets create and restore links that carry the page", async () => {
  assert.equal(SHARED.returnPath("/app/mine?t=MURK"), "/app/mine?t=MURK");
  assert.equal(SHARED.returnPath("/app/mint?t=ABC"), "/app/mint?t=ABC");
  assert.equal(SHARED.returnPath("/app/settings"), "/app/settings");
  for (const bad of [null, undefined, "", "/", "/app", "/mine", "//evil.example/app/x", "https://evil.example/app/x", "/app//evil", "/app/../x", "/app/mine?t=<script>", "/app/create", "/app/import?next=x", "javascript:alert(1)", "/app\\evil", "app/mine"]) {
    assert.equal(SHARED.returnPath(bad), null, String(bad));
  }
  assert.equal(SHARED.nextQuery("/app/mine?t=MURK"), "?next=%2Fapp%2Fmine%3Ft%3DMURK");
  assert.equal(SHARED.nextQuery(null), "");
  assert.equal(SHARED.returnName("/app/mine?t=MURK"), "Mine");
  assert.equal(SHARED.returnName("/app/unknown"), "where you were");
  S.forgetWallet();
  globalThis.document.head ??= new FakeEl(); // the wallet views add their styles to <head> on first use
  const gate = (pathname, search) =>
    withUrl(pathname, search, async () => {
      const root = new FakeEl();
      await SHARED.withWallet(root, () => assert.fail("no wallet is open"));
      return String(root.innerHTML);
    });
  const mine = await gate("/app/mine", "?t=MURK");
  assert.match(mine, /href="\/app\/create\?next=%2Fapp%2Fmine%3Ft%3DMURK"/, "Start mining without a wallet: create returns to Mine");
  assert.match(mine, /href="\/app\/import\?next=%2Fapp%2Fmine%3Ft%3DMURK"/, "and so does restore");
  assert.ok(has(mine, "When your wallet is ready you go straight on to Mine."));
  const plain = await gate("/app", "");
  assert.match(plain, /href="\/app\/create"/);
  assert.match(plain, /href="\/app\/import"/);
  assert.ok(!plain.includes("next="));
  assert.ok(!has(plain, "you go straight on to"));
  const hostile = await gate("/app/mine", "?t=%3Cscript%3E");
  assert.ok(!hostile.includes("<script>"), "nothing from the query reaches the page unescaped");
});

test("wallet gate: after Create wallet the last step continues to the page that sent the visitor (and not without one)", async (t) => {
  const CREATE = await import("../web/src/views/app-create.js");
  const run = async (query) => {
    S.forgetWallet();
    const root = new DeepEl();
    const off = CREATE.render(root, {}, query);
    t.after(() => {
      off?.();
      S.forgetWallet();
    });
    const form = root.querySelector("[data-f]");
    const pw = "correct horse battery staple 1";
    form.querySelector("[name=password]").value = pw;
    form.querySelector("[name=confirm]").value = pw;
    form.ls.submit.at(-1)({ preventDefault() {} });
    const words = [...String(root.innerHTML).matchAll(/<li class="pw"><i>\d+<\/i><b>([a-z]+)<\/b>/g)].map((m) => m[1]);
    assert.equal(words.length, 24, "the 24 words are shown");
    root.querySelector("[data-saved]").checked = true;
    root.querySelector("[data-action=next]").ls.click.at(-1)();
    const asked = [...String(root.innerHTML).matchAll(/Word (\d+)<\/label>/g)].map((m) => Number(m[1]) - 1);
    assert.equal(asked.length, 3);
    for (const i of asked) form.querySelector(`[name=w${i}]`).value = words[i];
    form.ls.submit.at(-1)({ preventDefault() {} });
    await settle(60);
    return String(root.innerHTML);
  };
  const withNext = await run(new URLSearchParams({ next: "/app/mine?t=MURK" }));
  assert.ok(has(withNext, "Continue to Mine"), withNext.slice(0, 300));
  assert.match(withNext, /href="\/app\/mine\?t=MURK"/);
  assert.match(withNext, /href="\/app"/, "the portfolio stays one tap away");
  const without = await run(new URLSearchParams());
  assert.ok(!without.includes("Continue to"));
  assert.ok(has(without, "Open portfolio"));
  // A hostile next is ignored.
  const hostile = await run(new URLSearchParams({ next: "https://evil.example/app/x" }));
  assert.ok(!hostile.includes("evil.example") && !hostile.includes("Continue to"));
});

test("wallet gate: Restore from 24 words goes on to the page that sent the visitor, else to the portfolio", async (t) => {
  const IMPORT = await import("../web/src/views/app-import.js");
  const pushed = [];
  const pushState = history.pushState;
  history.pushState = (st, title, u) => {
    const x = new URL(String(u), "https://murkle.example");
    pushed.push(x.pathname + x.search);
  };
  t.after(() => {
    history.pushState = pushState;
    S.forgetWallet();
  });
  const run = async (query) => {
    S.forgetWallet();
    const root = new DeepEl();
    const off = IMPORT.render(root, {}, query);
    const form = root.querySelector("[data-f]");
    form.querySelector("[name=phrase]").value = S.newPhrase();
    const pw = "correct horse battery staple 1";
    form.querySelector("[name=password]").value = pw;
    form.querySelector("[name=confirm]").value = pw;
    form.ls.submit.at(-1)({ preventDefault() {} });
    await settle(60);
    off?.();
  };
  await run(new URLSearchParams({ next: "/app/mine?t=MURK" }));
  assert.equal(pushed.at(-1), "/app/mine?t=MURK");
  await run(new URLSearchParams());
  assert.equal(pushed.at(-1), "/app");
  await run(new URLSearchParams({ next: "//evil.example/app/x" }));
  assert.equal(pushed.at(-1), "/app", "a hostile next is ignored");
});

test("/app/mine preselects the ticker from ?t= (what every Start mining link carries), and falls back to an open token for an unknown one", async (t) => {
  const MV = await import("../web/src/views/app-mine.js");
  S.forgetWallet();
  const s = await S.createWallet(S.newPhrase(), "correct horse battery staple 1");
  t.after(() => S.forgetWallet());
  const second = murk({ ticker: "ORE", asset: "7", claims: 0 });
  for (const [query, want] of [["t=ORE", "ORE"], ["t=ore", "ORE"], ["t=NOPE", "MURK"], ["", "MURK"]]) {
    mineRoutes([murk(), second]);
    net.routes.set(/^\/api\/mine\/(\w+)$/, ({ m }) => reply(200, { ...(m[1] === "ORE" ? second : murk()), tip: { height: 971_582, hash: "00".repeat(32) }, series: { difficulty: [], claims: [] } }));
    await freshMine();
    net.calls.length = 0;
    const root = new FakeEl();
    const off = MV.mineView(root, s, new URLSearchParams(query), { spawn: () => ({ postMessage() {}, terminate() {} }) });
    try {
      await settle(40);
      const asked = net.calls.filter((c) => /^GET \/api\/mine\/\w+$/.test(c));
      assert.ok(asked.length > 0 && asked.every((c) => c === `GET /api/mine/${want}`), `?${query} asks for ${want}: ${asked}`);
    } finally {
      off?.();
    }
  }
  // The links that lead there all use ?t=.
  assert.match(src("web/src/views/token.js"), /href: `\/app\/mine\?t=\$\{encodeURIComponent\(m\.ticker\)\}`/);
  assert.match(src("web/src/share/mined.js"), /`\/app\/mine\?t=\$\{encodeURIComponent\(ticker\)\}`/);
});

test("copy of the public mining pages: no banned words, no limit framing, no proving-key warning", async () => {
  const M = await import("../web/src/share/mined.js");
  const MINE = await import("../web/src/views/mine.js");
  const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const texts = [
    code("web/src/views/mine.js"), code("web/src/share/mined.js"),
    M.speedNote(murk()), String(M.mineBlock(murk())), String(M.minedCard(murk())), String(MINE.featuredCard(murk())), String(MINE.costPanel({ rate: 3 })), String(MINE.speedPanel(murk())),
    M.gpuSpeedNote(murk()), String(MINE.gpuPanel(murk(), { network: "mainnet", hrp: "murk" })), String(MINE.gpuPanel(murk(), { network: "signet", hrp: "mrk" })),
    ...MINE.HOW_STEPS.flat(),
  ].join("\n");
  for (const re of [/anonymous/i, /trustless/i, /untraceable/i, /audited/i, /mixer/i, /\bsecure/i, /invisible/i, /\blimit/i, /per day/i, /per block/i, /proving key/i, /single-party/i, new RegExp(String.fromCharCode(91, 0x400, 45, 0x4ff, 93))]) {
    assert.doesNotMatch(texts, re, String(re));
  }
});

test("line endings: the public mining pages' files keep theirs (CRLF stays CRLF), the new files are LF", () => {
  const raw = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "latin1");
  for (const f of ["web/src/views/landing.js", "web/src/share/public.css", "web/src/ui/icons.js", "web/src/views/app-create.js", "web/src/views/app-import.js"]) {
    const s = raw(f);
    assert.equal((s.match(/\r\n/g) ?? []).length, (s.match(/\n/g) ?? []).length, `${f} stays CRLF`);
  }
  for (const f of ["web/src/views/mints.js", "web/src/views/mine.js", "web/src/share/mined.js"]) {
    const s = raw(f);
    assert.ok(!s.includes("\r"), `${f} is LF`);
    assert.ok(s.endsWith("\n"), `${f} ends with a newline`);
  }
});

test("/mine: the Mine on a GPU section sits below the panels with the intro, the live time per solution, the requirements, the steps, the reward line and the links", async () => {
  const MINE = await import("../web/src/views/mine.js");
  const M = await import("../web/src/share/mined.js");
  const C = await import("../web/src/config.js");
  mineRoutes([murk()], { rate: 4 });
  await freshMine();
  const root = new FakeEl();
  const off = MINE.render(root, {}, new URLSearchParams());
  try {
    const first = String(root.innerHTML);
    assert.ok(has(first, "GPU MINING"), "the section is in the page");
    assert.ok(first.indexOf("data-speed-slot") < first.indexOf("data-gpu-slot"), "below the cost and speed panels");
    assert.ok(first.indexOf('id="how"') < first.indexOf("data-gpu-slot"), "below How it works");
    await settle(30);
    const gpu = String(root.querySelector("[data-gpu-slot]").innerHTML);
    assert.ok(has(gpu, "An NVIDIA graphics card mines MURK with the Murkle command-line miner."));
    assert.ok(has(gpu, "On one RTX 4090 we measured about 113,000 hashes per second, as much as about a hundred browser tabs."));
    assert.ok(has(gpu, "That is a measurement on one card; other cards are not measured yet."));
    // Difficulty 3,600,000 / 113,000 = 31.9 s.
    assert.ok(has(gpu, "At difficulty 3,600,000 that is about 32 seconds per solution on that card (difficulty / 113,000 seconds)."));
    assert.equal(M.gpuSpeedNote(murk({ difficulty: "1130000000" })), "At difficulty 1,130,000,000 that is about 2.8 hours per solution on that card (difficulty / 113,000 seconds).");
    assert.match(M.gpuSpeedNote(null), /^Expected time per solution = difficulty \/ 113,000 seconds\.$/);
    assert.ok(has(gpu, "You need:"));
    assert.ok(has(gpu, "an NVIDIA GPU (Pascal or newer), Linux or Windows on x64, an NVIDIA driver 525.60 or newer on Linux, 527.41 or newer on Windows, and Node.js 22 or newer."));
    for (const h of ["Get the code", "Download the pinned files", "Create a mining wallet", "Fund its mining fee address", "Mine", "Where the reward goes"]) assert.ok(has(gpu, h), h);
    assert.equal((gpu.match(/<ol class="mi-gpu-steps">/g) ?? []).length, 1);
    assert.equal((gpu.match(/<li>/g) ?? []).length, 5, "five numbered steps");
    assert.ok(has(gpu, "private note, not in your browser wallet"));
    assert.ok(has(gpu, "send it to your browser wallet"));
    assert.ok(has(gpu, "send command"));
    // Every command has the page's copy button, and the copy handler reads the block's text.
    assert.ok((gpu.match(/data-action="mi-copy-cmd"/g) ?? []).length >= 6);
    assert.match(src("web/src/views/mine.js"), /\[data-action=mi-copy-cmd\][\s\S]{0,200}copyText\(b\.closest\("\.mi-cmd"\)\.querySelector\("code"\)\.textContent\)/);
    // The links: the release page, gpu/README.md on GitHub and the source.
    const links = [...gpu.matchAll(/<a class="[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(links, [
      "https://github.com/MurkleProtocol/murkle/releases/tag/gpu-v1.0.0",
      "https://github.com/MurkleProtocol/murkle/blob/main/gpu/README.md",
      "https://github.com/MurkleProtocol/murkle/tree/main/gpu",
    ]);
    assert.equal(M.GPU_RELEASE_URL, `${C.REPO_URL}/releases/tag/gpu-v1.0.0`);
    assert.equal(C.REPO_URL, "https://github.com/MurkleProtocol/murkle");
    assert.equal((gpu.match(/target="_blank" rel="noopener noreferrer"/g) ?? []).length, 3, "external links open safely");
    // The section follows the build's network.
    assert.match(gpu, new RegExp(`data-network="${C.NETWORK}"`));
  } finally {
    off?.();
  }
});

test("/mine GPU section: the commands are the CLI's real ones, the same steps on mainnet (MURKLE_NETWORK=mainnet, PowerShell form) and on signet (no variable)", async () => {
  const MINE = await import("../web/src/views/mine.js");
  const M = await import("../web/src/share/mined.js");
  const bin = src("bin/murkle.mjs");
  const pkg = JSON.parse(src("package.json"));
  const usage = bin.match(/export const MINE_USAGE =\s*`([^`]+)`/)[1];
  const main = M.gpuCommands({ network: "mainnet", ticker: "MURK", hrp: "murk" });
  const sig = M.gpuCommands({ network: "signet", ticker: "MURK", hrp: "mrk" });
  assert.deepEqual(main, {
    network: "mainnet",
    windowsEnv: '$env:MURKLE_NETWORK = "mainnet"',
    clone: "git clone https://github.com/MurkleProtocol/murkle\ncd murkle\nnpm ci",
    fetch: "MURKLE_NETWORK=mainnet npm run artifacts:fetch\nnpm run gpu:fetch",
    create: "MURKLE_NETWORK=mainnet node bin/murkle.mjs new miner",
    mine: "MURKLE_NETWORK=mainnet node bin/murkle.mjs mine miner MURK --gpu all",
    address: "MURKLE_NETWORK=mainnet node bin/murkle.mjs address miner",
    send: "MURKLE_NETWORK=mainnet node bin/murkle.mjs send miner MURK <amount> <your-murk1-address>",
  });
  assert.equal(sig.windowsEnv, null);
  for (const [k, v] of Object.entries(sig)) if (k !== "network" && v) assert.doesNotMatch(v, /MURKLE_NETWORK/, `signet ${k} has no variable`);
  assert.equal(sig.mine, "node bin/murkle.mjs mine miner MURK --gpu all");
  assert.equal(sig.fetch, "npm run artifacts:fetch\nnpm run gpu:fetch");
  assert.equal(sig.send, "node bin/murkle.mjs send miner MURK <amount> <your-mrk1-address>");
  // The CLI's own words: mine <wallet> <TICKER> [--gpu all|0,1,...], the npm scripts, the commands and send's argument order.
  assert.match(usage, /mine <wallet> <TICKER> \[--gpu all\|0,1,\.\.\.\]/);
  assert.equal(pkg.scripts["artifacts:fetch"], "node scripts/fetch-artifacts.mjs");
  assert.equal(pkg.scripts["gpu:fetch"], "node scripts/gpu-fetch.mjs");
  for (const cmd of ["new", "address", "send", "mine"]) assert.match(bin, new RegExp(`async ${cmd}\\(`), `the CLI has ${cmd}`);
  assert.match(bin, /const SEND_USAGE = `usage: \$\{CLI\} send <wallet> <ticker> <amount> </);
  // The page's mine command really parses with the CLI's parser (a child process: the CLI is a real program, not loaded into this fake DOM).
  const code = "const c = await import(process.argv[1]); console.log(JSON.stringify(c.parseMineArgs(process.argv.slice(2), { processors: 8 })));";
  const words = main.mine.replace(/^MURKLE_NETWORK=mainnet node bin\/murkle\.mjs mine /, "").split(" ");
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code, pathToFileURL(join(process.cwd(), "bin/murkle.mjs")).href, ...words], {
    env: { ...process.env, MURKLE_NETWORK: "" }, encoding: "utf8", windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.deepEqual([parsed.name, parsed.ticker, parsed.gpu, parsed.pay], ["miner", "MURK", "all", "key"]);
  // The rendered section shows the commands of each network, the Windows line only on mainnet.
  const mainPanel = String(MINE.gpuPanel(murk(), { network: "mainnet", hrp: "murk" }));
  for (const text of [main.clone, main.fetch, main.create, main.mine, main.send, main.windowsEnv, "open PowerShell and set the network once in that window", "prefix from every command in this list"]) assert.ok(has(mainPanel, text), text);
  assert.equal((mainPanel.match(/node bin\/murkle\.mjs mine miner MURK --gpu all/g) ?? []).length, 2, "the mine command is copyable at the funding step and the mining step");
  assert.ok(has(mainPanel, "Send enough bitcoin for the claims you want."));
  assert.ok(has(mainPanel, "each claim spends one coin from that address and costs about 2,000 to 4,000 sats"), "without a fee rate the page gives a range");
  assert.ok(has(mainPanel, "--prepare-coins n") && has(mainPanel, "--max-claims n"));
  assert.ok(mainPanel.indexOf("data-gpu-win") < mainPanel.indexOf("mi-gpu-steps"), "the Windows line comes before the steps");
  const rated = String(MINE.gpuPanel(murk(), { network: "mainnet", hrp: "murk", rate: 4 }));
  assert.match(rated, /costs about <span class="mono t-btc">[^<]*<\/span> at 4 sat\/vB/);
  assert.ok(has(mainPanel, "whole number of base units"));
  const sigPanel = String(MINE.gpuPanel(murk({ ticker: "DIG" }), { network: "signet", hrp: "mrk" }));
  for (const text of [sig.clone, sig.fetch, "node bin/murkle.mjs new miner", "node bin/murkle.mjs mine miner DIG --gpu all", "node bin/murkle.mjs send miner DIG <amount> <your-mrk1-address>", "Send enough signet coins for the claims you want.", "An NVIDIA graphics card mines DIG"]) assert.ok(has(sigPanel, text), text);
  assert.doesNotMatch(sigPanel, /MURKLE_NETWORK|\$env:|open PowerShell/);
  assert.equal((sigPanel.match(/<li>/g) ?? []).length, (mainPanel.match(/<li>/g) ?? []).length, "the same structure on both networks");
  // The funding step says what the first run does, as the CLI does.
  assert.ok(has(mainPanel, "after the GPU self-test it prints"));
  assert.ok(has(mainPanel, "The first run syncs the chain"));
  assert.match(bin, /mining fee address \$\{account\.address\} \(separate from the BTC fee key; it pays only claims\)/);
  assert.match(bin, /no coins at the mining fee address \$\{account\.address\}; fund it with/);
});

test("/mine GPU section release gate: once gpu/pins.json pins builds it pins both platforms the page names; until then the page must not ship", () => {
  const pins = JSON.parse(src("gpu/pins.json"));
  const files = Object.keys(pins.files ?? {});
  if (!files.length) return; // gpu-v1.0.0 is not published and pinned yet: deploy of the GPU section waits for it (npm run gpu:fetch fails until then)
  for (const platform of ["linux-x64", "win32-x64"]) assert.ok(files.some((f) => f.includes(platform)), `gpu/pins.json pins a ${platform} build`);
});

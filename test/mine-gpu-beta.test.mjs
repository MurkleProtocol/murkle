// The "Use the graphics card (beta)" box on /app/mine and the way many claims are paid, without a browser, a GPU or a network:
//   view helpers  gpuState for all eight phases, gpuSupported (a property check that never reads the value), mineView with a fake
//                 root, a fake CPU spawn, a fake GPU spawn and gpuDetect false / true (unsupported never spawns, ticking spawns once and
//                 sends open, a reload starts unticked, a wrong answer bans the lane while the CPU workers go on), the lab seams
//   payer         pickMineCoin tables, mineCoinSummary, CHAIN_LIMIT, the claim queue, the retry on a new block
// navigator.gpu is never read and no worker file is loaded: the GPU spawn is a fake.
import { test, after, mock } from "node:test";
import assert from "node:assert/strict";
import "./fixtures/lab-virtual-register.mjs"; // "virtual:murkle-lab" (imported by app-mine.js) is the stub outside Vite
import { faultOf } from "../web/src/lab/index.js";
import { createStubWorker, STUB_NAME } from "../web/src/lab/gpu-stub-worker.js";

// dynamic: the loader hook above must be registered before app-mine.js is linked
const S = await import("../web/src/session.js");
const V = await import("../web/src/views/app-mine.js");

// Nothing may reach the network: every request is a 404, except the two the mine view reads.
const realFetch = globalThis.fetch;
const MINED = {
  asset: "1395864371200007", kind: "pow", ticker: "ORE", divisibility: 0, status: "mining", deployTxid: "ab".repeat(32), deployHeight: 325_000, bodyHash: "cd".repeat(32),
  mineStart: 325_144, startHeight: 0, endHeight: 0, span: 24, targetPerSpan: 24, reward: "50", baseReward: "50", halvingInterval: 0, nextHalving: null,
  difficulty: "3600000", staleFloor: "0", target: "f".repeat(64), initialDifficulty: "3600000", minDifficulty: "3600000", issued: "1000", maxSupply: "1050000",
  claims: 20, rejectedClaims: 0, feeSats: "10000", burnedFeeSats: "0", claimFeeSats: "0", treasury: null, treasuryAddress: null, feeOutputs: [], firstClaimHeight: 325_150, claims144: 20,
  flags: { lowFloor: false, recipientDiscount: true }, tip: { height: 330_000, hash: "00".repeat(30) + "0abc" }, window: 12, staleFactor: 4, pendingClaims: 0, hashrateEstimate: 2000,
  series: { difficulty: [], claims: [] },
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const path = new URL(String(input), "http://indexer.test").pathname;
  if (path === "/api/mine") return json({ activation: { height: 325_000, active: true }, tip: MINED.tip, assets: [MINED] });
  if (/^\/api\/mine\/\w+$/.test(path)) return json(MINED);
  return json({ error: { code: "not_found", message: "Not found." } }, 404);
};
after(() => (globalThis.fetch = realFetch));

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) await tick();
};
const GPU = V.GPU_TEXT;

/* ---------- gpuState: the eight phases ---------- */

test("gpuState: every phase has its exact words, and the box is disabled or ticked as the spec says", () => {
  const base = { supported: true, gpu: null, banned: false, running: false, rate: 0 };
  const gpu = (over) => ({ w: {}, state: "opening", name: null, note: null, checked: false, ...over });
  const cases = [
    ["unsupported", { ...base, supported: false }, GPU.unsupported, true, false],
    ["off", base, GPU.off, false, false],
    ["starting", { ...base, gpu: gpu({}) }, "Starting the graphics card…", false, true],
    ["selftest", { ...base, gpu: gpu({ name: "RTX 4090", checked: true }) }, "Checking RTX 4090 against known answers. This takes a few seconds.", false, true],
    ["ready", { ...base, gpu: gpu({ state: "ready", name: "RTX 4090" }) }, "RTX 4090 passed its check. It mines when you start mining.", false, true],
    ["mining", { ...base, gpu: gpu({ state: "ready", name: "RTX 4090" }), running: true, rate: 72_345 }, "RTX 4090: 72.3 kH/s", false, true],
    ["failed", { ...base, gpu: gpu({ state: "off", note: "This browser has no WebGPU." }) }, "The graphics card stopped: This browser has no WebGPU. Untick the box and tick it again to retry. The processor keeps mining.", false, true],
    ["banned", { ...base, gpu: gpu({ state: "off", note: "GPU 0 (RTX 4090) disabled: it reported a nonce whose Argon2 hash differs from the reference" }), banned: true },
      "The graphics card is off for this page: GPU 0 (RTX 4090) disabled: it reported a nonce whose Argon2 hash differs from the reference. Nothing was paid for its answer. Reload the page to try again. The processor keeps mining.", true, false],
  ];
  for (const [phase, input, text, disabled, checked] of cases) {
    assert.deepEqual(V.gpuState(input), { phase, text, disabled, checked }, phase);
  }
  // the reason gets a final period only when it lacks one
  assert.match(V.gpuState({ ...base, gpu: gpu({ state: "off", note: "it stopped." }) }).text, /stopped: it stopped\. Untick/);
  assert.match(V.gpuState({ ...base, gpu: gpu({ state: "off", note: "" }) }).text, /stopped: it stopped without saying why\. Untick/);
  // unsupported wins over a ban and a worker; a ban wins over a worker that is still listed
  assert.equal(V.gpuState({ ...base, supported: false, banned: true, gpu: gpu({}) }).phase, "unsupported");
  assert.equal(V.gpuState({ ...base, banned: true, gpu: gpu({ state: "ready" }) }).phase, "banned");
  // a worker without a name is still named in the sentences
  assert.equal(V.gpuState({ ...base, gpu: gpu({ state: "ready" }) }).text, "The graphics card passed its check. It mines when you start mining.");
  assert.equal(V.gpuState({ ...base, gpu: gpu({ checked: true }) }).text, "Checking the graphics card against known answers. This takes a few seconds.");
});

test("gpuSupported is a property check: it never reads the value, and a getter that throws does not throw", () => {
  assert.equal(V.gpuSupported({}), false);
  assert.equal(V.gpuSupported({ gpu: {} }), true);
  assert.equal(V.gpuSupported({ gpu: undefined }), true, "the property exists");
  let reads = 0;
  const nav = {};
  Object.defineProperty(nav, "gpu", { get() { reads++; throw new Error("this must not be read"); } });
  assert.equal(V.gpuSupported(nav), true);
  assert.equal(reads, 0);
  const proto = Object.create({ get gpu() { reads++; throw new Error("nor this"); } });
  assert.equal(V.gpuSupported(proto), true, "a Navigator-style prototype getter");
  assert.equal(reads, 0);
  assert.equal(V.gpuSupported(null), false);
  assert.equal(V.gpuSupported(5), false);
  assert.equal(V.gpuSupported(), false, "this Node has no navigator.gpu");
});

/* ---------- mineView with a fake root ---------- */

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
const startsOf = (w) => w.posts.filter((m) => m.type === "start");

/** A page with a fake root. `lab` null is a default build. Nothing but the two GPU spawns can start a worker. */
function page({ detect = true, query = "", lab = null, route = null, session = {} } = {}) {
  const els = new Map();
  const el = (sel) => {
    if (!els.has(sel)) els.set(sel, { innerHTML: "", textContent: "", hidden: false, value: "", replaceWith() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {} });
    return els.get(sel);
  };
  const root = { innerHTML: "", ls: {}, querySelector: el, querySelectorAll: () => [], addEventListener(t, f) { (this.ls[t] ??= []).push(f); }, removeEventListener(t, f) { this.ls[t] = (this.ls[t] ?? []).filter((x) => x !== f); }, contains: () => true };
  const s = {
    history: [], relayInfo: null, view: { height: 330_000 }, state: null, closed: false, sync: async () => {}, loadRelayInfo: async () => {}, relayBalance: null, minePayer: null, mineBtc: null,
    mineCoins: null, unisat: null, linkage: () => [], holdDraft() {}, releaseDraft() {}, prepareMine: () => ({ challenge: new Uint8Array(32).fill(1), meta: { difficulty: 1n } }),
    resendHeldClaims: async () => ({ sent: 0, held: 0, dropped: 0 }),
    ...session,
  };
  const cpu = fakeWorkers();
  const gpu = fakeWorkers();
  let spawned = 0;
  const off = V.mineView(root, s, new URLSearchParams(query), { spawn: cpu.spawn, gpuSpawn: () => (spawned++, gpu.spawn()), gpuDetect: () => detect, lab });
  if (route) root.ls.change[0]({ target: { name: "mine-route", value: route } });
  return {
    s, cpu, gpu, off, el, root, spawned: () => spawned,
    controls: () => String(el("[data-mine-controls]").innerHTML),
    caption: () => String(el("[data-mine-gpu]").textContent),
    live: () => String(el("[data-mine-live]").innerHTML),
    tick: (checked) => root.ls.change[0]({ target: { name: "mine-gpu", checked } }),
    click: (action, key) => root.ls.click[0]({ target: { closest: () => ({ dataset: { action, key } }) } }),
    box: () => {
      const m = /<input type="checkbox" name="mine-gpu"([^>]*)>/.exec(String(el("[data-mine-controls]").innerHTML));
      return m ? { checked: /\bchecked\b/.test(m[1]), disabled: /\bdisabled\b/.test(m[1]) } : null;
    },
  };
}

test("no WebGPU: the box is disabled and unticked with the plain sentence, ticking it never spawns, and CPU Start still works", async () => {
  const p = page({ detect: false });
  await settle();
  assert.deepEqual(p.box(), { checked: false, disabled: true });
  assert.ok(p.controls().includes(GPU.label));
  assert.ok(p.controls().includes(GPU.unsupported));
  assert.equal(p.controls().includes("data-mine-gpu-note"), false);
  p.tick(true);
  assert.equal(p.spawned(), 0, "no GPU worker is created");
  assert.equal(p.gpu.all.length, 0);
  await p.click("mine-start");
  await settle();
  assert.ok(p.cpu.all.length >= 1, "CPU workers were created");
  assert.ok(p.cpu.all.every((w) => startsOf(w).length >= 1), "and told to start");
  assert.deepEqual(p.box(), { checked: false, disabled: true });
  p.off();
});

test("with WebGPU the box is enabled and unticked; ticking spawns one worker and sends open, then the states follow its messages", async () => {
  const p = page({ detect: true });
  await settle();
  assert.deepEqual(p.box(), { checked: false, disabled: false });
  assert.ok(p.controls().includes(GPU.off));
  assert.equal(p.spawned(), 0, "nothing is spawned by a page load");
  assert.equal(p.gpu.all.length, 0);
  p.tick(true);
  assert.equal(p.spawned(), 1);
  assert.deepEqual(p.gpu.all[0].posts, [{ type: "open", memoryUpToMiB: 4096 }], "open, with the graphics memory request (4 GiB by default) and no other engine option");
  p.tick(true);
  assert.equal(p.spawned(), 1, "a second tick does not spawn again");
  assert.deepEqual(p.box(), { checked: true, disabled: false });
  assert.ok(p.controls().includes(GPU.starting));
  assert.ok(p.controls().includes(GPU.tabNote), "the tab note shows while the box is ticked");
  assert.equal(p.controls().includes("data-mine-gpu-unisat"), false, "the Unisat line only with the Unisat route");
  const w = p.gpu.all[0];
  w.emit({ type: "gpu-info", info: { name: "Fake GPU 9000" } });
  assert.ok(p.controls().includes("Checking Fake GPU 9000 against known answers. This takes a few seconds."));
  w.emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake GPU 9000" });
  assert.ok(p.controls().includes("Fake GPU 9000 passed its check. It mines when you start mining."));
  // start mining: the worker joins the challenge, the caption shows the rate
  await p.click("mine-start");
  await settle();
  assert.equal(startsOf(w).length, 1, "the GPU lane got the challenge");
  w.emit({ type: "progress", hashes: 40_000, ms: 1000, id: startsOf(w)[0].id, lane: "gpu" });
  assert.equal(p.caption(), "Fake GPU 9000: 40.0 kH/s");
  // unticking ends the worker and the tab note goes
  p.tick(false);
  assert.equal(w.terminated, true);
  assert.deepEqual(p.box(), { checked: false, disabled: false });
  assert.equal(p.controls().includes("data-mine-gpu-note"), false);
  p.off();
});

test("a reload starts unticked: a new page on the same wallet has no GPU worker, and nothing is stored", async () => {
  const writes = [];
  const store = { setItem: (...a) => writes.push(a), getItem: () => null, removeItem: (...a) => writes.push(a) };
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
  try {
    const a = page();
    await settle();
    a.tick(true);
    assert.equal(a.spawned(), 1);
    a.off();
    const b = page();
    await settle();
    assert.deepEqual(b.box(), { checked: false, disabled: false });
    assert.equal(b.spawned(), 0);
    assert.equal(b.gpu.all.length, 0);
    assert.deepEqual(writes, [], "the choice is not written anywhere");
    b.off();
  } finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had);
    else delete globalThis.localStorage;
  }
});

test("a wrong GPU answer: the box is banned and disabled with the reason, and the CPU workers keep receiving start", async () => {
  const p = page();
  await settle();
  p.tick(true);
  const w = p.gpu.all[0];
  w.emit({ type: "gpu-info", info: { name: "Fake" } });
  w.emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake" });
  await p.click("mine-start");
  await settle();
  const cpuStarts = () => p.cpu.all.reduce((n, c) => n + startsOf(c).length, 0);
  const before = cpuStarts();
  assert.ok(before >= 1);
  w.emit({ type: "lane-off", reason: "GPU 0 (Fake) disabled: it reported a nonce whose Argon2 hash differs from the reference; nothing was paid for it", wrong: true });
  assert.deepEqual(p.box(), { checked: false, disabled: true });
  assert.ok(p.controls().includes("The graphics card is off for this page: GPU 0 (Fake) disabled: it reported a nonce whose Argon2 hash differs from the reference; nothing was paid for it."));
  assert.ok(p.controls().includes("Nothing was paid for its answer. Reload the page to try again. The processor keeps mining."));
  p.tick(true);
  assert.equal(p.spawned(), 1, "re-ticking after a ban does not spawn");
  // the CPU lanes were not touched: stop and start again, they get a new challenge
  await p.click("mine-stop");
  await p.click("mine-start");
  await settle();
  assert.ok(cpuStarts() > before, "CPU workers received start again");
  assert.deepEqual(p.box(), { checked: false, disabled: true });
  p.off();
});

test("a lane that stopped without a wrong answer: ticked with the reason, and unticking then ticking tries again", async () => {
  const p = page();
  await settle();
  p.tick(true);
  p.gpu.all[0].emit({ type: "lane-off", reason: "This browser has no WebGPU." });
  assert.deepEqual(p.box(), { checked: true, disabled: false });
  assert.ok(p.controls().includes("The graphics card stopped: This browser has no WebGPU. Untick the box and tick it again to retry. The processor keeps mining."));
  p.tick(false);
  assert.deepEqual(p.box(), { checked: false, disabled: false });
  p.tick(true);
  assert.equal(p.spawned(), 2, "a second worker for the retry");
  p.off();
});

test("the live caption splits the rate into processor and graphics card while a GPU worker exists, and is the plain average without one", async () => {
  const p = page();
  await settle();
  await p.click("mine-start");
  await settle();
  assert.ok(p.live().includes("10-second average"));
  assert.equal(p.live().includes("graphics card"), false);
  p.tick(true);
  const w = p.gpu.all[0];
  w.emit({ type: "gpu-info", info: { name: "Fake" } });
  w.emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake" });
  const id = startsOf(p.cpu.all[0])[0].id;
  p.cpu.all[0].emit({ type: "progress", hashes: 300, ms: 1000, id });
  w.emit({ type: "progress", hashes: 40_000, ms: 1000, id, lane: "gpu" });
  const live = p.live();
  assert.ok(live.includes("processor 300 H/s · graphics card 40.0 kH/s"), live.slice(0, 600));
  assert.ok(live.includes("40.3 kH/s"), "This tab stays the total");
  p.off();
});

test("the Unisat route adds the confirm-every-claim line while the box is ticked", async () => {
  const p = page({ route: "unisat" });
  await settle();
  assert.equal(p.controls().includes("data-mine-gpu-unisat"), false, "unticked: no note");
  p.tick(true);
  assert.ok(p.controls().includes(GPU.unisatNote));
  p.off();
});

test("lab seams: ?gpu=stub... picks a stub worker that never calls WebGPU, ?gpufault=n is sent with open; in a default build none of it does anything", async () => {
  const stubs = [];
  const lab = { spawnStub: (mode) => { const w = fakeWorkers().spawn(); stubs.push([mode, w]); return w; }, faultOf };
  for (const [query, mode] of [["gpu=stub", "ok"], ["gpu=stub-fail", "fail"], ["gpu=stub-wrong", "wrong"]]) {
    stubs.length = 0;
    const p = page({ detect: false, query, lab });
    await settle();
    assert.deepEqual(p.box(), { checked: false, disabled: false }, `${query}: the box is usable although this browser has no WebGPU`);
    p.tick(true);
    assert.equal(p.spawned(), 0, "the real worker is not spawned");
    assert.deepEqual(stubs.map(([m]) => m), [mode]);
    assert.deepEqual(stubs[0][1].posts, [{ type: "open", memoryUpToMiB: 4096 }]);
    p.off();
  }
  const none = page({ detect: true, query: "gpu=stub-none", lab });
  await settle();
  assert.deepEqual(none.box(), { checked: false, disabled: true }, "stub-none: no WebGPU, even where there is");
  none.off();
  // a fault is sent with open
  const real = page({ query: "gpufault=5", lab });
  await settle();
  real.tick(true);
  assert.deepEqual(real.gpu.all[0].posts, [{ type: "open", memoryUpToMiB: 4096, fault: { afterBatches: 5 } }]);
  real.off();
  for (const q of ["gpufault=0", "gpufault=1001", "gpufault=x", "gpufault=2.5", "gpufault=-1"]) {
    const p = page({ query: q, lab });
    await settle();
    p.tick(true);
    assert.deepEqual(p.gpu.all[0].posts, [{ type: "open", memoryUpToMiB: 4096 }], q);
    p.off();
  }
  assert.deepEqual(faultOf(new URLSearchParams("gpufault=1000")), { afterBatches: 1000 });
  assert.deepEqual(faultOf(new URLSearchParams("gpufault=1")), { afterBatches: 1 });
  assert.equal(faultOf(new URLSearchParams("")), null);
  // a default build (lab null): the same addresses change nothing
  const plain = page({ detect: false, query: "gpu=stub&gpufault=5", lab: null });
  await settle();
  assert.deepEqual(plain.box(), { checked: false, disabled: true });
  plain.tick(true);
  assert.equal(plain.spawned(), 0);
  plain.off();
  const plain2 = page({ detect: true, query: "gpu=stub&gpufault=5", lab: null });
  await settle();
  plain2.tick(true);
  assert.deepEqual(plain2.gpu.all[0].posts, [{ type: "open", memoryUpToMiB: 4096 }], "no fault without a lab build");
  plain2.off();
});

test("the stub worker: gpu-info after 300 ms, then ready (or lane-off, wrong: true for the wrong mode), progress of 40,000 every second, never found", () => {
  const run = (mode) => {
    const timers = [];
    const out = [];
    const fake = {
      setTimeout: (fn, ms) => timers.push({ fn, ms, id: timers.length, every: false }) && timers.length - 1,
      clearTimeout: (id) => { if (timers[id]) timers[id].dead = true; },
      setInterval: (fn, ms) => timers.push({ fn, ms, id: timers.length, every: true }) && timers.length - 1,
      clearInterval: (id) => { if (timers[id]) timers[id].dead = true; },
    };
    const w = createStubWorker({ post: (m) => out.push(m), timers: fake });
    w.onMessage({ type: "open", mode });
    return { w, out, timers, fire: (i) => timers[i].fn() };
  };
  const ok = run("ok");
  assert.equal(ok.timers[0].ms, 300);
  assert.equal(ok.timers[1].ms, 1000);
  ok.fire(0);
  ok.fire(1);
  assert.deepEqual(ok.out, [{ type: "gpu-info", info: { name: STUB_NAME } }, { type: "ready", ok: true, impl: "webgpu", name: STUB_NAME }]);
  ok.w.onMessage({ type: "start", id: 4 });
  const tickAt = ok.timers.findIndex((t) => t.every);
  assert.equal(ok.timers[tickAt].ms, 1000);
  ok.fire(tickAt);
  assert.deepEqual(ok.out.at(-1), { type: "progress", hashes: 40_000, ms: 1000, lane: "gpu", id: 4 });
  ok.w.onMessage({ type: "stop" });
  assert.equal(ok.timers[tickAt].dead, true);
  assert.equal(ok.out.some((m) => m.type === "found"), false);
  const fail = run("fail");
  fail.fire(0);
  fail.fire(1);
  assert.deepEqual(fail.out.at(-1), { type: "lane-off", reason: "the stub was told to fail." });
  const wrong = run("wrong");
  wrong.fire(0);
  wrong.fire(1);
  assert.deepEqual(wrong.out.at(-1), { type: "lane-off", reason: "the stub was told to fail.", wrong: true });
  wrong.w.onMessage({ type: "start", id: 1 });
  assert.equal(wrong.timers.filter((t) => t.every).length, 0, "a lane that is off makes no progress");
});

/* ---------- the payer: which coin a claim binds ---------- */

const NEED = 2552n;
const coin = (n, value, confirmed = true) => ({ txid: n.toString(16).padStart(64, "0"), vout: 0, value, status: confirmed ? { confirmed: true, block_height: 1 } : { confirmed: false } });
const txidOf = (n) => n.toString(16).padStart(64, "0");
const claimEntry = (n, extra = {}) => ({ kind: "mine", via: "self", status: "submitted", txid: n == null ? undefined : txidOf(1000 + n), ...extra });
const pick = (over) => S.pickMineCoin({ utxos: [], history: [], splits: [], need: NEED, ...over });

test("pickMineCoin: a confirmed coin first, even when this wallet already has 24 unconfirmed transactions", () => {
  const big = coin(1, 100_000);
  const r = pick({ utxos: [big], history: Array.from({ length: 24 }, (_, i) => claimEntry(i)) });
  assert.equal(r.coin, big);
  assert.deepEqual(r.spend, [big]);
  assert.equal(r.unconfirmed, 24);
  // the largest confirmed coin that pays a claim, not the largest coin
  const small = coin(2, 3_000);
  const huge = coin(3, 900_000, false);
  const r2 = pick({ utxos: [small, huge, big] });
  assert.equal(r2.coin, big, "confirmed beats larger-but-unconfirmed");
  assert.equal(pick({ utxos: [small, coin(4, 50_000)] }).coin.value, 50_000);
});

test("pickMineCoin: an unconfirmed coin is allowed at 23 of this wallet's transactions and refused at 24", () => {
  const u = coin(1, 100_000, false);
  const withN = (n) => pick({ utxos: [u], history: Array.from({ length: n }, (_, i) => claimEntry(i)) });
  const ok = withN(22); // 22 claims + the coin's own transaction = 23
  assert.equal(ok.coin, u);
  assert.equal(ok.unconfirmed, 23);
  const full = withN(23); // 24: this claim would be the 25th
  assert.equal(full.wait, "chain");
  assert.equal(full.unconfirmed, 24);
  assert.equal(full.freeSats, 100_000);
  assert.equal(S.CHAIN_ROOM, 24);
  // the room is a parameter
  assert.equal(pick({ utxos: [u], room: 1 }).wait, "chain");
  assert.equal(pick({ utxos: [u], room: 2 }).coin, u);
});

test("pickMineCoin: claims still proving (no txid yet) count, one each; a carrier listed confirmed does not count; splits count until listed confirmed", () => {
  const u = coin(1, 100_000, false);
  const proving = (n) => Array.from({ length: n }, () => ({ kind: "mine", via: "self", status: "proving" }));
  assert.equal(pick({ utxos: [u], history: [...Array.from({ length: 21 }, (_, i) => claimEntry(i)), ...proving(1)] }).unconfirmed, 23);
  assert.equal(pick({ utxos: [u], history: [...Array.from({ length: 21 }, (_, i) => claimEntry(i)), ...proving(1)] }).coin, u);
  assert.equal(pick({ utxos: [u], history: [...Array.from({ length: 21 }, (_, i) => claimEntry(i)), ...proving(2)] }).wait, "chain");
  // a pending claim whose txid is listed confirmed no longer counts
  const confirmedCarriers = Array.from({ length: 30 }, (_, i) => ({ txid: txidOf(1000 + i), vout: 1, value: 330, status: { confirmed: true } }));
  const r = pick({ utxos: [u, ...confirmedCarriers], history: Array.from({ length: 30 }, (_, i) => claimEntry(i)) });
  assert.equal(r.unconfirmed, 1, "only the coin's own transaction");
  assert.equal(r.coin, u);
  // only the mining key's own self-paid claims count: relayed and other kinds do not
  const noise = [{ kind: "mine", via: "relay", status: "submitted", txid: txidOf(5000) }, { kind: "send", via: "self", status: "submitted", txid: txidOf(5001) }, claimEntry(1, { status: "landed" })];
  assert.equal(pick({ utxos: [u], history: noise }).unconfirmed, 1);
  // splits
  const splits = Array.from({ length: 23 }, (_, i) => txidOf(2000 + i));
  assert.equal(pick({ utxos: [u], splits }).wait, "chain", "23 unconfirmed splits and the coin's transaction");
  const listed = splits.map((t) => ({ txid: t, vout: 0, value: 1000, status: { confirmed: true } }));
  assert.equal(pick({ utxos: [u, ...listed], splits }).coin, u, "splits seen confirmed stop counting");
  assert.equal(pick({ utxos: [u], splits: splits.slice(0, 2) }).unconfirmed, 3);
});

test("pickMineCoin: the multi-input fallback, and coins vs chain waits", () => {
  const three = [coin(1, 1_000), coin(2, 1_200), coin(3, 900)]; // 3,100 together, none pays a claim alone
  const r = pick({ utxos: three });
  assert.equal(r.coin.value, 1_200);
  assert.deepEqual(r.spend, three, "the carrier may spend every free coin");
  // not enough in all: coins
  const less = pick({ utxos: [coin(1, 1_000), coin(2, 500)] });
  assert.deepEqual([less.wait, less.freeSats], ["coins", 1_500]);
  assert.deepEqual(pick({ utxos: [] }).wait, "coins");
  // enough in all, but one coin is unconfirmed and the wallet's chain is full: wait for the chain
  const mixed = [coin(1, 1_000), coin(2, 1_200, false), coin(3, 900)];
  const full = pick({ utxos: mixed, history: Array.from({ length: 24 }, (_, i) => claimEntry(i)) });
  assert.equal(full.wait, "chain");
  // the chain is full, but the confirmed free coins alone cover the claim: they are spent, the unconfirmed one is left
  const cover = [coin(1, 1_500), coin(2, 1_200), coin(3, 5_000, false)];
  const alone = pick({ utxos: cover, history: Array.from({ length: 24 }, (_, i) => claimEntry(i)) });
  assert.deepEqual(alone.spend, [cover[0], cover[1]]);
  // with room the fallback may spend the unconfirmed coin too
  assert.deepEqual(pick({ utxos: mixed, history: Array.from({ length: 3 }, (_, i) => claimEntry(i)) }).spend, mixed);
  // all confirmed: the fallback needs no room at all
  assert.equal(pick({ utxos: three, history: Array.from({ length: 40 }, (_, i) => claimEntry(i)) }).spend.length, 3);
});

test("pickMineCoin: a coin held by a pending claim is never chosen or spent (its bound coin, or any input of its carrier)", () => {
  const a = coin(1, 100_000);
  const b = coin(2, 50_000);
  const c = coin(3, 40_000);
  const held = [
    { kind: "mine", via: "self", status: "proving", coin: `${a.txid}:${a.vout}` },
    { kind: "mine", via: "self", status: "submitted", txid: txidOf(9), inputs: [`${b.txid}:${b.vout}`] },
    { kind: "mine", via: "self", status: "landed", coin: `${c.txid}:${c.vout}` },
  ];
  const r = pick({ utxos: [a, b, c], history: held });
  assert.equal(r.coin, c, "a and b are held; c's claim already landed");
  assert.deepEqual(r.spend, [c]);
  const none = pick({ utxos: [a, b], history: held });
  assert.equal(none.wait, "coins");
  assert.equal(none.freeSats, 0);
  // the fallback does not spend a held coin either
  const f = pick({ utxos: [a, coin(4, 1_500), coin(5, 1_500)], history: held });
  assert.deepEqual(f.spend.map((u) => u.value), [1_500, 1_500]);
});

test("mineCoinSummary: sats, coins, ready, unconfirmed, held by claims in flight, and the claims the free sats cover", () => {
  const A = coin(1, 100_000);
  const B = coin(2, 100_000, false);
  const C = coin(3, 1_000);
  const D = coin(4, 5_000);
  const history = [{ kind: "mine", via: "self", status: "proving", coin: `${D.txid}:${D.vout}` }];
  assert.deepEqual(S.mineCoinSummary({ utxos: [A, B, C, D], history, need: NEED }), { sats: 206_000, coins: 4, ready: 1, unconfirmed: 1, busy: 1, claimsCovered: 78 });
  assert.deepEqual(S.mineCoinSummary({ utxos: [], history: [], need: NEED }), { sats: 0, coins: 0, ready: 0, unconfirmed: 0, busy: 0, claimsCovered: 0 });
  assert.equal(S.mineCoinSummary({ utxos: [A], history: [], need: null }).claimsCovered, null, "no cost known yet");
  assert.equal(S.mineCoinSummary({ utxos: [A], history: [], need: 100_000 }).claimsCovered, 1);
});

test("CHAIN_LIMIT matches Bitcoin Core's chain refusals (and the cluster mempool's), not an unrelated refusal", async () => {
  for (const msg of [
    "sendrawtransaction RPC error: too-long-mempool-chain, too many unconfirmed ancestors [limit: 25]",
    `sendrawtransaction RPC error: too-long-mempool-chain, too many descendants for tx ${"ab".repeat(32)} [limit: 25]`,
    'POST /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"too-long-mempool-chain, too many unconfirmed parents"}',
    "sendrawtransaction RPC error: too-large-cluster, cluster would have too many transactions",
    "TOO-LONG-MEMPOOL-CHAIN",
  ]) assert.ok(S.CHAIN_LIMIT.test(msg), msg);
  for (const msg of ["sendrawtransaction RPC error: bad-txns-inputs-missingorspent", "sendrawtransaction RPC error: txn-already-in-mempool", "POST /tx: 500 boom", "min relay fee not met"]) assert.equal(S.CHAIN_LIMIT.test(msg), false, msg);
});

/* ---------- the claim queue and the retry on a new block ---------- */

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const sol = (key, ref, over = {}) => ({ key, ref, status: "found", ...over });

test("ClaimQueue: two solutions found 1 ms apart are proved one after the other, never at once", async () => {
  const gates = new Map();
  const log = [];
  let running = 0;
  let most = 0;
  const q = new V.ClaimQueue(async (s) => {
    log.push(`start ${s.key}`);
    running += 1;
    most = Math.max(most, running);
    gates.set(s.key, deferred());
    await gates.get(s.key).promise;
    s.status = "submitted";
    running -= 1;
    log.push(`end ${s.key}`);
  });
  const a = sol("a", 100);
  const b = sol("b", 100);
  q.add(a);
  await new Promise((r) => setTimeout(r, 1));
  q.add(b);
  await settle();
  assert.deepEqual(log, ["start a"], "b waits for a");
  gates.get("a").resolve();
  await settle();
  assert.deepEqual(log, ["start a", "end a", "start b"]);
  gates.get("b").resolve();
  await settle();
  assert.deepEqual(log, ["start a", "end a", "start b", "end b"]);
  assert.equal(most, 1);
  assert.equal(q.pumping, false);
});

test("ClaimQueue: the oldest reference block goes first, a solution is queued once, one that is no longer found is skipped, and a throwing claim does not stop the queue", async () => {
  const order = [];
  const q = new V.ClaimQueue(async (s) => {
    order.push(s.key);
    if (s.key === "boom") throw new Error("x");
    s.status = "submitted";
  });
  const s3 = sol("s3", 103);
  const s1 = sol("s1", 101);
  const s2 = sol("s2", 102);
  const gone = sol("gone", 100, { status: "expired" });
  const boom = sol("boom", 104);
  for (const x of [s3, s1, s2, gone, boom]) q.add(x);
  q.add(s1);
  q.add({ ...s1 });
  await settle();
  assert.deepEqual(order, ["s1", "s2", "s3", "boom"]);
  q.add(sol("later", 99));
  await settle();
  assert.equal(order.at(-1), "later");
});

test("a wait code leaves the solution found and waiting; a new block queues it again, oldest first; an expired one is not retried; automatic claiming off queues nothing", async () => {
  const err = (code, message = "Nothing was paid.") => Object.assign(new Error(message), { code });
  const w1 = sol("w1", 100);
  const w2 = sol("w2", 101);
  const r1 = V.applyClaimFailure(w1, err("chain_wait", "Bitcoin nodes accept about 25 unconfirmed transactions in a chain, and this wallet has 24 waiting. Nothing was paid: this solution is paid after the next block, while it stays valid (until block 110)."));
  assert.deepEqual([w1.status, w1.wait, r1.again], ["found", true, false]);
  assert.match(w1.message, /^Bitcoin nodes accept about 25 unconfirmed transactions in a chain/);
  assert.equal(w1.message.includes("claim again, or pick another route"), false, "the wait message stands on its own");
  V.applyClaimFailure(w2, err("no_coins", "Your mining key has 1,500 sats free; a claim needs about 2,552. Add BTC or wait for claims in flight to confirm. Nothing was paid."));
  assert.deepEqual([w2.status, w2.wait], ["found", true]);
  // coin_busy is tried again at once, once
  const b = sol("b", 100);
  assert.equal(V.applyClaimFailure(b, err("coin_busy", "Another claim took that coin a moment ago.")).again, true);
  assert.equal(V.applyClaimFailure(b, err("coin_busy", "Another claim took that coin a moment ago.")).again, false, "only once");
  // a final refusal is not a wait
  const f = sol("f", 100);
  V.applyClaimFailure(f, err("insufficient", "This solution does not meet the difficulty. Nothing was paid."));
  assert.deepEqual([f.status, f.wait], ["failed", false]);
  // a plain failure with no code (a network error, a 429 or 5xx from an explorer) and the indexer / block-hash codes wait for the next block
  const other = sol("o", 100);
  V.applyClaimFailure(other, new Error("GET /blocks/tip/hash: 503 Service Unavailable"), null, "key");
  assert.deepEqual([other.status, other.wait, other.waitCode], ["found", true, null]);
  assert.equal(other.message, "GET /blocks/tip/hash: 503 Service Unavailable. Nothing was paid; it is tried again after the next block, while it stays valid.");
  for (const code of ["indexer", "refhash", "behind"]) {
    const x = sol(code, 100);
    V.applyClaimFailure(x, err(code, "x."));
    assert.deepEqual([x.status, x.wait], ["found", true], code);
  }
  // the wait chip: coins missing is not fixed by a block
  const nc = sol("nc", 100);
  V.applyClaimFailure(nc, err("no_coins"));
  assert.equal(nc.waitCode, "no_coins");
  // stays manual: Unisat (a declined popup must not reopen every block), and coded refusals that need the user
  const uni = sol("uni", 100);
  V.applyClaimFailure(uni, new Error("User rejected the request."), null, "unisat");
  assert.deepEqual([uni.status, uni.wait], ["found", false]);
  for (const code of ["unisat", "no_key", "relay_off", "balance_low", "fee_policy", "notes_taken"]) {
    const x = sol(code, 100);
    V.applyClaimFailure(x, err(code));
    assert.deepEqual([x.status, x.wait], ["found", false], code);
  }
  // a rejected explorer call re-queues the solution on the next tip
  const outage = sol("outage", 100);
  V.applyClaimFailure(outage, new Error("POST /tx: 429 Too Many Requests"), null, "key");
  const requeued = [];
  await V.retryOnTip({ s: { view: { height: 101 } }, solutions: [outage], autoSubmit: true, queue: { add: (x) => requeued.push(x.key) }, route: "key" });
  assert.deepEqual(requeued, ["outage"]);

  const queued = [];
  const queue = { add: (x) => queued.push(x.key) };
  const resent = [];
  const s = { view: { height: 105 }, resendHeldClaims: async () => resent.push(105) };
  const expired = sol("late", 90, { wait: true });
  const waiting = [w2, w1, expired, sol("plain", 100), sol("done", 100, { status: "submitted", wait: true })];
  await V.retryOnTip({ s, solutions: waiting, autoSubmit: true, queue, route: "key" });
  assert.deepEqual(resent, [105], "held carriers are sent again first");
  assert.deepEqual(queued, ["w1", "w2"], "oldest first; the expired, the not waiting and the finished are left");
  // the window edge: a self-paid solution can be paid until the tip is ref + 10
  queued.length = 0;
  s.view.height = 110;
  await V.retryOnTip({ s, solutions: [w1], autoSubmit: true, queue, route: "key" });
  assert.deepEqual(queued, ["w1"]);
  queued.length = 0;
  s.view.height = 111;
  await V.retryOnTip({ s, solutions: [w1], autoSubmit: true, queue, route: "key" });
  assert.deepEqual(queued, []);
  // automatic claiming off: held carriers are still sent, nothing is queued
  resent.length = 0;
  s.view.height = 105;
  await V.retryOnTip({ s, solutions: [w1, w2], autoSubmit: false, queue, route: "key" });
  assert.deepEqual([resent.length, queued.length], [1, 0]);
  // a throwing resend does not stop the retry
  await V.retryOnTip({ s: { view: { height: 105 }, resendHeldClaims: async () => { throw new Error("offline"); } }, solutions: [w1], autoSubmit: true, queue, route: "key" });
  assert.deepEqual(queued, ["w1"]);
  // the session of an older page has no resend at all
  await V.retryOnTip({ s: { view: { height: 105 } }, solutions: [], autoSubmit: true, queue, route: "key" });
});

test("small page helpers: the rate per block, the suggested number of coins, the waiting count", () => {
  assert.deepEqual(V.gpuYield({ hashrate: 72_000, difficulty: 3_600_000, need: 1_868 }), { perBlock: 12, text: "12", sats: 22_416 });
  assert.equal(V.gpuYield({ hashrate: 73_800, difficulty: 3_600_000, need: 1_868 }).text, "12.3");
  assert.equal(V.gpuYield({ hashrate: 40_000, difficulty: 1_875, need: 3_236 }).text, "12,800", "thousands separators, no trailing .0");
  assert.equal(V.gpuYield({ hashrate: 0, difficulty: 3_600_000, need: 1_868 }), null);
  assert.equal(V.gpuYield({ hashrate: 5, difficulty: 0, need: 1 }), null);
  assert.equal(V.gpuYield({ hashrate: 72_000, difficulty: 3_600_000, need: null }).sats, null);
  assert.equal(V.suggestedCoins(0.2), 4);
  assert.equal(V.suggestedCoins(12), 36);
  assert.equal(V.suggestedCoins(16.4), 50);
  assert.equal(V.suggestedCoins(100), 50, "the input's own maximum of 50");
  const held = { kind: "mine", status: "submitted", held: "chain" };
  assert.equal(V.waitingCount([sol("a", 1, { wait: true }), sol("b", 1), sol("c", 1, { wait: true, status: "failed" })], [held, { ...held, status: "landed" }, { kind: "mine", status: "submitted" }]), 2);
  assert.equal(V.waitingCount([], []), 0);
});

/* ---------- graphics memory: the default and the remembered choice ---------- */

const GM = await import("../web/src/share/gpu-memory.js");

/** A Map-backed localStorage for one test; restores whatever the global was. */
function withStorage(fn) {
  const data = new Map();
  const writes = [];
  const store = { getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => (writes.push(k), data.set(k, String(v))), removeItem: (k) => data.delete(k) };
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: store });
  const restore = () => (had ? Object.defineProperty(globalThis, "localStorage", had) : delete globalThis.localStorage);
  return Promise.resolve(fn({ data, writes })).finally(restore);
}
const memorySelect = (p) => {
  const m = /<select class="input" name="mine-gpu-memory"([^>]*)>([\s\S]*?)<\/select>/.exec(p.controls());
  if (!m) return null;
  return { disabled: /\bdisabled\b/.test(m[1]), options: [...m[2].matchAll(/<option value="(\d+)"( selected)?>([^<]*)<\/option>/g)].map((o) => [Number(o[1]), o[3], Boolean(o[2])]) };
};
const selectedMemory = (p) => memorySelect(p).options.find((o) => o[2])[0];
const pickMemory = (p, value) => p.root.ls.change[0]({ target: { name: "mine-gpu-memory", value: String(value) } });

test("graphics memory: 4 GiB is the default, the choice is remembered (only that number is stored), the next page sends it with open, and the box itself stays off", async () => {
  await withStorage(async ({ data, writes }) => {
    const a = page();
    await settle();
    assert.deepEqual(memorySelect(a), { disabled: false, options: [[2048, "2 GiB", false], [4096, "4 GiB", true], [8192, "8 GiB", false]] }, "4 GiB selected by default");
    assert.ok(a.controls().includes(GPU.memoryLabel));
    assert.ok(a.controls().includes("data-mine-gpu-memory-note"));
    assert.deepEqual(writes, [], "a page load stores nothing");
    pickMemory(a, 8192);
    assert.deepEqual([...data], [[GM.GPU_MEMORY_KEY, "8192"]], "exactly one key: the memory");
    assert.equal(selectedMemory(a), 8192);
    a.tick(true);
    assert.deepEqual(a.gpu.all[0].posts, [{ type: "open", memoryUpToMiB: 8192 }]);
    assert.equal(memorySelect(a).disabled, true, "the choice applies the next time the box is ticked");
    assert.equal(a.controls().includes("data-mine-gpu-memory-note"), false);
    assert.equal(data.size, 1, "ticking the box stores nothing");
    a.off();
    // a new page: unticked, the remembered size selected, and ticking sends it
    const b = page();
    await settle();
    assert.deepEqual(b.box(), { checked: false, disabled: false });
    assert.equal(selectedMemory(b), 8192);
    b.tick(true);
    assert.deepEqual(b.gpu.all[0].posts, [{ type: "open", memoryUpToMiB: 8192 }]);
    b.tick(false);
    pickMemory(b, 2048);
    b.tick(true);
    assert.deepEqual(b.gpu.all[1].posts, [{ type: "open", memoryUpToMiB: 2048 }], "a new choice reaches the next open");
    pickMemory(b, 1234); // not a choice: ignored
    assert.equal(data.get(GM.GPU_MEMORY_KEY), "2048");
    assert.equal(data.size, 1);
    b.off();
    // an odd stored value falls back to 4 GiB
    data.set(GM.GPU_MEMORY_KEY, "123");
    const c = page();
    await settle();
    assert.equal(selectedMemory(c), 4096);
    c.tick(true);
    assert.deepEqual(c.gpu.all[0].posts, [{ type: "open", memoryUpToMiB: 4096 }]);
    c.off();
  });
});

test("graphics memory: no select where there is no WebGPU; the module reads, saves and survives storage that throws", async () => {
  const p = page({ detect: false });
  await settle();
  assert.equal(memorySelect(p), null);
  p.off();
  assert.deepEqual([...GM.GPU_MEMORY_CHOICES], [2048, 4096, 8192]);
  assert.equal(GM.GPU_MEMORY_DEFAULT, 4096);
  assert.deepEqual(["2048", "4096", "8192"].map((v) => GM.readGpuMemory({ getItem: () => v })), [2048, 4096, 8192]);
  for (const bad of [null, "", "0", "1024", "4096.5", "abc", "16384"]) assert.equal(GM.readGpuMemory({ getItem: () => bad }), 4096, String(bad));
  assert.equal(GM.readGpuMemory({ getItem() { throw new Error("blocked"); } }), 4096);
  assert.equal(GM.readGpuMemory(null), 4096);
  const saved = [];
  assert.equal(GM.saveGpuMemory(8192, { setItem: (k, v) => saved.push([k, v]) }), true);
  assert.deepEqual(saved, [[GM.GPU_MEMORY_KEY, "8192"]]);
  assert.equal(GM.saveGpuMemory(1234, { setItem: () => assert.fail("not a choice") }), false);
  assert.equal(GM.saveGpuMemory(4096, { setItem() { throw new Error("full"); } }), false);
  assert.equal(GM.saveGpuMemory(4096, null), false);
  assert.equal(GM.gpuMemoryLabel(2048), "2 GiB");
  assert.ok(GM.GPU_MEMORY_KEY.endsWith(".gpuMemoryMiB"));
});

/* ---------- a proof needs the tab's memory: threads, parked CPU workers, a memory error, a stuck claim ---------- */

const withNavigator = async (value, fn) => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value });
  try {
    return await fn();
  } finally {
    if (had) Object.defineProperty(globalThis, "navigator", had);
    else delete globalThis.navigator;
  }
};
const aliveCpu = (p) => p.cpu.all.filter((w) => !w.terminated).length;
const threadsShown = (p) => Number(/data-threads-out>(\d+)</.exec(p.controls())[1]);

test("ticking the GPU box moves the threads slider down to 2 (never up) and ends the extra CPU workers; the user can still change it", async () => {
  await withNavigator({ hardwareConcurrency: 24 }, async () => {
    assert.deepEqual(V.threadRange(24), { min: 1, max: 23, value: 12 });
    assert.equal(V.gpuThreads(12, V.threadRange(24)), 2);
    assert.equal(V.gpuThreads(1, V.threadRange(24)), 1, "never up");
    assert.equal(V.gpuThreads(12, V.threadRange(1)), 1, "the slider's own limits win");
    assert.equal(V.GPU_THREADS, 2);
    const p = page();
    await settle();
    assert.equal(threadsShown(p), 12);
    await p.click("mine-start");
    await settle();
    assert.equal(aliveCpu(p), 12);
    p.tick(true);
    assert.equal(threadsShown(p), 2, "the slider moved");
    assert.ok(/name="mine-threads" min="1" max="23" value="2"/.test(p.controls()));
    assert.equal(aliveCpu(p), 2, "and the extra workers ended");
    // the user may change it again
    p.root.ls.change[0]({ target: { name: "mine-threads", value: "5" } });
    assert.equal(threadsShown(p), 5);
    assert.equal(aliveCpu(p), 5);
    // unticking does not touch it
    p.tick(false);
    assert.equal(threadsShown(p), 5);
    p.root.ls.change[0]({ target: { name: "mine-threads", value: "12" } }); // leaves the module's remembered slider where a default page puts it
    p.off();
    // a box ticked before Start: Start then runs 2
    const q = page();
    await settle();
    q.tick(true);
    assert.equal(threadsShown(q), 2);
    await q.click("mine-start");
    await settle();
    assert.equal(aliveCpu(q), 2);
    q.off();
    // a lane that never opened (no WebGPU) leaves the slider alone
    const none = page({ detect: false });
    await settle();
    const before = threadsShown(none);
    none.tick(true);
    assert.equal(threadsShown(none), before);
    none.off();
  });
});

test("holdCpu: with the GPU lane on the CPU workers end while a proof runs and start again on the current challenge; without a GPU lane it changes nothing", async () => {
  const cpu = fakeWorkers();
  const gpu = fakeWorkers();
  const ctl = new V.MineController({ spawn: cpu.spawn, gpuSpawn: gpu.spawn, prepare: async () => ({ draft: {}, challenge: "aa".repeat(32), target: "ff".repeat(32) }) });
  const alive = () => cpu.all.filter((w) => !w.terminated).length;
  await ctl.start(3);
  assert.equal(alive(), 3);
  const none = ctl.holdCpu();
  assert.equal(alive(), 3, "no GPU lane: nothing changes");
  none();
  assert.equal(ctl.holds, 0);
  ctl.enableGpu(true);
  gpu.all[0].emit({ type: "gpu-info", info: { name: "G" } });
  gpu.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "G" });
  const r1 = ctl.holdCpu();
  assert.equal(alive(), 0, "the CPU workers are gone, their memory is free");
  const r2 = ctl.holdCpu();
  r1();
  assert.equal(alive(), 0, "still held by the second proof");
  const gpuStarts = startsOf(gpu.all[0]).length;
  await ctl.restart(); // a new block during the proof
  assert.equal(alive(), 0, "a restart does not bring them back");
  assert.equal(startsOf(gpu.all[0]).length, gpuStarts + 1, "the GPU lane keeps mining");
  r2();
  r2(); // a second release does nothing
  assert.equal(alive(), 3, "all three are back");
  const job = ctl.job;
  assert.ok(cpu.all.filter((w) => !w.terminated).every((w) => startsOf(w).some((m) => m.id === job.id)), "each got start for the current challenge");
  // a reference check in flight keeps its worker
  const verify = ctl.verify("00");
  const r3 = ctl.holdCpu();
  assert.equal(alive(), 1);
  r3();
  assert.equal(alive(), 3);
  const asked = ctl.workers.find((w) => w.posts.some((m) => m.type === "verify"));
  asked.emit({ type: "verified", id: 1, powHash: "ab" });
  assert.equal(await verify, "ab");
  // stopped mining: a release starts nothing
  ctl.stop();
  const startsBefore = cpu.all.reduce((n, w) => n + startsOf(w).length, 0);
  const r4 = ctl.holdCpu();
  r4();
  assert.equal(cpu.all.reduce((n, w) => n + startsOf(w).length, 0), startsBefore);
  ctl.terminate();
});

test("holdCpu: release.settled keeps the proof back for settleMs after workers were ended, and is done at once when none were", async () => {
  const cpu = fakeWorkers();
  const gpu = fakeWorkers();
  const ctl = new V.MineController({ spawn: cpu.spawn, gpuSpawn: gpu.spawn, prepare: async () => ({ draft: {}, challenge: "aa".repeat(32), target: "ff".repeat(32) }) });
  assert.equal(ctl.settleMs, V.HOLD_SETTLE_MS);
  ctl.settleMs = 40;
  await ctl.start(2);
  const none = ctl.holdCpu();
  assert.equal(await Promise.race([none.settled.then(() => "done"), new Promise((r) => setTimeout(() => r("late"), 20))]), "done", "no GPU lane: no wait");
  ctl.enableGpu(true);
  gpu.all[0].emit({ type: "gpu-info", info: { name: "G" } });
  gpu.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "G" });
  const t0 = Date.now();
  const r1 = ctl.holdCpu();
  const r2 = ctl.holdCpu();
  assert.equal(r2.settled, r1.settled, "a second proof waits for the same moment");
  assert.equal(await Promise.race([r1.settled.then(() => "done"), new Promise((r) => setTimeout(() => r("early"), 10))]), "early", "still waiting right after the workers ended");
  await r1.settled;
  assert.ok(Date.now() - t0 >= 35);
  r1();
  r2();
  assert.equal(ctl.workers.length, 2, "the workers are back");
  ctl.terminate();
  // a hold that ends no worker has nothing to wait for
  const empty = new V.MineController({ spawn: cpu.spawn, gpuSpawn: gpu.spawn, prepare: async () => ({ draft: {}, challenge: "aa".repeat(32), target: "ff".repeat(32) }) });
  empty.settleMs = 40;
  empty.enableGpu(true);
  gpu.all[gpu.all.length - 1].emit({ type: "gpu-info", info: { name: "G" } });
  gpu.all[gpu.all.length - 1].emit({ type: "ready", ok: true, impl: "webgpu", name: "G" });
  const r3 = empty.holdCpu();
  assert.equal(await Promise.race([r3.settled.then(() => "done"), new Promise((r) => setTimeout(() => r("late"), 20))]), "done");
  r3();
  empty.terminate();
});

test("a proof that ran out of memory is a coded refusal the page tries again, quickly at first (prove_memory), never a final failure", async () => {
  assert.equal(V.RETRY_CODES.has("prove_memory"), true);
  assert.equal(V.FINAL_CLAIM_CODES.has("prove_memory"), false);
  const err = () => Object.assign(new Error(S.PROVE_MEMORY_TEXT), { code: "prove_memory" });
  const x = sol("m", 100);
  const r = V.applyClaimFailure(x, err(), null, "key");
  assert.deepEqual([x.status, x.wait, x.waitCode, r.retryInMs], ["found", true, "prove_memory", V.PROVE_RETRY_MS]);
  assert.equal(r.again, false);
  assert.match(x.message, /ran out of memory while proving, so nothing was sent and nothing was paid\./);
  assert.match(x.message, /It is tried again in a few seconds\.$/);
  for (let i = 1; i < V.PROVE_RETRIES; i++) assert.equal(V.applyClaimFailure(x, err(), null, "key").retryInMs, V.PROVE_RETRY_MS);
  const last = V.applyClaimFailure(x, err(), null, "key");
  assert.equal(last.retryInMs, null, "after PROVE_RETRIES quick retries it waits for the next block");
  assert.match(x.message, /It is tried again after the next block, while it stays valid\.$/);
  assert.equal(x.wait, true);
  // other waits have no quick retry
  assert.equal(V.applyClaimFailure(sol("c", 100), Object.assign(new Error("x."), { code: "chain_wait" })).retryInMs, null);
  // the next block gives the quick retries again
  const queued = [];
  await V.retryOnTip({ s: { view: { height: 101 } }, solutions: [x], autoSubmit: true, queue: { add: (y) => queued.push(y.key) }, route: "key" });
  assert.equal(x.memoryRetries, 0);
  assert.deepEqual(queued, ["m"]);
});

test("ClaimQueue watchdog: a claim that never finishes stops holding the queue after the time limit, the next solution goes on, nothing is cancelled and nothing is queued twice", async () => {
  assert.equal(V.CLAIM_WATCHDOG_MS, 180_000);
  const order = [];
  const stuck = [];
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    let lateReject;
    const never = new Promise((_, rej) => (lateReject = rej));
    const q = new V.ClaimQueue(
      async (s) => {
        order.push(s.key);
        if (s.key === "a") await never; // the proof that never ends
        if (s.key === "b") s.status = "submitted";
      },
      { watchdogMs: 30, onStuck: (s) => stuck.push(s.key) },
    );
    const a = sol("a", 100);
    const b = sol("b", 101);
    q.add(a);
    q.add(b);
    await new Promise((r) => setTimeout(r, 12));
    assert.deepEqual(order, ["a"], "b waits while a is inside its time");
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(order, ["a", "b"], "after the watchdog the queue went on");
    assert.deepEqual(stuck, ["a"], "the page was told");
    assert.equal(b.status, "submitted");
    assert.equal(q.pumping, false);
    assert.equal(q.items.length, 0, "the queue does not queue the stuck solution again");
    // the abandoned claim fails later: no unhandled rejection
    lateReject(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
    // claims that finish in time never fire it, and a throwing onStuck does not stop the queue
    const fine = new V.ClaimQueue(async (s) => (s.status = "submitted"), { watchdogMs: 30, onStuck: () => stuck.push("fine") });
    await fine.add(sol("f", 1));
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(stuck.includes("fine"), false);
    const loud = new V.ClaimQueue((s) => (s.key === "x" ? new Promise(() => {}) : (s.status = "submitted")), { watchdogMs: 10, onStuck: () => { throw new Error("boom"); } });
    const y = sol("y", 2);
    loud.add(sol("x", 1));
    loud.add(y);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(y.status, "submitted");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("ClaimQueue watchdog: the clock is long before the proof (preMs) and counts watchdogMs from proving()", async () => {
  const stuck = [];
  const order = [];
  // a: slow checks (never reports a proof) is held for preMs; b: proves, then hangs: held for watchdogMs from proving()
  const q = new V.ClaimQueue(
    async (s, hooks) => {
      order.push(s.key);
      if (s.key === "a") await new Promise((r) => setTimeout(r, 70)); // longer than watchdogMs, shorter than preMs
      if (s.key === "b") {
        await new Promise((r) => setTimeout(r, 20));
        hooks.proving();
        await new Promise(() => {});
      }
      if (s.key === "c") s.status = "submitted";
    },
    { watchdogMs: 50, preMs: 150, onStuck: (s) => stuck.push(s.key) },
  );
  q.add(sol("a", 1));
  q.add(sol("b", 2));
  const c = sol("c", 3);
  q.add(c);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(order, ["a", "b", "c"]);
  assert.ok(!stuck.includes("a"), "slow pre-prove steps are not a stuck proof");
  assert.deepEqual(stuck, ["b"]);
  assert.equal(c.status, "submitted");
  assert.equal(q.pumping, false);
});

/* ---------- the rows, and what happens after a claim went out ---------- */

const draftOf = () => ({ challenge: new Uint8Array(32).fill(1), meta: { difficulty: 1n }, refHeight: 329_990, reward: 50n });
const waitError = (code) => Object.assign(new Error(code === "no_coins" ? "Your mining key has 100 sats free; a claim needs about 2,552. Add BTC or wait for claims in flight to confirm. Nothing was paid." : "Bitcoin nodes accept about 25 unconfirmed transactions in a chain, and this wallet has 24 waiting. Nothing was paid: this solution is paid after the next block, while it stays valid (until block 330,000)."), { code });
/** A page that mines with a fake claimMine: each claim waits at a gate, then ends as outcome(nonce) says (an error code, or null = sent). */
function claimPage(outcome) {
  const gates = new Map();
  const calls = [];
  const history = [];
  const claimMine = async ({ nonce, onStep }) => {
    calls.push(nonce);
    onStep({ id: "check", status: "running" });
    const g = deferred();
    gates.set(nonce, g);
    await g.promise;
    const code = outcome(nonce);
    if (code) throw waitError(code);
    const entry = { id: `e-${nonce}`, kind: "mine", via: "self", status: "submitted", txid: "ab".repeat(32) };
    history.push(entry);
    return entry;
  };
  const p = page({ session: { prepareMine: draftOf, claimMine, history } });
  const found = async (nonce, from = "cpu") => {
    const w = from === "gpu" ? p.gpu.all[0] : p.cpu.all[0];
    const id = startsOf(w).at(-1).id;
    w.emit({ type: "found", id, nonce, powHash: "00".repeat(32), hashes: 1 });
    await settle();
  };
  const row = (nonce) => {
    const html = String(p.el("[data-mine-solutions]").innerHTML);
    const at = html.indexOf(`data-nonce="${nonce}"`);
    return at < 0 ? null : html.slice(html.lastIndexOf("<li", at), html.indexOf("</li>", at));
  };
  const release = async (nonce) => {
    gates.get(nonce).resolve();
    await settle();
  };
  return { p, found, row, release, calls, gates };
}
const N = (i) => i.toString(16).padStart(16, "0");

test("rows: a solution that waits in the claim queue reads Queued, one that waits for chain room reads Waiting for a block, one that needs coins reads Waiting for coins, one with automatic claiming off reads Found", async () => {
  const outcomes = { [N(1)]: "chain_wait", [N(2)]: "no_coins" };
  const t = claimPage((n) => outcomes[n] ?? null);
  await settle();
  await t.p.click("mine-start");
  await settle();
  await t.found(N(1));
  await t.found(N(2));
  await t.found(N(3));
  assert.deepEqual(t.calls, [N(1)], "one claim at a time");
  assert.match(t.row(N(1)), /Checking/);
  for (const n of [N(2), N(3)]) {
    assert.match(t.row(n), /Queued/, "queued behind the first: it waits for the queue, not for a block");
    assert.doesNotMatch(t.row(n), /Waiting for a block/);
    assert.doesNotMatch(t.row(n), /Found: claim it before its window closes/);
  }
  await t.release(N(1)); // chain_wait
  assert.match(t.row(N(1)), /Waiting for a block/);
  assert.match(t.row(N(1)), /Bitcoin nodes accept about 25 unconfirmed transactions/);
  // the wallet has just said "no room" in this block: the two queued behind it wait too, without a claim attempt of their own
  assert.deepEqual(t.calls, [N(1)], "no check, no request for N2 and N3");
  for (const n of [N(2), N(3)]) {
    assert.match(t.row(n), /Waiting for a block/);
    assert.match(t.row(n), /Bitcoin nodes accept about 25 unconfirmed transactions/);
  }
  // a click asks the wallet again whatever it said before
  await t.p.click("mine-claim", `329990:${N(2)}`);
  await settle();
  await t.release(N(2)); // no_coins
  const coins = t.row(N(2));
  assert.match(coins, /Waiting for coins/);
  assert.doesNotMatch(coins, /Waiting for a block/, "a block does not fix a missing balance");
  assert.match(coins, /Add BTC/);
  await t.p.click("mine-claim", `329990:${N(3)}`);
  await settle();
  await t.release(N(3));
  assert.match(t.row(N(3)), /Receipt/, "sent: the claim's own chip and receipt");
  assert.equal(V.solChip({ wait: true, waitCode: "no_coins" }, "found").text, "Waiting for coins");
  assert.equal(V.solChip({ wait: true, waitCode: "chain_wait" }, "found").text, "Waiting for a block");
  assert.equal(V.solChip({ wait: false }, "found", { queued: true }).text, "Queued");
  assert.equal(V.solChip({ wait: true, waitCode: "chain_wait" }, "found", { queued: true }).text, "Waiting for a block", "a row that waits for a block keeps that wording while queued again");
  assert.equal(V.solChip({ wait: false }, "found").text, "Found: claim it before its window closes");
  assert.equal(V.solChip({ wait: false }, "proving", { queued: true }).text, "Proving");
  t.p.off();
  // automatic claiming off: nothing is queued, so the row is a plain Found with its button
  const manual = claimPage(() => null);
  await settle();
  manual.p.root.ls.change[0]({ target: { name: "mine-auto", checked: false } });
  await manual.p.click("mine-start");
  await settle();
  await manual.found(N(7));
  assert.deepEqual(manual.calls, []);
  assert.match(manual.row(N(7)), /Found: claim it before its window closes/);
  assert.doesNotMatch(manual.row(N(7)), /Waiting for a block/);
  manual.p.off();
});

test("rows carry the solution's key, nonce and lane (data-key, data-nonce, data-lane), so a claim can be tied to the lane that found it", async () => {
  const t = claimPage(() => null);
  await settle();
  t.p.tick(true);
  t.p.gpu.all[0].emit({ type: "gpu-info", info: { name: "G" } });
  t.p.gpu.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "G" });
  await t.p.click("mine-start");
  await settle();
  await t.found(N(1), "cpu");
  await t.release(N(1));
  const gw = t.p.gpu.all[0];
  gw.emit({ type: "found", id: startsOf(gw).at(-1).id, nonce: N(2), powHash: "00".repeat(32), hashes: 1, lane: "gpu" });
  await settle();
  await t.release(N(2));
  assert.match(t.row(N(1)), /data-key="329990:0000000000000001" data-nonce="0000000000000001" data-lane="cpu"/);
  assert.match(t.row(N(2)), /data-key="329990:0000000000000002" data-nonce="0000000000000002" data-lane="gpu"/);
  t.p.off();
});

test("after a claim went out the page sends the solutions that wait for chain room by itself, up to the room there is", async () => {
  let room = 0;
  const t = claimPage(() => (room > 0 ? (room--, null) : "chain_wait"));
  await settle();
  await t.p.click("mine-start");
  await settle();
  for (let i = 1; i <= 5; i++) {
    await t.found(N(i));
    if (t.gates.has(N(i))) await t.release(N(i)); // no room: the first claim waits, and so do the others without asking again
  }
  assert.deepEqual(t.calls, [N(1)], "once the wallet said no room in this block, the others wait without a claim attempt");
  for (let i = 1; i <= 5; i++) assert.match(t.row(N(i)), /Waiting for a block/);
  // a block freed room for 3 claims. One click on the oldest sends it; the page then tries the others at once instead of leaving them to the next block.
  room = 3;
  t.calls.length = 0;
  await t.p.click("mine-claim", `329990:${N(1)}`);
  await settle();
  for (let guard = 0; guard < 8; guard++) {
    const open = [...t.gates.keys()].filter((n) => t.calls.includes(n) && !/Receipt|Waiting for a block/.test(String(t.row(n))));
    if (!open.length) break;
    for (const n of open) await t.release(n);
  }
  await settle();
  const sent = [1, 2, 3, 4, 5].filter((i) => /Receipt/.test(t.row(N(i))));
  assert.equal(sent.length, 3, `3 claims went out with room for 3, got ${sent}`);
  assert.deepEqual(sent, [1, 2, 3], "the oldest first");
  assert.match(t.row(N(4)), /Waiting for a block/);
  assert.match(t.row(N(5)), /Waiting for a block/);
  assert.equal(t.calls.includes(N(5)), false, "the fourth got no room, so the fifth was not asked");
  t.p.off();
});

test("the page's probe: while solutions wait for chain room and the queue is idle, the oldest tries again every 30 seconds without a block", async () => {
  assert.equal(V.PROBE_MS, 30_000);
  mock.timers.enable({ apis: ["setInterval", "Date"] });
  let t;
  try {
    let room = 0;
    t = claimPage(() => (room > 0 ? (room--, null) : "chain_wait"));
    await settle();
    await t.p.click("mine-start");
    await settle();
    for (let i = 1; i <= 3; i++) {
      await t.found(N(i));
      if (t.gates.has(N(i))) await t.release(N(i));
    }
    assert.deepEqual(t.calls, [N(1)], "the other two wait without asking");
    t.calls.length = 0;
    mock.timers.tick(15_000);
    await settle();
    assert.equal(t.calls.length, 0, "15 s after the page opened: too early");
    room = 2;
    mock.timers.tick(15_000); // 30 s: the poll runs and the oldest waiting solution is queued
    await settle();
    assert.deepEqual(t.calls, [N(1)]);
    await t.release(N(1)); // sent: the others follow at once
    for (const n of [N(2), N(3)]) if (t.calls.includes(n)) await t.release(n);
    await settle();
    assert.deepEqual([...t.calls].sort(), [N(1), N(2), N(3)]);
    assert.match(t.row(N(1)), /Receipt/);
    assert.match(t.row(N(2)), /Receipt/);
    assert.match(t.row(N(3)), /Waiting for a block/, "the room was 2");
  } finally {
    t?.p.off();
    mock.timers.reset();
  }
});

test("the per-block line reads in whole numbers with thousands separators and never a trailing .0", async () => {
  const p = page({ session: { mineCoins: { utxos: [], at: 0, need: 1868n } } });
  await settle();
  p.tick(true);
  const w = p.gpu.all[0];
  w.emit({ type: "gpu-info", info: { name: "G" } });
  w.emit({ type: "ready", ok: true, impl: "webgpu", name: "G" });
  await p.click("mine-start");
  await settle();
  const id = startsOf(w)[0].id;
  const line = () => p.el("[data-mine-gpu-rate]").textContent;
  const tail = " Confirmed coins pay at once; once 24 of this wallet's transactions are unconfirmed, the rest wait for the next block and are paid then while still valid. More coins mean fewer waits.";
  // difficulty 3,600,000: 72,000 H/s is exactly 12 solutions a block (not "12.0"), 73,800 is 12.3, 43.2 MH/s is 7,200 (not "7200" or "7200.0")
  w.emit({ type: "progress", hashes: 72_000, ms: 1000, id, lane: "gpu" });
  assert.equal(line(), `With the graphics card this tab finds about 12 solutions per block, about 22,416 sats per block at today's cost.${tail}`);
  p.cpu.all[0].emit({ type: "progress", hashes: 0, ms: 1000, id }); // keeps the window comparable
  w.emit({ type: "progress", hashes: 1_800, ms: 1000, id, lane: "gpu" }); // 73,800 H/s in the 10 s window
  assert.match(line(), /finds about 12\.3 solutions per block, about 22,976 sats per block/);
  w.emit({ type: "progress", hashes: 43_126_200, ms: 1000, id, lane: "gpu" }); // 43,200,000 H/s
  assert.match(line(), /finds about 7,200 solutions per block, about 13,449,600 sats per block/);
  assert.doesNotMatch(line(), /\.0 solutions|\d{4,}\.\d solutions|\b7200\b/);
  p.off();
});

/* ======================================================================================= */
/* a flood of solutions (very low difficulty): the rows, the backpressure, the claim queue   */
/* ======================================================================================= */

const countRows = (html) => (String(html).match(/<li class="mine-sol"/g) ?? []).length;

test("the solutions list draws the newest 200 rows and counts the rest; every solution is still kept", async () => {
  assert.equal(V.SOLUTION_ROWS, 200);
  const t = claimPage(() => null);
  await settle();
  t.p.root.ls.change[0]({ target: { name: "mine-auto", checked: false } }); // nothing is claimed: only the list is under test
  await t.p.click("mine-start");
  await settle();
  for (let i = 1; i <= 230; i++) await t.found(N(i));
  const html = String(t.p.el("[data-mine-solutions]").innerHTML);
  assert.equal(countRows(html), 200, "no more than 200 rows are drawn");
  assert.match(html, /<li class="mine-sol" data-key="329990:00000000000000e6"/, "the newest row (230) comes first");
  assert.ok(html.includes(`data-nonce="${N(31)}"`) && !html.includes(`data-nonce="${N(30)}"`), "rows 31 to 230 are drawn, 1 to 30 are not");
  // automatic claiming is off here, so the note must not say the rest is claimed
  assert.match(html, /<p class="caption t-3" data-mine-sols-more>30 older solutions are not listed here\. They are kept in this tab\. Automatic claiming is off, so they are not claimed\.<\/p>/);
  assert.doesNotMatch(html, /claimed and kept the same way/);
  // with automatic claiming on, the sentence is the old one
  t.p.root.ls.change[0]({ target: { name: "mine-auto", checked: true } });
  assert.match(String(t.p.el("[data-mine-solutions]").innerHTML), /<p class="caption t-3" data-mine-sols-more>30 older solutions are not listed here\. They are claimed and kept the same way\.<\/p>/);
  assert.equal(V.GPU_TEXT.older("30"), "30 older solutions are not listed here. They are claimed and kept the same way.", "on is the default");
  assert.equal(V.GPU_TEXT.older("30", false), "30 older solutions are not listed here. They are kept in this tab. Automatic claiming is off, so they are not claimed.");
  t.p.root.ls.change[0]({ target: { name: "mine-auto", checked: false } });
  assert.match(String(t.p.el("[data-mine-solutions]").innerHTML), /Automatic claiming is off/, "unticking repaints the note");
  assert.match(t.p.live(), /<b class="mono">230<\/b><span class="caption t-3">found in this tab<\/span>/, "the counter holds all of them");
  // a short list has no count line
  const few = claimPage(() => null);
  await settle();
  few.p.root.ls.change[0]({ target: { name: "mine-auto", checked: false } });
  await few.p.click("mine-start");
  await settle();
  await few.found(N(1));
  assert.doesNotMatch(String(few.p.el("[data-mine-solutions]").innerHTML), /data-mine-sols-more/);
  t.p.off();
  few.p.off();
});

test("gpuBacklogPaused: pauses above 2 x the room, resumes once the backlog is down to the room; and it says so", () => {
  assert.equal(V.BACKLOG_FACTOR, 2);
  const at = (backlog, paused, room = 24) => V.gpuBacklogPaused({ paused, backlog, room });
  assert.deepEqual([at(0, false), at(48, false), at(49, false), at(5_168, false)], [false, false, true, true]);
  assert.deepEqual([at(49, true), at(30, true), at(25, true), at(24, true), at(0, true)], [true, true, true, false, false], "stays paused until the backlog is down to the room");
  assert.equal(at(60, false, 24 + 10), false, "ready confirmed coins widen the room: 60 waiting is not above 2 x 34");
  assert.equal(at(69, false, 24 + 10), true);
  assert.equal(V.GPU_TEXT.paused("1,234"), "Graphics card paused: 1,234 solutions are waiting to be paid. It searches again when the wallet has caught up. No solution is dropped; each one is paid, or kept while its window is open.");
  const base = { supported: true, gpu: { w: {}, state: "ready", name: "RTX 4090", note: null, checked: true }, banned: false, running: true, rate: 0 };
  assert.deepEqual(V.gpuState({ ...base, paused: 61 }), { phase: "paused", text: V.GPU_TEXT.paused("61"), disabled: false, checked: true });
  assert.equal(V.gpuState({ ...base, paused: null }).phase, "mining");
  assert.equal(V.gpuState({ ...base, running: false, paused: 61 }).phase, "ready", "paused means nothing while mining is stopped");
  for (const w of ["capped", "limit"]) assert.ok(!V.GPU_TEXT.paused(5).toLowerCase().includes(w), `no "${w}" in the pause text`);
});

test("MineController.pauseGpu: the GPU worker is stopped and gets no new job while paused, the processor lanes go on, and it joins the current challenge again when resumed", async () => {
  const cpu = fakeWorkers();
  const gpu = fakeWorkers();
  let seq = 0;
  const changes = [];
  const ctl = new V.MineController({
    spawn: cpu.spawn, gpuSpawn: gpu.spawn, random: () => "0000000000000001",
    prepare: async () => ({ draft: { n: ++seq }, challenge: "aa".repeat(32), target: "ff".repeat(32) }),
    onFound: () => {}, onChange: (type) => changes.push(type),
  });
  ctl.enableGpu(true);
  const gw = gpu.all[0];
  gw.emit({ type: "gpu-info", info: { name: "G" } });
  gw.emit({ type: "ready", ok: true, impl: "webgpu", name: "G" });
  await ctl.start(2);
  assert.equal(startsOf(gw).length, 1, "the lane started with the first challenge");
  ctl.pauseGpu(true);
  assert.equal(ctl.gpuPaused, true);
  assert.equal(gw.posts.at(-1).type, "stop", "the lane is told to stop searching");
  const cpuBefore = startsOf(cpu.all[0]).length;
  await ctl.restart();
  assert.equal(startsOf(gw).length, 1, "a new challenge is not sent to the paused lane");
  assert.equal(startsOf(cpu.all[0]).length, cpuBefore + 1, "the processor lanes keep searching");
  ctl.pauseGpu(true); // no change, no repeat
  ctl.pauseGpu(false);
  assert.equal(ctl.gpuPaused, false);
  assert.equal(startsOf(gw).length, 2, "resumed: the lane gets the current challenge");
  assert.equal(startsOf(gw).at(-1).id, ctl.job.id);
  // switching the lane off clears the hold
  ctl.pauseGpu(true);
  ctl.enableGpu(false);
  assert.equal(ctl.gpuPaused, false);
  assert.ok(changes.includes("gpu"));
  ctl.terminate();
});

test("a flood on the GPU lane: the lane pauses above 2 x the room, the page says so, no solution is dropped, and the lane searches again when the backlog falls", async () => {
  const t = claimPage(() => null);
  await settle();
  t.p.tick(true);
  const gw = t.p.gpu.all[0];
  gw.emit({ type: "gpu-info", info: { name: "RTX 4090" } });
  gw.emit({ type: "ready", ok: true, impl: "webgpu", name: "RTX 4090" });
  await t.p.click("mine-start");
  await settle();
  const startsAtFirst = startsOf(gw).length;
  let found = 0;
  const live = () => String(t.p.caption());
  // the first claim is held at its gate; the rest queue behind it. The room is 24, so the lane pauses once more than 48 wait.
  while (found < 80 && !/paused/.test(live())) await t.found(N(++found), "gpu");
  assert.ok(found >= 49 && found <= 51, `the lane paused after ${found} solutions`);
  assert.match(live(), /^Graphics card paused: \d+ solutions are waiting to be paid\./);
  assert.equal(gw.posts.at(-1).type, "stop", "the GPU worker was told to stop");
  const gpuStarts = startsOf(gw).length;
  assert.ok(gpuStarts >= startsAtFirst, "it had been started before");
  // more solutions that were already on their way are still accepted: nothing is dropped
  const rows = countRows(t.p.el("[data-mine-solutions]").innerHTML);
  assert.equal(rows, found, "every solution found is a row");
  await t.found(N(found + 1), "cpu"); // the processor lane keeps finding
  assert.equal(countRows(t.p.el("[data-mine-solutions]").innerHTML), found + 1);
  assert.equal(startsOf(gw).length, gpuStarts, "the paused lane got no new challenge");
  assert.match(String(t.p.el("[data-mine-gpu]").textContent), /paused/);
  // the wallet catches up: claims go out one by one; at 24 left the lane joins the current challenge again
  let guard = 0;
  while (/paused/.test(live()) && guard++ < 200) {
    const open = [...t.gates.keys()].filter((n) => t.calls.includes(n) && !/Receipt/.test(String(t.row(n))));
    if (!open.length) break;
    await t.release(open[0]);
  }
  assert.doesNotMatch(live(), /paused/, "the lane searches again");
  assert.equal(startsOf(gw).length, gpuStarts + 1, "it got the current challenge");
  const sent = [...Array(found + 1).keys()].filter((i) => /Receipt/.test(String(t.row(N(i + 1))))).length;
  assert.ok(sent >= found + 1 - 24 - 2, `most solutions were paid while it was paused (${sent})`);
  assert.equal(countRows(t.p.el("[data-mine-solutions]").innerHTML), found + 1, "none was dropped");
  t.p.off();
});

test("solutions whose window closed leave the claim queue at once: no claim step, no request, no reference hash for them; their notes are released", async () => {
  const released = [];
  const t = claimPage(() => null);
  t.p.s.releaseDraft = (d) => released.push(d);
  await settle();
  await t.p.click("mine-start");
  await settle();
  for (let i = 1; i <= 40; i++) await t.found(N(i));
  assert.deepEqual(t.calls, [N(1)], "one claim at a time; the other 39 queue");
  // blocks pass while the first claim proves (a laptop that slept): the window of every one of them (ref 329,990) is closed
  t.p.s.view.height = 330_020;
  await t.release(N(1));
  await settle();
  assert.deepEqual(t.calls, [N(1)], "the 39 closed solutions cost no claim attempt");
  assert.equal(released.length >= 39, true, "their notes are free again");
  for (const i of [2, 20, 40]) assert.match(t.row(N(i)), /Expired/);
  t.p.off();
});

test("a short line on the Mine page says the processor pauses while a claim is proved with the graphics card on; it shows only while the box is ticked", async () => {
  const p = page();
  await settle();
  assert.doesNotMatch(p.controls(), /data-mine-gpu-cpu-pause/);
  p.tick(true);
  assert.match(p.controls(), /<p class="caption t-3" data-mine-gpu-cpu-pause>While a claim is being proved with the graphics card on, the processor pauses and reads 0 H\/s; it mines again when the proof is done\.<\/p>/);
  assert.equal(V.GPU_TEXT.cpuPause.split(". ").length, 1, "one sentence");
  p.tick(false);
  assert.doesNotMatch(p.controls(), /data-mine-gpu-cpu-pause/);
  p.off();
});

test("ClaimQueue: a solution the user clicked (force) goes before the backlog, oldest first among the clicked; without live() every closed solution costs a run, with it none does", async () => {
  const ran = [];
  const gates = new Map();
  const q = new V.ClaimQueue(async (s) => {
    ran.push(s.key);
    gates.set(s.key, deferred());
    await gates.get(s.key).promise;
    s.status = "submitted";
  });
  const first = sol("first", 100);
  q.add(first);
  await settle();
  const backlog = ["b1", "b2", "b3"].map((k, i) => sol(k, 101 + i));
  for (const x of backlog) q.add(x);
  const clicked = sol("clicked", 110, { force: true });
  const clicked2 = sol("clicked2", 109, { force: true });
  q.add(clicked);
  q.add(clicked2);
  await settle();
  gates.get("first").resolve();
  await settle();
  assert.equal(ran[1], "clicked2", "the clicked solutions go before the backlog, the older one first");
  gates.get("clicked2").resolve();
  await settle();
  assert.equal(ran[2], "clicked");
  gates.get("clicked").resolve();
  await settle();
  assert.deepEqual(ran.slice(3), ["b1"], "then the backlog, oldest first");
  gates.get("b1").resolve();
  gates.get("b2")?.resolve();
  await settle();
  gates.get("b2")?.resolve();
  gates.get("b3")?.resolve();
  await settle();
  gates.get("b3")?.resolve();
  await settle();

  // live(): the closed ones never reach run()
  const open = new Set(["open"]);
  const mk = (live) => {
    const calls = [];
    const queue = new V.ClaimQueue(async (s) => { calls.push(s.key); s.status = "submitted"; }, live ? { live: (x) => open.has(x.key) } : {});
    return { calls, queue };
  };
  const withLive = mk(true);
  const without = mk(false);
  for (const m of [withLive, without]) for (const k of ["closed1", "closed2", "open"]) m.queue.add(sol(k, 100));
  await settle();
  assert.deepEqual(withLive.calls, ["open"], "with live() the closed solutions cost no run");
  assert.equal(without.calls.length, 3, "without it every one of them is run");
});

test("a click on Claim for the newest of a long backlog is proved right after the claim that is running, and its row reads Queued at once", async () => {
  const t = claimPage(() => null);
  await settle();
  await t.p.click("mine-start");
  await settle();
  for (let i = 1; i <= 30; i++) await t.found(N(i));
  assert.deepEqual(t.calls, [N(1)]);
  const key = /data-key="([^"]+)" data-nonce="0*1e"/.exec(String(t.p.el("[data-mine-solutions]").innerHTML))?.[1];
  assert.ok(key, "the row of the 30th solution is drawn");
  await t.p.click("mine-claim", key);
  assert.match(t.row(N(30)), /Queued/);
  await t.release(N(1));
  assert.deepEqual(t.calls, [N(1), N(30)], "the clicked solution is next, not 29th");
  t.p.off();
});

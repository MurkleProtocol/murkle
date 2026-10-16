// The lab's browser side without a browser or a GPU: web/src/lab/gpu-worker.js (the GPU lane worker) over the real engine
// on the stand-in WebGPU of test/fixtures/fake-webgpu.mjs, web/src/lab/pow-pool-worker.js, and the lab page's controller
// (web/src/lab/lab-gpu.js) wired to both through in-memory message channels. The CPU reference is a stand-in whose
// Argon2 is sha256 (known vectors answer with their true tags). navigator.gpu is never read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha256";
import { hex, unhex } from "../src/bytes.mjs";
import { GPU_SELF_TEST_VECTORS } from "../src/gpu-gate.mjs";
import { SELF_TEST_VECTORS, nonceOf, passwordOf } from "../src/mine.mjs";
import { openWebGpu } from "../src/webgpu/engine.mjs";
import { createGpuWorker } from "../web/src/lab/gpu-worker.js";
import { createPowPoolWorker } from "../web/src/lab/pow-pool-worker.js";
import { LabController, poolSizeOf } from "../web/src/lab/lab-gpu.js";
import { createFakeGpu } from "./fixtures/fake-webgpu.mjs";

const ALL_VECTORS = [...SELF_TEST_VECTORS.filter((v) => !v.salt && v.password.length === 80), ...GPU_SELF_TEST_VECTORS];
const TRUE_TAGS = new Map(ALL_VECTORS.map((v) => [v.password, unhex(v.powHash)]));
const tagOf = (pw) => TRUE_TAGS.get(hex(pw)) ?? sha256(pw);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await sleep(5);
  }
};
const CH = hex(new Uint8Array(32).map((_, i) => 3 * i + 1));
const mineStub = { selfTest: async () => ({ ok: true, impl: "hash-wasm" }), powHash: async (pw) => tagOf(pw) };

/** A gpu worker over a fake GPU: -> { w (the logic), out (messages posted), fake, gpu } */
function rig({ fake = {}, open = {}, getGpu, mine = mineStub, maxRestarts = 3 } = {}) {
  const f = createFakeGpu({ tagOf, ...fake });
  const out = [];
  const w = createGpuWorker({
    post: (m) => out.push(m),
    getGpu: getGpu ?? (() => f.gpu),
    open: (o) => openWebGpu({ ...o }),
    openOpts: { browser: true, mode: "gpu", segments: 3, hpw: 2, ...open },
    mine,
    maxRestarts,
  });
  const of = (type) => out.filter((m) => m.type === type);
  return { w, out, of, fake: f };
}
const OPEN = { type: "open", memoryMiB: 32, hpw: 2 };

test("open: gpu-info after the engine, then ready (impl webgpu) after the CPU self-test and gpuSelfTest; nothing before the open message", async () => {
  let reads = 0;
  const { w, out, of, fake } = rig({ getGpu: () => (reads++, fake0.gpu) });
  const fake0 = fake;
  assert.equal(reads, 0, "navigator.gpu is not read by creating the worker");
  w.onMessage(OPEN);
  await until(() => of("ready").length || of("lane-off").length);
  assert.equal(of("lane-off").length, 0, JSON.stringify(of("lane-off")));
  assert.deepEqual(out.map((m) => m.type), ["gpu-info", "ready"]);
  assert.equal(of("gpu-info")[0].info.slots, 8);
  assert.equal(of("gpu-info")[0].info.name, "Fake WebGPU adapter");
  assert.deepEqual(of("ready")[0], { type: "ready", ok: true, impl: "webgpu", name: "Fake WebGPU adapter" });
  assert.equal(w.state().state, "ready");
  w.onMessage(OPEN);
  await sleep(20);
  assert.equal(out.length, 2, "a second open is ignored");
  w.onMessage({ type: "lab-close", id: 1 });
  await until(() => of("lab-result").length);
});

test("no WebGPU in the browser: lane-off with the sentence, the worker idles and ignores a start", async () => {
  const { w, out, of } = rig({ getGpu: () => undefined });
  w.onMessage(OPEN);
  await until(() => of("lane-off").length);
  assert.deepEqual(of("lane-off")[0], { type: "lane-off", reason: "This browser has no WebGPU." });
  w.onMessage({ type: "start", id: 1, challenge: CH, target: "ff".repeat(32), nonceStart: "0000000000000000" });
  await sleep(30);
  assert.equal(out.length, 1);
  assert.equal(w.state().state, "off");
});

test("no adapter, a failed CPU self-test and a failed gpuSelfTest each give lane-off with a reason", async () => {
  const none = rig({ fake: { adapterNull: true } });
  none.w.onMessage(OPEN);
  await until(() => none.of("lane-off").length);
  assert.match(none.of("lane-off")[0].reason, /adapter/i);

  const bad = rig({ mine: { selfTest: async () => ({ ok: false, impl: null }), powHash: mineStub.powHash } });
  bad.w.onMessage(OPEN);
  await until(() => bad.of("lane-off").length);
  assert.match(bad.of("lane-off")[0].reason, /test hash wrong/);
  assert.equal(bad.of("gpu-info").length, 0, "the GPU is not even opened when the CPU reference is wrong");

  let flip = false;
  const wrong = rig({ open: { _afterReadback: (tags) => flip && (tags[40] ^= 0x10) } });
  flip = true;
  wrong.w.onMessage(OPEN);
  await until(() => wrong.of("lane-off").length);
  assert.equal(wrong.of("gpu-info").length, 1);
  assert.equal(wrong.of("ready").length, 0);
  assert.match(wrong.of("lane-off")[0].reason, /vector|hashed/i);
  assert.equal(wrong.of("lane-off")[0].wrong, true, "a wrong GPU answer in its self-test marks the lane-off as wrong");
  assert.equal(none.of("lane-off")[0].wrong, undefined, "no adapter is not a wrong answer");
  assert.equal(bad.of("lane-off")[0].wrong, undefined, "a failed CPU self-test is not the GPU's fault");
});

test("start: progress with lane gpu and the id echoed, found with the CPU reference's hash, then it idles", async () => {
  const { w, of, out } = rig();
  w.onMessage(OPEN);
  await until(() => of("ready").length);
  // a loose target: the first batch holds hits; powHash is the reference's value (here tagOf), the nonce is the first one
  const start = 0x0102030405060708n;
  const nonceStart = hex(nonceOf(start));
  w.onMessage({ type: "start", id: 7, challenge: CH, target: "ff".repeat(32), nonceStart });
  await until(() => of("found").length);
  const f = of("found")[0];
  assert.equal(f.id, 7);
  assert.equal(f.lane, "gpu");
  assert.equal(f.nonce, nonceStart);
  assert.equal(f.powHash, hex(sha256(passwordOf(unhex(CH), nonceOf(start)))), "the reference's hash, not the GPU's");
  assert.equal(f.hashes, 8, "one batch of 8 slots through the first hit");
  assert.ok(of("progress").every((p) => p.lane === "gpu" && p.id === 7));
  assert.equal(of("progress").reduce((a, p) => a + p.hashes, 0), 8, "the hashes of the round were reported");
  const n = out.length;
  await sleep(50);
  assert.equal(out.length, n, "idle after found");
  assert.equal(w.state().running, false);
});

test("start: a search that finds nothing reports progress about every progressMs; stop and a new start end it; bad input is an error", async () => {
  const { w, of } = rig();
  w.onMessage(OPEN);
  await until(() => of("ready").length);
  w.onMessage({ type: "start", id: 1, challenge: CH, target: "00".repeat(32), nonceStart: "0000000000000000", progressMs: 30 });
  await until(() => of("progress").length >= 3);
  assert.ok(of("progress").every((p) => p.id === 1 && p.hashes > 0 && p.ms >= 1));
  w.onMessage({ type: "stop" });
  await sleep(60);
  const n = of("progress").length;
  await sleep(120);
  assert.equal(of("progress").length, n, "no progress after stop (the last part was flushed before)");
  assert.equal(of("found").length, 0);
  // a new start replaces a running one, with its own id
  w.onMessage({ type: "start", id: 2, challenge: CH, target: "00".repeat(32), progressMs: 30 });
  await until(() => of("progress").some((p) => p.id === 2));
  w.onMessage({ type: "start", id: 3, challenge: CH, target: "00".repeat(32), progressMs: 30 });
  await until(() => of("progress").some((p) => p.id === 3));
  w.onMessage({ type: "stop" });
  w.onMessage({ type: "start", id: 4, challenge: "zz", target: "00".repeat(32) });
  assert.match(of("error").at(-1).message, /challenge must be 32 bytes of hex/);
  w.onMessage({ type: "start", id: 5, challenge: CH, target: "00".repeat(32), step: 2 });
  assert.match(of("error").at(-1).message, /step must be 1/);
  w.onMessage({ type: "nonsense" });
  assert.match(of("error").at(-1).message, /unknown message/);
  w.onMessage({ type: "verify", id: 9, password: "00".repeat(40) });
  assert.deepEqual(of("verified")[0], { type: "verified", id: 9, error: "verify on a CPU worker" });
});

test("a start before the lane is ready is kept and runs once it is ready", async () => {
  const { w, of } = rig();
  w.onMessage(OPEN);
  w.onMessage({ type: "start", id: 11, challenge: CH, target: "ff".repeat(32), nonceStart: "0100000000000000" });
  await until(() => of("found").length);
  assert.ok(of("ready").length === 1 && of("ready")[0] !== undefined);
  assert.equal(of("found")[0].id, 11);
});

test("a wrong tag from the GPU after the self-test: lane-off with the lane's sentence, nothing is found, the worker stays off", async () => {
  let flip = false;
  const { w, of } = rig({ open: { _afterReadback: (tags) => flip && (tags[0] ^= 0x01) } });
  w.onMessage(OPEN);
  await until(() => of("ready").length);
  flip = true;
  w.onMessage({ type: "start", id: 3, challenge: CH, target: "ff".repeat(32), nonceStart: "0000000000000005" });
  await until(() => of("lane-off").length);
  assert.match(of("lane-off")[0].reason, /disabled: it reported a nonce whose Argon2 hash differs from the reference; nothing was paid for it/);
  assert.equal(of("lane-off")[0].wrong, true);
  assert.equal(of("found").length, 0);
  assert.equal(w.state().state, "off");
  w.onMessage({ type: "start", id: 4, challenge: CH, target: "ff".repeat(32) });
  await sleep(40);
  assert.equal(of("found").length, 0, "an off lane stays off");
});

test("a lost device is restarted through GpuLane (new device, self-test) and mining goes on", async () => {
  const { w, of, fake } = rig();
  w.onMessage(OPEN);
  await until(() => of("ready").length);
  w.onMessage({ type: "start", id: 1, challenge: CH, target: "00".repeat(32), progressMs: 20 });
  await until(() => of("progress").length >= 1);
  fake.state.devices[0].lose("GPU reset");
  await until(() => fake.state.deviceRequests.length >= 2, 15_000);
  const n = of("progress").length;
  await until(() => of("progress").length >= n + 2, 15_000);
  assert.equal(of("lane-off").length, 0);
  assert.equal(w.state().state, "ready");
  w.onMessage({ type: "stop" });
});

test("a device that keeps getting lost runs the restarts out: lane-off", async () => {
  const { w, of, fake } = rig({ maxRestarts: 1 });
  w.onMessage(OPEN);
  await until(() => of("ready").length);
  w.onMessage({ type: "start", id: 1, challenge: CH, target: "00".repeat(32), progressMs: 20 });
  await until(() => of("progress").length >= 1);
  fake.state.devices[0].lose("GPU reset");
  await until(() => fake.state.deviceRequests.length >= 2, 15_000);
  const n = of("progress").length;
  await until(() => of("progress").length >= n + 1, 15_000); // mining again on the second device
  fake.state.devices.at(-1).lose("GPU reset again");
  await until(() => of("lane-off").length, 15_000);
  assert.match(of("lane-off")[0].reason, /disabled/);
  assert.equal(w.state().state, "off");
});

test("lab extras: info, selftest, hash (GPU only), bench with ticks; they refuse before open", async () => {
  const { w, of } = rig();
  w.onMessage({ type: "lab-info", id: 1 });
  await until(() => of("lab-result").length);
  assert.equal(of("lab-result")[0].ok, false);
  assert.match(of("lab-result")[0].error, /not open/);
  w.onMessage(OPEN);
  await until(() => of("ready").length);
  w.onMessage({ type: "lab-info", id: 2 });
  w.onMessage({ type: "lab-selftest", id: 3 });
  const pw = [new Uint8Array(40).fill(1), new Uint8Array(40).fill(2), unhex(ALL_VECTORS[0].password)];
  w.onMessage({ type: "lab-hash", id: 4, passwords: pw.map((p) => hex(p)) });
  await until(() => of("lab-result").length >= 4);
  const r = (id) => of("lab-result").find((m) => m.id === id);
  assert.equal(r(2).result.info.slots, 8);
  assert.equal(r(2).result.stats.batches >= 0, true);
  assert.equal(r(3).ok, true, JSON.stringify(r(3)));
  assert.equal(r(3).result.vectors, 20);
  assert.deepEqual(r(4).result.hashes, pw.map((p) => hex(tagOf(p))));
  w.onMessage({ type: "lab-hash", id: 5, passwords: ["00"] });
  await until(() => r(5));
  assert.equal(r(5).ok, false);
  w.onMessage({ type: "lab-bench", id: 6, seconds: 1 });
  await until(() => r(6), 20_000);
  assert.equal(r(6).ok, true, JSON.stringify(r(6)));
  assert.ok(r(6).result.hashes > 0 && r(6).result.hs > 0 && r(6).result.seconds >= 1);
  assert.ok(of("lab-bench-tick").length >= 1 && of("lab-bench-tick").every((t) => t.id === 6 && t.hs > 0));
  w.onMessage({ type: "lab-close", id: 7 });
  await until(() => r(7));
  assert.equal(r(7).ok, true);
  w.onMessage({ type: "lab-info", id: 8 });
  await until(() => r(8));
  assert.equal(r(8).ok, false, "after lab-close the lane is closed");
});

test("verifyVia page: the self-test's reference hashes come from the page (lab-verify / lab-verified)", async () => {
  const { w, of, out } = rig();
  let asked = 0;
  const pump = setInterval(() => {
    for (const m of out.filter((x) => x.type === "lab-verify" && !x.answered)) {
      m.answered = true;
      asked += m.passwords.length;
      w.onMessage({ type: "lab-verified", rid: m.rid, hashes: m.passwords.map((p) => hex(tagOf(unhex(p)))) });
    }
  }, 2);
  try {
    w.onMessage({ ...OPEN, verifyVia: "page" });
    await until(() => of("ready").length || of("lane-off").length);
    assert.equal(of("lane-off").length, 0, JSON.stringify(of("lane-off")));
    assert.ok(asked >= 32 + 8, `the page verified ${asked} hashes`);
  } finally {
    clearInterval(pump);
  }
  // a page that answers with an error fails the open
  const bad = rig();
  const pump2 = setInterval(() => {
    for (const m of bad.out.filter((x) => x.type === "lab-verify" && !x.answered)) {
      m.answered = true;
      bad.w.onMessage({ type: "lab-verified", rid: m.rid, error: "pool is closed" });
    }
  }, 2);
  try {
    bad.w.onMessage({ ...OPEN, verifyVia: "page" });
    await until(() => bad.of("lane-off").length);
    assert.match(bad.of("lane-off")[0].reason, /pool is closed|failed/);
  } finally {
    clearInterval(pump2);
  }
});

test("pow-pool-worker: ready after its self-test, hashes in order, errors answered with the id", async () => {
  const out = [];
  const w = createPowPoolWorker({ post: (m) => out.push(m), mine: { selfTest: async () => ({ ok: true, impl: "noble" }), powHash: async (pw) => sha256(pw) } });
  await w.ready;
  assert.deepEqual(out[0], { type: "ready", ok: true, impl: "noble" });
  const a = hex(new Uint8Array(40).fill(1));
  const b = hex(new Uint8Array(40).fill(2));
  w.onMessage({ id: 5, type: "hash", passwords: [a, b] });
  w.onMessage({ id: 6, type: "grind" });
  w.onMessage({ id: 7, type: "hash", passwords: ["zz"] });
  await until(() => out.length >= 4);
  assert.deepEqual(out[1], { id: 5, ok: true, hashes: [hex(sha256(unhex(a))), hex(sha256(unhex(b)))] });
  assert.deepEqual(out[2], { id: 6, ok: false, error: "unknown task grind" });
  assert.equal(out[3].ok, false);
  const refused = [];
  const bad = createPowPoolWorker({ post: (m) => refused.push(m), mine: { selfTest: async () => ({ ok: false, impl: null }), powHash: async () => new Uint8Array(32) } });
  await bad.ready;
  bad.onMessage({ id: 1, type: "hash", passwords: [a] });
  await until(() => refused.length >= 2);
  assert.deepEqual(refused[0], { type: "ready", ok: false, impl: null });
  assert.deepEqual(refused[1], { id: 1, ok: false, error: "Argon2 self-test failed" });
});

/* ---------- the lab page's controller, wired to both workers ---------- */

/** An in-memory worker: page -> logic.onMessage (a clone), logic's post -> w.onmessage({ data }). */
function channel(make) {
  const w = {
    onmessage: null,
    terminated: false,
    postMessage(m) {
      const c = structuredClone(m);
      setImmediate(() => this.logic.onMessage(c));
    },
    terminate() {
      this.terminated = true;
    },
  };
  w.logic = make((m) => setImmediate(() => !w.terminated && w.onmessage?.({ data: structuredClone(m) })));
  return w;
}
function lab(over = {}) {
  const f = createFakeGpu({ tagOf });
  const gpuWorkers = [];
  const powWorkers = [];
  let visibility = "visible";
  const ctl = new LabController({
    spawnGpu: () => {
      const w = channel((post) => createGpuWorker({ post, getGpu: () => f.gpu, open: (o) => openWebGpu({ ...o }), openOpts: { browser: true, mode: "gpu", segments: 3 }, mine: mineStub }));
      gpuWorkers.push(w);
      return w;
    },
    spawnPow: () => {
      const w = channel((post) => createPowPoolWorker({ post, mine: mineStub }));
      powWorkers.push(w);
      return w;
    },
    visibility: () => visibility,
    poolSize: 2,
    ...over,
  });
  return { ctl, f, gpuWorkers, powWorkers, setVisibility: (v) => (visibility = v) };
}

test("LabController: nothing is spawned or opened until open(); open runs the whole check with the page's pool as the reference", async () => {
  const { ctl, f, gpuWorkers, powWorkers } = lab();
  assert.equal(gpuWorkers.length, 0);
  assert.equal(powWorkers.length, 0);
  assert.equal(f.state.adapterRequests.length, 0, "no adapter was requested at construction");
  await assert.rejects(ctl.selfTest(), /Press Open GPU first/);
  const r = await ctl.open({ memoryMiB: 32, hpw: 2 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.info.slots, 8);
  assert.equal(gpuWorkers.length, 1);
  assert.equal(powWorkers.length, 2);
  assert.equal(f.state.adapterRequests.length, 1);
  assert.deepEqual((await ctl.open()).ok, true, "opening again returns the open lane");
  const st = await ctl.selfTest();
  assert.equal(st.vectors, 20);
  assert.equal((await ctl.info()).info.slots, 8);
  await ctl.close();
  assert.equal(gpuWorkers[0].terminated, true);
  assert.equal(ctl.state, "closed");
});

test("LabController: correct() compares the GPU with the pool; a lying GPU is counted and listed (at most 5)", async () => {
  const { ctl } = lab();
  const ok = await ctl.open({ memoryMiB: 32, hpw: 2 });
  assert.equal(ok.ok, true);
  const good = await ctl.correct(300);
  assert.deepEqual(good, { n: 300, mismatches: 0, first: [] });
  // a reference pool that disagrees on every password
  const bad = lab();
  await bad.ctl.open({ memoryMiB: 32, hpw: 2 });
  const real = bad.ctl.pool.hashMany.bind(bad.ctl.pool);
  bad.ctl.pool.hashMany = async (p) => (await real(p)).map((h) => (h[0] ^= 1, h));
  const r = await bad.ctl.correct(10);
  assert.equal(r.mismatches, 10);
  assert.equal(r.first.length, 5);
  assert.equal(r.first[0].password.length, 80);
  await ctl.close();
  await bad.ctl.close();
});

test("LabController: bench() reports ticks with the tab's visibility; hidden() splits the rate by visibility", async () => {
  const { ctl, setVisibility } = lab();
  await ctl.open({ memoryMiB: 32, hpw: 2 });
  const seen = [];
  ctl.onTick = (t) => seen.push(t);
  const b = await ctl.bench(1);
  assert.ok(b.hs > 0 && b.hashes > 0);
  assert.ok(b.ticks.length >= 1 && b.ticks.every((t) => t.visibility === "visible" && t.hs > 0));
  assert.equal(seen.length, b.ticks.length);
  setVisibility("hidden");
  const h = await ctl.hidden(2);
  assert.ok(h.hiddenSeconds >= 1 && h.visibleSeconds === 0);
  assert.ok(h.hsHidden > 0 && h.hsVisible === null && h.ratio === null);
  await ctl.close();
});

test("LabController: a GPU that cannot start gives { ok: false, reason } and the other calls fail with that reason", async () => {
  const f = createFakeGpu({ tagOf, adapterNull: true });
  const ctl = new LabController({
    spawnGpu: () => channel((post) => createGpuWorker({ post, getGpu: () => f.gpu, open: (o) => openWebGpu({ ...o }), openOpts: { browser: true, mode: "gpu", segments: 3 }, mine: mineStub })),
    spawnPow: () => channel((post) => createPowPoolWorker({ post, mine: mineStub })),
    poolSize: 1,
  });
  const r = await ctl.open({ memoryMiB: 32, hpw: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /adapter/i);
  assert.equal(ctl.state, "off");
  await assert.rejects(ctl.selfTest());
  await ctl.close();
});

test("LabController: opening again after a failed open releases the first worker and pool", async () => {
  const f = createFakeGpu({ tagOf, adapterNull: true });
  const gpuWorkers = [];
  const powWorkers = [];
  const ctl = new LabController({
    spawnGpu: () => {
      const w = channel((post) => createGpuWorker({ post, getGpu: () => f.gpu, open: (o) => openWebGpu({ ...o }), openOpts: { browser: true, mode: "gpu", segments: 3 }, mine: mineStub }));
      gpuWorkers.push(w);
      return w;
    },
    spawnPow: () => {
      const w = channel((post) => createPowPoolWorker({ post, mine: mineStub }));
      powWorkers.push(w);
      return w;
    },
    poolSize: 1,
  });
  assert.equal((await ctl.open({ memoryMiB: 32, hpw: 2 })).ok, false);
  assert.equal((await ctl.open({ memoryMiB: 32, hpw: 2 })).ok, false);
  assert.equal(gpuWorkers.length, 2);
  assert.equal(gpuWorkers[0].terminated, true, "the first GPU worker was terminated");
  assert.equal(powWorkers[0].terminated, true, "the first pool's worker was terminated");
  await ctl.close();
  assert.equal(gpuWorkers[1].terminated, true);
});

test("poolSizeOf: min(4, cores - 1), at least 1", () => {
  assert.equal(poolSizeOf(16), 4);
  assert.equal(poolSizeOf(4), 3);
  assert.equal(poolSizeOf(2), 1);
  assert.equal(poolSizeOf(1), 1);
  assert.equal(poolSizeOf(NaN), 1);
});

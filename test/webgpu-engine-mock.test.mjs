// The host logic of the WebGPU engine (src/webgpu/engine.mjs) against a stand-in for the WebGPU API
// (test/fixtures/fake-webgpu.mjs): the guard, adapter and limits, banks, segments, the start-up checks, memory
// halving, calibration, the watchdog, device loss, close(), and the unmodified gate on top. No GPU, no `webgpu`
// package. The kernels are not run here (the fake answers sha256 tags); test/webgpu-wgsl-exec.test.mjs runs the
// kernel text, and one test below runs the engine over the real kernel text on the interpreter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import v8 from "node:v8";
import vm from "node:vm";
import { sha256 } from "@noble/hashes/sha256";
import { hex, unhex } from "../src/bytes.mjs";
import { GPU_SELF_TEST_VECTORS, GpuError, GpuLane, gpuSelfTest } from "../src/gpu-gate.mjs";
import { SELF_TEST_VECTORS, nonceOf, passwordOf } from "../src/mine.mjs";
import { bankCapacities, fillRandom, openWebGpu, segmentEdges } from "../src/webgpu/engine.mjs";
import { createFakeGpu } from "./fixtures/fake-webgpu.mjs";

const SLOW = process.env.MURKLE_SLOW_TESTS === "1";
const GPU_ENV = { MURKLE_WEBGPU: "gpu" };
const ALL_VECTORS = [...SELF_TEST_VECTORS.filter((v) => !v.salt && v.password.length === 80), ...GPU_SELF_TEST_VECTORS];
const TRUE_TAGS = new Map(ALL_VECTORS.map((v) => [v.password, unhex(v.powHash)]));
const tagOf = (pw) => TRUE_TAGS.get(hex(pw)) ?? sha256(pw);
const pws = (n, seed = 1) => Array.from({ length: n }, (_, i) => sha256(Uint8Array.of(seed, i, i >> 8)).subarray(0, 8).reduce((a, x, k) => ((a[32 + k] = x), (a[k] = i + seed), a), new Uint8Array(40)));
const open = (fakeOptions = {}, engineOptions = {}) => {
  const fake = createFakeGpu({ tagOf, ...fakeOptions });
  return openWebGpu({ gpu: fake.gpu, mode: "gpu", env: GPU_ENV, platform: "linux", memoryMiB: 16, hpw: 2, segments: 3, ...engineOptions }).then((dev) => ({ dev, ...fake }));
};
const fillsOf = (state, bank) => state.dispatches.filter((d) => d.entry === "k_fill" && d.bank === bank);

test("segmentEdges and bankCapacities: even pieces of [2, 4096), banks that are multiples of HPW", () => {
  for (const K of [1, 2, 7, 64, 256]) {
    const e = segmentEdges(K);
    assert.equal(e.length, K + 1);
    assert.equal(e[0], 2);
    assert.equal(e[K], 4096);
    for (let i = 0; i < K; i++) assert.ok(e[i + 1] > e[i]);
    const sizes = e.slice(1).map((x, i) => x - e[i]);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1);
  }
  assert.throws(() => segmentEdges(0), RangeError);
  assert.throws(() => segmentEdges(257), RangeError);
  assert.deepEqual(bankCapacities(4, 1023, 2), [4]);
  assert.deepEqual(bankCapacities(4, 2, 2), [2, 2]);
  const big = bankCapacities(2048, 1023, 2);
  assert.equal(big.reduce((a, c) => a + c, 0), 2048);
  assert.ok(big.every((c) => c % 2 === 0 && c <= 1023));
  const caps = bankCapacities(4096, 1023, 8);
  assert.equal(caps.reduce((a, b) => a + b, 0), 4096);
  assert.ok(caps.every((c) => c % 8 === 0 && c <= 1023));
  assert.throws(() => bankCapacities(8, 1, 2), (e) => e.code === "GPU_NO_DEVICE");
});

test("the guard: a Node process without MURKLE_WEBGPU is refused before anything is requested", async () => {
  const fake = createFakeGpu();
  await assert.rejects(openWebGpu({ gpu: fake.gpu, mode: "gpu", env: {}, platform: "linux" }), (e) => e.code === "GPU_NO_DEVICE" && /disabled here/.test(e.message));
  await assert.rejects(openWebGpu({ gpu: fake.gpu, mode: "fallback", env: { MURKLE_WEBGPU: "fallback" }, platform: "win32" }), (e) => e.code === "GPU_NO_DEVICE");
  assert.equal(fake.state.adapterRequests.length, 0);
  await assert.rejects(openWebGpu({ gpu: null, mode: "gpu", env: GPU_ENV }), (e) => e.code === "GPU_NO_DEVICE");
});

test("fallback mode: forces the fallback adapter, asks again without it, and refuses a non-CPU adapter before requestDevice", async () => {
  const env = { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json" };
  const base = { gpu: null, mode: "fallback", env, platform: "linux", memoryMiB: 8, hpw: 1, segments: 2 };
  const a = createFakeGpu({ adapterNull: "first", isFallbackAdapter: true, tagOf });
  const dev = await openWebGpu({ ...base, gpu: a.gpu });
  assert.deepEqual(a.state.adapterRequests.map((r) => r.forceFallbackAdapter ?? false), [true, false]);
  assert.equal(dev.info.fallback, true);
  await dev.close();
  const gpuLike = createFakeGpu({ description: "NVIDIA GeForce RTX", isFallbackAdapter: false });
  await assert.rejects(openWebGpu({ ...base, gpu: gpuLike.gpu }), (e) => e.code === "GPU_NO_DEVICE" && /not a CPU/.test(e.message));
  assert.equal(gpuLike.state.deviceRequests.length, 0, "requestDevice was never called");
  const none = createFakeGpu({ adapterNull: true });
  await assert.rejects(openWebGpu({ ...base, gpu: none.gpu }), (e) => e.code === "GPU_NO_DEVICE" && /no WebGPU adapter/.test(e.message));
  // lavapipe by name is a CPU adapter too
  const lvp = createFakeGpu({ description: "llvmpipe (LLVM 15.0.7, 256 bits)", tagOf });
  await (await openWebGpu({ ...base, gpu: lvp.gpu })).close();
});

test("open: info, requested limits, pipelines, the start-up checks that ran, and the device contract", async () => {
  const { dev, state } = await open({}, { memoryMiB: 16, segments: 5 });
  try {
    assert.equal(dev.info.slots, 4);
    assert.equal(dev.info.banks, 1);
    assert.equal(dev.info.slotsPerBank, 4);
    assert.equal(dev.info.hpw, 2);
    assert.equal(dev.info.segments, 5);
    assert.equal(dev.info.device, 0);
    assert.equal(dev.info.name, "Fake WebGPU adapter");
    assert.equal(dev.info.version, "webgpu-proto-1");
    assert.equal(dev.info.limits.maxStorageBufferBindingSize, 128 * 1024 * 1024);
    assert.deepEqual(dev.info.features, { subgroups: false, timestampQuery: false });
    assert.equal(dev.info.calibration.skipped, true);
    assert.deepEqual(state.deviceRequests[0].requiredLimits, { maxStorageBufferBindingSize: 128 * 1024 * 1024, maxBufferSize: 128 * 1024 * 1024 });
    const entries = state.pipelines.map((p) => p.entryPoint).sort();
    assert.deepEqual(entries, ["k_fill", "k_final", "k_init", "k_kat", "k_prims"]);
    assert.deepEqual(state.pipelines.find((p) => p.entryPoint === "k_fill").constants, { HPW: 2 });
    assert.deepEqual(state.pipelines.find((p) => p.entryPoint === "k_init").constants, {});
    const ran = state.dispatches.map((d) => d.entry);
    assert.deepEqual(ran.slice(0, 2), ["k_kat", "k_prims"], "the checks come first");
    assert.equal(typeof dev.lost.then, "function");
    assert.deepEqual(Object.keys(dev.stats()).sort(), ["batches", "busyMs", "dispatchMsMax", "hashes", "lastBatchMs"]);
  } finally {
    await dev.close();
  }
});

test("hash(): any count, in order, over a bank of 4 slots; search finds the first batch with a hit", async () => {
  const { dev } = await open();
  try {
    const list = pws(10);
    const out = await dev.hash(list);
    assert.equal(out.length, 10);
    out.forEach((t, i) => assert.equal(hex(t), hex(sha256(list[i]))));
    const ch = new Uint8Array(32).fill(9);
    const r = await dev.search({ challenge: ch, target: (1n << 256n) - 1n, nonceStart: 5n, count: 100, probe: 2 });
    assert.equal(r.done, 4n);
    assert.equal(r.candidates.length, 4);
    assert.equal(hex(r.candidates[1].hash), hex(sha256(passwordOf(ch, nonceOf(6n)))));
    assert.equal(hex(r.probe.hash), hex(sha256(passwordOf(ch, nonceOf(7n)))));
    assert.ok(dev.stats().batches >= 4);
  } finally {
    await dev.close();
  }
});

test("banks: two banks of two slots (and four of one) give the same tags as one bank, with the right slotBase per bank", async () => {
  const list = pws(8, 3);
  const one = await open({}, { memoryMiB: 16, hpw: 2 });
  const want = (await one.dev.hash(list)).map(hex);
  await one.dev.close();
  for (const [hpw, perBank, banks] of [[2, 2, 2], [1, 1, 4], [1, 2, 2]]) {
    const { dev, state } = await open({}, { memoryMiB: 16, hpw, _slotsPerBankMax: perBank });
    try {
      assert.equal(dev.info.banks, banks);
      assert.deepEqual((await dev.hash(list)).map(hex), want);
      const inits = state.dispatches.filter((d) => d.entry === "k_init");
      assert.deepEqual(inits.slice(-banks).map((d) => d.slotBase), Array.from({ length: banks }, (_, b) => (b * 4) / banks));
      assert.ok(inits.every((d) => d.slots <= perBank));
      const finals = state.dispatches.filter((d) => d.entry === "k_final").slice(-banks);
      assert.deepEqual(finals.map((d) => [d.slotBase, d.slots]), Array.from({ length: banks }, (_, b) => [(b * 4) / banks, 4 / banks]));
      // every bank has its own memory buffer
      assert.equal(new Set(finals.map((d) => d.bank)).size, banks);
    } finally {
      await dev.close();
    }
  }
});

test("segments: K = 1 and K = 7 (an uneven split) give the same tags and cover blocks 2 .. 4095 exactly once, in order", async () => {
  const list = pws(4, 5);
  const want = list.map((p) => hex(sha256(p)));
  for (const K of [1, 7, 64]) {
    const { dev, state } = await open({}, { segments: K });
    try {
      state.dispatches.length = 0;
      assert.deepEqual((await dev.hash(list)).map(hex), want);
      const fills = fillsOf(state, state.dispatches.find((d) => d.entry === "k_fill").bank);
      assert.equal(fills.length, K);
      assert.equal(fills[0].segFrom, 2);
      assert.equal(fills.at(-1).segTo, 4096);
      fills.slice(1).forEach((f, i) => assert.equal(f.segFrom, fills[i].segTo));
      // _setSegments switches without touching the results
      await dev._setSegments(7);
      state.dispatches.length = 0;
      assert.deepEqual((await dev.hash(list)).map(hex), want);
      assert.equal(state.dispatches.filter((d) => d.entry === "k_fill").length, 7);
      assert.equal(dev.info.segments, 7);
    } finally {
      await dev.close();
    }
  }
});

test("a short batch is padded to the slots in use; the padding never reaches the caller", async () => {
  const { dev } = await open({}, { memoryMiB: 32, hpw: 2 });
  try {
    assert.equal(dev.info.slots, 8);
    const r = await dev.search({ challenge: new Uint8Array(32), target: (1n << 256n) - 1n, nonceStart: 0n, count: 3 });
    assert.equal(r.done, 3n);
    assert.equal(r.candidates.length, 3);
    assert.equal((await dev.hash(pws(3))).length, 3);
  } finally {
    await dev.close();
  }
});

test("the start-up checks: a wrong BLAKE2b answer, a wrong primitive and a shader that does not compile are refused", async () => {
  await assert.rejects(open({ corruptKat: true }), (e) => e.code === "GPU_SELF_TEST" && /abc/.test(e.message));
  await assert.rejects(open({ corruptPrims: true }), (e) => e.code === "GPU_SELF_TEST" && /mul32wide differs on this GPU/.test(e.message));
  await assert.rejects(open({ compileError: true }), (e) => e.code === "GPU_START" && /unexpected token/.test(e.message));
});

test("a throwing requestAdapter or requestDevice becomes a GpuError", async () => {
  await assert.rejects(open({ adapterError: "no backend" }), (e) => e.code === "GPU_NO_DEVICE" && /no backend/.test(e.message));
  await assert.rejects(open({ deviceError: "limit 4 not supported" }), (e) => e.code === "GPU_START" && /not supported/.test(e.message));
});

test("limits: no 4 MiB buffer, a workgroup too large for the device, and a small binding size gives more banks", async () => {
  await assert.rejects(open({ limits: { maxStorageBufferBindingSize: 1 << 20 } }), (e) => e.code === "GPU_NO_DEVICE" && /4 MiB/.test(e.message));
  await assert.rejects(open({ limits: { maxComputeInvocationsPerWorkgroup: 128 } }, { hpw: 8 }), (e) => e.code === "GPU_START" && /workgroup limits/.test(e.message));
  const { dev, state } = await open({ limits: { maxStorageBufferBindingSize: 8 << 20, maxBufferSize: 1 << 30 } }, { memoryMiB: 32, hpw: 2 });
  try {
    assert.equal(dev.info.slotsPerBank, 2, "8 MiB per binding = 2 slots");
    assert.equal(dev.info.banks, 4);
    assert.deepEqual(state.deviceRequests[0].requiredLimits, { maxStorageBufferBindingSize: 8 << 20, maxBufferSize: 8 << 20 });
  } finally {
    await dev.close();
  }
});

test("an allocation that fails is retried with half the slots, at most 6 times, then GPU_START with oom", async () => {
  const { dev, info } = await open({ memoryBudgetBytes: 40 * 1024 * 1024 }, { memoryMiB: 128, hpw: 2 }).then((x) => ({ ...x, info: x.dev.info }));
  try {
    assert.ok(info.slots * 4 <= 40 && info.slots >= 2, `slots ${info.slots}`);
    assert.ok(info.slots < 32);
  } finally {
    await dev.close();
  }
  await assert.rejects(open({ memoryBudgetBytes: 1024 }, { memoryMiB: 128 }), (e) => e.code === "GPU_START" && e.oom === true);
});

test("calibration: the segment count follows the measured cost, dispatches stay short, the slot count is kept when the GPU is fast", async () => {
  // a batch of 32 slots costs 32 * 4094 * 0.0003 = ~39 ms in total
  const { dev, state } = await open({ msPerBlockSlot: 0.0003 }, { memoryMiB: 128, hpw: 2, segments: undefined, targetDispatchMs: 8, maxDispatchMs: 40, targetBatchMs: 250 });
  try {
    assert.equal(dev.info.calibration.skipped, false);
    assert.equal(dev.info.slots, 32);
    assert.ok(dev.info.segments >= 2 && dev.info.segments <= 16, `segments ${dev.info.segments}`);
    assert.ok(dev.info.calibration.batchMs > 5);
    assert.ok(dev.info.calibration.dispatchMsMax > 0 && dev.info.calibration.dispatchMsMax < 40);
    assert.match(dev.info.calibration.dispatchMsSource, /batch time/);
    assert.ok(state.maxDispatchMs <= 40, `largest dispatch ${state.maxDispatchMs} ms`);
    assert.ok(dev.info.calibration.fillMsPerBlockPerSlot > 0);
  } finally {
    await dev.close();
  }
});

test("calibration: a slow GPU gets fewer slots; a hopeless one is refused", async () => {
  // 0.02 ms per block and slot: a batch of 16 slots takes 1.3 s, four times the batch target of 100 ms, so the slots are halved
  const slowish = await open({ msPerBlockSlot: 0.02 }, { memoryMiB: 64, hpw: 2, segments: undefined, targetDispatchMs: 10, maxDispatchMs: 30, targetBatchMs: 100 });
  try {
    assert.ok(slowish.dev.info.slots < 16, `slots ${slowish.dev.info.slots}`);
    assert.ok(slowish.state.maxDispatchMs <= 30, `largest dispatch ${slowish.state.maxDispatchMs}`);
  } finally {
    await slowish.dev.close();
  }
  await assert.rejects(open({ msPerBlockSlot: 0.1 }, { memoryMiB: 8, hpw: 2, segments: undefined, targetDispatchMs: 1, maxDispatchMs: 2 }), (e) => e.code === "GPU_START" && /too slow/.test(e.message));
});

test("calibration: a predicted batch far over the target is halved before it runs, so the watchdog does not kill the device during open", async () => {
  // 0.002 ms per block and slot: 64 slots would take about 520 ms, over the 500 ms watchdog (the first, small calibration batch of 32 slots takes 260 ms)
  const r = await open({ msPerBlockSlot: 0.002 }, { memoryMiB: 256, hpw: 2, segments: undefined, hangMs: 500 });
  try {
    assert.ok(r.dev.info.slots < 64, `slots ${r.dev.info.slots}`);
    assert.ok(r.dev.info.calibration.batchMs < 500, `batch ${r.dev.info.calibration.batchMs} ms`);
  } finally {
    await r.dev.close();
  }
  // a GPU too slow even for the smallest batch is refused as too slow, not as a hang
  await assert.rejects(open({ msPerBlockSlot: 0.04 }, { memoryMiB: 8, hpw: 2, segments: undefined, hangMs: 500 }), (e) => e.code === "GPU_START" && /too slow/.test(e.message));
});

test("the watchdog: a batch that does not finish within hangMs destroys the device and fails with GPU_TIMEOUT", async () => {
  const { dev, state } = await open({ msPerBlockSlot: 0 }, { hangMs: 150, segments: 2 });
  state.devices[0].busyUntil = performance.now() + 5000; // the queue is stuck
  await assert.rejects(dev.hash(pws(1)), (e) => e.code === "GPU_TIMEOUT" && /destroyed/.test(e.message));
  assert.equal(state.devices[0].destroyed, true);
  await assert.rejects(dev.hash(pws(1)), (e) => e.code === "GPU_TIMEOUT", "the device stays failed");
  await dev.close();
});

test("device loss in the middle of a search fails with GPU_EXITED and lost resolves; GpuLane restarts through reopen and goes on", async () => {
  const { dev, state } = await open({ msPerBlockSlot: 0.002 }, { segments: 4, pipelineDepth: 1 });
  const p = dev.search({ challenge: new Uint8Array(32), target: 0n, nonceStart: 0n, count: 1_000_000 });
  await new Promise((r) => setTimeout(r, 30));
  state.devices[0].lose("GPU reset");
  await assert.rejects(p, (e) => e.code === "GPU_EXITED" && /lost/.test(e.message));
  const l = await dev.lost;
  assert.equal(l.reason, "unknown");
  await dev.close();

  const fakes = [];
  const reopen = async () => {
    const x = await open({ msPerBlockSlot: 0.002 }, { segments: 3, pipelineDepth: 1 });
    fakes.push(x);
    return x.dev;
  };
  const verifyMany = async (list) => list.map((q) => tagOf(q));
  const lane = new GpuLane({ device: await reopen(), verifyMany, label: "WebGPU", reopen, maxRestarts: 2 });
  const ch = new Uint8Array(32).fill(3);
  const run = lane.grind({ challenge: ch, target: 0n, nonceStart: 0n, count: 1_000_000 });
  await new Promise((r) => setTimeout(r, 30));
  fakes[0].state.devices[0].lose();
  await assert.rejects(run, (e) => e.code === "GPU_EXITED");
  assert.equal(lane.restarts, 1);
  assert.equal(fakes.length, 2, "reopen made a second device");
  assert.equal(lane.disabled, null);
  const again = await lane.grind({ challenge: ch, target: (1n << 256n) - 1n, nonceStart: 0n, count: 8 });
  assert.ok(again.nonce, "the restarted lane mines");
  await lane.close();
});

test("close() releases every buffer and the device, and later calls fail with GPU_CLOSED", async () => {
  const { dev, state } = await open();
  await dev.hash(pws(2));
  await dev.close();
  assert.ok(state.buffers.length > 8);
  assert.ok(state.buffers.every((b) => b.destroyed), "every buffer destroyed");
  assert.equal(state.devices[0].destroyed, true);
  await assert.rejects(dev.hash(pws(1)), (e) => e.code === "GPU_CLOSED");
  await assert.rejects(dev.search({ challenge: new Uint8Array(32), target: 1n, nonceStart: 0n, count: 1 }), (e) => e.code === "GPU_CLOSED");
  await dev.close(); // twice is fine
});

// Dawn (the "webgpu" package) ends the native instance when the JS GPU object is collected, even while its adapter and
// device are in use (segfaults and futex errors on the rented boxes). The caller of openWebGpu may drop its reference.
async function collect() {
  v8.setFlagsFromString("--expose-gc");
  const gc = vm.runInNewContext("gc");
  for (let i = 0; i < 6; i++) {
    gc();
    await delay(5);
  }
}
// Nothing here keeps the GPU object but the engine: the helper returns only the device and a weak reference.
async function openDroppingGpu() {
  const fake = createFakeGpu({ tagOf });
  const weak = new WeakRef(fake.gpu);
  const dev = await openWebGpu({ gpu: fake.gpu, mode: "gpu", env: GPU_ENV, platform: "linux", memoryMiB: 16, hpw: 2, segments: 3 });
  return { dev, weak, state: fake.state };
}

test("the engine keeps the GPU object and the adapter alive while the device is open (garbage collection must not end Dawn's instance), and lets go in close()", async () => {
  const { dev, weak, state } = await openDroppingGpu();
  await collect();
  assert.ok(weak.deref(), "the GPU object was garbage-collected under a live device");
  assert.ok(dev._held().gpu === weak.deref() && typeof dev._held().adapter.requestDevice === "function");
  const [tag] = await dev.hash(pws(1)); // and the device still works after the collection
  assert.equal(tag.length, 32);
  await dev.close();
  assert.equal(dev._held(), null, "close() drops the GPU object");
  assert.equal(state.devices[0].destroyed, true);
  await collect();
  assert.equal(weak.deref(), undefined, "nothing else holds the GPU object after close()");
});

test("a failed open does not leak the GPU object either", async () => {
  const fake = createFakeGpu({ tagOf, corruptKat: true });
  const weak = new WeakRef(fake.gpu);
  await assert.rejects(openWebGpu({ gpu: fake.gpu, mode: "gpu", env: GPU_ENV, platform: "linux", memoryMiB: 16, hpw: 2, segments: 3 }), (e) => e.code === "GPU_SELF_TEST");
  fake.gpu = null;
  await collect();
  assert.equal(weak.deref(), undefined);
});

test("fillRandom: pieces of at most 65,536 bytes (the Web Crypto limit), every byte filled", () => {
  const sizes = [];
  const crypto = {
    getRandomValues(a) {
      if (a.byteLength > 65_536) throw Object.assign(new Error("The requested length exceeds 65,536 bytes"), { name: "QuotaExceededError" });
      sizes.push(a.byteLength);
      a.fill(0xa5);
      return a;
    },
  };
  const out = fillRandom(new Uint8Array(2048 * 40), crypto); // 8 GiB: 2,048 slots of 40 bytes
  assert.deepEqual(sizes, [65_536, 16_384]);
  assert.ok(out.every((x) => x === 0xa5));
  assert.equal(fillRandom(new Uint8Array(0), crypto).length, 0);
  assert.throws(() => globalThis.crypto.getRandomValues(new Uint8Array(65_537)), /65,536/, "the platform really has the limit");
  assert.equal(fillRandom(new Uint8Array(65_537)).length, 65_537);
});

test("memory from 8 GiB up: 2,048+ slots open and calibrate (the batch is above 65,536 bytes and the Params uniform buffer is above 64 KiB) within the device limits", { timeout: 120_000 }, async () => {
  const GiB = 1024 * 1024 * 1024;
  // the limits a real NVIDIA adapter reports: 2 GiB minus 4 bytes per binding, so 511 slots per bank and a short last bank;
  // the fake enforces maxUniformBufferBindingSize = 65,536 on every bind group and dynamic offset, as Dawn does
  const limits = { maxStorageBufferBindingSize: 2 * GiB - 4, maxBufferSize: 2 ** 40 };
  for (const [memoryMiB, slots] of [[8192, 2048], [16384, 4096]]) {
    const { dev, state } = await open({ limits }, { memoryMiB, hpw: 2, segments: undefined, targetBatchMs: 1e8, maxDispatchMs: 1e8, hangMs: 1e9 }); // generous: the fake's JS speed must not halve the slots
    try {
      assert.equal(dev.info.slots, slots);
      const caps = bankCapacities(slots, 511, 2);
      assert.equal(dev.info.banks, caps.length);
      assert.ok(caps.length > slots / 512, "more banks than a round 2 GiB split: 511 slots per bank, not 512");
      assert.equal(caps.reduce((a, b) => a + b, 0), slots);
      assert.ok(slots * 40 > 65_536, "the password batch is above the Web Crypto limit");
      const params = state.buffers.find((b) => b.label === "params");
      assert.equal(params.size, dev.info.banks * 258 * 256);
      if (slots === 2048) assert.ok(params.size > 65_536, "the Params buffer is bigger than one uniform binding is allowed to be");
      const uniformBinds = state.buffers.filter((b) => b.usage & 0x40);
      assert.ok(uniformBinds.length >= 2);
      const hs = await dev.hash(pws(slots + 3));
      assert.equal(hs.length, slots + 3);
      assert.equal(state.errors.length, 0);
    } finally {
      await dev.close();
    }
  }
});

test("the fake enforces the uniform limits it stands for: a binding above 64 KiB and a dynamic offset beyond the buffer are refused", async () => {
  const { gpu } = createFakeGpu();
  const adapter = await gpu.requestAdapter();
  const d = await adapter.requestDevice({});
  const bgl = d.createBindGroupLayout({ entries: [{ binding: 4, visibility: 4, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 } }] });
  const buf = d.createBuffer({ label: "u", size: 4096, usage: 0x40 | 0x8 });
  const big = d.createBuffer({ label: "ubig", size: 131_072, usage: 0x40 | 0x8 });
  assert.throws(() => d.createBindGroup({ layout: bgl, entries: [{ binding: 4, resource: { buffer: big } }] }), /maxUniformBufferBindingSize/);
  const bg = d.createBindGroup({ layout: bgl, entries: [{ binding: 4, resource: { buffer: buf, offset: 0, size: 16 } }] });
  const pass = d.createCommandEncoder().beginComputePass();
  pass.setBindGroup(0, bg, [4096 - 16 - ((4096 - 16) % 256)]);
  assert.throws(() => pass.setBindGroup(0, bg, [4096]), /beyond buffer/);
});

test("an unreported device error (onuncapturederror) fails the device with GPU_EXITED", async () => {
  const { dev, state } = await open();
  state.devices[0].onuncapturederror({ error: { message: "validation error in a dispatch" } });
  await assert.rejects(dev.hash(pws(1)), (e) => e.code === "GPU_EXITED" && /validation error/.test(e.message));
  await dev.close();
});

test("the unmodified gate runs on the engine: gpuSelfTest passes, and a flipped tag bit after readback fails it", async () => {
  const verifyMany = async (list) => list.map((q) => tagOf(q));
  const { dev } = await open({}, { memoryMiB: 32, hpw: 2 });
  try {
    const r = await gpuSelfTest(dev, { verifyMany });
    assert.equal(r.vectors, 20);
    assert.equal(r.slots, 8);
  } finally {
    await dev.close();
  }
  let flip = false;
  const bad = await open({}, { memoryMiB: 32, hpw: 2, _afterReadback: (tags) => flip && (tags[40] ^= 0x10) });
  try {
    flip = true;
    await assert.rejects(gpuSelfTest(bad.dev, { verifyMany }), (e) => e.code === "GPU_SELF_TEST");
  } finally {
    await bad.dev.close();
  }
});

test("GpuLane over the engine: a candidate is returned only when the reference agrees; a lying readback disables the lane", async () => {
  const verifyMany = async (list) => list.map((q) => tagOf(q));
  const { dev } = await open({}, { memoryMiB: 16, hpw: 2 });
  const lane = new GpuLane({ device: dev, verifyMany, label: "WebGPU" });
  const ch = new Uint8Array(32).fill(1);
  const target = (1n << 256n) / 4n;
  let hit = null;
  for (let i = 0; i < 20 && !hit; i++) {
    const r = await lane.grind({ challenge: ch, target, nonceStart: BigInt(i) * 100n, count: 100 });
    if (r.nonce) hit = r;
  }
  assert.ok(hit);
  assert.equal(hex(hit.powHash), hex(sha256(passwordOf(ch, hit.nonce))));
  await lane.close();
  const liar = await open({}, { memoryMiB: 16, hpw: 2, _afterReadback: (tags) => (tags[3] ^= 1) });
  const badLane = new GpuLane({ device: liar.dev, verifyMany, label: "WebGPU" });
  await assert.rejects(badLane.grind({ challenge: ch, target: (1n << 256n) - 1n, nonceStart: 0n, count: 8 }), (e) => e.code === "GPU_WRONG");
  assert.match(badLane.disabled, /disabled/);
});

test("a search of several batches submits one command buffer per batch, also with a deep pipeline", async () => {
  const { dev, state } = await open({ msPerBlockSlot: 0.0005 }, { segments: 2, pipelineDepth: 3 });
  try {
    state.submits = 0;
    const r = await dev.search({ challenge: new Uint8Array(32), target: 0n, nonceStart: 0n, count: 4 * 6 });
    assert.equal(r.done, 24n);
    assert.equal(state.submits, 6);
  } finally {
    await dev.close();
  }
});

test("the real kernel text on the interpreter, through the whole engine: one hash equals the vector tag (3 segments, k_kat and k_prims included)", { timeout: 120_000 }, async () => {
  const v = GPU_SELF_TEST_VECTORS[0];
  const fake = createFakeGpu({ exec: "interp" });
  const dev = await openWebGpu({ gpu: fake.gpu, mode: "gpu", env: GPU_ENV, platform: "linux", memoryMiB: 4, hpw: 1, segments: 3 });
  try {
    assert.equal(dev.info.slots, 1);
    const [tag] = await dev.hash([unhex(v.password)]);
    assert.equal(hex(tag), v.powHash);
  } finally {
    await dev.close();
  }
});

test("MURKLE_SLOW_TESTS=1: two banks of one slot with HPW 1 on the real kernel text, two different vectors", { skip: !SLOW && "set MURKLE_SLOW_TESTS=1", timeout: 300_000 }, async () => {
  const vs = [GPU_SELF_TEST_VECTORS[2], GPU_SELF_TEST_VECTORS[9]];
  const fake = createFakeGpu({ exec: "interp" });
  const dev = await openWebGpu({ gpu: fake.gpu, mode: "gpu", env: GPU_ENV, platform: "linux", memoryMiB: 8, hpw: 1, segments: 7, _slotsPerBankMax: 1 });
  try {
    assert.equal(dev.info.banks, 2);
    const out = await dev.hash(vs.map((x) => unhex(x.password)));
    out.forEach((t, i) => assert.equal(hex(t), vs[i].powHash));
  } finally {
    await dev.close();
  }
});

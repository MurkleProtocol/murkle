// The real WebGPU engine (src/webgpu/engine.mjs) on a real adapter: a CPU Vulkan driver in CI
// (MURKLE_WEBGPU=fallback, Linux, VK_ICD_FILENAMES pointing at lavapipe) or a GPU on a labelled rented box
// (MURKLE_WEBGPU=gpu). Everywhere else every test here is skipped, and the `webgpu` package is not even
// imported: the guard runs first, and nothing touches navigator.gpu or Dawn. On the owner's workstation this
// file must never run with the variable set.
//
// Install the package for a run with `npm i --no-save webgpu@<pin>`; it is never in package.json.
// On lavapipe a hash takes a long time: the seconds per hash are measured first, and when it is over 120 s the
// test names say so and only the known-answer check, the primitives check and one vector run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hex, unhex } from "../src/bytes.mjs";
import { GPU_SELF_TEST_VECTORS, gpuSelfTest } from "../src/gpu-gate.mjs";
import { SELF_TEST_VECTORS, inlinePow } from "../src/mine.mjs";
import { assertWebGpuAllowed } from "../src/webgpu/guard.mjs";

const MODE = process.env.MURKLE_WEBGPU === "fallback" ? "fallback" : "gpu";
const VECTORS = [...SELF_TEST_VECTORS.filter((v) => !v.salt && v.password.length === 80), ...GPU_SELF_TEST_VECTORS];
const TIMEOUT = 20 * 60_000;

// 1. the guard, before anything else
let skip = false;
try {
  assertWebGpuAllowed({ mode: MODE });
} catch (e) {
  skip = e.message;
}

// 2. only then the package
let gpu = null;
let openWebGpu = null;
if (!skip) {
  try {
    const dawn = await import("webgpu");
    Object.assign(globalThis, dawn.globals ?? {});
    gpu = dawn.create([]);
    ({ openWebGpu } = await import("../src/webgpu/engine.mjs"));
  } catch (e) {
    skip = `the webgpu package is not installed or could not start (${e.message})`;
  }
}
// a hash on a CPU Vulkan driver can take minutes: the engine's hang watchdog (10 s by default) must not fire
const HANG_MS = 30 * 60_000;
const open = (extra = {}) => openWebGpu({ gpu, mode: MODE, memoryMiB: 16, hpw: 2, segments: 8, hangMs: HANG_MS, ...extra });

// 3. how slow is one hash here?
let secondsPerHash = 0;
if (!skip) {
  try {
    const dev = await open({ memoryMiB: 4, hpw: 1, segments: 8 });
    try {
      const t0 = Date.now();
      await dev.hash([unhex(VECTORS[0].password)]);
      secondsPerHash = (Date.now() - t0) / 1000;
    } finally {
      await dev.close();
    }
  } catch (e) {
    secondsPerHash = Infinity; // could not even time one hash: light mode, the tests below report the real error
  }
}
const LIGHT = secondsPerHash > 120;
const WHAT = LIGHT ? ` (light: ${Number.isFinite(secondsPerHash) ? secondsPerHash.toFixed(0) : "?"} s per hash here, one vector only)` : "";
const vectors = LIGHT ? VECTORS.slice(0, 1) : VECTORS;
const t = (name, fn, extra = {}) => test(name, { skip, timeout: TIMEOUT, ...extra }, fn);

t("k_kat and k_prims pass at open, and the engine reports its adapter and layout", async () => {
  const dev = await open();
  try {
    assert.equal(dev.info.version, "webgpu-proto-1");
    assert.equal(dev.info.slots, 4);
    assert.equal(dev.info.hpw, 2);
    assert.equal(dev.info.fallback, MODE === "fallback" || dev.info.fallback);
    assert.ok(dev.info.limits.maxStorageBufferBindingSize >= 4 * 1024 * 1024);
    console.log(`adapter: ${dev.info.name} (${dev.info.vendor}), ${secondsPerHash.toFixed(2)} s for one hash`);
  } finally {
    await dev.close();
  }
});

t(`the known vectors hash right at HPW 1 and HPW 2 (4 slots)${WHAT}`, async () => {
  const first = [];
  for (const hpw of [1, 2]) {
    const dev = await open({ hpw });
    try {
      const out = await dev.hash(vectors.map((v) => unhex(v.password)));
      out.forEach((tag, i) => assert.equal(hex(tag), vectors[i].powHash, `${vectors[i].name} at HPW ${hpw}`));
      first.push(out.map(hex));
    } finally {
      await dev.close();
    }
  }
  assert.deepEqual(first[0], first[1]);
});

t(`banks: two banks of two slots give the same tags${WHAT}`, async () => {
  const dev = await open({ hpw: 2, _slotsPerBankMax: 2 });
  try {
    assert.equal(dev.info.banks, 2);
    const list = vectors.slice(0, 4);
    const out = await dev.hash(list.map((v) => unhex(v.password)));
    out.forEach((tag, i) => assert.equal(hex(tag), list[i].powHash, list[i].name));
  } finally {
    await dev.close();
  }
});

t(`segments: K = 1 and K = 7 (an uneven split) give the same tags${WHAT}`, async () => {
  for (const K of [1, 7]) {
    const dev = await open({ segments: K });
    try {
      const list = vectors.slice(0, 4);
      const out = await dev.hash(list.map((v) => unhex(v.password)));
      out.forEach((tag, i) => assert.equal(hex(tag), list[i].powHash, `${list[i].name} with ${K} segments`));
    } finally {
      await dev.close();
    }
  }
});

t("gpuSelfTest passes with automatic calibration (skipped when a hash takes too long here)", async (ctx) => {
  if (secondsPerHash * 120 > 900) return ctx.skip(`about ${(secondsPerHash * 120).toFixed(0)} s of hashing needed; run on a GPU`);
  const dev = await openWebGpu({ gpu, mode: MODE, memoryMiB: 64, hpw: 2, hangMs: HANG_MS });
  try {
    const r = await gpuSelfTest(dev, { verifyMany: (p) => inlinePow.hashMany(p) });
    assert.equal(r.slots, dev.info.slots);
    assert.equal(dev.info.calibration.skipped, false);
    console.log(`calibrated: ${dev.info.slots} slots, ${dev.info.segments} segments, batch ${dev.info.calibration.batchMs?.toFixed(0)} ms`);
  } finally {
    await dev.close();
  }
});

t("a lost device fails the search with GPU_EXITED, and the engine can be opened again", async () => {
  const dev = await open({ segments: 2 });
  const p = dev.search({ challenge: new Uint8Array(32), target: 0n, nonceStart: 0n, count: 2 ** 40 });
  await new Promise((r) => setTimeout(r, 300));
  dev._loseDevice();
  await assert.rejects(p, (e) => e.code === "GPU_EXITED");
  await dev.close();
  const again = await open({ segments: 2 });
  await again.close();
});

t("close() releases the device: later calls fail with GPU_CLOSED", async () => {
  const dev = await open();
  await dev.close();
  await assert.rejects(dev.hash([new Uint8Array(40)]), (e) => e.code === "GPU_CLOSED");
});

test("this file is skipped on a machine without MURKLE_WEBGPU, and then imports nothing from the webgpu package", { skip: skip ? false : "the engine tests ran" }, () => {
  assert.equal(gpu, null);
  assert.equal(openWebGpu, null);
  assert.ok(typeof skip === "string" && skip.length > 0);
});

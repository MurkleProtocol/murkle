// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner prototype: the engine. One implementation for browsers and Node.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// openWebGpu({ gpu, ... }) takes the GPU object from outside (navigator.gpu in a page, create() from the
// "webgpu" npm package in Node) and returns a WebGpuDevice with the contract of GpuDevice in src/gpu.mjs, so
// the existing gate (gpuSelfTest, GpuLane in src/gpu-gate.mjs) runs on it unchanged. Nothing the GPU
// says is trusted: that is the gate's job, not this file's.
//
// Memory is 4 MiB per hash, kept in "banks": a bank is one storage buffer of up to
// min(maxStorageBufferBindingSize, maxBufferSize) bytes, with its own bind group. A batch is one compute pass:
// k_init for every bank, then K fill dispatches per bank (each covers a range of blocks, its state is in
// memory), then k_final for every bank, then a copy of the tags to a mappable staging buffer. K is
// chosen by a calibration run so that a single dispatch stays short (the watchdog of the OS and the browser).
//
// Isomorphic: nothing here imports a Node module and no global other than the WebGPU object it is given.
import { GpuError } from "../gpu-gate.mjs";
import { ARGON2_WGSL, PRIMS_WGSL } from "./argon2.wgsl.mjs";
import { createSearch } from "./batcher.mjs";
import { assertWebGpuAllowed, checkAdapterIsCpu } from "./guard.mjs";
import { b2_kat, firstPrimsMismatch, primsExpected, primsInputs, PRIMS_IN_WORDS, PRIMS_OUT_PAIRS, refTable } from "./ref64.mjs";

export const ENGINE_VERSION = "webgpu-proto-1";

// WebGPU flag values (the constants GPUBufferUsage / GPUMapMode / GPUShaderStage are not globals in Node)
const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 };
const MAP_READ = 0x1;
const STAGE_COMPUTE = 0x4;

const SLOT_BYTES = 4 * 1024 * 1024; // 4096 blocks of 1 KiB
const PW_BYTES = 40;
const TAG_BYTES = 32;
const PARAM_STRIDE = 256; // minUniformBufferOffsetAlignment
const MAX_SEGMENTS = 256;
const ENTRIES_PER_BANK = MAX_SEGMENTS + 2; // k_init, k_final and up to 256 fill segments
const FILL_BLOCKS = 4094; // blocks 2 .. 4095
const MAX_SLOTS_PER_BANK = 1023; // 1023 * 524288 words stays below 2^32 in the kernel's u32 index math
const CAL_SEGMENTS = 64;
const PRIMS_CASES = 4096;

const now = () => globalThis.performance.now();
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const limitOf = (limits, name, fallback = Infinity) => (typeof limits?.[name] === "number" ? limits[name] : fallback);

/** The block ranges of K fill dispatches: edges[0] = 2, edges[K] = 4096, near-equal pieces. */
export function segmentEdges(K) {
  if (!Number.isInteger(K) || K < 1 || K > MAX_SEGMENTS) throw new RangeError(`segments must be 1 .. ${MAX_SEGMENTS}`);
  const edges = [];
  for (let s = 0; s <= K; s++) edges.push(s === K ? 4096 : 2 + Math.floor((FILL_BLOCKS * s) / K));
  return edges;
}

/** How many slots each bank holds: `total` slots (a multiple of hpw) spread over `banks` banks, each a multiple of hpw. */
export function bankCapacities(total, slotsPerBankMax, hpw) {
  const units = total / hpw;
  const unitsMax = Math.floor(slotsPerBankMax / hpw);
  if (unitsMax < 1) throw new GpuError(`this GPU allows no bank of ${hpw} slots`, "GPU_NO_DEVICE");
  const banks = Math.ceil(units / unitsMax);
  const per = Math.floor(units / banks);
  const extra = units % banks;
  return Array.from({ length: banks }, (_, i) => (per + (i < extra ? 1 : 0)) * hpw);
}

const dispatchCounts = (slots, hpw) => ({ init: Math.ceil((2 * slots) / 64), fill: slots / hpw, final: Math.ceil(slots / 64) });

/**
 * Opens a WebGPU adapter and device and prepares the buffers and pipelines.
 * -> WebGpuDevice (see the bottom of this file)
 */
export async function openWebGpu(opts = {}) {
  const {
    gpu,
    mode = "gpu",
    powerPreference = "high-performance",
    hpw = 2,
    maxSlots = 4096,
    targetDispatchMs = 50,
    maxDispatchMs = 500,
    targetBatchMs = 250,
    pipelineDepth = 2,
    hangMs = 10_000,
    log = () => {},
  } = opts;
  if (!gpu || typeof gpu.requestAdapter !== "function") throw new GpuError("no WebGPU object was given (navigator.gpu or create() from the webgpu package)", "GPU_NO_DEVICE");
  if (![1, 2, 4, 8].includes(hpw)) throw new RangeError("hpw must be 1, 2, 4 or 8");
  if (!Number.isInteger(pipelineDepth) || pipelineDepth < 1 || pipelineDepth > 3) throw new RangeError("pipelineDepth must be 1 .. 3");
  if (opts.segments !== undefined) segmentEdges(opts.segments);

  // 1. the guard, then the host byte order
  assertWebGpuAllowed({ env: opts.env ?? globalThis.process?.env, platform: opts.platform ?? globalThis.process?.platform, mode, ...(opts.browser === undefined ? {} : { browser: opts.browser }) });
  if (new Uint8Array(new Uint32Array([1]).buffer)[0] !== 1) throw new GpuError("the WebGPU miner needs a little-endian host", "GPU_START");

  // 2. adapter
  let adapter;
  try {
    adapter = await gpu.requestAdapter({ powerPreference, ...(mode === "fallback" ? { forceFallbackAdapter: true } : {}) });
    if (!adapter && mode === "fallback") adapter = await gpu.requestAdapter({ powerPreference }); // the loader is pinned to a CPU driver: only CPU devices exist
  } catch (e) {
    throw new GpuError(`requesting a WebGPU adapter failed: ${e?.message ?? e}`, "GPU_NO_DEVICE", { cause: e });
  }
  if (!adapter) throw new GpuError("no WebGPU adapter was found", "GPU_NO_DEVICE");
  if (mode === "fallback") checkAdapterIsCpu(adapter);
  const ai = adapter.info ?? (await adapter.requestAdapterInfo?.()) ?? {};
  const vendor = String(ai.vendor ?? "");
  const name = String(ai.description || [ai.vendor, ai.architecture, ai.device].filter(Boolean).join(" ") || "WebGPU adapter");

  // 3. limits
  const aLim = adapter.limits ?? {};
  const bindMax = Math.min(limitOf(aLim, "maxStorageBufferBindingSize"), limitOf(aLim, "maxBufferSize"));
  if (!Number.isFinite(bindMax) || Math.floor(bindMax / SLOT_BYTES) < 1) throw new GpuError("this GPU allows no 4 MiB buffer", "GPU_NO_DEVICE");
  let slotsPerBankMax = Math.min(Math.floor(bindMax / SLOT_BYTES), MAX_SLOTS_PER_BANK);
  if (opts._slotsPerBankMax !== undefined) slotsPerBankMax = Math.min(slotsPerBankMax, opts._slotsPerBankMax); // test hook
  if (slotsPerBankMax < hpw) throw new GpuError(`this GPU allows ${slotsPerBankMax} slots per buffer, fewer than ${hpw} hashes per workgroup`, "GPU_NO_DEVICE");
  if (limitOf(aLim, "maxComputeInvocationsPerWorkgroup") < 32 * hpw || limitOf(aLim, "maxComputeWorkgroupSizeX") < 32 * hpw) {
    throw new GpuError(`this GPU's workgroup limits are too small for ${hpw} hashes per workgroup (${32 * hpw} invocations)`, "GPU_START");
  }
  if (limitOf(aLim, "maxComputeWorkgroupStorageSize") < hpw * 138 * 8) throw new GpuError(`this GPU's workgroup memory is too small for ${hpw} hashes per workgroup`, "GPU_START");
  if (limitOf(aLim, "maxStorageBuffersPerShaderStage") < 4) throw new GpuError("this GPU allows fewer than 4 storage buffers per shader", "GPU_START");

  // 4. device
  // no optional features are requested: timestamp queries would be used if present, never required, and v1 does not use them
  let device;
  try {
    device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: bindMax, maxBufferSize: bindMax },
    });
  } catch (e) {
    throw new GpuError(`requesting a WebGPU device failed: ${e?.message ?? e}`, "GPU_START", { cause: e });
  }
  const dev = new WebGpuDevice({
    device, adapter, name, vendor, ai, mode, hpw, pipelineDepth, hangMs, log, bindMax, slotsPerBankMax,
    afterReadback: opts._afterReadback ?? null,
  });
  try {
    await dev._build({
      memoryMiB: opts.memoryMiB ?? (/nvidia|amd|advanced micro/i.test(vendor) ? 4096 : 1024),
      maxSlots, targetDispatchMs, maxDispatchMs, targetBatchMs, segments: opts.segments,
    });
  } catch (e) {
    await dev.close().catch(() => {});
    throw e instanceof GpuError ? e : new GpuError(`could not start the WebGPU engine: ${e?.message ?? e}`, "GPU_START", { cause: e });
  }
  return dev;
}

// ----------------------------------------------------------------------------------------------

export class WebGpuDevice {
  info = null;
  lost;
  #device;
  #adapter;
  #cfg;
  #closing = false;
  #error = null;
  #failed;
  #rejectFailed;
  #chain = Promise.resolve();
  #search = null;
  // buffers and pipelines
  #banksMem = [];
  #pwBuf = null;
  #tagsBuf = null;
  #tabBuf = null;
  #paramsBuf = null;
  #calParamsBuf = null;
  #stage = [];
  #bgl = null;
  #layout = null;
  #pipes = {};
  #bgs = [];
  #calBg = null;
  #caps = [];
  // the plan in force
  #active = 0;
  #K = 1;
  #edges = [];
  #bankPlan = [];
  // numbers
  #batchNo = 0;
  #stats = { batches: 0, hashes: 0, busyMs: 0, dispatchMsMax: 0, lastBatchMs: 0 };
  #buffers = [];

  constructor(cfg) {
    this.#cfg = cfg;
    this.#device = cfg.device;
    this.#adapter = cfg.adapter;
    this.#failed = new Promise((_, reject) => (this.#rejectFailed = reject));
    this.#failed.catch(() => {});
    this.lost = Promise.resolve(this.#device.lost).then((l) => {
      if (!this.#closing) this.#fail(new GpuError(`the WebGPU device was lost: ${l?.message || l?.reason || "unknown reason"}`, "GPU_EXITED"));
      return { reason: l?.reason, message: l?.message };
    });
    this.#device.onuncapturederror = (ev) => {
      if (!this.#closing) this.#fail(new GpuError(`the WebGPU device reported an error: ${ev?.error?.message ?? ev?.message ?? "unknown"}`, "GPU_EXITED"));
    };
  }

  get closed() {
    return this.#closing;
  }

  #fail(err) {
    if (this.#error || this.#closing) return;
    this.#error = err;
    this.#rejectFailed(err);
  }

  #buffer(desc) {
    const b = this.#device.createBuffer(desc);
    this.#buffers.push(b);
    return b;
  }

  // ------------------------------------------------------------ construction

  async _build({ memoryMiB, maxSlots, targetDispatchMs, maxDispatchMs, targetBatchMs, segments }) {
    const d = this.#device;
    const { hpw, log } = this.#cfg;
    const t0 = now();
    // bind group layout, shared by every entry point
    this.#bgl = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: STAGE_COMPUTE, buffer: { type: "storage" } },
        { binding: 1, visibility: STAGE_COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: STAGE_COMPUTE, buffer: { type: "storage" } },
        { binding: 3, visibility: STAGE_COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: STAGE_COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: 16 } },
      ],
    });
    this.#layout = d.createPipelineLayout({ bindGroupLayouts: [this.#bgl] });
    // pipelines
    const module = d.createShaderModule({ code: ARGON2_WGSL });
    await this.#checkCompilation(module, "the Argon2 kernel");
    const make = async (entryPoint, constants) => {
      try {
        return await d.createComputePipelineAsync({ layout: this.#layout, compute: { module, entryPoint, ...(constants ? { constants } : {}) } });
      } catch (e) {
        throw new GpuError(`the WebGPU pipeline ${entryPoint} could not be created: ${e?.message ?? e}`, "GPU_START");
      }
    };
    const [init, fill, final, kat] = await Promise.all([make("k_init"), make("k_fill", { HPW: hpw }), make("k_final"), make("k_kat")]);
    this.#pipes = { init, fill, final, kat };
    const compileMs = now() - t0;

    // buffers, halving the slot count when the allocation fails
    let total = Math.min(maxSlots, Math.floor(memoryMiB / 4));
    total = Math.floor(total / hpw) * hpw;
    if (total < hpw) throw new GpuError(`memoryMiB ${memoryMiB} is too small for ${hpw} hashes per workgroup`, "GPU_START");
    let tries = 0;
    for (;;) {
      this.#caps = bankCapacities(total, this.#cfg.slotsPerBankMax, hpw);
      const err = await this.#allocate(total);
      if (!err) break;
      this.#releaseBuffers();
      tries++;
      log(`allocation of ${total} slots failed (${err}); trying half`);
      const half = Math.floor(total / 2 / hpw) * hpw;
      if (tries >= 6 || half < hpw) throw new GpuError(`the GPU could not allocate memory for ${total} hashes (${err})`, "GPU_START", { oom: true });
      total = half;
    }
    this.#cfg.total = total;
    d.queue.writeBuffer(this.#tabBuf, 0, refTable());

    // checks of this GPU's arithmetic before anything is trusted
    await this.#checkKat();
    await this.#checkPrims();

    // plan: fixed segment count, or calibration
    let cal;
    if (segments !== undefined) {
      this.#setPlan(total, segments);
      cal = { skipped: true, fillMsPerBlockPerSlot: null, batchMs: null, dispatchMsMax: null, dispatchMsSource: "not measured (segments given)" };
    } else {
      cal = await this.#calibrate({ total, targetDispatchMs, maxDispatchMs, targetBatchMs });
    }
    cal.compileMs = Math.round(compileMs);
    this.#publish(cal);
    log(`ready: ${this.#active} slots in ${this.#bankPlan.length} bank(s), ${this.#K} segments`);
  }

  async #checkCompilation(module, what) {
    const info = await module.getCompilationInfo?.();
    const bad = info?.messages?.find((m) => m.type === "error");
    if (bad) throw new GpuError(`WebGPU rejected ${what}: ${bad.message} (line ${bad.lineNum})`, "GPU_START");
  }

  // returns an error text, or null
  async #allocate(total) {
    const d = this.#device;
    d.pushErrorScope("out-of-memory");
    d.pushErrorScope("validation");
    try {
      const caps = this.#caps;
      this.#banksMem = caps.map((slots, i) => this.#buffer({ label: `mem${i}`, size: slots * SLOT_BYTES, usage: USAGE.STORAGE }));
      this.#pwBuf = this.#buffer({ label: "pw", size: total * PW_BYTES, usage: USAGE.STORAGE | USAGE.COPY_DST });
      this.#tagsBuf = this.#buffer({ label: "tags", size: total * TAG_BYTES, usage: USAGE.STORAGE | USAGE.COPY_SRC });
      this.#tabBuf = this.#buffer({ label: "reftab", size: 2048 * 4, usage: USAGE.STORAGE | USAGE.COPY_DST });
      this.#paramsBuf = this.#buffer({ label: "params", size: caps.length * ENTRIES_PER_BANK * PARAM_STRIDE, usage: USAGE.UNIFORM | USAGE.COPY_DST });
      this.#calParamsBuf = this.#buffer({ label: "calParams", size: (CAL_SEGMENTS + 2) * PARAM_STRIDE, usage: USAGE.UNIFORM | USAGE.COPY_DST });
      this.#stage = Array.from({ length: this.#cfg.pipelineDepth + 1 }, (_, i) => this.#buffer({ label: `stage${i}`, size: total * TAG_BYTES, usage: USAGE.MAP_READ | USAGE.COPY_DST }));
      const entries = (mem, params) => [
        { binding: 0, resource: { buffer: mem } },
        { binding: 1, resource: { buffer: this.#pwBuf } },
        { binding: 2, resource: { buffer: this.#tagsBuf } },
        { binding: 3, resource: { buffer: this.#tabBuf } },
        { binding: 4, resource: { buffer: params, offset: 0, size: 16 } },
      ];
      this.#bgs = this.#banksMem.map((mem) => d.createBindGroup({ layout: this.#bgl, entries: entries(mem, this.#paramsBuf) }));
      this.#calBg = d.createBindGroup({ layout: this.#bgl, entries: entries(this.#banksMem[0], this.#calParamsBuf) });
    } catch (e) {
      await d.popErrorScope();
      await d.popErrorScope();
      return String(e?.message ?? e);
    }
    const validation = await d.popErrorScope();
    const oom = await d.popErrorScope();
    const err = validation ?? oom;
    return err ? String(err.message || err.constructor?.name || "error") : null;
  }

  #releaseBuffers() {
    for (const b of this.#buffers) {
      try {
        b.destroy();
      } catch {
        // already gone
      }
    }
    this.#buffers = [];
    this.#banksMem = [];
    this.#stage = [];
    this.#bgs = [];
  }

  // ------------------------------------------------------------ plan

  /** Sets the slots in use and the segment count and writes the Params entries (nothing may be in flight). */
  #setPlan(active, K) {
    const hpw = this.#cfg.hpw;
    const edges = segmentEdges(K);
    const words = new Uint32Array(this.#caps.length * ENTRIES_PER_BANK * (PARAM_STRIDE / 4));
    const put = (entry, slotBase, slots, segFrom, segTo) => words.set([slotBase, slots, segFrom, segTo], entry * (PARAM_STRIDE / 4));
    const plan = [];
    let remaining = active;
    let slotBase = 0;
    this.#caps.forEach((cap, b) => {
      const slots = Math.min(cap, remaining);
      if (slots <= 0) return;
      const base = b * ENTRIES_PER_BANK;
      put(base, slotBase, slots, 0, 0);
      put(base + 1, slotBase, slots, 0, 0);
      for (let s = 0; s < K; s++) put(base + 2 + s, slotBase, slots, edges[s], edges[s + 1]);
      plan.push({ bank: b, slotBase, slots, counts: dispatchCounts(slots, hpw), initOff: base * PARAM_STRIDE, finalOff: (base + 1) * PARAM_STRIDE, segOff: (s) => (base + 2 + s) * PARAM_STRIDE });
      slotBase += slots;
      remaining -= slots;
    });
    if (remaining !== 0 || active % hpw !== 0) throw new Error("internal: slots do not fit the banks");
    this.#device.queue.writeBuffer(this.#paramsBuf, 0, words);
    this.#bankPlan = plan;
    this.#active = active;
    this.#K = K;
    this.#edges = edges;
    this.#search = createSearch({ runBatch: (pw) => this.#runBatch(pw), slots: active, pipelineDepth: this.#cfg.pipelineDepth });
  }

  #encode(pass, plan, K, bgOf) {
    const { init, fill, final } = this.#pipes;
    pass.setPipeline(init);
    for (const p of plan) {
      pass.setBindGroup(0, bgOf(p), [p.initOff]);
      pass.dispatchWorkgroups(p.counts.init);
    }
    pass.setPipeline(fill);
    for (let s = 0; s < K; s++) {
      for (const p of plan) {
        pass.setBindGroup(0, bgOf(p), [p.segOff(s)]);
        pass.dispatchWorkgroups(p.counts.fill);
      }
    }
    pass.setPipeline(final);
    for (const p of plan) {
      pass.setBindGroup(0, bgOf(p), [p.finalOff]);
      pass.dispatchWorkgroups(p.counts.final);
    }
  }

  // ------------------------------------------------------------ start-up checks

  async #readBytes(buffer, size) {
    const d = this.#device;
    const stage = d.createBuffer({ label: "check", size, usage: USAGE.MAP_READ | USAGE.COPY_DST });
    try {
      const enc = d.createCommandEncoder();
      enc.copyBufferToBuffer(buffer, 0, stage, 0, size);
      d.queue.submit([enc.finish()]);
      await this.#withWatchdog(stage.mapAsync(MAP_READ));
      const out = new Uint8Array(stage.getMappedRange(0, size).slice(0));
      stage.unmap();
      return out;
    } finally {
      stage.destroy();
    }
  }

  async #checkKat() {
    const d = this.#device;
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.#pipes.kat);
    pass.setBindGroup(0, this.#bgs[0], [0]);
    pass.dispatchWorkgroups(1);
    pass.end();
    d.queue.submit([enc.finish()]);
    const got = await this.#readBytes(this.#tagsBuf, 32);
    const want = b2_kat();
    if (got.some((x, i) => x !== want[i])) throw new GpuError("BLAKE2b-256(\"abc\") is wrong on this GPU (the known-answer check failed)", "GPU_SELF_TEST");
  }

  async #checkPrims() {
    const d = this.#device;
    const n = PRIMS_CASES;
    const module = d.createShaderModule({ code: PRIMS_WGSL });
    await this.#checkCompilation(module, "the primitives check");
    let pipe;
    try {
      pipe = await d.createComputePipelineAsync({ layout: this.#layout, compute: { module, entryPoint: "k_prims" } });
    } catch (e) {
      throw new GpuError(`the primitives check pipeline could not be created: ${e?.message ?? e}`, "GPU_START");
    }
    const words = primsInputs(n, 0x6d75726b);
    const mem = d.createBuffer({ label: "primsMem", size: 256, usage: USAGE.STORAGE });
    const pw = d.createBuffer({ label: "primsIn", size: n * PRIMS_IN_WORDS * 4, usage: USAGE.STORAGE | USAGE.COPY_DST });
    const tags = d.createBuffer({ label: "primsOut", size: n * PRIMS_OUT_PAIRS * 8, usage: USAGE.STORAGE | USAGE.COPY_SRC });
    const prm = d.createBuffer({ label: "primsPrm", size: PARAM_STRIDE, usage: USAGE.UNIFORM | USAGE.COPY_DST });
    try {
      d.queue.writeBuffer(pw, 0, words);
      d.queue.writeBuffer(prm, 0, new Uint32Array([0, n, 0, 0]));
      const bg = d.createBindGroup({
        layout: this.#bgl,
        entries: [
          { binding: 0, resource: { buffer: mem } },
          { binding: 1, resource: { buffer: pw } },
          { binding: 2, resource: { buffer: tags } },
          { binding: 3, resource: { buffer: this.#tabBuf } },
          { binding: 4, resource: { buffer: prm, offset: 0, size: 16 } },
        ],
      });
      const enc = d.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe);
      pass.setBindGroup(0, bg, [0]);
      pass.dispatchWorkgroups(Math.ceil(n / 64));
      pass.end();
      d.queue.submit([enc.finish()]);
      const bytes = await this.#readBytes(tags, n * PRIMS_OUT_PAIRS * 8);
      const got = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      const bad = firstPrimsMismatch(got, primsExpected(words));
      if (bad) throw new GpuError(`${bad.primitive} differs on this GPU (input set ${bad.index} of ${n})`, "GPU_SELF_TEST");
    } finally {
      for (const b of [mem, pw, tags, prm]) b.destroy();
    }
  }

  // ------------------------------------------------------------ calibration

  async #timedSubmit(encodeFn) {
    const d = this.#device;
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    encodeFn(pass);
    pass.end();
    const t0 = now();
    d.queue.submit([enc.finish()]);
    await this.#withWatchdog(d.queue.onSubmittedWorkDone());
    return now() - t0;
  }

  async #calibrate({ total, targetDispatchMs, maxDispatchMs, targetBatchMs }) {
    const { hpw, log, hangMs } = this.#cfg;
    // (a) a small start: S0 slots of bank 0, 64 fill segments
    const bank0 = Math.min(this.#caps[0], 16 * hpw);
    const S0 = Math.max(hpw, Math.floor(bank0 / hpw) * hpw);
    const edges = segmentEdges(CAL_SEGMENTS);
    const words = new Uint32Array((CAL_SEGMENTS + 2) * (PARAM_STRIDE / 4));
    const put = (entry, from, to) => words.set([0, S0, from, to], entry * (PARAM_STRIDE / 4));
    put(0, 0, 0);
    put(1, 0, 0);
    for (let s = 0; s < CAL_SEGMENTS; s++) put(2 + s, edges[s], edges[s + 1]);
    this.#device.queue.writeBuffer(this.#calParamsBuf, 0, words);
    const calPlan = [{ slots: S0, counts: dispatchCounts(S0, hpw), initOff: 0, finalOff: PARAM_STRIDE, segOff: (s) => (2 + s) * PARAM_STRIDE }];
    const ms0 = await this.#timedSubmit((pass) => this.#encode(pass, calPlan, CAL_SEGMENTS, () => this.#calBg));
    // the whole run, init and final included, divided by the blocks it filled: pessimistic
    let fill = ms0 / (FILL_BLOCKS * S0);
    log(`calibration: ${S0} slots in ${ms0.toFixed(1)} ms`);

    let active = total;
    let K = 1;
    let batchMs = 0;
    for (let round = 0; ; round++) {
      // (b) K so that one dispatch of all banks is at most targetDispatchMs; (c) halve the slots when even 256 is too long
      for (;;) {
        const predicted = fill * FILL_BLOCKS * active;
        K = clamp(Math.ceil(predicted / targetDispatchMs), 1, MAX_SEGMENTS);
        // a predicted batch far over the target is halved too, so the real batch (d) cannot run into the hang watchdog
        const tooLong = predicted > Math.min(4 * targetBatchMs, hangMs / 2);
        if (predicted / K <= maxDispatchMs && !tooLong) break;
        if (active <= hpw) {
          if (predicted / K <= maxDispatchMs && predicted <= hangMs / 2) break; // the smallest batch: slow but safe
          throw new GpuError("this GPU is too slow for a safe batch", "GPU_START");
        }
        active = Math.max(hpw, Math.floor(active / 2 / hpw) * hpw);
      }
      this.#setPlan(active, K);
      // (d) one real batch at this size, with the readback
      const pw = new Uint8Array(active * PW_BYTES);
      globalThis.crypto.getRandomValues(pw);
      const t0 = now();
      await this.#runBatch(pw);
      batchMs = now() - t0;
      fill = Math.max(fill * 0.05, batchMs / (FILL_BLOCKS * active)); // the measured figure, with a floor against a lucky run
      const K2 = clamp(Math.ceil((fill * FILL_BLOCKS * active) / targetDispatchMs), 1, MAX_SEGMENTS);
      // (e) a batch that is too long for responsiveness and cancel latency: halve the slots
      if (batchMs > 4 * targetBatchMs && active > hpw && round < 5) {
        active = Math.max(hpw, Math.floor(active / 2 / hpw) * hpw);
        continue;
      }
      if (K2 !== K) {
        this.#setPlan(active, K2);
        K = K2;
      }
      break;
    }
    return {
      skipped: false,
      fillMsPerBlockPerSlot: fill,
      batchMs,
      // no per-dispatch timestamps: the mean dispatch is the batch time over the segment count
      dispatchMsMax: batchMs / K,
      dispatchMsSource: "batch time / segments (no timestamp queries)",
      calibrationMs: ms0,
    };
  }

  #publish(cal) {
    const lim = this.#adapter.limits ?? {};
    const feat = this.#adapter.features;
    this.info = {
      device: 0,
      name: this.#cfg.name,
      vendor: this.#cfg.vendor,
      architecture: String(this.#cfg.ai.architecture ?? ""),
      backend: this.#cfg.ai.backend ?? undefined,
      fallback: this.#cfg.mode === "fallback" || this.#cfg.ai.isFallbackAdapter === true,
      slots: this.#active,
      banks: this.#bankPlan.length,
      slotsPerBank: this.#caps[0],
      hpw: this.#cfg.hpw,
      segments: this.#K,
      limits: { maxStorageBufferBindingSize: limitOf(lim, "maxStorageBufferBindingSize", null), maxBufferSize: limitOf(lim, "maxBufferSize", null) },
      features: { subgroups: !!feat?.has?.("subgroups"), timestampQuery: !!feat?.has?.("timestamp-query") },
      calibration: cal,
      version: ENGINE_VERSION,
    };
    this.#stats.dispatchMsMax = cal.dispatchMsMax ?? 0;
  }

  // ------------------------------------------------------------ one batch

  async #withWatchdog(promise) {
    let timer;
    const hang = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new GpuError(`the GPU did not answer within ${this.#cfg.hangMs} ms; the device was destroyed`, "GPU_TIMEOUT");
        this.#fail(err);
        try {
          this.#device.destroy();
        } catch {
          // already gone
        }
        reject(err);
      }, this.#cfg.hangMs);
    });
    try {
      return await Promise.race([promise, hang, this.#failed]);
    } catch (e) {
      if (this.#closing) throw new GpuError("the GPU device is closed", "GPU_CLOSED");
      if (this.#error) throw this.#error;
      throw e instanceof GpuError ? e : new GpuError(`the WebGPU device failed: ${e?.message ?? e}`, "GPU_EXITED", { cause: e });
    } finally {
      clearTimeout(timer);
    }
  }

  /** pw: active * 40 bytes -> tags: active * 32 bytes. Used by the batcher, up to pipelineDepth at a time. */
  async #runBatch(pw) {
    if (this.#closing) throw new GpuError("the GPU device is closed", "GPU_CLOSED");
    if (this.#error) throw this.#error;
    const d = this.#device;
    const n = this.#active;
    if (pw.length !== n * PW_BYTES) throw new RangeError(`a batch is ${n * PW_BYTES} bytes, got ${pw.length}`);
    const stage = this.#stage[this.#batchNo++ % this.#stage.length];
    const t0 = now();
    d.queue.writeBuffer(this.#pwBuf, 0, pw);
    const enc = d.createCommandEncoder();
    const pass = enc.beginComputePass();
    this.#encode(pass, this.#bankPlan, this.#K, (p) => this.#bgs[p.bank]);
    pass.end();
    enc.copyBufferToBuffer(this.#tagsBuf, 0, stage, 0, n * TAG_BYTES);
    d.queue.submit([enc.finish()]);
    await this.#withWatchdog(stage.mapAsync(MAP_READ, 0, n * TAG_BYTES));
    const out = new Uint8Array(stage.getMappedRange(0, n * TAG_BYTES).slice(0));
    stage.unmap();
    this.#cfg.afterReadback?.(out);
    const ms = now() - t0;
    this.#stats.batches += 1;
    this.#stats.hashes += n;
    this.#stats.busyMs += ms;
    this.#stats.lastBatchMs = ms;
    return out;
  }

  // ------------------------------------------------------------ the GpuDevice contract

  #queue(fn) {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.then(() => {}, () => {});
    return run;
  }

  #usable() {
    if (this.#closing) throw new GpuError("the GPU device is closed", "GPU_CLOSED");
    if (this.#error) throw this.#error;
  }

  /** Argon2id of each 40-byte password, in order -> Uint8Array(32)[] */
  hash(passwords) {
    return this.#queue(async () => {
      this.#usable();
      return this.#search.hash(passwords);
    });
  }

  /** As GpuDevice.search: -> { done: bigint, ms, cancelled, candidates: [{ nonce, hash }], more, probe } */
  search(args) {
    return this.#queue(async () => {
      this.#usable();
      return this.#search.search(args);
    });
  }

  stats() {
    return { ...this.#stats };
  }

  /** Test hook: waits until the GPU is idle, then switches to K fill segments. */
  async _setSegments(K) {
    return this.#queue(async () => {
      this.#usable();
      await this.#withWatchdog(this.#device.queue.onSubmittedWorkDone());
      this.#setPlan(this.#active, K);
      this.info.segments = K;
    });
  }

  /** Diagnostic hook (scripts/webgpu-bench.mjs --lose): destroys the WebGPU device under a running search, as a driver reset would. */
  _loseDevice() {
    this.#device.destroy();
  }

  /** Destroys the buffers and the device. */
  async close() {
    if (this.#closing) return;
    this.#closing = true;
    this.#rejectFailed(new GpuError("the GPU device is closed", "GPU_CLOSED"));
    this.#releaseBuffers();
    try {
      this.#device.destroy();
    } catch {
      // already gone
    }
    await this.#chain.catch(() => {});
  }
}

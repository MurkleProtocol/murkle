// A stand-in for the WebGPU API (what src/webgpu/engine.mjs calls), for testing the engine's host logic with no GPU:
// buffers, bind groups with dynamic offsets, error scopes, a command queue that executes at submit, mapAsync, device loss.
// It validates what a real implementation would (usage flags, offset alignment, ranges, mapping state, dispatch limits)
// and executes the kernels in one of two ways:
//   exec "fast"   no memory model: k_init / k_fill / k_final check the call protocol (every slot initialised first, the
//                 fill segments contiguous from block 2 to 4096, nothing finalised early) and k_final writes
//                 tag = tagOf(password) (sha256 by default). k_kat and k_prims give the true answers.
//   exec "interp" runs the real WGSL text on test/fixtures/wgsl-mini.mjs against real memory (slow: seconds per hash).
// A simple cost model (msPerBlockSlot) makes the queue take time, so calibration has something to measure.
import { sha256 } from "@noble/hashes/sha256";
import { b2_kat, primsExpected } from "../../src/webgpu/ref64.mjs";
import { ARGON2_WGSL, PRIMS_WGSL } from "../../src/webgpu/argon2.wgsl.mjs";
import { compileWgsl } from "./wgsl-mini.mjs";

const U = { MAP_READ: 0x1, MAP_WRITE: 0x2, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 };
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

export const DEFAULT_LIMITS = Object.freeze({
  maxStorageBufferBindingSize: 128 * 1024 * 1024,
  maxBufferSize: 256 * 1024 * 1024,
  maxComputeInvocationsPerWorkgroup: 256,
  maxComputeWorkgroupSizeX: 256,
  maxComputeWorkgroupStorageSize: 16384,
  maxStorageBuffersPerShaderStage: 8,
  maxComputeWorkgroupsPerDimension: 65535,
});

class FakeBuffer {
  constructor(dev, desc) {
    this.dev = dev;
    this.size = desc.size;
    this.usage = desc.usage;
    this.label = desc.label ?? "";
    this.destroyed = false;
    this.mapState = "unmapped";
    this._data = null;
  }
  get data() {
    return (this._data ??= new Uint8Array(this.size));
  }
  destroy() {
    if (!this.destroyed) this.dev.state.allocated -= this.size;
    this.destroyed = true;
    this._data = null;
  }
  async mapAsync(mode, offset = 0, size = this.size - offset) {
    const bad = (m) => {
      throw new Error(`mapAsync ${this.label}: ${m}`);
    };
    if (this.destroyed) bad("destroyed");
    if (!(this.usage & U.MAP_READ) || mode !== 1) bad("needs MAP_READ and mode READ");
    if (this.mapState !== "unmapped") bad(`already ${this.mapState}`);
    if (offset % 8 !== 0 || size % 4 !== 0 || offset + size > this.size) bad("bad range");
    this.mapState = "pending";
    await this.dev._whenIdle();
    if (this.dev.destroyed || this.destroyed) {
      this.mapState = "unmapped";
      throw new Error("the device was destroyed while the buffer was being mapped");
    }
    this.mapState = "mapped";
  }
  getMappedRange(offset = 0, size = this.size - offset) {
    if (this.mapState !== "mapped") throw new Error(`getMappedRange ${this.label}: not mapped`);
    return this.data.buffer.slice(this.data.byteOffset + offset, this.data.byteOffset + offset + size);
  }
  unmap() {
    if (this.mapState === "unmapped") throw new Error(`unmap ${this.label}: not mapped`);
    this.mapState = "unmapped";
  }
}

/**
 * -> { gpu, state }. options:
 *   exec: "fast" | "interp";  tagOf(pw40) -> Uint8Array(32) for exec fast
 *   limits, vendor, description, isFallbackAdapter, adapterNull (true: requestAdapter answers null; "first": only the first call)
 *   memoryBudgetBytes: createBuffer beyond this total raises an out-of-memory error
 *   msPerBlockSlot: cost model of k_fill; initMsPerSlot, finalMsPerSlot
 *   adapterError / deviceError: requestAdapter / requestDevice throw this message
 *   corruptKat / corruptPrims: make the start-up checks fail; compileError: getCompilationInfo reports an error
 */
export function createFakeGpu(options = {}) {
  const o = {
    exec: "fast", tagOf: (pw) => sha256(pw), limits: {}, vendor: "fake-vendor", description: "Fake WebGPU adapter", isFallbackAdapter: false,
    adapterNull: false, memoryBudgetBytes: Infinity, msPerBlockSlot: 0, initMsPerSlot: 0, finalMsPerSlot: 0,
    corruptKat: false, corruptPrims: false, compileError: false, ...options,
  };
  const limits = { ...DEFAULT_LIMITS, ...o.limits };
  const state = {
    adapterRequests: [],
    deviceRequests: [],
    buffers: [],
    devices: [],
    dispatches: [], // { entry, bank, slotBase, slots, segFrom, segTo, ms }
    submits: 0,
    maxDispatchMs: 0,
    pipelines: [],
    modules: [],
    allocated: 0,
    errors: [],
  };

  const compiled = new Map();
  const program = (src, constants) => {
    const key = `${src.length}:${JSON.stringify(constants ?? {})}`;
    if (!compiled.has(key)) compiled.set(key, compileWgsl(src, constants ?? {}));
    return compiled.get(key);
  };

  class FakeDevice {
    constructor() {
      this.state = state;
      this.destroyed = false;
      this.scopes = [];
      this.busyUntil = 0;
      this.lost = new Promise((r) => (this._resolveLost = r));
      this.onuncapturederror = null;
      this.queue = {
        writeBuffer: (buf, offset, data, dataOffset = 0, size) => this._writeBuffer(buf, offset, data, dataOffset, size),
        submit: (cbs) => this._submit(cbs),
        onSubmittedWorkDone: () => this._whenIdle(),
      };
      this.slotInit = new Map(); // buffer -> { init: Set(slot), next: Map(slot -> next block) }
    }
    _alive() {
      if (this.destroyed) throw new Error("the device is destroyed");
    }
    _raise(type, message) {
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        if (this.scopes[i].filter === type) {
          this.scopes[i].error ??= { constructor: { name: type }, message };
          return;
        }
      }
      state.errors.push({ type, message });
      this.onuncapturederror?.({ error: { message } });
    }
    pushErrorScope(filter) {
      this.scopes.push({ filter, error: null });
    }
    async popErrorScope() {
      return this.scopes.pop().error;
    }
    destroy() {
      this.destroyed = true;
      for (const b of state.buffers) if (b.dev === this) b.destroy();
      this._resolveLost({ reason: "destroyed", message: "the device was destroyed" });
    }
    /** Test hook: the GPU goes away. */
    lose(message = "GPU reset") {
      this.destroyed = true;
      this._resolveLost({ reason: "unknown", message });
    }
    createBuffer(desc) {
      this._alive();
      if (desc.size > limits.maxBufferSize) {
        this._raise("validation", `buffer ${desc.label} of ${desc.size} bytes is above maxBufferSize`);
      }
      if (state.allocated + desc.size > o.memoryBudgetBytes) this._raise("out-of-memory", `out of memory allocating ${desc.size} bytes`);
      if (desc.usage & U.UNIFORM && desc.size % 4) this._raise("validation", "bad uniform size");
      const b = new FakeBuffer(this, desc);
      state.buffers.push(b);
      state.allocated += desc.size;
      return b;
    }
    createShaderModule({ code }) {
      this._alive();
      const m = { code, async getCompilationInfo() { return { messages: o.compileError ? [{ type: "error", message: "unexpected token", lineNum: 3 }] : [] }; } };
      state.modules.push(m);
      return m;
    }
    createBindGroupLayout({ entries }) {
      return { entries };
    }
    createPipelineLayout({ bindGroupLayouts }) {
      return { bindGroupLayouts };
    }
    async createComputePipelineAsync({ layout, compute }) {
      this._alive();
      if (!layout?.bindGroupLayouts?.length) throw new Error("pipeline needs an explicit layout");
      const src = compute.module.code;
      if (!new RegExp(`fn ${compute.entryPoint}\\(`).test(src)) throw Object.assign(new Error(`no entry point ${compute.entryPoint}`), { name: "GPUPipelineError" });
      for (const k of Object.keys(compute.constants ?? {})) if (!new RegExp(`override ${k}\\b`).test(src)) throw new Error(`unknown pipeline constant ${k}`);
      const p = { entryPoint: compute.entryPoint, constants: compute.constants ?? {}, code: src, layout };
      state.pipelines.push(p);
      return p;
    }
    createBindGroup({ layout, entries }) {
      this._alive();
      if (entries.length !== layout.entries.length) throw new Error("bind group entries do not match the layout");
      for (const e of entries) {
        const l = layout.entries.find((x) => x.binding === e.binding);
        const buf = e.resource.buffer;
        const need = { storage: U.STORAGE, "read-only-storage": U.STORAGE, uniform: U.UNIFORM }[l.buffer.type];
        if (!(buf.usage & need)) throw new Error(`binding ${e.binding}: buffer ${buf.label} lacks the usage`);
        const size = e.resource.size ?? buf.size - (e.resource.offset ?? 0);
        if (l.buffer.type !== "uniform" && size > limits.maxStorageBufferBindingSize) throw new Error(`binding ${e.binding}: ${size} bytes is above maxStorageBufferBindingSize`);
        if (l.buffer.minBindingSize && size < l.buffer.minBindingSize) throw new Error(`binding ${e.binding}: below minBindingSize`);
      }
      return { layout, entries };
    }
    createCommandEncoder() {
      const cmds = [];
      let inPass = false;
      return {
        beginComputePass: () => {
          inPass = true;
          const pass = [];
          cmds.push({ pass });
          let pipe = null;
          let bg = null;
          let offs = null;
          return {
            setPipeline: (p) => (pipe = p),
            setBindGroup: (i, g, offsets = []) => {
              if (i !== 0) throw new Error("only group 0");
              const dyn = g.layout.entries.filter((e) => e.buffer.hasDynamicOffset).length;
              if (offsets.length !== dyn) throw new Error(`expected ${dyn} dynamic offsets`);
              offsets.forEach((x) => {
                if (x % 256) throw new Error(`dynamic offset ${x} is not a multiple of 256`);
              });
              bg = g;
              offs = offsets;
            },
            dispatchWorkgroups: (x, y = 1, z = 1) => {
              if (!pipe || !bg) throw new Error("dispatch without a pipeline and a bind group");
              if (x < 1 || x > limits.maxComputeWorkgroupsPerDimension || y !== 1 || z !== 1) throw new Error(`bad dispatch size ${x}`);
              pass.push({ pipe, bg, offs: [...offs], x });
            },
            end: () => {
              inPass = false;
            },
          };
        },
        copyBufferToBuffer: (src, so, dst, doff, size) => {
          if (inPass) throw new Error("copy inside a pass");
          if (!(src.usage & U.COPY_SRC) || !(dst.usage & U.COPY_DST)) throw new Error("copy: usage");
          if (so % 4 || doff % 4 || size % 4 || so + size > src.size || doff + size > dst.size) throw new Error("copy: range");
          cmds.push({ copy: [src, so, dst, doff, size] });
        },
        finish: () => cmds,
      };
    }
    _writeBuffer(buf, offset, data, dataOffset, size) {
      this._alive();
      if (!(buf.usage & U.COPY_DST)) throw new Error(`writeBuffer ${buf.label}: no COPY_DST`);
      const isView = ArrayBuffer.isView(data);
      const bytes = isView ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      const elem = isView ? data.BYTES_PER_ELEMENT : 1;
      const from = dataOffset * elem;
      const n = size === undefined ? bytes.length - from : size * elem;
      if (offset % 4 || n % 4 || offset + n > buf.size) throw new Error(`writeBuffer ${buf.label}: bad range (${offset} + ${n} of ${buf.size})`);
      buf.data.set(bytes.subarray(from, from + n), offset);
    }
    _submit(cbs) {
      this._alive();
      state.submits++;
      for (const cb of cbs) {
        let cost = 0;
        for (const c of cb) {
          if (c.copy) {
            const [src, so, dst, doff, size] = c.copy;
            dst.data.set(src.data.subarray(so, so + size), doff);
          } else {
            for (const d of c.pass) cost += this._dispatch(d);
          }
        }
        this.busyUntil = Math.max(this.busyUntil, performance.now()) + cost;
      }
    }
    async _whenIdle() {
      await sleep(this.busyUntil - performance.now());
      if (this.destroyed) throw new Error("the device was destroyed");
      await Promise.resolve();
    }
    _dispatch({ pipe, bg, offs, x }) {
      const get = (n) => bg.entries.find((e) => e.binding === n).resource.buffer;
      const mem = get(0);
      const pwb = get(1);
      const tagsb = get(2);
      const tab = get(3);
      const prmb = get(4);
      const pr = new Uint32Array(prmb.data.buffer.slice(offs[0], offs[0] + 16));
      const prm = { slotBase: pr[0], slots: pr[1], segFrom: pr[2], segTo: pr[3] };
      const entry = pipe.entryPoint;
      const hpw = pipe.constants.HPW ?? 2;
      const rec = { entry, bank: state.buffers.indexOf(mem), ...prm, ms: 0 };
      const words = (b) => new Uint32Array(b.data.buffer, b.data.byteOffset, b.data.byteLength >> 2);
      // protocol checks, both modes
      const slotsCover = (need) => {
        if (x !== need) throw new Error(`${entry}: dispatched ${x} workgroups where ${need} are needed for ${prm.slots} slots`);
      };
      if (entry === "k_init") slotsCover(Math.ceil((2 * prm.slots) / 64));
      if (entry === "k_final") slotsCover(Math.ceil(prm.slots / 64));
      if (entry === "k_fill") slotsCover(prm.slots / hpw);
      if (entry === "k_prims") slotsCover(Math.ceil(prm.slots / 64));
      if (entry === "k_init" || entry === "k_fill" || entry === "k_final") {
        if (prm.slots % (entry === "k_fill" ? hpw : 1)) throw new Error("slots is not a multiple of HPW");
        if ((prm.slotBase + prm.slots) * 40 > pwb.size || (prm.slotBase + prm.slots) * 32 > tagsb.size) throw new Error(`${entry}: slots beyond the pw / tags buffers`);
        if (prm.slots * 4 * 1024 * 1024 > mem.size) throw new Error(`${entry}: slots beyond the bank (${prm.slots} slots in ${mem.size} bytes)`);
      }
      if (entry === "k_fill" && !(prm.segFrom >= 2 && prm.segFrom < prm.segTo && prm.segTo <= 4096)) throw new Error(`k_fill: bad segment ${prm.segFrom}..${prm.segTo}`);
      if (o.exec === "interp") {
        const isPrims = entry === "k_prims";
        const prog = program(isPrims ? PRIMS_WGSL : ARGON2_WGSL, entry === "k_fill" ? { HPW: hpw } : {});
        prog.dispatch(entry, x, { mem: words(mem), pw: words(pwb), tags: words(tagsb), reftab: words(tab), prm });
      } else this._fast(entry, { mem, pwb, tagsb, prm, words });
      if (entry === "k_prims" && o.corruptPrims) words(tagsb)[5 * 2] ^= 1; // mul32wide of the first set
      if (entry === "k_kat" && o.corruptKat) tagsb.data[3] ^= 1;
      rec.ms = entry === "k_fill" ? o.msPerBlockSlot * prm.slots * (prm.segTo - prm.segFrom) : entry === "k_init" ? o.initMsPerSlot * prm.slots : entry === "k_final" ? o.finalMsPerSlot * prm.slots : 0;
      state.maxDispatchMs = Math.max(state.maxDispatchMs, rec.ms);
      state.dispatches.push(rec);
      return rec.ms;
    }
    _fast(entry, { mem, pwb, tagsb, prm, words }) {
      const rec = this.slotInit.get(mem) ?? { init: new Set(), next: new Map() };
      this.slotInit.set(mem, rec);
      if (entry === "k_kat") {
        tagsb.data.set(b2_kat(), 0);
      } else if (entry === "k_init") {
        for (let s = 0; s < prm.slots; s++) {
          rec.init.add(s);
          rec.next.set(s, 2);
        }
      } else if (entry === "k_fill") {
        for (let s = 0; s < prm.slots; s++) {
          if (!rec.init.has(s)) throw new Error(`k_fill on slot ${s} that k_init did not prepare`);
          if (rec.next.get(s) !== prm.segFrom) throw new Error(`k_fill segment ${prm.segFrom}..${prm.segTo} on slot ${s} that is at block ${rec.next.get(s)}`);
          rec.next.set(s, prm.segTo);
        }
      } else if (entry === "k_final") {
        for (let s = 0; s < prm.slots; s++) {
          if (rec.next.get(s) !== 4096) throw new Error(`k_final on slot ${s} at block ${rec.next.get(s)}`);
          const pw = pwb.data.slice((prm.slotBase + s) * 40, (prm.slotBase + s) * 40 + 40);
          tagsb.data.set(o.tagOf(pw), (prm.slotBase + s) * 32);
          rec.init.delete(s);
        }
      } else if (entry === "k_prims") {
        const n = prm.slots;
        const exp = primsExpected(words(pwb).subarray(0, n * 8));
        words(tagsb).set(exp, 0);
      } else throw new Error(`unknown entry point ${entry}`);
    }
  }

  const adapter = {
    info: { vendor: o.vendor, architecture: "fake", device: "", description: o.description, isFallbackAdapter: o.isFallbackAdapter },
    limits,
    features: new Set(),
    async requestDevice(desc) {
      state.deviceRequests.push(desc);
      if (o.deviceError) throw new Error(o.deviceError);
      for (const [k, v] of Object.entries(desc?.requiredLimits ?? {})) {
        if (!(k in limits) || v > limits[k]) throw new Error(`limit ${k} = ${v} is not supported`);
      }
      const d = new FakeDevice();
      state.devices.push(d);
      return d;
    },
  };
  const gpu = {
    async requestAdapter(opts) {
      state.adapterRequests.push(opts);
      if (o.adapterError) throw new Error(o.adapterError);
      if (o.adapterNull === true || (o.adapterNull === "first" && state.adapterRequests.length === 1)) return null;
      return adapter;
    },
  };
  return { gpu, state, adapter };
}

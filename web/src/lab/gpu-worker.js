// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner prototype: the GPU lane as a module Web Worker.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// The lab only (web/lab-plugin.mjs). This worker speaks the protocol of web/src/mine-worker.js, so the
// page's MineController can drive it like a CPU worker, plus a few extras. It never touches
// navigator.gpu before an "open" message, and the page sends that only after a click.
//
// Protocol
//   in  { type: "open", memoryMiB?, hpw?, targetDispatchMs?, verifyVia?: "page" }
//   out { type: "gpu-info", info }                          after the engine opened (src/webgpu/engine.mjs)
//   out { type: "ready", ok: true, impl: "webgpu", name }   after the CPU self-test (hash-wasm, else noble) AND gpuSelfTest passed
//   out { type: "lane-off", reason, wrong? }                any failure (wrong: true when the GPU gave a wrong answer; the page then bans the lane): no navigator.gpu, no adapter, the self-test, GPU_WRONG,
//                                                           restarts used up, a device lost beyond its restarts. The worker then idles.
//   in  { type: "start", id, challenge: hex64, target: hex64, nonceStart?: hex16, progressMs? }   a new start replaces the search
//   in  { type: "stop" }
//   out { type: "progress", hashes, ms, id, lane: "gpu" }   about every progressMs (1000)
//   out { type: "found", nonce: hex16, powHash: hex64, hashes, id, lane: "gpu" }
//         powHash is the CPU Argon2 value that GpuLane returned (hash-wasm, else noble), never the GPU's.
//   in  { type: "verify", id, password }                    answered { type: "verified", id, error }: verify on a CPU worker
//   out { type: "error", message }                          malformed input
// Lab extras (the lab page, never /app/mine). Each request has an id; the answer is
//   { type: "lab-result", id, ok: true, result } | { type: "lab-result", id, ok: false, error, code }
//   in  { type: "lab-info", id }                            -> { info, stats }
//   in  { type: "lab-selftest", id }                        gpuSelfTest again -> { vectors, slots, ms }
//   in  { type: "lab-bench", id, seconds }                  search with target 0 for `seconds` -> { seconds, hashes, hs, ticks }
//                                                           and one { type: "lab-bench-tick", id, second, hs, hashes } per second
//   in  { type: "lab-hash", id, passwords: [hex80, ...] }   -> { hashes: [hex64, ...] } from the GPU alone
//   in  { type: "lab-close", id }                           closes the device
// With verifyVia "page" the worker has the page check hashes (a PowPool of pow-pool-worker.js workers):
//   out { type: "lab-verify", rid, passwords: [hex80, ...] }    in { type: "lab-verified", rid, hashes: [hex64, ...] | error }
import { hex, unhex } from "../../../src/bytes.mjs";
import { GpuError, GpuLane, gpuSelfTest } from "../../../src/gpu-gate.mjs";
import * as mineLib from "../../../src/mine.mjs";
import { openWebGpu } from "../../../src/webgpu/engine.mjs";

const HEX = /^[0-9a-f]*$/;
const U64 = (1n << 64n) - 1n;
const hexOf = (v, len, what) => {
  const s = String(v ?? "").toLowerCase();
  if (s.length !== len * 2 || !HEX.test(s)) throw new TypeError(`${what} must be ${len} bytes of hex`);
  return s;
};
const MAX_ROUND_BATCHES = 64; // a round never holds more batches than this, so a slowdown or a stop shows within a round

/**
 * How many nonces to hand a search round so that it lasts about targetMs: slots * round(targetMs / batchMs) from the
 * calibration at first, then from the measured rate (a batch time that is a guess must not decide how long a round runs).
 */
function roundPlanner() {
  let rate = 0; // nonces per ms, averaged over the rounds so far
  return {
    count(device, targetMs) {
      const slots = device.info.slots;
      let batches;
      if (rate > 0) batches = Math.round((rate * targetMs) / slots);
      else {
        const batchMs = device.info.calibration?.batchMs ?? device.stats?.().lastBatchMs ?? 0;
        batches = Math.round(targetMs / (batchMs > 0 ? batchMs : targetMs));
      }
      return slots * Math.min(MAX_ROUND_BATCHES, Math.max(1, batches));
    },
    note(tried, ms) {
      if (tried > 0 && ms > 0) rate = rate > 0 ? (rate + tried / ms) / 2 : tried / ms;
    },
  };
}
const idOf = (job) => (job?.id != null ? { id: job.id } : {});
const reasonOf = (e) => (e instanceof GpuError ? e.message : `the GPU lane failed: ${e?.message ?? e}`);

/** The page's words for the one case the lab cannot do anything with. */
export const GPU_WORKER_TEXT = { noGpu: "This browser has no WebGPU." };

/**
 * The worker's logic, independent of the worker global (tests drive it directly).
 *   post     (message) => void
 *   getGpu   () => the WebGPU object (navigator.gpu), read only when "open" arrives
 *   open     openWebGpu stand-in: (opts) => Promise<WebGpuDevice>
 *   mine     src/mine.mjs or a stand-in with selfTest() and powHash()
 *   openOpts extra options for open() (tests: { browser: true, mode: ... })
 *   now      clock in ms
 * Returns { onMessage(msg), state() }.
 */
export function createGpuWorker({ post, getGpu = () => globalThis.navigator?.gpu, open = openWebGpu, mine = mineLib, openOpts = {}, now = () => Date.now(), maxRestarts = 3 } = {}) {
  let state = "idle"; // idle | opening | ready | off | closed
  let lane = null;
  let gen = 0; // bumped by every start and stop: an older loop sees it and ends
  let ac = null; // aborts the search in flight
  let job = null;
  let pendingStart = null; // a start that arrived before the lane was ready
  let verifyVia = "cpu";
  let rseq = 0;
  const waiting = new Map(); // rid -> { resolve, reject }
  let engineOpts = {};

  const off = (reason, wrong = false) => {
    state = "off";
    job = null;
    pendingStart = null;
    gen++;
    ac?.abort();
    for (const w of waiting.values()) w.reject(new GpuError("the page stopped answering", "GPU_EXITED"));
    waiting.clear();
    post({ type: "lane-off", reason, ...(wrong ? { wrong: true } : {}) });
  };

  // The CPU reference for the gate: this worker's own Argon2 (one hash at a time; hits and probes are rare), or the page's pool.
  async function verifyMany(passwords) {
    if (verifyVia === "page") {
      const rid = ++rseq;
      return new Promise((resolve, reject) => {
        waiting.set(rid, { resolve, reject });
        post({ type: "lab-verify", rid, passwords: passwords.map((p) => hex(p)) });
      });
    }
    const out = [];
    for (const p of passwords) out.push(await mine.powHash(p));
    return out;
  }

  const openDevice = async () => {
    const gpu = getGpu();
    if (!gpu) throw new GpuError(GPU_WORKER_TEXT.noGpu, "GPU_NO_DEVICE");
    return open({ ...openOpts, gpu, ...engineOpts });
  };
  const reopen = async () => {
    const d = await openDevice();
    try {
      await gpuSelfTest(d, { verifyMany });
    } catch (e) {
      await d.close().catch(() => {});
      throw e;
    }
    return d;
  };

  async function openLane(msg) {
    if (state !== "idle") return; // opened once; a lane that is off stays off
    state = "opening";
    verifyVia = msg.verifyVia === "page" ? "page" : "cpu";
    engineOpts = {};
    for (const k of ["memoryMiB", "hpw", "targetDispatchMs"]) if (msg[k] != null) engineOpts[k] = Number(msg[k]);
    let device = null;
    let gpuAnswered = false; // the GPU's own self-test is running: a failure there is a wrong answer
    try {
      const st = await mine.selfTest();
      if (!st?.ok) throw new GpuError("This browser computed a test hash wrong; the GPU lane is off.", "GPU_SELF_TEST");
      if (!getGpu()) throw new GpuError(GPU_WORKER_TEXT.noGpu, "GPU_NO_DEVICE");
      device = await openDevice();
      post({ type: "gpu-info", info: device.info });
      gpuAnswered = true;
      await gpuSelfTest(device, { verifyMany });
      gpuAnswered = false;
      lane = new GpuLane({ device, verifyMany, label: "WebGPU", reopen, maxRestarts });
    } catch (e) {
      await device?.close().catch(() => {});
      return off(reasonOf(e), e?.code === "GPU_WRONG" || (gpuAnswered && e?.code === "GPU_SELF_TEST"));
    }
    if (state !== "opening") return;
    state = "ready";
    post({ type: "ready", ok: true, impl: "webgpu", name: lane.device.info.name });
    if (pendingStart) {
      const m = pendingStart;
      pendingStart = null;
      start(m);
    }
  }

  const planner = roundPlanner();

  async function grind(my, j) {
    let since = 0; // hashes since the last progress message
    let sinceMs = now();
    const flush = () => {
      if (since > 0) post({ type: "progress", hashes: since, ms: Math.max(1, now() - sinceMs), lane: "gpu", ...idOf(j) });
      since = 0;
      sinceMs = now();
    };
    while (gen === my && state === "ready" && !lane.disabled) {
      let r;
      const roundAt = now();
      try {
        // a round lasts about a second, or progressMs when that is shorter
        r = await lane.grind({ challenge: j.challenge, target: j.target, nonceStart: j.counter, count: planner.count(lane.device, Math.min(1000, j.progressMs)), signal: j.ac.signal });
      } catch (e) {
        if (gen !== my) return flush();
        if (e?.code === "GPU_WRONG" || lane.disabled || !(e instanceof GpuError)) {
          flush();
          return off(lane.disabled ?? reasonOf(e), e?.code === "GPU_WRONG" || Boolean(lane.disabled));
        }
        flush();
        continue; // GpuLane restarted the device; its restarts are bounded
      }
      planner.note(r.tried, now() - roundAt);
      since += r.tried; // computed, whatever happens to the search now
      if (gen !== my) return flush();
      j.counter = (j.counter + BigInt(r.tried)) & U64;
      j.hashes += r.tried;
      if (r.nonce) {
        job = null;
        flush();
        post({ type: "found", nonce: hex(r.nonce), powHash: hex(r.powHash), hashes: j.hashes, lane: "gpu", ...idOf(j) });
        return;
      }
      const t = now();
      if (t - sinceMs >= j.progressMs) flush();
    }
    flush();
    if (state === "ready" && lane?.disabled) off(lane.disabled, true);
  }

  function start(msg) {
    const my = ++gen;
    ac?.abort();
    let challenge;
    let target;
    let nonceStart;
    try {
      challenge = hexOf(msg.challenge, 32, "challenge");
      target = hexOf(msg.target, 32, "target");
      nonceStart = msg.nonceStart == null ? hex(globalThis.crypto.getRandomValues(new Uint8Array(8))) : hexOf(msg.nonceStart, 8, "nonceStart");
      if (msg.step != null && Number(msg.step) !== 1) throw new RangeError("step must be 1");
    } catch (e) {
      job = null;
      return post({ type: "error", message: e.message });
    }
    if (state === "opening" || state === "idle") {
      pendingStart = msg;
      return;
    }
    if (state !== "ready") return; // off: idles
    const progressMs = Number.isFinite(Number(msg.progressMs)) && Number(msg.progressMs) > 0 ? Number(msg.progressMs) : 1000;
    ac = new AbortController();
    job = {
      id: msg.id ?? null,
      challenge: unhex(challenge),
      target: BigInt(`0x${target}`),
      counter: BigInt(`0x${hex(unhex(nonceStart).reverse())}`),
      progressMs,
      hashes: 0,
      ac,
    };
    return grind(my, job);
  }

  function stop() {
    gen++;
    pendingStart = null;
    job = null;
    ac?.abort();
  }

  // ---- lab extras
  const reply = (id, ok, body) => post(ok ? { type: "lab-result", id, ok, result: body } : { type: "lab-result", id, ok, error: body.message ?? String(body), code: body.code ?? null });

  async function labCall(id, fn) {
    try {
      if (state !== "ready" && state !== "off") throw new GpuError("the GPU lane is not open", "GPU_START");
      if (!lane || lane.disabled) throw new GpuError(lane?.disabled ?? "the GPU lane is off", "GPU_START");
      reply(id, true, await fn(lane.device));
    } catch (e) {
      reply(id, false, e);
    }
  }

  async function bench(id, seconds, device) {
    const stopAt = now() + seconds * 1000;
    const challenge = globalThis.crypto.getRandomValues(new Uint8Array(32));
    let counter = BigInt(`0x${hex(globalThis.crypto.getRandomValues(new Uint8Array(8)))}`);
    const ticks = [];
    let hashes = 0;
    let tickHashes = 0;
    let tickAt = now();
    const t0 = tickAt;
    const planner = roundPlanner();
    while (now() < stopAt) {
      const roundAt = now();
      const r = await device.search({ challenge, target: 0n, nonceStart: counter, count: planner.count(device, 1000) });
      planner.note(Number(r.done), now() - roundAt);
      counter = (counter + r.done) & U64;
      hashes += Number(r.done);
      tickHashes += Number(r.done);
      const t = now();
      if (t - tickAt >= 1000) {
        const hs = (tickHashes * 1000) / (t - tickAt);
        ticks.push({ second: ticks.length + 1, hs });
        post({ type: "lab-bench-tick", id, second: ticks.length, hs, hashes: tickHashes });
        tickHashes = 0;
        tickAt = t;
      }
    }
    // the last part of a second counts as a tick when it is long enough (or when there is no tick yet)
    const tail = now() - tickAt;
    if (tickHashes > 0 && (tail >= 500 || ticks.length === 0)) {
      const hs = (tickHashes * 1000) / Math.max(1, tail);
      ticks.push({ second: ticks.length + 1, hs });
      post({ type: "lab-bench-tick", id, second: ticks.length, hs, hashes: tickHashes });
    }
    const ms = Math.max(1, now() - t0);
    return { seconds: ms / 1000, hashes, hs: (hashes * 1000) / ms, ticks };
  }

  function onMessage(msg) {
    switch (msg?.type) {
      case "open":
        return openLane(msg);
      case "start":
        return start(msg);
      case "stop":
        return stop();
      case "verify":
        return post({ type: "verified", id: msg.id, error: "verify on a CPU worker" });
      case "lab-verified": {
        const w = waiting.get(msg.rid);
        if (!w) return;
        waiting.delete(msg.rid);
        return Array.isArray(msg.hashes) ? w.resolve(msg.hashes.map((h) => unhex(h))) : w.reject(new GpuError(String(msg.error ?? "the page could not verify"), "GPU_EXITED"));
      }
      case "lab-info":
        return labCall(msg.id, async (d) => ({ info: d.info, stats: d.stats() }));
      case "lab-selftest":
        return labCall(msg.id, async (d) => {
          const t0 = now();
          const r = await gpuSelfTest(d, { verifyMany });
          return { ...r, ms: now() - t0 };
        });
      case "lab-bench":
        return labCall(msg.id, (d) => bench(msg.id, Math.max(1, Number(msg.seconds) || 10), d));
      case "lab-hash":
        return labCall(msg.id, async (d) => ({ hashes: (await d.hash(msg.passwords.map((p) => unhex(hexOf(p, 40, "password"))))).map((h) => hex(h)) }));
      case "lab-close":
        return labCall(msg.id, async (d) => {
          stop();
          await d.close();
          state = "closed"; // nothing else is answered or started on a closed lane
          return { closed: true };
        });
      default:
        post({ type: "error", message: `unknown message ${String(msg?.type)}` });
    }
  }

  return { onMessage, state: () => ({ state, running: Boolean(job), disabled: lane?.disabled ?? null }) };
}

// In a dedicated worker: wire the logic to the worker's own message port.
if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  const worker = createGpuWorker({ post: (m) => globalThis.postMessage(m) });
  globalThis.addEventListener("message", (e) => worker.onMessage(e.data));
}

#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner prototype: headless bench and correctness check.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// Measures the WebGPU miner engine headless in Node (Dawn, the "webgpu" npm package), and checks that it is correct.
// NOT for the owner's workstation: it opens a real GPU and hashes flat out. It runs on a labelled rented box
// (MURKLE_WEBGPU=gpu), or on a CPU Vulkan driver in CI (MURKLE_WEBGPU=fallback, Linux). Without the right
// environment it exits with code 2 before it imports or enumerates anything. The box holds no wallet and no
// mainnet keys; this script reads none. Install the package with `npm i --no-save webgpu@<pin>` (never --save).
//
// Usage: MURKLE_WEBGPU=gpu node scripts/webgpu-bench.mjs [actions] [options]
//   actions (run in this order; --info when none is given):
//     --info              adapter info, limits, features and the engine's own info after open
//     --startup           time from requestAdapter to a passing gpuSelfTest (the compile time is reported separately)
//     --correct N         N seeded random passwords, GPU against hash-wasm (--threads T); --noble M of them also against noble
//     --sweep             memory x HPW grid, --seconds S each (60), best cell repeated 3 times
//     --robust            the best cell (or --memory / --hpw) with Dawn's robustness checks off, next to the normal run
//     --lane S            GpuLane for S seconds against a synthetic target (--difficulty D, default 10000), pool-verified
//     --watchdog          dispatchMsMax at the auto config, and the time of one batch at 2 GiB with a single segment
//     --lose              destroys the device under a running search: GPU_EXITED, then a restart and a passing self-test
//   options: --memory MiB (default 4096)  --hpw 1|2|4|8 (2)  --segments K (auto)  --depth 1..3 (2)
//            --threads T (Argon2 reference workers, default min(8, cores - 1))  --seconds S  --runs R
//            --sweep-memory 1024,2048,4096,8192  --sweep-hpw 1,2,4  --mode gpu|fallback (from MURKLE_WEBGPU)
//            --out file   (every result is also appended to it as one JSON line)
// Each result is one JSON line on stdout: { action, ... }.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { hex } from "../src/bytes.mjs";
import { GpuError, GpuLane, gpuSelfTest } from "../src/gpu-gate.mjs";
import { passwordOf, powHashReference, targetOf } from "../src/mine.mjs";
import { createNodePowPool } from "../src/pow-pool.mjs";
import { assertWebGpuAllowed } from "../src/webgpu/guard.mjs";

const ACTIONS = ["info", "startup", "correct", "sweep", "robust", "lane", "watchdog", "lose"];

export function parseWebGpuBenchArgs(argv, env = process.env) {
  const o = {
    actions: [], correct: 20_000, noble: 2000, seconds: 60, runs: 3, lane: 600, difficulty: 10_000, memory: 4096, hpw: 2, segments: undefined, depth: 2,
    threads: Math.max(1, Math.min(8, os.availableParallelism() - 1)), sweepMemory: [1024, 2048, 4096, 8192], sweepHpw: [1, 2, 4], mode: env.MURKLE_WEBGPU === "fallback" ? "fallback" : "gpu", out: null,
  };
  const whole = (name, v, min = 1) => {
    if (!/^\d+$/.test(String(v)) || Number(v) < min) throw new Error(`--${name} needs a whole number of at least ${min}`);
    return Number(v);
  };
  const list = (name, v) => String(v).split(",").map((x) => whole(name, x));
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    const name = a.replace(/^--/, "");
    if (ACTIONS.includes(name) && a.startsWith("--")) {
      if (name === "correct") o.correct = whole("correct", value());
      else if (name === "lane") o.lane = whole("lane", value());
      o.actions.push(name);
    } else if (a === "--noble") o.noble = whole("noble", value(), 0);
    else if (a === "--threads") o.threads = whole("threads", value());
    else if (a === "--seconds") {
      o.seconds = Number(value());
      if (!(o.seconds >= 0.1)) throw new Error("--seconds needs a number of at least 0.1");
    }
    else if (a === "--runs") o.runs = whole("runs", value());
    else if (a === "--difficulty") o.difficulty = whole("difficulty", value());
    else if (a === "--memory") o.memory = whole("memory", value(), 8);
    else if (a === "--hpw") {
      o.hpw = whole("hpw", value());
      if (![1, 2, 4, 8].includes(o.hpw)) throw new Error("--hpw must be 1, 2, 4 or 8");
    } else if (a === "--segments") o.segments = whole("segments", value());
    else if (a === "--depth") {
      o.depth = whole("depth", value());
      if (o.depth > 3) throw new Error("--depth must be 1 .. 3");
    } else if (a === "--sweep-memory") o.sweepMemory = list("sweep-memory", value());
    else if (a === "--sweep-hpw") {
      o.sweepHpw = list("sweep-hpw", value());
      if (o.sweepHpw.some((h) => ![1, 2, 4, 8].includes(h))) throw new Error("--sweep-hpw values must be 1, 2, 4 or 8");
    } else if (a === "--mode") {
      o.mode = value();
      if (o.mode !== "gpu" && o.mode !== "fallback") throw new Error('--mode must be "gpu" or "fallback"');
    } else if (a === "--out") o.out = value();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.actions.length) o.actions = ["info"];
  o.actions = ACTIONS.filter((x) => o.actions.includes(x));
  return o;
}

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const round = (x, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Deterministic bytes: sha256(label || counter), block after block. */
function stream(label) {
  let n = 0;
  const tag = Buffer.from(label);
  return (len) => {
    const out = new Uint8Array(len);
    for (let o = 0; o < len; o += 32) {
      const c = Buffer.alloc(4);
      c.writeUInt32LE(n++);
      out.set(createHash("sha256").update(Buffer.concat([tag, c])).digest().subarray(0, Math.min(32, len - o)), o);
    }
    return out;
  };
}

/** One nvidia-smi sample, or null when nvidia-smi is not there. */
function smiSample() {
  const r = spawnSync("nvidia-smi", ["-i", "0", "--query-gpu=utilization.gpu,utilization.memory,memory.used,power.draw,clocks.sm,clocks.mem,temperature.gpu", "--format=csv,noheader,nounits"], { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return null;
  const [sm, mem, vram, power, smMHz, memMHz, temp] = r.stdout.trim().split(/\s*,\s*/).map(Number);
  return { smPct: sm, memPct: mem, vramMiB: vram, powerW: power, smMHz, memMHz, tempC: temp };
}

/** loadDawn(flags) -> the GPU object; createPool({ size }) -> a pool with ready / hashMany / close (both injectable for tests). */
export async function runWebGpuBench(o, { log = console.error, emit = () => {}, loadDawn = defaultLoadDawn, createPool = createNodePowPool } = {}) {
  const { openWebGpu } = await import("../src/webgpu/engine.mjs");
  const results = {};
  const record = (action, data) => {
    results[action] = data;
    emit(action, data);
  };
  const gpuFor = async (flags = []) => loadDawn(flags);
  const openDev = async ({ memory = o.memory, hpw = o.hpw, segments = o.segments, flags = [] } = {}) =>
    openWebGpu({ gpu: await gpuFor(flags), mode: o.mode, memoryMiB: memory, hpw, segments, pipelineDepth: o.depth, log: (m) => log(`  engine: ${m}`) });

  if (os.constants.priority && o.threads < os.availableParallelism() && process.env.MURKLE_BENCH_NORMAL_PRIORITY !== "1") {
    try {
      os.setPriority(os.constants.priority.PRIORITY_LOW);
    } catch {
      // not allowed: keep going
    }
  }
  const pool = await createPool({ size: o.threads });
  const verifyMany = (p) => pool.hashMany(p);
  let best = { memory: o.memory, hpw: o.hpw };
  try {
    const ready = await pool.ready();
    log(`Argon2 reference: ${ready.impl}, ${ready.workers} workers`);

    for (const action of o.actions) {
      log(`action: ${action}`);
      if (action === "info") {
        const dev = await openDev({ memory: Math.min(o.memory, 64), segments: o.segments ?? 1 });
        try {
          record("info", { info: dev.info, host: { cpus: os.availableParallelism(), platform: process.platform, arch: process.arch, node: process.version }, smi: smiSample() });
        } finally {
          await dev.close();
        }
      } else if (action === "startup") {
        const t0 = Date.now();
        const dev = await openDev();
        const openMs = Date.now() - t0;
        try {
          const t1 = Date.now();
          const st = await gpuSelfTest(dev, { verifyMany });
          record("startup", { openMs, compileMs: dev.info.calibration.compileMs, selfTestMs: Date.now() - t1, totalMs: Date.now() - t0, slots: st.slots, segments: dev.info.segments, banks: dev.info.banks, ok: Date.now() - t0 <= 15_000 });
        } finally {
          await dev.close();
        }
      } else if (action === "correct") {
        record("correct", await correctness(o, openDev, pool));
      } else if (action === "sweep") {
        const sweep = await runSweep(o, openDev, log);
        best = { memory: sweep.best.memory, hpw: sweep.best.hpw };
        record("sweep", sweep);
      } else if (action === "robust") {
        const normal = await oneRun(o, openDev, best, o.seconds);
        const robust = await oneRun(o, openDev, { ...best, flags: ["enable-dawn-features=disable_robustness"] }, o.seconds);
        record("robust", { config: best, normalHs: normal.hs, noRobustnessHs: robust.hs, deltaPct: round(((robust.hs - normal.hs) / normal.hs) * 100, 1), note: "Dawn flag, Node only: browsers always keep the bounds checks" });
      } else if (action === "lane") {
        record("lane", await laneRun(o, openDev, verifyMany, best));
      } else if (action === "watchdog") {
        const auto = await openDev({ ...best, segments: undefined });
        const autoInfo = { segments: auto.info.segments, slots: auto.info.slots, dispatchMsMax: auto.info.calibration.dispatchMsMax, batchMs: auto.info.calibration.batchMs, source: auto.info.calibration.dispatchMsSource };
        await auto.close();
        const forced = await openDev({ memory: 2048, hpw: o.hpw, segments: 1 });
        let forcedMs;
        try {
          const t = Date.now();
          await forced.search({ challenge: new Uint8Array(32), target: 0n, nonceStart: 0n, count: forced.info.slots });
          forcedMs = Date.now() - t;
        } finally {
          await forced.close();
        }
        record("watchdog", { auto: autoInfo, autoOk: autoInfo.dispatchMsMax !== null && autoInfo.dispatchMsMax <= 100, forcedSingleSegment2GiB: { slots: forced.info.slots, ms: forcedMs } });
      } else if (action === "lose") {
        record("lose", await loseRun(o, openDev, verifyMany, best));
      }
    }
  } finally {
    await pool.close();
  }
  return results;
}

async function correctness(o, openDev, pool) {
  const dev = await openDev();
  const r = { random: o.correct, noble: 0, mismatches: 0, notes: [], slots: dev.info.slots, vectors: 0 };
  try {
    const next = stream("murkle/webgpu-bench/v1");
    const chunk = Math.max(1, Math.min(4096, dev.info.slots * 2));
    const picks = [];
    const t0 = Date.now();
    for (let done = 0; done < o.correct; done += chunk) {
      const n = Math.min(chunk, o.correct - done);
      const pws = Array.from({ length: n }, () => next(40));
      const [gpu, ref] = await Promise.all([dev.hash(pws), pool.hashMany(pws)]);
      gpu.forEach((g, i) => {
        if (hex(g) !== hex(ref[i])) {
          r.mismatches += 1;
          if (r.notes.length < 5) r.notes.push({ index: done + i, password: hex(pws[i]), gpu: hex(g), reference: hex(ref[i]) });
        }
      });
      const stride = Math.max(1, Math.floor(o.correct / Math.max(1, o.noble)));
      for (let i = 0; i < n && picks.length < o.noble; i += stride) picks.push([pws[i], ref[i]]);
    }
    r.ms = Date.now() - t0;
    for (const [pw, ref] of picks) {
      r.noble += 1;
      if (hex(powHashReference(pw)) !== hex(ref)) {
        r.mismatches += 1;
        r.notes.push("noble disagrees with hash-wasm");
      }
    }
  } finally {
    await dev.close();
  }
  r.ok = r.mismatches === 0;
  return r;
}

async function oneRun(o, openDev, cfg, seconds) {
  const dev = await openDev(cfg);
  const smi = [];
  const timer = setInterval(() => {
    const s = smiSample();
    if (s) smi.push(s);
  }, 1000);
  try {
    const slots = dev.info.slots;
    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    let hashes = 0n;
    let start = 1n << 40n;
    while (Date.now() - t0 < seconds * 1000) {
      const r = await dev.search({ challenge: new Uint8Array(32).fill(5), target: 0n, nonceStart: start, count: slots * 8, probe: 0 });
      hashes += r.done;
      start += r.done;
    }
    const wall = (Date.now() - t0) / 1000;
    const cpu = process.cpuUsage(cpu0);
    return {
      hs: round(Number(hashes) / wall), slots, banks: dev.info.banks, segments: dev.info.segments, batchMs: round(dev.info.calibration.batchMs, 1), dispatchMsMax: round(dev.info.calibration.dispatchMsMax, 1),
      lastBatchMs: round(dev.stats().lastBatchMs, 1), nodeCpuPct: round(((cpu.user + cpu.system) / 1e6 / wall) * 100, 1),
      smSmiPct: round(avg(smi.map((s) => s.smPct)), 1), memSmiPct: round(avg(smi.map((s) => s.memPct)), 1), powerW: round(avg(smi.map((s) => s.powerW)), 1),
      smMHz: round(avg(smi.map((s) => s.smMHz))), memMHz: round(avg(smi.map((s) => s.memMHz))), vramMiB: round(Math.max(0, ...smi.map((s) => s.vramMiB))), tempC: round(Math.max(0, ...smi.map((s) => s.tempC))),
    };
  } finally {
    clearInterval(timer);
    await dev.close();
  }
}

async function runSweep(o, openDev, log) {
  const rows = [];
  for (const memory of o.sweepMemory) {
    for (const hpw of o.sweepHpw) {
      log(`  sweep: ${memory} MiB, HPW ${hpw}`);
      try {
        const run = await oneRun(o, openDev, { memory, hpw, segments: undefined }, o.seconds);
        rows.push({ memory, hpw, ...run });
      } catch (e) {
        rows.push({ memory, hpw, error: `${e.code ?? "error"}: ${e.message}`.slice(0, 300) });
      }
    }
  }
  const ok = rows.filter((r) => !r.error);
  if (!ok.length) throw new Error("every sweep cell failed");
  const bestRow = [...ok].sort((a, b) => b.hs - a.hs)[0];
  const repeats = [];
  for (let i = 0; i < o.runs; i++) repeats.push(await oneRun(o, openDev, { memory: bestRow.memory, hpw: bestRow.hpw }, o.seconds));
  return { rows, best: { memory: bestRow.memory, hpw: bestRow.hpw, hs: bestRow.hs }, repeats, meanHs: round(avg(repeats.map((r) => r.hs))) };
}

async function laneRun(o, openDev, verifyMany, best) {
  const open = async () => {
    const dev = await openDev(best);
    await gpuSelfTest(dev, { verifyMany });
    return dev;
  };
  const lane = new GpuLane({ device: await open(), verifyMany, label: "WebGPU", reopen: open });
  const target = targetOf(o.difficulty);
  const next = stream("murkle/webgpu-bench/lane");
  const challenge = next(32);
  let count = lane.device.info.slots * 4;
  let tried = 0;
  let found = 0;
  let wrong = 0;
  const errors = [];
  const t0 = Date.now();
  while (Date.now() - t0 < o.lane * 1000 && !lane.disabled) {
    const t = Date.now();
    try {
      const r = await lane.grind({ challenge, target, nonceStart: BigInt(`0x${hex(next(8))}`), count, timeoutMs: 120_000 });
      tried += r.tried;
      if (r.nonce) {
        found += 1;
        // every returned nonce is hashed again by the reference, here too
        const [h] = await verifyMany([passwordOf(challenge, r.nonce)]);
        if (hex(h) !== hex(r.powHash)) wrong += 1;
      }
      const ms = Date.now() - t;
      if (ms > 0 && r.tried > 0) count = Math.max(lane.device.info.slots, Math.min(2 ** 31, Math.round((2000 * r.tried) / ms)));
    } catch (e) {
      if (e instanceof GpuError && e.code === "GPU_WRONG") wrong += 1;
      errors.push(`${e.code ?? "error"}: ${e.message}`.slice(0, 200));
      if (errors.length > 20) break;
    }
  }
  const seconds = (Date.now() - t0) / 1000;
  await lane.close();
  return { seconds: round(seconds, 1), difficulty: o.difficulty, hashes: tried, hs: round(tried / seconds), verified: found, reportedHits: lane.hits, expectedHits: round(lane.hashed / o.difficulty, 1), gpuWrong: wrong, restarts: lane.restarts, disabled: lane.disabled, errors: errors.slice(0, 5), ok: wrong === 0 && !lane.disabled };
}

async function loseRun(o, openDev, verifyMany, best) {
  const dev = await openDev(best);
  const search = dev.search({ challenge: new Uint8Array(32), target: 0n, nonceStart: 0n, count: 2 ** 40 });
  await new Promise((r) => setTimeout(r, 500));
  dev._loseDevice();
  let code = null;
  let message = null;
  try {
    await search;
  } catch (e) {
    code = e.code ?? null;
    message = String(e.message).slice(0, 200);
  }
  const lost = await Promise.race([dev.lost, new Promise((r) => setTimeout(() => r(null), 5000))]);
  await dev.close();
  // a restart, as GpuLane does
  const again = await openDev(best);
  let restartOk = false;
  try {
    await gpuSelfTest(again, { verifyMany });
    restartOk = true;
  } finally {
    await again.close();
  }
  return { code, message, lost, restartOk, ok: code === "GPU_EXITED" && restartOk };
}

async function defaultLoadDawn(flags) {
  const m = await import("webgpu"); // only after the guard has passed
  Object.assign(globalThis, m.globals ?? {});
  return m.create(flags);
}

// Not run when imported (the tests import parseWebGpuBenchArgs).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let o;
  try {
    o = parseWebGpuBenchArgs(process.argv.slice(2));
    assertWebGpuAllowed({ mode: o.mode }); // before anything is imported or enumerated
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  try {
    const emit = (action, data) => {
      const line = JSON.stringify({ action, when: new Date().toISOString(), ...data }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
      console.log(line);
      if (o.out) appendFileSync(o.out, `${line}\n`);
    };
    const results = await runWebGpuBench(o, { emit });
    const failed = Object.entries(results).filter(([, v]) => v?.ok === false || v?.autoOk === false);
    for (const [k] of failed) console.error(`FAIL: ${k}`);
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.error(`${e.code ?? "error"}: ${e.message}`);
    process.exitCode = e.code === "GPU_NO_DEVICE" ? 2 : 1;
  }
}


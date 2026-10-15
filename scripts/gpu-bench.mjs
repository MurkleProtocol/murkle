#!/usr/bin/env node
// Measures murkle-gpu on a rented GPU box (docs/design/mining.md section 12.2, gpu/README.md section "Measuring").
// NOT for the owner's workstation: it hashes flat out for tens of minutes. It runs on a labelled Vast
// instance with self-destruct armed, and the instance is destroyed afterwards. The box holds no wallet
// and no mainnet keys; this script reads none.
//
// Usage: node scripts/gpu-bench.mjs [--build] [--bin <path>] [--device N] [--only build,correctness,sweep,lane]
//          [--random N] [--noble N] [--seconds S] [--runs R] [--lane-seconds S] [--difficulty D]
//          [--workers N|all] [--out report.json] [--fake]
//   (npm run gpu:bench -- --build --workers all --out bench.json)
//
//   --build           build gpu/ with nvcc first (bash gpu/build.sh) and record the toolkit and the driver
//   --bin <path>      the binary (default: MURKLE_GPU_BIN, then gpu/bin/)
//   --only <list>     steps to run, comma separated (default all four)
//   --random N        random passwords GPU against hash-wasm (default 100000); --noble N of them also against noble (2000)
//   --seconds S       length of one sweep run (60); --runs R runs per setting (3)
//   --lane-seconds S  the GpuLane run (600) at --difficulty D (10000)
//   --workers N|all   Argon2 workers for the reference (default min(8, cores - 1); "all" on the rented box)
//   --fake            test the harness with the Node stand-in of test/fixtures (a few seconds, no GPU)
//
// Steps: 1 build, 2 correctness (acceptance: 0 mismatches), 3 sweep S in {25%, 50%, 100%} of the default
// slots x W in {1, 2, 4, 8}, 4 lane run (acceptance: no GPU_WRONG). Step 5 of the plan, an older driver, is
// step 2 run on that box (--only correctness). The report is printed as JSON (and written to --out) and
// ends with the acceptance table.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { hex, unhex } from "../src/bytes.mjs";
import { GpuError, GpuLane, gpuBinaryPath, gpuSelfTest, listGpus, openGpu } from "../src/gpu.mjs";
import { counterOf, powHashReference, targetOf } from "../src/mine.mjs";
import { createNodePowPool } from "../src/pow-pool.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const STEPS = ["build", "correctness", "sweep", "lane"];
const WS = [1, 2, 4, 8];
const FRACTIONS = [0.25, 0.5, 1];
const TICKS = 100; // /proc clock ticks per second on Linux

export function parseBenchArgs(argv) {
  const o = {
    build: false, bin: null, device: 0, only: STEPS, random: 100_000, noble: 2000, seconds: 60, runs: 3, laneSeconds: 600, difficulty: 10_000,
    workers: Math.max(1, Math.min(8, os.availableParallelism() - 1)), out: null, fake: false,
  };
  const whole = (name, v, min = 1) => {
    if (!/^\d+$/.test(String(v)) || Number(v) < min) throw new Error(`--${name} needs a whole number of at least ${min}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--build") o.build = true;
    else if (a === "--fake") o.fake = true;
    else if (a === "--bin") o.bin = value();
    else if (a === "--device") o.device = whole("device", value(), 0);
    else if (a === "--only") {
      o.only = value().split(",");
      for (const s of o.only) if (!STEPS.includes(s)) throw new Error(`--only: unknown step "${s}" (${STEPS.join(", ")})`);
    } else if (a === "--random") o.random = whole("random", value());
    else if (a === "--noble") o.noble = whole("noble", value(), 0);
    else if (a === "--seconds") {
      o.seconds = Number(value());
      if (!(o.seconds >= 0.1)) throw new Error("--seconds needs a number of at least 0.1");
    }
    else if (a === "--runs") o.runs = whole("runs", value());
    else if (a === "--lane-seconds") o.laneSeconds = whole("lane-seconds", value());
    else if (a === "--difficulty") o.difficulty = whole("difficulty", value());
    else if (a === "--workers") {
      const v = value();
      o.workers = v === "all" ? os.availableParallelism() : whole("workers", v);
    } else if (a === "--out") o.out = value();
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.build) o.only = ["build", ...o.only.filter((s) => s !== "build")];
  return o;
}

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

// The stand-in is told what to hash with and how big a batch is; the real binary takes its defaults.
const fakeArgs = (o, hash) => (o.fake ? ["--hash", hash, "--slots", "64"] : []);

const smiArgs = (device, fields) => ["-i", String(device), `--query-gpu=${fields}`, "--format=csv,noheader,nounits"];

/** One nvidia-smi sample of the device, or null when nvidia-smi is not there. */
export function smiSample(device) {
  const r = spawnSync("nvidia-smi", smiArgs(device, "utilization.gpu,memory.used,power.draw,clocks.sm,clocks.mem,temperature.gpu"), { encoding: "utf8", timeout: 5000 });
  if (r.status !== 0 || !r.stdout) return null;
  const [util, mem, power, sm, memClock, temp] = r.stdout.trim().split(/\s*,\s*/).map(Number);
  return { util, memMiB: mem, powerW: power, smMHz: sm, memMHz: memClock, tempC: temp };
}

/** Seconds of CPU time a process has used (Linux /proc), or null. */
function cpuSeconds(pid) {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = f.slice(f.lastIndexOf(")") + 2).split(" ");
    return (Number(rest[11]) + Number(rest[12])) / TICKS;
  } catch {
    return null;
  }
}

const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
const round = (x, d = 0) => (x === null || x === undefined ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Opens a device and times the start; remembers the child's pid for the CPU figures. */
async function openTimed({ bin, device, args, spawnFn }) {
  const children = [];
  const spawnWrap = (b, a, o) => {
    const c = spawnFn(b, a, o);
    children.push(c);
    return c;
  };
  const t0 = Date.now();
  const dev = await openGpu({ bin, device, args, spawn: spawnWrap });
  return { dev, startMs: Date.now() - t0, pid: children[0]?.pid ?? null };
}

async function sh(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.stderr.on("data", (d) => (out += d));
    c.on("error", (e) => resolve({ code: -1, out: String(e.message) }));
    c.on("close", (code) => resolve({ code, out }));
  });
}

async function stepBuild(o, report) {
  const nvcc = await sh(process.env.NVCC || "nvcc", ["--version"]);
  const driver = spawnSync("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"], { encoding: "utf8" });
  const t0 = Date.now();
  const script = process.platform === "win32" ? ["powershell", ["-NoProfile", "-File", `${ROOT}gpu/build.ps1`]] : ["bash", [`${ROOT}gpu/build.sh`]];
  const built = o.fake ? { code: 0, out: "skipped (--fake)" } : await sh(script[0], script[1], { cwd: ROOT });
  report.build = {
    ok: built.code === 0, seconds: round((Date.now() - t0) / 1000, 1), nvcc: nvcc.out.trim().split("\n").slice(-2).join(" "),
    gpu: driver.stdout?.trim() ?? null, tail: built.out.trim().split("\n").slice(-4),
  };
  if (built.code !== 0) throw new Error(`the build failed:\n${built.out.slice(-2000)}`);
}

async function stepCorrectness({ o, bin, spawnFn, pool }, report) {
  const vectors = JSON.parse(readFileSync(`${ROOT}test/fixtures/gpu-vectors.json`, "utf8")).vectors;
  const { dev, startMs } = await openTimed({ bin, device: o.device, args: fakeArgs(o, "argon2"), spawnFn });
  const r = { mismatches: 0, vectors: vectors.length, random: o.random, noble: 0, boundary: 0, startMs, notes: [] };
  try {
    const t0 = Date.now();
    const st = await gpuSelfTest(dev, { verifyMany: (p) => pool.hashMany(p) });
    r.selfTestMs = Date.now() - t0;
    r.slots = st.slots;
    const tags = await dev.hash(vectors.map((v) => unhex(v.password)));
    vectors.forEach((v, i) => {
      if (hex(tags[i]) !== v.tag) {
        r.mismatches += 1;
        r.notes.push(`vector ${v.name}`);
      }
    });
    // boundary searches on every vector: equality hits, one less misses
    for (const v of vectors) {
      const pw = unhex(v.password);
      const base = { challenge: pw.slice(0, 32), nonceStart: counterOf(pw.slice(32)), count: 1, probe: 0 };
      const tag = BigInt(`0x${v.tag}`);
      const hit = await dev.search({ ...base, target: tag });
      const miss = tag > 0n ? await dev.search({ ...base, target: tag - 1n }) : { candidates: [] };
      r.boundary += 1;
      if (hit.candidates.length !== 1 || hex(hit.candidates[0].hash) !== v.tag || miss.candidates.length !== 0) {
        r.mismatches += 1;
        r.notes.push(`boundary ${v.name}`);
      }
    }
    // seeded random passwords, GPU against hash-wasm in chunks
    const next = stream("murkle/gpu-bench/v1");
    const chunk = Math.max(1, Math.min(4096, st.slots * 2));
    const tr = Date.now();
    const noblePicks = [];
    for (let done = 0; done < o.random; done += chunk) {
      const n = Math.min(chunk, o.random - done);
      const pws = Array.from({ length: n }, () => next(40));
      const [gpu, ref] = await Promise.all([dev.hash(pws), pool.hashMany(pws)]);
      gpu.forEach((g, i) => {
        if (hex(g) !== hex(ref[i])) {
          r.mismatches += 1;
          if (r.notes.length < 20) r.notes.push(`random ${done + i}`);
        }
      });
      const stride = Math.max(1, Math.floor(o.random / Math.max(1, o.noble)));
      for (let i = 0; i < n && noblePicks.length < o.noble; i += stride) noblePicks.push([pws[i], ref[i]]);
    }
    r.randomMs = Date.now() - tr;
    // a sample of them also against noble (the reference of the consensus rule)
    for (const [pw, ref] of noblePicks.slice(0, o.noble)) {
      r.noble += 1;
      if (hex(powHashReference(pw)) !== hex(ref)) {
        r.mismatches += 1;
        r.notes.push("noble disagrees with hash-wasm");
      }
    }
  } finally {
    await dev.close();
  }
  report.correctness = r;
}

async function stepSweep({ o, bin, spawnFn }, report) {
  // The default slots, as the binary chooses them for this card.
  const probe = await openTimed({ bin, device: o.device, args: fakeArgs(o, "sha256"), spawnFn });
  const defaultSlots = probe.dev.info.slots;
  const sms = probe.dev.info.sms;
  await probe.dev.close();
  const rows = [];
  for (const f of FRACTIONS) {
    for (const w of WS) {
      const unit = Math.max(1, sms * w);
      const slots = Math.max(w, f === 1 ? defaultSlots : Math.floor((defaultSlots * f) / unit) * unit || w);
      const runs = [];
      for (let run = 1; run <= o.runs; run++) {
        const args = [...(o.fake ? ["--hash", "sha256"] : []), "--slots", String(slots), "--hashes-per-block", String(w)];
        const { dev, startMs, pid } = await openTimed({ bin, device: o.device, args, spawnFn });
        const samples = [];
        const timer = o.fake
          ? null
          : setInterval(() => {
              const s = smiSample(o.device);
              if (s) samples.push(s);
            }, 1000);
        const cpu0 = process.cpuUsage();
        const child0 = pid ? cpuSeconds(pid) : null;
        const t0 = Date.now();
        let hashes = 0n;
        let start = BigInt(run) << 40n;
        while (Date.now() - t0 < o.seconds * 1000) {
          const r = await dev.search({ challenge: new Uint8Array(32).fill(5), target: 0n, nonceStart: start, count: slots * 4, probe: 0 });
          hashes += r.done;
          start += r.done;
        }
        const wall = (Date.now() - t0) / 1000;
        if (timer) clearInterval(timer);
        const child1 = pid ? cpuSeconds(pid) : null;
        const nodeCpu = process.cpuUsage(cpu0);
        // cancel latency: abort a long search 300 ms in and time the answer
        const ac = new AbortController();
        const running = dev.search({ challenge: new Uint8Array(32), target: 0n, nonceStart: 0n, count: 2n ** 40n, probe: 0, signal: ac.signal });
        await new Promise((r) => setTimeout(r, 300));
        const t1 = Date.now();
        ac.abort();
        await running;
        const cancelMs = Date.now() - t1;
        await dev.close();
        runs.push({
          hs: round(Number(hashes) / wall), startMs, cancelMs,
          util: round(avg(samples.map((s) => s.util)), 1), memMiB: round(Math.max(0, ...samples.map((s) => s.memMiB))), powerW: round(avg(samples.map((s) => s.powerW)), 1),
          smMHz: round(avg(samples.map((s) => s.smMHz))), memMHz: round(avg(samples.map((s) => s.memMHz))), tempC: round(Math.max(0, ...samples.map((s) => s.tempC))),
          gpuProcessCpuPct: child0 !== null && child1 !== null ? round(((child1 - child0) / wall) * 100, 1) : null,
          nodeCpuPct: round((((nodeCpu.user + nodeCpu.system) / 1e6) / wall) * 100, 1),
        });
      }
      const best = [...runs].sort((a, b) => b.hs - a.hs)[0];
      rows.push({ slotsPercent: f * 100, slots, hashesPerBlock: w, runs, meanHs: round(avg(runs.map((r) => r.hs))), best });
    }
  }
  report.sweep = { defaultSlots, sms, rows, best: [...rows].sort((a, b) => b.meanHs - a.meanHs)[0] };
}

async function stepLane({ o, bin, spawnFn, pool }, report) {
  const args = fakeArgs(o, "argon2");
  const verifyMany = (p) => pool.hashMany(p);
  const open = async () => {
    const dev = (await openTimed({ bin, device: o.device, args, spawnFn })).dev;
    await gpuSelfTest(dev, { verifyMany });
    return dev;
  };
  const lane = new GpuLane({ device: await open(), verifyMany, label: `GPU ${o.device}`, reopen: open });
  const target = targetOf(o.difficulty);
  const next = stream("murkle/gpu-bench/lane");
  const challenge = next(32);
  let count = 8192;
  let tried = 0;
  let found = 0;
  let wrong = 0;
  let errors = [];
  const t0 = Date.now();
  while (Date.now() - t0 < o.laneSeconds * 1000 && !lane.disabled) {
    const t = Date.now();
    try {
      const r = await lane.grind({ challenge, target, nonceStart: BigInt(`0x${hex(next(8))}`), count, timeoutMs: 120_000 });
      tried += r.tried;
      if (r.nonce) found += 1;
      const ms = Date.now() - t;
      if (ms > 0 && r.tried > 0) count = Math.max(1, Math.min(2 ** 31, Math.round((2000 * r.tried) / ms)));
    } catch (e) {
      if (e instanceof GpuError && e.code === "GPU_WRONG") wrong += 1;
      errors.push(`${e.code ?? "error"}: ${e.message}`.slice(0, 200));
      if (errors.length > 20) break;
    }
  }
  const seconds = (Date.now() - t0) / 1000;
  await lane.close();
  report.lane = {
    seconds: round(seconds, 1), difficulty: o.difficulty, hashes: tried, hs: round(tried / seconds), verified: found, reportedHits: lane.hits,
    expectedHits: round(lane.hashed / o.difficulty, 1), gpuWrong: wrong, restarts: lane.restarts, disabled: lane.disabled, errors: errors.slice(0, 5),
  };
}

/** The acceptance table of the plan: [{ measure, target, got, ok }]. */
export function acceptance(report, gpuName = "", { fake = false } = {}) {
  const rows = [];
  const add = (measure, target, got, ok) => rows.push({ measure, target, got, ok });
  const best = report.sweep?.best;
  const name = String(gpuName || report.build?.gpu || "");
  if (best) {
    const floor = /4090/.test(name) ? 50_000 : /3060|3070/.test(name) ? 12_000 : null;
    if (floor) add(`${/4090/.test(name) ? "RTX 4090" : "RTX 3060/3070"} H/s`, `>= ${floor.toLocaleString("en-US")}`, best.meanHs, best.meanHs >= floor);
    add("GPU utilisation", ">= 95 %", best.best.util, best.best.util === null ? null : best.best.util >= 95);
    add("Host CPU per GPU", "<= 25 % of one core", best.best.gpuProcessCpuPct, best.best.gpuProcessCpuPct === null ? null : best.best.gpuProcessCpuPct + (best.best.nodeCpuPct ?? 0) <= 25);
    const cancel = Math.max(...report.sweep.rows.flatMap((r) => r.runs.map((x) => x.cancelMs)));
    add("Cancel latency", "<= 250 ms", cancel, cancel <= 250);
    const start = Math.max(...report.sweep.rows.flatMap((r) => r.runs.map((x) => x.startMs))) + (report.correctness?.selfTestMs ?? 0);
    add("Start-up (allocation plus self-test)", "<= 15 s", round(start / 1000, 1), start <= 15_000);
  }
  if (report.correctness) add("Correctness mismatches", "0", report.correctness.mismatches, report.correctness.mismatches === 0);
  if (report.lane) add("Lane run GPU_WRONG", "0", report.lane.gpuWrong, report.lane.gpuWrong === 0 && !report.lane.disabled);
  // the Node stand-in hashes on the CPU: the hardware rows say nothing about a GPU, so they are informational only
  const hardware = /H\/s$|^GPU utilisation|^Host CPU|^Cancel latency|^Start-up/;
  return fake ? rows.map((r) => (hardware.test(r.measure) ? { ...r, ok: null, note: "stand-in" } : r)) : rows;
}

export async function runBench(o, { log = console.error } = {}) {
  let bin = o.bin;
  let spawnFn = spawn;
  if (o.fake) {
    const { fakeSpawn } = await import("../test/fixtures/fake-gpu-spawn.mjs");
    spawnFn = fakeSpawn(["--hash", "argon2"]);
    bin = "fake";
  } else if (!bin) bin = gpuBinaryPath();
  const report = { when: new Date().toISOString(), node: process.version, host: { cpus: os.availableParallelism(), platform: process.platform, arch: process.arch }, options: { ...o, bin }, driver: null };
  const smi = spawnSync("nvidia-smi", ["--query-gpu=driver_version", "--format=csv,noheader"], { encoding: "utf8" });
  if (smi.status === 0) report.driver = smi.stdout.trim().split("\n")[0];
  if (o.only.includes("build")) {
    log("step 1: build");
    await stepBuild(o, report);
    if (!o.bin && !o.fake) bin = gpuBinaryPath();
  }
  if (!o.fake) {
    const list = await listGpus({ bin, spawn: spawnFn });
    report.devices = list;
    log(`devices: ${list.map((d) => `${d.index} ${d.name} (${d.vramMiB} MiB)`).join("; ")}`);
  }
  if (os.constants.priority && !o.fake && process.env.MURKLE_BENCH_NORMAL_PRIORITY !== "1" && o.workers < os.availableParallelism()) {
    try {
      os.setPriority(os.constants.priority.PRIORITY_LOW); // a workstation run keeps the machine usable; "--workers all" is the rented box
    } catch {
      // not allowed: keep going
    }
  }
  const pool = await createNodePowPool({ size: o.workers });
  try {
    const ready = await pool.ready();
    log(`Argon2 reference: ${ready.impl}, ${ready.workers} workers`);
    const ctx = { o, bin, spawnFn, pool };
    if (o.only.includes("correctness")) {
      log("step 2: correctness");
      await stepCorrectness(ctx, report);
    }
    if (o.only.includes("sweep")) {
      log("step 3: sweep");
      await stepSweep(ctx, report);
    }
    if (o.only.includes("lane")) {
      log("step 4: lane run");
      await stepLane(ctx, report);
    }
  } finally {
    await pool.close();
  }
  report.acceptance = acceptance(report, report.devices?.[o.device]?.name, { fake: o.fake });
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const o = parseBenchArgs(process.argv.slice(2));
    const report = await runBench(o);
    const text = JSON.stringify(report, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
    if (o.out) writeFileSync(o.out, `${text}\n`);
    console.log(text);
    console.error("\nacceptance:");
    for (const r of report.acceptance) console.error(`  ${r.ok === null ? "?" : r.ok ? "ok  " : "FAIL"} ${r.measure}: ${r.got} (target ${r.target})`);
    process.exitCode = report.acceptance.some((r) => r.ok === false) ? 1 : 0;
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}

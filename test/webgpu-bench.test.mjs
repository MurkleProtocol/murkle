// scripts/webgpu-bench.mjs without a GPU: the argument parser, the refusal (exit code 2 before anything is imported),
// and the whole bench logic over the stand-in WebGPU of test/fixtures/fake-webgpu.mjs with a stand-in reference pool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { hex, unhex } from "../src/bytes.mjs";
import { GPU_SELF_TEST_VECTORS } from "../src/gpu-gate.mjs";
import { SELF_TEST_VECTORS } from "../src/mine.mjs";
import { parseWebGpuBenchArgs, runWebGpuBench } from "../scripts/webgpu-bench.mjs";
import { createFakeGpu } from "./fixtures/fake-webgpu.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/webgpu-bench.mjs", import.meta.url));

test("argument parsing: actions, numbers, lists, modes and refusals", () => {
  assert.deepEqual(parseWebGpuBenchArgs([], {}).actions, ["info"]);
  const o = parseWebGpuBenchArgs(["--sweep", "--correct", "100", "--noble", "5", "--threads", "3", "--seconds", "7", "--hpw", "4", "--memory", "2048", "--sweep-memory", "1024,2048", "--sweep-hpw", "1,2", "--lane", "30", "--lose", "--out", "r.json"], { MURKLE_WEBGPU: "fallback" });
  assert.deepEqual(o.actions, ["correct", "sweep", "lane", "lose"]);
  assert.deepEqual([o.correct, o.noble, o.threads, o.seconds, o.hpw, o.memory, o.lane, o.out, o.mode], [100, 5, 3, 7, 4, 2048, 30, "r.json", "fallback"]);
  assert.deepEqual([o.sweepMemory, o.sweepHpw], [[1024, 2048], [1, 2]]);
  assert.equal(parseWebGpuBenchArgs([], { MURKLE_WEBGPU: "gpu" }).mode, "gpu");
  assert.equal(parseWebGpuBenchArgs([], {}).difficulty, 3_600_000, "--lane defaults to the live MURK difficulty");
  assert.equal(parseWebGpuBenchArgs(["--lane", "5", "--difficulty", "10000"], {}).difficulty, 10_000, "--difficulty overrides it");
  assert.throws(() => parseWebGpuBenchArgs(["--hpw", "3"]), /hpw/);
  assert.throws(() => parseWebGpuBenchArgs(["--depth", "4"]), /depth/);
  assert.throws(() => parseWebGpuBenchArgs(["--nope"]), /unknown argument/);
  assert.throws(() => parseWebGpuBenchArgs(["--correct"]), /needs a value/);
  assert.throws(() => parseWebGpuBenchArgs(["--mode", "turbo"]), /mode/);
  assert.equal(parseWebGpuBenchArgs(["--seconds", "0.5"]).seconds, 0.5);
  assert.throws(() => parseWebGpuBenchArgs(["--seconds", "0"]), /seconds/);
});

test("without MURKLE_WEBGPU the script exits with code 2 and names the reason, before it imports anything", () => {
  const env = { ...process.env };
  delete env.MURKLE_WEBGPU;
  delete env.VK_ICD_FILENAMES;
  delete env.VK_DRIVER_FILES;
  const r = spawnSync(process.execPath, [SCRIPT, "--info"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /WebGPU is disabled here/);
  assert.equal(r.stdout, "");
  const f = spawnSync(process.execPath, [SCRIPT, "--info", "--mode", "fallback"], { env: { ...env, MURKLE_WEBGPU: "fallback" }, encoding: "utf8", timeout: 30_000 });
  assert.equal(f.status, 2);
  assert.match(f.stderr, /VK_ICD_FILENAMES|Linux only/);
  const bad = spawnSync(process.execPath, [SCRIPT, "--hpw", "9"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(bad.status, 2);
});

const VECTORS = [...SELF_TEST_VECTORS.filter((v) => !v.salt && v.password.length === 80), ...GPU_SELF_TEST_VECTORS];
const TRUE_TAGS = new Map(VECTORS.map((v) => [v.password, unhex(v.powHash)]));
const tagOf = (pw) => TRUE_TAGS.get(hex(pw)) ?? sha256(pw);

/** Sets MURKLE_WEBGPU=gpu for the engine's guard (the stand-in touches no GPU) and restores it afterwards. */
function withGpuEnv(t) {
  const was = process.env.MURKLE_WEBGPU;
  process.env.MURKLE_WEBGPU = "gpu";
  t.after(() => {
    if (was === undefined) delete process.env.MURKLE_WEBGPU;
    else process.env.MURKLE_WEBGPU = was;
  });
}
const standInPool = async () => ({ ready: async () => ({ impl: "stand-in", workers: 1 }), hashMany: async (pws) => pws.map((p) => tagOf(p)), close: async () => {} });

test("the bench logic over the stand-in GPU: info, startup, correctness, sweep, robustness, lane, watchdog and loss", { timeout: 120_000 }, async (t) => {
  withGpuEnv(t);
  const flagsSeen = [];
  const loadDawn = async (flags) => {
    flagsSeen.push(flags);
    return createFakeGpu({ tagOf, msPerBlockSlot: 0.00001 }).gpu;
  };
  const lines = [];
  const o = parseWebGpuBenchArgs(
    ["--info", "--startup", "--correct", "300", "--noble", "0", "--sweep", "--robust", "--lane", "1", "--watchdog", "--lose",
      "--memory", "32", "--hpw", "2", "--seconds", "0.3", "--runs", "2", "--sweep-memory", "16,32", "--sweep-hpw", "1,2", "--difficulty", "4", "--threads", "1"],
    { MURKLE_WEBGPU: "gpu" },
  );
  const results = await runWebGpuBench(o, { loadDawn, createPool: standInPool, log: () => {}, emit: (a) => lines.push(a) });
  assert.deepEqual(lines, ["info", "startup", "correct", "sweep", "robust", "lane", "watchdog", "lose"]);
  assert.equal(results.info.info.version, "webgpu-proto-1");
  assert.equal(results.startup.ok, true);
  assert.equal(results.correct.mismatches, 0);
  assert.equal(results.correct.random, 300);
  assert.equal(results.sweep.rows.length, 4);
  assert.ok(results.sweep.rows.every((r) => r.hs > 0), JSON.stringify(results.sweep.rows));
  assert.equal(results.sweep.repeats.length, 2);
  assert.ok(results.robust.normalHs > 0 && results.robust.noRobustnessHs > 0);
  assert.ok(flagsSeen.some((f) => f.includes("enable-dawn-features=disable_robustness")), "the robustness run asks Dawn for the toggle");
  assert.equal(results.lane.gpuWrong, 0);
  assert.equal(results.lane.disabled, null);
  assert.ok(results.lane.hashes > 0 && results.lane.verified >= 1);
  assert.equal(results.watchdog.auto.dispatchMsMax !== null, true);
  assert.equal(results.lose.code, "GPU_EXITED");
  assert.equal(results.lose.restartOk, true);
  assert.equal(results.lose.ok, true);
});

test("a lying GPU shows up as correctness mismatches", { timeout: 60_000 }, async (t) => {
  withGpuEnv(t);
  const loadDawn = async () => createFakeGpu({ tagOf: (pw) => (pw[0] % 4 === 0 ? sha256(sha256(pw)) : tagOf(pw)) }).gpu;
  const o = parseWebGpuBenchArgs(["--correct", "200", "--noble", "0", "--memory", "16", "--segments", "2", "--threads", "1"], { MURKLE_WEBGPU: "gpu" });
  const results = await runWebGpuBench(o, { loadDawn, createPool: standInPool, log: () => {} });
  assert.ok(results.correct.mismatches > 10 && results.correct.ok === false);
  assert.ok(results.correct.notes.length >= 1 && results.correct.notes.length <= 5);
});

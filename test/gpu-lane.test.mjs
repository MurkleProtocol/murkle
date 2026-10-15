// The GPU lane and the safety gate (docs/design/mining.md section 12.2) without a GPU:
// - GpuLane.grind hands out a nonce only after the Argon2 pool agrees; every lying mode of the
//   stand-in (a hash that misses the target, a wrong hash, a wrong probe tag) disables the lane
//   with GPU_WRONG; a crash or a stall restarts it, at most maxRestarts times;
// - runMiner with GPU lanes against the fake chain of test/mine-cli.test.mjs: a lying GPU never
//   leads to a signature, a payment or a relay submit, and a CPU lane carries on;
// - `mine --gpu` flags, the start-up order (binary, devices, pool, self-test) and its refusals.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hex } from "../src/bytes.mjs";
import * as gpu from "../src/gpu.mjs";
import { GpuError, GpuLane, openGpu } from "../src/gpu.mjs";
import { nonceOf, passwordOf } from "../src/mine.mjs";
import { alive, fakeSpawn, until } from "./fixtures/fake-gpu-spawn.mjs";
import { fakeChain, makeRun, stubLib } from "./fixtures/fake-chain.mjs";

const DIR = mkdtempSync(join(tmpdir(), "murkle-gpu-lane-"));
process.env.MURKLE_DATA_DIR = DIR;
process.env.MURKLE_ESPLORA = "http://127.0.0.1:9/api";
delete process.env.MURKLE_RELAY_URL;
const CLI = await import("../bin/murkle.mjs");
const { MINE_USAGE, openGpuLanes, parseMineArgs, planGpus, runMiner } = CLI;
const run = makeRun(runMiner);

after(async () => {
  await Promise.all(devices.map((d) => d.close().catch(() => {})));
  rmSync(DIR, { recursive: true, force: true });
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const devices = [];
const BIN = "murkle-gpu-fake";
// The stand-in hashes like the CLI tests' contract stub does: sha256("pow" || password).
const POW = ["--hash", "pow-prefix"];
const lib = stubLib();
const verifyMany = async (pws) => pws.map((p) => lib.powHashReference(p));
const open = async (extra = [], spawnOpts = {}) => {
  const dev = await openGpu({ bin: BIN, device: 0, spawn: fakeSpawn([...POW, ...extra], spawnOpts) });
  devices.push(dev);
  return dev;
};
const lane = async (extra = [], over = {}) => new GpuLane({ device: await open(extra), verifyMany, ...over });
const CH = new Uint8Array(32).fill(9);
const ALL = (1n << 256n) - 1n;
const grindArgs = (over = {}) => ({ challenge: CH, target: ALL, nonceStart: 1000n, count: 64, timeoutMs: 5000, ...over });
const sentence = (what) =>
  `GPU 0 (Fake GPU 0) disabled: it reported a nonce whose Argon2 hash ${what}; nothing was paid for it. Check overclocking, temperature and drivers.`;

/* ------------------------------------------------------------------ GpuLane */

test("an honest lane returns the first candidate with the pool's hash, or no nonce for an empty range", async () => {
  const l = await lane();
  assert.equal(l.label, "GPU 0");
  const hit = await l.grind(grindArgs());
  assert.deepEqual([...hit.nonce], [...nonceOf(1000n)]);
  assert.equal(hex(hit.powHash), hex(lib.powHashReference(passwordOf(CH, nonceOf(1000n)))));
  assert.equal(hit.tried, 64);
  const miss = await l.grind(grindArgs({ target: 0n, nonceStart: 5000n }));
  assert.deepEqual(miss, { nonce: null, powHash: null, tried: 64 });
  assert.equal(l.disabled, null);
  // nonceStart may be given as 8 bytes, the target as hex
  const bytes = await l.grind(grindArgs({ nonceStart: nonceOf(7n), target: "f".repeat(64) }));
  assert.deepEqual([...bytes.nonce], [...nonceOf(7n)]);
});

test("a hash above the target disables the lane with the exact sentence; so does a wrong hash; nothing is returned", async () => {
  const above = await lane(["--mode", "wrong-candidate"]);
  await assert.rejects(above.grind(grindArgs({ target: 0n })), (e) => e instanceof GpuError && e.code === "GPU_WRONG" && e.message === sentence("does not meet the target"));
  assert.equal(above.disabled, sentence("does not meet the target"));
  await assert.rejects(above.grind(grindArgs()), (e) => e.code === "GPU_WRONG", "a disabled lane stays disabled");

  const wrong = await lane(["--mode", "wrong-hash"]);
  await assert.rejects(wrong.grind(grindArgs()), (e) => e.code === "GPU_WRONG" && e.message === sentence("differs from the reference"));
  assert.equal(wrong.disabled, sentence("differs from the reference"));
});

test("a wrong probe tag is caught by the next grind, in the background of the round before", async () => {
  const l = await lane(["--mode", "wrong-probe"]);
  const first = await l.grind(grindArgs({ target: 0n }));
  assert.equal(first.nonce, null, "the round itself finds nothing to refuse");
  assert.equal(l.disabled, null);
  await assert.rejects(l.grind(grindArgs({ target: 0n })), (e) => e.code === "GPU_WRONG" && e.message === sentence("differs from the reference"));
  assert.equal(l.disabled, sentence("differs from the reference"));

  // an honest probe never trips it, round after round
  const ok = await lane();
  for (let i = 0; i < 4; i++) await ok.grind(grindArgs({ target: 0n }));
  assert.equal(ok.disabled, null);
});

test("a pool failure while checking a candidate is not blamed on the GPU", async () => {
  const dev = await open();
  const down = Object.assign(new Error("Argon2 worker did not answer in time"), { code: "POW_TIMEOUT" });
  const l = new GpuLane({ device: dev, verifyMany: async () => { throw down; } });
  await assert.rejects(l.grind(grindArgs()), (e) => e === down);
  assert.equal(l.disabled, null);
});

test("a crash or a stall restarts the lane (a new device) at most maxRestarts times, then it is disabled", async () => {
  // crash after one request: grind 1 is fine, grind 2 hits GPU_EXITED, the lane reopens, grind 3 works
  let reopened = 0;
  const reopen = async () => {
    reopened += 1;
    return open();
  };
  const l = await lane(["--mode", "crash-after=1"], { reopen });
  await l.grind(grindArgs());
  const oldDevice = l.device;
  await assert.rejects(l.grind(grindArgs()), (e) => e.code === "GPU_EXITED");
  assert.equal(reopened, 1);
  assert.notEqual(l.device, oldDevice);
  assert.equal(l.disabled, null);
  assert.equal((await l.grind(grindArgs())).tried, 64);

  // a stall: GPU_TIMEOUT, the child is killed, the lane restarts
  const stalled = await lane(["--mode", "silent"], { reopen });
  const stuck = stalled.device;
  await assert.rejects(stalled.grind(grindArgs({ timeoutMs: 200 })), (e) => e.code === "GPU_TIMEOUT");
  assert.notEqual(stalled.device, stuck);
  assert.equal(stalled.disabled, null);

  // reopen keeps failing: three tries, then the lane is out for the run
  let tries = 0;
  const hopeless = await lane(["--mode", "crash-after=0"], { reopen: async () => { tries += 1; throw new GpuError("self-test failed", "GPU_SELF_TEST"); } });
  await assert.rejects(hopeless.grind(grindArgs()), (e) => e.code === "GPU_EXITED");
  assert.equal(tries, 3);
  assert.match(hopeless.disabled, /^GPU 0 \(Fake GPU 0\) disabled: self-test failed; it was restarted 3 times and failed again$/);

  // without a way to reopen the lane is disabled at once, and the code is not "no solution"
  const alone = await lane(["--mode", "crash-after=0"]);
  await assert.rejects(alone.grind(grindArgs()), (e) => e.code === "GPU_EXITED");
  assert.match(alone.disabled, /^GPU 0 \(Fake GPU 0\) disabled: the GPU process exited/);
});

test("any device error but a wrong answer restarts the lane or disables it: a dead lane never keeps rejecting", async () => {
  for (const code of ["GPU_START", "GPU_NO_DEVICE", "GPU_CLOSED"]) {
    const dead = () => ({ info: { device: 0, name: "Stub" }, search: async () => { throw new GpuError("device gone", code); }, close: async () => {} });
    const alone = new GpuLane({ device: dead(), verifyMany });
    await assert.rejects(alone.grind(grindArgs()), (e) => e.code === code);
    assert.match(alone.disabled, /^GPU 0 \(Stub\) disabled: device gone$/, code);
    await assert.rejects(alone.grind(grindArgs()), (e) => e.code === code, "the next call is refused with the stored verdict");
    let tries = 0;
    const again = new GpuLane({ device: dead(), verifyMany, reopen: async () => { tries += 1; return dead(); } });
    await assert.rejects(again.grind(grindArgs()), (e) => e.code === code);
    assert.equal(tries, 1);
    assert.equal(again.disabled, null, "restarted, alive again");
  }
});

test("the miner binary note and the tuning variables", async () => {
  const file = join(DIR, "murkle-gpu-unpinned");
  writeFileSync(file, "not a real binary");
  const lines = [];
  await planGpus("all", { lib: fakeLib({ gpuBinaryPath: () => file }), spawn: fakeSpawn(), print: (t) => lines.push(t) });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^GPU miner binary is not a pinned release build \(sha256 [0-9a-f]{64}\)\. Run only a binary you built yourself or fetched with npm run gpu:fetch: it runs with your account's rights and can read your wallet files\.$/);
  // a path that is not a file prints nothing here (the spawn reports it)
  const none = [];
  await planGpus("all", { lib: fakeLib({ gpuBinaryPath: () => BIN }), spawn: fakeSpawn(), print: (t) => none.push(t) });
  assert.deepEqual(none, []);

  const seen = [];
  const spy = fakeLib({ openGpu: async (o) => { seen.push(o.args); throw new GpuError("stop here", "GPU_START"); } });
  const plan = { bin: BIN, devices: [{ index: 0 }] };
  await assert.rejects(openGpuLanes({ plan, pool: { hashMany: verifyMany }, lib: spy, env: { MURKLE_GPU_SLOTS: "1400", MURKLE_GPU_HASHES_PER_BLOCK: "8" } }), /GPU 0 failed its self-test/);
  await assert.rejects(openGpuLanes({ plan, pool: { hashMany: verifyMany }, lib: spy, env: {} }), /GPU 0 failed/);
  assert.deepEqual(seen, [["--slots", "1400", "--hashes-per-block", "8"], []]);
  for (const env of [{ MURKLE_GPU_SLOTS: "0" }, { MURKLE_GPU_SLOTS: "x" }, { MURKLE_GPU_HASHES_PER_BLOCK: "3" }]) {
    await assert.rejects(openGpuLanes({ plan, pool: { hashMany: verifyMany }, lib: spy, env }), /must be .*nothing was mined/);
  }
});

/* ------------------------------------------------------------------ runMiner with GPU lanes */

// Difficulty 1 makes every hash a hit (an honest GPU finds at once); a huge one makes every hash a miss.
const easy = () => stubLib({ effectiveDifficulty: () => 1n });
const hard = () => stubLib({ effectiveDifficulty: () => 1_000_000_000_000_000n });

test("one honest GPU lane mines and its solution is claimed", async () => {
  const fx = fakeChain({ lib: easy() });
  const l = await lane();
  const r = await run(fx, { maxClaims: 1, threads: 0, gpus: [l], slice: 64, statsMs: 0 });
  assert.equal(r.status, "done", r.out.join("\n"));
  assert.equal(r.sent, 1);
  assert.equal(r.solutions, 1);
  assert.equal(fx.esplora.broadcasts.length, 1);
  assert.ok(r.out.some((s) => /^block 1000: reward 50 DIG, difficulty 1, GPU 0$/.test(s)), r.out.join("\n"));
  assert.ok(r.out.some((s) => /^[\d,]+ H\/s {2}\[gpu0 [\d,]+\] {2}solutions /.test(s)), r.out.join("\n"));
  assert.equal(fx.pool.calls.length, 0, "no CPU lane ran");
});

test("lanes are listed as 'GPU 0, GPU 1 and 2 CPU threads' and the status line splits H/s per lane", async () => {
  const fx = fakeChain({ lib: easy(), findOn: 99 });
  const l0 = await lane();
  const l1 = await lane([], { label: "GPU 1" });
  l1.index = 1;
  const r = await run(fx, { maxClaims: 1, threads: 2, gpus: [l0, l1], slice: 64, statsMs: 0 });
  assert.equal(r.status, "done", r.out.join("\n"));
  assert.ok(r.out.some((s) => /^block 1000: reward 50 DIG, difficulty 1, GPU 0, GPU 1 and 2 CPU threads$/.test(s)), r.out.join("\n"));
  assert.ok(r.out.some((s) => /^[\d,]+ H\/s {2}\[gpu0 [\d,]+ \| gpu1 [\d,]+ \| cpu [\d,]+\] {2}solutions /.test(s)), r.out.join("\n"));
});

test("without GPU lanes the block and status lines are what they always were", async () => {
  const fx = fakeChain({ findOn: 2 });
  fx.pool.size = 1;
  const r = await run(fx, { maxClaims: 1, threads: 1, statsMs: 0 });
  assert.ok(r.out.some((s) => s === "block 1000: reward 50 DIG, difficulty 1000, 1 thread"), r.out.join("\n"));
  assert.ok(r.out.some((s) => /^[\d,]+ H\/s {2}solutions 0 {2}claims sent 0/.test(s)), r.out.join("\n"));
  assert.ok(!r.out.filter((s) => /^block |H\/s/.test(s)).some((s) => /gpu|GPU/.test(s)));
});

for (const [mode, lib2, what] of [
  ["wrong-hash", easy(), "differs from the reference"],
  ["wrong-candidate", hard(), "does not meet the target"],
]) {
  test(`a lying GPU (${mode}) alone: nothing is signed, paid or submitted; the disable sentence is printed and mining stops`, async () => {
    const fx = fakeChain({ lib: lib2 });
    let signed = 0;
    let submitted = 0;
    const relay = { client: { submit: async () => { submitted += 1; return { status: 500 }; } }, url: "http://relay.test" };
    const l = await lane(["--mode", mode]);
    const r = await run(fx, { maxClaims: 1, threads: 0, gpus: [l], relay, sign: () => { signed += 1; throw new Error("must not sign"); }, statsMs: 0 });
    assert.equal(r.status, "error", r.out.join("\n"));
    assert.equal(r.reason, "every GPU and CPU lane is disabled; nothing more was mined");
    assert.ok(r.out.includes(sentence(what)), r.out.join("\n"));
    assert.ok(r.out.includes("stopped: every GPU and CPU lane is disabled; nothing more was mined"));
    assert.deepEqual([signed, submitted, r.sent, r.solutions], [0, 0, 0, 0]);
    assert.equal(fx.esplora.broadcasts.length, 0);
    assert.equal(fx.wallet.finals.length, 0, "no claim was proved");
    assert.equal(fx.file.pending.length, 0, "no W-M entry");
  });
}

test("a lying GPU next to a CPU lane: the GPU is disabled, the CPU solution is claimed", async () => {
  const fx = fakeChain({ lib: easy(), findOn: 2 });
  fx.pool.size = 1;
  const l = await lane(["--mode", "wrong-hash"]);
  const r = await run(fx, { maxClaims: 1, threads: 1, gpus: [l], slice: 64 });
  assert.equal(r.status, "done", r.out.join("\n"));
  assert.equal(r.sent, 1);
  assert.equal(fx.esplora.broadcasts.length, 1);
  assert.equal(r.out.filter((s) => s === sentence("differs from the reference")).length, 1, "printed once");
  assert.equal(fx.pool.calls.length, 2, "the CPU lane carried on");
  assert.ok(r.out.some((s) => /difficulty 1, GPU 0 and 1 CPU thread$/.test(s)));
});

test("a GPU lane that crashes is restarted and mining goes on; its error is a warning, not a verdict", async () => {
  const fx = fakeChain({ lib: hard(), findOn: 3 });
  fx.pool.size = 1;
  const reopen = () => open();
  const l = await lane(["--mode", "crash-after=1"], { reopen });
  const r = await run(fx, { maxClaims: 1, threads: 1, gpus: [l], slice: 16 });
  assert.equal(r.status, "done", r.out.join("\n"));
  assert.ok(r.out.some((s) => /^warn: GPU 0: the GPU process exited .*\(GPU_EXITED\); trying again$/.test(s)), r.out.join("\n"));
  assert.equal(l.disabled, null);
});

test("a solution on one lane cancels the GPU slices of the others", async () => {
  // the CPU lane answers after 150 ms: by then the GPU slice (100,000 nonces, 40 ms per 16) is under way
  const fx = fakeChain({ lib: hard(), findOn: 1, onGrind: () => new Promise((r) => setTimeout(r, 150)) });
  fx.pool.size = 1;
  const sent = [];
  const l = new GpuLane({ device: await openGpu({ bin: BIN, device: 0, spawn: fakeSpawn([...POW, "--mode", "slow"], { sent }) }), verifyMany });
  devices.push(l.device);
  const t0 = Date.now();
  const r = await run(fx, { maxClaims: 1, threads: 1, gpus: [l], slice: 100_000 });
  assert.equal(r.status, "done", r.out.join("\n"));
  assert.ok(Date.now() - t0 < 10_000, "the 100,000-nonce GPU slice was cancelled");
  assert.ok(sent.some((s) => /^cancel \d+$/.test(s)), sent.join("\n"));
});

test("Ctrl+C (the run's signal) cancels a GPU slice and the miner stops", async () => {
  const fx = fakeChain({ lib: hard() });
  const l = await lane(["--mode", "slow"]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const t0 = Date.now();
  const r = await run(fx, { threads: 0, gpus: [l], slice: 1_000_000, signal: ac.signal });
  assert.equal(r.status, "stopped");
  assert.ok(Date.now() - t0 < 5000);
});

/* ------------------------------------------------------------------ mine --gpu: flags and start-up */

test("--gpu flag: all, a list, refusals, and gpu: null without it", () => {
  const none = () => undefined;
  const p = (...a) => parseMineArgs(["erin", "DIG", ...a], { read: none, processors: 8 });
  assert.equal(p().gpu, null);
  assert.equal(p("--gpu", "all").gpu, "all");
  assert.deepEqual(p("--gpu", "0,2").gpu, [0, 2]);
  assert.deepEqual(p("--gpu=7").gpu, [7]);
  assert.deepEqual(p("--gpu", "999").gpu, [999]);
  assert.deepEqual(p("--gpu", "3", "--threads", "2").threads, 2);
  assert.throws(() => p("--gpu", "0,0"), /--gpu names device 0 twice/);
  assert.throws(() => p("--gpu", "x"), /--gpu takes all, or device numbers 0 to 999/);
  assert.throws(() => p("--gpu", "1000"), /--gpu takes all/);
  assert.throws(() => p("--gpu", "01"), /--gpu takes all/);
  assert.throws(() => p("--gpu", "-1"), /needs a value|--gpu takes all/);
  assert.throws(() => p("--gpu", "0,"), /--gpu takes all/);
  assert.throws(() => p("--gpu"), /--gpu needs a value/);
  assert.throws(() => p("--gpu", "all", "--gpu", "0"), /--gpu given twice/);
  assert.throws(() => p("--gpu", "all", "--prepare-coins", "4"), /--prepare-coins .* does not go with --gpu/);
  // everything else is as before
  const base = parseMineArgs(["erin", "dig"], { read: none });
  assert.deepEqual(base, {
    name: "erin", ticker: "DIG", pay: "key", threads: null, gpu: null, maxClaims: null, maxFeeRate: null, prepareCoins: null, esplora: null, relay: null, linkable: false, acceptCapRisk: false,
  });
  assert.ok(MINE_USAGE.includes("<TICKER> [--gpu all|0,1,...] [--threads N]"));
});

const fakeLib = (over = {}) => ({ ...gpu, ...over });

test("start-up: the binary is found first, then the devices; 'all' and lists resolve; an unlisted number is refused", async () => {
  const spawn = fakeSpawn();
  const binLib = fakeLib({ gpuBinaryPath: () => BIN });
  const all = await planGpus("all", { lib: binLib, spawn });
  assert.deepEqual(all.devices.map((d) => d.index), [0, 1]);
  assert.equal(all.bin, BIN);
  assert.deepEqual((await planGpus([1], { lib: binLib, spawn })).devices, [{ index: 1, name: "Fake GPU 1", cc: "8.9", vramMiB: 24564 }]);
  await assert.rejects(planGpus([0, 5], { lib: binLib, spawn }), /no CUDA device 5: murkle-gpu-fake lists 0, 1; nothing was mined/);

  // no binary: the exact refusal, before any device is looked at
  let listed = false;
  await assert.rejects(
    planGpus("all", { lib: fakeLib({ listGpus: async () => { listed = true; return []; } }), env: { MURKLE_GPU_BIN: join(DIR, "absent") } }),
    (e) => e.code === "GPU_NO_BINARY" && e.message === `MURKLE_GPU_BIN is set to "${join(DIR, "absent")}", but there is no file there; nothing was mined`,
  );
  assert.equal(listed, false);
  // no device
  await assert.rejects(planGpus("all", { lib: binLib, spawn: fakeSpawn(["--mode", "no-device"]) }), (e) => e.code === "GPU_NO_DEVICE" && /^no CUDA device found \(driver 525 or newer is needed\); nothing was mined$/.test(e.message));
});

test("start-up self-test: each device is opened and tested against the pool; the line is printed; a bad device refuses the run", async () => {
  const pool = { hashMany: verifyMany };
  const printed = [];
  const plan = { bin: BIN, devices: [{ index: 0 }] };
  // the stand-in is told to hash like the stub, and its vectors are the real Argon2 ones: so use its argon2 mode for the shipped vectors
  const good = await openGpuLanes({ plan, pool: { hashMany: (p) => verifyReal(p) }, spawn: fakeSpawn(["--hash", "argon2", "--slots", "6"]), print: (s) => printed.push(s) });
  assert.equal(good.length, 1);
  assert.deepEqual(printed, ["GPU 0 self-test passed: Fake GPU 0 (8.9, 1024 MiB, 6 slots)"]);
  await Promise.all(good.map((g) => g.close()));

  const children = [];
  await assert.rejects(
    openGpuLanes({ plan, pool, spawn: fakeSpawn(["--mode", "wrong-vector", "--hash", "argon2", "--slots", "6"], { children }), print: (s) => printed.push(s) }),
    (e) => /^GPU 0 failed its self-test \(vector illustrative: .*\); remove it from --gpu\. Nothing was mined\.$/.test(e.message),
  );
  await until(() => children.every((c) => !alive(c.pid)));
  assert.equal(printed.length, 1, "no 'passed' line for the bad device");

  // a stand-in that cannot start is refused the same way
  await assert.rejects(openGpuLanes({ plan, pool, spawn: fakeSpawn(["--mode", "early-exit"]) }), /^Error: GPU 0 failed its self-test \(the GPU process exited \(3\)/);
});

async function verifyReal(pws) {
  const { powHash } = await import("../src/mine.mjs");
  return Promise.all(pws.map((p) => powHash(p)));
}

test("a failing second device closes the first: no child is left behind", async () => {
  const children = [];
  const plan = { bin: BIN, devices: [{ index: 0 }, { index: 1 }] };
  let started = 0;
  const spawn = (bin, args, opts) => fakeSpawn(started++ === 0 ? ["--hash", "argon2", "--slots", "6"] : ["--mode", "early-exit"], { children })(bin, args, opts);
  await assert.rejects(openGpuLanes({ plan, pool: { hashMany: verifyReal }, spawn, print: () => {} }), /GPU 1 failed its self-test/);
  await until(() => children.length === 2 && children.every((c) => !alive(c.pid)));
});

// The real murkle-gpu binary on a real CUDA device (docs/design/mining.md section 12.2). Skipped
// unless a binary is found (gpu/bin/, MURKLE_GPU_BIN) and `--list` reports a device. Checks, against
// the reference Argon2 (noble, hash-wasm): the 32 vectors, the boundary of the target comparison,
// random passwords, the start-up self-test, and a throughput sample that is printed, not asserted.
//
// Knobs (environment): MURKLE_GPU_TEST_DEVICE (default 0), MURKLE_GPU_TEST_SLOTS (default: the binary's own choice),
// MURKLE_GPU_TEST_RANDOM (random passwords, default 2000), MURKLE_GPU_TEST_BENCH=0 (skip the 10 s sample).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { hex, unhex } from "../src/bytes.mjs";
import { gpuBinaryPath, gpuSelfTest, listGpus, openGpu } from "../src/gpu.mjs";
import { counterOf, nonceOf } from "../src/mine.mjs";
import { createNodePowPool } from "../src/pow-pool.mjs";

const FILE = JSON.parse(readFileSync(new URL("./fixtures/gpu-vectors.json", import.meta.url), "utf8"));
const DEVICE = Number(process.env.MURKLE_GPU_TEST_DEVICE ?? 0);
const RANDOM = Number(process.env.MURKLE_GPU_TEST_RANDOM ?? 2000);

let bin = null;
let listed = null;
try {
  bin = gpuBinaryPath();
  listed = await listGpus({ bin });
} catch {
  // no binary or no device: the tests below are skipped
}
const skip = !bin ? "no murkle-gpu binary (npm run gpu:fetch or npm run gpu:build)" : !listed?.some((d) => d.index === DEVICE) ? "no CUDA device" : false;

let device = null;
let pool = null;
if (!skip) {
  const args = process.env.MURKLE_GPU_TEST_SLOTS ? ["--slots", process.env.MURKLE_GPU_TEST_SLOTS] : [];
  device = await openGpu({ bin, device: DEVICE, args });
  pool = await createNodePowPool({ size: 2 });
  await pool.ready();
}
after(async () => {
  await device?.close();
  await pool?.close();
});

test("the device announces itself", { skip }, (t) => {
  const i = device.info;
  t.diagnostic(`${i.name} (${i.cc}), ${i.sms} SMs, ${i.vramMiB} MiB, ${i.slots} slots, ${i.hashesPerBlock} hashes per block, murkle-gpu ${i.version}`);
  assert.ok(i.slots >= 1 && i.sms >= 1);
});

test("all 32 vectors of gpu-vectors.json hash to their tags", { skip }, async () => {
  const tags = await device.hash(FILE.vectors.map((v) => unhex(v.password)));
  FILE.vectors.forEach((v, i) => assert.equal(hex(tags[i]), v.tag, v.name));
});

test("the target comparison: equal is a hit, one less is not; the first batch with a hit ends the search", { skip }, async () => {
  for (const v of FILE.vectors.slice(0, 8)) {
    const pw = unhex(v.password);
    const args = { challenge: pw.slice(0, 32), nonceStart: counterOf(pw.slice(32)), count: 1, probe: 0 };
    const tag = BigInt(`0x${v.tag}`);
    const hit = await device.search({ ...args, target: tag });
    assert.equal(hit.candidates.length, 1, v.name);
    assert.equal(hex(hit.candidates[0].hash), v.tag);
    assert.equal(hex(hit.probe.hash), v.tag);
    if (tag > 0n) assert.equal((await device.search({ ...args, target: tag - 1n })).candidates.length, 0, v.name);
  }
  const start = 1n << 63n;
  const r = await device.search({ challenge: new Uint8Array(32).fill(3), target: (1n << 256n) - 1n, nonceStart: start, count: device.info.slots + 7, probe: 0 });
  assert.equal(r.done, BigInt(device.info.slots));
  assert.equal(r.candidates.length, Math.min(64, device.info.slots));
  r.candidates.forEach((c, i) => assert.deepEqual([...c.nonce], [...nonceOf(start + BigInt(i))]));
});

test(`${RANDOM} random passwords agree with hash-wasm`, { skip }, async () => {
  const pws = Array.from({ length: RANDOM }, () => Uint8Array.from(randomBytes(40)));
  const [gpu, ref] = [await device.hash(pws), await pool.hashMany(pws)];
  let bad = 0;
  gpu.forEach((g, i) => {
    if (hex(g) !== hex(ref[i])) bad += 1;
  });
  assert.equal(bad, 0, `${bad} of ${RANDOM} differ`);
});

test("the start-up self-test passes", { skip }, async () => {
  const r = await gpuSelfTest(device, { verifyMany: (p) => pool.hashMany(p) });
  assert.equal(r.slots, device.info.slots);
});

test("throughput over 10 s (printed, not asserted)", { skip: skip || process.env.MURKLE_GPU_TEST_BENCH === "0" }, async (t) => {
  const per = device.info.slots * 4;
  const t0 = Date.now();
  let hashes = 0n;
  let start = 0n;
  while (Date.now() - t0 < 10_000) {
    const r = await device.search({ challenge: new Uint8Array(32), target: 0n, nonceStart: start, count: per, probe: 0 });
    hashes += r.done;
    start += r.done;
  }
  const hs = Math.round((Number(hashes) * 1000) / (Date.now() - t0));
  t.diagnostic(`${hs.toLocaleString("en-US")} H/s on ${device.info.name}`);
  assert.ok(hashes > 0n);
});

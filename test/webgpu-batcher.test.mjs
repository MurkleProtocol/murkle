// The batching logic of the WebGPU engine (src/webgpu/batcher.mjs) with a fake runBatch whose tag is
// sha256(password): hits, padding, pipelining, candidates, probe, cancel, errors, and the unmodified
// gpuSelfTest / GpuLane gate running on top of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha256";
import { equal, hex, unhex } from "../src/bytes.mjs";
import { GPU_SELF_TEST_VECTORS, GpuError, GpuLane, gpuSelfTest } from "../src/gpu-gate.mjs";
import { SELF_TEST_VECTORS, nonceOf, passwordOf } from "../src/mine.mjs";
import { createSearch } from "../src/webgpu/batcher.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FORTY = SELF_TEST_VECTORS.filter((v) => !v.salt && v.password.length === 80);
const ALL_VECTORS = [...FORTY, ...GPU_SELF_TEST_VECTORS];
const TRUE_TAGS = new Map(ALL_VECTORS.map((v) => [v.password, unhex(v.powHash)]));

/** The fake GPU: tag = sha256(password), except that the known vectors answer with their true Argon2 tags. */
const tagOf = (pw) => TRUE_TAGS.get(hex(pw)) ?? sha256(pw);

function fake({ slots = 8, pipelineDepth = 2, delay = 0, tag = (pw) => sha256(pw), failAt = null, record = [] } = {}) {
  const state = { calls: 0, settled: 0, inFlight: 0, maxInFlight: 0 };
  const runBatch = async (pw) => {
    const call = state.calls++;
    state.inFlight++;
    state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
    record.push(pw);
    try {
      if (delay) await sleep(delay);
      if (failAt !== null && call === failAt.call) throw failAt.error;
      const out = new Uint8Array(slots * 32);
      for (let i = 0; i < slots; i++) out.set(tag(pw.subarray(i * 40, i * 40 + 40)), i * 32);
      return out;
    } finally {
      state.inFlight--;
      state.settled++;
    }
  };
  return { ...createSearch({ runBatch, slots, pipelineDepth }), state };
}

const CH = new Uint8Array(32).map((_, i) => 7 * i + 1);
const tagsFor = (challenge, start, n) => Array.from({ length: n }, (_, i) => sha256(passwordOf(challenge, nonceOf(BigInt(start) + BigInt(i)))));
const big = (t) => BigInt(`0x${hex(t)}`);

test("a hit in the middle of the third batch gives done = 3 * slots and the right candidates, in nonce order", async () => {
  const slots = 8;
  let challenge;
  let target;
  let want;
  // find a challenge for which nonce 2 * slots + 3 is the first nonce at or below its own tag
  for (let seed = 0; seed < 500; seed++) {
    challenge = sha256(Uint8Array.of(seed, seed >> 8));
    const tags = tagsFor(challenge, 1000, 5 * slots);
    const idx = 2 * slots + 3;
    if (tags.slice(0, idx).every((t) => big(t) > big(tags[idx]))) {
      target = big(tags[idx]);
      want = tags.map((t, i) => [i, t]).filter(([i, t]) => i < 3 * slots && big(t) <= target);
      break;
    }
  }
  assert.ok(target !== undefined, "a test case was found");
  for (const depth of [1, 2, 3]) {
    const dev = fake({ slots, pipelineDepth: depth });
    const r = await dev.search({ challenge, target, nonceStart: 1000n, count: 5 * slots });
    assert.equal(r.done, BigInt(3 * slots), `depth ${depth}`);
    assert.equal(r.cancelled, false);
    assert.deepEqual(r.candidates.map((c) => hex(c.nonce)), want.map(([i]) => hex(nonceOf(1000n + BigInt(i)))));
    assert.deepEqual(r.candidates.map((c) => hex(c.hash)), want.map(([, t]) => hex(t)));
    assert.equal(r.more, 0);
    assert.ok(r.candidates.length >= 1 && r.candidates.every((c) => big(c.hash) <= target));
  }
});

test("equal to the target counts as a hit, one less does not", async () => {
  const slots = 4;
  const tags = tagsFor(CH, 50, slots);
  const dev = fake({ slots });
  const t = big(tags[2]);
  const hit = await dev.search({ challenge: CH, target: t, nonceStart: 50n, count: slots });
  assert.ok(hit.candidates.some((c) => equal(c.hash, tags[2])));
  const miss = await dev.search({ challenge: CH, target: t - 1n, nonceStart: 50n, count: slots });
  assert.ok(!miss.candidates.some((c) => equal(c.hash, tags[2])));
  // the target as a hex string, and 0: no hit
  const none = await dev.search({ challenge: hex(CH), target: "00".repeat(32), nonceStart: nonceOf(50n), count: slots });
  assert.equal(none.candidates.length, 0);
  assert.equal(none.done, BigInt(slots));
});

test("the comparison is big-endian over the whole 256 bits (first word decides, then the next ones)", async () => {
  const tag = new Uint8Array(32).fill(0);
  const dev = fake({ slots: 1, tag: () => tag });
  const run = async (target) => (await dev.search({ challenge: CH, target, nonceStart: 0n, count: 1 })).candidates.length;
  tag[31] = 5; // the tag is 5
  assert.equal(await run(5n), 1);
  assert.equal(await run(4n), 0);
  assert.equal(await run(6n), 1);
  tag[0] = 1; // the tag is 2^248 + 5
  assert.equal(await run((1n << 248n) + 5n), 1);
  assert.equal(await run((1n << 248n) + 4n), 0);
  assert.equal(await run((1n << 248n) - 1n), 0);
  tag.fill(0);
  tag[4] = 0x80; // the top byte of the second word: 2^223
  assert.equal(await run((1n << 223n) - 1n), 0);
  assert.equal(await run(1n << 223n), 1);
  assert.equal(await run((1n << 256n) - 1n), 1);
});

test("more than 64 hits give 64 candidates in nonce order plus `more`", async () => {
  const slots = 100;
  const dev = fake({ slots });
  const r = await dev.search({ challenge: CH, target: (1n << 256n) - 1n, nonceStart: 9n, count: 250 });
  assert.equal(r.done, 100n);
  assert.equal(r.candidates.length, 64);
  assert.equal(r.more, 36);
  r.candidates.forEach((c, i) => assert.equal(hex(c.nonce), hex(nonceOf(9n + BigInt(i)))));
});

test("the probe tag is returned only when the probe nonce was hashed", async () => {
  const slots = 8;
  const dev = fake({ slots });
  const tags = tagsFor(CH, 0, 5 * slots);
  // no hit possible: the probe in the last batch is hashed
  const all = await dev.search({ challenge: CH, target: 0n, nonceStart: 0n, count: 5 * slots, probe: 5 * slots - 1 });
  assert.equal(all.done, BigInt(5 * slots));
  assert.equal(hex(all.probe.nonce), hex(nonceOf(BigInt(5 * slots - 1))));
  assert.equal(hex(all.probe.hash), hex(tags[5 * slots - 1]));
  // a hit in batch 0 stops the search: the probe in batch 3 was not hashed (counted)
  const early = await dev.search({ challenge: CH, target: (1n << 256n) - 1n, nonceStart: 0n, count: 5 * slots, probe: 3 * slots + 1 });
  assert.equal(early.done, BigInt(slots));
  assert.equal(early.probe, null);
  // ... and one in the batch of the hit is returned
  const same = await dev.search({ challenge: CH, target: (1n << 256n) - 1n, nonceStart: 0n, count: 5 * slots, probe: 5 });
  assert.equal(hex(same.probe.hash), hex(tags[5]));
});

test("count < slots hashes a padded batch and done === count; padding never becomes a candidate", async () => {
  const slots = 8;
  const record = [];
  const dev = fake({ slots, record });
  const r = await dev.search({ challenge: CH, target: (1n << 256n) - 1n, nonceStart: 3n, count: 5, probe: 4 });
  assert.equal(r.done, 5n);
  assert.equal(r.candidates.length, 5);
  assert.equal(r.more, 0);
  assert.equal(hex(r.probe.nonce), hex(nonceOf(7n)));
  assert.equal(record.length, 1);
  assert.equal(record[0].length, slots * 40, "the engine always gets a full batch");
  const last = record[0].subarray(4 * 40, 5 * 40);
  for (let i = 5; i < slots; i++) assert.deepEqual(record[0].subarray(i * 40, (i + 1) * 40), last, `padding slot ${i}`);
  assert.deepEqual(last, passwordOf(CH, nonceOf(7n)));
});

test("an abort between batches gives cancelled: true with the batches finished so far", async () => {
  const slots = 4;
  const dev = fake({ slots, delay: 15, pipelineDepth: 1 });
  const ac = new AbortController();
  const p = dev.search({ challenge: CH, target: 0n, nonceStart: 0n, count: 1000, signal: ac.signal });
  await sleep(40);
  ac.abort();
  const r = await p;
  assert.equal(r.cancelled, true);
  assert.ok(r.done >= 1n && r.done < 1000n, `done ${r.done}`);
  assert.equal(r.done % BigInt(slots), 0n);
  assert.equal(r.candidates.length, 0);
  // already aborted: nothing runs
  const before = dev.state.calls;
  const none = await dev.search({ challenge: CH, target: 0n, nonceStart: 0n, count: 10, signal: ac.signal });
  assert.deepEqual([none.done, none.cancelled, none.candidates.length, none.probe], [0n, true, 0, null]);
  assert.equal(dev.state.calls, before);
});

test("batches in flight after a hit are discarded, waited for, and not counted", async () => {
  const slots = 4;
  const dev = fake({ slots, pipelineDepth: 3, delay: 5 });
  const r = await dev.search({ challenge: CH, target: (1n << 256n) - 1n, nonceStart: 0n, count: 100 });
  assert.equal(r.done, BigInt(slots), "only the batch with the first hit is counted");
  assert.equal(dev.state.calls, 3, "three batches were launched (the pipeline depth)");
  assert.equal(dev.state.inFlight, 0, "search resolved only after every launched batch settled");
  assert.equal(dev.state.settled, 3);
  assert.equal(dev.state.maxInFlight, 3, "the batches really overlapped");
});

test("batches are pipelined: with depth 2 two run at once, with depth 1 never", async () => {
  for (const depth of [1, 2]) {
    const dev = fake({ slots: 4, pipelineDepth: depth, delay: 4 });
    await dev.search({ challenge: CH, target: 0n, nonceStart: 0n, count: 40 });
    assert.equal(dev.state.maxInFlight, depth);
    assert.equal(dev.state.calls, 10);
  }
});

test("a runBatch rejection leaves with the same error code, also when another batch fails while one is awaited", async () => {
  const unhandled = [];
  const on = (e) => unhandled.push(e);
  process.on("unhandledRejection", on);
  try {
    const dev = fake({ slots: 4, pipelineDepth: 3, delay: 3, failAt: { call: 1, error: new GpuError("device gone", "GPU_EXITED") } });
    await assert.rejects(dev.search({ challenge: CH, target: 0n, nonceStart: 0n, count: 100 }), (e) => e instanceof GpuError && e.code === "GPU_EXITED" && /device gone/.test(e.message));
    assert.equal(dev.state.inFlight, 0);
    const stall = fake({ slots: 4, failAt: { call: 0, error: new GpuError("hung", "GPU_TIMEOUT") } });
    await assert.rejects(stall.hash([new Uint8Array(40)]), (e) => e.code === "GPU_TIMEOUT");
    const plain = fake({ slots: 4, failAt: { call: 0, error: new Error("lost") } });
    await assert.rejects(plain.search({ challenge: CH, target: 0n, nonceStart: 0n, count: 4 }), (e) => e instanceof GpuError && e.code === "GPU_EXITED" && /lost/.test(e.message));
    await sleep(20);
  } finally {
    process.off("unhandledRejection", on);
  }
  assert.deepEqual(unhandled, []);
});

test("a runBatch that answers with the wrong number of bytes is a GPU_PROTOCOL error", async () => {
  const dev = createSearch({ runBatch: async () => new Uint8Array(31), slots: 1 });
  await assert.rejects(dev.hash([new Uint8Array(40)]), (e) => e.code === "GPU_PROTOCOL");
});

test("the nonce counter carries across 2^32 and wraps at 2^64", async () => {
  const record = [];
  const dev = fake({ slots: 4, record });
  await dev.search({ challenge: CH, target: 0n, nonceStart: (1n << 32n) - 2n, count: 8 });
  const seen = record.flatMap((pw) => Array.from({ length: 4 }, (_, i) => pw.subarray(i * 40, i * 40 + 40)));
  seen.forEach((pw, i) => assert.deepEqual(pw, passwordOf(CH, nonceOf((1n << 32n) - 2n + BigInt(i)))));
  record.length = 0;
  await dev.search({ challenge: CH, target: 0n, nonceStart: (1n << 64n) - 2n, count: 4 });
  const wrapped = Array.from({ length: 4 }, (_, i) => record[0].subarray(i * 40, i * 40 + 40));
  [(1n << 64n) - 2n, (1n << 64n) - 1n, 0n, 1n].forEach((n, i) => assert.deepEqual(wrapped[i], passwordOf(CH, nonceOf(n))));
  // a start given as bytes works too
  record.length = 0;
  await dev.search({ challenge: CH, target: 0n, nonceStart: nonceOf(0x1_0000_0000n), count: 1 });
  assert.deepEqual(record[0].subarray(0, 40), passwordOf(CH, nonceOf(0x1_0000_0000n)));
});

test("candidate nonces across the 2^32 boundary are right", async () => {
  const dev = fake({ slots: 4 });
  const r = await dev.search({ challenge: CH, target: (1n << 256n) - 1n, nonceStart: 0xfffffffeffffffffn, count: 4 });
  assert.deepEqual(r.candidates.map((c) => hex(c.nonce)), [0xfffffffeffffffffn, 0xffffffff00000000n, 0xffffffff00000001n, 0xffffffff00000002n].map((n) => hex(nonceOf(n))));
});

test("hash(): any count, in order, batches of `slots`, 40-byte inputs only", async () => {
  const dev = fake({ slots: 8, pipelineDepth: 2 });
  const pws = Array.from({ length: 21 }, (_, i) => sha256(Uint8Array.of(i)).subarray(0, 8).reduce((a, x, k) => (a[32 + k] = x, a), new Uint8Array(40)));
  const out = await dev.hash(pws);
  assert.equal(out.length, 21);
  out.forEach((t, i) => assert.equal(hex(t), hex(sha256(pws[i]))));
  assert.deepEqual(await dev.hash([]), []);
  assert.equal(dev.state.calls, 3);
  await assert.rejects(dev.hash([new Uint8Array(39)]), TypeError);
});

test("search validates its arguments like GpuDevice", async () => {
  const dev = fake({ slots: 4 });
  const ok = { challenge: CH, target: 1n, nonceStart: 0n, count: 4 };
  await assert.rejects(dev.search({ ...ok, challenge: new Uint8Array(31) }), TypeError);
  await assert.rejects(dev.search({ ...ok, target: -1n }), RangeError);
  await assert.rejects(dev.search({ ...ok, target: 1n << 256n }), RangeError);
  await assert.rejects(dev.search({ ...ok, nonceStart: 1n << 64n }), RangeError);
  await assert.rejects(dev.search({ ...ok, count: 0 }), RangeError);
  await assert.rejects(dev.search({ ...ok, probe: 4 }), RangeError);
  await assert.rejects(dev.search({ ...ok, count: 1.5 }), TypeError);
  assert.throws(() => createSearch({ runBatch: async () => null, slots: 0 }), RangeError);
  assert.throws(() => createSearch({ runBatch: async () => null, slots: 1, pipelineDepth: 4 }), RangeError);
});

test("a search that runs past timeoutMs fails with GPU_TIMEOUT", async () => {
  let now = 0;
  const slots = 2;
  const runBatch = async (pw) => {
    now += 100;
    return new Uint8Array(slots * 32).fill(255);
  };
  const dev = createSearch({ runBatch, slots, pipelineDepth: 1, clock: () => now });
  await assert.rejects(dev.search({ challenge: CH, target: 0n, nonceStart: 0n, count: 1000, timeoutMs: 450 }), (e) => e.code === "GPU_TIMEOUT");
});

// ---------------------------------------------------------------- the unmodified gate on top of the batcher

function gateDevice({ slots = 8, corrupt = null } = {}) {
  const tag = (pw) => {
    const t = Uint8Array.from(tagOf(pw));
    if (corrupt?.(pw)) t[17] ^= 0x04;
    return t;
  };
  const inner = fake({ slots, tag });
  return Object.assign(inner, { info: { device: 0, name: "fake WebGPU", slots }, close: async () => {} });
}
const verifyMany = async (pws) => pws.map((p) => tagOf(p));

test("gpuSelfTest passes against a correct fake (the 20 vectors, random passwords, the boundary, a full batch)", async () => {
  const r = await gpuSelfTest(gateDevice(), { verifyMany });
  assert.equal(r.vectors, 20);
  assert.equal(r.slots, 8);
  // also with a batch size that is not a divisor of the vector count and with a slot count above 64
  await gpuSelfTest(gateDevice({ slots: 5 }), { verifyMany });
  await gpuSelfTest(gateDevice({ slots: 70 }), { verifyMany });
});

test("gpuSelfTest fails with GPU_SELF_TEST when one tag bit is flipped (a vector, a random password, or a boundary hit)", async () => {
  const vec = unhex(GPU_SELF_TEST_VECTORS[3].password);
  await assert.rejects(gpuSelfTest(gateDevice({ corrupt: (pw) => equal(pw, vec) }), { verifyMany }), (e) => e.code === "GPU_SELF_TEST" && /vector nonce-2\^32/.test(e.message));
  await assert.rejects(gpuSelfTest(gateDevice({ corrupt: (pw) => !TRUE_TAGS.has(hex(pw)) && pw[39] % 3 === 0 }), { verifyMany }), (e) => e.code === "GPU_SELF_TEST");
  // every tag flipped
  await assert.rejects(gpuSelfTest(gateDevice({ corrupt: () => true }), { verifyMany }), (e) => e.code === "GPU_SELF_TEST");
});

test("GpuLane over the batcher finds nonces whose reference hash meets the target, and drops the lane on a wrong tag", async () => {
  const dev = gateDevice({ slots: 16 });
  const lane = new GpuLane({ device: dev, verifyMany, label: "fake WebGPU" });
  const target = (1n << 256n) / 40n; // about one hit in 40 hashes
  let found = 0;
  for (let round = 0; round < 12 && found < 3; round++) {
    const r = await lane.grind({ challenge: CH, target, nonceStart: BigInt(round) * 64n, count: 64 });
    if (r.nonce) {
      found++;
      assert.deepEqual(r.powHash, sha256(passwordOf(CH, r.nonce)));
      assert.ok(big(r.powHash) <= target);
    }
  }
  assert.ok(found >= 1);
  assert.equal(lane.disabled, null);
  // a GPU that lies about the tag it reports for a nonce: the pool's value differs, so GPU_WRONG
  const liar = gateDevice({ slots: 16, corrupt: () => true });
  const bad = new GpuLane({ device: liar, verifyMany, label: "liar" });
  await assert.rejects(bad.grind({ challenge: CH, target: (1n << 256n) - 1n, nonceStart: 0n, count: 16 }), (e) => e.code === "GPU_WRONG");
  assert.match(bad.disabled, /disabled/);
});

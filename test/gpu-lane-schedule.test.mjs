// How GpuLane.grind schedules the CPU checks around the GPU (src/gpu-gate.mjs), without a GPU:
// - the previous round's probe is awaited AFTER the next search, never before it, so the GPU does not sit
//   idle while an Argon2 re-hash runs (a re-hash takes 15-23 ms per round on a rented RTX 4090; no measurable change with an idle CPU at
//   the live difficulty, about 5-8% recovered with the CPU busy);
// - the random probe keeps its detection rate (one uniformly random nonce per round, every one re-hashed);
// - nothing the GPU reported passes unverified: a pending probe is settled before a candidate or "none"
//   leaves grind(), a wrong candidate or probe disables the lane, and a restarted device keeps the rule.
// A fake engine (createSearch over a runBatch that answers at once) stands in for the GPU. The order of events is what is checked,
// never a wall-clock time: the tests wait for the event loop to drain (tick), not for a number of milliseconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sha256 } from "@noble/hashes/sha256";
import { equal } from "../src/bytes.mjs";
import { GpuError, GpuLane } from "../src/gpu-gate.mjs";
import { nonceOf, passwordOf } from "../src/mine.mjs";
import { createSearch } from "../src/webgpu/batcher.mjs";

/** Lets every pending promise reaction run (the fake engine and the held checks use no timers). */
const tick = () => new Promise((r) => setImmediate(r));
const CH = new Uint8Array(32).fill(5);
const ALL = (1n << 256n) - 1n;
const grindArgs = (over = {}) => ({ challenge: CH, target: 0n, nonceStart: 0n, count: 64, timeoutMs: 5000, ...over });
const tagOf = (pw) => sha256(pw); // the fake reference and (unless corrupted) the fake GPU

/** A seeded randomBytes (xorshift32), so a probe-rate test is the same on every run. */
function seeded(seed) {
  let s = seed >>> 0 || 1;
  return (n) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      s ^= s << 13;
      s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5;
      s >>>= 0;
      out[i] = s & 0xff;
    }
    return out;
  };
}

/**
 * A GpuDevice over the real batcher. bad(nonceCounter) -> true makes the GPU answer with a wrong tag for that nonce.
 * searches: [{ probe, count }] per search call; onSearchDone(n) runs when the n-th search (1-based) has returned its result.
 */
function engine({ slots = 8, bad = () => false, searches = [], onSearchDone = () => {} } = {}) {
  const runBatch = async (pw) => {
    const out = new Uint8Array(slots * 32);
    for (let i = 0; i < slots; i++) {
      const p = pw.subarray(i * 40, i * 40 + 40);
      const counter = Number(new DataView(p.buffer, p.byteOffset + 32, 8).getBigUint64(0, true));
      const t = tagOf(p);
      if (bad(counter)) t[0] ^= 0xff;
      out.set(t, i * 32);
    }
    return out;
  };
  const search = createSearch({ runBatch, slots, pipelineDepth: 2 });
  return {
    info: { device: 0, name: "Fake engine", slots },
    search: async (args) => {
      searches.push({ probe: args.probe, count: args.count });
      const n = searches.length;
      const res = await search.search(args);
      onSearchDone(n);
      return res;
    },
    hash: search.hash,
    close: async () => {},
  };
}

/** A verifyMany whose answers are held until released: lets a test decide when the CPU check finishes. */
function heldVerify() {
  const waiting = [];
  const calls = [];
  const verifyMany = (pws) => {
    calls.push(pws);
    return new Promise((resolve) => waiting.push(() => resolve(pws.map(tagOf))));
  };
  return { verifyMany, calls, release: () => waiting.splice(0).forEach((f) => f()), pending: () => waiting.length };
}

test("round N + 1's search runs while round N's probe check is still running (no idle wait for the CPU)", async () => {
  const held = heldVerify();
  const searches = [];
  const lane = new GpuLane({ device: engine({ searches }), verifyMany: held.verifyMany, randomBytes: seeded(1) });
  await lane.grind(grindArgs()); // round 1: nothing pending to settle; starts probe 1
  assert.equal(held.calls.length, 1, "round 1's probe is re-hashed");
  assert.equal(held.pending(), 1);
  const second = lane.grind(grindArgs({ nonceStart: 64n }));
  let settled = false;
  second.then(() => (settled = true), () => (settled = true));
  await tick(); // everything that can run without the CPU check has run
  assert.equal(searches.length, 2, "the second search ran although the first probe check has not finished");
  assert.equal(held.pending(), 1, "the first probe check is still running");
  assert.equal(settled, false, "but grind() does not return until the previous probe has been checked");
  held.release();
  assert.deepEqual(await second, { nonce: null, powHash: null, tried: 64 });
  assert.equal(held.calls.length, 2, "probe 2 started once probe 1 was settled");
  held.release();
});

test("event order over several rounds: every search starts before the previous probe check ends, and grind() returns after it", { timeout: 10_000 }, async () => {
  // The check of round N - 1 is held until round N's search has returned. If grind() waited for the check BEFORE
  // searching (the old order) it would wait forever here, so the GPU idling for the CPU shows as a hang, not as a timing.
  const held = heldVerify();
  const events = [];
  const verifyMany = (pws) => {
    const n = held.calls.length + 1;
    events.push(`verify-start ${n}`);
    return held.verifyMany(pws).then((r) => (events.push(`verify-end ${n}`), r));
  };
  const rounds = 5;
  const device = engine({
    onSearchDone: (n) => {
      events.push(`search-done ${n}`);
      if (n > 1) held.release(); // round n's search is back: now the CPU check of round n - 1 may finish
    },
  });
  const inner = device.search;
  let started = 0;
  device.search = async (a) => {
    started += 1;
    events.push(`search-start ${started}`);
    return inner(a);
  };
  const lane = new GpuLane({ device, verifyMany, randomBytes: seeded(2) });
  for (let round = 1; round <= rounds; round++) {
    const r = await lane.grind(grindArgs({ nonceStart: BigInt(round * 64), count: 64 }));
    events.push(`grind-done ${round}`);
    assert.equal(r.tried, 64);
  }
  assert.equal(lane.disabled, null);
  const at = (e) => {
    const i = events.indexOf(e);
    assert.ok(i >= 0, `${e} happened: ${events.join(", ")}`);
    return i;
  };
  for (let n = 2; n <= rounds; n++) {
    assert.ok(at(`verify-start ${n - 1}`) < at(`search-start ${n}`), `probe ${n - 1} was started before search ${n}`);
    assert.ok(at(`search-start ${n}`) < at(`search-done ${n}`));
    assert.ok(at(`search-done ${n}`) < at(`verify-end ${n - 1}`), `search ${n} returned before check ${n - 1} ended`);
    assert.ok(at(`verify-end ${n - 1}`) < at(`grind-done ${n}`), `grind ${n} returned after check ${n - 1}`);
  }
  held.release();
});

test("the random probe: one uniformly random nonce per round, each re-hashed once, in range", async () => {
  const searches = [];
  const rehashed = [];
  const verifyMany = async (pws) => {
    rehashed.push(...pws);
    return pws.map(tagOf);
  };
  const count = 64;
  const rounds = 200;
  const lane = new GpuLane({ device: engine({ searches }), verifyMany, randomBytes: seeded(3) });
  for (let i = 0; i < rounds; i++) await lane.grind(grindArgs({ count, nonceStart: BigInt(i * count) }));
  assert.equal(searches.length, rounds);
  for (const s of searches) assert.ok(Number.isInteger(s.probe) && s.probe >= 0 && s.probe < count);
  // every round's probe nonce was re-hashed (the last round's check is the one started after the final search)
  assert.equal(rehashed.length, rounds, "one CPU re-hash per round");
  searches.forEach((s, i) => {
    assert.ok(equal(rehashed[i], passwordOf(CH, nonceOf(BigInt(i * count + s.probe)))), `round ${i}: the re-hashed password is the probe nonce`);
  });
  // spread: with 200 draws over 64 slots every quarter of the range is hit
  const quarters = new Set(searches.map((s) => Math.floor((s.probe * 4) / count)));
  assert.equal(quarters.size, 4);
});

test("probe detection rate is unchanged: a GPU wrong on a fraction f of nonces is caught within a few rounds", async () => {
  // wrong on every 4th nonce: a round's probe lands on one with probability 1/4, so 80 rounds miss with p = 0.75^80 = 1e-10
  const lane = new GpuLane({ device: engine({ bad: (c) => c % 4 === 0 }), verifyMany: async (p) => p.map(tagOf), randomBytes: seeded(4) });
  let caughtAt = null;
  for (let i = 0; i < 80 && caughtAt === null; i++) {
    try {
      const r = await lane.grind(grindArgs({ nonceStart: BigInt(i * 64) }));
      assert.equal(r.nonce, null, "a round the GPU got wrong never yields a nonce here (target 0)");
    } catch (e) {
      assert.ok(e instanceof GpuError && e.code === "GPU_WRONG");
      caughtAt = i;
    }
  }
  assert.notEqual(caughtAt, null, "the wrong GPU was caught");
  assert.ok(lane.disabled);

  // one wrong nonce, hit by the probe of round 3 (probe = nonce 10 of every round): rounds 0-3 return, round 4 is refused, never later
  const at = 64 * 3 + 10;
  const pinned = new GpuLane({ device: engine({ bad: (c) => c === at }), verifyMany: async (p) => p.map(tagOf), randomBytes: () => Uint8Array.of(0, 0, 0, 0, 0, 10) });
  const outcome = [];
  for (let i = 0; i < 6 && !pinned.disabled; i++) {
    try {
      await pinned.grind(grindArgs({ nonceStart: BigInt(i * 64) }));
      outcome.push("ok");
    } catch (e) {
      outcome.push(e.code);
    }
  }
  assert.deepEqual(outcome, ["ok", "ok", "ok", "ok", "GPU_WRONG"]);
});

test("nothing unverified passes: a pending probe is settled before a candidate or an empty answer is returned", async () => {
  // a bad probe from round 1 and an honest-looking candidate in round 2: round 2 must be refused, not returned
  const held = heldVerify();
  const bad = new Set();
  const lane = new GpuLane({ device: engine({ bad: (c) => bad.has(c) }), verifyMany: held.verifyMany, randomBytes: () => new Uint8Array(6) }); // probe = nonce 0 of each round
  bad.add(0);
  await lane.grind(grindArgs()); // round 1: the probe (nonce 0) came back wrong; its check is running
  const second = lane.grind(grindArgs({ target: ALL, nonceStart: 1000n })); // would return nonce 1000
  const outcome = Promise.allSettled([second]);
  await tick();
  assert.equal(held.pending(), 1, "the check of the bad probe is still running");
  assert.equal(lane.disabled, null, "not decided while the check runs");
  held.release();
  const [r] = await outcome;
  assert.equal(r.status, "rejected");
  assert.equal(r.reason.code, "GPU_WRONG");
  assert.ok(lane.disabled);
  await assert.rejects(lane.grind(grindArgs()), (e) => e.code === "GPU_WRONG", "a disabled lane stays disabled");
});

test("a candidate with a wrong hash is refused even when the probe is fine, and every returned nonce was re-hashed", async () => {
  const hashed = [];
  const verifyMany = async (pws) => {
    hashed.push(...pws);
    return pws.map(tagOf);
  };
  const ok = new GpuLane({ device: engine(), verifyMany, randomBytes: seeded(6) });
  const r = await ok.grind(grindArgs({ target: ALL, nonceStart: 500n }));
  assert.deepEqual([...r.nonce], [...nonceOf(500n)]);
  assert.ok(hashed.some((p) => equal(p, passwordOf(CH, r.nonce))), "the returned nonce's password went through the CPU reference");
  assert.equal(r.powHash.length, 32);

  const liar = new GpuLane({ device: engine({ bad: (c) => c === 500 }), verifyMany, randomBytes: seeded(6) });
  await assert.rejects(liar.grind(grindArgs({ target: ALL, nonceStart: 500n })), (e) => e.code === "GPU_WRONG");
  assert.ok(liar.disabled);
});

test("a restartable search error settles the pending probe first: a wrong probe bans the lane, no restart, no candidate", async () => {
  const bad = new Set([0]); // the probe is nonce 0 of every round; round 1's came back wrong
  const inner = engine({ bad: (c) => bad.has(c) });
  let broken = false;
  let reopened = 0;
  const device = { ...inner, search: async (a) => (broken ? Promise.reject(new GpuError("lost", "GPU_START")) : inner.search(a)) };
  const lane = new GpuLane({
    device,
    verifyMany: async (p) => p.map(tagOf),
    randomBytes: () => new Uint8Array(6),
    reopen: async () => {
      reopened += 1;
      return device;
    },
  });
  await lane.grind(grindArgs()); // round 1: the wrong probe is now being checked
  broken = true;
  await assert.rejects(lane.grind(grindArgs({ target: ALL, nonceStart: 1000n })), (e) => e.code === "GPU_WRONG");
  assert.ok(lane.disabled, "the lane is banned");
  assert.equal(lane.restarts, 0, "no restart was attempted");
  assert.equal(reopened, 0);
  await assert.rejects(lane.grind(grindArgs()), (e) => e.code === "GPU_WRONG", "and stays banned");
});

test("a restartable search error with a good pending probe still restarts the device and rethrows the error", async () => {
  const inner = engine();
  let broken = false;
  let reopened = 0;
  const device = { ...inner, search: async (a) => (broken ? Promise.reject(new GpuError("lost", "GPU_START")) : inner.search(a)) };
  const lane = new GpuLane({
    device,
    verifyMany: async (p) => p.map(tagOf),
    randomBytes: seeded(7),
    reopen: async () => {
      reopened += 1;
      return device;
    },
  });
  await lane.grind(grindArgs()); // round 1 ok, its probe is pending (and fine)
  broken = true;
  await assert.rejects(lane.grind(grindArgs()), (e) => e.code === "GPU_START");
  assert.equal(lane.disabled, null);
  assert.equal(reopened, 1);
  broken = false;
  assert.equal((await lane.grind(grindArgs())).tried, 64, "the lane is alive again");
});

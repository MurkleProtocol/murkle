// Mining primitives (mining-contract.md §2, §3, §4, §7.1, §13 core): Argon2id vectors with the
// reference (noble) and the fast path (hash-wasm), the self-test and its fallbacks, the worker
// pool, the difficulty retarget, rewards, the service-fee rule and the pinned constants.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2";
import { sha256 } from "@noble/hashes/sha256";
import { argon2id as wasmArgon2id } from "hash-wasm";
import * as btc from "@scure/btc-signer";
import * as P from "../src/params.mjs";
import * as M from "../src/mine.mjs";
import { PowPool, PowError, createNodePowPool, defaultPowThreads } from "../src/pow-pool.mjs";
import { FIELD } from "../src/core.mjs";
import { hex, unhex } from "../src/bytes.mjs";

const FILE = JSON.parse(readFileSync(new URL("./fixtures/mine-vectors.json", import.meta.url), "utf8"));
const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const CYRILLIC = new RegExp(`[${String.fromCharCode(0x400)}-${String.fromCharCode(0x4ff)}]`);
const noble = (pw) => nobleArgon2id(pw, M.MINE_SALT, { t: 1, m: 4096, p: 1, dkLen: 32 });
const wasm = async (pw) => Uint8Array.from(await wasmArgon2id({
  password: pw, salt: M.MINE_SALT, parallelism: 1, iterations: 1, memorySize: 4096, hashLength: 32, outputType: "binary",
}));

after(() => M.__testing.reset());

// ---------------------------------------------------------------- vectors

test("the fixture pins the parameters, the label and at least 16 vectors covering every required case", () => {
  assert.equal(FILE.format, "murkle-mine-vectors/1");
  assert.deepEqual(FILE.argon2, { type: "argon2id", version: 19, memoryKiB: 4096, passes: 1, lanes: 1, tagLength: 32, salt: "murkle/mine/salt" });
  assert.equal(FILE.label, P.LABELS.mine);
  assert.equal(P.LABELS.mine, "murkle/mine/v1");
  assert.equal(new TextEncoder().encode(P.LABELS.mine).length, 14);
  assert.equal(hex(M.MINE_SALT), hex(new TextEncoder().encode("murkle/mine/salt")));
  assert.equal(M.MINE_SALT.length, 16);
  assert.deepEqual({ ...P.ARGON }, { type: "argon2id", version: 0x13, memoryKiB: 4096, passes: 1, lanes: 1, tagLength: 32 });
  const v = FILE.vectors;
  assert.ok(v.length >= 16, `${v.length} vectors`);
  const has = (pred, what) => assert.ok(v.some(pred), what);
  has((x) => x.nonce === "0000000000000000", "nonce 0");
  has((x) => x.nonce === "ffffffffffffffff", "nonce ff..ff");
  has((x) => x.refHash === "0".repeat(64), "zero ref hash");
  has((x) => /[1-9a-f]/.test(x.refHash.slice(0, 32)), "random ref hash");
  has((x) => x.commitments.every((c) => BigInt(c) === FIELD - 1n), "field-max commitments");
  has((x) => x.asset === "0", "asset 0");
  has((x) => x.asset === ((1n << 64n) - 1n).toString(), "asset 2^64 - 1");
  has((x) => x.reward === "1", "reward 1");
  has((x) => x.reward === ((1n << 63n) - 1n).toString(), "reward 2^63 - 1");
  for (const d of ["1", "256", "1000", P.D_MAX.toString()]) has((x) => x.difficulty === d, `difficulty ${d}`);
  has((x) => x.difficulty === null && x.target === x.powHash && x.valid === true, "equality vector");
  has((x) => x.difficulty === null && BigInt("0x" + x.target) === BigInt("0x" + x.powHash) - 1n && x.valid === false, "target = powHash - 1");
  has((x) => x.valid && x.difficulty === "256", "a valid solution at the protocol floor");
  for (const x of v) {
    for (const k of ["challenge", "solutionId", "powHash", "target"]) assert.match(x[k], /^[0-9a-f]{64}$/, `${x.name}.${k}`);
    assert.match(x.password, /^[0-9a-f]{80}$/);
    assert.match(x.nonce, /^[0-9a-f]{16}$/);
  }
});

test("illustrative vector of mining.md §4.3 (asset 325000 << 32 | 7, ref 325100)", () => {
  const x = FILE.vectors.find((v) => v.name === "illustrative");
  assert.equal(BigInt(x.asset), (325000n << 32n) | 7n);
  assert.equal(x.challenge, "f9181c09f98cb253ed91f856cc42eab177a0639e22df4de67f8d5d9176121661");
  assert.equal(x.solutionId, "1bb0f3380801d593ed3d3ae627ce16a8209f228bceea9e7d6ca2921fcc2008f4");
  assert.equal(x.powHash, "8ce2b336274d4c3a60b8c69f8902776ea6e657318fb1bd8d44edcfad4d44c372");
  assert.equal(x.valid, false, "not valid at D = 1000");
});

test("RFC 9106 §5.3: noble reproduces the Argon2id vector; hash-wasm (no associated data input) reproduces the no-AD variant", async () => {
  const r = FILE.rfc9106;
  assert.equal(r.tag, "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659");
  const ref = nobleArgon2id(unhex(r.password), unhex(r.salt), { t: r.passes, m: r.memoryKiB, p: r.lanes, dkLen: r.tagLength, key: unhex(r.secret), personalization: unhex(r.ad) });
  assert.equal(hex(ref), r.tag);
  assert.deepEqual({ ...M.RFC9106_VECTOR }, r);

  const n = FILE.rfc9106NoAd;
  assert.equal(n.ad, undefined);
  assert.equal(n.tag, "0034de3c8a75efc1148100eaf5ba9b1ce6d50ba5cdf6ae4018c54a4fc03ac10d");
  for (const k of ["password", "salt", "secret", "memoryKiB", "passes", "lanes", "tagLength"]) assert.equal(n[k], r[k], k);
  const fast = await wasmArgon2id({
    password: unhex(n.password), salt: unhex(n.salt), secret: unhex(n.secret), parallelism: n.lanes, iterations: n.passes,
    memorySize: n.memoryKiB, hashLength: n.tagLength, outputType: "binary",
  });
  assert.equal(hex(fast), n.tag);
  const refNoAd = nobleArgon2id(unhex(n.password), unhex(n.salt), { t: n.passes, m: n.memoryKiB, p: n.lanes, dkLen: n.tagLength, key: unhex(n.secret) });
  assert.equal(hex(refNoAd), n.tag);
});

test("every vector: challenge, password, solutionId, powHash (noble and hash-wasm), target and validity", async () => {
  for (const x of FILE.vectors) {
    const pre = M.claimPreimage({
      asset: BigInt(x.asset), refHeight: x.refHeight, refHash: x.refHash, reward: BigInt(x.reward), commitments: x.commitments.map(BigInt), nonce: unhex(x.nonce),
    });
    assert.equal(hex(pre.challenge), x.challenge, x.name);
    assert.equal(hex(pre.password), x.password, x.name);
    assert.equal(pre.solutionIdHex, x.solutionId, x.name);
    assert.equal(hex(M.solutionIdOf(pre.challenge, unhex(x.nonce))), x.solutionId);
    assert.equal(hex(sha256(unhex(x.password))), x.solutionId);
    // refHash as 32 bytes gives the same challenge.
    assert.equal(hex(M.challengeOf({ asset: BigInt(x.asset), refHeight: x.refHeight, refHash: unhex(x.refHash), reward: BigInt(x.reward), commitments: x.commitments.map(BigInt) })), x.challenge);
    const pw = unhex(x.password);
    assert.equal(hex(M.powHashReference(pw)), x.powHash, `${x.name}: noble`);
    assert.equal(hex(await wasm(pw)), x.powHash, `${x.name}: hash-wasm`);
    assert.equal(hex(await M.powHash(pw)), x.powHash, `${x.name}: powHash`);
    if (x.difficulty !== null) {
      assert.equal(M.targetHex(BigInt(x.difficulty)), x.target, `${x.name}: target`);
      assert.equal(M.meetsTarget(unhex(x.powHash), M.targetOf(BigInt(x.difficulty))), x.valid, `${x.name}: valid`);
    }
    assert.equal(M.meetsTarget(unhex(x.powHash), x.target), x.valid, `${x.name}: valid against the hex target`);
  }
});

test("64 concurrent hash-wasm calls equal sequential noble", async () => {
  const pws = Array.from({ length: 64 }, (_, i) => sha256(new Uint8Array([i])).slice(0, 8)).map((n, i) => M.passwordOf(sha256(new Uint8Array([i, 1])), n));
  const fast = await Promise.all(pws.map((pw) => wasm(pw)));
  const viaPowHash = await Promise.all(pws.map((pw) => M.powHash(pw)));
  pws.forEach((pw, i) => {
    const ref = hex(noble(pw));
    assert.equal(hex(fast[i]), ref, `hash-wasm ${i}`);
    assert.equal(hex(viaPowHash[i]), ref, `powHash ${i}`);
  });
  assert.deepEqual(M.fastPathState(), { impl: "hash-wasm", tested: true, disabled: null });
});

test("SELF_TEST_VECTORS are entries of the fixture (at least three mine vectors, the equality one, and the no-AD vector)", () => {
  const mine = M.SELF_TEST_VECTORS.filter((v) => !v.salt);
  assert.ok(mine.length >= 3);
  assert.ok(Object.isFrozen(M.SELF_TEST_VECTORS));
  for (const s of mine) {
    const f = FILE.vectors.find((v) => v.name === s.name);
    assert.ok(f, s.name);
    assert.equal(s.password, f.password, s.name);
    assert.equal(s.powHash, f.powHash, s.name);
  }
  const eq = FILE.vectors.find((v) => v.difficulty === null && v.valid);
  assert.ok(mine.some((s) => s.password === eq.password && s.powHash === eq.powHash), "the equality vector");
  const noAd = M.SELF_TEST_VECTORS.find((v) => v.salt);
  const { tag, ...params } = FILE.rfc9106NoAd;
  assert.equal(noAd.powHash, tag);
  for (const [k, val] of Object.entries(params)) assert.equal(noAd[k], val, k);
});

// ---------------------------------------------------------------- self-test and fallbacks

test("a forced hash-wasm mismatch disables the fast path; powHash then uses the reference and stays correct", async () => {
  const x = FILE.vectors[0];
  M.__testing.reset();
  M.__testing.setImpls({ fast: async () => new Uint8Array(32).fill(7) });
  assert.deepEqual(await M.selfTest(), { ok: true, impl: "noble" });
  assert.deepEqual(M.fastPathState(), { impl: "noble", tested: true, disabled: "self-test failed" });
  assert.equal(hex(await M.powHash(unhex(x.password))), x.powHash);

  // A throwing fast path is a failed self-test too.
  M.__testing.reset();
  M.__testing.setImpls({ fast: async () => { throw new Error("wasm out of memory"); } });
  assert.equal((await M.selfTest()).impl, "noble");
  assert.equal(M.fastPathState().disabled, "self-test failed");
  M.__testing.reset();
});

test("a hash-wasm failure after the self-test disables the fast path and retries the same password with the reference", async () => {
  const x = FILE.vectors[1];
  M.__testing.reset();
  assert.equal((await M.selfTest()).impl, "hash-wasm");
  let calls = 0;
  M.__testing.setImpls({ fast: async () => { calls += 1; throw new Error("RuntimeError: unreachable"); } });
  assert.equal(hex(await M.powHash(unhex(x.password))), x.powHash);
  assert.equal(calls, 1);
  assert.match(M.fastPathState().disabled, /runtime error/);
  assert.equal(hex(await M.powHash(unhex(x.password))), x.powHash);
  assert.equal(calls, 1, "never tried again in this process");
  M.__testing.reset();
});

test("a throwing reference makes powHash throw (POW_FAILED), never return a value; a wrong reference fails the self-test (POW_SELF_TEST)", async () => {
  const x = FILE.vectors[0];
  // Fast path disabled by its own failure, then the reference throws: an error, not a value.
  M.__testing.reset();
  await M.selfTest();
  M.__testing.setImpls({
    fast: async () => { throw new Error("wasm trap"); },
    reference: () => { throw new Error("allocation failed"); },
  });
  await assert.rejects(M.powHash(unhex(x.password)), (e) => e.code === "POW_FAILED");
  await assert.rejects(M.powHash(unhex(x.password)), (e) => e.code === "POW_FAILED");

  // A reference that computes wrong values fails the self-test: powHash refuses to answer at all.
  M.__testing.reset();
  M.__testing.setImpls({ reference: () => new Uint8Array(32) });
  assert.deepEqual(await M.selfTest(), { ok: false, impl: null });
  await assert.rejects(M.powHash(unhex(x.password)), (e) => e.code === "POW_SELF_TEST" && /self-test failed/.test(e.message));
  M.__testing.reset();
  assert.equal(hex(await M.powHash(unhex(x.password))), x.powHash);
});

test("powHash and powHashReference take exactly 40-byte passwords; inlinePow.hashMany dedups", async () => {
  await assert.rejects(M.powHash(new Uint8Array(39)), TypeError);
  assert.throws(() => M.powHashReference(new Uint8Array(41)), TypeError);
  const a = unhex(FILE.vectors[0].password);
  const b = unhex(FILE.vectors[1].password);
  const out = await M.inlinePow.hashMany([a, b, a]);
  assert.deepEqual(out.map(hex), [FILE.vectors[0].powHash, FILE.vectors[1].powHash, FILE.vectors[0].powHash]);
});

// ---------------------------------------------------------------- nonces, targets, grinding

test("nonce counter encoding, targets and the equality rule", async () => {
  assert.equal(hex(M.nonceOf(0n)), "0000000000000000");
  assert.equal(hex(M.nonceOf(1n)), "0100000000000000");
  assert.equal(hex(M.nonceOf((1n << 64n) - 1n)), "ffffffffffffffff");
  assert.equal(M.counterOf(M.nonceOf(123456789012345n)), 123456789012345n);
  assert.throws(() => M.nonceOf(1n << 64n), RangeError);
  assert.throws(() => M.nonceOf(-1n), RangeError);
  assert.equal(M.targetOf(1n), (1n << 256n) - 1n);
  assert.equal(M.targetOf(256n), ((1n << 256n) - 1n) / 256n);
  assert.equal(M.targetHex(1n), "f".repeat(64));
  assert.throws(() => M.targetOf(0n), RangeError);
  assert.throws(() => M.targetOf(P.D_MAX + 1n), RangeError);
  assert.equal(P.D_MAX, (1n << 63n) - 1n);
  const h = unhex("00".repeat(31) + "10");
  assert.equal(M.meetsTarget(h, 16n), true, "equal to the target is valid");
  assert.equal(M.meetsTarget(h, 15n), false);
  assert.equal(M.meetsTarget(new Uint8Array(32).fill(255), M.targetOf(1n)), true);
  assert.equal(M.PASSWORD_LEN, 40);
  assert.equal(M.NONCE_LEN, 8);
});

test("grindRange tries nonceStart, +1, … wrapping at 2^64, and reports how many it tried", async () => {
  const seen = [];
  const hash = async (pw) => { seen.push(hex(pw.slice(32))); return seen.length === 3 ? new Uint8Array(32) : new Uint8Array(32).fill(255); };
  const r = await M.grindRange({ challenge: new Uint8Array(32), target: M.targetOf(1000n), nonceStart: (1n << 64n) - 2n, count: 10, hash });
  assert.deepEqual(seen, ["feffffffffffffff", "ffffffffffffffff", "0000000000000000"]);
  assert.equal(hex(r.nonce), "0000000000000000");
  assert.equal(r.tried, 3);
  const none = await M.grindRange({ challenge: new Uint8Array(32), target: 0n, nonceStart: M.nonceOf(5n), count: 4, hash: async () => new Uint8Array(32).fill(1) });
  assert.deepEqual(none, { nonce: null, powHash: null, tried: 4 });
  // Real Argon2: a solution at D = 16 from the fixture's challenge, checked by the reference.
  const x = FILE.vectors[0];
  const found = await M.grindRange({ challenge: unhex(x.challenge), target: M.targetHex(16n), nonceStart: 0n, count: 2000 });
  assert.ok(found.nonce);
  assert.ok(M.meetsTarget(M.powHashReference(M.passwordOf(unhex(x.challenge), found.nonce)), M.targetOf(16n)));
});

// ---------------------------------------------------------------- worker pool

/** A fake worker running the pow-worker protocol in-process (fast, deterministic, controllable). */
class FakeWorker extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.terminated = false;
    this.hashed = [];
    setImmediate(() => !this.terminated && this.emit("message", { type: "ready", ok: opts.ok ?? true, impl: opts.ok === false ? null : "hash-wasm" }));
  }
  postMessage(msg) {
    if (this.opts.onPost?.(msg, this) === "handled") return;
    setImmediate(() => {
      if (this.terminated) return;
      if (msg.type === "hash") {
        this.hashed.push(...msg.passwords);
        this.emit("message", { id: msg.id, ok: true, hashes: msg.passwords.map((p) => hex(sha256(unhex(p)))) });
      } else if (msg.type === "grind") {
        this.emit("message", { id: msg.id, ok: true, nonce: msg.nonceStart, powHash: "00".repeat(32), tried: 1 });
      }
    });
  }
  terminate() { this.terminated = true; return Promise.resolve(0); }
}
const pw = (i) => M.passwordOf(sha256(new Uint8Array([i])), M.nonceOf(BigInt(i)));

test("PowPool: ready(), hash, hashMany in input order with equal passwords evaluated once", async () => {
  const workers = [];
  const pool = new PowPool({ size: 3, spawn: () => { const w = new FakeWorker(); workers.push(w); return w; } });
  assert.deepEqual(await pool.ready(), { impl: "hash-wasm", workers: 3 });
  assert.equal(pool.size, 3);
  assert.equal(hex(await pool.hash(pw(1))), hex(sha256(pw(1))));
  const list = [pw(1), pw(2), pw(1), pw(3), pw(2), pw(1)];
  const out = await pool.hashMany(list);
  assert.deepEqual(out.map(hex), list.map((p) => hex(sha256(p))));
  const evaluated = workers.flatMap((w) => w.hashed);
  assert.equal(evaluated.length, 1 + 3, "one for hash(), three distinct passwords for hashMany()");
  assert.deepEqual(await pool.hashMany([]), []);
  await assert.rejects(pool.hash(new Uint8Array(12)), TypeError);
  assert.equal(pool.busy, 0);
  assert.equal(pool.queued, 0);
  await pool.close();
});

test("PowPool: a killed worker rejects its task with PowError (never a result) and is replaced", async () => {
  let n = 0;
  const workers = [];
  const pool = new PowPool({
    size: 1,
    spawn: () => {
      n += 1;
      const first = n === 1;
      const w = new FakeWorker({ onPost: first ? (msg, self) => { setImmediate(() => self.emit("exit", 1)); return "handled"; } : undefined });
      workers.push(w);
      return w;
    },
  });
  await pool.ready();
  await assert.rejects(pool.hash(pw(9)), (e) => e instanceof PowError && e.code === "POW_WORKER_FAILED");
  assert.ok(workers[0].terminated);
  assert.equal(hex(await pool.hash(pw(9))), hex(sha256(pw(9))), "the replacement answers");
  assert.equal(n, 2);

  // An error event and a silent worker (timeout) behave the same way.
  let m = 0;
  const pool2 = new PowPool({
    size: 1, timeoutMs: 50,
    spawn: () => {
      m += 1;
      if (m === 1) return new FakeWorker({ onPost: (msg, self) => { setImmediate(() => self.emit("error", new Error("boom"))); return "handled"; } });
      if (m === 2) return new FakeWorker({ onPost: () => "handled" });
      return new FakeWorker();
    },
  });
  await pool2.ready();
  await assert.rejects(pool2.hashMany([pw(1)]), (e) => e.code === "POW_WORKER_FAILED");
  await assert.rejects(pool2.hash(pw(1)), (e) => e.code === "POW_TIMEOUT");
  assert.equal(hex(await pool2.hash(pw(1))), hex(sha256(pw(1))));
  await pool.close();
  await pool2.close();
});

test("PowPool: POW_BUSY beyond maxQueue for hash() (never for hashMany), POW_CLOSED after close(), POW_SELF_TEST when workers fail it", async () => {
  const held = [];
  const pool = new PowPool({ size: 1, maxQueue: 2, spawn: () => new FakeWorker({ onPost: (msg, self) => { held.push([msg, self]); return "handled"; } }) });
  await pool.ready();
  const running = pool.hash(pw(1)); // dispatched
  const q1 = pool.hash(pw(2));
  const q2 = pool.hash(pw(3));
  assert.equal(pool.busy, 1);
  assert.equal(pool.queued, 2);
  await assert.rejects(pool.hash(pw(4)), (e) => e instanceof PowError && e.code === "POW_BUSY");
  const many = pool.hashMany([pw(5), pw(6)]); // the indexer is never refused for queue length
  assert.ok(pool.queued >= 3);
  await pool.close();
  for (const p of [running, q1, q2, many]) await assert.rejects(p, (e) => e.code === "POW_CLOSED");
  await assert.rejects(pool.hash(pw(1)), (e) => e.code === "POW_CLOSED");
  await assert.rejects(pool.ready(), (e) => e.code === "POW_CLOSED");

  const bad = new PowPool({ size: 2, spawn: () => new FakeWorker({ ok: false }) });
  await assert.rejects(bad.ready(), (e) => e.code === "POW_SELF_TEST");
  await assert.rejects(bad.hash(pw(1)), (e) => e.code === "POW_SELF_TEST");
  await bad.close();
});

test("createNodePowPool: real worker_threads pass the self-test and agree with the reference; grind works", async () => {
  const pool = await createNodePowPool({ size: 2 });
  try {
    assert.deepEqual(await pool.ready(), { impl: "hash-wasm", workers: 2 });
    const x = FILE.vectors.slice(0, 5);
    const out = await pool.hashMany([...x, x[0]].map((v) => unhex(v.password)));
    assert.deepEqual(out.map(hex), [...x, x[0]].map((v) => v.powHash));
    const g = await pool.grind({ challenge: unhex(x[0].challenge), target: M.targetHex(8n), nonceStart: 0n, count: 500 });
    assert.ok(g.nonce && g.tried >= 1);
    assert.ok(M.meetsTarget(M.powHashReference(M.passwordOf(unhex(x[0].challenge), g.nonce)), M.targetOf(8n)));
  } finally {
    await pool.close();
  }
  const n = defaultPowThreads();
  assert.ok(Number.isSafeInteger(n) && n >= 1 && n <= 4);
  process.env.MURKLE_POW_THREADS = "7";
  assert.equal(defaultPowThreads(), 7);
  delete process.env.MURKLE_POW_THREADS;
});

// ---------------------------------------------------------------- difficulty

const terms = (o = {}) => ({ span: 24, targetPerSpan: 24, minDifficulty: 256n, ...o });
const eager = (d, works, t = terms()) => works.reduce((acc, w) => M.stepDifficulty(acc, w, t), d);
const assetOf = (o = {}) => ({
  id: 7n, deployHeight: 1000, startHeight: 0, mineStart: 1144, endHeight: 0, reward: 1000n, maxSupply: 10n ** 9n, halvingInterval: 0,
  span: 24, targetPerSpan: 24, initialDifficulty: 1_000_000n, minDifficulty: 256n, issued: 0n, claimFeeSats: 0n, treasury: new Uint8Array(),
  dPts: [[1144, 1_000_000n]], ...o,
});

test("stepDifficulty: the moving-average formula, BigInt floor, floor and D_MAX clamps", () => {
  const t = terms();
  assert.equal(M.stepDifficulty(1_000_000n, 0n, t), 958_333n, "one quiet block: x 23/24");
  assert.equal(M.stepDifficulty(1_000_000n, 1_000_000n, t), 1_000_000n, "one claim at D with S/span = 1: equilibrium");
  assert.equal(M.stepDifficulty(1_000_000n, 1700n * 1_000_000n, t), 71_791_666n, "1,700 claims in one block");
  assert.equal(M.stepDifficulty(1_000_000n, 2_000_000n, t), 1_041_666n, "two claims");
  assert.equal(M.stepDifficulty(300n, 0n, t), 287n);
  assert.equal(M.stepDifficulty(257n, 0n, t), 256n, "never below the floor");
  assert.equal(M.stepDifficulty(256n, 0n, t), 256n, "the floor is a fixed point");
  assert.equal(M.stepDifficulty(P.D_MAX, 1700n * P.D_MAX, t), P.D_MAX, "D_MAX clamp");
  // Equilibrium: X hashes per block settle D at X·span/S.
  const tt = terms({ span: 12, targetPerSpan: 48 });
  assert.equal(M.stepDifficulty(250_000n, 4n * 250_000n, tt), 250_000n, "S/span = 4 claims per block at D keeps D");
  // Formula check against an independent computation.
  for (const [prev, w, span, S] of [[999_999n, 123_456n, 432, 43200], [12_345_678n, 0n, 12, 16], [256n, 10n ** 12n, 100, 1000]]) {
    const want = (prev * BigInt(span - 1) * BigInt(S) + w * BigInt(span)) / (BigInt(span) * BigInt(S));
    const clamped = want < 256n ? 256n : want > P.D_MAX ? P.D_MAX : want;
    assert.equal(M.stepDifficulty(prev, w, { span, targetPerSpan: S, minDifficulty: 256n }), clamped);
  }
});

test("difficultyAt: initial up to mineStart; 0, 1 and n quiet blocks lazy = eager; stops at the floor; reads the newest point", () => {
  const a = assetOf();
  assert.equal(M.difficultyAt(a, 1000), 1_000_000n);
  assert.equal(M.difficultyAt(a, 1144), 1_000_000n, "D(mineStart) = initial");
  assert.equal(M.difficultyAt(a, 1145), 958_333n, "one quiet block");
  for (const n of [0, 1, 2, 10, 100, 500]) assert.equal(M.difficultyAt(a, 1144 + n), eager(1_000_000n, Array(n).fill(0n)), `${n} quiet blocks`);
  assert.equal(M.difficultyAt(a, 1144 + 100_000), 256n, "a long quiet stretch ends at the floor");
  // With points: D at a point's height is the point; after it, quiet decay from it.
  const b = assetOf({ dPts: [[1144, 1_000_000n], [1150, 2_000_000n]] });
  assert.equal(M.difficultyAt(b, 1149), eager(1_000_000n, Array(5).fill(0n)));
  assert.equal(M.difficultyAt(b, 1150), 2_000_000n);
  assert.equal(M.difficultyAt(b, 1153), eager(2_000_000n, [0n, 0n, 0n]));
  const pruned = assetOf({ dPts: [[1150, 2_000_000n]] });
  assert.throws(() => M.difficultyAt(pruned, 1149), RangeError);
  // The stale bound.
  const c = assetOf({ dPts: [[1144, 1000n], [1160, 8000n]] });
  assert.equal(M.effectiveDifficulty(c, 1150, 1161), 2000n, "D(H - 1) / 4 = 2000 > D(1150)");
  assert.equal(M.effectiveDifficulty(c, 1160, 1161), 8000n);
  assert.equal(M.effectiveDifficulty(c, 1150, 1155), M.difficultyAt(c, 1150), "no jump: D(ref) decides");
  assert.equal(P.STALE_FACTOR, 4);
});

test("rewardAt halves every interval from mineStart and reaches 0 at a shift of 63; nextHalving; mineStatus", () => {
  const a = assetOf({ reward: (1n << 63n) - 1n, halvingInterval: 10 });
  assert.equal(M.rewardAt(a, 1144), (1n << 63n) - 1n);
  assert.equal(M.rewardAt(a, 1153), (1n << 63n) - 1n);
  assert.equal(M.rewardAt(a, 1154), ((1n << 63n) - 1n) >> 1n);
  assert.equal(M.rewardAt(a, 1144 + 620), 1n, "shift 62");
  assert.equal(M.rewardAt(a, 1144 + 630), 0n, "shift 63");
  assert.equal(M.rewardAt(a, 1144 + 10_000), 0n);
  assert.equal(M.nextHalving(a, 1150), 1154);
  assert.equal(M.nextHalving(a, 1154), 1164);
  assert.equal(M.nextHalving(a, 1144 + 630), null);
  assert.equal(M.nextHalving(assetOf(), 2000), null, "no halving");
  assert.equal(M.rewardAt(assetOf(), 99_999), 1000n);
  const b = assetOf({ reward: 1000n, halvingInterval: 5 });
  assert.equal(M.rewardAt(b, 1144 + 5 * 9), 1n, "1000 >> 9");
  assert.equal(M.rewardAt(b, 1144 + 5 * 10), 0n, "1000 >> 10");

  // No lead: startHeight 0 (or any height already passed) opens mining at the deploy block itself.
  assert.equal(M.mineStartOf({ deployHeight: 1000, startHeight: 0 }), 1000);
  assert.equal(M.mineStartOf({ deployHeight: 1000 }), 1000);
  assert.equal(M.mineStartOf({ deployHeight: 1000, startHeight: 999 }), 1000, "never before the deploy block");
  assert.equal(M.mineStartOf({ deployHeight: 1000, startHeight: 1001 }), 1001);
  assert.equal(M.mineStartOf({ deployHeight: 1000, startHeight: 2000 }), 2000);
  assert.equal(M.mineStatus(assetOf(), 1143), "mining-soon");
  assert.equal(M.mineStatus(assetOf(), 1144), "mining");
  assert.equal(M.mineStatus(assetOf({ endHeight: 1200 }), 1201), "mining-ended");
  assert.equal(M.mineStatus(b, 1144 + 50), "mining-ended", "reward 0");
  assert.equal(M.mineStatus(assetOf({ issued: 10n ** 9n - 999n }), 1150), "mined-out");
  assert.equal(M.mineStatus(assetOf({ issued: 10n ** 9n - 1000n }), 1150), "mining");
});

// ---------------------------------------------------------------- service fee

const PLATFORM = unhex(P.MINE_FEES.signet.platformScript);
const TREASURY = unhex("5120" + "ab".repeat(32));
const DEPLOYER_ONLY = { platformScript: null, platformSats: 0n, deployerMinSats: 546n, deployerMaxSats: 10_000n };
const BOTH = { platformScript: P.MINE_FEES.signet.platformScript, platformSats: 500n, deployerMinSats: 0n, deployerMaxSats: 10_000n };

test("requiredFeeOutputs and feeOutputsPaid under the three policies, with same-script summing", () => {
  // Owner's constants: the platform only.
  const own = M.requiredFeeOutputs(assetOf());
  assert.equal(own.length, 1);
  assert.equal(hex(own[0].script), P.MINE_FEES.signet.platformScript);
  assert.equal(own[0].sats, 500n);
  assert.equal(own[0].role, "platform");
  // Deployer's treasury only.
  const dep = M.requiredFeeOutputs(assetOf({ claimFeeSats: 1000n, treasury: TREASURY }), DEPLOYER_ONLY);
  assert.deepEqual(dep.map((g) => [hex(g.script), g.sats, g.role]), [[hex(TREASURY), 1000n, "deployer"]]);
  // Both, different scripts: treasury first, then the platform.
  const both = M.requiredFeeOutputs(assetOf({ claimFeeSats: 700n, treasury: TREASURY }), BOTH);
  assert.deepEqual(both.map((g) => [hex(g.script), g.sats, g.role]), [[hex(TREASURY), 700n, "deployer"], [hex(PLATFORM), 500n, "platform"]]);
  // Both, the same script: one group, amounts summed.
  const same = M.requiredFeeOutputs(assetOf({ claimFeeSats: 700n, treasury: PLATFORM }), BOTH);
  assert.deepEqual(same.map((g) => [hex(g.script), g.sats, g.role]), [[hex(PLATFORM), 1200n, "both"]]);
  assert.deepEqual(M.requiredFeeOutputs(assetOf(), null), [], "no fee rule");

  const tx = (outs) => ({ outputs: outs.map(([script, value]) => ({ script, value })) });
  const paid = M.feeOutputsPaid(assetOf({ claimFeeSats: 700n, treasury: PLATFORM }), tx([[PLATFORM, 600], [PLATFORM, 600n], [TREASURY, 99]]), BOTH);
  assert.deepEqual(paid, { ok: true, paid: 1200n, short: [] }, "gross sum over outputs to the script");
  const short = M.feeOutputsPaid(assetOf({ claimFeeSats: 700n, treasury: TREASURY }), tx([[TREASURY, 700], [PLATFORM, 499]]), BOTH);
  assert.equal(short.ok, false);
  assert.equal(short.paid, 1199n);
  assert.deepEqual(short.short, [{ script: hex(PLATFORM), need: 500n, paid: 499n }]);
  assert.equal(M.feeOutputsPaid(assetOf(), tx([[PLATFORM, 500]])).ok, true);
  assert.equal(M.feeOutputsPaid(assetOf(), tx([[TREASURY, 5000]])).ok, false);
});

test("checkFeePolicy: the owner's constants forbid any deployer fee; the other policies bound it", () => {
  assert.equal(M.checkFeePolicy(0n, new Uint8Array()), null);
  assert.equal(M.checkFeePolicy(0n, TREASURY), null);
  assert.equal(M.checkFeePolicy(1n, TREASURY), "malformed: deployer claim fee not allowed");
  assert.equal(M.checkFeePolicy(546n, TREASURY), "malformed: deployer claim fee not allowed");
  // Deployer fee required within bounds.
  assert.equal(M.checkFeePolicy(0n, new Uint8Array(), DEPLOYER_ONLY), "malformed: claim fee 0 outside 546..10000");
  assert.equal(M.checkFeePolicy(546n, TREASURY, DEPLOYER_ONLY), null);
  assert.equal(M.checkFeePolicy(10_001n, TREASURY, DEPLOYER_ONLY), "malformed: claim fee 10001 outside 546..10000");
  // Optional deployer fee: 0, or 546 .. max.
  assert.equal(M.checkFeePolicy(0n, new Uint8Array(), BOTH), null);
  assert.equal(M.checkFeePolicy(545n, TREASURY, BOTH), "malformed: claim fee below 546 sats");
  assert.equal(M.checkFeePolicy(546n, TREASURY, BOTH), null);
  assert.equal(M.checkFeePolicy(10_001n, TREASURY, BOTH), "malformed: claim fee 10001 outside 546..10000");
});

test("isStandardScript and dustLimit recognise exact templates only", () => {
  const cases = [
    ["76a914" + "11".repeat(20) + "88ac", "p2pkh", 546n],
    ["a914" + "11".repeat(20) + "87", "p2sh", 540n],
    ["0014" + "11".repeat(20), "p2wpkh", 294n],
    ["0020" + "11".repeat(32), "p2wsh", 330n],
    ["5120" + "11".repeat(32), "p2tr", 330n],
  ];
  for (const [s, kind, dust] of cases) {
    assert.equal(M.isStandardScript(unhex(s)), kind);
    assert.equal(M.isStandardScript(s), kind);
    assert.equal(M.dustLimit(s), dust);
  }
  for (const s of ["", "6a", "5121" + "11".repeat(32), "0014" + "11".repeat(19), "5120" + "11".repeat(33), "0020" + "11".repeat(20), "76a914" + "11".repeat(20) + "88ad"]) {
    assert.equal(M.isStandardScript(unhex(s)), null, s);
  }
  assert.deepEqual([...P.STANDARD_SCRIPTS], ["p2pkh", "p2sh", "p2wpkh", "p2wsh", "p2tr"]);
});

// ---------------------------------------------------------------- params, activations

test("params: the platform fee constants, the platform address decodes to platformScript, MINING_HEIGHT is the pinned 325138", () => {
  const f = P.MINE_FEES.signet;
  assert.equal(P.MINE_FEE, f);
  assert.equal(P.NETWORK, "signet");
  assert.equal(f.platformSats, 500n);
  assert.equal(f.deployerMinSats, 0n);
  assert.equal(f.deployerMaxSats, 0n);
  assert.equal(f.platformScript, "51203084846915ba86451221466028377de3bcf2ad8dc19ab8137684407dba6a9bab");
  assert.match(f.platformAddress, /^tb1p[02-9ac-hj-np-z]{58}$/);
  const decoded = btc.OutScript.encode(btc.Address(btc.TEST_NETWORK).decode(f.platformAddress));
  assert.equal(hex(decoded), f.platformScript);
  assert.equal(M.isStandardScript(f.platformScript), "p2tr");
  assert.ok(f.platformSats >= M.dustLimit(f.platformScript), "500 sats clears the P2TR dust limit (D2)");
  assert.equal(P.FEE_MIN_SATS, 546n);
  assert.doesNotThrow(() => M.assertMineFee(P.MINE_FEE));
  assert.throws(() => M.assertMineFee(null), /mining activation needs MINE_FEE for this network/);
  assert.throws(() => M.assertMineFee({ ...f, platformSats: 329n }), /dust/);
  assert.throws(() => M.assertMineFee({ ...f, platformScript: "6a" }), /standard/);
  assert.ok(Object.isFrozen(P.MINE_FEES) && Object.isFrozen(f));
  // The segwit encoder agrees with @scure/btc-signer for v0 and v1 programs.
  for (const s of ["0014" + "22".repeat(20), "0020" + "33".repeat(32), "5120" + "44".repeat(32)]) {
    assert.equal(P.segwitAddress("tb", s), btc.Address(btc.TEST_NETWORK).encode(btc.OutScript.decode(unhex(s))));
  }

  assert.equal(P.MINE_WINDOW, 12);
  assert.equal(P.MIN_DIFFICULTY, 256n);
  assert.equal(P.MINE_LEAD, undefined, "no mandatory lead (owner decision 2026-10-06)");
  assert.deepEqual([P.SPAN_MIN, P.SPAN_MAX, P.MIN_SPAN_CLAIMS, P.MAX_PER_BLOCK, P.MINE_SLACK], [12, 432, 16, 100, 2]);
  assert.equal(P.MINE_SALT_TEXT, "murkle/mine/salt");
  assert.equal(P.LABELS.btcMineFee, "murkle/btc-mine-fee");
  assert.equal(P.LABELS.digest, "murkle/digest/v1", "unchanged");
  assert.equal(P.digestTag(1), P.LABELS.digest);
  assert.equal(P.digestTag(2), "murkle/digest/v2");
  assert.equal(P.DIGEST_V, 2);
  assert.equal(P.SNAPSHOT_VERSION, 3);

  // The owner pinned the mining activation height (2026-10-06): consensus, changed only by a release.
  const pinned = [{ name: "mining", height: 325_138, digestV: 2 }];
  const pins = JSON.parse(read("../src/pins.json"));
  assert.deepEqual(pins.activations, pinned);
  assert.deepEqual(P.ACTIVATIONS.map((a) => ({ ...a })), pinned);
  assert.equal(P.MINING_HEIGHT, 325_138);
  assert.equal(P.activationHeight("mining"), 325_138);
  assert.ok(P.MINING_HEIGHT > P.ACTIVATION_HEIGHT, "above the genesis activation height");
  assert.doesNotThrow(() => M.assertActivations(P.ACTIVATIONS));
  assert.doesNotThrow(() => M.assertActivations(P.ACTIVATIONS, { genesisHeight: P.GENESIS.height }));
  assert.equal(P.digestVersionAt(P.ACTIVATION_HEIGHT), 1, "digest v1 from genesis ...");
  assert.equal(P.digestVersionAt(325_137), 1, "... up to the block before the activation");
  assert.equal(P.digestVersionAt(325_138), 2, "digest v2 exactly at the activation height");
  assert.equal(P.digestVersionAt(10 ** 9), 2);
});

test("activation table: digestVersionAt and assertActivations", () => {
  const t = [{ name: "mining", height: 400_000, digestV: 2 }, { name: "batch", height: 450_000, digestV: 3 }];
  assert.equal(P.digestVersionAt(399_999, t), 1);
  assert.equal(P.digestVersionAt(400_000, t), 2);
  assert.equal(P.digestVersionAt(449_999, t), 2);
  assert.equal(P.digestVersionAt(450_000, t), 3);
  assert.equal(P.activationHeight("batch", t), 450_000);
  assert.equal(P.activationHeight("nope", t), null);
  assert.equal(P.digestVersionAt(500_000, [{ name: "mining", height: null, digestV: 2 }]), 1);
  assert.doesNotThrow(() => M.assertActivations(t));
  assert.doesNotThrow(() => M.assertActivations([{ name: "mining", height: null, digestV: 2 }, { name: "batch", height: 450_000, digestV: 3 }]));
  assert.throws(() => M.assertActivations([{ name: "mining", height: 400_000, digestV: 2 }, { name: "mining", height: 400_001, digestV: 3 }]), /twice/);
  assert.throws(() => M.assertActivations([{ name: "mining", height: 400_000, digestV: 3 }]), /digestV 2/);
  assert.throws(() => M.assertActivations([{ name: "mining", height: 450_000, digestV: 2 }, { name: "batch", height: 400_000, digestV: 3 }]), /below/);
  assert.throws(() => M.assertActivations([{ name: "mining", height: P.ACTIVATION_HEIGHT, digestV: 2 }]), /genesis/);
  assert.throws(() => M.assertActivations([{ name: "mining", height: 1.5, digestV: 2 }]), /integer/);
});

// ---------------------------------------------------------------- non-consensus helpers

test("launch helpers: defaults, suggested difficulty and floor, low-floor flag, hashrate estimate, difficulty series", () => {
  const L = M.LAUNCH_DEFAULTS;
  assert.deepEqual({ ...L }, { span: 24, perBlock: 1, launchHashrate: 2000, floorDivisor: 16, browserThreadHs: 250, lowFloorRatio: 1000, halvingInterval: 0, claimFeeSats: 0n, start: "now", startAfter: 144 });
  // The two start choices: now -> 0 (the deploy block); after N -> tip + 1 + N.
  assert.equal(M.startHeightFor({ start: "now" }), 0);
  assert.equal(M.startHeightFor({ start: "now", after: 10, tip: 500 }), 0, "now ignores the count");
  assert.equal(M.startHeightFor({ start: "after", after: 10, tip: 500 }), 511);
  assert.equal(M.startHeightFor({ start: "after", after: 1, tip: 0 }), 2);
  assert.equal(M.mineStartOf({ deployHeight: 501, startHeight: M.startHeightFor({ start: "after", after: 10, tip: 500 }) }), 511, "10 blocks after a launch in the next block");
  assert.equal(M.mineStartOf({ deployHeight: 520, startHeight: 511 }), 520, "a launch that confirms after the start block opens at its own block");
  for (const [o, re] of [
    [{ start: "later" }, /now.*after/], [{ start: "after", after: 0, tip: 5 }, /at least 1/], [{ start: "after", after: 1.5, tip: 5 }, /whole number/],
    [{ start: "after", after: -3, tip: 5 }, /at least 1/], [{ start: "after", after: 5 }, /height is not known/], [{ start: "after", after: 5, tip: 2 ** 32 - 3 }, /past 4294967295/],
  ]) assert.throws(() => M.startHeightFor(o), re, JSON.stringify(o));
  assert.equal(M.suggestInitialDifficulty({ hashrate: 2000, span: 24, targetPerSpan: 24 }), 1_200_000n, "2,000 H/s x 600 s per claim");
  assert.equal(M.suggestInitialDifficulty({ hashrate: 0.1, span: 24, targetPerSpan: 24 }), 256n);
  assert.equal(M.suggestInitialDifficulty({ hashrate: 1e30, span: 24, targetPerSpan: 24 }), P.D_MAX);
  assert.equal(M.suggestFloor(1_200_000n), 75_000n);
  assert.equal(M.suggestFloor(1000n), 256n);
  const honest = assetOf({ initialDifficulty: 1_200_000n, minDifficulty: 75_000n });
  assert.equal(M.lowFloor(honest, 2000), false);
  assert.equal(M.lowFloor(assetOf({ initialDifficulty: 1_200_000n, minDifficulty: 256n }), 2000), true, "floor far below a browser launch");
  assert.equal(M.lowFloor(assetOf({ initialDifficulty: 256n, minDifficulty: 256n }), 0), false, "256 x 1000 >= one browser thread's 150,000");
  assert.equal(M.floorEmission(assetOf({ minDifficulty: 600n }), 1000), 1000);
  assert.equal(M.floorEmission(assetOf({ minDifficulty: 256n }), 1e9), 1700);

  const entries = [
    { op: 7, ok: true, asset: "7", height: 1150, difficulty: "1000000" },
    { op: 8, ok: true, asset: "7", height: 1150, difficulty: "1000000" },
    { op: 7, ok: false, asset: "7", height: 1151, reason: "insufficient work" },
    { op: 7, ok: true, asset: "7", height: 1160, difficulty: "2000000" },
    { op: 7, ok: true, asset: "8", height: 1160, difficulty: "5" },
    { op: 3, ok: true, asset: "7", height: 1160, amount: "1" },
  ];
  assert.equal(M.hashrateEstimate(entries, 1200), 4_000_005 / 86400);
  assert.equal(M.hashrateEstimate(entries, 1150 + 144), 2_000_005 / 86400, "only the last 144 blocks");
  const series = M.difficultySeries(assetOf(), entries, { from: 1144, to: 1165 });
  const a = assetOf();
  const works = new Map([[1150, 2_000_000n], [1160, 2_000_000n]]);
  let d = 1_000_000n;
  const want = [[1144, d]];
  for (let h = 1145; h <= 1165; h++) { d = M.stepDifficulty(d, works.get(h) ?? 0n, a); want.push([h, d]); }
  assert.deepEqual(series, want);
  // Lazy evaluation over stored points equals the eager series rebuilt from the log.
  const pts = [[1144, 1_000_000n], [1150, want.find(([h]) => h === 1150)[1]], [1160, want.find(([h]) => h === 1160)[1]]];
  for (const [h, D] of want) assert.equal(M.difficultyAt(assetOf({ dPts: pts }), h), D, `h ${h}`);
});

test("src/mine.mjs and src/pow-pool.mjs stay isomorphic: allowed imports only, hash-wasm loaded lazily, no node: at the top", () => {
  const mine = read("../src/mine.mjs");
  const imports = [...mine.matchAll(/^import [^;]*? from "([^"]+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./bytes.mjs", "./params.mjs", "@noble/hashes/argon2", "@noble/hashes/sha256"]);
  assert.match(mine, /import\("hash-wasm"\)/);
  assert.doesNotMatch(mine, /from "[^"]*(envelope|indexer|core)\.mjs"|from "snarkjs"|import\("(node:|snarkjs)/);
  const pool = read("../src/pow-pool.mjs");
  assert.doesNotMatch(pool.split("\n").filter((l) => l.startsWith("import ")).join("\n"), /node:/);
  for (const f of ["../src/mine.mjs", "../src/pow-pool.mjs", "../src/pow-worker.mjs", "./fixtures/mine-vectors.json"]) {
    const b = read(f);
    assert.ok(!b.includes("\r"), `${f}: LF`);
    assert.ok(b.endsWith("\n"), `${f}: final newline`);
    assert.ok(!CYRILLIC.test(b), `${f}: English only`);
  }
  const pkg = JSON.parse(read("../package.json"));
  assert.equal(pkg.dependencies["hash-wasm"], "4.12.0");
  assert.equal(pkg.dependencies["@noble/hashes"], "1.8.0");
  const lock = JSON.parse(read("../package-lock.json"));
  assert.equal(lock.packages[""].dependencies["hash-wasm"], "4.12.0");
  assert.equal(lock.packages["node_modules/hash-wasm"].version, "4.12.0");
  assert.equal(lock.packages["node_modules/@noble/hashes"].version, "1.8.0");
  assert.match(read("../THIRD_PARTY_NOTICES.md"), /hash-wasm/);
});

/* ---------------------------------------------------------------- fix round (mining review) */

test("difficultyAt memoizes the quiet decay per point: same values as the plain loop in any call order, and 1,700 claims after a long quiet stretch at span 432 cost milliseconds", () => {
  // The plain loop (the consensus definition), uncached.
  const plain = (asset, h) => {
    if (h <= asset.mineStart) return asset.initialDifficulty;
    const pts = asset.dPts;
    let i = pts.length - 1;
    while (i >= 0 && pts[i][0] > h) i--;
    let [ph, d] = pts[i];
    const t = { span: asset.span, targetPerSpan: asset.targetPerSpan, minDifficulty: asset.minDifficulty };
    for (let x = ph + 1; x <= h && d > asset.minDifficulty; x++) d = M.stepDifficulty(d, 0n, t);
    return d;
  };
  const a = assetOf({ span: 432, targetPerSpan: 432, initialDifficulty: P.D_MAX, minDifficulty: 256n, dPts: [[1144, P.D_MAX]] });
  const heights = [1144 + 9000, 1144 + 5, 1144 + 9000, 1144 + 20_000, 1144 + 8999, 1144 + 3, 1144 + 30_000, 1145, 1144];
  for (const h of heights) assert.equal(M.difficultyAt(a, h), plain(a, h), `h = ${h}`);
  // A new point (end of block) is a new memo; the old point's values stay right for heights before it.
  a.dPts.push([1144 + 20_001, 5_000_000n]);
  for (const h of [1144 + 20_000, 1144 + 20_001, 1144 + 20_050, 1144 + 9000]) assert.equal(M.difficultyAt(a, h), plain(a, h), `h = ${h} after a new point`);
  // Terms changed on the same point (a test or a restore reusing the pair): never a stale value.
  const b = assetOf({ dPts: a.dPts, span: 12, targetPerSpan: 16, minDifficulty: 1000n });
  assert.equal(M.difficultyAt(b, 1144 + 20_060), plain(b, 1144 + 20_060));

  // 1,700 claims in one block after ~16,000 quiet blocks: two difficultyAt per claim.
  const quiet = assetOf({ span: 432, targetPerSpan: 432, initialDifficulty: P.D_MAX, minDifficulty: 256n, dPts: [[1144, P.D_MAX]] });
  const H = 1144 + 16_000;
  const t0 = performance.now();
  for (let i = 0; i < 1700; i++) M.effectiveDifficulty(quiet, H - 1 - (i % 12), H);
  const ms = performance.now() - t0;
  assert.ok(ms < 1500, `1,700 claims took ${Math.round(ms)} ms`);
  assert.equal(M.effectiveDifficulty(quiet, H - 5, H), (() => {
    const r = plain(quiet, H - 5);
    const s = plain(quiet, H - 1) / 4n;
    return r > s ? r : s;
  })());
});

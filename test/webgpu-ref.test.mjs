// The pure-JS model of the WebGPU kernel (src/webgpu/ref64.mjs) against independent oracles:
// BigInt for every emulated 64-bit step, @noble/hashes for BLAKE2b, the existing Argon2 vectors for the
// whole hash, and the lane schedule of the kernel (registers, padded workgroup array, four barrier
// phases) against the plain RFC 9106 layout plus a hazard check of the barrier placement.
// Pure JS, no GPU, runs everywhere in a few seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";
import { sha256 } from "@noble/hashes/sha256";
import { hex, unhex } from "../src/bytes.mjs";
import { GPU_SELF_TEST_VECTORS } from "../src/gpu-gate.mjs";
import { SELF_TEST_VECTORS, powHashReference } from "../src/mine.mjs";
import * as R from "../src/webgpu/ref64.mjs";

const M64 = (1n << 64n) - 1n;
const M32 = (1n << 32n) - 1n;

/** mulberry32: a seeded generator of u32 numbers. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0);
  };
}
const rand64 = (next) => (BigInt(next()) << 32n) | BigInt(next());
const randBlock = (next) => Array.from({ length: 128 }, () => R.pairOf(rand64(next)));
const randBytes = (next, n) => Uint8Array.from({ length: n }, () => next() & 0xff);

const EDGES64 = [0n, 1n, 2n, 1n << 31n, M32, 1n << 32n, 1n << 63n, M64, 0xffffffff00000000n, 0x00000000ffffffffn];
const EDGES32 = [0, 1, 2, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0xfffe0001];

// BigInt oracles
const rotrB = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M64;
const fblaB = (x, y) => (x + y + 2n * (x & M32) * (y & M32)) & M64;
function gbB(a, b, c, d) {
  a = fblaB(a, b);
  d = rotrB(d ^ a, 32);
  c = fblaB(c, d);
  b = rotrB(b ^ c, 24);
  a = fblaB(a, b);
  d = rotrB(d ^ a, 16);
  c = fblaB(c, d);
  b = rotrB(b ^ c, 63);
  return [a, b, c, d];
}

test("every emulated 64-bit step equals BigInt: edge values in every combination", () => {
  for (const x of EDGES64) {
    const px = R.pairOf(x);
    assert.equal(R.bigOf(R.rotr32(px)), rotrB(x, 32));
    assert.equal(R.bigOf(R.rotr24(px)), rotrB(x, 24));
    assert.equal(R.bigOf(R.rotr16(px)), rotrB(x, 16));
    assert.equal(R.bigOf(R.rotr63(px)), rotrB(x, 63));
    for (const y of EDGES64) {
      const py = R.pairOf(y);
      assert.equal(R.bigOf(R.add64(px, py)), (x + y) & M64, `add64 ${x} ${y}`);
      assert.equal(R.bigOf(R.xor64(px, py)), x ^ y);
      assert.equal(R.bigOf(R.fbla(px, py)), fblaB(x, y), `fbla ${x} ${y}`);
      for (const z of [0n, M64, 0x8000000080000000n]) {
        const [a, b, c, d] = gbB(x, y, z, x ^ y);
        const r = R.a2_gb(px, py, R.pairOf(z), R.pairOf(x ^ y));
        assert.deepEqual([R.bigOf(r.a), R.bigOf(r.b), R.bigOf(r.c), R.bigOf(r.d)], [a, b, c, d], `a2_gb ${x} ${y} ${z}`);
      }
    }
  }
  for (const a of EDGES32) {
    for (const b of EDGES32) {
      const want = BigInt(a) * BigInt(b);
      const got = R.mul32wide(a, b);
      assert.equal(R.bigOf(got), want, `mul32wide ${a} ${b}`);
      assert.equal(R.mulhi32(a, b), Number(want >> 32n));
    }
  }
});

test("every emulated 64-bit step equals BigInt: 100,000 seeded random cases", () => {
  const next = rng(0xa11ce);
  for (let i = 0; i < 100_000; i++) {
    const x = rand64(next);
    const y = rand64(next);
    const px = R.pairOf(x);
    const py = R.pairOf(y);
    if (R.bigOf(R.add64(px, py)) !== ((x + y) & M64)) assert.fail(`add64 ${x} ${y}`);
    if (R.bigOf(R.xor64(px, py)) !== (x ^ y)) assert.fail(`xor64 ${x} ${y}`);
    if (R.bigOf(R.rotr32(px)) !== rotrB(x, 32)) assert.fail(`rotr32 ${x}`);
    if (R.bigOf(R.rotr24(px)) !== rotrB(x, 24)) assert.fail(`rotr24 ${x}`);
    if (R.bigOf(R.rotr16(px)) !== rotrB(x, 16)) assert.fail(`rotr16 ${x}`);
    if (R.bigOf(R.rotr63(px)) !== rotrB(x, 63)) assert.fail(`rotr63 ${x}`);
    const a = Number(x & M32);
    const b = Number(y & M32);
    if (R.bigOf(R.mul32wide(a, b)) !== BigInt(a) * BigInt(b)) assert.fail(`mul32wide ${a} ${b}`);
    if (R.bigOf(R.fbla(px, py)) !== fblaB(x, y)) assert.fail(`fbla ${x} ${y}`);
    if (i % 4 === 0) {
      const z = rand64(next);
      const w = rand64(next);
      const want = gbB(x, y, z, w);
      const r = R.a2_gb(px, py, R.pairOf(z), R.pairOf(w));
      const got = [R.bigOf(r.a), R.bigOf(r.b), R.bigOf(r.c), R.bigOf(r.d)];
      if (got.some((v, k) => v !== want[k])) assert.fail(`a2_gb ${x} ${y} ${z} ${w}`);
    }
  }
});

test("a2_ref_of equals the BigInt formula of RFC 9106 section 3.4.2 (one pass, one lane)", () => {
  const next = rng(77);
  for (let i = 0; i < 20_000; i++) {
    const index = 2 + (next() % 4094);
    const j1 = next();
    const area = BigInt(index - 1);
    const x = (BigInt(j1) * BigInt(j1)) >> 32n;
    const y = (area * x) >> 32n;
    assert.equal(R.a2_ref_of(index, j1), Number(area - 1n - y), `index ${index} j1 ${j1}`);
  }
  // edges: the first reference of each region and the extreme J1 values
  for (const index of [2, 3, 4, 2047, 2048, 4095]) for (const j1 of [0, 1, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff]) {
    const area = BigInt(index - 1);
    const y = (area * ((BigInt(j1) * BigInt(j1)) >> 32n)) >> 32n;
    assert.equal(R.a2_ref_of(index, j1), Number(area - 1n - y));
    assert.ok(R.a2_ref_of(index, j1) >= 0 && R.a2_ref_of(index, j1) <= index - 2);
  }
});

// ---------------------------------------------------------------- BLAKE2b

/** BLAKE2b with outlen bytes of any message, driven only by ref64's b2_init / b2_compress. */
function blake2bWithRef(msg, outlen) {
  const h = R.b2_init(outlen);
  const blocks = Math.max(1, Math.ceil(msg.length / 128));
  for (let b = 0; b < blocks; b++) {
    const chunk = new Uint8Array(128);
    chunk.set(msg.subarray(b * 128, Math.min(msg.length, b * 128 + 128)));
    const m = [];
    for (let j = 0; j < 16; j++) {
      const dv = new DataView(chunk.buffer);
      m.push({ lo: dv.getUint32(8 * j, true), hi: dv.getUint32(8 * j + 4, true) });
    }
    const last = b === blocks - 1;
    R.b2_compress(h, m, last ? msg.length : (b + 1) * 128, last);
  }
  const out = new Uint8Array(64);
  const dv = new DataView(out.buffer);
  h.forEach((p, i) => {
    dv.setUint32(8 * i, p.lo, true);
    dv.setUint32(8 * i + 4, p.hi, true);
  });
  return out.subarray(0, outlen);
}

test("b2_compress: BLAKE2b-256(\"abc\") known answer, and k_kat's model", () => {
  const want = "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319";
  assert.equal(hex(R.b2_kat()), want);
  assert.equal(hex(blake2bWithRef(new TextEncoder().encode("abc"), 32)), want);
});

test("b2_compress: BLAKE2b-512 and -256 of 0, 1, 127, 128, 129, 255, 256 and 1028 random bytes equal @noble/hashes", () => {
  const next = rng(31337);
  for (const len of [0, 1, 127, 128, 129, 255, 256, 1028]) {
    const msg = randBytes(next, len);
    assert.equal(hex(blake2bWithRef(msg, 64)), hex(blake2b(msg, { dkLen: 64 })), `512 over ${len} bytes`);
    assert.equal(hex(blake2bWithRef(msg, 32)), hex(blake2b(msg, { dkLen: 32 })), `256 over ${len} bytes`);
  }
});

// RFC 9106 H0 and H' written with noble's blake2b (an independent BLAKE2b), the oracle for a2_h0 / a2_hprime_1024
const le32 = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
const cat = (...parts) => {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const SALT = new TextEncoder().encode("murkle/mine/salt");
const h0Oracle = (pw) => blake2b(cat(le32(1), le32(32), le32(4096), le32(1), le32(0x13), le32(2), le32(40), pw, le32(16), SALT, le32(0), le32(0)), { dkLen: 64 });
function hprimeOracle(h0, j) {
  const X = cat(h0, le32(j), le32(0));
  let v = blake2b(cat(le32(1024), X), { dkLen: 64 });
  const out = [v.subarray(0, 32)];
  for (let i = 2; i <= 30; i++) {
    v = blake2b(v, { dkLen: 64 });
    out.push(v.subarray(0, 32));
  }
  v = blake2b(v, { dkLen: 64 });
  out.push(v);
  return cat(...out);
}
const bytesOfPairs = (pairs) => {
  const out = new Uint8Array(pairs.length * 8);
  const dv = new DataView(out.buffer);
  pairs.forEach((p, i) => {
    dv.setUint32(8 * i, p.lo, true);
    dv.setUint32(8 * i + 4, p.hi, true);
  });
  return out;
};

test("a2_h0 and a2_hprime_1024 equal RFC 9106 (H0 and H' built from noble's BLAKE2b) for 3 random passwords", () => {
  const next = rng(9106);
  for (let i = 0; i < 3; i++) {
    const pw = randBytes(next, 40);
    const h0 = R.a2_h0(R.pwWords(pw));
    const want0 = h0Oracle(pw);
    assert.equal(hex(bytesOfPairs(h0)), hex(want0));
    for (const j of [0, 1]) {
      const got = bytesOfPairs(R.a2_hprime_1024(h0, j));
      assert.equal(got.length, 1024);
      assert.equal(hex(got), hex(hprimeOracle(want0, j)), `H' for j = ${j}`);
    }
  }
});

// ---------------------------------------------------------------- the permutation and the lane schedule

// RFC 9106 permutation P written with BigInt, on the plain layout
function mixBlockOracle(R128) {
  const x = R128.map(R.bigOf);
  const Q = x.slice();
  const perm = (v) => {
    for (const [ia, ib, ic, id] of [[0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15], [0, 5, 10, 15], [1, 6, 11, 12], [2, 7, 8, 13], [3, 4, 9, 14]]) {
      [v[ia], v[ib], v[ic], v[id]] = gbB(v[ia], v[ib], v[ic], v[id]);
    }
  };
  for (let r = 0; r < 8; r++) {
    const v = Q.slice(16 * r, 16 * r + 16);
    perm(v);
    for (let k = 0; k < 16; k++) Q[16 * r + k] = v[k];
  }
  for (let c = 0; c < 8; c++) {
    const idx = [];
    for (let r = 0; r < 8; r++) idx.push(16 * r + 2 * c, 16 * r + 2 * c + 1);
    const v = idx.map((i) => Q[i]);
    perm(v);
    idx.forEach((i, k) => (Q[i] = v[k]));
  }
  return Q.map((q, i) => q ^ x[i]);
}

test("mixBlock equals the BigInt permutation of RFC 9106 on random blocks", () => {
  const next = rng(5);
  for (let i = 0; i < 20; i++) {
    const blk = randBlock(next);
    assert.deepEqual(R.mixBlock(blk).map(R.bigOf), mixBlockOracle(blk));
  }
});

test("mixBlockLanes(R) equals mixBlock(R) on 1,000 seeded random blocks (lane order identity)", () => {
  const next = rng(1234);
  for (let i = 0; i < 1000; i++) {
    const blk = randBlock(next);
    const lanes = R.mixBlockLanes(blk, { parity: i & 1 });
    const want = R.mixBlock(blk);
    for (let w = 0; w < 128; w++) if (lanes.out[w].lo !== want[w].lo || lanes.out[w].hi !== want[w].hi) assert.fail(`block ${i} word ${w}`);
    assert.equal(lanes.j1, want[0].lo, "every lane reads J1 = low half of word 0 of the new block");
  }
});

test("mixBlockLanes does not depend on the order in which the lanes of a phase run (reversed and shuffled)", () => {
  const next = rng(4321);
  for (let i = 0; i < 60; i++) {
    const blk = randBlock(next);
    const want = R.mixBlock(blk);
    const reversed = Array.from({ length: 32 }, (_, k) => 31 - k);
    const shuffled = Array.from({ length: 32 }, (_, k) => k);
    for (let k = 31; k > 0; k--) {
      const j = next() % (k + 1);
      [shuffled[k], shuffled[j]] = [shuffled[j], shuffled[k]];
    }
    for (const order of [reversed, shuffled]) {
      const got = R.mixBlockLanes(blk, { order, parity: i & 1 }).out;
      assert.deepEqual(got.map(R.bigOf), want.map(R.bigOf));
    }
  }
});

test("hazard checker: over fillLanes with 3 blocks, no address is written by one lane and touched by another within a barrier interval", () => {
  const next = rng(99);
  const prev = randBlock(next);
  const refs = [randBlock(next), randBlock(next), randBlock(next)];
  const c = R.hazardChecker();
  const outs = R.fillLanes(prev, refs, { onAccess: c.onAccess });
  assert.deepEqual(c.hazards(), []);
  // and the blocks are the plain-layout chain
  let p = prev;
  refs.forEach((ref, i) => {
    p = R.mixBlock(p.map((x, w) => R.xor64(x, ref[w])));
    assert.deepEqual(outs[i].map(R.bigOf), p.map(R.bigOf));
  });
  // the checker saw real traffic: 5 interval ids per block pair, S addresses and both R0 slots
  const phases = [...c.accesses().keys()].sort((a, b) => a - b);
  assert.deepEqual(phases, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const addrs = new Set();
  for (const m of c.accesses().values()) for (const a of m.keys()) addrs.add(a);
  assert.ok(addrs.has(R.R0_ADDR) && addrs.has(R.R0_ADDR + 1), "both R0 parity slots are used");
  assert.equal(Math.max(...addrs), R.R0_ADDR + 1);
  assert.ok([...addrs].filter((a) => a < R.S_WORDS).length === 128, "128 distinct padded S positions are used");
});

test("hazard checker: it flags a missing barrier (a synthetic conflict), also across the block back edge", () => {
  const c = R.hazardChecker();
  c.onAccess(2, 0, "write", 10);
  c.onAccess(2, 1, "read", 10);
  assert.equal(c.hazards().length, 1);
  const same = R.hazardChecker();
  same.onAccess(2, 3, "write", 10);
  same.onAccess(2, 3, "read", 10);
  same.onAccess(3, 4, "read", 10);
  assert.deepEqual(same.hazards(), [], "one lane touching its own address is fine, and a different interval is fine");
  // phase 4 of block 0 and phase 0 of block 1 are the same interval: phaseBase 4 for block 1
  const back = R.hazardChecker();
  back.onAccess(4, 5, "read", 20); // block 0, after its last barrier
  back.onAccess(0 + 4, 6, "write", 20); // block 1, before its first barrier
  assert.equal(back.hazards().length, 1);
});

test("a lane that reads before the barrier gets nothing: removing a barrier would show as a hazard (the unrotated variant)", () => {
  // Without the B1 barrier the second step would read positions other lanes write in the same interval.
  // Model it by reporting phase 0 for the rotated reads of a block: the checker must flag it.
  const c = R.hazardChecker();
  const next = rng(3);
  R.mixBlockLanes(randBlock(next), {
    onAccess: (phase, lane, kind, addr) => c.onAccess(phase === 1 ? 0 : phase, lane, kind, addr),
  });
  assert.ok(c.hazards().length > 0);
});

// ---------------------------------------------------------------- the reference table and whole hashes

test("refTable(): shape, range, and the sha256 of its bytes is pinned", () => {
  const t = R.refTable();
  assert.equal(t.length, 2048);
  for (let i = 2; i < 2048; i++) assert.ok(t[i] >= 0 && t[i] <= i - 2, `entry ${i} = ${t[i]}`);
  assert.equal(t[2], 0);
  assert.equal(hex(sha256(new Uint8Array(t.buffer, t.byteOffset, t.byteLength))), "138b02838929da9ab8c12673adb79549be528f7d079d9456ed27d769ed51108d");
});

const FORTY = SELF_TEST_VECTORS.filter((v) => !v.salt && v.password.length === 80);
const ALL_VECTORS = [...FORTY, ...GPU_SELF_TEST_VECTORS];

test("argon2idRef equals powHash for the 4 forty-byte SELF_TEST vectors and the 16 GPU vectors", () => {
  assert.equal(FORTY.length, 4);
  assert.equal(ALL_VECTORS.length, 20);
  for (const v of ALL_VECTORS) {
    assert.equal(hex(R.argon2idRef(unhex(v.password))), v.powHash, v.name);
  }
});

test("argon2idRef equals the noble reference on random passwords", () => {
  const next = rng(2026);
  for (let i = 0; i < 3; i++) {
    const pw = randBytes(next, 40);
    assert.equal(hex(R.argon2idRef(pw)), hex(powHashReference(pw)));
  }
});

test("the lane model hashes whole passwords, also with the fill split into segments at any block index", () => {
  const cutsList = [[], [3], [2047], [2048], [1000, 2047, 2049, 4000], [4095], [2, 5, 11, 100, 3000]].map((c) => c.filter((x) => x > 2));
  const vectors = [ALL_VECTORS[0], ALL_VECTORS[4], ALL_VECTORS[7]];
  cutsList.forEach((cuts, i) => {
    const v = vectors[i % vectors.length];
    assert.equal(hex(R.argon2idLanes(unhex(v.password), cuts)), v.powHash, `${v.name} cut at ${cuts.join(",") || "nothing"}`);
  });
});

test("hazard check over a fill segment that crosses the data-independent / data-dependent border at block 2048", () => {
  const v = ALL_VECTORS[2];
  const mem = R.initMemory(unhex(v.password));
  const table = R.refTable();
  R.fillModel(mem, 2, 2043, table); // plain progress up to block 2042
  const c = R.hazardChecker();
  R.fillModel(mem, 2043, 2055, table, { onAccess: c.onAccess });
  assert.deepEqual(c.hazards(), []);
  // the rest of the hash from there on still gives the right tag
  R.fillModel(mem, 2055, 4096, table);
  assert.equal(hex(R.finalTag(mem)), v.powHash);
});

test("k_prims model: expected outputs are the ref64 functions, and the first mismatch is named", () => {
  const words = R.primsInputs(64, 5);
  assert.equal(words.length, 64 * R.PRIMS_IN_WORDS);
  const want = R.primsExpected(words);
  assert.equal(want.length, 64 * R.PRIMS_OUT_PAIRS * 2);
  assert.equal(R.firstPrimsMismatch(want, want), null);
  const bad = want.slice();
  bad[3 * R.PRIMS_OUT_PAIRS * 2 + 5 * 2] ^= 1; // case 3, output 5 = mul32wide
  assert.deepEqual(R.firstPrimsMismatch(bad, want), { index: 3, primitive: "mul32wide" });
  for (let i = 0; i < 64; i++) {
    const o = i * R.PRIMS_IN_WORDS;
    assert.ok(words[o + 5] >= 2 && words[o + 5] <= 4095);
  }
});

test("ref64 has no BigInt except in its two test helpers, and no imports", () => {
  const text = readFileSync(new URL("../src/webgpu/ref64.mjs", import.meta.url), "utf8");
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .filter((l) => !/^export const (pairOf|bigOf) =/.test(l))
    .join("\n");
  assert.equal(/\bBigInt\b|\b\d+n\b/.test(code), false);
  assert.equal(/^\s*import\s/m.test(code), false);
});

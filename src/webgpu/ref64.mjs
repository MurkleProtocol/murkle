// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner prototype: the pure-JS model of the WGSL kernel (src/webgpu/argon2.wgsl.mjs).
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// The algorithm is RFC 9106 and the layout is the one of gpu/src/argon2.cuh (a hash is 32 lanes,
// four lanes share one 16-word permutation). This file exists for two reasons:
//
//   1. WGSL has no 64-bit integers. A 64-bit word is a pair { lo, hi } of 32-bit numbers (a
//      vec2<u32> in WGSL: .x is lo, .y is hi) and every 64-bit step is built from the operations
//      WGSL has: 32-bit + and * (mod 2^32), & | ^, shifts by constants 1 .. 31, and < for the carry.
//      No BigInt and no 64-bit arithmetic in here; the tests use BigInt as the oracle. Every
//      function below has a WGSL twin of the same name with the same statement order.
//   2. The kernel's schedule (registers, the padded workgroup array S, four barrier phases, the
//      quad rotations) is modelled by mixBlockLanes / fillLanes / fillModel so that it can be
//      proved on a CPU: lane results equal the plain RFC layout, and a hazard checker over the
//      reported memory accesses proves the barrier placement.
//
// Isomorphic (no imports).

const BLOCKS = 4096;
const BLOCK_WORDS = 128;
const INDEP_BLOCKS = 2048;
export const SLOT_U32 = BLOCKS * BLOCK_WORDS * 2; // u32 words of one hash's memory: 4 MiB

// ---------------------------------------------------------------- 64-bit pieces (pairs of u32)

/** { lo, hi } from two numbers (reduced mod 2^32). */
export const pair = (lo, hi) => ({ lo: lo >>> 0, hi: hi >>> 0 });
/** { lo, hi } from a BigInt below 2^64 (tests and constants only). */
export const pairOf = (v) => ({ lo: Number(BigInt(v) & 0xffffffffn), hi: Number((BigInt(v) >> 32n) & 0xffffffffn) });
/** The BigInt of a pair (tests only). */
export const bigOf = (p) => (BigInt(p.hi >>> 0) << 32n) | BigInt(p.lo >>> 0);

export function add64(a, b) {
  const lo = (a.lo + b.lo) >>> 0;
  const c = lo < a.lo ? 1 : 0;
  const hi = (a.hi + b.hi + c) >>> 0;
  return { lo, hi };
}

export function xor64(a, b) {
  return { lo: (a.lo ^ b.lo) >>> 0, hi: (a.hi ^ b.hi) >>> 0 };
}

export function rotr32(x) {
  return { lo: x.hi, hi: x.lo };
}

export function rotr24(x) {
  const lo = ((x.lo >>> 24) | (x.hi << 8)) >>> 0;
  const hi = ((x.hi >>> 24) | (x.lo << 8)) >>> 0;
  return { lo, hi };
}

export function rotr16(x) {
  const lo = ((x.lo >>> 16) | (x.hi << 16)) >>> 0;
  const hi = ((x.hi >>> 16) | (x.lo << 16)) >>> 0;
  return { lo, hi };
}

/** rotr 63 = rotl 1 */
export function rotr63(x) {
  const lo = ((x.lo << 1) | (x.hi >>> 31)) >>> 0;
  const hi = ((x.hi << 1) | (x.lo >>> 31)) >>> 0;
  return { lo, hi };
}

/** The full 64-bit product of two u32 numbers, from four 16-bit limb products. */
export function mul32wide(a, b) {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const p00 = Math.imul(a0, b0) >>> 0; // each product is below 2^32, so exact in u32
  const p01 = Math.imul(a0, b1) >>> 0;
  const p10 = Math.imul(a1, b0) >>> 0;
  const p11 = Math.imul(a1, b1) >>> 0;
  const mid = ((p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff)) >>> 0; // below 3 * 2^16
  const lo = ((p00 & 0xffff) | (mid << 16)) >>> 0;
  const hi = (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
  return { lo, hi };
}

export function mulhi32(a, b) {
  return mul32wide(a, b).hi;
}

/** fBlaMka: x + y + 2 * lo32(x) * lo32(y), mod 2^64 */
export function fbla(x, y) {
  const m = mul32wide(x.lo, y.lo);
  const m2 = { lo: (m.lo << 1) >>> 0, hi: ((m.hi << 1) | (m.lo >>> 31)) >>> 0 };
  return add64(add64(x, y), m2);
}

/** The Argon2 round function GB (RFC 9106 section 3.5): returns the new { a, b, c, d }. */
export function a2_gb(a0, b0, c0, d0) {
  let a = fbla(a0, b0);
  let d = rotr32(xor64(d0, a));
  let c = fbla(c0, d);
  let b = rotr24(xor64(b0, c));
  a = fbla(a, b);
  d = rotr16(xor64(d, a));
  c = fbla(c, d);
  b = rotr63(xor64(b, c));
  return { a, b, c, d };
}

// ---------------------------------------------------------------- BLAKE2b (RFC 7693)

// The initial values as { lo, hi } (hi first in the comment: 6a09e667 f3bcc908, ...).
export const B2_IV = [
  pair(0xf3bcc908, 0x6a09e667), pair(0x84caa73b, 0xbb67ae85), pair(0xfe94f82b, 0x3c6ef372), pair(0x5f1d36f1, 0xa54ff53a),
  pair(0xade682d1, 0x510e527f), pair(0x2b3e6c1f, 0x9b05688c), pair(0xfb41bd6b, 0x1f83d9ab), pair(0x137e2179, 0x5be0cd19),
];

// 12 rounds: the ten rows of RFC 7693, then rows 0 and 1 again.
export const B2_SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

/** BLAKE2b G with message words x, y: a = a + b + x, ...; returns the new { a, b, c, d }. */
export function b2_g(a0, b0, c0, d0, x, y) {
  let a = add64(add64(a0, b0), x);
  let d = rotr32(xor64(d0, a));
  let c = add64(c0, d);
  let b = rotr24(xor64(b0, c));
  a = add64(add64(a, b), y);
  d = rotr16(xor64(d, a));
  c = add64(c, d);
  b = rotr63(xor64(b, c));
  return { a, b, c, d };
}

/**
 * The compression function F. h: 8 pairs, updated in place; m: 16 pairs; t: bytes hashed so far
 * including this block (always below 2^32 here: at most 1028); last: the final block.
 */
export function b2_compress(h, m, t, last) {
  const v = [];
  for (let i = 0; i < 8; i++) v.push(h[i]);
  for (let i = 0; i < 8; i++) v.push(B2_IV[i]);
  v[12] = xor64(v[12], { lo: t >>> 0, hi: 0 });
  if (last) v[14] = xor64(v[14], { lo: 0xffffffff, hi: 0xffffffff });
  const step = (ia, ib, ic, id, x, y) => {
    const r = b2_g(v[ia], v[ib], v[ic], v[id], x, y);
    v[ia] = r.a;
    v[ib] = r.b;
    v[ic] = r.c;
    v[id] = r.d;
  };
  for (let r = 0; r < 12; r++) {
    const s = B2_SIGMA[r];
    step(0, 4, 8, 12, m[s[0]], m[s[1]]);
    step(1, 5, 9, 13, m[s[2]], m[s[3]]);
    step(2, 6, 10, 14, m[s[4]], m[s[5]]);
    step(3, 7, 11, 15, m[s[6]], m[s[7]]);
    step(0, 5, 10, 15, m[s[8]], m[s[9]]);
    step(1, 6, 11, 12, m[s[10]], m[s[11]]);
    step(2, 7, 8, 13, m[s[12]], m[s[13]]);
    step(3, 4, 9, 14, m[s[14]], m[s[15]]);
  }
  for (let i = 0; i < 8; i++) h[i] = xor64(h[i], xor64(v[i], v[i + 8]));
}

/** The initial state of an unkeyed BLAKE2b with outlen output bytes. */
export function b2_init(outlen) {
  const h = B2_IV.map((p) => ({ lo: p.lo, hi: p.hi }));
  h[0] = { lo: (h[0].lo ^ (0x01010000 | outlen)) >>> 0, hi: h[0].hi };
  return h;
}

/** BLAKE2b with outlen bytes of a message of len <= 128 bytes held in m (16 pairs): one compression. */
export function b2_hash1(m, len, outlen) {
  const h = b2_init(outlen);
  b2_compress(h, m, len, true);
  return h;
}

const le4 = (s) => (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0;

/**
 * H0 of Argon2id for MURK (p = 1, tag 32, m = 4096 KiB, t = 1, v = 0x13, y = 2, 40-byte password,
 * the 16-byte salt "murkle/mine/salt"): 96 bytes in, one compression. pw: Uint32Array(10), little-endian words.
 */
export function a2_h0(pw) {
  const w = new Array(24).fill(0);
  w[0] = 1;
  w[1] = 32;
  w[2] = 4096;
  w[3] = 1;
  w[4] = 0x13;
  w[5] = 2;
  w[6] = 40;
  for (let i = 0; i < 10; i++) w[7 + i] = pw[i] >>> 0;
  w[17] = 16;
  w[18] = le4("murk");
  w[19] = le4("le/m");
  w[20] = le4("ine/");
  w[21] = le4("salt");
  w[22] = 0;
  w[23] = 0;
  const m = [];
  for (let i = 0; i < 12; i++) m.push({ lo: w[2 * i], hi: w[2 * i + 1] });
  for (let i = 12; i < 16; i++) m.push({ lo: 0, hi: 0 });
  return b2_hash1(m, 96, 64);
}

/** H'1024(H0 || LE32 j || LE32 0) (RFC 9106 section 3.3): the 128 pairs of block j. */
export function a2_hprime_1024(h0, j) {
  const zero = () => ({ lo: 0, hi: 0 });
  const m = [];
  for (let k = 0; k < 16; k++) m.push(zero());
  m[0] = { lo: 1024, hi: h0[0].lo };
  for (let k = 1; k < 8; k++) m[k] = { lo: h0[k - 1].hi, hi: h0[k].lo };
  m[8] = { lo: h0[7].hi, hi: j >>> 0 };
  m[9] = zero();
  for (let k = 10; k < 16; k++) m[k] = zero();
  const out = new Array(128);
  let v = b2_hash1(m, 76, 64);
  for (let w = 0; w < 4; w++) out[w] = v[w];
  for (let i = 2; i <= 30; i++) {
    for (let k = 0; k < 8; k++) m[k] = v[k];
    for (let k = 8; k < 16; k++) m[k] = zero();
    v = b2_hash1(m, 64, 64);
    for (let w = 0; w < 4; w++) out[4 * (i - 1) + w] = v[w];
  }
  for (let k = 0; k < 8; k++) m[k] = v[k];
  for (let k = 8; k < 16; k++) m[k] = zero();
  v = b2_hash1(m, 64, 64);
  for (let w = 0; w < 8; w++) out[120 + w] = v[w];
  return out;
}

/**
 * The tag: BLAKE2b-256(LE32(32) || block), 1028 bytes, nine compressions (RFC 9106 section 3.3, T = 32).
 * blockWord(k) -> the u32 word k (0 .. 255) of the last block. -> Uint8Array(32)
 */
export function a2_final(blockWord) {
  const h = b2_init(32);
  for (let t = 0; t < 9; t++) {
    const m = [];
    for (let j = 0; j < 16; j++) {
      const lo = 32 * t + 2 * j;
      const hi = lo + 1;
      const wl = lo === 0 ? 32 : lo <= 256 ? blockWord(lo - 1) : 0;
      const wh = hi <= 256 ? blockWord(hi - 1) : 0;
      m.push({ lo: wl >>> 0, hi: wh >>> 0 });
    }
    b2_compress(h, m, t === 8 ? 1028 : 128 * (t + 1), t === 8);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    for (let b = 0; b < 4; b++) {
      out[8 * i + b] = (h[i].lo >>> (8 * b)) & 0xff;
      out[8 * i + 4 + b] = (h[i].hi >>> (8 * b)) & 0xff;
    }
  }
  return out;
}

/** BLAKE2b-256("abc"), as k_kat computes it. -> Uint8Array(32) */
export function b2_kat() {
  const m = [{ lo: 0x636261, hi: 0 }];
  for (let i = 1; i < 16; i++) m.push({ lo: 0, hi: 0 });
  const h = b2_hash1(m, 3, 32);
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    for (let b = 0; b < 4; b++) {
      out[8 * i + b] = (h[i].lo >>> (8 * b)) & 0xff;
      out[8 * i + 4 + b] = (h[i].hi >>> (8 * b)) & 0xff;
    }
  }
  return out;
}

// ---------------------------------------------------------------- Argon2 pieces

/** The block to read for block `index` (>= 2) from J1 (RFC 9106 section 3.4.2, one pass, one lane). */
export function a2_ref_of(index, j1) {
  const x = mulhi32(j1, j1);
  const y = mulhi32(index - 1, x);
  return index - 2 - y;
}

// One 16-word permutation P (RFC 9106 section 3.6) on v (16 pairs), in place.
const P_STEPS = [
  [0, 4, 8, 12], [1, 5, 9, 13], [2, 6, 10, 14], [3, 7, 11, 15],
  [0, 5, 10, 15], [1, 6, 11, 12], [2, 7, 8, 13], [3, 4, 9, 14],
];
function permP(v) {
  for (const [ia, ib, ic, id] of P_STEPS) {
    const r = a2_gb(v[ia], v[ib], v[ic], v[id]);
    v[ia] = r.a;
    v[ib] = r.b;
    v[ic] = r.c;
    v[id] = r.d;
  }
}

/**
 * G(0, R) in the plain RFC 9106 layout: R (128 pairs, word order) -> P_cols(P_rows(R)) xor R.
 * Row i of the 8 x 8 matrix of 16-byte registers is words 16i .. 16i+15; column i takes words
 * 16k + 2i and 16k + 2i + 1 for k = 0 .. 7.
 */
export function mixBlock(R) {
  const Q = R.slice();
  const v = new Array(16);
  for (let i = 0; i < 8; i++) {
    for (let k = 0; k < 16; k++) v[k] = Q[16 * i + k];
    permP(v);
    for (let k = 0; k < 16; k++) Q[16 * i + k] = v[k];
  }
  for (let i = 0; i < 8; i++) {
    for (let k = 0; k < 16; k++) v[k] = Q[16 * (k >> 1) + 2 * i + (k & 1)];
    permP(v);
    for (let k = 0; k < 16; k++) Q[16 * (k >> 1) + 2 * i + (k & 1)] = v[k];
  }
  return Q.map((p, w) => xor64(p, R[w]));
}

/** One address block of data-independent addressing (RFC 9106 section 3.4.1.2): G(0, G(0, Z)). */
export function addressBlock(s, counter) {
  const Z = [];
  for (let w = 0; w < 128; w++) Z.push({ lo: 0, hi: 0 });
  Z[2] = { lo: s, hi: 0 };
  Z[3] = { lo: BLOCKS, hi: 0 };
  Z[4] = { lo: 1, hi: 0 };
  Z[5] = { lo: 2, hi: 0 };
  Z[6] = { lo: counter, hi: 0 };
  return mixBlock(mixBlock(Z));
}

/**
 * For the 2046 blocks of slices 0 and 1 (indexes 2 .. 2047), which are addressed independently of the data,
 * the block to read. Same for every password. Entries 0 and 1 are unused (0). -> Uint32Array(2048)
 */
export function refTable() {
  const table = new Uint32Array(INDEP_BLOCKS);
  for (let s = 0; s < 2; s++) {
    let counter = 0;
    let addr = null;
    if (s === 0) addr = addressBlock(s, ++counter); // slice 0 starts at index 2: its first address block is made up front
    for (let i = s === 0 ? 2 : 0; i < BLOCKS / 4; i++) {
      if ((i & 127) === 0) addr = addressBlock(s, ++counter);
      const index = s * (BLOCKS / 4) + i;
      table[index] = a2_ref_of(index, addr[i & 127].lo);
    }
  }
  return table;
}

// ---------------------------------------------------------------- the whole hash, plain layout

const loadPair = (mem, blk, w) => ({ lo: mem[(blk * BLOCK_WORDS + w) * 2], hi: mem[(blk * BLOCK_WORDS + w) * 2 + 1] });
const storePair = (mem, blk, w, p) => {
  mem[(blk * BLOCK_WORDS + w) * 2] = p.lo;
  mem[(blk * BLOCK_WORDS + w) * 2 + 1] = p.hi;
};

/** The password as ten little-endian u32 words. */
export function pwWords(password) {
  if (!(password instanceof Uint8Array) || password.length !== 40) throw new TypeError("password must be 40 bytes");
  const out = new Uint32Array(10);
  for (let i = 0; i < 10; i++) out[i] = (password[4 * i] | (password[4 * i + 1] << 8) | (password[4 * i + 2] << 16) | (password[4 * i + 3] << 24)) >>> 0;
  return out;
}

/** k_init for one hash: blocks 0 and 1 of a fresh Uint32Array(SLOT_U32). */
export function initMemory(password) {
  const mem = new Uint32Array(SLOT_U32);
  const h0 = a2_h0(pwWords(password));
  for (let j = 0; j < 2; j++) {
    const blk = a2_hprime_1024(h0, j);
    for (let w = 0; w < 128; w++) storePair(mem, j, w, blk[w]);
  }
  return mem;
}

/** k_final for one hash. -> Uint8Array(32) */
export function finalTag(mem) {
  return a2_final((k) => mem[(BLOCKS - 1) * BLOCK_WORDS * 2 + k]);
}

let TABLE = null;
const sharedTable = () => (TABLE ??= refTable());

/** Argon2id for MURK built only from the functions above: 40-byte password -> 32-byte tag. */
export function argon2idRef(password, table = sharedTable()) {
  const mem = initMemory(password);
  for (let index = 2; index < BLOCKS; index++) {
    const ri = index < INDEP_BLOCKS ? table[index] : a2_ref_of(index, mem[(index - 1) * BLOCK_WORDS * 2]);
    const R = new Array(BLOCK_WORDS);
    for (let w = 0; w < BLOCK_WORDS; w++) R[w] = xor64(loadPair(mem, index - 1, w), loadPair(mem, ri, w));
    const out = mixBlock(R);
    for (let w = 0; w < BLOCK_WORDS; w++) storePair(mem, index, w, out[w]);
  }
  return finalTag(mem);
}

// ---------------------------------------------------------------- the kernel's lane schedule

/** Padded index into the workgroup array S: 8 pad words against bank conflicts. */
export const sidx = (w) => w + (w >> 4);
export const S_WORDS = 136;
/** Address of R0[parity] in the access reports (S has the addresses 0 .. 135). */
export const R0_ADDR = S_WORDS;

// Row layout: register m of lane (q, g) holds block word 16q + g + 4m.
export const wR = (lane, m) => 16 * (lane >> 2) + (lane & 3) + 4 * m;
// Positions for the quad exchange of the row round and of the column round (block word indexes).
const posR = (q, k, gp) => 16 * q + 4 * k + gp;
const posC = (q, k, gp) => 16 * (2 * k + (gp >> 1)) + 2 * q + (gp & 1);

/**
 * One block G(0, R) as the kernel does it: 32 lanes of one hash, lane = 4q + g, the permutation
 * exchanged through the padded workgroup array S and four barriers (B1 .. B4 of the kernel).
 * Lanes run one after another inside a phase; opts.order is the lane order (a permutation of 0 .. 31).
 *
 * R: 128 pairs in word order (= prev xor ref). Returns { out, j1, S, R0 }: out is the new block
 * (128 pairs in word order), j1 is the low half of its word 0 as every lane reads it (S[sidx(0)] xor R0[parity]).
 *
 * onAccess(phase, lane, kind, addr) is called for each read and write of workgroup memory
 * ("read" | "write"; addr is a position of S, or R0_ADDR + parity for R0). The phase is
 * phaseBase + 0 .. 4 : phase 0 is before B1, 1 between B1 and B2, 2 between B2 and B3, 3 between B3
 * and B4, 4 after B4. Phase 4 of one block and phase 0 of the next block (phaseBase + 4) are the
 * same barrier interval, which is why fillLanes passes phaseBase = 4 * blockNumber.
 */
export function mixBlockLanes(R, { onAccess = null, phaseBase = 0, parity = 0, order = null, S = null, R0 = null } = {}) {
  const mem = S ?? new Array(S_WORDS).fill(null);
  const r0 = R0 ?? [null, null];
  const lanes = order ?? Array.from({ length: 32 }, (_, i) => i);
  if (lanes.length !== 32 || new Set(lanes).size !== 32) throw new RangeError("order must be a permutation of 0 .. 31");
  const note = (phase, lane, kind, addr) => onAccess?.(phaseBase + phase, lane, kind, addr);
  const rd = (phase, lane, w) => {
    note(phase, lane, "read", sidx(w));
    const v = mem[sidx(w)];
    if (v === null) throw new Error(`lane ${lane} read S[${sidx(w)}] before it was written`);
    return v;
  };
  const wr = (phase, lane, w, v) => {
    note(phase, lane, "write", sidx(w));
    mem[sidx(w)] = v;
  };
  const reg = Array.from({ length: 32 }, () => ({ r: null, a: null, b: null, c: null, d: null }));
  // phase 0: R in registers, R0, the first GB, the row exchange out
  for (const lane of lanes) {
    const L = reg[lane];
    L.r = [0, 1, 2, 3].map((m) => R[wR(lane, m)]);
    if (lane === 0) {
      note(0, lane, "write", R0_ADDR + parity);
      r0[parity] = L.r[0];
    }
    const x = a2_gb(L.r[0], L.r[1], L.r[2], L.r[3]);
    L.a = x.a;
    L.b = x.b;
    L.c = x.c;
    L.d = x.d;
    const q = lane >> 2;
    const g = lane & 3;
    wr(0, lane, posR(q, 1, g), L.b);
    wr(0, lane, posR(q, 2, g), L.c);
    wr(0, lane, posR(q, 3, g), L.d);
  }
  // B1. phase 1: rotated read, diagonal GB, write back by address (un-rotated)
  for (const lane of lanes) {
    const L = reg[lane];
    const q = lane >> 2;
    const g = lane & 3;
    L.b = rd(1, lane, posR(q, 1, (g + 1) & 3));
    L.c = rd(1, lane, posR(q, 2, (g + 2) & 3));
    L.d = rd(1, lane, posR(q, 3, (g + 3) & 3));
    const x = a2_gb(L.a, L.b, L.c, L.d);
    L.a = x.a;
    L.b = x.b;
    L.c = x.c;
    L.d = x.d;
    wr(1, lane, posR(q, 0, g), L.a);
    wr(1, lane, posR(q, 1, (g + 1) & 3), L.b);
    wr(1, lane, posR(q, 2, (g + 2) & 3), L.c);
    wr(1, lane, posR(q, 3, (g + 3) & 3), L.d);
  }
  // B2. phase 2: column round, first GB
  for (const lane of lanes) {
    const L = reg[lane];
    const q = lane >> 2;
    const g = lane & 3;
    L.a = rd(2, lane, posC(q, 0, g));
    L.b = rd(2, lane, posC(q, 1, g));
    L.c = rd(2, lane, posC(q, 2, g));
    L.d = rd(2, lane, posC(q, 3, g));
    const x = a2_gb(L.a, L.b, L.c, L.d);
    L.a = x.a;
    L.b = x.b;
    L.c = x.c;
    L.d = x.d;
    wr(2, lane, posC(q, 1, g), L.b);
    wr(2, lane, posC(q, 2, g), L.c);
    wr(2, lane, posC(q, 3, g), L.d);
  }
  // B3. phase 3: rotated read, diagonal GB, write back by address
  for (const lane of lanes) {
    const L = reg[lane];
    const q = lane >> 2;
    const g = lane & 3;
    L.b = rd(3, lane, posC(q, 1, (g + 1) & 3));
    L.c = rd(3, lane, posC(q, 2, (g + 2) & 3));
    L.d = rd(3, lane, posC(q, 3, (g + 3) & 3));
    const x = a2_gb(L.a, L.b, L.c, L.d);
    L.a = x.a;
    L.b = x.b;
    L.c = x.c;
    L.d = x.d;
    wr(3, lane, posC(q, 0, g), L.a);
    wr(3, lane, posC(q, 1, (g + 1) & 3), L.b);
    wr(3, lane, posC(q, 2, (g + 2) & 3), L.c);
    wr(3, lane, posC(q, 3, (g + 3) & 3), L.d);
  }
  // B4. phase 4: Z xor R in row layout, and J1 of the next block
  const out = new Array(128);
  let j1 = null;
  for (const lane of lanes) {
    const L = reg[lane];
    for (let m = 0; m < 4; m++) out[wR(lane, m)] = xor64(rd(4, lane, wR(lane, m)), L.r[m]);
    note(4, lane, "read", sidx(0));
    note(4, lane, "read", R0_ADDR + parity);
    const j = (mem[sidx(0)].lo ^ r0[parity].lo) >>> 0;
    if (j1 !== null && j !== j1) throw new Error("lanes disagree about J1");
    j1 = j;
  }
  return { out, j1, S: mem, R0: r0 };
}

/**
 * mixBlockLanes over consecutive blocks: block i is G(prev, refs[i]) with prev the output of block
 * i - 1 (the first prev is given). The shared S and R0 persist from block to block, and the phases
 * continue (4 per block), so the back edge (final reads of block i, row exchange of block i + 1) is
 * one barrier interval in the reports. -> the output blocks (arrays of 128 pairs)
 */
export function fillLanes(prev, refs, opts = {}) {
  const S = new Array(S_WORDS).fill(null);
  const R0 = [null, null];
  const outs = [];
  let p = prev;
  refs.forEach((ref, i) => {
    const R = p.map((x, w) => xor64(x, ref[w]));
    const { out } = mixBlockLanes(R, { ...opts, phaseBase: 4 * i, parity: i & 1, S, R0 });
    outs.push(out);
    p = out;
  });
  return outs;
}

/**
 * The checker for the barrier placement: collects the accesses of a run and reports every barrier
 * interval in which one address is written by one lane and read or written by another lane.
 * Usage: const c = hazardChecker(); mixBlockLanes(R, { onAccess: c.onAccess }); c.hazards() -> [] when clean.
 */
export function hazardChecker() {
  const by = new Map(); // phase -> Map(addr -> { writers: Set, readers: Set })
  const onAccess = (phase, lane, kind, addr) => {
    let m = by.get(phase);
    if (!m) by.set(phase, (m = new Map()));
    let e = m.get(addr);
    if (!e) m.set(addr, (e = { writers: new Set(), readers: new Set() }));
    (kind === "write" ? e.writers : e.readers).add(lane);
  };
  const hazards = () => {
    const found = [];
    for (const [phase, m] of by) {
      for (const [addr, e] of m) {
        if (e.writers.size === 0) continue;
        const others = new Set([...e.writers, ...e.readers]);
        if (others.size > 1) found.push({ phase, addr, writers: [...e.writers], readers: [...e.readers] });
      }
    }
    return found;
  };
  return { onAccess, hazards, accesses: () => by };
}

/**
 * k_fill for one hash on the lane model: blocks [from, to) of mem (a Uint32Array(SLOT_U32) that already holds blocks
 * 0 .. from - 1), with prev / nxt in per-lane registers, the prefetch of the next reference before the mix and J1
 * from workgroup memory after it, exactly as the kernel does. A segment can start anywhere in [2, 4096): it only
 * needs memory. onAccess / order as in mixBlockLanes (phases continue across the whole call).
 */
export function fillModel(mem, from, to, table = sharedTable(), { onAccess = null, order = null } = {}) {
  if (!(from >= 2 && from <= to && to <= BLOCKS)) throw new RangeError("a fill segment lies inside [2, 4096)");
  const S = new Array(S_WORDS).fill(null);
  const R0 = [null, null];
  const refIndex = (i) => (i < INDEP_BLOCKS ? table[i] : a2_ref_of(i, mem[(i - 1) * BLOCK_WORDS * 2]));
  const loadLanes = (blk) => Array.from({ length: 32 }, (_, lane) => [0, 1, 2, 3].map((m) => loadPair(mem, blk, wR(lane, m))));
  let prev = loadLanes(from - 1);
  let nxt = from < to ? loadLanes(refIndex(from)) : null;
  for (let index = from; index < to; index++) {
    const R = new Array(BLOCK_WORDS);
    for (let lane = 0; lane < 32; lane++) for (let m = 0; m < 4; m++) R[wR(lane, m)] = xor64(prev[lane][m], nxt[lane][m]);
    if (index + 1 < INDEP_BLOCKS) nxt = loadLanes(table[index + 1]); // prefetch, before the mix
    const { out, j1 } = mixBlockLanes(R, { onAccess, order, phaseBase: 4 * (index - from), parity: index & 1, S, R0 });
    for (let lane = 0; lane < 32; lane++) {
      for (let m = 0; m < 4; m++) storePair(mem, index, wR(lane, m), out[wR(lane, m)]);
      prev[lane] = [0, 1, 2, 3].map((m) => out[wR(lane, m)]);
    }
    if (index + 1 >= INDEP_BLOCKS && index + 1 < BLOCKS) nxt = loadLanes(a2_ref_of(index + 1, j1));
  }
}

/** The whole hash through the lane model, with the fill split at the given block indexes (ascending, inside (2, 4096)). */
export function argon2idLanes(password, cuts = [], table = sharedTable()) {
  const mem = initMemory(password);
  const edges = [2, ...cuts, BLOCKS];
  for (let i = 0; i + 1 < edges.length; i++) fillModel(mem, edges[i], edges[i + 1], table);
  return finalTag(mem);
}

// ---------------------------------------------------------------- k_prims: primitives on the GPU vs here

export const PRIMS_IN_WORDS = 8; // x.lo x.hi y.lo y.hi j1 index a b
export const PRIMS_OUT_PAIRS = 12;
export const PRIM_NAMES = ["add64", "rotr24", "rotr16", "rotr63", "rotr32", "mul32wide", "fbla", "a2_gb.a", "a2_gb.b", "a2_gb.c", "a2_gb.d", "a2_ref_of"];

/** What k_prims writes for one input set (12 pairs). Inputs: x, y pairs; j1, a, b u32; index in 2 .. 4095. */
export function primsCase({ x, y, j1, index, a, b }) {
  const gb = a2_gb(x, y, xor64(x, y), { lo: ~x.lo >>> 0, hi: ~x.hi >>> 0 });
  return [
    add64(x, y), rotr24(x), rotr16(x), rotr63(x), rotr32(x), mul32wide(a, b), fbla(x, y),
    gb.a, gb.b, gb.c, gb.d, { lo: a2_ref_of(index, j1) >>> 0, hi: 0 },
  ];
}

/** n input sets from a seeded 32-bit generator (xorshift32), as the Uint32Array the kernel reads (8 words each). */
export function primsInputs(n, seed = 0x9e3779b9) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  const words = new Uint32Array(n * PRIMS_IN_WORDS);
  for (let i = 0; i < n; i++) {
    const o = i * PRIMS_IN_WORDS;
    for (let k = 0; k < PRIMS_IN_WORDS; k++) words[o + k] = next();
    // edge values now and then
    if (i % 7 === 0) words[o] = [0, 1, 0x80000000, 0xffffffff][i % 4];
    if (i % 11 === 0) words[o + 2] = [0xffffffff, 0, 0xffff, 0x10000][i % 4];
    if (i % 13 === 0) words[o + 6] = 0xffffffff;
    if (i % 13 === 0) words[o + 7] = 0xffffffff;
    words[o + 5] = 2 + (words[o + 5] % (BLOCKS - 2)); // index in 2 .. 4095
  }
  return words;
}

/** The expected k_prims output for packed inputs: Uint32Array(n * 12 * 2). */
export function primsExpected(words) {
  const n = words.length / PRIMS_IN_WORDS;
  const out = new Uint32Array(n * PRIMS_OUT_PAIRS * 2);
  for (let i = 0; i < n; i++) {
    const o = i * PRIMS_IN_WORDS;
    const res = primsCase({ x: { lo: words[o], hi: words[o + 1] }, y: { lo: words[o + 2], hi: words[o + 3] }, j1: words[o + 4], index: words[o + 5], a: words[o + 6], b: words[o + 7] });
    res.forEach((p, k) => {
      out[(i * PRIMS_OUT_PAIRS + k) * 2] = p.lo;
      out[(i * PRIMS_OUT_PAIRS + k) * 2 + 1] = p.hi;
    });
  }
  return out;
}

/** The name of the first primitive whose output differs: { index, primitive } or null. got / want: Uint32Array of 24 words per input set. */
export function firstPrimsMismatch(got, want) {
  const per = PRIMS_OUT_PAIRS * 2;
  for (let i = 0; i < want.length / per; i++) {
    for (let k = 0; k < PRIMS_OUT_PAIRS; k++) {
      if (got[i * per + 2 * k] !== want[i * per + 2 * k] || got[i * per + 2 * k + 1] !== want[i * per + 2 * k + 1]) return { index: i, primitive: PRIM_NAMES[k] };
    }
  }
  return null;
}

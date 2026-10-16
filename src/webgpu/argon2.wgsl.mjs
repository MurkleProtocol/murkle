// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner prototype: the Argon2id kernel for the one parameter set of MURK, in WGSL.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// The algorithm is RFC 9106. The layout is a one-to-one port of gpu/src/argon2.cuh: 32 invocations
// compute one hash, four of them share one 16-word permutation, a 64-bit word is a vec2<u32>
// (.x low, .y high). What CUDA does with warp shuffles goes through workgroup memory here, behind
// four workgroupBarrier() calls per 1 KiB block. Every function below has a twin of the same name in
// src/webgpu/ref64.mjs with the same statement order; that file is tested against BigInt, noble and
// the Argon2 vectors, and models this kernel's schedule line for line. Where this text and ref64.mjs
// differ, ref64.mjs is right. Parameters: m = 4096 KiB (4096 blocks of 1024 bytes), t = 1, p = 1,
// 32-byte tag, salt "murkle/mine/salt", 40-byte passwords; each hash owns 4 MiB.
//
// WGSL notes: shifts are always by a literal 1 .. 31 (a runtime shift count is taken mod 32, and a
// shift by 0 or 32 is not what the code means); the names "from" and "target" are reserved words in
// WGSL, so the segment bounds are segFrom and segTo; there are no 64-bit integer types, no extensions
// and no optional built-ins, so the kernel runs on every WebGPU implementation.
//
// Strings in a .mjs file so that Node and Vite import them without a loader.

export const COMMON_WGSL = /* wgsl */ `
// murkle-webgpu-kernel
alias w64 = vec2<u32>;

// One entry per (bank, segment) at a 256-byte stride, bound with a dynamic offset.
struct Params {
  slotBase: u32,
  slots: u32,
  segFrom: u32,
  segTo: u32,
}

@group(0) @binding(0) var<storage, read_write> mem: array<vec2<u32>>;
@group(0) @binding(1) var<storage, read> pw: array<u32>;
@group(0) @binding(2) var<storage, read_write> tags: array<vec2<u32>>;
@group(0) @binding(3) var<storage, read> reftab: array<u32>;
@group(0) @binding(4) var<uniform> prm: Params;

// Hashes per workgroup: 1, 2, 4 or 8 (a pipeline constant).
override HPW: u32 = 2u;
override WG_SIZE: u32 = HPW * 32u;
override S_LEN: u32 = HPW * 136u;
override R0_LEN: u32 = HPW * 2u;

// ---------------------------------------------------------------- 64-bit pieces

fn add64(a: w64, b: w64) -> w64 {
  let lo = a.x + b.x;
  let c = select(0u, 1u, lo < a.x);
  let hi = a.y + b.y + c;
  return w64(lo, hi);
}

fn xor64(a: w64, b: w64) -> w64 {
  return w64(a.x ^ b.x, a.y ^ b.y);
}

fn rotr32(x: w64) -> w64 {
  return x.yx;
}

fn rotr24(x: w64) -> w64 {
  let lo = (x.x >> 24u) | (x.y << 8u);
  let hi = (x.y >> 24u) | (x.x << 8u);
  return w64(lo, hi);
}

fn rotr16(x: w64) -> w64 {
  let lo = (x.x >> 16u) | (x.y << 16u);
  let hi = (x.y >> 16u) | (x.x << 16u);
  return w64(lo, hi);
}

fn rotr63(x: w64) -> w64 {
  let lo = (x.x << 1u) | (x.y >> 31u);
  let hi = (x.y << 1u) | (x.x >> 31u);
  return w64(lo, hi);
}

fn mul32wide(a: u32, b: u32) -> w64 {
  let a0 = a & 0xffffu;
  let a1 = a >> 16u;
  let b0 = b & 0xffffu;
  let b1 = b >> 16u;
  let p00 = a0 * b0;
  let p01 = a0 * b1;
  let p10 = a1 * b0;
  let p11 = a1 * b1;
  let mid = (p00 >> 16u) + (p01 & 0xffffu) + (p10 & 0xffffu);
  let lo = (p00 & 0xffffu) | (mid << 16u);
  let hi = p11 + (p01 >> 16u) + (p10 >> 16u) + (mid >> 16u);
  return w64(lo, hi);
}

fn mulhi32(a: u32, b: u32) -> u32 {
  return mul32wide(a, b).y;
}

fn fbla(x: w64, y: w64) -> w64 {
  let m = mul32wide(x.x, y.x);
  let m2 = w64(m.x << 1u, (m.y << 1u) | (m.x >> 31u));
  return add64(add64(x, y), m2);
}

struct Quad {
  a: w64,
  b: w64,
  c: w64,
  d: w64,
}

fn a2_gb(a0: w64, b0: w64, c0: w64, d0: w64) -> Quad {
  var a = fbla(a0, b0);
  var d = rotr32(xor64(d0, a));
  var c = fbla(c0, d);
  var b = rotr24(xor64(b0, c));
  a = fbla(a, b);
  d = rotr16(xor64(d, a));
  c = fbla(c, d);
  b = rotr63(xor64(b, c));
  return Quad(a, b, c, d);
}

// ---------------------------------------------------------------- BLAKE2b

var<private> B2_IV: array<vec2<u32>, 8> = array<vec2<u32>, 8>(
  vec2<u32>(0xf3bcc908u, 0x6a09e667u), vec2<u32>(0x84caa73bu, 0xbb67ae85u),
  vec2<u32>(0xfe94f82bu, 0x3c6ef372u), vec2<u32>(0x5f1d36f1u, 0xa54ff53au),
  vec2<u32>(0xade682d1u, 0x510e527fu), vec2<u32>(0x2b3e6c1fu, 0x9b05688cu),
  vec2<u32>(0xfb41bd6bu, 0x1f83d9abu), vec2<u32>(0x137e2179u, 0x5be0cd19u)
);

// 12 rounds of 16 message indexes: the ten rows of RFC 7693, then rows 0 and 1 again.
var<private> B2_SIGMA: array<u32, 192> = array<u32, 192>(
  0u, 1u, 2u, 3u, 4u, 5u, 6u, 7u, 8u, 9u, 10u, 11u, 12u, 13u, 14u, 15u,
  14u, 10u, 4u, 8u, 9u, 15u, 13u, 6u, 1u, 12u, 0u, 2u, 11u, 7u, 5u, 3u,
  11u, 8u, 12u, 0u, 5u, 2u, 15u, 13u, 10u, 14u, 3u, 6u, 7u, 1u, 9u, 4u,
  7u, 9u, 3u, 1u, 13u, 12u, 11u, 14u, 2u, 6u, 5u, 10u, 4u, 0u, 15u, 8u,
  9u, 0u, 5u, 7u, 2u, 4u, 10u, 15u, 14u, 1u, 11u, 12u, 6u, 8u, 3u, 13u,
  2u, 12u, 6u, 10u, 0u, 11u, 8u, 3u, 4u, 13u, 7u, 5u, 15u, 14u, 1u, 9u,
  12u, 5u, 1u, 15u, 14u, 13u, 4u, 10u, 0u, 7u, 6u, 3u, 9u, 2u, 8u, 11u,
  13u, 11u, 7u, 14u, 12u, 1u, 3u, 9u, 5u, 0u, 15u, 4u, 8u, 6u, 2u, 10u,
  6u, 15u, 14u, 9u, 11u, 3u, 0u, 8u, 12u, 2u, 13u, 7u, 1u, 4u, 10u, 5u,
  10u, 2u, 8u, 4u, 7u, 6u, 1u, 5u, 15u, 11u, 9u, 14u, 3u, 12u, 13u, 0u,
  0u, 1u, 2u, 3u, 4u, 5u, 6u, 7u, 8u, 9u, 10u, 11u, 12u, 13u, 14u, 15u,
  14u, 10u, 4u, 8u, 9u, 15u, 13u, 6u, 1u, 12u, 0u, 2u, 11u, 7u, 5u, 3u
);

// BLAKE2b G with the message words x and y: a = a + b + x, ...
fn b2_g(a0: w64, b0: w64, c0: w64, d0: w64, x: w64, y: w64) -> Quad {
  var a = add64(add64(a0, b0), x);
  var d = rotr32(xor64(d0, a));
  var c = add64(c0, d);
  var b = rotr24(xor64(b0, c));
  a = add64(add64(a, b), y);
  d = rotr16(xor64(d, a));
  c = add64(c, d);
  b = rotr63(xor64(b, c));
  return Quad(a, b, c, d);
}

fn b2_step(v: ptr<function, array<vec2<u32>, 16>>, ia: u32, ib: u32, ic: u32, id: u32, x: w64, y: w64) {
  let r = b2_g((*v)[ia], (*v)[ib], (*v)[ic], (*v)[id], x, y);
  (*v)[ia] = r.a;
  (*v)[ib] = r.b;
  (*v)[ic] = r.c;
  (*v)[id] = r.d;
}

// The compression function F. h: 8 words, updated in place; m: 16 words; t: bytes hashed so far
// including this block (below 2^32: at most 1028); last: the final block.
fn b2_compress(h: ptr<function, array<vec2<u32>, 8>>, m: ptr<function, array<vec2<u32>, 16>>, t: u32, last: bool) {
  var v: array<vec2<u32>, 16>;
  for (var i = 0u; i < 8u; i++) {
    v[i] = (*h)[i];
    v[i + 8u] = B2_IV[i];
  }
  v[12] = xor64(v[12], w64(t, 0u));
  if (last) {
    v[14] = xor64(v[14], w64(0xffffffffu, 0xffffffffu));
  }
  for (var r = 0u; r < 12u; r++) {
    let s = r * 16u;
    b2_step(&v, 0u, 4u, 8u, 12u, (*m)[B2_SIGMA[s]], (*m)[B2_SIGMA[s + 1u]]);
    b2_step(&v, 1u, 5u, 9u, 13u, (*m)[B2_SIGMA[s + 2u]], (*m)[B2_SIGMA[s + 3u]]);
    b2_step(&v, 2u, 6u, 10u, 14u, (*m)[B2_SIGMA[s + 4u]], (*m)[B2_SIGMA[s + 5u]]);
    b2_step(&v, 3u, 7u, 11u, 15u, (*m)[B2_SIGMA[s + 6u]], (*m)[B2_SIGMA[s + 7u]]);
    b2_step(&v, 0u, 5u, 10u, 15u, (*m)[B2_SIGMA[s + 8u]], (*m)[B2_SIGMA[s + 9u]]);
    b2_step(&v, 1u, 6u, 11u, 12u, (*m)[B2_SIGMA[s + 10u]], (*m)[B2_SIGMA[s + 11u]]);
    b2_step(&v, 2u, 7u, 8u, 13u, (*m)[B2_SIGMA[s + 12u]], (*m)[B2_SIGMA[s + 13u]]);
    b2_step(&v, 3u, 4u, 9u, 14u, (*m)[B2_SIGMA[s + 14u]], (*m)[B2_SIGMA[s + 15u]]);
  }
  for (var i = 0u; i < 8u; i++) {
    (*h)[i] = xor64((*h)[i], xor64(v[i], v[i + 8u]));
  }
}

// The initial state of an unkeyed BLAKE2b with outlen output bytes.
fn b2_init(outlen: u32) -> array<vec2<u32>, 8> {
  var h: array<vec2<u32>, 8> = B2_IV;
  h[0] = w64(h[0].x ^ (0x01010000u | outlen), h[0].y);
  return h;
}

// BLAKE2b with outlen bytes of a message of len <= 128 bytes held in m: one compression.
fn b2_hash1(m: ptr<function, array<vec2<u32>, 16>>, len: u32, outlen: u32) -> array<vec2<u32>, 8> {
  var h = b2_init(outlen);
  b2_compress(&h, m, len, true);
  return h;
}

// H0 of Argon2id for MURK: p = 1, tag 32, m = 4096 KiB, t = 1, v = 0x13, y = 2, the 40-byte
// password (ten little-endian words), the 16-byte salt, no secret, no associated data: 96 bytes.
// "murk" "le/m" "ine/" "salt" are the little-endian words of the salt.
fn a2_h0(p: ptr<function, array<u32, 10>>) -> array<vec2<u32>, 8> {
  var w: array<u32, 24>;
  w[0] = 1u;
  w[1] = 32u;
  w[2] = 4096u;
  w[3] = 1u;
  w[4] = 0x13u;
  w[5] = 2u;
  w[6] = 40u;
  for (var i = 0u; i < 10u; i++) {
    w[7u + i] = (*p)[i];
  }
  w[17] = 16u;
  w[18] = 0x6b72756du;
  w[19] = 0x6d2f656cu;
  w[20] = 0x2f656e69u;
  w[21] = 0x746c6173u;
  w[22] = 0u;
  w[23] = 0u;
  var m: array<vec2<u32>, 16>;
  for (var i = 0u; i < 12u; i++) {
    m[i] = w64(w[2u * i], w[2u * i + 1u]);
  }
  return b2_hash1(&m, 96u, 64u);
}

// H'1024(H0 || LE32 j || LE32 0) (RFC 9106 section 3.3): the 128 words of block j are written to
// mem at outBase (the JS twin returns them).
fn a2_hprime_1024(h0: ptr<function, array<vec2<u32>, 8>>, j: u32, outBase: u32) {
  var m: array<vec2<u32>, 16>;
  m[0] = w64(1024u, (*h0)[0].x);
  for (var k = 1u; k < 8u; k++) {
    m[k] = w64((*h0)[k - 1u].y, (*h0)[k].x);
  }
  m[8] = w64((*h0)[7].y, j);
  var v = b2_hash1(&m, 76u, 64u);
  for (var w = 0u; w < 4u; w++) {
    mem[outBase + w] = v[w];
  }
  for (var i = 2u; i <= 30u; i++) {
    for (var k = 0u; k < 8u; k++) {
      m[k] = v[k];
    }
    for (var k = 8u; k < 16u; k++) {
      m[k] = w64(0u, 0u);
    }
    v = b2_hash1(&m, 64u, 64u);
    for (var w = 0u; w < 4u; w++) {
      mem[outBase + 4u * (i - 1u) + w] = v[w];
    }
  }
  for (var k = 0u; k < 8u; k++) {
    m[k] = v[k];
  }
  for (var k = 8u; k < 16u; k++) {
    m[k] = w64(0u, 0u);
  }
  v = b2_hash1(&m, 64u, 64u);
  for (var w = 0u; w < 8u; w++) {
    mem[outBase + 120u + w] = v[w];
  }
}

// ---------------------------------------------------------------- Argon2 pieces

// The block to read for block index (>= 2) from J1 (RFC 9106 section 3.4.2, one pass, one lane).
fn a2_ref_of(index: u32, j1: u32) -> u32 {
  let x = mulhi32(j1, j1);
  let y = mulhi32(index - 1u, x);
  return index - 2u - y;
}

// Padded index into the workgroup array S: 8 pad words against bank conflicts.
fn sidx(w: u32) -> u32 {
  return w + (w >> 4u);
}

// Positions (block word indexes) for the quad exchange. Row round: row q, position k * 4 + gp.
// Column round: column pair q; the row of v[4k + gp] is 2k + (gp >> 1).
fn posR(q: u32, k: u32, gp: u32) -> u32 {
  return 16u * q + 4u * k + gp;
}

fn posC(q: u32, k: u32, gp: u32) -> u32 {
  return 16u * (2u * k + (gp >> 1u)) + 2u * q + (gp & 1u);
}

// The block a block reads: reftab for the data-independent half, else from J1 (low half of word 0
// of the block before it, read from memory).
fn ref_index(base: u32, i: u32) -> u32 {
  if (i < 2048u) {
    return reftab[i];
  }
  return a2_ref_of(i, mem[base + (i - 1u) * 128u].x);
}

`;

// The kernels. S: the padded exchange array (hash h at offset h * 136); R0: word 0 of R by block parity.
const KERNELS_WGSL = /* wgsl */ `
var<workgroup> S: array<vec2<u32>, S_LEN>;
var<workgroup> R0: array<vec2<u32>, R0_LEN>;

// ---------------------------------------------------------------- kernels

// One invocation per (slot, j): H0 of the slot's password, then block j = H'1024(H0 || j || 0).
@compute @workgroup_size(64)
fn k_init(@builtin(global_invocation_id) gid: vec3<u32>) {
  let t = gid.x;
  let slot = t >> 1u;
  let j = t & 1u;
  if (slot >= prm.slots) {
    return;
  }
  var p: array<u32, 10>;
  for (var i = 0u; i < 10u; i++) {
    p[i] = pw[(prm.slotBase + slot) * 10u + i];
  }
  var h0 = a2_h0(&p);
  a2_hprime_1024(&h0, j, slot * 524288u + j * 128u);
}

// Blocks [segFrom, segTo) of every slot of the bank. 32 * HPW invocations per workgroup, HPW hashes.
// A segment can start at any block in [2, 4096): everything it needs is in memory.
@compute @workgroup_size(WG_SIZE)
fn k_fill(@builtin(local_invocation_index) lid: u32, @builtin(workgroup_id) wid: vec3<u32>) {
  let h = lid >> 5u;
  let lane = lid & 31u;
  let q = lane >> 2u;
  let g = lane & 3u;
  let g1 = (g + 1u) & 3u;
  let g2 = (g + 2u) & 3u;
  let g3 = (g + 3u) & 3u;
  let base = (wid.x * HPW + h) * 524288u;
  let sb = h * 136u;
  let w0 = 16u * q + g;
  let segFrom = prm.segFrom;
  let segTo = prm.segTo;

  var p0 = mem[base + (segFrom - 1u) * 128u + w0];
  var p1 = mem[base + (segFrom - 1u) * 128u + w0 + 4u];
  var p2 = mem[base + (segFrom - 1u) * 128u + w0 + 8u];
  var p3 = mem[base + (segFrom - 1u) * 128u + w0 + 12u];
  let ri = ref_index(base, segFrom);
  var n0 = mem[base + ri * 128u + w0];
  var n1 = mem[base + ri * 128u + w0 + 4u];
  var n2 = mem[base + ri * 128u + w0 + 8u];
  var n3 = mem[base + ri * 128u + w0 + 12u];

  for (var index = segFrom; index < segTo; index++) {
    // R = prev xor ref, in registers
    let r0 = p0 ^ n0;
    let r1 = p1 ^ n1;
    let r2 = p2 ^ n2;
    let r3 = p3 ^ n3;
    if (lane == 0u) {
      R0[2u * h + (index & 1u)] = r0;
    }
    // the next reference of the data-independent half is known now: fetch it before the mix
    if (index + 1u < 2048u) {
      let rb = base + reftab[index + 1u] * 128u + w0;
      n0 = mem[rb];
      n1 = mem[rb + 4u];
      n2 = mem[rb + 8u];
      n3 = mem[rb + 12u];
    }

    // row round: lane g of quad q holds a = v[g], b = v[4 + g], c = v[8 + g], d = v[12 + g] of row q
    var x = a2_gb(r0, r1, r2, r3);
    var a = x.a;
    var b = x.b;
    var c = x.c;
    var d = x.d;
    S[sb + sidx(posR(q, 1u, g))] = b;
    S[sb + sidx(posR(q, 2u, g))] = c;
    S[sb + sidx(posR(q, 3u, g))] = d;
    workgroupBarrier();
    b = S[sb + sidx(posR(q, 1u, g1))];
    c = S[sb + sidx(posR(q, 2u, g2))];
    d = S[sb + sidx(posR(q, 3u, g3))];
    x = a2_gb(a, b, c, d);
    a = x.a;
    b = x.b;
    c = x.c;
    d = x.d;
    S[sb + sidx(posR(q, 0u, g))] = a;
    S[sb + sidx(posR(q, 1u, g1))] = b;
    S[sb + sidx(posR(q, 2u, g2))] = c;
    S[sb + sidx(posR(q, 3u, g3))] = d;
    workgroupBarrier();

    // column round: column pair q
    a = S[sb + sidx(posC(q, 0u, g))];
    b = S[sb + sidx(posC(q, 1u, g))];
    c = S[sb + sidx(posC(q, 2u, g))];
    d = S[sb + sidx(posC(q, 3u, g))];
    x = a2_gb(a, b, c, d);
    a = x.a;
    b = x.b;
    c = x.c;
    d = x.d;
    S[sb + sidx(posC(q, 1u, g))] = b;
    S[sb + sidx(posC(q, 2u, g))] = c;
    S[sb + sidx(posC(q, 3u, g))] = d;
    workgroupBarrier();
    b = S[sb + sidx(posC(q, 1u, g1))];
    c = S[sb + sidx(posC(q, 2u, g2))];
    d = S[sb + sidx(posC(q, 3u, g3))];
    x = a2_gb(a, b, c, d);
    a = x.a;
    b = x.b;
    c = x.c;
    d = x.d;
    S[sb + sidx(posC(q, 0u, g))] = a;
    S[sb + sidx(posC(q, 1u, g1))] = b;
    S[sb + sidx(posC(q, 2u, g2))] = c;
    S[sb + sidx(posC(q, 3u, g3))] = d;
    workgroupBarrier();

    // the new block is Z xor R, in the row layout
    let z0 = S[sb + sidx(w0)] ^ r0;
    let z1 = S[sb + sidx(w0 + 4u)] ^ r1;
    let z2 = S[sb + sidx(w0 + 8u)] ^ r2;
    let z3 = S[sb + sidx(w0 + 12u)] ^ r3;
    mem[base + index * 128u + w0] = z0;
    mem[base + index * 128u + w0 + 4u] = z1;
    mem[base + index * 128u + w0 + 8u] = z2;
    mem[base + index * 128u + w0 + 12u] = z3;
    p0 = z0;
    p1 = z1;
    p2 = z2;
    p3 = z3;
    // the data-dependent half: J1 is the low half of word 0 of the block just made (the uniform branch)
    if (index + 1u >= 2048u && index + 1u < 4096u) {
      let j1 = (S[sb + sidx(0u)] ^ R0[2u * h + (index & 1u)]).x;
      let rj = a2_ref_of(index + 1u, j1);
      n0 = mem[base + rj * 128u + w0];
      n1 = mem[base + rj * 128u + w0 + 4u];
      n2 = mem[base + rj * 128u + w0 + 8u];
      n3 = mem[base + rj * 128u + w0 + 12u];
    }
  }
}

// One invocation per slot: tag = BLAKE2b-256(LE32(32) || block 4095), 1028 bytes, nine compressions.
// Word k of the block is mem[...][k >> 1], component k & 1.
fn blkword(base: u32, k: u32) -> u32 {
  let v = mem[base + (k >> 1u)];
  return select(v.x, v.y, (k & 1u) == 1u);
}

@compute @workgroup_size(64)
fn k_final(@builtin(global_invocation_id) gid: vec3<u32>) {
  let slot = gid.x;
  if (slot >= prm.slots) {
    return;
  }
  let base = slot * 524288u + 4095u * 128u;
  var h = b2_init(32u);
  for (var t = 0u; t < 9u; t++) {
    var m: array<vec2<u32>, 16>;
    for (var j = 0u; j < 16u; j++) {
      let lo = 32u * t + 2u * j;
      let hi = lo + 1u;
      var wl = 0u;
      if (lo == 0u) {
        wl = 32u;
      } else if (lo <= 256u) {
        wl = blkword(base, lo - 1u);
      }
      var wh = 0u;
      if (hi <= 256u) {
        wh = blkword(base, hi - 1u);
      }
      m[j] = w64(wl, wh);
    }
    var done = 128u * (t + 1u);
    if (t == 8u) {
      done = 1028u;
    }
    b2_compress(&h, &m, done, t == 8u);
  }
  let o = (prm.slotBase + slot) * 4u;
  tags[o] = h[0];
  tags[o + 1u] = h[1];
  tags[o + 2u] = h[2];
  tags[o + 3u] = h[3];
}

// BLAKE2b-256("abc") into tags[0 .. 3]: the start-up check of the BLAKE2b code on this GPU.
@compute @workgroup_size(1)
fn k_kat() {
  var m: array<vec2<u32>, 16>;
  m[0] = w64(0x636261u, 0u);
  var h = b2_hash1(&m, 3u, 32u);
  tags[0] = h[0];
  tags[1] = h[1];
  tags[2] = h[2];
  tags[3] = h[3];
}
`;

// Diagnostic only: the primitives on random inputs, compared with ref64.mjs by the engine at start-up
// and by the tests. Case i reads 8 words of pw (x.lo x.hi y.lo y.hi j1 index a b) and writes 12
// words of tags: add64(x, y), rotr24(x), rotr16(x), rotr63(x), rotr32(x), mul32wide(a, b), fbla(x, y),
// a2_gb(x, y, x ^ y, ~x) (four words), a2_ref_of(index, j1) (low half). prm.slots is the case count.
const PRIMS_KERNEL = /* wgsl */ `
@compute @workgroup_size(64)
fn k_prims(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= prm.slots) {
    return;
  }
  let o = i * 8u;
  let x = w64(pw[o], pw[o + 1u]);
  let y = w64(pw[o + 2u], pw[o + 3u]);
  let j1 = pw[o + 4u];
  let index = pw[o + 5u];
  let a = pw[o + 6u];
  let b = pw[o + 7u];
  let ob = i * 12u;
  tags[ob] = add64(x, y);
  tags[ob + 1u] = rotr24(x);
  tags[ob + 2u] = rotr16(x);
  tags[ob + 3u] = rotr63(x);
  tags[ob + 4u] = rotr32(x);
  tags[ob + 5u] = mul32wide(a, b);
  tags[ob + 6u] = fbla(x, y);
  let gb = a2_gb(x, y, xor64(x, y), ~x);
  tags[ob + 7u] = gb.a;
  tags[ob + 8u] = gb.b;
  tags[ob + 9u] = gb.c;
  tags[ob + 10u] = gb.d;
  tags[ob + 11u] = w64(a2_ref_of(index, j1), 0u);
}
`;

export const ARGON2_WGSL = COMMON_WGSL + KERNELS_WGSL;
export const PRIMS_WGSL = COMMON_WGSL + PRIMS_KERNEL;

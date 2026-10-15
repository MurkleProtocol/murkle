// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle GPU miner (murkle-gpu): Argon2id for the one parameter set of MURK, on the GPU.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// Additional permission under GNU GPL version 3 section 7: if you link or combine this program
// with the NVIDIA CUDA runtime and driver libraries (cudart, libcuda / nvcuda), the licensors
// grant you additional permission to convey the resulting work. Corresponding Source for a
// non-source form of such a combination need not include the source of those NVIDIA libraries.
//
// The algorithm is RFC 9106. The warp-cooperative layout (a warp holds a 1 KiB block, four lanes
// share one 16-word BLAKE2b-style permutation, diagonals through warp shuffles) is the same idea
// that hashcat (MIT, Jens Steube and contributors) and argon2-gpu (MIT, Ondrej Mosnacek) use for
// their GPU Argon2. This code was written independently for this one parameter set; no source
// of either project was read or copied. Their MIT notices are kept as a courtesy in
// THIRD_PARTY_NOTICES.md.
//
// Fixed parameters (RFC 9106, version 0x13): m = 4096 KiB (4096 blocks of 1024 bytes), t = 1,
// p = 1, 32-byte tag, salt "murkle/mine/salt", 40-byte passwords. One warp computes one hash;
// each slot owns 4 MiB of device memory. With p = 1 there is a single lane, so the reference lane
// is always 0, and with t = 1 the new block is never XORed with an old one.
//
// This file holds device code only (no host headers), so it also compiles with NVRTC.
#pragma once
#include "blake2b.cuh"

#define A2_BLOCKS 4096u
#define A2_BLOCK_WORDS 128u
#define A2_SLOT_WORDS (A2_BLOCKS * A2_BLOCK_WORDS)  // u64 words per slot: 4 MiB
#define A2_PW_WORDS 10u                             // 40-byte password as u32 words
#define A2_INDEP_BLOCKS 2048u                       // slices 0 and 1: data-independent addressing
#define A2_PAD 20u                                  // shared-memory row stride (u64 words)
#define A2_SM_WORDS (8u * A2_PAD)                   // shared u64 words per warp: 1280 bytes
#define A2_FULL 0xffffffffu

// For block index 2 .. 2047: the index of the block to read (the same for every password). Filled once by k_reftable.
__device__ u16 g_ref_table[A2_INDEP_BLOCKS];

// fBlaMka: x + y + 2 * lo32(x) * lo32(y)
__device__ __forceinline__ u64 a2_fbla(u64 x, u64 y) { return x + y + 2ULL * (u64)(u32)x * (u64)(u32)y; }

__device__ __forceinline__ void a2_gb(u64& a, u64& b, u64& c, u64& d) {
  a = a2_fbla(a, b);
  d = b2_rotr(d ^ a, 32);
  c = a2_fbla(c, d);
  b = b2_rotr(b ^ c, 24);
  a = a2_fbla(a, b);
  d = b2_rotr(d ^ a, 16);
  c = a2_fbla(c, d);
  b = b2_rotr(b ^ c, 63);
}

// The permutation P on one 16-word unit (RFC 9106 permutation P), shared by
// the four lanes g = 0 .. 3 of a quad: lane g holds a = v[g], b = v[4 + g], c = v[8 + g],
// d = v[12 + g]. The column step is one G per lane; the diagonal step first rotates b, c, d across
// the quad (shuffles), then rotates them back.
__device__ __forceinline__ void a2_p(u64& a, u64& b, u64& c, u64& d, u32 g) {
  a2_gb(a, b, c, d);
  b = __shfl_sync(A2_FULL, b, (g + 1) & 3, 4);
  c = __shfl_sync(A2_FULL, c, (g + 2) & 3, 4);
  d = __shfl_sync(A2_FULL, d, (g + 3) & 3, 4);
  a2_gb(a, b, c, d);
  b = __shfl_sync(A2_FULL, b, (g + 3) & 3, 4);
  c = __shfl_sync(A2_FULL, c, (g + 2) & 3, 4);
  d = __shfl_sync(A2_FULL, d, (g + 1) & 3, 4);
}

// G(0, R) for a block R = X xor Y held by one warp (RFC 9106 G with the warp layout below).
// x[m] is word 16 * (lane >> 2) + (lane & 3) + 4 m of the block (the "row layout": a quad holds one
// row of 16 words). On return x holds P_cols(P_rows(R)) xor R in the same layout. sm: this warp's
// A2_SM_WORDS words of shared memory. The row round runs in the row layout; the column round needs
// the transposed layout, which goes through shared memory (rows padded to A2_PAD words against
// bank conflicts).
__device__ __forceinline__ void a2_mix(u64 x[4], u64* sm, u32 lane) {
  const u32 g = lane & 3;
  const u32 q = lane >> 2;  // the row in the row round, the column pair in the column round
  const u64 r0 = x[0], r1 = x[1], r2 = x[2], r3 = x[3];
  u64 a = r0, b = r1, c = r2, d = r3;
  a2_p(a, b, c, d, g);  // P on each of the 8 rows
  const u32 rowAt = q * A2_PAD + g;
  sm[rowAt] = a;
  sm[rowAt + 4] = b;
  sm[rowAt + 8] = c;
  sm[rowAt + 12] = d;
  __syncwarp();
  // Column q uses the words (row 2k + (g >> 1), word 2q + (g & 1)) for k = 0 .. 3.
  const u32 colAt = (g >> 1) * A2_PAD + 2 * q + (g & 1);
  a = sm[colAt];
  b = sm[colAt + 2 * A2_PAD];
  c = sm[colAt + 4 * A2_PAD];
  d = sm[colAt + 6 * A2_PAD];
  __syncwarp();
  a2_p(a, b, c, d, g);  // P on each of the 8 columns
  sm[colAt] = a;
  sm[colAt + 2 * A2_PAD] = b;
  sm[colAt + 4 * A2_PAD] = c;
  sm[colAt + 6 * A2_PAD] = d;
  __syncwarp();
  x[0] = sm[rowAt] ^ r0;
  x[1] = sm[rowAt + 4] ^ r1;
  x[2] = sm[rowAt + 8] ^ r2;
  x[3] = sm[rowAt + 12] ^ r3;
  __syncwarp();  // the next use of sm, and of global memory written by other lanes, comes after this point
}

// Block to read for block `index` (>= 2) from J1, the low 32 bits of the pseudo-random word
// (RFC 9106 section 3.4.2 with one pass and one lane: the reference area is the index - 1 blocks
// before the previous one, so the lane is always 0 and the start position 0).
__device__ __forceinline__ u32 a2_ref_of(u32 index, u32 j1) {
  const u64 area = index - 1;
  const u64 x = ((u64)j1 * (u64)j1) >> 32;
  const u64 y = (area * x) >> 32;
  return (u32)(area - 1 - y);
}

// One address block of data-independent addressing (RFC 9106 section 3.4.1.2):
// G(0, G(0, Z)) with Z = [pass 0, lane 0, slice s, 4096 blocks, t = 1, type 2, counter, 0 ...],
// in the row layout of the warp.
__device__ __forceinline__ void a2_address_block(u64 addr[4], u32 s, u64 counter, u64* sm, u32 lane) {
  const u32 off = 16 * (lane >> 2) + (lane & 3);
  for (u32 m = 0; m < 4; m++) {
    const u32 w = off + 4 * m;
    u64 v = 0;
    if (w == 2) v = s;
    else if (w == 3) v = A2_BLOCKS;
    else if (w == 4) v = 1;
    else if (w == 5) v = 2;
    else if (w == 6) v = counter;
    addr[m] = v;
  }
  a2_mix(addr, sm, lane);  // G(0, Z)
  a2_mix(addr, sm, lane);  // G(0, G(0, Z))
}

// ---------------------------------------------------------------------------------------------
// k_reftable: one warp (launch <<<1, 32, A2_SM_WORDS * 8>>>). For the 2046 blocks of slices 0 and
// 1 that are addressed independently of the data, the address blocks give J1 for every index and
// from it the block to read. The result is the same for every password.
// ---------------------------------------------------------------------------------------------
extern "C" __global__ void k_reftable() {
  extern __shared__ u64 smem[];
  const u32 lane = threadIdx.x;
  for (u32 s = 0; s < 2; s++) {
    u64 addr[4] = {0, 0, 0, 0};
    u64 counter = 0;
    if (s == 0) a2_address_block(addr, s, ++counter, smem, lane);  // slice 0 starts at index 2: its first address block is made up front
    for (u32 i = (s == 0 ? 2u : 0u); i < A2_BLOCKS / 4; i++) {
      if ((i & 127u) == 0) a2_address_block(addr, s, ++counter, smem, lane);
      // J1 = low 32 bits of address word i mod 128: lane 4 * (word >> 4) + (word & 3), register (word & 15) >> 2.
      const u32 word = i & 127u;
      const u32 reg = (word & 15u) >> 2;
      u64 mine = addr[0];
      if (reg == 1) mine = addr[1];
      else if (reg == 2) mine = addr[2];
      else if (reg == 3) mine = addr[3];
      const u64 got = __shfl_sync(A2_FULL, mine, 4 * (word >> 4) + (word & 3));
      const u32 index = s * (A2_BLOCKS / 4) + i;
      if (lane == 0) g_ref_table[index] = (u16)a2_ref_of(index, (u32)got);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// k_init: one thread per (slot, j): H0 of the slot's password, then B[j] = H'1024(H0 || j || 0).
// pw: slots * 10 little-endian u32 words; mem: slot * A2_SLOT_WORDS u64 words.
// ---------------------------------------------------------------------------------------------
extern "C" __global__ void k_init(u64* __restrict__ mem, const u32* __restrict__ pw, u32 slots) {
  const u32 t = blockIdx.x * blockDim.x + threadIdx.x;
  const u32 slot = t >> 1;
  const u32 j = t & 1;
  if (slot >= slots) return;
  u32 p[10];
  for (int i = 0; i < 10; i++) p[i] = pw[(size_t)slot * A2_PW_WORDS + i];
  u64 h0[8];
  a2_h0(h0, p);
  a2_hprime_1024(mem + (size_t)slot * A2_SLOT_WORDS + (size_t)j * A2_BLOCK_WORDS, h0, j);
}

// ---------------------------------------------------------------------------------------------
// k_fill: one warp per slot (blockDim.x = 32 * W, dynamic shared memory W * A2_SM_WORDS * 8 bytes).
// Blocks 2 .. 4095: new = G(prev, ref). prev stays in registers; ref is read with L2-only loads
// (this warp wrote the data a moment earlier, and L1 would only be polluted by it).
// ---------------------------------------------------------------------------------------------
extern "C" __global__ void __launch_bounds__(256) k_fill(u64* __restrict__ mem, u32 slots) {
  extern __shared__ u64 smem[];
  const u32 warp = threadIdx.x >> 5;
  const u32 lane = threadIdx.x & 31;
  const u32 slot = blockIdx.x * (blockDim.x >> 5) + warp;
  if (slot >= slots) return;  // uniform per warp
  u64* sm = smem + warp * A2_SM_WORDS;
  u64* base = mem + (size_t)slot * A2_SLOT_WORDS;
  const u32 off = 16 * (lane >> 2) + (lane & 3);

  u64 prev[4], nxt[4];
  for (int m = 0; m < 4; m++) prev[m] = __ldcg(base + A2_BLOCK_WORDS + off + 4 * m);  // B[1]
  {
    const u64* r = base + (size_t)g_ref_table[2] * A2_BLOCK_WORDS + off;  // index 2 reads B[0]
    for (int m = 0; m < 4; m++) nxt[m] = __ldcg(r + 4 * m);
  }
  for (u32 index = 2; index < A2_BLOCKS; index++) {
    u64 x[4];
    for (int m = 0; m < 4; m++) x[m] = prev[m] ^ nxt[m];
    // Data-independent half: the block after this one is known, so its reference is requested now.
    if (index + 1 < A2_INDEP_BLOCKS) {
      const u64* r = base + (size_t)g_ref_table[index + 1] * A2_BLOCK_WORDS + off;
      for (int m = 0; m < 4; m++) nxt[m] = __ldcg(r + 4 * m);
    }
    a2_mix(x, sm, lane);
    u64* dst = base + (size_t)index * A2_BLOCK_WORDS + off;
    for (int m = 0; m < 4; m++) {
      dst[4 * m] = x[m];
      prev[m] = x[m];
    }
    __syncwarp();  // the stores above are visible to every lane of the warp before the next loads
    if (index + 1 >= A2_INDEP_BLOCKS && index + 1 < A2_BLOCKS) {
      // Data-dependent half: J1 comes from word 0 of the block just written (lane 0, register 0).
      const u32 j1 = (u32)__shfl_sync(A2_FULL, prev[0], 0);
      const u64* r = base + (size_t)a2_ref_of(index + 1, j1) * A2_BLOCK_WORDS + off;
      for (int m = 0; m < 4; m++) nxt[m] = __ldcg(r + 4 * m);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// k_final: one thread per slot. tag = BLAKE2b-256(LE32 32 || B[4095]) (RFC 9106 section 3.3 with
// T = 32: H'32 is H^32 of the length-prefixed block, not a truncated 512-bit digest):
// 1028 bytes, nine compressions. tags: slots * 32 bytes.
// ---------------------------------------------------------------------------------------------
extern "C" __global__ void k_final(const u64* __restrict__ mem, u64* __restrict__ tags, u32 slots) {
  const u32 slot = blockIdx.x * blockDim.x + threadIdx.x;
  if (slot >= slots) return;
  const u32* blk = reinterpret_cast<const u32*>(mem + (size_t)slot * A2_SLOT_WORDS + (size_t)(A2_BLOCKS - 1) * A2_BLOCK_WORDS);
  u64 h[8];
  b2_init(h, 32);
  // The message as 32-bit words: M[0] = 32, M[1 + k] = blk[k] for k = 0 .. 255, then zeros (257 words).
  for (u32 t = 0; t < 9; t++) {
    u64 m[16];
    for (u32 j = 0; j < 16; j++) {
      const u32 lo = 32 * t + 2 * j;
      const u32 hi = lo + 1;
      const u32 wl = lo == 0 ? 32u : (lo <= 256 ? __ldcg(blk + lo - 1) : 0u);
      const u32 wh = hi <= 256 ? __ldcg(blk + hi - 1) : 0u;
      m[j] = (u64)wl | ((u64)wh << 32);
    }
    const u64 done = t == 8 ? 1028u : 128u * (t + 1);
    b2_compress(h, m, done, t == 8);
  }
  for (int i = 0; i < 4; i++) tags[(size_t)slot * 4 + i] = h[i];
}

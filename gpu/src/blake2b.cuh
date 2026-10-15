// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle GPU miner (murkle-gpu): BLAKE2b (RFC 7693) for the Argon2id parameter set of MURK.
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
// This file has no host headers on purpose, so the same source also compiles with NVRTC.
#pragma once

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;

#define MK_HD __host__ __device__ __forceinline__

// Little-endian 32-bit word from four characters, for compile-time constants.
#define MK_LE4(a, b, c, d) ((u32)(u8)(a) | ((u32)(u8)(b) << 8) | ((u32)(u8)(c) << 16) | ((u32)(u8)(d) << 24))

MK_HD u64 b2_rotr(u64 x, int n) { return (x >> n) | (x << (64 - n)); }

#define B2_G(a, b, c, d, x, y)  \
  do {                          \
    a = a + b + (x);            \
    d = b2_rotr(d ^ a, 32);     \
    c = c + d;                  \
    b = b2_rotr(b ^ c, 24);     \
    a = a + b + (y);            \
    d = b2_rotr(d ^ a, 16);     \
    c = c + d;                  \
    b = b2_rotr(b ^ c, 63);     \
  } while (0)

// One BLAKE2b round with the message schedule row s0 .. s15 (literals, so m[] stays in registers).
#define B2_ROUND(s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15) \
  do {                                                                                  \
    B2_G(v0, v4, v8, v12, m[s0], m[s1]);                                                \
    B2_G(v1, v5, v9, v13, m[s2], m[s3]);                                                \
    B2_G(v2, v6, v10, v14, m[s4], m[s5]);                                               \
    B2_G(v3, v7, v11, v15, m[s6], m[s7]);                                               \
    B2_G(v0, v5, v10, v15, m[s8], m[s9]);                                               \
    B2_G(v1, v6, v11, v12, m[s10], m[s11]);                                             \
    B2_G(v2, v7, v8, v13, m[s12], m[s13]);                                              \
    B2_G(v3, v4, v9, v14, m[s14], m[s15]);                                              \
  } while (0)

// The compression function F: h (8 words) absorbs one 128-byte block m (16 words);
// t = bytes hashed so far including this block; last marks the final block.
MK_HD void b2_compress(u64 h[8], const u64 m[16], u64 t, bool last) {
  u64 v0 = h[0], v1 = h[1], v2 = h[2], v3 = h[3], v4 = h[4], v5 = h[5], v6 = h[6], v7 = h[7];
  u64 v8 = 0x6a09e667f3bcc908ULL, v9 = 0xbb67ae8584caa73bULL, v10 = 0x3c6ef372fe94f82bULL, v11 = 0xa54ff53a5f1d36f1ULL;
  u64 v12 = 0x510e527fade682d1ULL ^ t, v13 = 0x9b05688c2b3e6c1fULL;
  u64 v14 = 0x1f83d9abfb41bd6bULL ^ (last ? ~0ULL : 0ULL), v15 = 0x5be0cd19137e2179ULL;
  B2_ROUND(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
  B2_ROUND(14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3);
  B2_ROUND(11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4);
  B2_ROUND(7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8);
  B2_ROUND(9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13);
  B2_ROUND(2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9);
  B2_ROUND(12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11);
  B2_ROUND(13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10);
  B2_ROUND(6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5);
  B2_ROUND(10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0);
  B2_ROUND(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15);
  B2_ROUND(14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3);
  h[0] ^= v0 ^ v8;
  h[1] ^= v1 ^ v9;
  h[2] ^= v2 ^ v10;
  h[3] ^= v3 ^ v11;
  h[4] ^= v4 ^ v12;
  h[5] ^= v5 ^ v13;
  h[6] ^= v6 ^ v14;
  h[7] ^= v7 ^ v15;
}

// The initial state for an unkeyed hash of outlen bytes (sequential mode, fanout = depth = 1).
MK_HD void b2_init(u64 h[8], u32 outlen) {
  h[0] = 0x6a09e667f3bcc908ULL ^ (0x01010000ULL | outlen);
  h[1] = 0xbb67ae8584caa73bULL;
  h[2] = 0x3c6ef372fe94f82bULL;
  h[3] = 0xa54ff53a5f1d36f1ULL;
  h[4] = 0x510e527fade682d1ULL;
  h[5] = 0x9b05688c2b3e6c1fULL;
  h[6] = 0x1f83d9abfb41bd6bULL;
  h[7] = 0x5be0cd19137e2179ULL;
}

// BLAKE2b with outlen bytes of output (the first outlen bytes of h, little-endian words) of a
// message of len <= 128 bytes held in m[] (little-endian words, the rest zero): one compression.
// This is the whole of H0 (96 bytes), of V1 of H' (76 bytes) and of V2 .. V31 (64 bytes).
MK_HD void b2_hash1(u64 h[8], const u64 m[16], u32 len, u32 outlen) {
  b2_init(h, outlen);
  b2_compress(h, m, len, true);
}

// H0, the 64-byte pre-hash of Argon2id (RFC 9106 section 3.2) for MURK: p = 1, tag = 32 bytes,
// m = 4096 KiB, t = 1, v = 0x13, y = 2 (Argon2id), the 40-byte password P (ten little-endian
// words), the 16-byte salt "murkle/mine/salt", no secret, no associated data. 96 bytes.
MK_HD void a2_h0(u64 h[8], const u32 pw[10]) {
  u32 w[24];
  w[0] = 1;
  w[1] = 32;
  w[2] = 4096;
  w[3] = 1;
  w[4] = 0x13;
  w[5] = 2;
  w[6] = 40;
  for (int i = 0; i < 10; i++) w[7 + i] = pw[i];
  w[17] = 16;
  w[18] = MK_LE4('m', 'u', 'r', 'k');
  w[19] = MK_LE4('l', 'e', '/', 'm');
  w[20] = MK_LE4('i', 'n', 'e', '/');
  w[21] = MK_LE4('s', 'a', 'l', 't');
  w[22] = 0;
  w[23] = 0;
  u64 m[16];
  for (int i = 0; i < 12; i++) m[i] = (u64)w[2 * i] | ((u64)w[2 * i + 1] << 32);
  for (int i = 12; i < 16; i++) m[i] = 0;
  b2_hash1(h, m, 96, 64);
}

// H'1024(H0 || LE32 j || LE32 0) (RFC 9106 section 3.3): V1 = BLAKE2b-512(LE32 1024 || X),
// V2 .. V30 = BLAKE2b-512(previous), the output is the first 32 bytes of V1 .. V30 (960 bytes)
// followed by V31 = BLAKE2b-512(V30) in full (64 bytes). out receives the 128 words of the block.
MK_HD void a2_hprime_1024(u64* out, const u64 h0[8], u32 j) {
  u64 m[16];
  m[0] = 1024ULL | ((h0[0] & 0xffffffffULL) << 32);
  for (int k = 1; k < 8; k++) m[k] = (h0[k - 1] >> 32) | ((h0[k] & 0xffffffffULL) << 32);
  m[8] = (h0[7] >> 32) | ((u64)j << 32);
  m[9] = 0;
  for (int k = 10; k < 16; k++) m[k] = 0;
  u64 v[8];
  b2_hash1(v, m, 76, 64);
  for (int w = 0; w < 4; w++) out[w] = v[w];
  for (int i = 2; i <= 30; i++) {
    for (int k = 0; k < 8; k++) m[k] = v[k];
    for (int k = 8; k < 16; k++) m[k] = 0;
    b2_hash1(v, m, 64, 64);
    for (int w = 0; w < 4; w++) out[4 * (i - 1) + w] = v[w];
  }
  for (int k = 0; k < 8; k++) m[k] = v[k];
  b2_hash1(v, m, 64, 64);
  for (int w = 0; w < 8; w++) out[120 + w] = v[w];
}

// BLAKE2b-256 of a short message of len <= 128 bytes (words m[], zero padded), as 32 bytes in
// four little-endian words. Used by the start-up known-answer check.
MK_HD void b2_256_short(u64 out[4], const u64 m[16], u32 len) {
  u64 h[8];
  b2_hash1(h, m, len, 32);
  for (int i = 0; i < 4; i++) out[i] = h[i];
}

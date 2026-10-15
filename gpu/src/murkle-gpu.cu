// SPDX-License-Identifier: GPL-3.0-or-later
//
// murkle-gpu: the Argon2id miner kernel host for MURK (docs/design/mining.md section 12.2).
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
// One process drives one GPU. The Node CLI (src/gpu.mjs) writes plain-text requests to stdin and
// reads JSON lines from stdout; stderr is free text for humans. The protocol (all lines ASCII):
//
//   murkle-gpu --list | --version
//   murkle-gpu --device N [--slots S] [--hashes-per-block W]
//
//   stdin   hash <id> <hex80> [<hex80> ...]      1 .. 4096 passwords of 40 bytes
//           search <id> <challengeHex64> <targetHex64> <nonceStart> <count> <probe>
//           cancel <id>
//           quit                                 (end of input also quits)
//   stdout  {"type":"hello",...} once, then one {"type":"hash"|"search"|"error",...} per request;
//           {"type":"fatal",...} and exit code 2 when the process cannot go on.
//
// The binary only computes: the target comparison is plain memcmp of the 32-byte tag against the
// big-endian target. It never decides what is paid; Node re-checks every candidate it reports.
#include <cuda_runtime.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

#include "argon2.cuh"

// gpu/build.sh and gpu/build.ps1 write gpu/build/stamp.h with the commit the binary was built from.
#if defined(__has_include)
#if __has_include("stamp.h")
#include "stamp.h"
#endif
#endif
#ifndef MURKLE_GPU_GIT
#define MURKLE_GPU_GIT "unknown"
#endif
#define MURKLE_GPU_VERSION "1.0.0"
#define PROTOCOL_VERSION 1

static const size_t SLOT_BYTES = (size_t)A2_SLOT_WORDS * 8;  // 4 MiB
static const u32 MAX_HASH_REQUEST = 4096;
static const size_t MAX_LINE = 8u << 20;
static const u32 MAX_CANDIDATES = 64;
static const double WATCHDOG_MS = 500.0;
static const u64 NO_ID = ~0ULL;

// ------------------------------------------------------------------------------------ output

static std::mutex g_out_mu;

static void emit(const std::string& line) {
  std::lock_guard<std::mutex> lock(g_out_mu);
  fwrite(line.data(), 1, line.size(), stdout);
  fputc('\n', stdout);
  fflush(stdout);
}

static std::string jstr(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') {
      o += '\\';
      o += (char)c;
    } else if (c < 0x20) {
      char b[8];
      snprintf(b, sizeof b, "\\u%04x", c);
      o += b;
    } else {
      o += (char)c;
    }
  }
  return o + "\"";
}

static std::string hexs(const u8* p, size_t n) {
  static const char* d = "0123456789abcdef";
  std::string o(n * 2, '0');
  for (size_t i = 0; i < n; i++) {
    o[2 * i] = d[p[i] >> 4];
    o[2 * i + 1] = d[p[i] & 15];
  }
  return o;
}

static bool unhexs(const std::string& s, u8* out, size_t n) {
  if (s.size() != 2 * n) return false;
  for (size_t i = 0; i < n; i++) {
    int v[2];
    for (int k = 0; k < 2; k++) {
      char c = s[2 * i + k];
      v[k] = c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
      if (v[k] < 0) return false;
    }
    out[i] = (u8)(v[0] * 16 + v[1]);
  }
  return true;
}

static bool parse_u64(const std::string& s, u64* out) {
  if (s.empty() || s.size() > 20) return false;
  u64 v = 0;
  for (char c : s) {
    if (c < '0' || c > '9') return false;
    u64 d = (u64)(c - '0');
    if (v > (~0ULL - d) / 10) return false;
    v = v * 10 + d;
  }
  *out = v;
  return true;
}

[[noreturn]] static void fatal(const char* code, const std::string& msg, int exitCode = 2) {
  emit(std::string("{\"type\":\"fatal\",\"code\":\"") + code + "\",\"error\":" + jstr(msg) + "}");
  fprintf(stderr, "murkle-gpu: %s: %s\n", code, msg.c_str());
  fflush(stderr);
  std::_Exit(exitCode);
}

static void cuda_check(cudaError_t e, const char* what, int line) {
  if (e == cudaSuccess) return;
  std::string msg = std::string(what) + " failed at line " + std::to_string(line) + ": " + cudaGetErrorString(e);
  fatal(e == cudaErrorMemoryAllocation ? "OOM" : "CUDA", msg);
}
#define CK(x) cuda_check((x), #x, __LINE__)

static std::string cc_of(const cudaDeviceProp& p) { return std::to_string(p.major) + "." + std::to_string(p.minor); }
static unsigned long long mib_of(size_t bytes) { return (unsigned long long)(bytes >> 20); }

// ------------------------------------------------------------------------------------ kernels check

// Start-up known-answer check of BLAKE2b on the device and on the host: BLAKE2b-256("abc").
static const char* KAT_ABC = "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319";

extern "C" __global__ void k_kat(u64* out) {
  u64 m[16];
  m[0] = 0x636261ULL;
  for (int i = 1; i < 16; i++) m[i] = 0;
  u64 r[4];
  b2_256_short(r, m, 3);
  for (int i = 0; i < 4; i++) out[i] = r[i];
}

static void blake_known_answer(int dev) {
  (void)dev;
  u64 m[16] = {0x636261ULL};
  u64 r[4];
  b2_256_short(r, m, 3);
  u8 host[32];
  memcpy(host, r, 32);  // little-endian host
  if (hexs(host, 32) != KAT_ABC) fatal("CUDA", "the host BLAKE2b known-answer check failed (a build problem)");
  u64* d = nullptr;
  CK(cudaMalloc(&d, 32));
  k_kat<<<1, 1>>>(d);
  CK(cudaGetLastError());
  u8 dev_out[32];
  CK(cudaMemcpy(dev_out, d, 32, cudaMemcpyDeviceToHost));
  CK(cudaFree(d));
  if (hexs(dev_out, 32) != KAT_ABC) fatal("CUDA", "the device BLAKE2b known-answer check failed (a build problem or a faulty GPU)");
}

// ------------------------------------------------------------------------------------ the engine

struct Engine {
  int dev = 0;
  cudaDeviceProp prop{};
  u32 W = 4;             // warps (hashes) per block
  u32 slots = 0;         // hashes per batch
  u32 allocSlots = 0;    // slots with device memory behind them
  u64* d_mem = nullptr;  // allocSlots * 4 MiB
  u32* d_pw = nullptr;   // allocSlots * 40 bytes
  u64* d_tags = nullptr; // allocSlots * 32 bytes
  u32* h_pw = nullptr;   // pinned
  u8* h_tags = nullptr;  // pinned
  cudaStream_t stream{};
  cudaEvent_t ev0{}, ev1{};
};

static Engine g;

// H2D the first n passwords, hash them, D2H the tags. Returns the k_fill time in ms.
static float run_batch(u32 n) {
  CK(cudaMemcpyAsync(g.d_pw, g.h_pw, (size_t)n * 40, cudaMemcpyHostToDevice, g.stream));
  const u32 initThreads = 2 * n;
  k_init<<<(initThreads + 127) / 128, 128, 0, g.stream>>>(g.d_mem, g.d_pw, n);
  CK(cudaGetLastError());
  CK(cudaEventRecord(g.ev0, g.stream));
  k_fill<<<(n + g.W - 1) / g.W, 32 * g.W, (size_t)g.W * A2_SM_WORDS * 8, g.stream>>>(g.d_mem, n);
  CK(cudaGetLastError());
  CK(cudaEventRecord(g.ev1, g.stream));
  k_final<<<(n + 127) / 128, 128, 0, g.stream>>>(g.d_mem, g.d_tags, n);
  CK(cudaGetLastError());
  CK(cudaMemcpyAsync(g.h_tags, g.d_tags, (size_t)n * 32, cudaMemcpyDeviceToHost, g.stream));
  CK(cudaStreamSynchronize(g.stream));
  float ms = 0;
  CK(cudaEventElapsedTime(&ms, g.ev0, g.ev1));
  return ms;
}

static void set_password(u32 k, const u8 challenge[32], u64 nonce) {
  u8* p = reinterpret_cast<u8*>(g.h_pw) + (size_t)k * 40;
  memcpy(p, challenge, 32);
  memcpy(p + 32, &nonce, 8);  // u64 little-endian: x86-64 hosts only (checked in main)
}

// ------------------------------------------------------------------------------------ requests

static std::mutex g_q_mu;
static std::condition_variable g_q_cv;
static std::deque<std::string> g_queue;
static std::atomic<bool> g_quit{false};
static std::atomic<u64> g_cancel_id{NO_ID};

static void reader_thread() {
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line.size() > MAX_LINE) line = "\x01toolong";
    if (line == "quit") break;
    if (line.compare(0, 7, "cancel ") == 0) {
      u64 id;
      if (parse_u64(line.substr(7), &id)) g_cancel_id.store(id);
      continue;
    }
    {
      std::lock_guard<std::mutex> lock(g_q_mu);
      g_queue.push_back(line);
    }
    g_q_cv.notify_one();
  }
  g_quit.store(true);  // "quit" or the end of input: the binary never outlives Node
  g_q_cv.notify_all();
}

static void send_error(u64 id, const char* code, const std::string& msg) {
  std::string o = "{\"type\":\"error\",\"id\":";
  o += id == NO_ID ? "null" : std::to_string(id);
  o += std::string(",\"code\":\"") + code + "\",\"error\":" + jstr(msg) + "}";
  emit(o);
}

static std::vector<std::string> split(const std::string& s) {
  std::vector<std::string> out;
  size_t i = 0;
  for (;;) {
    size_t j = s.find(' ', i);
    out.push_back(s.substr(i, j == std::string::npos ? std::string::npos : j - i));
    if (j == std::string::npos) break;
    i = j + 1;
  }
  return out;
}

static void do_hash(u64 id, const std::vector<std::string>& t) {
  const size_t n = t.size() - 2;
  if (n < 1 || n > MAX_HASH_REQUEST) return send_error(id, "BAD_REQUEST", "hash takes 1 to 4096 passwords");
  std::vector<u8> pw(n * 40);
  for (size_t i = 0; i < n; i++) {
    if (!unhexs(t[2 + i], pw.data() + i * 40, 40)) return send_error(id, "BAD_REQUEST", "a password must be 80 lowercase hex characters");
  }
  std::string o = "{\"type\":\"hash\",\"id\":" + std::to_string(id) + ",\"ok\":true,\"hashes\":[";
  for (size_t at = 0; at < n; at += g.slots) {
    const u32 b = (u32)std::min<size_t>(g.slots, n - at);
    memcpy(g.h_pw, pw.data() + at * 40, (size_t)b * 40);
    run_batch(b);
    for (u32 k = 0; k < b; k++) {
      if (at + k) o += ',';
      o += '"' + hexs(g.h_tags + (size_t)k * 32, 32) + '"';
    }
  }
  o += "]}";
  emit(o);
}

struct Candidate {
  u64 nonce;
  u8 tag[32];
};

static void do_search(u64 id, const std::vector<std::string>& t) {
  u8 challenge[32], target[32];
  u64 nonceStart, count, probe;
  if (t.size() != 7 || !unhexs(t[2], challenge, 32) || !unhexs(t[3], target, 32) || !parse_u64(t[4], &nonceStart) || !parse_u64(t[5], &count) ||
      !parse_u64(t[6], &probe)) {
    return send_error(id, "BAD_REQUEST", "usage: search <id> <challengeHex64> <targetHex64> <nonceStart> <count> <probe>");
  }
  if (count < 1 || count > 9007199254740991ULL) return send_error(id, "BAD_REQUEST", "count must be 1 to 2^53-1");
  if (probe >= count) return send_error(id, "BAD_REQUEST", "probe must be 0 to count-1");

  const auto t0 = std::chrono::steady_clock::now();
  u64 done = 0, total = 0;
  std::vector<Candidate> found;
  bool haveProbe = false, cancelled = false;
  u8 probeTag[32];
  while (done < count) {
    if (g_quit.load() || g_cancel_id.load() == id) {
      cancelled = true;
      break;
    }
    const u32 n = (u32)std::min<u64>(g.slots, count - done);
    for (u32 k = 0; k < n; k++) set_password(k, challenge, nonceStart + done + k);
    run_batch(n);
    for (u32 k = 0; k < n; k++) {
      const u8* tag = g.h_tags + (size_t)k * 32;
      if (memcmp(tag, target, 32) <= 0) {
        total++;
        if (found.size() < MAX_CANDIDATES) {
          Candidate c;
          c.nonce = nonceStart + done + k;
          memcpy(c.tag, tag, 32);
          found.push_back(c);
        }
      }
    }
    if (probe >= done && probe < done + n) {
      memcpy(probeTag, g.h_tags + (size_t)(probe - done) * 32, 32);
      haveProbe = true;
    }
    done += n;
    if (total > 0) break;  // the search stops after the batch in which the first candidate appears
  }
  u64 expected = id;
  g_cancel_id.compare_exchange_strong(expected, NO_ID);
  const long long ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
  std::string o = "{\"type\":\"search\",\"id\":" + std::to_string(id) + ",\"ok\":true,\"done\":\"" + std::to_string(done) + "\",\"ms\":" + std::to_string(ms) +
                  ",\"cancelled\":" + (cancelled ? "true" : "false") + ",\"candidates\":[";
  for (size_t i = 0; i < found.size(); i++) {
    if (i) o += ',';
    o += "{\"nonce\":\"" + std::to_string(found[i].nonce) + "\",\"hash\":\"" + hexs(found[i].tag, 32) + "\"}";
  }
  o += "],\"more\":" + std::to_string(total - found.size()) + ",\"probe\":";
  o += haveProbe ? "\"" + hexs(probeTag, 32) + "\"" : "null";
  o += "}";
  emit(o);
}

static void handle(const std::string& line) {
  if (line == "\x01toolong") return send_error(NO_ID, "BAD_REQUEST", "request line too long");
  const std::vector<std::string> t = split(line);
  u64 id = NO_ID;
  if (t.size() >= 2 && !parse_u64(t[1], &id)) id = NO_ID;
  if (t[0] == "hash" && t.size() >= 3 && id != NO_ID) return do_hash(id, t);
  if (t[0] == "search" && t.size() >= 2 && id != NO_ID) return do_search(id, t);
  send_error(id, "BAD_REQUEST", "unknown or malformed request");
}

// ------------------------------------------------------------------------------------ main

static void usage_fatal(const std::string& why) {
  fatal("BAD_ARGS", why + "; usage: murkle-gpu --list | --version | --device N [--slots S] [--hashes-per-block W]");
}

static bool arg_u32(const char* s, u64 lo, u64 hi, u64* out) {
  u64 v;
  if (!parse_u64(s, &v) || v < lo || v > hi) return false;
  *out = v;
  return true;
}

static void list_devices() {
  int count = 0;
  cudaError_t e = cudaGetDeviceCount(&count);
  if (e == cudaErrorNoDevice || e == cudaErrorInsufficientDriver) fatal("NO_DEVICE", std::string("no CUDA device: ") + cudaGetErrorString(e));
  CK(e);
  for (int i = 0; i < count; i++) {
    cudaDeviceProp p;
    CK(cudaGetDeviceProperties(&p, i));
    emit("{\"type\":\"device\",\"index\":" + std::to_string(i) + ",\"name\":" + jstr(p.name) + ",\"cc\":\"" + cc_of(p) + "\",\"vramMiB\":" +
         std::to_string(mib_of(p.totalGlobalMem)) + "}");
  }
  emit("{\"type\":\"list\",\"count\":" + std::to_string(count) + "}");
}

int main(int argc, char** argv) {
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  {
    const u32 one = 1;
    if (*reinterpret_cast<const u8*>(&one) != 1) fatal("CUDA", "this build needs a little-endian host");
  }
  bool list = false, version = false, haveDevice = false, haveSlots = false;
  u64 device = 0, slotsArg = 0, wArg = 4;
  for (int i = 1; i < argc; i++) {
    const std::string a = argv[i];
    auto value = [&](u64 lo, u64 hi, u64* out) {
      if (i + 1 >= argc || !arg_u32(argv[i + 1], lo, hi, out)) usage_fatal(a + " needs a whole number from " + std::to_string(lo) + " to " + std::to_string(hi));
      i++;
    };
    if (a == "--list") list = true;
    else if (a == "--version") version = true;
    else if (a == "--device") {
      value(0, 999, &device);
      haveDevice = true;
    } else if (a == "--slots") {
      value(1, 1u << 20, &slotsArg);
      haveSlots = true;
    } else if (a == "--hashes-per-block") {
      value(1, 8, &wArg);
      if (wArg != 1 && wArg != 2 && wArg != 4 && wArg != 8) usage_fatal("--hashes-per-block must be 1, 2, 4 or 8");
    } else usage_fatal("unknown argument " + a);
  }
  if (version) {
    const int v = CUDART_VERSION;
    emit(std::string("{\"version\":\"") + MURKLE_GPU_VERSION + "\",\"cuda\":\"" + std::to_string(v / 1000) + "." + std::to_string((v % 1000) / 10) + "\",\"git\":" +
         jstr(MURKLE_GPU_GIT) + "}");
    return 0;
  }
  if (list) {
    list_devices();
    return 0;
  }
  if (!haveDevice) usage_fatal("--device N is required");

  // ---- the device
  signal(SIGINT, SIG_IGN);  // Node owns the shutdown; the process ends at "quit" or when stdin closes
  int count = 0;
  cudaError_t ce = cudaGetDeviceCount(&count);
  if (ce == cudaErrorNoDevice || ce == cudaErrorInsufficientDriver || count == 0) fatal("NO_DEVICE", "no CUDA device (a driver of version 525 or newer is needed)");
  CK(ce);
  if ((int)device >= count) fatal("BAD_DEVICE", "no device " + std::to_string(device) + "; this machine has " + std::to_string(count));
  g.dev = (int)device;
  g.W = (u32)wArg;
  CK(cudaSetDevice(g.dev));
  CK(cudaSetDeviceFlags(cudaDeviceScheduleBlockingSync));  // wait for the GPU without spinning a CPU core
  CK(cudaGetDeviceProperties(&g.prop, g.dev));
  CK(cudaFree(0));
  size_t freeB = 0, totalB = 0;
  CK(cudaMemGetInfo(&freeB, &totalB));

  const u32 unit = (u32)g.prop.multiProcessorCount * g.W;
  u64 slots;
  if (haveSlots) {
    slots = slotsArg;
    if ((u64)slots * SLOT_BYTES > freeB) fatal("OOM", "--slots " + std::to_string(slots) + " needs " + std::to_string(mib_of(slots * SLOT_BYTES)) + " MiB but only " + std::to_string(mib_of(freeB)) + " MiB are free");
  } else {
    const size_t reserve = std::max<size_t>((size_t)512 << 20, totalB / 10);
    slots = freeB > reserve ? (freeB - reserve) / SLOT_BYTES : 0;
    // The Vast sweep (RTX 4090) ran as fast at 25 % of the old default as at 100 %: leave the rest to a display or a game.
    slots = std::min<u64>(slots, (freeB / 4) / SLOT_BYTES);
    if (slots >= unit) slots -= slots % unit;
    else slots -= slots % g.W;
    if (slots > (1u << 20)) slots = 1u << 20;
    if (slots < 1) fatal("OOM", "not enough free GPU memory: " + std::to_string(mib_of(freeB)) + " MiB free");
  }
  // Allocate; with the default size, shrink by an eighth a few times before giving up.
  for (int attempt = 0;; attempt++) {
    cudaError_t e = cudaMalloc(&g.d_mem, (size_t)slots * SLOT_BYTES);
    if (e == cudaSuccess) break;
    cudaGetLastError();
    if (haveSlots || attempt >= 8 || slots < 2 * g.W) cuda_check(e, "cudaMalloc(slots)", __LINE__);
    slots -= std::max<u64>(g.W, (slots / 8) - (slots / 8) % g.W);
  }
  g.slots = g.allocSlots = (u32)slots;
  CK(cudaMalloc(&g.d_pw, (size_t)g.allocSlots * 40));
  CK(cudaMalloc(&g.d_tags, (size_t)g.allocSlots * 32));
  CK(cudaMallocHost(&g.h_pw, (size_t)g.allocSlots * 40));
  CK(cudaMallocHost(&g.h_tags, (size_t)g.allocSlots * 32));
  CK(cudaStreamCreate(&g.stream));
  CK(cudaEventCreate(&g.ev0));
  CK(cudaEventCreate(&g.ev1));

  blake_known_answer(g.dev);
  k_reftable<<<1, 32, A2_SM_WORDS * 8>>>();
  CK(cudaGetLastError());
  CK(cudaDeviceSynchronize());

  // ---- watchdog: a batch whose k_fill runs longer than 500 ms risks the Windows display watchdog
  // (and slows cancel). Run one batch of zero passwords; with the default size halve it until it fits.
  for (;;) {
    memset(g.h_pw, 0, (size_t)g.slots * 40);
    const float ms = run_batch(g.slots);
    if (ms <= WATCHDOG_MS) break;
    if (haveSlots || g.slots <= g.W) {
      fprintf(stderr, "murkle-gpu: warning: a batch of %u hashes takes %.0f ms; use fewer --slots if the display freezes\n", g.slots, ms);
      break;
    }
    const u32 next = std::max<u32>(g.W, (g.slots / 2) - (g.slots / 2) % g.W);
    fprintf(stderr, "murkle-gpu: a batch of %u hashes took %.0f ms (over %.0f ms); using %u\n", g.slots, ms, WATCHDOG_MS, next);
    g.slots = next;
  }

  emit("{\"type\":\"hello\",\"protocol\":" + std::to_string(PROTOCOL_VERSION) + ",\"version\":\"" MURKLE_GPU_VERSION "\",\"device\":" + std::to_string(g.dev) +
       ",\"name\":" + jstr(g.prop.name) + ",\"cc\":\"" + cc_of(g.prop) + "\",\"sms\":" + std::to_string(g.prop.multiProcessorCount) + ",\"vramMiB\":" +
       std::to_string(mib_of(g.prop.totalGlobalMem)) + ",\"slots\":" + std::to_string(g.slots) + ",\"hashesPerBlock\":" + std::to_string(g.W) + "}");

  std::thread(reader_thread).detach();
  for (;;) {
    std::string line;
    {
      std::unique_lock<std::mutex> lock(g_q_mu);
      g_q_cv.wait(lock, [] { return g_quit.load() || !g_queue.empty(); });
      if (g_quit.load()) break;
      line = std::move(g_queue.front());
      g_queue.pop_front();
    }
    handle(line);
  }
  cudaFree(g.d_mem);
  cudaFree(g.d_pw);
  cudaFree(g.d_tags);
  cudaFreeHost(g.h_pw);
  cudaFreeHost(g.h_tags);
  fflush(stdout);
  std::_Exit(0);  // the reader thread may still wait on stdin
}

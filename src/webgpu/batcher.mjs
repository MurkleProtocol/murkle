// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner prototype: the batching logic that does not need a GPU.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// createSearch({ runBatch, slots, pipelineDepth }) turns "hash `slots` passwords at once" into the hash() and
// search() of a GpuDevice (src/gpu.mjs): batching, padding, a pipeline of batches in flight, the candidate
// scan, the probe, `done` accounting, cancel and the time limit. runBatch is the only thing that touches a
// GPU; the tests drive this module with a fake one.
//
//   runBatch(passwords: Uint8Array(slots * 40)) -> Promise<Uint8Array(slots * 32)>
//     slots passwords packed one after the other (the unused tail of a short batch is padded with copies of
//     the last real password), the tags in the same order. The array is fresh for every call.
//
// Semantics of search (the ones of GpuDevice, which gpuSelfTest and GpuLane rely on):
//   - at most 64 candidates, in nonce order, and `more` counts the rest;
//   - it stops after the batch in which the first candidate appears; `done` counts the nonces through that
//     batch only, a later batch already in flight is discarded and not counted;
//   - the probe tag is returned when the probe nonce was hashed (inside a counted batch);
//   - count < slots hashes a padded batch and done === count;
//   - an abort is looked at between batches: cancelled: true, done counts the batches finished before it;
//   - a runBatch rejection leaves as a GpuError with the same code (anything else becomes GPU_EXITED).
// Isomorphic.
import { GpuError, asBig, challengeBytes, counterBig } from "../gpu-gate.mjs";

export const PASSWORD_BYTES = 40;
export const TAG_BYTES = 32;
export const MAX_CANDIDATES = 64;
const MAX_TARGET = (1n << 256n) - 1n;
const U64 = (1n << 64n) - 1n;
const MAX_COUNT = (1n << 53n) - 1n;
const DEFAULT_SEARCH_TIMEOUT_MS = 120_000;

const asGpuError = (e) => (e instanceof GpuError ? e : new GpuError(`the WebGPU batch failed: ${e?.message ?? e}`, "GPU_EXITED", { cause: e }));

/** The 64-bit counter { lo, hi } (u32 words) of a BigInt below 2^64. */
const pairOfBig = (v) => ({ lo: Number(v & 0xffffffffn), hi: Number((v >> 32n) & 0xffffffffn) });

/** c + n for a safe integer n >= 0, mod 2^64, without BigInt. */
function pairPlus(c, n) {
  const loSum = c.lo + (n % 4294967296);
  return { lo: loSum >>> 0, hi: (c.hi + Math.floor(n / 4294967296) + (loSum > 0xffffffff ? 1 : 0)) >>> 0 };
}

/** The big-endian 32-bit words of a 256-bit target. */
function targetWords(t) {
  const w = new Uint32Array(8);
  for (let k = 0; k < 8; k++) w[k] = Number((t >> BigInt(32 * (7 - k))) & 0xffffffffn);
  return w;
}

/** int_BE(tag) <= target, comparing 32-bit big-endian words, first word first. */
function tagMeets(dv, off, tw) {
  for (let k = 0; k < 8; k++) {
    const a = dv.getUint32(off + 4 * k, false);
    if (a !== tw[k]) return a < tw[k];
  }
  return true;
}

const nonceBytes = (lo, hi) => {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, lo, true);
  dv.setUint32(4, hi, true);
  return b;
};

/**
 * -> { slots, hash(passwords), search({ challenge, target, nonceStart, count, probe = 0, signal, timeoutMs }) }
 * clock: () => milliseconds (default performance.now), for tests.
 */
export function createSearch({ runBatch, slots, pipelineDepth = 2, clock = () => globalThis.performance.now() }) {
  if (typeof runBatch !== "function") throw new TypeError("runBatch must be a function");
  if (!Number.isSafeInteger(slots) || slots < 1) throw new RangeError("slots must be a positive integer");
  if (!Number.isSafeInteger(pipelineDepth) || pipelineDepth < 1 || pipelineDepth > 3) throw new RangeError("pipelineDepth must be 1 .. 3");

  /** Starts one batch; the promise resolves to its tags (the first n are real). Rejections are GpuErrors. */
  const launch = (pw) => {
    let p;
    try {
      p = Promise.resolve(runBatch(pw));
    } catch (e) {
      p = Promise.reject(e);
    }
    const out = p.then(
      (tags) => {
        if (!(tags instanceof Uint8Array) || tags.length !== slots * TAG_BYTES) throw new GpuError(`runBatch returned ${tags?.length} bytes where ${slots * TAG_BYTES} were expected`, "GPU_PROTOCOL");
        return tags;
      },
      (e) => {
        throw asGpuError(e);
      },
    );
    out.catch(() => {}); // a batch that fails while another is awaited must not be an unhandled rejection
    return out;
  };

  /** Pads the unused tail of a packed batch (n real passwords) with copies of the last real one. */
  const pad = (pw, n) => {
    const last = pw.subarray((n - 1) * PASSWORD_BYTES, n * PASSWORD_BYTES);
    for (let i = n; i < slots; i++) pw.set(last, i * PASSWORD_BYTES);
    return pw;
  };

  /** Waits for every launched batch and drops the results (and the errors: the first error was already reported). */
  const drain = async (queue) => {
    await Promise.all(queue.map((q) => q.promise.catch(() => {})));
    queue.length = 0;
  };

  async function hash(passwords) {
    for (const p of passwords) {
      if (!(p instanceof Uint8Array) || p.length !== PASSWORD_BYTES) throw new TypeError(`password must be ${PASSWORD_BYTES} bytes`);
    }
    const out = new Array(passwords.length);
    const queue = [];
    let next = 0;
    try {
      while (next < passwords.length || queue.length) {
        while (next < passwords.length && queue.length < pipelineDepth) {
          const n = Math.min(slots, passwords.length - next);
          const pw = new Uint8Array(slots * PASSWORD_BYTES);
          for (let i = 0; i < n; i++) pw.set(passwords[next + i], i * PASSWORD_BYTES);
          pad(pw, n);
          queue.push({ first: next, n, promise: launch(pw) });
          next += n;
        }
        const head = queue.shift();
        const tags = await head.promise;
        for (let i = 0; i < head.n; i++) out[head.first + i] = tags.slice(i * TAG_BYTES, (i + 1) * TAG_BYTES);
      }
    } catch (e) {
      await drain(queue);
      throw e;
    }
    return out;
  }

  async function search({ challenge, target, nonceStart, count, probe = 0, signal, timeoutMs = DEFAULT_SEARCH_TIMEOUT_MS }) {
    const ch = challengeBytes(challenge);
    const tgt = typeof target === "string" ? BigInt(`0x${target}`) : asBig(target, "target");
    if (tgt < 0n || tgt > MAX_TARGET) throw new RangeError("target must be 0 .. 2^256 - 1");
    const start = counterBig(nonceStart);
    if (start < 0n || start > U64) throw new RangeError("nonceStart must be 0 .. 2^64 - 1");
    const n = asBig(count, "count");
    if (n < 1n || n > MAX_COUNT) throw new RangeError("count must be 1 .. 2^53 - 1");
    const pr = asBig(probe, "probe");
    if (pr < 0n || pr >= n) throw new RangeError("probe must be 0 .. count - 1");
    const total = Number(n);
    const probeAt = Number(pr);
    if (signal?.aborted) return { done: 0n, ms: 0, cancelled: true, candidates: [], more: 0, probe: null };

    const tw = targetWords(tgt);
    const base = pairOfBig(start);
    const t0 = clock();
    const queue = [];
    let issued = 0; // nonces handed to batches
    let done = 0; // nonces in counted batches
    let cancelled = false;
    let stop = false;
    let hits = 0;
    const candidates = [];
    let probeResult = null;

    const issueBatch = () => {
      const size = Math.min(slots, total - issued);
      const first = issued;
      const c = pairPlus(base, first); // the nonce counter of the batch's first password
      const pw = new Uint8Array(slots * PASSWORD_BYTES);
      const view = new DataView(pw.buffer);
      let lo = c.lo;
      let hi = c.hi;
      for (let i = 0; i < size; i++) {
        const o = i * PASSWORD_BYTES;
        pw.set(ch, o);
        view.setUint32(o + 32, lo, true);
        view.setUint32(o + 36, hi, true);
        lo = (lo + 1) >>> 0;
        if (lo === 0) hi = (hi + 1) >>> 0;
      }
      pad(pw, size);
      queue.push({ first, size, c, promise: launch(pw) });
      issued += size;
    };
    const entry = (head, i, tags) => {
      const nc = pairPlus(head.c, i);
      return { nonce: nonceBytes(nc.lo, nc.hi), hash: tags.slice(i * TAG_BYTES, (i + 1) * TAG_BYTES) };
    };

    try {
      for (;;) {
        while (!stop && issued < total && queue.length < pipelineDepth) {
          if (signal?.aborted) {
            cancelled = true;
            stop = true;
            break;
          }
          if (clock() - t0 > timeoutMs) throw new GpuError(`the search did not finish within ${timeoutMs} ms`, "GPU_TIMEOUT");
          issueBatch();
        }
        if (stop || !queue.length) break; // a batch still in flight after a stop is discarded below
        const head = queue.shift();
        const tags = await head.promise;
        const dv = new DataView(tags.buffer, tags.byteOffset, tags.byteLength);
        done += head.size;
        for (let i = 0; i < head.size; i++) {
          if (tagMeets(dv, i * TAG_BYTES, tw)) {
            hits++;
            if (candidates.length < MAX_CANDIDATES) candidates.push(entry(head, i, tags));
          }
        }
        if (probeAt >= head.first && probeAt < head.first + head.size) probeResult = entry(head, probeAt - head.first, tags);
        if (hits > 0) stop = true;
        else if (signal?.aborted && done < total) {
          cancelled = true;
          stop = true;
        }
        if (stop) break;
      }
    } catch (e) {
      await drain(queue);
      throw e;
    }
    await drain(queue); // a batch still in flight after a hit or a cancel: wait for it, discard it
    return { done: BigInt(done), ms: clock() - t0, cancelled, candidates, more: hits - candidates.length, probe: probeResult };
  }

  return { slots, pipelineDepth, hash, search };
}

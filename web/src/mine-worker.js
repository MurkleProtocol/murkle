// Mining worker: one module Web Worker per mining thread (mining-contract.md §10.2,
// mining.md §12.1). Argon2id runs here and never on the page's main thread.
//
// It runs the Argon2 self-test of src/mine.mjs first (hash-wasm against the pinned
// vectors, then the noble reference against the same vectors and RFC 9106). A fast path
// that fails is disabled and the worker mines with the reference ("Slow mode", about 10x
// slower); a reference that fails refuses to mine at all.
//
// Protocol
//   in  { type: "start", challenge: hex64, target: hex64, nonceStart: hex16, step: 1, progressMs: 1000 }
//   in  { type: "stop" }
//   in  { type: "verify", id, password: hex80 }      the reference (noble) Argon2id of one password
//   in  { type: "disable", reason }                  the page's reference re-check disagreed: noble from now on
//   out { type: "ready", ok, impl: "hash-wasm" | "noble" | null }   after the self-test (again after "disable")
//   out { type: "progress", hashes, ms }             hashes tried since the last progress message
//   out { type: "found", nonce: hex16, powHash: hex64, hashes }      then it idles until the next "start"
//   out { type: "verified", id, powHash: hex64 } | { type: "verified", id, error }
//   out { type: "error", message }
// A start may carry an `id` (any string or number): progress and found messages of that search
// echo it, so the page never takes a solution of an older challenge for the current one.
// A start while another search runs replaces it (a new tip, a new challenge). Nonces are the
// miners' counter encoding (u64 LE), stepping by 1 from nonceStart; a missing nonceStart is
// drawn at random, so two workers never search the same range by accident.
import * as mineLib from "../../src/mine.mjs";

const HEX = /^[0-9a-f]*$/;
const toHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const fromHex = (h) => Uint8Array.from(String(h).match(/../g) ?? [], (x) => parseInt(x, 16));
const hexOf = (v, len, what) => {
  const s = String(v ?? "").toLowerCase();
  if (s.length !== len * 2 || !HEX.test(s)) throw new TypeError(`${what} must be ${len} bytes of hex`);
  return s;
};
const randomNonce = () => toHex(globalThis.crypto.getRandomValues(new Uint8Array(8)));
const macrotask = () => new Promise((r) => setTimeout(r, 0));
const idOf = (job) => (job?.id != null ? { id: job.id } : {});

/** The page's copy for the two self-test outcomes that need one (the strings of mining-contract.md §12). */
export const WORKER_TEXT = {
  slow: "Slow mode: this browser's fast hash failed its test.",
  off: "This browser computed a test hash wrong; mining is off.",
};

/**
 * The worker's logic, independent of the worker global (tests drive it directly).
 *   mine   src/mine.mjs or a stand-in with the same selfTest, grindRange, powHashReference,
 *          disableFastPath and fastPathState
 *   post   (message) => void
 *   now    clock in ms; yieldNow () => Promise that lets queued messages in between slices
 * Returns { onMessage(msg), ready: Promise<{ ok, impl }>, state() }.
 */
export function createMiner({ mine = mineLib, post, now = () => Date.now(), yieldNow = macrotask, slice = 4, maxSlice = 64, sliceMs = 50 } = {}) {
  let job = null; // the search in progress
  let gen = 0; // bumped by every start and stop: an older loop sees it and ends
  let self = { ok: false, impl: null };
  const ready = Promise.resolve()
    .then(() => mine.selfTest())
    .then(
      (r) => (self = { ok: Boolean(r?.ok), impl: r?.ok ? r.impl : null }),
      () => (self = { ok: false, impl: null }),
    )
    .then((r) => {
      post({ type: "ready", ok: r.ok, impl: r.impl });
      return r;
    });

  async function grind(my) {
    const j = job; // this search; a start or a stop replaces `job` and bumps `gen`
    let n = slice;
    let sinceMs = now();
    let since = 0;
    // The hashes since the last progress message, reported when the search ends early (a stop
    // or a new start), so the page's hashrate counts every hash this worker computed.
    const flush = () => {
      if (since > 0) post({ type: "progress", hashes: since, ms: Math.max(1, now() - sinceMs), ...idOf(j) });
      since = 0;
    };
    while (j && gen === my) {
      const t0 = now();
      let r;
      try {
        r = await mine.grindRange({ challenge: j.challenge, target: j.target, nonceStart: j.counter, count: n });
      } catch (e) {
        // An Argon2 failure is never a "no solution": stop and say so.
        if (gen === my) {
          job = null;
          post({ type: "error", message: e?.message ?? String(e) });
        } else flush();
        return;
      }
      since += r.tried; // computed, whatever happens to the search now
      if (gen !== my) {
        // Stopped or restarted while hashing: the slice's solution (if any) is dropped, its hashes counted.
        flush();
        return;
      }
      j.counter = (j.counter + BigInt(r.tried)) & ((1n << 64n) - 1n);
      j.hashes += r.tried;
      if (r.nonce) {
        job = null;
        flush();
        post({ type: "found", nonce: toHex(r.nonce), powHash: toHex(r.powHash), hashes: j.hashes, ...idOf(j) });
        return;
      }
      const t = now();
      if (t - sinceMs >= j.progressMs) {
        post({ type: "progress", hashes: since, ms: t - sinceMs, ...idOf(j) });
        since = 0;
        sinceMs = t;
      }
      // Slices of about sliceMs, so a stop or a new start is seen quickly.
      const took = Math.max(1, t - t0);
      n = Math.max(1, Math.min(maxSlice, Math.round((n * sliceMs) / took)));
      await yieldNow();
    }
    flush();
  }

  async function start(msg) {
    const my = ++gen;
    let challenge;
    let target;
    let nonceStart;
    try {
      challenge = hexOf(msg.challenge, 32, "challenge");
      target = hexOf(msg.target, 32, "target");
      nonceStart = msg.nonceStart == null ? randomNonce() : hexOf(msg.nonceStart, 8, "nonceStart");
      if (msg.step != null && Number(msg.step) !== 1) throw new RangeError("step must be 1");
    } catch (e) {
      job = null;
      post({ type: "error", message: e.message });
      return;
    }
    await ready;
    if (my !== gen) return;
    if (!self.ok) {
      job = null;
      post({ type: "error", message: WORKER_TEXT.off });
      return;
    }
    const progressMs = Number.isFinite(Number(msg.progressMs)) && Number(msg.progressMs) > 0 ? Number(msg.progressMs) : 1000;
    job = { id: msg.id ?? null, challenge, target, counter: mine.counterOf ? mine.counterOf(fromHex(nonceStart)) : BigInt(`0x${toHex(fromHex(nonceStart).reverse())}`), progressMs, hashes: 0 };
    return grind(my);
  }

  async function verify(msg) {
    try {
      const pw = hexOf(msg.password, 40, "password");
      const out = mine.powHashReference(fromHex(pw));
      post({ type: "verified", id: msg.id, powHash: toHex(out) });
    } catch (e) {
      post({ type: "verified", id: msg.id, error: e?.message ?? String(e) });
    }
  }

  function onMessage(msg) {
    switch (msg?.type) {
      case "start":
        return start(msg);
      case "stop":
        gen++;
        job = null;
        return;
      case "verify":
        return verify(msg);
      case "disable":
        mine.disableFastPath(msg.reason ?? "disabled by the page");
        return ready.then(() => {
          if (self.ok) self = { ok: true, impl: "noble" };
          post({ type: "ready", ok: self.ok, impl: self.impl });
        });
      default:
        post({ type: "error", message: `unknown message ${String(msg?.type)}` });
    }
  }

  return { onMessage, ready, state: () => ({ running: Boolean(job), ...self }) };
}

// In a dedicated worker: wire the logic to the worker's own message port.
if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  const miner = createMiner({ post: (m) => globalThis.postMessage(m) });
  globalThis.addEventListener("message", (e) => miner.onMessage(e.data));
}

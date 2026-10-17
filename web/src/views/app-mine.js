// /app/mine: mine a token by proof of work (mining-contract.md §10.3, mining.md §12.1).
//
// Workers (web/src/mine-worker.js, one module worker per thread) grind Argon2id nonces for the
// current challenge; the page never hashes on its main thread. Each challenge commits to fresh
// output notes (session.prepareMine), so the page builds a new one on every new block and right
// after every solution, then restarts the workers. A found solution is re-checked with the
// reference implementation (in a worker) and the block hash from mempool.space before anything
// is paid; the claim then goes through the chosen route (relay balance, the built-in mining
// key, or Unisat) and is recorded under W-M: one solution, one route.
//
// Copy is mining-contract.md §12: the reward goes to a private note; the claim itself is public.
//
// The graphics card (beta) is an opt-in box, unticked on every page load and never stored. Its worker
// (web/src/gpu/gpu-worker.js) is created only inside the box's change handler, so a page load never fetches it,
// and this file holds no WebGPU code. Claims are proved one at a time, oldest reference block first; a solution that
// cannot be paid yet (no coin with room in the chain) waits and is tried again on every new block while it stays valid.
// Memory: ticking the box moves the threads slider to 2, a proof ends the processor workers while it runs (holdCpu), a proof that
// runs out of memory is a refusal the page retries (prove_memory), and a claim that has not finished after 3 minutes no longer holds the
// queue (ClaimQueue). The "Graphics memory" choice (2 / 4 / 8 GiB, default 4) is the one thing remembered (share/gpu-memory.js).
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { int, sats, heightText, plural, DASH } from "../ui/format.js";
import { button, panel, payerCard, progress, kv, empty, tag } from "../ui/components.js";
import { prov } from "../ui/prov.js";
import { sigil } from "../ui/sigil.js";
import { toast } from "../ui/toast.js";
import { hex } from "../../../src/bytes.mjs";
import { capRisk, capWarningText, targetHex } from "../../../src/mine.mjs";
import { MINE_FEE, mineFeeReady } from "../../../src/params.mjs";
import { IS_SIGNET } from "../config.js";
import * as api from "../api.js";
import { CHAIN_ROOM, mineCoinSummary, mineFeeOutputs, mineQuote, mineWindowLeft, nextBlockRate, MINE_PENDING, PROVE_MEMORY_TEXT } from "../session.js";
import { mixState, poolMix, relayOpen } from "../relay.js";
import { UNISAT_SIGNET_NOTICE } from "../payers.js";
import { GPU_MEMORY_CHOICES, gpuMemoryLabel, readGpuMemory, saveGpuMemory } from "../share/gpu-memory.js";
// A stub (null) in every build but a lab build (web/lab-plugin.mjs): only the stub GPU worker and the fault hook of the
// lab checks come from it. The GPU (beta) box itself is in every build.
import { labGpu } from "virtual:murkle-lab";
import {
  withWallet, pageHead, wireStreamer, liveSession, amountHTML, amountText, btcHTML, satsHTML, callout, statusChip, MINE_TEXT, mineCopy, RELAY_TEXT,
} from "./app-shared.js";

/** The box a relayed claim needs while the relay pool is thin (privacy-trace-test.md L1). */
export const MINE_LINKABLE = "Relay my claims linkable: I accept that Bitcoin ties them to the address I topped up from.";

/**
 * The relay pool's lineage under the relay route: thin shows the warning with the
 * "linkable" box (unticked, a relayed claim is refused before it leaves); unknown says the
 * claims may be tied to the top-up address. "" when the pool has cover.
 */
export function mineMixBlock(info, linkable = false, refused = false) {
  // refused: the relayer answered pool_thin for this account although info said it has cover.
  const mix = refused ? "thin" : mixState(info);
  if (mix === "ok") return "";
  if (mix === "unknown") return callout(RELAY_TEXT.mixUnknown, "warn");
  return html`<div class="callout callout--warn" data-pool-thin>${icon("warn", { size: 16 })}<div>
    <p>${RELAY_TEXT.thin({ k: poolMix(info)?.k ?? null })} Pay with the mining key, or tick the box to relay them linkable.</p>
    <label class="cluster small" style="margin-top:6px"><input type="checkbox" name="mine-linkable"${linkable ? html` checked` : ""}><span>${MINE_LINKABLE}</span></label>
  </div></div>`;
}

export const POLL_MS = 15_000;
/** How often the oldest solution that waits for chain room tries again while the queue is idle (a block's carriers may be confirmed a few seconds after the wallet saw the block). */
export const PROBE_MS = 30_000;
const RATE_WINDOW_MS = 10_000;

/* ---------- pure helpers (tested in test/mine-web.test.mjs) ---------- */

/** Threads the slider offers: 1 … hardwareConcurrency − 1 (at least 1), default half. */
export function threadRange(hc = globalThis.navigator?.hardwareConcurrency) {
  const n = Number.isInteger(hc) && hc > 0 ? hc : 2;
  const max = Math.max(1, n - 1);
  return { min: 1, max, value: Math.max(1, Math.min(max, Math.floor(n / 2))) };
}

/** Threads the slider moves to when the GPU lane turns on: 2, or the slider's own limits if they are tighter, never up. */
export const GPU_THREADS = 2;
export function gpuThreads(current, range = threadRange()) {
  return Math.max(range.min, Math.min(range.max, GPU_THREADS, current));
}

/**
 * Live figures for hashrate H (H/s) at difficulty D: expected seconds per solution D / H and
 * the chance of at least one solution in the next block, 1 − exp(−600 × H / D).
 */
export function liveFigures({ hashrate, difficulty }) {
  const h = Number(hashrate);
  const d = Number(difficulty);
  if (!(h > 0) || !(d > 0)) return { perSolution: null, nextBlock: 0 };
  return { perSolution: d / h, nextBlock: 1 - Math.exp((-600 * h) / d) };
}

/** "about 4 min", "about 2.5 h", "about 3 days": rough durations for expected times. */
export function roughDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return DASH;
  if (s < 90) return `about ${Math.max(1, Math.round(s))} s`;
  if (s < 5400) return `about ${Math.round(s / 60)} min`;
  if (s < 172_800) return `about ${(s / 3600).toFixed(1)} h`;
  if (s < 3_153_600_000) return `about ${int(Math.round(s / 86_400))} days`;
  return "longer than a lifetime";
}

export const pct = (p) => (p >= 0.995 ? "over 99%" : p > 0 && p < 0.001 ? "under 0.1%" : `${(100 * p).toFixed(p < 0.1 ? 1 : 0)}%`);

/** H/s like "1,234 H/s" or "12.3 kH/s". */
export function rateText(hs) {
  const v = Number(hs);
  if (!Number.isFinite(v) || v <= 0) return "0 H/s";
  if (v < 10_000) return `${int(Math.round(v))} H/s`;
  if (v < 10_000_000) return `${(v / 1000).toFixed(1)} kH/s`;
  return `${(v / 1e6).toFixed(1)} MH/s`;
}

/** The route the page starts on: the relay balance when it covers a claim, else the built-in mining key. */
export function defaultRoute({ relayMine = null, balance = null, serviceSats = 0n } = {}) {
  if (!relayOpen() || relayMine?.enabled !== true) return "key";
  const q = mineQuote({ route: "relay", relayMine, serviceSats });
  return q && Number.isSafeInteger(balance?.balance) && BigInt(balance.balance) >= q.total ? "relay" : "key";
}

/** Rewards of claims in flight: at their own rewards (pendingReward) when the server reports it. */
function pendingRewardOf(view, reward) {
  return /^\d+$/.test(String(view.pendingReward ?? ""))
    ? BigInt(view.pendingReward)
    : reward * (Number.isSafeInteger(view.pendingClaims) ? BigInt(view.pendingClaims) : 0n);
}

/**
 * The warning shown before a claim is paid when the supply cap is close, or null: the claims that
 * still fit (counting claims in flight) are at most 10, or at most 3 times the average claims per
 * block over the last 144 blocks (capRisk). Claims beyond the cap in the same block are not credited
 * and their fees are lost. The page shows it and waits for a second, explicit click.
 */
export function capWarning(view) {
  if (!view) return null;
  const reward = BigInt(view.reward ?? 0);
  if (reward <= 0n) return null;
  const risk = capRisk({
    remaining: BigInt(view.maxSupply) - BigInt(view.issued) - pendingRewardOf(view, reward), reward,
    claims: view.series?.claims ?? [], tip: view.tip?.height ?? 0, mineStart: view.mineStart ?? 0,
  });
  return risk ? capWarningText(risk, view.ticker) : null;
}

/**
 * Supply is nearly mined out when what is left, counting claims in flight, is below the reward
 * times (claims in the last 3 blocks + 1) (mining.md §6.4).
 */
export function nearCap(view) {
  if (!view) return false;
  const reward = BigInt(view.reward ?? 0);
  if (reward <= 0n) return false;
  const remaining = BigInt(view.maxSupply) - BigInt(view.issued) - pendingRewardOf(view, reward);
  const tip = view.tip?.height ?? 0;
  const recent = (view.series?.claims ?? []).filter(([h]) => Number(h) > tip - 3).reduce((s, [, n]) => s + Number(n), 0);
  return remaining < reward * BigInt(recent + 1);
}

/** What the page says about the worker self-test: null, the slow-mode line, or the refusal. */
export function fastPathNote(ready) {
  if (!ready) return null;
  if (ready.ok === false) return MINE_TEXT.off;
  if (ready.impl === "noble") return MINE_TEXT.slow;
  return null;
}

const randomNonceHex = () => hex(globalThis.crypto.getRandomValues(new Uint8Array(8)));

/**
 * Drives the mining workers (mining-contract.md §10.2). Nothing here hashes: workers do.
 *   spawn()            -> a worker-like object { postMessage, terminate, onmessage }
 *   prepare()          -> Promise<{ draft, challenge: hex64, target: hex64 }>: a FRESH challenge
 *                         (session.prepareMine); a throw pauses mining with that message
 *   onFound({ draft, nonce, powHash, hashes, lane? })   after every worker was told to stop; lane is "gpu" for a GPU solution
 *   onChange(type)     "ready" | "progress" | "state" | "error" | "gpu"
 *   gpuSpawn()         optional: a worker for the GPU lane (null: no GPU lane, e.g. no WebGPU in this browser)
 *   gpuOpen            extra fields of the GPU worker's "open" message (the lab build's fault hook); none otherwise
 * restart() builds a new challenge and restarts every worker (a new tip, after a solution).
 * The GPU worker is never in `workers` (the thread count and verify() are CPU only), and its messages
 * never touch `ready` or `note`: a GPU failure never stops the CPU lanes.
 */
export class MineController {
  constructor({ spawn, prepare, onFound = () => {}, onChange = () => {}, now = () => Date.now(), random = randomNonceHex, gpuSpawn = null, gpuOpen = {} } = {}) {
    Object.assign(this, { spawn, prepare, onFound, onChange, now, random, gpuSpawn, gpuOpen });
    this.gpuBanned = false; // set by a wrong GPU answer: the lane stays off for the life of the page
    this.gpu = null; // { w, state: "opening" | "ready" | "off", name, note, checked } (checked: the GPU opened, its self-test runs)
    this.gpuPaused = false; // backpressure: more solutions wait to be paid than the wallet can pay; the lane stops searching, nothing is dropped
    this.workers = [];
    this.running = false;
    this.job = null; // { id, draft, challenge, target }
    this.seq = 0;
    this.ready = null; // { ok, impl } of the first worker that answered
    this.note = null; // fastPathNote(ready) or a pause reason
    this.paused = null;
    this.samples = []; // [t, hashes, ms]
    this.startedAt = null; // when mining last started (hashrate's window)
    this.total = 0;
    this.verifies = new Map();
    this.vseq = 0;
    this.threads = 1;
    this.holds = 0; // proofs running with the GPU lane on: while > 0 the CPU workers are ended (holdCpu)
    this.settleMs = HOLD_SETTLE_MS; // how long a proof waits after the workers were ended
    this.settling = null; // the wait in progress for the memory of workers just ended
  }

  #grow(n) {
    while (this.workers.length < n) {
      const w = this.spawn();
      w.onmessage = (e) => this.#message(w, e?.data ?? e);
      this.workers.push(w);
    }
    while (this.workers.length > n) {
      const w = this.workers.pop();
      w.postMessage({ type: "stop" });
      w.terminate?.();
    }
  }

  #message(w, m) {
    switch (m?.type) {
      case "ready": {
        // A refusal from any worker wins; "noble" from any worker means slow mode.
        const prev = this.ready;
        this.ready = !prev ? { ok: m.ok, impl: m.impl } : { ok: prev.ok && m.ok, impl: prev.impl === "noble" || m.impl === "noble" ? "noble" : m.impl ?? prev.impl };
        this.note = fastPathNote(this.ready) ?? this.paused;
        if (this.ready.ok === false && this.running) this.stop();
        return this.onChange("ready");
      }
      case "progress":
        return this.#progress(m, "cpu");
      case "found":
        return this.#found(m, "cpu");
      case "verified": {
        const p = this.verifies.get(m.id);
        if (!p) return;
        this.verifies.delete(m.id);
        return m.error ? p.reject(new Error(m.error)) : p.resolve(m.powHash);
      }
      case "error":
        this.note = m.message;
        return this.onChange("error");
    }
  }

  #progress(m, lane) {
    // Hashes of an earlier challenge of this controller count too (a worker reports the
    // last part of a search when it is stopped or restarted): this tab computed them.
    if (m.id != null && !(Number.isSafeInteger(m.id) && m.id >= 1 && m.id <= this.seq)) return;
    this.samples.push([this.now(), Number(m.hashes) || 0, Number(m.ms) || 0, lane]);
    this.total += Number(m.hashes) || 0;
    return this.onChange("progress");
  }

  #found(m, lane) {
    const job = this.job;
    if (!job || (m.id != null && m.id !== job.id)) return; // a solution of an older challenge: ignored
    // One solution per challenge: every worker stops, the solution is handed over, then a new challenge.
    this.job = null;
    for (const x of this.workers) x.postMessage({ type: "stop" });
    if (this.gpu?.w) this.gpu.w.postMessage({ type: "stop" });
    try {
      this.onFound({ draft: job.draft, nonce: m.nonce, powHash: m.powHash, hashes: m.hashes, ...(lane === "gpu" ? { lane } : {}) });
    } finally {
      if (this.running) this.restart();
    }
  }

  /** The GPU worker's messages. They never reach `ready` or `note`. A message of an earlier GPU worker is ignored. */
  #gpuMessage(w, m) {
    const g = this.gpu;
    if (!g || g.w !== w) return;
    switch (m?.type) {
      case "gpu-info":
        g.name = m.info?.name ?? g.name;
        g.checked = true;
        return this.onChange("gpu");
      case "ready":
        if (!m.ok) {
          g.state = "off";
          g.note = "The GPU lane did not start.";
          return this.onChange("gpu");
        }
        g.state = "ready";
        g.name = m.name ?? g.name;
        g.note = null;
        // Mining is already on: the GPU joins the challenge in progress.
        if (this.running && this.job) this.#startGpu(this.job.id, this.job);
        return this.onChange("gpu");
      case "lane-off":
        g.state = "off";
        g.note = String(m.reason ?? "The GPU lane is off.");
        if (m.wrong === true) this.gpuBanned = true;
        return this.onChange("gpu");
      case "progress":
        return this.#progress(m, "gpu");
      case "found":
        return this.#found(m, "gpu");
      case "error":
        g.note = String(m.message ?? "The GPU lane reported an error.");
        return this.onChange("gpu");
    }
  }

  #startGpu(id, job) {
    if (this.gpu?.state === "ready" && !this.gpuPaused) this.gpu.w.postMessage({ type: "start", id, challenge: job.challenge, target: job.target, nonceStart: this.random(), step: 1, progressMs: 1000 });
  }

  /**
   * Backpressure on the GPU lane: while more solutions wait to be paid than the wallet can pay before they expire, the lane
   * stops searching (the processor lanes go on); when the backlog falls it joins the current challenge again. This holds the
   * search only: no solution is dropped and no claim is limited. Reports "gpu" when the state changed.
   */
  pauseGpu(on) {
    on = on === true;
    if (this.gpuPaused === on) return;
    this.gpuPaused = on;
    if (on) this.gpu?.w?.postMessage({ type: "stop" });
    else if (this.running && this.job) this.#startGpu(this.job.id, this.job);
    this.onChange("gpu");
  }

  /**
   * Switches the GPU lane on or off (gpuSpawn is set when this browser has WebGPU). On: spawn the worker, tell it to open
   * the GPU, and give it the current job once it is ready. Off: stop and terminate it; `note` stays
   * as the caption (for example when the reference re-check disagreed with a GPU solution).
   */
  enableGpu(on, note = null, { ban = false } = {}) {
    if (ban) this.gpuBanned = true;
    if (on) {
      if (!this.gpuSpawn || this.gpu?.w || this.gpuBanned) return;
      const w = this.gpuSpawn();
      this.gpu = { w, state: "opening", name: null, note: null, checked: false };
      w.onmessage = (e) => this.#gpuMessage(w, e?.data ?? e);
      w.postMessage({ type: "open", ...this.gpuOpen });
      return this.onChange("gpu");
    }
    const g = this.gpu;
    this.gpuPaused = false; // a lane switched off holds nothing back
    if (!g && !(this.gpuBanned && note)) return;
    if (g?.w) {
      g.w.postMessage({ type: "stop" });
      g.w.terminate?.();
    }
    // a banned lane keeps its caption, so the page still says why the box cannot be ticked
    const why = note ?? (this.gpuBanned ? g?.note : null);
    this.gpu = why ? { w: null, state: "off", name: g?.name ?? null, note: why } : null;
    this.onChange("gpu");
  }

  /** How many CPU workers there should be: none while a proof holds the CPU lanes (holdCpu), else `threads`. */
  #want() {
    return this.holds > 0 ? (this.verifies.size ? 1 : 0) : this.threads;
  }

  /**
   * A proof needs memory the mining workers hold: found on a rented GPU box, the proof ran out of memory with 12 mining threads
   * plus the GPU lane. While the GPU lane is on, this ends the CPU workers (their memory comes free; the GPU lane goes on and
   * adds nearly all the hashes) and returns release(): when the last proof is done the CPU workers start again on the current
   * challenge. Without a GPU lane nothing changes and release does nothing.
   * The browser takes back a terminated worker's memory a moment later, so release.settled is a promise the proof awaits before it
   * builds (settleMs after workers were ended; already done when none were).
   */
  holdCpu() {
    if (!this.gpu?.w) return Object.assign(() => {}, { settled: Promise.resolve() });
    this.holds += 1;
    if (this.holds === 1) {
      const before = this.workers.length;
      this.#grow(this.#want()); // a reference check in flight keeps its worker
      if (this.workers.length < before && this.settleMs > 0) this.settling = new Promise((r) => setTimeout(r, this.settleMs));
    }
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.holds = Math.max(0, this.holds - 1);
      if (this.holds === 0) this.settling = null;
      if (this.holds > 0 || !this.running) return;
      this.#grow(this.threads);
      const job = this.job;
      if (job) for (const w of this.workers) w.postMessage({ type: "start", id: job.id, challenge: job.challenge, target: job.target, nonceStart: this.random(), step: 1, progressMs: 1000 });
      this.onChange("state");
    };
    return Object.assign(release, { settled: this.settling ?? Promise.resolve() });
  }

  async start(threads = this.threads) {
    this.threads = Math.max(1, threads | 0);
    this.#grow(this.#want());
    if (!this.running) {
      this.startedAt = this.now();
      this.samples = [];
    }
    this.running = true;
    this.onChange("state");
    return this.restart();
  }

  stop() {
    this.running = false;
    this.job = null;
    for (const w of this.workers) w.postMessage({ type: "stop" });
    this.gpu?.w?.postMessage({ type: "stop" });
    this.onChange("state");
  }

  /** A new challenge for every worker: on a new tip and after each solution. */
  async restart() {
    if (!this.running) return;
    const id = ++this.seq;
    this.job = null;
    for (const w of this.workers) w.postMessage({ type: "stop" });
    this.gpu?.w?.postMessage({ type: "stop" });
    let next;
    try {
      next = await this.prepare();
    } catch (e) {
      if (id !== this.seq) return;
      this.paused = e?.message ?? String(e);
      this.note = fastPathNote(this.ready) ?? this.paused;
      return this.onChange("state");
    }
    if (id !== this.seq || !this.running) return;
    this.paused = null;
    this.note = fastPathNote(this.ready);
    this.job = { id, draft: next.draft, challenge: next.challenge, target: next.target };
    // Each worker starts at its own random 8-byte nonce.
    for (const w of this.workers) w.postMessage({ type: "start", id, challenge: next.challenge, target: next.target, nonceStart: this.random(), step: 1, progressMs: 1000 });
    this.#startGpu(id, this.job);
    this.onChange("state");
  }

  setThreads(n) {
    this.threads = Math.max(1, n | 0);
    if (!this.running) return;
    const before = this.workers.length;
    this.#grow(this.#want());
    if (this.job && this.workers.length > before) {
      for (const w of this.workers.slice(before)) w.postMessage({ type: "start", id: this.job.id, challenge: this.job.challenge, target: this.job.target, nonceStart: this.random(), step: 1, progressMs: 1000 });
    }
  }

  /**
   * This tab's hashrate (H/s): the hashes reported in the last 10 s over the time they cover,
   * that is 10 s, or less right after Start (never less than the longest report, at least 1 s).
   */
  hashrate() {
    return this.#rate(null);
  }

  /** The same figure per lane: { cpu, gpu } (hashrate() stays the total of both). */
  hashrateByLane() {
    return { cpu: this.#rate("cpu"), gpu: this.#rate("gpu") };
  }

  #rate(lane) {
    const t = this.now();
    this.samples = this.samples.filter(([at]) => t - at <= RATE_WINDOW_MS);
    const mine = lane ? this.samples.filter(([, , , l]) => (l ?? "cpu") === lane) : this.samples;
    const sum = mine.reduce((s, [, n]) => s + n, 0);
    if (!sum) return 0;
    const longest = mine.reduce((m, [, , ms]) => Math.max(m, ms), 0);
    const since = this.startedAt === null ? RATE_WINDOW_MS : t - this.startedAt;
    const span = Math.min(RATE_WINDOW_MS, Math.max(since, longest, 1000));
    return sum / (span / 1000);
  }

  /** The reference (noble) Argon2id of a password (hex), computed in a worker, never on the page. */
  verify(passwordHex) {
    if (!this.workers.length) this.#grow(1);
    const id = ++this.vseq;
    return new Promise((resolve, reject) => {
      this.verifies.set(id, { resolve, reject });
      this.workers[0].postMessage({ type: "verify", id, password: passwordHex });
    });
  }

  /** The reference re-check disagreed with the fast path: every worker uses noble from now on. */
  disableFast(reason = "the reference re-check disagreed") {
    this.ready = { ok: this.ready?.ok !== false, impl: "noble" };
    this.note = fastPathNote(this.ready);
    for (const w of this.workers) w.postMessage({ type: "disable", reason });
    this.onChange("ready");
  }

  terminate() {
    this.running = false;
    this.job = null;
    for (const w of this.workers) {
      w.postMessage({ type: "stop" });
      w.terminate?.();
    }
    this.workers = [];
    if (this.gpu?.w) {
      this.gpu.w.postMessage({ type: "stop" });
      this.gpu.w.terminate?.();
    }
    this.gpu = null;
    for (const p of this.verifies.values()) p.reject(new Error("Mining stopped."));
    this.verifies.clear();
  }
}

/**
 * Refusals after which this solution can never be claimed (by any route, at any time): the
 * work is wrong or no longer counts, the supply or the window is gone, or it was handed out.
 */
export const FINAL_CLAIM_CODES = new Set(["pow_mismatch", "stale_work", "insufficient", "cap_reached", "closed", "solution_taken", "expired", "ended"]);

/** The caption after a GPU solution failed the reference re-check. */
export const GPU_OFF_NOTE = "GPU lane off: its verifier disagreed with the reference";

/**
 * A claim failure, as the page handles it: a fast path that disagreed is disabled at once (and the
 * GPU lane too, when the solution came from it). A
 * refusal before anything left the browser (no W-M entry) that is not final leaves the solution
 * "found", so the Claim button retries it, by the same or another route, until its window
 * closes (a stale relay balance, Unisat not connected, no unbound coin, a network error).
 */
export function onClaimError(err, ctl, sol = null) {
  if (err?.code === "pow_mismatch") {
    ctl?.disableFast("the reference re-check disagreed");
    // A solution that came from the GPU lane and failed the re-check: that lane is off for this page.
    if (sol?.lane === "gpu") ctl?.enableGpu?.(false, GPU_OFF_NOTE, { ban: true });
  }
  if (err?.code === "stale_work") return { status: "stale", message: MINE_TEXT.surge };
  const message = err?.message ?? String(err);
  if (!err?.entry && !FINAL_CLAIM_CODES.has(err?.code)) return { status: "found", message: `${message.replace(/[.\s]+$/, "")}. Nothing was paid: claim again, or pick another route.` };
  // Handed out: the W-M entry's own reason says whether it may still land (its notes stay locked).
  return { status: "failed", message: err?.entry?.reason ?? message };
}

/**
 * What a wallet sync means for the workers: "reload" the token's view first when the wallet
 * reached a block the view does not show yet (loadView then builds the new challenge), else
 * "restart" on the new block at once. Restarting before the view caught up would stop every
 * worker until the next poll.
 */
export function syncAction(walletHeight, viewTipHeight) {
  return walletHeight != null && walletHeight === viewTipHeight ? "restart" : "reload";
}

const spawnWorker = () => new Worker(new URL("../mine-worker.js", import.meta.url), { type: "module" });
// Called only from the box's change handler: the browser fetches the GPU worker's file when this runs, not before.
const spawnGpuWorker = () => new Worker(new URL("../gpu/gpu-worker.js", import.meta.url), { type: "module" });

/**
 * True when this browser exposes WebGPU. A property check only: no adapter is requested and the property's value is
 * never read, so nothing touches the graphics card.
 */
export const gpuSupported = (nav = globalThis.navigator) => Boolean(nav) && typeof nav === "object" && "gpu" in nav;

/** The words of the GPU (beta) box and of what it changes on this page (the claim queue, the coin summary). */
export const GPU_TEXT = Object.freeze({
  label: "Use the graphics card (beta)",
  unsupported: "WebGPU is not available in this browser, so the graphics card cannot be used here. Current Chrome or Edge on a desktop computer have it. Mining with the processor works as before.",
  off: "Off. The graphics card is used only after you tick the box, and the box is unticked again after a reload.",
  starting: "Starting the graphics card…",
  selftest: (name) => `Checking ${name} against known answers. This takes a few seconds.`,
  ready: (name) => `${name} passed its check. It mines when you start mining.`,
  mining: (name, rate) => `${name}: ${rate}`,
  failed: (reason) => `The graphics card stopped: ${reason} Untick the box and tick it again to retry. The processor keeps mining.`,
  banned: (reason) => `The graphics card is off for this page: ${reason} Nothing was paid for its answer. Reload the page to try again. The processor keeps mining.`,
  tabNote: "Keep this tab open and in front: how fast a hidden or background tab mines is not measured yet. Solutions waiting for a block are kept only while this tab is open.",
  cpuPause: "While a claim is being proved with the graphics card on, the processor pauses and reads 0 H/s; it mines again when the proof is done.",
  unisatNote: "Unisat asks you to confirm every claim; with the graphics card that can be every minute or so. The built-in mining key pays without asking.",
  memoryLabel: "Graphics memory",
  memoryNote: "Used the next time you tick the box. 4 GiB is the measured default. 8 GiB was faster on the cards measured, for cards with spare memory; if the card refuses, the page takes less.",
  lanes: (cpu, gpu) => `processor ${cpu} · graphics card ${gpu}`,
  waiting: (n) => `${n} waiting to be paid`,
  paused: (n) => `Graphics card paused: ${n} solutions are waiting to be paid. It searches again when the wallet has caught up. No solution is dropped; each one is paid, or kept while its window is open.`,
  // The second sentence is true only with automatic claiming on; with it off nothing is claimed until the box is ticked again.
  older: (n, auto = true) => `${n} older solutions are not listed here. ${auto ? "They are claimed and kept the same way." : "They are kept in this tab. Automatic claiming is off, so they are not claimed."}`,
  stuck: "Proving this claim is taking longer than 3 minutes, so the next solutions go on without it. It still goes out if its proof finishes; until then its coin and notes stay held, and it is never paid twice.",
  chip: "Waiting for a block",
  chipQueued: "Queued",
  chipCoins: "Waiting for coins",
  coinsNone: "Check balance to see its coins.",
  coins: ({ sats, coins, ready, unconfirmed, busy, claimsCovered }, need) =>
    `Mining key: ${int(sats)} sats in ${int(coins)} coins: ${int(ready)} ready now, ${int(unconfirmed)} unconfirmed, ${int(busy)} held by claims in flight.${claimsCovered == null || need == null ? "" : ` Enough for about ${int(claimsCovered)} claims at ~${int(need)} sats each.`}`,
  rate: (perBlock, satsPerBlock, room = CHAIN_ROOM) =>
    `With the graphics card this tab finds about ${perBlock} solutions per block, about ${int(satsPerBlock)} sats per block at today's cost. Confirmed coins pay at once; once ${room} of this wallet's transactions are unconfirmed, the rest wait for the next block and are paid then while still valid. More coins mean fewer waits.`,
  chain: "Bitcoin nodes accept about 25 unconfirmed transactions in one chain; claims beyond that wait for the next block.",
});

const sentence = (t) => {
  const r = String(t ?? "").trim() || "it stopped without saying why.";
  return /[.!?]$/.test(r) ? r : `${r}.`;
};

/**
 * What the GPU (beta) box shows: { phase, text, disabled, checked } from
 *   supported  this browser exposes WebGPU (gpuSupported)
 *   gpu        MineController.gpu ({ state, name, note, checked }) or null
 *   banned     MineController.gpuBanned (a wrong answer: the lane is off for the life of the page)
 *   running    the controller is mining
 *   rate       the GPU lane's H/s
 *   paused     null, or how many solutions wait to be paid while the lane holds its search back (MineController.gpuPaused)
 */
export function gpuState({ supported, gpu = null, banned = false, running = false, rate = 0, paused = null } = {}) {
  if (!supported) return { phase: "unsupported", text: GPU_TEXT.unsupported, disabled: true, checked: false };
  if (banned) return { phase: "banned", text: GPU_TEXT.banned(sentence(gpu?.note)), disabled: true, checked: false };
  if (!gpu) return { phase: "off", text: GPU_TEXT.off, disabled: false, checked: false };
  const name = gpu.name || "the graphics card";
  const Name = gpu.name || "The graphics card";
  const on = (phase, text) => ({ phase, text, disabled: false, checked: true });
  if (gpu.state === "opening") return gpu.checked ? on("selftest", GPU_TEXT.selftest(name)) : on("starting", GPU_TEXT.starting);
  if (gpu.state === "ready" && running && paused != null) return on("paused", GPU_TEXT.paused(int(paused)));
  if (gpu.state === "ready") return running ? on("mining", GPU_TEXT.mining(Name, rateText(rate))) : on("ready", GPU_TEXT.ready(Name));
  return on("failed", GPU_TEXT.failed(sentence(gpu.note)));
}

/** Refusals that leave a solution valid and unpaid: it waits for the next block (a coin with room in the chain, or coins). */
export const WAIT_CODES = new Set(["chain_wait", "no_coins", "coin_busy"]);
/**
 * Refusals before the hand-out that a later block can fix without the user: the indexer or an explorer did not answer in time, the
 * wallet and the indexer sat on different blocks, or the browser had no memory for the proof (prove_memory).
 */
export const RETRY_CODES = new Set(["indexer", "refhash", "behind", "prove_memory"]);
/** A proof that ran out of memory is tried again after this long (the mining workers were ended for it), at most PROVE_RETRIES times; then on the next block. */
export const PROVE_RETRY_MS = 20_000;
export const PROVE_RETRIES = 3;

/**
 * A claim failure, as the page records it on the solution: onClaimError plus `wait` (the solution is valid and unpaid, so
 * it is tried again on the next block). Waits: WAIT_CODES, RETRY_CODES, and a plain failure with no code (a network error, a
 * 429 or 5xx from an explorer) on the self-paid and relayer routes. A Unisat failure stays manual (a declined popup must not reopen
 * every block), and so does every other coded refusal (Unisat not connected, a final refusal, a fee policy). -> { again, retryInMs }:
 * again is true once for coin_busy, which is tried again at once; retryInMs is set for a memory failure of the proof (prove_memory),
 * which is tried again after that many ms, up to PROVE_RETRIES times.
 */
export function applyClaimFailure(sol, err, ctl = null, route = null) {
  Object.assign(sol, onClaimError(err, ctl, sol));
  const plain = !err?.code && !err?.entry && route !== "unisat";
  sol.wait = sol.status === "found" && (WAIT_CODES.has(err?.code) || RETRY_CODES.has(err?.code) || plain);
  sol.waitCode = sol.wait ? err?.code ?? null : null;
  const memory = err?.code === "prove_memory" && sol.wait;
  if (memory) sol.memoryRetries = (sol.memoryRetries ?? 0) + 1;
  const soon = memory && sol.memoryRetries <= PROVE_RETRIES;
  if (sol.wait) {
    sol.message = WAIT_CODES.has(err?.code)
      ? String(err.message)
      : memory
        ? `${String(err.message ?? PROVE_MEMORY_TEXT)} ${soon ? "It is tried again in a few seconds." : "It is tried again after the next block, while it stays valid."}`
        : `${String(err?.message ?? err).replace(/[.\s]+$/, "")}. Nothing was paid; it is tried again after the next block, while it stays valid.`;
  }
  const again = err?.code === "coin_busy" && sol.wait && !sol.busyRetried;
  if (err?.code === "coin_busy") sol.busyRetried = true;
  return { again, retryInMs: soon ? PROVE_RETRY_MS : null };
}

/** How long the queue waits for one claim before it goes on to the next (a proof that never ends, see ClaimQueue). */
export const CLAIM_WATCHDOG_MS = 180_000;
/** After the processor workers are ended for a proof, the proof starts this much later so their memory is back first. */
export const HOLD_SETTLE_MS = 300;
/** Before the proof begins (checks, the bind step, the first key download) a claim has this long: those steps have no timeouts of their own. */
export const CLAIM_PRE_PROVE_MS = 300_000;
const STUCK = Symbol("stuck");

/**
 * Claims one at a time, the oldest reference block first (a solution the user clicked, force, goes before the rest), so a backlog never proves many claims at once.
 * run(sol, { proving }) -> Promise (the page's claim(), which handles its own errors). add(sol) queues a solution once (by key).
 * Watchdog: a claim that has not finished no longer holds the queue. It has preMs (5 minutes) for the steps before the proof
 * (a slow explorer call or the first key download is not a stuck proof); proving() restarts the clock with watchdogMs (3 minutes)
 * when the proof begins. A run that never calls proving() gets preMs. The claim itself is not
 * cancelled and nothing is undone: its W-M entry stays pending (notes and coin held until it lands or its window ends), it still
 * goes out if its proof ever finishes, and the same solution is never claimed a second time (solution_taken). onStuck(sol) tells the page.
 * live(sol) -> false drops a solution that can no longer be paid (its window closed) before any claim step runs: it costs no check,
 * no request and no reference hash.
 */
export class ClaimQueue {
  constructor(run, { watchdogMs = CLAIM_WATCHDOG_MS, preMs = watchdogMs, onStuck = () => {}, live = () => true } = {}) {
    this.run = run;
    this.live = live;
    this.watchdogMs = watchdogMs;
    this.preMs = preMs;
    this.onStuck = onStuck;
    this.items = [];
    this.pumping = false;
  }

  add(sol) {
    if (!this.has(sol)) this.items.push(sol);
    return this.pump();
  }

  /** True while the solution waits in the queue (not once its claim started). */
  has(sol) {
    return this.items.some((x) => x.key === sol.key);
  }

  async #guarded(sol) {
    let timer = null;
    let resolveStuck;
    const stuck = new Promise((resolve) => (resolveStuck = resolve));
    let over = false; // an abandoned claim may still report its proof later: that must not start a clock again
    const arm = (ms) => {
      clearTimeout(timer);
      if (!over && ms > 0 && Number.isFinite(ms)) {
        timer = setTimeout(() => resolveStuck(STUCK), ms);
        timer?.unref?.(); // Node (tests): a pending watchdog must not keep the process alive
      }
    };
    arm(this.preMs);
    try {
      // A late rejection of an abandoned claim is handled by the race: it never becomes an unhandled rejection.
      if ((await Promise.race([Promise.resolve().then(() => this.run(sol, { proving: () => arm(this.watchdogMs) })), stuck])) === STUCK) {
        try {
          this.onStuck(sol);
        } catch {
          // the page's notice must not stop the queue
        }
      }
    } catch {
      // run() reports its own failures; the queue goes on
    } finally {
      over = true;
      clearTimeout(timer);
    }
  }

  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      await null; // solutions added in the same tick are all in before the first is picked
      for (;;) {
        this.items = this.items.filter((x) => x.status === "found" && this.live(x));
        if (!this.items.length) break;
        // A solution the user asked for (a click on Claim sets force) goes before the backlog; among those, and among the rest, the oldest reference block first.
        const next = this.items.reduce((a, b) => (Boolean(b.force) !== Boolean(a.force) ? (b.force ? b : a) : b.ref < a.ref ? b : a));
        this.items = this.items.filter((x) => x !== next);
        await this.#guarded(next);
      }
    } finally {
      this.pumping = false;
    }
  }
}

/**
 * On a new block: send again the carriers a node refused for chain length, then (automatic claiming on) queue every
 * waiting solution whose window is still open, oldest first.
 */
export async function retryOnTip({ s, solutions, autoSubmit, queue, route }) {
  try {
    await s.resendHeldClaims?.();
  } catch {
    // a failed resend is tried again on the next block
  }
  if (!autoSubmit) return;
  const open = (sol) => !(s.view && mineWindowLeft(sol.ref, s.view.height, route) < 0);
  const waiting = solutions.filter((x) => x.status === "found" && x.wait && open(x)).sort((a, b) => a.ref - b.ref);
  for (const sol of waiting) {
    sol.busyRetried = false;
    sol.memoryRetries = 0; // a new block gives the quick retries after a memory failure again
    queue.add(sol);
  }
}

/** Solutions waiting to be paid: valid and unpaid, plus carriers held for the next block. */
export const waitingCount = (solutions, history) =>
  solutions.filter((x) => x.status === "found" && x.wait).length + (history ?? []).filter((h) => h.kind === "mine" && h.held === "chain" && MINE_PENDING.has(h.status)).length;

/** Solutions per block at a hashrate, 600 x H / D, and the sats a block of them costs at `need` sats a claim. */
export function gpuYield({ hashrate, difficulty, need }) {
  const h = Number(hashrate);
  const d = Number(difficulty);
  if (!(h > 0) || !(d > 0)) return null;
  const perBlock = (600 * h) / d;
  return { perBlock, text: perBlock < 100 ? perBlock.toFixed(1).replace(/\.0$/, "") : int(Math.round(perBlock)), sats: need == null ? null : Math.round(perBlock * Number(need)) };
}

/** The "Prepare coins" number to suggest while the GPU lane mines: max(4, ceil(3 x solutions per block)), at most 50. */
export const suggestedCoins = (perBlock) => Math.min(50, Math.max(4, Math.ceil(3 * perBlock)));

/** The solutions list draws this many of the newest rows; the rest is one count line (at very low difficulty there can be thousands). */
export const SOLUTION_ROWS = 200;
/**
 * Backpressure on the GPU lane (not a limit on claims): it stops searching while more than BACKLOG_FACTOR x the room
 * solutions wait to be paid, and searches again once the backlog is down to the room. The room is what the wallet can start in
 * one block: CHAIN_ROOM transactions in a chain plus each confirmed coin that starts a chain of its own.
 */
export const BACKLOG_FACTOR = 2;
export function gpuBacklogPaused({ paused = false, backlog = 0, room = CHAIN_ROOM } = {}) {
  return paused ? backlog > room : backlog > BACKLOG_FACTOR * room;
}

/* ---------- the page ---------- */

const ROUTE_LABEL = { relay: "Relay balance", key: "Built-in mining key", unisat: "Unisat" };
const SOL_TEXT = {
  found: "Found: claim it before its window closes",
  checking: "Checking",
  proving: "Proving",
  submitted: "Submitted",
  landed: "Landed",
  expired: "Expired",
  rejected: "Rejected",
  dropped: "Dropped",
  stale: "No longer counts",
  failed: "Not claimed",
};

/**
 * The chip of a solution row that has no claim entry yet: { text, kind }. A found solution that waits for chain room reads
 * "Waiting for a block"; one that needs coins reads "Waiting for coins", which a block does not fix; one that only waits its turn
 * in the claim queue (behind a claim that is proving) reads "Queued": it waits for the queue, not for a block.
 */
export function solChip(sol, status, { queued = false } = {}) {
  if (status === "found" && sol.wait) return { text: sol.waitCode === "no_coins" ? GPU_TEXT.chipCoins : GPU_TEXT.chip, kind: "btc" };
  if (status === "found" && queued) return { text: GPU_TEXT.chipQueued, kind: "btc" };
  return { text: SOL_TEXT[status] ?? status, kind: status === "failed" || status === "stale" ? "warn" : status === "expired" ? "neutral" : "btc" };
}

// The thread count the user chose on the slider, kept when the page is drawn again (a route change inside the app).
let chosenThreads = null;

export function mineView(root, s, query, { spawn = spawnWorker, gpuSpawn = spawnGpuWorker, gpuDetect = gpuSupported, lab = labGpu } = {}) {
  let alive = true;
  let want = query?.get?.("t")?.toUpperCase() ?? null;
  let list = null; // GET /api/mine assets
  let view = null; // GET /api/mine/:asset of the picked token
  let loadError = null;
  let feeRate = null;
  let route = null; // chosen by the user, else defaultRoute()
  let autoSubmit = true;
  let mineLinkable = false; // L1 consent: relayed claims while the relay pool is thin
  let minePoolThin = false; // the relayer refused a claim with pool_thin
  let coinsN = 4;
  let coinsEdited = false; // the user typed a number: the GPU suggestion no longer overwrites it
  const tr = threadRange();
  let threads = chosenThreads ? Math.min(tr.max, Math.max(tr.min, chosenThreads)) : tr.value;
  const solutions = []; // { key, draft, nonce, powHash, status, message, step, entryId, ref, reward }
  const phone = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  // The service fee of one claim; terms outside the pinned fee policy show the platform's fee only (a claim refuses them).
  const service = () => {
    try {
      return mineFeeOutputs(view ?? {}).reduce((x, o) => x + o.sats, 0n);
    } catch {
      return mineFeeOutputs({}).reduce((x, o) => x + o.sats, 0n);
    }
  };
  const routeNow = () => route ?? defaultRoute({ relayMine: s.relayInfo?.mine, balance: s.relayBalance, serviceSats: service() });

  // The GPU (beta) box: in every build, read once here. Only a lab build lets the address pick a stub worker that never
  // calls WebGPU (?gpu=stub, stub-fail, stub-wrong; stub-none: no WebGPU) and arm the fault hook (?gpufault=n).
  const stubMode = lab ? { stub: "ok", "stub-fail": "fail", "stub-wrong": "wrong" }[query?.get?.("gpu")] : undefined;
  const gpuOk = lab && query?.get?.("gpu") === "stub-none" ? false : stubMode ? true : gpuDetect();
  const fault = lab ? lab.faultOf?.(query) ?? null : null;
  // The "Graphics memory" choice (2 / 4 / 8 GiB, remembered; default 4 GiB). Sent with the open message as a request the engine
  // never lifts a vendor above its default for. The box itself is not remembered.
  let gpuMemory = readGpuMemory();
  const gpuOpenOf = () => ({ memoryUpToMiB: gpuMemory, ...(fault ? { fault } : {}) });
  const ctl = new MineController({
    spawn,
    gpuSpawn: gpuOk ? (stubMode ? () => lab.spawnStub(stubMode) : gpuSpawn) : null,
    gpuOpen: gpuOpenOf(),
    prepare: async () => {
      if (!view || view.status !== "mining") throw new Error(`${view?.ticker ?? "This token"} is not open for mining right now.`);
      if (!s.view || s.view.height !== view.tip?.height) throw new Error(`Waiting for the wallet and the indexer to reach the same block${view.tip ? ` (${heightText(view.tip.height)})` : ""}.`);
      const draft = s.prepareMine(view);
      return { draft, challenge: hex(draft.challenge), target: targetHex(draft.meta.difficulty) };
    },
    onFound: (f) => found(f),
    onChange: (type) => {
      if (!alive) return;
      if (type === "progress") paintLive();
      else paint();
    },
  });

  function found({ draft, nonce, powHash, lane }) {
    s.holdDraft(draft); // its notes stay out of the next challenge (W-M)
    const sol = { key: `${draft.refHeight}:${nonce}`, draft, nonce, powHash, status: "found", ref: draft.refHeight, reward: draft.reward, at: Date.now(), ...(lane ? { lane } : {}) };
    solutions.unshift(sol);
    checkBackpressure(); // before anything else: a flood must stop the lane at once
    if (autoSubmit) queueClaim(sol);
    else paint();
  }

  // One claim at a time, the oldest reference block first (a backlog never proves many claims at once). A claim that has not
  // finished after 3 minutes (a proof that never ends) no longer holds the queue: see ClaimQueue.
  const claimQueue = new ClaimQueue((sol, hooks) => claim(sol, hooks), { preMs: CLAIM_PRE_PROVE_MS, onStuck: (sol) => stuck(sol), live: (sol) => !expireIfClosed(sol) });
  const queueClaim = (sol) => claimQueue.add(sol);
  const timers = new Set(); // retries after a proof ran out of memory
  const later = (ms, fn) => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (alive) fn();
    }, ms);
    timers.add(t);
  };
  const windowOpen = (sol) => !(s.view && mineWindowLeft(sol.ref, s.view.height, routeNow()) < 0);
  // the oldest reference block first; among solutions of one block the earlier found (solutions lists the newest first).
  // The positions are read once per sort: an indexOf inside the comparator is quadratic, and with thousands of solutions it froze the page.
  const oldestFirstOf = () => {
    const at = new Map(solutions.map((x, i) => [x, i]));
    return (a, b) => a.ref - b.ref || at.get(b) - at.get(a);
  };
  /**
   * A found solution whose window closed can never be paid: it leaves the claim queue at once and frees its notes, without a
   * check, a request or a reference hash. (Before, only the rows on screen were marked expired, so thousands of closed
   * solutions stayed in the queue and each cost a full claim attempt.) True when the solution was or is now expired.
   */
  function expireIfClosed(sol) {
    if (sol.status === "expired") return true;
    if (sol.status !== "found" || windowOpen(sol)) return false;
    sol.status = "expired";
    s.releaseDraft(sol.draft);
    return true;
  }
  function sweepExpired() {
    for (const sol of solutions) expireIfClosed(sol);
  }
  /** Queues every solution that waits for chain room (oldest first): after a claim went out there is room, and after each block there is more. */
  function requeueWaiting() {
    if (!autoSubmit) return;
    for (const sol of solutions.filter((x) => x.status === "found" && x.wait && x.waitCode === "chain_wait" && windowOpen(x)).sort(oldestFirstOf())) {
      sol.busyRetried = false;
      queueClaim(sol);
    }
  }

  // The wallet's own answer "no room / no coins", per block: it is the same for every solution, so once one claim got it the others
  // wait without asking (no check, no request) until a claim goes out, a block comes, PROBE_MS pass, or the user clicks Claim.
  let walletWait = null; // { height, at, route, code, message }
  const walletWaits = () => {
    const w = walletWait;
    return Boolean(w) && w.height === (s.view?.height ?? null) && w.route === routeNow() && Date.now() - w.at < PROBE_MS;
  };

  // Backpressure: while more solutions wait to be paid than the wallet can pay before they expire, the GPU lane holds its search back.
  let gpuPausedN = null; // the backlog when it paused (shown in the box), else null
  const heldCarriers = () => s.history.filter((h) => h.kind === "mine" && h.held === "chain" && MINE_PENDING.has(h.status)).length;
  const backlogNow = () => {
    let n = heldCarriers();
    for (const x of solutions) if (x.status === "found" && windowOpen(x)) n++;
    return n;
  };
  const roomNow = () => {
    const coins = routeNow() === "key" && s.mineCoins ? mineCoinSummary({ utxos: s.mineCoins.utxos, history: s.history, need: keyNeed() }) : null;
    return CHAIN_ROOM + (coins?.ready ?? 0);
  };
  function checkBackpressure() {
    if (!alive || !ctl.gpu?.w) return;
    const backlog = backlogNow();
    const pause = gpuBacklogPaused({ paused: ctl.gpuPaused, backlog, room: roomNow() });
    gpuPausedN = pause ? backlog : null;
    if (pause !== ctl.gpuPaused) ctl.pauseGpu(pause); // repaints through onChange
    else if (pause) paintGpu();
  }
  let lastProbe = 0;
  /** While solutions wait for chain room and the queue is idle, the oldest one tries again every PROBE_MS: the explorer may confirm a block's carriers a few seconds after the wallet saw the block. */
  function probeWaiting() {
    if (!autoSubmit || claimQueue.pumping || Date.now() - lastProbe < PROBE_MS) return;
    const oldest = solutions.filter((x) => x.status === "found" && x.wait && x.waitCode === "chain_wait" && windowOpen(x)).sort(oldestFirstOf())[0];
    if (!oldest) return;
    lastProbe = Date.now();
    oldest.busyRetried = false;
    oldest.force = true; // the probe really asks the wallet again
    queueClaim(oldest);
  }
  /** The watchdog fired: this claim goes on by itself (or fails later); the queue went on without it. */
  function stuck(sol) {
    sol.release?.(); // give the processor lanes back
    sol.release = null;
    sol.stuck = true;
    sol.message = GPU_TEXT.stuck;
    if (alive) paint();
  }

  async function claim(sol, hooks) {
    if (sol.status !== "found") return;
    // Close to the supply cap: say so before anything is paid. The solution stays "found" (also with
    // automatic claiming); only a second click, on "Claim anyway", goes on.
    if (capWarning(view) && !sol.capSeen) {
      sol.capSeen = true;
      sol.message = capWarning(view);
      return paint();
    }
    if (expireIfClosed(sol)) return paintSolutions();
    // The wallet already said, in this block, that it has no room or no coins: this solution waits too, without asking again.
    if (!sol.force && walletWaits()) {
      sol.wait = true;
      sol.waitCode = walletWait.code;
      sol.message = walletWait.message;
      if (alive && !claimQueue.items.length) paintSolutions(); // one repaint when the queue is through, not one per solution
      return;
    }
    sol.force = false;
    if (sol.capSeen || sol.wait) sol.message = null;
    sol.wait = false;
    let again = false;
    let retryIn = null;
    let room = false;
    sol.status = "checking";
    paint();
    try {
      const entry = await s.claimMine({
        draft: sol.draft, nonce: sol.nonce, powHash: sol.powHash, route: routeNow(), referenceHash: (pw) => ctl.verify(pw),
        linkable: routeNow() === "relay" && mineLinkable && (minePoolThin || mixState(s.relayInfo) === "thin"),
        beforeProve: () => sol.release?.settled,
        onStep: (st) => {
          sol.step = st.id;
          if (st.id === "prove" && st.status === "running") {
            sol.status = "proving";
            hooks?.proving(); // the queue's watchdog counts from here
            // With the GPU lane on, the processor workers are ended while the proof runs: it needs their memory.
            sol.release ??= ctl.holdCpu();
          }
          if (alive) paintSolutions();
        },
      });
      sol.entryId = entry.id;
      sol.status = entry.status;
      // A carrier that went out (not one a node held back for chain length) shows there is room for the claims that wait.
      room = !entry.held && MINE_PENDING.has(entry.status);
      if (room) walletWait = null;
    } catch (e) {
      if (e?.code === "pool_thin") minePoolThin = true;
      ({ again, retryInMs: retryIn } = applyClaimFailure(sol, e, ctl, routeNow()));
      if (sol.wait && (e?.code === "chain_wait" || e?.code === "no_coins")) walletWait = { height: s.view?.height ?? null, at: Date.now(), route: routeNow(), code: e.code, message: sol.message };
      if (e?.entry) sol.entryId = e.entry.id;
      // Nothing was handed out: the solution's notes stay out of the next challenge until it is claimed or expires (W-M).
      if (sol.status === "found") s.holdDraft(sol.draft);
    } finally {
      sol.release?.();
      sol.release = null;
      if (sol.stuck) {
        sol.stuck = false;
        if (sol.message === GPU_TEXT.stuck) sol.message = null;
      }
    }
    checkBackpressure();
    if (alive) paint();
    if (again && alive) queueClaim(sol);
    if (retryIn && alive) later(retryIn, () => queueClaim(sol));
    if (room && alive) requeueWaiting();
  }

  /* ----- data ----- */

  async function loadList(fresh = false) {
    try {
      const m = await api.mine({ fresh });
      list = (m?.assets ?? []).filter((a) => a.status === "mining" || a.status === "mining-soon");
      loadError = null;
    } catch (e) {
      list = list ?? [];
      loadError = e.message;
    }
    const open = list.filter((a) => a.status === "mining");
    if (!want || !list.some((a) => a.ticker === want)) want = open[0]?.ticker ?? list[0]?.ticker ?? null;
    await loadView();
  }

  async function loadView() {
    if (!want) {
      view = null;
      return paint();
    }
    try {
      const before = view?.tip?.height ?? null;
      const next = await api.mineAsset(want);
      if (!alive) return;
      const switched = view?.ticker !== next.ticker;
      view = next;
      loadError = null;
      if (switched) paint();
      else {
        paintToken();
        paintLive();
        paintRoute();
        paintCopy();
      }
      // A new block: wait for the wallet to reach it, then a new challenge.
      if (before !== null && next.tip?.height !== before && s.view?.height !== next.tip?.height) s.sync().catch(() => {});
      if (ctl.running && (switched || next.tip?.height !== before)) ctl.restart();
    } catch (e) {
      loadError = e.message;
      paint();
    }
    nextBlockRate()
      .then((r) => {
        feeRate = r;
        if (alive) paintToken();
      })
      .catch(() => {});
  }

  /* ----- painting ----- */

  const $ = (sel) => root.querySelector(sel);

  function shell() {
    root.innerHTML = html`<div class="wl mine">
      ${pageHead({ eyebrow: "MINE", title: "Mine a token", lead: "This tab searches for proof-of-work solutions. Each valid solution claims the token's full reward, and the reward goes to a private note. The claim itself is a public Bitcoin transaction.", streamer: true })}
      <div data-mine-note></div>
      <div class="wl-cols">
        <div class="stack stack--l">
          <section class="panel" data-mine-token></section>
          <section class="panel" data-mine-controls></section>
          <section class="panel" data-mine-live></section>
          <section class="panel" data-mine-solutions></section>
        </div>
        <aside class="stack stack--l preview-sticky">
          <section class="panel" data-mine-route></section>
          <section class="panel" data-mine-copy></section>
        </aside>
      </div>
    </div>`;
  }

  function paint() {
    if (!alive) return;
    if (!$("[data-mine-token]")) shell();
    paintNote();
    paintToken();
    paintControls();
    paintLive();
    paintSolutions();
    paintRoute();
    paintCopy();
  }

  function paintNote() {
    const el = $("[data-mine-note]");
    if (!el) return;
    const lines = [];
    if (ctl.ready?.ok === false) lines.push(callout(MINE_TEXT.off, "danger"));
    else if (ctl.ready?.impl === "noble") lines.push(callout(html`${MINE_TEXT.slow} It mines with the reference implementation, about 10 times slower.`, "warn"));
    if (ctl.paused && ctl.running) lines.push(callout(ctl.paused, "info"));
    if (loadError) lines.push(callout(html`The mining data didn't load: ${loadError}`, "warn"));
    el.innerHTML = html`${lines}`;
  }

  function paintToken() {
    const el = $("[data-mine-token]");
    if (!el) return;
    if (list === null) {
      el.innerHTML = html`<span class="skel" style="width:100%;height:160px"></span>`;
      return;
    }
    if (!list.length) {
      el.innerHTML = empty({ text: "No token is open for mining on this server right now.", action: { label: "Launch a mined token", href: "/app/launch?kind=pow" } });
      return;
    }
    const v = view;
    const q = v ? mineQuote({ route: routeNow(), feeRate, relayMine: s.relayInfo?.mine, serviceSats: service() }) : null;
    const picker = html`<label class="mine-pick"><span class="field-label">Token</span><select class="input" name="mine-asset">${list.map((a) => html`<option value="${a.ticker}"${a.ticker === want ? html` selected` : ""}>${a.ticker}${a.status === "mining" ? "" : " (opens soon)"}</option>`)}</select></label>`;
    if (!v) {
      el.innerHTML = html`${picker}<span class="skel" style="width:100%;height:120px"></span>`;
      return;
    }
    el.innerHTML = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">TOKEN ${prov("IDX")}</div><h2 class="h3 mine-title">${sigil(v.asset, { size: 28 })}<a class="ticker" href="/t/${encodeURIComponent(v.ticker)}" data-link>${v.ticker}</a>${v.status === "mining" ? tag("Mining", "btc") : tag(String(v.status).replace("-", " "), "neutral")}</h2></div></header>
      ${picker}
      ${progress({ value: Number(v.issued), max: Number(v.maxSupply), label: false })}
      ${kv([
        ["Reward per claim", amountHTML(v.reward, v.divisibility, v.ticker)],
        ["Difficulty", html`<span class="mono">${int(v.difficulty)}</span>`],
        ["Network hashrate", html`<span class="mono">${rateText(v.hashrateEstimate)}</span> <span class="caption t-3">estimate from counted work</span>`],
        ["Issued / max", html`<span class="mono">${amountHTML(v.issued, v.divisibility)} / ${amountHTML(v.maxSupply, v.divisibility)}</span>`],
        ["Reference block", v.tip ? html`<span class="mono">${heightText(v.tip.height)}</span>` : DASH],
        ["Cost per claim", q ? html`<span class="mono t-btc">~${sats(q.total)}</span> <span class="caption t-3">${route === "relay" || routeNow() === "relay" ? `relayer's fee ${sats(q.feeSats)} + service ${sats(q.serviceSats)} + margin ${sats(q.marginSats)}` : `Bitcoin fee ~${sats(q.feeSats)} (684 vB at a next-block rate) + service ${sats(q.serviceSats)}`}</span>` : html`<span class="t-3">fee rate not known yet</span>`],
      ])}
      ${v.flags?.lowFloor ? html`<p class="caption t-warn">${icon("warn", { size: 14 })} Low floor: this token's minimum difficulty is far below what an honest browser launch would set, so a fast miner can claim many rewards after a quiet period.</p>` : ""}`;
  }

  function paintControls() {
    const el = $("[data-mine-controls]");
    if (!el) return;
    const off = ctl.ready?.ok === false;
    const reason = off ? MINE_TEXT.off : !view ? "Pick a token first." : view.status !== "mining" ? `${view.ticker} is not open for mining right now.` : null;
    const g = gpuNow();
    el.innerHTML = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">CONTROLS</div></div></header>
      <div class="mine-controls">
        ${ctl.running ? button({ label: "Stop", kind: "secondary", size: "lg", icon: "cross", action: "mine-stop" }) : button({ label: "Start mining", kind: "btc", size: "lg", icon: "block", action: "mine-start", disabled: Boolean(reason), reason })}
        <label class="mine-threads"><span class="field-label">Threads <span class="mono" data-threads-out>${threads}</span> of ${tr.max}</span><input type="range" name="mine-threads" min="${tr.min}" max="${tr.max}" value="${threads}"></label>
        <label class="mine-auto"><input type="checkbox" name="mine-auto"${autoSubmit ? html` checked` : ""}><span>Claim each solution automatically</span></label>
        <label class="mine-auto"><input type="checkbox" name="mine-gpu"${g.checked ? html` checked` : ""}${g.disabled ? html` disabled` : ""}><span>${GPU_TEXT.label}</span></label>
        ${gpuOk ? html`<label class="mine-gpu-memory"><span>${GPU_TEXT.memoryLabel}</span><select class="input" name="mine-gpu-memory"${g.checked || g.disabled ? html` disabled` : ""}>${GPU_MEMORY_CHOICES.map((m) => html`<option value="${m}"${m === gpuMemory ? html` selected` : ""}>${gpuMemoryLabel(m)}</option>`)}</select></label>` : ""}
      </div>
      <p class="caption t-3" data-mine-gpu>${g.text}</p>
      ${gpuOk && !g.checked && !g.disabled ? html`<p class="caption t-3" data-mine-gpu-memory-note>${GPU_TEXT.memoryNote}</p>` : ""}
      ${g.checked ? html`<p class="caption t-3" data-mine-gpu-note>${GPU_TEXT.tabNote}</p><p class="caption t-3" data-mine-gpu-cpu-pause>${GPU_TEXT.cpuPause}</p>${routeNow() === "unisat" ? html`<p class="caption t-3" data-mine-gpu-unisat>${GPU_TEXT.unisatNote}</p>` : ""}` : ""}
      <p class="caption t-3">${MINE_TEXT.gpu}</p>`;
    paintGpu();
  }

  const gpuNow = () => gpuState({ supported: gpuOk, gpu: ctl.gpu, banned: ctl.gpuBanned, running: ctl.running, rate: ctl.gpu?.w ? ctl.hashrateByLane().gpu : 0, paused: ctl.gpuPaused ? gpuPausedN ?? backlogNow() : null });

  /** Mining-key claim cost now: the page's own quote when the rate is known, else the last claim's. */
  const keyNeed = () => mineQuote({ route: "key", feeRate, serviceSats: service() })?.total ?? s.mineCoins?.need ?? null;
  /** Solutions per block of the GPU lane right now, or null. */
  const gpuRateNow = () => {
    if (!(ctl.gpu?.state === "ready" && ctl.running)) return null;
    return gpuYield({ hashrate: ctl.hashrateByLane().gpu, difficulty: view?.difficulty, need: keyNeed() });
  };
  const rateLine = () => {
    const y = gpuRateNow();
    return y && y.sats != null && routeNow() === "key" ? GPU_TEXT.rate(y.text, y.sats) : "";
  };

  // The one caption line of the GPU box, the live rate line and the suggested coin count: updated without redrawing the panel.
  function paintGpu() {
    const el = $("[data-mine-gpu]");
    if (el) el.textContent = gpuNow().text;
    const rl = $("[data-mine-gpu-rate]");
    if (rl) {
      const text = rateLine();
      rl.textContent = text;
      rl.hidden = !text;
    }
    const y = gpuRateNow();
    if (y && !coinsEdited) {
      coinsN = suggestedCoins(y.perBlock);
      const inp = $("#mine-coins-n");
      if (inp) inp.value = String(coinsN);
    }
  }

  function paintLive() {
    paintGpu();
    const el = $("[data-mine-live]");
    if (!el) return;
    const mine = ctl.hashrate();
    const lanes = ctl.gpu?.w ? ctl.hashrateByLane() : null;
    const fig = liveFigures({ hashrate: mine, difficulty: view?.difficulty });
    const landed = s.history.filter((h) => h.kind === "mine" && h.status === "landed" && view && h.assetId === String(view.asset));
    const earned = landed.reduce((x, h) => x + BigInt(h.reward ?? 0), 0n);
    el.innerHTML = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">LIVE ${prov("YOU")}</div></div></header>
      <div class="mine-figures">
        <div><span class="caption t-3">This tab</span><b class="mono">${rateText(mine)}</b><span class="caption t-3">${lanes ? GPU_TEXT.lanes(rateText(lanes.cpu), rateText(lanes.gpu)) : "10-second average"}</span></div>
        <div><span class="caption t-3">Network</span><b class="mono">${rateText(view?.hashrateEstimate)}</b><span class="caption t-3">estimate ${prov("IDX")}</span></div>
        <div><span class="caption t-3">Time per solution</span><b class="mono">${fig.perSolution === null ? DASH : roughDuration(fig.perSolution)}</b><span class="caption t-3">expected, at this rate</span></div>
        <div><span class="caption t-3">Next block</span><b class="mono">${pct(fig.nextBlock)}</b><span class="caption t-3">chance of a solution</span></div>
        <div><span class="caption t-3">Solutions</span><b class="mono">${int(solutions.length)}</b><span class="caption t-3">found in this tab</span></div>
        <div><span class="caption t-3">Reward earned</span><b class="mono">${view ? amountHTML(earned, view.divisibility, view.ticker) : DASH}</b><span class="caption t-3">${plural(landed.length, "claim")} landed</span></div>
      </div>`;
  }

  function solStatus(sol) {
    const entry = sol.entryId ? s.history.find((h) => h.id === sol.entryId) : null;
    if (entry) return { status: entry.status === "proving" && sol.status !== "proving" ? sol.status : entry.status, entry };
    if (sol.status === "found" && s.view && mineWindowLeft(sol.ref, s.view.height, routeNow()) < 0) return { status: "expired", entry: null };
    return { status: sol.status, entry: null };
  }

  function paintSolutions() {
    const el = $("[data-mine-solutions]");
    if (!el) return;
    const waitingN = waitingCount(solutions, s.history);
    const head = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">SOLUTIONS</div><h2 class="h3">Found in this tab</h2>${waitingN > 0 ? html`<span class="caption t-3" data-mine-waiting>${GPU_TEXT.waiting(waitingN)}</span>` : ""}</div></header>`;
    // Claims of this token recorded before this page opened (other tabs, earlier visits).
    const shown = new Set(solutions.map((x) => x.entryId).filter(Boolean));
    const older = s.history.filter((h) => h.kind === "mine" && view && h.assetId === String(view.asset) && !shown.has(h.id)).slice(0, 10);
    if (!solutions.length && !older.length) {
      el.innerHTML = html`${head}<p class="small t-3">${ctl.running ? "Searching. A solution shows up here with its claim's progress." : "Start mining to search for solutions."}</p>`;
      return;
    }
    const row = (sol) => {
      const { status, entry } = solStatus(sol);
      if (status === "expired" && sol.status === "found") {
        sol.status = "expired";
        s.releaseDraft(sol.draft);
      }
      const chip = entry ? statusChip(entry) : (({ text, kind }) => tag(text, kind))(solChip(sol, status, { queued: claimQueue.has(sol) }));
      const left = s.view ? mineWindowLeft(sol.ref, s.view.height, routeNow()) : null;
      // data-key, data-nonce and data-lane say which solution this is and which lane found it (the E2E reads them).
      return html`<li class="mine-sol" data-key="${sol.key}" data-nonce="${sol.nonce}" data-lane="${sol.lane ?? "cpu"}">
        <span class="mine-sol-main"><b>+${amountHTML(sol.reward, view?.divisibility ?? 0)}</b> <span class="caption t-3">block ${heightText(sol.ref)}</span>${chip}${sol.step && (status === "checking" || status === "proving") ? html`<span class="caption t-3">${sol.step}</span>` : ""}</span>
        ${status === "found" ? button({ label: `${sol.capSeen && capWarning(view) ? "Claim anyway" : "Claim"} · ${ROUTE_LABEL[routeNow()]}`, kind: "btc", size: "sm", action: "mine-claim", attrs: { "data-key": sol.key }, disabled: left !== null && left < 0, reason: left !== null && left < 0 ? MINE_TEXT.window : null }) : ""}
        ${sol.message ? html`<p class="caption ${status === "failed" || status === "stale" || (status === "found" && sol.capSeen) ? "t-warn" : "t-3"}">${sol.message}</p>` : ""}
        ${entry?.via === "relay" && MINE_PENDING.has(entry.status) ? html`<p class="caption t-3">${MINE_TEXT.pendingRelay}</p>` : ""}
        ${entry?.held && entry.reason ? html`<p class="caption t-3">${entry.reason}</p>` : ""}
        ${entry?.txid ? html`<a class="caption" href="/tx/${entry.txid}" data-link>Receipt →</a>` : ""}
      </li>`;
    };
    const oldRow = (h) => html`<li class="mine-sol"><span class="mine-sol-main"><b>+${amountHTML(h.reward, h.div ?? 0)}</b> <span class="caption t-3">block ${heightText(h.ref)}</span>${statusChip(h)}</span>${h.held && h.reason ? html`<p class="caption t-3">${h.reason}</p>` : ""}${h.txid ? html`<a class="caption" href="/tx/${h.txid}" data-link>Receipt →</a>` : ""}</li>`;
    const rest = solutions.length - SOLUTION_ROWS;
    el.innerHTML = html`${head}<ul class="mine-sols">${solutions.slice(0, SOLUTION_ROWS).map(row)}${older.map(oldRow)}</ul>${rest > 0 ? html`<p class="caption t-3" data-mine-sols-more>${GPU_TEXT.older(int(rest), autoSubmit)}</p>` : ""}`;
  }

  function paintRoute() {
    const el = $("[data-mine-route]");
    if (!el) return;
    const r = routeNow();
    const m = s.relayInfo?.mine;
    const relayReady = relayOpen() && m?.enabled === true;
    const q = mineQuote({ route: "relay", relayMine: m, serviceSats: service() });
    const bal = s.relayBalance;
    const recent = r === "relay" && s.linkage("relay").some((x) => x.kind === "recent-deposit");
    el.innerHTML = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">PAID BY</div><h2 class="h3">How each claim is paid</h2></div></header>
      <div class="payers">
        ${payerCard({
          value: "relay", name: "mine-route", title: ROUTE_LABEL.relay, checked: r === "relay", disabled: !relayReady,
          reason: relayReady ? null : "The relayer is not taking mining claims on this server.",
          status: bal ? html`${satsHTML(bal.balance)} available` : "balance not read",
          fee: q ? html`~${sats(q.total)} per claim` : null,
        })}
        ${payerCard({
          value: "key", name: "mine-route", title: ROUTE_LABEL.key, checked: r === "key", disabled: !s.minePayer,
          status: s.mineBtc ? html`${satsHTML(s.mineBtc.sats)} ${prov("BTC")}` : "balance not checked",
          fee: s.minePayer ? btcHTML(s.minePayer.address) : null,
        })}
        ${payerCard({ value: "unisat", name: "mine-route", title: ROUTE_LABEL.unisat, checked: r === "unisat", status: s.unisat ? "connected" : "not connected", fee: s.unisat ? btcHTML(s.unisat.address) : null, warning: UNISAT_SIGNET_NOTICE })}
      </div>
      ${r === "key"
        ? html`<p class="caption t-3">${MINE_TEXT.keyApart}</p>
          <div class="inline-actions">${button({ label: "Check balance", kind: "ghost", size: "sm", icon: "refresh", action: "mine-check-btc" })}${button({ label: "Add BTC", kind: "secondary", size: "sm", icon: "plus", action: "mine-add-btc" })}</div>
          <p class="caption t-3" data-mine-coins>${s.mineCoins ? GPU_TEXT.coins(mineCoinSummary({ utxos: s.mineCoins.utxos, history: s.history, need: keyNeed() }), keyNeed()) : GPU_TEXT.coinsNone}</p>
          <p class="caption t-3" data-mine-gpu-rate${rateLine() ? "" : html` hidden`}>${rateLine()}</p>
          <div class="mine-coins"><label class="field-label" for="mine-coins-n">Prepare coins</label><input class="input mono" id="mine-coins-n" type="number" min="1" max="50" name="mine-coins" value="${gpuRateNow() && !coinsEdited ? suggestedCoins(gpuRateNow().perBlock) : coinsN}">${button({ label: "Split", kind: "ghost", size: "sm", action: "mine-prepare" })}</div>
          <p class="caption t-3">Each self-paid claim spends its own coin. Splitting the mining key's balance into several coins lets several claims be in flight at once. ${GPU_TEXT.chain}</p>`
        : ""}
      ${r === "unisat" && !s.unisat ? html`<div class="inline-actions">${button({ label: "Connect Unisat", kind: "secondary", size: "sm", action: "mine-unisat" })}</div>` : ""}
      ${r === "relay" && bal && q && BigInt(bal.balance) < q.total ? callout(`Your relay balance is ${int(bal.balance)} sats; a claim needs about ${int(q.total)}. Top up, or pay with the mining key.`, "warn") : ""}
      ${recent ? callout(MINE_TEXT.recentDeposit, "warn") : ""}
      ${r === "relay" && relayReady ? mineMixBlock(s.relayInfo, mineLinkable, minePoolThin) : ""}`;
  }

  function paintCopy() {
    const el = $("[data-mine-copy]");
    if (!el) return;
    const r = routeNow();
    const lines = mineCopy(r, {
      ticker: view?.ticker ?? "this token",
      reward: view ? amountText(view.reward, view.divisibility, view.ticker) : "the reward",
      feeSats: MINE_FEE?.platformSats ?? null,
      phone,
    });
    if (nearCap(view)) lines.unshift(MINE_TEXT.nearCap);
    el.innerHTML = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">WHAT TO KNOW</div><h2 class="h3">${r === "relay" ? "Relayed claims" : "Self-paid claims"}</h2></div></header>
      <ul class="mine-copy">${lines.map((t) => html`<li>${t}</li>`)}</ul>
      <p class="caption t-3">The relayer, when it carries a claim, sees it before the chain does and can delay or reorder the claims it carries. Nobody can redirect a reward or forge work.</p>`;
  }

  /* ----- events ----- */

  const onClick = async (e) => {
    const b = e.target.closest?.("[data-action]");
    if (!b || !root.contains(b)) return;
    try {
      switch (b.dataset.action) {
        case "mine-start":
          if (s.view?.height == null) await s.sync();
          await ctl.start(threads);
          return paint();
        case "mine-stop":
          ctl.stop();
          return paint();
        case "mine-claim": {
          const sol = solutions.find((x) => x.key === b.dataset.key);
          if (sol) {
            sol.force = true; // the user asked: the wallet is asked again, whatever it said before in this block, and this solution goes next in the queue
            queueClaim(sol);
            if (sol.status === "found" && alive) paintSolutions(); // the row reads Queued at once
          }
          return;
        }
        case "mine-check-btc":
          b.disabled = true;
          await s.checkMineBtc();
          return paintRoute();
        case "mine-add-btc":
          if (s.minePayer) {
            const { copyText } = await import("../ui/behaviors.js");
            if (await copyText(s.minePayer.address)) toast({ kind: "info", title: "Mining key address copied.", body: IS_SIGNET ? "Send signet BTC to it from a faucet or any signet wallet. It pays self-paid claims only." : "Send BTC to it from any Bitcoin wallet. It pays self-paid claims only." });
          }
          return;
        case "mine-prepare": {
          b.disabled = true;
          const r = await s.prepareCoins(coinsN);
          toast({ kind: "success", title: `Splitting into ${r.n} coins.`, body: `${sats(r.value)} each, in the mempool now.` });
          return paintRoute();
        }
        case "mine-unisat":
          await s.connectUnisat();
          return paint();
      }
    } catch (err) {
      toast({ kind: "danger", title: "That didn't work.", body: err.message });
      paint();
    }
  };
  const onChange = (e) => {
    const t = e.target;
    if (t.name === "mine-asset") {
      want = t.value;
      view = null;
      paint();
      loadView();
    } else if (t.name === "mine-route") {
      route = t.value;
      paint();
    } else if (t.name === "mine-auto") {
      autoSubmit = t.checked;
      paintSolutions(); // the note under a long list says whether the rest is claimed
    } else if (t.name === "mine-gpu") {
      ctl.enableGpu(t.checked === true);
      // The processor lanes and the GPU lane share the tab's memory with the prover: with the GPU on, the slider moves down to a
      // small number (the user can still change it, and 12 threads plus the GPU ran the first claim out of memory).
      if (t.checked === true && ctl.gpu?.w) {
        const small = gpuThreads(threads, tr);
        if (small !== threads) {
          threads = small;
          ctl.setThreads(threads);
        }
      }
      paintControls();
    } else if (t.name === "mine-gpu-memory") {
      const m = Number(t.value);
      if (GPU_MEMORY_CHOICES.includes(m)) {
        gpuMemory = m;
        saveGpuMemory(m);
        ctl.gpuOpen = gpuOpenOf();
      }
      paintControls();
    } else if (t.name === "mine-linkable") {
      mineLinkable = t.checked === true;
    } else if (t.name === "mine-coins") {
      const n = Number(t.value);
      coinsEdited = true;
      if (Number.isInteger(n) && n >= 1 && n <= 50) coinsN = n;
    } else if (t.name === "mine-threads") {
      threads = Number(t.value) || 1;
      chosenThreads = threads;
      ctl.setThreads(threads);
      paintControls();
    }
  };
  const onInput = (e) => {
    if (e.target.name !== "mine-threads") return;
    const out = root.querySelector("[data-threads-out]");
    if (out) out.textContent = String(e.target.value);
  };

  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  shell();
  paint();
  loadList();
  if (!s.relayInfo) s.loadRelayInfo().then(() => alive && paint()).catch(() => {});
  // Carriers held for the next block survive a reload (their hex is in the history): send them again once the wallet is synced.
  if (s.view) s.resendHeldClaims?.().catch?.(() => {});
  const poll = setInterval(() => {
    if (!alive) return;
    loadView();
    sweepExpired();
    checkBackpressure();
    probeWaiting();
  }, POLL_MS);
  let lastTip = s.view?.height ?? null;
  const offLive = liveSession(s, (type) => {
    if (!alive) return;
    // The wallet reached a new block: a new challenge for every worker, once the token's view
    // shows that block too (loadView restarts on its new tip); until then the workers keep
    // searching the previous challenge, which stays valid for 11 more blocks.
    if (type === "sync" && s.view?.height !== lastTip) {
      lastTip = s.view?.height ?? null;
      if (syncAction(s.view?.height, view?.tip?.height) === "reload") loadView();
      else if (ctl.running) ctl.restart();
      sweepExpired();
      checkBackpressure();
      retryOnTip({ s, solutions, autoSubmit, queue: claimQueue, route: routeNow() }).catch(() => {});
    }
    paint();
  });
  const offStreamer = wireStreamer(root, paint);
  return () => {
    alive = false;
    clearInterval(poll);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    ctl.terminate();
    for (const sol of solutions) if (sol.status === "found" || sol.status === "expired") s.releaseDraft(sol.draft);
    root.removeEventListener("click", onClick);
    root.removeEventListener("change", onChange);
    root.removeEventListener("input", onInput);
    offLive();
    offStreamer();
  };
}

export function render(root, params, query) {
  // No mining until this network's service-fee rule is complete (MINE_FEE, docs/MAINNET.md G5).
  if (mineFeeReady()) {
    root.innerHTML = html`<div class="wl">${pageHead({ eyebrow: "MINE", title: "Mine", lead: "Mining is not configured on mainnet yet." })}${callout("Mining is not configured on mainnet yet. Nothing here mines or pays.", "info")}</div>`;
    return () => {};
  }
  return withWallet(root, (s) => mineView(root, s, query));
}

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
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { int, sats, heightText, plural, DASH } from "../ui/format.js";
import { button, panel, payerCard, progress, kv, empty, tag } from "../ui/components.js";
import { prov } from "../ui/prov.js";
import { sigil } from "../ui/sigil.js";
import { toast } from "../ui/toast.js";
import { hex } from "../../../src/bytes.mjs";
import { targetHex } from "../../../src/mine.mjs";
import { MINE_FEE, mineFeeReady } from "../../../src/params.mjs";
import { IS_SIGNET } from "../config.js";
import * as api from "../api.js";
import { mineFeeOutputs, mineQuote, mineWindowLeft, nextBlockRate, MINE_PENDING } from "../session.js";
import { mixState, poolMix, relayOpen } from "../relay.js";
import { UNISAT_SIGNET_NOTICE } from "../payers.js";
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
const RATE_WINDOW_MS = 10_000;

/* ---------- pure helpers (tested in test/mine-web.test.mjs) ---------- */

/** Threads the slider offers: 1 … hardwareConcurrency − 1 (at least 1), default half. */
export function threadRange(hc = globalThis.navigator?.hardwareConcurrency) {
  const n = Number.isInteger(hc) && hc > 0 ? hc : 2;
  const max = Math.max(1, n - 1);
  return { min: 1, max, value: Math.max(1, Math.min(max, Math.floor(n / 2))) };
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

/**
 * Supply is nearly mined out when what is left, counting claims in flight, is below the reward
 * times (claims in the last 3 blocks + 1) (mining.md §6.4).
 */
export function nearCap(view) {
  if (!view) return false;
  const reward = BigInt(view.reward ?? 0);
  if (reward <= 0n) return false;
  // Claims in flight at their own rewards (pendingReward) when the server reports it.
  const pending = /^\d+$/.test(String(view.pendingReward ?? ""))
    ? BigInt(view.pendingReward)
    : reward * (Number.isSafeInteger(view.pendingClaims) ? BigInt(view.pendingClaims) : 0n);
  const remaining = BigInt(view.maxSupply) - BigInt(view.issued) - pending;
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
 *   onFound({ draft, nonce, powHash, hashes })   after every worker was told to stop
 *   onChange(type)     "ready" | "progress" | "state" | "error"
 * restart() builds a new challenge and restarts every worker (a new tip, after a solution).
 */
export class MineController {
  constructor({ spawn, prepare, onFound = () => {}, onChange = () => {}, now = () => Date.now(), random = randomNonceHex } = {}) {
    Object.assign(this, { spawn, prepare, onFound, onChange, now, random });
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
        // Hashes of an earlier challenge of this controller count too (a worker reports the
        // last part of a search when it is stopped or restarted): this tab computed them.
        if (m.id != null && !(Number.isSafeInteger(m.id) && m.id >= 1 && m.id <= this.seq)) return;
        this.samples.push([this.now(), Number(m.hashes) || 0, Number(m.ms) || 0]);
        this.total += Number(m.hashes) || 0;
        return this.onChange("progress");
      case "found": {
        const job = this.job;
        if (!job || (m.id != null && m.id !== job.id)) return; // a solution of an older challenge: ignored
        // One solution per challenge: every worker stops, the solution is handed over, then a new challenge.
        this.job = null;
        for (const x of this.workers) x.postMessage({ type: "stop" });
        try {
          this.onFound({ draft: job.draft, nonce: m.nonce, powHash: m.powHash, hashes: m.hashes });
        } finally {
          if (this.running) this.restart();
        }
        return;
      }
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

  async start(threads = this.threads) {
    this.threads = Math.max(1, threads | 0);
    this.#grow(this.threads);
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
    this.onChange("state");
  }

  /** A new challenge for every worker: on a new tip and after each solution. */
  async restart() {
    if (!this.running) return;
    const id = ++this.seq;
    this.job = null;
    for (const w of this.workers) w.postMessage({ type: "stop" });
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
    this.onChange("state");
  }

  setThreads(n) {
    this.threads = Math.max(1, n | 0);
    if (!this.running) return;
    const before = this.workers.length;
    this.#grow(this.threads);
    if (this.job && this.workers.length > before) {
      for (const w of this.workers.slice(before)) w.postMessage({ type: "start", id: this.job.id, challenge: this.job.challenge, target: this.job.target, nonceStart: this.random(), step: 1, progressMs: 1000 });
    }
  }

  /**
   * This tab's hashrate (H/s): the hashes reported in the last 10 s over the time they cover,
   * that is 10 s, or less right after Start (never less than the longest report, at least 1 s).
   */
  hashrate() {
    const t = this.now();
    this.samples = this.samples.filter(([at]) => t - at <= RATE_WINDOW_MS);
    const sum = this.samples.reduce((s, [, n]) => s + n, 0);
    if (!sum) return 0;
    const longest = this.samples.reduce((m, [, , ms]) => Math.max(m, ms), 0);
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
    for (const p of this.verifies.values()) p.reject(new Error("Mining stopped."));
    this.verifies.clear();
  }
}

/**
 * Refusals after which this solution can never be claimed (by any route, at any time): the
 * work is wrong or no longer counts, the supply or the window is gone, or it was handed out.
 */
export const FINAL_CLAIM_CODES = new Set(["pow_mismatch", "stale_work", "insufficient", "cap_reached", "closed", "solution_taken", "expired", "ended"]);

/**
 * A claim failure, as the page handles it: a fast path that disagreed is disabled at once. A
 * refusal before anything left the browser (no W-M entry) that is not final leaves the solution
 * "found", so the Claim button retries it, by the same or another route, until its window
 * closes (a stale relay balance, Unisat not connected, no unbound coin, a network error).
 */
export function onClaimError(err, ctl) {
  if (err?.code === "pow_mismatch") ctl?.disableFast("the reference re-check disagreed");
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

export function mineView(root, s, query, { spawn = spawnWorker } = {}) {
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
  const tr = threadRange();
  let threads = tr.value;
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

  const ctl = new MineController({
    spawn,
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

  function found({ draft, nonce, powHash }) {
    s.holdDraft(draft); // its notes stay out of the next challenge (W-M)
    const sol = { key: `${draft.refHeight}:${nonce}`, draft, nonce, powHash, status: "found", ref: draft.refHeight, reward: draft.reward, at: Date.now() };
    solutions.unshift(sol);
    if (autoSubmit) claim(sol);
    else paint();
  }

  async function claim(sol) {
    if (sol.status !== "found") return;
    sol.status = "checking";
    paint();
    try {
      const entry = await s.claimMine({
        draft: sol.draft, nonce: sol.nonce, powHash: sol.powHash, route: routeNow(), referenceHash: (pw) => ctl.verify(pw),
        linkable: routeNow() === "relay" && mineLinkable && (minePoolThin || mixState(s.relayInfo) === "thin"),
        onStep: (st) => {
          sol.step = st.id;
          if (st.id === "prove" && st.status === "running") sol.status = "proving";
          if (alive) paintSolutions();
        },
      });
      sol.entryId = entry.id;
      sol.status = entry.status;
    } catch (e) {
      if (e?.code === "pool_thin") minePoolThin = true;
      Object.assign(sol, onClaimError(e, ctl));
      if (e?.entry) sol.entryId = e.entry.id;
      // Nothing was handed out: the solution's notes stay out of the next challenge until it is claimed or expires (W-M).
      if (sol.status === "found") s.holdDraft(sol.draft);
    }
    if (alive) paint();
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
    el.innerHTML = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">CONTROLS</div></div></header>
      <div class="mine-controls">
        ${ctl.running ? button({ label: "Stop", kind: "secondary", size: "lg", icon: "cross", action: "mine-stop" }) : button({ label: "Start mining", kind: "btc", size: "lg", icon: "block", action: "mine-start", disabled: Boolean(reason), reason })}
        <label class="mine-threads"><span class="field-label">Threads <span class="mono" data-threads-out>${threads}</span> of ${tr.max}</span><input type="range" name="mine-threads" min="${tr.min}" max="${tr.max}" value="${threads}"></label>
        <label class="mine-auto"><input type="checkbox" name="mine-auto"${autoSubmit ? html` checked` : ""}><span>Claim each solution automatically</span></label>
      </div>
      <p class="caption t-3">${MINE_TEXT.gpu}</p>`;
  }

  function paintLive() {
    const el = $("[data-mine-live]");
    if (!el) return;
    const mine = ctl.hashrate();
    const fig = liveFigures({ hashrate: mine, difficulty: view?.difficulty });
    const landed = s.history.filter((h) => h.kind === "mine" && h.status === "landed" && view && h.assetId === String(view.asset));
    const earned = landed.reduce((x, h) => x + BigInt(h.reward ?? 0), 0n);
    el.innerHTML = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">LIVE ${prov("YOU")}</div></div></header>
      <div class="mine-figures">
        <div><span class="caption t-3">This tab</span><b class="mono">${rateText(mine)}</b><span class="caption t-3">10-second average</span></div>
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
    const head = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">SOLUTIONS</div><h2 class="h3">Found in this tab</h2></div></header>`;
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
      const chip = entry ? statusChip(entry) : tag(SOL_TEXT[status] ?? status, status === "failed" || status === "stale" ? "warn" : status === "expired" ? "neutral" : "btc");
      const left = s.view ? mineWindowLeft(sol.ref, s.view.height, routeNow()) : null;
      return html`<li class="mine-sol">
        <span class="mine-sol-main"><b>+${amountHTML(sol.reward, view?.divisibility ?? 0)}</b> <span class="caption t-3">block ${heightText(sol.ref)}</span>${chip}${sol.step && (status === "checking" || status === "proving") ? html`<span class="caption t-3">${sol.step}</span>` : ""}</span>
        ${status === "found" ? button({ label: `Claim · ${ROUTE_LABEL[routeNow()]}`, kind: "btc", size: "sm", action: "mine-claim", attrs: { "data-key": sol.key }, disabled: left !== null && left < 0, reason: left !== null && left < 0 ? MINE_TEXT.window : null }) : ""}
        ${sol.message ? html`<p class="caption ${status === "failed" || status === "stale" ? "t-warn" : "t-3"}">${sol.message}</p>` : ""}
        ${entry?.via === "relay" && MINE_PENDING.has(entry.status) ? html`<p class="caption t-3">${MINE_TEXT.pendingRelay}</p>` : ""}
        ${entry?.txid ? html`<a class="caption" href="/tx/${entry.txid}" data-link>Receipt →</a>` : ""}
      </li>`;
    };
    const oldRow = (h) => html`<li class="mine-sol"><span class="mine-sol-main"><b>+${amountHTML(h.reward, h.div ?? 0)}</b> <span class="caption t-3">block ${heightText(h.ref)}</span>${statusChip(h)}</span>${h.txid ? html`<a class="caption" href="/tx/${h.txid}" data-link>Receipt →</a>` : ""}</li>`;
    el.innerHTML = html`${head}<ul class="mine-sols">${solutions.slice(0, 50).map(row)}${older.map(oldRow)}</ul>`;
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
          <div class="mine-coins"><label class="field-label" for="mine-coins-n">Prepare coins</label><input class="input mono" id="mine-coins-n" type="number" min="1" max="50" name="mine-coins" value="${coinsN}">${button({ label: "Split", kind: "ghost", size: "sm", action: "mine-prepare" })}</div>
          <p class="caption t-3">Each self-paid claim spends its own coin. Splitting the mining key's balance into several coins lets several claims be in flight at once. One coin can carry at most about 25 unconfirmed claims in a chain.</p>`
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
          if (sol) await claim(sol);
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
    } else if (t.name === "mine-linkable") {
      mineLinkable = t.checked === true;
    } else if (t.name === "mine-coins") {
      const n = Number(t.value);
      if (Number.isInteger(n) && n >= 1 && n <= 50) coinsN = n;
    } else if (t.name === "mine-threads") {
      threads = Number(t.value) || 1;
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
  const poll = setInterval(() => alive && loadView(), POLL_MS);
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
    }
    paint();
  });
  const offStreamer = wireStreamer(root, paint);
  return () => {
    alive = false;
    clearInterval(poll);
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

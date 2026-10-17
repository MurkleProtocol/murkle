#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// End-to-end run of the "Use the graphics card (beta)" box on /app/mine in headless Chrome with Puppeteer, on a labelled
// rented NVIDIA Linux box. NOT for the owner's workstation: it opens the machine's
// GPU in a browser and hashes flat out. It refuses to start without MURKLE_WEBGPU=gpu, and refuses MURKLE_NETWORK=mainnet.
//
// Nothing is ever broadcast and mainnet is never contacted. The page talks to a box-local SIGNET indexer on 127.0.0.1
// that only reads. Every request the page makes to an outside host goes through route() of test/fixtures/fake-mine-payer.mjs:
//   "fake"    the mining key's coin listing, POST /tx and the fake txids' lookups are answered by the fake payer in this process
//   "pass"    this page's own origin and every other read under the signet Esplora base
//   "forbid"  anything else (another host, a mainnet path): aborted, and the run fails
//
// Usage: MURKLE_WEBGPU=gpu node scripts/e2e-gpu-mine.mjs --url http://127.0.0.1:8787 --chrome <path> --scenario 1 [options]
//   --scenario 1|2|3|4   1 the shipped path (build A, fake limit 25), 2 the chain wait and held path (build A, limit 6, 1 coin),
//                        3 forced wrong answer (build B = MURKLE_LAB=1, ?gpufault=5), 4 no WebGPU (build A, navigator.gpu removed)
//   --limit N            the fake's chain limit (1: 25, 2: 6)        --solutions N   stop after N handed-out solutions (8)
//   --minutes M          the longest a scenario runs (45; 4 and 3 use their own shorter limits)
// Environment: E2E_THREADS=n sets the page's CPU threads slider before Start (the page moves it to 2 when the GPU box is ticked;
//   12 reproduces the out-of-memory hang of the first run).
//   --ticker T           the mined token (default: the first open one)  --state FILE   a COPY of the indexer's state file, used to
//                        run the indexer's checkMine on every broadcast carrier (best effort; skipped without it)
//   --out FILE           one JSON line per event (results-e2e.json)     --shots DIR     a screenshot of each state
// Exit code: 0 every criterion passed, 1 a criterion failed, 2 refused (environment or arguments).
//
// The pure parts (arguments, the guard, the carrier check, the verdicts) are exported and tested in test/e2e-gpu-mine.test.mjs.
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as btc from "@scure/btc-signer";
import { assertWebGpuAllowed } from "../src/webgpu/guard.mjs";
import { OP, decodeEnvelope, opReturnPayload } from "../src/envelope.mjs";
import { MINE_FEE } from "../src/params.mjs";
import { hex, outpointOf } from "../src/bytes.mjs";
import { launchOptions } from "./webgpu-chrome.mjs";

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Arguments -> options. Throws a plain sentence on a bad one. */
export function parseE2eArgs(argv) {
  const o = { url: null, chrome: null, scenario: 1, limit: null, solutions: 8, minutes: 45, ticker: null, state: null, out: "results-e2e.json", shots: null };
  const whole = (name, v, min = 1) => {
    if (!/^\d+$/.test(String(v)) || Number(v) < min) throw new Error(`--${name} needs a whole number of at least ${min}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--url") o.url = value().replace(/\/+$/, "");
    else if (a === "--chrome") o.chrome = value();
    else if (a === "--scenario") {
      o.scenario = whole("scenario", value());
      if (o.scenario > 4) throw new Error("--scenario is 1, 2, 3 or 4");
    } else if (a === "--limit") o.limit = whole("limit", value(), 2);
    else if (a === "--solutions") o.solutions = whole("solutions", value());
    else if (a === "--minutes") o.minutes = whole("minutes", value());
    else if (a === "--ticker") o.ticker = value().toUpperCase();
    else if (a === "--state") o.state = value();
    else if (a === "--out") o.out = value();
    else if (a === "--shots") o.shots = value();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.url) throw new Error("--url is needed (the box-local signet indexer, on 127.0.0.1)");
  if (!LOCAL.test(o.url)) throw new Error("--url must be an address on 127.0.0.1 or localhost");
  o.limit ??= o.scenario === 2 ? 6 : 25;
  return o;
}

/** The refusals before anything is imported or started. Throws; the caller exits with code 2. */
export function guardE2e(env = process.env, platform = process.platform) {
  if (String(env.MURKLE_NETWORK ?? "").toLowerCase() === "mainnet") throw new Error("refusing: MURKLE_NETWORK=mainnet. This run is signet only; nothing is broadcast and mainnet is never contacted.");
  assertWebGpuAllowed({ env, platform, mode: "gpu", browser: false });
}

/**
 * Checks one broadcast carrier (raw hex): the first input is the coin the MINE envelope is bound to, output 0 is an OP_RETURN
 * with a MINE envelope, and one output pays the platform script exactly `platformSats`.
 * -> { ok, problems: [..], txid, op, firstInput, nonce } (nonce: the claim's 8-byte nonce as hex, the page's solution key is ref:nonce)
 */
export function checkCarrier(rawHex, { platformScriptHex = MINE_FEE.platformScript, platformSats = BigInt(MINE_FEE.platformSats) } = {}) {
  const problems = [];
  const tx = btc.Transaction.fromRaw(Buffer.from(rawHex, "hex"), { allowUnknownOutputs: true });
  const first = tx.getInput(0);
  const firstInput = `${hex(first.txid)}:${first.index}`;
  let env = null;
  const out0 = tx.getOutput(0);
  if (!out0?.script || out0.script[0] !== 0x6a) problems.push("output 0 is not an OP_RETURN");
  else {
    try {
      env = decodeEnvelope(opReturnPayload(out0.script));
    } catch (e) {
      problems.push(`output 0 does not hold a decodable envelope: ${e.message}`);
    }
  }
  if (env) {
    if (env.op !== OP.MINE) problems.push(`the envelope is op ${env.op}, not MINE`);
    else if (hex(env.bindOutpoint) !== hex(outpointOf(hex(first.txid), first.index))) problems.push("the envelope is not bound to the first input");
  }
  let paid = false;
  for (let v = 1; v < tx.outputsLength; v++) {
    const o = tx.getOutput(v);
    if (hex(o.script) === platformScriptHex && o.amount === platformSats) paid = true;
  }
  if (!paid) problems.push(`no output pays ${platformSats} sats to the platform script`);
  return { ok: problems.length === 0, problems, txid: tx.id, op: env?.op ?? null, firstInput, nonce: env?.nonce ? hex(env.nonce) : null };
}

/** A solution's end state is acceptable when it was broadcast, still waits inside its window, or is held; never lost. */
export const GOOD_ENDS = new Set(["broadcast", "waiting", "held"]);
export const BAD_ENDS = new Set(["dropped", "failed", "rejected", "stale", "expired"]);

/** The GPU box phase a caption text means (the text of [data-mine-gpu]); null for no text. */
export function phaseOfText(t) {
  if (!t) return null;
  if (/^WebGPU is not available/.test(t)) return "unsupported";
  if (/^Starting the graphics card/.test(t)) return "starting";
  if (/^Checking /.test(t)) return "selftest";
  if (/passed its check/.test(t)) return "ready";
  if (/^Graphics card paused/.test(t)) return "paused";
  if (/^The graphics card stopped/.test(t)) return "failed";
  if (/^The graphics card is off for this page/.test(t)) return "banned";
  if (/^Off\./.test(t)) return "off";
  return "mining";
}

/** After a proof the processor workers start again; a sample this soon after one (or during one) says nothing about the processor. */
export const CPU_SETTLE_MS = 5000;
export const cpuJudged = (r) => r.proving !== true && !(Number.isFinite(r.sinceProofMs) && r.sinceProofMs < CPU_SETTLE_MS);

/** Where the script moves the pointer to keep the wallet from auto-locking (the page treats pointermove as activity): alternates two spots. */
export const activityPoint = (i) => ({ x: 600 + (i % 2) * 40, y: 400 + (i % 2) * 20 });
/** How often the script nudges the pointer. The wallet locks after 15 minutes without activity (AUTO_LOCK 5 / 15 / 60). */
export const ACTIVITY_MS = 20_000;

/**
 * The verdict of a scenario from its event list. Events: { ev, t, ... }:
 *   state { phase }                       the GPU box phase (starting, selftest, ready, mining, failed, banned, unsupported, off)
 *   rates { gpu, cpu, bench? }            H/s read from the page every 10 s
//                                         While a claim is proved with the GPU on, the page ends the processor workers (the CPU reads 0), so the
//                                         CPU is judged only on samples outside a proof: proving false, and CPU_SETTLE_MS since a proof was last seen
//                                         (rates also carries proving and sinceProofMs)
 *   sol   { key, end }                    a solution's end state (see GOOD_ENDS / BAD_ENDS)
 *   row   { key, nonce, lane, text }      a solution row of the page (lane: "gpu" | "cpu", from the row's data-lane)
 *   cpu-start { cpu, ms }                 the first non-zero CPU H/s after Start (ms: how long it took)
 *   block { height, confirmed } and block-rows { rows, waiting }   a block the fake payer mined, and the page's rows at that moment
 *   post  { ok, fromGpu?, afterFault?, error?, carrier? }   a POST /tx the page made (carrier: the checkCarrier result, with the nonce)
 *   resent { txid }                       a held carrier accepted after a block
 *   net   { url, verdict }                a request that was forbidden
 *   req   { url }                         every request URL (for the no-worker check)
 *   tick                                  the moment the script ticks the GPU box (a gpu-worker request before it fails the run)
 *   jsscan { url, requestAdapter }        a JS file the page loaded before the tick, and whether its text calls requestAdapter
 *   mainnet / checkMine { txid, result }
 * -> { pass, failures: [...], facts }
 */
export function scenarioVerdict(n, events, { solutions = 8, benchHs = null } = {}) {
  const failures = [];
  const of = (ev) => events.filter((e) => e.ev === ev);
  const phases = of("state").map((e) => e.phase);
  const has = (p) => phases.includes(p);
  const forbidden = of("net").filter((e) => e.verdict === "forbid");
  if (forbidden.length) failures.push(`${forbidden.length} forbidden request(s), first: ${forbidden[0].url}`);
  const workerReq = of("req").filter((e) => /gpu-worker/.test(e.url));
  const rates = of("rates");
  const judged = rates.filter(cpuJudged);
  const cpuAlways = judged.length > 0 && judged.every((r) => r.cpu > 0);
  const facts = { phases: [...new Set(phases)], solutions: of("sol").length, posts: of("post").length, gpuHsMax: Math.max(0, ...rates.map((r) => r.gpu ?? 0)), cpuSamples: judged.length, cpuSamplesInProofs: rates.length - judged.length };
  // The CPU lanes must be mining soon after Start (the samples above start only once they are).
  if (n !== 4) {
    const started = of("cpu-start")[0];
    if (!started || !(started.cpu > 0)) failures.push("the processor never reported H/s after Start");
    else facts.cpuStartMs = started.ms ?? null;
  }
  // Which lane found each claim: the page marks every solution row with data-lane; a carrier's nonce ties a POST to its row.
  const rowAt = new Map(); // nonce -> { lane, t } of the row's first sample
  for (const r of of("row")) if (r.nonce && !rowAt.has(r.nonce)) rowAt.set(r.nonce, { lane: r.lane ?? null, t: r.t });
  const laneOfPost = (p) => (p.fromGpu === true ? "gpu" : p.fromGpu === false ? "cpu" : rowAt.get(p.carrier?.nonce)?.lane ?? null);
  facts.gpuPosts = of("post").filter((p) => p.ok && laneOfPost(p) === "gpu").length;
  if (n === 1 || n === 2) {
    for (const p of ["starting", "ready"]) if (!has(p)) failures.push(`the box never reached ${p}`);
    if (!has("mining")) failures.push("the box never reached mining");
    const bad = of("sol").filter((e) => BAD_ENDS.has(e.end));
    if (bad.length) failures.push(`${bad.length} solution(s) ended badly: ${bad.map((e) => `${e.key}=${e.end}`).join(", ")}`);
    const fakeBad = of("post").filter((e) => e.carrier && !e.carrier.ok);
    if (fakeBad.length) failures.push(`${fakeBad.length} carrier(s) failed the shape check: ${fakeBad[0].carrier.problems.join("; ")}`);
    const rejectedByIndexer = of("checkMine").filter((e) => e.result !== true);
    if (rejectedByIndexer.length) failures.push(`${rejectedByIndexer.length} carrier(s) failed the indexer's checkMine: ${rejectedByIndexer[0].result}`);
    if (!cpuAlways) failures.push(judged.length ? "the processor reported 0 H/s at some sample outside a proof" : "no processor sample outside a proof to judge");
    if (n === 1) {
      if (of("sol").length < 1) failures.push("no solution was found");
      if (benchHs && facts.gpuHsMax < 0.5 * benchHs) failures.push(`the page's GPU rate ${facts.gpuHsMax} H/s is under 50% of the bench ${benchHs} H/s`);
    }
    // Throughput after a block: the claims that went out before the next block must match the claims that were waiting. A block that
    // confirmed carriers frees chain room, so min(waiting, 12) of them must go out in the interval (measured against the fake
    // payer's real confirmations; only a complete interval, with a next block, counts).
    const blocks = of("block");
    for (let i = 0; i + 1 < blocks.length; i++) {
      const [b, next] = [blocks[i], blocks[i + 1]];
      const rows = of("block-rows").find((r) => r.t >= b.t && r.t <= next.t);
      const waiting = rows?.waiting ?? 0;
      if (!(b.confirmed > 0) || waiting < 1) continue;
      const sent = of("post").filter((p) => p.ok && p.t > b.t && p.t <= next.t).length;
      const expected = Math.min(waiting, 12);
      (facts.afterBlock ??= []).push({ height: b.height, confirmed: b.confirmed, waiting, sent });
      if (sent < expected) failures.push(`after block ${b.height} (${b.confirmed} carriers confirmed, ${waiting} claims waiting) only ${sent} claim(s) went out before the next block, expected at least ${expected}`);
    }
    if (n === 2) {
      if (!of("post").some((e) => !e.ok && /too-long-mempool-chain/.test(e.error ?? ""))) failures.push("no broadcast was refused for chain length");
      if (!of("resent").length) failures.push("no held carrier was accepted after a block");
    }
  }
  if (n === 3) {
    if (!has("mining")) failures.push("the box never reached mining before the fault");
    if (!has("banned")) failures.push("the box never became banned");
    if (!cpuAlways) failures.push(judged.length ? "the processor reported 0 H/s at some sample outside a proof" : "no processor sample outside a proof to judge");
    // No claim of a solution the GPU lane found after the ban may be posted: the lane is off. A solution the lane found earlier had
    // passed the lane's re-checks and is still re-checked with the reference before it is paid, so its claim may go out late. A post
    // whose lane is not known counts as a GPU one. "Before the ban" means: its row was on the page when the harness saw the banned
    // phase (fault-seen carries those rows' nonces; without them, the time of the row's first sample). The harness reads the page
    // once a second, so a solution the lane found in the second before that read still counts as found before the ban: the strict
    // bound is approximate by up to 1 s.
    const banEv = of("fault-seen")[0];
    const banAt = banEv?.t ?? of("state").find((e) => e.phase === "banned")?.t ?? null;
    const rowsAtBan = Array.isArray(banEv?.nonces) ? new Set(banEv.nonces) : null;
    const gpuPostsAfter = of("post").filter((e) => {
      if (!e.afterFault) return false;
      const lane = laneOfPost(e);
      if (lane === "cpu") return false;
      if (lane === "gpu" && rowsAtBan) return !rowsAtBan.has(e.carrier?.nonce); // a row not on the page at the ban came from the banned lane
      if (lane === "gpu" && banAt !== null) {
        const seen = rowAt.get(e.carrier?.nonce)?.t;
        return seen === undefined || seen > banAt; // a row first seen after the ban came from the banned lane
      }
      return true;
    });
    facts.gpuPostsAfterBan = of("post").filter((e) => e.afterFault && laneOfPost(e) === "gpu").length;
    if (gpuPostsAfter.length) failures.push(`${gpuPostsAfter.length} POST /tx after the ban of a GPU-lane solution found after it (or of unknown lane)`);
    if (!of("check").some((e) => e.name === "banned-disabled" && e.ok)) failures.push("the box was not disabled once banned");
    if (!of("check").some((e) => e.name === "cpu-after-ban" && e.ok)) failures.push("the processor did not keep mining for 60 s after the ban");
    if (!of("check").some((e) => e.name === "stop-start" && e.ok)) failures.push("Stop / Start mining did not work after the ban");
  }
  if (n === 4) {
    if (!has("unsupported")) failures.push("the box did not show the unsupported text");
    if (workerReq.length) failures.push("a gpu-worker file was requested");
    if (!of("check").some((e) => e.name === "box-disabled" && e.ok)) failures.push("the box was not disabled");
    if (!rates.length || !rates.some((r) => r.cpu > 0)) failures.push("the processor reported no H/s");
  }
  if (n === 1 || n === 2) {
    // The tick is the script's own click on the box (the first "starting" phase seen is the fallback): no gpu-worker request may come before it.
    const tickT = (of("tick")[0] ?? of("state").find((e) => e.phase === "starting"))?.t ?? null;
    if (workerReq.length && tickT === null) failures.push("the GPU worker was requested without a tick");
    else if (tickT !== null && workerReq.some((e) => e.t < tickT)) failures.push(`the GPU worker was requested before the tick: ${workerReq.find((e) => e.t < tickT).url}`);
    const eager = of("jsscan").filter((e) => e.requestAdapter);
    if (eager.length) failures.push(`${eager.length} script(s) loaded before the tick call requestAdapter, first: ${eager[0].url}`);
  }
  return { pass: failures.length === 0, failures, facts };
}

/* ---------- the browser run (box only) ---------- */

async function main() {
  let o;
  try {
    o = parseE2eArgs(process.argv.slice(2));
    guardE2e(); // before anything is imported or started
  } catch (e) {
    console.error(`e2e-gpu-mine: ${e.message}`);
    process.exit(2);
  }
  const t0 = Date.now();
  const events = [];
  const emit = (ev, data = {}) => {
    const line = { ev, t: Date.now() - t0, ...data };
    events.push(line);
    const text = JSON.stringify(line, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    appendFileSync(o.out, `${text}\n`);
  };
  let browser;
  try {
    const { FakeMinePayer } = await import("../test/fixtures/fake-mine-payer.mjs");
    const puppeteer = (await import("puppeteer-core")).default; // only after the guard has passed
    const profile = mkdtempSync(join(tmpdir(), "murkle-e2e-profile-"));
    browser = await puppeteer.launch({ ...launchOptions(o, (await puppeteer.defaultArgs?.({ headless: true })) ?? []), userDataDir: profile });
    const payer = new FakeMinePayer({ limit: o.limit });
    const verdict = await runScenario({ o, browser, payer, emit, events });
    emit("verdict", verdict);
    console.log(JSON.stringify(verdict));
    process.exitCode = verdict.pass ? 0 : 1;
  } catch (e) {
    console.error(`e2e-gpu-mine: ${e?.stack ?? e}`);
    emit("error", { message: String(e?.message ?? e) });
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
  }
}

async function runScenario({ o, browser, payer, emit, events }) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  if (o.shots) mkdirSync(o.shots, { recursive: true });
  const shot = async (name) => {
    if (o.shots) await page.screenshot({ path: join(o.shots, `s${o.scenario}-${name}.png`) }).catch(() => {});
  };
  if (o.scenario === 4) await page.evaluateOnNewDocument(() => {
    delete Navigator.prototype.gpu;
  });
  let afterFault = false;
  await page.setRequestInterception(true);
  page.on("request", async (req) => {
    const url = req.url();
    const method = req.method();
    const verdict = payer.route(url, method);
    emit("req", { url, method });
    if (verdict === "pass") return req.continue();
    if (verdict === "forbid") {
      emit("net", { url, method, verdict });
      return req.abort("blockedbyclient");
    }
    const body = method === "POST" ? req.postData() ?? "" : "";
    const a = await payer.answer(url, method, body);
    if (method === "POST") {
      const sent = payer.broadcasts.at(-1);
      let carrier = null;
      try {
        carrier = checkCarrier(body);
      } catch (e) {
        carrier = { ok: false, problems: [`not a transaction: ${e.message}`] };
      }
      emit("post", { ok: a.status === 200, txid: sent?.txid ?? null, error: a.status === 200 ? null : a.body, carrier, afterFault, fromGpu: null });
    }
    return req.respond({ status: a.status, contentType: a.contentType, body: a.body, headers: { "access-control-allow-origin": "*" } });
  });
  page.on("pageerror", (e) => emit("pageerror", { message: String(e?.message ?? e) }));
  // Every script the page loads before the tick is read: none may call requestAdapter (the engine lives in the gpu-worker file).
  let ticked = false;
  page.on("response", async (res) => {
    const url = res.url();
    if (ticked || !/\.m?js(\?|$)/.test(url) || !res.ok()) return;
    try {
      emit("jsscan", { url, requestAdapter: /requestAdapter/.test(await res.text()) });
    } catch {
      // a response whose body is gone (a redirect, a cancelled load) cannot be read
    }
  });

  // 1. a wallet through /app/create, then the Mine page
  const password = `e2e-${Date.now()}-correct horse battery`;
  await page.goto(`${o.url}/app/create`, { waitUntil: "load" });
  await page.waitForSelector("[name=password]");
  await page.type("[name=password]", password);
  await page.type("[name=confirm]", password);
  await Promise.all([page.waitForSelector(".phrase-grid b"), page.click("[data-f] button[type=submit]")]);
  const words = await page.$$eval(".phrase-grid b", (els) => els.map((e) => e.textContent.trim()));
  await page.click("[data-saved]");
  await page.click("[data-action=next]");
  await page.waitForSelector(".confirm-words input");
  for (const name of await page.$$eval(".confirm-words input", (els) => els.map((e) => e.name))) await page.type(`[name=${name}]`, words[Number(name.slice(1))]);
  await page.click("[data-f] button[type=submit]");
  await page.waitForFunction(() => document.body.textContent.includes("Wallet encrypted on this device"), { timeout: 120_000 });
  const params = [o.ticker ? `t=${encodeURIComponent(o.ticker)}` : null, o.scenario === 3 ? "gpufault=5" : null].filter(Boolean);
  const query = params.length ? `?${params.join("&")}` : "";
  await page.evaluate((q) => {
    history.pushState(null, "", `/app/mine${q}`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, query);
  await page.waitForSelector("[data-mine-controls] input[name=mine-gpu]", { timeout: 60_000 });
  const route = await page.$eval("[data-mine-route]", (e) => e.outerHTML);
  const address = /tb1p[0-9a-z]{50,}/.exec(route)?.[0];
  if (!address) throw new Error("the mining key's address was not found on the Mine page");
  payer.miningAddress = address;
  payer.seed(o.scenario === 2 ? [200_000] : [200_000, 200_000], { height: 1 });
  emit("wallet", { address, coins: payer.listing().length });
  await page.click("[data-action=mine-check-btc]").catch(() => {});

  const text = (sel) => page.$eval(sel, (e) => e.textContent).catch(() => "");
  // 'starting' lasts well under a second, and the script sleeps between its reads: a MutationObserver in the page keeps every caption the
  // box shows, with its time, and watch() reads them all, so no phase is missed whatever the polling does. Installed before the tick.
  await page.evaluate(() => {
    window.__gpuTexts = [];
    let last = null;
    const note = () => {
      const t = document.querySelector("[data-mine-gpu]")?.textContent ?? null;
      if (t && t !== last) {
        last = t;
        window.__gpuTexts.push(t);
      }
    };
    new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true });
    note();
  });
  let lastPhase = null;
  const watch = async () => {
    const texts = await page.evaluate(() => window.__gpuTexts.splice(0)).catch(() => []);
    const now = await text("[data-mine-gpu]");
    if (now && texts.at(-1) !== now) texts.push(now);
    for (const t of texts) {
      const p = phaseOfText(t);
      if (p && p !== lastPhase) {
        lastPhase = p;
        emit("state", { phase: p, text: t });
        await shot(p);
      }
    }
    return lastPhase;
  };
  // The wallet locks itself after 15 minutes without a pointer or key event, and a run lasts up to 45: a nudge of the pointer now and then.
  let nudges = 0;
  const keepAwake = setInterval(() => {
    const { x, y } = activityPoint(nudges++);
    page.mouse.move(x, y).catch(() => {});
  }, ACTIVITY_MS);
  keepAwake.unref?.();
  const until = async (fn, ms, label, every = 250) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await fn()) return true;
      await sleep(every);
    }
    emit("timeout", { label });
    return false;
  };
  const seen = new Map(); // solution key (ref:nonce) -> last row text
  // Every solution row of this page: its key and nonce (data-key, data-nonce), the lane that found it (data-lane) and its text.
  const readRows = () =>
    page.$$eval("[data-mine-solutions] li.mine-sol[data-key]", (els) => els.map((e) => ({ key: e.dataset.key, nonce: e.dataset.nonce ?? null, lane: e.dataset.lane ?? null, text: e.textContent.replace(/\s+/g, " ").trim() })));
  const sampleRows = async () => {
    const rows = await readRows().catch(() => []);
    for (const r of rows) {
      if (seen.get(r.key) !== r.text) {
        seen.set(r.key, r.text);
        emit("row", r);
      }
    }
    return rows;
  };
  const endOf = (rowText) => (/Dropped/.test(rowText) ? "dropped" : /Rejected/.test(rowText) ? "rejected" : /Not claimed/.test(rowText) ? "failed" : /No longer counts/.test(rowText) ? "stale" : /Expired/.test(rowText) ? "expired"
    : /refused a longer chain/.test(rowText) ? "held" : /Receipt|Submitted|Landed/.test(rowText) ? "broadcast" : /Waiting for a block|Queued|Found/.test(rowText) ? "waiting" : "pending");
  const ratesNow = async () => {
    const live = await text("[data-mine-live]");
    const m = /processor ([\d,.]+)\s*(kH\/s|H\/s|MH\/s) · graphics card ([\d,.]+)\s*(kH\/s|H\/s|MH\/s)/.exec(live);
    const hs = (n, u) => Number(n.replace(/,/g, "")) * (u === "kH/s" ? 1000 : u === "MH/s" ? 1e6 : 1);
    return m ? { cpu: hs(m[1], m[2]), gpu: hs(m[3], m[4]) } : { cpu: hs((/([\d,.]+)\s*(kH\/s|H\/s)/.exec(live) ?? ["", "0", "H/s"]).slice(1)[0], "H/s"), gpu: 0 };
  };
  // A proof is running while a row reads Proving; the processor is paused then and for a moment after (CPU_SETTLE_MS).
  let lastProving = null;
  const ratesSample = async () => {
    const r = await ratesNow();
    const rows = await readRows().catch(() => []);
    const proving = rows.some((x) => /Proving/.test(x.text));
    if (proving) lastProving = Date.now();
    return { ...r, proving, sinceProofMs: lastProving === null ? null : Date.now() - lastProving };
  };
  let blockTimer = null;
  const pollBlocks = async () => {
    let last = null;
    while (blockTimer !== false) {
      try {
        const s = await (await fetch(`${o.url}/api/state`)).json();
        if (last !== null && s.height !== last) {
          // The fake payer takes its mempool into this block: from now on its status route and its coin listing say "confirmed", which is
          // what the page's claim count reads (not the wallet's own "landed", which the fake carriers never reach).
          const ids = payer.confirmAll(s.height);
          emit("block", { height: s.height, confirmed: ids.length });
          const rows = await readRows().catch(() => []);
          emit("block-rows", { rows: rows.length, waiting: rows.filter((r) => !/Receipt/.test(r.text) && /Waiting for a block|Queued|Found:/.test(r.text)).length });
        }
        last = s.height;
      } catch (e) {
        emit("indexer-error", { message: String(e?.message ?? e) });
      }
      await sleep(1000);
    }
  };
  blockTimer = pollBlocks();

  const box = "[data-mine-controls] input[name=mine-gpu]";
  const done = () => new Set(events.filter((e) => e.ev === "row" && /Receipt|Landed|Dropped|Rejected|Not claimed/.test(e.text)).map((e) => e.key)).size;

  if (o.scenario === 4) {
    await watch();
    emit("check", { name: "box-disabled", ok: await page.$eval(box, (e) => e.disabled && !e.checked) });
    await shot("unsupported");
    await page.click("[data-action=mine-start]");
    await until(async () => (await ratesNow()).cpu > 0, 120_000, "cpu hashrate");
    emit("rates", await ratesSample());
  } else {
    ticked = true;
    emit("tick");
    // A click can land before the page wired the box (or while it redraws): click again, up to 5 times, until it is ticked.
    await sleep(3000);
    for (let k = 0; k < 5 && !(await page.$eval(box, (e) => e.checked).catch(() => false)); k++) {
      await page.click(box).catch(() => {});
      await sleep(1500);
    }
    // 'starting' lasts well under a second: poll every 50 ms to see it
    await until(async () => (await watch()) === "ready" || lastPhase === "failed" || lastPhase === "banned", 15_000 + 30_000, "box ready", 50);
    // the page moved the slider to 2 threads when the box was ticked; E2E_THREADS puts it back (12 reproduces the first run's memory hang)
    if (process.env.E2E_THREADS) {
      await page.$eval("input[name=mine-threads]", (e, v) => {
        e.value = v;
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
      }, process.env.E2E_THREADS);
    }
    emit("threads", { slider: await page.$eval("input[name=mine-threads]", (e) => Number(e.value)).catch(() => null) });
    const startedAt = Date.now();
    await page.click("[data-action=mine-start]");
    await until(async () => (await watch()) === "mining" || lastPhase === "banned", 30_000, "mining", 100);
    // CPU H/s after Start: the first non-zero reading, and how long the processor lanes took to report it
    await until(async () => (await ratesNow()).cpu > 0, 60_000, "cpu hashrate after start", 250);
    const cpu0 = await ratesNow();
    emit("cpu-start", { cpu: cpu0.cpu, ms: Date.now() - startedAt });
    const deadline = Date.now() + (o.scenario === 3 ? 120_000 : o.minutes * 60_000);
    let nextRates = 0;
    let bannedAt = null;
    while (Date.now() < deadline) {
      await watch();
      const rows = await sampleRows();
      if (Date.now() >= nextRates) {
        nextRates = Date.now() + 10_000;
        emit("rates", await ratesSample());
      }
      if (o.scenario === 3) {
        if (lastPhase === "banned" && bannedAt === null) {
          bannedAt = Date.now();
          afterFault = true;
          emit("fault-seen", { nonces: rows.filter((r) => r.nonce).map((r) => r.nonce) });
          emit("check", { name: "banned-disabled", ok: await page.$eval(box, (e) => e.disabled && !e.checked) });
          await shot("banned");
        }
        if (bannedAt !== null && Date.now() - bannedAt >= 60_000) break;
      } else if (done() >= o.solutions) break;
      void rows;
      await sleep(1000);
    }
    if (o.scenario === 3) {
      // the processor is judged outside a proof: wait (up to 30 s) for a sample that is not in or just after one
      let r = await ratesSample();
      for (let k = 0; k < 30 && !cpuJudged(r); k++) {
        await sleep(1000);
        r = await ratesSample();
      }
      emit("rates", r);
      emit("check", { name: "cpu-after-ban", ok: r.cpu > 0 });
      await page.click("[data-action=mine-stop]").catch(() => {});
      await sleep(500);
      await page.click("[data-action=mine-start]").catch(() => {});
      await until(async () => (await ratesNow()).cpu > 0, 30_000, "cpu hashrate after restart");
      emit("check", { name: "stop-start", ok: (await ratesNow()).cpu > 0 });
    } else {
      // let waiting claims see one more block, so a held carrier is sent again
      if (o.scenario === 2) await until(() => events.some((e) => e.ev === "block") && payer.broadcasts.some((b) => b.ok), 20 * 60_000, "a block after the refusal");
      const rows = await sampleRows();
      for (const r of rows) emit("sol", { key: r.key, lane: r.lane, end: endOf(r.text) });
    }
  }
  // held carriers sent again: a successful broadcast of a txid that an earlier POST was refused for
  const refused = new Set(payer.broadcasts.filter((b) => !b.ok && b.txid).map((b) => b.txid));
  for (const b of payer.broadcasts) if (b.ok && refused.has(b.txid)) emit("resent", { txid: b.txid });
  // the indexer's own rules on every accepted carrier (best effort; needs --state, a copy of the indexer's state file)
  if (o.state) await checkWithIndexer({ o, payer, emit });
  if (o.scenario === 1 || o.scenario === 2) {
    const first = events.find((e) => e.ev === "rates" && e.gpu > 0);
    emit("recorded", { gpuHs: first?.gpu ?? null, note: "compare with the bench H/s of this card" });
  }
  blockTimer = false;
  clearInterval(keepAwake);
  await shot("end");
  const verdict = scenarioVerdict(o.scenario, events, { solutions: o.solutions });
  verdict.provePending = events.filter((e) => e.ev === "row" && /Proving/.test(e.text)).length;
  return verdict;
}

/** checkMine of the indexer's rules for tip + 1, on a copy of its state, for each accepted carrier. */
async function checkWithIndexer({ o, payer, emit }) {
  try {
    const dir = mkdtempSync(join(tmpdir(), "murkle-e2e-state-"));
    const copy = join(dir, "state.json");
    copyFileSync(o.state, copy);
    const { loadIndexer, loadPinnedVkey } = await import("../src/store-node.mjs");
    const { ARTIFACTS } = await import("../server/indexer-server.mjs");
    const { createNodePowPool } = await import("../src/pow-pool.mjs");
    const { parseRawTx } = await import("../src/btc/block.mjs");
    const { findEnvelope } = await import("../src/envelope.mjs");
    const idx = await loadIndexer(copy, { vkey: loadPinnedVkey(ARTIFACTS["verification_key.json"]), api: null });
    idx.pow = await createNodePowPool({ size: 1 });
    const tip = (await (await fetch(`${o.url}/api/state`)).json()).height;
    for (const raw of payer.accepted) {
      const tx = parseRawTx(raw);
      const payload = findEnvelope(tx);
      const env = decodeEnvelope(payload);
      emit("checkMine", { txid: tx.txid, result: await idx.checkMine(env, tx, tip + 1) });
    }
    await idx.pow.close?.();
  } catch (e) {
    emit("checkMine-skipped", { message: String(e?.message ?? e) });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

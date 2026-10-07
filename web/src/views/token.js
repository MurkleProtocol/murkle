/**
 * /t/:ticker Launch page (visual.md section 9).
 *
 * The terms panel starts with our indexer's numbers (IDX), then this browser fetches the DEPLOY
 * transaction from mempool.space, checks its inclusion and decodes the envelope, and every term
 * that matches the bytes on Bitcoin flips to BTC. A mismatch is shown as a mismatch, never
 * smoothed over. The supply proof states exactly what it rests on, including the development
 * trusted-setup caveat.
 *
 * Tokens only, never people: no holder list, no minter addresses, and the launch card carries
 * no txid unless the launcher opts in.
 *
 * A mined token (kind "pow", mining-contract.md §10.5) gets its own page from GET /api/mine/:asset:
 * reward now, next halving, issued / max, claims, difficulty and stale floor, span and target
 * per block, the hashrate estimate (labelled as one), difficulty and claims charts, rejected
 * claims, service-fee totals, the mining start, the fairness flags and the fairness copy.
 * Claims show the token, the reward, the reference block and the difficulty, never a recipient.
 */
import "../share/public.css";
import * as api from "../api.js";
import { html, on, toNode } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { prov, upgrade } from "../ui/prov.js";
import { int, units, sats, hash, heightText, height as heightHTML, eta, chunks, plural, DASH } from "../ui/format.js";
import { button, panel, progress, statTile, kv, empty, tag } from "../ui/components.js";
import { sealBlock, sealPill } from "../ui/seal.js";
import { INDEXER_HREF } from "../ui/indexer.js";
import { sigil } from "../ui/sigil.js";
import { redact } from "../ui/redact.js";
import { transcript, TranscriptView, summary } from "../ui/transcript.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import { suggestTickers } from "../ui/search.js";
import { getWalletStatus, onWalletStatus } from "../ui/status.js";
import { setTitle } from "../router.js";
import { BRAND, IS_SIGNET } from "../config.js";
import { logAll } from "../verify/pool-data.js";
import {
  pillFor, scheduleText, blocksUntilOpen, blocksLeft, mintLabel, priceText, supplyCheck, recountMints, termsDiff,
} from "../share/launch.js";
import { mintsChart } from "../share/charts.js";
import { entrySeal } from "../share/feed.js";
import { launchCardModel, shareText, xIntentUrl } from "../share/launch-card.js";
import { floorEmission } from "../../../src/mine.mjs";
import { MINE_FEE } from "../../../src/params.mjs";
import { MINE_TEXT, MINE_RECIPIENT } from "./app-shared.js";

const live = () => import("../share/live-check.js");
const card = () => import("../share/launch-card.js");
const funding = () => import("../../../src/btc/funding.mjs");
const TICKER = /^[A-Z0-9]{1,16}$/;

/**
 * What a mined token's page says about privacy (mining-contract.md §12): the reward note is
 * private, but a self-paid claim shows its paying address, so the claims of one address add up.
 */
export const MINED_PRIVACY_TEXT =
  "A claim is a public Bitcoin transaction that shows the token, the reward and how it was paid. The reward goes to a private note. Self-paid claims show the paying address, so anyone can add up what that address mined; relayed claims show only the relayer.";
/** The caption next to a mined token's start block: the launch block itself, or how long after it. */
export const startLead = (m) => {
  const n = Number(m.mineStart) - Number(m.deployHeight);
  if (!Number.isInteger(n) || n < 0) return "";
  return n === 0 ? "the launch block itself" : `${plural(n, "block")} after the launch`;
};
/** The fairness line about the start (mining.md §8.6): an open start favours the ready, a delay shows the terms first. */
export const startFairness = (m) => {
  const n = Number(m.mineStart) - Number(m.deployHeight);
  if (!Number.isInteger(n) || n < 0) return "";
  return n === 0
    ? "Mining opened at the launch block itself. Nobody could know its hash before it was mined, but whoever was ready first had an edge."
    : `Everyone could read the terms for ${plural(n, "block")} before the first usable block.`;
};
const FEED_PAGE = 20;
const big = (v) => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};

export function render(root, params) {
  const ticker = String(params.ticker ?? "").trim().replace(/^\$/, "").toUpperCase();
  setTitle(ticker || "Token");
  if (!TICKER.test(ticker)) return missing(root, ticker, null);

  let a = null;
  let mined = null; // GET /api/mine/:asset when the token is mined (kind "pow")
  let minedFeed = null;
  let height = null;
  let alive = true;
  let check = null; // { state: "running" | "ok" | "diff" | "error", result, diff, idOk, address }
  let feed = null; // mint entries for this asset, newest first
  let feedShown = FEED_PAGE;
  let withTxid = false;
  let cardUrl = null;
  let checkSeq = 0;
  // Term chips render as IDX until the DEPLOY bytes are decoded here; then they crossfade to BTC.
  let chipState = "IDX";

  root.innerHTML = html`<div class="container section tk"><div class="stack stack--l">
    <span class="skel" style="width:30%;height:14px"></span>
    <div class="tk-hero"><div class="stack"><span class="skel" style="width:60%;height:56px"></span><span class="skel" style="width:100%;height:8px"></span><span class="skel" style="width:80%;height:20px"></span></div><span class="skel" style="width:100%;height:320px"></span></div>
  </div></div>`;

  const $ = (s) => root.querySelector(s);
  const url = () => `${location.origin}/t/${ticker}`;

  async function load({ fresh = false } = {}) {
    try {
      const [s, asset] = await Promise.all([api.state({ fresh }).catch(() => null), api.asset(ticker)]);
      if (!alive) return;
      if (asset?.kind === "pow") {
        const view = await api.mineAsset(ticker);
        if (!alive) return;
        height = s?.height ?? view?.tip?.height ?? height;
        mined = view;
        paintMined();
        loadMinedFeed(fresh);
        return;
      }
      const first = !a;
      height = s?.height ?? height;
      a = asset;
      if (first) {
        shell();
        runCheck();
      } else repaint();
      loadFeed(fresh);
    } catch (e) {
      if (!alive) return;
      if (e?.status === 404 || e?.status === 400) return missing(root, ticker, e);
      if (!a && !mined) {
        root.innerHTML = html`<div class="container section"><section class="panel placeholder" role="alert"><div class="eyebrow">${ticker}</div><h1 class="h1-app">This launch page didn't load.</h1><p>${e.message}</p>${button({ label: "Try again", kind: "secondary", action: "tk-retry", icon: "refresh" })}</section></div>`;
      }
    }
  }

  function paintMined() {
    if (!alive || !mined) return;
    root.innerHTML = minedPageHTML(mined, { height, feed: minedFeed, walletReady: getWalletStatus().state === "unlocked" });
  }

  async function loadMinedFeed(fresh = false) {
    try {
      const entries = await logAll({ fresh });
      if (!alive || !mined) return;
      minedFeed = entries.filter((e) => (e.opName === "MINE" || e.opName === "MINE_SCRIPT") && String(e.asset) === String(mined.asset)).reverse();
    } catch {
      minedFeed = minedFeed ?? [];
    }
    paintMined();
  }

  async function loadFeed(fresh = false) {
    try {
      const entries = await logAll({ fresh });
      if (!alive || !a) return;
      feed = entries.filter((e) => (e.opName === "MINT" || e.opName === "MINT_SCRIPT") && String(e.asset) === String(a.id)).reverse();
    } catch {
      feed = feed ?? [];
    }
    paintFeed();
    paintSupply();
  }

  /* ---------- layout ---------- */

  function shell() {
    root.innerHTML = html`<div class="container section tk">
      <nav class="tk-crumbs" aria-label="Breadcrumb"><a href="/mints" data-link>Mints</a><span aria-hidden="true">/</span><span class="mono">${a.ticker}</span></nav>
      <div class="tk-hero">
        <div class="tk-main" data-hero></div>
        <aside class="panel panel--certified tk-terms" aria-labelledby="tk-terms-h" data-terms></aside>
      </div>
      <div class="tk-body">
        <div class="tk-col">
          <section class="panel panel--certified" aria-labelledby="tk-supply-h" data-supply></section>
          <section class="panel" aria-labelledby="tk-chart-h" data-chart></section>
          <section class="panel" aria-labelledby="tk-feed-h" data-feed></section>
        </div>
        <div class="tk-col">
          <section class="panel tk-holders" aria-labelledby="tk-holders-h" data-holders></section>
          <section class="panel tk-kit" id="kit" aria-labelledby="tk-kit-h" data-kit></section>
          <div class="tk-stats" data-stats></div>
        </div>
      </div>
    </div>`;
    repaint();
    paintKit();
  }

  function repaint() {
    if (!a) return;
    paintHero();
    paintTerms();
    paintSupply();
    paintChart();
    paintHolders();
    paintStats();
    paintFeed();
  }

  function paintHero() {
    const el = $("[data-hero]");
    if (!el) return;
    const walletReady = getWalletStatus().state === "unlocked";
    const cta =
      a.status === "live"
        ? button({ label: mintLabel(a), href: `/app/mint?t=${encodeURIComponent(a.ticker)}`, kind: walletReady ? "btc" : "neutral", size: "lg", icon: "mint" })
        : button({
            label: a.status === "upcoming" ? "Mint opens soon" : "Minting is closed",
            kind: "neutral",
            size: "lg",
            disabled: true,
            reason: a.status === "upcoming" ? `Opens at ${heightText(a.startHeight)}.` : a.status === "sold-out" ? "Every mint under the cap is taken." : "The mint window has closed.",
          });
    el.innerHTML = html`
      <div class="tk-id">
        ${sigil(a.id, { size: 96, label: `${a.ticker} sigil` })}
        <div class="tk-id-text">
          <h1 class="ticker ticker--page">${a.ticker}</h1>
          <div class="cluster">${pillFor(a, height)}<span class="tk-id-meta">Launched ${heightText(a.deployHeight)} · id ${a.id}</span></div>
        </div>
      </div>
      ${progress({ value: a.minted, max: a.mintCap, soldOut: a.status === "sold-out", size: 8 })}
      <p class="tk-sched">${scheduleText(a, height)} ${prov("IDX")}</p>
      <dl class="tk-quick">
        <div><dt>Price ${prov(chipState)}</dt><dd class="t-btc">${priceText(a)}</dd></div>
        <div><dt>Per mint ${prov(chipState)}</dt><dd>${units(a.mintAmount, a.divisibility)}</dd></div>
        <div><dt>Last 144 blocks ${prov("IDX")}</dt><dd>${a.mints144 != null ? plural(a.mints144, "mint") : DASH}</dd></div>
      </dl>
      <div class="tk-cta">${cta}${button({ label: "Copy link", kind: "secondary", size: "lg", icon: "link", cls: "tk-copy", attrs: { "data-copy": url(), "aria-label": "Copy link to this launch page" } })}</div>
      <p class="caption t-3">A mint is a public purchase: the token, the amount and the paying Bitcoin address are visible. Privacy starts with your first private send.</p>`;
  }

  /* ---------- terms on Bitcoin ---------- */

  // A mismatch shows the bytes decoded from Bitcoin, so those values carry BTC at once; a match
  // renders IDX first and crossfades to BTC (runCheck), the product's key micro-interaction.
  const termChip = () => prov(check?.state === "diff" ? "BTC" : chipState);

  function paintTerms() {
    const el = $("[data-terms]");
    if (!el) return;
    // After a check, the terms shown are the ones decoded from Bitcoin, even when they differ.
    const fromChain = check?.state === "ok" || check?.state === "diff";
    const src = fromChain ? check.result.env : a;
    const until = blocksUntilOpen(a, height);
    const left = blocksLeft(a, height);
    const start = !Number(src.startHeight)
      ? "From the launch block"
      : html`<span class="mono">${heightText(src.startHeight)}</span>${a.status === "upcoming" && until !== null ? html`<span class="caption t-3"> · opens in ${plural(until, "block")}, ${eta(until)}</span>` : ""}`;
    const end = !Number(src.endHeight)
      ? "No end block"
      : html`<span class="mono">${heightText(src.endHeight)}</span>${a.status === "live" && left !== null ? html`<span class="caption t-3"> · ${plural(left, "block")} left, ${eta(left)}</span>` : ""}`;
    const treasury = check?.address ?? a.treasuryAddress ?? null;
    const row = (label, value) => [html`${label}`, html`${value} ${termChip()}`];
    const seal =
      check?.state === "ok"
        ? { state: "verified", deploy: true, height: check.result.status?.height ?? a.deployHeight, confirmations: check.result.status?.confirmations ?? null, vsize: check.result.sizes?.vsize ?? null }
        : check?.state === "diff"
          ? { state: "mismatch" }
          : { state: "accepted", deploy: true, height: a.deployHeight };
    const status =
      check?.state === "running"
        ? html`<p class="caption t-3 tk-line"><span class="spinner spinner--12"></span><span>Fetching the DEPLOY transaction from mempool.space and checking it…</span></p>`
        : check?.state === "error"
          ? html`<p class="caption t-warn">${icon("warn", { size: 14 })} Couldn't check the terms against Bitcoin: ${check.message} ${button({ label: "Try again", kind: "ghost", size: "xs", action: "tk-check" })}</p>`
          : check?.state === "diff"
            ? html`<div class="tk-diff">${icon("warn", { size: 16 })}<div><b>The indexer's terms differ from the bytes on Bitcoin</b> (${check.diff.join(", ")}). The values below are decoded from the DEPLOY transaction. Do not trust this indexer: <a href="${INDEXER_HREF}" data-link>switch to your own</a>.</div></div>`
            : check?.state === "ok"
              ? html`<p class="caption t-proof tk-line">${icon("check", { size: 14 })}<span>Every term below was decoded from the DEPLOY bytes in this browser and matches the indexer.${check.idOk ? " The token id matches the deploy's block and position." : ""}</span></p>`
              : "";
    el.innerHTML = html`
      <header class="panel-head"><div class="panel-titles"><div class="eyebrow">TERMS ON BITCOIN</div><h2 class="h3" id="tk-terms-h">Written once. Immutable.</h2></div></header>
      ${sealBlock(seal)}
      ${status}
      ${kv([
        row("Per mint", html`<span class="mono">${units(src.mintAmount, src.divisibility)} ${a.ticker}</span>`),
        row("Mint cap", html`<span class="mono">${int(src.mintCap)} mints</span>`),
        row("Total supply", html`<span class="mono">${units(big(src.mintAmount) * big(src.mintCap), src.divisibility)}</span>`),
        row("Price", html`<span class="mono t-btc">${big(src.priceSats) === 0n ? "Free mint" : sats(src.priceSats)}</span>`),
        row("Treasury", treasury ? chunks(treasury) : DASH),
        row("Start", start),
        row("End", end),
        row("Decimals", html`<span class="mono">${int(src.divisibility)}</span>`),
      ])}
      <div class="tk-terms-foot">
        <span>Written in block ${heightHTML(a.deployHeight)}. Terms can't change after this transaction.</span>
        <a href="/tx/${a.deployTxid}" data-link>Decoded from DEPLOY tx ${hash(a.deployTxid, { copy: false, head: 6, tail: 6 })} →</a>
      </div>
      <div class="tk-check" data-check-detail>${checkDetails()}</div>`;
    // A repaint (new block) must not lose the finished transcript inside the details.
    const box = el.querySelector("[data-tr]");
    if (box && check?.state !== "running" && check?.result?.steps?.length) {
      box.innerHTML = transcript(check.result.steps.map((s) => ({ id: s.id, label: s.label, prov: s.source, status: s.status, detail: s.detail ?? "", ms: s.ms })), { actions: false });
    }
  }

  function checkDetails() {
    if (!check?.result?.steps?.length && check?.state !== "running") return "";
    return html`<details${check?.state === "diff" || check?.state === "error" ? html` open` : ""}><summary>${icon("chevron", { size: 14 })}<span>${check?.state === "running" ? "Checks running…" : `Show the checks · ${summary((check.result.steps ?? []).map((s) => ({ prov: s.source })))}`}</span></summary><div data-tr></div></details>`;
  }

  let tv = null;
  async function runCheck() {
    if (!a?.deployTxid) return;
    const my = ++checkSeq;
    check = { state: "running", result: { steps: [] } };
    paintTerms();
    const mod = await live().catch((e) => ({ error: e }));
    if (!alive || my !== checkSeq) return;
    if (mod.error) {
      check = { state: "error", message: mod.error.message, result: { steps: [] } };
      return paintTerms();
    }
    const box = root.querySelector("[data-tr]");
    const rows = mod.planSteps("DEPLOY").map((s) => ({ id: s.id, label: s.label, prov: s.source, status: "pending", detail: "", ms: null }));
    if (box) {
      box.innerHTML = transcript(rows, { actions: false });
      tv = new TranscriptView(box.querySelector(".transcript"));
    }
    const res = await mod.checkTx(a.deployTxid, {
      onStep: (s) => {
        if (my !== checkSeq || !tv) return;
        const patch = { status: s.status, prov: s.source, label: s.label, detail: s.detail ?? "", ms: s.ms };
        if (tv.rows.some((r) => r.id === s.id)) tv.update(s.id, patch);
      },
    });
    if (!alive || my !== checkSeq) return;
    const failed = (res.steps ?? []).find((s) => s.status === "fail");
    if (res.error || !res.env || res.env.op !== 2 || failed) {
      check = { state: "error", message: res.error?.message ?? (failed ? `${failed.label}: ${failed.detail}` : "the transaction carries no DEPLOY envelope"), result: res };
      return paintAll();
    }
    const diff = termsDiff(res.env, a);
    // The token id is (deploy height << 32) | position in block; the merkle proof fixes both.
    const idOk = res.status?.confirmed && Number.isInteger(res.position) ? ((BigInt(res.status.height) << 32n) | BigInt(res.position)) === big(a.id) : false;
    if (!idOk && res.status?.confirmed && Number.isInteger(res.position)) diff.push("token id");
    let address = null;
    try {
      address = res.env.treasury?.length ? (await funding()).addressOf(res.env.treasury) : null;
    } catch {
      address = null;
    }
    check = { state: diff.length ? "diff" : "ok", result: res, diff, idOk, address };
    paintAll();
    if (check.state !== "ok") return;
    // The hero's price and per-mint figures are the same terms: they upgrade with the panel.
    chipState = "BTC";
    for (const chip of root.querySelectorAll("[data-terms] .kv .prov, [data-hero] .tk-quick > div:nth-child(-n + 2) .prov")) upgrade(chip, "BTC");
  }

  function paintAll() {
    if (alive) paintTerms();
  }

  /* ---------- supply proof ---------- */

  function paintSupply() {
    const el = $("[data-supply]");
    if (!el || !a) return;
    const s = supplyCheck(a);
    const r = feed ? recountMints(feed, a.id) : null;
    const recountOk = r ? r.accepted === Number(a.minted) && r.units === s.supply : null;
    el.innerHTML = html`
      <header class="panel-head"><div class="panel-titles"><div class="eyebrow">SUPPLY PROOF</div><h2 class="h3" id="tk-supply-h">Supply follows from the rules, not from a promise</h2></div></header>
      <div class="tk-eq${s.equal ? "" : " tk-eq--bad"}">
        <span>${int(a.minted)}</span><span class="op">×</span><span>${units(a.mintAmount, a.divisibility)}</span><span class="op">=</span><span>${units(s.expected, a.divisibility)}</span><span class="op">${s.equal ? "=" : "≠"}</span><span>${units(s.supply, a.divisibility)}</span><span class="t-3" style="font-size:.6em">${a.ticker}</span>
      </div>
      <p class="tk-eq-ok">${s.equal ? icon("check", { size: 14 }) : icon("cross", { size: 14 })}<span>mints × per mint ${s.equal ? "equals" : "does not equal"} the pool balance of ${a.ticker}. Computed in your browser from our indexer's numbers.</span>${prov("IDX")}</p>
      <p class="tk-eq-ok">${r === null ? html`<span class="spinner spinner--12"></span><span>Recounting from the public log…</span>` : recountOk ? html`${icon("check", { size: 14 })}<span>Recounted here from the bulk public log: ${plural(r.accepted, "accepted mint record")}${r.rejected ? `, ${plural(r.rejected, "rejected")}` : ""}.</span>${prov("IDX")}` : html`${icon("warn", { size: 14 })}<span>The public log lists ${plural(r.accepted, "accepted mint")}, the asset table ${plural(a.minted, "mint")}. The indexer may be mid-sync; reload in a minute.</span>${prov("IDX")}`}</p>
      <ul class="tk-why">
        <li>${icon("block", { size: 14 })}<span>Every mint is a public Bitcoin transaction that pays the treasury, checked against the deploy terms by every replayer.</span></li>
        <li>${icon("proof", { size: 14 })}<span>Private transfers must have publicAmount = 0, and the circuit's balance constraint Σin = Σout keeps the supply unchanged.</span></li>
        <li>${icon("launch", { size: 14 })}<span>No premine path: a launch creates no notes. A mint over the cap is rejected and its payment counts as burned, as with Runes.</span></li>
      </ul>
      <div class="tk-caveat">${icon("warn", { size: 16 })}<span>Counterfeiting inside the pool would need a broken circuit or a forged proof from the development trusted setup (single-party phase 2, A-8). Supply numbers can't detect that today; a public setup ceremony before mainnet removes it.</span></div>
      <p class="small"><a href="/verify#pool" data-link>Replay the whole pool in your browser →</a> <span class="t-3">Turns every number on this page into your own result.</span></p>`;
  }

  /* ---------- chart, stats, feed ---------- */

  function paintChart() {
    const el = $("[data-chart]");
    if (!el) return;
    el.innerHTML = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">MINTS PER BLOCK ${prov("IDX")}</div><h2 class="h3" id="tk-chart-h">Last 144 blocks</h2></div></header>
      ${height != null ? mintsChart(a.mintsByHeight ?? [], height, { blocks: 144 }) : html`<span class="skel" style="width:100%;height:56px"></span>`}`;
  }

  // treasurySats is the gross sum paid to the treasury script by accepted mints (SPEC §11): it
  // includes overpayment and the payer's change when the payer's own address is the treasury.
  // price × mints is the nominal mint revenue.
  function treasuryFoot(a) {
    const price = big(a.priceSats);
    if (price === 0n) return "Gross, change included";
    return `Gross, change included · price × mints: ${sats(price * big(a.minted ?? 0))}`;
  }

  function paintStats() {
    const el = $("[data-stats]");
    if (!el) return;
    el.innerHTML = html`
      ${statTile({ eyebrow: "Sent to treasury address", value: units(a.treasurySats, 0), unit: "sats", prov: "IDX", foot: treasuryFoot(a) })}
      ${statTile({ eyebrow: "Rejected mints", value: int(a.rejectedMints ?? 0), prov: "IDX", foot: big(a.burnedSats) > 0n ? `${sats(a.burnedSats)} burned` : "Nothing burned" })}
      ${statTile({ eyebrow: "First mint", value: a.firstMintHeight != null ? heightText(a.firstMintHeight) : DASH, prov: "IDX" })}
      ${statTile({ eyebrow: "Minted out", value: a.soldOutHeight != null ? heightText(a.soldOutHeight) : DASH, prov: "IDX", foot: a.soldOutHeight != null && a.firstMintHeight != null ? `${plural(a.soldOutHeight - a.firstMintHeight, "block")} after the first mint` : null })}`;
  }

  function paintFeed() {
    const el = $("[data-feed]");
    if (!el) return;
    const head = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">LIVE MINTS ${prov("IDX")}</div><h2 class="h3" id="tk-feed-h">Every mint is public. Every recipient is not.</h2></div></header>`;
    if (!feed) {
      el.innerHTML = html`${head}<span class="skel-group"><span class="skel" style="width:100%;height:20px"></span><span class="skel" style="width:100%;height:20px"></span></span>`;
      return;
    }
    if (!feed.length) {
      el.innerHTML = html`${head}${empty({ text: a.status === "live" ? `No mints yet. Be the first to mint ${a.ticker}.` : "No mints yet." , action: a.status === "live" ? { label: mintLabel(a), href: `/app/mint?t=${encodeURIComponent(a.ticker)}` } : null })}`;
      return;
    }
    const rows = feed.slice(0, feedShown);
    el.innerHTML = html`${head}
      <div class="tk-feed">${rows.map(
        (e) => html`<div class="tk-feed-row">
          <span class="height">${heightText(e.height)}</span>
          <span class="tk-feed-main"><span class="mono">+${e.amount != null ? units(e.amount, a.divisibility) : DASH} ${a.ticker}</span><span class="t-3" aria-hidden="true">→</span>${redact("recipient")}${hash(e.txid, { head: 6, tail: 4, href: `/tx/${e.txid}`, label: "Copy txid" })}</span>
          ${sealPill(entrySeal(e))}
          ${e.ok ? "" : html`<span class="tk-feed-rej">${e.reason ?? "rejected"}</span>`}
        </div>`,
      )}</div>
      ${feed.length > feedShown ? html`<div class="ex-more">${button({ label: `Load older · ${int(feed.length - feedShown)} more`, kind: "ghost", size: "sm", action: "tk-more" })}</div>` : ""}
      <p class="caption t-3" style="margin-top:10px">The recipient of a mint is a shielded note: nobody can see who received it. The paying Bitcoin address is public on each receipt.</p>`;
  }

  function paintHolders() {
    const el = $("[data-holders]");
    if (!el) return;
    const s = supplyCheck(a);
    el.innerHTML = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">HOLDERS</div><h2 class="h3" id="tk-holders-h">There is no holder list</h2></div></header>
      <div class="tk-holders-art" aria-hidden="true">${[0, 1, 2, 3].map(() => html`<span>${redact("address")}${redact("amount")}</span>`)}</div>
      <p class="tk-holders-line">No holder list. No whale alerts. That's the feature.</p>
      <p class="caption t-2" style="margin-top:10px">Supply minted: <span class="mono">${int(a.minted)} × ${units(a.mintAmount, a.divisibility)} = ${units(s.expected, a.divisibility)}</span> · publicly checkable ${prov("IDX")}</p>`;
  }

  /* ---------- launch kit ---------- */

  function paintKit() {
    const el = $("[data-kit]");
    if (!el) return;
    const text = shareText(a, url());
    el.innerHTML = html`<header class="panel-head"><div class="panel-titles"><div class="eyebrow">LAUNCH KIT</div><h2 class="h3" id="tk-kit-h">Share ${a.ticker}</h2></div></header>
      <div class="linkbox">${url()}</div>
      <div class="cluster">
        ${button({ label: "Copy link", kind: "secondary", size: "sm", icon: "link", attrs: { "data-copy": url() } })}
        ${button({ label: "Copy announcement", kind: "ghost", size: "sm", icon: "copy", attrs: { "data-copy": text } })}
        ${button({ label: "Share on X", href: xIntentUrl(text), kind: "ghost", size: "sm", iconRight: "external" })}
      </div>
      <div class="tk-kit-prev" data-preview><span class="skel"></span></div>
      <label class="tk-kit-opt"><input type="checkbox" data-txid-opt${withTxid ? html` checked` : ""}><span>Put the deploy txid on the card. Off by default: a txid ties the card to the Bitcoin address that paid the launch.</span></label>
      <div class="cluster">${button({ label: "Download PNG", kind: "neutral", size: "sm", icon: "download", action: "tk-png" })}<span class="caption t-3">1200 × 675, drawn in your browser. Observer data only.</span></div>`;
    drawPreview();
  }

  let lastCanvas = null;
  async function drawPreview() {
    const box = $("[data-preview]");
    if (!box) return;
    try {
      const mod = await card();
      const c = await mod.drawLaunchCard(launchCardModel(a, { height, url: url(), includeTxid: withTxid, brand: BRAND }));
      if (!alive) return;
      lastCanvas = c;
      const blob = await mod.toBlob(c);
      if (cardUrl) URL.revokeObjectURL(cardUrl);
      cardUrl = URL.createObjectURL(blob);
      const img = toNode(html`<img alt="Announcement card for ${a.ticker}" width="1200" height="675">`);
      img.src = cardUrl;
      box.replaceChildren(img);
    } catch {
      box.replaceChildren(toNode(html`<p class="caption t-3" style="padding:12px">The card couldn't be drawn in this browser.</p>`));
    }
  }

  /* ---------- events ---------- */

  let lastHeight = null;
  const offs = [
    api.watchState((s) => {
      if (!alive || !s) return;
      if (lastHeight !== null && s.height !== lastHeight && (a || mined)) load({ fresh: true });
      lastHeight = s.height;
    }),
    onWalletStatus(() => alive && (mined ? paintMined() : a && paintHero())),
    on(root, "click", "[data-action]", async (e, el) => {
      switch (el.dataset.action) {
        case "tk-retry":
          return load({ fresh: true });
        case "tk-check":
        case "verify":
          return runCheck();
        case "tk-more":
          feedShown += FEED_PAGE;
          return paintFeed();
        case "tk-png": {
          if (!lastCanvas) return toast({ kind: "info", title: "The card isn't ready yet.", body: "Wait a moment, then try again." });
          const mod = await card();
          await mod.download(lastCanvas, `${BRAND.toLowerCase()}-${a.ticker.toLowerCase()}-launch.png`);
          return;
        }
        case "transcript":
          root.querySelector("[data-check-detail] details")?.setAttribute("open", "");
          return;
      }
    }),
    on(root, "change", "[data-txid-opt]", (e, el) => {
      withTxid = el.checked;
      drawPreview();
    }),
  ];

  load();
  return () => {
    alive = false;
    checkSeq++;
    if (cardUrl) URL.revokeObjectURL(cardUrl);
    offs.forEach((off) => off());
  };
}

/* ---------- mined tokens (kind "pow") ---------- */

const MINED_STATUS = {
  "mining-soon": ["Mining soon", "neutral"],
  mining: ["Mining", "btc"],
  "mined-out": ["Mined out", "neutral"],
  "mining-ended": ["Mining ended", "neutral"],
};
const bigOr = (v, d = 0n) => {
  try {
    return v == null ? d : BigInt(v);
  } catch {
    return d;
  }
};
/** "1,234 H/s", "12.3 kH/s". */
const rateText = (hs) => {
  const v = Number(hs);
  if (!Number.isFinite(v) || v <= 0) return "0 H/s";
  return v < 10_000 ? `${int(Math.round(v))} H/s` : v < 1e7 ? `${(v / 1000).toFixed(1)} kH/s` : `${(v / 1e6).toFixed(1)} MH/s`;
};

/** Difficulty per block over the last `blocks` blocks, from series [[h, "D"]] (not consensus). */
export function difficultyChart(series, tip, { blocks = 144 } = {}) {
  const pts = (series ?? []).map(([h, d]) => [Number(h), Number(d)]).filter(([h, d]) => Number.isFinite(h) && Number.isFinite(d) && h > Number(tip) - blocks && h <= Number(tip)).sort((x, y) => x[0] - y[0]);
  const W = blocks * 3;
  const H = 56;
  if (!pts.length || !Number.isFinite(Number(tip))) {
    return html`<figure class="lp-chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="No difficulty data yet"><line class="lp-axis" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/></svg><figcaption class="lp-chart-foot mono"><span>—</span><span>No difficulty data yet</span><span>—</span></figcaption></figure>`;
  }
  const max = Math.max(...pts.map(([, d]) => d));
  const min = Math.min(...pts.map(([, d]) => d));
  const y = (d) => (max === min ? H / 2 : 4 + (H - 8) * (1 - (d - min) / (max - min)));
  const x = (h) => (h - (Number(tip) - blocks + 1)) * 3 + 1;
  // A step line: D holds from one point to the next.
  let path = `M${x(pts[0][0]).toFixed(1)},${y(pts[0][1]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) path += ` H${x(pts[i][0]).toFixed(1)} V${y(pts[i][1]).toFixed(1)}`;
  path += ` H${W}`;
  const label = `Difficulty from ${int(min)} to ${int(max)} in the last ${int(blocks)} blocks`;
  return html`<figure class="lp-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}"><line class="lp-axis" x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}"/><path class="mine-line" d="${path}"/></svg>
    <figcaption class="lp-chart-foot mono"><span>${heightText(Number(tip) - blocks + 1)}</span><span>${label}</span><span>${heightText(tip)}</span></figcaption>
  </figure>`;
}

/**
 * The mined token page for a GET /api/mine/:asset view `m` (pure markup). feed: accepted and
 * rejected MINE / MINE_SCRIPT log entries of this asset, newest first, or null while loading.
 */
export function minedPageHTML(m, { height = null, feed = null, walletReady = false } = {}) {
  const tip = m.tip?.height ?? height;
  const div = m.divisibility ?? 0;
  const [statusText, statusTone] = MINED_STATUS[m.status] ?? [String(m.status ?? "unknown"), "neutral"];
  const reward = bigOr(m.reward);
  const issued = bigOr(m.issued);
  const max = bigOr(m.maxSupply);
  const feeOutputs = Array.isArray(m.feeOutputs) ? m.feeOutputs : [];
  const serviceSats = feeOutputs.reduce((s, o) => s + bigOr(o.sats), 0n);
  const platformOnly = feeOutputs.length > 0 && feeOutputs.every((o) => o.role === "platform");
  const recipient = platformOnly ? MINE_RECIPIENT : feeOutputs.map((o) => o.address ?? "the fee address").join(" and ");
  const perBlock = Number(m.targetPerSpan) / Math.max(1, Number(m.span));
  const hs = Number(m.hashrateEstimate) || 0;
  let floorRate = null;
  try {
    floorRate = floorEmission({ minDifficulty: m.minDifficulty }, hs);
  } catch {
    floorRate = null;
  }
  const flags = [
    m.flags?.lowFloor ? tag("Low floor", "warn") : "",
    m.flags?.recipientDiscount ? tag("Recipient mines cheaper", "warn") : "",
  ];
  const cta =
    m.status === "mining"
      ? button({ label: `Mine ${m.ticker}`, href: `/app/mine?t=${encodeURIComponent(m.ticker)}`, kind: walletReady ? "btc" : "neutral", size: "lg", icon: "block" })
      : button({
          label: m.status === "mining-soon" ? "Mining opens soon" : "Mining is closed",
          kind: "neutral", size: "lg", disabled: true,
          reason: m.status === "mining-soon" ? `Opens at ${heightText(m.mineStart)}.` : m.status === "mined-out" ? "Every reward under the cap is claimed." : "The reward has reached 0 or the end block has passed.",
        });
  const feedRows = feed === null
    ? html`<span class="skel-group"><span class="skel" style="width:100%;height:20px"></span><span class="skel" style="width:100%;height:20px"></span></span>`
    : !feed.length
      ? empty({ text: m.status === "mining" ? `No claims yet. Be the first to mine ${m.ticker}.` : "No claims yet." })
      : html`<div class="tk-feed">${feed.slice(0, 40).map(
          (e) => html`<div class="tk-feed-row">
            <span class="height">${heightText(e.height)}</span>
            <span class="tk-feed-main"><span class="mono">+${e.amount != null ? units(e.amount, div) : DASH} ${m.ticker}</span><span class="t-3" aria-hidden="true">→</span>${redact("recipient")}<span class="caption t-3">ref ${heightText(e.ref)}${e.difficulty != null ? ` · D ${int(e.difficulty)}` : ""}</span>${hash(e.txid, { head: 6, tail: 4, href: `/tx/${e.txid}`, label: "Copy txid" })}</span>
            ${sealPill(entrySeal(e))}
            ${e.ok ? "" : html`<span class="tk-feed-rej">${e.reason ?? "rejected"}</span>`}
          </div>`,
        )}</div>`;
  return html`<div class="container section tk mine-tk">
    <nav class="tk-crumbs" aria-label="Breadcrumb"><a href="/explorer" data-link>Explorer</a><span aria-hidden="true">/</span><span class="mono">${m.ticker}</span></nav>
    <div class="tk-hero">
      <div class="tk-main">
        <div class="tk-id">
          ${sigil(m.asset, { size: 96, label: `${m.ticker} sigil` })}
          <div class="tk-id-text">
            <h1 class="ticker ticker--page">${m.ticker}</h1>
            <div class="cluster">${tag(statusText, statusTone)}${tag("Mined", "neutral")}<span class="tk-id-meta">Launched ${heightText(m.deployHeight)} · id ${m.asset}</span></div>
          </div>
        </div>
        ${progress({ value: Number(issued), max: Number(max) || null, size: 8, label: false })}
        <p class="tk-sched">${units(issued, div)} of ${units(max, div)} ${m.ticker} issued by ${plural(m.claims ?? 0, "claim")} ${prov("IDX")}</p>
        <dl class="tk-quick">
          <div><dt>Reward now ${prov("IDX")}</dt><dd class="mono">${units(reward, div)}</dd></div>
          <div><dt>Next halving ${prov("IDX")}</dt><dd>${m.nextHalving != null ? heightText(m.nextHalving) : "none"}</dd></div>
          <div><dt>Claims ${prov("IDX")}</dt><dd>${int(m.claims ?? 0)}</dd></div>
        </dl>
        <div class="tk-cta">${cta}</div>
        <div class="cluster">${flags}</div>
        <p class="caption t-3">${MINED_PRIVACY_TEXT}</p>
      </div>
      <aside class="panel panel--certified tk-terms" aria-labelledby="tk-terms-h">
        <header class="panel-head"><div class="panel-titles"><div class="eyebrow">TERMS ON BITCOIN</div><h2 class="h3" id="tk-terms-h">Written once. Immutable.</h2></div></header>
        ${kv([
          ["Base reward", html`<span class="mono">${units(m.baseReward ?? m.reward, div)} ${m.ticker}</span> ${prov("IDX")}`],
          ["Max supply", html`<span class="mono">${units(max, div)}</span> ${prov("IDX")}`],
          ["Halving", html`${Number(m.halvingInterval) ? `every ${plural(m.halvingInterval, "block")}` : "none"} ${prov("IDX")}`],
          ["Pace", html`<span class="mono">${perBlock.toFixed(2)}</span> per block, averaged over ${plural(m.span, "block")} ${prov("IDX")}`],
          ["Initial difficulty", html`<span class="mono">${int(m.initialDifficulty)}</span> ${prov("IDX")}`],
          ["Floor", html`<span class="mono">${int(m.minDifficulty)}</span> ${prov("IDX")}`],
          ["Mining start", html`<span class="mono">${heightText(m.mineStart)}</span> <span class="caption t-3">${startLead(m)}</span>`],
          ["End", Number(m.endHeight) ? html`<span class="mono">${heightText(m.endHeight)}</span>` : "No end block"],
          ["Claim fee to the deployer", html`<span class="mono">${sats(m.claimFeeSats ?? 0)}</span>`],
          ["Service fee per claim", serviceSats > 0n ? html`<span class="mono t-btc">${sats(serviceSats)}</span> <span class="caption t-3">to ${recipient}</span>` : "none"],
          ["Decimals", html`<span class="mono">${int(div)}</span>`],
        ])}
        <div class="tk-terms-foot">
          <span>Written in block ${heightHTML(m.deployHeight)}. Terms can't change after this transaction.</span>
          ${m.deployTxid ? html`<a href="/tx/${m.deployTxid}" data-link>Check the DEPLOY_POW tx ${hash(m.deployTxid, { copy: false, head: 6, tail: 6 })} →</a>` : ""}
        </div>
      </aside>
    </div>
    <div class="tk-body">
      <div class="tk-col">
        <section class="panel" aria-labelledby="tk-mining-h">
          <header class="panel-head"><div class="panel-titles"><div class="eyebrow">MINING ${prov("IDX")}</div><h2 class="h3" id="tk-mining-h">Difficulty and hashrate</h2></div></header>
          ${kv([
            ["Difficulty now", html`<span class="mono">${int(m.difficulty)}</span>`],
            ["Stale floor", html`<span class="mono">${int(m.staleFloor)}</span> <span class="caption t-3">difficulty now / ${m.staleFactor ?? 4}: older work must meet at least this</span>`],
            ["Target per block", html`<span class="mono">${perBlock.toFixed(2)}</span>`],
            ["Network hashrate", html`<span class="mono">${rateText(hs)}</span> <span class="caption t-3">an estimate from the work counted in the last 144 blocks</span>`],
            ["Claims in flight", m.pendingClaims != null ? int(m.pendingClaims) : DASH],
            ["Claims, last 144 blocks", int(m.claims144 ?? 0)],
          ])}
          <h3 class="eyebrow" style="margin-top:16px">DIFFICULTY PER BLOCK</h3>
          ${tip != null ? difficultyChart(m.series?.difficulty ?? [], tip) : ""}
          <h3 class="eyebrow" style="margin-top:12px">CLAIMS PER BLOCK</h3>
          ${tip != null ? mintsChart(m.series?.claims ?? [], tip, { blocks: 144, unit: "claim" }) : ""}
          <p class="caption t-3">Charts are rebuilt from the public log. They are not consensus data.</p>
        </section>
        <section class="panel" aria-labelledby="tk-claims-h">
          <header class="panel-head"><div class="panel-titles"><div class="eyebrow">LIVE CLAIMS ${prov("IDX")}</div><h2 class="h3" id="tk-claims-h">Every claim is public. Every recipient is not.</h2></div></header>
          ${feedRows}
        </section>
      </div>
      <div class="tk-col">
        <section class="panel" aria-labelledby="tk-fair-h">
          <header class="panel-head"><div class="panel-titles"><div class="eyebrow">FAIRNESS</div><h2 class="h3" id="tk-fair-h">What shapes who mines</h2></div></header>
          <ul class="mine-copy">
            <li>No premine by consensus: only claims issue ${m.ticker}. ${startFairness(m)}</li>
            ${serviceSats > 0n ? html`<li>${MINE_TEXT.fee({ sats: serviceSats, recipient })}</li>` : ""}
            <li>${MINE_TEXT.gpu}</li>
            <li>At the floor and today's estimated hashrate, up to ${floorRate !== null ? int(Math.round(floorRate)) : DASH} claims could land per block after a quiet period. ${MINE_TEXT.burst}</li>
            ${m.flags?.lowFloor ? html`<li><b>Low floor:</b> the floor or the initial difficulty is far below what an honest browser launch would set.</li>` : ""}
            <li>${MINE_TEXT.censor}</li>
            ${IS_SIGNET ? html`<li>${MINE_TEXT.signet}</li>` : ""}
          </ul>
        </section>
        <div class="tk-stats">
          ${statTile({ eyebrow: "Rejected claims", value: int(m.rejectedClaims ?? 0), prov: "IDX", foot: bigOr(m.burnedFeeSats) > 0n ? `${sats(m.burnedFeeSats)} of service fees in rejected claims` : "No fees in rejected claims" })}
          ${statTile({ eyebrow: "Service fees paid", value: units(m.feeSats ?? 0, 0), unit: "sats", prov: "IDX", foot: "Gross sats to the fee address in accepted claims, change included" })}
          ${statTile({ eyebrow: "First claim", value: m.firstClaimHeight != null ? heightText(m.firstClaimHeight) : DASH, prov: "IDX" })}
        </div>
      </div>
    </div>
  </div>`;
}

async function missing(root, ticker, err) {
  setTitle("Token not found");
  const bad = !TICKER.test(ticker);
  root.innerHTML = html`<div class="container section"><section class="panel panel--certified placeholder tk-missing">
    <div class="eyebrow">${bad ? "NOT A TICKER" : "NO SUCH TOKEN"}</div>
    <h1 class="h1-app">${bad ? "That isn't a ticker." : `No token ${ticker} on this pool.`}</h1>
    <p>${bad ? "A ticker is 1 to 16 characters, A to Z and 0 to 9." : "Tickers are first come, first served: the first valid launch of a ticker claims it. This one hasn't been launched here yet."}</p>
    <div data-suggest></div>
    <div class="cluster">${button({ label: "Browse mints", href: "/mints?f=all", kind: "secondary" })}${bad ? "" : button({ label: `Launch ${ticker}`, href: "/app/launch", kind: "ghost", icon: "launch" })}</div>
    ${err && err.status !== 404 && err.status !== 400 ? html`<p class="caption t-3">${err.message}</p>` : ""}
  </section></div>`;
  if (bad) return;
  try {
    const list = await api.assets();
    const near = suggestTickers(ticker.slice(0, 2), list, 5).filter((x) => x.ticker !== ticker);
    const box = root.querySelector("[data-suggest]");
    if (box && near.length) box.innerHTML = html`<p class="small t-2">Similar tickers: ${near.map((x, i) => html`${i ? ", " : ""}<a href="/t/${encodeURIComponent(x.ticker)}" data-link class="ticker">${x.ticker}</a>`)}</p>`;
  } catch {
    // Suggestions are optional.
  }
}

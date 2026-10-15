/**
 * /mine: the public page for mining tokens by proof of work in the browser. It reads the mined
 * tokens from GET /api/mine (no wallet, no session bundle): the featured token as a big card with
 * live numbers, the other mined tokens, how it works in four steps, what one claim costs and an
 * honest note on speed. "Start mining" goes to the wallet's Mine page with the ticker preselected
 * (/app/mine?t=MURK); a visitor without a wallet meets the wallet gate there and returns to it.
 */
import "../share/public.css";
import * as api from "../api.js";
import { html, on } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { prov } from "../ui/prov.js";
import { sats, heightText, DASH } from "../ui/format.js";
import { button, empty, kv, progress } from "../ui/components.js";
import { sigil } from "../ui/sigil.js";
import { getWalletStatus, onWalletStatus } from "../ui/status.js";
import { setTitle } from "../router.js";
import {
  CLAIM_VSIZE, claimsText, closedReason, difficultyText, featuredMined, feeEstimate, fetchMined, isOpen, issuedShareText, mineHref, minedCard, minedPill,
  miningOn, publicFeeRate, rankMined, rewardText, serviceSats, speedNote, supplyText, wholeTokens,
} from "../share/mined.js";

/** The four steps (icon, title, text). */
export const HOW_STEPS = [
  ["wallet", "Open a wallet", "Create one or restore one. No sign-up, no email: the keys are made in this browser and stay on this device."],
  ["receive", "Fund the mining address", "Send a few thousand sats to your wallet's mining address. It pays the Bitcoin fee of each claim."],
  ["pick", "Press Mine and leave the tab open", "Your browser searches for proof-of-work solutions. Keep the tab open while it runs."],
  ["proof", "Each solution is a claim", "A claim is a Bitcoin transaction you pay. The token's reward lands in your wallet as a private note."],
];

/** The featured token as a large card. `a` null: the empty state. */
export function featuredCard(a, { walletReady = false } = {}) {
  if (!a) return "";
  const t = encodeURIComponent(a.ticker);
  const open = isOpen(a);
  return html`<section class="panel panel--certified mi-card" aria-labelledby="mi-card-h" data-featured data-ticker="${a.ticker}">
    <div class="mi-card-top">
      ${sigil(a.asset, { size: 56 })}
      <div class="mi-card-id">
        <div class="eyebrow">MINED TOKEN ${prov("IDX")}</div>
        <h2 class="ticker ticker--page" id="mi-card-h"><a href="/t/${t}" data-link>${a.ticker}</a></h2>
      </div>
      ${minedPill(a)}
    </div>
    <div class="mi-claims">
      <span class="mi-claims-v mono" data-claims>${claimsText(a)}</span>
      <span class="mi-claims-l">claims mined</span>
    </div>
    ${progress({ value: wholeTokens(a.issued, a.divisibility), max: wholeTokens(a.maxSupply, a.divisibility) || null, unit: a.ticker, size: 8, label: false })}
    <p class="mi-supply mono" data-supply>${supplyText(a)} issued · ${issuedShareText(a)}</p>
    <dl class="mi-quick">
      <div><dt>Reward per claim</dt><dd class="mono">${rewardText(a)}</dd></div>
      <div><dt>Difficulty</dt><dd class="mono">${difficultyText(a)}</dd></div>
      <div><dt>Status</dt><dd>${open ? "Mining now" : a.status === "mining-soon" ? "Opens soon" : "Closed"}</dd></div>
      <div><dt>Deployed at block</dt><dd class="mono">${heightText(a.deployHeight)}</dd></div>
    </dl>
    <div class="mi-cta">
      ${open
        ? button({ label: "Start mining", href: mineHref(a.ticker), kind: walletReady ? "btc" : "neutral", size: "lg", icon: "pick" })
        : button({ label: a.status === "mining-soon" ? "Mining opens soon" : "Mining is closed", kind: "neutral", size: "lg", disabled: true, reason: closedReason(a) })}
      ${button({ label: `About ${a.ticker}`, href: `/t/${t}`, kind: "secondary", size: "lg" })}
    </div>
  </section>`;
}

/** What one claim costs: the Bitcoin network fee for about 680 vB at a rate, plus the platform's service fee. */
export function costPanel({ rate = null, service = serviceSats() } = {}) {
  const est = feeEstimate({ rate, service });
  return html`<section class="panel mi-panel" aria-labelledby="mi-cost-h">
    <header class="panel-head"><div class="panel-titles"><div class="eyebrow">COST OF ONE CLAIM</div><h2 class="h3" id="mi-cost-h">What one claim costs</h2></div></header>
    ${kv([
      ["Bitcoin network fee", est ? html`<span class="mono t-btc">~${sats(est.networkSats)}</span> <span class="caption t-3">about 680 vB at ${est.rate} sat/vB ${prov("BTC")}</span>` : html`<span class="t-3">about 680 vB at the current fee rate (not loaded yet)</span>`],
      ["Service fee to the platform", html`<span class="mono t-btc">${sats(service)}</span>`],
      ["Total", est ? html`<span class="mono t-btc">~${sats(est.totalSats)}</span>` : DASH],
    ])}
    <p class="caption t-3">Paid from your wallet's mining address; a relay balance has its own quote in the wallet. The Bitcoin fee follows the fee rate of the day.</p>
  </section>`;
}

/** The honest speed note, for the featured token (or the generic sentence without one). */
export function speedPanel(a) {
  return html`<section class="panel mi-panel" aria-labelledby="mi-speed-h">
    <header class="panel-head"><div class="panel-titles"><div class="eyebrow">HOW FAST</div><h2 class="h3" id="mi-speed-h">Your browser is one miner among many</h2></div></header>
    <p class="small" data-speed>${speedNote(a)}</p>
  </section>`;
}

export function render(root) {
  setTitle("Mine");
  let list = null;
  let failed = null;
  let rate = null;
  let alive = true;
  let paintKey = null;

  root.innerHTML = html`<div class="mi">
    <section class="mi-hero container" aria-labelledby="mi-h1">
      <div class="eyebrow">MINING</div>
      <h1 class="display mi-h1" id="mi-h1">Mine tokens <em>in your browser.</em></h1>
      <p class="lead">No special hardware and no sign-up. Your browser searches for proof-of-work solutions, and each solution claims a token reward that lands in your wallet as a private note.</p>
      <div class="ld-ctas" data-hero-cta>${button({ label: "Start mining", href: "/app/mine", kind: "neutral", size: "lg", icon: "pick" })}${button({ label: "How it works", href: "#how", kind: "secondary", size: "lg" })}</div>
    </section>
    <section class="container mi-sec" aria-label="Featured mined token" data-featured-slot>
      <div class="panel mi-card"><span class="skel" style="width:40%;height:28px"></span><span class="skel" style="width:60%;height:48px"></span><span class="skel" style="width:100%;height:8px"></span><span class="skel" style="width:100%;height:64px"></span></div>
    </section>
    <section class="container mi-sec" aria-labelledby="mi-others-h" data-others hidden>
      <div class="ld-sec-head"><div class="eyebrow">MORE TOKENS</div><h2 class="h2-landing" id="mi-others-h">Other mined tokens</h2></div>
      <div class="lp-grid" data-others-grid></div>
    </section>
    <section class="ld-sec" id="how" aria-labelledby="mi-how-h">
      <div class="container">
        <div class="ld-sec-head"><div class="eyebrow">HOW IT WORKS</div><h2 class="h2-landing" id="mi-how-h">Four steps, <em>no sign-up.</em></h2></div>
        <ol class="ld-steps">${HOW_STEPS.map(([ic, title, text], i) => html`<li class="ld-step"><span class="ld-step-n">${String(i + 1).padStart(2, "0")}</span><h3>${icon(ic, { size: 18 })}${title}</h3><p>${text}</p></li>`)}</ol>
      </div>
    </section>
    <section class="container mi-sec mi-two">
      <div data-cost>${costPanel({ rate })}</div>
      <div data-speed-slot>${speedPanel(null)}</div>
    </section>
  </div>`;

  const $ = (s) => root.querySelector(s);

  function paint() {
    const walletReady = getWalletStatus().state === "unlocked";
    const slot = $("[data-featured-slot]");
    const ranked = rankMined(list ?? []);
    // Rebuild only when something shown changed, so a block that brings no news keeps keyboard focus where it is.
    const key = JSON.stringify([failed?.message ?? null, list === null, ranked, walletReady]);
    if (key === paintKey) return;
    paintKey = key;
    const featured = featuredMined(ranked);
    if (failed && !list) {
      slot.innerHTML = html`<div class="panel">${empty({ text: `The mining list didn't load: ${failed.message}`, action: { label: "Try again", action: "mi-retry" } })}</div>`;
    } else if (list === null) {
      return;
    } else if (!miningOn()) {
      slot.innerHTML = html`<div class="panel">${empty({ text: "Mining is not configured on this network yet. Nothing here mines or pays." })}</div>`;
    } else if (featured) {
      slot.innerHTML = featuredCard(featured, { walletReady });
    } else {
      slot.innerHTML = html`<div class="panel">${empty({ text: "No token is being mined on this network right now. Launch one, or check back soon.", action: { label: "Launch a mined token", href: "/app/launch?kind=pow" } })}</div>`;
    }
    const hero = $("[data-hero-cta]");
    hero.firstElementChild?.setAttribute?.("href", featured && isOpen(featured) ? mineHref(featured.ticker) : "/app/mine");
    const others = ranked.filter((a) => a !== featured);
    $("[data-others]").hidden = !others.length;
    $("[data-others-grid]").innerHTML = html`${others.map((a) => minedCard(a, { walletReady }))}`;
    $("[data-speed-slot]").innerHTML = speedPanel(featured);
  }

  async function load(fresh = false) {
    try {
      list = await fetchMined({ fresh });
      failed = null;
    } catch (e) {
      if (!alive) return;
      failed = e;
    }
    if (!alive) return;
    paint();
  }

  publicFeeRate()
    .then((r) => {
      rate = r;
      if (alive) $("[data-cost]").innerHTML = costPanel({ rate });
    })
    .catch(() => {});

  let lastHeight = null;
  const offs = [
    api.watchState((s) => {
      if (!alive || !s) return;
      if (lastHeight !== null && s.height !== lastHeight) load(true);
      lastHeight = s.height;
    }),
    onWalletStatus(() => alive && list && paint()),
    on(root, "click", "[data-action=mi-retry]", () => load(true)),
  ];

  load();
  return () => {
    alive = false;
    offs.forEach((off) => off());
  };
}

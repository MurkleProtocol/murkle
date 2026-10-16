/**
 * /mine: the public page for mining tokens by proof of work in the browser. It reads the mined
 * tokens from GET /api/mine (no wallet, no session bundle): the featured token as a big card with
 * live numbers, the other mined tokens, how it works in four steps, what one claim costs and an
 * honest note on speed. "Start mining" goes to the wallet's Mine page with the ticker preselected
 * (/app/mine?t=MURK); a visitor without a wallet meets the wallet gate there and returns to it. "Mine on a GPU"
 * (below the panels) explains the command-line miner for NVIDIA cards, with copyable commands for this network.
 */
import "../share/public.css";
import * as api from "../api.js";
import { html, on } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { prov } from "../ui/prov.js";
import { sats, int, heightText, DASH } from "../ui/format.js";
import { button, empty, kv, progress } from "../ui/components.js";
import { sigil } from "../ui/sigil.js";
import { getWalletStatus, onWalletStatus } from "../ui/status.js";
import { setTitle } from "../router.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import { ACTIVATION_HEIGHT, ADDRESS_HRP, BRAND, NETWORK } from "../config.js";
import { CLAIM_VSIZE, feeEstimate } from "../share/mine-fee.js";
import {
  COIN_CHANGE_SATS, GPU_COINS, GPU_DRIVERS, GPU_HASHRATE, GPU_HASHRATE_3090, GPU_README_URL, GPU_RELEASE_URL, GPU_RUN_HASHRATE, GPU_SOURCE_URL, claimsText, closedReason,
  difficultyText, durationText, featuredMined, fetchMined, firstRunText, gpuCommands, gpuSpeedNote, isOpen, issuedShareText, mineHref, minedCard, minedPill,
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

/**
 * What one claim costs from the browser wallet's mining address: the Bitcoin network fee for about 684 vB at the rate the
 * wallet pays (the next-block rate plus 25%, up front), plus the platform's service fee.
 */
export function costPanel({ rate = null, service = serviceSats() } = {}) {
  const est = feeEstimate({ rate, service });
  return html`<section class="panel mi-panel" aria-labelledby="mi-cost-h">
    <header class="panel-head"><div class="panel-titles"><div class="eyebrow">COST OF ONE CLAIM</div><h2 class="h3" id="mi-cost-h">What one claim costs</h2></div></header>
    ${kv([
      ["Bitcoin network fee", est ? html`<span class="mono t-btc">~${sats(est.networkSats)}</span> <span class="caption t-3">about ${est.vsize} vB at up to ${est.rate} sat/vB: the next-block rate of ${est.nextRate} plus 25%, rounded up to a whole sat/vB, paid up front ${prov("BTC")}</span>` : html`<span class="t-3">about ${CLAIM_VSIZE} vB at the next-block fee rate plus 25%, rounded up to a whole sat/vB, paid up front (rate not loaded yet)</span>`],
      ["Service fee to the platform", html`<span class="mono t-btc">${sats(service)}</span>`],
      ["Total", est ? html`<span class="mono t-btc">~${sats(est.totalSats)}</span>` : DASH],
    ])}
    <p class="caption t-3">Paid from your wallet's mining address; a relay balance has its own quote in the wallet. The Bitcoin fee follows the fee rate of the day, and the 25% is paid up front because the fee recipient can block a later fee bump.</p>
  </section>`;
}

/** The honest speed note, for the featured token (or the generic sentence without one). */
export function speedPanel(a) {
  return html`<section class="panel mi-panel" aria-labelledby="mi-speed-h">
    <header class="panel-head"><div class="panel-titles"><div class="eyebrow">HOW FAST</div><h2 class="h3" id="mi-speed-h">Your browser is one miner among many</h2></div></header>
    <p class="small" data-speed>${speedNote(a)}</p>
  </section>`;
}

/** A copyable command block, as /verify's "Copy command" blocks. */
function cmdBlock(text) {
  // Long commands wrap on a phone; a flag (--prepare-coins) stays whole instead of splitting after its "--".
  const words = String(text).split(" ").map((w, i) => html`${i ? " " : ""}${w.startsWith("--") ? html`<span class="mi-nobr">${w}</span>` : w}`);
  return html`<div class="mi-cmd"><pre><code>${words}</code></pre><button type="button" class="icon-btn icon-btn--xs mi-cmd-copy" data-action="mi-copy-cmd" aria-label="Copy command" data-tip="Copy command">${icon("copy", { size: 14 })}</button></div>`;
}

/** What the first sync of the CLI replays (one element, data-gpu-sync, so a new block can update it without redrawing the section). */
const syncNote = ({ height, network }) => firstRunText({ height, from: ACTIVATION_HEIGHT, network });

/**
 * "Mine on a GPU": the command-line miner for NVIDIA cards (gpu/README.md, `mine <wallet> <TICKER> --gpu all`).
 * `a` is the featured token (its ticker, live difficulty and reward), `network` the build's network: on mainnet the commands
 * carry MURKLE_NETWORK=mainnet, on signet (the CLI's default) there is no variable and the structure is the same.
 * `rate` is the next-block fee rate (sat/vB) and `height` the chain tip, each null until it is known. The CLI pays each claim
 * at headroomRate(next-block rate), which is what feeEstimate shows.
 */
export function gpuPanel(a, { network = NETWORK, hrp = ADDRESS_HRP, rate = null, height = null } = {}) {
  const ticker = a?.ticker ?? "MURK";
  const c = gpuCommands({ network, ticker, hrp });
  const coins = network === "mainnet" ? "bitcoin" : "signet coins";
  const est = feeEstimate({ rate });
  const service = serviceSats();
  const claimCost = est
    ? html`about <span class="mono t-btc">${sats(est.totalSats)}</span> at up to ${est.rate} sat/vB (${est.vsize} vB at the next-block rate of ${est.nextRate} plus 25%, rounded up to a whole sat/vB, paid up front, plus the ${sats(service)} service fee)`
    : html`the Bitcoin fee (about ${CLAIM_VSIZE} vB at the next-block rate plus 25%, rounded up to a whole sat/vB, paid up front) plus the ${sats(service)} service fee`;
  const coin = est
    ? html`One coin holds <span class="mono t-btc">${sats(est.totalSats + COIN_CHANGE_SATS)}</span>: the claim cost plus ${sats(COIN_CHANGE_SATS)} that come back as change`
    : html`One coin holds the claim cost plus ${sats(COIN_CHANGE_SATS)} that come back as change`;
  const d = Number(a?.difficulty);
  const lasts = d > 0 ? html` At the time per solution above, ${GPU_COINS} coins last ${durationText((GPU_COINS * d) / GPU_RUN_HASHRATE)} on average.` : "";
  const baseUnits = a?.reward != null && Number.isInteger(a?.divisibility)
    ? html`<p class="small">Amounts are in base units: 1 ${ticker} = ${int(10n ** BigInt(a.divisibility))} base units, so one claim of ${rewardText(a)} is <span class="mono">${String(a.reward)}</span>.</p>`
    : html`<p class="small">Amounts are in base units, the smallest unit of the token (<span class="mono">balance</span> prints them): 1 ${ticker} is 10 to the power of its divisibility in base units.</p>`;
  return html`<div class="container" data-gpu data-network="${network}">
    <div class="ld-sec-head"><div class="eyebrow">GPU MINING</div><h2 class="h2-landing" id="mi-gpu-h">Mine on a <em>GPU.</em></h2></div>
    <div class="mi-gpu">
      <p class="lead">An NVIDIA graphics card mines ${ticker} with the ${BRAND} command-line miner. One RTX 4090 measured about ${int(GPU_HASHRATE)} hashes per second for the kernel alone and about ${int(GPU_RUN_HASHRATE)} in a full mining run (every solution re-checked), as much as about a hundred browser tabs. <span data-gpu-speed>${gpuSpeedNote(a)}</span></p>
      <p class="caption t-3" data-gpu-measured>These are measurements on Linux. One RTX 3090 with the release build measured about ${int(GPU_HASHRATE_3090)} for the kernel alone. Other cards are not measured yet, and the Windows build has not been timed yet.</p>
      <p class="small" data-gpu-req><strong>You need:</strong> an NVIDIA GPU (Pascal or newer), Linux or Windows on x64, an NVIDIA driver ${GPU_DRIVERS}, and Node.js 22 or newer. The minimum drivers follow NVIDIA's compatibility rules and are not tested on every version.</p>
      ${c.windowsEnv ? html`<div class="mi-gpu-win" data-gpu-win><p class="small"><strong>On Windows,</strong> open PowerShell and set the network once in that window with the line below, then drop the <span class="mono">MURKLE_NETWORK=mainnet</span> prefix from every command in this list.</p>${cmdBlock(c.windowsEnv)}</div>` : ""}
      <ol class="mi-gpu-steps">
        <li><h3>Get the code</h3>${cmdBlock(c.clone)}</li>
        <li><h3>Download the pinned files</h3>
          ${cmdBlock(c.fetch)}
          <p class="caption t-3">The first command fetches the circuit files and the second the GPU miner build from the release. Each file is checked against its pinned sha256, and nothing is written if one differs.</p></li>
        <li><h3>Create a mining wallet</h3>${cmdBlock(c.create)}
          <p class="small">It prints three addresses at once: the ${BRAND} address (<span class="mono">${hrp}1</span>, where your private notes land), the BTC fee address (it pays a later send) and the <strong>mining fee address</strong>. The mining fee address is the one to fund for mining. The <span class="mono">address</span> command prints them again.</p>
          <p class="caption t-3">The wallet file is saved in the data folder with its keys in plain text; keep it private.</p></li>
        <li><h3>Fund the mining fee address, then split it into coins</h3>
          <p class="small">First send ${coins} to the mining fee address. Then split it into coins, one for each claim you want ready:</p>
          ${cmdBlock(c.prepare)}
          <p class="small"><span data-gpu-sync>${syncNote({ height, network })}</span> The <span class="mono">new</span> command does not sync.</p>
          <p class="small">Each solution is a claim, and each claim spends one coin of that address and costs ${claimCost}. A GPU finds many solutions in a short time. Claims paid from a single coin chain on each other's unconfirmed change, and Bitcoin nodes accept only about 25 unconfirmed transactions in such a chain. Separate coins let claims go out side by side.</p>
          <p class="small">The split above makes ${GPU_COINS} coins; change the number to the claims you want ready. ${coin}, so fund about ${GPU_COINS} times that, plus the split's own fee at the next-block rate (about 43 vB for each coin and about 110 vB more for the transaction itself). The miner binds each claim to your largest coin, so a large leftover coin would be spent first and chain; fund close to what you split.${lasts} Split again when the coins are used.</p></li>
        <li><h3>Mine</h3>${cmdBlock(c.mine)}
          <p class="caption t-3"><span class="mono">--gpu all</span> uses every NVIDIA card; <span class="mono">--gpu 0,1</span> picks cards by number. <span class="mono">--max-claims n</span> stops after n claims. Ctrl+C stops after the current slice. With no coins at the mining fee address it stops and says so.</p></li>
      </ol>
      <div class="mi-gpu-reward" data-gpu-reward>
        <h3>Where the reward goes</h3>
        <p class="small">Each reward lands in that command-line wallet as a private note, not in your browser wallet. When you like, send it to your browser wallet's <span class="mono">${hrp}1</span> address with the send command. A send is paid from the BTC fee address that <span class="mono">new</span> printed, not from the mining fee address, so fund that address for the send's network fee first.</p>
        ${cmdBlock(c.send)}
        <p class="caption t-3">Edit before running: replace <span class="mono">&lt;amount&gt;</span> with a whole number of base units (as <span class="mono">balance</span> prints) and the last word with your browser wallet's address.</p>
        ${baseUnits}
      </div>
      <div class="cluster mi-gpu-links" data-gpu-links>
        ${button({ label: "Release gpu-v1.0.0", href: GPU_RELEASE_URL, kind: "secondary", size: "sm" })}
        ${button({ label: "gpu/README.md", href: GPU_README_URL, kind: "secondary", size: "sm" })}
        ${button({ label: "Source (gpu/)", href: GPU_SOURCE_URL, kind: "secondary", size: "sm" })}
      </div>
    </div>
  </div>`;
}

export function render(root) {
  setTitle("Mine");
  let list = null;
  let failed = null;
  let rate = null;
  let alive = true;
  let paintKey = null;
  let gpuFeatured;
  let tip = null;

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
    <section class="ld-sec" id="gpu" aria-labelledby="mi-gpu-h" data-gpu-slot>${gpuPanel(null)}</section>
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
    gpuFeatured = featured;
    $("[data-gpu-slot]").innerHTML = gpuPanel(featured, { rate, height: tip });
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
      if (!alive) return;
      $("[data-cost]").innerHTML = costPanel({ rate });
      if (gpuFeatured !== undefined) $("[data-gpu-slot]").innerHTML = gpuPanel(gpuFeatured, { rate, height: tip });
    })
    .catch(() => {});

  let lastHeight = null;
  const offs = [
    api.watchState((s) => {
      if (!alive || !s) return;
      if (lastHeight !== null && s.height !== lastHeight) load(true);
      lastHeight = s.height;
      // The first-sync block count follows the tip without redrawing the section (a selection or a copied command stays put).
      tip = Number.isSafeInteger(s.height) ? s.height : tip;
      const note = $("[data-gpu-sync]");
      if (note) note.textContent = syncNote({ height: tip, network: NETWORK });
    }),
    onWalletStatus(() => alive && list && paint()),
    on(root, "click", "[data-action=mi-retry]", () => load(true)),
    on(root, "click", "[data-action=mi-copy-cmd]", async (e, b) => {
      const ok = await copyText(b.closest(".mi-cmd").querySelector("code").textContent);
      toast({ kind: ok ? "success" : "warn", title: ok ? "Command copied." : "Couldn't copy." });
    }),
  ];

  load();
  return () => {
    alive = false;
    offs.forEach((off) => off());
  };
}

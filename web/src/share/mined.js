/**
 * Mined tokens (kind "pow") on the public pages: the /mine page, the landing's Mine block, the
 * "Mining now" rows of /mints and the landing's "mined" stat. Pure helpers and markup; nothing here
 * loads the wallet bundle (no session.js), so a visitor reads it all without a wallet.
 *
 * Rows are GET /api/mine assets (MinedView, docs/API.md): { asset, ticker, divisibility, status
 * ("mining-soon" | "mining" | "mined-out" | "mining-ended"), deployHeight, deployTxid, mineStart,
 * reward, baseReward, halvingInterval, difficulty, issued, maxSupply, claims, ... }. Bigints
 * arrive as decimal strings.
 *
 * API
 *   CLAIM_VSIZE, TAB_HASHRATE                      the claim's size in vB and a desktop tab's hashrate (H/s)
 *   mineHref(ticker) -> "/app/mine?t=ABC"          the wallet's Mine page with the token preselected
 *   miningOn() -> boolean                          this network's service-fee rule is complete (mineFeeReady)
 *   serviceSats() -> bigint                        the platform's service fee per claim (MINE_FEE)
 *   fetchMined({ fresh }) -> Promise<asset[]>      /api/mine assets, [] when mining is not configured
 *   isOpen(a), isListed(a), rankMined(list), featuredMined(list), openMined(list)
 *   claimsTotal(a) -> number | null                claims it takes to mine the whole supply (no halving)
 *   claimsText(a) -> "1 of 21,000" | "1"           claims mined of the total
 *   minedClaims(list) -> number                    accepted claims over all the tokens
 *   rewardText(a), supplyText(a), difficultyText(a)
 *   wholeTokens(v, div) -> number                  base units to whole tokens (for the progress bar)
 *   issuedShare(a) -> 0..100, issuedShareText(a)   share of the supply issued
 *   feeEstimate({ rate }) -> { vsize, rate, networkSats, serviceSats, totalSats } | null
 *   publicFeeRate(esplora?) -> Promise<number>     next-block sat/vB, as the wallet reads it
 *   durationText(seconds), speedNote(a) -> string  expected time per solution = difficulty / hash rate
 *   GPU_HASHRATE, gpuSpeedNote(a), gpuCommands({ network, ticker }) -> { clone, fetch, create, mine, ... }   the GPU section
 *   minedPill(a), minedCard(a, { walletReady }), mineBlock(a, { walletReady })
 */
import { html } from "../ui/dom.js";
import { int, units, heightText, short, DASH } from "../ui/format.js";
import { button, progress, statusPill } from "../ui/components.js";
import { prov } from "../ui/prov.js";
import { sigil } from "../ui/sigil.js";
import { MINE_FEE, mineFeeReady, REPO_URL } from "../../../src/params.mjs";
import * as api from "../api.js";

/** A mining claim's Bitcoin transaction is about 684 vB (the wallet prices claims with the same figure). */
export const CLAIM_VSIZE = 684;
/** What one browser tab on a desktop computer hashes per second, roughly (Argon2id, mining-contract.md section 10). */
export const TAB_HASHRATE = 1000;

export const mineHref = (ticker) => `/app/mine?t=${encodeURIComponent(ticker)}`;

export const miningOn = () => mineFeeReady() === null;

export function serviceSats() {
  try {
    return BigInt(MINE_FEE?.platformSats ?? 0);
  } catch {
    return 0n;
  }
}

const big = (v, d = 0n) => {
  try {
    return v === null || v === undefined || v === "" ? d : BigInt(v);
  } catch {
    return d;
  }
};
/** Whole tokens of an amount in base units (the progress bar counts tokens, not base units). */
export const wholeTokens = (v, div) => Number(big(v) / 10n ** BigInt(Number.isInteger(div) && div > 0 ? div : 0));

/** The mined tokens of /api/mine; nothing is asked when this network's mining fee rule is incomplete. */
export async function fetchMined({ fresh = false, signal } = {}) {
  if (!miningOn()) return [];
  const m = await api.mine({ fresh, signal });
  return (m?.assets ?? []).filter((a) => a && a.ticker && (a.kind === undefined || a.kind === "pow"));
}

export const isOpen = (a) => a?.status === "mining";
/** Mining now or opening soon: what the landing and /mints put forward. */
export const isListed = (a) => a?.status === "mining" || a?.status === "mining-soon";

const RANK = { mining: 0, "mining-soon": 1, "mined-out": 2, "mining-ended": 3 };

/** Open tokens first, then the most claims, then the newest launch. A new array. */
export function rankMined(list) {
  const n = (v) => Number(v ?? 0);
  return [...(list ?? [])].sort(
    (x, y) => (RANK[x.status] ?? 9) - (RANK[y.status] ?? 9) || n(y.claims) - n(x.claims) || n(y.deployHeight) - n(x.deployHeight) || (big(y.asset) < big(x.asset) ? -1 : big(y.asset) > big(x.asset) ? 1 : 0),
  );
}

export const openMined = (list) => rankMined((list ?? []).filter(isListed));

/** The token to put forward: the open one with the most claims (newest on a tie), else one opening soon, else none. */
export const featuredMined = (list) => openMined(list)[0] ?? null;

/** Claims it takes to mine the whole supply at the base reward; null when halvings make it a moving target. */
export function claimsTotal(a) {
  const reward = big(a?.baseReward ?? a?.reward);
  const max = big(a?.maxSupply);
  if (reward <= 0n || max <= 0n || Number(a?.halvingInterval) > 0) return null;
  return Number((max + reward - 1n) / reward);
}

export function claimsText(a) {
  const total = claimsTotal(a);
  return total === null ? int(a?.claims ?? 0) : `${int(a?.claims ?? 0)} of ${int(total)}`;
}

export const minedClaims = (list) => (list ?? []).reduce((s, a) => s + (Number(a?.claims) || 0), 0);

export const rewardText = (a) => `${units(a?.reward ?? 0, a?.divisibility ?? 0)} ${a?.ticker ?? ""}`.trim();
export const supplyText = (a) => `${units(a?.issued ?? 0, a?.divisibility ?? 0)} of ${units(a?.maxSupply ?? 0, a?.divisibility ?? 0)} ${a?.ticker ?? ""}`.trim();
export const difficultyText = (a) => (a?.difficulty == null ? DASH : int(a.difficulty));

/** Share of the supply issued, 0 to 100 (from the exact integers). */
export function issuedShare(a) {
  const max = big(a?.maxSupply);
  if (max <= 0n) return 0;
  return Math.min(100, Number((big(a?.issued) * 1_000_000n) / max) / 10_000);
}
export const issuedShareText = (a) => {
  const p = issuedShare(a);
  return p === 0 ? "0%" : p < 0.1 ? "under 0.1%" : `${p.toFixed(p < 10 ? 1 : 0)}%`;
};

/** Cost of one claim paid from the wallet's mining address, at a whole sat/vB rate (the page's estimate). */
export function feeEstimate({ rate, service = serviceSats() } = {}) {
  const r = Math.ceil(Number(rate));
  if (!Number.isFinite(r) || r <= 0) return null;
  const networkSats = BigInt(CLAIM_VSIZE * r);
  return { vsize: CLAIM_VSIZE, rate: r, networkSats, serviceSats: service, totalSats: networkSats + service };
}

/** The next-block rate in sat/vB, read the way the wallet reads it. Throws when no explorer answers. */
export async function publicFeeRate(esplora = api.esplora) {
  try {
    if (typeof esplora.requestUrl === "function" && /\/api$/.test(esplora.base ?? "")) {
      const fees = await (await esplora.requestUrl(esplora.base.replace(/\/api$/, "/api/v1") + "/fees/recommended", "/v1/fees/recommended")).json();
      const rate = Number(fees?.fastestFee);
      if (Number.isFinite(rate) && rate > 0) return Math.max(1, Math.ceil(rate));
    }
  } catch {
    // Not mempool.space, or it failed: the plain estimate below.
  }
  return esplora.feeRate();
}

/** "about 20 seconds", "about 12 minutes", "about 1 hour", "about 3 days". */
export function durationText(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 0) return DASH;
  const plural = (n, w) => `about ${int(n)} ${n === 1 ? w : w + "s"}`;
  if (s < 90) return plural(Math.max(1, Math.round(s)), "second");
  if (s < 3300) return plural(Math.round(s / 60), "minute");
  if (s < 172_800) {
    const h = Number((s / 3600).toFixed(1));
    return `about ${h} ${h === 1 ? "hour" : "hours"}`;
  }
  if (s < 3_153_600_000) return plural(Math.round(s / 86_400), "day");
  return "longer than a lifetime";
}

/** How long a solution takes: difficulty / hash rate, for one desktop tab; GPUs and servers are faster. */
export function speedNote(a) {
  const d = Number(a?.difficulty);
  const base = "Expected time per solution = difficulty / hash rate.";
  const tail = "GPUs and servers are faster, and difficulty adjusts to the work, so more miners make each solution harder to find.";
  if (!(d > 0)) return `${base} ${tail}`;
  return `${base} At difficulty ${int(a.difficulty)}, a desktop browser tab (about ${int(TAB_HASHRATE)} hashes per second) needs ${durationText(d / TAB_HASHRATE)} per solution. ${tail}`;
}

/** One RTX 4090 measured about 113,000 hashes per second with the GPU miner (gpu/README.md section 7, docs/design/mining.md 4.4). */
export const GPU_HASHRATE = 113_000;
export const GPU_RELEASE_URL = `${REPO_URL}/releases/tag/gpu-v1.0.0`;
export const GPU_README_URL = `${REPO_URL}/blob/main/gpu/README.md`;
export const GPU_SOURCE_URL = `${REPO_URL}/tree/main/gpu`;
/** The drivers gpu/README.md names (CUDA minor-version compatibility). */
export const GPU_DRIVERS = "525.60 or newer on Linux, 527.41 or newer on Windows";

/** The GPU speed note: difficulty / 113,000 seconds for the token's live difficulty (the bare formula without one). */
export function gpuSpeedNote(a) {
  const d = Number(a?.difficulty);
  if (!(d > 0)) return `Expected time per solution = difficulty / ${int(GPU_HASHRATE)} seconds.`;
  return `At difficulty ${int(a.difficulty)} that is ${durationText(d / GPU_HASHRATE)} per solution on that card (difficulty / ${int(GPU_HASHRATE)} seconds).`;
}

/**
 * The commands of the GPU section for a network. On mainnet each command that reads the network carries
 * MURKLE_NETWORK=mainnet and Windows (PowerShell) sets the variable once; on signet (the CLI's default) there is none.
 * The flags are the CLI's own (MINE_USAGE in bin/murkle.mjs): mine <wallet> <TICKER> --gpu all.
 */
export function gpuCommands({ network = "signet", ticker = "MURK", wallet = "miner", hrp = "mrk" } = {}) {
  const main = network === "mainnet";
  const pre = main ? "MURKLE_NETWORK=mainnet " : "";
  return {
    network,
    windowsEnv: main ? '$env:MURKLE_NETWORK = "mainnet"' : null,
    clone: `git clone ${REPO_URL}\ncd murkle\nnpm ci`,
    fetch: `${pre}npm run artifacts:fetch\nnpm run gpu:fetch`,
    create: `${pre}node bin/murkle.mjs new ${wallet}`,
    mine: `${pre}node bin/murkle.mjs mine ${wallet} ${ticker} --gpu all`,
    address: `${pre}node bin/murkle.mjs address ${wallet}`,
    send: `${pre}node bin/murkle.mjs send ${wallet} ${ticker} <amount> <your-${hrp}1-address>`,
  };
}

const PILL = {
  mining: ["open", "MINING"],
  "mining-soon": ["upcoming", "OPENS SOON"],
  "mined-out": ["soldout", "MINED OUT"],
  "mining-ended": ["ended", "ENDED"],
};
export function minedPill(a) {
  const [kind, text] = PILL[a?.status] ?? ["ended", String(a?.status ?? "unknown").toUpperCase()];
  return statusPill(kind, text);
}

/** One line for a token that cannot be mined now. */
export function closedReason(a) {
  if (a?.status === "mining-soon") return `Mining opens at ${heightText(a.mineStart)}.`;
  if (a?.status === "mined-out") return "Every reward under the cap is claimed.";
  return "The reward has reached 0 or the end block has passed.";
}

/** A /mints row for a mined token: the paid-mint card's layout, with Mine in place of Mint. */
export function minedCard(a, { walletReady = false } = {}) {
  const t = encodeURIComponent(a.ticker);
  return html`<article class="panel lp-card" data-ticker="${a.ticker}" data-kind="pow">
    <div class="lp-card-top">
      ${sigil(a.asset, { size: 40 })}
      <a class="ticker ticker--card lp-card-name" href="/t/${t}" data-link>${a.ticker}</a>
      ${minedPill(a)}
    </div>
    <div class="lp-card-meta mono">Mined · launched ${heightText(a.deployHeight)} · ${short(a.deployTxid)}</div>
    ${progress({ value: wholeTokens(a.issued, a.divisibility), max: wholeTokens(a.maxSupply, a.divisibility) || null, unit: a.ticker, label: false })}
    <p class="caption t-3 mono">${supplyText(a)} · ${issuedShareText(a)}</p>
    <dl class="lp-card-dl">
      <div><dt>Reward</dt><dd class="mono">${units(a.reward ?? 0, a.divisibility ?? 0)}</dd></div>
      <div><dt>Difficulty</dt><dd class="mono">${difficultyText(a)}</dd></div>
      <div><dt>Claims</dt><dd class="mono">${claimsText(a)}</dd></div>
    </dl>
    <div class="lp-card-foot">${
      isOpen(a)
        ? button({ label: `Mine ${a.ticker}`, href: mineHref(a.ticker), kind: walletReady ? "btc" : "neutral", icon: "pick", block: true })
        : html`<p class="lp-card-reason caption">${closedReason(a)}</p>`
    }</div>
  </article>`;
}

/**
 * The landing's Mine block for the featured token `a`: ticker, claims mined of the total, a slim bar,
 * the reward per claim, Start mining and a link to /mine. "" when there is no token (the block is hidden).
 */
export function mineBlock(a, { walletReady = false } = {}) {
  if (!a) return "";
  const t = encodeURIComponent(a.ticker);
  const open = isOpen(a);
  return html`<div class="panel panel--certified ld-mine-card" data-ticker="${a.ticker}">
      <div class="ld-mine-id">
        ${sigil(a.asset, { size: 48 })}
        <div class="ld-mine-title">
          <div class="eyebrow">MINE IN YOUR BROWSER ${prov("IDX")}</div>
          <h2 class="ld-mine-h" id="ld-mine-h">Mine <a class="ticker" href="/t/${t}" data-link>$${a.ticker}</a></h2>
        </div>
        ${minedPill(a)}
      </div>
      <div class="ld-mine-nums">
        <div class="ld-mine-claims">
          <div class="ld-mine-big mono" data-mine-claims>${claimsText(a)}</div>
          <div class="ld-mine-cap caption t-3">claims mined</div>
          ${progress({ value: wholeTokens(a.issued, a.divisibility), max: wholeTokens(a.maxSupply, a.divisibility) || null, unit: a.ticker, label: false })}
        </div>
        <dl class="ld-mine-dl">
          <div><dt>Reward per claim</dt><dd class="mono">${rewardText(a)}</dd></div>
          <div><dt>Issued</dt><dd class="mono">${issuedShareText(a)} of the supply</dd></div>
        </dl>
      </div>
      <div class="ld-mine-cta">
        ${open
          ? button({ label: "Start mining", href: mineHref(a.ticker), kind: walletReady ? "btc" : "neutral", size: "lg", icon: "pick" })
          : button({ label: `View ${a.ticker}`, href: `/t/${t}`, kind: "neutral", size: "lg" })}
        <a class="ld-mine-link" href="/mine" data-link>How mining works →</a>
        ${open ? "" : html`<span class="caption t-3">${closedReason(a)}</span>`}
      </div>
    </div>`;
}

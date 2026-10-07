// /app/launch: write a token's terms to Bitcoin (DEPLOY). The form shows a live
// preview of the launch card and the exact DEPLOY envelope as Envelope Anatomy.
// A launch is public by design and never relayed (a free launch would allow
// free ticker squatting); it is paid from your own Bitcoin address.
//
// "Mined" (mining-contract.md §10.4, mining.md §12.1): the same page writes a DEPLOY_POW
// instead. The token is then issued only by proof-of-work claims: reward, max supply,
// solutions per block, span, an expected launch hashrate that suggests the initial
// difficulty, a floor (initial / 16, never below 256), optional halving, a start (two
// choices: "Start mining now", at the launch block itself, or "Start after N blocks") and end. The claim fee is fixed at 0: under the current rules
// every claim pays the platform's service fee instead, and the form says so.
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { int, sats, units, heightText, eta, plural, bytes as fmtBytes } from "../ui/format.js";
import { button, field, panel, progress, statusPill, kv, disclosure, segmented } from "../ui/components.js";
import { sigil } from "../ui/sigil.js";
import { hexmap } from "../ui/hexmap.js";
import { chainWritesBlocked } from "../ui/status.js";
import { openSheet } from "../ui/sheet.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import { encodeDeploy, encodeDeployPow } from "../../../src/envelope.mjs";
import { LAUNCH_DEFAULTS, startHeightFor, suggestFloor, suggestInitialDifficulty } from "../../../src/mine.mjs";
import { D_MAX, MAX_PER_BLOCK, MINE_FEE, MIN_DIFFICULTY, MIN_SPAN_CLAIMS, SPAN_MAX, SPAN_MIN, mineFeeReady } from "../../../src/params.mjs";
import { BTC_WORD, IS_SIGNET } from "../config.js";
import { dustLimit, scriptOf } from "../../../src/btc/funding.mjs";
import * as api from "../api.js";
import { parseUnits } from "../session.js";
import { withWallet, pageHead, wireStreamer, liveSession, btcHTML, callout, provingSheet, MINE_TEXT, MINE_RECIPIENT } from "./app-shared.js";
import { payerCards } from "./app-mint.js";
import { openDeposit } from "./deposit.js";
import { shareText, xIntentUrl } from "../share/launch-card.js";

const TICKER = /^[A-Z0-9]{1,16}$/;
const CARRIER_OVERHEAD_VB = 150; // one P2TR input, change, OP_RETURN framing
const U32_MAX = 0xffffffff; // DEPLOY heights and cap are u32, the price u64
const U64_MAX = (1n << 64n) - 1n;

export const LAUNCH_STEPS = (payerKind) => [
  { id: "sync", label: "Sync and check the ticker is free", prov: "IDX" },
  { id: "sign", label: payerKind === "unisat" ? "Confirm in Unisat" : "Sign with built-in key" },
  { id: "broadcast", label: "Broadcast, then in mempool", prov: "BTC" },
];

/** Form values -> { terms, envelope, errors{}, supply, raise }. Pure. */
export function buildTerms(v, { height = null, taken = new Set() } = {}) {
  const errors = {};
  const ticker = String(v.ticker ?? "").trim().toUpperCase();
  if (!ticker) errors.ticker = "Pick a ticker: 1 to 16 letters A-Z or digits.";
  else if (!TICKER.test(ticker)) errors.ticker = "Use 1 to 16 letters A-Z or digits only.";
  else if (taken.has(ticker)) errors.ticker = `${ticker} is already taken. Tickers are first come, first served.`;
  const divisibility = Number(v.decimals ?? 0);
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 8) errors.decimals = "Decimals go from 0 to 8.";
  let mintAmount = null;
  try {
    mintAmount = parseUnits(String(v.perMint ?? ""), Number.isInteger(divisibility) ? Math.min(8, Math.max(0, divisibility)) : 0);
    if (mintAmount <= 0n) throw new Error("Per mint must be greater than zero.");
  } catch (e) {
    errors.perMint = e.message;
    mintAmount = null;
  }
  const mintCap = Number(String(v.mints ?? "").replace(/,/g, ""));
  if (!Number.isInteger(mintCap) || mintCap < 1 || mintCap > U32_MAX) errors.mints = "Number of mints: a whole number from 1 to 4,294,967,295.";
  let priceSats = 0n;
  try {
    priceSats = BigInt(String(v.price ?? "0").replace(/,/g, "").trim() || "0");
    if (priceSats < 0n || priceSats > U64_MAX) throw new Error();
  } catch {
    errors.price = "Price in whole sats, 0 or more.";
  }
  let treasury = new Uint8Array();
  const tAddr = String(v.treasury ?? "").trim();
  if (tAddr) {
    try {
      treasury = scriptOf(tAddr);
    } catch {
      errors.treasury = IS_SIGNET ? "That isn't a valid signet Bitcoin address." : "That isn't a valid Bitcoin mainnet address.";
    }
  } else if (priceSats > 0n) errors.treasury = "A paid mint needs a treasury address.";
  // Nodes refuse to relay a payment below the dust limit, so such a price could never be paid as set.
  if (!errors.price && treasury.length && priceSats > 0n && priceSats < dustLimit(treasury)) {
    errors.price = `A paid mint costs at least ${dustLimit(treasury)} sats: Bitcoin nodes refuse smaller payments to this address. Or set 0 for a free mint.`;
  }
  const startHeight = Number(v.start || 0);
  const endHeight = Number(v.end || 0);
  if (!Number.isInteger(startHeight) || startHeight < 0 || startHeight > U32_MAX) errors.start = "A block height, or 0 to open right away.";
  if (!Number.isInteger(endHeight) || endHeight < 0 || endHeight > U32_MAX) errors.end = "A block height, or 0 for no end.";
  else if (endHeight && endHeight < startHeight) errors.end = "The end block comes before the start block.";
  else if (endHeight && height !== null && endHeight <= height) errors.end = "The end block is already in the past.";
  const supply = mintAmount !== null && !errors.mints ? mintAmount * BigInt(mintCap) : null;
  const raise = !errors.mints && !errors.price ? priceSats * BigInt(mintCap) : null;
  let envelope = null;
  let terms = null;
  if (!Object.keys(errors).length) {
    terms = { ticker, divisibility, mintAmount, mintCap, priceSats, treasury: tAddr || null, startHeight, endHeight };
    try {
      envelope = encodeDeploy({ ...terms, treasury });
    } catch (e) {
      errors.form = e.message;
      terms = null;
    }
  }
  return { ticker, divisibility, mintAmount, mintCap, priceSats, supply, raise, terms, envelope, errors };
}

/* ---------- mined tokens (DEPLOY_POW) ---------- */

const I63_MAX = (1n << 63n) - 1n;
/** Form defaults of a mined launch (LAUNCH_DEFAULTS of src/mine.mjs). Blank initial / floor = the suggestion. */
export const POW_FORM_DEFAULTS = Object.freeze({
  reward: "50", maxSupply: "1050000", perBlock: String(LAUNCH_DEFAULTS.perBlock), span: String(LAUNCH_DEFAULTS.span),
  hashrate: String(LAUNCH_DEFAULTS.launchHashrate), initial: "", floor: "", halving: String(LAUNCH_DEFAULTS.halvingInterval),
  start: LAUNCH_DEFAULTS.start, startAfter: String(LAUNCH_DEFAULTS.startAfter), end: "0",
});
/** The two start choices of a mined launch, and the one-line trade-off shown next to them. */
export const START_OPTIONS = Object.freeze([
  { value: "now", label: "Start mining now" },
  { value: "after", label: "Start after N blocks" },
]);
export const START_HINT = MINE_TEXT.start;
/** Disclosures of a mined launch: noise, surge, and who receives the service fee (mining-contract.md §12). */
export const POW_DISCLOSURES = () => [
  MINE_TEXT.noise,
  MINE_TEXT.burst,
  ...(MINE_FEE && BigInt(MINE_FEE.platformSats) > 0n ? [MINE_TEXT.fee({ sats: MINE_FEE.platformSats, recipient: MINE_RECIPIENT })] : []),
  MINE_TEXT.gpu,
];

const wholeNum = (t) => {
  const s = String(t ?? "").replace(/,/g, "").trim();
  return /^\d+$/.test(s) ? BigInt(s) : null;
};

/**
 * Mined-launch form values -> { ..., terms, envelope, errors{} }. Pure. `v`: ticker, decimals,
 * reward, maxSupply, perBlock, span, hashrate, initial (blank: suggested), floor (blank:
 * initial / 16, at least 256), halving, start ("now" | "after"), startAfter (blocks, for
 * "after"), end (0: none). height: the current tip; the launch lands at height + 1 at the
 * earliest. "now" encodes startHeight 0: mining opens at the launch block itself. "after"
 * encodes startHeight = height + 1 + startAfter (startHeightFor): the count runs from the
 * current tip, so a later launch block keeps that start block and shortens the delay.
 */
/**
 * Blocks of confirmation delay a mined launch's end block must leave room for. A DEPLOY_POW whose
 * end is below max(start, its own block) is rejected and its fee is spent, so the launch must
 * confirm by the end block; the form keeps that at least this many blocks after the next one.
 */
export const END_MARGIN = 6;

/** The sentence every surface shows when a mined launch has an end block. */
export const confirmByText = (endHeight) => `The launch must confirm by block ${int(endHeight)} (the end block), or it is rejected and its fee is spent.`;

/** The line under the start choice: where mining opens for this choice, at tip `h`. */
export function startText(r, h) {
  if (r.startMode === "now") {
    return `Mining opens at the launch block itself${r.mineStart !== null ? ` (block ${int(r.mineStart)} if it lands in the next block)` : ""}. Its hash is unknown until it is mined, so nobody can start before it; claims can reference it from the next block on.`;
  }
  if (r.startMode !== "after" || r.startHeight === null) return "";
  return (
    `First usable block ${int(r.startHeight)}${h !== null && r.startHeight > h ? `, ${eta(r.startHeight - h)}` : ""}: ${plural(r.startAfter, "block")} after the next block. ` +
    `The count runs from the current tip: if the launch confirms later, the start block stays ${int(r.startHeight)} and the delay is shorter.`
  );
}

/** After the broadcast: when mining opens for this launch. */
export function opensText(r) {
  return r.startMode === "after" && r.startHeight !== null
    ? `Mining opens at block ${int(r.startHeight)} as you set, or at the launch block if it confirms at or after that block.`
    : "Mining opens at the launch block itself: claims can reference it from the next block on.";
}

export function buildPowTerms(v, { height = null, taken = new Set() } = {}) {
  const errors = {};
  const ticker = String(v.ticker ?? "").trim().toUpperCase();
  if (!ticker) errors.ticker = "Pick a ticker: 1 to 16 letters A-Z or digits.";
  else if (!TICKER.test(ticker)) errors.ticker = "Use 1 to 16 letters A-Z or digits only.";
  else if (taken.has(ticker)) errors.ticker = `${ticker} is already taken. Tickers are first come, first served.`;
  const divisibility = Number(v.decimals ?? 0);
  if (!Number.isInteger(divisibility) || divisibility < 0 || divisibility > 8) errors.decimals = "Decimals go from 0 to 8.";
  const div = Number.isInteger(divisibility) ? Math.min(8, Math.max(0, divisibility)) : 0;
  let reward = null;
  try {
    reward = parseUnits(String(v.reward ?? ""), div);
    if (reward <= 0n || reward > I63_MAX) throw new Error("The reward per claim must be greater than zero (and below 2^63 base units).");
  } catch (e) {
    errors.reward = e.message;
    reward = null;
  }
  let maxSupply = null;
  try {
    maxSupply = parseUnits(String(v.maxSupply ?? ""), div);
    if (maxSupply > U64_MAX) throw new Error("Max supply is at most 2^64 - 1 base units.");
    if (reward !== null && maxSupply < reward) throw new Error("Max supply must be at least one reward.");
  } catch (e) {
    errors.maxSupply = e.message;
    maxSupply = null;
  }
  const span = Number(v.span);
  if (!Number.isInteger(span) || span < SPAN_MIN || span > SPAN_MAX) errors.span = `The span is a whole number of blocks from ${SPAN_MIN} to ${SPAN_MAX}.`;
  const perBlock = Number(String(v.perBlock ?? "").trim());
  let targetPerSpan = null;
  if (!Number.isFinite(perBlock) || perBlock <= 0) errors.perBlock = "Solutions per block: a number greater than zero, such as 1 or 0.5.";
  else if (!errors.span) {
    targetPerSpan = Math.round(perBlock * span);
    if (targetPerSpan < MIN_SPAN_CLAIMS) errors.perBlock = `With a span of ${span} blocks, ask for at least ${(MIN_SPAN_CLAIMS / span).toFixed(2)} per block (${MIN_SPAN_CLAIMS} per span), or the difficulty gets too noisy.`;
    else if (targetPerSpan > MAX_PER_BLOCK * span) errors.perBlock = `At most ${MAX_PER_BLOCK} per block: a block holds about 1,700 claims, so more could never raise the difficulty.`;
  }
  const hashrate = Number(String(v.hashrate ?? "").replace(/,/g, "").trim());
  if (!Number.isFinite(hashrate) || hashrate <= 0) errors.hashrate = "Expected launch hashrate in hashes per second, greater than zero.";
  const suggested = !errors.hashrate && targetPerSpan ? suggestInitialDifficulty({ hashrate, span, targetPerSpan }) : null;
  let initialDifficulty = null;
  if (String(v.initial ?? "").trim()) {
    initialDifficulty = wholeNum(v.initial);
    if (initialDifficulty === null || initialDifficulty < MIN_DIFFICULTY || initialDifficulty > D_MAX) {
      errors.initial = `A whole number from ${MIN_DIFFICULTY} to 2^63 - 1.`;
      initialDifficulty = null;
    }
  } else initialDifficulty = suggested;
  const suggestedFloor = initialDifficulty !== null ? suggestFloor(initialDifficulty) : null;
  let minDifficulty = null;
  if (String(v.floor ?? "").trim()) {
    minDifficulty = wholeNum(v.floor);
    if (minDifficulty === null || minDifficulty < MIN_DIFFICULTY) {
      errors.floor = `The floor is a whole number, at least ${MIN_DIFFICULTY}.`;
      minDifficulty = null;
    } else if (initialDifficulty !== null && minDifficulty > initialDifficulty) {
      errors.floor = "The floor can't be above the initial difficulty.";
      minDifficulty = null;
    }
  } else minDifficulty = suggestedFloor;
  const halvingInterval = Number(String(v.halving ?? "0").trim() || 0);
  if (!Number.isInteger(halvingInterval) || halvingInterval < 0 || halvingInterval > U32_MAX) errors.halving = "Blocks between halvings, or 0 for no halving.";
  const startMode = v.start === "after" ? "after" : v.start === "now" || v.start == null ? "now" : null;
  if (!startMode) errors.start = "Pick when mining starts: now, or after a number of blocks.";
  const startAfter = startMode === "after" ? Number(String(v.startAfter ?? "").replace(/,/g, "").trim() || NaN) : 0;
  let startHeight = startMode === "now" ? 0 : null;
  if (startMode === "after") {
    if (!Number.isSafeInteger(startAfter) || startAfter < 1) errors.startAfter = "A whole number of blocks, at least 1. To start at the launch block, pick Start mining now.";
    else if (height === null) errors.startAfter = "Waiting for the current block height to count from.";
    else {
      try {
        startHeight = startHeightFor({ start: "after", after: startAfter, tip: height });
      } catch (e) {
        errors.startAfter = `${e.message[0].toUpperCase()}${e.message.slice(1)}.`;
      }
    }
  }
  // The launch lands at height + 1 at the earliest; mining opens at max(startHeight, its block).
  const earliest = height !== null ? height + 1 : null;
  const mineStart = startMode === "now" ? earliest : startHeight;
  const endHeight = Number(v.end || 0);
  if (!Number.isInteger(endHeight) || endHeight < 0 || endHeight > U32_MAX) errors.end = "A block height, or 0 for no end.";
  else if (endHeight && mineStart !== null && endHeight < mineStart) errors.end = `The end block comes before mining starts (block ${int(mineStart)}).`;
  else if (endHeight && earliest !== null && endHeight < earliest + END_MARGIN) {
    errors.end = `Set the end at block ${int(earliest + END_MARGIN)} or later. ${confirmByText(endHeight)} Leave room for a few blocks of delay.`;
  }
  // Blocks to mine everything out at the target pace, with no halving (an estimate).
  const claims = reward && maxSupply ? maxSupply / reward : null;
  const blocksToMineOut = claims !== null && targetPerSpan ? Math.ceil((Number(claims) * span) / targetPerSpan) : null;
  const leftover = reward && maxSupply && !halvingInterval ? maxSupply % reward : 0n;
  let terms = null;
  let envelope = null;
  if (!Object.keys(errors).length) {
    terms = {
      ticker, divisibility, reward, maxSupply, halvingInterval, span, targetPerSpan, initialDifficulty, minDifficulty,
      claimFeeSats: 0n, treasury: new Uint8Array(), startHeight, endHeight,
    };
    try {
      envelope = encodeDeployPow(terms);
    } catch (e) {
      errors.form = e.message;
      terms = null;
    }
  }
  return {
    kind: "pow", ticker, divisibility, reward, maxSupply, span, perBlock, targetPerSpan, hashrate, suggested, initialDifficulty, suggestedFloor, minDifficulty,
    halvingInterval, startMode, startAfter, startHeight, endHeight, mineStart, blocksToMineOut, leftover, terms, envelope, errors,
    confirmBy: endHeight ? endHeight : null,
  };
}

export function launchView(root, s, query = null) {
  const v = { ticker: "", decimals: "0", perMint: "1000", mints: "1000", price: "1000", treasury: "", start: "0", end: "0" };
  // "mint" (DEPLOY, paid mints) or "pow" (DEPLOY_POW, mined); ?kind=pow opens the second.
  let kind = query?.get?.("kind") === "pow" ? "pow" : "mint";
  const pv = { ...POW_FORM_DEFAULTS };
  const KIND_SEG = () => segmented([{ value: "mint", label: "Paid mint" }, { value: "pow", label: "Mined" }], { value: kind, name: "launch-kind", label: "How the token is issued" });
  let feeRate = null;
  let done = null;
  let busy = false;

  const payerAddress = () => (s.payerPref === "unisat" ? s.unisat?.address : s.localPayer.address) ?? "";
  v.treasury = payerAddress();
  const taken = () => new Set(s.assetList.map((a) => a.ticker));
  const now = () => s.view?.height ?? s.state?.height ?? null;

  const errorOf = (r, k) => (r.errors[k] ? html`<p class="caption t-danger">${icon("warn", { size: 14 })}${r.errors[k]}</p>` : "");

  function shell() {
    if (kind === "pow") return shellPow();
    root.innerHTML = html`<div class="wl">
      ${pageHead({ eyebrow: "LAUNCH", title: "Launch a token", lead: "Write a token's terms to Bitcoin: ticker, supply, mint price, schedule. One transaction. No premine. Terms can't change after it.", streamer: true })}
      <div class="wl-cols">
        <form class="wl-form" novalidate data-f>
          ${panel({ eyebrow: "ISSUED BY", body: html`${KIND_SEG()}<p class="caption t-3" style="margin-top:8px">Paid mint: anyone buys a fixed amount at your price. Mined: anyone claims a fixed reward with proof of work.</p>` })}
          ${panel({
            eyebrow: "IDENTITY",
            body: html`<div class="grid-2f">
              <div>${field({ label: "Ticker", name: "ticker", value: v.ticker, mono: true, placeholder: "ABC", attrs: { maxlength: 16, autocomplete: "off", autocapitalize: "characters", spellcheck: "false" } })}<div data-err="ticker"></div></div>
              <div>${field({ label: "Decimals", name: "decimals", value: v.decimals, type: "number", attrs: { min: 0, max: 8, inputmode: "numeric" } })}<div data-err="decimals"></div></div>
            </div>`,
          })}
          ${panel({
            eyebrow: "SUPPLY",
            body: html`<div class="grid-2f">
              <div>${field({ label: "Tokens per mint", name: "perMint", value: v.perMint, mono: true, attrs: { inputmode: "decimal", autocomplete: "off" } })}<div data-err="perMint"></div></div>
              <div>${field({ label: "Number of mints", name: "mints", value: v.mints, mono: true, attrs: { inputmode: "numeric", autocomplete: "off" } })}<div data-err="mints"></div></div>
            </div><p class="small t-2" data-supply style="margin-top:10px"></p>`,
          })}
          ${panel({
            eyebrow: "PRICE AND TREASURY",
            body: html`<div class="stack">
              <div>${field({ label: "Price per mint", name: "price", value: v.price, mono: true, suffix: "sats", attrs: { inputmode: "numeric", autocomplete: "off" } })}<div data-err="price"></div></div>
              <div data-mask>${field({ label: "Treasury address", name: "treasury", value: v.treasury, mono: true, help: `Prefilled with your fee payer's address. Any ${IS_SIGNET ? "signet" : "Bitcoin"} address works; every mint pays it in the same transaction. Mints paid from this same address send their change here too, and the token page counts that change in “Sent to treasury address”: a separate address keeps that figure to mint payments.`, attrs: { autocomplete: "off", spellcheck: "false" } })}<div data-err="treasury"></div></div>
            </div>`,
          })}
          ${panel({
            eyebrow: "SCHEDULE",
            body: html`<div class="grid-2f">
              <div>${field({ label: "Opens at block", name: "start", value: v.start, mono: true, attrs: { inputmode: "numeric" } })}<p class="caption t-3" data-eta="start"></p><div data-err="start"></div></div>
              <div>${field({ label: "Ends at block", name: "end", value: v.end, mono: true, attrs: { inputmode: "numeric" } })}<p class="caption t-3" data-eta="end"></p><div data-err="end"></div></div>
            </div>`,
          })}
          ${panel({ eyebrow: "PAID BY", body: html`<div class="payers" data-payers></div><div data-fund></div>` })}
          <span data-error-anchor></span>
          <div class="sticky-cta" data-cta></div>
        </form>
        <aside class="stack stack--l preview-sticky" data-preview></aside>
      </div>
    </div>`;
  }

  function shellPow() {
    // Mining needs a complete service-fee rule on this network (MINE_FEE): until then, say so.
    const mineOff = mineFeeReady();
    if (mineOff) {
      root.innerHTML = html`<div class="wl">
        ${pageHead({ eyebrow: "LAUNCH", title: "Launch a mined token", lead: "Mining is not configured on mainnet yet." })}
        ${panel({ eyebrow: "ISSUED BY", body: html`${KIND_SEG()}<p class="caption t-3" style="margin-top:8px">Mining is not configured on mainnet yet. Paid mints are the only launch kind for now.</p>` })}
      </div>`;
      return;
    }
    const powField = (label, key, opts = {}) => html`<div>${field({ label, name: `pow-${key}`, value: pv[key], mono: true, ...opts, attrs: { autocomplete: "off", ...(opts.attrs ?? {}) } })}<div data-err="pow-${key}"></div></div>`;
    root.innerHTML = html`<div class="wl">
      ${pageHead({ eyebrow: "LAUNCH", title: "Launch a mined token", lead: "Write a mined token's terms to Bitcoin. Anyone who finds a proof-of-work solution claims the full reward into a private note. No premine: only claims issue it. Terms can't change after this transaction.", streamer: true })}
      <div class="wl-cols">
        <form class="wl-form" novalidate data-f>
          ${panel({ eyebrow: "ISSUED BY", body: html`${KIND_SEG()}<p class="caption t-3" style="margin-top:8px">Paid mint: anyone buys a fixed amount at your price. Mined: anyone claims a fixed reward with proof of work.</p>` })}
          ${panel({
            eyebrow: "IDENTITY",
            body: html`<div class="grid-2f">
              <div>${field({ label: "Ticker", name: "ticker", value: v.ticker, mono: true, placeholder: "ABC", attrs: { maxlength: 16, autocomplete: "off", autocapitalize: "characters", spellcheck: "false" } })}<div data-err="ticker"></div></div>
              <div>${field({ label: "Decimals", name: "decimals", value: v.decimals, type: "number", attrs: { min: 0, max: 8, inputmode: "numeric" } })}<div data-err="decimals"></div></div>
            </div>`,
          })}
          ${panel({
            eyebrow: "REWARD AND SUPPLY",
            body: html`<div class="grid-2f">${powField("Reward per claim", "reward", { attrs: { inputmode: "decimal" } })}${powField("Max supply", "maxSupply", { attrs: { inputmode: "decimal" } })}</div><p class="small t-2" data-pow-supply style="margin-top:10px"></p>`,
          })}
          ${panel({
            eyebrow: "PACE",
            body: html`<div class="grid-2f">${powField("Solutions per block", "perBlock", { help: "Every valid solution earns the full reward; there is no per-block limit.", attrs: { inputmode: "decimal" } })}${powField("Span", "span", { suffix: "blocks", help: "Difficulty follows the claims of about this many blocks.", attrs: { inputmode: "numeric" } })}</div>`,
          })}
          ${panel({
            eyebrow: "DIFFICULTY",
            body: html`<div class="stack">
              ${powField("Expected launch hashrate", "hashrate", { suffix: "H/s", help: "About 250 H/s per browser thread. The default is a few browsers.", attrs: { inputmode: "numeric" } })}
              <div class="grid-2f">${powField("Initial difficulty", "initial", { attrs: { inputmode: "numeric" } })}${powField("Floor (minimum difficulty)", "floor", { attrs: { inputmode: "numeric" } })}</div>
              <p class="caption t-3" data-pow-diff></p>
            </div>`,
          })}
          ${panel({
            eyebrow: "SCHEDULE",
            body: html`<div class="stack">
              ${powField("Halving every", "halving", { suffix: "blocks", help: "0 = the reward never halves.", attrs: { inputmode: "numeric" } })}
              <div data-pow-start-choice>${segmented(START_OPTIONS, { value: pv.start, name: "pow-start", label: "When mining starts" })}
                <p class="caption t-3" data-start-hint style="margin-top:8px">${START_HINT}</p><div data-err="pow-start"></div></div>
              <div class="grid-2f">
                <div data-pow-after${pv.start === "after" ? "" : " hidden"}>${field({ label: "Start after", name: "pow-startAfter", value: pv.startAfter, mono: true, suffix: "blocks", attrs: { inputmode: "numeric" } })}<div data-err="pow-startAfter"></div></div>
                <div>${field({ label: "Mining ends at block", name: "pow-end", value: pv.end, mono: true, attrs: { inputmode: "numeric" } })}<p class="caption t-3" data-eta="pow-end"></p><div data-err="pow-end"></div></div>
              </div>
              <p class="caption t-3" data-eta="pow-start"></p>
            </div>`,
          })}
          ${panel({
            eyebrow: "SERVICE FEE",
            body: html`${kv([["Claim fee to you", html`<span class="mono">0 sats</span> <span class="caption t-3">fixed by the current rules</span>`], ["Service fee per claim", MINE_FEE ? html`<span class="mono t-btc">${sats(MINE_FEE.platformSats)}</span> <span class="caption t-3">to ${MINE_RECIPIENT}</span>` : "none"]])}
              ${MINE_FEE && BigInt(MINE_FEE.platformSats) > 0n ? html`<p class="caption t-3" style="margin-top:8px">${MINE_TEXT.fee({ sats: MINE_FEE.platformSats, recipient: MINE_RECIPIENT })}</p>` : ""}`,
          })}
          ${panel({ eyebrow: "WHAT TO KNOW", body: html`<ul class="mine-copy">${POW_DISCLOSURES().map((t) => html`<li>${t}</li>`)}</ul>` })}
          ${panel({ eyebrow: "PAID BY", body: html`<div class="payers" data-payers></div><div data-fund></div>` })}
          <span data-error-anchor></span>
          <div class="sticky-cta" data-cta></div>
        </form>
        <aside class="stack stack--l preview-sticky" data-preview></aside>
      </div>
    </div>`;
  }

  function updatePow() {
    const r = buildPowTerms({ ...pv, ticker: v.ticker, decimals: v.decimals }, { height: now(), taken: taken() });
    for (const k of ["ticker", "decimals"]) {
      const slot = root.querySelector(`[data-err=${k}]`);
      if (slot) slot.innerHTML = errorOf(r, k);
    }
    for (const k of ["reward", "maxSupply", "perBlock", "span", "hashrate", "initial", "floor", "halving", "start", "startAfter", "end"]) {
      const slot = root.querySelector(`[data-err=pow-${k}]`);
      if (slot) slot.innerHTML = errorOf(r, k);
    }
    if (r.ticker && !r.errors.ticker) root.querySelector("[data-err=ticker]").innerHTML = html`<p class="caption ok-mark">${icon("check", { size: 14 })}${r.ticker} is available</p>`;
    const sup = root.querySelector("[data-pow-supply]");
    if (sup) {
      sup.innerHTML = r.reward !== null && r.maxSupply !== null
        ? html`${int(r.maxSupply / r.reward)} claims of <span class="mono">${units(r.reward, r.divisibility)}</span> ${r.ticker || "tokens"}${r.blocksToMineOut ? html` · about ${plural(r.blocksToMineOut, "block")} (${eta(r.blocksToMineOut)}) at the target pace` : ""}${r.leftover > 0n ? html`<br><span class="t-warn">Max supply is not a multiple of the reward: the last <span class="mono">${units(r.leftover, r.divisibility)}</span> can never be claimed.</span>` : ""}`
        : "";
    }
    const diff = root.querySelector("[data-pow-diff]");
    if (diff) {
      diff.textContent = r.suggested !== null
        ? `Suggested initial difficulty ${int(r.suggested)} for ${int(r.hashrate)} H/s and ${r.targetPerSpan} solutions per ${r.span} blocks; suggested floor ${int(suggestFloor(r.initialDifficulty ?? r.suggested))} (initial / 16, at least ${int(MIN_DIFFICULTY)}). Leave a field blank to use the suggestion. A low floor lets a fast miner claim many rewards after a quiet period, and the explorer flags it.`
        : "";
    }
    for (const [name, key] of [["initial", "suggested"], ["floor", "suggestedFloor"]]) {
      const input = root.querySelector(`[name=pow-${name}]`);
      if (input && r[key] !== null) input.placeholder = String(r[key]);
    }
    const h = now();
    const st = root.querySelector("[data-eta=pow-start]");
    if (st) st.textContent = startText(r, h);
    const after = root.querySelector("[data-pow-after]");
    if (after) after.hidden = r.startMode !== "after";
    const en = root.querySelector("[data-eta=pow-end]");
    if (en) {
      const end = Number(pv.end);
      en.textContent = end
        ? [h !== null && end > h ? `In ${int(end - h)} blocks, ${eta(end - h)}.` : "", Number.isInteger(end) && end > 0 ? confirmByText(end) : ""].filter(Boolean).join(" ")
        : "0 = no end";
    }
    root.querySelector("[data-payers]").innerHTML = payerCards(s, "launch-payer");
    const empty = s.payerPref !== "unisat" && s.btc?.sats === 0;
    root.querySelector("[data-fund]").innerHTML =
      s.payerPref === "unisat"
        ? ""
        : html`<div class="inline-actions" style="margin-top:12px">${button({ label: "Add BTC", kind: "secondary", size: "sm", icon: "plus", action: "add-btc" })}</div>
          <p class="caption ${empty ? "t-warn" : "t-3"}" style="margin-top:8px">${empty ? `Your built-in key has no BTC. Add ${BTC_WORD} before you launch.` : `The built-in key pays the launch fee from its own ${BTC_WORD}.`}</p>`;
    const envBytes = r.envelope?.length ?? null;
    const feeSats = feeRate && envBytes ? feeRate * (envBytes + CARRIER_OVERHEAD_VB) : null;
    const blocked = chainWritesBlocked();
    const payerMissing = s.payerPref === "unisat" && !s.unisat ? "Connect Unisat in Settings, or pick the built-in key." : empty ? `Add ${BTC_WORD} to your built-in key first.` : null;
    const reason = blocked ?? payerMissing ?? (r.errors.form ? r.errors.form : r.terms ? null : "Fix the fields marked above.");
    root.querySelector("[data-cta]").innerHTML = button({ label: `Launch mined token · ${feeSats ? `~${sats(feeSats)}` : "network fee"}`, kind: "btc", size: "lg", type: "submit", icon: "launch", disabled: Boolean(reason) || busy, reason, block: true });
    root.querySelector("[data-preview]").innerHTML = html`${panel({
      eyebrow: "PREVIEW · MINED TOKEN",
      cls: "lcard",
      body: html`<div class="lcard-top">${sigil(r.ticker || "?", { size: 40 })}<span class="ticker">${r.ticker || "TICKER"}</span>${statusPill("upcoming", "Mining soon")}</div>
        <div class="lcard-meta">${r.mineStart !== null ? `Mining from block ${int(r.mineStart)}` : r.startMode === "now" ? "Mining starts at the launch block" : "Mining starts after the launch"}</div>
        ${kv([
          ["Reward", r.reward !== null ? html`<span class="mono">${units(r.reward, r.divisibility)}</span>` : "—"],
          ["Max supply", r.maxSupply !== null ? html`<span class="mono">${units(r.maxSupply, r.divisibility)}</span>` : "—"],
          ["Per block", r.targetPerSpan ? html`<span class="mono">${(r.targetPerSpan / r.span).toFixed(2)}</span>` : "—"],
          ["Difficulty", r.initialDifficulty !== null ? html`<span class="mono">${int(r.initialDifficulty)} · floor ${r.minDifficulty !== null ? int(r.minDifficulty) : "—"}</span>` : "—"],
        ], { compact: true })}
        <p class="caption t-3">The sigil comes from the asset id, which Bitcoin assigns from the launch's block and position, so the real one differs from this preview.</p>`,
    })}
    ${panel({
      eyebrow: "DEPLOY_POW ENVELOPE",
      title: envBytes ? `${fmtBytes(envBytes)} on Bitcoin` : "Fill in the terms",
      body: r.envelope ? html`${hexmap(r.envelope, { carrierVsize: envBytes + CARRIER_OVERHEAD_VB, compact: true })}<p class="caption t-3" style="margin-top:8px">Estimated fee ${feeSats ? sats(feeSats) : "—"} at ${feeRate ?? "—"} sat/vB (mempool.space).</p>` : html`<p class="small t-3">The exact bytes appear here as you type.</p>`,
    })}`;
    return r;
  }

  function successPow(entry, r) {
    done = entry;
    root.innerHTML = html`<div class="wl"><div class="wl-form">
      ${pageHead({ eyebrow: "LAUNCHED", title: `${r.ticker} is on its way to Bitcoin`, streamer: false })}
      ${callout(html`<b>In the mempool.</b> The token page goes live once a block includes the launch and the indexer accepts it. ${opensText(r)} First valid launch of a ticker wins.`, "proof")}
      <div class="inline-actions">${button({ label: "View receipt", href: `/tx/${entry.txid}`, kind: "ghost" })}${button({ label: "Open token page", href: `/t/${r.ticker}`, kind: "neutral" })}${button({ label: "Launch another", kind: "ghost", action: "again" })}</div>
    </div></div>`;
    root.querySelector("[data-action=again]").addEventListener("click", () => {
      done = null;
      v.ticker = "";
      shell();
      update();
    });
  }

  async function reviewPow(r) {
    const payerKind = s.payerPref;
    const sheet = openSheet({
      title: `Launch ${r.ticker}`,
      eyebrow: "REVIEW",
      body: html`<div class="stack">
        ${disclosure({
          op: "Launch",
          publicRows: [
            ["Ticker", r.ticker],
            ["Issued by", "proof-of-work claims only"],
            ["Reward per claim", html`<span class="mono">${units(r.reward, r.divisibility)}</span>`],
            ["Max supply", html`<span class="mono">${units(r.maxSupply, r.divisibility)}</span>`],
            ["Pace", `${r.targetPerSpan} solutions per ${r.span} blocks`],
            ["Difficulty", html`<span class="mono">${int(r.initialDifficulty)} · floor ${int(r.minDifficulty)}</span>`],
            ["Halving", r.halvingInterval ? `every ${int(r.halvingInterval)} blocks` : "none"],
            ["Start", r.startMode === "after" ? `block ${heightText(r.startHeight)}, ${plural(r.startAfter, "block")} after the next block` : "now: the launch block itself"],
            ["End", r.endHeight ? heightText(r.endHeight) : "no end"],
            ["Deployer", btcHTML(payerAddress(), { copy: false })],
          ],
          hidden: [],
          note: "A launch is public by design: everyone must be able to check the terms.",
        })}
        <ul class="mine-copy">${[START_HINT, ...POW_DISCLOSURES()].map((t) => html`<li>${t}</li>`)}</ul>
        ${r.confirmBy !== null ? callout(confirmByText(r.endHeight), "warn") : ""}
        ${callout("Tickers are first come, first served. Terms can't change after this transaction.", "warn")}
        ${button({ label: "Launch mined token", kind: "btc", size: "lg", block: true, action: "go", icon: "launch" })}
      </div>`,
    });
    sheet.el.querySelector("[data-action=go]").addEventListener("click", async () => {
      sheet.close();
      busy = true;
      const pv2 = provingSheet({ title: `Launching ${r.ticker}`, eyebrow: "WRITING TO BITCOIN", steps: LAUNCH_STEPS(payerKind) });
      try {
        const entry = await s.deployPow(r.terms, { onStep: pv2.onStep });
        pv2.done({ body: callout(`Launch broadcast. ${opensText(r)}`, "proof") });
        successPow(entry, r);
      } catch (err) {
        pv2.fail(err);
      } finally {
        busy = false;
        update();
      }
    });
  }

  function update() {
    if (done) return;
    if (kind === "pow") return updatePow();
    const r = buildTerms(v, { height: now(), taken: taken() });
    for (const k of ["ticker", "decimals", "perMint", "mints", "price", "treasury", "start", "end"]) {
      const slot = root.querySelector(`[data-err=${k}]`);
      if (slot) slot.innerHTML = errorOf(r, k);
    }
    const tickerOk = r.ticker && !r.errors.ticker;
    if (tickerOk) root.querySelector("[data-err=ticker]").innerHTML = html`<p class="caption ok-mark">${icon("check", { size: 14 })}${r.ticker} is available</p>`;
    root.querySelector("[data-supply]").innerHTML =
      r.supply !== null ? html`Total supply <span class="mono">${units(r.supply, r.divisibility)}</span> ${r.ticker || "tokens"} · max raise <span class="mono t-btc">${sats(r.raise ?? 0n)}</span>` : "";
    const h = now();
    for (const k of ["start", "end"]) {
      const n = Number(v[k] || 0);
      const el = root.querySelector(`[data-eta=${k}]`);
      el.textContent = !n ? (k === "start" ? "0 = opens with the launch" : "0 = no end") : h !== null && n > h ? `In ${int(n - h)} blocks, ${eta(n - h)}` : h !== null ? "Already passed" : "";
    }
    root.querySelector("[data-payers]").innerHTML = payerCards(s, "launch-payer");
    const empty = s.payerPref !== "unisat" && s.btc?.sats === 0;
    root.querySelector("[data-fund]").innerHTML =
      s.payerPref === "unisat"
        ? ""
        : html`<div class="inline-actions" style="margin-top:12px">${button({ label: "Add BTC", kind: "secondary", size: "sm", icon: "plus", action: "add-btc" })}</div>
          <p class="caption ${empty ? "t-warn" : "t-3"}" style="margin-top:8px">${empty ? `Your built-in key has no BTC. Add ${BTC_WORD} before you launch.` : `The built-in key pays the launch fee from its own ${BTC_WORD}.`}</p>`;
    const envBytes = r.envelope?.length ?? null;
    const feeSats = feeRate && envBytes ? feeRate * (envBytes + CARRIER_OVERHEAD_VB) : null;
    const blocked = chainWritesBlocked();
    const payerMissing = s.payerPref === "unisat" && !s.unisat ? "Connect Unisat in Settings, or pick the built-in key." : empty ? `Add ${BTC_WORD} to your built-in key first.` : null;
    const reason = blocked ?? payerMissing ?? (r.errors.form ? r.errors.form : r.terms ? null : "Fix the fields marked above.");
    root.querySelector("[data-cta]").innerHTML = button({ label: `Launch token · ${feeSats ? `~${sats(feeSats)}` : "network fee"}`, kind: "btc", size: "lg", type: "submit", icon: "launch", disabled: Boolean(reason) || busy, reason, block: true });
    root.querySelector("[data-preview]").innerHTML = html`${panel({
      eyebrow: "PREVIEW · MINT BOARD CARD",
      cls: "lcard",
      body: html`<div class="lcard-top">${sigil(r.ticker || "?", { size: 40 })}<span class="ticker">${r.ticker || "TICKER"}</span>${statusPill(Number(v.start) > (h ?? 0) ? "upcoming" : "open")}</div>
        <div class="lcard-meta">Launches in the next block</div>
        ${progress({ value: 0, max: r.errors.mints ? null : r.mintCap })}
        ${kv([["Per mint", r.mintAmount !== null ? html`<span class="mono">${units(r.mintAmount, r.divisibility)}</span>` : "—"], ["Price", html`<span class="mono t-btc">${r.errors.price ? "—" : sats(r.priceSats)}</span>`], ["Supply", r.supply !== null ? html`<span class="mono">${units(r.supply, r.divisibility)}</span>` : "—"]], { compact: true })}
        <p class="caption t-3">The sigil comes from the asset id, which Bitcoin assigns from the launch's block and position, so the real one differs from this preview.</p>`,
    })}
    ${panel({
      eyebrow: "DEPLOY ENVELOPE",
      title: envBytes ? `${fmtBytes(envBytes)} on Bitcoin` : "Fill in the terms",
      body: r.envelope ? html`${hexmap(r.envelope, { carrierVsize: envBytes + CARRIER_OVERHEAD_VB, compact: true })}<p class="caption t-3" style="margin-top:8px">Estimated fee ${feeSats ? sats(feeSats) : "—"} at ${feeRate ?? "—"} sat/vB (mempool.space).</p>` : html`<p class="small t-3">The exact bytes appear here as you type.</p>`,
    })}`;
    return r;
  }

  function success(entry, terms) {
    done = entry;
    const url = `${location.origin}/t/${terms.ticker}`;
    const text = shareText(terms, url); // same wording as the launch page
    root.innerHTML = html`<div class="wl"><div class="wl-form">
      ${pageHead({ eyebrow: "LAUNCHED", title: `${terms.ticker} is on its way to Bitcoin`, streamer: false })}
      ${callout(html`<b>In the mempool.</b> The launch page goes live once a block includes it and the indexer accepts it. First valid launch of a ticker wins.`, "proof")}
      ${panel({
        certified: true,
        eyebrow: "YOUR LAUNCH PAGE",
        title: `Share /t/${terms.ticker} with your community`,
        body: html`<div class="stack">
          <div class="linkbox">${url}</div>
          <div class="inline-actions">
            ${button({ label: "Copy link", kind: "secondary", size: "sm", icon: "link", attrs: { "data-copy": url } })}
            ${button({ label: "Copy announcement", kind: "ghost", size: "sm", icon: "copy", action: "copy-text" })}
            ${button({ label: "Share on X", href: xIntentUrl(text), kind: "ghost", size: "sm", iconRight: "external" })}
            ${button({ label: "Open launch page", href: `/t/${terms.ticker}`, kind: "neutral", size: "sm" })}
          </div>
          <p class="caption t-3">The share text has no txid: a txid would tie your social account to the Bitcoin address that paid the launch.</p>
          <p class="caption t-3">The announcement card (PNG) is in the launch kit on <a href="/t/${terms.ticker}#kit" data-link>your launch page</a>. Its sigil comes from the token id, which exists only once a block includes the launch, so the card appears there after confirmation.</p>
        </div>`,
      })}
      <div class="inline-actions">${button({ label: "View receipt", href: `/tx/${entry.txid}`, kind: "ghost" })}${button({ label: "Launch another", kind: "ghost", action: "again" })}</div>
    </div></div>`;
    root.querySelector("[data-action=copy-text]").addEventListener("click", () => copyText(text).then((ok) => ok && toast({ kind: "success", title: "Announcement copied.", timeout: 2500 })));
    root.querySelector("[data-action=again]").addEventListener("click", () => {
      done = null;
      v.ticker = "";
      shell();
      update();
    });
  }

  async function review(r) {
    const payerKind = s.payerPref;
    const sheet = openSheet({
      title: `Launch ${r.ticker}`,
      eyebrow: "REVIEW",
      body: html`<div class="stack">
        ${disclosure({
          op: "Launch",
          publicRows: [
            ["Ticker", r.ticker],
            ["Per mint × mints", html`<span class="mono">${units(r.mintAmount, r.divisibility)} × ${int(r.mintCap)}</span>`],
            ["Supply", html`<span class="mono">${units(r.supply, r.divisibility)}</span>`],
            ["Price", html`<span class="mono t-btc">${sats(r.priceSats)}</span>`],
            ["Treasury", btcHTML(r.terms.treasury, { copy: false })],
            ["Schedule", `${r.terms.startHeight ? heightText(r.terms.startHeight) : "now"} → ${r.terms.endHeight ? heightText(r.terms.endHeight) : "no end"}`],
            ["Deployer", btcHTML(payerAddress(), { copy: false })],
          ],
          hidden: [],
          note: "A launch is public by design: everyone must be able to check the terms.",
        })}
        ${callout("Tickers are first come, first served. Terms can't change after this transaction.", "warn")}
        ${button({ label: "Launch token", kind: "btc", size: "lg", block: true, action: "go", icon: "launch" })}
      </div>`,
    });
    sheet.el.querySelector("[data-action=go]").addEventListener("click", async () => {
      sheet.close();
      busy = true;
      const pv = provingSheet({ title: `Launching ${r.ticker}`, eyebrow: "WRITING TO BITCOIN", steps: LAUNCH_STEPS(payerKind) });
      try {
        const entry = await s.deploy(r.terms, { onStep: pv.onStep });
        pv.done({ body: callout("Launch broadcast. Share your launch page once it's in a block.", "proof") });
        success(entry, r.terms);
      } catch (err) {
        pv.fail(err);
      } finally {
        busy = false;
        update();
      }
    });
  }

  shell();
  update();
  const f = () => root.querySelector("[data-f]");
  const onInput = (e) => {
    const n = e.target.name;
    if (typeof n === "string" && n.startsWith("pow-") && n.slice(4) in pv) {
      pv[n.slice(4)] = e.target.value;
      update();
    } else if (n in v) {
      v[n] = n === "ticker" ? e.target.value.toUpperCase() : e.target.value;
      if (n === "ticker" && e.target.value !== v.ticker) e.target.value = v.ticker;
      update();
    } else if (n === "launch-payer") {
      const before = payerAddress();
      s.payerPref = e.target.value;
      if (!v.treasury || v.treasury === before) {
        v.treasury = payerAddress();
        const t = f()?.querySelector("[name=treasury]");
        if (t) t.value = v.treasury;
      }
      update();
    }
  };
  const onClick = (e) => e.target.closest("[data-action=add-btc]") && openDeposit(s);
  const onSubmit = (e) => {
    if (!e.target.matches("[data-f]")) return;
    e.preventDefault();
    const r = update();
    if (r?.terms && !busy) (r.kind === "pow" ? reviewPow : review)(r);
  };
  const onKind = (e) => {
    if (e.detail?.name === "pow-start" && (e.detail.value === "now" || e.detail.value === "after") && !done) {
      pv.start = e.detail.value;
      update();
      return;
    }
    if (e.detail?.name !== "launch-kind" || (e.detail.value !== "mint" && e.detail.value !== "pow") || e.detail.value === kind || done) return;
    kind = e.detail.value;
    shell();
    update();
  };
  root.addEventListener("seg-change", onKind);
  root.addEventListener("input", onInput);
  root.addEventListener("change", onInput);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("click", onClick);
  api.esplora.feeRate().then((r) => ((feeRate = r), update())).catch(() => {});
  const offLive = liveSession(s, (type) => (type === "sync" || type === "payer" || type === "btc") && update());
  const offStreamer = wireStreamer(root, () => (done ? null : update()));
  return () => {
    root.removeEventListener("input", onInput);
    root.removeEventListener("change", onInput);
    root.removeEventListener("submit", onSubmit);
    root.removeEventListener("click", onClick);
    root.removeEventListener("seg-change", onKind);
    offLive();
    offStreamer();
  };
}

export function render(root, params, query) {
  return withWallet(root, (s) => launchView(root, s, query));
}

// Shared pieces of the wallet views (/app/*): the gate that every wallet page goes
// through (onboarding, lock screen, migration), streamer-mode masking, the page
// head, the proving sheet and the view-specific styles.
//
// Streamer mode masks every amount and address on every wallet screen, in toasts
// too. Views must render amounts and addresses through amountHTML / zpHTML /
// btcHTML / satsHTML / amountText, never with the raw formatters.
import { html, raw, toNode } from "../ui/dom.js";
import { icon, glyphSVG } from "../ui/icons.js";
import { units, sats, hash, addr, ms as fmtMs, short, int, eta } from "../ui/format.js";
import { redact } from "../ui/redact.js";
import { button, field, stepper, panel, tag } from "../ui/components.js";
import { openSheet, closeAllSheets } from "../ui/sheet.js";
import { toast } from "../ui/toast.js";
import { sealPill } from "../ui/seal.js";
import { navigate } from "../router.js";
import { ADDRESS_HRP, BRAND, IS_SIGNET, NOT_LAUNCHED, MAINNET_NOT_LAUNCHED_TEXT } from "../config.js";
import { KDF, KDF_MEMORY_MIB } from "../keystore.js";
import { watchState } from "../api.js";
import {
  currentSession, hasVault, hasLegacy, unlock, migrateWallet, forgetWallet, streamerMode, setStreamerMode, onStreamerChange,
  onSessionChange, ROOT_MISMATCH, batchPhase, relayStranded, relayStuck,
} from "../session.js";
import { MIN_COVER_K, missedText, relayOpen } from "../relay.js";
import { strengthMeter } from "../ui/meter.js";
import { passwordStrength, MIN_PASSWORD } from "../keystore.js";

/* ---------- styles (view-specific; the integrator may move them into styles/pages.css) ---------- */

const APP_CSS = `
.wl { display: flex; flex-direction: column; gap: 24px; }
@media (min-width: 768px) { .wl { gap: 32px; } }
.wl-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: 12px 16px; }
.wl-head .lead { margin-top: 6px; font-size: 15px; line-height: 22px; }
.wl-head-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.wl-cols { display: grid; gap: 24px; grid-template-columns: minmax(0, 1fr); }
@media (min-width: 1024px) { .wl-cols { grid-template-columns: minmax(0, 1fr) minmax(0, 300px); align-items: start; } }
.wl-form { display: flex; flex-direction: column; gap: 20px; max-width: var(--max-form); }
.wl-center { max-width: 480px; margin: 24px auto; width: 100%; }
@media (min-width: 768px) { .wl-center { margin: 48px auto; } }
.lockpanel { display: flex; flex-direction: column; gap: 16px; align-items: stretch; padding: 28px 24px; }
.lockpanel .glyph { width: 40px; height: 40px; }
.lockpanel .input { height: 48px; font-size: 16px; }
.lock-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.onboard { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr)); }
.onboard .panel { display: flex; flex-direction: column; gap: 12px; }
.onboard .panel p { color: var(--text-2); }
.steps-top { display: flex; gap: 6px; }
.steps-top span { flex: 1; height: 3px; border-radius: 2px; background: var(--line); }
.steps-top span.is-on { background: var(--text); }
.phrase-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; counter-reset: w; user-select: none; -webkit-user-select: none; }
@media (min-width: 560px) { .phrase-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
.pw { display: flex; align-items: baseline; gap: 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-s); background: var(--surface-inset); font: 500 14px/20px var(--font-mono); }
.pw i { font-style: normal; color: var(--text-3); font-size: 11px; min-width: 2ch; text-align: right; }
.phrase-wrap { position: relative; }
.phrase-wrap.is-hidden .pw b { filter: blur(7px); opacity: .7; }
.phrase-hold { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.phrase-wrap:not(.is-hidden) .phrase-hold { display: none; }
.phrase-hold .btn { box-shadow: var(--shadow-pop); touch-action: none; }
.confirm-words { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr)); }
.callout { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; border-radius: var(--radius); border: 1px solid var(--line); background: var(--surface-inset); font-size: 13px; line-height: 19px; color: var(--text-2); }
.callout svg { flex: none; margin-top: 1px; }
.callout--warn { border-color: var(--warn-line); background: var(--warn-wash); color: var(--text); }
.callout--warn svg { color: var(--warn); }
.callout--danger { border-color: var(--danger-line); background: var(--danger-wash); color: var(--text); }
.callout--danger svg { color: var(--danger); }
.callout--proof { border-color: var(--proof-line); background: var(--proof-wash); }
.callout--proof svg { color: var(--proof-text); }
.callout b { font-weight: 600; color: var(--text); }
.bal-cell { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.bal-pending { color: var(--warn); font-size: 12px; line-height: 16px; }
.tok { display: inline-flex; align-items: center; gap: 10px; }
.addr-card { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); align-items: center; }
@media (min-width: 640px) { .addr-card { grid-template-columns: minmax(0, 1fr) auto; } }
.addr-card .addr { font-size: 14px; line-height: 22px; }
.qr-tile { display: inline-block; padding: 12px; background: var(--qr-tile); border-radius: var(--radius); line-height: 0; }
.qr-tile svg path { fill: var(--qr-ink); }
.quick { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.quick .btn { width: 100%; }
.tier { display: inline-flex; align-items: center; gap: 6px; }
.reasons { margin: 6px 0 0; padding-left: 18px; color: var(--text-2); font-size: 13px; line-height: 19px; }
.reasons li + li { margin-top: 2px; }
.acts { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface-1); overflow: hidden; }
.act { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; gap: 4px 12px; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--line); }
.act:last-child { border-bottom: 0; }
.act-main { display: flex; flex-direction: column; gap: 2px; }
.act-title { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px; font-size: 14px; line-height: 20px; }
.act-sub { font-size: 12px; line-height: 16px; color: var(--text-3); display: flex; flex-wrap: wrap; gap: 4px 10px; }
.act-side { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.act-extra { grid-column: 2 / -1; display: flex; flex-direction: column; gap: 8px; }
.act .proofprint, .act .act-ic { width: 24px; height: 24px; color: var(--text-3); }
.filters { display: flex; flex-wrap: wrap; gap: 6px; }
.chipbtn { height: 32px; padding: 0 12px; border-radius: var(--radius-pill); border: 1px solid var(--line-strong); color: var(--text-2); font-size: 13px; }
.chipbtn[aria-pressed="true"] { background: var(--inverse); color: var(--inverse-ink); border-color: var(--inverse); }
.payers { display: grid; gap: 10px; }
.mode-row { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.mode-row .seg-wrap { max-width: 100%; }
.sum-line { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; color: var(--text-2); }
.sum-line .mono { color: var(--text); }
.sticky-cta { position: sticky; bottom: calc(var(--tabbar-space) + 8px); z-index: 2; display: flex; flex-direction: column; gap: 6px; padding-top: 8px; background: linear-gradient(to bottom, transparent, var(--bg) 12px); }
@media (min-width: 768px) { .sticky-cta { position: static; background: none; padding: 0; } }
.mint-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr)); }
.lcard { display: flex; flex-direction: column; gap: 14px; }
.lcard-top { display: flex; align-items: center; gap: 12px; }
.lcard-top .ticker { font-size: 20px; line-height: 24px; }
.lcard-top .spill { margin-left: auto; }
.lcard-meta { font: 400 12px/16px var(--font-mono); color: var(--text-3); }
.lcard.is-picked { border-color: var(--text); box-shadow: inset 0 0 0 1px var(--text); }
.preview-sticky { position: static; }
@media (min-width: 1024px) { .preview-sticky { position: sticky; top: calc(var(--h-top) + var(--h-ledger) + 24px); } }
.grid-2f { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); }
.inline-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.seg-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px 16px; }
.danger-zone { border-color: var(--danger-line); }
.netlist { display: flex; flex-direction: column; gap: 6px; font: 400 13px/18px var(--font-mono); }
.netlist li { display: flex; justify-content: space-between; gap: 12px; }
.req-out { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr); align-items: start; }
@media (min-width: 640px) { .req-out { grid-template-columns: minmax(0, 1fr) auto; } }
.linkbox { font: 400 12px/18px var(--font-mono); overflow-wrap: anywhere; padding: 10px 12px; border-radius: var(--radius-btn); background: var(--surface-inset); border: 1px solid var(--line); }
.proving-well { font: 400 11px/16px var(--font-mono); color: var(--text-3); overflow-wrap: anywhere; padding: 10px 12px; border-radius: var(--radius-btn); background: var(--surface-inset); border: 1px solid var(--line); max-height: 96px; overflow: auto; }
.proving-bar { height: 2px; background: var(--line); overflow: hidden; border-radius: 2px; }
.proving-bar span { display: block; width: 30%; height: 100%; background: var(--text-2); animation: pbar 1.2s var(--ease) infinite; }
@keyframes pbar { from { transform: translateX(-100%); } to { transform: translateX(340%); } }
.streamer-btn[aria-pressed="true"] { color: var(--warn); }
html[data-streamer="on"] [data-mask] input, html[data-streamer="on"] [data-mask] textarea, html[data-streamer="on"] [data-mask] .linkbox { filter: blur(6px); }
.ok-mark { display: inline-flex; align-items: center; gap: 6px; color: var(--proof-text); font-size: 13px; }
.bad-mark { display: inline-flex; align-items: center; gap: 6px; color: var(--danger); font-size: 13px; }
`;

let styled = false;
export function ensureStyles() {
  if (styled || typeof document === "undefined") return;
  styled = true;
  const el = document.createElement("style");
  el.id = "murkle-app-views";
  el.textContent = APP_CSS;
  document.head.append(el);
}

/* ---------- masking (streamer mode) ---------- */

export const masked = () => streamerMode();

/** Token amount: real value, or a redaction bar in streamer mode. */
export function amountHTML(value, div = 0, ticker = null, { cls = "" } = {}) {
  if (masked()) return html`${redact("amount")}${ticker ? html` <span class="ticker">${ticker}</span>` : ""}`;
  return html`<span class="mono ${cls}">${units(value, div)}</span>${ticker ? html` <span class="ticker">${ticker}</span>` : ""}`;
}

/** Plain text for toasts and aria labels: never leaks an amount in streamer mode. */
export function amountText(value, div = 0, ticker = "") {
  return masked() ? `hidden amount${ticker ? " of " + ticker : ""}` : `${units(value, div)}${ticker ? " " + ticker : ""}`;
}

export const satsHTML = (n) => (masked() ? redact("amount") : html`<span class="mono">${sats(n)}</span>`);

/** Shielded address, chunked, or "mrk1…" plus a bar in streamer mode. */
export function zpHTML(address, { copy = true } = {}) {
  if (masked()) return html`<span class="mono">${ADDRESS_HRP}1…</span> ${redact("address")}`;
  return addr(address, { copy });
}

/** Bitcoin address, short with a copy button, or a bar in streamer mode. */
export function btcHTML(address, { copy = true } = {}) {
  if (!address) return raw("—");
  if (masked()) return redact("address");
  return hash(address, { head: 8, tail: 6, copy, label: "Copy address" });
}

export const btcText = (address) => (masked() ? "your Bitcoin address" : short(address, 8, 6));

const BTC_ADDR = /\b(?:tb1|bc1|bcrt1)[02-9ac-hj-np-z]{8,}\b/gi;
const ZP_ADDR = new RegExp(`\\b${ADDRESS_HRP}1[02-9ac-hj-np-z]{8,}\\b`, "gi");

/** Streamer mode: error and step text without addresses or amounts. */
export function maskError(text) {
  return String(text ?? "")
    .replace(BTC_ADDR, "your Bitcoin address")
    .replace(ZP_ADDR, `a ${BRAND} address`)
    .replace(/\d[\d,.]*\s*[<>]\s*\d[\d,.]*/g, "hidden")
    .replace(/\d[\d,.]*(?=\s*sats?\b(?!\/))/g, "hidden")
    .replace(/\b(have|need)\s+\d[\d,.]*/g, "$1 hidden");
}

/** Step details and failures as shown: masked in streamer mode, null kept. */
export const maskText = (text) => (text == null || !masked() ? text : maskError(text));

/* ---------- page head and streamer toggle ---------- */

export function streamerButton() {
  const on = masked();
  return html`<button type="button" class="btn btn--ghost btn--sm streamer-btn" data-action="streamer" aria-pressed="${on ? "true" : "false"}" data-tip="${on ? "Streamer mode is on: amounts and addresses are hidden on every screen." : "Hide every amount and address, for streaming or screen sharing."}">${icon(on ? "eye-off" : "eye", { size: 16 })}<span>${on ? "Amounts hidden" : "Hide amounts"}</span></button>`;
}

export function pageHead({ eyebrow = null, title, lead = null, actions = null, streamer = true }) {
  return html`<header class="wl-head">
    <div>${eyebrow ? html`<div class="eyebrow">${eyebrow}</div>` : ""}<h1 class="h1-app">${title}</h1>${lead ? html`<p class="lead">${lead}</p>` : ""}</div>
    <div class="wl-head-actions">${actions ?? ""}${streamer ? streamerButton() : ""}</div>
  </header>`;
}

/**
 * Wires [data-action=streamer] inside root and re-renders on any streamer change.
 * Returns an unsubscribe function.
 */
export function wireStreamer(root, rerender) {
  const onClick = (e) => {
    if (e.target.closest("[data-action=streamer]")) setStreamerMode(!masked());
  };
  root.addEventListener("click", onClick);
  const off = onStreamerChange(() => {
    for (const b of root.querySelectorAll(".streamer-btn")) b.replaceWith(toNode(streamerButton()));
    rerender();
  });
  return () => {
    root.removeEventListener("click", onClick);
    off();
  };
}

/** Re-renders the current route in place (after unlock, lock or migration). */
export const reroute = () => navigate(location.pathname + location.search + location.hash, { replace: true });

/* ---------- password fields ---------- */

export function passwordFields({ confirm = true, label = "Password", autofocus = true } = {}) {
  return html`<div class="stack">
    ${field({ label, name: "password", type: "password", attrs: { autocomplete: "new-password", minlength: MIN_PASSWORD, required: true, autofocus: autofocus ? true : null } })}
    <div data-strength>${strengthMeter(0, `At least ${MIN_PASSWORD} characters.`)}</div>
    ${confirm ? field({ label: "Confirm password", name: "confirm", type: "password", attrs: { autocomplete: "new-password", required: true } }) : ""}
  </div>`;
}

/** Live strength meter; returns a validator () => password | throws. */
export function wirePasswordFields(scope, { confirm = true } = {}) {
  const pw = scope.querySelector("[name=password]");
  const cf = scope.querySelector("[name=confirm]");
  const meter = scope.querySelector("[data-strength]");
  pw.addEventListener("input", () => {
    const s = passwordStrength(pw.value);
    meter.innerHTML = strengthMeter(pw.value ? s.score : 0, pw.value ? `${s.label}. ${s.hint}` : `At least ${MIN_PASSWORD} characters.`);
  });
  return () => {
    if (pw.value.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters for the password.`);
    if (confirm && cf.value !== pw.value) throw new Error("The two passwords don't match. Type them again.");
    return pw.value;
  };
}

export const KDF_COPY = `Your recovery phrase is encrypted on this device with XChaCha20-Poly1305. The key comes from your password via ${KDF.name} (N = ${KDF.N.toLocaleString("en-US")}, r = ${KDF.r}, p = ${KDF.p}, about ${KDF_MEMORY_MIB} MiB), so guessing is slow. We never see either.`;

export function callout(text, tone = "info", ic = null) {
  const glyph = ic ?? (tone === "warn" || tone === "danger" ? "warn" : tone === "proof" ? "check" : "info");
  return html`<div class="callout callout--${tone}">${icon(glyph, { size: 16 })}<div>${text}</div></div>`;
}

export function formError(form, message) {
  let el = form.querySelector(".form-error");
  if (!message) return el?.remove();
  if (!el) {
    el = toNode(html`<p class="form-error field-msg field-msg--error caption" role="alert"></p>`);
    const anchor = form.querySelector("[data-error-anchor]") ?? form.lastElementChild;
    anchor.before(el);
  }
  el.innerHTML = html`${icon("warn", { size: 14 })}${message}`;
}

/* ---------- the gate: onboarding, lock screen, migration ---------- */

function onboarding(root) {
  root.innerHTML = html`<div class="wl">
    ${pageHead({ eyebrow: "WALLET · KEYS STAY ON THIS DEVICE", title: `Your ${BRAND} wallet`, lead: "Private balances on Bitcoin. Your keys are made in this browser and encrypted with your password. No sign-up, no email, no server account.", streamer: false })}
    <div class="onboard">
      ${panel({
        certified: true,
        body: html`${icon("plus")}<h2 class="h3">Create a new wallet</h2><p class="small">24 recovery words, made in this browser and encrypted with a password you choose. About a minute.</p>${button({ label: "Create new wallet", href: "/app/create", kind: "neutral", iconRight: "arrow-right" })}`,
      })}
      ${panel({
        body: html`${icon("unlock")}<h2 class="h3">I have a phrase</h2><p class="small">Restore a wallet from its 24 words. Your notes are found again by scanning the pool in this browser.</p>${button({ label: "Restore from 24 words", href: "/app/import", kind: "secondary" })}`,
      })}
    </div>
    ${IS_SIGNET
      ? callout(html`Signet test network: tokens here have no value. The wallet never sends your keys, balance or notes anywhere. It downloads the whole public pool and finds your notes locally.`, "info")
      : callout(html`${NOT_LAUNCHED ? `${MAINNET_NOT_LAUNCHED_TEXT} ` : ""}Bitcoin mainnet: experimental software, and tokens can be lost to bugs. The wallet never sends your keys, balance or notes anywhere. It downloads the whole public pool and finds your notes locally.`, NOT_LAUNCHED ? "warn" : "info")}
  </div>`;
}

function lockScreen(root, onDone) {
  const render = () => {
    root.innerHTML = html`<div class="wl-center">
      ${panel({
        certified: true,
        cls: "lockpanel",
        body: html`<div class="lock-top">${glyphSVG({ size: 40 })}${streamerButton()}</div>
          <div><div class="eyebrow">${icon("lock", { size: 12 })} Wallet locked</div><h1 class="h1-app" style="margin-top:6px">Unlock your wallet</h1></div>
          <form class="stack" data-unlock novalidate>
            ${field({ label: "Password", name: "password", type: "password", attrs: { autocomplete: "current-password", autofocus: true, required: true } })}
            <span data-error-anchor></span>
            ${button({ label: "Unlock", type: "submit", kind: "neutral", size: "lg", block: true, icon: "unlock" })}
          </form>
          <button type="button" class="linklike small" data-action="forgot" style="align-self:flex-start">Forgot password? Restore from your 24 words</button>
          <p class="caption t-3">Unlocking takes about a second: the password goes through ${KDF.name} so that guessing it is slow.</p>`,
      })}
    </div>`;
    const form = root.querySelector("[data-unlock]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const pw = form.querySelector("[name=password]");
      const btn = form.querySelector("button[type=submit]");
      formError(form, null);
      btn.disabled = true;
      btn.innerHTML = html`<span class="spinner spinner--14"></span><span>Unlocking…</span>`;
      try {
        await unlock(pw.value);
        pw.value = "";
        onDone();
      } catch (err) {
        btn.disabled = false;
        btn.innerHTML = html`${icon("unlock", { size: 16 })}<span>Unlock</span>`;
        formError(form, err.name === "WrongPassword" ? "Wrong password. Try again." : err.message);
        pw.select();
      }
    });
    root.querySelector("[data-action=forgot]").addEventListener("click", forgotSheet);
  };
  render();
  return wireStreamer(root, render);
}

function forgotSheet() {
  const s = openSheet({
    title: "Restore from your 24 words",
    body: html`<div class="stack">
      <p>The password only unlocks this browser. Without it, the encrypted wallet here can't be opened, by you or by us.</p>
      ${callout(html`<b>This removes the encrypted wallet from this browser.</b> Continue only if you have your 24 words: they restore everything, including your notes, on this or any device.`, "warn")}
      <div class="inline-actions">${button({ label: "Remove and restore", kind: "danger", action: "wipe" })}${button({ label: "Cancel", kind: "ghost", attrs: { "data-sheet-close": true } })}</div>
    </div>`,
  });
  s.el.querySelector("[data-action=wipe]").addEventListener("click", () => {
    forgetWallet();
    s.close();
    navigate("/app/import");
  });
}

function migrationScreen(root, onDone) {
  root.innerHTML = html`<div class="wl-center">
    ${panel({
      certified: true,
      cls: "lockpanel",
      body: html`${glyphSVG({ size: 40 })}
        <div><div class="eyebrow">${icon("warn", { size: 12 })} Secure your wallet</div><h1 class="h1-app" style="margin-top:6px">Protect your wallet with a password</h1></div>
        <p class="t-2">This browser holds a wallet from before ${BRAND} got its name, and its recovery phrase is stored unencrypted. Set a password to encrypt it. The plaintext copy is deleted only after the encrypted one has been read back and checked.</p>
        <p class="caption t-3">${KDF_COPY}</p>
        <form class="stack" data-migrate novalidate>
          ${passwordFields()}
          <span data-error-anchor></span>
          ${button({ label: "Encrypt my wallet", type: "submit", kind: "neutral", size: "lg", block: true, icon: "lock" })}
        </form>
        ${callout("The rename came with a signet reset: notes from the old pool don't carry over. Your old activity stays in the history, marked as from before the reset.", "info")}`,
    })}
  </div>`;
  const form = root.querySelector("[data-migrate]");
  const validate = wirePasswordFields(form);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError(form, null);
    let pw;
    try {
      pw = validate();
    } catch (err) {
      return formError(form, err.message);
    }
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    btn.innerHTML = html`<span class="spinner spinner--14"></span><span>Encrypting and checking…</span>`;
    try {
      await migrateWallet(pw);
      toast({ kind: "success", title: "Wallet encrypted on this device.", body: "The unencrypted copy is gone. You'll need your password to unlock from now on." });
      onDone();
    } catch (err) {
      btn.disabled = false;
      btn.innerHTML = html`${icon("lock", { size: 16 })}<span>Encrypt my wallet</span>`;
      formError(form, err.message);
    }
  });
}

/**
 * Every wallet page goes through this. Unlocked: renderUnlocked(session) runs and
 * its cleanup is returned. Otherwise the gate renders here and, once the wallet is
 * unlocked, the same route renders again.
 */
export async function withWallet(root, renderUnlocked) {
  ensureStyles();
  const s = currentSession();
  if (s) return renderUnlocked(s);
  if (hasLegacy() && !hasVault()) {
    migrationScreen(root, reroute);
    return null;
  }
  if (hasVault()) return lockScreen(root, reroute);
  onboarding(root);
  return null;
}

/* ---------- proving sheet ---------- */

/** True when a failure means the built-in key lacks BTC (its own errors, or streamer-masked ones). */
export function lacksBtc(err, s = currentSession()) {
  const m = String(err?.message ?? err ?? "");
  if (/built-in address has no (?:signet )?BTC/i.test(m)) return true;
  const at = m.match(/not enough BTC at (.+?): have/i)?.[1];
  return Boolean(at) && (at === "your Bitcoin address" || at === s?.localPayer?.address);
}

/** Opens the Add BTC sheet (views/deposit.js, loaded on first use). */
export const openAddBtc = () =>
  import("./deposit.js").then((m) => m.openDeposit()).catch((e) => toast({ kind: "danger", title: "Couldn't open Add BTC.", body: e.message }));

/**
 * A locked sheet driven by the real onStep callbacks (visual.md §7). steps:
 * [{ id, label, prov }]. Returns { onStep, done({ title, body, actions }), fail(err, { actions }), sheet }.
 * Step details and the failure message are masked in streamer mode. A failure for lack of
 * BTC on the built-in key also offers Add BTC.
 */
export function provingSheet({ title, eyebrow = "PROVING IN THIS BROWSER", steps }) {
  const state = new Map(steps.map((s) => [s.id, { status: "pending", detail: null, ms: null, t0: null }]));
  const stop = () => {
    finished = true;
    clearInterval(tick);
  };
  // Closed from outside (a lock closes every sheet): stop repainting.
  const sheet = openSheet({ title, eyebrow, locked: true, body: html`<div data-pv></div>`, label: title, onClose: stop });
  const host = sheet.body.querySelector("[data-pv]");
  sheet.el.addEventListener("click", (e) => e.target.closest?.("[data-action=add-btc]") && openAddBtc());
  let tail = "";
  let finished = false;
  const paint = () => {
    const now = Date.now();
    const rows = steps.map((s) => {
      const st = state.get(s.id);
      return { label: s.label, status: st.status, detail: maskText(st.detail), prov: s.prov ?? null, ms: st.status === "running" && st.t0 ? now - st.t0 : st.ms };
    });
    const proving = state.get("prove")?.status === "running";
    host.innerHTML = html`${stepper(rows)}${proving ? html`<div class="proving-bar" aria-hidden="true"><span></span></div>` : ""}${raw(tail)}`;
  };
  // The clock only rewrites the running steps' times: a full repaint every 100 ms would
  // restart the spinner and the proving bar, which then jitter instead of moving.
  const clock = () => {
    const now = Date.now();
    const rows = host.querySelectorAll(".step");
    steps.forEach((s, i) => {
      const st = state.get(s.id);
      const el = st.status === "running" && st.t0 ? rows[i]?.querySelector(".step-ms") : null;
      if (el) el.textContent = fmtMs(now - st.t0);
    });
  };
  const tick = setInterval(() => !finished && clock(), 100);
  paint();
  return {
    sheet,
    onStep(ev) {
      const st = state.get(ev.id);
      if (!st) return;
      if (ev.status === "running" && st.status !== "running") st.t0 = Date.now();
      st.status = ev.status;
      if (ev.detail !== undefined) st.detail = ev.detail;
      if (ev.ms !== undefined) st.ms = ev.ms;
      paint();
    },
    done({ body = "", actions = "" } = {}) {
      stop();
      tail = html`<div class="stack" style="margin-top:16px">${body}<div class="inline-actions">${actions}${button({ label: "Done", kind: "neutral", attrs: { "data-sheet-close": true } })}</div></div>`.toString();
      sheet.setLocked(false);
      paint();
    },
    fail(err, { actions = "" } = {}) {
      stop();
      for (const st of state.values()) if (st.status === "running") st.status = "fail";
      const fund = lacksBtc(err) ? button({ label: "Add BTC", kind: "secondary", icon: "plus", action: "add-btc" }) : "";
      tail = html`<div class="stack" style="margin-top:16px">${callout(html`<b>Nothing more was sent.</b> ${maskText(err?.message ?? String(err))}`, "danger")}<div class="inline-actions">${fund}${actions}${button({ label: "Close", kind: "secondary", attrs: { "data-sheet-close": true } })}</div></div>`.toString();
      sheet.setLocked(false);
      paint();
    },
  };
}

export const mempoolPill = () => sealPill({ state: "mempool" });

/**
 * Keeps a wallet page current: syncs when the indexer reports a new block or new
 * outputs (the same bulk data every wallet downloads), and calls rerender(type)
 * after every sync, history, payer, BTC or relay balance change. Returns an unsubscribe function.
 */
export function liveSession(s, rerender, { syncNow = true } = {}) {
  let lastKey = null;
  let shown = null; // the sync error this page painted last
  const doSync = () =>
    s.sync().catch((e) => {
      if (s.closed) return; // locked meanwhile: the lock screen replaces this page
      // The page keeps the last verified view. Try again on the next poll (say, after an
      // indexer restart) rather than at the next block; after a root mismatch only once the
      // state changes, since the same state rebuilds the same tree. Paint an error once.
      if (e?.code !== ROOT_MISMATCH) lastKey = null;
      s.syncError = e.message;
      if (shown === e.message) return;
      shown = e.message;
      rerender("error");
    });
  const offState = watchState((st) => {
    if (!st || s.closed) return;
    const key = `${st.height}:${st.outputs}:${st.nullifiers}:${st.root}`;
    if (lastKey === null) {
      lastKey = key;
      if (syncNow && (!s.view || s.state?.root !== st.root || s.view.height !== st.height)) doSync();
      return;
    }
    if (key !== lastKey) {
      lastKey = key;
      doSync();
    }
  });
  if (syncNow && !s.view) doSync();
  const offSession = onSessionChange((type) => {
    if (type === "sync") s.syncError = shown = null;
    if (type === "sync" || type === "history" || type === "btc" || type === "payer" || type === "relay-balance") rerender(type);
  });
  return () => {
    offState();
    offSession();
  };
}

/* ---------- batch relay timing: every batch string (batch-contract.md §5.2) ---------- */

const batchName = (mode) => (mode === "batch10" ? "10-hour batch" : "hourly batch");

/**
 * Copy for the Hourly and 10-hour batch. Heights are block numbers (shown through int()),
 * `wait` is a number of blocks (shown through eta()). Counts are transfers, never people.
 */
export const BATCH_TEXT = {
  label: { fast: "Fast (~1 min)", block: "Next block", batch: "Hourly batch", batch10: "10-hour batch" },
  stop: "Batch", // the third stop of "Relay timing"; the length is chosen under it
  name: batchName,
  control: "Relay timing",
  lengthControl: "Batch length",
  otherModes: "Next block lands with the other transfers in that block. Fast (~1 min) goes out alone, so its timing is easier to link. Batch waits for a shared release, so Bitcoin doesn't show when you pressed Send.",
  caption: {
    batch: "Hourly batch waits for the next batch. People watching Bitcoin see it land together with the other hourly-batch transfers from that hour, not when you pressed Send.",
    batch10: "10-hour batch waits for the next 10-hour batch. People watching Bitcoin see it land together with the other 10-hour-batch transfers from those 10 hours, not when you pressed Send. Use it only when the recipient can wait.",
  },
  ip: "The relayer still sees your IP address and when you submitted. Tor Browser hides your IP. Anyone can watch the waiting count, which changes once per block, so with few transfers the block you submitted in can be read from it.",
  crowd: (n) => `Waiting for this batch: ${int(n)} (reported by the relayer).`,
  alone: "A batch hides nothing while it holds only your transfer.",
  thin: "Few transfers are waiting for this batch. With so few, it hides little.",
  tooNew: ({ start, eligibleAt, wait }) =>
    `The note this send needs arrived after block ${int(start)}, so it can join the batch that starts at block ${int(eligibleAt)} (${eta(wait)}). Or send it with the next block now.`,
  notYet: ({ eligibleAt, wait }) => `This send can join the batch that starts at block ${int(eligibleAt)} (${eta(wait)}). Or send it with the next block now.`,
  tooNewCta: ({ eligibleAt }) => `This send can join the batch that starts at block ${int(eligibleAt)}, or go with the next block now.`,
  useNextBlock: "Send with the next block",
  full: "This batch is full. Send with the next block, or try the next batch.",
  disabled: "The relayer is not taking this batch length right now. Send with the next block instead.",
  time: ({ mode, releaseAt, wait }) => `With the ${batchName(mode)} after block ${int(releaseAt)} (${eta(wait)})`,
  step: "Scheduled for the batch",
  scheduled: ({ releaseAt, deadline }) =>
    `Scheduled. It goes out with the batch after block ${int(releaseAt)}. Your notes stay reserved until it lands, or until block ${int(deadline)} at the latest.`,
  recipientWait: {
    batch: "The recipient sees it when it lands: usually within an hour, at most about two.",
    batch10: "The recipient sees it when it lands: usually within 10 hours, at most about 15.",
  },
  noCancel: "A scheduled transfer can't be cancelled: the relayer holds it, and anyone holding it could still carry it.",
  long10: {
    reserve: ({ deadline, wait }) => `Your notes stay reserved until it lands, about 10 hours, or until block ${int(deadline)} (${eta(wait)}) if it never does.`,
    crowd: "The 10-hour batch is a separate crowd: it lands about 10 hours after its anchor block, so it only hides among other 10-hour transfers, and there are fewer of those than in the hourly batches.",
    stall: ({ lastRelease }) => `If the relayer stalls, it has until block ${int(lastRelease)} to send it. After that it won't, and Activity offers other ways to send it.`,
  },
  selfDefault: "Merges and refreshes go with the hourly batch by default: nobody waits for them, and they add real transfers to the batch.",
  toast: { title: "Transfer scheduled.", body: ({ what, releaseAt }) => `${what} goes out with the batch after block ${int(releaseAt)}.` },
  retried: ({ releaseAt, deadline }) =>
    `Scheduled again. It goes out with the batch after block ${int(releaseAt)}. Same notes, so it can't pay twice. Your notes stay reserved until it lands, or until block ${int(deadline)} at the latest.`,
  // Activity
  chip: { scheduled: "Scheduled", releasing: "Going out with the batch", attention: "Needs attention" },
  scheduledLine: ({ mode, releaseAt, wait, deadline }) =>
    `Scheduled. It goes out with the ${batchName(mode)} after block ${int(releaseAt)} (${eta(wait)}). Your notes stay reserved until it lands, or until block ${int(deadline)} at the latest.`,
  releasing: ({ mode, releaseAt, deadline, broadcast }) =>
    `${broadcast ? `Sent by the relayer with the ${batchName(mode)} after block ${int(releaseAt)}; waiting for a block.` : `Going out with the ${batchName(mode)} after block ${int(releaseAt)}.`} Your notes stay reserved until it lands, or until block ${int(deadline)} at the latest.`,
  landed: ({ height, count }) =>
    `Landed in block ${int(height)}. The relayer reports ${int(count)} ${count === 1 ? "transfer" : "transfers"} in this batch, yours included. Check it with Audit the relayer.`,
  landedNoCount: ({ height, mode, releaseAt }) => `Landed in block ${int(height)} with the ${batchName(mode)} after block ${int(releaseAt)}.`,
  landedThin: "Few transfers were in this batch. With so few, it hid little.",
  split: (n) =>
    n === 1
      ? "Landed one block after the rest of its batch, so its timing stands out."
      : `Landed ${int(n)} blocks after the rest of its batch, so its timing stands out.`,
  overdue: ({ releaseAt, lastRelease, deadline }) =>
    `The batch after block ${int(releaseAt)} should have gone out by now. The relayer has until block ${int(lastRelease)} to send it. You can pay the fee yourself or copy the envelope; your notes stay reserved until it lands, or until block ${int(deadline)}.`,
  missed: ({ lastRelease }) =>
    `The relayer did not send it by block ${int(lastRelease)}. ${relayOpen() ? "Retry in the next batch, send at the next block, or pay the fee yourself." : "Pay the fee yourself or copy the envelope."} Same notes, so it can't pay twice.`,
  // Relaying closed on this server: a relayed send no relayer will send (session.relayStranded).
  stranded: ({ deadline }) =>
    `No relayer will send it: no relayer runs on this server now. Pay the fee yourself or copy the envelope. Same notes, so it can't pay twice. Your notes stay reserved until it lands, or until block ${int(deadline)} at the latest.`,
  nextBlockNote: "Sending at the next block reuses this envelope when it is recent enough; its anchor then shows it missed a batch.",
  buttons: {
    relay: "Retry with the same notes",
    "next-batch": "Retry in the next batch",
    "next-block": "Send at the next block",
    self: "Pay the fee myself (links this transfer to your BTC address)",
    copy: "Copy envelope hex",
  },
  // Settings, Relayer books
  title: "Batches",
  now: { batch: "Hourly batch now", batch10: "10-hour batch now" },
  nowValue: ({ queued, releaseAt }) => `${int(queued)} waiting · goes out after block ${int(releaseAt)}`,
  nowOff: "not taking transfers right now",
  recentTitle: "Recent batches",
  recentColumns: { batch: "Batch", anchor: "Anchor block", sent: "Sent", landed: "Landed in" },
  recentEmpty: "No batches sent yet.",
  landedIn: (rows) => rows.map(([h, n]) => `#${int(h)} (${int(n)})`).join(", "),
  settingsCaption: "Counts are reported by the relayer. Audit the relayer checks them against Bitcoin.",
  auditLine: ({ matched, total }) => `Batch sizes match Bitcoin: ${int(matched)}/${int(total)}`,
  mismatch: ({ mode, start, note }) => `${BATCH_TEXT.label[mode] ?? mode} at anchor block ${int(start)}: ${note}`,
  get networkNote() {
    return relayOpen()
      ? "Scheduled batch transfers are not looked up until their batch goes out."
      : "While relaying is unavailable, scheduled batch transfers are looked up too, so the wallet learns that no relayer will send them.";
  },
};

/* ---------- relay balance: every relay-balance string (relay-balance-contract.md §5.7) ---------- */

/**
 * Copy for the relay balance: the quiet entry on Send, the relay card, the top-up sheet,
 * Settings and Activity. recentDeposit, operator and topUpOnce are the approved
 * sentences of docs/design/relay-balance.md §5, word for word. Never "free balance":
 * the balance one can spend is the "available balance".
 */
export const RELAY_TEXT = {
  entry: "Top up a relay balance",
  cardTitle: "Relay from my balance: my BTC address is not on the transfer",
  cardStatus: ({ balance }) => `Balance ${int(balance)} sats`,
  // The margin and the batch headroom are the relayer's (info.balance); the defaults are relay-balance.md §6.
  cardFee: ({ perSend, marginPct = 10, marginMinSats = 50 }) =>
    `~${int(perSend)} sats from your relay balance (network fee plus a ${int(marginPct)}% margin, at least ${int(marginMinSats)} sats)`,
  low: ({ balance, needed }) => `Your relay balance is ${int(balance)} sats; this send needs about ${int(needed)}. Top up, or pay the fee yourself.`,
  lowBatch: ({ headroom = 2 } = {}) =>
    `A batch send reserves ${headroom === 1 ? "the fee" : headroom === 2 ? "twice the fee" : `${int(headroom)} times the fee`} until its batch goes out; the difference comes back.`,
  feeHigh: ({ feeRate, maxFeeRate }) => `Bitcoin fees (${feeRate} sat/vB) are above the relayer's cap of ${maxFeeRate} sat/vB, so it does not take sends right now. Pay the fee yourself or copy the envelope.`,
  topUpOnce: "Top up once, it lasts many sends.",
  meter: (n) => `Relayed transfers in the last 144 blocks: ${int(n)}`,
  suggested: ({ sats, sends }) => `Suggested: ${int(sats)} sats, about ${sends} sends at today's fees.`,
  minimum: ({ min }) => `Minimum ${int(min)} sats. A smaller payment is not credited and is not returned.`,
  confirmations: (n) => `Credited after ${n} confirmation${n === 1 ? "" : "s"}, about ${n * 10} minutes on average.`,
  fresh: "Each top-up gets a new address. Payments to an older one are still credited.",
  anyWallet: IS_SIGNET
    ? "Pay it from any signet wallet: a plain payment, nothing else. Never send real bitcoin to it."
    : "Pay it from any Bitcoin wallet: a plain payment of real bitcoin, nothing else.",
  sweep: ({ sweep }) => `${int(sweep)} sats of each top-up pay for the relayer to spend that coin later.`,
  noWithdraw: IS_SIGNET
    ? "The balance does not expire on signet. Withdrawing what is left is not available yet."
    : "The balance does not expire. Withdrawing what is left is not available yet, so top up only what you plan to send.",
  recentDeposit: "Your top-up confirmed recently and few people are relaying right now. Sending now can link this transfer to the address you paid from. A batch mode, or waiting, hides this better.",
  operator: "The relayer can link the address you top up from to every transfer you relay with this balance. Tor does not prevent this. It cannot see amounts, tokens or recipients.",
  timing: "Topping up ahead of time hides this better: a send made right after a top-up confirms is easier to link to the address that paid.",
  lookup: "To notice your payment, this browser asks mempool.space about the deposit address while this sheet is open or a payment is waiting; mempool.space sees your IP and that address.",
  payFromKey: "The relayer sees which address paid. Paying from the built-in key links your relay balance to that key's address, which your self-paid sends also use.",
  waiting: ({ confirmations, needed }) => `Payment seen, waiting for confirmation (${confirmations} of ${needed}).`,
  credited: ({ amount }) => `Credited: +${int(amount)} sats.`,
  small: ({ min }) => `Below the ${int(min)}-sat minimum: not credited.`,
  missed: missedText,
  stuck: "The relayer's carrier is not confirmed yet. You can pay the fee yourself with the same envelope; if the relayer's carrier is also mined, its fee stays spent.",
  // Relay pool lineage (privacy-trace-test.md L1). Never says the sender is hidden for a linkable send.
  thin: ({ k } = {}) =>
    k != null && k < MIN_COVER_K
      ? `This relayer does not require its coins to descend from enough separate depositors (it asks for ${int(k)} besides the sender). A relayed send can be tied on Bitcoin to the address you topped up from, by its input, and anyone can follow that link.`
      : `The relay pool is thin: no relayer coin descends yet from ${k ? `at least ${int(k + 1)}` : "enough"} separate depositors. A relayed send now is tied on Bitcoin to the address you topped up from, by its input, and anyone can follow that link.`,
  thinChoice: "Pay the fee yourself, or confirm to send it linkable.",
  thinConfirm: "Send it linkable: I accept that Bitcoin ties this transfer to the address I topped up from.",
  thinConfirmFirst: "Confirm that this send may go linkable, or pay the fee yourself.",
  thinCard: "While the relay pool is thin, a relayed send is tied to your top-up address by its input.",
  mixUnknown: "This relayer does not publish how many depositors its coins descend from, so a relayed send may be tied to the address you topped up from by its input.",
  linkableSent: "Sent linkable: its carrier's input ties it to the address you topped up from.",
  mix: ({ depositors, k, coverOk }) =>
    `${depositors == null ? "" : `${int(depositors)} separate ${depositors === 1 ? "account has" : "accounts have"} topped up. `}${
      k != null && k < MIN_COVER_K
        ? `This relayer asks a carrier's coins to descend from only ${int(k)} depositors besides the sender, too few to hide one: a relayed send can be tied to the address that topped it up.`
        : `A carrier spends only coins that descend from at least ${k == null ? "several" : int(k + 1)} depositors, so whoever sends, at least ${k == null ? "several" : int(k)} others are among them. ${coverOk ? "Such coins exist now." : "None exists yet, so a relayed send is tied to the address that topped it up unless its sender confirms it may go linkable or pays the fee."}`
    }`,
  mixUnknownShort: "Not published by this relayer.",
  // Emergencies (relay-balance.md §9): the relayer moves its coins to new keys. Balances are kept.
  paused: "The relayer takes no top-ups right now: it is moving its coins to new keys, or is paused. Do not pay any deposit address it showed you. Your balance is kept in full.",
  rotated: "The relayer moved to new keys. Every deposit address it showed before is retired: never pay one again. This wallet now shows addresses of the new key only. Your balance carried over: it belongs to your account, not to the relayer's keys.",
  retiredWaiting: "Paid to a retired deposit address. It is credited once the relayer's operator has moved it into the new pool.",
};

/**
 * Copy for mining (mining-contract.md §12, word for word). The relay sentence of the
 * transfer route ("It cannot see amounts, tokens or recipients") is never shown for
 * mining: for a claim the relayer sees the token and the reward. fee() takes its amount
 * and recipient from MINE_FEE.
 */
export const MINE_TEXT = {
  relay: ({ ticker, reward }) =>
    `The reward goes to a private note. Chain observers see relay claims of ${ticker} for ${reward} each, not who received them. The relayer can link the address you top up from to every claim it carries for you, including the token and the reward. While few people relay claims, the claims right after your top-up are easy to tie to it. Top up before you start mining.`,
  self: "Claims are public: token, reward and the paying address. Anyone can add up what this address mined, and the transfers it pays for later.",
  gpu: "A single GPU or a server miner can be thousands of times faster than this tab. Anyone can rent many computers.",
  fee: ({ sats, recipient }) => `Every claim pays a Bitcoin fee and a service fee of ${int(sats)} sats to ${recipient}. Its own claims cost it ${int(sats)} sats less.`,
  censor: "Bitcoin miners choose what goes into blocks and in what order. They can delay a claim until it expires.",
  nearCap: "Supply is nearly mined out. A claim that lands after the cap is rejected; its Bitcoin fee and its service fee are still spent.",
  window: "A claim must land within 12 blocks of the block it references.",
  surge: "Difficulty jumped. Solutions found before the jump may no longer count; the wallet checks before paying.",
  bump: "The fee recipient can block a fee bump, so the wallet pays a next-block rate up front.",
  signet: "Test coins, no value.",
  start: "Starting now favours whoever is ready first; a delay gives everyone time to see the terms.",
  phone: "Mining keeps the processor busy: expect battery drain and heat.",
  noise: "Difficulty is noisy: with few solutions per span, emission runs a few percent above target.",
  burst: "After a quiet period or a hashrate jump, the first block can carry many claims.",
  slow: "Slow mode: this browser's fast hash failed its test.",
  off: "This browser computed a test hash wrong; mining is off.",
  recentDeposit: "Your top-up confirmed recently and few claims or transfers have been relayed since. Claims you relay now are easy to tie to the address you paid from.",
  pendingRelay: "This claim is with the relayer. Paying the fee yourself would publish the same claim from your address and link the two, so the wallet does not offer it.",
  keyApart: "Self-paid claims use a separate built-in mining key, never the key that pays your transfers and top-ups.",
};

/** The platform's name in the fee sentence. */
export const MINE_RECIPIENT = `the ${BRAND} platform address`;

/**
 * The disclosures a Mine page shows for `route` ("relay" | "key" | "unisat"), in order:
 * the route's privacy sentence, then every all-routes sentence. Never the transfer relay copy.
 */
export function mineCopy(route, { ticker = "TICKER", reward = "R", feeSats = null, recipient = MINE_RECIPIENT, phone = false } = {}) {
  const out = [route === "relay" ? MINE_TEXT.relay({ ticker, reward }) : MINE_TEXT.self, MINE_TEXT.gpu];
  if (feeSats != null && BigInt(feeSats) > 0n) out.push(MINE_TEXT.fee({ sats: feeSats, recipient }));
  out.push(MINE_TEXT.censor, MINE_TEXT.window, MINE_TEXT.bump, ...(IS_SIGNET ? [MINE_TEXT.signet] : []));
  if (phone) out.push(MINE_TEXT.phone);
  return out;
}

/** A status chip for a history entry (text always present). With `tip`, batch sends show their phase. */
export function statusChip(h, tip = null) {
  if (h?.kind === "mine") {
    switch (h.status) {
      case "proving":
        return tag("Proving", "btc");
      case "landed":
        return tag("Landed", "proof");
      case "rejected":
        return tag("Rejected", "danger");
      case "expired":
        return tag("Expired", "neutral");
      case "dropped":
        return tag("Dropped", "neutral");
      default:
        return tag(h.via === "relay" ? "With the relayer" : "Waiting for a block", "btc");
    }
  }
  if (relayStranded(h) || relayStuck(h, tip)) return tag(BATCH_TEXT.chip.attention, "warn");
  const phase = tip == null ? null : batchPhase(h, tip);
  if (phase === "scheduled") return tag(BATCH_TEXT.chip.scheduled, "btc");
  if (phase === "releasing") return tag(BATCH_TEXT.chip.releasing, "btc");
  if (phase === "overdue" || phase === "missed") return tag(BATCH_TEXT.chip.attention, "warn");
  switch (h.status) {
    case "accepted":
      return tag("Accepted", "proof");
    case "rejected":
      return tag("Rejected", "danger");
    case "expired":
      return tag("Expired · notes free", "neutral");
    case "failed":
      return tag("Needs attention", "warn");
    case "dropped":
      return tag("Dropped", "neutral");
    case "copied":
      return tag("Envelope copied", "neutral");
    case "relaying":
      return tag(h.relayStatus === "broadcast" || h.relayStatus === "accepted" ? "Broadcast by relayer" : "Queued at relayer", "btc");
    case "legacy":
      return tag("Before the reset", "neutral", { hatched: true });
    default:
      return tag("Waiting for a block", "btc");
  }
}

export { fmtMs };

// A lock from anywhere (idle timer, header menu, Settings, another tab) closes every
// sheet and re-renders the wallet page in place, which then shows the lock screen;
// unlocking returns to it.
export const LOCK_EVENTS = new Set(["lock", "idle-lock", "elsewhere-lock"]);
onSessionChange((type) => {
  if (typeof location === "undefined" || !LOCK_EVENTS.has(type)) return;
  closeAllSheets();
  if (location.pathname.startsWith("/app")) reroute();
  if (type === "idle-lock") toast({ kind: "info", title: "Wallet locked after inactivity.", body: "Unlock with your password to continue. Change the delay in Settings." });
  if (type === "elsewhere-lock") toast({ kind: "info", title: "Locked: this wallet was changed in another tab.", body: hasVault() ? "Unlock with its current password to continue." : "It was removed from this browser." });
});

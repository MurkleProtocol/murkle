// "Add BTC": how to fund the built-in key, the wallet's own Bitcoin key that pays
// mints, launches and any private send you carry yourself. The sheet shows its
// signet address in full with a QR code and a copy button, the balance split into
// confirmed and unconfirmed, a waiting state that notices a deposit, and short,
// honest privacy advice. Streamer mode masks the address and the QR until revealed.
//
// The balance comes from mempool.space only while this sheet is open: once on open,
// then on the indexer poll's ticks at most every AUTO_GAP_MS, for AUTO_FOR_MS.
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { addr, rel, sats } from "../ui/format.js";
import { button, kv, tag } from "../ui/components.js";
import { prov } from "../ui/prov.js";
import { redact } from "../ui/redact.js";
import { qrSVG } from "../ui/qr.js";
import { openSheet } from "../ui/sheet.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import * as api from "../api.js";
import { BTC_WORD, IS_SIGNET, NETWORK_TAG, PARAMS } from "../config.js";
import { currentSession, onSessionChange, onStreamerChange } from "../session.js";
import { masked, satsHTML, callout } from "./app-shared.js";

export const AUTO_GAP_MS = 30_000;
export const AUTO_FOR_MS = 30 * 60_000;
/** Seconds between automatic checks: the first indexer poll tick after the gap. */
export const autoEverySeconds = (poll = api.POLL_MS) => (Math.ceil(AUTO_GAP_MS / poll) * poll) / 1000;

export const WHAT_IT_PAYS =
  `This key pays the Bitcoin side of mints, launches and any private send you choose to pay yourself. Send ${BTC_WORD} to its address.`;
export const ADVICE = [
  "Fund this key from a source not linked to your main wallet, for example a direct withdrawal from an exchange, so no chain of transactions connects it to your other addresses. The exchange itself knows where it sent the coins.",
  "Every transaction this key pays is visible on Bitcoin (mints are public anyway). It pays the private sends you pay yourself too, and each one is tied to its address, so keep it apart from your main wallet.",
];
// config.js's FAUCET (signetfaucet.com) answered 522 when checked; its alt mirror pays out on signet.
// (params.mjs names the main faucet now; this sheet keeps the mirror, as it always did.)
export const SIGNET_FAUCET = "https://alt.signetfaucet.com";
export const SIGNET_NOTE =
  "Signet coins have no value, so exchanges don't list them. On signet, get free coins from a faucet instead. The faucet sees your IP and the address you paste.";
export const signetNote = (faucet = SIGNET_FAUCET) =>
  html`${SIGNET_NOTE} <a href="${faucet}" target="_blank" rel="noopener noreferrer">Open ${faucet.replace(/^https?:\/\//, "").replace(/\/$/, "")} ↗</a>`;
/** Mainnet: no faucet, real bitcoin. Said plainly where signet shows the faucet note. */
export const MAINNET_FUNDING_NOTE =
  "This is a Bitcoin mainnet address: send only what you plan to spend on fees and mint prices. Every payment to it is public on Bitcoin.";
export const fundingNote = () => (IS_SIGNET ? signetNote() : MAINNET_FUNDING_NOTE);
export const lookupNote = () =>
  `Checking the balance asks mempool.space about this address, so it sees your IP. This sheet checks when it opens, then about every ${autoEverySeconds()} s while it stays open (up to ${AUTO_FOR_MS / 60_000} min).`;

/** Esplora UTXOs -> sats confirmed, in the mempool, and in total. */
export function splitCoins(utxos = []) {
  let confirmed = 0;
  let unconfirmed = 0;
  for (const u of utxos) {
    if (u.status?.confirmed) confirmed += Number(u.value);
    else unconfirmed += Number(u.value);
  }
  return { confirmed, unconfirmed, total: confirmed + unconfirmed, count: utxos.length };
}

/** "loading" | "error" | "waiting" | "mempool" | "funded" */
export function depositState({ coins = null, error = null } = {}) {
  if (!coins) return error ? "error" : "loading";
  if (!coins.total) return "waiting";
  return coins.unconfirmed ? "mempool" : "funded";
}

/** Shown when Unisat pays: this sheet still funds the built-in key. */
export function payerNote(s, { here = typeof location !== "undefined" ? location.pathname : "" } = {}) {
  if (s.payerPref !== "unisat") return "";
  const link = here === "/app/settings" ? "" : html` <a href="/app/settings#fees" data-link data-sheet-close>Fee settings</a>`;
  return callout(html`<b>Unisat pays your mints and launches now.</b> This sheet adds BTC to the built-in key instead, which pays only once you pick it as the payer.${link}`, "info");
}

/** Address, QR and copy. Streamer mode: a bar and a hatched tile until shown. */
export function addressBlock(address, { shown = false } = {}) {
  const hide = masked() && !shown;
  return html`<div class="dep-addr">
    ${hide ? html`<div class="dep-qr-mask" role="img" aria-label="QR code hidden in streamer mode">${icon("eye-off", { size: 20 })}<span class="caption">QR hidden</span></div>` : qrSVG(address, { size: 152, label: "QR code of your built-in Bitcoin address" })}
    <div class="stack stack--s dep-addr-main">
      <div class="eyebrow">YOUR BUILT-IN ADDRESS · ${NETWORK_TAG}</div>
      <div class="dep-addr-text">${hide ? redact("address", { tip: "Hidden in streamer mode." }) : addr(address, { copy: false })}</div>
      <div class="inline-actions">
        ${button({ label: "Copy address", kind: "secondary", size: "sm", icon: "copy", action: "dep-copy", attrs: { "data-autofocus": true } })}
        ${masked() ? button({ label: shown ? "Hide address" : "Show address", kind: "ghost", size: "sm", icon: shown ? "eye-off" : "eye", action: "dep-reveal" }) : ""}
      </div>
    </div>
  </div>`;
}

/** Status line and confirmed / unconfirmed rows. Amounts are masked in streamer mode. */
export function statusBlock({ coins = null, error = null, unisat = false } = {}) {
  const state = depositState({ coins, error });
  const head = {
    loading: html`<span class="spinner spinner--12"></span><b>Checking mempool.space…</b>`,
    error: html`${icon("warn", { size: 16 })}<b>Couldn't read the balance.</b>`,
    waiting: html`${icon("clock", { size: 16 })}<b>Waiting for coins</b>`,
    mempool: html`${tag("In mempool", "btc")}<b>Coins arrived, waiting for a block</b>`,
    funded: html`${icon("check", { size: 16 })}<b>Funded</b>`,
  }[state];
  const sub = {
    loading: "",
    error: "mempool.space didn't answer. Check your connection, then press Check again.",
    waiting: `Send ${BTC_WORD} to the address above. It shows here once it reaches the mempool.`,
    mempool: "You can use them now: a mint paid with them confirms in the same block as the deposit or later.",
    funded: unisat ? "Ready for when you pick the built-in key as the payer." : "Ready to pay mints and launches.",
  }[state];
  return html`<div class="dep-head">${head}</div>
    ${sub ? html`<p class="caption t-2">${sub}</p>` : ""}
    ${coins
      ? html`${kv(
          [
            ["Confirmed", html`${satsHTML(coins.confirmed)} ${prov("BTC")}`],
            ["Unconfirmed", satsHTML(coins.unconfirmed)],
          ],
          { compact: true },
        )}<p class="caption t-3">Checked ${rel(coins.at)}${error ? ". The last check failed; showing the one before." : "."}</p>`
      : ""}`;
}

export function depositBody(s, st = {}) {
  return html`<div class="stack dep">
    <div data-dep-payer>${payerNote(s)}</div>
    <p class="small t-2">${WHAT_IT_PAYS}</p>
    <div data-dep-addr>${addressBlock(s.localPayer.address, st)}</div>
    <section class="dep-bal" aria-label="Balance of the built-in key">
      <div class="stack stack--s" data-dep-status aria-live="polite">${statusBlock({ ...st, unisat: s.payerPref === "unisat" })}</div>
      <div class="inline-actions">${button({ label: "Check again", kind: "ghost", size: "sm", icon: "refresh", action: "dep-check" })}</div>
    </section>
    <section class="dep-advice" aria-label="Funding and privacy">
      <div class="eyebrow">FUNDING AND PRIVACY</div>
      <ul class="dep-list">${ADVICE.map((a) => html`<li>${a}</li>`)}</ul>
    </section>
    ${callout(fundingNote(), "info")}
    <p class="caption t-3">${lookupNote()}</p>
  </div>`;
}

let current = null;

/**
 * Opens the sheet for session s (default: the unlocked one). One at a time.
 * esplora and watch are injectable for tests. Returns { sheet, refresh, state }, or null with
 * no session (or while the last one is still closing: it opens again once that's done).
 */
export function openDeposit(s = currentSession(), { esplora = api.esplora, watch = api.watchState } = {}) {
  if (!s || s.closed) return null;
  if (current) {
    if (!current.state.closing) return current;
    // Still animating out: open again once it's gone and has handed focus back.
    current.state.reopen = () => openDeposit(s, { esplora, watch });
    return null;
  }
  const st = { coins: null, error: null, checking: false, shown: false, lastCheck: 0, since: Date.now(), closing: false, closed: false, reopen: null };
  const offs = [];
  const sheet = openSheet({
    title: "Add BTC",
    eyebrow: `BUILT-IN KEY · ${NETWORK_TAG}`,
    label: "Add BTC to your built-in key",
    body: depositBody(s, st),
    onClose() {
      st.closed = true;
      for (const off of offs) off();
      if (current?.state === st) current = null;
      // The page under the sheet may have repainted (a "btc" event): land on its Add BTC again.
      if (typeof document !== "undefined" && (!document.activeElement || document.activeElement === document.body)) {
        document.querySelector?.("main [data-action=add-btc]")?.focus({ preventScroll: true });
      }
      st.reopen?.();
    },
  });
  // onClose comes after a 240 ms close animation: note the close as it starts (Esc, X, scrim,
  // a [data-sheet-close] link, close()), so Add BTC pressed meanwhile isn't swallowed.
  const closing = () => (st.closing = true);
  const onKey = (e) => e.key === "Escape" && closing();
  sheet.el.addEventListener("keydown", onKey);
  offs.push(() => sheet.el.removeEventListener("keydown", onKey));
  const close = sheet.close;
  sheet.close = () => (closing(), close());
  const slot = (sel) => sheet.body.querySelector(sel);
  // Keeps focus on the same control when a slot is redrawn.
  const repaint = (sel, markup) => {
    const el = slot(sel);
    if (!el) return;
    const act = typeof document !== "undefined" && el.contains?.(document.activeElement) ? document.activeElement.dataset?.action : null;
    el.innerHTML = markup;
    if (act) el.querySelector(`[data-action="${act}"]`)?.focus();
  };
  const paintAddr = () => repaint("[data-dep-addr]", addressBlock(s.localPayer.address, st));
  const paintStatus = () => repaint("[data-dep-status]", statusBlock({ ...st, unisat: s.payerPref === "unisat" }));
  const paintCheck = () => {
    const b = slot("[data-action=dep-check]");
    if (!b) return;
    b.innerHTML = st.checking ? html`<span class="spinner spinner--14"></span><span>Checking…</span>` : html`${icon("refresh", { size: 16 })}<span>Check again</span>`;
    b.setAttribute("aria-busy", st.checking ? "true" : "false");
  };

  async function refresh() {
    if (st.checking || st.closed || s.closed) return;
    st.checking = true;
    st.lastCheck = Date.now();
    paintCheck();
    try {
      const next = splitCoins(await s.localPayer.utxos(esplora));
      if (st.closed) return;
      const prev = st.coins;
      st.coins = { ...next, at: Date.now() };
      st.error = null;
      // Every open view repaints on the session's "btc" event.
      if (s.btc?.sats !== next.total) s.checkBtc().catch(() => {});
      if (prev && next.total > prev.total) {
        const got = next.total - prev.total;
        toast({ kind: "success", title: IS_SIGNET ? "Signet BTC arrived." : "BTC arrived.", body: masked() ? "Your built-in key received coins." : `${sats(got)} reached your built-in key${next.unconfirmed ? ", waiting for a block" : ""}.` });
      }
    } catch {
      st.error = "unreachable";
    } finally {
      st.checking = false;
      if (!st.closed) {
        paintCheck();
        paintStatus();
      }
    }
  }

  const onClick = async (e) => {
    if (e.target.closest?.("[data-sheet-close]") || e.target.matches?.("[data-scrim]")) closing();
    const b = e.target.closest?.("[data-action]");
    if (!b) return;
    const act = b.dataset.action;
    if (act === "dep-copy") {
      if (await copyText(s.localPayer.address)) toast({ kind: "success", title: "Address copied.", timeout: 2500 });
      else toast({ kind: "warn", title: "Couldn't copy.", body: "Your browser blocked the clipboard. Select the address and copy it by hand." });
    } else if (act === "dep-reveal") {
      st.shown = !st.shown;
      paintAddr();
    } else if (act === "dep-check") {
      st.since = Date.now(); // a manual check restarts the automatic window
      refresh();
    }
  };
  sheet.el.addEventListener("click", onClick);
  offs.push(() => sheet.el.removeEventListener("click", onClick));
  offs.push(
    onStreamerChange(() => {
      st.shown = false;
      paintAddr();
      paintStatus();
    }),
  );
  offs.push(
    onSessionChange((type) => {
      if (type !== "payer") return;
      repaint("[data-dep-payer]", payerNote(s));
      paintStatus();
    }),
  );
  current = { sheet, refresh, state: st };
  refresh();
  // Rides the indexer poll (20 s, paused while the tab is hidden): no timer of its own.
  offs.push(
    watch(() => {
      const now = Date.now();
      if (now - st.since < AUTO_FOR_MS && now - st.lastCheck >= AUTO_GAP_MS) refresh();
    }),
  );
  return current;
}

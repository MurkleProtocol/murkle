// /app once unlocked: private balances, the shielded address, pool state checked
// in this browser, the crowd around each note, and how fees get paid.
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { int, rel, heightText, plural } from "../ui/format.js";
import { button, panel, table, empty, tag } from "../ui/components.js";
import { prov, REBUILD_TIP } from "../ui/prov.js";
import { sigil } from "../ui/sigil.js";
import { qrSVG } from "../ui/qr.js";
import { anonMeter, linkMeter, LINK_TEXT } from "../ui/meter.js";
import { toastError } from "../ui/toast.js";
import { noteContext, noteTier, UPPER_BOUND_TIP } from "../privacy.js";
import { mixState } from "../relay.js";
import { batchLate } from "../session.js";
import {
  withWallet, pageHead, wireStreamer, liveSession, amountHTML, zpHTML, btcHTML, satsHTML, masked, callout,
} from "./app-shared.js";
import { openDeposit } from "./deposit.js";
import { BTC_WORD, IS_SIGNET } from "../config.js";

const TIER_TONE = { exposed: "danger", weak: "warn", fair: "neutral", strong: "proof" };

export function tierTag(t) {
  return html`<span class="tier" data-tip="${UPPER_BOUND_TIP}" tabindex="0">${tag(t.label, TIER_TONE[t.tier])}</span>`;
}

function stateLine(s) {
  // A failed sync keeps the last verified view: say how old the balances below are.
  const kept = s.view ? html`<div class="caption t-2" style="margin-top:2px">The balances below are from the last state your browser verified, at ${heightText(s.view.height)}.</div>` : "";
  if (s.syncError) return callout(html`<b>Sync failed.</b> ${s.syncError}${kept}`, "danger");
  if (!s.view) return html`<p class="small t-3"><span class="spinner spinner--12"></span> Downloading the public pool and rebuilding the note tree in this browser…</p>`;
  return html`<div class="callout callout--proof">${icon("check", { size: 16 })}<div><b>Indexer consistent: root matches at ${heightText(s.view.height)}</b> ${prov("IDX", { tip: REBUILD_TIP })}<div class="caption t-2" style="margin-top:2px">Your browser rebuilt the note tree from the ${int(s.view.outputs.length)} commitments our indexer served and got the root it reports. Verify the Pool checks them against Bitcoin. Synced ${rel(s.lastSync)}.</div></div></div>`;
}

function balances(s) {
  const rows = s.assets().filter((a) => a.balance > 0n);
  if (!s.view) return html`<div class="skel" style="width:100%;height:88px"></div>`;
  if (!rows.length) return empty({ text: "No notes yet. Mint from an open token to receive your first private note.", action: { label: "Browse mints", href: "/app/mint" } });
  return table({
    caption: "Private balances",
    columns: [
      { key: "token", label: "Token" },
      { key: "balance", label: "Balance", align: "right" },
      { key: "actions", label: "", align: "right" },
    ],
    rows: rows.map((a) => {
      const pending = a.balance - a.available;
      return {
        token: html`<a class="tok" href="/t/${a.ticker}" data-link>${sigil(a.id, { size: 32 })}<span class="ticker">${a.ticker}</span></a>`,
        balance: html`<span class="bal-cell"><span>${amountHTML(a.balance, a.divisibility)}</span>${pending > 0n ? html`<span class="bal-pending">${amountHTML(pending, a.divisibility)} pending</span>` : ""}</span>`,
        actions: html`<span class="inline-actions" style="justify-content:flex-end">${button({ label: "Send", href: `/app/send?t=${a.ticker}`, kind: "secondary", size: "sm" })}</span>`,
      };
    }),
  });
}

/** The route the Crowd Meter grades notes for: how this wallet's private sends go now. */
function noteRoute(s) {
  const r = s.routePref;
  // L1: while the relay pool is thin, a relayed send is tied to the top-up address.
  if (r === "relay") return mixState(s.relayInfo) === "thin" ? "relay-linkable" : "relay";
  if (r === "copy") return r;
  return s.payerPref === "unisat" ? "unisat" : "self";
}

function notesPanel(s) {
  if (!s.view) return "";
  const notes = s.notes();
  if (!notes.length) return "";
  const leaves = s.view.outputs.length;
  const items = notes
    .sort((a, b) => (b.height ?? 0) - (a.height ?? 0))
    .slice(0, 12)
    .map((n) => {
      const ctx = noteContext(n, { leaves, height: s.view.height, log: s.logItems });
      const t = noteTier(ctx, { route: noteRoute(s) });
      return html`<li class="act">
        <span class="act-ic">${sigil(n.asset.toString(), { size: 24 })}</span>
        <span class="act-main">
          <span class="act-title">${amountHTML(n.amount, n.div, n.ticker)}${n.locked ? tag("Reserved", "warn") : ""}</span>
          <span class="act-sub"><span>Hides among up to ${int(leaves)} notes</span><span>${plural(ctx.notesAfter, "note")} and ${plural(ctx.transfersSince, "private transfer")} since yours arrived</span></span>
        </span>
        <span class="act-side">${tierTag(t)}<span class="caption t-3">${n.height != null ? heightText(n.height) : ""}</span></span>
        <details class="act-extra"><summary class="caption t-2">Why ${t.label.toLowerCase()}?</summary><ul class="reasons">${t.reasons.map((r) => html`<li>${r}</li>`)}</ul>${t.advice ? html`<p class="caption t-warn" style="margin-top:6px">${t.advice}</p>` : ""}</details>
      </li>`;
    });
  return panel({
    eyebrow: "YOUR NOTES · CROWD METER",
    title: "How well each note is hidden",
    actions: html`<span class="caption t-3" data-tip="${UPPER_BOUND_TIP}" tabindex="0">${icon("info", { size: 14 })} Upper bound</span>`,
    body: html`<ul class="acts">${items}</ul>${notes.length > 12 ? html`<p class="caption t-3" style="margin-top:8px">Showing the 12 newest of ${int(notes.length)} notes.</p>` : ""}`,
  });
}

function addressCard(s) {
  return panel({
    eyebrow: "SHIELDED ADDRESS",
    title: "Receive privately",
    body: html`<div class="addr-card">
      <div class="stack stack--s">${zpHTML(s.address)}<p class="caption t-3">This address never appears on Bitcoin. Payments to it are encrypted notes only you can open.</p>
      <div class="inline-actions">${button({ label: "Request a payment", href: "/app/receive", kind: "secondary", size: "sm", icon: "qr" })}</div></div>
      ${masked() ? "" : qrSVG(s.address, { size: 132, label: "QR code of your shielded address" })}
    </div>`,
  });
}

/** The built-in key's BTC, up top beside the balances, with the way to add some. */
function fundStrip(s) {
  const unisat = s.payerPref === "unisat";
  const empty = !unisat && s.btc && s.btc.sats === 0;
  const note = unisat
    ? "Unisat pays mints and launches now. This key pays once you pick it."
    : empty
      ? `Add ${BTC_WORD} before your first mint, launch or private send you pay yourself.`
      : "Pays mints, launches and the private sends you pay yourself.";
  return html`<div class="fund-strip${empty ? " is-low" : ""}">
    <div class="fund-main">
      <div class="eyebrow">BTC FOR FEES · BUILT-IN KEY</div>
      <div class="fund-amt">${s.btc ? html`${satsHTML(s.btc.sats)} ${prov("BTC")}<span class="caption t-3">${rel(s.btc.at)}</span>` : html`<span class="small t-3">Balance not checked</span>`}</div>
      <div class="caption ${empty ? "t-warn" : "t-3"}">${note}</div>
    </div>
    ${button({ label: "Add BTC", kind: "secondary", icon: "plus", action: "add-btc" })}
  </div>`;
}

/** Only for a wallet that has topped up (prefs.relay): its relay balance and a way to top up. */
export function relayLine(s) {
  if (!s.relayPrefs) return "";
  const b = s.relayBalance;
  return html`<div class="sum-line" data-relay-line><span>Relay balance</span><span>${b ? html`${satsHTML(b.balance)}${b.reserved ? html` <span class="caption t-3">(${satsHTML(b.reserved)} reserved)</span>` : ""}` : html`<span class="t-3">not read yet</span>`} ${button({ label: "Top up", kind: "ghost", size: "sm", action: "relay-topup" })}</span></div>`;
}

function feeCard(s) {
  const btc = s.btc ? satsHTML(s.btc.sats) : html`<span class="t-3">not checked</span>`;
  return panel({
    eyebrow: "WHO PAYS BITCOIN FEES",
    title: "Fees and linkability",
    body: html`<div class="stack">
      <div class="stack stack--s"><div class="small">${s.routePref === "relay" ? html`<b>Private sends</b> go via the relayer, charged to your relay balance` : html`<b>Private sends</b> ${s.routePref === "copy" ? "are copied out as envelopes; whoever carries one pays its fee" : "are paid from your own Bitcoin wallet"}`}</div>
      ${s.routePref === "relay" ? linkMeter(3, LINK_TEXT.relayer) : linkMeter(2, LINK_TEXT.builtin)}</div>
      ${relayLine(s)}
      <div class="stack stack--s"><div class="small"><b>Mints and launches</b> are paid by ${s.payerPref === "unisat" ? "Unisat" : "the built-in key"}</div>${linkMeter(1, LINK_TEXT.mint)}</div>
      <div class="sum-line"><span>Built-in address</span><span>${btcHTML(s.localPayer.address)}</span></div>
      <div class="sum-line"><span>${IS_SIGNET ? "Signet BTC" : "BTC"}</span><span>${btc} ${s.btc ? prov("BTC") : ""}</span></div>
      <div class="inline-actions">${button({ label: "Add BTC", kind: "secondary", size: "sm", action: "add-btc", icon: "plus" })}${button({ label: "Check BTC", kind: "ghost", size: "sm", action: "check-btc", icon: "refresh" })}${button({ label: "Settings", href: "/app/settings#fees", kind: "ghost", size: "sm" })}</div>
      <p class="caption t-3">The balance is fetched from mempool.space only when you press Check BTC, open Add BTC or right before a mint, so a sync never tells anyone which address is yours.</p>
    </div>`,
  });
}

export function attention(s) {
  const tip = s.view?.height ?? null;
  const bad = s.history.filter((h) => h.status === "failed" || batchLate(h, tip));
  if (!bad.length) return "";
  return callout(html`<b>${plural(bad.length, "transfer")} need${bad.length === 1 ? "s" : ""} attention.</b> The notes stay reserved for a retry until their window closes. <a href="/app/activity?f=failed" data-link>Open activity</a>`, "warn");
}

export function renderPortfolio(root, s) {
  const paint = () => {
    root.innerHTML = html`<div class="wl">
      ${pageHead({ eyebrow: "PORTFOLIO", title: "Private balances", actions: button({ label: "Sync", kind: "ghost", size: "sm", icon: "refresh", action: "sync" }) })}
      ${stateLine(s)}
      ${attention(s)}
      <div class="quick">${button({ label: "Send", href: "/app/send", kind: "neutral", icon: "send" })}${button({ label: "Receive", href: "/app/receive", kind: "secondary", icon: "receive" })}${button({ label: "Mint", href: "/app/mint", kind: "secondary", icon: "mint" })}</div>
      ${fundStrip(s)}
      ${balances(s)}
      <div class="wl-cols">
        <div class="stack stack--l">${addressCard(s)}${notesPanel(s)}</div>
        <div class="stack stack--l">${panel({ eyebrow: "ANONYMITY SET", body: anonMeter({ notes: s.view ? s.view.outputs.length : null, tokens: s.view ? s.assetList.length : null, prov: "IDX" }) })}${feeCard(s)}</div>
      </div>
    </div>`;
  };
  paint();
  const onClick = async (e) => {
    const a = e.target.closest("[data-action]");
    if (!a) return;
    if (a.dataset.action === "sync") {
      a.disabled = true;
      s.sync().catch((err) => {
        a.disabled = false; // "Sync again" stays possible
        toastError(err, { title: "Sync failed." });
      });
    } else if (a.dataset.action === "check-btc") {
      a.disabled = true;
      s.checkBtc().catch((err) => toastError(err, { title: "Couldn't read the BTC balance." }));
    } else if (a.dataset.action === "add-btc") {
      openDeposit(s);
    }
  };
  root.addEventListener("click", onClick);
  const offLive = liveSession(s, paint);
  const offStreamer = wireStreamer(root, paint);
  return () => {
    root.removeEventListener("click", onClick);
    offLive();
    offStreamer();
  };
}

export function render(root) {
  return withWallet(root, (s) => renderPortfolio(root, s));
}

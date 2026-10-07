// /app/settings: security (auto-lock, lock now, streamer mode, change password,
// reveal phrase), who pays fees, the relay balance (only while a relay-balance relayer
// runs, docs/design/relay-balance.md), "Relayer books" with a browser-side audit,
// indexer, network activity, appearance and the danger zone.
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { int, sats, short, rel, heightText } from "../ui/format.js";
import { button, field, panel, segmented, kv, table, tag, payerCard } from "../ui/components.js";
import { prov } from "../ui/prov.js";
import { openSheet } from "../ui/sheet.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import { themeControl } from "../ui/theme.js";
import { linkMeter, LINK_TEXT } from "../ui/meter.js";
import { navigate } from "../router.js";
import { BRAND, EXPLORER, IS_SIGNET } from "../config.js";
import * as api from "../api.js";
import { KDF, KDF_MEMORY_MIB } from "../keystore.js";
import {
  AUTO_LOCK_CHOICES, autoLockMinutes, setAutoLock, lock, forgetWallet, revealPhrase, changePassword, streamerMode, setStreamerMode,
  onSessionChange, onStreamerChange, hasLegacy, revealLegacyPhrase, forgetLegacy,
} from "../session.js";
import { auditRelayer, mixState, poolMix, RELAY_OFF, relayerTxs, relayOpen, relayRotation, routeState } from "../relay.js";
import {
  withWallet, pageHead, wireStreamer, liveSession, btcHTML, satsHTML, masked, callout, passwordFields, wirePasswordFields, formError, LOCK_EVENTS,
  BATCH_TEXT, RELAY_TEXT,
} from "./app-shared.js";
import { payerCards } from "./app-mint.js";
import { openDeposit } from "./deposit.js";

let clipboardTimer = null;

/** What the relay balance adds to the wallet's requests (Settings, Network activity). */
export const RELAY_NETWORK_NOTE =
  "With a relay balance, the wallet also reads it from the relayer with a request signed by its relay account (on unlock, after a top-up or a relayed send, and once per block while the balance holds anything), and asks mempool.space about its deposit addresses while a payment is waiting or the top-up sheet is open. A wallet that never topped up makes neither request.";

/** Settings > Fees: the relay route, while a relay-balance relayer runs. Usable once the balance is in use (ok, low). */
export function settingsRelayCard(s) {
  const state = routeState(s.relayInfo, s.relayBalance, "block");
  const usable = state === "ok" || state === "low";
  const reason = usable
    ? null
    : state === "fee_high"
      ? RELAY_TEXT.feeHigh({ feeRate: s.relayInfo?.fees?.feeRate ?? "?", maxFeeRate: s.relayInfo?.fees?.maxFeeRate ?? "?" })
      : "Top up a relay balance first.";
  return payerCard({
    value: "relay", name: "route", title: RELAY_TEXT.cardTitle,
    status: s.relayBalance ? (masked() ? "Balance hidden" : RELAY_TEXT.cardStatus({ balance: s.relayBalance.balance })) : "no balance yet",
    checked: s.routePref === "relay", disabled: !usable, reason,
    // L1: "Linked" while the relay pool is thin: its coins descend from your own top-up.
    link: mixState(s.relayInfo) === "thin" ? { level: 1, text: RELAY_TEXT.thinCard } : { level: 3, text: LINK_TEXT.relayer },
  });
}

/**
 * The relay pool's lineage (privacy-trace-test.md L1), from relay info balance.mix: how many
 * separate accounts topped up, and whether a carrier can avoid descending from your own top-up.
 */
export function mixLine(info) {
  const m = poolMix(info);
  if (!m) return html`<p class="caption t-3" data-mix>${RELAY_TEXT.mixUnknown}</p>`;
  // mixState, not coverOk alone: a relayer whose k is below the wallet's floor gives no cover.
  return mixState(info) === "ok"
    ? html`<p class="caption t-2" data-mix>${RELAY_TEXT.mix(m)}</p>`
    : callout(html`<span data-mix>${RELAY_TEXT.mix(m)}</span>`, "warn");
}

/** Settings > Relay balance (#relay-balance), while a relay-balance relayer runs. */
export function relayBalancePanel(s) {
  if (!relayOpen()) return "";
  const b = s.relayBalance;
  const i = s.relayInfo;
  let next = "—";
  try {
    next = `#${int(s.depositIndex)}`;
  } catch {}
  return panel({
    id: "relay-balance",
    eyebrow: "RELAY BALANCE",
    title: "Relay balance",
    body: html`<div class="stack stack--l">
      <p class="small t-2">${RELAY_TEXT.topUpOnce} A relayer carries your private sends in its own Bitcoin transactions and charges the exact fee plus a margin to this balance. The operator never pays any part of your transaction.</p>
      ${b
        ? kv([
            ["Available", html`${satsHTML(b.balance)} ${prov("IDX")}`],
            ["Reserved", html`${satsHTML(b.reserved)} <span class="caption t-3">held for sends waiting for their batch</span>`],
            ["Recent deposits", html`<span class="mono">${int(b.credits.length)}</span> <span class="caption t-3">the relayer forgets whose a top-up was once it is no longer recent</span>`],
            ["Next deposit address", html`<span class="mono">${next}</span>`],
          ])
        : html`<p class="small t-3">Not read yet. Reading it sends a request signed by this wallet's relay account to the relayer.</p>`}
      <div class="inline-actions">${button({ label: "Top up", kind: "secondary", size: "sm", icon: "plus", action: "relay-topup" })}${b ? "" : button({ label: "Read my relay balance", kind: "ghost", size: "sm", icon: "refresh", action: "relay-read" })}</div>
      ${i?.stats ? html`<p class="caption t-2">${RELAY_TEXT.meter(i.stats.relayed144 ?? 0)}</p>` : ""}
      ${mixLine(i)}
      ${callout(RELAY_TEXT.operator, "warn")}
    </div>`,
  });
}

/** Hosts this tab has contacted, from the browser's own resource timing log. */
export function networkHosts() {
  const counts = new Map();
  const add = (url) => {
    try {
      const u = new URL(url, location.href);
      if (u.protocol === "data:" || u.protocol === "blob:") return;
      counts.set(u.host, (counts.get(u.host) ?? 0) + 1);
    } catch {}
  };
  add(location.href);
  for (const e of performance.getEntriesByType?.("resource") ?? []) add(e.name);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Wipes and closes the phrase sheet on any lock (idle, manual, another tab, forget) or
 * when streamer mode turns on. Returns { wiped, off() }.
 */
export function guardReveal(sheet) {
  const offSession = onSessionChange((type) => (LOCK_EVENTS.has(type) || type === "forget") && wipe());
  const offStreamer = onStreamerChange((on) => on && wipe());
  const guard = { wiped: false, off: () => (offSession(), offStreamer()) };
  function wipe() {
    guard.wiped = true;
    guard.off();
    sheet.setBody("");
    sheet.close();
  }
  return guard;
}

const HIDE_ON = ["pointerup", "pointercancel", "blur"];
// What each kind of relayer ledger row is (relay-balance.md §2 and §9); anything else is a carrier.
const LEDGER_KIND = { fanout: "fan-out", merge: "merge", evacuation: "evacuation", "retired-sweep": "late deposit sweep", refund: "pool refill" };
/**
 * Press-and-hold for the recovery words (`wrap` loses .is-hidden while `hold` is pressed).
 * They hide again as soon as the press ends anywhere, or when the window or the tab loses
 * focus mid-press: Alt-Tab sends the page no pointerup or keyup. Returns off(), which
 * removes the window and document listeners. `win` and `doc` are for tests.
 */
export function wireHold(wrap, hold, { win = globalThis, doc = globalThis.document } = {}) {
  const hide = () => wrap.classList.add("is-hidden");
  const onHidden = () => doc.hidden && hide();
  hold.addEventListener("pointerdown", (ev) => (ev.preventDefault(), wrap.classList.remove("is-hidden")));
  hold.addEventListener("keydown", (ev) => (ev.key === " " || ev.key === "Enter") && wrap.classList.remove("is-hidden"));
  hold.addEventListener("keyup", hide);
  for (const t of HIDE_ON) win.addEventListener(t, hide);
  doc.addEventListener("visibilitychange", onHidden);
  return () => {
    for (const t of HIDE_ON) win.removeEventListener(t, hide);
    doc.removeEventListener("visibilitychange", onHidden);
  };
}

/**
 * Password, then the words behind press-and-hold; wiped on any lock or streamer mode.
 * reveal(password) -> phrase. after: { markup, wire(sheet) } adds controls under the words.
 */
function phraseSheet({ title, warning, reveal, after = null }) {
  let guard = null;
  let offHold = () => {};
  const sheet = openSheet({
    title,
    eyebrow: "PASSWORD REQUIRED",
    onClose: () => (guard?.off(), offHold()),
    body: html`<form class="stack" data-reveal novalidate>
      ${callout(warning, "warn")}
      ${field({ label: "Password", name: "password", type: "password", attrs: { autocomplete: "current-password", autofocus: true } })}
      <span data-error-anchor></span>
      ${button({ label: "Show phrase", type: "submit", kind: "neutral", icon: "eye" })}
    </form>`,
  });
  guard = guardReveal(sheet);
  const form = sheet.body.querySelector("[data-reveal]");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    formError(form, null);
    const pw = form.querySelector("[name=password]");
    try {
      const phrase = await reveal(pw.value);
      pw.value = "";
      if (guard.wiped) return; // locked while the password was checked
      const words = phrase.split(" ");
      sheet.setBody(html`<div class="stack">
        <div class="phrase-wrap is-hidden" data-phrase>
          <ol class="phrase-grid" aria-label="Recovery words">${words.map((w, i) => html`<li class="pw"><i>${i + 1}</i><b>${w}</b></li>`)}</ol>
          <div class="phrase-hold">${button({ label: "Press and hold to show", kind: "neutral", icon: "eye", action: "hold" })}</div>
        </div>
        <div class="inline-actions">${button({ label: "Copy words", kind: "ghost", size: "sm", icon: "copy", action: "copy" })}</div>
        <p class="caption t-3">The clipboard is cleared after 30 seconds if this tab still has focus (best effort).</p>
        ${after?.markup ?? ""}
      </div>`);
      offHold = wireHold(sheet.body.querySelector("[data-phrase]"), sheet.body.querySelector("[data-action=hold]"));
      sheet.body.querySelector("[data-action=copy]").addEventListener("click", async () => {
        if (!(await copyText(phrase))) return;
        toast({ kind: "warn", title: "Words copied.", body: "Paste them somewhere offline. The clipboard is cleared in 30 s if this tab still has focus." });
        clearTimeout(clipboardTimer);
        clipboardTimer = setTimeout(() => document.hasFocus() && navigator.clipboard?.writeText("").catch(() => {}), 30_000);
      });
      after?.wire(sheet);
    } catch (err) {
      formError(form, err.name === "WrongPassword" ? "Wrong password. Try again." : err.message);
    }
  });
}

function revealSheet() {
  phraseSheet({
    title: "Show recovery phrase",
    warning: html`<b>Anyone who sees these words owns your notes.</b> Make sure nobody is watching and you aren't screen sharing.`,
    reveal: revealPhrase,
  });
}

/** The zkpool-era phrase left beside the vault: shown like the recovery phrase, then deleted. */
function legacySheet(onDeleted) {
  phraseSheet({
    title: "Show the older phrase",
    warning: html`<b>Anyone who sees these words owns that wallet's notes.</b> Enter the password of the wallet that's open. Make sure nobody is watching and you aren't screen sharing.`,
    reveal: revealLegacyPhrase,
    after: {
      markup: html`<label class="cluster small"><input type="checkbox" data-kept> I wrote these 24 words down, or I don't need that wallet.</label>
        <div class="inline-actions">${button({ label: "Delete the unencrypted copy", kind: "danger", size: "sm", icon: "cross", action: "forget-legacy", disabled: true })}</div>`,
      wire(sheet) {
        const del = sheet.body.querySelector("[data-action=forget-legacy]");
        sheet.body.querySelector("[data-kept]").addEventListener("change", (e) => (del.disabled = !e.target.checked));
        del.addEventListener("click", () => {
          try {
            forgetLegacy();
          } catch (err) {
            return toast({ kind: "danger", title: "That didn't work.", body: err.message });
          }
          sheet.setBody("");
          sheet.close();
          toast({ kind: "success", title: "Unencrypted copy deleted.", body: "Only those 24 words can bring that older wallet back." });
          onDeleted();
        });
      },
    },
  });
}

/**
 * "Batches" in Relayer books: what each length holds now and the recent releases, as
 * the relayer reports them (relay info `batch`). Empty when the relayer has no batch info.
 */
export function batchesBlock(batch) {
  if (!batch?.modes) return "";
  const now = (mode) => {
    const m = batch.modes[mode];
    if (!m) return null;
    const off = m.enabled !== true || m.maxPerEpoch === 0; // as relay.js: only an enabled length takes sends
    const c = m.current;
    return [BATCH_TEXT.now[mode], off || !c ? html`<span class="t-3">${BATCH_TEXT.nowOff}</span>` : html`<span class="mono">${BATCH_TEXT.nowValue({ queued: c.queued, releaseAt: c.releaseAt })}</span> ${prov("IDX")}`];
  };
  const C = BATCH_TEXT.recentColumns;
  // Newest release first, both lengths together.
  const recent = [...(batch.recent ?? [])].sort((a, b) => (b.releaseAt ?? 0) - (a.releaseAt ?? 0)).slice(0, 12);
  const rows = recent.map((r) => ({
    batch: BATCH_TEXT.label[r.mode] ?? r.mode,
    anchor: html`<span class="mono">${heightText(r.start)}</span>`,
    sent: html`<span class="mono">${int(r.released)}</span>`,
    landed: r.landed?.length ? html`<span class="mono">${BATCH_TEXT.landedIn(r.landed)}</span>` : "—",
  }));
  return html`<div class="stack stack--s" data-batches><div class="small"><b>${BATCH_TEXT.title}</b></div>
    ${kv([now("batch"), now("batch10")].filter(Boolean))}
    ${table({ caption: BATCH_TEXT.recentTitle, columns: [{ key: "batch", label: C.batch }, { key: "anchor", label: C.anchor, align: "right" }, { key: "sent", label: C.sent, align: "right" }, { key: "landed", label: C.landed }], rows, empty: BATCH_TEXT.recentEmpty })}
    <p class="caption t-3">${BATCH_TEXT.settingsCaption}</p></div>`;
}

/** The batch part of an audit result: sizes against Bitcoin, and each mismatch. */
export function auditBatches(b) {
  if (!b || !b.total) return "";
  const bad = (b.rows ?? []).filter((r) => !r.ok);
  return html`<div class="stack stack--s" data-audit-batches>${callout(html`<b>${BATCH_TEXT.auditLine({ matched: b.matched, total: b.total })}</b> ${prov("YOU")}`, bad.length ? "warn" : "proof")}${
    bad.length ? html`<ul class="reasons">${bad.slice(0, 8).map((r) => html`<li>${BATCH_TEXT.mismatch(r)}</li>`)}</ul>` : ""
  }</div>`;
}

export function settingsView(root, s) {
  let audit = null;
  let ledger = null;
  let indexerTest = null;

  const security = () =>
    panel({
      id: "security",
      eyebrow: "SECURITY",
      title: "Lock and encryption",
      body: html`<div class="stack stack--l">
        <div class="seg-row"><div><div class="small"><b>Auto-lock after</b></div><div class="caption t-3">Idle means no pointer or key activity in this tab.</div></div>
          ${segmented(AUTO_LOCK_CHOICES.map((m) => ({ value: String(m), label: m === 0 ? "Never" : m === 60 ? "1 h" : `${m} min` })), { value: String(autoLockMinutes()), name: "autolock", label: "Auto-lock after" })}</div>
        <div class="seg-row"><div><div class="small"><b>Streamer mode</b></div><div class="caption t-3">Hides every amount and address on every wallet screen, toasts included, and refuses to show the phrase.</div></div>
          ${segmented([{ value: "off", label: "Off" }, { value: "on", label: "On" }], { value: streamerMode() ? "on" : "off", name: "streamer", label: "Streamer mode" })}</div>
        <div class="inline-actions">
          ${button({ label: "Lock now", kind: "secondary", icon: "lock", action: "lock" })}
          ${button({ label: "Show recovery phrase", kind: "secondary", icon: "eye", action: "reveal", disabled: masked(), reason: masked() ? "Turn off streamer mode first." : null })}
        </div>
        <details><summary class="small"><b>Change password</b></summary>
          <form class="stack" data-chpw novalidate style="margin-top:12px">
            ${field({ label: "Current password", name: "old", type: "password", attrs: { autocomplete: "current-password" } })}
            ${passwordFields({ label: "New password", autofocus: false })}
            <span data-error-anchor></span>
            ${button({ label: "Change password", type: "submit", kind: "neutral" })}
          </form>
        </details>
        <div class="callout">${icon("info", { size: 16 })}<div>
          <b>What the lock protects.</b> Your phrase and history are stored only encrypted (XChaCha20-Poly1305, key from ${KDF.name} N = ${KDF.N.toLocaleString("en-US")}, r = ${KDF.r}, p = ${KDF.p}, about ${KDF_MEMORY_MIB} MiB). That protects data at rest. While unlocked, keys live in this tab's memory, where a malicious browser extension or a compromised page could read them. Anyone holding a copy of the encrypted vault can try passwords offline, so use a long one. Your 24 words stay the root of everything.
        </div></div>
      </div>`,
    });

  const fees = () =>
    panel({
      id: "fees",
      eyebrow: "FEES",
      title: "Who pays Bitcoin fees",
      body: html`<div class="stack stack--l">
        <div class="stack stack--s"><div class="small"><b>Private sends go via</b></div>
          <div class="payers">
            ${relayOpen() ? settingsRelayCard(s) : ""}
            ${payerCard({ value: "self", name: "route", title: "Pay the fee myself", status: s.payerPref === "unisat" ? "Unisat" : "built-in key", checked: s.routePref === "self", link: { level: 2, text: "Bitcoin shows this address paid for every transfer it pays, permanently." } })}
            ${payerCard({ value: "copy", name: "route", title: "Copy envelope", status: "anyone can carry it", checked: s.routePref === "copy", link: { level: 2, text: "Whoever carries the envelope pays the fee, and Bitcoin ties the transfer to their address." } })}
          </div>
          <p class="caption t-2">The paying address is tied to the transfer on Bitcoin. Fund the built-in key from a source not linked to your main wallet.</p>
          ${relayOpen() ? "" : html`<p class="caption t-3">${RELAY_OFF}</p>`}</div>
        <div class="stack stack--s"><div class="small"><b>Mints and launches are paid by</b></div><div class="payers">${payerCards(s, "mint-payer")}</div></div>
        ${kv([
          ["Built-in address", btcHTML(s.localPayer.address)],
          [IS_SIGNET ? "Signet BTC" : "BTC", s.btc ? html`${satsHTML(s.btc.sats)} ${prov("BTC")} <span class="caption t-3">${rel(s.btc.at)}</span>` : html`<span class="t-3">not checked</span>`],
          ["Unisat", s.unisat ? btcHTML(s.unisat.address) : html`<span class="t-3">not connected</span>`],
        ])}
        <div class="inline-actions">
          ${button({ label: "Add BTC", kind: "secondary", size: "sm", icon: "plus", action: "add-btc" })}
          ${button({ label: "Check BTC", kind: "ghost", size: "sm", icon: "refresh", action: "check-btc" })}
          ${s.unisat ? "" : button({ label: "Connect Unisat", kind: "ghost", size: "sm", action: "unisat" })}
        </div>
        <p class="caption t-3">${s.payerPref === "unisat" ? "Unisat pays from its own address. Add BTC funds the built-in key, for when you pick it instead." : "Add BTC shows the built-in key's address and how to keep it apart from your other wallets."}</p>
      </div>`,
    });

  const relayer = () => {
    const i = s.relayInfo;
    if (!i) return panel({ id: "relayer", eyebrow: "RELAY", title: "Relayer books", body: html`<span class="skel" style="width:100%;height:80px"></span>` });
    if (!i.address) {
      return panel({
        id: "relayer",
        eyebrow: "RELAY",
        title: "Relayer books",
        body: callout(i.error ? "Can't reach the relayer right now." : "No relayer runs on this server. Pay the fee yourself, or copy the envelope.", "info"),
      });
    }
    const relayed = i.stats?.relayed144 ?? 0;
    const ledgerRows = (ledger?.items ?? []).slice(0, 15).map((l) => ({
      kind: LEDGER_KIND[l.kind] ?? "carrier",
      tx: html`<a class="mono" href="${EXPLORER}/tx/${l.txid}" target="_blank" rel="noopener noreferrer">${short(l.txid, 8, 6)}</a>`,
      fee: html`<span class="mono">${sats(l.fee)}</span>`,
      outcome: tag(l.outcome, l.outcome === "accepted" ? "proof" : l.outcome === "rejected" ? "danger" : "neutral"),
      block: l.height != null ? heightText(l.height) : "—",
    }));
    return panel({
      id: "relayer",
      eyebrow: "RELAY",
      title: "Relayer books",
      body: html`<div class="stack stack--l">
        <p class="small t-2">Every carrier is on Bitcoin. Carriers are funded only from coins users deposited to their relay balances; all change goes to one public address. The relayer publishes a ledger, and your browser can check that ledger against Bitcoin.</p>
        ${kv([
          ["Relayer change address", html`<a class="mono" href="${EXPLORER}/address/${i.address}" target="_blank" rel="noopener noreferrer">${short(i.address, 10, 8)} ↗</a>`],
          ["Relayed in the last 144 blocks", html`<span class="mono">${int(relayed)}</span> ${prov("IDX")}`],
          ["Separate depositors", poolMix(i)?.depositors != null ? html`<span class="mono">${int(poolMix(i).depositors)}</span> ${prov("IDX")}` : RELAY_TEXT.mixUnknownShort],
          ["Fee rate", `${i.fees?.feeRate ?? "—"} sat/vB (cap ${i.fees?.maxFeeRate ?? "—"})`],
        ])}
        ${relayed < 5 ? callout("Few relayed transfers right now; timing can still link you.", "warn") : ""}
        ${!relayRotation(i).depositsOpen ? callout(RELAY_TEXT.paused, "warn") : relayRotation(i).retired.length ? callout(RELAY_TEXT.rotated, "info") : ""}
        ${batchesBlock(i.batch)}
        ${ledger ? html`<div class="stack stack--s"><div class="small"><b>Ledger</b> · ${int(ledger.totals?.carriers)} carriers, ${int(ledger.totals?.accepted)} accepted, ${int(ledger.totals?.wasted)} wasted, ${sats(ledger.totals?.satsSpent)} spent</div>
          ${table({ caption: "Relayer ledger", columns: [{ key: "kind", label: "Kind" }, { key: "tx", label: "Transaction" }, { key: "fee", label: "Fee", align: "right" }, { key: "outcome", label: "Outcome" }, { key: "block", label: "Block", align: "right" }], rows: ledgerRows, empty: "No carriers yet." })}</div>` : ""}
        <div class="stack stack--s">
          <div class="inline-actions">${button({ label: "Audit the relayer", kind: "neutral", icon: "proof", action: "audit", loading: audit === "running" ? "Checking Bitcoin…" : null })}</div>
          ${audit && audit !== "running" ? auditResult(audit) : html`<p class="caption t-3">Your browser fetches the relayer address's transactions from mempool.space, decodes every OP_RETURN locally and compares each fee with the ledger. It only looks up the relayer's public address, so it reveals nothing about you.</p>`}
        </div>
      </div>`,
    });
  };

  const auditResult = (a) => {
    if (a.error) return callout(html`<b>Audit failed.</b> ${a.error}`, "danger");
    const bad = a.rows.filter((r) => !r.ok);
    return html`<div class="stack stack--s">${callout(
      html`<b>Ledger matches Bitcoin: ${int(a.matched)}/${int(a.total)}</b> ${prov("YOU")}<div class="caption t-2">${int(a.rows.filter((r) => r.kind === "carrier").length)} carriers, ${int(a.rows.filter((r) => r.kind === "fanout" || r.kind === "merge").length)} fan-outs and merges in the ${int(a.rows.length)} most recent transactions${a.foreign ? `, and ${int(a.foreign)} not made by the relayer (it never spends such coins)` : ""}.</div>`,
      bad.length > (a.foreign ?? 0) ? "warn" : "proof",
    )}${bad.length ? html`<ul class="reasons">${bad.slice(0, 8).map((r) => html`<li><span class="mono">${short(r.txid, 8, 6)}</span>: ${r.note}</li>`)}</ul>` : ""}${auditBatches(a.batches)}</div>`;
  };

  const indexer = () =>
    panel({
      id: "indexer",
      eyebrow: "INDEXER",
      title: "Use your own indexer",
      body: html`<form class="stack" data-indexer novalidate>
        <p class="small t-2">Currently: <span class="mono">${api.indexerBase() || `${location.origin} (this site)`}</span>. Your wallet rebuilds the note tree from whatever indexer it uses and checks it against that indexer's root. That catches an indexer whose list and root disagree, not one that serves a consistent fake list: Verify the Pool checks against Bitcoin.</p>
        ${field({ label: "Indexer URL", name: "url", value: api.indexerBase(), placeholder: "https://indexer.example.com", mono: true, attrs: { autocomplete: "off", spellcheck: "false" } })}
        <div class="inline-actions">${button({ label: "Test connection", kind: "secondary", size: "sm", action: "test-indexer", loading: indexerTest === "running" ? "Testing…" : null })}${button({ label: "Use this indexer", kind: "neutral", size: "sm", action: "use-indexer" })}${api.indexerBase() ? button({ label: "Back to this site's indexer", kind: "ghost", size: "sm", action: "reset-indexer" }) : ""}</div>
        ${indexerTest && indexerTest !== "running" ? (indexerTest.ok ? callout(indexerTest.text, "proof") : callout(indexerTest.text, "danger")) : ""}
        <p class="caption t-3">This site's security policy only lets the page talk to itself and mempool.space, so a different indexer may be blocked here. The sure way is to serve this wallet from your own indexer (npm run indexer).</p>
      </form>`,
    });

  const network = () => {
    const hosts = networkHosts();
    return panel({
      id: "network",
      eyebrow: "NETWORK ACTIVITY",
      title: "Every host this tab contacted",
      body: html`<ul class="netlist">${hosts.map(([h, n]) => html`<li><span>${h}</span><span class="t-3">${int(n)} ${n === 1 ? "request" : "requests"}</span></li>`)}</ul>
        <p class="caption t-3" style="margin-top:8px">From your browser's own timing log. Expect this site and mempool.space only: no analytics, no fonts or scripts from anyone else. Requests to the indexer are bulk downloads every wallet makes, with one exception: until a relayed transfer lands or expires, each sync asks the relayer about it by its relay id, so the relayer can tie your IP at that moment to that transfer. ${BATCH_TEXT.networkNote} ${RELAY_NETWORK_NOTE}</p>
        <div class="inline-actions" style="margin-top:8px">${button({ label: "Refresh", kind: "ghost", size: "sm", icon: "refresh", action: "net-refresh" })}</div>`,
    });
  };

  const appearance = () => panel({ id: "appearance", eyebrow: "APPEARANCE", title: "Theme", body: themeControl({ size: "md" }) });

  // Left by an older build: another wallet's phrase, unencrypted, beside this vault.
  const legacy = () =>
    hasLegacy()
      ? panel({
          id: "older-phrase",
          eyebrow: "OLDER WALLET",
          title: "An unencrypted recovery phrase is still stored here",
          cls: "danger-zone",
          body: html`<div class="stack">
            ${callout(html`This browser also holds a recovery phrase from before ${BRAND} got its name, stored <b>unencrypted</b>. It belongs to a different wallet from the one that's open. Show it with this wallet's password, write it down if you still need that wallet, then delete the plaintext copy.`, "warn")}
            <div class="inline-actions">${button({ label: "Show the older phrase", kind: "secondary", icon: "eye", action: "reveal-legacy", disabled: masked(), reason: masked() ? "Turn off streamer mode first." : null })}</div>
          </div>`,
        })
      : "";

  const danger = () =>
    panel({
      id: "danger",
      eyebrow: "DANGER ZONE",
      title: "Remove wallet from this browser",
      cls: "danger-zone",
      body: html`<form class="stack" data-remove novalidate>
        <p class="small t-2">Deletes the encrypted wallet and its history from this browser. Your notes stay on Bitcoin; only your 24 words can bring them back. Activity history can't be restored.${hasLegacy() ? " The older unencrypted phrase stored here is deleted too." : ""}</p>
        ${field({ label: "Type REMOVE to confirm", name: "confirm", mono: true, attrs: { autocomplete: "off", autocapitalize: "characters" } })}
        <span data-error-anchor></span>
        ${button({ label: "Remove wallet", type: "submit", kind: "danger", icon: "cross" })}
      </form>`,
    });

  const paint = () => {
    root.innerHTML = html`<div class="wl">
      ${pageHead({ eyebrow: "SETTINGS", title: "Settings" })}
      ${legacy()}${security()}${fees()}<div data-relay-balance-slot style="display:contents">${relayBalancePanel(s)}</div><div data-relayer-slot style="display:contents">${relayer()}</div>${indexer()}${network()}${appearance()}${danger()}
    </div>`;
    const chpw = root.querySelector("[data-chpw]");
    const validate = wirePasswordFields(chpw);
    chpw.addEventListener("submit", async (e) => {
      e.preventDefault();
      formError(chpw, null);
      let next;
      try {
        next = validate();
      } catch (err) {
        return formError(chpw, err.message);
      }
      const btn = chpw.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        await changePassword(chpw.querySelector("[name=old]").value, next);
        toast({ kind: "success", title: "Password changed.", body: "The vault was re-encrypted under the new password." });
        paint();
      } catch (err) {
        btn.disabled = false;
        formError(chpw, err.name === "WrongPassword" ? "The current password is wrong." : err.message);
      }
    });
    root.querySelector("[data-remove]").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = e.target;
      if (f.querySelector("[name=confirm]").value.trim() !== "REMOVE") return formError(f, "Type REMOVE in capitals to confirm.");
      forgetWallet();
      toast({ kind: "info", title: "Wallet removed from this browser.", body: "Restore it any time from your 24 words." });
      navigate("/app");
    });
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  };

  async function runAudit() {
    audit = "running";
    paint();
    try {
      // Fresh info: the batch counts it reports are compared with what Bitcoin shows now.
      const i = await s.loadRelayInfo();
      if (!i?.address) throw new Error(i?.error ? "Can't reach the relayer right now." : "The relayer is turned off on this server.");
      ledger = await api.relay.ledger({ limit: 500 });
      const txs = await relayerTxs(api.esplora, i.address);
      // The mined assets' service-fee outputs, so mining claim carriers are checked, not flagged.
      const mine = await api.mine({ fresh: true }).catch(() => null);
      audit = auditRelayer({ address: i.address, txs, ledger: ledger.items ?? [], batch: i.batch ?? null, mine });
    } catch (err) {
      audit = { error: err.message };
    }
    paint();
  }

  async function testIndexer(url) {
    indexerTest = "running";
    paint();
    try {
      const base = url.trim().replace(/\/+$/, "");
      if (!/^https?:\/\/[^\s/]+/.test(base)) throw new Error("Use a full address such as https://indexer.example.com.");
      const theirs = await (await fetch(`${base}/api/state`, { cache: "no-store" })).json();
      api.checkStateNetwork(theirs);
      const h = Math.min(theirs.height, s.view?.height ?? theirs.height);
      const [a, b] = await Promise.all([
        fetch(`${base}/api/roots?height=${h}`, { cache: "no-store" }).then((r) => r.json()),
        api.roots({ from: h, to: h }).then((rows) => rows[0]?.[1] ?? null),
      ]);
      const same = a.root && b && a.root === b;
      indexerTest = { ok: same, text: same ? `Connected. Its root at ${heightText(h)} matches this site's indexer.` : `Connected, but its root at ${heightText(h)} differs from this site's. One of them is wrong or on another network.` };
    } catch (err) {
      indexerTest = { ok: false, text: `Can't use it: ${err.message}` };
    }
    paint();
  }

  const onClick = async (e) => {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    try {
      switch (b.dataset.action) {
        case "lock":
          lock("manual");
          return navigate("/app");
        case "reveal":
          return revealSheet();
        case "reveal-legacy":
          return legacySheet(paint);
        case "add-btc":
          return openDeposit(s);
        case "check-btc":
          b.disabled = true;
          await s.checkBtc();
          return paint();
        case "unisat":
          await s.connectUnisat();
          return paint();
        case "audit":
          return runAudit();
        case "relay-read":
          b.disabled = true;
          await s.loadRelayBalance();
          return paint();
        case "test-indexer":
          return testIndexer(root.querySelector("[data-indexer] [name=url]").value);
        case "use-indexer":
          // Refused (and the old indexer kept) unless it serves this build's network.
          await api.useIndexer(root.querySelector("[data-indexer] [name=url]").value);
          s.view = null;
          toast({ kind: "info", title: "Indexer changed.", body: "Your wallet resyncs from it and checks its root." });
          s.sync().catch(() => {});
          return paint();
        case "reset-indexer":
          api.setIndexerBase("");
          s.view = null;
          s.sync().catch(() => {});
          return paint();
        case "net-refresh":
          return paint();
      }
    } catch (err) {
      toast({ kind: "danger", title: "That didn't work.", body: err.message });
    }
  };
  const onSeg = (e) => {
    if (e.detail?.name === "autolock") {
      setAutoLock(Number(e.detail.value));
      toast({ kind: "info", title: Number(e.detail.value) ? `Locks after ${e.detail.value === "60" ? "1 h" : e.detail.value + " min"} idle.` : "Auto-lock is off.", body: Number(e.detail.value) ? null : "The wallet stays unlocked until you lock it or close the tab.", timeout: 3000 });
    } else if (e.detail?.name === "streamer") setStreamerMode(e.detail.value === "on");
  };
  const onChange = (e) => {
    if (e.target.name === "route") s.routePref = e.target.value;
    else if (e.target.name === "mint-payer") {
      s.payerPref = e.target.value;
      paint();
    }
  };
  paint();
  root.addEventListener("click", onClick);
  root.addEventListener("seg-change", onSeg);
  root.addEventListener("change", onChange);
  s.loadRelayInfo().then(async () => {
    // The balance is read here only for a wallet that has topped up (prefs.relay).
    if (relayOpen() && s.relayPrefs && !s.relayBalance) s.loadRelayBalance().catch(() => {});
    try {
      if (s.relayInfo?.address) ledger = await api.relay.ledger({ limit: 100 });
    } catch {}
    paint();
  });
  // "Hourly batch now" and Recent batches follow the chain: relay info again at most once per new
  // block, repainting only Relayer books (the forms on this page keep what was typed).
  let infoHeight = s.view?.height ?? null;
  const paintRelayer = () => {
    const el = root.querySelector("[data-relayer-slot]");
    if (el) el.innerHTML = relayer();
  };
  const offLive = liveSession(
    s,
    (type) => {
      if (type === "btc" || type === "payer" || type === "relay-balance") return paint();
      const h = s.view?.height ?? null;
      if (type !== "sync" || h === null || h === infoHeight || audit === "running") return;
      infoHeight = h;
      s.loadRelayInfo().then(paintRelayer).catch(() => {});
    },
    { syncNow: !s.view },
  );
  const offStreamer = wireStreamer(root, paint);
  return () => {
    root.removeEventListener("click", onClick);
    root.removeEventListener("seg-change", onSeg);
    root.removeEventListener("change", onChange);
    offLive();
    offStreamer();
  };
}

export function render(root) {
  return withWallet(root, (s) => settingsView(root, s));
}

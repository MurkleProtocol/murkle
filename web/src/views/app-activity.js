// /app/activity: your history (sealed in the vault) plus notes received from
// others (found by trial decryption). Statuses come from bulk data, except relayed
// transfers, polled by relay id until they land or expire (a batch transfer only
// once its batch goes out). Failed sends offer the W-1-safe recovery paths: pay the
// fee yourself or copy the envelope for anyone to carry; retrying through a relayer
// (in the next batch, or at the next block) only while relaying is open (relay.js).
// A send the relayer missed (its relay balance or the fee cap, when it was due) says so
// and offers the next batch, the next block, paying yourself and copying; a carrier stuck
// for 6 blocks offers paying yourself or copying (the relayer never bumps). Transfers the
// retired operator-paid relayer held answer "dropped" with its reason and offer the same two paths.
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { int, rel, heightText, eta, short } from "../ui/format.js";
import { button, empty, disclosure } from "../ui/components.js";
import { proofprint } from "../ui/proofprint.js";
import { sealPill } from "../ui/seal.js";
import { openSheet } from "../ui/sheet.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import * as api from "../api.js";
import { ANCHOR_WINDOW, batchLate, batchPhase, lastReleaseFor, relayStranded, relayStuck, retryChoices } from "../session.js";
import { isBatchMode, savedMode } from "../../../src/relay-batch.mjs";
import {
  withWallet, pageHead, wireStreamer, liveSession, amountHTML, zpHTML, btcHTML, satsHTML, masked, statusChip, provingSheet, callout, BATCH_TEXT,
  RELAY_TEXT,
} from "./app-shared.js";
import { SEND_STEPS, sendText } from "./app-send.js";
import { quoteFor, relayOpen, routeState } from "../relay.js";

// Retry choices that go through a relayer: hidden while relaying is unavailable.
const RELAY_CHOICES = new Set(["relay", "next-batch", "next-block"]);
/** The retry a relayer refused for a thin pool (pool_thin): the button names the consequence. */
export const RETRY_LINKABLE = "Send it linkable (ties it to your top-up address)";

/** The relay mode a retry choice would send in (as s.retry: a batch entry retries in its own batch length). */
const choiceMode = (h, id) => (id === "next-block" ? "block" : savedMode(h.mode) ?? "block");

/**
 * Whether the relay balance, as last read, cannot pay a relayed retry in `mode`: routeState
 * "low" or "none". An unread balance ("unknown") does not block: the relayer decides.
 */
export function relayShort(s, mode) {
  const st = routeState(s?.relayInfo ?? null, s?.relayBalance ?? null, mode);
  return st === "low" || st === "none";
}

const FILTERS = [
  ["all", "All"],
  ["sent", "Sent"],
  ["received", "Received"],
  ["minted", "Minted"],
  ["launched", "Launched"],
  ["failed", "Failed"],
];
const KIND = { send: "Sent", receive: "Received", mint: "Minted", deploy: "Launched", mine: "Mined" };
const KIND_ICON = { send: "send", receive: "receive", mint: "mint", deploy: "launch", mine: "mint" };

/** Filter `f` at tip `tip`: "failed" also holds batch sends the relayer is late with or missed, and stuck carriers. */
export function matches(f, h, tip = null) {
  switch (f) {
    case "sent":
      return h.kind === "send";
    case "received":
      return h.kind === "receive";
    case "minted":
      return h.kind === "mint";
    case "launched":
      return h.kind === "deploy";
    case "failed":
      return ["failed", "rejected", "expired", "dropped"].includes(h.status) || batchLate(h, tip) || relayStuck(h, tip);
    default:
      return true;
  }
}

const sentOut = (h) => h.relayStatus === "broadcast" || h.relayStatus === "accepted";
/** A batch send the relayer gave up on past its lastRelease (relay status "expired"): the missed copy, not the raw reason. */
const relayerMissed = (h) => h.kind === "send" && isBatchMode(h.mode) && h.status === "failed" && h.relayStatus === "expired";

function seal(h, tip) {
  const conf = h.height != null && tip != null ? tip - h.height + 1 : null;
  switch (h.status) {
    case "accepted":
      return sealPill({ state: "accepted", height: h.height, confirmations: conf });
    case "rejected":
      return sealPill({ state: "rejected", height: h.height, reason: h.reason });
    case "relaying":
      // A batch transfer the relayer still holds is not in any mempool, nor is one no relayer will send.
      return relayStranded(h) || (isBatchMode(h.mode) && !sentOut(h)) ? "" : sealPill({ state: "mempool" });
    case "mempool":
      return sealPill({ state: "mempool" });
    case "legacy":
    case "copied":
      return "";
    default:
      return sealPill({ state: "dropped" });
  }
}

/** The relayer's published row for the batch a send went out with (relay info `batch.recent`). */
export function batchRecent(info, h) {
  return (info?.batch?.recent ?? []).find((r) => r.mode === h.mode && r.start === h.anchor) ?? null;
}

/** Status lines of a batch send at tip `tip` (batch-contract.md §5.2, Activity); [] for other entries. */
export function batchLines(h, tip, info = null) {
  if (tip == null) return [];
  const phase = batchPhase(h, tip);
  const p = (t, cls = "t-3") => html`<p class="caption ${cls}">${t}</p>`;
  const deadline = h.deadline ?? h.anchor + ANCHOR_WINDOW;
  switch (phase) {
    case "scheduled":
      return [p(BATCH_TEXT.scheduledLine({ mode: h.mode, releaseAt: h.releaseAt, wait: h.releaseAt - tip, deadline }))];
    case "releasing":
      return [p(BATCH_TEXT.releasing({ mode: h.mode, releaseAt: h.releaseAt, deadline, broadcast: sentOut(h) }))];
    case "overdue":
      return [p(BATCH_TEXT.overdue({ releaseAt: h.releaseAt, lastRelease: h.lastRelease, deadline }), "t-warn")];
    case "missed":
      return [p(BATCH_TEXT.missed({ lastRelease: lastReleaseFor(h) }), "t-danger")];
    case "stranded":
      return [p(BATCH_TEXT.stranded({ deadline }), "t-warn")];
    case "failed":
      return relayerMissed(h) ? [p(BATCH_TEXT.missed({ lastRelease: lastReleaseFor(h) }), "t-danger")] : [];
    case "landed": {
      if (h.height == null) return [];
      const r = batchRecent(info, h);
      const landed = (r?.landed ?? []).filter(([x, n]) => Number.isFinite(x) && n > 0);
      if (!landed.length) return [p(BATCH_TEXT.landedNoCount({ height: h.height, mode: h.mode, releaseAt: h.releaseAt }))];
      const count = landed.reduce((a, [, n]) => a + n, 0);
      const first = Math.min(...landed.map(([x]) => x));
      return [
        p(BATCH_TEXT.landed({ height: h.height, count })),
        count < 3 ? p(BATCH_TEXT.landedThin) : "",
        first < h.height ? p(BATCH_TEXT.split(h.height - first), "t-warn") : "",
      ];
    }
    default:
      return [];
  }
}

/**
 * The recovery buttons a send offers now (session.retryChoices); "copy" only while the
 * envelope is kept, relay choices only while relaying is open and the relay balance (as
 * last read from `s`) can pay them. A send missed for its balance, or whose relay choices
 * the balance cannot pay, offers Top up instead (the relayer would refuse it after a re-proof).
 */
export function retryButtons(h, tip, s = null) {
  if (h.kind !== "send" || tip == null) return "";
  const offered = retryChoices(h, tip).filter((id) => (id !== "copy" || h.envelope) && (relayOpen() || !RELAY_CHOICES.has(id)));
  const ids = offered.filter((id) => !RELAY_CHOICES.has(id) || !relayShort(s, choiceMode(h, id)));
  const topUp = relayOpen() && (ids.length < offered.length || (h.relayStatus === "missed" && h.missedCode === "balance_low"));
  if (!ids.length && !topUp) return "";
  const attrs = { "data-id": h.id };
  const B = BATCH_TEXT.buttons;
  const one = {
    relay: () => button({ label: B.relay, kind: "secondary", size: "sm", icon: "refresh", action: "retry-relay", attrs }),
    "next-batch": () => button({ label: B["next-batch"], kind: "secondary", size: "sm", icon: "refresh", action: "retry-batch", attrs }),
    "next-block": () => button({ label: B["next-block"], kind: ids.includes("next-batch") ? "ghost" : "secondary", size: "sm", action: "retry-block", attrs }),
    self: () => button({ label: B.self, kind: "ghost", size: "sm", action: "retry-self", attrs }),
    copy: () => button({ label: B.copy, kind: "ghost", size: "sm", icon: "copy", action: "copy-env", attrs }),
  };
  const note = ids.includes("next-block") ? html`<p class="caption t-3">${BATCH_TEXT.nextBlockNote}</p>` : "";
  // L1: the relayer found its pool thin. Sending it linkable is the user's explicit choice, never a default.
  const linkable = h.failCode === "pool_thin" && h.status === "failed" && relayOpen() && ids.some((id) => RELAY_CHOICES.has(id))
    ? button({ label: RETRY_LINKABLE, kind: "ghost", size: "sm", action: "retry-linkable", attrs })
    : "";
  return html`<div class="inline-actions">
      ${ids.map((id) => one[id]?.() ?? "")}${linkable}${topUp ? button({ label: "Top up", kind: "secondary", size: "sm", icon: "plus", action: "relay-topup" }) : ""}
    </div>${note}`;
}

function row(h, s) {
  const tip = s.view?.height ?? null;
  const batch = h.kind === "send" && isBatchMode(h.mode);
  const art = h.print ? proofprint(h.print, { size: 24, half: true, mined: h.status === "accepted" }) : html`<span class="act-ic">${icon(KIND_ICON[h.kind] ?? "activity", { size: 20 })}</span>`;
  const amount = h.amount != null ? amountHTML(h.amount, h.div ?? 0, h.ticker) : html`<span class="ticker">${h.ticker ?? ""}</span>`;
  const sub = [];
  if (h.kind === "send" && h.to) sub.push(html`<span>to ${masked() ? zpHTML(h.to) : html`<span class="mono">${short(h.to, 8, 6)}</span>`}</span>`);
  if (h.kind === "send") sub.push(html`<span>${h.via === "relay" ? (h.linkable ? "via the relayer, linkable" : "via the relayer") : h.via === "copy" ? "envelope copied" : html`fee paid by ${btcHTML(h.payerAddress, { copy: false })}`}</span>`);
  if (h.kind === "receive") sub.push(html`<span>decrypted in this browser</span>`);
  if (h.kind === "mint" || h.kind === "deploy") sub.push(html`<span>paid by ${btcHTML(h.payerAddress, { copy: false })}</span>`);
  if (h.height != null) sub.push(html`<span>${heightText(h.height)}</span>`);
  if (h.time) sub.push(html`<span>${rel(h.time)}</span>`);
  const extra = [];
  const missed = h.kind === "send" && h.status === "failed" && h.relayStatus === "missed";
  if (missed) extra.push(html`<p class="caption t-danger" data-relay-missed>${RELAY_TEXT.missed(h.missedCode)}</p>`);
  else if (h.reason && h.status !== "accepted" && !relayerMissed(h)) extra.push(html`<p class="caption ${h.status === "failed" || h.status === "rejected" ? "t-danger" : "t-3"}">${sendText(h.reason)}</p>`);
  if (h.kind === "send" && h.via === "relay" && h.linkable) extra.push(html`<p class="caption t-warn" data-linkable>${RELAY_TEXT.linkableSent}</p>`);
  if (relayStuck(h, tip)) extra.push(html`<p class="caption t-warn" data-relay-stuck>${RELAY_TEXT.stuck}</p>`);
  else if (batch) extra.push(...batchLines(h, tip, s.relayInfo).filter(Boolean));
  else if (relayStranded(h) && h.anchor != null) extra.push(html`<p class="caption t-warn">${BATCH_TEXT.stranded({ deadline: h.deadline ?? h.anchor + ANCHOR_WINDOW })}</p>`);
  else if (h.status === "relaying" && h.anchor != null) extra.push(html`<p class="caption t-3">${h.relayStatus === "broadcast" ? "Broadcast by the relayer; waiting for a block." : "Queued at the relayer."} Valid until block ${int(h.anchor + ANCHOR_WINDOW)}.</p>`);
  else if (h.status === "copied" && h.anchor != null) extra.push(html`<p class="caption t-3">Copied, not sent from here. Anyone holding the envelope can carry it until block ${int(h.anchor + ANCHOR_WINDOW)}; whoever does pays the fee. Your notes stay reserved until then unless it lands.</p>`);
  // Failed, or a batch the relayer missed: when the notes come free again (W-1).
  if (h.kind === "send" && h.anchor != null && tip != null && (h.status === "failed" || (batch && batchPhase(h, tip) === "missed"))) {
    const left = h.anchor + ANCHOR_WINDOW - tip;
    extra.push(html`<p class="caption t-3">Notes unlock at block ${int(h.anchor + ANCHOR_WINDOW + 1)} (${eta(Math.max(0, left))}) unless this transfer lands first. Until then they can only be used to retry this same transfer, so it can never be paid twice.</p>`);
  }
  const buttons = retryButtons(h, tip, s);
  if (buttons) extra.push(buttons);
  const href = h.txid ? `/tx/${h.txid}` : null;
  return html`<li class="act">
    ${art}
    <span class="act-main">
      <span class="act-title"><b>${KIND[h.kind] ?? h.kind}</b>${amount}${statusChip(h, tip)}</span>
      <span class="act-sub">${sub}</span>
    </span>
    <span class="act-side">${seal(h, tip)}${href ? html`<a class="caption" href="${href}" data-link>Receipt →</a>` : ""}</span>
    ${extra.length ? html`<div class="act-extra">${extra}</div>` : ""}
  </li>`;
}

/** The Disclosure Preview before a self-paid retry; the fee fills [data-fee] once known. */
export function selfRetryReview({ payerAddr, blocked = null }) {
  return html`<div class="stack">${disclosure({
    op: "Send",
    publicRows: [
      ["Operation", "private transfer (retry with the same notes)"],
      ["Envelope", "471 bytes"],
      ["Bitcoin fee", html`<span data-fee>set by the market</span>`],
      ["Paid by", btcHTML(payerAddr, { copy: false })],
      ["Time", "when it is mined"],
      ["Sender", "tied to the paying address"],
    ],
    // Self-paid: the payer's address is on the transfer, so the sender is never listed as hidden.
    hidden: ["Token", "Amount", "Recipient", "Which notes you spent"],
    note: "Your Bitcoin address pays the fee in public. Anyone can link this transfer to it, and that link can't be undone.",
  })}
  ${button({ label: "Pay the fee and broadcast", kind: "btc", size: "lg", icon: "send", action: "go", block: true, disabled: Boolean(blocked), reason: blocked })}</div>`;
}

export function activityView(root, s, query) {
  let filter = FILTERS.some(([k]) => k === query?.get("f")) ? query.get("f") : "all";
  let busy = false;
  let askedRelay = false;

  const paint = () => {
    const all = s.activity();
    const current = all.filter((h) => h.era !== "legacy" && matches(filter, h, s.view?.height ?? null));
    const legacy = all.filter((h) => h.era === "legacy");
    // A landed batch transfer shows the relayer's count for its batch: relay info once per visit.
    if (!askedRelay && current.some((h) => h.kind === "send" && h.status === "accepted" && isBatchMode(h.mode))) {
      askedRelay = true;
      s.loadRelayInfo().then(() => !busy && paint()).catch(() => {});
    }
    root.innerHTML = html`<div class="wl">
      ${pageHead({ eyebrow: "ACTIVITY", title: "Activity", lead: `Kept encrypted on this device. Statuses come from the public data every wallet downloads, except for relayed transfers: until one lands or expires, each sync asks the relayer about it by its relay id. ${BATCH_TEXT.networkNote}` })}
      <div class="filters" role="group" aria-label="Filter">${FILTERS.map(([k, label]) => html`<button type="button" class="chipbtn" data-filter="${k}" aria-pressed="${k === filter ? "true" : "false"}">${label}</button>`)}</div>
      ${!s.view ? html`<div class="skel" style="height:160px;width:100%"></div>` : current.length ? html`<ul class="acts">${current.map((h) => row(h, s))}</ul>` : filter === "failed" ? empty({ text: "Nothing failed. Every transfer either landed or is on its way." }) : empty({ text: "No proofs yet. Your first receipt will appear here.", action: { label: "Mint a token", href: "/app/mint" } })}
      ${legacy.length ? html`<details class="panel"><summary class="small t-2">${legacy.length} ${legacy.length === 1 ? "entry" : "entries"} from before the signet v1 reset</summary><p class="caption t-3" style="margin:8px 0">These belong to the old pool, which was reset with the rename. They are kept for your records and are not tracked any more.</p><ul class="acts">${legacy.map((h) => row(h, s))}</ul></details>` : ""}
    </div>`;
  };

  // mode: undefined keeps the entry's own timing (a batch entry retries in the next batch).
  async function retry(entry, via, mode, { linkable = false } = {}) {
    if (busy || (via === "relay" && !relayOpen())) return;
    const timing = mode ?? savedMode(entry.mode) ?? "block"; // as s.retry: "batch12" goes with the 10-hour batch
    // A balance that cannot pay it: say so now, before a re-proof the relayer would refuse.
    if (via === "relay" && relayShort(s, timing)) {
      toast({ kind: "danger", title: "Relay balance too low.", body: RELAY_TEXT.low({ balance: s.relayBalance?.balance ?? 0, needed: quoteFor(s.relayInfo, timing)?.needed ?? 0 }) });
      return;
    }
    busy = true;
    const payerKind = via === "relay" ? "relay" : s.payerPref;
    const sheet = provingSheet({ title: "Retrying with the same notes", steps: SEND_STEPS(via, payerKind, timing) });
    const onStep = (ev) => sheet.onStep(typeof ev.detail === "string" ? { ...ev, detail: sendText(ev.detail) } : ev);
    try {
      await s.retry(entry, { via, ...(mode ? { mode } : {}), ...(linkable ? { linkable: true } : {}), onStep });
      const again = via === "relay" && isBatchMode(entry.mode) && entry.releaseAt != null;
      sheet.done({
        body: callout(
          again
            ? BATCH_TEXT.retried({ releaseAt: entry.releaseAt, deadline: entry.deadline ?? entry.anchor + ANCHOR_WINDOW })
            : via === "relay"
              ? "Handed to the relayer again. Same notes, so it can't pay twice."
              : "Broadcast from your own address. Same notes, so it can't pay twice.",
          "proof",
        ),
      });
    } catch (err) {
      sheet.fail({ message: sendText(err?.message ?? String(err)) });
    } finally {
      busy = false;
      paint();
    }
  }

  // Paying the fee yourself links the transfer to your address: review it first, like Send.
  function reviewSelf(entry) {
    if (busy) return;
    const unisat = s.payerPref === "unisat";
    const blocked = unisat && !s.unisat ? "Connect Unisat in Settings first." : null;
    const confirm = openSheet({ title: "Pay the fee yourself", eyebrow: "REVIEW", body: selfRetryReview({ payerAddr: unisat ? s.unisat?.address : s.localPayer.address, blocked }) });
    api.esplora
      .feeRate()
      .then((r) => {
        const el = confirm.el.querySelector("[data-fee]");
        if (el && r) el.innerHTML = html`~${satsHTML(r * 600)} (${r} sat/vB)`;
      })
      .catch(() => {});
    confirm.el.addEventListener("click", (e) => {
      if (!e.target.closest("[data-action=go]")) return;
      confirm.close();
      retry(entry, "self");
    });
  }

  const onClick = async (e) => {
    const f = e.target.closest("[data-filter]");
    if (f) {
      filter = f.dataset.filter;
      history.replaceState(history.state, "", filter === "all" ? location.pathname : `${location.pathname}?f=${filter}`);
      return paint();
    }
    const b = e.target.closest("[data-action]");
    if (!b?.dataset.id) return;
    const entry = s.history.find((h) => h.id === b.dataset.id);
    if (!entry) return;
    if (b.dataset.action === "copy-env") {
      if (await copyText(entry.envelope)) toast({ kind: "info", title: "Envelope copied.", body: "Anyone can carry it in an OP_RETURN until its window closes. It reveals nothing that the chain wouldn't show." });
    } else if (b.dataset.action === "retry-relay" || b.dataset.action === "retry-batch") retry(entry, "relay");
    else if (b.dataset.action === "retry-block") retry(entry, "relay", "block");
    else if (b.dataset.action === "retry-linkable") retry(entry, "relay", undefined, { linkable: true });
    else if (b.dataset.action === "retry-self") reviewSelf(entry);
  };
  paint();
  root.addEventListener("click", onClick);
  const offLive = liveSession(s, () => !busy && paint());
  const offStreamer = wireStreamer(root, paint);
  return () => {
    root.removeEventListener("click", onClick);
    offLive();
    offStreamer();
  };
}

export function render(root, params, query) {
  return withWallet(root, (s) => activityView(root, s, query));
}

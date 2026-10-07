// /app/send: asset -> amount -> recipient -> route -> privacy hint ->
// Disclosure Preview -> [Send privately] -> proving sheet.
// Prefill from /pay links: ?to=&t=&a= or the same keys after the #.
//
// Routes (docs/design/relay-balance-contract.md §5.4): "Pay the fee myself" (built-in key
// or Unisat) and "Copy envelope" are always there and stay the default. The operator never
// pays for a send. "Relay from my balance" is an option the user turns on by topping up a
// relay balance: with no balance the form shows only the first two cards and one quiet
// "Top up a relay balance" entry; with one, the relay card comes last, with the Relay
// timing control when chosen. routeState (relay.js) decides which: off | unknown | none |
// fee_high | low | ok.
import { html, raw } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { units, sats, int } from "../ui/format.js";
import { button, field, panel, payerCard, segmented, disclosure, tag, kv } from "../ui/components.js";
import { prov } from "../ui/prov.js";
import { sigil } from "../ui/sigil.js";
import { anonMeter, LINK_TEXT } from "../ui/meter.js";
import { chainWritesBlocked } from "../ui/status.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import { navigate } from "../router.js";
import { ADDRESS_HRP, BRAND } from "../config.js";
import { decodeAddress } from "../../../src/keys.mjs";
import { isBatchMode, isMode } from "../../../src/relay-batch.mjs";
import * as api from "../api.js";
import { parseUnits, addressWords, NOT_IN_BATCH } from "../session.js";
import { UNISAT_SIGNET_NOTICE } from "../payers.js";
import { RELAY_OFF, mixState, poolMix, quoteFor, relayFailure, relayOpen, routeState } from "../relay.js";
import { CROWD_TEXT, noteContext, noteTier, weakest, UPPER_BOUND_TIP } from "../privacy.js";
import {
  withWallet, pageHead, wireStreamer, liveSession, amountHTML, amountText, btcHTML, btcText, satsHTML, masked, maskError, callout, provingSheet,
  BATCH_TEXT, RELAY_TEXT,
} from "./app-shared.js";
import { tierTag } from "./app-portfolio.js";

export const SEND_STEPS = (via, payerKind, mode = "block") => [
  { id: "keys", label: "Load proving key" },
  { id: "sync", label: "Sync pool and match root", prov: "IDX" },
  { id: "select", label: "Select notes" },
  { id: "prove", label: "Build witness and prove (Groth16)" },
  { id: "verify", label: "Self-verify proof locally", prov: "YOU" },
  ...(via === "relay"
    ? [
        { id: "submit", label: "Hand to the relayer, paid from your relay balance" },
        { id: "queued", label: isBatchMode(mode) ? BATCH_TEXT.step : "Queued for the next block" },
      ]
    : via === "copy"
      ? [{ id: "ready", label: "Envelope ready to copy" }]
      : [
          { id: "sign", label: payerKind === "unisat" ? "Confirm in Unisat" : "Sign with built-in key" },
          { id: "broadcast", label: "Broadcast, then in mempool", prov: "BTC" },
        ]),
];

/** Under the route cards: who is tied to the transfer, and the line shown while no relayer runs. */
export const ROUTE_TEXT = {
  linkage: "The paying address is tied to this transfer on Bitcoin. Fund the built-in key from a source not linked to your main wallet.",
  off: RELAY_OFF,
  copyTitle: "Copy envelope: anyone can carry it",
  copyStatus: "nothing is sent from here",
  copyFee: "paid by whoever carries it",
  copyLink: "Whoever carries the envelope pays the fee, and Bitcoin ties the transfer to their address. It reveals nothing else.",
};

/** Prefill from ?to=&t=&a= or #to=&t=&a= (payment links keep data after the #). */
export function prefill(query) {
  const h = new URLSearchParams(location.hash.slice(1));
  const get = (k) => query?.get(k) ?? h.get(k) ?? null;
  return { to: get("to"), t: get("t"), a: get("a") };
}

/**
 * The token the form starts on: the named one if held, else the first held one.
 * A link that set a token or an amount never falls back silently (null: the user chooses).
 */
export function startToken(list, ticker, linked) {
  if (list.some((a) => a.ticker === ticker)) return ticker;
  return linked ? null : (list[0]?.ticker ?? null);
}

/** Checks the amount text against the available balance and `max`, what one 2-note send can spend. */
export function checkAmount(text, a, max) {
  if (!a || !String(text ?? "").trim()) return { value: null, error: null };
  try {
    const v = parseUnits(text, a.divisibility);
    if (v <= 0n) return { value: null, error: "Amount must be greater than zero." };
    if (v > a.available) return { value: v, error: `More than your available ${amountText(a.available, a.divisibility, a.ticker)}.` };
    if (v > max) return { value: v, error: `One send spends at most 2 notes, so up to ${amountText(max, a.divisibility, a.ticker)} right now. Merge notes first by sending to your own address.` };
    return { value: v, error: null };
  } catch (e) {
    return { value: null, error: e.message };
  }
}

/**
 * "Merge notes": a send of `amount` to yourself. A recipient you typed waits, with its amount
 * and its timing (picked or not), until it goes out. The merge starts untouched, so it takes
 * the self-transfer default; a pick made for the merge never carries over to the payment.
 */
export function mergeForm(form, own, amount) {
  const to = form.to.trim();
  const aside = to && to !== own ? { to: form.to, amount: form.amount, mode: form.mode, modeTouched: form.modeTouched, batchLen: form.batchLen } : form.aside;
  return { ...form, to: own, amount, aside, modeTouched: aside ? false : form.modeTouched };
}

/** Puts back the recipient, amount and timing that "Merge notes" set aside. */
export function restoreForm(form) {
  return form.aside ? { ...form, ...form.aside, aside: null } : form;
}

// Streamer-mode masking lives in app-shared.js (the proving sheet uses it too).
export { maskError };

/** Text a send's proving sheet shows: wallet errors in plain words, masked in streamer mode. */
export function sendText(text) {
  let t = String(text ?? "");
  if (/^one transfer spends at most 2 notes/.test(t)) t = "One send spends at most 2 notes. Merge notes first by sending to your own address.";
  else if (/^insufficient balance/.test(t)) t = "Your unlocked notes no longer cover this amount.";
  return masked() ? maskError(t) : t;
}

/** Replaces el's markup; a focused radio or segmented stop inside gets focus back on its replacement. */
export function keepFocus(el, markup) {
  const had = document.activeElement;
  const inside = had && had !== el && el.contains(had);
  const radio = inside && had.name ? { name: had.name, value: had.value } : null;
  // A segmented control's stops are named buttons only through their control (behaviors.js).
  const seg = inside && !radio ? had.closest?.("[data-seg]") : null;
  const segOpt = seg ? (had.dataset?.value != null ? `.seg-opt[data-value="${had.dataset.value}"]` : ".seg-select") : null;
  el.innerHTML = markup;
  if (radio) el.querySelector(`input[name="${radio.name}"][value="${radio.value}"]`)?.focus({ preventScroll: true });
  else if (segOpt) el.querySelector(`[data-seg][data-name="${seg.dataset.name}"] ${segOpt}`)?.focus({ preventScroll: true });
}

/* ---------- relay timing (batch-contract.md §5.1) ---------- */

const ownAddress = (form, s) => String(form.to ?? "").trim() === s.address;

/** "Relay timing": Fast, Next block, Batch; under Batch, Hourly or 10-hour. */
export function timingControl(mode) {
  const batch = isBatchMode(mode);
  return html`<div class="mode-row"><span class="field-label">${BATCH_TEXT.control}</span>${segmented(
    [
      { value: "fast", label: BATCH_TEXT.label.fast },
      { value: "block", label: BATCH_TEXT.label.block },
      { value: "batch", label: BATCH_TEXT.stop },
    ],
    { value: batch ? "batch" : mode, name: "timing", label: BATCH_TEXT.control },
  )}${
    batch
      ? segmented(
          [
            { value: "batch", label: BATCH_TEXT.label.batch },
            { value: "batch10", label: BATCH_TEXT.label.batch10 },
          ],
          { value: mode, name: "batchlen", label: BATCH_TEXT.lengthControl, size: "sm" },
        )
      : ""
  }</div>`;
}

/** Until the user picks a timing, a recipient change re-applies the default (own address: hourly batch). */
export function followRecipient(form, s) {
  if (!form.modeTouched) form.mode = s.defaultMode(form.to);
  return form;
}

/**
 * The user picked a timing stop ("timing") or a batch length ("batchlen"). The pick sticks for
 * this form and is remembered: self-transfers in selfModePref, payments in relayModePref
 * (never a batch pick for a payment). remember: false for a one-off way out (Send with the
 * next block, offered when this batch can't take the send), which keeps the saved defaults.
 */
export function pickTiming(form, s, { name, value }, { remember = true } = {}) {
  if (name !== "timing" && name !== "batchlen") return form;
  // The Batch stop brings back the length picked last on this form (hourly at first).
  const mode = name === "timing" && value === "batch" ? (isBatchMode(form.mode) ? form.mode : (form.batchLen ?? "batch")) : value;
  if (!isMode(mode)) return form;
  form.mode = mode;
  form.modeTouched = true;
  if (isBatchMode(mode)) form.batchLen = mode;
  if (!remember) return form;
  if (ownAddress(form, s)) s.selfModePref = mode;
  else if (!isBatchMode(mode)) s.relayModePref = mode;
  return form;
}

/**
 * What the relayer reports for the batch this send would join (relay info `batch`):
 * { enabled, queued, full }. queued is null when it reports another epoch (its tip differs);
 * enabled is false when it doesn't take this length (relay.js refuses those before submitting).
 * null while relay info is unknown.
 */
export function crowdFor(info, mode, start) {
  if (!info || info.error || !info.enabled) return null;
  const m = info.batch?.modes?.[mode];
  if (!m || m.enabled !== true || m.maxPerEpoch === 0) return { enabled: false, queued: null, full: false };
  const c = m.current;
  if (!c || typeof c.queued !== "number" || (start != null && c.start !== start)) return { enabled: true, queued: null, full: false };
  return { enabled: true, queued: c.queued, full: m.maxPerEpoch != null && c.queued >= m.maxPerEpoch };
}

/**
 * Why a batch send can't go right now (the CTA reason), or null. `plan` is session.batchPlan()
 * for the current amount; `crowd` is crowdFor().
 */
export function batchBlock(plan, crowd) {
  if (crowd && !crowd.enabled) return BATCH_TEXT.disabled;
  if (plan && !plan.eligible && plan.reason !== "short") return BATCH_TEXT.tooNewCta(plan);
  if (crowd?.full) return BATCH_TEXT.full;
  return null;
}

/**
 * Lines under the timing control. mode: the chosen mode; self: a send to your own address;
 * plan: session.batchPlan() or null; info: relay info; height: the wallet's tip.
 */
export function timingNotes({ mode, self = false, plan = null, info = null, height = null }) {
  const p = (t, cls = "t-3") => html`<p class="caption ${cls}">${t}</p>`;
  const selfLine = self ? p(BATCH_TEXT.selfDefault) : "";
  if (!isBatchMode(mode)) return html`<div class="stack stack--s" data-timing-notes>${p(BATCH_TEXT.otherModes)}${selfLine}</div>`;
  const crowd = crowdFor(info, mode, plan?.start ?? null);
  const late = plan && !plan.eligible && plan.reason !== "short";
  const wait = (h) => (height == null ? null : Math.max(0, h - height));
  let crowdLine = "";
  if (late) {
    const text = plan.reason === "too-new" ? BATCH_TEXT.tooNew({ start: plan.start, eligibleAt: plan.eligibleAt, wait: wait(plan.eligibleAt) }) : BATCH_TEXT.notYet({ eligibleAt: plan.eligibleAt, wait: wait(plan.eligibleAt) });
    crowdLine = callout(html`${text} ${button({ label: BATCH_TEXT.useNextBlock, kind: "ghost", size: "sm", action: "mode-block" })}`, "warn");
  } else if (crowd && !crowd.enabled) crowdLine = callout(BATCH_TEXT.disabled, "warn");
  else if (crowd?.full) crowdLine = callout(html`${BATCH_TEXT.full} ${button({ label: BATCH_TEXT.useNextBlock, kind: "ghost", size: "sm", action: "mode-block" })}`, "warn");
  else if (crowd?.queued != null) crowdLine = html`${p(BATCH_TEXT.crowd(crowd.queued), "t-2")}${crowd.queued < 3 ? p(BATCH_TEXT.thin) : ""}${crowd.queued === 0 ? p(BATCH_TEXT.alone, "t-warn") : ""}`;
  const long =
    mode === "batch10" && plan
      ? html`${p(BATCH_TEXT.long10.reserve({ deadline: plan.deadline, wait: wait(plan.deadline) }))}${p(BATCH_TEXT.long10.crowd)}${p(BATCH_TEXT.long10.stall({ lastRelease: plan.lastRelease }))}`
      : mode === "batch10"
        ? p(BATCH_TEXT.long10.crowd)
        : "";
  return html`<div class="stack stack--s" data-timing-notes>${p(BATCH_TEXT.caption[mode], "t-2")}${crowdLine}${p(BATCH_TEXT.ip)}${long}${selfLine}${p(BATCH_TEXT.noCancel)}</div>`;
}

/* ---------- who can tell it was you (privacy-trace-test.md L1, L3) ---------- */

/**
 * Whether the Send screen may list the sender among what the proof hides: only while the crowd
 * at the proof's anchor is known and not thin (L3: the anchor alone can name a sender, whoever
 * carries the envelope), and then for a relayed send whose relay pool has cover (mixState "ok")
 * that is not sent linkable, or for a copied envelope (whoever carries it pays). Self-paid sends
 * put the payer's address on the transfer; a linkable relayed send is tied to the top-up address.
 */
export function senderHidden({ via, mix = "unknown", linkable = false, crowd = null }) {
  if (!crowd || crowd.thin) return false;
  if (via === "copy") return true;
  return via === "relay" && mix === "ok" && linkable !== true;
}

/**
 * The privacy block above the Disclosure Preview: for a relayed send the pool's lineage (L1:
 * thin needs the "send it linkable" confirmation, unknown says the link may exist); for a relayed
 * send or a copied envelope the effective crowd (L3: a warning below CROWD_MIN_NOTES candidates or
 * a batch crowd of 1; never blocking). mix: mixState() (null for a copied envelope: no relayer);
 * k: poolMix().k; crowd: session.sendCrowd(); linkable: the box's state.
 */
export function relayPrivacyBlock({ mix = "unknown", k = null, crowd = null, linkable = false }) {
  const parts = [];
  if (mix === "thin") {
    parts.push(html`<div class="callout callout--warn" data-pool-thin>${icon("warn", { size: 16 })}<div>
      <p>${RELAY_TEXT.thin({ k })} ${RELAY_TEXT.thinChoice}</p>
      <label class="cluster small" style="margin-top:6px"><input type="checkbox" name="linkable"${linkable ? raw(" checked") : ""}><span>${RELAY_TEXT.thinConfirm}</span></label>
    </div></div>`);
  } else if (mix === "unknown") parts.push(callout(RELAY_TEXT.mixUnknown, "warn"));
  if (crowd) {
    const lines = [CROWD_TEXT.notes(crowd.candidates), ...(crowd.batchCrowd != null ? [CROWD_TEXT.batch(crowd.batchCrowd)] : []), ...(crowd.alone ? [CROWD_TEXT.alone] : [])];
    parts.push(
      crowd.thin
        ? html`<div class="callout callout--warn" data-crowd-thin>${icon("warn", { size: 16 })}<div><b>${CROWD_TEXT.few}</b><ul class="reasons" style="margin-top:6px">${lines.map((l) => html`<li>${l}</li>`)}</ul><p class="caption t-3" style="margin-top:6px">${CROWD_TEXT.advice}</p></div></div>`
        : html`<p class="caption t-3" data-crowd>${lines.join(" ")}</p>`,
    );
  }
  return parts.length ? html`<div class="stack stack--s" data-relay-privacy>${parts}</div>` : "";
}

function recipientStatus(text, own) {
  const v = text.trim();
  if (!v) return { ok: false, msg: null };
  if (!v.toLowerCase().startsWith(`${ADDRESS_HRP}1`)) return { ok: false, msg: `A ${BRAND} address starts with ${ADDRESS_HRP}1. Bitcoin addresses can't receive private notes.` };
  try {
    decodeAddress(v);
    return { ok: true, msg: v === own ? "Valid shielded address (your own)" : "Valid shielded address" };
  } catch {
    return { ok: false, msg: "Checksum failed. Copy the address again." };
  }
}

// Relayer gates (relay info `code`) that refuse every send now, whatever the balance.
const RELAY_DOWN = new Set(["halted", "indexer_behind", "busy"]);

/**
 * Why a relayed send in `mode` can't go now, or null: the balance (low), the fee cap
 * (fee_high) or a relayer gate. For the relay card's reason and the Send button.
 */
export function relayBlock(info, balance, mode) {
  const state = routeState(info, balance, mode);
  if (state === "fee_high") return RELAY_TEXT.feeHigh({ feeRate: info.fees?.feeRate ?? "?", maxFeeRate: info.fees?.maxFeeRate ?? "?" });
  if (state === "low") {
    const q = quoteFor(info, mode);
    // The headroom quoteFor used, so the text and the amount it explains always agree.
    return `${RELAY_TEXT.low({ balance: balance.balance, needed: q.needed })}${isBatchMode(mode) ? ` ${RELAY_TEXT.lowBatch({ headroom: q.needed / q.perSend })}` : ""}`;
  }
  if (state === "ok" && RELAY_DOWN.has(info.code)) return relayFailure({ code: info.code }).message;
  return null;
}

/** The relayer's margin settings from relay info, for RELAY_TEXT.cardFee (its defaults otherwise). */
function marginOf(info) {
  const out = {};
  const pct = info?.balance?.marginPct;
  const min = info?.balance?.marginMinSats;
  if (Number.isSafeInteger(pct) && pct >= 0) out.marginPct = pct;
  if (Number.isSafeInteger(min) && min >= 0) out.marginMinSats = min;
  return out;
}

/**
 * The relay card ("Relay from my balance"), shown only while the relay balance can be
 * offered (routeState ok, low or fee_high). low and fee_high render it disabled with
 * their reason; low also offers a Top up button under it.
 */
export function relayCard(s, { checked, mode = "block" }) {
  const i = s.relayInfo;
  const b = s.relayBalance;
  const state = routeState(i, b, mode);
  const q = quoteFor(i, mode);
  const reason = relayBlock(i, b, mode);
  const card = payerCard({
    value: "relay",
    name: "route",
    title: RELAY_TEXT.cardTitle,
    status: masked() ? "Balance hidden" : RELAY_TEXT.cardStatus({ balance: b?.balance ?? 0 }),
    fee: q ? (masked() ? html`~${satsHTML(q.perSend)} from your relay balance` : RELAY_TEXT.cardFee({ perSend: q.perSend, ...marginOf(i) })) : null,
    // L1: while the pool is thin the relayer's coin descends from your own top-up ("Linked"). An
    // unpublished lineage keeps the card's text; the block under the form says the link may exist.
    link: mixState(i) === "thin" ? { level: 1, text: RELAY_TEXT.thinCard } : { level: 3, text: LINK_TEXT.relayer },
    checked,
    disabled: Boolean(reason),
    reason: masked() && reason ? maskError(reason) : reason,
  });
  return state === "low" ? html`${card}<div class="inline-actions">${button({ label: "Top up", kind: "secondary", size: "sm", icon: "plus", action: "relay-topup" })}</div>` : card;
}

/**
 * The timing the relay card is judged at while another route is chosen: the form's own,
 * unless only a batch is short (it reserves more) and Next block would be covered, so the
 * card can still be picked and its timing changed.
 */
export function cardMode(form, s) {
  const st = routeState(s.relayInfo, s.relayBalance, form.mode);
  return st === "low" && isBatchMode(form.mode) && routeState(s.relayInfo, s.relayBalance, "block") === "ok" ? "block" : form.mode;
}

/** routeState for the relay card on this form. */
export const cardState = (form, s) => routeState(s.relayInfo, s.relayBalance, form.via === "relay" ? form.mode : cardMode(form, s));

/**
 * Which route the form is on. Until the user picks a route or a timing it follows
 * routePref, where a stored "relay" counts only while the balance can pay this send
 * (state ok); otherwise the form uses "self" and the stored preference stays. A relay pick
 * falls back to "self" once the relay card is gone (no balance, or relaying off).
 */
export function settleVia(form, s) {
  if (!form.viaTouched) {
    const pref = s.routePref;
    form.via = pref === "relay" ? (routeState(s.relayInfo, s.relayBalance, form.mode) === "ok" ? "relay" : "self") : pref;
  }
  if (form.via === "relay" && !["ok", "low", "fee_high"].includes(cardState(form, s))) form.via = "self";
  return form;
}

/** The quiet entry under the stage-0 cards while the relay balance is not in use (none, unknown). */
export const relayEntry = () => html`<p class="caption t-3" data-relay-entry>${button({ label: RELAY_TEXT.entry, kind: "ghost", size: "sm", action: "relay-topup" })}</p>`;

/** "Copy envelope": prove here, hand it to nobody; anyone can carry it until its window closes. */
export function copyCard({ checked }) {
  return payerCard({
    value: "copy",
    name: "route",
    title: ROUTE_TEXT.copyTitle,
    status: ROUTE_TEXT.copyStatus,
    fee: ROUTE_TEXT.copyFee,
    link: { level: 2, text: ROUTE_TEXT.copyLink },
    checked,
  });
}

export function selfCard(s, { checked, links, feeText, kind }) {
  const unisat = s.payerPref === "unisat";
  const linked = links.filter((l) => l.kind === "linked");
  const warning = linked.length
    ? `${btcText(linked[0].address)} also paid your ${linked[0].ticker} ${linked[0].what === "deploy" ? "launch" : "mint"}${linked[0].height != null ? ` at block ${int(linked[0].height)}` : ""}. Paying this send from it links the two.`
    : unisat
      ? UNISAT_SIGNET_NOTICE
      : null;
  return payerCard({
    value: "self",
    name: "route",
    title: `Pay the fee myself: Bitcoin shows this ${kind} was made by your BTC address, permanently`,
    status: unisat ? (s.unisat ? "Unisat connected" : "Unisat not connected") : "built-in key",
    fee: feeText,
    link: unisat ? { level: 1, text: LINK_TEXT.unisat(s.unisat ? btcText(s.unisat.address) : "address") } : { level: linked.length ? 1 : 2, text: LINK_TEXT.builtin },
    checked,
    disabled: unisat && !s.unisat,
    reason: unisat && !s.unisat ? "Connect Unisat in Settings, or switch to the built-in key." : null,
    warning,
  });
}

export function sendView(root, s, query) {
  const pre = prefill(query);
  const linked = Boolean(pre.t || pre.a);
  // The form starts on routePref ("self" unless the user chose "copy" or "relay"); a stored
  // "relay" counts only while the relay balance can pay this send (settleVia).
  const form = { ticker: pre.t?.toUpperCase() ?? null, amount: pre.a ?? "", to: pre.to ?? "", via: "self", viaTouched: false, mode: "block", modeTouched: false, batchLen: null, aside: null, linkable: false, poolThin: false };
  // L1: relay info's coverOk is computed for an anonymous caller; the relayer can still find the
  // pool thin for this account (it is among the k). A pool_thin refusal makes the form treat the
  // pool as thin from then on, so the "send it linkable" box can be ticked.
  const mixNow = () => (form.poolThin ? "thin" : mixState(s.relayInfo));
  followRecipient(form, s); // payments start on Next block, a send to yourself on the hourly batch
  settleVia(form, s);
  let feeRate = null;
  let sending = false;
  let infoHeight = s.view?.height ?? null; // the tip relay info was last loaded at

  const held = () => s.assets().filter((a) => a.balance > 0n || a.ticker === form.ticker);
  const asset = () => {
    const list = held();
    const t = startToken(list, form.ticker, linked);
    return list.find((a) => a.ticker === t) ?? null;
  };
  const sendable = (a) => s.wallet.maxSendable(BigInt(a.id));

  root.innerHTML = html`<div class="wl">
    ${pageHead({ eyebrow: "SEND", title: "Send privately", lead: "A zero-knowledge proof hides the token, the amount and the recipient. Whether anyone can tell the transfer came from you depends on who pays the fee and how many others use the pool. Bitcoin only carries a 471-byte envelope." })}
    <div class="wl-cols">
      <form class="wl-form" novalidate data-f>
        <div data-slot="asset"></div>
        <div data-slot="amount" data-mask></div>
        <div data-slot="to" data-mask>${field({ label: "Recipient", name: "to", value: form.to, mono: true, placeholder: `${ADDRESS_HRP}1…`, chips: [{ label: "Paste", action: "paste" }], attrs: { autocomplete: "off", autocapitalize: "off", spellcheck: "false" } })}<p class="caption" data-to-msg aria-live="polite"></p><p class="caption t-3" data-to-aside></p></div>
        <fieldset class="stack stack--s" style="border:0;padding:0;margin:0"><legend class="field-label" style="margin-bottom:6px">Who pays the Bitcoin fee</legend><div class="payers" data-slot="route"></div><div class="stack stack--s" data-route-notes></div></fieldset>
        <div data-slot="mode"></div>
        <p class="visually-hidden" data-timing-live aria-live="polite"></p>
        <div data-slot="timing"></div>
        <div data-slot="hint"></div>
        <div data-slot="crowd"></div>
        <div data-slot="disclosure"></div>
        <span data-error-anchor></span>
        <div class="sticky-cta" data-slot="cta"></div>
      </form>
      <aside class="stack stack--l preview-sticky" data-slot="aside"></aside>
    </div>
  </div>`;
  const f = root.querySelector("[data-f]");
  const slot = (n) => root.querySelector(`[data-slot=${n}]`);
  const toInput = f.querySelector("[name=to]");
  const syncInputs = () => {
    toInput.value = form.to;
    const amt = f.querySelector("[name=amount]");
    if (amt) amt.value = form.amount;
  };

  const parsedAmount = (a) => (a ? checkAmount(form.amount, a, sendable(a)) : { value: null, error: null });

  /** The batch this send would join, from the current view (no network); null for other modes. */
  const planFor = () => {
    if (form.via !== "relay" || !isBatchMode(form.mode) || !s.view) return null;
    const a = asset();
    const p = a ? parsedAmount(a) : null;
    try {
      return s.batchPlan(form.mode, a && p?.value && !p.error ? { asset: a, amount: p.value } : {});
    } catch {
      return null;
    }
  };

  function paintAsset() {
    const list = held();
    if (!s.view) {
      slot("asset").innerHTML = html`<div class="field"><span class="field-label">Token</span><span class="skel" style="height:44px;width:100%"></span></div>`;
      return;
    }
    if (!list.length) {
      slot("asset").innerHTML = callout(html`<b>Nothing to send yet.</b> Mint from an open token, or share your address to receive a private note. <a href="/app/mint" data-link>Browse mints</a>`, "info");
      return;
    }
    const pick = startToken(list, form.ticker, linked);
    if (pick) form.ticker = pick;
    slot("asset").innerHTML = html`<div class="field"><label class="field-label" for="send-asset">Token</label>
      <select class="input" id="send-asset" name="asset">${pick ? "" : raw('<option value="" selected disabled>Choose a token</option>')}${list.map((a) => html`<option value="${a.ticker}"${a.ticker === form.ticker ? raw(" selected") : ""}>${a.ticker} · ${masked() ? "available" : `${units(a.available, a.divisibility)} available`}</option>`)}</select></div>`;
  }

  function paintAmount() {
    const a = asset();
    if (!a) {
      slot("amount").innerHTML = s.view && held().length ? html`<p class="caption t-3">${form.ticker ? `This link asks for ${form.ticker}, which this wallet doesn't hold.` : "This link sets an amount but no token."} Choose the token to send.</p>` : "";
      return;
    }
    const p = parsedAmount(a);
    const max = sendable(a);
    const prev = slot("amount").querySelector("input");
    const focused = prev && document.activeElement === prev;
    if (!prev) {
      slot("amount").innerHTML = html`${field({ label: "Amount", name: "amount", value: form.amount, mono: true, suffix: a.ticker, chips: [{ label: "Max", action: "max" }], attrs: { inputmode: "decimal", autocomplete: "off" } })}<p class="caption" data-amt-msg></p>`;
    } else {
      slot("amount").querySelector(".field-suffix").textContent = a.ticker;
      if (!focused && prev.value !== form.amount) prev.value = form.amount;
    }
    const msg = slot("amount").querySelector("[data-amt-msg]");
    msg.className = `caption ${p.error ? "t-danger" : "t-3"}`;
    const merge = max < a.available ? button({ label: "Merge notes", kind: "ghost", size: "sm", action: "merge" }) : "";
    msg.innerHTML = p.error
      ? html`${p.error}${a.balance > a.available ? html` ${amountHTML(a.balance - a.available, a.divisibility, a.ticker)} is reserved by a pending transfer.` : ""} ${merge}`
      : html`Available ${amountHTML(a.available, a.divisibility, a.ticker)}${max < a.available ? html` · up to ${amountHTML(max, a.divisibility)} in one send (2 notes at most) ${merge}` : ""}${a.balance > a.available ? html` · ${amountHTML(a.balance - a.available, a.divisibility)} reserved by a pending transfer` : ""}`;
  }

  function paintTo() {
    const st = recipientStatus(form.to, s.address);
    const msg = slot("to").querySelector("[data-to-msg]");
    msg.className = `caption ${st.ok ? "ok-mark" : "t-danger"}`;
    msg.innerHTML = st.msg
      ? st.ok
        ? html`${icon("check", { size: 14 })}${st.msg}${masked() ? "" : html`<span class="t-3"> · fingerprint </span><span class="mono t-2">${addressWords(form.to.trim()).join(" ")}</span>`}`
        : html`${icon("warn", { size: 14 })}${st.msg}`
      : "";
    slot("to").querySelector("[data-to-aside]").innerHTML = form.aside
      ? html`Merging notes first. The recipient you entered comes back, with its amount, once this send goes out. ${button({ label: "Put it back now", kind: "ghost", size: "sm", action: "restore-to" })}`
      : "";
    return st;
  }

  async function paintRoute() {
    settleVia(form, s);
    const links = s.linkage("self");
    const feeText = feeRate ? html`~${sats(feeRate * 600)} (${feeRate} sat/vB) from your address` : "network fee from your address";
    const state = cardState(form, s);
    const base = html`${selfCard(s, { checked: form.via === "self", links, feeText, kind: "transfer" })}${copyCard({ checked: form.via === "copy" })}`;
    const shown = state === "ok" || state === "low" || state === "fee_high";
    const cards = shown ? html`${base}${relayCard(s, { checked: form.via === "relay", mode: form.via === "relay" ? form.mode : cardMode(form, s) })}` : base;
    keepFocus(slot("route"), cards);
    const notes = root.querySelector("[data-route-notes]");
    if (notes) notes.innerHTML = html`<p class="caption t-2">${ROUTE_TEXT.linkage}</p>${state === "off" ? html`<p class="caption t-3">${ROUTE_TEXT.off}</p>` : state === "none" || state === "unknown" ? relayEntry() : ""}`;
    paintMode();
  }

  // Self-paid sends ignore timing, so the whole control hides.
  function paintMode() {
    keepFocus(slot("mode"), form.via === "relay" ? timingControl(form.mode) : "");
  }

  /** After a button that sat in the timing notes switched the timing: focus the stop now on, and say so. */
  function focusTiming() {
    const narrow = typeof matchMedia === "function" && matchMedia("(max-width: 359px)").matches;
    const seg = `[data-seg][data-name="timing"] ${narrow ? ".seg-select" : `.seg-opt[data-value="${isBatchMode(form.mode) ? "batch" : form.mode}"]`}`;
    slot("mode").querySelector(seg)?.focus({ preventScroll: true });
    const live = root.querySelector("[data-timing-live]");
    if (live) live.textContent = `${BATCH_TEXT.control}: ${BATCH_TEXT.label[form.mode]}.`;
  }

  function paintTiming() {
    slot("timing").innerHTML =
      form.via === "relay" ? timingNotes({ mode: form.mode, self: ownAddress(form, s), plan: planFor(), info: s.relayInfo, height: s.view?.height ?? null }) : "";
  }

  // The crowd line: relay info again at most once per new block, only while a batch is chosen.
  function refreshInfo() {
    const h = s.view?.height ?? null;
    if (form.via !== "relay" || !isBatchMode(form.mode) || h === null || h === infoHeight) return;
    infoHeight = h;
    s.loadRelayInfo().then(() => (paintTiming(), paintCta()));
  }

  function modeChanged() {
    paintRoute(); // the relay card's cost depends on the timing (a batch reserves more); repaints the control too
    paintTiming();
    paintHint();
    paintCrowd();
    paintDisclosure();
    paintCta();
    refreshInfo();
  }

  /** A recipient change: re-applies the default timing until the user picks one. before: the timing shown so far. */
  function recipientChanged(before = form.mode) {
    followRecipient(form, s);
    if (form.mode !== before) modeChanged();
    else paintTiming(); // the self-transfer line
  }

  function tierFor(a, amount) {
    if (!a || !amount) return null;
    let picked;
    try {
      // A batch send spends only notes in the tree at its boundary: grade those (too new: no hint,
      // the timing notes say why).
      const plan = planFor();
      picked = s.wallet.selectNotes(BigInt(a.id), amount, plan ? { maxLeaf: plan.leaves } : {}).picked;
    } catch {
      return null;
    }
    const notes = s.notes();
    const leaves = s.view.outputs.length;
    const relay = form.via === "relay";
    const route = relay ? (mixNow() === "thin" ? "relay-linkable" : "relay") : form.via === "copy" ? "copy" : s.payerPref === "unisat" ? "unisat" : s.linkage("self").some((l) => l.kind === "linked") ? "self-linked" : "self";
    return weakest(
      picked.map((p) => {
        const n = notes.find((x) => String(x.nullifier) === String(p.nullifier)) ?? { ...p, height: s.view.height };
        return noteTier(noteContext(n, { leaves, height: s.view.height, log: s.logItems }), { route, mode: relay ? form.mode : "block" });
      }),
    );
  }

  function paintHint() {
    const a = asset();
    const p = a ? parsedAmount(a) : { value: null };
    const t = tierFor(a, p.error ? null : p.value);
    const relayLinks = form.via === "relay" ? s.linkage("relay") : [];
    const recent = relayLinks.find((l) => l.kind === "recent-mint");
    const deposit = relayLinks.some((l) => l.kind === "recent-deposit");
    slot("hint").innerHTML = html`${deposit ? callout(RELAY_TEXT.recentDeposit, "warn") : ""}${
      t
        ? html`<div class="callout ${t.rank <= 1 ? "callout--warn" : ""}">${icon(t.rank <= 1 ? "warn" : "info", { size: 16 })}<div>
            <div class="cluster">Privacy of this send ${tierTag(t)}</div>
            ${t.advice ? html`<p style="margin-top:6px">${t.advice} This is advice only; you can still send.</p>` : ""}
            <details style="margin-top:6px"><summary class="caption">Why</summary><ul class="reasons">${t.reasons.map((r) => html`<li>${r}</li>`)}</ul><p class="caption t-3" style="margin-top:6px">${UPPER_BOUND_TIP}</p></details>
          </div></div>`
        : ""
    }${recent ? callout(html`You minted ${recent.ticker} from your BTC address recently; wait a few blocks for better privacy.`, "warn") : ""}`;
  }

  /** L3 before a relayed send or a copied envelope (the anchor names the crowd either way), from data this browser already has. */
  function crowdNow() {
    if ((form.via !== "relay" && form.via !== "copy") || !s.view) return null;
    if (form.via === "copy") return s.sendCrowd({ mode: "block" });
    const plan = isBatchMode(form.mode) ? planFor() : null;
    const batch = isBatchMode(form.mode) ? crowdFor(s.relayInfo, form.mode, plan?.start ?? null) : null;
    return s.sendCrowd({ mode: form.mode, leaves: plan?.leaves, ...(batch ? { queued: batch.queued } : {}) });
  }

  function paintCrowd() {
    const el = slot("crowd");
    if (!el) return;
    const block = !s.view
      ? ""
      : form.via === "relay"
        ? relayPrivacyBlock({ mix: mixNow(), k: poolMix(s.relayInfo)?.k ?? null, crowd: crowdNow(), linkable: form.linkable })
        : form.via === "copy"
          ? relayPrivacyBlock({ mix: null, crowd: crowdNow() })
          : "";
    keepFocus(el, block);
  }

  function paintDisclosure() {
    const relay = form.via === "relay";
    const copy = form.via === "copy";
    const i = s.relayInfo;
    const payerAddr = relay || copy ? null : s.payerPref === "unisat" ? s.unisat?.address : s.localPayer.address;
    const q = relay ? quoteFor(i, form.mode) : null;
    const fee = relay
      ? q ? html`~${satsHTML(q.perSend)} from your relay balance` : "from your relay balance"
      : copy
        ? "paid by whoever carries it"
        : feeRate ? html`~${satsHTML(feeRate * 600)} (${feeRate} sat/vB)` : "set by the market";
    const plan = relay ? planFor() : null;
    const mix = mixNow();
    const crowd = relay || copy ? crowdNow() : null;
    const hiddenNow = senderHidden({ via: form.via, mix, linkable: form.linkable, crowd });
    const senderLine = !relay && !copy
      ? "tied to the paying address"
      : relay && mix !== "ok"
        ? mix === "thin" ? "tied to the address you topped up from, by the carrier's input" : "may be tied to the address you topped up from"
        : crowd
          ? "likely to be told: few transfers to hide among"
          : "may be told: how many transfers it hides among is not known yet";
    const time = plan
      ? BATCH_TEXT.time({ mode: form.mode, releaseAt: plan.releaseAt, wait: Math.max(0, plan.releaseAt - s.view.height) })
      : relay && form.mode === "block"
        ? "the next block, with other transfers"
        : copy
          ? "when someone carries it, before its window closes"
          : "when it is mined";
    slot("disclosure").innerHTML = disclosure({
      op: "Send",
      publicRows: [
        ["Operation", "private transfer"],
        ["Envelope", "471 bytes"],
        ["Bitcoin fee", fee],
        ["Paid by", relay ? "Relayer coins, charged to your relay balance" : copy ? "Whoever carries the envelope" : btcHTML(payerAddr, { copy: false })],
        ["Time", time],
        ...(hiddenNow ? [] : [["Sender", senderLine]]),
      ],
      hidden: hiddenNow ? ["Token", "Amount", "Sender (you)", "Recipient", "Which notes you spent"] : ["Token", "Amount", "Recipient", "Which notes you spent"],
      note: relay
        ? RELAY_TEXT.operator
        : copy
          ? "Nothing leaves this browser until you paste the envelope somewhere. Whoever carries it pays the fee in public, and Bitcoin ties the transfer to their address. Your notes stay reserved until it lands or its window closes."
          : "Your Bitcoin address pays the fee in public. Anyone can link this transfer to it.",
    });
  }

  function paintCta() {
    const a = asset();
    const p = a ? parsedAmount(a) : { value: null, error: null };
    const to = recipientStatus(form.to, s.address);
    const blocked = chainWritesBlocked();
    let reason = null;
    if (sending) reason = "Sending…";
    else if (!s.view) reason = "Syncing the pool…";
    else if (blocked) reason = blocked;
    else if (!a) reason = held().length ? "Choose the token to send." : "Nothing to send yet.";
    else if (!p.value || p.error) reason = p.error ?? "Enter an amount.";
    else if (!to.ok) reason = to.msg ?? "Enter the recipient's shielded address.";
    else if (form.via === "self" && s.payerPref === "unisat" && !s.unisat) reason = "Connect Unisat in Settings first.";
    else if (form.via === "relay" && relayBlock(s.relayInfo, s.relayBalance, form.mode)) reason = relayBlock(s.relayInfo, s.relayBalance, form.mode);
    else if (form.via === "relay" && mixNow() === "thin" && !form.linkable) reason = RELAY_TEXT.thinConfirmFirst;
    else if (form.via === "relay" && isBatchMode(form.mode)) {
      const plan = planFor();
      reason = batchBlock(plan, crowdFor(s.relayInfo, form.mode, plan?.start ?? null));
    }
    if (reason && masked()) reason = maskError(reason);
    slot("cta").innerHTML = button({ label: "Send privately", type: "submit", kind: "btc", size: "lg", icon: "send", disabled: Boolean(reason), reason, block: true });
  }

  function paintAside() {
    const i = s.relayInfo;
    const crowd = panel({ eyebrow: "CROWD", body: anonMeter({ notes: s.view ? s.view.outputs.length : null, tokens: s.view ? s.assetList.length : null, prov: "IDX" }) });
    const state = cardState(form, s);
    if (state !== "ok" && state !== "low" && state !== "fee_high") {
      slot("aside").innerHTML = html`${crowd}
      ${panel({
        eyebrow: "FEES",
        title: "Who carries this transfer",
        body: html`<ul class="reasons" style="padding-left:16px">
          <li>Pay the fee myself: the built-in key or Unisat pays, and Bitcoin shows that address made this transfer.</li>
          <li>Copy envelope: anyone can carry it in an OP_RETURN until its window closes. Whoever does pays the fee.</li>
          <li>Either way the proof hides the token, the amount and the recipient.</li>
          <li>${state === "off" ? ROUTE_TEXT.off : "Or top up a relay balance: a relayer carries the transfer in its own transaction and charges the fee to that balance."}</li>
        </ul>`,
      })}`;
      return;
    }
    slot("aside").innerHTML = html`${crowd}
      ${panel({
        eyebrow: "RELAY",
        title: "What the relayer can and can't do",
        body: html`<ul class="reasons" style="padding-left:16px">
          <li>Can't see the token, the amount or the recipient, and can't change a byte: the proof locks it.</li>
          <li>${RELAY_TEXT.operator}</li>
          <li>Sees your IP address and timing. Use Tor Browser to hide your IP.</li>
          <li>Can delay or refuse; you can always pay the fee yourself.</li>
        </ul>${i?.stats ? kv([["Relayed in the last 144 blocks", html`${int(i.stats.relayed144)} ${prov("IDX")}`]], { compact: true }) : ""}
        <a class="small" href="/app/settings#relay-balance" data-link>Relay balance →</a>
        <a class="small" href="/app/settings#relayer" data-link>Relayer books →</a>`,
      })}`;
  }

  async function paintAll() {
    paintAsset();
    paintAmount();
    paintTo();
    await paintRoute();
    paintTiming();
    paintHint();
    paintCrowd();
    paintDisclosure();
    paintCta();
    paintAside();
  }

  const light = () => {
    paintAmount();
    paintTiming(); // whether the notes for this amount are old enough for the batch
    paintHint();
    paintCta();
  };

  f.addEventListener("input", (e) => {
    if (e.target.name === "amount") {
      form.amount = e.target.value;
      light();
    } else if (e.target.name === "to") {
      form.to = e.target.value;
      form.aside = null;
      paintTo();
      recipientChanged();
      paintCta();
    }
  });
  f.addEventListener("change", async (e) => {
    if (e.target.name === "asset") {
      form.ticker = e.target.value;
      paintAmount();
      paintHint();
      paintCta();
    } else if (e.target.name === "linkable") {
      form.linkable = e.target.checked === true;
      paintDisclosure();
      paintCta();
    } else if (e.target.name === "route") {
      form.via = e.target.value;
      form.viaTouched = true;
      s.routePref = form.via;
      if (form.via === "self" && feeRate === null) feeRate = await api.esplora.feeRate().catch(() => null);
      await paintRoute();
      paintTiming();
      paintHint();
      paintCrowd();
      paintDisclosure();
      paintCta();
      refreshInfo();
    }
  });
  f.addEventListener("seg-change", (e) => {
    const name = e.detail?.name;
    if (name !== "timing" && name !== "batchlen") return;
    form.viaTouched = true; // a timing pick is a choice of the relay route: it stays chosen
    const before = form.mode;
    pickTiming(form, s, e.detail);
    // The control repaints too: Batch shows or hides the length choice (keepFocus keeps the stop focused).
    if (form.mode !== before) modeChanged();
  });
  f.addEventListener("click", async (e) => {
    const a = e.target.closest("[data-action]");
    if (!a) return;
    if (a.dataset.action === "max" || a.dataset.action === "merge") {
      const as = asset();
      if (as) {
        const amount = units(sendable(as), as.divisibility).replace(/,/g, "");
        if (a.dataset.action === "merge") {
          // A send of the two largest notes to yourself leaves one note; a typed recipient waits.
          const before = form.mode;
          Object.assign(form, mergeForm(form, s.address, amount));
          paintTo();
          recipientChanged(before);
        } else form.amount = amount;
        syncInputs();
        light();
      }
    } else if (a.dataset.action === "restore-to") {
      const before = form.mode;
      Object.assign(form, restoreForm(form));
      syncInputs();
      paintTo();
      recipientChanged(before);
      light();
    } else if (a.dataset.action === "mode-block") {
      form.viaTouched = true;
      pickTiming(form, s, { name: "timing", value: "block" }, { remember: false });
      modeChanged();
      focusTiming(); // the button was in the notes that just repainted without it
    } else if (a.dataset.action === "paste") {
      try {
        form.to = (await navigator.clipboard.readText()).trim();
        form.aside = null;
        toInput.value = form.to;
        paintTo();
        recipientChanged();
        paintCta();
      } catch {
        toast({ kind: "info", title: "Paste it into the field.", body: "Your browser didn't let the page read the clipboard." });
      }
    }
  });

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const a = asset();
    const p = a ? parsedAmount(a) : null;
    if (!a || !p?.value || p.error || !recipientStatus(form.to, s.address).ok || sending) return paintCta();
    sending = true;
    paintCta();
    const via = form.via;
    const mode = form.mode;
    const batch = via === "relay" && isBatchMode(mode);
    const self = ownAddress(form, s);
    const payerKind = via === "relay" ? "relay" : via === "copy" ? "copy" : s.payerPref;
    const sheet = provingSheet({ title: "Sending privately", steps: SEND_STEPS(via, payerKind, mode) });
    const onStep = (ev) => sheet.onStep(typeof ev.detail === "string" ? { ...ev, detail: sendText(ev.detail) } : ev);
    try {
      // L1: consent counts only while the pool is thin and the box is ticked; it is never assumed.
      const linkable = via === "relay" && form.linkable === true && mixNow() === "thin";
      const entry = await s.send({ asset: a, amount: p.value, to: form.to, via, mode, linkable, onStep });
      const deadline = entry.deadline ?? entry.anchor + 100;
      sheet.done({
        body: batch
          ? html`${callout(BATCH_TEXT.scheduled({ releaseAt: entry.releaseAt, deadline }), "proof")}${self ? "" : html`<p class="caption t-2">${BATCH_TEXT.recipientWait[mode]}</p>`}<p class="caption t-3">${BATCH_TEXT.noCancel}</p>`
          : via === "relay"
            ? callout(html`<b>Queued at the relayer.</b> It goes out in the ${mode === "fast" ? "next minute or so" : "next block, together with other transfers"}. Your notes stay reserved until it lands or its window closes at block ${int(entry.anchor + 100)}.`, "proof")
            : via === "copy"
              ? callout(html`<b>Envelope ready.</b> The proof was verified in this browser. Copy it and have anyone carry it in an OP_RETURN before block ${int(entry.anchor + 100)}; whoever does pays the fee. Your notes stay reserved until it lands or that block passes. Activity can also pay the fee from here.`, "proof")
              : callout(html`<b>In the mempool.</b> The proof was verified in this browser before it left. ${tag("Txid public", "btc")}`, "proof"),
        actions: html`${via === "copy" ? button({ label: "Copy envelope", kind: "secondary", icon: "copy", action: "copy-env", attrs: { "data-env": entry.envelope ?? "" } }) : ""}${entry.txid ? button({ label: "View receipt", href: `/tx/${entry.txid}`, kind: "secondary" }) : ""}${button({ label: "Activity", href: "/app/activity", kind: "ghost" })}`,
      });
      if (via === "copy") {
        sheet.sheet?.el?.addEventListener("click", (ev) => {
          const b = ev.target.closest?.("[data-action=copy-env]");
          if (b) copyText(b.dataset.env).then((ok) => ok && toast({ kind: "info", title: "Envelope copied.", body: "Anyone can carry it in an OP_RETURN until its window closes. It reveals nothing new." }));
        });
      }
      const back = Boolean(form.aside);
      const what = amountText(p.value, a.divisibility, a.ticker);
      toast({
        kind: "success",
        title: batch ? BATCH_TEXT.toast.title : via === "relay" ? "Transfer queued at the relayer." : via === "copy" ? "Envelope ready to copy." : "Transfer broadcast.",
        body: back ? "Your recipient is back in the form. Send to it once the merge lands." : batch ? BATCH_TEXT.toast.body({ what, releaseAt: entry.releaseAt }) : via === "copy" ? `${what} lands once someone carries the envelope.` : `${what} on its way.`,
        action: { label: "Activity", href: "/app/activity" },
      });
      // After a merge the set-aside recipient and amount return; otherwise the amount clears.
      if (back) Object.assign(form, restoreForm(form));
      else form.amount = "";
      followRecipient(form, s); // the restored recipient gets its own default timing
      syncInputs();
    } catch (err) {
      if (err?.code === "pool_thin") form.poolThin = true;
      sheet.fail({ message: sendText(err?.message ?? String(err)) }, {
        actions: err.entry
          ? html`${button({ label: "Open activity to retry", href: "/app/activity?f=failed", kind: "secondary" })}${button({ label: "Copy envelope", kind: "ghost", action: "copy-env", attrs: { "data-env": err.entry.envelope ?? "" } })}`
          : err?.code === NOT_IN_BATCH
            ? button({ label: BATCH_TEXT.useNextBlock, kind: "secondary", action: "mode-block", attrs: { "data-sheet-close": true } })
            : err?.code === "pool_thin"
              ? button({ label: "Review the linkable send", kind: "secondary", action: "pool-thin", attrs: { "data-sheet-close": true } })
              : "",
      });
      sheet.sheet.el.addEventListener("click", (ev) => {
        const b = ev.target.closest("[data-action=copy-env]");
        if (b) copyText(b.dataset.env).then((ok) => ok && toast({ kind: "info", title: "Envelope copied.", body: "Anyone can carry it in an OP_RETURN until its window closes. It reveals nothing new." }));
        // Nothing left the browser: switch the form to Next block; the user sends again.
        if (ev.target.closest("[data-action=mode-block]")) {
          pickTiming(form, s, { name: "timing", value: "block" }, { remember: false });
          modeChanged();
        }
        // The relayer found the pool thin: read relay info again, so the form shows the warning and its box.
        if (ev.target.closest("[data-action=pool-thin]")) s.loadRelayInfo().then(() => paintAll()).catch(() => {});
      });
    } finally {
      sending = false;
      paintAll();
    }
  });

  paintAll();
  // Relay info (the same for every wallet) says whether a relay-balance relayer runs. The
  // balance itself is read only for a wallet that has topped up (prefs.relay).
  s.loadRelayInfo()
    .then(() => {
      if (relayOpen() && s.relayPrefs && !s.relayBalance) s.loadRelayBalance().catch(() => {});
      return paintAll();
    })
    .catch(() => {});
  if (form.via === "self") api.esplora.feeRate().then((r) => ((feeRate = r), paintRoute(), paintDisclosure())).catch(() => {});

  const offLive = liveSession(s, (type) => {
    if (type === "sync" || type === "history" || type === "payer" || type === "error" || type === "relay-balance") paintAll();
    if (type === "sync") refreshInfo();
  });
  const offStreamer = wireStreamer(root, paintAll);
  return () => {
    offLive();
    offStreamer();
  };
}

export function render(root, params, query) {
  return withWallet(root, (s) => sendView(root, s, query));
}

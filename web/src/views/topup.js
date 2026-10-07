// "Top up your relay balance" (docs/design/relay-balance.md, contract §5.5): a sheet like
// Add BTC. It shows the wallet's next deposit address (a fresh one per top-up, derived in
// this browser from the relayer's pool key and this wallet's relay account), the rules
// (minimum, confirmations, the suggested amount of about 10 sends), optional ways to pay
// from the built-in key or Unisat (a plain payment, no OP_RETURN, nothing else), the
// deposits the wallet has seen with their state, and the privacy facts in plain words.
//
// While the sheet is open, the session looks up its deposit address on mempool.space once
// per new block (session.topUpOpen) and asks the relayer to credit each confirmed payment.
// Streamer mode masks the address and the QR until revealed, and every amount.
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { addr, int } from "../ui/format.js";
import { button, field, kv } from "../ui/components.js";
import { prov } from "../ui/prov.js";
import { redact } from "../ui/redact.js";
import { qrSVG } from "../ui/qr.js";
import { openSheet } from "../ui/sheet.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import * as api from "../api.js";
import { currentSession, onSessionChange, onStreamerChange } from "../session.js";
import { RELAY_OFF, relayFailure, relayOpen, relayRotation } from "../relay.js";
import { masked, satsHTML, callout, maskError, RELAY_TEXT } from "./app-shared.js";
import { NETWORK_TAG } from "../config.js";

/** Whether the More sheet lists "Relay balance": only while a relay-balance relayer runs. */
export const relayMenuOn = () => relayOpen();

/** The numbers the sheet shows, from relay info (`balance`): min, confirmations, suggested, sends, sweep. */
export function topUpRules(info) {
  const b = info?.balance ?? {};
  const min = Number.isSafeInteger(b.minDepositSats) ? b.minDepositSats : 2000;
  return {
    min,
    confirmations: Number.isSafeInteger(b.depositConfirmations) ? b.depositConfirmations : 1,
    suggested: Number.isSafeInteger(b.suggestedTopUpSats) ? b.suggestedTopUpSats : null,
    sends: Number.isSafeInteger(b.suggestSends) ? b.suggestSends : 10,
    sweep: Number.isSafeInteger(b.sweepCostSats) ? b.sweepCostSats : null,
  };
}

/** The amount field: whole sats, at least the minimum. -> { sats, error } */
export function parseTopUp(text, min) {
  const v = String(text ?? "").trim().replace(/[,_\s]/g, "");
  if (!v) return { sats: null, error: "Enter an amount in sats." };
  if (!/^[0-9]+$/.test(v)) return { sats: null, error: "Enter a whole number of sats." };
  const sats = Number(v);
  if (!Number.isSafeInteger(sats)) return { sats: null, error: "That amount is too large." };
  if (sats < min) return { sats, error: RELAY_TEXT.minimum({ min }) };
  return { sats, error: null };
}

/** One deposit row as checkDeposits() reports it. */
export function depositLine(d, rules) {
  const text =
    d.state === "credited"
      ? d.amount != null ? RELAY_TEXT.credited({ amount: d.amount }) : "Credited."
      : d.state === "small"
        ? RELAY_TEXT.small({ min: rules.min })
        : d.state === "refused"
          ? d.message ?? relayFailure({ code: d.code }).message
          : d.retired && d.code !== "deposit_unconfirmed"
            ? RELAY_TEXT.retiredWaiting
            : RELAY_TEXT.waiting({ confirmations: d.confirmations ?? 0, needed: d.needed ?? rules.confirmations });
  const tone = d.state === "credited" ? "ok-mark" : d.state === "waiting" ? "t-2" : "t-danger";
  return html`<li class="caption ${tone}" data-deposit-state="${d.state}"><span class="mono t-3">#${int(d.n)}</span> ${masked() ? "" : html`${satsHTML(d.value)} · `}${masked() ? maskError(text) : text}</li>`;
}

/** Address, QR and copy. Streamer mode: a bar and a hatched tile until shown. */
export function depositAddressBlock(dep, { shown = false } = {}) {
  const hide = masked() && !shown;
  return html`<div class="dep-addr" data-topup-addr>
    ${hide ? html`<div class="dep-qr-mask" role="img" aria-label="QR code hidden in streamer mode">${icon("eye-off", { size: 20 })}<span class="caption">QR hidden</span></div>` : qrSVG(dep.address, { size: 152, label: "QR code of your relay deposit address" })}
    <div class="stack stack--s dep-addr-main">
      <div class="eyebrow">DEPOSIT ADDRESS #${int(dep.n)} · ${NETWORK_TAG}</div>
      <div class="dep-addr-text">${hide ? redact("address", { tip: "Hidden in streamer mode." }) : addr(dep.address, { copy: false })}</div>
      <div class="inline-actions">
        ${button({ label: "Copy address", kind: "secondary", size: "sm", icon: "copy", action: "tu-copy", attrs: { "data-autofocus": true } })}
        ${masked() ? button({ label: shown ? "Hide address" : "Show address", kind: "ghost", size: "sm", icon: shown ? "eye-off" : "eye", action: "tu-reveal" }) : ""}
      </div>
      <p class="caption t-2">${RELAY_TEXT.fresh}</p>
      <p class="caption t-2">${RELAY_TEXT.anyWallet}</p>
    </div>
  </div>`;
}

/** The pay-from-key review: amount, network fee and what the relayer then sees. */
export function payReview(plan) {
  return html`<div class="stack stack--s" data-topup-review>
    ${kv(
      [
        ["Pays", html`${satsHTML(plan.amount)} to deposit address #${int(plan.n)}`],
        ["Network fee", html`~${satsHTML(plan.fee)} from the built-in key`],
      ],
      { compact: true },
    )}
    ${callout(RELAY_TEXT.payFromKey, "warn")}
    <div class="inline-actions">${button({ label: "Pay and broadcast", kind: "btc", size: "sm", icon: "send", action: "tu-pay-confirm" })}${button({ label: "Cancel", kind: "ghost", size: "sm", action: "tu-pay-cancel" })}</div>
  </div>`;
}

/** The whole sheet body for session `s` and sheet state `st`. */
export function topUpBody(s, st = {}) {
  if (!relayOpen()) return html`<div class="stack">${callout(RELAY_OFF, "info")}</div>`;
  const i = s.relayInfo;
  const rules = topUpRules(i);
  const b = s.relayBalance;
  // relay-balance.md §9: no address while top-ups are closed; a rotation is said once, plainly.
  const rot = relayRotation(i);
  let dep = null;
  try {
    dep = s.depositAddress();
  } catch {}
  const amount = parseTopUp(st.amount ?? (rules.suggested != null ? String(rules.suggested) : ""), rules.min);
  const deposits = s.relayDeposits ?? [];
  // A settled top-up (L2) is no longer listed; an address counter past 0 still shows one was credited.
  const credited = deposits.some((d) => d.state === "credited") || (b?.credits?.length ?? 0) > 0 || (b?.nextIndex ?? 0) > 0;
  return html`<div class="stack dep" data-topup>
    <p class="small t-2">${RELAY_TEXT.topUpOnce}</p>
    <section class="dep-bal" aria-label="Relay balance">
      <div class="dep-head">${icon("wallet", { size: 16 })}<b>Relay balance</b></div>
      ${b
        ? kv(
            [
              ["Available", html`${satsHTML(b.balance)} ${prov("IDX")}`],
              ["Reserved", satsHTML(b.reserved)],
            ],
            { compact: true },
          )
        : html`<p class="caption t-3">Reading the balance…</p>`}
      ${i?.stats ? html`<p class="caption t-2" data-topup-meter>${RELAY_TEXT.meter(i.stats.relayed144 ?? 0)}</p>` : ""}
    </section>
    <ul class="dep-list" data-topup-rules>
      ${rules.suggested != null ? html`<li>${masked() ? maskError(RELAY_TEXT.suggested({ sats: rules.suggested, sends: rules.sends })) : RELAY_TEXT.suggested({ sats: rules.suggested, sends: rules.sends })}</li>` : ""}
      <li>${RELAY_TEXT.minimum({ min: rules.min })}</li>
      <li>${RELAY_TEXT.confirmations(rules.confirmations)}</li>
    </ul>
    ${rot.retired.length ? html`<div data-topup-rotated>${callout(RELAY_TEXT.rotated, "warn")}</div>` : ""}
    ${!rot.depositsOpen
      ? html`<div data-topup-paused>${callout(RELAY_TEXT.paused, "warn")}</div>`
      : dep ? depositAddressBlock(dep, st) : callout("The deposit address can't be derived right now. Close this sheet and try again.", "danger")}
    ${rot.depositsOpen ? html`<section class="stack stack--s" aria-label="Pay from this wallet" data-topup-pay>
      <div class="eyebrow">PAY FROM THIS WALLET (OPTIONAL)</div>
      <div data-mask>${field({ label: "Amount (sats)", name: "topup-amount", value: st.amount ?? (rules.suggested != null ? String(rules.suggested) : ""), mono: true, suffix: "sats", attrs: { inputmode: "numeric", autocomplete: "off" } })}</div>
      <p class="caption ${amount.error ? "t-danger" : "t-3"}" data-topup-amount-msg>${amount.error ?? ""}</p>
      ${st.review ? payReview(st.review) : html`<div class="inline-actions">
        ${button({ label: "Pay from the built-in key", kind: "secondary", size: "sm", action: "tu-pay-key", disabled: Boolean(amount.error) || !dep || st.paying })}
        ${s.unisat ? button({ label: "Pay with Unisat", kind: "secondary", size: "sm", action: "tu-pay-unisat", disabled: Boolean(amount.error) || !dep || st.paying }) : ""}
      </div>`}
      ${st.payError ? callout(masked() ? maskError(st.payError) : st.payError, "danger") : ""}
    </section>` : ""}
    <section class="stack stack--s" aria-label="Deposits" data-topup-deposits>
      <div class="eyebrow">DEPOSITS</div>
      ${deposits.length ? html`<ul class="stack stack--s" style="list-style:none;padding:0;margin:0">${deposits.map((d) => depositLine(d, rules))}</ul>` : html`<p class="caption t-3">No payment seen yet at this address.</p>`}
      <div class="inline-actions">${button({ label: "Check now", kind: "ghost", size: "sm", icon: "refresh", action: "tu-check", loading: st.checking ? "Checking…" : null })}${button({ label: "Check older addresses", kind: "ghost", size: "sm", action: "tu-older" })}</div>
      ${st.checkError ? html`<p class="caption t-danger">${st.checkError}</p>` : ""}
      ${credited && s.routePref !== "relay" ? html`<div class="inline-actions">${button({ label: "Use my relay balance for private sends", kind: "neutral", size: "sm", action: "tu-use-relay" })}</div>` : ""}
    </section>
    <section class="dep-advice" aria-label="Privacy" data-topup-privacy>
      <div class="eyebrow">PRIVACY</div>
      <ul class="dep-list">
        <li>${RELAY_TEXT.operator}</li>
        <li>${RELAY_TEXT.timing}</li>
        <li>${RELAY_TEXT.lookup}</li>
        ${rules.sweep != null ? html`<li>${RELAY_TEXT.sweep({ sweep: rules.sweep })}</li>` : ""}
        <li>${RELAY_TEXT.noWithdraw}</li>
      </ul>
    </section>
  </div>`;
}

let current = null;

/**
 * Opens the top-up sheet for session s (default: the unlocked one). One at a time.
 * esplora is injectable for tests. Returns { sheet, state, check, paint }, or null with no session.
 */
export function openTopUp(s = currentSession(), { esplora = api.esplora } = {}) {
  if (!s || s.closed) return null;
  if (current) return current;
  const st = { amount: null, shown: false, review: null, paying: false, payError: null, checking: false, checkError: null, closed: false };
  const offs = [];
  s.topUpOpen = true;
  const sheet = openSheet({
    title: "Top up your relay balance",
    eyebrow: `RELAY BALANCE · ${NETWORK_TAG}`,
    label: "Top up your relay balance",
    body: topUpBody(s, st),
    onClose() {
      st.closed = true;
      s.topUpOpen = false;
      for (const off of offs) off();
      if (current?.state === st) current = null;
    },
  });
  const paint = () => {
    if (st.closed) return;
    sheet.setBody?.(topUpBody(s, st));
  };

  async function check(older = false) {
    if (st.checking || st.closed || s.closed || !relayOpen()) return;
    st.checking = true;
    st.checkError = null;
    paint();
    try {
      const out = await s.checkDeposits({ older });
      const got = out.filter((d) => d.state === "credited" && !d.already);
      if (got.length > 0) {
        toast({ kind: "success", title: "Relay balance topped up.", body: masked() ? "A deposit was credited." : got.map((d) => RELAY_TEXT.credited({ amount: d.amount ?? 0 })).join(" ") });
      }
    } catch (e) {
      st.checkError = relayFailure(e).message;
    } finally {
      st.checking = false;
      paint();
    }
  }

  async function startPay(kind) {
    const rules = topUpRules(s.relayInfo);
    const amount = parseTopUp(st.amount ?? (rules.suggested != null ? String(rules.suggested) : ""), rules.min);
    if (amount.error) return paint();
    st.payError = null;
    let dep;
    try {
      dep = s.depositAddress();
    } catch (e) {
      st.payError = e.message;
      return paint();
    }
    if (kind === "unisat") {
      st.paying = true;
      paint();
      try {
        const { txid } = await s.unisat.pay({ to: dep.address, amount: amount.sats });
        s.recordTopUp({ n: dep.n, txid, value: amount.sats });
        toast({ kind: "success", title: "Payment sent with Unisat.", body: "It is credited after its confirmation. This sheet checks once per block." });
      } catch (e) {
        st.payError = e.message;
      } finally {
        st.paying = false;
        paint();
      }
      return;
    }
    // Built-in key: plan and sign here, show the fee, broadcast only after the user confirms.
    st.paying = true;
    paint();
    try {
      const utxos = await s.localPayer.utxos(esplora);
      const feeRate = await esplora.feeRate();
      const plan = s.localPayer.planPay({ utxos, to: dep.address, amount: amount.sats, feeRate });
      st.review = { ...plan, n: dep.n };
    } catch (e) {
      st.payError = e.message;
    } finally {
      st.paying = false;
      paint();
    }
  }

  async function confirmPay() {
    const r = st.review;
    if (!r || st.paying) return;
    st.paying = true;
    paint();
    try {
      const txid = await esplora.broadcast(r.hex);
      // The deposit's own output: the change position is random (L5), never assume vout 0.
      s.recordTopUp({ n: r.n, txid, vout: r.vout, value: r.amount });
      st.review = null;
      toast({ kind: "success", title: "Top-up broadcast.", body: "It is credited after its confirmation. This sheet checks once per block." });
    } catch (e) {
      st.payError = e.message;
    } finally {
      st.paying = false;
      paint();
    }
  }

  const onClick = async (e) => {
    const b = e.target.closest?.("[data-action]");
    if (!b) return;
    switch (b.dataset.action) {
      case "tu-copy": {
        let address = null;
        try {
          address = s.depositAddress().address;
        } catch {}
        if (address && (await copyText(address))) toast({ kind: "success", title: "Address copied.", timeout: 2500 });
        else toast({ kind: "warn", title: "Couldn't copy.", body: "Your browser blocked the clipboard. Select the address and copy it by hand." });
        return;
      }
      case "tu-reveal":
        st.shown = !st.shown;
        return paint();
      case "tu-check":
        return check(false);
      case "tu-older":
        return check(true);
      case "tu-pay-key":
        return startPay("key");
      case "tu-pay-unisat":
        return startPay("unisat");
      case "tu-pay-confirm":
        return confirmPay();
      case "tu-pay-cancel":
        st.review = null;
        return paint();
      case "tu-use-relay":
        s.routePref = "relay";
        toast({ kind: "info", title: "Private sends now go through the relayer.", body: "Each one is charged to your relay balance. Change it on Send or in Settings." });
        return paint();
    }
  };
  const onInput = (e) => {
    if (e.target?.name !== "topup-amount") return;
    st.amount = e.target.value;
    st.review = null; // a new amount needs a new review
    const rules = topUpRules(s.relayInfo);
    const a = parseTopUp(st.amount, rules.min);
    const msg = sheet.body.querySelector?.("[data-topup-amount-msg]");
    if (msg) {
      msg.className = `caption ${a.error ? "t-danger" : "t-3"}`;
      msg.textContent = a.error ?? "";
    }
    for (const sel of ["[data-action=tu-pay-key]", "[data-action=tu-pay-unisat]"]) {
      const btn = sheet.body.querySelector?.(sel);
      if (btn) btn.disabled = Boolean(a.error);
    }
  };
  sheet.el.addEventListener("click", onClick);
  sheet.el.addEventListener("input", onInput);
  offs.push(() => sheet.el.removeEventListener("click", onClick));
  offs.push(() => sheet.el.removeEventListener("input", onInput));
  offs.push(
    onStreamerChange(() => {
      st.shown = false;
      paint();
    }),
  );
  offs.push(
    onSessionChange((type) => {
      if (type === "relay" || type === "relay-balance" || type === "payer") paint();
      if (LOCKS.has(type)) sheet.close();
    }),
  );
  current = { sheet, state: st, check, paint };
  // Relay info first when this page never loaded it, then one look at the deposit address.
  (s.relayInfo && !s.relayInfo.error ? Promise.resolve() : s.loadRelayInfo())
    .then(() => {
      paint();
      return check(false);
    })
    .catch(() => {});
  return current;
}

const LOCKS = new Set(["lock", "idle-lock", "elsewhere-lock", "forget"]);

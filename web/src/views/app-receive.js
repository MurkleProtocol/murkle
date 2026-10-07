// /app/receive: the shielded address with its QR code and six-word fingerprint,
// plus a payment-request builder. Request links keep their data after the #,
// which browsers never send to any server.
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { button, field, panel } from "../ui/components.js";
import { sigil } from "../ui/sigil.js";
import { qrSVG } from "../ui/qr.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import { parseUnits, addressWords } from "../session.js";
import { withWallet, pageHead, wireStreamer, liveSession, zpHTML, masked, callout, amountText } from "./app-shared.js";

/** /pay#to=…&t=…&a=… for this origin. Only the fragment carries the details. */
export function payLink({ to, ticker = null, amount = null, origin = location.origin }) {
  const p = new URLSearchParams();
  p.set("to", to);
  if (ticker) p.set("t", ticker);
  if (amount) p.set("a", amount);
  return `${origin}/pay#${p.toString()}`;
}

function receiveView(root, s) {
  const req = { ticker: "", amount: "" };

  const paint = () => {
    const words = addressWords(s.address);
    root.innerHTML = html`<div class="wl">
      ${pageHead({ eyebrow: "RECEIVE", title: "Receive privately", lead: "Share this address with whoever pays you. It never appears on Bitcoin: payments arrive as encrypted notes that only this wallet can open." })}
      ${panel({
        certified: true,
        eyebrow: "YOUR SHIELDED ADDRESS",
        body: html`<div class="addr-card">
          <div class="stack">
            <div style="font-size:15px;line-height:24px">${zpHTML(s.address)}</div>
            <div class="stack stack--s"><span class="eyebrow">FINGERPRINT</span><span class="mono">${masked() ? "hidden in streamer mode" : words.join(" ")}</span><span class="caption t-3">Read these six words to the sender: if theirs match, they have the right address.</span></div>
            <div class="inline-actions">${button({ label: "Copy address", kind: "secondary", size: "sm", icon: "copy", attrs: { "data-copy": s.address } })}${typeof navigator !== "undefined" && navigator.share ? button({ label: "Share", kind: "ghost", size: "sm", icon: "share", action: "share-addr" }) : ""}</div>
          </div>
          ${masked() ? callout("QR hidden in streamer mode.", "info", "eye-off") : qrSVG(s.address, { size: 200, label: "QR code of your shielded address" })}
        </div>`,
      })}
      ${panel({
        eyebrow: "PAYMENT REQUEST",
        title: "Ask for a token and amount",
        body: html`<form class="stack" data-req novalidate>
          <div class="grid-2f">
            <div class="field"><label class="field-label" for="req-t">Token</label><select class="input" id="req-t" name="t"><option value="">Any token</option>${s.assetList.map((a) => html`<option value="${a.ticker}"${a.ticker === req.ticker ? " selected" : ""}>${a.ticker}</option>`)}</select></div>
            ${field({ label: "Amount (optional)", name: "a", value: req.amount, mono: true, attrs: { inputmode: "decimal", autocomplete: "off" } })}
          </div>
          <p class="caption t-3" data-req-err></p>
          <div data-req-out></div>
          <p class="caption t-3">Payment details stay after the #, so they never reach our server. Anyone who has the link can see the address and amount in it, so share it only with the payer.</p>
        </form>`,
      })}
    </div>`;
    paintRequest();
  };

  function paintRequest() {
    const out = root.querySelector("[data-req-out]");
    const err = root.querySelector("[data-req-err]");
    const a = s.assetList.find((x) => x.ticker === req.ticker);
    let amount = null;
    err.textContent = "";
    if (req.amount.trim()) {
      try {
        if (!a) throw new Error("Pick a token for the amount.");
        amount = parseUnits(req.amount, a.divisibility);
        if (amount <= 0n) throw new Error("Amount must be greater than zero.");
      } catch (e) {
        err.textContent = e.message;
        err.className = "caption t-danger";
        out.innerHTML = "";
        return;
      }
    }
    const link = payLink({ to: s.address, ticker: req.ticker || null, amount: req.amount.trim() || null });
    out.innerHTML = html`<div class="req-out">
      <div class="stack stack--s">
        <div class="cluster">${a ? sigil(a.id, { size: 24 }) : icon("receive", { size: 20 })}<span class="small">${a && amount ? `Requesting ${amountText(amount, a.divisibility, a.ticker)}` : a ? `Requesting ${a.ticker}` : "Requesting any token"}</span></div>
        <div class="linkbox">${masked() ? "Link hidden in streamer mode." : link}</div>
        <div class="inline-actions">${button({ label: "Copy link", kind: "secondary", size: "sm", icon: "link", action: "copy-link" })}${navigator.share ? button({ label: "Share", kind: "ghost", size: "sm", icon: "share", action: "share-link" }) : ""}</div>
      </div>
      ${masked() ? "" : qrSVG(link, { size: 160, label: "QR code of the payment link", ecc: "L" })}
    </div>`;
    out.dataset.link = link;
  }

  paint();
  const onInput = (e) => {
    if (e.target.name === "t") req.ticker = e.target.value;
    else if (e.target.name === "a") req.amount = e.target.value;
    else return;
    paintRequest();
  };
  const onClick = async (e) => {
    const b = e.target.closest("[data-action]");
    if (!b) return;
    const link = root.querySelector("[data-req-out]")?.dataset.link;
    if (b.dataset.action === "copy-link" && link) {
      if (await copyText(link)) toast({ kind: "success", title: "Payment link copied.", timeout: 2500 });
    } else if (b.dataset.action === "share-link" && link) {
      navigator.share({ title: "Payment request", url: link }).catch(() => {});
    } else if (b.dataset.action === "share-addr") {
      navigator.share({ title: "My shielded address", text: s.address }).catch(() => {});
    }
  };
  root.addEventListener("input", onInput);
  root.addEventListener("change", onInput);
  root.addEventListener("click", onClick);
  const offLive = liveSession(s, (type) => type === "sync" && !root.querySelector("[data-req] :focus") && paint(), { syncNow: !s.view });
  const offStreamer = wireStreamer(root, paint);
  return () => {
    root.removeEventListener("input", onInput);
    root.removeEventListener("change", onInput);
    root.removeEventListener("click", onClick);
    offLive();
    offStreamer();
  };
}

export function render(root) {
  return withWallet(root, (s) => receiveView(root, s));
}

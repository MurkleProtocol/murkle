// /pay#to=mrk1…&t=ABC&a=250: a private payment request. Everything after the #
// stays in this browser (browsers never send the fragment to a server), and the
// address is checked locally. [Pay privately] opens the send form prefilled.
import { html } from "../ui/dom.js";
import { icon, glyphSVG } from "../ui/icons.js";
import { button, panel } from "../ui/components.js";
import { sigil } from "../ui/sigil.js";
import { decodeAddress } from "../../../src/keys.mjs";
import * as api from "../api.js";
import { ADDRESS_HRP, BRAND } from "../config.js";
import { currentSession, hasVault, hasLegacy, parseUnits, addressWords } from "../session.js";
import { ensureStyles, amountHTML, zpHTML, masked, callout } from "./app-shared.js";

/** Parses and checks a request fragment. Pure apart from decoding. */
export function parseRequest(hash, assets = []) {
  const p = new URLSearchParams(String(hash ?? "").replace(/^#/, ""));
  const to = (p.get("to") ?? "").trim();
  const ticker = (p.get("t") ?? "").trim().toUpperCase() || null;
  const amountText = (p.get("a") ?? "").trim() || null;
  const out = { to, ticker, amountText, amount: null, asset: null, errors: [] };
  if (!to) out.errors.push("This link has no recipient address.");
  else {
    try {
      decodeAddress(to);
    } catch {
      out.errors.push(`The address in this link isn't a valid ${BRAND} address. Ask for a new link.`);
    }
  }
  if (ticker) {
    out.asset = assets.find((a) => a.ticker === ticker) ?? null;
    if (assets.length && !out.asset) out.errors.push(`No token ${ticker} exists on this network.`);
  } else if (amountText) out.errors.push("This link sets an amount but no token. Ask for a new link.");
  if (amountText && out.asset) {
    try {
      out.amount = parseUnits(amountText, out.asset.divisibility);
      if (out.amount <= 0n) throw new Error("Amount must be greater than zero.");
    } catch (e) {
      out.errors.push(e.message);
    }
  }
  return out;
}

export async function render(root) {
  ensureStyles();
  let assets = [];
  try {
    assets = await api.assets();
  } catch {
    assets = [];
  }
  const paint = () => {
    const r = parseRequest(location.hash, assets);
    const ok = !r.errors.length && r.to;
    const sendHash = new URLSearchParams();
    if (r.to) sendHash.set("to", r.to);
    if (r.ticker) sendHash.set("t", r.ticker);
    if (r.amountText) sendHash.set("a", r.amountText);
    const sendHref = `/app/send#${sendHash.toString()}`;
    const what =
      r.asset && r.amount !== null
        ? html`Someone requests ${amountHTML(r.amount, r.asset.divisibility, r.asset.ticker)}`
        : r.asset
          ? html`Someone requests <span class="ticker">${r.asset.ticker}</span>`
          : html`Someone requests a private payment`;
    const wallet = currentSession()
      ? button({ label: "Pay privately", href: sendHref, kind: "neutral", size: "lg", icon: "send", block: true })
      : hasVault() || hasLegacy()
        ? button({ label: "Unlock to pay", href: sendHref, kind: "neutral", size: "lg", icon: "unlock", block: true })
        : html`<div class="stack stack--s"><p class="small t-2">You need a ${BRAND} wallet to pay. It takes about a minute; then open this link again.</p><div class="inline-actions">${button({ label: "Create wallet", href: "/app/create", kind: "neutral" })}${button({ label: "I have a phrase", href: "/app/import", kind: "secondary" })}</div></div>`;
    root.innerHTML = html`<div class="container section"><div class="wl-center" style="max-width:560px">
      ${panel({
        certified: true,
        cls: "lockpanel",
        body: html`<div class="lock-top">${r.asset ? sigil(r.asset.id, { size: 56 }) : glyphSVG({ size: 40 })}<span class="eyebrow">${icon("lock", { size: 12 })} PAYMENT REQUEST</span></div>
          <h1 class="h2-app">${what}</h1>
          ${r.to && !r.errors.some((e) => e.includes("address")) ? html`<div class="stack stack--s"><span class="eyebrow">TO</span><div>${zpHTML(r.to)}</div>${masked() ? "" : html`<span class="caption t-3">Fingerprint <span class="mono t-2">${addressWords(r.to).join(" ")}</span>. If the requester reads you the same six words, it's their address.</span>`}</div>` : ""}
          ${r.errors.length ? callout(html`${r.errors.map((e) => html`<div>${e}</div>`)}`, "danger") : ""}
          ${ok ? wallet : ""}
          <p class="caption t-3">The request lives after the # in this link, so it never reached our server. Paying sends a private transfer: the token, the amount and the recipient stay hidden on Bitcoin. Who pays its fee can still show who sent it.</p>`,
      })}
      ${!r.to ? callout(html`To make a request, open your wallet's <a href="/app/receive" data-link>Receive</a> page. Links look like /pay#to=${ADDRESS_HRP}1…&amp;t=TICKER&amp;a=250.`, "info") : ""}
    </div></div>`;
  };
  paint();
  addEventListener("hashchange", paint);
  return () => removeEventListener("hashchange", paint);
}

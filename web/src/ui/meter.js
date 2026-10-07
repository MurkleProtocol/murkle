/**
 * Meters (visual.md sections 6.6 and 6.8). Honest by construction: no anonymity percentage,
 * only counts and plain sentences about what can still narrow things down.
 *
 * API
 *   anonPosition(n) -> 0..1          log10 position of n on the 1..10^6 scale
 *   anonMeter({ notes, tokens, prov = "IDX" })
 *       -> Safe "Your next transfer hides among 1,284 notes in one pool shared by 7 tokens."
 *          plus a 4px log-scale bar with ticks at 10, 100, 1k, 10k, 100k and the caveat tooltip.
 *          notes null -> skeleton.
 *   ANON_TIP                         the caveat sentence
 *   linkMeter(level 1..3, text)      3 segments (24x4px each) plus one sentence.
 *                                    3 = unlinked (--proof), 2 = shared key (--warn), 1 = linked (--danger)
 *   LINK_TEXT                        { relayer, builtin, unisat(addr), mint } approved sentences
 *   strengthMeter(score 0..4, text?) 4-segment hairline (password strength)
 */
import { html } from "./dom.js";
import { int } from "./format.js";
import { prov as provChip } from "./prov.js";

export const ANON_TIP =
  "Timing, the fee payer and unusual amounts can still narrow this down. Pay fees from a key funded apart from your main wallet, and don't send right after you receive.";

export function anonPosition(n) {
  const v = Math.max(1, Number(n) || 1);
  return Math.min(1, Math.log10(v) / 6);
}

export function anonMeter({ notes = null, tokens = null, prov = "IDX" } = {}) {
  if (notes === null || notes === undefined) {
    return html`<div class="anon"><span class="skel" style="width:70%;height:16px"></span><div class="anon-bar"><span class="anon-fill" style="width:0"></span></div></div>`;
  }
  const pos = (anonPosition(notes) * 100).toFixed(2);
  const ticks = [1, 2, 3, 4, 5].map((e) => html`<span class="anon-tick" style="left:${((e / 6) * 100).toFixed(2)}%" data-label="${["10", "100", "1k", "10k", "100k"][e - 1]}"></span>`);
  const tokenPart = tokens === null || tokens === undefined ? "" : ` in one pool shared by ${int(tokens)} ${Number(tokens) === 1 ? "token" : "tokens"}`;
  return html`<div class="anon" data-tip="${ANON_TIP}" tabindex="0">
    <p class="anon-copy">Your next transfer hides among <span class="mono anon-n">${int(notes)}</span> notes${tokenPart}. ${provChip(prov)}</p>
    <div class="anon-bar" role="meter" aria-valuemin="1" aria-valuemax="1000000" aria-valuenow="${Number(notes)}" aria-label="Anonymity set, log scale"><span class="anon-fill" style="width:${pos}%"></span>${ticks}</div>
    <div class="anon-scale mono" aria-hidden="true"><span>1</span><span>1M</span></div>
  </div>`;
}

export const LINK_TEXT = {
  relayer:
    "On Bitcoin, relayer coins carry the transfer, not yours. The relayer knows which balance paid and the address you topped up from. It can't read or change the contents: the proof binds every byte.",
  builtin: "Every transfer paid by this key shares one Bitcoin address.",
  unisat: (addr) => `Linked to your Unisat address ${addr} on Bitcoin.`,
  mint: "Mints are always paid from a Bitcoin address, so this mint is linked to it. Later private transfers aren't, unless that address pays their fees too.",
};

export function linkMeter(level, text) {
  const l = Math.max(1, Math.min(3, Number(level) || 1));
  const tone = l === 3 ? "proof" : l === 2 ? "warn" : "danger";
  const label = l === 3 ? "Unlinked" : l === 2 ? "Shared address" : "Linked";
  return html`<div class="linkm linkm--${tone}">
    <span class="linkm-segs" role="img" aria-label="Linkability: ${label}, ${l} of 3">${[1, 2, 3].map((i) => html`<span class="linkm-seg${i <= l ? " is-on" : ""}"></span>`)}</span>
    <span class="linkm-text caption">${text}</span>
  </div>`;
}

export function strengthMeter(score, text = null) {
  const s = Math.max(0, Math.min(4, Number(score) || 0));
  const tone = s >= 3 ? "proof" : s === 2 ? "warn" : "danger";
  return html`<div class="strength strength--${tone}"><span class="strength-segs" role="img" aria-label="Password strength ${s} of 4">${[1, 2, 3, 4].map((i) => html`<span class="strength-seg${i <= s ? " is-on" : ""}"></span>`)}</span>${text ? html`<span class="caption t-3">${text}</span>` : ""}</div>`;
}

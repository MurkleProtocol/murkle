/**
 * Root Match chip (visual.md section 6.3): does the note-tree root rebuilt in this browser
 * match the indexer's? Lives in the top bar; the popover explains the readout.
 *
 * Root status (the shell keeps it in ui/status.js; wallet and verifier code update it):
 *   { state: "checking" | "match" | "indexer" | "mismatch",
 *     root?: hex (indexer root), localRoot?: hex, height?: number,
 *     commitments?: number, ms?: number, error?: string }
 *
 * API
 *   ROOT_MISMATCH_REASON           reason line for disabled chain-writing buttons
 *   rootChip(status, { compact })  -> Safe <button data-rootchip>. The short root hash sits in
 *                                     .rc-hash (shown from 1280px); compact drops it entirely
 *   rootDetails(status)            -> Safe popover/sheet body with
 *                                     <button data-action="root-rebuild"> and a link to the
 *                                     public indexer switch (no wallet needed)
 *   rootSentence(status) -> string
 */
import { html } from "./dom.js";
import { icon } from "./icons.js";
import { prov, REBUILD_TIP } from "./prov.js";
import { fieldHex, int, ms, short, heightText, hash, DASH } from "./format.js";
import { INDEXER_HREF } from "./indexer.js";

export const ROOT_MISMATCH_REASON = "Root mismatch: switch indexer or sync again";

export function rootSentence(s) {
  const at = s.height != null ? ` at ${heightText(s.height)}` : "";
  switch (s.state) {
    case "match":
      return `Your browser rebuilt the note tree from the indexer's ${int(s.commitments ?? 0)} commitments and got the same root it reports${at}: its list and its root agree. Only Verify the Pool checks them against Bitcoin.`;
    case "mismatch":
      return `Your browser rebuilt the note tree and got a different root than the indexer${at}. Don't sign anything until this is resolved.`;
    case "checking":
      return "Your browser is rebuilding the note tree from the indexer's commitments.";
    default:
      return `The indexer reports this root${at}. Your browser hasn't rebuilt the tree yet.`;
  }
}

export function rootChip(s = { state: "checking" }, { compact = false } = {}) {
  const st = s.state ?? "checking";
  const r = s.root ? short(fieldHex(s.root)) : DASH;
  let body;
  switch (st) {
    case "match":
      body = html`${icon("check", { size: 12 })}<span>Root${compact ? "" : html`<span class="rc-hash"> ${r}</span>`}</span>${prov("IDX", { tip: false })}`;
      break;
    case "indexer":
      body = html`<span>Root${compact ? "" : html`<span class="rc-hash"> ${r}</span>`}</span>${prov("IDX", { tip: false })}`;
      break;
    case "mismatch":
      body = html`${icon("cross", { size: 12 })}<span>Root mismatch</span>`;
      break;
    default:
      body = html`<span class="spinner spinner--10" aria-hidden="true"></span><span>Root…</span>`;
  }
  return html`<button type="button" class="rootchip rootchip--${st}${compact ? " rootchip--compact" : ""}" data-rootchip aria-haspopup="dialog" aria-label="Root match: ${rootSentence(s)}">${body}</button>`;
}

export function rootDetails(s = { state: "checking" }) {
  const row = (k, v) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`;
  const localChip = s.state === "match" ? prov("IDX", { tip: REBUILD_TIP }) : s.state === "mismatch" ? html`<span class="tag tag--danger">differs</span>` : "";
  return html`<div class="rootdetails">
    <div class="eyebrow">ROOT MATCH</div>
    <p class="small">${rootSentence(s)}</p>
    <dl class="kv kv--compact">
      ${row("Indexer root", html`${s.root ? hash(fieldHex(s.root), { head: 6, tail: 6 }) : DASH} ${prov("IDX")}`)}
      ${row("Local root", html`${s.localRoot ? hash(fieldHex(s.localRoot), { head: 6, tail: 6 }) : DASH} ${localChip}`)}
      ${row("Commitments", html`<span class="mono">${s.commitments != null ? int(s.commitments) : DASH}</span>`)}
      ${row("Time", html`<span class="mono">${s.ms != null ? ms(s.ms) : DASH}</span>`)}
    </dl>
    ${s.error ? html`<p class="caption t-danger">${s.error}</p>` : ""}
    <div class="cluster">
      <button type="button" class="btn btn--secondary btn--sm" data-action="root-rebuild" data-autofocus>${icon("refresh", { size: 16 })}Rebuild now</button>
      <a class="btn btn--ghost btn--sm" href="${INDEXER_HREF}" data-link>Use your own indexer…</a>
    </div>
  </div>`;
}

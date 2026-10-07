/**
 * Standard components (visual.md section 7). Every function returns Safe HTML (see dom.js);
 * interactive parts are wired by global behaviors (ui/behaviors.js) or by the view through
 * `data-action` attributes and event delegation.
 *
 * API
 *   button({ label, kind, size, href, icon, iconRight, action, disabled, reason, loading, type,
 *            block, attrs, cls })
 *       kind: "neutral" (default; Open wallet, Unlock, Continue, Verify in my browser)
 *             | "btc" (ONLY the final action that signs; the label states the cost)
 *             | "secondary" | "ghost" | "danger"
 *       size: "sm" 32 | "md" 40 (default) | "lg" 48 (phone primary)
 *       disabled + reason: renders the reason line under the button (never silently disabled).
 *       loading: a 14px ring plus `loading` as the live label (e.g. "Proving… 0.8 s").
 *   iconButton({ icon, label, action, href, size = 40, attrs })     label is required (aria)
 *   panel({ eyebrow, title, actions, body, certified, cls, id, tag = "section" })
 *   statTile({ eyebrow, value, unit, foot, prov, id })   value null -> skeleton (no fake numbers)
 *   statusPill(kind, text?)  kind: "open" | "upcoming" | "soldout" | "ended"
 *   opBadge(op)              DEPLOY | MINT | MINT_SCRIPT | TRANSFER (TRANSACT shows as TRANSFER) | ATTEST
 *   tag(text, tone = "neutral" | "warn" | "danger" | "proof" | "btc", { hatched, solid })
 *   signetChip()             the network chip next to the wordmark: "SIGNET" on signet; on mainnet
 *                            "MAINNET · NOT LAUNCHED" until a genesis is pinned, then "MAINNET"
 *   progress({ value, max, soldOut, label = true, unit = "mints", size = 4 })
 *   empty({ text, action: { label, href } })   line-art merkle branch, one sentence, one action
 *   skeleton({ width, height, lines })
 *   spinner(size = 14)
 *   segmented(options [{ value, label }], { value, name, label, size })
 *       Emits "seg-change" (bubbles, detail { value, name }) via ui/behaviors.js. Becomes a
 *       <select> under 360px.
 *   field({ label, name, id, type, value, placeholder, help, error, valid, mono, suffix, chips,
 *           textarea, rows, attrs })   chips: [{ label, action }] e.g. Paste / Max
 *   kv(rows [[label, value]], { compact })      a <dl>
 *   table({ columns [{ key, label, align, mono }], rows [{ key: value, _attrs? }], caption, empty })
 *       Rows restack as cards under 720px (each <td> carries data-label).
 *   faq(items [{ q, a }])                      <details> accordion
 *   payerCard({ value, name, title, status, fee, link: { level 1..3, text }, checked, disabled,
 *               reason, warning })             fee payer radio card with its linkability meter
 *   stepper(steps [{ label, status: pending|running|ok|fail|skip, ms, detail, prov }])
 *   disclosure({ op, publicRows [[k, v]], hidden [text], note })
 *       Disclosure Preview "What becomes public" (mandatory before every chain-writing action).
 *   eyebrow(text)
 */
import { NETWORK, PRE_GENESIS } from "../../../src/params.mjs";
import { attrs as toAttrs, cls as cx, esc, html, raw, Safe, uid } from "./dom.js";
import { icon } from "./icons.js";
import { prov as provChip } from "./prov.js";
import { int, pct, ms as fmtMs } from "./format.js";
import { linkMeter } from "./meter.js";

export const eyebrow = (text) => html`<div class="eyebrow">${text}</div>`;

export function spinner(size = 14) {
  return raw(`<span class="spinner spinner--${size}" aria-hidden="true"></span>`);
}

export function button({
  label,
  kind = "neutral",
  size = "md",
  href = null,
  icon: ic = null,
  iconRight = null,
  action = null,
  disabled = false,
  reason = null,
  loading = null,
  type = "button",
  block = false,
  attrs = {},
  cls = "",
} = {}) {
  const classes = cx("btn", `btn--${kind}`, size !== "md" && `btn--${size}`, block && "btn--block", loading && "is-loading", cls);
  const inner = loading
    ? html`${spinner(14)}<span class="btn-live" aria-live="polite">${loading}</span>`
    : html`${ic ? icon(ic, { size: 16 }) : ""}<span>${label}</span>${iconRight ? icon(iconRight, { size: 16 }) : ""}`;
  const a = { ...attrs, "data-action": action };
  let el;
  if (href && !disabled) {
    const external = /^https?:/.test(href);
    el = html`<a class="${classes}" href="${href}"${toAttrs(a)}${external ? raw(' target="_blank" rel="noopener noreferrer"') : raw(" data-link")}>${inner}</a>`;
  } else {
    const rid = reason && disabled ? uid("why") : null;
    el = html`<button type="${type}" class="${classes}"${toAttrs({ ...a, disabled: disabled || !!loading, "aria-describedby": rid, "aria-busy": loading ? "true" : null })}>${inner}</button>`;
    if (rid) return html`<span class="btn-wrap${block ? " btn-wrap--block" : ""}">${el}<span class="reason caption" id="${rid}">${reason}</span></span>`;
  }
  return el;
}

export function iconButton({ icon: ic, label, action = null, href = null, size = 40, attrs = {}, cls = "" }) {
  const c = cx("icon-btn", size === 32 && "icon-btn--sm", cls);
  const a = toAttrs({ ...attrs, "data-action": action, "aria-label": label, "data-tip": label });
  return href
    ? html`<a class="${c}" href="${href}" data-link${a}>${icon(ic)}</a>`
    : html`<button type="button" class="${c}"${a}>${icon(ic)}</button>`;
}

export function panel({ eyebrow: eb = null, title = null, actions = null, body = "", certified = false, cls = "", id = null, tag = "section" } = {}) {
  const head =
    eb || title || actions
      ? html`<header class="panel-head"><div class="panel-titles">${eb ? html`<div class="eyebrow">${eb}</div>` : ""}${title ? html`<h3 class="h3">${title}</h3>` : ""}</div>${actions ? html`<div class="panel-actions">${actions}</div>` : ""}</header>`
      : "";
  return new Safe(`<${tag} class="${esc(cx("panel", certified && "panel--certified", cls))}"${id ? ` id="${esc(id)}"` : ""}>${head}${body}</${tag}>`);
}

export function statTile({ eyebrow: eb, value = null, unit = null, foot = null, prov = null, id = null } = {}) {
  const v =
    value === null || value === undefined
      ? html`<span class="skel skel--num" aria-label="Loading"></span>`
      : html`<span class="hero-number mono" data-value>${value}</span>${unit ? html`<span class="unit">${unit}</span>` : ""}`;
  return html`<div class="stat"${toAttrs({ id })}><div class="stat-top"><span class="eyebrow">${eb}</span>${prov ? provChip(prov) : ""}</div><div class="stat-v">${v}</div>${foot ? html`<div class="caption t-3">${foot}</div>` : ""}</div>`;
}

const PILL = { open: "OPEN", upcoming: "UPCOMING", soldout: "MINTED OUT", ended: "ENDED" };
export function statusPill(kind, text = null) {
  return html`<span class="spill spill--${kind}">${kind === "open" ? raw('<span class="spill-dot" aria-hidden="true"></span>') : ""}${text ?? PILL[kind] ?? kind}</span>`;
}

export function opBadge(op) {
  const name = op === "TRANSACT" ? "TRANSFER" : op === "MINT_SCRIPT" ? "MINT" : op;
  const tone = name === "DEPLOY" || name === "MINT" ? "btc" : name === "TRANSFER" ? "neutral" : "neutral";
  return html`<span class="opbadge opbadge--${tone}">${name === "TRANSFER" ? icon("lock", { size: 10 }) : ""}${name}</span>`;
}

export function tag(text, tone = "neutral", { hatched = false, solid = false } = {}) {
  return html`<span class="${cx("tag", `tag--${tone}`, hatched && "tag--hatched", solid && "tag--solid")}">${text}</span>`;
}

const NETWORK_CHIP = NETWORK === "signet" ? "SIGNET" : PRE_GENESIS ? `${NETWORK.toUpperCase()} · NOT LAUNCHED` : NETWORK.toUpperCase();
export const signetChip = () => html`<span class="chip-signet">${NETWORK_CHIP}</span>`;

export function progress({ value, max, soldOut = false, label = true, unit = "mints", size = 4 } = {}) {
  const known = value !== null && value !== undefined && max;
  const p = known ? Math.min(100, (100 * Number(value)) / Number(max)) : 0;
  const full = soldOut || (known && Number(value) >= Number(max));
  return html`<div class="progress${size === 8 ? " progress--lg" : ""}">
    <div class="progress-track${full ? " is-full" : ""}" role="progressbar" aria-valuemin="0" aria-valuemax="${max ?? 0}" aria-valuenow="${value ?? 0}" aria-label="${known ? `${int(value)} of ${int(max)} ${unit}` : "Loading"}">
      <span class="progress-fill" style="width:${p.toFixed(2)}%"></span>
      <span class="progress-tick" style="left:25%"></span><span class="progress-tick" style="left:50%"></span><span class="progress-tick" style="left:75%"></span>
    </div>
    ${label ? html`<div class="progress-label mono">${known ? `${int(value)} / ${int(max)} ${unit} · ${pct(value, max)}` : "—"}</div>` : ""}
  </div>`;
}

const BRANCH = raw(
  `<svg class="empty-art" width="120" height="120" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">` +
    `<path d="M57.1 28.1L38.3 54.7M62.9 28.1L81.7 54.7M34.7 61.8L25.3 90.2M37.3 61.8L46.7 90.2M82.7 61.8L73.3 90.2M85.3 61.8L94.7 90.2"/>` +
    `<circle cx="60" cy="24" r="5"/><circle cx="36" cy="58" r="4"/><circle cx="84" cy="58" r="4"/>` +
    `<circle cx="24" cy="94" r="4"/><circle cx="48" cy="94" r="4"/><circle cx="72" cy="94" r="4"/><circle cx="96" cy="94" r="4"/></svg>`,
);

export function empty({ text, action = null } = {}) {
  return html`<div class="empty">${BRANCH}<p class="empty-text">${text}</p>${action ? button({ label: action.label, href: action.href, action: action.action, kind: action.kind ?? "secondary" }) : ""}</div>`;
}

export function skeleton({ width = "100%", height = "16px", lines = 1 } = {}) {
  const one = `<span class="skel" style="width:${esc(width)};height:${esc(height)}"></span>`;
  return raw(`<span class="skel-group" aria-label="Loading">${Array.from({ length: lines }, () => one).join("")}</span>`);
}

export function segmented(options, { value = null, name = "seg", label = "Options", size = "md" } = {}) {
  const current = value ?? options[0]?.value;
  const btns = options
    .map(
      (o) =>
        html`<button type="button" role="radio" class="seg-opt" data-value="${o.value}" aria-checked="${o.value === current ? "true" : "false"}" tabindex="${o.value === current ? "0" : "-1"}">${o.icon ? icon(o.icon, { size: 16 }) : ""}<span>${o.label}</span></button>`,
    )
    .join("");
  const opts = options.map((o) => html`<option value="${o.value}"${o.value === current ? raw(" selected") : ""}>${o.label}</option>`).join("");
  return html`<div class="seg-wrap${size === "sm" ? " seg-wrap--sm" : ""}" data-seg data-name="${name}" data-value="${current}">
    <div class="seg" role="radiogroup" aria-label="${label}">${raw(btns)}</div>
    <select class="seg-select input" aria-label="${label}">${raw(opts)}</select>
  </div>`;
}

export function field({
  label,
  name,
  id = null,
  type = "text",
  value = "",
  placeholder = "",
  help = null,
  error = null,
  valid = null,
  mono = false,
  suffix = null,
  chips = [],
  textarea = false,
  rows = 4,
  attrs = {},
} = {}) {
  const fid = id ?? uid("f");
  const hid = help || error || valid ? `${fid}-msg` : null;
  const a = toAttrs({ ...attrs, id: fid, name, placeholder: placeholder || null, "aria-describedby": hid, "aria-invalid": error ? "true" : null });
  const ctl = textarea
    ? html`<textarea class="${cx("input", mono && "mono")}" rows="${rows}"${a}>${value}</textarea>`
    : html`<input class="${cx("input", mono && "mono")}" type="${type}" value="${value}"${a}>`;
  const extras =
    suffix || chips.length
      ? html`<span class="field-extras">${suffix ? html`<span class="field-suffix mono">${suffix}</span>` : ""}${chips.map((c) => html`<button type="button" class="field-chip" data-action="${c.action}">${c.label}</button>`)}</span>`
      : "";
  const msg = error
    ? html`<span class="field-msg field-msg--error caption" id="${hid}">${icon("warn", { size: 14 })}${error}</span>`
    : valid
      ? html`<span class="field-msg field-msg--valid caption" id="${hid}">${icon("check", { size: 14 })}${valid}</span>`
      : help
        ? html`<span class="field-msg caption" id="${hid}">${help}</span>`
        : "";
  return html`<div class="${cx("field", error && "has-error", extras && "has-extras")}"><label class="field-label" for="${fid}">${label}</label><span class="field-ctl">${ctl}${extras}</span>${msg}</div>`;
}

export function kv(rows, { compact = false } = {}) {
  return html`<dl class="${cx("kv", compact && "kv--compact")}">${rows.map(([k, v]) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;
}

export function table({ columns, rows, caption = null, empty: emptyText = "Nothing here yet." }) {
  const head = columns.map((c) => html`<th scope="col" class="${cx(c.align === "right" && "num")}">${c.label}</th>`);
  const body = rows.length
    ? rows.map(
        (r) =>
          html`<tr${toAttrs(r._attrs ?? {})}>${columns.map((c) => html`<td data-label="${c.label}" class="${cx(c.align === "right" && "num", c.mono && "mono")}">${r[c.key] ?? "—"}</td>`)}</tr>`,
      )
    : html`<tr><td class="table-empty" colspan="${columns.length}">${emptyText}</td></tr>`;
  return html`<div class="table-wrap"><table class="table">${caption ? html`<caption class="visually-hidden">${caption}</caption>` : ""}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function faq(items) {
  return html`<div class="faq">${items.map((it) => html`<details class="faq-item"><summary><span>${it.q}</span>${icon("chevron", { size: 16 })}</summary><div class="faq-a">${it.a}</div></details>`)}</div>`;
}

export function payerCard({ value, name = "payer", title, status = null, fee = null, link = null, checked = false, disabled = false, reason = null, warning = null } = {}) {
  const id = uid("payer");
  return html`<label class="${cx("payer", disabled && "is-disabled")}" for="${id}">
    <input type="radio" class="payer-radio" id="${id}" name="${name}" value="${value}"${checked ? raw(" checked") : ""}${disabled ? raw(" disabled") : ""}>
    <span class="payer-body">
      <span class="payer-top"><span class="payer-title">${title}</span>${status ? html`<span class="payer-status caption">${status}</span>` : ""}</span>
      ${fee ? html`<span class="payer-fee mono">${fee}</span>` : ""}
      ${link ? linkMeter(link.level, link.text) : ""}
      ${disabled && reason ? html`<span class="reason caption">${reason}</span>` : ""}
      ${warning ? html`<span class="payer-warn caption">${icon("warn", { size: 14 })}${warning}</span>` : ""}
    </span>
  </label>`;
}

const STEP_GLYPH = {
  pending: () => raw('<span class="step-g step-g--pending" aria-hidden="true"></span>'),
  running: () => spinner(12),
  ok: () => html`<span class="step-g step-g--ok">${icon("check", { size: 12 })}</span>`,
  fail: () => html`<span class="step-g step-g--fail">${icon("cross", { size: 12 })}</span>`,
  skip: () => raw('<span class="step-g step-g--skip" aria-hidden="true">–</span>'),
};

export function stepper(steps) {
  return html`<ol class="stepper" aria-live="polite">${steps.map(
    (s, i) => html`<li class="step step--${s.status ?? "pending"}">
      <span class="step-n mono">${String(i + 1).padStart(2, "0")}</span>
      ${(STEP_GLYPH[s.status] ?? STEP_GLYPH.pending)()}
      <span class="step-text"><span class="step-label">${s.label}</span>${s.detail ? html`<span class="step-detail caption">${s.detail}</span>` : ""}</span>
      ${s.prov ? provChip(s.prov) : raw("<span></span>")}
      <span class="step-ms mono">${s.ms != null ? fmtMs(s.ms) : ""}</span>
    </li>`,
  )}</ol>`;
}

export function disclosure({ op = "Send", publicRows = [], hidden = [], note = null } = {}) {
  return html`<section class="disclosure panel panel--certified" aria-label="What becomes public">
    <div class="eyebrow">WHAT BECOMES PUBLIC · ${op.toUpperCase()}</div>
    <div class="disc-cols">
      <div class="disc-col disc-col--public">
        <div class="disc-h">${icon("block", { size: 16 })}Public on Bitcoin</div>
        ${kv(publicRows, { compact: true })}
      </div>
      <div class="disc-col disc-col--hidden">
        <div class="disc-h">${icon("proof", { size: 16 })}Hidden by proof</div>
        ${hidden.length ? html`<ul class="disc-list">${hidden.map((h) => html`<li>${h}</li>`)}</ul>` : html`<p class="small t-2">Nothing.</p>`}
      </div>
    </div>
    ${note ? html`<p class="caption t-2 disc-note">${note}</p>` : ""}
  </section>`;
}

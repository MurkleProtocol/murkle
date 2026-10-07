/**
 * Formatting helpers (visual.md section 4). Everything is fixed to en-US; never call
 * toLocaleString() directly. Missing values (null/undefined) render as "—", never as 0.
 *
 * Text helpers (return plain strings)
 *   int(n)                  "1,284"  (number | bigint | decimal string)
 *   units(value, div)       "12,500.25"  base units -> decimal, grouped, trailing zeros trimmed
 *   sats(n)                 "1,240 sats" / "1 sat"
 *   heightText(h)           "#263,104"
 *   date(ms)                "Oct 2, 2026, 2:05 PM"
 *   rel(ms, now?)           "12 s ago", "4 min ago", "3 h ago", "2 d ago" ("in 4 min" for the future)
 *   relBlocks(n)            "3 blocks ago" / "1 block ago" / "this block"
 *   short(hex, head, tail)  "1a2b…9f8e" (default 4 + 4)
 *   bytes(n)                "471 bytes", "12.3 MB" (decimal units)
 *   ms(n)                   "412 ms", "1.2 s"
 *   pct(part, whole)        "41%"
 *   eta(blocks)             "about 6 h" (10-minute blocks)
 *   plural(n, one, many?)   "1 block" / "3 blocks"
 *
 * Markup helpers (return Safe HTML, see dom.js)
 *   height(h)                         <span class="height mono">#263,104</span> in --btc-text
 *   hash(hex, { copy, head, tail, href, label })
 *                                     8 head + "…" + 8 tail, full value in title, copy button
 *   chunks(hex)                       groups of 4 with a 0.25ch gap, wraps anywhere
 *   addr(address, { copy })           shielded address: HRP + chunked body, first and last 6 chars
 *                                     in --text, the middle in --text-2
 *   copyButton(value, { label })      icon button handled by the global [data-copy] behavior
 */
import { esc, html, raw, Safe } from "./dom.js";
import { icon } from "./icons.js";

export const DASH = "—";
const missing = (v) => v === null || v === undefined || v === "" || (typeof v === "number" && !Number.isFinite(v));

const NF = new Intl.NumberFormat("en-US");
const NF1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const DF = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

function toBig(v) {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`not an integer: ${s}`);
  return BigInt(s);
}

export function int(n) {
  if (missing(n)) return DASH;
  if (typeof n === "number") return NF.format(n);
  return NF.format(toBig(n));
}

/** Groups the integer part from the BigInt itself, so supplies above 2^53 stay exact. */
export function units(value, div = 0) {
  if (missing(value)) return DASH;
  const v = toBig(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(div);
  const whole = NF.format(abs / base);
  let frac = div > 0 ? (abs % base).toString().padStart(div, "0").replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export function sats(n) {
  if (missing(n)) return DASH;
  const one = typeof n === "bigint" ? n === 1n : Number(n) === 1;
  return `${int(n)} ${one ? "sat" : "sats"}`;
}

export function heightText(h) {
  return missing(h) ? DASH : `#${int(h)}`;
}

export function height(h) {
  if (missing(h)) return raw(DASH);
  return html`<span class="height mono">${heightText(h)}</span>`;
}

export function date(ms) {
  if (missing(ms)) return DASH;
  const t = typeof ms === "string" ? Date.parse(ms) : Number(ms);
  return Number.isFinite(t) ? DF.format(t) : DASH;
}

export function rel(ms, now = Date.now()) {
  if (missing(ms)) return DASH;
  const t = typeof ms === "string" ? Date.parse(ms) : Number(ms);
  if (!Number.isFinite(t)) return DASH;
  const d = now - t;
  const a = Math.abs(d) / 1000;
  if (a < 2) return "just now";
  let txt;
  if (a < 60) txt = `${Math.floor(a)} s`;
  else if (a < 3600) txt = `${Math.floor(a / 60)} min`;
  else if (a < 86400) txt = `${Math.floor(a / 3600)} h`;
  else txt = `${Math.floor(a / 86400)} d`;
  return d >= 0 ? `${txt} ago` : `in ${txt}`;
}

export function relBlocks(n) {
  if (missing(n)) return DASH;
  const v = Number(n);
  if (v <= 0) return "this block";
  return `${int(v)} ${v === 1 ? "block" : "blocks"} ago`;
}

export const plural = (n, one, many = `${one}s`) => `${int(n)} ${Number(n) === 1 ? one : many}`;

/**
 * A note-tree root or other field element (decimal string or bigint) as the
 * 64-char hex that receipts, the explorer and search use. Unparsable input is
 * returned unchanged.
 */
export function fieldHex(v) {
  try {
    return BigInt(v).toString(16).padStart(64, "0");
  } catch {
    return String(v);
  }
}

export function short(hex, head = 4, tail = 4) {
  if (missing(hex)) return DASH;
  const s = String(hex);
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export function bytes(n) {
  if (missing(n)) return DASH;
  const v = Number(n);
  if (v < 1000) return `${int(v)} ${v === 1 ? "byte" : "bytes"}`;
  if (v < 1e6) return `${NF1.format(v / 1e3)} kB`;
  if (v < 1e9) return `${NF1.format(v / 1e6)} MB`;
  return `${NF1.format(v / 1e9)} GB`;
}

export function ms(n) {
  if (missing(n)) return DASH;
  const v = Number(n);
  return v < 1000 ? `${Math.max(0, Math.round(v))} ms` : `${NF1.format(v / 1000)} s`;
}

export function pct(part, whole) {
  if (missing(part) || missing(whole) || Number(whole) === 0) return DASH;
  return `${Math.floor((100 * Number(part)) / Number(whole))}%`;
}

export function eta(blocks) {
  if (missing(blocks)) return DASH;
  const min = Math.max(0, Number(blocks)) * 10;
  if (min < 60) return `about ${Math.max(10, Math.round(min / 10) * 10)} min`;
  if (min < 48 * 60) return `about ${Math.round(min / 60)} h`;
  return `about ${Math.round(min / 1440)} d`;
}

export function copyButton(value, { label = "Copy" } = {}) {
  return html`<button type="button" class="icon-btn icon-btn--xs copy" data-copy="${value}" aria-label="${label}" data-tip="${label}">${icon("copy", { size: 14 })}</button>`;
}

export function hash(hex, { copy = true, head = 8, tail = 8, href = null, label = "Copy" } = {}) {
  if (missing(hex)) return raw(DASH);
  const s = String(hex);
  const body =
    s.length <= head + tail + 1
      ? html`<span class="hash-h">${s}</span>`
      : html`<span class="hash-h">${s.slice(0, head)}</span><span class="hash-e">…</span><span class="hash-h">${s.slice(-tail)}</span>`;
  const inner = href ? html`<a class="hash-link" href="${href}" data-link>${body}</a>` : body;
  return html`<span class="hash mono" title="${s}">${inner}${copy ? copyButton(s, { label }) : ""}</span>`;
}

export function chunks(hex) {
  if (missing(hex)) return raw(DASH);
  const s = String(hex);
  const groups = s.match(/.{1,4}/g) ?? [];
  return new Safe(`<span class="chunks mono">${groups.map((g) => `<span>${esc(g)}</span>`).join("")}</span>`);
}

/** Shielded address: "mrk1" + chunked body. Splits at the separator "1" closest to the end (bech32m). */
export function addr(address, { copy = true } = {}) {
  if (missing(address)) return raw(DASH);
  const s = String(address);
  const sep = s.lastIndexOf("1");
  const hrp = sep > 0 ? s.slice(0, sep + 1) : "";
  const body = s.slice(hrp.length);
  // Chunk the whole body in fours, then color by character position so the
  // groups stay even while the first and last six characters stand out.
  const hi = (i) => body.length <= 12 || i < 6 || i >= body.length - 6;
  let inner = "";
  for (let o = 0; o < body.length; o += 4) {
    let group = "";
    let run = "";
    let runHi = null;
    for (let i = o; i < Math.min(o + 4, body.length); i++) {
      if (runHi !== null && hi(i) !== runHi) {
        group += `<span class="${runHi ? "addr-hi" : "addr-mid"}">${esc(run)}</span>`;
        run = "";
      }
      runHi = hi(i);
      run += body[i];
    }
    group += `<span class="${runHi ? "addr-hi" : "addr-mid"}">${esc(run)}</span>`;
    inner += `<span class="addr-g">${group}</span>`;
  }
  return html`<span class="addr mono" title="${s}"><span class="addr-g addr-hrp">${hrp}</span>${raw(inner)}${copy ? copyButton(s, { label: "Copy address" }) : ""}</span>`;
}

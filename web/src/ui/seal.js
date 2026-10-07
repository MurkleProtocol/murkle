/**
 * Dual Seal (visual.md section 6.2): the brand emblem and the "verified on Bitcoin" badge.
 * Left half = ON BITCOIN (orange), right half = VERIFIED (green). An outline means someone
 * else says so; a solid fill means this browser checked it. Text always accompanies color.
 *
 * Seal input (shared by every variant):
 *   {
 *     state: "mempool" | "mined" | "accepted" | "verified" | "rejected" | "mismatch" | "dropped",
 *     height?: number, confirmations?: number, vsize?: number,
 *     ms?: number,            // browser verification time (verified)
 *     reason?: string,        // rejected
 *     deploy?: boolean,       // DEPLOY has no proof: "Terms checked in this browser"
 *     settingsHref?: string,  // mismatch link (default "/verify#indexer", no wallet needed)
 *   }
 *
 * API
 *   SEAL_STATES                     list of states
 *   sealLabel(seal) -> string       full sentence for aria-label
 *   sealPill(seal) -> Safe          24px two-segment pill for lists
 *   sealBlock(seal) -> Safe         72px two-cell block. Cells carry data-action="transcript";
 *                                   the IDX state adds <button data-action="verify">Verify</button>.
 *                                   The view wires both actions (event delegation).
 *   sealEmblem(seal, { size, proof, ring, op })
 *                                   -> Safe SVG (viewBox 200). `proof` (bytes|hex) draws the
 *                                   Proofprint in the plate; `ring` is the hex-ring text
 *                                   (default "<op> · #<height> · <proof hex>").
 *                                   Always follow it with sealBlock so all state text is in HTML.
 *   stamp(el)                       plays the 500ms stamp once (band draw, scale .97 -> 1, disc
 *                                   fade). No-op with reduced motion. `el` is the emblem <svg>.
 */
import { esc, html, Safe, uid, reducedMotion } from "./dom.js";
import { icon } from "./icons.js";
import { int, ms as fmtMs, heightText } from "./format.js";
import { proofprint } from "./proofprint.js";
import { INDEXER_HREF } from "./indexer.js";

export const SEAL_STATES = ["mempool", "mined", "accepted", "verified", "rejected", "mismatch", "dropped"];

const check = (s) => {
  if (!SEAL_STATES.includes(s?.state)) throw new Error(`unknown seal state: ${s?.state}`);
  return s;
};

const confLong = (n) => (n === null || n === undefined ? null : `${int(n)} ${Number(n) === 1 ? "confirmation" : "confirmations"}`);
const minedState = (st) => st === "mined" || st === "accepted" || st === "verified" || st === "rejected";

export function sealLabel(seal) {
  const s = check(seal);
  const where =
    s.state === "mempool"
      ? "In the mempool, not in a block yet."
      : s.state === "dropped"
        ? "Dropped from the mempool."
        : `Mined in block ${int(s.height)}${s.confirmations ? `, ${confLong(s.confirmations)}` : ""}.`;
  const what = {
    mempool: "Proof check waits for a block.",
    mined: "Waiting for the indexer.",
    accepted: "Accepted by the indexer; not yet checked in this browser.",
    verified: s.deploy ? "Terms checked in this browser." : "Proof verified in this browser.",
    rejected: `Rejected by the indexer${s.reason ? `: ${s.reason}` : ""}.`,
    mismatch: "This browser disagrees with the indexer. Do not trust this indexer.",
    dropped: "",
  }[s.state];
  return `${where} ${what}`.trim();
}

export function sealPill(seal) {
  const s = check(seal);
  const left =
    s.state === "mempool" ? "mempool" : s.state === "dropped" ? "dropped" : s.height != null ? heightText(s.height) : "mined";
  const right = { mempool: "WAIT", mined: "WAIT", accepted: "IDX", verified: "YOU", rejected: "REJ", mismatch: "ERR", dropped: "—" }[s.state];
  return html`<span class="seal-pill seal--${s.state}" role="img" aria-label="${sealLabel(s)}"><span class="sp-l">${icon("block", { size: 12 })}<span class="mono">${left}</span></span><span class="sp-r">${icon("proof", { size: 12 })}<span class="mono">${right}</span></span></span>`;
}

export function sealBlock(seal) {
  const s = check(seal);
  const settings = s.settingsHref ?? INDEXER_HREF;
  if (s.state === "mismatch") {
    return html`<div class="seal-block seal--mismatch" role="group" aria-label="${sealLabel(s)}">
      <div class="sb-cell sb-full">
        <span class="eyebrow">${icon("warn", { size: 12 })} Indexer mismatch</span>
        <span class="sb-value">Do not trust this indexer</span>
        <span class="caption">Your browser got a different result. <a href="${settings}" data-link>Switch indexer</a></span>
      </div></div>`;
  }
  const mined = minedState(s.state);
  const leftValue = s.state === "mempool" ? "In mempool" : s.state === "dropped" ? "Dropped" : heightText(s.height);
  const leftCap =
    s.state === "mempool"
      ? "Not in a block yet"
      : s.state === "dropped"
        ? "Dropped from mempool"
        : [confLong(s.confirmations), s.vsize ? `${int(s.vsize)} vB` : null].filter(Boolean).join(" · ") || "In a block";
  let rightValue;
  let rightCap;
  let verifyBtn = "";
  switch (s.state) {
    case "mempool":
      rightValue = "Awaiting block";
      rightCap = "Checked once mined";
      break;
    case "mined":
      rightValue = "Waiting for indexer";
      rightCap = "Not checked yet";
      break;
    case "accepted":
      rightValue = "Accepted by indexer";
      rightCap = "Not checked in this browser";
      verifyBtn = html`<button type="button" class="btn btn--ghost btn--xs" data-action="verify">Verify</button>`;
      break;
    case "verified":
      rightValue = s.deploy ? "Terms checked" : "in this browser";
      rightCap = s.deploy ? "in this browser" : `Groth16${s.ms != null ? ` · ${fmtMs(s.ms)}` : ""}`;
      break;
    case "rejected":
      rightValue = "Rejected";
      rightCap = s.reason ?? "By the indexer's rules";
      break;
    default:
      rightValue = "—";
      rightCap = "";
  }
  const cell = (side, eyebrow, value, cap, extra = "", mono = false) =>
    html`<div class="sb-cell sb-${side}" data-action="transcript" role="button" tabindex="0" aria-label="${eyebrow}: ${value}. Open the transcript.">
      <span class="eyebrow">${eyebrow}</span>
      <span class="sb-value${mono ? " mono" : ""}">${value}</span>
      <span class="caption">${cap}</span>${extra}</div>`;
  return html`<div class="seal-block seal--${s.state}${mined ? " is-mined" : ""}" role="group" aria-label="${sealLabel(s)}">
    ${cell("l", "ON BITCOIN", leftValue, leftCap, "", s.state !== "mempool" && s.state !== "dropped")}
    ${cell("r", "VERIFIED", rightValue, rightCap, verifyBtn)}
  </div>`;
}

/* ---------- emblem ---------- */

const C = 100;
const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
};
// Clockwise from 12 o'clock. 160-degree arcs with 20-degree gaps at 12 and 6 o'clock.
const arc = (r, from, to) => `M${pt(r, from)} A${r} ${r} 0 0 1 ${pt(r, to)}`;

let rimCache = null;
function rimPath() {
  if (rimCache) return rimCache;
  let d = "";
  for (let i = 0; i <= 360; i++) {
    const th = (i * Math.PI) / 180;
    const rho = 95 + 2 * Math.sin(36 * th);
    d += `${i ? "L" : "M"}${(C + rho * Math.cos(th)).toFixed(2)} ${(C + rho * Math.sin(th)).toFixed(2)}`;
  }
  return (rimCache = d + "Z");
}

function toHex(proof) {
  if (!proof) return "";
  if (proof instanceof Uint8Array) return Array.from(proof, (b) => b.toString(16).padStart(2, "0")).join("");
  return String(proof).replace(/^0x/, "").toLowerCase();
}

export function sealEmblem(seal, { size = 200, proof = null, ring = null, op = "TRANSACT" } = {}) {
  const s = check(seal);
  const id = uid("ring");
  const mined = minedState(s.state);
  const leftMode = s.state === "mempool" ? "dashed" : s.state === "dropped" ? "grey" : "solid";
  const rightMode = {
    mempool: "grey-dashed",
    mined: "grey-dashed",
    accepted: "outline",
    verified: "solid",
    rejected: "danger",
    mismatch: "danger",
    dropped: "grey",
  }[s.state];
  const disc = s.state === "verified" ? "ok" : s.state === "rejected" || s.state === "mismatch" ? "bad" : "wait";
  const hex = toHex(proof);
  // Like a coin's reeded edge, the ring is always full: short text repeats until it fits.
  const unit = ring ?? `${op} · ${s.height != null ? "#" + s.height : "MEMPOOL"} · ${hex || "AWAITING PROOF"}`;
  let ringText = unit;
  if (unit.length < 112) {
    while ((ringText + " · " + unit).length <= 112) ringText += ` · ${unit}`;
    ringText += " · "; // the seam reads like every other separator
  } else ringText = unit.slice(0, 112);
  const discGlyph =
    disc === "ok"
      ? `<path d="M96.6 172.2l2.4 2.4 4.4-4.8" class="disc-ink" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`
      : disc === "bad"
        ? `<path d="M97.4 169.4l5.2 5.2M102.6 169.4l-5.2 5.2" class="disc-ink" fill="none" stroke-width="1.6" stroke-linecap="round"/>`
        : `<g class="disc-ink-fill"><circle cx="96.6" cy="172" r=".9"/><circle cx="100" cy="172" r=".9"/><circle cx="103.4" cy="172" r=".9"/></g>`;
  let print = "";
  if (hex.length >= 10) {
    print = proofprint(hex, { size: 112, cx: C, cy: C, R: 56, mined, verified: s.state === "verified", bare: true }).toString();
  }
  return new Safe(
    `<svg class="seal-emblem seal--${s.state}${s.state === "mismatch" ? " is-danger" : ""}" width="${size}" height="${size}" viewBox="0 0 200 200" role="img" aria-label="${esc(sealLabel(s))}">` +
      `<circle cx="100" cy="100" r="98" class="em-rim-outer"/>` +
      `<circle cx="100" cy="100" r="92" class="em-rim-inner"/>` +
      `<path d="${rimPath()}" class="em-guilloche"/>` +
      `<path id="${id}" d="M100 16 A84 84 0 1 1 100 184 A84 84 0 1 1 100 16" fill="none" stroke="none"/>` +
      `<text class="em-ring"><textPath href="#${id}" textLength="520" lengthAdjust="spacing">${esc(ringText)}</textPath></text>` +
      `<circle cx="100" cy="100" r="64" class="em-plate"/>` +
      print +
      `<path d="${arc(72, 190, 350)}" pathLength="100" class="em-band em-band-l band--${leftMode}"/>` +
      `<path d="${arc(72, 10, 170)}" pathLength="100" class="em-band em-band-r band--${rightMode}"/>` +
      `<circle cx="100" cy="28" r="2" class="em-root"/>` +
      `<g class="em-disc disc--${disc}"><circle cx="100" cy="172" r="7"/>${discGlyph}</g>` +
      `</svg>`,
  );
}

export function stamp(el) {
  if (!el || reducedMotion()) return;
  el.classList.remove("is-stamping");
  // Force a reflow so the animation restarts when stamp() is called twice.
  void el.getBoundingClientRect();
  el.classList.add("is-stamping");
  setTimeout(() => el.classList.remove("is-stamping"), 650);
}


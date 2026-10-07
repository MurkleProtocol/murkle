/**
 * Launch kit (visual.md section 9): the announcement card, drawn client-side on
 * a canvas (1200x675, the X large-image ratio), plus the share text.
 *
 * Observer data only: ticker, status, progress, terms, the brand and the page URL. No txid unless
 * the launcher opts in (a txid ties the card to the Bitcoin address that paid the launch), and
 * never an address, a holder or an amount someone holds. Colors are the dark theme tokens, fixed,
 * so a shared PNG looks the same everywhere.
 *
 * API
 *   CARD_W, CARD_H                     1200, 675
 *   launchCardModel(asset, { height, url, includeTxid = false, brand }) -> model (pure)
 *   shareText(asset, url) -> "Mint $ABC on Bitcoin (signet test network, no value). Terms on-chain;
 *                              transfers are private, mints are public. <url>"
 *   xIntentUrl(text) -> https://x.com/intent/post?text=...
 *   drawLaunchCard(model) -> Promise<HTMLCanvasElement>   browser only
 *   toBlob, download                   re-exported from verify/share-card.js
 */
import { sigilPattern } from "../ui/sigil.js";
import { EXPLORER, NETWORK, PRE_GENESIS } from "../../../src/params.mjs";

// Leaving the site: signet says "test network, no value"; mainnet makes no value claim either way.
const ON_SIGNET = NETWORK === "signet";
const CARD_TAG = ON_SIGNET ? "SIGNET" : PRE_GENESIS ? "MAINNET · NOT LAUNCHED" : "MAINNET";
import { int, units, short } from "../ui/format.js";
import { PILL_KIND, blocksUntilOpen, priceText, scheduleText } from "./launch.js";

export { toBlob, download } from "../verify/share-card.js";

export const CARD_W = 1200;
export const CARD_H = 675;

const C = {
  bg: "#0A0B0D",
  surface: "#101215",
  surface3: "#1B1F24",
  line: "#23272D",
  lineStrong: "#333941",
  text: "#E8EBEE",
  text2: "#A2AAB4",
  text3: "#7A828C",
  btc: "#F7931A",
  btcWash: "rgba(247,147,26,.10)",
  btcLine: "rgba(247,147,26,.38)",
  warn: "#E9B949",
  redact: "#262B31",
  hatch: "rgba(255,255,255,.07)",
  sg: ["#7FA7FF", "#B79CFF", "#F28DB5", "#5CC8E0", "#D8C59A", "#A9B4C0"],
};
const SERIF = '"Instrument Serif", Georgia, serif';
const SANS = '"Instrument Sans", system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';

function statusLabel(a, height) {
  const kind = PILL_KIND[a.status] ?? "ended";
  if (kind === "open") return "OPEN";
  if (kind === "upcoming") {
    const n = blocksUntilOpen(a, height);
    return n === null ? "UPCOMING" : n === 0 ? "OPENS NEXT BLOCK" : `OPENS IN ${int(n)} ${n === 1 ? "BLOCK" : "BLOCKS"}`;
  }
  return kind === "soldout" ? "MINTED OUT" : "ENDED";
}

export function launchCardModel(a, { height = null, url = "", includeTxid = false, brand = "Murkle" } = {}) {
  const minted = Number(a.minted ?? 0);
  const cap = Number(a.mintCap ?? 0);
  return {
    brand,
    ticker: String(a.ticker),
    status: statusLabel(a, height),
    open: a.status === "live",
    soldOut: a.status === "sold-out",
    ratio: cap ? Math.min(1, minted / cap) : 0,
    progress: `${int(minted)} / ${int(cap)} mints · ${cap ? Math.floor((100 * minted) / cap) : 0}%`,
    facts: [
      ["PER MINT", `${units(a.mintAmount, a.divisibility)} ${a.ticker}`],
      ["PRICE", priceText(a)],
      ["SUPPLY", `${units(a.maxSupply, a.divisibility)}`],
    ],
    schedule: scheduleText(a, height),
    claim: "Terms on Bitcoin. No holder list.",
    url: String(url).replace(/^https?:\/\//, ""),
    txid: includeTxid && a.deployTxid ? short(a.deployTxid, 10, 10) : null,
    sigil: sigilPattern(a.id),
  };
}

// Leaves the site, so it carries the signet note and says that mints are public.
export const shareText = (a, url) => ON_SIGNET
  ? `Mint $${a.ticker} on Bitcoin (signet test network, no value). Terms on-chain; transfers are private, mints are public. ${url}`
  : `Mint $${a.ticker} on Bitcoin (experimental software). Terms on-chain; transfers are private, mints are public. ${url}`;
export const xIntentUrl = (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

/* ---------- drawing ---------- */

async function fontsReady() {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.all([`400 48px ${SERIF}`, `700 96px ${SANS}`, `600 24px ${SANS}`, `500 20px ${MONO}`].map((f) => document.fonts.load(f).catch(() => null)));
}

function backdrop(ctx) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  // The merkle lattice, faint, fanning out to the right edge.
  ctx.strokeStyle = "rgba(232,235,238,.045)";
  ctx.lineWidth = 1;
  const depth = 6;
  const x0 = 520;
  const x1 = 1170;
  const node = (d, i) => [x0 + ((x1 - x0) * d) / depth, 24 + ((i + 0.5) * (CARD_H - 48)) / 2 ** d];
  for (let d = 0; d < depth; d++) {
    for (let i = 0; i < 2 ** d; i++) {
      const [ax, ay] = node(d, i);
      for (const k of [0, 1]) {
        const [bx, by] = node(d + 1, 2 * i + k);
        const mx = (ax + bx) / 2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.bezierCurveTo(mx, ay, mx, by, bx, by);
        ctx.stroke();
      }
    }
  }
  ctx.strokeStyle = C.lineStrong;
  ctx.lineWidth = 2;
  for (const [x, y, dx, dy] of [[24, 24, 1, 1], [CARD_W - 24, 24, -1, 1], [24, CARD_H - 24, 1, -1], [CARD_W - 24, CARD_H - 24, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x, y + 16 * dy);
    ctx.lineTo(x, y);
    ctx.lineTo(x + 16 * dx, y);
    ctx.stroke();
  }
}

function tagBox(ctx, x, y, text, color, { fill = null, h = 30, font = `600 15px ${MONO}` } = {}) {
  ctx.font = font;
  const w = ctx.measureText(text).width + 20;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, h / 2 > 8 ? 6 : 4);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 10, y + h / 2 + 1);
  return w;
}

function brandRow(ctx, brand) {
  const x = 64;
  const y = 52;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(1.6, 1.6);
  ctx.strokeStyle = C.text;
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.roundRect(0.75, 0.75, 18.5, 18.5, 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(7.6, 11.8);
  ctx.lineTo(9, 9);
  ctx.moveTo(12.4, 11.8);
  ctx.lineTo(11, 9);
  ctx.stroke();
  for (const cx of [6.5, 13.5]) {
    ctx.beginPath();
    ctx.arc(cx, 14, 1.75, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.fillStyle = C.btc;
  ctx.beginPath();
  ctx.arc(10, 7, 2.25, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = C.text;
  ctx.font = `600 30px ${SANS}`;
  ctx.textBaseline = "middle";
  ctx.fillText(brand, x + 46, y + 17);
  const w = ctx.measureText(brand).width;
  tagBox(ctx, x + 62 + w, y + 3, CARD_TAG, C.warn, { h: 28, font: `600 14px ${MONO}` });
  ctx.font = `500 15px ${MONO}`;
  ctx.fillStyle = C.text3;
  ctx.textAlign = "right";
  ctx.fillText("PRIVATE TOKENS ON BITCOIN", CARD_W - 64, y + 17);
  ctx.textAlign = "left";
}

function sigilTile(ctx, model, x, y, size) {
  ctx.fillStyle = C.surface3;
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, size * 0.28);
  ctx.fill();
  ctx.stroke();
  const pad = size * 0.16;
  const cell = (size - 2 * pad) / 5;
  ctx.fillStyle = C.sg[(model.sigil.color - 1) % 6];
  model.sigil.cells.forEach((on, i) => {
    if (!on) return;
    ctx.fillRect(x + pad + (i % 5) * cell, y + pad + Math.floor(i / 5) * cell, cell + 0.5, cell + 0.5);
  });
}

function fitFont(ctx, text, weight, family, max, width) {
  let size = max;
  for (; size > 28; size -= 4) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= width) break;
  }
  return size;
}

export async function drawLaunchCard(model) {
  await fontsReady();
  const c = document.createElement("canvas");
  c.width = CARD_W;
  c.height = CARD_H;
  const ctx = c.getContext("2d");
  backdrop(ctx);
  brandRow(ctx, model.brand);

  // Identity: sigil, ticker, status.
  sigilTile(ctx, model, 64, 140, 168);
  const size = fitFont(ctx, model.ticker, 700, SANS, 112, CARD_W - 64 - 268);
  ctx.font = `700 ${size}px ${SANS}`;
  ctx.fillStyle = C.text;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(model.ticker, 264, 140 + 96);
  if (model.open) tagBox(ctx, 266, 262, `●  ${model.status}`, C.btc, { fill: C.btcWash });
  else tagBox(ctx, 266, 262, model.status, model.soldOut ? C.text2 : C.text3);

  // Progress: an 12px track, --btc fill, ticks at 25/50/75%; hatched when minted out.
  const px = 64;
  const pw = CARD_W - 128;
  const py = 362;
  ctx.fillStyle = C.surface3;
  ctx.beginPath();
  ctx.roundRect(px, py, pw, 12, 6);
  ctx.fill();
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(px, py, pw, 12, 6);
  ctx.clip();
  ctx.fillStyle = model.soldOut ? C.lineStrong : C.btc;
  ctx.fillRect(px, py, pw * model.ratio, 12);
  if (model.soldOut) {
    ctx.strokeStyle = C.hatch;
    ctx.lineWidth = 2;
    for (let i = 0; i < pw + 12; i += 7) {
      ctx.beginPath();
      ctx.moveTo(px + i, py + 12);
      ctx.lineTo(px + i + 12, py);
      ctx.stroke();
    }
  }
  ctx.fillStyle = C.bg;
  for (const f of [0.25, 0.5, 0.75]) ctx.fillRect(px + pw * f, py, 2, 12);
  ctx.restore();
  ctx.font = `500 20px ${MONO}`;
  ctx.fillStyle = C.text2;
  ctx.fillText(model.progress, px, py + 46);

  // Terms.
  const colW = pw / 3;
  model.facts.forEach(([label, value], i) => {
    const x = px + i * colW;
    ctx.font = `500 15px ${MONO}`;
    ctx.fillStyle = C.text3;
    ctx.fillText(label, x, 470);
    const vs = fitFont(ctx, value, 500, MONO, 32, colW - 24);
    ctx.font = `500 ${vs}px ${MONO}`;
    ctx.fillStyle = label === "PRICE" ? C.btc : C.text;
    ctx.fillText(value, x, 512);
  });
  ctx.fillStyle = C.line;
  ctx.fillRect(px, 548, pw, 1);

  // Claim and link.
  ctx.font = `400 46px ${SERIF}`;
  ctx.fillStyle = C.text;
  ctx.fillText(model.claim, px, 606);
  if (model.url) {
    ctx.textAlign = "right";
    const us = fitFont(ctx, model.url, 500, MONO, 22, 420);
    ctx.font = `500 ${us}px ${MONO}`;
    ctx.fillStyle = C.btc;
    ctx.fillText(model.url, CARD_W - 64, 600);
    ctx.textAlign = "left";
  }
  ctx.font = `400 15px ${SANS}`;
  ctx.fillStyle = C.text3;
  const lead = ON_SIGNET ? "Signet test network: test tokens with no value." : "Bitcoin mainnet, experimental software.";
  const foot = `${lead} Mints are public; transfers are private.${model.txid ? `  Deploy tx ${model.txid}` : ""}`;
  ctx.fillText(foot, px, 642);
  return c;
}

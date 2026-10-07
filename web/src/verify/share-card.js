/**
 * Share images drawn on a canvas, client-side (visual.md section 9).
 * They carry observer data only: never amounts, tokens or addresses that a proof hides, and no
 * wallet data. Colors are the dark theme's tokens, fixed, so a shared PNG looks the same
 * everywhere.
 *
 * API
 *   receiptCard({ opName, verdict, fault, rootSource, pinned, height, txid, proof, ticker, amount, proofMs, brand })
 *       -> Promise<HTMLCanvasElement>   1200x630
 *   receiptCardText({ opName, verdict, fault, rootSource, pinned, proofMs }) -> { op, title, line, tone,
 *       proofLine, rootLine, note, footer }   the card's words, the same claims as the receipt page (pure).
 *       pinned: false for an attestation that names another manifest (result.attest.pinned)
 *   poolCard({ proofs, blocks, seconds, height, digest, matched, brand }) -> Promise<HTMLCanvasElement>
 *   poolCardText({ ... }) -> string     the same claim as copyable text, with the network's note
 *   cardNetwork({ network, notLaunched }) -> { tag, receiptFooter(hasProof), poolChain, poolFooter }
 *       the per-network words: signet says test coins with no value; mainnet names experimental
 *       software and never a value claim; mainnet before genesis says it has not launched.
 *   Every card and text function takes { network, notLaunched } (default: this build's).
 *   toBlob(canvas) -> Promise<Blob>
 *   download(canvas, filename)          saves a PNG through a temporary <a download>
 */
import { proofprintPaths } from "../ui/proofprint.js";
import { MAINNET_NOT_LAUNCHED_TEXT, NETWORK, NOT_LAUNCHED } from "../config.js";

/** The words a card uses for its network (see the API note above). */
export function cardNetwork({ network = NETWORK, notLaunched = NOT_LAUNCHED } = {}) {
  if (network === "signet") {
    return {
      tag: "SIGNET",
      receiptFooter: (hasProof) =>
        hasProof
          ? "Signet: test coins with no value. Development proving keys (A-8). Bitcoin stores the proof; browsers check it."
          : "Signet: test coins with no value. Bitcoin stores the envelope; browsers check it.",
      poolChain: (blocks) => `Bitcoin signet ${blocks === 1 ? "block" : "blocks"} (test network, no value)`,
      poolFooter: "Signet test network: test coins with no value. Block data from mempool.space; headers checked from a pinned checkpoint, block signatures not checked.",
    };
  }
  const name = `Bitcoin ${network}`;
  if (notLaunched) {
    return {
      tag: `${network.toUpperCase()} · NOT LAUNCHED`,
      receiptFooter: () => MAINNET_NOT_LAUNCHED_TEXT,
      poolChain: (blocks) => `${name} ${blocks === 1 ? "block" : "blocks"} (not launched)`,
      poolFooter: MAINNET_NOT_LAUNCHED_TEXT,
    };
  }
  return {
    tag: network.toUpperCase(),
    receiptFooter: (hasProof) =>
      hasProof
        ? `${name}, experimental software. Proving keys from the public trusted-setup ceremony. Bitcoin stores the proof; browsers check it.`
        : `${name}, experimental software. Bitcoin stores the envelope; browsers check it.`,
    poolChain: (blocks) => `${name} ${blocks === 1 ? "block" : "blocks"}`,
    poolFooter: `${name}, experimental software. Block data from mempool.space; headers checked from a pinned checkpoint (proof of work and difficulty rules).`,
  };
}

const C = {
  bg: "#0A0B0D",
  surface: "#101215",
  line: "#23272D",
  lineStrong: "#333941",
  text: "#E8EBEE",
  text2: "#A2AAB4",
  text3: "#7A828C",
  btc: "#F7931A",
  proof: "#3FD8A0",
  warn: "#E9B949",
  danger: "#F26B5E",
  redact: "#262B31",
  hatch: "rgba(255,255,255,.07)",
};
const SERIF = '"Instrument Serif", Georgia, serif';
const SANS = '"Instrument Sans", system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';
const NF = new Intl.NumberFormat("en-US");

async function fontsReady() {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.all(
    [`400 64px ${SERIF}`, `600 24px ${SANS}`, `500 20px ${MONO}`].map((f) => document.fonts.load(f).catch(() => null)),
  );
}

function canvas() {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 630;
  return c;
}

function frame(ctx) {
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, 1200, 630);
  // Faint merkle lattice fanning out to the right, as on the receipt hero.
  ctx.strokeStyle = "rgba(232,235,238,.05)";
  ctx.lineWidth = 1;
  const depth = 6;
  const x0 = 40;
  const x1 = 1160;
  const node = (d, i) => [x0 + ((x1 - x0) * d) / depth, 30 + ((i + 0.5) * 570) / 2 ** d];
  for (let d = 0; d < depth; d++) {
    for (let i = 0; i < 2 ** d; i++) {
      const [ax, ay] = node(d, i);
      for (const k of [0, 1]) {
        const [bx, by] = node(d + 1, 2 * i + k);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
    }
  }
  // Certified-panel corner ticks.
  ctx.strokeStyle = C.lineStrong;
  ctx.lineWidth = 2;
  for (const [x, y, dx, dy] of [[24, 24, 1, 1], [1176, 24, -1, 1], [24, 606, 1, -1], [1176, 606, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x, y + 16 * dy);
    ctx.lineTo(x, y);
    ctx.lineTo(x + 16 * dx, y);
    ctx.stroke();
  }
}

function brandRow(ctx, brand, net = cardNetwork()) {
  // Glyph: rounded square, two hollow leaves, the orange sealed root.
  const x = 64;
  const y = 56;
  const s = 1.6;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.strokeStyle = C.text;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(0.75, 0.75, 18.5, 18.5, 5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(7.3, 13);
  ctx.lineTo(9.4, 9.4);
  ctx.moveTo(12.7, 13);
  ctx.lineTo(10.6, 9.4);
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
  ctx.fillText(brand, x + 46, y + 16);
  const w = ctx.measureText(brand).width;
  tagBox(ctx, x + 60 + w, y + 4, net.tag, C.warn);
}

function tagBox(ctx, x, y, text, color) {
  ctx.font = `500 15px ${MONO}`;
  const w = ctx.measureText(text).width + 16;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 26, 5);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, x + 8, y + 14);
  return w;
}

function redactBar(ctx, x, y, w) {
  ctx.fillStyle = C.redact;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 24, 4);
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = C.hatch;
  ctx.lineWidth = 2;
  for (let i = -30; i < w + 30; i += 6) {
    ctx.beginPath();
    ctx.moveTo(x + i, y + 24);
    ctx.lineTo(x + i + 24, y);
    ctx.stroke();
  }
  ctx.restore();
}

function emblem(ctx, { cx, cy, proof, mined, verified, failed }) {
  ctx.save();
  ctx.strokeStyle = C.lineStrong;
  ctx.lineWidth = 1;
  for (const r of [196, 184]) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 2 * Math.PI);
    ctx.stroke();
  }
  ctx.fillStyle = C.surface;
  ctx.strokeStyle = C.line;
  ctx.beginPath();
  ctx.arc(cx, cy, 128, 0, 2 * Math.PI);
  ctx.fill();
  ctx.stroke();
  if (proof && proof.length >= 5) {
    const paths = proofprintPaths(proof, { R: 112, cx, cy });
    paths.forEach((d, k) => {
      ctx.strokeStyle = k === 0 && mined ? C.btc : k === paths.length - 1 && verified ? C.proof : "rgba(122,130,140,.7)";
      ctx.lineWidth = 1.1;
      ctx.stroke(new Path2D(d));
    });
  }
  // Dual band: left ON BITCOIN, right VERIFIED; solid when checked, thin otherwise.
  const band = (from, to, color, solid) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = solid ? 12 : 3;
    ctx.lineCap = "round";
    ctx.setLineDash(solid ? [] : [6, 6]);
    ctx.beginPath();
    ctx.arc(cx, cy, 144, from, to);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  const deg = (d) => ((d - 90) * Math.PI) / 180;
  band(deg(190), deg(350), mined ? C.btc : C.text3, mined);
  band(deg(10), deg(170), failed ? C.danger : verified ? C.proof : C.text3, verified || failed);
  ctx.fillStyle = C.btc;
  ctx.beginPath();
  ctx.arc(cx, cy - 144, 5, 0, 2 * Math.PI);
  ctx.fill();
  ctx.restore();
}

const shortHex = (h, a = 8, b = 8) => (h && h.length > a + b ? `${h.slice(0, a)}…${h.slice(-b)}` : (h ?? ""));

const ROOT_LINE = {
  replay: "Anchor root from the viewer's own replay",
  rebuild: "Anchor root rebuilt from the indexer's commitments",
  indexer: "Anchor root as reported by the indexer",
};

// The card leaves the site, so it says no more than the receipt page: no proof claim for a
// launch or an attestation, a rejection is final, a check that couldn't run isn't a failure,
// and an attestation of another manifest is not shown as a green result.
export function receiptCardText({ opName = "TRANSFER", verdict, fault = null, rootSource = null, pinned = null, proofMs = null, network = NETWORK, notLaunched = NOT_LAUNCHED }) {
  const op = opName === "TRANSACT" ? "TRANSFER" : opName === "MINT_SCRIPT" ? "MINT" : opName;
  const hasProof = op !== "DEPLOY" && op !== "ATTEST";
  const title = op === "DEPLOY" ? "Launch on Bitcoin." : op === "ATTEST" ? "Attestation on Bitcoin." : "Proof on Bitcoin.";
  let line = "Not verified yet.";
  let tone = "neutral";
  let note = null;
  if (verdict === "verified" && op === "ATTEST" && pinned === false) {
    line = "Names another manifest.";
    note = "Not the pinned circuit manifest · carries no authority · never changes the pool";
  } else if (verdict === "verified") {
    line = op === "DEPLOY" ? "Terms checked in the browser." : op === "ATTEST" ? "Checked in the browser." : "Verified in the browser.";
    tone = "proof";
  } else if (verdict === "rejected") [line, tone] = ["Rejected by the indexer.", "danger"];
  else if (verdict === "mismatch") [line, tone] = ["Browser and indexer disagree.", "danger"];
  else if (verdict === "failed") [line, tone] = fault === "data" ? ["Couldn't be checked.", "neutral"] : ["Failed in the browser.", "danger"];
  const checked = hasProof && proofMs != null && verdict === "verified";
  return {
    op,
    title,
    line,
    tone,
    proofLine: checked ? `Groth16 · ${Math.round(proofMs)} ms in the viewer's browser` : null,
    rootLine: checked ? (ROOT_LINE[rootSource] ?? null) : null,
    note,
    footer: cardNetwork({ network, notLaunched }).receiptFooter(hasProof),
  };
}

export async function receiptCard({ opName = "TRANSFER", verdict, fault = null, rootSource = null, pinned = null, height, txid, proof = null, ticker = null, amount = null, proofMs = null, brand = "Murkle", network = NETWORK, notLaunched = NOT_LAUNCHED }) {
  await fontsReady();
  const c = canvas();
  const ctx = c.getContext("2d");
  frame(ctx);
  brandRow(ctx, brand, cardNetwork({ network, notLaunched }));
  const t = receiptCardText({ opName, verdict, fault, rootSource, pinned, proofMs, network, notLaunched });
  const verified = t.tone === "proof";
  const failed = t.tone === "danger";
  const mined = height !== null && height !== undefined;
  emblem(ctx, { cx: 900, cy: 315, proof, mined, verified, failed });

  const op = t.op;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.text3;
  ctx.font = `500 18px ${MONO}`;
  ctx.fillText(`PROOF RECEIPT · ${op}`, 64, 180);
  ctx.fillStyle = C.text;
  ctx.font = `400 68px ${SERIF}`;
  ctx.fillText(t.title, 64, 256);
  ctx.fillStyle = verified ? C.proof : failed ? C.danger : C.text2;
  ctx.fillText(t.line, 64, 330);

  // What a chain observer sees.
  let y = 392;
  ctx.font = `500 18px ${MONO}`;
  if (op === "TRANSFER") {
    let x = 64;
    for (const [label, w] of [["TOKEN", 70], ["AMOUNT", 100], ["FROM", 140], ["TO", 140]]) {
      ctx.fillStyle = C.text3;
      ctx.fillText(label, x, y);
      redactBar(ctx, x, y + 12, w);
      x += Math.max(w, ctx.measureText(label).width) + 28;
    }
  } else if (op === "MINT" && ticker) {
    ctx.fillStyle = C.text2;
    const line = `+${amount ?? "?"} ${ticker} →`;
    ctx.fillText(line, 64, y + 30);
    redactBar(ctx, 64 + ctx.measureText(line).width + 12, y + 12, 140);
  }
  y = 500;
  ctx.fillStyle = C.btc;
  ctx.font = `500 22px ${MONO}`;
  const h = mined ? `#${NF.format(height)}` : "MEMPOOL";
  ctx.fillText(h, 64, y);
  const hw = ctx.measureText(h).width;
  ctx.fillStyle = C.text2;
  ctx.fillText(`tx ${shortHex(txid)}`, 64 + hw + 24, y);
  ctx.fillStyle = C.text3;
  if (t.proofLine ?? t.note) {
    ctx.font = `500 18px ${MONO}`;
    ctx.fillText(t.proofLine ?? t.note, 64, y + 36);
  }
  if (t.rootLine) {
    ctx.font = `500 16px ${MONO}`;
    ctx.fillText(t.rootLine, 64, y + 62);
  }
  ctx.font = `400 16px ${SANS}`;
  ctx.fillText(t.footer, 64, 590);
  return c;
}

export function poolCardText({ proofs, blocks, seconds, height, digest, matched, network = NETWORK, notLaunched = NOT_LAUNCHED }) {
  const chain = cardNetwork({ network, notLaunched }).poolChain(blocks);
  const base = `My browser verified ${NF.format(proofs)} ${proofs === 1 ? "proof" : "proofs"} across ${NF.format(blocks)} ${chain} in ${NF.format(Math.max(1, Math.round(seconds)))} s.`;
  if (matched) return `${base} Pool state matches at block #${NF.format(height)} (digest ${String(digest).slice(0, 8)}…).`;
  return `${base} Pool state at block #${NF.format(height)} differs from the indexer's (digest ${String(digest).slice(0, 8)}…).`;
}

export async function poolCard(data) {
  await fontsReady();
  const c = canvas();
  const ctx = c.getContext("2d");
  frame(ctx);
  const net = cardNetwork({ network: data.network ?? NETWORK, notLaunched: data.notLaunched ?? NOT_LAUNCHED });
  brandRow(ctx, data.brand ?? "Murkle", net);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.text3;
  ctx.font = `500 18px ${MONO}`;
  ctx.fillText("VERIFY THE POOL · REPLAYED FROM RAW BITCOIN BLOCKS", 64, 180);
  ctx.fillStyle = C.text;
  ctx.font = `400 60px ${SERIF}`;
  ctx.fillText(`${NF.format(data.proofs)} ${data.proofs === 1 ? "proof" : "proofs"} checked`, 64, 262);
  ctx.fillStyle = C.text2;
  ctx.fillText(`across ${NF.format(data.blocks)} Bitcoin ${data.blocks === 1 ? "block" : "blocks"}.`, 64, 332);
  ctx.font = `500 22px ${MONO}`;
  ctx.fillStyle = data.matched ? C.proof : C.danger;
  ctx.fillText(data.matched ? `Pool state matches at #${NF.format(data.height)}` : `Pool state differs at #${NF.format(data.height)}`, 64, 420);
  ctx.fillStyle = C.text3;
  ctx.fillText(`digest ${shortHex(data.digest, 16, 8)} · ${NF.format(Math.max(1, Math.round(data.seconds)))} s in one browser`, 64, 460);
  emblem(ctx, { cx: 980, cy: 315, proof: data.digest ? hexBytes(data.digest) : null, mined: true, verified: data.matched, failed: !data.matched });
  ctx.fillStyle = C.text3;
  ctx.font = `400 16px ${SANS}`;
  ctx.fillText(net.poolFooter, 64, 590);
  return c;
}

function hexBytes(h) {
  const s = String(h);
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function toBlob(c) {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't render the image."))), "image/png"));
}

export async function download(c, filename) {
  const blob = await toBlob(c);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

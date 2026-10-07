/**
 * /_kit: a hidden review page that renders every shared component in every state, in the dark
 * and the light theme side by side (stacked under 1280px). Not linked from the site; it
 * is for checking the design system visually.
 *
 * API (view contract, see router.js)
 *   render(root) -> cleanup
 */
import { html } from "./dom.js";
import { icon, ICON_NAMES, glyphSVG } from "./icons.js";
import * as fmt from "./format.js";
import { prov, upgrade } from "./prov.js";
import { sealPill, sealBlock, sealEmblem, stamp, SEAL_STATES } from "./seal.js";
import { rootChip, rootDetails } from "./rootmatch.js";
import { transcript, TranscriptView } from "./transcript.js";
import { hexmap } from "./hexmap.js";
import { redact, revealed, viewToggle } from "./redact.js";
import { sigil } from "./sigil.js";
import { proofprint } from "./proofprint.js";
import { openSheet } from "./sheet.js";
import { toast } from "./toast.js";
import { qrSVG } from "./qr.js";
import { mountLattice } from "./lattice.js";
import { anonMeter, linkMeter, strengthMeter, LINK_TEXT } from "./meter.js";
import {
  button, iconButton, panel, statTile, statusPill, opBadge, tag, signetChip, progress, empty, skeleton, segmented,
  field, kv, table, faq, payerCard, stepper, disclosure, spinner,
} from "./components.js";
import { themeControl } from "./theme.js";
import { INDEXER_HREF } from "./indexer.js";
import { setTitle } from "../router.js";
import { getWalletStatus, setWalletStatus, getRootStatus, setRootStatus } from "./status.js";

/* ---------- deterministic sample data ---------- */

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) & 0xff;
  };
}

function envelope(op, len, seed) {
  const r = rng(seed);
  const b = new Uint8Array(len);
  b.set([0x6d, 0x72, 0x6b, 0, op]); // "mrk", version 0, op
  for (let i = 5; i < len; i++) b[i] = r();
  return b;
}

function deployEnvelope() {
  const t = new TextEncoder().encode("ABC");
  const parts = [[0x6d, 0x72, 0x6b, 0, 2], [t.length], [...t], [2], [0xe8, 0x03, 0, 0, 0, 0, 0, 0], [0xe8, 0x03, 0, 0], [0xe8, 0x03, 0, 0, 0, 0, 0, 0]];
  const treasury = [0x51, 0x20, ...envelope(0, 32, 7)];
  parts.push([treasury.length], treasury, [0x10, 0x05, 0x04, 0], [0, 0, 0, 0]);
  return Uint8Array.from(parts.flat());
}

const PROOF = Array.from(envelope(1, 128, 99), (b) => b.toString(16).padStart(2, "0")).join("");
const TXID = "9fc2e1d07a5b3c4e8f9012ab34cd56ef7890abcdef1234567890abcdef12a1b3";
const ROOT = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e79f8e";
const ADDR = "mrk1q7x9v2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlhm4yq8sd3k0mfy2w4f9";
const now = Date.now();

const sampleRows = [
  { id: "raw", prov: "BTC", label: "Raw transaction fetched", detail: "mempool.space/signet/api/tx/9fc2…a1b3/hex · 612 vB", status: "ok", ms: 182 },
  { id: "mined", prov: "BTC", label: "Mined", detail: "#263,104 · 3 confirmations", status: "ok", ms: 64 },
  { id: "incl", prov: "BTC", label: "Included in block", detail: "merkle path of 9 hashes rebuilds the header's merkle root", status: "ok", ms: 12 },
  { id: "env", prov: "YOU", label: "Envelope found", detail: "TRANSACT · 471 bytes · anchor #263,050", status: "ok", ms: 1 },
  { id: "bind", prov: "YOU", label: "Binding hash recomputed", detail: "extDataHash 0x1f3a…9c", status: "ok", ms: 1 },
  { id: "points", prov: "YOU", label: "Proof points valid", detail: "canonical, on curve, G2 subgroup, not infinity", status: "ok", ms: 3 },
  { id: "vkey", prov: "YOU", label: "Verification key", detail: "sha256 893e…a557 matches the pinned fingerprint", status: "running" },
  { id: "anchor", prov: "IDX", label: "Anchor root", detail: "#263,050 from /api/roots", status: "pending" },
  { id: "groth", prov: "YOU", label: "Groth16 pairing check", status: "pending" },
  { id: "null", prov: "IDX", label: "Nullifiers unspent before this transaction", status: "pending" },
];
const failRows = [
  { id: "f1", prov: "BTC", label: "Raw transaction fetched", detail: "mempool.space/signet/api/tx/…/hex", status: "ok", ms: 140 },
  { id: "f2", prov: "YOU", label: "Envelope found", detail: "No protocol envelope in this transaction's OP_RETURN outputs.", status: "fail", ms: 2 },
  { id: "f3", prov: "YOU", label: "Binding hash recomputed", status: "skip" },
  { id: "f4", prov: "YOU", label: "Groth16 pairing check", status: "skip" },
];

/* ---------- sections ---------- */

const sec = (title, body) => html`<section class="kit-sec"><h2>${title}</h2>${body}</section>`;
const cell = (label, body) => html`<div class="kit-cell"><span class="kit-label">${label}</span>${body}</div>`;

const SWATCHES = ["bg", "surface-1", "surface-2", "surface-3", "surface-inset", "line", "line-strong", "text", "text-2", "text-3", "btc", "btc-text", "btc-wash", "proof", "proof-text", "proof-wash", "link", "warn", "danger", "redact", "f-header", "f-anchor", "f-public", "f-bind", "f-nullifier", "f-commitment", "f-cipher", "f-proof", "sg-1", "sg-2", "sg-3", "sg-4", "sg-5", "sg-6"];

function column(scope) {
  const seals = SEAL_STATES.map((st) => ({ state: st, height: 263104, confirmations: st === "mined" ? 1 : 3, vsize: 612, ms: 412, reason: "Nullifier already spent" }));
  return html`<div class="kit-col" data-scope="${scope}">
    <div class="split"><div class="eyebrow">${scope} theme</div>${signetChip()}</div>

    ${sec("Tokens", html`<div class="kit-swatches">${SWATCHES.map((s) => html`<div class="kit-swatch"><span style="background:var(--${s})"></span><span>--${s}</span></div>`)}</div>`)}

    ${sec("Type", html`<div class="stack">
      <div class="display">Private tokens on Bitcoin. <em>Proven</em>, not promised.</div>
      <div class="h2-landing">Don't trust. <em>Verify.</em></div>
      <div class="receipt-hero">Proof verified.</div>
      <div class="h1-app">Wallet locked</div><div class="h2-app">Private balances</div><div class="h3">Terms on Bitcoin</div>
      <p class="lead">Send tokens on Bitcoin L1 with the token, the amount and the recipient hidden by zero-knowledge proofs. Launches and mints are public.</p>
      <p class="body">Body 15/24. The proof hides what and how much, and to whom.</p><p class="dense">Dense 14/20.</p><p class="small">Small 13/18.</p><p class="caption">Caption 12/16.</p>
      <div class="eyebrow">Eyebrow · live verifier</div>
      <div><span class="hero-number mono">1,284</span><span class="unit">notes</span></div>
      <div><span class="ticker ticker--card">ABC</span> <span class="ticker ticker--page">ZKTEST</span></div>
    </div>`)}

    ${sec("Format", kv([
      ["int(1284)", fmt.int(1284)],
      ["units(1250025n, 2)", html`<span class="mono">${fmt.units(1250025n, 2)}</span>`],
      ["units big", html`<span class="mono">${fmt.units("123456789012345678901234", 8)}</span>`],
      ["sats(1240)", html`<span class="mono t-btc">${fmt.sats(1240)}</span>`],
      ["height(263104)", fmt.height(263104)],
      ["date / rel", html`${fmt.date(now - 4 * 60000)} · ${fmt.rel(now - 4 * 60000)}`],
      ["relBlocks(3)", fmt.relBlocks(3)],
      ["hash(txid)", fmt.hash(TXID)],
      ["hash link", fmt.hash(TXID, { href: `/tx/${TXID}` })],
      ["chunks", fmt.chunks(ROOT.slice(0, 32))],
      ["addr", fmt.addr(ADDR)],
      ["bytes", `${fmt.bytes(471)} · ${fmt.bytes(12291078)}`],
      ["ms / eta", `${fmt.ms(412)} · ${fmt.ms(1830)} · ${fmt.eta(37)}`],
      ["missing", fmt.int(null)],
    ]))}

    ${sec("Icons", html`<div class="kit-row">${glyphSVG({ size: 32 })}${ICON_NAMES.map((n) => html`<span data-tip="${n}" tabindex="0" style="display:inline-flex;color:var(--text-2)">${icon(n)}</span>`)}</div>`)}

    ${sec("Buttons", html`<div class="stack">
      <div class="kit-row">${button({ label: "Open wallet" })}${button({ label: "Mint · 1,000 sats + fee", kind: "btc", icon: "mint" })}${button({ label: "Secondary", kind: "secondary" })}${button({ label: "Ghost", kind: "ghost" })}${button({ label: "Remove wallet", kind: "danger" })}</div>
      <div class="kit-row">${button({ label: "Small", size: "sm" })}${button({ label: "Small", size: "sm", kind: "secondary" })}${button({ label: "Verify", size: "xs", kind: "ghost" })}${button({ label: "Send privately", kind: "btc", size: "lg" })}</div>
      <div class="kit-row">${button({ label: "Send privately", kind: "btc", disabled: true, reason: "Top up 1,240 sats" })}${button({ label: "x", kind: "neutral", loading: "Proving… 0.8 s" })}</div>
      <div class="kit-row">${iconButton({ icon: "copy", label: "Copy" })}${iconButton({ icon: "qr", label: "Show QR" })}${iconButton({ icon: "external", label: "Open on mempool.space" })}${iconButton({ icon: "refresh", label: "Re-run", size: 32 })} ${spinner(10)} ${spinner(12)} ${spinner(14)}</div>
    </div>`)}

    ${sec("Provenance chips", html`<div class="kit-row">${prov("BTC")}${prov("YOU")}${prov("IDX")}<span class="kit-upgrade">${prov("IDX")}</span><span class="caption t-3">(the last chip upgrades with the demo button)</span></div>`)}

    ${sec("Dual Seal · pill", html`<div class="kit-row">${seals.map((s) => sealPill(s))}</div>`)}
    ${sec("Dual Seal · block", html`<div class="stack">${seals.map((s) => cell(s.state, html`<div style="width:100%">${sealBlock(s)}</div>`))}${cell("deploy verified", html`<div style="width:100%">${sealBlock({ state: "verified", height: 262880, confirmations: 224, deploy: true })}</div>`)}</div>`)}
    ${sec("Dual Seal · emblem", html`<div class="kit-grid">
      ${["mempool", "mined", "accepted", "verified", "rejected", "mismatch", "dropped"].map((st) => cell(st, sealEmblem({ state: st, height: 263104 }, { size: 160, proof: st === "mempool" ? null : PROOF })))}
      ${cell("verified · 200", html`<span class="kit-stamp">${sealEmblem({ state: "verified", height: 263104 }, { size: 200, proof: PROOF })}</span>`)}
    </div>`)}

    ${sec("Root Match", html`<div class="stack">
      <div class="kit-row">${["checking", "match", "indexer", "mismatch"].map((st) => rootChip({ state: st, root: ROOT, height: 263104 }))}${rootChip({ state: "match", root: ROOT }, { compact: true })}</div>
      <div class="panel" style="max-width:360px">${rootDetails({ state: "match", root: ROOT, localRoot: ROOT, height: 263104, commitments: 1284, ms: 412 })}</div>
      <div class="panel" style="max-width:360px">${rootDetails({ state: "mismatch", root: ROOT, localRoot: ROOT.split("").reverse().join(""), height: 263104, commitments: 1284, ms: 398 })}</div>
    </div>`)}

    ${sec("Transcript", html`<div class="stack">
      <div class="kit-transcript">${transcript(sampleRows, { title: "Verification transcript" })}</div>
      ${transcript(failRows, { actions: false })}
    </div>`)}

    ${sec("Envelope anatomy", html`<div class="stack stack--l">
      ${cell("TRANSACT", hexmap(envelope(1, 471, 1), { carrierVsize: 612 }))}
      ${cell("MINT (compact)", hexmap(envelope(3, 507, 2), { carrierVsize: 648, compact: true }))}
      ${cell("DEPLOY", hexmap(deployEnvelope()))}
      ${cell("ATTEST", hexmap(envelope(5, 38, 3).fill(1, 5, 6)))}
    </div>`)}

    ${sec("Redaction", html`<div class="stack">
      <div class="kit-row"><span>Token ${redact("token")}</span><span>Amount ${redact("amount")}</span><span>Sender ${redact("sender")}</span><span>Recipient ${redact("recipient")}</span></div>
      <div class="kit-row">${revealed(html`<span class="mono">250 ABC</span>`, { source: "received" })}${revealed(html`<span class="mono">1,000 ABC</span>`, { source: "sent" })}</div>
      ${viewToggle({ mine: false, name: `kit-view-${scope}` })}
    </div>`)}

    ${sec("Meters", html`<div class="stack stack--l">
      ${anonMeter({ notes: 1284, tokens: 7, prov: "IDX" })}
      ${anonMeter({ notes: 37, tokens: 1, prov: "YOU" })}
      ${anonMeter({ notes: null })}
      ${linkMeter(3, LINK_TEXT.relayer)}${linkMeter(2, LINK_TEXT.builtin)}${linkMeter(1, LINK_TEXT.unisat("tb1q…7k"))}
      <div class="kit-grid">${[0, 1, 2, 3, 4].map((s) => strengthMeter(s, `score ${s}`))}</div>
      ${progress({ value: 412, max: 1000 })}${progress({ value: 1000, max: 1000, size: 8 })}${progress({ value: null, max: null })}
    </div>`)}

    ${sec("Sigils", html`<div class="kit-row">${["1", "2", "3", "42", "777", "9001", "123456789"].map((s) => sigil(s, { size: 40, label: `asset ${s}` }))}${sigil("77", { size: 20 })}${sigil("77", { size: 32 })}${sigil("77", { size: 56 })}${sigil("77", { size: 96 })}</div>`)}

    ${sec("Proofprint", html`<div class="kit-row">${proofprint(PROOF, { size: 24, half: true })}${proofprint(PROOF, { size: 24, half: true, mined: true, verified: true })}${proofprint(PROOF, { size: 112 })}${proofprint(PROOF, { size: 112, mined: true })}${proofprint(PROOF, { size: 112, mined: true, verified: true })}${proofprint(TXID, { size: 200, mined: true, verified: true })}</div>`)}

    ${sec("Pills, badges, tags", html`<div class="stack">
      <div class="kit-row">${statusPill("open")}${statusPill("upcoming", "Opens in 37 blocks")}${statusPill("soldout")}${statusPill("ended")}</div>
      <div class="kit-row">${opBadge("DEPLOY")}${opBadge("MINT")}${opBadge("TRANSACT")}${opBadge("ATTEST")}</div>
      <div class="kit-row">${tag("Done", "proof")}${tag("Signet only", "warn")}${tag("Before mainnet", "neutral")}${tag("By design", "neutral", { hatched: true })}${tag("Single-party setup", "danger")}${tag("Fixed", "proof", { solid: true })}${signetChip()}</div>
    </div>`)}

    ${sec("Panels and stats", html`<div class="stack">
      ${panel({ eyebrow: "Live verifier", title: "Panel title", actions: button({ label: "Action", size: "sm", kind: "secondary" }), body: html`<p class="t-2">Plain panel body.</p>` })}
      ${panel({ eyebrow: "Terms on Bitcoin", title: "Certified panel", certified: true, body: html`<p class="t-2">Receipts, seals, verifier and lock screen use the certified frame.</p>` })}
      <div class="grid-stats">
        ${statTile({ eyebrow: "Bitcoin height", value: "263,104", prov: "BTC" })}
        ${statTile({ eyebrow: "Notes", value: "1,284", unit: "in the pool", prov: "YOU", foot: "Rebuilt in your browser" })}
        ${statTile({ eyebrow: "Spent nullifiers", value: null, prov: "IDX" })}
      </div>
    </div>`)}

    ${sec("Forms", html`<div class="stack" style="max-width:var(--max-form)">
      ${field({ label: "Recipient", name: "to", mono: true, placeholder: "mrk1…", chips: [{ label: "Paste", action: "paste" }], valid: "Valid shielded address" })}
      ${field({ label: "Amount", name: "amount", mono: true, value: "250", suffix: "ABC", chips: [{ label: "Max", action: "max" }], help: "Available 1,250.00 ABC" })}
      ${field({ label: "Password", name: "pw", type: "password", error: "At least 8 characters." })}
      ${field({ label: "Recovery phrase", name: "phrase", textarea: true, rows: 3, help: "24 words, separated by spaces." })}
      ${segmented([{ value: "all", label: "All" }, { value: "open", label: "Open" }, { value: "soon", label: "Upcoming" }, { value: "out", label: "Minted out" }], { value: "open", name: `kit-seg-${scope}`, label: "Filter" })}
      ${themeControl()}
    </div>`)}

    ${sec("Table", table({
      caption: "Operations",
      columns: [{ key: "block", label: "Block" }, { key: "op", label: "Op" }, { key: "tx", label: "Tx" }, { key: "data", label: "Public data" }, { key: "seal", label: "Seal", align: "right" }],
      rows: [
        { block: fmt.height(263104), op: opBadge("TRANSACT"), tx: fmt.hash(TXID, { head: 4, tail: 4 }), data: html`${redact("token")} ${redact("amount")} ${redact("recipient")}`, seal: sealPill({ state: "verified", height: 263104 }) },
        { block: fmt.height(263101), op: opBadge("MINT"), tx: fmt.hash(TXID.split("").reverse().join(""), { head: 4, tail: 4 }), data: html`<span class="mono">+1,000 ABC →</span> ${redact("recipient")}`, seal: sealPill({ state: "accepted", height: 263101 }) },
        { block: fmt.height(263099), op: opBadge("DEPLOY"), tx: fmt.hash(ROOT, { head: 4, tail: 4 }), data: "ABC · 1,000 × 1,000 · 1,000 sats", seal: sealPill({ state: "rejected", height: 263099 }) },
      ],
    }))}

    ${sec("Empty states and skeletons", html`<div class="stack">
      ${empty({ text: "No open mints right now. Be first: write a token to Bitcoin.", action: { label: "Launch a token", href: "/app/launch" } })}
      ${skeleton({ lines: 3, height: "14px" })}
    </div>`)}

    ${sec("FAQ", faq([
      { q: "Does Bitcoin itself verify the proofs?", a: "No. Bitcoin stores and orders them. Verification is deterministic: any indexer or browser that applies the same rules to the same blocks gets the same result." },
      { q: "What is still visible?", a: "That a protocol transaction happened, when, its size, its fee and the address that paid the fee." },
    ]))}

    ${sec("Fee payer cards", html`<div class="stack">
      ${payerCard({ value: "relay", name: `payer-${scope}`, title: "Relay from my balance", status: "Balance 6,055 sats", fee: "~657 sats from your relay balance", link: { level: 3, text: LINK_TEXT.relayer }, checked: true })}
      ${payerCard({ value: "local", name: `payer-${scope}`, title: "Built-in key", status: "Balance 24,500 sats", fee: "~1,240 sats (6 sat/vB)", link: { level: 2, text: LINK_TEXT.builtin } })}
      ${payerCard({ value: "unisat", name: `payer-${scope}`, title: "Unisat", status: "Connect", link: { level: 1, text: LINK_TEXT.unisat("tb1q…7k") }, warning: "Unisat's signet node rejects the large OP_RETURN (old relay policy). On signet, pay with the built-in key, or copy the envelope." })}
      ${payerCard({ value: "relay-mint", name: `payer2-${scope}`, title: "Relayer", disabled: true, reason: "Mints are paid from your Bitcoin address" })}
    </div>`)}

    ${sec("Proving stepper", stepper([
      { label: "Load proving key", detail: "cached · 12.3 MB", status: "ok", ms: 40 },
      { label: "Sync pool and match root", status: "ok", ms: 412, prov: "IDX" },
      { label: "Select notes", status: "ok", ms: 3 },
      { label: "Build witness", status: "ok", ms: 180 },
      { label: "Prove (Groth16, 18,411 constraints)", status: "running", ms: 800 },
      { label: "Self-verify proof locally", status: "pending", prov: "YOU" },
      { label: "Handing to relayer", status: "pending" },
      { label: "Broadcast, then in mempool", status: "pending", prov: "BTC" },
    ]))}

    ${sec("Disclosure preview", html`<div class="stack">
      ${disclosure({ op: "Send", publicRows: [["Operation", "private transfer"], ["Envelope", "471 bytes"], ["Bitcoin fee", html`<span class="mono t-btc">~1,240 sats</span>`], ["Paid by", "Relayer, shared address"]], hidden: ["Token", "Amount", "Recipient", "Which notes you spent"] })}
      ${disclosure({ op: "Launch", publicRows: [["Ticker", "ABC"], ["Terms", "1,000 × 1,000"], ["Treasury", "tb1p…9x"]], hidden: [], note: "A launch is public by design: everyone must be able to check the terms." })}
    </div>`)}

    ${sec("QR", html`<div class="kit-row">${qrSVG(ADDR, { label: "Shielded address", size: 160 })}${qrSVG(`https://murkle.example/pay#to=${ADDR}&t=ABC&a=250`, { label: "Payment link", size: 160 })}</div>`)}

    ${sec("Merkle lattice", html`<div class="kit-lattice" data-kit-lattice></div>`)}
  </div>`;
}

export function render(root) {
  setTitle("Component kit");
  root.innerHTML = html`
    <div class="container kit-head stack">
      <div class="eyebrow">Internal · not linked</div>
      <h1 class="h1-app">Component kit</h1>
      <p class="t-2">Every shared component in every state, dark and light side by side. Global overlays (tooltips, toasts, sheets) follow the page theme.</p>
      <div class="cluster">
        ${button({ label: "Info toast", kind: "secondary", size: "sm", action: "kit-toast-info" })}
        ${button({ label: "Success toast", kind: "secondary", size: "sm", action: "kit-toast-success" })}
        ${button({ label: "Warn toast", kind: "secondary", size: "sm", action: "kit-toast-warn" })}
        ${button({ label: "Danger toast", kind: "secondary", size: "sm", action: "kit-toast-danger" })}
        ${button({ label: "Open sheet", kind: "secondary", size: "sm", action: "kit-sheet" })}
        ${button({ label: "Open locked sheet", kind: "secondary", size: "sm", action: "kit-sheet-locked" })}
        ${button({ label: "Stamp seal", kind: "secondary", size: "sm", action: "kit-stamp" })}
        ${button({ label: "Upgrade chip", kind: "secondary", size: "sm", action: "kit-upgrade" })}
        ${button({ label: "Run transcript", kind: "secondary", size: "sm", action: "kit-transcript" })}
        ${button({ label: "Grow lattice", kind: "secondary", size: "sm", action: "kit-lattice" })}
        ${button({ label: "Cycle wallet state", kind: "secondary", size: "sm", action: "kit-wallet" })}
        ${button({ label: "Cycle root state", kind: "secondary", size: "sm", action: "kit-root" })}
      </div>
    </div>
    <div class="kit-cols">${column("dark")}${column("light")}</div>`;

  const lattices = [...root.querySelectorAll("[data-kit-lattice]")].map((el) => mountLattice(el));
  let total = 41;
  lattices.forEach((l) => l.update(total));

  const onClick = (e) => {
    const a = e.target.closest("[data-action]");
    if (!a) return;
    switch (a.dataset.action) {
      case "kit-toast-info":
        return toast({ kind: "info", title: "Synced to #263,104.", body: "Your notes are up to date." });
      case "kit-toast-success":
        return toast({ kind: "success", title: "Proof verified in this browser.", body: "Groth16 pairing check passed in 9 ms.", action: { label: "View receipt", href: `/tx/${TXID}` } });
      case "kit-toast-warn":
        return toast({ kind: "warn", title: "Few relayed transfers right now.", body: "Timing can still link you. Wait a few blocks for more cover." });
      case "kit-toast-danger":
        return toast({ kind: "danger", title: "Root mismatch.", body: "The tree rebuilt in your browser differs from the indexer's. Sync again, or switch indexer.", action: { label: "Switch indexer", href: INDEXER_HREF } });
      case "kit-sheet":
        return openSheet({ eyebrow: "Root match", title: "Sheet title", body: rootDetails({ state: "match", root: ROOT, localRoot: ROOT, height: 263104, commitments: 1284, ms: 412 }), actions: html`${button({ label: "Close", kind: "secondary", attrs: { "data-sheet-close": true } })}${button({ label: "Continue" })}` });
      case "kit-sheet-locked": {
        const s = openSheet({ title: "Proving…", body: html`<p class="t-2">Locked sheets ignore Esc and scrim clicks. It unlocks after 3 s.</p>`, locked: true });
        setTimeout(() => s.setLocked(false), 3000);
        return;
      }
      case "kit-stamp":
        return root.querySelectorAll(".kit-stamp .seal-emblem").forEach((el) => stamp(el));
      case "kit-upgrade":
        return root.querySelectorAll(".kit-upgrade .prov").forEach((el) => upgrade(el, el.dataset.prov === "IDX" ? "YOU" : "IDX"));
      case "kit-transcript":
        return root.querySelectorAll(".kit-transcript .transcript").forEach((el) => {
          const v = new TranscriptView(el);
          v.set(sampleRows.map((r, i) => ({ ...r, status: i === 0 ? "running" : "pending", ms: null })));
          const t0 = performance.now();
          sampleRows.forEach((r, i) => {
            setTimeout(() => {
              if (r.id === "anchor") v.update(r.id, { status: "ok", prov: "IDX", detail: "rebuilt from 1,180 commitments · matches indexer", ms: performance.now() - t0 });
              else v.update(r.id, { status: "ok", ms: Math.round(performance.now() - t0) });
              const next = sampleRows[i + 1];
              if (next) v.update(next.id, { status: "running" });
            }, 120 * (i + 1));
          });
        });
      case "kit-lattice":
        total += 3;
        return lattices.forEach((l) => l.update(total));
      case "kit-wallet": {
        // Simulates the wallet's status updates so the header, rail and tab bar can be reviewed.
        const order = ["none", "locked", "unlocked"];
        const next = order[(order.indexOf(getWalletStatus().state) + 1) % order.length];
        setWalletStatus({ state: next, address: next === "unlocked" ? ADDR : null, lock: next === "unlocked" ? () => setWalletStatus({ state: "locked", address: null, lock: null }) : null });
        return toast({ kind: "info", title: `Wallet state: ${next}`, body: "Simulated for review; nothing was stored." });
      }
      case "kit-root": {
        const order = ["checking", "indexer", "match", "mismatch"];
        const cur = getRootStatus();
        const next = order[(order.indexOf(cur.state) + 1) % order.length];
        setRootStatus({ ...cur, state: next, localRoot: next === "match" ? cur.root : next === "mismatch" ? ROOT : null, commitments: 1284, ms: 412 });
        return toast({ kind: "info", title: `Root state: ${next}`, body: "Simulated for review." });
      }
    }
  };
  root.addEventListener("click", onClick);
  return () => {
    root.removeEventListener("click", onClick);
    lattices.forEach((l) => l.destroy());
  };
}


/**
 * / Landing (visual.md section 10).
 *
 * The page's one promise is that it can show, not tell: the Live Verifier re-checks a real
 * Bitcoin transaction in front of the visitor, the Proof Wall re-checks the latest envelopes one
 * by one, and the Crowd Meter shows the real (small, early) pool with the honest "Early pool"
 * tag. Every live number carries a provenance chip; nothing counts up to a placeholder; missing
 * values render as "—".
 *
 * Copy rules (visual.md section 2): Bitcoin stores and orders the data, it never "verifies the
 * proofs"; "verified" and solid green only for checks this browser ran.
 */
import "../share/public.css";
import * as api from "../api.js";
import facts from "../facts.json";
import { html, on, reducedMotion } from "../ui/dom.js";
import { icon, glyphSVG } from "../ui/icons.js";
import { prov, provTip, upgrade, REBUILD_TIP } from "../ui/prov.js";
import { int, units, sats, short, hash, heightText, height as heightHTML, relBlocks, ms as fmtMs, DASH } from "../ui/format.js";
import { button, segmented, tag, faq, empty } from "../ui/components.js";
import { sealEmblem, stamp } from "../ui/seal.js";
import { proofprint } from "../ui/proofprint.js";
import { hexmap } from "../ui/hexmap.js";
import { redact } from "../ui/redact.js";
import { transcript, TranscriptView } from "../ui/transcript.js";
import { mountLattice } from "../ui/lattice.js";
import { anonMeter } from "../ui/meter.js";
import { rootChip, rootSentence } from "../ui/rootmatch.js";
import { getRootStatus, onRootStatus, getWalletStatus, onWalletStatus } from "../ui/status.js";
import { toast } from "../ui/toast.js";
import { navigate, setTitle } from "../router.js";
import { BRAND, PRE_GENESIS, ARTIFACT_SHA256, MANIFEST_SHA256, GENESIS_TXID, IS_SIGNET, NOT_LAUNCHED, MAINNET_NOT_LAUNCHED_TEXT } from "../config.js";

// Where this site runs, in the hero's status line. Mainnet never says "live" before or after launch:
// it says it has not launched, then names the network.
const LIVE_TEXT = IS_SIGNET ? "Live on Bitcoin signet" : NOT_LAUNCHED ? "Bitcoin mainnet · Not launched" : "On Bitcoin mainnet";
import { launchCard, boardGroups } from "../share/launch.js";
import { crowdChart } from "../share/charts.js";
import { logTail } from "../share/feed.js";
import { wallEntries, verifierCandidates, pickDefault, candidateLabel, wallVerdict, wallSummary } from "../share/wall.js";

// The verifier stack (snarkjs, Poseidon, the proof codec) loads only when something is checked.
const live = () => import("../share/live-check.js");
const TXID = /^[0-9a-f]{64}$/;
const isPhone = () => typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;
const OP_WORD = { TRANSFER: "TRANSACT", MINT: "MINT", MINT_SCRIPT: "MINT_SCRIPT", DEPLOY: "DEPLOY" };
const MILESTONES = [1000, 10000];
const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/* ---------- static copy (visual.md section 10) ---------- */

const STEPS = [
  ["launch", "Launch", "Write a token's terms to Bitcoin: ticker, supply, mint price, schedule. One transaction. No premine. Terms can't change."],
  ["mint", "Mint", "Anyone mints by paying sats to the treasury in the same transaction. The tokens arrive as a private note only you can open. Each mint is bound to your own coins, so copies from the mempool get nothing."],
  ["send", "Send", "Your browser builds a zero-knowledge proof in about a second. Bitcoin carries a 471-byte envelope; the token, amount and recipient stay hidden."],
  ["proof", "Verify", "Any indexer replays the chain and gets the same pool root. Your wallet checks it, and anyone can re-verify any proof from raw Bitcoin data."],
];

const TILES = [
  ["seal", "Proof receipts", "Every transaction gets a page anyone can re-verify. Share it as an image."],
  ["link", "Private payment links", "Request tokens with a link. The details live after the #, so they never reach our server."],
  ["launch", "Launch kit", "A token page with live supply, a share link and an announcement card for X, drawn in your browser."],
  ["relayer", "Copy, pay or relay", "Pay the fee from the built-in key, copy the envelope for anyone to carry, or top up a relay balance and let a relayer carry it, charged to that balance."],
  ["lock", "Password lock", "Your recovery phrase is encrypted on this device and locks itself when idle."],
  ["root", "Pool audit", "Replay every private transaction from Bitcoin in your browser and match the pool root."],
];

const FAQ = [
  ["Is this a bridge or a sidechain?", "Neither. It's a metaprotocol, like Runes: the data lives in ordinary Bitcoin transactions and the state comes from replaying blocks. Tokens are born inside the protocol; no BTC is locked anywhere."],
  ["Does Bitcoin itself verify the proofs?", "No. Bitcoin stores and orders them. Verification is deterministic: any indexer or browser that applies the same rules to the same blocks gets the same result. This site lets you run those checks yourself."],
  ["What is still visible?", "That a protocol transaction happened, when, its size, its fee and the address that paid the fee. For mints and launches, the token and amount are public too. For private transfers, the token, the amount and the recipient are hidden. Whether anyone can tell who sent one depends on who pays its fee and how many others use the pool."],
  ["What can your server see?", "That you downloaded the public pool data, which every wallet downloads in full. Not your balance, and not which notes are yours. If you relay from a relay balance, the relayer also sees your IP address, the envelope it broadcasts, and the address you topped up from."],
  ...(IS_SIGNET
    ? [["What is still trusted on signet?", "A single-party development setup for the proving keys, and block data from a public API instead of our own Bitcoin node. Both are replaced before mainnet."]]
    : [["What is still trusted on mainnet?", "The phase-2 setup is sound if at least one participant of the public ceremony discarded their secret. Block headers are checked from a pinned checkpoint, but a data source can still hide or delay blocks; your own node removes it. There is no external audit yet."]]),
  ["What if I lose my phrase or password?", "Your 24 words are the only backup. The password only unlocks this browser; with the words you can restore anywhere. Nobody, including us, can recover your notes."],
  IS_SIGNET
    ? ["When mainnet?", "After a multi-party setup ceremony, an external audit and our own Bitcoin node. Until then, test coins only."]
    : ["Is mainnet launched?", NOT_LAUNCHED ? MAINNET_NOT_LAUNCHED_TEXT : "A genesis is pinned, so the pool runs on Bitcoin mainnet. It is experimental software: tokens can be lost to bugs."],
];

const SEES = {
  normal: {
    label: "A normal token transfer",
    rows: [["Token", "SAMPLE•TOKEN"], ["Amount", "50,000"], ["From", "tb1q…8f2k"], ["To", "tb1q…r7m0"], ["Proof", "none"]],
  },
  public: {
    label: "A private transfer, as everyone sees it",
    rows: [["Token", "R:token"], ["Amount", "R:amount"], ["From (shielded address)", "R:sender"], ["To", "R:recipient"], ["Proof", "128 bytes · valid"]],
  },
  mine: {
    label: "The same transfer, as you see it",
    rows: [["Token", "ABC"], ["Amount", "250"], ["From", "you"], ["To", "mrk1q…w4f9"], ["Proof", "128 bytes · valid"]],
  },
};

function statusBoard() {
  const c = facts.circuit ?? {};
  const a = facts.audit ?? {};
  const v = (x) => (x === null || x === undefined ? DASH : int(x));
  const medium = a.bySeverity?.Medium ?? null;
  const chip = { DONE: tag("DONE", "proof"), SIGNET: tag("SIGNET ONLY", "warn"), MAINNET: tag("BEFORE MAINNET", "danger"), DESIGN: tag("BY DESIGN", "neutral") };
  const rows = [
    [`Circuit: ${v(c.constraints)} constraints, ${c.proofSystem ?? "Groth16"} on ${c.curve ?? "BN254"}, ${c.inputs ?? 2}-in/${c.outputs ?? 2}-out, depth-${c.treeDepth ?? 32} ${c.hash ?? "Poseidon"} tree`, "DONE"],
    ["Formal under-constraint check (Picus + cvc5): no under-constrained signals except harmless IsZero helper inverses, explained in the report", "DONE"],
    [`Static analysis (circomspect): ${v(a.circomspectFindings)} notes, 0 real issues`, "DONE"],
    [`Internal review: ${v(a.total)} findings, ${v(medium)} medium, ${a.mediumFixed != null && a.mediumFixed === medium ? "all fixed with regression tests" : `${v(a.mediumFixed)} fixed`}`, "DONE"],
    [`${v(facts.testCount)} automated tests`, "DONE"],
    ...(IS_SIGNET
      ? [["Trusted setup: single-party development setup", "SIGNET"], ["MPC setup ceremony", "MAINNET"], ["Block headers from a public API", "SIGNET"]]
      : [
        ["MPC setup ceremony (public phase 2)", NOT_LAUNCHED ? "MAINNET" : "DONE"],
        ["Block headers checked from a pinned checkpoint; a data source can still hide blocks", "DESIGN"],
      ]),
    ["Note encryption isn't proven in the circuit; a bad sender can only hurt their own payment's recipient", "DESIGN"],
    ["External audit", "MAINNET"],
  ];
  return html`<ul class="ld-board-list">${rows.map(([text, k]) => html`<li class="ld-board-row"><span>${chip[k]}</span><span>${text}</span></li>`)}</ul>`;
}

function factsRow() {
  const c = facts.circuit ?? {};
  const vkey = ARTIFACT_SHA256?.vkey ?? facts.artifacts?.vkey?.sha256 ?? null;
  const manifest = MANIFEST_SHA256 ?? facts.manifest?.sha256 ?? null;
  const fact = (label, value) => html`<div class="ld-fact"><span class="eyebrow">${label}</span><span class="ld-fact-v">${value}</span></div>`;
  return html`<div class="ld-facts">
    ${fact("Verifier key sha256", vkey ? hash(vkey, { head: 8, tail: 6, label: "Copy verifier key hash" }) : DASH)}
    ${fact("Circuit manifest sha256", manifest ? hash(manifest, { head: 8, tail: 6, label: "Copy manifest hash" }) : DASH)}
    ${fact("Circuit", html`${c.constraints != null ? int(c.constraints) : DASH} constraints · ${c.proofSystem ?? "Groth16"}/${c.curve ?? "BN254"}`)}
    ${fact("Anchored on Bitcoin", GENESIS_TXID && !PRE_GENESIS ? hash(GENESIS_TXID, { head: 8, tail: 6, href: `/tx/${GENESIS_TXID}`, label: "Copy genesis txid" }) : html`<span class="t-warn">Not yet (pre-genesis)</span>`)}
  </div>`;
}

/* ---------- the page ---------- */

export function render(root) {
  setTitle(null);
  root.innerHTML = html`<div class="ld">
    <section class="ld-hero" aria-labelledby="ld-h1">
      <div class="ld-hero-lattice" aria-hidden="true"></div>
      <div class="container ld-hero-in">
        <div class="ld-copy">
          <div class="cluster">
            <span class="ld-live" data-live><span class="ld-live-dot" aria-hidden="true"></span><span data-live-text>${LIVE_TEXT}</span></span>
            ${PRE_GENESIS ? html`<span class="tag tag--warn" data-tip="No genesis attestation is pinned yet. A re-genesis will reset this pool.">PRE-GENESIS</span>` : ""}
          </div>
          <h1 class="display ld-h1" id="ld-h1">Private tokens on Bitcoin. <span class="ld-h1-2">Proven, <em>not promised</em>.</span></h1>
          <p class="lead">Launch and mint tokens on Bitcoin L1 in public, then send them with the token, the amount and the recipient hidden by zero-knowledge proofs. Every proof is written into a Bitcoin transaction, so anyone can check it. This page does, in your browser, from raw Bitcoin data.</p>
          <div class="ld-ctas">
            ${button({ label: "Open wallet", href: "/app", kind: "neutral", size: "lg" })}
            ${button({ label: "Verify a live proof", kind: "secondary", size: "lg", icon: "proof", action: "ld-goverify" })}
          </div>
          <a class="ld-sec-link" href="/security#status" data-link>Read the security status →</a>
          <p class="ld-micro"><span>${icon("check", { size: 14 })}No sign-up</span><span>${icon("lock", { size: 14 })}Keys never leave your device</span><span>${icon("warn", { size: 14 })}Test coins only</span></p>
        </div>
        ${verifierShell()}
      </div>
    </section>

    <div class="ld-strip" aria-label="Live pool numbers"><div class="container ld-strip-in" data-strip>${stripMarkup()}</div></div>

    <section class="ld-sec" aria-labelledby="ld-sees-h">
      <div class="container ld-sees">
        <div class="ld-sec-head">
          <div class="eyebrow">WHAT BITCOIN SEES</div>
          <h2 class="h2-landing" id="ld-sees-h">One transaction. <em>Two views.</em></h2>
          <p class="lead">Both are ordinary Bitcoin transactions. Only one tells the world your bag.</p>
          <p class="small t-3">The token is hidden too: every token shares one pool, so a transfer of one looks exactly like a transfer of any other.</p>
        </div>
        <div>
          ${segmented(
            [
              { value: "normal", label: "Normal" },
              { value: "public", label: "Private · everyone" },
              { value: "mine", label: "Private · you" },
            ],
            { value: "public", name: "ld-sees", label: "Choose a view" },
          )}
          <div class="panel ld-sees-card" style="margin-top:12px" data-sees>${seesCard("public")}</div>
        </div>
      </div>
    </section>

    <section class="ld-sec" aria-labelledby="ld-steps-h">
      <div class="container">
        <div class="ld-sec-head">
          <div class="eyebrow">HOW IT WORKS</div>
          <h2 class="h2-landing" id="ld-steps-h">Four steps, <em>all on Bitcoin.</em></h2>
        </div>
        <ol class="ld-steps">${STEPS.map(([ic, title, text], i) => html`<li class="ld-step"><span class="ld-step-n">${String(i + 1).padStart(2, "0")}</span><h3>${icon(ic, { size: 18 })}${title}</h3><p>${text}</p></li>`)}</ol>
      </div>
    </section>

    <section class="ld-sec" aria-labelledby="ld-crowd-h" id="crowd">
      <div class="container ld-crowd">
        <div class="ld-sec-head" style="margin-bottom:0">
          <div class="eyebrow">CROWD METER</div>
          <h2 class="h2-landing" id="ld-crowd-h">One pool. <em>Every token.</em></h2>
          <div class="ld-crowd-big" data-crowd-big>${crowdBig(null, null)}</div>
          <p class="lead">A transfer of any token looks exactly like a transfer of every other token. Every new launch makes the crowd bigger for all of them.</p>
          <p class="ld-caveat">${icon("warn", { size: 14 })}<span>Timing and fee payers can still leak. Fund the fee key apart from your main wallet.</span></p>
        </div>
        <div class="panel ld-crowd-panel" data-crowd-panel>${crowdPanel(null, null)}</div>
      </div>
    </section>

    <section class="ld-sec" aria-labelledby="ld-wall-h" id="wall">
      <div class="container">
        <div class="ld-sec-head ld-sec-head--row">
          <div>
            <div class="eyebrow">PROOF WALL</div>
            <h2 class="h2-landing" id="ld-wall-h">The latest proofs, <em>re-checked here.</em></h2>
            <p class="lead">The last 12 envelopes written to Bitcoin. Your browser fetches each raw transaction from mempool.space and re-verifies it, one by one, with real timings.</p>
          </div>
        </div>
        <div class="wall-bar">
          <span class="wall-sum" data-wall-sum aria-live="polite">Loading the public log…</span>
          <span class="cluster" data-wall-actions></span>
        </div>
        <ol class="wall-grid" data-wall-grid>${Array.from({ length: 6 }, () => html`<li class="wall-item"><span class="wall-print"></span><span class="skel" style="width:70%;height:12px"></span><span class="skel" style="width:50%;height:12px"></span></li>`)}</ol>
        <p class="wall-note">${icon("eye", { size: 14 })}<span>Raw data comes from mempool.space, not from us; each byte is re-hashed to its txid and block header here. Rejected envelopes show the indexer's reason next to what your browser found. Each tile opens its full receipt.</span></p>
      </div>
    </section>

    <section class="ld-sec ld-board" aria-labelledby="ld-board-h" id="launches">
      <div class="container">
        <div class="ld-sec-head">
          <div class="eyebrow">LAUNCHPAD</div>
          <h2 class="h2-landing" id="ld-board-h">Fair launches. <em>Private holders.</em></h2>
          <p class="lead">Runes-style open mints, with one difference: nobody can read the holder list, because there isn't one.</p>
        </div>
        <ul class="ld-bullets">${[
          "Open mint, paid in sats. No premine.",
          "The treasury is paid in the same Bitcoin transaction.",
          "Supply is public and checkable. Holders are not.",
          "Mints are bound to the minter's coins, so mempool copycats get nothing.",
          "No whale alerts. No copy-trading your buyers.",
        ].map((t) => html`<li>${icon("check", { size: 16 })}<span>${t}</span></li>`)}</ul>
        <div class="ld-board-bar">
          ${segmented(
            [
              { value: "live", label: "Live" },
              { value: "upcoming", label: "Upcoming" },
              { value: "soldout", label: "Minted out" },
            ],
            { value: "live", name: "ld-board", label: "Which launches" },
          )}
          <span class="cluster">${button({ label: "Browse mints", href: "/mints", kind: "secondary", size: "sm" })}${button({ label: "Launch a token", href: "/app/launch", kind: "ghost", size: "sm", icon: "launch" })}</span>
        </div>
        <div class="lp-grid" data-board>${Array.from({ length: 3 }, () => html`<div class="panel lp-card"><span class="skel" style="width:60%;height:24px"></span><span class="skel" style="width:100%;height:4px"></span><span class="skel" style="width:80%;height:40px"></span></div>`)}</div>
      </div>
    </section>

    <section class="ld-sec" aria-labelledby="ld-trust-h" id="trust">
      <div class="container">
        <div class="ld-sec-head">
          <div class="eyebrow">TRUST MODEL</div>
          <h2 class="h2-landing" id="ld-trust-h">Don't trust. <em>Verify.</em></h2>
          <p class="lead">Every number on this site carries a chip that names what you still trust for it: ${prov("BTC")} Bitcoin data from mempool.space, ${prov("YOU")} only your browser's math, ${prov("IDX")} our indexer's claim.</p>
        </div>
        <div class="ld-trust">
          <div class="panel ld-trust-col ld-trust--btc"><h3>${icon("block", { size: 18 })}Bitcoin guarantees</h3><ul>${["The envelope bytes are in a block.", "Their order and time.", "The mint payment is in the same transaction."].map((t) => html`<li>${icon("check", { size: 14 })}<span>${t}</span></li>`)}</ul></div>
          <div class="panel ld-trust-col ld-trust--you"><h3>${icon("proof", { size: 18 })}Your browser checks</h3><ul>${["The Groth16 proof against the published key.", "The hash binding the proof to these exact bytes.", "Valid curve and subgroup points.", "The pool root, rebuilt from every commitment.", "Which notes are yours, by local trial decryption. The server never learns."].map((t) => html`<li>${icon("check", { size: 14 })}<span>${t}</span></li>`)}</ul></div>
          <div class="panel ld-trust-col ld-trust--still"><h3>${icon("warn", { size: 18 })}Still trusted on ${IS_SIGNET ? "signet" : "mainnet"}</h3><ul>${[...(IS_SIGNET ? ["Proving keys from a single-party development setup.", "Block data from a public API, not yet our own Bitcoin node."] : ["Proving keys from the public ceremony: sound if one participant discarded their secret.", "A data source can hide or delay blocks; headers are checked from a pinned checkpoint."]), "Our transaction list: Verify the Pool catches a wrong state (Root Match only shows the list agrees with its own root), not a hidden transaction. Run your own indexer to close that gap."].map((t) => html`<li>${icon("info", { size: 14 })}<span>${t}</span></li>`)}</ul></div>
        </div>
        ${IS_SIGNET ? html`<p class="ld-mainnet">${tag("BEFORE MAINNET", "danger")}<span>Multi-party setup ceremony, external audit, our own Bitcoin node.</span></p>` : html`<p class="ld-mainnet">${tag(NOT_LAUNCHED ? "NOT LAUNCHED" : "EXPERIMENTAL", "danger")}<span>${NOT_LAUNCHED ? MAINNET_NOT_LAUNCHED_TEXT : "No external audit yet. Tokens can be lost to bugs."}</span></p>`}
        <div class="ld-tools">
          <div class="panel ld-tool">
            <div class="eyebrow">ROOT MATCH</div>
            <h3>Your browser rebuilds the note tree and checks the root</h3>
            <div data-root-tool>${rootTool()}</div>
          </div>
          <div class="panel ld-tool">
            <div class="eyebrow">PROOF RECEIPT</div>
            <h3>Re-verify any proof from raw Bitcoin data</h3>
            <p>Paste a txid. The receipt page fetches it from mempool.space and runs every check here.</p>
            <form class="lv-any" data-any="tool" novalidate><input class="input mono" name="txid" placeholder="64-character txid" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Transaction id">${button({ label: "Verify", kind: "secondary", type: "submit" })}</form>
            <p class="caption t-3" data-any-msg="tool" hidden></p>
          </div>
          <div class="panel ld-tool">
            <div class="eyebrow">YOUR OWN INDEXER</div>
            <h3>Run your own indexer</h3>
            <p>In a copy of the source, download the pinned keys from this site (the fetch checks each one against the pins in the source), build the site, then start the indexer. It won't start with a different verification key.</p>
            <pre>npm ci
npm run artifacts:fetch -- --from ${typeof location !== "undefined" ? location.origin : "https://<this-site>"}/artifacts
npm run web:build
npm run indexer</pre>
            <p>Then <a href="/verify#indexer" data-link>switch this site to it</a>; no wallet needed. <a href="/verify#run" data-link>Full instructions →</a></p>
          </div>
        </div>
      </div>
    </section>

    <section class="ld-sec" aria-labelledby="ld-sec-h" id="status">
      <div class="container">
        <div class="ld-sec-head ld-sec-head--row">
          <div>
            <div class="eyebrow">SECURITY STATUS</div>
            <h2 class="h2-landing" id="ld-sec-h">What is done. <em>What isn't.</em></h2>
          </div>
          ${button({ label: "Read the full report", href: "/security", kind: "secondary", iconRight: "arrow-right" })}
        </div>
        ${statusBoard()}
        <p class="caption t-3" style="margin-top:12px">Internal review, not an independent audit yet. Every value above is read from this build's repository at build time.</p>
        ${factsRow()}
      </div>
    </section>

    <section class="ld-sec" aria-labelledby="ld-tiles-h">
      <div class="container">
        <div class="ld-sec-head">
          <div class="eyebrow">FEATURES</div>
          <h2 class="h2-landing" id="ld-tiles-h">Built for launches. <em>Designed for privacy.</em></h2>
        </div>
        <div class="ld-tiles">${TILES.map(([ic, title, text]) => html`<div class="panel ld-tile"><span class="ld-tile-ic">${icon(ic)}</span><h3>${title}</h3><p>${text}</p></div>`)}</div>
      </div>
    </section>

    <section class="ld-sec" aria-labelledby="ld-faq-h">
      <div class="container ld-faq">
        <div class="ld-sec-head"><div class="eyebrow">FAQ</div><h2 class="h2-landing" id="ld-faq-h">Straight answers.</h2></div>
        ${faq(FAQ.map(([q, a]) => ({ q, a })))}
      </div>
    </section>

    <section class="ld-sec ld-final" aria-labelledby="ld-final-h">
      <div class="ld-final-lattice" aria-hidden="true"></div>
      <div class="container ld-final-in">
        ${glyphSVG({ size: 48 })}
        <h2 class="h2-landing" id="ld-final-h">Your bag. <em>Your business.</em></h2>
        <p class="lead">Private by proof. Anchored to Bitcoin. Checked by you.</p>
        <div class="ld-ctas" style="justify-content:center">${button({ label: "Open wallet", href: "/app", kind: "neutral", size: "lg" })}${button({ label: "Run your own indexer", href: "/verify#run", kind: "secondary", size: "lg" })}</div>
      </div>
    </section>
  </div>`;

  const $ = (s) => root.querySelector(s);
  const offs = [];
  const observers = [];
  let alive = true;

  /* ---------- data ---------- */
  let chain = null;
  let stats = null;
  let assets = null;
  let logItems = null;
  let btcTip = null;
  let boardWhich = "live";

  const lattice = mountLattice($(".ld-hero-lattice"));
  const finalLattice = mountLattice($(".ld-final-lattice"), { depth: 5 });

  async function refresh() {
    const [st, as, lg] = await Promise.allSettled([api.stats({ fresh: true }), api.assets({ fresh: true }), logTail(api, { count: 60 })]);
    if (!alive) return;
    if (st.status === "fulfilled") stats = st.value;
    if (as.status === "fulfilled") assets = as.value;
    const firstLog = logItems === null;
    if (lg.status === "fulfilled") logItems = lg.value.items;
    else if (logItems === null) logItems = [];
    paintStrip();
    paintCrowd();
    paintBoard();
    if (firstLog) {
      setupVerifier();
      setupWall();
    }
    if (st.status === "rejected" && as.status === "rejected") paintOffline();
  }

  api.esplora
    .tipHeight()
    .then((h) => {
      btcTip = Number(h);
      if (alive) paintStrip();
    })
    .catch(() => {});

  /* ---------- hero chip and stats strip ---------- */

  function paintLive() {
    const el = $("[data-live-text]");
    if (!el) return;
    el.textContent = chain?.height != null ? `${LIVE_TEXT} · Block ${heightText(chain.height)}` : LIVE_TEXT;
  }

  let stripSeen = false;
  function paintStrip() {
    const box = $("[data-strip]");
    if (!box) return;
    const notes = n(stats?.notes ?? chain?.outputs);
    const proofs = stats ? n(stats.mints) + n(stats.privateTransfers) : null;
    const values = {
      block: btcTip ?? n(chain?.height),
      notes,
      proofs,
      tokens: n(stats?.tokens),
      mints: n(stats?.mints),
    };
    const blockChip = box.querySelector('[data-k="block"] .prov');
    if (btcTip !== null && blockChip) upgrade(blockChip, "BTC");
    for (const [k, v] of Object.entries(values)) {
      const el = box.querySelector(`[data-k="${k}"] [data-v]`);
      if (!el) continue;
      if (v === null || !Number.isFinite(v)) {
        el.innerHTML = '<span class="skel" style="width:5ch;height:.9em"></span>';
        continue;
      }
      el.dataset.to = String(v);
      if (stripSeen) countTo(el, v, k === "block");
    }
    paintNotesChips();
  }

  const stripObs = new IntersectionObserver((list) => {
    if (!list.some((e) => e.isIntersecting)) return;
    stripSeen = true;
    stripObs.disconnect();
    for (const el of root.querySelectorAll("[data-strip] [data-v][data-to]")) countTo(el, Number(el.dataset.to), el.closest('[data-k="block"]') !== null);
  });
  stripObs.observe($("[data-strip]"));
  observers.push(stripObs);

  /** The landing's one count-up: once, on first view, to the real value. */
  function countTo(el, to, isHeight = false) {
    const fmt = (v) => (isHeight ? heightText(v) : int(v));
    if (el.dataset.counted === "1" || reducedMotion() || to < 10 || isHeight) {
      el.textContent = fmt(to);
      el.dataset.counted = "1";
      return;
    }
    el.dataset.counted = "1";
    const t0 = performance.now();
    const step = (t) => {
      if (!alive) return;
      const p = Math.min(1, (t - t0) / 700);
      el.textContent = fmt(Math.round(to * (1 - (1 - p) ** 3)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /**
   * Notes stay IDX: a rebuild from exactly that many commitments only shows the indexer's
   * list agrees with its root (REBUILD_TIP says so), not that the list is Bitcoin's.
   */
  function notesVerified() {
    const r = getRootStatus();
    const notes = n(stats?.notes ?? chain?.outputs);
    return r.state === "match" && notes !== null && Number(r.commitments) === notes && (!chain || r.root === chain.root);
  }
  function paintNotesChips() {
    const tip = notesVerified() ? REBUILD_TIP : provTip("IDX");
    for (const chip of root.querySelectorAll("[data-notes-chip] .prov")) {
      upgrade(chip, "IDX");
      if (chip.hasAttribute("data-tip")) chip.dataset.tip = tip;
      chip.setAttribute("aria-label", `IDX: ${tip}`);
    }
  }
  offs.push(
    onRootStatus(() => {
      paintNotesChips();
      const t = $("[data-root-tool]");
      if (t) t.innerHTML = rootTool();
    }),
  );

  /* ---------- crowd meter ---------- */

  function paintCrowd() {
    const big = $("[data-crowd-big]");
    const panel = $("[data-crowd-panel]");
    const verified = notesVerified();
    if (big) big.innerHTML = crowdBig(stats, chain, verified);
    if (panel) panel.innerHTML = crowdPanel(stats, chain, verified);
    paintNotesChips();
  }

  /* ---------- launch board ---------- */

  function paintBoard() {
    const el = $("[data-board]");
    if (!el) return;
    if (!assets) {
      el.innerHTML = html`<p class="small t-3">The launch list didn't load. ${button({ label: "Browse mints", href: "/mints", kind: "ghost", size: "sm" })}</p>`;
      return;
    }
    const groups = boardGroups(assets, chain?.height ?? null);
    const list = groups[boardWhich] ?? [];
    const walletReady = getWalletStatus().state === "unlocked";
    if (!list.length) {
      const text = {
        live: "No open mints right now. Be first: write a token to Bitcoin.",
        upcoming: "No launches are scheduled. A launch can open at any future block.",
        soldout: "Nothing has minted out yet.",
      }[boardWhich];
      el.innerHTML = html`<div class="panel" style="grid-column:1/-1">${empty({ text, action: { label: "Launch a token", href: "/app/launch" } })}</div>`;
      return;
    }
    el.innerHTML = html`${list.slice(0, 3).map((a) => launchCard(a, { height: chain?.height ?? null, walletReady }))}`;
  }
  offs.push(onWalletStatus(() => alive && assets && paintBoard()));

  function paintOffline() {
    const sum = $("[data-wall-sum]");
    if (sum && !logItems?.length) sum.textContent = "Our indexer is unreachable right now, so there's no public log to read. The checks below need it to pick transactions; try again in a minute.";
  }

  /* ---------- live verifier ---------- */

  let candidates = [];
  let current = null;
  let runSeq = 0;
  let lastResult = null;
  let tv = null;

  function setupVerifier() {
    candidates = verifierCandidates(logItems, 50);
    current = pickDefault(candidates);
    paintPick();
  }

  function paintPick() {
    const pick = $("[data-lv-pick]");
    const body = $("[data-lv-body]");
    if (!pick || !body) return;
    lastResult = null;
    if (!current) {
      pick.innerHTML = html`<span class="t-2">No proofs on this pool yet.</span>`;
      $("[data-lv-tx]").textContent = "";
      $("[data-lv-emblem]").innerHTML = sealEmblem({ state: "mined", height: chain?.height ?? null }, { size: 104, ring: `AWAITING THE FIRST PROOF · ${IS_SIGNET ? "SIGNET" : "MAINNET"}` });
      body.innerHTML = html`<div class="lv-empty"><p class="small">The first private transfer or mint on this pool will appear here, ready to re-check. Until then, verify any txid below or open a launch.</p>${button({ label: "Browse mints", href: "/mints", kind: "secondary", size: "sm" })}</div>`;
      return;
    }
    const e = current;
    const ago = chain?.height != null ? relBlocks(chain.height - e.height) : null;
    pick.innerHTML = html`<span>${candidateLabel(e)}</span><span class="t-3">·</span>${heightHTML(e.height)}${ago ? html`<span class="t-3">· ${ago}</span>` : ""}${candidates.length > 1 ? html`<button type="button" class="btn btn--ghost btn--xs" data-action="lv-shuffle">${icon("shuffle", { size: 14 })}Shuffle</button>` : ""}`;
    $("[data-lv-tx]").innerHTML = html`tx ${hash(e.txid, { head: 8, tail: 8, href: `/tx/${e.txid}`, label: "Copy txid" })}`;
    $("[data-lv-emblem]").innerHTML = sealEmblem({ state: "accepted", height: e.height }, { size: 104, op: OP_WORD[e.opName] ?? e.opName });
    body.innerHTML = html`
      <div class="lv-anatomy" data-lv-anatomy><span class="skel" style="width:100%;height:112px"></span></div>
      <div class="lv-row" data-lv-row>${observerRow(e, null)}</div>
      <div data-lv-action>${button({ label: "Verify in my browser", kind: "neutral", block: true, icon: "proof", action: "lv-verify" })}</div>
      <div data-lv-transcript hidden></div>
      <div data-lv-result hidden></div>
      <div data-lv-after hidden></div>`;
    tv = null;
    loadAnatomy(e);
  }

  async function loadAnatomy(e) {
    const my = runSeq;
    try {
      const { readEnvelope, chain: cached } = await live();
      const env = await readEnvelope(e.txid);
      if (!alive || current !== e || my !== runSeq) return;
      const box = $("[data-lv-anatomy]");
      if (box) box.innerHTML = env.payload ? hexmap(env.payload, { carrierVsize: env.vsize, compact: true }) : html`<p class="small t-3">No envelope found in this transaction.</p>`;
      const d = await cached.tx(e.txid).catch(() => null);
      if (!alive || current !== e) return;
      const row = $("[data-lv-row]");
      if (row) row.innerHTML = observerRow(e, d?.fee ?? null);
    } catch (err) {
      const box = $("[data-lv-anatomy]");
      const why = /: 404\b/.test(String(err?.message)) ? "mempool.space doesn't have this transaction" : "mempool.space didn't answer";
      if (box && current === e) box.innerHTML = html`<p class="small t-3 lv-err">${icon("warn", { size: 14 })} Couldn't load the raw transaction: ${why}. The check below tries again.</p>`;
    }
  }

  function observerRow(e, fee) {
    const feeText = fee !== null && fee !== undefined ? sats(fee) : DASH;
    if (e.opName === "TRANSFER") {
      return html`<span>Token ${redact("token")}</span><span>Amount ${redact("amount")}</span><span>Sender&#39;s shielded address ${redact("sender")}</span><span>Recipient ${redact("recipient")}</span><span>Proof <b class="mono">128 bytes</b></span><span>Fee <b class="mono">${feeText}</b> ${prov("BTC")}</span>`;
    }
    const a = (assets ?? []).find((x) => String(x.id) === String(e.asset));
    const amount = e.amount != null ? units(e.amount, a?.divisibility ?? 0) : DASH;
    return html`<span>Token <b class="ticker">${e.ticker ?? a?.ticker ?? DASH}</b></span><span>Amount <b class="mono">${amount}</b></span><span>Paid by <b>a public address</b></span><span>Recipient ${redact("recipient")}</span><span>Proof <b class="mono">128 bytes</b></span><span>Fee <b class="mono">${feeText}</b> ${prov("BTC")}</span>`;
  }

  async function runVerifier() {
    const e = current;
    if (!e) return;
    const my = ++runSeq;
    const mod = await live();
    if (!alive || my !== runSeq) return;
    const tbox = $("[data-lv-transcript]");
    const action = $("[data-lv-action]");
    const result = $("[data-lv-result]");
    const after = $("[data-lv-after]");
    action.hidden = false;
    action.innerHTML = button({ label: "Verifying…", kind: "neutral", block: true, loading: "Checking in your browser…" });
    result.hidden = true;
    after.hidden = true;
    tbox.hidden = false;
    tbox.innerHTML = transcript(rowsFor(mod.planSteps(e.opName)), { actions: false });
    tv = new TranscriptView(tbox.querySelector(".transcript"));
    const res = await mod.checkTx(e.txid, {
      entry: e,
      onPlan: (opName) => {
        if (my !== runSeq) return;
        const done = new Map(tv.rows.map((r) => [r.id, r]));
        tv.set(rowsFor(mod.planSteps(opName)).map((r) => done.get(r.id) ?? r));
      },
      onStep: (s) => {
        if (my !== runSeq) return;
        const patch = { status: s.status, prov: s.source, label: s.label, detail: s.detail ?? "", ms: s.ms };
        if (tv.rows.some((r) => r.id === s.id)) tv.update(s.id, patch);
        else tv.set([...tv.rows, { id: s.id, ...patch }]);
      },
    });
    await tv.queue;
    if (!alive || my !== runSeq) return;
    lastResult = res;
    // The check fetched the raw bytes itself: draw the envelope from them if the preview couldn't.
    const anat = $("[data-lv-anatomy]");
    if (res.payload && anat && !anat.querySelector(".hexmap")) anat.innerHTML = hexmap(res.payload, { carrierVsize: res.sizes?.vsize ?? null, compact: true });
    mod.chain.tx(e.txid).then((d) => {
      const row = alive && current === e ? $("[data-lv-row]") : null;
      if (row && d?.fee != null) row.innerHTML = observerRow(e, d.fee);
    }).catch(() => {});
    if (res.steps?.length) tv.set(res.steps.map((s) => ({ id: s.id, label: s.label, prov: s.source, status: s.status, detail: s.detail ?? "", ms: s.ms })));
    const v = wallVerdict(res, e);
    const ok = res.verdict === "verified";
    const emblem = $("[data-lv-emblem]");
    if (res.status) {
      const seal = ok
        ? { state: "verified", height: res.status.height, ms: res.proofMs ?? null }
        : res.verdict === "mismatch"
          ? { state: "mismatch", height: res.status.height }
          : v.tone === "danger"
            ? { state: "rejected", height: res.status.height, reason: v.title }
            : { state: res.status.confirmed ? "accepted" : "mempool", height: res.status.height };
      emblem.innerHTML = sealEmblem(seal, { size: 104, proof: res.env?.proof ?? null, op: OP_WORD[e.opName] ?? e.opName });
      if (ok) stamp(emblem.querySelector(".seal-emblem"));
    }
    result.hidden = false;
    result.innerHTML = ok
      ? html`<div class="lv-result lv-result--ok">${icon("check", { size: 18 })}<div><b>Verified in your browser${res.proofMs != null ? html` in <span class="mono">${fmtMs(res.proofMs)}</span>` : ""}.</b> Bitcoin carried the proof; your machine checked it. ${prov("YOU")}</div></div>`
      : html`<div class="lv-result ${v.tone === "danger" ? "lv-result--bad" : ""}">${icon(v.tone === "danger" ? "cross" : "info", { size: 18 })}<div><b>${v.title}.</b> ${v.detail}</div></div>`;
    // Transcript, then the verdict, then what to do next (visual.md 10.2).
    action.hidden = true;
    after.hidden = false;
    after.innerHTML = html`<div class="cluster">${button({ label: "Open receipt", href: `/tx/${e.txid}`, kind: "secondary", icon: "seal" })}${candidates.length > 1 ? button({ label: "Try another", kind: "ghost", icon: "shuffle", action: "lv-shuffle" }) : button({ label: "Run again", kind: "ghost", icon: "refresh", action: "lv-verify" })}</div>`;
  }

  function shuffle() {
    if (candidates.length < 2) return;
    let next = current;
    for (let guard = 0; guard < 8 && next === current; guard++) next = candidates[Math.floor(Math.random() * candidates.length)];
    if (next === current) next = candidates[(candidates.indexOf(current) + 1) % candidates.length];
    current = next;
    runSeq++;
    paintPick();
  }

  /* ---------- proof wall ---------- */

  let wall = [];
  let wallRunning = false;
  let wallAbort = null;

  function setupWall() {
    wall = wallEntries(logItems, 12).map((entry) => ({ entry, state: "waiting", verdict: null, proof: null, ms: null }));
    paintWall();
    if (!wall.length) return;
    if (!isPhone()) {
      const obs = new IntersectionObserver((list) => {
        if (!list.some((x) => x.isIntersecting)) return;
        obs.disconnect();
        runWall();
      }, { rootMargin: "200px" });
      obs.observe($("#wall"));
      observers.push(obs);
    }
  }

  function wallItem(w, i) {
    const e = w.entry;
    const op = e.opName === "MINT_SCRIPT" ? "MINT" : e.opName === "TRANSACT" ? "TRANSFER" : e.opName === "MINE_SCRIPT" ? "MINE" : e.opName === "DEPLOY_POW" ? "DEPLOY" : e.opName;
    // A rejected envelope is red from the start, with the indexer's reason, before any check.
    const tone = w.verdict?.tone ?? (e.ok === false ? "danger" : null);
    const print =
      w.proof && w.state === "done"
        ? proofprint(w.proof, { size: 44, mined: true, verified: w.verdict?.tone === "proof", half: false })
        : w.state === "running"
          ? html`<span class="spinner spinner--14"></span>`
          : icon(op === "DEPLOY" ? "launch" : op === "ATTEST" ? "seal" : op === "MINT" ? "mint" : "lock", { size: 16 });
    const res =
      w.state === "running"
        ? html`<span>Checking…</span>`
        : w.state === "waiting"
          ? html`<span>${e.ok === false ? "Rejected by indexer · waiting" : "Waiting"}</span>`
          : w.verdict?.tone === "proof"
            ? html`${icon("check", { size: 14 })}<span>${w.verdict.title}${w.verdict.ms != null ? html` · <span class="mono">${fmtMs(w.verdict.ms)}</span>` : ""}</span>${prov("YOU")}`
            : html`${icon(tone === "danger" ? "cross" : "info", { size: 14 })}<span>${w.verdict?.title ?? "Done"}</span>`;
    const detail = w.state === "done" && w.verdict && w.verdict.tone !== "proof" ? html`<span class="wall-detail">${w.verdict.detail}</span>` : e.ok === false && w.state !== "done" ? html`<span class="wall-detail">${e.reason ?? ""}</span>` : "";
    return html`<li class="wall-item ${tone ? `wall--${tone}` : ""} ${w.state === "done" ? "is-done" : ""}" data-wall="${i}">
      <a class="wall-print" href="/tx/${e.txid}" data-link aria-label="Open the receipt for ${short(e.txid)}">${print}</a>
      <span class="wall-top"><span class="opbadge ${op === "DEPLOY" || op === "MINT" ? "opbadge--btc" : ""}">${op === "TRANSFER" ? icon("lock", { size: 10 }) : ""}${op}</span><span class="height">${heightText(e.height)}</span><a class="wall-tx" href="/tx/${e.txid}" data-link>${short(e.txid, 6, 4)}</a></span>
      <span class="wall-res">${res}</span>
      ${detail}
    </li>`;
  }

  function paintWall() {
    const grid = $("[data-wall-grid]");
    const actions = $("[data-wall-actions]");
    const sum = $("[data-wall-sum]");
    if (!grid) return;
    if (!wall.length) {
      grid.innerHTML = html`<li class="panel" style="grid-column:1/-1">${empty({ text: "No envelopes on this pool yet. The first launch, mint or transfer will appear here and be re-checked live.", action: { label: "Launch a token", href: "/app/launch" } })}</li>`;
      if (sum && logItems) sum.textContent = "Nothing to check yet.";
      if (actions) actions.innerHTML = "";
      return;
    }
    grid.innerHTML = html`${wall.map((w, i) => wallItem(w, i))}`;
    const done = wall.filter((w) => w.state === "done");
    if (sum) sum.textContent = done.length ? `${wallSummary(wall.map((w) => w.verdict))}` : `${wall.length} envelopes ready to check`;
    if (actions) {
      actions.innerHTML = wallRunning
        ? button({ label: "Stop", kind: "ghost", size: "sm", action: "wall-stop" })
        : done.length === wall.length
          ? button({ label: "Re-run", kind: "secondary", size: "sm", icon: "refresh", action: "wall-run" })
          : button({ label: done.length ? "Continue" : "Verify live", kind: "neutral", size: "sm", icon: "proof", action: "wall-run" });
    }
  }

  function paintWallItem(i) {
    const li = root.querySelector(`[data-wall="${i}"]`);
    if (!li) return paintWall();
    const tmp = document.createElement("template");
    tmp.innerHTML = String(wallItem(wall[i], i)).trim();
    li.replaceWith(tmp.content.firstChild);
    const sum = $("[data-wall-sum]");
    if (sum) sum.textContent = wallSummary(wall.map((w) => w.verdict));
  }

  async function runWall() {
    if (wallRunning || !wall.length) return;
    wallRunning = true;
    wallAbort = new AbortController();
    const signal = wallAbort.signal;
    if (wall.every((w) => w.state === "done")) for (const w of wall) Object.assign(w, { state: "waiting", verdict: null });
    paintWall();
    try {
      const mod = await live();
      await mod.runQueue(
        wall.map((w, i) => i).filter((i) => wall[i].state !== "done"),
        async (i) => {
          if (!alive || signal.aborted) return;
          const w = wall[i];
          w.state = "running";
          paintWallItem(i);
          const res = await mod.checkTx(w.entry.txid, { entry: w.entry });
          if (!alive) return;
          w.state = "done";
          w.verdict = wallVerdict(res, w.entry);
          w.proof = res.env?.proof ?? null;
          paintWallItem(i);
        },
        { signal },
      );
    } catch (e) {
      toast({ kind: "warn", title: "The proof wall stopped.", body: `${e.message}. Press Continue to pick up where it stopped.` });
    } finally {
      wallRunning = false;
      if (alive) paintWall();
    }
  }

  /* ---------- events ---------- */

  offs.push(
    on(root, "click", "[data-action]", (ev, el) => {
      switch (el.dataset.action) {
        case "ld-goverify": {
          const panel = $("#verifier");
          panel?.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
          const btn = root.querySelector("[data-action=lv-verify]");
          if (btn && !isPhone()) setTimeout(() => btn.focus({ preventScroll: true }), 300);
          return;
        }
        case "lv-verify":
          return runVerifier();
        case "lv-shuffle":
          return shuffle();
        case "wall-run":
          return runWall();
        case "wall-stop":
          wallAbort?.abort();
          return;
      }
    }),
    on(root, "seg-change", "[data-seg]", (ev) => {
      if (ev.detail?.name === "ld-sees") $("[data-sees]").innerHTML = seesCard(ev.detail.value);
      if (ev.detail?.name === "ld-board") {
        boardWhich = ev.detail.value;
        paintBoard();
      }
    }),
    on(root, "submit", "form[data-any]", (ev, form) => {
      ev.preventDefault();
      const v = String(form.querySelector("input").value).trim().toLowerCase().replace(/^0x/, "");
      const msg = root.querySelector(`[data-any-msg="${form.dataset.any}"]`);
      if (TXID.test(v)) return navigate(`/tx/${v}`);
      if (msg) {
        msg.hidden = false;
        msg.textContent = "That isn't a txid. Paste the 64 hexadecimal characters of a Bitcoin transaction id.";
      }
    }),
  );

  // Subscribed last: watchState calls back synchronously with the cached state, and every
  // painter above must be initialized by then.
  offs.push(
    api.watchState((s) => {
      if (!alive || !s) return;
      const grew = chain && s.outputs > chain.outputs;
      const newBlock = chain && s.height !== chain.height;
      chain = s;
      lattice.update(s.outputs);
      finalLattice.update(s.outputs);
      paintLive();
      paintStrip();
      if (newBlock || grew) refresh();
    }),
  );
  refresh();

  return () => {
    alive = false;
    runSeq++;
    wallAbort?.abort();
    lattice.destroy();
    finalLattice.destroy();
    for (const o of observers) o.disconnect();
    for (const off of offs) off();
  };
}

/* ---------- markup helpers ---------- */

function verifierShell() {
  return html`<section class="panel panel--certified lv" id="verifier" aria-labelledby="lv-h" tabindex="-1">
    <div class="lv-head">
      <div class="lv-pick">
        <div class="eyebrow">LIVE VERIFIER</div>
        <h2 class="visually-hidden" id="lv-h">Live verifier</h2>
        <div class="lv-pick-line" data-lv-pick><span class="skel" style="width:16ch;height:14px"></span></div>
        <div class="lv-tx mono" data-lv-tx></div>
      </div>
      <div class="lv-emblem" data-lv-emblem>${sealEmblem({ state: "mempool" }, { size: 104, ring: "LIVE VERIFIER · RAW BITCOIN DATA · MEMPOOL.SPACE" })}</div>
    </div>
    <div class="stack" data-lv-body><span class="skel" style="width:100%;height:112px"></span><span class="skel" style="width:100%;height:40px"></span></div>
    <form class="lv-any" data-any="hero" novalidate>
      <input class="input mono" name="txid" placeholder="Verify any txid…" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Verify any transaction id">
      ${button({ label: "Go", kind: "secondary", type: "submit" })}
    </form>
    <p class="caption t-3" data-any-msg="hero" hidden></p>
    <p class="lv-small">This widget calls mempool.space directly from your browser. Open your network tab and watch. Bitcoin stores and orders this data; it doesn't run the proof. The rules are enforced by replay, as with Runes and Ordinals, which is why anyone can re-check them.</p>
  </section>`;
}

function rowsFor(plan) {
  return plan.map((s) => ({ id: s.id, label: s.label, prov: s.source, status: "pending", detail: "", ms: null }));
}

function stripMarkup() {
  const item = (k, label, chip, notes = false) =>
    html`<div class="ld-stat" data-k="${k}"><span class="ld-stat-v${k === "block" ? " height" : ""}" data-v><span class="skel" style="width:5ch;height:.9em"></span></span><span class="ld-stat-l"${notes ? html` data-notes-chip` : ""}>${label} ${prov(chip)}</span></div>`;
  return html`${item("block", "Block", "IDX")}${item("notes", "Notes in the pool", "IDX", true)}${item("proofs", "Proofs on Bitcoin", "IDX")}${item("tokens", "Tokens", "IDX")}${item("mints", "Mints", "IDX")}`;
}

function seesCard(which) {
  const s = SEES[which] ?? SEES.public;
  const val = (v) => (String(v).startsWith("R:") ? redact(String(v).slice(2)) : v);
  return html`<div class="ld-sees-top"><span class="eyebrow">${s.label}</span>${tag("Illustration", "neutral")}</div>
    <dl class="ld-sees-rows">${s.rows.map(([k, v]) => html`<div class="ld-sees-row"><dt>${k}</dt><dd>${val(v)}</dd></div>`)}</dl>
    <div class="ld-sees-top" style="border-top:1px solid var(--line);border-bottom:0"><span class="caption t-3">${
      which === "normal"
        ? "Every explorer and every bot reads this."
        : which === "public"
          ? "The proof shows the rules were followed, and nothing else."
          : "From your wallet's history on this device. Nothing is sent anywhere."
    }</span></div>`;
}

function crowdBig(stats, chain, verified = false) {
  const notes = n(stats?.notes ?? chain?.outputs);
  const tokens = n(stats?.tokens);
  const spent = n(stats?.nullifiers ?? chain?.nullifiers);
  const v = (x) => (x === null ? html`<span class="skel" style="width:4ch;height:.8em"></span>` : int(x));
  return html`<span>${v(notes)}<span class="unit">notes</span></span><span data-notes-chip>${prov("IDX", { tip: verified ? REBUILD_TIP : true })}</span><span class="sep">·</span><span>${v(tokens)}<span class="unit">tokens</span></span><span class="sep">·</span><span>${v(spent)}<span class="unit">spent</span></span>${prov("IDX")}`;
}

function crowdPanel(stats, chain, verified = false) {
  const notes = n(stats?.notes ?? chain?.outputs);
  if (notes === null) return html`<span class="skel" style="width:70%;height:16px"></span><span class="skel" style="width:100%;height:120px"></span>`;
  const next = MILESTONES.find((m) => notes < m) ?? null;
  const prevMark = next === 10000 ? 1000 : 0;
  const early = notes < 1000;
  const fill = next ? Math.min(100, (100 * (notes - prevMark)) / (next - prevMark)) : 100;
  return html`
    <div data-notes-chip>${anonMeter({ notes, tokens: n(stats?.tokens), prov: "IDX" })}</div>
    ${early
      ? html`<div class="ld-early" role="note">${icon("info", { size: 16 })}<div>${tag("EARLY POOL", "warn")} <span>The crowd is small today. Every launch and every transfer grows it.</span></div></div>`
      : ""}
    <div class="ld-mile">
      <div class="split"><span class="eyebrow">${next ? `Next milestone · ${int(next)} notes` : "Past 10,000 notes"}</span><span class="caption t-3 mono">${next ? `${int(next - notes)} to go` : ""}</span></div>
      <div class="ld-mile-track" role="progressbar" aria-valuemin="${prevMark}" aria-valuemax="${next ?? notes}" aria-valuenow="${notes}" aria-label="Pool size toward the next milestone"><span class="ld-mile-fill" style="width:${fill.toFixed(2)}%"></span></div>
      <div class="ld-mile-labels"><span>${int(prevMark)}</span><span>${next ? int(next) : int(notes)}</span></div>
    </div>
    <div>
      <div class="split" style="margin-bottom:8px"><span class="eyebrow">Pool growth · last 1,008 blocks ${prov("IDX")}</span><span class="caption t-3 mono">${stats ? `${int(stats.transfers144)} private transfers in 144 blocks` : DASH}</span></div>
      ${stats ? crowdChart(stats.series ?? [], { notes, tip: stats.height ?? chain?.height }) : html`<span class="skel" style="width:100%;height:120px"></span>`}
    </div>
    <p class="caption t-3">An upper bound, not a guarantee: timing, public mint data, your IP address and unusual amounts can all narrow it down. Nobody pads these numbers: they count only envelopes that are on Bitcoin.</p>`;
}

function rootTool() {
  const s = getRootStatus();
  return html`<p>${rootSentence(s)}</p><div class="cluster" style="margin-top:10px">${rootChip(s)}<span class="caption t-3">Tap the chip for the readout and a rebuild.</span></div>`;
}

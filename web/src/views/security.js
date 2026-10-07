/**
 * /security (visual.md sections 9 and 10.9; the trust panel). Every number comes
 * from facts.json (written at build time from the repo) or a live API; missing values show "—".
 * Copy rules: "internally reviewed", never "audited" alone; no "trustless"; the setup and the
 * network status are always stated, per network (docs/design/mainnet-readiness.md §6.7):
 * signet keeps its single-party development setup by design (its genesis pins it); mainnet
 * uses a public ceremony, shown only once the mainnet pins name it, and is "not launched"
 * until a genesis is pinned.
 */
import "../verify/verify.css";
import { html } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { int, hash, heightText, DASH } from "../ui/format.js";
import { button, panel, tag, table } from "../ui/components.js";
import facts from "../facts.json";
import { ACTIVATION_HEIGHT, ARTIFACT_SHA256, GENESIS_TXID, MANIFEST_SHA256, NETWORK, PARAMS, PRE_GENESIS, REPO_URL } from "../config.js";

// src/params.mjs; config.js doesn't re-export it, so read it from PARAMS.
const SECURITY_CONTACT = PARAMS.SECURITY_CONTACT ?? null;

const n = (v) => (v === null || v === undefined ? DASH : int(v));

/**
 * What this page states, from the build's network and pins. Exported so tests (and the /verify
 * page) can render the copy of either network. `ceremony` is null until the mainnet pins hold the
 * ceremony's verification key and manifest; its details come from the manifest when facts.json
 * carries them.
 */
export function pageContext(over = {}) {
  const network = NETWORK === "mainnet" ? "mainnet" : "signet";
  const manifest = MANIFEST_SHA256 ?? facts.manifest?.sha256 ?? null;
  const pinned = network === "mainnet" && Boolean(MANIFEST_SHA256) && Boolean(ARTIFACT_SHA256?.vkey);
  return {
    network,
    preGenesis: PRE_GENESIS,
    genesisTxid: GENESIS_TXID,
    activationHeight: ACTIVATION_HEIGHT,
    manifest,
    vkey: ARTIFACT_SHA256?.vkey ?? facts.artifacts?.vkey?.sha256 ?? null,
    zkey: ARTIFACT_SHA256?.zkey ?? facts.artifacts?.zkey?.sha256 ?? null,
    ceremony: pinned ? (facts.manifest?.ceremony ?? {}) : null,
    ...over,
  };
}

/** "public ceremony <id>, N contributions, beacon block H", with what the manifest gives. */
export function ceremonyLabel(c) {
  if (!c) return null;
  const parts = [`public ceremony${c.id ? ` ${c.id}` : ""}`];
  if (Number.isInteger(c.contributions)) parts.push(`${int(c.contributions)} contribution${c.contributions === 1 ? "" : "s"}`);
  if (Number.isInteger(c.beacon?.height)) parts.push(`beacon block ${heightText(c.beacon.height)}`);
  return parts.length > 1 ? parts.join(", ") : "public ceremony (details in the pinned manifest)";
}

/** A-9: what the chain check covers and what is still trusted, per network. */
export function chainTrust(network) {
  if (network === "mainnet") {
    return {
      word: "HEADERS CHECKED",
      text: "Headers are checked for proof of work and the difficulty rules from a pinned checkpoint, and the chain with the most work wins among those the data source serves. The source can still hide or delay blocks; your own node removes it.",
      limit: "A single data source can still hide or delay blocks; your own node removes it",
    };
  }
  return {
    word: "PARTLY CHECKED",
    text: "Headers are checked for proof of work and the difficulty rules from a pinned checkpoint. Signet blocks are valid by a signature that is not checked, and signet proof of work is nearly free.",
    limit: "Signet block signature (BIP325) not checked, and signet proof of work is nearly free; a single data source can still hide or delay blocks",
  };
}

/** A-8: the phase-2 setup, per network. */
export function setupTrust({ network, ceremony = null }) {
  if (network !== "mainnet") {
    return {
      level: "red", word: "OPEN RISK", status: "single-party development setup", tone: "danger",
      text: "Development phase 2 from a single party. Whoever ran it could forge proofs. Signet keeps it by design: its genesis attestation pins these keys. Mainnet uses keys from a public ceremony.",
    };
  }
  if (!ceremony) {
    return {
      level: "red", word: "NOT RUN YET", status: "public ceremony not run yet", tone: "danger",
      text: "The public phase-2 ceremony has not run yet, so no mainnet proving key is pinned.",
    };
  }
  const label = ceremonyLabel(ceremony);
  return {
    level: "amber", word: "PUBLIC CEREMONY", status: label, tone: "proof",
    text: `Phase 2 comes from a ${label}. It is secure if at least one contributor discarded their secret; anyone can re-verify the transcript, every contribution and the beacon.`,
  };
}

/** The network line of the trust board and the banner, per network and genesis. */
export function networkStatus({ network, preGenesis }) {
  if (network !== "mainnet") {
    return { level: "neutral", word: "TEST ONLY", text: "Signet test coins. The tokens have no value.", banner: "Signet test network. Test coins only, with no value. Development proving keys." };
  }
  if (preGenesis) {
    const text = "Murkle has not launched on Bitcoin mainnet. No genesis is pinned, so nothing here can move funds.";
    return { level: "neutral", word: "NOT LAUNCHED", text, banner: text };
  }
  return {
    level: "amber", word: "BITCOIN MAINNET",
    text: "Experimental software on Bitcoin mainnet. Tokens may be worth money and can be lost to bugs. The anonymity set is small while the pool is early.",
    banner: "Bitcoin mainnet. Experimental software: tokens may be worth money and can be lost to bugs. Internal review only, no external audit yet.",
  };
}

/** How a proof receipt checks the block header it relies on (headerCheck levels, best first). */
export function receiptLevels() {
  return [
    ["checkpoint", "Your replay's header chain, verified from a pinned checkpoint, holds the block."],
    ["linked", "Up to 6 headers above the block link to it, meet their own targets and stay within what the pinned checkpoint allows."],
    ["bounded", "The block's own target is no easier than the pinned checkpoint allows at its height, so a forged header needs at least that much work. That bound loosens 4x per difficulty period away from the checkpoint; on mainnet the receipt prints the work it implies and says when it is too low to rule out a forgery."],
    ["own-target", "Only the block's own proof of work was checked (no more data was available)."],
  ];
}

/** The per-network copy of /verify (web/src/views/verify.js), kept here so both pages say the same. */
export function verifyCopy(ctx = pageContext()) {
  const mainnet = ctx.network === "mainnet";
  const setup = setupTrust(ctx);
  const label = ceremonyLabel(ctx.ceremony);
  return {
    caveats: [
      "It catches an indexer that reports a wrong pool: a missing or extra note, a double spend, a wrong verdict or wrong supply. Because it reads whole blocks, a hidden or omitted transaction shows up too.",
      mainnet
        ? "It checks every block header from a pinned checkpoint: proof of work, the difficulty rules, and the most work among the chains mempool.space serves (A-9). mempool.space can still hide or delay blocks; your own node removes it (run your own indexer, below)."
        : "It checks every block header from a pinned checkpoint: proof of work and the difficulty rules (A-9). Signet blocks are valid by a signature that is not checked, and signet proof of work is nearly free, so on signet this mainly catches broken or inconsistent data. mempool.space can still hide or delay blocks.",
      "It trusts the verification key and genesis pinned in the page you loaded. A tampered website could ship different pins; a locally built copy closes that gap.",
      mainnet
        ? ctx.ceremony
          ? `A valid proof is only as sound as the trusted setup: the ${label}, secure if at least one contributor discarded their secret (A-8).`
          : "No mainnet proving key is pinned yet: the public ceremony has not run (A-8)."
        : "A valid proof is only as sound as the trusted setup, which on signet is a single-party development setup (A-8), kept by design; mainnet uses a public ceremony.",
    ],
    limitsTitle: mainnet ? "What is still trusted on mainnet" : "What is still trusted on signet",
    limits: [
      ["SETUP", mainnet && ctx.ceremony ? "warn" : "danger", mainnet
        ? `${setup.text} (A-8)`
        : "Proving keys come from a single-party development setup (A-8). Whoever ran it could forge proofs. Signet keeps it by design; mainnet uses a public ceremony."],
      ["CHAIN DATA", "warn", mainnet
        ? "Block data comes from mempool.space. Headers are checked from a pinned checkpoint and the chain with the most work wins among those it serves; it can still hide or delay blocks, and your own node removes it (A-9)."
        : "Block data comes from mempool.space. Headers are checked for proof of work and the difficulty rules from a pinned checkpoint, but the signet block signature is not checked and signet proof of work is nearly free (A-9)."],
      ["REVIEW", "warn", "Internal review only (circomspect, Picus, manual); no external audit yet."],
      ["NETWORK", "neutral", networkStatus(ctx).text],
    ],
    setupTag: [setup.status, setup.tone],
    headerLevels: receiptLevels(),
  };
}

const CHIP = {
  DONE: () => tag("DONE", "proof"),
  SIGNET: () => tag("SIGNET ONLY", "warn"),
  MAINNET: () => tag("BEFORE MAINNET", "danger"),
  DESIGN: () => tag("BY DESIGN", "neutral"),
  LIMIT: () => tag("KNOWN LIMIT", "warn"),
  OPEN: () => tag("NOT YET", "danger"),
};

function statusBoard(ctx) {
  const c = facts.circuit ?? {};
  const a = facts.audit ?? {};
  const medium = a.bySeverity?.Medium ?? null;
  const mainnet = ctx.network === "mainnet";
  const setupRows = !mainnet
    ? [["Trusted setup: single-party development setup (signet keeps it by design: its genesis pins it)", "SIGNET"], ["Public MPC setup ceremony for the mainnet keys: tooling ready, not run yet", "MAINNET"]]
    : ctx.ceremony
      ? [[`Trusted setup: ${ceremonyLabel(ctx.ceremony)}`, "DONE"]]
      : [["Trusted setup: the public MPC ceremony has not run yet; no mainnet proving key is pinned", "MAINNET"]];
  const rows = [
    [`Circuit: ${n(c.constraints)} constraints, ${c.proofSystem ?? "Groth16"} on ${c.curve ?? "BN254"}, ${c.inputs ?? 2}-in/${c.outputs ?? 2}-out, depth-${c.treeDepth ?? 32} ${c.hash ?? "Poseidon"} tree`, "DONE"],
    ["Formal under-constraint check (Picus + cvc5): no under-constrained signals except harmless IsZero helper inverses, explained in the report", "DONE"],
    [`Static analysis (circomspect): ${n(a.circomspectFindings)} notes, 0 real issues`, "DONE"],
    [`Internal review: ${n(a.total)} findings, ${n(medium)} medium, ${a.mediumFixed != null && medium != null && a.mediumFixed === medium ? "all fixed with regression tests" : `${n(a.mediumFixed)} fixed`}`, "DONE"],
    [`${n(facts.testCount)} automated tests`, "DONE"],
    ["Every proof re-checkable in the browser from raw Bitcoin data (Proof receipts, Verify the Pool)", "DONE"],
    ...setupRows,
    ["Block headers checked from a pinned checkpoint: linkage, proof of work, difficulty rules, timestamps, and the most work among the chains the data source serves", "DONE"],
    [chainTrust(ctx.network).limit, mainnet ? "LIMIT" : "SIGNET"],
    ["Note encryption isn't proven in the circuit; a bad sender can only hurt their own payment's recipient", "DESIGN"],
    ["Mints are public: token, amount and the paying Bitcoin address", "DESIGN"],
    ["External audit", mainnet && !ctx.preGenesis ? "OPEN" : "MAINNET"],
  ];
  return html`<ul class="sec-board">${rows.map(([text, k]) => html`<li class="sec-board-row"><span class="sec-board-chip">${CHIP[k]()}</span><span>${text}</span></li>`)}</ul>`;
}

// The trust panel: a red/amber/green board of what you still trust.
function trustBoard(ctx) {
  const setup = setupTrust(ctx);
  const chain = chainTrust(ctx.network);
  const net = networkStatus(ctx);
  const rows = [
    [setup.level, "Trusted setup", setup.word, setup.text, "A-8", "/security#setup"],
    ["amber", "External audit", "NOT YET", "None yet. Internal review, Picus and circomspect only.", null, "/security#findings"],
    ["amber", "Chain data", chain.word, chain.text, "A-9", "/verify#pool"],
    ["amber", "Note encryption", "BY DESIGN", "Not proven in the circuit: a sender can send an unreadable note, burning their own payment.", "A-7", "/security#findings"],
    ["amber", "Fee-payer linkage", "BY DESIGN", "Whoever pays a transfer's fee is tied to it on Bitcoin. Fund the built-in key from a source not linked to your main wallet. A relay balance keeps your address off the transfer, but the relayer can link the address you top up from to every transfer it relays for you. While few accounts have topped up, the relayer's coin itself descends from your top-up, so Bitcoin ties the transfer to that address; the wallet says so and asks before sending. Mints are public by design.", null, "/protocol"],
    ["green", "Proof checks", "CHECKABLE", "Every proof can be re-verified in your browser from raw Bitcoin data, or by your own indexer.", null, "/verify"],
    [net.level, "Network", net.word, net.text, null, null],
  ];
  const tone = { red: "danger", amber: "warn", green: "proof", neutral: "neutral" };
  return html`<ul class="sec-trust">${rows.map(
    ([level, title, word, text, id, href]) => html`<li class="sec-trust-row sec-trust--${level}">
      <span class="sec-trust-dot" aria-hidden="true"></span>
      <div class="sec-trust-text"><div class="sec-trust-title">${title} ${tag(word, tone[level])}${id ? html` <span class="mono caption t-3">${id}</span>` : ""}</div><p class="small t-2">${text}</p></div>
      ${href ? html`<a class="small sec-trust-link" href="${href}" data-link>Details →</a>` : html`<span></span>`}
    </li>`,
  )}</ul>`;
}

function findingsTable() {
  const list = facts.audit?.findings ?? [];
  const sev = (s) => (s === "Medium" ? tag("Medium", "warn") : tag(s ?? DASH, "neutral"));
  const st = (f) =>
    f.state === "fixed"
      ? html`<span class="t-proof">${tag("Fixed", "proof")}</span>`
      : f.state === "partial"
        ? tag("Partially fixed", "warn")
        : f.state === "open"
          ? tag("Open", "warn")
          : f.state === "tested"
            ? tag("Regression test", "proof")
            : tag("Documented", "neutral");
  return table({
    columns: [
      { key: "id", label: "ID", mono: true },
      { key: "sev", label: "Severity" },
      { key: "where", label: "Where" },
      { key: "what", label: "Finding" },
      { key: "status", label: "Status" },
    ],
    rows: list.map((f) => ({
      id: f.id,
      sev: html`${sev(f.severity)}${f.severityNote && f.severityNote !== f.severity ? html`<span class="caption t-3 sec-sev-note">${f.severityNote}</span>` : ""}`,
      where: f.location ?? DASH,
      what: html`<span class="sec-finding">${f.description ?? f.title}</span>`,
      status: html`${st(f)}<span class="caption t-3 sec-status-note">${f.status ?? ""}</span>`,
    })),
    caption: "Internal review findings",
    empty: "The findings table isn't in this build (facts.json has none).",
  });
}

function methodology(ctx) {
  const total = facts.audit?.total ?? null;
  const signet = ctx.network !== "mainnet";
  const items = [
    ["circomspect", "Static analysis of the circuit for common mistakes: unconstrained signals, unused inputs, risky operators.", "It doesn't prove the circuit is correct or complete; it flags patterns, and each note was reviewed by hand."],
    ["Picus + cvc5", "A formal search for under-constrained signals: two different witnesses for the same public inputs.", "It doesn't prove the circuit implements the intended rules, only that its outputs are determined by its inputs."],
    [`${n(facts.testCount)} automated tests`, "Real Groth16 proofs end to end: mints, transfers, double spends, reorgs, tampered envelopes, tampered blocks and the genesis rule.", "Tests show the cases someone thought of. They don't cover every input."],
    ["Manual review", `The circuit, envelope codec, proof codec, indexer rules and wallet, reviewed internally; ${total ? `all ${int(total)} findings are` : "the findings are"} in the table above.`, "It is an internal review, not an independent audit."],
    ["Proof receipts", "Re-check one transaction from raw Bitcoin data: inclusion, envelope, binding hash, curve points, the pinned key and the pairing. The block header is checked as far as the data allows: your replay's header chain from a pinned checkpoint, else the headers above it, else its own target against the checkpoint.", `The data source can still hide blocks${signet ? ", and the signet block signature is not checked" : ""}. It trusts our indexer's log for rules that depend on pool history (spent nullifiers, caps), even after you replay the pool. Your replay only supplies the anchor root. Without a replay, the anchor root comes from our indexer (rebuilt from its commitments when possible).`],
    ["Verify the Pool", "Your browser replays every block since activation, checks every block header from a pinned checkpoint (proof of work, difficulty rules, most work), and compares the whole pool state with our indexer.", `mempool.space can still hide or delay blocks${signet ? ", and the signet block signature is not checked (signet proof of work is nearly free)" : ""}. It trusts the pins in the page you loaded.`],
  ];
  return html`<div class="sec-method">${items.map(
    ([name, does, not]) => html`<div class="sec-method-row">
      <div class="sec-method-name">${name}</div>
      <p class="small"><span class="eyebrow">DOES</span> ${does}</p>
      <p class="small t-2"><span class="eyebrow">DOES NOT PROVE</span> ${not}</p>
    </div>`,
  )}</div>`;
}

function setupPanel(ctx) {
  const phase1 = html`<div class="sec-setup-row"><span class="sec-step mono">1</span><div><div class="sec-setup-title">Phase 1: public Perpetual Powers of Tau ${tag("PUBLIC", "proof")}</div><p class="small t-2">powersOfTau28_hez_final_15, contributed to by many independent parties. Checked against its pinned hash when the circuit is built.</p></div></div>`;
  const keyLine = html`<p class="caption t-3">Proving key sha256 ${hash(ctx.zkey, { head: 8, tail: 4, label: "Copy proving key hash" })}</p>`;
  if (ctx.network !== "mainnet") {
    return html`<div class="sec-setup">
      ${phase1}
      <div class="sec-setup-row"><span class="sec-step mono">2</span><div><div class="sec-setup-title">Phase 2: circuit-specific ${tag("single-party development setup", "danger")}</div><p class="small t-2">One party made this contribution. If it kept its secret, it could forge proofs that every verifier accepts (A-8). That's acceptable for signet test coins and not for anything of value. Signet keeps it by design: its genesis attestation pins these keys.</p>${keyLine}</div></div>
      <div class="sec-setup-row"><span class="sec-step mono">3</span><div><div class="sec-setup-title">Public MPC ceremony for mainnet ${tag("NOT RUN YET", "neutral")}</div><p class="small t-2">Mainnet uses phase-2 keys from a ceremony anyone can join, finished with a random beacon from a pre-announced Bitcoin block. One honest participant is enough to prevent forged proofs. The mainnet keys get their own genesis attestation; signet keeps its development keys.</p></div></div>
    </div>`;
  }
  const setup = setupTrust(ctx);
  return html`<div class="sec-setup">
    ${phase1}
    <div class="sec-setup-row"><span class="sec-step mono">2</span><div><div class="sec-setup-title">Phase 2: circuit-specific ${ctx.ceremony ? tag("public ceremony", "proof") : tag("not run yet", "danger")}</div><p class="small t-2">${setup.text}</p>${ctx.ceremony ? keyLine : ""}</div></div>
    <div class="sec-setup-row"><span class="sec-step mono">3</span><div><div class="sec-setup-title">Signet ${tag("development setup", "neutral")}</div><p class="small t-2">The signet test network keeps its single-party development setup (A-8), pinned by its own genesis. It is never used on mainnet.</p></div></div>
  </div>`;
}

function contactLink(contact) {
  const c = String(contact).trim();
  if (/^https:\/\//i.test(c)) return html`<a href="${c}" target="_blank" rel="noopener noreferrer">${c.replace(/^https:\/\//i, "")}</a>`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return html`<a href="mailto:${c}">${c}</a>`;
  return html`<span class="mono">${c}</span>`;
}

/** The responsible-disclosure text. Never names a channel that doesn't exist. Exported for tests. */
export function disclosure({ contact = SECURITY_CONTACT, repoUrl = REPO_URL, network = NETWORK } = {}) {
  const how = contact
    ? html`Please report vulnerabilities privately to ${contactLink(contact)}, with steps to reproduce.`
    : repoUrl
      ? html`Please report vulnerabilities privately through a private security advisory on the <a href="${repoUrl}" target="_blank" rel="noopener noreferrer">repository</a>, with steps to reproduce.`
      : "No private reporting channel is published yet. One will be published on this page before any public launch.";
  const why = network === "mainnet"
    ? "Mainnet tokens may be worth money: report privately first, so a fix can ship before the details are public."
    : "Signet coins have no value, but every finding shapes what ships to mainnet.";
  return html`<p class="small t-2">${how} Don't post working exploits publicly. ${why}</p>`;
}

function checklist(ctx) {
  const mainnet = ctx.network === "mainnet";
  const items = [
    ["Public MPC setup ceremony for phase 2 (the mainnet keys)", mainnet ? (ctx.ceremony ? "Done" : "Not run yet") : "Tooling ready, not run"],
    ["Independent external audit of the circuit, codecs and indexer rules", "Not started"],
    ["Header verification from pinned checkpoints (proof of work, difficulty rules, most work) in the indexer, the CLI and the browser replay", "Done"],
    ["Indexing from the operator's own Bitcoin node (RPC source)", "Supported"],
    ["Independent indexer operators comparing digests", "Planned"],
    ["Locally verifiable web builds, so the pins in the page can be checked", "Planned"],
    ["Genesis attestation for the final artifacts", ctx.preGenesis ? "Not posted yet" : mainnet ? "Posted on mainnet" : "Posted on signet"],
  ];
  return html`<ul class="sec-check">${items.map(([t, s]) => html`<li><span class="sec-check-box" aria-hidden="true"></span><span>${t}</span><span class="caption t-3">${s}</span></li>`)}</ul>`;
}

function checklistNote(ctx) {
  if (ctx.network !== "mainnet") return "Until every item is done, this runs on signet with test coins only.";
  if (ctx.preGenesis) return "Mainnet has not launched. No genesis is pinned, so nothing here can move funds.";
  return "Items not done are open risks on mainnet; the trust board above says what each one means for you.";
}

/** The whole page for a context (pageContext()). */
export function renderPage(ctx = pageContext()) {
  const net = networkStatus(ctx);
  const launched = ctx.network === "mainnet" && !ctx.preGenesis;
  return html`<div class="container section sec">
    <header class="page-head">
      <div>
        <div class="eyebrow">SECURITY</div>
        <h1 class="receipt-hero">Security status.</h1>
        <p class="lead">${launched
          ? "What has been checked, what you still trust, and what is still open. Internal review, not an independent audit yet."
          : "What has been checked, what you still trust, and what must happen before mainnet. Internal review, not an independent audit yet."}</p>
      </div>
      <div class="cluster">${button({ label: "Verify it yourself", href: "/verify", kind: "neutral", icon: "proof" })}</div>
    </header>

    <div class="sec-signet" role="note">${icon("warn", { size: 16 })}<span>${net.banner}</span></div>

    <section id="status" class="vf-sec">${panel({ eyebrow: "STATUS", title: "Status board", certified: true, body: statusBoard(ctx) })}</section>
    <section id="trust" class="vf-sec">${panel({ eyebrow: "TRUST", title: "What you still trust", body: trustBoard(ctx) })}</section>
    <section id="findings" class="vf-sec">${panel({ eyebrow: "FINDINGS", title: "Internal review findings", body: html`${findingsTable()}<p class="caption t-3 sec-note">From audit/REPORT.md in the repository. Severity is our own internal rating.</p>` })}</section>
    <section id="methodology" class="vf-sec">${panel({ eyebrow: "METHODOLOGY", title: "How it was checked, and what each tool does not prove", body: methodology(ctx) })}</section>
    <section id="setup" class="vf-sec">${panel({ eyebrow: "TRUSTED SETUP", title: "Setup status", body: setupPanel(ctx) })}</section>
    <section id="fingerprints" class="vf-sec">${panel({
      eyebrow: "FINGERPRINTS",
      title: "Pinned in this build",
      body: html`<dl class="kv kv--compact">
        <div class="kv-row"><dt>Verification key</dt><dd>${hash(ctx.vkey, { label: "Copy verification key hash" })}</dd></div>
        <div class="kv-row"><dt>Circuit manifest</dt><dd>${hash(ctx.manifest, { label: "Copy manifest hash" })}</dd></div>
        <div class="kv-row"><dt>Genesis</dt><dd>${!ctx.preGenesis && ctx.genesisTxid ? html`${hash(ctx.genesisTxid, { href: `/tx/${ctx.genesisTxid}`, label: "Copy genesis txid" })} <span class="mono t-btc">${heightText(ctx.activationHeight)}</span>` : html`${tag("Pre-genesis", "warn")} <span class="caption t-3">not anchored on Bitcoin yet</span>`}</dd></div>
      </dl>
      ${button({ label: "Recompute them in your browser", href: "/verify#artifacts", kind: "secondary", size: "sm" })}`,
    })}</section>
    <section id="mainnet" class="vf-sec">${panel({ eyebrow: launched ? "OPEN ITEMS" : "BEFORE MAINNET", title: launched ? "Checklist" : "Mainnet checklist", body: html`${checklist(ctx)}<p class="caption t-3">${checklistNote(ctx)}</p>` })}</section>
    <section id="disclosure" class="vf-sec">${panel({
      eyebrow: "DISCLOSURE",
      title: "Found a problem?",
      body: disclosure({ network: ctx.network }),
    })}</section>
  </div>`;
}

export function render(root) {
  root.innerHTML = renderPage(pageContext());
}

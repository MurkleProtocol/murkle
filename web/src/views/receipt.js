/**
 * /tx/:txid Proof Receipt (visual.md section 9, Proof X-ray). Verification
 * auto-runs on open: the raw transaction comes straight from mempool.space, every check runs
 * in this browser, and every row names what it still trusts (BTC / YOU / IDX). The headline
 * never says "verified" without naming where the anchor root came from.
 */
import "../verify/verify.css";
import * as api from "../api.js";
import { html, on, toNode } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { prov } from "../ui/prov.js";
import { int, sats, short, hash, heightText, date, units, ms as fmtMs, bytes as fmtBytes, plural, DASH } from "../ui/format.js";
import { sealBlock, sealEmblem, stamp } from "../ui/seal.js";
import { transcript, TranscriptView, copyText as transcriptText } from "../ui/transcript.js";
import { hexmap } from "../ui/hexmap.js";
import { redact, revealed, viewToggle } from "../ui/redact.js";
import { button, opBadge, tag, kv } from "../ui/components.js";
import { mountLattice } from "../ui/lattice.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import { openSheet } from "../ui/sheet.js";
import { setTitle } from "../router.js";
import { BRAND, EXPLORER } from "../config.js";
import { verifyInBrowser, planSteps, leafIndexOf } from "../verify/engine.js";
import { assetById, commitmentsAll } from "../verify/pool-data.js";
import { mySession, myView } from "../verify/my-view.js";
import { receiptCard, download, toBlob } from "../verify/share-card.js";
import { INDEXER_HREF } from "../ui/indexer.js";
import { amountHTML, zpHTML } from "./app-shared.js";
import { onStreamerChange } from "../session.js";

const TXID = /^[0-9a-f]{64}$/;
const OP_LABEL = { TRANSFER: "private transfer", MINT: "mint", MINT_SCRIPT: "mint", DEPLOY: "token launch", ATTEST: "attestation" };
const fieldHex = (v) => BigInt(v).toString(16).padStart(64, "0");
const PRIVACY_NOTE = "Looking up a txid tells mempool.space that your IP address is interested in it. For your own transactions, use Verify the Pool (whole blocks) or Tor.";
// The mint's next move isn't something a counterparty sees, so not the default amount tip.
const NEXT_TIP = "Not readable on Bitcoin. Only the owner knows what they do with it next.";

export function render(root, params) {
  const txid = String(params.txid ?? "").trim().toLowerCase();
  if (!TXID.test(txid)) return badTxid(root, params.txid);
  setTitle(`Proof receipt ${short(txid)}`);

  root.innerHTML = html`<div class="container section xr">
    <section class="panel panel--certified xr-hero" aria-labelledby="xr-h">
      <div class="xr-lattice" aria-hidden="true"></div>
      <div class="xr-hero-in">
        <div class="xr-copy">
          <div class="eyebrow">PROOF RECEIPT · <span data-op>CHECKING</span></div>
          <h1 class="receipt-hero" id="xr-h" data-headline>Checking proof…</h1>
          <p class="lead xr-sub" data-sub>Your browser is fetching this transaction from mempool.space and checking it, step by step.</p>
          <p class="mono xr-txid">tx ${hash(txid, { head: 10, tail: 10, label: "Copy txid" })}</p>
          <div class="xr-seal" data-seal>${sealSkeleton()}</div>
          <div class="cluster xr-actions">
            ${button({ label: "Re-run", kind: "secondary", size: "sm", icon: "refresh", action: "xr-rerun" })}
            ${button({ label: "Copy link", kind: "ghost", size: "sm", icon: "link", action: "xr-link" })}
            ${button({ label: "Share image", kind: "ghost", size: "sm", icon: "share", action: "xr-share" })}
            ${button({ label: "mempool.space", kind: "ghost", size: "sm", iconRight: "external", href: `${EXPLORER}/tx/${txid}` })}
          </div>
        </div>
        <div class="xr-emblem" data-emblem>${sealEmblem({ state: "mempool" }, { size: 200, ring: "CHECKING · RAW BITCOIN DATA · MEMPOOL.SPACE" })}</div>
      </div>
    </section>

    <section class="xr-sec" id="transcript" aria-labelledby="xr-tr">
      <div class="xr-sec-head"><h2 class="h2-app" id="xr-tr">Verification transcript</h2><span class="caption t-3">Every row ran just now, in this tab.</span></div>
      <div data-transcript>${transcript(rows(planSteps("TRANSFER")), { title: null })}</div>
      <p class="caption t-3 xr-note">${icon("eye", { size: 14 })} ${PRIVACY_NOTE}</p>
    </section>

    <div data-after hidden>
      <section class="xr-sec" data-anatomy aria-label="Envelope anatomy"></section>
      <section class="xr-sec" data-reveals aria-label="What this transaction reveals"></section>
      <div class="grid-2 xr-sec">
        <section data-inputs aria-label="Public inputs"></section>
        <section data-bitcoin aria-label="Bitcoin"></section>
      </div>
      <section class="xr-sec" data-compare aria-label="Indexer vs your browser"></section>
    </div>
  </div>`;

  const $ = (s) => root.querySelector(s);
  const lattice = mountLattice($(".xr-lattice"));
  let latticeTotal = null;
  const tv = new TranscriptView($("[data-transcript] .transcript"));
  let result = null;
  let runSeq = 0;
  let viewMode = "observer";
  let mine = null;
  let display = null; // esplora JSON, display only
  let alive = true;

  async function run() {
    const my = ++runSeq;
    result = null;
    mine = null;
    $("[data-after]").hidden = true;
    paintHero({ running: true });
    tv.set(rows(planSteps("TRANSFER")));
    const res = await verifyInBrowser(txid, {
      onPlan: (opName) => {
        if (my !== runSeq) return;
        const done = new Map(tv.rows.map((r) => [r.id, r]));
        tv.set(rows(planSteps(opName)).map((r) => done.get(r.id) ?? r));
        $("[data-op]").textContent = opText(opName);
      },
      onStep: (s) => {
        if (my !== runSeq) return;
        const patch = { status: s.status, prov: s.source, label: s.label, detail: s.detail ?? "", ms: s.ms };
        if (tv.rows.some((r) => r.id === s.id)) tv.update(s.id, patch);
        else tv.set([...tv.rows, { id: s.id, ...patch }]);
        if (s.id === "status" && s.status === "ok") paintHero({ running: true, partial: s });
      },
    }).catch((e) => ({ verdict: "failed", steps: [], error: e }));
    if (my !== runSeq || !alive) return;
    result = res;
    if (res.error) {
      toast({ kind: "danger", title: "Verification stopped.", body: `${res.error.message} Try Re-run.` });
      paintHero({ error: res.error });
      return;
    }
    mine = res.env ? myView(res.env, txid) : null;
    // Show exactly the rows that ran (a non-protocol tx has no proof rows), once the
    // staggered reveal has caught up.
    await tv.queue;
    if (my !== runSeq || !alive) return;
    tv.set(res.steps.map((s) => ({ id: s.id, label: s.label, prov: s.source, status: s.status, detail: s.detail ?? "", ms: s.ms })));
    paintHero({});
    await paintAfter(res);
  }

  function paintHero({ running = false, partial = null, error = null }) {
    const r = result;
    const headline = $("[data-headline]");
    const sub = $("[data-sub]");
    if (running) {
      headline.textContent = "Checking proof…";
      if (partial) {
        $("[data-emblem]").innerHTML = sealEmblem({ state: "mined", height: null }, { size: 200, ring: "CHECKING · RAW BITCOIN DATA · MEMPOOL.SPACE" });
      }
      $("[data-seal]").innerHTML = sealSkeleton();
      return;
    }
    if (error || !r) {
      headline.textContent = "Couldn't finish.";
      sub.textContent = `${error?.message ?? "Something went wrong"}. Run it again.`;
      return;
    }
    $("[data-op]").textContent = opText(r.opName);
    const T = heroText(r);
    headline.textContent = T[0];
    // Escaped text, or trusted markup (the mismatch line links to the indexer switch).
    sub.innerHTML = html`${T[1]}`;
    const seal = sealFor(r);
    $("[data-seal]").innerHTML = seal ? sealBlock(seal) : "";
    if (!seal) {
      const ring = r.verdict === "not-protocol" ? "NOT A PROTOCOL TRANSACTION · NOTHING TO VERIFY" : "NO DATA · CHECK THE TXID";
      $("[data-emblem]").innerHTML = sealEmblem(r.status?.confirmed ? { state: "mined", height: r.status.height } : { state: "dropped" }, { size: 200, ring });
    } else {
      $("[data-emblem]").innerHTML = sealEmblem(seal, { size: 200, proof: r.env?.proof ?? null, op: r.opName === "TRANSFER" ? "TRANSACT" : (r.opName ?? "TX") });
      if (seal.state === "verified") stamp($("[data-emblem] .seal-emblem"));
    }
  }

  async function paintAfter(r) {
    $("[data-after]").hidden = !r.payload;
    if (!r.payload) return;
    $("[data-anatomy]").innerHTML = html`<div class="panel">
      <header class="panel-head"><div class="panel-titles"><div class="eyebrow">ENVELOPE ANATOMY ${prov("BTC")}</div><h3 class="h3">Every byte this transaction wrote to Bitcoin</h3></div></header>
      ${hexmap(r.payload, { carrierVsize: r.sizes?.vsize ?? null })}
      <p class="caption t-3 xr-note">Read from the OP_RETURN output of the raw transaction. Hatched cells are encrypted: public, but only the recipient's view key opens them.</p>
    </div>`;
    paintReveals();
    paintInputs(r);
    paintCompare(r);
    $("[data-bitcoin]").innerHTML = bitcoinPanel(r, null);
    try {
      display = await api.esplora.tx(txid);
    } catch {
      display = null;
    }
    if (!alive || r !== result) return;
    $("[data-bitcoin]").innerHTML = bitcoinPanel(r, display);
    paintReveals();
    // Fill in the anonymity set and leaf indexes from the bulk commitment list.
    try {
      const { rows: comms, outputs } = await commitmentsAll();
      if (r.env?.anchor != null) latticeTotal = comms.filter(([, h]) => h <= r.env.anchor).length;
      lattice.update(outputs);
      if (!alive || r !== result) return;
      paintReveals();
      paintInputs(r, true);
    } catch {
      // The indexer is optional for this page: everything above came from Bitcoin data.
    }
  }

  function paintReveals() {
    const r = result;
    if (!r?.payload) return;
    const op = r.opName;
    const hasMine = Boolean(mine);
    const showMine = hasMine && viewMode === "mine";
    let pub = [];
    let hidden = [];
    const fee = display?.fee != null ? sats(display.fee) : DASH;
    const payer = display?.vin?.[0]?.prevout?.scriptpubkey_address ?? null;
    const when = r.status?.confirmed ? `${heightText(r.status.height)}${r.status.time ? ` · ${date(r.status.time * 1000)}` : ""}` : "In the mempool";
    if (op === "TRANSFER") {
      pub = [
        ["Operation", html`${opBadge("TRANSFER")} private transfer`],
        ["Block and time", html`<span class="mono">${when}</span>`],
        ["Envelope", `${int(r.payload.length)} bytes in a ${int(r.sizes?.vsize)} vB transaction`],
        ["Bitcoin fee", html`<span class="mono">${fee}</span>`],
        ["Paid by", payer ? html`${hash(payer, { head: 8, tail: 6, label: "Copy address" })}` : DASH],
        ["Spend tags", "2 nullifiers: some notes were spent, not which ones"],
        ["New notes", "2 commitments: sealed, they reveal nothing"],
        ["Hides among", latticeTotal != null ? html`up to <span class="mono">${int(latticeTotal)}</span> notes in the pool at the anchor ${prov("IDX")}` : DASH],
      ];
      hidden = showMine
        ? myTransferRows(mine)
        : [
            ["Token", redact("token")],
            ["Amount", redact("amount")],
            // The proof hides the sender's shielded address; "Paid by" above, the anchor and the
            // timing can still point to who sent it (privacy-trace-test.md L1, L3).
            ["Sender's shielded address", redact("sender")],
            ["Recipient", redact("recipient")],
            ["Which notes were spent", redact("spent")],
          ];
    } else if (op === "MINT" || op === "MINT_SCRIPT") {
      const t = r.terms;
      pub = [
        ["Operation", html`${opBadge("MINT")} mint`],
        ["Token", t ? html`<span class="ticker">${t.ticker}</span>` : DASH],
        ["Amount", t ? html`<span class="mono">${units(r.env.publicAmount, t.divisibility)}</span>` : DASH],
        ["Treasury payment", r.treasuryPaid != null ? html`<span class="mono t-btc">${sats(r.treasuryPaid)}</span>` : DASH],
        ["Paid by", payer ? hash(payer, { head: 8, tail: 6, label: "Copy address" }) : DASH],
        ["Bitcoin fee", html`<span class="mono">${fee}</span>`],
        ["Block and time", html`<span class="mono">${when}</span>`],
      ];
      const recv = mine?.outputs ?? [];
      hidden = [
        ["Shielded address that receives the note", showMine && recv.length ? revealed("you", { source: "received" }) : redact("recipient")],
        ["What the owner does with it next", redact("amount", { tip: NEXT_TIP })],
      ];
    } else if (op === "DEPLOY") {
      const d = r.env;
      pub = [
        ["Operation", html`${opBadge("DEPLOY")} token launch`],
        ["Ticker", html`<span class="ticker">${d.ticker}</span>`],
        ["Per mint", html`<span class="mono">${units(d.mintAmount, d.divisibility)}</span>`],
        ["Mint cap", html`<span class="mono">${int(d.mintCap)}</span>`],
        ["Price", html`<span class="mono t-btc">${sats(d.priceSats)}</span>`],
        ["Window", d.startHeight || d.endHeight ? `${d.startHeight ? heightText(d.startHeight) : "now"} to ${d.endHeight ? heightText(d.endHeight) : "open"}` : "Open now, no end"],
        ["Launched by", payer ? hash(payer, { head: 8, tail: 6, label: "Copy address" }) : DASH],
      ];
    } else if (op === "ATTEST") {
      pub = [
        ["Operation", html`${opBadge("ATTEST")} attestation`],
        ["Kind", r.env.kind === 1 ? "genesis" : r.env.kind === 2 ? "checkpoint (reserved)" : "release (reserved)"],
        ["Hash", hash(Array.from(r.env.hash, (b) => b.toString(16).padStart(2, "0")).join(""), { label: "Copy hash" })],
        ["Posted by", payer ? hash(payer, { head: 8, tail: 6, label: "Copy address" }) : DASH],
      ];
    }
    const nothing =
      op === "DEPLOY"
        ? "Nothing. A launch is public by design: everyone must be able to check the terms."
        : op === "ATTEST"
          ? "Nothing. An attestation is a public statement; it never changes the pool."
          : null;
    $("[data-reveals]").innerHTML = html`<div class="panel panel--certified">
      <header class="panel-head">
        <div class="panel-titles"><div class="eyebrow">WHAT THIS TRANSACTION REVEALS</div><h3 class="h3">${op === "TRANSFER" ? "The proof is public. The payment is not." : "Public on Bitcoin, by design."}</h3></div>
        ${hasMine ? html`<div class="panel-actions">${viewToggle({ mine: showMine, name: "xr-view" })}</div>` : ""}
      </header>
      <div class="disc-cols">
        <div class="disc-col disc-col--public"><div class="disc-h">${icon("block", { size: 16 })}Public on Bitcoin ${prov("BTC")}</div>${kv(pub, { compact: true })}</div>
        <div class="disc-col disc-col--hidden"><div class="disc-h">${icon("proof", { size: 16 })}Hidden by proof</div>${nothing ? html`<p class="small t-2">${nothing}</p>` : kv(hidden, { compact: true })}</div>
      </div>
      ${showMine ? html`<p class="caption t-3 xr-note">${icon("lock", { size: 14 })} Shown only in this browser, from your unlocked wallet. Nothing was sent anywhere.</p>` : ""}
      ${op === "MINT" || op === "MINT_SCRIPT" ? html`<p class="caption t-3 xr-note">Mints are always paid from a Bitcoin address, so a mint is linked to it. Later private transfers aren't, unless that address pays their fees too.</p>` : ""}
    </div>`;
    enrichMine();
  }

  // Tickers and decimals for "My view" rows (decrypted assets are ids).
  async function enrichMine() {
    if (!mine || mine.enriched) return;
    mine.enriched = true;
    for (const n of [...mine.outputs, ...mine.spent]) {
      const a = await assetById(n.asset).catch(() => null);
      n.ticker = a?.ticker ?? `asset ${n.asset}`;
      n.div = a?.divisibility ?? 0;
    }
    if (alive) paintReveals();
  }

  function paintInputs(r, withLeaves = false) {
    const env = r.env;
    if (!env?.nullifiers) {
      $("[data-inputs]").innerHTML = html`<div class="panel"><header class="panel-head"><div class="panel-titles"><div class="eyebrow">PUBLIC INPUTS</div><h3 class="h3">No proof in this operation</h3></div></header><p class="small t-2">${r.opName === "DEPLOY" ? "A launch writes its terms in the clear; replayers check them directly." : "An attestation is a 32-byte statement; replayers log it and never change the pool for it."}</p></div>`;
      return;
    }
    const h = r.status?.confirmed ? r.status.height : null;
    const anchorAge = h !== null ? ` · ${plural(h - env.anchor, "block")} before inclusion · window 100` : "";
    const rootStep = r.steps.find((s) => s.id === "root");
    const leaf = (i) => (withLeaves ? html`<span class="caption t-3" data-leaf="${i}"></span>` : "");
    $("[data-inputs]").innerHTML = html`<div class="panel">
      <header class="panel-head"><div class="panel-titles"><div class="eyebrow">PUBLIC INPUTS ${prov("YOU")}</div><h3 class="h3">What the proof is checked against</h3></div></header>
      ${kv([
        ["Anchor", html`<span class="mono">${heightText(env.anchor)}</span><span class="caption t-3">${anchorAge}</span>`],
        ["Anchor root", r.root != null ? html`${hash(fieldHex(r.root), { label: "Copy root" })} ${rootStep ? prov(rootStep.source) : ""}` : DASH],
        ["extDataHash", hash(fieldHex(env.extDataHash), { label: "Copy extDataHash" })],
        ...env.nullifiers.map((n, i) => [`Nullifier ${i}`, hash(fieldHex(n), { href: `/nullifier/${fieldHex(n)}`, label: "Copy nullifier" })]),
        ...env.commitments.map((c, i) => [`Commitment ${i}`, html`${hash(fieldHex(c), { href: `/commitment/${fieldHex(c)}`, label: "Copy commitment" })}${leaf(i)}`]),
        ...(env.publicAmount !== 0n ? [["Public amount", html`<span class="mono">${int(env.publicAmount)}</span>`], ["Public asset", html`<span class="mono">${env.publicAsset.toString()}</span>`]] : []),
      ])}
    </div>`;
    if (withLeaves) {
      env.commitments.forEach(async (c, i) => {
        const hit = await leafIndexOf(c).catch(() => null);
        const el = root.querySelector(`[data-leaf="${i}"]`);
        if (el) el.textContent = hit ? ` · leaf ${int(hit.leafIndex)}` : r.indexer?.ok ? "" : " · not in the pool";
      });
    }
  }

  function bitcoinPanel(r, d) {
    const vsize = d?.weight ? Math.ceil(d.weight / 4) : r.sizes?.vsize;
    const rate = d?.fee != null && vsize ? (d.fee / vsize).toFixed(1) : null;
    const payer = d?.vin?.[0]?.prevout?.scriptpubkey_address ?? null;
    return html`<div class="panel">
      <header class="panel-head"><div class="panel-titles"><div class="eyebrow">BITCOIN ${prov("BTC")}</div><h3 class="h3">The carrier transaction</h3></div></header>
      ${kv([
        ["Status", r.status?.confirmed ? html`<span class="mono t-btc">${heightText(r.status.height)}</span> · ${r.status.confirmations != null ? plural(r.status.confirmations, "confirmation") : "mined"}` : r.status ? "In the mempool" : DASH],
        ["Position in block", r.position != null ? html`<span class="mono">${int(r.position)}</span>` : DASH],
        ["Size", html`<span class="mono">${fmtBytes(r.sizes?.size)} · ${int(vsize)} vB</span>`],
        ["Fee", d?.fee != null ? html`<span class="mono">${sats(d.fee)}${rate ? ` · ${rate} sat/vB` : ""}</span>` : DASH],
        ["Paid by", payer ? html`${hash(payer, { head: 8, tail: 6, label: "Copy address" })}<span class="caption t-3 xr-block">This is the only identity this transaction reveals.</span>` : DASH],
        ["Block", r.status?.hash ? hash(r.status.hash, { head: 8, tail: 8, label: "Copy block hash" }) : DASH],
      ])}
      <p class="caption t-3 xr-note">Fee and payer come from mempool.space's transaction view, for display; the checks above use only the raw bytes.</p>
    </div>`;
  }

  function paintCompare(r) {
    const v = r.indexer;
    $("[data-compare]").innerHTML = html`<div class="panel">
      <header class="panel-head"><div class="panel-titles"><div class="eyebrow">INDEXER VS YOUR BROWSER</div><h3 class="h3">Does our indexer say the same?</h3></div></header>
      ${compareBody(r)}
      ${v ? html`<p class="caption t-3 xr-note">Indexer log entry #${int(v.seq)}: ${v.ok ? "accepted" : `rejected, ${v.reason}`} ${prov("IDX")} · found by downloading the whole public log and filtering it here. The checks on this page ask our indexer nothing about this transaction; opening a /tx/ link directly does send its address to the server.</p>` : ""}
    </div>`;
  }

  async function share() {
    const r = result;
    if (!r?.payload) return toast({ kind: "info", title: "Nothing to share yet.", body: "Wait for the checks to finish, then try again." });
    const yours = Boolean(mine);
    const s = openSheet({
      eyebrow: "SHARE",
      title: "Share this receipt",
      body: html`<div class="stack">
        <div class="xr-share-preview" data-preview><span class="skel" style="width:100%;height:100%"></span></div>
        <p class="small ${yours ? "t-warn" : "t-2"}">${icon("warn", { size: 14 })} A receipt hides amounts, but sharing it tells people this transaction is yours.</p>
        <p class="caption t-3">The image shows what any chain observer sees: no token, amount or address hidden by the proof, and nothing from your wallet.</p>
      </div>`,
      actions: html`${button({ label: "Copy link", kind: "secondary", action: "xr-share-link", icon: "link" })}${button({ label: "Download PNG", kind: "neutral", action: "xr-share-png", icon: "download" })}`,
    });
    let card = null;
    try {
      card = await receiptCard({
        opName: r.opName,
        verdict: r.verdict,
        fault: r.steps.find((x) => x.status === "fail")?.fault ?? null,
        rootSource: r.steps.find((x) => x.id === "root")?.status === "ok" ? (r.rootSource ?? null) : null,
        pinned: r.attest?.pinned ?? null,
        height: r.status?.confirmed ? r.status.height : null,
        txid,
        proof: r.env?.proof ?? null,
        ticker: r.terms?.ticker ?? null,
        amount: r.terms ? units(r.env.publicAmount, r.terms.divisibility) : null,
        proofMs: r.proofMs ?? null,
        brand: BRAND,
      });
      const url = URL.createObjectURL(await toBlob(card));
      const img = toNode(html`<img alt="Receipt image preview" width="1200" height="630">`);
      img.src = url;
      s.el.querySelector("[data-preview]")?.replaceChildren(img);
    } catch {
      s.el.querySelector("[data-preview]")?.replaceChildren(toNode(html`<p class="caption t-3">The preview couldn't be drawn in this browser.</p>`));
    }
    s.el.addEventListener("click", async (e) => {
      if (e.target.closest("[data-action=xr-share-png]") && card) await download(card, `${BRAND.toLowerCase()}-receipt-${txid.slice(0, 8)}.png`);
      if (e.target.closest("[data-action=xr-share-link]")) copyLink();
    });
  }

  async function copyLink() {
    const url = `${location.origin}/tx/${txid}`;
    const text = result?.opName === "TRANSFER" ? `Can you find the amount? ${url}` : url;
    const ok = await copyText(text);
    toast({ kind: ok ? "success" : "warn", title: ok ? "Link copied." : "Couldn't copy.", body: ok ? "The link contains only the txid." : "Copy it from the address bar instead." });
  }

  const offs = [
    on(root, "click", "[data-action=xr-rerun], [data-action=transcript-rerun], .seal-block [data-action=verify]", (e) => {
      e.preventDefault();
      run();
    }),
    on(root, "click", "[data-action=xr-link]", () => copyLink()),
    on(root, "click", "[data-action=xr-share]", () => share()),
    on(root, "click", ".seal-block [data-action=transcript]", (e) => {
      if (e.target.closest("[data-action=verify]")) return;
      $("#transcript").scrollIntoView({ behavior: "smooth", block: "start" });
    }),
    on(root, "click", "[data-action=transcript-copy]", async () => {
      const ok = await copyText(transcriptText(tv.rows, { title: `${BRAND} proof receipt · tx ${txid}` }));
      toast({ kind: ok ? "success" : "warn", title: ok ? "Transcript copied." : "Couldn't copy the transcript." });
    }),
    on(root, "seg-change", "[data-seg]", (e) => {
      if (e.detail?.name !== "xr-view") return;
      viewMode = e.detail.value;
      paintReveals();
    }),
    // Streamer mode toggled from the header: "My view" masks or unmasks at once.
    onStreamerChange(() => alive && paintReveals()),
  ];

  run();
  return () => {
    alive = false;
    runSeq++;
    lattice.destroy();
    offs.forEach((off) => off());
  };
}

/* ---------- helpers ---------- */

function rows(plan) {
  return plan.map((s) => ({ id: s.id, label: s.label, prov: s.source, status: "pending", detail: "", ms: null }));
}

function opText(opName) {
  return { TRANSFER: "TRANSFER", MINT: "MINT", MINT_SCRIPT: "MINT", DEPLOY: "LAUNCH", ATTEST: "ATTESTATION" }[opName] ?? "TRANSACTION";
}

/**
 * "My view" rows of a transfer, from the wallet's own data. Streamer mode masks every amount
 * and address, as on the wallet screens. Exported for tests.
 */
export function myTransferRows(mine) {
  const notesText = (list) => html`${list.map((n, i) => html`${i ? " + " : ""}${amountHTML(n.amount, n.div ?? 0, n.ticker ?? null)}`)}`;
  const recv = mine?.outputs ?? [];
  const spentMine = mine?.spent ?? [];
  const hist = mine?.history?.kind === "send" ? mine.history : null;
  // A sender can't decrypt the recipient's output; outputs it can open are its change.
  const iSent = spentMine.length > 0 || Boolean(hist);
  const histAmount = hist?.amount != null ? amountHTML(hist.amount, hist.div ?? 0, hist.ticker ?? null) : null;
  return iSent
    ? [
        ["Token", hist?.ticker ? revealed(hist.ticker, { source: "sent" }) : spentMine[0]?.ticker ? revealed(spentMine[0].ticker, { source: "local" }) : redact("token")],
        ["Amount", histAmount ? revealed(histAmount, { source: "sent" }) : redact("amount")],
        ["Sender", revealed("you", { source: "local" })],
        ["Recipient", hist?.to ? revealed(zpHTML(hist.to, { copy: false }), { source: "sent" }) : redact("recipient")],
        ["Which notes were spent", spentMine.length ? revealed(html`${plural(spentMine.length, "note")} of yours: ${notesText(spentMine)}`, { source: "local" }) : redact("spent")],
        ...(recv.length ? [["Change back to you", revealed(notesText(recv), { source: "received" })]] : []),
      ]
    : [
        ["Token", recv[0]?.ticker ? revealed(recv[0].ticker, { source: "received" }) : redact("token")],
        ["Amount", revealed(notesText(recv), { source: "received" })],
        ["Sender's shielded address", redact("sender")],
        ["Recipient", revealed("you", { source: "received" })],
        ["Which notes were spent", redact("spent")],
      ];
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const POOL_HREF = "/verify#pool";
const PROOF_ROWS = new Set(["extdata", "points", "vkey", "root", "groth16"]);

/** [headline, sub] for a finished result; sub is text, or Safe markup with a link. Exported for tests. */
export function heroText(r) {
  const failed = r.steps.find((s) => s.status === "fail");
  const h = r.status?.height;
  const where = r.status?.confirmed ? `mined in ${heightText(h)}` : "in the mempool";
  const what = OP_LABEL[r.opName] ?? "protocol transaction";
  const root = rootPhrase(r);
  const otherManifest = r.attest?.pinned === false ? " It names a manifest other than the one pinned in this build, so it carries no authority." : "";
  // A rule this browser saw broken is a result; missing or bad input data is not.
  const failedHead = !failed
    ? "Proof failed."
    : failed.fault === "rule"
      ? PROOF_ROWS.has(failed.id) ? "Proof failed." : "Breaks a protocol rule."
      : failed.source === "BTC" || failed.id === "txid" ? "Bitcoin data failed a check." : "Couldn't finish the check.";
  return {
    verified: [
      r.opName === "DEPLOY" ? "Terms checked." : r.opName === "ATTEST" ? "Attestation checked." : "Proof verified.",
      r.proofMs != null
        ? `${cap(what)} ${where}. Verified in this browser in ${fmtMs(r.proofMs)}, against ${root}.`
        : r.opName === "DEPLOY"
          ? `Token launch ${where}. Checked in this browser. A launch carries no proof: its terms are public by design.`
          : `Attestation ${where}. Checked in this browser. An attestation carries no proof: it is a public statement and never changes the pool.${otherManifest}`,
    ],
    mempool: ["In the mempool.", `${r.proofMs != null ? `Proof verified in this browser in ${fmtMs(r.proofMs)}, against ${root}. ` : ""}Inclusion and the indexer's verdict wait for a block.`],
    rejected: ["Rejected by indexer.", `${r.indexer?.reason ? cap(r.indexer.reason) + ". " : ""}Your browser's checks passed; that rule depends on pool history, so the indexer's verdict stands.`],
    mismatch: ["Indexer disagrees.", html`Your browser and our indexer reached different verdicts on this transaction. Do not trust this indexer: <a href="${INDEXER_HREF}" data-link>switch to your own</a>.`],
    "not-protocol": ["Not a protocol transaction.", `This Bitcoin transaction carries no ${BRAND} envelope, so there is nothing to verify.`],
    "not-found": ["Transaction not found.", failed?.detail ?? "mempool.space doesn't know this txid."],
    failed: r.untrustedRootFail
      ? ["Doesn't verify against the indexer's root.", html`The proof was checked only against an anchor root our indexer supplied, and it fails there. That root is the indexer's word: <a href="${POOL_HREF}" data-link>Verify the Pool</a> to rebuild the roots from Bitcoin yourself, then check again.`]
      : [failedHead, failed ? `${failed.label}: ${failed.detail}` : "A check failed."],
  }[r.verdict] ?? ["Checked.", ""];
}

/** What the indexer alone vouches for when no replay of the user's own judged the transaction. */
const HISTORY_PART = {
  TRANSFER: "Spent notes rest",
  MINT: "Spent notes and the mint cap rest",
  MINT_SCRIPT: "Spent notes and the mint cap rest",
  DEPLOY: "The free-ticker rule rests",
};

/** The "Does our indexer say the same?" body. Exported for tests. */
export function compareBody(r) {
  const step = r.steps.find((s) => s.id === "indexer");
  if (r.verdict === "mismatch") return html`${sealBlock({ state: "mismatch" })}<p class="small t-2 xr-note">${step?.detail ?? ""}</p>`;
  // A history rejection is the indexer's word alone: this browser neither confirmed nor refuted it.
  if (r.verdict === "rejected") {
    return html`<p class="xr-agree xr-agree--idx">${icon("info", { size: 16 })}<span>The indexer's verdict rests on pool history your browser can't see.</span> ${prov("IDX")}</p><p class="small t-2">${step?.detail ?? ""}</p>`;
  }
  if (step?.status === "ok") {
    // The history rules (spent nullifiers, mint cap, a free ticker) were never checked here
    // unless the user's own replay judged this transaction: they stay the indexer's word.
    if (r.historyFrom === "IDX") {
      return html`<p class="xr-agree">${icon("check", { size: 16 })}<span>Agrees on every rule your browser checked.</span> ${prov("YOU")}</p><p class="xr-agree xr-agree--idx">${icon("info", { size: 16 })}<span>${HISTORY_PART[r.opName] ?? "The pool-history rules rest"} on the indexer's log.</span> ${prov("IDX")}</p><p class="small t-2">${step.detail}</p>`;
    }
    return html`<p class="xr-agree">${icon("check", { size: 16 })}<span>They agree.</span> ${prov("YOU")}</p><p class="small t-2">${step.detail}</p>`;
  }
  return html`<p class="small t-2">${step?.detail ?? "No verdict to compare yet."}</p>`;
}

function rootPhrase(r) {
  const s = r.steps.find((x) => x.id === "root");
  if (!s || s.status !== "ok") return "an anchor root";
  if (r.rootSource === "replay") return "an anchor root from your own replay";
  if (r.rootSource === "rebuild") return "an anchor root rebuilt here from our indexer's commitments";
  return "an anchor root reported by our indexer";
}

function sealSkeleton() {
  return html`<div class="seal-block xr-seal-skel" aria-hidden="true"><div class="sb-cell"><span class="skel" style="width:60%;height:10px"></span><span class="skel" style="width:80%;height:14px"></span></div><div class="sb-cell"><span class="skel" style="width:60%;height:10px"></span><span class="skel" style="width:80%;height:14px"></span></div></div>`;
}

export function sealFor(r) {
  if (!r.status || r.verdict === "not-protocol" || r.verdict === "not-found") return null;
  const base = { height: r.status.height, confirmations: r.status.confirmations ?? null, vsize: r.sizes?.vsize ?? null };
  if (!r.status.confirmed) return { state: "mempool", vsize: base.vsize };
  if (r.verdict === "mismatch") return { state: "mismatch", ...base };
  if (r.verdict === "verified") return { state: "verified", ...base, ms: r.proofMs ?? null, deploy: r.proofMs == null };
  if (r.verdict === "rejected") return { state: "rejected", ...base, reason: r.indexer?.reason ?? null };
  const failed = r.steps.find((s) => s.status === "fail");
  // The checks couldn't finish: show the indexer's claim as its own, not as a browser result.
  if (failed?.fault === "data") {
    if (r.indexer?.ok) return { state: "accepted", ...base };
    if (r.indexer) return { state: "rejected", ...base, reason: r.indexer.reason ?? null };
    return { state: "mined", ...base };
  }
  return { state: "rejected", ...base, reason: failed ? `Failed in this browser: ${failed.label.toLowerCase()}` : "Failed in this browser" };
}

function badTxid(root, value) {
  root.innerHTML = html`<div class="container section"><section class="panel panel--certified placeholder" role="alert">
    <div class="eyebrow">PROOF RECEIPT</div>
    <h1 class="h1-app">That isn't a txid.</h1>
    <p>A Bitcoin transaction id is 64 hexadecimal characters. Check the link, or paste the txid into the box on the Verify page.</p>
    <p class="mono caption t-3">${String(value ?? "").slice(0, 80)}</p>
    ${button({ label: "Go to Verify", href: "/verify", kind: "secondary" })}
  </section></div>`;
}

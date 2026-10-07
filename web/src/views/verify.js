/**
 * /verify (visual.md section 9).
 *   A  Check one transaction, nullifier or commitment (the receipt engine).
 *   B  Verify the Pool: replay every block since activation from mempool.space in a Worker,
 *      check every proof, then compare the pool digest with our indexer's.
 *   C  Artifact fingerprints, recomputed in this browser and compared with the pins.
 *   D  Run your own indexer.
 *   E  Switch this site to another indexer (a browser setting, no wallet needed).
 * Copy follows docs/CLAIMS.md: Bitcoin stores and orders the data; replayers verify it.
 * The A-8 and A-9 copy is per network and comes from verifyCopy() in ./security.js, so both
 * pages say the same thing (docs/design/mainnet-readiness.md §6.7).
 */
import "../verify/verify.css";
import * as api from "../api.js";
import { html, on } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { prov } from "../ui/prov.js";
import { int, hash, heightText, bytes as fmtBytes, ms as fmtMs, short, DASH } from "../ui/format.js";
import { button, field, panel, progress, statTile, tag } from "../ui/components.js";
import { runCommands, testIndexer, switchIndexer } from "../ui/indexer.js";
import { sealPill } from "../ui/seal.js";
import { toast } from "../ui/toast.js";
import { copyText } from "../ui/behaviors.js";
import { resolveSearch } from "../ui/search.js";
import { navigate } from "../router.js";
import { getWalletStatus } from "../ui/status.js";
import facts from "../facts.json";
import { ADDRESS_HRP, BRAND, GENESIS_TXID, ACTIVATION_HEIGHT, MANIFEST_SHA256, PRE_GENESIS, REPO_URL } from "../config.js";
import { ARTIFACT_LIST, fingerprint } from "../verify/artifacts.js";
import { replayPlan, PoolReplay, compareReplay, resetReplay, loadReplay } from "../verify/replay.js";
import { logAll } from "../verify/pool-data.js";
import { poolCard, poolCardText, download } from "../verify/share-card.js";
import { verifyCopy } from "./security.js";

const COPY = verifyCopy();

/** The replay's stop message for a header error (code from src/btc/headers.mjs), else null. */
function headerStopText(err) {
  const code = err?.code ?? null;
  if (code === "less-work") return "The data source served a chain with less work than the one your replay already verified. Your replay kept its chain and stopped; try again later or use your own indexer.";
  if (code === "time-too-new") return "A block header is dated more than two hours ahead of this computer's clock. That clears on its own: resume in a few minutes, and check your clock.";
  if (code === "source") return `The data source failed while serving block headers: ${err.message}. Resume to try again.`;
  if (["data", "linkage", "pow", "bits-range", "bad-diffbits", "time-too-old", "bad-version", "checkpoint", "conflict", "below-base"].includes(code)) {
    return `A block header failed verification (${code}): ${err.message}. The data source served data that is not a valid chain from the pinned checkpoint, so nothing after it was applied.`;
  }
  return null;
}

const PRIVACY_NOTE = "Looking up a txid tells mempool.space that your IP address is interested in it. For your own transactions, use Verify the Pool (whole blocks) or Tor.";

export function render(root) {
  root.innerHTML = html`<div class="container section vf">
    <header class="page-head vf-head">
      <div>
        <div class="eyebrow">VERIFY</div>
        <h1 class="receipt-hero">Don't trust. <em>Verify.</em></h1>
        <p class="lead">Don't trust our website: replay the whole pool from raw Bitcoin blocks in your browser, or with one command. Every proof lives on Bitcoin; your browser checks every one.</p>
      </div>
      <nav class="vf-jump cluster cluster--l" aria-label="On this page">
        <a href="#lookup" data-link>One transaction</a><a href="#pool" data-link>Whole pool</a><a href="#artifacts" data-link>Artifacts</a><a href="#run" data-link>Your own indexer</a><a href="#indexer" data-link>Switch indexer</a>
      </nav>
    </header>

    <section id="lookup" class="vf-sec">${lookupPanel()}</section>
    <section id="pool" class="vf-sec" data-pool>${poolPanel()}</section>
    <section id="artifacts" class="vf-sec" data-artifacts>${artifactsPanel()}</section>
    <section id="run" class="vf-sec">${runPanel()}</section>
    <section id="indexer" class="vf-sec" data-vf-indexer>${indexerPanel()}</section>
    <section class="vf-sec">${limitsPanel()}</section>
  </div>`;

  const $ = (s) => root.querySelector(s);
  let alive = true;

  /* ---------- A: lookup ---------- */

  const form = $("[data-vf-lookup]");
  const msg = $("[data-vf-msg]");
  const offLookup = on(root, "submit", "[data-vf-lookup]", async (e) => {
    e.preventDefault();
    const q = form.querySelector("input").value;
    msg.textContent = "Checking the public lists in your browser…";
    const res = await resolveSearch(q, {
      hrp: ADDRESS_HRP,
      getNullifiers: () => api.nullifiers(),
      getCommitments: () => api.commitments(),
      getAssets: () => api.assets(),
    });
    if (!alive) return;
    if (res.path) {
      msg.textContent = "";
      navigate(res.path);
    } else msg.textContent = res.message;
  });
  logAll()
    .then((log) => {
      if (!alive) return;
      const last = [...log].reverse().find((e) => e.ok && (e.opName === "TRANSFER" || e.op === 1));
      const lastAny = last ?? [...log].reverse().find((e) => e.ok);
      const el = $("[data-vf-latest]");
      if (!lastAny || !el) return;
      el.innerHTML = html`<span class="caption t-3">Try ${last ? "the latest private transfer" : "the latest accepted transaction"}:</span>
        <a class="mono" href="/tx/${lastAny.txid}" data-link>${short(lastAny.txid, 8, 6)}</a>${sealPill({ state: "accepted", height: lastAny.height })}`;
    })
    .catch(() => {});

  /* ---------- B: Verify the Pool ---------- */

  let plan = null;
  let replay = null;
  let lastProgress = null;
  let lastDone = null;

  const pool = $("[data-pool]");
  const setStatus = (text, tone = "t-2") => {
    const el = pool.querySelector("[data-vp-status]");
    if (el) el.innerHTML = html`<span class="${tone}">${text}</span>`;
  };

  async function loadPlan() {
    try {
      plan = await replayPlan();
    } catch (e) {
      plan = null;
      if (alive) pool.querySelector("[data-vp-plan]").innerHTML = html`<p class="small t-danger">Couldn't plan the replay: ${e.message}. Check your connection and reload.</p>`;
      return;
    }
    if (!alive) return;
    paintPlan();
    const saved = await loadReplay({ key: plan.key }).catch(() => null);
    if (saved?.result && alive) paintResult(saved.result, null);
  }

  function paintPlan() {
    const p = plan;
    const est = p.estBytes != null ? `about ${fmtBytes(p.estBytes)}` : "an unknown amount of data";
    const resume = p.saved && p.blocks > 0
      ? html`<p class="small t-2">${icon("check", { size: 14 })} A replay saved in this browser reaches ${heightText(p.saved.height)}, so only newer blocks download.</p>`
      : "";
    pool.querySelector("[data-vp-plan]").innerHTML = html`
      ${p.blocks === 0
        ? html`<p class="small">Your saved replay is at the tip, ${heightText(p.tip)} ${prov("BTC")}. Nothing new to download.</p>`
        : html`<p class="small">From ${heightText(p.saved ? p.saved.height + 1 : p.startHeight)} to ${heightText(p.tip)} ${prov("BTC")}: ${int(p.blocks)} ${p.blocks === 1 ? "block" : "blocks"}, ${est} straight from mempool.space. Nothing goes through our servers.</p>`}
      ${resume}
      ${p.formatChanged && p.restartNote ? html`<p class="small t-warn">${icon("warn", { size: 14 })} ${p.restartNote}</p>` : ""}
      ${p.preGenesis
        ? html`<p class="small t-warn">${icon("warn", { size: 14 })} Pre-genesis: no genesis attestation is pinned yet, so the start block ${heightText(p.startHeight)} is the one our indexer reports ${prov("IDX")}, and the genesis check is skipped.</p>`
        : html`<p class="small t-2">The replay starts at the genesis block ${heightText(ACTIVATION_HEIGHT)} and stops if it doesn't carry the pinned genesis attestation.</p>`}`;
    paintControls();
  }

  function paintControls() {
    const running = replay?.running;
    const done = lastProgress && lastProgress.height >= (lastProgress.tip ?? Infinity);
    pool.querySelector("[data-vp-controls]").innerHTML = html`
      ${running
        ? button({ label: "Pause", kind: "secondary", action: "vp-pause", icon: "clock" })
        : button({ label: plan?.saved || lastProgress ? (done ? "Check for new blocks" : "Resume") : "Verify the pool in my browser", kind: "neutral", action: "vp-start", icon: "proof", disabled: !plan, reason: plan ? null : "Planning the replay…" })}
      ${!running && (plan?.saved || lastProgress) ? button({ label: "Forget saved replay", kind: "ghost", size: "sm", action: "vp-reset" }) : ""}`;
  }

  function paintProgress(p) {
    lastProgress = p;
    const total = Math.max(1, p.tip - p.startHeight + 1);
    const done = Math.max(0, p.height - p.startHeight + 1);
    pool.querySelector("[data-vp-progress]").hidden = false;
    pool.querySelector("[data-vp-bar]").innerHTML = progress({ value: done, max: total, unit: "blocks" });
    pool.querySelector("[data-vp-stats]").innerHTML = html`
      ${statTile({ eyebrow: "Replayed to", value: heightText(p.height), prov: "BTC", foot: `tip ${heightText(p.tip)}` })}
      ${statTile({ eyebrow: "Blocks this run", value: int(p.blocksScanned), foot: fmtBytes(p.bytes) + " downloaded" })}
      ${statTile({ eyebrow: "Envelopes found", value: int(p.envelopes), prov: "YOU", foot: `${int(p.rejected)} rejected by the rules` })}
      ${statTile({ eyebrow: "Proofs verified", value: int(p.proofsVerified), prov: "YOU", foot: p.msPerProof != null ? `${fmtMs(p.msPerProof)} per proof` : "this run" })}
      ${p.claimsVerified ? statTile({ eyebrow: "Mining claims checked", value: int(p.claimsVerified), prov: "YOU", foot: p.msPerClaim != null ? `${fmtMs(p.msPerClaim)} per claim (Argon2id work)` : "this run" }) : ""}
      ${p.headers?.tipHeight != null ? statTile({ eyebrow: "Headers verified to", value: heightText(p.headers.tipHeight), prov: "YOU", foot: p.headers.baseHeight != null ? `from pinned checkpoint ${heightText(p.headers.baseHeight)}` : "from a pinned checkpoint" }) : ""}`;
  }

  async function onDone(p) {
    paintProgress(p);
    lastDone = p;
    paintControls();
    setStatus("Replay complete. Comparing with our indexer, digest by digest…");
    try {
      const r = await compareReplay(plan);
      if (alive) paintResult(r, p);
    } catch (e) {
      if (alive) setStatus(`Couldn't compare with the indexer: ${e.message}`, "t-danger");
    }
    plan = await replayPlan().catch(() => plan);
    if (alive && plan) paintPlan();
  }

  function paintResult(r, p) {
    const el = pool.querySelector("[data-vp-result]");
    el.hidden = false;
    const ok = r.ok;
    const comp = { chain: "Block hash", root: "Note tree root", log: "Transaction log", "nullifiers-or-assets": "Nullifiers or token table", missing: "Missing on one side", version: "Protocol version" };
    el.innerHTML = html`<div class="vp-result ${ok ? "is-ok" : "is-bad"}">
      <div class="vp-result-head">
        <span class="vp-result-ic">${icon(ok ? "check" : "cross", { size: 20 })}</span>
        <div>
          <div class="eyebrow">${ok ? "POOL STATE MATCHES" : "POOL STATE DIFFERS"} ${prov("YOU")}</div>
          <p class="h3">${ok
            ? html`Your browser replayed the pool from Bitcoin and got the same state as our indexer at ${heightText(r.height)}.`
            : html`Your replay and our indexer disagree${r.firstDivergence != null ? html` from ${heightText(r.firstDivergence)}` : ""}.`}</p>
        </div>
      </div>
      ${kv2([
        ["Compared at", html`<span class="mono">${heightText(r.height)}</span> <span class="caption t-3">(your replay ${heightText(r.localHeight)} · indexer ${heightText(r.indexerHeight)})</span>`],
        ["Your digest", r.local ? hash(r.local, { label: "Copy digest" }) : DASH],
        ["Indexer digest", r.remote ? html`${hash(r.remote, { label: "Copy digest" })} ${prov("IDX")}` : DASH],
        ...(ok ? [] : [["First difference", r.firstDivergence != null ? html`<span class="mono">${heightText(r.firstDivergence)}</span> · ${comp[r.component] ?? r.component ?? DASH}` : DASH]]),
      ])}
      ${!ok && r.text ? html`<p class="small t-danger">${r.text} Don't trust this indexer's view of the pool: <a href="#indexer" data-link>switch to your own indexer</a>.</p>` : ""}
      ${ok && p ? html`<div class="cluster vp-share">
        ${button({ label: "Download result card", kind: "secondary", size: "sm", icon: "download", action: "vp-card" })}
        ${button({ label: "Copy result", kind: "ghost", size: "sm", icon: "copy", action: "vp-copy" })}
        <span class="caption t-3">The card holds no wallet data.</span></div>` : ""}
    </div>`;
    setStatus(ok ? "Done. Your browser checked every proof itself." : "Done, with a mismatch.", ok ? "t-proof" : "t-danger");
    lastResult = r;
  }
  let lastResult = null;

  function cardData() {
    const t = lastDone.totals ?? { proofs: lastDone.proofsVerified, blocks: lastDone.blocksScanned, ms: lastDone.ms };
    return {
      proofs: t.proofs,
      blocks: t.blocks,
      seconds: t.ms / 1000,
      height: lastResult.height,
      digest: lastResult.local,
      matched: lastResult.ok,
      brand: BRAND,
    };
  }

  const offPool = on(root, "click", "[data-action^=vp-]", async (e, b) => {
    const a = b.dataset.action;
    if (a === "vp-start" && plan) {
      replay ??= new PoolReplay({
        onProgress: (p) => alive && paintProgress(p),
        onDone: (p) => alive && onDone(p),
        onPaused: (p) => {
          if (!alive) return;
          paintProgress(p);
          paintControls();
          setStatus(`Paused at ${heightText(p.height)}. Progress is saved in this browser.`);
        },
        onError: (err) => {
          if (!alive) return;
          paintControls();
          const genesis = /genesis mismatch/.test(err.message);
          const header = headerStopText(err);
          setStatus(genesis ? "Genesis mismatch: the activation block doesn't carry the pinned genesis attestation. This replay ran against different artifacts or a different chain." : header ?? `The replay stopped: ${err.message}`, err?.code === "time-too-new" ? "t-warn" : "t-danger");
        },
      });
      pool.querySelector("[data-vp-result]").hidden = true;
      setStatus("Replaying blocks from mempool.space and checking every proof…");
      await replay.start(plan);
      paintControls();
    } else if (a === "vp-pause") {
      replay?.pause();
      setStatus("Pausing after the current blocks…");
    } else if (a === "vp-reset" && plan) {
      await resetReplay(plan);
      lastProgress = null;
      pool.querySelector("[data-vp-progress]").hidden = true;
      pool.querySelector("[data-vp-result]").hidden = true;
      setStatus("Saved replay forgotten. The next run starts from the first block.");
      plan = await replayPlan().catch(() => plan);
      if (plan) paintPlan();
    } else if (a === "vp-card" && lastResult && lastDone) {
      await download(await poolCard(cardData()), `${BRAND.toLowerCase()}-pool-verified-${lastResult.height}.png`);
    } else if (a === "vp-copy" && lastResult && lastDone) {
      const ok = await copyText(poolCardText(cardData()));
      toast({ kind: ok ? "success" : "warn", title: ok ? "Result copied." : "Couldn't copy the result." });
    }
  });

  loadPlan();

  /* ---------- C: artifacts ---------- */

  const art = $("[data-artifacts]");
  async function hashOne(name) {
    const cell = art.querySelector(`[data-art="${name}"]`);
    if (!cell) return;
    cell.innerHTML = html`<span class="spinner spinner--12"></span> <span class="caption t-3">Downloading and hashing…</span>`;
    try {
      const f = await fingerprint(name);
      if (!alive) return;
      const verdict =
        f.matchesPin === false || f.matchesFacts === false
          ? tag("Differs from the pinned fingerprint", "danger")
          : f.matchesPin || f.matchesFacts
            ? html`${tag("Matches", "proof")} ${prov("YOU")}`
            : tag("Nothing pinned to compare", "warn");
      cell.innerHTML = html`${hash(f.sha256, { head: 10, tail: 6, label: "Copy sha256" })}<span class="caption t-3 vf-art-meta">${fmtBytes(f.bytes)} · hashed here in ${fmtMs(f.ms)}</span><span class="cluster">${verdict}</span>`;
    } catch (e) {
      cell.innerHTML = html`<span class="small t-danger">Couldn't fetch it: ${e.message}</span>`;
    }
  }
  const offArt = on(root, "click", "[data-action=vf-hash]", (e, b) => hashOne(b.dataset.name));
  for (const a of ARTIFACT_LIST) if (a.auto) hashOne(a.name);

  const offCopy = on(root, "click", "[data-action=vf-copy-cmd]", async (e, b) => {
    const ok = await copyText(b.closest(".vf-cmd").querySelector("code").textContent);
    toast({ kind: ok ? "success" : "warn", title: ok ? "Command copied." : "Couldn't copy." });
  });

  /* ---------- E: switch indexer (no wallet needed) ---------- */

  const idx = $("[data-vf-indexer]");
  const idxUrl = () => idx.querySelector("[name=url]").value;
  const paintIdx = (result = null, value = undefined) => alive && (idx.innerHTML = indexerPanel(result, value));
  const getJson = async (u) => {
    const res = await fetch(u, { cache: "no-store" });
    if (!res.ok) throw new Error(`it answered HTTP ${res.status}.`);
    return res.json();
  };
  async function testIdx(url) {
    paintIdx({ text: "Testing…" }, url);
    const ours = await api.state().catch(() => null);
    const ourRootAt = (h) => api.roots({ from: h, to: h }).then((rows) => rows[0]?.[1] ?? null);
    paintIdx(await testIndexer(url, { getJson, ourHeight: ours?.height ?? null, ourRootAt }), url);
  }
  const offIdx = on(root, "click", "[data-action^=vf-idx-]", async (e, b) => {
    const url = idxUrl();
    try {
      if (b.dataset.action === "vf-idx-test") return testIdx(url);
      // Unlocked means session.js is already loaded; a public visit doesn't pull the wallet in.
      const session = getWalletStatus().state === "unlocked" ? (await import("../session.js")).currentSession() : null;
      await switchIndexer(b.dataset.action === "vf-idx-use" ? url : "", { setBase: api.useIndexer, refresh: api.refreshState, session });
      toast({ kind: "info", title: "Indexer changed.", body: session ? "Every page in this browser now reads from it, and your wallet resyncs from it and checks its root." : "Every page in this browser now reads from it, and Root Match checks its commitments against its own root." });
      paintIdx();
    } catch (err) {
      paintIdx({ ok: false, text: err.message }, url);
    }
  });
  const offIdxForm = on(root, "submit", "[data-vf-idx]", (e) => {
    e.preventDefault();
    testIdx(idxUrl());
  });

  return () => {
    alive = false;
    // A replay keeps running in its Worker only while this page is open; progress is saved.
    replay?.pause();
    setTimeout(() => replay?.destroy(), 4000);
    [offLookup, offPool, offArt, offCopy, offIdx, offIdxForm].forEach((off) => off());
  };
}

/* ---------- static sections ---------- */

const kv2 = (rows) => html`<dl class="kv kv--compact">${rows.map(([k, v]) => html`<div class="kv-row"><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`;

function lookupPanel() {
  return panel({
    eyebrow: "A · ONE TRANSACTION",
    title: "Re-verify any proof from raw Bitcoin data",
    certified: true,
    body: html`<p class="small t-2">Paste a txid, a nullifier or a commitment. Transactions open as a proof receipt: your browser fetches the raw bytes from mempool.space, checks inclusion, decodes the envelope and verifies the Groth16 proof against the pinned key.</p>
      <form class="vf-lookup" data-vf-lookup autocomplete="off">
        <label class="visually-hidden" for="vf-q">Txid, nullifier or commitment</label>
        <input class="input mono" id="vf-q" name="q" type="text" placeholder="64-character txid, nullifier or commitment" spellcheck="false" autocapitalize="off">
        ${button({ label: "Verify in my browser", kind: "neutral", type: "submit", icon: "proof" })}
      </form>
      <p class="caption t-2" data-vf-msg aria-live="polite"></p>
      <div class="cluster vf-latest" data-vf-latest></div>
      <details class="vp-caveats">
        <summary class="small">How a receipt checks the block header</summary>
        <p class="small t-2">The receipt says which of these applied, best first:</p>
        <ul class="small t-2">${COPY.headerLevels.map(([level, text]) => html`<li><span class="mono">${level}</span>: ${text}</li>`)}</ul>
      </details>
      <p class="caption t-3 vf-note">${icon("eye", { size: 14 })} ${PRIVACY_NOTE}</p>`,
  });
}

function poolPanel() {
  return panel({
    eyebrow: "B · THE WHOLE POOL",
    title: "Verify the Pool: your browser becomes the indexer",
    certified: true,
    body: html`<p class="small t-2">Your browser downloads every Bitcoin block since activation from mempool.space, checks every block header from a pinned checkpoint, finds every envelope, checks every proof with the same code our indexer runs, and rebuilds the pool. Then it compares the result with our indexer, block by block, using a state digest that covers the note tree, every spent nullifier, every verdict and the token table.</p>
      <div data-vp-plan><span class="skel" style="width:70%;height:14px"></span></div>
      <div class="cluster vp-controls" data-vp-controls></div>
      <p class="small" data-vp-status aria-live="polite"></p>
      <div data-vp-progress hidden>
        <div data-vp-bar></div>
        <div class="grid-stats vp-stats" data-vp-stats></div>
      </div>
      <div data-vp-result hidden></div>
      <details class="vp-caveats">
        <summary class="small">What this proves, and what it doesn't</summary>
        <ul class="small t-2">${COPY.caveats.map((text) => html`<li>${text}</li>`)}</ul>
      </details>`,
  });
}

function artifactsPanel() {
  const manifest = MANIFEST_SHA256 ?? facts.manifest?.sha256 ?? null;
  const cards = ARTIFACT_LIST.map((a) => {
    const size = a.name === "manifest" ? null : facts.artifacts?.[a.factsKey]?.bytes ?? null;
    const pinned = a.name === "manifest" ? manifest : (facts.artifacts?.[a.factsKey]?.pinned ?? null);
    return html`<div class="vf-art">
      <div class="vf-art-head"><span class="mono vf-art-file">${a.file}</span><span class="caption t-3">${a.what}</span></div>
      <dl class="vf-art-kv">
        <div><dt class="eyebrow">Pinned in this build</dt><dd>${hash(pinned, { head: 10, tail: 6, label: "Copy pinned sha256" })}</dd></div>
        <div><dt class="eyebrow">Hashed in your browser</dt><dd data-art="${a.name}">${a.auto ? html`<span class="skel" style="width:12ch;height:12px"></span>` : button({ label: `Hash here${size ? ` · ${fmtBytes(size)}` : ""}`, kind: "secondary", size: "sm", action: "vf-hash", attrs: { "data-name": a.name } })}</dd></div>
      </dl>
    </div>`;
  });
  return panel({
    eyebrow: "C · ARTIFACTS",
    title: "Fingerprints, recomputed in your browser",
    body: html`<div class="vf-arts">${cards}</div>
      <div class="vf-genesis">
        ${kv2([
          ["Circuit manifest", hash(manifest, { label: "Copy manifest sha256" })],
          ["Genesis", !PRE_GENESIS && GENESIS_TXID
            ? html`${hash(GENESIS_TXID, { href: `/tx/${GENESIS_TXID}`, label: "Copy genesis txid" })} <span class="mono t-btc">${heightText(ACTIVATION_HEIGHT)}</span>`
            : html`${tag("Pre-genesis", "warn")} <span class="caption t-3">The manifest isn't anchored on Bitcoin yet.</span>`],
          ["Setup", html`phase 1: public Perpetual Powers of Tau · phase 2: ${tag(COPY.setupTag[0], COPY.setupTag[1])}`],
        ])}
      </div>
      <p class="caption t-3">The wasm can be rebuilt from the circuit with circom ${facts.circuit?.circom ?? "2.2.2"} and compared byte for byte. The zkey can't be rebuilt (it holds a random contribution), so it is pinned by hash and anchored by the genesis attestation.</p>`,
  });
}

function runPanel() {
  const origin = typeof location !== "undefined" ? location.origin : "https://<this-site>";
  const cmd = (text, note) => html`<div class="vf-cmd"><pre><code>${text}</code></pre>${copyButtonCmd()}${note ? html`<p class="caption t-3">${note}</p>` : ""}</div>`;
  return panel({
    eyebrow: "D · YOUR OWN INDEXER",
    title: "Run the same rules on your own machine",
    body: html`<p class="small t-2">${REPO_URL
        ? "The indexer is open source and deterministic: anyone who replays the same blocks gets the same pool, digest for digest."
        : "The indexer is deterministic: anyone who replays the same blocks gets the same pool, digest for digest. Its source isn't at a public URL yet, so these steps start from a copy of it."}</p>
      ${cmd(runCommands({ repoUrl: REPO_URL, origin }), html`The proving key can't be rebuilt, so the steps download the pinned files from this site. The indexer hashes them against <span class="mono">src/pins.json</span> in your copy and won't start with a different verification key or manifest. It serves the site and the API on http://localhost:8787; then <a href="#indexer" data-link>switch this site to it</a>.`)}
      ${cmd(`node bin/murkle.mjs audit --compare ${origin}`, "Replays from the activation block into a temporary state and prints \"OK up to <height>\" or the first block where our indexer differs.")}
      ${cmd("node bin/murkle.mjs audit --esplora http://127.0.0.1:3002/api --compare http://localhost:8787", "Use any Esplora-compatible API, such as your own electrs or mempool backend, so you don't depend on mempool.space either.")}`,
  });
}

function copyButtonCmd() {
  return html`<button type="button" class="icon-btn icon-btn--xs vf-cmd-copy" data-action="vf-copy-cmd" aria-label="Copy command" data-tip="Copy command">${icon("copy", { size: 14 })}</button>`;
}

/** The indexer URL is a setting of this browser, so this works without a wallet. */
function indexerPanel(result = null, value = undefined) {
  const cur = api.indexerBase();
  const here = typeof location !== "undefined" ? location.origin : "";
  return panel({
    eyebrow: "E · SWITCH INDEXER",
    title: "Point this site at your own indexer",
    body: html`<form class="stack vf-idx" data-vf-idx novalidate>
      <p class="small t-2">This site reads from <span class="mono">${cur || `${here} (this site)`}</span>. The choice is kept in this browser and needs no wallet: every page, and your wallet if it's unlocked, switches to that indexer at once, and Root Match then checks its commitments against its own root (Verify the Pool checks them against Bitcoin).</p>
      ${field({ label: "Indexer URL", name: "url", value: value ?? cur, placeholder: "http://localhost:8787", mono: true, attrs: { autocomplete: "off", spellcheck: "false" } })}
      <div class="cluster">${button({ label: "Test connection", kind: "secondary", size: "sm", action: "vf-idx-test", loading: result && result.ok === undefined ? result.text : null })}${button({ label: "Use this indexer", kind: "neutral", size: "sm", action: "vf-idx-use" })}${cur ? button({ label: "Back to this site's indexer", kind: "ghost", size: "sm", action: "vf-idx-reset" }) : ""}</div>
      ${result && result.ok !== undefined ? html`<p class="small ${result.ok ? "t-proof" : result.ok === null ? "t-warn" : "t-danger"}" role="status">${result.text}</p>` : ""}
      <p class="caption t-3">This site's security policy only lets the page talk to itself and mempool.space, so a different indexer may be blocked here. The sure way is to open the site your own indexer serves.</p>
    </form>`,
  });
}

function limitsPanel() {
  return panel({
    eyebrow: "LIMITS",
    title: COPY.limitsTitle,
    body: html`<ul class="vf-limits small">${COPY.limits.map(([label, tone, text]) => html`<li>${tag(label, tone)} ${text}</li>`)}</ul>
      ${button({ label: "Read the security status", href: "/security", kind: "ghost", iconRight: "chevron" })}`,
  });
}


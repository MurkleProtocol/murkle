/**
 * /explorer (visual.md section 9). The public face of the pool: what Bitcoin shows, and nothing
 * more. Mints and launches are public by design; a private transfer is three redaction bars.
 *
 * Provenance, per tile: the Bitcoin height comes from mempool.space (BTC); the pool root and the
 * note count are the indexer's (IDX) until this browser rebuilds the tree and matches them (YOU);
 * everything counted from the log is the indexer's (IDX). The root history is re-derived here
 * from the bulk commitment list, block by block.
 *
 * Mining (mining-contract.md §10.5): a MINE / MINE_SCRIPT entry shows the token, the reward, the
 * reference block and the difficulty it met, never a recipient; a DEPLOY_POW shows as a launch.
 */
import "../share/public.css";
import { CHAIN_NAME } from "../config.js";
import * as api from "../api.js";
import { html, on } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { prov, upgrade, REBUILD_TIP } from "../ui/prov.js";
import { int, hash, heightText, units, DASH } from "../ui/format.js";
import { redact } from "../ui/redact.js";
import { button, panel, statTile, segmented, table, empty, opBadge, tag } from "../ui/components.js";
import { sealPill } from "../ui/seal.js";
import { getRootStatus, onRootStatus } from "../ui/status.js";
import { setTitle } from "../router.js";
import { blockStrip, blockOpsText } from "../share/charts.js";
import { logTail, FEED_FILTERS, EMPTY_TEXT, matchesFilter, opDisplay, publicData, entrySeal, assetIndex } from "../share/feed.js";

/* ---------- mining entries (the shared feed helpers know paid mints only) ---------- */

const MINE_OPS = new Set(["MINE", "MINE_SCRIPT"]);
export const isMineEntry = (e) => MINE_OPS.has(e?.opName);
const isDeployPow = (e) => e?.opName === "DEPLOY_POW";
export const EX_FILTERS = [...FEED_FILTERS.slice(0, 3), { value: "mined", label: "Mined" }, ...FEED_FILTERS.slice(3)];

/** The explorer's filter: "mined" holds claims; launches include mined launches. */
export function exMatches(e, filter = "all") {
  if (filter === "mined") return isMineEntry(e);
  if (filter === "launches" && isDeployPow(e)) return true;
  if (isMineEntry(e) || isDeployPow(e)) return filter === "all" || (filter === "rejected" && e.ok === false);
  return matchesFilter(e, filter);
}

export const exOp = (e) => (isMineEntry(e) ? "MINE" : isDeployPow(e) ? "DEPLOY" : opDisplay(e));

/** Public data of one entry; a claim names the token, reward, reference block and difficulty, never a recipient. */
export function exPublicData(e, assets = new Map()) {
  const reason = e.ok === false ? html`<span class="ex-reason">${e.reason ?? "rejected"}</span>` : "";
  if (isMineEntry(e)) {
    const a = e.asset !== undefined ? assets.get(String(e.asset)) : null;
    const ticker = e.ticker ?? a?.ticker ?? null;
    const amount = e.amount != null ? units(e.amount, a?.divisibility ?? 0) : DASH;
    return html`<span class="ex-pub"><span class="mono">+${amount}</span>${ticker ? html` <a class="ticker" href="/t/${encodeURIComponent(ticker)}" data-link>${ticker}</a>` : html` <span class="t-3">unknown token</span>`}<span class="t-3" aria-hidden="true">→</span>${redact("recipient")}<span class="mono t-2">ref ${heightText(e.ref)}${e.difficulty != null ? ` · D ${int(e.difficulty)}` : ""}</span></span>${reason}`;
  }
  if (isDeployPow(e)) {
    const a = e.asset !== undefined ? assets.get(String(e.asset)) : null;
    const ticker = a?.ticker ?? e.ticker ?? null;
    if (a && e.ok) {
      return html`<span class="ex-pub"><a class="ticker" href="/t/${encodeURIComponent(a.ticker)}" data-link>${a.ticker}</a><span class="mono t-2">mined · ${units(a.baseReward ?? a.reward, a.divisibility ?? 0)} per claim · max ${units(a.maxSupply, a.divisibility ?? 0)}</span></span>`;
    }
    return html`<span class="ex-pub"><span class="ticker">${ticker ?? DASH}</span><span class="t-3">mined launch terms</span></span>${reason}`;
  }
  return publicData(e, assets);
}

const PAGE = 60;
const ROOTS = 20;
const REBUILD_LIMIT = 50_000;
const fieldHex = (v) => {
  try {
    return BigInt(v).toString(16).padStart(64, "0");
  } catch {
    return null;
  }
};

export function render(root) {
  setTitle("Explorer");
  let alive = true;
  let chain = null;
  let stats = null;
  let blocks = null;
  let assets = new Map();
  let entries = null; // oldest first
  let from = null;
  let filter = "all";
  let blockSel = null;
  let btcTip = null;
  let roots = null; // [{ height, root, local: string | null | undefined }]
  let rootsNote = null;

  root.innerHTML = html`<div class="container section ex">
    <header class="page-head">
      <div>
        <div class="eyebrow">EXPLORER</div>
        <h1 class="h1-app">Explorer</h1>
        <p class="lead">Every envelope on ${CHAIN_NAME}, as any chain observer sees it. Launches and mints are public; a private transfer shows only that it happened.</p>
      </div>
      ${button({ label: "Verify the whole pool", href: "/verify#pool", kind: "secondary", icon: "proof" })}
    </header>
    <div class="grid-stats ex-tiles" data-tiles>${tiles()}</div>
    ${panel({ eyebrow: "BLOCKS", title: "Recent blocks", actions: html`<span class="ex-legend"><span><i></i>empty</span><span><i class="on"></i>protocol operations</span><span><i class="on rej"></i>with a rejection</span></span>`, body: html`<div data-strip><span class="skel" style="width:100%;height:32px"></span></div>`, cls: "ex-sec" })}
    ${panel({ eyebrow: "OPERATIONS", title: "Operations feed", body: html`<div class="ex-feed-bar">${segmented(EX_FILTERS, { value: "all", name: "ex-filter", label: "Filter operations" })}<span class="caption t-3" data-feed-count></span></div><div data-block-filter></div><div class="ex-feed" data-feed><span class="skel" style="width:100%;height:160px"></span></div>`, cls: "ex-sec" })}
    ${panel({ eyebrow: "ROOT HISTORY", title: "Pool root after each block", body: html`<div data-roots><span class="skel" style="width:100%;height:120px"></span></div>`, cls: "ex-sec", id: "roots" })}
  </div>`;

  const $ = (s) => root.querySelector(s);

  /* ---------- tiles ---------- */

  function tiles() {
    const r = getRootStatus();
    const rootMatch = r.state === "match" && chain && r.root === chain.root;
    const notesYou = rootMatch && Number(r.commitments) === Number(chain?.outputs);
    const accepted = stats ? ["deploys", "mints", "privateTransfers", "attests", "mines"].reduce((s, k) => s + Number(stats[k] ?? 0), 0) : null;
    const rootHex = chain?.root != null ? fieldHex(chain.root) : null;
    // mempool.space's tip when it answered (BTC); until then the tip our indexer last saw (IDX).
    const tip = btcTip ?? chain?.chainTip ?? chain?.height ?? null;
    return html`
      ${statTile({ eyebrow: "Bitcoin height", value: tip !== null ? heightText(tip) : null, prov: btcTip !== null ? "BTC" : "IDX", foot: chain?.height != null ? `Indexer at ${heightText(chain.height)}` : null, id: "ex-t-btc" })}
      ${statTile({ eyebrow: "Pool root", value: rootHex ? hash(rootHex, { head: 6, tail: 4, label: "Copy root" }) : null, prov: "IDX", foot: rootMatch ? "Matches its commitments, rebuilt here" : r.state === "mismatch" ? "Your rebuild differs" : "Reported by our indexer", id: "ex-t-root" })}
      ${statTile({ eyebrow: "Notes", value: chain ? int(chain.outputs) : null, prov: "IDX", foot: notesYou ? "Counted in your rebuild" : null, id: "ex-t-notes" })}
      ${statTile({ eyebrow: "Spent nullifiers", value: chain ? int(chain.nullifiers) : null, prov: "IDX" })}
      ${statTile({ eyebrow: "Tokens", value: stats ? int(stats.tokens) : null, prov: "IDX" })}
      ${statTile({ eyebrow: "Envelopes", value: accepted !== null ? int(accepted) : null, unit: "accepted", prov: "IDX", foot: stats ? `${int(stats.rejected)} rejected` : null })}`;
  }

  function paintTiles() {
    const box = $("[data-tiles]");
    if (!box) return;
    // Keep chip elements so a provenance change plays the IDX -> YOU crossfade.
    const before = new Map([...box.querySelectorAll(".stat[id]")].map((s) => [s.id, s.querySelector(".prov")?.dataset.prov]));
    box.innerHTML = tiles();
    for (const [id, was] of before) {
      const chip = box.querySelector(`#${id} .prov`);
      if (!chip || !was || chip.dataset.prov === was) continue;
      const now = chip.dataset.prov;
      chip.className = `prov prov--${was.toLowerCase()}`;
      chip.dataset.prov = was;
      upgrade(chip, now);
    }
  }

  /* ---------- blocks ---------- */

  function paintStrip() {
    const el = $("[data-strip]");
    if (!el) return;
    if (!blocks) return;
    if (!blocks.length) {
      el.innerHTML = html`<p class="small t-3">No blocks indexed yet.</p>`;
      return;
    }
    const sorted = [...blocks].sort((x, y) => x.height - y.height);
    el.innerHTML = html`${blockStrip(blocks, { selected: blockSel })}
      <div class="ex-strip-foot"><span>← older</span><span>Tap a block to filter the feed</span><span>${heightText(sorted.at(-1).height)}</span></div>`;
  }

  /* ---------- feed ---------- */

  function feedRows() {
    if (!entries) return null;
    return [...entries].reverse().filter((e) => exMatches(e, filter) && (blockSel === null || e.height === blockSel));
  }

  function paintFeed() {
    const el = $("[data-feed]");
    const count = $("[data-feed-count]");
    const bf = $("[data-block-filter]");
    if (!el) return;
    if (bf) {
      const b = blocks?.find((x) => x.height === blockSel);
      bf.innerHTML = blockSel === null ? "" : html`<p class="ex-block-filter">${icon("block", { size: 14 })}<span>Block ${heightText(blockSel)} · ${b ? blockOpsText(b.ops) : "operations"}</span>${button({ label: "Clear", kind: "ghost", size: "xs", action: "ex-clear-block" })}</p>`;
    }
    const rows = feedRows();
    if (rows === null) return;
    if (count) count.textContent = entries.length ? `${int(rows.length)} shown · ${int(entries.length)} loaded${from > 0 ? ` of ${int(from + entries.length)}` : ""}` : "";
    if (!rows.length) {
      el.innerHTML = html`${empty({ text: blockSel !== null ? "No envelopes in this block match the filter." : filter === "mined" ? "No mining claims in this range. Load older entries to look further back." : EMPTY_TEXT[filter] ?? EMPTY_TEXT.all })}${moreButton()}`;
      return;
    }
    el.innerHTML = html`${table({
      columns: [
        { key: "block", label: "Block" },
        { key: "op", label: "Op" },
        { key: "tx", label: "Tx" },
        { key: "data", label: "Public data" },
        { key: "seal", label: "Seal" },
      ],
      rows: rows.map((e) => ({
        block: html`<span class="height mono">${heightText(e.height)}</span>`,
        op: opBadge(exOp(e)),
        tx: hash(e.txid, { head: 6, tail: 6, href: `/tx/${e.txid}`, label: "Copy txid" }),
        data: exPublicData(e, assets),
        seal: sealPill(entrySeal(e)),
      })),
      caption: "Protocol operations, newest first",
    })}${moreButton()}`;
  }

  const moreButton = () => (from > 0 ? html`<div class="ex-more">${button({ label: "Load older", kind: "ghost", size: "sm", action: "ex-more", icon: "chevron" })}</div>` : "");

  async function loadOlder() {
    if (!from) return;
    try {
      const page = await logTail(api, { count: PAGE, before: from });
      if (!alive) return;
      entries = [...page.items, ...entries];
      from = page.from;
      paintFeed();
    } catch (e) {
      const el = $("[data-feed]");
      el?.insertAdjacentHTML("beforeend", String(html`<p class="caption t-danger">Older entries didn't load: ${e.message}</p>`));
    }
  }

  /* ---------- root history ---------- */

  async function loadRoots() {
    if (!chain) return;
    const hi = chain.height;
    const lo = Math.max(chain.startHeight ?? 0, hi - ROOTS + 1);
    let list;
    try {
      list = await api.roots({ from: lo, to: hi });
    } catch (e) {
      rootsNote = `The root history didn't load: ${e.message}`;
      return paintRoots();
    }
    if (!alive) return;
    roots = list.map(([h, r]) => ({ height: h, root: String(r), local: undefined })).sort((x, y) => y.height - x.height);
    paintRoots();
    // Rebuild every root of the window here, from the bulk commitment list.
    try {
      const [{ commitmentsAll }, { rebuildRoots }] = await Promise.all([import("../verify/pool-data.js"), import("../verify/rebuild.js")]);
      const data = await commitmentsAll();
      if (!alive) return;
      if (data.rows.length > REBUILD_LIMIT) {
        rootsNote = `The pool has ${int(data.rows.length)} notes, too many to rebuild on this page. Verify the Pool replays it in a worker.`;
        for (const r of roots) r.local = null;
        return paintRoots();
      }
      const counts = roots.map((r) => (r.height <= data.height ? data.rows.filter(([, h]) => h <= r.height).length : null));
      const want = counts.filter((c) => c !== null);
      const { roots: local, ms } = await rebuildRoots(data.rows.map((x) => x[0]), want);
      if (!alive) return;
      let k = 0;
      roots.forEach((r, i) => (r.local = counts[i] === null ? null : local[k++]));
      rootsNote = `Rebuilt here from ${int(data.rows.length)} commitments served by our indexer in ${Math.round(ms)} ms.`;
    } catch (e) {
      rootsNote = `This browser couldn't rebuild the roots: ${e.message}`;
      for (const r of roots) if (r.local === undefined) r.local = null;
    }
    paintRoots();
  }

  function paintRoots() {
    const el = $("[data-roots]");
    if (!el) return;
    if (!roots) {
      el.innerHTML = rootsNote ? html`<p class="small t-danger">${rootsNote}</p>` : html`<span class="skel" style="width:100%;height:120px"></span>`;
      return;
    }
    if (!roots.length) {
      el.innerHTML = html`<p class="small t-3">No roots yet: the indexer hasn't applied a block.</p>`;
      return;
    }
    const chip = (r) =>
      r.local === undefined
        ? html`<span class="cluster caption t-3"><span class="spinner spinner--10"></span>rebuilding</span>`
        : r.local === null
          ? html`<span class="cluster caption t-3">${prov("IDX")} not rebuilt</span>`
          : r.local === r.root
            ? html`<span class="cluster caption ex-root-ok">${prov("IDX", { tip: REBUILD_TIP })} matches local rebuild</span>`
            : html`${tag("Differs from your rebuild", "danger")}`;
    el.innerHTML = html`${table({
      columns: [
        { key: "h", label: "Block" },
        { key: "root", label: "Root R[H]" },
        { key: "check", label: "Check" },
      ],
      rows: roots.map((r) => ({
        h: html`<span class="height mono">${heightText(r.height)}</span>`,
        root: fieldHex(r.root) ? hash(fieldHex(r.root), { head: 10, tail: 8, label: "Copy root" }) : DASH,
        check: chip(r),
      })),
      caption: "Pool root after each recent block",
    })}${rootsNote ? html`<p class="caption t-3" style="margin-top:10px">${rootsNote}</p>` : ""}
    <p class="caption t-3" style="margin-top:6px">A block with no operations keeps the previous root. Your rebuild shows the indexer's commitments agree with its roots; Verify the Pool checks them against Bitcoin. Neither catches a hidden transaction: run your own indexer to close that gap.</p>`;
  }

  /* ---------- loading ---------- */

  async function loadAll({ fresh = false } = {}) {
    const [st, bl, as, lg, mn] = await Promise.allSettled([api.stats({ fresh }), api.blocks({ limit: 24 }), api.assets({ fresh }), logTail(api, { count: PAGE }), api.mine({ fresh })]);
    if (!alive) return;
    if (st.status === "fulfilled") stats = st.value;
    if (bl.status === "fulfilled") blocks = bl.value;
    else if (!blocks) $("[data-strip]").innerHTML = html`<p class="small t-danger">Blocks didn't load: ${bl.reason?.message ?? "error"}</p>`;
    if (as.status === "fulfilled") {
      // Mined assets (GET /api/mine) join the index, keyed by id like the paid-mint rows.
      const minedRows = mn.status === "fulfilled" ? (mn.value?.assets ?? []).map((m) => ({ ...m, id: String(m.asset), kind: "pow" })) : [];
      assets = assetIndex([...as.value, ...minedRows]);
    }
    if (lg.status === "fulfilled") {
      entries = lg.value.items;
      from = lg.value.from;
    } else if (!entries) {
      $("[data-feed]").innerHTML = html`<p class="small t-danger">The operations feed didn't load: ${lg.reason?.message ?? "error"}. It retries with the next block.</p>`;
    }
    paintTiles();
    paintStrip();
    paintFeed();
  }

  api.esplora
    .tipHeight()
    .then((h) => {
      btcTip = Number(h);
      if (alive) paintTiles();
    })
    .catch(() => {});

  let lastHeight = null;
  const offs = [
    api.watchState((s) => {
      if (!alive || !s) return;
      chain = s;
      paintTiles();
      if (lastHeight === null || s.height !== lastHeight) {
        const first = lastHeight === null;
        lastHeight = s.height;
        loadAll({ fresh: !first });
        loadRoots();
      }
    }),
    onRootStatus(() => alive && paintTiles()),
    on(root, "seg-change", "[data-seg]", (e) => {
      if (e.detail?.name !== "ex-filter") return;
      filter = e.detail.value;
      paintFeed();
    }),
    on(root, "click", "[data-block]", (e, el) => {
      const h = Number(el.dataset.block);
      blockSel = blockSel === h ? null : h;
      paintStrip();
      paintFeed();
    }),
    on(root, "click", "[data-action]", (e, el) => {
      if (el.dataset.action === "ex-more") loadOlder();
      if (el.dataset.action === "ex-clear-block") {
        blockSel = null;
        paintStrip();
        paintFeed();
      }
    }),
  ];

  return () => {
    alive = false;
    offs.forEach((off) => off());
  };
}

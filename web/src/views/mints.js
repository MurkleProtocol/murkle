/**
 * /mints: the mint board (visual.md section 9). Tokens only, never people:
 * no holder counts, no minter addresses, no "top buyers". Filters and sort live in the query
 * string (?f=open&s=trending&q=ABC), so a filtered board is a shareable link.
 */
import "../share/public.css";
import * as api from "../api.js";
import { html, on } from "../ui/dom.js";
import { icon } from "../ui/icons.js";
import { prov } from "../ui/prov.js";
import { int } from "../ui/format.js";
import { button, segmented, empty } from "../ui/components.js";
import { getWalletStatus, onWalletStatus } from "../ui/status.js";
import { setTitle } from "../router.js";
import { FILTERS, SORTS, filterAssets, sortAssets, launchCard } from "../share/launch.js";

const FILTER_VALUES = new Set(FILTERS.map((f) => f.value));
const SORT_VALUES = new Set(SORTS.map((s) => s.value));

const EMPTY = {
  open: { text: "No open mints right now. Be first: write a token to Bitcoin.", action: { label: "Launch a token", href: "/app/launch" } },
  upcoming: { text: "No launches are scheduled. A launch can open at any future block.", action: { label: "Launch a token", href: "/app/launch" } },
  soldout: { text: "Nothing has minted out yet.", action: { label: "Show open mints", href: "/mints?f=open" } },
  all: { text: "No tokens on this pool yet. Be first: write a token to Bitcoin.", action: { label: "Launch a token", href: "/app/launch" } },
};

export function render(root, params, query) {
  setTitle("Mints");
  const state = {
    filter: FILTER_VALUES.has(query?.get("f")) ? query.get("f") : "open",
    sort: SORT_VALUES.has(query?.get("s")) ? query.get("s") : "trending",
    q: String(query?.get("q") ?? "").slice(0, 16),
  };
  let assets = null;
  let height = null;
  let failed = null;
  let alive = true;

  root.innerHTML = html`<div class="container section">
    <header class="page-head">
      <div>
        <div class="eyebrow">LAUNCHPAD</div>
        <h1 class="h1-app">Mints</h1>
        <p class="lead">Open-mint tokens on Bitcoin. Terms are public; holders are not.</p>
      </div>
      ${button({ label: "Launch a token", href: "/app/launch", kind: "secondary", icon: "launch" })}
    </header>
    <div class="mn-tools">
      ${segmented(FILTERS, { value: state.filter, name: "mn-filter", label: "Filter tokens" })}
      <div class="mn-sort"><label for="mn-sort">Sort</label><select id="mn-sort" class="input" data-sort>${SORTS.map((s) => html`<option value="${s.value}"${s.value === state.sort ? html` selected` : ""}>${s.label}</option>`)}</select></div>
      <div class="mn-q"><span class="mn-q-ic">${icon("search", { size: 16 })}</span><input class="input" type="search" data-q value="${state.q}" placeholder="Ticker" maxlength="16" spellcheck="false" autocapitalize="characters" autocomplete="off" aria-label="Filter by ticker"></div>
    </div>
    <p class="mn-count" data-count aria-live="polite"></p>
    <div class="lp-grid" data-grid>${Array.from({ length: 6 }, () => html`<div class="panel lp-card"><span class="skel" style="width:60%;height:24px"></span><span class="skel" style="width:40%;height:12px"></span><span class="skel" style="width:100%;height:4px"></span><span class="skel" style="width:100%;height:40px"></span><span class="skel" style="width:100%;height:40px"></span></div>`)}</div>
    <p class="mn-note">${icon("info", { size: 14 })}<span>Progress, prices and schedules are reported by our indexer ${prov("IDX")}; open a token to check its terms against the DEPLOY transaction on Bitcoin. "Trending" counts mints in the last 144 blocks. There are no holder counts anywhere, by design.</span></p>
  </div>`;

  const $ = (s) => root.querySelector(s);

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.filter !== "open") p.set("f", state.filter);
    if (state.sort !== "trending") p.set("s", state.sort);
    if (state.q) p.set("q", state.q);
    const next = `/mints${p.toString() ? `?${p}` : ""}`;
    if (location.pathname + location.search !== next) history.replaceState(history.state, "", next);
  }

  function paint() {
    const grid = $("[data-grid]");
    const count = $("[data-count]");
    if (failed && !assets) {
      grid.innerHTML = html`<div class="panel" style="grid-column:1/-1">${empty({ text: `The token list didn't load: ${failed.message}`, action: { label: "Try again", action: "mn-retry" } })}</div>`;
      count.textContent = "";
      return;
    }
    if (!assets) return;
    const list = sortAssets(filterAssets(assets, { filter: state.filter, query: state.q }), state.sort, height);
    const walletReady = getWalletStatus().state === "unlocked";
    count.textContent = `${int(list.length)} ${list.length === 1 ? "token" : "tokens"}${state.q ? ` matching "${state.q.toUpperCase()}"` : ""} · ${int(assets.length)} on this pool`;
    if (!list.length) {
      const e = state.q ? { text: `No token matches "${state.q.toUpperCase()}" here. Check the spelling, or look in All.`, action: { label: "Show all", href: "/mints?f=all" } } : EMPTY[state.filter] ?? EMPTY.all;
      grid.innerHTML = html`<div class="panel" style="grid-column:1/-1">${empty(e)}</div>`;
      return;
    }
    grid.innerHTML = html`${list.map((a) => launchCard(a, { height, walletReady }))}`;
  }

  async function load(fresh = false) {
    try {
      const [s, list] = await Promise.all([api.state().catch(() => null), api.assets({ fresh })]);
      if (!alive) return;
      height = s?.height ?? height;
      assets = list;
      failed = null;
    } catch (e) {
      if (!alive) return;
      failed = e;
    }
    paint();
  }

  let lastHeight = null;
  const offs = [
    api.watchState((s) => {
      if (!alive || !s) return;
      if (lastHeight !== null && s.height !== lastHeight) load(true);
      lastHeight = s.height;
      height = s.height;
    }),
    onWalletStatus(() => alive && paint()),
    on(root, "seg-change", "[data-seg]", (e) => {
      if (e.detail?.name !== "mn-filter") return;
      state.filter = e.detail.value;
      syncUrl();
      paint();
    }),
    on(root, "change", "[data-sort]", (e, el) => {
      state.sort = SORT_VALUES.has(el.value) ? el.value : "trending";
      syncUrl();
      paint();
    }),
    on(root, "input", "[data-q]", (e, el) => {
      state.q = el.value.trim().replace(/^\$/, "").slice(0, 16);
      syncUrl();
      paint();
    }),
    on(root, "click", "[data-action=mn-retry]", () => load(true)),
  ];

  load();
  return () => {
    alive = false;
    offs.forEach((off) => off());
  };
}

// Entry point: styles, self-hosted fonts, the app shell and the route table.
//
// Shell, top to bottom (visual.md section 5): honesty ribbon, sticky top bar (wordmark, nav,
// global search, Root Match chip, theme, wallet button), ledger strip (tablet and up), main,
// footer (genesis anchor, disclosures, links, theme), phone tab bar, toast host.
//
// Views live in ./views/<name>.js and export render(root, params, query) (see router.js).
// A view that doesn't exist yet renders a styled "coming soon" panel instead of breaking the
// build: import.meta.glob only lists files that exist.

import "@fontsource/instrument-sans/latin-400.css";
import "@fontsource/instrument-sans/latin-500.css";
import "@fontsource/instrument-sans/latin-600.css";
import "@fontsource/instrument-sans/latin-700.css";
import "@fontsource/instrument-serif/latin-400.css";
import "@fontsource/instrument-serif/latin-400-italic.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/pages.css";
// First after the styles: inside a frame it shows a notice and stops here (audit V2-10).
import "./frame-guard.js";

import facts from "./facts.json";
import {
  ADDRESS_HRP, ARTIFACT_SHA256, BRAND, GENESIS_TXID, ACTIVATION_HEIGHT, IS_SIGNET, LEGACY_STORAGE_PREFIX, MANIFEST_SHA256,
  NETWORK_TAG, NOT_LAUNCHED, PRE_GENESIS, REPO_URL, STORAGE_PREFIX,
} from "./config.js";

// The honesty ribbon per network: signet keeps its words; mainnet says it has not launched until
// a genesis is pinned, then that it is experimental software.
const RIBBON = IS_SIGNET
  ? { long: "Signet test network · Test coins only · Development proving keys", short: "Signet · Test coins · Dev keys" }
  : NOT_LAUNCHED
    ? { long: `${BRAND} has not launched on Bitcoin mainnet. No genesis is pinned, so nothing here can move funds.`, short: "Mainnet · Not launched" }
    : { long: "Bitcoin mainnet · Experimental software · Tokens can be lost to bugs", short: "Mainnet · Experimental" };
import * as api from "./api.js";
import { route, start, navigate, setTitle } from "./router.js";
import { html, raw, toNode, setHTML } from "./ui/dom.js";
import { icon, injectSprite, glyphSVG } from "./ui/icons.js";
import { int, short, rel, hash, height, heightText, fieldHex, DASH } from "./ui/format.js";
import { prov } from "./ui/prov.js";
import { sigil } from "./ui/sigil.js";
import { rootChip, rootDetails } from "./ui/rootmatch.js";
import { signetChip, button, tag } from "./ui/components.js";
import { openSheet, openPopover, closeAllPopovers } from "./ui/sheet.js";
import { mountToasts, toast } from "./ui/toast.js";
import { installBehaviors } from "./ui/behaviors.js";
import { themeControl, getThemePref, setThemePref, onThemeChange } from "./ui/theme.js";
import { resolveSearch, suggestTickers, classify, ADDRESS_MESSAGE } from "./ui/search.js";
import {
  getWalletStatus, setWalletStatus, onWalletStatus, getRootStatus, setRootStatus, onRootStatus, detectStoredWallet,
} from "./ui/status.js";

/* ---------- routes ---------- */

const views = import.meta.glob("./views/*.js");
const rootCheckers = import.meta.glob("./verify/root-match.js");

// [pattern, view module, layout, title, extra params]
const ROUTES = [
  ["/", "landing", "public", null],
  ["/mints", "mints", "public", "Mints"],
  ["/t/:ticker", "token", "public", "Token"],
  ["/explorer", "explorer", "public", "Explorer"],
  ["/tx/:txid", "receipt", "public", "Proof receipt"],
  ["/nullifier/:hex", "lookup", "public", "Nullifier", { kind: "nullifier" }],
  ["/commitment/:hex", "lookup", "public", "Commitment", { kind: "commitment" }],
  ["/verify", "verify", "public", "Verify"],
  ["/security", "security", "public", "Security"],
  ["/protocol", "protocol", "public", "Protocol"],
  ["/pay", "pay", "public", "Payment request"],
  ["/app", "app-gate", "app", "Wallet"],
  ["/app/create", "app-create", "app", "Create wallet"],
  ["/app/import", "app-import", "app", "Import wallet"],
  ["/app/send", "app-send", "app", "Send"],
  ["/app/receive", "app-receive", "app", "Receive"],
  ["/app/mint", "app-mint", "app", "Mint"],
  ["/app/mine", "app-mine", "app", "Mine"],
  ["/app/launch", "app-launch", "app", "Launch a token"],
  ["/app/activity", "app-activity", "app", "Activity"],
  ["/app/settings", "app-settings", "app", "Settings"],
];

for (const [pattern, name, layout, title, params] of ROUTES) {
  // /app is the gate (onboarding / lock screen) or, once unlocked, the portfolio; either view
  // module may provide it.
  const loader = views[`./views/${name}.js`] ?? (name === "app-gate" ? views["./views/app-portfolio.js"] : null) ?? null;
  route(pattern, loader, { name, layout, title, params });
}
// Hidden review page for every component in every state (not linked anywhere).
route("/_kit", () => import("./ui/kit-view.js"), { name: "kit", layout: "public", title: "Component kit" });
route("*", views["./views/notfound.js"] ?? null, { name: "notfound", layout: "public", title: "Not found" });

/* ---------- shell markup ---------- */

const NAV = [
  ["/mints", "Mints"],
  ["/explorer", "Explorer"],
  ["/verify", "Verify"],
  ["/security", "Security"],
];

const app = document.getElementById("app");
injectSprite();

app.innerHTML = html`
  <a class="skip" href="#main">Skip to content</a>
  <div class="ribbon" role="note" aria-label="Network status">
    <div class="container ribbon-in">
      <span class="rb-long">${RIBBON.long}${IS_SIGNET ? raw('<span class="rb-pre" hidden> · Pre-genesis</span>') : ""}</span>
      <span class="rb-short">${RIBBON.short}${IS_SIGNET ? raw('<span class="rb-pre" hidden> · Pre-genesis</span>') : ""}</span>
      <a class="ribbon-link" href="/security#status" data-link aria-label="What this means: security status"><span class="rb-long">What this means </span>→</a>
    </div>
  </div>
  <header class="topbar">
    <div class="container topbar-in">
      <a class="brand" href="/" data-link aria-label="${BRAND} home">${glyphSVG({ size: 20 })}<span class="wordmark">${BRAND}</span>${signetChip()}</a>
      <nav class="nav" aria-label="Main">${NAV.map(([href, label]) => html`<a href="${href}" data-link>${label}</a>`)}</nav>
      <span class="topbar-spacer"></span>
      <div class="top-search">${searchForm("top")}</div>
      <div class="top-actions">
        <button type="button" class="icon-btn search-btn" data-action="open-search" aria-label="Search" data-tip="Search">${icon("search")}</button>
        <span class="rootchip-slot"></span>
        <button type="button" class="icon-btn streamer-btn" data-action="streamer-toggle" aria-pressed="false" aria-label="Streamer mode" data-tip="Streamer mode"></button>
        <button type="button" class="icon-btn theme-btn" data-action="theme-menu" aria-haspopup="menu" aria-label="Theme" data-tip="Theme"></button>
        <span class="wallet-slot"></span>
      </div>
    </div>
  </header>
  <div class="ledger"><div class="container ledger-in" role="status" aria-label="Pool status"></div></div>
  <main id="main" class="main" tabindex="-1"></main>
  <footer class="footer"></footer>
  <nav class="tabbar" aria-label="Sections"></nav>`;

const $ = (sel) => app.querySelector(sel);
const main = $("#main");
mountToasts(document.body);
installBehaviors(document);

// Dev server only: saving a source file reloads every open tab (these modules take no hot
// updates), and a reload locks the wallet. Say so, rather than leave an unexplained flash.
if (import.meta.hot) {
  const RELOAD_KEY = `${STORAGE_PREFIX}.dev-reload`;
  // Why the dev server is about to reload this tab. A reload or a navigation by the user also
  // closes the socket, which some browsers report as a disconnect: ignored after beforeunload,
  // as Vite does. The mark is set as the page goes, so it dates the reload, not the drop.
  let cause = null;
  let leaving = false;
  addEventListener("beforeunload", () => (leaving = true));
  import.meta.hot.on("vite:beforeFullReload", () => (cause = "save"));
  import.meta.hot.on("vite:ws:disconnect", () => leaving || (cause = "restart"));
  addEventListener("pagehide", () => {
    try {
      if (cause) sessionStorage.setItem(RELOAD_KEY, `${cause} ${Date.now()}`);
    } catch {}
  });
  let mark = "";
  try {
    mark = sessionStorage.getItem(RELOAD_KEY) ?? "";
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {}
  const [why, at] = mark.split(" ");
  const reloaded = performance.getEntriesByType?.("navigation")?.[0]?.type === "reload";
  if (reloaded && Date.now() - Number(at) < 5_000) {
    const what = why === "restart" ? "It restarted" : "A source file changed";
    toast({ kind: "info", title: "Reloaded by the dev server.", body: `${what}, so every open tab reloaded and an unlocked wallet locked. The built app (npm run web:build, served by the indexer) doesn't reload on its own.` });
  }
}

// A native jump to #main would fire popstate, re-mount the view (typed input lost) and replace
// the URL's own fragment (/pay#to=…). Move focus instead.
$(".skip").addEventListener("click", (e) => {
  e.preventDefault();
  main.focus();
});

/* ---------- search ---------- */

function searchForm(where) {
  return html`<form class="search${where === "sheet" ? " search--sheet" : ""}" role="search" data-search autocomplete="off">
    <span class="search-ic">${icon("search", { size: 16 })}</span>
    <input class="input search-input" type="search" name="q" placeholder="Search txid, nullifier, ticker" spellcheck="false" autocapitalize="off" aria-label="Search txid, nullifier, commitment or ticker"${where === "sheet" ? raw(" autofocus") : ""}>
    ${where === "top" ? html`<kbd class="search-kbd" aria-hidden="true">/</kbd>` : ""}
    <div class="search-pop" hidden></div>
  </form>`;
}

let assetCache = null;
const getAssets = () => (assetCache ??= api.assets().catch((e) => ((assetCache = null), Promise.reject(e))));

function searchMessage(pop, text, tone = "info") {
  pop.hidden = false;
  pop.innerHTML = html`<div class="search-msg search-msg--${tone}">${icon(tone === "warn" ? "warn" : "info", { size: 16 })}<span>${text}</span></div>`;
}

async function onSearchInput(form) {
  const input = form.querySelector(".search-input");
  const pop = form.querySelector(".search-pop");
  const q = input.value;
  const c = classify(q, { hrp: ADDRESS_HRP });
  if (c.kind === "empty") return (pop.hidden = true);
  if (c.kind === "address") return searchMessage(pop, ADDRESS_MESSAGE);
  if (c.kind === "hex64") {
    pop.hidden = false;
    pop.innerHTML = html`<div class="search-msg">${icon("search", { size: 16 })}<span>Press Enter to look up this hash. Your browser checks the public lists first; nothing is sent to our indexer.</span></div>`;
    return;
  }
  if (c.kind !== "ticker") return (pop.hidden = true);
  let list = [];
  try {
    list = suggestTickers(q, await getAssets());
  } catch {
    list = [];
  }
  if (input.value !== q) return;
  if (!list.length) return (pop.hidden = true);
  pop.hidden = false;
  pop.innerHTML = list
    .map((a) => html`<a class="search-opt" href="/t/${a.ticker}" data-link>${sigil(String(a.assetId), { size: 20 })}<span class="ticker">${a.ticker}</span><span class="caption">Token</span></a>`)
    .join("");
}

async function onSearchSubmit(form, sheet = null) {
  const input = form.querySelector(".search-input");
  const pop = form.querySelector(".search-pop");
  const res = await resolveSearch(input.value, {
    hrp: ADDRESS_HRP,
    getNullifiers: () => api.nullifiers(),
    getCommitments: () => api.commitments(),
    getAssets,
  });
  if (res.path) {
    input.value = "";
    pop.hidden = true;
    input.blur();
    sheet?.close();
    navigate(res.path);
  } else {
    searchMessage(pop, res.message, res.tone);
  }
}

function wireSearch(scope, sheet = null) {
  scope.addEventListener("input", (e) => {
    const f = e.target.closest("[data-search]");
    if (f) onSearchInput(f);
  });
  scope.addEventListener("submit", (e) => {
    const f = e.target.closest("[data-search]");
    if (!f) return;
    e.preventDefault();
    onSearchSubmit(f, sheet);
  });
  scope.addEventListener("keydown", (e) => {
    const f = e.target.closest?.("[data-search]");
    if (f && e.key === "Escape") {
      f.querySelector(".search-pop").hidden = true;
      if (!sheet) e.target.blur();
    }
  });
  scope.addEventListener("focusout", (e) => {
    const f = e.target.closest?.("[data-search]");
    if (f && !f.contains(e.relatedTarget)) setTimeout(() => !f.contains(document.activeElement) && (f.querySelector(".search-pop").hidden = true), 120);
  });
}
wireSearch(app.querySelector(".topbar"));

function openSearchSheet() {
  const s = openSheet({ title: "Search", body: searchForm("sheet"), label: "Search" });
  s.body.insertAdjacentHTML("beforeend", html`<p class="caption t-3" style="margin-top:12px">Txids, nullifiers and commitments are matched in your browser against public lists. Shielded addresses are never sent anywhere.</p>`);
  wireSearch(s.el, s);
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const t = e.target;
  if (t.closest?.("input, textarea, select, [contenteditable]")) return;
  const field = app.querySelector(".top-search .search-input");
  e.preventDefault();
  if (field && field.offsetParent !== null) field.focus();
  else openSearchSheet();
});

/* ---------- streamer mode button ---------- */

// The flag is a plain, non-secret pref, so public pages read it without loading the
// wallet bundle; the session module is imported only when the user toggles it.
const STREAMER_KEY = `${STORAGE_PREFIX}.streamer`;
function streamerOn() {
  try {
    return localStorage.getItem(STREAMER_KEY) === "1";
  } catch {
    return false;
  }
}
function paintStreamerButton(on = streamerOn()) {
  const b = $(".streamer-btn");
  b.innerHTML = icon(on ? "eye-off" : "eye");
  b.setAttribute("aria-pressed", on ? "true" : "false");
  b.setAttribute("aria-label", on ? "Streamer mode on: amounts and addresses hidden" : "Streamer mode off");
  b.dataset.tip = on ? "Streamer mode: on" : "Streamer mode: off";
}
paintStreamerButton();
let streamerWired = false;
async function toggleStreamer() {
  const m = await import("./session.js");
  if (!streamerWired) {
    streamerWired = true;
    m.onStreamerChange(() => paintStreamerButton(m.streamerMode()));
  }
  m.setStreamerMode(!m.streamerMode());
  paintStreamerButton(m.streamerMode());
  toast({ kind: "info", title: m.streamerMode() ? "Streamer mode on: amounts and addresses are hidden." : "Streamer mode off." });
}

/* ---------- theme button ---------- */

const THEME_ICON = { system: "monitor", dark: "moon", light: "sun" };
function paintThemeButton() {
  const b = $(".theme-btn");
  const pref = getThemePref();
  b.innerHTML = icon(THEME_ICON[pref]);
  b.setAttribute("aria-label", `Theme: ${pref}`);
  b.dataset.tip = `Theme: ${pref[0].toUpperCase()}${pref.slice(1)}`;
}
paintThemeButton();
onThemeChange(paintThemeButton);

function themeMenu(anchor) {
  const item = (v, label) =>
    html`<button type="button" data-theme-pick="${v}" role="menuitemradio" aria-checked="${getThemePref() === v ? "true" : "false"}">${icon(THEME_ICON[v], { size: 16 })}<span>${label}</span>${getThemePref() === v ? html`<span style="margin-left:auto">${icon("check", { size: 16 })}</span>` : ""}</button>`;
  const p = openPopover(anchor, html`<div class="menu" role="menu">${item("system", "System")}${item("dark", "Dark")}${item("light", "Light")}</div>`, { width: 200, title: "Theme" });
  p.el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-theme-pick]");
    if (!b) return;
    setThemePref(b.dataset.themePick);
    p.close();
  });
}

/* ---------- wallet button ---------- */

function initialWalletState() {
  if (getWalletStatus().state === "unlocked") return;
  setWalletStatus({ state: detectStoredWallet(STORAGE_PREFIX, LEGACY_STORAGE_PREFIX) });
}
initialWalletState();
addEventListener("storage", (e) => {
  if (e.key && (e.key.startsWith(STORAGE_PREFIX) || (LEGACY_STORAGE_PREFIX && e.key.startsWith(LEGACY_STORAGE_PREFIX)))) initialWalletState();
  // Streamer mode set in another tab (session.js masks the page itself once it is loaded).
  if (e.key === STREAMER_KEY || e.key === null) paintStreamerButton();
});

function paintWallet() {
  const w = getWalletStatus();
  const slot = $(".wallet-slot");
  if (w.state === "unlocked") {
    slot.innerHTML = html`<button type="button" class="btn btn--secondary btn--sm wallet-btn" data-action="wallet-menu" aria-haspopup="menu">${sigil(w.address ?? "wallet", { size: 20 })}<span>Wallet</span>${icon("chevron", { size: 16 })}</button>`;
  } else if (w.state === "locked") {
    slot.innerHTML = button({ label: "Unlock", kind: "secondary", size: "sm", href: "/app", icon: "lock" });
  } else {
    slot.innerHTML = button({ label: "Open wallet", kind: "neutral", size: "sm", href: "/app" });
  }
  paintTabbar();
  const layout = main.querySelector(":scope > .app-layout");
  if (layout) layout.dataset.wallet = w.state;
}
onWalletStatus(paintWallet);

/** The wallet's Add BTC sheet (views/deposit.js), loaded on first use. */
const addBtc = () =>
  Promise.resolve()
    .then(() => views["./views/deposit.js"]())
    .then((m) => m.openDeposit())
    .catch((e) => toast({ kind: "danger", title: "Couldn't open Add BTC.", body: e.message }));

/** The relay balance top-up sheet (views/topup.js), loaded on first use; any [data-action=relay-topup] opens it. */
const topUp = () =>
  Promise.resolve()
    .then(() => views["./views/topup.js"]())
    .then((m) => m.openTopUp())
    .catch((e) => toast({ kind: "danger", title: "Couldn't open the top-up.", body: e.message }));

function walletMenu(anchor) {
  const w = getWalletStatus();
  const p = openPopover(
    anchor,
    html`<div class="menu" role="menu">
      <a href="/app" data-link role="menuitem">${icon("wallet", { size: 16 })}Portfolio</a>
      <button type="button" data-action="add-btc" role="menuitem">${icon("plus", { size: 16 })}Add BTC</button>
      <a href="/app/settings" data-link role="menuitem">${icon("settings", { size: 16 })}Settings</a>
      <hr>
      <button type="button" data-action="lock-now" role="menuitem">${icon("lock", { size: 16 })}Lock now</button>
    </div>`,
    { width: 220, title: "Wallet" },
  );
  p.el.addEventListener("click", (e) => {
    if (e.target.closest("[data-action=add-btc]")) {
      p.close();
      return addBtc();
    }
    if (!e.target.closest("[data-action=lock-now]")) return;
    p.close();
    lockNow(w);
  });
}

function lockNow(w = getWalletStatus()) {
  if (typeof w.lock === "function") w.lock();
  else setWalletStatus({ state: "locked", address: null });
  if (location.pathname.startsWith("/app")) navigate("/app");
}

/* ---------- root match ---------- */

function paintRoot() {
  setHTML($(".rootchip-slot"), rootChip(getRootStatus()));
  paintLedger();
}
onRootStatus(paintRoot);

let rootRun = null;
/** Rebuilds the note tree in this browser through the verifier module, when it exists. */
async function runRootCheck() {
  const loader = rootCheckers["./verify/root-match.js"];
  if (!loader) return false;
  if (rootRun) return rootRun;
  const before = getRootStatus();
  setRootStatus({ ...before, state: "checking", error: null });
  rootRun = (async () => {
    try {
      const mod = await loader();
      const r = await mod.checkRoot({ api });
      setRootStatus({ ...r, state: r.localRoot && r.root && r.localRoot === r.root ? "match" : "mismatch", error: null });
      return true;
    } catch (e) {
      setRootStatus({ ...before, state: before.state === "checking" ? "indexer" : before.state, error: `Rebuild failed: ${e.message}` });
      return false;
    } finally {
      rootRun = null;
    }
  })();
  return rootRun;
}

/** Phones have no ledger strip, so the Root Match sheet carries the same readout. */
function ledgerReadout() {
  if (!chain || matchMedia("(min-width: 768px)").matches) return "";
  return html`<dl class="kv kv--compact" style="margin-bottom:12px">
    <div class="kv-row"><dt>${IS_SIGNET ? "Signet" : "Mainnet"} height</dt><dd>${height(chain.height)} ${prov("BTC")}</dd></div>
    <div class="kv-row"><dt>Notes in the pool</dt><dd class="mono">${int(chain.outputs)}</dd></div>
    <div class="kv-row"><dt>Spent</dt><dd class="mono">${int(chain.nullifiers)}</dd></div>
    <div class="kv-row"><dt>Tokens</dt><dd class="mono">${poolStats?.tokens != null ? int(poolStats.tokens) : DASH}</dd></div>
    <div class="kv-row"><dt>Synced</dt><dd>${chainError ? "Last sync failed" : rel(chain.lastSync)}</dd></div>
  </dl>`;
}

function onRootChip(anchor) {
  const p = openPopover(anchor, html`${ledgerReadout()}${rootDetails(getRootStatus())}`, { width: 320, title: "Root match" });
  p.el.addEventListener("click", async (e) => {
    if (!e.target.closest("[data-action=root-rebuild]")) return;
    if (!rootCheckers["./verify/root-match.js"]) {
      p.close();
      toast({ kind: "info", title: "Rebuild runs in the wallet.", body: "Open your wallet: it rebuilds the note tree in this browser on every sync." });
      return;
    }
    p.close();
    await runRootCheck();
  });
}

/* ---------- chain state: ledger strip, ribbon, lattice data ---------- */

let chain = null;
let chainError = null;
let poolStats = null;
let autoChecked = false;

// The strip is rewritten only when its content changes, and "Synced N s ago" ages in place:
// rebuilding it every 5 s restarted the sync dot's pulse.
// The strip names the network (NETWORK_TAG: "SIGNET" / "MAINNET"). Its typeof guard keeps this function
// self-contained where a test lifts it out of the module (it then reads "SIGNET").
function paintLedger() {
  const el = $(".ledger-in");
  if (!chain) {
    setHTML(
      el,
      chainError
        ? html`<div class="lg-row"><span class="lg-item"><span class="lg-dot lg-dot--off"></span><span class="lg-bad">Indexer unreachable</span></span><span class="lg-item"><span>Retrying every 20 s</span></span></div>`
        : html`<div class="lg-row"><span class="lg-item"><span>${typeof NETWORK_TAG === "undefined" ? "SIGNET" : NETWORK_TAG}</span><span class="skel" style="width:7ch;height:10px"></span></span><span class="lg-item"><span>ROOT</span><span class="skel" style="width:18ch;height:10px"></span></span></div>`,
    );
    return;
  }
  const r = getRootStatus();
  const rootPart =
    r.state === "match" && r.root === chain.root
      ? html`<span class="lg-ok">${icon("check", { size: 12 })}Rebuilt in your browser</span>`
      : r.state === "mismatch"
        ? html`<span class="lg-bad">${icon("cross", { size: 12 })}Mismatch with your browser</span>`
        : html`<span>Reported by indexer</span>`;
  const behind = chain.chainTip != null && chain.height != null && chain.chainTip - chain.height > 2;
  const dot = chainError
    ? html`<span class="lg-dot lg-dot--off" aria-label="Last sync failed"></span>`
    : behind || chain.syncing
      ? html`<span class="lg-dot lg-dot--wait" aria-label="Catching up"></span>`
      : html`<span class="lg-dot" aria-label="In sync"></span>`;
  const syncedText = chainError ? html`<span class="lg-bad">Sync failed</span>` : behind ? html`<span class="lg-warn">Catching up</span>` : html`Synced <span class="lg-v" data-ago></span>`;
  const tokens = poolStats?.tokens ?? null;
  setHTML(el, html`<div class="lg-row">
    <span class="lg-item"><span>${typeof NETWORK_TAG === "undefined" ? "SIGNET" : NETWORK_TAG}</span><span class="lg-h">${heightText(chain.height)}</span></span>
    <span class="lg-item"><span>ROOT</span><span class="lg-v lg-hash" title="${chain.root ? fieldHex(chain.root) : ""}">${chain.root ? short(fieldHex(chain.root), 8, 4) : DASH}</span>${rootPart}</span>
    <span class="lg-item lg-notes"><span class="lg-v">${int(chain.outputs)}</span><span>NOTES</span></span>
    <span class="lg-item lg-spent"><span class="lg-v">${int(chain.nullifiers)}</span><span>SPENT</span></span>
    <span class="lg-item lg-tokens"><span class="lg-v">${tokens === null ? DASH : int(tokens)}</span><span>TOKENS</span></span>
    <span class="lg-item lg-synced">${syncedText}${dot}</span>
  </div>`);
  const ago = el.querySelector("[data-ago]");
  if (ago) ago.textContent = rel(chain.lastSync);
}
setInterval(() => chain && !document.hidden && paintLedger(), 5000);

function paintPreGenesis() {
  const pre = PRE_GENESIS || chain?.preGenesis === true;
  for (const n of app.querySelectorAll(".rb-pre")) n.hidden = !pre;
}

function onChain(s, err) {
  chainError = err;
  if (s) {
    const prevRoot = chain?.root;
    chain = s;
    const r = getRootStatus();
    // A match or mismatch only holds for the root it was computed against.
    if (r.state === "checking" && !rootRun) setRootStatus({ state: "indexer", root: s.root, height: s.height });
    else if ((r.state === "match" || r.state === "mismatch" || r.state === "indexer") && r.root !== s.root && !rootRun) {
      setRootStatus({ state: "indexer", root: s.root, height: s.height, error: null });
      if (prevRoot && autoChecked && getWalletStatus().state !== "unlocked") idle(runRootCheck);
    }
    maybeAutoCheck();
  } else if (err && getRootStatus().state === "checking") {
    setRootStatus({ state: "indexer", root: null, error: err.message });
  }
  paintLedger();
  paintPreGenesis();
  paintFooterAnchor();
}

/** visual.md 6.3: public pages without a wallet rebuild on idle when the pool is small. */
function maybeAutoCheck() {
  if (autoChecked || !chain) return;
  if (getWalletStatus().state === "unlocked") return;
  if (!(Number(chain.outputs) <= 10000)) return;
  if (!rootCheckers["./verify/root-match.js"]) return;
  autoChecked = true;
  idle(runRootCheck);
}

const idle = (fn) => (typeof requestIdleCallback === "function" ? requestIdleCallback(() => fn(), { timeout: 3000 }) : setTimeout(fn, 600));

api.watchState(onChain);
const loadStats = () =>
  api
    .stats()
    .then((s) => ((poolStats = s), paintLedger()))
    .catch(() => {});
loadStats();
setInterval(() => !document.hidden && loadStats(), 60_000);

/* ---------- footer ---------- */

const DISCLOSURES = IS_SIGNET
  ? [
    "Signet test network; the tokens have no value.",
    "Internal review only (circomspect, Picus, manual); no external audit yet.",
    "Development phase-2 trusted setup from a single party (A-8): whoever ran it could forge proofs until a public ceremony replaces it.",
    "Chain data is read from mempool.space; proof-of-work is not checked yet (A-9).",
    "Mints are public (token, amount, payer). The address that pays a transfer's fee is tied to it on Bitcoin.",
    "The anonymity set is small while the pool is early.",
  ]
  : [
    ...(NOT_LAUNCHED ? [`${BRAND} has not launched on Bitcoin mainnet. No genesis is pinned, so nothing here can move funds.`] : []),
    "Experimental software: tokens may be worth money and can be lost to bugs.",
    "Phase-2 trusted setup from the public ceremony named in the pinned manifest (A-8): secure if at least one contributor discarded their secret.",
    "Internal review only (circomspect, Picus, manual); no external audit yet.",
    "Block headers are checked from a pinned checkpoint (A-9); the data source can still hide or delay blocks.",
    "Mints are public (token, amount, payer). The address that pays a transfer's fee is tied to it on Bitcoin.",
    "The anonymity set is small while the pool is early.",
  ];
const FOOTER_STATUS = IS_SIGNET
  ? "Signet · Test coins have no value · Development proving keys"
  : NOT_LAUNCHED ? "Mainnet · Not launched · No genesis pinned" : "Mainnet · Experimental software · Public ceremony setup";

function footerMarkup() {
  const col = (title, links) =>
    html`<nav class="footer-col" aria-label="${title}"><h2 class="eyebrow">${title}</h2>${links.map(([href, label]) =>
      /^https?:/.test(href) ? html`<a href="${href}" target="_blank" rel="noopener noreferrer">${label} ↗</a>` : html`<a href="${href}" data-link>${label}</a>`,
    )}</nav>`;
  const source = [["/verify#run", "Run an indexer"], ["/protocol", "Specification"]];
  if (REPO_URL) source.unshift([REPO_URL, "Repository"]);
  const vkeyPin = ARTIFACT_SHA256?.vkey ?? facts.artifacts?.vkey?.sha256 ?? null;
  const c = facts.circuit ?? {};
  return html`<div class="container">
    <div class="footer-grid">
      <div class="footer-brand">
        <a class="brand" href="/" data-link>${glyphSVG({ size: 20 })}<span>${BRAND}</span></a>
        <p class="small t-2">Private tokens on Bitcoin.</p>
        ${themeControl({ size: "sm" })}
      </div>
      ${col("Product", [["/mints", "Mints"], ["/explorer", "Explorer"], ["/app", "Wallet"]])}
      ${col("Verify", [["/verify", "Verify"], ["/security", "Security"], ["/protocol", "Protocol"]])}
      ${col("Source", source)}
    </div>
    <div class="footer-meta">
      <p class="footer-mono">${FOOTER_STATUS}</p>
      <p class="footer-line footer-anchor"></p>
      <p class="footer-line footer-vkey">Verifier key sha256 ${vkeyPin ? hash(vkeyPin, { head: 8, tail: 4, label: "Copy verifier key hash" }) : DASH}<span class="vkey-chip"></span></p>
      <p class="footer-line">Circuit ${c.constraints != null ? int(c.constraints) : DASH} constraints · ${c.proofSystem ?? "Groth16"}/${c.curve ?? "BN254"} · ${facts.testCount != null ? int(facts.testCount) : DASH} automated tests · internally reviewed</p>
      <ul class="footer-disc">${DISCLOSURES.map((d) => html`<li>${d}</li>`)}</ul>
    </div>
  </div>`;
}

function paintFooterAnchor() {
  const el = app.querySelector(".footer-anchor");
  if (!el) return;
  const manifest = MANIFEST_SHA256 ?? facts.manifest?.sha256 ?? null;
  const g = chain?.genesis ?? null;
  const txid = GENESIS_TXID ?? g?.txid ?? null;
  const height = ACTIVATION_HEIGHT ?? g?.height ?? null;
  const circuit = html`Circuit <span class="mono" title="${manifest ?? ""}">${manifest ? manifest.slice(0, 8) + "…" : DASH}</span>`;
  const anchored =
    txid && !PRE_GENESIS
      ? html` · anchored in tx <a class="mono" href="/tx/${txid}" data-link title="${txid}">${short(txid)}</a> · block <span class="height mono">${heightText(height)}</span>`
      : html` · <span class="t-warn">not anchored on Bitcoin yet (pre-genesis)</span>`;
  // The indexer must agree with the manifest pinned in this build; say so loudly if not.
  const disagree = g?.manifestSha256 && manifest && g.manifestSha256 !== manifest ? html` · ${tag("Indexer reports a different circuit", "danger")}` : "";
  setHTML(el, html`${circuit}${anchored} · phase 2: DEV setup${disagree}`);
}

/** Hash the served verification key in this browser and compare it with the pinned value. */
async function checkVerifierKey() {
  const pin = ARTIFACT_SHA256?.vkey ?? null;
  const slot = app.querySelector(".vkey-chip");
  if (!pin || !slot || !crypto?.subtle) return;
  try {
    const bytes = await api.artifact("verification_key.json", { as: "bytes" });
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    slot.innerHTML = hex === pin ? prov("YOU") : tag("Served key differs from the pinned one", "danger");
    slot.title = hex === pin ? "Your browser hashed the served verification key: it matches the fingerprint pinned in this build." : `Served key hashes to ${hex}.`;
  } catch {
    // Offline or no artifacts served: leave the pinned value without a chip.
  }
}

$(".footer").innerHTML = footerMarkup();
paintFooterAnchor();
paintPreGenesis();
idle(checkVerifierKey);

/* ---------- phone tab bar ---------- */

function paintTabbar() {
  const path = location.pathname;
  const inApp = path.startsWith("/app") && getWalletStatus().state === "unlocked";
  const cur = (href, exact = false) => (exact ? path === href : path === href || path.startsWith(href + "/")) ? raw(' aria-current="page"') : "";
  const tab = (href, ic, label, exact = false, center = false) =>
    html`<a class="tab${center ? " tab--center" : ""}" href="${href}" data-link${cur(href, exact)}><span class="tab-ic">${icon(ic)}</span><span>${label}</span></a>`;
  const more = html`<button type="button" class="tab" data-action="tab-more"><span class="tab-ic">${icon("more")}</span><span>More</span></button>`;
  // In the wallet the bar has six tabs (Mine next to Mint); the public bar keeps five.
  $(".tabbar").classList.toggle("mine-tabs6", inApp);
  $(".tabbar").innerHTML = inApp
    ? html`${tab("/app", "wallet", "Portfolio", true)}${tab("/app/send", "send", "Send")}${tab("/app/mint", "mint", "Mint")}${tab("/app/mine", "block", "Mine")}${tab("/app/activity", "activity", "Activity")}${more}`
    : html`${tab("/mints", "coins", "Mints")}${tab("/explorer", "block", "Explorer")}${tab("/app", "wallet", "Wallet", false, true)}${tab("/verify", "proof", "Verify")}${more}`;
}

function openMore() {
  const inApp = location.pathname.startsWith("/app") && getWalletStatus().state === "unlocked";
  const link = (href, ic, label) =>
    /^https?:/.test(href)
      ? html`<a href="${href}" target="_blank" rel="noopener noreferrer">${icon(ic)}<span>${label}</span></a>`
      : html`<a href="${href}" data-link data-sheet-close>${icon(ic)}<span>${label}</span></a>`;
  const items = inApp
    ? [link("/app/receive", "receive", "Receive"), html`<button type="button" data-action="add-btc">${icon("plus")}<span>Add BTC</span></button>`, link("/app/launch", "launch", "Launch a token"), link("/app/settings", "settings", "Settings"), link("/", "arrow-left", "Back to site"), html`<button type="button" data-action="lock-now" data-sheet-close>${icon("lock")}<span>Lock now</span></button>`]
    : [link("/security", "seal", "Security"), link("/protocol", "notes", "Protocol"), link("/verify#run", "server", "Run an indexer"), REPO_URL ? link(REPO_URL, "code", "Source") : ""];
  let then = null;
  const s = openSheet({
    title: "More",
    onClose: () => then?.(),
    body: html`<nav class="more-list" aria-label="More">${items}<button type="button" data-action="streamer-toggle" data-sheet-close>${icon(streamerOn() ? "eye-off" : "eye")}<span>${streamerOn() ? "Streamer mode: on" : "Streamer mode: off"}</span></button></nav><div class="more-theme"><span class="eyebrow">Theme</span>${themeControl({ size: "md" })}</div>`,
  });
  s.el.addEventListener("click", (e) => {
    if (e.target.closest("[data-action=lock-now]")) lockNow();
    else if (e.target.closest("[data-action=add-btc]")) {
      then = addBtc; // once More has closed and handed focus back
      s.close();
    } else if (e.target.closest("[data-action=more-relay-topup]")) {
      then = topUp;
      s.close();
    }
  });
  // "Relay balance", after Add BTC, only while a relayer with relay balances runs on this server.
  const relayChunk = inApp ? views["./views/topup.js"] : null;
  if (relayChunk) {
    relayChunk()
      .then((m) => {
        if (!m.relayMenuOn()) return;
        s.el.querySelector("[data-action=add-btc]")?.after(toNode(html`<button type="button" data-action="more-relay-topup">${icon("wallet")}<span>Relay balance</span></button>`));
      })
      .catch(() => {});
  }
}

/* ---------- wallet layout and page chrome ---------- */

const RAIL = [
  ["/app", "wallet", "Portfolio", true],
  ["/app/send", "send", "Send"],
  ["/app/receive", "receive", "Receive"],
  ["/app/mint", "mint", "Mint"],
  ["/app/mine", "block", "Mine"],
  ["/app/launch", "launch", "Launch"],
  ["/app/activity", "activity", "Activity"],
  ["/app/settings", "settings", "Settings"],
];

function appLayout() {
  return html`<div class="app-layout" data-wallet="${getWalletStatus().state}">
    <aside class="app-rail" aria-label="Wallet">
      ${RAIL.map(([href, ic, label, exact]) => html`<a class="rail-link" href="${href}" data-link data-exact="${exact ? "1" : ""}" data-tip="${label}">${icon(ic)}<span class="rail-label">${label}</span></a>`)}
      <div class="rail-foot"><button type="button" class="rail-link" data-action="lock-now" data-tip="Lock">${icon("lock")}<span class="rail-label">Lock</span></button></div>
    </aside>
    <div class="app-content container container--app"></div>
  </div>`;
}

function markCurrent(path) {
  for (const a of app.querySelectorAll(".nav a")) {
    const href = a.getAttribute("href");
    if (path === href || path.startsWith(href + "/") || (href === "/mints" && path.startsWith("/t/"))) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  for (const a of main.querySelectorAll(".rail-link[href]")) {
    const href = a.getAttribute("href");
    const on = a.dataset.exact ? path === href : path === href || path.startsWith(href + "/");
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  }
  $(".ledger").classList.toggle("is-sticky", path.startsWith("/app") || path === "/explorer");
}

function viewRoot(layout, enter = true) {
  const fresh = document.createElement("div");
  fresh.className = enter ? "view page-enter" : "view";
  if (layout === "app") {
    let l = main.querySelector(":scope > .app-layout");
    if (!l) {
      main.replaceChildren(toNode(appLayout()));
      l = main.querySelector(":scope > .app-layout");
    }
    l.dataset.wallet = getWalletStatus().state;
    l.querySelector(".app-content").replaceChildren(fresh);
  } else {
    main.replaceChildren(fresh);
  }
  return fresh;
}

function placeholder(root, meta, path) {
  // Inside /app the content column is already a container.
  const wrap = meta.layout === "app" ? "" : "container section";
  root.innerHTML = html`<div class="${wrap}"><section class="panel panel--certified placeholder">
    ${glyphSVG({ size: 40 })}
    <div class="eyebrow">${path}</div>
    <h1 class="h1-app">${meta.title ?? "This page"} is coming soon.</h1>
    <p>This page is part of the ${BRAND} v1 build and isn't in this version of the site yet. Everything that is here works against live ${IS_SIGNET ? "signet" : "Bitcoin mainnet"} data.</p>
    <div class="cluster">${button({ label: "Go to the home page", href: "/", kind: "secondary" })}${button({ label: "Open the explorer", href: "/explorer", kind: "ghost" })}</div>
  </section></div>`;
}

function notFound(root) {
  root.innerHTML = html`<div class="container section"><section class="panel panel--certified placeholder">
    ${glyphSVG({ size: 40 })}
    <div class="eyebrow">404</div>
    <h1 class="h1-app">Nothing at this path.</h1>
    <p>Bitcoin never forgets, but this page never existed. Search for a transaction, a nullifier or a ticker instead.</p>
    <div class="notfound-search">${searchForm("page")}</div>
    ${button({ label: "Go to the home page", href: "/", kind: "secondary" })}
  </section></div>`;
  wireSearch(root);
}

function failed(root, err) {
  root.innerHTML = html`<div class="container section"><section class="panel placeholder" role="alert">
    <div class="eyebrow t-danger">${icon("warn", { size: 14 })} Page error</div>
    <h1 class="h1-app">This page failed to load.</h1>
    <p>Reload the page. If it keeps failing, the details below help us find the cause.</p>
    <pre>${String(err?.message ?? err)}</pre>
    ${button({ label: "Reload", kind: "secondary", action: "reload", icon: "refresh" })}
  </section></div>`;
  root.querySelector("[data-action=reload]")?.addEventListener("click", () => location.reload());
}

let cleanup = null;
let seq = 0;
let shownPath = null; // pathname + search of the mounted view

async function mount(match, url) {
  const mine = ++seq;
  closeAllPopovers();
  const meta = match?.route.meta ?? { name: "notfound", layout: "public", title: "Not found" };
  const loader = match?.route.loader;
  // The next view's module loads while the current view stays up: emptying main first left
  // it blank (and pulled the footer up) for as long as a first-visit chunk took to arrive.
  let mod = null;
  let loadError = null;
  if (loader) {
    try {
      mod = await loader();
    } catch (e) {
      loadError = e;
    }
    if (mine !== seq) return;
  }
  const prev = cleanup;
  cleanup = null;
  try {
    await prev?.();
  } catch (e) {
    console.error(e);
  }
  if (mine !== seq) return;
  setTitle(meta.title);
  // A re-render of the same page (lock, unlock) swaps in place, without the page-in fade.
  const path = url.pathname + url.search;
  const root = viewRoot(meta.layout, path !== shownPath);
  shownPath = path;
  markCurrent(url.pathname);
  paintTabbar();
  main.focus({ preventScroll: true });
  if (!loader) {
    if (meta.name === "notfound") notFound(root);
    else placeholder(root, meta, url.pathname);
    return;
  }
  try {
    if (loadError) throw loadError;
    const params = { ...(meta.params ?? {}), ...(match.params ?? {}) };
    const out = await mod.render(root, params, url.searchParams);
    if (mine !== seq) {
      if (typeof out === "function") out();
      return;
    }
    cleanup = typeof out === "function" ? out : null;
  } catch (e) {
    console.error(e);
    if (mine === seq) failed(root, e);
  }
}

/* ---------- global actions ---------- */

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-action], [data-rootchip]");
  if (!a || !app.contains(a) && !a.closest(".sheet-layer")) return;
  if (a.matches("[data-rootchip]")) return onRootChip(a);
  switch (a.dataset.action) {
    case "open-search":
      return openSearchSheet();
    case "streamer-toggle":
      return toggleStreamer();
    case "theme-menu":
      return themeMenu(a);
    case "wallet-menu":
      return walletMenu(a);
    case "tab-more":
      return openMore();
    case "relay-topup":
      return topUp();
    case "lock-now":
      if (a.closest(".app-rail")) lockNow();
      return;
  }
});

/* ---------- start ---------- */

paintRoot();
paintWallet();
paintLedger();
start({ mount });

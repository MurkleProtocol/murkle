// Add BTC: the deposit sheet for the built-in key (web/src/views/deposit.js) and its
// entry points. Runs on a fake DOM with fake storage; no network: the payer's UTXO
// read, checkBtc and the indexer poll are stubbed per test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ---------- a minimal DOM: sheets, toasts, view roots, recorded listeners ---------- */

const made = []; // every markup string turned into nodes
class FakeEl {
  constructor(markup = "") {
    this.markup = String(markup);
    this.sel = new Map();
    this.ls = {};
    this.attrs = {};
    this.dataset = {};
    this.innerHTML = "";
    this.hidden = false;
    const set = new Set();
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: () => {} };
  }
  querySelector(s) {
    if (!this.sel.has(s)) this.sel.set(s, new FakeEl());
    return this.sel.get(s);
  }
  querySelectorAll() {
    return [];
  }
  addEventListener(t, fn) {
    (this.ls[t] ??= []).push(fn);
  }
  removeEventListener(t, fn) {
    this.ls[t] = (this.ls[t] ?? []).filter((f) => f !== fn);
  }
  append() {}
  replaceChildren() {}
  remove() {}
  focus() {}
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
}
globalThis.Node = FakeEl;
globalThis.document = {
  createElement() {
    const t = { content: null };
    Object.defineProperty(t, "innerHTML", {
      set(v) {
        made.push(String(v));
        const el = new FakeEl(v);
        t.content = { childNodes: [el], firstChild: el };
      },
    });
    return t;
  },
  body: new FakeEl(),
  documentElement: new FakeEl(),
  activeElement: null,
  hidden: false,
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
  hasFocus: () => true,
};
globalThis.requestAnimationFrame = () => 0;
// Reduced motion: sheets finish closing (and call onClose) right away.
globalThis.matchMedia = (q) => ({ matches: q.includes("reduced-motion") });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
let url = new URL("https://murkle.example/app");
globalThis.location = {
  get href() { return url.href; },
  get origin() { return url.origin; },
  get pathname() { return url.pathname; },
  get search() { return url.search; },
  get hash() { return url.hash; },
};
const clipboard = [];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async (t) => void clipboard.push(t) } } });

const S = await import("../web/src/session.js");
const { esc, html } = await import("../web/src/ui/dom.js");
const { icon } = await import("../web/src/ui/icons.js");
const { closeAllSheets, openSheet } = await import("../web/src/ui/sheet.js");
const { dismiss } = await import("../web/src/ui/toast.js");
const api = await import("../web/src/api.js");
const D = await import("../web/src/views/deposit.js");
const { provingSheet, lacksBtc, maskError } = await import("../web/src/views/app-shared.js");
const { renderPortfolio } = await import("../web/src/views/app-portfolio.js");
const { mintView, emptyKeyNotice } = await import("../web/src/views/app-mint.js");
const { launchView } = await import("../web/src/views/app-launch.js");
const { settingsView } = await import("../web/src/views/app-settings.js");
const { planCarrierTx } = await import("../src/btc/funding.mjs");

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const text = (m) => String(m).replace(/<[^>]+>/g, "");
const tick = () => new Promise((r) => setImmediate(r));
const bodyOf = () => [...made].reverse().find((m) => m.includes("data-dep-addr")) ?? "";
const clearToasts = () => {
  for (let i = 1; i <= 80; i++) dismiss(`t${i}`);
};

/** A click on a control with data-action="act", as delegated handlers see it. */
const clickOn = (act) => {
  const el = { dataset: { action: act }, disabled: false };
  return { target: { closest: (sel) => (sel === "[data-action]" || sel === `[data-action=${act}]` ? el : null), matches: () => false } };
};
const fire = (el, type, ev) => (el.ls[type] ?? []).map((fn) => fn(ev));

/** A session with no network: UTXOs from `coins`, checkBtc counted, sync a no-op. */
function wallet() {
  const s = new S.Session({ phrase: S.newPhrase() });
  const stub = { coins: [], reads: 0, checks: 0 };
  s.localPayer.utxos = async () => (stub.reads++, stub.coins);
  s.checkBtc = async () => {
    stub.checks++;
    s.btc = { sats: stub.coins.reduce((a, u) => a + u.value, 0), at: Date.now() };
    return s.btc.sats;
  };
  s.sync = async () => {};
  s.loadRelayInfo = async () => (s.relayInfo = { address: null });
  return { s, stub };
}
const watcher = () => {
  const fns = new Set();
  return { fns, watch: (fn) => (fns.add(fn), () => fns.delete(fn)), tick: () => [...fns].forEach((fn) => fn({ height: 1 })) };
};
const conf = (value) => ({ txid: "aa".repeat(32), vout: 0, value, status: { confirmed: true } });
const pend = (value) => ({ txid: "bb".repeat(32), vout: 1, value, status: { confirmed: false } });

/* ---------- pure parts ---------- */

test("coins split into confirmed and unconfirmed; the sheet's states", () => {
  assert.deepEqual(D.splitCoins([conf(1000), pend(500), conf(20)]), { confirmed: 1020, unconfirmed: 500, total: 1520, count: 3 });
  assert.deepEqual(D.splitCoins([]), { confirmed: 0, unconfirmed: 0, total: 0, count: 0 });
  assert.equal(D.depositState({}), "loading");
  assert.equal(D.depositState({ error: "x" }), "error");
  assert.equal(D.depositState({ coins: { total: 0 } }), "waiting");
  assert.equal(D.depositState({ coins: { total: 5, unconfirmed: 5 } }), "mempool");
  assert.equal(D.depositState({ coins: { total: 5, unconfirmed: 0 }, error: "x" }), "funded", "a failed re-check keeps the last result");
  // Automatic checks ride the 20 s indexer poll: the first tick after 30 s.
  assert.equal(D.autoEverySeconds(20_000), 40);
  assert.match(D.lookupNote(), /asks mempool\.space about this address, so it sees your IP/);
  assert.match(D.lookupNote(), /about every 40 s while it stays open \(up to 30 min\)/);
});

/* ---------- the sheet ---------- */

test("the sheet shows the full address, a QR code, Copy, the balance and the advice", async (t) => {
  t.after(() => (closeAllSheets(), clearToasts()));
  const { s, stub } = wallet();
  const w = watcher();
  const d = D.openDeposit(s, { esplora: {}, watch: w.watch });
  const body = bodyOf();
  const address = s.localPayer.address;
  assert.match(address, /^tb1p/);
  assert.ok(text(body).includes(address), "the address in full");
  assert.match(body, /class="qr-tile"><svg class="qr"[^>]*aria-label="QR code of your built-in Bitcoin address"/);
  assert.match(body, /data-autofocus data-action="dep-copy"/, "Copy gets focus first");
  assert.match(body, /aria-live="polite"/, "the balance line is announced");
  for (const a of D.ADVICE) assert.ok(body.includes(esc(a)), a);
  assert.ok(body.includes(esc(D.SIGNET_NOTE)));
  assert.match(D.ADVICE[0], /direct withdrawal from an exchange/);
  assert.match(D.ADVICE[0], /The exchange itself knows where it sent the coins\./);
  assert.match(D.ADVICE[1], /visible on Bitcoin \(mints are public anyway\)\. It pays the private sends you pay yourself too, and each one is tied to its address/);
  assert.doesNotMatch(D.ADVICE.join(" "), /need no BTC|Ghost Relay|for free/i, "the built-in key pays private sends now (paid-relay.md stage 0)");
  assert.match(D.SIGNET_NOTE, /exchanges don't list them\. On signet, get free coins from a faucet instead\. The faucet sees your IP and the address you paste\./);
  // One outside link: a faucet that answered when checked (signetfaucet.com gave 522), in a new tab.
  assert.equal(D.SIGNET_FAUCET, "https://alt.signetfaucet.com");
  assert.deepEqual([...body.matchAll(/<a [^>]*href="([^"]*)"/g)].map((m) => m[1]), [D.SIGNET_FAUCET]);
  assert.match(body, /<a href="https:\/\/alt\.signetfaucet\.com" target="_blank" rel="noopener noreferrer">Open alt\.signetfaucet\.com ↗<\/a>/);
  assert.ok(!/anonym|untraceable|trustless|can't be linked|unlinkable/i.test(body), "no overclaims");
  assert.match(body, /Checking mempool\.space…/, "loading first, never a made-up zero");

  // First read: empty, so it waits; checkBtc tells the views underneath.
  await tick();
  const status = () => String(d.sheet.body.querySelector("[data-dep-status]").innerHTML);
  assert.match(status(), /Waiting for coins/);
  assert.match(status(), /0 sats/);
  assert.equal(stub.reads, 1);
  assert.equal(stub.checks, 1, "s.btc was unknown: one checkBtc so open views repaint");

  // The indexer poll ticks; too soon after the last read: nothing.
  w.tick();
  await tick();
  assert.equal(stub.reads, 1);

  // A deposit reaches the mempool.
  stub.coins = [pend(5000)];
  d.state.lastCheck = 0;
  w.tick();
  await tick();
  assert.equal(stub.reads, 2);
  assert.match(status(), /Coins arrived, waiting for a block/);
  assert.match(status(), /5,000 sats/);
  assert.equal(stub.checks, 2);
  assert.ok(made.some((m) => m.includes("Signet BTC arrived.") && m.includes("5,000 sats reached your built-in key, waiting for a block.")), "a toast says so");

  // It confirms: same total, no extra checkBtc.
  stub.coins = [conf(5000)];
  d.state.lastCheck = 0;
  w.tick();
  await tick();
  assert.match(status(), /Funded/);
  assert.match(status(), /Ready to pay mints and launches\./);
  assert.equal(stub.checks, 2);

  // Automatic checks stop after AUTO_FOR_MS; Check again restarts them.
  d.state.since = Date.now() - D.AUTO_FOR_MS - 1;
  d.state.lastCheck = 0;
  w.tick();
  await tick();
  assert.equal(stub.reads, 3);
  fire(d.sheet.el, "click", clickOn("dep-check"));
  await tick();
  assert.equal(stub.reads, 4);
  assert.ok(Date.now() - d.state.since < 1000, "the window restarted");

  // Copy uses the clipboard; one sheet at a time; closing unsubscribes.
  await Promise.all(fire(d.sheet.el, "click", clickOn("dep-copy")));
  assert.equal(clipboard.at(-1), address);
  assert.equal(D.openDeposit(s, { esplora: {}, watch: w.watch }), d);
  assert.equal(w.fns.size, 1);
  d.sheet.close();
  assert.equal(w.fns.size, 0, "no polling once closed");
  assert.equal(d.state.closed, true);
});

test("Add BTC pressed while the sheet is still closing opens it again once it's gone", async (t) => {
  const mm = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: false }); // motion on: a sheet takes 240 ms to close
  t.after(() => ((globalThis.matchMedia = mm), closeAllSheets(), clearToasts()));
  const { s } = wallet();
  const w = watcher();
  const opts = { esplora: {}, watch: w.watch };
  const settle = () => new Promise((r) => setTimeout(r, 300));
  const hit = (sel) => ({ target: { closest: (q) => (q === sel ? {} : null), matches: (q) => q === sel } });
  const ways = {
    x: (d) => fire(d.sheet.el, "click", hit("[data-sheet-close]")),
    scrim: (d) => fire(d.sheet.el, "click", hit("[data-scrim]")),
    esc: (d) => fire(d.sheet.el, "keydown", { key: "Escape", stopPropagation() {} }),
    close: (d) => d.sheet.close(),
    lock: () => closeAllSheets(),
  };
  let d = D.openDeposit(s, opts);
  for (const [how, shut] of Object.entries(ways)) {
    assert.equal(d.state.closing, false, how);
    shut(d);
    assert.equal(d.state.closing, true, `${how}: noted as it starts`);
    assert.equal(d.state.closed, false, `${how}: still animating out`);
    assert.equal(D.openDeposit(s, opts), null, `${how}: not the closing sheet`);
    assert.equal(D.openDeposit(s, opts), null, `${how}: pressed twice`);
    await settle();
    assert.equal(d.state.closed, true, how);
    const next = D.openDeposit(s, opts);
    assert.ok(next && next !== d && !next.state.closing, `${how}: a fresh sheet is open`);
    assert.equal(w.fns.size, 1, `${how}: one sheet polling, once`);
    d = next;
  }
  // Closed and not pressed again: nothing reopens.
  d.sheet.close();
  await settle();
  assert.equal(w.fns.size, 0);
});

test("a failed read says so and keeps nothing made up", async (t) => {
  t.after(() => (closeAllSheets(), clearToasts()));
  const { s } = wallet();
  s.localPayer.utxos = async () => {
    throw new Error(`GET /address/${s.localPayer.address}/utxo: 503`);
  };
  const d = D.openDeposit(s, { esplora: {}, watch: watcher().watch });
  await tick();
  const st = String(d.sheet.body.querySelector("[data-dep-status]").innerHTML);
  assert.match(st, /Couldn't read the balance\./);
  assert.match(st, /mempool\.space didn&#39;t answer\. Check your connection, then press Check again\./);
  assert.ok(!st.includes(s.localPayer.address), "the raw error (with the address) isn't shown");
  assert.ok(!/0 sats/.test(st));
});

test("streamer mode masks the address and the QR until shown, and the amounts", async (t) => {
  t.after(() => (closeAllSheets(), clearToasts(), S.setStreamerMode(false)));
  const { s, stub } = wallet();
  const address = s.localPayer.address;
  S.setStreamerMode(true);
  stub.coins = [pend(7777)];
  const w = watcher();
  const d = D.openDeposit(s, { esplora: {}, watch: w.watch });
  const body = bodyOf();
  assert.ok(!body.includes(address) && !body.includes(address.slice(4, 20)), "no address anywhere in the markup, not even a title");
  assert.ok(!body.includes("qr-tile"), "no QR");
  assert.match(body, /class="dep-qr-mask" role="img" aria-label="QR code hidden in streamer mode"/);
  assert.match(body, /class="redact redact--address"/);
  assert.match(body, /data-action="dep-reveal"/);
  assert.match(text(body), /Show address/);

  await tick();
  const status = () => String(d.sheet.body.querySelector("[data-dep-status]").innerHTML);
  assert.ok(!status().includes("7,777"), "amounts stay hidden");
  assert.match(status(), /redact--amount/);

  // Copy works without showing anything.
  await Promise.all(fire(d.sheet.el, "click", clickOn("dep-copy")));
  assert.equal(clipboard.at(-1), address);

  // Show: address and QR appear in this sheet only.
  const slot = () => String(d.sheet.body.querySelector("[data-dep-addr]").innerHTML);
  fire(d.sheet.el, "click", clickOn("dep-reveal"));
  assert.ok(text(slot()).includes(address));
  assert.match(slot(), /class="qr-tile"/);
  assert.match(text(slot()), /Hide address/);
  fire(d.sheet.el, "click", clickOn("dep-reveal"));
  assert.ok(!slot().includes(address));

  // Shown, then streamer mode is switched off and on again: hidden again.
  fire(d.sheet.el, "click", clickOn("dep-reveal"));
  S.setStreamerMode(false);
  assert.ok(text(slot()).includes(address));
  assert.ok(!/dep-reveal/.test(slot()), "no Show button outside streamer mode");
  S.setStreamerMode(true);
  assert.ok(!slot().includes(address), "a new streamer session starts hidden");

  // An arrival toast carries no amount.
  stub.coins = [pend(7777), pend(1111)];
  d.state.lastCheck = 0;
  w.tick();
  await tick();
  const toastMarkup = [...made].reverse().find((m) => m.includes("Signet BTC arrived."));
  assert.ok(toastMarkup && toastMarkup.includes("Your built-in key received coins.") && !/1,111|8,888/.test(toastMarkup));
});

test("with Unisat as the payer, the sheet says Unisat pays and this funds the built-in key", async (t) => {
  const { s } = wallet();
  s.payerPref = "unisat";
  t.after(() => ((s.payerPref = "local"), closeAllSheets(), clearToasts()));
  D.openDeposit(s, { esplora: {}, watch: watcher().watch });
  const body = bodyOf();
  assert.match(body, /Unisat pays your mints and launches now\./);
  assert.match(body, /adds BTC to the built-in key instead, which pays only once you pick it as the payer/);
  assert.match(body, /href="\/app\/settings#fees" data-link data-sheet-close>Fee settings</);
  assert.equal(String(D.payerNote(s, { here: "/app/settings" })).includes("Fee settings"), false, "no link to the page you're on");
  s.payerPref = "local";
  assert.equal(String(D.payerNote(s)), "");
  assert.match(String(D.statusBlock({ coins: { total: 5, confirmed: 5, unconfirmed: 0, at: Date.now() }, unisat: true })), /Ready for when you pick the built-in key as the payer\./);
});

/* ---------- the proving sheet: not enough BTC -> Add BTC ---------- */

test("a failure for lack of BTC on the built-in key offers Add BTC; others don't", async () => {
  const { s } = wallet();
  const other = wallet().s;
  let real;
  try {
    planCarrierTx({ account: s.localPayer.account, utxos: [], envelope: new Uint8Array(471), feeRate: 2 });
  } catch (e) {
    real = e.message;
  }
  assert.match(real, /^not enough BTC at tb1p\w+: have 0 sats, need \d+/);
  assert.equal(lacksBtc(new Error(real), s), true);
  assert.equal(lacksBtc(new Error(real), other), false, "another address isn't this key");
  assert.equal(lacksBtc(new Error(maskError(real)), null), true, "the streamer-masked text too");
  assert.equal(lacksBtc(new Error("Your built-in address has no signet BTC. Add BTC to it, then mint again."), null), true);
  assert.equal(lacksBtc(new Error("Unisat can pay only one output per transaction."), s), false);
  assert.equal(lacksBtc(new Error("Root mismatch: the tree rebuilt in your browser differs from the indexer's."), s), false);
  assert.equal(lacksBtc(null, s), false);

  const host = (pv) => String(pv.sheet.body.querySelector("[data-pv]").innerHTML);
  const steps = [{ id: "payer", label: "Pick and bind your coin (A-6)" }];
  const pv = provingSheet({ title: "Minting ABC", steps });
  pv.fail(new Error("Your built-in address has no signet BTC. Add BTC to it, then mint again."));
  assert.match(host(pv), /data-action="add-btc"/);
  assert.match(text(host(pv)), /Add BTC/);
  assert.match(text(host(pv)), /Close/);
  // The button opens the sheet (loaded on first use); with no unlocked wallet there is none to open.
  const opened = fire(pv.sheet.el, "click", clickOn("add-btc")).filter(Boolean);
  assert.equal(opened.length, 1);
  assert.equal(await opened[0], null);

  S.setStreamerMode(true);
  try {
    const masked = provingSheet({ title: "Sending", steps });
    masked.fail({ message: maskError(real) });
    assert.match(host(masked), /data-action="add-btc"/);
  } finally {
    S.setStreamerMode(false);
  }
  const plain = provingSheet({ title: "Minting ABC", steps });
  plain.fail(new Error("ABC isn't open for minting right now (ended)."));
  assert.ok(!host(plain).includes("add-btc"));
  closeAllSheets();
  const mint = src("web/src/views/app-mint.js");
  assert.match(mint, /sheet\.fail\(err\); \/\/ lack of BTC on the built-in key: the sheet offers Add BTC/);
  assert.ok(!/FAUCET|Open the faucet/.test(mint), "no dead faucet link");
});

/* ---------- entry points ---------- */

test("Portfolio: Add BTC sits at the top next to the balance, and in the fee card", async (t) => {
  t.after(() => (closeAllSheets(), clearToasts()));
  const { s } = wallet();
  const root = new FakeEl();
  const off = renderPortfolio(root, s);
  t.after(off);
  const page = String(root.innerHTML);
  assert.equal(page.match(/data-action="add-btc"/g)?.length, 2);
  assert.match(page, /BTC FOR FEES · BUILT-IN KEY/);
  assert.ok(page.indexOf("fund-strip") < page.indexOf("wl-cols"), "above the two columns, not bottom right");
  assert.ok(page.indexOf("fund-strip") > page.indexOf('class="quick"'), "right under Send, Receive, Mint");
  assert.match(text(page), /Balance not checked/);
  assert.match(text(page), /only when you press Check BTC, open Add BTC or right before a mint/);

  s.btc = { sats: 0, at: Date.now() };
  const low = new FakeEl();
  const off2 = renderPortfolio(low, s);
  t.after(off2);
  assert.match(String(low.innerHTML), /fund-strip is-low/);
  assert.match(text(low.innerHTML), /Add signet BTC before your first mint, launch or private send you pay yourself\./);

  // The button opens the sheet.
  const before = made.length;
  fire(low, "click", clickOn("add-btc"));
  assert.ok(made.slice(before).some((m) => m.includes('aria-label="Add BTC to your built-in key"')));
  closeAllSheets();
});

test("Mint, Launch and Settings offer Add BTC where the payer is chosen", async (t) => {
  t.after(() => (closeAllSheets(), clearToasts()));
  const { s } = wallet();
  s.btc = { sats: 0, at: Date.now() };

  const mint = new FakeEl();
  const offMint = mintView(mint, s, null);
  t.after(offMint);
  assert.match(String(mint.innerHTML), /Your built-in key has no BTC\./, "said up top when the key is empty");
  assert.equal(String(mint.innerHTML).match(/data-action="add-btc"/g)?.length, 2, "the notice and the Paid by panel");
  assert.equal(String(emptyKeyNotice({ payerPref: "local", btc: null })), "", "not before a check");
  assert.equal(String(emptyKeyNotice({ payerPref: "unisat", btc: { sats: 0 } })), "");

  const origFee = api.esplora.feeRate;
  api.esplora.feeRate = async () => 2;
  t.after(() => (api.esplora.feeRate = origFee));
  const launch = new FakeEl();
  const offLaunch = launchView(launch, s);
  t.after(offLaunch);
  assert.match(String(launch.querySelector("[data-fund]").innerHTML), /data-action="add-btc"/);
  assert.match(String(launch.querySelector("[data-fund]").innerHTML), /Your built-in key has no BTC\. Add signet BTC before you launch\./);
  assert.match(String(launch.querySelector("[data-cta]").innerHTML), /Add signet BTC to your built-in key first\./);
  const before = made.length;
  fire(launch, "click", clickOn("add-btc"));
  assert.ok(made.slice(before).some((m) => m.includes('aria-label="Add BTC to your built-in key"')));
  closeAllSheets();

  const settings = new FakeEl();
  const offSettings = settingsView(settings, s);
  t.after(offSettings);
  await tick();
  const page = String(settings.innerHTML);
  assert.match(page, /id="fees"[\s\S]*data-action="add-btc"/);
  assert.ok(!/signetfaucet|>Faucet</.test(page), "no dead faucet link");
  assert.match(text(page), /Add BTC shows the built-in key&#39;s address/);
  s.payerPref = "unisat";
  t.after(() => (s.payerPref = "local"));
  const uni = new FakeEl();
  t.after(settingsView(uni, s));
  assert.match(text(uni.innerHTML), /Unisat pays from its own address\. Add BTC funds the built-in key, for when you pick it instead\./);
});

/**
 * app.js can't load under node (import.meta.glob, CSS imports), so its addBtc, walletMenu and
 * openMore are lifted from the source and run against stubs and the real openSheet.
 */
function shell({ load, unlocked = true } = {}) {
  const app = src("web/src/app.js");
  const grab = (re) => app.match(re)?.[0] ?? assert.fail(`not in app.js: ${re}`);
  const code = [/const addBtc = [\s\S]*?\n\n/, /function walletMenu[\s\S]*?\n}\n/, /function openMore[\s\S]*?\n}\n/].map(grab).join("\n");
  const log = [];
  const views = { "./views/deposit.js": async () => ({ openDeposit: () => (log.push("deposit opened"), "sheet") }) };
  if (load !== undefined) views["./views/deposit.js"] = load;
  const ui = { menu: null, more: null };
  const deps = {
    views,
    toast: (o) => log.push(`toast: ${o.title} ${o.body}`),
    getWalletStatus: () => ({ state: unlocked ? "unlocked" : "locked" }),
    openPopover: (anchor, body) => (ui.menu = { el: new FakeEl(body), close: () => log.push("menu closed") }),
    openSheet: (o) => {
      const sh = openSheet(o);
      const close = sh.close;
      sh.close = () => (log.push("more closed"), close());
      return (ui.more = sh);
    },
    html,
    icon,
    lockNow: () => log.push("locked"),
    streamerOn: () => false,
    themeControl: () => "",
    REPO_URL: null,
  };
  const fns = new Function(...Object.keys(deps), `${code}\nreturn { addBtc, walletMenu, openMore };`)(...Object.values(deps));
  return { ...fns, ui, log };
}

test("the wallet menu and the More sheet open Add BTC", async (t) => {
  t.after(() => closeAllSheets());
  // Wallet menu: a menu item that closes the menu, then opens the sheet.
  let sh = shell();
  sh.walletMenu(new FakeEl());
  assert.match(sh.ui.menu.el.markup, /<button type="button" data-action="add-btc" role="menuitem"><svg[^]*?<\/svg>Add BTC<\/button>/);
  assert.ok(sh.ui.menu.el.markup.indexOf("add-btc") < sh.ui.menu.el.markup.indexOf("/app/settings"), "between Portfolio and Settings");
  assert.equal(await fire(sh.ui.menu.el, "click", clickOn("add-btc"))[0], "sheet");
  assert.deepEqual(sh.log, ["menu closed", "deposit opened"]);

  // More (phone): the row closes More first; the sheet opens from More's onClose.
  sh = shell();
  const before = made.length;
  sh.openMore();
  const more = made.slice(before).find((m) => m.includes('class="more-list"'));
  assert.match(more, /<button type="button" data-action="add-btc"><svg[^]*?<\/svg><span>Add BTC<\/span><\/button>/);
  assert.ok(more.indexOf("add-btc") > more.indexOf("/app/receive"), "after Receive");
  fire(sh.ui.more.el, "click", clickOn("add-btc"));
  await tick();
  assert.deepEqual(sh.log, ["more closed", "deposit opened"]);
  // Outside the unlocked wallet, More has no Add BTC.
  const out = shell({ unlocked: false });
  const b2 = made.length;
  out.openMore();
  assert.ok(!made.slice(b2).find((m) => m.includes('class="more-list"')).includes("add-btc"));
  closeAllSheets();

  // The view chunk fails to load, or isn't there: a toast, not a silent rejection.
  sh = shell({ load: () => Promise.reject(new Error("Failed to fetch dynamically imported module")) });
  sh.walletMenu(new FakeEl());
  await fire(sh.ui.menu.el, "click", clickOn("add-btc"))[0];
  assert.deepEqual(sh.log, ["menu closed", "toast: Couldn't open Add BTC. Failed to fetch dynamically imported module"]);
  sh = shell({ load: null });
  sh.openMore();
  fire(sh.ui.more.el, "click", clickOn("add-btc"));
  await tick();
  await tick();
  assert.equal(sh.log[0], "more closed");
  assert.match(sh.log[1], /^toast: Couldn't open Add BTC\./);
});

test("deposit styles: fluid at 375 px, QR on a white tile, mask hatched", () => {
  const all = src("web/src/styles/pages.css");
  const css = all.slice(all.indexOf("/* ---------- Add BTC"), all.indexOf("/* ---------- placeholder"));
  assert.ok(css.length > 200);
  assert.match(css, /\.dep-addr \{ display: grid; gap: 16px; grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /@media \(min-width: 480px\) \{ \.dep-addr \{ grid-template-columns: auto minmax\(0, 1fr\);/);
  assert.match(css, /\.dep-qr-mask \{\n\s+width: 176px; height: 176px;[^}]*background: var\(--hatch\), var\(--redact\);/);
  assert.match(css, /\.fund-strip \{\n\s+display: flex; flex-wrap: wrap;/);
  assert.match(css, /\.fund-main \{[^}]*min-width: 0;/);
  // 176 px tile + sheet padding fits a 375 px phone; nothing wider is fixed.
  for (const m of css.matchAll(/(?:^|[;{\s])width: (\d+)px/gm)) assert.ok(Number(m[1]) <= 343, m[0]);
});

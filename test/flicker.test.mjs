// UI stability during the first sync after load: the in-app causes of flicker, each
// pinned down so it can't come back.
// - A sync builds its view off to the side: no half-built view on a repaint, and a failed or
//   mismatched sync (an indexer restart) keeps the verified view instead of swapping it out.
// - After a failed sync the next poll retries, so the error clears without waiting a block.
// - Two unlocked tabs write a status both derived from the same block once, not once per tab,
//   and a write that changes nothing here repaints nothing.
// - Navigation keeps the current view until the next one's module has loaded; a re-render of
//   the same page (lock, unlock) has no page-in fade.
// - Polls with unchanged data leave the ledger strip, the lattice and the root chip alone; the
//   proving sheet's clock doesn't restart its spinner; a provenance chip never fades twice.
// The main cause was outside the app: the Vite dev server reloads every open tab whenever a
// source file is saved. That is covered by the dev-only notice checked at the end.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ---------- a minimal DOM that records every innerHTML write ---------- */

let reduce = true; // reduced motion: sheets close (and call onClose) at once
class FakeEl {
  constructor(markup = "") {
    this.markup = String(markup);
    this.sel = new Map();
    this.all = {};
    this.ls = {};
    this.attrs = {};
    this.dataset = {};
    this.writes = [];
    this.html = "";
    this.children = [];
    this.className = "";
    this.hidden = false;
    this.classAdds = [];
    const set = new Set();
    this.classList = {
      add: (c) => (this.classAdds.push(c), set.add(c)),
      remove: (c) => set.delete(c),
      contains: (c) => set.has(c),
      toggle: () => {},
    };
  }
  get innerHTML() {
    return this.html;
  }
  set innerHTML(v) {
    this.html = String(v);
    this.writes.push(this.html);
  }
  querySelector(s) {
    if (!this.sel.has(s)) this.sel.set(s, new FakeEl());
    return this.sel.get(s);
  }
  querySelectorAll(s) {
    return this.all[s] ?? [];
  }
  addEventListener(t, fn) {
    (this.ls[t] ??= []).push(fn);
  }
  removeEventListener(t, fn) {
    this.ls[t] = (this.ls[t] ?? []).filter((f) => f !== fn);
  }
  append() {}
  replaceChildren(...nodes) {
    this.children = nodes;
  }
  remove() {}
  focus() {}
  setAttribute(k, v) {
    this.attrs[k] = String(v);
  }
  hasAttribute(k) {
    return k in this.attrs;
  }
}
globalThis.Node = FakeEl;
globalThis.document = {
  createElement(tag) {
    if (tag !== "template") return new FakeEl();
    const t = { content: null };
    Object.defineProperty(t, "innerHTML", {
      set(v) {
        const el = new FakeEl(v);
        t.content = { childNodes: [el], firstChild: el };
      },
    });
    return t;
  },
  body: new FakeEl(),
  documentElement: new FakeEl(),
  activeElement: null,
  hidden: true, // no 20 s poll timer: the tests poll with api.refreshState()
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
  hasFocus: () => true,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.matchMedia = (q) => ({ matches: q.includes("reduced-motion") ? reduce : false, addEventListener() {} });
// session.js listens for "storage" (another tab wrote the vault); keep that listener.
const storageListeners = [];
globalThis.addEventListener = (type, fn) => type === "storage" && storageListeners.push(fn);
globalThis.removeEventListener = () => {};
let url = new URL("https://murkle.example/app");
globalThis.location = {
  get href() { return url.href; },
  get origin() { return url.origin; },
  get pathname() { return url.pathname; },
  get search() { return url.search; },
  get hash() { return url.hash; },
};
globalThis.history = {
  state: null,
  pushState(st, _t, u) { this.state = st; if (u) url = new URL(u, url); },
  replaceState(st, _t, u) { this.state = st; if (u) url = new URL(u, url); },
};
globalThis.scrollTo = () => {};

/* ---------- a fake indexer ---------- */

const net = { height: 100, startHeight: 90, outs: [], badRoot: null, down: false, onOutputs: null, gate: null, calls: [] };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let rootOf;
globalThis.fetch = async (input) => {
  const u = new URL(String(input), "http://indexer.test");
  net.calls.push(u.pathname);
  if (net.gate?.path === u.pathname) await net.gate.promise;
  if (net.down) return reply(500, { error: { message: "The indexer is restarting. Try again in a minute." } });
  switch (u.pathname) {
    case "/api/state":
      return reply(200, { height: net.height, startHeight: net.startHeight, root: net.badRoot ?? rootOf(net.outs), outputs: net.outs.length, nullifiers: 0, chainTip: net.height, syncing: false, lastSync: Date.now() });
    case "/api/outputs": {
      const from = Number(u.searchParams.get("from") ?? 0);
      const to = Number(u.searchParams.get("to") ?? net.outs.length);
      const out = net.outs.slice(from, to);
      net.onOutputs?.();
      return reply(200, out);
    }
    case "/api/nullifiers":
      return reply(200, []);
    case "/api/assets":
      return reply(200, [{ id: "7", ticker: "MURK", divisibility: 0, status: "live", mintAmount: "50", priceSats: "0", treasury: null }]);
    case "/api/log":
      return reply(200, { items: [], next: null, total: 0 });
    default:
      return reply(404, { error: { message: "Not found." } });
  }
};

const keystore = await import("../web/src/keystore.js");
const { STORAGE_PREFIX } = await import("../web/src/config.js");
const S = await import("../web/src/session.js");
const api = await import("../web/src/api.js");
const { html, setHTML, toNode } = await import("../web/src/ui/dom.js");
const { icon } = await import("../web/src/ui/icons.js");
const fmt = await import("../web/src/ui/format.js");
const { getRootStatus } = await import("../web/src/ui/status.js");
const { mountLattice } = await import("../web/src/ui/lattice.js");
const { prov, upgrade } = await import("../web/src/ui/prov.js");
const { closeAllSheets } = await import("../web/src/ui/sheet.js");
const { dismiss } = await import("../web/src/ui/toast.js");
const { provingSheet, liveSession } = await import("../web/src/views/app-shared.js");
const { renderPortfolio } = await import("../web/src/views/app-portfolio.js");
const { MerkleTree, commitmentOf, randomField } = await import("../src/core.mjs");
const { encryptNote } = await import("../src/keys.mjs");
const { hex } = await import("../src/bytes.mjs");

rootOf = (outs) => {
  const t = new MerkleTree();
  for (const o of outs) t.insert(BigInt(o.commitment));
  return t.root().toString();
};

const PW = "correct horse battery";
const VAULT = keystore.vaultKey(STORAGE_PREFIX);
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tick = () => new Promise((r) => setImmediate(r));
const until = async (cond) => {
  for (let i = 0; i < 500 && !cond(); i++) await tick();
  assert.ok(cond(), "timed out");
};
const clearToasts = () => {
  for (let i = 1; i <= 80; i++) dismiss(`t${i}`);
};

/** A public output: a note of 50 MURK for `s`, or someone else's (it doesn't decrypt here). */
function output(i, s = null) {
  const blinding = randomField();
  const commitment = s ? commitmentOf({ asset: 7n, amount: 50n, pubkey: s.keys.pk, blinding }) : randomField();
  const ciphertext = s ? encryptNote({ asset: 7n, amount: 50n, blinding, vpk: s.keys.vpk, commitment }) : new Uint8Array(95).fill(i + 1);
  return { commitment: commitment.toString(), ciphertext: hex(ciphertext), height: 95 + i, txid: String(i).padStart(64, "a"), leafIndex: i };
}
function resetNet(outs) {
  Object.assign(net, { height: 100, startHeight: 90, outs, badRoot: null, down: false, onOutputs: null, gate: null, calls: [] });
}
/** The portfolio, with every markup it paints. */
function portfolio(s) {
  const root = new FakeEl();
  const off = renderPortfolio(root, s);
  return { root, off, last: () => root.html };
}
const HOLDS = 'href="/app/send?t=MURK"'; // the balances row of the note above

after(() => {
  S.lock();
  clearToasts();
});

/* ---------- a sync never shows a half-built view ---------- */

test("the first sync keeps the download line up until its view checks out (no 'verified at #0')", async (t) => {
  const s = new S.Session({ phrase: S.newPhrase() });
  s.localPayer.balance = async () => 0;
  resetNet([output(0, s), output(1)]);
  let open;
  net.gate = { path: "/api/outputs", promise: new Promise((r) => (open = r)) };
  const page = portfolio(s);
  t.after(page.off);
  await until(() => net.calls.includes("/api/outputs"));
  // Something repaints while the outputs download (here a BTC check; a storage event or a payer change do the same).
  await s.checkBtc();
  assert.equal(s.view, null, "no view until the root matches");
  assert.match(page.last(), /Downloading the public pool/);
  assert.doesNotMatch(page.last(), /root matches at #0|No notes yet/, "never an empty view claimed as verified");
  open();
  await s.syncing;
  assert.equal(s.view.height, 100);
  assert.match(page.last(), /root matches at #100/);
  assert.ok(page.last().includes(HOLDS));
});

test("an incremental sync keeps the current view on screen until the new one is verified", async () => {
  const s = new S.Session({ phrase: S.newPhrase() });
  resetNet([output(0, s)]);
  await s.sync();
  const before = s.view;
  net.outs = [...net.outs, output(1), output(2)];
  net.height = 101;
  let open;
  net.gate = { path: "/api/nullifiers", promise: new Promise((r) => (open = r)) };
  const p = s.sync();
  await until(() => net.calls.filter((c) => c === "/api/nullifiers").length === 2);
  // Outputs in and the root checked, nullifiers still downloading: the page still sees the last verified view.
  assert.equal(s.view, before);
  assert.deepEqual([s.view.outputs.length, s.view.height, s.view.tree.size], [1, 100, 1], "untouched, not half updated");
  open();
  await p;
  assert.notEqual(s.view, before);
  assert.deepEqual([s.view.outputs.length, s.view.height, s.view.tree.size], [3, 101, 3]);
  assert.equal(s.view.tree.root().toString(), rootOf(net.outs));
});

/* ---------- an indexer restart: errors keep the view, the next poll recovers ---------- */

test("an API error during an indexer restart doesn't swap the balances out and back", async (t) => {
  t.after(clearToasts);
  const s = new S.Session({ phrase: S.newPhrase() });
  resetNet([output(0, s), output(1)]);
  const page = portfolio(s);
  t.after(page.off);
  await until(() => s.view && page.last().includes(HOLDS));
  const verified = s.view;
  const seen = page.root.writes.length;

  // A reorg-like change (output 1 replaced, one more added), and the indexer goes down
  // mid-sync: the incremental tree mismatches, and the rebuild from scratch fails.
  net.outs = [net.outs[0], output(1), output(2)];
  net.height = 101;
  net.onOutputs = () => (net.down = true);
  await api.refreshState();
  await until(() => s.syncError);
  assert.equal(s.view, verified, "the verified view stays");
  let paints = page.root.writes.slice(seen);
  assert.ok(paints.length >= 1);
  for (const m of paints) assert.ok(m.includes(HOLDS), "every paint still shows the balance");
  assert.match(page.last(), /Sync failed/);

  // Still down: the poll retries, and the same error isn't painted again.
  const n = page.root.writes.length;
  const calls = net.calls.length;
  await api.refreshState();
  await until(() => net.calls.length > calls + 1 && !s.syncing);
  assert.equal(page.root.writes.length, n, "no repaint for the same error");

  // Back up with the same state: the next poll syncs (not only at the next block).
  net.down = false;
  net.onOutputs = null;
  await api.refreshState();
  await until(() => !s.syncError && s.view !== verified);
  assert.equal(s.view.height, 101);
  assert.match(page.last(), /root matches at #101/);
  paints = page.root.writes.slice(seen);
  for (const m of paints) assert.ok(m.includes(HOLDS), "the balance never left the page");
});

test("an indexer that restarts from an older snapshot and then fails leaves the view whole", async () => {
  const s = new S.Session({ phrase: S.newPhrase() });
  resetNet([output(0, s), output(1), output(2)]);
  await s.sync();
  const verified = s.view;
  // Fewer outputs than this browser holds: the view is rebuilt from scratch, and that fails.
  net.outs = net.outs.slice(0, 1);
  net.height = 99;
  net.onOutputs = () => (net.down = true);
  net.down = false;
  await assert.rejects(s.sync()); // the request after the outputs fails
  assert.equal(s.view, verified, "the verified view stays");
  assert.deepEqual([s.view.outputs.length, s.view.height], [3, 100]);
  assert.ok(s.wallet.notes.length === 1 && s.available(7n) === 50n, "and so do the notes");
});

test("a root mismatch keeps the last verified view, labelled as old, and isn't re-downloaded on every poll", async (t) => {
  t.after(clearToasts);
  const s = new S.Session({ phrase: S.newPhrase() });
  resetNet([output(0, s), output(1)]);
  const page = portfolio(s);
  t.after(page.off);
  await until(() => s.view && page.last().includes(HOLDS));
  const verified = s.view;

  // The indexer reports a root that its own outputs don't give.
  net.outs = [...net.outs, output(2)];
  net.height = 101;
  net.badRoot = "12345";
  await api.refreshState();
  await until(() => s.syncError && !s.syncing);
  assert.match(s.syncError, /Root mismatch/);
  assert.equal(s.view, verified);
  assert.ok(page.last().includes(HOLDS));
  assert.match(page.last(), /Sync failed[\s\S]*The balances below are from the last state your browser verified, at #100\./, "the kept balances say how old they are");
  assert.doesNotMatch(page.last(), /root matches/);

  // The same state rebuilds the same tree: the polls don't download every output again.
  const downloads = () => net.calls.filter((c) => c === "/api/outputs").length;
  const n = downloads();
  for (let i = 0; i < 3; i++) await api.refreshState();
  for (let i = 0; i < 20; i++) await tick();
  assert.equal(downloads(), n, "no download per poll");

  // "Sync again" (the error's advice): the button works again after a failed press.
  const btn = { dataset: { action: "sync" }, disabled: false };
  page.root.ls.click[0]({ target: { closest: () => btn } });
  assert.equal(btn.disabled, true);
  await until(() => !s.syncing);
  await tick();
  assert.equal(btn.disabled, false);

  // Fixed indexer, new state: the next poll syncs.
  net.badRoot = null;
  await api.refreshState();
  await until(() => !s.syncError && s.view !== verified);
  assert.match(page.last(), /root matches at #101/);
});

test("a locked session is never synced again: a page still up after the lock ignores its polls", async () => {
  const s = new S.Session({ phrase: S.newPhrase() });
  resetNet([output(0, s)]);
  const paints = [];
  const off = liveSession(s, (type) => paints.push(type));
  await until(() => s.view && !s.syncing);
  paints.length = 0;
  // lock() disposes the session; the page stays up until the next view's module has loaded.
  s.dispose();
  net.calls = [];
  net.outs = [...net.outs, output(1)];
  net.height = 101;
  await api.refreshState();
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(net.calls, ["/api/state"], "the poll only: no download for a dropped session");
  assert.deepEqual(paints, [], "and no repaint");
  await assert.rejects(s.sync(), /locked/);
  assert.deepEqual(net.calls, ["/api/state"]);
  off();
});

test("each wallet page paints a sync error, even one the previous page already showed", async () => {
  const s = new S.Session({ phrase: S.newPhrase() });
  resetNet([output(0, s)]);
  net.down = true;
  const first = [];
  const off1 = liveSession(s, (type) => first.push(type));
  await until(() => first.includes("error") && !s.syncing);
  off1();
  // The next page (portfolio -> activity) fails with the same message.
  const second = [];
  const off2 = liveSession(s, (type) => second.push(type));
  await until(() => second.includes("error") && !s.syncing);
  await api.refreshState(); // still down: retried, and the same error isn't painted twice
  for (let i = 0; i < 20; i++) await tick();
  assert.deepEqual(second, ["error"]);
  off2();
});

/* ---------- two unlocked tabs ---------- */

test("two tabs: a status both derive from one block is written once, and the echo repaints nothing", async (t) => {
  S.lock();
  S.storage.removeItem(VAULT);
  const vaultWrites = [];
  const setItem = S.storage.setItem;
  S.storage.setItem = (k, v) => (k === VAULT && vaultWrites.push(v), setItem.call(S.storage, k, v));
  let repaints = 0;
  const offEmit = S.onSessionChange((type) => type === "history" && repaints++);
  t.after(() => {
    S.storage.setItem = setItem;
    offEmit();
    S.lock();
  });
  const fireStorage = () => storageListeners.forEach((fn) => fn({ key: VAULT }));

  const a = await S.createWallet(S.newPhrase(), PW); // tab A: the module session
  resetNet([output(0)]);
  const mine = output(1, a);
  a.record({ kind: "mint", via: "self", txid: "b".repeat(64), txids: ["b".repeat(64)], ticker: "MURK", assetId: "7", amount: "50", div: 0, commitments: [mine.commitment], anchor: 100, status: "mempool" });
  const stored = JSON.parse(S.storage.getItem(VAULT));
  const opened = await keystore.unlockVault(stored, PW);
  const b = new S.Session({ phrase: opened.phrase, key: opened.key, data: opened.data, vault: stored }); // tab B
  await a.sync();
  await b.sync();
  const w0 = vaultWrites.length;
  repaints = 0;

  // The mint lands. B syncs first and writes "accepted"; A gets the storage event.
  net.outs = [...net.outs, mine];
  net.height = 101;
  await b.sync();
  assert.equal(vaultWrites.length - w0, 1);
  fireStorage();
  assert.equal(repaints, 0, "A's history didn't change, so A doesn't repaint");
  // A syncs the same block and derives the same status: already stored, so no second write.
  await a.sync();
  assert.equal(vaultWrites.length - w0, 1, "one write for one status change, not one per tab");
  assert.equal(b.pull(), false);

  // A fixed point: more polls and storage events, no new writes.
  for (let i = 0; i < 3; i++) {
    await a.sync();
    await b.sync();
    fireStorage();
    b.pull();
  }
  assert.equal(vaultWrites.length - w0, 1);
  assert.equal(repaints, 0);
  const statuses = [a, b].map((s) => s.history[0].status);
  const back = await keystore.unlockVault(JSON.parse(S.storage.getItem(VAULT)), PW);
  assert.deepEqual([...statuses, back.data.history[0].status], ["accepted", "accepted", "accepted"]);

  // A real change from B (a new entry) still reaches A, with one repaint.
  b.record({ kind: "send", via: "relay", spends: ["9"], commitments: [], anchor: 101, status: "relaying" });
  repaints = 0; // record() itself emits in B's tab
  fireStorage();
  assert.equal(repaints, 1);
  assert.equal(a.history.length, 2);
});

/* ---------- the shell: navigation and polls (app.js can't load under node: lifted) ---------- */

function lift(blocks, deps, names) {
  const app = src("web/src/app.js");
  const code = blocks.map((re) => app.match(re)?.[0] ?? assert.fail(`not in app.js: ${re}`)).join("\n");
  return new Function(...Object.keys(deps), `${code}\nreturn { ${names} };`)(...Object.values(deps));
}

test("navigation keeps the current view up while the next view's module loads", async () => {
  const main = new FakeEl();
  const failures = [];
  const { mount } = lift([/function viewRoot\([\s\S]*?\n\}\n/, /let cleanup = null;[\s\S]*?\nasync function mount\([\s\S]*?\n\}\n/], {
    main, toNode, getWalletStatus: () => ({ state: "none" }), appLayout: () => "", closeAllPopovers: () => {}, setTitle: () => {},
    markCurrent: () => {}, paintTabbar: () => {}, notFound: () => {}, placeholder: () => {}, failed: (root, e) => failures.push(e.message), console: { error() {} },
  }, "mount");
  const route = (loader) => ({ route: { loader, meta: { name: "x", layout: "public", title: "X" } }, params: {} });
  const view = (text) => ({ render: (root) => void (root.innerHTML = text) });

  await mount(route(async () => view("one")), new URL("https://m.example/a"));
  const first = main.children[0];
  assert.equal(first.innerHTML, "one");
  let load;
  const p = mount(route(() => new Promise((r) => (load = r))), new URL("https://m.example/b"));
  await tick();
  assert.equal(main.children[0], first, "main still shows the current view, not an empty one");
  load(view("two"));
  await p;
  assert.equal(main.children[0].innerHTML, "two");
  assert.equal(main.children[0].className, "view page-enter", "a new page fades in");

  // The same page again (a lock or an unlock re-renders it): swapped in place, no fade.
  await mount(route(async () => view("two, locked")), new URL("https://m.example/b"));
  assert.equal(main.children[0].className, "view");
  // A module that fails to load still ends on the error page.
  await mount(route(() => Promise.reject(new Error("chunk failed"))), new URL("https://m.example/c"));
  assert.deepEqual(failures, ["chunk failed"]);
});

test("a poll with unchanged data rewrites nothing: ledger strip, lattice, root chip", () => {
  // Ledger: rebuilt every 5 s, which restarted the sync dot's pulse. Now "Synced N s ago" ages in place.
  const ledger = new FakeEl();
  const chain = { height: 324650, chainTip: 324650, root: "12345", outputs: 2, nullifiers: 2, syncing: false, lastSync: Date.now() - 5_000 };
  const { paintLedger } = lift([/function paintLedger\(\) \{[\s\S]*?\n\}\n/], {
    $: () => ledger, chain, chainError: null, poolStats: { tokens: 1 }, getRootStatus, html, icon, setHTML,
    heightText: fmt.heightText, fieldHex: fmt.fieldHex, short: fmt.short, DASH: fmt.DASH, int: fmt.int, rel: fmt.rel,
  }, "paintLedger");
  paintLedger();
  chain.lastSync -= 5_000; // the 5 s timer fires
  paintLedger();
  assert.equal(ledger.writes.length, 1, "the strip (and its pulsing dot) is written once");
  assert.equal(ledger.querySelector("[data-ago]").textContent, "10 s ago");
  chain.height++;
  paintLedger();
  assert.equal(ledger.writes.length, 2, "a new block does repaint");

  // Lattice: redrawn on every 20 s poll.
  const box = new FakeEl();
  reduce = false; // new leaves flash only without reduced motion
  const lattice = mountLattice(box);
  lattice.update(5);
  const n = box.writes.length;
  lattice.update(5);
  assert.equal(box.writes.length, n);
  lattice.update(6);
  assert.equal(box.writes.length, n + 1);
  assert.match(box.html, /lt-leaf is-on is-new" data-leaf="5"/);
  lattice.destroy();
  reduce = true;

  // Any element written only through setHTML (root chip, footer anchor).
  const chip = new FakeEl();
  assert.equal(setHTML(chip, html`<b>Root</b>`), true);
  assert.equal(setHTML(chip, html`<b>Root</b>`), false);
  assert.equal(chip.writes.length, 1);
  const shell = src("web/src/app.js");
  assert.match(shell, /setHTML\(\$\("\.rootchip-slot"\), rootChip\(getRootStatus\(\)\)\)/);
  assert.match(shell, /setHTML\(el, html`\$\{circuit\}\$\{anchored\}/);
});

/* ---------- animations that a repaint restarted ---------- */

test("the proving sheet's clock updates the times, not the whole sheet", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  t.after(() => closeAllSheets());
  const ps = provingSheet({ title: "Minting", steps: [{ id: "sync", label: "Sync" }, { id: "prove", label: "Prove" }] });
  const host = ps.sheet.body.querySelector("[data-pv]");
  const rows = [new FakeEl(), new FakeEl()];
  host.all[".step"] = rows;
  ps.onStep({ id: "sync", status: "ok", ms: 40 });
  ps.onStep({ id: "prove", status: "running" });
  const n = host.writes.length;
  assert.match(host.html, /class="spinner[^"]*"[\s\S]*class="proving-bar"/);
  t.mock.timers.tick(1_000);
  assert.equal(host.writes.length, n, "the spinner and the proving bar keep running");
  assert.equal(rows[1].querySelector(".step-ms").textContent, fmt.ms(1_000));
  assert.equal(rows[0].querySelector(".step-ms").textContent, undefined, "finished steps keep their time");
  ps.onStep({ id: "prove", status: "ok", ms: 1_000 });
  assert.equal(host.writes.length, n + 1, "a step change repaints");
  ps.done();
});

test("a provenance chip asked twice within its crossfade fades once, to the latest target", (t) => {
  reduce = false;
  t.after(() => (reduce = true));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const chip = () => {
    const el = new FakeEl();
    el.dataset.prov = "IDX";
    el.attrs["data-tip"] = "";
    return el;
  };
  const a = chip();
  upgrade(a, "YOU");
  upgrade(a, "YOU"); // a second repaint within 150 ms
  t.mock.timers.tick(150);
  assert.equal(a.classAdds.filter((c) => c === "prov--swap-out").length, 1);
  assert.equal(a.classAdds.filter((c) => c === "prov--swap-in").length, 1, "one fade, not two");
  assert.equal(a.dataset.prov, "YOU");
  assert.equal(a.dataset.provTo, undefined);

  const b = chip();
  upgrade(b, "YOU");
  upgrade(b, "IDX"); // the root changed again before the fade finished
  t.mock.timers.tick(150);
  assert.equal(b.dataset.prov, "IDX", "the latest state wins");
  assert.match(String(prov("IDX")), /data-prov="IDX"/);
});

/* ---------- the dev server ---------- */

test("dev server only: a reload it triggers is explained, one by the user isn't, and the saved theme colors the first frame", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 5_000_000 });
  const block = src("web/src/app.js").match(/if \(import\.meta\.hot\) \{[\s\S]*?\n\}\n/)?.[0] ?? assert.fail("no dev reload notice");
  const store = new Map();
  const sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  /** One page load: its toasts, and its window and Vite events to fire. */
  const boot = (navigation = "reload") => {
    const on = {};
    const listen = (type, fn) => (on[type] ??= []).push(fn);
    const toasts = [];
    new Function("hot", "addEventListener", "sessionStorage", "performance", "toast", "STORAGE_PREFIX", block.replace(/import\.meta\.hot/g, "hot"))(
      { on: listen }, listen, sessionStorage, { getEntriesByType: () => [{ type: navigation }] }, (x) => toasts.push(`${x.title} ${x.body}`), "murkle",
    );
    return { toasts, fire: (...types) => types.forEach((type) => (on[type] ?? []).forEach((fn) => fn({}))) };
  };

  // A saved file: Vite announces the reload, then reloads (its socket closes on the way out).
  let page = boot("navigate");
  assert.deepEqual(page.toasts, []);
  page.fire("vite:beforeFullReload", "beforeunload", "vite:ws:disconnect", "pagehide");
  page = boot();
  assert.equal(page.toasts.length, 1);
  assert.match(page.toasts[0], /^Reloaded by the dev server\. A source file changed, .*an unlocked wallet locked/);

  // The user reloads. Some browsers report the socket closing on the way out as a disconnect
  // (Vite itself ignores it after beforeunload): not the dev server's doing.
  page.fire("beforeunload", "vite:ws:disconnect", "pagehide");
  page = boot();
  assert.deepEqual(page.toasts, []);

  // The dev server restarts: the socket drops, and Vite reloads once the server answers, a minute later.
  page.fire("vite:ws:disconnect");
  t.mock.timers.tick(60_000);
  page.fire("beforeunload", "pagehide");
  page = boot();
  assert.match(page.toasts[0] ?? "", /^Reloaded by the dev server\. It restarted, /);

  // The server stops, the user reloads while it is down, and loads the page again later.
  page.fire("vite:ws:disconnect", "beforeunload", "pagehide");
  t.mock.timers.tick(10_000);
  page = boot();
  assert.deepEqual(page.toasts, [], "an old mark is not this load's cause");
  // A mark is read only on a reload: a later plain navigation in this tab drops it.
  page.fire("vite:beforeFullReload", "beforeunload", "pagehide");
  page = boot("navigate");
  assert.deepEqual(page.toasts, []);

  // theme-boot.js runs before any stylesheet: the canvas follows the saved theme, not the OS.
  const themeBoot = src("web/public/theme-boot.js");
  const meta = { content: "dark light" };
  const root = { dataset: {} };
  const run = (saved) => {
    meta.content = "dark light";
    root.dataset = {};
    new Function("localStorage", "document", themeBoot)({ getItem: () => saved }, { documentElement: root, querySelector: () => meta });
    return [root.dataset.theme, meta.content];
  };
  assert.deepEqual(run("light"), ["light", "light"]);
  assert.deepEqual(run(null), [undefined, "dark light"]);
});

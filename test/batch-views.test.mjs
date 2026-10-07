// Batch relay timing, wallet views (docs/design/batch-contract.md §5, tests §8 "views"):
// the Relay timing control and its defaults, every BATCH_TEXT line in its state on Send,
// the Activity phases with their recovery buttons, the Settings batch block and audit line,
// and the copy rules. Runs on a fake DOM with fake storage and a fake indexer; nothing is
// broadcast and no wallet is opened in any browser.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { relayInfoOff } from "../server/retired-relay.mjs";

/* ---------- a minimal DOM: every innerHTML write and every parsed node is recorded ---------- */

const painted = []; // innerHTML writes, in order
const made = []; // { markup, el } for every toNode()
class FakeEl {
  constructor(markup = "") {
    this.markup = String(markup);
    this.sel = new Map();
    this.ls = {};
    this.attrs = {};
    this.dataset = {};
    this.html = "";
    this.hidden = false;
    const set = new Set();
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle: () => {} };
  }
  get innerHTML() {
    return this.html;
  }
  set innerHTML(v) {
    this.html = String(v);
    painted.push(this.html);
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
  contains() {
    return false;
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
        const el = new FakeEl(v);
        made.push({ markup: String(v), el });
        t.content = { childNodes: [el], firstChild: el };
      },
    });
    return t;
  },
  body: new FakeEl(),
  documentElement: new FakeEl(),
  activeElement: null,
  hidden: true, // no 20 s poll timer: syncs run when a test calls them
  addEventListener() {},
  removeEventListener() {},
  getElementById: () => null,
  hasFocus: () => true,
};
globalThis.requestAnimationFrame = () => 0;
// Reduced motion: sheets finish closing at once.
globalThis.matchMedia = (q) => ({ matches: q.includes("reduced-motion"), addEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
const url = new URL("https://murkle.example/app/send");
globalThis.location = {
  get href() { return url.href; },
  get origin() { return url.origin; },
  get pathname() { return url.pathname; },
  get search() { return url.search; },
  get hash() { return url.hash; },
};
globalThis.history = { state: null, pushState() {}, replaceState() {} };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => {} } } });

/* ---------- a fake indexer and relayer (bulk endpoints, relay info, ledger, mempool.space) ---------- */

const TIP = 324_700; // the contract's example tip: hourly S 324,696, 10-hour S 324,660
const RELAYER = `tb1p${"q".repeat(58)}`;
const net = { height: TIP, startHeight: 324_592, outs: [], info: null, ledger: { items: [], totals: {} }, txs: [], calls: [], relayStatus: null };
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let rootOf;
globalThis.fetch = async (input) => {
  const u = new URL(String(input), "http://indexer.test");
  net.calls.push(u.pathname);
  if (u.pathname.endsWith(`/address/${RELAYER}/txs`)) return reply(200, net.txs);
  if (u.pathname.startsWith("/api/relay/status/")) return net.relayStatus ? reply(200, net.relayStatus) : reply(404, { error: { code: "not_found", message: "Unknown relay id." } });
  switch (u.pathname) {
    case "/api/state":
      return reply(200, { height: net.height, startHeight: net.startHeight, root: rootOf(net.outs), outputs: net.outs.length, nullifiers: 0, chainTip: net.height, syncing: false, lastSync: Date.now() });
    case "/api/outputs": {
      const from = Number(u.searchParams.get("from") ?? 0);
      const to = Number(u.searchParams.get("to") ?? net.outs.length);
      return reply(200, net.outs.slice(from, to));
    }
    case "/api/nullifiers":
      return reply(200, []);
    case "/api/assets":
      return reply(200, [{ id: "7", ticker: "ABC", divisibility: 0, status: "live", mintAmount: "50", priceSats: "0", treasury: null }]);
    case "/api/log":
      return reply(200, { items: [], next: null, total: 0 });
    case "/api/relay/info":
      return net.info ? reply(200, net.info) : reply(503, { error: { message: "Relayer off." } });
    case "/api/relay/ledger":
      return reply(200, net.ledger);
    default:
      return reply(404, { error: { message: "Not found." } });
  }
};

const S = await import("../web/src/session.js");
// These tests drive the relay route, its timing control and relay retries. The route is open
// only while a relayer with relay balances runs (docs/design/relay-balance.md) and offered on
// Send only to a wallet whose balance covers the send: relayInfo() below reports such a
// relayer, walletWithNotes() gives the wallet a balance, and this file opens the route.
const { RELAY_ROUTE } = await import("../web/src/relay.js");
RELAY_ROUTE.open = true;
const { schnorr } = await import("@noble/curves/secp256k1");
const POOL = Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(5))).toString("hex");
const { STORAGE_PREFIX } = await import("../web/src/config.js");
const { esc } = await import("../web/src/ui/dom.js");
const { closeAllSheets } = await import("../web/src/ui/sheet.js");
const { dismiss } = await import("../web/src/ui/toast.js");
const RB = await import("../src/relay-batch.mjs");
const { BATCH_TEXT, statusChip } = await import("../web/src/views/app-shared.js");
const SEND = await import("../web/src/views/app-send.js");
const ACT = await import("../web/src/views/app-activity.js");
const SET = await import("../web/src/views/app-settings.js");
const { MerkleTree, commitmentOf, randomField } = await import("../src/core.mjs");
const { encryptNote } = await import("../src/keys.mjs");
const { OP, encodeTxBody, opReturnScript } = await import("../src/envelope.mjs");
const { hex } = await import("../src/bytes.mjs");

rootOf = (outs) => {
  const t = new MerkleTree();
  for (const o of outs) t.insert(BigInt(o.commitment));
  return t.root().toString();
};

after(() => {
  closeAllSheets();
  for (let i = 1; i <= 200; i++) dismiss(`t${i}`);
});

/* ---------- helpers ---------- */

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};
/** Markup contains this text (escaped as html`` escapes it). */
const has = (markup, text) => String(markup).includes(esc(text));
const fire = (el, type, ev) => (el.ls[type] ?? []).map((fn) => fn(ev));
/** A click on a control with data-action="act", as delegated handlers see it. */
const clickOn = (act, dataset = {}) => {
  const el = { dataset: { action: act, ...dataset }, disabled: false };
  return { target: { closest: (sel) => (sel === "[data-action]" || sel === `[data-action=${act}]` ? el : null), matches: () => false } };
};
/** The markup of one segmented control (from its wrapper to the end of its <select>). */
function segOf(markup, name) {
  const m = String(markup);
  const at = m.indexOf(`data-name="${name}"`);
  return at < 0 ? null : m.slice(at, m.indexOf("</select>", at) + "</select>".length);
}
const checked = (markup, name) => segOf(markup, name)?.match(/data-value="([^"]+)" aria-checked="true"/)?.[1] ?? null;
const stops = (markup, name) => [...(segOf(markup, name) ?? "").matchAll(/data-value="([^"]+)" aria-checked="(?:true|false)" tabindex="(?:0|-1)">(?:<svg[\s\S]*?<\/svg>)?<span>([^<]+)<\/span>/g)].map((x) => [x[1], x[2]]);
const PREFS = [`${STORAGE_PREFIX}.relayMode`, `${STORAGE_PREFIX}.selfMode`, `${STORAGE_PREFIX}.route`];
const resetPrefs = () => PREFS.forEach((k) => S.storage.removeItem(k));
const infoCalls = () => net.calls.filter((p) => p === "/api/relay/info").length;
const PAYEE = new S.Session({ phrase: S.newPhrase() }).address; // someone else: a payment

/** What the relayer reports (batch-contract.md §3.8), for the epochs that contain TIP. */
function relayInfo({ hourly = 5, ten = 7, start = 324_696, start10 = 324_660, enabled = true, enabled10 = true, max = 40, max10 = 120, recent = [] } = {}) {
  return {
    enabled: true, mode: "balance", code: null, reason: null, network: "signet", address: RELAYER,
    fees: { feeRate: 1, maxFeeRate: 5, estVsize: 597, carrierFeeSats: 597, maxFeePerTx: 3000 },
    balance: {
      poolKey: POOL, changeAddress: RELAYER, signTag: "murkle/relay/v1", marginPct: 10, marginMinSats: 50, perSendSats: 657, batchHeadroom: 2,
      minDepositSats: 2000, depositConfirmations: 1, sweepCostSats: 288, suggestSends: 10, suggestedTopUpSats: 7000,
    },
    stats: { relayed144: 3, landed144: [] },
    batch: {
      perIp: 3,
      modes: {
        batch: { epochBlocks: 6, maxPerEpoch: max, safety: 24, enabled, current: { start, releaseAt: start + 6, lastRelease: start + 76, queued: hourly } },
        batch10: { epochBlocks: 60, maxPerEpoch: max10, safety: 12, enabled: enabled10, current: { start: start10, releaseAt: start10 + 60, lastRelease: start10 + 88, queued: ten } },
      },
      recent,
    },
  };
}

/** A public output: a note of `amount` ABC for `s`, or someone else's (it doesn't decrypt here). */
function out(i, s, amount, height) {
  const blinding = randomField();
  const commitment = s ? commitmentOf({ asset: 7n, amount, pubkey: s.keys.pk, blinding }) : randomField();
  const ciphertext = s ? encryptNote({ asset: 7n, amount, blinding, vpk: s.keys.vpk, commitment }) : new Uint8Array(95).fill(i + 1);
  return { commitment: commitment.toString(), ciphertext: hex(ciphertext), height, txid: String(i).padStart(64, "b"), leafIndex: i };
}

/**
 * A synced wallet at TIP with notes of 100 (block 324,600), 50 (324,662) and 1,000 (324,698):
 * the hourly batch (S 324,696) can use 100 + 50, the 10-hour batch (S 324,660) only 100.
 */
async function walletWithNotes() {
  const s = new S.Session({ phrase: S.newPhrase() });
  net.height = TIP;
  net.outs = [out(0, s, 100n, 324_600), out(1, null, 0n, 324_605), out(2, s, 50n, 324_662), out(3, s, 1000n, 324_698), out(4, null, 0n, 324_699)];
  await s.sync();
  assert.equal(s.wallet.notes.length, 3, "the three notes were found");
  // A topped-up relay balance (relay-balance.md): the relay card is offered, and chosen.
  s.relayBalance = { balance: 100_000, reserved: 0, nextIndex: 1, credits: [], at: Date.now() };
  s.routePref = "relay";
  return s;
}

/** The Send page, with handles on its slots and its events. */
async function mountSend(t, s, query = null) {
  const root = new FakeEl();
  const off = SEND.sendView(root, s, query);
  t.after(off);
  await settle();
  const slot = (n) => root.querySelector(`[data-slot=${n}]`);
  const f = root.querySelector("[data-f]");
  const run = async (type, ev) => (fire(f, type, ev), settle());
  return {
    root, f, slot,
    mode: () => String(slot("mode").innerHTML),
    notes: () => String(slot("timing").innerHTML),
    cta: () => String(slot("cta").innerHTML),
    disclosure: () => String(slot("disclosure").innerHTML),
    to: (value) => run("input", { target: { name: "to", value } }),
    amount: (value) => run("input", { target: { name: "amount", value } }),
    seg: (name, value) => run("seg-change", { detail: { name, value } }),
    click: (act) => run("click", clickOn(act)),
    submit: () => run("submit", { preventDefault() {} }),
  };
}

/** Picks a timing on the form the way the segmented controls report it. */
async function choose(v, mode) {
  if (RB.isBatchMode(mode)) {
    await v.seg("timing", "batch");
    if (mode === "batch10") await v.seg("batchlen", "batch10");
  } else await v.seg("timing", mode);
}

const SCHEDULE = { batch: RB.batchSchedule(TIP, "batch"), batch10: RB.batchSchedule(TIP, "batch10") };

/* ---------- 1. the control ---------- */

test("Relay timing: three stops left to right, the length only under Batch, radiogroups with roving tabindex and the <select> fallback", () => {
  const block = String(SEND.timingControl("block"));
  assert.deepEqual(stops(block, "timing"), [["fast", "Fast (~1 min)"], ["block", "Next block"], ["batch", "Batch"]]);
  assert.equal(checked(block, "timing"), "block");
  assert.match(block, /^<div class="mode-row"><span class="field-label">Relay timing<\/span>/);
  assert.match(segOf(block, "timing"), /<div class="seg" role="radiogroup" aria-label="Relay timing">/);
  assert.equal(segOf(block, "timing").match(/tabindex="0"/g).length, 1, "one stop in the tab order (roving tabindex)");
  assert.match(segOf(block, "timing"), /data-value="block" aria-checked="true" tabindex="0"/);
  assert.match(segOf(block, "timing"), /<select class="seg-select input" aria-label="Relay timing">(<option value="(fast|block|batch)"( selected)?>[^<]+<\/option>){3}<\/select>$/);
  assert.equal(segOf(block, "batchlen"), null, "no length choice under Next block");
  assert.equal(segOf(String(SEND.timingControl("fast")), "batchlen"), null, "nor under Fast");
  assert.equal(checked(String(SEND.timingControl("fast")), "timing"), "fast");

  for (const mode of ["batch", "batch10"]) {
    const m = String(SEND.timingControl(mode));
    assert.equal(checked(m, "timing"), "batch", "the Batch stop is on for both lengths");
    assert.equal(checked(m, "batchlen"), mode);
    assert.deepEqual(stops(m, "batchlen"), [["batch", "Hourly batch"], ["batch10", "10-hour batch"]]);
    assert.match(m, /<div class="seg-wrap seg-wrap--sm" data-seg data-name="batchlen" data-value="batch(10)?">/, "the small size");
    assert.match(segOf(m, "batchlen"), /role="radiogroup" aria-label="Batch length"/);
    assert.match(segOf(m, "batchlen"), /<select class="seg-select input" aria-label="Batch length">(<option[^>]*>[^<]+<\/option>){2}<\/select>$/);
    assert.ok(m.indexOf('data-name="timing"') < m.indexOf('data-name="batchlen"'), "the length follows the three stops");
    assert.ok(m.endsWith("</select>\n  </div></div>"), "both inside the one mode-row");
  }

  // The column layout and the narrow-screen fallback.
  const shared = src("web/src/views/app-shared.js");
  assert.match(shared, /\n\.mode-row \{ display: flex; flex-direction: column; align-items: flex-start; gap: 8px; \}\n/);
  assert.match(shared, /\n\.mode-row \.seg-wrap \{ max-width: 100%; \}\n/);
  assert.match(src("web/src/styles/components.css"), /@media \(max-width: 359px\) \{\s*\.seg \{ display: none; \}\s*\.seg-select \{ display: block; \}\s*\}/);

  // The proving steps end on the batch.
  for (const mode of ["batch", "batch10"]) assert.deepEqual(SEND.SEND_STEPS("relay", "relay", mode).at(-1), { id: "queued", label: "Scheduled for the batch" });
  for (const mode of ["block", "fast", undefined]) assert.equal(SEND.SEND_STEPS("relay", "relay", mode).at(-1).label, "Queued for the next block");
  assert.ok(!SEND.SEND_STEPS("self", "local", "batch").some((x) => x.id === "queued"), "self-paid sends have no relay steps");
});

test("keyboard focus stays on the segmented stop (or its <select>) when the control is repainted", (t) => {
  const prev = globalThis.document.activeElement;
  t.after(() => (globalThis.document.activeElement = prev));
  const wrap = { dataset: { name: "timing" } };
  const focused = [];
  const el = {
    contains: () => true,
    set innerHTML(v) {
      this.html = v;
    },
    querySelector: (sel) => ({ focus: (o) => focused.push([sel, o]) }),
  };
  globalThis.document.activeElement = { dataset: { value: "batch" }, closest: (s) => (s === "[data-seg]" ? wrap : null) };
  SEND.keepFocus(el, "<x>");
  globalThis.document.activeElement = { dataset: {}, closest: (s) => (s === "[data-seg]" ? { dataset: { name: "batchlen" } } : null) };
  SEND.keepFocus(el, "<y>");
  assert.deepEqual(focused, [
    ['[data-seg][data-name="timing"] .seg-opt[data-value="batch"]', { preventScroll: true }],
    ['[data-seg][data-name="batchlen"] .seg-select', { preventScroll: true }],
  ]);
  assert.match(src("web/src/views/app-send.js"), /keepFocus\(slot\("mode"\), form\.via === "relay" \? timingControl\(form\.mode\) : ""\)/);
});

test("the self-paid route hides the whole control, and the relay route brings it back", async (t) => {
  resetPrefs();
  net.info = relayInfo();
  const s = await walletWithNotes();
  s.routePref = "self";
  t.after(() => (s.routePref = "relay"));
  const v = await mountSend(t, s);
  assert.equal(v.mode(), "");
  assert.equal(v.notes(), "");
  fire(v.f, "change", { target: { name: "route", value: "relay" } });
  await settle(20);
  assert.equal(checked(v.mode(), "timing"), "block");
  assert.ok(has(v.notes(), BATCH_TEXT.otherModes));
  fire(v.f, "change", { target: { name: "route", value: "self" } });
  await settle(20);
  assert.equal(v.mode(), "");
  assert.equal(v.notes(), "");
});

/* ---------- 2. defaults ---------- */

test("defaults: a payment starts on Next block; Merge notes and a typed own address switch to the hourly batch; a touched control stays", async (t) => {
  resetPrefs();
  net.info = relayInfo();
  const s = await walletWithNotes();
  const v = await mountSend(t, s);
  assert.equal(checked(v.mode(), "timing"), "block", "a payment starts on Next block");

  await v.to(s.address);
  assert.equal(checked(v.mode(), "timing"), "batch");
  assert.equal(checked(v.mode(), "batchlen"), "batch", "own address: hourly batch");
  assert.ok(has(v.notes(), BATCH_TEXT.selfDefault));
  await v.to(PAYEE);
  assert.equal(checked(v.mode(), "timing"), "block", "back to a payment: Next block");
  assert.ok(!has(v.notes(), BATCH_TEXT.selfDefault));

  await v.click("merge");
  assert.equal(checked(v.mode(), "batchlen"), "batch", "Merge notes sends to yourself with the hourly batch");
  await v.click("restore-to");
  assert.equal(checked(v.mode(), "timing"), "block", "the set-aside recipient comes back with Next block");

  // Touched: the pick stays whatever the recipient.
  await v.seg("timing", "fast");
  assert.equal(s.relayModePref, "fast", "a payment's pick is remembered");
  await v.to(s.address);
  assert.equal(checked(v.mode(), "timing"), "fast", "a touched control stays");
  await v.to(PAYEE);
  assert.equal(checked(v.mode(), "timing"), "fast");
  await v.seg("timing", "batch");
  assert.equal(s.relayModePref, "fast", "a batch pick for a payment is never remembered");
  assert.equal(checked(v.mode(), "batchlen"), "batch");

  // The next form starts from the remembered picks.
  const next = await mountSend(t, s);
  assert.equal(checked(next.mode(), "timing"), "fast", "payments: the remembered Next block / Fast pick");
  await next.to(s.address);
  await next.seg("timing", "batch");
  await next.seg("batchlen", "batch10");
  assert.equal(s.selfModePref, "batch10", "a self-transfer's pick is remembered, batch included");
  const own = await mountSend(t, s, new URLSearchParams(`to=${s.address}`));
  assert.equal(checked(own.mode(), "batchlen"), "batch10", "a send to yourself starts on the remembered length");
  // A length remembered by an older wallet ("batch12", the retired 12-hour batch) opens on the 10-hour batch.
  S.storage.setItem(`${STORAGE_PREFIX}.selfMode`, "batch12");
  const legacy = await mountSend(t, s, new URLSearchParams(`to=${s.address}`));
  assert.deepEqual([checked(legacy.mode(), "timing"), checked(legacy.mode(), "batchlen")], ["batch", "batch10"]);
  assert.ok(has(legacy.notes(), BATCH_TEXT.caption.batch10));
  resetPrefs();
});

test("pickTiming and followRecipient: the Batch stop brings back the last length; unknown names change nothing", () => {
  const prefs = {};
  const s = {
    address: "mrk1self",
    defaultMode: (to) => (String(to).trim() === "mrk1self" ? "batch" : "block"),
    set relayModePref(v) {
      prefs.relay = v;
    },
    set selfModePref(v) {
      prefs.self = v;
    },
  };
  const form = { to: "mrk1other", mode: "block", modeTouched: false, batchLen: null };
  SEND.followRecipient(form, s);
  assert.equal(form.mode, "block");
  form.to = " mrk1self ";
  SEND.followRecipient(form, s);
  assert.equal(form.mode, "batch", "own address, even with spaces around it");
  form.to = "mrk1other";
  SEND.pickTiming(form, s, { name: "timing", value: "batch" });
  SEND.pickTiming(form, s, { name: "batchlen", value: "batch10" });
  SEND.pickTiming(form, s, { name: "timing", value: "block" });
  SEND.pickTiming(form, s, { name: "timing", value: "batch" });
  assert.equal(form.mode, "batch10", "the Batch stop remembers the length picked on this form");
  assert.deepEqual(prefs, { relay: "block" }, "only the non-batch payment pick was stored");
  SEND.pickTiming(form, s, { name: "timing", value: "fast" }, { remember: false });
  assert.equal(form.mode, "fast");
  assert.deepEqual(prefs, { relay: "block" }, "a one-off pick stores nothing");
  SEND.pickTiming(form, s, { name: "timing", value: "batch" });
  SEND.pickTiming(form, s, { name: "theme", value: "dark" });
  SEND.pickTiming(form, s, { name: "timing", value: "warp" });
  assert.equal(form.mode, "batch10");
  form.to = "mrk1self";
  SEND.followRecipient(form, s);
  assert.equal(form.mode, "batch10", "touched: the recipient no longer moves it");
});

/* ---------- 3. every batch line in its state ---------- */

test("BATCH_TEXT is the contract's copy, word for word", () => {
  const T = BATCH_TEXT;
  assert.deepEqual(T.label, { fast: "Fast (~1 min)", block: "Next block", batch: "Hourly batch", batch10: "10-hour batch" });
  assert.equal(T.name("batch"), "hourly batch");
  assert.equal(T.name("batch10"), "10-hour batch");
  assert.equal(T.caption.batch, "Hourly batch waits for the next batch. People watching Bitcoin see it land together with the other hourly-batch transfers from that hour, not when you pressed Send.");
  assert.equal(T.caption.batch10, "10-hour batch waits for the next 10-hour batch. People watching Bitcoin see it land together with the other 10-hour-batch transfers from those 10 hours, not when you pressed Send. Use it only when the recipient can wait.");
  assert.equal(T.ip, "The relayer still sees your IP address and when you submitted. Tor Browser hides your IP. Anyone can watch the waiting count, which changes once per block, so with few transfers the block you submitted in can be read from it.");
  assert.equal(T.crowd(1234), "Waiting for this batch: 1,234 (reported by the relayer).");
  assert.equal(T.thin, "Few transfers are waiting for this batch. With so few, it hides little.");
  assert.equal(T.tooNew({ start: 324_696, eligibleAt: 324_702, wait: 2 }), "The note this send needs arrived after block 324,696, so it can join the batch that starts at block 324,702 (about 20 min). Or send it with the next block now.");
  assert.equal(T.useNextBlock, "Send with the next block");
  assert.equal(T.time({ mode: "batch", releaseAt: 324_702, wait: 2 }), "With the hourly batch after block 324,702 (about 20 min)");
  assert.equal(T.time({ mode: "batch10", releaseAt: 324_720, wait: 20 }), "With the 10-hour batch after block 324,720 (about 3 h)");
  assert.equal(T.scheduled({ releaseAt: 324_702, deadline: 324_796 }), "Scheduled. It goes out with the batch after block 324,702. Your notes stay reserved until it lands, or until block 324,796 at the latest.");
  assert.equal(T.recipientWait.batch, "The recipient sees it when it lands: usually within an hour, at most about two.");
  assert.equal(T.recipientWait.batch10, "The recipient sees it when it lands: usually within 10 hours, at most about 15.");
  assert.equal(T.noCancel, "A scheduled transfer can't be cancelled: the relayer holds it, and anyone holding it could still carry it.");
  assert.equal(T.long10.reserve({ deadline: 324_760, wait: 60 }), "Your notes stay reserved until it lands, about 10 hours, or until block 324,760 (about 10 h) if it never does.");
  assert.equal(T.long10.crowd, "The 10-hour batch is a separate crowd: it lands about 10 hours after its anchor block, so it only hides among other 10-hour transfers, and there are fewer of those than in the hourly batches.");
  assert.equal(T.long10.stall({ lastRelease: 324_748 }), "If the relayer stalls, it has until block 324,748 to send it. After that it won't, and Activity offers other ways to send it.");
  assert.equal(T.selfDefault, "Merges and refreshes go with the hourly batch by default: nobody waits for them, and they add real transfers to the batch.");
  assert.equal(T.scheduledLine({ mode: "batch10", releaseAt: 324_720, wait: 20, deadline: 324_760 }), "Scheduled. It goes out with the 10-hour batch after block 324,720 (about 3 h). Your notes stay reserved until it lands, or until block 324,760 at the latest.");
  assert.equal(T.landed({ height: 324_703, count: 1 }), "Landed in block 324,703. The relayer reports 1 transfer in this batch, yours included. Check it with Audit the relayer.");
  assert.equal(T.landed({ height: 324_703, count: 5 }), "Landed in block 324,703. The relayer reports 5 transfers in this batch, yours included. Check it with Audit the relayer.");
  assert.equal(T.landedNoCount({ height: 324_721, mode: "batch10", releaseAt: 324_720 }), "Landed in block 324,721 with the 10-hour batch after block 324,720.");
  assert.equal(T.landedThin, "Few transfers were in this batch. With so few, it hid little.");
  assert.equal(T.split(1), "Landed one block after the rest of its batch, so its timing stands out.");
  assert.equal(T.split(3), "Landed 3 blocks after the rest of its batch, so its timing stands out.");
  assert.equal(T.overdue({ releaseAt: 324_702, lastRelease: 324_772, deadline: 324_796 }), "The batch after block 324,702 should have gone out by now. The relayer has until block 324,772 to send it. You can pay the fee yourself or copy the envelope; your notes stay reserved until it lands, or until block 324,796.");
  assert.equal(T.missed({ lastRelease: 324_772 }), "The relayer did not send it by block 324,772. Retry in the next batch, send at the next block, or pay the fee yourself. Same notes, so it can't pay twice.");
  assert.equal(T.nextBlockNote, "Sending at the next block reuses this envelope when it is recent enough; its anchor then shows it missed a batch.");
  assert.equal(T.settingsCaption, "Counts are reported by the relayer. Audit the relayer checks them against Bitcoin.");
  assert.equal(T.auditLine({ matched: 3, total: 4 }), "Batch sizes match Bitcoin: 3/4");
  assert.equal(T.toast.title, "Transfer scheduled.");
  assert.deepEqual(T.chip, { scheduled: "Scheduled", releasing: "Going out with the batch", attention: "Needs attention" });
  assert.deepEqual(T.now, { batch: "Hourly batch now", batch10: "10-hour batch now" });
  const keys = [];
  (function walk(o) {
    for (const [k, x] of Object.entries(o)) {
      keys.push(k);
      if (x && typeof x === "object") walk(x);
    }
  })(T);
  assert.deepEqual(keys.filter((k) => /12/.test(k)), [], "no key of the retired 12-hour batch is left");
  assert.equal(T.nowValue({ queued: 2, releaseAt: 324_702 }), "2 waiting · goes out after block 324,702");
  assert.deepEqual(T.recentColumns, { batch: "Batch", anchor: "Anchor block", sent: "Sent", landed: "Landed in" });
  // The session's not-eligible error is the same sentence as the form's line.
  assert.match(src("web/src/session.js"), /The note this send needs arrived after block \$\{int\(plan\.start\)\}, so it can join the batch that starts at block \$\{int\(plan\.eligibleAt\)\} \(\$\{eta\(plan\.eligibleAt - height\)\}\)\. Or send it with the next block now\./);
});

for (const mode of ["batch", "batch10"]) {
  const plan = SCHEDULE[mode];
  const other = mode === "batch" ? "batch10" : "batch";

  test(`${mode}: caption, Tor line, crowd, cannot-cancel${mode === "batch10" ? ", the three 10-hour lines" : ""} and the review row Time`, async (t) => {
    resetPrefs();
    net.info = relayInfo({ hourly: 5, ten: 7 });
    const s = await walletWithNotes();
    const v = await mountSend(t, s);
    await v.to(PAYEE);
    await v.amount("80");
    await choose(v, mode);
    const n = v.notes();
    const queued = mode === "batch" ? 5 : 7;
    assert.ok(has(n, BATCH_TEXT.caption[mode]), "caption");
    assert.ok(!has(n, BATCH_TEXT.caption[other]), "only this length's caption");
    assert.ok(has(n, BATCH_TEXT.ip), "the relayer sees IP and timing; Tor Browser hides the IP");
    assert.ok(has(n, BATCH_TEXT.crowd(queued)), "the relayer's count for this batch");
    assert.ok(!has(n, BATCH_TEXT.thin), "five or more waiting: not called thin");
    assert.ok(has(n, BATCH_TEXT.noCancel));
    assert.ok(!has(n, BATCH_TEXT.selfDefault), "a payment");
    const long = [BATCH_TEXT.long10.reserve({ deadline: plan.deadline, wait: plan.deadline - TIP }), BATCH_TEXT.long10.crowd, BATCH_TEXT.long10.stall({ lastRelease: plan.lastRelease })];
    for (const line of long) assert.equal(has(n, line), mode === "batch10", line);
    if (mode === "batch10") {
      assert.ok(has(n, "until block 324,760 (about 10 h)"), "deadline S+100");
      assert.ok(has(n, "until block 324,748 to send it"), "relayer deadline S+88");
    }
    assert.match(v.disclosure(), new RegExp(`<dt>Time</dt><dd>${esc(BATCH_TEXT.time({ mode, releaseAt: plan.releaseAt, wait: plan.releaseAt - TIP })).replace(/[()]/g, "\\$&")}</dd>`));
    assert.ok(!/class="reason caption"/.test(v.cta()), "the CTA is open");
  });

  test(`${mode}: a thin batch says so; a full or disabled length, or a note too new for the boundary, offers Next block`, async (t) => {
    resetPrefs();
    net.info = relayInfo({ hourly: 2, ten: 0 });
    const s = await walletWithNotes();
    s.relayModePref = "fast"; // a saved payment default the way out must not overwrite
    const v = await mountSend(t, s);
    assert.equal(checked(v.mode(), "timing"), "fast");
    await v.to(PAYEE);
    await v.amount("80");
    await choose(v, mode);
    const queued = mode === "batch" ? 2 : 0;
    assert.ok(has(v.notes(), BATCH_TEXT.crowd(queued)));
    assert.ok(has(v.notes(), BATCH_TEXT.thin), "fewer than 3 waiting");

    // Too new: the amount needs a note that arrived after S (hourly: 500 > 100 + 50; 10-hour: 120 > 100).
    await v.amount(mode === "batch" ? "500" : "120");
    const tooNew = BATCH_TEXT.tooNew({ start: plan.start, eligibleAt: plan.releaseAt, wait: plan.releaseAt - TIP });
    assert.ok(has(v.notes(), tooNew), "the not-eligible line");
    assert.match(v.notes(), /<button type="button" class="btn btn--ghost btn--sm" data-action="mode-block"><span>Send with the next block<\/span><\/button>/);
    assert.ok(!has(v.notes(), BATCH_TEXT.crowd(queued)), "it replaces the crowd line");
    assert.ok(has(v.cta(), BATCH_TEXT.tooNewCta({ eligibleAt: plan.releaseAt })), "and the CTA says why it waits");
    assert.match(v.cta(), /disabled/);
    await v.click("mode-block");
    assert.equal(checked(v.mode(), "timing"), "block", "the button switches to Next block");
    assert.equal(s.relayModePref, "fast", "a one-off way out, not a new default");
    assert.ok(has(v.notes(), BATCH_TEXT.otherModes));
    assert.ok(!/class="reason caption"/.test(v.cta()), "and the send can go now");

    // Full, then not taken at all: said before proving, with the same way out.
    await v.amount("80");
    for (const [info, line] of [
      [relayInfo({ hourly: 40, ten: 120 }), BATCH_TEXT.full],
      [relayInfo({ enabled: false, enabled10: false }), BATCH_TEXT.disabled],
      [{ ...relayInfo(), batch: undefined }, BATCH_TEXT.disabled],
    ]) {
      net.info = info;
      await s.loadRelayInfo();
      const w = await mountSend(t, s);
      await w.to(PAYEE);
      await w.amount("80");
      await choose(w, mode);
      assert.ok(has(w.notes(), line), line);
      assert.ok(has(w.cta(), line), "the CTA reason");
    }

    // The relayer reports another epoch (its tip differs): no count rather than the wrong one.
    net.info = relayInfo({ start: 324_690, start10: 324_600 });
    await s.loadRelayInfo();
    const w = await mountSend(t, s);
    await w.to(PAYEE);
    await w.amount("80");
    await choose(w, mode);
    assert.ok(!/Waiting for this batch/.test(w.notes()));
    assert.ok(has(w.notes(), BATCH_TEXT.caption[mode]));
  });

  test(`${mode}: after submit the sheet says Scheduled, when the recipient sees it and that it can't be cancelled`, async (t) => {
    resetPrefs();
    net.info = relayInfo();
    const s = await walletWithNotes();
    const sent = [];
    s.send = async (args) => {
      sent.push(args);
      args.onStep({ id: "queued", status: "ok", detail: `Scheduled for the batch after block ${plan.releaseAt}` });
      return { kind: "send", via: "relay", mode, anchor: plan.start, releaseAt: plan.releaseAt, lastRelease: plan.lastRelease, deadline: plan.deadline, relayId: "f".repeat(32), status: "relaying" };
    };
    const v = await mountSend(t, s);
    await v.to(PAYEE);
    await v.amount("80");
    await choose(v, mode);
    const before = painted.length;
    const toasts = made.length;
    await v.submit();
    assert.equal(sent.length, 1);
    assert.equal(sent[0].mode, mode, "the chosen length goes to the session");
    assert.equal(sent[0].via, "relay");
    const sheet = painted.slice(before).reverse().find((m) => m.includes('class="stepper"')) ?? "";
    assert.match(sheet, /<span class="step-label">Scheduled for the batch<\/span>/, "the last proving step");
    assert.ok(has(sheet, BATCH_TEXT.scheduled({ releaseAt: plan.releaseAt, deadline: plan.deadline })));
    assert.ok(has(sheet, BATCH_TEXT.recipientWait[mode]));
    assert.ok(!has(sheet, BATCH_TEXT.recipientWait[other]));
    assert.ok(has(sheet, BATCH_TEXT.noCancel));
    const toast = made.slice(toasts).map((x) => x.markup).find((m) => m.includes("Transfer scheduled.")) ?? "";
    assert.ok(has(toast, BATCH_TEXT.toast.body({ what: "80 ABC", releaseAt: plan.releaseAt })), "the toast");
    closeAllSheets();

    // A merge (to yourself) skips the recipient line.
    await v.to(s.address);
    await v.amount("80"); // a sent form clears its amount
    const mark = painted.length;
    await v.submit();
    const own = painted.slice(mark).reverse().find((m) => m.includes('class="stepper"')) ?? "";
    assert.ok(has(own, BATCH_TEXT.scheduled({ releaseAt: plan.releaseAt, deadline: plan.deadline })));
    assert.ok(!has(own, BATCH_TEXT.recipientWait[mode]));
    closeAllSheets();
  });
}

test("a self-transfer shows the merge line under every timing; the 10-hour batch keeps all its disclosures", async (t) => {
  resetPrefs();
  net.info = relayInfo();
  const s = await walletWithNotes();
  const v = await mountSend(t, s, new URLSearchParams(`to=${s.address}`));
  assert.equal(checked(v.mode(), "batchlen"), "batch");
  assert.ok(has(v.notes(), BATCH_TEXT.selfDefault));
  assert.ok(has(v.notes(), BATCH_TEXT.caption.batch));
  await v.seg("timing", "block");
  assert.ok(has(v.notes(), BATCH_TEXT.selfDefault), "under Next block too");
  await v.seg("timing", "batch");
  await v.seg("batchlen", "batch10");
  for (const line of [BATCH_TEXT.caption.batch10, BATCH_TEXT.ip, BATCH_TEXT.long10.crowd, BATCH_TEXT.selfDefault, BATCH_TEXT.noCancel]) assert.ok(has(v.notes(), line), line);
  assert.equal(s.selfModePref, "batch10");

  // Merge notes when the largest note is newer than the boundary: Next block for this send only.
  const m = await mountSend(t, s);
  await m.to(PAYEE);
  await m.click("merge");
  assert.equal(checked(m.mode(), "batchlen"), "batch10");
  assert.ok(has(m.notes(), BATCH_TEXT.tooNew({ start: 324_660, eligibleAt: 324_720, wait: 20 })), "the merge needs the 1,000 note from block 324,698");
  await m.click("mode-block");
  assert.equal(checked(m.mode(), "timing"), "block");
  assert.equal(s.selfModePref, "batch10", "merges keep their saved default");
  resetPrefs();
});

test("not in this batch at send time (NOT_IN_BATCH): nothing was sent, and the sheet offers Next block", async (t) => {
  resetPrefs();
  net.info = relayInfo();
  const s = await walletWithNotes();
  const text = BATCH_TEXT.tooNew({ start: 324_696, eligibleAt: 324_702, wait: 2 });
  s.send = async () => {
    throw Object.assign(new Error(text), { code: S.NOT_IN_BATCH, mode: "batch", start: 324_696, eligibleAt: 324_702 });
  };
  const v = await mountSend(t, s);
  await v.to(PAYEE);
  await v.amount("80");
  await choose(v, "batch");
  const before = painted.length;
  const sheets = made.length;
  await v.submit();
  const tail = painted.slice(before).reverse().find((m) => m.includes("Nothing more was sent.")) ?? "";
  assert.ok(has(tail, text));
  assert.match(tail, /data-sheet-close data-action="mode-block"/);
  const sheet = made.slice(sheets).find((x) => x.markup.includes('aria-label="Sending privately"'));
  assert.ok(sheet, "the proving sheet");
  fire(sheet.el, "click", clickOn("mode-block"));
  await settle();
  assert.equal(checked(v.mode(), "timing"), "block");
  closeAllSheets();
});

test("relay info for the crowd line: at most once per new block, and only while a batch is chosen", async (t) => {
  resetPrefs();
  net.info = relayInfo();
  const s = await walletWithNotes();
  net.calls = [];
  const v = await mountSend(t, s, new URLSearchParams(`to=${s.address}`)); // hourly batch
  assert.equal(infoCalls(), 1, "the page loads it once");
  await s.sync();
  await settle();
  assert.equal(infoCalls(), 1, "same block: not again");
  net.height = TIP + 1;
  await s.sync();
  await settle();
  assert.equal(infoCalls(), 2, "a new block: once");
  await s.sync();
  await settle();
  assert.equal(infoCalls(), 2);
  await v.seg("timing", "block");
  net.height = TIP + 2;
  await s.sync();
  await settle();
  assert.equal(infoCalls(), 2, "not under Next block");
  await v.seg("timing", "batch");
  assert.equal(infoCalls(), 3, "back on a batch at a block not loaded yet: once");
  await v.seg("batchlen", "batch10");
  assert.equal(infoCalls(), 3, "another length at the same block: not again");
  net.height = TIP;
  resetPrefs();
});

test("the inline Send with the next block keeps keyboard focus: on the Next block stop, announced", async (t) => {
  resetPrefs();
  net.info = relayInfo();
  const s = await walletWithNotes();
  const v = await mountSend(t, s);
  await v.to(PAYEE);
  await v.amount("500"); // needs the note from block 324,698: too new for the hourly batch
  await choose(v, "batch");
  assert.match(v.notes(), /data-action="mode-block"/);
  const focused = [];
  const stop = v.slot("mode").querySelector('[data-seg][data-name="timing"] .seg-opt[data-value="block"]');
  stop.focus = (o) => focused.push(o);
  await v.click("mode-block");
  assert.equal(checked(v.mode(), "timing"), "block");
  assert.ok(!/data-action="mode-block"/.test(v.notes()), "the button itself is gone");
  assert.deepEqual(focused, [{ preventScroll: true }], "focus moves to the stop now on");
  assert.equal(v.root.querySelector("[data-timing-live]").textContent, "Relay timing: Next block.", "announced in a live region outside the repainted slots");
  assert.match(src("web/src/views/app-send.js"), /<p class="visually-hidden" data-timing-live aria-live="polite"><\/p>/);
  resetPrefs();
});

test("Merge notes: a timing picked for the merge never carries over to the payment it set aside", async (t) => {
  resetPrefs();
  net.info = relayInfo();
  const s = await walletWithNotes();
  s.send = async (args) => ({ kind: "send", via: "relay", mode: args.mode, anchor: 324_660, releaseAt: 324_720, lastRelease: 324_748, deadline: 324_760, relayId: "f".repeat(32), status: "relaying" });
  const v = await mountSend(t, s);
  await v.to(PAYEE);
  await v.amount("80");
  assert.equal(checked(v.mode(), "timing"), "block");
  await v.click("merge");
  assert.equal(checked(v.mode(), "batchlen"), "batch", "the merge: hourly batch");
  await v.seg("batchlen", "batch10");
  await v.submit();
  closeAllSheets();
  assert.equal(v.f.querySelector("[name=to]").value, PAYEE, "the recipient is back");
  assert.equal(checked(v.mode(), "timing"), "block", "and with it the payment's Next block, not the merge's 10-hour batch");
  assert.equal(segOf(v.mode(), "batchlen"), null);

  // A payment's own pick waits with it, through Put it back now too.
  await v.seg("timing", "fast");
  await v.click("merge");
  assert.equal(checked(v.mode(), "batchlen"), "batch10", "the merge takes the self-transfer default (remembered 10-hour)");
  await v.click("restore-to");
  assert.equal(checked(v.mode(), "timing"), "fast", "the payment's Fast comes back");
  const f = SEND.mergeForm({ to: PAYEE, amount: "5", mode: "fast", modeTouched: true, batchLen: null, aside: null }, "mrk1self", "9");
  assert.deepEqual([f.to, f.modeTouched, f.aside], ["mrk1self", false, { to: PAYEE, amount: "5", mode: "fast", modeTouched: true, batchLen: null }]);
  assert.deepEqual(SEND.restoreForm({ ...f, mode: "batch10", modeTouched: true }), { ...f, to: PAYEE, amount: "5", mode: "fast", modeTouched: true, batchLen: null, aside: null });
  resetPrefs();
});

test("the privacy hint grades the notes the batch send will spend (only those in the tree at its boundary)", async (t) => {
  resetPrefs();
  net.info = relayInfo();
  const s = await walletWithNotes();
  const v = await mountSend(t, s);
  const hint = () => String(v.slot("hint").innerHTML);
  await v.to(PAYEE);
  await v.amount("80");
  assert.ok(has(hint(), "It arrived 2 blocks ago."), "Next block spends the 1,000 note from block 324,698");
  await choose(v, "batch");
  assert.ok(has(hint(), "It arrived 100 blocks ago."), "the hourly batch spends the 100 note from block 324,600");
  assert.ok(!has(hint(), "It arrived 2 blocks ago."));
  await v.amount("500"); // only the too-new note covers it: no hint, the timing notes say why
  assert.ok(!/Privacy of this send/.test(hint()));
  resetPrefs();
});

/* ---------- 4. Activity ---------- */

/** A relayed batch send as the session records it (batch-contract.md §4.3). */
const batchEntry = (over = {}) => ({
  id: "e1", kind: "send", via: "relay", mode: "batch", status: "relaying", relayStatus: "queued", relayId: "r".repeat(32),
  ticker: "ABC", assetId: "7", amount: "5", div: 0, to: PAYEE, spends: ["11", "12"], commitments: ["21", "22"],
  anchor: 324_696, epochBlocks: 6, releaseAt: 324_702, lastRelease: 324_772, deadline: 324_796, envelope: "ab".repeat(16), time: Date.now(),
  ...over,
});

function activitySession(tip, history) {
  const s = new S.Session({ phrase: S.newPhrase() });
  s.view = { startHeight: 324_592, height: tip, outputs: [], nullifiers: new Set(), tree: null };
  s.history = history;
  s.sync = async () => {}; // the fixtures are the statuses under test
  return s;
}

async function mountActivity(t, s) {
  const root = new FakeEl();
  const off = ACT.activityView(root, s, null);
  t.after(off);
  await settle();
  return { root, page: () => String(root.innerHTML), click: (act, id) => (fire(root, "click", clickOn(act, { id })), settle()) };
}

// button() writes data-id before data-action.
const actions = (markup) => [...String(markup).matchAll(/data-id="[^"]+" data-action="(retry-[a-z]+|copy-env)"/g)].map((x) => x[1]);
/** The history list only (the page lead mentions scheduled transfers too). */
const rowsOf = (page) => page.slice(page.indexOf('<ul class="acts">'));

test("Activity: Scheduled before releaseAt, then going out, overdue and missed, each with its line and buttons", async (t) => {
  const cases = [
    { tip: 324_700, chip: "Scheduled", tone: "btc", line: BATCH_TEXT.scheduledLine({ mode: "batch", releaseAt: 324_702, wait: 2, deadline: 324_796 }), buttons: [], seal: false },
    { tip: 324_703, chip: "Going out with the batch", tone: "btc", line: BATCH_TEXT.releasing({ mode: "batch", releaseAt: 324_702, deadline: 324_796, broadcast: false }), buttons: [], seal: false },
    { tip: 324_710, over: { relayStatus: "broadcast" }, chip: "Going out with the batch", tone: "btc", line: BATCH_TEXT.releasing({ mode: "batch", releaseAt: 324_702, deadline: 324_796, broadcast: true }), buttons: [], seal: true },
    { tip: 324_706, chip: "Needs attention", tone: "warn", line: BATCH_TEXT.overdue({ releaseAt: 324_702, lastRelease: 324_772, deadline: 324_796 }), buttons: ["retry-self", "copy-env"] },
    { tip: 324_772, chip: "Needs attention", tone: "warn", line: BATCH_TEXT.overdue({ releaseAt: 324_702, lastRelease: 324_772, deadline: 324_796 }), buttons: ["retry-self", "copy-env"] },
    { tip: 324_773, chip: "Needs attention", tone: "warn", line: BATCH_TEXT.missed({ lastRelease: 324_772 }), buttons: ["retry-batch", "retry-block", "retry-self", "copy-env"], note: true },
    { tip: 324_773, over: { envelope: undefined }, chip: "Needs attention", tone: "warn", line: BATCH_TEXT.missed({ lastRelease: 324_772 }), buttons: ["retry-batch", "retry-block", "retry-self"], note: true },
    {
      tip: 324_748, over: { mode: "batch10", anchor: 324_660, epochBlocks: 60, releaseAt: 324_720, lastRelease: 324_748, deadline: 324_760 },
      chip: "Needs attention", tone: "warn", line: BATCH_TEXT.overdue({ releaseAt: 324_720, lastRelease: 324_748, deadline: 324_760 }), buttons: ["retry-self", "copy-env"],
    },
    {
      tip: 324_749, over: { mode: "batch10", anchor: 324_660, epochBlocks: 60, releaseAt: 324_720, lastRelease: 324_748, deadline: 324_760 },
      chip: "Needs attention", tone: "warn", line: BATCH_TEXT.missed({ lastRelease: 324_748 }), buttons: ["retry-batch", "retry-block", "retry-self", "copy-env"], note: true,
    },
    {
      tip: 324_700, over: { mode: "batch10", anchor: 324_660, epochBlocks: 60, releaseAt: 324_720, lastRelease: 324_748, deadline: 324_760 },
      chip: "Scheduled", tone: "btc", line: BATCH_TEXT.scheduledLine({ mode: "batch10", releaseAt: 324_720, wait: 20, deadline: 324_760 }), buttons: [], seal: false,
    },
  ];
  for (const c of cases) {
    const s = activitySession(c.tip, [batchEntry(c.over)]);
    const v = await mountActivity(t, s);
    const page = v.page();
    const label = `${c.chip} at ${c.tip}`;
    assert.match(page, new RegExp(`<span class="tag tag--${c.tone}">${c.chip}</span>`), label);
    assert.ok(has(page, c.line), label);
    assert.deepEqual(actions(page), c.buttons, label);
    assert.equal(has(page, BATCH_TEXT.nextBlockNote), Boolean(c.note), label);
    assert.equal(/Notes unlock at block/.test(page), Boolean(c.note), `${label}: the W-1 unlock line once the relayer missed it`);
    if (c.seal !== undefined) assert.equal(/In the mempool/.test(page), c.seal, `${label}: a held batch transfer is in no mempool`);
    assert.ok(!/Queued at the relayer\. Valid until/.test(page), `${label}: not the Next-block line`);
    assert.equal(net.calls.includes("/api/relay/status/" + "r".repeat(32)), false, "the view itself never asks about one transfer");
  }
  // The labels on the buttons.
  const s = activitySession(324_773, [batchEntry()]);
  const page = (await mountActivity(t, s)).page();
  for (const label of ["Retry in the next batch", "Send at the next block", "Pay the fee myself (links this transfer to your BTC address)", "Copy envelope hex"]) assert.ok(has(page, label), label);
  assert.ok(!has(page, "Retry with the same notes"), "the Next-block retry label is for non-batch rows");
});

test("Activity: a failed batch send offers the next batch, the next block, paying yourself and the envelope", async (t) => {
  const s = activitySession(324_710, [batchEntry({ status: "failed", relayStatus: "dropped", reason: "No longer valid after a reorg." })]);
  const page = (await mountActivity(t, s)).page();
  assert.match(page, /<span class="tag tag--warn">Needs attention<\/span>/);
  assert.deepEqual(actions(page), ["retry-batch", "retry-block", "retry-self", "copy-env"]);
  assert.ok(has(page, BATCH_TEXT.nextBlockNote));
  assert.ok(has(page, "Notes unlock at block 324,797"), "W-1: reserved until anchor + 100");
  for (const status of ["expired", "dropped", "rejected"]) {
    const p = (await mountActivity(t, activitySession(324_710, [batchEntry({ status })]))).page();
    assert.deepEqual(actions(p), [], `${status}: nothing to retry`);
  }
});

test("Activity: retry in the next batch keeps the entry's timing; send at the next block switches it; both reuse the notes", async (t) => {
  const e = batchEntry();
  const s = activitySession(324_773, [e]);
  const calls = [];
  s.retry = async (entry, opts) => {
    calls.push(opts);
    if (opts.mode) Object.assign(entry, { mode: opts.mode, releaseAt: null, lastRelease: null, epochBlocks: null });
    else Object.assign(entry, { anchor: 324_768, releaseAt: 324_774, lastRelease: 324_844, deadline: 324_868 });
    entry.status = "relaying";
    return entry;
  };
  const v = await mountActivity(t, s);
  let mark = painted.length;
  await v.click("retry-batch", "e1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].via, "relay");
  assert.ok(!("mode" in calls[0]), "the entry's own mode: the session re-plans at the current boundary");
  let sheet = painted.slice(mark).reverse().find((m) => m.includes('class="stepper"')) ?? "";
  assert.match(sheet, /Scheduled for the batch/);
  assert.ok(has(sheet, BATCH_TEXT.retried({ releaseAt: 324_774, deadline: 324_868 })));
  closeAllSheets();

  Object.assign(e, { anchor: 324_696, releaseAt: 324_702, lastRelease: 324_772, deadline: 324_796 });
  mark = painted.length;
  await v.click("retry-block", "e1");
  assert.equal(calls[1].mode, "block");
  assert.equal(calls[1].via, "relay");
  sheet = painted.slice(mark).reverse().find((m) => m.includes('class="stepper"')) ?? "";
  assert.match(sheet, /Queued for the next block/);
  assert.ok(has(sheet, "Handed to the relayer again. Same notes, so it can't pay twice."));
  closeAllSheets();
  assert.match(src("web/src/views/app-activity.js"), /b\.dataset\.action === "retry-block"\) retry\(entry, "relay", "block"\)/);
});

test("Activity: landed with the relayer's count, thin and split batches, and the 10-hour crowd told apart", async (t) => {
  const recent = [
    { mode: "batch", start: 324_696, releaseAt: 324_702, released: 5, landed: [[324_703, 5]] },
    { mode: "batch", start: 324_690, releaseAt: 324_696, released: 2, landed: [[324_697, 2]] },
    { mode: "batch", start: 324_684, releaseAt: 324_690, released: 5, landed: [[324_691, 4], [324_693, 1]] },
    { mode: "batch", start: 324_660, releaseAt: 324_666, released: 9, landed: [[324_667, 9]] },
    { mode: "batch10", start: 324_660, releaseAt: 324_720, released: 2, landed: [[324_721, 2]] },
  ];
  net.info = relayInfo({ recent });
  const landed = (over) => batchEntry({ status: "accepted", relayStatus: "accepted", envelope: undefined, ...over });
  const cases = [
    { e: landed({ height: 324_703 }), lines: [BATCH_TEXT.landed({ height: 324_703, count: 5 })], not: [BATCH_TEXT.landedThin, "after the rest of its batch"] },
    { e: landed({ anchor: 324_690, releaseAt: 324_696, height: 324_697 }), lines: [BATCH_TEXT.landed({ height: 324_697, count: 2 }), BATCH_TEXT.landedThin], not: ["after the rest of its batch"] },
    { e: landed({ anchor: 324_684, releaseAt: 324_690, height: 324_693 }), lines: [BATCH_TEXT.landed({ height: 324_693, count: 5 }), BATCH_TEXT.split(2)], not: [BATCH_TEXT.landedThin] },
    { e: landed({ anchor: 324_684, releaseAt: 324_690, height: 324_691 }), lines: [BATCH_TEXT.landed({ height: 324_691, count: 5 })], not: ["after the rest of its batch"] },
    { e: landed({ mode: "batch10", anchor: 324_660, epochBlocks: 60, releaseAt: 324_720, lastRelease: 324_748, deadline: 324_760, height: 324_721 }), lines: [BATCH_TEXT.landed({ height: 324_721, count: 2 }), BATCH_TEXT.landedThin], not: ["9 transfers"] },
    { e: landed({ anchor: 324_678, releaseAt: 324_684, height: 324_685 }), lines: [BATCH_TEXT.landedNoCount({ height: 324_685, mode: "batch", releaseAt: 324_684 })], not: ["The relayer reports"] },
  ];
  for (const c of cases) {
    net.calls = [];
    const s = activitySession(324_730, [c.e]);
    const v = await mountActivity(t, s);
    assert.equal(infoCalls(), 1, "relay info once, for the counts");
    const page = v.page();
    assert.match(page, /<span class="tag tag--proof">Accepted<\/span>/);
    for (const line of c.lines) assert.ok(has(page, line), line);
    for (const line of c.not) assert.ok(!has(page, line), `not: ${line}`);
    assert.deepEqual(actions(page), []);
    // Repaints (a filter click) don't ask again.
    fire(v.root, "click", { target: { closest: (sel) => (sel === "[data-filter]" ? { dataset: { filter: "sent" } } : null) } });
    await settle();
    assert.equal(infoCalls(), 1);
  }
  // A one-block split, and nothing asked when no batch transfer landed.
  assert.equal(String(ACT.batchLines(landed({ anchor: 324_684, releaseAt: 324_690, height: 324_692 }), 324_730, { batch: { recent: [{ mode: "batch", start: 324_684, landed: [[324_691, 3], [324_692, 1]] }] } })[2]).includes(esc(BATCH_TEXT.split(1))), true);
  net.calls = [];
  await mountActivity(t, activitySession(324_730, [batchEntry()]));
  assert.equal(infoCalls(), 0, "a scheduled transfer needs no relay info");
});

test("Activity: the Failed filter and the portfolio callout include batch sends the relayer is late with or missed", async (t) => {
  const PORT = await import("../web/src/views/app-portfolio.js");
  for (const [tip, chip] of [[324_706, "overdue"], [324_773, "missed"]]) {
    const s = activitySession(tip, [batchEntry()]);
    const root = new FakeEl();
    t.after(ACT.activityView(root, s, new URLSearchParams("f=failed")));
    await settle();
    const page = String(root.innerHTML);
    assert.match(page, /<span class="tag tag--warn">Needs attention<\/span>/, chip);
    assert.ok(!page.includes("Nothing failed."), `${chip}: not called on its way`);
    assert.ok(actions(page).includes("retry-self"), chip);
    assert.ok(ACT.matches("failed", batchEntry(), tip));
    assert.match(String(PORT.attention(s)), /1 transfer<\/b>|1 transfer needs attention/, `${chip}: the portfolio callout counts it`);
  }
  for (const tip of [324_700, 324_703]) assert.equal(ACT.matches("failed", batchEntry(), tip), false, "scheduled or going out: not failed");
  assert.equal(ACT.matches("failed", batchEntry()), false, "no tip: by status only");
  const none = activitySession(324_700, [batchEntry()]);
  assert.equal(String(PORT.attention(none)), "");
});

test("Activity: a batch the relayer expired past lastRelease shows the missed line, not the relayer's raw reason", async (t) => {
  const e = batchEntry({ status: "failed", relayStatus: "expired", reason: "the batch could not be sent before block 324772" });
  const page = (await mountActivity(t, activitySession(324_776, [e]))).page();
  assert.ok(has(page, BATCH_TEXT.missed({ lastRelease: 324_772 })));
  assert.ok(!page.includes("could not be sent before block"), "no raw relayer string");
  assert.match(page, /<span class="tag tag--warn">Needs attention<\/span>/);
  assert.deepEqual(actions(page), ["retry-batch", "retry-block", "retry-self", "copy-env"]);
  assert.ok(has(page, "Notes unlock at block 324,797"));
  // Other failures keep their reason.
  const other = (await mountActivity(t, activitySession(324_710, [batchEntry({ status: "failed", relayStatus: "dropped", reason: "No longer valid after a reorg." })]))).page();
  assert.ok(has(other, "No longer valid after a reorg."));
  assert.ok(!has(other, BATCH_TEXT.missed({ lastRelease: 324_772 })));
});

test("Activity: Next-block and Fast rows are unchanged", async (t) => {
  const plain = (over) => batchEntry({ mode: "block", epochBlocks: undefined, releaseAt: undefined, lastRelease: undefined, anchor: 324_700, deadline: 324_800, ...over });
  let page = (await mountActivity(t, activitySession(324_701, [plain()]))).page();
  assert.match(page, /<span class="tag tag--btc">Queued at relayer<\/span>/);
  assert.ok(has(page, "Queued at the relayer. Valid until block 324,800."));
  assert.match(page, /In the mempool/, "the seal as before");
  page = (await mountActivity(t, activitySession(324_701, [plain({ relayStatus: "broadcast" })]))).page();
  assert.match(page, /<span class="tag tag--btc">Broadcast by relayer<\/span>/);
  assert.ok(has(page, "Broadcast by the relayer; waiting for a block. Valid until block 324,800."));
  page = (await mountActivity(t, activitySession(324_710, [plain({ status: "failed", mode: "fast", reason: "The relayer dropped this transfer." })]))).page();
  assert.match(page, /<span class="tag tag--warn">Needs attention<\/span>/);
  assert.deepEqual(actions(page), ["retry-relay", "retry-self", "copy-env"]);
  assert.match(page, /data-id="e1" data-action="retry-relay"><svg[\s\S]*?<span>Retry with the same notes<\/span>/);
  assert.ok(has(page, "Notes unlock at block 324,801"));
  for (const line of [BATCH_TEXT.nextBlockNote, "Retry in the next batch", "Scheduled", "Going out with the batch"]) assert.ok(!has(rowsOf(page), line), line);
  // Mints, launches and received notes never get batch chips.
  assert.match(String(statusChip({ kind: "mint", status: "mempool" }, 324_701)), /Waiting for a block/);
  assert.match(String(statusChip(batchEntry(), null)), /Queued at relayer/, "without a tip: the plain relay chip");
});

/* ---------- 5. Settings ---------- */

function carrier(txid, anchor, height, fee = 597) {
  const body = encodeTxBody({
    op: OP.TRANSACT, anchor, publicAmount: 0n, nullifiers: [11n, 12n], commitments: [21n, 22n],
    ciphertexts: [new Uint8Array(95).fill(1), new Uint8Array(95).fill(2)],
  });
  const env = new Uint8Array(body.length + 128);
  env.set(body);
  return {
    txid, fee, status: { confirmed: true, block_height: height },
    vin: [{ prevout: { scriptpubkey_address: RELAYER } }],
    vout: [{ scriptpubkey_type: "op_return", scriptpubkey: hex(opReturnScript(env)), value: 0 }, { scriptpubkey_address: RELAYER, value: 1000 }],
  };
}

test("Settings: Batches rows, Recent batches (12 at most, newest first) and the caption; the network note", async (t) => {
  const recent = Array.from({ length: 30 }, (_, i) => ({ mode: i % 5 === 0 ? "batch10" : "batch", start: 324_000 + i * 6, releaseAt: 324_006 + i * 6, released: 3, landed: [[324_007 + i * 6, 2], [324_008 + i * 6, 1]] }));
  net.info = relayInfo({ hourly: 2, ten: 0, recent });
  net.ledger = { items: [], totals: { carriers: 0, accepted: 0, wasted: 0, satsSpent: 0 } };
  const s = activitySession(TIP, []);
  const root = new FakeEl();
  t.after(SET.settingsView(root, s));
  await settle(20);
  const page = String(root.innerHTML);
  const block = page.slice(page.indexOf("data-batches"), page.indexOf("</table>", page.indexOf("data-batches")));
  assert.ok(block.length > 100, "the Batches block is in Relayer books");
  assert.ok(page.indexOf('id="relayer"') < page.indexOf("data-batches"));
  assert.match(block, /<b>Batches<\/b>/);
  assert.match(block, /<dt>Hourly batch now<\/dt><dd><span class="mono">2 waiting · goes out after block 324,702<\/span>/);
  assert.match(block, /<dt>10-hour batch now<\/dt><dd><span class="mono">0 waiting · goes out after block 324,720<\/span>/);
  assert.match(block, /<caption class="visually-hidden">Recent batches<\/caption><thead><tr><th scope="col" class="">Batch<\/th><th scope="col" class="num">Anchor block<\/th><th scope="col" class="num">Sent<\/th><th scope="col" class="">Landed in<\/th><\/tr><\/thead>/);
  const rows = block.split("<tr>").slice(2);
  assert.equal(rows.length, 12, "at most 12 rows");
  assert.match(rows[0], /10-hour batch|Hourly batch/);
  assert.match(rows[0], /#324,174/, "newest first: the last of the 30");
  assert.match(rows[0], /#324,181 \(2\), #324,182 \(1\)/, "landed blocks with their counts");
  assert.match(rows[1], /#324,168/);
  assert.ok(has(page, BATCH_TEXT.settingsCaption));
  assert.ok(has(page, BATCH_TEXT.networkNote), "Network activity: no lookups before the batch goes out");
  assert.ok(has(page, "until a relayed transfer lands or expires, each sync asks the relayer about it by its relay id"), "the existing disclosure stays");

  // A length the relayer is not taking.
  const off = String(SET.batchesBlock(relayInfo({ enabled10: false }).batch));
  assert.match(off, /<dt>10-hour batch now<\/dt><dd><span class="t-3">not taking transfers right now<\/span>/);
  assert.equal(String(SET.batchesBlock(undefined)), "", "no block from a relayer without batches");
  assert.ok(has(String(SET.batchesBlock({ modes: relayInfo().batch.modes, recent: [] })), "No batches sent yet."));
});

test("Settings: the batch rows follow new blocks (relay info once per block), repainting only Relayer books", async (t) => {
  net.info = relayInfo({ hourly: 2, ten: 0 });
  net.ledger = { items: [], totals: { carriers: 0, accepted: 0, wasted: 0, satsSpent: 0 } };
  const s = await walletWithNotes();
  const root = new FakeEl();
  t.after(SET.settingsView(root, s));
  await settle(20);
  assert.match(String(root.innerHTML), /2 waiting · goes out after block 324,702/);
  const slot = root.querySelector("[data-relayer-slot]");
  net.calls = [];
  await s.sync(); // same block
  await settle(20);
  assert.equal(infoCalls(), 0);
  net.info = relayInfo({ hourly: 0, ten: 1, start: 324_702 });
  net.height = TIP + 2;
  const pages = painted.length;
  await s.sync();
  await settle(20);
  assert.equal(infoCalls(), 1, "a new block: relay info once");
  assert.match(String(slot.innerHTML), /<dt>Hourly batch now<\/dt><dd><span class="mono">0 waiting · goes out after block 324,708<\/span>/);
  assert.ok(!painted.slice(pages).some((m) => m.includes('class="wl"')), "the page itself is not repainted");
  net.height = TIP;
});

test("Settings: Audit the relayer adds the batch line and each mismatch", async (t) => {
  const recent = [
    { mode: "batch", start: 324_696, releaseAt: 324_702, released: 3, landed: [[324_703, 3]] },
    { mode: "batch", start: 324_690, releaseAt: 324_696, released: 3, landed: [[324_697, 3]] },
  ];
  net.info = relayInfo({ recent });
  net.txs = [
    carrier("c1", 324_696, 324_703), carrier("c2", 324_696, 324_703), carrier("c3", 324_696, 324_703),
    carrier("c4", 324_690, 324_697), carrier("c5", 324_690, 324_697),
    { txid: "f1", fee: 900, status: { confirmed: true, block_height: 324_600 }, vin: [{ prevout: { scriptpubkey_address: RELAYER } }], vout: [{ scriptpubkey_address: RELAYER }, { scriptpubkey_address: RELAYER }] },
  ];
  net.ledger = {
    items: net.txs.map((x) => ({ kind: x.txid.startsWith("f") ? "fanout" : "carrier", txid: x.txid, fee: x.fee, outcome: "accepted", height: x.status.block_height })),
    totals: { carriers: 5, accepted: 5, wasted: 0, satsSpent: 3885 },
  };
  const s = activitySession(TIP, []);
  const root = new FakeEl();
  t.after(SET.settingsView(root, s));
  await settle(20);
  fire(root, "click", clickOn("audit"));
  await settle(40);
  const page = String(root.innerHTML);
  assert.match(page, /Ledger matches Bitcoin: 6\/6/, "the existing ledger line");
  assert.ok(has(page, BATCH_TEXT.auditLine({ matched: 1, total: 2 })), "batch sizes against Bitcoin");
  assert.ok(has(page, "Hourly batch at anchor block 324,690: Bitcoin shows 2 carriers for this batch; the relayer reports 3."));
  assert.match(page, /data-audit-batches><div class="callout callout--warn">/);

  const ok = String(SET.auditBatches({ rows: [{ mode: "batch10", start: 324_660, reported: 2, onChain: 2, ok: true, note: null }], matched: 1, total: 1, skipped: 0 }));
  assert.match(ok, /callout--proof/);
  assert.ok(has(ok, "Batch sizes match Bitcoin: 1/1"));
  assert.equal(String(SET.auditBatches({ rows: [], matched: 0, total: 0, skipped: 3 })), "", "nothing checkable: no line");
  assert.equal(String(SET.auditBatches(undefined)), "");
  net.txs = [];
});

/* ---------- 6. copy rules and docs ---------- */

/** Every BATCH_TEXT string, functions called with sample values. */
function allBatchText(v = BATCH_TEXT, out = []) {
  const args = { start: 324_696, eligibleAt: 324_702, wait: 2, mode: "batch10", releaseAt: 324_702, deadline: 324_796, lastRelease: 324_772, height: 324_703, count: 2, broadcast: true, what: "5 ABC", queued: 2, matched: 1, total: 2, note: "a note" };
  if (typeof v === "string") out.push(v);
  else if (typeof v === "function") {
    for (const a of [args, 1, 2, [[324_703, 2]]]) {
      try {
        const r = v(a);
        if (typeof r === "string") out.push(r);
      } catch {}
    }
  } else if (v && typeof v === "object") for (const x of Object.values(v)) allBatchText(x, out);
  return out;
}

const NEVER = [/level\s*2/i, /\bmix(er|ers|ing|ed)?\b/i, /\bblend/i, /ghost mode/i, /\banonymous/i, /\buntraceable\b/i, /fully anonymous/i, /learns nothing/i];

test("batch copy: none of the never-words, no percentages, transfers counted and never people", async (t) => {
  const strings = allBatchText();
  assert.ok(strings.length > 60, `collected ${strings.length} strings`);
  // The batch UI as rendered: the control, the lines, the Activity rows and the Settings block.
  const ui = [
    ...["fast", "block", "batch", "batch10"].map((m) => String(SEND.timingControl(m))),
    ...["block", "batch", "batch10"].map((m) => String(SEND.timingNotes({ mode: m, self: true, plan: { ...SCHEDULE[m === "block" ? "batch" : m], eligible: false, reason: "too-new", eligibleAt: 324_702 }, info: relayInfo({ hourly: 1, ten: 1 }), height: TIP }))),
    ...["batch", "batch10"].map((m) => String(SEND.timingNotes({ mode: m, plan: { ...SCHEDULE[m], eligible: true, reason: null }, info: relayInfo({ hourly: 1, ten: 1 }), height: TIP }))),
    ...[324_700, 324_703, 324_706, 324_773].flatMap((tip) => ACT.batchLines(batchEntry(), tip).map(String)),
    ...ACT.batchLines(batchEntry({ status: "accepted", height: 324_704 }), 324_710, relayInfo({ recent: [{ mode: "batch", start: 324_696, landed: [[324_703, 1], [324_704, 1]] }] })).map(String),
    String(ACT.retryButtons(batchEntry(), 324_773)),
    String(SET.batchesBlock(relayInfo({ recent: [{ mode: "batch10", start: 324_660, releaseAt: 324_720, released: 1, landed: [[324_721, 1]] }] }).batch)),
    String(SET.auditBatches({ rows: [{ mode: "batch", start: 324_690, reported: 3, onChain: 2, ok: false, note: "Bitcoin shows 2 carriers for this batch; the relayer reports 3." }], matched: 0, total: 1 })),
  ];
  // Text only: icon markup (say, mix-blend-mode) is not copy.
  for (const text of [...strings, ...ui.map((m) => m.replace(/<[^>]*>/g, " "))]) {
    for (const re of NEVER) assert.ok(!re.test(text), `${re} in: ${text}`);
    assert.ok(!/%/.test(text.replace(/%[0-9A-F]{2}/g, "")), `a percentage in: ${text}`);
    assert.ok(!/\b(users?|people|persons?|holders?|senders?)\b\s*(\(|:|waiting|in this)/i.test(text) && !/\d[\d,]*\s+(users?|people|persons?|holders?|senders?)\b/i.test(text), `a count of people in: ${text}`);
  }
  assert.ok(strings.some((x) => /transfers? in this batch/.test(x)), "counts are transfers");
  // The files the batch UI lives in, comments aside.
  for (const f of ["web/src/views/app-send.js", "web/src/views/app-activity.js", "web/src/views/app-settings.js", "web/src/views/app-shared.js"]) {
    const code = src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const re of [/level\s*2/i, /\bmixer\b/i, /ghost mode/i, /\banonymous\b/i, /\buntraceable\b/i]) assert.ok(!re.test(code), `${f}: ${re}`);
  }
});

test("the README roadmap no longer lists Privacy delay; privacy-level2.md describes both lengths and records the 10-hour change", () => {
  const readme = src("README.md");
  const roadmap = readme.slice(readme.indexOf("## Roadmap"));
  assert.ok(readme.includes("## Roadmap"), "the README has a roadmap");
  assert.ok(!/Privacy delay/i.test(roadmap), "no Privacy delay on the roadmap");
  assert.doesNotMatch(roadmap, /12-hour|72 blocks/);

  const doc = src("docs/design/privacy-level2.md");
  assert.ok(!/Status: proposal, nothing built/.test(doc));
  for (const s of ["10-hour batch", "S+76", "S+88", "S+60", "S+61", "Tor Browser", "batch-contract.md", "13,000"]) assert.ok(doc.includes(s), s);
  assert.match(doc, /## 9\. Decisions \(final, 2026-10-02\)/, "§9 kept as recorded");
  const nine = doc.slice(doc.indexOf("## 9. Decisions"), doc.indexOf("## 10."));
  assert.match(nine, /2026-10-03/, "§9 records the change to the 10-hour batch");
  assert.match(nine, /3 to 29 blocks/, "and its reason");
  assert.ok(!/One 25,000-sat fan-out coin/.test(doc), "the fan-out numbers follow the contract");
  // Only the never-say list (6.4) and the decision that quotes it (9) may name these words.
  const prose = doc.replace(/### 6\.4 Never say[\s\S]*?### 6\.5/, "").replace(/## 9\. Decisions[\s\S]*?## 10\./, "");
  for (const banned of [/fully anonymous/i, /\buntraceable\b/i]) assert.ok(!banned.test(prose), String(banned));
});

test("every batch view file keeps its line endings", () => {
  const crlf = ["web/src/views/app-send.js", "web/src/views/app-shared.js", "web/src/styles/components.css", "web/src/styles/pages.css"];
  const lf = ["web/src/views/app-activity.js", "web/src/views/app-settings.js", "web/src/styles/base.css", "web/src/styles/tokens.css", "docs/design/privacy-level2.md", "test/batch-views.test.mjs"];
  const raw = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
  for (const f of crlf) {
    const b = raw(f);
    assert.equal((b.match(/\r\n/g) ?? []).length, (b.match(/\n/g) ?? []).length, `${f}: CRLF throughout`);
  }
  for (const f of lf) assert.ok(!raw(f).includes("\r"), `${f}: LF only`);
});

/* ---------- 7. no relayer on the server: relaying off (relay-balance-contract.md §4.2, §5.4) ---------- */

/** What a server without a relayer answers for GET /api/relay/info (server/retired-relay.mjs relayInfoOff). */
const OFF_INFO = relayInfoOff();
const RETIRED = "The free relayer was retired. Pay the fee yourself, or copy the envelope.";
/** Closes the relay route for one test, as the shipped wallet has it. */
const closeRelay = (t) => {
  RELAY_ROUTE.open = false;
  t.after(() => (RELAY_ROUTE.open = true));
};
const routeValues = (markup) => [...String(markup).matchAll(/name="route" value="([a-z]+)"/g)].map((x) => x[1]);

test("stage 0: Send offers only Pay the fee myself and Copy envelope, with the linkage line and no timing control", async (t) => {
  closeRelay(t);
  resetPrefs();
  net.info = OFF_INFO;
  const s = await walletWithNotes();
  S.storage.setItem(`${STORAGE_PREFIX}.route`, "relay"); // saved by an older build
  assert.equal(s.routePref, "self", "a saved relay route reads as paying yourself");
  const calls = infoCalls();
  const asked = net.calls.length;
  const v = await mountSend(t, s);
  assert.deepEqual(routeValues(v.slot("route").innerHTML), ["self", "copy"]);
  assert.ok(has(v.slot("route").innerHTML, "Pay the fee myself: Bitcoin shows this transfer was made by your BTC address, permanently"));
  assert.ok(has(v.slot("route").innerHTML, SEND.ROUTE_TEXT.copyTitle));
  const notes = String(v.root.querySelector("[data-route-notes]").innerHTML);
  assert.ok(has(notes, "The paying address is tied to this transfer on Bitcoin. Fund the built-in key from a source not linked to your main wallet."));
  assert.ok(has(notes, "Relaying is off on this server. Pay the fee yourself, or copy the envelope."));
  assert.equal(SEND.ROUTE_TEXT.off, "Relaying is off on this server. Pay the fee yourself, or copy the envelope.");
  assert.ok(!notes.includes("relay-topup"), "no top-up entry while no relayer runs");
  assert.equal(v.mode(), "", "no Relay timing control");
  assert.equal(v.notes(), "", "no timing notes");
  assert.equal(infoCalls(), calls + 1, "relay info (the same for every wallet) is asked for once, to learn that no relayer runs");
  assert.ok(!net.calls.slice(asked).includes("/api/relay/account"), "no balance read");
  const aside = String(v.slot("aside").innerHTML);
  assert.ok(has(aside, "Relaying is off on this server. Pay the fee yourself, or copy the envelope."));
  for (const markup of [v.slot("route").innerHTML, notes, aside, v.disclosure()]) {
    assert.doesNotMatch(String(markup), /free|sponsor|Ghost Relay|need no BTC|relays left|ticket/i);
  }

  // Copy envelope: the session proves and records it; the sheet hands the envelope to the clipboard.
  await v.f.ls.change[0]({ target: { name: "route", value: "copy" } });
  await settle();
  assert.equal(s.routePref, "copy", "remembered");
  assert.ok(has(v.disclosure(), "Whoever carries the envelope"));
  assert.equal(v.mode(), "");
  const sent = [];
  s.send = async (args) => {
    sent.push(args);
    args.onStep({ id: "ready", status: "ok", detail: "Valid until block 324,800" });
    return { kind: "send", via: "copy", mode: "block", anchor: TIP, envelope: "ab".repeat(16), status: "copied" };
  };
  await v.to(PAYEE);
  await v.amount("80");
  const before = painted.length;
  await v.submit();
  assert.deepEqual([sent.length, sent[0].via], [1, "copy"]);
  const sheet = painted.slice(before).reverse().find((m) => m.includes('class="stepper"')) ?? "";
  assert.match(sheet, /<span class="step-label">Envelope ready to copy<\/span>/);
  assert.match(sheet, /<b>Envelope ready\.<\/b>/);
  assert.match(sheet, /data-env="abab/);
  assert.ok(!/step-label">(Anti-spam check|Hand to (the )?relayer)/.test(sheet), "nothing goes to a relayer");
  closeAllSheets();
  resetPrefs();
});

test("stage 0: a transfer the retired relayer held answers dropped; Activity shows why and offers paying yourself or copying", async (t) => {
  closeRelay(t);
  // The wallet asks the server about the relay id and gets the retired answer.
  const e = { ...batchEntry({ mode: "block", releaseAt: null, lastRelease: null, epochBlocks: null }), id: "v1", anchor: 324_690, deadline: 324_790 };
  const s = activitySession(324_700, [e]);
  net.relayStatus = { status: "dropped", reason: RETIRED, anchor: 324_690, deadline: 324_790 };
  t.after(() => (net.relayStatus = null));
  await s.refreshHistory();
  assert.deepEqual([e.status, e.relayStatus, e.reason], ["failed", "dropped", RETIRED]);
  const page = (await mountActivity(t, s)).page();
  assert.ok(has(page, RETIRED), "the reason is shown");
  assert.deepEqual(actions(page), ["retry-self", "copy-env"], "no relay retry while relaying is unavailable");
  assert.ok(has(page, "via the relayer"));
  assert.doesNotMatch(page.replace(esc(RETIRED), ""), /Ghost Relay|free relay|sponsor/i, "the wallet's own words (the server's reason names the retired relayer)");

  // A batch send it held: the same two ways out, not the next batch or block.
  const b = activitySession(324_710, [batchEntry({ status: "failed", relayStatus: "dropped", reason: RETIRED })]);
  assert.deepEqual(actions((await mountActivity(t, b)).page()), ["retry-self", "copy-env"]);
});

test("stage 0: a copied envelope keeps its notes reserved and offers paying yourself or copying again", async (t) => {
  closeRelay(t);
  const copied = { kind: "send", via: "copy", mode: "block", status: "copied", anchor: 324_690, spends: ["11", "12"], commitments: ["21", "22"], envelope: "cd".repeat(16) };
  assert.ok(S.LOCK_STATUSES.has("copied"));
  assert.deepEqual(S.retryChoices(copied, 324_700), ["self", "copy"]);
  assert.deepEqual(S.deriveStatus(copied, { height: 324_700 }), { status: "copied" });
  assert.equal(S.deriveStatus(copied, { height: 324_791 }).status, "expired", "its window closed");
  assert.deepEqual([...S.lockedNullifiers([copied], 324_700, new Set())], ["11", "12"], "W-1");
  assert.equal(S.lockedNullifiers([copied], 324_791, new Set()).size, 0);
  const s = activitySession(324_700, [{ ...copied, id: "c1", ticker: "ABC", assetId: "7", amount: "5", div: 0, to: PAYEE, time: Date.now() }]);
  const page = (await mountActivity(t, s)).page();
  assert.match(page, /<span class="tag tag--neutral">Envelope copied<\/span>/);
  assert.ok(has(page, "envelope copied"));
  assert.deepEqual(actions(page), ["retry-self", "copy-env"]);
  assert.ok(!ACT.matches("failed", { status: "copied", kind: "send" }, 324_700), "not a failure");
});

test("stage 0: Settings offers paying yourself or copying, and Relayer books says no relayer runs", async (t) => {
  closeRelay(t);
  resetPrefs();
  net.info = OFF_INFO;
  const s = activitySession(TIP, []);
  const root = new FakeEl();
  t.after(SET.settingsView(root, s));
  await settle(20);
  const page = String(root.innerHTML) + String(root.querySelector("[data-relayer-slot]").innerHTML);
  assert.deepEqual(routeValues(page), ["self", "copy"]);
  assert.ok(has(page, "Relayer books"));
  assert.ok(has(page, "No relayer runs on this server. Pay the fee yourself, or copy the envelope."));
  assert.ok(has(page, "Relaying is off on this server. Pay the fee yourself, or copy the envelope."));
  assert.ok(!page.includes('id="relay-balance"'), "no relay balance panel while no relayer runs");
  assert.doesNotMatch(page, /Proof of sponsorship|Ghost Relay|free on signet|Today's budget|ticket/i);
});

test("stage 0: a batch send the retired relayer held before its release is never shown as scheduled; it is looked up at once and offers paying yourself or copying", async (t) => {
  closeRelay(t);
  // Like the live v1 item: a 10-hour batch queued at anchor 324,780, release 324,840, tip 324,811.
  const held = () => batchEntry({ mode: "batch10", anchor: 324_780, epochBlocks: 60, releaseAt: 324_840, lastRelease: 324_868, deadline: 324_880 });
  const tip = 324_811;
  const e = held();
  assert.equal(S.relayStranded(e), true);
  assert.equal(S.relayStranded(e, true), false, "while relaying is open it is simply scheduled");
  assert.equal(S.batchPhase(e, tip), "stranded");
  assert.deepEqual(S.retryChoices(e, tip), ["self", "copy"]);
  assert.equal(S.batchLate(e, tip), true);
  assert.equal(ACT.matches("failed", e, tip), true, "it needs the user");
  const PORT = await import("../web/src/views/app-portfolio.js");

  // Before any lookup (a reload, or the server unreachable): no batch is going out, and the wallet says so.
  const s = activitySession(tip, [e]);
  assert.match(String(PORT.attention(s)), /1 transfer<\/b>|1 transfer needs attention/);
  let page = (await mountActivity(t, s)).page();
  const rows = rowsOf(page);
  assert.match(rows, /<span class="tag tag--warn">Needs attention<\/span>/);
  assert.ok(has(rows, BATCH_TEXT.stranded({ deadline: 324_880 })));
  assert.deepEqual(actions(page), ["retry-self", "copy-env"]);
  for (const line of [BATCH_TEXT.scheduledLine({ mode: "batch10", releaseAt: 324_840, wait: 29, deadline: 324_880 }), "Scheduled", "Going out with the batch", "goes out after block"]) {
    assert.ok(!has(rows, line), line);
  }
  assert.doesNotMatch(rows, /In the mempool/, "no relayer holds it, so it is in no mempool");
  assert.doesNotMatch(rows.replace(esc(BATCH_TEXT.stranded({ deadline: 324_880 })), ""), /free|sponsor|Ghost Relay/i);
  assert.doesNotMatch(BATCH_TEXT.stranded({ deadline: 1 }), /free|sponsor|Ghost Relay/i);

  // The next sync asks the server before releaseAt and gets the retired answer.
  net.relayStatus = { status: "dropped", reason: RETIRED, anchor: 324_780, deadline: 324_880, mode: "batch10", releaseAt: 324_840, lastRelease: 324_868 };
  t.after(() => (net.relayStatus = null));
  const before = net.calls.length;
  await s.refreshHistory();
  assert.deepEqual(net.calls.slice(before), [`/api/relay/status/${"r".repeat(32)}`], "looked up although its batch has not gone out");
  assert.deepEqual([e.status, e.relayStatus, e.reason], ["failed", "dropped", RETIRED]);
  assert.equal(S.batchPhase(e, tip), "failed");
  page = (await mountActivity(t, s)).page();
  assert.ok(has(page, RETIRED));
  assert.deepEqual(actions(page), ["retry-self", "copy-env"]);
  assert.ok(has(page, "Notes unlock at block 324,881"), "W-1: reserved until anchor + 100");
  assert.ok(!has(rowsOf(page), "Scheduled"));

  // A relay id the server does not know (404): nobody holds it, so it fails too; its notes stay reserved.
  net.relayStatus = null;
  const lost = held();
  const s2 = activitySession(tip, [lost]);
  await s2.refreshHistory();
  assert.deepEqual([lost.status, lost.relayStatus, lost.reason], ["failed", "dropped", S.STRANDED_REASON]);
  assert.deepEqual([...S.lockedNullifiers([lost], tip, new Set())], ["11", "12"]);
  assert.deepEqual(actions((await mountActivity(t, s2)).page()), ["retry-self", "copy-env"]);

  // A carrier the retired relayer already broadcast may still land: not stranded.
  const out = held();
  out.relayStatus = "broadcast";
  assert.equal(S.relayStranded(out), false);
  assert.equal(S.batchPhase(out, 324_841), "releasing");

  // Next-block entries it held read the same way before their lookup, not "Queued at the relayer".
  const plain = batchEntry({ mode: "block", epochBlocks: undefined, releaseAt: undefined, lastRelease: undefined, anchor: 324_800, deadline: 324_900 });
  const p = (await mountActivity(t, activitySession(tip, [plain]))).page();
  assert.match(p, /<span class="tag tag--warn">Needs attention<\/span>/);
  assert.ok(has(p, BATCH_TEXT.stranded({ deadline: 324_900 })));
  assert.ok(!/Queued at (the )?relayer/.test(p));
  assert.deepEqual(actions(p), ["retry-self", "copy-env"]);

  // A batch the relayer expired before it was retired: only the two ways out are named.
  assert.ok(BATCH_TEXT.missed({ lastRelease: 324_772 }).includes("Pay the fee yourself or copy the envelope."));
  assert.ok(!BATCH_TEXT.missed({ lastRelease: 324_772 }).includes("next batch"));
  // Network activity says lookups happen.
  assert.match(BATCH_TEXT.networkNote, /^While relaying is unavailable, scheduled batch transfers are looked up too/);
});

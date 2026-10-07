// Round 2, wallet follow-ups: a lock caused by another tab says so and closes every
// sheet; the proving sheet masks step details and failures in streamer mode; the
// older plaintext phrase left beside a vault can be shown and deleted; a mint priced
// below the dust limit shows and records what is actually paid; the launch share
// text comes from launch-card.js; the router keeps the view on fragment-only steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/* ---------- a minimal DOM, enough for sheets, toasts and the router ---------- */

const made = []; // every markup string turned into nodes
class FakeEl {
  constructor(markup = "") {
    this.markup = String(markup);
    this.sel = new Map();
    this.dataset = {};
    this.innerHTML = "";
    this.hidden = false;
    this.removed = false;
    const set = new Set();
    this.classList = { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c) };
  }
  querySelector(s) {
    if (!this.sel.has(s)) this.sel.set(s, new FakeEl());
    return this.sel.get(s);
  }
  querySelectorAll() {
    return [];
  }
  addEventListener() {}
  removeEventListener() {}
  append() {}
  replaceChildren() {}
  remove() {
    this.removed = true;
  }
  focus() {}
  setAttribute() {}
}
const docHandlers = {};
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
  addEventListener: (t, fn) => (docHandlers[t] ??= []).push(fn),
  removeEventListener() {},
  getElementById: () => null,
  hasFocus: () => true,
};
globalThis.requestAnimationFrame = () => 0;
// Reduced motion: sheets finish closing (and call onClose) right away.
globalThis.matchMedia = (q) => ({ matches: q.includes("reduced-motion") });
const winHandlers = {};
globalThis.addEventListener = (t, fn) => (winHandlers[t] ??= []).push(fn);
globalThis.scrollTo = () => {};
globalThis.scrollY = 0;
let url = new URL("https://murkle.example/");
globalThis.location = {
  get href() { return url.href; },
  get origin() { return url.origin; },
  get pathname() { return url.pathname; },
  get search() { return url.search; },
  get hash() { return url.hash; },
};
const go = (u) => (url = new URL(u, url));
globalThis.history = {
  state: null,
  scrollRestoration: "auto",
  pushState(s, _t, u) { this.state = s; go(u); },
  replaceState(s, _t, u) { this.state = s; if (u) go(u); },
};

const keystore = await import("../web/src/keystore.js");
const { STORAGE_PREFIX } = await import("../web/src/config.js");
const S = await import("../web/src/session.js");
const { openSheet } = await import("../web/src/ui/sheet.js");
const { dismiss } = await import("../web/src/ui/toast.js");
const { provingSheet, maskError, maskText, LOCK_EVENTS } = await import("../web/src/views/app-shared.js");
const { guardReveal } = await import("../web/src/views/app-settings.js");
const { paidHTML } = await import("../web/src/views/app-mint.js");
const { UnisatPayer } = await import("../web/src/payers.js");
const { MockUnisat } = await import("./mock-unisat.mjs");
const { planCarrierTx, btcAccount, scriptOf } = await import("../src/btc/funding.mjs");
const { hex } = await import("../src/bytes.mjs");
const router = await import("../web/src/router.js");

const PW = "correct horse battery";
const VAULT = keystore.vaultKey(STORAGE_PREFIX);
// A neutral signet P2TR address: the key-path address of the dummy key new Uint8Array(32).fill(1).
const TREASURY = "tb1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8snwrkwy";
const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function reset() {
  S.lock();
  S.setStreamerMode(false);
  for (const k of [VAULT, ...Object.values(keystore.LEGACY_KEYS)]) S.storage.removeItem(k);
  go("/");
}
const clearToasts = () => {
  for (let i = 1; i <= 50; i++) dismiss(`t${i}`);
};

/* ---------- #2 and #3: a lock caused by another tab ---------- */

test("#2/#3 another tab removing the wallet: elsewhere-lock, every sheet closes, a toast says why", async (t) => {
  t.after(clearToasts);
  reset();
  const s = await S.createWallet(S.newPhrase(), PW);
  const closed = [];
  openSheet({ title: "Plain", onClose: () => closed.push("plain") });
  openSheet({ title: "Proving", locked: true, onClose: () => closed.push("locked") });
  const events = [];
  const off = S.onSessionChange((type) => events.push(type));
  S.storage.removeItem(VAULT); // the other tab removed it
  assert.throws(() => s.persist(), /changed in another tab/);
  off();
  assert.deepEqual(events, ["elsewhere-lock"]);
  assert.ok(LOCK_EVENTS.has("elsewhere-lock") && LOCK_EVENTS.has("lock") && LOCK_EVENTS.has("idle-lock"));
  assert.deepEqual(closed.sort(), ["locked", "plain"], "locked sheets close too");
  assert.ok(made.some((m) => m.includes("Locked: this wallet was changed in another tab.") && m.includes("It was removed from this browser.")));
  assert.equal(S.currentSession(), null);
});

test("#2 a password changed in another tab: the toast asks for the current password", async (t) => {
  t.after(clearToasts);
  reset();
  const s = await S.createWallet(S.newPhrase(), PW);
  const vault = JSON.parse(S.storage.getItem(VAULT));
  const { vault: next } = await keystore.changePassword(vault, PW, "another password here");
  keystore.writeVault(S.storage, STORAGE_PREFIX, next);
  made.length = 0;
  assert.throws(() => s.persist(), /changed in another tab/);
  assert.ok(made.some((m) => m.includes("Locked: this wallet was changed in another tab.") && m.includes("Unlock with its current password")));
  assert.ok(!made.some((m) => m.includes("Wallet locked after inactivity.")));
});

test("#2 the phrase sheet is wiped on a lock from another tab, and a manual lock still emits lock", async () => {
  reset();
  const s = await S.createWallet(S.newPhrase(), PW);
  const calls = [];
  guardReveal({ setBody: (b) => calls.push(`body:${b}`), close: () => calls.push("close") });
  S.storage.removeItem(VAULT);
  assert.throws(() => s.persist());
  assert.deepEqual(calls, ["body:", "close"]);

  await S.createWallet(S.newPhrase(), PW);
  const events = [];
  const off = S.onSessionChange((type) => events.push(type));
  S.lock("manual");
  off();
  assert.deepEqual(events, ["lock"]);
});

/* ---------- #6: the proving sheet in streamer mode ---------- */

function realFundingError() {
  try {
    planCarrierTx({ account: btcAccount(new Uint8Array(32).fill(7)), utxos: [{ txid: "ab".repeat(32), vout: 0, value: 400 }], envelope: new Uint8Array(471), feeRate: 2 });
  } catch (e) {
    return e.message;
  }
  throw new Error("expected a funding error");
}

test("#6 streamer mode: proving-sheet step details and the failure are masked", () => {
  reset();
  const real = realFundingError();
  assert.match(real, /tb1p\w+: have 400 sats/);
  S.setStreamerMode(true);
  try {
    const pv = provingSheet({ title: "Minting ABC", steps: [{ id: "payer", label: "Pick" }, { id: "sign", label: "Sign" }] });
    const host = { get innerHTML() { return String(pv.sheet.body.querySelector("[data-pv]").innerHTML); } };
    pv.onStep({ id: "payer", status: "ok", detail: "12,345 sats available" });
    pv.onStep({ id: "sign", status: "running", detail: "1,234 sats at 2 sat/vB" });
    assert.ok(!host.innerHTML.includes("12,345") && !host.innerHTML.includes("1,234"), host.innerHTML);
    assert.match(host.innerHTML, /hidden sats available/);
    assert.match(host.innerHTML, /hidden sats at 2 sat\/vB/);
    pv.fail(new Error(real));
    assert.ok(!/tb1p/.test(host.innerHTML) && !host.innerHTML.includes("have 400"), host.innerHTML);
    assert.match(host.innerHTML, /your Bitcoin address: have hidden sats, need hidden/);
  } finally {
    S.setStreamerMode(false);
  }
  const pv = provingSheet({ title: "Minting ABC", steps: [{ id: "payer", label: "Pick" }] });
  pv.onStep({ id: "payer", status: "ok", detail: "12,345 sats available" });
  pv.fail(new Error(real));
  const host = { innerHTML: String(pv.sheet.body.querySelector("[data-pv]").innerHTML) };
  assert.match(host.innerHTML, /12,345 sats available/, "unchanged with streamer mode off");
  assert.ok(host.innerHTML.includes("have 400 sats"));
  assert.equal(maskText(null), null);
  assert.equal(maskError("root matches at #324,600"), "root matches at #324,600");
});

/* ---------- #10: the older plaintext phrase beside a vault ---------- */

test("#10 the older plaintext phrase: shown only with the vault password, outside streamer mode, then deleted", async () => {
  reset();
  await S.createWallet(S.newPhrase(), PW);
  const old = S.newPhrase();
  S.storage.setItem(keystore.LEGACY_KEYS.phrase, JSON.stringify(old));
  S.storage.setItem(keystore.LEGACY_KEYS.history, JSON.stringify([{ kind: "send" }]));
  assert.ok(S.hasVault() && S.hasLegacy());
  await assert.rejects(S.revealLegacyPhrase("wrong password!"), keystore.WrongPassword);
  S.setStreamerMode(true);
  await assert.rejects(S.revealLegacyPhrase(PW), /Streamer mode is on/);
  S.setStreamerMode(false);
  assert.equal(await S.revealLegacyPhrase(PW), old);
  S.forgetLegacy();
  assert.equal(S.hasLegacy(), false);
  assert.equal(S.storage.getItem(keystore.LEGACY_KEYS.history), null);
  assert.ok(S.hasVault(), "the open wallet stays");
  await assert.rejects(S.revealLegacyPhrase(PW), /no longer stored/);

  // Without a vault the plaintext phrase is the only copy: never deleted from here.
  reset();
  S.storage.setItem(keystore.LEGACY_KEYS.phrase, JSON.stringify(old));
  assert.throws(() => S.forgetLegacy(), /only copy/);
  assert.ok(S.hasLegacy());
  reset();
});

test("#10 Settings shows the notice only when an older phrase is stored, behind the reveal sheet", () => {
  const settings = src("web/src/views/app-settings.js");
  assert.match(settings, /const legacy = \(\) =>\s+hasLegacy\(\)\s+\?/);
  assert.match(settings, /\$\{legacy\(\)\}\$\{security\(\)\}/);
  assert.match(settings, /case "reveal-legacy":\s+return legacySheet\(paint\);/);
  assert.match(settings, /reveal: revealLegacyPhrase,/);
  assert.match(settings, /reveal: revealPhrase,/, "both go through the same phrase sheet");
  assert.match(settings, /guard = guardReveal\(sheet\);/);
  assert.match(settings, /action: "reveal-legacy", disabled: masked\(\)/, "not offered in streamer mode");
  assert.match(settings, /action: "forget-legacy", disabled: true/, "delete waits for the checkbox");
});

/* ---------- #15: a mint price below the dust limit ---------- */

test("#15 mintPayment and the mint review show the amount actually paid", () => {
  const p2tr = hex(scriptOf(TREASURY));
  assert.deepEqual(S.mintPayment({ priceSats: "100", treasury: p2tr }), { price: 100n, paid: 330n, raised: true });
  assert.deepEqual(S.mintPayment({ priceSats: "330", treasury: p2tr }), { price: 330n, paid: 330n, raised: false });
  assert.deepEqual(S.mintPayment({ priceSats: "1000", treasury: p2tr }), { price: 1000n, paid: 1000n, raised: false });
  assert.deepEqual(S.mintPayment({ priceSats: "0", treasury: "" }), { price: 0n, paid: 0n, raised: false });
  const p2pkh = hex(new Uint8Array([0x76, 0xa9, 0x14, ...new Uint8Array(20).fill(1), 0x88, 0xac]));
  assert.equal(S.mintPayment({ priceSats: "500", treasury: p2pkh }).paid, 546n);

  const low = String(paidHTML({ priceSats: "100", treasury: p2tr }));
  assert.match(low, /330 sats/);
  assert.match(low, /raised to the dust limit \(price 100 sats\)/);
  assert.ok(!/raised/.test(String(paidHTML({ priceSats: "1000", treasury: p2tr }))));
  const mint = src("web/src/views/app-mint.js");
  assert.match(mint, /\["To treasury", paidHTML\(a\)\]/);
  assert.match(mint, /\["Price", paidHTML\(a\)\]/);
  const session = src("web/src/session.js");
  assert.match(session, /amount: paid \}\] : \[\]/);
  assert.match(session, /price: paid\.toString\(\), \.\.\.\(raised \? \{ listPrice: price\.toString\(\), priceNote: "raised to the dust limit" \}/);
});

test("#15 Unisat pays at least the dust limit, never a non-standard output", async () => {
  globalThis.window = { unisat: new MockUnisat() };
  const payer = await new UnisatPayer().connect();
  const env = new TextEncoder().encode("murkle-r2");
  await payer.carry({ envelope: env, outputs: [{ script: scriptOf(TREASURY), amount: 100n }], feeRate: 2 });
  await payer.carry({ envelope: env, outputs: [{ script: scriptOf(TREASURY), amount: 1000n }], feeRate: 2 });
  const p2wpkh = new MockUnisat({ type: "p2wpkh" }).address;
  await payer.carry({ envelope: env, outputs: [{ script: scriptOf(p2wpkh), amount: 1n }], feeRate: 2 });
  await payer.carry({ envelope: env, feeRate: 2 });
  assert.deepEqual(window.unisat.sent.map((x) => x.satoshis), [330, 1000, 294, 546]);
  delete globalThis.window;
});

/* ---------- #36: the launch share text ---------- */

test("#36 the launch success screen uses the shared launch-card text and X link", () => {
  const launch = src("web/src/views/app-launch.js");
  assert.match(launch, /import \{ shareText, xIntentUrl \} from "\.\.\/share\/launch-card\.js";/);
  assert.match(launch, /const text = shareText\(terms, url\);/);
  assert.match(launch, /href: xIntentUrl\(text\)/);
  assert.ok(!/privately on Bitcoin/.test(launch));
});

/* ---------- #44: indexer switch wording ---------- */

test("#44 wallet errors name /verify#indexer next to Settings", () => {
  const session = src("web/src/session.js");
  assert.ok(!/switch indexer in Settings/.test(session));
  assert.equal(session.match(/switch indexer \(Settings, or \/verify#indexer\)/g).length, 3);
  assert.match(src("web/src/api.js"), /switch on \/verify#indexer use it/);
});

/* ---------- #40: the router keeps the view on fragment-only steps ---------- */

test("#40 popstate re-renders only when the pathname or search changes", () => {
  const mounts = [];
  go("/app/activity");
  router.start({ mount: (_m, u) => mounts.push(u.pathname + u.search) });
  assert.deepEqual(mounts, ["/app/activity"]);
  const pop = (state = null) => winHandlers.popstate.forEach((fn) => fn({ state }));
  const click = () => docHandlers.click.forEach((fn) => fn({ defaultPrevented: false, button: 0, target: { closest: () => null } }));

  // The view filters with replaceState, then a plain #link is followed natively.
  history.replaceState(history.state, "", "/app/activity?f=send");
  click();
  history.pushState(null, "", "/app/activity?f=send#top");
  pop();
  assert.equal(mounts.length, 1, "a plain #fragment link keeps the view");
  go("/app/activity?f=send"); // back over the fragment
  pop();
  assert.equal(mounts.length, 1, "back over a fragment keeps the view");

  go("/app/activity?f=mint"); // back to another query: render
  pop({ scrollY: 0 });
  go("/mints");
  pop();
  assert.deepEqual(mounts, ["/app/activity", "/app/activity?f=mint", "/mints"]);
});

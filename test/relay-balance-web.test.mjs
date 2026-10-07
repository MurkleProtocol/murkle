// Relay balance, web wallet (docs/design/relay-balance-contract.md §5, tests §8 "web"):
// the route states, the relay account in the session, deposit lookups and auto-credit,
// the Send form in every state, the signed submit, missed and stuck sends in Activity, the
// recent-deposit warning, the top-up sheet and the copy rules. Runs on a fake DOM with fake
// storage, a fake indexer, a fake relayer (it checks every signature the wallet makes) and a
// fake mempool.space. Nothing is broadcast, no browser wallet is used, nothing is written
// outside memory.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/* ---------- a minimal DOM: every innerHTML write and every parsed node is recorded ---------- */

const painted = [];
const made = [];
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

/* ---------- modules ---------- */

const { schnorr } = await import("@noble/curves/secp256k1");
const { sha256 } = await import("@noble/hashes/sha256");
const { mnemonicToEntropy } = await import("@scure/bip39");
const { wordlist } = await import("@scure/bip39/wordlists/english");
const btc = await import("@scure/btc-signer");
const RA = await import("../src/relay-account.mjs");
const { hex } = await import("../src/bytes.mjs");
const { OP, encodeTxBody } = await import("../src/envelope.mjs");
const { MerkleTree } = await import("../src/core.mjs");
const S = await import("../web/src/session.js");
const R = await import("../web/src/relay.js");
const { RelayPayer } = await import("../web/src/payers.js");
const { STORAGE_PREFIX } = await import("../web/src/config.js");
const { esc } = await import("../web/src/ui/dom.js");
const { LINK_TEXT } = await import("../web/src/ui/meter.js");
const { closeAllSheets } = await import("../web/src/ui/sheet.js");
const { dismiss } = await import("../web/src/ui/toast.js");
const { RELAY_TEXT, statusChip } = await import("../web/src/views/app-shared.js");
const SEND = await import("../web/src/views/app-send.js");
const ACT = await import("../web/src/views/app-activity.js");
const SET = await import("../web/src/views/app-settings.js");
const PORT = await import("../web/src/views/app-portfolio.js");
const TOPUP = await import("../web/src/views/topup.js");

after(() => {
  closeAllSheets();
  for (let i = 1; i <= 200; i++) dismiss(`t${i}`);
});

/* ---------- a fake indexer, relayer and mempool.space behind fetch ---------- */

const TIP = 324_700;
const POOL_SECRET = new Uint8Array(32).fill(7);
const POOL = hex(schnorr.getPublicKey(POOL_SECRET));
const CHANGE = `tb1p${"c".repeat(58)}`;
const txid = (i) => i.toString(16).padStart(64, "0");

/** Relay info of a relayer with relay balances (contract §4.2). */
function balanceInfo(over = {}) {
  return {
    enabled: true, mode: "balance", code: null, reason: null, network: "signet", ops: ["TRANSACT"], address: CHANGE,
    height: net.height, chainTip: net.height, pow: null, selfPay: true,
    fees: { feeRate: 1, maxFeeRate: 5, estVsize: 597, carrierFeeSats: 597, maxFeePerTx: 3000 },
    balance: {
      poolKey: POOL, changeAddress: CHANGE, signTag: "murkle/relay/v1", marginPct: 10, marginMinSats: 50, perSendSats: 657, batchHeadroom: 2,
      minDepositSats: 2000, depositConfirmations: 1, sweepCostSats: 288, suggestSends: 10, suggestedTopUpSats: 7000,
    },
    queue: { queued: 0, max: 120 },
    stats: { relayed144: 3, landed144: [], accepted: 0, rejected: 0, expired: 0, missed: 0, satsSpent: 0 },
    defaultMode: "block",
    batch: { perIp: 3, modes: { batch: { epochBlocks: 6, maxPerEpoch: 40, safety: 24, enabled: true }, batch10: { epochBlocks: 60, maxPerEpoch: 120, safety: 12, enabled: true } }, recent: [] },
    docs: "docs/design/relay-balance.md",
    ...over,
  };
}
const OFF_INFO = { enabled: false, mode: null, code: "disabled", reason: "no relayer runs on this server", network: "signet", ops: [], address: null, pow: null, selfPay: true, balance: null, batch: null, docs: "docs/design/relay-balance.md" };

const net = {
  height: TIP,
  info: null,
  calls: [], // "METHOD path"
  bodies: [], // every JSON body POSTed to the relayer
  chain: new Map(), // outpoint -> { address, value, height | null }
  accounts: new Map(), // account id hex -> { balance, reserved, nextIndex, credits }
  creditErrors: new Map(), // outpoint -> { status, code, ...extra }
  wrongDeposit: false, // the account read answers another deposit address
  verified: [], // verifyRequest results of signed requests
  broadcasts: [],
  stateRelay: null, // /api/state's relay field, when a test sets it
};
const reply = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refuse = (status, code, extra = {}) => reply(status, { error: { code, message: R.FALLBACK[code] ?? code, ...extra } });
const accountOf = (id) => {
  if (!net.accounts.has(id)) net.accounts.set(id, { balance: 0, reserved: 0, nextIndex: 0, credits: [] });
  return net.accounts.get(id);
};
const EMPTY_ROOT = new MerkleTree().root().toString();

globalThis.fetch = async (input, init = {}) => {
  const u = new URL(String(input), "http://indexer.test");
  const method = init.method ?? "GET";
  net.calls.push(`${method} ${u.pathname}`);
  const body = typeof init.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : null;
  if (body) net.bodies.push(body);
  const p = u.pathname;
  // mempool.space
  let m;
  if ((m = p.match(/\/address\/([a-z0-9]+)\/utxo$/))) {
    const rows = [...net.chain.entries()]
      .filter(([, c]) => c.address === m[1] && !c.spent)
      .map(([op, c]) => ({ txid: op.split(":")[0], vout: Number(op.split(":")[1]), value: c.value, status: c.height == null ? { confirmed: false } : { confirmed: true, block_height: c.height } }));
    return reply(200, rows);
  }
  if (p.endsWith("/fees/recommended")) return reply(200, { halfHourFee: 1 });
  if (p.endsWith("/api/tx") && method === "POST") {
    net.broadcasts.push(init.body);
    return new Response(btc.Transaction.fromRaw(Buffer.from(init.body, "hex")).id, { status: 200 });
  }
  // the relayer
  if (p === "/api/relay/info") return net.info ? reply(200, net.info) : reply(503, { error: { message: "down" } });
  if (p === "/api/relay/account") {
    const v = RA.verifyRequest({ endpoint: "/api/relay/account", network: "signet", poolKey: POOL, body });
    net.verified.push(v);
    if (!v.ok) return refuse(401, v.code);
    const a = accountOf(v.idHex);
    const dep = net.wrongDeposit ? RA.depositAddress(POOL, new Uint8Array(32).fill(1), a.nextIndex, "signet") : RA.depositAddress(POOL, v.id, a.nextIndex, "signet");
    return reply(200, { accountId: v.idHex, balance: a.balance, reserved: a.reserved, nextIndex: a.nextIndex, depositAddress: dep.address, credits: a.credits });
  }
  if (p === "/api/relay/credit") {
    const { outpoint, accountPub, n } = body;
    const scripted = net.creditErrors.get(outpoint);
    if (scripted) return refuse(scripted.status, scripted.code, scripted.extra);
    const c = net.chain.get(outpoint);
    if (!c) return refuse(404, "deposit_unknown");
    const id = sha256(RA.parseAccountPub(accountPub));
    if (RA.depositAddress(POOL, id, n, "signet").address !== c.address) return refuse(422, "deposit_mismatch");
    if (c.value < 2000) return refuse(422, "deposit_small", { minDepositSats: 2000 });
    const confirmations = c.height == null ? 0 : net.height - c.height + 1;
    if (confirmations < 1) return refuse(409, "deposit_unconfirmed", { confirmations, needed: 1 });
    const a = accountOf(hex(id));
    if (a.credits.some((x) => x.outpoint === outpoint)) return reply(200, { credited: true, already: true, outpoint, n });
    const amount = c.value - 288;
    a.balance += amount;
    a.nextIndex = Math.max(a.nextIndex, n + 1);
    a.credits.unshift({ outpoint, n, value: c.value, amount, height: c.height });
    return reply(200, { credited: true, already: false, outpoint, n, value: c.value, sweepCost: 288, amount, height: c.height });
  }
  if (p.startsWith("/api/relay/status/")) return refuse(404, "not_found");
  // the indexer (an empty pool)
  switch (p) {
    case "/api/state":
      return reply(200, { height: net.height, startHeight: 324_592, root: EMPTY_ROOT, outputs: 0, nullifiers: 0, chainTip: net.height, syncing: false, lastSync: Date.now(), ...(net.stateRelay ? { relay: net.stateRelay } : {}) });
    case "/api/outputs":
    case "/api/nullifiers":
      return reply(200, []);
    case "/api/assets":
      return reply(200, [{ id: "7", ticker: "ABC", divisibility: 0, status: "live", mintAmount: "50", priceSats: "0", treasury: null }]);
    case "/api/log":
      return reply(200, { items: [], next: null, total: 0 });
    default:
      return reply(404, { error: { message: "Not found." } });
  }
};

/* ---------- helpers ---------- */

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};
const has = (markup, text) => String(markup).includes(esc(text));
const fire = (el, type, ev) => (el.ls[type] ?? []).map((fn) => fn(ev));
const clickOn = (act, dataset = {}) => {
  const el = { dataset: { action: act, ...dataset }, disabled: false };
  return { target: { closest: (sel) => (sel === "[data-action]" || sel === `[data-action=${act}]` ? el : null), matches: () => false } };
};
const ROUTE_KEY = `${STORAGE_PREFIX}.route`;
const resetPrefs = () => ["relayMode", "selfMode", "route", "streamer"].forEach((k) => S.storage.removeItem(`${STORAGE_PREFIX}.${k}`));
const routeValues = (markup) => [...String(markup).matchAll(/name="route" value="([a-z]+)"/g)].map((x) => x[1]);
const checkedRoute = (markup) => String(markup).match(/name="route" value="([a-z]+)" checked/)?.[1] ?? null;
const relayCardOf = (markup) => {
  const m = String(markup);
  const at = m.indexOf('value="relay"');
  return at < 0 ? "" : m.slice(m.lastIndexOf("<label", at), m.indexOf("</label>", at) + 8);
};
const since = (n) => net.calls.slice(n);
const lookups = (calls) => calls.filter((c) => /\/api\/relay\/(account|credit)|\/address\//.test(c));
const balanceOf = (balance, reserved = 0, credits = []) => ({ balance, reserved, nextIndex: credits.length, credits, at: Date.now() });

/** A wallet session synced at net.height (an empty pool). */
async function synced() {
  const s = new S.Session({ phrase: S.newPhrase() });
  await s.sync();
  return s;
}
/** Relay info loaded and the route open (as the session does after GET /api/relay/info). */
async function withInfo(s, info = balanceInfo()) {
  net.info = info;
  await s.loadRelayInfo();
  return s;
}
/** Money on Bitcoin to deposit address n of session s: { outpoint }. height null = in the mempool. */
function pay(s, n, value, height = null, i = net.chain.size + 1) {
  const address = s.depositAddress(n).address;
  const outpoint = `${txid(1000 + i)}:${i % 3}`;
  net.chain.set(outpoint, { address, value, height });
  return outpoint;
}
async function mountSend(t, s) {
  const root = new FakeEl();
  const off = SEND.sendView(root, s, null);
  t.after(off);
  await settle(20);
  const slot = (n) => root.querySelector(`[data-slot=${n}]`);
  const f = root.querySelector("[data-f]");
  const run = async (type, ev) => (fire(f, type, ev), settle(20));
  return {
    root, slot, f,
    route: () => String(slot("route").innerHTML),
    notes: () => String(root.querySelector("[data-route-notes]").innerHTML),
    mode: () => String(slot("mode").innerHTML),
    hint: () => String(slot("hint").innerHTML),
    cta: () => String(slot("cta").innerHTML),
    aside: () => String(slot("aside").innerHTML),
    disclosure: () => String(slot("disclosure").innerHTML),
    choose: (value) => run("change", { target: { name: "route", value } }),
    seg: (name, value) => run("seg-change", { detail: { name, value } }),
  };
}
function activitySession(tip, history) {
  const s = new S.Session({ phrase: S.newPhrase() });
  s.view = { startHeight: 324_592, height: tip, outputs: [], nullifiers: new Set(), tree: null };
  s.history = history;
  s.sync = async () => {};
  return s;
}
async function mountActivity(t, s) {
  const root = new FakeEl();
  const off = ACT.activityView(root, s, null);
  t.after(off);
  await settle();
  return String(root.innerHTML);
}
const actions = (markup) => [...String(markup).matchAll(/data-id="[^"]+" data-action="(retry-[a-z]+|copy-env)"/g)].map((x) => x[1]);
const relayEntry = (over = {}) => ({
  id: "e1", kind: "send", via: "relay", mode: "block", status: "relaying", relayStatus: "queued", relayId: "r".repeat(32),
  ticker: "ABC", assetId: "7", amount: "5", div: 0, to: "mrk1x", spends: ["11", "12"], commitments: ["21", "22"],
  anchor: 324_690, deadline: 324_790, envelope: "ab".repeat(16), time: Date.now(), sentHeight: 324_690, ...over,
});
/** A structurally valid TRANSACT envelope (the proof bytes are not checked client-side). */
function transact(anchor = 100) {
  const body = encodeTxBody({
    op: OP.TRANSACT, anchor, publicAmount: 0n, nullifiers: [11n, 12n], commitments: [21n, 22n],
    ciphertexts: [new Uint8Array(95).fill(1), new Uint8Array(95).fill(2)],
  });
  const env = new Uint8Array(body.length + 128);
  env.set(body);
  return env;
}

/* ---------- 1. setRelayRoute and routeState ---------- */

test("1: setRelayRoute opens only for a relay-balance relayer; routeState for off, unknown, none, low, low batch, fee_high, ok", () => {
  const info = balanceInfo();
  for (const bad of [null, undefined, OFF_INFO, { ...info, enabled: false }, { ...info, mode: null }, { ...info, mode: "free" }, { ...info, balance: null }, { ...info, balance: { ...info.balance, poolKey: "zz" } }, { ...info, balance: { ...info.balance, poolKey: POOL.toUpperCase() } }]) {
    assert.equal(R.setRelayRoute(bad), false, JSON.stringify(bad)?.slice(0, 60));
    assert.equal(R.relayOpen(), false);
    assert.equal(R.routeState(bad, balanceOf(100_000)), "off");
  }
  assert.equal(R.setRelayRoute(info), true);
  assert.equal(R.RELAY_ROUTE.info, info);
  assert.equal(R.relayOpen(), true);

  assert.deepEqual(R.quoteFor(info, "block"), { perSend: 657, needed: 657 });
  assert.deepEqual(R.quoteFor(info, "fast"), { perSend: 657, needed: 657 });
  assert.deepEqual(R.quoteFor(info, "batch"), { perSend: 657, needed: 1314 });
  assert.deepEqual(R.quoteFor({ ...info, balance: { ...info.balance, batchHeadroom: 3 } }, "batch10"), { perSend: 657, needed: 1971 });
  assert.equal(R.quoteFor({ ...info, balance: { ...info.balance, perSendSats: null } }), null, "fee rate unknown");

  const st = (b, mode, i = info) => R.routeState(i, b, mode);
  assert.equal(st(null), "unknown", "balance not read");
  assert.equal(st(balanceOf(0)), "none");
  assert.equal(st(balanceOf(0), "batch", { ...info, code: "fee_high" }), "none", "no balance: the quiet entry, whatever the fees");
  assert.equal(st(balanceOf(0, 1314)), "low", "everything reserved");
  assert.equal(st(balanceOf(656)), "low");
  assert.equal(st(balanceOf(657)), "ok");
  assert.equal(st(balanceOf(1000), "batch"), "low", "a batch reserves twice");
  assert.equal(st(balanceOf(1000), "batch10", { ...info, balance: { ...info.balance, batchHeadroom: 1 } }), "ok", "with the relayer's own headroom");
  assert.equal(st(balanceOf(1314), "batch"), "ok");
  assert.equal(st(balanceOf(100_000), "block", { ...info, code: "fee_high" }), "fee_high");
  assert.equal(st(balanceOf(100_000), "batch"), "ok");
  // Tests may still set .open directly.
  R.RELAY_ROUTE.open = false;
  assert.equal(st(balanceOf(100_000)), "off");
  R.setRelayRoute(info);
});

/* ---------- 2. the relay account in the session ---------- */

test("2: the session derives the same relay account and deposit addresses as src/relay-account.mjs; a mismatching deposit address throws and nothing is paid", async () => {
  const phrase = S.newPhrase();
  const s = new S.Session({ phrase });
  const mine = RA.relayAccount(mnemonicToEntropy(phrase, wordlist), "signet");
  assert.deepEqual(s.relayAccount, { pubHex: mine.pubHex, idHex: mine.idHex });
  assert.equal(mine.idHex, hex(sha256(mine.pub)));
  assert.ok(!JSON.stringify(s.relayAccount).includes(hex(mine.secret)), "the secret is never exposed");
  assert.ok(!JSON.stringify(Object.entries(s).map(([k, v]) => [k, typeof v === "object" ? null : v])).includes(hex(mine.secret)));
  assert.notEqual(new S.Session({ phrase: S.newPhrase() }).relayAccount.pubHex, mine.pubHex);

  // No relayer: no deposit address at all.
  R.setRelayRoute(OFF_INFO);
  s.relayInfo = OFF_INFO;
  assert.throws(() => s.depositAddress(0), { code: "disabled" });
  await withInfo(s);
  for (const n of [0, 1, 5, RA.MAX_DEPOSIT_INDEX]) assert.equal(s.depositAddress(n).address, RA.depositAddress(POOL, mine.id, n, "signet").address, `n = ${n}`);
  assert.match(s.depositAddress(0).address, /^tb1p/);
  assert.deepEqual(s.depositAddress(), { n: 0, address: RA.depositAddress(POOL, mine.id, 0, "signet").address }, "depositIndex 0 at first");

  // The signed balance read: accepted by the relayer's check, stored, emitted.
  const events = [];
  const off = S.onSessionChange((type) => events.push(type));
  const b = await s.loadRelayBalance();
  off();
  assert.deepEqual([b.balance, b.reserved, b.nextIndex, b.credits], [0, 0, 0, []]);
  assert.equal(net.verified.at(-1).ok, true);
  assert.equal(net.verified.at(-1).idHex, mine.idHex);
  assert.deepEqual(Object.keys(net.bodies.at(-1)).sort(), ["accountPub", "sig", "t"]);
  assert.ok(events.includes("relay-balance"));
  assert.equal(s.relayPrefs, null, "a read showing nothing stores nothing");

  // A relayer answering another deposit address: refused, nothing stored, nothing paid.
  net.wrongDeposit = true;
  const fresh = new S.Session({ phrase: S.newPhrase() });
  fresh.relayInfo = s.relayInfo;
  const sent = net.broadcasts.length;
  await assert.rejects(fresh.loadRelayBalance(), { message: "The relayer's deposit address doesn't match this wallet. Nothing was paid." });
  net.wrongDeposit = false;
  assert.equal(fresh.relayBalance, null);
  assert.equal(net.broadcasts.length, sent);
});

/* ---------- 3. deposits, credit and auto-credit ---------- */

test("3: checkDeposits advances the index on a payment, waits for its confirmation, credits once; small and refused map to their states; older addresses", async () => {
  net.height = TIP;
  const s = await synced();
  await withInfo(s);
  const before = net.calls.length;

  // Nothing paid yet: one look at address #0, no credit, nothing stored.
  assert.deepEqual(await s.checkDeposits(), []);
  assert.equal(s.depositIndex, 0);
  assert.equal(s.relayPrefs, null);

  // A payment in the mempool: seen, the next top-up moves to #1, waiting for 1 confirmation.
  const a = pay(s, 0, 7000, null);
  let out = await s.checkDeposits();
  assert.deepEqual(out.map((d) => [d.n, d.outpoint, d.value, d.state, d.confirmations, d.needed]), [[0, a, 7000, "waiting", 0, 1]]);
  assert.equal(s.depositIndex, 1);
  assert.deepEqual(s.relayPrefs.pending.map((p) => [p.n, p.outpoint, p.value]), [[0, a, 7000]]);
  assert.equal(since(before).filter((c) => c.includes("/api/relay/credit")).length, 0, "not asked before it confirms");
  assert.equal(s.depositAddress().n, 1);

  // Confirmed: credited once, the balance read follows.
  net.chain.get(a).height = TIP;
  out = await s.checkDeposits();
  assert.deepEqual(out.map((d) => [d.state, d.amount]), [["credited", 6712]]);
  assert.equal(s.relayBalance.balance, 6712);
  assert.deepEqual(s.relayPrefs.pending, []);
  const credits = () => since(before).filter((c) => c.includes("/api/relay/credit")).length;
  assert.equal(credits(), 1);
  out = await s.checkDeposits();
  assert.equal(credits(), 1, "a credited deposit is not sent again");
  assert.deepEqual(out, []);

  // Below the minimum: "small", never sent for credit, not kept.
  const small = pay(s, 1, 1500, TIP);
  out = await s.checkDeposits();
  assert.deepEqual(out.map((d) => [d.outpoint, d.state]), [[small, "small"]]);
  assert.equal(credits(), 1);
  assert.equal(s.depositIndex, 2);
  assert.ok(has(TOPUP.depositLine(out[0], TOPUP.topUpRules(s.relayInfo)), RELAY_TEXT.small({ min: 2000 })));

  // The relayer refuses (its own change, another account): "refused" with the code, not kept.
  const own = pay(s, 2, 9000, TIP);
  net.creditErrors.set(own, { status: 422, code: "deposit_own" });
  out = await s.checkDeposits();
  assert.deepEqual(out.map((d) => [d.outpoint, d.state, d.code, d.message]), [[own, "refused", "deposit_own", R.FALLBACK.deposit_own]]);
  assert.deepEqual(s.relayPrefs.pending, []);
  // The relayer counts fewer confirmations than the explorer: still waiting, with its counts.
  const slow = pay(s, 3, 5000, TIP);
  net.creditErrors.set(slow, { status: 409, code: "deposit_unconfirmed", extra: { confirmations: 0, needed: 1 } });
  out = await s.checkDeposits();
  assert.deepEqual(out.map((d) => [d.state, d.code, d.confirmations]), [["waiting", "deposit_unconfirmed", 0]]);
  assert.deepEqual(s.relayPrefs.pending.map((p) => p.outpoint), [slow]);
  net.creditErrors.delete(slow);
  out = await s.checkDeposits();
  assert.deepEqual(out.map((d) => d.state), ["credited"]);

  // An exchange paid an older address: found only when older addresses are checked, then credited.
  const late = pay(s, 0, 4000, TIP);
  assert.deepEqual((await s.checkDeposits()).map((d) => d.outpoint), [], "only the current address (and waiting ones) by default");
  const index = s.depositIndex;
  const asked = credits();
  out = await s.checkDeposits({ older: true });
  assert.deepEqual(out.filter((d) => d.state === "credited").map((d) => [d.outpoint, d.n]), [[late, 0]]);
  assert.deepEqual(out.filter((d) => d.state !== "credited").map((d) => [d.outpoint, d.state]), [[small, "small"], [own, "refused"]], "the older ones are reported again as they stand");
  assert.equal(credits(), asked + 2, "the late one and the refused one; never the small one");
  assert.equal(s.depositIndex, index, "an older payment does not move the index");
  assert.equal(s.relayBalance.balance, 6712 + 4712 + 3712);
});

test("3b: a wallet without prefs.relay makes no deposit or account request while the sheet is closed; auto-credit runs once per new block", async () => {
  net.height = TIP;
  const s = await synced();
  await withInfo(s);
  const before = net.calls.length;
  for (let i = 1; i <= 3; i++) {
    net.height = TIP + i;
    await s.sync();
    await s.relayWork;
  }
  assert.deepEqual(lookups(since(before)), [], "never topped up: no lookups at all");

  // The top-up sheet opens: deposit lookups once per new block while it is open.
  s.topUpOpen = true;
  net.height++;
  await s.sync();
  await s.relayWork;
  assert.equal(since(before).filter((c) => c.includes("/address/")).length, 1);
  await s.sync(); // same block: nothing more
  await s.relayWork;
  assert.equal(since(before).filter((c) => c.includes("/address/")).length, 1);

  // A payment arrives and the sheet closes: the pending payment keeps the lookups going until credited.
  const a = pay(s, 0, 7000, null);
  net.height++;
  await s.sync();
  await s.relayWork;
  assert.deepEqual(s.relayPrefs.pending.map((p) => p.outpoint), [a]);
  s.topUpOpen = false;
  net.chain.get(a).height = net.height + 1;
  net.height++;
  await s.sync();
  await s.relayWork;
  assert.equal(s.relayBalance.balance, 6712, "auto-credited after its confirmation");
  assert.deepEqual(s.relayPrefs.pending, []);
  // Credited: from now on only the balance read, once per block while it holds anything.
  const mark = net.calls.length;
  net.height++;
  await s.sync();
  await s.relayWork;
  assert.deepEqual(lookups(since(mark)), ["POST /api/relay/account"]);

  // A wallet with prefs.relay reads its balance on unlock (the first sync), without the sheet.
  const t0 = net.calls.length;
  const again = new S.Session({ phrase: S.newPhrase() });
  again.prefs.relay = { depositIndex: 1, pending: [] };
  await again.sync();
  await again.relayWork;
  assert.deepEqual(lookups(since(t0)), ["POST /api/relay/account"]);
  assert.deepEqual(again.relayBalance && [again.relayBalance.balance, again.relayBalance.nextIndex], [0, 0]);
});

/* ---------- 4. the Send form ---------- */

test("4: Send with no balance shows exactly the stage-0 cards plus the quiet top-up entry; off shows the off line", async (t) => {
  resetPrefs();
  const s = await synced();
  // Relaying off on this server.
  net.info = OFF_INFO;
  let v = await mountSend(t, s);
  assert.deepEqual(routeValues(v.route()), ["self", "copy"]);
  assert.ok(has(v.notes(), SEND.ROUTE_TEXT.off));
  assert.ok(!v.notes().includes("relay-topup"));
  assert.equal(v.mode(), "");

  // A relay-balance relayer, balance never read (unknown) or empty (none): the same two cards, one quiet entry.
  net.info = balanceInfo();
  for (const balance of [null, balanceOf(0)]) {
    s.relayBalance = balance;
    v = await mountSend(t, s);
    assert.deepEqual(routeValues(v.route()), ["self", "copy"], String(balance));
    assert.equal(checkedRoute(v.route()), "self");
    assert.ok(!has(v.route(), RELAY_TEXT.cardTitle));
    assert.ok(has(v.notes(), RELAY_TEXT.entry));
    assert.match(v.notes(), /<button type="button" class="btn btn--ghost btn--sm" data-action="relay-topup"><span>Top up a relay balance<\/span><\/button>/);
    assert.ok(!has(v.notes(), SEND.ROUTE_TEXT.off));
    assert.equal(v.mode(), "", "no timing control");
    assert.doesNotMatch(v.aside(), /What the relayer can and can't do/);
  }
});

test("4b: ok shows the relay card last and keeps Pay the fee myself checked; low and fee_high disable it with their texts; a stored relay route falls back to self while low", async (t) => {
  resetPrefs();
  const s = await synced();
  net.info = balanceInfo();
  s.relayBalance = balanceOf(100_000);
  let v = await mountSend(t, s);
  assert.deepEqual(routeValues(v.route()), ["self", "copy", "relay"], "the relay card comes last");
  assert.equal(checkedRoute(v.route()), "self", "paying yourself stays the default");
  const card = relayCardOf(v.route());
  for (const text of [RELAY_TEXT.cardTitle, RELAY_TEXT.cardStatus({ balance: 100_000 }), RELAY_TEXT.cardFee({ perSend: 657 }), LINK_TEXT.relayer]) assert.ok(has(card, text), text);
  assert.ok(!card.includes(" disabled"));
  assert.ok(!v.notes().includes("relay-topup"), "no entry line once the balance is in use");
  assert.equal(v.mode(), "");

  // Choosing it: the timing control, the relay disclosure and the operator sentence.
  await v.choose("relay");
  assert.equal(S.storage.getItem(ROUTE_KEY), "relay");
  assert.equal(checkedRoute(v.route()), "relay");
  assert.match(v.mode(), /data-name="timing"/);
  assert.ok(has(v.disclosure(), "~657 sats from your relay balance") || v.disclosure().includes("657 sats</span> from your relay balance"));
  assert.ok(has(v.disclosure(), "Relayer coins, charged to your relay balance"));
  assert.ok(has(v.disclosure(), RELAY_TEXT.operator));
  assert.deepEqual(SEND.SEND_STEPS("relay", "relay", "block").slice(-2), [
    { id: "submit", label: "Hand to the relayer, paid from your relay balance" },
    { id: "queued", label: "Queued for the next block" },
  ]);
  assert.ok(!SEND.SEND_STEPS("relay", "relay", "batch").some((x) => x.id === "pow"), "no anti-spam step");

  // A batch reserves twice the fee: 1,000 sats cover Next block but not a batch.
  s.relayBalance = balanceOf(1000);
  await v.seg("timing", "batch");
  let relay = relayCardOf(v.route());
  assert.ok(relay.includes(" disabled"), "disabled for the batch");
  assert.ok(has(relay, `${RELAY_TEXT.low({ balance: 1000, needed: 1314 })} ${RELAY_TEXT.lowBatch()}`));
  assert.ok(v.route().includes('data-action="relay-topup"'), "a Top up button under it");
  assert.equal(SEND.relayBlock(s.relayInfo, s.relayBalance, "batch"), `${RELAY_TEXT.low({ balance: 1000, needed: 1314 })} ${RELAY_TEXT.lowBatch()}`, "what the Send button says");
  assert.equal(SEND.relayBlock(s.relayInfo, s.relayBalance, "block"), null);
  await v.seg("timing", "block");
  assert.ok(!relayCardOf(v.route()).includes(" disabled"), "Next block is covered");

  // Low for any timing: disabled with the low text, and the Top up button.
  s.relayBalance = balanceOf(100);
  v = await mountSend(t, s);
  assert.equal(S.storage.getItem(ROUTE_KEY), "relay", "the stored preference stays");
  assert.equal(checkedRoute(v.route()), "self", "but the form uses Pay the fee myself");
  relay = relayCardOf(v.route());
  assert.ok(relay.includes(" disabled"));
  assert.ok(has(relay, RELAY_TEXT.low({ balance: 100, needed: 657 })));
  assert.ok(v.route().includes('data-action="relay-topup"'));
  assert.equal(v.mode(), "");

  // Fees above the cap: disabled with the fee_high text, no Top up button (topping up doesn't help).
  net.info = balanceInfo({ code: "fee_high", fees: { feeRate: 9, maxFeeRate: 5, carrierFeeSats: 5373 } });
  s.relayBalance = balanceOf(100_000);
  v = await mountSend(t, s);
  relay = relayCardOf(v.route());
  assert.ok(relay.includes(" disabled"));
  assert.ok(has(relay, RELAY_TEXT.feeHigh({ feeRate: 9, maxFeeRate: 5 })));
  assert.ok(!v.route().includes('data-action="relay-topup"'));
  assert.equal(checkedRoute(v.route()), "self");
  resetPrefs();
});

/* ---------- 5. the signed submit and failure texts ---------- */

test("5: submitEnvelope sends { envelope, mode, accountPub, t, sig } that verifyRequest accepts, never a pow field; relayFailure has a text for every code", async () => {
  const account = RA.relayAccount(new Uint8Array(32).fill(4), "signet");
  const submits = [];
  const client = {
    info: async () => balanceInfo(),
    submit: async (body) => (submits.push(body), { id: "ab".repeat(16), status: "queued", anchor: 100, deadline: 200, flush: "next-block", reservedSats: 657, balance: 1000 }),
  };
  const env = transact();
  for (const mode of ["fast", "block", "batch", "batch10"]) await R.submitEnvelope(env, { mode, account, client });
  assert.equal(submits.length, 4);
  for (const [i, body] of submits.entries()) {
    assert.deepEqual(Object.keys(body).sort(), ["accountPub", "envelope", "mode", "sig", "t"]);
    assert.ok(!("pow" in body));
    assert.equal(body.envelope, hex(env));
    const v = RA.verifyRequest({ endpoint: "/api/relay/submit", network: "signet", poolKey: POOL, body });
    assert.equal(v.ok, true, body.mode);
    assert.equal(v.idHex, account.idHex);
    assert.equal(body.mode, ["fast", "block", "batch", "batch10"][i]);
    // The signature binds the mode and the envelope: a copy with either changed fails.
    assert.equal(RA.verifyRequest({ endpoint: "/api/relay/submit", network: "signet", poolKey: POOL, body: { ...body, mode: body.mode === "fast" ? "block" : "fast" } }).code, "bad_signature");
    assert.equal(RA.verifyRequest({ endpoint: "/api/relay/submit", network: "signet", poolKey: POOL, body: { ...body, envelope: hex(transact(101)) } }).code, "bad_signature");
  }

  // Refused locally, before anything is signed: no balance-mode relayer, fees above the cap, a short balance.
  const n = submits.length;
  await assert.rejects(R.submitEnvelope(env, { account, client: { ...client, info: async () => OFF_INFO } }), { code: "disabled" });
  await assert.rejects(R.submitEnvelope(env, { mode: "batch", account, client: { ...client, info: async () => balanceInfo({ code: "fee_high" }) } }), { code: "fee_high" });
  await assert.rejects(R.submitEnvelope(env, { account, client: { ...client, info: async () => balanceInfo({ code: "halted" }) } }), { code: "halted" });
  await assert.rejects(R.submitEnvelope(env, { mode: "batch", account, balance: balanceOf(1000), client }), (e) => e.code === "balance_low" && e.needed === 1314 && e.perSend === 657);
  assert.equal(submits.length, n);
  // RelayPayer passes the account and returns the reservation.
  const carried = await new RelayPayer({ client }).carry({ envelope: env, account });
  assert.deepEqual([carried.relayId, carried.reservedSats, carried.balance], ["ab".repeat(16), 657, 1000]);

  // Every code of the contract's table has a plain-English text; the retired ones are gone.
  const CODES = {
    malformed: "The request is not a valid relay request. Update the wallet and try again.",
    bad_outpoint: "That is not a deposit outpoint. It must be a 64-character lowercase txid, a colon and the output number.",
    bad_signature: "The request signature does not match this account. Update the wallet and try again.",
    stale_request: "The request is too old or from the future. Check this device's clock and try again.",
    balance_low: "Your relay balance does not cover this send. Top up, or pay the fee yourself.",
    deposit_unknown: "The explorer does not know this deposit yet. Wait a minute and try again.",
    already_credited: "This deposit was already credited to another relay account or address number.",
    credit_in_progress: "This deposit is being credited right now. Try again in a few seconds.",
    deposit_unconfirmed: "The deposit needs more confirmations before it is credited.",
    replayed: "This exact request was already received. Send it again from the wallet.",
    deposit_mismatch: "This output does not pay that deposit address of your relay account.",
    deposit_small: "This deposit is below the minimum, so it is not credited.",
    deposit_own: "This output belongs to the relayer's own transaction and is never credited.",
    disabled: "No relayer runs on this server. Pay the fee yourself, or copy the envelope so anyone can carry it.",
    halted: "The relayer stopped itself because its books do not add up. Pay the fee yourself or copy the envelope; your balance is kept.",
    fee_high: "Bitcoin fees are above the relayer's cap right now, so it does not take sends. Pay the fee yourself or copy the envelope.",
    pool_low: "The relayer cannot fund more carriers in this block. Try the next block, or pay the fee yourself.",
  };
  for (const [code, text] of Object.entries(CODES)) assert.equal(R.relayFailure({ code }).message, text, code);
  for (const code of ["not_transact", "public_value", "duplicate_nullifier", "nullifier_spent", "nullifier_pending", "too_large", "anchor_unknown", "anchor_stale", "proof_invalid", "anchor_not_boundary", "epoch_closed", "rate_limited", "indexer_behind", "busy", "block_full", "queue_full", "batch_full", "batch_disabled", "network"]) {
    assert.ok(R.relayFailure({ code }).message.length > 20 && R.FALLBACK[code], code);
  }
  for (const code of ["pow_stale", "pow_insufficient", "hot_wallet_low", "budget_exhausted", "fee_too_high"]) assert.equal(R.FALLBACK[code], undefined, `${code} is retired`);
  for (const code of ["fee_high", "pool_low", "halted", "credit_in_progress", "deposit_unconfirmed", "stale_request"]) assert.equal(R.relayFailure({ code }).retryable, true, code);
  assert.equal(R.relayFailure({ code: "balance_low" }).retryable, false, "needs a top-up first");
  assert.equal(R.relayFailure({ code: "fee_high", message: "server text" }).message, "server text", "the server's text wins");
  assert.match(readFileSync(new URL("../web/src/relay.js", import.meta.url), "utf8"), /^(?![\s\S]*relay-pow)/, "no proof of work in the client");
});

/* ---------- 6. missed and stuck ---------- */

test("6: deriveStatus and retryChoices for missed (batch and not) and stuck sends; Activity shows RELAY_TEXT.missed and RELAY_TEXT.stuck", async (t) => {
  R.setRelayRoute(balanceInfo());
  const base = { height: 324_700, nullifiers: new Set(), outputs: new Map(), log: new Map(), assets: [] };
  for (const code of ["balance_low", "fee_high"]) {
    assert.deepEqual(S.deriveStatus(relayEntry(), { ...base, relay: { status: "missed", code, reason: "server words" } }), {
      status: "failed", relayStatus: "missed", missedCode: code, reason: RELAY_TEXT.missed(code),
    });
  }
  assert.equal(RELAY_TEXT.missed("fee_high"), "Not sent: fees were above the relayer's cap when it was due. Nothing was charged.");
  assert.equal(RELAY_TEXT.missed("balance_low"), "Not sent: your relay balance did not cover the fee when it was due. Nothing was charged.");
  const bc = S.deriveStatus(relayEntry(), { ...base, relay: { status: "broadcast", txid: "aa", broadcastHeight: 324_695, cost: 657 } });
  assert.deepEqual(bc, { status: "relaying", relayStatus: "broadcast", txid: "aa", broadcastHeight: 324_695, cost: 657 });

  const missed = (over) => relayEntry({ status: "failed", relayStatus: "missed", missedCode: "balance_low", reason: RELAY_TEXT.missed("balance_low"), ...over });
  assert.deepEqual(S.retryChoices(missed({ mode: "block" }), 324_700), ["next-block", "self", "copy"]);
  assert.deepEqual(S.retryChoices(missed({ mode: "fast" }), 324_700), ["next-block", "self", "copy"]);
  for (const mode of ["batch", "batch10"]) assert.deepEqual(S.retryChoices(missed({ mode, releaseAt: 324_702, lastRelease: 324_772 }), 324_710), ["next-batch", "next-block", "self", "copy"], mode);

  const stuck = relayEntry({ relayStatus: "broadcast", broadcastHeight: 324_694 });
  assert.equal(S.STUCK_AFTER, 6);
  assert.deepEqual(S.retryChoices(stuck, 324_699), [], "five blocks: not yet");
  assert.equal(S.relayStuck(stuck, 324_699), false);
  assert.deepEqual(S.retryChoices(stuck, 324_700), ["self", "copy"]);
  assert.equal(S.relayStuck(stuck, 324_700), true);
  assert.equal(S.relayStuck({ ...stuck, broadcastHeight: undefined, sentHeight: 324_690 }, 324_696), true, "from the send height when the relayer gave none");
  assert.equal(S.relayStuck({ ...stuck, relayStatus: "accepted" }, 324_800), false);
  assert.equal(S.relayStuck({ ...stuck, via: "self" }, 324_800), false);
  assert.deepEqual(S.retryChoices({ ...stuck, mode: "batch", releaseAt: 324_690, lastRelease: 324_760 }, 324_700), ["self", "copy"], "a stuck batch carrier too");

  // Activity: the missed line and its four (batch) or three ways on; the stuck line and two.
  let page = await mountActivity(t, activitySession(324_700, [missed({ mode: "block" })]));
  assert.ok(has(page, RELAY_TEXT.missed("balance_low")));
  assert.deepEqual(actions(page), ["retry-block", "retry-self", "copy-env"]);
  page = await mountActivity(t, activitySession(324_710, [missed({ mode: "batch", missedCode: "fee_high", reason: RELAY_TEXT.missed("fee_high"), anchor: 324_696, releaseAt: 324_702, lastRelease: 324_772, deadline: 324_796 })]));
  assert.ok(has(page, RELAY_TEXT.missed("fee_high")));
  assert.equal(page.split(esc(RELAY_TEXT.missed("fee_high"))).length - 1, 1, "said once");
  assert.deepEqual(actions(page), ["retry-batch", "retry-block", "retry-self", "copy-env"]);
  page = await mountActivity(t, activitySession(324_700, [stuck]));
  assert.ok(has(page, RELAY_TEXT.stuck));
  assert.match(page, /<span class="tag tag--warn">Needs attention<\/span>/);
  assert.deepEqual(actions(page), ["retry-self", "copy-env"]);
  assert.ok(ACT.matches("failed", stuck, 324_700));
  assert.match(String(statusChip(stuck, 324_700)), /Needs attention/);
  // Relaying off: relay retries are never offered.
  R.setRelayRoute(OFF_INFO);
  page = await mountActivity(t, activitySession(324_700, [missed({ mode: "block" })]));
  assert.deepEqual(actions(page), ["retry-self", "copy-env"]);
  R.setRelayRoute(balanceInfo());
});

/* ---------- 7. recent deposit ---------- */

test("7: linkage(relay) gives recent-deposit below 5 relayed transfers landed since the newest credit, and the Send hint shows it", async (t) => {
  resetPrefs();
  const s = await synced();
  await withInfo(s, balanceInfo({ stats: { relayed144: 9, landed144: [[324_680, 9], [324_691, 2], [324_695, 2]] } }));
  assert.deepEqual(s.linkage("relay"), [], "no credit yet");
  s.relayBalance = balanceOf(10_000, 0, [{ outpoint: `${txid(5)}:0`, n: 0, value: 7000, amount: 6712, height: 324_650 }, { outpoint: `${txid(6)}:1`, n: 1, value: 4000, amount: 3712, height: 324_690 }]);
  assert.deepEqual(s.linkage("relay"), [{ kind: "recent-deposit", height: 324_690, landedSince: 4 }], "4 landed after block 324,690");
  s.relayInfo.stats.landed144.push([324_699, 1]);
  assert.deepEqual(s.linkage("relay"), [], "5 landed since: no warning");
  s.relayInfo.stats.landed144.pop();
  assert.equal(S.RECENT_DEPOSIT_LANDED, 5);
  assert.deepEqual(s.linkage("self").filter((l) => l.kind === "recent-deposit"), [], "only for the relay route");

  S.storage.setItem(ROUTE_KEY, "relay");
  const v = await mountSend(t, s);
  assert.equal(checkedRoute(v.route()), "relay");
  assert.match(v.hint(), /callout--warn/);
  assert.ok(has(v.hint(), RELAY_TEXT.recentDeposit));
  assert.match(v.cta(), /Send privately/);
  await v.choose("self");
  assert.ok(!has(v.hint(), RELAY_TEXT.recentDeposit), "not for paying yourself");
  resetPrefs();
});

/* ---------- 8. the top-up sheet ---------- */

test("8: the top-up sheet: address, QR, suggested amount, minimum, confirmations, every privacy line; streamer masking", async () => {
  resetPrefs();
  const s = await synced();
  await withInfo(s);
  s.relayBalance = balanceOf(1234, 657);
  const dep = s.depositAddress();
  const body = String(TOPUP.topUpBody(s, {}));
  assert.ok(body.includes(dep.address.slice(0, 12)) && body.includes(dep.address.slice(-8)), "the address in full");
  assert.match(body, /<svg[^>]*aria-label="QR code of your relay deposit address"/);
  assert.ok(body.includes("DEPOSIT ADDRESS #0"));
  for (const text of [
    RELAY_TEXT.topUpOnce, RELAY_TEXT.meter(3), RELAY_TEXT.suggested({ sats: 7000, sends: 10 }), RELAY_TEXT.minimum({ min: 2000 }), RELAY_TEXT.confirmations(1),
    RELAY_TEXT.fresh, RELAY_TEXT.anyWallet, RELAY_TEXT.operator, RELAY_TEXT.timing, RELAY_TEXT.lookup, RELAY_TEXT.sweep({ sweep: 288 }), RELAY_TEXT.noWithdraw,
  ]) assert.ok(has(body, text), text);
  assert.equal(RELAY_TEXT.suggested({ sats: 7000, sends: 10 }), "Suggested: 7,000 sats, about 10 sends at today's fees.");
  assert.equal(RELAY_TEXT.confirmations(3), "Credited after 3 confirmations, about 30 minutes on average.");
  assert.match(body, /value="7000"[^>]*name="topup-amount"/, "the amount starts on the suggested one");
  assert.ok(body.includes('data-action="tu-pay-key"'));
  assert.ok(!body.includes('data-action="tu-pay-unisat"'), "Unisat only when connected");
  assert.ok(body.includes('data-action="tu-older"'));
  assert.deepEqual([TOPUP.parseTopUp("1999", 2000).error, TOPUP.parseTopUp("2000", 2000).error, TOPUP.parseTopUp("1.5", 2000).error], [RELAY_TEXT.minimum({ min: 2000 }), null, "Enter a whole number of sats."]);
  assert.match(String(TOPUP.topUpBody(s, { amount: "1500" })), /data-action="tu-pay-key" disabled/, "below the minimum: refused");

  // Streamer mode: the address and the QR are hidden until revealed, amounts too.
  S.setStreamerMode(true);
  try {
    const hidden = String(TOPUP.topUpBody(s, {}));
    assert.ok(!hidden.includes(dep.address.slice(4, 20)), "no address");
    assert.ok(!/<svg[^>]*aria-label="QR code of your relay deposit address"/.test(hidden), "no QR");
    assert.ok(hidden.includes("QR hidden"));
    assert.ok(!hidden.includes("1,234"), "no balance");
    assert.ok(hidden.includes('data-action="tu-reveal"'));
    const shown = String(TOPUP.topUpBody(s, { shown: true }));
    assert.ok(shown.includes(dep.address.slice(4, 20)), "shown on request");
  } finally {
    S.setStreamerMode(false);
  }
  // No relayer: the off line only.
  R.setRelayRoute(OFF_INFO);
  assert.ok(has(TOPUP.topUpBody(s, {}), R.RELAY_OFF));
  assert.equal(TOPUP.relayMenuOn(), false);
  R.setRelayRoute(s.relayInfo);
  assert.equal(TOPUP.relayMenuOn(), true);
});

test("8b: pay from the built-in key builds a plain payment to the deposit address (no OP_RETURN), shows its fee first, broadcasts only on confirm, and tracks it", async (t) => {
  resetPrefs();
  const s = await synced();
  await withInfo(s);
  s.relayBalance = balanceOf(0);
  const dep = s.depositAddress();
  const broadcasts = [];
  const coin = { txid: txid(77), vout: 1, value: 50_000, status: { confirmed: true, block_height: TIP - 10 } };
  const esplora = {
    utxos: async (address) => (address === s.localPayer.address ? [coin] : []),
    feeRate: async () => 2,
    broadcast: async (raw) => (broadcasts.push(raw), btc.Transaction.fromRaw(Buffer.from(raw, "hex")).id),
  };
  const opened = TOPUP.openTopUp(s, { esplora });
  t.after(() => opened.sheet.close());
  assert.equal(s.topUpOpen, true);
  await settle(20);
  assert.equal(TOPUP.openTopUp(s, { esplora }), opened, "one at a time");

  fire(opened.sheet.el, "click", clickOn("tu-pay-key"));
  await settle(20);
  const review = opened.state.review;
  assert.ok(review, "a review before anything is broadcast");
  assert.deepEqual(broadcasts, []);
  assert.equal(review.amount, 7000);
  assert.equal(review.n, 0);
  assert.ok(review.fee > 0);
  assert.ok(has(TOPUP.payReview(review), RELAY_TEXT.payFromKey));
  const tx = btc.Transaction.fromRaw(Buffer.from(review.hex, "hex"));
  const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));
  assert.ok(outs.every((o) => o.script[0] !== 0x6a), "no OP_RETURN");
  // L5: the change can come first; review.vout names the deposit output.
  assert.ok(review.vout === 0 || review.vout === 1);
  assert.equal(hex(outs[review.vout].script), hex(RA.depositAddress(POOL, sha256(RA.parseAccountPub(s.relayAccount.pubHex)), 0, "signet").script));
  assert.equal(outs[review.vout].amount, 7000n);
  assert.equal(Number(50_000n - outs.reduce((a, o) => a + o.amount, 0n)), review.fee, "the fee is what the review shows");

  fire(opened.sheet.el, "click", clickOn("tu-pay-confirm"));
  await settle(20);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0], review.hex);
  assert.equal(opened.state.review, null);
  const broadcastVout = Number(s.relayPrefs.pending[0].outpoint.split(":")[1]);
  assert.deepEqual(s.relayPrefs.pending.map((p) => [p.n, p.outpoint, p.value]), [[0, `${tx.id}:${review.vout}`, 7000]]);
  assert.equal(s.depositIndex, 1, "the next top-up goes to a fresh address");
  assert.notEqual(s.depositAddress().address, dep.address);

  // Once credited, the sheet offers to use the balance for private sends.
  net.chain.set(`${tx.id}:${broadcastVout}`, { address: dep.address, value: 7000, height: TIP });
  await opened.check(false);
  assert.equal(s.relayBalance.balance, 6712);
  const after = String(TOPUP.topUpBody(s, opened.state));
  assert.ok(has(after, RELAY_TEXT.credited({ amount: 6712 })));
  assert.ok(after.includes('data-action="tu-use-relay"'));
  fire(opened.sheet.el, "click", clickOn("tu-use-relay"));
  await settle();
  assert.equal(S.storage.getItem(ROUTE_KEY), "relay");
  opened.sheet.close();
  await settle(40);
  assert.equal(s.topUpOpen, false, "closing the sheet stops the lookups");
  resetPrefs();
});

/* ---------- Settings and Portfolio ---------- */

test("Settings: the relay balance panel and relay card only while a relay-balance relayer runs; Portfolio shows the balance only after a top-up", async (t) => {
  resetPrefs();
  const s = await synced();
  net.info = balanceInfo();
  s.relayBalance = balanceOf(6055, 0, [{ outpoint: `${txid(9)}:0`, n: 0, value: 7000, amount: 6712, height: TIP }]);
  const root = new FakeEl();
  t.after(SET.settingsView(root, s));
  await settle(30);
  const page = String(root.innerHTML);
  assert.ok(page.includes('id="relay-balance"'));
  for (const text of ["Relay balance", RELAY_TEXT.operator, RELAY_TEXT.meter(3), RELAY_TEXT.cardTitle]) assert.ok(has(page, text), text);
  assert.ok(page.includes("6,055"));
  assert.ok(page.includes('data-action="relay-topup"'));
  assert.ok(has(page, SET.RELAY_NETWORK_NOTE));
  assert.deepEqual(routeValues(page), ["relay", "self", "copy"]);
  assert.doesNotMatch(page, /ticket/i);
  // No balance: the card is there but disabled until a top-up.
  s.relayBalance = balanceOf(0);
  assert.match(String(SET.settingsRelayCard(s)), /value="relay" disabled/);
  assert.ok(has(SET.settingsRelayCard(s), "Top up a relay balance first."));

  // Portfolio: nothing new for a wallet that never topped up.
  assert.equal(PORT.relayLine(s), "");
  s.prefs.relay = { depositIndex: 1, pending: [] };
  s.relayBalance = balanceOf(6055);
  assert.ok(String(PORT.relayLine(s)).includes("6,055"));
  assert.ok(String(PORT.relayLine(s)).includes('data-action="relay-topup"'));
  resetPrefs();
});

/* ---------- 9. copy ---------- */

test("9: the approved sentences word for word; no web file says ticket; no free or sponsored relaying", () => {
  const doc = readFileSync(new URL("../docs/design/relay-balance.md", import.meta.url), "utf8");
  for (const k of ["recentDeposit", "operator", "topUpOnce"]) assert.ok(doc.includes(`"${RELAY_TEXT[k]}"`), k);
  assert.equal(RELAY_TEXT.recentDeposit, "Your top-up confirmed recently and few people are relaying right now. Sending now can link this transfer to the address you paid from. A batch mode, or waiting, hides this better.");
  assert.equal(RELAY_TEXT.operator, "The relayer can link the address you top up from to every transfer you relay with this balance. Tor does not prevent this. It cannot see amounts, tokens or recipients.");
  assert.equal(RELAY_TEXT.topUpOnce, "Top up once, it lasts many sends.");
  assert.equal(RELAY_TEXT.entry, "Top up a relay balance");
  assert.equal(LINK_TEXT.relayer, "On Bitcoin, relayer coins carry the transfer, not yours. The relayer knows which balance paid and the address you topped up from. It can't read or change the contents: the proof binds every byte.");
  assert.equal(R.RELAY_OFF, "Relaying is off on this server. Pay the fee yourself, or copy the envelope.");

  const root = new URL("../web/src/", import.meta.url);
  const files = [];
  (function walk(dir) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(js|json|css|html)$/.test(name)) files.push(p);
    }
  })(root.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  assert.ok(files.length > 40);
  const FREE_RELAY = [/\bfree[- ]relay/i, /\brelay\w*[^.\n]{0,24}\bfree\b/i, /\bsponsor/i, /\bneeds? no BTC\b/i, /\bfor free\b/i, /\bGhost Relay\b/i, /\brelayer pays\b/i, /\bfree balance\b/i];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.doesNotMatch(text, /ticket/i, f);
    if (!f.endsWith(".js")) continue;
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const re of FREE_RELAY) assert.doesNotMatch(code, re, `${f}: ${re}`);
  }
  // Every RELAY_TEXT string stays within the copy rules too.
  const args = { balance: 1, needed: 2, perSend: 3, feeRate: 4, maxFeeRate: 5, sats: 6, sends: 7, min: 8, sweep: 9, confirmations: 1, amount: 10 };
  const all = Object.entries(RELAY_TEXT)
    .flatMap(([k, v]) => (typeof v !== "function" ? [v] : k === "meter" || k === "confirmations" ? [v(1), v(3)] : k === "missed" ? [v("fee_high"), v("balance_low")] : [v(args)]))
    .join("\n");
  for (const re of [...FREE_RELAY, /\banonymous\b/i, /\buntraceable\b/i, /\bmixer\b/i, /\btrustless\b/i, /ticket/i]) assert.doesNotMatch(all, re);
});

/* ---------- review fixes (web): first sync, Activity retries, credited elsewhere, the 144-block window, copy from relay info ---------- */

test("10: the first sync after a page load opens the relay route before reading history: a scheduled batch send is not looked up early, nor shown as stranded", async () => {
  net.height = TIP;
  R.setRelayRoute(null); // a page load: the route starts closed
  net.info = balanceInfo();
  net.stateRelay = { enabled: true, mode: "balance", queued: 0, defaultMode: "block", batch: null };
  const batchEntry = (id) => relayEntry({ id, mode: "batch", anchor: TIP - 2, releaseAt: TIP + 4, lastRelease: TIP + 74, deadline: TIP + 98 });
  const s = new S.Session({ phrase: S.newPhrase() });
  const entry = batchEntry("e1");
  s.history = [entry];
  const before = net.calls.length;
  await s.sync();
  const calls = since(before);
  assert.deepEqual(calls.filter((c) => c.includes("/api/relay/status/")), [], "no per-id lookup before releaseAt");
  assert.ok(calls.includes("GET /api/relay/info"), "relay info is read during the sync");
  assert.equal(R.relayOpen(), true);
  assert.equal(S.relayStranded(entry), false);
  assert.equal(S.batchPhase(entry, TIP), "scheduled");
  assert.deepEqual([entry.status, entry.relayStatus], ["relaying", "queued"]);

  // Relay info unreadable, but /api/state says a relayer runs: still no early lookup, nothing stranded.
  R.setRelayRoute(null);
  net.info = null;
  const s2 = new S.Session({ phrase: S.newPhrase() });
  const e2 = batchEntry("e2");
  s2.history = [e2];
  const b2 = net.calls.length;
  await s2.sync();
  assert.deepEqual(since(b2).filter((c) => c.includes("/api/relay/status/")), []);
  assert.deepEqual([e2.status, e2.relayStatus], ["relaying", "queued"]);

  // A server without a relayer: the stage-0 behaviour stays (asked at once; the retired relayer's ids answer there).
  net.stateRelay = null;
  const s3 = new S.Session({ phrase: S.newPhrase() });
  s3.history = [batchEntry("e3")];
  const b3 = net.calls.length;
  await s3.sync();
  assert.equal(since(b3).filter((c) => c.includes("/api/relay/status/")).length, 1);
  net.info = balanceInfo();
  R.setRelayRoute(balanceInfo());
});

test("10b: Activity offers no relay retry the balance cannot pay (a missed balance_low send gets Top up); an unread balance does not block; retry refuses before proving", async (t) => {
  R.setRelayRoute(balanceInfo());
  const missed = relayEntry({ status: "failed", relayStatus: "missed", missedCode: "balance_low", reason: RELAY_TEXT.missed("balance_low"), mode: "batch", anchor: 324_696, releaseAt: 324_702, lastRelease: 324_772, deadline: 324_796 });
  const withBalance = (b, entry = missed) => {
    const s = activitySession(324_710, [{ ...entry }]);
    s.relayInfo = balanceInfo();
    s.relayBalance = b;
    return s;
  };
  let page = await mountActivity(t, withBalance(balanceOf(600)));
  assert.deepEqual(actions(page), ["retry-self", "copy-env"], "600 sats pay neither a batch retry (1,314) nor a next-block one (657)");
  assert.match(page, /data-action="relay-topup"/);
  page = await mountActivity(t, withBalance(balanceOf(1000)));
  assert.deepEqual(actions(page), ["retry-block", "retry-self", "copy-env"], "1,000 sats pay the next block, not the batch");
  assert.match(page, /data-action="relay-topup"/);
  page = await mountActivity(t, withBalance(balanceOf(10_000)));
  assert.deepEqual(actions(page), ["retry-batch", "retry-block", "retry-self", "copy-env"]);
  assert.match(page, /data-action="relay-topup"/, "missed for its balance: Top up is offered too");
  page = await mountActivity(t, withBalance(null));
  assert.deepEqual(actions(page), ["retry-batch", "retry-block", "retry-self", "copy-env"], "an unread balance: the relayer decides");
  page = await mountActivity(t, withBalance(balanceOf(10_000), { ...missed, missedCode: "fee_high", reason: RELAY_TEXT.missed("fee_high") }));
  assert.doesNotMatch(page, /data-action="relay-topup"/, "missed for fees: no Top up");

  // Clicking a relay retry the balance cannot pay never starts a proof.
  const s = withBalance(balanceOf(1000));
  let retried = 0;
  s.retry = async () => {
    retried += 1;
  };
  const root = new FakeEl();
  const off = ACT.activityView(root, s, null);
  t.after(off);
  await settle();
  await Promise.all(fire(root, "click", clickOn("retry-batch", { id: "e1" })));
  await settle();
  assert.equal(retried, 0);
  await Promise.all(fire(root, "click", clickOn("retry-block", { id: "e1" })));
  await settle(20);
  assert.equal(retried, 1, "the next block is within the balance");
  closeAllSheets();
});

test("10c: a pending top-up credited elsewhere leaves pending instead of waiting forever", async () => {
  net.height = TIP;
  const a = await synced();
  await withInfo(a);
  const id = (i) => txid(9000 + i);
  // This device paid #0 from its built-in key, and the payment confirmed.
  a.recordTopUp({ n: 0, txid: id(1), vout: 0, value: 7000 });
  net.chain.set(`${id(1)}:0`, { address: a.depositAddress(0).address, value: 7000, height: TIP });
  // Another device of the same wallet credited it first.
  const acct = accountOf(a.relayAccount.idHex);
  acct.balance += 6712;
  acct.nextIndex = 1;
  acct.credits.unshift({ outpoint: `${id(1)}:0`, n: 0, value: 7000, amount: 6712, height: TIP });
  await a.loadRelayBalance();
  for (let i = 0; i < 3; i++) {
    const out = await a.checkDeposits();
    assert.deepEqual(out.filter((d) => d.state === "waiting"), [], `check ${i}: not "waiting"`);
  }
  assert.deepEqual(a.relayPrefs.pending, [], "it left pending");
  // One credited and already spent by the relayer (no scan sees it any more): it leaves pending too.
  a.recordTopUp({ n: 1, txid: id(2), vout: 0, value: 5000 });
  acct.credits.unshift({ outpoint: `${id(2)}:0`, n: 1, value: 5000, amount: 4712, height: TIP });
  acct.nextIndex = 2;
  await a.loadRelayBalance();
  await a.checkDeposits();
  assert.deepEqual(a.relayPrefs.pending, []);
});

test("10d: the recent-deposit warning only for a credit inside the 144 blocks landed144 covers", async () => {
  const s = await synced();
  await withInfo(s, balanceInfo({ height: 325_000, stats: { relayed144: 2, landed144: [[324_990, 1], [324_995, 1]] } }));
  s.relayBalance = balanceOf(10_000, 0, [{ outpoint: `${txid(7)}:0`, n: 0, value: 7000, amount: 6712, height: 324_600 }]);
  assert.deepEqual(s.linkage("relay"), [], "a top-up 400 blocks old is not recent");
  s.relayBalance = balanceOf(10_000, 0, [{ outpoint: `${txid(7)}:0`, n: 0, value: 7000, amount: 6712, height: 324_900 }]);
  assert.deepEqual(s.linkage("relay"), [{ kind: "recent-deposit", height: 324_900, landedSince: 2 }]);
  await withInfo(s);
});

test("10e: the fee and reservation copy follows the relayer's margin and headroom; the defaults read as before", () => {
  assert.equal(RELAY_TEXT.cardFee({ perSend: 657 }), "~657 sats from your relay balance (network fee plus a 10% margin, at least 50 sats)");
  assert.equal(RELAY_TEXT.lowBatch(), "A batch send reserves twice the fee until its batch goes out; the difference comes back.");
  assert.equal(RELAY_TEXT.cardFee({ perSend: 718, marginPct: 20, marginMinSats: 100 }), "~718 sats from your relay balance (network fee plus a 20% margin, at least 100 sats)");
  assert.equal(RELAY_TEXT.lowBatch({ headroom: 3 }), "A batch send reserves 3 times the fee until its batch goes out; the difference comes back.");
  R.setRelayRoute(balanceInfo());
  const info = balanceInfo({ balance: { ...balanceInfo().balance, marginPct: 20, marginMinSats: 100, perSendSats: 718, batchHeadroom: 3 } });
  const text = SEND.relayBlock(info, balanceOf(1000), "batch");
  assert.ok(text.includes("needs about 2,154") && text.endsWith(RELAY_TEXT.lowBatch({ headroom: 3 })), text);
  const card = String(SEND.relayCard({ relayInfo: info, relayBalance: balanceOf(10_000) }, { checked: false, mode: "block" }));
  assert.ok(has(card, RELAY_TEXT.cardFee({ perSend: 718, marginPct: 20, marginMinSats: 100 })), card);
});

test("file formats: CRLF files stay CRLF, LF files stay LF, the new sheet is LF", () => {
  const raw = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "latin1");
  for (const f of ["web/src/session.js", "web/src/relay.js", "web/src/app.js", "web/src/views/app-send.js", "web/src/views/app-shared.js", "web/src/views/landing.js", "web/src/ui/kit-view.js"]) {
    const b = raw(f);
    assert.equal((b.match(/\r\n/g) ?? []).length, (b.match(/\n/g) ?? []).length, `${f}: CRLF throughout`);
  }
  for (const f of ["web/src/views/topup.js", "web/src/payers.js", "web/src/api.js", "web/src/privacy.js", "web/src/views/app-settings.js", "web/src/views/app-activity.js", "web/src/views/app-portfolio.js", "web/src/ui/meter.js", "web/src/facts.json"]) {
    assert.ok(!raw(f).includes("\r"), `${f}: LF only`);
  }
});

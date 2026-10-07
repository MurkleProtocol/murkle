// Audit 2, web wallet and in-browser verification fixes:
// V2-18 the relay deposit address is always on this wallet's network (signet), whatever the server reports;
// V2-19 a vault write that localStorage refuses throws, it never goes to memory and drops entries later;
// V2-20 / V2-21 switching indexer drops the old server's relay info, log and cursor; top-ups are kept per relayer;
// V2-22 two tabs can't reserve the same notes (W-1 across tabs);
// V2-23 Lock now locks every tab; V2-24 streamer mode follows other tabs;
// V2-25 Unisat payments re-check the chain; V2-27 the phrase hides when the window loses focus mid-press;
// V2-31 a root rebuilt from the indexer's commitments is labelled IDX, not YOU;
// V2-32 a saved replay's root is used only while its block is still the chain's.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { schnorr } from "@noble/curves/secp256k1";

// Web modules import JSON without attributes and CSS (Vite handles both); teach Node the same.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (url.endsWith(".json") && !context.importAttributes?.type) return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
    return nextLoad(url, context);
  },
});

const keystore = await import("../web/src/keystore.js");
const api = await import("../web/src/api.js");
const { STORAGE_PREFIX, NETWORK } = await import("../web/src/config.js");
const S = await import("../web/src/session.js");
const R = await import("../web/src/relay.js");
const RA = await import("../src/relay-account.mjs");
const { UnisatPayer } = await import("../web/src/payers.js");
const { MockUnisat } = await import("./mock-unisat.mjs");
const { RELAY_TEXT } = await import("../web/src/views/app-shared.js");
const { wireHold } = await import("../web/src/views/app-settings.js");
const { rootChip, rootDetails, rootSentence } = await import("../web/src/ui/rootmatch.js");
const { REBUILD_TIP, prov } = await import("../web/src/ui/prov.js");
const { replayRootAt } = await import("../web/src/verify/replay.js");

const PW = "correct horse battery";
const VAULT = keystore.vaultKey(STORAGE_PREFIX);
const LOCK_ALL = `${STORAGE_PREFIX}.lockAll`;
const STREAMER = `${STORAGE_PREFIX}.streamer`;
const POOL_A = Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(9))).toString("hex");
const POOL_B = Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(10))).toString("hex");
const info = (poolKey = POOL_A, over = {}) => ({
  enabled: true, mode: "balance", code: null, reason: null, network: "signet", address: "tb1prelayer",
  fees: { feeRate: 1, maxFeeRate: 5, carrierFeeSats: 597 },
  balance: { poolKey, perSendSats: 657, batchHeadroom: 2, minDepositSats: 2000, depositConfirmations: 1 }, ...over,
});
const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });

function reset() {
  S.forgetWallet();
  R.setRelayRoute(null);
}

/** A session that never touches the network. */
function offlineSession(phrase = S.newPhrase()) {
  const s = new S.Session({ phrase });
  s.wallet.artifacts = {};
  s.sync = async () => {};
  s.view = { height: 200, nullifiers: new Set(), outputs: [] };
  return s;
}

/* ---------- V2-18 ---------- */

test("V2-18: the relay route opens only on this wallet's network; deposit addresses and signatures pin it", async () => {
  assert.equal(NETWORK, "signet");
  assert.equal(R.setRelayRoute(info(POOL_A, { network: "mainnet" })), false, "a relayer on mainnet never opens the route");
  assert.equal(R.setRelayRoute(info(POOL_A, { network: undefined })), false, "nor one that names no network");
  assert.equal(R.setRelayRoute(info(POOL_A)), true);

  const s = offlineSession();
  s.relayInfo = info(POOL_A);
  const good = s.depositAddress(0).address;
  assert.match(good, /^tb1p/);
  // A hostile server's info, with the route forced open: the wallet still derives on signet.
  s.relayInfo = info(POOL_A, { network: "mainnet" });
  R.RELAY_ROUTE.open = true;
  assert.equal(s.depositAddress(0).address, good, "never the bc1p twin");
  R.setRelayRoute(s.relayInfo);
  assert.throws(() => s.depositAddress(0), { code: "disabled" }, "the route is closed for it anyway");

  // Signed requests name this wallet's network, not the server's.
  const account = RA.relayAccount(new Uint8Array(32).fill(3), "signet");
  const sent = [];
  const client = { account: async (body) => (sent.push(body), { ok: true }) };
  await R.accountBalance({ account, info: info(POOL_A), client });
  assert.equal(RA.verifyRequest({ endpoint: "/api/relay/account", network: "signet", poolKey: POOL_A, body: sent[0] }).ok, true);
  await assert.rejects(R.accountBalance({ account, info: info(POOL_A, { network: "mainnet" }), client }), { code: "disabled" });
  assert.equal(sent.length, 1, "nothing is signed for a relayer on another network");

  assert.doesNotMatch(RELAY_TEXT.anyWallet, /exchange/i, "no exchange can pay a signet address");
  assert.match(RELAY_TEXT.anyWallet, /signet wallet/);
  R.setRelayRoute(null);
});

/* ---------- V2-19 ---------- */

test("V2-19: a vault write refused by a full localStorage throws; no entry is dropped later", async (t) => {
  reset();
  const data = new Map();
  const ls = {
    full: false,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem(k, v) {
      if (this.full) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
      data.set(k, String(v));
    },
    removeItem: (k) => data.delete(k),
  };
  globalThis.localStorage = ls;
  t.after(() => {
    S.lock("idle");
    S.storage.removeItem(VAULT);
    delete globalThis.localStorage;
  });
  const s = await S.createWallet(S.newPhrase(), PW);
  const first = s.record({ kind: "send", via: "relay", spends: ["111", "222"], commitments: ["1"], anchor: 150, status: "relaying" });
  assert.equal(S.storage.getItem(VAULT), data.get(VAULT), "the vault lives in localStorage");

  ls.full = true;
  assert.throws(
    () => s.record({ kind: "send", via: "relay", spends: ["333", "444"], commitments: ["2"], anchor: 150, status: "relaying" }),
    (e) => e.code === "storage_full" && e.message === S.STORAGE_FULL,
    "record() throws before anything could be handed out",
  );
  assert.deepEqual(s.history.map((h) => h.id), [first.id], "the refused entry is not kept in memory either");
  assert.equal(S.storage.getItem(VAULT), data.get(VAULT), "nothing went to an in-memory stand-in");
  // A plain pref write is best effort and never throws.
  s.routePref = "copy";

  ls.full = false;
  s.update(first, { relayId: "r1" }); // the next write: pull() must not take the stored vault for another tab's
  assert.deepEqual(s.history.map((h) => h.id), [first.id]);
  const stored = (await keystore.unlockVault(JSON.parse(data.get(VAULT)), PW)).data.history;
  assert.deepEqual(stored.map((h) => [h.id, h.relayId]), [[first.id, "r1"]]);
  assert.deepEqual([...S.lockedNullifiers(s.history, 160, new Set())], ["111", "222"]);
});

/* ---------- V2-20 / V2-21 ---------- */

test("V2-20/21: switching indexer drops the old server's relay info, log and cursor", async (t) => {
  reset();
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    api.setIndexerBase("");
    R.setRelayRoute(null);
  });
  // The module session (unlocked) is reset by the switch itself.
  const m = await S.createWallet(S.newPhrase(), PW);
  m.relayInfo = info(POOL_A);
  R.setRelayRoute(m.relayInfo);
  m.relayBalance = { balance: 5000, reserved: 0, nextIndex: 1, credits: [], at: 1 };
  m.log.set("t1", { ok: false, reason: "lie" });
  m.logItems = [{ txid: "t1", ok: false }];
  m.logCursor = 5;
  api.setIndexerBase("http://b.test");
  assert.deepEqual([m.relayInfo, m.relayBalance, m.logCursor, m.log.size, m.logItems.length, R.relayOpen()], [null, null, 0, 0, 0, false]);

  // Any session reads the log of the indexer it is on: a cursor from another one starts over.
  api.setIndexerBase("");
  const urls = [];
  const logs = {
    "": [{ height: 10, txid: "t1", ok: false, opName: "TRANSFER", reason: "lie" }],
    "http://b.test": [{ height: 9, txid: "t0", ok: true, opName: "MINT" }, { height: 10, txid: "t2", ok: true, opName: "TRANSFER" }],
  };
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const u = new URL(url, "http://here");
    const base = String(url).startsWith("http://b.test") ? "http://b.test" : "";
    const all = logs[base];
    const from = Number(u.searchParams.get("from"));
    return json({ items: all.slice(from), next: null, total: all.length });
  };
  const s = offlineSession();
  await s.pullLog();
  assert.equal(s.log.get("t1")?.ok, false);
  api.setIndexerBase("http://b.test");
  await s.pullLog();
  assert.match(urls.at(-1), /^http:\/\/b\.test\/api\/log\?from=0&/, "the new indexer is read from its start");
  assert.equal(s.log.has("t1"), false, "the abandoned indexer's verdict is gone");
  assert.deepEqual(s.logItems.map((e) => e.txid), ["t0", "t2"]);
});

test("V2-20: top-ups are tracked per relayer (pool key): a deposit made to one is never checked at another", () => {
  const s = offlineSession();
  s.relayInfo = info(POOL_A);
  R.setRelayRoute(s.relayInfo);
  const txA = "ab".repeat(32);
  s.recordTopUp({ n: 0, txid: txA, vout: 0, value: 5000 });
  assert.equal(s.relayPrefs.poolKey, POOL_A);
  assert.equal(s.depositIndex, 1);

  s.relayInfo = info(POOL_B);
  R.setRelayRoute(s.relayInfo);
  assert.equal(s.relayPrefs, null, "relayer B has no top-up from this wallet");
  assert.equal(s.depositIndex, 0);
  s.recordTopUp({ n: 0, txid: "cd".repeat(32), vout: 1, value: 4000 });
  assert.equal(s.prefs.relay.poolKey, POOL_B);
  assert.deepEqual(s.prefs.relayBy[POOL_A].pending.map((p) => p.outpoint), [`${txA}:0`], "A's pending top-up waits, untouched");

  s.relayInfo = info(POOL_A);
  R.setRelayRoute(s.relayInfo);
  assert.deepEqual(s.relayPrefs.pending.map((p) => p.outpoint), [`${txA}:0`]);
  assert.equal(s.depositIndex, 1);
  // A record from before this fix (no poolKey) belongs to the relayer in use.
  const old = offlineSession();
  old.relayInfo = info(POOL_B);
  old.prefs.relay = { depositIndex: 2, pending: [] };
  assert.equal(old.depositIndex, 2);
  R.setRelayRoute(null);
});

/* ---------- V2-22 ---------- */

test("V2-22: two tabs sending at once never reserve the same notes", { timeout: 300_000 }, async (t) => {
  reset();
  const { randomBytes } = await import("node:crypto");
  const { Indexer, assetIdOf } = await import("../src/indexer.mjs");
  const { Wallet } = await import("../src/wallet.mjs");
  const { deriveKeys, encodeAddress } = await import("../src/keys.mjs");
  const { encodeDeploy, opReturnScript } = await import("../src/envelope.mjs");
  const { createApp } = await import("../server/indexer-server.mjs");

  const START = 900000;
  const h32 = () => randomBytes(32).toString("hex");
  const idx = new Indexer({ vkey: JSON.parse(readFileSync("build/dev/verification_key.json", "utf8")), startHeight: START, genesis: null });
  const mine = (txs = []) => idx.applyBlock({ height: idx.height + 1, hash: h32(), txs: [{ txid: h32(), inputs: [], outputs: [] }, ...txs] });
  const carrierOf = (payload, first = randomBytes(36)) => ({ txid: h32(), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(payload), value: 0n }] });

  // One wallet, unlocked in two tabs over the same stored vault.
  const phrase = S.newPhrase();
  const { vault, key } = await keystore.createVault(phrase, PW);
  keystore.writeVault(S.storage, STORAGE_PREFIX, vault);
  const tab = () => new S.Session({ phrase, key: key.slice(), vault: JSON.parse(JSON.stringify(vault)) });
  const a = tab();
  const b = tab();
  const bob = new Wallet(deriveKeys(randomBytes(32)));
  const minter = new Wallet(a.keys);
  await mine([carrierOf(encodeDeploy({ ticker: "TAB", divisibility: 0, mintAmount: 500n, mintCap: 10, priceSats: 0n, treasury: new Uint8Array() }))]);
  const ASSET = assetIdOf(START, 1);
  for (let i = 0; i < 2; i++) {
    const bind = randomBytes(36);
    await mine([carrierOf(await minter.mint(idx, { asset: ASSET, mintAmount: 500n, bindOutpoint: bind }), bind)]);
  }
  await mine([]);
  const app = createApp({ idx, log: { warn() {}, error() {}, log() {} } });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const nav = globalThis.navigator;
  t.after(async () => {
    if (nav) delete nav.locks;
    api.setIndexerBase("");
    S.storage.removeItem(VAULT);
    await new Promise((r) => app.server.close(r));
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  });
  api.setIndexerBase(`http://127.0.0.1:${app.server.address().port}`);
  await a.sync();
  await b.sync();
  assert.equal(a.available(ASSET), 1000n);
  const to = encodeAddress(bob.address);
  const storedSends = async () => (await keystore.unlockVault(JSON.parse(S.storage.getItem(VAULT)), PW)).data.history.filter((h) => h.kind === "send");

  // No Web Locks (a browser without them; Node 24.5+ has its own, hidden here): both tabs pick
  // the same note and prove; the second to record is refused. Each tab waits at the proof until both have selected, so a slow machine cannot let one tab
  // record before the other selects (it would then select around it, which is also safe).
  if (nav) Object.defineProperty(nav, "locks", { configurable: true, value: undefined });
  let arrived = 0, release;
  const bothSelected = new Promise((r) => (release = r));
  for (const s of [a, b]) {
    const transfer = s.wallet.transfer;
    s.wallet.transfer = async (...args) => {
      if (++arrived === 2) release();
      await bothSelected;
      return transfer.apply(s.wallet, args);
    };
  }
  const asset = a.asset("TAB");
  const race = await Promise.allSettled([a.send({ asset, amount: 120n, to, via: "copy" }), b.send({ asset, amount: 120n, to, via: "copy" })]);
  delete a.wallet.transfer;
  delete b.wallet.transfer;
  assert.deepEqual(race.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const lost = race.find((r) => r.status === "rejected").reason;
  assert.equal(lost.code, "notes_taken", lost.message);
  assert.equal(lost.message, S.NOTES_TAKEN);
  let sends = await storedSends();
  assert.equal(sends.length, 1, "one reservation is stored");

  // With Web Locks the second tab waits, then selects around the first tab's reservation.
  const queue = new Map();
  Object.defineProperty(nav, "locks", {
    configurable: true,
    value: {
      request(name, fn) {
        const run = (queue.get(name) ?? Promise.resolve()).then(() => fn());
        queue.set(name, run.catch(() => {}));
        return run;
      },
    },
  });
  const both = await Promise.allSettled([a.send({ asset, amount: 120n, to, via: "copy" }), b.send({ asset, amount: 120n, to, via: "copy" })]);
  assert.deepEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  assert.notEqual(both.find((r) => r.status === "rejected").reason.code, "notes_taken", "refused at selection: nothing was proved twice");
  sends = await storedSends();
  assert.equal(sends.length, 2);
  const spent = sends.flatMap((h) => h.spends.map(String));
  assert.equal(new Set(spent).size, spent.length, "no note is reserved twice");
});

/* ---------- V2-23 / V2-24 ---------- */

test("V2-23: Lock now in one tab locks the others; an idle lock stays per tab", async () => {
  reset();
  await S.createWallet(S.newPhrase(), PW);
  const before = S.storage.getItem(LOCK_ALL);
  S.lock("idle");
  assert.equal(S.storage.getItem(LOCK_ALL), before, "an idle lock is not broadcast");
  await S.unlock(PW);
  S.lock("manual");
  const sent = S.storage.getItem(LOCK_ALL);
  assert.ok(sent && sent !== before, "a manual lock writes a fresh value the other tabs see");

  // The other tab's side: the storage event for that key locks it.
  await S.unlock(PW);
  assert.ok(S.currentSession());
  S.onOtherTab({ key: LOCK_ALL, newValue: `${Date.now()}.x` });
  assert.equal(S.currentSession(), null);
  reset();
});

test("V2-24: streamer mode set in another tab masks this one at once", (t) => {
  const own = globalThis.document === undefined;
  if (own) globalThis.document = { documentElement: { dataset: {} } };
  const seen = [];
  const off = S.onStreamerChange((on) => seen.push(on));
  t.after(() => {
    off();
    S.storage.removeItem(STREAMER);
    if (own) delete globalThis.document;
  });
  S.storage.setItem(STREAMER, "1"); // written by the other tab
  S.onOtherTab({ key: STREAMER, newValue: "1" });
  assert.deepEqual(seen, [true]);
  assert.equal(document.documentElement.dataset.streamer, "on");
  S.storage.setItem(STREAMER, "0");
  S.onOtherTab({ key: null }); // storage cleared or bulk change
  assert.deepEqual(seen, [true, false]);
  assert.equal(document.documentElement.dataset.streamer, "off");
  // The header button (app.js, also on pages without the wallet) repaints on the same event.
  const shell = readFileSync("web/src/app.js", "utf8");
  assert.match(shell, /if \(e\.key === STREAMER_KEY \|\| e\.key === null\) paintStreamerButton\(\);/);
});

/* ---------- V2-25 ---------- */

test("V2-25: a Unisat payment is refused once Unisat left signet, before anything is sent", async () => {
  globalThis.window = { unisat: new MockUnisat() };
  const payer = await new UnisatPayer().connect();
  assert.equal(window.unisat.chain, "BITCOIN_SIGNET");
  let calls = 0;
  const send = window.unisat.sendBitcoin.bind(window.unisat);
  window.unisat.sendBitcoin = (...a) => (calls++, send(...a));
  await payer.pay({ to: window.unisat.address, amount: 3000 });
  assert.equal(calls, 1);
  window.unisat.chain = "BITCOIN_TESTNET4"; // same tb1 address there
  await assert.rejects(payer.pay({ to: window.unisat.address, amount: 3000 }), /no longer on Bitcoin Signet/);
  await assert.rejects(payer.carry({ envelope: new Uint8Array(8), outputs: [] }), /Nothing was paid/);
  assert.equal(calls, 1, "sendBitcoin was never called on testnet4");
  delete globalThis.window;
});

/* ---------- V2-27 ---------- */

test("V2-27: the recovery words hide when the window or tab loses focus mid-press", () => {
  const target = () => {
    const fns = new Map();
    return {
      fns,
      addEventListener: (t, f) => fns.set(t, [...(fns.get(t) ?? []), f]),
      removeEventListener: (t, f) => fns.set(t, (fns.get(t) ?? []).filter((x) => x !== f)),
      fire: (t, ev = {}) => (fns.get(t) ?? []).forEach((f) => f({ preventDefault() {}, ...ev })),
    };
  };
  const cls = new Set(["is-hidden"]);
  const wrap = { classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } };
  const hold = target();
  const win = target();
  const doc = Object.assign(target(), { hidden: false });
  const off = wireHold(wrap, hold, { win, doc });
  const press = () => (hold.fire("pointerdown"), assert.equal(cls.has("is-hidden"), false, "shown while pressed"));
  press();
  win.fire("blur"); // Alt-Tab: no pointerup ever reaches the page
  assert.equal(cls.has("is-hidden"), true);
  press();
  doc.hidden = true;
  doc.fire("visibilitychange");
  assert.equal(cls.has("is-hidden"), true);
  doc.hidden = false;
  press();
  win.fire("pointerup"); // a release anywhere
  assert.equal(cls.has("is-hidden"), true);
  hold.fire("keydown", { key: " " });
  win.fire("blur");
  assert.equal(cls.has("is-hidden"), true, "keyboard press too");
  off();
  assert.deepEqual([...win.fns.values(), ...doc.fns.values()].flat(), [], "closing the sheet removes the listeners");
});

/* ---------- V2-31 ---------- */

test("V2-31: a root rebuilt from the indexer's own commitments is IDX, and the copy says what it shows", async (t) => {
  const match = { state: "match", root: "ab".repeat(32), localRoot: "ab".repeat(32), commitments: 14, height: 324600 };
  const chip = String(rootChip(match));
  assert.match(chip, /data-prov="IDX"/);
  assert.doesNotMatch(chip, /data-prov="YOU"/);
  const details = String(rootDetails(match));
  assert.doesNotMatch(details, /data-prov="YOU"/);
  assert.ok(details.includes(String(prov("IDX", { tip: REBUILD_TIP }))));
  assert.match(rootSentence(match), /its list and its root agree\. Only Verify the Pool checks them against Bitcoin\./);
  assert.match(REBUILD_TIP, /Verify the Pool/);
  assert.doesNotMatch(String(prov("IDX", { tip: REBUILD_TIP })), /hasn't checked/);

  // The receipt's anchor root: rebuilt and matching is IDX; a mismatch is still caught as YOU.
  const { rootOfLeaves } = await import("../web/src/verify/rebuild.js");
  const rows = [["5", 1001], ["7", 1050]];
  const rootAt = (h) => rootOfLeaves(rows.filter(([, x]) => x <= h).map(([c]) => c)).toString();
  let wrong = false;
  const realFetch = globalThis.fetch;
  t.after(() => (globalThis.fetch = realFetch));
  globalThis.fetch = async (url) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/api/state") return json({ startHeight: 1000, height: 1150, outputs: rows.length, root: rootAt(1150) });
    if (u.pathname === "/api/commitments") return json(rows);
    if (u.pathname === "/api/roots") {
      const out = [];
      for (let h = Math.max(999, Number(u.searchParams.get("from"))); h <= Math.min(1150, Number(u.searchParams.get("to"))); h++) out.push([h, wrong ? "123" : rootAt(h)]);
      return json(out);
    }
    return new Response("{}", { status: 404 });
  };
  const { anchorRoot } = await import("../web/src/verify/engine.js");
  const { rootsAll } = await import("../web/src/verify/pool-data.js");
  const ok = await anchorRoot(1100);
  assert.deepEqual([ok.source, ok.kind, ok.root, Boolean(ok.mismatch)], ["IDX", "rebuild", rootAt(1100), false]);
  wrong = true;
  await rootsAll({ fresh: true });
  const bad = await anchorRoot(1100);
  assert.deepEqual([bad.source, bad.mismatch], ["YOU", true]);

  // The wallet's state line and the landing copy.
  const portfolio = readFileSync("web/src/views/app-portfolio.js", "utf8");
  assert.doesNotMatch(portfolio, /State verified/);
  assert.match(portfolio, /Indexer consistent: root matches at/);
  const landing = readFileSync("web/src/views/landing.js", "utf8");
  assert.match(landing, /Verify the Pool catches a wrong state/);
  assert.doesNotMatch(landing, /notesVerified\(\) \? "YOU"/);
  const security = readFileSync("web/src/views/security.js", "utf8");
  assert.match(security, /Without a replay, the anchor root comes from our indexer/);
});

/* ---------- V2-32 ---------- */

test("V2-32: a saved replay's root is used only while its block is still the chain's", async () => {
  const replay = { roots: new Map([[100, "55"], [99, "44"]]), hashes: new Map([[100, "aa".repeat(32)]]) };
  const at = (hash) => async () => hash;
  assert.equal(await replayRootAt(100, { replay, blockHash: at("aa".repeat(32)) }), "55");
  assert.equal(await replayRootAt(100, { replay, blockHash: at("bb".repeat(32)) }), null, "reorged since the replay");
  assert.equal(await replayRootAt(100, { replay, blockHash: async () => Promise.reject(new Error("offline")) }), null, "unconfirmed: next source");
  assert.equal(await replayRootAt(99, { replay, blockHash: at("aa".repeat(32)) }), null, "no saved block hash");
  assert.equal(await replayRootAt(101, { replay, blockHash: at("aa".repeat(32)) }), null, "not replayed");
});

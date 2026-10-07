// Wallet-core review fixes: a failed retry never drops a handed-out send (W-1);
// two unlocked tabs merge the vault instead of overwriting it; Unisat never pays
// from an account other than the connected one; the zkpool-era payer choice
// survives migration; create/import never bypass the plaintext-wallet migration.
import { test } from "node:test";
import assert from "node:assert/strict";

// session.js registers a "storage" listener in browsers; capture it here.
const storageListeners = [];
globalThis.addEventListener ??= (type, fn) => {
  if (type === "storage") storageListeners.push(fn);
};

const keystore = await import("../web/src/keystore.js");
const api = await import("../web/src/api.js");
const { STORAGE_PREFIX } = await import("../web/src/config.js");
const S = await import("../web/src/session.js");
const { UnisatPayer, RelayPayer } = await import("../web/src/payers.js");
const { MockUnisat } = await import("./mock-unisat.mjs");
const { OP, encodeTxBody } = await import("../src/envelope.mjs");
const { scriptOf } = await import("../src/btc/funding.mjs");
const { hex } = await import("../src/bytes.mjs");

const PW = "correct horse battery";
const VAULT = keystore.vaultKey(STORAGE_PREFIX);
const PAYER = keystore.payerKey(STORAGE_PREFIX);
// A neutral signet P2TR address: the key-path address of the dummy key new Uint8Array(32).fill(1).
const TREASURY = "tb1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8snwrkwy";

function reset() {
  S.lock();
  for (const k of [VAULT, PAYER, ...Object.values(keystore.LEGACY_KEYS)]) S.storage.removeItem(k);
}

/** A second tab: its own session over the vault as stored right now. */
async function otherTab(password = PW) {
  const vault = JSON.parse(S.storage.getItem(VAULT));
  const { phrase, key, data } = await keystore.unlockVault(vault, password);
  return new S.Session({ phrase, key, data, vault });
}

const storedHistory = async (password = PW) => (await keystore.unlockVault(keystore.readVault(S.storage, STORAGE_PREFIX), password)).data.history;
const fireStorage = () => storageListeners.forEach((fn) => fn({ key: VAULT }));

/** A structurally valid TRANSACT envelope (proof bytes are not checked client-side). */
function transact(anchor) {
  const body = encodeTxBody({
    op: OP.TRANSACT, anchor, publicAmount: 0n, nullifiers: [11n, 12n], commitments: [21n, 22n],
    ciphertexts: [new Uint8Array(95).fill(1), new Uint8Array(95).fill(2)],
  });
  const env = new Uint8Array(body.length + 128);
  env.set(body);
  return env;
}

/** A session that never touches the network: artifacts and sync are stubbed. */
function offlineSession() {
  const s = new S.Session({ phrase: S.newPhrase() });
  s.wallet.artifacts = {};
  s.sync = async () => {};
  s.view = { height: 200, nullifiers: new Set(), outputs: [] };
  return s;
}

/** A send that already left the browser once and failed (e.g. a timed-out relay submit). */
function failedSend(s, extra = {}) {
  const entry = {
    id: "e1", kind: "send", via: "relay", mode: "block", ticker: "T", assetId: "7", amount: "5", div: 0, to: "x",
    spends: ["11", "12"], commitments: ["21", "22"], anchor: 150, envelope: hex(transact(150)), status: "failed", relayId: null, txid: null, ...extra,
  };
  s.history.unshift(entry);
  return entry;
}

/* ---------- finding 1 ---------- */

test("finding 1: a retry that fails before anything leaves keeps the entry and its notes locked", async (t) => {
  reset();
  // "Retry with the same notes" while the relayer is unreachable: info() throws before submit.
  const s = offlineSession();
  s.relayPayer = new RelayPayer({
    client: { info: async () => Promise.reject(Object.assign(new Error("offline"), { name: "ApiError", status: 0 })) },
    workers: false,
  });
  const e = failedSend(s, { relayId: "r-old" });
  await assert.rejects(s.retry(e, { via: "relay" }));
  assert.ok(s.history.includes(e), "the entry stays in history");
  assert.equal(e.status, "failed");
  assert.deepEqual([...S.lockedNullifiers(s.history, 200, new Set())], ["11", "12"], "its notes stay reserved");

  // "Pay the fee myself" with an empty built-in key: planning fails before the broadcast.
  const esplora = api.esplora;
  esplora.feeRate = async () => 1;
  esplora.utxos = async () => [];
  t.after(() => {
    delete esplora.feeRate;
    delete esplora.utxos;
  });
  const s2 = offlineSession();
  const e2 = failedSend(s2);
  await assert.rejects(s2.retry(e2, { via: "self" }), /not enough BTC/);
  assert.ok(s2.history.includes(e2));
  assert.equal(e2.status, "failed");
  assert.equal(e2.retries, 1);
  assert.deepEqual([...S.lockedNullifiers(s2.history, 200, new Set())], ["11", "12"]);
});

/* ---------- finding 2 ---------- */

test("finding 2: two unlocked tabs merge history; a drop sticks; a later hand-out marker wins", async () => {
  reset();
  const a = await S.createWallet(S.newPhrase(), PW); // tab A (the module session)
  const b = await otherTab(); // tab B, unlocked before A's send

  const e = a.record({ kind: "send", via: "relay", spends: ["101"], commitments: ["201"], anchor: 100, status: "relaying" });
  b.persist(); // B writes (a status change) from a history that lacks E
  assert.ok((await storedHistory()).some((h) => h.id === e.id), "A's entry survives B's write");
  assert.ok(b.history.some((h) => h.id === e.id), "B now has it too");
  assert.deepEqual([...S.lockedNullifiers(b.history, 120, new Set())], ["101"], "so B reserves its notes");

  // B records a send; A sets E's relay id; B's older copy of E takes A's marker.
  const f = b.record({ kind: "send", via: "relay", spends: ["102"], anchor: 100, status: "relaying" });
  a.update(e, { relayId: "r1" });
  assert.ok(a.history.some((h) => h.id === f.id), "A picked up B's send before writing");
  b.persist();
  assert.equal(b.history.find((h) => h.id === e.id).relayId, "r1");
  assert.equal((await storedHistory()).find((h) => h.id === e.id).relayId, "r1");

  // An entry A drops (nothing left the browser) does not come back through B.
  const g = a.record({ kind: "send", via: "relay", spends: ["103"], anchor: 100, status: "relaying" });
  b.persist();
  assert.ok(b.history.some((h) => h.id === g.id));
  a.history = a.history.filter((h) => h !== g);
  a.persist();
  b.persist();
  a.persist();
  assert.ok(!b.history.some((h) => h.id === g.id) && !(await storedHistory()).some((h) => h.id === g.id), "the drop sticks");
  assert.deepEqual((await storedHistory()).map((h) => h.id).sort(), [e.id, f.id].sort());

  // The storage event folds B's next send into A right away, locks included.
  a.view = { height: 120, nullifiers: new Set(), outputs: [] };
  const h = b.record({ kind: "send", via: "relay", spends: ["104"], anchor: 100, status: "relaying" });
  assert.ok(storageListeners.length, "session.js listens for other tabs' writes");
  fireStorage();
  assert.ok(a.history.some((x) => x.id === h.id));
  assert.ok(a.wallet.locked.has("104"));
});

test("finding 2: a password change or removal in one tab is never undone by another", async () => {
  reset();
  const NEW = "a brand new password";
  const a = await S.createWallet(S.newPhrase(), PW);
  const e = a.record({ kind: "send", via: "relay", spends: ["1"], anchor: 100, status: "relaying" });
  const b = await otherTab();

  await S.changePassword(PW, NEW);
  assert.throws(() => b.persist(), /changed in another tab/);
  assert.equal(b.closed, true, "the stale tab locked itself");
  await assert.rejects(keystore.unlockVault(keystore.readVault(S.storage, STORAGE_PREFIX), PW), keystore.WrongPassword);
  assert.ok((await storedHistory(NEW)).some((h) => h.id === e.id));
  a.persist(); // the tab that changed it keeps working

  // A write from another tab during the key derivation aborts the change instead of being lost.
  const c = await otherTab(NEW);
  const pending = S.changePassword(NEW, "yet another password");
  const late = c.record({ kind: "send", via: "relay", spends: ["2"], anchor: 100, status: "relaying" });
  await assert.rejects(pending, /changed in another tab meanwhile/);
  assert.ok((await storedHistory(NEW)).some((h) => h.id === late.id), "the other tab's send is kept, old password still valid");

  // Removing the wallet in one tab: another tab's next write must not bring it back.
  const d = await otherTab(NEW);
  S.forgetWallet();
  assert.throws(() => d.persist(), /changed in another tab/);
  assert.equal(S.storage.getItem(VAULT), null, "the removed wallet stays removed");
  assert.throws(() => d.record({ kind: "send" }), /locked/, "a locked tab can't record, so it can't hand anything out");

  // The storage event locks the unlocked tab when the vault disappears under it.
  await S.createWallet(S.newPhrase(), PW);
  S.storage.removeItem(VAULT);
  fireStorage();
  assert.equal(S.currentSession(), null);
});

test("finding 2: creating a wallet never overwrites one that already exists", async () => {
  reset();
  await S.createWallet(S.newPhrase(), PW);
  const before = S.storage.getItem(VAULT);
  await assert.rejects(S.createWallet(S.newPhrase(), PW), /already has a wallet/);
  assert.equal(S.storage.getItem(VAULT), before);
});

test("finding 2: this tab's own writes during a password change don't abort it", async () => {
  reset();
  const NEW = "a brand new password";
  const a = await S.createWallet(S.newPhrase(), PW);
  const salt = JSON.parse(S.storage.getItem(VAULT)).kdf.salt;
  const writes = [];
  const setItem = S.storage.setItem;
  S.storage.setItem = (k, v) => {
    if (k === VAULT) writes.push(v);
    return setItem.call(S.storage, k, v);
  };
  try {
    // A send this tab hands out while the new key is being derived.
    const pending = S.changePassword(PW, NEW);
    const own = a.record({ kind: "send", via: "relay", spends: ["5"], anchor: 100, status: "relaying" });
    await pending;
    assert.ok((await storedHistory(NEW)).some((h) => h.id === own.id), "the change went through and kept the send");
    // The first write under the new password already holds it, so no crash window loses it.
    const first = writes.find((raw) => JSON.parse(raw).kdf.salt !== salt);
    const { data } = await keystore.unlockVault(JSON.parse(first), NEW);
    assert.ok(data.history.some((h) => h.id === own.id));

    // Another tab's write that this tab folded in (storage event) doesn't abort it either.
    const c = await otherTab(NEW);
    const NEXT = "yet another password";
    const pending2 = S.changePassword(NEW, NEXT);
    const late = c.record({ kind: "send", via: "relay", spends: ["6"], anchor: 100, status: "relaying" });
    fireStorage();
    await pending2;
    const ids = (await storedHistory(NEXT)).map((h) => h.id);
    assert.ok(ids.includes(late.id) && ids.includes(own.id));
  } finally {
    S.storage.setItem = setItem;
    reset();
  }
});

/* ---------- finding 5 ---------- */

test("finding 5: Unisat never pays from an account other than the connected one", async () => {
  reset();
  const u = new MockUnisat();
  const handlers = {};
  u.on = (ev, fn) => (handlers[ev] = fn);
  globalThis.window = { unisat: u };
  const other = new MockUnisat().address;

  const payer = await new UnisatPayer().connect();
  u.getAccounts = async () => [other];
  await assert.rejects(payer.carry({ envelope: new Uint8Array(8), outputs: [{ script: scriptOf(TREASURY), amount: 1000n }], feeRate: 1 }), /no longer on the account you connected/);
  assert.equal(u.sent.length, 0, "nothing was paid");

  // A mint refuses before proving: the binding would point at the old account.
  const s = offlineSession();
  u.getAccounts = async () => [u.address];
  await s.connectUnisat();
  assert.equal(s.ownPayer(), s.unisat);
  u.getAccounts = async () => [other];
  const asset = { id: "7", ticker: "T", status: "live", mintAmount: "1", priceSats: "1000", treasury: hex(scriptOf(TREASURY)), divisibility: 0 };
  await assert.rejects(s.mint(asset), /no longer on the account you connected/);
  assert.equal(u.sent.length, 0);

  // Unisat's accountsChanged event drops the connection, so the views ask to connect again.
  handlers.accountsChanged([other]);
  assert.equal(s.unisat, null);
  assert.throws(() => s.ownPayer(), /not connected/);
  reset();
});

test("finding 5: the accountsChanged listener goes with the connection and the session", async () => {
  reset();
  const u = new MockUnisat();
  const subs = new Set();
  u.on = (ev, fn) => ev === "accountsChanged" && subs.add(fn);
  u.removeListener = (ev, fn) => subs.delete(fn);
  globalThis.window = { unisat: u };
  const other = new MockUnisat().address;
  let payerEvents = 0;
  const off = S.onSessionChange((type) => type === "payer" && payerEvents++);
  try {
    const a = await S.createWallet(S.newPhrase(), PW);
    await a.connectUnisat();
    await a.connectUnisat();
    assert.equal(subs.size, 1, "connecting again replaces the listener");
    S.lock();
    assert.equal(subs.size, 0, "locking removes it, so the dead session isn't kept alive");
    assert.equal(a.unisat, null);

    const b = await S.unlock(PW);
    await b.connectUnisat();
    payerEvents = 0;
    for (const fn of [...subs]) fn([other]);
    assert.equal(b.unisat, null);
    assert.equal(payerEvents, 1);
    assert.equal(subs.size, 0, "a dropped connection stops listening");

    // Locked while the Unisat popup was open: no listener is left behind.
    let release;
    const asked = new Promise((ok) => {
      u.requestAccounts = () => new Promise((r) => ((release = () => r([u.address])), ok()));
    });
    const pending = b.connectUnisat();
    await asked;
    S.lock();
    release();
    await assert.rejects(pending, /locked/);
    assert.equal(subs.size, 0);
    assert.equal(b.unisat, null);
  } finally {
    off();
    delete globalThis.window;
    reset();
  }
});

/* ---------- finding 9 ---------- */

test("finding 9: the zkpool-era payer choice is still in effect after migration", async () => {
  reset();
  S.storage.setItem(keystore.LEGACY_KEYS.phrase, JSON.stringify(S.newPhrase()));
  S.storage.setItem(keystore.LEGACY_KEYS.payer, "unisat"); // a bare string, not JSON
  const s = await S.migrateWallet(PW);
  assert.equal(s.payerPref, "unisat");
  assert.equal(S.storage.getItem(PAYER), "unisat");
  assert.equal(S.storage.getItem(keystore.LEGACY_KEYS.payer), null);

  // A wallet migrated by an earlier build has the choice only in its vault prefs.
  reset();
  const old = new S.Session({ phrase: S.newPhrase(), data: { prefs: { payer: "unisat" } } });
  assert.equal(old.payerPref, "unisat");
  old.payerPref = "local";
  assert.equal(old.payerPref, "local", "a later explicit choice wins");
  reset();
});

/* ---------- finding 10 ---------- */

test("finding 10: create and import never bypass the plaintext-wallet migration", async () => {
  reset();
  const legacy = S.newPhrase();
  S.storage.setItem(keystore.LEGACY_KEYS.phrase, JSON.stringify(legacy));
  await assert.rejects(S.createWallet(S.newPhrase(), PW), /isn't encrypted/);
  assert.equal(S.hasVault(), false, "no vault was written");
  assert.equal(keystore.legacyPhrase(S.storage), legacy, "the old wallet is still there to migrate");

  const views = [await import("../web/src/views/app-create.js"), await import("../web/src/views/app-import.js")];
  for (const view of views) {
    const root = { innerHTML: "" };
    view.render(root);
    const out = String(root.innerHTML);
    assert.match(out, /Protect your current wallet first/);
    assert.match(out, /href="\/app"/);
    assert.doesNotMatch(out, /Recovery phrase|Continue/, "no create or restore form");
  }
  reset();
});

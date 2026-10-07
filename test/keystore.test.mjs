// Locked Vault: scrypt + XChaCha20-Poly1305 vault v1 with a
// sealed data field, password changes, strength hints and the one-time migration
// of the zkpool-era plaintext wallet.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createVault, unlockVault, changePassword, seal, open, sealData, openData, withData, WrongPassword, MIN_PASSWORD,
  passwordStrength, migrateLegacy, readVault, writeVault, vaultKey, LEGACY_KEYS, emptyData,
} from "../web/src/keystore.js";

// Public dummies: the first 24 words of the BIP-39 English list (no valid checksum, not a
// real recovery phrase) and a well-known example password.
const PHRASE = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";
const PW = "correct horse battery";
const PREFIX = "murkle.signet";

/** Map-backed stand-in for localStorage. */
function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

test("vault round-trips the phrase and stores no plaintext", async () => {
  const { vault } = await createVault(PHRASE, PW);
  const stored = JSON.stringify(vault);
  assert.ok(!stored.includes("abandon"), "phrase must not appear in storage");
  assert.equal(vault.v, 1);
  assert.deepEqual(Object.keys(vault).sort(), ["data", "kdf", "phrase", "v"]);
  const { phrase, data } = await unlockVault(JSON.parse(stored), PW);
  assert.equal(phrase, PHRASE);
  assert.deepEqual(data, emptyData());
});

test("wrong password is rejected with WrongPassword ('Wrong password')", async () => {
  const { vault } = await createVault(PHRASE, PW);
  await assert.rejects(unlockVault(vault, `${PW}!`), (e) => e instanceof WrongPassword && e.message === "Wrong password");
});

test("short passwords are refused", async () => {
  await assert.rejects(createVault(PHRASE, "x".repeat(MIN_PASSWORD - 1)), /at least 8/);
});

test("each vault uses a fresh salt and nonce", async () => {
  const a = (await createVault(PHRASE, PW)).vault;
  const b = (await createVault(PHRASE, PW)).vault;
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.phrase.ct, b.phrase.ct);
});

test("sealData round-trips history and prefs; every seal uses a new nonce", async () => {
  const { vault, key } = await createVault(PHRASE, PW);
  const data = { history: [{ txid: "ab".repeat(32), kind: "send", amount: "200", to: "mrk1qqq" }], gifts: [], prefs: { autoLockMin: 5 } };
  const next = withData(vault, key, data);
  assert.deepEqual(openData(key, next), data);
  const again = withData(vault, key, data);
  assert.notEqual(next.data.nonce, again.data.nonce);
  const stored = JSON.stringify(next);
  assert.ok(!stored.includes("mrk1") && !stored.includes("send"), "history is not readable in storage");
  // The phrase field is untouched by a data update, and the password still opens both.
  assert.deepEqual(next.phrase, vault.phrase);
  const opened = await unlockVault(next, PW);
  assert.deepEqual(opened.data, data);
  assert.deepEqual(open(key, sealData(key, [1, 2, 3])), [1, 2, 3]);
});

test("a tampered vault fails to open: phrase blob, data blob or nonce", async () => {
  const { vault, key } = await createVault(PHRASE, PW);
  const flip = (hex) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
  await assert.rejects(unlockVault({ ...vault, phrase: { ...vault.phrase, ct: flip(vault.phrase.ct) } }, PW), WrongPassword);
  await assert.rejects(unlockVault({ ...vault, data: { ...vault.data, ct: flip(vault.data.ct) } }, PW), WrongPassword);
  assert.throws(() => openData(key, { ...vault, data: { ...vault.data, nonce: flip(vault.data.nonce) } }), WrongPassword);
  const history = [{ txid: "ab".repeat(32) }];
  const sealed = seal(key, history);
  assert.throws(() => open(key, { ...sealed, ct: flip(sealed.ct) }), WrongPassword);
  await assert.rejects(unlockVault({ ...vault, v: 2 }, PW), /format/);
});

test("changing the password keeps the phrase and the data, and invalidates the old password", async () => {
  const data = { history: [{ txid: "cd".repeat(32), kind: "mint" }], gifts: [], prefs: {} };
  const { vault } = await createVault(PHRASE, PW, data);
  const { vault: next } = await changePassword(vault, PW, "new strong password");
  const opened = await unlockVault(next, "new strong password");
  assert.equal(opened.phrase, PHRASE);
  assert.deepEqual(opened.data, data);
  await assert.rejects(unlockVault(next, PW), WrongPassword);
  await assert.rejects(changePassword(vault, "not the password", "another one!"), WrongPassword);
});

test("password strength: length and character classes, never a guarantee", () => {
  assert.equal(passwordStrength("").score, 0);
  assert.equal(passwordStrength("short").score, 0);
  assert.equal(passwordStrength("aaaaaaaaaaaaaaaaaaaaaaaa").score, 1, "one repeated character is weak at any length");
  assert.equal(passwordStrength("123456789012345678").score, 1, "digits only is weak");
  assert.equal(passwordStrength("abcdefgh").score, 1);
  assert.ok(passwordStrength("Tr0ub4dor&3xyz").score >= 3);
  assert.equal(passwordStrength("correct horse battery staple").score, 4);
  for (const p of ["", "abcdefgh", "Tr0ub4dor&3xyz"]) {
    const s = passwordStrength(p);
    assert.ok(s.label && s.hint && !/%/.test(s.hint));
  }
});

test("migration: plaintext zkpool wallet -> verified vault, then the plaintext keys are gone", async () => {
  const history = [{ txid: "ef".repeat(32), kind: "send", status: "accepted", to: "zp1abc", amount: "5" }];
  const st = memStorage({
    [LEGACY_KEYS.phrase]: JSON.stringify(PHRASE),
    [LEGACY_KEYS.history]: JSON.stringify(history),
    [LEGACY_KEYS.payer]: JSON.stringify("local"),
    unrelated: "keep me",
  });
  const out = await migrateLegacy(st, PW, { prefix: PREFIX });
  assert.equal(out.phrase, PHRASE);
  assert.equal(out.data.history.length, 1);
  assert.equal(out.data.history[0].era, "legacy", "old entries are kept and marked");
  assert.equal(st.getItem(`${PREFIX}.payer`), "local", "the payer choice moves to its plain key, where the session reads it");
  assert.equal(out.data.prefs.payer, undefined);
  for (const k of Object.values(LEGACY_KEYS)) assert.equal(st.getItem(k), null, `${k} deleted`);
  assert.equal(st.getItem("unrelated"), "keep me");
  // Nothing in storage holds the phrase or the history in plaintext.
  const dump = [...st.m.values()].join("\n");
  assert.ok(!dump.includes("abandon") && !dump.includes("zp1abc"), "no BIP-39 words or recipients left in storage");
  const opened = await unlockVault(readVault(st, PREFIX), PW);
  assert.equal(opened.phrase, PHRASE);
  assert.deepEqual(opened.data.history.map((h) => h.txid), history.map((h) => h.txid));
});

test("migration never leaves both copies and never destroys the only copy", async () => {
  // A vault already exists: refuse instead of overwriting it.
  const { vault } = await createVault(PHRASE, PW);
  const both = memStorage({ [LEGACY_KEYS.phrase]: JSON.stringify(PHRASE) });
  writeVault(both, PREFIX, vault);
  await assert.rejects(migrateLegacy(both, PW, { prefix: PREFIX }), /already exists/);
  assert.notEqual(both.getItem(LEGACY_KEYS.phrase), null);

  // The read-back check fails (storage corrupts the write): the plaintext stays, the bad vault goes.
  const broken = memStorage({ [LEGACY_KEYS.phrase]: JSON.stringify(PHRASE) });
  const setItem = broken.setItem;
  broken.setItem = (k, v) => setItem(k, k === vaultKey(PREFIX) ? v.replace(/"ct":"(.)/, (m, c) => `"ct":"${c === "0" ? "1" : "0"}`) : v);
  await assert.rejects(migrateLegacy(broken, PW, { prefix: PREFIX }), /didn't verify/);
  assert.equal(JSON.parse(broken.getItem(LEGACY_KEYS.phrase)), PHRASE, "plaintext copy kept for a retry");
  assert.equal(broken.getItem(vaultKey(PREFIX)), null, "half-written vault removed");

  // Too-short password: nothing changes.
  const st = memStorage({ [LEGACY_KEYS.phrase]: JSON.stringify(PHRASE) });
  await assert.rejects(migrateLegacy(st, "short", { prefix: PREFIX }), /at least/);
  assert.notEqual(st.getItem(LEGACY_KEYS.phrase), null);
  assert.equal(st.getItem(vaultKey(PREFIX)), null);

  await assert.rejects(migrateLegacy(memStorage(), PW, { prefix: PREFIX }), /No unprotected wallet/);
});

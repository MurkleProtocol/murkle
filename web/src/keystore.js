// Password-protected wallet storage (the "Locked Vault"). The
// recovery phrase and the wallet's private data (history, prefs) are sealed with
// XChaCha20-Poly1305 under a key derived from the password with scrypt, so
// browser storage reveals nothing without the password. The derived key lives
// only in memory while the wallet is unlocked.
//
// Vault format v1, stored as JSON under `${STORAGE_PREFIX}.vault`:
//   { v: 1, kdf: { name, N, r, p, salt }, phrase: seal(key, phrase), data: seal(key, { history, gifts, prefs }) }
// The KDF parameters travel with the blob, so they can be raised later without
// breaking old vaults. Every seal uses a fresh 24-byte nonce.
//
// No DOM dependency: storage is passed in (anything with getItem/setItem/removeItem),
// so the migration runs under node:test against a Map-backed stand-in.
import { scryptAsync } from "@noble/hashes/scrypt";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { hex, unhex, randomBytes } from "../../src/bytes.mjs";
import { NETWORK } from "../../src/params.mjs";

export const MIN_PASSWORD = 8;
// ~64 MiB, ~0.5-1 s in a browser: costly to brute-force, still fine on phones.
export const KDF = { name: "scrypt", N: 2 ** 16, r: 8, p: 1 };
export const KDF_MEMORY_MIB = (128 * KDF.N * KDF.r) / 2 ** 20;

/** Plaintext keys written by the zkpool-era wallet; migrated once, then deleted. */
export const LEGACY_KEYS = Object.freeze({
  phrase: "zkpool.signet.phrase",
  history: "zkpool.signet.history",
  payer: "zkpool.signet.payer",
});

export const vaultKey = (prefix) => `${prefix}.vault`;
/** Plain, non-secret payer preference ("local" | "unisat"), read by session.js. */
export const payerKey = (prefix) => `${prefix}.payer`;
export const emptyData = () => ({ history: [], gifts: [], prefs: {} });

export class WrongPassword extends Error {
  constructor() {
    super("Wrong password");
    this.name = "WrongPassword";
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function deriveKey(password, salt, kdf = KDF) {
  if (kdf.name !== "scrypt") throw new Error(`Unsupported key derivation ${kdf.name}. Update the wallet and try again.`);
  return scryptAsync(enc.encode(String(password).normalize("NFKC")), salt, { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32 });
}

/** Encrypts any JSON value under `key`; a fresh 24-byte nonce per call. */
export function seal(key, value) {
  const nonce = randomBytes(24);
  const ct = xchacha20poly1305(key, nonce).encrypt(enc.encode(JSON.stringify(value)));
  return { nonce: hex(nonce), ct: hex(ct) };
}

/** Decrypts a sealed value. A wrong key and a tampered blob look the same: WrongPassword. */
export function open(key, sealed) {
  let pt;
  try {
    pt = xchacha20poly1305(key, unhex(sealed.nonce)).decrypt(unhex(sealed.ct));
  } catch {
    throw new WrongPassword();
  }
  return JSON.parse(dec.decode(pt));
}

/** Seals the wallet's private data ({ history, gifts, prefs }) for the vault's `data` field. */
export const sealData = (key, value) => seal(key, value);

/** Opens the vault's `data` field; a vault without one yields empty data. */
export function openData(key, vault) {
  if (!vault?.data) return emptyData();
  return { ...emptyData(), ...open(key, vault.data) };
}

/** The same vault with `data` re-sealed under `key` (new nonce). The phrase is untouched. */
export const withData = (vault, key, data) => ({ ...vault, data: sealData(key, data) });

/** New vault for `phrase`. Returns { vault, key }: `vault` is JSON-safe for storage. */
export async function createVault(phrase, password, data = emptyData()) {
  if (String(password).length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters.`);
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return { vault: { v: 1, kdf: { ...KDF, salt: hex(salt) }, phrase: seal(key, phrase), data: sealData(key, data) }, key };
}

/** Returns { phrase, key, data } or throws WrongPassword. */
export async function unlockVault(vault, password) {
  if (vault?.v !== 1) throw new Error("This wallet was saved in a format this version can't read. Restore it from your 24 words.");
  const key = await deriveKey(password, unhex(vault.kdf.salt), vault.kdf);
  const phrase = open(key, vault.phrase);
  return { phrase, key, data: openData(key, vault) };
}

/** Re-encrypts the phrase and the data under a new password (old password required). */
export async function changePassword(vault, oldPassword, newPassword) {
  const { phrase, data } = await unlockVault(vault, oldPassword);
  return createVault(phrase, newPassword, data);
}

/**
 * Password strength from length and character classes only (no dictionary):
 * a hint, not a guarantee. score 0..4.
 */
export function passwordStrength(password) {
  const pw = String(password ?? "");
  const len = [...pw].length;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(pw)).length;
  const words = pw.trim().split(/\s+/).filter((w) => w.length >= 3).length;
  let score = 0;
  if (len >= MIN_PASSWORD) score = 1;
  if (len >= 12 && (classes >= 2 || words >= 3)) score = 2;
  if (len >= 14 && (classes >= 3 || words >= 3)) score = 3;
  if (len >= 18 && (classes >= 3 || words >= 4)) score = 4;
  // One repeated character or a plain run of digits is weak at any length.
  if (/^(.)\1*$/.test(pw) || /^\d+$/.test(pw)) score = Math.min(score, 1);
  const label = ["Too short", "Weak", "Fair", "Good", "Strong"][score];
  const hint =
    len < MIN_PASSWORD
      ? `Use at least ${MIN_PASSWORD} characters.`
      : score < 3
        ? "Longer is better: 14 or more characters, or four unrelated words."
        : "Good. Anyone who copies this browser's storage would still have to guess it.";
  return { score, label, hint };
}

/* ---------- storage ---------- */

function readJSON(storage, k) {
  const v = storage.getItem(k);
  if (v === null || v === undefined) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export const readVault = (storage, prefix) => readJSON(storage, vaultKey(prefix));
/** Writes the vault and returns the JSON written. */
export function writeVault(storage, prefix, vault) {
  const json = JSON.stringify(vault);
  storage.setItem(vaultKey(prefix), json);
  return json;
}

/** The plaintext phrase left by the zkpool-era wallet, or null. Signet only: that wallet never ran on another network. */
export function legacyPhrase(storage) {
  if (NETWORK !== "signet") return null;
  const p = readJSON(storage, LEGACY_KEYS.phrase);
  return typeof p === "string" && p.trim() ? p.trim() : null;
}

/**
 * Moves the zkpool-era plaintext wallet into a Murkle vault: create the vault,
 * write it, read it back and decrypt it to check it, THEN delete the plaintext
 * phrase and history. Never leaves both copies after success; on any failure the
 * plaintext copy stays and the half-written vault is removed, so a retry is safe.
 * Old history entries are kept, marked `era: "legacy"` (they belong to the
 * pre-rename pool and are never tracked against the new indexer).
 * @returns { vault, key, phrase, data }
 */
export async function migrateLegacy(storage, password, { prefix }) {
  const phrase = legacyPhrase(storage);
  if (!phrase) throw new Error("No unprotected wallet to migrate.");
  if (readVault(storage, prefix)) throw new Error("A password-protected wallet already exists in this browser.");
  const oldHistory = readJSON(storage, LEGACY_KEYS.history);
  const history = (Array.isArray(oldHistory) ? oldHistory : []).map((h) => ({ ...h, era: "legacy" }));
  // Stored as JSON or as a bare string; either way it moves to the plain payer key.
  const payer = [readJSON(storage, LEGACY_KEYS.payer), storage.getItem(LEGACY_KEYS.payer)].find((p) => p === "unisat" || p === "local") ?? null;
  const data = { ...emptyData(), history };

  const { vault } = await createVault(phrase, password, data);
  writeVault(storage, prefix, vault);
  let check;
  try {
    const back = readVault(storage, prefix);
    check = await unlockVault(back, password);
    if (check.phrase !== phrase || check.data.history.length !== history.length) throw new Error("vault check failed");
  } catch (e) {
    storage.removeItem(vaultKey(prefix));
    throw new Error(`The encrypted copy didn't verify, so nothing was changed (${e.message}). Try again.`);
  }
  // A plain pref: best effort (the storage wrapper's setPref never throws; a bare stand-in has only setItem).
  if (payer && storage.getItem(payerKey(prefix)) === null) (storage.setPref ?? storage.setItem).call(storage, payerKey(prefix), payer);
  storage.removeItem(LEGACY_KEYS.phrase);
  storage.removeItem(LEGACY_KEYS.history);
  storage.removeItem(LEGACY_KEYS.payer);
  return { vault: readVault(storage, prefix), key: check.key, phrase, data: check.data };
}

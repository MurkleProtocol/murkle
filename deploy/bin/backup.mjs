#!/usr/bin/env node
// Encrypted backups of a Murkle node's state: the relayer's keys and books (they hold users'
// prepaid deposits), the indexer state and the header chain. docs/OPERATIONS.md has the
// procedures (schedule, off-site copies, the restore drill).
//
// Usage:
//   node deploy/bin/backup.mjs keygen  --out <path>
//   node deploy/bin/backup.mjs backup  [--recipient <pub>] [--data <dir>] [--out <dir>] [--network signet|mainnet]
//                                      [--keep N] [--keep-daily N] [--min-interval SECS] [--include <relative path>]...
//                                      [--require-relayer]
//   node deploy/bin/backup.mjs restore --key <path> --in <file.mbk> --to <dir> [--force]
//   node deploy/bin/backup.mjs verify  --key <path> --in <file.mbk>
//
// keygen runs on an offline machine. It writes an X25519 private key file (mode 0600, never
// overwritten) and prints the public key (murkle-backup-pub:<base64url>). Only the public key
// goes on the server; the private key is needed to restore and must never be stored there.
//
// backup reads each file once (the services replace their files atomically, so every read is
// a whole file), builds the archive { v: 1, network, createdAt, files: [{ path, mode, sha256, b64 }] },
// gzips it and encrypts it to the recipient: an ephemeral X25519 key, HKDF-SHA256 with info
// "murkle/backup/v1", XChaCha20-Poly1305 with the file header as associated data. It writes
// murkle-backup-<network>-<time>.mbk (mode 0600) and prunes older backups beyond --keep
// (plus the newest backup of each of the last --keep-daily days). Copying the files off the
// server is the operator's job.
//
// Defaults from the environment: MURKLE_BACKUP_RECIPIENT, MURKLE_BACKUP_DIR (/var/backups/murkle),
// MURKLE_BACKUP_KEEP (48), MURKLE_NETWORK (signet); --data defaults to /var/lib/murkle/<network>.
//
// --require-relayer (or MURKLE_BACKUP_REQUIRE_RELAYER=1, or MURKLE_RELAYER=1 in the environment):
// the paid relayer runs from <data>/relay-balance, so a backup without its pool key, change key
// and books fails (exit 1) instead of succeeding without the keys that control users' deposits.
//
// File layout (.mbk): "MBK1" | recipient public key (32) | ephemeral public key (32) | nonce (24)
// | ciphertext with its 16-byte tag. The first 92 bytes are the associated data.
//
// Exit codes: 0 done (or skipped by --min-interval); 1 failed (nothing to back up, a file
// that does not parse, a wrong key, a damaged or modified backup, a hash mismatch); 2 usage.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, chmodSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

export const MAGIC = new TextEncoder().encode("MBK1");
export const INFO = "murkle/backup/v1";
export const PUB_PREFIX = "murkle-backup-pub:";
export const KEY_PREFIX = "murkle-backup-key:";
const HEADER_LEN = 4 + 32 + 32 + 24;
export const NETWORKS = ["signet", "mainnet"];
// What a node holds that cannot be rebuilt from the chain (the relay keys and books) or takes
// long to rebuild (the indexer state and the header chain). Missing files are skipped, except the
// relayer's (RELAYER_FILES) when the relayer is required.
export const DEFAULT_FILES = Object.freeze([
  "relay-balance/pool.key",
  "relay-balance/change.key",
  "relay-balance/relayer.json",
  "state.json",
  "headers.json",
]);

/**
 * After a key rotation (docs/OPERATIONS.md 10.4) the relay directory also holds account-tags.key
 * (the books keys every balance is stored under) and retired/g<N>/ (the old keys, which late
 * deposits to old addresses are swept with, and the old state): every such file that exists.
 */
export function rotationFiles(dataDir) {
  const out = [];
  if (existsSync(join(dataDir, "relay-balance", "account-tags.key"))) out.push("relay-balance/account-tags.key");
  const retired = join(dataDir, "relay-balance", "retired");
  if (!existsSync(retired)) return out;
  for (const g of readdirSync(retired).filter((n) => /^g\d+$/.test(n)).sort()) {
    for (const f of ["pool.key", "change.key", "relayer.json"]) if (existsSync(join(retired, g, f))) out.push(`relay-balance/retired/${g}/${f}`);
  }
  return out;
}

/** The paid relayer's files: its keys and books (they hold users' prepaid deposits). */
export const RELAYER_FILES = Object.freeze(["relay-balance/pool.key", "relay-balance/change.key", "relay-balance/relayer.json"]);

export class BackupError extends Error {}
export class UsageError extends Error {}

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64u = (text) => new Uint8Array(Buffer.from(text, "base64url"));
const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equalBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/** Parses "murkle-backup-pub:<base64url>" (or the bare base64url) to 32 bytes. */
export function parsePublicKey(text) {
  const raw = String(text ?? "").trim().replace(PUB_PREFIX, "");
  const bytes = /^[A-Za-z0-9_-]{43}$/.test(raw) ? fromB64u(raw) : null;
  if (!bytes || bytes.length !== 32 || bytes.every((b) => b === 0)) {
    throw new BackupError(`the recipient is not a backup public key (expected ${PUB_PREFIX}<43 base64url characters>)`);
  }
  return bytes;
}

/** Reads a key file written by keygen -> { secret, pub }. */
export function readKeyFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8").trim();
  } catch (e) {
    throw new BackupError(`cannot read the key file (${e.code ?? e.message})`);
  }
  const raw = text.startsWith(KEY_PREFIX) ? text.slice(KEY_PREFIX.length) : null;
  const secret = raw && /^[A-Za-z0-9_-]{43}$/.test(raw) ? fromB64u(raw) : null;
  if (!secret || secret.length !== 32) throw new BackupError(`the key file does not hold a backup key (expected ${KEY_PREFIX}<base64url>)`);
  return { secret, pub: x25519.getPublicKey(secret) };
}

/** A new key pair -> { secret, pub, pubText, keyText }. */
export function generateKey() {
  const secret = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(secret);
  return { secret, pub, pubText: PUB_PREFIX + b64u(pub), keyText: `${KEY_PREFIX}${b64u(secret)}\n` };
}

function deriveKey(shared, ephPub, recipientPub) {
  if (shared.every((b) => b === 0)) throw new BackupError("the key agreement gave the zero point (a malformed public key)");
  const salt = new Uint8Array(64);
  salt.set(ephPub, 0);
  salt.set(recipientPub, 32);
  return hkdf(sha256, shared, salt, INFO, 32);
}

/** Encrypts `plain` to `recipientPub` -> the .mbk bytes. */
export function seal(plain, recipientPub) {
  const eph = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(eph);
  const key = deriveKey(x25519.getSharedSecret(eph, recipientPub), ephPub, recipientPub);
  const nonce = randomBytes(24);
  const header = new Uint8Array(HEADER_LEN);
  header.set(MAGIC, 0);
  header.set(recipientPub, 4);
  header.set(ephPub, 36);
  header.set(nonce, 68);
  const ct = xchacha20poly1305(key, nonce, header).encrypt(plain);
  const out = new Uint8Array(HEADER_LEN + ct.length);
  out.set(header, 0);
  out.set(ct, HEADER_LEN);
  return out;
}

/** Decrypts .mbk bytes with the private key; throws BackupError for another key or modified bytes. */
export function unseal(bytes, secret) {
  const buf = new Uint8Array(bytes);
  if (buf.length < HEADER_LEN + 16 || !equalBytes(buf.subarray(0, 4), MAGIC)) throw new BackupError("this is not a Murkle backup file (no MBK1 header)");
  const header = buf.subarray(0, HEADER_LEN);
  const recipientPub = header.subarray(4, 36);
  const ephPub = header.subarray(36, 68);
  const nonce = header.subarray(68, 92);
  const mine = x25519.getPublicKey(secret);
  if (!equalBytes(mine, recipientPub)) {
    throw new BackupError(`this backup was encrypted for another key (${PUB_PREFIX}${b64u(recipientPub)}), not this key file`);
  }
  const key = deriveKey(x25519.getSharedSecret(secret, ephPub), ephPub, recipientPub);
  try {
    return xchacha20poly1305(key, nonce, header).decrypt(buf.subarray(HEADER_LEN));
  } catch {
    throw new BackupError("the backup does not decrypt: it was modified or is damaged");
  }
}

/** A relative path inside the data directory, or a BackupError. */
export function safeRelative(path) {
  const p = String(path ?? "").replace(/\\/g, "/");
  if (!p || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").some((s) => s === ".." || s === "." || s === "")) {
    throw new BackupError(`unsafe path in the archive: ${JSON.stringify(path)}`);
  }
  return p;
}

const JSON_FILE = /\.json$/;

/**
 * Reads the listed files of `dataDir` once each -> { files, skipped }. A JSON file that does not
 * parse is an error (a backup must never hold a torn file).
 */
export function collect(dataDir, list = DEFAULT_FILES) {
  const files = [];
  const skipped = [];
  for (const rel of [...new Set(list.map(safeRelative))]) {
    const path = join(dataDir, ...rel.split("/"));
    let bytes;
    let mode;
    try {
      bytes = readFileSync(path);
      mode = statSync(path).mode & 0o777;
    } catch (e) {
      if (e.code === "ENOENT") {
        skipped.push(rel);
        continue;
      }
      throw new BackupError(`cannot read ${rel} (${e.code ?? e.message})`);
    }
    if (JSON_FILE.test(rel)) {
      try {
        JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new BackupError(`${rel} does not parse as JSON; refusing to back up a damaged file`);
      }
    }
    files.push({ path: rel, mode, sha256: sha256Hex(bytes), b64: bytes.toString("base64") });
  }
  return { files, skipped };
}

/** The archive -> gzip(JSON) bytes. */
export function packArchive({ network, createdAt = new Date().toISOString(), files }) {
  return new Uint8Array(gzipSync(Buffer.from(JSON.stringify({ v: 1, network, createdAt, files }))));
}

/** gzip(JSON) bytes -> the archive, with every path and sha256 checked. */
export function unpackArchive(plain) {
  let archive;
  try {
    archive = JSON.parse(gunzipSync(Buffer.from(plain)).toString("utf8"));
  } catch {
    throw new BackupError("the decrypted archive does not parse");
  }
  if (archive?.v !== 1 || !Array.isArray(archive.files)) throw new BackupError(`unsupported archive version ${archive?.v}`);
  const seen = new Set();
  const out = [];
  for (const f of archive.files) {
    const path = safeRelative(f?.path);
    if (seen.has(path)) throw new BackupError(`duplicate path in the archive: ${path}`);
    seen.add(path);
    const bytes = Buffer.from(String(f.b64 ?? ""), "base64");
    if (sha256Hex(bytes) !== f.sha256) throw new BackupError(`${path}: sha256 does not match the archive's record`);
    out.push({ path, mode: Number.isInteger(f.mode) ? f.mode & 0o777 : 0o600, sha256: f.sha256, bytes });
  }
  return { network: archive.network, createdAt: archive.createdAt, files: out };
}

/** Writes `bytes` to `path` through a temp file and a rename, with `mode`, flushed to disk. */
function writeFileDurable(path, bytes, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  try {
    chmodSync(path, mode);
  } catch {
    // Windows keeps its own ACLs
  }
}

const STAMP = (iso) => iso.replace(/[:.]/g, "-");
const backupName = (network, iso) => `murkle-backup-${network}-${STAMP(iso)}.mbk`;
const backupPattern = (network) => new RegExp(`^murkle-backup-${network}-(\\d{4}-\\d{2}-\\d{2})T[0-9-]+Z\\.mbk$`);

/** Backups of `network` in `dir`, oldest first (the names sort by time). */
export function listBackups(dir, network) {
  if (!existsSync(dir)) return [];
  const re = backupPattern(network);
  return readdirSync(dir).filter((n) => re.test(n)).sort();
}

/** The names to delete: all but the newest `keep`, and the newest of each of the last `keepDaily` days. */
export function pruneList(names, { keep = 48, keepDaily = 14, network }) {
  const re = backupPattern(network);
  const sorted = names.filter((n) => re.test(n)).sort(); // never another network's file or anything else
  const keepSet = new Set(sorted.slice(Math.max(0, sorted.length - keep)));
  const days = new Map();
  for (const n of sorted) days.set(n.match(re)?.[1], n); // last one per day wins (newest)
  [...days.keys()].sort().slice(-keepDaily).forEach((d) => keepSet.add(days.get(d)));
  return sorted.filter((n) => !keepSet.has(n));
}

/** Runs one backup -> { file, files, skipped, pruned } or { skipped: true, reason } (min-interval). */
export function runBackup({ recipient, dataDir, outDir, network, keep = 48, keepDaily = 14, minIntervalSecs = 0, include = [], requireRelayer = false, now = () => new Date() }) {
  if (!NETWORKS.includes(network)) throw new UsageError(`unknown network "${network}" (signet or mainnet)`);
  const pub = parsePublicKey(recipient);
  if (!existsSync(dataDir)) throw new BackupError(`the data directory ${dataDir} does not exist`);
  const at = now();
  const existing = listBackups(outDir, network);
  if (minIntervalSecs > 0 && existing.length) {
    const last = statSync(join(outDir, existing[existing.length - 1])).mtimeMs;
    const age = (at.getTime() - last) / 1000;
    if (age >= 0 && age < minIntervalSecs) return { skipped: true, reason: `the newest backup is ${Math.floor(age)} s old (--min-interval ${minIntervalSecs})` };
  }
  const { files, skipped } = collect(dataDir, [...DEFAULT_FILES, ...rotationFiles(dataDir), ...include]);
  const missing = requireRelayer ? RELAYER_FILES.filter((p) => skipped.includes(p)) : [];
  if (missing.length) {
    throw new BackupError(`the paid relayer is on, but ${dataDir} has no ${missing.join(", ")}: its directory must be ${join(dataDir, "relay-balance")} (MURKLE_RELAY_DIR for ${network}); nothing was backed up`);
  }
  if (!files.length) throw new BackupError(`nothing to back up in ${dataDir} (none of ${[...DEFAULT_FILES, ...include].join(", ")})`);
  const createdAt = at.toISOString();
  const sealed = seal(packArchive({ network, createdAt, files }), pub);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  let name = backupName(network, createdAt);
  if (existsSync(join(outDir, name))) name = name.replace(/\.mbk$/, `-${randomBytes(2).toString("hex")}.mbk`);
  const file = join(outDir, name);
  writeFileDurable(file, sealed, 0o600);
  const pruned = pruneList(listBackups(outDir, network), { keep, keepDaily, network });
  for (const n of pruned) rmSync(join(outDir, n), { force: true });
  return { file, bytes: sealed.length, files: files.map((f) => ({ path: f.path, sha256: f.sha256 })), skipped, pruned };
}

/** Decrypts and checks a backup -> { network, createdAt, files } (bytes included). */
export function openBackup({ keyPath, inPath }) {
  const { secret } = readKeyFile(keyPath);
  let bytes;
  try {
    bytes = readFileSync(inPath);
  } catch (e) {
    throw new BackupError(`cannot read ${inPath} (${e.code ?? e.message})`);
  }
  return unpackArchive(unseal(bytes, secret));
}

const isEmptyDir = (dir) => !existsSync(dir) || readdirSync(dir).length === 0;

/** Restores a backup into `toDir` (refuses a non-empty directory without force). */
export function runRestore({ keyPath, inPath, toDir, force = false }) {
  const archive = openBackup({ keyPath, inPath });
  if (!isEmptyDir(toDir) && !force) throw new BackupError(`${toDir} is not empty; restore into an empty directory, or pass --force to overwrite the files in the backup`);
  const root = resolve(toDir);
  for (const f of archive.files) {
    const dest = resolve(root, ...f.path.split("/"));
    if (!(dest + sep).startsWith(root + sep)) throw new BackupError(`unsafe path in the archive: ${f.path}`);
    writeFileDurable(dest, f.bytes, f.mode);
  }
  return { network: archive.network, createdAt: archive.createdAt, files: archive.files.map((f) => ({ path: f.path, bytes: f.bytes.length, sha256: f.sha256 })) };
}

/** keygen: writes the private key file (never over an existing file) and its .pub next to it. */
export function runKeygen({ out }) {
  if (existsSync(out)) throw new BackupError(`${out} exists; keygen never overwrites a key file`);
  const k = generateKey();
  mkdirSync(dirname(resolve(out)), { recursive: true });
  const fd = openSync(out, "wx", 0o600);
  try {
    writeFileSync(fd, k.keyText);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(out, 0o600);
  } catch {
    // Windows keeps its own ACLs
  }
  writeFileSync(`${out}.pub`, `${k.pubText}\n`, { mode: 0o644 });
  return { pubText: k.pubText, keyPath: out, pubPath: `${out}.pub` };
}

/* ---------- command line ---------- */

const USAGE = `usage:
  backup.mjs keygen  --out <path>
  backup.mjs backup  [--recipient <pub>] [--data <dir>] [--out <dir>] [--network signet|mainnet] [--keep N] [--keep-daily N] [--min-interval SECS] [--include <relative path>]... [--require-relayer]
  backup.mjs restore --key <path> --in <file.mbk> --to <dir> [--force]
  backup.mjs verify  --key <path> --in <file.mbk>`;

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "--help" || cmd === "-h") return { cmd: "help", help: true, include: [] };
  if (!["keygen", "backup", "restore", "verify"].includes(cmd)) throw new UsageError(cmd ? `unknown command ${cmd}` : "a command is needed");
  const opts = { cmd, include: [] };
  const NAMES = { "--out": "out", "--recipient": "recipient", "--data": "data", "--network": "network", "--keep": "keep", "--keep-daily": "keepDaily", "--min-interval": "minInterval", "--include": "include", "--key": "key", "--in": "in", "--to": "to" };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--force") {
      opts.force = true;
      continue;
    }
    if (a === "--require-relayer") {
      opts.requireRelayer = true;
      continue;
    }
    if (a === "--help" || a === "-h") {
      opts.help = true;
      continue;
    }
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const name = NAMES[flag];
    if (!name) throw new UsageError(`unknown argument ${a}`);
    const v = inline ?? rest[++i];
    if (v === undefined || (inline === undefined && v.startsWith("--"))) throw new UsageError(`${flag} needs a value`);
    if (name === "include") opts.include.push(v);
    else opts[name] = v;
  }
  return opts;
}

const wholeNumber = (v, name, dflt) => {
  if (v === undefined || v === "") return dflt;
  if (!/^\d+$/.test(String(v))) throw new UsageError(`${name} must be a whole number`);
  return Number(v);
};

/** Runs the command line -> exit code. `env` and `print` are injectable for tests. */
export function main(argv, { env = process.env, print = (s) => console.log(s), error = (s) => console.error(s), now } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
    if (opts.help) {
      print(USAGE);
      return 0;
    }
    if (opts.cmd === "keygen") {
      if (!opts.out) throw new UsageError("keygen needs --out <path>");
      const r = runKeygen({ out: opts.out });
      print(r.pubText);
      error(`private key written to ${r.keyPath} (mode 0600). Keep it offline; the server needs only the public key above (MURKLE_BACKUP_RECIPIENT).`);
      return 0;
    }
    if (opts.cmd === "backup") {
      const network = opts.network ?? env.MURKLE_NETWORK ?? "signet";
      if (!NETWORKS.includes(network)) throw new UsageError(`unknown network "${network}" (signet or mainnet)`);
      const recipient = opts.recipient ?? env.MURKLE_BACKUP_RECIPIENT;
      if (!recipient) throw new UsageError("backup needs --recipient or MURKLE_BACKUP_RECIPIENT (the public key from keygen)");
      const r = runBackup({
        recipient,
        network,
        dataDir: opts.data ?? join("/var/lib/murkle", network),
        outDir: opts.out ?? env.MURKLE_BACKUP_DIR ?? "/var/backups/murkle",
        keep: wholeNumber(opts.keep ?? env.MURKLE_BACKUP_KEEP, "--keep", 48),
        keepDaily: wholeNumber(opts.keepDaily, "--keep-daily", 14),
        minIntervalSecs: wholeNumber(opts.minInterval, "--min-interval", 0),
        include: opts.include,
        requireRelayer: Boolean(opts.requireRelayer) || env.MURKLE_BACKUP_REQUIRE_RELAYER === "1" || env.MURKLE_RELAYER === "1",
        ...(now ? { now } : {}),
      });
      print(JSON.stringify(r.skipped === true ? { ok: true, skipped: r.reason } : { ok: true, file: r.file, bytes: r.bytes, files: r.files.map((f) => f.path), missing: r.skipped, pruned: r.pruned.length }));
      return 0;
    }
    if (!opts.key || !opts.in) throw new UsageError(`${opts.cmd} needs --key <path> and --in <file.mbk>`);
    if (opts.cmd === "verify") {
      const a = openBackup({ keyPath: opts.key, inPath: opts.in });
      print(JSON.stringify({ ok: true, network: a.network, createdAt: a.createdAt, files: a.files.map((f) => ({ path: f.path, bytes: f.bytes.length, sha256: f.sha256 })) }));
      return 0;
    }
    if (!opts.to) throw new UsageError("restore needs --to <dir>");
    const r = runRestore({ keyPath: opts.key, inPath: opts.in, toDir: opts.to, force: Boolean(opts.force) });
    print(JSON.stringify({ ok: true, restoredTo: resolve(opts.to), ...r }));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      error(`backup: ${e.message}\n${USAGE}`);
      return 2;
    }
    error(`backup: ${e instanceof BackupError ? e.message : `failed: ${e.message}`}`);
    return 1;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  const a = resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
if (isMain()) process.exitCode = main(process.argv.slice(2));

#!/usr/bin/env node
// Pre-publication check: lists the files a public commit would contain and fails on anything
// that must not be published. Run it before every push of the public repository.
//
// Usage: node scripts/prepublish-check.mjs [--final] [--list] [--root <dir>]
//   (npm run prepublish:check, npm run prepublish:check -- --final)
//   --final  also fail on what the owner still has to decide (TODO_ placeholders, no LICENSE,
//            LICENSE-CHOICE.md still present); without it those are warnings
//   --list   print every file that would be committed
//   --root   check another checkout (default: this repository)
//
// The file list comes from `git ls-files --cached --others --exclude-standard` when the root
// is a git work tree, and otherwise from walking the tree with the root .gitignore rules.
//
// Errors:
//   - any file under data/, build/, node_modules/, web/dist/ or docs/internal/, or named like a
//     key, wallet, relayer state or .env file
//   - files over 1 MB
//   - secret-like values: PEM private keys, WIF keys (base58check-valid), xprv/tprv, nsec,
//     API and bot tokens, JWTs, credentials inside URLs, valid BIP-39 recovery phrases, and any
//     64-hex value on a line (or right after a line) that names a private key, secret or seed;
//     a public test vector there carries the marker "prepublish-ok" on that line or the one above
//   - any secret held in this checkout's data/ (wallet seeds and BTC keys, relayer keys, also as
//     any fragment of 16+ hex digits or as raw bytes in a binary file), the keys and addresses
//     derived from them (P2TR address and x-only key, shielded address, relay account key and
//     id), and the identifiers in the wallet and relayer state files (account ids, outpoints,
//     txids); all read in memory and never printed. Public protocol constants a state file
//     repeats (the pinned MINE_FEES platform scripts) are not identifiers.
//   - values listed in .prepublish-deny (one per line; "prefix...suffix" matches any token with
//     that start and end; the file is gitignored, so the owner's own addresses never get published)
//   - absolute local paths (drive letters, home directories), email addresses other than
//     reserved example domains, Cyrillic text
// Values that match are never printed: only the file, the line and the kind.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createBase58check } from "@scure/base";
import { sha256 as sha256Noble } from "@noble/hashes/sha256";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { btcAccount } from "../src/btc/funding.mjs";
import { deriveKeys, encodeAddress } from "../src/keys.mjs";
import { MINE_FEES } from "../src/params.mjs";
import { relayAccount } from "../src/relay-account.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// Public protocol constants that a relayer state legitimately repeats (the platform fee output of a
// mining claim is pinned in src/params.mjs and appears on chain in every claim): never private.
const PUBLIC_CONSTANTS = Object.values(MINE_FEES)
  .map((rule) => rule?.platformScript)
  .filter((s) => typeof s === "string" && s.length >= 12)
  .map((s) => s.toLowerCase());
export const DEFAULT_ROOT = resolve(HERE, "..");
export const MAX_BYTES = 1024 * 1024;

const PRIVATE_DIRS = ["data/", "build/", "node_modules/", "web/dist/", "docs/internal/", ".git/"];
const PRIVATE_NAMES = [
  [/(^|\/)\.env(\..*)?$/, "environment file"],
  [/\.(key|pem|p12|pfx|wif)$/i, "key file"],
  [/(^|\/)wallets\//, "wallet directory"],
  [/(^|\/)relay-balance\//, "relayer key directory"],
  [/(^|\/)(relayer|state)\.json$/, "relayer or indexer state"],
  [/(^|\/)\.prepublish-deny$/, "the private deny list"],
];
// Files whose job is to name the placeholders (they are not placeholders themselves).
const LAUNCH_PLACEHOLDERS = new Set(["TODO_PLATFORM_ADDRESS"]);
const PLACEHOLDER_DOCS = new Set(["PUBLISHING.md", "scripts/prepublish-check.mjs", "test/publish-tools.test.mjs"]);
// The scanner's own patterns and its test vectors would otherwise trip it.
const SELF = new Set(["scripts/prepublish-check.mjs", "test/publish-tools.test.mjs"]);

const b58check = createBase58check(sha256Noble);
const WORDS = new Set(wordlist);
const EXAMPLE_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/i;

/* ---------- file list ---------- */

/** .gitignore rules -> a matcher (path, isDir) -> ignored. Covers the syntax this repository uses. */
export function gitignoreMatcher(text) {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    line = line.replace(/\s+$/, "");
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.startsWith("/") || line.includes("/");
    line = line.replace(/^\//, "");
    let re = "";
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === "*" && line[i + 1] === "*") {
        re += ".*";
        i++;
        if (line[i + 1] === "/") i++;
      } else if (c === "*") re += "[^/]*";
      else if (c === "?") re += "[^/]";
      else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
    rules.push({ negate, dirOnly, re: new RegExp(anchored ? `^${re}$` : `(^|/)${re}$`) });
  }
  return (path, isDir) => {
    let ignored = false;
    for (const r of rules) if ((!r.dirOnly || isDir) && r.re.test(path)) ignored = !r.negate;
    return ignored;
  };
}

function walk(root, ignored, dir = "", out = []) {
  for (const name of readdirSync(join(root, dir))) {
    const rel = dir ? `${dir}/${name}` : name;
    if (name === ".git") continue;
    const isDir = statSync(join(root, rel)).isDirectory();
    if (ignored(rel, isDir)) continue;
    if (isDir) walk(root, ignored, rel, out);
    else out.push(rel);
  }
  return out;
}

/** { files, via } for `root`: what `git add -A` would commit. */
export function committableFiles(root) {
  try {
    const top = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (resolve(top).toLowerCase() === resolve(root).toLowerCase()) {
      const out = execFileSync("git", ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { files: out.split("\0").filter(Boolean).filter((f) => existsSync(join(root, f))).sort(), via: "git ls-files" };
    }
  } catch {
    // not a git work tree, or no git: walk the tree instead
  }
  const gi = existsSync(join(root, ".gitignore")) ? readFileSync(join(root, ".gitignore"), "utf8") : "";
  return { files: walk(root, gitignoreMatcher(gi)).sort(), via: "the .gitignore rules (no git work tree)" };
}

/* ---------- secrets held in this checkout ---------- */

/**
 * Secrets and identifying values from data/ (never printed), and the deny list.
 * -> { values: [{ value, kind }], secrets: [{ hex, kind }], fragments: Map(16-hex -> kind), deny }
 */
export function privateValues(root) {
  const values = [];
  const secrets = [];
  const seen = new Set();
  const add = (value, kind) => {
    const v = typeof value === "string" ? value.toLowerCase() : "";
    if (v.length < 12 || seen.has(v)) return;
    seen.add(v);
    if (PUBLIC_CONSTANTS.some((c) => c.includes(v))) return;
    values.push({ value: v, kind });
  };
  const toHex = (b) => Buffer.from(b).toString("hex");
  const addKey = (hex, kind) => {
    if (!/^[0-9a-f]{64}$/i.test(hex)) return;
    hex = hex.toLowerCase();
    if (secrets.some((s) => s.hex === hex)) return;
    secrets.push({ hex, kind });
    try {
      const acct = btcAccount(Buffer.from(hex, "hex"));
      add(acct.address, `address derived from a ${kind}`);
      add(toHex(acct.pub), `public key derived from a ${kind}`);
    } catch {
      // not a valid secp256k1 secret: the hex itself is still checked
    }
  };
  const addSeed = (hex, kind) => {
    addKey(hex, kind);
    if (!/^[0-9a-f]{64}$/i.test(hex)) return;
    const seed = Uint8Array.from(Buffer.from(hex, "hex"));
    try {
      add(encodeAddress(deriveKeys(seed)), `shielded address derived from a ${kind}`);
    } catch {
      // unusable seed: the hex itself is still checked
    }
    try {
      const ra = relayAccount(seed);
      addKey(toHex(ra.secret), `relay account key derived from a ${kind}`);
      add(ra.pubHex, `relay account key derived from a ${kind}`);
      add(ra.idHex, `relay account id derived from a ${kind}`);
    } catch {
      // unusable relay account: nothing more to derive
    }
  };
  // Every 64-hex value in a state file (as a value or a map key, also inside "txid:vout"):
  // secrets under a "keys" object or a key named like a secret, identifiers otherwise.
  const addState = (node, kind, name = "", parent = "") => {
    if (typeof node === "string") {
      const secretName = parent === "keys" || /secret|seed|priv|btckey/i.test(name);
      for (const m of node.matchAll(/[0-9a-f]{64}/gi)) {
        if (secretName && m[0] === node) addKey(m[0], `secret in ${kind}`);
        else add(m[0], `identifier in ${kind}`);
      }
    } else if (Array.isArray(node)) {
      for (const v of node) addState(v, kind, name, parent);
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) {
        addState(k, kind, "", name);
        addState(v, kind, k, name);
      }
    }
  };
  const readJson = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null; // unreadable file: nothing to compare
    }
  };
  const data = join(root, "data");
  if (existsSync(data)) {
    (function scan(dir) {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          // archive/ holds older indexer snapshots: public chain data, rebuilt from the genesis
          if (name !== "archive") scan(p);
        } else if (name.endsWith(".key")) addKey(readFileSync(p, "utf8").trim(), "relayer key in data/");
        else if (p.split(sep).includes("wallets") && name.endsWith(".json")) {
          const w = readJson(p);
          if (!w) continue;
          if (typeof w.seed === "string") addSeed(w.seed, "wallet seed in data/");
          if (typeof w.btcKey === "string") addKey(w.btcKey, "wallet BTC key in data/");
          addState({ ...w, seed: undefined, btcKey: undefined }, "a data/ wallet file");
        } else if (name === "relayer.json") {
          const s = readJson(p);
          if (s) addState(s, "the relayer state in data/");
        }
      }
    })(data);
  }
  const fragments = new Map();
  for (const { hex, kind } of secrets) for (let i = 0; i + 16 <= hex.length; i++) fragments.set(hex.slice(i, i + 16), kind);
  const deny = [];
  const denyFile = join(root, ".prepublish-deny");
  if (existsSync(denyFile)) {
    readFileSync(denyFile, "utf8").split(/\r?\n/).forEach((line, i) => {
      const v = line.trim();
      if (!v || v.startsWith("#")) return;
      const m = v.match(/^(.+?)(?:\.\.\.|\u2026)(.+)$/);
      deny.push(m ? { prefix: m[1].toLowerCase(), suffix: m[2].toLowerCase(), line: i + 1 } : { value: v.toLowerCase(), line: i + 1 });
    });
  }
  return { values, secrets, fragments, deny };
}

/* ---------- content checks ---------- */

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "PEM private key"],
  [/\b[xtyzuv]prv[1-9A-HJ-NP-Za-km-z]{100,112}\b/, "extended private key"],
  [/\bnsec1[02-9ac-hj-np-z]{50,}\b/, "nostr secret key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, "GitHub token"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/, "API secret key"],
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/, "Telegram bot token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, "JWT"],
  [/\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"`<>]+:[^\s/@'"`<>]+@[^\s'"`<>]/i, "credentials in a URL"],
];
const ABSOLUTE_PATHS = [
  [/(?<![A-Za-z0-9])[A-Za-z]:(?:\\{1,2}|\/)[^\\/\s"'`<>|*?:]+/, "absolute Windows path"],
  [/\\\\\?\\/, "Windows long-path prefix"],
  [/(?<![\w.~-])\/(?:home|Users|root)\/[A-Za-z0-9._-]+/, "home directory path"],
  // Git Bash / MSYS / Cygwin / WSL drive paths: /e/SOFT/..., /cygdrive/c/..., /mnt/c/...
  [/(?<![\w.~\/-])\/(?:cygdrive\/|mnt\/)?[a-z]\/Users\//i, "home directory path (shell form)"],
  [/(?<![\w.~\/-])\/(?:cygdrive\/|mnt\/)?[a-z]\/[A-Za-z][\w .-]*\/[\w .-]+\//, "absolute drive path (shell form)"],
  [/\bAppData[\\/]/, "AppData path"],
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;
const WIF = /\b[59cKL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;

function isWif(s) {
  try {
    const b = b58check.decode(s);
    return (b[0] === 0x80 || b[0] === 0xef) && (b.length === 33 || (b.length === 34 && b[33] === 1));
  } catch {
    return false;
  }
}

/** Valid BIP-39 phrases (12 to 24 words, checksum included) hidden in a text. */
export function findMnemonics(text) {
  const words = [...text.matchAll(/[a-z]+/g)];
  const hits = [];
  let run = [];
  const flush = () => {
    for (const n of [24, 21, 18, 15, 12]) {
      for (let i = 0; i + n <= run.length; i++) {
        const phrase = run.slice(i, i + n).map((m) => m[0]).join(" ");
        if (validateMnemonic(phrase, wordlist)) {
          hits.push(run[i].index);
          return;
        }
      }
    }
  };
  for (const m of words) {
    const prev = run[run.length - 1];
    const gapOk = !prev || /^[\s,"'`]*$/.test(text.slice(prev.index + prev[0].length, m.index));
    if (WORDS.has(m[0]) && gapOk) run.push(m);
    else {
      if (run.length >= 12) flush();
      run = WORDS.has(m[0]) ? [m] : [];
    }
  }
  if (run.length >= 12) flush();
  return hits;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// A line that names a private key, secret or seed; a 64-hex value on it or on the next line is
// treated as a secret unless the line or the one above carries "prepublish-ok".
const SECRET_NAME = /(?:^|[^a-z])priv(?:ate)?(?:[^a-z]|key|$)|secret|seed|mnemonic|recovery|passphrase|\bwif\b|btc_?key|spend_?key|signing_?key|\bsk\b/i;
const SECRET_NAME_CASED = /\bsk[A-Z_]/; // skFoo, sk_bar (not "skip")
const namesSecret = (line) => SECRET_NAME.test(line) || SECRET_NAME_CASED.test(line);
const HEX64 = /(?<![0-9A-Za-z])(?:0x)?([0-9a-fA-F]{64})(?![0-9A-Za-z])/g;
const ALLOW = /prepublish-ok/;
/** Trivial dummies (a short pattern repeated, such as "07" x 32) are not secrets. */
const trivialHex = (h) => /^(.{1,8})\1+$/i.test(h);

function namedSecrets(text, hit) {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const named = namesSecret(line) || (i > 0 && namesSecret(lines[i - 1]));
    const allowed = ALLOW.test(line) || (i > 0 && ALLOW.test(lines[i - 1]));
    if (named && !allowed) {
      for (const m of line.matchAll(HEX64)) if (!trivialHex(m[1])) hit(offset + m.index, "secret-like value (64-hex next to a secret name; mark a public test vector with prepublish-ok)");
    }
    offset += line.length + 1;
  }
}

/** Values from this checkout's data/ and the deny list, in a text or (with buf) a binary file. */
function privateHits(text, privates, hit, buf) {
  const lower = text.toLowerCase();
  for (const { value, kind } of privates.values ?? []) {
    for (let i = lower.indexOf(value); i >= 0; i = lower.indexOf(value, i + 1)) hit(i, `private value from this checkout (${kind})`);
  }
  if (privates.fragments?.size) {
    for (const m of lower.matchAll(/[0-9a-f]{16,}/g)) {
      for (let i = 0; i + 16 <= m[0].length; i++) {
        const kind = privates.fragments.get(m[0].slice(i, i + 16));
        if (kind) {
          hit(m.index + i, `private value from this checkout (${kind}, whole or a fragment)`);
          break;
        }
      }
    }
  }
  if (buf) {
    for (const { hex, kind } of privates.secrets ?? []) {
      const bytes = Buffer.from(hex, "hex");
      for (let i = 0; i + 16 <= bytes.length; i++) {
        const at = buf.indexOf(bytes.subarray(i, i + 16));
        if (at >= 0) {
          hit(at, `private value from this checkout (${kind}, raw bytes)`);
          break;
        }
      }
    }
  }
  for (const d of privates.deny ?? []) {
    if (d.value) {
      for (let i = lower.indexOf(d.value); i >= 0; i = lower.indexOf(d.value, i + 1)) hit(i, `deny-listed value (.prepublish-deny line ${d.line})`);
    } else {
      for (const m of lower.matchAll(/[a-z0-9._%+@:/-]+/g)) {
        if (m[0].length > d.prefix.length + d.suffix.length && m[0].includes(d.prefix) && m[0].endsWith(d.suffix)) hit(m.index, `deny-listed value (.prepublish-deny line ${d.line})`);
      }
    }
  }
}

/** Problems in a binary file: values from data/ and the deny list only. -> [{ kind }] */
export function scanBinary(buf, { privates = { values: [], deny: [] } } = {}) {
  const found = [];
  privateHits(buf.toString("latin1"), privates, (_i, kind) => found.push({ kind }), buf);
  return found;
}

/** Problems in one file's text: [{ line, kind }] (values are never included). */
export function scanText(text, { path = "", privates = { values: [], deny: [] } } = {}) {
  const found = [];
  const hit = (index, kind) => found.push({ line: lineOf(text, index), kind });
  if (!SELF.has(path)) {
    for (const [re, kind] of SECRET_PATTERNS) {
      const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      for (const m of text.matchAll(g)) hit(m.index, `secret-like value (${kind})`);
    }
    for (const m of text.matchAll(WIF)) if (isWif(m[0])) hit(m.index, "secret-like value (WIF private key)");
    for (const i of findMnemonics(text)) hit(i, "secret-like value (valid BIP-39 recovery phrase)");
    for (const [re, kind] of ABSOLUTE_PATHS) {
      const g = new RegExp(re.source, re.flags + "g");
      for (const m of text.matchAll(g)) hit(m.index, kind);
    }
    for (const m of text.matchAll(EMAIL)) if (!EXAMPLE_EMAIL_DOMAIN.test(m[1]) && m[0] !== "git@github.com") hit(m.index, "email address");
    const cyr = text.search(/[\u0400-\u04FF]/);
    if (cyr >= 0) hit(cyr, "Cyrillic text");
    namedSecrets(text, hit);
  }
  privateHits(text, privates, hit);
  return found;
}

const isBinary = (buf) => buf.subarray(0, Math.min(buf.length, 65536)).includes(0);

/** Runs every check on `root`. Returns { files, via, errors, warnings } with { path, line?, kind }. */
export function check(root = DEFAULT_ROOT, { final = false } = {}) {
  const { files, via } = committableFiles(root);
  const privates = privateValues(root);
  const errors = [];
  const warnings = [];
  const launch = new Set();
  for (const path of files) {
    for (const d of PRIVATE_DIRS) if (path.startsWith(d)) errors.push({ path, kind: `private or generated path (${d})` });
    for (const [re, kind] of PRIVATE_NAMES) if (re.test(path)) errors.push({ path, kind });
    const buf = readFileSync(join(root, path));
    if (buf.length > MAX_BYTES) errors.push({ path, kind: `file over 1 MB (${buf.length.toLocaleString("en-US")} bytes)` });
    if (isBinary(buf)) {
      for (const f of scanBinary(buf, { privates })) errors.push({ path, ...f });
      continue;
    }
    const text = buf.toString("utf8");
    for (const f of scanText(text, { path, privates })) errors.push({ path, ...f });
    if (!PLACEHOLDER_DOCS.has(path)) {
      for (const m of text.matchAll(/\bTODO_[A-Z][A-Z_]+\b/g)) {
        // Mainnet-launch placeholders are guarded in code (mining refuses on mainnet until
        // set), so they belong to docs/MAINNET.md, not to publishing the source.
        if (LAUNCH_PLACEHOLDERS.has(m[0])) { launch.add(m[0]); continue; }
        (final ? errors : warnings).push({ path, line: lineOf(text, m.index), kind: `owner decision still open (${m[0]})` });
      }
    }
  }
  const owner = final ? errors : warnings;
  if (!files.includes("LICENSE")) owner.push({ path: "LICENSE", kind: "missing: choose the license (LICENSE-CHOICE.md)" });
  if (files.includes("LICENSE-CHOICE.md")) owner.push({ path: "LICENSE-CHOICE.md", kind: "delete it once LICENSE is written" });
  const params = existsSync(join(root, "src/params.mjs")) ? readFileSync(join(root, "src/params.mjs"), "utf8") : "";
  if (/export const REPO_URL = null;/.test(params)) owner.push({ path: "src/params.mjs", kind: "REPO_URL is still null" });
  if (/export const SECURITY_CONTACT = null;/.test(params)) owner.push({ path: "src/params.mjs", kind: "SECURITY_CONTACT is still null" });
  return { files, via, errors, warnings, launch: [...launch] };
}

function main() {
  const argv = process.argv.slice(2);
  const final = argv.includes("--final");
  const list = argv.includes("--list");
  const r = argv.indexOf("--root");
  const root = r >= 0 && argv[r + 1] ? resolve(argv[r + 1]) : DEFAULT_ROOT;
  const { files, via, errors, warnings, launch } = check(root, { final });
  if (list) for (const f of files) console.log(f);
  const where = (p) => `${p.path}${p.line ? `:${p.line}` : ""}`;
  console.log(`${files.length} files would be committed (from ${via}).`);
  if (launch.length) console.log(`note     mainnet-launch placeholder(s) left on purpose, guarded in code: ${launch.join(", ")} (docs/MAINNET.md)`);
  for (const w of warnings) console.log(`warning  ${where(w)}  ${w.kind}`);
  for (const e of errors) console.error(`ERROR    ${where(e)}  ${e.kind}`);
  if (errors.length) {
    console.error(`\n${errors.length} problem(s): fix them before publishing. Matched values are not printed.`);
    return 1;
  }
  console.log(warnings.length ? `\nNo blocking problems; ${warnings.length} owner decision(s) still open (run with --final before the first push).` : "\nNo problems found.");
  return 0;
}

function isMain() {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? entry.toLowerCase() === self.toLowerCase() : entry === self;
}

if (isMain()) process.exit(main());

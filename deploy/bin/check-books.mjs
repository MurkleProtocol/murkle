#!/usr/bin/env node
// Offline check of a relayer's books (invariant I2) from its relayer.json, for the restore
// drill in docs/OPERATIONS.md and for incident work on a halted relayer. Nothing is signed,
// sent or written, and no key is printed.
//
// Usage: node deploy/bin/check-books.mjs --state <relayer.json> [--keys <dir>] [--margin-pct N] [--margin-min-sats N]
//
// It restores the books exactly as the relayer does (RelayBooks.restore: version, network, pool
// and change keys, record shapes), counts the pool's recorded coins (unspent and reserved), runs
// checkI2 and, when pool.key and change.key are in --keys (default: the state file's directory),
// checks that their public keys are the ones the state names. The coins are the relayer's own
// record: comparing them with the chain is the operator's step (docs/OPERATIONS.md).
//
// Prints one JSON line. Exit codes: 0 I2 holds and the keys match (or are absent); 1 a problem; 2 usage.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1";
import { RelayBooks } from "../../server/relay-books.mjs";

const HEX32 = /^[0-9a-f]{64}$/;
const STATE_VERSION = 2; // server/relayer.mjs STATE_VERSION (the paid relayer's state file)
const hex = (b) => Buffer.from(b).toString("hex");

/**
 * Σ value of the coins the relayer counts as pool money (unspent and reserved), as Relayer.poolUnspent:
 * a held coin (an operator's refill, a sweep of late deposits) only once it is in a block.
 */
export function poolUnspentOf(coins) {
  let s = 0;
  for (const c of Object.values(coins ?? {})) {
    if (c?.hold && !c.confirmed) continue;
    if (c?.status === "unspent" || c?.status === "reserved") s += c.value;
  }
  return s;
}

/** Compares key files with the public keys a state names -> "match" | "absent" | a problem string. */
export function checkKeyFiles(dir, keys) {
  const files = { pool: join(dir, "pool.key"), change: join(dir, "change.key") };
  const have = Object.values(files).filter((p) => existsSync(p)).length;
  if (have === 0) return "absent";
  if (have === 1) return "only one of pool.key and change.key is present";
  for (const [name, path] of Object.entries(files)) {
    const text = readFileSync(path, "utf8").trim();
    if (!HEX32.test(text)) return `${name}.key does not hold 64 lowercase hex characters`;
    if (hex(schnorr.getPublicKey(text)) !== keys?.[name]) return `${name}.key does not belong to this state (its public key differs)`;
  }
  return "match";
}

/** The check of a parsed relayer.json -> a JSON-safe report with ok and problems. */
export function checkBooks(saved, { keysDir = null, marginPct = 10, marginMinSats = 50 } = {}) {
  const problems = [];
  if (!saved || typeof saved !== "object") return { ok: false, problems: ["the state is not a JSON object"] };
  if (saved.version !== STATE_VERSION) problems.push(`state version ${saved.version} is not ${STATE_VERSION} (the paid relayer's format)`);
  let books = null;
  try {
    books = RelayBooks.restore(saved.books, { network: saved.network, poolKey: saved.keys?.pool, changeKey: saved.keys?.change, marginPct, marginMinSats });
  } catch (e) {
    problems.push(`the books do not load: ${e.message}`);
  }
  const report = { network: saved.network ?? null, halted: saved.halted ?? null, accounts: 0, credits: 0 };
  if (books) {
    const poolUnspent = poolUnspentOf(saved.coins);
    const r = books.checkI2({ poolUnspent });
    problems.push(...r.problems);
    Object.assign(report, {
      credited: r.credited, fees: r.fees, serviceOut: r.serviceOut, balances: r.balances, reserved: r.reserved,
      margin: r.margin, liabilities: r.liabilities, poolUnspent, slack: poolUnspent - r.liabilities,
      // After an evacuation (relay-balance.md §9): its fees the margin could not pay, and what of them is not refunded yet.
      ...(r.operatorIn ? { operatorIn: r.operatorIn, operatorOwed: r.operatorOwed } : {}),
      accounts: books.accounts.size, credits: books.creditMap.size,
    });
  }
  if (keysDir) {
    const k = checkKeyFiles(keysDir, saved.keys);
    report.keyFiles = k === "match" || k === "absent" ? k : "mismatch";
    if (report.keyFiles === "mismatch") problems.push(k);
  }
  if (saved.halted) problems.push(`the state records a halt at ${saved.halted.height ?? "?"}: ${(saved.halted.problems ?? []).join("; ")}`);
  return { ok: problems.length === 0, problems, ...report };
}

export function parseArgs(argv) {
  const o = {};
  const NAMES = { "--state": "state", "--keys": "keys", "--margin-pct": "marginPct", "--margin-min-sats": "marginMinSats" };
  for (let i = 0; i < argv.length; i++) {
    const k = NAMES[argv[i]];
    if (!k) throw new Error(`unknown argument ${argv[i]}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${argv[i - 1]} needs a value`);
    o[k] = v;
  }
  if (!o.state) throw new Error("usage: check-books.mjs --state <relayer.json> [--keys <dir>] [--margin-pct N] [--margin-min-sats N]");
  for (const k of ["marginPct", "marginMinSats"]) {
    if (o[k] === undefined) continue;
    if (!/^\d+$/.test(o[k])) throw new Error(`--${k === "marginPct" ? "margin-pct" : "margin-min-sats"} must be a whole number`);
    o[k] = Number(o[k]);
  }
  return o;
}

export function main(argv, { print = (s) => console.log(s), error = (s) => console.error(s) } = {}) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    error(`check-books: ${e.message}`);
    return 2;
  }
  let saved;
  try {
    saved = JSON.parse(readFileSync(o.state, "utf8"));
  } catch (e) {
    print(JSON.stringify({ ok: false, problems: [`cannot read ${o.state} (${e.code ?? e.message})`] }));
    return 1;
  }
  const r = checkBooks(saved, { keysDir: o.keys ?? dirname(resolve(o.state)), marginPct: o.marginPct, marginMinSats: o.marginMinSats });
  print(JSON.stringify(r));
  return r.ok ? 0 : 1;
}

function isMain() {
  if (!process.argv[1]) return false;
  const a = resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
if (isMain()) process.exitCode = main(process.argv.slice(2));

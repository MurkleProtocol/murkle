#!/usr/bin/env node
// Murkle CLI (MURKLE_NETWORK, signet by default). Wallet files hold plaintext keys: on mainnet,
// keep the data directory on a machine you trust, and hold only small amounts in these wallets.
import {
  readFileSync, existsSync, mkdirSync, realpathSync, openSync, writeSync, fsyncSync, closeSync, renameSync, rmSync, statSync, chmodSync,
  copyFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { availableParallelism, cpus } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { deriveKeys, encodeAddress, decodeAddress } from "../src/keys.mjs";
import { Wallet, anchorAt } from "../src/wallet.mjs";
import { ATTEST_KIND, decodeEnvelope, encodeAttest, encodeDeploy } from "../src/envelope.mjs";
import { Esplora } from "../src/btc/esplora.mjs";
import { RBF_SEQUENCE, btcAccount, buildCarrierTx, dustLimit, feeFor, headroomRate, pickBindUtxo, scriptOf, signLocal } from "../src/btc/funding.mjs";
// planPayment (relay-balance-contract.md §1b) is read from the namespace when a top-up is paid.
import * as funding from "../src/btc/funding.mjs";
import { equal, hex, outpointOf, unhex } from "../src/bytes.mjs";
// The mining build's encodeDeployPow and its constants (mining-contract.md §2, §5) are read from
// these namespaces, so the commands that never mine load without them.
import * as envelopeLib from "../src/envelope.mjs";
import * as params from "../src/params.mjs";
import { ANCHOR_WINDOW, Indexer, mintClosed } from "../src/indexer.mjs";
import { compareDigests, syncIndexer } from "../src/sync.mjs";
import { readRelayerKey, readV1File, retireFree } from "../server/retired-relay.mjs";
import { loadIndexer, loadPinnedVkey, saveIndexer, sha256File } from "../src/store-node.mjs";
import { EPOCH_BLOCKS, batchSchedule, isBatchMode, savedMode } from "../src/relay-batch.mjs";
import { candidateNotes, crowdCheck } from "../src/crowd.mjs";
import {
  ACTIVATION_HEIGHT, ARTIFACT_PATHS, ARTIFACT_SHA256, BRAND, ESPLORA_API, EXPLORER, GENESIS, GENESIS_TXID, IS_TESTNET, MANIFEST_SHA256,
  NETWORK, PINS_FILE, PRE_GENESIS, PROTOCOL, env,
} from "../src/params.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = env("DATA_DIR") ?? join(ROOT, "data", NETWORK); // cli-state.json and wallets/
// The CLI's own index snapshot. The indexer server's default snapshot is data/<network>/state.json,
// the same directory, so the CLI keeps a file of its own: a running server and the CLI never
// share one state file (audit V2-41). SHARED_STATE is only read, once, to seed a first run.
const STATE = join(DATA, "cli-state.json");
const SHARED_STATE = join(DATA, "state.json");
const WALLETS = join(DATA, "wallets");
// This network's artifacts (signet: the DEV setup; mainnet: build/mainnet/*, the ceremony output).
const ARTIFACTS = {
  wasm: join(ROOT, ARTIFACT_PATHS.wasm),
  zkey: join(ROOT, ARTIFACT_PATHS.zkey),
  vkey: join(ROOT, ARTIFACT_PATHS.vkey),
  manifest: join(ROOT, ARTIFACT_PATHS.manifest),
};
const CLI = PROTOCOL; // command name in messages
// The chain source. Imported (tests): this network's Esplora. Run as a command: openCliChainSource
// replaces it (Esplora or Bitcoin Core, with header verification when src/btc/source.mjs exists).
let api = new Esplora(env("ESPLORA") ?? ESPLORA_API);
let cliChain = null; // { kind, api, headers, save(), describe() } once opened
const CLI_HEADERS = join(DATA, "cli-headers.json");
let vkeyCache;
// Refuses to run against a verification key other than the pinned one.
const vkey = () => (vkeyCache ??= loadPinnedVkey(ARTIFACTS.vkey));

const walletPath = (name) => join(WALLETS, `${name}.json`);

// ------------------------------------------------- wallet files
//
// A wallet file is the only copy of its seed, BTC fee key and (derived) relay account, so:
// owner-only access on POSIX (0600 files in a 0700 directory), every write goes to a temp file
// that is synced and renamed over the old one (a crash, a kill or a full disk never leaves an
// empty or cut file), and a save merges under a lock only what this command changed since it
// read the file. Two commands on one wallet (a 10-hour batch wait and another send, say)
// therefore never undo each other's pending entries (W-1) or relay state.

const POSIX = process.platform !== "win32";
const LOCK_WAIT_MS = 10_000;
const LOCK_STALE_MS = 30_000;
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Owner-only access on POSIX for a wallet file or directory that is readable by others. */
function ownerOnly(path, mode) {
  if (!POSIX) return;
  try {
    if (statSync(path).mode & 0o077) chmodSync(path, mode);
  } catch {
    // a missing path is reported by the read that follows
  }
}

function readWalletJson(path, name = path) {
  if (!existsSync(path)) throw new Error(`no wallet "${name}" (create it with: ${CLI} new ${name})`);
  ownerOnly(dirname(path), 0o700);
  ownerOnly(path, 0o600);
  const file = JSON.parse(readFileSync(path, "utf8"));
  checkWalletNetwork(file, name);
  return file;
}
const readWalletFile = (name) => readWalletJson(walletPath(name), name);

/** The network a wallet file belongs to: its `network` field, else signet (files from before the field). */
export const walletNetworkOf = (file) => (typeof file?.network === "string" && file.network ? file.network : "signet");

/**
 * Refuses a wallet file of another network: its BTC fee key (and mining key) are raw keys, so the
 * same file would show the same key as tb1p... on signet and bc1p... on mainnet, linking the two,
 * and replay signet pending entries against mainnet.
 */
export function checkWalletNetwork(file, name = "wallet", network = NETWORK) {
  const theirs = walletNetworkOf(file);
  if (theirs !== network) {
    throw new Error(`wallet "${name}" belongs to Bitcoin ${theirs}, and this is ${network}: never reuse a wallet file across networks (use a separate MURKLE_DATA_DIR per network, or create a new wallet)`);
  }
}

/** Writes `text` to a new file at `path` (mode 0600, refused when it exists) and syncs it. */
function createFileDurable(path, text) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Replaces `path` with `text` atomically: a 0600 temp file next to it, fsync, rename. Until the
 * rename the old file stays whole; the temp file is removed on any error.
 */
export function writeFileDurable(path, text) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    createFileDurable(tmp, text);
    for (let tries = 0; ; tries++) {
      try {
        renameSync(tmp, path);
        break;
      } catch (e) {
        // Windows: a reader or a virus scanner may hold the old file for a moment.
        if (tries >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) throw e;
        sleepSync(25);
      }
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Runs `fn` while holding `<path>.lock` (created exclusively); a lock older than 30 s is taken as stale. */
export function withFileLock(path, fn, { waitMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  const lock = `${path}.lock`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      // Windows answers EPERM for a lock file that is being deleted.
      if (e.code !== "EEXIST" && !(e.code === "EPERM" && !POSIX)) throw e;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released in the meantime
      }
      if (age > staleMs) {
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() > until) {
        throw new Error(`${path} is locked by another ${CLI} command; try again (if none runs, delete ${lock})`);
      }
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

const cloneJson = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Identity of a pending entry across saves and commands: its spent notes' nullifiers (a retry
 * proves the same notes again, and two live entries never share a note), else txid and creation time.
 */
const entryKey = (p) =>
  p?.kind === "mine" && p.solutionId
    ? `m:${p.solutionId}` // a mining claim (W-M): one entry per solution, whatever its carrier
    : p?.spends?.length
      ? `n:${p.spends.map(String).sort().join(",")}`
      : `t:${p?.txid ?? ""}:${p?.createdAt ?? ""}`;

/** pending: on-disk order; ours where we changed it since `base`, dropped where we dropped it, the rest as on disk. */
function mergePendingEntries(base = [], mine = [], disk = []) {
  const b = new Map(base.map((p) => [entryKey(p), p]));
  const m = new Map(mine.map((p) => [entryKey(p), p]));
  const out = [];
  const done = new Set();
  for (const p of disk) {
    const k = entryKey(p);
    if (done.has(k)) continue;
    done.add(k);
    if (m.has(k)) out.push(sameJson(m.get(k), b.get(k)) ? p : m.get(k));
    else if (!b.has(k)) out.push(p); // another command added it
    // else: this command dropped it (it landed, or its window passed)
  }
  for (const [k, p] of m) {
    if (done.has(k)) continue;
    // Not on disk: new or changed here, or (unchanged here) dropped by another command.
    if (!b.has(k) || !sameJson(p, b.get(k))) out.push(p);
  }
  return out;
}

/** relay: depositIndex never moves back; relay.pending gains what we added and loses what we settled. */
function mergeRelayState(base, mine, disk) {
  if (mine == null && disk == null) return undefined;
  const out = { ...(disk ?? {}) };
  for (const k of Object.keys(mine ?? {})) {
    if (k !== "pending" && k !== "depositIndex" && !sameJson(mine[k], base?.[k])) out[k] = mine[k];
  }
  if (mine?.depositIndex !== undefined || disk?.depositIndex !== undefined) {
    out.depositIndex = Math.max(depositIndexOf({ relay: disk }), depositIndexOf({ relay: mine }));
  }
  if (mine?.pending !== undefined || disk?.pending !== undefined) {
    const list = (r) => pendingOf({ relay: r });
    const before = new Set(list(base).map((p) => p.outpoint));
    const now = new Set(list(mine).map((p) => p.outpoint));
    const merged = list(disk).filter((p) => !(before.has(p.outpoint) && !now.has(p.outpoint)));
    const have = new Set(merged.map((p) => p.outpoint));
    for (const p of list(mine)) {
      if (!before.has(p.outpoint) && !have.has(p.outpoint)) {
        merged.push({ n: p.n, outpoint: p.outpoint });
        have.add(p.outpoint);
      }
    }
    out.pending = merged.slice(-MAX_PENDING);
  }
  return out;
}

/**
 * The wallet file to write when this command read `base`, now holds `mine`, and `disk` is on
 * disk (another command may have saved since): every field as on disk except what this command
 * changed; `pending` and `relay` merged entry by entry. Pure; returns a new object.
 */
export function mergeWalletFile(base, mine, disk) {
  if (!disk) return cloneJson(mine);
  const out = cloneJson(disk);
  for (const k of Object.keys(mine)) {
    if (k !== "pending" && k !== "relay" && !sameJson(mine[k], base?.[k])) out[k] = cloneJson(mine[k]);
  }
  out.pending = cloneJson(mergePendingEntries(base?.pending, mine.pending, disk.pending));
  const relay = cloneJson(mergeRelayState(base?.relay, mine.relay, disk.relay));
  if (relay === undefined) delete out.relay;
  else out.relay = relay;
  return out;
}

/**
 * Opens the wallet file at `path` for update: `file` is the live object a command changes, and
 * save() merges this command's changes into the file on disk (mergeWalletFile) under its lock
 * and writes it atomically. Never writes back a stale copy of what other commands saved.
 */
export function openWalletFile(path, name = path) {
  const file = readWalletJson(path, name);
  let base = cloneJson(file);
  const save = () =>
    withFileLock(path, () => {
      const disk = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
      writeFileDurable(path, JSON.stringify(mergeWalletFile(base, file, disk), null, 2));
      base = cloneJson(file);
    });
  return { file, save };
}

/** A whole-file write of `f` (atomic, 0600), for callers that hold no merge base. */
const writeWalletFile = (name, f) => withFileLock(walletPath(name), () => writeFileDurable(walletPath(name), JSON.stringify(f, null, 2)));

function warnPreGenesis() {
  if (PRE_GENESIS) process.stderr.write(`pre-genesis: no genesis ATTEST is pinned in ${PINS_FILE}; state is not anchored yet\n`);
}

/**
 * The CLI's chain source (hook H2): src/btc/source.mjs openChainSource with its own header file
 * (cli-headers.json in the data directory) when that module exists; else, on a test network only,
 * this network's Esplora without header verification. Mainnet never runs without it.
 */
export async function openCliChainSource({
  network = NETWORK, test = IS_TESTNET, read = env, headersPath = CLI_HEADERS, log = console,
  sourceModule = join(ROOT, "src", "btc", "source.mjs"),
} = {}) {
  if (existsSync(sourceModule)) {
    const mod = await import(pathToFileURL(sourceModule).href);
    if (typeof mod.openChainSource === "function") return mod.openChainSource({ network, read, headersPath, log });
  }
  if (!test) throw new Error(`header verification is required on ${network}, and this build has no chain source module (src/btc/source.mjs)`);
  const esplora = new Esplora(read("ESPLORA") ?? ESPLORA_API);
  return { kind: "esplora", api: esplora, headers: null, save() {}, describe: () => `esplora ${esplora.base}` };
}

/**
 * A fresh HeaderChain for an audit replay from `from` (src/btc/headers.mjs, imported defensively),
 * or null where this build has none or no checkpoint lies at or below `from` (signet only; mainnet refuses).
 */
async function auditHeaderChain(from) {
  if (env("HEADERS") === "off" && IS_TESTNET) return null;
  const path = join(ROOT, "src", "btc", "headers.mjs");
  const mod = existsSync(path) ? await import(pathToFileURL(path).href) : null;
  if (!mod?.HeaderChain) {
    if (!IS_TESTNET) throw new Error(`header verification is required on ${NETWORK}, and this build has no src/btc/headers.mjs`);
    return null;
  }
  try {
    return new mod.HeaderChain({ network: NETWORK, startHeight: from });
  } catch (e) {
    if (!IS_TESTNET) throw e;
    process.stderr.write(`headers are not checked for this replay: ${e.message}\n`);
    return null;
  }
}

// Commands that run on mainnet before genesis (mainnet-readiness.md §4.6): wallet creation, its
// addresses, the genesis ATTEST itself and read-only commands. Everything that moves value waits.
const PRE_GENESIS_COMMANDS = new Set(["new", "address", "address-script", "attest", "sync", "assets", "log", "balance", "pending", "audit"]);
// Commands that never read the chain: they run without opening a chain source.
const OFFLINE_COMMANDS = new Set(["new", "address", "address-script"]);

/** Why `cmd` (with `args`) must not run on this network now, or null. */
export function commandRefusal(cmd, args = [], { test = IS_TESTNET, preGenesis = PRE_GENESIS, mineReason = params.mineFeeReady() } = {}) {
  if ((cmd === "mine" || cmd === "deploy-pow") && mineReason) return `${mineReason}; nothing was mined or launched (docs/MAINNET.md G5)`;
  if (test || !preGenesis) return null;
  if (PRE_GENESIS_COMMANDS.has(cmd)) return null;
  // No relay command before genesis: a relay account would hand out deposit addresses for real
  // coins that could neither pay for a transfer nor be withdrawn.
  return `${BRAND} has not launched on ${NETWORK}: no genesis is pinned in ${PINS_FILE}, so ${cmd} is refused. Only new, address, address-script, attest genesis and read-only commands run.`;
}

/** "tb" / "bc" address -> scriptPubKey hex, for this network only (the owner fills MINE_FEES.mainnet.platformScript with it). */
export function addressScriptHex(address) {
  let script;
  try {
    script = scriptOf(String(address ?? "").trim());
  } catch (e) {
    throw new Error(`not a Bitcoin ${NETWORK} address: ${e.message}`);
  }
  return hex(script);
}

/**
 * First run with this data directory: start from a copy of state.json (the server's snapshot,
 * or one an earlier CLI version wrote) instead of replaying from the activation height. The
 * copy is the CLI's own: loadIndexer may archive an incompatible one, never the original.
 * The paths are for tests. Returns true when it seeded.
 */
export function seedState({ state = STATE, shared = SHARED_STATE } = {}) {
  if (existsSync(state) || !existsSync(shared)) return false;
  const tmp = `${state}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    copyFileSync(shared, tmp);
    if (existsSync(state)) return false;
    renameSync(tmp, state);
    return true;
  } catch {
    return false; // a seed is only a shortcut: without it the CLI replays from the start
  } finally {
    rmSync(tmp, { force: true });
  }
}

async function synced() {
  warnPreGenesis();
  seedState();
  return syncInPlace(await loadIndexer(STATE, { vkey: vkey(), api }));
}

/** Catches `idx` up with the chain and saves it (also used to catch up mid-send). */
async function syncInPlace(idx) {
  const from = idx.height;
  const onBlock = (h, t) => process.stderr.write(`\rsync ${h}/${t}`);
  const headers = cliChain?.headers ?? null;
  const tip = headers ? await syncIndexer(idx, api, { onBlock, headers }) : await syncIndexer(idx, api, { onBlock });
  if (tip > from) process.stderr.write("\n");
  saveIndexer(STATE, idx);
  cliChain?.save?.();
  return idx;
}

/**
 * W-1: anyone may re-carry a sent envelope until anchor + ANCHOR_WINDOW, so its notes
 * stay locked until the synced index has its verdict, its nullifiers are spent, or
 * that window has passed. Decided from the index only: an explorer error never unlocks.
 * Older entries have no anchor. The CLI anchors at its synced height, so the height an
 * entry is first seen at bounds its anchor from above: the lock may run long, but it ends.
 * A relayed entry has no txid until the relayer broadcasts it, so only its spends or
 * its window release it. Mining claims (`kind: "mine"`) follow W-M instead (keepMineEntry).
 * Returns the entries still pending.
 */
export function keepPending(pending, idx) {
  for (const p of pending) if (p.anchor == null && p.kind !== "mine") p.anchorMax ??= idx.height;
  return pending.filter((p) => {
    if (p.kind === "mine") return keepMineEntry(p, idx);
    if (p.txid && idx.log.some((l) => l.txid === p.txid)) return false;
    if (p.spends.every((n) => idx.nullifiers.has(String(n)))) return false;
    return idx.height <= (p.anchor ?? p.anchorMax) + ANCHOR_WINDOW;
  });
}

/**
 * W-M (mining.md §8.1): a mining claim's entry, and with it its solution and the notes rolled into
 * it, stays until its carrier has a verdict in the index, its solution is claimed (by any carrier),
 * or block ref + 12 is indexed, after which it can no longer land. A spent rolled note alone does
 * not end it, and neither does an error or a refusal: the envelope left this machine.
 */
export function keepMineEntry(p, idx) {
  if (p.txid && idx.log.some((l) => l.txid === p.txid)) return false;
  if (p.solutionId && idx.claimed?.has?.(p.solutionId)) return false;
  return idx.height < p.lockUntil;
}

/** Opens a wallet against the synced index: locks the notes of pending entries; saves only when the pending list changed. */
async function openWallet(name, idx) {
  const { file, save } = openWalletFile(walletPath(name), name);
  const wallet = new Wallet(deriveKeys(Buffer.from(file.seed, "hex")), ARTIFACTS).scan(idx);
  const before = JSON.stringify(file.pending ?? null);
  const still = keepPending(file.pending ?? [], idx);
  file.pending = still;
  for (const p of still.filter((x) => x.anchor == null && x.kind !== "mine")) {
    process.stderr.write(`pending ${short(p.txid)} predates anchor tracking: its notes stay locked until it lands or block ${p.anchorMax + ANCHOR_WINDOW + 1}\n`);
  }
  still.forEach((p) => p.spends.forEach((n) => wallet.locked.add(n)));
  if (JSON.stringify(still) !== before) save();
  return { wallet, file, save, btcKey: Buffer.from(file.btcKey, "hex") };
}

function assetByTicker(idx, ticker) {
  const id = idx.tickers.get(ticker.toUpperCase());
  if (id === undefined) throw new Error(`unknown ticker ${ticker} (run: ${CLI} assets)`);
  return idx.assets.get(id);
}

/** --key value pairs; a flag followed by another flag (or nothing) is boolean true. */
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const next = args[i + 1];
    flags[args[i].slice(2)] = next === undefined || next.startsWith("--") ? true : (i++, next);
  }
  return flags;
}

/**
 * Flags of one command, strictly: each of `values` takes a value (--x v or --x=v), each of
 * `booleans` takes none. An unknown flag, a flag given twice, a value on a boolean flag, a
 * missing value or a stray argument is refused before anything is read or broadcast, so a
 * typo never becomes permanent DEPLOY terms or turns a --dry-run into a broadcast. -> { flag: string | true }
 */
export function parseStrictFlags(args, { values = [], booleans = [], usage = "" } = {}) {
  const out = {};
  const fail = (msg) => {
    throw new Error(usage ? `${msg}\n${usage}` : msg);
  };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (!a.startsWith("--")) fail(`unexpected argument "${a}"`);
    const eq = a.indexOf("=");
    const flag = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (!values.includes(flag) && !booleans.includes(flag)) fail(`unknown flag ${eq < 0 ? a : a.slice(0, eq)}`);
    if (Object.hasOwn(out, flag)) fail(`--${flag} given twice`);
    if (booleans.includes(flag)) {
      if (eq >= 0) fail(`--${flag} takes no value`);
      out[flag] = true;
      continue;
    }
    const v = eq >= 0 ? a.slice(eq + 1) : args[++i];
    if (v === undefined || v === "" || String(v).startsWith("--")) fail(`--${flag} needs a value`);
    out[flag] = String(v);
  }
  return out;
}

/** A flag that must be a whole number, as a string; refuses "-1", "1e3", "120,000" and a bare flag. */
function whole(flags, name, fallback) {
  const v = flags[name] ?? fallback;
  if (!/^\d+$/.test(String(v))) throw new Error(`--${name} must be a whole number`);
  return String(v);
}

async function broadcast(tx, label) {
  const txid = await api.broadcast(tx.hex);
  console.log(`${label} broadcast: ${txid}  (${tx.vsize} vB, fee ${tx.fee} sats)`);
  console.log(`  ${EXPLORER}/tx/${txid}`);
  return txid;
}

const short = (txid) => `${txid.slice(0, 12)}…`;
const assetRef = (id) => `${id >> 32n}:${id & 0xffffffffn}`;

/** Names which digest input differs at the first diverging height, as far as the remote API allows. */
async function diagnose(idx, height, getJson) {
  if (idx.digestAt(height) === null) return "the local replay does not reach this block";
  let remote;
  try {
    remote = await getJson(`/api/digest?height=${height}`);
  } catch {
    return "the remote indexer has no digest for this block";
  }
  if (remote.blockHash !== idx.hashes.get(height)) return "block hash: the two sides follow different chains";
  if (BigInt(remote.root) !== idx.roots.get(height)) return "root: the note tree (outputs) differs";
  const mine = idx.log.filter((l) => l.height === height);
  const seq = mine.length ? mine[0].seq : idx.log.filter((l) => l.height < height).length;
  const theirs = (await getJson(`/api/log?from=${seq}&limit=${Math.max(1, mine.length + 1)}`)).items.filter((l) => l.height === height);
  const key = (l) => `${l.txid}:${l.op}:${l.ok}`;
  if (mine.length !== theirs.length || mine.some((l, i) => key(l) !== key(theirs[i]))) return "log: different envelopes accepted or rejected";
  return "nullifier set or asset table (root and log agree)";
}

// ------------------------------------------------- relayed sends (batch-contract §6)
//
// Relay balances (docs/design/relay-balance.md, build contract relay-balance-contract.md §6):
// the user tops up a balance with a plain BTC payment to a fresh deposit address, and the
// relayer charges each relayed send its exact carrier fee plus a margin from that balance.
// The operator never pays any part of a user's transaction, and no command here adds coins
// to the relayer: only a user's credited deposit does. A self-paid send (no --relay) stays
// the default and needs no relayer.

/** True when the relayer behind `info` carries sends paid from relay balances (balanceInfo then also checks its pool key). */
export const relayOpenAt = (info) => info?.enabled === true && info?.mode === "balance";

/** What `send --relay` (and `retry`) print when no relayer with relay balances runs at `url`. */
export const relayUnavailable = (url) =>
  `relaying is unavailable at ${url}: no relayer with relay balances runs there. Nothing was handed over. Send without --relay to pay the fee from this wallet's BTC fee key, which ties the transfer to that address on Bitcoin.`;

/**
 * The `open` that listPending and pickRetry assume when the caller has not read relay info:
 * closed. The commands pass relayOpenAt(info) instead (an unreachable relayer counts as closed).
 */
export const RELAY_OPEN = false;

export const DEFAULT_RELAY = "http://localhost:8787";

/**
 * A relayer URL the CLI talks to, without trailing slashes: https://, or plain http:// only to
 * this machine (localhost, *.localhost, 127.0.0.0/8, [::1]) or a .onion address. Over plain
 * http to any other host an on-path attacker could swap the relayer's pool key, and with it
 * the deposit address `relay topup --pay` pays, or fake balances and statuses. `what` names
 * the source in the refusal (a flag or MURKLE_RELAY_URL).
 */
export function checkRelayUrl(url, what = "--relay") {
  const s = String(url ?? "");
  let u = null;
  try {
    u = /^https?:\/\/[^\s/]+/i.test(s) ? new URL(s) : null;
  } catch {
    u = null;
  }
  if (!u) throw new Error(`${what} takes an http(s) URL, not "${s}"`);
  if (u.protocol === "http:") {
    const h = u.hostname.toLowerCase().replace(/\.$/, "");
    const local = h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h.endsWith(".onion");
    if (!local) {
      throw new Error(`${what}: plain http:// is allowed only for a relayer on this machine or a .onion address; use https:// for ${u.host}`);
    }
  }
  return s.replace(/\/+$/, "");
}
const TIMING_FLAGS = ["fast", "batch", "batch10"];
const MODE_NAME = { block: "next block", fast: "fast", batch: "hourly batch", batch10: "10-hour batch" };
// A pending entry an older CLI saved in the retired 12-hour batch. Shown by `murkle pending`
// only: relaySend never takes it, and `murkle retry` sends it with the 10-hour batch.
const RETIRED_MODE_NAME = { batch12: "12-hour batch (retired)" };
const STATE_POLL_MS = 30_000; // before releaseAt: chain height only
const STATUS_POLL_MS = 15_000; // from releaseAt: the item's status
const BUSY_RETRIES = 3;
const FINAL = new Set(["accepted", "rejected", "expired", "dropped", "missed"]);
const EXIT = { accepted: 0, queued: 0, error: 1, not_eligible: 3, refused: 4, rejected: 4, expired: 4, dropped: 4, missed: 4, unknown: 4, timeout: 5, interrupted: 130 };
/** The approved timing warning (relay-balance.md §5), printed while few relayed transfers landed since the newest top-up. */
export const RECENT_DEPOSIT =
  "Your top-up confirmed recently and few people are relaying right now. Sending now can link this transfer to the address you paid from. A batch mode, or waiting, hides this better.";
/**
 * L1 (relay-balance.md "Pool cover"): the relay pool is thin for this send, so its carrier's input
 * would descend from few top-ups, possibly only yours. The relayer's own 409 pool_thin text.
 */
export const POOL_THIN =
  "Too few people have topped up the relay pool, so this send's input would tie it to your top-up address. Pay the fee yourself, or confirm to send it linkable.";
/**
 * L1: printed before a relayed send or claim when the relayer publishes no lineage (an older
 * relayer): the CLI then knows nothing about the carrier's coin, as the web says (mixUnknown).
 */
export const MIX_UNKNOWN =
  "this relayer does not publish how many depositors its coins descend from, so the carrier's input may tie this to the address you topped up from";
/** The smallest k the CLI counts as cover (as the web's MIN_COVER_K): below it, every relayed send is linkable. */
export const MIN_COVER_K = 3;
/** Printed for a send the relayer accepted as linkable: it never claims the sender is hidden. */
export const LINKABLE_LINE = "sent linkable: its carrier's input can tie it to your top-up address, so it does not hide that you sent it";
/** L3 (privacy-trace-test.md): the effective-crowd warnings, as in the web wallet. Advice only. */
export const CROWD_FEW = "Few transfers to hide among: an observer can likely tell this came from you.";
export const BATCH_ALONE = "A batch hides nothing while it holds only your transfer.";
/** What the relayer can see (relay-balance.md §5), printed before a relayed send and by `relay topup`. */
const OPERATOR_LINE = "the relayer can link the address you top up from to every transfer you relay with this balance; Tor does not prevent this";
const RECENT_LANDED = 5; // fewer relayed transfers than this since the newest credit: warn

/** "6,055" */
const int = (n) => Number(n).toLocaleString("en-US");

let relayLib = null;
/**
 * The shared relay-account module (src/relay-account.mjs, contract §1), loaded on first use so
 * that commands which never relay run without it. Tests pass their own `lib` instead.
 */
export async function loadRelayLib() {
  return (relayLib ??= await import("../src/relay-account.mjs"));
}

/** The wallet's relay account (contract §6.1): derived from the wallet file's 32-byte seed. */
export function relayAccountOf(file, lib) {
  return lib.relayAccount(new Uint8Array(Buffer.from(String(file.seed), "hex")), NETWORK);
}

/** The deposit address number the wallet shows: `relay.depositIndex` of the wallet file, 0 for older files. */
export function depositIndexOf(file) {
  const n = file?.relay?.depositIndex;
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

/** Moves `relay.depositIndex` forward (never back) and saves when it moved. */
function advanceDepositIndex(file, n, save) {
  if (n <= depositIndexOf(file)) return false;
  file.relay = { ...(file.relay ?? {}), depositIndex: n };
  save();
  return true;
}

const MAX_PENDING = 50;
/**
 * Top-ups paid but not credited yet: `relay.pending` of the wallet file, [{ n, outpoint }] (the
 * web wallet keeps the same list). `relay topup --pay` adds its payment, a scan adds every
 * payment it sees at a deposit address, and a plain `relay credit` tries each one again, so a
 * payment is never stranded behind the deposit address number moving on.
 */
export function pendingOf(file) {
  const list = Array.isArray(file?.relay?.pending) ? file.relay.pending : [];
  return list.filter((p) => p && Number.isSafeInteger(p.n) && p.n >= 0 && typeof p.outpoint === "string" && /^[0-9a-f]{64}:\d+$/.test(p.outpoint));
}

/** Adds `{ n, outpoint }` rows to `relay.pending` (once per outpoint) and saves when the list changed. */
function addPending(file, rows, save) {
  const list = pendingOf(file);
  const have = new Set(list.map((p) => p.outpoint));
  const fresh = rows.filter((r) => !have.has(r.outpoint) && have.add(r.outpoint)).map(({ n, outpoint }) => ({ n, outpoint }));
  if (!fresh.length) return;
  file.relay = { ...(file.relay ?? {}), pending: [...list, ...fresh].slice(-MAX_PENDING) };
  save();
}

/** Removes the outpoints in `done` from `relay.pending` and saves when the list changed. */
function dropPending(file, done, save) {
  const list = pendingOf(file);
  const left = list.filter((p) => !done.has(p.outpoint));
  if (left.length === list.length) return;
  file.relay = { ...(file.relay ?? {}), pending: left };
  save();
}

/** Relay info of a relayer that must be in balance mode on this network; throws a one-line reason otherwise. */
async function balanceInfo(client, url) {
  let info;
  try {
    info = await client.info();
  } catch {
    info = null;
  }
  if (!relayOpenAt(info)) throw new Error(relayUnavailable(url));
  if (info.network !== NETWORK) throw new Error(`the relayer at ${url} runs on ${info.network ?? "an unknown network"}, not ${NETWORK}`);
  if (!/^[0-9a-f]{64}$/.test(String(info.balance?.poolKey ?? ""))) throw new Error(`the relayer at ${url} published no valid pool key; nothing was sent`);
  return info;
}

/** The deposit address `n` of `account` at the relayer behind `info`. */
const depositOf = (lib, info, account, n) => lib.depositAddress(lib.parsePoolKey(info.balance.poolKey), account.id, n, info.network);

/** A refusal body as one readable phrase: "code (message)". */
const refusalText = (res) => {
  const err = res?.body?.error ?? {};
  return `${err.code ?? `http_${res?.status}`}${err.message ? ` (${err.message})` : ""}`;
};

/**
 * Signed account read (contract §4.2 POST /api/relay/account). Checks that the relayer's
 * deposit address for `nextIndex` is the one this wallet derives from the pool key in the same
 * relay info. That catches a relayer that disagrees with itself, not a substituted one: both
 * sides come from that relayer's answers, which is why plain http:// is refused for any host
 * but this machine or a .onion address (checkRelayUrl). -> { accountId, balance, reserved, nextIndex, depositAddress, credits }
 */
export async function readRelayAccount({ client, info, account, lib, now = Date.now }) {
  const body = lib.signRequest({
    account, endpoint: lib.RELAY_ENDPOINTS.account, network: info.network, poolKey: lib.parsePoolKey(info.balance.poolKey), fields: {}, now,
  });
  const res = await client.account(body);
  if (res.status !== 200 || !res.body) throw new Error(`the relayer refused the balance read: ${refusalText(res)}`);
  const a = res.body;
  for (const k of ["balance", "reserved", "nextIndex"]) {
    if (!Number.isSafeInteger(a[k]) || a[k] < 0) throw new Error(`the relayer answered the balance read without a valid ${k}`);
  }
  if (a.depositAddress !== depositOf(lib, info, account, a.nextIndex).address) {
    throw new Error("The relayer's deposit address doesn't match this wallet. Nothing was paid.");
  }
  return { ...a, credits: Array.isArray(a.credits) ? a.credits : [] };
}

/** "per send ~657 sats (fee 597 + margin 60 at 1 sat/vB)", from relay info. */
function perSendText(info) {
  const per = info.balance?.perSendSats;
  const fee = info.fees?.carrierFeeSats;
  if (!Number.isSafeInteger(per) || !Number.isSafeInteger(fee)) return "per send: not quoted yet (the relayer does not know the fee rate)";
  return `per send ~${int(per)} sats (fee ${int(fee)} + margin ${int(per - fee)} at ${info.fees.feeRate} sat/vB)`;
}

/** Relayed transfers that landed above `height`, from info.stats.landed144 ([[height, count], ...]). */
function landedSince(info, height) {
  const rows = Array.isArray(info.stats?.landed144) ? info.stats.landed144 : [];
  return rows.reduce((s, [h, c]) => s + (Number(h) > height && Number.isSafeInteger(c) ? c : 0), 0);
}

/**
 * Whether to print RECENT_DEPOSIT for the newest credit at `since`: fewer than 5 relayed
 * transfers landed after it. landed144 covers only the last 144 blocks, so the count is exact
 * only for a credit inside that window; an older top-up is not "recent" and is never warned about.
 */
export function recentDepositWarning(info, since) {
  if (since === null || !Number.isSafeInteger(info?.height) || since < info.height - 144) return false;
  return landedSince(info, since) < RECENT_LANDED;
}

/** The relay pool's published cover (relay info balance.mix, L1): { k, coverOk, depositors }, or null when not published. */
export function poolCoverOf(info) {
  const m = info?.balance?.mix;
  if (!m || typeof m !== "object" || typeof m.coverOk !== "boolean") return null;
  return { k: Number.isSafeInteger(m.k) ? m.k : null, coverOk: m.coverOk, depositors: Number.isSafeInteger(m.depositors) ? m.depositors : null };
}

/**
 * Whether a published cover gives none (L1): no covering coin now, or a relayer whose k is below
 * MIN_COVER_K (MURKLE_RELAY_MIN_MIX=0 turns its rule off) or unreadable. null cover: not thin,
 * unknown (MIX_UNKNOWN is printed instead).
 */
export function coverThin(cover) {
  return Boolean(cover) && (cover.coverOk === false || !(cover.k >= MIN_COVER_K));
}

/** The published waiting count of the batch a send in `mode` would join, or null. */
function batchQueued(info, mode) {
  const q = info?.batch?.modes?.[mode]?.current?.queued;
  return Number.isSafeInteger(q) && q >= 0 ? q : null;
}

/** The thin-pool refusal, printed before anything is proved or handed over. */
export function poolThinLines(cover, { what = "send", retry = null } = {}) {
  const who = cover?.depositors == null ? "" : `${int(cover.depositors)} account${cover.depositors === 1 ? " has" : "s have"} topped up this relay pool; `;
  const k = cover?.k == null
    ? ""
    : cover.k < MIN_COVER_K
      ? `this relayer asks a carrier's coin to descend from only ${cover.k} accounts besides the sender, too few to hide one. `
      : `a carrier needs coin history from at least ${cover.k + 1} accounts (${cover.k} besides whoever sends). `;
  const self = what === "claim" ? "use --pay key" : "send without --relay";
  return [POOL_THIN, `${who}${k}To relay this ${what} anyway, add --linkable${retry ? ` (${retry})` : ""}; to pay the fee yourself, ${self}. Nothing was handed over`];
}

/** The newest credited deposit's height, or null. */
function newestCreditHeight(account) {
  const hs = account.credits.map((c) => c?.height).filter((h) => Number.isSafeInteger(h));
  return hs.length ? Math.max(...hs) : null;
}

/** Process exit code for a relaySend / waitForRelay result (batch-contract §6.4). */
export const exitCodeFor = (result) => EXIT[result?.status] ?? 1;

/** "about 50 min" for a number of blocks at 10 minutes each (the web app's wording). */
function eta(blocks) {
  const min = Math.max(0, Number(blocks)) * 10;
  if (min < 60) return `about ${Math.max(10, Math.round(min / 10) * 10)} min`;
  if (min < 48 * 60) return `about ${Math.round(min / 60)} h`;
  return `about ${Math.round(min / 1440)} d`;
}

const delay = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/**
 * Relay flags of send / retry / pending: --relay [url], one of --fast / --batch /
 * --batch10, --no-wait, --wait-max <minutes>, --linkable (L1: relay even while the pool is thin,
 * accepting that the carrier's input can tie the send to your top-up); the rest are positional. `--relay`
 * takes the next argument only when it is an http(s) URL (or as --relay=<url>).
 * `implied` (retry) relays without --relay. `mode` is the timing flag, else
 * "block" when relaying; `timing` is the flag alone (null when none was given).
 */
export function parseRelayFlags(args, { read = env, implied = false } = {}) {
  const out = { args: [], relay: implied, url: null, urlGiven: false, timing: null, mode: null, wait: true, waitMaxMs: null, linkable: false };
  const timings = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (!a.startsWith("--")) {
      out.args.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const flag = eq < 0 ? a.slice(2) : a.slice(2, eq);
    const inline = eq < 0 ? undefined : a.slice(eq + 1);
    if (flag === "relay") {
      out.relay = true;
      const url = inline ?? (/^https?:\/\//i.test(args[i + 1] ?? "") ? args[++i] : undefined);
      if (url === undefined) continue;
      out.url = checkRelayUrl(url);
      out.urlGiven = true;
    } else if (TIMING_FLAGS.includes(flag) && inline === undefined) timings.add(flag);
    else if (flag === "no-wait" && inline === undefined) out.wait = false;
    else if (flag === "linkable" && inline === undefined) out.linkable = true;
    else if (flag === "wait-max") {
      const v = inline ?? args[++i];
      if (!/^\d+(\.\d+)?$/.test(v ?? "") || !(Number(v) > 0)) throw new Error("--wait-max takes a number of minutes above 0");
      out.waitMaxMs = Number(v) * 60_000;
    } else throw new Error(`unknown flag ${a}`);
  }
  if (timings.size > 1) throw new Error("choose one of --fast, --batch, --batch10");
  out.timing = [...timings][0] ?? null;
  if (!out.relay && out.timing) throw new Error(`--${out.timing} needs --relay: a self-paid send goes out at once`);
  if (!out.relay && (!out.wait || out.waitMaxMs !== null)) throw new Error("--no-wait and --wait-max need --relay");
  if (!out.relay && out.linkable) throw new Error("--linkable needs --relay: a self-paid send is paid from this wallet's BTC fee key");
  if (out.relay) {
    out.url ??= checkRelayUrl(read("RELAY_URL") || DEFAULT_RELAY, "MURKLE_RELAY_URL");
    out.mode = out.timing ?? "block";
  }
  return out;
}

/**
 * HTTP client for a relayer (an indexer server running the paid relayer). submit(),
 * account() and credit() answer { status, body } like the relayer; status() is null for
 * an id the relayer does not know (404).
 */
export function relayClient(url, { fetchFn = fetch, timeoutMs = 30_000 } = {}) {
  const call = async (path, init = {}) => {
    let res;
    try {
      res = await fetchFn(url + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw Object.assign(new Error(`relayer at ${url} unreachable (${e.cause?.code ?? e.cause?.message ?? e.message})`), { code: "unreachable" });
    }
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };
  const get = async (path) => {
    const r = await call(path);
    if (r.status !== 200 || !r.body) throw new Error(`GET ${url}${path}: HTTP ${r.status}${r.body?.error?.message ? ` (${r.body.error.message})` : ""}`);
    return r.body;
  };
  const post = (path, body) => call(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return {
    info: () => get("/api/relay/info"),
    state: () => get("/api/state"),
    submit: (body) => post("/api/relay/submit", body),
    account: (body) => post("/api/relay/account", body),
    credit: (body) => post("/api/relay/credit", body),
    /** GET /api/mine/:asset (mining-contract.md §9.7), or null when that server knows no such mined token. */
    async mineAsset(idOrTicker) {
      const r = await call(`/api/mine/${encodeURIComponent(String(idOrTicker).toUpperCase())}`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body) throw new Error(`GET ${url}/api/mine: HTTP ${r.status}`);
      return r.body;
    },
    async status(id) {
      const r = await call(`/api/relay/status/${encodeURIComponent(id)}`);
      if (r.status === 404) return null;
      if (r.status !== 200 || !r.body) throw new Error(`GET ${url}/api/relay/status: HTTP ${r.status}`);
      return r.body;
    },
  };
}

/**
 * A gate in relay info that refuses this timing anyway: checked before proving or locking notes.
 * `info.code` is the relayer's first failing gate for a Next-block send (contract §4.2).
 */
function refusalFrom(info, mode) {
  const m = info.batch?.modes?.[mode];
  if (isBatchMode(mode) && m) {
    if (m.enabled === false || m.maxPerEpoch === 0) return "batch_disabled";
    if (m.current && m.current.queued >= m.maxPerEpoch) return "batch_full";
  }
  const r = info.code ?? null;
  if (!r || r === "busy") return null; // busy is transient: the submit retries it
  if (isBatchMode(mode) && (r === "block_full" || r === "queue_full")) return null; // batch items count apart
  return r;
}

const scheduleLine = (mode, h, sched) =>
  sched
    ? `${MODE_NAME[mode]}: anchor ${sched.start}, goes out after block ${sched.releaseAt}, relayer deadline ${sched.lastRelease}, notes reserved until ${sched.deadline}`
    : `${MODE_NAME[mode]}: anchor ${h}, notes reserved until ${h + ANCHOR_WINDOW}`;

/**
 * A relayed send (batch-contract §6.2, relay-balance-contract §6.1): check that the relayer
 * takes relay balances and that this wallet's balance covers the send (a signed account
 * read, before anything is proved or written), anchor (the epoch start S for a batch),
 * select with the notes that existed there, prove and check locally, write the pending
 * entry (W-1) before anything leaves, then hand the envelope over in a request signed by
 * the relay account (contract §1). `client` is { info, state, account, submit, status };
 * `lib` the relay-account module (loaded when not given); `account` the relay account
 * (derived from `file.seed` when not given). `entry` (retry) reproves an earlier entry
 * with its own notes. Returns { status, entry, ... } for exitCodeFor; throws only on a
 * local error before anything is written.
 */
export async function relaySend({
  idx, wallet, file, name, client, mode = "block", url = DEFAULT_RELAY, ticker, amount, to, entry = null, linkable = false,
  print = console.log, warn = (s) => process.stderr.write(`${s}\n`), now = Date.now,
  save = () => writeWalletFile(name, file), resync = () => syncInPlace(idx), sleep = delay, lib = null, account = null,
}) {
  if (!MODE_NAME[mode]) throw new Error(`unknown relay timing "${mode}"`);
  const batch = isBatchMode(mode);
  const asset = assetByTicker(idx, String(ticker));
  if (!/^\d+$/.test(String(amount)) || BigInt(amount) === 0n) throw new Error("amount must be a whole number above 0");
  const value = BigInt(amount);
  const recipient = decodeAddress(String(to));
  const inputs = entry?.spends;

  let info = await balanceInfo(client, url);
  print(`relay ${url} (${info.network}), relayer height ${info.height}`);
  const refusal = refusalFrom(info, mode);
  if (refusal) {
    const self = refusal === "fee_high" || refusal === "halted" || EMERGENCY_CODES.includes(refusal) ? "; send without --relay to pay the fee from this wallet's BTC fee key" : "";
    throw new Error(`the relayer is not taking ${MODE_NAME[mode]} transfers right now (${refusal}); nothing was sent${self}`);
  }

  // The relay balance must cover this send before anything is proved, locked or written.
  lib ??= await loadRelayLib();
  account ??= relayAccountOf(file, lib);
  const perSend = info.balance.perSendSats;
  if (!Number.isSafeInteger(perSend)) {
    throw new Error("the relayer does not know the fee rate yet, so it cannot quote this send; nothing was sent. Try again in a minute");
  }
  const headroom = batch ? (Number.isSafeInteger(info.balance.batchHeadroom) ? info.balance.batchHeadroom : 2) : 1;
  const need = perSend * headroom;
  const acct = await readRelayAccount({ client, info, account, lib, now });
  if (acct.balance < need) {
    print(`relay balance ${int(acct.balance)} sats; this send needs about ${int(need)}. Nothing was handed over. Top up: ${CLI} relay topup ${name}`);
    return { status: "error", code: "balance_low", balance: acct.balance, needed: need };
  }
  print(
    `relay balance ${int(acct.balance)} sats available; this send costs about ${int(perSend)} sats` +
      (batch ? `, and ${int(need)} are reserved until its batch goes out (the difference comes back)` : ""),
  );
  print(`${OPERATOR_LINE}; it cannot see amounts, tokens or recipients`);
  // L1: while the pool is thin the carrier's input ties the send to the top-up; only with --linkable.
  const cover = poolCoverOf(info);
  if (!cover) print(MIX_UNKNOWN);
  else if (coverThin(cover)) {
    if (linkable !== true) {
      for (const line of poolThinLines(cover, { retry: entry ? `${CLI} retry ${name} --linkable` : null })) print(line);
      return { status: "error", code: "pool_thin", cover };
    }
    print("the relay pool is thin: sending linkable, as --linkable asked; the carrier's input can tie this transfer to your top-up address");
  }
  if (recentDepositWarning(info, newestCreditHeight(acct))) {
    print(RECENT_DEPOSIT);
    if (batchQueued(info, "batch") === 0) print(BATCH_ALONE); // L3: the suggested batch holds nobody yet
  }

  // Anchor: the epoch start for a batch, else the lower tip (the relayer must know the root).
  const anchored = async () => {
    const sched = batch ? batchSchedule(info.height, mode, { safety: info.batch?.modes?.[mode]?.safety }) : null;
    const need = batch ? sched.start : (info.anchor?.minAnchor ?? 0);
    if (idx.height < need) {
      await resync();
      wallet.scan(idx);
    }
    if (idx.height < need) throw new Error(`local index is behind the relayer (local ${idx.height}, relayer ${info.height}); run sync`);
    const h = batch ? sched.start : Math.min(idx.height, info.height);
    if (batch && h < idx.startHeight - 1) return { h, sched, anchor: null }; // just after activation
    const anchor = anchorAt(idx, h);
    if (anchor.tree.root() !== idx.roots.get(h)) throw new Error(`the local tree at block ${h} does not match the replayed root; run sync`);
    return { h, sched, anchor };
  };
  const proveAt = async ({ h, anchor }, notes) => {
    print(`proving transfer of ${value} ${asset.ticker} against block ${h}…`);
    const envelope = await wallet.transfer(idx, { asset: asset.id, amount: value, to: recipient, inputs: notes, anchor });
    const verdict = await idx.checkTx(decodeEnvelope(envelope), { inputs: [], outputs: [] }, idx.height + 1);
    if (verdict !== true) throw new Error(`the transfer fails the local check (${verdict})`);
    print(`proof checked locally against the root at ${h}`);
    return envelope;
  };
  const notEligible = (h, eligibleAt, why = `the note this send needs arrived after block ${h}`) => {
    print(`not in this batch: ${why}; it can join the batch that starts at block ${eligibleAt} (${eta(eligibleAt - info.height)}), or send without --${mode} now`);
    return { status: "not_eligible", mode, start: h, eligibleAt };
  };

  let at = await anchored();
  if (!at.anchor) {
    const e = EPOCH_BLOCKS[mode];
    return notEligible(at.h, Math.ceil(idx.startHeight / e) * e, `the pool started after block ${at.h}`);
  }
  try {
    const maxLeaf = at.anchor.tree.size;
    if (inputs) wallet.notesFor(asset.id, value, inputs, { maxLeaf });
    else wallet.selectNotes(asset.id, value, { maxLeaf }); // fail fast before proving
  } catch (e) {
    if (e.code !== "NOTE_TOO_NEW") throw e;
    if (batch) return notEligible(at.h, at.sched.releaseAt);
    throw new Error(`the note this send needs arrived after block ${at.h}, which the relayer has not reached yet; try again after the next block`);
  }
  print(scheduleLine(mode, at.h, at.sched));
  // L3: the effective crowd at the proof's anchor (other people's value notes) and in the batch. Advice only.
  const crowd = crowdCheck({
    candidates: candidateNotes({ outputs: idx.outputs, leaves: at.anchor.tree.size, log: idx.log, own: wallet.notes.map((n) => n.leafIndex) }),
    mode, queued: batch ? batchQueued(info, mode) : null,
  });
  if (crowd.fewNotes) print(`${CROWD_FEW} ${int(crowd.candidates)} note${crowd.candidates === 1 ? "" : "s"} of other people ${crowd.candidates === 1 ? "is" : "are"} in the pool at block ${at.h}.`);
  if (crowd.alone) print(BATCH_ALONE);
  if (batch) {
    print("the relayer still sees your IP address and when you submitted; anyone can watch its waiting count, which changes once per block, so with few transfers the block you submitted in can be read from it");
    if (mode === "batch10") {
      print(`a 10-hour batch is a separate crowd: it lands at block ${at.sched.landsAt}, while hourly transfers anchored at block ${at.h} land at block ${at.h + 7}, so it only hides among other 10-hour transfers`);
    }
  }
  const envelope = await proveAt(at, inputs);

  // W-1: the entry exists before the envelope leaves this machine.
  const fields = {
    via: "relay", relay: url, relayId: null, mode, ticker: asset.ticker, amount: String(value), to: String(to),
    spends: envelope.spends, anchor: at.h, ...(batch ? { releaseAt: at.sched.releaseAt, lastRelease: at.sched.lastRelease } : {}),
    envelope: hex(envelope), status: "relaying", createdAt: now(),
  };
  if (entry) {
    // Retry: either envelope may still land, so the lock runs to the later anchor + 100.
    for (const k of ["txid", "error", "reason", "height", "releaseAt", "lastRelease", "epochQueued", "missedCode", "cost"]) delete entry[k];
    Object.assign(entry, fields, { anchor: Math.max(entry.anchor ?? at.h, at.h) });
  } else {
    entry = fields;
    file.pending ??= [];
    file.pending.push(entry);
  }
  entry.spends.forEach((n) => wallet.locked.add(String(n)));
  save();

  let handedOut = false;
  const fail = (code, reason) => {
    Object.assign(entry, { status: "failed", error: code, reason });
    save();
    const topUp = code === "balance_low"
      ? `; to top up: ${CLI} relay topup ${name}, or send without --relay`
      : code === "pool_thin" ? `; to relay it anyway: ${CLI} retry ${name} --linkable, or send without --relay` : "";
    print(`relay failed: ${code} (${reason}); notes stay reserved until block ${entry.anchor + ANCHOR_WINDOW} unless it lands: ${CLI} retry ${name}${topUp}`);
    return { status: handedOut ? "refused" : "error", code, entry };
  };
  // Signed per attempt with a fresh t, so a repeated request is never a replay (contract §1).
  const signed = () =>
    lib.signRequest({
      account, endpoint: lib.RELAY_ENDPOINTS.submit, network: info.network, poolKey: lib.parsePoolKey(info.balance.poolKey),
      fields: linkable === true ? { envelope: entry.envelope, mode, linkable: true } : { envelope: entry.envelope, mode }, now,
    });
  let res;
  try {
    const tried = new Set();
    const once = (code) => !tried.has(code) && Boolean(tried.add(code));
    let busy = 0;
    for (;;) {
      const body = signed();
      handedOut = true;
      res = await client.submit(body);
      if (res.status === 202) break;
      const err = res.body?.error ?? {};
      const code = err.code ?? `http_${res.status}`;
      if (code === "busy" && busy++ < BUSY_RETRIES) {
        warn("the relayer is busy; trying again in 5 s");
        await sleep(5000);
      } else if (code === "epoch_closed" && batch && once(code)) {
        // Same notes, so the closed batch's envelope and this one can't both land.
        print("the batch closed while proving; proving again for the next batch");
        info = await balanceInfo(client, url);
        at = await anchored();
        if (!at.anchor) throw new Error(`no tree for the batch at block ${at.h}`);
        print(scheduleLine(mode, at.h, at.sched));
        const again = await proveAt(at, entry.spends);
        Object.assign(entry, { envelope: hex(again), anchor: Math.max(entry.anchor, at.h), releaseAt: at.sched.releaseAt, lastRelease: at.sched.lastRelease });
        save();
      } else return fail(code, err.message ?? `HTTP ${res.status}`);
    }
  } catch (e) {
    return fail(e.code === "unreachable" ? "unreachable" : "error", e.message);
  }

  const b = res.body ?? {};
  if (typeof b.id !== "string") return fail("malformed", "the relayer answered 202 without a relay id");
  Object.assign(entry, { relayId: b.id });
  if (b.linkable === true || b.thin === true) entry.linkable = true;
  else delete entry.linkable;
  if (batch) {
    Object.assign(entry, { releaseAt: b.releaseAt ?? entry.releaseAt, lastRelease: b.lastRelease ?? entry.lastRelease, epochQueued: b.epochQueued ?? null });
  }
  save();
  const id = `${b.id.slice(0, 12)}…`;
  if (batch) {
    print(`scheduled: relay id ${id}  waiting for this batch: ${b.epochQueued ?? "?"} including yours, as of the last block (reported by the relayer)`);
    if (Number.isInteger(b.epochQueued) && b.epochQueued < 3) print("few transfers are waiting for this batch; with so few, it hides little");
  } else if (mode === "fast") print(`queued (fast): relay id ${id}`);
  else print(`queued for the next block: relay id ${id}`);
  if (entry.linkable) print(LINKABLE_LINE);
  if (Number.isSafeInteger(b.reservedSats)) {
    print(`reserved ${int(b.reservedSats)} sats of your relay balance${Number.isSafeInteger(b.balance) ? ` (${int(b.balance)} still available)` : ""}; the exact fee plus margin is charged when it goes out`);
  }
  return { status: "queued", mode, entry };
}

/**
 * Waits for a handed-over entry (batch-contract §6.4): before a batch's
 * releaseAt only the chain height is polled (no per-id call); from releaseAt
 * (at once for block / fast) the relay status, printing each change, until a
 * final status, `waitMaxMs` or `signal` (Ctrl+C). Updates the entry through `save`.
 */
export async function waitForRelay({
  client, entry, mode = entry.mode, name = "<wallet>", print = console.log, warn = (s) => process.stderr.write(`${s}\n`),
  sleep = delay, waitMaxMs = null, now = Date.now, signal, save = () => {},
}) {
  const started = now();
  const id = `${entry.relayId.slice(0, 12)}…`;
  const later = `the relayer still holds it (relay id ${id}); check later with: ${CLI} pending ${name}`;
  const left = () => (waitMaxMs === null ? Infinity : waitMaxMs - (now() - started));
  const stopped = () => {
    if (signal?.aborted) {
      print(`stopped waiting; ${later}`);
      return { status: "interrupted", entry };
    }
    if (left() <= 0) {
      print(`stopped waiting after ${waitMaxMs / 60_000} min; ${later}`);
      return { status: "timeout", entry };
    }
    return null;
  };
  const pause = async (ms) => {
    await sleep(Math.max(0, Math.min(ms, left())), signal);
    return stopped();
  };

  if (isBatchMode(mode) && entry.releaseAt != null) {
    let last = null;
    for (;;) {
      let h = null;
      try {
        h = (await client.state()).height;
      } catch (e) {
        warn(`${e.message}; still waiting`);
      }
      if (Number.isInteger(h) && h >= entry.releaseAt) break;
      if (Number.isInteger(h) && h !== last) {
        if (last === null) print(`waiting for block ${entry.releaseAt} (${eta(entry.releaseAt - h)}); Ctrl+C stops waiting, the relayer keeps the transfer`);
        else print(`block ${h} (${entry.releaseAt - h} to go)`);
        last = h;
      }
      const stop = await pause(STATE_POLL_MS);
      if (stop) return stop;
    }
  } else print("waiting for the carrier; Ctrl+C stops waiting, the relayer keeps the transfer");

  let last = "queued";
  for (;;) {
    let st;
    try {
      st = await client.status(entry.relayId);
    } catch (e) {
      warn(`${e.message}; still waiting`);
    }
    if (st === null) {
      Object.assign(entry, { status: "failed", error: "unknown", reason: "the relayer no longer knows this relay id" });
      save();
      print(`relay failed: unknown (the relayer no longer knows relay id ${id}); notes stay reserved until block ${entry.anchor + ANCHOR_WINDOW} unless it lands: ${CLI} retry ${name}`);
      return { status: "unknown", entry };
    }
    if (st) {
      if (st.txid && st.txid !== entry.txid) {
        // The relayer never bumps a carrier (contract §3), so a second txid is reported as it is, not as a bump.
        print(`${entry.txid ? "new carrier" : "released"}: carrier ${st.txid}`);
        print(`  ${EXPLORER}/tx/${st.txid}`);
        entry.txid = st.txid;
        save();
      }
      if (st.status !== last) {
        if (st.status === "accepted") {
          print(`landed in block ${st.height}`);
          if (Number.isSafeInteger(st.cost)) print(`charged ${int(st.cost)} sats to your relay balance`);
        } else if (st.status === "queued") print(`back in the relay queue${st.reason ? `: ${st.reason}` : ""}`);
        else if (st.status === "missed") {
          // Final: the relayer never sends a missed item later on its own, and a top-up never releases it.
          print(`relay missed: ${st.code ?? "unknown"} (${st.reason ?? "no reason given"}); nothing was charged: ${CLI} retry ${name}`);
        } else if (FINAL.has(st.status)) {
          print(`relay failed: ${st.status} (${st.reason ?? "no reason given"}); notes stay reserved until block ${entry.anchor + ANCHOR_WINDOW} unless it lands: ${CLI} retry ${name}`);
        }
        last = st.status;
      }
      if (FINAL.has(st.status)) {
        if (st.status === "accepted") Object.assign(entry, { status: "accepted", height: st.height, ...(Number.isSafeInteger(st.cost) ? { cost: st.cost } : {}) });
        else {
          Object.assign(entry, { status: "failed", error: st.status, reason: st.reason ?? null, ...(st.height != null ? { height: st.height } : {}) });
          if (st.status === "missed") entry.missedCode = st.code ?? null;
        }
        save();
        return { status: st.status, entry, txid: st.txid ?? null, height: st.height ?? null };
      }
    }
    const stop = await pause(STATUS_POLL_MS);
    if (stop) return stop;
  }
}

/** waitForRelay with Ctrl+C wired to stop waiting (the relayer keeps the transfer). */
async function waitInterruptibly(opts) {
  const ac = new AbortController();
  const onInt = () => ac.abort();
  process.on("SIGINT", onInt);
  try {
    return await waitForRelay({ ...opts, signal: ac.signal });
  } finally {
    process.off("SIGINT", onInt);
  }
}

/** `open` of listPending / pickRetry for the relayer at `url`: a fixed boolean, or asked of that relayer. */
const openFor = async (open, url) => (typeof open === "function" ? (await open(url)) === true : Boolean(open));

/**
 * Lists pending entries with their relay status: one status call per relayed
 * entry that may have one, none for a batch entry before its releaseAt (by the
 * local height) while relaying is open at the entry's own relayer (`open`: a boolean, or
 * async (relayUrl) => relayOpenAt of that relayer's info, asked only when it decides).
 * While it is closed no batch goes out, so every relayed entry is looked up: the
 * server answers "dropped" for the ids the retired free relayer held. Stores a
 * carrier txid it learns, so the W-1 lock can end on it.
 */
export async function listPending({ idx, file, clientFor, print = console.log, save = () => {}, open = RELAY_OPEN }) {
  const pending = file.pending ?? [];
  if (!pending.length) {
    print("no pending transfers");
    return [];
  }
  let changed = false;
  const rows = [];
  for (const p of pending) {
    if (p.kind === "mine") {
      // W-M: a claim is listed from the wallet file only; it is never retried with another route.
      const id = p.relayId ? `  id ${p.relayId.slice(0, 12)}…` : "";
      const status = p.status === "failed" ? `failed (${p.error}${p.reason ? `: ${p.reason}` : ""})` : p.status;
      print(`mine ${p.via === "relay" ? "relay" : "self-paid"}  ${p.reward} ${p.ticker}  ref ${p.ref}  ${status}  txid ${p.txid ?? "—"}${id}  locked until ${p.lockUntil}`);
      rows.push({ entry: p, status });
      continue;
    }
    const lock = `notes reserved until ${(p.anchor ?? p.anchorMax) + ANCHOR_WINDOW}`;
    if (p.via !== "relay") {
      print(`self-paid  txid ${p.txid}  anchor ${p.anchor ?? "—"}  ${lock}`);
      rows.push({ entry: p, status: "self-paid" });
      continue;
    }
    let status;
    if (p.status === "failed") status = `failed (${p.error}${p.reason ? `: ${p.reason}` : ""})`;
    else if (p.status === "accepted") status = `accepted in block ${p.height}`;
    else if (!p.relayId) status = "not handed over";
    else if (isBatchMode(p.mode) && p.releaseAt != null && idx.height < p.releaseAt && (await openFor(open, p.relay))) status = `scheduled, goes out after block ${p.releaseAt}`;
    else {
      try {
        const st = await clientFor(p.relay).status(p.relayId);
        if (st === null) status = "unknown to the relayer";
        else {
          status = `${st.status}${st.height != null ? ` in block ${st.height}` : ""}${st.reason ? ` (${st.reason})` : ""}`;
          if (st.txid && st.txid !== p.txid) {
            p.txid = st.txid;
            changed = true;
          }
        }
      } catch (e) {
        status = `unreachable (${e.message})`;
      }
    }
    const id = p.relayId ? `${p.relayId.slice(0, 12)}…` : "—";
    print(
      `${MODE_NAME[p.mode] ?? RETIRED_MODE_NAME[p.mode] ?? p.mode}  ${p.amount} ${p.ticker}  anchor ${p.anchor}  release ${p.releaseAt ?? "—"}  relay ${status}  txid ${p.txid ?? "—"}  id ${id}  ${lock}`,
    );
    rows.push({ entry: p, status });
  }
  if (changed) save();
  return rows;
}

/**
 * The newest relayed entry worth retrying: refused or failed, never handed
 * over, or final without landing (rejected, expired, dropped, missed), or unknown
 * to its relayer. A queued, broadcast or landed entry is never picked. While relaying
 * is open at the entry's own relayer (`open` as in listPending), a batch entry before
 * its releaseAt (at `height`) is skipped unasked: the
 * relayer still holds it, and a lookup now would tie it to this retry. While it is
 * closed nobody holds it, so it is looked up like any other.
 */
export async function pickRetry({ file, clientFor, height = null, warn = (s) => process.stderr.write(`${s}\n`), open = RELAY_OPEN }) {
  for (const p of [...(file.pending ?? [])].reverse()) {
    // A mining claim is never retried (W-M: one solution, one route, submitted once).
    if (p.kind === "mine" || p.via !== "relay" || p.status === "accepted") continue;
    if (p.status === "failed" || !p.relayId) return p;
    if (isBatchMode(p.mode) && p.releaseAt != null && (height == null || height < p.releaseAt) && (await openFor(open, p.relay))) continue;
    let st;
    try {
      st = await clientFor(p.relay).status(p.relayId);
    } catch (e) {
      warn(`${e.message}; skipping relay id ${p.relayId.slice(0, 12)}…`);
      continue;
    }
    if (st === null || ["rejected", "expired", "dropped", "missed"].includes(st.status)) return p;
  }
  return null;
}

/** Relay info, or null when the relayer is unreachable or answers an error. */
async function infoOrNull(client) {
  try {
    return await client.info();
  } catch {
    return null;
  }
}

/**
 * send --relay and retry: refuse at once (exit 1, nothing synced, proved or written) when the
 * relayer at `checkUrl` runs no relay balances; else sync, open the wallet, hand over, then
 * wait unless --no-wait. relaySend checks the relayer it actually uses once more.
 */
async function relayed(f, name, run, { checkUrl = f.url } = {}) {
  if (checkUrl && !relayOpenAt(await infoOrNull(relayClient(checkUrl)))) {
    console.error(`error: ${relayUnavailable(checkUrl)}`);
    process.exitCode = 1;
    return;
  }
  const idx = await synced();
  const { wallet, file, save } = await openWallet(name, idx);
  const { client, ...result } = await run({ idx, wallet, file, save });
  let out = result;
  if (out.status === "queued" && f.wait) {
    out = await waitInterruptibly({ client, entry: out.entry, mode: out.mode, name, waitMaxMs: f.waitMaxMs, save });
  }
  process.exitCode = exitCodeFor(out);
}

// ------------------------------------------------- relay balance commands (relay-balance-contract.md §6)

export const RELAY_USAGE = [
  `usage: ${CLI} relay account <wallet> [--relay url]   (alias: relay balance <wallet>)`,
  `       ${CLI} relay topup <wallet> [--relay url] [--pay <sats> [--fee-rate n] [--dry-run]]`,
  `       ${CLI} relay credit <wallet> [<txid:vout> [<n>]] [--older] [--relay url]`,
].join("\n");

/**
 * Arguments of `relay account | balance | topup | credit`, strictly. --relay needs a URL here
 * (default MURKLE_RELAY_URL, else localhost); --pay, --fee-rate and --dry-run belong to topup
 * (--fee-rate and --dry-run only with --pay); --older and the outpoint to credit. Anything else
 * is refused before any key is read. -> { sub, name, url, pay, feeRate, dryRun, outpoint, n, older }
 */
export function parseRelayCommand(args, { read = env } = {}) {
  const fail = (msg) => {
    throw new Error(`${msg}\n${RELAY_USAGE}`);
  };
  const [what, ...rest] = args.map(String);
  const sub = what === "balance" ? "account" : what;
  if (!["account", "topup", "credit"].includes(sub)) fail(what ? `unknown relay command "${what}"` : "which relay command?");
  const allowed = { account: ["relay"], topup: ["relay", "pay", "fee-rate", "dry-run"], credit: ["relay", "older"] }[sub];
  const out = { sub, name: null, url: null, pay: null, feeRate: null, dryRun: false, outpoint: null, n: null, older: false };
  const pos = [];
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const flag = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (!allowed.includes(flag)) fail(`unknown flag ${eq < 0 ? a : a.slice(0, eq)} for relay ${sub}`);
    if (seen.has(flag)) fail(`--${flag} given twice`);
    seen.add(flag);
    if (flag === "dry-run" || flag === "older") {
      if (eq >= 0) fail(`--${flag} takes no value`);
      out[flag === "dry-run" ? "dryRun" : "older"] = true;
      continue;
    }
    const v = eq >= 0 ? a.slice(eq + 1) : rest[++i];
    if (v === undefined || v === "" || v.startsWith("--")) fail(`--${flag} needs a value`);
    if (flag === "relay") {
      try {
        out.url = checkRelayUrl(v);
      } catch (e) {
        fail(e.message);
      }
    } else if (!/^[1-9]\d{0,15}$/.test(v)) fail(`--${flag} must be a whole number above 0`);
    else out[flag === "pay" ? "pay" : "feeRate"] = Number(v);
  }
  if ((out.feeRate !== null || out.dryRun) && out.pay === null) fail("--fee-rate and --dry-run go with --pay");
  const most = sub === "credit" ? 3 : 1;
  if (!pos.length) fail("which wallet?");
  if (pos.length > most) fail(`unexpected argument "${pos[most]}"`);
  [out.name, out.outpoint = null, out.n = null] = pos;
  if (out.n !== null && !/^(0|[1-9]\d{0,9})$/.test(out.n)) fail(`deposit address number must be a whole number, not "${out.n}"`);
  if (out.n !== null) out.n = Number(out.n);
  if (out.outpoint !== null && out.older) fail("--older looks up deposit addresses; leave it out when you name an outpoint");
  out.url ??= checkRelayUrl(read("RELAY_URL") || DEFAULT_RELAY, "MURKLE_RELAY_URL");
  return out;
}

/**
 * `relay account <w>`: the balance of this wallet's relay account (a signed read), the deposit
 * address it shows next and the relayer's price per send. Moves `relay.depositIndex` up to the
 * relayer's `nextIndex` (a credited payment was seen there). Throws on any error (exit 1).
 */
export async function relayAccountCommand({ file, client, url, lib, print = console.log, save = () => {}, now = Date.now }) {
  const info = await balanceInfo(client, url);
  const account = relayAccountOf(file, lib);
  const acct = await readRelayAccount({ client, info, account, lib, now });
  advanceDepositIndex(file, acct.nextIndex, save);
  const n = depositIndexOf(file);
  const address = n === acct.nextIndex ? acct.depositAddress : depositOf(lib, info, account, n).address;
  print(`account   ${account.idHex.slice(0, 4)}…${account.idHex.slice(-4)} (${info.network})`);
  print(`balance   ${int(acct.balance)} sats available, ${int(acct.reserved)} reserved`);
  if (depositsOpenAt(info)) print(`next      deposit address #${n}  ${address}`);
  else print(`next      no top-ups right now (${info.code}): do not pay any deposit address until the relayer takes them again`);
  print(`relayer   ${url}  ${perSendText(info)}`);
  if (info.code === "fee_high" || info.code === "halted" || EMERGENCY_CODES.includes(info.code)) print(`note      the relayer takes no sends right now (${info.code}); your balance is kept`);
  for (const line of rotationLines(info)) print(`note      ${line}`);
  return { status: "ok", balance: acct.balance, reserved: acct.reserved, n };
}

/** Codes of a relayer that is moving its coins, paused, or waiting for its new pool (relay-balance.md §9). */
export const EMERGENCY_CODES = Object.freeze(["relayer_evacuating", "pool_unfunded", "maintenance"]);

/** The pool keys a rotated relayer retired (relay info `balance.retiredPoolKeys`), well-formed ones only. */
export const retiredKeysOf = (info) => (Array.isArray(info?.balance?.retiredPoolKeys) ? info.balance.retiredPoolKeys.filter((k) => /^[0-9a-f]{64}$/.test(String(k))) : []);

/** Address numbers below the current one that `relay credit` looks at under each retired pool key (all of them with --older). */
const RETIRED_SCAN = 4;

/** False while the relayer takes no top-ups (relay info `balance.depositsOpen`; an older relayer does not say: open). */
export const depositsOpenAt = (info) => info?.balance?.depositsOpen !== false && !EMERGENCY_CODES.includes(info?.code);

/**
 * What the CLI prints about a rotated relayer (relay info `balance.retiredPoolKeys`): its earlier
 * deposit addresses are retired. Balances belong to the account key, so they carried over.
 */
export function rotationLines(info) {
  const retired = retiredKeysOf(info);
  if (!retired.length) return [];
  return [
    `the relayer moved to new keys (generation ${info.balance.generation ?? retired.length}): every deposit address it showed before is retired. Never pay one again; this wallet shows addresses of the new key only`,
    "your relay balance carried over: it belongs to your account key, not to the relayer's keys. A payment already made to an old address is credited once the operator has moved it",
  ];
}

/**
 * The first deposit address from `n` on that has not been paid (by the explorer's listing of
 * each address). A payment seen on the way is kept in `relay.pending`, so a plain
 * `relay credit` still credits it after the address number moved on.
 */
async function freshDeposit({ lib, info, account, esplora, n, file, save }) {
  for (let guard = 0; guard < 50; guard++) {
    const dep = depositOf(lib, info, account, n);
    const paid = await esplora.utxos(dep.address);
    if (!paid.length) return dep;
    addPending(file, paid.map((u) => ({ n, outpoint: `${u.txid}:${u.vout}` })), () => {}); // saved with the index below
    n += 1; // paid already: every top-up gets a fresh address
    advanceDepositIndex(file, n, save);
  }
  throw new Error("50 deposit addresses in a row are paid already; run relay credit first");
}

/**
 * `relay topup <w>`: the deposit address to pay next (#depositIndex, moved past any address that
 * already received a payment) and the rules. With `pay`, builds a plain payment (no OP_RETURN)
 * of that many sats from the wallet's BTC fee key to that address, prints it and broadcasts it
 * unless `dryRun`; only a broadcast payment moves `relay.depositIndex` on. Never pays the
 * relayer anything but a user's own deposit. Throws on any error (exit 1).
 */
export async function relayTopUpCommand({
  name, file, client, url, lib, esplora, btcKey = null, pay = null, feeRate = null, dryRun = false,
  print = console.log, save = () => {}, now = Date.now, planPayment = funding.planPayment, sign = signLocal,
}) {
  const info = await balanceInfo(client, url);
  const rules = info.balance;
  if (!depositsOpenAt(info)) {
    throw new Error(`the relayer takes no top-ups right now (${info.code ?? "closed"}): it is moving its coins to new keys or is paused. Do not pay any deposit address; nothing was paid and your balance is kept`);
  }
  for (const line of rotationLines(info)) print(`note: ${line}`);
  const account = relayAccountOf(file, lib);
  const acct = await readRelayAccount({ client, info, account, lib, now });
  advanceDepositIndex(file, acct.nextIndex, save);
  const dep = await freshDeposit({ lib, info, account, esplora, n: depositIndexOf(file), file, save });
  const confs = rules.depositConfirmations;
  // While the relayer does not know the fee rate it quotes no price, so there is no suggestion yet.
  const suggested = Number.isSafeInteger(rules.suggestedTopUpSats) && rules.suggestedTopUpSats > 0 ? rules.suggestedTopUpSats : null;
  print(`deposit address #${dep.n}: ${dep.address}`);
  print(
    `minimum ${int(rules.minDepositSats)} sats; credited after ${confs} confirmation${confs === 1 ? "" : "s"}; ` +
      (suggested === null
        ? "suggested amount: not quoted yet (the relayer does not know the fee rate)"
        : `suggested ${int(suggested)} sats (about ${rules.suggestSends} sends)`),
  );
  print(NETWORK === "signet"
    ? "a plain payment from any signet wallet, never real bitcoin; each top-up gets a new address, older ones are still credited"
    : `a plain payment of real bitcoin (${NETWORK}) from any wallet; each top-up gets a new address, older ones are still credited`);
  print(OPERATOR_LINE);
  if (pay === null) {
    print(`${int(rules.sweepCostSats)} sats of each top-up pay for the relayer to spend that coin later; a payment below the minimum is not credited and is not returned`);
    const amount = suggested === null ? `<sats> (at least ${rules.minDepositSats})` : suggested;
    print(`to pay it from this wallet's BTC fee key: ${CLI} relay topup ${name} --pay ${amount}; then, once confirmed: ${CLI} relay credit ${name}`);
    return { status: "ok", n: dep.n, address: dep.address };
  }
  if (!Number.isSafeInteger(pay) || pay < rules.minDepositSats) {
    throw new Error(`--pay ${pay} is below the ${int(rules.minDepositSats)}-sat minimum: a smaller payment is not credited and is not returned. Nothing was paid`);
  }
  if (typeof planPayment !== "function") throw new Error("this checkout has no planPayment in src/btc/funding.mjs; nothing was paid");
  if (!btcKey) throw new Error("this wallet file has no BTC fee key; nothing was paid");
  const payer = btcAccount(btcKey);
  const rate = feeRate ?? (await esplora.feeRate());
  const plan = planPayment({ account: payer, utxos: await esplora.utxos(payer.address), to: dep.script, amount: BigInt(pay), feeRate: rate });
  const tx = sign(plan.tx, btcKey);
  print(`paying ${int(pay)} sats to deposit address #${dep.n} from ${payer.address}, fee ${int(plan.fee)} sats at ${rate} sat/vB`);
  print("the relayer sees which address paid: paying from this wallet's BTC fee key links your relay balance to that key's address, which your self-paid sends also use");
  if (dryRun) {
    print(`dry run, nothing broadcast: ${tx.txid}\n${tx.hex}`);
    return { status: "ok", n: dep.n, address: dep.address, txid: tx.txid, hex: tx.hex, fee: plan.fee, dryRun: true };
  }
  const txid = await esplora.broadcast(tx.hex);
  // The payment's output: kept in relay.pending, so a plain `relay credit` finds it after the index moves on.
  let vout = 0;
  for (let v = 0; v < plan.tx.outputsLength; v++) {
    const s = plan.tx.getOutput(v).script;
    if (s && Buffer.from(s).equals(Buffer.from(dep.script))) vout = v;
  }
  const outpoint = `${txid}:${vout}`;
  addPending(file, [{ n: dep.n, outpoint }], () => {}); // saved with the index below
  if (!advanceDepositIndex(file, dep.n + 1, save)) save();
  print(`top-up broadcast: ${txid}  (${tx.vsize} vB, fee ${int(plan.fee)} sats)`);
  print(`  ${EXPLORER}/tx/${txid}`);
  print(`after ${confs} confirmation${confs === 1 ? "" : "s"}: ${CLI} relay credit ${name}  (or by outpoint: ${CLI} relay credit ${name} ${outpoint} ${dep.n})`);
  return { status: "ok", n: dep.n, address: dep.address, txid, outpoint, fee: plan.fee };
}

/** What a credit answer means for one deposit: [state, text]; state is credited | already | waiting | refused | error. */
function creditOutcome(res, rules, running) {
  const err = res.body?.error ?? {};
  if (res.status === 200 && res.body) {
    if (res.body.already) return ["already", "already credited"];
    return ["credited", `credited +${int(res.body.amount)} (balance ${int(running + res.body.amount)})`];
  }
  const code = err.code ?? `http_${res.status}`;
  if (code === "deposit_unconfirmed") {
    return ["waiting", `waiting for confirmations (${err.confirmations ?? 0} of ${err.needed ?? rules.depositConfirmations})`];
  }
  if (code === "credit_in_progress") return ["waiting", "being credited right now; run this again in a few seconds"];
  // A payment to a deposit address of a pool key the relayer retired (relay-balance.md §9): kept
  // pending, credited once the operator has swept it into the new pool.
  if (code === "deposit_retired") return ["waiting", `paid a retired deposit address: credited once the relayer's operator has moved it into the new pool (${err.status ?? "waiting"}); never pay an old address again`];
  if (["relayer_evacuating", "pool_unfunded", "maintenance"].includes(code)) return ["waiting", `the relayer takes no credits right now (${code}); the deposit stays pending and your balance is kept`];
  if (code === "deposit_unknown") return ["waiting", "the relayer's explorer does not know it yet; run this again in a minute"];
  if (code === "deposit_small") return ["refused", `below the ${int(err.minDepositSats ?? rules.minDepositSats)}-sat minimum: not credited`];
  if (["deposit_mismatch", "deposit_own", "already_credited", "bad_outpoint"].includes(code)) return ["refused", `refused: ${refusalText(res)}`];
  return ["error", `not credited: ${refusalText(res)}`];
}

/**
 * `relay credit <w> [<txid:vout> [<n>]] [--older]`: asks the relayer to credit deposits to this
 * wallet's relay account. With an outpoint it credits that one (deposit address `n`, default the
 * wallet's depositIndex − 1, else 0). Without one it tries every top-up in `relay.pending` (paid
 * with `relay topup --pay`, or seen earlier but not credited yet), and looks up deposit address
 * #depositIndex (and every older one with `older`) at the explorer and credits each payment
 * found there; a payment at #depositIndex moves the index on. Unconfirmed payments are listed,
 * not sent, and kept pending; credited, already credited and refused ones leave the list.
 * -> { exit: 0 all credited or already | 1 error or nothing found | 4 any refused | 6 some still waiting, rows }
 */
export async function relayCreditCommand({
  file, client, url, lib, esplora, outpoint = null, n = null, older = false, print = console.log, save = () => {}, now = Date.now,
}) {
  const info = await balanceInfo(client, url);
  const rules = info.balance;
  const account = relayAccountOf(file, lib);
  const acct = await readRelayAccount({ client, info, account, lib, now });
  advanceDepositIndex(file, acct.nextIndex, save);
  const found = [];
  if (outpoint !== null) {
    let key;
    try {
      key = lib.parseOutpoint(outpoint).key;
    } catch {
      throw new Error(`"${outpoint}" is not a deposit outpoint: it must be a 64-character lowercase txid, a colon and the output number`);
    }
    const at = n ?? Math.max(0, depositIndexOf(file) - 1);
    if (!Number.isSafeInteger(at) || at < 0 || at > lib.MAX_DEPOSIT_INDEX) throw new Error(`deposit address number ${at} is out of range`);
    found.push({ n: at, outpoint: key, value: null, confirmed: null });
  } else {
    const scanAt = async (address, k) =>
      (await esplora.utxos(address)).map((u) => ({
        n: k, outpoint: `${u.txid}:${u.vout}`, value: u.value, confirmed: u.status?.confirmed === true,
      }));
    const scan = (k) => scanAt(depositOf(lib, info, account, k).address, k);
    let top = depositIndexOf(file);
    if (older) for (let k = 0; k < top; k++) found.push(...(await scan(k)));
    for (let guard = 0; guard < 50; guard++) {
      const got = await scan(top);
      if (!got.length) break;
      found.push(...got);
      top += 1; // a payment was seen at the address the wallet shows: show the next one
      advanceDepositIndex(file, top, save);
    }
    // Payments to an address of a pool key the relayer has retired (relay-balance.md §9), made from
    // anywhere (an exchange, another wallet) to an address this wallet showed before: the last few
    // address numbers under each retired key (every one with --older). The relayer records each and
    // credits it once its operator has moved it into the new pool; it stays pending meanwhile.
    if (depositsOpenAt(info)) {
      for (const pk of retiredKeysOf(info)) {
        const Q = lib.parsePoolKey(pk);
        for (let k = older ? 0 : Math.max(0, top - RETIRED_SCAN); k <= top; k++) {
          found.push(...(await scanAt(lib.depositAddress(Q, account.id, k, info.network).address, k)).map((d) => ({ ...d, retired: true })));
        }
      }
    }
    // Top-ups paid earlier and not credited yet (their address number has moved on).
    const seen = new Set(found.map((d) => d.outpoint));
    for (const p of pendingOf(file)) if (!seen.has(p.outpoint)) found.push({ n: p.n, outpoint: p.outpoint, value: null, confirmed: null });
    addPending(file, found, save);
    if (!found.length) {
      print(`no payment found at deposit address #${top}${older ? " or any older one" : ""}: ${depositOf(lib, info, account, top).address}`);
      if (!older) print(`a payment to an older deposit address: ${CLI} relay credit <wallet> --older, or name it: ${CLI} relay credit <wallet> <txid:vout> <n>`);
      return { exit: 1, rows: [] };
    }
  }
  let running = acct.balance;
  const rows = [];
  for (const d of found) {
    let state;
    let text;
    let value = d.value;
    if (d.confirmed === false) {
      [state, text] = ["waiting", `waiting for confirmations (0 of ${rules.depositConfirmations})`];
    } else {
      const res = await client.credit({ outpoint: d.outpoint, accountPub: account.pubHex, n: d.n });
      [state, text] = creditOutcome(res, rules, running);
      if (state === "credited") running += res.body.amount;
      if (Number.isSafeInteger(res.body?.value)) value = res.body.value;
    }
    print(`#${d.n}${d.retired ? " (retired key)" : ""} ${d.outpoint}  ${value === null ? "—" : `${int(value)} sats`}  ${text}`);
    rows.push({ ...d, value, state, text });
  }
  // Settled rows leave relay.pending; waiting ones (and errors) are tried again next time.
  dropPending(file, new Set(rows.filter((r) => ["credited", "already", "refused"].includes(r.state)).map((r) => r.outpoint)), save);
  const has = (s) => rows.some((r) => r.state === s);
  const exit = has("error") ? 1 : has("refused") ? 4 : has("waiting") ? 6 : 0;
  return { exit, rows };
}

export const RETIRE_USAGE = `usage: ${CLI} relayer retire-free --to <address> [--dry-run] [--fee-rate <sat/vB>]`;

/**
 * Flags of `relayer retire-free`, strictly: --to <address> (or --to=<address>), --dry-run
 * (no value), --fee-rate <n> (or --fee-rate=<n>, a whole number of sat/vB, at least 1).
 * Anything else is refused before any key is read: a mistyped --dry-run must never turn
 * into a broadcast of the operator's coins. Returns { to, dryRun, feeRate | null }.
 */
export function parseRetireFlags(args) {
  const out = { to: null, dryRun: false, feeRate: null };
  const seen = new Set();
  const fail = (msg) => {
    throw new Error(`${msg}. ${RETIRE_USAGE}`);
  };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (!a.startsWith("--")) fail(`unexpected argument "${a}"`);
    const eq = a.indexOf("=");
    const flag = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (!["to", "dry-run", "fee-rate"].includes(flag)) fail(`unknown flag ${eq < 0 ? a : a.slice(0, eq)}`);
    if (seen.has(flag)) fail(`--${flag} given twice`);
    seen.add(flag);
    if (flag === "dry-run") {
      if (eq >= 0) fail("--dry-run takes no value");
      out.dryRun = true;
      continue;
    }
    const v = eq >= 0 ? a.slice(eq + 1) : args[++i];
    if (v === undefined || v === "" || String(v).startsWith("--")) fail(`--${flag} needs a value`);
    if (flag === "to") out.to = String(v);
    else if (!/^\d+$/.test(String(v)) || Number(v) < 1) fail("--fee-rate must be a whole number of sat/vB, at least 1");
    else out.feeRate = Number(v);
  }
  if (!out.to) fail("--to <address> is required");
  return out;
}

// ------------------------------------------- relayer emergencies (relay-balance.md §9)

export const RELAYER_USAGE = [
  `usage: ${CLI} relayer evacuate --to <cold address> [--fee-rate n] [--high-fee] [--dry-run] [--wait <seconds>] [--relayer-stopped]`,
  `       ${CLI} relayer evacuate --bump [--fee-rate n] [--high-fee] [--dry-run] [--wait <seconds>] [--relayer-stopped]`,
  `       ${CLI} relayer evacuate --cancel [--wait <seconds>] [--relayer-stopped]`,
  `       ${CLI} relayer rotate [--accept-lost]`,
  `       ${CLI} relayer refund-pool --from <cold key file> [--amount <sats>] [--fee-rate n] [--dry-run] [--wait <seconds>] [--relayer-stopped]`,
  `       ${CLI} relayer refund-pool --outpoint <txid:vout> [--wait <seconds>] [--relayer-stopped]`,
  `       ${CLI} relayer sweep-retired [--fee-rate n] [--high-fee] [--bump] [--accept-lost] [--dry-run] [--wait <seconds>] [--relayer-stopped]`,
  `       ${CLI} relayer status`,
  `       ${CLI} relayer retire-free --to <address> [--dry-run] [--fee-rate <sat/vB>]`,
].join("\n");

const RELAYER_FLAGS = Object.freeze({
  evacuate: { values: ["to", "fee-rate", "wait"], booleans: ["dry-run", "bump", "cancel", "high-fee", "relayer-stopped"] },
  rotate: { values: [], booleans: ["accept-lost"] },
  "refund-pool": { values: ["from", "outpoint", "amount", "fee-rate", "wait"], booleans: ["dry-run", "relayer-stopped"] },
  "sweep-retired": { values: ["fee-rate", "wait"], booleans: ["dry-run", "bump", "accept-lost", "high-fee", "relayer-stopped"] },
  status: { values: [], booleans: [] },
});

/**
 * Arguments of the operator's emergency commands (`relayer evacuate | rotate | refund-pool |
 * sweep-retired | status`), strictly, before any key is read: a mistyped --dry-run must never
 * turn into a broadcast. --relayer-stopped: the operator says no relayer runs (a tool otherwise
 * waits for the running relayer to acknowledge its HOLD, and refuses without that); --high-fee:
 * fees above half of the swept value are meant (a thief bidding high), not a typo.
 * -> { sub, to, feeRate, waitSecs, dryRun, bump, cancel, highFee, relayerStopped, acceptLost, from, outpoint, amount }
 */
export function parseRelayerArgs(what, args) {
  if (!Object.hasOwn(RELAYER_FLAGS, String(what))) throw new Error(what ? `unknown relayer command "${what}"\n${RELAYER_USAGE}` : RELAYER_USAGE);
  const f = parseStrictFlags(args, { ...RELAYER_FLAGS[what], usage: RELAYER_USAGE });
  const fail = (msg) => {
    throw new Error(`${msg}\n${RELAYER_USAGE}`);
  };
  const num = (name, min) => {
    if (f[name] === undefined) return null;
    if (!/^\d+$/.test(f[name]) || Number(f[name]) < min || !Number.isSafeInteger(Number(f[name]))) fail(`--${name} must be a whole number of at least ${min}`);
    return Number(f[name]);
  };
  const out = {
    sub: what, to: f.to ?? null, feeRate: num("fee-rate", 1), waitSecs: num("wait", 0), dryRun: f["dry-run"] === true, bump: f.bump === true,
    cancel: f.cancel === true, highFee: f["high-fee"] === true, relayerStopped: f["relayer-stopped"] === true,
    acceptLost: f["accept-lost"] === true, from: f.from ?? null, outpoint: f.outpoint ?? null, amount: num("amount", 1),
  };
  if (what === "evacuate") {
    if (out.cancel && (out.bump || out.to || out.feeRate !== null || out.dryRun || out.highFee)) fail("--cancel takes no --to, --bump, --fee-rate, --high-fee or --dry-run");
    if (out.bump && out.to) fail("--bump signs the sweep again to the address it already pays; leave out --to");
    if (!out.bump && !out.cancel && !out.to) fail("--to <cold address> is required: the address whose key never was on this server");
  }
  if (what === "refund-pool") {
    if (Boolean(out.from) === Boolean(out.outpoint)) fail("refund-pool takes --from <cold key file> or --outpoint <txid:vout>, one of them");
    if (out.outpoint && (out.amount !== null || out.feeRate !== null || out.dryRun)) fail("--amount, --fee-rate and --dry-run go with --from");
  }
  return out;
}

// ------------------------------------------------- mining (docs/design/mining-contract.md §11)
//
// `deploy-pow` launches a mined token (DEPLOY_POW). `mine` hashes Argon2id in worker threads
// (src/pow-pool.mjs, after each worker's self-test), proves each solution as a claim and either
// pays it from the wallet's separate mining key (MINE, bound to a coin chosen after the solution
// is found) or hands it to a relayer that charges the relay balance (MINE_SCRIPT, bound to the
// relayer's change key). Every claim pays its own Bitcoin fee and the service fee; the operator
// pays nothing (I-PAY) and no command here adds coins to anyone. Both commands refuse to pay
// below the "mining" activation height of src/pins.json, which is not set in this release.

let mineLibCache = null;
/** src/mine.mjs (mining-contract.md §3), loaded on first use. Tests pass their own `lib`. */
export async function loadMineLib() {
  return (mineLibCache ??= await import("../src/mine.mjs"));
}

/** The copy of mining-contract.md §12, as the CLI prints it ("this tab" reads "this miner" here). */
export const MINE_COPY = Object.freeze({
  relay: (ticker, reward) =>
    `The reward goes to a private note. Chain observers see relay claims of ${ticker} for ${reward} each, not who received them. ` +
    "The relayer can link the address you top up from to every claim it carries for you, including the token and the reward. " +
    "While few people relay claims, the claims right after your top-up are easy to tie to it. Top up before you start mining.",
  key: "Claims are public: token, reward and the paying address. Anyone can add up what this address mined, and the transfers it pays for later.",
  hardware: "A single GPU or a server miner can be thousands of times faster than this miner. Anyone can rent many computers.",
  fee: (fee) =>
    `Every claim pays a Bitcoin fee and a service fee of ${int(fee.platformSats)} sats to the ${BRAND} platform address. Its own claims cost it ${int(fee.platformSats)} sats less.`,
  censor: "Bitcoin miners choose what goes into blocks and in what order. They can delay a claim until it expires.",
  nearCap: "Supply is nearly mined out. A claim that lands after the cap is rejected; its Bitcoin fee and its service fee are still spent.",
  window: "A claim must land within 12 blocks of the block it references.",
  surge: "Difficulty jumped. Solutions found before the jump may no longer count; the wallet checks before paying.",
  bump: "The fee recipient can block a fee bump, so the wallet pays a next-block rate up front.",
  testCoins: "Test coins, no value.",
  start: "Starting now favours whoever is ready first; a delay gives everyone time to see the terms.",
  noise: "Difficulty is noisy: with few solutions per span, emission runs a few percent above target.",
  quiet: "After a quiet period or a hashrate jump, the first block can carry many claims.",
  slow: "Slow mode: this computer's fast hash failed its test; the reference implementation is about 10 times slower.",
  refused: "This computer computed a test hash wrong; mining is off.",
});

/** "a service fee of 500 sats per claim to the platform address tb1p…, and no deployer fee" (the network's fee policy, D2). */
function feePolicyText(fee) {
  const deployer = fee.deployerMaxSats === 0n
    ? "no deployer claim fee is allowed"
    : `a deployer claim fee may be ${fee.deployerMinSats > 0n ? int(fee.deployerMinSats) : `0 or ${int(params.FEE_MIN_SATS)}`} to ${int(fee.deployerMaxSats)} sats`;
  return `on ${NETWORK} every claim pays a service fee of ${int(fee.platformSats)} sats to the platform address ${fee.platformAddress}, and ${deployer}`;
}

/** Whether a claim or launch in block `height` is past the mining activation height. */
function miningActiveAt(idx, height) {
  if (typeof idx.miningActive === "function") return idx.miningActive(height) === true;
  return params.MINING_HEIGHT != null && height >= params.MINING_HEIGHT;
}
const activationText = (idx) => {
  const h = idx.miningHeight !== undefined ? idx.miningHeight : params.MINING_HEIGHT;
  return h == null ? "no activation height is set in this release" : `mining activates at block ${h}`;
};

const DEPLOY_POW_VALUES = [
  "ticker", "reward", "max-supply", "divisibility", "span", "per-block", "difficulty", "hashrate", "min-difficulty", "halving", "start", "start-after", "end",
  "fee-rate",
  "claim-fee", "treasury",
];
export const DEPLOY_POW_USAGE =
  `usage: ${CLI} deploy-pow <wallet> --ticker T --reward N --max-supply N [--divisibility d] [--span 24] [--per-block 1] ` +
  "[--difficulty D | --hashrate H] [--min-difficulty D] [--halving n] [--start now | --start-after N] [--end h] [--fee-rate r] [--dry-run]";
const I64_MAX = (1n << 63n) - 1n;
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 2 ** 32 - 1;

/**
 * The terms of `deploy-pow` from its flags (the arguments after the wallet name), strictly and
 * before anything is read or broadcast. Defaults come from LAUNCH_DEFAULTS: span 24 blocks, 1
 * solution per block, an initial difficulty suggested for the default launch hashrate, and a
 * floor of initial / 16 (never below MIN_DIFFICULTY). The bounds are those of DEPLOY_POW
 * (mining-contract.md §5). --claim-fee and --treasury are checked against the network's fee
 * policy (D2): while it allows no deployer fee, both are refused with its reason.
 * The start is one of two choices: `--start now` (the default; startHeight 0, so mining opens at
 * the launch block itself) or `--start-after N` (startHeight = tip + 1 + N: N blocks after the
 * next block, counted from the current tip `tip`; without a tip, startHeight is null and only
 * the flags are checked).
 * -> { terms (the encodeDeployPow input), hashrate (H/s behind the suggestion, or null), perBlock, startAfter (0 = now), feeRate | null, dryRun }
 */
export function deployPowTerms(args, { lib, fee = params.MINE_FEE, tip = null } = {}) {
  const fail = (msg) => {
    throw new Error(`${msg}\n${DEPLOY_POW_USAGE}`);
  };
  const f = parseStrictFlags(args, { values: DEPLOY_POW_VALUES, booleans: ["dry-run"], usage: DEPLOY_POW_USAGE });
  if (!f.ticker || !f.reward || !f["max-supply"]) fail("--ticker, --reward and --max-supply are required");
  const ticker = String(f.ticker).toUpperCase();
  if (!/^[A-Z0-9]{1,16}$/.test(ticker)) fail("--ticker takes 1 to 16 letters A-Z or digits");
  const d = lib.LAUNCH_DEFAULTS;
  const big = (name, fallback) => BigInt(whole(f, name, fallback));
  const small = (name, fallback, max = U32_MAX) => {
    const v = Number(whole(f, name, fallback));
    if (!Number.isSafeInteger(v) || v > max) fail(`--${name} must be at most ${int(max)}`);
    return v;
  };
  const reward = big("reward");
  const maxSupply = big("max-supply");
  if (reward < 1n || reward > I64_MAX) fail(`--reward must be from 1 to ${I64_MAX}`);
  if (maxSupply < reward || maxSupply > U64_MAX) fail("--max-supply must be at least --reward and at most 2^64 - 1");
  const divisibility = small("divisibility", "0", 8);
  const span = small("span", String(d.span));
  if (span < params.SPAN_MIN || span > params.SPAN_MAX) fail(`--span must be from ${params.SPAN_MIN} to ${params.SPAN_MAX} blocks`);
  const perBlock = small("per-block", String(d.perBlock));
  const targetPerSpan = perBlock * span;
  if (targetPerSpan < params.MIN_SPAN_CLAIMS || perBlock > params.MAX_PER_BLOCK) {
    fail(`--per-block x --span must be at least ${params.MIN_SPAN_CLAIMS} solutions per span, and --per-block at most ${params.MAX_PER_BLOCK}`);
  }
  if (f.difficulty !== undefined && f.hashrate !== undefined) fail("give --difficulty or --hashrate, not both");
  const hashrate = f.difficulty === undefined ? Number(whole(f, "hashrate", String(d.launchHashrate))) : null;
  if (hashrate !== null && !(hashrate > 0 && Number.isSafeInteger(hashrate))) fail("--hashrate must be a whole number of hashes per second above 0");
  const initialDifficulty = f.difficulty !== undefined ? big("difficulty") : BigInt(lib.suggestInitialDifficulty({ hashrate, span, targetPerSpan }));
  const minDifficulty = f["min-difficulty"] !== undefined ? big("min-difficulty") : BigInt(lib.suggestFloor(initialDifficulty));
  if (minDifficulty < params.MIN_DIFFICULTY) fail(`--min-difficulty must be at least ${params.MIN_DIFFICULTY}`);
  if (initialDifficulty < minDifficulty || initialDifficulty > params.D_MAX) {
    fail(`the initial difficulty ${initialDifficulty} must be from the floor ${minDifficulty} to ${params.D_MAX}`);
  }
  const halvingInterval = small("halving", "0");
  if (f.start !== undefined && f.start !== "now") fail('--start takes only "now"; to start later, give --start-after N (blocks)');
  if (f.start !== undefined && f["start-after"] !== undefined) fail("give --start now or --start-after N, not both");
  const startAfter = f["start-after"] !== undefined ? small("start-after", undefined) : 0;
  if (f["start-after"] !== undefined && startAfter < 1) fail("--start-after must be at least 1 block; --start now opens mining at the launch block");
  let startHeight = startAfter ? null : 0;
  if (startAfter && tip !== null) {
    try {
      startHeight = lib.startHeightFor({ start: "after", after: startAfter, tip });
    } catch (e) {
      fail(`--start-after: ${e.message}`);
    }
  }
  const endHeight = small("end", "0");
  if (endHeight !== 0 && startHeight !== null && endHeight < startHeight) fail(`--end must be 0 (no end) or at least the start block ${startHeight}`);
  const feeRate = f["fee-rate"] !== undefined ? small("fee-rate", undefined, 10_000) : null;
  if (feeRate !== null && feeRate < 1) fail("--fee-rate must be at least 1 sat/vB");

  // The service-fee policy is consensus (mining-contract.md D2): checked before anything is paid.
  if (!fee) throw new Error(`mining has no service-fee policy on ${NETWORK}; nothing was broadcast`);
  const claimFeeSats = big("claim-fee", "0");
  const treasury = f.treasury !== undefined ? scriptOf(String(f.treasury)) : new Uint8Array();
  const policy = lib.checkFeePolicy(claimFeeSats, treasury, fee);
  if (policy) throw new Error(`refused: ${policy} (${feePolicyText(fee)}); nothing was broadcast`);
  if (treasury.length && claimFeeSats === 0n) {
    throw new Error(`refused: --treasury receives only a deployer claim fee, and none is set (${feePolicyText(fee)}); nothing was broadcast`);
  }
  return {
    terms: {
      ticker, divisibility, reward, maxSupply, halvingInterval, span, targetPerSpan, initialDifficulty, minDifficulty, claimFeeSats, treasury,
      startHeight, endHeight,
    },
    hashrate, perBlock, startAfter, feeRate, dryRun: f["dry-run"] === true,
  };
}

/**
 * `deploy-pow <w> …`: checks the terms (deployPowTerms), the ticker, the end height against the
 * earliest mining start, and the activation height; prints the terms, the service fee and the
 * disclosures; then pays the launch from the wallet's BTC fee key, or with `--dry-run` prints the
 * signed transaction and broadcasts nothing. Refuses before paying whatever the indexer would
 * reject (a launch below the activation height would be `unknown op 9` and its fee spent).
 * `build({ envelope, feeRate })` signs the carrier (buildCarrierTx with the BTC fee key by default).
 */
export async function deployPowCommand({
  args, idx, esplora, lib, btcKey = null, encode = envelopeLib.encodeDeployPow, fee = params.MINE_FEE, print = console.log,
  build = ({ envelope, feeRate }) => buildCarrierTx({ api: esplora, btcKey, envelope, feeRate }),
}) {
  const { terms, hashrate, perBlock, startAfter, feeRate, dryRun } = deployPowTerms(args, { lib, fee, tip: idx.height });
  if (typeof encode !== "function") throw new Error("this checkout has no encodeDeployPow in src/envelope.mjs; nothing was broadcast");
  const envelope = encode(terms);
  if (idx.tickers.has(terms.ticker)) throw new Error(`ticker ${terms.ticker} is taken; nothing was broadcast`);
  const deployAt = idx.height + 1;
  const mineStart = lib.mineStartOf({ startHeight: terms.startHeight, deployHeight: deployAt });
  if (terms.endHeight !== 0 && terms.endHeight < mineStart) {
    throw new Error(
      `--end ${terms.endHeight} is before mining can start (block ${mineStart} if the launch lands in block ${deployAt}): ` +
        "the launch would be rejected and its fee spent; nothing was broadcast",
    );
  }
  const active = miningActiveAt(idx, deployAt);
  if (!active && !dryRun) {
    throw new Error(
      `mining is not active on ${NETWORK} at block ${deployAt} (${activationText(idx)}): the launch would be rejected as unknown op 9 ` +
        "and its fee spent; nothing was broadcast. --dry-run builds it without broadcasting",
    );
  }
  print(`DEPLOY_POW ${terms.ticker}: reward ${terms.reward} per claim, max supply ${terms.maxSupply}, divisibility ${terms.divisibility}`);
  print(
    `  difficulty: initial ${terms.initialDifficulty}${hashrate !== null ? ` (suggested for ${int(hashrate)} H/s)` : ""}, floor ${terms.minDifficulty}; ` +
      `span ${terms.span} blocks, ${terms.targetPerSpan} solutions per span (${perBlock} per block)`,
  );
  print(`  halving: ${terms.halvingInterval ? `the reward halves every ${int(terms.halvingInterval)} blocks` : "none"}`);
  const starts = startAfter
    ? `mining starts at block ${mineStart}, ${startAfter} blocks after block ${deployAt} if the launch lands there ` +
      `(counted from the current tip ${idx.height}: a later launch block shortens the delay, and a launch at or after block ${terms.startHeight} starts mining at its own block)`
    : `mining starts now: the first usable block is the launch block itself (block ${deployAt} if it lands in the next block), whose hash nobody knows before it is mined`;
  print(`  ${starts}; ends ${terms.endHeight ? `after block ${terms.endHeight}` : "when the supply is mined out"}`);
  print(`  ${MINE_COPY.start}`);
  if (terms.endHeight) print(`  the launch must land by block ${terms.endHeight}, or it is rejected (end before mining start) and its fee is spent`);
  print(`  service fee: ${feePolicyText(fee)}`);
  for (const line of [MINE_COPY.fee(fee), MINE_COPY.noise, MINE_COPY.quiet, MINE_COPY.hardware, MINE_COPY.censor, MINE_COPY.testCoins]) print(line);
  if (!active) print(`note: mining is not active at block ${deployAt} (${activationText(idx)}); this launch is built for inspection only`);
  const tx = await build({ envelope, feeRate: feeRate ?? undefined });
  if (dryRun) {
    print(`DEPLOY_POW (not broadcast): ${tx.txid}  ${tx.vsize} vB, fee ${tx.fee} sats\n${tx.hex}`);
    return { status: "dry-run", envelope, terms, mineStart, tx };
  }
  const txid = await esplora.broadcast(tx.hex);
  print(`DEPLOY_POW broadcast: ${txid}  (${tx.vsize} vB, fee ${tx.fee} sats)`);
  print(`  ${EXPLORER}/tx/${txid}`);
  return { status: "broadcast", envelope, terms, mineStart, tx, txid };
}

export const MINE_USAGE =
  `usage: ${CLI} mine <wallet> <TICKER> [--threads N] [--pay key|relay] [--linkable] [--max-claims n] [--max-fee-rate r] [--prepare-coins n] [--esplora url] [--relay url]`;
// A self-paid claim pays headroomRate(next-block rate) up front (a bump can be blocked): the one
// headroom of src/btc/funding.mjs (FEE_HEADROOM), as the web wallet. Every input carries its RBF_SEQUENCE.
const MINE_RELAY_MODE = "fast"; // a relayed claim goes out at once: its 12-block window is short
const CHANGE_FLOOR = 330n;

/**
 * Arguments of `mine`, strictly: <wallet> <TICKER>, then --threads, --pay key|relay (default key),
 * --max-claims, --max-fee-rate (sat/vB), --prepare-coins (key only), --esplora (the Bitcoin backend
 * the reference re-check reads block hashes from; default MURKLE_ESPLORA) and --relay (the relayer
 * for --pay relay, default MURKLE_RELAY_URL, else localhost; with --pay key it is read only for the
 * claims in flight); --linkable (with --pay relay only) relays claims even while the relay pool is thin (L1).
 * -> { name, ticker, pay, threads, maxClaims, maxFeeRate, prepareCoins, esplora, relay, linkable }
 * --threads is 1 … this machine's logical processors (each worker holds 4 MiB for Argon2 and
 * loads its own hash-wasm; thousands of them would exhaust memory before the self-test ends).
 */
export function parseMineArgs(args, { read = env, processors = logicalProcessors() } = {}) {
  const [name, ticker, ...rest] = args.map(String);
  if (!name || name.startsWith("--") || !ticker || ticker.startsWith("--")) throw new Error(MINE_USAGE);
  const f = parseStrictFlags(rest, { values: ["threads", "pay", "max-claims", "max-fee-rate", "prepare-coins", "esplora", "relay"], booleans: ["linkable"], usage: MINE_USAGE });
  const count = (k) => {
    if (f[k] === undefined) return null;
    if (!/^[1-9]\d{0,5}$/.test(f[k])) throw new Error(`--${k} must be a whole number above 0\n${MINE_USAGE}`);
    return Number(f[k]);
  };
  const pay = f.pay ?? "key";
  if (pay !== "key" && pay !== "relay") throw new Error(`--pay takes key or relay, not "${pay}"\n${MINE_USAGE}`);
  const maxThreads = Math.max(1, processors | 0);
  if (count("threads") !== null && count("threads") > maxThreads) {
    throw new Error(`--threads must be 1 to ${maxThreads} (this machine's logical processors)\n${MINE_USAGE}`);
  }
  const out = {
    name, ticker: ticker.toUpperCase(), pay, threads: count("threads"), maxClaims: count("max-claims"), maxFeeRate: count("max-fee-rate"),
    prepareCoins: count("prepare-coins"), esplora: f.esplora === undefined ? null : checkRelayUrl(f.esplora, "--esplora"), relay: null,
    linkable: f.linkable === true,
  };
  if (out.linkable && pay !== "relay") throw new Error(`--linkable goes with --pay relay: a claim paid from the mining key shows that key's address anyway\n${MINE_USAGE}`);
  if (out.prepareCoins !== null && pay === "relay") throw new Error(`--prepare-coins splits the mining key's coins; it does not go with --pay relay\n${MINE_USAGE}`);
  if (pay === "relay") out.relay = f.relay !== undefined ? checkRelayUrl(f.relay) : checkRelayUrl(read("RELAY_URL") || DEFAULT_RELAY, "MURKLE_RELAY_URL");
  else if (f.relay !== undefined) out.relay = checkRelayUrl(f.relay);
  return out;
}

/** This machine's logical processors (the --threads bound). */
export function logicalProcessors() {
  try {
    return typeof availableParallelism === "function" ? availableParallelism() : cpus().length;
  } catch {
    return 1;
  }
}

/** Codes of PowPool failures a miner retries (a slow, crashed or saturated worker); others end the run. */
const POW_RETRY = new Set(["POW_TIMEOUT", "POW_WORKER_FAILED", "POW_BUSY"]);
const POW_RETRY_MAX = 10; // consecutive failed rounds before mining stops
const SLICE_TARGET_MS = 2000; // an adaptive slice aims at about 2 s of hashing per thread
const SLICE_MAX = 4096;

/**
 * The wallet file's mining key (`mineKey`, 32 random bytes): it pays self-paid claims and never
 * transfers, top-ups or launches, and it is never the BTC fee key. Created and saved on first use.
 */
export function mineKeyOf(file, save = () => {}) {
  if (file.mineKey === undefined) {
    let key;
    do key = randomBytes(32).toString("hex");
    while (key === file.btcKey);
    file.mineKey = key;
    save();
  }
  if (!/^[0-9a-f]{64}$/.test(String(file.mineKey))) throw new Error("the wallet file's mineKey is not 32 bytes of hex; nothing was paid");
  if (file.mineKey === file.btcKey) throw new Error("the wallet file's mineKey equals its BTC fee key; the two must stay apart, nothing was paid");
  return Buffer.from(file.mineKey, "hex");
}

/**
 * The next-block fee rate (sat/vB): mempool.space's fastestFee when the backend is
 * mempool.space-like, else the backend's own estimate.
 */
export async function nextBlockRate(esplora) {
  // A chain source with its own next-block estimate answers first (hook H3): Esplora's fastestFee,
  // Bitcoin Core's estimatesmartfee 2 (which throws on mainnet rather than guess).
  if (typeof esplora.nextBlockFeeRate === "function") {
    const rate = Number(await esplora.nextBlockFeeRate());
    if (Number.isFinite(rate) && rate >= 0) return Math.max(1, Math.ceil(rate));
    throw new Error("the chain source gave no next-block fee rate");
  }
  if (typeof esplora.requestUrl === "function" && /\/api$/.test(String(esplora.base ?? ""))) {
    try {
      const fees = await (await esplora.requestUrl(esplora.base.replace(/\/api$/, "/api/v1") + "/fees/recommended", "/v1/fees/recommended")).json();
      const rate = Number(fees?.fastestFee);
      if (Number.isFinite(rate) && rate >= 0) return Math.max(1, Math.ceil(rate));
    } catch {
      // not mempool.space: its plain estimate below
    }
  }
  return esplora.feeRate();
}

/** What a carrier pays a fee script: the service amount, raised to that script's dust limit. */
const carrierAmount = (fundingLib, script, sats) =>
  typeof fundingLib.carrierAmountOf === "function" ? BigInt(fundingLib.carrierAmountOf(script, sats)) : sats < dustLimit(script) ? dustLimit(script) : sats;

/** The carrier outputs a claim of `asset` must pay: requiredFeeOutputs, each at its carrier amount. */
function feeOutputsFor(lib, asset, fee, fundingLib) {
  return lib.requiredFeeOutputs(asset, fee).map((o) => ({ script: o.script, sats: o.sats, amount: carrierAmount(fundingLib, o.script, o.sats), role: o.role }));
}

/**
 * Why a found solution must not be paid for now, or null. The checks the page runs before paying
 * (mining-contract.md §10.1), against the synced index at `tip`: the token still mining, the
 * reference inside the 12-block window with the relayer's slack (a claim paid later may land too
 * late), the reward, the solution not claimed yet, rolled notes unspent, the stale bound at the
 * next block, and the supply cap counting `inflight` claims already on the way: each at its own
 * reward when `inflightReward` (their sum, a bigint) is known, else at this claim's reward.
 */
export function claimRefusal({ lib, idx, asset, draft, powHash, solutionIdHex, tip, inflight = 0, inflightReward = null }) {
  const ref = draft.refHeight;
  const status = lib.mineStatus(asset, tip);
  if (status === "mining-ended") return "mining has ended for this token";
  if (status === "mined-out") return "the supply is mined out";
  if (ref < (asset.mineStart ?? lib.mineStartOf(asset))) return "mining had not started at the reference block";
  const last = ref + params.MINE_WINDOW - 1 - params.MINE_SLACK;
  if (tip > last) return `the reference block ${ref} is too old to pay for now (tip ${tip}, last safe tip ${last}). ${MINE_COPY.window}`;
  if (lib.rewardAt(asset, ref) !== draft.reward) return "the reward differs from the terms";
  if (idx.claimed?.has?.(solutionIdHex)) return "this solution was already claimed";
  if ((draft.rolled ?? []).some((n) => idx.nullifiers.has(String(n)))) return "a note rolled into this claim was spent meanwhile";
  const dEff = lib.effectiveDifficulty(asset, ref, tip + 1);
  if (!lib.meetsTarget(powHash, lib.targetOf(dEff))) return `${MINE_COPY.surge} (difficulty for the next block: ${dEff})`;
  const onTheWay = inflightReward === null ? BigInt(draft.reward) * BigInt(inflight) : BigInt(inflightReward);
  if (onTheWay + BigInt(draft.reward) > asset.maxSupply - asset.issued) {
    return `the supply cap would be reached, counting ${inflight} claim${inflight === 1 ? "" : "s"} already on the way`;
  }
  return null;
}

/** The pass/fail of one public check part of the indexer (true, null or undefined pass; a string is the reason). */
const failed = (r) => (typeof r === "string" ? r : null);

/** The indexer's checks of a claim whose carrier the relayer builds: every part but the carrier ones (mining-contract.md §6.4). */
async function relayLocalCheck(idx, env, height) {
  if (typeof idx.mineStatic !== "function") return null;
  return (
    failed(idx.mineStatic(env, height)) ??
    failed(idx.mineState(env)) ??
    failed(await idx.minePow(env, height)) ??
    failed(await idx.mineProof(env))
  );
}

/**
 * `mine --prepare-coins n`: splits the mining key's coins into `n` coins that each pay one claim
 * (about the carrier size at the claim fee rate, plus the service fee and change), so many
 * claims can be in flight at once. A plain payment to the mining key itself, paid from it.
 */
export async function prepareCoinsCommand({
  n, asset, lib, mineKey, esplora, fee = params.MINE_FEE, fundingLib = funding, maxFeeRate = null, sign = signLocal, print = console.log,
}) {
  if (typeof fundingLib.planSplitTx !== "function" || typeof fundingLib.mineCarrierVsize !== "function") {
    throw new Error("this checkout has no planSplitTx / mineCarrierVsize in src/btc/funding.mjs; nothing was broadcast");
  }
  const account = btcAccount(mineKey);
  const next = await nextBlockRate(esplora);
  const claimRate = maxFeeRate ?? headroomRate(next);
  const outs = feeOutputsFor(lib, asset, fee, fundingLib);
  const service = outs.reduce((s, o) => s + o.amount, 0n);
  const vsize = fundingLib.mineCarrierVsize({ feeOutputs: outs.length, change: true });
  const value = feeFor(claimRate, vsize) + service + CHANGE_FLOOR;
  const plan = fundingLib.planSplitTx({ account, utxos: await esplora.utxos(account.address), n, value, feeRate: next });
  const tx = sign(plan.tx, mineKey);
  print(`mining fee address ${account.address}: ${n} coins of ${int(value)} sats (each pays one ${asset.ticker} claim: about ${vsize} vB at up to ${claimRate} sat/vB plus ${int(service)} sats of service fee)`);
  const txid = await esplora.broadcast(tx.hex);
  print(`prepare-coins broadcast: ${txid}  (${tx.vsize} vB, fee ${int(plan.fee)} sats)`);
  print(`  ${EXPLORER}/tx/${txid}`);
  return { status: "broadcast", txid, value, n, fee: plan.fee };
}

/**
 * The miner (mining-contract.md §11): until `maxClaims` claims are sent, `signal` aborts, or the
 * token stops mining, it
 *  1. builds a new claim draft on each new tip and after each solution (fresh commitments and
 *     nullifiers, `wallet.prepareClaim`), so no two claims share either;
 *  2. hands slices of nonces to the worker pool (`pool.grind`), one slice per thread, and polls the
 *     backend's tip between slices;
 *  3. on a solution: re-checks it with the reference Argon2 against the block hash its own backend
 *     (`esplora`) reports for the reference block (a fast path that disagrees stops mining), then
 *     claimRefusal against the synced index, counting claims in flight;
 *  4. binds and proves it for its route and checks it with the local indexer rules, then writes
 *     the W-M entry (kind "mine", locked until ref + 12) before it leaves this machine;
 *  5. `pay: "key"` pays the carrier from the mining key (bound to a coin chosen now, a next-block
 *     rate x 1.25 paid up front, RBF signalled); `pay: "relay"` submits it, signed by the relay
 *     account, after checking that the relay balance covers the quote. A relayed claim is never
 *     paid from the mining key, whatever the relayer answers.
 * Prints H/s, solutions, claims sent, claims landed and fees spent.
 * -> { status: "done" | "stopped" | "ended" | "error", solutions, sent, landed, feesSats, hashes, reason? }
 */
export async function runMiner({
  idx, wallet, file, save = () => {}, name = "<wallet>", ticker, lib, pool, esplora, resync = async () => {}, pay = "key", maxClaims = Infinity,
  maxFeeRate = null, mineKey = null, relay = null, linkable = false, fee = params.MINE_FEE, fundingLib = funding, decode = decodeEnvelope, sign = signLocal,
  print = console.log, warn = (s) => process.stderr.write(`${s}\n`), now = Date.now, sleep = delay, signal, slice = null, threads = pool.size ?? 1,
  pollMs = 15_000, statsMs = 10_000, randomCounter = () => BigInt(`0x${randomBytes(8).toString("hex")}`),
}) {
  if (pay !== "key" && pay !== "relay") throw new Error(`unknown route "${pay}"`);
  let asset = assetByTicker(idx, String(ticker));
  if (asset.kind !== "pow") throw new Error(`${asset.ticker} is not a mined token; mint it with: ${CLI} mint ${name} ${asset.ticker}`);
  if (!miningActiveAt(idx, idx.height + 1)) throw new Error(`mining is not active on ${NETWORK} at block ${idx.height + 1} (${activationText(idx)}); nothing was mined`);
  if (!fee) throw new Error(`mining has no service-fee policy on ${NETWORK}; nothing was mined`);
  const stats = { solutions: 0, sent: 0, landed: 0, feesSats: 0, hashes: 0 };
  const sent = []; // this run's W-M entries, for their verdicts
  const settled = new Set(); // entries whose verdict was printed
  const done = (status, reason) => {
    print(`mined ${stats.solutions} solution${stats.solutions === 1 ? "" : "s"}, sent ${stats.sent} claim${stats.sent === 1 ? "" : "s"}, ${stats.landed} landed; fees spent ${int(stats.feesSats)} sats`);
    return { status, ...stats, ...(reason ? { reason } : {}) };
  };
  const quit = (reason) => {
    print(`stopped: ${reason}`);
    return done("error", reason);
  };

  // The route, checked before any work.
  let account = null;
  let info = null;
  const quoteOf = (m) => m.carrierFeeSats + feeOutputsFor(lib, asset, fee, fundingLib).reduce((s, o) => s + Number(o.amount), 0) + m.marginSats;
  const relayInfo = async () => {
    info = await balanceInfo(relay.client, relay.url);
    const m = info.mine;
    if (!m || m.enabled !== true) return `the relayer at ${relay.url} is not taking mining claims right now (${m?.code ?? "mine_disabled"}); a relayed claim is never paid from your own key, so nothing was paid`;
    if (!/^[0-9a-f]{64}$/.test(String(m.bindScriptHash ?? ""))) return `the relayer at ${relay.url} published no valid mining bind; nothing was paid`;
    if (!Number.isSafeInteger(m.carrierFeeSats) || !Number.isSafeInteger(m.marginSats)) return "the relayer does not quote mining claims yet; nothing was paid";
    const acct = await readRelayAccount({ client: relay.client, info, account: relay.account, lib: relay.lib, now });
    const need = quoteOf(m);
    if (acct.balance < need) return `relay balance ${int(acct.balance)} sats; a claim needs about ${int(need)}. Nothing was paid. Top up: ${CLI} relay topup ${name}`;
    // L1: while the pool is thin a claim's carrier input ties it to your top-up; only with --linkable.
    const cover = poolCoverOf(info);
    if (coverThin(cover) && linkable !== true) return poolThinLines(cover, { what: "claim" }).join(" ");
    if (!cover) print(MIX_UNKNOWN);
    return null;
  };
  if (pay === "key") {
    if (!mineKey) throw new Error("--pay key needs the wallet's mining key");
    account = btcAccount(mineKey);
    print(`mining fee address ${account.address} (separate from the BTC fee key; it pays only claims)`);
    if (!(await esplora.utxos(account.address)).length) {
      return quit(`no coins at the mining fee address ${account.address}; fund it with ${NETWORK === "signet" ? "signet coins" : `bitcoin (${NETWORK})`} (then: ${CLI} mine ${name} ${asset.ticker} --prepare-coins n), nothing was mined`);
    }
    print(MINE_COPY.key);
  } else {
    if (!relay?.client || !relay.lib || !relay.account) throw new Error("--pay relay needs a relayer");
    const why = await relayInfo();
    if (why) return quit(why);
    print(`relay ${relay.url}: about ${int(quoteOf(info.mine))} sats of relay balance per claim (Bitcoin fee ${int(info.mine.carrierFeeSats)} + service fee + margin ${int(info.mine.marginSats)})`);
    print(MINE_COPY.relay(asset.ticker, lib.rewardAt(asset, Math.max(idx.height, asset.mineStart ?? 0))));
  }
  for (const line of [MINE_COPY.fee(fee), MINE_COPY.hardware, MINE_COPY.censor, MINE_COPY.window, ...(pay === "key" ? [MINE_COPY.bump] : []), MINE_COPY.testCoins]) print(line);

  // Claims of this token still on the way: this wallet's own, or what the relayer counts (relayer
  // queue and mempool), whichever is more. -> { n, reward: Σ their rewards (each its own) | null }
  const inflight = async (thisReward) => {
    const mine = (file.pending ?? []).filter((p) => p.kind === "mine" && p.asset === String(asset.id) && ["submitted", "relaying"].includes(p.status));
    const own = { n: mine.length, reward: mine.reduce((s, p) => s + (/^\d+$/.test(String(p.reward ?? "")) ? BigInt(p.reward) : BigInt(thisReward)), 0n) };
    let remote = { n: 0, reward: 0n };
    if (relay?.client?.mineAsset) {
      try {
        const v = await relay.client.mineAsset(asset.id);
        if (Number.isSafeInteger(v?.pendingClaims)) {
          const sum = /^\d+$/.test(String(v.pendingReward ?? "")) ? BigInt(v.pendingReward) : BigInt(thisReward) * BigInt(v.pendingClaims);
          remote = { n: v.pendingClaims, reward: sum };
        }
      } catch (e) {
        warn(`${e.message}; counting only this wallet's claims in flight`);
      }
    }
    return remote.reward > own.reward ? remote : own;
  };

  // A new tip: sync, rescan, verdicts of this run's claims, W-M entries that ended.
  const refresh = async () => {
    await resync();
    wallet.scan(idx);
    asset = idx.assets.get(asset.id) ?? asset;
    for (const e of sent.filter((x) => !settled.has(x))) {
      if (e.via === "relay" && e.relayId) {
        let st = null;
        try {
          st = await relay.client.status(e.relayId);
        } catch (err) {
          warn(`${err.message}; still waiting`);
        }
        if (st?.txid && st.txid !== e.txid) e.txid = st.txid;
        if (st?.status === "accepted") {
          settled.add(e);
          Object.assign(e, { status: "landed", height: st.height ?? null });
          stats.landed += 1;
          if (Number.isSafeInteger(st.cost)) stats.feesSats += st.cost;
          print(`landed: ${e.reward} ${e.ticker} in block ${st.height ?? "?"} (carrier ${e.txid ?? "?"}${Number.isSafeInteger(st.cost) ? `, charged ${int(st.cost)} sats` : ""})`);
          continue;
        }
        if (st && ["rejected", "expired", "dropped", "missed"].includes(st.status)) {
          settled.add(e);
          Object.assign(e, { status: "failed", error: st.status, reason: st.reason ?? null });
          print(`relay ${st.status}: claim of block ${e.ref}${st.reason ? ` (${st.reason})` : ""}`);
          continue;
        }
      }
      const l = e.txid ? idx.log.find((x) => x.txid === e.txid) : null;
      if (l) {
        settled.add(e);
        Object.assign(e, { status: l.ok ? "landed" : "rejected", height: l.height });
        if (l.ok) stats.landed += 1;
        print(l.ok ? `landed: ${e.reward} ${e.ticker} in block ${l.height} (${e.txid})` : `rejected in block ${l.height}: ${l.reason} (${e.txid})`);
      } else if (idx.height >= e.lockUntil) {
        settled.add(e);
        Object.assign(e, { status: "expired" });
        print(`expired: the claim of block ${e.ref} did not land by block ${e.lockUntil}`);
      }
    }
    const before = JSON.stringify(file.pending ?? []);
    file.pending = keepPending(file.pending ?? [], idx);
    for (const p of file.pending) (p.spends ?? []).forEach((n) => wallet.locked.add(String(n)));
    if (JSON.stringify(file.pending) !== before) save();
  };
  const tipMoved = async () => (await esplora.tipHeight()) > idx.height;

  // One found solution, from the re-check to the hand-out. -> null (keep mining) or a reason to stop.
  const claim = async (draft, found) => {
    // 1. Reference re-check: the block hash from this miner's own backend, the reference Argon2.
    const ownHash = await esplora.blockHash(draft.refHeight);
    if (ownHash !== draft.refHash) {
      print(`solution not paid: block ${draft.refHeight} has another hash at the Bitcoin backend (a reorganisation?); nothing was paid`);
      return null;
    }
    const challenge = lib.challengeOf({ asset: asset.id, refHeight: draft.refHeight, refHash: ownHash, reward: draft.reward, commitments: draft.commitments });
    if (!equal(challenge, draft.challenge)) return "the claim draft does not match the reference block; nothing was paid";
    const reference = lib.powHashReference(lib.passwordOf(challenge, found.nonce));
    if (!equal(reference, found.powHash)) {
      lib.disableFastPath?.("disagreed with the reference on a found solution");
      return "the fast Argon2 path disagreed with the reference implementation on a found solution; mining stopped and nothing was paid";
    }
    const solutionIdHex = hex(lib.solutionIdOf(challenge, found.nonce));
    // 2. The checks before paying, at the current tip.
    if (await tipMoved()) await refresh();
    const n = await inflight(draft.reward);
    const why = claimRefusal({ lib, idx, asset, draft, powHash: reference, solutionIdHex, tip: idx.height, inflight: n.n, inflightReward: n.reward });
    if (why) {
      print(`solution not paid: ${why}`);
      return null;
    }
    const room = asset.maxSupply - asset.issued;
    const recent = (asset.claimsByHeight ?? []).filter(([h]) => h > idx.height - 3).reduce((s, [, c]) => s + c, 0);
    if (room < BigInt(draft.reward) * BigInt(recent + 1)) print(MINE_COPY.nearCap);
    const entry = {
      kind: "mine", via: pay === "relay" ? "relay" : "self", ticker: asset.ticker, asset: String(asset.id), reward: String(draft.reward), ref: draft.refHeight,
      solutionId: solutionIdHex, commitments: draft.commitments.map(String), spends: (draft.rolled ?? []).map(String),
      lockUntil: draft.refHeight + params.MINE_WINDOW, status: "submitted", createdAt: now(),
    };
    const record = () => {
      file.pending ??= [];
      file.pending.push(entry);
      if (typeof wallet.lockClaim === "function") wallet.lockClaim(draft);
      entry.spends.forEach((x) => wallet.locked.add(x));
      save();
      sent.push(entry);
      stats.sent += 1;
    };

    if (pay === "key") {
      // 3a. Self-paid: a coin of the mining key chosen now, a deadline-safe rate paid up front.
      const rate = headroomRate(await nextBlockRate(esplora));
      if (maxFeeRate !== null && rate > maxFeeRate) {
        print(`solution not paid: the claim fee rate would be ${rate} sat/vB, above --max-fee-rate ${maxFeeRate}`);
        return null;
      }
      const utxos = await esplora.utxos(account.address);
      if (!utxos.length) return `no coins left at the mining fee address ${account.address}; nothing was paid`;
      const bind = pickBindUtxo(utxos);
      print(`proving the claim of ${draft.reward} ${asset.ticker} (bound to ${bind.txid}:${bind.vout})…`);
      const envelope = await wallet.finalizeClaim(draft, { bindOutpoint: outpointOf(bind.txid, bind.vout) }, found.nonce);
      const outs = feeOutputsFor(lib, asset, fee, fundingLib);
      let plan;
      try {
        plan = fundingLib.planCarrierTx({
          account, utxos, envelope, outputs: outs.map((o) => ({ script: o.script, amount: o.amount })), feeRate: rate, firstInput: bind, sequence: RBF_SEQUENCE,
        });
      } catch (e) {
        return `${e.message}; nothing was paid`;
      }
      const tx = sign(plan.tx, mineKey);
      const shape = {
        txid: tx.txid,
        inputs: plan.inputs.map((i) => ({ outpoint: outpointOf(i.txid, i.vout) })),
        outputs: Array.from({ length: plan.tx.outputsLength }, (_, i) => plan.tx.getOutput(i)).map((o) => ({ script: o.script, value: o.amount })),
      };
      if (typeof idx.checkMine === "function") {
        const verdict = await idx.checkMine(decode(envelope), shape, idx.height + 1);
        if (verdict !== true) {
          print(`solution not paid: the claim fails the local check (${verdict})`);
          return null;
        }
      }
      const service = outs.reduce((s, o) => s + o.amount, 0n);
      // W-M: the entry exists before the carrier leaves this machine.
      Object.assign(entry, { txid: tx.txid });
      record();
      try {
        await esplora.broadcast(tx.hex);
      } catch (e) {
        print(`${e.message}. The carrier ${tx.txid} may still have reached the network: its solution and notes stay locked until it lands or block ${entry.lockUntil}`);
        return null;
      }
      stats.feesSats += Number(plan.fee) + Number(service);
      print(`claim broadcast: ${tx.txid}  (${tx.vsize} vB, fee ${int(plan.fee)} sats + service fee ${int(service)} sats)`);
      print(`  ${EXPLORER}/tx/${tx.txid}`);
      return null;
    }

    // 3b. Relayed: the relay balance must cover the quote before anything is proved or handed over.
    const why2 = await relayInfo();
    if (why2) return why2;
    if (maxFeeRate !== null && Number(info.mine.feeRate) > maxFeeRate) {
      print(`solution not paid: the relayer's claim fee rate is ${info.mine.feeRate} sat/vB, above --max-fee-rate ${maxFeeRate}`);
      return null;
    }
    const prove = async (bindHex) => {
      print(`proving the claim of ${draft.reward} ${asset.ticker} for the relayer…`);
      return wallet.finalizeClaim(draft, { bindScriptHash: unhex(bindHex) }, found.nonce);
    };
    let envelope = await prove(info.mine.bindScriptHash);
    const local = await relayLocalCheck(idx, decode(envelope), idx.height + 1);
    if (local) {
      print(`solution not paid: the claim fails the local check (${local})`);
      return null;
    }
    Object.assign(entry, { status: "relaying", relay: relay.url, relayId: null, envelope: hex(envelope) });
    record();
    const signed = () =>
      relay.lib.signRequest({
        account: relay.account, endpoint: relay.lib.RELAY_ENDPOINTS.submit, network: info.network, poolKey: relay.lib.parsePoolKey(info.balance.poolKey),
        fields: linkable === true ? { envelope: entry.envelope, mode: MINE_RELAY_MODE, linkable: true } : { envelope: entry.envelope, mode: MINE_RELAY_MODE }, now,
      });
    let res;
    let busy = 0;
    let rebound = false;
    try {
      for (;;) {
        res = await relay.client.submit(signed());
        if (res.status === 202) break;
        const err = res.body?.error ?? {};
        const code = err.code ?? `http_${res.status}`;
        if (code === "busy" && busy++ < BUSY_RETRIES) {
          warn("the relayer is busy; trying again in 5 s");
          await sleep(5000);
        } else if (code === "bind_stale" && !rebound) {
          // The relayer's change address changed: the same solution, proved again for the new bind.
          rebound = true;
          const fresh = /^[0-9a-f]{64}$/.test(String(res.body?.bindScriptHash ?? "")) ? res.body.bindScriptHash : (await relay.client.info()).mine?.bindScriptHash;
          envelope = await prove(fresh);
          entry.envelope = hex(envelope);
          save();
        } else {
          Object.assign(entry, { status: "failed", error: code, reason: err.message ?? `HTTP ${res.status}` });
          save();
          print(`relay refused: ${code} (${entry.reason}); the solution stays locked until block ${entry.lockUntil} and is never paid from your own key`);
          if (code === "pool_thin") return `the relayer refused the claim (pool_thin): ${POOL_THIN} To relay claims anyway: --linkable; to pay them yourself: --pay key`;
          return ["balance_low", "mine_disabled", "halted", "fee_high", "rate_limited", "disabled"].includes(code) ? `the relayer refused the claim (${code})` : null;
        }
      }
    } catch (e) {
      Object.assign(entry, { status: "failed", error: e.code === "unreachable" ? "unreachable" : "error", reason: e.message });
      save();
      return `${e.message}; the solution stays locked until block ${entry.lockUntil}`;
    }
    const b = res.body ?? {};
    if (typeof b.id !== "string") {
      Object.assign(entry, { status: "failed", error: "malformed", reason: "the relayer answered 202 without a relay id" });
      save();
      return "the relayer answered 202 without a relay id";
    }
    Object.assign(entry, { status: "submitted", relayId: b.id, ...(Number.isSafeInteger(b.deadline) ? { deadline: b.deadline } : {}), ...(b.linkable === true || b.thin === true ? { linkable: true } : {}) });
    save();
    if (entry.linkable) print(`claim ${LINKABLE_LINE}`);
    print(
      `claim queued at the relayer: relay id ${b.id.slice(0, 12)}…` +
        (Number.isSafeInteger(b.reservedSats) ? `, ${int(b.reservedSats)} sats reserved (service fee ${b.serviceSats ?? "?"} sats)` : "") +
        (Number.isSafeInteger(b.lastBroadcast) ? `; it goes out by block ${b.lastBroadcast} or not at all` : ""),
    );
    return null;
  };

  // Adaptive slices (slice === null): start small, then about SLICE_TARGET_MS per slice.
  const e2code = (e) => String(e?.code ?? "");
  const sizing = {
    count: 16,
    msPerHash: null,
    failures: 0,
    measure(n, ms) {
      if (!(ms > 0) || !(n > 0)) return;
      this.msPerHash = ms / n;
      this.count = Math.max(1, Math.min(SLICE_MAX, Math.round(SLICE_TARGET_MS / this.msPerHash)));
    },
    // Four times the expected time of the slice, never below the pool's 30 s default.
    timeoutMs(n) {
      return this.msPerHash === null ? undefined : Math.max(30_000, Math.ceil(n * this.msPerHash * 4));
    },
  };

  // The loop: one draft per tip and per solution.
  let lastStats = now();
  let windowHashes = 0;
  let announced = null;
  while (!signal?.aborted && stats.sent < maxClaims) {
    const status = lib.mineStatus(asset, idx.height);
    if (status === "mining-ended" || status === "mined-out") {
      print(`${asset.ticker}: ${status === "mined-out" ? "the supply is mined out" : "mining has ended"} at block ${idx.height}`);
      return done("ended");
    }
    if (status === "mining-soon") {
      if (announced !== "soon") print(`${asset.ticker}: mining starts at block ${asset.mineStart ?? lib.mineStartOf(asset)}; waiting (tip ${idx.height})`);
      announced = "soon";
      await sleep(pollMs, signal);
      if (!signal?.aborted && (await tipMoved())) await refresh();
      continue;
    }
    const ref = idx.height;
    const refHash = idx.hashes.get(ref);
    const reward = lib.rewardAt(asset, ref);
    let draft;
    try {
      draft = wallet.prepareClaim(idx, { asset: asset.id, reward, refHeight: ref, refHash });
    } catch (e) {
      return quit(`${e.message}; nothing was paid`);
    }
    const dEff = lib.effectiveDifficulty(asset, ref, ref + 1);
    const target = lib.targetOf(dEff);
    if (announced !== ref) print(`block ${ref}: reward ${reward} ${asset.ticker}, difficulty ${dEff}, ${threads} thread${threads === 1 ? "" : "s"}`);
    announced = ref;
    let found = null;
    let lastPoll = now();
    let moved = false;
    while (!found && !signal?.aborted) {
      // One round: a slice per thread. A slice is sized from the measured rate (about 2 s each,
      // whatever the machine or the Argon2 implementation) unless the caller fixed it, and its
      // task timeout grows with it, so a slow machine never meets the pool's 30 s default.
      const count = slice ?? sizing.count;
      const t0 = now();
      const settledRound = await Promise.allSettled(
        Array.from({ length: threads }, () => pool.grind({ challenge: draft.challenge, target, nonceStart: randomCounter(), count, timeoutMs: sizing.timeoutMs(count) })),
      );
      const results = settledRound.filter((x) => x.status === "fulfilled").map((x) => x.value);
      const failed = settledRound.filter((x) => x.status === "rejected").map((x) => x.reason);
      const fatal = failed.find((e) => !POW_RETRY.has(e?.code));
      if (fatal) {
        if (e2code(fatal) === "POW_CLOSED" || e2code(fatal) === "POW_SELF_TEST") return quit(`${fatal.message}; nothing more was mined`);
        throw fatal;
      }
      if (failed.length) {
        // A failure is retried, never a verdict: a smaller slice, a fresh worker (the pool replaced it).
        sizing.failures += 1;
        warn(`${failed[0].message} (${failed[0].code}); retrying with a smaller slice`);
        if (slice === null) sizing.count = Math.max(1, Math.floor(sizing.count / 2));
        if (sizing.failures >= POW_RETRY_MAX) return quit(`the Argon2 workers failed ${sizing.failures} rounds in a row (${failed[0].message}); nothing more was mined`);
      } else sizing.failures = 0;
      if (slice === null && !failed.length) sizing.measure(count, now() - t0);
      const tried = results.reduce((s, r) => s + (Number(r?.tried) || 0), 0);
      stats.hashes += tried;
      windowHashes += tried;
      found = results.find((r) => r?.nonce) ?? null;
      if (now() - lastStats >= statsMs) {
        const hs = Math.round((windowHashes * 1000) / Math.max(1, now() - lastStats));
        print(`${int(hs)} H/s  solutions ${stats.solutions}  claims sent ${stats.sent}  landed ${stats.landed}  fees spent ${int(stats.feesSats)} sats`);
        lastStats = now();
        windowHashes = 0;
      }
      if (!found && now() - lastPoll >= pollMs) {
        lastPoll = now();
        if (await tipMoved()) {
          moved = true;
          break;
        }
      }
    }
    if (signal?.aborted) break;
    if (found) {
      stats.solutions += 1;
      print(`solution found for block ${ref}`);
      const stop = await claim(draft, found);
      if (stop) return quit(stop);
    }
    if (moved || (await tipMoved())) await refresh();
  }
  return done(signal?.aborted ? "stopped" : "done");
}

/**
 * Explains a first diverging height of `audit --compare` that is where the digest version
 * changes on either side (the other side runs a different release), or null. Both sides agree
 * up to height - 1, so the version there is the same; `remoteVersion` is the remote's
 * /api/digest `version` at `height` (absent means 1), or null when unknown.
 */
export function digestVersionLine(idx, height, remoteVersion = null) {
  const at = (h) => (typeof idx.digestVersionAt === "function" ? idx.digestVersionAt(h) : 1);
  const before = at(height - 1);
  const local = at(height);
  const changed = local !== before ? local : remoteVersion !== null && remoteVersion !== before ? remoteVersion : null;
  return changed === null ? null : `digest version changes at ${height} (v${before} -> v${changed}): the other side runs a different release`;
}

/** What `murkle assets` prints for a mined token at `tip`: issuance, terms, fees. */
export function minedAssetLines(a, tip, lib) {
  return [
    `${a.ticker.padEnd(16)} id ${assetRef(a.id)}  mined ${a.issued}/${a.maxSupply} in ${a.claims} claims  reward ${lib.rewardAt(a, tip)}  difficulty ${lib.difficultyAt(a, tip)}  ${lib.mineStatus(a, tip)}`,
    `  deployed at ${a.deployHeight} in ${short(a.deployTxid)}  mining from block ${a.mineStart}${a.endHeight ? ` to ${a.endHeight}` : ""}  span ${a.span}, ${a.targetPerSpan} solutions per span  floor ${a.minDifficulty}${a.halvingInterval ? `  halving every ${a.halvingInterval}` : ""}`,
    `  service fees paid by accepted claims ${a.feeSats} sats (gross)  rejected claims ${a.rejectedClaims} (their fees spent: ${a.burnedFeeSats} sats)`,
  ];
}

const DEPLOY_FLAGS = ["ticker", "amount", "cap", "price", "treasury", "divisibility", "start", "end"];
const BTC1 = `${params.BTC_HRP}1…`; // tb1… on signet, bc1… on mainnet
const MRK1 = `${params.ADDRESS_HRP}1…`; // mrk1… on signet, murk1… on mainnet
const DEPLOY_USAGE = `usage: ${CLI} deploy <wallet> --ticker T --amount <per mint> --cap <mints> [--price sats --treasury ${BTC1}] [--divisibility d --start h --end h]`;

const SEND_USAGE = `usage: ${CLI} send <wallet> <ticker> <amount> <${MRK1} address> [--relay [url] [--fast | --batch | --batch10] [--linkable] [--no-wait] [--wait-max <minutes>]]`;

export const HELP = [
  `${BRAND} CLI (${NETWORK}). Commands:`,
  "  new <w> | address <w> | balance <w> | sync | assets | log [n]",
  `  deploy <w> --ticker T --amount N --cap N [--price sats --treasury ${BTC1}] [--divisibility d --start h --end h]`,
  `  mint <w> <ticker> | send <w> <ticker> <amount> <${MRK1}>`,
  `  send <w> <ticker> <amount> <${MRK1}> --relay [url] [--fast | --batch | --batch10] [--linkable] [--no-wait] [--wait-max <minutes>]`,
  "  pending <w> [--relay url] | retry <w> [--relay [url]] [--fast | --batch | --batch10] [--linkable] [--no-wait] [--wait-max <minutes>]",
  "  relay account <w> [--relay url]   your relay balance and next deposit address (alias: relay balance <w>)",
  "  relay topup <w> [--relay url] [--pay <sats> [--fee-rate n] [--dry-run]]   a fresh deposit address; --pay pays it from the BTC fee key",
  "  relay credit <w> [<txid:vout> [<n>]] [--older] [--relay url]   credits confirmed deposits to your relay balance",
  "  deploy-pow <w> --ticker T --reward N --max-supply N [--span 24] [--per-block 1] [--difficulty D | --hashrate H] [--min-difficulty D] [--halving n] [--start now | --start-after N] [--end h] [--fee-rate r] [--dry-run]",
  "  mine <w> <TICKER> [--threads N] [--pay key|relay] [--linkable] [--max-claims n] [--max-fee-rate r] [--prepare-coins n] [--esplora url] [--relay url]",
  `Mining (once the mining activation height is set): every claim pays a Bitcoin fee and a service fee of ${params.MINE_FEE ? int(params.MINE_FEE.platformSats) : "N"} sats to the ${BRAND} platform address. --pay key (the default) pays from the wallet's separate mining key, so the token, the reward and that address are public; --pay relay pays from the relay balance, and the relayer sees the token and the reward of every claim it carries for you.`,
  "  attest genesis <w> [--dry-run] [--force]",
  "  address-script <bitcoin address>   prints its scriptPubKey hex (this network's addresses only)",
  "  audit [--esplora <url>] [--compare <indexer url>] [--from h] [--to h]",
  "  relayer retire-free --to <address> [--dry-run]   operator only: sweeps the retired relayer's old coins to <address>",
  "  relayer evacuate --to <cold address> [--fee-rate n] [--dry-run] | --bump | --cancel   operator only, the relayer's keys may be compromised: stops sends and top-ups, sweeps every relayer coin to <cold address>",
  "  relayer rotate | refund-pool --from <key file> | --outpoint <txid:vout> | sweep-retired | status   operator only: new keys (balances carried over), refill the new pool, late deposits to old addresses",
  "A self-paid send is paid from the wallet's BTC fee key: Bitcoin shows that address paid for the transfer, permanently. It is the default and needs no relayer.",
  "A relayed send (--relay) is paid from a relay balance you top up first with a plain BTC payment to a fresh deposit address; the relayer charges each send its network fee plus a margin, and refuses (nothing handed over) when the balance is short.",
  "The relayer can link the address you top up from to every transfer you relay with that balance; it cannot see amounts, tokens or recipients.",
  `--relay uses MURKLE_RELAY_URL, else ${DEFAULT_RELAY}. The relayer also sees your IP address and when you submit.`,
  "A relayer on another machine needs https:// (plain http:// only to this machine or a .onion address).",
  "  (default)  next block: goes out when the next block arrives",
  "  --fast     goes out at once",
  "  --batch    hourly batch: anchored at the last block divisible by 6, goes out with its whole batch 6 blocks later",
  "  --batch10  10-hour batch: the same at blocks divisible by 60 (60 blocks later); a separate, thinner crowd",
  "  It waits and reports until the transfer lands; --no-wait returns once queued, --wait-max stops after N minutes.",
  "  --linkable relays even while too few people have topped up the relay pool: the carrier's input can then tie the transfer to your top-up address. Without it such a send is refused before anything is handed over.",
  "Exit codes: 0 landed (or queued with --no-wait), 1 error with nothing handed over, 3 not in this batch, 4 refused, failed or missed, 5 --wait-max reached, 130 interrupted.",
  "relay credit exits 0 when every deposit found is credited, 1 on an error or when none is found, 4 when one is refused, 6 when some still wait for confirmations.",
];

const commands = {
  async new([name]) {
    if (!name) throw new Error(`usage: ${CLI} new <name>`);
    mkdirSync(WALLETS, { recursive: true, mode: 0o700 });
    ownerOnly(WALLETS, 0o700);
    if (existsSync(walletPath(name))) throw new Error(`wallet "${name}" already exists`);
    // Owner-only and exclusive: an existing wallet (its only copy of the seed) is never overwritten.
    // Bound to its network (a file without the field is a signet one, as every earlier file).
    const fresh = { ...(NETWORK === "signet" ? {} : { network: NETWORK }), seed: randomBytes(32).toString("hex"), btcKey: randomBytes(32).toString("hex"), pending: [] };
    createFileDurable(walletPath(name), JSON.stringify(fresh, null, 2));
    if (!IS_TESTNET) console.log(`This wallet file holds plaintext keys for Bitcoin ${NETWORK}: ${walletPath(name)}. Back it up, keep it private, and hold only small amounts with it.`);
    await commands.address([name]);
  },

  /** Read-only: the scriptPubKey hex of a Bitcoin address of this network (for MINE_FEES.<network>.platformScript). */
  async "address-script"([address]) {
    if (!address) throw new Error(`usage: ${CLI} address-script <bitcoin address of ${NETWORK}>`);
    console.log(addressScriptHex(address));
  },

  async address([name]) {
    const file = readWalletFile(name);
    console.log(`${BRAND} address: ${encodeAddress(deriveKeys(Buffer.from(file.seed, "hex")))}`);
    // Signet keeps its line verbatim; mainnet names the network and says what the coins are.
    const where = NETWORK === "signet" ? "signet" : `Bitcoin ${NETWORK}: real bitcoin`;
    console.log(`BTC fee address: ${btcAccount(Buffer.from(file.btcKey, "hex")).address}  (${where}; fund it for fees and mint prices)`);
    if (file.mineKey) console.log(`mining fee address: ${btcAccount(mineKeyOf(file)).address}  (pays self-paid mining claims only)`);
  },

  async sync() {
    const idx = await synced();
    console.log(`indexed to ${idx.height} (start ${idx.startHeight}), ${idx.assets.size} assets, ${idx.outputs.length} notes`);
    console.log(`digest ${idx.digestAt(idx.height) ?? "—"}`);
  },

  async balance([name]) {
    const idx = await synced();
    const { wallet, file, btcKey } = await openWallet(name, idx);
    const account = btcAccount(btcKey);
    const sats = (await api.utxos(account.address)).reduce((s, u) => s + u.value, 0);
    console.log(`BTC  ${sats} sats  (${account.address})`);
    for (const asset of idx.assets.values()) {
      const bal = wallet.balance(asset.id);
      if (bal > 0n) console.log(`${asset.ticker.padEnd(16)} ${bal}`);
    }
    if (file.pending.length) console.log(`${file.pending.length} pending envelope(s)`);
  },

  async assets() {
    const idx = await synced();
    if (!idx.assets.size) return console.log("no assets yet");
    const lib = [...idx.assets.values()].some((a) => a.kind === "pow") ? await loadMineLib() : null;
    for (const a of idx.assets.values()) {
      if (a.kind === "pow") {
        for (const line of minedAssetLines(a, idx.height, lib)) console.log(line);
        continue;
      }
      const supply = a.mintAmount * BigInt(a.mintCap);
      console.log(
        `${a.ticker.padEnd(16)} id ${assetRef(a.id)}  minted ${a.minted}/${a.mintCap} x ${a.mintAmount} (max ${supply})  price ${a.priceSats} sats`,
      );
      const window = `${a.startHeight || "any"}..${a.endHeight || "open"}`;
      const status = a.soldOutHeight !== null ? `sold out at ${a.soldOutHeight}` : a.minted ? "minting" : "no mints yet";
      console.log(`  deployed at ${a.deployHeight} in ${short(a.deployTxid)}  window ${window}  first mint ${a.firstMintHeight ?? "—"}  ${status}`);
      // Gross: every sat mints paid to the treasury script, overpayment and change included (SPEC §11).
      const revenue = a.priceSats > 0n ? `  price x minted ${a.priceSats * BigInt(a.minted)} sats` : "";
      console.log(`  sent to treasury address ${a.treasurySats} sats (gross, change included)${revenue}  rejected mints ${a.rejectedMints} (burned ${a.burnedSats} sats)`);
    }
    const s = idx.stats;
    console.log(
      `pool: ${idx.outputs.length} notes, ${idx.nullifiers.size} nullifiers; accepted deploy ${s.accepted.deploy}, mint ${s.accepted.mint}, ` +
        `transfer ${s.accepted.transact}, attest ${s.accepted.attest}${s.accepted.mine ? `, mining claims ${s.accepted.mine}` : ""}; rejected ${s.rejected}`,
    );
  },

  async log([n = "20"]) {
    const idx = await synced();
    for (const l of idx.log.slice(-Number(n))) {
      const what = [l.ticker, l.amount, l.kind !== undefined ? `kind ${l.kind} ${l.hash.slice(0, 16)}…` : null].filter(Boolean).join(" ");
      console.log(`#${l.seq} ${l.height} ${short(l.txid)} ${l.opName.padEnd(11)} ${l.ok ? "OK      " : "REJECTED"} ${what} ${l.reason ?? ""}`.trimEnd());
    }
  },

  async deploy([name, ...rest]) {
    // Strict: a mistyped flag (--prcie, --price=…, --ned) is refused, never left to default to 0.
    const f = parseStrictFlags(rest, { values: DEPLOY_FLAGS, usage: DEPLOY_USAGE });
    if (!name || name.startsWith("--") || !f.ticker || !f.amount || !f.cap) throw new Error(DEPLOY_USAGE);
    if (f.treasury !== undefined && f.price === undefined) {
      throw new Error(`--treasury goes with --price <sats>: without it the mint is free and the treasury receives nothing\n${DEPLOY_USAGE}`);
    }
    // Terms are permanent: check them before syncing, and refuse anything that would not round-trip.
    const treasury = typeof f.treasury === "string" ? scriptOf(f.treasury) : new Uint8Array();
    const priceSats = BigInt(whole(f, "price", "0"));
    if (priceSats > 0n && treasury.length && priceSats < dustLimit(treasury)) {
      throw new Error(`--price must be 0 or at least ${dustLimit(treasury)} sats: a smaller payment to this treasury is dust that nodes refuse to relay`);
    }
    const envelope = encodeDeploy({
      ticker: f.ticker.toUpperCase(),
      divisibility: Number(whole(f, "divisibility", "0")),
      mintAmount: BigInt(whole(f, "amount")),
      mintCap: Number(whole(f, "cap")),
      priceSats,
      treasury,
      startHeight: Number(whole(f, "start", "0")),
      endHeight: Number(whole(f, "end", "0")),
    });
    const idx = await synced();
    if (idx.tickers.has(f.ticker.toUpperCase())) throw new Error(`ticker ${f.ticker} is taken`);
    const { btcKey } = await openWallet(name, idx);
    await broadcast(await buildCarrierTx({ api, btcKey, envelope }), "DEPLOY");
  },

  async mint([name, ticker]) {
    const idx = await synced();
    const asset = assetByTicker(idx, ticker);
    // The indexer burns the price of a mint its terms refuse, so check before proving or paying.
    const closed = mintClosed(asset, idx.height + 1);
    if (closed) {
      const window = `${asset.startHeight || "any"}..${asset.endHeight || "open"}`;
      throw new Error(`${asset.ticker}: ${closed} for block ${idx.height + 1} (minted ${asset.minted}/${asset.mintCap}, window ${window}); nothing was broadcast`);
    }
    const { wallet, btcKey } = await openWallet(name, idx);
    // The envelope commits to the UTXO the carrier spends first (audit A-6).
    const bind = pickBindUtxo(await api.utxos(btcAccount(btcKey).address));
    console.log(`proving mint of ${asset.mintAmount} ${asset.ticker} (bound to ${bind.txid}:${bind.vout})…`);
    const envelope = await wallet.mint(idx, {
      asset: asset.id, mintAmount: asset.mintAmount, bindOutpoint: outpointOf(bind.txid, bind.vout),
    });
    const outputs = asset.priceSats > 0n ? [{ script: asset.treasury, amount: asset.priceSats }] : [];
    const dust = asset.priceSats > 0n ? dustLimit(asset.treasury) : 0n;
    if (asset.priceSats < dust) console.log(`price ${asset.priceSats} sats is below the dust limit; paying ${dust} sats to the treasury`);
    await broadcast(await buildCarrierTx({ api, btcKey, envelope, outputs, firstInput: bind }), "MINT");
  },

  /** Launches a mined token (DEPLOY_POW), paid from the BTC fee key; --dry-run broadcasts nothing. */
  async "deploy-pow"([name, ...rest]) {
    if (!name || name.startsWith("--")) throw new Error(DEPLOY_POW_USAGE);
    const lib = await loadMineLib();
    deployPowTerms(rest, { lib }); // flags and fee policy are refused before syncing
    const idx = await synced();
    const { btcKey } = await openWallet(name, idx);
    await deployPowCommand({ args: rest, idx, esplora: api, lib, btcKey });
  },

  /**
   * Mines a token with worker threads and pays each claim from the mining key (--pay key) or the
   * relay balance (--pay relay); --prepare-coins n splits the mining key's coins and exits.
   * Ctrl+C stops after the current slice; claims already sent stay locked (W-M).
   */
  async mine(args) {
    const f = parseMineArgs(args);
    const lib = await loadMineLib();
    const idx = await synced();
    const { wallet, file, save } = await openWallet(f.name, idx);
    const own = f.esplora ? new Esplora(f.esplora) : api;
    if (f.prepareCoins !== null) {
      const asset = assetByTicker(idx, f.ticker);
      if (asset.kind !== "pow") throw new Error(`${asset.ticker} is not a mined token`);
      await prepareCoinsCommand({ n: f.prepareCoins, asset, lib, mineKey: mineKeyOf(file, save), esplora: own, maxFeeRate: f.maxFeeRate });
      return;
    }
    let relay = null;
    if (f.relay) {
      relay = { client: relayClient(f.relay), url: f.relay };
      if (f.pay === "relay") {
        const rlib = await loadRelayLib();
        Object.assign(relay, { lib: rlib, account: relayAccountOf(file, rlib) });
      }
    }
    const mineKey = f.pay === "key" ? mineKeyOf(file, save) : null;
    const { createNodePowPool } = await import("../src/pow-pool.mjs");
    const pool = await createNodePowPool(f.threads ? { size: f.threads } : {});
    const ac = new AbortController();
    const onInt = () => ac.abort();
    process.on("SIGINT", onInt);
    try {
      let ready;
      try {
        ready = await pool.ready();
      } catch (e) {
        throw new Error(`${MINE_COPY.refused} (${e.message})`);
      }
      console.log(`Argon2id self-test passed: ${ready.impl}, ${ready.workers ?? pool.size} worker thread${(ready.workers ?? pool.size) === 1 ? "" : "s"}`);
      if (ready.impl === "noble") console.log(MINE_COPY.slow);
      const out = await runMiner({
        idx, wallet, file, save, name: f.name, ticker: f.ticker, lib, pool, esplora: own, resync: () => syncInPlace(idx), pay: f.pay,
        maxClaims: f.maxClaims ?? Infinity, maxFeeRate: f.maxFeeRate, mineKey, relay, linkable: f.linkable, signal: ac.signal, threads: ready.workers ?? pool.size,
      });
      process.exitCode = out.status === "error" ? 1 : 0;
    } finally {
      process.off("SIGINT", onInt);
      await pool.close();
    }
  },

  async send(args) {
    const f = parseRelayFlags(args);
    const [name, ticker, amount, to] = f.args;
    if (!to) throw new Error(SEND_USAGE);
    if (f.relay) {
      return relayed(f, name, async (ctx) => {
        const client = relayClient(f.url);
        return { client, ...(await relaySend({ ...ctx, name, client, mode: f.mode, url: f.url, ticker, amount, to, linkable: f.linkable })) };
      });
    }
    if (!/^\d+$/.test(String(amount)) || BigInt(amount) === 0n) throw new Error("amount must be a whole number above 0");
    const value = BigInt(amount);
    const recipient = decodeAddress(to);
    const idx = await synced();
    const asset = assetByTicker(idx, ticker);
    const { wallet, file, save, btcKey } = await openWallet(name, idx);
    wallet.selectNotes(asset.id, value); // fail fast before proving
    console.log(`proving transfer of ${value} ${asset.ticker}…`);
    const envelope = await wallet.transfer(idx, { asset: asset.id, amount: value, to: recipient });
    const tx = await buildCarrierTx({ api, btcKey, envelope });
    // W-1: the entry exists before the envelope leaves this machine. An explorer error after the
    // node took the carrier (a lost answer, a timeout, Ctrl+C) must not free these notes.
    const anchor = decodeEnvelope(envelope).anchor;
    file.pending.push({ txid: tx.txid, spends: envelope.spends, anchor });
    save();
    try {
      await broadcast(tx, "TRANSACT");
    } catch (e) {
      throw new Error(
        `${e.message}. The carrier ${tx.txid} may still have reached the network, so its notes stay reserved until it lands or block ${anchor + ANCHOR_WINDOW}; ` +
          `look it up before sending again: ${EXPLORER}/tx/${tx.txid}`,
      );
    }
  },

  /** Lists pending envelopes and the relay status of relayed ones. */
  async pending(args) {
    const f = parseRelayFlags(args);
    const [name] = f.args;
    if (!name || f.timing || !f.wait || f.waitMaxMs !== null) throw new Error(`usage: ${CLI} pending <wallet> [--relay url]`);
    const idx = await synced();
    const { file, save } = await openWallet(name, idx);
    // Each entry is looked up at its own relayer (MURKLE_RELAY_URL, else localhost, for an entry that names none).
    const urlFor = (url) => (f.urlGiven ? f.url : (url ?? f.url ?? String(env("RELAY_URL") || DEFAULT_RELAY).replace(/\/+$/, "")));
    const clients = new Map();
    const clientFor = (url) => {
      const u = urlFor(url);
      if (!clients.has(u)) clients.set(u, relayClient(u));
      return clients.get(u);
    };
    // A batch entry is not looked up before its release only while the relayer that holds it
    // carries relay balances: asked of that relayer, once per relayer.
    const opens = new Map();
    const open = (url) => {
      const u = urlFor(url);
      if (!opens.has(u)) opens.set(u, infoOrNull(clientFor(u)).then(relayOpenAt));
      return opens.get(u);
    };
    await listPending({ idx, file, clientFor, save, open });
  },

  /** Proves the newest failed relayed transfer again with the same notes (same nullifiers, never pays twice). */
  async retry(args) {
    const f = parseRelayFlags(args, { implied: true });
    const [name] = f.args;
    if (!name) throw new Error(`usage: ${CLI} retry <wallet> [--relay [url]] [--fast | --batch | --batch10] [--linkable] [--no-wait] [--wait-max <minutes>]`);
    // With --relay <url> the relayer is checked before anything else; otherwise relaySend checks the entry's own.
    return relayed(f, name, async (ctx) => {
      const urlOf = (p) => (f.urlGiven ? f.url : (p?.relay ?? f.url));
      // Open or not is asked of the relayer that holds each entry (once per relayer), not of f.url.
      const opens = new Map();
      const open = (url) => {
        const u = urlOf({ relay: url });
        if (!opens.has(u)) opens.set(u, infoOrNull(relayClient(u)).then(relayOpenAt));
        return opens.get(u);
      };
      const entry = await pickRetry({ file: ctx.file, height: ctx.idx.height, clientFor: (url) => relayClient(urlOf({ relay: url })), open });
      if (!entry) throw new Error(`no failed relayed transfer to retry in wallet "${name}" (see: ${CLI} pending ${name})`);
      // An entry saved by an older CLI may name a plain-http relayer elsewhere: refused as --relay would be.
      const url = checkRelayUrl(urlOf(entry), "the relayer this transfer was sent to (choose another with --relay https://…)");
      const mode = f.timing ?? savedMode(entry.mode) ?? "block"; // an older entry may say "batch12"
      console.log(`retrying ${entry.amount} ${entry.ticker} to ${entry.to} with the same notes (${MODE_NAME[mode]})`);
      const client = relayClient(url);
      return { client, ...(await relaySend({ ...ctx, name, client, mode, url, ticker: entry.ticker, amount: entry.amount, to: entry.to, entry, linkable: f.linkable })) };
    }, { checkUrl: f.urlGiven ? f.url : null });
  },

  /**
   * Relay balance (relay-balance-contract.md §6.1):
   *   relay account <w> [--relay url]            (alias: relay balance <w>)
   *   relay topup <w> [--relay url] [--pay <sats> [--fee-rate n] [--dry-run]]
   *   relay credit <w> [<txid:vout> [<n>]] [--older] [--relay url]
   * None of these needs the synced index. Exit codes: 0 ok, 1 error; relay credit also 4 and 6.
   */
  async relay(args) {
    const f = parseRelayCommand(args);
    const { file, save } = openWalletFile(walletPath(f.name), f.name);
    const client = relayClient(f.url);
    const lib = await loadRelayLib();
    const common = { name: f.name, file, client, url: f.url, lib, save };
    if (f.sub === "account") return void (await relayAccountCommand(common));
    if (f.sub === "topup") {
      const btcKey = file.btcKey ? Buffer.from(file.btcKey, "hex") : null;
      return void (await relayTopUpCommand({ ...common, esplora: api, btcKey, pay: f.pay, feeRate: f.feeRate, dryRun: f.dryRun }));
    }
    const { exit } = await relayCreditCommand({ ...common, esplora: api, outpoint: f.outpoint, n: f.n, older: f.older });
    process.exitCode = exit;
  },

  /**
   * Operator tools for the retired free relayer (README, "The old relayer's coins"):
   *   relayer retire-free --to <address> [--dry-run] [--fee-rate n]
   * sweeps every coin of the old relayer key to <address>, paid from that balance.
   * Refuses while a v1 carrier may still land; archives nothing.
   */
  async relayer([what, ...rest]) {
    if (what === "retire-free") {
      const { to, dryRun, feeRate } = parseRetireFlags(rest);
      const keyPath = env("RELAY_KEY_PATH") || join(DATA, "relayer.key");
      const statePath = env("RELAY_STATE_PATH") || join(DATA, "relayer.json");
      await retireFree({ key: readRelayerKey(keyPath), state: readV1File(statePath), esplora: api, to, dryRun, feeRate });
      return;
    }
    // Emergencies (docs/OPERATIONS.md 10.4, relay-balance.md §9): the paid relayer's own directory
    // (MURKLE_RELAY_DIR, as the server reads it), never data/ of another network.
    const f = parseRelayerArgs(what, rest);
    const ops = await import("../server/relay-evacuate.mjs");
    const { readConfig } = await import("../server/relayer.mjs");
    const { config, problems } = readConfig(env);
    if (problems.length) throw new Error(problems[0]);
    const common = { root: ROOT, config, esplora: api, print: (s) => console.log(s) };
    const waitMs = (f.waitSecs ?? ops.DEFAULT_WAIT_SECS) * 1000;
    const held = { waitMs, relayerStopped: f.relayerStopped };
    if (f.sub === "evacuate") await ops.runEvacuate({ ...common, ...held, to: f.to, feeRate: f.feeRate, dryRun: f.dryRun, bump: f.bump, cancel: f.cancel, highFee: f.highFee });
    else if (f.sub === "rotate") await ops.rotate({ ...common, acceptLost: f.acceptLost });
    else if (f.sub === "refund-pool") await ops.refundPool({ ...common, ...held, fromKey: f.from, outpoint: f.outpoint, amount: f.amount, feeRate: f.feeRate, dryRun: f.dryRun });
    else if (f.sub === "sweep-retired") await ops.sweepRetired({ ...common, ...held, feeRate: f.feeRate, dryRun: f.dryRun, bump: f.bump, acceptLost: f.acceptLost, highFee: f.highFee });
    else await ops.relayerStatus(common);
  },

  /**
   * Posts ATTEST kind 1 over the pinned manifest hash. After it confirms, the
   * operator pins its txid and block height in this network's pins file (the genesis rule).
   */
  async attest([what, name, ...rest]) {
    const usage = `usage: ${CLI} attest genesis <wallet> [--dry-run] [--force]`;
    if (what !== "genesis" || !name || name.startsWith("--")) throw new Error(usage);
    // Strict: --dryrun, --dry-run=1 or --dry_run is refused, never read as "broadcast".
    const f = parseStrictFlags(rest, { booleans: ["dry-run", "force"], usage });
    if (!MANIFEST_SHA256) throw new Error(NETWORK === "signet" ? "no manifest is pinned in src/pins.json; run npm run circuit:build first" : `no manifest is pinned in ${PINS_FILE}; finish the ceremony and run its finalize --install first (docs/MAINNET.md)`);
    if (GENESIS_TXID && !f.force) throw new Error(`genesis is already pinned (${GENESIS_TXID}); a second genesis needs --force and a re-genesis`);
    // The attested hash must describe the artifacts this checkout actually serves.
    if (sha256File(ARTIFACTS.manifest) !== MANIFEST_SHA256) throw new Error(`${ARTIFACT_PATHS.manifest} does not match manifestSha256 in ${PINS_FILE}`);
    for (const k of ["wasm", "zkey", "vkey"]) {
      if (sha256File(ARTIFACTS[k]) !== ARTIFACT_SHA256[k]) throw new Error(`${ARTIFACTS[k]} does not match its pinned hash`);
    }
    const btcKey = Buffer.from(readWalletFile(name).btcKey, "hex");
    const envelope = encodeAttest({ kind: ATTEST_KIND.GENESIS, hash: MANIFEST_SHA256 });
    const tx = await buildCarrierTx({ api, btcKey, envelope });
    if (f["dry-run"]) {
      console.log(`ATTEST genesis (not broadcast): ${tx.txid}  ${tx.vsize} vB, fee ${tx.fee} sats\n${tx.hex}`);
      return;
    }
    const txid = await broadcast(tx, "ATTEST genesis");
    console.log("\nNext, once it has confirmed:");
    console.log(`  1. set "genesisTxid": "${txid}" and "activationHeight": <its block height> in ${PINS_FILE}`);
    console.log("  2. restart the indexer; an old state.json is archived automatically");
  },

  /**
   * Replays from the activation height into memory (never touching any state
   * file) through any Esplora-compatible API, and optionally compares every
   * block's digest with another indexer. A replay that stops on an error says
   * the last block it applied.
   */
  async audit(args) {
    const f = parseFlags(args);
    const from = f.from !== undefined ? Number(f.from) : ACTIVATION_HEIGHT;
    if (from === null || !Number.isInteger(from)) throw new Error("pre-genesis: no activation height is pinned; pass --from <height>");
    // The genesis rule applies whenever the replay starts at the pinned activation height.
    const genesis = GENESIS && from === ACTIVATION_HEIGHT ? GENESIS : null;
    if (!genesis) warnPreGenesis();
    const source = f.esplora ? new Esplora(f.esplora) : api;
    const idx = new Indexer({ vkey: vkey(), startHeight: from, genesis });
    // A fresh header chain from the pinned checkpoint at or below `from` (never the CLI's file):
    // every replayed block's header is checked (A-9) when this build has src/btc/headers.mjs.
    const headers = await auditHeaderChain(from);
    const started = Date.now();
    let bytes = 0;
    console.log(`replaying from ${from} via ${source.base ?? cliChain?.describe?.() ?? "the chain source"}${genesis ? ` (genesis ${short(genesis.txid)})` : ""}${headers ? ", headers checked from the pinned checkpoint" : ""}`);
    let tip;
    try {
      tip = await syncIndexer(idx, source, {
        ...(headers ? { headers } : {}),
        to: f.to !== undefined ? Number(f.to) : undefined,
        onBlock: (h, t, info) => {
          bytes += info.bytes;
          process.stderr.write(`\rblock ${h}/${t}  ${(bytes / 2 ** 20).toFixed(1)} MiB  ${idx.log.length} envelopes`);
        },
      });
    } catch (e) {
      process.stderr.write("\n");
      const last = idx.height >= from ? `last block applied: ${idx.height}` : "no block applied";
      throw new Error(`replay stopped (${last}): ${e.message}`);
    }
    process.stderr.write("\n");
    const s = idx.stats;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`replayed ${idx.height - from + 1} blocks (${from}..${idx.height}, tip ${tip}) in ${secs} s`);
    console.log(`envelopes ${idx.log.length}: accepted ${idx.log.length - s.rejected}, rejected ${s.rejected}; notes ${idx.outputs.length}, nullifiers ${idx.nullifiers.size}`);
    console.log(`digest at ${idx.height}: ${idx.digestAt(idx.height) ?? "—"}`);
    if (!f.compare) return;

    const base = String(f.compare).replace(/\/+$/, "");
    const getJson = async (path) => {
      const res = await fetch(base + path);
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return res.json();
    };
    const remoteState = await getJson("/api/state");
    const to = Math.min(idx.height, remoteState.height);
    const res = await compareDigests(idx, (a, b) => getJson(`/api/digests?from=${a}&to=${b}`), { from, to });
    if (res.empty) {
      throw new Error(`nothing compared: no height from ${from} on is on both sides (local replay at ${idx.height}, remote at ${remoteState.height ?? "—"})`);
    }
    if (res.ok) {
      const n = res.upTo - from + 1;
      console.log(`OK up to ${res.upTo} (${n} height${n === 1 ? "" : "s"} compared)`);
      return;
    }
    console.log(`DIVERGES at block ${res.height}`);
    console.log(`  local  ${res.local ?? "—"}\n  remote ${res.remote ?? "—"}`);
    // A different release switches digest versions at another height: say so instead of pointing at a transaction.
    let remoteVersion = null;
    try {
      remoteVersion = (await getJson(`/api/digest?height=${res.height}`)).version ?? 1;
    } catch {
      remoteVersion = null;
    }
    const versionLine = digestVersionLine(idx, res.height, remoteVersion);
    console.log(`  ${versionLine ?? `component: ${await diagnose(idx, res.height, getJson)}`}`);
    process.exitCode = 2;
  },
};

/** True when this file is the script node was started with (not an import, e.g. from a test). */
function isEntryScript() {
  try {
    const norm = (p) => {
      const real = realpathSync.native(p);
      return process.platform === "win32" ? real.toLowerCase() : real;
    };
    return Boolean(process.argv[1]) && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryScript()) {
  const [cmd, ...args] = process.argv.slice(2);
  if (!Object.hasOwn(commands, cmd ?? "")) {
    console.log(HELP.join("\n"));
    process.exit(cmd ? 1 : 0);
  }
  try {
    const refused = commandRefusal(cmd, args);
    if (refused) throw new Error(refused);
    if (!OFFLINE_COMMANDS.has(cmd)) {
      cliChain = await openCliChainSource();
      api = cliChain.api;
    }
    await commands[cmd](args);
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exitCode = 1;
  } finally {
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  }
}

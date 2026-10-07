#!/usr/bin/env node
// Replays the chain from a state snapshot's start height with this checkout's code into a
// temporary state and compares the digest at every height with the snapshot's digests.
// Proof for docs/design/mainnet-readiness.md §7: the live signet chain replays to the same
// digests with and without header verification, and no signet DEPLOY / DEPLOY_POW depends on
// the strict ticker rule (V2-02).
//
//   node scripts/replay-compare.mjs --network signet --snapshot <copy of state.json> --out <temp dir>
//        [--headers on|off] [--to H] [--source esplora|bitcoind] [--cache <dir>] [--parallel N]
//
// Reads the snapshot, the pinned verification key and the chain source; writes only inside
// --out (the replayed state.json, headers.json and result.json) and the cache directory
// (default <out>/cache). The cache holds block hashes by height, raw blocks and raw
// transactions, each checked against its hash before it is stored or used, so a second run
// (e.g. --headers off after --headers on) reads the same chain without the network. Blocks are
// prefetched N at a time (default 3). Exit 0 only when every height through H is identical.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parseBlock, parseRawTx } from "../src/btc/block.mjs";
import { openChainSource } from "../src/btc/source.mjs";
import { syncIndexer } from "../src/sync.mjs";
import * as P from "../src/params.mjs";

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

const HEADER_LEN = 5; // magic (3) ‖ version ‖ op
const OP_DEPLOY = 2;
const OP_DEPLOY_POW = 9;
const strictOk = (raw) => raw.length >= 1 && raw.length <= 16 && raw.every((b) => (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a));

/**
 * Wraps a chain source so every raw block it serves is scanned for DEPLOY / DEPLOY_POW envelopes
 * whose raw ticker bytes fail the strict rule. Returns { api, v202 }.
 */
export function withTickerScan(api, { findEnvelope, decodeEnvelope }) {
  const v202 = { deploys: 0, strictFailures: [], legacyAccepted: 0 };
  const scan = (raw, hash) => {
    let block;
    try {
      block = parseBlock(raw);
    } catch {
      return; // the sync itself reports a bad block
    }
    for (const tx of block.txs) {
      const payload = findEnvelope(tx);
      if (!payload || payload.length <= HEADER_LEN) continue;
      const op = payload[HEADER_LEN - 1];
      if (op !== OP_DEPLOY && op !== OP_DEPLOY_POW) continue;
      v202.deploys += 1;
      const len = payload[HEADER_LEN];
      const ticker = payload.subarray(HEADER_LEN + 1, HEADER_LEN + 1 + len);
      if (ticker.length === len && strictOk(ticker)) continue;
      let legacy = false;
      try {
        decodeEnvelope(payload, { strictTicker: false });
        legacy = true;
      } catch {
        legacy = false;
      }
      if (legacy) v202.legacyAccepted += 1;
      v202.strictFailures.push({ block: hash, txid: tx.txid, op: op === OP_DEPLOY ? "DEPLOY" : "DEPLOY_POW", tickerHex: Buffer.from(ticker).toString("hex"), legacyAccepted: legacy });
    }
  };
  const wrapped = new Proxy(api, {
    get(target, key) {
      if (key === "rawBlock") {
        return async (hash) => {
          const raw = await target.rawBlock(hash);
          scan(raw, hash);
          return raw;
        };
      }
      const v = target[key];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { api: wrapped, v202 };
}

/**
 * A chain source whose block hashes (by height), raw blocks and raw transactions are kept in
 * `dir`. Raw blocks must hash to the requested hash and raw transactions to their txid, both
 * when fetched and when read back, so a cache file cannot change what is replayed.
 * prefetch(from, to, parallel) downloads blocks ahead.
 */
export function cachedSource(api, dir, { attempts = 6, retryMs = 2000 } = {}) {
  mkdirSync(dir, { recursive: true });
  // A body cut off mid-download ("terminated") or a reset is retried here; a 404 is not.
  const retry = async (fn) => {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= attempts || /: 404/.test(String(e?.message ?? ""))) throw e;
        await new Promise((r) => setTimeout(r, retryMs * i));
      }
    }
  };
  const file = (name) => join(dir, name);
  const readText = (name) => (existsSync(file(name)) ? readFileSync(file(name), "utf8").trim() : null);
  const blockHash = async (h) => {
    const hit = readText(`height-${h}.txt`);
    if (hit && /^[0-9a-f]{64}$/.test(hit)) return hit;
    const hash = String(await retry(() => api.blockHash(h))).trim();
    writeFileSync(file(`height-${h}.txt`), hash);
    return hash;
  };
  const rawBlock = async (hash) => {
    const name = file(`block-${hash}.bin`);
    if (existsSync(name)) {
      const raw = new Uint8Array(readFileSync(name));
      if (parseBlock(raw).hash === hash) return raw;
    }
    const raw = await retry(() => api.rawBlock(hash));
    if (parseBlock(raw).hash !== hash) throw new Error(`block ${hash}: the served bytes hash to something else`);
    writeFileSync(name, raw);
    return raw;
  };
  const txHex = async (txid) => {
    const hit = readText(`tx-${txid}.hex`);
    if (hit) {
      try {
        parseRawTx(hit, txid);
        return hit;
      } catch {
        // fetch again below
      }
    }
    const h = String(await retry(() => api.txHex(txid))).trim();
    parseRawTx(h, txid);
    writeFileSync(file(`tx-${txid}.hex`), h);
    return h;
  };
  const prevoutScript = async (outpoint) => {
    const txid = Buffer.from(outpoint.slice(0, 32)).reverse().toString("hex");
    const vout = Buffer.from(outpoint.slice(32, 36)).readUInt32LE(0);
    const out = parseRawTx(await txHex(txid), txid).outputs[vout];
    if (!out) throw new Error(`prevout ${txid}:${vout} not found`);
    return out.script;
  };
  const prefetch = async (from, to, parallel = 4, log = () => {}) => {
    let next = from;
    let done = 0;
    const worker = async () => {
      while (next <= to) {
        const h = next++;
        await rawBlock(await blockHash(h));
        if (++done % 50 === 0) log(`prefetched ${done} of ${to - from + 1} blocks`);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, parallel) }, worker));
  };
  const wrapped = new Proxy(api, {
    get(target, key) {
      if (key === "blockHash") return blockHash;
      if (key === "rawBlock") return rawBlock;
      if (key === "txHex") return txHex;
      if (key === "prevoutScript") return prevoutScript;
      if (key === "prefetch") return prefetch;
      const v = target[key];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return wrapped;
}

/**
 * Replays from snap.startHeight to `to` into a fresh Indexer and compares every digest.
 * Returns { ok, identicalThrough, firstDivergence, compared, v202, idx, headers }.
 */
export async function replayCompare({ snap, vkey, api, headers = null, to = snap.height, envelope, Indexer, log = () => {} }) {
  const want = new Map((snap.digests ?? []).map(([h, d]) => [Number(h), String(d)]));
  const idx = new Indexer({ vkey, startHeight: snap.startHeight, genesis: snap.genesis ?? null });
  const scanned = withTickerScan(api, envelope);
  let first = null;
  let compared = 0;
  let identicalThrough = snap.startHeight - 1;
  const STOP = Symbol("stop");
  try {
    while (idx.height < to) {
      const before = idx.height;
      await syncIndexer(idx, scanned.api, {
        to,
        headers,
        onBlock: (h) => {
          const mine = idx.digestAt(h);
          const theirs = want.get(h) ?? null;
          compared += 1;
          if (theirs === null || mine !== theirs) {
            first = { height: h, replayed: mine, snapshot: theirs };
            throw STOP;
          }
          identicalThrough = h;
          if (h % 100 === 0) log(`identical through #${h}`);
        },
      });
      if (idx.height === before) break; // the source's tip is below `to`
    }
  } catch (e) {
    if (e !== STOP) throw e;
  }
  return { ok: first === null && identicalThrough >= to, identicalThrough, firstDivergence: first, compared, v202: scanned.v202, idx, headers };
}

async function main() {
  const a = args(process.argv.slice(2));
  const network = String(a.network ?? P.NETWORK ?? "signet");
  if (network !== (P.NETWORK ?? "signet")) throw new Error(`this process runs for ${P.NETWORK ?? "signet"}; run it with MURKLE_NETWORK=${network}`);
  if (!a.snapshot || !a.out) throw new Error("usage: --network signet --snapshot <copy of state.json> --out <temp dir> [--headers on|off] [--to H] [--source esplora|bitcoind]");
  const out = resolve(String(a.out));
  const dataDir = resolve("data");
  const rel = relative(dataDir, out);
  if (!rel.startsWith("..") && !isAbsolute(rel)) throw new Error(`--out must not be inside ${dataDir} (live state lives there)`);
  const headersOn = String(a.headers ?? "on") !== "off";
  const snap = JSON.parse(readFileSync(resolve(String(a.snapshot)), "utf8"));
  const to = a.to !== undefined ? Number(a.to) : snap.height;
  if (!Number.isInteger(to) || to > snap.height || to < snap.startHeight) throw new Error(`--to must be between ${snap.startHeight} and the snapshot height ${snap.height}`);

  const { Indexer } = await import("../src/indexer.mjs");
  const { loadPinnedVkey } = await import("../src/store-node.mjs");
  const envelope = await import("../src/envelope.mjs");
  const vkeyPath = P.ARTIFACT_PATHS?.vkey ?? "build/dev/verification_key.json";
  if (!existsSync(vkeyPath)) throw new Error(`${vkeyPath} is missing: npm run artifacts:fetch`);
  const vkey = loadPinnedVkey(vkeyPath);
  const kind = a.source ? String(a.source) : null;
  const read = (name) => (name === "BTC_SOURCE" && kind ? kind : name === "HEADERS" ? (headersOn ? "on" : "off") : P.env?.(name));
  const src = await openChainSource({ network, read, startHeight: snap.startHeight, log: console });
  mkdirSync(out, { recursive: true });
  const cacheDir = resolve(String(a.cache ?? join(out, "cache")));
  const crel = relative(dataDir, cacheDir);
  if (!crel.startsWith("..") && !isAbsolute(crel)) throw new Error(`--cache must not be inside ${dataDir}`);
  const api = cachedSource(src.api, cacheDir);
  console.error(`replaying #${snap.startHeight}..#${to} from ${src.describe()} (cache ${cacheDir})`);
  const t0 = Date.now();
  await api.prefetch(snap.startHeight, to, Number(a.parallel ?? 3), (m) => console.error(m));
  const r = await replayCompare({ snap, vkey, api, headers: src.headers, to, envelope, Indexer, log: (m) => console.error(m) });

  const { saveIndexer } = await import("../src/store-node.mjs");
  saveIndexer(join(out, "state.json"), r.idx);
  if (r.headers) writeFileSync(join(out, "headers.json"), JSON.stringify(r.headers.snapshot()));
  const result = {
    network,
    headers: headersOn ? (r.headers?.status() ?? null) : "off",
    from: snap.startHeight,
    to,
    ok: r.ok,
    identicalThrough: r.identicalThrough,
    firstDivergence: r.firstDivergence,
    compared: r.compared,
    v202: { deploys: r.v202.deploys, strictFailures: r.v202.strictFailures.length, legacyAccepted: r.v202.legacyAccepted, items: r.v202.strictFailures },
    seconds: Math.round((Date.now() - t0) / 1000),
  };
  writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
  console.error(r.ok ? `identical through ${r.identicalThrough}` : r.firstDivergence ? `first divergence at #${r.firstDivergence.height}` : `stopped at #${r.identicalThrough} (source tip below --to?)`);
  if (!r.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Exit explicitly: the proof verifier (snarkjs' curve) keeps worker threads alive after the replay.
  main().then(
    () => process.exit(process.exitCode ?? 0),
    (e) => {
      console.error(`replay-compare: ${e.message}`);
      process.exit(2);
    },
  );
}

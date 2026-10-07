// Bitcoin Core JSON-RPC chain source (Node only): the same method surface as Esplora
// (src/btc/esplora.mjs), so an operator can index from their own node (audit A-9: no third
// party between the node and the indexer). Needs `txindex=1` (prevout lookups of arbitrary
// confirmed transactions), so the node cannot be pruned.
//
// Error contract (server/relayer.mjs broadcastRaw classifies by message text):
//   - a JSON-RPC error object from the node throws Error("RPC error <code>: <message>") with
//     err.rpcCode, and is never retried;
//   - getrawtransaction -5 (unknown transaction) also says "404 not found", so callers that test
//     for an unknown txid (verify-tx, the relayer's statusOf) work unchanged;
//   - transport failures (refused, timeout, no answer) never say "RPC error"; reads retry them
//     with backoff, sendrawtransaction never does (its outcome is unknown).
// Auth: Core's cookie file (preferred, re-read after a 401 since Core rewrites it on restart) or
// a user plus a password FILE. No password is read from an environment value, logged or echoed.
import { readFile } from "node:fs/promises";
import { hex, readU32le, unhex } from "../bytes.mjs";
import * as P from "../params.mjs";
import { parseRawTx } from "./block.mjs";
import { decodeHeader } from "./headers.mjs";

const TXID = /^[0-9a-f]{64}$/;
const checkTxid = (txid) => {
  const t = String(txid ?? "").toLowerCase();
  if (!TXID.test(t)) throw new Error(`bad txid ${txid}`);
  return t;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An error answered by the node itself (never retried). */
export class RpcError extends Error {
  constructor(code, message, method) {
    super(`RPC error ${code}: ${message}`);
    this.name = "RpcError";
    this.rpcCode = code;
    this.method = method;
  }
}

/** BTC/kvB (Core's estimatesmartfee) -> whole sat/vB, rounded up, at least 1. */
export function satPerVbyte(btcPerKvB) {
  const satsPerKvB = Math.round(Number(btcPerKvB) * 1e8);
  if (!Number.isFinite(satsPerKvB) || satsPerKvB <= 0) return null;
  return Math.max(1, Math.ceil(satsPerKvB / 1000));
}

const notAvailable = (method) => new Error(`bitcoind source: ${method} is not available; set MURKLE_ESPLORA for wallet lookups`);

export class Bitcoind {
  /**
   * url:          JSON-RPC endpoint, e.g. http://127.0.0.1:8332 (no credentials in it)
   * cookieFile:   path to Core's .cookie ("__cookie__:<secret>")
   * user, passwordFile: rpcauth user and a file holding its password
   * network:      "mainnet" | "signet": fee estimates fall back to 1 sat/vB only on signet
   * walletSource: optional Esplora for utxos() and merkleProof(), which Core cannot answer
   */
  constructor({ url, cookieFile = null, user = null, passwordFile = null, timeoutMs = 30_000, retries = 4, retryMs = 500, network = P.NETWORK ?? "signet", walletSource = null, fetch: fetchFn = null } = {}) {
    if (!url) throw new Error("bitcoind source: no RPC url");
    let u;
    try {
      u = new URL(url);
    } catch {
      throw new Error(`bitcoind source: ${String(url).replace(/\/\/[^@/]*@/, "//***@")} is not a URL`);
    }
    if (u.username || u.password) throw new Error("bitcoind source: put RPC credentials in a cookie file or a password file, not in the URL");
    if (!cookieFile && !(user && passwordFile)) throw new Error("bitcoind source: set MURKLE_BITCOIND_COOKIE (Core's .cookie) or MURKLE_BITCOIND_USER plus MURKLE_BITCOIND_PASSWORD_FILE");
    this.url = u.href.replace(/\/$/, "");
    this.base = this.url; // shown on receipts and logs (never carries credentials)
    this.cookieFile = cookieFile;
    this.user = user;
    this.passwordFile = passwordFile;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.retryMs = retryMs;
    this.network = network;
    this.walletSource = walletSource;
    this.fetch = fetchFn ?? ((...a) => globalThis.fetch(...a));
    this.prevouts = new Map();
    this._auth = null;
    this._id = 0;
  }

  async authHeader({ reload = false } = {}) {
    if (this._auth && !reload) return this._auth;
    let pair;
    if (this.cookieFile) {
      const text = (await readFile(this.cookieFile, "utf8").catch((e) => {
        throw new Error(`bitcoind source: cannot read the cookie file ${this.cookieFile} (${e.code ?? "error"})`);
      })).trim();
      if (!/^[^:\s]+:\S+$/.test(text)) throw new Error(`bitcoind source: the cookie file ${this.cookieFile} is not "user:secret"`);
      pair = text;
    } else {
      const pass = (await readFile(this.passwordFile, "utf8").catch((e) => {
        throw new Error(`bitcoind source: cannot read the password file ${this.passwordFile} (${e.code ?? "error"})`);
      })).replace(/\r?\n$/, "");
      if (!pass) throw new Error(`bitcoind source: the password file ${this.passwordFile} is empty`);
      pair = `${this.user}:${pass}`;
    }
    this._auth = `Basic ${Buffer.from(pair, "utf8").toString("base64")}`;
    return this._auth;
  }

  /** One HTTP exchange; returns the parsed JSON body. Transport errors carry `transport: true`. */
  async post(body, label, { reloaded = false } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: await this.authHeader() },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      const err = new Error(`bitcoind ${label}: ${ctrl.signal.aborted ? `no answer within ${this.timeoutMs} ms` : `connection failed (${e?.cause?.code ?? e?.message ?? e})`}`);
      err.transport = true;
      throw err;
    }
    let text;
    try {
      text = await res.text();
    } catch (e) {
      const err = new Error(`bitcoind ${label}: the answer was cut off (${e?.message ?? e})`);
      err.transport = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401 || res.status === 403) {
      if (this.cookieFile && !reloaded) {
        // Core writes a new cookie on every restart.
        await this.authHeader({ reload: true });
        return this.post(body, label, { reloaded: true });
      }
      throw new Error(`bitcoind ${label}: authentication failed (HTTP ${res.status}); check the cookie or password file`);
    }
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (json === null) {
      const err = new Error(`bitcoind ${label}: HTTP ${res.status} without a JSON-RPC answer`);
      err.transport = res.status >= 500 || res.status === 0;
      throw err;
    }
    return json;
  }

  /** One call. RPC errors throw RpcError at once; transport errors are retried when `retry`. */
  async rpc(method, params = [], { retry = true } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        const json = await this.post({ jsonrpc: "1.0", id: ++this._id, method, params }, method);
        if (json.error) throw new RpcError(json.error.code, json.error.message, method);
        if (!("result" in json)) throw new Error(`bitcoind ${method}: answer has no result`);
        return json.result;
      } catch (e) {
        if (!(e?.transport && retry && attempt < this.retries)) throw e;
        await sleep(this.retryMs * 2 ** attempt);
      }
    }
  }

  /**
   * Several calls in one request: [[method, params], ...] -> [{ result } | { error: RpcError }]
   * in the same order. Transport errors retry the whole batch (reads only).
   */
  async batch(calls, { retry = true } = {}) {
    if (!calls.length) return [];
    const ids = calls.map(() => ++this._id);
    for (let attempt = 0; ; attempt++) {
      try {
        const json = await this.post(calls.map(([method, params = []], i) => ({ jsonrpc: "1.0", id: ids[i], method, params })), `batch of ${calls.length}`);
        if (!Array.isArray(json)) {
          if (json?.error) throw new RpcError(json.error.code, json.error.message, "batch");
          throw new Error("bitcoind batch: the answer is not a list");
        }
        const byId = new Map(json.map((r) => [r?.id, r]));
        return ids.map((id, i) => {
          const r = byId.get(id);
          if (!r) return { error: new Error(`bitcoind batch: no answer for ${calls[i][0]}`) };
          if (r.error) return { error: new RpcError(r.error.code, r.error.message, calls[i][0]) };
          return { result: r.result };
        });
      } catch (e) {
        if (!(e?.transport && retry && attempt < this.retries)) throw e;
        await sleep(this.retryMs * 2 ** attempt);
      }
    }
  }

  /* ---------------------------------------------------------- chain surface */

  async tipHeight() {
    return Number(await this.rpc("getblockcount"));
  }

  async blockHash(height) {
    return String(await this.rpc("getblockhash", [height])).trim();
  }

  async rawBlock(hash) {
    return unhex(String(await this.rpc("getblock", [hash, 0])).trim());
  }

  async blockHeader(hash) {
    return String(await this.rpc("getblockheader", [hash, false])).trim();
  }

  /** `count` consecutive 80-byte headers from `fromHeight` (fewer at the tip), each checked to hash to its block hash. */
  async headers(fromHeight, count) {
    if (!Number.isInteger(fromHeight) || fromHeight < 0 || !Number.isInteger(count) || count < 0) throw new Error(`headers(${fromHeight}, ${count}): not a height range`);
    const hashes = [];
    const got = await this.batch(Array.from({ length: count }, (_, i) => ["getblockhash", [fromHeight + i]]));
    for (const r of got) {
      if (r.error) {
        if (r.error.rpcCode === -8) break; // Block height out of range: the tip
        throw r.error;
      }
      hashes.push(String(r.result));
    }
    const raw = await this.batch(hashes.map((h) => ["getblockheader", [h, false]]));
    return raw.map((r, i) => {
      if (r.error) throw r.error;
      const d = decodeHeader(String(r.result));
      if (d.hash !== hashes[i]) throw new Error(`bitcoind getblockheader ${hashes[i]}: the header hashes to ${d.hash}`);
      return d.bytes;
    });
  }

  /** Raw transaction hex as the node serves it; -5 (unknown) says "404 not found". */
  async txHex(txid) {
    const t = checkTxid(txid);
    try {
      return String(await this.rpc("getrawtransaction", [t, false])).trim();
    } catch (e) {
      throw notFoundOf(e, t);
    }
  }

  async rawTx(txid) {
    const bytes = unhex(await this.txHex(txid));
    parseRawTx(bytes, String(txid).toLowerCase());
    return bytes;
  }

  async prevoutScript(outpoint) {
    const key = hex(outpoint);
    if (!this.prevouts.has(key)) {
      const txid = hex(Uint8Array.from(outpoint.slice(0, 32)).reverse());
      const vout = readU32le(outpoint, 32);
      const out = parseRawTx(await this.txHex(txid), txid).outputs[vout];
      if (!out) throw new Error(`prevout ${txid}:${vout} not found`);
      this.prevouts.set(key, out.script);
    }
    return this.prevouts.get(key);
  }

  /** { confirmed, block_height?, block_hash?, block_time? } from a verbose getrawtransaction. */
  async statusFromVerbose(v) {
    if (v?.blockhash && Number(v.confirmations) > 0) {
      const head = await this.rpc("getblockheader", [v.blockhash, true]);
      return { confirmed: true, block_height: head.height, block_hash: v.blockhash, block_time: v.blocktime ?? head.time };
    }
    return { confirmed: false };
  }

  /** Esplora-like { txid, status }; throws "404 not found" for an unknown txid. */
  async tx(txid) {
    const t = checkTxid(txid);
    let v;
    try {
      v = await this.rpc("getrawtransaction", [t, true]);
    } catch (e) {
      throw notFoundOf(e, t);
    }
    return { txid: t, status: await this.statusFromVerbose(v) };
  }

  /** { confirmed: false } for an unknown txid, as Esplora answers. */
  async txStatus(txid) {
    const t = checkTxid(txid);
    let v;
    try {
      v = await this.rpc("getrawtransaction", [t, true]);
    } catch (e) {
      if (e?.rpcCode !== -5) throw e;
      // Without txindex an unconfirmed transaction is still in the mempool.
      try {
        await this.rpc("getmempoolentry", [t]);
      } catch {
        // unknown either way
      }
      return { confirmed: false };
    }
    return this.statusFromVerbose(v);
  }

  async estimate(target, mode) {
    let r = null;
    try {
      r = await this.rpc("estimatesmartfee", [target, mode]);
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      r = null;
    }
    const rate = r && r.feerate !== undefined ? satPerVbyte(r.feerate) : null;
    if (rate !== null) return rate;
    // A quiet test chain has no estimate: the minimum relay rate. Never guess on mainnet.
    if (this.network === "signet") return 1;
    throw new Error(`bitcoind estimatesmartfee ${target}: the node has no fee estimate yet${r?.errors?.length ? ` (${r.errors.join("; ")})` : ""}`);
  }

  /** Whole sat/vB for about three blocks (estimatesmartfee 3 ECONOMICAL). */
  feeRate() {
    return this.estimate(3, "ECONOMICAL");
  }

  /** Whole sat/vB for the next block (estimatesmartfee 2 CONSERVATIVE). */
  nextBlockFeeRate() {
    return this.estimate(2, "CONSERVATIVE");
  }

  /** sendrawtransaction; never retried (a timeout leaves the outcome unknown). Returns the txid. */
  async broadcast(txHex) {
    return String(await this.rpc("sendrawtransaction", [String(txHex).trim()], { retry: false })).trim();
  }

  async mempoolTxids() {
    const list = await this.rpc("getrawmempool", [false]);
    if (!Array.isArray(list)) throw new Error("bitcoind getrawmempool: not a list");
    return list.map((t) => checkTxid(t));
  }

  /** { chain, blocks, headers, ibd, txindex: { synced, best_block_height } | null }. */
  async chainInfo() {
    const info = await this.rpc("getblockchaininfo");
    let txindex = null;
    try {
      const idx = await this.rpc("getindexinfo", ["txindex"]);
      txindex = idx?.txindex ? { synced: Boolean(idx.txindex.synced), best_block_height: idx.txindex.best_block_height ?? null } : null;
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      txindex = null;
    }
    return { chain: info.chain, blocks: info.blocks, headers: info.headers ?? null, ibd: info.initialblockdownload ?? null, txindex };
  }

  async utxos(address) {
    if (this.walletSource) return this.walletSource.utxos(address);
    throw notAvailable("utxos");
  }

  async merkleProof(txid) {
    if (this.walletSource) return this.walletSource.merkleProof(txid);
    throw notAvailable("merkleProof");
  }
}

function notFoundOf(e, txid) {
  if (e?.rpcCode !== -5) return e;
  const err = new Error(`GET /tx/${txid}: 404 not found (RPC error -5: ${String(e.message).replace(/^RPC error -5: /, "")})`);
  err.rpcCode = -5;
  return err;
}

// Esplora-compatible REST client (mempool.space). Signet by default.
// Anything that feeds consensus (blocks, prevouts) is fetched as raw bytes and
// checked against its hash here, never taken from the JSON views.
import { hex, readU32le, unhex } from "../bytes.mjs";
import { ESPLORA_API, NETWORK } from "../params.mjs";
import { parseRawTx } from "./block.mjs";
import { decodeHeader, encodeHeader } from "./headers.mjs";

export const SIGNET_API = ESPLORA_API;
const TXID = /^[0-9a-f]{64}$/;
const checkTxid = (txid) => {
  if (!TXID.test(txid)) throw new Error(`bad txid ${txid}`);
  return txid;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The order in which /fee-estimates targets (blocks) stand in for mempool's halfHourFee.
const FEE_TARGETS = ["3", "4", "5", "6", "2", "1"];

/**
 * A network-level failure worth retrying: fetch rejects with a TypeError ("fetch failed"
 * in Node with an ECONNRESET/ETIMEDOUT cause, "Failed to fetch" in browsers). An abort is
 * the caller's decision and is never retried.
 */
const transientNetworkError = (e, init) => e instanceof TypeError && e?.name !== "AbortError" && !init?.signal?.aborted;

export class Esplora {
  /**
   * base:    API root, e.g. https://mempool.space/signet/api (a trailing slash is dropped).
   * retries: how often a read (GET) is retried after a network error or a 5xx answer.
   * retryMs: first backoff delay; it doubles on every retry.
   * network: the chain it serves (default: this build's). Only signet may fall back to the
   *          minimum relay rate when the backend has no fee estimate; elsewhere that throws.
   */
  constructor(base = SIGNET_API, { retries = 4, retryMs = 500, network = NETWORK ?? "signet" } = {}) {
    this.base = String(base).replace(/\/+$/, "");
    this.retries = retries;
    this.retryMs = retryMs;
    this.network = network;
    this.prevouts = new Map();
  }

  request(path, init) {
    return this.requestUrl(this.base + path, path, init);
  }

  /**
   * Fetches `url` and throws unless the answer is 2xx. A 429 is retried with backoff for
   * every method. A network error or a 5xx is retried only for reads: a POST (a broadcast)
   * may have reached the server, and its caller maps the first answer to an outcome.
   */
  async requestUrl(url, label, init, attempt = 0) {
    const method = init?.method ?? "GET";
    const idempotent = method === "GET" || method === "HEAD";
    const canRetry = idempotent && attempt < this.retries;
    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (!canRetry || !transientNetworkError(e, init)) throw e;
      await sleep(this.retryMs * 2 ** attempt);
      return this.requestUrl(url, label, init, attempt + 1);
    }
    if ((res.status === 429 && attempt < 5) || (res.status >= 500 && canRetry)) {
      await res.body?.cancel?.().catch(() => {});
      await sleep(res.status === 429 ? 1000 * 2 ** attempt : this.retryMs * 2 ** attempt);
      return this.requestUrl(url, label, init, attempt + 1);
    }
    if (!res.ok) throw new Error(`${method} ${label}: ${res.status} ${await res.text()}`);
    return res;
  }

  async tipHeight() {
    return Number(await (await this.request("/blocks/tip/height")).text());
  }

  async blockHash(height) {
    return (await (await this.request(`/block-height/${height}`)).text()).trim();
  }

  async rawBlock(hash) {
    return new Uint8Array(await (await this.request(`/block/${hash}/raw`)).arrayBuffer());
  }

  async blockTxids(hash) {
    return (await this.request(`/block/${hash}/txids`)).json();
  }

  async utxos(address) {
    return (await this.request(`/address/${address}/utxo`)).json();
  }

  /**
   * Whole sat/vB for a confirmation in about three blocks, at least 1. mempool.space's
   * /api/v1/fees/recommended (halfHourFee) first; any other Esplora/electrs serves only
   * /fee-estimates ({ target: sat/vB }), which mempool.space also serves. Fractional rates
   * round up, since the carrier builder needs a whole number. Throws when neither answers, and
   * off signet when the backend has no estimate yet (an empty map).
   */
  async feeRate() {
    if (/\/api$/.test(this.base)) {
      try {
        const fees = await (await this.requestUrl(this.base.replace(/\/api$/, "/api/v1") + "/fees/recommended", "/v1/fees/recommended")).json();
        const rate = Number(fees?.halfHourFee);
        if (Number.isFinite(rate) && rate >= 0) return Math.max(1, Math.ceil(rate));
      } catch {
        // Not a mempool.space instance, or the endpoint failed: try the plain Esplora one.
      }
    }
    const est = await (await this.request("/fee-estimates")).json();
    if (!est || typeof est !== "object" || Array.isArray(est)) throw new Error(`GET /fee-estimates: not a fee estimate map`);
    const target = FEE_TARGETS.find((t) => Number.isFinite(Number(est[t])) && Number(est[t]) >= 0);
    // An empty map means the backend has no estimate yet: on a quiet test chain the minimum
    // relay rate. Never guess on mainnet (a fresh electrs answers {}), as the bitcoind source.
    if (target === undefined) return this.noEstimate("/fee-estimates");
    return Math.max(1, Math.ceil(Number(est[target])));
  }

  async broadcast(hex) {
    return (await (await this.request("/tx", { method: "POST", body: hex })).text()).trim();
  }

  /**
   * GET /tx/<txid>/status. mempool.space and electrs answer 200 { confirmed: false } for a txid
   * they have never seen, never a 404: "not confirmed" here does not mean "in the mempool". Use
   * tx() (GET /tx/<txid>), which does answer 404, to learn whether the txid is known at all.
   */
  async txStatus(txid) {
    return (await this.request(`/tx/${txid}/status`)).json();
  }

  /** Explorer JSON view of a transaction. Display only: never feed it to consensus code. */
  async tx(txid) {
    return (await this.request(`/tx/${checkTxid(txid)}`)).json();
  }

  /** Raw transaction hex as served (unchecked; use rawTx for anything that matters). */
  async txHex(txid) {
    return (await (await this.request(`/tx/${checkTxid(txid)}/hex`)).text()).trim();
  }

  /** Raw transaction bytes, checked to hash to `txid`. */
  async rawTx(txid) {
    const bytes = unhex(await this.txHex(txid));
    parseRawTx(bytes, txid);
    return bytes;
  }

  /** Esplora merkle inclusion proof: { block_height, merkle: [hex…], pos }. */
  async merkleProof(txid) {
    return (await this.request(`/tx/${checkTxid(txid)}/merkle-proof`)).json();
  }

  /** 80-byte block header as hex. */
  async blockHeader(hash) {
    return (await (await this.request(`/block/${hash}/header`)).text()).trim();
  }

  /**
   * `count` consecutive 80-byte headers from `fromHeight`, ascending; fewer at the tip.
   * Built from GET /blocks/:start_height (up to 10 blocks per call, descending from
   * start_height; mempool.space serves the same path): every header is rebuilt from the JSON
   * fields and refused unless its double SHA-256 is the block's id, so the JSON view cannot
   * inject a header. The header chain (headers.mjs) then checks linkage and proof of work.
   */
  async headers(fromHeight, count) {
    if (!Number.isInteger(fromHeight) || fromHeight < 0 || !Number.isInteger(count) || count < 0) {
      throw new Error(`headers(${fromHeight}, ${count}): not a height range`);
    }
    const out = [];
    let pos = fromHeight;
    let tip = null;
    while (out.length < count) {
      const want = Math.min(10, count - out.length);
      let start = pos + want - 1;
      if (tip !== null) start = Math.min(start, tip);
      if (start < pos) break;
      let list;
      try {
        list = await (await this.request(`/blocks/${start}`)).json();
      } catch (e) {
        // Above the tip, Esplora answers 404: clamp to the tip once, then stop there.
        if (tip !== null || !/: 404\b/.test(String(e?.message ?? ""))) throw e;
        tip = await this.tipHeight();
        continue;
      }
      if (!Array.isArray(list)) throw new Error(`GET /blocks/${start}: not a block list`);
      const byHeight = new Map(list.map((b) => [b?.height, b]));
      let got = 0;
      for (let h = pos; h <= start; h++) {
        const b = byHeight.get(h);
        if (!b) break;
        let bytes;
        try {
          bytes = encodeHeader({ version: b.version, prevHash: b.previousblockhash ?? null, merkleRoot: b.merkle_root, time: b.timestamp, bits: b.bits, nonce: b.nonce });
        } catch (e) {
          throw new Error(`GET /blocks/${start}: block #${h} has malformed header fields (${e.message})`);
        }
        const hash = decodeHeader(bytes).hash;
        if (hash !== String(b.id).toLowerCase()) throw new Error(`GET /blocks/${start}: the fields of block #${h} hash to ${hash}, not to its id ${b.id}`);
        out.push(bytes);
        got += 1;
      }
      if (got === 0) break;
      pos += got;
      if (got < start - (pos - got) + 1) break; // the list ended early: the tip
    }
    return out;
  }

  /**
   * Whole sat/vB for the next block, at least 1: mempool.space's fastestFee, else the plain
   * Esplora /fee-estimates for 1 or 2 blocks. Throws when neither answers (and, off signet,
   * when the backend has no estimate).
   */
  async nextBlockFeeRate() {
    if (/\/api$/.test(this.base)) {
      try {
        const fees = await (await this.requestUrl(this.base.replace(/\/api$/, "/api/v1") + "/fees/recommended", "/v1/fees/recommended")).json();
        const rate = Number(fees?.fastestFee);
        if (Number.isFinite(rate) && rate >= 0) return Math.max(1, Math.ceil(rate));
      } catch {
        // Not a mempool.space instance: the plain Esplora endpoint below.
      }
    }
    const est = await (await this.request("/fee-estimates")).json();
    if (!est || typeof est !== "object" || Array.isArray(est)) throw new Error(`GET /fee-estimates: not a fee estimate map`);
    const target = ["1", "2"].find((t) => Number.isFinite(Number(est[t])) && Number(est[t]) >= 0);
    if (target === undefined) return this.noEstimate("/fee-estimates (1 or 2 blocks)");
    return Math.max(1, Math.ceil(Number(est[target])));
  }

  /** No fee estimate from the backend: 1 sat/vB on signet, a throw anywhere else. */
  noEstimate(what) {
    if (this.network === "signet") return 1;
    throw new Error(`GET ${what}: the backend has no fee estimate yet; refusing to guess a fee rate on ${this.network}`);
  }

  /** Txids in the source's mempool. */
  async mempoolTxids() {
    const list = await (await this.request("/mempool/txids")).json();
    if (!Array.isArray(list)) throw new Error("GET /mempool/txids: not a list");
    return list.map((t) => checkTxid(String(t).toLowerCase()));
  }

  /**
   * { chain, blocks, headers: null, ibd: null }. Esplora does not say which chain it serves:
   * `chain` is read from the base URL of the well-known explorers ("main", "signet", "test",
   * "testnet4"), else null.
   */
  async chainInfo() {
    const b = this.base.toLowerCase();
    let chain = null;
    if (/\/signet\/api$/.test(b)) chain = "signet";
    else if (/\/testnet4\/api$/.test(b)) chain = "testnet4";
    else if (/\/testnet\/api$/.test(b)) chain = "test";
    else if (/^https?:\/\/(mempool\.space|blockstream\.info)\/api$/.test(b)) chain = "main";
    return { chain, blocks: await this.tipHeight(), headers: null, ibd: null };
  }

  /**
   * scriptPubKey of the output a 36-byte serialized outpoint refers to. Read from
   * the raw transaction, whose bytes must hash to the outpoint's txid, so a data
   * source cannot substitute another script (audit A-9, MINT_SCRIPT). Cached:
   * a confirmed output never changes.
   */
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
}

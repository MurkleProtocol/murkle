// A fake payer for the browser mining E2E (scripts/e2e-gpu-mine.mjs) and its unit tests: the mining key's Esplora, with
// coins, a mempool, confirmations and Bitcoin Core's chain limit, and a router that decides for every request a page makes
// whether it is answered here ("fake"), may go to the signet Esplora for a read ("pass"), or must never be sent ("forbid").
// Nothing here opens a socket or broadcasts anything: a "POST /tx" is a call to broadcast() on this object.
import { FakeEsplora, txOf } from "./relay-harness.mjs";
import { scriptOf } from "../../src/btc/funding.mjs";

const SIGNET_API = "https://mempool.space/signet/api";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class FakeMinePayer extends FakeEsplora {
  /**
   * miningAddress  the wallet's mining-key address: its listing is the fake's
   * base           the build's signet Esplora base (ESPLORA_API); everything under it that is not faked is a read that may pass
   * limit          Bitcoin Core's unconfirmed ancestors / descendants per transaction (default 25; a test lowers it)
   */
  constructor({ miningAddress = null, base = SIGNET_API, limit = 25, fee = 1 } = {}) {
    super({ fee });
    this.miningAddress = miningAddress;
    this.base = base.replace(/\/+$/, "");
    this.limit = limit;
    this.limits = true;
    this.listings = 0; // GET .../utxo answered
    this.broadcasts = []; // [{ hex, txid, ok, error }] every POST /tx
    this.forbidden = []; // [url] requests the router refused
  }

  /** Coins of `values` sats to the mining address, confirmed at `height`. Returns the funding txid. */
  seed(values, { height = this.tip || 1, address = this.miningAddress } = {}) {
    const script = scriptOf(address);
    return this.pay(values.map((value) => ({ script, value })), { height });
  }

  /**
   * The mining address's coins as GET /address/<a>/utxo lists them: seeded coins and the change of accepted broadcasts, minus
   * spent ones, each with status.confirmed. -> [{ txid, vout, value, status: { confirmed, block_height? } }]
   */
  listing(address = this.miningAddress) {
    const script = hexOf(scriptOf(address));
    const out = [];
    for (const [key, coin] of this.coins) {
      if (hexOf(coin.script) !== script) continue;
      const [txid, vout] = key.split(":");
      const status = this.mined.has(txid) ? { confirmed: true, block_height: this.mined.get(txid) } : { confirmed: false };
      out.push({ txid, vout: Number(vout), value: coin.value, status });
    }
    return out;
  }

  /** The base class's chain check with this.limit instead of 25. */
  checkLimits(tx) {
    const anc = this.ancestors(tx);
    if (anc.size + 1 > this.limit) throw new Error(`sendrawtransaction RPC error: too-long-mempool-chain, too many unconfirmed ancestors [limit: ${this.limit}]`);
    const below = new Map();
    for (const id of this.mempool) for (const a of this.ancestors(txOf(this.txs.get(id)))) below.set(a, (below.get(a) ?? 0) + 1);
    for (const a of anc) if ((below.get(a) ?? 0) + 2 > this.limit) throw new Error(`sendrawtransaction RPC error: too-long-mempool-chain, too many descendants for tx ${a} [limit: ${this.limit}]`);
  }

  /** A new block at `height` takes every transaction in the mempool. Returns the txids. */
  confirmAll(height) {
    const ids = [...this.mempool];
    this.confirm(ids, height);
    return ids;
  }

  /**
   * Which of the three a request is. url: the full URL; method: "GET" | "POST" | ...
   *   "fake"    GET <base>/address/<miningAddress>/utxo, POST <base>/tx, and GET <base>/tx/<txid>[/status|/hex] of a txid this fake knows
   *   "pass"    this page's own origin (127.0.0.1, localhost), data: and blob: URLs, and every other read under <base>
   *   "forbid"  anything else: another host, or a mainnet path (mempool.space/api/... without /signet), or a write that is not POST <base>/tx
   */
  route(url, method = "GET") {
    let u;
    try {
      u = new URL(url);
    } catch {
      return "forbid";
    }
    if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return "pass";
    if (LOCAL_HOSTS.has(u.hostname)) return "pass";
    const b = new URL(this.base);
    const underBase = u.origin === b.origin && u.pathname.startsWith(`${b.pathname}/`);
    if (!underBase) return "forbid";
    const path = u.pathname.slice(b.pathname.length);
    const m = String(method).toUpperCase();
    if (m === "POST") return path === "/tx" ? "fake" : "forbid";
    if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") return "forbid";
    if (this.miningAddress && path === `/address/${this.miningAddress}/utxo`) return "fake";
    const tx = /^\/tx\/([0-9a-f]{64})(\/status|\/hex)?$/.exec(path);
    if (tx && this.txs.has(tx[1])) return "fake";
    return "pass";
  }

  /**
   * Answers a "fake" request: -> { status, contentType, body }. A refused broadcast is a 400 with the node's text, as Esplora
   * answers it (the page's esplora client then throws "POST /tx: 400 ...").
   */
  async answer(url, method = "GET", body = "") {
    const u = new URL(url);
    const path = u.pathname.slice(new URL(this.base).pathname.length);
    const json = (v) => ({ status: 200, contentType: "application/json", body: JSON.stringify(v) });
    const text = (v, status = 200) => ({ status, contentType: "text/plain", body: String(v) });
    if (String(method).toUpperCase() === "POST" && path === "/tx") {
      let txid = null;
      try {
        txid = await this.broadcast(String(body));
        this.broadcasts.push({ hex: String(body), txid, ok: true, error: null });
        return text(txid);
      } catch (e) {
        this.broadcasts.push({ hex: String(body), txid: safeTxid(body), ok: false, error: e.message });
        return text(e.message, 400);
      }
    }
    if (path === `/address/${this.miningAddress}/utxo`) {
      this.listings += 1;
      return json(this.listing());
    }
    const tx = /^\/tx\/([0-9a-f]{64})(\/status|\/hex)?$/.exec(path);
    if (tx) {
      const [, txid, tail] = tx;
      if (tail === "/status") return json(await this.txStatus(txid));
      if (tail === "/hex") return this.txs.has(txid) ? text(this.txs.get(txid)) : text("Transaction not found", 404);
      try {
        return json(await this.tx(txid));
      } catch (e) {
        return text("Transaction not found", 404);
      }
    }
    return text("not a fake route", 404);
  }
}

const hexOf = (b) => Buffer.from(b).toString("hex");
function safeTxid(hex) {
  try {
    return txOf(String(hex)).id;
  } catch {
    return null;
  }
}


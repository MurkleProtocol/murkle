/**
 * A polite mempool.space client for the public pages (Proof Wall): wraps an
 * Esplora instance (src/btc/esplora.mjs, which already backs off on HTTP 429) with a cache, so a
 * visitor who reloads the landing page doesn't refetch a dozen transactions.
 *
 * What is cached, and where:
 *   txHex(txid)           sessionStorage; the verifier re-hashes the bytes to the txid anyway
 *   blockHeader(hash)     sessionStorage; a header is named by its own hash
 *   merkleProof(txid)     sessionStorage once the transaction is confirmed (10 min), memory otherwise
 *   txStatus(txid)        confirmed: sessionStorage for 10 min; unconfirmed: memory for 15 s
 *   tx(txid)              display JSON (fee, payer), sessionStorage for 10 min
 *   tipHeight()           memory, 30 s
 * Everything lives in this tab only (sessionStorage), never in localStorage, and nothing is ever
 * sent anywhere but to mempool.space itself.
 *
 * API
 *   new CachedEsplora(inner, { storage, prefix, now })
 *     .base                the inner API base URL (shown in transcripts)
 *     .txHex .blockHeader .merkleProof .txStatus .tx .tipHeight   same contracts as Esplora
 *     .stats               { hits, misses }
 *   sessionStore()         sessionStorage, or null when it's unavailable
 */

const TTL = 10 * 60_000;

export function sessionStore() {
  try {
    const s = globalThis.sessionStorage;
    if (!s) return null;
    const k = "__murkle_probe__";
    s.setItem(k, "1");
    s.removeItem(k);
    return s;
  } catch {
    return null;
  }
}

export class CachedEsplora {
  constructor(inner, { storage = sessionStore(), prefix = "murkle.esplora.", now = () => Date.now() } = {}) {
    this.inner = inner;
    this.storage = storage;
    this.prefix = prefix;
    this.now = now;
    this.mem = new Map();
    this.inflight = new Map();
    this.stats = { hits: 0, misses: 0 };
  }

  get base() {
    return this.inner.base;
  }

  read(key) {
    const m = this.mem.get(key);
    if (m && (m.until === 0 || m.until > this.now())) return m;
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(this.prefix + key);
      if (!raw) return null;
      const v = JSON.parse(raw);
      if (v.until && v.until <= this.now()) {
        this.storage.removeItem(this.prefix + key);
        return null;
      }
      this.mem.set(key, v);
      return v;
    } catch {
      return null;
    }
  }

  write(key, value, { ttl = 0, persist = true } = {}) {
    const v = { value, until: ttl ? this.now() + ttl : 0 };
    this.mem.set(key, v);
    if (!persist || !this.storage) return;
    try {
      this.storage.setItem(this.prefix + key, JSON.stringify(v));
    } catch {
      // Quota or privacy mode: the memory copy still serves this page view.
    }
  }

  /** One request per key at a time; `store(value)` decides how long the answer may be reused. */
  async cached(key, fetch, store) {
    const hit = this.read(key);
    if (hit) {
      this.stats.hits += 1;
      return hit.value;
    }
    if (this.inflight.has(key)) return this.inflight.get(key);
    this.stats.misses += 1;
    const p = (async () => {
      const value = await fetch();
      const how = store(value);
      if (how) this.write(key, value, how);
      return value;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  txHex(txid) {
    return this.cached(`hex:${txid}`, () => this.inner.txHex(txid), () => ({}));
  }

  blockHeader(hash) {
    return this.cached(`hdr:${hash}`, () => this.inner.blockHeader(hash), () => ({}));
  }

  txStatus(txid) {
    return this.cached(`st:${txid}`, () => this.inner.txStatus(txid), (st) => (st?.confirmed ? { ttl: TTL } : { ttl: 15_000, persist: false }));
  }

  merkleProof(txid) {
    return this.cached(`mp:${txid}`, () => this.inner.merkleProof(txid), (p) => (Number.isInteger(p?.block_height) ? { ttl: TTL } : { ttl: 15_000, persist: false }));
  }

  tx(txid) {
    return this.cached(`tx:${txid}`, () => this.inner.tx(txid), (t) => (t?.status?.confirmed ? { ttl: TTL } : { ttl: 15_000, persist: false }));
  }

  tipHeight() {
    return this.cached("tip", () => this.inner.tipHeight(), () => ({ ttl: 30_000, persist: false }));
  }
}

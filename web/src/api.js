/**
 * Indexer API client (docs/API.md) plus a shared mempool.space client.
 * Bigints arrive as decimal strings and bytes as lowercase hex; values are passed through
 * unchanged (format them with ui/format.js).
 *
 * Privacy rule: there is deliberately no per-transaction lookup against our indexer. Per-tx
 * questions go to mempool.space (`esplora`) or are answered from bulk downloads that every
 * wallet makes anyway (outputs, commitments, nullifiers, log pages).
 *
 * API (every fetcher accepts a trailing { signal, fresh } options object)
 *   state()                         GET /api/state           (cached 3 s; fresh: true bypasses)
 *   outputs({ from, to })           GET /api/outputs
 *   commitments({ from, to })       GET /api/commitments      -> [[commitment, height]]
 *   nullifiers()                    GET /api/nullifiers       -> [decimal string]
 *   log({ from, limit })            GET /api/log              -> { items, next }
 *   roots({ from, to })             GET /api/roots            -> [[height, root]]
 *   digest(height)                  GET /api/digest?height=H
 *   digests({ from, to })           GET /api/digests          -> [[height, digest]]
 *   assets()                        GET /api/assets           (cached 15 s)
 *   asset(ticker)                   GET /api/assets/:ticker
 *   stats()                         GET /api/stats            (cached 10 s)
 *   mine()                          GET /api/mine             (cached 15 s) mined assets, every status
 *   mineAsset(idOrTicker)           GET /api/mine/:asset      one mined asset with tip, window and series
 *   blocks({ limit = 24 })          GET /api/blocks
 *   artifact(name, { as })          GET /artifacts/<name>; name in ARTIFACTS; as "json" | "bytes" | "text"
 *   manifest()                      GET /artifacts/manifest.json
 *   relay.info()                    GET  /api/relay/info
 *   relay.submit(body)              POST /api/relay/submit    -> 202 { id, status, ... } (signed body)
 *   relay.account(body)             POST /api/relay/account   -> { balance, reserved, nextIndex, ... } (signed body)
 *   relay.credit(body)              POST /api/relay/credit    -> { credited, already, amount, ... } (not signed)
 *   relay.status(id)                GET  /api/relay/status/:id
 *   relay.ledger({ limit, before }) GET  /api/relay/ledger
 *   esplora                         shared Esplora instance (src/btc/esplora.mjs) on this network's mempool.space
 *                                   (its broadcast refuses on a mainnet that has not launched)
 *   watchState(fn) -> unsubscribe   polls /api/state every 20 s while someone listens and the tab
 *                                   is visible; fn(state, error) runs immediately with the cached value
 *   refreshState()                  fetch now and notify watchers
 *   state() refuses (ApiError code "wrong_network") an indexer whose /api/state reports another
 *                                   network than this build's (no `network` field: signet), so
 *                                   nothing syncs, mints or sends against another network's pool
 *   useIndexer(url)                 setIndexerBase after reading <url>/api/state and checking its
 *                                   network (Settings > Indexer and /verify#indexer use it)
 *   indexerBase() / setIndexerBase(url)   "" = same origin (default). Stored under
 *                                   `${STORAGE_PREFIX}.indexer`; Settings > Indexer and the public
 *                                   switch on /verify#indexer use it.
 *   onIndexerChange(fn) -> unsubscribe   fn(base) after every setIndexerBase that changes the base:
 *                                   whoever kept data from the old indexer drops it
 *   class ApiError { status, code, retryAfter, bits, path, ... }  message follows
 *                                   "What happened. What to do." Every other field of the
 *                                   server's error object is kept too (epochStart, releaseAt,
 *                                   mode, epochBlocks on batch refusals; balance, needed,
 *                                   perSend on balance_low; confirmations, needed on
 *                                   deposit_unconfirmed; minDepositSats on deposit_small).
 */
import { Esplora } from "../../src/btc/esplora.mjs";
import { ESPLORA_API, MAINNET_NOT_LAUNCHED_TEXT, NETWORK, NOT_LAUNCHED, STORAGE_PREFIX } from "./config.js";
import { networkOfState, wrongNetworkText } from "./ui/indexer.js";

export const ARTIFACTS = ["transaction.wasm", "transaction.zkey", "verification_key.json", "manifest.json"];
export const INDEXER_KEY = `${STORAGE_PREFIX}.indexer`;
export const POLL_MS = 20_000;

// Never copied from the server's error object: they would shadow the Error itself.
const OWN = new Set(["message", "name", "stack", "cause", "status", "path"]);

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, retryAfter = null, bits = null, path = null, ...extra } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.bits = bits;
    this.path = path;
    for (const [k, v] of Object.entries(extra)) if (!OWN.has(k) && v !== undefined) this[k] = v;
  }
}

let base = "";
try {
  base = (typeof localStorage !== "undefined" && localStorage.getItem(INDEXER_KEY)) || "";
} catch {
  base = "";
}

export const indexerBase = () => base;

const indexerFns = new Set();
/** fn(base) runs after the indexer base changed. Returns an unsubscribe function. */
export function onIndexerChange(fn) {
  indexerFns.add(fn);
  return () => indexerFns.delete(fn);
}

export function setIndexerBase(url) {
  const v = String(url ?? "").trim().replace(/\/+$/, "");
  if (v && !/^https?:\/\/[^\s/]+/.test(v)) throw new ApiError("That isn't an indexer URL. Use a full address such as https://indexer.example.com.");
  const changed = v !== base;
  base = v;
  try {
    if (v) localStorage.setItem(INDEXER_KEY, v);
    else localStorage.removeItem(INDEXER_KEY);
  } catch {}
  cache.clear();
  stateCache = null;
  if (!changed) return;
  for (const fn of [...indexerFns]) {
    try {
      fn(v);
    } catch (e) {
      console.error(e);
    }
  }
}

/** Throws ApiError "wrong_network" unless an indexer's /api/state is for this build's network. */
export function checkStateNetwork(s) {
  const theirs = networkOfState(s);
  if (theirs !== NETWORK) throw new ApiError(wrongNetworkText(theirs), { code: "wrong_network", network: theirs });
  return s;
}

/** setIndexerBase(url), but only after <url>/api/state answers for this build's network. */
export async function useIndexer(url) {
  const v = String(url ?? "").trim().replace(/\/+$/, "");
  if (v) {
    if (!/^https?:\/\/[^\s/]+/.test(v)) throw new ApiError("That isn't an indexer URL. Use a full address such as https://indexer.example.com.");
    let s;
    try {
      const res = await fetch(`${v}/api/state`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      s = await res.json();
    } catch (e) {
      throw new ApiError(`Can't reach that indexer (${e.message}). Check the address, then try again.`);
    }
    checkStateNetwork(s);
  }
  setIndexerBase(v);
}

function qs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

function describe(status, path) {
  if (status === 404) return "Not found on the indexer. Check the value and try again.";
  if (status === 429) return "Too many requests to the indexer. Wait a minute, then try again.";
  if (status >= 500) return `The indexer returned an error (${status}). Try again in a minute.`;
  return `The indexer rejected the request (${status}). Reload the page and try again.`;
}

async function request(path, { method = "GET", body, signal, as = "json" } = {}) {
  const url = base + path;
  let res;
  try {
    res = await fetch(url, {
      method,
      signal,
      cache: "no-store",
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (e?.name === "AbortError") throw e;
    throw new ApiError("Can't reach the indexer. Check your connection, then try again.", { path });
  }
  if (!res.ok) {
    let err = null;
    try {
      err = (await res.json())?.error ?? null;
    } catch {}
    // Keeps the error's extra fields (batch refusals carry epochStart, releaseAt, ...).
    throw new ApiError(err?.message ?? describe(res.status, path), {
      ...(err && typeof err === "object" ? err : {}),
      status: res.status,
      code: err?.code ?? null,
      retryAfter: err?.retryAfter ?? null,
      bits: err?.bits ?? null,
      path,
    });
  }
  if (as === "bytes") return new Uint8Array(await res.arrayBuffer());
  if (as === "text") return res.text();
  return res.json();
}

const cache = new Map();
const inflight = new Map();

function cached(key, ttl, fn, { fresh = false } = {}) {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.t < ttl) return Promise.resolve(hit.v);
  if (!fresh && inflight.has(key)) return inflight.get(key);
  const p = fn()
    .then((v) => {
      cache.set(key, { t: Date.now(), v });
      return v;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

let stateCache = null;

export function state({ signal, fresh = false } = {}) {
  return cached("state", 3000, () => request("/api/state", { signal }).then(checkStateNetwork), { fresh }).then((s) => (stateCache = s));
}
export const outputs = ({ from, to } = {}, { signal } = {}) => request(`/api/outputs${qs({ from, to })}`, { signal });
export const commitments = ({ from, to } = {}, { signal } = {}) => request(`/api/commitments${qs({ from, to })}`, { signal });
export const nullifiers = ({ signal } = {}) => request("/api/nullifiers", { signal });
export const log = ({ from, limit } = {}, { signal } = {}) => request(`/api/log${qs({ from, limit })}`, { signal });
export const roots = ({ from, to } = {}, { signal } = {}) => request(`/api/roots${qs({ from, to })}`, { signal });
export const digest = (height, { signal } = {}) => request(`/api/digest${qs({ height })}`, { signal });
export const digests = ({ from, to } = {}, { signal } = {}) => request(`/api/digests${qs({ from, to })}`, { signal });
export const assets = ({ signal, fresh = false } = {}) => cached("assets", 15000, () => request("/api/assets", { signal }), { fresh });
export const asset = (ticker, { signal } = {}) => request(`/api/assets/${encodeURIComponent(String(ticker).toUpperCase())}`, { signal });
export const stats = ({ signal, fresh = false } = {}) => cached("stats", 10000, () => request("/api/stats", { signal }), { fresh });
export const mine = ({ signal, fresh = false } = {}) => cached("mine", 15000, () => request("/api/mine", { signal }), { fresh });
export const mineAsset = (idOrTicker, { signal } = {}) => request(`/api/mine/${encodeURIComponent(String(idOrTicker).toUpperCase())}`, { signal });
export const blocks = ({ limit = 24 } = {}, { signal } = {}) => request(`/api/blocks${qs({ limit })}`, { signal });

export function artifact(name, { as = null, signal } = {}) {
  if (!ARTIFACTS.includes(name)) throw new ApiError(`Unknown artifact ${name}.`);
  const kind = as ?? (name.endsWith(".json") ? "json" : "bytes");
  return request(`/artifacts/${name}`, { signal, as: kind });
}
export const manifest = ({ signal } = {}) => artifact("manifest.json", { signal });

export const relay = {
  info: ({ signal } = {}) => request("/api/relay/info", { signal }),
  submit: (body, { signal } = {}) => request("/api/relay/submit", { method: "POST", body, signal }),
  account: (body, { signal } = {}) => request("/api/relay/account", { method: "POST", body, signal }),
  credit: (body, { signal } = {}) => request("/api/relay/credit", { method: "POST", body, signal }),
  status: (id, { signal } = {}) => request(`/api/relay/status/${encodeURIComponent(id)}`, { signal }),
  ledger: ({ limit, before } = {}, { signal } = {}) => request(`/api/relay/ledger${qs({ limit, before })}`, { signal }),
};

/** Direct mempool.space reads (independent of us). */
export const esplora = new Esplora(ESPLORA_API);
if (NOT_LAUNCHED) {
  esplora.broadcast = async () => {
    throw new Error(MAINNET_NOT_LAUNCHED_TEXT);
  };
}

/* ---------- state polling ---------- */

const watchers = new Set();
let timer = null;
let lastError = null;

async function poll() {
  try {
    const s = await state({ fresh: true });
    lastError = null;
    for (const fn of [...watchers]) fn(s, null);
  } catch (e) {
    lastError = e;
    for (const fn of [...watchers]) fn(stateCache, e);
  }
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (watchers.size && typeof document !== "undefined" && !document.hidden) timer = setInterval(poll, POLL_MS);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && watchers.size) poll();
    schedule();
  });
}

export function watchState(fn) {
  watchers.add(fn);
  if (stateCache) fn(stateCache, lastError);
  if (watchers.size === 1) poll();
  schedule();
  return () => {
    watchers.delete(fn);
    schedule();
  };
}

export const refreshState = () => poll();

export const api = {
  state, outputs, commitments, nullifiers, log, roots, digest, digests, assets, asset, stats, blocks, mine, mineAsset,
  artifact, manifest, relay, esplora, watchState, refreshState, indexerBase, setIndexerBase, useIndexer,
};

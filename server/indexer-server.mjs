// Murkle indexer HTTP service (MURKLE_NETWORK, signet by default): public pool data, the
// relay endpoints and the built web app, all from one origin.
//
// Network (mainnet-readiness.md §4.5): artifacts, pins and the state path follow the network.
// On mainnet the server refuses to start before genesis (MURKLE_ALLOW_PRE_GENESIS=1 for a
// staging run), with an unpinned verification key, with a mining height and an incomplete
// MINE_FEE rule, and without header verification. Chain data comes from openChainSource
// (Esplora or the operator's Bitcoin Core); GET /api/health reports lag, errors and the relayer.
//
// Relaying (docs/design/relay-balance.md): the free relayer is retired. The paid
// relayer (relay balances: users prepay, the operator never pays a user's fee)
// starts only with MURKLE_RELAYER=1, MURKLE_RELAY_MODE=balance and a valid
// configuration, from its own new keys (startPaidRelayer). Otherwise the relay
// endpoints answer "not available". Old v1 relay ids answer "dropped", from the
// v1 relayer.json read once; startup cuts that file down once (pruneV1File) when it
// still holds envelopes, nullifiers or charges, and nothing else ever writes it.
//
// Mining (docs/design/mining.md, mining-contract.md §9.7): mined tokens are served by
// /api/mine and /api/mine/:asset (/api/assets keeps paid-mint tokens), and every Argon2
// evaluation runs in a worker_threads pool (idx.pow), never on this event loop.
//
// The chain is synced in the background. Readers get an immutable view that
// is republished only between ticks, so nobody sees half a block and a wallet
// can check the tree root it rebuilds against `root`.
//
// Privacy rule: there are no per-transaction lookups. Asking the indexer
// about one txid or nullifier would tell it which transactions are yours, so
// every endpoint serves bulk data that every wallet downloads anyway.
import http from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
import { Esplora } from "../src/btc/esplora.mjs";
import { addressOf } from "../src/btc/funding.mjs";
import { syncIndexer } from "../src/sync.mjs";
import { loadIndexer, loadPinnedVkey, saveIndexer } from "../src/store-node.mjs";
import { hex } from "../src/bytes.mjs";
import { ANCHOR_WINDOW } from "../src/indexer.mjs";
import {
  difficultyAt, difficultySeries, hashrateEstimate, lowFloor, mineStatus, nextHalving, requiredFeeOutputs, rewardAt, targetHex,
} from "../src/mine.mjs";
import { createNodePowPool } from "../src/pow-pool.mjs";
import {
  ARTIFACT_PATHS, ARTIFACT_SHA256, BRAND, IS_TESTNET, MANIFEST_SHA256, MINE_WINDOW, MINING_HEIGHT, NETWORK, PINS_FILE, PRE_GENESIS,
  PROTOCOL, STALE_FACTOR, env, mineFeeReady,
} from "../src/params.mjs";
import { Mutex, RelayError, clientIp, relayerStartup, startPaidRelayer, writeDurable } from "./relayer.mjs";
import { SUBMIT_MESSAGE, loadV1State, pruneV1State, relayInfoOff, v1NeedsPrune, v1Status } from "./retired-relay.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// This network's artifacts (signet: build/dev/* and build/manifest.json, unchanged; mainnet:
// build/mainnet/*, the ceremony output). The wasm is shared: same circuit.
export const ARTIFACTS = Object.freeze({
  "transaction.wasm": join(ROOT, ARTIFACT_PATHS.wasm),
  "transaction.zkey": join(ROOT, ARTIFACT_PATHS.zkey),
  "verification_key.json": join(ROOT, ARTIFACT_PATHS.vkey),
  "manifest.json": join(ROOT, ARTIFACT_PATHS.manifest),
});
const PIN_OF = { "transaction.wasm": "wasm", "transaction.zkey": "zkey", "verification_key.json": "vkey" };
export const WEB_DIST = join(ROOT, "web", "dist");
const DEFAULT_STATE = join(ROOT, "data", NETWORK, "state.json");
const DEFAULT_HEADERS = join(ROOT, "data", NETWORK, "headers.json");
const SYNC_MS = 20_000;
const HEALTH_MAX_SYNC_AGE_SECS = 600;
/** The web build marker (web/vite.config.mjs writes it): { network, manifestSha256, genesisTxid }. */
export const BUILD_MARKER = "murkle-build.json";
const TICKER = /^[A-Z0-9]{1,16}$/;
const MAX_LOG_PAGE = 500;
const MAX_RANGE = 2000;

// visual.md §11. Shipped Report-Only until snarkjs and Unisat are confirmed in
// every browser; MURKLE_CSP_ENFORCE=1 switches to enforcing.
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "connect-src 'self' https://mempool.space",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
// No page is frameable (audit V2-10). The SPA has no embed view yet, so a framable path
// would serve the whole wallet shell, whose client-side navigation reaches /app without a new
// document (and so without these headers). The planned /embed/t/:TICKER widget (visual.md §11)
// may relax framing for that exact route only, once its view exists and refuses to mount the app.

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

const BASE_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Base units -> decimal string with `divisibility` places, trailing zeros trimmed. */
export function formatUnits(units, divisibility) {
  const v = BigInt(units);
  if (!divisibility) return v.toString();
  const s = v.toString().padStart(divisibility + 1, "0");
  const frac = s.slice(-divisibility).replace(/0+$/, "");
  return s.slice(0, -divisibility) + (frac ? `.${frac}` : "");
}

/** sha256 of each served artifact against src/pins.json (and the manifest against manifestSha256). */
export function checkArtifacts(artifacts = ARTIFACTS) {
  const mismatched = [];
  const missing = [];
  for (const [name, path] of Object.entries(artifacts)) {
    if (!existsSync(path)) {
      missing.push(name);
      continue;
    }
    const pinned = name === "manifest.json" ? MANIFEST_SHA256 : ARTIFACT_SHA256[PIN_OF[name]];
    if (!pinned) continue;
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== pinned) mismatched.push(name);
  }
  return { ok: !mismatched.length && !missing.length, mismatched, missing };
}

/**
 * Which network the built web app in `webDist` is for (its murkle-build.json). A dist without the
 * marker is a build from before networks existed, so signet. { ok, network, message }: ok is false
 * when it was built for another network than `network` (or the marker cannot be read).
 */
export function checkWebBuild(webDist, network = NETWORK) {
  const file = join(webDist, BUILD_MARKER);
  if (!existsSync(file)) {
    return network === "signet"
      ? { ok: true, network: "signet", message: null }
      : { ok: false, network: "signet", message: `The web app in ${webDist} has no ${BUILD_MARKER}, so it was built for signet; this indexer runs on ${network}. Rebuild it with MURKLE_NETWORK=${network}.` };
  }
  let built = null;
  try {
    built = JSON.parse(readFileSync(file, "utf8"))?.network ?? null;
  } catch {
    built = null;
  }
  if (built === network) return { ok: true, network: built, message: null };
  return {
    ok: false,
    network: built,
    message: built
      ? `The web app was built for ${built}; this indexer runs on ${network}. Rebuild it with MURKLE_NETWORK=${network}.`
      : `The web app's ${BUILD_MARKER} cannot be read; rebuild it with MURKLE_NETWORK=${network}.`,
  };
}

/**
 * Why the server must not start on this network, or null (mainnet-readiness.md D13). Signet keeps
 * today's behaviour (pre-genesis runs, with a warning). Mainnet refuses before genesis unless
 * MURKLE_ALLOW_PRE_GENESIS=1 (staging), always refuses an unpinned verification key, and refuses
 * a pinned mining height while the MINE_FEE rule is incomplete.
 */
export function startRefusal({
  network = NETWORK, test = IS_TESTNET, preGenesis = PRE_GENESIS, vkeyPinned = Boolean(ARTIFACT_SHA256.vkey),
  miningHeight = MINING_HEIGHT, mineFeeReason = mineFeeReady(), allowPreGenesis = env("ALLOW_PRE_GENESIS") === "1",
} = {}) {
  if (miningHeight != null && mineFeeReason) return `${mineFeeReason}, but ${PINS_FILE} pins a mining height (${miningHeight}). See docs/MAINNET.md G5.`;
  if (test) return null;
  if (!vkeyPinned) return `${network} artifacts are not pinned yet (${PINS_FILE} has no vkey): run the ceremony, see docs/MAINNET.md.`;
  if (preGenesis && !allowPreGenesis) {
    return `${BRAND} has not launched on ${network}: no genesis is pinned in ${PINS_FILE}. Set MURKLE_ALLOW_PRE_GENESIS=1 only for a staging run (docs/MAINNET.md).`;
  }
  return null;
}

/**
 * Why the paid relayer must not start (null: it may). Before genesis on a network that is not a
 * test network there is no pool to carry transfers and relay balances cannot be withdrawn, so a
 * staging run (MURKLE_ALLOW_PRE_GENESIS=1) never credits real deposits unless the operator also
 * sets MURKLE_ALLOW_PRE_GENESIS_RELAYER=1 for a deliberate test with their own coins.
 */
export function relayerRefusal({ network = NETWORK, test = IS_TESTNET, preGenesis = PRE_GENESIS, allowRelayer = env("ALLOW_PRE_GENESIS_RELAYER") === "1" } = {}) {
  if (test || !preGenesis || allowRelayer) return null;
  return `relayer off: ${BRAND} has not launched on ${network} (no genesis in ${PINS_FILE}), so deposits could neither pay for a transfer nor be withdrawn.`;
}

/**
 * Whether the CSP is enforced: MURKLE_CSP_ENFORCE=1 or 0 when set, else enforced everywhere but
 * on a test network (the wallet holds keys in the browser; mainnet go/no-go).
 */
export function cspEnforced({ read = env, test = IS_TESTNET } = {}) {
  const v = read("CSP_ENFORCE");
  if (v !== undefined && v !== "") return v === "1";
  return !test;
}

/**
 * The chain source (hook H1): src/btc/source.mjs openChainSource when it exists, else (on a test
 * network only) today's Esplora client without header verification. Mainnet never runs without
 * header verification, so a missing source module refuses there.
 * -> { kind, api, headers, save(), describe() }
 */
export async function openServerChainSource({
  network = NETWORK, test = IS_TESTNET, read = env, headersPath = DEFAULT_HEADERS, log = console,
  sourceModule = join(ROOT, "src", "btc", "source.mjs"),
} = {}) {
  if (existsSync(sourceModule)) {
    const mod = await import(pathToFileURL(sourceModule).href);
    if (typeof mod.openChainSource === "function") return mod.openChainSource({ network, read, headersPath, log });
  }
  if (!test) throw new Error(`header verification is required on ${network}, and this build has no chain source module (src/btc/source.mjs)`);
  const base = read("ESPLORA") || undefined;
  const api = new Esplora(base);
  return { kind: "esplora", api, headers: null, save() {}, describe: () => `esplora ${api.base ?? base ?? "default"} (headers not verified: this build has no src/btc/source.mjs)` };
}

function assetStatus(a, nextHeight) {
  if (a.minted >= a.mintCap) return "sold-out";
  if (nextHeight < a.startHeight) return "upcoming";
  if (a.endHeight !== 0 && nextHeight > a.endHeight) return "ended";
  return "live";
}

const sumSince = (series, from) => series.reduce((s, [h, n]) => (h >= from ? s + n : s), 0);

/** Public JSON for one asset: deploy terms, supply and launch stats. */
function assetView(a, height) {
  let treasuryAddress = null;
  try {
    treasuryAddress = a.treasury.length ? addressOf(a.treasury) : null;
  } catch {
    treasuryAddress = null;
  }
  return {
    id: a.id.toString(),
    ticker: a.ticker,
    divisibility: a.divisibility,
    mintAmount: a.mintAmount.toString(),
    mintCap: a.mintCap,
    minted: a.minted,
    supply: a.pool.toString(),
    maxSupply: (a.mintAmount * BigInt(a.mintCap)).toString(),
    priceSats: a.priceSats.toString(),
    treasury: hex(a.treasury),
    treasuryAddress,
    startHeight: a.startHeight,
    endHeight: a.endHeight,
    status: assetStatus(a, height + 1),
    deployTxid: a.deployTxid,
    deployHeight: a.deployHeight,
    bodyHash: a.bodyHash,
    firstMintHeight: a.firstMintHeight,
    soldOutHeight: a.soldOutHeight,
    treasurySats: a.treasurySats.toString(),
    rejectedMints: a.rejectedMints,
    burnedSats: a.burnedSats.toString(),
    mints144: sumSince(a.mintsByHeight, height - 143),
  };
}

const addressOrNull = (script) => {
  try {
    return script.length ? addressOf(script) : null;
  } catch {
    return null;
  }
};
const isClaimEntry = (e) => e.ok && (e.opName === "MINE" || e.opName === "MINE_SCRIPT");
const SERIES_BLOCKS = 144;

/**
 * Public JSON for one mined asset (kind "pow"; mining-contract.md §9.7 MinedView) at indexer
 * height `height`: terms, supply, difficulty and fee outputs. Bigints are decimal strings.
 * `claims` are this asset's accepted claim log entries (the hashrate estimate, the flags).
 * `recipientDiscount`: the service-fee recipient's own claims cost it that fee less.
 */
function minedView(a, height, claims, mineFee) {
  const difficulty = difficultyAt(a, height);
  const hashrate = hashrateEstimate(claims, height);
  const feeOutputs = requiredFeeOutputs(a, mineFee).map((o) => ({ script: hex(o.script), address: addressOrNull(o.script), sats: o.sats.toString(), role: o.role }));
  return {
    asset: a.id.toString(),
    kind: "pow",
    ticker: a.ticker,
    divisibility: a.divisibility,
    status: mineStatus(a, height),
    deployTxid: a.deployTxid,
    deployHeight: a.deployHeight,
    bodyHash: a.bodyHash,
    mineStart: a.mineStart,
    startHeight: a.startHeight,
    endHeight: a.endHeight,
    span: a.span,
    targetPerSpan: a.targetPerSpan,
    reward: rewardAt(a, height).toString(),
    baseReward: a.reward.toString(),
    halvingInterval: a.halvingInterval,
    nextHalving: nextHalving(a, height),
    difficulty: difficulty.toString(),
    staleFloor: (difficulty / BigInt(STALE_FACTOR)).toString(),
    target: targetHex(difficulty),
    initialDifficulty: a.initialDifficulty.toString(),
    minDifficulty: a.minDifficulty.toString(),
    issued: a.issued.toString(),
    maxSupply: a.maxSupply.toString(),
    claims: a.claims,
    rejectedClaims: a.rejectedClaims,
    feeSats: a.feeSats.toString(),
    burnedFeeSats: a.burnedFeeSats.toString(),
    claimFeeSats: a.claimFeeSats.toString(),
    treasury: hex(a.treasury),
    treasuryAddress: addressOrNull(a.treasury),
    feeOutputs,
    firstClaimHeight: a.firstClaimHeight,
    claims144: sumSince(a.claimsByHeight ?? [], height - SERIES_BLOCKS + 1),
    flags: { lowFloor: lowFloor(a, hashrate), recipientDiscount: feeOutputs.length > 0 },
  };
}

/**
 * The extra fields of GET /api/mine/:asset: window, stale factor, the hashrate estimate and the
 * last 144 blocks of the difficulty (rebuilt from the log; not consensus) and claims series.
 */
function minedDetail(a, height, claims) {
  const from = Math.max(a.mineStart, height - SERIES_BLOCKS + 1);
  return {
    window: MINE_WINDOW,
    staleFactor: STALE_FACTOR,
    hashrateEstimate: hashrateEstimate(claims, height),
    series: {
      difficulty: from > height ? [] : difficultySeries(a, claims, { from, to: height }).map(([h, d]) => [h, d.toString()]),
      claims: (a.claimsByHeight ?? []).filter(([h]) => h > height - SERIES_BLOCKS).map(([h, n]) => [h, n]),
    },
  };
}

const outputView = (o) => ({ leafIndex: o.leafIndex, commitment: o.commitment.toString(), ciphertext: hex(o.ciphertext), height: o.height, txid: o.txid });

/** A route body that is already JSON text: sent as is. */
class JsonText {
  constructor(text) {
    this.text = text;
  }
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Integer query parameter; missing gives `dflt`, garbage is a 400. */
function intParam(q, name, dflt) {
  const raw = q.get(name);
  if (raw === null || raw === "") return dflt;
  if (!/^-?\d+$/.test(raw)) throw new HttpError(400, "bad_request", `Query parameter ${name} must be an integer. Fix the request and try again.`);
  return Number(raw);
}

// POST endpoints of the paid relayer (contract §4.2); each answers 503 "disabled" without one.
const RELAY_POSTS = Object.freeze({
  "/api/relay/submit": { call: "submit", wrongMethod: "Use POST to submit an envelope." },
  "/api/relay/account": { call: "account", wrongMethod: "Use POST to read a relay balance." },
  "/api/relay/credit": { call: "credit", wrongMethod: "Use POST to credit a deposit." },
});

function readBody(req, { limit, timeoutMs }) {
  return new Promise((done, fail) => {
    if (Number(req.headers["content-length"]) > limit) return fail(new RelayError("too_large"));
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => finish(fail, new RelayError("malformed", {}, "The request body did not arrive in time. Try again.")), timeoutMs);
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) finish(fail, new RelayError("too_large"));
      else chunks.push(c);
    });
    req.on("end", () => finish(done, Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e) => finish(fail, e));
  });
}

/**
 * Startup (L2): rewrites the retired v1 relayer.json without the envelopes, raw transactions,
 * nullifiers, accounts and costs of its items (pruneV1State), only when it holds any of them,
 * through writeDurable. Never throws: a file it cannot read or write is left as it is, with a
 * warning (loadV1State prunes it in memory either way). Returns true when it rewrote the file.
 */
export function pruneV1File(path, { log = console } = {}) {
  if (!path || !existsSync(path)) return false;
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved?.version !== 1 || !v1NeedsPrune(saved)) return false;
    writeDurable(path, JSON.stringify(pruneV1State(saved)));
    log.log?.(`${path}: the retired relayer's envelopes, nullifiers and charges were removed; its ids still answer.`);
    return true;
  } catch (e) {
    log.warn?.(`${path}: not pruned (${e.message})`);
    return false;
  }
}

/**
 * Builds the HTTP app around an Indexer. Tests pass an in-memory indexer and
 * a fake esplora; main() passes the persisted indexer and mempool.space.
 *
 * @param idx       the Indexer (synced by tick())
 * @param relayer   the paid relayer (startPaidRelayer), or null: the relay endpoints then answer
 *                  "not available" (stage-0 behaviour).
 * @param v1StatePath  the retired v1 relayer.json, read once (pruned in memory; never written here) to answer old relay ids
 * @param api       Esplora-compatible chain source (sync, recent block hashes)
 * @param statePath where tick() saves the indexer (null: never saved)
 * @param publicUrl absolute origin for og:image / og:url (MURKLE_PUBLIC_URL), optional
 * @param headers   the HeaderChain that verifies every applied block (src/btc/headers.mjs), or null
 * @param source    the openChainSource result ({ kind, save() }), or null: save() runs after each saved state
 * @param network   the network this server indexes (the web build marker must match it)
 * @param healthMaxLag  GET /api/health: blocks behind the chain tip before ok is false (MURKLE_HEALTH_MAX_LAG)
 */
export function createApp({
  idx, relayer = null, api = null, lock = relayer?.lock ?? new Mutex(), statePath = null, v1StatePath = null,
  artifacts = ARTIFACTS, webDist = WEB_DIST, artifactCheck = null, publicUrl = null,
  trustProxy = false, bodyLimit = 4096, bodyTimeoutMs = 10_000, enforceCsp = false, log = console,
  headers = null, source = null, network = NETWORK, healthMaxLag = 3, now = Date.now,
} = {}) {
  const status = { chainTip: null, syncing: false, lastError: null, lastSync: null };
  const startedAt = now();
  const sourceKind = source?.kind ?? "esplora";
  const v1 = loadV1State(v1StatePath, { log });
  // Hashes of tip, tip-1 and tip-2 when the indexer has none yet (a fresh
  // pre-genesis start has applied no block): /api/state lists them.
  const extraHashes = new Map();
  const hashAt = (h) => idx.hashes.get(h) ?? extraHashes.get(h) ?? null;

  // The artifact check (null: unchecked) follows the files on disk, not just the startup state
  // (audit V2-44): a file whose size or times changed is hashed again against the pins, both for
  // /api/state.artifacts and before it is served.
  const signatureOf = () => Object.values(artifacts).map((p) => {
    try {
      const st = statSync(p);
      return `${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    } catch {
      return "missing";
    }
  }).join("|");
  let artifactSig = artifactCheck ? signatureOf() : null;
  function liveArtifactCheck() {
    if (!artifactCheck) return artifactCheck;
    const sig = signatureOf();
    if (sig !== artifactSig) {
      artifactCheck = checkArtifacts(artifacts);
      artifactSig = sig;
      if (!artifactCheck.ok) log.warn?.(`artifacts changed on disk and no longer match the pins: ${[...artifactCheck.mismatched, ...artifactCheck.missing].join(", ")}`);
    }
    return artifactCheck;
  }

  let view = null;
  let viewKey = null;
  let bodies = new Map(); // full-pool bulk bodies of the current view, serialized once
  // Per-output JSON, cached by object: an output never changes in place (a reorg makes new ones).
  const outputJson = new WeakMap();

  function publish() {
    const height = idx.height;
    // [h, h-1, h-2] by position, cut at the first height with no known hash (never a gap).
    const recent = [];
    for (const h of [height, height - 1, height - 2]) {
      const hash = hashAt(h);
      if (!hash) break;
      recent.push(hash);
    }
    const key = `${height}:${recent.join(",")}:${idx.log.length}:${idx.outputs.length}:${idx.nullifiers.size}`;
    if (key === viewKey) return view;
    const s = idx.stats;
    const series = new Map();
    for (const [h, n] of s.outputsByHeight) if (h > height - 1008) series.set(h, [h, n, 0]);
    for (const [h, n] of s.transfersByHeight) if (h > height - 1008) (series.get(h) ?? series.set(h, [h, 0, 0]).get(h))[2] = n;
    // Paid-mint assets (/api/assets) and mined assets (/api/mine), each kind with its own view.
    const minted = [];
    const mined = [];
    for (const a of idx.assets.values()) (a.kind === "pow" ? mined : minted).push(a);
    const claimsOf = new Map(mined.map((a) => [a.id.toString(), []]));
    if (mined.length) for (const e of idx.log) if (isClaimEntry(e)) claimsOf.get(String(e.asset))?.push(e);
    view = {
      height,
      startHeight: idx.startHeight,
      root: idx.tree.root().toString(),
      digest: idx.digestAt(height),
      // Snapshotted with the rest of the view: a tick that rolls back and re-applies blocks
      // mutates idx.hashes while requests are served, and must not show a half-updated tip.
      tipHash: hashAt(height),
      recentHashes: recent,
      genesis: idx.genesis ? { txid: idx.genesis.txid, height: idx.startHeight, manifestSha256: idx.genesis.manifestSha256 } : null,
      outputs: idx.outputs.slice(),
      nullifiers: [...idx.nullifiers],
      log: idx.log.slice(),
      roots: new Map(idx.roots),
      hashes: new Map(idx.hashes),
      digests: new Map(idx.digests),
      assets: minted.map((a) => ({ ...assetView(a, height), kind: "mint", mintsByHeight: a.mintsByHeight.map((p) => [...p]) })),
      // A view that cannot be built is left out and logged: a view never stops the publish.
      mined: mined.flatMap((a) => {
        try {
          return [minedView(a, height, claimsOf.get(a.id.toString()), idx.mineFee)];
        } catch (e) {
          log.error?.(`mined token ${a.ticker}: view failed (${e.message})`);
          return [];
        }
      }),
      // What GET /api/mine/:asset needs, snapshotted here (its series is built on first request).
      minedSrc: new Map(mined.map((a) => [a.id.toString(), {
        terms: { ...a, claimsByHeight: (a.claimsByHeight ?? []).map((p) => [...p]) }, claims: claimsOf.get(a.id.toString()),
      }])),
      mining: {
        height: idx.miningHeight ?? null,
        active: typeof idx.miningActive === "function" ? idx.miningActive(height + 1) : false,
      },
      stats: {
        notes: idx.outputs.length,
        nullifiers: idx.nullifiers.size,
        privateTransfers: s.accepted.transact,
        transfers144: sumSince(s.transfersByHeight, height - 143),
        transfers1008: sumSince(s.transfersByHeight, height - 1007),
        mints: s.accepted.mint,
        tokens: idx.assets.size,
        deploys: s.accepted.deploy,
        attests: s.accepted.attest,
        ...(s.accepted.mine ? { mines: s.accepted.mine } : {}), // accepted mining claims, only once non-zero (mining-contract.md D5)
        rejected: s.rejected,
        height,
        series: [...series.values()].sort((a, b) => a[0] - b[0]),
      },
    };
    bodies = new Map();
    viewKey = key;
    return view;
  }

  async function refreshRecentHashes() {
    if (!api) return;
    for (let h = idx.height; h >= idx.height - 2 && h >= 0; h--) {
      if (!idx.hashes.has(h) && !extraHashes.has(h)) extraHashes.set(h, await api.blockHash(h));
    }
    for (const h of extraHashes.keys()) if (h < idx.height - 2 || h > idx.height) extraHashes.delete(h);
  }

  /** sync -> save -> relayer.onTick -> publish, under the lock shared with fast-mode flushes. */
  function tick() {
    return lock.run(async () => {
      if (status.syncing) return;
      status.syncing = true;
      try {
        // Without a header chain the call is exactly today's (signet fallback, tests).
        status.chainTip = headers ? await syncIndexer(idx, api, { headers }) : await syncIndexer(idx, api);
        // The header chain first: a crash between the two writes then leaves headers.json at or
        // above state.json, which alignTo() matches without fetching anything (src/sync.mjs).
        if (source && typeof source.save === "function") {
          try {
            source.save();
          } catch (e) {
            log.warn?.(`saving the header chain failed: ${e.message}`);
          }
        }
        if (statePath) saveIndexer(statePath, idx);
        await refreshRecentHashes();
        status.lastError = null;
        status.lastSync = Date.now();
        if (relayer) {
          try {
            await relayer.onTick({ chainTip: status.chainTip });
          } catch (e) {
            log.error?.(`relayer tick failed: ${e.message}`);
          }
        }
      } catch (e) {
        status.lastError = e.message;
        log.error?.(`sync failed: ${e.message}`);
      } finally {
        status.syncing = false;
        publish();
      }
    });
  }

  // ------------------------------------------------------------ responses

  const json = (res, code, body, extra = {}) => {
    res.writeHead(code, {
      ...BASE_HEADERS,
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
      ...extra,
    });
    res.end(res.req?.method === "HEAD" ? undefined : body instanceof JsonText ? body.text : JSON.stringify(body));
  };
  const fail = (res, status, code, message, extra) => json(res, status, { error: { code, message } }, extra);

  function htmlHeaders() {
    const name = enforceCsp ? "content-security-policy" : "content-security-policy-report-only";
    // X-Frame-Options is the enforced anti-framing control while the CSP is Report-Only.
    return { ...BASE_HEADERS, [name]: CSP, "x-frame-options": "DENY" };
  }

  function sendFile(res, file, { cache = "no-cache", extra = {} } = {}) {
    const size = statSync(file).size;
    res.writeHead(200, {
      ...BASE_HEADERS,
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "content-length": size,
      "cache-control": cache,
      "access-control-allow-origin": "*",
      ...extra,
    });
    if (res.req?.method === "HEAD") return res.end();
    // A file removed after statSync (a rebuild) must not crash the process.
    createReadStream(file)
      .on("error", (e) => {
        log.error?.(`reading ${file} failed: ${e.message}`);
        res.destroy();
      })
      .pipe(res);
  }

  // ------------------------------------------------------------ OG meta

  const origin = publicUrl ? String(publicUrl).replace(/\/+$/, "") : "";
  // Link previews: "signet test network, no value" on signet only; mainnet gets neutral text with
  // no value claims (and says it has not launched while no genesis is pinned).
  const onSignet = network === "signet";
  const GENERIC = {
    title: `${BRAND}: private tokens on Bitcoin`,
    description: onSignet
      ? "Private tokens on Bitcoin. Every proof lives on-chain. Your browser checks every one. Signet test network; the tokens have no value."
      : `Private tokens on Bitcoin. Every proof lives on-chain. Your browser checks every one.${PRE_GENESIS ? ` ${BRAND} has not launched on Bitcoin mainnet.` : " Experimental software."}`,
  };
  const minedTail = onSignet ? "A private token on Bitcoin, issued by proof of work; signet test network, no value." : "A private token on Bitcoin, issued by proof of work.";
  const mintTail = onSignet ? "A private token on Bitcoin; signet test network, no value." : "A private token on Bitcoin.";

  function metaFor(ticker) {
    const a = view.assets.find((x) => x.ticker === ticker);
    const m = a ? null : view.mined.find((x) => x.ticker === ticker);
    if (m) {
      return {
        title: `${m.ticker} on ${BRAND}`,
        description: `${formatUnits(m.issued, m.divisibility)} of ${formatUnits(m.maxSupply, m.divisibility)} ${m.ticker} mined (${m.status.replace("-", " ")}) · ${formatUnits(m.reward, m.divisibility)} ${m.ticker} per claim. ${minedTail}`,
        path: `/t/${m.ticker}`,
      };
    }
    if (!a) return { ...GENERIC, path: "/" };
    const per = `${formatUnits(a.mintAmount, a.divisibility)} ${a.ticker} per mint`;
    const price = a.priceSats === "0" ? "free mint" : `${a.priceSats} sats per mint`;
    return {
      title: `${a.ticker} on ${BRAND}`,
      description: `${a.minted} of ${a.mintCap} mints (${a.status.replace("-", " ")}) · ${per} · ${price}. ${mintTail}`,
      path: `/t/${a.ticker}`,
    };
  }

  /**
   * The preview image tags. Open Graph and Twitter cards want absolute image URLs, and the
   * server cannot know its public origin without MURKLE_PUBLIC_URL (the Host header can be
   * spoofed). With it: absolute og:image and twitter:image and a large-image card. Without it:
   * a relative og:image (some crawlers resolve it against the page URL) and a plain "summary"
   * card with no twitter:image, which X would ignore anyway (audit V2-13).
   */
  const imageTags = () => [
    ["property", "og:image", `${origin}/og.png`],
    ["property", "og:image:width", "1200"],
    ["property", "og:image:height", "630"],
    ["name", "twitter:card", origin ? "summary_large_image" : "summary"],
    ...(origin ? [["name", "twitter:image", `${origin}/og.png`]] : []),
  ];
  const metaTag = ([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`;
  const inHead = (html, tags) => {
    const text = tags.map(metaTag);
    return html.includes("</head>") ? html.replace("</head>", () => `    ${text.join("\n    ")}\n  </head>`) : text.join("\n") + html;
  };

  /** index.html with escaped OG/Twitter meta for /t/:ticker (existing og:/twitter: tags replaced). */
  function withMeta(html, meta) {
    const tags = [
      ["property", "og:type", "website"],
      ["property", "og:site_name", BRAND],
      ["property", "og:title", meta.title],
      ["property", "og:description", meta.description],
      ...(origin ? [["property", "og:url", `${origin}${meta.path}`]] : []),
      ["name", "twitter:title", meta.title],
      ["name", "twitter:description", meta.description],
      ["name", "description", meta.description],
      ...imageTags(),
    ];
    const out = html
      .replace(/<meta\s+(?:property|name)="(?:og:[^"]*|twitter:[^"]*|description)"[^>]*>\s*/gi, "")
      .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHtml(meta.title)}</title>`);
    return inHead(out, tags);
  }

  /** index.html for every other route: only its preview image tags are replaced (imageTags). */
  function withImages(html) {
    return inHead(html.replace(/<meta\s+(?:property|name)="(?:og:image[^"]*|twitter:card|twitter:image[^"]*)"[^>]*>\s*/gi, ""), imageTags());
  }

  function sendIndex(res, path) {
    const index = join(webDist, "index.html");
    if (!existsSync(index)) {
      res.writeHead(404, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" });
      return res.end("The web app is not built. Run npm run web:build, or use npm run dev.");
    }
    let html = readFileSync(index, "utf8");
    const m = path.match(/^\/t\/([^/]+)\/?$/);
    if (m) {
      let ticker = "";
      try {
        ticker = decodeURIComponent(m[1]).toUpperCase();
      } catch {
        ticker = "";
      }
      html = withMeta(html, TICKER.test(ticker) ? metaFor(ticker) : { ...GENERIC, path: "/" });
    } else html = withImages(html);
    const body = Buffer.from(html, "utf8");
    res.writeHead(200, {
      ...htmlHeaders(),
      "content-type": "text/html; charset=utf-8",
      "content-length": body.length,
      "cache-control": "no-cache",
    });
    res.end(res.req?.method === "HEAD" ? undefined : body);
  }

  // ------------------------------------------------------------ API routes

  const rangeOf = (q, { lo, hi, maxSpan = Infinity, dfltFrom = lo, dfltTo = hi }) => {
    const from = Math.max(lo, intParam(q, "from", dfltFrom));
    const to = Math.min(hi, intParam(q, "to", dfltTo), from + maxSpan - 1);
    return { from, to };
  };

  function stateBody() {
    const v = view;
    return {
      protocol: PROTOCOL,
      brand: BRAND,
      network: NETWORK,
      height: v.height,
      startHeight: v.startHeight,
      chainTip: status.chainTip,
      tipHash: v.tipHash,
      recentHashes: v.recentHashes,
      root: v.root,
      digest: v.digest,
      outputs: v.outputs.length,
      nullifiers: v.nullifiers.length,
      genesis: v.genesis,
      preGenesis: !v.genesis,
      ...(v.genesis ? {} : { warning: `Pre-genesis: no genesis attestation is pinned yet. This indexer started at block ${v.startHeight}; a re-genesis will reset it.` }),
      anchorWindow: ANCHOR_WINDOW,
      syncing: status.syncing,
      lastError: status.lastError,
      lastSync: status.lastSync,
      artifacts: liveArtifactCheck(),
      // `batch`: the current Hourly and 10-hour epochs ({ start, releaseAt, queued }), as the relayer reports them.
      relay: { enabled: Boolean(relayer?.config.enabled), mode: relayer ? "balance" : null, queued: relayer ? relayer.queuedCount() : 0, defaultMode: "block", batch: relayer?.batchSummary?.() ?? null },
      // Where the chain data comes from and what its header check verified (SPEC.md §16).
      chain: { source: sourceKind, headers: headerStatus() },
    };
  }

  function headerStatus() {
    if (!headers || typeof headers.status !== "function") return null;
    try {
      return headers.status();
    } catch (e) {
      return { verified: false, network, lastError: { code: "status", message: e.message, height: null } };
    }
  }

  function relayerHealth() {
    if (!relayer) return { enabled: false, halted: false, code: null };
    if (typeof relayer.health === "function") {
      const h = relayer.health();
      return { enabled: Boolean(h.enabled), halted: Boolean(h.halted), code: h.code ?? null };
    }
    return { enabled: Boolean(relayer.config?.enabled), halted: false, code: null };
  }

  /** GET /api/health (mainnet-readiness.md §4.5): liveness plus the checks the monitor alerts on. */
  function healthBody() {
    const height = idx.height;
    const lagBlocks = status.chainTip == null ? null : Math.max(0, status.chainTip - height);
    const syncAgeSecs = Math.max(0, Math.floor((now() - (status.lastSync ?? startedAt)) / 1000));
    const hs = headerStatus();
    const rel = relayerHealth();
    const art = liveArtifactCheck();
    const artifactsOk = art ? Boolean(art.ok) : true;
    const ok = !status.lastError && !(lagBlocks !== null && lagBlocks > healthMaxLag) && syncAgeSecs <= HEALTH_MAX_SYNC_AGE_SECS
      && artifactsOk && !rel.halted && !hs?.lastError;
    return {
      ok,
      network,
      height,
      chainTip: status.chainTip,
      lagBlocks,
      lastSync: status.lastSync,
      syncAgeSecs,
      lastError: status.lastError,
      source: sourceKind,
      headers: hs ? { verified: Boolean(hs.verified), tipHeight: hs.tipHeight ?? null, baseHeight: hs.base?.height ?? null, lastError: hs.lastError ?? null } : null,
      relayer: rel,
      artifacts: { ok: artifactsOk },
      preGenesis: !idx.genesis,
    };
  }

  const memo = (name, build) => bodies.get(name) ?? bodies.set(name, build()).get(name);
  const fragmentsOf = (o) => {
    let f = outputJson.get(o);
    if (!f) {
      const v = outputView(o);
      outputJson.set(o, (f = [JSON.stringify(v), JSON.stringify([v.commitment, v.height])]));
    }
    return f;
  };

  /** Outputs [from, to) as JSON from cached per-output fragments; the full pool is serialized once per view. */
  function bulkOutputs(name, q, part) {
    // `to` lets a wallet fetch exactly the outputs of the snapshot whose root it checks.
    const { from, to } = rangeOf(q, { lo: 0, hi: view.outputs.length });
    const build = () => new JsonText(`[${view.outputs.slice(from, Math.max(from, to)).map((o) => fragmentsOf(o)[part]).join(",")}]`);
    return from === 0 && to === view.outputs.length ? memo(name, build) : build();
  }

  const routes = {
    "/api/state": () => stateBody(),
    "/api/outputs": (q) => bulkOutputs("outputs", q, 0),
    "/api/commitments": (q) => bulkOutputs("commitments", q, 1),
    "/api/nullifiers": () => memo("nullifiers", () => new JsonText(JSON.stringify(view.nullifiers))),
    "/api/log": (q) => {
      if (q.has("txid") || q.has("nullifier")) {
        throw new HttpError(400, "bad_request", "Per-transaction lookups are not served: they would reveal which transactions are yours. Fetch the log in bulk and filter it locally.");
      }
      const total = view.log.length;
      const from = Math.max(0, intParam(q, "from", 0));
      const limit = Math.max(1, Math.min(MAX_LOG_PAGE, intParam(q, "limit", MAX_LOG_PAGE)));
      const items = view.log.slice(from, from + limit);
      const end = from + items.length;
      return { items, next: end < total ? end : null, total };
    },
    "/api/roots": (q) => {
      if (q.has("height")) {
        // Present but empty is a malformed request, not an unknown height.
        const h = intParam(q, "height", null);
        if (h === null) throw new HttpError(400, "bad_request", "Query parameter height must be an integer. Fix the request and try again.");
        if (!view.roots.has(h)) throw new HttpError(404, "not_found", `No root for block ${h}. Use a height the indexer has applied.`);
        return { height: h, root: view.roots.get(h).toString() };
      }
      const lo = view.startHeight - 1;
      const { from, to } = rangeOf(q, { lo, hi: view.height, maxSpan: MAX_RANGE, dfltFrom: Math.max(lo, view.height - MAX_RANGE + 1) });
      const out = [];
      for (let h = from; h <= to; h++) if (view.roots.has(h)) out.push([h, view.roots.get(h).toString()]);
      return out;
    },
    "/api/digest": (q) => {
      const h = intParam(q, "height", view.height);
      const digest = view.digests.get(h);
      if (!digest) throw new HttpError(404, "not_found", `No digest for block ${h}. Use a height between ${view.startHeight} and ${view.height}.`);
      // `version` only from digest v2 on (absent means v1, SPEC.md §10).
      const version = typeof idx.digestVersionAt === "function" ? idx.digestVersionAt(h) : 1;
      return { height: h, ...(version >= 2 ? { version } : {}), digest, blockHash: view.hashes.get(h) ?? null, root: view.roots.get(h)?.toString() ?? null };
    },
    "/api/digests": (q) => {
      const lo = view.startHeight;
      const { from, to } = rangeOf(q, { lo, hi: view.height, maxSpan: MAX_RANGE, dfltFrom: Math.max(lo, view.height - MAX_RANGE + 1) });
      const out = [];
      for (let h = from; h <= to; h++) if (view.digests.has(h)) out.push([h, view.digests.get(h)]);
      return out;
    },
    "/api/assets": () => view.assets.map(({ mintsByHeight, ...a }) => a),
    "/api/stats": () => view.stats,
    "/api/blocks": (q) => {
      const limit = Math.max(1, Math.min(144, intParam(q, "limit", 24)));
      const lowest = Math.max(view.startHeight, view.height - limit + 1);
      const rows = new Map();
      for (let h = view.height; h >= lowest; h--) {
        rows.set(h, { height: h, hash: view.hashes.get(h) ?? null, ops: { deploy: 0, mint: 0, transfer: 0, attest: 0, rejected: 0 } });
      }
      const key = { DEPLOY: "deploy", DEPLOY_POW: "deploy", MINT: "mint", MINT_SCRIPT: "mint", TRANSFER: "transfer", ATTEST: "attest", MINE: "mine", MINE_SCRIPT: "mine" };
      for (let k = view.log.length - 1; k >= 0 && view.log[k].height >= lowest; k--) {
        const e = view.log[k];
        const row = rows.get(e.height);
        if (!row) continue;
        if (!e.ok) row.ops.rejected += 1;
        else if (key[e.opName]) row.ops[key[e.opName]] = (row.ops[key[e.opName]] ?? 0) + 1; // `mine` only on rows with a claim
      }
      return [...rows.values()];
    },
    "/api/mine": () => memo("mine", () => ({
      activation: view.mining,
      tip: { height: view.height, hash: view.tipHash },
      assets: view.mined,
    })),
    "/api/relay/info": () => (relayer ? relayer.info() : relayInfoOff()),
    "/api/relay/ledger": (q) => {
      if (!relayer) return { address: null, totals: { carriers: 0, accepted: 0, wasted: 0, satsSpent: 0, fanoutSats: 0 }, items: [] };
      return relayer.ledgerView({ limit: intParam(q, "limit", 100), before: q.has("before") ? intParam(q, "before") : undefined });
    },
  };

  async function handleApi(req, res, path, q) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...BASE_HEADERS,
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      return res.end();
    }
    const post = RELAY_POSTS[path];
    if (post) {
      if (req.method !== "POST") return fail(res, 405, "method_not_allowed", post.wrongMethod, { allow: "POST, OPTIONS" });
      if (!relayer || !relayer.config.enabled) {
        const e = new RelayError("disabled", {}, SUBMIT_MESSAGE);
        return json(res, e.status, e.toJSON());
      }
      let text;
      try {
        text = await readBody(req, { limit: bodyLimit, timeoutMs: bodyTimeoutMs });
      } catch (e) {
        const err = e instanceof RelayError ? e : new RelayError("malformed");
        return json(res, err.status, err.toJSON(), err.code === "too_large" ? { connection: "close" } : {});
      }
      // The body goes to the relayer only: it is never logged, here or there.
      const out = await relayer[post.call](text, clientIp(req, trustProxy));
      return json(res, out.status, out.body);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "method_not_allowed", "This endpoint is read-only. Use GET.", { allow: "GET, HEAD, OPTIONS" });

    const statusMatch = path.match(/^\/api\/relay\/status\/([^/]+)$/);
    if (statusMatch) {
      const st = relayer?.status(statusMatch[1]) ?? v1Status(v1, statusMatch[1]);
      if (!st) return fail(res, 404, "not_found", "Unknown relay id. It may have been pruned after 1008 blocks; check your history instead.");
      return json(res, 200, st);
    }
    const assetMatch = path.match(/^\/api\/assets\/([^/]+)$/);
    if (assetMatch) {
      let ticker = "";
      try {
        ticker = decodeURIComponent(assetMatch[1]).toUpperCase();
      } catch {
        ticker = "";
      }
      if (!TICKER.test(ticker)) return fail(res, 400, "bad_request", "A ticker is 1-16 characters A-Z and 0-9. Check the ticker and try again.");
      const a = view.assets.find((x) => x.ticker === ticker) ?? view.mined.find((x) => x.ticker === ticker);
      if (!a) return fail(res, 404, "not_found", `No token ${ticker} is deployed. Check the ticker, or browse the mints.`);
      return json(res, 200, a);
    }
    const mineMatch = path.match(/^\/api\/mine\/([^/]+)$/);
    if (mineMatch) {
      let key = "";
      try {
        key = decodeURIComponent(mineMatch[1]).toUpperCase();
      } catch {
        key = "";
      }
      const isId = /^\d{1,20}$/.test(key);
      if (!isId && !TICKER.test(key)) return fail(res, 400, "bad_request", "Name a mined token by its ticker (1-16 characters A-Z and 0-9) or its decimal asset id.");
      // A decimal string is an asset id first, then a ticker (tickers may be all digits).
      const m = (isId ? view.mined.find((x) => x.asset === String(BigInt(key))) : null) ?? view.mined.find((x) => x.ticker === key);
      if (!m) return fail(res, 404, "not_found", `No mined token ${key}. Check the ticker, or browse the mined tokens.`);
      const body = memo(`mine:${m.asset}`, () => {
        const src = view.minedSrc.get(m.asset);
        return { ...m, tip: { height: view.height, hash: view.tipHash }, ...minedDetail(src.terms, view.height, src.claims) };
      });
      // Claims on their way, as the relayer counts them now, and the sum of their rewards (each at
      // its own reference block, so a halving between them counts right); null without a relayer.
      const counts = relayer && typeof relayer.pendingClaims === "function";
      return json(res, 200, {
        ...body,
        pendingClaims: counts ? relayer.pendingClaims(m.asset) : null,
        pendingReward: counts && typeof relayer.pendingReward === "function" ? String(relayer.pendingReward(m.asset)) : null,
      });
    }
    if (path === "/api/health") {
      // Liveness: 200 while the process serves (container health checks). ?strict=1 answers 503
      // when ok is false (the monitor, load balancers), never for container restarts.
      const body = healthBody();
      return json(res, q.get("strict") === "1" && !body.ok ? 503 : 200, body);
    }
    const route = routes[path];
    if (!route) return fail(res, 404, "not_found", "Unknown API endpoint. Check the path.");
    return json(res, 200, route(q));
  }

  function handleArtifact(res, name) {
    const file = Object.hasOwn(artifacts, name) ? artifacts[name] : null;
    if (!file || !existsSync(file)) return fail(res, 404, "not_found", "Unknown artifact. The served artifacts are listed in the manifest.");
    // Never served as a pinned artifact once it no longer matches its pin.
    if (liveArtifactCheck()?.mismatched.includes(name)) {
      return fail(res, 503, "unavailable", `This artifact no longer matches its pinned hash in ${PINS_FILE}. Try again later, or fetch it from another source and check it against the pins.`);
    }
    return sendFile(res, file, { cache: "public, max-age=3600" });
  }

  // A web app built for another network is never served (mainnet-readiness.md §4.5): a signet
  // wallet on a mainnet indexer would derive the wrong keys and addresses. Rechecked when the
  // marker file changes (a rebuild).
  let buildSig = null;
  let buildCheck = null;
  function webBuildCheck() {
    let sig = "none";
    try {
      const st = statSync(join(webDist, BUILD_MARKER));
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      sig = "none";
    }
    if (sig !== buildSig || !buildCheck) {
      buildCheck = checkWebBuild(webDist, network);
      buildSig = sig;
    }
    return buildCheck;
  }
  function refuseBuild(res, message) {
    res.writeHead(503, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    return res.end(res.req?.method === "HEAD" ? undefined : message);
  }

  /** /ceremony serves the ceremony page when it is built; the coordinator's API and files are not served here. */
  function handleCeremony(res, path) {
    if (path === "/ceremony/transcript.json" || path === "/ceremony/api" || path.startsWith("/ceremony/api/") || path.startsWith("/ceremony/files/")) {
      return fail(res, 404, "not_found", "The ceremony coordinator is a separate service; this indexer does not serve its API or files.");
    }
    const build = webBuildCheck();
    if (!build.ok) return refuseBuild(res, build.message);
    const page = join(webDist, "ceremony.html");
    if (!existsSync(page)) {
      res.writeHead(404, { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" });
      return res.end(res.req?.method === "HEAD" ? undefined : "The ceremony page is not built.");
    }
    return sendFile(res, page, { cache: "no-cache", extra: htmlHeaders() });
  }

  function handleStatic(res, path) {
    const build = webBuildCheck();
    if (!build.ok) return refuseBuild(res, build.message);
    let rel;
    try {
      rel = decodeURIComponent(path);
    } catch {
      rel = null;
    }
    if (rel !== null && rel !== "/" && !rel.includes("\0")) {
      const file = resolve(webDist, "." + rel);
      if (file.startsWith(resolve(webDist) + sep) && existsSync(file) && statSync(file).isFile()) {
        const html = extname(file).toLowerCase() === ".html";
        const immutable = rel.startsWith("/assets/");
        return sendFile(res, file, { cache: immutable ? "public, max-age=31536000, immutable" : "no-cache", extra: html ? htmlHeaders() : {} });
      }
    }
    // SPA fallback: every other path is a client-side route.
    return sendIndex(res, path);
  }

  async function handle(req, res) {
    let path = "";
    try {
      let url;
      try {
        url = new URL(req.url, "http://localhost");
      } catch {
        throw new HttpError(400, "bad_request", "The request URL is malformed. Fix the request and try again.");
      }
      path = url.pathname;
      if (path === "/api" || path.startsWith("/api/")) return await handleApi(req, res, path, url.searchParams);
      if (req.method !== "GET" && req.method !== "HEAD") return fail(res, 405, "method_not_allowed", "Only GET is served here.", { allow: "GET, HEAD" });
      if (path.startsWith("/artifacts/")) return handleArtifact(res, path.slice("/artifacts/".length));
      if (path === "/ceremony" || path === "/ceremony/" || path === "/ceremony/transcript.json" || path === "/ceremony/api"
        || path.startsWith("/ceremony/api/") || path.startsWith("/ceremony/files/")) return handleCeremony(res, path);
      return handleStatic(res, path);
    } catch (e) {
      if (e instanceof HttpError) return fail(res, e.status, e.code, e.message);
      log.error?.(`request ${req.method} ${path} failed: ${e.stack ?? e.message}`);
      if (!res.headersSent) return fail(res, 500, "internal", "The indexer hit an internal error. Try again in a minute.");
      res.destroy();
    }
  }

  publish();
  // Nothing a request does may reject unhandled: Node would exit the whole process.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log.error?.(`request ${req.method} failed: ${e.stack ?? e.message}`);
      res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  // Longer than the proxy keeps an idle upstream connection (deploy/caddy: 60 s), so it never
  // reuses a socket this server is closing (a 502, unretried on a POST).
  server.keepAliveTimeout = 65_000;
  return { server, tick, publish, status, hashAt, view: () => view, health: healthBody };
}

/** True when this file is the process entry point (not imported by a test). */
function isMain() {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? entry.toLowerCase() === self.toLowerCase() : entry === self;
}

const fromRoot = (p) => (isAbsolute(p) ? p : join(ROOT, p));

async function main() {
  // Mainnet refusals first (D13), each with the reason and the fix.
  const refusal = startRefusal();
  if (refusal) {
    console.error(`refusing to start: ${refusal}`);
    process.exit(1);
  }
  // Pinned artifacts: never serve or verify with a verification key other than the pinned one.
  let vkey;
  try {
    vkey = loadPinnedVkey(ARTIFACTS["verification_key.json"]);
  } catch (e) {
    console.error(`refusing to start: ${e.message}`);
    process.exit(1);
  }
  const artifactCheck = checkArtifacts();
  if (!artifactCheck.ok) {
    const what = [...artifactCheck.mismatched.map((n) => `${n} (hash differs from ${PINS_FILE})`), ...artifactCheck.missing.map((n) => `${n} (missing)`)].join(", ");
    // A manifest that is not the anchored one must never be served once genesis is pinned.
    if (MANIFEST_SHA256 && artifactCheck.mismatched.includes("manifest.json") && env("ALLOW_UNPINNED") !== "1") {
      console.error(`refusing to start: ${ARTIFACT_PATHS.manifest} does not match manifestSha256 in ${PINS_FILE}`);
      process.exit(1);
    }
    console.warn(`WARNING: artifacts do not match the pins: ${what}. Wallets will refuse to prove with them.`);
  }

  let source;
  try {
    source = await openServerChainSource({ headersPath: env("HEADERS_PATH") ? fromRoot(env("HEADERS_PATH")) : DEFAULT_HEADERS });
  } catch (e) {
    console.error(`refusing to start: ${e.message}`);
    process.exit(1);
  }
  const api = source.api;
  const headers = source.headers ?? null;
  console.log(`${NETWORK}: chain data from ${typeof source.describe === "function" ? source.describe() : source.kind}`);
  if (!headers) console.warn(`WARNING: block headers are not verified (${NETWORK}); the data source is trusted for proof of work.`);
  const statePath = env("STATE_PATH") ? fromRoot(env("STATE_PATH")) : DEFAULT_STATE;
  const idx = await loadIndexer(statePath, { vkey, api });
  // Every Argon2 evaluation (MINE claims, in the indexer and the relayer) runs in worker
  // threads, never on this event loop. A pool that fails its self-test stays in place: a block
  // that needs PoW then fails and is retried (never judged), and everything else keeps working.
  const pow = await createNodePowPool();
  idx.pow = pow;
  pow.ready().then(
    ({ impl, workers }) => console.log(`Argon2 worker pool ready: ${workers} thread(s), ${impl}`),
    (e) => console.error(`Argon2 worker pool failed its self-test (${e?.code ?? e?.message}); blocks with mining claims are retried, never judged, until it passes.`),
  );
  if (!idx.genesis) {
    console.warn(`PRE-GENESIS: no genesis attestation is pinned in ${PINS_FILE}; indexing from block ${idx.startHeight} without the genesis check.`);
  } else {
    console.log(`genesis ${idx.genesis.txid} at block ${idx.startHeight} (manifest ${idx.genesis.manifestSha256.slice(0, 16)}...)`);
  }

  // The paid relayer starts only with MURKLE_RELAYER=1, MURKLE_RELAY_MODE=balance and a valid
  // configuration (rule R6); it never loads the retired key as pool money. Any refusal
  // leaves the indexer running with the relay endpoints answering "not available".
  const startup = relayerStartup();
  const config = startup.config;
  const lock = new Mutex();
  let relayer = null;
  const notLaunched = startup.start ? relayerRefusal() : null;
  if (notLaunched) console.error(`${notLaunched} The indexer keeps running.`);
  else if (startup.start) {
    try {
      relayer = await startPaidRelayer({ idx, esplora: api, config, root: ROOT, lock, log: console });
      console.log(startup.message);
    } catch (e) {
      console.error(`refusing to start the relayer: ${e.message} The indexer keeps running.`);
    }
  } else if (startup.requested) console.error(startup.message);
  else console.log(startup.message);
  // Old relay ids answer from the v1 state, read once. A v1 file that still holds an envelope,
  // a raw transaction, nullifiers, an account or a cost is cut down once, here, to what those
  // answers need (privacy-trace-test.md L2); it is never written otherwise.
  const v1StatePath = fromRoot(config.statePath);
  pruneV1File(v1StatePath);

  // Not PORT: dev tooling sets PORT for the web server that runs alongside.
  const port = Number(env("INDEXER_PORT") ?? 8787);
  if (!env("PUBLIC_URL")) {
    console.warn("MURKLE_PUBLIC_URL is not set: link previews get a relative og:image and no large-image card. Set it to this site's public origin (https://...).");
  }
  const maxLag = Number(env("HEALTH_MAX_LAG") ?? 3);
  const enforceCsp = cspEnforced();
  if (!enforceCsp && !IS_TESTNET) console.warn(`WARNING: the Content-Security-Policy is Report-Only on ${NETWORK} (MURKLE_CSP_ENFORCE=0). Enforce it before the public site goes live (docs/MAINNET.md).`);
  const app = createApp({
    idx, relayer, api, lock, statePath, v1StatePath, artifactCheck,
    publicUrl: env("PUBLIC_URL") || null,
    trustProxy: config.trustProxy, bodyLimit: config.bodyLimit, bodyTimeoutMs: config.bodyTimeoutMs,
    enforceCsp,
    headers, source, network: NETWORK, healthMaxLag: Number.isFinite(maxLag) && maxLag >= 0 ? maxLag : 3,
  });
  const build = checkWebBuild(WEB_DIST, NETWORK);
  if (!build.ok) console.error(`WARNING: ${build.message} The web app answers 503 until then.`);
  app.server.listen(port, () => console.log(`${BRAND} indexer API (${NETWORK}) on http://localhost:${port} (height ${idx.height})`));
  await app.tick();
  setInterval(app.tick, SYNC_MS);
}

if (isMain()) await main();

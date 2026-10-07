// Shared Node code for the Murkle phase-2 trusted-setup ceremony (audit A-8, docs/CEREMONY.md).
//
// Used by the coordinator (server/ceremony-server.mjs), its verification child process
// (verify-one.mjs) and the command-line tools in this folder. Node only.
//
// What lives here:
// - the pins the ceremony starts from (the circuit's r1cs and the public phase-1 ptau),
// - a reader for the contribution list of a zkey file (snarkjs 0.7.5 binary format,
//   section 10) that recomputes each contribution hash exactly as snarkjs prints it,
// - deterministic initial key, verification and beacon helpers around snarkjs,
// - the beacon block reader (Esplora or Bitcoin Core) with its header checks,
// - small file helpers (atomic JSON writes, ceremony directory layout, arguments).
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2b";
import * as snarkjs from "snarkjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** snarkjs version actually loaded (receipts name it). */
export const SNARKJS_VERSION = (() => {
  try {
    const main = createRequire(import.meta.url).resolve("snarkjs");
    return JSON.parse(readFileSync(join(dirname(main), "..", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
})();
export const VERIFIED_WITH = `snarkjs ${SNARKJS_VERSION} zkey verifyFromInit`;

/**
 * What the ceremony is pinned to. The r1cs hash is the one in the signet manifest
 * (build/manifest.json, itself pinned by src/pins.json): the same circuit runs on both
 * networks. The ptau is the public Perpetual Powers of Tau file that
 * scripts/build-circuit.mjs downloads and checks against two hashes.
 */
export const PINNED = Object.freeze({
  r1csSha256: "382e5c0a70bf5f327804080f5aee999454a32c1b302017185894b0b363e8335e",
  constraints: 18411,
  wasmSha256: "7b9f73d4c5eccdb982f0a132979f5ceedd0bc08b569b94c022dcf0718ca0fe7d",
  circom: "2.2.2",
  ptau: Object.freeze({
    name: "powersOfTau28_hez_final_15.ptau",
    sha256: "3ef2ecc5b75d687048cf2d59195119b42fb07c5af639c5f283d84bfa69829e7f",
  }),
});
export const DEFAULT_PATHS = Object.freeze({
  r1cs: "build/transaction.r1cs",
  ptau: `build/ptau/${PINNED.ptau.name}`,
  wasm: "build/transaction_js/transaction.wasm",
});

export const PROTOCOL = "murkle";
export const ITERATIONS_EXP = 10; // the beacon is hashed 2^10 times (snarkjs minimum)
export const CLOSE_BEFORE_BLOCKS = 6; // the queue closes this many blocks before the beacon height
export const CONFIRMATIONS = 6; // finalize waits until the beacon block is this deep
export const UPLOAD_SLACK = 65536; // an upload may exceed the key it extends by at most this much
export const NAME_MAX = 64; // snarkjs stores at most 64 bytes of a contributor name

/** Block 0 of each network: a data source must serve this hash before it is believed. */
export const GENESIS_HASH = Object.freeze({
  mainnet: "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f",
  signet: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
});
// Bitcoin Core's powLimit per network (the easiest target a valid header may claim).
const POW_LIMIT = Object.freeze({
  mainnet: 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffn,
  signet: 0x00000377ae000000000000000000000000000000000000000000000000000000n,
});
const PUBLIC_ESPLORA = Object.freeze({ mainnet: "https://mempool.space/api", signet: "https://mempool.space/signet/api" });
const BITCOIND_PORT = Object.freeze({ mainnet: 8332, signet: 38332 });

/* ------------------------------------------------------------------ bytes and files */

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sha256File = (path) => sha256Hex(readFileSync(path));
export const toHex = (bytes) => Buffer.from(bytes).toString("hex");
export const zkeyName = (index) => `${String(index).padStart(4, "0")}.zkey`;
export const HASH128 = /^[0-9a-f]{128}$/;

/** Lowercase 128-hex contribution hash from any spacing snarkjs or a person used; null if it is not one. */
export function normalizeHash(text) {
  const h = String(text ?? "").replace(/[\s:]/g, "").toLowerCase();
  return HASH128.test(h) ? h : null;
}

const RENAME_RETRY = new Set(["EPERM", "EACCES", "EBUSY"]);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Writes bytes atomically (temp file in the same directory, then rename; Windows retries). */
export function writeFileAtomic(path, data, { mode = 0o644 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode });
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path);
        return;
      } catch (e) {
        if (!RENAME_RETRY.has(e?.code) || attempt >= 20) throw e;
        pause(10 + attempt * 10);
      }
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** The one serialization of transcript.json and ceremony.json (hashes are taken over these bytes). */
export const serializeJson = (value) => JSON.stringify(value, null, 2) + "\n";
export const writeJsonAtomic = (path, value) => writeFileAtomic(path, serializeJson(value));
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export function readJsonOr(path, fallback) {
  try {
    return readJson(path);
  } catch {
    return fallback;
  }
}

/** Files of one ceremony directory (docs/CEREMONY.md, "State directory"). */
export function ceremonyPaths(dir) {
  const d = resolve(dir);
  return {
    dir: d,
    ceremony: join(d, "ceremony.json"),
    transcript: join(d, "transcript.json"),
    state: join(d, "state.json"),
    control: join(d, "control.json"),
    zkeys: join(d, "zkeys"),
    zkey: (i) => join(d, "zkeys", zkeyName(i)),
    final: join(d, "final"),
    uploads: join(d, "uploads"),
  };
}

/**
 * sha256 of the transcript as it stood when the contribution phase ended, i.e. with
 * `final` set to null. The manifest carries this hash, and transcript.final carries the
 * manifest's hash, so neither has to contain itself.
 */
export const contributionsTranscriptSha256 = (transcript) => sha256Hex(serializeJson({ ...transcript, final: null }));

/**
 * The close commitment (docs/CEREMONY.md, "The beacon"): what the operator publishes, somewhere
 * independently timestamped, as soon as the queue closes and before the beacon block exists. It
 * fixes the contribution list (index, name, contribution hash, key hashes) and the latest key.
 * -> { contributions, contributionsSha256, latestZkeySha256, commitment }
 */
export function closeCommitmentOf(transcript) {
  const list = (transcript?.contributions ?? []).map((c) => ({ index: c.index, name: c.name, contributionHash: c.contributionHash, zkeySha256: c.zkeySha256, prevZkeySha256: c.prevZkeySha256 }));
  const contributionsSha256 = sha256Hex(serializeJson(list));
  const latestZkeySha256 = list.length ? list.at(-1).zkeySha256 : transcript?.initial?.zkeySha256 ?? null;
  const commitment = sha256Hex(`murkle-ceremony-close/v1\n${transcript?.ceremony}\n${list.length}\n${contributionsSha256}\n${latestZkeySha256}\n`);
  return { contributions: list.length, contributionsSha256, latestZkeySha256, commitment };
}

/** A contributor name: 1..64 printable ASCII characters after trimming, else null. */
export function cleanName(name) {
  if (typeof name !== "string") return null;
  const n = name.trim();
  if (n.length < 1 || n.length > NAME_MAX) return null;
  return /^[\x20-\x7e]+$/.test(n) ? n : null;
}

/** nConstraints from an r1cs header section (iden3 r1cs binary format v1). */
export function r1csConstraints(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "r1cs") throw new Error("not an r1cs file");
  let o = 12;
  for (let i = 0, n = b.readUInt32LE(8); i < n; i++) {
    const type = b.readUInt32LE(o);
    const size = Number(b.readBigUInt64LE(o + 4));
    if (type === 1) {
      const fieldSize = b.readUInt32LE(o + 12);
      return b.readUInt32LE(o + 12 + 4 + fieldSize + 16 + 8);
    }
    o += 12 + size;
  }
  throw new Error("r1cs header not found");
}

/* ------------------------------------------------------------------ zkey contents */

const curves = new Map();
async function curveFor(q) {
  const key = q.toString(16);
  if (!curves.has(key)) curves.set(key, snarkjs.curves.getCurveFromQ(q, { singleThread: true }));
  return curves.get(key);
}

/** Splits an iden3 binary file ("zkey") into its sections: Map(type -> [{ start, size }]). */
function binSections(b, magic) {
  if (b.length < 12 || b.toString("latin1", 0, 4) !== magic) throw new Error(`not a ${magic} file`);
  const sections = new Map();
  let o = 12;
  for (let i = 0, n = b.readUInt32LE(8); i < n; i++) {
    if (o + 12 > b.length) throw new Error(`truncated ${magic} file`);
    const type = b.readUInt32LE(o);
    const size = Number(b.readBigUInt64LE(o + 4));
    if (o + 12 + size > b.length) throw new Error(`truncated ${magic} file`);
    if (!sections.has(type)) sections.set(type, []);
    sections.get(type).push({ start: o + 12, size });
    o += 12 + size;
  }
  return sections;
}

const uniqueSection = (sections, type) => {
  const s = sections.get(type);
  if (!s || s.length !== 1) throw new Error(`zkey section ${type} missing or repeated`);
  return s[0];
};

/**
 * Reads the phase-2 contribution list of a Groth16 zkey and recomputes every
 * contribution hash: blake2b-512 over deltaAfter, g1_s, g1_sx (G1, uncompressed),
 * g2_spx (G2, uncompressed) and the 64-byte transcript, the value snarkjs prints as
 * "Contribution Hash" and returns from `zkey contribute`.
 *
 * bytesOrPath: Uint8Array | path. Throws on any malformed input.
 * -> { csHash: hex, contributions: [{ index, name, type, contributionHash, beaconHash?, numIterationsExp? }] }
 */
export async function readContributions(bytesOrPath) {
  const b = Buffer.from(typeof bytesOrPath === "string" ? readFileSync(bytesOrPath) : bytesOrPath);
  const sections = binSections(b, "zkey");
  const h1 = uniqueSection(sections, 1);
  if (h1.size < 4 || b.readUInt32LE(h1.start) !== 1) throw new Error("zkey is not groth16");
  const h2 = uniqueSection(sections, 2);
  const n8q = b.readUInt32LE(h2.start);
  if (n8q !== 32) throw new Error("unsupported curve");
  let q = 0n;
  for (let i = n8q - 1; i >= 0; i--) q = (q << 8n) | BigInt(b[h2.start + 4 + i]);
  const curve = await curveFor(q);
  const sG1 = curve.G1.F.n8 * 2;
  const sG2 = curve.G2.F.n8 * 2;

  const s10 = uniqueSection(sections, 10);
  const end = s10.start + s10.size;
  let o = s10.start;
  const take = (n) => {
    if (o + n > end) throw new Error("zkey contribution section is truncated");
    const out = new Uint8Array(b.buffer, b.byteOffset + o, n);
    o += n;
    return out;
  };
  const u32 = () => Buffer.from(take(4)).readUInt32LE(0);
  const csHash = toHex(take(64));
  const n = u32();
  if (n > 100000) throw new Error("implausible contribution count");
  const contributions = [];
  for (let i = 0; i < n; i++) {
    const deltaAfter = curve.G1.fromRprLEM(take(sG1), 0);
    const g1s = curve.G1.fromRprLEM(take(sG1), 0);
    const g1sx = curve.G1.fromRprLEM(take(sG1), 0);
    const g2spx = curve.G2.fromRprLEM(take(sG2), 0);
    const transcript = Uint8Array.from(take(64));
    const type = u32();
    const paramLength = u32();
    const pEnd = o + paramLength;
    if (pEnd > end) throw new Error("zkey contribution parameters are truncated");
    const c = { index: i + 1, name: null, type };
    let last = 0;
    while (o < pEnd) {
      const t = take(1)[0];
      if (t <= last) throw new Error("zkey contribution parameters are not sorted");
      last = t;
      if (t === 1) c.name = new TextDecoder().decode(take(take(1)[0]));
      else if (t === 2) c.numIterationsExp = take(1)[0];
      else if (t === 3) c.beaconHash = toHex(take(take(1)[0]));
      else throw new Error("unknown zkey contribution parameter");
    }
    if (o !== pEnd) throw new Error("zkey contribution parameters do not match their length");
    const buf = new Uint8Array(sG1 * 3 + sG2 + 64);
    curve.G1.toRprUncompressed(buf, 0, deltaAfter);
    curve.G1.toRprUncompressed(buf, sG1, g1s);
    curve.G1.toRprUncompressed(buf, sG1 * 2, g1sx);
    curve.G2.toRprUncompressed(buf, sG1 * 3, g2spx);
    buf.set(transcript, sG1 * 3 + sG2);
    c.contributionHash = toHex(blake2b(buf, { dkLen: 64 }));
    contributions.push(c);
  }
  if (o !== end) throw new Error("zkey contribution section has trailing bytes");
  return { csHash, contributions };
}

/* ------------------------------------------------------------------ snarkjs wrappers */

/** Collects snarkjs log lines; errors become the rejection reason. */
function capture() {
  const lines = [];
  const add = (level) => (msg) => lines.push({ level, msg: String(msg) });
  return { lines, logger: { info: add("info"), warn: add("warn"), error: add("error"), debug() {} } };
}

/** The deterministic phase-2 starting key `zkey new <r1cs> <ptau>`, in memory. */
export async function newInitialZkey(r1cs, ptau) {
  const out = { type: "mem" };
  const { lines, logger } = capture();
  const ok = await snarkjs.zKey.newZKey(r1cs, ptau, out, logger);
  if (ok === false || !(out.data instanceof Uint8Array)) {
    throw new Error(`zkey new failed: ${lines.filter((l) => l.level === "error").map((l) => l.msg).join("; ") || "unknown"}`);
  }
  return out.data;
}

const asSnarkFile = (x) => (x instanceof Uint8Array ? { type: "mem", data: x } : x);

/**
 * snarkjs `zkey verifyFromInit`: `zkey` extends `init` by valid contributions only.
 * -> { ok: true } | { ok: false, reason }
 */
export async function verifyFromInit(init, ptau, zkey) {
  const { lines, logger } = capture();
  // snarkjs prints some INVALID lines with console.log instead of its logger: collect them too.
  const log = console.log;
  console.log = (...a) => {
    const s = a.join(" ");
    if (/INVALID/.test(s)) lines.push({ level: "error", msg: s.trim() });
    else log(...a);
  };
  try {
    const ok = await snarkjs.zKey.verifyFromInit(asSnarkFile(init), ptau, asSnarkFile(zkey), logger);
    if (ok === true) return { ok: true };
    const errors = lines.filter((l) => l.level === "error").map((l) => l.msg.replace(/^INVALID(\(\d+\))?:\s*/, ""));
    return { ok: false, reason: `zkey verify failed: ${errors.join("; ") || "a contribution does not verify"}` };
  } catch (e) {
    return { ok: false, reason: `not a valid zkey: ${e?.message ?? e}` };
  } finally {
    console.log = log;
  }
}

/**
 * The checks the coordinator runs on one upload (in a child process, verify-one.mjs):
 * snarkjs verification from the initial key, then the contribution list.
 * -> { ok, reason?, contributions? }
 */
export async function verifyUpload({ init, ptau, zkey }) {
  const v = await verifyFromInit(init, ptau, zkey);
  if (!v.ok) return v;
  try {
    const { contributions } = await readContributions(zkey);
    return { ok: true, contributions };
  } catch (e) {
    return { ok: false, reason: `contribution list unreadable: ${e?.message ?? e}` };
  }
}

/** Stops snarkjs' worker threads so a command can exit. */
export async function terminateCurve() {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
}

/** vkey JSON exactly as `snarkjs zkey export verificationkey` writes it (1-space indent, no newline). */
export async function exportVkeyBytes(zkey) {
  const vkey = await snarkjs.zKey.exportVerificationKey(asSnarkFile(zkey));
  return Buffer.from(JSON.stringify(vkey, null, 1));
}

/* ------------------------------------------------------------------ the beacon block */

const sha256d = (b) => createHash("sha256").update(createHash("sha256").update(b).digest()).digest();
const displayHex = (b) => Buffer.from(b).reverse().toString("hex");

/** Core's SetCompact: { target, negative, overflow }. */
function targetFromBitsLocal(bits) {
  const size = bits >>> 24;
  let word = BigInt(bits & 0x007fffff);
  if (size <= 3) word >>= BigInt(8 * (3 - size));
  const target = size <= 3 ? word : (word << BigInt(8 * (size - 3))) & ((1n << 256n) - 1n);
  const negative = word !== 0n && (bits & 0x00800000) !== 0;
  const overflow = word !== 0n && (size > 34 || (word > 0xffn && size > 33) || (word > 0xffffn && size > 32));
  return { target, negative, overflow };
}

/**
 * Checks a beacon block header: 80 bytes, its double-SHA256 is `hash`, and it carries its
 * own proof of work (hash <= target(nBits), target within the network's powLimit). Uses
 * src/btc/headers.mjs when present (the A-9 header code), else the same two checks here.
 * With `height` and a pinned checkpoint for the network, its target must also be within the
 * difficulty bounds from that checkpoint (src/btc/headers.mjs maxTargetAt): on mainnet a header
 * at difficulty 1 costs about 2^32 hashes, so the own-target check alone proves little.
 * None of this proves the block is in the most-work chain: that is what the second data source
 * and the published hash are for (docs/CEREMONY.md, "The beacon").
 * -> { hash, time, bits, prevHash, checkedBy, bounds }
 */
export async function checkBeaconHeader({ header, hash, network = "mainnet", height = null }) {
  const bytes = Buffer.from(String(header).trim(), "hex");
  if (bytes.length !== 80) throw new Error("beacon header is not 80 bytes");
  const got = displayHex(sha256d(bytes));
  if (got !== String(hash).toLowerCase()) throw new Error(`beacon header hashes to ${got}, not ${hash}`);
  const H = await import("../../src/btc/headers.mjs").catch(() => null);
  if (H && typeof H.decodeHeader === "function" && typeof H.checkPow === "function" && H.RULES?.[network]) {
    const d = H.decodeHeader(bytes);
    if (d.hash !== got) throw new Error("beacon header decode mismatch");
    H.checkPow(d, H.RULES[network]);
    let bounds = null;
    const cp = Number.isSafeInteger(height) && typeof H.nearestCheckpoint === "function" ? H.nearestCheckpoint(network, height) : null;
    if (cp && typeof H.maxTargetAt === "function") {
      if (H.targetFromBits(d.bits).target > H.maxTargetAt(H.RULES[network], cp, height)) {
        throw new Error(`beacon header claims an easier target than any valid ${network} block at ${height} can have (bounds from pinned checkpoint ${cp.height}): it was not mined on ${network}`);
      }
      bounds = cp.height;
    }
    return {
      hash: got, time: d.time, bits: d.bits, prevHash: d.prevHash, bounds,
      checkedBy: bounds === null ? "src/btc/headers.mjs checkPow" : `src/btc/headers.mjs checkPow and the difficulty bounds from pinned checkpoint ${bounds}`,
    };
  }
  const bits = bytes.readUInt32LE(72);
  const { target, negative, overflow } = targetFromBitsLocal(bits);
  if (negative || overflow || target === 0n || target > POW_LIMIT[network]) throw new Error("beacon header has invalid difficulty bits");
  if (BigInt("0x" + got) > target) throw new Error("beacon header does not meet its own proof-of-work target");
  return {
    hash: got,
    time: bytes.readUInt32LE(68),
    bits,
    prevHash: displayHex(bytes.subarray(4, 36)),
    bounds: null,
    checkedBy: "built-in sha256d and target check (src/btc/headers.mjs not available)",
  };
}

/**
 * Opens a Bitcoin data source for the beacon network and checks it serves that network
 * (block 0 must have the known hash).
 *   kind: "esplora" | "bitcoind"; env: process.env-like; esplora: URL override.
 * -> { kind, describe, tipHeight(), blockHash(h), blockHeader(hash) }
 */
export async function openBeaconSource({ kind = "esplora", network = "mainnet", env = process.env, esplora = null } = {}) {
  if (!GENESIS_HASH[network]) throw new Error(`unknown beacon network ${network}`);
  let api;
  let describe;
  if (kind === "esplora") {
    const { Esplora } = await import("../../src/btc/esplora.mjs");
    const url = esplora ?? env.MURKLE_ESPLORA ?? PUBLIC_ESPLORA[network];
    api = new Esplora(url, { retries: 3, retryMs: 500 });
    describe = `esplora ${url}`;
  } else if (kind === "bitcoind") {
    const mod = await import("../../src/btc/bitcoind.mjs").catch(() => null);
    if (!mod?.Bitcoind) throw new Error("the bitcoind source (src/btc/bitcoind.mjs) is not in this build; use --source esplora");
    const url = env.MURKLE_BITCOIND_URL ?? `http://127.0.0.1:${BITCOIND_PORT[network]}`;
    const node = new mod.Bitcoind({
      url,
      cookieFile: env.MURKLE_BITCOIND_COOKIE ?? null,
      user: env.MURKLE_BITCOIND_USER ?? null,
      passwordFile: env.MURKLE_BITCOIND_PASSWORD_FILE ?? null,
    });
    api = typeof node.blockHash === "function" && typeof node.blockHeader === "function" && typeof node.tipHeight === "function"
      ? node
      : {
          tipHeight: () => node.rpc("getblockcount"),
          blockHash: (h) => node.rpc("getblockhash", [h]),
          blockHeader: (hash) => node.rpc("getblockheader", [hash, false]),
        };
    describe = `bitcoind ${url}`;
  } else {
    throw new Error(`unknown source ${kind} (esplora or bitcoind)`);
  }
  const zero = String(await api.blockHash(0)).trim();
  if (zero !== GENESIS_HASH[network]) throw new Error(`${describe} is not Bitcoin ${network}: block 0 is ${zero}`);
  return {
    kind,
    describe,
    tipHeight: async () => Number(await api.tipHeight()),
    blockHash: async (h) => String(await api.blockHash(h)).trim(),
    blockHeader: async (hash) => String(await api.blockHeader(hash)).trim(),
  };
}

/** The checked block at `height` from one source: { hash, header, ...checkBeaconHeader }. */
export async function readBeaconBlock(source, height, network = "mainnet") {
  const hash = await source.blockHash(height);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${source.describe}: bad block hash at ${height}`);
  const header = await source.blockHeader(hash);
  const checked = await checkBeaconHeader({ header, hash, network, height });
  return { height, header, ...checked };
}

/** The snarkjs contribution name of the beacon (at most 64 bytes). */
export const beaconName = (network, height) => `murkle ${network} beacon: Bitcoin block ${height}`;

/* ------------------------------------------------------------------ arguments */

/**
 * Tiny argument parser: `--key value`, `--flag`, `--key=value`; positional words in `_`.
 * spec.flags lists the boolean options.
 */
export function parseArgs(argv, { flags = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (eq > 0) out[key] = a.slice(eq + 1);
    else if (flags.includes(key)) out[key] = true;
    else if (i + 1 < argv.length) out[key] = argv[++i];
    else throw new Error(`${a} needs a value`);
  }
  return out;
}

/** Runs a CLI main: prints the error message (never a stack with secrets) and sets the exit code. */
export async function runMain(main) {
  try {
    const code = await main(process.argv.slice(2));
    await terminateCurve();
    process.exitCode = code ?? 0;
  } catch (e) {
    console.error(`error: ${e?.message ?? e}`);
    await terminateCurve().catch(() => {});
    process.exitCode = 2;
  }
}

export const isMain = (metaUrl) => process.argv[1] && resolve(process.argv[1]) === fileURLToPath(metaUrl);

export function requireFile(path, what) {
  if (!existsSync(path)) throw new Error(`${what} not found: ${path}`);
  return path;
}

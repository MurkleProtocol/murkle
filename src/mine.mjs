// Mining primitives (SPEC.md §15, docs/design/mining.md): the PoW preimage, Argon2id
// (hash-wasm after its self-test, @noble/hashes as the reference), targets, the
// per-block difficulty retarget, rewards, the service-fee output rule and the
// non-consensus launch helpers. Pure and isomorphic: Node, browser main thread
// and Web Workers. No node: imports, no envelope / indexer / snarkjs imports.
import { sha256 } from "@noble/hashes/sha256";
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2";
import { bigToBytes, bytesToBig, concat, equal, hex, u32le, u64le, unhex } from "./bytes.mjs";
import {
  ACTIVATION_HEIGHT, D_MAX, FEE_MIN_SATS, LABELS, MINE_FEE, MINE_SALT_TEXT, MINE_WINDOW,
  MIN_DIFFICULTY, STALE_FACTOR,
} from "./params.mjs";

export const NONCE_LEN = 8;
export const CHALLENGE_LEN = 32;
export const PASSWORD_LEN = CHALLENGE_LEN + NONCE_LEN; // 40
const text = (s) => new TextEncoder().encode(s);
export const MINE_SALT = text(MINE_SALT_TEXT); // 16 bytes
const MINE_TAG = text(LABELS.mine); // 14 bytes
const U64 = (1n << 64n) - 1n;
const MAX_HASH = (1n << 256n) - 1n;

const powError = (message, code) => Object.assign(new Error(message), { code });
const bytesOf = (v, len, what) => {
  const b = typeof v === "string" ? unhex(v) : v instanceof Uint8Array ? v : null;
  if (!b || (len != null && b.length !== len)) throw new TypeError(`${what} must be ${len} bytes`);
  return b;
};

// ---------------------------------------------------------------- preimage (mining.md §4.3)

/**
 * sha256("murkle/mine/v1" ‖ asset u64 LE ‖ refHeight u32 LE ‖ refHash 32 ‖ reward u64 LE ‖ c0 32 BE ‖ c1 32 BE).
 * refHash: the block hash as display hex (64 chars) or its 32 display-order bytes, as the digest uses it.
 */
export function challengeOf({ asset, refHeight, refHash, reward, commitments }) {
  if (!Number.isSafeInteger(refHeight) || refHeight < 0 || refHeight > 0xffffffff) throw new RangeError("refHeight must be a u32");
  if (!Array.isArray(commitments) || commitments.length !== 2) throw new TypeError("two commitments are required");
  return sha256(concat(
    MINE_TAG,
    u64le(BigInt(asset)),
    u32le(refHeight),
    bytesOf(refHash, 32, "refHash"),
    u64le(BigInt(reward)),
    bigToBytes(commitments[0], 32),
    bigToBytes(commitments[1], 32),
  ));
}

/** password = challenge ‖ nonce (40 bytes). */
export function passwordOf(challenge, nonce) {
  return concat(bytesOf(challenge, CHALLENGE_LEN, "challenge"), bytesOf(nonce, NONCE_LEN, "nonce"));
}

/** solutionId = sha256(password): identical for every claim of one solution, however bound or proved. */
export function solutionIdOf(challenge, nonce) {
  return sha256(passwordOf(challenge, nonce));
}

export function claimPreimage({ asset, refHeight, refHash, reward, commitments, nonce }) {
  const challenge = challengeOf({ asset, refHeight, refHash, reward, commitments });
  const password = passwordOf(challenge, nonce);
  const solutionId = sha256(password);
  return { challenge, password, solutionId, solutionIdHex: hex(solutionId) };
}

/** Miners' counter encoding: bigint 0 .. 2^64 - 1 -> 8 bytes u64 LE. Consensus treats the nonce as raw bytes. */
export function nonceOf(counter) {
  const c = BigInt(counter);
  if (c < 0n || c > U64) throw new RangeError("nonce counter must be 0 .. 2^64 - 1");
  return u64le(c);
}
export function counterOf(nonce) {
  const b = bytesOf(nonce, NONCE_LEN, "nonce");
  return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
}

// ---------------------------------------------------------------- Argon2id

const REF_OPTS = { t: 1, m: 4096, p: 1, dkLen: 32 };
const wasmOpts = (password) => ({
  password, salt: MINE_SALT, parallelism: 1, iterations: 1, memorySize: 4096, hashLength: 32, outputType: "binary",
});

/** RFC 9106 §5.3 Argon2id vector. Only the reference can run it: hash-wasm has no associated-data input. */
export const RFC9106_VECTOR = Object.freeze({
  password: "01".repeat(32), salt: "02".repeat(16), secret: "03".repeat(8), ad: "04".repeat(12),
  memoryKiB: 32, passes: 3, lanes: 4, tagLength: 32,
  tag: "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
});

/**
 * Copied from test/fixtures/mine-vectors.json (a core test checks every entry is in it;
 * runtime code never reads test/). The last entry is the RFC 9106 §5.3 inputs without
 * associated data, the variant hash-wasm can compute.
 */
export const SELF_TEST_VECTORS = Object.freeze([
  Object.freeze({
    name: "illustrative",
    password: "f9181c09f98cb253ed91f856cc42eab177a0639e22df4de67f8d5d91761216610000000000000000",
    powHash: "8ce2b336274d4c3a60b8c69f8902776ea6e657318fb1bd8d44edcfad4d44c372",
  }),
  Object.freeze({
    name: "nonce-max",
    password: "f9181c09f98cb253ed91f856cc42eab177a0639e22df4de67f8d5d9176121661ffffffffffffffff",
    powHash: "0d3ff34d5645bb1df6d4299f81f4a376670bc8c8dae0f0d62c30d2dd74324719",
  }),
  Object.freeze({
    name: "mined-256",
    password: "c1ec2639c3f4abd16bdefcd4e325751867739f33f71bdd20b01cf9fc378ff5655700000000000000",
    powHash: "003da0735bbfc81afe99870c99fdfb677f9095122e276ee446fb042aab227223",
  }),
  Object.freeze({
    name: "equality",
    password: "4d4177d7ccb4509b1744838cfaa0dfa129b83dcdf36bec45780b08c9231fc5b10102030405060708",
    powHash: "e22d5f9a9f236ba8bd236d108c6221aed2be98a236eae2298408552e1e902816",
  }),
  Object.freeze({
    name: "rfc9106-no-ad",
    password: "01".repeat(32), salt: "02".repeat(16), secret: "03".repeat(8),
    memoryKiB: 32, passes: 3, lanes: 4, tagLength: 32,
    powHash: "0034de3c8a75efc1148100eaf5ba9b1ce6d50ba5cdf6ae4018c54a4fc03ac10d",
  }),
]);

let wasmModule = null;
async function loadWasm() {
  wasmModule ??= import("hash-wasm").then((m) => (typeof m.argon2id === "function" ? m : m.default));
  return wasmModule;
}
async function wasmArgon2id(opts) {
  const { argon2id } = await loadWasm();
  const out = await argon2id(opts);
  if (!(out instanceof Uint8Array) || out.length !== opts.hashLength) throw new Error("hash-wasm returned a malformed tag");
  return Uint8Array.from(out);
}

// Swappable for tests only (the fast path is disabled by a mismatch, the reference may throw).
const defaultImpls = {
  fast: (password) => wasmArgon2id(wasmOpts(password)),
  fastVector: (v) => wasmArgon2id({
    password: unhex(v.password), salt: unhex(v.salt), secret: unhex(v.secret), parallelism: v.lanes,
    iterations: v.passes, memorySize: v.memoryKiB, hashLength: v.tagLength, outputType: "binary",
  }),
  reference: (password) => nobleArgon2id(password, MINE_SALT, REF_OPTS),
  referenceVector: (v) => nobleArgon2id(unhex(v.password), unhex(v.salt), {
    t: v.passes, m: v.memoryKiB, p: v.lanes, dkLen: v.tagLength, key: unhex(v.secret),
    ...(v.ad ? { personalization: unhex(v.ad) } : {}),
  }),
};
let impls = { ...defaultImpls };
let state = { impl: "hash-wasm", tested: false, disabled: null, referenceOk: null };
let selfTestRun = null;

const vectorTag = (v) => (v.salt ? v.powHash ?? v.tag : v.powHash);

/** The reference (noble) Argon2id of one 40-byte password, synchronous. */
export function powHashReference(password) {
  return Uint8Array.from(impls.reference(bytesOf(password, PASSWORD_LEN, "password")));
}

/**
 * Runs once per process or worker (memoized): hash-wasm over SELF_TEST_VECTORS (a mismatch
 * or a throw disables the fast path), then the reference over the same vectors and the
 * RFC 9106 §5.3 vector. ok: false (impl null) when the reference itself is wrong.
 */
export function selfTest() {
  selfTestRun ??= (async () => {
    let fastOk = false;
    if (!state.disabled) {
      try {
        fastOk = true;
        for (const v of SELF_TEST_VECTORS) {
          const got = v.salt ? await impls.fastVector(v) : await impls.fast(unhex(v.password));
          if (hex(got) !== vectorTag(v)) { fastOk = false; break; }
        }
      } catch {
        fastOk = false;
      }
      if (!fastOk) disableFastPath("self-test failed");
    }
    let refOk = true;
    try {
      for (const v of SELF_TEST_VECTORS) {
        const got = v.salt ? impls.referenceVector(v) : impls.reference(unhex(v.password));
        if (hex(got) !== vectorTag(v)) refOk = false;
      }
      if (hex(impls.referenceVector(RFC9106_VECTOR)) !== RFC9106_VECTOR.tag) refOk = false;
    } catch {
      refOk = false;
    }
    state.tested = true;
    state.referenceOk = refOk;
    if (!refOk) return { ok: false, impl: null };
    return { ok: true, impl: fastOk ? "hash-wasm" : "noble" };
  })();
  return selfTestRun;
}

export function fastPathState() {
  return { impl: state.disabled ? "noble" : "hash-wasm", tested: state.tested, disabled: state.disabled };
}

/** From now on this process / worker uses the reference implementation. */
export function disableFastPath(reason) {
  state.disabled ??= String(reason || "disabled");
}

/**
 * Argon2id(password, MINE_SALT, 4 MiB, t = 1, p = 1, 32 bytes). The fast path is used only
 * after it passed its self-test in this process; a runtime failure disables it and the same
 * password is retried once with the reference. Never returns a substitute value: a failure
 * throws (code POW_SELF_TEST or POW_FAILED), and callers must treat that as an error, never a verdict.
 */
export async function powHash(password) {
  const pw = bytesOf(password, PASSWORD_LEN, "password");
  const st = await selfTest();
  if (!st.ok) throw powError("Argon2 self-test failed", "POW_SELF_TEST");
  if (!state.disabled) {
    try {
      const out = await impls.fast(pw);
      if (!(out instanceof Uint8Array) || out.length !== 32) throw new Error("malformed tag");
      return Uint8Array.from(out);
    } catch (e) {
      disableFastPath(`runtime error: ${e?.message ?? e}`);
    }
  }
  try {
    const out = impls.reference(pw);
    if (!(out instanceof Uint8Array) || out.length !== 32) throw new Error("malformed tag");
    return Uint8Array.from(out);
  } catch (e) {
    throw powError(`Argon2 failed: ${e?.message ?? e}`, "POW_FAILED");
  }
}

/** The in-process PoW backend ({ hash, hashMany }), the Indexer's default. Browser pages use it only inside Web Workers. */
export const inlinePow = Object.freeze({
  hash: powHash,
  async hashMany(passwords) {
    const memo = new Map();
    const out = [];
    for (const p of passwords) {
      const k = hex(bytesOf(p, PASSWORD_LEN, "password"));
      if (!memo.has(k)) memo.set(k, await powHash(p));
      out.push(memo.get(k));
    }
    return out;
  },
});

/** Test hooks: swap implementations and reset the memoized self-test. Not for production code. */
export const __testing = Object.freeze({
  setImpls(next = {}) { impls = { ...defaultImpls, ...next }; },
  reset() {
    impls = { ...defaultImpls };
    state = { impl: "hash-wasm", tested: false, disabled: null, referenceOk: null };
    selfTestRun = null;
  },
  resetSelfTest() {
    state = { impl: "hash-wasm", tested: false, disabled: null, referenceOk: null };
    selfTestRun = null;
  },
});

// ---------------------------------------------------------------- targets

/** floor((2^256 - 1) / D); RangeError unless 1 <= D <= D_MAX. */
export function targetOf(D) {
  const d = BigInt(D);
  if (d < 1n || d > D_MAX) throw new RangeError(`difficulty must be 1 .. ${D_MAX}`);
  return MAX_HASH / d;
}
export const targetHex = (D) => targetOf(D).toString(16).padStart(64, "0");
const asTarget = (t) => (typeof t === "string" ? BigInt("0x" + t) : BigInt(t));

/** int_BE(hash) <= target (equality is valid). */
export function meetsTarget(hash, target) {
  return bytesToBig(bytesOf(hash, 32, "hash")) <= asTarget(target);
}

/**
 * Tries nonces nonceStart, nonceStart + 1, … (mod 2^64, counter encoding), `count` of them.
 * nonceStart: 8 bytes or a bigint counter. -> { nonce, powHash, tried } (nonce null when none met the target).
 */
export async function grindRange({ challenge, target, nonceStart = 0n, count, hash = powHash }) {
  const ch = bytesOf(challenge, CHALLENGE_LEN, "challenge");
  const t = asTarget(target);
  let c = nonceStart instanceof Uint8Array || typeof nonceStart === "string" ? counterOf(nonceStart) : BigInt(nonceStart);
  const n = Number(count);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("count must be a whole number");
  for (let i = 0; i < n; i++) {
    const nonce = nonceOf(c);
    const h = await hash(passwordOf(ch, nonce));
    if (bytesToBig(h) <= t) return { nonce, powHash: h, tried: i + 1 };
    c = (c + 1n) & U64;
  }
  return { nonce: null, powHash: null, tried: n };
}

// ---------------------------------------------------------------- terms, reward, difficulty

const big = (v) => BigInt(v);
const minB = (a, b) => (a < b ? a : b);
const maxB = (a, b) => (a > b ? a : b);

/**
 * max(startHeight, deployHeight): the first block a claim may reference. startHeight 0 (or any
 * height at or below the deploy block) opens mining at the deploy block itself, whose hash nobody
 * knows before it is mined; a later startHeight delays it. No reference before the deploy block.
 */
export function mineStartOf(asset) {
  return Math.max(asset.startHeight ?? 0, asset.deployHeight);
}
const startOf = (asset) => asset.mineStart ?? mineStartOf(asset);

/** reward(ref): halvingInterval 0 -> reward; else reward >> floor((ref - mineStart) / interval), 0n once the shift reaches 63. */
export function rewardAt(asset, ref) {
  const reward = big(asset.reward);
  const hi = asset.halvingInterval ?? 0;
  if (!hi) return reward;
  const s = Math.max(0, Math.floor((ref - startOf(asset)) / hi));
  return s >= 63 ? 0n : reward >> BigInt(s);
}

/** Height of the next halving after `tip`, or null (no halving, or the reward is already 0). */
export function nextHalving(asset, tip) {
  const hi = asset.halvingInterval ?? 0;
  if (!hi || rewardAt(asset, tip) === 0n) return null;
  const ms = startOf(asset);
  const s = Math.max(0, Math.floor((tip - ms) / hi));
  return ms + (s + 1) * hi;
}

/** min(D_MAX, max(minDifficulty, floor((prev·(span-1)·S + work·span) / (span·S)))), all BigInt. */
export function stepDifficulty(prev, work, { span, targetPerSpan, minDifficulty }) {
  const t = big(span);
  const S = big(targetPerSpan);
  const next = (big(prev) * (t - 1n) * S + big(work) * t) / (t * S);
  return minB(D_MAX, maxB(big(minDifficulty), next));
}

/**
 * D(h) from asset.dPts ([[height, D]] ascending, starting at [mineStart, initialDifficulty]):
 * the w = 0 step iterated from the newest point at or below h, stopping at minDifficulty.
 * initialDifficulty for h <= mineStart.
 */
export function difficultyAt(asset, h) {
  const ms = startOf(asset);
  if (h <= ms) return big(asset.initialDifficulty);
  const pts = asset.dPts;
  let i = pts.length - 1;
  while (i >= 0 && pts[i][0] > h) i--;
  if (i < 0) throw new RangeError(`difficulty at ${h} is older than the retained points`);
  return decayFrom(pts[i], h, asset);
}

// Memo of the w = 0 decay (difficultyAt): per dPts point (the [height, D] pair itself, so a new
// point or a restored copy starts afresh and a reverted one is dropped with it), the values
// already computed at later heights. The decay from a point can take ~16,000 BigInt steps (span
// 432, D_MAX down to the floor), and every claim in a block asks for the same few heights.
// Pure: the value is exactly the loop's; a cached height only saves the steps below it.
const DECAY_MEMO = new WeakMap(); // point -> { sig, at: Map<height, D> }
const DECAY_MEMO_MAX = 64;

function decayFrom(point, h, asset) {
  const floor = big(asset.minDifficulty);
  const terms = { span: asset.span, targetPerSpan: asset.targetPerSpan, minDifficulty: floor };
  const sig = `${asset.span}:${asset.targetPerSpan}:${floor}:${point[1]}`;
  let memo = DECAY_MEMO.get(point);
  if (!memo || memo.sig !== sig) {
    memo = { sig, at: new Map() };
    DECAY_MEMO.set(point, memo);
  }
  const hit = memo.at.get(h);
  if (hit !== undefined) return hit;
  let x = point[0];
  let d = big(point[1]);
  for (const [ch, cd] of memo.at) if (ch < h && ch > x) [x, d] = [ch, cd]; // resume from the nearest height below h
  for (x += 1; x <= h && d > floor; x++) d = stepDifficulty(d, 0n, terms);
  if (memo.at.size >= DECAY_MEMO_MAX) memo.at.delete(memo.at.keys().next().value);
  memo.at.set(h, d);
  return d;
}

/** D_eff = max(D(refHeight), floor(D(height - 1) / STALE_FACTOR)), height = the inclusion height. */
export function effectiveDifficulty(asset, refHeight, height) {
  return maxB(difficultyAt(asset, refHeight), difficultyAt(asset, height - 1) / BigInt(STALE_FACTOR));
}

/** "mining-soon" | "mining-ended" | "mined-out" | "mining" at tip (not consensus; the API and pages). */
export function mineStatus(asset, tip) {
  if (tip < startOf(asset)) return "mining-soon";
  if ((asset.endHeight !== 0 && tip > asset.endHeight) || rewardAt(asset, tip) === 0n) return "mining-ended";
  if (big(asset.issued ?? 0n) + rewardAt(asset, tip) > big(asset.maxSupply)) return "mined-out";
  return "mining";
}

// ---------------------------------------------------------------- service fee (mining.md §7)

const scriptBytes = (s) => (typeof s === "string" ? unhex(s) : Uint8Array.from(s));

/** "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr" | null, exact templates only. */
export function isStandardScript(script) {
  const s = scriptBytes(script);
  if (s.length === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac) return "p2pkh";
  if (s.length === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return "p2sh";
  if (s.length === 22 && s[0] === 0x00 && s[1] === 0x14) return "p2wpkh";
  if (s.length === 34 && s[0] === 0x00 && s[1] === 0x20) return "p2wsh";
  if (s.length === 34 && s[0] === 0x51 && s[1] === 0x20) return "p2tr";
  return null;
}

/** Bitcoin Core's dust limit (3 sat/vB relay fee) for a standard script, or null. */
export function dustLimit(script) {
  return { p2pkh: 546n, p2sh: 540n, p2wpkh: 294n, p2wsh: 330n, p2tr: 330n }[isStandardScript(script)] ?? null;
}

/**
 * The outputs a claim's carrier must pay: [treasury, claimFeeSats] when claimFeeSats > 0, then
 * [platformScript, platformSats] when platformSats > 0; grouped by script in order of first
 * appearance, amounts summed (role "both" when the deployer's treasury is the platform script).
 */
export function requiredFeeOutputs(asset, fee = MINE_FEE) {
  const groups = [];
  const add = (script, sats, role) => {
    const s = scriptBytes(script);
    const g = groups.find((x) => equal(x.script, s));
    if (g) {
      g.sats += sats;
      if (g.role !== role) g.role = "both";
    } else groups.push({ script: s, sats, role });
  };
  const claimFee = big(asset.claimFeeSats ?? 0n);
  if (claimFee > 0n) add(asset.treasury, claimFee, "deployer");
  if (fee && big(fee.platformSats) > 0n) add(fee.platformScript, big(fee.platformSats), "platform");
  return groups;
}

/**
 * Whether tx ({ outputs: [{ script, value }] }) pays every required fee group: per script, the gross
 * sum of the outputs paying it must reach the amount. paid = gross sats to every required script
 * (counted as treasuryPaid counts MINT payments); short = [{ script (hex), need, paid }].
 */
export function feeOutputsPaid(asset, tx, fee = MINE_FEE) {
  let paid = 0n;
  const short = [];
  for (const g of requiredFeeOutputs(asset, fee)) {
    const got = (tx.outputs ?? []).filter((o) => equal(scriptBytes(o.script), g.script)).reduce((s, o) => s + BigInt(o.value), 0n);
    paid += got;
    if (got < g.sats) short.push({ script: hex(g.script), need: g.sats, paid: got });
  }
  return { ok: short.length === 0, paid, short };
}

/** The DEPLOY_POW claim-fee policy under `fee` (indexer rule): null, or a `malformed: …` reason. */
export function checkFeePolicy(claimFeeSats, treasury, fee = MINE_FEE) {
  const c = big(claimFeeSats ?? 0n);
  const min = big(fee?.deployerMinSats ?? 0n);
  const max = big(fee?.deployerMaxSats ?? 0n);
  if (max === 0n) return c === 0n ? null : "malformed: deployer claim fee not allowed";
  if (min > 0n) {
    if (c < min || c > max) return `malformed: claim fee ${c} outside ${min}..${max}`;
  } else if (c !== 0n) {
    if (c < FEE_MIN_SATS) return `malformed: claim fee below ${FEE_MIN_SATS} sats`;
    if (c > max) return `malformed: claim fee ${c} outside ${FEE_MIN_SATS}..${max}`;
  }
  if (c > 0n && !isStandardScript(treasury ?? new Uint8Array())) return "malformed: treasury is not a standard script";
  return null;
}

/** Throws unless a MINE_FEE constant set is usable as consensus (platform script standard, amount >= its dust limit). */
export function assertMineFee(fee) {
  if (!fee) throw new Error("mining activation needs MINE_FEE for this network");
  const sats = big(fee.platformSats);
  if (sats < 0n || big(fee.deployerMinSats) < 0n || big(fee.deployerMaxSats) < big(fee.deployerMinSats)) throw new Error("MINE_FEE amounts are invalid");
  if (sats > 0n) {
    if (!isStandardScript(fee.platformScript)) throw new Error("MINE_FEE platformScript is not a standard script");
    if (sats < dustLimit(fee.platformScript)) throw new Error("MINE_FEE platformSats is below the dust limit of its script");
  }
  if (big(fee.deployerMinSats) > 0n && big(fee.deployerMinSats) < FEE_MIN_SATS) throw new Error(`MINE_FEE deployerMinSats is below ${FEE_MIN_SATS}`);
  return true;
}

/**
 * Throws unless the activation table is valid: names unique; digestV 2, 3, … in table order;
 * heights null or integers above the genesis activation height; non-null heights non-decreasing.
 */
export function assertActivations(activations, { genesisHeight = ACTIVATION_HEIGHT } = {}) {
  if (!Array.isArray(activations)) throw new Error("activations must be a list");
  const names = new Set();
  let last = -Infinity;
  activations.forEach((a, i) => {
    if (!a || typeof a.name !== "string" || !a.name) throw new Error(`activation ${i} has no name`);
    if (names.has(a.name)) throw new Error(`activation ${a.name} is listed twice`);
    names.add(a.name);
    if (a.digestV !== i + 2) throw new Error(`activation ${a.name} must have digestV ${i + 2}`);
    if (a.height === null) return;
    if (!Number.isSafeInteger(a.height) || a.height < 0) throw new Error(`activation ${a.name} height must be an integer or null`);
    if (genesisHeight != null && a.height <= genesisHeight) throw new Error(`activation ${a.name} must be above the genesis height ${genesisHeight}`);
    if (a.height < last) throw new Error(`activation ${a.name} is below an earlier version's height`);
    last = a.height;
  });
  return true;
}

// ---------------------------------------------------------------- non-consensus helpers

export const LAUNCH_DEFAULTS = Object.freeze({
  span: 24, perBlock: 1, // S = perBlock * span
  launchHashrate: 2000, // H/s, "a few browsers": the form's default expected launch hashrate
  floorDivisor: 16, // floor = initial / 16, never below MIN_DIFFICULTY
  browserThreadHs: 250, // one hash-wasm browser thread (mining.md §4.4)
  lowFloorRatio: 1000, // explorer flag
  halvingInterval: 0, claimFeeSats: 0n,
  start: "now", startAfter: 144, // the launch form: "Start mining now", or this many blocks after the next one
});

/**
 * The startHeight a launch encodes for its start choice (not consensus; the form and the CLI).
 * "now" -> 0: mining opens at the deploy block. "after" -> tip + 1 + after: the launch lands in
 * block tip + 1 at the earliest, so mining opens `after` blocks after it; the field is absolute,
 * so a launch that confirms later keeps the same start block (a shorter delay), and one that
 * confirms at or after it starts mining at its own block. Throws on a bad count or an unknown tip.
 */
export function startHeightFor({ start = "now", after = 0, tip = null }) {
  if (start === "now") return 0;
  if (start !== "after") throw new Error('start must be "now" or "after"');
  if (!Number.isSafeInteger(after) || after < 1) throw new Error("the delay is a whole number of blocks, at least 1");
  if (!Number.isSafeInteger(tip) || tip < 0) throw new Error("the current block height is not known yet");
  const h = tip + 1 + after;
  if (h > 0xffffffff) throw new Error("the start block is past 4294967295");
  return h;
}

/** max(MIN_DIFFICULTY, floor(hashrate · 600 · span / targetPerSpan)), capped at D_MAX. */
export function suggestInitialDifficulty({ hashrate, span, targetPerSpan }) {
  const v = Math.floor((Number(hashrate) * 600 * Number(span)) / Number(targetPerSpan));
  if (!Number.isFinite(v) || v <= 0) return MIN_DIFFICULTY;
  const d = v >= Number(D_MAX) ? D_MAX : BigInt(v);
  return minB(D_MAX, maxB(MIN_DIFFICULTY, d));
}

/** max(MIN_DIFFICULTY, initial / 16). */
export function suggestFloor(initialDifficulty) {
  return maxB(MIN_DIFFICULTY, big(initialDifficulty) / BigInt(LAUNCH_DEFAULTS.floorDivisor));
}

const isClaimEntry = (e) => e.ok && (e.op === 7 || e.op === 8);

/** Σ D_eff of accepted claims with height > tip - 144, per second of 144 blocks (86,400 s). An estimate. */
export function hashrateEstimate(entries, tip) {
  let work = 0n;
  for (const e of entries) if (isClaimEntry(e) && e.height > tip - 144 && e.difficulty != null) work += BigInt(e.difficulty);
  return Number(work) / 86400;
}

/** [[h, D(h)]] for from <= h <= to, recomputed from the accepted claims in the log (a chart, not consensus). */
export function difficultySeries(asset, entries, { from, to }) {
  const id = String(asset.id);
  const ms = startOf(asset);
  const work = new Map();
  for (const e of entries) {
    if (!isClaimEntry(e) || String(e.asset) !== id || e.difficulty == null) continue;
    work.set(e.height, (work.get(e.height) ?? 0n) + BigInt(e.difficulty));
  }
  const terms = { span: asset.span, targetPerSpan: asset.targetPerSpan, minDifficulty: asset.minDifficulty };
  const out = [];
  let d = big(asset.initialDifficulty);
  for (let h = Math.min(ms, to); h <= to; h++) {
    if (h > ms) d = stepDifficulty(d, work.get(h) ?? 0n, terms);
    if (h >= from) out.push([h, d]);
  }
  return out;
}

/** Expected claims per block at the floor difficulty for `hashrate` (H/s), capped at block space (1,700). */
export function floorEmission(asset, hashrate) {
  return Math.min(1700, (Number(hashrate) * 600) / Number(asset.minDifficulty));
}

/** The explorer's "Low floor" flag: floor or initial difficulty under 1/1,000 of an honest launch at this hashrate. */
export function lowFloor(asset, hashrate) {
  const shape = { span: asset.span, targetPerSpan: asset.targetPerSpan };
  const a = suggestInitialDifficulty({ hashrate, ...shape });
  const b = suggestInitialDifficulty({ hashrate: LAUNCH_DEFAULTS.browserThreadHs, ...shape });
  const ref = maxB(a, b);
  const k = BigInt(LAUNCH_DEFAULTS.lowFloorRatio);
  return big(asset.minDifficulty) * k < ref || big(asset.initialDifficulty) * k < ref;
}

export { MINE_WINDOW, STALE_FACTOR, MIN_DIFFICULTY, D_MAX };

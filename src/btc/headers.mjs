// Bitcoin block header verification (audit A-9). Isomorphic: Node, browsers and workers.
//
// Verifies, from the 80-byte headers actually fetched, what Bitcoin Core checks for a header
// (CheckBlockHeader + ContextualCheckBlockHeader): linkage to the header below, proof of work
// against nBits (DeriveTarget / CheckProofOfWork), the difficulty rule (GetNextWorkRequired /
// CalculateNextWorkRequired, exact 256-bit arithmetic and GetCompact re-encoding), the
// median-time-past and future-time limits, the BIP34/66/65 version floors and pinned
// checkpoints, starting from a pinned base checkpoint. Among the branches a data source
// serves, it keeps the one with the most cumulative work (first seen on a tie, as Core).
//
// What it cannot do: a single data source can still withhold blocks or a better chain. On
// signet a block is valid because of the signet operator's signature (BIP325), which is NOT
// checked here, and signet proof of work is nearly free.
//
// Contract: docs/design/mainnet-readiness.md §3.
import { sha256 } from "@noble/hashes/sha256";
import { hex, unhex } from "../bytes.mjs";
import * as P from "../params.mjs";
import CHECKPOINTS_JSON from "./checkpoints.json" with { type: "json" };

const NETWORK = P.NETWORK ?? "signet";
const dsha = (b) => sha256(sha256(b));
const rev = (b) => Uint8Array.from(b).reverse();
const HASH = /^[0-9a-f]{64}$/;
const MASK256 = (1n << 256n) - 1n;

export const RULES = Object.freeze({
  mainnet: Object.freeze({
    network: "mainnet",
    powLimit: 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffn,
    interval: 2016,
    targetTimespan: 1209600,
    targetSpacing: 600,
    retarget: true,
    versionFloor: Object.freeze([[227931, 2], [363725, 3], [388381, 4]]),
    maxFutureSecs: 7200,
    validity: "pow",
  }),
  signet: Object.freeze({
    network: "signet",
    powLimit: 0x00000377ae000000000000000000000000000000000000000000000000000000n,
    interval: 2016,
    targetTimespan: 1209600,
    targetSpacing: 600,
    retarget: true,
    versionFloor: Object.freeze([[1, 4]]),
    maxFutureSecs: 7200,
    validity: "pow+signet-signature-unchecked",
  }),
});

/** The parsed src/btc/checkpoints.json: { signet: Checkpoint[], mainnet: Checkpoint[] }. */
export const CHECKPOINTS = Object.freeze(
  Object.fromEntries(Object.entries(CHECKPOINTS_JSON).filter(([k]) => Array.isArray(CHECKPOINTS_JSON[k])).map(([k, list]) => [k, Object.freeze(list.map((c) => Object.freeze({ ...c })))])),
);

export class HeaderError extends Error {
  /**
   * code: "data" | "linkage" | "pow" | "bits-range" | "bad-diffbits" | "time-too-old" | "time-too-new"
   *       | "bad-version" | "checkpoint" | "conflict" | "less-work" | "below-base" | "source"
   * retryable: the same data may pass later (a header too far in the future, a source failure).
   */
  constructor(code, message, { height = null, retryable = false } = {}) {
    super(message);
    this.name = "HeaderError";
    this.code = code;
    this.height = height;
    this.retryable = retryable;
  }
}

const at = (height) => (Number.isInteger(height) ? ` at #${height}` : "");

/* ------------------------------------------------------------------ encoding */

/** 80 bytes (Uint8Array or hex) -> header fields; throws HeaderError("data") on anything else. */
export function decodeHeader(bytesOrHex) {
  let b;
  if (typeof bytesOrHex === "string") {
    const s = bytesOrHex.trim();
    if (!/^[0-9a-fA-F]{160}$/.test(s)) throw new HeaderError("data", `a block header is 80 bytes (160 hex characters), got ${s.length} characters`);
    b = unhex(s.toLowerCase());
  } else if (bytesOrHex instanceof Uint8Array) {
    if (bytesOrHex.length !== 80) throw new HeaderError("data", `a block header is 80 bytes, got ${bytesOrHex.length}`);
    b = Uint8Array.from(bytesOrHex);
  } else {
    throw new HeaderError("data", "a block header must be bytes or hex");
  }
  const v = new DataView(b.buffer, b.byteOffset, 80);
  return {
    bytes: b,
    hash: hex(rev(dsha(b))),
    prevHash: hex(rev(b.subarray(4, 36))),
    merkleRoot: hex(rev(b.subarray(36, 68))),
    version: v.getInt32(0, true),
    time: v.getUint32(68, true),
    bits: v.getUint32(72, true),
    nonce: v.getUint32(76, true),
  };
}

/**
 * Builds the 80-byte header from its fields (display-order hashes, as explorers show them),
 * e.g. an Esplora block JSON. The caller compares the result's hash with the claimed id.
 */
export function encodeHeader({ version, prevHash, merkleRoot, time, bits, nonce }) {
  const b = new Uint8Array(80);
  const v = new DataView(b.buffer);
  const u32 = (name, x) => {
    if (!Number.isInteger(x) || x < 0 || x > 0xffffffff) throw new HeaderError("data", `header field ${name} is not a 32-bit unsigned integer`);
    return x;
  };
  if (!Number.isInteger(version) || version < -0x80000000 || version > 0xffffffff) throw new HeaderError("data", "header field version is not a 32-bit integer");
  v.setUint32(0, version >>> 0, true);
  const prev = prevHash == null ? "0".repeat(64) : String(prevHash).toLowerCase();
  const root = String(merkleRoot ?? "").toLowerCase();
  if (!HASH.test(prev) || !HASH.test(root)) throw new HeaderError("data", "header hashes must be 64 hexadecimal characters");
  b.set(rev(unhex(prev)), 4);
  b.set(rev(unhex(root)), 36);
  v.setUint32(68, u32("time", time), true);
  v.setUint32(72, u32("bits", bits), true);
  v.setUint32(76, u32("nonce", nonce), true);
  return b;
}

/* ------------------------------------------------------------- compact bits */

/** Core's arith_uint256::SetCompact: { target, negative, overflow } (target truncated to 256 bits). */
export function targetFromBits(bits) {
  const n = Number(bits) >>> 0;
  const size = n >>> 24;
  let word = n & 0x007fffff;
  let target;
  if (size <= 3) {
    word >>>= 8 * (3 - size);
    target = BigInt(word);
  } else {
    target = (BigInt(word) << BigInt(8 * (size - 3))) & MASK256;
  }
  const negative = word !== 0 && (n & 0x00800000) !== 0;
  const overflow = word !== 0 && (size > 34 || (word > 0xff && size > 33) || (word > 0xffff && size > 32));
  return { target, negative, overflow };
}

/** Core's arith_uint256::GetCompact (never sets the sign bit). */
export function bitsFromTarget(target) {
  let t = BigInt(target);
  if (t < 0n) throw new RangeError("a target is never negative");
  t &= MASK256;
  let size = t === 0n ? 0 : Math.ceil(t.toString(2).length / 8);
  let compact;
  if (size <= 3) compact = Number(t << BigInt(8 * (3 - size)));
  else compact = Number((t >> BigInt(8 * (size - 3))) & 0xffffffffn);
  // The 0x00800000 bit is the sign: if it is set, divide the mantissa by 256 and grow the exponent.
  if (compact & 0x00800000) {
    compact >>>= 8;
    size += 1;
  }
  return ((compact | (size << 24)) >>> 0);
}

/** Core's GetBlockProof: 2^256 / (target + 1); 0n for a negative, overflowing or zero target. */
export function workOf(bits) {
  const { target, negative, overflow } = targetFromBits(bits);
  if (negative || overflow || target === 0n) return 0n;
  return (1n << 256n) / (target + 1n);
}

/** Median of up to 11 timestamps, as Core's GetMedianTimePast (sorted, the middle element). */
export function medianTimePast(times) {
  const s = [...times].map(Number).sort((a, b) => a - b);
  if (!s.length) throw new HeaderError("data", "no timestamps for the median time past");
  return s[Math.floor(s.length / 2)];
}

/**
 * The nBits a header at `height` must carry (GetNextWorkRequired without min-difficulty
 * blocks: neither mainnet nor signet allows them). firstTime is the time of the header at
 * height - interval; it is read only at a retarget boundary.
 */
export function nextBits(rules, { height, prevBits, prevTime, firstTime }) {
  if (!rules.retarget || height % rules.interval !== 0) return Number(prevBits) >>> 0;
  if (!Number.isFinite(firstTime) || !Number.isFinite(prevTime)) throw new HeaderError("data", `retarget${at(height)} needs the time of the period's first header`, { height });
  let span = prevTime - firstTime;
  const min = Math.floor(rules.targetTimespan / 4);
  const max = rules.targetTimespan * 4;
  if (span < min) span = min;
  if (span > max) span = max;
  // Core: bnNew.SetCompact(prev); bnNew *= span (mod 2^256); bnNew /= timespan; cap at powLimit.
  let t = targetFromBits(prevBits).target;
  t = (t * BigInt(span)) & MASK256;
  t /= BigInt(rules.targetTimespan);
  if (t > rules.powLimit) t = rules.powLimit;
  return bitsFromTarget(t);
}

/** Throws HeaderError("bits-range" | "pow") unless the header meets CheckProofOfWork. */
export function checkPow(header, rules) {
  const h = header instanceof Uint8Array || typeof header === "string" ? decodeHeader(header) : header;
  const { target, negative, overflow } = targetFromBits(h.bits);
  if (negative || overflow || target === 0n || target > rules.powLimit) {
    throw new HeaderError("bits-range", `nBits 0x${(h.bits >>> 0).toString(16).padStart(8, "0")} is not a valid target for ${rules.network}`);
  }
  if (BigInt("0x" + h.hash) > target) throw new HeaderError("pow", `block ${h.hash} does not meet its own target`);
}

/** Smallest nVersion allowed at `height` (BIP34/66/65 floors), 0 below all of them. */
export function versionFloorAt(rules, height) {
  let floor = 0;
  for (const [h, v] of rules.versionFloor) if (height >= h && v > floor) floor = v;
  return floor;
}

/**
 * The easiest target any valid header at `height` can have, given a pinned checkpoint with
 * its bits: min(powLimit, target(checkpoint bits) * 4^ceil(|height - checkpoint.height| / interval)).
 * A retarget changes the target by at most a factor 4, once per interval. Going back from the
 * checkpoint, each step also allows for GetCompact's truncation: Core re-encodes floor(t / 4)
 * with a 3-byte mantissa, so the new target can be slightly below a quarter of the old one and
 * the old one slightly above 4 times the new (by less than 2^-15 of it, plus rounding).
 */
export function maxTargetAt(rules, checkpoint, height) {
  const bits = checkpoint?.base?.bits ?? checkpoint?.bits;
  if (!Number.isInteger(bits)) throw new HeaderError("data", "the checkpoint carries no bits");
  const steps = Math.ceil(Math.abs(height - checkpoint.height) / rules.interval);
  const back = height < checkpoint.height;
  let t = targetFromBits(bits).target;
  for (let i = 0; i < steps && t < rules.powLimit; i++) t = back ? t * 4n + (t >> 13n) + 4n : t * 4n;
  return t > rules.powLimit ? rules.powLimit : t;
}

/**
 * The smallest target a valid retarget can give after a period whose target was `prev`: Core
 * clamps the timespan to targetTimespan / 4, computes prev * span / targetTimespan on 256 bits and
 * re-encodes it with GetCompact, which can truncate it below prev / 4.
 */
export function minRetargetTarget(rules, prev) {
  const span = BigInt(Math.floor(rules.targetTimespan / 4));
  const t = ((BigInt(prev) * span) & MASK256) / BigInt(rules.targetTimespan);
  return targetFromBits(bitsFromTarget(t)).target;
}

/** Expected hashes to find a header whose target is `target` (Core's GetBlockProof for a raw target). */
export function workOfTarget(target) {
  const t = BigInt(target);
  return t < 0n ? 0n : (1n << 256n) / (t + 1n);
}

/**
 * The highest height an honest chain from `checkpoint` can plausibly have reached at unix time
 * `now`: one block per targetSpacing from the checkpoint's time to now + maxFutureSecs, 25%
 * faster than that (hash rate growth between retargets), plus one retarget period of slack.
 */
export function maxPlausibleHeight(rules, checkpoint, now) {
  const time = checkpoint?.base?.time;
  if (!Number.isInteger(time) || !Number.isFinite(now)) return Infinity;
  const secs = Math.max(0, now + rules.maxFutureSecs - time);
  return checkpoint.height + Math.ceil((secs / rules.targetSpacing) * 1.25) + rules.interval;
}

/** Base-capable checkpoints of a list, ascending by height. */
const basesOf = (list) => (list ?? []).filter((c) => c && c.base).sort((a, b) => a.height - b.height);

function checkBase(cp, rules) {
  const b = cp?.base;
  if (!cp || !Number.isInteger(cp.height) || cp.height < 0 || !HASH.test(String(cp.hash))) throw new HeaderError("data", "a checkpoint needs an integer height and a 64-hex hash");
  if (!b || !Number.isInteger(b.bits) || !Number.isInteger(b.time) || !Number.isInteger(b.periodStartTime) || !Array.isArray(b.prevTimes)) {
    throw new HeaderError("data", `checkpoint #${cp.height} cannot start a header chain (no base context)`);
  }
  if (!b.prevTimes.every(Number.isInteger) || b.prevTimes.length > 10) throw new HeaderError("data", `checkpoint #${cp.height}: prevTimes must be at most 10 integer timestamps`);
  if (cp.height % rules.interval === 0 && b.periodStartTime !== b.time) throw new HeaderError("data", `checkpoint #${cp.height} is a retarget boundary, so its periodStartTime must equal its time`);
}

/* -------------------------------------------------------------- HeaderChain */

/**
 * A verified header chain from a pinned base checkpoint. Entries hold heights from `from`
 * (the base, until the window slides) to the tip; timestamps and period start times the next
 * checks need are kept as context when the window slides.
 */
export class HeaderChain {
  constructor({
    network = NETWORK,
    rules = RULES[network],
    checkpoints = CHECKPOINTS[network],
    base = null,
    startHeight = null,
    now = () => Math.floor(Date.now() / 1000),
    keep = 2400,
  } = {}) {
    if (!rules) throw new HeaderError("data", `no header rules for network ${network}`);
    this._network = network;
    this.rules = rules;
    this.checkpoints = Object.freeze([...(checkpoints ?? [])]);
    this._cp = new Map(this.checkpoints.map((c) => [c.height, String(c.hash).toLowerCase()]));
    this.now = now;
    this.keep = Math.max(keep, rules.interval + 11 + 144);
    let b = base;
    if (!b) {
      const bases = basesOf(this.checkpoints);
      if (!bases.length) throw new HeaderError("below-base", `no base checkpoint for ${network}`);
      if (startHeight == null) b = bases.at(-1);
      else b = [...bases].reverse().find((c) => c.height <= startHeight) ?? bases[0]; // below every base: blocks under it are not header-checked
    }
    checkBase(b, rules);
    if (this._cp.has(b.height) && this._cp.get(b.height) !== String(b.hash).toLowerCase()) throw new HeaderError("checkpoint", `base #${b.height} contradicts the checkpoint list`);
    this._base = Object.freeze({ ...b, hash: String(b.hash).toLowerCase() });
    this._reset();
    this._lastError = null;
  }

  _reset() {
    const b = this._base;
    this._e = [{ height: b.height, hash: b.hash, prevHash: null, time: b.base.time, bits: b.base.bits, version: null, bytes: null, cw: 0n }];
    this._prevTimes = [...b.base.prevTimes];
    this._bounds = new Map([[b.height - (b.height % this.rules.interval), b.base.periodStartTime]]);
  }

  /** Highest base-capable checkpoint at or below `height`; throws HeaderError("below-base"). */
  static baseFor(network, height, checkpoints = CHECKPOINTS[network]) {
    const found = [...basesOf(checkpoints)].reverse().find((c) => c.height <= height);
    if (!found) throw new HeaderError("below-base", `no ${network} base checkpoint at or below #${height}`, { height });
    return found;
  }

  get network() { return this._network; }
  get base() { return { height: this._base.height, hash: this._base.hash }; }
  get baseCheckpoint() { return this._base; }
  get height() { return this._e.at(-1).height; }
  get hash() { return this._e.at(-1).hash; }
  get work() { return this._e.at(-1).cw; }
  /** First height held (the base until the window slides). */
  get from() { return this._e[0].height; }
  get lastError() { return this._lastError; }

  _entry(height) {
    const i = height - this._e[0].height;
    return i >= 0 && i < this._e.length ? this._e[i] : null;
  }
  has(height) { return this._entry(height) !== null; }
  hashAt(height) { return this._entry(height)?.hash ?? null; }
  /** Cumulative work from the base (exclusive) up to `height`, or null when not held. */
  workAt(height) { return this._entry(height)?.cw ?? null; }
  timeAt(height) {
    const e = this._entry(height);
    if (e) return e.time;
    const first = this._e[0].height;
    const k = height - (first - this._prevTimes.length);
    if (height < first && k >= 0) return this._prevTimes[k];
    return this._bounds.get(height) ?? null;
  }

  _fail(err) {
    if (err instanceof HeaderError) this._lastError = { code: err.code, message: err.message, height: err.height };
    throw err;
  }

  /** The full rule check of `d` as the header at tip + 1 (does not append). */
  _verifyNext(height, d) {
    const r = this.rules;
    const tip = this._e.at(-1);
    if (d.prevHash !== tip.hash) throw new HeaderError("linkage", `header${at(height)} does not link to ${tip.hash.slice(0, 16)}…`, { height });
    const cp = this._cp.get(height);
    if (cp && cp !== d.hash) throw new HeaderError("checkpoint", `header${at(height)} is ${d.hash}, the pinned checkpoint is ${cp}`, { height });
    try {
      checkPow(d, r);
    } catch (e) {
      throw new HeaderError(e.code ?? "pow", `${e.message}${at(height)}`, { height });
    }
    const boundary = r.retarget && height % r.interval === 0;
    const firstTime = boundary ? this.timeAt(height - r.interval) : undefined;
    if (boundary && firstTime == null) throw new HeaderError("data", `retarget${at(height)}: the period start time is not held`, { height });
    const want = nextBits(r, { height, prevBits: tip.bits, prevTime: tip.time, firstTime });
    if ((d.bits >>> 0) !== want) {
      throw new HeaderError("bad-diffbits", `header${at(height)} has nBits 0x${(d.bits >>> 0).toString(16)}, the difficulty rule gives 0x${want.toString(16)}`, { height });
    }
    const times = [];
    for (let k = 1; k <= 11; k++) {
      const t = this.timeAt(height - k);
      if (t == null) break;
      times.push(t);
    }
    if (times.length < 11 && height - times.length > 0) throw new HeaderError("data", `header${at(height)}: the 11 timestamps below it are not held`, { height });
    const mtp = medianTimePast(times);
    if (d.time <= mtp) throw new HeaderError("time-too-old", `header${at(height)} time ${d.time} is not above the median time past ${mtp}`, { height });
    const floor = versionFloorAt(r, height);
    if (d.version < floor) throw new HeaderError("bad-version", `header${at(height)} has version ${d.version}, at least ${floor} is required`, { height });
    const limit = this.now() + r.maxFutureSecs;
    if (d.time > limit) throw new HeaderError("time-too-new", `header${at(height)} time ${d.time} is more than ${r.maxFutureSecs} s in the future`, { height, retryable: true });
  }

  _push(height, d) {
    const tip = this._e.at(-1);
    this._e.push({ height, hash: d.hash, prevHash: d.prevHash, time: d.time, bits: d.bits >>> 0, version: d.version, bytes: d.bytes, cw: tip.cw + workOf(d.bits) });
    if (height % this.rules.interval === 0) this._bounds.set(height, d.time);
    this._slide();
  }

  _slide() {
    const extra = this._e.length - this.keep;
    if (extra > 0) {
      const dropped = this._e.splice(0, extra);
      this._prevTimes = [...this._prevTimes, ...dropped.map((e) => e.time)].slice(-11);
    }
    const lo = this._e[0].height - 2 * this.rules.interval;
    for (const k of this._bounds.keys()) if (k < lo) this._bounds.delete(k);
  }

  /**
   * Appends the header at `height` (Uint8Array(80) or hex) and returns its decoded fields:
   *   height === base.height: its hash must equal the base hash (no other check)
   *   height <= tip:          its hash must equal the held one (no-op), else "conflict"
   *   height === tip + 1:     full verification, then appended
   *   anything else:          "linkage"
   */
  append(height, header) {
    try {
      const d = decodeHeader(header);
      if (!Number.isInteger(height)) throw new HeaderError("data", "a header height must be an integer");
      if (height < this._base.height) throw new HeaderError("below-base", `#${height} is below the base checkpoint #${this._base.height}`, { height });
      if (height === this._base.height) {
        if (d.hash !== this._base.hash) throw new HeaderError("checkpoint", `block #${height} is ${d.hash}, the pinned base checkpoint is ${this._base.hash}`, { height });
        return d;
      }
      if (height <= this.height) {
        const held = this.hashAt(height);
        if (held === null) throw new HeaderError("below-base", `#${height} is below the held header window (from #${this.from})`, { height });
        if (held !== d.hash) throw new HeaderError("conflict", `block #${height} is ${d.hash}, the verified chain holds ${held}`, { height });
        return d;
      }
      if (height !== this.height + 1) throw new HeaderError("linkage", `header #${height} does not follow the verified tip #${this.height}`, { height });
      this._verifyNext(height, d);
      this._push(height, d);
      this._lastError = null;
      return d;
    } catch (e) {
      return this._fail(e instanceof HeaderError ? e : new HeaderError("data", String(e?.message ?? e), { height }));
    }
  }

  /** Fetches and appends this.height + 1 .. toHeight. Source failures are retryable HeaderErrors. */
  async catchUp(source, toHeight, { onProgress, pageSize = 200, onHeader } = {}) {
    while (this.height < toHeight) {
      const from = this.height + 1;
      const n = Math.min(pageSize, toHeight - from + 1);
      let list;
      try {
        list = await fetchHeaders(source, from, n);
      } catch (e) {
        if (e instanceof HeaderError) this._fail(e);
        this._fail(new HeaderError("source", `could not fetch headers from #${from}: ${e?.message ?? e}`, { height: from, retryable: true }));
      }
      if (!list.length) this._fail(new HeaderError("source", `the data source served no header at #${from}`, { height: from, retryable: true }));
      for (let i = 0; i < list.length && from + i <= toHeight; i++) {
        const d = this.append(from + i, list[i]);
        if (onHeader?.(from + i, d.hash) === false) return;
      }
      onProgress?.(this.height, toHeight);
    }
  }

  /**
   * Makes the chain cover the indexer's tip with the same hashes: catches up from its own tip
   * to idx.height, comparing every appended height (and the heights both already hold) with
   * idx.hashes. Returns { mismatchAt }: the lowest height where they differ, or null.
   *
   * When the source now serves another branch above the held tip (the header file lagged the
   * indexer's state, or was lost), alignment alone never decides between the branches: the
   * indexer's own blocks are fetched by hash and verified from the held chain, and if they
   * verify the chain takes them (mismatchAt null, adopted: the first such height). The caller's
   * reorg path then follows the source's branch only if it has strictly more work (offer()).
   * Only when the source cannot serve the indexer's headers, or they do not verify, does it
   * report the mismatch (the indexer's branch cannot be checked; the source is a single point of
   * trust there, as everywhere for withheld blocks).
   */
  async alignTo(idx, source) {
    const base = this._base.height;
    if (idx.hashes?.has(base) && idx.hashes.get(base) !== this._base.hash) {
      this._fail(new HeaderError("checkpoint", `the indexer holds ${idx.hashes.get(base)} at the base checkpoint #${base}, which pins ${this._base.hash}`, { height: base }));
    }
    // The indexer is below the held window (e.g. its state was restored from an older backup):
    // the blocks it will apply next could not be matched, so start again from the base.
    if (this.from > base && idx.height < this.from - 1) this._reset();
    if (idx.height <= base) return { mismatchAt: null };
    const lo = Math.max(this.from, base + 1, idx.startHeight ?? 0);
    const hi = Math.min(this.height, idx.height);
    for (let h = lo; h <= hi; h++) {
      const theirs = idx.hashes.get(h);
      if (theirs !== undefined && theirs !== this.hashAt(h)) return { mismatchAt: h };
    }
    let mismatchAt = null;
    if (this.height < idx.height) {
      const start = this.height;
      const snap = this._clone();
      await this.catchUp(source, idx.height, {
        onHeader: (h, hash) => {
          const theirs = idx.hashes.get(h);
          if (theirs !== undefined && theirs !== hash) {
            mismatchAt = h;
            return false;
          }
          return true;
        },
      });
      if (mismatchAt !== null) {
        const own = await this._indexerBranch(idx, source, snap, start + 1);
        if (own) {
          this._e = own._e;
          this._prevTimes = own._prevTimes;
          this._bounds = own._bounds;
          this._lastError = null;
          return { mismatchAt: null, adopted: mismatchAt };
        }
      }
    }
    return { mismatchAt };
  }

  /**
   * The indexer's own branch from `from` to idx.height, verified on a copy of `held` (the chain
   * before this catch-up), or null when the source cannot serve one of its headers by hash or a
   * header does not verify.
   */
  async _indexerBranch(idx, source, held, from) {
    const read = async (hash) => {
      if (typeof source.blockHeader === "function") return String(await source.blockHeader(hash)).trim();
      if (typeof source.rawBlock === "function") return (await source.rawBlock(hash)).subarray(0, 80);
      throw new Error("the source serves no header by hash");
    };
    const c = held._clone();
    try {
      for (let h = from; h <= idx.height; h++) {
        const hash = idx.hashes.get(h);
        if (hash === undefined) return null;
        const d = decodeHeader(await read(hash));
        if (d.hash !== hash) return null;
        c.append(h, d.bytes);
      }
    } catch {
      return null;
    }
    return c;
  }

  _clone() {
    const c = Object.create(HeaderChain.prototype);
    Object.assign(c, this);
    c._e = [...this._e];
    c._prevTimes = [...this._prevTimes];
    c._bounds = new Map(this._bounds);
    return c;
  }

  /**
   * The source serves another branch above `forkHeight`: fetch it to the source's tip, verify
   * it from the held header at forkHeight, and switch only if its work is strictly greater than
   * the held branch above forkHeight (Core keeps the first-seen chain on a tie). Otherwise
   * throws HeaderError("less-work") and changes nothing.
   */
  async offer(source, forkHeight) {
    if (!this.has(forkHeight) || forkHeight < this._base.height) {
      this._fail(new HeaderError("conflict", `the fork point #${forkHeight} is outside the verified header window (#${this.from}..#${this.height})`, { height: forkHeight }));
    }
    let tip;
    try {
      tip = await source.tipHeight();
    } catch (e) {
      this._fail(new HeaderError("source", `could not read the source's tip: ${e?.message ?? e}`, { retryable: true }));
    }
    const fork = this._clone();
    fork.rollbackTo(forkHeight);
    // Cumulative work counts from the base on both branches, and they share everything up to
    // forkHeight. Read it from the held chain: the clone's window may slide past forkHeight
    // while it catches up a branch longer than `keep` headers.
    const atFork = this.workAt(forkHeight);
    if (tip > forkHeight) {
      try {
        await fork.catchUp(source, tip);
      } catch (e) {
        this._fail(e);
      }
    }
    const held = this.work - atFork;
    const offered = fork.work - atFork;
    if (offered > held) {
      this._e = fork._e;
      this._prevTimes = fork._prevTimes;
      this._bounds = fork._bounds;
      this._lastError = null;
      return { switched: true, forkHeight, tipHeight: this.height };
    }
    return this._fail(new HeaderError("less-work", `the data source's branch above #${forkHeight} (to #${fork.height}) has ${offered === held ? "the same" : "less"} work than the verified branch (to #${this.height}); keeping the verified chain`, { height: forkHeight }));
  }

  /** Drops headers above `height` (never below the base or the held window). */
  rollbackTo(height) {
    if (height >= this.height) return;
    if (height < this._base.height || height < this.from) throw new HeaderError("below-base", `cannot roll the header chain back to #${height} (held from #${this.from})`, { height });
    this._e.length = height - this.from + 1;
    for (const k of [...this._bounds.keys()]) if (k > height) this._bounds.delete(k);
  }

  status() {
    return {
      verified: true,
      network: this._network,
      rules: this.rules.validity,
      base: this.base,
      tipHeight: this.height,
      tipHash: this.hash,
      headers: this._e.length,
      workHex: this.work.toString(16),
      lastError: this._lastError ? { ...this._lastError } : null,
    };
  }

  snapshot() {
    const held = this._e[0].bytes ? this._e : this._e.slice(1);
    const from = held.length ? held[0].height : this.height + 1;
    const prevTimes = [];
    for (let h = from - 11; h < from; h++) {
      const t = this.timeAt(h);
      if (t != null) prevTimes.push(t);
      else prevTimes.length = 0;
    }
    return {
      v: 1,
      network: this._network,
      base: this.base,
      height: this.height,
      hash: this.hash,
      workHex: this.work.toString(16),
      from,
      headersHex: held.map((e) => hex(e.bytes)).join(""),
      context: { periodStartTimes: Object.fromEntries([...this._bounds].map(([k, v]) => [String(k), v])), prevTimes },
    };
  }

  /**
   * Rebuilds a chain from snapshot(). Throws on another network, a base that is not a pinned
   * checkpoint (or not the expected one), or data that does not verify; the caller then starts
   * a fresh chain from the base.
   */
  static restore(snap, { network = NETWORK, rules = RULES[network], checkpoints = CHECKPOINTS[network], base = null, startHeight = null, now, keep } = {}) {
    if (!snap || snap.v !== 1) throw new HeaderError("data", "not a header chain snapshot (v1)");
    if (snap.network !== network) throw new HeaderError("data", `the saved header chain is for ${snap.network}, this is ${network}`);
    const cp = basesOf(checkpoints).find((c) => c.height === snap.base?.height && String(c.hash).toLowerCase() === String(snap.base?.hash).toLowerCase());
    if (!cp) throw new HeaderError("checkpoint", `the saved header chain starts at #${snap.base?.height}, which is not a pinned base checkpoint`);
    const expected = base ?? (startHeight != null ? new HeaderChain({ network, rules, checkpoints, startHeight })._base : null);
    if (expected && (expected.height !== cp.height || String(expected.hash).toLowerCase() !== String(cp.hash).toLowerCase())) {
      throw new HeaderError("checkpoint", `the saved header chain starts at #${cp.height}, the expected base is #${expected.height}`);
    }
    const chain = new HeaderChain({ network, rules, checkpoints, base: cp, now: () => Infinity, keep });
    const hx = String(snap.headersHex ?? "");
    if (hx.length % 160 !== 0 || !/^[0-9a-f]*$/.test(hx)) throw new HeaderError("data", "saved headers are not whole 80-byte headers");
    const count = hx.length / 160;
    const from = snap.from;
    if (!Number.isInteger(from) || from <= cp.height || from + count - 1 !== snap.height) throw new HeaderError("data", "saved header range does not match its height");
    if (count === 0) {
      if (snap.height !== cp.height) throw new HeaderError("data", "saved header chain is empty above the base");
    } else if (from === cp.height + 1) {
      for (let i = 0; i < count; i++) chain.append(from + i, hx.slice(i * 160, i * 160 + 160));
    } else {
      // The window had slid: the first saved header is the anchor (it was verified when it was
      // appended); everything above it is verified again from it and the saved context.
      const anchor = decodeHeader(hx.slice(0, 160));
      checkPow(anchor, chain.rules);
      const cpHash = chain._cp.get(from);
      if (cpHash && cpHash !== anchor.hash) throw new HeaderError("checkpoint", `saved header #${from} contradicts the checkpoint list`);
      const ctx = snap.context ?? {};
      const prevTimes = Array.isArray(ctx.prevTimes) ? ctx.prevTimes : [];
      if (!prevTimes.every(Number.isInteger) || prevTimes.length !== Math.min(11, from)) throw new HeaderError("data", "saved header context has no valid timestamps");
      chain._e = [{ height: from, hash: anchor.hash, prevHash: anchor.prevHash, time: anchor.time, bits: anchor.bits, version: anchor.version, bytes: anchor.bytes, cw: 0n }];
      chain._prevTimes = [...prevTimes];
      chain._bounds = new Map(Object.entries(ctx.periodStartTimes ?? {}).map(([k, v]) => [Number(k), Number(v)]));
      if (from % chain.rules.interval === 0) chain._bounds.set(from, anchor.time);
      for (let i = 1; i < count; i++) chain.append(from + i, hx.slice(i * 160, i * 160 + 160));
      // Cumulative work is counted from the base; the anchor's share comes from the saved total.
      const total = BigInt("0x" + String(snap.workHex ?? "0"));
      const above = chain.work;
      if (total < above + workOf(anchor.bits)) throw new HeaderError("data", "saved work is less than the saved headers carry");
      const shift = total - above;
      for (const e of chain._e) e.cw += shift;
    }
    if (chain.height !== snap.height || chain.hash !== String(snap.hash).toLowerCase()) throw new HeaderError("data", "saved header chain tip does not match its headers");
    if (chain.work.toString(16) !== String(snap.workHex).toLowerCase()) throw new HeaderError("data", "saved header chain work does not match its headers");
    chain.now = now ?? (() => Math.floor(Date.now() / 1000));
    chain._lastError = null;
    return chain;
  }
}

/** `count` consecutive headers from `from` (fewer at the tip): source.headers when it has one, else one by one. */
export async function fetchHeaders(source, from, count) {
  if (typeof source.headers === "function") return source.headers(from, count);
  const out = [];
  for (let h = from; h < from + count; h++) {
    let hash;
    try {
      hash = String(await source.blockHash(h)).trim();
    } catch (e) {
      if (out.length) break; // the tip: fewer headers
      throw e;
    }
    const d = decodeHeader(String(await source.blockHeader(hash)).trim());
    if (d.hash !== hash) throw new HeaderError("source", `the header served for ${hash} hashes to ${d.hash}`, { height: h, retryable: true });
    out.push(d.bytes);
  }
  return out;
}

/** The nearest base-capable checkpoint of `network` to `height` (for receipt bounds), or null. */
export function nearestCheckpoint(network, height, checkpoints = CHECKPOINTS[network]) {
  let best = null;
  for (const c of basesOf(checkpoints)) if (!best || Math.abs(c.height - height) < Math.abs(best.height - height)) best = c;
  return best;
}

// Murkle envelope wire format (SPEC.md §5, §7, §8, §15). Parsing is strict: any length or
// range mismatch throws, and the indexer ignores the transaction.
import { sha256 } from "@noble/hashes/sha256";
import { FIELD } from "./core.mjs";
import { NOTE_CT_LEN } from "./keys.mjs";
import { PROOF_LEN } from "./proof-codec.mjs";
import {
  bigToBytes, bytesToBig, concat, equal, i64le, unhex, readI64le, readU16le, readU32le, readU64le, u32le, u64le,
} from "./bytes.mjs";
import { D_MAX, MAGIC, MAX_PER_BLOCK, MIN_DIFFICULTY, MIN_SPAN_CLAIMS, SPAN_MAX, SPAN_MIN, STRICT_TICKER, VERSION } from "./params.mjs";
import { isStandardScript } from "./mine.mjs";

export { MAGIC, VERSION };
// MINT binds to the first input's outpoint; MINT_SCRIPT to the scriptPubKey that
// input spends from (for wallets that choose inputs themselves, e.g. Unisat).
// ATTEST is a public, state-free statement (genesis manifest, later checkpoints).
// MINE / MINE_SCRIPT claim a proof-of-work reward, bound like MINT / MINT_SCRIPT;
// DEPLOY_POW carries mining terms. Op 6 stays reserved (BATCH).
export const OP = { TRANSACT: 1, DEPLOY: 2, MINT: 3, MINT_SCRIPT: 4, ATTEST: 5, MINE: 7, MINE_SCRIPT: 8, DEPLOY_POW: 9 };
export const isMint = (op) => op === OP.MINT || op === OP.MINT_SCRIPT;
export const isMine = (op) => op === OP.MINE || op === OP.MINE_SCRIPT;
/** Ops that exist only at and above the mining activation height (SPEC.md §15). */
export const MINING_OPS = new Set([OP.MINE, OP.MINE_SCRIPT, OP.DEPLOY_POW]);
/** Display names used in the indexer log. TRANSACT is shown as a transfer. */
export const OP_NAME = { 1: "TRANSFER", 2: "DEPLOY", 3: "MINT", 4: "MINT_SCRIPT", 5: "ATTEST", 7: "MINE", 8: "MINE_SCRIPT", 9: "DEPLOY_POW" };
// Kinds 2 and 3 are reserved: they decode, but nothing interprets them yet.
export const ATTEST_KIND = { GENESIS: 1, CHECKPOINT: 2, RELEASE: 3 };
const ATTEST_KINDS = new Set(Object.values(ATTEST_KIND));
const HEADER_LEN = MAGIC.length + 2;
export const ATTEST_HASH_LEN = 32;
export const ATTEST_LEN = HEADER_LEN + 1 + ATTEST_HASH_LEN; // 38
export const OUTPOINT_LEN = 36;
export const SCRIPT_HASH_LEN = 32;
export const NONCE_LEN = 8;
// Proof excluded. MINT also carries the outpoint it is bound to (audit A-6); MINE the bind and the nonce.
const TX_BODY_LEN = HEADER_LEN + 4 + 8 + 8 + 2 * 32 + 2 * 32 + 2 * NOTE_CT_LEN;
const BIND_LEN = { [OP.MINT]: OUTPOINT_LEN, [OP.MINT_SCRIPT]: SCRIPT_HASH_LEN, [OP.MINE]: OUTPOINT_LEN, [OP.MINE_SCRIPT]: SCRIPT_HASH_LEN };
const bodyLen = (op) => TX_BODY_LEN + (BIND_LEN[op] ?? 0) + (isMine(op) ? NONCE_LEN : 0);
// TRANSACT 471, MINT 507, MINT_SCRIPT 503, MINE 515, MINE_SCRIPT 511, ATTEST 38
export const envelopeLen = (op) => (op === OP.ATTEST ? ATTEST_LEN : bodyLen(op) + PROOF_LEN);
// DEPLOY_POW: 66 fixed bytes + ticker (1..16) + treasury (0..34).
export const DEPLOY_POW_MIN_LEN = 66;
export const DEPLOY_POW_MAX_LEN = 116;

/** What a MINT_SCRIPT commits to: sha256 of the payer's scriptPubKey. */
export const scriptHashOf = (script) => sha256(script);

const TICKER = /^[A-Z0-9]{1,16}$/;
const U64_MAX = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;

class Writer {
  constructor() { this.parts = []; }
  bytes(b) { this.parts.push(Uint8Array.from(b)); return this; }
  u8(v) { return this.bytes([v]); }
  u16(v) { return this.bytes([v & 0xff, (v >> 8) & 0xff]); }
  u32(v) { return this.bytes(u32le(v)); }
  u64(v) { return this.bytes(u64le(v)); }
  i64(v) { return this.bytes(i64le(v)); }
  field(v) { return this.bytes(bigToBytes(v, 32)); }
  done() { return concat(...this.parts); }
}

class Reader {
  constructor(bytes) { this.b = Uint8Array.from(bytes); this.o = 0; }
  take(n) {
    if (this.o + n > this.b.length) throw new Error("truncated envelope");
    const s = this.b.slice(this.o, this.o + n);
    this.o += n;
    return s;
  }
  u8() { return this.take(1)[0]; }
  u16() { return readU16le(this.take(2)); }
  u32() { return readU32le(this.take(4)); }
  u64() { return readU64le(this.take(8)); }
  i64() { return readI64le(this.take(8)); }
  field() {
    const v = bytesToBig(this.take(32));
    if (v >= FIELD) throw new Error("non-canonical field element");
    return v;
  }
  end() { if (this.o !== this.b.length) throw new Error("trailing bytes"); }
}

const hasMagic = (b) => b.length >= MAGIC.length && equal(b.subarray(0, MAGIC.length), MAGIC);

const header = (op) => new Writer().bytes(MAGIC).u8(VERSION).u8(op);

/** The op byte of a payload's header, or 0 when the payload is too short to have one. */
export const headerOp = (payload) => (payload.length >= HEADER_LEN ? payload[HEADER_LEN - 1] : 0);

/**
 * TRANSACT, MINT and MINE share one body. `extDataHash` (the circuit's public input)
 * commits to every body byte, so ciphertexts and the anchor cannot be swapped.
 * A MINT also names the outpoint its carrier transaction must spend first, so a
 * copy of the envelope is invalid in anyone else's transaction. A MINE / MINE_SCRIPT
 * is bound the same way; its anchor is the reference height and its nonce follows the bind.
 */
export function encodeTxBody({ op, anchor, publicAsset = 0n, publicAmount = 0n, bindOutpoint, bindScriptHash, nonce, nullifiers, commitments, ciphertexts }) {
  const w = header(op).u32(anchor).u64(publicAsset).i64(publicAmount);
  if (op === OP.MINT || op === OP.MINE) {
    if (bindOutpoint?.length !== OUTPOINT_LEN) throw new Error(`${op === OP.MINT ? "MINT" : "MINE"} needs a 36-byte bindOutpoint`);
    w.bytes(bindOutpoint);
  }
  if (op === OP.MINT_SCRIPT || op === OP.MINE_SCRIPT) {
    if (bindScriptHash?.length !== SCRIPT_HASH_LEN) throw new Error(`${op === OP.MINT_SCRIPT ? "MINT_SCRIPT" : "MINE_SCRIPT"} needs a 32-byte bindScriptHash`);
    w.bytes(bindScriptHash);
  }
  if (isMine(op)) {
    if (nonce?.length !== NONCE_LEN) throw new Error("MINE needs an 8-byte nonce");
    w.bytes(nonce);
  }
  nullifiers.forEach((n) => w.field(n));
  commitments.forEach((c) => w.field(c));
  ciphertexts.forEach((c) => {
    if (c.length !== NOTE_CT_LEN) throw new Error("bad ciphertext length");
    w.bytes(c);
  });
  return w.done();
}

export const extDataHashOf = (body) => bytesToBig(sha256(body)) >> 8n;

const isU32 = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;

export function encodeDeploy({ ticker, divisibility, mintAmount, mintCap, priceSats, treasury, startHeight = 0, endHeight = 0 }) {
  // The writer wraps out-of-range numbers silently (5e9 -> 705032704, -1 -> 0xffffffff),
  // so refuse them here. Encode side only: decoded fields are in range by construction.
  for (const [k, v] of Object.entries({ mintCap, startHeight, endHeight })) {
    if (!isU32(v)) throw new Error(`${k} must be a whole number from 0 to 4294967295`);
  }
  if (!Number.isInteger(divisibility) || divisibility < 0) throw new Error("divisibility must be a whole number from 0 to 8");
  if (BigInt(mintAmount) < 0n) throw new Error("mintAmount must be positive");
  if (BigInt(priceSats) < 0n || BigInt(priceSats) > U64_MAX) throw new Error("priceSats must be from 0 to 2^64-1");
  validateDeploy({ ticker, divisibility, mintAmount: BigInt(mintAmount), mintCap, priceSats: BigInt(priceSats), treasury, startHeight, endHeight });
  const t = new TextEncoder().encode(ticker);
  return header(OP.DEPLOY)
    .u8(t.length).bytes(t)
    .u8(divisibility)
    .u64(mintAmount)
    .u32(mintCap)
    .u64(priceSats)
    .u8(treasury.length).bytes(treasury)
    .u32(startHeight)
    .u32(endHeight)
    .done();
}

/**
 * DEPLOY_POW: magic ‖ version ‖ 0x09 ‖ ticker (u8 len + ASCII) ‖ divisibility u8 ‖ reward u64 ‖
 * maxSupply u64 ‖ halvingInterval u32 ‖ span u16 ‖ targetPerSpan u32 ‖ initialDifficulty u64 ‖
 * minDifficulty u64 ‖ claimFeeSats u64 ‖ treasury (u8 len + script) ‖ startHeight u32 ‖ endHeight u32.
 */
export function encodeDeployPow({
  ticker, divisibility, reward, maxSupply, halvingInterval = 0, span, targetPerSpan,
  initialDifficulty, minDifficulty, claimFeeSats = 0n, treasury = new Uint8Array(), startHeight = 0, endHeight = 0,
}) {
  for (const [k, v] of Object.entries({ halvingInterval, targetPerSpan, startHeight, endHeight })) {
    if (!isU32(v)) throw new Error(`${k} must be a whole number from 0 to 4294967295`);
  }
  if (!Number.isInteger(span) || span < 0 || span > 0xffff) throw new Error("span must be a whole number from 0 to 65535");
  if (!Number.isInteger(divisibility) || divisibility < 0) throw new Error("divisibility must be a whole number from 0 to 8");
  const d = {
    ticker, divisibility, reward: BigInt(reward), maxSupply: BigInt(maxSupply), halvingInterval, span, targetPerSpan,
    initialDifficulty: BigInt(initialDifficulty), minDifficulty: BigInt(minDifficulty), claimFeeSats: BigInt(claimFeeSats),
    treasury: Uint8Array.from(treasury), startHeight, endHeight,
  };
  for (const k of ["reward", "maxSupply", "initialDifficulty", "minDifficulty", "claimFeeSats"]) {
    if (d[k] < 0n || d[k] > U64_MAX) throw new Error(`${k} must be from 0 to 2^64-1`);
  }
  validateDeployPow(d);
  const t = new TextEncoder().encode(ticker);
  return header(OP.DEPLOY_POW)
    .u8(t.length).bytes(t)
    .u8(divisibility)
    .u64(d.reward)
    .u64(d.maxSupply)
    .u32(halvingInterval)
    .u16(span)
    .u32(targetPerSpan)
    .u64(d.initialDifficulty)
    .u64(d.minDifficulty)
    .u64(d.claimFeeSats)
    .u8(d.treasury.length).bytes(d.treasury)
    .u32(startHeight)
    .u32(endHeight)
    .done();
}

/** ATTEST: magic ‖ version ‖ 0x05 ‖ kind u8 ‖ hash 32. */
export function encodeAttest({ kind, hash }) {
  if (!ATTEST_KINDS.has(kind)) throw new Error(`unknown attest kind ${kind}`);
  const h = typeof hash === "string" ? unhex(hash) : Uint8Array.from(hash);
  if (h.length !== ATTEST_HASH_LEN) throw new Error("attest hash must be 32 bytes");
  return header(OP.ATTEST).u8(kind).bytes(h).done();
}

function validateDeploy(d) {
  if (!TICKER.test(d.ticker)) throw new Error("ticker must be 1-16 chars A-Z0-9");
  if (d.divisibility > 8) throw new Error("divisibility > 8");
  if (d.mintAmount === 0n || d.mintCap === 0) throw new Error("empty mint terms");
  // MINT carries publicAmount as i64, so a larger mintAmount could never be minted.
  if (d.mintAmount > I64_MAX) throw new Error("mintAmount exceeds i64");
  if (d.mintAmount * BigInt(d.mintCap) > U64_MAX) throw new Error("supply exceeds u64");
  if (d.treasury.length > 64) throw new Error("treasury script too long");
  if (d.priceSats > 0n && d.treasury.length === 0) throw new Error("paid mint needs a treasury");
  if (d.endHeight !== 0 && d.endHeight < d.startHeight) throw new Error("end before start");
}

/**
 * Structural DEPLOY_POW rules (encode and decode). The fee policy (MINE_FEE) and
 * endHeight >= mineStart are indexer rules, so a later fee rule can carry its own activation.
 */
export function validateDeployPow(d) {
  if (!TICKER.test(d.ticker)) throw new Error("ticker must be 1-16 chars A-Z0-9");
  if (d.divisibility > 8) throw new Error("divisibility > 8");
  // MINE carries publicAmount as i64.
  if (d.reward < 1n || d.reward > I64_MAX) throw new Error("reward must be from 1 to 2^63-1");
  if (d.reward > d.maxSupply) throw new Error("reward exceeds max supply");
  if (d.span < SPAN_MIN || d.span > SPAN_MAX) throw new Error(`span must be ${SPAN_MIN}..${SPAN_MAX} blocks`);
  if (d.targetPerSpan < MIN_SPAN_CLAIMS || d.targetPerSpan > MAX_PER_BLOCK * d.span) throw new Error(`target per span must be ${MIN_SPAN_CLAIMS}..${MAX_PER_BLOCK} x span`);
  if (d.minDifficulty < MIN_DIFFICULTY) throw new Error(`min difficulty below ${MIN_DIFFICULTY}`);
  if (d.initialDifficulty < d.minDifficulty) throw new Error("initial difficulty below min difficulty");
  if (d.initialDifficulty > D_MAX) throw new Error("initial difficulty exceeds 2^63-1");
  if (d.treasury.length && !isStandardScript(d.treasury)) throw new Error("treasury is not a standard script");
  if (d.claimFeeSats > 0n && d.treasury.length === 0) throw new Error("claim fee needs a treasury");
  if (d.endHeight !== 0 && d.endHeight < d.startHeight) throw new Error("end before start");
}

/** SPEC.md §7 strict ticker rule (V2-02): 1..16 raw bytes, each 0-9 or A-Z. */
export const TICKER_BYTES_ERROR = "ticker bytes must be 1-16 of A-Z0-9";
export function tickerBytesValid(raw) {
  if (raw.length < 1 || raw.length > 16) return false;
  for (const b of raw) if (!((b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a))) return false;
  return true;
}

// DEPLOY / DEPLOY_POW ticker field. Strict (mainnet from genesis): the raw bytes must already be
// canonical, checked once the envelope parsed whole (so a truncated or overlong envelope fails as
// it always did) and before the term rules. Historical (signet, forever): TextDecoder, which strips
// a leading UTF-8 BOM and maps bad bytes to U+FFFD, then the regex in validateDeploy*. The two
// accept different byte strings only for a leading BOM.
function readTicker(r) {
  const raw = r.take(r.u8());
  return { raw, text: new TextDecoder().decode(raw) };
}
function checkTickerBytes(raw, strictTicker) {
  if (strictTicker && !tickerBytesValid(raw)) throw new Error(TICKER_BYTES_ERROR);
}

/**
 * Bytes -> { op, ... }. Throws unless the envelope is exactly canonical. Free of height: activation is an indexer rule.
 * `strictTicker` defaults to this network's rule (STRICT_TICKER), so every call site agrees.
 */
export function decodeEnvelope(bytes, { strictTicker = STRICT_TICKER } = {}) {
  const r = new Reader(bytes);
  if (!hasMagic(r.take(MAGIC.length))) throw new Error("bad magic");
  if (r.u8() !== VERSION) throw new Error("unsupported version");
  const op = r.u8();

  if (op === OP.TRANSACT || isMint(op) || isMine(op)) {
    if (bytes.length !== envelopeLen(op)) throw new Error("bad envelope length");
    const env = { op, anchor: r.u32(), publicAsset: r.u64(), publicAmount: r.i64() };
    if (op === OP.MINT || op === OP.MINE) env.bindOutpoint = r.take(OUTPOINT_LEN);
    if (op === OP.MINT_SCRIPT || op === OP.MINE_SCRIPT) env.bindScriptHash = r.take(SCRIPT_HASH_LEN);
    if (isMine(op)) {
      env.refHeight = env.anchor;
      env.nonce = r.take(NONCE_LEN);
    }
    env.nullifiers = [r.field(), r.field()];
    env.commitments = [r.field(), r.field()];
    env.ciphertexts = [r.take(NOTE_CT_LEN), r.take(NOTE_CT_LEN)];
    env.proof = r.take(PROOF_LEN);
    r.end();
    env.extDataHash = extDataHashOf(bytes.slice(0, bodyLen(op)));
    return env;
  }

  if (op === OP.DEPLOY) {
    const { raw: tickerRaw, text: ticker } = readTicker(r);
    const d = {
      op, ticker, divisibility: r.u8(), mintAmount: r.u64(), mintCap: r.u32(), priceSats: r.u64(),
    };
    d.treasury = r.take(r.u8());
    d.startHeight = r.u32();
    d.endHeight = r.u32();
    r.end();
    checkTickerBytes(tickerRaw, strictTicker);
    validateDeploy(d);
    return d;
  }

  if (op === OP.DEPLOY_POW) {
    const { raw: tickerRaw, text: ticker } = readTicker(r);
    const d = {
      op, ticker, divisibility: r.u8(), reward: r.u64(), maxSupply: r.u64(), halvingInterval: r.u32(), span: r.u16(),
      targetPerSpan: r.u32(), initialDifficulty: r.u64(), minDifficulty: r.u64(), claimFeeSats: r.u64(),
    };
    d.treasury = r.take(r.u8());
    d.startHeight = r.u32();
    d.endHeight = r.u32();
    r.end();
    checkTickerBytes(tickerRaw, strictTicker);
    validateDeployPow(d);
    return d;
  }

  if (op === OP.ATTEST) {
    if (bytes.length !== ATTEST_LEN) throw new Error("bad envelope length");
    const kind = r.u8();
    if (!ATTEST_KINDS.has(kind)) throw new Error(`unknown attest kind ${kind}`);
    const env = { op, kind, hash: r.take(ATTEST_HASH_LEN) };
    r.end();
    return env;
  }

  throw new Error(`unknown op ${op}`);
}

/** Wraps envelope bytes into an OP_RETURN scriptPubKey (single push). */
export function opReturnScript(data) {
  const len = data.length;
  const push = len < 0x4c ? [len] : len <= 0xff ? [0x4c, len] : [0x4d, len & 0xff, len >> 8];
  return new Uint8Array([0x6a, ...push, ...data]);
}

/** Concatenated pushes of an OP_RETURN script, or null if it is not push-only. */
export function opReturnPayload(script) {
  const s = Uint8Array.from(script);
  if (s[0] !== 0x6a) return null;
  const parts = [];
  let i = 1;
  while (i < s.length) {
    const op = s[i++];
    let n;
    if (op >= 0x01 && op <= 0x4b) n = op;
    else if (op === 0x4c && i + 1 <= s.length) n = s[i++];
    else if (op === 0x4d && i + 2 <= s.length) { n = readU16le(s, i); i += 2; }
    else if (op === 0x4e && i + 4 <= s.length) { n = readU32le(s, i); i += 4; }
    else return null;
    if (i + n > s.length) return null;
    parts.push(s.subarray(i, i + n));
    i += n;
  }
  return concat(...parts);
}

/** Payload of the first OP_RETURN output of a transaction that starts with MAGIC, or null. */
export function findEnvelope(tx) {
  for (const out of tx.outputs) {
    const payload = opReturnPayload(out.script);
    if (payload && hasMagic(payload)) return payload;
  }
  return null;
}

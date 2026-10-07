// Ghost Relay anti-spam proof of work (relayer.md §4.3). Shared by the server,
// the browser worker, the CLI and the tests, so every side hashes the same bytes.
//
//   digest = sha256(TAG ‖ blockHash 32 ‖ sha256(envelope) ‖ nonce 8)
//
// The block hash ties a solution to a recent block (no precomputation), and the
// envelope hash ties it to one submission. This is a speed bump only: a GPU
// grinds it instantly. The relayer's real limit is its budget cap.
import { sha256 } from "@noble/hashes/sha256";
import { LABELS } from "./params.mjs";
import { hex, unhex } from "./bytes.mjs";

export const TAG = new TextEncoder().encode(LABELS.relayPow);
export const NONCE_LEN = 8;
const HEX32 = /^[0-9a-f]{64}$/;
const HEX8 = /^[0-9a-f]{16}$/;

const asBytes = (v) => (typeof v === "string" ? unhex(v) : Uint8Array.from(v));

function blockBytes(block) {
  if (typeof block === "string") {
    if (!HEX32.test(block)) throw new Error("block hash must be 64 lowercase hex chars");
    return unhex(block);
  }
  if (block.length !== 32) throw new Error("block hash must be 32 bytes");
  return Uint8Array.from(block);
}

function nonceBytes(nonce) {
  if (typeof nonce === "string") {
    if (!HEX8.test(nonce)) throw new Error("nonce must be 16 lowercase hex chars");
    return unhex(nonce);
  }
  if (nonce.length !== NONCE_LEN) throw new Error("nonce must be 8 bytes");
  return Uint8Array.from(nonce);
}

/** Hash state after TAG ‖ block ‖ sha256(envelope); grinding clones it per nonce. */
function prefixState(envelope, block) {
  return sha256.create().update(TAG).update(blockBytes(block)).update(sha256(asBytes(envelope)));
}

/** The 32-byte PoW digest for one (envelope, block, nonce). Accepts bytes or hex. */
export function powDigest({ envelope, block, nonce }) {
  return prefixState(envelope, block).update(nonceBytes(nonce)).digest();
}

/** Number of leading zero bits of a byte string (8 × length when all zero). */
export function leadingZeroBits(bytes) {
  let bits = 0;
  for (const b of bytes) {
    if (b === 0) {
      bits += 8;
      continue;
    }
    return bits + Math.clz32(b) - 24;
  }
  return bits;
}

/** True iff the digest has at least `bits` leading zero bits. Malformed input is false, never a throw. */
export function checkPow({ envelope, block, nonce, bits }) {
  try {
    return leadingZeroBits(powDigest({ envelope, block, nonce })) >= bits;
  } catch {
    return false;
  }
}

/** 8-byte big-endian nonce for a counter (counters stay below 2^53). */
export function nonceOf(counter) {
  const out = new Uint8Array(NONCE_LEN);
  let n = BigInt(counter);
  for (let i = NONCE_LEN - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/**
 * Tries counters start, start+step, start+2·step, … until a digest has `bits`
 * leading zeros. `step` lets several workers split the space; `limit` bounds
 * one call (returns null when it runs out) so a main-thread fallback can yield.
 * @returns { nonce (hex), counter, tries } or null.
 */
export function grind({ envelope, block, bits, start = 0, step = 1, limit = Infinity }) {
  const prefix = prefixState(envelope, block);
  let tries = 0;
  for (let counter = start; tries < limit; counter += step) {
    tries += 1;
    const nonce = nonceOf(counter);
    if (leadingZeroBits(prefix.clone().update(nonce).digest()) >= bits) return { nonce: hex(nonce), counter, tries };
  }
  return null;
}

/**
 * Required bits for the next submission (relayer.md §4.3): base, plus up to
 * `maxExtra` as the current block fills, plus `budgetExtra` past half the daily budget.
 */
export function powBits({ acceptedThisBlock = 0, spentToday = 0, reserved = 0, budget = Infinity, base = 18, maxExtra = 6, budgetExtra = 2 }) {
  const load = Math.min(maxExtra, Math.floor(Math.log2(1 + acceptedThisBlock / 8)));
  return base + load + (spentToday + reserved > budget / 2 ? budgetExtra : 0);
}

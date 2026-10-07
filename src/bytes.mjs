// Byte helpers that work identically in Node and browsers (no Buffer).
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils";

export { bytesToHex as hex, hexToBytes as unhex, concatBytes as concat };

export const randomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export const bytesToBig = (b) => (b.length ? BigInt("0x" + bytesToHex(b)) : 0n);

/** Big-endian fixed-width encoding; throws if `x` does not fit. */
export function bigToBytes(x, len) {
  const h = BigInt(x).toString(16).padStart(len * 2, "0");
  if (h.length > len * 2) throw new Error(`value does not fit in ${len} bytes`);
  return hexToBytes(h);
}

export const equal = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const view = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export function u32le(v) {
  const b = new Uint8Array(4);
  view(b).setUint32(0, v, true);
  return b;
}
export function u64le(v) {
  const b = new Uint8Array(8);
  view(b).setBigUint64(0, BigInt(v), true);
  return b;
}
export function i64le(v) {
  const b = new Uint8Array(8);
  view(b).setBigInt64(0, BigInt(v), true);
  return b;
}
export const readU16le = (b, o = 0) => view(b).getUint16(o, true);
export const readU32le = (b, o = 0) => view(b).getUint32(o, true);
export const readU64le = (b, o = 0) => view(b).getBigUint64(o, true);
export const readI64le = (b, o = 0) => view(b).getBigInt64(o, true);

/** Serialized outpoint as in a raw tx input: txid (internal byte order) ‖ vout LE. */
export const outpointOf = (txid, vout) => concatBytes(hexToBytes(txid).reverse(), u32le(vout));

// Minimal raw Bitcoin block and transaction parser: only what replay needs
// (txids, input outpoints and outputs). Every txid is recomputed from the bytes.
import { sha256 } from "@noble/hashes/sha256";
import { concat, equal, hex, readU16le, readU32le, readU64le, unhex } from "../bytes.mjs";

const dsha = (b) => sha256(sha256(b));
const rev = (b) => Uint8Array.from(b).reverse();
const NULL_OUTPOINT = Uint8Array.from([...new Uint8Array(32), 0xff, 0xff, 0xff, 0xff]);

/** True for the null outpoint (zero txid, vout 0xffffffff): a coinbase's only input, which spends no coin. */
export const isNullOutpoint = (outpoint) => outpoint?.length === 36 && equal(outpoint, NULL_OUTPOINT);

class Cursor {
  constructor(buf) { this.b = Uint8Array.from(buf); this.o = 0; }
  take(n) {
    if (this.o + n > this.b.length) throw new Error("truncated data");
    const s = this.b.subarray(this.o, this.o + n);
    this.o += n;
    return s;
  }
  u8() { return this.take(1)[0]; }
  u32() { return readU32le(this.take(4)); }
  u64() { return readU64le(this.take(8)); }
  varint() {
    const n = this.u8();
    if (n < 0xfd) return n;
    if (n === 0xfd) return readU16le(this.take(2));
    if (n === 0xfe) return readU32le(this.take(4));
    return Number(readU64le(this.take(8)));
  }
  bytes() { return this.take(this.varint()); }
}

function parseTx(c) {
  const start = c.o;
  c.take(4); // version
  let segwit = false;
  if (c.b[c.o] === 0 && c.b[c.o + 1] === 1) {
    segwit = true;
    c.take(2);
  }
  const ioStart = c.o;
  const inputs = [];
  const nIn = c.varint();
  for (let i = 0; i < nIn; i++) {
    inputs.push({ outpoint: new Uint8Array(c.take(36)) }); // prev txid (internal order) ‖ vout LE
    c.bytes();
    c.take(4);
  }
  const outputs = [];
  const nOut = c.varint();
  for (let i = 0; i < nOut; i++) {
    const value = c.u64();
    outputs.push({ value, script: new Uint8Array(c.bytes()) });
  }
  const ioEnd = c.o;
  if (segwit) for (let i = 0; i < nIn; i++) for (let k = c.varint(); k > 0; k--) c.bytes();
  c.take(4); // locktime
  // txid commits to the legacy serialization: version ‖ inputs ‖ outputs ‖ locktime.
  const legacy = concat(c.b.subarray(start, start + 4), c.b.subarray(ioStart, ioEnd), c.b.subarray(c.o - 4, c.o));
  const hash = dsha(legacy);
  return { txid: hex(rev(hash)), hash, inputs, outputs };
}

/** Bitcoin merkle root over internal-order txids (odd levels duplicate the last node). */
function merkleRoot(hashes) {
  let level = hashes;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(dsha(concat(level[i], level[i + 1] ?? level[i])));
    }
    level = next;
  }
  return level[0];
}

/**
 * Raw block bytes -> { hash, prevHash, header, txs: [{ txid, outputs: [{ value, script }] }] }.
 * `header` is the block's 80-byte header (a copy), for the header chain (src/btc/headers.mjs).
 */
export function parseBlock(raw) {
  const c = new Cursor(raw);
  const header = c.take(80);
  const txs = [];
  for (let n = c.varint(); n > 0; n--) txs.push(parseTx(c));
  if (c.o !== c.b.length) throw new Error("trailing bytes after block");
  // Ties the transaction list to the header, so a data source cannot inject,
  // drop or reorder transactions without changing the block hash.
  if (!txs.length || !equal(merkleRoot(txs.map((t) => t.hash)), header.subarray(36, 68))) {
    throw new Error("merkle root mismatch");
  }
  // CVE-2012-2459: duplicated transactions leave the merkle root unchanged.
  if (new Set(txs.map((t) => t.txid)).size !== txs.length) throw new Error("duplicate transactions in block");
  return {
    hash: hex(rev(dsha(header))),
    prevHash: hex(rev(header.subarray(4, 36))),
    header: Uint8Array.from(header),
    txs: txs.map(({ txid, inputs, outputs }) => ({ txid, inputs, outputs })),
  };
}

/**
 * Raw transaction (bytes or hex) -> { txid, inputs, outputs }. With
 * `expectedTxid`, throws unless the bytes hash to it, so a data source cannot
 * answer a prevout lookup with some other transaction's outputs (audit A-9).
 */
export function parseRawTx(raw, expectedTxid) {
  const c = new Cursor(typeof raw === "string" ? unhex(raw.trim()) : raw);
  const { txid, inputs, outputs } = parseTx(c);
  if (c.o !== c.b.length) throw new Error("trailing bytes after transaction");
  if (expectedTxid !== undefined && txid !== String(expectedTxid).toLowerCase()) {
    throw new Error(`txid mismatch: expected ${expectedTxid}, bytes hash to ${txid}`);
  }
  return { txid, inputs, outputs };
}

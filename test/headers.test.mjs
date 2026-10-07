// A-9: block header verification (src/btc/headers.mjs), the sync integration (src/sync.mjs),
// Esplora's header surface and the receipt levels (src/verify-tx.mjs makeHeaderCheck).
// Offline: real signet and mainnet headers from test/fixtures/headers/, synthetic chains for
// everything that needs headers no real chain has (bad bits, reorgs, timestamps).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import * as H from "../src/btc/headers.mjs";
import { HeaderChain, HeaderError, CHECKPOINTS, RULES, decodeHeader, encodeHeader, targetFromBits, bitsFromTarget, workOf, checkPow, nextBits, medianTimePast, maxTargetAt, versionFloorAt } from "../src/btc/headers.mjs";
import { syncIndexer } from "../src/sync.mjs";
import { parseBlock } from "../src/btc/block.mjs";
import { Indexer } from "../src/indexer.mjs";
import { Esplora } from "../src/btc/esplora.mjs";
import { ATTEST_KIND, encodeAttest, opReturnScript } from "../src/envelope.mjs";
import { concat, hex, u32le, u64le, unhex } from "../src/bytes.mjs";
import { makeHeaderCheck, chainTrustClause, verifyTx, CheckError } from "../src/verify-tx.mjs";
import { registerHooks } from "node:module";

// Web modules import JSON without attributes and CSS (Vite handles both); teach Node the same.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (url.endsWith(".json") && !context.importAttributes?.type) return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
    return nextLoad(url, context);
  },
});

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const dsha = (b) => sha256(sha256(b));
const rev = (b) => Uint8Array.from(b).reverse();
const code = (c) => (e) => e instanceof HeaderError && e.code === c;
const CYRILLIC = new RegExp(`[${String.fromCharCode(0x400)}-${String.fromCharCode(0x4ff)}]`);

/* ------------------------------------------------------------------ fixtures */

const SIG = readFileSync("test/fixtures/headers/signet-322550-324600.bin");
const SIG_FROM = 322550;
const SIG_TO = 324600;
const sig = (h) => {
  assert.ok(h >= SIG_FROM && h <= SIG_TO, `signet fixture has no #${h}`);
  return decodeHeader(new Uint8Array(SIG.subarray((h - SIG_FROM) * 80, (h - SIG_FROM + 1) * 80)));
};
const MAIN = JSON.parse(readFileSync("test/fixtures/headers/mainnet-969696.json", "utf8"));
const main = (h) => decodeHeader(MAIN.headers[h - MAIN.from]);
const MAIN_TO = MAIN.from + MAIN.headers.length - 1;
const MAIN_PERIOD = decodeHeader(MAIN.periodStart.header);

/** A base checkpoint for height `h` built from a fixture lookup. */
function baseFrom(get, h, periodStartTime) {
  const d = get(h);
  return { height: h, hash: d.hash, base: { bits: d.bits, time: d.time, periodStartTime, prevTimes: Array.from({ length: 10 }, (_, i) => get(h - 10 + i).time) } };
}

/* -------------------------------------------------------- synthetic chains */

// Easy proof of work for synthetic headers: powLimit 0x207fffff (regtest), a 16-block retarget
// interval and 1-second spacing. Core computes the retarget as target * timespan on 256 bits
// (truncated), so synthetic targets stay below 2^250 (EASY) to keep that product in range.
const SP = 1;
const TEST_RULES = Object.freeze({
  network: "test",
  powLimit: targetFromBits(0x207fffff).target,
  interval: 16,
  targetTimespan: 16 * SP,
  targetSpacing: SP,
  retarget: true,
  versionFloor: [[0, 2], [100005, 3], [100010, 4]],
  maxFutureSecs: 7200,
  validity: "pow",
});
const EASY = 0x2001ffff; // about 1 in 128 hashes meets it

function mine({ prevHash, merkleRoot = "11".repeat(32), time, bits = EASY, version = 4 }) {
  const { target } = targetFromBits(bits);
  for (let nonce = 0; ; nonce++) {
    const bytes = encodeHeader({ version, prevHash, merkleRoot, time, bits, nonce });
    const d = decodeHeader(bytes);
    if (BigInt("0x" + d.hash) <= target) return d;
  }
}

const varint = (n) => (n < 0xfd ? Uint8Array.of(n) : concat(Uint8Array.of(0xfd), Uint8Array.of(n & 0xff, n >> 8)));
const script = (s) => concat(varint(s.length), s);
function txBytes({ outpoint = new Uint8Array(36).fill(0).map((_, i) => (i >= 32 ? 0xff : 0)), scriptSig = new Uint8Array(0), outputs }) {
  return concat(
    u32le(1), varint(1), outpoint, script(scriptSig), u32le(0xffffffff),
    varint(outputs.length), ...outputs.map(({ value, s }) => concat(u64le(value), script(s))), u32le(0),
  );
}
function merkle(hashes) {
  let level = hashes;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(dsha(concat(level[i], level[i + 1] ?? level[i])));
    level = next;
  }
  return level[0];
}

/**
 * A synthetic chain: base header at `start`, then blocks start+1 .. start+n. Each block has a
 * coinbase (unique by height and `salt`); every `attestEvery`-th block also carries an ATTEST.
 */
function makeChain({ start = 100000, n = 20, rules = TEST_RULES, t0 = 1_700_000_000, salt = 0, attestEvery = 3, from = null, bits = EASY } = {}) {
  const blocks = new Map();
  const periodStart = (h) => blocks.get(h)?.time;
  const bitsFor = (height, prev) => {
    if (!prev) return bits;
    if (height % rules.interval !== 0) return prev.bits;
    return nextBits(rules, { height, prevBits: prev.bits, prevTime: prev.time, firstTime: periodStart(height - rules.interval) ?? t0 - (start % rules.interval) * SP });
  };
  const addBlock = (height, prevHash, time) => {
    const cb = txBytes({ scriptSig: concat(u32le(height), u32le(salt)), outputs: [{ value: 0n, s: Uint8Array.of(0x51) }] });
    const txs = [cb];
    if (attestEvery && height % attestEvery === 0) {
      const env = encodeAttest({ kind: ATTEST_KIND.GENESIS, hash: dsha(concat(u32le(height), u32le(salt))) });
      txs.push(txBytes({ outpoint: concat(dsha(u32le(height + 7)), u32le(0)), outputs: [{ value: 0n, s: opReturnScript(env) }] }));
    }
    const root = merkle(txs.map((t) => dsha(t)));
    const b = bitsFor(height, blocks.get(height - 1));
    const h = mine({ prevHash, merkleRoot: hex(rev(root)), time, bits: b });
    const raw = concat(h.bytes, varint(txs.length), ...txs);
    blocks.set(height, { height, hash: h.hash, header: h.bytes, raw, time, bits: b });
    return h;
  };
  let prev;
  if (from) {
    for (const [k, v] of from.blocks) if (k <= from.forkAt) blocks.set(k, v);
    prev = blocks.get(from.forkAt);
  } else {
    prev = addBlock(start, "00".repeat(32), t0);
  }
  const first = from ? from.forkAt + 1 : start + 1;
  const last = from ? from.forkAt + n : start + n;
  let prevHash = prev.hash;
  for (let height = first; height <= last; height++) {
    const time = t0 + (height - start) * SP + (from ? 1 : 0);
    prevHash = addBlock(height, prevHash, time).hash;
  }
  const b = blocks.get(start);
  const period = start - (start % rules.interval);
  const base = { height: start, hash: b.hash, base: { bits, time: b.time, periodStartTime: b.time - (start - period) * SP, prevTimes: Array.from({ length: 10 }, (_, i) => b.time - (10 - i) * SP) } };
  return { blocks, base, start, tip: last };
}

/** A fake chain source over one chain at a time (swap `source.chain` for a reorg). Records calls. */
function fakeSource(chain) {
  const s = {
    chain,
    calls: [],
    async tipHeight() { s.calls.push("tipHeight"); return s.chain.tip; },
    async blockHash(h) {
      s.calls.push(`blockHash ${h}`);
      const b = s.chain.blocks.get(h);
      if (!b) throw new Error(`GET /block-height/${h}: 404 Block not found`);
      return b.hash;
    },
    async rawBlock(hash) {
      s.calls.push(`rawBlock ${hash.slice(0, 8)}`);
      for (const b of s.chain.blocks.values()) if (b.hash === hash) return b.raw;
      throw new Error("404");
    },
    async headers(from, count) {
      s.calls.push(`headers ${from} ${count}`);
      const out = [];
      for (let h = from; h < from + count && s.chain.blocks.has(h); h++) out.push(s.chain.blocks.get(h).header);
      return out;
    },
    async prevoutScript() { throw new Error("no prevouts in this chain"); },
  };
  return s;
}

const newChain = (c, opts = {}) => new HeaderChain({ network: "test", rules: TEST_RULES, checkpoints: [c.base], base: c.base, ...opts });

/* ------------------------------------------------------- checkpoints and data */

test("checkpoints.json: the signet base is the Murkle genesis block, its context matches the real headers", () => {
  const [cp] = CHECKPOINTS.signet;
  assert.equal(cp.height, 324592);
  assert.equal(cp.hash, "0000000418f25af53b4ddd1b227ce058f27672d3352dec005466dcacf38cf715");
  assert.equal(cp.hash, sig(324592).hash);
  assert.deepEqual(cp.base, {
    bits: sig(324592).bits,
    time: sig(324592).time,
    periodStartTime: sig(324576).time,
    prevTimes: Array.from({ length: 10 }, (_, i) => sig(324582 + i).time),
  });
  assert.equal(cp.base.periodStartTime, 1790905711);
  assert.equal(sig(324576).hash.slice(0, 16), "0000000141d60082");
  assert.equal(HeaderChain.baseFor("signet", 324592).height, 324592);
  assert.throws(() => HeaderChain.baseFor("signet", 324591), code("below-base"));
});

test("checkpoints.json: the mainnet pre-launch base is the retarget boundary 969696 and matches the real headers", () => {
  const cp = CHECKPOINTS.mainnet.find((c) => c.base);
  assert.equal(cp.height, 969696);
  assert.equal(cp.height % 2016, 0);
  assert.equal(cp.hash, main(969696).hash);
  assert.deepEqual(cp.base, {
    bits: main(969696).bits,
    time: main(969696).time,
    periodStartTime: main(969696).time,
    prevTimes: Array.from({ length: 10 }, (_, i) => main(969686 + i).time),
  });
  // Every header of the fixture hashes below its target and links to the one before.
  for (let h = MAIN.from + 1; h <= MAIN_TO; h++) {
    assert.equal(main(h).prevHash, main(h - 1).hash);
    checkPow(main(h), RULES.mainnet);
  }
});

test("decodeHeader / encodeHeader round trip on real headers; bad lengths are data errors", () => {
  const d = sig(324592);
  assert.equal(d.version, 0x20000000);
  assert.deepEqual(encodeHeader(d), d.bytes);
  assert.equal(decodeHeader(hex(d.bytes)).hash, d.hash);
  assert.throws(() => decodeHeader(d.bytes.subarray(0, 79)), code("data"));
  assert.throws(() => decodeHeader("00"), code("data"));
  assert.throws(() => decodeHeader(42), code("data"));
  // A signed version: the top bit set reads as a negative int32, as Core's int32_t.
  const neg = Uint8Array.from(d.bytes);
  neg[3] = 0x80;
  assert.ok(decodeHeader(neg).version < 0);
});

/* ------------------------------------------------------------ compact bits */

test("bitsFromTarget(targetFromBits(b)) === b for every real nBits in the fixtures", () => {
  const all = new Set();
  for (let h = SIG_FROM; h <= SIG_TO; h++) all.add(sig(h).bits);
  for (let h = MAIN.from; h <= MAIN_TO; h++) all.add(main(h).bits);
  all.add(0x1d00ffff);
  all.add(0x207fffff);
  assert.ok(all.size >= 4);
  for (const b of all) assert.equal(bitsFromTarget(targetFromBits(b).target), b, b.toString(16));
});

test("compact encoding: Bitcoin Core's arith_uint256 SetCompact/GetCompact vectors", () => {
  const v = (bits, target, { negative = false, overflow = false, compact = bits } = {}) => {
    const r = targetFromBits(bits);
    assert.equal(r.target, target, `target of ${bits.toString(16)}`);
    assert.equal(r.negative, negative, `negative of ${bits.toString(16)}`);
    assert.equal(r.overflow, overflow, `overflow of ${bits.toString(16)}`);
    if (!negative && !overflow) assert.equal(bitsFromTarget(target), compact, `compact of ${bits.toString(16)}`);
  };
  v(0x00000000, 0n, { compact: 0 });
  v(0x00123456, 0n, { compact: 0 });
  v(0x01003456, 0n, { compact: 0 });
  v(0x02000056, 0n, { compact: 0 });
  v(0x03000000, 0n, { compact: 0 });
  v(0x04000000, 0n, { compact: 0 });
  v(0x00923456, 0n, { compact: 0 });
  v(0x01803456, 0n, { compact: 0 });
  v(0x02800056, 0n, { compact: 0 });
  v(0x03800000, 0n, { compact: 0 });
  v(0x04800000, 0n, { compact: 0 });
  v(0x01123456, 0x12n, { compact: 0x01120000 });
  v(0x02008000, 0x80n);
  v(0x01fedcba, 0x7en, { negative: true });
  v(0x02123456, 0x1234n, { compact: 0x02123400 });
  v(0x03123456, 0x123456n);
  v(0x04123456, 0x12345600n);
  v(0x04923456, 0x12345600n, { negative: true });
  v(0x05009234, 0x92340000n);
  v(0x20123456, 0x1234560000000000000000000000000000000000000000000000000000000000n);
  v(0xff123456, targetFromBits(0xff123456).target, { overflow: true });
  // Overflow edges: a 1-byte mantissa may reach size 34, a 2-byte one 33, a 3-byte one 32.
  assert.equal(targetFromBits(0x22000001).overflow, false);
  assert.equal(targetFromBits(0x23000001).overflow, true);
  assert.equal(targetFromBits(0x21000100).overflow, false);
  assert.equal(targetFromBits(0x22000100).overflow, true);
  assert.equal(targetFromBits(0x20010000).overflow, false);
  assert.equal(targetFromBits(0x21010000).overflow, true);
  // GetCompact moves a set sign bit into the exponent.
  assert.equal(bitsFromTarget(0x80n), 0x02008000);
  assert.equal(bitsFromTarget(0n), 0);
});

test("checkPow: negative, zero, overflowing and above-powLimit targets are bits-range; a hash above target is pow", () => {
  const real = main(969700);
  checkPow(real, RULES.mainnet);
  const withBits = (bits) => ({ ...real, bits });
  for (const bits of [0x1d80ffff, 0x00000000, 0x01003456, 0xff123456, 0x1d01ffff, 0x207fffff]) {
    assert.throws(() => checkPow(withBits(bits), RULES.mainnet), code("bits-range"), bits.toString(16));
  }
  assert.throws(() => checkPow({ ...real, hash: "ff".repeat(32) }, RULES.mainnet), code("pow"));
  // Signet's powLimit 0x1e0377ae is valid there and not on mainnet.
  assert.throws(() => checkPow(withBits(0x1e0377ae), RULES.mainnet), code("bits-range"));
  assert.equal(bitsFromTarget(RULES.signet.powLimit), 0x1e0377ae);
  assert.equal(bitsFromTarget(RULES.mainnet.powLimit), 0x1d00ffff);
});

test("workOf: 2^256 / (target + 1), zero for invalid targets", () => {
  assert.equal(workOf(0x1d00ffff), 0x100010001n); // the genesis block's chain work
  assert.equal(workOf(0x00000000), 0n);
  assert.equal(workOf(0x04923456), 0n);
  assert.equal(workOf(0xff123456), 0n);
  const t = targetFromBits(386014960).target;
  assert.equal(workOf(386014960), (1n << 256n) / (t + 1n));
});

test("medianTimePast, versionFloorAt and maxTargetAt", () => {
  assert.equal(medianTimePast([5, 1, 4, 2, 3, 9, 8, 7, 6, 11, 10]), 6);
  assert.equal(medianTimePast([3, 1]), 3);
  assert.equal(versionFloorAt(RULES.mainnet, 227930), 0);
  assert.equal(versionFloorAt(RULES.mainnet, 227931), 2);
  assert.equal(versionFloorAt(RULES.mainnet, 363725), 3);
  assert.equal(versionFloorAt(RULES.mainnet, 388380), 3);
  assert.equal(versionFloorAt(RULES.mainnet, 388381), 4);
  assert.equal(versionFloorAt(RULES.signet, 1), 4);
  const cp = CHECKPOINTS.mainnet[0];
  const t = targetFromBits(cp.base.bits).target;
  assert.equal(maxTargetAt(RULES.mainnet, cp, cp.height), t);
  assert.equal(maxTargetAt(RULES.mainnet, cp, cp.height + 1), t * 4n);
  assert.equal(maxTargetAt(RULES.mainnet, cp, cp.height + 2016), t * 4n);
  assert.equal(maxTargetAt(RULES.mainnet, cp, cp.height + 2017), t * 16n);
  assert.equal(maxTargetAt(RULES.mainnet, cp, cp.height - 1), t * 4n + (t >> 13n) + 4n); // GetCompact truncation slack going back
  assert.equal(maxTargetAt(RULES.mainnet, cp, 0), RULES.mainnet.powLimit);
});

/* ------------------------------------------------------------ real chains */

test("signet: a full retarget period from boundary 322560 through the retarget at 324576 and the genesis checkpoint (Core's rules hold on signet)", () => {
  const c = new HeaderChain({ network: "signet", base: baseFrom(sig, 322560, sig(322560).time) });
  for (let h = 322561; h <= SIG_TO; h++) c.append(h, sig(h).bytes);
  assert.equal(c.height, SIG_TO);
  assert.equal(c.hash, sig(SIG_TO).hash);
  assert.equal(c.hashAt(324592), CHECKPOINTS.signet[0].hash, "passes the pinned genesis checkpoint");
  assert.notEqual(sig(324575).bits, sig(324576).bits, "the difficulty changed at the boundary");
  assert.equal(nextBits(RULES.signet, { height: 324576, prevBits: sig(324575).bits, prevTime: sig(324575).time, firstTime: sig(322560).time }), sig(324576).bits);
  // The same boundary with bits off by one is refused.
  const d = new HeaderChain({ network: "signet", base: baseFrom(sig, 322560, sig(322560).time) });
  for (let h = 322561; h <= 324575; h++) d.append(h, sig(h).bytes);
  const off = Uint8Array.from(sig(324576).bytes);
  new DataView(off.buffer).setUint32(72, sig(324576).bits + 1, true);
  assert.throws(() => d.append(324576, off), (e) => ["bad-diffbits", "pow"].includes(e.code));
  assert.equal(c.status().rules, "pow+signet-signature-unchecked");
});

test("signet: the default chain starts at the Murkle genesis checkpoint and verifies the blocks above it", () => {
  const c = new HeaderChain({ network: "signet", startHeight: 324592 });
  assert.deepEqual(c.base, { height: 324592, hash: CHECKPOINTS.signet[0].hash });
  assert.equal(c.height, 324592);
  c.append(324592, sig(324592).bytes); // the base itself: a hash comparison only
  for (let h = 324593; h <= SIG_TO; h++) c.append(h, sig(h).bytes);
  assert.equal(c.hash, sig(SIG_TO).hash);
  assert.equal(c.work, [...Array(SIG_TO - 324592).keys()].reduce((a, i) => a + workOf(sig(324593 + i).bits), 0n));
});

test("mainnet: headers across the real retarget boundary 969696 (B-1 context) and 34 more", () => {
  const c = new HeaderChain({ network: "mainnet", base: baseFrom(main, 969695, MAIN_PERIOD.time) });
  assert.equal(MAIN.periodStart.height, 969696 - 2016);
  for (let h = 969696; h <= MAIN_TO; h++) c.append(h, main(h).bytes);
  assert.equal(c.height - 969695, 35);
  assert.notEqual(main(969695).bits, main(969696).bits);
  assert.equal(nextBits(RULES.mainnet, { height: 969696, prevBits: main(969695).bits, prevTime: main(969695).time, firstTime: MAIN_PERIOD.time }), main(969696).bits);
  // The default mainnet chain starts at the pinned boundary and verifies everything above it.
  const d = new HeaderChain({ network: "mainnet" });
  assert.equal(d.base.height, 969696);
  for (let h = 969697; h <= MAIN_TO; h++) d.append(h, main(h).bytes);
  assert.equal(d.hash, main(MAIN_TO).hash);
  assert.equal(d.status().rules, "pow");
  // A wrong period start time changes the retarget: refused.
  const e = new HeaderChain({ network: "mainnet", base: baseFrom(main, 969695, MAIN_PERIOD.time + 600) });
  assert.throws(() => e.append(969696, main(969696).bytes), code("bad-diffbits"));
});

/* --------------------------------------------------------- failure codes */

test("failure codes on real signet headers: linkage, pow, checkpoint, conflict, below-base", () => {
  const c = new HeaderChain({ network: "signet", startHeight: 324592 });
  assert.throws(() => c.append(324594, sig(324594).bytes), code("linkage"), "not tip + 1");
  const broken = Uint8Array.from(sig(324593).bytes);
  broken[4] ^= 1; // prevHash
  assert.throws(() => c.append(324593, broken), code("linkage"));
  assert.equal(c.lastError.code, "linkage");
  const nonce = Uint8Array.from(sig(324593).bytes);
  let bad;
  for (let n = 1; ; n++) {
    new DataView(nonce.buffer).setUint32(76, n, true);
    bad = decodeHeader(nonce);
    if (BigInt("0x" + bad.hash) > targetFromBits(bad.bits).target) break;
  }
  assert.throws(() => c.append(324593, nonce), code("pow"));
  assert.throws(() => c.append(324592, sig(324591).bytes), code("checkpoint"), "the base height must carry the pinned hash");
  assert.throws(() => c.append(324500, sig(324500).bytes), code("below-base"));
  c.append(324593, sig(324593).bytes);
  assert.equal(c.lastError, null, "a good header clears the error");
  assert.throws(() => c.append(324593, sig(324594).bytes), code("conflict"));
  c.append(324593, sig(324593).bytes); // the same header again: a no-op
  // A pinned checkpoint above the base with another hash.
  const pinned = [CHECKPOINTS.signet[0], { height: 324595, hash: "00".repeat(31) + "01" }];
  const p = new HeaderChain({ network: "signet", checkpoints: pinned, startHeight: 324592 });
  p.append(324593, sig(324593).bytes);
  p.append(324594, sig(324594).bytes);
  assert.throws(() => p.append(324595, sig(324595).bytes), code("checkpoint"));
});

test("failure codes on synthetic headers: wrong bits mid-period, wrong retarget, time-too-old at the MTP, time-too-new (retryable), bad-version, bits-range", () => {
  const chain = makeChain({ start: 100000, n: 15 }); // 100000 % 16 === 0: base at a boundary
  const c = newChain(chain);
  for (let h = 100001; h <= 100015; h++) c.append(h, chain.blocks.get(h).header);
  const tip = chain.blocks.get(100015);
  const t = tip.time;
  // Retarget at 100016: expected bits from the 15-second period (15 blocks, 1 s apart).
  const want = nextBits(TEST_RULES, { height: 100016, prevBits: EASY, prevTime: t, firstTime: chain.blocks.get(100000).time });
  assert.notEqual(want, EASY);
  assert.throws(() => c.append(100016, mine({ prevHash: tip.hash, time: t + SP, bits: EASY }).bytes), code("bad-diffbits"));
  assert.throws(() => c.append(100016, mine({ prevHash: tip.hash, time: t + SP, bits: want - 1 }).bytes), code("bad-diffbits"), "off by one");
  const good = mine({ prevHash: tip.hash, time: t + SP, bits: want });
  // Mid-period, at 100017: bits must stay.
  const d = c._clone();
  d.append(100016, good.bytes);
  assert.throws(() => d.append(100017, mine({ prevHash: good.hash, time: t + 2 * SP, bits: EASY }).bytes), code("bad-diffbits"));
  d.append(100017, mine({ prevHash: good.hash, time: t + 2 * SP, bits: want }).bytes);
  // Time equal to the median time past of the 11 below: too old. One second later: fine.
  const mtp = medianTimePast(Array.from({ length: 11 }, (_, i) => chain.blocks.get(100015 - i).time));
  assert.throws(() => c.append(100016, mine({ prevHash: tip.hash, time: mtp, bits: want }).bytes), code("time-too-old"));
  // More than two hours ahead of the clock: retryable, and fine once the clock catches up.
  let now = t;
  const f = newChain(chain, { now: () => now });
  for (let h = 100001; h <= 100015; h++) f.append(h, chain.blocks.get(h).header);
  const future = mine({ prevHash: tip.hash, time: t + 7201, bits: want });
  assert.throws(() => f.append(100016, future.bytes), (e) => e.code === "time-too-new" && e.retryable === true);
  assert.equal(f.status().lastError.code, "time-too-new");
  now = t + 1;
  f.append(100016, future.bytes);
  // Version floors: 3 from 100005, 4 from 100010 (TEST_RULES).
  const v = makeChain({ start: 100000, n: 9 });
  const g = newChain(v);
  for (let h = 100001; h <= 100009; h++) g.append(h, v.blocks.get(h).header);
  const top = v.blocks.get(100009);
  assert.throws(() => g.append(100010, mine({ prevHash: top.hash, time: top.time + SP, version: 3 }).bytes), code("bad-version"));
  g.append(100010, mine({ prevHash: top.hash, time: top.time + SP, version: 4 }).bytes);
  // Bits above powLimit.
  const h2 = newChain(v);
  const easy = mine({ prevHash: v.blocks.get(100000).hash, time: v.blocks.get(100000).time + SP, bits: 0x2100ffff });
  assert.throws(() => h2.append(100001, easy.bytes), code("bits-range"));
});

test("the real mainnet BIP65 rule: a version-3 header above 388381 is bad-version (checked before the clock)", () => {
  const c = new HeaderChain({ network: "mainnet" });
  const d = main(969697);
  // Version 3 changes the hash, so it fails proof of work first; the version rule is checked on
  // the rule table directly and through a chain whose rules have an easy powLimit.
  assert.throws(() => c.append(969697, encodeHeader({ ...d, version: 3 })), (e) => ["pow", "bad-version"].includes(e.code));
  assert.ok(versionFloorAt(RULES.mainnet, 969696) === 4 && 3 < versionFloorAt(RULES.mainnet, 969696));
});

/* ---------------------------------------------------------------- windowing */

test("snapshot round trip, a window sliding across boundaries, and restores that are refused", () => {
  const chain = makeChain({ start: 100000, n: 15, attestEvery: 0 });
  const c = newChain(chain, { keep: 1 }); // the floor: interval + 11 + 144 = 171
  assert.equal(c.keep, 171);
  // Extend to 400 headers above the base with correct retargets.
  let prev = chain.blocks.get(100000);
  const headers = [];
  for (let h = 100001; h <= 100400; h++) {
    const bits = nextBits(TEST_RULES, { height: h, prevBits: c.height === 100000 ? EASY : decodeHeader(headers.at(-1)).bits, prevTime: prev.time, firstTime: c.timeAt(h - 16) });
    const d = mine({ prevHash: prev.hash, time: prev.time + SP, bits });
    c.append(h, d.bytes);
    headers.push(d.bytes);
    prev = { hash: d.hash, time: d.time };
  }
  assert.equal(c.height, 100400);
  assert.equal(c.from, 100400 - 170);
  assert.equal(c.has(100100), false);
  const snap = c.snapshot();
  assert.equal(snap.v, 1);
  assert.equal(snap.from, c.from);
  assert.equal(snap.headersHex.length, 171 * 160);
  const r = HeaderChain.restore(JSON.parse(JSON.stringify(snap)), { network: "test", rules: TEST_RULES, checkpoints: [chain.base] });
  assert.equal(r.height, c.height);
  assert.equal(r.hash, c.hash);
  assert.equal(r.work, c.work);
  assert.deepEqual(r.status(), { ...c.status() });
  // Both accept the same next header (retarget at 100416 needs the kept period start).
  for (let h = 100401; h <= 100420; h++) {
    const bits = nextBits(TEST_RULES, { height: h, prevBits: decodeHeader(headers.at(-1)).bits, prevTime: prev.time, firstTime: c.timeAt(h - 16) });
    const d = mine({ prevHash: prev.hash, time: prev.time + SP, bits });
    c.append(h, d.bytes);
    r.append(h, d.bytes);
    headers.push(d.bytes);
    prev = { hash: d.hash, time: d.time };
  }
  assert.equal(r.hash, c.hash);
  // Refusals: another network, a base that is not pinned, tampered data.
  assert.throws(() => HeaderChain.restore(snap, { network: "signet" }), code("data"));
  assert.throws(() => HeaderChain.restore(snap, { network: "test", rules: TEST_RULES, checkpoints: [] }), code("checkpoint"));
  const tampered = { ...snap, headersHex: snap.headersHex.slice(0, 1600) + "00" + snap.headersHex.slice(1602) };
  assert.throws(() => HeaderChain.restore(tampered, { network: "test", rules: TEST_RULES, checkpoints: [chain.base] }));
  assert.throws(() => HeaderChain.restore({ ...snap, workHex: "1" }, { network: "test", rules: TEST_RULES, checkpoints: [chain.base] }), code("data"));
});

test("snapshot round trip of the real signet chain from its genesis checkpoint; another network's file is refused", () => {
  const c = new HeaderChain({ network: "signet", startHeight: 324592 });
  for (let h = 324593; h <= SIG_TO; h++) c.append(h, sig(h).bytes);
  const snap = JSON.parse(JSON.stringify(c.snapshot()));
  assert.equal(snap.from, 324593);
  const r = HeaderChain.restore(snap, { network: "signet", startHeight: 324592 });
  assert.equal(r.hash, c.hash);
  assert.equal(r.work, c.work);
  assert.throws(() => HeaderChain.restore(snap, { network: "mainnet" }), code("data"));
  const empty = new HeaderChain({ network: "signet" }).snapshot();
  assert.equal(HeaderChain.restore(empty, { network: "signet" }).height, 324592);
});

/* ------------------------------------------------------- sync integration */

async function syncAll(idx, api, opts = {}) {
  let tip;
  do tip = await syncIndexer(idx, api, opts);
  while (idx.height < tip && opts.to === undefined);
  return tip;
}

test("syncIndexer: identical digests with and without headers on a synthetic chain; headers=null makes exactly the old calls", async () => {
  const chain = makeChain({ start: 100000, n: 30 });
  const plain = new Indexer({ vkey: VKEY, startHeight: 100001 });
  const checked = new Indexer({ vkey: VKEY, startHeight: 100001 });
  const a = fakeSource(chain);
  const b = fakeSource(chain);
  await syncIndexer(plain, a);
  const headers = newChain(chain);
  await syncIndexer(checked, b, { headers });
  assert.equal(plain.height, 100030);
  assert.equal(checked.height, 100030);
  assert.ok(plain.log.length >= 10, "the chain carries envelopes");
  for (let h = 100001; h <= 100030; h++) assert.equal(checked.digestAt(h), plain.digestAt(h), `digest at ${h}`);
  assert.equal(headers.height, 100030);
  // The unverified path: tipHeight, then blockHash + rawBlock per height (a fresh indexer has no hash to walk back on).
  const expected = ["tipHeight"];
  for (let h = 100001; h <= 100030; h++) expected.push(`blockHash ${h}`, `rawBlock ${chain.blocks.get(h).hash.slice(0, 8)}`);
  assert.deepEqual(a.calls, expected);
  // A second run on an unchanged chain: one walk-back read and the tip.
  a.calls.length = 0;
  await syncIndexer(plain, a);
  assert.deepEqual(a.calls, ["blockHash 100030", "tipHeight"]);
});

test("syncIndexer with headers: the real signet block 324500 gives the same digest as without", async () => {
  const raw = new Uint8Array(readFileSync("test/fixtures/signet-324500.bin"));
  const block = parseBlock(raw);
  assert.equal(block.header.length, 80);
  assert.deepEqual(block.header, raw.subarray(0, 80));
  const d = decodeHeader(block.header);
  const blocks = new Map([[324500, { height: 324500, hash: block.hash, raw, header: block.header }]]);
  const chain = { blocks, tip: 324500 };
  // A test base at #324499 with this block's bits (same retarget period) and times below it.
  const base = { height: 324499, hash: block.prevHash, base: { bits: d.bits, time: d.time - 600, periodStartTime: d.time - 600 * 1000, prevTimes: Array.from({ length: 10 }, (_, i) => d.time - 600 * (11 - i)) } };
  const headers = new HeaderChain({ network: "signet", base, checkpoints: [base] });
  const plain = new Indexer({ vkey: VKEY, startHeight: 324500 });
  const checked = new Indexer({ vkey: VKEY, startHeight: 324500 });
  await syncIndexer(plain, fakeSource(chain));
  await syncIndexer(checked, fakeSource(chain), { headers });
  assert.equal(checked.digestAt(324500), plain.digestAt(324500));
  assert.equal(headers.hash, block.hash);
});

test("syncIndexer with headers refuses a block whose header breaks a rule, and applies nothing", async () => {
  const chain = makeChain({ start: 100000, n: 10 });
  // Replace block 100006 by one whose header has the right parent but the wrong bits.
  const b5 = chain.blocks.get(100005);
  const bad = mine({ prevHash: b5.hash, time: b5.time + 600, bits: 0x2007ffff, merkleRoot: hex(rev(parseBlock(chain.blocks.get(100006).raw).header.subarray(36, 68))) });
  const raw = concat(bad.bytes, chain.blocks.get(100006).raw.subarray(80));
  chain.blocks.set(100006, { height: 100006, hash: bad.hash, header: bad.bytes, raw });
  chain.tip = 100006;
  const idx = new Indexer({ vkey: VKEY, startHeight: 100001 });
  await assert.rejects(syncIndexer(idx, fakeSource(chain), { headers: newChain(chain) }), code("bad-diffbits"));
  assert.equal(idx.height, 100005, "nothing at or above the bad header was applied");
});

test("most work: an equal-work branch is refused, a lower-work one is refused and the indexer is not rolled back, a higher-work one is accepted", async () => {
  const A = makeChain({ start: 100000, n: 20, salt: 1 });
  const idx = new Indexer({ vkey: VKEY, startHeight: 100001 });
  const headers = newChain(A);
  const src = fakeSource(A);
  await syncIndexer(idx, src, { headers });
  assert.equal(idx.height, 100020);
  const before = { height: idx.height, hash: idx.hashes.get(100020), digest: idx.digestAt(100020) };

  // Equal work: fork at 100015, five other blocks (same bits).
  src.chain = makeChain({ start: 100000, n: 5, salt: 2, from: { blocks: A.blocks, forkAt: 100015 } });
  await assert.rejects(syncIndexer(idx, src, { headers }), code("less-work"));
  assert.deepEqual({ height: idx.height, hash: idx.hashes.get(100020), digest: idx.digestAt(100020) }, before, "not rolled back on a tie");
  assert.equal(headers.hash, A.blocks.get(100020).hash);
  assert.equal(headers.status().lastError.code, "less-work");

  // Lower work: three other blocks.
  src.chain = makeChain({ start: 100000, n: 3, salt: 3, from: { blocks: A.blocks, forkAt: 100015 } });
  await assert.rejects(syncIndexer(idx, src, { headers }), code("less-work"));
  assert.deepEqual({ height: idx.height, hash: idx.hashes.get(100020), digest: idx.digestAt(100020) }, before);

  // Higher work: seven other blocks. The header chain switches, the indexer rolls back to the fork and re-syncs.
  const B = makeChain({ start: 100000, n: 7, salt: 4, from: { blocks: A.blocks, forkAt: 100015 } });
  src.chain = B;
  await syncIndexer(idx, src, { headers });
  assert.equal(idx.height, 100022);
  assert.equal(idx.hashes.get(100022), B.blocks.get(100022).hash);
  assert.equal(headers.hash, B.blocks.get(100022).hash);
  assert.equal(headers.status().lastError, null);
  // The same digests as an indexer that only ever saw branch B (without headers).
  const fresh = new Indexer({ vkey: VKEY, startHeight: 100001 });
  await syncIndexer(fresh, fakeSource(B));
  for (let h = 100001; h <= 100022; h++) assert.equal(idx.digestAt(h), fresh.digestAt(h), `digest at ${h}`);
});

test("alignTo: a fresh header chain catches up to an indexer synced without headers; a disagreeing indexer is rolled back to the verified chain", async () => {
  const chain = makeChain({ start: 100000, n: 12 });
  const idx = new Indexer({ vkey: VKEY, startHeight: 100001 });
  await syncIndexer(idx, fakeSource(chain));
  const headers = newChain(chain);
  assert.deepEqual(await headers.alignTo(idx, fakeSource(chain)), { mismatchAt: null });
  assert.equal(headers.height, 100012);
  // An indexer that followed another branch above 100008 (e.g. the header file was lost after a reorg).
  const other = makeChain({ start: 100000, n: 4, salt: 9, from: { blocks: chain.blocks, forkAt: 100008 } });
  const idx2 = new Indexer({ vkey: VKEY, startHeight: 100001 });
  await syncIndexer(idx2, fakeSource(other));
  const h2 = newChain(chain);
  const src = fakeSource(chain);
  assert.deepEqual(await h2.alignTo(idx2, src), { mismatchAt: 100009 });
  await syncIndexer(idx2, src, { headers: h2 });
  assert.equal(idx2.hashes.get(100012), chain.blocks.get(100012).hash);
  assert.equal(idx2.digestAt(100012), idx.digestAt(100012));
  // An indexer holding another hash at the base checkpoint is refused outright.
  const fake = { height: 100003, startHeight: 100000, hashes: new Map([[100000, "11".repeat(32)]]) };
  await assert.rejects(newChain(chain).alignTo(fake, src), code("checkpoint"));
});

test("a source that lags behind the verified chain is not a reorg", async () => {
  const chain = makeChain({ start: 100000, n: 10 });
  const idx = new Indexer({ vkey: VKEY, startHeight: 100001 });
  const headers = newChain(chain);
  await syncIndexer(idx, fakeSource(chain), { headers });
  const lagging = { blocks: new Map([...chain.blocks].filter(([h]) => h <= 100007)), tip: 100007 };
  await syncIndexer(idx, fakeSource(lagging), { headers });
  assert.equal(idx.height, 100010);
  assert.equal(headers.height, 100010);
});

test("catchUp works over a source without headers() (blockHash + blockHeader), and a source failure is retryable", async () => {
  const chain = makeChain({ start: 100000, n: 5 });
  const src = {
    async blockHash(h) {
      const b = chain.blocks.get(h);
      if (!b) throw new Error("404");
      return b.hash;
    },
    async blockHeader(hash) {
      for (const b of chain.blocks.values()) if (b.hash === hash) return hex(b.header);
      throw new Error("404");
    },
  };
  const c = newChain(chain);
  await c.catchUp(src, 100005);
  assert.equal(c.hash, chain.blocks.get(100005).hash);
  await assert.rejects(c.catchUp(src, 100006), (e) => e.code === "source" && e.retryable);
  const failing = { headers: async () => { throw new Error("socket hang up"); } };
  await assert.rejects(newChain(chain).catchUp(failing, 100002), (e) => e.code === "source" && e.retryable);
});

/* ----------------------------------------------------------------- Esplora */

function esploraFetch({ get, tip, tamper = null, extra = {} }) {
  const seen = [];
  const f = async (url) => {
    const u = String(url);
    seen.push(u);
    const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    let m;
    if ((m = u.match(/\/blocks\/(\d+)$/))) {
      const start = Number(m[1]);
      if (start > tip) return new Response("Block not found", { status: 404 });
      const list = [];
      for (let h = start; h > start - 10; h--) {
        const d = get(h);
        list.push({
          id: tamper === h ? "ff".repeat(32) : d.hash, height: h, version: d.version, timestamp: d.time, bits: d.bits, nonce: d.nonce,
          merkle_root: d.merkleRoot, previousblockhash: d.prevHash, tx_count: 1, size: 100,
        });
      }
      return json(list);
    }
    if (u.endsWith("/blocks/tip/height")) return new Response(String(tip));
    for (const [k, v] of Object.entries(extra)) if (u.endsWith(k)) return typeof v === "string" ? new Response(v) : json(v);
    return new Response("not found", { status: 404 });
  };
  return { f, seen };
}

async function withFetch(f, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}

test("Esplora.headers: rebuilds every header from /blocks/:start, checks it against the id, pages of 10, stops at the tip", async () => {
  const api = new Esplora("https://mempool.space/signet/api", { retries: 0 });
  const { f, seen } = esploraFetch({ get: sig, tip: 324600 });
  const list = await withFetch(f, () => api.headers(324580, 21));
  assert.equal(list.length, 21);
  list.forEach((b, i) => assert.deepEqual(b, sig(324580 + i).bytes));
  assert.deepEqual(seen.map((u) => u.replace(/^.*\/api/, "")), ["/blocks/324589", "/blocks/324599", "/blocks/324600"]);
  // Asked past the tip: one 404, the tip, then the rest up to it.
  const { f: f2 } = esploraFetch({ get: sig, tip: 324600 });
  const near = await withFetch(f2, () => api.headers(324595, 10));
  assert.equal(near.length, 6);
  assert.deepEqual(near.at(-1), sig(324600).bytes);
  const { f: f3 } = esploraFetch({ get: sig, tip: 324600 });
  assert.deepEqual(await withFetch(f3, () => api.headers(324601, 5)), []);
  // A JSON view whose fields do not hash to the id is refused.
  const { f: f4 } = esploraFetch({ get: sig, tip: 324600, tamper: 324585 });
  await assert.rejects(withFetch(f4, () => api.headers(324580, 10)), /hash to/);
  // A HeaderChain fed by it verifies the real chain.
  const { f: f5 } = esploraFetch({ get: sig, tip: 324600 });
  const c = new HeaderChain({ network: "signet", startHeight: 324592 });
  await withFetch(f5, () => c.catchUp(api, 324600));
  assert.equal(c.hash, sig(324600).hash);
});

test("Esplora: nextBlockFeeRate, mempoolTxids and chainInfo", async () => {
  const txid = "ab".repeat(32);
  const { f } = esploraFetch({
    get: sig, tip: 324600,
    extra: { "/api/v1/fees/recommended": { fastestFee: 3.2, halfHourFee: 2 }, "/mempool/txids": [txid] },
  });
  const api = new Esplora("https://mempool.space/signet/api", { retries: 0 });
  await withFetch(f, async () => {
    assert.equal(await api.nextBlockFeeRate(), 4);
    assert.equal(await api.feeRate(), 2);
    assert.deepEqual(await api.mempoolTxids(), [txid]);
    assert.deepEqual(await api.chainInfo(), { chain: "signet", blocks: 324600, headers: null, ibd: null });
  });
  const plain = new Esplora("http://127.0.0.1:3002", { retries: 0 });
  const { f: g } = esploraFetch({ get: sig, tip: 7, extra: { "/fee-estimates": { 1: 7.5, 2: 5, 3: 2 } } });
  await withFetch(g, async () => {
    assert.equal(await plain.nextBlockFeeRate(), 8);
    assert.equal((await plain.chainInfo()).chain, null);
  });
  assert.equal(await withFetch(esploraFetch({ get: sig, tip: 1 }).f, () => new Esplora("https://mempool.space/api", { retries: 0 }).chainInfo()).then((r) => r.chain), "main");
});

/* ---------------------------------------------------------------- receipts */

const sigSource = (tip = SIG_TO) => ({
  async tipHeight() { return tip; },
  async headers(from, count) {
    const out = [];
    for (let h = from; h < from + count && h <= tip; h++) out.push(sig(h).bytes);
    return out;
  },
});

test("receipt header levels: checkpoint (your replay), linked, bounded, own-target", async () => {
  const at = 324594;
  const args = { height: at, hash: sig(at).hash, header: { bytes: sig(at).bytes } };
  // 1. Your own replay covers it with the same hash.
  const own = makeHeaderCheck({ network: "signet", source: sigSource(), replayHeaderAt: async (h) => (h === at ? { hash: sig(at).hash, baseHeight: 324592, linkedAbove: 6 } : null) });
  const r1 = await own(args);
  assert.equal(r1.level, "checkpoint");
  assert.equal(r1.source, "YOU");
  assert.match(r1.detail, /header chain verified by your replay from pinned checkpoint #324,592 \(proof of work and difficulty rules\)/);
  // A replay that holds another hash there (a reorg since) is not used.
  const stale = makeHeaderCheck({ network: "signet", source: sigSource(), replayHeaderAt: async () => ({ hash: "00".repeat(32), baseHeight: 324592 }) });
  assert.equal((await stale(args)).level, "linked");
  // 2. Six real headers above it link and keep their work.
  const r2 = await makeHeaderCheck({ network: "signet", source: sigSource() })(args);
  assert.equal(r2.level, "linked");
  assert.equal(r2.linkedAbove, 6);
  assert.equal(r2.source, "BTC");
  assert.match(r2.detail, /6 headers above it link to it/);
  // Fewer at the tip.
  assert.equal((await makeHeaderCheck({ network: "signet", source: sigSource(324596) })(args)).linkedAbove, 2);
  // 3. At the tip (or with a source that cannot answer): bounded by the checkpoint.
  const r3 = await makeHeaderCheck({ network: "signet", source: sigSource(at) })(args);
  assert.equal(r3.level, "bounded");
  assert.match(r3.detail, /within the difficulty bounds from pinned checkpoint #324,592/);
  const down = { tipHeight: async () => { throw new Error("offline"); }, headers: async () => [] };
  assert.equal((await makeHeaderCheck({ network: "signet", source: down })(args)).level, "bounded");
  // 4. No checkpoint for the network: its own target only.
  const r4 = await makeHeaderCheck({ network: "signet", checkpoints: [] })(args);
  assert.equal(r4.level, "own-target");
});

test("receipt header levels refuse headers that do not link or lack the work the checkpoint bounds require", async () => {
  const at = 324594;
  const args = { height: at, hash: sig(at).hash, header: { bytes: sig(at).bytes } };
  const gap = { tipHeight: async () => SIG_TO, headers: async (from, count) => sigSource().headers(from + 1, count) };
  await assert.rejects(makeHeaderCheck({ network: "signet", source: gap })(args), (e) => e instanceof CheckError && /does not link/.test(e.message));
  await assert.rejects(makeHeaderCheck({ network: "signet" })({ ...args, hash: sig(at + 1).hash }), CheckError);
  // A synthetic network whose checkpoint is far harder than a header's own (easy) target.
  const chain = makeChain({ start: 100000, n: 3, attestEvery: 0 });
  const hard = { height: 100000, hash: chain.base.hash, base: { ...chain.base.base, bits: 0x1d00ffff } };
  const easy = chain.blocks.get(100002);
  await assert.rejects(
    makeHeaderCheck({ network: "test", rules: TEST_RULES, checkpoints: [hard] })({ height: 100002, hash: easy.hash, header: { bytes: easy.header } }),
    (e) => e instanceof CheckError && /easier target than any valid/.test(e.message),
  );
  // The same header within the bounds of a matching checkpoint: bounded.
  const ok = await makeHeaderCheck({ network: "test", rules: TEST_RULES, checkpoints: [chain.base] })({ height: 100002, hash: easy.hash, header: { bytes: easy.header } });
  assert.equal(ok.level, "bounded");
});

test("verifyTx: the inclusion row carries the header level and the per-network A-9 clause", async () => {
  // A one-transaction synthetic block with a regtest-style header; the transaction has no envelope,
  // so the run ends at the envelope step, after inclusion.
  const tx = txBytes({ outpoint: concat(dsha(u32le(5)), u32le(1)), outputs: [{ value: 1000n, s: Uint8Array.of(0x51) }] });
  const cb = txBytes({ scriptSig: u32le(77), outputs: [{ value: 0n, s: Uint8Array.of(0x51) }] });
  const hashes = [dsha(cb), dsha(tx)];
  const header = mine({ prevHash: "22".repeat(32), merkleRoot: hex(rev(merkle(hashes))), time: 1_700_000_000, bits: 0x207fffff });
  const txid = hex(rev(dsha(tx)));
  const esplora = {
    base: "https://mempool.space/signet/api",
    txHex: async () => hex(tx),
    txStatus: async () => ({ confirmed: true, block_height: 500, block_hash: header.hash, block_time: header.time }),
    tipHeight: async () => 505,
    merkleProof: async () => ({ block_height: 500, merkle: [hex(rev(hashes[0]))], pos: 1 }),
    blockHeader: async () => hex(header.bytes),
  };
  const row = (r) => r.steps.find((s) => s.id === "inclusion");
  const plain = await verifyTx(txid, { esplora });
  assert.equal(row(plain).status, "ok");
  assert.match(row(plain).detail, /A-9: signet blocks are valid by a signature that is not checked, and signet proof of work is nearly free/);
  assert.match(row(plain).detail, /header meets its own difficulty target/);
  const main = await verifyTx(txid, { esplora, network: "mainnet" });
  // No header check beyond the header's own target: the mainnet clause does not claim forging is costly.
  assert.match(row(main).detail, /A-9: only the header's own proof of work was checked, which the data source can forge cheaply; your own node or your replay of the pool removes it/);
  let asked = null;
  const withCheck = await verifyTx(txid, {
    esplora,
    headerCheck: async (a) => {
      asked = a;
      return { level: "checkpoint", source: "YOU", linkedAbove: 5, detail: "header chain verified by your replay from pinned checkpoint #400 (proof of work and difficulty rules)" };
    },
  });
  assert.equal(asked.height, 500);
  assert.equal(asked.hash, header.hash);
  assert.equal(row(withCheck).source, "YOU");
  assert.match(row(withCheck).detail, /^merkle path of 1 hash rebuilds the header's merkle root · header chain verified by your replay from pinned checkpoint #400 \(proof of work and difficulty rules\) · A-9: /);
  assert.equal(withCheck.headerCheck.level, "checkpoint");
  const failing = await verifyTx(txid, { esplora, headerCheck: async () => { throw new CheckError("The header of block #501 served by the data source does not link to block #500."); } });
  assert.equal(row(failing).status, "fail");
  assert.equal(row(failing).fault, "data");
  assert.equal(chainTrustClause("signet"), "signet blocks are valid by a signature that is not checked, and signet proof of work is nearly free");
});

test("the replay's saved header chain answers replayHeaderAt (web/src/verify/replay.js)", async () => {
  const { replayHeaderAt } = await import("../web/src/verify/replay.js");
  const c = new HeaderChain({ network: "signet", startHeight: 324592 });
  for (let h = 324593; h <= 324600; h++) c.append(h, sig(h).bytes);
  const hashes = new Map(Array.from({ length: 9 }, (_, i) => [324592 + i, sig(324592 + i).hash]));
  const replay = { snapshot: { height: 324600, startHeight: 324592 }, hashes, headers: JSON.parse(JSON.stringify(c.snapshot())) };
  assert.deepEqual(await replayHeaderAt(324595, { replay }), { hash: sig(324595).hash, baseHeight: 324592, linkedAbove: 5 });
  assert.deepEqual(await replayHeaderAt(324592, { replay }), { hash: sig(324592).hash, baseHeight: 324592, linkedAbove: 8 });
  assert.equal(await replayHeaderAt(324601, { replay }), null);
  assert.equal(await replayHeaderAt(324591, { replay }), null);
  assert.equal(await replayHeaderAt(324595, { replay: { ...replay, headers: null } }), null, "a v1 record claims nothing");
  // The replay and its header chain disagree: nothing is claimed.
  const torn = new Map(hashes);
  torn.set(324596, "00".repeat(32));
  assert.equal(await replayHeaderAt(324596, { replay: { ...replay, hashes: torn } }), null);
});

test("source files: English only, line endings kept, the worker saves v2 records with headers", () => {
  const lf = ["src/btc/headers.mjs", "src/btc/headers-store.mjs", "src/btc/bitcoind.mjs", "src/btc/source.mjs", "src/sync.mjs", "src/btc/block.mjs", "scripts/checkpoint.mjs", "scripts/replay-compare.mjs", "web/src/verify/replay.js", "test/headers.test.mjs"];
  const crlf = ["src/btc/esplora.mjs", "src/verify-tx.mjs", "web/src/verify/engine.js", "web/src/verify/replay.worker.js"];
  const banned = new RegExp(`\\b(${["anony" + "mous", "untrace" + "able", "trust" + "less", "mix" + "er", "audit" + "ed"].join("|")})\\b`, "i");
  for (const f of [...lf, ...crlf]) {
    const s = readFileSync(f, "utf8");
    const lines = (s.match(/\n/g) ?? []).length;
    const crs = (s.match(/\r\n/g) ?? []).length;
    assert.equal(crs, crlf.includes(f) ? lines : 0, f);
    assert.doesNotMatch(s, CYRILLIC, f);
    if (!f.startsWith("test/")) assert.doesNotMatch(s, banned, f);
  }
  const worker = readFileSync("web/src/verify/replay.worker.js", "utf8");
  assert.match(worker, /v: 2, snapshot: idx\.snapshot\(\)/);
  assert.match(worker, /headers: headers\.snapshot\(\)/);
  assert.match(worker, /syncIndexer\(idx, esplora, \{\r?\n\s+to: Math\.min\(idx\.height \+ CHUNK, tip\),\r?\n\s+headers,/);
  assert.match(readFileSync("web/src/verify/engine.js", "utf8"), /^\s+headerCheck,\r?$/m);
  assert.ok(H.HeaderChain === HeaderChain);
});

/* ------------------------------------------------------------------- tools */

test("scripts/checkpoint.mjs makeCheckpoint rebuilds the pinned signet genesis checkpoint from headers", async () => {
  const { makeCheckpoint } = await import("../scripts/checkpoint.mjs");
  const cp = await makeCheckpoint({ network: "signet", height: 324592, source: sigSource() });
  const { label, ...pinned } = CHECKPOINTS.signet[0];
  assert.ok(label);
  assert.deepEqual({ ...cp, label: undefined }, { ...pinned, label: undefined });
  // A boundary needs only 11 headers and has periodStartTime === time.
  const b = await makeCheckpoint({ network: "signet", height: 324576, source: sigSource() });
  assert.equal(b.base.periodStartTime, b.base.time);
  // Above the tip: refused.
  await assert.rejects(makeCheckpoint({ network: "signet", height: 324600, source: sigSource(324599) }), /expected|no header/);
  // Broken linkage in what the source serves: refused.
  const gap = { tipHeight: async () => SIG_TO, headers: async (from, count) => (await sigSource().headers(from, count)).map((x, i) => (i === 3 ? sig(from).bytes : x)) };
  await assert.rejects(makeCheckpoint({ network: "signet", height: 324592, source: gap }), /does not link/);
});

test("scripts/replay-compare.mjs: identical through the tip on a synthetic chain, the first divergence named, V2-02 tickers counted", async () => {
  const { replayCompare, withTickerScan } = await import("../scripts/replay-compare.mjs");
  const envelope = await import("../src/envelope.mjs");
  const chain = makeChain({ start: 100000, n: 12 });
  const live = new Indexer({ vkey: VKEY, startHeight: 100001 });
  await syncIndexer(live, fakeSource(chain));
  const snap = JSON.parse(JSON.stringify(live.snapshot()));
  const on = await replayCompare({ snap, vkey: VKEY, api: fakeSource(chain), headers: newChain(chain), envelope, Indexer });
  assert.equal(on.ok, true);
  assert.equal(on.identicalThrough, 100012);
  assert.equal(on.compared, 12);
  const off = await replayCompare({ snap, vkey: VKEY, api: fakeSource(chain), headers: null, envelope, Indexer });
  assert.equal(off.ok, true);
  const bent = { ...snap, digests: snap.digests.map(([h, d]) => [h, h === 100007 ? "00".repeat(32) : d]) };
  const r = await replayCompare({ snap: bent, vkey: VKEY, api: fakeSource(chain), headers: newChain(chain), envelope, Indexer });
  assert.equal(r.ok, false);
  assert.equal(r.firstDivergence.height, 100007);
  assert.equal(r.identicalThrough, 100006);

  // Ticker scan: a DEPLOY whose ticker starts with a UTF-8 BOM (the only bytes the two rules
  // judge differently), a canonical one, and a lowercase one (refused by both).
  const deploy = (ticker) => envelope.encodeDeploy({ ticker, divisibility: 0, mintAmount: 1n, mintCap: 1, priceSats: 0n, treasury: new Uint8Array() });
  const withTicker = (payload, raw) => concat(payload.subarray(0, 5), Uint8Array.of(raw.length), raw, payload.subarray(6 + payload[5]));
  const bom = withTicker(deploy("ABC"), concat(Uint8Array.of(0xef, 0xbb, 0xbf), new TextEncoder().encode("ABC")));
  const lower = withTicker(deploy("ABC"), new TextEncoder().encode("abc"));
  const txs = [txBytes({ scriptSig: u32le(1), outputs: [{ value: 0n, s: Uint8Array.of(0x51) }] }),
    ...[deploy("OK1"), bom, lower].map((p, i) => txBytes({ outpoint: concat(dsha(u32le(50 + i)), u32le(0)), outputs: [{ value: 0n, s: opReturnScript(p) }] }))];
  const h = mine({ prevHash: "33".repeat(32), merkleRoot: hex(rev(merkle(txs.map((t) => dsha(t))))), time: 1 });
  const raw = concat(h.bytes, varint(txs.length), ...txs);
  const { api, v202 } = withTickerScan({ rawBlock: async () => raw, tipHeight: async () => 1 }, envelope);
  assert.deepEqual(await api.rawBlock(h.hash), raw);
  assert.equal(await api.tipHeight(), 1);
  assert.equal(v202.deploys, 3);
  assert.equal(v202.strictFailures.length, 2);
  assert.equal(v202.legacyAccepted, 1, "only the BOM ticker passes the historical decoder");
  assert.deepEqual(v202.strictFailures.map((f) => [f.tickerHex, f.legacyAccepted]), [["efbbbf414243", true], ["616263", false]]);
});

test("an indexer below the held header window (an older state file) makes the header chain start again from the base", async () => {
  const chain = makeChain({ start: 100000, n: 200, attestEvery: 0 });
  const headers = newChain(chain, { keep: 1 }); // window of 171
  await headers.catchUp(fakeSource(chain), 100200);
  assert.ok(headers.from > 100010);
  const idx = new Indexer({ vkey: VKEY, startHeight: 100001 });
  await syncIndexer(idx, fakeSource({ blocks: chain.blocks, tip: 100005 }));
  await syncIndexer(idx, fakeSource(chain), { headers });
  assert.equal(idx.height, 100200);
  assert.equal(headers.hash, chain.blocks.get(100200).hash);
});

/* ------------------------------------------------- launch review regressions */

const mainSource = (tip = MAIN_TO) => ({
  async tipHeight() { return tip; },
  async headers(from, count) {
    const out = [];
    for (let h = from; h < from + count && h <= tip; h++) out.push(main(h).bytes);
    return out;
  },
});

test("receipt (mainnet): a height the chain cannot have reached by now is refused; far from the checkpoint the bounds are weak and the receipt says so", async () => {
  const cp = CHECKPOINTS.mainnet.find((c) => c.base);
  const at = 969700;
  const args = { height: at, hash: main(at).hash, header: { bytes: main(at).bytes } };
  const soon = () => cp.base.time + 6 * 3600;
  // Near the checkpoint: linked, strong, and the receipt keeps the strong A-9 clause.
  const near = await makeHeaderCheck({ network: "mainnet", source: mainSource(), now: soon })(args);
  assert.equal(near.level, "linked");
  assert.equal(near.strong, true);
  assert.ok(near.minWorkLog2 >= 72, String(near.minWorkLog2));
  assert.match(near.detail, /forging them takes at least about 2\^\d+ hashes/);
  assert.equal(chainTrustClause("mainnet", near), "the data source can hide blocks but cannot cheaply forge proof of work; your own node removes it");
  // The source claims a height far above what any chain from the checkpoint reached by now.
  await assert.rejects(
    makeHeaderCheck({ network: "mainnet", source: mainSource(), now: soon })({ ...args, height: 1_100_000 }),
    (e) => e instanceof CheckError && /cannot have reached past about #[\d,]+ by now: the height is not credible/.test(e.message),
  );
  assert.equal(H.maxPlausibleHeight(RULES.mainnet, cp, soon()), cp.height + Math.ceil(((6 * 3600 + 7200) / 600) * 1.25) + 2016);
  // A year later, 26 periods out: the bounds reach powLimit, about 2^32 hashes per header.
  const later = () => cp.base.time + 400 * 86400;
  const far = cp.height + 26 * 2016;
  assert.equal(maxTargetAt(RULES.mainnet, cp, far), RULES.mainnet.powLimit);
  const weak = await makeHeaderCheck({ network: "mainnet", now: later })({ ...args, height: far });
  assert.equal(weak.level, "bounded");
  assert.equal(weak.strong, false);
  assert.equal(weak.minWorkLog2, 32);
  assert.match(weak.detail, /these bounds are weak this far from the checkpoint: forging it takes only about 2\^32 hashes/);
  const clause = chainTrustClause("mainnet", weak);
  assert.doesNotMatch(clause, /cannot cheaply forge/);
  assert.match(clause, /weak, so the data source could forge this block with about 2\^32 hashes/);
  // Signet keeps its wording and its detail (no work note: its blocks are valid by a signature).
  const s = await makeHeaderCheck({ network: "signet", source: sigSource() })({ height: 324594, hash: sig(324594).hash, header: { bytes: sig(324594).bytes } });
  assert.equal(s.detail, "6 headers above it link to it, each with valid proof of work within the difficulty bounds from pinned checkpoint #324,592");
  assert.equal(s.strong, undefined);
  assert.equal(chainTrustClause("signet", s), chainTrustClause("signet"));
});

test("receipt: a header at a pinned checkpoint height must be the pinned block (the header itself and the headers above it)", async () => {
  const other = sig(324593);
  await assert.rejects(
    makeHeaderCheck({ network: "signet" })({ height: 324592, hash: other.hash, header: { bytes: other.bytes } }),
    (e) => e instanceof CheckError && /Block #324,592 is pinned as 00000004…/.test(e.message),
  );
  // A checkpoint above the receipt's block: the source's header there must match it too.
  const pinnedAbove = [...CHECKPOINTS.signet, { height: 324596, hash: "00".repeat(32) }];
  await assert.rejects(
    makeHeaderCheck({ network: "signet", source: sigSource(), checkpoints: pinnedAbove })({ height: 324594, hash: sig(324594).hash, header: { bytes: sig(324594).bytes } }),
    (e) => e instanceof CheckError && /#324,596 is pinned/.test(e.message),
  );
  // The real genesis block passes.
  const ok = await makeHeaderCheck({ network: "signet", source: sigSource() })({ height: 324592, hash: sig(324592).hash, header: { bytes: sig(324592).bytes } });
  assert.equal(ok.level, "linked");
});

test("retarget bounds allow GetCompact's truncation of a 4x-clamped difficulty increase (receipt and maxTargetAt)", async () => {
  // Core: floor(a / 4) re-encoded with a 3-byte mantissa can fall below a / 4.
  const A = 0x1b7fffff;
  const a = targetFromBits(A).target;
  const clamped = targetFromBits(nextBits(RULES.mainnet, { height: 2016, prevBits: A, prevTime: 1000, firstTime: 1000 })).target;
  assert.ok(clamped * 4n < a, "the valid clamped target is below a quarter");
  assert.equal(H.minRetargetTarget(RULES.mainnet, a), clamped);
  // Going back from a checkpoint whose bits are that clamped target, the earlier target is allowed.
  assert.ok(maxTargetAt(RULES.mainnet, { height: 2016, bits: bitsFromTarget(clamped) }, 2015) >= a);
  // A receipt over that retarget on a synthetic proof-of-work network.
  const PA = 0x1f7fffff;
  const pa = targetFromBits(PA).target;
  const pbBits = nextBits(TEST_RULES, { height: 100016, prevBits: PA, prevTime: 1000, firstTime: 1000 });
  const pb = targetFromBits(pbBits).target;
  assert.ok(pb * 4n < pa);
  const h15 = mine({ prevHash: "44".repeat(32), time: 1_700_000_015, bits: PA });
  const h16 = mine({ prevHash: h15.hash, time: 1_700_000_016, bits: pbBits });
  const cp = { height: 100000, hash: "55".repeat(32), base: { bits: PA, time: 1_700_000_000, periodStartTime: 1_700_000_000, prevTimes: [] } };
  const src = { tipHeight: async () => 100016, headers: async (from) => (from === 100016 ? [h16.bytes] : []) };
  const r = await makeHeaderCheck({ network: "test", rules: TEST_RULES, checkpoints: [cp], source: src })({ height: 100015, hash: h15.hash, header: { bytes: h15.bytes } });
  assert.equal(r.level, "linked");
  assert.equal(r.linkedAbove, 1);
  // A target below the clamped minimum is still refused.
  const tooHard = mine({ prevHash: h15.hash, time: 1_700_000_016, bits: bitsFromTarget(pb / 2n) });
  const src2 = { tipHeight: async () => 100016, headers: async () => [tooHard.bytes] };
  await assert.rejects(
    makeHeaderCheck({ network: "test", rules: TEST_RULES, checkpoints: [cp], source: src2 })({ height: 100015, hash: h15.hash, header: { bytes: h15.bytes } }),
    (e) => e instanceof CheckError && /more than a factor of 4/.test(e.message),
  );
});

test("verifyTx (mainnet): the A-9 clause follows the header check's strength", async () => {
  const tx = txBytes({ outpoint: concat(dsha(u32le(6)), u32le(1)), outputs: [{ value: 1000n, s: Uint8Array.of(0x51) }] });
  const cb = txBytes({ scriptSig: u32le(78), outputs: [{ value: 0n, s: Uint8Array.of(0x51) }] });
  const hashes = [dsha(cb), dsha(tx)];
  const header = mine({ prevHash: "22".repeat(32), merkleRoot: hex(rev(merkle(hashes))), time: 1_700_000_000, bits: 0x207fffff });
  const txid = hex(rev(dsha(tx)));
  const esplora = {
    base: "https://mempool.space/api",
    txHex: async () => hex(tx),
    txStatus: async () => ({ confirmed: true, block_height: 500, block_hash: header.hash, block_time: header.time }),
    tipHeight: async () => 505,
    merkleProof: async () => ({ block_height: 500, merkle: [hex(rev(hashes[0]))], pos: 1 }),
    blockHeader: async () => hex(header.bytes),
  };
  const row = (r) => r.steps.find((s) => s.id === "inclusion");
  const weak = await verifyTx(txid, { esplora, network: "mainnet", headerCheck: async () => ({ level: "linked", source: "BTC", linkedAbove: 6, detail: "6 headers above it link to it", minWorkLog2: 34, strong: false }) });
  assert.match(row(weak).detail, /A-9: the difficulty bounds this far from a pinned checkpoint are weak, so the data source could forge this block with about 2\^34 hashes/);
  const strong = await verifyTx(txid, { esplora, network: "mainnet", headerCheck: async () => ({ level: "linked", source: "BTC", linkedAbove: 6, detail: "6 headers above it link to it", minWorkLog2: 80, strong: true }) });
  assert.match(row(strong).detail, /A-9: the data source can hide blocks but cannot cheaply forge proof of work/);
});

test("offer(): a competing branch longer than the header window is compared by work (no TypeError) and taken", async () => {
  const A = makeChain({ start: 100000, n: 20, salt: 11, attestEvery: 0 });
  const headers = newChain(A, { keep: 1 }); // window of 171 headers
  await headers.catchUp(fakeSource(A), 100020);
  const B = makeChain({ start: 100000, n: 400, salt: 12, attestEvery: 0, from: { blocks: A.blocks, forkAt: 100015 } });
  const r = await headers.offer(fakeSource(B), 100015);
  assert.deepEqual(r, { switched: true, forkHeight: 100015, tipHeight: 100415 });
  assert.equal(headers.hash, B.blocks.get(100415).hash);
  assert.ok(headers.from > 100015, "the window slid past the fork point");
  // A shorter branch from the same point is still refused as less work.
  const C = makeChain({ start: 100000, n: 2, salt: 13, attestEvery: 0, from: { blocks: B.blocks, forkAt: 100400 } });
  await assert.rejects(headers.offer(fakeSource(C), 100400), code("less-work"));
});

test("alignTo: when the header file lags the indexer and the source serves a less-work branch, the indexer keeps its branch (most work), then follows a branch with more", async () => {
  const A = makeChain({ start: 100000, n: 12, salt: 21 });
  const idx = new Indexer({ vkey: VKEY, startHeight: 100001 });
  await syncIndexer(idx, fakeSource(A));
  const before = { height: idx.height, hash: idx.hashes.get(100012), digest: idx.digestAt(100012) };
  // A source that now serves branch B from 100009 (two blocks: less work) but still knows A's blocks by hash.
  const withA = (chain) => {
    const s = fakeSource(chain);
    const raw = s.rawBlock;
    s.rawBlock = async (hash) => {
      for (const b of A.blocks.values()) if (b.hash === hash) return b.raw;
      return raw(hash);
    };
    return s;
  };
  const B = makeChain({ start: 100000, n: 2, salt: 22, from: { blocks: A.blocks, forkAt: 100008 } });
  const headers = newChain(A); // a fresh (lagging) header chain
  const r = await headers.alignTo(idx, withA(B));
  assert.deepEqual(r, { mismatchAt: null, adopted: 100009 });
  assert.equal(headers.hash, A.blocks.get(100012).hash);
  await assert.rejects(syncIndexer(idx, withA(B), { headers: newChain(A) }), code("less-work"));
  assert.deepEqual({ height: idx.height, hash: idx.hashes.get(100012), digest: idx.digestAt(100012) }, before, "not rolled back onto less work");
  // Branch C from the same point with more work: followed.
  const C = makeChain({ start: 100000, n: 6, salt: 23, from: { blocks: A.blocks, forkAt: 100008 } });
  const h2 = newChain(A);
  await syncIndexer(idx, withA(C), { headers: h2 });
  assert.equal(idx.hashes.get(100014), C.blocks.get(100014).hash);
  assert.equal(h2.hash, C.blocks.get(100014).hash);
});

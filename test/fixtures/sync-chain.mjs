// Synthetic chains and a recording fake chain source, shared by test/headers.test.mjs and
// test/sync-prefetch.test.mjs. Easy proof of work, a 16-block retarget interval, 1-second spacing.
import { readFileSync } from "node:fs";
import { sha256 } from "@noble/hashes/sha256";
import { HeaderChain, decodeHeader, encodeHeader, targetFromBits, nextBits } from "../../src/btc/headers.mjs";
import { ATTEST_KIND, encodeAttest, opReturnScript } from "../../src/envelope.mjs";
import { concat, hex, u32le, u64le } from "../../src/bytes.mjs";

export const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
export const dsha = (b) => sha256(sha256(b));
export const rev = (b) => Uint8Array.from(b).reverse();


// Easy proof of work for synthetic headers: powLimit 0x207fffff (regtest), a 16-block retarget
// interval and 1-second spacing. Core computes the retarget as target * timespan on 256 bits
// (truncated), so synthetic targets stay below 2^250 (EASY) to keep that product in range.
export const SP = 1;
export const TEST_RULES = Object.freeze({
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
export const EASY = 0x2001ffff; // about 1 in 128 hashes meets it

export function mine({ prevHash, merkleRoot = "11".repeat(32), time, bits = EASY, version = 4 }) {
  const { target } = targetFromBits(bits);
  for (let nonce = 0; ; nonce++) {
    const bytes = encodeHeader({ version, prevHash, merkleRoot, time, bits, nonce });
    const d = decodeHeader(bytes);
    if (BigInt("0x" + d.hash) <= target) return d;
  }
}

export const varint = (n) => (n < 0xfd ? Uint8Array.of(n) : concat(Uint8Array.of(0xfd), Uint8Array.of(n & 0xff, n >> 8)));
export const script = (s) => concat(varint(s.length), s);
export function txBytes({ outpoint = new Uint8Array(36).fill(0).map((_, i) => (i >= 32 ? 0xff : 0)), scriptSig = new Uint8Array(0), outputs }) {
  return concat(
    u32le(1), varint(1), outpoint, script(scriptSig), u32le(0xffffffff),
    varint(outputs.length), ...outputs.map(({ value, s }) => concat(u64le(value), script(s))), u32le(0),
  );
}
export function merkle(hashes) {
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
export function makeChain({ start = 100000, n = 20, rules = TEST_RULES, t0 = 1_700_000_000, salt = 0, attestEvery = 3, from = null, bits = EASY } = {}) {
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

/**
 * A fake chain source over one chain at a time (swap `source.chain` for a reorg). Records calls.
 * Options (all off by default, which gives the plain recording source):
 *   rawDelay  ms (or (height, n) => ms) every rawBlock takes; an abort of the passed signal rejects it
 *   onRaw     (n, height, source) called when the n-th rawBlock starts; it may throw or bump source.throttled
 * It also counts rawBlock calls in flight (inFlight, maxInFlight), resolved ones (rawDone) and records the
 * signal each call got (signals), and has a `throttled` count like the Esplora client.
 */
export function fakeSource(chain, { rawDelay = 0, onRaw = null } = {}) {
  const s = {
    chain,
    calls: [],
    throttled: 0,
    inFlight: 0,
    maxInFlight: 0,
    rawStarted: 0,
    rawDone: 0,
    signals: [],
    async tipHeight() { s.calls.push("tipHeight"); return s.chain.tip; },
    async blockHash(h) {
      s.calls.push(`blockHash ${h}`);
      const b = s.chain.blocks.get(h);
      if (!b) throw new Error(`GET /block-height/${h}: 404 Block not found`);
      return b.hash;
    },
    async rawBlock(hash, opts) {
      s.calls.push(`rawBlock ${hash.slice(0, 8)}`);
      const n = ++s.rawStarted;
      const signal = opts?.signal;
      let found = null;
      for (const b of s.chain.blocks.values()) if (b.hash === hash) found = b;
      s.signals.push({ n, height: found?.height ?? null, signal });
      s.inFlight += 1;
      s.maxInFlight = Math.max(s.maxInFlight, s.inFlight);
      try {
        onRaw?.(n, found?.height ?? null, s);
        const ms = typeof rawDelay === "function" ? rawDelay(found?.height ?? null, n) : rawDelay;
        if (ms > 0) {
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, ms);
            signal?.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
          });
        }
        if (!found) throw new Error("404");
        s.rawDone += 1;
        return found.raw;
      } finally {
        s.inFlight -= 1;
      }
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

export const newChain = (c, opts = {}) => new HeaderChain({ network: "test", rules: TEST_RULES, checkpoints: [c.base], base: c.base, ...opts });

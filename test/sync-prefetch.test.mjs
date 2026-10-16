// Block prefetch and header-page hashes in the verified sync path (src/sync.mjs blockFeed,
// docs/design/mainnet-readiness.md section 3.4 step 3a). Offline: synthetic chains from
// test/fixtures/sync-chain.mjs plus one real signet block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SYNC_PREFETCH, SYNC_PREFETCH_MAX, parsePrefetch, syncIndexer, blockFeed } from "../src/sync.mjs";
import { HeaderChain, decodeHeader } from "../src/btc/headers.mjs";
import { parseBlock } from "../src/btc/block.mjs";
import { Indexer } from "../src/indexer.mjs";
import { Esplora } from "../src/btc/esplora.mjs";
import { openChainSource } from "../src/btc/source.mjs";
import { VKEY, makeChain, fakeSource, newChain, mine } from "./fixtures/sync-chain.mjs";
import { concat, hex } from "../src/bytes.mjs";

const fresh = () => new Indexer({ vkey: VKEY, startHeight: 100001 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const digests = (idx, from, to) => {
  const out = [];
  for (let h = from; h <= to; h++) out.push(idx.digestAt(h));
  return out;
};
/** Wraps idx.applyBlock: records the heights in order, never two at once; `delay` ms per block. */
function recordApplies(idx, delay = 0) {
  const heights = [];
  let busy = false;
  const real = idx.applyBlock.bind(idx);
  idx.applyBlock = async (b) => {
    assert.equal(busy, false, "applyBlock never runs concurrently");
    busy = true;
    try {
      heights.push(b.height);
      if (delay) await sleep(delay);
      return await real(b);
    } finally {
      busy = false;
    }
  };
  return heights;
}
/** A seeded generator (mulberry32) for repeatable "random" delays. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("T1 header pages replace blockHash on a long run, with the same digests as the plain path", async () => {
  const chain = makeChain({ start: 100000, n: 30 });
  const plain = fresh();
  await syncIndexer(plain, fakeSource(chain));
  const idx = fresh();
  const src = fakeSource(chain);
  await syncIndexer(idx, src, { headers: newChain(chain) });
  assert.equal(idx.height, 100030);
  for (let h = 100001; h <= 100030; h++) assert.ok(!src.calls.includes(`blockHash ${h}`), `no blockHash ${h}`);
  assert.ok(src.calls.some((c) => c.startsWith("headers ")), "header pages were used");
  assert.equal(src.calls.filter((c) => c.startsWith("rawBlock ")).length, 30, "one raw block per applied block");
  assert.deepEqual(digests(idx, 100001, 100030), digests(plain, 100001, 100030));
  assert.ok(idx.log.length >= 10);
});

test("T2 downloads overlap: the window is the prefetch setting", async () => {
  const chain = makeChain({ start: 100000, n: 30 });
  const run = async (opts) => {
    const src = fakeSource(chain, { rawDelay: 20 });
    const idx = fresh();
    await syncIndexer(idx, src, { headers: newChain(chain), ...opts });
    assert.equal(idx.height, 100030);
    return src.maxInFlight;
  };
  assert.equal(await run({}), SYNC_PREFETCH);
  assert.equal(await run({ prefetch: 8 }), 8);
  assert.equal(await run({ prefetch: 1 }), 1);
});

test("T3 memory cap: no more than k blocks are fetched ahead of the ones taken, and the lead reaches k", async () => {
  const chain = makeChain({ start: 100000, n: 40 });
  for (const k of [2, 8]) {
    const src = fakeSource(chain);
    const idx = fresh();
    let started = 0;
    let maxLead = 0;
    const real = idx.applyBlock.bind(idx);
    idx.applyBlock = async (b) => {
      started += 1;
      // Fetched but not yet taken: everything that resolved, minus the blocks taken so far (this one included).
      const lead = src.rawDone - started;
      maxLead = Math.max(maxLead, lead);
      assert.ok(lead <= k, `lead ${lead} <= ${k} at ${b.height}`);
      await sleep(10);
      return real(b);
    };
    await syncIndexer(idx, src, { headers: newChain(chain), prefetch: k });
    assert.equal(idx.height, 100040);
    assert.equal(maxLead, k, `the lead reaches ${k}`);
  }
});

test("T4 a 429 halves the window, and it grows back by one per 16 blocks", async () => {
  const chain = makeChain({ start: 100000, n: 70 });
  const startFlight = [];
  const src = fakeSource(chain, {
    rawDelay: 5,
    onRaw: (n, _h, s) => {
      if (n === 3) s.throttled += 1;
      startFlight[n] = s.inFlight;
    },
  });
  const idx = fresh();
  await syncIndexer(idx, src, { headers: newChain(chain), prefetch: 4 });
  assert.equal(idx.height, 100070);
  assert.equal(Math.max(...startFlight.slice(1, 5)), 4, "the window was 4 before the 429");
  const after = startFlight.slice(6, 19);
  assert.ok(Math.max(...after) <= 2, `window <= 2 after the 429, saw ${Math.max(...after)}`);
  assert.equal(Math.max(...startFlight.slice(21, 36)), 3, "one step back after 16 calm blocks");
  assert.equal(Math.max(...startFlight.slice(45)), 4, "back to 4 after enough calm blocks");
});

test("T5 a failed download stops the run at its own height, aborts the rest, and leaves no unhandled rejection", async () => {
  const chain = makeChain({ start: 100000, n: 20 });
  const first = 100001;
  const src = fakeSource(chain, {
    rawDelay: (h) => (h === first + 5 ? 0 : 50),
    onRaw: (_n, h) => {
      if (h === first + 5) throw new Error("boom");
    },
  });
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const idx = fresh();
    const headers = newChain(chain);
    await assert.rejects(syncIndexer(idx, src, { headers, prefetch: 8 }), /^Error: boom$/);
    assert.equal(idx.height, first + 4, "every lower block was applied");
    assert.equal(headers.height, first + 4);
    assert.ok(src.signals.length > 6);
    for (const { signal } of src.signals) assert.equal(signal?.aborted, true);
    await sleep(120);
    assert.equal(src.inFlight, 0, "nothing is still downloading");
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("T6 MURKLE_SYNC_PREFETCH: default 4, 1 to 16 accepted, anything else refused at startup", async () => {
  const msg = (v) => `MURKLE_SYNC_PREFETCH must be a whole number from 1 to 16, not ${v}`;
  assert.equal(SYNC_PREFETCH, 4);
  assert.equal(SYNC_PREFETCH_MAX, 16);
  for (const v of [undefined, null, ""]) assert.equal(parsePrefetch(v), 4);
  assert.equal(parsePrefetch("8"), 8);
  assert.equal(parsePrefetch(16), 16);
  assert.equal(parsePrefetch("1"), 1);
  for (const v of ["0", "17", "2.5", "abc", 0, 17, 2.5, "-1", NaN]) {
    assert.throws(() => parsePrefetch(v), { message: msg(v) }, String(v));
  }
  const open = (value) => openChainSource({ network: "signet", read: (name) => (name === "SYNC_PREFETCH" ? value : undefined), log: null });
  assert.equal((await open(undefined)).prefetch, 4);
  const eight = await open("8");
  assert.equal(eight.prefetch, 8);
  assert.match(eight.describe(), /, 8 block downloads at a time$/);
  for (const v of ["0", "17", "2.5", "abc"]) await assert.rejects(open(v), { message: msg(v) });
});

test("T7 Esplora.rawBlock passes the abort signal on; a 429 answer is counted", async () => {
  const api = new Esplora("https://example.invalid/api", { retries: 0 });
  assert.equal(api.throttled, 0);
  const inits = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    inits.push(init);
    if (String(url).endsWith("/tip/height")) return new Response("busy", { status: 429 });
    return new Response(Uint8Array.of(1, 2, 3));
  };
  try {
    const ac = new AbortController();
    assert.deepEqual(await api.rawBlock("ab".repeat(32), { signal: ac.signal }), Uint8Array.of(1, 2, 3));
    assert.equal(inits[0].signal, ac.signal);
    await api.rawBlock("ab".repeat(32));
    assert.equal(inits[1], undefined, "no init without a signal: the call is as before");
    assert.equal(api.throttled, 0);
    // attempt 5 is the last one: the 429 is counted and then reported, with no backoff sleep.
    await assert.rejects(api.requestUrl(api.base + "/blocks/tip/height", "/blocks/tip/height", undefined, 5), /429/);
    assert.equal(api.throttled, 1);
  } finally {
    globalThis.fetch = saved;
  }
});

test("T8 determinism: same digests, log and apply order for any window, pages on or off, any completion order", async () => {
  const chain = makeChain({ start: 100000, n: 40 });
  const plain = fresh();
  await syncIndexer(plain, fakeSource(chain));
  const want = digests(plain, 100001, 100040);
  const order = Array.from({ length: 40 }, (_, i) => 100001 + i);
  const cases = [];
  for (const k of [1, 4, 16]) for (const pages of [true, false]) cases.push({ k, pages, random: false });
  for (const [k, seed] of [[4, 1], [16, 2], [8, 3]]) cases.push({ k, pages: true, random: seed });
  for (const { k, pages, random } of cases) {
    const rand = random ? rng(random) : null;
    const src = fakeSource(chain, { rawDelay: rand ? () => Math.floor(rand() * 31) : 0 });
    if (!pages) src.headers = undefined;
    const idx = fresh();
    const heights = recordApplies(idx);
    await syncIndexer(idx, src, { headers: newChain(chain), prefetch: k });
    const label = `k=${k} pages=${pages} random=${random}`;
    assert.equal(idx.height, 100040, label);
    assert.deepEqual(digests(idx, 100001, 100040), want, label);
    assert.deepEqual(idx.log, plain.log, label);
    assert.deepEqual(heights, order, label);
    if (!pages) assert.equal(src.calls.filter((c) => c.startsWith("blockHash ")).length, 40, label);
  }
});

test("T9 the real signet block 324500 gives the same digest at k = 1 and k = 4", async () => {
  const raw = new Uint8Array(readFileSync("test/fixtures/signet-324500.bin"));
  const block = parseBlock(raw);
  const d = decodeHeader(block.header);
  const blocks = new Map([[324500, { height: 324500, hash: block.hash, raw, header: block.header }]]);
  const chain = { blocks, tip: 324500 };
  const base = { height: 324499, hash: block.prevHash, base: { bits: d.bits, time: d.time - 600, periodStartTime: d.time - 600 * 1000, prevTimes: Array.from({ length: 10 }, (_, i) => d.time - 600 * (11 - i)) } };
  const plain = new Indexer({ vkey: VKEY, startHeight: 324500 });
  await syncIndexer(plain, fakeSource(chain));
  for (const prefetch of [1, 4]) {
    const headers = new HeaderChain({ network: "signet", base, checkpoints: [base] });
    const idx = new Indexer({ vkey: VKEY, startHeight: 324500 });
    await syncIndexer(idx, fakeSource(chain), { headers, prefetch });
    assert.equal(idx.digestAt(324500), plain.digestAt(324500), `k=${prefetch}`);
    assert.equal(headers.hash, block.hash);
  }
});

test("T10 k = 1 on a short run makes exactly the calls the code before the prefetch change made", async () => {
  const chain = makeChain({ start: 100000, n: 5 });
  const src = fakeSource(chain);
  await syncIndexer(fresh(), src, { headers: newChain(chain), prefetch: 1 });
  // Captured on d66520e (before this change): tipHeight, then blockHash + rawBlock per height.
  assert.deepEqual(src.calls, [
    "tipHeight",
    "blockHash 100001", "rawBlock 003cc04d",
    "blockHash 100002", "rawBlock 016e7d0c",
    "blockHash 100003", "rawBlock 0166f488",
    "blockHash 100004", "rawBlock 00647161",
    "blockHash 100005", "rawBlock 0198d85e",
  ]);
});

test("T10b k = 1 starts no download while a block is being applied; k = 2 does", async () => {
  const chain = makeChain({ start: 100000, n: 6 });
  const run = async (k) => {
    const src = fakeSource(chain);
    const idx = fresh();
    const real = idx.applyBlock.bind(idx);
    idx.applyBlock = async (b) => {
      src.calls.push(`apply ${b.height}`);
      await sleep(15); // long enough for a download started now to show up before the apply ends
      src.calls.push(`applied ${b.height}`);
      return real(b);
    };
    await syncIndexer(idx, src, { headers: newChain(chain), prefetch: k });
    assert.equal(idx.height, 100006);
    return src.calls;
  };
  const between = (calls, h) => calls.slice(calls.indexOf(`apply ${h}`), calls.indexOf(`applied ${h}`)).filter((c) => /^(blockHash|rawBlock|headers)/.test(c));
  const one = await run(1);
  for (let h = 100001; h < 100006; h++) assert.deepEqual(between(one, h), [], `no call while block ${h} is applied (k = 1)`);
  const two = await run(2);
  assert.ok(between(two, 100002).length > 0, "with k = 2 the next download runs during the apply");
});

test("T11 a block whose header breaks a rule is refused with everything below it applied (default window)", async () => {
  const chain = makeChain({ start: 100000, n: 10 });
  const b5 = chain.blocks.get(100005);
  const bad = mine({ prevHash: b5.hash, time: b5.time + 600, bits: 0x2007ffff, merkleRoot: hex(Uint8Array.from(parseBlock(chain.blocks.get(100006).raw).header.subarray(36, 68)).reverse()) });
  const raw = concat(bad.bytes, chain.blocks.get(100006).raw.subarray(80));
  chain.blocks.set(100006, { height: 100006, hash: bad.hash, header: bad.bytes, raw });
  chain.tip = 100006;
  for (const delay of [0, 10]) {
    const idx = fresh();
    await assert.rejects(syncIndexer(idx, fakeSource(chain, { rawDelay: delay }), { headers: newChain(chain) }), (e) => e.code === "bad-diffbits");
    assert.equal(idx.height, 100005, "nothing at or above the bad header was applied");
  }
});

test("T12 a reorg while blocks are prefetched ends the run cleanly, and the next run follows the heavier branch", async () => {
  for (const forkAt of [100006, 100003]) {
    const A = makeChain({ start: 100000, n: 20, salt: 1 });
    const B = makeChain({ start: 100000, n: 20, salt: 2, from: { blocks: A.blocks, forkAt } });
    const idx = fresh();
    const headers = newChain(A);
    const src = fakeSource(A, { rawDelay: 2 });
    let switched = false;
    const onBlock = (h) => {
      if (h === 100005 && !switched) {
        switched = true;
        src.chain = B;
      }
    };
    try {
      await syncIndexer(idx, src, { headers, onBlock });
    } catch (e) {
      assert.match(e.message, /^(404|reorg at \d+ during sync; run again)$/, `fork at ${forkAt}`);
    }
    assert.ok(idx.height >= 100005 && idx.height <= 100020);
    assert.ok(headers.height <= idx.height, "the header chain never runs ahead of the indexer");
    const tip = await syncIndexer(idx, src, { headers });
    assert.equal(tip, B.tip);
    assert.equal(idx.height, B.tip);
    assert.equal(idx.hashes.get(B.tip), B.blocks.get(B.tip).hash);
    const ref = fresh();
    await syncIndexer(ref, fakeSource(B));
    assert.deepEqual(digests(idx, 100001, B.tip), digests(ref, 100001, B.tip), `fork at ${forkAt}`);
  }
});

test("T13 the tip moving mid-run is picked up by the next run; a lying page ends in a hash mismatch", async () => {
  const chain = makeChain({ start: 100000, n: 30 });
  chain.tip = 100020;
  const idx = fresh();
  const headers = newChain(chain);
  const src = fakeSource(chain);
  const tip = await syncIndexer(idx, src, { headers, onBlock: () => { chain.tip = Math.min(100030, chain.tip + 3); } });
  assert.equal(tip, 100020);
  assert.equal(idx.height, 100020);
  assert.equal(src.calls.filter((c) => c.startsWith("rawBlock ")).length, 20, "nothing above the first tip was fetched");
  for (const c of src.calls.filter((c) => c.startsWith("headers "))) {
    const [from, n] = c.split(" ").slice(1).map(Number);
    assert.ok(from + n - 1 <= 100020, c);
  }
  assert.equal(await syncIndexer(idx, src, { headers }), 100030);
  assert.equal(idx.height, 100030);

  // A page that names another chain's header at one height: the download does not match, nothing from there on is applied.
  const real = makeChain({ start: 100000, n: 30 });
  const other = makeChain({ start: 100000, n: 30, salt: 5 });
  const liar = other.blocks.get(100010).hash;
  const lying = fakeSource(real);
  const pageOf = lying.headers.bind(lying);
  lying.headers = async (from, count) => {
    const list = await pageOf(from, count);
    return list.map((bytes, i) => (from + i === 100010 ? other.blocks.get(100010).header : bytes));
  };
  const rawOf = lying.rawBlock.bind(lying);
  lying.rawBlock = (hash, o) => rawOf(hash === liar ? real.blocks.get(100010).hash : hash, o);
  const idx2 = fresh();
  await assert.rejects(syncIndexer(idx2, lying, { headers: newChain(real) }), { message: "block 100010: hash mismatch" });
  assert.equal(idx2.height, 100009);
  assert.equal(idx2.hashes.has(100010), false);
});

test("T14 an unchanged chain costs the same two calls as before and starts no feed", async () => {
  const chain = makeChain({ start: 100000, n: 12 });
  const idx = fresh();
  const headers = newChain(chain);
  const src = fakeSource(chain);
  await syncIndexer(idx, src, { headers });
  src.calls.length = 0;
  await syncIndexer(idx, src, { headers });
  assert.deepEqual(src.calls, ["tipHeight", "blockHash 100012"]);
});

test("blockFeed: heights must be taken in order, a short page falls back to blockHash, a failing page is never fatal", async () => {
  const chain = makeChain({ start: 100000, n: 24 });
  const src = fakeSource(chain);
  const feed = blockFeed(src, { from: 100001, to: 100024, k: 4, pages: true });
  await assert.rejects(feed.take(100003), /out of order/);
  const got = [];
  for (let h = 100001; h <= 100024; h++) got.push((await feed.take(h)).hash);
  feed.close();
  assert.deepEqual(got, Array.from({ length: 24 }, (_, i) => chain.blocks.get(100001 + i).hash));
  assert.ok(feed.stats.pages >= 2);

  // The source answers a short page (the tip lagging): the rest comes from blockHash.
  const shortSrc = fakeSource(chain);
  const pageOf = shortSrc.headers.bind(shortSrc);
  shortSrc.headers = async (from, count) => (await pageOf(from, count)).slice(0, 5);
  const f2 = blockFeed(shortSrc, { from: 100001, to: 100024, k: 4, pages: true });
  for (let h = 100001; h <= 100024; h++) assert.equal((await f2.take(h)).hash, chain.blocks.get(h).hash);
  f2.close();
  assert.ok(shortSrc.calls.includes("blockHash 100010"));

  const broken = fakeSource(chain);
  broken.headers = async () => { throw new Error("pages are down"); };
  const f3 = blockFeed(broken, { from: 100001, to: 100024, k: 4, pages: true });
  for (let h = 100001; h <= 100024; h++) assert.equal((await f3.take(h)).hash, chain.blocks.get(h).hash);
  f3.close();
});

test("new files: English only, LF line endings", () => {
  const cyr = new RegExp(`[${String.fromCharCode(0x400)}-${String.fromCharCode(0x4ff)}]`);
  for (const f of ["test/sync-prefetch.test.mjs", "test/fixtures/sync-chain.mjs", "src/sync.mjs"]) {
    const s = readFileSync(f, "utf8");
    assert.doesNotMatch(s, cyr, f);
    assert.doesNotMatch(s, /\r\n/, f);
  }
});

test("T4b a 429 backoff outlives one syncIndexer call: the next call on the same source starts narrow", async () => {
  const chain = makeChain({ start: 100000, n: 20 });
  const src = fakeSource(chain, {
    rawDelay: 5,
    onRaw: (n, _h, s) => {
      if (n === 2) s.throttled += 1; // during the first call only
    },
  });
  const idx = fresh();
  const headers = newChain(chain);
  await syncIndexer(idx, src, { headers, prefetch: 4, to: 100010 });
  assert.equal(idx.height, 100010);
  const before = src.rawStarted;
  let maxStart = 0;
  src.signals.length = 0;
  const startFlight = [];
  const real = src.rawBlock.bind(src);
  src.rawBlock = (hash, opts) => {
    const p = real(hash, opts);
    startFlight.push(src.inFlight);
    return p;
  };
  await syncIndexer(idx, src, { headers, prefetch: 4 });
  assert.equal(idx.height, 100020);
  maxStart = Math.max(...startFlight.slice(0, 4)); // calm blocks of the first call count: the window grows back later
  assert.ok(src.rawStarted - before === 10);
  assert.ok(maxStart <= 2, `the second call starts with the reduced window (saw ${maxStart} in flight)`);
  // a source that was never throttled still gets the full window
  const clean = fakeSource(chain, { rawDelay: 5 });
  await syncIndexer(fresh(), clean, { headers: newChain(chain), prefetch: 4 });
  assert.equal(clean.maxInFlight, 4);
});

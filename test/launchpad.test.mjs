// Public launchpad and explorer: the pure helpers behind the landing page, /mints,
// /t/:ticker, /explorer and /protocol, run in Node without a DOM. Also guards the copy rules
// (visual.md section 2) in every launchpad and explorer file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderMarkdown, inline, slugify } from "../web/src/share/markdown.js";
import {
  blocksUntilOpen, blocksLeft, pillFor, scheduleText, filterAssets, sortAssets, boardGroups, launchCard,
  supplyCheck, recountMints, termsDiff, mintLabel, priceText,
} from "../web/src/share/launch.js";
import { launchCardModel, shareText, xIntentUrl, CARD_W, CARD_H } from "../web/src/share/launch-card.js";
import { windowCounts, mintsChart, crowdSeries, crowdChart, blockStrip, blockOpsText } from "../web/src/share/charts.js";
import { logTail, matchesFilter, publicData, entrySeal, opDisplay, assetIndex } from "../web/src/share/feed.js";
import { wallEntries, verifierCandidates, pickDefault, candidateLabel, wallVerdict, wallSummary } from "../web/src/share/wall.js";
import { CachedEsplora } from "../web/src/share/cached-esplora.js";
import { encodeDeploy, decodeEnvelope } from "../src/envelope.mjs";

const TXID = (c) => c.repeat(64).slice(0, 64);

const asset = (over = {}) => ({
  id: "4294967298",
  ticker: "ABC",
  divisibility: 2,
  mintAmount: "100000",
  mintCap: 1000,
  minted: 412,
  supply: "41200000",
  maxSupply: "100000000",
  priceSats: "1000",
  treasury: "5120" + "11".repeat(32),
  treasuryAddress: "tb1pexampletreasuryaddressxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  startHeight: 0,
  endHeight: 0,
  status: "live",
  deployTxid: TXID("4e"),
  deployHeight: 262880,
  firstMintHeight: 262881,
  soldOutHeight: null,
  treasurySats: "412000",
  rejectedMints: 3,
  burnedSats: "3000",
  mints144: 40,
  ...over,
});

/* ---------- markdown ---------- */

test("markdown: escapes everything, keeps only safe links, never formats code", () => {
  const { html } = renderMarkdown("# Title <script>\n\nHello <img src=x onerror=1> **bold** *it* `a*b*<c>` snake_case_name\n\n[ok](https://example.com/a_b_c) [rel](/t/ABC) [frag](#x) [bad](javascript:alert) [[alloc] init]");
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img src=x onerror=1&gt;"));
  assert.ok(html.includes("<strong>bold</strong>") && html.includes("<em>it</em>"));
  assert.ok(html.includes("<code>a*b*&lt;c&gt;</code>"));
  assert.ok(html.includes("snake_case_name"));
  assert.ok(html.includes('<a href="https://example.com/a_b_c" target="_blank" rel="noopener noreferrer">ok</a>'));
  assert.ok(html.includes('<a href="/t/ABC" data-link>rel</a>') && html.includes('<a href="#x" data-link>frag</a>'));
  assert.ok(!html.includes("javascript:"));
  assert.ok(html.includes("[[alloc] init]"));
  assert.equal(inline("x \u0000 y").includes("\u0000"), true); // inline is raw-text safe; renderMarkdown strips NUL
  assert.ok(!renderMarkdown("a\u0000b").html.includes("\u0000"));
});

test("markdown: headings, tables, nested and numbered lists, fences", () => {
  const src = [
    "## 1. First `code` part",
    "",
    "| Field | Bytes |",
    "|---|---:|",
    "| magic `a|b` | 5 |",
    "",
    "0. zero",
    "1. one, with a lazy",
    "continuation line",
    "   - nested a",
    "   - nested b",
    "",
    "   a second paragraph",
    "2. two",
    "",
    "```js",
    "const x = '<b>';",
    "```",
    "",
    "## 1. First code part",
  ].join("\n");
  const { html, toc } = renderMarkdown(src, { idPrefix: "s-" });
  assert.deepEqual(toc.map((t) => t.id), ["s-1-first-code-part", "s-1-first-code-part-2"]);
  assert.ok(html.includes('<h2 id="s-1-first-code-part" class="md-h md-h2">1. First <code>code</code> part</h2>'));
  assert.ok(html.includes('<th style="text-align:right">Bytes</th>'));
  assert.ok(html.includes("<td>magic <code>a|b</code></td>"), "pipes inside code spans stay in the cell");
  assert.ok(html.includes('<ol class="md-ol" start="0">'));
  assert.ok(html.includes("<li>one, with a lazy continuation line<ul"));
  assert.ok(html.includes("<li>nested b</li></ul><p>a second paragraph</p></li><li>two</li>"));
  assert.ok(html.includes("<pre class=\"md-pre\" data-lang=\"js\"><code>const x = &#39;&lt;b&gt;&#39;;</code></pre>"));
  assert.equal(slugify("5. `TRANSACT` envelope (op = 0x01), 471 bytes"), "5-transact-envelope-op-0x01-471-bytes");
});

test("markdown renders the real SPEC.md with every section and no raw markup", () => {
  const spec = readFileSync("SPEC.md", "utf8");
  const { html, toc } = renderMarkdown(spec);
  const h2 = toc.filter((t) => t.level === 2).map((t) => t.text);
  assert.ok(h2.length >= 10, `expected the spec's sections, got ${h2.length}`);
  assert.ok(h2.some((t) => /TRANSACT/.test(t)) && h2.some((t) => /Genesis/.test(t)) && h2.some((t) => /digest/i.test(t)));
  assert.ok(html.includes("<table") && html.includes("<ol") && html.includes("<code>"));
  // Every tag in the output is one the renderer emits.
  const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]));
  for (const t of tags) assert.ok(["h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td", "div", "code", "pre", "strong", "em", "a", "blockquote", "hr"].includes(t), `unexpected tag ${t}`);
});

/* ---------- launch helpers ---------- */

test("launch schedule: blocks to open, blocks left, pills and plain sentences", () => {
  const up = asset({ status: "upcoming", startHeight: 300, minted: 0 });
  assert.equal(blocksUntilOpen(up, 262), 37);
  assert.equal(blocksUntilOpen(up, 299), 0);
  assert.equal(blocksUntilOpen(up, null), null);
  assert.match(String(pillFor(up, 262)), /OPENS IN 37 BLOCKS/);
  assert.match(String(pillFor(up, 299)), /OPENS NEXT BLOCK/);
  assert.match(scheduleText(up, 262), /^Opens at #300, in 37 blocks \(about 6 h\)\.$/);
  const live = asset({ endHeight: 1000 });
  assert.equal(blocksLeft(live, 990), 10);
  assert.equal(blocksLeft(asset(), 990), null);
  assert.match(scheduleText(live, 990), /closes after #1,000: 10 blocks left \(about 2 h\), 588 mints left before the cap/);
  assert.match(scheduleText(asset(), 990), /no end block: 588 mints left/);
  assert.match(scheduleText(asset({ status: "sold-out", soldOutHeight: 262900 }), 263000), /Minted out at #262,900, 19 blocks after the first mint/);
  assert.match(scheduleText(asset({ status: "ended", endHeight: 263000 }), 263005), /Ended after #263,000 with 412 of 1,000 mints/);
  assert.match(String(pillFor(asset({ status: "sold-out" }))), /MINTED OUT/);
  assert.equal(mintLabel(asset()), "Mint · 1,000 sats + fee");
  assert.equal(mintLabel(asset({ priceSats: "0" })), "Mint · fee only");
  assert.equal(priceText(asset({ priceSats: "0" })), "Free mint");
});

test("launch board: filters, sorts and ranking use tokens only", () => {
  const list = [
    asset({ ticker: "AAA", id: "1", mints144: 5, deployHeight: 10, priceSats: "500" }),
    asset({ ticker: "BBB", id: "2", mints144: 50, deployHeight: 20, priceSats: "2000", endHeight: 400 }),
    asset({ ticker: "CCC", id: "3", status: "upcoming", startHeight: 500, deployHeight: 30, priceSats: "0" }),
    asset({ ticker: "DDD", id: "4", status: "sold-out", firstMintHeight: 11, soldOutHeight: 90, deployHeight: 10 }),
    asset({ ticker: "EEE", id: "5", status: "sold-out", firstMintHeight: 21, soldOutHeight: 30, deployHeight: 20 }),
    asset({ ticker: "FFF", id: "6", mints144: 50, deployHeight: 25, priceSats: "100", endHeight: 300, minted: 999 }),
  ];
  assert.deepEqual(filterAssets(list, { filter: "open" }).map((a) => a.ticker), ["AAA", "BBB", "FFF"]);
  assert.deepEqual(filterAssets(list, { filter: "soldout" }).map((a) => a.ticker), ["DDD", "EEE"]);
  assert.deepEqual(filterAssets(list, { filter: "all", query: "$c" }).map((a) => a.ticker), ["CCC"]);
  assert.deepEqual(sortAssets(list.filter((a) => a.status === "live"), "trending").map((a) => a.ticker), ["FFF", "BBB", "AAA"]);
  assert.deepEqual(sortAssets(list, "newest").map((a) => a.ticker).slice(0, 2), ["CCC", "FFF"]);
  assert.deepEqual(sortAssets(list, "cheapest").map((a) => a.ticker).slice(0, 3), ["CCC", "FFF", "AAA"]);
  assert.deepEqual(sortAssets(list, "closing", 250).map((a) => a.ticker).slice(0, 3), ["FFF", "BBB", "AAA"]);
  const g = boardGroups(list, 250);
  assert.deepEqual(g.live.map((a) => a.ticker), ["FFF", "BBB", "AAA"]);
  assert.deepEqual(g.upcoming.map((a) => a.ticker), ["CCC"]);
  assert.deepEqual(g.soldout.map((a) => a.ticker), ["EEE", "DDD"], "fastest sell-out first");
});

test("launch card: no addresses or holders, CTA routes to the wallet, Bitcoin orange only when ready", () => {
  const a = asset();
  const neutral = String(launchCard(a, { height: 263000, walletReady: false }));
  const ready = String(launchCard(a, { height: 263000, walletReady: true }));
  assert.ok(neutral.includes('href="/t/ABC"'));
  assert.ok(neutral.includes('href="/app/mint?t=ABC"'));
  assert.ok(neutral.includes("btn--neutral") && !neutral.includes("btn--btc"));
  assert.ok(ready.includes("btn--btc"));
  assert.ok(neutral.includes("412 / 1,000 mints · 41%"));
  assert.ok(!neutral.includes(a.treasuryAddress) && !neutral.includes(a.treasury));
  assert.ok(!/holder/i.test(neutral));
  const up = String(launchCard(asset({ status: "upcoming", startHeight: 263040 }), { height: 263000 }));
  assert.ok(!up.includes("/app/mint") && up.includes("Opens at #263,040"));
});

test("supply proof and recount follow the rules from public data", () => {
  const s = supplyCheck(asset());
  assert.equal(s.expected, 41200000n);
  assert.equal(s.equal, true);
  assert.equal(supplyCheck(asset({ supply: "1" })).equal, false);
  const log = [
    { opName: "MINT", ok: true, asset: "4294967298", amount: "100000" },
    { opName: "MINT_SCRIPT", ok: true, asset: "4294967298", amount: "100000" },
    { opName: "MINT", ok: false, asset: "4294967298", amount: "100000", reason: "cap reached" },
    { opName: "MINT", ok: true, asset: "7", amount: "5" },
    { opName: "TRANSFER", ok: true },
  ];
  assert.deepEqual(recountMints(log, "4294967298"), { accepted: 2, rejected: 1, units: 200000n });
});

test("terms diff compares the DEPLOY bytes with the indexer's view", () => {
  const treasury = new Uint8Array([0x51, 0x20, ...new Array(32).fill(0x11)]);
  const bytes = encodeDeploy({ ticker: "ABC", divisibility: 2, mintAmount: 100000n, mintCap: 1000, priceSats: 1000n, treasury, startHeight: 0, endHeight: 0 });
  const d = decodeEnvelope(bytes);
  assert.deepEqual(termsDiff(d, asset()), []);
  assert.deepEqual(termsDiff(d, asset({ priceSats: "999", treasury: "00", endHeight: 5 })), ["price", "treasury", "end block"]);
  assert.deepEqual(termsDiff(null, asset()), ["terms"]);
});

test("launch kit: card and share text carry no txid unless asked, and no addresses", () => {
  const a = asset();
  const m = launchCardModel(a, { height: 263000, url: "https://murkle.example/t/ABC", brand: "Murkle" });
  const flat = JSON.stringify(m);
  assert.equal(m.txid, null);
  assert.ok(!flat.includes(a.deployTxid) && !flat.includes(a.deployTxid.slice(0, 10)));
  assert.ok(!flat.includes(a.treasuryAddress) && !flat.includes(a.treasury));
  assert.equal(m.url, "murkle.example/t/ABC");
  assert.equal(m.status, "OPEN");
  assert.equal(m.progress, "412 / 1,000 mints · 41%");
  assert.deepEqual(m.facts.map((f) => f[0]), ["PER MINT", "PRICE", "SUPPLY"]);
  assert.equal(m.sigil.cells.length, 25);
  const withTx = launchCardModel(a, { includeTxid: true });
  assert.equal(withTx.txid, "4e4e4e4e4e…4e4e4e4e4e");
  assert.equal(CARD_W * 9, CARD_H * 16);
  const text = shareText(a, "https://murkle.example/t/ABC");
  assert.equal(text, "Mint $ABC on Bitcoin (signet test network, no value). Terms on-chain; transfers are private, mints are public. https://murkle.example/t/ABC");
  assert.ok(!text.includes(a.deployTxid));
  assert.equal(xIntentUrl("a b&c"), "https://x.com/intent/post?text=a%20b%26c");
});

/* ---------- charts ---------- */

test("charts use only real series values", () => {
  assert.deepEqual(windowCounts([[98, 2], [100, 3], [90, 9], [101, 1]], 100, 3), [2, 0, 3]);
  const svg = String(mintsChart([[98, 2], [100, 3]], 100, { blocks: 3 }));
  assert.equal((svg.match(/class="lp-bar"/g) ?? []).length, 2);
  assert.ok(svg.includes("5 mints in the last 3 blocks, at most 3 in one block"));
  assert.ok(String(mintsChart([], 100, { blocks: 144 })).includes("0 mints in the last 144 blocks"));
  const c = crowdSeries([[99, 2, 1], [100, 1, 0]], { notes: 10, tip: 100, blocks: 3 });
  assert.deepEqual(c.cum, [7, 9, 10]);
  assert.deepEqual(c.transfers, [0, 1, 0]);
  assert.equal(c.added, 3);
  assert.ok(String(crowdChart([[99, 2, 1]], { notes: 10, tip: 100, blocks: 3 })).includes("2 new notes · 1 private transfers"));
  assert.ok(String(crowdChart([], { notes: null, tip: 100 })).includes("skel"), "no data, no chart");
  const strip = String(blockStrip([{ height: 12, ops: { mint: 2, transfer: 1, rejected: 0 } }, { height: 11, ops: {} }]));
  assert.ok(strip.indexOf('data-block="11"') < strip.indexOf('data-block="12"'), "oldest on the left");
  assert.ok(strip.includes("#12 · 2 mints · 1 private transfer"));
  assert.equal(blockOpsText({}), "No protocol operations");
});

/* ---------- feed ---------- */

test("log tail pages backwards from the end without per-transaction queries", async () => {
  const all = Array.from({ length: 130 }, (_, i) => ({ seq: i, height: 100 + Math.floor(i / 3), txid: TXID(String(i % 10)), opName: "TRANSFER", ok: true }));
  const calls = [];
  const api = {
    log: async ({ from, limit }) => {
      calls.push([from, limit]);
      const items = all.slice(from, from + limit);
      const end = from + items.length;
      return { items, next: end < all.length ? end : null, total: all.length };
    },
  };
  const t = await logTail(api, { count: 50 });
  assert.equal(t.items.length, 50);
  assert.equal(t.items[0].seq, 80);
  assert.equal(t.from, 80);
  const older = await logTail(api, { count: 50, before: t.from });
  assert.deepEqual([older.items[0].seq, older.items.at(-1).seq, older.from], [30, 79, 30]);
  const oldest = await logTail(api, { count: 50, before: 30 });
  assert.deepEqual([oldest.items.length, oldest.from], [30, 0]);
  assert.ok(calls.every(([from, limit]) => Number.isInteger(from) && limit <= 500));
  // An indexer without `total` is walked once to the end.
  const bare = { log: async (q) => { const r = await api.log(q); delete r.total; return r; } };
  const b = await logTail(bare, { count: 10 });
  assert.deepEqual([b.items[0].seq, b.items.length, b.total], [120, 10, 130]);
});

test("feed shows what Bitcoin shows: transfers are redaction bars, mints are public", () => {
  const assets = assetIndex([asset()]);
  const t = String(publicData({ opName: "TRANSFER", ok: true }, assets));
  assert.equal((t.match(/class="redact /g) ?? []).length, 3);
  assert.ok(!/\d/.test(t.replace(/<[^>]+>/g, "")), "no numbers in a private transfer row");
  const m = String(publicData({ opName: "MINT_SCRIPT", ok: true, asset: "4294967298", ticker: "ABC", amount: "100000" }, assets));
  assert.ok(m.includes("+1,000") && m.includes('href="/t/ABC"') && m.includes("redact"));
  const d = String(publicData({ opName: "DEPLOY", ok: true, asset: "4294967298", ticker: "ABC" }, assets));
  assert.ok(d.includes("1,000 × 1,000 · 1,000 sats"));
  const r = String(publicData({ opName: "DEPLOY", ok: false, ticker: "ABC", reason: "ticker ABC already deployed" }, assets));
  assert.ok(r.includes("ticker ABC already deployed"));
  assert.equal(opDisplay({ opName: "MINT_SCRIPT" }), "MINT");
  assert.equal(opDisplay({ opName: "UNKNOWN" }), "UNKNOWN");
  assert.ok(matchesFilter({ opName: "DEPLOY", ok: true }, "launches"));
  assert.ok(matchesFilter({ opName: "MINT_SCRIPT", ok: true }, "mints"));
  assert.ok(!matchesFilter({ opName: "TRANSFER", ok: true }, "rejected"));
  assert.ok(matchesFilter({ opName: "TRANSFER", ok: false }, "rejected"));
  assert.deepEqual(entrySeal({ ok: false, height: 5, reason: "x" }), { state: "rejected", height: 5, reason: "x" });
  assert.deepEqual(entrySeal({ ok: true, height: 5 }), { state: "accepted", height: 5 });
});

/* ---------- proof wall ---------- */

test("proof wall picks the latest envelopes and never claims a check it didn't run", () => {
  const log = [
    { seq: 1, height: 10, txid: TXID("a"), opName: "DEPLOY", ok: true },
    { seq: 2, height: 11, txid: TXID("b"), opName: "MINT", ok: true },
    { seq: 3, height: 12, txid: TXID("c"), opName: "TRANSFER", ok: true },
    { seq: 4, height: 13, txid: TXID("d"), opName: "MINT", ok: false, reason: "cap reached" },
    { seq: 5, height: 13, txid: TXID("d"), opName: "MINT", ok: false, reason: "dup" },
  ];
  assert.deepEqual(wallEntries(log, 3).map((e) => e.seq), [5, 3, 2]);
  const c = verifierCandidates(log);
  assert.deepEqual(c.map((e) => e.seq), [3, 2]);
  assert.equal(pickDefault(c).opName, "TRANSFER");
  assert.equal(pickDefault([]), null);
  assert.equal(candidateLabel(c[1]), "Latest mint");

  const ok = wallVerdict({ verdict: "verified", proofMs: 23, steps: [] });
  assert.deepEqual([ok.tone, ok.title, ok.prov, ok.ms], ["proof", "Verified", "YOU", 23]);
  assert.equal(wallVerdict({ verdict: "verified", proofMs: null, opName: "DEPLOY", steps: [] }).title, "Terms checked");
  const net = wallVerdict({ verdict: "failed", steps: [{ id: "fetch", source: "BTC", status: "fail", label: "Raw transaction fetched", detail: "offline" }] });
  assert.deepEqual([net.tone, net.title], ["muted", "Couldn't check"]);
  const noRoot = wallVerdict({ verdict: "failed", steps: [{ id: "root", source: "IDX", status: "fail", label: "Anchor root", detail: "no root" }] }, { ok: true });
  assert.equal(noRoot.tone, "muted");
  const bad = wallVerdict({ verdict: "failed", steps: [{ id: "groth16", source: "YOU", status: "fail", label: "Groth16 pairing check", detail: "invalid" }] }, { ok: true });
  assert.deepEqual([bad.tone, bad.title], ["danger", "Failed in your browser"]);
  const agrees = wallVerdict({ verdict: "failed", steps: [{ id: "treasury", source: "BTC", status: "fail", label: "Treasury paid in this transaction", detail: "underpaid" }] }, { ok: false, reason: "underpaid" });
  assert.equal(agrees.tone, "danger");
  assert.equal(agrees.detail, 'underpaid. Your browser agrees: the check "Treasury paid in this transaction" failed.');
  const hist = wallVerdict({ verdict: "rejected", steps: [] }, { ok: false, reason: "cap reached" });
  assert.match(hist.detail, /^cap reached\. Your browser's checks passed/);
  assert.equal(wallVerdict({ verdict: "mismatch", steps: [] }).title, "Indexer disagrees");
  const offline = wallVerdict({ verdict: "failed", steps: [{ id: "fetch", source: "BTC", status: "fail", label: "Raw transaction fetched", detail: "offline" }] }, { ok: false, reason: "cap reached" });
  assert.deepEqual([offline.tone, offline.title, offline.prov], ["danger", "Rejected by indexer", "IDX"]);
  assert.match(offline.detail, /^cap reached\. Your browser couldn't re-check it: offline/);
  assert.equal(wallVerdict({ verdict: "error", error: new Error("boom"), steps: [] }).title, "Couldn't check");
  assert.equal(wallSummary([ok, bad, net, null]), "1 verified in your browser · 1 rejected or disputed · 1 couldn't be checked · 1 waiting");
});

/* ---------- mempool.space cache ---------- */

test("cached esplora reuses immutable data and keeps unconfirmed answers short-lived", async () => {
  let now = 1_000_000;
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const calls = [];
  let confirmed = false;
  const inner = {
    base: "https://mempool.space/signet/api",
    txHex: async (t) => (calls.push(["hex", t]), "00ff"),
    blockHeader: async (h) => (calls.push(["hdr", h]), "aa".repeat(80)),
    txStatus: async (t) => (calls.push(["st", t]), confirmed ? { confirmed: true, block_height: 5 } : { confirmed: false }),
    merkleProof: async (t) => (calls.push(["mp", t]), { block_height: 5, merkle: [], pos: 0 }),
    tx: async (t) => (calls.push(["tx", t]), { fee: 100, status: { confirmed: true } }),
    tipHeight: async () => (calls.push(["tip"]), 7),
  };
  const c = new CachedEsplora(inner, { storage, prefix: "t.", now: () => now });
  assert.equal(c.base, inner.base);
  const [a1, a2] = await Promise.all([c.txHex(TXID("1")), c.txHex(TXID("1"))]);
  assert.equal(a1, "00ff");
  assert.equal(a2, "00ff");
  assert.equal(calls.filter((x) => x[0] === "hex").length, 1, "concurrent reads share one request");
  // A second instance (a reload) finds it in sessionStorage.
  const c2 = new CachedEsplora(inner, { storage, prefix: "t.", now: () => now });
  await c2.txHex(TXID("1"));
  await c2.blockHeader("bb");
  await c2.blockHeader("bb");
  assert.equal(calls.filter((x) => x[0] === "hex").length, 1);
  assert.equal(calls.filter((x) => x[0] === "hdr").length, 1);
  // Unconfirmed status: memory only, 15 s.
  await c2.txStatus(TXID("2"));
  assert.ok(![...store.keys()].some((k) => k.includes("st:")));
  await c2.txStatus(TXID("2"));
  assert.equal(calls.filter((x) => x[0] === "st").length, 1);
  now += 16_000;
  confirmed = true;
  assert.equal((await c2.txStatus(TXID("2"))).confirmed, true);
  assert.equal(calls.filter((x) => x[0] === "st").length, 2);
  assert.ok([...store.keys()].some((k) => k.includes("st:")), "confirmed status persists");
  await c2.tipHeight();
  await c2.tipHeight();
  now += 31_000;
  await c2.tipHeight();
  assert.equal(calls.filter((x) => x[0] === "tip").length, 2);
  // Storage that throws (quota, privacy mode) still works from memory.
  const broken = new CachedEsplora(inner, { storage: { getItem() { throw new Error("no"); }, setItem() { throw new Error("no"); }, removeItem() {} }, now: () => now });
  assert.equal(await broken.txHex(TXID("3")), "00ff");
  assert.equal(await broken.txHex(TXID("3")), "00ff");
});

/* ---------- copy rules in the launchpad files ---------- */

// Built from code points so this file itself stays free of the characters it looks for.
const CYRILLIC = new RegExp(`[${String.fromCharCode(0x400)}-${String.fromCharCode(0x4ff)}]`);

test("launchpad files: English only and none of the banned claims", () => {
  const files = [
    ...["landing", "mints", "token", "explorer", "protocol", "notfound"].map((v) => join("web/src/views", `${v}.js`)),
    ...readdirSync("web/src/share").map((f) => join("web/src/share", f)),
    "test/launchpad.test.mjs",
  ];
  const banned = [/untraceable/i, /fully anonymous/i, /100% anonymous/i, /unhackable/i, /bank-grade/i, /military-grade/i, /\btrustless\b/i, /mainnet-ready/i, /bitcoin verifies/i, /secured by bitcoin consensus/i, /decentralized indexers/i];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!CYRILLIC.test(text), `${f} contains Cyrillic`);
    if (f.endsWith("launchpad.test.mjs")) continue; // this file lists the banned words on purpose
    for (const re of banned) assert.ok(!re.test(text), `${f} contains a banned phrase: ${re}`);
    for (const m of text.matchAll(/\baudited\b/gi)) assert.match(text.slice(Math.max(0, m.index - 12), m.index), /internally\s*$/i, `${f}: "audited" without "internally"`);
    assert.ok(!/\d+(\.\d+)?\s*%\s*anonym/i.test(text), `${f} claims an anonymity percentage`);
  }
});

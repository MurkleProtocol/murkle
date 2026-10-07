// Front-end design system (web/src/ui): pure functions and markup, run in Node without a DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { html, raw, esc, Safe, attrs } from "../web/src/ui/dom.js";
import * as fmt from "../web/src/ui/format.js";
import { qrMatrix, qrSVG, rsDivisor, rsRemainder, numDataCodewords } from "../web/src/ui/qr.js";
import { sigilPattern, sigil } from "../web/src/ui/sigil.js";
import { proofprintParams, proofprintPaths, proofprint } from "../web/src/ui/proofprint.js";
import { envelopeFields, opName, hexmap } from "../web/src/ui/hexmap.js";
import { sealPill, sealBlock, sealEmblem, sealLabel, SEAL_STATES } from "../web/src/ui/seal.js";
import { summary, copyText, transcript } from "../web/src/ui/transcript.js";
import { anonPosition, anonMeter, linkMeter } from "../web/src/ui/meter.js";
import { classify, resolveSearch, suggestTickers, ADDRESS_MESSAGE } from "../web/src/ui/search.js";
import { prov, PROV } from "../web/src/ui/prov.js";
import { icon, ICONS, spriteMarkup } from "../web/src/ui/icons.js";
import { button, progress, segmented, table } from "../web/src/ui/components.js";
import { rootChip, rootDetails } from "../web/src/ui/rootmatch.js";
import { windowLeaves, latticeSVG } from "../web/src/ui/lattice.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("html escapes interpolations but keeps component output", () => {
  const evil = `<img src=x onerror="alert(1)">`;
  const out = html`<p title="${evil}">${evil}${raw("<b>ok</b>")}${[html`<i>${"&"}</i>`, null, false]}</p>`;
  assert.ok(out instanceof Safe);
  assert.equal(String(out), `<p title="${esc(evil)}">${esc(evil)}<b>ok</b><i>&amp;</i></p>`);
  assert.ok(!String(out).includes("<img"));
  assert.equal(String(attrs({ a: "x", b: true, c: false, d: null })), ` a="x" b`);
});

test("format helpers are en-US, exact for bigints, and never invent numbers", () => {
  assert.equal(fmt.int(1284), "1,284");
  assert.equal(fmt.int("12345678901234567890"), "12,345,678,901,234,567,890");
  assert.equal(fmt.units(1250025n, 2), "12,500.25");
  assert.equal(fmt.units("100000000", 8), "1");
  assert.equal(fmt.units(-150n, 2), "-1.5");
  assert.equal(fmt.units("123456789012345678901234", 8), "1,234,567,890,123,456.78901234");
  assert.equal(fmt.sats(1240), "1,240 sats");
  assert.equal(fmt.sats(1), "1 sat");
  assert.equal(fmt.heightText(263104), "#263,104");
  assert.match(String(fmt.height(263104)), /class="height mono">#263,104</);
  assert.equal(fmt.date(Date.UTC(2026, 9, 2, 14, 5)).includes("2026"), true);
  const now = 1_000_000_000_000;
  assert.equal(fmt.rel(now - 12_000, now), "12 s ago");
  assert.equal(fmt.rel(now - 4 * 60_000, now), "4 min ago");
  assert.equal(fmt.rel(now - 3 * 3_600_000, now), "3 h ago");
  assert.equal(fmt.rel(now - 2 * 86_400_000, now), "2 d ago");
  assert.equal(fmt.rel(now + 5 * 60_000, now), "in 5 min");
  assert.equal(fmt.relBlocks(3), "3 blocks ago");
  assert.equal(fmt.relBlocks(1), "1 block ago");
  assert.equal(fmt.bytes(471), "471 bytes");
  assert.equal(fmt.bytes(12_291_078), "12.3 MB");
  assert.equal(fmt.ms(412), "412 ms");
  assert.equal(fmt.ms(1830), "1.8 s");
  assert.equal(fmt.pct(412, 1000), "41%");
  assert.equal(fmt.eta(37), "about 6 h");
  assert.equal(fmt.short("1a2b3c4d5e6f9f8e"), "1a2b…9f8e");
  for (const f of [fmt.int, fmt.units, fmt.sats, fmt.heightText, fmt.date, fmt.rel, fmt.bytes, fmt.ms]) assert.equal(String(f(null)), "—");
});

test("hash, chunks and addr markup keep the full value and lowercase", () => {
  const txid = "9fc2e1d07a5b3c4e8f9012ab34cd56ef7890abcdef1234567890abcdef12a1b3";
  const h = String(fmt.hash(txid));
  assert.match(h, new RegExp(`title="${txid}"`));
  assert.match(h, /9fc2e1d0<\/span><span class="hash-e">…<\/span><span class="hash-h">ef12a1b3/);
  assert.match(h, new RegExp(`data-copy="${txid}"`));
  assert.equal(String(fmt.chunks("aabbccddee")), `<span class="chunks mono"><span>aabb</span><span>ccdd</span><span>ee</span></span>`);
  const a = String(fmt.addr("mrk1abcdefghijklmnopqrstuvwxyz", { copy: false }));
  assert.match(a, /addr-hrp">mrk1</);
  // first and last six characters are highlighted, the middle is not
  const text = a.replace(/<[^>]+>/g, "");
  assert.equal(text, "mrk1abcdefghijklmnopqrstuvwxyz");
  assert.match(a, /<span class="addr-hi">abcd<\/span>/);
  assert.match(a, /<span class="addr-hi">ef<\/span><span class="addr-mid">gh<\/span>/);
  assert.match(a, /<span class="addr-mid">ijkl<\/span>/);
});

test("QR encoder matches reference vectors", () => {
  // Reed-Solomon: "HELLO WORLD" version 1-M data codewords (ISO 18004 tutorial vector).
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  assert.equal(numDataCodewords(1, "M"), 16);
  assert.equal(numDataCodewords(40, "L"), 2956);
  // Whole-matrix vectors cross-checked against the python-qrcode reference implementation.
  const digest = (t, o) => {
    const m = qrMatrix(t, o);
    return [m.version, sha(m.rows().map((r) => r.map((v) => (v ? 1 : 0)).join("")).join("\n"))];
  };
  assert.deepEqual(digest("hello", { ecc: "M", mask: 0 }), [1, "52a7aa67e7296ede539d6be86579c7180e3b6d417445712ae8bd314c1818458a"]);
  assert.deepEqual(digest("mrk1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", { ecc: "Q", mask: 5 }), [4, "c003bfedeb30eb6d7577a810893c7dd0d3dd914ac8c333444305375bb39f752e"]);
  assert.deepEqual(digest("x".repeat(300), { ecc: "L", mask: 3 }), [11, "70e788ed172631c494c96ae4acd3829a4bff21f47a49a3c015a72c57019d587e"]);
  const auto = qrMatrix("mrk1q7x9v2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlhm4yq8sd3k0mfy2w4f9");
  assert.ok(auto.mask >= 0 && auto.mask < 8);
  assert.equal(auto.size, auto.version * 4 + 17);
  const svg = String(qrSVG("hello"));
  assert.match(svg, /^<div class="qr-tile"><svg class="qr"/);
  assert.match(svg, /viewBox="0 0 21 21"/);
  assert.throws(() => qrMatrix("y".repeat(3000), { ecc: "H" }), /too long/);
});

test("sigils are deterministic, mirrored and never empty", () => {
  for (const seed of ["0", "1", "42", "123456789", 7n, "mrk1abc"]) {
    const a = sigilPattern(seed);
    assert.deepEqual(a, sigilPattern(String(seed)));
    assert.ok(a.color >= 1 && a.color <= 6);
    assert.ok(a.cells.filter(Boolean).length >= 5 * 2 - 5, "at least 5 source cells on");
    for (let r = 0; r < 5; r++) for (let c = 0; c < 5; c++) assert.equal(a.cells[r * 5 + c], a.cells[r * 5 + (4 - c)]);
  }
  assert.notDeepEqual(sigilPattern("1"), sigilPattern("2"));
  assert.match(String(sigil("42", { size: 32, label: "ABC" })), /<svg class="sigil" width="32"[^>]*aria-label="ABC"/);
});

test("proofprint parameters follow the proof bytes", () => {
  const bytes = Uint8Array.from([3, 4, 255, 0, 255, ...new Array(27).fill(9)]);
  assert.deepEqual(proofprintParams(bytes), { n: 8, L: 12, inner: 0.7, phi: 0, twist: 0.75 });
  const paths = proofprintPaths(bytes, { R: 50, cx: 50, cy: 50 });
  assert.equal(paths.length, 12);
  assert.ok(paths.every((d) => d.startsWith("M") && d.endsWith("Z") && d.split("L").length === 144));
  assert.notEqual(paths[0], paths[11], "lines are spread apart");
  const half = String(proofprint(bytes, { size: 24, half: true, mined: true, verified: true }));
  assert.equal((half.match(/<path/g) ?? []).length, 6);
  assert.match(half, /pp-btc/);
  assert.match(half, /pp-proof/);
  assert.throws(() => proofprintParams(new Uint8Array(3)));
});

test("envelope anatomy splits every op into its exact layout", () => {
  const env = (op, len) => {
    const b = new Uint8Array(len);
    b.set([0x6d, 0x72, 0x6b, 0, op]);
    return b;
  };
  const sum = (fs) => fs.reduce((n, f) => n + f.len, 0);
  const transact = envelopeFields(env(1, 471));
  assert.equal(sum(transact), 471);
  assert.deepEqual(transact.map((f) => f.key), ["header", "anchor", "asset", "amount", "n0", "n1", "c0", "c1", "e0", "e1", "proof"]);
  assert.equal(sum(envelopeFields(env(3, 507))), 507);
  assert.ok(envelopeFields(env(3, 507)).some((f) => f.key === "bind" && f.len === 36));
  assert.ok(envelopeFields(env(4, 503)).some((f) => f.key === "bind" && f.len === 32));
  const attest = env(5, 38);
  attest[5] = 1;
  assert.deepEqual(envelopeFields(attest).map((f) => [f.key, f.len]), [["header", 5], ["kind", 1], ["hash", 32]]);
  // DEPLOY: ticker "ABC", 34-byte P2TR treasury -> 73 bytes
  const deploy = Uint8Array.from([0x6d, 0x72, 0x6b, 0, 2, 3, 65, 66, 67, 0, ...new Array(8 + 4 + 8).fill(1), 34, ...new Array(34).fill(2), 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(deploy.length, 73);
  assert.deepEqual(envelopeFields(deploy).map((f) => f.key), ["header", "ticker", "terms", "treasury", "schedule"]);
  assert.equal(opName(deploy), "DEPLOY");
  // Malformed lengths never throw; they fall back to an "unparsed" field.
  assert.equal(envelopeFields(env(1, 470)).at(-1).key, "unknown");
  const m = String(hexmap(env(1, 471), { carrierVsize: 612 }));
  assert.equal((m.match(/class="hx-c /g) ?? []).length, 471);
  assert.match(m, /TRANSACT · 471 bytes · carried in a 612 vB transaction/);
});

test("seal variants carry text for every state (color is never the only signal)", () => {
  for (const state of SEAL_STATES) {
    const s = { state, height: 263104, confirmations: 3, vsize: 612, ms: 412, reason: "Nullifier already spent" };
    assert.ok(sealLabel(s).length > 10);
    assert.match(String(sealPill(s)), /aria-label="[^"]+"/);
    assert.match(String(sealBlock(s)), /seal-block/);
    assert.match(String(sealEmblem(s, { proof: "ab".repeat(32) })), /<svg class="seal-emblem/);
  }
  assert.match(String(sealBlock({ state: "accepted", height: 1 })), /data-action="verify"/);
  assert.match(String(sealBlock({ state: "verified", height: 1, ms: 9 })), /Groth16 · 9 ms/);
  assert.match(String(sealBlock({ state: "verified", height: 1, deploy: true })), /Terms checked/);
  assert.match(sealLabel({ state: "verified", height: 263104, confirmations: 3 }), /Mined in block 263,104, 3 confirmations\. Proof verified in this browser\./);
  assert.throws(() => sealPill({ state: "bogus" }));
});

test("transcript summary counts what each check relies on", () => {
  const rows = [
    { id: "a", prov: "BTC", label: "Raw transaction fetched", status: "ok", ms: 10 },
    { id: "b", prov: "YOU", label: "Groth16 pairing check", status: "ok", ms: 9 },
    { id: "c", prov: "IDX", label: "Nullifiers unspent", status: "pending" },
  ];
  assert.equal(summary(rows), "1 of 3 checks ran in your browser · 1 relies on Bitcoin data from mempool.space · 1 relies on our indexer");
  const text = copyText(rows);
  assert.match(text, /\[ok\]\s+BTC Raw transaction fetched \(10 ms\)/);
  assert.match(text, /mempool\.space\/signet, independent of us/);
  assert.match(String(transcript(rows)), /aria-live="polite"/);
});

test("meters stay honest: log scale, counts, no percentages", () => {
  assert.equal(anonPosition(1), 0);
  assert.equal(anonPosition(1_000_000), 1);
  assert.ok(Math.abs(anonPosition(1000) - 0.5) < 1e-9);
  const m = String(anonMeter({ notes: 1284, tokens: 7 }));
  assert.match(m, /hides among <span class="mono anon-n">1,284<\/span> notes in one pool shared by 7 tokens/);
  assert.ok(!/%<\/|\d%/.test(m.replace(/style="[^"]*"/g, "")), "no anonymity percentage in the copy");
  assert.match(String(anonMeter({ notes: null })), /skel/);
  assert.match(String(linkMeter(1, "Linked.")), /linkm--danger/);
});

test("global search resolves locally and never looks up shielded addresses", async () => {
  assert.equal(classify("").kind, "empty");
  assert.equal(classify("mrk1qqqqqqqqqqqqqqqq").kind, "address");
  assert.equal(classify("A".repeat(64)).kind, "hex64");
  assert.equal(classify("0x" + "a".repeat(64)).value, "a".repeat(64));
  assert.deepEqual(classify("$abc"), { kind: "ticker", value: "ABC" });
  let calls = 0;
  const spy = async () => {
    calls++;
    return [];
  };
  assert.deepEqual(await resolveSearch("mrk1q7x9v2kgdygjrsqtzq2n0yrf", { getNullifiers: spy, getCommitments: spy, getAssets: spy }), { message: ADDRESS_MESSAGE, tone: "info" });
  assert.equal(calls, 0, "an address is never sent anywhere");
  const hex = "00".repeat(31) + "2a"; // 42
  assert.deepEqual(await resolveSearch(hex, { getNullifiers: async () => ["42"], getCommitments: async () => [] }), { path: `/nullifier/${hex}` });
  assert.deepEqual(await resolveSearch(hex, { getNullifiers: async () => [], getCommitments: async () => [["42", 7]] }), { path: `/commitment/${hex}` });
  assert.deepEqual(await resolveSearch(hex, { getNullifiers: async () => [], getCommitments: async () => [] }), { path: `/tx/${hex}` });
  const assets = [{ ticker: "ABC", assetId: "1" }, { ticker: "ABCD", assetId: "2" }, { ticker: "ZZZ", assetId: "3" }];
  assert.deepEqual(await resolveSearch("abc", { getAssets: async () => assets }), { path: "/t/ABC" });
  assert.equal((await resolveSearch("nope", { getAssets: async () => assets })).tone, "warn");
  assert.deepEqual(suggestTickers("ab", assets).map((a) => a.ticker), ["ABC", "ABCD"]);
});

test("components: chips, buttons, progress, tables and icons", () => {
  for (const k of Object.keys(PROV)) assert.match(String(prov(k)), new RegExp(`prov--${k.toLowerCase()}`));
  assert.throws(() => prov("XYZ"));
  const disabled = String(button({ label: "Send privately", kind: "btc", disabled: true, reason: "Top up 1,240 sats" }));
  assert.match(disabled, /disabled/);
  assert.match(disabled, /class="reason caption"[^>]*>Top up 1,240 sats</);
  assert.match(String(button({ label: "Docs", href: "https://example.com" })), /target="_blank" rel="noopener noreferrer"/);
  assert.match(String(button({ label: "Mints", href: "/mints" })), /data-link/);
  assert.match(String(progress({ value: 412, max: 1000 })), /412 \/ 1,000 mints · 41%/);
  assert.match(String(progress({ value: null, max: null })), /—/);
  assert.match(String(segmented([{ value: "a", label: "A" }, { value: "b", label: "B" }], { value: "b" })), /data-value="b" aria-checked="true"/);
  assert.match(String(table({ columns: [{ key: "x", label: "X" }], rows: [{ x: "1" }] })), /data-label="X"/);
  for (const n of Object.keys(ICONS)) assert.match(String(icon(n)), new RegExp(`#i-${n}`));
  assert.throws(() => icon("emoji"));
  assert.equal((spriteMarkup().match(/<symbol /g) ?? []).length, Object.keys(ICONS).length);
  assert.match(String(rootChip({ state: "match", root: "ab".repeat(32) })), /rootchip--match/);
  assert.match(String(rootDetails({ state: "mismatch", root: "ab".repeat(32), localRoot: "cd".repeat(32) })), /different root/);
});

test("lattice maps the newest window of outputs to leaf slots", () => {
  assert.deepEqual([...windowLeaves(0)], []);
  assert.deepEqual([...windowLeaves(3)], [0, 1, 2]);
  assert.equal(windowLeaves(64).size, 64);
  assert.deepEqual([...windowLeaves(66)], [0, 1]);
  const svg = String(latticeSVG({ depth: 5, occupied: [0, 1], fresh: [1] }));
  assert.equal((svg.match(/class="lt-leaf/g) ?? []).length, 32);
  assert.equal((svg.match(/is-new/g) ?? []).length, 1);
});

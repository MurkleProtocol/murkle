// Audit 2, server area: regression tests for V2-10/V2-26 (no frameable path), V2-11 (/api/state
// tip hashes from the published view), V2-12 (/api/roots?height= is a 400), V2-13 (preview image
// tags follow MURKLE_PUBLIC_URL), V2-44 (the artifact check follows the files on disk), V2-15
// (an unknown txid is unknown even when the explorer's /status says { confirmed: false }), V2-16
// (deposits count toward capacity only when the margin can merge them) and V2-17 (a carrier
// whose earlier answer was lost is never refunded on later refusals).
//
// Fakes only: FakeEsplora (never broadcasts anything real), synthetic blocks and envelopes,
// temporary directories. Nothing touches data/signet/ or the live servers.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeEsplora, chain, fundAccount, makePaidRelayer, newAccount, signedSubmit, silent, synth,
} from "./fixtures/relay-harness.mjs";
import { ARTIFACTS, CSP, checkArtifacts, createApp } from "../server/indexer-server.mjs";
import { ANCHOR_WINDOW } from "../src/indexer.mjs";

const DIR = mkdtempSync(join(tmpdir(), "murkle-audit2-server-"));
const servers = [];
const relayers = [];
after(async () => {
  relayers.forEach((r) => r.close());
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  rmSync(DIR, { recursive: true, force: true });
});
const anyIp = () => `203.0.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;

/** A built web root with the real index.html (its OG and Twitter tags included). */
const DIST = join(DIR, "dist");
mkdirSync(DIST, { recursive: true });
copyFileSync(new URL("../web/index.html", import.meta.url), join(DIST, "index.html"));

async function serve(app) {
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  servers.push(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { base, get: (p) => fetch(base + p) };
}

async function threeBlocks() {
  const c = chain({ start: 700_000 });
  for (let i = 0; i < 3; i++) await c.mine();
  return c;
}

/* ---------------------------------------------------------------- V2-10 / V2-26 framing */

test("V2-10: no path is frameable: /embed/* gets X-Frame-Options DENY and frame-ancestors 'none' like every page", async () => {
  const { idx } = await threeBlocks();
  const { get } = await serve(createApp({ idx, webDist: DIST, log: silent }));
  for (const path of ["/embed/HEX", "/embed/t/HEX", "/embed/t/HEX/", "/embed/anything/app", "/app", "/"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.equal(res.headers.get("x-frame-options"), "DENY", path);
    assert.equal(res.headers.get("content-security-policy-report-only"), CSP, path);
    assert.match(CSP, /frame-ancestors 'none'/);
  }
  const enforced = await serve(createApp({ idx, webDist: DIST, enforceCsp: true, log: silent }));
  const res = await enforced.get("/embed/t/HEX");
  assert.equal(res.headers.get("content-security-policy"), CSP);
  assert.equal(res.headers.get("x-frame-options"), "DENY");
});

/* ---------------------------------------------------------------- V2-11 tip hashes */

test("V2-11: tipHash and recentHashes come from the published view, so a tick that rolls back mid-way shows no half-updated tip", async () => {
  const { idx } = await threeBlocks();
  const h = idx.height;
  const hashes = [h, h - 1, h - 2].map((x) => idx.hashes.get(x));
  const { get } = await serve(createApp({ idx, webDist: DIST, log: silent }));
  const before = await (await get("/api/state")).json();
  assert.equal(before.tipHash, hashes[0]);
  assert.deepEqual(before.recentHashes, hashes);
  // A sync rolls back the tip and awaits the network before re-applying it (src/sync.mjs):
  // the live indexer has lost its tip hash, the published view has not.
  idx.rollbackTo(h - 1);
  assert.equal(idx.hashes.has(h), false);
  const mid = await (await get("/api/state")).json();
  assert.equal(mid.height, h);
  assert.equal(mid.root, before.root);
  assert.equal(mid.tipHash, hashes[0], "the tip hash of the block whose root is served");
  assert.deepEqual(mid.recentHashes, hashes, "[h, h-1, h-2] by position, never shifted");
});

test("V2-11: recentHashes is cut at the first height with no known hash, never closed over a gap", async () => {
  const c = chain({ start: 710_000 });
  await c.mine(); // only the first block is known: h-1 and h-2 precede the start
  const { get } = await serve(createApp({ idx: c.idx, webDist: DIST, log: silent }));
  const s = await (await get("/api/state")).json();
  assert.deepEqual(s.recentHashes, [c.idx.hashes.get(c.idx.height)]);
  assert.equal(s.tipHash, c.idx.hashes.get(c.idx.height));
});

/* ---------------------------------------------------------------- V2-12 empty height */

test("V2-12: /api/roots?height= (empty) is a 400 bad_request, not a 404 for block undefined", async () => {
  const { idx } = await threeBlocks();
  const { get } = await serve(createApp({ idx, webDist: DIST, log: silent }));
  for (const q of ["height=", "height=abc", "height=1.5"]) {
    const res = await get(`/api/roots?${q}`);
    assert.equal(res.status, 400, q);
    const body = await res.json();
    assert.equal(body.error.code, "bad_request");
    assert.doesNotMatch(body.error.message, /undefined/);
  }
  assert.equal((await get(`/api/roots?height=${idx.height}`)).status, 200);
  assert.equal((await get("/api/roots?height=5")).status, 404);
});

/* ---------------------------------------------------------------- V2-13 preview images */

const metas = (html) => Object.fromEntries([...html.matchAll(/<meta (?:property|name)="((?:og|twitter):[^"]+)" content="([^"]*)"/g)].map((m) => [m[1], m[2]]));

test("V2-13: without MURKLE_PUBLIC_URL no page claims a large-image card with a relative image; with it every page gets absolute image URLs", async () => {
  const { idx } = await threeBlocks();
  const plain = await serve(createApp({ idx, webDist: DIST, log: silent }));
  for (const path of ["/t/HEX", "/", "/mints"]) {
    const m = metas(await (await plain.get(path)).text());
    assert.equal(m["twitter:card"], "summary", path);
    assert.equal(m["twitter:image"], undefined, `${path}: X needs an absolute image URL`);
    assert.equal(m["og:image"], "/og.png", path);
    assert.equal(m["og:url"], undefined, path);
    assert.equal(m["og:image:width"], "1200", path);
    assert.equal(m["og:image:height"], "630", path);
  }
  const site = await serve(createApp({ idx, webDist: DIST, publicUrl: "https://murkle.example/", log: silent }));
  for (const path of ["/t/HEX", "/", "/mints"]) {
    const html = await (await site.get(path)).text();
    const m = metas(html);
    assert.equal(m["og:image"], "https://murkle.example/og.png", path);
    assert.equal(m["twitter:image"], "https://murkle.example/og.png", path);
    assert.equal(m["twitter:card"], "summary_large_image", path);
    assert.equal(m["og:image:width"], "1200", path);
    assert.equal((html.match(/property="og:image"/g) ?? []).length, 1, `${path}: one og:image`);
    assert.equal((html.match(/name="twitter:card"/g) ?? []).length, 1, `${path}: one twitter:card`);
  }
  const t = metas(await (await site.get("/t/HEX")).text());
  assert.equal(t["og:url"], "https://murkle.example/");
});

/* ---------------------------------------------------------------- V2-44 artifacts */

test("V2-44: /api/state.artifacts follows the files on disk, and a file that no longer matches its pin is never served", async (t) => {
  const vkey = ARTIFACTS["verification_key.json"];
  const pinned = checkArtifacts({ "verification_key.json": vkey });
  if (!pinned.ok) return t.skip("build/dev/verification_key.json does not match the pins in this checkout");
  const dir = mkdtempSync(join(DIR, "artifacts-"));
  const copy = join(dir, "verification_key.json");
  copyFileSync(vkey, copy);
  const artifacts = { "verification_key.json": copy };
  const { idx } = await threeBlocks();
  const warnings = [];
  const { get } = await serve(createApp({ idx, webDist: DIST, artifacts, artifactCheck: checkArtifacts(artifacts), log: { ...silent, warn: (m) => warnings.push(m) } }));
  assert.deepEqual((await (await get("/api/state")).json()).artifacts, { ok: true, mismatched: [], missing: [] });
  const ok = await get("/artifacts/verification_key.json");
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), readFileSync(vkey, "utf8"));

  writeFileSync(copy, JSON.stringify({ tampered: true }));
  const state = (await (await get("/api/state")).json()).artifacts;
  assert.deepEqual(state, { ok: false, mismatched: ["verification_key.json"], missing: [] });
  const res = await get("/artifacts/verification_key.json");
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal((await res.json()).error.code, "unavailable");
  assert.equal(warnings.length, 1);

  copyFileSync(vkey, copy);
  assert.equal((await (await get("/api/state")).json()).artifacts.ok, true, "restored");
  assert.equal((await get("/artifacts/verification_key.json")).status, 200);
});

/* ---------------------------------------------------------------- relayer worlds */

/**
 * mempool.space's real answers: GET /tx/<txid>/status is 200 { confirmed: false } for a txid it
 * has never seen; only GET /tx/<txid> is a 404.
 */
class RealExplorer extends FakeEsplora {
  constructor(opts) {
    super(opts);
    this.statusDown = false; // every lookup fails (503), as during an outage
  }
  async txStatus(txid) {
    if (this.statusDown) throw new Error(`GET /tx/${txid}/status: 503 Service Unavailable`);
    this.requests.push(["status", txid]);
    if (this.mined.has(txid)) return { confirmed: true, block_height: this.mined.get(txid) };
    return { confirmed: false };
  }
  async tx(txid) {
    if (this.statusDown) throw new Error(`GET /tx/${txid}: 503 Service Unavailable`);
    this.requests.push(["tx", txid]);
    if (this.mined.has(txid)) return { txid, status: { confirmed: true, block_height: this.mined.get(txid) } };
    if (this.mempool.has(txid)) return { txid, status: { confirmed: false } };
    throw new Error(`GET /tx/${txid}: 404 Transaction not found`);
  }
}

async function world({ fee = 1, start = 866_000, config = {} } = {}) {
  const esplora = new RealExplorer({ fee });
  const c = chain({ start, fakes: [esplora] });
  await c.mine();
  const r = await makePaidRelayer({ idx: c.idx, esplora, config, log: silent });
  relayers.push(r);
  const tick = () => r.onTick({ chainTip: c.idx.height });
  await tick();
  return {
    esplora, c, idx: c.idx, r, tick,
    step: async () => (await c.mine(), tick()),
    land: async () => (await c.mineCarriers(esplora), tick()),
  };
}
const send = (w, account, envelope, mode = "block") => w.r.submit(signedSubmit(account, w.r.info(), envelope, mode), anyIp());
async function funded(w, sats = 7000) {
  const a = newAccount();
  const f = await fundAccount({ relayer: w.r, esplora: w.esplora, account: a, sats });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  return a;
}
const bal = (w, a) => w.r.books.account(a.idHex);
const REFUSAL = 'POST /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}';

/* ---------------------------------------------------------------- V2-15 unknown txids */

test("V2-15: statusOf reads GET /tx/<txid>: unknown is null although /status says { confirmed: false }; a client without tx() still uses txStatus", async () => {
  const w = await world();
  const unknown = "ab".repeat(32);
  assert.deepEqual(await w.esplora.txStatus(unknown), { confirmed: false }, "the real explorer's /status answer");
  assert.equal(await w.r.statusOf(unknown), null);
  const paid = w.esplora.pay([{ script: new Uint8Array([0x51]), value: 1000 }]);
  assert.deepEqual(await w.r.statusOf(paid), { confirmed: false });
  w.esplora.confirm([paid], w.idx.height);
  assert.deepEqual(await w.r.statusOf(paid), { confirmed: true, block_height: w.idx.height });
  w.esplora.statusDown = true;
  assert.equal(await w.r.statusOf(paid), undefined, "no answer");
  w.esplora.statusDown = false;
  // A client without tx(): txStatus, whose 404 means unknown.
  const old = { txStatus: async (t) => { throw new Error(`GET /tx/${t}/status: 404 Transaction not found`); } };
  const saved = w.r.esplora;
  w.r.esplora = old;
  assert.equal(await w.r.statusOf(unknown), null);
  w.r.esplora = saved;
});

test("V2-15: with the real explorer's answers, a carrier the node refused once is not taken as broadcast: it is resent, lands and is charged once", async () => {
  const w = await world();
  const a = await funded(w);
  await w.tick(); // merged into C
  const out = await send(w, a, synth(w.idx));
  assert.equal(out.status, 202);
  await w.c.mine();
  w.esplora.failNext = new Error(REFUSAL);
  await w.tick();
  const item = w.r.state.items[out.body.id];
  assert.deepEqual([item.status, item.attempts], ["signing", 1], "refused: an attempt, not 'reached the network'");
  assert.equal(w.esplora.mempool.has(item.txid), false);
  const coin = w.r.state.coins[`${item.txid}:1`];
  assert.equal(coin.unsent, true, "its change is not spendable while it is not on the network");
  await w.step(); // resent with the same bytes
  assert.equal(w.r.status(out.body.id).status, "broadcast");
  assert.equal(w.esplora.mempool.has(item.txid), true);
  await w.land();
  assert.equal(w.r.status(out.body.id).status, "accepted");
  assert.equal(bal(w, a).balance, 6712 - 658, "charged once (fee 598 + margin 60)");
  assert.equal(w.r.checkBooks().ok, true);
});

test("V2-15: with the real explorer's answers, three refusals drop a carrier and refund it; a merge whose send was lost is sent again", async () => {
  const w = await world();
  const a = await funded(w);
  // The merge's broadcast never arrives: nothing entered any mempool.
  w.esplora.failNext = new Error("socket hang up");
  await w.tick();
  const merge = w.r.state.ledger.find((l) => l.kind === "merge");
  assert.ok(merge);
  assert.equal(w.esplora.mempool.has(merge.txid), false);
  assert.deepEqual([merge.outcome, merge.unsent], ["pending", true], "unknown outcome: its output is not spendable yet");
  await w.tick(); // reconcileFanouts: unknown to the explorer, so the same bytes go out again
  assert.equal(w.esplora.mempool.has(merge.txid), true);
  assert.equal(merge.unsent, undefined);
  await w.land();
  assert.equal(merge.outcome, "accepted");

  const out = await send(w, a, synth(w.idx));
  const before = bal(w, a);
  for (let k = 0; k < 3; k++) {
    w.esplora.failNext = new Error(REFUSAL);
    await w.step();
  }
  const item = w.r.state.items[out.body.id];
  assert.equal(item.status, "dropped", "three refusals of a txid the explorer does not know");
  assert.deepEqual(bal(w, a), { ...before, balance: before.balance + before.reserved, reserved: 0 }, "refunded: it never reached the network");
  assert.equal(w.r.checkBooks().ok, true);
});

/* ---------------------------------------------------------------- V2-17 unknownOutcome */

test("V2-17: a carrier whose first answer was lost is never refunded after later refusals; it lands and keeps its charge", async () => {
  const w = await world();
  const a = await funded(w);
  await w.tick();
  const out = await send(w, a, synth(w.idx));
  await w.c.mine();
  // The node takes the carrier, the answer is lost and the explorer cannot answer either.
  w.esplora.loseAnswer = new Error("socket hang up");
  w.esplora.statusDown = true;
  await w.tick();
  w.esplora.statusDown = false;
  const item = w.r.state.items[out.body.id];
  assert.deepEqual([item.status, item.unknownOutcome], ["signing", true]);
  const charged = bal(w, a).balance;
  assert.equal(charged, 6712 - 658);
  const raw = item.raw;
  // The explorer's node evicts it and refuses it three times; another node keeps it.
  w.esplora.evict(item.txid);
  for (let k = 0; k < 3; k++) {
    w.esplora.failNext = new Error(REFUSAL);
    await w.step();
    assert.equal(item.status, "signing", `refusal ${k + 1}: kept journaled`);
    assert.equal(item.attempts, 0, "not an attempt");
  }
  assert.equal(bal(w, a).balance, charged, "never refunded");
  assert.equal(w.r.state.coins[item.outpoint].status, "spent", "its input stays spent by it");
  // A miner that kept the original bytes mines it.
  await w.esplora.broadcast(raw);
  await w.land();
  assert.equal(w.r.status(out.body.id).status, "accepted");
  assert.equal(bal(w, a).balance, charged);
  assert.equal(w.r.checkBooks().ok, true);
});

test("V2-17: a 'spent' answer after an unknown outcome neither drops nor refunds; past the anchor window the carrier is broadcast and expires, charged", async () => {
  const w = await world();
  const a = await funded(w);
  await w.tick();
  const out = await send(w, a, synth(w.idx));
  await w.c.mine();
  w.esplora.failNext = new Error("POST /tx: 502 Bad Gateway"); // nothing entered: the relayer cannot know
  await w.tick();
  const item = w.r.state.items[out.body.id];
  assert.deepEqual([item.status, item.unknownOutcome], ["signing", true]);
  const charged = bal(w, a).balance;
  w.esplora.coins.delete(item.outpoint); // its input is gone: every resend answers "spent"
  await w.step();
  assert.equal(item.status, "signing", "spent + 404 after an unknown outcome: kept journaled");
  assert.equal(bal(w, a).balance, charged);
  while (w.idx.height < item.anchor + ANCHOR_WINDOW) await w.c.mine();
  await w.tick();
  assert.equal(w.r.status(out.body.id).status, "broadcast", "the window has closed: charge final");
  await w.step();
  assert.equal(w.r.status(out.body.id).status, "expired");
  assert.equal(bal(w, a).balance, charged, "never refunded: it may have been on the network");
});

/* ---------------------------------------------------------------- V2-16 merges */

test("V2-16: a lone deposit the margin cannot merge (3 sat/vB) funds no send: submit answers pool_low, not a 202 that expires", async () => {
  const w = await world({ fee: 3 });
  const a = await funded(w, 20_000);
  await w.step();
  assert.equal(w.r.state.ledger.length, 0, "no merge: 288 of margin < a 336-sat merge");
  assert.equal(w.r.capacity(), 0);
  const out = await send(w, a, synth(w.idx));
  assert.equal(out.status, 503);
  assert.equal(out.body.error?.code ?? out.body.code, "pool_low");
  assert.equal(bal(w, a).reserved, 0, "nothing reserved");

  // A second deposit makes the merge affordable (576 >= 507): sends are taken and carried.
  const b = await funded(w, 20_000);
  assert.ok(w.r.capacity() > 0);
  const ok = await send(w, b, synth(w.idx));
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  await w.step();
  await w.step();
  assert.equal(w.r.state.ledger.filter((l) => l.kind === "merge").length, 1);
  assert.equal(w.r.status(ok.body.id).status, "broadcast");
  assert.equal(w.r.checkBooks().ok, true);
});

test("V2-16: a merge takes as many deposits as the margin pays for, instead of none", async () => {
  const w = await world({ fee: 4 });
  for (let i = 0; i < 3; i++) await funded(w, 20_000);
  assert.equal(w.r.books.availableMargin(), 3 * 288);
  assert.equal(w.r.mergeRoom(3), 2, "3 inputs cost 908 > 864; 2 cost 676");
  await w.step();
  const merges = w.r.state.ledger.filter((l) => l.kind === "merge");
  assert.equal(merges.length, 1);
  assert.equal(merges[0].fee, 676);
  assert.equal(w.r.books.availableMargin(), 864 - 676);
  assert.equal(w.r.checkBooks().ok, true);
});

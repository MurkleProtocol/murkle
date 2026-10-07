// Indexer HTTP server (docs/API.md): every endpoint against an in-memory
// indexer on an ephemeral port, the SPA fallback with escaped OG meta, the
// security headers, and the relay endpoints over real HTTP. No network: the
// chain source and the relayer's esplora are fakes, and nothing is broadcast.
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { deriveKeys } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { ATTEST_KIND, encodeAttest, encodeDeploy, opReturnScript } from "../src/envelope.mjs";
import { hex } from "../src/bytes.mjs";
import { btcAccount } from "../src/btc/funding.mjs";
import { ARTIFACTS, CSP, checkArtifacts, createApp, escapeHtml, formatUnits } from "../server/indexer-server.mjs";
import { fundAccount, makeFakeEsplora, makePaidRelayer, newAccount, signedSubmit } from "./fixtures/relay-harness.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const START = 600000;
const MANIFEST = randomBytes(32).toString("hex");
const TREASURY = btcAccount(new Uint8Array(randomBytes(32))).script; // a valid P2TR output
const hash32 = () => randomBytes(32).toString("hex");
const DIR = mkdtempSync(join(tmpdir(), "murkle-server-"));
const DIST = join(DIR, "dist");
const silent = { warn() {}, error() {}, log() {} };

const coinbase = () => ({ txid: hash32(), inputs: [], outputs: [] });
const carrier = (payload, extra = [], first = randomBytes(36)) => ({
  txid: hash32(), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(payload), value: 0n }, ...extra],
});

/** The relayer's esplora: deposits, a fee rate, and recorded (never real) broadcasts; it never lists addresses. */
const fakeEsplora = makeFakeEsplora();
const payer = newAccount(); // the relay account that pays for the relayed transfer below

const genesis = carrier(encodeAttest({ kind: ATTEST_KIND.GENESIS, hash: MANIFEST }));
// The v1 endpoints: these blocks lie above the pinned mining activation height (src/pins.json),
// so the table is given explicitly (mining unscheduled; test/mine-relayer.test.mjs covers mining).
const idx = new Indexer({ vkey: VKEY, startHeight: START, genesis: { txid: genesis.txid, manifestSha256: MANIFEST }, activations: [{ name: "mining", height: null, digestV: 2 }] });
const alice = new Wallet(deriveKeys(randomBytes(32)));
const ASSET = assetIdOf(START, 2);
let base, app, relayer, mintTx;

const mine = (txs = []) => idx.applyBlock({ height: idx.height + 1, hash: hash32(), txs: [coinbase(), ...txs] });

before(async () => {
  mkdirSync(join(DIST, "assets"), { recursive: true });
  writeFileSync(join(DIST, "index.html"), [
    "<!doctype html>",
    '<html lang="en">',
    "  <head>",
    "    <title>Murkle</title>",
    '    <meta property="og:title" content="static title" />',
    '    <meta name="twitter:card" content="summary" />',
    "  </head>",
    '  <body><div id="app"></div></body>',
    "</html>",
  ].join("\n"));
  writeFileSync(join(DIST, "assets", "app-1234.js"), "console.log('app');");
  writeFileSync(join(DIR, "secret.txt"), "outside the web root");

  await mine([genesis, carrier(encodeDeploy({ ticker: "HEX", divisibility: 2, mintAmount: 12345n, mintCap: 21, priceSats: 1500n, treasury: TREASURY }))]);
  const bind = randomBytes(36);
  mintTx = carrier(await alice.mint(idx, { asset: ASSET, mintAmount: 12345n, bindOutpoint: bind }), [{ script: TREASURY, value: 1500n }], bind);
  const underpaid = randomBytes(36);
  const cheap = carrier(await alice.mint(idx, { asset: ASSET, mintAmount: 12345n, bindOutpoint: underpaid }), [{ script: TREASURY, value: 10n }], underpaid);
  await mine([mintTx, cheap]);
  await mine([carrier(new Uint8Array([0x6d, 0x72, 0x6b, 0, 9, 1, 2]))]); // our magic, unknown op: logged as rejected
  await mine([]);

  relayer = await makePaidRelayer({ idx, esplora: fakeEsplora, log: silent });
  await relayer.onTick({ chainTip: idx.height });
  const credit = await fundAccount({ relayer, esplora: fakeEsplora, account: payer, sats: 7000 });
  assert.equal(credit.status, 200, JSON.stringify(credit.body));
  app = createApp({ idx, relayer, webDist: DIST, publicUrl: "https://murkle.example", bodyLimit: 4096, log: silent });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  relayer?.close();
  await new Promise((r) => (app ? app.server.close(r) : r()));
  rmSync(DIR, { recursive: true, force: true });
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const get = (path, init) => fetch(base + path, init);
const getJSON = async (path) => {
  const res = await get(path);
  assert.equal(res.status, 200, `${path}: ${res.status}`);
  return res.json();
};

test("GET /api/state: heights, root, digest, genesis and relay summary", async () => {
  const s = await getJSON("/api/state");
  assert.equal(s.protocol, "murkle");
  assert.equal(s.network, "signet");
  assert.equal(s.height, START + 3);
  assert.equal(s.startHeight, START);
  assert.equal(s.root, idx.tree.root().toString());
  assert.equal(s.digest, idx.digestAt(START + 3));
  assert.equal(s.tipHash, idx.hashes.get(START + 3));
  assert.deepEqual(s.recentHashes, [START + 3, START + 2, START + 1].map((h) => idx.hashes.get(h)));
  assert.equal(s.outputs, 2);
  assert.equal(s.nullifiers, 2);
  assert.deepEqual(s.genesis, { txid: genesis.txid, height: START, manifestSha256: MANIFEST });
  assert.equal(s.preGenesis, false);
  assert.equal(s.warning, undefined);
  assert.deepEqual(s.relay, { enabled: true, mode: "balance", queued: 0, defaultMode: "block", batch: relayer.batchSummary() });
  const res = await get("/api/state");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
});

test("pre-genesis is visible in /api/state", async () => {
  const pre = new Indexer({ vkey: VKEY, startHeight: 5 });
  const other = createApp({ idx: pre, log: silent });
  await new Promise((r) => other.server.listen(0, "127.0.0.1", r));
  try {
    const s = await (await fetch(`http://127.0.0.1:${other.server.address().port}/api/state`)).json();
    assert.equal(s.preGenesis, true);
    assert.equal(s.genesis, null);
    assert.match(s.warning, /Pre-genesis/);
    assert.deepEqual(s.relay, { enabled: false, mode: null, queued: 0, defaultMode: "block", batch: null });
    const info = await (await fetch(`http://127.0.0.1:${other.server.address().port}/api/relay/info`)).json();
    assert.deepEqual([info.enabled, info.code, info.reason], [false, "disabled", "no relayer runs on this server"]);
  } finally {
    await new Promise((r) => other.server.close(r));
  }
});

test("outputs, commitments and nullifiers in bulk, with from/to ranges", async () => {
  const outputs = await getJSON("/api/outputs");
  assert.equal(outputs.length, 2);
  assert.deepEqual(Object.keys(outputs[0]).sort(), ["ciphertext", "commitment", "height", "leafIndex", "txid"]);
  assert.equal(outputs[0].txid, mintTx.txid);
  assert.equal(outputs[0].commitment, idx.outputs[0].commitment.toString());
  assert.equal(outputs[0].ciphertext, hex(idx.outputs[0].ciphertext));
  assert.deepEqual((await getJSON("/api/outputs?from=1&to=2")).map((o) => o.leafIndex), [1]);
  assert.deepEqual(await getJSON("/api/outputs?from=5"), []);
  assert.deepEqual(await getJSON("/api/commitments?to=1"), [[idx.outputs[0].commitment.toString(), START + 1]]);
  assert.deepEqual((await getJSON("/api/nullifiers")).sort(), [...idx.nullifiers].sort());
  const bad = await get("/api/outputs?from=abc");
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "bad_request");
});

test("GET /api/log pages by seq and refuses per-transaction lookups", async () => {
  const page = await getJSON("/api/log?from=0&limit=2");
  assert.deepEqual(page.items.map((e) => e.seq), [0, 1]);
  assert.equal(page.next, 2);
  assert.equal(page.total, idx.log.length);
  assert.deepEqual(page.items.map((e) => e.opName), ["ATTEST", "DEPLOY"]);
  const rest = await getJSON(`/api/log?from=${page.next}`);
  assert.equal(rest.next, null);
  assert.deepEqual(rest.items.map((e) => [e.opName, e.ok]), [["MINT", true], ["MINT", false], ["UNKNOWN", false]]);
  assert.equal(rest.items[0].ticker, "HEX");
  assert.equal(rest.items[0].amount, "12345");
  for (const q of [`txid=${mintTx.txid}`, "nullifier=1"]) {
    const res = await get(`/api/log?${q}`);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error.message, /would reveal which transactions are yours/);
  }
  assert.equal((await getJSON("/api/log?limit=100000")).items.length, idx.log.length, "limit is capped, not refused");
});

test("roots, digest and digests", async () => {
  assert.deepEqual(await getJSON(`/api/roots?from=${START}&to=${START + 1}`), [[START, idx.roots.get(START).toString()], [START + 1, idx.roots.get(START + 1).toString()]]);
  assert.equal((await getJSON("/api/roots")).length, 5, "startHeight-1 .. tip");
  assert.deepEqual(await getJSON(`/api/roots?height=${START + 2}`), { height: START + 2, root: idx.roots.get(START + 2).toString() });
  assert.equal((await get("/api/roots?height=1")).status, 404);

  assert.deepEqual(await getJSON(`/api/digest?height=${START + 1}`), {
    height: START + 1, digest: idx.digestAt(START + 1), blockHash: idx.hashes.get(START + 1), root: idx.roots.get(START + 1).toString(),
  });
  assert.equal((await getJSON("/api/digest")).height, START + 3, "defaults to the tip");
  assert.equal((await get(`/api/digest?height=${START + 9}`)).status, 404);
  assert.deepEqual(await getJSON("/api/digests"), [...idx.digests]);
  assert.deepEqual(await getJSON(`/api/digests?from=${START + 2}&to=${START + 2}`), [[START + 2, idx.digestAt(START + 2)]]);
});

test("assets list, one asset with mintsByHeight, and launch stats", async () => {
  const [a] = await getJSON("/api/assets");
  assert.equal(a.ticker, "HEX");
  assert.equal(a.id, ASSET.toString());
  assert.equal(a.minted, 1);
  assert.equal(a.supply, "12345");
  assert.equal(a.maxSupply, (12345n * 21n).toString());
  assert.equal(a.priceSats, "1500");
  assert.equal(a.treasurySats, "1500");
  assert.equal(a.rejectedMints, 1);
  assert.equal(a.burnedSats, "10");
  assert.equal(a.status, "live");
  assert.equal(a.deployHeight, START);
  assert.equal(a.firstMintHeight, START + 1);
  assert.match(a.treasuryAddress, /^tb1p/);
  assert.equal(a.mintsByHeight, undefined);
  const one = await getJSON("/api/assets/hex");
  assert.deepEqual(one.mintsByHeight, [[START + 1, 1]]);
  assert.equal((await get("/api/assets/NOPE")).status, 404);
  assert.equal((await get("/api/assets/%3Cb%3E")).status, 400);

  const stats = await getJSON("/api/stats");
  assert.deepEqual(
    { notes: stats.notes, nullifiers: stats.nullifiers, privateTransfers: stats.privateTransfers, transfers144: stats.transfers144, mints: stats.mints, tokens: stats.tokens, rejected: stats.rejected },
    { notes: 2, nullifiers: 2, privateTransfers: 0, transfers144: 0, mints: 1, tokens: 1, rejected: 2 },
  );
  assert.deepEqual(stats.series, [[START + 1, 2, 0]]);
});

test("GET /api/blocks counts operations per block, newest first", async () => {
  const blocks = await getJSON("/api/blocks?limit=3");
  assert.deepEqual(blocks.map((b) => b.height), [START + 3, START + 2, START + 1]);
  assert.equal(blocks[2].hash, idx.hashes.get(START + 1));
  assert.deepEqual(blocks[2].ops, { deploy: 0, mint: 1, transfer: 0, attest: 0, rejected: 1 });
  assert.deepEqual(blocks[1].ops, { deploy: 0, mint: 0, transfer: 0, attest: 0, rejected: 1 });
  const all = await getJSON("/api/blocks");
  assert.equal(all.length, 4, "never below the start height");
  assert.deepEqual(all[3].ops, { deploy: 1, mint: 0, transfer: 0, attest: 1, rejected: 0 });
});

test("artifacts, including manifest.json; unknown names are 404", async () => {
  const res = await get("/artifacts/manifest.json");
  assert.equal(res.status, 200);
  assert.equal((await res.json()).protocol, "murkle");
  const vk = await get("/artifacts/verification_key.json");
  assert.deepEqual(await vk.json(), VKEY);
  assert.match(vk.headers.get("cache-control"), /max-age/);
  for (const bad of ["/artifacts/nope.zkey", "/artifacts/..%2Fpackage.json", "/artifacts/toString"]) assert.equal((await get(bad)).status, 404, bad);
  const check = checkArtifacts(ARTIFACTS);
  assert.deepEqual(check, { ok: true, mismatched: [], missing: [] });
  assert.deepEqual(checkArtifacts({ "manifest.json": join(DIR, "dist", "index.html") }).mismatched, ["manifest.json"]);
});

test("SPA fallback: client routes get index.html with security headers; static files are served as files", async () => {
  for (const path of ["/", "/mints", "/app/send", "/tx/" + "ab".repeat(32), "/missing.js"]) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type"), /text\/html/);
    assert.equal(res.headers.get("content-security-policy-report-only"), CSP);
    assert.equal(res.headers.get("content-security-policy"), null, "Report-Only first");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(await res.text(), /<div id="app">/);
  }
  assert.match(CSP, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(CSP, /connect-src 'self' https:\/\/mempool\.space/);
  // No route may be framed until the /embed/t/:TICKER widget view exists (audit V2-10).
  const embed = await get("/embed/HEX");
  assert.match(embed.headers.get("content-security-policy-report-only"), /frame-ancestors 'none'/);
  assert.equal(embed.headers.get("x-frame-options"), "DENY");

  const js = await get("/assets/app-1234.js");
  assert.match(js.headers.get("content-type"), /text\/javascript/);
  assert.match(js.headers.get("cache-control"), /immutable/);
  assert.equal(await js.text(), "console.log('app');");

  for (const sneaky of ["/..%2Fsecret.txt", "/%2e%2e/secret.txt", "/assets/..%2F..%2Fsecret.txt"]) {
    const text = await (await get(sneaky)).text();
    assert.ok(!text.includes("outside the web root"), sneaky);
  }
  assert.equal((await get("/api/nope")).status, 404, "unknown API paths are not the SPA");
  assert.equal((await get("/mints", { method: "DELETE" })).status, 405);
});

test("/t/:ticker gets escaped OG and Twitter meta; unknown or invalid tickers get the generic card", async () => {
  const html = await (await get("/t/HEX")).text();
  assert.match(html, /<title>HEX on Murkle<\/title>/);
  assert.match(html, /<meta property="og:title" content="HEX on Murkle" \/>/);
  assert.match(html, /<meta property="og:description" content="1 of 21 mints \(live\) · 123\.45 HEX per mint · 1500 sats per mint\. A private token on Bitcoin; signet test network, no value\." \/>/);
  assert.match(html, /<meta property="og:image" content="https:\/\/murkle\.example\/og\.png" \/>/);
  assert.match(html, /<meta property="og:url" content="https:\/\/murkle\.example\/t\/HEX" \/>/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/);
  assert.ok(!html.includes("static title") && !html.includes('content="summary"'), "the static og/twitter tags are replaced, not duplicated");
  assert.equal((html.match(/og:title/g) ?? []).length, 1);

  const lower = await (await get("/t/hex")).text();
  assert.match(lower, /HEX on Murkle/);
  for (const path of ["/t/NOPE", "/t/%3Cscript%3Ealert(1)%3C%2Fscript%3E", "/t/%22onload%3D"]) {
    const page = await (await get(path)).text();
    assert.match(page, /<title>Murkle: private tokens on Bitcoin<\/title>/, path);
    assert.ok(!/<script>alert/i.test(page) && !page.includes('"onload='), path);
  }
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(formatUnits(12345n, 2), "123.45");
  assert.equal(formatUnits(100n, 2), "1");
  assert.equal(formatUnits(5n, 3), "0.005");
  assert.equal(formatUnits(7n, 0), "7");
});

test("relay over HTTP: info, OPTIONS, malformed, too large, a real signed submit, status and ledger", async () => {
  const info = await getJSON("/api/relay/info");
  assert.equal(info.enabled, true);
  assert.equal(info.mode, "balance");
  assert.deepEqual([info.code, info.reason], [null, null]);
  assert.deepEqual(info.ops, ["TRANSACT"]);
  assert.equal(info.address, relayer.address);
  assert.equal(info.pow, null, "no proof of work: every send is paid from a relay balance");
  assert.equal(info.anchor.minAnchor, START + 3 - 76);
  assert.equal("budget" in info, false);
  assert.deepEqual([info.fees.carrierFeeSats, info.balance.perSendSats, info.balance.minDepositSats], [598, 658, 2000]);

  const pre = await get("/api/relay/submit", { method: "OPTIONS" });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-methods"), "GET, POST");
  assert.equal(pre.headers.get("access-control-allow-headers"), "content-type");

  const post = (body, headers = { "content-type": "application/json" }) => get("/api/relay/submit", { method: "POST", headers, body });
  const malformed = await post("{nope");
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, "malformed");
  const big = await post(JSON.stringify({ envelope: "ab".repeat(4000) }));
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error.code, "too_large");
  assert.equal((await get("/api/relay/submit")).status, 405);

  // A real private transfer, carried by the relayer and paid from a relay balance (queued only: nothing is broadcast here).
  alice.scan(idx);
  const envelope = hex(await alice.transfer(idx, { asset: ASSET, amount: 5n, to: deriveKeys(randomBytes(32)) }));
  const body = signedSubmit(payer, info, envelope, "block");
  const ok = await post(body);
  assert.equal(ok.status, 202);
  const { id, status, flush, reservedSats, balance } = await ok.json();
  assert.deepEqual([status, flush, reservedSats, balance], ["queued", "next-block", 658, 6712 - 658]);
  const again = await post(body);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, "replayed", "the same signed request twice");
  const resigned = await post(signedSubmit(payer, info, envelope, "block", { now: () => Date.now() + 1000 }));
  assert.equal(resigned.status, 409);
  assert.equal((await resigned.json()).error.code, "nullifier_pending", "the same envelope in a fresh request");

  const st = await getJSON(`/api/relay/status/${id}`);
  assert.equal(st.status, "queued");
  assert.equal((await get(`/api/relay/status/${"0".repeat(32)}`)).status, 404);
  assert.equal((await get("/api/relay/status/garbage")).status, 404);
  assert.equal((await getJSON("/api/state")).relay.queued, 1);

  const ledger = await getJSON("/api/relay/ledger?limit=10");
  assert.equal(ledger.address, relayer.address);
  assert.deepEqual(ledger.items, []);
  assert.equal(fakeEsplora.calls.length, 0, "nothing is broadcast without a new block");
  assert.equal(fakeEsplora.utxoCalls, 0, "no address was listed");
});

test("tick() syncs, saves, runs the relayer and republishes, under one lock", async () => {
  const other = new Indexer({ vkey: VKEY, startHeight: 10 });
  await other.applyBlock({ height: 10, hash: hash32(), txs: [coinbase()] });
  const chain = {
    tip: 10,
    tipHeight: async () => chain.tip,
    blockHash: async (h) => other.hashes.get(h) ?? `${h}`.padStart(64, "0"),
    rawBlock: async () => {
      throw new Error("offline");
    },
  };
  const statePath = join(DIR, "state.json");
  let relayerTicks = 0;
  const stub = { config: { enabled: true }, queuedCount: () => 0, onTick: async () => (relayerTicks += 1), info: () => ({}) };
  const local = createApp({ idx: other, relayer: stub, api: chain, statePath, log: silent });
  await local.tick();
  assert.equal(local.status.chainTip, 10);
  assert.equal(local.status.lastError, null);
  assert.equal(relayerTicks, 1);
  assert.ok(readFileSync(statePath, "utf8").includes('"version":2'), "indexer state saved");
  assert.equal(local.hashAt(9), "9".padStart(64, "0"), "missing recent hashes are fetched for /api/state");

  chain.tip = 11;
  await local.tick();
  assert.match(local.status.lastError, /offline/);
  assert.equal(local.status.syncing, false);
  assert.equal(relayerTicks, 1, "the relayer does not run on a failed sync");
});

// Second internal audit, protocol area: SPEC rules the decoder already enforces (V2-03,
// V2-04), the treasury statistic's definition (V2-06/V2-42), the Esplora client's fee
// lookup and retries (V2-07, V2-40), atomic state saves shared by two processes (V2-41)
// and the in-browser verifier's honesty about where its inputs came from (V2-08, V2-28,
// V2-29, V2-30).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { deriveKeys } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { decodeEnvelope, encodeDeploy, findEnvelope, opReturnPayload } from "../src/envelope.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { Esplora } from "../src/btc/esplora.mjs";
import { btcAccount, planCarrierTx, signLocal } from "../src/btc/funding.mjs";
import { concat, hex, outpointOf, u32le, unhex } from "../src/bytes.mjs";
import { verifyTx, headerFields, txSizes, classifyReason } from "../src/verify-tx.mjs";
import { saveIndexer } from "../src/store-node.mjs";

const SPEC = readFileSync("SPEC.md", "utf8");
const VKEY_BYTES = new Uint8Array(readFileSync("build/dev/verification_key.json"));
const VKEY = JSON.parse(new TextDecoder().decode(VKEY_BYTES));
const DIR = mkdtempSync(join(tmpdir(), "murkle-audit2-protocol-"));

after(async () => {
  rmSync(DIR, { recursive: true, force: true });
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

/* ------------------------------------------------------------------ V2-03 */

test("V2-03: DEPLOY rules the decoder enforces are written in SPEC section 7", () => {
  const treasury = btcAccount(randomBytes(32)).script;
  const good = encodeDeploy({ ticker: "ABC", divisibility: 0, mintAmount: 5n, mintCap: 1, priceSats: 0n, treasury, startHeight: 400_000, endHeight: 500_000 });
  assert.equal(decodeEnvelope(good).ticker, "ABC");
  // Layout: magic 3 ‖ version 1 ‖ op 1 ‖ len 1 ‖ "ABC" ‖ div 1 ‖ mintAmount 8 ‖ mintCap 4 ‖ price 8 ‖ len 1 ‖ treasury ‖ start 4 ‖ end 4.
  const amountAt = 5 + 1 + 3 + 1;
  const big = Uint8Array.from(good);
  big.set([0, 0, 0, 0, 0, 0, 0, 0x80], amountAt); // 2^63, mintCap 1: fits u64, not i64
  assert.throws(() => decodeEnvelope(big), /mintAmount exceeds i64/);
  const backwards = Uint8Array.from(good);
  backwards.set(u32le(500_000), good.length - 8);
  backwards.set(u32le(400_000), good.length - 4);
  assert.throws(() => decodeEnvelope(backwards), /end before start/);

  const table = SPEC.slice(SPEC.indexOf("### DEPLOY"), SPEC.indexOf("### MINT (op"));
  assert.match(table, /mintAmount \| u64 LE, > 0 and ≤ 2\^63 − 1 \(MINT carries `publicAmount` as i64\)/);
  assert.match(table, /when endHeight ≠ 0, endHeight ≥ startHeight/);
  assert.match(table, /A DEPLOY that breaks any rule of this table .* is malformed/s);
  assert.match(table, /claims no ticker and adds no asset/);
});

/* ------------------------------------------------------------------ V2-04 */

test("V2-04: the OP_RETURN extraction rule in SPEC section 6 matches opReturnPayload exactly", () => {
  const mrk = [0x6d, 0x72, 0x6b];
  const p = (bytes) => opReturnPayload(Uint8Array.from(bytes));
  assert.deepEqual([...p([0x6a, 0x4c, 3, ...mrk])], mrk, "non-minimal OP_PUSHDATA1");
  assert.deepEqual([...p([0x6a, 0x4d, 3, 0, ...mrk])], mrk, "non-minimal OP_PUSHDATA2");
  assert.deepEqual([...p([0x6a, 0x4e, 3, 0, 0, 0, ...mrk])], mrk, "non-minimal OP_PUSHDATA4");
  assert.deepEqual([...p([0x6a, 2, 0x6d, 0x72, 1, 0x6b])], mrk, "split pushes are concatenated");
  for (const op of [0x00, 0x4f, 0x50, 0x51, 0x60]) assert.equal(p([0x6a, op, 3, ...mrk]), null, `opcode ${op} means no envelope`);
  assert.equal(p([0x6a, 5, ...mrk]), null, "a push running past the end means no envelope");
  assert.equal(p([0x51, 3, ...mrk]), null, "must start with OP_RETURN");
  // The search moves on to the next output.
  const tx = { outputs: [{ script: Uint8Array.from([0x6a, 0x00, 3, ...mrk]) }, { script: Uint8Array.from([0x6a, 3, ...mrk]) }] };
  assert.deepEqual([...findEnvelope(tx)], mrk);

  const rule = SPEC.slice(SPEC.indexOf("## 6. Indexer rules"), SPEC.indexOf("2. ATTEST (section 8)"));
  for (const re of [
    /start with `OP_RETURN` \(0x6a\)/,
    /concatenation, in order, of the data of every push/,
    /0x01-0x4b\) or `OP_PUSHDATA1\/2\/4`/,
    /Non-minimal\s+pushes are allowed/,
    /`OP_0` \(0x00\), `OP_1NEGATE` \(0x4f\), `OP_RESERVED`\s+\(0x50\) and `OP_1`..`OP_16` \(0x51-0x60\)/,
    /runs past the end of the script/,
    /The search moves on to the next output/,
    /The first output whose payload starts with the 3 bytes `mrk`/,
    /"Strictly canonical" applies to the envelope bytes/,
  ]) assert.match(rule, re);
});

/* ------------------------------------------------------------- V2-06/V2-42 */

test("V2-06/V2-42: SPEC defines treasurySats as gross sats sent to the treasury script, change included", () => {
  const stats = SPEC.slice(SPEC.indexOf("## 11. Log entries"), SPEC.indexOf("## 12."));
  assert.doesNotMatch(stats, /\(paid by accepted mints\)/, "the old, misleading definition is gone");
  assert.match(stats, /`treasurySats` is the gross sum of every output paying to the treasury script/);
  assert.match(stats, /any change a payer\s+sends back to the treasury script/);
  assert.match(stats, /`priceSats × minted` is\s+the nominal mint revenue/);
  assert.match(stats, /Neither field is part of `assetsHash` or the digest/);
});

/* ------------------------------------------------------------ V2-07, V2-40 */

/** A local Esplora/electrs stand-in. `routes[path]` is (req, res, n) => void, n counting calls. */
async function esploraServer(routes) {
  const calls = new Map();
  const server = createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    const n = (calls.get(`${req.method} ${path}`) ?? 0) + 1;
    calls.set(`${req.method} ${path}`, n);
    const route = routes[path];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("endpoint does not exist");
    }
    return route(req, res, n);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, calls, close: () => new Promise((r) => server.close(r)) };
}
const json = (body, status = 200) => (req, res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const text = (body, status = 200) => (req, res) => {
  res.writeHead(status, { "content-type": "text/plain" });
  res.end(body);
};

test("V2-07: feeRate works against a standard Esplora (no /v1/fees/recommended) and rounds up", async () => {
  const s = await esploraServer({ "/api/fee-estimates": json({ 1: 7.2, 3: 1.5, 6: 1.1, 144: 1 }), "/api/blocks/tip/height": text("123") });
  try {
    for (const base of [`${s.origin}/api`, `${s.origin}/api/`]) {
      const e = new Esplora(base, { retryMs: 1 });
      assert.equal(await e.tipHeight(), 123);
      assert.equal(await e.feeRate(), 2, base);
    }
  } finally {
    await s.close();
  }
});

test("V2-07: feeRate prefers mempool.space's halfHourFee, rounds a fraction up, and falls back cleanly", async () => {
  const mempool = await esploraServer({ "/api/v1/fees/recommended": json({ fastestFee: 3, halfHourFee: 1.2, hourFee: 1 }), "/api/fee-estimates": json({ 3: 9 }) });
  const quiet = await esploraServer({ "/esplora/fee-estimates": json({}) });
  const broken = await esploraServer({ "/api/fee-estimates": json(["not", "a", "map"]) });
  try {
    assert.equal(await new Esplora(`${mempool.origin}/api`, { retryMs: 1 }).feeRate(), 2);
    assert.equal(mempool.calls.get("GET /api/fee-estimates"), undefined, "the fallback is not needed");
    // A base without the /api suffix goes straight to /fee-estimates; an empty map is the minimum rate.
    assert.equal(await new Esplora(`${quiet.origin}/esplora`, { retryMs: 1 }).feeRate(), 1);
    // Neither endpoint usable: a clear error, never a JSON SyntaxError from a 404 page.
    await assert.rejects(new Esplora(`${broken.origin}/api`, { retryMs: 1 }).feeRate(), (e) => !(e instanceof SyntaxError) && /fee-estimates/.test(e.message));
    const none = await esploraServer({});
    try {
      await assert.rejects(new Esplora(`${none.origin}/api`, { retryMs: 1 }).feeRate(), /GET \/fee-estimates: 404/);
    } finally {
      await none.close();
    }
  } finally {
    await Promise.all([mempool.close(), quiet.close(), broken.close()]);
  }
});

test("V2-40: reads are retried after a connection reset or a 5xx; a POST is never retried on them", async () => {
  const s = await esploraServer({
    // The first two calls drop the connection mid-request (fetch rejects: "fetch failed", ECONNRESET).
    "/api/blocks/tip/height": (req, res, n) => (n <= 2 ? req.socket.destroy() : text("324917")(req, res)),
    "/api/block-height/5": (req, res, n) => (n === 1 ? text("upstream down", 503)(req, res) : text("ab".repeat(32))(req, res)),
    "/api/block-height/6": text("still down", 502),
    "/api/tx": text("server error", 500),
  });
  try {
    const e = new Esplora(`${s.origin}/api`, { retryMs: 1 });
    assert.equal(await e.tipHeight(), 324917);
    assert.equal(s.calls.get("GET /api/blocks/tip/height"), 3);
    assert.equal(await e.blockHash(5), "ab".repeat(32));
    // Retries are bounded, and the final error still names the status (callers match on it).
    await assert.rejects(e.blockHash(6), /GET \/block-height\/6: 502 still down/);
    assert.equal(s.calls.get("GET /api/block-height/6"), 1 + e.retries);
    // A broadcast may have reached the node: its first answer stands.
    await assert.rejects(e.broadcast("00"), /POST \/tx: 500/);
    assert.equal(s.calls.get("POST /api/tx"), 1);
    // A 404 is an answer, not a transient failure.
    await assert.rejects(e.request("/nope"), /GET \/nope: 404/);
    assert.equal(s.calls.get("GET /api/nope"), 1);
  } finally {
    await s.close();
  }
});

/* ------------------------------------------------------------------ V2-41 */

test("V2-41: two processes saving the same state file never clash on a temp file", { timeout: 120_000 }, async () => {
  const path = join(DIR, "state.json");
  const store = pathToFileURL(join(process.cwd(), "src", "store-node.mjs")).href;
  // Each writer saves a snapshot of a different size, as a CLI and a server at different heights do.
  // Both start saving at the same instant and keep at it for 800 ms. Module loading takes a while,
  // and longer on a loaded machine, so each writer waits at a barrier (a ready file per writer)
  // until the other has loaded too, instead of at a fixed clock time.
  const ready = (pad) => `${path}.ready-${pad}`;
  const writer = (pad, other) => `
    const { existsSync, writeFileSync } = await import("node:fs");
    const { saveIndexer } = await import(${JSON.stringify(store)});
    const idx = { snapshot: () => ({ who: ${pad}, pad: "x".repeat(${pad}) }) };
    writeFileSync(${JSON.stringify(ready(pad))}, "");
    const giveUp = Date.now() + 60000;
    while (!existsSync(${JSON.stringify(ready(other))}) && Date.now() < giveUp);
    const end = Date.now() + 800;
    let saves = 0;
    while (Date.now() < end) { saveIndexer(${JSON.stringify(path)}, idx); saves++; }
    console.log(saves);
  `;
  const run = (pad, other) => new Promise((resolve) => {
    execFile(process.execPath, ["--input-type=module", "-e", writer(pad, other)], (err, stdout, stderr) => resolve({ err, stdout, stderr }));
  });
  const results = await Promise.all([run(150_000, 20_000), run(20_000, 150_000)]);
  for (const pad of [150_000, 20_000]) rmSync(ready(pad), { force: true }); // the barrier files are the test's, not the store's
  for (const r of results) assert.ok(Number(r.stdout) > 20, `each writer saved many times while the other did: ${r.stdout} ${r.stderr}`);
  for (const r of results) assert.equal(r.err, null, r.stderr);
  const final = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(final.who === 150_000 || final.who === 20_000);
  assert.equal(final.pad.length, final.who, "the file is one writer's snapshot, whole");
  assert.deepEqual(readdirSync(DIR).filter((f) => f.endsWith(".tmp")), [], "no temp file is left behind");

  // In-process: the temp name is unique per call and never the bare `<path>.tmp`.
  saveIndexer(path, { snapshot: () => ({ ok: 1 }) });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { ok: 1 });
  assert.deepEqual(readdirSync(DIR).sort(), ["state.json"]);
});

/* ---------------------------------------------- verifier: a small fake chain */

const BASE = "https://esplora.invalid/api";
const START = 300000;
const PRICE = 1000n;
const MINT_AMOUNT = 500n;
const dsha = (b) => sha256(sha256(b));
const rev = (b) => Uint8Array.from(b).reverse();
const randTxid = () => randomBytes(32).toString("hex");

const idx = new Indexer({ vkey: VKEY, startHeight: START });
const served = new Map();
const where = new Map();
const blocks = [];
const hexOverride = new Map();
let prevHash = new Uint8Array(32);

function merkleLevels(hashes) {
  const levels = [hashes];
  while (levels.at(-1).length > 1) {
    const l = levels.at(-1);
    const next = [];
    for (let i = 0; i < l.length; i += 2) next.push(dsha(concat(l[i], l[i + 1] ?? l[i])));
    levels.push(next);
  }
  return levels;
}

function proofFor(txid) {
  const w = where.get(txid);
  const levels = merkleLevels(blocks.find((b) => b.height === w.height).hashes);
  const merkle = [];
  let i = w.pos;
  for (const l of levels.slice(0, -1)) {
    merkle.push(hex(rev(l[i ^ 1] ?? l[i])));
    i = Math.floor(i / 2);
  }
  return { block_height: w.height, merkle, pos: w.pos };
}

async function mine(txs) {
  const height = idx.height + 1;
  const coinbase = randTxid();
  const hashes = [coinbase, ...txs.map((t) => t.txid)].map((id) => rev(unhex(id)));
  const root = merkleLevels(hashes).at(-1)[0];
  let header;
  for (let nonce = 0; ; nonce++) {
    header = concat(u32le(0x20000000), prevHash, root, u32le(1_700_000_000 + height), u32le(0x207fffff), u32le(nonce));
    if (headerFields(header).meetsTarget) break;
  }
  const hash = hex(rev(dsha(header)));
  prevHash = dsha(header);
  blocks.push({ height, hash, header: hex(header), hashes });
  txs.forEach((t, k) => {
    served.set(t.txid, t.hex);
    where.set(t.txid, { height, hash, pos: k + 1 });
  });
  await idx.applyBlock({ height, hash, txs: [{ txid: coinbase, inputs: [], outputs: [] }, ...txs.map((t) => parseRawTx(t.hex, t.txid))] });
}

function fakeFetch(url) {
  const path = String(url).slice(BASE.length);
  const ok = (v) => new Response(typeof v === "string" ? v : JSON.stringify(v));
  const nf = () => new Response("Transaction not found", { status: 404 });
  let m;
  if (path === "/blocks/tip/height") return ok(String(idx.height));
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/hex$/))) {
    const h = hexOverride.get(m[1]) ?? served.get(m[1]);
    return h ? ok(h) : nf();
  }
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/status$/))) {
    const w = where.get(m[1]);
    return w ? ok({ confirmed: true, block_height: w.height, block_hash: w.hash, block_time: 1 }) : nf();
  }
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/merkle-proof$/))) return where.has(m[1]) ? ok(proofFor(m[1])) : nf();
  if ((m = path.match(/^\/block\/([0-9a-f]{64})\/header$/))) {
    const b = blocks.find((x) => x.hash === m[1]);
    return b ? ok(b.header) : nf();
  }
  return nf();
}

const payerKey = randomBytes(32);
const payer = btcAccount(payerKey);
const TREASURY = btcAccount(randomBytes(32)).script;
const utxo = () => ({ txid: randTxid(), vout: 0, value: 100_000 });
function carrier(envelope, { outputs = [], first = utxo() } = {}) {
  const { tx } = planCarrierTx({ account: payer, utxos: [first], envelope, outputs, feeRate: 1, firstInput: first });
  const signed = signLocal(tx, payerKey);
  return { hex: signed.hex, txid: signed.txid, vsize: signed.vsize };
}

const alice = new Wallet(deriveKeys(randomBytes(32)));
const bob = new Wallet(deriveKeys(randomBytes(32)));
const T = {};
const realFetch = globalThis.fetch;
const logOf = (txid) => idx.log.find((l) => l.txid === txid) ?? null;
const ctx = (over = {}) => ({
  esplora: new Esplora(BASE),
  vkeyBytes: async () => VKEY_BYTES,
  pinnedVkeySha256: hex(sha256(VKEY_BYTES)),
  genesisTxid: null,
  anchorRoot: async (h) => (idx.roots.has(h) ? { root: idx.roots.get(h), source: "YOU", kind: "replay", detail: "from your own replay" } : null),
  assetInfo: async (id) => {
    const a = idx.assets.get(id);
    return a ? { deployTxid: a.deployTxid, ticker: a.ticker } : null;
  },
  indexerVerdict: async (txid) => logOf(txid),
  ...over,
});
const stepOf = (r, id) => r.steps.find((s) => s.id === id);
const failedAt = (r) => r.steps.find((s) => s.status === "fail")?.id ?? null;
const lie = (patch) => async (txid) => ({ ...logOf(txid), reason: undefined, ...patch });

before(async () => {
  globalThis.fetch = async (url, init) => (String(url).startsWith(BASE) ? fakeFetch(url) : realFetch(url, init));
  // Block START: a paid token whose mint window closes at START + 1.
  T.deploy = carrier(encodeDeploy({ ticker: "WIN", divisibility: 0, mintAmount: MINT_AMOUNT, mintCap: 10, priceSats: PRICE, treasury: TREASURY, endHeight: START + 1 }));
  await mine([T.deploy]);
  const asset = assetIdOf(START, 1);
  // Block START + 1: a mint inside the window.
  const bind = utxo();
  T.mint = carrier(await alice.mint(idx, { asset, mintAmount: MINT_AMOUNT, bindOutpoint: outpointOf(bind.txid, bind.vout) }), { outputs: [{ script: TREASURY, amount: PRICE }], first: bind });
  await mine([T.mint]);
  // Block START + 2: a private transfer, and a mint after the window closed.
  alice.scan(idx);
  T.transferEnv = await alice.transfer(idx, { asset, amount: 200n, to: bob.address });
  T.transfer = carrier(T.transferEnv);
  const late = utxo();
  T.lateMint = carrier(await alice.mint(idx, { asset, mintAmount: MINT_AMOUNT, bindOutpoint: outpointOf(late.txid, late.vout) }), { outputs: [{ script: TREASURY, amount: PRICE }], first: late });
  await mine([T.transfer, T.lateMint]);
  // Block START + 3: the same transfer envelope carried again, a double spend.
  T.dup = carrier(T.transferEnv);
  await mine([T.dup]);

  assert.equal(logOf(T.mint.txid).ok, true);
  assert.equal(logOf(T.transfer.txid).ok, true);
  assert.equal(logOf(T.lateMint.txid).reason, "mint closed");
  assert.equal(logOf(T.dup.txid).reason, "nullifier already spent");
});

after(() => {
  globalThis.fetch = realFetch;
});

/* ------------------------------------------------------------------ V2-08 */

test("V2-08: hostile raw-tx hex fails fast with 'not a valid transaction' instead of hanging", async () => {
  for (const bad of ["01000000ffffffffffffffffff", "01000000fe00000010", "01000000fe00000001", "0100", "0100000001"]) {
    const t0 = Date.now();
    assert.throws(() => txSizes(unhex(bad)), /truncated data/, bad);
    assert.ok(Date.now() - t0 < 200, `${bad} took ${Date.now() - t0} ms`);
  }
  // Real transactions still measure exactly.
  for (const t of [T.deploy, T.transfer]) assert.equal(txSizes(unhex(t.hex)).vsize, t.vsize);

  const victim = randTxid();
  where.set(victim, where.get(T.transfer.txid));
  hexOverride.set(victim, "01000000ffffffffffffffffff");
  try {
    const t0 = Date.now();
    const r = await verifyTx(victim, ctx());
    assert.ok(Date.now() - t0 < 2000, "verifyTx finished");
    assert.equal(stepOf(r, "fetch").status, "ok", "the fetch itself worked");
    assert.equal(r.sizes, null);
    assert.equal(failedAt(r), "txid");
    assert.match(stepOf(r, "txid").detail, /not a valid transaction: truncated data/);
    assert.equal(r.verdict, "failed");
  } finally {
    hexOverride.delete(victim);
    where.delete(victim);
  }
});

/* ------------------------------------------------------------------ V2-28 */

test("V2-28: a rebuild root mismatch is a finding against the indexer, never 'agrees' or 'Proof failed'", async () => {
  const mismatch = async () => ({ root: 1n, source: "YOU", kind: "rebuild", mismatch: true, detail: "your rebuild from 3 commitments differs from the root our indexer reports. Do not trust this indexer." });
  for (const verdict of [lie({ ok: false, reason: "proof does not verify" }), lie({ ok: false, reason: "nullifier already spent" }), lie({ ok: true }), async () => null]) {
    const r = await verifyTx(T.transfer.txid, ctx({ anchorRoot: mismatch, indexerVerdict: verdict }));
    assert.equal(r.verdict, "mismatch");
    assert.equal(r.rootMismatch, true);
    assert.equal(failedAt(r), "root");
    assert.equal(stepOf(r, "groth16").status, "skip", "no proof was checked");
    assert.doesNotMatch(stepOf(r, "indexer").detail, /[Aa]grees/);
  }
  const rejected = await verifyTx(T.transfer.txid, ctx({ anchorRoot: mismatch, indexerVerdict: lie({ ok: false, reason: "proof does not verify" }) }));
  assert.equal(stepOf(rejected, "indexer").status, "fail");
  assert.match(stepOf(rejected, "indexer").detail, /differs from your rebuild of its own commitments.*Do not trust this indexer/);
});

/* ------------------------------------------------------------------ V2-29 */

test("V2-29: a pairing failure against an indexer-supplied root is no browser verdict", async () => {
  const at = logOf(T.transfer.txid);
  const wrong = (kind) => async (h) => ({ root: idx.roots.get(h) + 1n, source: kind === "indexer" ? "IDX" : "YOU", kind, detail: kind === "rebuild" ? "rebuilt from 4 commitments · matches its root" : "reported by our indexer" });
  for (const kind of ["rebuild", "indexer"]) {
    // A lying indexer serves a wrong (self-consistent) root and calls an honest payment invalid.
    const r = await verifyTx(T.transfer.txid, ctx({ anchorRoot: wrong(kind), indexerVerdict: lie({ ok: false, reason: "proof does not verify" }) }));
    assert.equal(failedAt(r), "groth16", kind);
    assert.equal(stepOf(r, "groth16").fault, "data", "not a rule this browser saw broken");
    assert.match(stepOf(r, "groth16").detail, /anchor root .* That root is the indexer's word.*Verify the Pool/);
    assert.equal(r.untrustedRootFail, true);
    assert.equal(r.verdict, "failed");
    assert.equal(stepOf(r, "indexer").status, "skip", "inconclusive, not 'agrees'");
    assert.doesNotMatch(stepOf(r, "indexer").detail, /[Aa]grees/);
    // An indexer that accepted it contradicts its own root.
    const accepted = await verifyTx(T.transfer.txid, ctx({ anchorRoot: wrong(kind), indexerVerdict: async () => at }));
    assert.equal(accepted.verdict, "mismatch", kind);
    assert.match(stepOf(accepted, "indexer").detail, /does not verify against the anchor root this same indexer supplied/);
  }
  // A root from the user's own replay keeps the pairing failure a real browser result.
  const own = await verifyTx(T.transfer.txid, ctx({ anchorRoot: async (h) => ({ root: idx.roots.get(h) + 1n, source: "YOU", kind: "replay" }), indexerVerdict: lie({ ok: false, reason: "proof does not verify" }) }));
  assert.equal(stepOf(own, "groth16").fault, "rule");
  assert.match(stepOf(own, "indexer").detail, /Agrees with your browser/);
  // The honest path is unchanged: the right root from the indexer verifies.
  const honest = await verifyTx(T.transfer.txid, ctx({ anchorRoot: async (h) => ({ root: idx.roots.get(h), source: "IDX", kind: "indexer" }) }));
  assert.equal(honest.verdict, "verified");
});

/* ------------------------------------------------------------------ V2-30 */

test("V2-30: an accepted verdict never claims the browser checked history rules it can't see", async () => {
  // A lying indexer accepts a double spend: the proof is valid, the nullifiers were spent.
  const lying = await verifyTx(T.dup.txid, ctx({ indexerVerdict: lie({ ok: true }) }));
  assert.equal(lying.verdict, "verified");
  assert.equal(lying.historyFrom, "IDX");
  const detail = stepOf(lying, "indexer").detail;
  assert.doesNotMatch(detail, /agrees with your browser$/);
  assert.match(detail, /agrees with every rule your browser checked; the history rules \(spent nullifiers\) rest on the indexer's log/);
  const mint = await verifyTx(T.mint.txid, ctx());
  assert.match(stepOf(mint, "indexer").detail, /history rules \(spent nullifiers, mint cap\)/);

  // With the user's own replay covering the block, history rules become a browser result.
  const replay = { replayVerdict: async (txid) => logOf(txid) };
  const caught = await verifyTx(T.dup.txid, ctx({ indexerVerdict: lie({ ok: true }), ...replay }));
  assert.equal(caught.verdict, "mismatch");
  assert.match(stepOf(caught, "indexer").detail, /your own replay of the pool rejects it: nullifier already spent/);
  const confirmed = await verifyTx(T.transfer.txid, ctx(replay));
  assert.equal(confirmed.verdict, "verified");
  assert.equal(confirmed.historyFrom, "YOU");
  assert.match(stepOf(confirmed, "indexer").detail, /agrees with your browser and with your own replay of the pool/);
  const both = await verifyTx(T.dup.txid, ctx(replay));
  assert.equal(both.verdict, "rejected");
  assert.equal(stepOf(both, "indexer").status, "ok");
  assert.match(stepOf(both, "indexer").detail, /Your own replay of the pool rejects it too/);
  // A replay that has no entry (it doesn't cover the block) changes nothing.
  const uncovered = await verifyTx(T.dup.txid, ctx({ replayVerdict: async () => null }));
  assert.equal(uncovered.verdict, "rejected");
  assert.equal(uncovered.historyFrom, "IDX");
});

test("V2-30: the mint window is checked in the browser, so 'mint closed' is no longer the indexer's word", async () => {
  assert.equal(classifyReason("mint closed"), "checked");
  assert.equal(classifyReason("mint cap reached"), "history");
  const honest = await verifyTx(T.lateMint.txid, ctx());
  assert.equal(failedAt(honest), "terms");
  assert.equal(stepOf(honest, "terms").fault, "rule");
  assert.match(stepOf(honest, "terms").detail, /outside the mint window .*#300,001.*the mint was closed/);
  assert.match(stepOf(honest, "indexer").detail, /mint closed\. Agrees with your browser/);
  const lying = await verifyTx(T.lateMint.txid, ctx({ indexerVerdict: lie({ ok: true }) }));
  assert.equal(lying.verdict, "mismatch");
  // An indexer that calls an in-window mint closed is caught too.
  const framed = await verifyTx(T.mint.txid, ctx({ indexerVerdict: lie({ ok: false, reason: "mint closed" }) }));
  assert.equal(framed.verdict, "mismatch");
  assert.match(stepOf(framed, "terms").detail, /mint window open/);
});

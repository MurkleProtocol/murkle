// Phase-2 trusted-setup ceremony (audit A-8, docs/CEREMONY.md, docs/design/mainnet-readiness.md §5).
//
// A real small ceremony end to end in Node on a tiny circuit (test/fixtures/ceremony/sanity_decoder.r1cs,
// a power-6 ptau generated here with the snarkjs CLI): init, three contributions over HTTP (the CLI
// online, the CLI air-gapped in three steps, and web/src/ceremony/client.js plus the worker's core
// function), automatic close from a fake chain, finalize with the real mainnet block 900000 as the
// beacon (served by a fake Esplora), verify.mjs, a proof made and checked with the final key, and the
// install into a temporary root. Then every refusal of the coordinator.
//
// Temporary directories and port 0 only: nothing touches build/, src/pins*.json or data/, nothing is
// broadcast, no real network. With MURKLE_CEREMONY_REAL=1 and the build files present, one dry
// contribution on the real circuit's initial key (read-only) is verified too.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, request } from "node:http";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import {
  PINNED, ceremonyPaths, cleanName, contributionsTranscriptSha256, newInitialZkey, readContributions, sha256Hex,
  terminateCurve, verifyUpload,
} from "../scripts/ceremony/lib.mjs";
import { initCeremony } from "../scripts/ceremony/init.mjs";
import { finalizeCeremony, installFinal } from "../scripts/ceremony/finalize.mjs";
import { verifyCeremony } from "../scripts/ceremony/verify.mjs";
import { createCeremonyServer, ipPrefix, verifyInChildProcess } from "../server/ceremony-server.mjs";
import { CeremonyClient } from "../web/src/ceremony/client.js";
import { contributeZkey, freshEntropy } from "../web/src/ceremony/core.js";
import { checkReceipt, findContribution, formatHash, normalizeHash, receiptText } from "../web/src/ceremony/receipt.js";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const FIX = join(ROOT, "test", "fixtures", "ceremony");
const R1CS = join(FIX, "sanity_decoder.r1cs");
const WASM = join(FIX, "sanity_decoder.wasm");
const BEACON = JSON.parse(readFileSync(join(FIX, "beacon-mainnet-900000.json"), "utf8"));
const H = BEACON.height;
const MAINNET_GENESIS = "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";
const SNARKJS_CLI = join(ROOT, "node_modules", "snarkjs", "build", "cli.cjs");
const TMP = mkdtempSync(join(tmpdir(), "murkle-ceremony-"));
const PTAU = join(TMP, "test.ptau");

// Files this test must never change.
const GUARDED = ["src/pins.json", "build/manifest.json"].map((p) => join(ROOT, p)).filter((p) => existsSync(p));
const fileSha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const guardedBefore = GUARDED.map((p) => [p, fileSha(p)]);
const dataCeremonyBefore = existsSync(join(ROOT, "data", "ceremony"));

// Child processes run without the operator's MURKLE_* settings.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MURKLE_")));
function node(script, args, { env = {} } = {}) {
  return new Promise((done) => {
    execFile(process.execPath, [join(ROOT, script), ...args], { env: { ...cleanEnv, ...env }, cwd: ROOT, maxBuffer: 16 << 20, timeout: 300_000 }, (err, stdout, stderr) =>
      done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr }));
  });
}
const lastJson = (s) => JSON.parse(s.trim().split("\n").at(-1));

/* ---------------------------------------------------------------- fakes */

const fakeChain = { tip: H - 2000, header: BEACON.header, hash: BEACON.hash };
let esploraUrl;
const esplora = createServer((req, res) => {
  const u = req.url;
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "text/plain" });
    res.end(String(body));
  };
  if (u === "/api/blocks/tip/height") return send(200, fakeChain.tip);
  if (u === "/api/block-height/0") return send(200, MAINNET_GENESIS);
  if (u === `/api/block-height/${H}`) return fakeChain.tip >= H ? send(200, fakeChain.hash) : send(404, "Block not found");
  if (u === `/api/block/${fakeChain.hash}/header`) return send(200, fakeChain.header);
  send(404, "not found");
});

const servers = [];
async function startCoordinator(dir, opts = {}) {
  const logs = [];
  const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const app = createCeremonyServer({ dir, r1csPath: R1CS, ptauPath: PTAU, log, minFreeDiskBytes: 0, ...opts });
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  servers.push(app);
  return { app, url, logs };
}

async function api(url, method, path, { pass = null, json, body, headers = {} } = {}) {
  const h = { ...headers };
  if (pass) h.authorization = `Bearer ${pass}`;
  if (json !== undefined) h["content-type"] = "application/json";
  const res = await fetch(url + path, { method, headers: h, body: json !== undefined ? JSON.stringify(json) : body });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

/** A raw request whose declared Content-Length and body can disagree with the truth. */
function rawPost(url, path, { headers = {}, body = null, chunked = false } = {}) {
  return new Promise((done, fail) => {
    const u = new URL(url + path);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers }, (res) => {
      let t = "";
      res.on("data", (d) => (t += d));
      res.on("end", () => {
        req.destroy();
        done({ status: res.statusCode, data: JSON.parse(t || "null"), headers: res.headers });
      });
    });
    req.on("error", (e) => (e.code === "ECONNRESET" || e.code === "EPIPE" ? null : fail(e)));
    if (chunked) {
      req.write(body ?? "x");
      req.end();
    } else if (body) req.end(body);
    else req.flushHeaders();
  });
}

let counter = 0;
async function newCeremony(id, extra = {}) {
  const dir = join(TMP, `${id}-${++counter}`);
  await initCeremony({ dir, id, r1csPath: R1CS, ptauPath: PTAU, beaconHeight: H, tipHeight: H - 2000, unpinned: true, ...extra });
  return dir;
}

async function contributeTo(client, pass, turn, name) {
  const prev = await client.download(turn.base.url, { expectSha256: turn.base.zkeySha256 });
  return contributeZkey(snarkjs, prev, { name, entropy: freshEntropy("test") });
}

before(async () => {
  // A small phase 1 made here (power 6 covers the 5-constraint circuit).
  for (const args of [
    ["powersoftau", "new", "bn128", "6", join(TMP, "pot0.ptau")],
    ["powersoftau", "contribute", join(TMP, "pot0.ptau"), join(TMP, "pot1.ptau"), "--name=test phase 1", `-e=${Math.random()}`],
    ["powersoftau", "prepare", "phase2", join(TMP, "pot1.ptau"), PTAU],
  ]) {
    const r = await new Promise((done) => execFile(process.execPath, [SNARKJS_CLI, ...args], { timeout: 120_000 }, (err, stdout, stderr) => done({ err, stderr })));
    assert.equal(r.err, null, r.stderr);
  }
  await new Promise((ok) => esplora.listen(0, "127.0.0.1", ok));
  esploraUrl = `http://127.0.0.1:${esplora.address().port}/api`;
});

after(async () => {
  for (const s of servers) await s.close();
  esplora.close();
  await terminateCurve();
  rmSync(TMP, { recursive: true, force: true });
  for (const [p, h] of guardedBefore) assert.equal(fileSha(p), h, `${p} untouched`);
  assert.equal(existsSync(join(ROOT, "data", "ceremony")), dataCeremonyBefore, "data/ceremony neither created nor removed");
});

/* ---------------------------------------------------------------- pieces */

test("the contribution list reader recomputes snarkjs' own contribution hashes", async () => {
  const init = await newInitialZkey(R1CS, PTAU);
  const again = await newInitialZkey(R1CS, PTAU);
  assert.equal(sha256Hex(init), sha256Hex(again), "zkey new is deterministic: anyone recomputes 0000.zkey");
  const a = await contributeZkey(snarkjs, init, { name: "one", entropy: freshEntropy() });
  const b = await contributeZkey(snarkjs, a.zkey, { name: "two", entropy: freshEntropy("extra words") });
  assert.match(a.contributionHash, /^[0-9a-f]{128}$/);
  const { contributions } = await readContributions(b.zkey);
  assert.deepEqual(contributions.map((c) => [c.index, c.name, c.type, c.contributionHash]), [[1, "one", 0, a.contributionHash], [2, "two", 0, b.contributionHash]]);
  const v = await verifyUpload({ init, ptau: PTAU, zkey: b.zkey });
  assert.equal(v.ok, true, v.reason);
  // Two contributions with the same entropy text still differ: snarkjs adds its own 64 random bytes.
  const c = await contributeZkey(snarkjs, init, { name: "one", entropy: "a".repeat(128) });
  const d = await contributeZkey(snarkjs, init, { name: "one", entropy: "a".repeat(128) });
  assert.notEqual(c.contributionHash, d.contributionHash);
  await assert.rejects(readContributions(Buffer.from("not a zkey at all, just text")), /not a zkey/);
  await assert.rejects(contributeZkey(snarkjs, init, { name: "x", entropy: "short" }), /entropy/);
});

test("receipt helpers: hash formats, receipt checks, transcript lookup", () => {
  const h = "ab".repeat(64);
  const pretty = formatHash(h);
  assert.equal(pretty.split("\n").length, 4);
  assert.equal(normalizeHash(pretty), h);
  assert.equal(normalizeHash(h.toUpperCase()), h);
  assert.equal(normalizeHash("ab".repeat(63)), null);
  const r = { ceremony: "c", index: 1, name: "n", contributionHash: h, zkeySha256: "11".repeat(32), prevZkeySha256: "22".repeat(32), acceptedAt: "t", verifiedWith: "v" };
  assert.deepEqual(checkReceipt(r, pretty), { ok: true, problems: [] });
  assert.equal(checkReceipt(r, "cd".repeat(64)).ok, false);
  assert.equal(checkReceipt({ ...r, zkeySha256: "x" }).ok, false);
  assert.equal(findContribution({ contributions: [{ index: 1, contributionHash: h }] }, pretty).index, 1);
  assert.equal(findContribution({ contributions: [] }, h), null);
  assert.match(receiptText(r, { origin: "https://example.org" }), /https:\/\/example\.org\/ceremony\/api\/transcript\.json/);
  assert.equal(cleanName("  alice  "), "alice");
  for (const bad of ["", "   ", "x".repeat(65), "naïve", "tab\there", 7, null]) assert.equal(cleanName(bad), null, String(bad));
  assert.equal(cleanName("x".repeat(64)), "x".repeat(64));
});

test("the client calls fetch as a plain function (browsers throw Illegal invocation otherwise)", async () => {
  const calls = [];
  const strictFetch = function (url, init) {
    "use strict";
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    calls.push([url, init.method, init.credentials]);
    return Promise.resolve(new Response(JSON.stringify({ phase: "open" }), { status: 200 }));
  };
  const c = new CeremonyClient("https://coordinator.example", { fetch: strictFetch });
  assert.deepEqual(await c.status(), { phase: "open" });
  assert.deepEqual(calls, [["https://coordinator.example/ceremony/api/status", "GET", "omit"]]);
  const err = new CeremonyClient("", { fetch: async () => new Response(JSON.stringify({ error: "rejected", reason: "nope" }), { status: 422 }) });
  await assert.rejects(err.upload("ab".repeat(32), new Uint8Array(4)), (e) => e.code === "rejected" && e.status === 422 && e.detail.reason === "nope");
});

test("address prefixes for rate limits: IPv4 /24, IPv6 /48 (one customer allocation)", () => {
  assert.equal(ipPrefix("203.0.113.7"), "203.0.113.0/24");
  assert.equal(ipPrefix("::ffff:203.0.113.200"), "203.0.113.0/24");
  assert.equal(ipPrefix("2001:db8:abcd:12ff:1::1"), "2001:db8:abcd::/48");
  assert.equal(ipPrefix("2001:db8:abcd:1201::9"), "2001:db8:abcd::/48");
  // The 256 /56s of one /48 are one key.
  assert.equal(ipPrefix("2001:db8:abcd:ff01::9"), ipPrefix("2001:db8:abcd:1201::9"));
  assert.notEqual(ipPrefix("2001:db8:abce:1201::9"), ipPrefix("2001:db8:abcd:1201::9"));
  assert.equal(ipPrefix("[2001:db8::1%eth0]"), "2001:db8:0::/48");
  assert.equal(ipPrefix("::1"), "0:0:0::/48");
  assert.equal(ipPrefix("nonsense"), "unknown");
  assert.equal(ipPrefix("1:2:3"), "unknown");
});

test("init refuses an unpinned circuit without --unpinned, a near beacon, a bad id, data/signet and an existing ceremony", async () => {
  await assert.rejects(initCeremony({ dir: join(TMP, "x1"), id: "t", r1csPath: R1CS, ptauPath: PTAU, beaconHeight: H, tipHeight: H - 2000 }), /not the pinned/);
  await assert.rejects(initCeremony({ dir: join(TMP, "x2"), id: "t", r1csPath: R1CS, ptauPath: PTAU, beaconHeight: H, tipHeight: H - 100, unpinned: true }), /at least 1008 blocks/);
  await assert.rejects(initCeremony({ dir: join(TMP, "x3"), id: "Bad Id", r1csPath: R1CS, ptauPath: PTAU, beaconHeight: H, tipHeight: 0, unpinned: true }), /--id/);
  await assert.rejects(initCeremony({ dir: join(ROOT, "data", "signet", "ceremony"), id: "t", r1csPath: R1CS, ptauPath: PTAU, beaconHeight: H, tipHeight: 0, unpinned: true }), /data\/signet/);
  assert.equal(existsSync(join(ROOT, "data", "signet", "ceremony")), false);
  const dir = await newCeremony("dup");
  await assert.rejects(initCeremony({ dir, id: "dup", r1csPath: R1CS, ptauPath: PTAU, beaconHeight: H, tipHeight: 0, unpinned: true }), /never overwritten/);
  const c = JSON.parse(readFileSync(join(dir, "ceremony.json"), "utf8"));
  assert.equal(c.pinned, false);
  assert.deepEqual(c.beacon, { network: "mainnet", height: H, closeBeforeBlocks: 6, iterationsExp: 10 });
  assert.equal(c.initialZkeySha256, sha256Hex(readFileSync(join(dir, "zkeys", "0000.zkey"))));
});

/* ---------------------------------------------------------------- the end-to-end ceremony */

test("a real small ceremony end to end: three contributions, auto-close, beacon, verify, prove, install", async (t) => {
  const dir = join(TMP, "e2e");
  // init through the CLI.
  const init = await node("scripts/ceremony/init.mjs", ["--dir", dir, "--id", "test-e2e", "--r1cs", R1CS, "--ptau", PTAU, "--beacon-height", String(H), "--tip", String(H - 2000), "--unpinned"]);
  assert.equal(init.code, 0, init.stderr);
  assert.match(init.stdout, /UNPINNED: rehearsal only/);
  const P = ceremonyPaths(dir);
  assert.equal(sha256Hex(readFileSync(P.zkey(0))), sha256Hex(await newInitialZkey(R1CS, PTAU)));

  const chain = { tip: H - 500, tipHeight: async () => chain.tip };
  const { app, url, logs } = await startCoordinator(dir, { chain, heartbeatSecs: 60, slotSecs: 600 });
  const passes = [];

  // 1. The CLI, online.
  const one = await node("scripts/ceremony/contribute.mjs", ["--coordinator", url, "--name", "alice", "--json", "--receipt", join(TMP, "r1.json"), "--out", join(TMP, "alice.zkey")]);
  assert.equal(one.code, 0, one.stderr);
  const r1 = lastJson(one.stdout);
  assert.deepEqual(JSON.parse(readFileSync(join(TMP, "r1.json"), "utf8")), r1);
  assert.equal(r1.index, 1);
  assert.equal(r1.name, "alice");
  assert.equal(r1.verifiedWith, "snarkjs 0.7.5 zkey verifyFromInit");
  assert.equal(r1.zkeySha256, sha256Hex(readFileSync(join(TMP, "alice.zkey"))));

  // 2. The CLI, air-gapped in three steps.
  const passFile = join(TMP, "bob.pass");
  const j = await node("scripts/ceremony/contribute.mjs", ["--coordinator", url, "--name", "bob", "--join-only", "--download", join(TMP, "bob-prev.zkey"), "--pass-file", passFile, "--json"]);
  assert.equal(j.code, 0, j.stderr);
  assert.equal(lastJson(j.stdout).index, 2);
  passes.push(readFileSync(passFile, "utf8").trim());
  assert.equal(sha256Hex(readFileSync(join(TMP, "bob-prev.zkey"))), r1.zkeySha256, "downloaded key #1");
  const off = await node("scripts/ceremony/contribute.mjs", ["--in", join(TMP, "bob-prev.zkey"), "--out", join(TMP, "bob-next.zkey"), "--name", "bob", "--json"]);
  assert.equal(off.code, 0, off.stderr);
  const bobHash = lastJson(off.stdout).contributionHash;
  const up = await node("scripts/ceremony/contribute.mjs", ["--upload", join(TMP, "bob-next.zkey"), "--coordinator", url, "--pass-file", passFile, "--expect-hash", bobHash, "--json"]);
  assert.equal(up.code, 0, up.stderr);
  const r2 = lastJson(up.stdout);
  assert.equal(r2.contributionHash, bobHash);
  assert.equal(r2.prevZkeySha256, r1.zkeySha256);
  assert.equal(existsSync(passFile), false, "the pass file is removed after the upload");

  // 3. The browser client and the worker's core function, in Node.
  const client = new CeremonyClient(url);
  const joined = await client.join("carol");
  passes.push(joined.pass);
  assert.equal(joined.position, 0);
  const turn = await client.waitForTurn(joined.pass, { pollMs: 50 });
  assert.equal(turn.state, "active");
  assert.equal(turn.base.index, 2);
  assert.equal(turn.maxUploadBytes, turn.base.bytes + 65536);
  const carol = await contributeTo(client, joined.pass, turn, "carol");
  const r3 = await client.upload(joined.pass, carol.zkey);
  assert.deepEqual(checkReceipt(r3, carol.contributionHash), { ok: true, problems: [] });
  assert.deepEqual(await client.turn(joined.pass), { state: "done", index: 3 });

  // Receipts match the public transcript.
  const tr = await client.transcript();
  assert.equal(tr.contributions.length, 3);
  for (const r of [r1, r2, r3]) {
    const e = tr.contributions[r.index - 1];
    assert.deepEqual([e.index, e.name, e.contributionHash, e.zkeySha256, e.prevZkeySha256, e.acceptedAt], [r.index, r.name, r.contributionHash, r.zkeySha256, r.prevZkeySha256, r.acceptedAt]);
  }
  assert.equal(tr.contributions[0].prevZkeySha256, tr.initial.zkeySha256);
  const alias = await api(url, "GET", "/ceremony/transcript.json");
  assert.deepEqual(alias.data, tr);
  const st = await client.status();
  assert.equal(st.contributions, 3);
  assert.equal(st.latest.contributionHash, r3.contributionHash);
  assert.equal(st.latest.url, "/ceremony/files/0003.zkey");

  // Keys are served, immutable; an unaccepted index is not.
  const f = await fetch(`${url}/ceremony/files/0003.zkey`);
  assert.equal(f.status, 200);
  assert.match(f.headers.get("cache-control"), /immutable/);
  assert.equal(sha256Hex(Buffer.from(await f.arrayBuffer())), r3.zkeySha256);
  assert.equal((await fetch(`${url}/ceremony/files/0004.zkey`)).status, 404);
  assert.equal((await fetch(`${url}/ceremony/files/..%2Fceremony.json`)).status, 404);

  // The coordinator never logs a pass.
  assert.ok(logs.some((l) => /accepted contribution 3/.test(l)), logs.join("\n"));
  for (const p of passes) assert.ok(!logs.join("\n").includes(p), "pass in the log");
  assert.ok(!readFileSync(P.state, "utf8").includes(passes[1]), "only pass hashes are stored");

  // The chain reaches the close height: the queue closes itself.
  chain.tip = H - 6;
  await app.pollChain();
  const closed = await client.status();
  assert.equal(closed.phase, "closed");
  assert.deepEqual(closed.closed.tipHeight, H - 6);
  assert.equal((await api(url, "POST", "/ceremony/api/join", { json: { name: "late" } })).data.error, "closed");
  assert.equal(JSON.parse(readFileSync(P.transcript, "utf8")).closed.tipHeight, H - 6);

  // finalize refuses too early, a bad header and disagreeing sources; then succeeds.
  fakeChain.tip = H + 3;
  let fin = await node("scripts/ceremony/finalize.mjs", ["--dir", dir, "--r1cs", R1CS, "--ptau", PTAU, "--wasm", WASM, "--esplora", esploraUrl, "--cross-check", "none"]);
  assert.equal(fin.code, 2);
  assert.match(fin.stderr, /wait 3 more blocks/);
  fakeChain.tip = H + 10;
  fakeChain.header = BEACON.header.slice(0, -2) + "00"; // another nonce: hashes to something else
  fin = await node("scripts/ceremony/finalize.mjs", ["--dir", dir, "--r1cs", R1CS, "--ptau", PTAU, "--wasm", WASM, "--esplora", esploraUrl, "--cross-check", "none"]);
  assert.equal(fin.code, 2);
  assert.match(fin.stderr, /beacon header hashes to/);
  fakeChain.header = BEACON.header;
  const good = { describe: "a", tipHeight: async () => H + 10, blockHash: async () => BEACON.hash, blockHeader: async () => BEACON.header };
  // A second source that serves another real block (900001) at the beacon height: both are well formed, they disagree.
  const other = { ...good, describe: "b", blockHash: async () => BEACON.next.hash, blockHeader: async () => BEACON.next.header };
  await assert.rejects(finalizeCeremony({ dir, r1csPath: R1CS, ptauPath: PTAU, wasmPath: WASM, sources: [good, other], log: () => {} }), /the sources disagree on block 900000/);
  const lying = { ...good, blockHeader: async () => BEACON.header.replace(/^00a0/, "01a0") };
  await assert.rejects(finalizeCeremony({ dir, r1csPath: R1CS, ptauPath: PTAU, wasmPath: WASM, sources: [good, lying], log: () => {} }), /hashes to/);
  assert.equal(JSON.parse(readFileSync(P.transcript, "utf8")).final, null, "a refused finalize changes nothing");
  fin = await node("scripts/ceremony/finalize.mjs", ["--dir", dir, "--r1cs", R1CS, "--ptau", PTAU, "--wasm", WASM, "--esplora", esploraUrl, "--cross-check", "none"]);
  assert.equal(fin.code, 0, fin.stderr);
  assert.match(fin.stdout, /finalized test-e2e: 3 contributions, beacon block 900000/);
  const final = JSON.parse(readFileSync(P.transcript, "utf8"));
  assert.equal(final.final.beaconBlockHash, BEACON.hash);
  assert.equal(final.final.zkeySha256, sha256Hex(readFileSync(join(P.final, "transaction.zkey"))));
  const manifest = JSON.parse(readFileSync(join(P.final, "manifest.json"), "utf8"));
  assert.equal(manifest.ceremony.transcriptSha256, contributionsTranscriptSha256(final));
  assert.deepEqual(manifest.ceremony.beacon, { network: "mainnet", height: H, blockHash: BEACON.hash, iterationsExp: 10 });
  assert.equal(manifest.sha256.wasm, sha256Hex(readFileSync(WASM)));
  assert.equal(manifest.network, "mainnet");
  assert.match(manifest.setup, /rehearsal/);
  assert.equal((await client.status()).phase, "finalized");
  const again = await node("scripts/ceremony/finalize.mjs", ["--dir", dir, "--esplora", esploraUrl]);
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already finalized/);

  // verify.mjs: everything holds; each tampering is caught.
  const vargs = ["--transcript", P.transcript, "--zkey", join(P.final, "transaction.zkey"), "--r1cs", R1CS, "--ptau", PTAU, "--esplora", esploraUrl,
    "--zkeys-dir", P.zkeys, "--vkey", join(P.final, "verification_key.json"), "--manifest", join(P.final, "manifest.json")];
  let v = await node("scripts/ceremony/verify.mjs", [...vargs, "--unpinned", "--expect-hash", formatHash(r2.contributionHash)]);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /every check holds/);
  assert.match(v.stdout, /ok   beacon block on chain/);
  assert.match(v.stdout, /ok   your contribution: #2 by "bob"/);
  v = await node("scripts/ceremony/verify.mjs", [...vargs]);
  assert.equal(v.code, 1, "an unpinned rehearsal is not accepted as the real ceremony");
  assert.match(v.stdout, /FAIL pinned circuit/);
  v = await node("scripts/ceremony/verify.mjs", [...vargs, "--unpinned", "--expect-hash", "cd".repeat(64)]);
  assert.equal(v.code, 1);
  assert.match(v.stdout, /FAIL your contribution/);
  const forged = { ...final, contributions: final.contributions.map((c, i) => (i === 1 ? { ...c, name: "mallory" } : c)) };
  writeFileSync(join(TMP, "forged.json"), JSON.stringify(forged));
  v = await node("scripts/ceremony/verify.mjs", ["--transcript", join(TMP, "forged.json"), "--zkey", join(P.final, "transaction.zkey"), "--r1cs", R1CS, "--ptau", PTAU, "--beacon-source", "none", "--unpinned"]);
  assert.equal(v.code, 1);
  assert.match(v.stdout, /FAIL contribution hashes/);
  assert.match(v.stdout, /skip beacon block on chain/);
  // A close recorded at H: still placed before the beacon by the tip recorded with each entry; without those tips it fails.
  const late = { ...final, closed: { ...final.closed, tipHeight: H } };
  let lr = await verifyCeremony({ transcript: late, zkeyPath: join(P.final, "transaction.zkey"), r1csPath: R1CS, ptauPath: PTAU, allowUnpinned: true });
  assert.ok(lr.checks.some((c) => c.name === "closed before the beacon" && c.status === "ok" && /recorded tip below/.test(c.detail)), JSON.stringify(lr.checks));
  const lateNoTips = { ...late, contributions: late.contributions.map((c) => ({ ...c, tipHeight: null })) };
  lr = await verifyCeremony({ transcript: lateNoTips, zkeyPath: join(P.final, "transaction.zkey"), r1csPath: R1CS, ptauPath: PTAU, allowUnpinned: true });
  assert.equal(lr.ok, false);
  assert.ok(lr.checks.some((c) => c.name === "closed before the beacon" && c.status === "FAIL"));
  // The close commitment the coordinator recorded at the close, and the announced values.
  const commit = final.closed.commitment;
  assert.match(commit, /^[0-9a-f]{64}$/);
  assert.equal(final.closed.contributions, 3);
  assert.ok(logs.some((l) => l.includes(`publish the close commitment ${commit}`)), "the coordinator logs what to publish");
  const st2 = await node("scripts/ceremony/admin.mjs", ["--dir", dir, "status"]);
  assert.match(st2.stdout, new RegExp(`close commitment ${commit} \\(3 contributions\\): publish it before block ${H}`));
  v = await node("scripts/ceremony/verify.mjs", [...vargs, "--unpinned", "--expect-close-commitment", commit, "--expect-beacon-height", String(H), "--expect-ceremony-id", "test-e2e"]);
  assert.equal(v.code, 0, v.stdout + v.stderr);
  assert.match(v.stdout, /ok   close commitment: recomputed/);
  assert.match(v.stdout, /ok   announced beacon height/);
  assert.match(v.stdout, /ok   announced ceremony id/);
  assert.match(v.stdout, /ok   beacon header: hashes to the block hash and meets the difficulty bounds from pinned checkpoint 969696/);
  assert.match(v.stdout, /closed before the beacon: closed at tip \d+, beacon height \d+: the coordinator's own statement/);
  // Without the published values: skip lines that say what to compare.
  v = await node("scripts/ceremony/verify.mjs", [...vargs, "--unpinned"]);
  assert.match(v.stdout, /skip close commitment: compare [0-9a-f]{64} with the commitment published before block/);
  assert.match(v.stdout, /skip announced beacon height/);
  v = await node("scripts/ceremony/verify.mjs", [...vargs, "--unpinned", "--expect-close-commitment", "00".repeat(32), "--expect-beacon-height", String(H + 1), "--expect-ceremony-id", "other"]);
  assert.equal(v.code, 1);
  for (const name of ["close commitment", "announced beacon height", "announced ceremony id"]) assert.match(v.stdout, new RegExp(`FAIL ${name}`), name);
  // A transcript whose contributions changed after the close no longer matches its recorded commitment.
  const swapped = { ...final, contributions: final.contributions.map((c, i) => (i === 2 ? { ...c, name: "zed" } : c)) };
  lr = await verifyCeremony({ transcript: swapped, zkeyPath: join(P.final, "transaction.zkey"), r1csPath: R1CS, ptauPath: PTAU, allowUnpinned: true });
  assert.ok(lr.checks.some((c) => c.name === "close commitment recorded" && c.status === "FAIL"));
  // A transcript without the beacon header fails instead of skipping the check.
  lr = await verifyCeremony({ transcript: { ...final, final: { ...final.final, beaconHeader: undefined } }, zkeyPath: join(P.final, "transaction.zkey"), r1csPath: R1CS, ptauPath: PTAU, allowUnpinned: true });
  assert.ok(lr.checks.some((c) => c.name === "beacon header" && c.status === "FAIL" && /missing/.test(c.detail)));
  fakeChain.hash = "11".repeat(32); // a source that serves another block at the beacon height
  v = await node("scripts/ceremony/verify.mjs", [...vargs, "--unpinned"]);
  assert.equal(v.code, 1);
  assert.match(v.stdout, /FAIL beacon block on chain/);
  fakeChain.hash = BEACON.hash;
  // The transcript straight from the coordinator's URL works too.
  v = await node("scripts/ceremony/verify.mjs", ["--transcript", `${url}/ceremony/api/transcript.json`, "--zkey", join(P.final, "transaction.zkey"), "--r1cs", R1CS, "--ptau", PTAU, "--beacon-source", "none", "--unpinned"]);
  assert.equal(v.code, 0, v.stdout + v.stderr);

  // The final key makes proofs that its exported vkey accepts.
  const vkey = JSON.parse(readFileSync(join(P.final, "verification_key.json"), "utf8"));
  const { proof, publicSignals } = await snarkjs.groth16.fullProve({ inp: 1 }, WASM, join(P.final, "transaction.zkey"));
  assert.deepEqual(publicSignals, ["0", "1", "0", "1"]);
  assert.equal(await snarkjs.groth16.verify(vkey, publicSignals, proof), true);
  const devVkey = JSON.parse(readFileSync(join(P.final, "verification_key.json"), "utf8"));
  devVkey.vk_delta_2 = vkey.vk_gamma_2;
  assert.equal(await snarkjs.groth16.verify(devVkey, publicSignals, proof), false, "the ceremony's delta is what makes it verify");

  // Install: never into this repository for a rehearsal; into a temporary root while genesis is null.
  await t.test("install", async () => {
    await assert.rejects(installFinal({ dir, log: () => {} }), /never installed into this repository/);
    const root = join(TMP, "root");
    mkdirSync(join(root, "src"), { recursive: true });
    const pinsSrc = join(ROOT, "src", "pins.mainnet.json");
    const startPins = existsSync(pinsSrc)
      ? readFileSync(pinsSrc, "utf8")
      : JSON.stringify({ manifestSha256: null, artifacts: { wasm: PINNED.wasmSha256, zkey: null, vkey: null }, genesisTxid: null, activationHeight: null, activations: [{ name: "mining", height: null, digestV: 2 }] }, null, 2) + "\n";
    writeFileSync(join(root, "src", "pins.mainnet.json"), startPins);
    const before = JSON.parse(startPins);
    before.artifacts.wasm = sha256Hex(readFileSync(WASM)); // the rehearsal circuit's wasm
    writeFileSync(join(root, "src", "pins.mainnet.json"), JSON.stringify(before, null, 2) + "\n");
    const { pins } = await installFinal({ dir, root, log: () => {} });
    assert.equal(pins.artifacts.zkey, final.final.zkeySha256);
    assert.equal(pins.artifacts.vkey, final.final.vkeySha256);
    assert.equal(pins.manifestSha256, final.final.manifestSha256);
    assert.equal(pins.genesisTxid, null);
    assert.deepEqual(pins.activations, before.activations, "other fields are kept");
    for (const f of ["transaction.zkey", "verification_key.json", "manifest.json"]) {
      assert.equal(fileSha(join(root, "build", "mainnet", f)), fileSha(join(P.final, f)));
    }
    assert.equal(existsSync(join(root, "src", "pins.json")), false);
    writeFileSync(join(root, "src", "pins.mainnet.json"), JSON.stringify({ ...pins, genesisTxid: "aa".repeat(32) }, null, 2) + "\n");
    await assert.rejects(installFinal({ dir, root, log: () => {} }), /genesis .* is pinned/);
    const v2 = await verifyCeremony({ transcript: final, zkeyPath: join(P.final, "transaction.zkey"), r1csPath: R1CS, ptauPath: PTAU, allowUnpinned: true });
    assert.equal(v2.ok, true, JSON.stringify(v2.checks.filter((c) => c.status === "FAIL")));
  });
});

/* ---------------------------------------------------------------- refusals */

test("the coordinator refuses: bad names, waiting uploads, tampering, wrong names, oversize, stale keys, expired slots", async () => {
  const dir = await newCeremony("rules");
  let clock = 1_800_000_000_000;
  const { app, url } = await startCoordinator(dir, { now: () => clock, slotSecs: 30, heartbeatSecs: 10, maxQueue: 50, joinPerHour: 50, trustProxy: true, tickMs: 3_600_000 });
  const joinAs = (name, ip = "10.1.1.1") => api(url, "POST", "/ceremony/api/join", { json: { name }, headers: { "x-forwarded-for": ip } });
  const client = new CeremonyClient(url);

  for (const name of ["", "   ", "x".repeat(65), "naïve", 42]) {
    const r = await joinAs(name);
    assert.deepEqual([r.status, r.data.error], [400, "bad_name"], JSON.stringify(name));
  }
  assert.equal((await api(url, "POST", "/ceremony/api/join", { body: "{not json", headers: { "content-type": "application/json" } })).data.error, "bad_json");
  const A = (await joinAs("anna")).data;
  assert.equal(A.position, 0);
  assert.match(A.pass, /^[0-9a-f]{64}$/);
  const B = (await joinAs("ben", "10.1.1.2")).data;
  assert.equal(B.position, 1);
  assert.deepEqual([(await joinAs("anna")).status, (await joinAs("anna")).data.error], [409, "name_taken"]);
  const tA = await client.turn(A.pass);
  assert.equal(tA.state, "active");
  assert.deepEqual(await client.turn(B.pass), { state: "waiting", position: 1, heartbeatSecs: 10 });

  // Authentication and request shape.
  assert.equal((await api(url, "GET", "/ceremony/api/turn")).status, 401);
  assert.equal((await api(url, "GET", "/ceremony/api/turn", { headers: { authorization: "Bearer xyz" } })).status, 401);
  assert.deepEqual(await client.turn("ee".repeat(32)), { state: "unknown" });
  const good = await contributeTo(client, A.pass, tA, "anna");
  let r = await api(url, "POST", "/ceremony/api/contribution", { pass: B.pass, body: good.zkey, headers: { "content-type": "application/octet-stream" } });
  assert.deepEqual([r.status, r.data.error], [409, "not_your_turn"]);
  r = await api(url, "POST", "/ceremony/api/contribution", { pass: A.pass, body: good.zkey, headers: { "content-type": "text/plain" } });
  assert.deepEqual([r.status, r.data.error], [415, "bad_content_type"]);
  r = await rawPost(url, "/ceremony/api/contribution", { headers: { authorization: `Bearer ${A.pass}`, "content-type": "application/octet-stream", "transfer-encoding": "chunked" }, chunked: true });
  assert.deepEqual([r.status, r.data.error], [411, "length_required"]);
  r = await rawPost(url, "/ceremony/api/contribution", { headers: { authorization: `Bearer ${A.pass}`, "content-type": "application/octet-stream", "content-length": String(tA.base.bytes + 65537) } });
  assert.deepEqual([r.status, r.data.error, r.data.maxUploadBytes], [413, "too_large", tA.base.bytes + 65536]);
  assert.equal(r.headers.connection, "close");
  // A body that is not a key at all uses up an attempt.
  r = await rawPost(url, "/ceremony/api/contribution", { headers: { authorization: `Bearer ${A.pass}`, "content-type": "application/octet-stream", "content-length": "100" }, body: Buffer.alloc(100) });
  assert.equal(r.status, 422, "100 zero bytes are not a key");
  assert.match(r.data.reason, /not a valid zkey|zkey/);
  assert.equal(r.data.attemptsLeft, 2);

  // A contribution under another name than the one joined.
  const wrong = await contributeTo(client, A.pass, tA, "someone-else");
  await assert.rejects(client.upload(A.pass, wrong.zkey), (e) => e.code === "rejected" && /named "someone-else", not "anna"/.test(e.detail.reason) && e.detail.attemptsLeft === 1);
  // A tampered key: one byte of the last contribution's public key flipped.
  const bad = Uint8Array.from(good.zkey);
  bad[bad.length - 200] ^= 1;
  await assert.rejects(client.upload(A.pass, bad), (e) => e.code === "rejected" && /zkey verify failed|not a valid zkey/.test(e.detail.reason));
  // Three failures used up the slot.
  assert.deepEqual(await client.turn(A.pass), { state: "expired" });
  await assert.rejects(client.upload(A.pass, good.zkey), (e) => e.code === "slot_expired");

  // Ben is next; his contribution is accepted. A key built on an old base is refused for the next one.
  const tB = await client.turn(B.pass);
  assert.equal(tB.state, "active");
  const ben = await contributeTo(client, B.pass, tB, "ben");
  const rb = await client.upload(B.pass, ben.zkey);
  assert.equal(rb.index, 1);
  const C = (await joinAs("cleo", "10.1.2.1")).data;
  const tC = await client.turn(C.pass);
  assert.equal(tC.base.index, 1);
  const stale = await contributeZkey(snarkjs, new Uint8Array(readFileSync(join(dir, "zkeys", "0000.zkey"))), { name: "cleo", entropy: freshEntropy() });
  await assert.rejects(client.upload(C.pass, stale.zkey), (e) => e.code === "rejected" && /already has 1/.test(e.detail.reason));
  // Ben's own accepted key, uploaded again by Cleo: no new contribution in it.
  await assert.rejects(client.upload(C.pass, ben.zkey), (e) => e.code === "rejected" && /already has 1/.test(e.detail.reason));

  // The slot expires at its deadline; a waiting pass that stops polling is dropped.
  const D = (await joinAs("dora", "10.1.3.1")).data;
  clock += 11_000; // Dora does not poll for longer than heartbeatSecs
  app.tick();
  assert.deepEqual(await client.turn(D.pass), { state: "expired" });
  clock += 30_000; // past Cleo's deadline
  app.tick();
  assert.deepEqual(await client.turn(C.pass), { state: "expired" });
  await assert.rejects(client.upload(C.pass, stale.zkey), (e) => e.code === "slot_expired");
  assert.equal((await client.status()).slot.active, false);

  // Leaving frees the slot at once.
  const E = (await joinAs("emil", "10.1.4.1")).data;
  const F = (await joinAs("finn", "10.1.5.1")).data;
  assert.equal((await client.turn(E.pass)).state, "active");
  assert.deepEqual(await client.leave(E.pass), { ok: true });
  assert.equal((await client.turn(F.pass)).state, "active");
  assert.equal((await client.turn(E.pass)).state, "expired");

  // State survives a restart: Finn still holds the slot.
  await app.close();
  servers.splice(servers.indexOf(app), 1);
  const second = await startCoordinator(dir, { now: () => clock, slotSecs: 30, heartbeatSecs: 10, tickMs: 3_600_000 });
  const c2 = new CeremonyClient(second.url);
  assert.equal((await c2.turn(F.pass)).state, "active");
  assert.equal((await c2.transcript()).contributions.length, 1);
});

test("the coordinator refuses: rate limit per address prefix, queue cap, pause, close, low disk; no CORS, no cookies", async () => {
  const dir = await newCeremony("limits");
  let clock = 1_800_000_000_000;
  const { app, url } = await startCoordinator(dir, { now: () => clock, joinPerHour: 3, maxQueue: 2, maxPerPrefix: 10, trustProxy: true, tickMs: 3_600_000 });
  const joinAs = (name, ip) => api(url, "POST", "/ceremony/api/join", { json: { name }, headers: { "x-forwarded-for": ip } });

  // Three joins per /24 per hour; the next /24 is separate; the hour slides.
  for (const [i, ip] of ["192.0.2.1", "192.0.2.2", "192.0.2.3"].entries()) assert.equal((await joinAs(`r${i}`, ip)).status, 201);
  let r = await joinAs("r3", "192.0.2.99");
  assert.deepEqual([r.status, r.data.error], [429, "rate_limited"]);
  // Only the last X-Forwarded-For entry (the one the proxy wrote) counts.
  r = await joinAs("r4", "198.51.100.1, 192.0.2.50");
  assert.deepEqual([r.status, r.data.error], [429, "rate_limited"]);
  // Queue cap: r0 holds the slot, r1 and r2 wait; the cap is 2 waiting places.
  r = await joinAs("q1", "198.51.100.7");
  assert.deepEqual([r.status, r.data.error], [503, "queue_full"]);
  clock += 3_600_001;
  // (the silent waiting passes dropped meanwhile free the queue)
  app.tick();
  assert.equal((await joinAs("r5", "192.0.2.4")).status, 201, "a new hour");

  // Pause and resume through admin.mjs.
  let a = await node("scripts/ceremony/admin.mjs", ["--dir", dir, "pause"]);
  assert.equal(a.code, 0, a.stderr);
  r = await joinAs("p1", "203.0.113.1");
  assert.deepEqual([r.status, r.data.error], [503, "paused"]);
  assert.equal((await api(url, "GET", "/ceremony/api/status")).data.phase, "paused");
  a = await node("scripts/ceremony/admin.mjs", ["--dir", dir, "resume"]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal((await joinAs("p2", "203.0.113.2")).status, 201);
  a = await node("scripts/ceremony/admin.mjs", ["--dir", dir, "status"]);
  assert.match(a.stdout, /ceremony limits/);

  // Close through admin.mjs: final, joins and uploads refused, waiting passes end.
  const holder = (await api(url, "GET", "/ceremony/api/status")).data;
  assert.equal(holder.slot.active, true);
  a = await node("scripts/ceremony/admin.mjs", ["--dir", dir, "close", "--tip", String(H - 10)]);
  assert.equal(a.code, 0, a.stderr);
  r = await joinAs("c1", "203.0.113.3");
  assert.deepEqual([r.status, r.data.error], [503, "closed"]);
  const st = (await api(url, "GET", "/ceremony/api/status")).data;
  assert.deepEqual([st.phase, st.closed.tipHeight, st.waiting, st.slot.active], ["closed", H - 10, 0, false]);
  a = await node("scripts/ceremony/admin.mjs", ["--dir", dir, "resume"]);
  assert.equal(a.code, 2);
  assert.match(a.stderr, /closed; that cannot be undone/);
  r = await api(url, "POST", "/ceremony/api/contribution", { pass: "ab".repeat(32), body: Buffer.alloc(10), headers: { "content-type": "application/octet-stream" } });
  assert.deepEqual([r.status, r.data.error], [503, "closed"]);

  // Low disk: no new joins, health says so.
  const low = await startCoordinator(await newCeremony("disk"), { minFreeDiskBytes: Number.MAX_SAFE_INTEGER });
  r = await api(low.url, "POST", "/ceremony/api/join", { json: { name: "x" } });
  assert.deepEqual([r.status, r.data.error], [503, "low_disk"]);
  const health = (await api(low.url, "GET", "/ceremony/api/health")).data;
  assert.equal(health.ok, false);
  assert.deepEqual(Object.keys(health).sort(), ["chain", "contributions", "freeDiskBytes", "lastError", "ok", "phase", "slotActive", "verifying", "waiting"]);

  // Routes, headers.
  assert.equal((await api(url, "GET", "/ceremony/api/nope")).status, 404);
  assert.equal((await api(url, "GET", "/")).status, 404);
  assert.equal((await api(url, "GET", "/ceremony/api/join")).status, 405);
  const res = await fetch(`${url}/ceremony/api/status`, { headers: { origin: "https://evil.example" } });
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
});

test("verification runs in a child process with a timeout; a missing file fails closed", async () => {
  const dir = await newCeremony("child");
  const p = ceremonyPaths(dir);
  const slow = await verifyInChildProcess({ init: p.zkey(0), ptau: PTAU, zkey: p.zkey(0), timeoutMs: 1 });
  assert.deepEqual(slow, { ok: false, reason: "verification timed out after 0 s" });
  const missing = await verifyInChildProcess({ init: p.zkey(0), ptau: PTAU, zkey: join(dir, "nope.zkey") });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /verifier failed/);
  const zero = await verifyInChildProcess({ init: p.zkey(0), ptau: PTAU, zkey: p.zkey(0) });
  assert.deepEqual(zero, { ok: true, contributions: [] });
});

/* ---------------------------------------------------------------- the real circuit */

const REAL = {
  r1cs: join(ROOT, "build", "transaction.r1cs"),
  ptau: join(ROOT, "build", "ptau", PINNED.ptau.name),
  zkey0: join(ROOT, "build", "dev", "transaction_0.zkey"),
  manifest: join(ROOT, "build", "manifest.json"),
};
const haveReal = Object.values(REAL).every((p) => existsSync(p));

test("the ceremony's pins are the signet manifest's circuit and the public ptau", { skip: !haveReal && "build files absent" }, () => {
  const manifest = JSON.parse(readFileSync(REAL.manifest, "utf8"));
  assert.equal(manifest.sha256.r1cs, PINNED.r1csSha256);
  assert.equal(manifest.sha256.ptau, PINNED.ptau.sha256);
  assert.equal(manifest.sha256.wasm, PINNED.wasmSha256);
  assert.equal(manifest.constraints, PINNED.constraints);
  assert.equal(manifest.circom, PINNED.circom);
  assert.equal(fileSha(REAL.r1cs), PINNED.r1csSha256);
  assert.equal(statSync(REAL.ptau).size, 37831832);
});

test("real circuit dry run: the initial key is recomputable and one contribution verifies", { skip: !(haveReal && process.env.MURKLE_CEREMONY_REAL === "1") && "set MURKLE_CEREMONY_REAL=1 (and have build/)", timeout: 1_800_000 }, async () => {
  const init = await newInitialZkey(REAL.r1cs, REAL.ptau);
  assert.equal(sha256Hex(init), fileSha(REAL.zkey0), "zkey new of the pinned r1cs and ptau is build/dev/transaction_0.zkey");
  const prev = new Uint8Array(readFileSync(REAL.zkey0));
  const c = await contributeZkey(snarkjs, prev, { name: "dry run", entropy: freshEntropy() });
  const dir = join(TMP, "real");
  mkdirSync(dir);
  writeFileSync(join(dir, "0001.zkey"), c.zkey);
  const v = await verifyInChildProcess({ init: REAL.zkey0, ptau: REAL.ptau, zkey: join(dir, "0001.zkey"), timeoutMs: 1_500_000 });
  assert.equal(v.ok, true, v.reason);
  assert.deepEqual(v.contributions.map((x) => [x.index, x.name, x.contributionHash]), [[1, "dry run", c.contributionHash]]);
});

/* ---------------------------------------------------------------- files */

test("ceremony files: LF, English, honest copy, no 'ticket' wording in server/ and web/src", () => {
  const mine = [
    "server/ceremony-server.mjs", "web/ceremony.html", "docs/CEREMONY.md", "test/ceremony.test.mjs",
    ...readdirSync(join(ROOT, "web/src/ceremony")).map((f) => `web/src/ceremony/${f}`),
    ...readdirSync(join(ROOT, "scripts/ceremony")).map((f) => `scripts/ceremony/${f}`),
    "test/fixtures/ceremony/README.md", "test/fixtures/ceremony/beacon-mainnet-900000.json",
  ];
  const banned = [/\btrustless\b/i, /\banonymous\b/i, /\buntraceable\b/i, /\baudited\b/i, /\bmixer\b/i, /mainnet[- ]ready/i, /live on mainnet/i, /military[- ]grade/i];
  for (const f of mine) {
    const b = readFileSync(join(ROOT, f));
    assert.ok(!b.includes(13), `${f}: LF line endings`);
    const s = b.toString("utf8");
    assert.ok(!/[\u0400-\u04FF]/.test(s), `${f}: English only`);
    if (f === "test/ceremony.test.mjs") continue; // lists the banned words
    for (const re of banned) assert.ok(!re.test(s), `${f}: ${re}`);
    if (f.startsWith("server/") || f.startsWith("web/src/")) assert.ok(!/ticket/i.test(s), `${f}: ticket wording`);
  }
});

test("the page module parses, the worker posts the core result, and the page never stores the pass or the entropy", () => {
  const main = readFileSync(join(ROOT, "web/src/ceremony/main.js"), "utf8");
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie/.test(main));
  assert.match(main, /new Worker\(new URL\("\.\/contribute\.worker\.js", import\.meta\.url\), \{ type: "module" \}\)/);
  assert.match(readFileSync(join(ROOT, "web/src/ceremony/contribute.worker.js"), "utf8"), /contributeZkey\(snarkjs, prev/);
  const html = readFileSync(join(ROOT, "web/ceremony.html"), "utf8");
  assert.match(html, /<script type="module" src="\/src\/ceremony\/main\.js"><\/script>/);
  assert.ok(!/<script>(?!<)/.test(html), "no inline script (CSP)");
  for (const id of ["status", "join-form", "name", "extra", "join-btn", "join-note", "run", "receipt", "lookup-form", "lookup-hash", "lookup-out", "transcript-link"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // Every element id the module reads exists in the page.
  for (const m of main.matchAll(/\$\("([a-z-]+)"\)/g)) assert.match(html, new RegExp(`id="${m[1]}"`), m[1]);
});

/* ---------------------------------------------------------------- launch review regressions */

const passHashOf = (pass) => createHash("sha256").update(pass, "utf8").digest("hex");

test("queue abuse: one /48 holds at most 2 places, an unacknowledged slot passes on, admin drop-slot and drop-prefix", async () => {
  const dir = await newCeremony("squat");
  let clock = 1_800_000_000_000;
  const { app, url } = await startCoordinator(dir, { now: () => clock, heartbeatSecs: 10, slotSecs: 900, joinPerHour: 50, maxQueue: 50, trustProxy: true, tickMs: 3_600_000 });
  const joinAs = (name, ip) => api(url, "POST", "/ceremony/api/join", { json: { name }, headers: { "x-forwarded-for": ip } });
  const client = new CeremonyClient(url);
  // Three /56s of one /48: the third place is refused while two are held.
  const a1 = await joinAs("a1", "2001:db8:1:100::1");
  const a2 = await joinAs("a2", "2001:db8:1:200::1");
  assert.deepEqual([a1.status, a2.status], [201, 201]);
  const a3 = await joinAs("a3", "2001:db8:1:300::1");
  assert.deepEqual([a3.status, a3.data.error, a3.data.maxPerPrefix], [429, "prefix_busy", 2]);
  assert.ok(!readFileSync(join(dir, "state.json"), "utf8").includes("2001:db8"), "no address in the state file");
  // a1 got the slot at its join but never polls: after one heartbeat the slot passes to a2.
  clock += 11_000;
  assert.equal((await client.turn(a2.data.pass)).state, "active");
  assert.deepEqual(await client.turn(a1.data.pass), { state: "expired" });
  // The operator ends a squatted slot.
  let a = await node("scripts/ceremony/admin.mjs", ["--dir", dir, "drop-slot"]);
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual(await client.turn(a2.data.pass), { state: "expired" });
  // ...and removes every place of one prefix, its slot included.
  const b1 = (await joinAs("b1", "198.51.100.5")).data;
  const b2 = (await joinAs("b2", "198.51.100.6")).data;
  const c1 = (await joinAs("c1", "203.0.113.9")).data;
  assert.equal((await client.turn(b1.pass)).state, "active");
  a = await node("scripts/ceremony/admin.mjs", ["--dir", dir, "drop-prefix", "198.51.100.77"]);
  assert.equal(a.code, 0, a.stderr);
  assert.deepEqual([(await client.turn(b1.pass)).state, (await client.turn(b2.pass)).state], ["expired", "expired"]);
  assert.equal((await client.turn(c1.pass)).state, "active");
  // An action is applied once: a later pause keeps it applied, not repeated.
  a = await node("scripts/ceremony/admin.mjs", ["--dir", dir, "pause"]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal((await client.turn(c1.pass)).state, "active");
  assert.equal(JSON.parse(readFileSync(join(dir, "control.json"), "utf8")).actions.length, 2);
  await app.close();
  servers.splice(servers.indexOf(app), 1);
});

test("chain freshness: no slot and no upload while the chain read is stale; each accepted entry records the tip", async () => {
  const dir = await newCeremony("stale");
  let clock = 1_800_000_000_000;
  const chain = { fail: false, tip: H - 500, tipHeight: async () => {
    if (chain.fail) throw new Error("socket hang up");
    return chain.tip;
  } };
  const { app, url } = await startCoordinator(dir, { now: () => clock, chain, chainPollSecs: 3600, chainStaleSecs: 5, heartbeatSecs: 600, tickMs: 3_600_000 });
  await app.pollChain();
  const client = new CeremonyClient(url);
  const x = await client.join("xena");
  const tx = await client.waitForTurn(x.pass, { pollMs: 10 });
  const xk = await contributeTo(client, x.pass, tx, "xena");
  // The source fails for longer than chainStaleSecs.
  chain.fail = true;
  clock += 6_000;
  await app.pollChain();
  const h = (await api(url, "GET", "/ceremony/api/health")).data;
  assert.deepEqual([h.ok, h.chain.stale, h.chain.configured, h.chain.tipHeight], [false, true, true, H - 500]);
  await assert.rejects(client.upload(x.pass, xk.zkey), (e) => e.code === "chain_unavailable" && e.status === 503);
  assert.equal((await client.turn(x.pass)).state, "active", "the slot is kept; nothing was accepted");
  await client.leave(x.pass);
  const y = await client.join("yuri");
  assert.equal((await client.turn(y.pass)).state, "waiting", "no slot is given out while the chain is stale");
  // The source answers again.
  chain.fail = false;
  chain.tip = H - 400;
  await app.pollChain();
  const ty = await client.turn(y.pass);
  assert.equal(ty.state, "active");
  const yk = await contributeTo(client, y.pass, ty, "yuri");
  const r = await client.upload(y.pass, yk.zkey);
  assert.equal(r.index, 1);
  assert.equal((await client.transcript()).contributions[0].tipHeight, H - 400);
  assert.equal((await api(url, "GET", "/ceremony/api/health")).data.ok, true);
  await app.close();
  servers.splice(servers.indexOf(app), 1);
});

test("a crash between transcript.json and state.json: the restored slot is done, the next contribution gets the next index", async () => {
  const dir = await newCeremony("crash");
  const first = await startCoordinator(dir, { heartbeatSecs: 600, tickMs: 3_600_000 });
  const client = new CeremonyClient(first.url);
  const p = await client.join("pia");
  const t1 = await client.waitForTurn(p.pass, { pollMs: 10 });
  const pk = await contributeTo(client, p.pass, t1, "pia");
  const slotBefore = first.app.state().slot;
  assert.equal(slotBefore.index, 1);
  assert.equal((await client.upload(p.pass, pk.zkey)).index, 1);
  await first.app.close();
  servers.splice(servers.indexOf(first.app), 1);
  // state.json as it was before the accept was saved: the slot still active, the transcript already holding #1.
  const st = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
  writeFileSync(join(dir, "state.json"), JSON.stringify({ ...st, slot: { ...slotBefore, uploading: false }, done: st.done.filter((d) => d.passHash !== passHashOf(p.pass)) }));
  const second = await startCoordinator(dir, { heartbeatSecs: 600, tickMs: 3_600_000 });
  const c2 = new CeremonyClient(second.url);
  assert.deepEqual(await c2.turn(p.pass), { state: "done", index: 1 });
  assert.equal((await c2.status()).slot.active, false);
  // Re-uploading with the same pass is refused, and the next contributor gets index 2.
  await assert.rejects(c2.upload(p.pass, pk.zkey), (e) => e.code === "not_your_turn");
  const q = await c2.join("quin");
  const t2 = await c2.waitForTurn(q.pass, { pollMs: 10 });
  assert.equal(t2.index, 2);
  const qk = await contributeTo(c2, q.pass, t2, "quin");
  assert.equal((await c2.upload(q.pass, qk.zkey)).index, 2);
  assert.deepEqual((await c2.transcript()).contributions.map((c) => c.index), [1, 2]);
});

test("receipts: the browser and the CLI keep their own values and refuse a receipt about another contribution", async () => {
  const { ownReceipt } = await import("../web/src/ceremony/receipt.js");
  const h = "ab".repeat(64);
  const local = { contributionHash: h, zkeySha256: "11".repeat(32), prevZkeySha256: "22".repeat(32) };
  const r = { ceremony: "c", index: 3, name: "n", contributionHash: h, zkeySha256: "11".repeat(32), prevZkeySha256: "22".repeat(32), acceptedAt: "t", verifiedWith: "v" };
  assert.deepEqual(checkReceipt(r, local), { ok: true, problems: [] });
  // A coordinator that answers with a sybil's hash, another key, or another base.
  const sybil = { ...r, contributionHash: "cd".repeat(64) };
  assert.equal(checkReceipt(sybil, local).ok, false);
  assert.equal(ownReceipt(sybil, local).contributionHash, h, "the saved receipt and the lookup use the local hash");
  assert.match(checkReceipt({ ...r, zkeySha256: "33".repeat(32) }, local).problems.join(), /key uploaded from here/);
  assert.match(checkReceipt({ ...r, prevZkeySha256: "44".repeat(32) }, local).problems.join(), /another key than the one downloaded/);
  const main = readFileSync(join(ROOT, "web/src/ceremony/main.js"), "utf8");
  assert.match(main, /lookup\(mine\.contributionHash, result\)/);
  assert.ok(!/accepted, with a warning/.test(main));
  assert.match(main, /Do not trust this run/);
  // contribute.mjs --upload refuses to run without the hash from the offline step.
  const passFile = join(TMP, "lonely.pass");
  writeFileSync(passFile, "ab".repeat(32));
  const key = join(TMP, "lonely.zkey");
  writeFileSync(key, Buffer.alloc(100));
  const up = await node("scripts/ceremony/contribute.mjs", ["--upload", key, "--coordinator", "http://127.0.0.1:9", "--pass-file", passFile]);
  assert.equal(up.code, 2);
  assert.match(up.stderr, /--upload needs --expect-hash/);
});

test("beacon header: on mainnet a header must also meet the difficulty bounds from a pinned checkpoint", async () => {
  const { checkBeaconHeader } = await import("../scripts/ceremony/lib.mjs");
  // The real mainnet genesis header: valid proof of work at difficulty 1 (about 2^32 hashes).
  const genesis = "0100000000000000000000000000000000000000000000000000000000000000000000003ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a29ab5f49ffff001d1dac2b7c";
  const ok = await checkBeaconHeader({ header: genesis, hash: MAINNET_GENESIS, network: "mainnet", height: 0 });
  assert.equal(ok.bounds, 969696);
  // The same header claimed for a beacon height near the checkpoint: refused.
  await assert.rejects(checkBeaconHeader({ header: genesis, hash: MAINNET_GENESIS, network: "mainnet", height: 975000 }), /easier target than any valid mainnet block at 975000/);
  // Without a height only its own target is checked (as before).
  assert.equal((await checkBeaconHeader({ header: genesis, hash: MAINNET_GENESIS, network: "mainnet" })).bounds, null);
  // The real beacon block 900000 is within the bounds.
  assert.equal((await checkBeaconHeader({ header: BEACON.header, hash: BEACON.hash, network: "mainnet", height: H })).bounds, 969696);
});

test("finalize after a late close: only contributions recorded below the close height, and only with --drop-late when some are not", async () => {
  const { usableContributions } = await import("../scripts/ceremony/finalize.mjs");
  const beacon = { height: 1000, closeBeforeBlocks: 6 };
  const t = (tips) => ({ contributions: tips.map((tipHeight, i) => ({ index: i + 1, tipHeight })) });
  assert.deepEqual(usableContributions(t([1, 2]), { tipHeight: 990 }, beacon).usable, 2);
  assert.equal(usableContributions(t([900, 950]), { tipHeight: 1010 }, beacon).usable, 2);
  assert.equal(usableContributions(t([900, 994, 999]), { tipHeight: 1010 }, beacon).usable, 1);
  assert.equal(usableContributions(t([null, 900]), { tipHeight: null }, beacon).usable, 0);
});

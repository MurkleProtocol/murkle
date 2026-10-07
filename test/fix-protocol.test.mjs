// Protocol fixes: atomic block application, DEPLOY range checks, dust-limit
// payments, the CLI's mint pre-check, W-1 pending locks and empty digest
// comparisons (numbered tests refer to findings of an internal review).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveKeys, NOTE_CT_LEN } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf, mintClosed } from "../src/indexer.mjs";
import {
  ATTEST_KIND, OP, decodeEnvelope, encodeAttest, encodeDeploy, encodeTxBody, opReturnScript, scriptHashOf,
} from "../src/envelope.mjs";
import { btcAccount, dustLimit, planCarrierTx } from "../src/btc/funding.mjs";
import { compareDigests } from "../src/sync.mjs";
import { hex } from "../src/bytes.mjs";
import { ACTIVATION_HEIGHT, GENESIS, GENESIS_TXID, MANIFEST_SHA256, PRE_GENESIS } from "../src/params.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const hash32 = () => randomBytes(32).toString("hex");

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const coinbase = () => ({ txid: hash32(), inputs: [], outputs: [] });
const carrier = (envelope, extra = [], first = randomBytes(36)) => ({
  txid: hash32(),
  inputs: [{ outpoint: first }],
  outputs: [{ script: opReturnScript(envelope), value: 0n }, ...extra],
});

/** Everything a half-applied block could leave behind, in comparable form. */
const fingerprint = (idx) => ({
  height: idx.height,
  digests: [...idx.digests],
  roots: [...idx.roots].map(([h, r]) => [h, String(r)]),
  root: String(idx.tree.root()),
  leaves: idx.tree.size,
  outputs: idx.outputs.length,
  nullifiers: [...idx.nullifiers].sort(),
  logAcc: hex(idx.logAcc),
  nullAcc: hex(idx.nullAcc),
  log: JSON.stringify(idx.log),
  stats: JSON.stringify(idx.stats),
  tickers: [...idx.tickers.keys()].sort(),
  assets: JSON.stringify(idx.snapshot().assets),
  undo: idx.undo.length,
});

/* ---------- 12 / 23: a block applies all or nothing ---------- */

test("a prevout lookup that fails mid-block leaves no trace; the retry matches a clean replay", async () => {
  const START = 600000;
  const ASSET = assetIdOf(START, 1);
  const payerScript = new Uint8Array([0x00, 0x14, ...randomBytes(20)]);
  const flaky = new Indexer({ vkey: VKEY, startHeight: START });
  const clean = new Indexer({ vkey: VKEY, startHeight: START });
  let failures = 1;
  flaky.prevoutScript = async () => {
    if (failures-- > 0) throw new Error("GET /tx/…/hex: 503");
    return payerScript;
  };
  clean.prevoutScript = async () => payerScript;

  const b0 = { height: START, hash: hash32(), txs: [coinbase(), carrier(encodeDeploy({ ticker: "ATOM", divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() }))] };
  await flaky.applyBlock(b0);
  await clean.applyBlock(b0);

  // An accepted MINT (tree, nullifiers, asset counters), a DEPLOY, then a MINT_SCRIPT whose lookup fails.
  const minter = new Wallet(deriveKeys(randomBytes(32)));
  const utxo = randomBytes(36);
  const mint = carrier(await minter.mint(flaky, { asset: ASSET, mintAmount: 10n, bindOutpoint: utxo }), [], utxo);
  // The MINT_SCRIPT carries a valid proof: its prevout lookup runs after the Groth16 check
  // (mining.md §13.1), so only a claim with a valid proof reaches the failing lookup.
  const mintScript = await minter.mint(flaky, { asset: ASSET, mintAmount: 10n, bindScriptHash: scriptHashOf(payerScript) });
  const b1 = {
    height: START + 1,
    hash: hash32(),
    txs: [coinbase(), mint, carrier(encodeDeploy({ ticker: "SECOND", divisibility: 0, mintAmount: 1n, mintCap: 1, priceSats: 0n, treasury: new Uint8Array() })), carrier(mintScript)],
  };

  const before = fingerprint(flaky);
  await assert.rejects(flaky.applyBlock(b1), /503/);
  assert.deepEqual(fingerprint(flaky), before, "the failed attempt is fully undone");

  await flaky.applyBlock(b1);
  await clean.applyBlock(b1);
  assert.deepEqual(fingerprint(flaky), fingerprint(clean));
  assert.equal(flaky.log.filter((l) => l.height === START + 1).length, 3, "each envelope logged once");
  assert.equal(flaky.log.find((l) => l.txid === mint.txid).ok, true);
  assert.equal(flaky.assets.get(ASSET).minted, 2, "both mints land once the lookup answers");

  // The undo entry of the retried block is intact, so a reorg still restores block START exactly.
  const atStart = new Indexer({ vkey: VKEY, startHeight: START });
  await atStart.applyBlock(b0);
  flaky.rollbackTo(START);
  const strip = (f) => ({ ...f, undo: 0 });
  assert.deepEqual(strip(fingerprint(flaky)), strip(fingerprint(atStart)));
});

/* ---------- 24: DEPLOY fields never wrap on the wire ---------- */

test("encodeDeploy refuses out-of-range or non-integer terms instead of wrapping them", () => {
  const terms = { ticker: "RANGE", divisibility: 0, mintAmount: 1n, mintCap: 10, priceSats: 0n, treasury: new Uint8Array() };
  const bad = [
    { mintCap: 5_000_000_000 }, { mintCap: -1 }, { mintCap: 1.5 }, { mintCap: NaN },
    { startHeight: -1 }, { startHeight: 2 ** 32 + 1 }, { startHeight: NaN }, { endHeight: -5 }, { endHeight: 2 ** 32 },
    { divisibility: -1 }, { divisibility: 2.5 }, { mintAmount: -1n }, { priceSats: -1n }, { priceSats: 1n << 64n },
  ];
  for (const b of bad) assert.throws(() => encodeDeploy({ ...terms, ...b }), undefined, JSON.stringify(b, (k, v) => (typeof v === "bigint" ? `${v}n` : v)));

  const edge = { ...terms, mintCap: 0xffffffff, startHeight: 0xffffffff, endHeight: 0, priceSats: (1n << 64n) - 1n, treasury: new Uint8Array([0x51]) };
  const d = decodeEnvelope(encodeDeploy(edge));
  assert.deepEqual([d.mintCap, d.startHeight, d.endHeight, d.priceSats], [0xffffffff, 0xffffffff, 0, (1n << 64n) - 1n]);
});

test("the launch form bounds heights and price to their wire ranges", async () => {
  const { buildTerms } = await import("../web/src/views/app-launch.js");
  const base = { ticker: "HGT", decimals: "0", perMint: "1", mints: "10", price: "0", treasury: "", start: "0", end: "0" };
  assert.deepEqual(buildTerms(base).errors, {});
  assert.match(buildTerms({ ...base, start: "4294967296" }).errors.start, /block height/);
  assert.match(buildTerms({ ...base, end: "4294967297" }).errors.end, /block height/);
  assert.ok(buildTerms({ ...base, price: "18446744073709551616", treasury: btcAccount(randomBytes(32)).address }).errors.price);
});

/* ---------- 15: payments are never dust ---------- */

test("dustLimit matches Bitcoin Core's thresholds at 3 sat/vB", () => {
  const p2tr = btcAccount(randomBytes(32)).script;
  assert.equal(dustLimit(p2tr), 330n);
  assert.equal(dustLimit(new Uint8Array([0x00, 0x14, ...randomBytes(20)])), 294n); // P2WPKH
  assert.equal(dustLimit(new Uint8Array([0x00, 0x20, ...randomBytes(32)])), 330n); // P2WSH
  assert.equal(dustLimit(new Uint8Array([0x76, 0xa9, 0x14, ...randomBytes(20), 0x88, 0xac])), 546n); // P2PKH
  assert.equal(dustLimit(new Uint8Array([0xa9, 0x14, ...randomBytes(20), 0x87])), 540n); // P2SH
  assert.equal(dustLimit(opReturnScript(new Uint8Array(10))), 0n);
});

test("planCarrierTx raises a sub-dust payment to the dust limit and leaves larger ones alone", () => {
  const account = btcAccount(randomBytes(32));
  const treasury = btcAccount(randomBytes(32)).script;
  const utxos = [{ txid: hash32(), vout: 0, value: 100_000 }];
  const plan = (amount) => planCarrierTx({ account, utxos, envelope: new Uint8Array(40), outputs: [{ script: treasury, amount }], feeRate: 1 }).tx;
  // L5: the change takes a random slot after the OP_RETURN; find the payment by its script.
  const paid = (tx) => Array.from({ length: tx.outputsLength }, (_, v) => tx.getOutput(v)).find((o) => hex(o.script) === hex(treasury)).amount;
  assert.equal(paid(plan(100n)), 330n);
  assert.equal(paid(plan(1000n)), 1000n);
  assert.equal(plan(100n).getOutput(0).amount, 0n, "the OP_RETURN stays at 0");
});

test("the launch form refuses a price below the treasury's dust limit", async () => {
  const { buildTerms } = await import("../web/src/views/app-launch.js");
  const treasury = btcAccount(randomBytes(32)).address; // P2TR: 330 sats
  const v = { ticker: "DUST", decimals: "0", perMint: "1", mints: "10", treasury, start: "0", end: "0" };
  const low = buildTerms({ ...v, price: "100" });
  assert.match(low.errors.price, /at least 330 sats/);
  assert.equal(low.envelope, null);
  assert.deepEqual(buildTerms({ ...v, price: "330" }).errors, {});
  assert.deepEqual(buildTerms({ ...v, price: "0", treasury: "" }).errors, {});
});

/* ---------- 25: mint pre-check shared with the indexer ---------- */

test("mintClosed mirrors the indexer's window and cap rules", () => {
  const a = { startHeight: 100, endHeight: 200, minted: 0, mintCap: 2 };
  assert.equal(mintClosed(a, 99), "mint closed");
  assert.equal(mintClosed(a, 100), null);
  assert.equal(mintClosed(a, 200), null);
  assert.equal(mintClosed(a, 201), "mint closed");
  assert.equal(mintClosed({ ...a, endHeight: 0 }, 10 ** 9), null, "endHeight 0 means no end");
  assert.equal(mintClosed({ ...a, minted: 2 }, 150), "mint cap reached");
});

/* ---------- 27: an empty comparison is not an OK ---------- */

test("compareDigests reports an empty range instead of a vacuous OK", async () => {
  const idx = new Indexer({ vkey: VKEY, startHeight: 10 });
  let calls = 0;
  const fetchDigests = async () => (calls++, []);
  assert.deepEqual(await compareDigests(idx, fetchDigests, { from: 10, to: 9 }), { ok: false, empty: true, from: 10, to: 9 });
  assert.equal((await compareDigests(idx, fetchDigests, { from: 10, to: NaN })).empty, true);
  assert.equal((await compareDigests(idx, fetchDigests)).empty, true, "an indexer that applied nothing");
  assert.equal(calls, 0);
});

/* ---------- the CLI against a local mock (never mempool.space, never data/signet) ---------- */

const ACT = ACTIVATION_HEIGHT;
const cliTest = { skip: PRE_GENESIS && "the CLI fixtures need a pinned genesis" };
const LOGGED_TXID = hash32();

/** Indexer state at ACT+2 under the pinned genesis: three tokens and one logged ATTEST. */
async function cliState() {
  const idx = new Indexer({ vkey: VKEY, startHeight: ACT, genesis: GENESIS });
  const genesisTx = { txid: GENESIS_TXID, inputs: [], outputs: [{ script: opReturnScript(encodeAttest({ kind: ATTEST_KIND.GENESIS, hash: MANIFEST_SHA256 })), value: 0n }] };
  const deploy = (ticker, extra) => carrier(encodeDeploy({ ticker, divisibility: 0, mintAmount: 5n, mintCap: 3, priceSats: 0n, treasury: new Uint8Array(), ...extra }));
  const logged = { ...carrier(encodeAttest({ kind: ATTEST_KIND.CHECKPOINT, hash: randomBytes(32) })), txid: LOGGED_TXID };
  await idx.applyBlock({ height: ACT, hash: hash32(), txs: [coinbase(), genesisTx] });
  await idx.applyBlock({ height: ACT + 1, hash: hash32(), txs: [coinbase(), deploy("LATE", { startHeight: ACT + 1000 }), deploy("ENDED", { endHeight: ACT + 1 }), logged] });
  await idx.applyBlock({ height: ACT + 2, hash: hash32(), txs: [coinbase()] });
  return idx;
}

/** Esplora under /api and a remote indexer under /remote; anything else answers 503 and is recorded. */
function mockServer({ idx, remoteState = { height: 0 }, remoteDigests = [], rawBlocks = new Map() }) {
  const seen = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    seen.push(`${req.method} ${p}`);
    const send = (status, body) => {
      res.writeHead(status);
      res.end(body);
    };
    let m;
    if (p === "/api/blocks/tip/height") return send(200, String(idx.height));
    if ((m = p.match(/^\/api\/block-height\/(\d+)$/))) {
      const h = Number(m[1]);
      const hash = idx.hashes.get(h) ?? [...rawBlocks.entries()].find(([, b]) => b.height === h)?.[0];
      return hash ? send(200, hash) : send(404, "not found");
    }
    if ((m = p.match(/^\/api\/block\/([0-9a-f]{64})\/raw$/)) && rawBlocks.has(m[1])) return send(200, rawBlocks.get(m[1]).raw);
    if (/^\/api\/address\/[^/]+\/utxo$/.test(p)) return send(200, "[]");
    if (p === "/remote/api/state") return send(200, JSON.stringify(remoteState));
    if (p === "/remote/api/digests") return send(200, JSON.stringify(remoteDigests));
    return send(503, "unavailable");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` })));
}

function cli(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, ["bin/murkle.mjs", ...args], { env: { ...process.env, ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

async function withCli(fn, mockOpts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "murkle-cli-"));
  const idx = await cliState();
  writeFileSync(join(dir, "state.json"), JSON.stringify(idx.snapshot()));
  mkdirSync(join(dir, "wallets"));
  const mock = await mockServer({ idx, ...mockOpts });
  try {
    // Synthetic blocks at the pinned signet heights cannot match the genesis header checkpoint (A-9):
    // header verification is off here (allowed on signet only).
    await fn({ dir, idx, mock, run: (args) => cli(args, { MURKLE_DATA_DIR: dir, MURKLE_ESPLORA: `${mock.base}/api`, MURKLE_HEADERS: "off" }) });
  } finally {
    mock.server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const walletFile = (dir, pending) => {
  const path = join(dir, "wallets", "w.json");
  writeFileSync(path, JSON.stringify({ seed: hash32(), btcKey: hash32(), pending }));
  return path;
};

test("CLI mint refuses a token outside its window before proving or touching any UTXO", cliTest, async () => {
  await withCli(async ({ dir, mock, run }) => {
    walletFile(dir, []);
    for (const ticker of ["LATE", "ENDED"]) {
      const r = await run(["mint", "w", ticker]);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, new RegExp(`${ticker}: mint closed for block ${ACT + 3}.*nothing was broadcast`));
    }
    assert.ok(!mock.seen.some((s) => s.includes("/utxo") || s.startsWith("POST")), mock.seen.join("\n"));
  });
});

test("CLI keeps W-1 locks across explorer errors; only a verdict, spent nullifiers or an expired anchor release them", cliTest, async () => {
  await withCli(async ({ dir, mock, run }) => {
    const fresh = { txid: hash32(), spends: ["111"], anchor: ACT + 2 };
    const legacy = { txid: hash32(), spends: ["222"] };
    const expired = { txid: hash32(), spends: ["333"], anchor: ACT + 2 - 101 };
    const landed = { txid: LOGGED_TXID, spends: ["444"], anchor: ACT + 1 };
    // Entries without an anchor get the height they are first seen at as an upper bound, once.
    const legacySeen = { txid: hash32(), spends: ["555"], anchorMax: ACT };
    const legacyExpired = { txid: hash32(), spends: ["666"], anchorMax: ACT + 2 - 101 };
    const path = walletFile(dir, [fresh, legacy, expired, landed, legacySeen, legacyExpired]);
    const r = await run(["balance", "w"]);
    assert.equal(r.code, 0, r.stderr);
    const kept = [fresh, { ...legacy, anchorMax: ACT + 2 }, legacySeen];
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).pending, kept);
    assert.match(r.stderr, new RegExp(`${legacy.txid.slice(0, 12)}… predates anchor tracking: .*until it lands or block ${ACT + 103}`));
    assert.match(r.stderr, new RegExp(`${legacySeen.txid.slice(0, 12)}… predates anchor tracking: .*block ${ACT + 101}`));
    const again = await run(["balance", "w"]);
    assert.equal(again.code, 0, again.stderr);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).pending, kept, "the bound is not moved forward");
    assert.ok(!mock.seen.some((s) => s.includes("/status")), "no explorer lookup decides a lock");
  });
});

test("CLI deploy refuses wrapped, malformed or dust terms before syncing", cliTest, async () => {
  await withCli(async ({ dir, mock, run }) => {
    walletFile(dir, []);
    const treasury = btcAccount(randomBytes(32)).address;
    const cases = [
      [["--cap", "5000000000"], /mintCap must be a whole number/],
      [["--cap", "-1"], /--cap must be a whole number/],
      [["--cap", "10", "--start", "120,000"], /--start must be a whole number/],
      [["--cap", "10", "--price", "100", "--treasury", treasury], /at least 330 sats/],
    ];
    for (const [flags, re] of cases) {
      const r = await run(["deploy", "w", "--ticker", "NEWT", "--amount", "1", ...flags]);
      assert.equal(r.code, 1, r.stderr);
      assert.match(r.stderr, re);
    }
    assert.deepEqual(mock.seen, [], "nothing was fetched");
  });
});

test("CLI audit --compare fails when no height was compared, and counts the heights when it passes", cliTest, async () => {
  const raw = readFileSync("test/fixtures/signet-324500.bin");
  const { hash } = JSON.parse(readFileSync("test/fixtures/signet-324500.json", "utf8"));
  const H = 324500;
  const ref = new Indexer({ vkey: VKEY, startHeight: H });
  const { parseBlock } = await import("../src/btc/block.mjs");
  const block = parseBlock(raw);
  await ref.applyBlock({ height: H, hash, prevHash: block.prevHash, txs: block.txs });
  const rawBlocks = new Map([[hash, { height: H, raw }]]);

  const audit = async (remoteState, args) => {
    let out;
    await withCli(async ({ mock, run }) => {
      out = await run(["audit", "--esplora", `${mock.base}/api`, ...args, "--compare", `${mock.base}/remote`]);
    }, { remoteState, remoteDigests: [[H, ref.digestAt(H)]], rawBlocks });
    return out;
  };

  const localEmpty = await audit({ height: H + 10 }, ["--from", String(H), "--to", String(H - 1)]);
  assert.equal(localEmpty.code, 1);
  assert.match(localEmpty.stderr, /nothing compared/);
  assert.doesNotMatch(localEmpty.stdout, /OK up to/);

  const remoteBehind = await audit({ height: H - 1 }, ["--from", String(H), "--to", String(H)]);
  assert.equal(remoteBehind.code, 1);
  assert.match(remoteBehind.stderr, /nothing compared.*remote at 324499/);

  const notAnIndexer = await audit({}, ["--from", String(H), "--to", String(H)]);
  assert.equal(notAnIndexer.code, 1);
  assert.match(notAnIndexer.stderr, /nothing compared/);

  const ok = await audit({ height: H }, ["--from", String(H), "--to", String(H)]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, new RegExp(`OK up to ${H} \\(1 height compared\\)`));
});

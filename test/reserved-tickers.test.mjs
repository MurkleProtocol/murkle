// Reserved tickers (security audit M1, SPEC.md section 7): on mainnet a DEPLOY or DEPLOY_POW of a
// reserved ticker is valid only as its pinned carrier transaction, so nobody who sees the genesis
// ATTEST can take the flagship ticker MURK first. Signet has none and does not change.
// - the Indexer on a mainnet-config chain: a squatter in the genesis block and at genesis + 1, a null
//   pin, a pin set to the operator's txid, other tickers, the rejected counters;
// - signet ignores the map and replays the v1 chain to the same digests; snapshots;
// - the pins loader (params.mjs) and the shipped mainnet pin, in a child process on mainnet;
// - the browser-side single-transaction check (src/verify-tx.mjs);
// - the CLI refuses a reserved ticker unless --reserved-ticker, and skips no other check.
// Offline: fakes only; nothing is broadcast.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { Indexer } from "../src/indexer.mjs";
import { encodeAttest, encodeDeploy, encodeDeployPow, opReturnScript } from "../src/envelope.mjs";
import { planCarrierTx, signLocal, btcAccount } from "../src/btc/funding.mjs";
import { Esplora } from "../src/btc/esplora.mjs";
import { hex, unhex } from "../src/bytes.mjs";
import * as P from "../src/params.mjs";
import * as M from "../src/mine.mjs";
import { verifyTx } from "../src/verify-tx.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const ROOT = resolve(".");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const h32 = () => randomBytes(32).toString("hex");
const NULL_OUTPOINT = new Uint8Array(36).fill(0).map((v, i) => (i >= 32 ? 0xff : 0));
const coinbase = () => ({ txid: h32(), inputs: [{ outpoint: NULL_OUTPOINT }], outputs: [] });
const carrier = (envelope, txid = h32()) => ({ txid, inputs: [{ outpoint: randomBytes(36) }], outputs: [{ script: opReturnScript(envelope), value: 0n }] });
const mining = (height) => [{ name: "mining", height, digestV: 2 }];
const verdictOf = (idx, tx) => idx.log.find((l) => l.txid === tx.txid);

const deployTerms = (ticker) => ({ ticker, divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() });
const powTerms = (ticker) => ({
  ticker, divisibility: 8, reward: 1000n, maxSupply: 10n ** 9n, span: 24, targetPerSpan: 24, initialDifficulty: 256n, minDifficulty: 256n,
});
const deployTx = (ticker, txid) => carrier(encodeDeploy(deployTerms(ticker)), txid);
const powTx = (ticker, txid) => carrier(encodeDeployPow(powTerms(ticker)), txid);

const START = 880_000; // the genesis block; mining from START + 1, as the MURK launch pins it
const GENESIS_TXID = h32();
const MANIFEST = h32();
const genesisTx = () => carrier(encodeAttest({ kind: 1, hash: unhex(MANIFEST) }), GENESIS_TXID);

/** A mainnet-config chain: genesis rule, strict tickers, no stale bound, mining from genesis + 1. */
function mainnetChain(reservedTickers) {
  const idx = new Indexer({
    vkey: VKEY, startHeight: START, genesis: { txid: GENESIS_TXID, manifestSha256: MANIFEST }, activations: mining(START + 1),
    strictTicker: true, staleFactor: null, reservedTickers,
  });
  const add = async (txs) => {
    const block = { height: idx.height + 1, hash: h32(), txs: [coinbase(), ...txs] };
    await idx.applyBlock(block);
    return block;
  };
  return { idx, add };
}
const RESERVED = /^ticker reserved/;

// ---------------------------------------------------------------- the Indexer rule

test("mainnet, pin null: a squatter's DEPLOY MURK in the genesis block and DEPLOY_POW MURK at genesis + 1 are rejected and never claim the ticker", async () => {
  const { idx, add } = mainnetChain({ MURK: null });
  const squatPlain = deployTx("MURK");
  const squatEarlyPow = powTx("MURK"); // DEPLOY_POW before the mining height: an unknown op, still no claim
  await add([genesisTx(), squatPlain, squatEarlyPow]);
  assert.equal(verdictOf(idx, squatPlain).ok, false);
  assert.match(verdictOf(idx, squatPlain).reason, RESERVED, "the genesis-block DEPLOY is rejected for the reserved ticker");
  assert.equal(verdictOf(idx, squatEarlyPow).ok, false);
  assert.equal(idx.tickers.has("MURK"), false);
  assert.equal(idx.assets.size, 0);

  const squatPow = powTx("MURK");
  const squatPlain2 = deployTx("MURK");
  const squatPow2 = powTx("MURK");
  await add([squatPow, squatPlain2]);
  await add([squatPow2]);
  for (const t of [squatPow, squatPlain2, squatPow2]) {
    assert.equal(verdictOf(idx, t).ok, false);
    assert.match(verdictOf(idx, t).reason, RESERVED, "with the pin null every MURK deploy is rejected");
    assert.match(verdictOf(idx, t).reason, /no launch transaction pinned/);
    assert.equal(verdictOf(idx, t).ticker, "MURK", "the log entry still names the ticker");
  }
  assert.equal(idx.tickers.has("MURK"), false, "a rejected deploy never claims the ticker");
  assert.equal(idx.assets.size, 0, "no asset");
  assert.equal(idx.stats.rejected, 5, "only the usual rejected counter moved");
  assert.equal(idx.stats.accepted.deploy, 0);
  // The operator's own deploy is rejected too while the pin is null (it becomes valid once pinned).
  const ours = powTx("MURK");
  await add([ours]);
  assert.match(verdictOf(idx, ours).reason, RESERVED);
});

test("mainnet, pin set to the operator's txid: that deploy is accepted, every other MURK deploy stays rejected, other tickers are unaffected", async () => {
  const operator = h32();
  const { idx, add } = mainnetChain({ MURK: operator });
  const squatPlain = deployTx("MURK");
  await add([genesisTx(), squatPlain]);
  const squatBefore = powTx("MURK");
  const theirs = powTx("MURK");
  const other = powTx("OTHER");
  const plain = deployTx("PLAIN");
  const ours = powTx("MURK", operator);
  // The squatters' transactions come first in the block, the operator's last.
  await add([squatBefore, theirs, other, plain, ours]);
  assert.match(verdictOf(idx, squatPlain).reason, RESERVED);
  assert.match(verdictOf(idx, squatPlain).reason, /only by its pinned launch transaction/);
  for (const t of [squatBefore, theirs]) {
    assert.equal(verdictOf(idx, t).ok, false);
    assert.match(verdictOf(idx, t).reason, RESERVED);
  }
  assert.equal(verdictOf(idx, ours).ok, true, "the pinned transaction deploys the ticker");
  assert.equal(idx.assets.get(BigInt(verdictOf(idx, ours).asset)).kind, "pow");
  assert.equal(idx.tickers.has("MURK"), true);
  assert.equal(verdictOf(idx, other).ok, true, "another DEPLOY_POW ticker is unaffected");
  assert.equal(verdictOf(idx, plain).ok, true, "another DEPLOY ticker is unaffected");
  // Afterwards the ticker is the operator's: a second deploy is rejected (reserved comes first).
  const later = powTx("MURK");
  await add([later]);
  assert.match(verdictOf(idx, later).reason, RESERVED);
  // The pinned transaction still obeys every other rule: a second deploy with the pinned txid finds the ticker taken.
  const twin = mainnetChain({ MURK: operator });
  await twin.add([genesisTx()]);
  const a = powTx("MURK", operator);
  await twin.add([a]);
  assert.equal(verdictOf(twin.idx, a).ok, true);
  const b = deployTx("MURK", operator);
  await twin.add([b]);
  assert.equal(twin.idx.log.at(-1).reason, "ticker MURK already deployed", "same txid again: the log entry of the second one");
});

test("the pinned transaction is still subject to the other deploy rules (fee policy)", async () => {
  const operator = h32();
  const { idx, add } = mainnetChain({ MURK: operator });
  await add([genesisTx()]);
  const treasury = unhex("51203084846915ba86451221466028377de3bcf2ad8dc19ab8137684407dba6a9bab");
  const badFee = carrier(encodeDeployPow({ ...powTerms("MURK"), claimFeeSats: 546n, treasury }), operator);
  await add([badFee]);
  assert.equal(verdictOf(idx, badFee).ok, false);
  assert.doesNotMatch(verdictOf(idx, badFee).reason, RESERVED, "the pin passes the reserved rule, then the fee policy refuses it");
  assert.equal(idx.tickers.has("MURK"), false);
});

test("only the exact ticker is reserved; txids compare case-insensitively; inherited names are not reserved", async () => {
  const { idx, add } = mainnetChain({ MURK: null, TACO: h32() });
  await add([genesisTx()]);
  const taco = powTx("TACO");
  const fine = powTx("MURKY");
  await add([taco, fine]);
  assert.match(verdictOf(idx, taco).reason, RESERVED);
  assert.equal(verdictOf(idx, fine).ok, true, "MURKY is not MURK");
  assert.notEqual(P.reservedTickerReason("MURK", undefined, { MURK: "ab".repeat(32) }), null, "no txid yet: refused");
  assert.equal(P.reservedTickerReason("MURK", "AB".repeat(32), { MURK: "ab".repeat(32) }), null);
  assert.equal(P.reservedTickerReason("MURK", "ab".repeat(32), {}), null);
  assert.equal(P.reservedTickerReason("toString", "ab".repeat(32), {}), null);
});

test("an Indexer refuses a malformed reservedTickers option", () => {
  for (const bad of [[], "MURK", { murk: null }, { MURK: "AB".repeat(32) }, { MURK: "ab" }, { MURK: undefined }, { "": null }, { ABCDEFGHIJKLMNOPQ: null }]) {
    assert.throws(() => new Indexer({ vkey: VKEY, startHeight: 5, reservedTickers: bad }), /reservedTickers|reserved ticker/, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------- signet and snapshots

test("signet: the map is never read, the default is empty, and the v1 chain replays to the same digests", async () => {
  assert.equal(P.NETWORK, "signet");
  assert.deepEqual(P.RESERVED_TICKERS, {}, "this process is signet");
  assert.deepEqual(P.reservedTickersOf({ MURK: null }, "signet"), {}, "signet ignores the pin");
  assert.deepEqual(P.reservedTickersOf("garbage", "signet"), {}, "and does not even validate it");
  const pins = JSON.parse(read("src/pins.json"));
  assert.equal(pins.reservedTickers === undefined || Object.keys(pins.reservedTickers).length === 0, true, "src/pins.json reserves nothing");

  const FIX = JSON.parse(read("test/fixtures/v1-chain.json"));
  const blocks = FIX.blocks.map((b) => ({
    height: b.height, hash: b.hash,
    txs: b.txs.map((t) => ({
      txid: t.txid, inputs: t.inputs.map((i) => ({ outpoint: unhex(i.outpoint) })),
      outputs: t.outputs.map((o) => ({ script: unhex(o.script), value: BigInt(o.value) })),
    })),
  }));
  const replay = async (opts) => {
    const idx = new Indexer({ vkey: VKEY, startHeight: FIX.startHeight, activations: mining(null), ...opts });
    idx.prevoutScript = async (o) => unhex(FIX.prevouts[hex(o)]);
    for (const b of blocks) await idx.applyBlock(b);
    return idx;
  };
  const dflt = await replay({});
  assert.deepEqual([...dflt.digests], FIX.digests, "unchanged signet digests");
  assert.deepEqual(dflt.log, FIX.log);
  assert.equal(Object.hasOwn(dflt.snapshot(), "reservedTickers"), false, "a signet snapshot keeps its layout");
  // The digest never folds the map in: a reserved ticker no deploy of the chain uses changes nothing.
  const unrelated = await replay({ reservedTickers: { ZZZZZZZZZZ: null } });
  assert.deepEqual([...unrelated.digests], FIX.digests);
});

test("snapshots record the map and refuse other pins", async () => {
  const operator = h32();
  const { idx, add } = mainnetChain({ MURK: null });
  await add([genesisTx(), deployTx("MURK")]);
  const snap = JSON.parse(JSON.stringify(idx.snapshot()));
  assert.deepEqual(snap.reservedTickers, { MURK: null });
  const opts = { vkey: VKEY, activations: mining(START + 1), strictTicker: true, staleFactor: null };
  const back = Indexer.restore(snap, { ...opts, reservedTickers: { MURK: null } });
  assert.deepEqual(back.reservedTickers, { MURK: null });
  assert.equal(back.digestAt(back.height), idx.digestAt(idx.height));
  // Pinning the txid changes a verdict at a height the snapshot does not name: the state is replayed, not reused.
  assert.throws(() => Indexer.restore(snap, { ...opts, reservedTickers: { MURK: operator } }), /snapshot reserved tickers differ/);
  assert.throws(() => Indexer.restoreRewound(snap, { ...opts, reservedTickers: { MURK: operator } }), /snapshot reserved tickers differ/);
  assert.throws(() => Indexer.restore(snap, { ...opts, reservedTickers: {} }), /snapshot reserved tickers differ/);
  // A snapshot without the key is a snapshot with no reservation.
  const plain = new Indexer({ vkey: VKEY, startHeight: 100, activations: mining(null) });
  assert.deepEqual(Indexer.restore(plain.snapshot(), { vkey: VKEY, activations: mining(null) }).reservedTickers, {});
  assert.throws(() => Indexer.restore(plain.snapshot(), { vkey: VKEY, activations: mining(null), reservedTickers: { MURK: null } }), /snapshot reserved tickers differ/);
});

// ---------------------------------------------------------------- the pins loader

test("the pins loader accepts a good map and refuses every malformed one (mainnet), and signet never reads it", () => {
  const good = "ab".repeat(32);
  assert.deepEqual(P.reservedTickersOf({}, "mainnet"), {});
  assert.deepEqual(P.reservedTickersOf({ MURK: null }, "mainnet"), { MURK: null });
  assert.deepEqual(P.reservedTickersOf({ MURK: good, A1: null }, "mainnet"), { MURK: good, A1: null });
  assert.equal(Object.isFrozen(P.reservedTickersOf({ MURK: null }, "mainnet")), true);
  const bad = [
    undefined, null, "MURK", 5, [], [["MURK", null]], ["MURK"],
    { murk: null }, { "MU RK": null }, { "": null }, { ABCDEFGHIJKLMNOPQ: null }, { "MURKé": null }, { "﻿MURK": null },
    { MURK: "" }, { MURK: "ab" }, { MURK: good.toUpperCase() }, { MURK: good + "0" }, { MURK: "zz".repeat(32) },
    { MURK: 0 }, { MURK: false }, { MURK: undefined }, { MURK: {} }, { MURK: [good] },
    { MURK: null, bad: null },
  ];
  for (const v of bad) assert.throws(() => P.reservedTickersOf(v, "mainnet"), /reservedTickers|reserved ticker/, JSON.stringify(v));
  assert.throws(() => P.reservedTickersOf(Object.create({ MURK: null }), "mainnet"), /reservedTickers/, "a prototype-carried map is refused");
  assert.throws(() => P.reservedTickersOf(JSON.parse('{"__proto__": null}'), "mainnet"), /reserved ticker/, "__proto__ is not a ticker");
  assert.match(read("src/params.mjs"), /export const RESERVED_TICKERS = reservedTickersOf\(pins\.reservedTickers\)/, "the loader runs on the active network's pins at import");
});

test("the shipped pins: src/pins.mainnet.json reserves MURK with a null pin, and a mainnet process loads exactly that", async () => {
  const pins = JSON.parse(read("src/pins.mainnet.json"));
  assert.deepEqual(pins.reservedTickers, { MURK: null });
  const txid = "cd".repeat(32);
  const out = await new Promise((done, fail) => {
    execFile(process.execPath, ["--input-type=module", "-e", `
      const P = await import("./src/params.mjs");
      const { Indexer } = await import("./src/indexer.mjs");
      const idx = new Indexer({ vkey: {}, startHeight: 5 });
      console.log(JSON.stringify({ n: P.NETWORK, r: P.RESERVED_TICKERS, frozen: Object.isFrozen(P.RESERVED_TICKERS), idx: idx.reservedTickers,
        why: P.reservedTickerReason("MURK", "${txid}"), none: P.reservedTickerReason("OTHER", "${txid}") }));
    `], { cwd: ROOT, env: { ...process.env, MURKLE_NETWORK: "mainnet" }, timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) return fail(new Error(`${err.message}\n${stderr}`));
      done(JSON.parse(stdout.trim().split("\n").pop()));
    });
  });
  assert.equal(out.n, "mainnet");
  assert.deepEqual(out.r, { MURK: null });
  assert.equal(out.frozen, true);
  assert.deepEqual(out.idx, { MURK: null }, "a default mainnet Indexer carries the pinned map");
  assert.match(out.why, RESERVED);
  assert.equal(out.none, null);
});

// ---------------------------------------------------------------- browser-side single-transaction check

test("verify-tx: a reserved ticker passes only as its pinned txid; a free ticker is untouched", async () => {
  const key = randomBytes(32);
  const account = btcAccount(key);
  const utxo = { txid: h32(), vout: 0, value: 100_000 };
  const build = (envelope) => {
    const { tx } = planCarrierTx({ account, utxos: [utxo], envelope, outputs: [], feeRate: 1, firstInput: utxo });
    return signLocal(tx, key);
  };
  const BASE = "https://esplora.invalid/api";
  const served = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = String(url).slice(BASE.length);
    let m;
    if (path === "/blocks/tip/height") return new Response("1000");
    if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/hex$/))) return served.has(m[1]) ? new Response(served.get(m[1])) : new Response("not found", { status: 404 });
    if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/status$/))) return new Response(JSON.stringify({ confirmed: false }), { headers: { "content-type": "application/json" } });
    return new Response("not found", { status: 404 });
  };
  try {
    const check = async (envelope, reservedTickers, pinToTxid = false) => {
      const tx = build(envelope);
      served.set(tx.txid, tx.hex);
      const r = await verifyTx(tx.txid, {
        esplora: new Esplora(BASE), indexerVerdict: async () => null, activations: mining(1), reservedTickers: pinToTxid ? { RSV: tx.txid } : reservedTickers,
      });
      return r.steps.find((s) => s.id === "deploy");
    };
    for (const make of [(t) => encodeDeploy(deployTerms(t)), (t) => encodeDeployPow(powTerms(t))]) {
      const nullPin = await check(make("RSV"), { RSV: null });
      assert.equal(nullPin.status, "fail");
      assert.match(JSON.stringify(nullPin), /ticker is reserved/);
      const other = await check(make("RSV"), { RSV: "ab".repeat(32) });
      assert.equal(other.status, "fail", "another pinned txid");
      const pinned = await check(make("RSV"), null, true);
      assert.equal(pinned.status, "ok", JSON.stringify(pinned));
      const free = await check(make("FREE"), { RSV: null });
      assert.equal(free.status, "ok");
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(read("src/verify-tx.mjs"), /\^ticker reserved/, "the engine classifies the reason as one it checks itself");
});

// ---------------------------------------------------------------- the CLI

process.env.MURKLE_DATA_DIR = mkdtempSync(join(tmpdir(), "murkle-reserved-")); // empty; the CLI is only imported
process.env.MURKLE_ESPLORA = "http://127.0.0.1:9/api";
const CLI = await import("../bin/murkle.mjs");

function deployFixture({ tickers = [] } = {}) {
  const calls = { build: [], broadcast: [] };
  const idx = { height: 1000, tickers: new Map(tickers.map((t) => [t, 1n])), miningActive: () => true, miningHeight: 900 };
  const esplora = { broadcast: async (h) => (calls.broadcast.push(h), "ab".repeat(32)) };
  const build = async ({ envelope, feeRate }) => (calls.build.push({ envelope, feeRate }), { txid: "cd".repeat(32), hex: "beef", vsize: 180, fee: 360 });
  const out = [];
  return { calls, idx, esplora, build, out, print: (s) => out.push(s) };
}
const POW_ARGS = (ticker, ...more) => ["--ticker", ticker, "--reward", "1000", "--max-supply", "21000000", "--fee-rate", "2", ...more];

test("deploy-pow refuses a reserved ticker without --reserved-ticker, before anything is built; with it, it builds and warns", async () => {
  const lib = M;
  const reserved = { MURK: null };
  const f = deployFixture();
  const run = (args) => CLI.deployPowCommand({ args, idx: f.idx, esplora: f.esplora, lib, build: f.build, print: f.print, reserved });
  await assert.rejects(run(POW_ARGS("MURK")), /refused: MURK is a reserved ticker on .*Pass --reserved-ticker only for the operator's own launch deploy|pass --reserved-ticker only for the operator's own launch deploy/i);
  await assert.rejects(run(POW_ARGS("murk")), /MURK is a reserved ticker/, "lowercase input is the same ticker");
  assert.deepEqual(f.calls.build, []);
  assert.deepEqual(f.calls.broadcast, []);

  const r = await run(POW_ARGS("MURK", "--reserved-ticker", "--dry-run"));
  assert.equal(r.status, "dry-run");
  assert.equal(r.terms.ticker, "MURK");
  assert.equal(f.calls.build.length, 1, "built");
  assert.deepEqual(f.calls.broadcast, [], "a dry run broadcasts nothing");
  const text = f.out.join("\n");
  assert.match(text, /warning: MURK is a reserved ticker\. This deploy becomes valid only once its txid is pinned as reservedTickers\.MURK in a release/);
  assert.ok(f.out.findIndex((l) => l.startsWith("warning: MURK")) < f.out.findIndex((l) => l.startsWith("DEPLOY_POW (not broadcast)")), "warned before building");

  const live = deployFixture();
  const sent = await CLI.deployPowCommand({ args: POW_ARGS("MURK", "--reserved-ticker"), idx: live.idx, esplora: live.esplora, lib, build: live.build, print: live.print, reserved });
  assert.equal(sent.status, "broadcast");
  assert.equal(live.calls.broadcast.length, 1);

  // A ticker that is not reserved: no warning, nothing changes.
  const free = deployFixture();
  await CLI.deployPowCommand({ args: POW_ARGS("DIG"), idx: free.idx, esplora: free.esplora, lib, build: free.build, print: free.print, reserved });
  assert.equal(free.out.some((l) => l.startsWith("warning:")), false);
  assert.equal(CLI.deployPowTerms(POW_ARGS("DIG"), { lib, reserved }).reservedTicker, false);
  assert.equal(CLI.deployPowTerms(POW_ARGS("MURK", "--reserved-ticker"), { lib, reserved }).reservedTicker, true);
});

test("--reserved-ticker skips no other check", async () => {
  const lib = M;
  const reserved = { MURK: null, TACO: "ab".repeat(32) };
  const flag = "--reserved-ticker";
  const f = deployFixture();
  const run = (args, idx = f.idx) => CLI.deployPowCommand({ args, idx, esplora: f.esplora, lib, build: f.build, print: f.print, reserved });
  // Strict flags, terms, fee policy, end height, taken ticker and the mining gate all still refuse.
  await assert.rejects(run([...POW_ARGS("MURK"), flag, "--prcie", "1"]), /unknown flag --prcie/);
  await assert.rejects(run([...POW_ARGS("MURK"), flag, flag]), /--reserved-ticker given twice/);
  await assert.rejects(run([...POW_ARGS("MURK"), "--reserved-ticker=1"]), /--reserved-ticker takes no value/);
  await assert.rejects(run([...POW_ARGS("MURK"), flag, "--claim-fee", "1000"]), /deployer claim fee not allowed|refused/);
  await assert.rejects(run([...POW_ARGS("MURK"), flag, "--end", "1000"]), /--end 1000 is before mining can start/);
  await assert.rejects(run(POW_ARGS("MURK", flag), deployFixture({ tickers: ["MURK"] }).idx), /ticker MURK is taken/);
  await assert.rejects(run(["--ticker", "MURK", flag, "--reward", "0", "--max-supply", "1"]), /--reward must be from 1/);
  // A pinned ticker is refused even with the flag: no new transaction can ever match the pin.
  await assert.rejects(run(POW_ARGS("TACO", flag)), /TACO is reserved for its pinned launch transaction abababab/);
  // The flag on a ticker that is not reserved is refused too.
  await assert.rejects(run(POW_ARGS("DIG", flag)), /--reserved-ticker given, but DIG is not a reserved ticker/);
  const inactive = deployFixture();
  inactive.idx.miningActive = () => false;
  inactive.idx.miningHeight = null;
  await assert.rejects(run(POW_ARGS("MURK", flag), inactive.idx), /mining is not active/);
  assert.deepEqual(f.calls.build, []);
  assert.deepEqual(f.calls.broadcast, []);
});

test("reservedTickerCheck is the one rule behind deploy and deploy-pow; deploy calls it before syncing", () => {
  const check = CLI.reservedTickerCheck;
  const reserved = { MURK: null, TACO: "cd".repeat(32) };
  assert.equal(check("DIG", { reserved }), false);
  assert.equal(check("MURK", { reserved, allow: true }), true);
  assert.throws(() => check("MURK", { reserved }), /refused: MURK is a reserved ticker/);
  assert.throws(() => check("TACO", { reserved, allow: true }), /reserved for its pinned launch transaction/);
  assert.throws(() => check("DIG", { reserved, allow: true }), /not a reserved ticker/);
  assert.equal(check("MURK", { reserved: {} }), false);
  assert.equal(check("MURK"), false, "signet: the network's own map is empty");
  const src = read("bin/murkle.mjs");
  const deploy = src.slice(src.indexOf("async deploy([name, ...rest])"), src.indexOf("async mint([name, ticker])"));
  assert.ok(deploy.includes("reservedTickerCheck("), "deploy checks the ticker");
  assert.ok(deploy.indexOf("reservedTickerCheck(") < deploy.indexOf("await synced()"), "before syncing, so before anything is read or paid");
  assert.ok(deploy.indexOf("reservedTickerCheck(") < deploy.indexOf("buildCarrierTx"), "before the carrier is built");
  assert.ok(CLI.DEPLOY_POW_USAGE.includes("[--reserved-ticker]"));
  assert.ok(CLI.HELP.some((l) => /deploy <w> .*\[--reserved-ticker\]/.test(l)));
  assert.ok(CLI.HELP.some((l) => /deploy-pow <w> .*\[--reserved-ticker\]/.test(l)));
});

// ---------------------------------------------------------------- web launch forms and docs

test("web launch: a reserved ticker is refused by the forms and by the session", async () => {
  const src = read("web/src/views/app-launch.js");
  assert.match(src, /reserved\.has\(ticker\)/);
  const { buildTerms, buildPowTerms } = await import("../web/src/views/app-launch.js");
  const form = { ticker: "murk", decimals: "0", perMint: "1", mints: "10", price: "0" };
  assert.match(buildTerms(form, { height: 10, reserved: new Set(["MURK"]) }).errors.ticker, /reserved on this network/);
  const pow = buildPowTerms({ ticker: "murk", decimals: "0", reward: "1", maxSupply: "1000" }, { height: 10, reserved: new Set(["MURK"]) });
  assert.match(pow.errors.ticker, /reserved on this network/);
  assert.equal(buildTerms({ ...form, ticker: "dig" }, { height: 10, reserved: new Set(["MURK"]) }).errors.ticker, undefined);
  const session = read("web/src/session.js");
  assert.equal((session.match(/Object\.hasOwn\(RESERVED_TICKERS, terms\.ticker\)/g) ?? []).length, 2, "deploy and deployPow");
});

test("docs: SPEC, MAINNET, API and the pins describe the reservation; the two audit lows are fixed", () => {
  const spec = read("SPEC.md");
  assert.match(spec, /\*\*Reserved tickers, per network\.\*\*/);
  assert.match(spec, /ticker reserved/);
  const main = read("docs/MAINNET.md");
  for (const s of ["--reserved-ticker", "reservedTickers.MURK", "6 confirmations", "an estimate, not a measurement"]) {
    assert.ok(main.includes(s), s);
  }
  // Audit M-1: the txid is pinned before the deploy is broadcast, and exactly the saved transaction is sent.
  assert.match(main, /The deploy's txid is pinned BEFORE the deploy is broadcast/);
  assert.match(main, /--dry-run > \/secure\/murkle-owner\/murk-deploy\.txt/);
  assert.match(main, /Broadcast exactly the saved transaction \(never rebuild it/);
  assert.match(main, /never replace it \(RBF changes the txid\)/);
  assert.ok(!/GPU \(80,000 to 120,000 H\/s, mining\.md\s+section 4\.4\) finds/.test(main), "the GPU figure is no longer stated as a measurement");
  const mining = read("docs/design/mining.md");
  assert.ok(!mining.includes("the signet digest is identical to the pre-change digest"));
  assert.match(mining, /the old formula by construction, and the tests compare it to that formula/);
  assert.match(read("docs/API.md"), /reservedTickers\?/);
});

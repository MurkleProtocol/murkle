// Network selection (docs/design/mainnet-readiness.md §4, §7): signet stays byte for byte what it
// was, and mainnet gets its own HRP, key labels, pins, strict tickers (V2-02), placeholder service
// fee, relayer economics, server and CLI refusals, Unisat chain and web build. Mainnet assertions
// run in child processes with MURKLE_NETWORK=mainnet (the network is read once, at import).
// Offline: nothing here touches the network, binds a fixed port, or writes outside temp dirs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as P from "../src/params.mjs";
import { Indexer } from "../src/indexer.mjs";
import {
  OP, TICKER_BYTES_ERROR, decodeEnvelope, encodeAttest, encodeDeploy, encodeDeployPow, findEnvelope, opReturnPayload, opReturnScript,
  tickerBytesValid,
} from "../src/envelope.mjs";
import { decodeAddress, deriveKeys, encodeAddress, feeKeysOf } from "../src/keys.mjs";
import { btcAccount } from "../src/btc/funding.mjs";
import { hex, unhex } from "../src/bytes.mjs";
import { DEFAULTS, NETWORK_DEFAULTS, balanceProblems } from "../server/relayer.mjs";
import { costFor, sweepCostFor } from "../server/relay-books.mjs";
import { checkWebBuild, createApp, openServerChainSource, startRefusal } from "../server/indexer-server.mjs";
import { addressScriptHex, commandRefusal, nextBlockRate, openCliChainSource } from "../bin/murkle.mjs";

const ROOT = resolve(".");
const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const DIR = mkdtempSync(join(tmpdir(), "murkle-network-"));
after(async () => {
  rmSync(DIR, { recursive: true, force: true });
  // snarkjs keeps its curve's worker threads alive after the in-process replays.
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});
const silent = { warn() {}, error() {}, log() {} };
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/** Runs an ES module snippet in a child Node with `env`; its last stdout line is parsed as JSON. */
function child(code, env = {}) {
  return new Promise((done, fail) => {
    execFile(process.execPath, ["--input-type=module", "-e", code], {
      cwd: ROOT, env: { ...process.env, MURKLE_NETWORK: "mainnet", ...env }, timeout: 120_000, maxBuffer: 1 << 24,
    }, (err, stdout, stderr) => {
      if (err) return fail(new Error(`${err.message}\n${stderr}`));
      try {
        done(JSON.parse(stdout.trim().split("\n").pop()));
      } catch (e) {
        fail(new Error(`bad child output: ${stdout}\n${stderr}`));
      }
    });
  });
}
/** Runs a script file; resolves { code, stdout, stderr } whatever the exit code. */
function run(args, env = {}) {
  return new Promise((done) => {
    execFile(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, timeout: 120_000 }, (err, stdout, stderr) => {
      done({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}
const big = (_k, v) => (typeof v === "bigint" ? `${v}n` : v instanceof Uint8Array ? hex(v) : v);
const js = (v) => JSON.parse(JSON.stringify(v, big));

// ================================================================ signet identity (§7)

// The values every signet surface had before networks existed (frozen literals).
const SIGNET_FROZEN = {
  NETWORK: "signet",
  PROTOCOL: "murkle",
  BRAND: "Murkle",
  MAGIC_TEXT: "mrk",
  VERSION: 0,
  ADDRESS_HRP: "mrk",
  STORAGE_PREFIX: "murkle.signet",
  EXPLORER: "https://mempool.space/signet",
  ESPLORA_API: "https://mempool.space/signet/api",
  DIGEST_V: 2,
  SNAPSHOT_VERSION: 3,
  LABELS: {
    spend: "murkle/spend", view: "murkle/view", note: "murkle/note", btcFee: "murkle/btc-fee", relayPow: "murkle/relay/pow/v1",
    digest: "murkle/digest/v1", btcMineFee: "murkle/btc-mine-fee", mine: "murkle/mine/v1",
  },
  GENESIS_TXID: "4c32443828131fe142d899007c1b8885aef7e62da3034c6f03e4ff7096c6dfad",
  ACTIVATION_HEIGHT: 324592,
  MANIFEST_SHA256: "41d28d8899f3ac657b25b3bb9bca32545a78c8ae276f736a472d4e243bcaf2a0",
  MINING_HEIGHT: 325138,
  PRE_GENESIS: false,
};
const PINS_JSON_SHA256 = "c30f0851c5f292a5ed543a46f558229135d38906811a1df88b076e06d7bc2096";

test("src/pins.json is byte-identical (signet pins never move)", () => {
  assert.equal(sha256(readFileSync("src/pins.json")), PINS_JSON_SHA256);
  assert.equal(P.PINS_FILE, "src/pins.json");
});

test("signet: every params export keeps its value (frozen literals)", () => {
  for (const [k, v] of Object.entries(SIGNET_FROZEN)) assert.deepEqual(js(P[k]), v, k);
  assert.equal(P.digestTag(1), P.LABELS.digest);
  assert.equal(P.label("x"), "murkle/x");
  assert.equal(P.MINE_FEE, P.MINE_FEES.signet);
  assert.equal(P.MINE_FEE.platformAddress, P.segwitAddress("tb", P.MINE_FEE.platformScript));
  assert.ok(P.MINE_FEE.platformAddress.startsWith("tb1p"));
  assert.equal(P.MINE_FEE.platformSats, 500n);
  assert.equal(P.mineFeeReady(), null, "signet mining is configured");
  assert.deepEqual(js(P.ACTIVATIONS), [{ name: "mining", height: 325138, digestV: 2 }]);
  assert.deepEqual(js(P.GENESIS), { txid: SIGNET_FROZEN.GENESIS_TXID, height: 324592, manifestSha256: SIGNET_FROZEN.MANIFEST_SHA256 });
  assert.deepEqual(js(P.ARTIFACT_SHA256), JSON.parse(readFileSync("src/pins.json", "utf8")).artifacts);
  // New exports, signet values.
  assert.equal(P.IS_TESTNET, true);
  assert.equal(P.BTC_HRP, "tb");
  assert.equal(P.UNISAT_CHAIN, "BITCOIN_SIGNET");
  assert.equal(P.FAUCET, "https://signetfaucet.com");
  assert.equal(P.STRICT_TICKER, false);
  assert.deepEqual({ ...P.ARTIFACT_PATHS }, {
    manifest: "build/manifest.json", vkey: "build/dev/verification_key.json", zkey: "build/dev/transaction.zkey", wasm: "build/transaction_js/transaction.wasm",
  });
});

/**
 * MURKLE_PRE_MAINNET_SRC: a copy of the pre-mainnet src/. It is copied under node_modules/.cache
 * (so its bare imports resolve) and every export of its params.mjs is compared with today's.
 */
let preCopy = null;
async function preMainnet(file) {
  const src = process.env.MURKLE_PRE_MAINNET_SRC;
  if (!src || !existsSync(join(src, "params.mjs"))) return null;
  if (!preCopy) {
    const base = join(ROOT, "node_modules", ".cache");
    mkdirSync(base, { recursive: true });
    preCopy = mkdtempSync(join(base, "murkle-pre-mainnet-"));
    cpSync(src, join(preCopy, "src"), { recursive: true });
  }
  return import(pathToFileURL(join(preCopy, "src", file)).href);
}
after(() => preCopy && rmSync(preCopy, { recursive: true, force: true }));

test("signet: every export of the pre-mainnet params.mjs has the same value now (MURKLE_PRE_MAINNET_SRC)", async (t) => {
  const old = await preMainnet("params.mjs");
  if (!old) return t.skip("MURKLE_PRE_MAINNET_SRC is not set");
  for (const [k, v] of Object.entries(old)) {
    if (typeof v === "function") continue;
    // MINE_FEES gains the mainnet placeholder; every entry it had is unchanged.
    if (k === "MINE_FEES") {
      for (const net of Object.keys(v)) assert.deepEqual(js(P.MINE_FEES[net]), js(v[net]), `MINE_FEES.${net}`);
      continue;
    }
    assert.deepEqual(js(P[k]), js(v), k);
  }
  for (const n of ["spend", "x", "relay/pow/v1"]) assert.equal(P.label(n), old.label(n));
  for (const v of [1, 2, 3]) assert.equal(P.digestTag(v), old.digestTag(v));
  for (const h of [0, 324592, 325137, 325138, 999999]) assert.equal(P.digestVersionAt(h), old.digestVersionAt(h), `digestVersionAt(${h})`);
  assert.equal(P.activationHeight("mining"), old.activationHeight("mining"));
  assert.equal(P.segwitAddress("tb", P.MINE_FEES.signet.platformScript), old.segwitAddress("tb", old.MINE_FEES.signet.platformScript));
});

// ---------------------------------------------------------------- tickers (V2-02)

const DEPLOY_TERMS = { ticker: "A", divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() };
const POW_TERMS = {
  ticker: "A", divisibility: 0, reward: 10n, maxSupply: 1000n, span: 24, targetPerSpan: 24, initialDifficulty: 4096n, minDifficulty: 256n,
};
/** A DEPLOY or DEPLOY_POW envelope with `raw` as its ticker bytes (the encoders refuse bad tickers). */
function withTicker(kind, raw) {
  const base = kind === "pow" ? encodeDeployPow(POW_TERMS) : encodeDeploy(DEPLOY_TERMS);
  return Uint8Array.from([...base.slice(0, 5), raw.length, ...raw, ...base.slice(7)]);
}
const enc = (s) => [...new TextEncoder().encode(s)];
const CORPUS = {
  plain: enc("ABC"),
  digits: enc("0123456789"),
  max16: enc("ABCDEFGHIJKLMNOP"),
  bom: [0xef, 0xbb, 0xbf, ...enc("ABC")],
  bomOnly: [0xef, 0xbb, 0xbf],
  lowercase: enc("abc"),
  ff: [0x41, 0xff, 0x42],
  overlong: [0xc1, 0x81], // an overlong "A"
  nul: [0x41, 0x00],
  empty: [],
  len17: enc("ABCDEFGHIJKLMNOPQ"),
  space: enc("A B"),
  bom16: [0xef, 0xbb, 0xbf, ...enc("ABCDEFGHIJKLMNOP")],
};
const outcome = (bytes, opts) => {
  try {
    const d = decodeEnvelope(Uint8Array.from(bytes), opts);
    return { ok: true, ticker: d.ticker };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
const oldOutcome = (old, bytes) => {
  try {
    return { ok: true, ticker: old.decodeEnvelope(Uint8Array.from(bytes)).ticker };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};
// The historical rule, written out: TextDecoder (strips a leading BOM, maps bad bytes to U+FFFD), then the regex.
const historical = (raw) => /^[A-Z0-9]{1,16}$/.test(new TextDecoder().decode(Uint8Array.from(raw)));

test("V2-02: tickerBytesValid is exactly 1-16 bytes of 0-9 / A-Z", () => {
  assert.equal(tickerBytesValid(Uint8Array.from(CORPUS.plain)), true);
  assert.equal(tickerBytesValid(Uint8Array.from(CORPUS.max16)), true);
  for (const k of ["bom", "bomOnly", "lowercase", "ff", "overlong", "nul", "empty", "len17", "space", "bom16"]) {
    assert.equal(tickerBytesValid(Uint8Array.from(CORPUS[k])), false, k);
  }
  for (let b = 0; b < 256; b++) assert.equal(tickerBytesValid(Uint8Array.of(b)), (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a), `byte ${b}`);
});

test("V2-02: signet decodes every ticker exactly as before; strict differs only on a leading BOM", async () => {
  const old = await preMainnet("envelope.mjs");
  for (const kind of ["deploy", "pow"]) {
    for (const [name, raw] of Object.entries(CORPUS)) {
      const bytes = withTicker(kind, raw);
      const signet = outcome(bytes);
      assert.deepEqual(signet, outcome(bytes, { strictTicker: false }), `${kind}/${name}: the signet default is the historical rule`);
      assert.equal(signet.ok, historical(raw), `${kind}/${name}: historical verdict`);
      if (old) assert.deepEqual(signet, oldOutcome(old, bytes), `${kind}/${name}: same as the pre-mainnet envelope.mjs`);
      const strict = outcome(bytes, { strictTicker: true });
      assert.equal(strict.ok, tickerBytesValid(Uint8Array.from(raw)), `${kind}/${name}: strict verdict`);
      if (!strict.ok && signet.ok) assert.ok(name.startsWith("bom"), `${kind}/${name}: only a BOM ticker is judged differently`);
      if (!strict.ok && !signet.ok && signet.error !== strict.error) assert.equal(strict.error, TICKER_BYTES_ERROR, `${kind}/${name}: only the ticker message differs`);
      if (strict.ok) assert.deepEqual(strict, signet, `${kind}/${name}: both accept with the same ticker`);
    }
    // The BOM cases are the whole difference.
    assert.deepEqual(outcome(withTicker(kind, CORPUS.bom)), { ok: true, ticker: "ABC" });
    assert.deepEqual(outcome(withTicker(kind, CORPUS.bom), { strictTicker: true }), { ok: false, error: TICKER_BYTES_ERROR });
  }
});

// The v1 identity chain (test/fixtures/v1-chain.json): real envelopes of every v1 op.
const FIX = JSON.parse(readFileSync("test/fixtures/v1-chain.json", "utf8"));
const fixtureBlocks = () => FIX.blocks.map((b) => ({
  height: b.height, hash: b.hash,
  txs: b.txs.map((t) => ({
    txid: t.txid, inputs: t.inputs.map((i) => ({ outpoint: unhex(i.outpoint) })),
    outputs: t.outputs.map((o) => ({ script: unhex(o.script), value: BigInt(o.value) })),
  })),
}));
const NO_MINING = [{ name: "mining", height: null, digestV: 2 }];
async function replay(opts = {}) {
  const idx = new Indexer({ vkey: VKEY, startHeight: FIX.startHeight, activations: NO_MINING, ...opts });
  idx.prevoutScript = async (o) => unhex(FIX.prevouts[hex(o)]);
  for (const b of fixtureBlocks()) await idx.applyBlock(b);
  return idx;
}

test("signet: every envelope of the v1 chain decodes identically with and without the strict rule, and as before", async () => {
  const old = await preMainnet("envelope.mjs");
  const payloads = fixtureBlocks().flatMap((b) => b.txs).map(findEnvelope).filter(Boolean);
  assert.ok(payloads.length >= 8);
  const extra = [encodeAttest({ kind: 1, hash: randomBytes(32) }), encodeDeploy({ ...DEPLOY_TERMS, ticker: "ZZ9" }), encodeDeployPow({ ...POW_TERMS, ticker: "MINE1" })];
  for (const p of [...payloads, ...extra]) {
    const a = outcome(p);
    assert.deepEqual(outcome(p, { strictTicker: true }), a, hex(p).slice(0, 16));
    if (old) assert.deepEqual(a, oldOutcome(old, p));
  }
});

test("signet: the v1 chain replays to the same digests and log with either ticker rule", async () => {
  const lax = await replay();
  assert.equal(lax.strictTicker, false, "signet default");
  assert.deepEqual([...lax.digests], FIX.digests);
  assert.deepEqual(lax.log, FIX.log);
  const strict = await replay({ strictTicker: true });
  assert.deepEqual([...strict.digests], FIX.digests, "no v1 ticker depends on V2-02");
  assert.deepEqual(strict.log, FIX.log);
});

const coinbase = () => ({ txid: randomBytes(32).toString("hex"), inputs: [{ outpoint: new Uint8Array(36).fill(0).map((v, i) => (i >= 32 ? 0xff : 0)) }], outputs: [] });
const carrier = (payload) => ({ txid: randomBytes(32).toString("hex"), inputs: [{ outpoint: randomBytes(36) }], outputs: [{ script: opReturnScript(payload), value: 0n }] });

test("Indexer strictTicker: a BOM ticker DEPLOY is accepted by the historical rule and malformed under the strict one", async () => {
  for (const strictTicker of [false, true]) {
    const idx = new Indexer({ vkey: VKEY, startHeight: 700000, activations: NO_MINING, strictTicker });
    const tx = carrier(withTicker("deploy", CORPUS.bom));
    await idx.applyBlock({ height: 700000, hash: randomBytes(32).toString("hex"), txs: [coinbase(), tx] });
    const e = idx.log.find((l) => l.txid === tx.txid);
    if (strictTicker) {
      assert.equal(e.ok, false);
      assert.equal(e.reason, `malformed: ${TICKER_BYTES_ERROR}`);
      assert.equal(idx.assets.size, 0);
    } else {
      assert.equal(e.ok, true, "historical: the BOM is stripped");
      assert.equal(idx.tickers.has("ABC"), true);
    }
  }
  // The option survives a snapshot round trip by being a constructor option (the network's default).
  const idx = new Indexer({ vkey: VKEY, startHeight: 700000, activations: NO_MINING });
  assert.equal(Indexer.restore(idx.snapshot(), { vkey: VKEY, activations: NO_MINING }).strictTicker, false);
  assert.equal(Indexer.restore(idx.snapshot(), { vkey: VKEY, activations: NO_MINING, strictTicker: true }).strictTicker, true);
});

// ---------------------------------------------------------------- keys and addresses

test("signet keys: derivations unchanged; a murk1 (mainnet) address is refused with a clear message", () => {
  const seed = new Uint8Array(32).fill(7);
  const k = deriveKeys(seed);
  const addr = encodeAddress(k);
  assert.ok(addr.startsWith("mrk1"));
  assert.equal(decodeAddress(addr).pk, k.pk);
  const entropy = new Uint8Array(32).fill(9);
  const fees = feeKeysOf(entropy);
  // Pinned outputs of the signet labels (murkle/btc-fee, murkle/btc-mine-fee, murkle/spend).
  assert.equal(btcAccount(fees.feeKey).address.slice(0, 4), "tb1p");
  assert.throws(() => decodeAddress("murk1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq"),
    { message: "This is a Murkle mainnet address (murk1…). This wallet is on Bitcoin signet." });
  assert.throws(() => decodeAddress("bc1qxyz"), /not a Murkle address|Invalid|invalid|checksum|Unknown/);
});

test("signet: key labels give exactly the old keys (computed with the literal labels)", async () => {
  const { hkdf } = await import("@noble/hashes/hkdf");
  const { sha256: H } = await import("@noble/hashes/sha256");
  const entropy = new Uint8Array(32).fill(3);
  assert.equal(hex(feeKeysOf(entropy).feeKey), hex(hkdf(H, entropy, undefined, "murkle/btc-fee", 32)));
  assert.equal(hex(feeKeysOf(entropy).mineFeeKey), hex(hkdf(H, entropy, undefined, "murkle/btc-mine-fee", 32)));
  assert.equal(hex(deriveKeys(entropy).vsk), hex(hkdf(H, entropy, undefined, "murkle/view", 32)));
});

// ---------------------------------------------------------------- relayer, server and CLI on signet

test("signet relayer defaults are unchanged; the mainnet set is internally consistent", () => {
  const signet = {
    maxFeeRate: 5, maxFeePerTx: 3000, marginMinSats: 50, minDepositSats: 2000, invalidProofSats: 50, fanoutTarget: 24,
    fanoutValue: 13000, fanoutMinCarriers: 120, invalidPowSats: 20, minMix: 3,
  };
  for (const [k, v] of Object.entries(signet)) assert.equal(DEFAULTS[k], v, k);
  assert.deepEqual({ ...NETWORK_DEFAULTS.signet }, signet);
  assert.equal(DEFAULTS.marginPct, 10);
  assert.equal(DEFAULTS.depositConfirmations, null);
  assert.equal(DEFAULTS.relayDir, "data/signet/relay-balance");
  const m = NETWORK_DEFAULTS.mainnet;
  assert.equal(m.minMix, 5, "L1: mainnet carriers need cover from 5 other accounts");
  assert.deepEqual(balanceProblems({ ...DEFAULTS, ...m }), [], "the mainnet defaults pass the same validation");
  assert.ok(m.minDepositSats > sweepCostFor(m.maxFeeRate) + 330, "a deposit always pays its own sweep at the cap");
  const sendAtCap = costFor(DEFAULTS.estVsize * m.maxFeeRate, { marginPct: DEFAULTS.marginPct, marginMinSats: m.marginMinSats });
  assert.ok(m.minDepositSats - sweepCostFor(m.maxFeeRate) >= 2 * sendAtCap, "a minimum deposit pays two sends at the fee cap");
  assert.ok(m.maxFeePerTx >= DEFAULTS.mineEstVsize * Math.ceil(m.maxFeeRate * DEFAULTS.mineFeeHeadroom), "a claim carrier fits the per-tx cap at the rate cap");
  assert.ok(m.maxFeePerTx >= DEFAULTS.estVsize * m.maxFeeRate, "a transfer carrier fits too");
  assert.ok(m.fanoutValue >= 2 * m.maxFeePerTx, "a fan-out coin counts as a funding coin");
});

test("nextBlockRate (CLI): a source's nextBlockFeeRate answers first, else today's path", async () => {
  assert.equal(await nextBlockRate({ nextBlockFeeRate: async () => 7.2, feeRate: async () => 99 }), 8);
  assert.equal(await nextBlockRate({ nextBlockFeeRate: async () => 0, feeRate: async () => 99 }), 1);
  assert.equal(await nextBlockRate({ feeRate: async () => 4 }), 4, "no nextBlockFeeRate: the plain estimate");
  await assert.rejects(nextBlockRate({ nextBlockFeeRate: async () => NaN }), /no next-block fee rate/);
});

test("server startRefusal: signet never refuses; mainnet refuses pre-genesis, an unpinned vkey and an incomplete fee rule", () => {
  assert.equal(startRefusal(), null, "this checkout on signet");
  assert.equal(startRefusal({ test: true, preGenesis: true, vkeyPinned: false, miningHeight: null }), null, "signet pre-genesis runs, as before");
  const main = { network: "mainnet", test: false, preGenesis: true, vkeyPinned: false, miningHeight: null, mineFeeReason: "x", allowPreGenesis: false };
  assert.match(startRefusal(main), /mainnet artifacts are not pinned yet .*run the ceremony/);
  assert.match(startRefusal({ ...main, vkeyPinned: true }), /has not launched on mainnet: no genesis is pinned/);
  assert.equal(startRefusal({ ...main, vkeyPinned: true, allowPreGenesis: true }), null, "staging");
  assert.match(startRefusal({ ...main, vkeyPinned: true, allowPreGenesis: true, miningHeight: 900000, mineFeeReason: P.mineFeeReady(P.MINE_FEES.mainnet) }), /TODO_PLATFORM_ADDRESS.*pins a mining height/);
  assert.equal(startRefusal({ ...main, vkeyPinned: true, preGenesis: false, miningHeight: null }), null, "launched mainnet");
});

test("CLI commandRefusal: nothing refused on signet; mainnet pre-genesis runs only the listed commands", () => {
  for (const c of ["send", "mint", "deploy", "relay", "mine", "deploy-pow", "attest"]) assert.equal(commandRefusal(c, []), null, c);
  const pre = { test: false, preGenesis: true, mineReason: "mining is not configured on mainnet: the platform address is TODO_PLATFORM_ADDRESS" };
  for (const c of ["new", "address", "address-script", "attest", "sync", "assets", "log", "balance", "pending", "audit"]) assert.equal(commandRefusal(c, [], pre), null, c);
  // No deposit address for real coins before launch (the relayer is off then, too).
  for (const sub of ["account", "balance"]) assert.match(commandRefusal("relay", [sub], pre), /has not launched on .*refused/, sub);
  for (const c of ["send", "mint", "deploy", "retry", "relayer"]) assert.match(commandRefusal(c, [], pre), /has not launched on .*refused/, c);
  assert.match(commandRefusal("relay", ["topup"], pre), /refused/);
  for (const c of ["mine", "deploy-pow"]) assert.match(commandRefusal(c, [], pre), /TODO_PLATFORM_ADDRESS; nothing was mined or launched/, c);
  assert.match(commandRefusal("mine", [], { ...pre, preGenesis: false }), /TODO_PLATFORM_ADDRESS/, "mining refuses after genesis too");
  assert.equal(commandRefusal("send", [], { ...pre, preGenesis: false }), null);
});

test("CLI address-script: this network's addresses only", () => {
  const acct = btcAccount(new Uint8Array(32).fill(1));
  assert.equal(addressScriptHex(acct.address), hex(acct.script));
  assert.throws(() => addressScriptHex("bc1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8syx4e5t"), /not a Bitcoin signet address/);
});

test("chain source fallback: without src/btc/source.mjs signet uses Esplora unverified, mainnet refuses; with it, openChainSource is used", async () => {
  const missing = join(DIR, "no-source.mjs");
  for (const open of [openServerChainSource, openCliChainSource]) {
    const s = await open({ sourceModule: missing, read: () => undefined, headersPath: join(DIR, "h.json"), log: silent });
    assert.equal(s.kind, "esplora");
    assert.equal(s.headers, null);
    assert.equal(s.api.base, "https://mempool.space/signet/api");
    s.save();
    const custom = await open({ sourceModule: missing, read: (n) => (n === "ESPLORA" ? "http://127.0.0.1:9/api" : undefined), log: silent });
    assert.equal(custom.api.base, "http://127.0.0.1:9/api");
    await assert.rejects(open({ sourceModule: missing, test: false, network: "mainnet", read: () => undefined, log: silent }), /header verification is required on mainnet/);
  }
  const fake = join(DIR, "fake-source.mjs");
  writeFileSync(fake, "export async function openChainSource(o) { return { kind: 'bitcoind', api: {}, headers: { status: () => ({ verified: true }) }, save() {}, describe: () => 'fake', opts: { network: o.network, headersPath: o.headersPath } }; }\n");
  const got = await openServerChainSource({ sourceModule: fake, headersPath: join(DIR, "hs.json"), log: silent });
  assert.equal(got.kind, "bitcoind");
  assert.deepEqual(got.opts, { network: "signet", headersPath: join(DIR, "hs.json") });
});

// ---------------------------------------------------------------- /api/health, /api/state.chain, build marker, /ceremony

async function serve(opts) {
  const app = createApp({ log: silent, ...opts });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base, close: () => new Promise((r) => app.server.close(r)) };
}

test("GET /api/health: liveness 200, ?strict=1 503 on lag, errors, a halted relayer or old syncs", async () => {
  const idx = new Indexer({ vkey: VKEY, startHeight: 800000, activations: NO_MINING });
  await idx.applyBlock({ height: 800000, hash: randomBytes(32).toString("hex"), txs: [coinbase()] });
  let now = 1_000_000_000_000;
  let halted = false;
  const relayer = { config: { enabled: true }, lock: null, health: () => ({ enabled: true, halted, code: halted ? "halted" : null, problems: halted ? ["x"] : [] }), queuedCount: () => 0 };
  const headers = { status: () => ({ verified: true, network: "signet", rules: "pow+signet-signature-unchecked", base: { height: 799000, hash: "00" }, tipHeight: 800000, tipHash: "00", headers: 1001, workHex: "01", lastError: null }) };
  const { app, base, close } = await serve({ idx, relayer: { ...relayer, lock: { run: (f) => f() } }, headers, source: { kind: "bitcoind", save() {} }, now: () => now, healthMaxLag: 3 });
  try {
    app.status.chainTip = 800001;
    app.status.lastSync = now - 5000;
    let r = await fetch(`${base}/api/health`);
    assert.equal(r.status, 200);
    let h = await r.json();
    assert.deepEqual(h, {
      ok: true, network: "signet", height: 800000, chainTip: 800001, lagBlocks: 1, lastSync: now - 5000, syncAgeSecs: 5, lastError: null,
      source: "bitcoind", headers: { verified: true, tipHeight: 800000, baseHeight: 799000, lastError: null },
      relayer: { enabled: true, halted: false, code: null }, artifacts: { ok: true }, preGenesis: true,
    });
    assert.equal((await fetch(`${base}/api/health?strict=1`)).status, 200);
    const strict = async () => (await fetch(`${base}/api/health?strict=1`)).status;
    app.status.chainTip = 800004;
    assert.equal(await strict(), 503, "lag 4 > 3");
    app.status.chainTip = 800001;
    app.status.lastError = "sync failed";
    assert.equal(await strict(), 503);
    r = await fetch(`${base}/api/health`);
    assert.equal(r.status, 200, "liveness stays 200");
    assert.equal((await r.json()).ok, false);
    app.status.lastError = null;
    halted = true;
    assert.equal(await strict(), 503, "halted relayer");
    halted = false;
    now += 601_000;
    assert.equal(await strict(), 503, "no sync for over 10 minutes");
    app.status.lastSync = now;
    assert.equal(await strict(), 200);
    const st = await (await fetch(`${base}/api/state`)).json();
    assert.equal(st.chain.source, "bitcoind");
    assert.equal(st.chain.headers.verified, true);
    assert.equal(st.network, "signet");
  } finally {
    await close();
  }
});

test("GET /api/health without headers or relayer; /api/state.chain says esplora and null", async () => {
  const idx = new Indexer({ vkey: VKEY, startHeight: 800000, activations: NO_MINING });
  const { base, close } = await serve({ idx });
  try {
    const h = await (await fetch(`${base}/api/health`)).json();
    assert.equal(h.source, "esplora");
    assert.equal(h.headers, null);
    assert.deepEqual(h.relayer, { enabled: false, halted: false, code: null });
    assert.equal(h.lagBlocks, null);
    assert.deepEqual((await (await fetch(`${base}/api/state`)).json()).chain, { source: "esplora", headers: null });
  } finally {
    await close();
  }
});

test("web build marker: a dist for another network is not served; no marker counts as signet; /ceremony routes", async () => {
  const dist = join(DIR, "dist-marker");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>M</title></head><body></body></html>");
  assert.deepEqual(checkWebBuild(dist, "signet"), { ok: true, network: "signet", message: null });
  assert.equal(checkWebBuild(dist, "mainnet").ok, false);
  const idx = new Indexer({ vkey: VKEY, startHeight: 800000, activations: NO_MINING });
  const { base, close } = await serve({ idx, webDist: dist });
  try {
    assert.equal((await fetch(`${base}/`)).status, 200, "no marker: signet");
    assert.equal((await fetch(`${base}/ceremony`)).status, 404, "no ceremony page built");
    for (const p of ["/ceremony/api/status", "/ceremony/files/0001.zkey", "/ceremony/transcript.json", "/ceremony/api"]) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 404, p);
      assert.equal((await r.json()).error.code, "not_found");
    }
    writeFileSync(join(dist, "ceremony.html"), "<!doctype html><title>ceremony</title>");
    for (const p of ["/ceremony", "/ceremony/"]) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 200, p);
      assert.match(await r.text(), /ceremony/);
      assert.ok(r.headers.get("content-security-policy-report-only") || r.headers.get("content-security-policy"), "the CSP goes with it");
    }
    writeFileSync(join(dist, "murkle-build.json"), JSON.stringify({ network: "mainnet", manifestSha256: null, genesisTxid: null }));
    const r = await fetch(`${base}/`);
    assert.equal(r.status, 503);
    assert.match(await r.text(), /built for mainnet; this indexer runs on signet/);
    assert.equal((await fetch(`${base}/api/health`)).status, 200, "the API still answers");
    writeFileSync(join(dist, "murkle-build.json"), JSON.stringify({ network: "signet", manifestSha256: null, genesisTxid: null }));
    assert.equal((await fetch(`${base}/`)).status, 200);
  } finally {
    await close();
  }
});

test("signet link previews keep their words", async () => {
  const dist = join(DIR, "dist-og");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "index.html"), "<!doctype html><html><head><title>M</title></head><body></body></html>");
  const idx = new Indexer({ vkey: VKEY, startHeight: 800000, activations: NO_MINING });
  const { base, close } = await serve({ idx, webDist: dist });
  try {
    const html = await (await fetch(`${base}/t/NOPE`)).text();
    assert.match(html, /Signet test network; the tokens have no value\./);
  } finally {
    await close();
  }
});

// ================================================================ mainnet (child processes)

test("mainnet params: network, HRP, labels, pins, explorer, strict tickers, placeholder fee", async () => {
  const r = await child(`
    const P = await import("./src/params.mjs");
    console.log(JSON.stringify({
      network: P.NETWORK, test: P.IS_TESTNET, hrp: P.ADDRESS_HRP, btc: P.BTC_HRP, labels: P.LABELS, prefix: P.STORAGE_PREFIX,
      explorer: P.EXPLORER, esplora: P.ESPLORA_API, strict: P.STRICT_TICKER, unisat: P.UNISAT_CHAIN, faucet: P.FAUCET,
      pins: P.PINS, preGenesis: P.PRE_GENESIS, genesis: P.GENESIS, mining: P.MINING_HEIGHT, pinsFile: P.PINS_FILE, paths: P.ARTIFACT_PATHS,
      fee: { ...P.MINE_FEE, platformSats: String(P.MINE_FEE.platformSats), deployerMinSats: String(P.MINE_FEE.deployerMinSats), deployerMaxSats: String(P.MINE_FEE.deployerMaxSats) },
      ready: P.mineFeeReady(), signetReady: P.mineFeeReady(P.MINE_FEES.signet), digest1: P.digestTag(1), magic: P.MAGIC_TEXT,
    }));`);
  assert.equal(r.network, "mainnet");
  assert.equal(r.test, false);
  assert.equal(r.hrp, "murk");
  assert.equal(r.btc, "bc");
  assert.deepEqual(r.labels, {
    spend: "murkle/mainnet/spend", view: "murkle/mainnet/view", note: "murkle/note", btcFee: "murkle/mainnet/btc-fee",
    relayPow: "murkle/relay/pow/v1", digest: "murkle/digest/v1", btcMineFee: "murkle/mainnet/btc-mine-fee", mine: "murkle/mine/v1",
  });
  assert.equal(r.digest1, "murkle/digest/v1", "protocol hashes never change");
  assert.equal(r.magic, "mrk", "same envelope magic (D6)");
  assert.equal(r.prefix, "murkle.mainnet");
  assert.equal(r.explorer, "https://mempool.space");
  assert.equal(r.esplora, "https://mempool.space/api");
  assert.equal(r.strict, true);
  assert.equal(r.unisat, "BITCOIN_MAINNET");
  assert.equal(r.faucet, null);
  assert.deepEqual(r.pins, JSON.parse(readFileSync("src/pins.mainnet.json", "utf8")));
  assert.equal(r.pins.artifacts.wasm, JSON.parse(readFileSync("src/pins.json", "utf8")).artifacts.wasm, "same circuit, same wasm");
  assert.equal(r.preGenesis, true);
  assert.equal(r.genesis, null);
  assert.equal(r.mining, null);
  assert.equal(r.pinsFile, "src/pins.mainnet.json");
  assert.deepEqual(r.paths, { manifest: "build/mainnet/manifest.json", vkey: "build/mainnet/verification_key.json", zkey: "build/mainnet/transaction.zkey", wasm: "build/transaction_js/transaction.wasm" });
  assert.deepEqual(r.fee, { placeholder: true, platformAddress: "TODO_PLATFORM_ADDRESS", platformScript: null, platformSats: "1000", deployerMinSats: "0", deployerMaxSats: "0" });
  assert.equal(r.ready, "mining is not configured on mainnet: the platform address is TODO_PLATFORM_ADDRESS");
  assert.equal(r.signetReady, null);
});

test("an unknown MURKLE_NETWORK refuses to load; an empty one is signet", async () => {
  await assert.rejects(child(`await import("./src/params.mjs"); console.log("{}");`, { MURKLE_NETWORK: "testnet" }), /MURKLE_NETWORK must be "signet" or "mainnet", not "testnet"/);
  const r = await child(`const P = await import("./src/params.mjs"); console.log(JSON.stringify({ n: P.NETWORK }));`, { MURKLE_NETWORK: "" });
  assert.equal(r.n, "signet");
});

test("mainnet keys: murk1 addresses, mrk1 refused, network-separated fee keys (no link to signet)", async () => {
  const seed = "07".repeat(32);
  const entropy = "09".repeat(32);
  const r = await child(`
    const K = await import("./src/keys.mjs");
    const F = await import("./src/btc/funding.mjs");
    const { unhex, hex } = await import("./src/bytes.mjs");
    const k = K.deriveKeys(unhex("${seed}"));
    const a = K.encodeAddress(k);
    let refused = null;
    try { K.decodeAddress("${encodeAddress(deriveKeys(new Uint8Array(32).fill(7)))}"); } catch (e) { refused = e.message; }
    const fees = K.feeKeysOf(unhex("${entropy}"));
    console.log(JSON.stringify({ a, back: String(K.decodeAddress(a).pk), pk: String(k.pk), refused, fee: F.btcAccount(fees.feeKey).address, mineFee: hex(fees.mineFeeKey) }));`);
  assert.ok(r.a.startsWith("murk1"));
  assert.equal(r.back, r.pk);
  assert.equal(r.refused, "This is a Murkle signet address (mrk1…). This wallet is on Bitcoin mainnet.");
  assert.notEqual(r.pk, String(deriveKeys(new Uint8Array(32).fill(7)).pk), "the same seed gives another spend key on mainnet");
  assert.ok(r.fee.startsWith("bc1p"));
  const signetFee = btcAccount(feeKeysOf(new Uint8Array(32).fill(9)).feeKey);
  const mainScript = hex((await import("@scure/btc-signer")).OutScript.encode((await import("@scure/btc-signer")).Address((await import("@scure/btc-signer")).NETWORK).decode(r.fee)));
  assert.notEqual(mainScript, hex(signetFee.script), "the Bitcoin fee key differs, so signet and mainnet activity are not linked by it");
  assert.notEqual(r.mineFee, hex(feeKeysOf(new Uint8Array(32).fill(9)).mineFeeKey));
});

test("mainnet Indexer: strict tickers by default, the v1 chain replays to the same digests, a mining activation with the placeholder fee refuses", async () => {
  const bomDeploy = hex(withTicker("deploy", CORPUS.bom));
  const r = await child(`
    const { readFileSync } = await import("node:fs");
    const { Indexer } = await import("./src/indexer.mjs");
    const { opReturnScript } = await import("./src/envelope.mjs");
    const { unhex, hex } = await import("./src/bytes.mjs");
    const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
    const FIX = JSON.parse(readFileSync("test/fixtures/v1-chain.json", "utf8"));
    const idx = new Indexer({ vkey: VKEY, startHeight: FIX.startHeight });
    idx.prevoutScript = async (o) => unhex(FIX.prevouts[hex(o)]);
    for (const b of FIX.blocks) await idx.applyBlock({ height: b.height, hash: b.hash, txs: b.txs.map((t) => ({ txid: t.txid, inputs: t.inputs.map((i) => ({ outpoint: unhex(i.outpoint) })), outputs: t.outputs.map((o) => ({ script: unhex(o.script), value: BigInt(o.value) })) })) });
    const one = new Indexer({ vkey: VKEY, startHeight: 900000 });
    const cb = { txid: "aa".repeat(32), inputs: [{ outpoint: new Uint8Array(36) }], outputs: [] };
    const tx = { txid: "bb".repeat(32), inputs: [{ outpoint: new Uint8Array(36).fill(1) }], outputs: [{ script: opReturnScript(unhex("${bomDeploy}")), value: 0n }] };
    await one.applyBlock({ height: 900000, hash: "cc".repeat(32), txs: [cb, tx] });
    let mining = null;
    try { new Indexer({ vkey: VKEY, startHeight: 900000, activations: [{ name: "mining", height: 900100, digestV: 2 }] }); } catch (e) { mining = e.message; }
    console.log(JSON.stringify({ strict: idx.strictTicker, digests: [...idx.digests], log: idx.log, bom: one.log.find((l) => l.txid === tx.txid), mining }));
    await globalThis.curve_bn128?.terminate?.(); // snarkjs keeps worker threads alive otherwise`);
  assert.equal(r.strict, true);
  assert.deepEqual(r.digests, FIX.digests, "consensus is the same on mainnet for canonical tickers");
  assert.deepEqual(r.log, FIX.log);
  assert.equal(r.bom.ok, false);
  assert.equal(r.bom.reason, `malformed: ${TICKER_BYTES_ERROR}`);
  assert.equal(r.mining, "mining activation needs a complete MINE_FEE: mining is not configured on mainnet: the platform address is TODO_PLATFORM_ADDRESS");
});

test("mainnet relayer defaults, funding network and the pool script", async () => {
  const r = await child(`
    const R = await import("./server/relayer.mjs");
    const F = await import("./src/btc/funding.mjs");
    const btc = await import("@scure/btc-signer");
    console.log(JSON.stringify({ d: R.DEFAULTS, problems: R.balanceProblems({ ...R.DEFAULTS }), mainnetNet: F.NETWORK === btc.NETWORK, bech32: F.NETWORK.bech32 }));`);
  for (const [k, v] of Object.entries(NETWORK_DEFAULTS.mainnet)) assert.equal(r.d[k], v, k);
  assert.equal(r.d.maxFeeRate, 50);
  assert.equal(r.d.maxFeePerTx, 45000);
  assert.equal(r.d.minDepositSats, 70000);
  assert.equal(r.d.marginMinSats, 300);
  assert.equal(r.d.relayDir, "data/mainnet/relay-balance");
  assert.deepEqual(r.problems, []);
  assert.equal(r.mainnetNet, true);
  assert.equal(r.bech32, "bc");
});

test("mainnet server: refuses to start before the ceremony, and before genesis (never binds a port)", async () => {
  const env = { MURKLE_NETWORK: "mainnet", MURKLE_INDEXER_PORT: "0", MURKLE_STATE_PATH: join(DIR, "m-state.json"), MURKLE_RELAYER: "0" };
  let out = await run(["server/indexer-server.mjs"], env);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /refusing to start: mainnet artifacts are not pinned yet \(src\/pins\.mainnet\.json has no vkey\): run the ceremony/);
  out = await run(["server/indexer-server.mjs"], { ...env, MURKLE_ALLOW_PRE_GENESIS: "1" });
  assert.equal(out.code, 1, "staging still refuses an unpinned verification key");
  assert.match(out.stderr, /artifacts are not pinned yet/);
  const r = await child(`
    const S = await import("./server/indexer-server.mjs");
    console.log(JSON.stringify({ refusal: S.startRefusal({ vkeyPinned: true }), staging: S.startRefusal({ vkeyPinned: true, allowPreGenesis: true }), artifacts: S.ARTIFACTS }));`);
  assert.match(r.refusal, /Murkle has not launched on mainnet: no genesis is pinned in src\/pins\.mainnet\.json/);
  assert.equal(r.staging, null);
  assert.match(r.artifacts["verification_key.json"].replaceAll("\\", "/"), /build\/mainnet\/verification_key\.json$/);
  assert.match(r.artifacts["transaction.wasm"].replaceAll("\\", "/"), /build\/transaction_js\/transaction\.wasm$/);
});

test("mainnet CLI: help and usage name the network; value-moving commands and mining refuse before genesis", async () => {
  const env = { MURKLE_NETWORK: "mainnet", MURKLE_DATA_DIR: join(DIR, "cli-main"), MURKLE_ESPLORA: "http://127.0.0.1:9/api" };
  const help = await run(["bin/murkle.mjs"], env);
  assert.match(help.stdout, /Murkle CLI \(mainnet\)\. Commands:/);
  assert.match(help.stdout, /--treasury bc1…/);
  assert.match(help.stdout, /<murk1…>/);
  const send = await run(["bin/murkle.mjs", "send", "w", "ABC", "1", "murk1x"], env);
  assert.equal(send.code, 1);
  assert.match(send.stderr, /has not launched on mainnet: no genesis is pinned in src\/pins\.mainnet\.json, so send is refused/);
  const mine = await run(["bin/murkle.mjs", "mine", "w", "ABC"], env);
  assert.match(mine.stderr, /mining is not configured on mainnet: the platform address is TODO_PLATFORM_ADDRESS/);
  const script = await run(["bin/murkle.mjs", "address-script", "bc1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8syx4e5t"], env);
  assert.equal(script.code, 0);
  assert.equal(script.stdout.trim(), "51208c5db7f797196d6edc4dd7df6048f4ea6b883a6af6af032342088f436543790f");
  const created = await run(["bin/murkle.mjs", "new", "w"], env);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /address: murk1/);
  assert.match(created.stdout, /BTC fee address: bc1p\S+ {2}\(Bitcoin mainnet: real bitcoin; fund it/);
  assert.match(created.stdout, /plaintext keys for Bitcoin mainnet/);
});

test("signet CLI: help and the address line are verbatim", async () => {
  const env = { MURKLE_NETWORK: "", MURKLE_DATA_DIR: join(DIR, "cli-signet"), MURKLE_ESPLORA: "http://127.0.0.1:9/api" };
  const help = await run(["bin/murkle.mjs"], env);
  assert.match(help.stdout, /^Murkle CLI \(signet\)\. Commands:/);
  assert.match(help.stdout, /--treasury tb1…\] \[--divisibility d --start h --end h\]/);
  assert.match(help.stdout, /  mint <w> <ticker> \| send <w> <ticker> <amount> <mrk1…>\n/);
  const created = await run(["bin/murkle.mjs", "new", "w"], env);
  assert.equal(created.code, 0, created.stderr);
  assert.match(created.stdout, /BTC fee address: tb1p\S+ {2}\(signet; fund it for fees and mint prices\)/);
  assert.doesNotMatch(created.stdout, /plaintext keys/);
});

test("mainnet web: config, Unisat chain, pre-launch guards and copy", async () => {
  const r = await child(`
    const C = await import("./web/src/config.js");
    const Pay = await import("./web/src/payers.js");
    const St = await import("./web/src/ui/status.js");
    const T = await import("./web/src/ui/transcript.js");
    const K = await import("./web/src/keystore.js");
    const store = new Map([["zkpool.signet.phrase", JSON.stringify("abandon ".repeat(23) + "art")]]);
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
    let carried = null;
    try { await new Pay.LocalPayer(new Uint8Array(32).fill(1)).carry({ api: {}, envelope: new Uint8Array(38), utxos: [] }); } catch (e) { carried = e.message; }
    console.log(JSON.stringify({
      network: C.NETWORK, testnet: C.IS_TESTNET, faucet: C.FAUCET, legacy: C.LEGACY_STORAGE_PREFIX, hrp: C.ADDRESS_HRP, btc: C.BTC_HRP,
      unisat: C.UNISAT_CHAIN, strict: C.STRICT_TICKER, pins: C.PINS, explorer: C.EXPLORER, notLaunched: C.NOT_LAUNCHED, word: C.BTC_WORD,
      notice: Pay.UNISAT_SIGNET_NOTICE, reason: Pay.NOT_LAUNCHED_REASON, carried, blocked: St.chainWritesBlocked(),
      data: T.copyText([]).split("\\n").pop(), legacyPhrase: K.legacyPhrase(storage),
    }));`);
  assert.equal(r.network, "mainnet");
  assert.equal(r.testnet, false);
  assert.equal(r.faucet, null);
  assert.equal(r.legacy, null, "no zkpool-era migration on mainnet");
  assert.equal(r.legacyPhrase, null);
  assert.equal(r.hrp, "murk");
  assert.equal(r.btc, "bc");
  assert.equal(r.unisat, "BITCOIN_MAINNET");
  assert.equal(r.strict, true);
  assert.equal(r.pins.genesisTxid, null);
  assert.equal(r.explorer, "https://mempool.space");
  assert.equal(r.notLaunched, true);
  assert.equal(r.word, "BTC");
  assert.equal(r.notice, null, "the Unisat signet relay-policy notice is signet only");
  assert.equal(r.reason, "Murkle has not launched on Bitcoin mainnet. No genesis is pinned, so nothing here can move funds.");
  assert.equal(r.carried, r.reason, "no payer carries anything before launch");
  assert.match(r.blocked, /has not launched on Bitcoin mainnet/);
  assert.equal(r.data, "Data: mempool.space, independent of us.");
});

test("signet web: config and copy unchanged", async () => {
  const C = await import("../web/src/config.js");
  const Pay = await import("../web/src/payers.js");
  const St = await import("../web/src/ui/status.js");
  assert.equal(C.NETWORK, "signet");
  assert.equal(C.LEGACY_STORAGE_PREFIX, "zkpool.signet");
  assert.equal(C.FAUCET, "https://signetfaucet.com");
  assert.equal(C.EXPLORER, "https://mempool.space/signet");
  assert.equal(C.ADDRESS_HRP, "mrk");
  assert.equal(C.UNISAT_CHAIN, "BITCOIN_SIGNET");
  assert.equal(C.NOT_LAUNCHED, false);
  assert.equal(C.BTC_WORD, "signet BTC");
  assert.match(Pay.UNISAT_SIGNET_NOTICE, /^Unisat's signet node rejects large OP_RETURN outputs/);
  assert.equal(Pay.NOT_LAUNCHED_REASON, null);
  assert.equal(St.chainWritesBlocked(), null);
});

test("Unisat payer: the chain check names the network (mock wallet, nothing is paid)", async () => {
  const code = (net) => `
    const Pay = await import("./web/src/payers.js");
    const calls = [];
    globalThis.window = { unisat: {
      getChain: async () => ({ enum: "BITCOIN_TESTNET" }), switchChain: async (c) => calls.push(c),
      requestAccounts: async () => ["${net === "mainnet" ? "bc1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8syx4e5t" : btcAccount(new Uint8Array(32).fill(1)).address}"],
      getAccounts: async () => ["${net === "mainnet" ? "bc1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8syx4e5t" : btcAccount(new Uint8Array(32).fill(1)).address}"],
    } };
    const p = await new Pay.UnisatPayer().connect();
    let err = null;
    try { await p.checkAccount(); } catch (e) { err = e.message; }
    console.log(JSON.stringify({ calls, err }));`;
  const main = await child(code("mainnet"));
  assert.deepEqual(main.calls, ["BITCOIN_MAINNET"]);
  assert.equal(main.err, "Unisat is no longer on Bitcoin mainnet (it was switched to another network). Nothing was paid. Switch Unisat back to mainnet, or connect it again, then retry.");
  const sig = await child(code("signet"), { MURKLE_NETWORK: "signet" });
  assert.deepEqual(sig.calls, ["BITCOIN_SIGNET"]);
  assert.equal(sig.err, "Unisat is no longer on Bitcoin Signet (it was switched to another network). Nothing was paid. Switch Unisat back to Signet, or connect it again, then retry.");
});

test("Vite config: the network define, the ceremony entry only when its file exists, the dev proxy and the build marker plugin", async () => {
  const code = `
    const m = (await import("./web/vite.config.mjs")).default;
    console.log(JSON.stringify({ define: m.define, input: Object.keys(m.build.rollupOptions.input), proxy: Object.keys(m.server.proxy), plugins: m.plugins.map((p) => p.name) }));`;
  const main = await child(code);
  assert.deepEqual(main.define, { __MURKLE_NETWORK__: JSON.stringify("mainnet") });
  const sig = await child(code, { MURKLE_NETWORK: "" });
  assert.deepEqual(sig.define, { __MURKLE_NETWORK__: JSON.stringify("signet") });
  assert.deepEqual(sig.input, existsSync("web/ceremony.html") ? ["index", "ceremony"] : ["index"]);
  assert.deepEqual(sig.proxy, ["/api", "/artifacts", "/ceremony/api", "/ceremony/files"]);
  assert.ok(sig.plugins.includes("murkle-build-marker"));
  assert.ok(sig.plugins.includes("murkle-network-html"));
  await assert.rejects(child(code, { MURKLE_NETWORK: "regtest" }), /MURKLE_NETWORK must be "signet" or "mainnet"/);
});

test("params.mjs reads the build-time define when no env is set (the browser path)", async () => {
  const src = readFileSync("src/params.mjs", "utf8");
  assert.match(src, /typeof __MURKLE_NETWORK__ !== "undefined" \? __MURKLE_NETWORK__ : undefined/);
  const r = await child(`
    globalThis.__MURKLE_NETWORK__ = "mainnet";
    const P = await import("./src/params.mjs");
    console.log(JSON.stringify({ n: P.NETWORK }));`, { MURKLE_NETWORK: "" });
  assert.equal(r.n, "mainnet");
});

// ================================================================ docs and file hygiene

const BANNED = /\b(trustless|anonymous|untraceable|mixer|mainnet-ready)\b|\baudited\b|live on mainnet/i;
const CYRILLIC = /[\u0400-\u04FF]/;

test("docs/MAINNET.md: the launch sequence, the owner's list and the go/no-go list, honest copy", () => {
  const md = readFileSync("docs/MAINNET.md", "utf8");
  for (const g of ["G0", "G1", "G2", "G3", "G4", "G5", "G6", "G7", "G8"]) assert.match(md, new RegExp(`\\b${g}\\b`), g);
  assert.match(md, /What the owner must provide/i);
  assert.match(md, /Go\/no-go/i);
  assert.match(md, /TODO_PLATFORM_ADDRESS/);
  assert.match(md, /murkle address-script/);
  assert.match(md, /MURKLE_NETWORK=mainnet/);
  assert.match(md, /not launched/i);
  assert.doesNotMatch(md, BANNED);
  assert.doesNotMatch(md, CYRILLIC);
  assert.ok(!md.includes("\r"), "LF");
});

test("SPEC.md and README.md name the network rules", () => {
  const spec = readFileSync("SPEC.md", "utf8");
  assert.match(spec, /MURKLE_NETWORK/);
  assert.match(spec, /murk1/);
  assert.match(spec, /murkle\/mainnet\/spend/);
  assert.match(spec, /ticker bytes must be 1-16 of A-Z0-9/);
  assert.match(spec, /## 16\. Chain data and header verification/);
  assert.match(spec, /pins\.mainnet\.json/);
  const readme = readFileSync("README.md", "utf8");
  assert.match(readme, /MURKLE_NETWORK/);
  assert.match(readme, /docs\/MAINNET\.md/);
  assert.match(readme, /docs\/CEREMONY\.md/);
  assert.match(readme, /docs\/OPERATIONS\.md/);
  for (const doc of [spec, readme]) assert.doesNotMatch(doc, /live on mainnet|mainnet-ready/i);
});

test("my files keep their line endings, are English only, and pins.mainnet.json is LF", () => {
  const crlf = ["src/indexer.mjs", "src/envelope.mjs", "src/keys.mjs", "src/store-node.mjs", "bin/murkle.mjs", "web/src/config.js", "web/src/session.js", "web/src/app.js", "web/src/ui/components.js", "web/src/share/launch-card.js"];
  const lf = ["src/params.mjs", "src/pins.json", "src/pins.mainnet.json", "src/wallet.mjs", "src/btc/funding.mjs", "server/indexer-server.mjs", "server/relayer.mjs", "web/vite.config.mjs", "web/src/payers.js", "web/src/api.js", "web/src/keystore.js", "web/src/ui/status.js", "web/src/ui/transcript.js", "test/network.test.mjs", "SPEC.md", "README.md", "docs/MAINNET.md", "docs/API.md"];
  for (const f of [...crlf, ...lf]) {
    const b = readFileSync(f, "utf8");
    const lines = b.split("\n").length - 1;
    const crlfs = b.split("\r\n").length - 1;
    if (crlf.includes(f)) assert.equal(crlfs, lines, `${f}: CRLF`);
    else assert.equal(crlfs, 0, `${f}: LF`);
    assert.ok(!CYRILLIC.test(b), `${f}: English only`);
  }
});

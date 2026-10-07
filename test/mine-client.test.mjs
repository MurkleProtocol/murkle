// Mining, client track (docs/design/mining-contract.md §8, mining.md §13.2): claim drafts and
// envelopes in the wallet, the separate mining fee key, claim carriers and "prepare coins", the
// Proof X-ray engine on MINE / MINE_SCRIPT / DEPLOY_POW, and the browser verifier's Argon2id
// worker, difficulty source and replay key.
//
// The chain is synthetic (real signed transactions, fake blocks with valid headers, a fake
// Esplora over fetch). Proofs are real Groth16 against build/dev; the work is real Argon2id
// (src/mine.mjs) ground at the protocol floor of 256. The indexer here runs with mining off
// (unscheduled; its blocks lie above the pinned height): the verifier engine is fed its own
// claims' verdicts explicitly.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import * as snarkjs from "snarkjs";
import { deriveKeys, feeKeysOf, tryDecryptNote } from "../src/keys.mjs";
import { Wallet, claimLockUntil } from "../src/wallet.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { OP, decodeEnvelope, encodeDeploy, encodeDeployPow, envelopeLen, opReturnScript, scriptHashOf } from "../src/envelope.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { Esplora } from "../src/btc/esplora.mjs";
import { MINE_VSIZE, btcAccount, carrierAmountOf, dustLimit, feeOf, mineCarrierVsize, planCarrierTx, planSplitTx, signLocal } from "../src/btc/funding.mjs";
import { toField } from "../src/core.mjs";
import { concat, hex, outpointOf, u32le, unhex } from "../src/bytes.mjs";
import { DIGEST_V, D_MAX, LABELS, MINE_FEE, MINE_WINDOW, MINING_HEIGHT, MIN_DIFFICULTY } from "../src/params.mjs";
import * as mining from "../src/mine.mjs";
import { verifyTx, planSteps, classifyReason, headerFields, OP_MINE, OP_MINE_SCRIPT, OP_DEPLOY_POW } from "../src/verify-tx.mjs";

// Web modules import JSON without attributes and CSS (Vite handles both); teach Node the same.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (url.endsWith(".json") && !context.importAttributes?.type) return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
    return nextLoad(url, context);
  },
});

// A minimal IndexedDB for web/src/verify/idb.js (saved replays).
const idbData = new Map();
globalThis.indexedDB = {
  open() {
    const db = {
      transaction() {
        const t = {};
        const done = (result) => {
          setTimeout(() => t.oncomplete?.());
          return { result };
        };
        t.objectStore = () => ({
          get: (k) => done(idbData.has(k) ? structuredClone(idbData.get(k)) : undefined),
          put: (v, k) => (idbData.set(k, structuredClone(v)), done(k)),
          delete: (k) => (idbData.delete(k), done(undefined)),
        });
        return t;
      },
    };
    const req = {};
    setTimeout(() => {
      req.result = db;
      req.onsuccess?.();
    });
    return req;
  },
};

const VKEY_BYTES = new Uint8Array(readFileSync("build/dev/verification_key.json"));
const VKEY = JSON.parse(new TextDecoder().decode(VKEY_BYTES));
const BASE = "https://esplora.invalid/api";
const START = 400000;
const PRICE = 1000n;
const MINT_AMOUNT = 500n;
const REWARD = 1000n;
const FLOOR = MIN_DIFFICULTY; // 256: the work is ground for real at the protocol floor
const ACTIVE = [{ name: "mining", height: START, digestV: 2 }];
const OFF = [{ name: "mining", height: null, digestV: 2 }]; // mining unscheduled
const PLATFORM = unhex(MINE_FEE.platformScript);

const dsha = (b) => sha256(sha256(b));
const rev = (b) => Uint8Array.from(b).reverse();
const randTxid = () => randomBytes(32).toString("hex");
const stepOf = (r, id) => r.steps.find((s) => s.id === id);
const failedAt = (r) => r.steps.find((s) => s.status === "fail")?.id ?? null;
const dump = (r) => JSON.stringify(r.steps.map((s) => [s.id, s.status, s.fault, s.detail]), null, 1);

/* ---------- a tiny fake chain (as in verify-tx.test.mjs) ---------- */

const idx = new Indexer({ vkey: VKEY, startHeight: START, activations: OFF });
const served = new Map(); // txid -> hex
const where = new Map(); // txid -> { height, hash, pos }
const blocks = []; // { height, hash, header, hashes (internal order) }
const hashAt = new Map(); // height -> display hash
const applied = []; // every block as applied, for a second (mining) indexer
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
  const block = blocks.find((b) => b.height === w.height);
  const levels = merkleLevels(block.hashes);
  const merkle = [];
  let i = w.pos;
  for (const l of levels.slice(0, -1)) {
    merkle.push(hex(rev(l[i ^ 1] ?? l[i])));
    i = Math.floor(i / 2);
  }
  return { block_height: w.height, merkle, pos: w.pos };
}

/** Mines `txs` ([{ hex, txid }]) after a dummy coinbase into the fake chain and the indexer. */
async function mine(txs = []) {
  const height = idx.height + 1;
  const coinbase = randTxid();
  const ids = [coinbase, ...txs.map((t) => t.txid)];
  const hashes = ids.map((id) => rev(unhex(id)));
  const root = merkleLevels(hashes).at(-1)[0];
  let header;
  for (let nonce = 0; ; nonce++) {
    header = concat(u32le(0x20000000), prevHash, root, u32le(1_700_000_000 + height), u32le(0x207fffff), u32le(nonce));
    if (headerFields(header).meetsTarget) break;
  }
  const hash = hex(rev(dsha(header)));
  prevHash = dsha(header);
  blocks.push({ height, hash, header: hex(header), hashes });
  hashAt.set(height, hash);
  txs.forEach((t, k) => {
    served.set(t.txid, t.hex);
    where.set(t.txid, { height, hash, pos: k + 1 });
  });
  const block = { height, hash, txs: [{ txid: coinbase, inputs: [], outputs: [] }, ...txs.map((t) => parseRawTx(t.hex, t.txid))] };
  applied.push(block);
  await idx.applyBlock(block);
  return hash;
}

function chainFetch(path) {
  const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const nf = () => new Response("Not found", { status: 404 });
  let m;
  if (path === "/blocks/tip/height") return new Response(String(idx.height));
  if ((m = path.match(/^\/block-height\/(\d+)$/))) return hashAt.has(Number(m[1])) ? new Response(hashAt.get(Number(m[1]))) : nf();
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/hex$/))) return served.has(m[1]) ? new Response(served.get(m[1])) : nf();
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/status$/))) {
    const w = where.get(m[1]);
    if (w) return json({ confirmed: true, block_height: w.height, block_hash: w.hash, block_time: 1_700_000_000 });
    return served.has(m[1]) ? json({ confirmed: false }) : nf();
  }
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/merkle-proof$/))) return where.has(m[1]) ? json(proofFor(m[1])) : nf();
  if ((m = path.match(/^\/block\/([0-9a-f]{64})\/header$/))) {
    const b = blocks.find((x) => x.hash === m[1]);
    return b ? new Response(b.header) : nf();
  }
  return nf();
}

let web = () => new Response("{}", { status: 404 });
const realFetch = globalThis.fetch;

/* ---------- transactions ---------- */

const payerKey = randomBytes(32);
const payer = btcAccount(payerKey);
const funderKey = randomBytes(32);
const funder = btcAccount(funderKey);
const TREASURY = btcAccount(randomBytes(32)).script;
const utxo = (value = 100_000) => ({ txid: randTxid(), vout: 0, value });
const feeOut = (sats = MINE_FEE.platformSats) => [{ script: PLATFORM, amount: carrierAmountOf(PLATFORM, sats) }];

function carrier(envelope, { outputs = [], first = utxo(), key = payerKey, account = payer, feeRate = 1 } = {}) {
  const { tx } = planCarrierTx({ account, utxos: [first], envelope, outputs, feeRate, firstInput: first, sequence: 0xfffffffd });
  const signed = signLocal(tx, key);
  return { hex: signed.hex, txid: signed.txid, vsize: signed.vsize };
}

const alice = new Wallet(deriveKeys(randomBytes(32)));
const miner = new Wallet(deriveKeys(randomBytes(32)));
const T = {}; // named transactions and facts
const verdicts = new Map(); // txid -> the log entry a mining-aware indexer would write

/** Grinds a nonce for `challenge` at `difficulty` with the real Argon2id (src/mine.mjs). */
async function grind(challenge, difficulty = FLOOR) {
  const r = await mining.grindRange({ challenge, target: mining.targetOf(difficulty), nonceStart: BigInt(randomBytes(2).readUInt16LE()), count: 200_000 });
  assert.ok(r.nonce, "a nonce was found");
  return r;
}

const ctx = (over = {}) => ({
  esplora: new Esplora(BASE),
  vkeyBytes: async () => VKEY_BYTES,
  pinnedVkeySha256: hex(sha256(VKEY_BYTES)),
  genesisTxid: null,
  activations: ACTIVE,
  anchorRoot: async (h) => (idx.roots.has(h) ? { root: idx.roots.get(h), source: "YOU", kind: "replay", detail: "from your own replay" } : null),
  assetInfo: async (id) => (String(id) === String(T.minedAsset) ? { deployTxid: T.deployPow.txid, ticker: "DIGS", kind: "pow" } : String(id) === String(T.paidAsset) ? { deployTxid: T.deploy.txid, ticker: "PAID", kind: "mint" } : null),
  indexerVerdict: async (txid) => verdicts.get(txid) ?? idx.log.find((l) => l.txid === txid) ?? null,
  mineDifficulty: async () => ({ dEff: FLOOR, source: "YOU", detail: "computed by your own replay of the pool" }),
  ...over,
});

before(async () => {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(BASE)) return chainFetch(u.slice(BASE.length));
    return web(u, init);
  };

  // Block 1: a paid-mint DEPLOY at position 1 and a DEPLOY_POW at position 2. Mining is off in
  // this indexer, so it logs the DEPLOY_POW as an unknown op; the engine is given its asset.
  T.deploy = carrier(encodeDeploy({ ticker: "PAID", divisibility: 0, mintAmount: MINT_AMOUNT, mintCap: 10, priceSats: PRICE, treasury: TREASURY }));
  T.deployPowEnv = encodeDeployPow({
    ticker: "DIGS", divisibility: 0, reward: REWARD, maxSupply: 21_000_000n, span: 24, targetPerSpan: 24,
    initialDifficulty: FLOOR, minDifficulty: FLOOR,
  });
  T.deployPow = carrier(T.deployPowEnv);
  T.deployFee = carrier(encodeDeployPow({
    ticker: "FEED", divisibility: 0, reward: REWARD, maxSupply: 21_000_000n, span: 24, targetPerSpan: 24,
    initialDifficulty: FLOOR, minDifficulty: FLOOR, claimFeeSats: 1000n, treasury: TREASURY,
  }));
  await mine([T.deploy, T.deployPow, T.deployFee]);
  T.deployHeight = where.get(T.deploy.txid).height;
  T.paidAsset = assetIdOf(T.deployHeight, 1);
  T.minedAsset = assetIdOf(T.deployHeight, 2);
  T.mineStart = mining.mineStartOf({ startHeight: 0, deployHeight: T.deployHeight });
  assert.equal(T.mineStart, T.deployHeight, "starting now: mining opens at the deploy block itself");

  // Block 2: two paid MINTs to alice (notes to roll into claims).
  T.beforeMints = idx.height;
  for (const name of ["mintA", "mintB"]) {
    const bind = utxo();
    const env = await alice.mint(idx, { asset: T.paidAsset, mintAmount: MINT_AMOUNT, bindOutpoint: outpointOf(bind.txid, bind.vout) });
    T[name] = carrier(env, { outputs: [{ script: TREASURY, amount: PRICE }], first: bind });
  }
  await mine([T.mintA, T.mintB]);
  alice.scan(idx);
  assert.equal(alice.balance(T.paidAsset), 2n * MINT_AMOUNT, JSON.stringify(idx.log.map((l) => [l.opName, l.ok, l.reason])));

  // Mining opens at the deploy block itself; a few quiet blocks, so the reference block has
  // real blocks before it (the wrong-hash case below picks one of them).
  while (idx.height < T.mineStart + 8) await mine();
  T.ref = idx.height;

  // Claim A (MINE, bound to its first input) and claim B (MINE_SCRIPT, bound to the payer's script).
  T.draftA = miner.prepareClaim(idx, { asset: T.minedAsset, reward: REWARD, refHash: hashAt.get(T.ref) });
  T.workA = await grind(T.draftA.challenge);
  T.bindA = utxo();
  T.envA = await miner.finalizeClaim(T.draftA, { bindOutpoint: outpointOf(T.bindA.txid, T.bindA.vout) }, T.workA.nonce);
  T.claimA = carrier(T.envA, { outputs: feeOut(), first: T.bindA });

  T.funding = carrier(new Uint8Array([1, 2, 3]), { outputs: [{ script: payer.script, amount: 50_000n }], key: funderKey, account: funder });
  served.set(T.funding.txid, T.funding.hex);
  T.draftB = miner.prepareClaim(idx, { asset: T.minedAsset, reward: REWARD, refHash: hashAt.get(T.ref) });
  T.workB = await grind(T.draftB.challenge);
  T.envB = await miner.finalizeClaim(T.draftB, { bindScriptHash: scriptHashOf(payer.script) }, T.workB.nonce);
  // L5: the funding change takes a random slot after its OP_RETURN, so find the payer's output by script.
  const fundingVout = parseRawTx(T.funding.hex, T.funding.txid).outputs.findIndex((o, v) => v > 0 && hex(o.script) === hex(payer.script));
  assert.ok(fundingVout === 1 || fundingVout === 2);
  T.claimB = carrier(T.envB, { outputs: feeOut(), first: { txid: T.funding.txid, vout: fundingVout, value: 50_000 } });

  // The same claim A in carriers that break one rule each: no service fee, someone else's coin first.
  T.noFee = carrier(T.envA, { outputs: [], first: T.bindA });
  T.underFee = carrier(T.envA, { outputs: [{ script: PLATFORM, amount: 499n }], first: T.bindA });
  T.copy = carrier(T.envA, { outputs: feeOut() });
  await mine([T.claimA, T.claimB, T.noFee, T.underFee, T.copy]);
  T.claimHeight = idx.height;
  for (const [t, op, env] of [[T.claimA, OP_MINE, T.envA], [T.claimB, OP_MINE_SCRIPT, T.envB]]) {
    verdicts.set(t.txid, {
      txid: t.txid, height: T.claimHeight, op, opName: op === OP_MINE ? "MINE" : "MINE_SCRIPT", ok: true,
      asset: String(T.minedAsset), ticker: "DIGS", amount: String(REWARD), ref: T.ref, difficulty: String(FLOOR), env,
    });
  }
  verdicts.set(T.noFee.txid, { txid: T.noFee.txid, height: T.claimHeight, op: OP_MINE, ok: false, reason: `underpaid service fee: 0 < 500 sats to ${MINE_FEE.platformScript}` });
  verdicts.set(T.copy.txid, { txid: T.copy.txid, height: T.claimHeight, op: OP_MINE, ok: false, reason: "MINE not bound to this transaction" });

  // Claim A once more, mined 13 blocks after its reference block: outside the window.
  while (idx.height < T.ref + MINE_WINDOW) await mine();
  T.late = carrier(T.envA, { outputs: feeOut(), first: T.bindA, feeRate: 3 });
  await mine([T.late]);
  assert.equal(where.get(T.late.txid).height, T.ref + MINE_WINDOW + 1);
  verdicts.set(T.late.txid, { txid: T.late.txid, height: idx.height, op: OP_MINE, ok: false, reason: "reference outside window" });

  // In the mempool: claim A in a transaction no block contains yet.
  T.pending = carrier(T.envA, { outputs: feeOut(), first: T.bindA, feeRate: 2 });
  served.set(T.pending.txid, T.pending.hex);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

/* ---------- keys ---------- */

test("feeKeysOf: the transfer fee key is today's derivation, the mining fee key is separate", () => {
  for (const entropy of [randomBytes(16), randomBytes(32)]) {
    const { feeKey, mineFeeKey } = feeKeysOf(new Uint8Array(entropy));
    // Today's web derivation (web/src/session.js): hkdf(sha256, entropy, undefined, label("btc-fee"), 32).
    assert.equal(hex(feeKey), hex(hkdf(sha256, entropy, undefined, "murkle/btc-fee", 32)));
    assert.equal(hex(mineFeeKey), hex(hkdf(sha256, entropy, undefined, "murkle/btc-mine-fee", 32)));
    assert.notEqual(hex(feeKey), hex(mineFeeKey));
    assert.equal(feeKey.length, 32);
    assert.equal(mineFeeKey.length, 32);
    assert.deepEqual(feeKeysOf(new Uint8Array(entropy)), { feeKey, mineFeeKey }, "deterministic");
    assert.notEqual(btcAccount(feeKey).address, btcAccount(mineFeeKey).address, "claims and transfers never share an address");
  }
  assert.equal(LABELS.btcFee, "murkle/btc-fee");
  assert.equal(LABELS.btcMineFee, "murkle/btc-mine-fee");
  assert.throws(() => feeKeysOf(new Uint8Array(8)), /at least 16 bytes/);
  assert.throws(() => feeKeysOf("not bytes"), /at least 16 bytes/);
});

/* ---------- funding ---------- */

test("mineCarrierVsize and MINE_VSIZE match real signed claim carriers", () => {
  assert.deepEqual({ ...MINE_VSIZE }, { bare: 598, change: 641, feeOutputAndChange: 684 });
  assert.ok(Object.isFrozen(MINE_VSIZE));
  assert.equal(mineCarrierVsize(), MINE_VSIZE.feeOutputAndChange);
  assert.equal(mineCarrierVsize({ feeOutputs: 0, change: false }), MINE_VSIZE.bare);
  assert.equal(mineCarrierVsize({ feeOutputs: 0 }), MINE_VSIZE.change);
  assert.equal(mineCarrierVsize({ feeOutputs: 2 }), 727);
  assert.equal(mineCarrierVsize({ inputs: 2 }), 742);
  assert.throws(() => mineCarrierVsize({ inputs: 0 }), RangeError);
  assert.throws(() => mineCarrierVsize({ feeOutputs: -1 }), RangeError);
  assert.equal(envelopeLen(OP.MINE), 515);
  assert.equal(envelopeLen(OP.MINE_SCRIPT), 511);

  // A 515-byte MINE envelope, one P2TR input, the platform fee output and change.
  const env = new Uint8Array(515).fill(7);
  const first = utxo(50_000);
  const withFee = signLocal(planCarrierTx({ account: payer, utxos: [first], envelope: env, outputs: feeOut(), feeRate: 1, firstInput: first, sequence: 0xfffffffd }).tx, payerKey);
  assert.equal(withFee.vsize, MINE_VSIZE.feeOutputAndChange);
  const noFee = signLocal(planCarrierTx({ account: payer, utxos: [first], envelope: env, outputs: [], feeRate: 1, firstInput: first }).tx, payerKey);
  assert.equal(noFee.vsize, MINE_VSIZE.change);
  // MINE_SCRIPT is 4 vB smaller: quotes using the MINE size never undercharge it.
  const script = signLocal(planCarrierTx({ account: payer, utxos: [first], envelope: new Uint8Array(511), outputs: feeOut(), feeRate: 1 }).tx, payerKey);
  assert.equal(script.vsize, MINE_VSIZE.feeOutputAndChange - 4);
  assert.ok(T.claimA.vsize <= MINE_VSIZE.feeOutputAndChange && T.claimB.vsize <= MINE_VSIZE.feeOutputAndChange);
});

test("carrierAmountOf raises a fee output to its script's dust limit, never lowers it", () => {
  const p2pkh = unhex(`76a914${"11".repeat(20)}88ac`);
  const p2wpkh = unhex(`0014${"22".repeat(20)}`);
  assert.equal(carrierAmountOf(PLATFORM, 500n), 500n, "the platform fee (500) clears the P2TR dust limit (330)");
  assert.equal(carrierAmountOf(MINE_FEE.platformScript, 500), 500n, "hex scripts and numbers work too");
  assert.equal(carrierAmountOf(PLATFORM, 100n), dustLimit(PLATFORM));
  assert.equal(carrierAmountOf(p2pkh, 500n), 546n);
  assert.equal(carrierAmountOf(p2wpkh, 200n), 294n);
  assert.equal(carrierAmountOf(p2wpkh, 10_000n), 10_000n);
  assert.equal(carrierAmountOf(PLATFORM, 0n), 330n);
  assert.equal(typeof carrierAmountOf(PLATFORM, 1), "bigint");
  assert.throws(() => carrierAmountOf(PLATFORM, -1n), RangeError);
  assert.throws(() => carrierAmountOf(42, 500n), TypeError);
  // Every fee output requiredFeeOutputs asks for, at its carrier amount, satisfies the fee rule.
  const asset = { claimFeeSats: 0n, treasury: new Uint8Array() };
  const req = mining.requiredFeeOutputs(asset);
  assert.deepEqual(req.map((g) => [hex(g.script), g.sats, g.role]), [[MINE_FEE.platformScript, 500n, "platform"]]);
  const outputs = req.map((g) => ({ script: g.script, value: carrierAmountOf(g.script, g.sats) }));
  assert.equal(mining.feeOutputsPaid(asset, { outputs }).ok, true);
});

test("planSplitTx prepares N equal coins for the mining key, plus change", () => {
  const key = randomBytes(32);
  const account = btcAccount(key);
  const coins = [utxo(30_000), utxo(20_000)];
  const { tx, fee, change, changeIndex, inputs } = planSplitTx({ account, utxos: coins, n: 5, value: 5_000, feeRate: 2 });
  assert.equal(tx.outputsLength, 6);
  // L5: the change takes a random slot among the outputs.
  assert.ok(Number.isInteger(changeIndex) && changeIndex >= 0 && changeIndex <= 5);
  for (let i = 0; i < 6; i++) {
    if (i !== changeIndex) assert.equal(tx.getOutput(i).amount, 5_000n);
    assert.equal(hex(tx.getOutput(i).script), hex(account.script), "every coin pays the mining key itself");
  }
  assert.equal(tx.getOutput(changeIndex).amount, change);
  assert.equal(inputs.length, 1, "the largest coin covers it");
  assert.equal(BigInt(feeOf(tx)), fee);
  assert.equal(30_000n - 25_000n - fee, change);
  const signed = signLocal(tx, key);
  assert.ok(Number(fee) >= 2 * signed.vsize, "the fee covers the rate");

  // Both coins when one is not enough; refusals before anything is built.
  assert.equal(planSplitTx({ account, utxos: coins, n: 8, value: 5_000, feeRate: 1 }).inputs.length, 2);
  assert.throws(() => planSplitTx({ account, utxos: coins, n: 20, value: 5_000, feeRate: 1 }), /not enough BTC/);
  assert.throws(() => planSplitTx({ account, utxos: coins, n: 2, value: 100, feeRate: 1 }), /dust limit/);
  assert.throws(() => planSplitTx({ account, utxos: coins, n: 0, value: 5_000, feeRate: 1 }), RangeError);
  assert.throws(() => planSplitTx({ account, utxos: coins, n: 1.5, value: 5_000, feeRate: 1 }), RangeError);
});

/* ---------- wallet: claim drafts ---------- */

test("prepareClaim: one output is the reward (plus rolled notes) to self, the other padding, in a random order (L4); the challenge commits to them", () => {
  const ref = idx.height;
  const d = alice.prepareClaim(idx, { asset: T.paidAsset, reward: 7n, refHash: hashAt.get(ref) });
  assert.deepEqual(Object.keys(d), ["asset", "reward", "refHeight", "refHash", "rolled", "rolledAmount", "nullifiers", "commitments", "ciphertexts", "challenge"]);
  assert.equal(d.refHeight, ref);
  assert.equal(d.refHash, hashAt.get(ref));
  assert.equal(d.rolledAmount, 2n * MINT_AMOUNT, "both notes of the asset are rolled in");
  assert.deepEqual(new Set(d.rolled), new Set(alice.notes.filter((n) => n.asset === T.paidAsset).map((n) => String(n.nullifier))));
  assert.deepEqual(new Set(d.nullifiers.map(String)), new Set(d.rolled), "the rolled notes are the inputs");
  const opened = [0, 1].map((o) => tryDecryptNote(d.ciphertexts[o], alice.keys, d.commitments[o]));
  const own = opened.findIndex((n) => n);
  assert.ok(own === 0 || own === 1);
  const mine0 = opened[own];
  assert.deepEqual(mine0 && { asset: mine0.asset, amount: mine0.amount }, { asset: T.paidAsset, amount: 2n * MINT_AMOUNT + 7n });
  assert.equal(opened[1 - own], null, "the other output is padding to a throwaway key");
  assert.equal(hex(d.challenge), hex(mining.challengeOf({ asset: T.paidAsset, refHeight: ref, refHash: hashAt.get(ref), reward: 7n, commitments: d.commitments })));
  // The circuit input stays private: not enumerable, not in JSON, not under a guessable name.
  assert.equal(JSON.stringify(Object.keys(d)).includes("input"), false);
  assert.equal("input" in d || "circuitInput" in d, false);
  assert.equal(Object.getOwnPropertySymbols(d).every((s) => !Object.getOwnPropertyDescriptor(d, s).enumerable), true);

  // Bytes for the hash, roll: false, an older reference block (before the notes existed).
  const plain = alice.prepareClaim(idx, { asset: T.paidAsset, reward: 7n, refHash: unhex(hashAt.get(ref)), roll: false });
  assert.deepEqual([plain.rolled, plain.rolledAmount], [[], 0n]);
  const old = alice.prepareClaim(idx, { asset: T.paidAsset, reward: 7n, refHeight: T.beforeMints, refHash: hashAt.get(T.beforeMints) });
  assert.deepEqual(old.rolled, [], "only notes in the tree at the reference block can be rolled");
  assert.equal(old.refHeight, T.beforeMints);

  assert.throws(() => alice.prepareClaim(idx, { asset: T.paidAsset, reward: 7n, refHash: "abc" }), /refHash/);
  assert.throws(() => alice.prepareClaim(idx, { asset: T.paidAsset, reward: 0n, refHash: hashAt.get(ref) }), RangeError);
  assert.throws(() => alice.prepareClaim(idx, { asset: T.paidAsset, reward: 7n, refHeight: ref + 1, refHash: hashAt.get(ref) }), /above the synced height/);
});

test("two drafts on one tip share no commitment or nullifier (fresh blindings, keys and dummies; W-M locks rolled notes)", async () => {
  const ref = idx.height;
  const opts = { asset: T.paidAsset, reward: 7n, refHash: hashAt.get(ref), roll: false };
  const a = miner.prepareClaim(idx, opts);
  const b = miner.prepareClaim(idx, opts);
  const all = (d) => [...d.commitments, ...d.nullifiers].map(String);
  assert.equal(new Set([...all(a), ...all(b)]).size, 8, "dummy inputs and outputs are all fresh");
  assert.notEqual(hex(a.challenge), hex(b.challenge));
  assert.notEqual(hex(a.ciphertexts[0]), hex(b.ciphertexts[0]));
  assert.notEqual(hex(a.ciphertexts[0].slice(0, 32)), hex(b.ciphertexts[0].slice(0, 32)), "fresh ephemeral keys");

  // With rolled notes, the W-M lock is what keeps a second claim off the first one's notes.
  const r1 = alice.prepareClaim(idx, { ...opts, roll: true });
  const unlocked = alice.prepareClaim(idx, { ...opts, roll: true });
  assert.deepEqual(unlocked.rolled, r1.rolled, "without the lock the same notes would be picked");
  alice.lockClaim(r1);
  assert.equal(alice.spendable(T.paidAsset).length, 0, "locked notes are not spendable");
  const r2 = alice.prepareClaim(idx, { ...opts, roll: true });
  assert.deepEqual(r2.rolled, []);
  assert.equal(new Set([...all(r1), ...all(r2)]).size, 8, "no shared commitment or nullifier");
  await assert.rejects(alice.transfer(idx, { asset: T.paidAsset, amount: 1n, to: miner.address }), /insufficient balance/, "a transfer can't spend them either");
  alice.unlockClaim(r1);
  assert.equal(alice.spendable(T.paidAsset).length, 2, "released when the claim expires or is dropped");
  assert.equal(claimLockUntil(1000), 1000 + MINE_WINDOW);
  assert.equal(claimLockUntil(T.ref), T.ref + 12);
});

test("finalizeClaim: MINE (515) and MINE_SCRIPT (511) from one draft keep the solutionId; both proofs verify with rolled inputs", async () => {
  const ref = idx.height;
  const draft = alice.prepareClaim(idx, { asset: T.paidAsset, reward: 7n, refHash: hashAt.get(ref) });
  assert.equal(draft.rolled.length, 2);
  const nonce = randomBytes(8);
  const bindOutpoint = outpointOf(randTxid(), 1);
  const bindScriptHash = scriptHashOf(payer.script);
  const e1 = await alice.finalizeClaim(draft, { bindOutpoint }, new Uint8Array(nonce));
  const e2 = await alice.finalizeClaim(draft, { bindScriptHash }, nonce.toString("hex"));
  assert.equal(e1.length, 515);
  assert.equal(e2.length, 511);
  const d1 = decodeEnvelope(e1);
  const d2 = decodeEnvelope(e2);
  assert.deepEqual([d1.op, d2.op], [OP.MINE, OP.MINE_SCRIPT]);
  assert.equal(hex(d1.bindOutpoint), hex(bindOutpoint));
  assert.equal(hex(d2.bindScriptHash), hex(bindScriptHash));
  const ids = [];
  for (const d of [d1, d2]) {
    assert.equal(d.anchor, ref);
    assert.equal(d.publicAsset, T.paidAsset);
    assert.equal(d.publicAmount, 7n);
    assert.equal(hex(d.nonce), nonce.toString("hex"));
    assert.deepEqual(d.commitments, draft.commitments);
    assert.deepEqual(d.nullifiers, draft.nullifiers);
    const c = mining.claimPreimage({ asset: d.publicAsset, refHeight: d.anchor, refHash: hashAt.get(ref), reward: d.publicAmount, commitments: d.commitments, nonce: d.nonce });
    assert.equal(hex(c.challenge), hex(draft.challenge));
    ids.push(c.solutionIdHex);
    const signals = [idx.roots.get(ref), toField(d.publicAmount), d.publicAsset, d.extDataHash, ...d.nullifiers, ...d.commitments].map(String);
    const { decodeProof } = await import("../src/proof-codec.mjs");
    assert.equal(await snarkjs.groth16.verify(VKEY, signals, decodeProof(d.proof)), true, `op ${d.op}: the proof verifies against R[ref]`);
  }
  assert.equal(ids[0], ids[1], "one solution, one solutionId, however it is bound");
  assert.notEqual(d1.extDataHash, d2.extDataHash, "the proof binds the bind");

  await assert.rejects(alice.finalizeClaim(draft, { bindOutpoint, bindScriptHash }, nonce), /exactly one bind/);
  await assert.rejects(alice.finalizeClaim(draft, {}, nonce), /exactly one bind/);
  await assert.rejects(alice.finalizeClaim(draft, { bindOutpoint }, new Uint8Array(7)), /8 bytes/);
  await assert.rejects(alice.finalizeClaim({ ...draft }, { bindOutpoint }, nonce), /not a claim draft/, "a copied draft has no circuit input");
});

/* ---------- Proof X-ray on mining ---------- */

test("planSteps: MINE / MINE_SCRIPT / DEPLOY_POW rows and their stable ids", () => {
  const head = ["fetch", "txid", "status", "inclusion", "envelope"];
  const mine = [...head, "extdata", "points", "vkey", "terms", "window", "refhash", "work", "difficulty", "bound", "fees", "root", "groth16", "indexer"];
  assert.deepEqual(planSteps("MINE").map((s) => s.id), mine);
  assert.deepEqual(planSteps("MINE_SCRIPT").map((s) => s.id), mine);
  assert.deepEqual(planSteps("DEPLOY_POW").map((s) => s.id), [...head, "deploy", "indexer"]);
  const row = (op, id) => planSteps(op).find((s) => s.id === id);
  assert.deepEqual(row("MINE", "terms"), { id: "terms", label: "Mining terms read from the deploy transaction", source: "BTC" });
  assert.deepEqual(row("MINE", "window"), { id: "window", label: "Reference block inside the 12-block window", source: "YOU" });
  assert.deepEqual(row("MINE", "refhash"), { id: "refhash", label: "Reference block hash", source: "BTC" });
  assert.deepEqual(row("MINE", "work"), { id: "work", label: "Work recomputed (Argon2id)", source: "YOU" });
  assert.deepEqual(row("MINE", "difficulty"), { id: "difficulty", label: "Difficulty the work must meet", source: "IDX" });
  assert.deepEqual(row("MINE", "bound"), { id: "bound", label: "First input is the bound coin", source: "BTC" });
  assert.deepEqual(row("MINE_SCRIPT", "bound"), { id: "bound", label: "Spends from the bound address", source: "BTC" });
  assert.deepEqual(row("MINE", "fees"), { id: "fees", label: "Service fee paid in this transaction", source: "BTC" });
  assert.deepEqual(row("DEPLOY_POW", "deploy"), { id: "deploy", label: "Terms valid", source: "YOU" });
  // Unchanged plans.
  assert.deepEqual(planSteps("MINT").map((s) => s.id), [...head, "extdata", "points", "vkey", "terms", "bound", "treasury", "root", "groth16", "indexer"]);
  assert.deepEqual(planSteps("TRANSFER").map((s) => s.id), [...head, "extdata", "points", "vkey", "root", "groth16", "indexer"]);
  assert.deepEqual([OP_MINE, OP_MINE_SCRIPT, OP_DEPLOY_POW], [OP.MINE, OP.MINE_SCRIPT, OP.DEPLOY_POW], "the engine's op numbers are the envelope's");
});

test("classifyReason: the mining rules this engine checks itself", () => {
  for (const r of [
    "insufficient work", "reference outside window", `underpaid service fee: 0 < 500 sats to ${MINE_FEE.platformScript}`,
    "MINE not bound to this transaction", "MINE not bound to this payer", "reward differs from terms",
    "mining not started", "mining closed", "mining ended", "malformed: unknown op 7", "malformed: deployer claim fee not allowed",
  ]) assert.equal(classifyReason(r), "checked", r);
  for (const r of ["solution already claimed", "supply cap reached", "nullifier already spent", "unknown reference block", "ticker DIGS already deployed"]) {
    assert.equal(classifyReason(r), "history", r);
  }
});

test("a valid MINE carrier passes every row with real Argon2id, and agrees with the indexer", async () => {
  const seen = [];
  const r = await verifyTx(T.claimA.txid, ctx({ powHash: undefined, onStep: (s) => seen.push(s) }));
  assert.equal(r.verdict, "verified", dump(r));
  assert.deepEqual(r.steps.map((s) => s.id), planSteps("MINE").map((s) => s.id));
  for (const s of r.steps) assert.equal(s.status, "ok", `${s.id}: ${s.detail}`);
  assert.equal(r.opName, "MINE");
  assert.equal(r.powHash, hex(T.workA.powHash), "the browser recomputed the miner's hash");
  assert.equal(r.solutionId, mining.claimPreimage({ asset: T.minedAsset, refHeight: T.ref, refHash: hashAt.get(T.ref), reward: REWARD, commitments: T.draftA.commitments, nonce: T.workA.nonce }).solutionIdHex);
  assert.match(stepOf(r, "terms").detail, new RegExp(`DIGS · reward 1,000 at #${T.ref.toLocaleString("en-US")}.* position 2 · reward matches`));
  assert.match(stepOf(r, "window").detail, /1 block before inclusion · window 12/);
  assert.match(stepOf(r, "refhash").detail, /header hashes to it/);
  assert.match(stepOf(r, "work").detail, /Argon2id .* meets the token's minimum difficulty 256/);
  assert.equal(stepOf(r, "difficulty").source, "YOU", "D_eff from the user's own replay");
  assert.match(stepOf(r, "difficulty").detail, /D_eff 256/);
  assert.match(stepOf(r, "fees").label, /Service fee paid 500 sats/);
  assert.match(stepOf(r, "fees").detail, /500 sats to the platform address/);
  assert.equal(r.servicePaid, 500n);
  assert.match(stepOf(r, "root").detail, /window 12/);
  assert.match(stepOf(r, "groth16").detail, /^valid/);
  assert.match(stepOf(r, "indexer").detail, /Accepted .* agrees/);
  assert.equal(r.historyFrom, "IDX", "claimed solutions and the cap are history rules");
  assert.ok(seen.some((s) => s.id === "work" && s.status === "running"));

  // MINE_SCRIPT: the payer's script, read from the spent output's own transaction.
  const b = await verifyTx(T.claimB.txid, ctx());
  assert.equal(b.verdict, "verified", dump(b));
  assert.deepEqual(b.steps.map((s) => s.id), planSteps("MINE_SCRIPT").map((s) => s.id));
  assert.equal(stepOf(b, "bound").label, "Spends from the bound address");
  assert.equal(stepOf(b, "bound").status, "ok");
});

test("a wrong reference block hash fails the work as a rule (another hash, another challenge)", async () => {
  const missesFloor = async (refHash) => {
    const c = mining.claimPreimage({ asset: T.minedAsset, refHeight: T.ref, refHash, reward: REWARD, commitments: T.draftA.commitments, nonce: T.workA.nonce });
    return !mining.meetsTarget(await mining.powHash(c.password), mining.targetOf(FLOOR));
  };
  // A made-up hash: its header can't be served, a data problem caught before the work.
  const made = randTxid();
  const r = await verifyTx(T.claimA.txid, ctx({ blockHash: async () => made }));
  assert.equal(failedAt(r), "refhash", dump(r));
  assert.equal(stepOf(r, "refhash").fault, "data");

  // A real block's hash served for the wrong height (255 in 256 of them miss the floor): the
  // header checks out, and the work recomputed against it fails as a rule.
  let wrong = null;
  for (let h = T.ref - 1; h > START && !wrong; h--) if (await missesFloor(hashAt.get(h))) wrong = hashAt.get(h);
  const w = await verifyTx(T.claimA.txid, ctx({ blockHash: async () => wrong }));
  assert.equal(stepOf(w, "refhash").status, "ok");
  assert.equal(failedAt(w), "work", dump(w));
  assert.equal(stepOf(w, "work").fault, "rule");
  assert.match(stepOf(w, "work").detail, /insufficient work/);
  assert.equal(w.verdict, "mismatch", "an indexer that accepted it is contradicted");
  // A thrown Argon2 is never a verdict.
  const t = await verifyTx(T.claimA.txid, ctx({ powHash: async () => {
    throw new Error("wasm trap");
  } }));
  assert.equal(failedAt(t), "work");
  assert.equal(stepOf(t, "work").fault, "data");
  assert.equal(stepOf(t, "indexer").ok, null, "inconclusive, not a disagreement");
});

test("a missing or short service-fee output fails the fees row as a rule, and agrees with a rejecting indexer", async () => {
  const r = await verifyTx(T.noFee.txid, ctx());
  assert.equal(failedAt(r), "fees", dump(r));
  assert.equal(stepOf(r, "fees").fault, "rule");
  assert.match(stepOf(r, "fees").detail, /Pays 0 sats to the platform address .*the rule asks 500: underpaid service fee/);
  assert.equal(stepOf(r, "indexer").ok, true);
  assert.match(stepOf(r, "indexer").detail, /Agrees with your browser/);

  const u = await verifyTx(T.underFee.txid, ctx({ indexerVerdict: async (txid) => ({ txid, ok: true, height: T.claimHeight, difficulty: "256" }) }));
  assert.equal(failedAt(u), "fees");
  assert.match(stepOf(u, "fees").detail, /Pays 499 sats/);
  assert.equal(u.verdict, "mismatch", "an indexer that accepts an underpaid claim is called out");
});

test("a copied claim in someone else's transaction fails the bind; a claim landing after its window fails the window", async () => {
  const c = await verifyTx(T.copy.txid, ctx());
  assert.equal(failedAt(c), "bound", dump(c));
  assert.equal(stepOf(c, "bound").fault, "rule");
  assert.match(stepOf(c, "bound").detail, /A copied claim gets nothing/);
  assert.match(stepOf(c, "indexer").detail, /Agrees/);

  const l = await verifyTx(T.late.txid, ctx());
  assert.equal(failedAt(l), "window", dump(l));
  assert.equal(stepOf(l, "window").fault, "rule");
  assert.match(stepOf(l, "window").detail, /outside the window .*: reference outside window/);
  assert.match(stepOf(l, "indexer").detail, /Agrees/);
});

test("difficulty: from your replay (YOU), from the indexer's log (IDX), or none; a failing figure is judged by its source", async () => {
  // No ctx.mineDifficulty: the indexer's own log entry, labelled IDX.
  const idxOnly = await verifyTx(T.claimA.txid, ctx({ mineDifficulty: undefined }));
  assert.equal(idxOnly.verdict, "verified", dump(idxOnly));
  assert.equal(stepOf(idxOnly, "difficulty").source, "IDX");
  assert.match(stepOf(idxOnly, "difficulty").detail, /reported by our indexer's log/);

  // Your own replay's difficulty that the work misses: a rule broken.
  const own = await verifyTx(T.claimA.txid, ctx({ mineDifficulty: async () => ({ dEff: D_MAX, source: "YOU" }) }));
  assert.equal(failedAt(own), "difficulty", dump(own));
  assert.equal(stepOf(own, "difficulty").fault, "rule");
  assert.equal(own.verdict, "mismatch");

  // The indexer's own logged difficulty that the work misses: the indexer contradicts itself.
  const lying = await verifyTx(T.claimA.txid, ctx({ mineDifficulty: async () => ({ dEff: D_MAX, source: "IDX" }) }));
  assert.equal(failedAt(lying), "difficulty");
  assert.equal(stepOf(lying, "difficulty").fault, "data");
  assert.equal(lying.verdict, "mismatch");
  assert.match(stepOf(lying, "indexer").detail, /does not meet the difficulty this same indexer logged/);

  // A figure below the token's floor is no usable figure.
  const low = await verifyTx(T.claimA.txid, ctx({ mineDifficulty: async () => ({ dEff: 1n, source: "IDX" }) }));
  assert.equal(failedAt(low), "difficulty");
  assert.equal(stepOf(low, "difficulty").fault, "data");

  // A rejection for insufficient work with no difficulty this browser computed: not called a lie.
  const rejected = await verifyTx(T.claimA.txid, ctx({
    mineDifficulty: async () => null,
    indexerVerdict: async (txid) => ({ txid, ok: false, height: T.claimHeight, reason: "insufficient work" }),
  }));
  assert.equal(stepOf(rejected, "difficulty").status, "skip");
  assert.equal(stepOf(rejected, "indexer").ok, null, dump(rejected));
  assert.equal(rejected.verdict, "rejected");
  // ... but with your own replay's D_eff met, that rejection is a disagreement.
  const contra = await verifyTx(T.claimA.txid, ctx({ indexerVerdict: async (txid) => ({ txid, ok: false, height: T.claimHeight, reason: "insufficient work" }) }));
  assert.equal(contra.verdict, "mismatch");
});

test("a claim in the mempool checks its proof, work and fee, and waits for a block for the window and difficulty", async () => {
  const r = await verifyTx(T.pending.txid, ctx());
  assert.equal(r.verdict, "mempool", dump(r));
  assert.equal(stepOf(r, "window").status, "skip");
  assert.match(stepOf(r, "window").detail, new RegExp(`must land by block #${(T.ref + 12).toLocaleString("en-US")}`));
  assert.equal(stepOf(r, "difficulty").status, "skip");
  for (const id of ["terms", "refhash", "work", "bound", "fees", "groth16"]) assert.equal(stepOf(r, id).status, "ok", id);
});

test("below the mining activation height, ops 7 - 9 are unknown ops, exactly as every replayer logs them", async () => {
  for (const activations of [OFF, [{ name: "mining", height: T.claimHeight + 1, digestV: 2 }]]) {
    const r = await verifyTx(T.claimA.txid, ctx({ activations, indexerVerdict: async (txid) => idx.log.find((l) => l.txid === txid) }));
    assert.equal(failedAt(r), "envelope", dump(r));
    assert.equal(stepOf(r, "envelope").fault, "rule");
    assert.match(stepOf(r, "envelope").detail, /unknown op 7/);
    assert.equal(r.opName, "UNKNOWN");
    // The indexer here (mining off) rejected it the same way.
    assert.equal(idx.log.find((l) => l.txid === T.claimA.txid).reason, "malformed: unknown op 7");
    assert.match(stepOf(r, "indexer").detail, /Agrees/);
  }
  const d = await verifyTx(T.deployPow.txid, ctx({ activations: OFF, indexerVerdict: async (txid) => idx.log.find((l) => l.txid === txid) }));
  assert.match(stepOf(d, "envelope").detail, /unknown op 9/);
  // Without a table the engine applies the pinned one (src/pins.json): these blocks lie above the
  // pinned height, so the mining rules apply and the envelope decodes as what it is.
  assert.ok(MINING_HEIGHT !== null && T.claimHeight >= MINING_HEIGHT, "the synthetic chain lies above the pinned height");
  const pinned = await verifyTx(T.claimA.txid, ctx({ activations: undefined }));
  assert.equal(stepOf(pinned, "envelope").status, "ok", dump(pinned));
  assert.equal(pinned.opName, "MINE");
});

test("DEPLOY_POW: terms valid under the fee policy; a deployer claim fee is refused", async () => {
  verdicts.set(T.deployPow.txid, { txid: T.deployPow.txid, height: T.deployHeight, op: OP_DEPLOY_POW, ok: true, ticker: "DIGS", asset: String(T.minedAsset) });
  const r = await verifyTx(T.deployPow.txid, ctx());
  assert.equal(r.verdict, "verified", dump(r));
  assert.deepEqual(r.steps.map((s) => s.id), planSteps("DEPLOY_POW").map((s) => s.id));
  assert.match(stepOf(r, "deploy").detail, new RegExp(`DIGS · 0 decimals · mined · 1,000 per claim · max supply 21,000,000 · 24 claims per 24 blocks · difficulty 256, floor 256 · mining from #${T.mineStart.toLocaleString("en-US")}`));
  assert.match(stepOf(r, "indexer").detail, /ticker was still free/);

  verdicts.set(T.deployFee.txid, { txid: T.deployFee.txid, height: T.deployHeight, op: OP_DEPLOY_POW, ok: false, reason: "malformed: deployer claim fee not allowed" });
  const f = await verifyTx(T.deployFee.txid, ctx());
  assert.equal(failedAt(f), "deploy");
  assert.equal(stepOf(f, "deploy").fault, "rule");
  assert.match(stepOf(f, "deploy").detail, /deployer claim fee not allowed/);
  assert.match(stepOf(f, "indexer").detail, /Agrees/);
});

test("MINE against a paid-mint asset fails its terms: asset is not mined", async () => {
  // A claim whose asset id names the paid DEPLOY: the deploy at that position is not a DEPLOY_POW.
  const draft = miner.prepareClaim(idx, { asset: T.paidAsset, reward: MINT_AMOUNT, refHeight: T.ref, refHash: hashAt.get(T.ref), roll: false });
  const bind = utxo();
  const env = await miner.finalizeClaim(draft, { bindOutpoint: outpointOf(bind.txid, bind.vout) }, new Uint8Array(8));
  const tx = carrier(env, { outputs: feeOut(), first: bind });
  served.set(tx.txid, tx.hex);
  const r = await verifyTx(tx.txid, ctx());
  assert.equal(failedAt(r), "terms", dump(r));
  assert.equal(stepOf(r, "terms").fault, "rule");
  assert.match(stepOf(r, "terms").detail, /asset is not mined/);

  // And the reverse: a MINT against the mined token (no premine by consensus).
  const mintBind = utxo();
  const mintEnv = await alice.mint(idx, { asset: T.minedAsset, mintAmount: REWARD, bindOutpoint: outpointOf(mintBind.txid, mintBind.vout) });
  const mintTx = carrier(mintEnv, { first: mintBind });
  served.set(mintTx.txid, mintTx.hex);
  const m = await verifyTx(mintTx.txid, ctx());
  assert.equal(failedAt(m), "terms", dump(m));
  assert.equal(stepOf(m, "terms").fault, "rule");
  assert.match(stepOf(m, "terms").detail, /asset is mined/);
});

test("with a mining indexer: the claims land, verifyTx agrees with its log, and a claim rolls the rewards into one note", { skip: typeof Indexer.prototype.checkMine !== "function" && "core's mining indexer has not landed" }, async () => {
  const idx2 = new Indexer({ vkey: VKEY, startHeight: START, activations: ACTIVE });
  idx2.prevoutScript = async (op) => parseRawTx(served.get(hex(rev(op.slice(0, 32)))), hex(rev(op.slice(0, 32)))).outputs[op[32]].script;
  const sync = async () => {
    for (const b of applied) if (b.height > idx2.height) await idx2.applyBlock(b);
  };
  await sync();
  const entry = (t) => idx2.log.find((l) => l.txid === t.txid);
  assert.equal(entry(T.claimA).ok, true, entry(T.claimA).reason);
  assert.equal(entry(T.claimB).ok, true, entry(T.claimB).reason);
  assert.equal(entry(T.claimA).difficulty, String(FLOOR));
  assert.match(entry(T.noFee).reason, /^underpaid service fee/);
  assert.match(entry(T.underFee).reason, /^(underpaid service fee|duplicate nullifier|nullifier already spent)/);
  assert.equal(entry(T.late).reason, "reference outside window");
  assert.equal(entry(T.deployFee).reason, "malformed: deployer claim fee not allowed");
  assert.equal(idx2.assets.get(T.minedAsset).issued, 2n * REWARD);

  // The engine against this indexer's own log and roots: D_eff from its log entry (IDX).
  const real = (over) => ctx({ anchorRoot: async (h) => ({ root: idx2.roots.get(h), source: "IDX", kind: "indexer" }), indexerVerdict: async (txid) => idx2.log.find((l) => l.txid === txid) ?? null, mineDifficulty: undefined, ...over });
  for (const t of [T.claimA, T.claimB]) {
    const r = await verifyTx(t.txid, real());
    assert.equal(r.verdict, "verified", dump(r));
    assert.equal(stepOf(r, "difficulty").source, "IDX");
  }
  for (const t of [T.noFee, T.copy, T.late]) assert.match(stepOf(await verifyTx(t.txid, real()), "indexer").detail, /Agrees/);

  // Roll both rewards into the next claim: issued grows by the reward only, the old notes are spent.
  miner.scan(idx2);
  assert.equal(miner.balance(T.minedAsset), 2n * REWARD);
  const ref = idx2.height;
  const draft = miner.prepareClaim(idx2, { asset: T.minedAsset, reward: REWARD, refHash: hashAt.get(ref) });
  assert.equal(draft.rolledAmount, 2n * REWARD);
  const dEff = idx2.effectiveDifficulty(T.minedAsset, ref, ref + 1);
  const work = await grind(draft.challenge, dEff);
  const bind = utxo();
  const env = await miner.finalizeClaim(draft, { bindOutpoint: outpointOf(bind.txid, bind.vout) }, work.nonce);
  miner.lockClaim(draft);
  const tx = carrier(env, { outputs: feeOut(), first: bind });
  await mine([tx]);
  await sync();
  assert.equal(entry(tx).ok, true, entry(tx).reason);
  assert.equal(idx2.assets.get(T.minedAsset).issued, 3n * REWARD, "issued grows by the reward only");
  for (const n of draft.rolled) assert.ok(idx2.nullifiers.has(n), "the rolled notes are spent");
  miner.unlockClaim(draft);
  miner.scan(idx2);
  assert.equal(miner.balance(T.minedAsset), 3n * REWARD);
  assert.equal(miner.spendable(T.minedAsset).length, 1, "one note however many claims landed");
  const r = await verifyTx(tx.txid, real());
  assert.equal(r.verdict, "verified", dump(r));
});

/* ---------- browser verifier ---------- */

test("the replay key carries DIGEST_V: saved replays of the v1 format restart once, and /verify can say why", async () => {
  const replay = await import("../web/src/verify/replay.js");
  const { ACTIVATION_HEIGHT, PRE_GENESIS, ESPLORA_API } = await import("../web/src/config.js");
  assert.equal(DIGEST_V, 2, "mining is digest v2");
  const start = 324_592;
  assert.match(replay.replayKey(start), /\.replay\.v2\./);
  assert.notEqual(replay.replayKey(start), replay.replayKey(start, 1));
  assert.match(replay.replayKey(start, 1), /\.replay\.v1\./);
  assert.equal(replay.REPLAY_RESTART_NOTE, "The verifier's digest format changed in this release; the replay starts over once.");

  const startHeight = PRE_GENESIS ? start : ACTIVATION_HEIGHT;
  web = (url) => {
    const u = new URL(url, "http://x");
    const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/state") return json({ height: start + 10, startHeight, protocol: "murkle" });
    if (u.href === `${ESPLORA_API}/blocks/tip/height`) return new Response(String(start + 10));
    if (u.href.startsWith(`${ESPLORA_API}/blocks/`)) return json([{ size: 1000 }]);
    return new Response("{}", { status: 404 });
  };
  try {
    idbData.clear();
    const fresh = await replay.replayPlan();
    assert.equal(fresh.formatChanged, undefined, "nothing saved, nothing to explain");
    idbData.set(replay.replayKey(startHeight, 1), { v: 1, snapshot: { height: start, startHeight }, spentBy: [] });
    const plan = await replay.replayPlan();
    assert.equal(plan.key, replay.replayKey(startHeight));
    assert.equal(plan.saved, null, "an old-format replay is never resumed");
    assert.equal(plan.formatChanged, true);
    assert.equal(plan.restartNote, replay.REPLAY_RESTART_NOTE);
    assert.deepEqual(plan.oldKeys, [replay.replayKey(startHeight, 1)]);
  } finally {
    web = () => new Response("{}", { status: 404 });
    idbData.clear();
  }
});

test("powHashInWorker: Argon2id in a Web Worker, never on the page; a failing worker rejects and is replaced", async () => {
  const engine = await import("../web/src/verify/engine.js");
  const password = mining.passwordOf(T.draftA.challenge, T.workA.nonce);
  // Node has no Web Worker: the page never falls back to its own thread.
  assert.equal(typeof globalThis.Worker, "undefined");
  await assert.rejects(engine.powHashInWorker(password), /Web Workers/);

  class FakeWorker {
    static made = [];
    static mode = "ok";
    constructor(url, opts) {
      this.url = String(url);
      this.opts = opts;
      this.posted = [];
      FakeWorker.made.push(this);
    }
    postMessage(m) {
      this.posted.push(m);
      setTimeout(async () => {
        if (FakeWorker.mode === "crash") return this.onerror?.({ message: "worker crashed", preventDefault() {} });
        if (FakeWorker.mode === "error") return this.onmessage?.({ data: { id: m.id, error: "self-test failed" } });
        if (FakeWorker.mode === "silent") return undefined;
        const h = await mining.powHash(unhex(m.password));
        this.onmessage?.({ data: { id: m.id, powHash: hex(h), impl: "hash-wasm" } });
      });
    }
    terminate() {
      this.dead = true;
    }
  }
  globalThis.Worker = FakeWorker;
  try {
    const h = await engine.powHashInWorker(password);
    assert.equal(hex(h), hex(T.workA.powHash));
    const w = FakeWorker.made[0];
    assert.match(w.url, /\/web\/src\/verify\/pow\.worker\.js$/);
    assert.deepEqual(w.opts, { type: "module" });
    assert.deepEqual(w.posted[0], { id: w.posted[0].id, password: hex(password) });
    await engine.powHashInWorker(password);
    assert.equal(FakeWorker.made.length, 1, "one worker serves every request");

    FakeWorker.mode = "error";
    await assert.rejects(engine.powHashInWorker(password), /self-test failed/);
    FakeWorker.mode = "crash";
    await assert.rejects(engine.powHashInWorker(password), /worker crashed/);
    assert.equal(FakeWorker.made[0].dead, true);
    FakeWorker.mode = "silent";
    await assert.rejects(engine.powHashInWorker(password, { timeoutMs: 30 }), /did not answer/);
    FakeWorker.mode = "ok";
    assert.equal(hex(await engine.powHashInWorker(password)), hex(T.workA.powHash));
    assert.equal(FakeWorker.made.length, 3, "a crashed or silent worker is replaced");
    await assert.rejects(engine.powHashInWorker(new Uint8Array(39)), /40 bytes/);

    // The page's ctx: the engine's Argon2id goes through the worker.
    const r = await verifyTx(T.claimA.txid, ctx({ powHash: (p) => engine.powHashInWorker(p) }));
    assert.equal(r.verdict, "verified", dump(r));
  } finally {
    delete globalThis.Worker;
  }
});

test("pow.worker.js answers { id, powHash } from src/mine.mjs, or { id, error }", async () => {
  const got = [];
  globalThis.self = { postMessage: (m) => got.push(m) };
  try {
    await import("../web/src/verify/pow.worker.js");
    const handler = globalThis.self.onmessage;
    const password = mining.passwordOf(T.draftA.challenge, T.workA.nonce);
    await handler({ data: { id: 7, password: hex(password) } });
    await handler({ data: { id: 8, password: "zz" } });
    assert.equal(got[0].id, 7);
    assert.equal(got[0].powHash, hex(T.workA.powHash));
    assert.ok(["hash-wasm", "noble"].includes(got[0].impl));
    assert.deepEqual(Object.keys(got[1]), ["id", "error"]);
    assert.equal(got[1].id, 8);
  } finally {
    delete globalThis.self;
  }
});

test("mineDifficulty: your own replay's entry first (YOU), else the public log entry (IDX), else null", async () => {
  const engine = await import("../web/src/verify/engine.js");
  const txid = T.claimA.txid;
  const entry = { txid, ok: true, height: T.claimHeight, difficulty: "300" };
  assert.deepEqual(await engine.mineDifficulty(T.minedAsset, T.ref, T.claimHeight, { txid, entry }), {
    dEff: 300n, source: "IDX", detail: "reported by our indexer's log; your browser didn't compute it (replay the pool to check it yourself)",
  });
  assert.equal(await engine.mineDifficulty(T.minedAsset, T.ref, T.claimHeight, { txid, entry: { ...entry, ok: false, difficulty: undefined } }), null);
  assert.equal(await engine.mineDifficulty(T.minedAsset, T.ref, T.claimHeight), null);
});

test("assetById returns rows with kind, mined tokens from /api/mine when the web API has it", async () => {
  const api = await import("../web/src/api.js");
  const { assetById } = await import("../web/src/verify/pool-data.js");
  const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  web = (url) => {
    const u = new URL(url, "http://x");
    if (u.pathname === "/api/assets") return json([{ id: "111", ticker: "PAID", deployTxid: "aa".repeat(32) }]);
    if (u.pathname === "/api/mine") return json({ activation: { height: null, active: false }, tip: { height: 1, hash: "00".repeat(32) }, assets: [{ asset: "222", kind: "pow", ticker: "DIGS", deployTxid: "bb".repeat(32), status: "mining" }] });
    return new Response("{}", { status: 404 });
  };
  try {
    const paid = await assetById("111");
    assert.equal(paid.kind, "mint");
    assert.equal(paid.ticker, "PAID");
    const mined = await assetById("222");
    if (typeof api.mine === "function") {
      assert.deepEqual([mined.id, mined.kind, mined.ticker, mined.deployTxid], ["222", "pow", "DIGS", "bb".repeat(32)]);
    } else {
      assert.equal(mined, null, "without api.mine (web track) only paid-mint rows are known");
    }
    assert.equal(await assetById("333"), null);
  } finally {
    web = () => new Response("{}", { status: 404 });
  }
});

test("the page verifiers pass a worker-backed powHash, the reference hash source and the difficulty source", () => {
  for (const f of ["web/src/verify/engine.js", "web/src/share/live-check.js"]) {
    const src = readFileSync(f, "utf8");
    assert.match(src, /powHash: \(password\) => powHashInWorker\(password\)/, f);
    assert.match(src, /blockHash: \(h\) => api\.esplora\.blockHash\(h\)/, f);
    assert.match(src, /mineDifficulty/, f);
    assert.doesNotMatch(src, /from "\.\.\/\.\.\/\.\.\/src\/mine\.mjs"/, `${f}: no Argon2 on the page's main thread`);
  }
  const worker = readFileSync("web/src/verify/replay.worker.js", "utf8");
  assert.match(worker, /claimsVerified/);
  assert.match(worker, /msPerClaim/);
  assert.doesNotMatch(readFileSync("web/src/verify/pow.worker.js", "utf8"), /[\u0400-\u04ff]/);
});

test("line endings and language of the client track's files", () => {
  const banned = new RegExp(`\\b(${["anony" + "mous", "untrace" + "able", "trust" + "less", "mix" + "er"].join("|")})\\b`, "i");
  const crlf = ["src/keys.mjs", "src/verify-tx.mjs", "web/src/share/live-check.js", "web/src/verify/replay.worker.js", "web/src/verify/engine.js"];
  const lf = ["src/wallet.mjs", "src/btc/funding.mjs", "web/src/verify/replay.js", "web/src/verify/pool-data.js", "web/src/verify/pow.worker.js", "test/mine-client.test.mjs"];
  for (const f of [...crlf, ...lf]) {
    const s = readFileSync(f, "utf8");
    const lines = (s.match(/\n/g) ?? []).length;
    const crs = (s.match(/\r\n/g) ?? []).length;
    if (crlf.includes(f)) assert.equal(crs, lines, `${f} is CRLF throughout`);
    else assert.equal(crs, 0, `${f} is LF`);
    assert.ok(s.endsWith("\n"), `${f} ends with a newline`);
    assert.doesNotMatch(s, /[\u0400-\u04ff]/, `${f}: English only`);
    if (!f.startsWith("test/")) assert.doesNotMatch(s, banned, `${f}: no banned words`);
  }
});

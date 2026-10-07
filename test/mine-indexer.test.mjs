// Mining consensus in the indexer (mining-contract.md §5-§7, §13 core): the v1 identity below
// activation, the envelope formats, the activation gate, DEPLOY_POW, every MINE rule in order,
// the per-block PoW memo and pre-pass, difficulty points, the journal, digest v2 and snapshots.
//
// Real Groth16 proofs and real Argon2 where the behaviour depends on them (a claim found by
// scan, rolled inputs, copies, re-proved solutions); elsewhere synthetic envelopes with a
// stubbed verifyGroth16 and an injected `pow` (mining-contract.md §1.3).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { EventEmitter } from "node:events";
import * as snarkjs from "snarkjs";
import { bn254 } from "@noble/curves/bn254";
import { sha256 } from "@noble/hashes/sha256";
import { x25519 } from "@noble/curves/ed25519";
import { deriveKeys, encryptNote, NOTE_CT_LEN } from "../src/keys.mjs";
import { Wallet, anchorAt } from "../src/wallet.mjs";
import { Indexer, assetIdOf, UNDO_DEPTH } from "../src/indexer.mjs";
import {
  DEPLOY_POW_MAX_LEN, DEPLOY_POW_MIN_LEN, MINING_OPS, NONCE_LEN, OP, OP_NAME, decodeEnvelope, encodeDeploy, encodeDeployPow,
  encodeTxBody, envelopeLen, extDataHashOf, findEnvelope, isMine, opReturnScript, scriptHashOf,
} from "../src/envelope.mjs";
import { encodeProof } from "../src/proof-codec.mjs";
import { buildTxInput, pubkeyOf, randomField, FIELD } from "../src/core.mjs";
import { parseBlock } from "../src/btc/block.mjs";
import { bigToBytes, concat, hex, u32le, u64le, unhex } from "../src/bytes.mjs";
import * as P from "../src/params.mjs";
import { ACTIVATION_HEIGHT, D_MAX, MINE_FEE, MINE_WINDOW, digestTag, LABELS } from "../src/params.mjs";
import * as M from "../src/mine.mjs";
import { PowPool } from "../src/pow-pool.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const ARTIFACTS = { wasm: "build/transaction_js/transaction.wasm", zkey: "build/dev/transaction.zkey" };
const PLATFORM = unhex(MINE_FEE.platformScript);
const NULL_OUTPOINT = concat(new Uint8Array(32), new Uint8Array([255, 255, 255, 255]));
const CYRILLIC = new RegExp(`[${String.fromCharCode(0x400)}-${String.fromCharCode(0x4ff)}]`);
const ZERO32 = new Uint8Array(32);
const G1 = (bn254.G1.ProjectivePoint ?? bn254.G1.Point).BASE.toAffine();
const G2 = (bn254.G2.ProjectivePoint ?? bn254.G2.Point).BASE.toAffine();
/** Canonical, on-curve proof points that do not verify: for envelopes whose Groth16 check is stubbed. */
const FAKE_PROOF = encodeProof({ pi_a: [G1.x, G1.y], pi_b: [[G2.x.c0, G2.x.c1], [G2.y.c0, G2.y.c1]], pi_c: [G1.x, G1.y] });

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const h32 = () => randomBytes(32).toString("hex");
const fee = (sats = 500n) => ({ script: PLATFORM, value: sats });
const coinbase = () => ({ txid: h32(), inputs: [{ outpoint: NULL_OUTPOINT }], outputs: [] });
const carrier = (envelope, extra = [], first = randomBytes(36)) => ({
  txid: h32(), inputs: [{ outpoint: Uint8Array.from(first) }], outputs: [{ script: opReturnScript(envelope), value: 0n }, ...extra],
});
const mining = (height) => [{ name: "mining", height, digestV: 2 }];
const verdictOf = (idx, tx) => idx.log.find((l) => l.txid === tx.txid);

/** Injected Argon2 backend: zero hashes (meet every target) unless forced; counts every evaluation. */
function ctlPow() {
  const pow = {
    forced: new Map(), hashCalls: 0, manyCalls: [], evaluated: 0,
    async hash(pw) { pow.hashCalls += 1; pow.evaluated += 1; return pow.forced.get(hex(pw)) ?? new Uint8Array(32); },
    async hashMany(pws) { pow.manyCalls.push(pws.length); pow.evaluated += pws.length; return pws.map((p) => pow.forced.get(hex(p)) ?? new Uint8Array(32)); },
  };
  return pow;
}

const powTerms = (o = {}) => ({
  ticker: "PMINE", divisibility: 0, reward: 1000n, maxSupply: 10n ** 12n, span: 24, targetPerSpan: 24,
  initialDifficulty: 256n, minDifficulty: 256n, ...o,
});

/**
 * A chain with mining active from START + 1, a DEPLOY_POW at START + 1 and every block up to
 * its mineStart applied, so the next block can carry claims.
 */
async function minedChain({ start = 900_000, activation, pow = ctlPow(), stub = true, terms = {}, vkey = VKEY } = {}) {
  const idx = new Indexer({ vkey, startHeight: start, activations: mining(activation ?? start + 1), pow });
  if (stub) idx.verifyGroth16 = async () => true;
  const blocks = [];
  const add = async (txs, { hash = h32() } = {}) => {
    const block = { height: idx.height + 1, ...(hash ? { hash } : {}), txs: [coinbase(), ...txs] };
    await idx.applyBlock(block);
    blocks.push(block);
    return block;
  };
  await add([]);
  const deploy = carrier(encodeDeployPow(powTerms(terms)));
  await add([deploy]);
  const asset = assetIdOf(start + 1, 1);
  const a = idx.assets.get(asset);
  while (idx.height < a.mineStart) await add([]);
  return { idx, asset, add, blocks, pow, deploy };
}

/** A synthetic MINE / MINE_SCRIPT envelope (FAKE_PROOF) with fresh fields unless given. */
function synthClaim(idx, asset, {
  op = OP.MINE, ref = idx.height, reward, nullifiers, commitments, nonce = randomBytes(8), bindOutpoint = randomBytes(36),
  bindScriptHash = randomBytes(32), proof = FAKE_PROOF,
} = {}) {
  const amount = reward ?? (idx.assets.get(asset) ? M.rewardAt(idx.assets.get(asset), ref) : 1000n);
  const body = encodeTxBody({
    op, anchor: ref, publicAsset: asset, publicAmount: amount, ...(op === OP.MINE ? { bindOutpoint } : { bindScriptHash }), nonce,
    nullifiers: nullifiers ?? [randomField(), randomField()], commitments: commitments ?? [randomField(), randomField()],
    ciphertexts: [randomBytes(NOTE_CT_LEN), randomBytes(NOTE_CT_LEN)],
  });
  const envelope = concat(body, proof);
  return { envelope, bindOutpoint, bindScriptHash, nonce, env: decodeEnvelope(envelope) };
}
/** The carrier of a synthetic MINE: first input = its bound outpoint, the platform fee paid. */
const claimTx = (c, { extra = [fee()], first } = {}) => carrier(c.envelope, extra, first ?? (c.env.op === OP.MINE ? c.bindOutpoint : randomBytes(36)));

// ---------------------------------------------------------------- real claims (client stand-in)

/**
 * A stand-in for the client track's prepareClaim / finalizeClaim (mining-contract.md §8.2):
 * up to two rolled notes, output 0 = rolled + reward to the wallet, output 1 zero padding.
 */
function prepareClaim(idx, wallet, { asset, reward, refHeight = idx.height, rolled = [], outs }) {
  const { tree } = anchorAt(idx, refHeight);
  const total = rolled.reduce((s, n) => s + n.amount, 0n);
  outs ??= [
    { amount: total + reward, pubkey: wallet.keys.pk, vpk: wallet.keys.vpk, blinding: randomField() },
    { amount: 0n, pubkey: pubkeyOf(randomField()), vpk: x25519.getPublicKey(x25519.utils.randomSecretKey()), blinding: randomField() },
  ];
  const input = buildTxInput({
    tree, asset, publicAmount: reward, publicAsset: asset, extDataHash: 0n,
    inputs: rolled.map((n) => ({ amount: n.amount, sk: wallet.keys.sk, blinding: n.blinding, leafIndex: n.leafIndex })),
    outputs: outs,
  });
  const commitments = input.outputCommitment.map(BigInt);
  const ciphertexts = outs.map((o, i) => encryptNote({ asset, amount: o.amount, blinding: o.blinding, vpk: o.vpk, commitment: commitments[i] }));
  const challenge = M.challengeOf({ asset, refHeight, refHash: idx.hashes.get(refHeight), reward, commitments });
  return { asset, reward, refHeight, input, outs, commitments, ciphertexts, nullifiers: input.inputNullifier.map(BigInt), challenge };
}
async function finalizeClaim(draft, bind, nonce) {
  const body = encodeTxBody({
    op: bind.bindOutpoint ? OP.MINE : OP.MINE_SCRIPT, anchor: draft.refHeight, publicAsset: draft.asset, publicAmount: draft.reward,
    ...bind, nonce, nullifiers: draft.nullifiers, commitments: draft.commitments, ciphertexts: draft.ciphertexts,
  });
  const { proof } = await snarkjs.groth16.fullProve({ ...draft.input, extDataHash: extDataHashOf(body).toString() }, ARTIFACTS.wasm, ARTIFACTS.zkey);
  return concat(body, encodeProof(proof));
}
/** Grinds a nonce for the draft at the difficulty that applies at the next block (real Argon2 unless `hash`). */
async function solve(idx, draft, { hash } = {}) {
  const dEff = idx.effectiveDifficulty(draft.asset, draft.refHeight, idx.height + 1);
  const r = await M.grindRange({ challenge: draft.challenge, target: M.targetOf(dEff), nonceStart: BigInt("0x" + h32().slice(0, 15)), count: 1_000_000, ...(hash ? { hash } : {}) });
  assert.ok(r.nonce, "a solution");
  return r.nonce;
}

/** Everything a rollback must restore, in comparable form. */
const fingerprint = (idx) => ({
  height: idx.height,
  digests: [...idx.digests],
  log: JSON.stringify(idx.log),
  stats: JSON.stringify(idx.stats),
  // The undo list is compared by its newest entry: older ones fall off at UNDO_DEPTH and a rollback cannot bring them back.
  snap: JSON.stringify({ ...idx.snapshot(), undo: undefined }),
  undoLast: JSON.stringify(idx.snapshot().undo.at(-1)),
  claimed: [...idx.claimed],
  mineAcc: hex(idx.mineAcc),
  root: String(idx.tree.root()),
  nullifiers: [...idx.nullifiers].sort(),
  tickers: [...idx.tickers],
});

// ================================================================ v1 identity (§7.2)

const FIX = JSON.parse(readFileSync("test/fixtures/v1-chain.json", "utf8"));
const fixtureBlocks = () => FIX.blocks.map((b) => ({
  height: b.height, hash: b.hash,
  txs: b.txs.map((t) => ({
    txid: t.txid, inputs: t.inputs.map((i) => ({ outpoint: unhex(i.outpoint) })),
    outputs: t.outputs.map((o) => ({ script: unhex(o.script), value: BigInt(o.value) })),
  })),
}));
async function replayFixture(Klass, opts = {}) {
  const idx = new Klass({ vkey: VKEY, startHeight: FIX.startHeight, ...opts });
  idx.prevoutScript = async (o) => unhex(FIX.prevouts[hex(o)]);
  for (const b of fixtureBlocks()) await idx.applyBlock(b);
  return idx;
}
const lastMiningOpHeight = () => Math.max(...FIX.log.filter((l) => MINING_OPS.has(l.op)).map((l) => l.height));

test("v1 identity fixture: built as specified (DEPLOY, paid and underpaid MINTs, MINT_SCRIPT, TRANSACT, ATTEST, malformed, and mining ops below activation)", () => {
  assert.equal(FIX.format, "murkle-v1-chain/1");
  assert.equal(FIX.generatedBy, "pre-mining src/indexer.mjs");
  assert.ok(FIX.blocks.length >= 8);
  const names = FIX.log.map((l) => `${l.opName}:${l.ok}`);
  for (const n of ["DEPLOY:true", "MINT:true", "MINT:false", "MINT_SCRIPT:true", "TRANSFER:true", "ATTEST:true", "ATTEST:false"]) assert.ok(names.includes(n), n);
  const unknown = FIX.log.filter((l) => l.opName === "UNKNOWN");
  assert.deepEqual(unknown.map((l) => [l.op, l.reason]), [
    [9, "malformed: unknown op 9"], [7, "malformed: unknown op 7"], [8, "malformed: unknown op 8"], [9, "malformed: unknown op 9"], [7, "malformed: unsupported version"],
  ]);
  // The payloads are what the contract lists: a valid-looking DEPLOY_POW, a 515-byte MINE, a 511-byte MINE_SCRIPT,
  // the truncated op 9 "mrk 00 09 01 02" and a full-length op 7 with version byte 1.
  const payloads = fixtureBlocks().flatMap((b) => b.txs).map(findEnvelope).filter(Boolean);
  const byOp = (op) => payloads.filter((p) => p[4] === op);
  assert.equal(decodeEnvelope(byOp(9)[0]).op, OP.DEPLOY_POW);
  assert.ok(byOp(7).some((p) => p.length === 515 && p[3] === 0 && decodeEnvelope(p).op === OP.MINE));
  assert.ok(byOp(8).some((p) => p.length === 511 && decodeEnvelope(p).op === OP.MINE_SCRIPT));
  assert.ok(byOp(9).some((p) => hex(p) === "6d726b0009" + "0102"));
  assert.ok(byOp(7).some((p) => p.length === 515 && p[3] === 1));
});

test("v1 identity: with mining unscheduled, every digest and the whole log equal the pre-mining code's", async () => {
  const idx = await replayFixture(Indexer, { activations: mining(null) });
  assert.deepEqual([...idx.digests], FIX.digests);
  assert.deepEqual(idx.log, FIX.log);
  assert.deepEqual(idx.stats.accepted, { deploy: 1, mint: 3, transact: 1, attest: 1 }, "no mine key, no pow asset");
  assert.ok([...idx.assets.values()].every((a) => a.kind === "mint"));
  // The default table is the pinned one (src/pins.json): v1 below the pinned height, and from it
  // on exactly what an explicit table with that height computes.
  const pinned = await replayFixture(Indexer);
  const explicit = await replayFixture(Indexer, { activations: mining(P.MINING_HEIGHT) });
  assert.deepEqual([...pinned.digests], [...explicit.digests]);
  assert.deepEqual(pinned.log, explicit.log);
  for (const [h, d] of FIX.digests) if (P.MINING_HEIGHT === null || h < P.MINING_HEIGHT) assert.equal(pinned.digestAt(h), d, `v1 at ${h}`);
});

test("v1 identity: with mining activating right after the last block, the same", async () => {
  const last = FIX.blocks.at(-1).height;
  const idx = await replayFixture(Indexer, { activations: mining(last + 1) });
  assert.deepEqual([...idx.digests], FIX.digests);
  assert.deepEqual(idx.log, FIX.log);
});

test("v1 identity: activating after the last mining op keeps every digest below it and switches to v2 from it on", async () => {
  const act = lastMiningOpHeight() + 1;
  assert.ok(act <= FIX.blocks.at(-1).height, "the fixture continues past the activation height");
  const idx = await replayFixture(Indexer, { activations: mining(act) });
  assert.deepEqual(idx.log, FIX.log, "verdicts unchanged");
  for (const [h, d] of FIX.digests) {
    if (h < act) assert.equal(idx.digestAt(h), d, `v1 at ${h}`);
    else {
      assert.notEqual(idx.digestAt(h), d, `v2 at ${h}`);
      assert.equal(idx.digestVersionAt(h), 2);
    }
  }
  // The tip digest is the v2 formula over this state (no mined asset: minedHash = sha256(""), mineAcc = 0).
  const h = idx.height;
  const want = sha256(concat(
    new TextEncoder().encode("murkle/digest/v2"), u32le(h), unhex(idx.hashes.get(h)), bigToBytes(idx.roots.get(h), 32),
    idx.nullAcc, idx.logAcc, idx.assetsHash(), sha256(new Uint8Array()), ZERO32,
  ));
  assert.equal(idx.digestAt(h), hex(want));
});

test("v1 identity: the pre-mining code replayed live (MURKLE_PRE_MINING_SRC) agrees, including on a real signet block", async (t) => {
  const dir = process.env.MURKLE_PRE_MINING_SRC;
  if (!dir) return t.skip("set MURKLE_PRE_MINING_SRC to a copy of the pre-mining src/ inside node_modules/.cache (mining-contract.md §7.2)");
  const { Indexer: Old } = await import(pathToFileURL(`${dir.replace(/[\\/]$/, "")}/indexer.mjs`).href);
  const old = await replayFixture(Old);
  assert.deepEqual([...old.digests], FIX.digests);
  assert.deepEqual(old.log, FIX.log);
  // A real signet block (no envelopes), as height 324,500.
  const real = parseBlock(readFileSync("test/fixtures/signet-324500.bin"));
  const block = { height: 324500, hash: real.hash, txs: real.txs };
  const a = new Old({ vkey: VKEY, startHeight: 324500 });
  const b = new Indexer({ vkey: VKEY, startHeight: 324500 });
  await a.applyBlock(block);
  await b.applyBlock(block);
  assert.equal(b.digestAt(324500), a.digestAt(324500));
});

// ================================================================ envelope formats

test("MINE is 515 bytes, MINE_SCRIPT 511 (bodies 387 / 383); the nonce follows the bind and is covered by extDataHash", () => {
  assert.equal(envelopeLen(OP.MINE), 515);
  assert.equal(envelopeLen(OP.MINE_SCRIPT), 511);
  assert.equal(NONCE_LEN, 8);
  assert.deepEqual([...MINING_OPS].sort(), [7, 8, 9]);
  assert.equal(OP_NAME[7], "MINE");
  assert.equal(OP_NAME[8], "MINE_SCRIPT");
  assert.equal(OP_NAME[9], "DEPLOY_POW");
  assert.equal(OP_NAME[6], undefined, "op 6 stays reserved");
  assert.ok(isMine(7) && isMine(8) && !isMine(3) && !isMine(9));
  const nonce = unhex("0102030405060708");
  const outpoint = randomBytes(36);
  const fields = {
    anchor: 330_000, publicAsset: 77n, publicAmount: 1000n, nonce,
    nullifiers: [1n, 2n], commitments: [FIELD - 1n, 4n], ciphertexts: [new Uint8Array(NOTE_CT_LEN).fill(5), new Uint8Array(NOTE_CT_LEN).fill(6)],
  };
  const body = encodeTxBody({ op: OP.MINE, bindOutpoint: outpoint, ...fields });
  assert.equal(body.length, 387);
  assert.deepEqual(body.subarray(25, 61), Uint8Array.from(outpoint), "bind right after the amounts");
  assert.deepEqual(body.subarray(61, 69), nonce, "then the nonce");
  const env = decodeEnvelope(concat(body, FAKE_PROOF));
  assert.equal(env.op, OP.MINE);
  assert.equal(env.refHeight, 330_000);
  assert.equal(env.anchor, env.refHeight);
  assert.deepEqual(env.nonce, nonce);
  assert.deepEqual(env.bindOutpoint, Uint8Array.from(outpoint));
  assert.deepEqual(env.commitments, [FIELD - 1n, 4n]);
  assert.equal(env.extDataHash, extDataHashOf(body));
  const other = encodeTxBody({ op: OP.MINE, bindOutpoint: outpoint, ...fields, nonce: unhex("0102030405060709") });
  assert.notEqual(extDataHashOf(other), extDataHashOf(body), "the proof binds the nonce");

  const sbody = encodeTxBody({ op: OP.MINE_SCRIPT, bindScriptHash: new Uint8Array(32).fill(9), ...fields });
  assert.equal(sbody.length, 383);
  const senv = decodeEnvelope(concat(sbody, FAKE_PROOF));
  assert.equal(senv.op, OP.MINE_SCRIPT);
  assert.deepEqual(senv.bindScriptHash, new Uint8Array(32).fill(9));
  assert.equal(senv.bindOutpoint, undefined);

  assert.throws(() => encodeTxBody({ op: OP.MINE, bindOutpoint: outpoint, ...fields, nonce: new Uint8Array(7) }), /8-byte nonce/);
  assert.throws(() => encodeTxBody({ op: OP.MINE, ...fields }), /bindOutpoint/);
  assert.throws(() => encodeTxBody({ op: OP.MINE_SCRIPT, ...fields }), /bindScriptHash/);
  assert.throws(() => decodeEnvelope(concat(body, FAKE_PROOF).subarray(0, 514)), /length/);
  assert.throws(() => decodeEnvelope(concat(body, FAKE_PROOF, new Uint8Array(1))), /length/);
  const noncanonical = concat(body, FAKE_PROOF);
  noncanonical.set(bigToBytes(FIELD, 32), 69);
  assert.throws(() => decodeEnvelope(noncanonical), /non-canonical/);
});

test("DEPLOY_POW: round trip, lengths 67 .. 116, every structural bound, no trailing bytes", () => {
  const t = powTerms({ ticker: "A", halvingInterval: 210, startHeight: 5, endHeight: 9 });
  const bytes = encodeDeployPow(t);
  assert.equal(bytes.length, DEPLOY_POW_MIN_LEN + 1);
  assert.equal(DEPLOY_POW_MIN_LEN, 66);
  const d = decodeEnvelope(bytes);
  assert.deepEqual(d, { op: OP.DEPLOY_POW, ...t, claimFeeSats: 0n, treasury: new Uint8Array() });
  const max = encodeDeployPow(powTerms({ ticker: "ABCDEFGHIJKLMNOP", treasury: unhex("0020" + "11".repeat(32)) }));
  assert.equal(max.length, DEPLOY_POW_MAX_LEN);
  const treasury = unhex("76a914" + "22".repeat(20) + "88ac");
  const full = powTerms({ reward: (1n << 63n) - 1n, maxSupply: (1n << 64n) - 1n, span: 432, targetPerSpan: 43_200, initialDifficulty: D_MAX, minDifficulty: D_MAX, claimFeeSats: 1000n, treasury });
  assert.deepEqual(decodeEnvelope(encodeDeployPow(full)), { op: OP.DEPLOY_POW, halvingInterval: 0, startHeight: 0, endHeight: 0, ...full });

  const bad = [
    [{ ticker: "lower" }, /ticker/], [{ ticker: "" }, /ticker/], [{ ticker: "A".repeat(17) }, /ticker/], [{ divisibility: 9 }, /divisibility/],
    [{ reward: 0n }, /reward/], [{ reward: 1n << 63n, maxSupply: 1n << 63n }, /reward/], [{ reward: 11n, maxSupply: 10n }, /max supply/],
    [{ span: 11 }, /span/], [{ span: 433 }, /span/], [{ targetPerSpan: 15 }, /target per span/], [{ span: 12, targetPerSpan: 1201 }, /target per span/],
    [{ minDifficulty: 255n, initialDifficulty: 255n }, /min difficulty/], [{ initialDifficulty: 300n, minDifficulty: 301n }, /initial difficulty below/],
    [{ initialDifficulty: D_MAX + 1n }, /exceeds/], [{ treasury: unhex("6a0102") }, /standard/], [{ claimFeeSats: 1n }, /needs a treasury/],
    [{ startHeight: 10, endHeight: 9 }, /end before start/], [{ span: 70000 }, /span/], [{ halvingInterval: -1 }, /halvingInterval/],
  ];
  for (const [o, re] of bad) assert.throws(() => encodeDeployPow(powTerms(o)), re, JSON.stringify(o, (k, v) => (typeof v === "bigint" ? String(v) : v)));
  assert.doesNotThrow(() => encodeDeployPow(powTerms({ span: 12, targetPerSpan: 1200 })));

  // The decoder enforces the same bounds and refuses trailing or missing bytes.
  assert.throws(() => decodeEnvelope(concat(bytes, new Uint8Array(1))), /trailing/);
  assert.throws(() => decodeEnvelope(bytes.subarray(0, bytes.length - 1)), /truncated/);
  const span11 = Uint8Array.from(bytes);
  const spanAt = 5 + 2 + 1 + 8 + 8 + 4;
  span11[spanAt] = 11;
  assert.throws(() => decodeEnvelope(span11), /span/);
});

// ================================================================ activation gate (D6)

test("below activation, ops 7, 8 and 9 are 'malformed: unknown op N' (UNKNOWN), whatever the body; nothing but stats.rejected moves", async () => {
  const idx = new Indexer({ vkey: VKEY, startHeight: 800_000, activations: mining(800_010) });
  await idx.applyBlock({ height: 800_000, hash: h32(), txs: [coinbase()] });
  const before = { assets: idx.assets.size, tickers: idx.tickers.size, accepted: { ...idx.stats.accepted } };
  const asset = assetIdOf(800_000, 1);
  const c = synthClaim(idx, asset, { reward: 1000n });
  const s = synthClaim(idx, asset, { op: OP.MINE_SCRIPT, reward: 1000n });
  const v1op7 = Uint8Array.from(c.envelope);
  v1op7[3] = 1;
  const txs = [
    carrier(encodeDeployPow(powTerms({ ticker: "EARLY" }))), claimTx(c), claimTx(s),
    carrier(new Uint8Array([0x6d, 0x72, 0x6b, 0x00, 0x09, 0x01, 0x02])), carrier(v1op7),
  ];
  await idx.applyBlock({ height: 800_001, hash: h32(), txs: [coinbase(), ...txs] });
  const entries = txs.map((t) => verdictOf(idx, t));
  assert.deepEqual(entries.map((e) => [e.op, e.opName, e.ok, e.reason]), [
    [9, "UNKNOWN", false, "malformed: unknown op 9"], [7, "UNKNOWN", false, "malformed: unknown op 7"], [8, "UNKNOWN", false, "malformed: unknown op 8"],
    [9, "UNKNOWN", false, "malformed: unknown op 9"], [7, "UNKNOWN", false, "malformed: unsupported version"],
  ]);
  for (const e of entries) assert.deepEqual(Object.keys(e), ["seq", "height", "index", "txid", "op", "opName", "ok", "reason"]);
  assert.equal(idx.assets.size, before.assets);
  assert.equal(idx.tickers.has("EARLY"), false);
  assert.deepEqual(idx.stats.accepted, before.accepted);
  assert.equal(idx.stats.rejected, 5);
  assert.equal(idx.digestVersionAt(800_001), 1);
  assert.equal(await idx.checkTx(c.env, claimTx(c), 800_002), "malformed: unknown op 7", "the relayer's checkTx path is gated too");

  // From the activation height on, the same payloads decode: the truncated op 9 has a decoding reason.
  while (idx.height < 800_009) await idx.applyBlock({ height: idx.height + 1, hash: h32(), txs: [coinbase()] });
  const later = [carrier(new Uint8Array([0x6d, 0x72, 0x6b, 0x00, 0x09, 0x01, 0x02])), carrier(v1op7), carrier(encodeDeployPow(powTerms({ ticker: "EARLY" })))];
  await idx.applyBlock({ height: 800_010, hash: h32(), txs: [coinbase(), ...later] });
  assert.deepEqual(later.map((t) => [verdictOf(idx, t).opName, verdictOf(idx, t).ok, verdictOf(idx, t).reason]), [
    ["DEPLOY_POW", false, "malformed: truncated envelope"], ["MINE", false, "malformed: unsupported version"], ["DEPLOY_POW", true, undefined],
  ]);
  assert.equal(idx.digestVersionAt(800_010), 2);
  assert.equal(idx.assets.get(assetIdOf(800_010, 3)).kind, "pow");
});

test("an Indexer with a mining height needs MINE_FEE, and a valid activation table", () => {
  assert.throws(() => new Indexer({ vkey: VKEY, startHeight: 900_000, activations: mining(900_005), mineFee: null }), /mining activation needs MINE_FEE for this network/);
  assert.doesNotThrow(() => new Indexer({ vkey: VKEY, startHeight: 900_000, activations: mining(null), mineFee: null }));
  assert.throws(() => new Indexer({ vkey: VKEY, startHeight: 900_000, activations: [{ name: "mining", height: 900_005, digestV: 3 }] }), /digestV/);
  // A replay may start above the activation height (murkle audit --from h); an activation at or
  // below the genesis activation height is refused (contract §2: strictly above).
  assert.doesNotThrow(() => new Indexer({ vkey: VKEY, startHeight: 900_000, activations: mining(899_000) }));
  assert.throws(() => new Indexer({ vkey: VKEY, startHeight: 900_000, activations: mining(ACTIVATION_HEIGHT) }), /above the genesis height/);
  assert.throws(() => new Indexer({ vkey: VKEY, startHeight: 900_000, genesis: { txid: "11".repeat(32), height: 899_500, manifestSha256: "22".repeat(32) }, activations: mining(899_500) }), /above the genesis height 899500/);
  assert.doesNotThrow(() => new Indexer({ vkey: VKEY, startHeight: 900_000, genesis: { txid: "11".repeat(32), height: 899_500, manifestSha256: "22".repeat(32) }, activations: mining(899_501) }));
  const idx = new Indexer({ vkey: VKEY, startHeight: 900_000, activations: mining(900_005) });
  assert.equal(idx.miningHeight, 900_005);
  assert.equal(idx.miningActive(900_004), false);
  assert.equal(idx.miningActive(900_005), true);
  assert.equal(new Indexer({ vkey: VKEY, startHeight: 900_000 }).miningHeight, P.MINING_HEIGHT, "the pinned table by default");
  assert.equal(new Indexer({ vkey: VKEY, startHeight: 900_000, activations: mining(null) }).miningHeight, null, "mining off");
  assert.equal(idx.pow, M.inlinePow, "in-process Argon2 by default");
  assert.equal(idx.mineFee, MINE_FEE);
});

// ================================================================ DEPLOY_POW in the indexer

test("DEPLOY_POW: the asset record, the fee policy, end before mining start, and the ticker namespace shared with DEPLOY", async () => {
  const { idx, asset, add, deploy } = await minedChain({ start: 910_000 });
  const a = idx.assets.get(asset);
  assert.equal(a.kind, "pow");
  assert.equal(a.deployHeight, 910_001);
  assert.equal(a.deployTxid, deploy.txid);
  assert.equal(a.mineStart, 910_001, "startHeight 0: mining opens at the deploy block itself (no lead)");
  assert.equal(P.MINE_LEAD, undefined, "the 144-block lead is gone");
  assert.deepEqual(a.dPts, [[a.mineStart, 256n]]);
  assert.equal(a.bodyHash, hex(sha256(findEnvelope(deploy))));
  for (const [k, v] of Object.entries({ claims: 0, issued: 0n, pool: 0n, rejectedClaims: 0, burnedFeeSats: 0n, feeSats: 0n, firstClaimHeight: null, minedOutHeight: null })) assert.deepEqual(a[k], v, k);
  assert.deepEqual(a.claimsByHeight, []);
  const entry = verdictOf(idx, deploy);
  assert.deepEqual(entry, { seq: entry.seq, height: 910_001, index: 1, txid: deploy.txid, op: 9, opName: "DEPLOY_POW", ok: true, asset: asset.toString(), ticker: "PMINE" });
  assert.equal(idx.stats.accepted.deploy, 1);
  assert.equal(idx.stats.accepted.mine, undefined, "no mine key before the first accepted claim (D5)");

  const at = idx.height + 1;
  const fee = carrier(encodeDeployPow(powTerms({ ticker: "FEE", claimFeeSats: 1000n, treasury: unhex("5120" + "33".repeat(32)) })));
  const late = carrier(encodeDeployPow(powTerms({ ticker: "LATE", startHeight: 0, endHeight: at - 1 })));
  const atDeploy = carrier(encodeDeployPow(powTerms({ ticker: "ENDNOW", startHeight: 0, endHeight: at })));
  const pastStart = carrier(encodeDeployPow(powTerms({ ticker: "PAST", startHeight: at - 5 })));
  const lateOk = carrier(encodeDeployPow(powTerms({ ticker: "LATEOK", startHeight: at + 200, endHeight: at + 200 })));
  const dupPow = carrier(encodeDeployPow(powTerms({ ticker: "PMINE" })));
  const paid = carrier(encodeDeploy({ ticker: "PAID", divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() }));
  const dupPaidAfterPow = carrier(encodeDeploy({ ticker: "PMINE", divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() }));
  const powAfterPaid = carrier(encodeDeployPow(powTerms({ ticker: "PAID" })));
  await add([fee, late, atDeploy, pastStart, lateOk, dupPow, paid, dupPaidAfterPow, powAfterPaid]);
  const r = (t) => verdictOf(idx, t).reason ?? true;
  assert.equal(r(fee), "malformed: deployer claim fee not allowed");
  assert.equal(r(late), "malformed: end before mining start", "an end before the deploy block");
  assert.equal(r(atDeploy), true, "an end at the deploy block itself is a one-block mining period");
  assert.equal(idx.assets.get(idx.tickers.get("ENDNOW")).mineStart, at);
  assert.equal(r(pastStart), true);
  assert.equal(idx.assets.get(idx.tickers.get("PAST")).mineStart, at, "a startHeight already passed opens at the deploy block, never before it");
  assert.equal(r(lateOk), true);
  assert.equal(idx.assets.get(idx.tickers.get("LATEOK")).mineStart, at + 200, "a later startHeight delays the start");
  assert.equal(r(dupPow), "ticker PMINE already deployed");
  assert.equal(r(paid), true);
  assert.equal(idx.assets.get(idx.tickers.get("PAID")).kind, "mint");
  assert.equal(r(dupPaidAfterPow), "ticker PMINE already deployed");
  assert.equal(r(powAfterPaid), "ticker PAID already deployed");
  assert.deepEqual(Object.keys(verdictOf(idx, fee)), ["seq", "height", "index", "txid", "op", "opName", "ok", "reason", "ticker"]);
});

// ================================================================ real claims: land, scan, roll, copy, re-prove

const real = {};

test("a claim lands (real Argon2, real proof): the reward is found by scan; asset, log, stats, claimed, mineAcc and dPts move", async () => {
  Object.assign(real, await minedChain({ start: 920_000, pow: M.inlinePow, stub: false }));
  const { idx, asset, add } = real;
  real.miner = new Wallet(deriveKeys(randomBytes(32)));
  const draft = prepareClaim(idx, real.miner, { asset, reward: 1000n });
  const nonce = await solve(idx, draft);
  const utxo = randomBytes(36);
  const env = await finalizeClaim(draft, { bindOutpoint: utxo }, nonce);
  assert.equal(env.length, 515);
  const tx = carrier(env, [fee()], utxo);
  const H = idx.height + 1;
  const dBefore = idx.difficultyAt(asset, H - 1);
  const leaves = idx.tree.size;
  await add([tx]);

  const e = verdictOf(idx, tx);
  assert.equal(e.ok, true, e.reason);
  assert.deepEqual(e, { seq: e.seq, height: H, index: 1, txid: tx.txid, op: 7, opName: "MINE", ok: true, asset: asset.toString(), ticker: "PMINE", amount: "1000", ref: H - 1, difficulty: "256" });
  assert.equal(real.miner.scan(idx).balance(asset), 1000n);
  const a = idx.assets.get(asset);
  assert.deepEqual([a.claims, a.issued, a.pool, a.feeSats, a.firstClaimHeight, a.minedOutHeight], [1, 1000n, 1000n, 500n, H, null]);
  assert.deepEqual(a.claimsByHeight, [[H, 1]]);
  assert.equal(idx.stats.accepted.mine, 1);
  assert.equal(idx.tree.size, leaves + 2);
  assert.deepEqual(idx.stats.outputsByHeight.at(-1), [H, 2]);
  const sol = M.claimPreimage({ asset, refHeight: H - 1, refHash: idx.hashes.get(H - 1), reward: 1000n, commitments: draft.commitments, nonce });
  assert.equal(idx.claimed.get(sol.solutionIdHex), H - 1);
  assert.equal(hex(idx.mineAcc), hex(sha256(concat(ZERO32, sol.solutionId))));
  assert.deepEqual(a.dPts.at(-1), [H, M.stepDifficulty(dBefore, 256n, a)]);
  assert.equal(idx.digestVersionAt(H), 2);
  real.firstNote = real.miner.notes[0];
});

test("two rolled inputs: issued grows by the reward only and the old notes' nullifiers are spent; a rejected rolled claim spends nothing", async () => {
  const { idx, asset, add, miner } = real;
  // A second reward, so the wallet holds two notes.
  const d2 = prepareClaim(idx, miner, { asset, reward: 1000n });
  const n2 = await solve(idx, d2);
  const u2 = randomBytes(36);
  await add([carrier(await finalizeClaim(d2, { bindOutpoint: u2 }, n2), [fee()], u2)]);
  miner.scan(idx);
  const notes = miner.spendable(asset);
  assert.equal(notes.length, 2);

  // Rejected first: an underpaid service fee. Nothing is spent; the fee paid is burned.
  const bad = prepareClaim(idx, miner, { asset, reward: 1000n, rolled: notes });
  const nb = await solve(idx, bad);
  const ub = randomBytes(36);
  const badTx = carrier(await finalizeClaim(bad, { bindOutpoint: ub }, nb), [fee(499n)], ub);
  const a = idx.assets.get(asset);
  const before = { issued: a.issued, nulls: idx.nullifiers.size, leaves: idx.tree.size, claimed: idx.claimed.size, acc: hex(idx.mineAcc) };
  await add([badTx]);
  assert.equal(verdictOf(idx, badTx).reason, `underpaid service fee: 499 < 500 sats to ${hex(PLATFORM)}`);
  assert.deepEqual({ issued: a.issued, nulls: idx.nullifiers.size, leaves: idx.tree.size, claimed: idx.claimed.size, acc: hex(idx.mineAcc) }, before);
  assert.equal(a.rejectedClaims, 1);
  assert.equal(a.burnedFeeSats, 499n);
  assert.deepEqual(Object.keys(verdictOf(idx, badTx)), ["seq", "height", "index", "txid", "op", "opName", "ok", "reason", "asset", "ticker", "amount", "ref"]);
  assert.equal(miner.scan(idx).spendable(asset).length, 2, "both notes still unspent");

  // The same notes rolled into a fresh claim that lands.
  const roll = prepareClaim(idx, miner, { asset, reward: 1000n, rolled: notes });
  const nr = await solve(idx, roll);
  const ur = randomBytes(36);
  const rollTx = carrier(await finalizeClaim(roll, { bindOutpoint: ur }, nr), [fee()], ur);
  await add([rollTx]);
  assert.equal(verdictOf(idx, rollTx).ok, true, verdictOf(idx, rollTx).reason);
  assert.equal(a.issued, 3000n, "+ reward only");
  assert.equal(a.claims, 3);
  for (const n of notes) assert.ok(idx.nullifiers.has(String(n.nullifier)), "old nullifier spent");
  miner.scan(idx);
  assert.equal(miner.balance(asset), 3000n);
  assert.equal(miner.spendable(asset).length, 1, "one note holds everything");
});

test("a verbatim copy in another transaction is rejected and consumes nothing; the original lands (MINE and MINE_SCRIPT)", async () => {
  const { idx, asset, add } = real;
  const w = new Wallet(deriveKeys(randomBytes(32)));
  const d = prepareClaim(idx, w, { asset, reward: 1000n });
  const n = await solve(idx, d);
  const utxo = randomBytes(36);
  const env = await finalizeClaim(d, { bindOutpoint: utxo }, n);
  const copy = carrier(env, [fee(), fee()], randomBytes(36)); // the copier pays twice the fee from its own coin
  const original = carrier(env, [fee()], utxo);

  // MINE_SCRIPT bound to a payer script; the copy is funded from another script.
  const payer = unhex("0014" + h32().slice(0, 40));
  const prevouts = new Map();
  idx.prevoutScript = async (o) => prevouts.get(hex(o));
  const ds = prepareClaim(idx, w, { asset, reward: 1000n });
  const ns = await solve(idx, ds);
  const envS = await finalizeClaim(ds, { bindScriptHash: scriptHashOf(payer) }, ns);
  assert.equal(envS.length, 511);
  const own = randomBytes(36);
  const other = randomBytes(36);
  prevouts.set(hex(own), payer);
  prevouts.set(hex(other), unhex("0014" + h32().slice(0, 40)));
  const copyS = carrier(envS, [fee()], other);
  const originalS = carrier(envS, [fee()], own);

  const claimedBefore = idx.claimed.size;
  await add([copy, copyS, original, originalS]);
  assert.equal(verdictOf(idx, copy).reason, "MINE not bound to this transaction");
  assert.equal(verdictOf(idx, copyS).reason, "MINE not bound to this payer");
  assert.equal(verdictOf(idx, original).ok, true, verdictOf(idx, original).reason);
  assert.equal(verdictOf(idx, originalS).ok, true, verdictOf(idx, originalS).reason);
  assert.equal(idx.claimed.size, claimedBefore + 2, "the copies claimed nothing");
  assert.equal(w.scan(idx).balance(asset), 2000n);
  const a = idx.assets.get(asset);
  assert.equal(a.burnedFeeSats, 499n + 1000n + 500n, "the copies' fee outputs are burned");
  idx.prevoutScript = undefined;
});

test("a re-proved claim of the same solution (other nullifiers, other bind) is rejected: solution already claimed", async () => {
  const { idx, asset, add } = real;
  const w = new Wallet(deriveKeys(randomBytes(32)));
  const d = prepareClaim(idx, w, { asset, reward: 1000n });
  const n = await solve(idx, d);
  // Same outputs (same commitments), fresh dummy inputs: same challenge, same nonce, same solutionId.
  const again = prepareClaim(idx, w, { asset, reward: 1000n, outs: d.outs });
  assert.deepEqual(again.commitments, d.commitments);
  assert.notDeepEqual(again.nullifiers, d.nullifiers);
  const u1 = randomBytes(36);
  const u2 = randomBytes(36);
  const first = carrier(await finalizeClaim(d, { bindOutpoint: u1 }, n), [fee()], u1);
  const second = carrier(await finalizeClaim(again, { bindOutpoint: u2 }, n), [fee()], u2);
  await add([first, second]);
  assert.equal(verdictOf(idx, first).ok, true);
  assert.equal(verdictOf(idx, second).reason, "solution already claimed");
  for (const x of again.nullifiers) assert.equal(idx.nullifiers.has(String(x)), false, "the rejected copy spent nothing");

  // A verbatim repeat that passes the bind is rejected by its nullifiers before any Argon2.
  let evaluations = 0;
  const realPow = idx.pow;
  idx.pow = { hash: async (p) => { evaluations += 1; return realPow.hash(p); }, hashMany: async (ps) => { evaluations += ps.length; return realPow.hashMany(ps); } };
  const repeat = { ...first, txid: h32() };
  await add([repeat]);
  assert.equal(verdictOf(idx, repeat).reason, "nullifier already spent");
  assert.equal(evaluations, 0);
  idx.pow = realPow;
});

test("spies (real proofs): bad PoW never reaches verifyGroth16 or the prevout resolver; a bad proof never reaches the resolver", async () => {
  const { idx, asset, add } = real;
  const w = new Wallet(deriveKeys(randomBytes(32)));
  const payer = unhex("5120" + h32());
  const calls = { groth16: 0, prevout: 0 };
  const verify = idx.verifyGroth16.bind(idx);
  idx.verifyGroth16 = async (...a) => { calls.groth16 += 1; return verify(...a); };
  idx.prevoutScript = async () => { calls.prevout += 1; return payer; };

  // Bad work: a nonce whose Argon2 misses the target (checked with the reference).
  const d = prepareClaim(idx, w, { asset, reward: 1000n });
  const target = M.targetOf(idx.effectiveDifficulty(asset, d.refHeight, idx.height + 1));
  let bad = 0n;
  while (M.meetsTarget(M.powHashReference(M.passwordOf(d.challenge, M.nonceOf(bad))), target)) bad += 1n;
  const badPow = carrier(await finalizeClaim(d, { bindScriptHash: scriptHashOf(payer) }, M.nonceOf(bad)), [fee()]);
  await add([badPow]);
  assert.equal(verdictOf(idx, badPow).reason, "insufficient work");
  assert.deepEqual(calls, { groth16: 0, prevout: 0 });

  // A good solution with a broken proof: Groth16 runs, the resolver does not.
  const d2 = prepareClaim(idx, w, { asset, reward: 1000n });
  const n2 = await solve(idx, d2);
  const env = await finalizeClaim(d2, { bindScriptHash: scriptHashOf(payer) }, n2);
  env[200] ^= 1; // a ciphertext byte: extDataHash no longer matches the proof
  const badProof = carrier(env, [fee()]);
  await add([badProof]);
  assert.equal(verdictOf(idx, badProof).reason, "proof does not verify");
  assert.deepEqual(calls, { groth16: 1, prevout: 0 });

  // The control: a good claim reaches both, once.
  const d3 = prepareClaim(idx, w, { asset, reward: 1000n });
  const n3 = await solve(idx, d3);
  const good = carrier(await finalizeClaim(d3, { bindScriptHash: scriptHashOf(payer) }, n3), [fee()]);
  await add([good]);
  assert.equal(verdictOf(idx, good).ok, true, verdictOf(idx, good).reason);
  assert.deepEqual(calls, { groth16: 2, prevout: 1 });
  idx.verifyGroth16 = verify;
  idx.prevoutScript = undefined;
});

// ================================================================ rules in order (synthetic)

test("window edges: ref = H - 12 accepted; H - 13 and H rejected; starting now, the deploy block itself is a valid reference and the block before it is not", async () => {
  const { idx, asset, add } = await minedChain({ start: 930_000 });
  const ms = idx.assets.get(asset).mineStart;
  assert.equal(ms, idx.assets.get(asset).deployHeight, "starting now: mineStart is the deploy block");
  // H = mineStart + 1: ref = mineStart - 1 (the block before the deploy) is in the window but before mining starts.
  const early = synthClaim(idx, asset, { ref: ms - 1, reward: 1000n });
  const atStart = synthClaim(idx, asset, { ref: ms });
  let t = [claimTx(early), claimTx(atStart)];
  await add(t);
  assert.equal(verdictOf(idx, t[0]).reason, "mining not started");
  assert.equal(verdictOf(idx, t[1]).ok, true);
  for (let i = 0; i < 14; i++) await add([]);
  const H = idx.height + 1;
  const edge = synthClaim(idx, asset, { ref: H - MINE_WINDOW });
  const tooOld = synthClaim(idx, asset, { ref: H - MINE_WINDOW - 1 });
  const current = synthClaim(idx, asset, { ref: H, reward: 1000n });
  const future = synthClaim(idx, asset, { ref: H + 5, reward: 1000n });
  t = [claimTx(edge), claimTx(tooOld), claimTx(current), claimTx(future)];
  await add(t);
  assert.deepEqual(t.map((x) => verdictOf(idx, x).reason ?? true), [true, "reference outside window", "reference outside window", "reference outside window"]);
  assert.equal(verdictOf(idx, t[0]).ref, H - 12);
});

test("start after N blocks: references before deploy + N are 'mining not started', deploy + N is accepted", async () => {
  const N = 5;
  // minedChain deploys in block start + 1; startHeight = start + 1 + N is "N blocks after the deploy block".
  const { idx, asset, add } = await minedChain({ start: 935_000, terms: { startHeight: 935_001 + N } });
  const a = idx.assets.get(asset);
  assert.equal(a.deployHeight, 935_001);
  assert.equal(a.mineStart, a.deployHeight + N);
  assert.deepEqual(a.dPts, [[a.mineStart, 256n]]);
  assert.equal(M.mineStatus(a, a.mineStart - 1), "mining-soon");
  assert.equal(M.mineStatus(a, a.mineStart), "mining");
  // H = deploy + N + 1: every block from deploy - 1 to deploy + N lies in the window.
  const refs = [a.deployHeight - 1, a.deployHeight, a.deployHeight + 1, a.mineStart - 1, a.mineStart];
  const claims = refs.map((ref) => synthClaim(idx, asset, { ref, reward: 1000n }));
  await add(claims.map((c) => claimTx(c)));
  const reasons = idx.log.slice(-refs.length).map((l) => l.reason ?? true);
  assert.deepEqual(reasons, ["mining not started", "mining not started", "mining not started", "mining not started", true]);
  assert.equal(idx.assets.get(asset).claims, 1);
});

test("each MINE rule in order with its exact reason; nothing mutates on a rejection", async () => {
  const pow = ctlPow();
  const { idx, asset, add } = await minedChain({ start: 940_000, pow, terms: { endHeight: 0 } });
  // A second mined asset that closes early and one that halves to 0 quickly; a paid asset.
  await add([
    carrier(encodeDeployPow(powTerms({ ticker: "SHORT", endHeight: idx.height + 1 + 2 }))),
    carrier(encodeDeployPow(powTerms({ ticker: "HALF", reward: 1n, maxSupply: 10n, halvingInterval: 1 }))),
    carrier(encodeDeploy({ ticker: "PAIDX", divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() })),
  ]);
  const short = idx.tickers.get("SHORT");
  const half = idx.tickers.get("HALF");
  const paid = idx.tickers.get("PAIDX");
  while (idx.height < idx.assets.get(short).mineStart + 4) await add([]);
  // A block without a hash inside the window.
  await add([], { hash: null });
  const noHashRef = idx.height;
  await add([]);

  const H = idx.height + 1;
  const ref = H - 1;
  const n = randomField();
  const cases = [
    ["unknown asset", synthClaim(idx, 12345n, { reward: 1000n })],
    ["asset is not mined", synthClaim(idx, paid, { reward: 10n })],
    ["mining closed", synthClaim(idx, short, { ref })],
    ["unknown reference block", synthClaim(idx, asset, { ref: noHashRef })],
    ["mining ended", synthClaim(idx, half, { ref, reward: 1n })],
    ["reward differs from terms", synthClaim(idx, asset, { ref, reward: 999n })],
    ["duplicate nullifier in envelope", synthClaim(idx, asset, { ref, nullifiers: [n, n] })],
  ];
  const txs = cases.map(([, c]) => claimTx(c));
  // Fee and bind rules.
  const under = synthClaim(idx, asset, { ref });
  txs.push(claimTx(under, { extra: [fee(250n), fee(249n)] }));
  cases.push([`underpaid service fee: 499 < 500 sats to ${hex(PLATFORM)}`, under]);
  const unbound = synthClaim(idx, asset, { ref });
  txs.push(claimTx(unbound, { first: randomBytes(36) }));
  cases.push(["MINE not bound to this transaction", unbound]);
  const noInput = synthClaim(idx, asset, { ref });
  txs.push({ txid: h32(), inputs: [], outputs: [{ script: opReturnScript(noInput.envelope), value: 0n }, fee()] });
  cases.push(["MINE not bound to this transaction", noInput]);
  const coinbaseBound = synthClaim(idx, asset, { ref, op: OP.MINE_SCRIPT });
  txs.push(claimTx(coinbaseBound, { first: NULL_OUTPOINT }));
  cases.push(["MINE not bound to this payer", coinbaseBound]);
  const noResolver = synthClaim(idx, asset, { ref, op: OP.MINE_SCRIPT });
  txs.push(claimTx(noResolver));
  cases.push(["cannot resolve the spent output (no prevout resolver)", noResolver]);
  // Work, then proof.
  const weak = synthClaim(idx, asset, { ref });
  pow.forced.set(hex(idx.claimOf(weak.env).password), new Uint8Array(32).fill(0xff));
  txs.push(claimTx(weak));
  cases.push(["insufficient work", weak]);
  const badEncoding = synthClaim(idx, asset, { ref, proof: new Uint8Array(128) });
  txs.push(claimTx(badEncoding));
  cases.push(["invalid proof encoding: ", badEncoding]);
  const notVerifying = synthClaim(idx, asset, { ref });
  txs.push(claimTx(notVerifying));
  cases.push(["proof does not verify", notVerifying]);
  const refuse = new Set([String(notVerifying.env.nullifiers[0])]);
  idx.verifyGroth16 = async (signals) => !refuse.has(signals[4]);

  const a = idx.assets.get(asset);
  const before = { nulls: idx.nullifiers.size, leaves: idx.tree.size, claimed: idx.claimed.size, acc: hex(idx.mineAcc), issued: a.issued, claims: a.claims };
  const rejectedBefore = { [asset]: a.rejectedClaims, [short]: idx.assets.get(short).rejectedClaims, [half]: idx.assets.get(half).rejectedClaims };
  await add(txs);
  cases.forEach(([reason, c], i) => {
    const e = verdictOf(idx, txs[i]);
    assert.equal(e.ok, false, reason);
    if (reason.endsWith(": ")) assert.ok(e.reason.startsWith(reason), `${reason} -> ${e.reason}`);
    else assert.equal(e.reason, reason);
    assert.equal(e.ref, c.env.refHeight);
    assert.equal(e.amount, c.env.publicAmount.toString());
  });
  assert.deepEqual({ nulls: idx.nullifiers.size, leaves: idx.tree.size, claimed: idx.claimed.size, acc: hex(idx.mineAcc), issued: a.issued, claims: a.claims }, before);
  assert.equal(a.rejectedClaims - rejectedBefore[asset], cases.filter(([, c]) => c.env.publicAsset === asset).length);
  assert.equal(idx.assets.get(paid).rejectedMints, 0, "a MINE against a paid asset does not touch it");
  assert.equal(verdictOf(idx, txs[0]).ticker, undefined, "unknown asset: no ticker");

  // checkMine's parts are public and pure.
  const c = synthClaim(idx, asset);
  const tx = claimTx(c);
  assert.equal(idx.mineStatic(c.env, idx.height + 1), true);
  assert.equal(idx.mineCarrier(c.env, tx), true);
  assert.equal(idx.mineState(c.env), true);
  assert.equal(await idx.minePow(c.env, idx.height + 1), true);
  assert.equal(await idx.mineProof(c.env), true);
  assert.equal(await idx.mineBind(c.env, tx), true);
  assert.equal(await idx.checkMine(c.env, tx, idx.height + 1), true);
  assert.equal(await idx.checkTx(c.env, tx, idx.height + 1), true, "checkTx routes a MINE to checkMine");
  assert.equal(idx.claimOf(synthClaim(idx, paid, { reward: 10n }).env), null);
  assert.equal(idx.claimOf(synthClaim(idx, asset, { ref: noHashRef }).env), null);
  assert.equal(idx.claimOf(c.env).solutionIdHex, hex(M.solutionIdOf(idx.claimOf(c.env).challenge, c.nonce)));
});

test("MINT and MINT_SCRIPT on a mined asset are rejected: asset is mined", async () => {
  const { idx, asset, add } = await minedChain({ start: 945_000 });
  const utxo = randomBytes(36);
  const body = encodeTxBody({
    op: OP.MINT, anchor: idx.height, publicAsset: asset, publicAmount: 1000n, bindOutpoint: utxo,
    nullifiers: [randomField(), randomField()], commitments: [randomField(), randomField()], ciphertexts: [randomBytes(NOTE_CT_LEN), randomBytes(NOTE_CT_LEN)],
  });
  const mint = carrier(concat(body, FAKE_PROOF), [], utxo);
  await add([mint]);
  assert.equal(verdictOf(idx, mint).reason, "asset is mined");
  assert.equal(verdictOf(idx, mint).opName, "MINT");
  assert.equal(idx.assets.get(asset).rejectedClaims, 0);
  assert.equal(idx.assets.get(asset).rejectedMints, undefined, "no paid-mint counters on a mined asset");
});

test("stale bound: a claim at D(ref) is accepted while D(H - 1) <= 4 D(ref) and rejected once it is above", async () => {
  const pow = ctlPow();
  const { idx, asset, add } = await minedChain({ start: 950_000, pow });
  const a = idx.assets.get(asset);
  const ref0 = idx.height; // D = 256
  // A surge: many claims in two blocks raise D far above 4 x 256.
  for (let k = 0; k < 2; k++) await add(Array.from({ length: 100 }, () => claimTx(synthClaim(idx, asset))));
  const H = idx.height + 1;
  const d0 = idx.difficultyAt(asset, ref0);
  const dTip = idx.difficultyAt(asset, H - 1);
  assert.equal(d0, 256n);
  assert.ok(dTip > 4n * d0, `${dTip} > ${4n * d0}`);
  // Exactly enough work for D(ref0): valid by the reference difficulty, short of D(H - 1) / 4.
  const exact = bigToBytes(M.targetOf(d0), 32);
  const stale = synthClaim(idx, asset, { ref: ref0 });
  pow.forced.set(hex(idx.claimOf(stale.env).password), exact);
  const enough = synthClaim(idx, asset, { ref: ref0 });
  pow.forced.set(hex(idx.claimOf(enough.env).password), bigToBytes(M.targetOf(dTip / 4n), 32));
  const t = [claimTx(stale), claimTx(enough)];
  await add(t);
  assert.equal(verdictOf(idx, t[0]).reason, "insufficient work");
  assert.equal(verdictOf(idx, t[1]).ok, true);
  assert.equal(verdictOf(idx, t[1]).difficulty, (dTip / 4n).toString(), "work counted at D_eff");

  // Before the surge the same quality of work at D(ref) passes: D(H - 1) <= 4 D(ref).
  const calm = await minedChain({ start: 955_000, pow: ctlPow() });
  await calm.add(Array.from({ length: 20 }, () => claimTx(synthClaim(calm.idx, calm.asset))));
  const r0 = calm.idx.height - 1;
  const dr = calm.idx.difficultyAt(calm.asset, r0);
  const dt = calm.idx.difficultyAt(calm.asset, calm.idx.height);
  assert.ok(dt > dr && dt <= 4n * dr, `${dr} < ${dt} <= 4 x ${dr}`);
  const ok = synthClaim(calm.idx, calm.asset, { ref: r0 });
  calm.pow.forced.set(hex(calm.idx.claimOf(ok.env).password), bigToBytes(M.targetOf(dr), 32));
  const okTx = claimTx(ok);
  await calm.add([okTx]);
  assert.equal(verdictOf(calm.idx, okTx).ok, true);
  assert.equal(verdictOf(calm.idx, okTx).difficulty, dr.toString());
  assert.ok(a.dPts.length <= MINE_WINDOW + 2);
});

test("difficulty points: a block of claims steps D from D(H - 1) by the counted work; quiet blocks decay lazily", async () => {
  const pow = ctlPow();
  const { idx, asset, add } = await minedChain({ start: 960_000, pow, terms: { initialDifficulty: 100_000n, minDifficulty: 256n } });
  const a = idx.assets.get(asset);
  const ms = a.mineStart;
  for (let i = 0; i < 5; i++) await add([]);
  assert.equal(a.dPts.length, 1, "quiet blocks store nothing");
  const H = idx.height + 1;
  const dPrev = idx.difficultyAt(asset, H - 1);
  assert.equal(dPrev, [1, 2, 3, 4, 5].reduce((d) => M.stepDifficulty(d, 0n, a), 100_000n));
  const t = Array.from({ length: 3 }, () => claimTx(synthClaim(idx, asset)));
  await add(t);
  const work = t.map((x) => BigInt(verdictOf(idx, x).difficulty)).reduce((s, d) => s + d, 0n);
  assert.equal(work, 3n * dPrev);
  assert.deepEqual(a.dPts, [[ms, 100_000n], [H, M.stepDifficulty(dPrev, work, a)]]);
  // A large block (300 claims; the pure 1,700-claim step is in mine-vectors.test.mjs).
  await add(Array.from({ length: 300 }, () => claimTx(synthClaim(idx, asset))));
  const d1 = idx.difficultyAt(asset, H);
  assert.deepEqual(a.dPts.at(-1), [H + 1, M.stepDifficulty(d1, 300n * d1, a)]);
  assert.equal(a.claims, 303);
  // The newest point feeds minedHash.
  const [dh, dv] = a.dPts.at(-1);
  const line = concat(u64le(asset), u64le(BigInt(a.claims)), u64le(a.issued), u32le(dh), u64le(dv), unhex(a.bodyHash));
  assert.equal(hex(idx.minedHash()), hex(sha256(line)));
});

test("supply cap reached mid-block in transaction order: later claims rejected, their fees burned", async () => {
  const { idx, asset, add } = await minedChain({ start: 970_000, terms: { reward: 1000n, maxSupply: 3000n } });
  const t = Array.from({ length: 5 }, () => claimTx(synthClaim(idx, asset)));
  await add(t);
  assert.deepEqual(t.map((x) => verdictOf(idx, x).reason ?? true), [true, true, true, "supply cap reached", "supply cap reached"]);
  const a = idx.assets.get(asset);
  assert.equal(a.issued, 3000n);
  assert.equal(a.rejectedClaims, 2);
  assert.equal(a.burnedFeeSats, 1000n);
  assert.equal(a.feeSats, 1500n);
  assert.equal(a.minedOutHeight, idx.height);
  assert.equal(M.mineStatus(a, idx.height), "mined-out");
});

// ================================================================ errors are never verdicts; the pre-pass

test("a throwing pow.hash and a dead pool worker: the block is reverted and retried, never rejected", async () => {
  const { idx, asset, add } = await minedChain({ start: 980_000 });
  const c = synthClaim(idx, asset);
  const block = { height: idx.height + 1, hash: h32(), txs: [coinbase(), claimTx(synthClaim(idx, asset)), claimTx(c)] };
  const before = fingerprint(idx);
  const good = idx.pow;
  idx.pow = { hash: async () => { throw Object.assign(new Error("Argon2 failed: allocation"), { code: "POW_FAILED" }); } };
  await assert.rejects(idx.applyBlock(block), /Argon2 failed/);
  assert.deepEqual(fingerprint(idx), before, "nothing of the block remains");
  idx.pow = { hash: good.hash, hashMany: async () => { throw new Error("pre-pass failed"); } };
  await assert.rejects(idx.applyBlock(block), /pre-pass failed/);
  assert.deepEqual(fingerprint(idx), before);

  // A pool whose worker dies on its first task: PowError, then the replacement serves the retry.
  let spawned = 0;
  class Dying extends EventEmitter {
    constructor(die) { super(); this.die = die; setImmediate(() => this.emit("message", { type: "ready", ok: true, impl: "hash-wasm" })); }
    postMessage(msg) {
      setImmediate(() => (this.die ? this.emit("exit", 1) : this.emit("message", { id: msg.id, ok: true, hashes: msg.passwords.map(() => "00".repeat(32)) })));
    }
    terminate() { return Promise.resolve(0); }
  }
  const pool = new PowPool({ size: 1, spawn: () => new Dying(spawned++ === 0) });
  await pool.ready();
  idx.pow = pool;
  await assert.rejects(idx.applyBlock(block), (e) => e.code === "POW_WORKER_FAILED");
  assert.deepEqual(fingerprint(idx), before);
  await idx.applyBlock(block);
  assert.equal(idx.log.at(-1).ok, true);
  assert.equal(idx.log.at(-2).ok, true);
  assert.equal(idx.stats.accepted.mine, 2);
  await pool.close();
});

test("pre-pass: 1,000 copies of one solution (re-proved, or verbatim) cost one Argon2 evaluation", async () => {
  const pow = ctlPow();
  const { idx, asset, add } = await minedChain({ start: 990_000, pow });
  const nonce = randomBytes(8);
  const commitments = [randomField(), randomField()];
  const reproved = Array.from({ length: 1000 }, () => claimTx(synthClaim(idx, asset, { nonce, commitments })));
  pow.manyCalls.length = 0;
  pow.hashCalls = 0;
  await add(reproved);
  assert.deepEqual(pow.manyCalls, [1], "one distinct solutionId in the pre-pass");
  assert.equal(pow.hashCalls, 0, "rule 11 read the memo");
  assert.equal(verdictOf(idx, reproved[0]).ok, true);
  assert.ok(reproved.slice(1).every((t) => verdictOf(idx, t).reason === "solution already claimed"));

  const one = synthClaim(idx, asset);
  const verbatim = Array.from({ length: 1000 }, () => claimTx(one));
  pow.manyCalls.length = 0;
  pow.hashCalls = 0;
  await add(verbatim);
  assert.equal(pow.evaluated - 1, 1, "one more evaluation in total");
  assert.ok(verbatim.slice(1).every((t) => verdictOf(idx, t).reason === "nullifier already spent"));

  // Without hashMany (a plain backend), the memo still evaluates each solution once.
  const plain = { calls: 0, hash: async () => { plain.calls += 1; return new Uint8Array(32); } };
  idx.pow = plain;
  const n2 = randomBytes(8);
  const c2 = [randomField(), randomField()];
  await add(Array.from({ length: 50 }, () => claimTx(synthClaim(idx, asset, { nonce: n2, commitments: c2 }))));
  assert.equal(plain.calls, 1);
});

// ================================================================ reorgs, pruning, digest, snapshots

/** Builds a random block of mining activity (claims ok, stale, weak, capped, rejected; deploys; nothing). */
function randomBlock(idx, assets, pow, rnd) {
  const txs = [];
  const n = Math.floor(rnd() * 6);
  for (let i = 0; i < n; i++) {
    const asset = assets[Math.floor(rnd() * assets.length)];
    const a = idx.assets.get(asset);
    const kind = rnd();
    const ref = idx.height - Math.floor(rnd() * 12);
    if (ref < a.mineStart) continue;
    const c = synthClaim(idx, asset, { ref });
    if (kind < 0.15) pow.forced.set(hex(idx.claimOf(c.env).password), new Uint8Array(32).fill(0xff));
    if (kind > 0.9) txs.push(claimTx(c, { extra: [fee(100n)] }));
    else txs.push(claimTx(c));
  }
  if (rnd() < 0.1) txs.push(carrier(encodeDeployPow(powTerms({ ticker: `R${Math.floor(rnd() * 1e9)}` }))));
  return txs;
}
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

test("randomized reorgs restore every mining field, dPts and claimed exactly; re-applying equals a fresh replay", async () => {
  const pow = ctlPow();
  const { idx, asset, add, blocks } = await minedChain({ start: 1_000_000, pow, terms: { maxSupply: 40_000n } });
  await add([carrier(encodeDeployPow(powTerms({ ticker: "SECOND", span: 12, targetPerSpan: 16 })))]);
  const second = idx.tickers.get("SECOND");
  while (idx.height < idx.assets.get(second).mineStart) await add([]);
  const assets = [asset, second];
  const rnd = rng(42);
  const states = new Map([[idx.height, fingerprint(idx)]]);
  for (let round = 0; round < 60; round++) {
    if (round % 7 === 6) {
      const depth = 1 + Math.floor(rnd() * 5);
      const target = idx.height - depth;
      idx.rollbackTo(target);
      blocks.length = blocks.findIndex((b) => b.height === target) + 1;
      assert.deepEqual(fingerprint(idx), states.get(target), `rollback to ${target}`);
      for (const h of [...states.keys()]) if (h > target) states.delete(h);
      continue;
    }
    await add(randomBlock(idx, assets, pow, rnd));
    states.set(idx.height, fingerprint(idx));
  }
  const a = idx.assets.get(asset);
  assert.ok(a.claims > 10 && a.rejectedClaims > 0, `${a.claims} claims, ${a.rejectedClaims} rejected`);
  // A fresh replay of the surviving chain is identical (forced hashes are keyed by password, so verdicts repeat).
  const fresh = new Indexer({ vkey: VKEY, startHeight: 1_000_000, activations: mining(1_000_001), pow });
  fresh.verifyGroth16 = async () => true;
  for (const b of blocks) await fresh.applyBlock(b);
  assert.deepEqual(fingerprint(fresh), fingerprint(idx));
});

test("pruning across a 144-block rollback: dPts keeps at most 14 points, claimed drops old refs, and re-applying is identical", async () => {
  const pow = ctlPow();
  const { idx, asset, add, blocks } = await minedChain({ start: 1_010_000, pow });
  const a = idx.assets.get(asset);
  const claimEvery = async (n) => {
    for (let i = 0; i < n; i++) {
      await add(i % 3 === 0 ? [claimTx(synthClaim(idx, asset)), claimTx(synthClaim(idx, asset, { ref: idx.height - 5 }))] : []);
      assert.ok(a.dPts.length <= MINE_WINDOW + 2, `dPts ${a.dPts.length}`);
      for (const [, ref] of idx.claimed) assert.ok(ref >= idx.height - MINE_WINDOW - UNDO_DEPTH, "claimed is pruned");
    }
  };
  await claimEvery(200);
  const mark = idx.height;
  await claimEvery(UNDO_DEPTH);
  const end = fingerprint(idx);
  const tail = blocks.slice(-UNDO_DEPTH);
  idx.rollbackTo(mark);
  assert.equal(idx.height, mark);
  assert.ok(a.dPts.length <= MINE_WINDOW + 2);
  for (const b of tail) await idx.applyBlock(b);
  assert.deepEqual(fingerprint(idx), end);
  assert.throws(() => idx.rollbackTo(idx.height - UNDO_DEPTH - 1), /deeper than undo log/);
});

test("digest v2 golden vectors: at activation, after a DEPLOY_POW before mineStart, and in a block with claims", async () => {
  // A deterministic chain: fixed hashes, txids and envelopes; zero Argon2; stubbed Groth16.
  let k = 0;
  const det = (tag) => hex(sha256(new TextEncoder().encode(`golden ${tag} ${k++}`)));
  const detBytes = (n, tag) => concat(unhex(det(tag)), unhex(det(tag))).slice(0, n);
  const idx = new Indexer({ vkey: VKEY, startHeight: 1_020_000, activations: mining(1_020_002), pow: ctlPow() });
  idx.verifyGroth16 = async () => true;
  const dcar = (env, extra = [], first = detBytes(36, "in")) => ({ txid: det("tx"), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(env), value: 0n }, ...extra] });
  const dcb = () => ({ txid: det("cb"), inputs: [{ outpoint: NULL_OUTPOINT }], outputs: [] });
  const chain = [];
  const apply = (txs) => {
    const b = { height: idx.height + 1, hash: det("block"), txs: [dcb(), ...txs] };
    chain.push(b);
    return idx.applyBlock(b);
  };
  await apply([dcar(encodeDeploy({ ticker: "GOLDM", divisibility: 0, mintAmount: 5n, mintCap: 9, priceSats: 0n, treasury: new Uint8Array() }))]);
  await apply([]); // 1_020_001: v1
  await apply([]); // 1_020_002: activation, no mining op
  const atActivation = idx.digestAt(1_020_002);
  // Start after 6 blocks (startHeight 1_020_009), so a digest exists with the asset deployed but not yet open.
  await apply([dcar(encodeDeployPow(powTerms({ ticker: "GOLD", startHeight: 1_020_009 })))]); // 1_020_003
  const asset = assetIdOf(1_020_003, 1);
  const beforeStart = idx.digestAt(1_020_003);
  assert.equal(idx.assets.get(asset).mineStart, 1_020_009);
  while (idx.height < idx.assets.get(asset).mineStart) await apply([]);
  const claims = [1, 2, 3].map((i) => {
    const bind = detBytes(36, "bind");
    const body = encodeTxBody({
      op: OP.MINE, anchor: idx.height, publicAsset: asset, publicAmount: 1000n, bindOutpoint: bind, nonce: u64le(BigInt(i)),
      nullifiers: [BigInt(10 * i), BigInt(10 * i + 1)], commitments: [BigInt(10 * i + 2), BigInt(10 * i + 3)],
      ciphertexts: [new Uint8Array(NOTE_CT_LEN).fill(i), new Uint8Array(NOTE_CT_LEN).fill(i + 1)],
    });
    return dcar(concat(body, FAKE_PROOF), [fee()], bind);
  });
  await apply(claims);
  const withClaims = idx.digestAt(idx.height);
  assert.ok(claims.every((t) => verdictOf(idx, t).ok));

  // Independent recomputation of the v2 formula at the tip.
  const a = idx.assets.get(asset);
  const h = idx.height;
  const paidAssets = [...idx.assets.values()].filter((x) => x.kind === "mint");
  const assetsHash = sha256(concat(...paidAssets.map((x) => concat(u64le(x.id), u32le(x.minted), u64le(x.pool), unhex(x.bodyHash)))));
  const [dh, dv] = a.dPts.at(-1);
  const minedHash = sha256(concat(u64le(a.id), u64le(BigInt(a.claims)), u64le(a.issued), u32le(dh), u64le(dv), unhex(a.bodyHash)));
  let mineAcc = ZERO32;
  for (const t of claims) {
    const env = decodeEnvelope(findEnvelope(t));
    mineAcc = sha256(concat(mineAcc, idx.claimOf(env).solutionId));
  }
  assert.equal(hex(idx.mineAcc), hex(mineAcc));
  const want = sha256(concat(new TextEncoder().encode(digestTag(2)), u32le(h), unhex(idx.hashes.get(h)), bigToBytes(idx.roots.get(h), 32), idx.nullAcc, idx.logAcc, assetsHash, minedHash, mineAcc));
  assert.equal(withClaims, hex(want));
  assert.notEqual(LABELS.digest, digestTag(2));

  // Pinned values: any change to the v2 formula or its inputs changes these.
  if (process.env.PRINT_GOLDEN) console.log("GOLDEN", JSON.stringify({ atActivation, beforeStart, withClaims }));
  assert.deepEqual([atActivation, beforeStart, withClaims], [
    GOLDEN.atActivation, GOLDEN.beforeStart, GOLDEN.withClaims,
  ]);
  // v1 below activation: the same chain with mining unscheduled matches up to 1_020_001 and differs from 1_020_002.
  assert.equal(idx.digestVersionAt(1_020_001), 1);
  assert.equal(idx.digestVersionAt(1_020_002), 2);
  const v1 = new Indexer({ vkey: VKEY, startHeight: 1_020_000, activations: mining(null) });
  for (const b of chain.slice(0, 4)) await v1.applyBlock(b);
  assert.equal(v1.digestAt(1_020_001), idx.digestAt(1_020_001));
  assert.notEqual(v1.digestAt(1_020_002), atActivation, "the switch is unconditional at the activation height");
  assert.equal(verdictOf(v1, chain[3].txs[1]).reason, "malformed: unknown op 9");
});
const GOLDEN = {
  atActivation: "0e0824eb389d5bad5cb0f9f2812cc68fe5fc9d8c1c6190bc52cf9d157e7fe688",
  beforeStart: "078fd4cfae8e34125cbdbb09a2fa845b0e15a1fd41fe9f2cbd8d0e47122e7957",
  withClaims: "bdfc157db65306b940b2fe560bdaeadf77b5d0bc5a514bc044c632dafe360eae",
};

test("snapshot v3 round trip: mining state, activations, undo; restored indexer continues and rolls back identically", async () => {
  const pow = ctlPow();
  const { idx, asset, add, blocks } = await minedChain({ start: 1_030_000, pow });
  const rnd = rng(7);
  for (let i = 0; i < 20; i++) await add(randomBlock(idx, [asset], pow, rnd));
  const snap = JSON.parse(JSON.stringify(idx.snapshot()));
  assert.equal(snap.version, 3);
  assert.equal(snap.digestVersion, 2);
  assert.deepEqual(snap.activations, mining(1_030_001));
  assert.equal(snap.mine.mineAcc, hex(idx.mineAcc));
  assert.deepEqual(snap.mine.claimed, [...idx.claimed]);
  const sa = snap.assets.find((x) => x.id === asset.toString());
  assert.equal(sa.kind, "pow");
  assert.equal(typeof sa.issued, "string");
  assert.equal(typeof sa.dPts[0][1], "string");
  assert.ok(snap.undo.every((u) => Array.isArray(u.mine) && typeof u.mineAcc === "string" && Array.isArray(u.claimed)));

  const restored = Indexer.restore(snap, { vkey: VKEY, activations: mining(1_030_001), pow });
  restored.verifyGroth16 = idx.verifyGroth16;
  assert.deepEqual(fingerprint(restored), fingerprint(idx));
  const more = [];
  for (let i = 0; i < 8; i++) more.push(randomBlock(idx, [asset], pow, rnd));
  for (const txs of more) await add(txs);
  for (const b of blocks.slice(-8)) await restored.applyBlock(b);
  assert.deepEqual(fingerprint(restored), fingerprint(idx));
  restored.rollbackTo(snap.height - 3);
  idx.rollbackTo(snap.height - 3);
  assert.deepEqual(fingerprint(restored), fingerprint(idx));
});

test("a v2 snapshot taken below activation migrates: restoring it and replaying past activation equals a fresh replay", async () => {
  const pow = ctlPow();
  const act = 1_040_005;
  const src = new Indexer({ vkey: VKEY, startHeight: 1_040_000, activations: mining(act), pow });
  src.verifyGroth16 = async () => true;
  const blocks = [];
  const add = async (txs) => {
    const b = { height: src.height + 1, hash: h32(), txs: [coinbase(), ...txs] };
    await src.applyBlock(b);
    blocks.push(b);
  };
  await add([carrier(encodeDeploy({ ticker: "OLDM", divisibility: 0, mintAmount: 5n, mintCap: 9, priceSats: 0n, treasury: new Uint8Array() }))]);
  await add([]);
  const snap = JSON.parse(JSON.stringify(src.snapshot()));
  assert.equal(snap.version, 2, "below every activation the v2 layout is written");
  assert.equal(snap.digestVersion, 1);
  assert.equal(snap.activations, undefined);
  assert.ok(snap.assets.every((a) => a.kind === undefined));
  assert.ok(snap.undo.every((u) => u.mine === undefined));

  const restored = Indexer.restore(snap, { vkey: VKEY, activations: mining(act), pow });
  restored.verifyGroth16 = src.verifyGroth16;
  assert.equal(restored.assets.get(assetIdOf(1_040_000, 1)).kind, "mint");
  assert.equal(hex(restored.mineAcc), hex(ZERO32));
  assert.equal(restored.claimed.size, 0);
  while (src.height < act) await add([]);
  await add([carrier(encodeDeployPow(powTerms({ ticker: "NEWM" })))]);
  const asset = assetIdOf(act + 1, 1);
  while (src.height < src.assets.get(asset).mineStart) await add([]);
  for (let i = 0; i < 4; i++) await add([claimTx(synthClaim(src, asset)), claimTx(synthClaim(src, asset))]);
  for (const b of blocks.filter((x) => x.height > snap.height)) await restored.applyBlock(b);
  const fresh = new Indexer({ vkey: VKEY, startHeight: 1_040_000, activations: mining(act), pow });
  fresh.verifyGroth16 = src.verifyGroth16;
  for (const b of blocks) await fresh.applyBlock(b);
  assert.deepEqual(fingerprint(restored), fingerprint(fresh));
  assert.deepEqual(fingerprint(src), fingerprint(fresh));
  restored.rollbackTo(restored.height - 6);
  fresh.rollbackTo(fresh.height - 6);
  assert.deepEqual(fingerprint(restored), fingerprint(fresh));
  assert.deepEqual([...restored.digests], [...fresh.digests]);
});

test("restore refuses activations that differ at or below the snapshot height, and unknown versions", async () => {
  const pow = ctlPow();
  const { idx } = await minedChain({ start: 1_050_000, pow });
  const snap = JSON.parse(JSON.stringify(idx.snapshot()));
  assert.equal(snap.version, 3);
  const act = 1_050_001;
  assert.throws(() => Indexer.restore(snap, { vkey: VKEY, activations: mining(null) }), /snapshot activations differ/);
  assert.throws(() => Indexer.restore(snap, { vkey: VKEY, activations: mining(act + 1) }), /snapshot activations differ/);
  assert.throws(() => Indexer.restore(snap, { vkey: VKEY }), /snapshot activations differ/, "the pinned table differs");
  assert.doesNotThrow(() => Indexer.restore(snap, { vkey: VKEY, activations: mining(act), pow }));
  assert.throws(() => Indexer.restore({ ...snap, version: 1 }, { vkey: VKEY }), /unsupported snapshot version/);
  assert.throws(() => Indexer.restore({ ...snap, version: 4 }, { vkey: VKEY }), /unsupported snapshot version/);
  assert.throws(() => Indexer.restore({ ...snap, digestVersion: 1 }, { vkey: VKEY, activations: mining(act) }), /unsupported digest version/);
  assert.throws(() => Indexer.restore({ ...snap, mine: { ...snap.mine, mineAcc: "11".repeat(32) } }, { vkey: VKEY, activations: mining(act), pow }), /digest mismatch/);

  // A v2 snapshot from below a scheduled activation restores under a later (or no) schedule too.
  const low = new Indexer({ vkey: VKEY, startHeight: 1_060_000, activations: mining(1_060_100) });
  await low.applyBlock({ height: 1_060_000, hash: h32(), txs: [coinbase()] });
  const v2 = JSON.parse(JSON.stringify(low.snapshot()));
  assert.equal(v2.version, 2);
  assert.doesNotThrow(() => Indexer.restore(v2, { vkey: VKEY, activations: mining(1_060_050) }));
  assert.doesNotThrow(() => Indexer.restore(v2, { vkey: VKEY, activations: mining(null) }));
  assert.throws(() => Indexer.restore(v2, { vkey: VKEY, activations: mining(1_060_000) }), /snapshot activations differ/);
  assert.throws(() => Indexer.restore(v2, { vkey: VKEY }), /snapshot activations differ/, "the pinned height lies below this snapshot");
  assert.throws(() => Indexer.restore({ ...v2, digestVersion: 2 }, { vkey: VKEY, activations: mining(null) }), /unsupported digest version/);
});

test("my files keep their line endings and are English only", () => {
  const crlf = ["src/indexer.mjs", "src/envelope.mjs"];
  const lf = ["src/params.mjs", "src/pins.json", "src/mine.mjs", "src/pow-pool.mjs", "src/pow-worker.mjs", "SPEC.md", "THIRD_PARTY_NOTICES.md", "package.json", "test/fixtures/v1-chain.json", "test/fixtures/mine-vectors.json", "test/mine-indexer.test.mjs", "test/mine-vectors.test.mjs"];
  for (const f of [...crlf, ...lf]) {
    const b = readFileSync(f, "utf8");
    const lines = b.split("\n").length - 1;
    const crlfs = b.split("\r\n").length - 1;
    if (crlf.includes(f)) assert.equal(crlfs, lines, `${f}: CRLF`);
    else assert.equal(crlfs, 0, `${f}: LF`);
    assert.ok(b.endsWith("\n"), `${f}: final newline`);
    assert.ok(!CYRILLIC.test(b), `${f}: English only`);
  }
  assert.match(readFileSync("src/pins.json", "utf8"), /"name": "mining",\s+"height": 325138,/, "the owner's pin");
});

// Mining end to end (docs/design/mining.md, binding contract docs/design/mining-contract.md): one
// synthetic chain with an explicit test activation height (not the pinned one in src/pins.json), the paid
// relayer over FakeEsplora, real Groth16 proofs and real Argon2id ground in the worker pool at the
// protocol's difficulty floor region.
//
//   - below activation, mining ops are unknown ops and every digest equals the pre-mining code's;
//   - a mined token is deployed; claims are self-paid (MINE bound to a coin of the built-in mining
//     key) and carried by the relay balance (MINE_SCRIPT bound to the relayer's change key C), each
//     paying the 500-sat platform fee; the indexer accepts them and the rewards land in shielded
//     notes the wallet finds, rolls into one note and spends;
//   - a copy in another transaction, a wrong fee output, a re-proved (duplicate) solution, a stale
//     reference and a claim beyond the supply cap are rejected, and the relayer refuses the
//     duplicate, the stale claim and the over-cap claim before charging anything;
//   - the difficulty follows the per-block moving average exactly, block after block;
//   - the relay books satisfy I2 and every satoshi that left the relayer's pool was debited from
//     the miner's relay balance first: the operator paid nothing.
//
// Nothing is broadcast for real (FakeEsplora), nothing touches data/, and the relayer lives in a
// temporary directory.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as snarkjs from "snarkjs";
import { sha256 } from "@noble/hashes/sha256";
import {
  VKEY, booksMod, fundAccount, hash32, makeFakeEsplora, makePaidRelayer, newAccount, poolCoins, signedSubmit, txOf,
} from "./fixtures/relay-harness.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { Wallet, DEFAULT_ARTIFACTS, anchorAt } from "../src/wallet.mjs";
import { deriveKeys, feeKeysOf } from "../src/keys.mjs";
import { buildTxInput } from "../src/core.mjs";
import { OP, decodeEnvelope, encodeDeploy, encodeDeployPow, encodeTxBody, extDataHashOf, opReturnScript } from "../src/envelope.mjs";
import { encodeProof } from "../src/proof-codec.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { btcAccount, carrierAmountOf, planCarrierTx, signLocal } from "../src/btc/funding.mjs";
import { concat, hex, outpointOf, readU32le, unhex } from "../src/bytes.mjs";
import { D_MAX, MINE_FEE, MINE_WINDOW, MIN_DIFFICULTY, STALE_FACTOR } from "../src/params.mjs";
import * as M from "../src/mine.mjs";
import { createNodePowPool } from "../src/pow-pool.mjs";

const { marginFor } = booksMod;

const START = 930_000;
const ACT = START + 3; // the test activation height
const ACTIVE = [{ name: "mining", height: ACT, digestV: 2 }];
const UNSCHEDULED = [{ name: "mining", height: null, digestV: 2 }]; // the pre-mining rules at every height
const PLATFORM = unhex(MINE_FEE.platformScript);
const SERVICE = Number(MINE_FEE.platformSats); // 500
const REWARD = 1000n;
const MAX_SUPPLY = 4000n; // four claims
const TERMS = {
  ticker: "DIGE2E", divisibility: 0, reward: REWARD, maxSupply: MAX_SUPPLY, span: 12, targetPerSpan: 16,
  initialDifficulty: 512n, minDifficulty: MIN_DIFFICULTY,
};
const TAU = BigInt(TERMS.span);
const S = BigInt(TERMS.targetPerSpan);
const anyIp = () => `203.0.113.${1 + (randomBytes(1)[0] % 250)}`;
const coinbase = () => ({ txid: hash32(), inputs: [], outputs: [] });
/** A transaction someone posts with `payload` in its OP_RETURN (indexer form; for the blocks below activation). */
const plain = (payload) => ({ txid: hash32(), inputs: [{ outpoint: new Uint8Array(randomBytes(36)) }], outputs: [{ script: opReturnScript(payload), value: 0n }] });

/* ---------- the world ---------- */

const W = {}; // shared state across the sequential tests below
const blocks = []; // every block as applied, for the identity replay

after(async () => {
  W.r?.close();
  if (W.r?.harnessDir) rmSync(W.r.harnessDir, { recursive: true, force: true });
  await W.pool?.close();
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

/** Applies one block (coinbase + txs) to the indexer, confirms the txs in the fake, ticks the relayer. */
async function mine(txs = []) {
  const { idx, esplora } = W;
  const height = idx.height + 1;
  const block = { height, hash: hash32(), txs: [coinbase(), ...txs] };
  await idx.applyBlock(block);
  blocks.push(block);
  esplora.confirm(txs.map((t) => t.txid), height);
  esplora.tip = Math.max(esplora.tip, height);
  if (W.r) await W.r.onTick({ chainTip: idx.height });
  if (W.asset != null) trackDifficulty(block);
  return height;
}

/** Raw transactions (hex) as the indexer reads them from a block. */
const fromRaw = (...raws) => raws.map((raw) => parseRawTx(raw));

/** The relayer's carrier of `envelope` in the fake's broadcasts, or null. */
const relayCarrierOf = (envelope) => {
  const want = hex(opReturnScript(envelope));
  const raw = W.esplora.accepted.find((x) => hex(txOf(x).getOutput(0).script) === want);
  return raw ?? null;
};

/** A coin of the built-in mining key (feeKeysOf().mineFeeKey), confirmed on the fake chain. */
function mineCoin(value = 20_000, account = W.mineAcct) {
  const txid = W.esplora.pay([{ script: account.script, value }], { height: W.idx.height });
  return { txid, vout: 0, value };
}

/** A self-paid claim carrier: first input = the bound coin, then the service-fee output(s), change back. */
async function selfCarrier(envelope, coin, { fee = [{ script: PLATFORM, amount: carrierAmountOf(PLATFORM, MINE_FEE.platformSats) }], key = W.mineKey, account = W.mineAcct } = {}) {
  const { tx } = planCarrierTx({ account, utxos: [coin], envelope, outputs: fee, feeRate: 2, firstInput: coin, sequence: 0xfffffffd });
  const signed = signLocal(tx, key);
  await W.esplora.broadcast(signed.hex);
  return signed.hex;
}

/** Real Argon2id in the worker pool (the CLI miner's path): a nonce meeting `difficulty` for the draft's challenge. */
async function grind(challenge, difficulty) {
  const target = M.targetOf(difficulty);
  for (let round = 0; round < 10_000; round++) {
    const starts = Array.from({ length: W.pool.size }, () => BigInt(`0x${randomBytes(8).toString("hex")}`));
    const found = (await Promise.all(starts.map((nonceStart) => W.pool.grind({ challenge, target, nonceStart, count: 64 })))).find((r) => r.nonce);
    if (found) {
      // The reference implementation agrees with the fast path (the wallet's re-check before paying).
      assert.ok(M.meetsTarget(M.powHashReference(M.passwordOf(challenge, found.nonce)), target), "the reference Argon2id agrees");
      return found.nonce;
    }
  }
  throw new Error("no solution found");
}

/** A fresh claim draft at the tip (the wallet API) and a nonce for it at the difficulty its reference block sets. */
async function solved(wallet, { roll = false, ref = W.idx.height } = {}) {
  const draft = wallet.prepareClaim(W.idx, { asset: W.asset, reward: W.idx.rewardAt(W.asset, ref), refHeight: ref, refHash: W.idx.hashes.get(ref), roll });
  const nonce = await grind(draft.challenge, W.idx.difficultyAt(W.asset, ref));
  return { draft, nonce };
}

/**
 * The same solution re-proved: the draft's outputs (so the same commitments, challenge and
 * solutionId), fresh dummy inputs (so other nullifiers), another bind. Only the miner can do this.
 */
async function reprove(draft, bind, nonce) {
  const input = draft[Object.getOwnPropertySymbols(draft)[0]];
  const outs = input.outAmount.map((a, i) => ({ amount: BigInt(a), pubkey: BigInt(input.outPubkey[i]), blinding: BigInt(input.outBlinding[i]) }));
  const { tree } = anchorAt(W.idx, draft.refHeight);
  const fresh = buildTxInput({ tree, asset: draft.asset, publicAmount: draft.reward, publicAsset: draft.asset, extDataHash: 0n, inputs: [], outputs: outs });
  assert.deepEqual(fresh.outputCommitment.map(BigInt), draft.commitments, "same outputs, same commitments");
  const body = encodeTxBody({
    op: bind.bindOutpoint ? OP.MINE : OP.MINE_SCRIPT, anchor: draft.refHeight, publicAsset: draft.asset, publicAmount: draft.reward, ...bind, nonce,
    nullifiers: fresh.inputNullifier.map(BigInt), commitments: draft.commitments, ciphertexts: draft.ciphertexts,
  });
  const { proof } = await snarkjs.groth16.fullProve({ ...fresh, extDataHash: extDataHashOf(body).toString() }, DEFAULT_ARTIFACTS.wasm, DEFAULT_ARTIFACTS.zkey);
  return concat(body, encodeProof(proof));
}

const submit = (account, envelope, mode = "block") => W.r.submit(signedSubmit(account, W.r.info(), envelope, mode), anyIp());
const verdict = (txid) => W.idx.log.find((e) => e.txid === txid);
const balanceOf = (account) => W.r.books.account(account.idHex).balance;

/* ---------- the difficulty, recomputed independently (mining.md §6.1, §6.2) ---------- */

const D = new Map(); // height -> expected D(height)
const stepD = (prev, work) => {
  const next = (prev * (TAU - 1n) * S + work * TAU) / (TAU * S);
  const floored = next < TERMS.minDifficulty ? TERMS.minDifficulty : next;
  return floored > D_MAX ? D_MAX : floored;
};
const expectedD = (h) => {
  let best = null;
  for (const [k, v] of D) if (k <= h && (best === null || k > best[0])) best = [k, v];
  let [k, v] = best;
  while (k < h) {
    v = stepD(v, 0n);
    k += 1;
  }
  return v;
};

/** After each block from the mining start on: D_eff of each accepted claim and the new D(H), as the formulas say. */
function trackDifficulty(block) {
  const a = W.idx.assets.get(W.asset);
  const H = block.height;
  if (H <= a.mineStart) {
    D.set(H, TERMS.initialDifficulty);
    assert.equal(W.idx.difficultyAt(W.asset, H), TERMS.initialDifficulty, `D(${H}) before the mining start is the initial difficulty`);
    return;
  }
  let work = 0n;
  for (const e of W.idx.log.filter((l) => l.height === H && l.ok && (l.opName === "MINE" || l.opName === "MINE_SCRIPT"))) {
    const stale = expectedD(H - 1) / BigInt(STALE_FACTOR);
    const dRef = expectedD(e.ref);
    const dEff = dRef > stale ? dRef : stale;
    assert.equal(e.difficulty, String(dEff), `D_eff of the claim in ${e.txid}`);
    work += dEff;
  }
  const want = stepD(expectedD(H - 1), work);
  D.set(H, want);
  assert.equal(W.idx.difficultyAt(W.asset, H), want, `D(${H}) after ${work} counted work`);
  W.dTrace.push([H, work, want]);
}

/* ---------- setup: the chain below activation, the relayer, the deploy, the mining start ---------- */

before(async () => {
  W.esplora = makeFakeEsplora({ fee: 1 });
  W.pool = await createNodePowPool({ size: 2 });
  await W.pool.ready();
  W.idx = new Indexer({ vkey: VKEY, startHeight: START, activations: ACTIVE, pow: W.pool });
  // MINE_SCRIPT binds through the spent output's script: read from the fake's raw transactions.
  W.idx.prevoutScript = async (outpoint) => {
    const txid = hex(Uint8Array.from(outpoint.slice(0, 32)).reverse());
    const raw = W.esplora.txs.get(txid);
    if (!raw) throw new Error(`GET /tx/${txid}/hex: 404`);
    return parseRawTx(raw).outputs[readU32le(outpoint, 32)].script;
  };
  W.dTrace = [];

  // Below activation: a paid-mint DEPLOY (v1), and mining ops that every replayer logs as unknown.
  await mine();
  W.preDeployPow = plain(encodeDeployPow(TERMS)); // the same ticker as the real launch below
  W.preMine = plain(concat(encodeTxBody({
    op: OP.MINE, anchor: START, publicAsset: 1n, publicAmount: REWARD, bindOutpoint: new Uint8Array(36), nonce: new Uint8Array(8),
    nullifiers: [1n, 2n], commitments: [3n, 4n], ciphertexts: [new Uint8Array(95), new Uint8Array(95)],
  }), new Uint8Array(128)));
  W.preTruncated = plain(new Uint8Array([0x6d, 0x72, 0x6b, 0x00, 0x09, 0x01, 0x02]));
  W.paidDeploy = plain(encodeDeploy({ ticker: "PAIDE2E", divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() }));
  await mine([W.paidDeploy, W.preDeployPow, W.preMine, W.preTruncated]);

  // The relayer, a funded relay account for the miner, confirmed pool coins at C.
  W.r = await makePaidRelayer({ idx: W.idx, esplora: W.esplora });
  await W.r.onTick({ chainTip: W.idx.height });
  await mine();
  assert.equal(W.idx.height, ACT - 1);
  W.poolCoins = (await poolCoins({ relayer: W.r, esplora: W.esplora, values: [20_000, 20_000, 20_000] })).outpoints;
  W.relayAccount = newAccount();
  const f = await fundAccount({ relayer: W.r, esplora: W.esplora, account: W.relayAccount, sats: 30_000 });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  W.funded = balanceOf(W.relayAccount);

  // The miner: shielded keys, and the built-in mining fee key apart from the transfer fee key.
  const entropy = new Uint8Array(randomBytes(32));
  W.miner = new Wallet(deriveKeys(entropy));
  const { feeKey, mineFeeKey } = feeKeysOf(entropy);
  assert.notEqual(hex(feeKey), hex(mineFeeKey));
  W.mineKey = mineFeeKey;
  W.mineAcct = btcAccount(mineFeeKey);
  W.feeKey = feeKey;
  W.feeAcct = btcAccount(feeKey);
  W.miner2 = new Wallet(deriveKeys(new Uint8Array(randomBytes(32))));
  W.miner3 = new Wallet(deriveKeys(new Uint8Array(randomBytes(32))));
  W.bob = new Wallet(deriveKeys(new Uint8Array(randomBytes(32))));

  // The launch, at the activation height.
  W.deployPow = plain(encodeDeployPow(TERMS));
  await mine([W.deployPow]);
  assert.equal(W.idx.height, ACT);
  W.asset = assetIdOf(ACT, 1);
  W.mineStart = W.idx.assets.get(W.asset).mineStart;
  trackDifficulty(blocks.at(-1)); // the launch block, mined before W.asset was known: mining opens there
  while (W.idx.height < W.mineStart) await mine();
});

/* ---------- 1. activation and the launch ---------- */

test("below activation the mining ops are unknown ops; at activation the DEPLOY_POW launches the mined token", () => {
  const { idx } = W;
  for (const [t, op] of [[W.preDeployPow, 9], [W.preMine, 7], [W.preTruncated, 9]]) {
    const e = verdict(t.txid);
    assert.deepEqual([e.ok, e.opName, e.reason], [false, "UNKNOWN", `malformed: unknown op ${op}`]);
  }
  assert.equal(verdict(W.paidDeploy.txid).ok, true);
  const e = verdict(W.deployPow.txid);
  assert.deepEqual([e.ok, e.opName, e.ticker], [true, "DEPLOY_POW", TERMS.ticker], "the pre-activation DEPLOY_POW claimed no ticker");
  const a = idx.assets.get(W.asset);
  assert.equal(a.kind, "pow");
  assert.equal(a.mineStart, ACT, "started now: the launch block itself is the first usable reference");
  assert.equal(M.mineStatus(a, idx.height), "mining");
  assert.equal(idx.digestVersionAt(ACT - 1), 1);
  assert.equal(idx.digestVersionAt(ACT), 2);
  assert.deepEqual(idx.requiredFeeOutputs(W.asset).map((o) => [hex(o.script), o.sats, o.role]), [[MINE_FEE.platformScript, 500n, "platform"]]);
  // The relayer takes claims bound to its change key.
  const info = W.r.info().mine;
  assert.equal(info.enabled, true, JSON.stringify(info));
  assert.match(info.bindScriptHash ?? "", /^[0-9a-f]{64}$/);
  assert.equal(info.bindScriptHash, hex(sha256(W.r.change.script)), "bound to sha256(C)");
  W.bindC = unhex(info.bindScriptHash);
});

/* ---------- 2. two claims land: one self-paid (MINE), one relayed (MINE_SCRIPT) ---------- */

test("a self-paid MINE and a relayed MINE_SCRIPT, each with the platform fee output, are accepted; a copy and a short fee are rejected", async () => {
  const { idx } = W;
  const ref = idx.height; // = mineStart
  assert.equal(ref, W.mineStart);

  // A: self-paid, bound to a coin of the mining key chosen after the work.
  W.A = await solved(W.miner);
  W.coinA = mineCoin();
  W.envA = await W.miner.finalizeClaim(W.A.draft, { bindOutpoint: outpointOf(W.coinA.txid, W.coinA.vout) }, W.A.nonce);
  assert.equal(W.envA.length, 515);

  // R: relayed, bound to sha256(C), carried by the relay balance.
  W.R = await solved(W.miner);
  W.envR = await W.miner.finalizeClaim(W.R.draft, { bindScriptHash: W.bindC }, W.R.nonce);
  assert.equal(W.envR.length, 511);
  const before = balanceOf(W.relayAccount);
  const out = await submit(W.relayAccount, W.envR);
  assert.equal(out.status, 202, JSON.stringify(out.body));
  assert.deepEqual([out.body.kind, out.body.ref, out.body.lastBroadcast, out.body.deadline, out.body.serviceSats], ["mine", ref, ref + 9, ref + MINE_WINDOW, String(SERVICE)]);
  assert.equal(out.body.solutionId, idx.claimOf(decodeEnvelope(W.envR)).solutionIdHex);
  assert.equal(balanceOf(W.relayAccount), before - out.body.reservedSats, "the quote is reserved before anything is signed");
  W.relayR = out.body.id;

  // Block mineStart + 1: A copied into someone else's transaction, and claim F paying 499 of 500 sats.
  const thiefKey = new Uint8Array(randomBytes(32));
  const thief = btcAccount(thiefKey);
  const copyRaw = await selfCarrier(W.envA, mineCoin(20_000, thief), { key: thiefKey, account: thief });
  W.F = await solved(W.miner);
  const coinF = mineCoin();
  W.envF = await W.miner.finalizeClaim(W.F.draft, { bindOutpoint: outpointOf(coinF.txid, coinF.vout) }, W.F.nonce);
  const shortRaw = await selfCarrier(W.envF, coinF, { fee: [{ script: PLATFORM, amount: 499n }] });
  [W.copyTx, W.shortTx] = fromRaw(copyRaw, shortRaw);
  await mine([W.copyTx, W.shortTx]);
  assert.equal(verdict(W.copyTx.txid).reason, "MINE not bound to this transaction");
  assert.equal(verdict(W.shortTx.txid).reason, `underpaid service fee: 499 < 500 sats to ${MINE_FEE.platformScript}`);
  for (const n of [...decodeEnvelope(W.envA).nullifiers, ...decodeEnvelope(W.envF).nullifiers]) assert.equal(idx.nullifiers.has(String(n)), false, "a rejected claim spends nothing");
  assert.equal(idx.claimed.size, 0);

  // The relayer carried R after that block: OP_RETURN, the platform fee from its own indexer, change to C.
  const rawR = relayCarrierOf(W.envR);
  assert.ok(rawR, "the relayer broadcast R's carrier");
  const txR = txOf(rawR);
  assert.equal(txR.outputsLength, 3);
  // L5: the change to C takes a random slot after the OP_RETURN; the fee output is the other one.
  const changeAt = [1, 2].filter((v) => hex(txR.getOutput(v).script) === hex(W.r.change.script));
  assert.equal(changeAt.length, 1, "one change output to C");
  const feeAt = 3 - changeAt[0];
  assert.deepEqual([hex(txR.getOutput(feeAt).script), txR.getOutput(feeAt).amount], [MINE_FEE.platformScript, 500n]);
  assert.ok(W.poolCoins.includes(`${hex(txR.getInput(0).txid)}:${txR.getInput(0).index}`), "funded from a confirmed pool coin");

  // Block mineStart + 2: A (its own coin first), A re-proved under another bind (the same solution), and R.
  const rawA = await selfCarrier(W.envA, W.coinA);
  const coinDup = mineCoin();
  W.envDup = await reprove(W.A.draft, { bindOutpoint: outpointOf(coinDup.txid, coinDup.vout) }, W.A.nonce);
  const rawDup = await selfCarrier(W.envDup, coinDup);
  [W.txA, W.txDup, W.txR] = fromRaw(rawA, rawDup, rawR);
  await mine([W.txA, W.txDup, W.txR]);
  for (const t of [W.txA, W.txR]) {
    const e = verdict(t.txid);
    assert.deepEqual([e.ok, e.reason, e.asset, e.amount, e.ref], [true, undefined, String(W.asset), String(REWARD), ref], JSON.stringify(e));
    assert.equal(e.recipient, undefined, "a log entry never names a recipient");
  }
  assert.equal(verdict(W.txA.txid).opName, "MINE");
  assert.equal(verdict(W.txR.txid).opName, "MINE_SCRIPT");
  assert.equal(verdict(W.txDup.txid).reason, "solution already claimed");
  assert.equal(W.r.status(W.relayR).status, "accepted");
  for (const t of [W.txA, W.txR]) {
    const platform = t.outputs.filter((o) => hex(o.script) === MINE_FEE.platformScript);
    assert.deepEqual(platform.map((o) => BigInt(o.value)), [500n], "exactly the platform fee");
  }

  // The rewards are shielded notes the miner's wallet finds.
  W.miner.scan(idx);
  assert.equal(W.miner.balance(W.asset), 2n * REWARD);
  assert.equal(W.miner.spendable(W.asset).length, 2);
  const a = idx.assets.get(W.asset);
  assert.deepEqual([a.claims, a.issued, a.rejectedClaims], [2, 2n * REWARD, 3]);
  assert.equal(a.feeSats, 1000n, "the platform fee of the two accepted claims");
  assert.equal(a.burnedFeeSats, 500n + 499n + 500n, "copy, short fee and duplicate: their fee outputs are spent for nothing");
});

/* ---------- 3. the relayer refuses certain failures before charging ---------- */

test("the relayer refuses a duplicate solution (solution_claimed) and a stale reference (expired) without charging", async () => {
  const before = balanceOf(W.relayAccount);
  const dupC = await reprove(W.A.draft, { bindScriptHash: W.bindC }, W.A.nonce);
  const dup = await submit(W.relayAccount, dupC);
  assert.deepEqual([dup.status, dup.body.error?.code], [409, "solution_claimed"], JSON.stringify(dup.body));
  assert.equal(balanceOf(W.relayAccount), before);

  // A claim held until too late: ref = tip, submitted once tip > ref + 9.
  W.Stale = await solved(W.miner);
  W.envStale = await W.miner.finalizeClaim(W.Stale.draft, { bindScriptHash: W.bindC }, W.Stale.nonce);
  W.staleRef = W.idx.height;
  // Meanwhile a claim that rolls both reward notes into one (W-M locks them while it is pending).
  const C3 = await solved(W.miner, { roll: true });
  assert.equal(C3.draft.rolled.length, 2);
  assert.equal(C3.draft.rolledAmount, 2n * REWARD);
  W.miner.lockClaim(C3.draft);
  assert.equal(W.miner.spendable(W.asset).length, 0, "rolled notes are locked while the claim is pending");
  const coin3 = mineCoin();
  const env3 = await W.miner.finalizeClaim(C3.draft, { bindOutpoint: outpointOf(coin3.txid, coin3.vout) }, C3.nonce);
  const [tx3] = fromRaw(await selfCarrier(env3, coin3));
  await mine([tx3]);
  assert.equal(verdict(tx3.txid).ok, true, JSON.stringify(verdict(tx3.txid)));
  W.miner.unlockClaim(C3.draft);
  W.miner.scan(W.idx);
  assert.equal(W.miner.balance(W.asset), 3n * REWARD);
  assert.equal(W.miner.spendable(W.asset).length, 1, "one note however many claims landed");
  for (const n of C3.draft.rolled) assert.equal(W.idx.nullifiers.has(n), true, "the rolled notes are spent");
  assert.equal(W.idx.assets.get(W.asset).issued, 3n * REWARD, "issued grows by the reward only");

  // Quiet blocks: the difficulty decays toward the floor (checked block by block in mine()).
  while (W.idx.height < W.staleRef + 10) await mine();
  const late = await submit(W.relayAccount, W.envStale);
  assert.deepEqual([late.status, late.body.error?.code], [422, "expired"], JSON.stringify(late.body));
  assert.equal(balanceOf(W.relayAccount), before, "nothing charged");

  // Posted anyway after its 12-block window: rejected on chain.
  while (W.idx.height < W.staleRef + MINE_WINDOW) await mine();
  const [txStale] = fromRaw(await selfCarrier(W.envStale, mineCoin()));
  await mine([txStale]);
  assert.equal(verdict(txStale.txid).reason, "reference outside window");
});

/* ---------- 4. the supply cap ---------- */

test("near the cap the relayer counts claims in flight (cap_reached); a claim landing after the cap is rejected and its fee burned", async () => {
  const { idx } = W;
  assert.equal(idx.assets.get(W.asset).issued, 3n * REWARD);
  const before = balanceOf(W.relayAccount);
  // X fills the supply; Y would be one too many once X is counted in flight.
  const X = await solved(W.miner2);
  const envX = await W.miner2.finalizeClaim(X.draft, { bindScriptHash: W.bindC }, X.nonce);
  const outX = await submit(W.relayAccount, envX);
  assert.equal(outX.status, 202, JSON.stringify(outX.body));
  const Y = await solved(W.miner3);
  const envY = await W.miner3.finalizeClaim(Y.draft, { bindScriptHash: W.bindC }, Y.nonce);
  const outY = await submit(W.relayAccount, envY);
  assert.deepEqual([outY.status, outY.body.error?.code], [409, "cap_reached"], JSON.stringify(outY.body));
  assert.equal(balanceOf(W.relayAccount), before - outX.body.reservedSats, "Y charged nothing");

  await mine(); // the relayer signs and broadcasts X after this block
  const rawX = relayCarrierOf(envX);
  assert.ok(rawX);
  // Y's miner pays the same solution himself; it lands after X in the same block.
  const coin5 = mineCoin(20_000, W.mineAcct);
  const env5 = await W.miner3.finalizeClaim(Y.draft, { bindOutpoint: outpointOf(coin5.txid, coin5.vout) }, Y.nonce);
  const [txX, tx5] = fromRaw(rawX, await selfCarrier(env5, coin5));
  await mine([txX, tx5]);
  assert.equal(verdict(txX.txid).ok, true, JSON.stringify(verdict(txX.txid)));
  assert.equal(verdict(tx5.txid).reason, "supply cap reached");
  const a = idx.assets.get(W.asset);
  assert.equal(a.issued, MAX_SUPPLY);
  assert.equal(M.mineStatus(a, idx.height), "mined-out");
  assert.equal(a.burnedFeeSats, 500n + 499n + 500n + 500n + 500n, "copy, short, duplicate, stale and over-cap");
  assert.equal(a.rejectedClaims, 5);
  assert.equal(a.claims, 4);
  assert.equal(a.feeSats, 2000n);
  W.miner2.scan(idx);
  assert.equal(W.miner2.balance(W.asset), REWARD);
  W.miner3.scan(idx);
  assert.equal(W.miner3.balance(W.asset), 0n, "the over-cap claim paid nothing");
});

/* ---------- 5. the difficulty, the wallet spend, the books ---------- */

test("the difficulty moved exactly as the per-block moving average says, up with claims and down when quiet", () => {
  const trace = W.dTrace;
  assert.ok(trace.length >= 15);
  const ups = trace.filter(([h, w], i) => i > 0 && w > 0n && trace[i][2] > trace[i - 1][2]);
  const downs = trace.filter(([h, w], i) => i > 0 && w === 0n && trace[i][2] < trace[i - 1][2]);
  assert.ok(ups.length >= 1, `a block with claims raised D: ${JSON.stringify(trace, (k, v) => (typeof v === "bigint" ? String(v) : v))}`);
  assert.ok(downs.length >= 3, "quiet blocks lowered D");
  assert.ok(trace.some(([, , d]) => d === MIN_DIFFICULTY), "and it stopped at the floor");
  // The first claim block: two claims at D(ref) = 512 after a quiet block at 469.
  const [, w2, d2] = trace[1];
  assert.equal(trace[0][2], (512n * 11n) / 12n);
  assert.equal(w2, 1024n);
  assert.equal(d2, (469n * 11n * 16n + 1024n * 12n) / 192n);
});

test("the mined reward is spendable: a private transfer from the rolled note lands and the recipient finds it", async () => {
  const { idx } = W;
  W.miner.scan(idx);
  const env = await W.miner.transfer(idx, { asset: W.asset, amount: 1200n, to: W.bob.address });
  // The transfer is paid from the transfer fee key, never from mining coins.
  const coin = { txid: W.esplora.pay([{ script: W.feeAcct.script, value: 10_000 }], { height: idx.height }), vout: 0, value: 10_000 };
  const { tx } = planCarrierTx({ account: W.feeAcct, utxos: [coin], envelope: env, feeRate: 2 });
  const signed = signLocal(tx, W.feeKey);
  await W.esplora.broadcast(signed.hex);
  const [t] = fromRaw(signed.hex);
  await mine([t]);
  assert.equal(verdict(t.txid).ok, true, JSON.stringify(verdict(t.txid)));
  W.bob.scan(idx);
  W.miner.scan(idx);
  assert.equal(W.bob.balance(W.asset), 1200n);
  assert.equal(W.miner.balance(W.asset), 3n * REWARD - 1200n);
});

test("relay books satisfy I2 and the operator paid nothing: every sat that left the pool was debited from the miner first", () => {
  const books = W.r.checkBooks();
  assert.equal(books.ok, true, books.problems?.join("; "));
  const cfg = { marginPct: W.r.config.marginPct, marginMinSats: W.r.config.marginMinSats };
  const rows = W.r.ledgerView({ limit: 500 }).items.filter((l) => l.kind === "carrier");
  assert.equal(rows.length, 2, "R and X");
  let spent = 0;
  let cost = 0;
  for (const row of rows) {
    assert.deepEqual([row.outcome, row.serviceSats], ["accepted", SERVICE]);
    const raw = W.esplora.txs.get(row.txid);
    const tx = txOf(raw);
    const inputs = [];
    for (let i = 0; i < tx.inputsLength; i++) {
      const prev = parseRawTx(W.esplora.txs.get(hex(tx.getInput(i).txid))).outputs[tx.getInput(i).index];
      inputs.push(Number(prev.value));
    }
    let toC = 0;
    for (let v = 0; v < tx.outputsLength; v++) if (hex(tx.getOutput(v).script) === hex(W.r.change.script)) toC += Number(tx.getOutput(v).amount);
    const left = inputs.reduce((s, x) => s + x, 0) - toC;
    assert.equal(left, row.fee + SERVICE, "the pool lost exactly the miner fee and the service fee");
    spent += left;
    cost += row.fee + SERVICE + marginFor(row.fee, cfg);
  }
  assert.equal(W.funded - balanceOf(W.relayAccount), cost, "the miner's balance paid fee + service + margin for each carried claim, and nothing for refusals");
  assert.ok(cost >= spent, "debits cover every sat that left the pool");
  assert.equal(W.r.books.serviceOut, 2 * SERVICE);
});

/* ---------- 6. the digest below activation equals the pre-mining code's ---------- */

test("below activation every digest equals the pre-mining code's on the same blocks; from activation it is v2", async (t) => {
  const below = blocks.filter((b) => b.height < ACT);
  assert.ok(below.some((b) => b.txs.length > 3), "the replay covers mining ops posted below activation");
  // The same blocks through this code with mining unscheduled.
  const off = new Indexer({ vkey: VKEY, startHeight: START, activations: UNSCHEDULED });
  for (const b of below) await off.applyBlock(b);
  for (const b of below) assert.equal(W.idx.digestAt(b.height), off.digestAt(b.height), `digest at ${b.height}`);
  assert.notEqual(W.idx.digestAt(ACT), null);

  // The pre-mining code itself (its src/ copied under node_modules/.cache, mining-contract.md §7.2).
  const dir = process.env.MURKLE_PRE_MINING_SRC ?? "node_modules/.cache/murkle-pre-mining/src";
  if (!existsSync(`${dir}/indexer.mjs`)) return t.skip("no copy of the pre-mining src/ (set MURKLE_PRE_MINING_SRC)");
  const { Indexer: Old } = await import(pathToFileURL(resolve(dir, "indexer.mjs")).href);
  const old = new Old({ vkey: VKEY, startHeight: START });
  for (const b of below) await old.applyBlock(b);
  for (const b of below) assert.equal(W.idx.digestAt(b.height), old.digestAt(b.height), `pre-mining digest at ${b.height}`);
  const strip = (l) => l.filter((e) => e.height < ACT).map((e) => JSON.stringify(e));
  assert.deepEqual(strip(W.idx.log), strip(old.log), "the same log below activation");
});

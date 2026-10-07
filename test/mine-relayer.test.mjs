// Relayer track of the mining build (docs/design/mining.md §9, binding contract
// docs/design/mining-contract.md §9 and §13 "relayer"): relayed MINE_SCRIPT claims bound to the
// change key C, their service-fee outputs, I-PAY with service fees (I0, I1, I2 and serviceOut),
// the 12-block deadlines, the cap with claims in flight, the Argon2 worker pool, info.mine, the
// mining API endpoints and books written before mining.
//
// Fakes only: FakeEsplora (nothing real is broadcast, no address is listed), a fake Argon2 pool
// (the relayer never hashes on its own thread), synthetic blocks with an explicit test activation
// height (and one test at the pinned height, src/pins.json), and synthetic claims whose Groth16 check is a registry.
// Temporary directories only; nothing touches data/signet/.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { createHash, randomBytes as nodeRandom } from "node:crypto";
import {
  TestIndexer, booksMod, fundAccount, hash32, makeFakeEsplora, makePaidRelayer, newAccount, poolCoins, relayerMod, serverMod,
  signedSubmit, silent, synth, txOf,
} from "./fixtures/relay-harness.mjs";
import { OP, decodeEnvelope, encodeDeployPow, encodeTxBody, envelopeLen, opReturnScript } from "../src/envelope.mjs";
import { ACTIVATIONS, MINE_FEE, MINE_SLACK, MINE_WINDOW, MINING_HEIGHT } from "../src/params.mjs";
import { inlinePow, targetOf } from "../src/mine.mjs";
import { NOTE_CT_LEN } from "../src/keys.mjs";
import { randomField } from "../src/core.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { bigToBytes, concat, hex, readU32le, unhex } from "../src/bytes.mjs";
import { btcAccount, planCarrierTx } from "../src/btc/funding.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { depositAddress } from "../src/relay-account.mjs";

const { DEFAULTS, ERROR_STATUS, MESSAGES, codeForReason, parseSubmit, readConfig, balanceProblems } = relayerMod;
const { RelayBooks, marginFor } = booksMod;
const { createApp } = serverMod;

const START = 910_000;
const ACT = START + 2; // the test activation height (the pinned one, src/pins.json, lies far below START)
const activations = (height = ACT) => [{ name: "mining", height, digestV: 2 }];
const rand = (n) => new Uint8Array(nodeRandom(n));
const sha256 = (b) => new Uint8Array(createHash("sha256").update(b).digest());
const PLATFORM = unhex(MINE_FEE.platformScript);
const ZERO = new Uint8Array(32); // meets every target
const FF = new Uint8Array(32).fill(0xff); // meets none
const code = (out) => out.body?.error?.code;
const anyIp = () => `203.0.${nodeRandom(1)[0]}.${1 + (nodeRandom(1)[0] % 250)}`;
const CYRILLIC = new RegExp(`[${String.fromCharCode(0x400)}-${String.fromCharCode(0x4ff)}]`);

const relayers = [];
const apps = [];
after(async () => {
  relayers.forEach((r) => r.close());
  for (const a of apps) await new Promise((r) => a.server.close(r));
  for (const r of relayers) rmSync(r.harnessDir, { recursive: true, force: true });
});

// extDataHash strings of synthetic claims whose "proof" verifies (Groth16 is not under test here).
const GOOD = new Set();

/** The real indexer (TestIndexer: synthetic transfers skip Groth16) with a test activation height; MINE proofs come from GOOD. */
class MineIndexer extends TestIndexer {
  constructor(opts) {
    super({ activations: activations(), ...opts });
    this.mineProofCalls = 0;
  }
  async mineProof(env) {
    this.mineProofCalls += 1;
    return GOOD.has(String(env.extDataHash)) ? true : "proof does not verify";
  }
}

/** A fake Argon2 worker pool: zeros (valid at any difficulty) unless an answer is set for the password. */
class FakePool {
  constructor() {
    this.queued = 0;
    this.size = 2;
    this.calls = [];
    this.answers = new Map(); // password hex -> Uint8Array | Error
  }
  async hash(password) {
    const k = hex(password);
    this.calls.push(k);
    const a = this.answers.get(k);
    if (a instanceof Error) throw a;
    return a ?? ZERO;
  }
  async hashMany(passwords) {
    return Promise.all(passwords.map((p) => this.hash(p)));
  }
}
const powError = (codeName) => Object.assign(new Error("Argon2 worker failed"), { name: "PowError", code: codeName });

/**
 * A chain, a fake esplora, a paid relayer and (unless deploy is false) a mined token whose mining
 * has started: tip = mineStart. `w.coins(values)` adds confirmed C coins, `w.account(sats)` a funded
 * relay account.
 */
async function world({ config = {}, fee = 1, mineFee = MINE_FEE, terms = {}, deploy = true, act = ACT, pow = true, start = START, table = null } = {}) {
  const esplora = makeFakeEsplora({ fee });
  const idx = new MineIndexer({ startHeight: start, activations: table ?? activations(act), mineFee });
  const pool = new FakePool();
  if (pow) idx.pow = pool;
  // The MINE_SCRIPT bind needs the spent output's script: read from the fake's raw transactions.
  idx.prevoutScript = async (outpoint) => {
    const txid = hex(Uint8Array.from(outpoint.slice(0, 32)).reverse());
    return parseRawTx(esplora.txs.get(txid)).outputs[readU32le(outpoint, 32)].script;
  };
  const mine = async (txs = []) => {
    const height = idx.height + 1;
    await idx.applyBlock({ height, hash: hash32(), txs: [{ txid: hash32(), inputs: [], outputs: [] }, ...txs] });
    esplora.confirm(txs.map((t) => t.txid), height);
    esplora.tip = Math.max(esplora.tip, height);
    return height;
  };
  await mine();
  const r = await makePaidRelayer({ idx, esplora, config });
  relayers.push(r);
  const tick = () => r.onTick({ chainTip: idx.height });
  const w = {
    esplora, idx, pool, r, mine, tick,
    /** One block with every mempool transaction (or `txs`), then a tick. */
    step: async (txs) => {
      if (txs) await mine(txs);
      else await mine([...esplora.mempool].map((id) => parseRawTx(esplora.txs.get(id))));
      await tick();
    },
    coins: (values) => poolCoins({ relayer: r, esplora, values }),
    account: async (sats = 30_000) => {
      const a = newAccount();
      const f = await fundAccount({ relayer: r, esplora, account: a, sats });
      assert.equal(f.status, 200, JSON.stringify(f.body));
      return a;
    },
  };
  await tick();
  if (deploy) {
    while (idx.height + 1 < act) await mine();
    w.asset = await deployPow(w, terms);
    while (idx.height < idx.assets.get(w.asset).mineStart) await mine();
    await tick();
  }
  return w;
}

/** A DEPLOY_POW in the next block. Returns the asset id. */
async function deployPow(w, terms = {}) {
  const payload = encodeDeployPow({
    ticker: `M${nodeRandom(4).toString("hex").toUpperCase()}`, divisibility: 0, reward: 1000n, maxSupply: 1_000_000n,
    span: 12, targetPerSpan: 16, initialDifficulty: 1000n, minDifficulty: 256n, ...terms,
  });
  const height = await w.mine([{ txid: hash32(), inputs: [{ outpoint: rand(36) }], outputs: [{ script: opReturnScript(payload), value: 0n }] }]);
  const id = assetIdOf(height, 1);
  assert.equal(w.idx.assets.get(id)?.kind, "pow", "the DEPLOY_POW was accepted");
  return id;
}

/**
 * A synthetic claim of `asset` referencing `ref` (default: the tip), "proved" unless good is false.
 * `same` reuses another claim's challenge and nonce (the same solution) with fresh nullifiers.
 */
function claimOf(w, { asset = w.asset, ref = w.idx.height, reward, bind = w.r.bindScriptHash, op = OP.MINE_SCRIPT, bindOutpoint, good = true, same } = {}) {
  const nonce = same ? same.env.nonce : rand(8);
  const commitments = same ? same.env.commitments : [randomField(), randomField()];
  const body = encodeTxBody({
    op, anchor: same ? same.env.refHeight : ref, publicAsset: asset, publicAmount: reward ?? (w.idx.assets.get(asset)?.kind === "pow" ? w.idx.rewardAt(asset, ref) : 1000n),
    bindScriptHash: op === OP.MINE_SCRIPT ? bind : undefined, bindOutpoint, nonce,
    nullifiers: [randomField(), randomField()], commitments, ciphertexts: [rand(NOTE_CT_LEN), rand(NOTE_CT_LEN)],
  });
  const envelope = concat(body, rand(128));
  const env = decodeEnvelope(envelope);
  if (good) GOOD.add(String(env.extDataHash));
  return { envelope, env, claim: w.idx.claimOf(env) };
}

const send = (w, account, envelope, mode = "block") => w.r.submit(signedSubmit(account, w.r.info(), envelope, mode), anyIp());
const item = (w, out) => w.r.state.items[out.body.id];
const quoteOf = (w) => {
  const rate = Math.max(1, Math.ceil(w.r.cache.nextBlockRate * w.r.config.mineFeeHeadroom));
  const fee = w.r.config.mineEstVsize * rate;
  const margin = marginFor(fee, { marginPct: w.r.config.marginPct, marginMinSats: w.r.config.marginMinSats });
  return { rate, fee, margin, total: fee + 500 + margin };
};
/** Every carrier the fake saw that carries `envelope`. */
// L5: a claim carrier's change to C takes a random slot after the OP_RETURN; the fee outputs keep
// their requiredFeeOutputs order among the other outputs.
const changeVout = (tx, script) => {
  const want = hex(script);
  const at = Array.from({ length: tx.outputsLength }, (_, v) => v).filter((v) => v > 0 && hex(tx.getOutput(v).script) === want);
  assert.equal(at.length, 1, "exactly one change output to C");
  return at[0];
};
const feeOutputsOf = (tx, script) => {
  const cv = changeVout(tx, script);
  return Array.from({ length: tx.outputsLength }, (_, v) => v).filter((v) => v > 0 && v !== cv).map((v) => tx.getOutput(v));
};
const carriersOf = (w, envelope) => [...new Set(w.esplora.calls)].map(txOf).filter((tx) => hex(tx.getOutput(0).script) === hex(opReturnScript(envelope)));
const booksOk = (w) => {
  const r = w.r.checkBooks();
  assert.equal(r.ok, true, r.problems.join("; "));
  return r;
};
/** A self-paid MINE (op 7) claim as an indexer transaction: bound to its first input, paying the platform fee. */
function selfPaid(w, opts = {}) {
  const first = rand(36);
  const c = claimOf(w, { op: OP.MINE, bindOutpoint: first, ...opts });
  return { ...c, tx: { txid: hash32(), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(c.envelope), value: 0n }, { script: PLATFORM, value: 500n }] } };
}

/* ---------------------------------------------------------------- shapes */

test("config, error codes and messages: the mining settings, the new codes with their HTTP status, codeForReason, parseSubmit lengths", () => {
  assert.deepEqual(
    [DEFAULTS.mineEnabled, DEFAULTS.mineFeeHeadroom, DEFAULTS.mineEstVsize, DEFAULTS.invalidPowSats, DEFAULTS.powQueueMax, DEFAULTS.mempoolLookupsPerTick],
    [true, 1.25, 684, 20, 64, 50],
  );
  const read = (vars) => readConfig((n) => vars[n]).config;
  const c = read({ RELAY_MINE_ENABLED: "0", RELAY_MINE_FEE_HEADROOM: "1.5", RELAY_MINE_EST_VSIZE: "700", RELAY_INVALID_POW_SATS: "30", RELAY_POW_QUEUE: "8", RELAY_MEMPOOL_LOOKUPS: "5" });
  assert.deepEqual([c.mineEnabled, c.mineFeeHeadroom, c.mineEstVsize, c.invalidPowSats, c.powQueueMax, c.mempoolLookupsPerTick], [false, 1.5, 700, 30, 8, 5]);
  assert.deepEqual(balanceProblems({ ...DEFAULTS, relayDir: "x" }), []);
  assert.match(balanceProblems({ ...DEFAULTS, relayDir: "x", mineFeeHeadroom: 0.9 }).join(), /MURKLE_RELAY_MINE_FEE_HEADROOM must be a number from 1 to 4/);
  assert.match(balanceProblems({ ...DEFAULTS, relayDir: "x", powQueueMax: 0 }).join(), /MURKLE_RELAY_POW_QUEUE/);

  const want = {
    mine_mode: 400, bind_stale: 409, solution_claimed: 409, solution_pending: 409, cap_reached: 409,
    expired: 422, stale_work: 422, pow_invalid: 422, mine_unsupported: 422, mine_rejected: 422, mine_disabled: 503,
  };
  for (const [k, s] of Object.entries(want)) {
    assert.equal(ERROR_STATUS[k], s, k);
    assert.ok(MESSAGES[k] && !CYRILLIC.test(MESSAGES[k]), k);
    assert.doesNotMatch(MESSAGES[k], /anonymous|untraceable|trustless|mixer|\bfree\b|sponsor/i, k);
  }
  assert.equal(MESSAGES.cap_reached, "The supply is mined out, counting claims already on their way. Nothing was charged.");
  assert.equal(MESSAGES.not_transact, "The relayer carries private transfers and mining claims bound to its change address. Mints and launches are paid from your own BTC wallet.");
  for (const [reason, c2] of [
    ["solution already claimed", "solution_claimed"], ["supply cap reached", "cap_reached"], ["reference outside window", "expired"],
    ["insufficient work", "pow_invalid"], ["unknown asset", "mine_rejected"], ["asset is not mined", "mine_rejected"], ["mining not started", "mine_rejected"],
    ["mining closed", "mine_rejected"], ["mining ended", "mine_rejected"], ["reward differs from terms", "mine_rejected"], ["unknown reference block", "mine_rejected"],
    ["nullifier already spent", "nullifier_spent"], ["duplicate nullifier in envelope", "duplicate_nullifier"], ["proof does not verify", "proof_invalid"],
    ["anchor outside window", "anchor_stale"],
  ]) assert.equal(codeForReason(reason), c2, reason);

  assert.equal(envelopeLen(OP.MINE_SCRIPT), 511);
  const body = (envelope) => JSON.stringify({ envelope, mode: "block", accountPub: "00".repeat(32), t: 1, sig: "00".repeat(64) });
  assert.equal(parseSubmit(body("ab".repeat(471))).envelope.length, 942);
  assert.equal(parseSubmit(body("ab".repeat(511))).envelope.length, 1022);
  for (const n of [470, 507, 515, 512]) assert.throws(() => parseSubmit(body("ab".repeat(n))), (e) => e.code === "malformed", String(n));
  // The request never names outputs: the carrier's fee outputs come from the indexer.
  const extra = JSON.stringify({ envelope: "ab".repeat(511), mode: "block", accountPub: "00".repeat(32), t: 1, sig: "00".repeat(64), outputs: [] });
  assert.throws(() => parseSubmit(extra), (e) => e.code === "malformed");
});

/* ---------------------------------------------------------------- books */

test("books: settle with a service fee debits fee + service + margin, refundCharge and reclaim reverse serviceOut; files without serviceOut load", () => {
  const keys = { network: "signet", poolKey: "11".repeat(32), changeKey: "22".repeat(32) };
  const b = new RelayBooks(keys);
  const id = "aa".repeat(32);
  b.credit({ key: `${"cd".repeat(32)}:0`, id, n: 0, value: 10_000, sweepCost: 288 });
  b.reserve("m1", id, 3000);
  const ch = b.settle("m1", { fee: 1368, service: 500 });
  assert.deepEqual(ch, { cost: 1368 + 500 + 137, fee: 1368, margin: 137, service: 500 });
  assert.equal(b.serviceOut, 500);
  assert.deepEqual(b.toJSON().charges.m1, { id, cost: 2005, fee: 1368, service: 500 });
  assert.equal(b.toJSON().serviceOut, 500);
  assert.equal(b.availableMargin(), 288, "a pending charge's margin is not spendable; its service is not margin");
  assert.equal(b.checkI2({ poolUnspent: b.liabilities() }).ok, true);
  assert.equal(b.checkI2({ poolUnspent: b.liabilities() }).serviceOut, 500);
  const refund = b.refundCharge("m1");
  assert.deepEqual(refund, { id, cost: 2005, fee: 1368, service: 500 });
  assert.equal(b.serviceOut, 0);
  assert.equal("serviceOut" in b.toJSON(), false, "written only when non-zero");
  assert.equal(b.account(id).balance, 10_000 - 288);
  // A transfer's settle is unchanged: no service key anywhere.
  b.reserve("t1", id, 700);
  assert.deepEqual(b.settle("t1", { fee: 598 }), { cost: 658, fee: 598, margin: 60 });
  assert.deepEqual(b.toJSON().charges.t1, { id, cost: 658, fee: 598 });
  b.confirmCharge("t1");
  // A broadcast claim whose input came back: its fee and its service go to the margin.
  b.reserve("m2", id, 3000);
  b.settle("m2", { fee: 1368, service: 500 });
  b.confirmCharge("m2");
  const margin = b.margin;
  assert.deepEqual(b.reclaim(1368, { service: 500 }), { sats: 1368, margin: margin + 1868, service: 500 });
  assert.equal(b.serviceOut, 0);
  assert.throws(() => b.reclaim(1, { service: 1 }), /more service fees reclaimed/);
  assert.equal(b.checkI2({ poolUnspent: b.liabilities() }).ok, true);
  assert.throws(() => b.settle("nope", { fee: 1, service: -1 }), /no reservation/);
  b.reserve("m3", id, 100);
  assert.throws(() => b.settle("m3", { fee: 10, service: -1 }), /service fee must be a non-negative integer/);

  // A file written before mining (no serviceOut, charges without service) loads as before.
  const old = { ...b.toJSON() };
  delete old.serviceOut;
  const again = RelayBooks.restore(JSON.parse(JSON.stringify(old)), keys);
  assert.equal(again.serviceOut, 0);
  assert.equal(JSON.stringify(again.toJSON()), JSON.stringify(old));
  // serviceOut round-trips, a malformed one is refused, and I2 counts it.
  const s = new RelayBooks(keys);
  s.credit({ key: `${"ce".repeat(32)}:1`, id, n: 0, value: 5000, sweepCost: 100 });
  s.reserve("x", id, 3000);
  s.settle("x", { fee: 1000, service: 500 });
  const back = RelayBooks.restore(JSON.parse(JSON.stringify(s.toJSON())), keys);
  assert.equal(back.serviceOut, 500);
  assert.equal(back.toJSON().charges.x.service, 500);
  for (const bad of [-1, 1.5, "500"]) assert.throws(() => RelayBooks.restore({ ...s.toJSON(), serviceOut: bad }, keys), /serviceOut is malformed/, String(bad));
  assert.throws(() => RelayBooks.restore({ ...s.toJSON(), charges: { x: { id, cost: 1, fee: 1, service: 0 } } }, keys), /charge x is malformed/);
  const tampered = RelayBooks.restore({ ...s.toJSON(), serviceOut: 499 }, keys);
  const i2 = tampered.checkI2({ poolUnspent: tampered.liabilities() + 10 });
  assert.equal(i2.ok, false);
  assert.match(i2.problems.join(), /- serviceOut 499 -/);
});

test("books: I2 with serviceOut holds under random sequences of credits, claims and transfers, refunds, confirms, reclaims, penalties", () => {
  const keys = { network: "signet", poolKey: "33".repeat(32), changeKey: "44".repeat(32) };
  for (let run = 0; run < 25; run++) {
    const b = new RelayBooks(keys);
    const ids = ["a1", "b2", "c3"].map((s) => s.repeat(32));
    let pool = 0; // what the pool's coins hold: credited value minus everything that left it
    const charged = []; // [ref, fee, service] confirmed and still reclaimable
    let n = 0;
    for (let step = 0; step < 200; step++) {
      const id = ids[nodeRandom(1)[0] % 3];
      const pick = nodeRandom(1)[0] % 7;
      const ref = `r${n++}`;
      try {
        if (pick === 0) {
          const value = 2000 + (nodeRandom(2).readUInt16LE(0) % 20_000);
          b.credit({ key: `${hex(rand(32))}:0`, id, n: 0, value, sweepCost: 288 });
          pool += value;
        } else if (pick <= 3) {
          const claim = pick !== 1;
          const fee = 300 + (nodeRandom(2).readUInt16LE(0) % 2000);
          const service = claim ? 500 : 0;
          b.reserve(ref, id, fee + service + 400);
          b.settle(ref, { fee, service });
          if (nodeRandom(1)[0] % 3 === 0) b.refundCharge(ref); // refused broadcast: nothing left the pool
          else {
            b.confirmCharge(ref);
            pool -= fee + service;
            charged.push([fee, service]);
          }
        } else if (pick === 4 && charged.length) {
          const [fee, service] = charged.splice(nodeRandom(1)[0] % charged.length, 1)[0];
          b.reclaim(fee, { service }); // the carrier never landed and its input came back
          pool += fee + service;
        } else if (pick === 5) {
          b.penalize(id, 20);
        } else {
          b.reserve(ref, id, 500);
          b.release(ref);
        }
      } catch (e) {
        assert.ok(e instanceof booksMod.BooksError && e.code === "balance_low", e.message);
      }
      const r = b.checkI2({ poolUnspent: pool });
      assert.equal(r.ok, true, `run ${run} step ${step}: ${r.problems.join("; ")}`);
    }
  }
});

/* ---------------------------------------------------------------- gates and info */

test("info.mine and mine_disabled: off with mining unscheduled, below the test activation, without a worker pool, or with mineEnabled off", async () => {
  // Mining unscheduled (height null). Claims answer mine_disabled; info says so with no bind.
  const live = await world({ deploy: false, act: null });
  assert.equal(live.idx.miningHeight, null);
  await live.coins([20_000]);
  const acct = await live.account();
  const off = live.r.info().mine;
  assert.deepEqual(
    { ...off, feeRate: undefined, carrierFeeSats: undefined, marginSats: undefined },
    { enabled: false, code: "mine_disabled", bindScriptHash: null, modes: ["fast", "block"], slack: MINE_SLACK, estVsize: 684, feeRate: undefined, carrierFeeSats: undefined, marginSats: undefined, invalidPowSats: 20 },
  );
  const fake = claimOf(live, { asset: 5n, ref: live.idx.height, reward: 1000n });
  const out = await send(live, acct, fake.envelope);
  assert.deepEqual([out.status, code(out)], [503, "mine_disabled"]);
  assert.equal(out.body.error.message, MESSAGES.mine_disabled);
  assert.equal(live.pool.calls.length, 0);
  assert.equal(live.r.cache.nextBlockRate, null, "no next-block rate is read while mining is off");

  // Active, with the fake pool: on, bound to sha256(C.script), priced at ceil(1 x 1.25) = 2 sat/vB.
  const w = await world();
  const info = w.r.info().mine;
  assert.deepEqual(info, {
    enabled: true, code: null, bindScriptHash: hex(sha256(w.r.change.script)), modes: ["fast", "block"], slack: 2,
    estVsize: 684, feeRate: 2, carrierFeeSats: 1368, marginSats: 137, invalidPowSats: 20,
  });
  assert.deepEqual(w.r.info().ops, ["TRANSACT"], "existing keys are unchanged");
  // An inline Argon2 (no worker pool) is never used by the relayer.
  w.idx.pow = inlinePow;
  assert.equal(w.r.info().mine.code, "mine_disabled");
  await w.coins([20_000]);
  const a = await w.account();
  const c = claimOf(w);
  assert.equal(code(await send(w, a, c.envelope)), "mine_disabled");
  w.idx.pow = w.pool;
  w.r.config.mineEnabled = false;
  assert.equal(code(await send(w, a, claimOf(w).envelope)), "mine_disabled");
  w.r.config.mineEnabled = true;
  // Above the cap: fee_high with the next-block rate.
  w.r.cache.nextBlockRate = 6;
  const high = await send(w, a, claimOf(w).envelope);
  assert.deepEqual([high.status, high.body.error], [503, { code: "fee_high", message: MESSAGES.fee_high, feeRate: 6, maxFeeRate: 5 }]);
  w.r.cache.nextBlockRate = 3; // 684 x ceil(3.75) = 2736 sats: under the 3000-sat per-carrier cap
  assert.equal(w.r.mineGateCode(), null);
  w.r.cache.nextBlockRate = 4; // 684 x 5 = 3420 > 3000
  assert.equal(w.r.mineGateCode(), "fee_high");
});

test("the next-block rate is mempool.space's fastestFee (with headroom on top), else the client's feeRate", async () => {
  const w = await world({ deploy: false });
  const seen = [];
  w.r.esplora = {
    base: "https://mempool.example/signet/api",
    requestUrl: async (url) => {
      seen.push(url);
      return { json: async () => ({ fastestFee: 3.2, halfHourFee: 1 }) };
    },
    feeRate: async () => 1,
  };
  assert.equal(await w.r.nextBlockRate(), 4);
  assert.deepEqual(seen, ["https://mempool.example/signet/api/v1/fees/recommended"]);
  w.r.cache.nextBlockRate = 4;
  assert.equal(w.r.mineFeeRate(), 5);
  w.r.esplora = { base: "http://localhost:3002", feeRate: async () => 7 };
  assert.equal(await w.r.nextBlockRate(), 7);
});

/* ---------------------------------------------------------------- the happy path */

test("a relayed claim: 202 with the claim fields, a carrier with the indexer's fee outputs on a confirmed coin, the debit (fee + service + margin) on disk before the broadcast, accepted by the indexer", async () => {
  const w = await world();
  const { outpoints } = await w.coins([20_000, 20_000]);
  const a = await w.account();
  const before = w.r.books.account(a.idHex).balance;
  const c = claimOf(w);
  const out = await send(w, a, c.envelope);
  assert.equal(out.status, 202, JSON.stringify(out.body));
  const q = quoteOf(w);
  const ref = w.idx.height;
  assert.deepEqual(out.body, {
    id: out.body.id, status: "queued", kind: "mine", ref, lastBroadcast: ref + 9, deadline: ref + 12, solutionId: c.claim.solutionIdHex,
    reservedSats: q.total, serviceSats: "500", balance: before - q.total, flush: "next-block",
  });
  assert.equal(q.total, 2005, "the contract's worked example: 1368 + 500 + 137");
  const it = item(w, out);
  assert.equal(it.kind, "mine");
  assert.equal(it.powHash, hex(ZERO));
  assert.deepEqual(it.serviceOutputs, [{ script: MINE_FEE.platformScript, sats: 500 }]);
  assert.equal(w.pool.calls.length, 1, "one Argon2, in the pool");
  assert.equal(w.idx.mineProofCalls, 1);
  assert.deepEqual(w.r.status(out.body.id), {
    status: "queued", anchor: ref, deadline: ref + 12, kind: "mine", ref, lastBroadcast: ref + 9, solutionId: c.claim.solutionIdHex, serviceSats: "500",
  });

  // The debit is on disk when the carrier is broadcast (I1: recorded before the signature is released).
  const statePath = `${w.r.harnessDir}/relay-balance/relayer.json`;
  let onDisk = null;
  const real = w.esplora.broadcast.bind(w.esplora);
  w.esplora.broadcast = async (raw) => {
    if (hex(txOf(raw).getOutput(0).script) === hex(opReturnScript(c.envelope))) onDisk ??= JSON.parse(readFileSync(statePath, "utf8"));
    return real(raw);
  };
  await w.step([]); // the next block: the relayer flushes
  w.esplora.broadcast = real;
  const [tx] = carriersOf(w, c.envelope);
  assert.ok(tx, "the carrier was broadcast");
  const charged = onDisk.books.charges[out.body.id];
  assert.equal(onDisk.items[out.body.id].status, "signing");
  assert.equal(charged.service, 500);
  assert.equal(charged.cost, charged.fee + 500 + marginFor(charged.fee, { marginPct: 10, marginMinSats: 50 }));
  assert.equal(onDisk.books.serviceOut, 500);
  // Layout: OP_RETURN, the platform output (from the indexer and MINE_FEE), change to C.
  assert.equal(tx.outputsLength, 3);
  const cv = changeVout(tx, w.r.change.script);
  const [feeOut] = feeOutputsOf(tx, w.r.change.script);
  assert.equal(hex(feeOut.script), MINE_FEE.platformScript);
  assert.equal(feeOut.amount, 500n);
  assert.ok(cv === 1 || cv === 2, "the change sits after the OP_RETURN");
  const input = `${hex(tx.getInput(0).txid)}:${tx.getInput(0).index}`;
  assert.ok(outpoints.includes(input), "funded from a confirmed C coin");
  // spent = inputs - change = fee + service, and the fee is what the books charged.
  const value = w.r.state.coins[input]?.value ?? 20_000;
  const fee = value - Number(feeOut.amount) - Number(tx.getOutput(cv).amount);
  assert.equal(fee, charged.fee);
  const it2 = item(w, out);
  assert.equal(it2.status, "broadcast");
  assert.equal(w.r.books.account(a.idHex).balance, before - charged.cost, "charged the exact cost; the rest of the reservation went back");
  booksOk(w);
  // The change waits for a confirmation: not spendable, so nothing chains on the fee recipient's output.
  const changeKey = `${tx.id}:${cv}`;
  assert.equal(w.r.state.coins[changeKey].thirdParty, true);
  assert.equal(w.r.spendableCoins().some((u) => u.key === changeKey), false);

  // It lands: the indexer accepts the carrier (fee output, bind to C through the prevout, work, proof).
  await w.step();
  const verdict = w.idx.log.find((e) => e.txid === tx.id);
  assert.deepEqual([verdict.ok, verdict.opName, verdict.reason], [true, "MINE_SCRIPT", undefined]);
  assert.equal(it2.status, "accepted");
  assert.equal(w.idx.claimed.has(c.claim.solutionIdHex), true);
  assert.equal(w.r.spendableCoins().some((u) => u.key === changeKey), true, "spendable once confirmed");
  const ledger = w.r.ledgerView().items.find((l) => l.txid === tx.id);
  assert.deepEqual([ledger.kind, ledger.fee, ledger.serviceSats, ledger.outcome], ["carrier", charged.fee, 500, "accepted"]);
  booksOk(w);
  assert.equal(w.r.books.serviceOut, 500);
});

/* ---------------------------------------------------------------- refusals before any debit */

test("only the current C bind is accepted (bind_stale names it); batch modes are refused (mine_mode); a MINE (op 7) or a short claim is not carried", async () => {
  const w = await world();
  await w.coins([20_000]);
  const a = await w.account();
  const books = JSON.stringify(w.r.books.toJSON());
  const other = claimOf(w, { bind: sha256(btcAccount(rand(32)).script) });
  const stale = await send(w, a, other.envelope);
  assert.deepEqual([stale.status, stale.body.error], [409, { code: "bind_stale", message: MESSAGES.bind_stale, bindScriptHash: hex(sha256(w.r.change.script)) }]);
  for (const mode of ["batch", "batch10"]) {
    const out = await send(w, a, claimOf(w).envelope, mode);
    assert.deepEqual([out.status, code(out)], [400, "mine_mode"], mode);
  }
  // A 511-byte payload whose header says MINE (op 7): not a claim the relayer carries.
  const mine7 = claimOf(w).envelope.slice();
  mine7[4] = OP.MINE;
  assert.deepEqual([(await send(w, a, mine7)).status, code(await send(w, a, mine7))], [400, "not_transact"]);
  assert.equal(JSON.stringify(w.r.books.toJSON()), books, "nothing was debited");
  assert.equal(w.pool.calls.length, 0, "no work was checked");
  // The current bind goes through.
  assert.equal((await send(w, a, claimOf(w).envelope, "fast")).status, 202);
});

test("a fee output that pays C or a deposit address is refused (mine_unsupported) before any debit; fee outputs come from the indexer's terms, in requiredFeeOutputs order", async () => {
  // A policy that lets a deployer take a claim fee, so a treasury can point at the relayer.
  const mineFee = { ...MINE_FEE, deployerMaxSats: 10_000n };
  const w = await world({ mineFee, deploy: false });
  await w.coins([20_000, 20_000]);
  const a = await w.account();
  while (w.idx.height + 1 < ACT) await w.mine();
  const dep = depositAddress(w.r.Q, a.id, 0, "signet").script;
  const third = btcAccount(rand(32)).script;
  const toC = await deployPow(w, { claimFeeSats: 1000n, treasury: w.r.change.script });
  const toDeposit = await deployPow(w, { claimFeeSats: 1000n, treasury: dep });
  const fair = await deployPow(w, { claimFeeSats: 1000n, treasury: third });
  while (w.idx.height < w.idx.assets.get(fair).mineStart) await w.mine();
  await w.tick();
  const books = JSON.stringify(w.r.books.toJSON());
  for (const asset of [toC, toDeposit]) {
    const out = await send(w, a, claimOf(w, { asset }).envelope);
    assert.deepEqual([out.status, code(out)], [422, "mine_unsupported"], String(asset));
  }
  assert.equal(JSON.stringify(w.r.books.toJSON()), books, "refused before any debit");
  assert.equal(w.pool.calls.length, 0);

  // The fair one: deployer output first, then the platform's; the debit covers both.
  const c = claimOf(w, { asset: fair });
  const out = await send(w, a, c.envelope);
  assert.equal(out.status, 202, JSON.stringify(out.body));
  assert.equal(out.body.serviceSats, "1500");
  assert.deepEqual(item(w, out).serviceOutputs, [{ script: hex(third), sats: 1000 }, { script: MINE_FEE.platformScript, sats: 500 }]);
  await w.step([]);
  const [tx] = carriersOf(w, c.envelope);
  assert.deepEqual(
    feeOutputsOf(tx, w.r.change.script).map((o) => [hex(o.script), o.amount]),
    [[hex(third), 1000n], [MINE_FEE.platformScript, 500n]],
    "the fee outputs in requiredFeeOutputs order; the change may sit between them",
  );
  assert.equal(w.r.books.serviceOut, 1500);
  booksOk(w);
  await w.step();
  assert.equal(w.idx.log.find((e) => e.txid === tx.id)?.ok, true, "the indexer finds every required output paid");
});

/* ---------------------------------------------------------------- work */

test("bad work is refused in the pool before any proof check, penalized (invalidPowSats) and rate-limited; a worker failure is busy and costs nothing; one check per account; a full queue is busy", async () => {
  const w = await world({ config: { invalidPerHour: 2 } });
  await w.coins([20_000, 20_000, 20_000]);
  const a = await w.account();
  const bal = () => w.r.books.account(a.idHex).balance;
  const margin = () => w.r.books.margin;
  const b0 = bal();
  const m0 = margin();
  const bad = claimOf(w);
  w.pool.answers.set(hex(bad.claim.password), FF);
  const out = await send(w, a, bad.envelope);
  assert.deepEqual([out.status, out.body.error], [422, { code: "pow_invalid", message: MESSAGES.pow_invalid }]);
  assert.equal(w.idx.mineProofCalls, 0, "bad work never reaches the proof check");
  assert.deepEqual([bal(), margin()], [b0 - 20, m0 + 20], "the penalty moved to the margin");
  assert.deepEqual(w.pool.calls, [hex(bad.claim.password)], "the hash came from the pool");
  booksOk(w);

  // A failing worker: busy, never a verdict, no penalty, not counted.
  const flaky = claimOf(w);
  w.pool.answers.set(hex(flaky.claim.password), powError("POW_WORKER_FAILED"));
  const busy = await send(w, a, flaky.envelope);
  assert.deepEqual([busy.status, code(busy)], [503, "busy"]);
  assert.equal(bal(), b0 - 20);
  w.pool.answers.delete(hex(flaky.claim.password));
  assert.equal((await send(w, a, flaky.envelope)).status, 202, "the same claim goes through once the pool works");

  // A full pool queue and an account's check in flight are busy before any work.
  w.pool.queued = 64;
  assert.equal(code(await send(w, a, claimOf(w).envelope)), "busy");
  w.pool.queued = 0;
  w.r.powBusy.add(a.idHex);
  assert.equal(code(await send(w, a, claimOf(w).envelope)), "busy");
  w.r.powBusy.delete(a.idHex);
  const calls = w.pool.calls.length;

  // A second refusal reaches invalidPerHour (2): the next submit is rate-limited before any work.
  const bad2 = claimOf(w);
  w.pool.answers.set(hex(bad2.claim.password), FF);
  assert.equal(code(await send(w, a, bad2.envelope)), "pow_invalid");
  const limited = await send(w, a, claimOf(w).envelope);
  assert.deepEqual([limited.status, code(limited)], [429, "rate_limited"]);
  assert.equal(w.pool.calls.length, calls + 1);
  assert.equal(bal(), b0 - 40 - quoteOf(w).total);
  // An invalid proof costs the existing penalty and counts too.
  const v = await world();
  await v.coins([20_000]);
  const b = await v.account();
  const unproved = claimOf(v, { good: false });
  const before = v.r.books.account(b.idHex).balance;
  const p = await send(v, b, unproved.envelope);
  assert.deepEqual([p.status, code(p)], [422, "proof_invalid"]);
  assert.equal(v.r.books.account(b.idHex).balance, before - v.r.config.invalidProofSats);
  booksOk(v);
});

test("PoW never runs on the relayer's thread: the claim is checked through idx.pow (the pool); at D_MAX only the pool's answer can pass", async () => {
  const w = await world({ terms: { initialDifficulty: (1n << 63n) - 1n, minDifficulty: (1n << 63n) - 1n } });
  await w.coins([20_000]);
  const a = await w.account();
  const c = claimOf(w);
  const out = await send(w, a, c.envelope);
  assert.equal(out.status, 202, "a real Argon2 hash would almost surely miss a D_MAX target; the pool's zeros meet it");
  assert.deepEqual(w.pool.calls, [hex(c.claim.password)]);
  // The relayer's source calls Argon2 only through the indexer (idx.minePow / idx.pow).
  const src = readFileSync("server/relayer.mjs", "utf8");
  assert.doesNotMatch(src, /\bpowHash\(|powHashReference|hash-wasm|@noble\/hashes\/argon2|argon2id/);
  assert.match(src, /idx\.minePow\(/);
});

/* ---------------------------------------------------------------- window, solutions, cap */

test("expired: a claim too close to the end of its 12-block window, or outside it; mine_rejected names the indexer's reason", async () => {
  const w = await world();
  await w.coins([20_000]);
  const a = await w.account();
  for (let i = 0; i < 12; i++) await w.mine();
  await w.tick();
  const tip = w.idx.height;
  const late = await send(w, a, claimOf(w, { ref: tip - 10 }).envelope); // tip > ref + 9
  assert.deepEqual([late.status, late.body.error], [422, { code: "expired", message: MESSAGES.expired }]);
  const out = await send(w, a, claimOf(w, { ref: tip - 12 }).envelope); // H - 13: outside the window
  assert.equal(code(out), "expired");
  assert.equal((await send(w, a, claimOf(w, { ref: tip - 9 }).envelope)).status, 202, "ref + 9 = tip: still signed this block");
  const wrong = await send(w, a, claimOf(w, { reward: 999n }).envelope);
  assert.deepEqual([wrong.status, wrong.body.error], [422, { code: "mine_rejected", message: "This claim cannot land: reward differs from terms.", reason: "reward differs from terms" }]);
  const unknown = await send(w, a, claimOf(w, { asset: 12345n, reward: 1000n }).envelope);
  assert.deepEqual([code(unknown), unknown.body.error.reason], ["mine_rejected", "unknown asset"]);
  assert.equal(w.pool.calls.length, 1, "only the claim that passed the cheap rules was hashed");
});

test("solution_pending, solution_claimed and nullifier_pending: one solution is carried once", async () => {
  const w = await world();
  await w.coins([20_000, 20_000, 20_000]);
  const a = await w.account();
  const first = claimOf(w);
  assert.equal((await send(w, a, first.envelope)).status, 202);
  // The same solution re-proved with new nullifiers: same solutionId.
  const again = claimOf(w, { same: first });
  assert.equal(again.claim.solutionIdHex, first.claim.solutionIdHex);
  const pending = await send(w, a, again.envelope);
  assert.deepEqual([pending.status, code(pending)], [409, "solution_pending"]);
  // The same nullifiers in another solution: nullifier_pending.
  const twin = claimOf(w);
  const bytes = twin.envelope.slice();
  bytes.set(first.envelope.slice(65, 129), 65); // nullifier[2] sits after header, ref, asset, amount, bind and nonce
  GOOD.add(String(decodeEnvelope(bytes).extDataHash));
  assert.equal(code(await send(w, a, bytes)), "nullifier_pending");
  // It lands; a re-proved copy is then solution_claimed.
  await w.step([]);
  await w.step();
  assert.equal(w.idx.claimed.has(first.claim.solutionIdHex), true);
  const third = claimOf(w, { same: first });
  const claimed = await send(w, a, third.envelope);
  assert.deepEqual([claimed.status, code(claimed)], [409, "solution_claimed"]);
  assert.equal(w.r.pendingSolutions.size, 0, "settled items release their solution");
});

test("cap_reached counts claims in flight (the relayer's own and the mempool's); a claim the cap overtakes before signing is dropped with nothing charged", async () => {
  const w = await world({ terms: { maxSupply: 2000n } });
  w.esplora.mempoolTxids = async () => [...w.esplora.mempool];
  await w.coins([20_000, 20_000, 20_000]);
  const a = await w.account();
  assert.equal((await send(w, a, claimOf(w).envelope)).status, 202);
  assert.equal((await send(w, a, claimOf(w).envelope)).status, 202);
  const full = await send(w, a, claimOf(w).envelope);
  assert.deepEqual([full.status, full.body.error], [409, { code: "cap_reached", message: MESSAGES.cap_reached }]);
  assert.equal(w.r.pendingClaims(w.asset), 2);

  // Another world: one claim of ours queued, then someone else's claim shows up in the mempool.
  const v = await world({ terms: { maxSupply: 2000n } });
  v.esplora.mempoolTxids = async () => [...v.esplora.mempool];
  await v.coins([20_000, 20_000, 20_000]);
  const b = await v.account();
  const mineOut = await send(v, b, claimOf(v).envelope);
  const ours = await send(v, b, claimOf(v).envelope);
  assert.equal(ours.status, 202);
  const foreign = selfPaid(v);
  v.esplora.pay([{ script: opReturnScript(foreign.envelope), value: 0 }, { script: PLATFORM, value: 500 }]);
  await v.r.refreshMempoolClaims();
  assert.equal(v.r.pendingClaims(v.asset), 3, "two of ours, one in the mempool");
  assert.equal(code(await send(v, b, claimOf(v).envelope)), "cap_reached");
  // At signing time only claims already sent count: the first goes out, the second is dropped (refunded).
  const balance = v.r.books.account(b.idHex).balance;
  const reserved = item(v, mineOut).reservation + item(v, ours).reservation;
  await v.mine();
  await v.tick();
  const states = [item(v, mineOut), item(v, ours)].map((i) => i.status).sort();
  assert.deepEqual(states, ["broadcast", "dropped"]);
  const dropped = [item(v, mineOut), item(v, ours)].find((i) => i.status === "dropped");
  assert.match(dropped.reason, /supply is mined out, counting claims already on their way/);
  assert.equal(dropped.txid, undefined, "never signed");
  const sent = [item(v, mineOut), item(v, ours)].find((i) => i.status === "broadcast");
  assert.equal(v.r.books.account(b.idHex).balance, balance + reserved - sent.cost, "only the carried claim was charged");
  booksOk(v);
});

test("stale_work: work that meets D(ref) but not the stale bound is refused without a penalty, and a queued claim overtaken by a difficulty jump is dropped before signing", async () => {
  const w = await world();
  await w.coins([20_000, 20_000, 20_000]);
  const a = await w.account();
  const ref = w.idx.height;
  const d0 = w.idx.difficultyAt(w.asset, ref);
  const exact = bigToBytes(targetOf(d0), 32); // meets D(ref) exactly (equality counts)
  // Queued before the jump: valid at D_eff = D(ref) now.
  const early = claimOf(w);
  w.pool.answers.set(hex(early.claim.password), exact);
  const queued = await send(w, a, early.envelope);
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  // A block of 60 self-paid claims at D(ref) multiplies the difficulty by about 4.7.
  const fillers = Array.from({ length: 60 }, () => selfPaid(w).tx);
  await w.mine(fillers);
  assert.equal(w.idx.log.filter((e) => e.ok && e.opName === "MINE").length, 60);
  assert.ok(w.idx.difficultyAt(w.asset, w.idx.height) > 4n * d0, "the difficulty jumped more than 4x");
  // The queued claim is now stale: dropped before signing, nothing charged.
  const bal = w.r.books.account(a.idHex).balance;
  const res = item(w, queued).reservation;
  await w.tick();
  assert.equal(item(w, queued).status, "dropped");
  assert.match(item(w, queued).reason, /difficulty jumped/);
  assert.equal(carriersOf(w, early.envelope).length, 0);
  assert.equal(w.r.books.account(a.idHex).balance, bal + res);
  // A new submit of a pre-jump solution: stale_work, no penalty.
  const late = claimOf(w, { ref });
  w.pool.answers.set(hex(late.claim.password), exact);
  const before = w.r.books.account(a.idHex).balance;
  const out = await send(w, a, late.envelope);
  assert.deepEqual([out.status, out.body.error], [422, { code: "stale_work", message: MESSAGES.stale_work }]);
  assert.equal(w.r.books.account(a.idHex).balance, before, "no penalty for stale work");
  assert.equal(w.r.invalidFor(a.idHex).length, 0);
  booksOk(w);
});

/* ---------------------------------------------------------------- deadlines and coins */

test("an item retried across blocks is never signed after ref + 9 and never broadcast after ref + 11", async () => {
  // 1. No confirmed coin for it: held block after block, then expired at ref + 10, never signed.
  const w = await world();
  await w.coins([20_000]);
  const a = await w.account();
  const c = claimOf(w);
  const out = await send(w, a, c.envelope);
  assert.equal(out.status, 202);
  const ref = out.body.ref;
  const bal = w.r.books.account(a.idHex).balance;
  // Only unconfirmed change left: the merges that made the coins are back in the mempool.
  for (const coin of Object.values(w.r.state.coins)) {
    if (coin.kind !== "change" || coin.status !== "unspent") continue;
    Object.assign(coin, { confirmed: false, depth: 1 });
    w.esplora.mined.delete(coin.parent);
    w.esplora.mempool.add(coin.parent);
  }
  while (w.idx.height <= ref + 9) {
    await w.mine();
    await w.tick();
    if (w.idx.height <= ref + 9) assert.equal(item(w, out).status, "queued", `held at ${w.idx.height}`);
  }
  assert.equal(item(w, out).status, "expired");
  assert.equal(item(w, out).txid, undefined);
  assert.equal(carriersOf(w, c.envelope).length, 0, "never signed, never broadcast");
  assert.equal(w.r.books.account(a.idHex).balance, bal + out.body.reservedSats, "the reservation came back");
  booksOk(w);

  // 2. Signed, but every broadcast meets a mempool chain limit: resent each block up to ref + 11, then never again.
  const v = await world();
  await v.coins([20_000]);
  const b = await v.account();
  const d = claimOf(v);
  const bal2 = v.r.books.account(b.idHex).balance;
  const sub = await send(v, b, d.envelope);
  const ref2 = sub.body.ref;
  const real = v.esplora.broadcast.bind(v.esplora);
  const tries = [];
  v.esplora.broadcast = async (raw) => {
    if (hex(txOf(raw).getOutput(0).script) === hex(opReturnScript(d.envelope))) {
      tries.push(v.r.topHeight());
      throw new Error("sendrawtransaction RPC error: too-long-mempool-chain, too many unconfirmed ancestors [limit: 25]");
    }
    return real(raw);
  };
  while (v.idx.height <= ref2 + 13) {
    await v.mine();
    await v.tick();
  }
  assert.ok(tries.length >= 2, `tried ${tries.length} times`);
  assert.ok(tries.every((h) => h <= ref2 + MINE_WINDOW - 1), `broadcast tips ${tries}`);
  const it = item(v, sub);
  assert.equal(it.status, "expired", "never reached the network: expired");
  assert.equal(v.r.books.account(b.idHex).balance, bal2, "refunded in full");
  assert.equal(v.r.books.serviceOut, 0, "refunded with its service fee");
  booksOk(v);
});

test("a MINE carrier the network refuses three times is dropped and refunded: serviceOut goes back and I2 holds", async () => {
  const w = await world();
  await w.coins([20_000]);
  const a = await w.account();
  const bal = w.r.books.account(a.idHex).balance;
  const c = claimOf(w);
  assert.equal((await send(w, a, c.envelope)).status, 202);
  const refuse = () => new Error('POST /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}');
  const real = w.esplora.broadcast.bind(w.esplora);
  w.esplora.broadcast = async (raw) => {
    if (hex(txOf(raw).getOutput(0).script) === hex(opReturnScript(c.envelope))) {
      w.esplora.calls.push(raw);
      throw refuse();
    }
    return real(raw);
  };
  await w.step([]);
  assert.equal(w.r.books.serviceOut, 500, "charged at signing");
  booksOk(w);
  await w.step([]);
  await w.step([]);
  const it = Object.values(w.r.state.items).find((i) => i.kind === "mine");
  assert.equal(it.status, "dropped");
  assert.equal(w.r.books.serviceOut, 0);
  assert.equal(w.r.books.account(a.idHex).balance, bal, "nothing charged in the end");
  booksOk(w);
});

test("MINE carriers spend confirmed coins only, and their change is not spent before it confirms", async () => {
  const w = await world();
  await w.coins([20_000]);
  const a = await w.account();
  const first = claimOf(w);
  assert.equal((await send(w, a, first.envelope)).status, 202);
  await w.step([]);
  const [tx] = carriersOf(w, first.envelope);
  const change = `${tx.id}:${changeVout(tx, w.r.change.script)}`;
  assert.equal(w.r.state.coins[change].thirdParty, true);
  // The only confirmed coin is spent and the change is unconfirmed: the next claim has no coin.
  const second = await send(w, a, claimOf(w).envelope);
  assert.deepEqual([second.status, code(second)], [503, "pool_low"]);
  // Nothing may chain on it before it confirms, a transfer included.
  assert.equal(w.r.spendableCoins().some((u) => u.key === change), false);
  const tr = await w.r.submit(signedSubmit(a, w.r.info(), synth(w.idx), "fast"), anyIp());
  assert.ok(tr.status === 202 || code(tr) === "pool_low", JSON.stringify(tr.body));
  await w.r.flush({ only: w.r.items.filter((i) => i.status === "queued" && !i.kind).map((i) => i.id) });
  const spends = (raw) => {
    const t = txOf(raw);
    return Array.from({ length: t.inputsLength }, (_, i) => `${hex(t.getInput(i).txid)}:${t.getInput(i).index}`).includes(change);
  };
  assert.equal([...new Set(w.esplora.calls)].some(spends), false, "no transaction spent the claim's change while it was unconfirmed");
  // Confirmed: it is a pool coin like any other, and the next claim goes out on a confirmed coin.
  await w.step();
  assert.equal(w.r.state.coins[change].confirmed, true);
  assert.equal(w.r.spendableCoins().some((u) => u.key === change), true);
  const third = claimOf(w);
  assert.equal((await send(w, a, third.envelope)).status, 202);
  await w.step([]);
  const [next] = carriersOf(w, third.envelope);
  const input = `${hex(next.getInput(0).txid)}:${next.getInput(0).index}`;
  assert.equal(w.r.state.coins[input].confirmed, true);
  booksOk(w);
});

test("a queued claim survives a restart: its solution stays pending, and the restarted relayer carries it (fast mode at once)", async () => {
  const w = await world();
  await w.coins([20_000, 20_000]);
  const a = await w.account();
  const c = claimOf(w);
  const out = await send(w, a, c.envelope);
  assert.equal(out.status, 202);
  w.r.close();
  const r2 = await makePaidRelayer({ idx: w.idx, esplora: w.esplora, dir: w.r.harnessDir, fastDelayMs: () => 0 });
  relayers.push(r2);
  await r2.onTick({ chainTip: w.idx.height });
  assert.equal(r2.pendingSolutions.get(c.claim.solutionIdHex), out.body.id);
  const again = await r2.submit(signedSubmit(a, r2.info(), claimOf(w, { same: c }).envelope, "fast"), anyIp());
  assert.equal(code(again), "solution_pending");
  // A fast claim on the restarted relayer goes out at once, with its fee output.
  const fast = claimOf(w);
  const f = await r2.submit(signedSubmit(a, r2.info(), fast.envelope, "fast"), anyIp());
  assert.equal(f.status, 202, JSON.stringify(f.body));
  assert.equal(f.body.flush, "fast");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await r2.lock.run(() => {});
  assert.equal(r2.state.items[f.body.id].status, "broadcast");
  await w.mine();
  await r2.onTick({ chainTip: w.idx.height });
  assert.equal(r2.state.items[out.body.id].status, "broadcast");
  const [tx] = carriersOf(w, c.envelope);
  assert.equal(hex(feeOutputsOf(tx, r2.change.script)[0].script), MINE_FEE.platformScript);
  assert.equal(r2.checkBooks().ok, true);
  assert.equal(r2.books.serviceOut, 1000);
});

test("a reorg of a queued claim's reference block: the work is checked again in the pool; it is dropped (refunded) when it no longer meets the target, carried under its new solution id when it does", async () => {
  const w = await world();
  await w.coins([20_000, 20_000, 20_000]);
  const a = await w.account();
  // Mining opens at the launch block itself; reference a later block, so the reorg keeps the asset.
  await w.mine();
  await w.tick();
  const tip = w.idx.height;
  assert.ok(tip > w.idx.assets.get(w.asset).deployHeight);
  const lost = claimOf(w);
  const kept = claimOf(w);
  const o1 = await send(w, a, lost.envelope);
  const o2 = await send(w, a, kept.envelope);
  assert.deepEqual([o1.status, o2.status], [202, 202]);
  const bal = w.r.books.account(a.idHex).balance + o1.body.reservedSats;
  // Block `tip` is replaced by another one (a new hash), then the chain moves on.
  w.idx.rollbackTo(tip - 1);
  await w.mine();
  assert.notEqual(w.idx.hashes.get(tip), item(w, o1).refHash);
  const fresh = (c) => w.idx.claimOf(decodeEnvelope(c.envelope));
  w.pool.answers.set(hex(fresh(lost).password), FF); // the new challenge's hash misses the target
  const calls = w.pool.calls.length;
  await w.mine();
  await w.tick();
  assert.ok(w.pool.calls.length >= calls + 2, "both were hashed again in the pool");
  const i1 = item(w, o1);
  assert.equal(i1.status, "dropped");
  assert.match(i1.reason, /no longer valid after a reorg: insufficient work/);
  assert.equal(carriersOf(w, lost.envelope).length, 0);
  const i2 = item(w, o2);
  assert.equal(i2.status, "broadcast");
  assert.equal(i2.solutionId, fresh(kept).solutionIdHex);
  assert.equal(i2.refHash, w.idx.hashes.get(tip));
  assert.equal(w.r.pendingSolutions.get(fresh(kept).solutionIdHex), i2.id);
  assert.equal(w.r.pendingSolutions.has(kept.claim.solutionIdHex), false);
  assert.equal(w.r.books.account(a.idHex).balance, bal + o2.body.reservedSats - i2.cost, "the dropped claim was refunded; only the carried one was charged");
  booksOk(w);
});

/* ---------------------------------------------------------------- I0 / I1 */

test("signPoolTx refuses any output a claim's carrier does not owe: a third-party output, a short or missing fee output, a caller's own fee list; the books do not move", async () => {
  const w = await world();
  await w.coins([20_000]);
  const a = await w.account();
  const c = claimOf(w);
  const out = await send(w, a, c.envelope);
  const it = item(w, out);
  const coin = w.r.spendableCoins().find((u) => u.kind === "change" && u.confirmed);
  const plan = (outputs) => planCarrierTx({ account: w.r.change, utxos: [w.r.utxoOf(coin)], envelope: c.envelope, outputs, feeRate: 2, changeScript: w.r.change.script, order: "given" }).tx;
  const sign = (tx, extra = {}) => w.r.signPoolTx({ tx, inputs: [coin], ref: it.id, kind: "carrier", envelope: c.envelope, ...extra });
  const books = JSON.stringify(w.r.books.toJSON());
  const thief = btcAccount(rand(32)).script;
  for (const [what, tx, extra] of [
    ["third-party output", plan([{ script: PLATFORM, amount: 500n }, { script: thief, amount: 1000n }]), {}],
    ["short fee output", plan([{ script: PLATFORM, amount: 499n }]), {}],
    ["no fee output", plan([]), {}],
    ["fee to someone else", plan([{ script: thief, amount: 500n }]), {}],
    ["caller's list", plan([{ script: thief, amount: 500n }]), { feeOutputs: [{ script: thief, amount: 500n }] }],
  ]) {
    assert.throws(() => sign(tx, extra), /^Error: I1: /, what);
    assert.equal(JSON.stringify(w.r.books.toJSON()), books, `${what}: nothing charged`);
    assert.equal(w.r.state.coins[coin.key].status, "unspent", what);
  }
  // A transfer's carrier still pays nothing but the envelope and C.
  assert.deepEqual(w.r.feeOutputsForEnvelope(synth(w.idx)), []);
  // The exact layout signs, and charges fee + service + margin.
  const ok = sign(plan([{ script: PLATFORM, amount: 500n }]));
  assert.equal(ok.service, 500);
  assert.equal(ok.cost, ok.fee + 500 + marginFor(ok.fee, { marginPct: 10, marginMinSats: 50 }));
  assert.equal(w.r.books.serviceOut, 500);
});

/* ---------------------------------------------------------------- the API */

test("GET /api/mine, /api/mine/:asset, /api/assets(/:ticker), /api/blocks and /api/digest (version only from v2)", async () => {
  const w = await world();
  await w.coins([20_000]);
  const a = await w.account();
  // One relayed claim queued (pendingClaims 1), one self-paid claim landed.
  const queued = claimOf(w);
  const fill = selfPaid(w);
  await w.mine([fill.tx]);
  await w.tick();
  assert.equal((await send(w, a, queued.envelope)).status, 202);
  const app = createApp({ idx: w.idx, relayer: w.r, log: silent });
  apps.push(app);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const get = async (p) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() };
  };
  const asset = w.idx.assets.get(w.asset);
  const tip = w.idx.height;

  const list = await get("/api/mine");
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.activation, { height: ACT, active: true });
  assert.deepEqual(list.body.tip, { height: tip, hash: w.idx.hashes.get(tip) });
  assert.equal(list.body.assets.length, 1);
  const row = list.body.assets[0];
  assert.deepEqual(
    { asset: row.asset, kind: row.kind, ticker: row.ticker, status: row.status, reward: row.reward, issued: row.issued, claims: row.claims, mineStart: row.mineStart },
    { asset: w.asset.toString(), kind: "pow", ticker: asset.ticker, status: "mining", reward: "1000", issued: "1000", claims: 1, mineStart: asset.mineStart },
  );
  assert.deepEqual(row.feeOutputs, [{ script: MINE_FEE.platformScript, address: MINE_FEE.platformAddress, sats: "500", role: "platform" }]);
  assert.deepEqual(row.flags, { lowFloor: row.flags.lowFloor, recipientDiscount: true });
  assert.equal(row.difficulty, w.idx.difficultyAt(w.asset, tip).toString());
  assert.equal(row.staleFloor, (w.idx.difficultyAt(w.asset, tip) / 4n).toString());
  assert.equal(row.target, targetOf(w.idx.difficultyAt(w.asset, tip)).toString(16).padStart(64, "0"));
  assert.equal(row.claimFeeSats, "0");
  assert.equal(row.treasuryAddress, null);
  assert.equal(row.claims144, 1);

  for (const key of [asset.ticker, asset.ticker.toLowerCase(), w.asset.toString()]) {
    const one = await get(`/api/mine/${key}`);
    assert.equal(one.status, 200, key);
    assert.equal(one.body.ticker, asset.ticker);
    assert.deepEqual([one.body.window, one.body.staleFactor, one.body.pendingClaims], [12, 4, 1], key);
    assert.equal(typeof one.body.hashrateEstimate, "number");
    assert.deepEqual(one.body.series.claims, [[fill.env.refHeight + 1, 1]]);
    assert.ok(one.body.series.difficulty.every(([h, d]) => Number.isSafeInteger(h) && /^\d+$/.test(d)));
    assert.deepEqual(one.body.series.difficulty.at(-1), [tip, w.idx.difficultyAt(w.asset, tip).toString()]);
  }
  assert.equal((await get("/api/mine/%3Cb%3E")).status, 400);
  assert.equal((await get("/api/mine/NOPE")).status, 404);
  assert.equal((await get("/api/mine/12345")).status, 404);

  // /api/assets lists paid-mint tokens only; /api/assets/:ticker answers either kind.
  assert.deepEqual((await get("/api/assets")).body, []);
  const byTicker = await get(`/api/assets/${asset.ticker}`);
  assert.deepEqual([byTicker.status, byTicker.body.kind, byTicker.body.asset], [200, "pow", w.asset.toString()]);

  // /api/blocks: `mine` only on a row with an accepted claim; DEPLOY_POW counts as a deploy.
  const blocks = (await get("/api/blocks?limit=144")).body;
  const withClaim = blocks.find((b) => b.height === fill.env.refHeight + 1);
  assert.deepEqual(withClaim.ops, { deploy: 0, mint: 0, transfer: 0, attest: 0, rejected: 0, mine: 1 });
  assert.equal(blocks.filter((b) => "mine" in b.ops).length, 1, "no other row gains the key");

  // /api/digest: no version below the activation height, version 2 from it on.
  const below = await get(`/api/digest?height=${START}`);
  assert.deepEqual(Object.keys(below.body).sort(), ["blockHash", "digest", "height", "root"]);
  const at = await get(`/api/digest?height=${ACT}`);
  assert.equal(at.body.version, 2);
  assert.equal(at.body.digest, w.idx.digestAt(ACT));
});

test("below the pinned activation height the server answers /api/mine with the pinned height, inactive, no assets, and /api/digest keeps the v1 shape", async () => {
  assert.ok(Number.isSafeInteger(MINING_HEIGHT) && MINING_HEIGHT > 6, "a pinned height above this chain");
  const idx = new Indexer({ vkey: JSON.parse(readFileSync("build/dev/verification_key.json", "utf8")), startHeight: 5 });
  await idx.applyBlock({ height: 5, hash: hash32(), txs: [] });
  const app = createApp({ idx, log: silent });
  apps.push(app);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const mine = await (await fetch(`${base}/api/mine`)).json();
  assert.deepEqual(mine, { activation: { height: MINING_HEIGHT, active: false }, tip: { height: 5, hash: idx.hashes.get(5) }, assets: [] });
  const d = await (await fetch(`${base}/api/digest`)).json();
  assert.deepEqual(Object.keys(d).sort(), ["blockHash", "digest", "height", "root"]);
  assert.equal((await fetch(`${base}/api/mine/ABC`)).status, 404);
});

test("with the pinned table the relayer takes claims only for blocks at or after the pinned activation height", async () => {
  const H = MINING_HEIGHT;
  const w = await world({ deploy: false, start: H - 2, table: ACTIVATIONS });
  assert.equal(w.idx.miningHeight, H);
  await w.coins([20_000]);
  const a = await w.account();
  // Tip H - 2: the next block (H - 1) is below activation.
  assert.equal(w.idx.height, H - 2);
  assert.equal(w.r.info().mine.code, "mine_disabled");
  assert.equal(code(await send(w, a, claimOf(w, { asset: 5n, ref: w.idx.height, reward: 1000n }).envelope)), "mine_disabled");
  // A DEPLOY_POW in block H - 1 is an unknown op there.
  const early = encodeDeployPow({ ticker: "EARLYPOW", divisibility: 0, reward: 1000n, maxSupply: 1_000_000n, span: 12, targetPerSpan: 16, initialDifficulty: 1000n, minDifficulty: 256n });
  const earlyTx = { txid: hash32(), inputs: [{ outpoint: rand(36) }], outputs: [{ script: opReturnScript(early), value: 0n }] };
  await w.mine([earlyTx]);
  await w.tick();
  assert.deepEqual(((e) => [e.ok, e.opName, e.reason])(w.idx.log.find((l) => l.txid === earlyTx.txid)), [false, "UNKNOWN", "malformed: unknown op 9"]);
  // Tip H - 1: the next block is the activation block, so claims are taken.
  assert.equal(w.idx.height, H - 1);
  assert.equal(w.r.info().mine.enabled, true, JSON.stringify(w.r.info().mine));
  assert.equal(w.idx.digestVersionAt(H - 1), 1);
  // The launch at H itself is accepted, and the digest is v2 from there on.
  w.asset = await deployPow(w);
  assert.equal(w.idx.height, H);
  assert.equal(w.idx.digestVersionAt(H), 2);
  assert.equal(w.idx.snapshot().version, 3);
});

/* ---------------------------------------------------------------- fix round (mining review) */

import { MAGIC, VERSION } from "../src/envelope.mjs";
const MAGIC_HEADER = (op) => concat(MAGIC, Uint8Array.of(VERSION, op));

test("isOwnScript never walks deposit indexes: a credit at n = 2^31 - 2 costs a few derivations, and a deposit that pays a fee script is never credited", async () => {
  const w = await world();
  await w.coins([20_000, 20_000]);
  const a = await w.account();
  // An attacker credits the highest deposit index it can: nextIndex becomes 2^31 - 1.
  const farAccount = newAccount();
  const far = await fundAccount({ relayer: w.r, esplora: w.esplora, account: farAccount, sats: 30_000, n: 2 ** 31 - 2 });
  assert.equal(far.status, 200, JSON.stringify(far.body));
  const t0 = Date.now();
  assert.equal(w.r.isOwnScript(btcAccount(rand(32)).script), false);
  assert.ok(Date.now() - t0 < 2000, "answered at once");
  // L2: the list holds two scripts per credit (the credited one and the next one), no account.
  assert.ok(w.r.ownScripts.size <= 2 * w.r.books.creditMap.size, `listed ${w.r.ownScripts.size} scripts`);
  // Credited and handed-out addresses are still the relayer's own; an index never used is not.
  assert.equal(w.r.books.account(farAccount.idHex).nextIndex, 2 ** 31 - 1, "the far account is in the books");
  assert.equal(w.r.isOwnScript(depositAddress(w.r.Q, farAccount.id, 2 ** 31 - 2, "signet").script), true, "credited");
  assert.equal(w.r.isOwnScript(depositAddress(w.r.Q, farAccount.id, 2 ** 31 - 1, "signet").script), true, "handed out");
  assert.equal(w.r.isOwnScript(depositAddress(w.r.Q, a.id, 0, "signet").script), true, "credited");
  assert.equal(w.r.isOwnScript(depositAddress(w.r.Q, a.id, 1, "signet").script), true, "handed out");
  assert.equal(w.r.isOwnScript(depositAddress(w.r.Q, a.id, 5, "signet").script), false, "never used");
  // A claim submit is answered promptly (it reaches step 6 and isOwnScript).
  const t1 = Date.now();
  assert.equal((await send(w, a, claimOf(w).envelope)).status, 202);
  assert.ok(Date.now() - t1 < 5000);

  // A treasury that is an unused deposit address of an account: the deposit is refused when credited.
  const v = await world({ mineFee: { ...MINE_FEE, deployerMaxSats: 10_000n }, deploy: false });
  const b = newAccount();
  while (v.idx.height + 1 < ACT) await v.mine();
  await deployPow(v, { claimFeeSats: 1000n, treasury: depositAddress(v.r.Q, b.id, 7, "signet").script });
  const refused = await fundAccount({ relayer: v.r, esplora: v.esplora, account: b, sats: 30_000, n: 7 });
  assert.deepEqual([refused.status, refused.body.error.code], [422, "deposit_own"]);
  assert.match(refused.body.error.message, /mining service fees/);
  assert.equal(v.r.books.account(b.idHex).balance, 0, "nothing credited");
  // The platform's own script can never be a deposit either.
  assert.equal(v.r.isFeeScript(PLATFORM), true);
});

test("pendingClaims counts only mempool claims that could land: junk, unknown tokens, unpaid fees and work below the target are ignored", async () => {
  const w = await world();
  w.esplora.mempoolTxids = async () => [...w.esplora.mempool];
  const junk = concat(MAGIC_HEADER(OP.MINE), rand(400)); // a MINE header on random bytes
  w.esplora.pay([{ script: opReturnScript(junk), value: 0 }, { script: PLATFORM, value: 500 }]);
  const unknown = selfPaid(w, { asset: 4242n, reward: 1000n }); // decodes, unknown token
  w.esplora.pay([{ script: opReturnScript(unknown.envelope), value: 0 }, { script: PLATFORM, value: 500 }]);
  const unpaid = selfPaid(w); // no service-fee output
  w.esplora.pay([{ script: opReturnScript(unpaid.envelope), value: 0 }]);
  const short = selfPaid(w); // 499 < 500 sats
  w.esplora.pay([{ script: opReturnScript(short.envelope), value: 0 }, { script: PLATFORM, value: 499 }]);
  const weak = selfPaid(w); // work below the target (the pool says so)
  w.pool.answers.set(hex(weak.claim.password), FF);
  w.esplora.pay([{ script: opReturnScript(weak.envelope), value: 0 }, { script: PLATFORM, value: 500 }]);
  const stale = selfPaid(w, { ref: w.idx.height - MINE_WINDOW - 1 }); // outside the window at the next block
  w.esplora.pay([{ script: opReturnScript(stale.envelope), value: 0 }, { script: PLATFORM, value: 500 }]);
  const good = selfPaid(w);
  w.esplora.pay([{ script: opReturnScript(good.envelope), value: 0 }, { script: PLATFORM, value: 500 }]);
  await w.r.refreshMempoolClaims();
  assert.equal(w.r.pendingClaims(w.asset), 1, "only the claim that pays and meets the target");
  assert.equal(w.r.pendingReward(w.asset), 1000n);
  // Its notes spent by another transaction: it no longer counts (the cheap rules run again at every count).
  w.idx.nullifiers.add(String(good.env.nullifiers[0]));
  assert.equal(w.r.pendingClaims(w.asset), 0);
  // A worker failure is not a verdict: the transaction is looked up again next tick.
  const later = selfPaid(w);
  w.pool.answers.set(hex(later.claim.password), powError("POW_WORKER_FAILED"));
  const laterTxid = w.esplora.pay([{ script: opReturnScript(later.envelope), value: 0 }, { script: PLATFORM, value: 500 }]);
  await w.r.refreshMempoolClaims();
  assert.equal(w.r.mempoolClaims.has(laterTxid), false);
  w.pool.answers.delete(hex(later.claim.password));
  await w.r.refreshMempoolClaims();
  assert.equal(w.r.pendingClaims(w.asset), 1);
});

test("the in-flight cap sums each pending claim's own reward: claims from before a halving count at their larger reward", async () => {
  // reward 1000 halving every 3 blocks; 3 claims at ref = mineStart (1000 each), then one at mineStart + 3 (500).
  const w = await world({ terms: { maxSupply: 3000n, halvingInterval: 3 } });
  await w.coins([20_000, 20_000, 20_000, 20_000, 20_000]);
  const a = await w.account(60_000);
  const start = w.idx.height;
  assert.equal(w.idx.rewardAt(w.asset, start), 1000n);
  for (let i = 0; i < 3; i++) assert.equal((await send(w, a, claimOf(w).envelope)).status, 202);
  for (let i = 0; i < 3; i++) await w.mine(); // no tick: the three stay queued
  assert.equal(w.idx.rewardAt(w.asset, w.idx.height), 500n);
  assert.equal(w.r.pendingReward(w.asset), 3000n);
  // 3 x 1000 in flight + 500 > 3000: refused (counting 4 x 500 = 2000 would have let it through).
  const late = await send(w, a, claimOf(w).envelope);
  assert.deepEqual([late.status, code(late)], [409, "cap_reached"]);
  assert.equal(w.r.pendingClaims(w.asset), 3);
});

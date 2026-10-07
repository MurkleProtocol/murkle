// The relayer (relayer.md §4.11, relay balances: docs/design/relay-balance-contract.md §4): the
// signed submit pipeline step by step with every error code, nullifier reservation under
// concurrency, the global gates, flush/broadcast/reconcile outcomes with real proofs, charges to
// the relay balance, journaling across restarts, reorgs and fan-out. Synthetic blocks and a fake
// esplora (test/fixtures/relay-harness.mjs): nothing touches a network and nothing is ever
// broadcast for real. The relayer's coins are credited deposits, never an address listing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { deriveKeys } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { decodeEnvelope, encodeDeploy, opReturnScript, opReturnPayload } from "../src/envelope.mjs";
import { addressOf, btcAccount, planCarrierTx } from "../src/btc/funding.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { equal, hex, unhex } from "../src/bytes.mjs";
import { LABELS } from "../src/params.mjs";
import { TAG, checkPow, grind, leadingZeroBits, nonceOf, powBits, powDigest } from "../src/relay-pow.mjs";
import { DEFAULTS, ERROR_STATUS, clientIp, codeForReason, configFromEnv, ipPrefix, parseSubmit, relayerStartup } from "../server/relayer.mjs";
import { depositAddress } from "../src/relay-account.mjs";
import { FakeEsplora, fundAccount, makePaidRelayer, newAccount, signedSubmit } from "./fixtures/relay-harness.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const START = 800000;
const TEST_IP = "203.0.113.77";
const hash32 = () => randomBytes(32).toString("hex");
const DIR = mkdtempSync(join(tmpdir(), "murkle-relayer-"));
const STATE_PATH = join(DIR, "relay-balance", "relayer.json");
const silent = { warn() {}, error() {}, log() {} };
const relayers = [];
const PER = 598; // one carrier at 1 sat/vB
const COST = 658; // 598 + max(50, ceil(59.8))

after(async () => {
  relayers.forEach((r) => r.close());
  rmSync(DIR, { recursive: true, force: true });
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

// ------------------------------------------------------------------ chain

const fake = new FakeEsplora();
const idx = new Indexer({ vkey: VKEY, startHeight: START });
const alice = new Wallet(deriveKeys(randomBytes(32)));
const bob = new Wallet(deriveKeys(randomBytes(32)));
const carol = new Wallet(deriveKeys(randomBytes(32)));
const aliceBtc = btcAccount(new Uint8Array(randomBytes(32))); // her built-in fee address
const payer = newAccount(); // Alice's relay account: it pays every relayed send below
const ASSET = assetIdOf(START, 1);
let notes; // Alice's minted notes, by leaf order
let mintEnvelope;
let R; // the relayer under test (replaced by a restarted instance in the restart test)
const responses = []; // every response body, for the privacy check

const coinbase = () => ({ txid: hash32(), inputs: [], outputs: [] });
/** A user-paid carrier in indexer form (not a Bitcoin transaction). */
const ownCarrier = (envelope, first = randomBytes(36)) => ({ txid: hash32(), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(envelope), value: 0n }] });

async function mine(txs = []) {
  const height = idx.height + 1;
  await idx.applyBlock({ height, hash: hash32(), txs: [coinbase(), ...txs] });
  fake.confirm(txs.map((t) => t.txid), height);
  return height;
}
const mempoolTxs = (f = fake) => [...f.mempool].map((id) => parseRawTx(f.txs.get(id)));
/** Mines every carrier the relayer broadcast and that is still unconfirmed. */
const mineBroadcasts = () => mine(mempoolTxs());
const tick = (r = R) => r.onTick({ chainTip: idx.height });

/** The relayer under test, from its directory under DIR (a restart reads the same keys and state). */
async function newRelayer(extra = {}, { esplora = fake, dir = DIR, fastDelayMs = () => 60_000 } = {}) {
  const r = await makePaidRelayer({ idx, esplora, dir, config: { fanoutTarget: 0, ...extra }, log: silent, fastDelayMs });
  relayers.push(r);
  return r;
}

/** Transfer of 100 from one of Alice's notes (explicit inputs: full control over nullifiers). */
async function transferFrom(note, to = bob) {
  alice.scan(idx);
  return alice.transfer(idx, { asset: ASSET, amount: 100n, to: to.address, inputs: [note.nullifier] });
}

async function submit(envelope, { ip = TEST_IP, mode = "block", r = R, raw, account = payer } = {}) {
  const body = raw ?? signedSubmit(account, r.info(), envelope, mode);
  const out = await r.submit(body, ip);
  responses.push(JSON.stringify(out.body));
  return out;
}
const codeOf = (out) => out.body.error?.code;
const noValidating = (r = R) => [...r.pending.values()].every((v) => !String(v).startsWith("validating"));
const carrierOf = (envelope) => fake.accepted.map((raw) => btc.Transaction.fromRaw(unhex(raw), { allowUnknownOutputs: true }))
  .find((tx) => equal(opReturnPayload(tx.getOutput(0).script) ?? new Uint8Array(), envelope));
const bal = (a = payer) => R.books.account(a.idHex);
/** A carrier (OP_RETURN output 0), not a merge or a fan-out. */
const isCarrierRaw = (raw) => btc.Transaction.fromRaw(unhex(raw), { allowUnknownOutputs: true }).getOutput(0).script[0] === 0x6a;
const carrierCalls = (f = fake) => f.calls.filter(isCarrierRaw).length;

// ------------------------------------------------------------------ tests

test("relay-pow: round trip, wrong block / envelope / bits fail, leadingZeroBits edges", () => {
  assert.equal(new TextDecoder().decode(TAG), "murkle/relay/pow/v1");
  assert.equal(LABELS.relayPow, "murkle/relay/pow/v1");
  const envelope = randomBytes(471);
  const block = hash32();
  const { nonce } = grind({ envelope, block, bits: 10 });
  assert.equal(checkPow({ envelope, block, nonce, bits: 10 }), true);
  assert.equal(checkPow({ envelope: hex(envelope), block, nonce, bits: 10 }), true, "hex and bytes hash the same");
  assert.ok(leadingZeroBits(powDigest({ envelope, block, nonce })) >= 10);
  const other = hash32();
  assert.equal(checkPow({ envelope, block: other, nonce, bits: 10 }) && checkPow({ envelope: randomBytes(471), block, nonce, bits: 10 }), false);
  assert.equal(checkPow({ envelope, block, nonce, bits: 40 }), false);
  assert.equal(checkPow({ envelope, block: "zz", nonce, bits: 1 }), false, "malformed input is false, not a throw");
  // Manual digest: sha256(TAG ‖ block ‖ sha256(envelope) ‖ nonce)
  assert.equal(nonce.length, 16);
  assert.deepEqual(nonceOf(258), new Uint8Array([0, 0, 0, 0, 0, 0, 1, 2]));

  assert.equal(leadingZeroBits(new Uint8Array([0x80])), 0);
  assert.equal(leadingZeroBits(new Uint8Array([0x01])), 7);
  assert.equal(leadingZeroBits(new Uint8Array([0x00, 0x40])), 9);
  assert.equal(leadingZeroBits(new Uint8Array([0, 0, 0])), 24);
  assert.equal(leadingZeroBits(new Uint8Array([])), 0);

  // Split search: two workers with step 2 cover the space between them.
  const even = grind({ envelope, block, bits: 6, start: 0, step: 2 });
  assert.equal(even.counter % 2, 0);
  assert.equal(grind({ envelope, block, bits: 64, limit: 50 }), null);

  assert.equal(powBits({}), 18);
  assert.equal(powBits({ acceptedThisBlock: 8 }), 19);
  assert.equal(powBits({ acceptedThisBlock: 10_000 }), 24, "load extra capped at 6");
  assert.equal(powBits({ spentToday: 60, reserved: 0, budget: 100 }), 20, "past half the budget");
});

test("config, ip prefixes, client ip and error mapping", () => {
  const cfg = configFromEnv((name) => ({ RELAYER: "0", DAILY_BUDGET_SATS: "5000", TRUST_PROXY: "1" })[name]);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.dailyBudgetSats, undefined, "the free relayer's budget is gone (relay-balance.md)");
  assert.equal(cfg.trustProxy, true);
  assert.equal("hotFloorSats" in DEFAULTS, false);
  assert.deepEqual([DEFAULTS.marginPct, DEFAULTS.marginMinSats, DEFAULTS.minDepositSats, DEFAULTS.batchHeadroom], [10, 50, 2000, 2]);
  assert.throws(() => configFromEnv((n) => (n === "MAX_QUEUE" ? "lots" : undefined)), /MURKLE_MAX_QUEUE/);

  assert.equal(ipPrefix("192.0.2.33"), ipPrefix("192.0.2.200"));
  assert.notEqual(ipPrefix("192.0.2.33"), ipPrefix("192.0.3.33"));
  assert.equal(ipPrefix("::ffff:192.0.2.9"), ipPrefix("192.0.2.1"), "IPv4-mapped IPv6 is IPv4");
  assert.equal(ipPrefix("2001:db8:aa:bb11::1"), ipPrefix("2001:db8:aa:bbff:ffff::9"), "same /56");
  assert.notEqual(ipPrefix("2001:db8:aa:bb11::1"), ipPrefix("2001:db8:aa:cc11::1"));
  assert.equal(ipPrefix("[2001:db8::1]:443"), ipPrefix("2001:0db8:0000:0000::2"));

  const req = { headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.2" }, socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientIp(req, false), "127.0.0.1", "X-Forwarded-For is ignored unless the proxy is trusted");
  assert.equal(clientIp(req, true), "10.0.0.2", "the last hop is the one our proxy added");

  assert.equal(codeForReason("proof does not verify"), "proof_invalid");
  assert.equal(codeForReason("invalid proof encoding: x"), "proof_invalid");
  assert.equal(codeForReason("anchor outside window"), "anchor_stale");
  assert.equal(codeForReason("nullifier already spent"), "nullifier_spent");
  for (const code of Object.keys(ERROR_STATUS)) assert.ok(ERROR_STATUS[code] >= 400);
  for (const gone of ["pow_stale", "pow_insufficient", "hot_wallet_low", "budget_exhausted", "fee_too_high"]) assert.equal(gone in ERROR_STATUS, false, gone);

  const body = (o) => JSON.stringify({ envelope: "ab".repeat(471), mode: "block", accountPub: "11".repeat(32), t: 1, sig: "22".repeat(64), ...o });
  assert.throws(() => parseSubmit("{"), (e) => e.code === "malformed");
  assert.throws(() => parseSubmit(body({ envelope: "AB".repeat(471) })), (e) => e.code === "malformed", "uppercase hex");
  assert.throws(() => parseSubmit(body({ mode: "turbo" })), (e) => e.code === "malformed");
  assert.throws(() => parseSubmit(body({ pow: { block: hash32(), nonce: "00".repeat(8) } })), (e) => e.code === "malformed", "no proof of work any more");
  const { mode: _m, ...noMode } = JSON.parse(body());
  assert.throws(() => parseSubmit(JSON.stringify(noMode)), (e) => e.code === "malformed", "the mode is required: it is signed");
  assert.equal(parseSubmit(body({ mode: "batch10" })).mode, "batch10");
});

test("setup: a free token, ten minted notes for Alice, a paid relayer and her relay balance", async () => {
  await mine([ownCarrier(encodeDeploy({ ticker: "GHOST", divisibility: 0, mintAmount: 100n, mintCap: 1000, priceSats: 0n, treasury: new Uint8Array() }))]);
  const mints = [];
  for (let i = 0; i < 10; i++) {
    const bind = randomBytes(36);
    const env = await alice.mint(idx, { asset: ASSET, mintAmount: 100n, bindOutpoint: bind });
    mints.push(ownCarrier(env, bind));
  }
  mintEnvelope = opReturnPayload(mints[0].outputs[0].script);
  await mine(mints);
  notes = alice.scan(idx).notes.sort((a, b) => a.leafIndex - b.leafIndex);
  assert.equal(notes.length, 10);
  assert.equal(alice.balance(ASSET), 1000n);

  R = await newRelayer();
  assert.equal(R.gateCode(), "busy", "no submissions before the first tick has priced fees");
  await tick();
  assert.equal(R.gateCode(), null);
  for (let i = 0; i < 8; i++) {
    const f = await fundAccount({ relayer: R, esplora: fake, account: payer, sats: 50_000 });
    assert.equal(f.status, 200, JSON.stringify(f.body));
  }
  assert.deepEqual(bal(), { balance: 8 * (50_000 - 288), reserved: 0, nextIndex: 8 });
  assert.equal(R.info().fees.carrierFeeSats, PER);
  assert.equal(R.info().balance.perSendSats, COST);
  assert.equal(R.state.ledger.length, 0, "8 confirmed coins: no fan-out needed");
});

let T1, T1again, T1id;

test("a valid transfer is queued (202), both nullifiers are pending and the balance holds its reservation", async () => {
  T1 = await transferFrom(notes[0]);
  const before = bal().balance;
  const out = await submit(T1);
  assert.equal(out.status, 202, JSON.stringify(out.body));
  assert.match(out.body.id, /^[0-9a-f]{32}$/);
  assert.deepEqual({ ...out.body, id: undefined }, {
    id: undefined, status: "queued", anchor: idx.height, deadline: idx.height + 100, flush: "next-block", reservedSats: COST, balance: before - COST,
  });
  T1id = out.body.id;
  const env = decodeEnvelope(T1);
  assert.deepEqual(env.nullifiers.map((n) => R.pending.get(String(n))), [T1id, T1id]);
  assert.equal(R.status(T1id).status, "queued");
  assert.deepEqual([bal().balance, bal().reserved], [before - COST, COST]);
  assert.ok(existsSync(STATE_PATH) && !existsSync(STATE_PATH + ".tmp"), "persisted atomically before answering");
  const saved = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  assert.equal(saved.items[T1id].envelope, hex(T1));
});

test("the same envelope again, and a re-proof of the same notes, are both nullifier_pending (409)", async () => {
  const again = await submit(T1);
  assert.equal(again.status, 409);
  assert.equal(codeOf(again), "nullifier_pending");
  T1again = await transferFrom(notes[0], carol); // same note, new randomness: different bytes
  assert.notEqual(hex(T1again), hex(T1));
  const reproof = await submit(T1again);
  assert.equal(codeOf(reproof), "nullifier_pending");
  assert.ok(noValidating());
});

test("wallet: transfer({ inputs }) reproduces the same nullifiers; bad retry inputs are refused", async () => {
  assert.deepEqual(T1again.spends, T1.spends);
  assert.equal(decodeEnvelope(T1again).nullifiers[0], decodeEnvelope(T1).nullifiers[0]);
  assert.equal(T1.spends[0], String(notes[0].nullifier));
  alice.scan(idx);
  alice.locked.add(String(notes[0].nullifier)); // W-1 lock does not block the retry itself
  assert.equal(alice.notesFor(ASSET, 100n, [notes[0].nullifier]).picked[0].leafIndex, notes[0].leafIndex);
  alice.locked.clear();
  assert.throws(() => alice.notesFor(ASSET, 101n, [notes[0].nullifier]), /insufficient/);
  assert.throws(() => alice.notesFor(ASSET, 1n, ["123"]), /not a note of this wallet/);
  assert.throws(() => alice.notesFor(ASSET, 1n, [notes[0].nullifier, notes[0].nullifier]), /repeat/);
});

let winnerId;

test("two concurrent submits spending the same notes: exactly one is accepted", async () => {
  const [e1, e2] = [await transferFrom(notes[1], carol), await transferFrom(notes[1], carol)];
  const outs = await Promise.all([submit(e1), submit(e2)]);
  assert.deepEqual(outs.map((o) => o.status).sort(), [202, 409]);
  assert.equal(codeOf(outs.find((o) => o.status === 409)), "nullifier_pending");
  winnerId = outs.find((o) => o.status === 202).body.id;
  assert.ok(noValidating());
});

test("every pipeline rejection has its own code, raised at its own step", async () => {
  const T3 = await transferFrom(notes[2], carol);
  let proofChecks = 0;
  const realCheck = idx.checkTx.bind(idx);
  idx.checkTx = (...args) => {
    proofChecks += 1;
    return realCheck(...args);
  };
  const patched = (fn) => {
    const e = Uint8Array.from(T3);
    fn(e);
    return e;
  };
  const expect = async (out, status, code) => {
    assert.equal(out.status, status, `${code}: ${JSON.stringify(out.body)}`);
    assert.equal(codeOf(out), code);
    assert.ok(out.body.error.message.length > 10);
    assert.ok(noValidating(), `${code} released its reservation`);
  };
  const signed = JSON.parse(signedSubmit(payer, R.info(), T3, "block"));
  try {
    // Step 0: request shape.
    await expect(await submit(mintEnvelope), 400, "malformed"); // a MINT is 1014 hex chars
    await expect(await submit(T3, { raw: "not json" }), 400, "malformed");
    await expect(await submit(T3, { raw: JSON.stringify({ envelope: hex(T3), pow: { block: hash32() } }) }), 400, "malformed");
    await expect(await submit(T3, { mode: "warp" }), 400, "malformed");
    // Step 2: the signature.
    await expect(await submit(T3, { raw: JSON.stringify({ ...signed, sig: "00".repeat(64) }) }), 401, "bad_signature");
    await expect(await submit(T3, { raw: JSON.stringify({ ...signed, mode: "fast" }) }), 401, "bad_signature");
    // Step 3: the balance.
    const broke = newAccount();
    const low = await submit(T3, { account: broke });
    await expect(low, 402, "balance_low");
    assert.deepEqual([low.body.error.balance, low.body.error.needed, low.body.error.perSend], [0, COST, COST]);
    // Step 5: decode.
    await expect(await submit(patched((e) => (e[4] = 3))), 400, "not_transact");
    await expect(await submit(patched((e) => (e[0] ^= 0xff))), 400, "malformed");
    await expect(await submit(patched((e) => (e[17] ^= 1))), 400, "public_value"); // publicAmount byte
    // Nullifiers.
    await expect(await submit(patched((e) => e.set(e.slice(25, 57), 57))), 409, "duplicate_nullifier");
    // Step 6: freshness.
    await expect(await submit(patched((e) => new DataView(e.buffer).setUint32(5, idx.height + 5, true))), 422, "anchor_unknown");
    assert.equal(proofChecks, 0, "every rejection so far came before proof verification");
    // Step 7: full check. An invalid proof costs the account 50 sats (to the margin).
    const before = bal().balance;
    await expect(await submit(patched((e) => (e[200] ^= 1))), 422, "proof_invalid"); // ciphertext byte
    assert.equal(proofChecks, 1);
    assert.equal(bal().balance, before - 50);

    // Step 1: global gates (each restored afterwards).
    const gates = [
      ["disabled", () => (R.config.enabled = false), () => (R.config.enabled = true)],
      ["halted", () => (R.state.halted = { height: idx.height, problems: ["test"] }), () => (R.state.halted = null)],
      ["indexer_behind", () => (R.chainTip = idx.height + 3), () => (R.chainTip = idx.height)],
      ["fee_high", () => (R.cache.feeRate = 6), () => (R.cache.feeRate = 1)],
      ["block_full", () => (R.config.maxRelaysPerBlock = R.blockCount()), () => (R.config.maxRelaysPerBlock = DEFAULTS.maxRelaysPerBlock)],
      ["queue_full", () => (R.config.maxQueue = R.queuedCount()), () => (R.config.maxQueue = DEFAULTS.maxQueue)],
      ["pool_low", () => Object.keys(R.state.coins).forEach((k) => R.suspect.set(k, idx.height)), () => R.suspect.clear()],
      ["busy", () => (R.config.verifyMaxPerSec = 0), () => (R.config.verifyMaxPerSec = DEFAULTS.verifyMaxPerSec)],
    ];
    for (const [code, set, reset] of gates) {
      set();
      try {
        await expect(await submit(T3), ERROR_STATUS[code], code);
      } finally {
        reset();
      }
    }
    assert.equal(R.info().reason, null);
    assert.equal(proofChecks, 1, "gates, the coin check and the verification-rate cap stop before any proof check");

    // After all of that, T3's notes are free again.
    const ok = await submit(T3);
    assert.equal(ok.status, 202);
  } finally {
    idx.checkTx = realCheck;
  }
});

test("invalid proofs are limited per account per hour, before the proof check; another account and valid sends are not affected", async () => {
  R.config.invalidPerHour = 1; // the one above already counts
  try {
    const T = await transferFrom(notes[3]);
    const bad = Uint8Array.from(T);
    bad[200] ^= 1;
    const limited = await submit(bad, { ip: "198.51.100.5" });
    assert.equal(limited.status, 429);
    assert.equal(codeOf(limited), "rate_limited");
    assert.ok(limited.body.error.retryAfter > 0 && limited.body.error.retryAfter <= 3600);
    assert.equal(codeOf(await submit(T, { ip: "198.51.100.5" })), "rate_limited", "the account is limited, whatever it sends");
    const other = newAccount();
    await fundAccount({ relayer: R, esplora: fake, account: other, sats: 7000 });
    assert.equal((await submit(T, { account: other, ip: "198.51.100.6" })).status, 202, "another account is not");
    assert.equal((await submit(await transferFrom(notes[4]), { account: other, ip: "192.0.2.9" })).status, 202);
  } finally {
    R.config.invalidPerHour = DEFAULTS.invalidPerHour;
    R.invalid.clear();
  }
});

let carrierHeight;

test("flush after a new block: one 1-in / OP_RETURN / change carrier per item, charged to the balance; reconcile accepts it; Bob finds the note", async () => {
  const queued = R.items.filter((i) => i.status === "queued");
  assert.equal(queued.length, 5); // T1, the concurrent winner, T3, two sends of the rate-limit test
  const before = carrierCalls();
  await tick(); // same height: nothing is flushed between blocks (the deposits are merged into C)
  assert.equal(carrierCalls(), before);

  const feesBefore = R.books.toJSON().totals.fees;
  await mine([]);
  await tick();
  assert.equal(fake.accepted.filter(isCarrierRaw).length, 5, "each queued envelope broadcast exactly once");
  assert.equal(new Set(fake.accepted.filter(isCarrierRaw)).size, 5);
  const tx = carrierOf(T1);
  assert.ok(tx, "T1 was carried");
  assert.equal(tx.inputsLength, 1);
  assert.equal(tx.getInput(0).sequence, 0xfffffffd, "L5: RBF is signalled on every input, as every route does (the relayer still never replaces a carrier)");
  assert.equal(tx.outputsLength, 2);
  assert.ok(equal(tx.getOutput(0).script, opReturnScript(T1)), "output 0 is the exact envelope");
  assert.equal(addressOf(tx.getOutput(1).script), R.address, "change goes to the relayer's change key C");
  // The carrier spends a pool coin at C, never a deposit (deposits reach C through a merge), so no
  // depositor's address is one hop from it; Alice's BTC address appears nowhere in it.
  const spentKey = `${hex(tx.getInput(0).txid)}:${tx.getInput(0).index}`;
  const [, spentCoin] = fake.spentBy.get(spentKey);
  assert.equal(R.books.isCredited(spentKey), null, "never a credited deposit");
  assert.ok(equal(spentCoin.script, R.change.script), "change at C");
  for (const raw of fake.accepted.filter(isCarrierRaw)) {
    const t = btc.Transaction.fromRaw(unhex(raw), { allowUnknownOutputs: true });
    assert.equal(R.books.isCredited(`${hex(t.getInput(0).txid)}:${t.getInput(0).index}`), null, "no carrier input is a deposit outpoint");
  }
  const merges = R.state.ledger.filter((l) => l.kind === "merge");
  assert.equal(merges.length, 1, "the 8 deposits went to C in one merge, paid from the margin");
  assert.ok(!equal(spentCoin.script, aliceBtc.script));
  const scripts = Array.from({ length: tx.outputsLength }, (_, v) => tx.getOutput(v).script);
  assert.ok(scripts.every((s) => !equal(s, aliceBtc.script)));

  const item = R.state.items[T1id];
  assert.equal(R.status(T1id).status, "broadcast");
  assert.equal(R.status(T1id).txid, tx.id);
  assert.equal(R.status(T1id).cost, COST);
  assert.equal(item.envelope, undefined, "the envelope is kept only while queued");
  assert.equal(item.account, undefined, "nor the account, once broadcast");
  assert.equal(bal().reserved, 0);
  // planCarrierTx rounds the half vbyte of a taproot input up: 598 sats at 1 sat/vB.
  assert.equal(R.books.toJSON().totals.fees - feesBefore, 5 * PER);
  const ledger = R.ledgerView();
  assert.equal(ledger.totals.carriers, 5);
  assert.equal(ledger.totals.satsSpent, 5 * PER + merges[0].fee);
  assert.equal(ledger.totals.fanoutSats, merges[0].fee);
  assert.ok(ledger.items.filter((l) => l.kind === "carrier").every((l) => l.outcome === "pending" && l.fee === PER && l.feeRate === 1 && l.vsize === tx.vsize));
  assert.equal(R.checkBooks().ok, true);

  carrierHeight = await mineBroadcasts();
  await tick();
  assert.deepEqual(R.status(T1id), { status: "accepted", txid: tx.id, height: carrierHeight, broadcastHeight: carrierHeight - 1, cost: COST, anchor: item.anchor, deadline: item.anchor + 100 });
  assert.equal(R.ledgerView().totals.accepted, 5);
  assert.equal(R.ledgerView().items.find((l) => l.txid === tx.id).outcome, "accepted");
  assert.ok(!R.pending.size, "final items release their nullifiers");
  assert.equal(bob.scan(idx).balance(ASSET), 300n); // T1 and both rate-limit transfers
  assert.equal(R.info().stats.relayed144, 5);
  assert.deepEqual(R.info().stats.landed144, [[carrierHeight, 5]]);
});

test("reorg: the carrier's block rolls back, the item returns to broadcast and the raw tx is sent again", async () => {
  const raw = R.state.items[T1id].raw;
  const block = { height: carrierHeight, hash: idx.hashes.get(carrierHeight) };
  const txsBefore = [...fake.mined.keys()];
  idx.rollbackTo(carrierHeight - 1);
  const calls = fake.calls.length;
  await tick();
  assert.equal(R.status(T1id).status, "broadcast");
  assert.ok(fake.calls.slice(calls).includes(raw), "rebroadcast with identical bytes");
  assert.equal(R.ledgerView().items.find((l) => l.txid === R.state.items[T1id].txid).outcome, "pending");
  assert.equal(R.pending.get(T1.spends[0]), T1id, "its nullifiers are pending again");

  // The same carriers confirm again in the replacement block.
  const txs = fake.accepted.map((r) => parseRawTx(r)).filter((t) => txsBefore.includes(t.txid));
  await idx.applyBlock({ height: carrierHeight, hash: block.hash, txs: [coinbase(), ...txs] });
  await tick();
  assert.equal(R.status(T1id).status, "accepted");
  assert.equal(R.ledgerView().totals.accepted, 5);
  assert.equal(R.checkBooks().ok, true);
});

test("after the transfer lands, its notes are nullifier_spent (409)", async () => {
  const out = await submit(T1again);
  assert.equal(out.status, 409);
  assert.equal(codeOf(out), "nullifier_spent");
});

test("the user carries the same envelope first: the item is dropped, nothing is broadcast and nothing charged", async () => {
  const X = await transferFrom(notes[5]);
  const before = bal().balance;
  const out = await submit(X);
  assert.equal(out.status, 202);
  const calls = carrierCalls();
  await mine([ownCarrier(X)]);
  await tick();
  assert.equal(R.status(out.body.id).status, "dropped");
  assert.match(R.status(out.body.id).reason, /already spent/);
  assert.equal(carrierCalls(), calls, "broadcast never called");
  assert.deepEqual([bal().balance, bal().reserved], [before, 0], "its reservation is returned");
});

let staleEnvelope;

test("fees above the cap when a Next-block item is due: missed (fee_high), never held, nothing charged", async () => {
  staleEnvelope = await transferFrom(notes[9]); // for the anchor_stale test below
  const Y = await transferFrom(notes[6]);
  const before = bal().balance;
  const out = await submit(Y);
  assert.equal(out.status, 202);
  fake.fee = 50;
  const calls = fake.calls.length;
  await mine([]);
  await tick();
  assert.deepEqual([R.status(out.body.id).status, R.status(out.body.id).code], ["missed", "fee_high"]);
  assert.equal(fake.calls.length, calls);
  assert.deepEqual([bal().balance, bal().reserved], [before, 0]);
  fake.fee = 1;
  // 77 more blocks age the envelope kept for the next test.
  for (let i = 0; i < 77; i++) {
    await mine([]);
    await tick();
  }
});

test("an envelope proven 80 blocks ago is anchor_stale", async () => {
  await mine([]);
  await mine([]);
  R.chainTip = idx.height;
  const out = await submit(staleEnvelope);
  assert.equal(out.status, 422);
  assert.equal(codeOf(out), "anchor_stale");
});

test("a conflicting envelope mined ahead of the carrier in the same block: rejected, counted as wasted, still paid by the balance", async () => {
  const Z = await transferFrom(notes[7]);
  const before = bal().balance;
  const out = await submit(Z);
  assert.equal(out.status, 202);
  await mine([]);
  await tick();
  const carrier = carrierOf(Z);
  assert.ok(carrier);
  const Zconflict = await transferFrom(notes[7], carol); // same note, proven again
  await mine([ownCarrier(Zconflict), parseRawTx(fake.txs.get(carrier.id))]);
  await tick();
  const st = R.status(out.body.id);
  assert.equal(st.status, "rejected");
  assert.match(st.reason, /already spent/);
  const entry = R.ledgerView().items.find((l) => l.txid === carrier.id);
  assert.equal(entry.outcome, "rejected");
  assert.equal(R.ledgerView().totals.wasted, 1);
  assert.equal(bal().balance, before - COST, "once broadcast, the fee is spent: the user paid it, not the operator");
  assert.equal(R.checkBooks().ok, true);
});

test("restart: the queue, pending nullifiers and reservations come back; a signing journal entry is resent with identical bytes", async () => {
  const W = await transferFrom(notes[8]);
  const out = await submit(W);
  assert.equal(out.status, 202);
  const id = out.body.id;

  const R2 = await newRelayer();
  assert.equal(R2.status(id).status, "queued");
  assert.deepEqual(decodeEnvelope(W).nullifiers.map((n) => R2.pending.get(String(n))), [id, id]);
  assert.deepEqual(R2.books.account(payer.idHex), bal());
  R.close();

  // A broadcast that fails (network error) leaves the journal in "signing", already charged.
  await R2.onTick({ chainTip: idx.height }); // same height: no flush (any fresh deposit is merged)
  await mine([]);
  fake.failNext = new Error("socket hang up");
  await R2.onTick({ chainTip: idx.height });
  const journaled = R2.state.items[id];
  assert.equal(journaled.status, "signing");
  assert.match(journaled.raw, /^[0-9a-f]+$/);
  assert.equal(R2.status(id).status, "queued", "signing is reported as queued");
  const charged = R2.books.account(payer.idHex).balance;

  // Crash and restart: the same raw bytes go out, never a re-signed carrier, and it is charged once.
  const calls = fake.calls.length;
  const R3 = await newRelayer(); // startPaidRelayer runs recover()
  assert.deepEqual(fake.calls.slice(calls), [journaled.raw]);
  assert.equal(R3.status(id).status, "broadcast");
  assert.equal(R3.ledgerView().items[0].txid, journaled.txid);
  assert.equal(R3.books.account(payer.idHex).balance, charged);
  R2.close();
  R = R3;

  await mineBroadcasts();
  await tick();
  assert.equal(R.status(id).status, "accepted");
  assert.equal(R.checkBooks().ok, true);
});

test("fast mode goes out at once, under the shared lock", async () => {
  // Fresh notes for Alice: one more mint.
  const bind = randomBytes(36);
  await mine([ownCarrier(await alice.mint(idx, { asset: ASSET, mintAmount: 100n, bindOutpoint: bind }), bind)]);
  await tick();
  const note = alice.scan(idx).notes.filter((n) => !n.spent).sort((a, b) => b.leafIndex - a.leafIndex)[0];
  const F = await newRelayer({}, { dir: mkdtempSync(join(DIR, "fast-")), fastDelayMs: () => 0 });
  await F.onTick({ chainTip: idx.height });
  const who = newAccount();
  await fundAccount({ relayer: F, esplora: fake, account: who, sats: 7000 });
  const env = await transferFrom(note);
  const out = await submit(env, { r: F, mode: "fast", account: who });
  assert.equal(out.status, 202);
  assert.equal(out.body.flush, "fast");
  for (let i = 0; i < 100 && F.status(out.body.id).status === "queued"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(F.status(out.body.id).status, "broadcast");
  assert.ok(carrierOf(env), "carried without waiting for a block");
  await mineBroadcasts();
});

test("fan-out: too few confirmed coins split the largest into 24 x 25,000 sats, paid from the margin, listed in the ledger", async () => {
  const esplora = new FakeEsplora();
  const F = await newRelayer({ fanoutTarget: 24, fanoutValue: 25_000 }, { esplora, dir: mkdtempSync(join(DIR, "fanout-")) });
  const who = newAccount();
  for (const sats of [1_000_000, 4000, 2000, 2000, 2000]) await fundAccount({ relayer: F, esplora, account: who, sats });
  // Deposits are never split or carried directly: one merge takes them all to C first.
  const margin0 = F.books.toJSON().margin;
  await F.onTick({ chainTip: idx.height });
  assert.equal(esplora.accepted.length, 1);
  const merge = btc.Transaction.fromRaw(unhex(esplora.accepted[0]));
  assert.deepEqual([merge.inputsLength, merge.outputsLength], [5, 1]);
  assert.equal(addressOf(merge.getOutput(0).script), F.address);
  const [m] = F.ledgerView().items;
  assert.deepEqual([m.kind, m.outcome, m.txid], ["merge", "pending", merge.id]);
  assert.equal(F.books.toJSON().margin, margin0 - m.fee, "the margin account paid the merge");
  esplora.confirm([merge.id], idx.height + 1);
  F.books.penalize(who.idHex, 1000); // the merge used most of the five sweep costs; margins refill it in real use

  const margin = F.books.toJSON().margin;
  await F.onTick({ chainTip: idx.height });
  assert.equal(esplora.accepted.length, 2);
  const tx = btc.Transaction.fromRaw(unhex(esplora.accepted[1]));
  assert.equal(tx.inputsLength, 1);
  assert.equal(`${hex(tx.getInput(0).txid)}:${tx.getInput(0).index}`, `${merge.id}:0`, "the fan-out splits the merged coin, never a deposit");
  assert.equal(tx.outputsLength, 25);
  // L5: the fan-out's change takes a random slot among its outputs.
  const amounts = Array.from({ length: 25 }, (_, v) => tx.getOutput(v).amount);
  assert.equal(amounts.filter((a) => a === 25_000n).length, 24, "24 coins of 25,000 sats, plus the change");
  assert.ok(amounts.some((a) => a !== 25_000n), "the change is one of the outputs");
  for (let v = 0; v < 25; v++) assert.equal(addressOf(tx.getOutput(v).script), F.address, "every output pays C");
  for (let i = 0; i < tx.inputsLength; i++) assert.equal(tx.getInput(i).sequence, 0xfffffffd, "L5: RBF on every input");
  const [entry] = F.ledgerView().items;
  assert.deepEqual([entry.kind, entry.outcome, entry.txid], ["fanout", "pending", tx.id]);
  assert.equal(F.ledgerView().totals.fanoutSats, entry.fee + m.fee);
  assert.equal(F.ledgerView().totals.carriers, 0);
  assert.equal(F.books.toJSON().margin, margin - entry.fee, "the margin account paid it");
  assert.equal(F.books.account(who.idHex).balance, 1_000_000 + 4000 + 6000 - 5 * 288 - 1000, "no balance paid for it");

  await F.onTick({ chainTip: idx.height });
  assert.equal(esplora.accepted.length, 2, "no second fan-out while one is pending");
  esplora.confirm([tx.id], idx.height + 1);
  await F.onTick({ chainTip: idx.height });
  assert.equal(F.ledgerView().items[0].outcome, "accepted");
  assert.equal(esplora.accepted.length, 2, "enough confirmed coins now");
  assert.equal(F.checkBooks().ok, true);

  // Coin choice: a change coin of C that covers the fee, chosen at random among the confirmed ones
  // (never a deposit), else our own shallow change.
  const coin = (value, extra = {}) => ({ key: `${hash32()}:0`, value, confirmed: true, kind: "change", ...extra });
  const coins = [coin(900), coin(30_000), coin(5000), coin(50_000, { kind: "deposit" })];
  const picked = new Set();
  for (let i = 0; i < 200; i++) picked.add(F.pickCoin(coins, 928).value);
  assert.deepEqual([...picked].sort((a, b) => a - b), [5000, 30_000], "random among the change coins that fit; never the deposit");
  assert.equal(F.pickCoin([coins[3]], 928), null, "a deposit never funds a carrier");
  const change = coin(2000, { confirmed: false, depth: 3 });
  assert.equal(F.pickCoin([change, coins[0]], 928), change);
  change.depth = 21;
  assert.equal(F.pickCoin([change], 928), null, "too deep a chain of unconfirmed carriers");
  assert.equal(F.pickCoin([coin(2000, { confirmed: false })], 928), null, "an unconfirmed coin of unknown depth is never used");
});

test("ledger and status views carry no relay ids or accounts; responses and relayer.json never contain the client IP", () => {
  const ledgerText = JSON.stringify(R.ledgerView({ limit: 500 }));
  for (const id of Object.keys(R.state.items)) assert.ok(!ledgerText.includes(id));
  assert.ok(!ledgerText.includes(payer.idHex));
  assert.ok(R.ledgerView({ limit: 2 }).items.length <= 2);
  const newest = R.ledgerView().items[0].seq;
  assert.ok(R.ledgerView({ before: newest }).items.every((l) => l.seq < newest));

  const file = readFileSync(STATE_PATH, "utf8");
  for (const ip of [TEST_IP, "198.51.100.5", "192.0.2.9", "198.51.100.6"]) {
    const prefix = ip.split(".").slice(0, 3).join(".");
    assert.ok(!file.includes(prefix), `relayer.json mentions ${prefix}`);
    assert.ok(responses.every((r) => !r.includes(prefix)), `a response mentions ${prefix}`);
  }
  assert.ok(responses.length > 30);
  assert.equal(R.status("nope"), null);
  assert.equal(R.status("0".repeat(32)), null);
});

test("planCarrierTx: every input signals RBF (0xfffffffd, one L5 policy) and any other sequence is refused; so do all of the relayer's own transactions", () => {
  const account = btcAccount(new Uint8Array(randomBytes(32)));
  const utxo = { txid: hash32(), vout: 0, value: 10_000 };
  const plain = planCarrierTx({ account, utxos: [utxo], envelope: randomBytes(471), feeRate: 1 });
  assert.equal(plain.tx.getInput(0).sequence, 0xfffffffd, "the default is RBF");
  const asked = planCarrierTx({ account, utxos: [utxo], envelope: randomBytes(471), feeRate: 1, sequence: 0xfffffffd });
  assert.equal(asked.tx.getInput(0).sequence, 0xfffffffd);
  assert.equal(Number(asked.fee), PER, "1-in / OP_RETURN / change: 597.5 vB estimated, rounded up");
  assert.throws(() => planCarrierTx({ account, utxos: [utxo], envelope: randomBytes(471), feeRate: 1, sequence: 0xffffffff }), /one policy/);
  assert.ok(fake.accepted.length > 0);
  for (const raw of fake.accepted) {
    const tx = btc.Transaction.fromRaw(unhex(raw), { allowUnknownOutputs: true });
    for (let i = 0; i < tx.inputsLength; i++) assert.equal(tx.getInput(i).sequence, 0xfffffffd);
  }
});

test("MURKLE_RELAYER only records the request; relayerStartup refuses it without MURKLE_RELAY_MODE=balance", () => {
  assert.equal(configFromEnv(() => undefined).enabled, false, "off by default");
  assert.equal(configFromEnv((n) => (n === "RELAYER" ? "1" : undefined)).enabled, true, "the request is recorded");
  assert.equal(configFromEnv((n) => (n === "RELAYER" ? "0" : undefined)).enabled, false);
  assert.equal(relayerStartup((n) => (n === "RELAYER" ? "1" : undefined)).start, false, "no relayer starts without relay balances");
  assert.equal(relayerStartup((n) => ({ RELAYER: "1", RELAY_MODE: "balance" })[n]).start, true);
});

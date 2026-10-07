// Fee payers and the relay client (relay balances, docs/design/relay-balance.md):
// - Unisat funds and broadcasts the carrier itself via sendBitcoin (mock extension);
// - RelayPayer carries TRANSACT only, signs each submit with the wallet's relay account
//   (no proof of work), and never relays mints or launches;
// - wallet invariant W-1 (lockedNullifiers) and leak-free history status (deriveStatus);
// - the "Audit the relayer" classifier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptOf } from "../src/btc/funding.mjs";
import { OP, encodeTxBody, encodeDeploy, opReturnScript } from "../src/envelope.mjs";
import { hex, unhex } from "../src/bytes.mjs";
import { relayAccount, verifyRequest } from "../src/relay-account.mjs";
import { schnorr } from "@noble/curves/secp256k1";
import { MockUnisat } from "./mock-unisat.mjs";
import { relayInfoOff } from "../server/retired-relay.mjs";

const { UnisatPayer, RelayPayer } = await import("../web/src/payers.js");
const { submitEnvelope, relayFailure, auditRelayer } = await import("../web/src/relay.js");
const { lockedNullifiers, deriveStatus, ANCHOR_WINDOW, parseUnits, formatUnits, phraseCheck, newPhrase, addressWords } = await import("../web/src/session.js");

const envelope = new TextEncoder().encode("murkle-payer-test");
// A neutral signet P2TR address: the key-path address of the dummy key new Uint8Array(32).fill(1).
const TREASURY = "tb1p33wm0auhr9kkahzd6l0kqj85af4cswn276hsxg6zpz85xe2r0y8snwrkwy";
const POOL = Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(9))).toString("hex");
const ACCOUNT = relayAccount(new Uint8Array(32).fill(3), "signet");
/** Relay info of a relayer with relay balances (relay-balance-contract.md §4.2). */
const balanceInfo = (over = {}) => ({
  enabled: true, mode: "balance", code: null, reason: null, network: "signet", address: "tb1prelayer",
  fees: { feeRate: 1, maxFeeRate: 5, carrierFeeSats: 597 },
  balance: { poolKey: POOL, perSendSats: 657, batchHeadroom: 2, minDepositSats: 2000, depositConfirmations: 1 }, ...over,
});

/** A structurally valid 471-byte TRANSACT envelope (the proof bytes are not checked client-side). */
function transact({ anchor = 100, publicAmount = 0n } = {}) {
  const body = encodeTxBody({
    op: OP.TRANSACT, anchor, publicAmount, nullifiers: [11n, 12n], commitments: [21n, 22n],
    ciphertexts: [new Uint8Array(95).fill(1), new Uint8Array(95).fill(2)],
  });
  const env = new Uint8Array(body.length + 128);
  env.set(body);
  return env;
}

async function connected(opts) {
  globalThis.window = { unisat: new MockUnisat(opts) };
  return new UnisatPayer().connect();
}

/* ---------- Unisat ---------- */

test("connect switches Unisat to signet and records the payer script", async () => {
  const payer = await connected({ type: "p2wpkh" });
  assert.equal(window.unisat.chain, "BITCOIN_SIGNET");
  assert.equal(payer.address, window.unisat.address);
  assert.deepEqual(payer.account.script, scriptOf(window.unisat.address));
});

test("a paid mint goes to the treasury with the envelope as a hex memo", async () => {
  const payer = await connected();
  await payer.carry({ envelope, outputs: [{ script: scriptOf(TREASURY), amount: 1000n }], feeRate: 3 });
  assert.deepEqual(window.unisat.sent, [{ to: TREASURY, satoshis: 1000, feeRate: 3, memo: hex(envelope) }]);
});

test("an envelope without a payment sends the minimum to the payer itself", async () => {
  const payer = await connected();
  await payer.carry({ envelope, feeRate: 1 });
  assert.equal(window.unisat.sent[0].to, payer.address);
  assert.equal(window.unisat.sent[0].satoshis, 546);
});

test("Unisat errors are plain English", async () => {
  const payer = await connected();
  const out = { script: scriptOf(TREASURY), amount: 1000n };
  await assert.rejects(payer.carry({ envelope, outputs: [out, out], feeRate: 1 }), /Unisat can pay only one output per transaction\./);
  window.unisat.sendBitcoin = async () => {
    throw new Error("bad-txns: scriptpubkey");
  };
  await assert.rejects(payer.carry({ envelope, feeRate: 1 }), /rejected the large OP_RETURN \(old relay policy\)/);
  globalThis.window = {};
  await assert.rejects(new UnisatPayer().connect(), /Unisat extension not found in this browser\./);
  globalThis.window = { unisat: {} };
  await assert.rejects(new UnisatPayer().connect(), /Update Unisat to 1\.4 or later/);
});

/* ---------- relay client ---------- */

function fakeRelay({ failures = [], info = balanceInfo() } = {}) {
  const calls = { info: 0, submits: [] };
  return {
    calls,
    async info() {
      calls.info++;
      return typeof info === "function" ? info() : info;
    },
    async submit(body) {
      calls.submits.push(body);
      const f = failures.shift();
      if (f) throw Object.assign(new Error(f.message ?? f.code), f);
      return { id: "ab".repeat(16), status: "queued", anchor: 100, deadline: 200, flush: "next-block", reservedSats: 657, balance: 6055 };
    },
  };
}

test("RelayPayer signs the submit with the relay account (no proof of work) and returns the relay id", async () => {
  const client = fakeRelay();
  const steps = [];
  const env = transact();
  const r = await new RelayPayer({ client, account: ACCOUNT }).carry({ envelope: env, onStep: (s) => steps.push(`${s.id}:${s.status}`) });
  assert.equal(r.relayId, "ab".repeat(16));
  assert.equal(r.txid, null, "the txid comes later, from the relayer's status");
  assert.deepEqual([r.reservedSats, r.balance], [657, 6055]);
  const [body] = client.calls.submits;
  assert.deepEqual(Object.keys(body).sort(), ["accountPub", "envelope", "mode", "sig", "t"]);
  assert.equal(body.envelope, hex(env));
  assert.equal(body.mode, "block");
  assert.equal(body.accountPub, ACCOUNT.pubHex);
  assert.equal(verifyRequest({ endpoint: "/api/relay/submit", network: "signet", poolKey: POOL, body }).ok, true);
  assert.deepEqual(steps.filter((s) => s.endsWith(":ok")), ["submit:ok"]);
});

test("a refusal is not retried; nothing is sent without an account", async () => {
  const env = transact();
  const c3 = fakeRelay({ failures: [{ code: "nullifier_pending", status: 409, message: "These notes are already in the relay queue." }] });
  await assert.rejects(submitEnvelope(env, { client: c3, account: ACCOUNT }), (e) => e.code === "nullifier_pending");
  assert.equal(c3.calls.submits.length, 1, "other errors are not retried");
  const c4 = fakeRelay({ failures: [{ code: "balance_low", status: 402, message: "Your relay balance does not cover this send. Top up, or pay the fee yourself.", balance: 10, needed: 657 }] });
  await assert.rejects(submitEnvelope(env, { client: c4, account: ACCOUNT }), (e) => e.code === "balance_low" && e.needed === 657);
  assert.equal(c4.calls.submits.length, 1);
  const c5 = fakeRelay();
  await assert.rejects(submitEnvelope(env, { client: c5 }), /No relay account/);
  assert.equal(c5.calls.submits.length, 0);
});

test("the relayer never gets a mint, a launch or public value", async () => {
  const client = fakeRelay();
  const payer = new RelayPayer({ client, account: ACCOUNT });
  const deploy = encodeDeploy({ ticker: "ABC", divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() });
  await assert.rejects(payer.carry({ envelope: deploy }), /private transfers only/);
  await assert.rejects(payer.carry({ envelope: transact({ publicAmount: 5n }) }), /public value/);
  await assert.rejects(payer.carry({ envelope: new Uint8Array(10) }), /malformed/);
  assert.equal(client.calls.submits.length, 0);
});

test("no relay-balance relayer: the submit fails before anything is signed, with a usable message", async () => {
  const client = fakeRelay({ info: { enabled: false, reason: "disabled" } });
  await assert.rejects(submitEnvelope(transact(), { client, account: ACCOUNT }), (e) => e.code === "disabled" && /Pay the fee yourself/.test(e.message));
  assert.equal(client.calls.submits.length, 0);
  // The stage-0 server's shape (server/retired-relay.mjs relayInfoOff): the machine code apart from the plain reason.
  const off = fakeRelay({ info: relayInfoOff() });
  await assert.rejects(submitEnvelope(transact(), { client: off, account: ACCOUNT }), (e) => e.code === "disabled" && /No relayer runs on this server/.test(e.message) && /Pay the fee yourself/.test(e.message));
  // An enabled relayer that is not in balance mode (the retired free design) is not used either.
  const old = fakeRelay({ info: { enabled: true, reason: null, address: "tb1prelayer", pow: { bits: 4, blocks: ["11".repeat(32)] } } });
  await assert.rejects(submitEnvelope(transact(), { client: old, account: ACCOUNT }), (e) => e.code === "disabled");
  assert.equal(old.calls.submits.length, 0);
  // Above the fee cap Fast and Next block are refused at once; the wallet offers paying yourself.
  const high = fakeRelay({ info: balanceInfo({ code: "fee_high", fees: { feeRate: 9, maxFeeRate: 5 } }) });
  await assert.rejects(submitEnvelope(transact(), { client: high, account: ACCOUNT, mode: "fast" }), (e) => e.code === "fee_high" && e.feeRate === 9 && /Pay the fee yourself/.test(e.message));
  assert.equal(high.calls.submits.length, 0);
  assert.equal(relayFailure({ code: "fee_high", message: "x" }).retryable, true);
  assert.equal(relayFailure({ code: "balance_low", message: "x" }).retryable, false, "a short balance needs a top-up first");
  assert.equal(relayFailure({ code: "proof_invalid", message: "x" }).retryable, false);
  assert.equal(relayFailure({ code: "budget_exhausted" }).retryable, false, "no daily free budget any more");
  assert.equal(relayFailure({ code: "fee_too_high" }).retryable, false, "a retired code");
});

/* ---------- W-1 and leak-free status ---------- */

const send = (over = {}) => ({ id: "x", kind: "send", via: "relay", spends: ["1", "2"], commitments: ["31", "32"], anchor: 500, status: "relaying", ...over });

test("W-1: a handed-out envelope keeps its notes reserved until anchor + 100 or until they are spent", () => {
  const none = new Set();
  for (const status of ["mempool", "relaying", "failed", "dropped"]) {
    assert.deepEqual([...lockedNullifiers([send({ status })], 550, none)], ["1", "2"], `${status} locks`);
  }
  assert.deepEqual([...lockedNullifiers([send({ status: "failed" })], 500 + ANCHOR_WINDOW, none)], ["1", "2"], "still locked at anchor + 100");
  assert.equal(lockedNullifiers([send({ status: "failed" })], 500 + ANCHOR_WINDOW + 1, none).size, 0, "free after the window");
  assert.equal(lockedNullifiers([send({ status: "accepted" })], 550, none).size, 0);
  assert.equal(lockedNullifiers([send({ status: "expired" })], 550, none).size, 0);
  assert.equal(lockedNullifiers([send({ status: "failed" })], 550, new Set(["1", "2"])).size, 0, "spent notes need no lock");
  assert.equal(lockedNullifiers([send({ era: "legacy", status: "mempool" })], 550, none).size, 0, "pre-reset entries never lock");
  // The double-pay case from relayer.md §2: a dropped self-paid send must not free its notes early.
  assert.deepEqual([...lockedNullifiers([send({ via: "self", status: "dropped" })], 501, none)], ["1", "2"]);
});

test("history status comes from bulk data only", () => {
  const base = { height: 520, nullifiers: new Set(), outputs: new Map(), log: new Map(), assets: [] };
  // Accepted: an own output commitment is in the pool (txid and height from /api/outputs).
  assert.deepEqual(deriveStatus(send(), { ...base, outputs: new Map([["32", { txid: "aa", height: 510 }]]) }), { status: "accepted", txid: "aa", height: 510, reason: null });
  // Accepted: every spend is published, whoever carried it.
  assert.equal(deriveStatus(send(), { ...base, nullifiers: new Set(["1", "2"]) }).status, "accepted");
  // Rejected: the bulk log has a failed verdict for a known txid.
  assert.deepEqual(deriveStatus(send({ via: "self", txid: "bb" }), { ...base, log: new Map([["bb", { ok: false, reason: "nullifier already spent", height: 511 }]]) }), { status: "rejected", reason: "nullifier already spent", height: 511 });
  // Expired after the anchor window.
  assert.equal(deriveStatus(send({ via: "self", txid: "cc", status: "mempool" }), { ...base, height: 601 }).status, "expired");
  assert.equal(deriveStatus(send({ via: "self", txid: "cc", status: "mempool" }), { ...base, height: 600 }).status, "mempool");
  // Relay statuses, only for envelopes the relayer already holds.
  assert.deepEqual(deriveStatus(send(), { ...base, relay: { status: "queued" } }), { status: "relaying", relayStatus: "queued" });
  assert.equal(deriveStatus(send(), { ...base, relay: { status: "broadcast", txid: "dd" } }).txid, "dd");
  assert.equal(deriveStatus(send(), { ...base, relay: { status: "dropped", reason: "notes already spent" } }).status, "failed");
  assert.equal(deriveStatus(send(), { ...base, relay: { status: "expired" } }).status, "failed");
  // Launches: the ticker's deployTxid decides; otherwise the log; otherwise pending.
  const dep = { kind: "deploy", ticker: "ABC", txid: "ee", sentHeight: 500 };
  assert.equal(deriveStatus(dep, { ...base, assets: [{ ticker: "ABC", deployTxid: "ee", deployHeight: 505 }] }).status, "accepted");
  assert.equal(deriveStatus(dep, { ...base, assets: [{ ticker: "ABC", deployTxid: "ff" }], log: new Map([["ee", { ok: false, reason: "ticker taken" }]]) }).status, "rejected");
  assert.equal(deriveStatus(dep, base).status, "mempool");
  assert.equal(deriveStatus(dep, { ...base, height: 700 }).status, "dropped");
  assert.equal(deriveStatus({ ...send(), era: "legacy" }, base).status, "legacy");
});

/* ---------- helpers ---------- */

test("amounts, phrases and address fingerprints", () => {
  assert.equal(parseUnits("1,250.5", 2), 125050n);
  assert.throws(() => parseUnits("1.234", 2), /Invalid amount: at most 2 decimal places\./);
  assert.equal(formatUnits(125050n, 2), "1250.5");
  const p = newPhrase();
  assert.equal(phraseCheck(p).valid, true);
  assert.equal(phraseCheck(p).message, "24 valid words");
  assert.match(phraseCheck("abandon zzz").message, /Not in the word list: zzz/);
  assert.match(phraseCheck(p.split(" ").slice(0, 12).join(" ")).message, /12 of 24 words/);
  // 24 known words with a bad checksum ("abandon" x 23 + "art" is the valid one).
  assert.equal(phraseCheck(`${"abandon ".repeat(23)}art`).valid, true);
  assert.match(phraseCheck("abandon ".repeat(24)).message, /checksum fails/);
  const w = addressWords("mrk1example");
  assert.equal(w.length, 6);
  assert.deepEqual(addressWords("mrk1example"), w, "deterministic");
  assert.notDeepEqual(addressWords("mrk1example2"), w);
});

/* ---------- audit the relayer ---------- */

test("audit the relayer: carriers, fan-outs and merges checked against the ledger; other coins at C flagged", () => {
  const R = "tb1prelayer"; // C, the relayer's change address
  const env = transact();
  const carrier = {
    txid: "c1", fee: 597, status: { confirmed: true },
    vin: [{ prevout: { scriptpubkey_address: "tb1pdeposit" } }],
    vout: [{ scriptpubkey_type: "op_return", scriptpubkey: hex(opReturnScript(env)), value: 0 }, { scriptpubkey_address: R, value: 1000 }],
  };
  const fanout = { txid: "f1", fee: 900, vin: [{ prevout: { scriptpubkey_address: R } }], vout: [{ scriptpubkey_address: R }, { scriptpubkey_address: R }] };
  const merge = { txid: "m1", fee: 400, vin: [{ prevout: { scriptpubkey_address: R } }, { prevout: { scriptpubkey_address: R } }], vout: [{ scriptpubkey_address: R }] };
  const dust = { txid: "t1", fee: 200, vin: [{ prevout: { scriptpubkey_address: "tb1qfaucet" } }], vout: [{ scriptpubkey_address: R }, { scriptpubkey_address: "tb1qfaucet" }] };
  const leak = { txid: "x1", fee: 300, vin: [{ prevout: { scriptpubkey_address: R } }], vout: [{ scriptpubkey_address: "tb1qelse" }] };
  const ledger = [{ txid: "c1", kind: "carrier", fee: 597 }, { txid: "f1", kind: "fanout", fee: 900 }, { txid: "m1", kind: "merge", fee: 400 }];
  const ok = auditRelayer({ address: R, txs: [carrier, fanout, merge, dust], ledger });
  assert.deepEqual(ok.rows.map((r) => r.kind), ["carrier", "fanout", "merge", "other"]);
  assert.equal(ok.matched, 3);
  assert.equal(ok.total, 3, "coins others sent to C are not the relayer's doing");
  assert.equal(ok.foreign, 1);
  assert.equal(ok.topUps, undefined, "the top-up kind is gone");
  assert.equal(ok.rows[3].note, "Not made by the relayer; it never spends such coins.");
  const bad = auditRelayer({ address: R, txs: [{ ...carrier, fee: 700 }, leak], ledger });
  assert.equal(bad.matched, 0);
  assert.equal(bad.total, 2);
  assert.match(bad.rows[0].note, /700 sats on Bitcoin but 597/);
  assert.match(bad.rows[1].note, /somewhere other than the relayer/);
  // A carrier's change must go to C: change to anywhere else is "other".
  const elsewhere = { ...carrier, txid: "c3", vout: [carrier.vout[0], { scriptpubkey_address: "tb1pdeposit", value: 1000 }] };
  assert.equal(auditRelayer({ address: R, txs: [elsewhere], ledger: [{ txid: "c3", fee: 597 }] }).rows[0].kind, "other");
  const deploy = encodeDeploy({ ticker: "ABC", divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() });
  const notTransact = { ...carrier, txid: "c2", vout: [{ ...carrier.vout[0], scriptpubkey: hex(opReturnScript(deploy)) }, carrier.vout[1]] };
  assert.match(auditRelayer({ address: R, txs: [notTransact], ledger: [{ txid: "c2", fee: 597 }] }).rows[0].note, /not a single private-transfer envelope/);
});

test("pay links and launch terms are checked locally", async () => {
  const { payLink } = await import("../web/src/views/app-receive.js");
  const { parseRequest } = await import("../web/src/views/pay.js");
  const { buildTerms } = await import("../web/src/views/app-launch.js");
  const { Session } = await import("../web/src/session.js");
  const me = new Session({ phrase: newPhrase() }).address;
  const link = payLink({ to: me, ticker: "ABC", amount: "2.5", origin: "https://murkle.test" });
  assert.ok(link.startsWith("https://murkle.test/pay#to="), "request data lives in the fragment only");
  const assets = [{ ticker: "ABC", id: "7", divisibility: 2 }];
  const r = parseRequest(new URL(link).hash, assets);
  assert.deepEqual([r.to, r.ticker, r.amount, r.errors], [me, "ABC", 250n, []]);
  assert.match(parseRequest("#to=mrk1broken&t=ABC", assets).errors[0], /isn't a valid Murkle address/);
  assert.match(parseRequest(`#to=${me}&t=NOPE`, assets).errors[0], /No token NOPE/);

  const good = buildTerms({ ticker: "abc", decimals: "2", perMint: "10.5", mints: "100", price: "1000", treasury: TREASURY, start: "0", end: "0" }, { height: 10 });
  assert.deepEqual(good.errors, {});
  assert.equal(good.terms.ticker, "ABC");
  assert.equal(good.supply, 105000n);
  assert.equal(good.envelope[4], OP.DEPLOY);
  const taken = buildTerms({ ticker: "ABC", decimals: "0", perMint: "1", mints: "1", price: "1000", treasury: "" }, { taken: new Set(["ABC"]) });
  assert.match(taken.errors.ticker, /already taken/);
  assert.match(taken.errors.treasury, /paid mint needs a treasury/);
  assert.equal(taken.envelope, null);
});

/* ---------- a full wallet session over HTTP, leak-free ---------- */

test("wallet session: sync, relay send, settle; no request names one of its txids or nullifiers", async (t) => {
  const { readFileSync } = await import("node:fs");
  const { randomBytes } = await import("node:crypto");
  const { Indexer, assetIdOf } = await import("../src/indexer.mjs");
  const { Wallet } = await import("../src/wallet.mjs");
  const { deriveKeys, encodeAddress } = await import("../src/keys.mjs");
  const { parseRawTx } = await import("../src/btc/block.mjs");
  const { createApp } = await import("../server/indexer-server.mjs");
  const { RELAY_ROUTE } = await import("../web/src/relay.js");
  const api = await import("../web/src/api.js");
  const { Session } = await import("../web/src/session.js");
  const { getRootStatus } = await import("../web/src/ui/status.js");

  const START = 900000;
  const h32 = () => randomBytes(32).toString("hex");
  const idx = new Indexer({ vkey: JSON.parse(readFileSync("build/dev/verification_key.json", "utf8")), startHeight: START, genesis: null });
  const mine = (txs = []) => idx.applyBlock({ height: idx.height + 1, hash: h32(), txs: [{ txid: h32(), inputs: [], outputs: [] }, ...txs] });
  const carrierOf = (payload, first = randomBytes(36)) => ({ txid: h32(), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(payload), value: 0n }] });

  const s = new Session({ phrase: newPhrase() });
  const bob = new Wallet(deriveKeys(randomBytes(32)));
  const minter = new Wallet(s.keys); // mints for the session's keys out of band (no BTC needed in the test)
  await mine([carrierOf(encodeDeploy({ ticker: "WAL", divisibility: 0, mintAmount: 500n, mintCap: 10, priceSats: 0n, treasury: new Uint8Array() }))]);
  const ASSET = assetIdOf(START, 1);
  const bind = randomBytes(36);
  await mine([carrierOf(await minter.mint(idx, { asset: ASSET, mintAmount: 500n, bindOutpoint: bind }), bind)]);
  await mine([]);

  // A relayer with relay balances, faked in process (the paid relayer itself is tested in
  // test/relay-balance-relayer.test.mjs): it checks the signed submit and carries the envelope.
  const relay = {
    submits: [],
    info: async () => balanceInfo(),
    async submit(body) {
      assert.equal(verifyRequest({ endpoint: "/api/relay/submit", network: "signet", poolKey: POOL, body }).ok, true, "a signed submit");
      relay.submits.push(body);
      return { id: "cd".repeat(16), status: "queued", anchor: 0, deadline: 0, flush: "next-block", reservedSats: 657, balance: 6000 };
    },
  };
  s.relayPayer = new RelayPayer({ client: relay });
  RELAY_ROUTE.open = true;
  const app = createApp({ idx, log: { warn() {}, error() {}, log() {} } });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const realFetch = globalThis.fetch;
  const urls = [];
  globalThis.fetch = (url, init) => (urls.push(String(url)), realFetch(url, init));
  t.after(async () => {
    globalThis.fetch = realFetch;
    api.setIndexerBase("");
    RELAY_ROUTE.open = false;
    await new Promise((r) => app.server.close(r));
    if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
  });
  api.setIndexerBase(`http://127.0.0.1:${app.server.address().port}`);

  await s.sync();
  assert.equal(getRootStatus().state, "match", "the browser rebuilt the tree and matched the root");
  assert.equal(s.wallet.balance(ASSET), 500n);
  const asset = s.asset("WAL");
  assert.equal(asset.id, ASSET.toString());

  const steps = [];
  const entry = await s.send({ asset, amount: 120n, to: encodeAddress(bob.address), via: "relay", onStep: (e) => steps.push(`${e.id}:${e.status}`) });
  for (const id of ["keys", "sync", "select", "prove", "verify", "submit", "queued"]) assert.ok(steps.includes(`${id}:ok`), `${id} step completed`);
  assert.ok(!steps.some((x) => x.startsWith("pow:")), "no proof of work");
  assert.equal(relay.submits.length, 1);
  assert.equal(relay.submits[0].envelope, entry.envelope);
  assert.equal(relay.submits[0].accountPub, s.relayAccount.pubHex, "signed by this wallet's relay account");
  assert.equal(entry.status, "relaying");
  assert.ok(entry.relayId && entry.envelope && [1, 2].includes(entry.spends.length));
  assert.deepEqual([...s.wallet.locked], entry.spends.map(String), "W-1: the handed-out notes are reserved");
  assert.equal(s.available(ASSET), 0n);

  // The relayer carries it in the next block; the wallet learns the outcome from bulk data.
  await mine([]);
  const carrier = carrierOf(unhex(entry.envelope));
  await mine([carrier]);
  app.publish();
  await s.sync();
  assert.equal(entry.status, "accepted");
  assert.equal(entry.txid, carrier.txid, "the txid came from /api/outputs, not a per-tx lookup");
  assert.equal(entry.envelope, undefined, "the envelope is dropped once settled");
  assert.equal(s.wallet.balance(ASSET), 380n);
  assert.equal(s.wallet.locked.size, 0);
  bob.scan(idx);
  assert.equal(bob.balance(ASSET), 120n);

  // Leak-free: nothing the wallet fetched names its txids, nullifiers or commitments.
  const secrets = [carrier.txid, ...entry.spends.map(String), ...entry.commitments.map(String)];
  for (const u of urls) {
    for (const x of secrets) assert.ok(!u.includes(x), `request ${u} leaks ${x}`);
    assert.ok(!/[?&](txid|nullifier)=/.test(u), `no per-item query: ${u}`);
  }
  assert.ok(!urls.some((u) => u.includes("mempool.space")), "a relayed send never touches mempool.space");

  // Copy envelope (paid-relay.md §12, the route that stays while relaying is unavailable): proved and
  // recorded here, handed to nobody; the notes stay reserved (W-1) until someone carries it.
  const seen = urls.length;
  const copySteps = [];
  const copied = await s.send({ asset, amount: 80n, to: encodeAddress(bob.address), via: "copy", onStep: (e) => copySteps.push(`${e.id}:${e.status}`) });
  for (const id of ["select", "prove", "verify", "ready"]) assert.ok(copySteps.includes(`${id}:ok`), `${id} step completed`);
  assert.ok(!copySteps.some((x) => /^(pow|submit|sign|broadcast):/.test(x)), "nothing is signed, broadcast or handed to a relayer");
  assert.deepEqual([copied.via, copied.status, copied.payerAddress, copied.relayId ?? null], ["copy", "copied", null, null]);
  assert.deepEqual([...s.wallet.locked].sort(), copied.spends.map(String).sort(), "W-1: the copied notes are reserved");
  assert.ok(!urls.slice(seen).some((u) => u.includes("/api/relay/") || u.includes("mempool.space")), "the envelope left nowhere");
  assert.equal(relay.submits.length, 1, "nothing more was handed to the relayer");
  // Anyone carries the copied envelope; the wallet sees it land from bulk data.
  await mine([carrierOf(unhex(copied.envelope))]);
  app.publish();
  await s.sync();
  assert.equal(copied.status, "accepted");
  assert.equal(s.wallet.balance(ASSET), 300n);
  assert.equal(s.wallet.locked.size, 0);
});

test("planning a carrier from an empty wallet fails with a clear message, not an unsigned transaction", async () => {
  const { planCarrierTx, btcAccount } = await import("../src/btc/funding.mjs");
  const account = btcAccount(new Uint8Array(32).fill(7));
  assert.throws(
    () => planCarrierTx({ account, utxos: [], envelope: new TextEncoder().encode("mrk-test"), feeRate: 1 }),
    /not enough BTC at .*: have 0 sats, need [1-9]/,
  );
});

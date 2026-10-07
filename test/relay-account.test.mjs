// Relay balance accounts (src/relay-account.mjs) and the carrier/payment
// planner changes (src/btc/funding.mjs): contract docs/design/relay-balance-contract.md
// §1, §1b and §8 "shared". Pure: no network, no files, nothing broadcast.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import {
  DEPOSIT_CONFIRMATIONS, DEPOSIT_TAG, MAX_DEPOSIT_INDEX, MAX_SKEW_SEC, RELAY_ENDPOINTS, RELAY_NETWORKS, RELAY_SIGN_TAG,
  RelayAccountError, accountIdOf, accountLabel, btcNetwork, canonicalBody, depositAddress, depositKey, depositSecret,
  depositTweak, parseAccountPub, parseOutpoint, parsePoolKey, relayAccount, requestDigest, signRequest, verifyRequest,
} from "../src/relay-account.mjs";
import {
  addressOf, btcAccount, dustLimit, feeOf, planCarrierTx, planPayment, scriptOf, signInputs,
} from "../src/btc/funding.mjs";
import { NETWORK } from "../src/params.mjs";

const h = (s) => sha256(utf8ToBytes(s));
const N = secp256k1.CURVE.n;
const big = (b) => BigInt("0x" + bytesToHex(b));
const SEED = h("murkle/test/relay-account/seed");
const POOL_SECRET = h("murkle/test/relay-account/pool"); // lift_x(Q) is this secret's point negated (odd y)
const POOL = schnorr.getPublicKey(POOL_SECRET);
const yParity = (secret) => schnorr.Point.BASE.multiply(big(secret)).toAffine().y % 2n;
/** Pool secrets whose point has even and odd y. */
function poolSecrets() {
  const out = {};
  for (let i = 0; !(out.even && out.odd); i++) {
    const s = h(`murkle/test/relay-account/pool/${i}`);
    out[yParity(s) === 0n ? "even" : "odd"] ??= s;
  }
  return out;
}
const code = (c) => (e) => e instanceof RelayAccountError && e.code === c;
const ENVELOPE_HEX = "ab".repeat(471);

// ---------------------------------------------------------------------------
// 1. Account derivation
// ---------------------------------------------------------------------------

test("constants: tags, labels, networks, confirmations, endpoints", () => {
  assert.equal(RELAY_SIGN_TAG, "murkle/relay/v1");
  assert.equal(DEPOSIT_TAG, "murkle/relay-deposit/v1");
  assert.equal(accountLabel("signet"), "murkle/relay-account/v1/signet");
  assert.deepEqual([...RELAY_NETWORKS], ["signet", "testnet", "mainnet"]);
  assert.deepEqual({ ...DEPOSIT_CONFIRMATIONS }, { signet: 1, testnet: 1, mainnet: 3 });
  assert.equal(MAX_DEPOSIT_INDEX, 2 ** 31 - 1);
  assert.equal(MAX_SKEW_SEC, 600);
  assert.deepEqual({ ...RELAY_ENDPOINTS }, { account: "/api/relay/account", submit: "/api/relay/submit" });
  assert.equal(NETWORK, "signet");
  assert.equal(btcNetwork("signet"), btc.TEST_NETWORK);
  assert.equal(btcNetwork("testnet"), btc.TEST_NETWORK);
  assert.equal(btcNetwork("mainnet"), btc.NETWORK);
  for (const bad of ["regtest", "Signet", "", undefined]) assert.throws(() => btcNetwork(bad), code("bad_network"));
});

test("relayAccount: deterministic per seed, per network, from the labelled HKDF; id = sha256(pub)", () => {
  const a = relayAccount(SEED, "signet");
  const b = relayAccount(Uint8Array.from(SEED), "signet");
  assert.deepEqual(a, b, "same seed, same account");
  assert.deepEqual(relayAccount(SEED), a, "the default network is signet");
  assert.equal(a.network, "signet");
  assert.deepEqual(a.secret, hkdf(sha256, SEED, undefined, "murkle/relay-account/v1/signet", 32));
  assert.deepEqual(a.pub, schnorr.getPublicKey(a.secret));
  assert.equal(a.pubHex, bytesToHex(a.pub));
  assert.deepEqual(a.id, sha256(a.pub));
  assert.equal(a.idHex, bytesToHex(a.id));
  assert.deepEqual(accountIdOf(a.pub), a.id);

  const accounts = RELAY_NETWORKS.map((n) => relayAccount(SEED, n));
  assert.equal(new Set(accounts.map((x) => x.pubHex)).size, 3, "signet, testnet and mainnet accounts differ");
  assert.equal(new Set(accounts.map((x) => x.idHex)).size, 3);
  assert.notEqual(relayAccount(h("another seed")).pubHex, a.pubHex);

  // Pinned vectors: the wallet, the CLI and the relayer must keep deriving these.
  assert.equal(a.pubHex, "9e4e8897720d1e2afa8d057964ad80cf4ad6da08c71123b3394b2148b2d17670");
  assert.equal(a.idHex, "8a8db071881e19be55956e697a933d86c840a66a395c55a4c3ebadfc44caca2f");
  assert.equal(relayAccount(SEED, "mainnet").pubHex, "876fb6c91844322a6609b0ca0c0cc02af5d732d708e632655ad76e28d60da907"); // prepublish-ok: public test vector
});

test("relayAccount: the secret is not the web fee key (murkle/btc-fee) for the same seed", () => {
  const feeKey = hkdf(sha256, SEED, undefined, "murkle/btc-fee", 32);
  const a = relayAccount(SEED, "signet");
  assert.notDeepEqual(a.secret, feeKey);
  assert.notEqual(a.pubHex, bytesToHex(schnorr.getPublicKey(feeKey)));
});

test("relayAccount refuses a seed that is not 32 bytes and an unknown network", () => {
  for (const bad of [new Uint8Array(31), new Uint8Array(33), "00".repeat(32), null, [...SEED]]) {
    assert.throws(() => relayAccount(bad), code("malformed"));
  }
  assert.throws(() => relayAccount(SEED, "regtest"), code("bad_network"));
});

test("parseAccountPub and parsePoolKey accept only 64 lowercase hex of a valid x-only key", () => {
  const a = relayAccount(SEED);
  assert.deepEqual(parseAccountPub(a.pubHex), a.pub);
  assert.deepEqual(parsePoolKey(bytesToHex(POOL)), POOL);
  const copy = parsePoolKey(POOL);
  assert.deepEqual(copy, POOL);
  assert.notEqual(copy, POOL, "a copy, not the caller's array");
  const notOnCurve = "0".repeat(63) + "5"; // x = 5: 5^3 + 7 = 132 is not a square mod p
  const tooBig = "f".repeat(64); // x >= p
  for (const bad of [a.pubHex.toUpperCase(), a.pubHex.slice(2), a.pubHex + "00", ` ${a.pubHex}`, notOnCurve, tooBig, "0".repeat(64), 42, null]) {
    assert.throws(() => parseAccountPub(bad), code("malformed"), String(bad));
    assert.throws(() => parsePoolKey(bad), code("malformed"), String(bad));
  }
  assert.throws(() => parsePoolKey(new Uint8Array(33)), code("malformed"));
  assert.throws(() => accountIdOf(new Uint8Array(31)), code("malformed"));
});

// ---------------------------------------------------------------------------
// 2. Deposit addresses: wallet side and server side agree
// ---------------------------------------------------------------------------

/** The tweak recomputed from scratch with plain sha256 (BIP340 tagged hash). */
function manualTweak(Q, id, n) {
  const tag = sha256(utf8ToBytes("murkle/relay-deposit/v1"));
  const nb = new Uint8Array(4);
  new DataView(nb.buffer).setUint32(0, n, false);
  return big(sha256(concatBytes(tag, tag, Q, id, nb))) % N;
}

test("deposit address n is the same on the wallet side and the server side, for even- and odd-y Q", () => {
  const { even, odd } = poolSecrets();
  assert.equal(yParity(even), 0n);
  assert.equal(yParity(odd), 1n);
  const a = relayAccount(SEED);
  for (const q of [even, odd, POOL_SECRET]) {
    const Q = schnorr.getPublicKey(q);
    for (const n of [0, 1, 2 ** 31 - 1]) {
      assert.equal(depositTweak(Q, a.id, n), manualTweak(Q, a.id, n));
      const wallet = depositAddress(Q, a.id, n);
      assert.equal(wallet.n, n);
      assert.deepEqual(wallet.key, depositKey(Q, a.id, n));
      // The wallet only knows Q (as hex from relay info); the server holds q.
      assert.deepEqual(depositAddress(bytesToHex(Q), a.idHex, n), wallet);
      const d = depositSecret(q, a.id, n);
      assert.equal(bytesToHex(schnorr.getPublicKey(d)), bytesToHex(wallet.key), `server key, n=${n}`);
      const pay = btc.p2tr(schnorr.getPublicKey(d), undefined, btc.TEST_NETWORK);
      assert.equal(pay.address, wallet.address);
      assert.deepEqual(pay.script, wallet.script);
      assert.match(wallet.address, /^tb1p[02-9ac-hj-np-z]{58}$/);
      assert.deepEqual(scriptOf(wallet.address), wallet.script);
    }
  }
});

test("deposit addresses: pinned vectors; different n, id or Q give different addresses; mainnet is bc1p", () => {
  const a = relayAccount(SEED, "signet");
  assert.equal(yParity(POOL_SECRET), 1n);
  assert.equal(bytesToHex(POOL), "535e5348a0e4a15c7af4ffe9b9f888b7b7c4aaf45a952bad23a37917d839e7d9"); // prepublish-ok: public test vector
  assert.equal(depositAddress(POOL, a.id, 0).address, "tb1p7vjxn2ut857g4vvjgx7ysn0247ylcfu6ul4qa230d8taceeqmz2q3ufxk9");
  assert.equal(depositAddress(POOL, a.id, 1).address, "tb1pu4982lhdlpf6mz3vua9px4jh5dm2fammjr3m2zh4lhkgvdmm6egslq0eew");
  assert.equal(depositAddress(POOL, a.id, 2 ** 31 - 1).address, "tb1pyygf3yjr73lv46mr85hn88wqphafzfppd3w6ulaeanmytc0luwlq68nnmn");
  const m = relayAccount(SEED, "mainnet");
  const main = depositAddress(POOL, m.id, 0, "mainnet");
  assert.equal(main.address, "bc1p4p3cdkfs4hx3e5swwaxwxndgrf9rjtuy48hrsxmmlvggud4k0jhsxsptca");
  assert.match(depositAddress(POOL, a.id, 0, "testnet").address, /^tb1p/);

  const seen = new Set();
  const other = relayAccount(h("other seed"));
  const Q2 = schnorr.getPublicKey(h("other pool"));
  for (const Q of [POOL, Q2]) {
    for (const id of [a.id, other.id]) {
      for (const n of [0, 1, 2, 7, 2 ** 31 - 1]) seen.add(depositAddress(Q, id, n).address);
    }
  }
  assert.equal(seen.size, 2 * 2 * 5, "every (Q, id, n) has its own address");
  // The pool's own plain address is not any deposit address.
  assert.ok(!seen.has(btc.p2tr(POOL, undefined, btc.TEST_NETWORK).address));
});

test("deposit index outside 0..2^31-1, a bad id or a bad Q throws", () => {
  const a = relayAccount(SEED);
  for (const n of [-1, 2 ** 31, 1.5, NaN, Infinity, "1", 1n, null, undefined]) {
    assert.throws(() => depositAddress(POOL, a.id, n), code("malformed"), String(n));
    assert.throws(() => depositSecret(POOL_SECRET, a.id, n), code("malformed"), String(n));
  }
  assert.throws(() => depositAddress(POOL, new Uint8Array(31), 0), code("malformed"));
  assert.throws(() => depositAddress(POOL, a.idHex.toUpperCase(), 0), code("malformed"));
  assert.throws(() => depositAddress("00".repeat(32), a.id, 0), code("malformed"));
  assert.throws(() => depositAddress(POOL, a.id, 0, "regtest"), code("bad_network"));
  assert.throws(() => depositSecret(new Uint8Array(32), a.id, 0), code("malformed"), "zero secret");
  assert.throws(() => depositSecret(new Uint8Array(32).fill(255), a.id, 0), code("malformed"), "secret >= N");
});

// ---------------------------------------------------------------------------
// 3. A deposit output spent by the relayer verifies
// ---------------------------------------------------------------------------

/** Checks every key-path witness of a finalized tx against its prevout's output key. */
function verifyKeyPathWitnesses(tx) {
  const scripts = [];
  const amounts = [];
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).witnessUtxo;
    scripts.push(w.script);
    amounts.push(w.amount);
  }
  for (let i = 0; i < tx.inputsLength; i++) {
    const witness = tx.getInput(i).finalScriptWitness;
    assert.equal(witness.length, 1, "key-path spend: one witness element");
    assert.equal(witness[0].length, 64, "default sighash: a 64-byte signature");
    const hash = tx.preimageWitnessV1(i, scripts, btc.SigHash.DEFAULT, amounts);
    const outputKey = scripts[i].subarray(2);
    assert.ok(schnorr.verify(witness[0], hash, outputKey), `input ${i} signature verifies`);
  }
}

test("a deposit coin and a change coin spent in one carrier: per-input keys, change to C, signatures verify", () => {
  const a = relayAccount(SEED);
  const changeSecret = h("murkle/test/relay-account/change");
  const C = btcAccount(changeSecret); // the pool change account
  const dep = depositAddress(POOL, a.id, 3);
  const depCoin = { txid: bytesToHex(h("deposit tx")), vout: 1, value: 7000, script: dep.script, tapInternalKey: dep.key };
  const changeCoin = { txid: bytesToHex(h("change tx")), vout: 2, value: 900 };
  const envelope = Uint8Array.from({ length: 471 }, (_, i) => i & 255);
  const plan = planCarrierTx({
    account: C, utxos: [changeCoin, depCoin], envelope, feeRate: 2, order: "given", changeScript: C.script, sequence: 0xfffffffd,
  });
  assert.equal(plan.inputs.length, 2, "900 sats alone does not cover the carrier");
  assert.deepEqual(plan.inputs.map((i) => `${i.txid}:${i.vout}`), [`${changeCoin.txid}:2`, `${depCoin.txid}:1`], "given order kept");
  assert.deepEqual(plan.inputs[0].script, C.script);
  assert.deepEqual(plan.inputs[0].tapInternalKey, C.pub);
  assert.deepEqual(plan.inputs[1].script, dep.script);
  assert.deepEqual(plan.inputs[1].tapInternalKey, dep.key);
  assert.equal(plan.changeIndex, 1);
  assert.deepEqual(plan.tx.getOutput(1).script, C.script);
  assert.equal(plan.tx.getOutput(1).amount, plan.change);
  assert.equal(BigInt(feeOf(plan.tx)), plan.fee);

  const secrets = [changeSecret, depositSecret(POOL_SECRET, a.id, 3)];
  // A secret on the wrong input does not sign it.
  const swapped = planCarrierTx({ account: C, utxos: [changeCoin, depCoin], envelope, feeRate: 2, order: "given" });
  assert.throws(() => signInputs(swapped.tx, [...secrets].reverse()), /does not sign input/);
  assert.throws(() => signInputs(swapped.tx, [changeSecret]), /one secret per input/);

  const signed = signInputs(plan.tx, secrets);
  assert.match(signed.hex, /^[0-9a-f]+$/);
  assert.match(signed.txid, /^[0-9a-f]{64}$/);
  assert.ok(signed.vsize > 0);
  verifyKeyPathWitnesses(plan.tx);
  // Round trip through raw bytes: the network sees the same transaction.
  const raw = btc.Transaction.fromRaw(plan.tx.toBytes(true, true), { allowUnknownOutputs: true });
  assert.equal(raw.id, signed.txid);
  assert.equal(raw.getInput(0).sequence, 0xfffffffd);
});

test("a deposit spend signed with the plain pool secret, or for another account or index, does not verify", () => {
  const a = relayAccount(SEED);
  const C = btcAccount(h("murkle/test/relay-account/change"));
  const dep = depositAddress(POOL, a.id, 0);
  const coin = { txid: bytesToHex(h("dep")), vout: 0, value: 5000, script: dep.script, tapInternalKey: dep.key };
  const plan = () => planCarrierTx({ account: C, utxos: [coin], envelope: new Uint8Array(10), feeRate: 1, changeScript: C.script });
  for (const wrong of [POOL_SECRET, depositSecret(POOL_SECRET, a.id, 1), depositSecret(POOL_SECRET, relayAccount(h("x")).id, 0)]) {
    assert.throws(() => signInputs(plan().tx, [wrong]), /does not sign input/);
  }
  const ok = plan();
  signInputs(ok.tx, [depositSecret(POOL_SECRET, a.id, 0)]);
  verifyKeyPathWitnesses(ok.tx);
});

// ---------------------------------------------------------------------------
// 4. Strict outpoints
// ---------------------------------------------------------------------------

test("parseOutpoint accepts only the canonical form", () => {
  const txid = bytesToHex(h("some tx"));
  assert.deepEqual(parseOutpoint(`${txid}:0`), { txid, vout: 0, key: `${txid}:0` });
  assert.deepEqual(parseOutpoint(`${txid}:1`), { txid, vout: 1, key: `${txid}:1` });
  assert.deepEqual(parseOutpoint(`${txid}:4294967295`), { txid, vout: 4294967295, key: `${txid}:4294967295` });
  assert.equal(parseOutpoint(`${txid}:1234567890`).vout, 1234567890);
  const refused = [
    `${txid.toUpperCase()}:0`, `${txid.slice(0, 10).toUpperCase()}${txid.slice(10)}:0`,
    `${txid.slice(1)}:0`, `${txid}a:0`, `${txid}:01`, `${txid}:00`, `${txid}:+1`, `${txid}:-1`, `${txid}: 1`,
    `${txid}:1 `, ` ${txid}:1`, `${txid} :1`, `${txid}:1e2`, `${txid}:0x1`, `${txid}:1.0`, `${txid}:4294967296`,
    `${txid}:9999999999`, `${txid}:12345678901`, `${txid}:`, `:0`, txid, `${txid}:1:2`, `${txid}::1`, `${txid}:1\n`,
    `${txid}:１`, "", null, undefined, 5, { txid, vout: 0 },
  ];
  for (const bad of refused) assert.throws(() => parseOutpoint(bad), code("bad_outpoint"), JSON.stringify(bad));
});

// ---------------------------------------------------------------------------
// 5. Canonical bodies and digests
// ---------------------------------------------------------------------------

test("canonicalBody sorts keys, has no whitespace, and refuses sig, floats, negatives, nesting and non-plain objects", () => {
  assert.equal(canonicalBody({ t: 5, mode: "fast", accountPub: "ab" }), '{"accountPub":"ab","mode":"fast","t":5}');
  assert.equal(canonicalBody({ t: 5, linkable: true, a: false }), '{"a":false,"linkable":true,"t":5}', "booleans are JSON true / false (L1 linkable)");
  assert.equal(canonicalBody({}), "{}");
  assert.equal(canonicalBody({ b: "x y", a: 0 }), '{"a":0,"b":"x y"}');
  assert.equal(canonicalBody(Object.assign(Object.create(null), { z: 1, y: "2" })), '{"y":"2","z":1}');
  assert.equal(canonicalBody(JSON.parse('{"__proto__":"p","a":1}')), '{"__proto__":"p","a":1}', "__proto__ stays a plain key");
  const bad = [
    { sig: "00" }, { t: 1.5 }, { t: -1 }, { t: 2 ** 53 }, { t: NaN }, { t: Infinity }, { a: { b: 1 } }, { a: [1] }, { a: null },
    { a: undefined }, { a: 1n }, null, [], "x", new Map(), new Date(0), new (class Fields {})(),
  ];
  for (const b of bad) assert.throws(() => canonicalBody(b), code("malformed"), typeof b === "object" ? Object.prototype.toString.call(b) : String(b));
});

test("requestDigest: the same fields in another order give the same digest; every part changes it", () => {
  const a = relayAccount(SEED);
  const base = { endpoint: RELAY_ENDPOINTS.submit, network: "signet", poolKey: POOL };
  const f1 = { envelope: ENVELOPE_HEX, mode: "batch", accountPub: a.pubHex, t: 1791000000 };
  const f2 = { t: 1791000000, accountPub: a.pubHex, mode: "batch", envelope: ENVELOPE_HEX };
  const d = requestDigest({ ...base, fields: f1 });
  assert.deepEqual(requestDigest({ ...base, fields: f2 }), d);
  assert.deepEqual(requestDigest({ ...base, poolKey: bytesToHex(POOL), fields: f1 }), d);
  assert.equal(bytesToHex(d), "00c50b105191a9356e32f27af6ace9caf9a7a0dd1f7631284c14e9bdac3b3b54", "pinned vector");
  // The digest is exactly taggedHash(tag, lp(endpoint) ‖ lp(network) ‖ Q ‖ sha256(body)).
  const lp = (s) => concatBytes(Uint8Array.of(utf8ToBytes(s).length), utf8ToBytes(s));
  const tag = sha256(utf8ToBytes("murkle/relay/v1"));
  const manual = sha256(concatBytes(tag, tag, lp(base.endpoint), lp("signet"), POOL, sha256(utf8ToBytes(canonicalBody(f1)))));
  assert.deepEqual(d, manual);
  const variants = [
    { ...base, endpoint: RELAY_ENDPOINTS.account, fields: f1 },
    { ...base, network: "testnet", fields: f1 },
    { ...base, poolKey: schnorr.getPublicKey(h("other pool")), fields: f1 },
    { ...base, fields: { ...f1, mode: "fast" } },
    { ...base, fields: { ...f1, t: 1791000001 } },
  ];
  for (const v of variants) assert.notDeepEqual(requestDigest(v), d);
  assert.throws(() => requestDigest({ ...base, network: "regtest", fields: f1 }), code("bad_network"));
  assert.throws(() => requestDigest({ ...base, endpoint: "", fields: f1 }), code("malformed"));
  assert.throws(() => requestDigest({ ...base, endpoint: "x".repeat(256), fields: f1 }), code("malformed"));
  assert.throws(() => requestDigest({ ...base, fields: { ...f1, sig: "00" } }), code("malformed"));
});

// ---------------------------------------------------------------------------
// 6. Signed requests
// ---------------------------------------------------------------------------

const NOW = 1791000000123; // ms
const now = () => NOW;
const roundTrip = (o) => JSON.parse(JSON.stringify(o));

function signedSubmit(account, { mode = "batch", envelope = ENVELOPE_HEX, poolKey = POOL, network = "signet", endpoint = RELAY_ENDPOINTS.submit, at = now } = {}) {
  return roundTrip(signRequest({ account, endpoint, network, poolKey, fields: { envelope, mode }, now: at }));
}
const verifySubmit = (body, over = {}) => verifyRequest({ endpoint: RELAY_ENDPOINTS.submit, network: "signet", poolKey: POOL, body, now, ...over });

test("signRequest produces exactly the contract's bodies; verifyRequest accepts them", () => {
  const a = relayAccount(SEED);
  const read = signRequest({ account: a, endpoint: RELAY_ENDPOINTS.account, network: "signet", poolKey: bytesToHex(POOL), now });
  assert.deepEqual(Object.keys(read).sort(), ["accountPub", "sig", "t"]);
  assert.equal(read.accountPub, a.pubHex);
  assert.equal(read.t, Math.floor(NOW / 1000));
  assert.match(read.sig, /^[0-9a-f]{128}$/);
  const okRead = verifyRequest({ endpoint: RELAY_ENDPOINTS.account, network: "signet", poolKey: bytesToHex(POOL), body: roundTrip(read), now });
  assert.equal(okRead.ok, true);
  assert.deepEqual(okRead.pub, a.pub);
  assert.deepEqual(okRead.id, a.id);
  assert.equal(okRead.idHex, a.idHex);
  assert.deepEqual(okRead.fields, { accountPub: a.pubHex, t: read.t });

  const sub = signedSubmit(a, { mode: "fast" });
  assert.deepEqual(Object.keys(sub).sort(), ["accountPub", "envelope", "mode", "sig", "t"]);
  const ok = verifySubmit(sub);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.fields, { accountPub: a.pubHex, envelope: ENVELOPE_HEX, mode: "fast", t: sub.t });
  assert.ok(!("sig" in ok.fields));
  for (const mode of ["fast", "block", "batch", "batch10"]) assert.equal(verifySubmit(signedSubmit(a, { mode })).ok, true, mode);
  // Default clock: a fresh request verifies against the real clock.
  const live = signRequest({ account: a, endpoint: RELAY_ENDPOINTS.account, network: "signet", poolKey: POOL });
  assert.equal(verifyRequest({ endpoint: RELAY_ENDPOINTS.account, network: "signet", poolKey: POOL, body: roundTrip(live) }).ok, true);
  assert.throws(() => signRequest({ account: a, endpoint: RELAY_ENDPOINTS.account, network: "signet", poolKey: POOL, fields: { sig: "00" } }), code("malformed"));
  assert.throws(() => signRequest({ account: {}, endpoint: RELAY_ENDPOINTS.account, network: "signet", poolKey: POOL }), code("malformed"));
});

test("the signature binds endpoint, network, Q, envelope, mode, accountPub and t", () => {
  const a = relayAccount(SEED);
  const other = relayAccount(h("other seed"));
  const body = signedSubmit(a);
  const bad = (b, over, why) => assert.deepEqual(verifySubmit(b, over), { ok: false, code: "bad_signature" }, why);
  bad(signedSubmit(a, { endpoint: RELAY_ENDPOINTS.account }), {}, "signed for another endpoint");
  bad(body, { endpoint: RELAY_ENDPOINTS.submit, network: "testnet" }, "verified on another network");
  bad(signedSubmit(a, { network: "mainnet" }), {}, "signed for another network");
  bad(body, { poolKey: schnorr.getPublicKey(h("other pool")) }, "another relayer's Q");
  bad(signedSubmit(a, { poolKey: schnorr.getPublicKey(h("other pool")) }), {}, "signed for another Q");
  bad({ ...body, envelope: "cd".repeat(471) }, {}, "another envelope");
  bad({ ...body, envelope: ENVELOPE_HEX.slice(0, -2) + "ac" }, {}, "one envelope byte changed");
  for (const mode of ["fast", "block", "batch10"]) bad({ ...body, mode }, {}, `mode changed to ${mode}`);
  bad({ ...body, accountPub: other.pubHex }, {}, "another account's key");
  bad({ ...body, t: body.t + 1 }, {}, "t changed");
  bad({ ...body, sig: signedSubmit(other).sig }, {}, "another account's signature");
  const flipped = body.sig.slice(0, -1) + (body.sig.at(-1) === "0" ? "1" : "0");
  bad({ ...body, sig: flipped }, {}, "signature bit flipped");
  // The account read cannot be replayed as a submit and vice versa.
  const read = roundTrip(signRequest({ account: a, endpoint: RELAY_ENDPOINTS.account, network: "signet", poolKey: POOL, now }));
  assert.equal(verifySubmit({ ...read, envelope: ENVELOPE_HEX, mode: "batch" }).code, "bad_signature");
});

test("L1: a submit may add the signed boolean linkable; the signature covers it and any other type is malformed", () => {
  const a = relayAccount(SEED);
  const signed = (linkable) => roundTrip(signRequest({ account: a, endpoint: RELAY_ENDPOINTS.submit, network: "signet", poolKey: POOL, fields: { envelope: ENVELOPE_HEX, mode: "block", linkable }, now }));
  const yes = signed(true);
  assert.deepEqual(Object.keys(yes).sort(), ["accountPub", "envelope", "linkable", "mode", "sig", "t"]);
  const ok = verifySubmit(yes);
  assert.equal(ok.ok, true);
  assert.equal(ok.fields.linkable, true);
  assert.equal(verifySubmit(signed(false)).ok, true, "linkable: false is allowed too");
  // The flag is signed: dropping or flipping it breaks the signature.
  const { linkable: _, ...dropped } = yes;
  assert.deepEqual(verifySubmit(dropped), { ok: false, code: "bad_signature" });
  assert.deepEqual(verifySubmit({ ...yes, linkable: false }), { ok: false, code: "bad_signature" });
  assert.deepEqual(verifySubmit({ ...signedSubmit(a, { mode: "block" }), linkable: true }), { ok: false, code: "bad_signature" }, "added after signing");
  for (const v of ["true", 1, null, {}]) assert.deepEqual(verifySubmit({ ...yes, linkable: v }), { ok: false, code: "malformed" }, String(v));
  // Only a submit takes it.
  const read = roundTrip(signRequest({ account: a, endpoint: RELAY_ENDPOINTS.account, network: "signet", poolKey: POOL, fields: { linkable: true }, now }));
  assert.deepEqual(verifyRequest({ endpoint: RELAY_ENDPOINTS.account, network: "signet", poolKey: POOL, body: read, now }), { ok: false, code: "malformed" });
});

test("t more than 600 s from the relayer's clock is stale_request; 600 s is accepted", () => {
  const a = relayAccount(SEED);
  const sec = Math.floor(NOW / 1000);
  const at = (s) => () => s * 1000;
  assert.equal(verifySubmit(signedSubmit(a, { at: at(sec - 600) })).ok, true);
  assert.equal(verifySubmit(signedSubmit(a, { at: at(sec + 600) })).ok, true);
  assert.deepEqual(verifySubmit(signedSubmit(a, { at: at(sec - 601) })), { ok: false, code: "stale_request" });
  assert.deepEqual(verifySubmit(signedSubmit(a, { at: at(sec + 601) })), { ok: false, code: "stale_request" });
  assert.deepEqual(verifySubmit(signedSubmit(a, { at: at(0) })), { ok: false, code: "stale_request" });
  assert.equal(verifySubmit(signedSubmit(a, { at: at(sec - 601) }), { maxSkewSec: 700 }).ok, true);
  // Stale is decided before the signature: a forged old request reads as stale, not as a key test.
  const forged = { ...signedSubmit(a, { at: at(sec - 5000) }), sig: "00".repeat(64) };
  assert.equal(verifySubmit(forged).code, "stale_request");
});

test("a missing or extra key, or a malformed field, is malformed", () => {
  const a = relayAccount(SEED);
  const body = signedSubmit(a);
  const malformed = (b, why, endpoint = RELAY_ENDPOINTS.submit) => assert.deepEqual(verifySubmit(b, { endpoint }), { ok: false, code: "malformed" }, why);
  for (const k of Object.keys(body)) {
    const { [k]: _, ...missing } = body;
    malformed(missing, `missing ${k}`);
  }
  malformed({ ...body, pow: "00" }, "extra pow");
  malformed({ ...body, extra: 1 }, "extra key");
  const read = roundTrip(signRequest({ account: a, endpoint: RELAY_ENDPOINTS.account, network: "signet", poolKey: POOL, now }));
  malformed({ ...read, mode: "fast" }, "account read with a mode", RELAY_ENDPOINTS.account);
  malformed(read, "an account read sent to submit");
  malformed({ ...body, accountPub: body.accountPub.toUpperCase() }, "uppercase accountPub");
  malformed({ ...body, accountPub: "0".repeat(63) + "5" }, "accountPub off the curve");
  malformed({ ...body, sig: body.sig.toUpperCase() }, "uppercase sig");
  malformed({ ...body, sig: body.sig.slice(2) }, "short sig");
  malformed({ ...body, t: String(body.t) }, "t as a string");
  malformed({ ...body, t: body.t + 0.5 }, "fractional t");
  malformed({ ...body, t: -1 }, "negative t");
  malformed({ ...body, mode: "batch12" }, "unknown mode");
  malformed({ ...body, mode: undefined }, "mode undefined");
  malformed({ ...body, envelope: ENVELOPE_HEX.toUpperCase() }, "uppercase envelope");
  malformed({ ...body, envelope: "abc" }, "odd-length envelope");
  malformed({ ...body, envelope: 5 }, "envelope not a string");
  malformed(null, "null body");
  malformed([], "array body");
  malformed("{}", "a string body");
  assert.deepEqual(verifyRequest({ endpoint: "/api/relay/withdraw", network: "signet", poolKey: POOL, body, now }), { ok: false, code: "malformed" });
  // The relayer's own configuration errors throw instead of refusing the user.
  assert.throws(() => verifyRequest({ endpoint: RELAY_ENDPOINTS.submit, network: "regtest", poolKey: POOL, body, now }), code("bad_network"));
  assert.throws(() => verifyRequest({ endpoint: RELAY_ENDPOINTS.submit, network: "signet", poolKey: "00", body, now }), code("malformed"));
});

test("relay-account.mjs is browser-safe: no node:* imports", () => {
  const src = readFileSync(new URL("../src/relay-account.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const i of imports) assert.ok(!i.startsWith("node:"), i);
  assert.deepEqual(imports.sort(), ["./bytes.mjs", "./params.mjs", "@noble/curves/secp256k1", "@noble/hashes/hkdf", "@noble/hashes/sha256", "@scure/btc-signer"]);
});

// ---------------------------------------------------------------------------
// 7. funding.mjs: stage-0 calls unchanged, new options
// ---------------------------------------------------------------------------

const FIX_KEY = h("murkle/test/fixture-key/1");
const FIX_ACCOUNT = btcAccount(FIX_KEY);
const FIX_ENVELOPE = Uint8Array.from({ length: 471 }, (_, i) => (i * 7 + 3) & 255);
const fixUtxo = (tag, vout, value) => ({ txid: bytesToHex(h(tag)), vout, value });
const FIX_UTXOS = [fixUtxo("a", 0, 1200), fixUtxo("b", 3, 50000), fixUtxo("c", 1, 9000)];
const FIX_TREASURY = scriptOf("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");

// Digests recorded from the stage-0 funding.mjs (before this change), signed with a zero aux.
const STAGE0 = {
  basic: { psbt: "2ddb0579ed3afc6f61c51ca4d2a1347b4271f92341d948e0a61677258285f84c", signed: "be8d5685bd09fab551530293067440c6eb2063894c006fa914e860f599cd9c16", txid: "780f8ac9c019a6989aa35205b47ee872b037fc04a14d7dc9e9dff932be24ca07", vsize: 597, fee: 1196n },
  outputs: { psbt: "f64ffa40cd3fa7952544be6fa6c553cdf820212109e723719f44c360eeef0df9", signed: "5b12998e41ad514fb60d2b8c9a8650a45004777cf564ada657c2961cf3148f83", txid: "7af6128aaaa13832c00af0d7ba8143cc2890cf26aaca6152896aa27d295770c3", vsize: 729, fee: 2187n },
  sequence: { psbt: "fd309a66ca2e301f3b4dbadc2d5003ee7f19b81bafb2c1ce755b1a3afdd6d514", signed: "6a2e86b744ed4b454c51b3b35256e5ea6a4ea9a72f4983e1c54310d900a842bf", txid: "b39b0e818446195cbb6d89b1b0a5472ce1685d812cf45a443c557c913f15e1bc", vsize: 597, fee: 598n },
  nochange: { psbt: "de64e8a0078e467c6dc8b51aad4f4d2599dbd850eba53e4e15ebfed58696cce7", signed: "121fc4f7ea0c4e7cafc415d314d75b33007feaa998839b73c2b9fb1faca3ee6c", txid: "729cef0742c4272d6b20e9dd84a4d0a43791d721c75d2a9d82faa70a08d50173", vsize: 554, fee: 1300n },
  multi: { psbt: "94b3b79ab17e1ad1a3f7cea7f855d319bb53c397fb9b6bf919a64bcb0b8b96be", signed: "b1f427ad8703f89189c09fe219cfac51f61564f72df22796fd73829b13f50b94", txid: "aa402d039349371e54eede0d189b546edf3ace949e14c5acacc68c72591cee75", vsize: 177, fee: 1100n },
};
// L5 lays inputs and the change out at random; `random: (n) => n - 1` keeps the stage-0 layout
// (largest first, change last), so these cases differ from stage-0 only in nSequence.
const KEEP = (n) => n - 1;
const STAGE0_CASES = {
  basic: () => planCarrierTx({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, envelope: FIX_ENVELOPE, feeRate: 2, random: KEEP }),
  outputs: () => planCarrierTx({
    account: FIX_ACCOUNT, utxos: FIX_UTXOS, envelope: FIX_ENVELOPE, feeRate: 3, firstInput: FIX_UTXOS[0],
    outputs: [{ script: FIX_TREASURY, amount: 100n }, { script: FIX_ACCOUNT.script, amount: 5000n }], random: KEEP,
  }),
  sequence: () => planCarrierTx({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, envelope: FIX_ENVELOPE, feeRate: 1, sequence: 0xfffffffd, random: KEEP }),
  nochange: () => planCarrierTx({ account: FIX_ACCOUNT, utxos: [fixUtxo("d", 0, 1300)], envelope: FIX_ENVELOPE, feeRate: 2, random: KEEP }),
  multi: () => planCarrierTx({ account: FIX_ACCOUNT, utxos: [fixUtxo("e", 0, 400), fixUtxo("f", 1, 500), fixUtxo("g", 2, 600)], envelope: new Uint8Array(40), feeRate: 4, random: KEEP }),
};

test("planCarrierTx with the stage-0 layout builds the stage-0 transactions except nSequence, now 0xfffffffd on every input (L5)", () => {
  for (const [name, plan] of Object.entries(STAGE0_CASES)) {
    const want = STAGE0[name];
    const { tx, fee } = plan();
    assert.equal(fee, want.fee, `${name} fee`);
    assert.equal(typeof fee, "bigint", "fee stays a bigint for existing callers");
    for (let i = 0; i < tx.inputsLength; i++) assert.equal(tx.getInput(i).sequence, 0xfffffffd, `${name} input ${i} signals RBF`);
    // The stage-0 "sequence" case already used 0xfffffffd: it is byte-identical as built. The others
    // used the default 0xffffffff: put that back and every byte matches the stage-0 recording.
    if (name !== "sequence") for (let i = 0; i < tx.inputsLength; i++) tx.updateInput(i, { sequence: 0xffffffff }, true);
    assert.equal(bytesToHex(sha256(tx.toPSBT())), want.psbt, `${name} unsigned PSBT`);
    tx.sign(FIX_KEY, undefined, new Uint8Array(32));
    tx.finalize();
    assert.equal(bytesToHex(sha256(tx.toBytes(true, true))), want.signed, `${name} signed bytes`);
    assert.equal(tx.id, want.txid);
    assert.equal(tx.vsize, want.vsize);
  }
  const short = /^Error: not enough BTC at tb1pg5uncgv2wxwaaqs6vjvn4jkyyp86696zm205h79lzujhu8twa5tsv6m476: have 500 sats, need 1196$/;
  assert.throws(() => planCarrierTx({ account: FIX_ACCOUNT, utxos: [fixUtxo("x", 0, 500)], envelope: FIX_ENVELOPE, feeRate: 2 }), short);
  assert.throws(() => planCarrierTx({ account: FIX_ACCOUNT, utxos: [], envelope: FIX_ENVELOPE, feeRate: 2 }), /have 0 sats, need 1196$/);
  assert.throws(() => planCarrierTx({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, envelope: FIX_ENVELOPE, feeRate: 1.5 }), "a fractional rate still throws");
  assert.throws(() => planCarrierTx({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, envelope: FIX_ENVELOPE, feeRate: 1, firstInput: fixUtxo("zz", 0, 1) }), /no longer available/);
});

test("planCarrierTx reports change, changeIndex and inputs", () => {
  const p = STAGE0_CASES.basic();
  assert.equal(p.changeIndex, 1);
  assert.equal(p.tx.outputsLength, 2);
  assert.equal(p.tx.getOutput(1).amount, p.change);
  assert.deepEqual(p.tx.getOutput(1).script, FIX_ACCOUNT.script);
  assert.deepEqual(p.inputs.map((i) => i.vout), [3], "largest first (one input)");
  assert.deepEqual(p.inputs[0], { ...FIX_UTXOS[1], script: FIX_ACCOUNT.script, tapInternalKey: FIX_ACCOUNT.pub });
  const n = STAGE0_CASES.nochange();
  assert.equal(n.changeIndex, null);
  assert.equal(n.change, 0n);
  assert.equal(n.tx.outputsLength, 1);
  const o = STAGE0_CASES.outputs();
  assert.equal(o.changeIndex, 3, "after the OP_RETURN and two payments");
  assert.deepEqual(o.inputs.map((i) => i.txid), [FIX_UTXOS[0].txid, FIX_UTXOS[1].txid], "the bound input first");
});

test("changeScript moves the change and the fee accounts for its size", () => {
  const p2wpkh = FIX_TREASURY; // 22 bytes: 9 vbytes smaller than a 34-byte P2TR output
  const C = btcAccount(h("murkle/test/change"));
  for (const rate of [1, 2, 5]) {
    const base = planCarrierTx({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, envelope: FIX_ENVELOPE, feeRate: rate });
    const toC = planCarrierTx({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, envelope: FIX_ENVELOPE, feeRate: rate, changeScript: C.script });
    assert.equal(toC.fee, base.fee, "a P2TR change script has the same size");
    assert.deepEqual(toC.tx.getOutput(toC.changeIndex).script, C.script);
    assert.ok(!sameScript(toC.tx.getOutput(toC.changeIndex).script, FIX_ACCOUNT.script));
    const toW = planCarrierTx({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, envelope: FIX_ENVELOPE, feeRate: rate, changeScript: p2wpkh });
    assert.equal(base.fee - toW.fee, BigInt(12 * rate), "12 vbytes less for a P2WPKH change output");
    assert.deepEqual(toW.tx.getOutput(toW.changeIndex).script, p2wpkh);
    for (const p of [base, toC, toW]) assert.equal(BigInt(feeOf(p.tx)), p.fee, "feeOf matches the planned fee");
  }
  // Signing the C-change plan and checking the finished size against the fee estimate.
  const toC = planCarrierTx({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, envelope: FIX_ENVELOPE, feeRate: 1, changeScript: C.script });
  const signed = signInputs(toC.tx, [FIX_KEY]);
  assert.ok(Number(toC.fee) >= signed.vsize, "the fee covers the real vsize at 1 sat/vB");
  assert.throws(() => planCarrierTx({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, envelope: FIX_ENVELOPE, feeRate: 1, changeScript: "tb1p..." }), /changeScript/);
});

const sameScript = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

test("order: 'given' keeps the order; 'largest' sorts; anything else throws", () => {
  const utxos = [fixUtxo("s", 0, 700), fixUtxo("m", 0, 800), fixUtxo("l", 0, 900)];
  const given = planCarrierTx({ account: FIX_ACCOUNT, utxos, envelope: new Uint8Array(40), feeRate: 1, order: "given" });
  assert.deepEqual(given.inputs.map((i) => i.value), [700], "the first given coin covers it");
  const two = planCarrierTx({ account: FIX_ACCOUNT, utxos, envelope: FIX_ENVELOPE, feeRate: 1, order: "given" });
  assert.deepEqual(two.inputs.map((i) => i.value), [700], "700 covers a 1 sat/vB carrier");
  const many = planCarrierTx({ account: FIX_ACCOUNT, utxos, envelope: FIX_ENVELOPE, feeRate: 2, order: "given" });
  assert.deepEqual(many.inputs.map((i) => i.value), [700, 800]);
  // 'largest' chooses the largest coins, then lays them out in a random order (L5).
  const largest = planCarrierTx({ account: FIX_ACCOUNT, utxos, envelope: FIX_ENVELOPE, feeRate: 2, random: KEEP });
  assert.deepEqual(largest.inputs.map((i) => i.value), [900, 800]);
  const swapped = planCarrierTx({ account: FIX_ACCOUNT, utxos, envelope: FIX_ENVELOPE, feeRate: 2, random: () => 0 });
  assert.deepEqual(swapped.inputs.map((i) => i.value), [800, 900]);
  const seen = new Set();
  for (let k = 0; k < 64 && seen.size < 2; k++) seen.add(planCarrierTx({ account: FIX_ACCOUNT, utxos, envelope: FIX_ENVELOPE, feeRate: 2 }).inputs.map((i) => i.value).join());
  assert.deepEqual([...seen].sort(), ["800,900", "900,800"], "the default CSPRNG gives both orders");
  assert.deepEqual(utxos.map((u) => u.value), [700, 800, 900], "the caller's array is not reordered");
  assert.throws(() => planCarrierTx({ account: FIX_ACCOUNT, utxos, envelope: FIX_ENVELOPE, feeRate: 1, order: "smallest" }), /unknown input order/);
});

test("per-input scripts must be key-path P2TR and match their internal key", () => {
  const C = btcAccount(h("murkle/test/change"));
  const coin = (over) => ({ txid: bytesToHex(h("in")), vout: 0, value: 5000, ...over });
  const plan = (u) => planCarrierTx({ account: C, utxos: [u], envelope: new Uint8Array(10), feeRate: 1 });
  assert.throws(() => plan(coin({ script: FIX_TREASURY, tapInternalKey: C.pub })), /only key-path P2TR/);
  assert.throws(() => plan(coin({ script: Uint8Array.of(0x6a, 1, 2) })), /only key-path P2TR/);
  assert.throws(() => plan(coin({ script: "5120" + "00".repeat(32) })), /script must be bytes/);
  assert.throws(() => plan(coin({ script: FIX_ACCOUNT.script })), /does not match/, "a script with the default key of another account");
  assert.throws(() => plan(coin({ tapInternalKey: FIX_ACCOUNT.pub })), /does not match/, "a key that does not pay the default script");
  assert.throws(() => plan(coin({ script: FIX_ACCOUNT.script, tapInternalKey: new Uint8Array(31) })), /32 bytes/);
  const ok = plan(coin({ script: FIX_ACCOUNT.script, tapInternalKey: FIX_ACCOUNT.pub }));
  assert.deepEqual(ok.tx.getInput(0).witnessUtxo.script, FIX_ACCOUNT.script);
  assert.deepEqual(ok.tx.getInput(0).tapInternalKey, FIX_ACCOUNT.pub);
  assert.deepEqual(ok.tx.getOutput(ok.changeIndex).script, C.script, "change still defaults to the account");
});

test("feeOf is inputs minus outputs and needs every input's amount", () => {
  const p = STAGE0_CASES.outputs();
  const ins = 1200 + 50000;
  const outs = [...Array(p.tx.outputsLength).keys()].reduce((s, i) => s + Number(p.tx.getOutput(i).amount), 0);
  assert.equal(feeOf(p.tx), ins - outs);
  assert.equal(feeOf(p.tx), Number(p.fee));
  const tx = new btc.Transaction();
  tx.addInput({ txid: bytesToHex(h("no amount")), index: 0 });
  tx.addOutputAddress(FIX_ACCOUNT.address, 1000n, btc.TEST_NETWORK);
  assert.throws(() => feeOf(tx), /no witnessUtxo/);
});

test("planPayment: a plain payment with no OP_RETURN, change to the account, dust and shortfalls refused", () => {
  const a = relayAccount(SEED);
  const dep = depositAddress(POOL, a.id, 0);
  const p = planPayment({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, to: dep.script, amount: 7000, feeRate: 2 });
  for (let i = 0; i < p.tx.outputsLength; i++) assert.notEqual(p.tx.getOutput(i).script[0], 0x6a, "no OP_RETURN");
  assert.equal(p.tx.outputsLength, 2);
  // L5: the change takes a random slot; paymentIndex and changeIndex say where each landed.
  assert.ok([0, 1].includes(p.paymentIndex));
  assert.equal(p.changeIndex, 1 - p.paymentIndex);
  assert.deepEqual(p.tx.getOutput(p.paymentIndex).script, dep.script);
  assert.equal(p.tx.getOutput(p.paymentIndex).amount, 7000n);
  assert.equal(addressOf(p.tx.getOutput(p.paymentIndex).script), dep.address);
  assert.deepEqual(p.tx.getOutput(p.changeIndex).script, FIX_ACCOUNT.script);
  assert.equal(p.tx.getOutput(p.changeIndex).amount, p.change);
  const first = planPayment({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, to: dep.script, amount: 7000, feeRate: 2, random: () => 0 });
  assert.deepEqual([first.changeIndex, first.paymentIndex], [0, 1], "the change can come first");
  assert.equal(BigInt(feeOf(p.tx)), p.fee);
  // 1 input, P2TR payment + P2TR change: ceil(11 + 43 + 43 + 57.5) = 155 vbytes.
  assert.equal(p.fee, 2n * 155n);
  const signed = signInputs(p.tx, [FIX_KEY]);
  assert.ok(signed.vsize <= 155);
  verifyKeyPathWitnesses(p.tx);
  // Bigint amounts work too; a sequence is applied.
  const q = planPayment({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, to: dep.script, amount: 2000n, feeRate: 1, sequence: 0xfffffffd });
  assert.equal(q.tx.getInput(0).sequence, 0xfffffffd);
  // No change output when the rest is dust.
  const exact = planPayment({ account: FIX_ACCOUNT, utxos: [fixUtxo("p", 0, 2000 + 112 + 100)], to: dep.script, amount: 2000, feeRate: 1 });
  assert.equal(exact.change, 0n);
  assert.equal(exact.tx.outputsLength, 1);
  assert.equal(exact.fee, 212n);

  assert.throws(() => planPayment({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, to: dep.script, amount: 329, feeRate: 1 }), /below the 330-sat dust limit/);
  assert.throws(() => planPayment({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, to: FIX_TREASURY, amount: 293, feeRate: 1 }), /below the 294-sat dust limit/);
  const min = planPayment({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, to: FIX_TREASURY, amount: 294, feeRate: 1 });
  assert.equal(min.tx.getOutput(min.paymentIndex).amount, 294n);
  assert.throws(() => planPayment({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, to: dep.script, amount: 0, feeRate: 1 }), /dust limit/);
  assert.throws(() => planPayment({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, to: Uint8Array.of(0x6a, 0), amount: 1000, feeRate: 1 }), /OP_RETURN/);
  assert.throws(() => planPayment({ account: FIX_ACCOUNT, utxos: FIX_UTXOS, to: dep.address, amount: 1000, feeRate: 1 }), /output script/);
  assert.throws(
    () => planPayment({ account: FIX_ACCOUNT, utxos: [fixUtxo("q", 0, 2100)], to: dep.script, amount: 2000, feeRate: 1 }),
    new RegExp(`^Error: not enough BTC at ${FIX_ACCOUNT.address}: have 2100 sats, need 2155$`),
  );
  assert.throws(() => planPayment({ account: FIX_ACCOUNT, utxos: [], to: dep.script, amount: 2000, feeRate: 1 }), /have 0 sats, need 2155$/);
  assert.equal(dustLimit(dep.script), 330n);
});

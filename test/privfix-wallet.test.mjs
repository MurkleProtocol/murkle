// Privacy fixes, wallet track (docs/design/privacy-trace-test.md L4 and L5):
// - L4: the two outputs of TRANSACT, MINT / MINT_SCRIPT and MINE / MINE_SCRIPT are shuffled with
//   a CSPRNG (commitment and ciphertext together); the circuit proves either order; the wallet
//   finds its notes wherever they land.
// - L5: one fingerprint policy for every transaction the software builds: nSequence 0xfffffffd on
//   every input, fee = ceil(vsize) x a whole sat/vB rate, one headroom, inputs in a random order
//   (a bound first input stays first) and the change at a random position after the OP_RETURN.
// Each statistical check runs 64 times: the old fixed order passes it with probability 2^-63.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as snarkjs from "snarkjs";
import * as btc from "@scure/btc-signer";
import { MerkleTree, commitmentOf, nullifierOf, randomField, toField } from "../src/core.mjs";
import { deriveKeys, tryDecryptNote } from "../src/keys.mjs";
import { Wallet, shuffleOutputs } from "../src/wallet.mjs";
import { OP, decodeEnvelope, extDataHashOf } from "../src/envelope.mjs";
import { decodeProof } from "../src/proof-codec.mjs";
import { challengeOf } from "../src/mine.mjs";
import {
  FEE_HEADROOM, RBF_SEQUENCE, btcAccount, buildCarrierTx, feeFor, headroomRate, planCarrierTx, planPayment, planSplitTx,
  scriptOf, shuffled,
} from "../src/btc/funding.mjs";
import { planSend } from "../scripts/send-btc.mjs";
import { hex } from "../src/bytes.mjs";

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const RUNS = 64;
const ASSET = 7n;

after(async () => {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const keys = () => deriveKeys(randomBytes(32));
const withProof = (body) => {
  const env = new Uint8Array(body.length + 128);
  env.set(body, 0);
  return env;
};
/** Which output (0 or 1) of a decoded envelope `who` can open with a value, or -1. */
const ownIndex = (env, who) => {
  const hits = [0, 1].filter((i) => {
    const n = tryDecryptNote(env.ciphertexts[i], who, env.commitments[i]);
    return n && n.amount > 0n;
  });
  assert.ok(hits.length <= 1);
  return hits.length ? hits[0] : -1;
};

/** A view with one note of `amount` owned by `owner` at leaf 0 (plus filler leaves). */
function viewWithNote(owner, amount) {
  const tree = new MerkleTree();
  const blinding = randomField();
  const commitment = commitmentOf({ asset: ASSET, amount, pubkey: owner.pk, blinding });
  tree.insert(commitment);
  tree.insert(randomField());
  const note = { asset: ASSET, amount, blinding, leafIndex: 0, nullifier: nullifierOf(commitment, 0n, owner.sk), spent: false };
  return { view: { height: 100, tree, outputs: [] }, note };
}

/* ------------------------------------------------------------------ L4 */

test("L4: shuffleOutputs is a uniform permutation from the CSPRNG and keeps every entry", () => {
  const seen = new Set();
  for (let i = 0; i < RUNS; i++) {
    const out = shuffleOutputs(["a", "b"]);
    assert.deepEqual([...out].sort(), ["a", "b"]);
    seen.add(out.join(""));
  }
  assert.deepEqual([...seen].sort(), ["ab", "ba"], "both orders occur");
  assert.deepEqual(shuffleOutputs(["a", "b"], (n) => n - 1), ["a", "b"], "an injected source decides");
  assert.deepEqual(shuffleOutputs(["a", "b"], () => 0), ["b", "a"]);
  assert.throws(() => shuffleOutputs(["a", "b"], () => 2), RangeError);
  const src = readFileSync("src/wallet.mjs", "utf8");
  assert.match(src, /globalThis\.crypto\.getRandomValues/, "a CSPRNG, not Math.random");
  assert.doesNotMatch(src, /Math\.random/);
});

test("L4: the circuit treats its two outputs symmetrically (one loop over nOuts, no index-specific rule)", () => {
  const lib = readFileSync("circuits/lib.circom", "utf8");
  const outLoop = lib.slice(lib.indexOf("component outCommitment[nOuts];"), lib.indexOf("// The same note cannot be spent twice"));
  assert.match(outLoop, /for \(var i = 0; i < nOuts; i\+\+\)/);
  assert.doesNotMatch(outLoop, /\b(out\w*|outputCommitment)\[(0|1)\]/, "no output is singled out by its index");
  assert.doesNotMatch(lib.slice(lib.indexOf("sumIns + publicAmount")), /out\w*\[(0|1)\]/);
});

test("L4: TRANSACT puts the recipient's note and the change at random positions; commitment and ciphertext move together", () => {
  const alice = keys();
  const bob = keys();
  const w = new Wallet(alice);
  const { view, note } = viewWithNote(alice, 1000n);
  const at = { 0: 0, 1: 0 };
  for (let i = 0; i < RUNS; i++) {
    const { body } = w.draftEnvelope(view, { op: OP.TRANSACT, asset: ASSET, inputs: [note], outputs: [{ amount: 300n, to: { pk: bob.pk, vpk: bob.vpk } }, { amount: 700n, to: w.address }] });
    const env = decodeEnvelope(withProof(body));
    const toBob = ownIndex(env, bob);
    const change = ownIndex(env, alice);
    assert.ok(toBob >= 0 && change >= 0 && toBob !== change, "each party opens exactly one output");
    assert.equal(tryDecryptNote(env.ciphertexts[toBob], bob, env.commitments[toBob]).amount, 300n);
    assert.equal(tryDecryptNote(env.ciphertexts[change], alice, env.commitments[change]).amount, 700n);
    at[toBob] += 1;
  }
  assert.ok(at[0] > 0 && at[1] > 0, `the recipient's note is not always output 0 (${at[0]} / ${at[1]})`);
});

test("L4: MINT and MINT_SCRIPT put the minted note and its zero padding at random positions", () => {
  const alice = keys();
  const w = new Wallet(alice);
  const view = { height: 100, tree: new MerkleTree(), outputs: [] };
  for (const [op, bind] of [[OP.MINT, { bindOutpoint: new Uint8Array(36) }], [OP.MINT_SCRIPT, { bindScriptHash: new Uint8Array(32) }]]) {
    const at = { 0: 0, 1: 0 };
    for (let i = 0; i < RUNS; i++) {
      const { body } = w.draftEnvelope(view, { op, asset: ASSET, inputs: [], outputs: [{ amount: 500n, to: w.address }], publicAmount: 500n, publicAsset: ASSET, ...bind });
      const env = decodeEnvelope(withProof(body));
      const mine = ownIndex(env, alice);
      assert.ok(mine >= 0);
      assert.equal(tryDecryptNote(env.ciphertexts[1 - mine], alice, env.commitments[1 - mine]), null, "the other output is padding to a throwaway key");
      at[mine] += 1;
    }
    assert.ok(at[0] > 0 && at[1] > 0, `op ${op}: the minted note is not always output 0 (${at[0]} / ${at[1]})`);
  }
});

test("L4: a mining claim draft puts its own note at a random position; the challenge commits to the shuffled order", () => {
  const alice = keys();
  const w = new Wallet(alice);
  const view = { height: 100, tree: new MerkleTree(), outputs: [] };
  const refHash = "ab".repeat(32);
  const at = { 0: 0, 1: 0 };
  for (let i = 0; i < RUNS; i++) {
    const d = w.prepareClaim(view, { asset: ASSET, reward: 9n, refHash, roll: false });
    const mine = [0, 1].find((k) => tryDecryptNote(d.ciphertexts[k], alice, d.commitments[k])?.amount === 9n);
    assert.ok(mine === 0 || mine === 1);
    assert.equal(tryDecryptNote(d.ciphertexts[1 - mine], alice, d.commitments[1 - mine]), null);
    assert.equal(hex(d.challenge), hex(challengeOf({ asset: ASSET, refHeight: 100, refHash, reward: 9n, commitments: d.commitments })));
    at[mine] += 1;
  }
  assert.ok(at[0] > 0 && at[1] > 0, `the claim's note is not always output 0 (${at[0]} / ${at[1]})`);
});

async function verifies(envelope, root) {
  const env = decodeEnvelope(envelope);
  const signals = [root, toField(env.publicAmount), env.publicAsset, env.extDataHash, ...env.nullifiers, ...env.commitments].map(String);
  return snarkjs.groth16.verify(VKEY, signals, decodeProof(env.proof));
}

test("L4: real proofs verify in both output orders (TRANSACT and MINT), and both parties' scans find their notes", async () => {
  const alice = keys();
  const bob = keys();
  for (const [name, random] of [["kept", (n) => n - 1], ["swapped", () => 0]]) {
    const w = new Wallet(alice);
    w.random = random;
    const { view, note } = viewWithNote(alice, 1000n);
    w.notes = [note];
    const envelope = await w.transfer(view, { asset: ASSET, amount: 300n, to: { pk: bob.pk, vpk: bob.vpk } });
    const env = decodeEnvelope(envelope);
    assert.equal(env.extDataHash, extDataHashOf(envelope.slice(0, envelope.length - 128)));
    assert.equal(await verifies(envelope, view.tree.root()), true, `TRANSACT, outputs ${name}`);
    assert.equal(ownIndex(env, bob), name === "kept" ? 0 : 1, "the injected order is the one on the wire");
    // Wallet.scan opens every output, wherever it sits.
    const indexer = {
      outputs: env.commitments.map((commitment, i) => ({ commitment, ciphertext: env.ciphertexts[i], leafIndex: 2 + i })),
      nullifiers: new Set([String(note.nullifier)]),
    };
    assert.deepEqual(new Wallet(bob).scan(indexer).notes.map((n) => n.amount), [300n]);
    assert.deepEqual(new Wallet(alice).scan(indexer).notes.map((n) => n.amount), [700n]);

    const mintView = { height: 100, tree: new MerkleTree(), outputs: [] };
    const mint = await w.mint(mintView, { asset: ASSET, mintAmount: 500n, bindOutpoint: new Uint8Array(36) });
    assert.equal(await verifies(mint, mintView.tree.root()), true, `MINT, outputs ${name}`);
    assert.equal(ownIndex(decodeEnvelope(mint), alice), name === "kept" ? 0 : 1);
  }
});

/* ------------------------------------------------------------------ L5 */

const ACCOUNT = btcAccount(new Uint8Array(32).fill(7));
const OTHER = scriptOf("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx");
const coin = (i, value) => ({ txid: hex(new Uint8Array(32).fill(i + 1)), vout: i, value });
const COINS = [coin(0, 600), coin(1, 700), coin(2, 800), coin(3, 900)];
const ENVELOPE = new Uint8Array(471).fill(3);
const sequences = (tx) => Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).sequence);
const inputKeys = (tx) => Array.from({ length: tx.inputsLength }, (_, i) => `${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`);
const outScripts = (tx) => Array.from({ length: tx.outputsLength }, (_, i) => hex(tx.getOutput(i).script));

test("L5: every input of every planned transaction carries nSequence 0xfffffffd, and no other value is accepted", async () => {
  assert.equal(RBF_SEQUENCE, 0xfffffffd);
  const plans = {
    carrier: planCarrierTx({ account: ACCOUNT, utxos: COINS, envelope: ENVELOPE, feeRate: 1 }),
    bound: planCarrierTx({ account: ACCOUNT, utxos: COINS, envelope: ENVELOPE, feeRate: 1, firstInput: COINS[0], outputs: [{ script: OTHER, amount: 500n }] }),
    given: planCarrierTx({ account: ACCOUNT, utxos: [COINS[3]], envelope: ENVELOPE, feeRate: 1, order: "given", changeScript: ACCOUNT.script }),
    payment: planPayment({ account: ACCOUNT, utxos: COINS, to: OTHER, amount: 1500n, feeRate: 1 }),
    split: planSplitTx({ account: ACCOUNT, utxos: COINS, n: 3, value: 400, feeRate: 1 }),
    sendAmount: planSend({ account: ACCOUNT, utxos: COINS, to: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", amount: 1500n, feeRate: 1 }),
    sendMax: planSend({ account: ACCOUNT, utxos: COINS, to: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", amount: "max", feeRate: 1 }),
  };
  for (const [name, { tx }] of Object.entries(plans)) {
    assert.ok(tx.inputsLength >= 1, name);
    assert.deepEqual(sequences(tx), Array(tx.inputsLength).fill(RBF_SEQUENCE), `${name}: RBF signalled on every input`);
  }
  const api = { utxos: async () => COINS, feeRate: async () => 2 };
  const built = await buildCarrierTx({ api, btcKey: new Uint8Array(32).fill(7), envelope: ENVELOPE });
  const raw = btc.Transaction.fromRaw(Buffer.from(built.hex, "hex"), { allowUnknownOutputs: true });
  assert.deepEqual(sequences(raw), Array(raw.inputsLength).fill(RBF_SEQUENCE), "the CLI's buildCarrierTx, signed");
  for (const sequence of [0xffffffff, 0xfffffffe, 0]) {
    assert.throws(() => planCarrierTx({ account: ACCOUNT, utxos: COINS, envelope: ENVELOPE, feeRate: 1, sequence }), /one policy/);
    assert.throws(() => planPayment({ account: ACCOUNT, utxos: COINS, to: OTHER, amount: 1500n, feeRate: 1, sequence }), /one policy/);
  }
  assert.doesNotThrow(() => planCarrierTx({ account: ACCOUNT, utxos: COINS, envelope: ENVELOPE, feeRate: 1, sequence: RBF_SEQUENCE }));
});

test("L5: inputs go in a random order, a bound first input stays first, plan.inputs follows the transaction", () => {
  const free = new Set();
  const bound = new Set();
  for (let i = 0; i < RUNS; i++) {
    const p = planCarrierTx({ account: ACCOUNT, utxos: COINS, envelope: new Uint8Array(40), feeRate: 1, outputs: [{ script: OTHER, amount: 2200n }] });
    assert.equal(p.tx.inputsLength, 4);
    assert.deepEqual(inputKeys(p.tx), p.inputs.map((u) => `${u.txid}:${u.vout}`), "plan.inputs is in input order");
    free.add(inputKeys(p.tx).join());
    const b = planCarrierTx({ account: ACCOUNT, utxos: COINS, envelope: new Uint8Array(40), feeRate: 1, firstInput: COINS[0], outputs: [{ script: OTHER, amount: 2200n }] });
    assert.equal(inputKeys(b.tx)[0], `${COINS[0].txid}:${COINS[0].vout}`, "the bind (MINT / MINE) holds");
    bound.add(inputKeys(b.tx).slice(1).join());
  }
  assert.ok(free.size > 1, "the largest coin is not always input 0");
  assert.ok(bound.size > 1, "the inputs after the bound one are shuffled too");
  const sweeps = new Set();
  for (let i = 0; i < RUNS; i++) sweeps.add(inputKeys(planSend({ account: ACCOUNT, utxos: COINS, to: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", amount: "max", feeRate: 1 }).tx).join());
  assert.ok(sweeps.size > 1, "send-btc max: inputs shuffled");
  // order "given" keeps the caller's layout (the relayer's I1 check pins outputs 1…k).
  for (let i = 0; i < 8; i++) {
    const g = planCarrierTx({ account: ACCOUNT, utxos: [COINS[1], COINS[3], COINS[2]], envelope: new Uint8Array(40), feeRate: 1, order: "given", outputs: [{ script: OTHER, amount: 1500n }] });
    assert.deepEqual(g.inputs.map((u) => u.vout), [1, 3, 2]);
    assert.equal(g.changeIndex, g.tx.outputsLength - 1);
  }
});

test("L5: the change output takes a random position, never before the OP_RETURN; changeIndex is where it is", () => {
  const PAY_A = OTHER;
  const PAY_B = scriptOf("tb1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3q0sl5k7");
  const carrierAt = new Set();
  const paymentAt = new Set();
  const splitAt = new Set();
  for (let i = 0; i < RUNS; i++) {
    const p = planCarrierTx({ account: ACCOUNT, utxos: [coin(9, 50_000)], envelope: ENVELOPE, feeRate: 2, outputs: [{ script: PAY_A, amount: 1000n }, { script: PAY_B, amount: 2000n }] });
    const s = outScripts(p.tx);
    assert.equal(s.length, 4);
    assert.equal(p.tx.getOutput(0).script[0], 0x6a, "the envelope stays output 0");
    assert.equal(s[p.changeIndex], hex(ACCOUNT.script));
    assert.equal(p.tx.getOutput(p.changeIndex).amount, p.change);
    assert.deepEqual(s.filter((x, k) => k !== 0 && k !== p.changeIndex), [hex(PAY_A), hex(PAY_B)], "the paid outputs keep their order");
    carrierAt.add(p.changeIndex);

    const q = planPayment({ account: ACCOUNT, utxos: [coin(9, 50_000)], to: PAY_A, amount: 5000n, feeRate: 2 });
    assert.equal(outScripts(q.tx)[q.changeIndex], hex(ACCOUNT.script));
    assert.equal(outScripts(q.tx)[q.paymentIndex], hex(PAY_A), "paymentIndex names the top-up's outpoint");
    assert.equal(q.tx.getOutput(q.paymentIndex).amount, 5000n);
    paymentAt.add(q.changeIndex);

    const sp = planSplitTx({ account: ACCOUNT, utxos: [coin(9, 50_000)], n: 2, value: 1000, feeRate: 1 });
    assert.equal(sp.tx.getOutput(sp.changeIndex).amount, sp.change);
    splitAt.add(sp.changeIndex);
  }
  assert.deepEqual([...carrierAt].sort(), [1, 2, 3], "carrier change: any slot after the envelope");
  assert.deepEqual([...paymentAt].sort(), [0, 1], "a top-up's change is not always last");
  assert.deepEqual([...splitAt].sort(), [0, 1, 2]);
  // No change output: nothing to place.
  const n = planCarrierTx({ account: ACCOUNT, utxos: [coin(9, 1300)], envelope: ENVELOPE, feeRate: 2 });
  assert.equal(n.changeIndex, null);
  assert.equal(n.tx.outputsLength, 1);
});

test("L5: one fee rule (ceil(vsize) x a whole rate) and one headroom; amounts are what the old rule charged", () => {
  assert.equal(feeFor(2, 597.5), 1196n);
  assert.equal(feeFor(3, 100), 300n);
  assert.throws(() => feeFor(1.5, 100), "a fractional rate still throws");
  assert.equal(FEE_HEADROOM, 1.25);
  assert.deepEqual([1, 2, 3, 4, 10].map(headroomRate), [2, 3, 4, 5, 13]);
  assert.equal(headroomRate(0), 1);
  for (const rate of [1, 2, 5, 17]) {
    const p = planCarrierTx({ account: ACCOUNT, utxos: [coin(9, 50_000), coin(8, 40_000)], envelope: ENVELOPE, feeRate: rate, outputs: [{ script: OTHER, amount: 60_000n }] });
    assert.equal(p.inputs.length, 2);
    const est = 11 + (8 + 3 + 475) + (8 + 1 + 22) + (8 + 1 + 34) + 57.5 * p.inputs.length; // overhead, OP_RETURN, payment, change, inputs
    assert.equal(p.fee, BigInt(rate) * BigInt(Math.ceil(est)), `rate ${rate}: unchanged I-PAY pricing`);
  }
  // The sweep and the payment price their bytes the same way.
  const max = planSend({ account: ACCOUNT, utxos: COINS, to: "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", amount: "max", feeRate: 3 });
  assert.equal(max.fee, feeFor(3, 11 + 57.5 * 4 + 8 + 1 + 22));
});

test("L5: the CLI and the send script use the shared policy (no own sequence, headroom or rounding)", () => {
  const cli = readFileSync("bin/murkle.mjs", "utf8");
  assert.doesNotMatch(cli, /MINE_HEADROOM|const RBF_SEQUENCE|0xffffffff\b.*sequence|sequence:\s*0x/);
  assert.doesNotMatch(cli, /Math\.ceil\([^)]*\*\s*(1\.25|MINE_HEADROOM)/, "one headroom: headroomRate");
  assert.match(cli, /headroomRate\(await nextBlockRate\(esplora\)\)/);
  assert.match(cli, /maxFeeRate \?\? headroomRate\(next\)/);
  assert.match(cli, /feeFor\(claimRate, vsize\)/);
  const send = readFileSync("scripts/send-btc.mjs", "utf8");
  assert.match(send, /sequence: RBF_SEQUENCE/);
  assert.match(send, /shuffled\(utxos, random\)/);
  assert.doesNotMatch(send, /BigInt\(feeRate\) \*/);
  const funding = readFileSync("src/btc/funding.mjs", "utf8");
  assert.doesNotMatch(funding, /Math\.random/);
  assert.deepEqual(shuffled([1, 2, 3], (n) => n - 1), [1, 2, 3]);
});

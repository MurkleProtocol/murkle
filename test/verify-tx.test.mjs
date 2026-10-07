// Proof X-ray engine (src/verify-tx.mjs) against a synthetic chain: real signed
// Bitcoin transactions (@scure/btc-signer) carrying real Groth16 envelopes, mined
// into fake blocks with valid headers and served by a fake Esplora over fetch.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { sha256 } from "@noble/hashes/sha256";
import { deriveKeys } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf, ANCHOR_WINDOW as IDX_WINDOW, MIN_ANCHOR_DEPTH as IDX_MIN_DEPTH } from "../src/indexer.mjs";
import { encodeAttest, encodeDeploy, findEnvelope, opReturnScript as opReturnScriptOf, scriptHashOf, ATTEST_KIND } from "../src/envelope.mjs";
import { parseBlock, parseRawTx } from "../src/btc/block.mjs";
import { Esplora } from "../src/btc/esplora.mjs";
import { btcAccount, planCarrierTx, signLocal } from "../src/btc/funding.mjs";
import { concat, hex, outpointOf, u32le, unhex } from "../src/bytes.mjs";
import { MANIFEST_SHA256, ARTIFACT_SHA256 } from "../src/params.mjs";
import {
  verifyTx, planSteps, headerFields, merkleRootFromProof, checkInclusion, txSizes, classifyReason,
  ANCHOR_WINDOW, MIN_ANCHOR_DEPTH,
} from "../src/verify-tx.mjs";

const VKEY_BYTES = new Uint8Array(readFileSync("build/dev/verification_key.json"));
const VKEY = JSON.parse(new TextDecoder().decode(VKEY_BYTES));
const BASE = "https://esplora.invalid/api";
const START = 200000;
const PRICE = 1000n;
const MINT_AMOUNT = 500n;

const dsha = (b) => sha256(sha256(b));
const rev = (b) => Uint8Array.from(b).reverse();
const randTxid = () => randomBytes(32).toString("hex");

/* ---------- a tiny fake chain ---------- */

const idx = new Indexer({ vkey: VKEY, startHeight: START });
const served = new Map(); // txid -> hex
const where = new Map(); // txid -> { height, hash, pos }
const blocks = []; // { height, hash, header, hashes (internal order) }
const overrides = { hex: new Map(), proof: new Map(), header: new Map() };
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
async function mine(txs) {
  const height = idx.height + 1;
  const coinbase = randTxid();
  const ids = [coinbase, ...txs.map((t) => t.txid)];
  const hashes = ids.map((id) => rev(unhex(id)));
  const root = merkleLevels(hashes).at(-1)[0];
  // Regtest-style target (0x207fffff): about half of all nonces work.
  let header;
  for (let nonce = 0; ; nonce++) {
    header = concat(u32le(0x20000000), prevHash, root, u32le(1_700_000_000 + height), u32le(0x207fffff), u32le(nonce));
    if (headerFields(header).meetsTarget) break;
  }
  const hash = hex(rev(dsha(header)));
  prevHash = dsha(header);
  blocks.push({ height, hash, header: hex(header), hashes });
  txs.forEach((t, k) => {
    served.set(t.txid, t.hex);
    where.set(t.txid, { height, hash, pos: k + 1 });
  });
  await idx.applyBlock({ height, hash, txs: [{ txid: coinbase, inputs: [], outputs: [] }, ...txs.map((t) => parseRawTx(t.hex, t.txid))] });
  return hash;
}

function fakeFetch(url) {
  const path = String(url).slice(BASE.length);
  const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const nf = () => new Response("Transaction not found", { status: 404 });
  let m;
  if (path === "/blocks/tip/height") return new Response(String(idx.height));
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/hex$/))) {
    const h = overrides.hex.get(m[1]) ?? served.get(m[1]);
    return h ? new Response(h) : nf();
  }
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/status$/))) {
    const w = where.get(m[1]);
    if (w) return json({ confirmed: true, block_height: w.height, block_hash: w.hash, block_time: 1_700_000_000 });
    return served.has(m[1]) ? json({ confirmed: false }) : nf();
  }
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/merkle-proof$/))) {
    if (overrides.proof.has(m[1])) return json(overrides.proof.get(m[1]));
    return where.has(m[1]) ? json(proofFor(m[1])) : nf();
  }
  if ((m = path.match(/^\/block\/([0-9a-f]{64})\/header$/))) {
    const b = blocks.find((x) => x.hash === m[1]);
    return b ? new Response(overrides.header.get(m[1]) ?? b.header) : nf();
  }
  return nf();
}

/* ---------- transactions ---------- */

const payerKey = randomBytes(32);
const payer = btcAccount(payerKey);
const funderKey = randomBytes(32);
const funder = btcAccount(funderKey);
const TREASURY = btcAccount(randomBytes(32)).script;
const utxo = (value = 100_000) => ({ txid: randTxid(), vout: 0, value });

/** A signed carrier transaction: OP_RETURN envelope, then `outputs`, spending `first` first. */
function carrier(envelope, { outputs = [], first = utxo(), key = payerKey, account = payer } = {}) {
  const { tx } = planCarrierTx({ account, utxos: [first], envelope, outputs, feeRate: 1, firstInput: first });
  const signed = signLocal(tx, key);
  return { hex: signed.hex, txid: signed.txid, vsize: signed.vsize };
}

const alice = new Wallet(deriveKeys(randomBytes(32)));
const bob = new Wallet(deriveKeys(randomBytes(32)));
const T = {}; // named transactions

const realFetch = globalThis.fetch;
const ctx = (over = {}) => ({
  esplora: new Esplora(BASE),
  vkeyBytes: async () => VKEY_BYTES,
  pinnedVkeySha256: hex(sha256(VKEY_BYTES)),
  genesisTxid: null,
  anchorRoot: async (h) => (idx.roots.has(h) ? { root: idx.roots.get(h), source: "YOU", kind: "replay", detail: "from your own replay" } : null),
  assetInfo: async (id) => {
    const a = idx.assets.get(id);
    return a ? { deployTxid: a.deployTxid, ticker: a.ticker } : null;
  },
  indexerVerdict: async (txid) => idx.log.find((l) => l.txid === txid) ?? null,
  ...over,
});
const stepOf = (r, id) => r.steps.find((s) => s.id === id);
const failedAt = (r) => r.steps.find((s) => s.status === "fail")?.id ?? null;

before(async () => {
  globalThis.fetch = async (url) => fakeFetch(url);

  // Block 1: DEPLOY at position 1, so the asset id is (START, 1).
  T.deploy = carrier(encodeDeploy({ ticker: "XRAY", divisibility: 0, mintAmount: MINT_AMOUNT, mintCap: 10, priceSats: PRICE, treasury: TREASURY }));
  await mine([T.deploy]);
  const asset = assetIdOf(START, 1);
  assert.equal(idx.assets.get(asset).ticker, "XRAY");

  // Block 2: a MINT bound to its first input, and a MINT_SCRIPT bound to the payer's script.
  const bindUtxo = utxo();
  const mintEnv = await alice.mint(idx, { asset, mintAmount: MINT_AMOUNT, bindOutpoint: outpointOf(bindUtxo.txid, bindUtxo.vout) });
  T.mint = carrier(mintEnv, { outputs: [{ script: TREASURY, amount: PRICE }], first: bindUtxo });
  // The coin the MINT_SCRIPT spends: the payer's output of a funding transaction (output 0 is its
  // OP_RETURN; L5 puts the change at a random slot after it, so the payment is output 1 or 2).
  T.funding = carrier(new Uint8Array([1, 2, 3]), { outputs: [{ script: payer.script, amount: 50_000n }], key: funderKey, account: funder });
  served.set(T.funding.txid, T.funding.hex);
  idx.prevoutScript = async (op) => parseRawTx(served.get(hex(rev(op.slice(0, 32)))), hex(rev(op.slice(0, 32)))).outputs[op[32]].script;
  const scriptEnv = await alice.mint(idx, { asset, mintAmount: MINT_AMOUNT, bindScriptHash: scriptHashOf(payer.script) });
  const fundingVout = parseRawTx(T.funding.hex, T.funding.txid).outputs.findIndex((o, v) => v > 0 && hex(o.script) === hex(payer.script));
  assert.ok(fundingVout === 1 || fundingVout === 2);
  T.mintScript = carrier(scriptEnv, { outputs: [{ script: TREASURY, amount: PRICE }], first: { txid: T.funding.txid, vout: fundingVout, value: 50_000 } });
  T.mintEnv = mintEnv;
  await mine([T.mint, T.mintScript]);

  // Block 3: a private transfer.
  alice.scan(idx);
  T.transferEnv = await alice.transfer(idx, { asset, amount: 300n, to: bob.address });
  T.transfer = carrier(T.transferEnv);
  await mine([T.transfer]);

  // Block 4: the genesis attestation and a transaction that is not ours.
  T.attest = carrier(encodeAttest({ kind: ATTEST_KIND.GENESIS, hash: MANIFEST_SHA256 }));
  T.plain = carrier(new Uint8Array([0x6f, 0x6b])); // an OP_RETURN without our magic
  await mine([T.attest, T.plain]);

  // Block 5: tampered copies. Each is a real, correctly hashed transaction.
  const cipher = Uint8Array.from(T.transferEnv);
  cipher[160] ^= 0x01; // inside noteCiphertext[0]: extDataHash changes, the proof no longer binds
  T.tamperedCipher = carrier(cipher);
  const badPoint = Uint8Array.from(T.transferEnv);
  badPoint[badPoint.length - 128] |= 0x40; // proof A with the infinity flag set
  T.badPoint = carrier(badPoint);
  T.mintCopy = carrier(mintEnv, { outputs: [{ script: TREASURY, amount: PRICE }] }); // A-6: someone else's coin first
  await mine([T.tamperedCipher, T.badPoint, T.mintCopy]);

  // In the mempool: the transfer's envelope again, in a transaction no block contains yet.
  T.pending = carrier(T.transferEnv);
  served.set(T.pending.txid, T.pending.hex);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test("the copied window constants match the indexer's", () => {
  assert.equal(ANCHOR_WINDOW, IDX_WINDOW);
  assert.equal(MIN_ANCHOR_DEPTH, IDX_MIN_DEPTH);
  assert.equal(hex(sha256(VKEY_BYTES)), ARTIFACT_SHA256.vkey, "the dev key is the pinned key");
});

test("a valid TRANSACT passes every step, each with a source, and agrees with the indexer", async () => {
  const seen = [];
  const r = await verifyTx(T.transfer.txid, ctx({ onStep: (s) => seen.push(s) }));
  assert.equal(r.verdict, "verified", JSON.stringify(r.steps, null, 1));
  assert.equal(r.ok, true);
  assert.deepEqual(r.steps.map((s) => s.id), planSteps("TRANSFER").map((s) => s.id));
  for (const s of r.steps) {
    assert.equal(s.status, "ok", `${s.id}: ${s.detail}`);
    assert.ok(["BTC", "YOU", "IDX"].includes(s.source));
    assert.equal(typeof s.label, "string");
    assert.ok(typeof s.ms === "number" && s.ms >= 0);
  }
  assert.equal(stepOf(r, "root").source, "YOU", "the root came from a local replay");
  assert.match(stepOf(r, "root").detail, /your own replay/);
  assert.match(stepOf(r, "inclusion").detail, /A-9/);
  assert.match(stepOf(r, "groth16").detail, /^valid/);
  assert.equal(r.opName, "TRANSFER");
  assert.ok(r.sizes.vsize > 471, "the carrier is larger than its envelope");
  assert.ok(seen.some((s) => s.id === "groth16" && s.status === "running"), "rows are reported as they start");
});

test("valid MINT and MINT_SCRIPT pass: binding, treasury payment and terms from the deploy tx", async () => {
  const mint = await verifyTx(T.mint.txid, ctx());
  assert.equal(mint.verdict, "verified", JSON.stringify(mint.steps, null, 1));
  assert.deepEqual(mint.steps.map((s) => s.id), planSteps("MINT").map((s) => s.id));
  assert.match(stepOf(mint, "treasury").label, /Treasury paid 1,000 sats/);
  assert.match(stepOf(mint, "terms").detail, /XRAY .* position 1/);
  assert.equal(mint.treasuryPaid, PRICE);

  const script = await verifyTx(T.mintScript.txid, ctx());
  assert.equal(script.verdict, "verified", JSON.stringify(script.steps, null, 1));
  assert.equal(stepOf(script, "bound").label, "Spends from the bound address");
  assert.equal(stepOf(script, "bound").status, "ok");
});

test("valid DEPLOY and genesis ATTEST pass", async () => {
  const d = await verifyTx(T.deploy.txid, ctx());
  assert.equal(d.verdict, "verified", JSON.stringify(d.steps, null, 1));
  assert.deepEqual(d.steps.map((s) => s.id), planSteps("DEPLOY").map((s) => s.id));
  assert.match(stepOf(d, "deploy").detail, /XRAY · 0 decimals · 500 × 10 mints · 1,000 sats each/);

  const a = await verifyTx(T.attest.txid, ctx({ genesisTxid: T.attest.txid }));
  assert.equal(a.verdict, "verified", JSON.stringify(a.steps, null, 1));
  assert.match(stepOf(a, "attest").detail, /this is the genesis transaction pinned in this build/);
  // Anyone may attest another manifest: no authority, but no rule broken either (finding 29).
  const other = await verifyTx(T.attest.txid, ctx({ manifestSha256: "ab".repeat(32) }));
  assert.equal(failedAt(other), null);
  assert.equal(other.verdict, "verified");
  assert.equal(stepOf(other, "attest").label, "Attestation names another manifest");
  assert.match(stepOf(other, "attest").detail, /no authority/);
  assert.equal(other.attest.pinned, false);
});

test("a transaction without an envelope says so", async () => {
  const r = await verifyTx(T.plain.txid, ctx());
  assert.equal(r.verdict, "not-protocol");
  assert.equal(failedAt(r), "envelope");
  assert.equal(stepOf(r, "envelope").detail, "No protocol envelope in this transaction.");
  assert.equal(stepOf(r, "indexer").status, "ok");
});

test("a tampered envelope byte fails the pairing check (extDataHash binds every byte)", async () => {
  const r = await verifyTx(T.tamperedCipher.txid, ctx());
  assert.equal(failedAt(r), "groth16");
  assert.equal(r.verdict, "failed");
  for (const id of ["fetch", "txid", "status", "inclusion", "envelope", "extdata", "points", "vkey", "root"]) assert.equal(stepOf(r, id).status, "ok", id);
  assert.equal(stepOf(r, "indexer").status, "ok", "the indexer rejected it too: they agree");
  // Its nullifiers were already spent by the original, so that is the indexer's first reason.
  assert.match(stepOf(r, "indexer").detail, /Rejected by the indexer .*Agrees with your browser/);
});

test("a bad proof point fails at the point check", async () => {
  const r = await verifyTx(T.badPoint.txid, ctx());
  assert.equal(failedAt(r), "points");
  assert.match(stepOf(r, "points").detail, /infinity/);
  assert.equal(stepOf(r, "groth16").status, "skip");
});

test("A-6: a copied MINT fails the binding check", async () => {
  const r = await verifyTx(T.mintCopy.txid, ctx());
  assert.equal(failedAt(r), "bound");
  assert.match(stepOf(r, "indexer").detail, /not bound/);
});

test("a wrong merkle path fails inclusion", async () => {
  const proof = proofFor(T.transfer.txid);
  proof.merkle[0] = proof.merkle[0].replace(/^./, (c) => (c === "0" ? "1" : "0"));
  overrides.proof.set(T.transfer.txid, proof);
  try {
    const r = await verifyTx(T.transfer.txid, ctx());
    assert.equal(failedAt(r), "inclusion");
    assert.match(stepOf(r, "inclusion").detail, /merkle path does not lead/);
    assert.equal(stepOf(r, "indexer").status, "skip", "bad chain data makes the comparison inconclusive");
  } finally {
    overrides.proof.delete(T.transfer.txid);
  }
  const w = where.get(T.transfer.txid);
  const block = blocks.find((b) => b.height === w.height);
  const header = unhex(block.header);
  header[79] ^= 0xff; // another nonce: the header no longer hashes to the block
  overrides.header.set(w.hash, hex(header));
  try {
    const r = await verifyTx(T.transfer.txid, ctx());
    assert.equal(failedAt(r), "inclusion");
    assert.match(stepOf(r, "inclusion").detail, /hashes to/);
  } finally {
    overrides.header.delete(w.hash);
  }
});

test("bytes of another transaction fail the txid check", async () => {
  overrides.hex.set(T.transfer.txid, T.mint.hex);
  try {
    const r = await verifyTx(T.transfer.txid, ctx());
    assert.equal(failedAt(r), "txid");
    assert.equal(stepOf(r, "envelope").status, "skip");
  } finally {
    overrides.hex.delete(T.transfer.txid);
  }
  const missing = await verifyTx(randTxid(), ctx());
  assert.equal(missing.verdict, "not-found");
  assert.match(stepOf(missing, "fetch").detail, /no transaction with this txid/);
  const junk = await verifyTx("xyz", ctx());
  assert.equal(failedAt(junk), "fetch");
});

test("a verification key that differs from the pin fails before any pairing", async () => {
  let called = false;
  const changed = concat(VKEY_BYTES, new Uint8Array([0x20]));
  const r = await verifyTx(T.transfer.txid, ctx({ vkeyBytes: async () => changed, groth16Verify: async () => (called = true) }));
  assert.equal(failedAt(r), "vkey");
  assert.equal(called, false);
  assert.equal(stepOf(r, "groth16").status, "skip");
});

test("the root's source is explicit, and a rebuild mismatch fails the root step", async () => {
  const idxRoot = await verifyTx(T.transfer.txid, ctx({ anchorRoot: async (h) => ({ root: idx.roots.get(h), source: "IDX", kind: "indexer" }) }));
  assert.equal(idxRoot.verdict, "verified");
  assert.equal(stepOf(idxRoot, "root").source, "IDX");
  assert.match(stepOf(idxRoot, "root").detail, /reported by our indexer/);
  assert.equal(idxRoot.rootSource, "indexer");

  const bad = await verifyTx(T.transfer.txid, ctx({ anchorRoot: async () => ({ root: 1n, source: "YOU", kind: "rebuild", mismatch: true, detail: "your rebuild differs from the indexer's root" }) }));
  assert.equal(failedAt(bad), "root");
  const none = await verifyTx(T.transfer.txid, ctx({ anchorRoot: async () => null }));
  assert.equal(failedAt(none), "root");
});

test("an indexer that disagrees with the browser is called out", async () => {
  const accepted = async (txid) => ({ ...idx.log.find((l) => l.txid === txid), ok: true, reason: undefined });
  const lying = await verifyTx(T.tamperedCipher.txid, ctx({ indexerVerdict: accepted }));
  assert.equal(lying.verdict, "mismatch");
  assert.equal(stepOf(lying, "indexer").status, "fail");
  assert.match(stepOf(lying, "indexer").detail, /Do not trust this indexer/);

  const rejects = async (txid) => ({ ...idx.log.find((l) => l.txid === txid), ok: false, reason: "proof does not verify" });
  const r = await verifyTx(T.transfer.txid, ctx({ indexerVerdict: rejects }));
  assert.equal(r.verdict, "mismatch");

  const spent = async (txid) => ({ ...idx.log.find((l) => l.txid === txid), ok: false, reason: "nullifier already spent" });
  const h = await verifyTx(T.transfer.txid, ctx({ indexerVerdict: spent }));
  assert.equal(h.verdict, "rejected", "history rules are the indexer's call");
  assert.equal(h.ok, true);
});

test("a mempool transaction verifies its proof and waits for a block", async () => {
  const r = await verifyTx(T.pending.txid, ctx());
  assert.equal(r.verdict, "mempool", JSON.stringify(r.steps, null, 1));
  assert.equal(stepOf(r, "status").label, "In mempool");
  assert.equal(stepOf(r, "inclusion").status, "skip");
  assert.equal(stepOf(r, "groth16").status, "ok");
  assert.equal(stepOf(r, "indexer").status, "skip");
});

test("pure helpers: real signet header, merkle path and sizes", () => {
  const raw = readFileSync("test/fixtures/signet-324500.bin");
  const expected = JSON.parse(readFileSync("test/fixtures/signet-324500.json", "utf8"));
  const header = headerFields(raw.subarray(0, 80));
  assert.equal(header.hash, expected.hash);
  assert.equal(header.meetsTarget, true);
  const block = parseBlock(raw);
  const hashes = block.txs.map((t) => rev(unhex(t.txid)));
  const levels = merkleLevels(hashes);
  const pos = block.txs.length - 1;
  const merkle = [];
  let i = pos;
  for (const l of levels.slice(0, -1)) {
    merkle.push(hex(rev(l[i ^ 1] ?? l[i])));
    i = Math.floor(i / 2);
  }
  assert.deepEqual(merkleRootFromProof(block.txs[pos].txid, merkle, pos), header.merkleRoot);
  assert.doesNotThrow(() => checkInclusion({ txid: block.txs[pos].txid, proof: { merkle, pos }, headerHex: hex(raw.subarray(0, 80)), blockHash: expected.hash }));
  assert.throws(() => checkInclusion({ txid: block.txs[pos].txid, proof: { merkle, pos: pos ^ 1 }, headerHex: hex(raw.subarray(0, 80)), blockHash: expected.hash }), /merkle path/);

  const s = txSizes(unhex(T.transfer.hex));
  assert.equal(s.size, T.transfer.hex.length / 2);
  assert.ok(s.base < s.size && s.vsize < s.size, "segwit discount applies");
  assert.equal(s.vsize, T.transfer.vsize, "same vsize as the signer computes");

  assert.equal(classifyReason("proof does not verify"), "checked");
  assert.equal(classifyReason("underpaid: 1 < 1000 sats"), "checked");
  assert.equal(classifyReason("nullifier already spent"), "history");
  assert.equal(classifyReason("mint cap reached"), "history");
  assert.deepEqual(planSteps("ATTEST").map((s) => s.id), ["fetch", "txid", "status", "inclusion", "envelope", "attest", "indexer"]);
  assert.equal(findEnvelope(parseRawTx(T.plain.hex)), null);
});

/* ---------- web/src/verify helpers (pure, node-importable) ---------- */

test("browser rebuild: level-by-level roots equal the incremental MerkleTree", async () => {
  const { rootOfLeaves, rootsAtCounts } = await import("../web/src/verify/rebuild.js");
  const { MerkleTree } = await import("../src/core.mjs");
  const leaves = Array.from({ length: 13 }, (_, i) => BigInt(i * 7919 + 3));
  const tree = new MerkleTree();
  const expected = [tree.root().toString()];
  for (const l of leaves) {
    tree.insert(l);
    expected.push(tree.root().toString());
  }
  assert.equal(rootOfLeaves([]).toString(), expected[0], "empty tree");
  assert.deepEqual(rootsAtCounts(leaves.map(String), [0, 1, 2, 5, 13]), [0, 1, 2, 5, 13].map((n) => expected[n]));
  assert.equal(rootOfLeaves(idx.outputs.map((o) => o.commitment)).toString(), idx.tree.root().toString(), "matches the indexer's tree");
});

test("Verify the Pool: first divergence by binary search, and the diff names the component", async () => {
  const { firstDivergence, diagnose } = await import("../web/src/verify/digest-diff.js");
  const deployTx = (ticker) => ({ txid: randTxid(), inputs: [], outputs: [{ script: opReturnScriptOf(encodeDeploy({ ticker, divisibility: 0, mintAmount: 1n, mintCap: 1, priceSats: 0n, treasury: new Uint8Array() })), value: 0n }] });
  const blocksList = Array.from({ length: 12 }, (_, i) => ({ hash: randTxid(), txs: i % 3 === 0 ? [deployTx(`D${i}`)] : [] }));
  async function replay(tamper) {
    const x = new Indexer({ vkey: VKEY, startHeight: 500 });
    for (const [i, b] of blocksList.entries()) {
      if (i === 7) tamper?.(x);
      await x.applyBlock({ height: 500 + i, hash: b.hash, txs: b.txs });
    }
    return x;
  }
  const honest = await replay();
  const views = (x) => ({
    digestAt: (h) => x.digestAt(h),
    local: { hashAt: (h) => x.hashes.get(h), rootAt: (h) => x.roots.get(h)?.toString(), logAt: (h) => x.log.filter((e) => e.height === h) },
    remote: { digestAt: (h) => ({ blockHash: x.hashes.get(h), root: x.roots.get(h)?.toString() }), logAt: (h) => x.log.filter((e) => e.height === h) },
  });
  const run = async (other) => {
    let calls = 0;
    const first = await firstDivergence({ lo: 500, hi: 511, localAt: (h) => honest.digestAt(h), remoteAt: (h) => (calls++, other.digestAt(h)) });
    const d = first === null ? null : await diagnose({ height: first, local: views(honest).local, remote: views(other).remote });
    return { first, d, calls };
  };

  const same = await run(await replay());
  assert.equal(same.first, null, "identical replays never diverge");

  const extraLeaf = await run(await replay((x) => x.tree.insert(12345n)));
  assert.equal(extraLeaf.first, 507);
  assert.equal(extraLeaf.d.component, "root");
  assert.ok(extraLeaf.calls <= 6, `binary search, not a scan (${extraLeaf.calls} requests)`);

  const extraNullifier = await run(await replay((x) => {
    x.nullifiers.add("99");
    x.nullAcc = sha256(concat(x.nullAcc, new Uint8Array(32).fill(9)));
  }));
  assert.equal(extraNullifier.first, 507);
  assert.equal(extraNullifier.d.component, "nullifiers-or-assets");

  const extraEntry = await run(await replay((x) => x.record({ height: 507, index: 9, txid: randTxid() }, 1, false, { reason: "forged" })));
  assert.equal(extraEntry.first, 507);
  assert.equal(extraEntry.d.component, "log");

  const missing = await diagnose({ height: 600, local: views(honest).local, remote: { digestAt: () => null, logAt: () => [] } });
  assert.equal(missing.component, "missing");
});

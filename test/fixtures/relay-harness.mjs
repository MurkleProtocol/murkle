// Test harness for the paid relayer (docs/design/relay-balance-contract.md §7): a fake esplora
// that never broadcasts anything real and refuses to list addresses, a paid relayer in a
// temporary directory with fresh keys, deposits credited through relayer.credit(), and signed
// submit bodies. Also synthetic TRANSACT envelopes for an indexer that skips Groth16 for them.
//
// The relay modules are re-exported as namespaces (`relayerMod`, `accountMod`, `booksMod`,
// `fundingMod`, `serverMod`) for convenience.
import { mkdtempSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { Indexer, ANCHOR_WINDOW } from "../../src/indexer.mjs";
import { NOTE_CT_LEN } from "../../src/keys.mjs";
import { OP, encodeTxBody, opReturnScript } from "../../src/envelope.mjs";
import { randomField } from "../../src/core.mjs";
import { parseRawTx } from "../../src/btc/block.mjs";
import { concat, hex, unhex, u32le, u64le } from "../../src/bytes.mjs";

export const relayerMod = await import("../../server/relayer.mjs");
export const accountMod = await import("../../src/relay-account.mjs");
export const booksMod = await import("../../server/relay-books.mjs");
export const fundingMod = await import("../../src/btc/funding.mjs");
export const serverMod = await import("../../server/indexer-server.mjs");

export const VKEY = JSON.parse(readFileSync(new URL("../../build/dev/verification_key.json", import.meta.url), "utf8"));
export const silent = { log() {}, warn() {}, error() {} };
export const hash32 = () => randomBytes(32).toString("hex");
export const txOf = (raw) => btc.Transaction.fromRaw(unhex(raw), { allowUnknownOutputs: true });
const NOT_LISTED = "the paid relayer never lists addresses";

const varint = (n) => (n < 0xfd ? new Uint8Array([n]) : concat(new Uint8Array([0xfd]), new Uint8Array([n & 255, n >> 8])));

/** A legacy-serialized transaction with one made-up input, paying `outputs` ([{ script, value }]): hex. */
export function rawPayment(outputs, { input = hash32() } = {}) {
  const parts = [u32le(2), varint(1), unhex(input).reverse(), u32le(randomBytes(4).readUInt32LE(0) >>> 1), varint(0), u32le(0xffffffff), varint(outputs.length)];
  for (const o of outputs) parts.push(u64le(o.value), varint(o.script.length), o.script);
  parts.push(u32le(0));
  return hex(concat(...parts));
}

/**
 * In-memory esplora: transactions by txid (deposits made with pay(), broadcasts), a coin set, a
 * mempool and mined heights. `utxos` throws: the paid relayer never lists an address.
 */
export class FakeEsplora {
  constructor({ fee = 1 } = {}) {
    this.fee = fee;
    this.txs = new Map(); // txid -> raw hex
    this.coins = new Map(); // "txid:vout" -> { value, script }
    this.mempool = new Set();
    this.mined = new Map(); // txid -> height
    this.calls = []; // every broadcast attempt, raw hex
    this.accepted = []; // broadcasts that entered the mempool, in order
    this.failNext = null; // the next broadcast throws this before anything enters the mempool
    this.loseAnswer = null; // the next broadcast enters the mempool, then throws this (a lost answer)
    this.feeError = null;
    this.limits = false; // Bitcoin Core's 25 ancestors / descendants per unconfirmed transaction
    this.utxoCalls = 0;
    this.tip = 0;
    this.requests = []; // [method, txid] of every lookup
    this.spentBy = new Map(); // "txid:vout" -> [spending txid, the coin]
  }
  async utxos() {
    this.utxoCalls += 1;
    throw new Error(NOT_LISTED);
  }
  async feeRate() {
    if (this.feeError) throw this.feeError;
    return this.fee;
  }
  async tipHeight() {
    return this.tip;
  }
  /** A transaction from someone else paying `outputs`; mined at `height` unless it is null. Returns its txid. */
  pay(outputs, { height = null } = {}) {
    const raw = rawPayment(outputs);
    const { txid } = parseRawTx(raw);
    this.txs.set(txid, raw);
    outputs.forEach((o, v) => this.coins.set(`${txid}:${v}`, { value: o.value, script: o.script }));
    if (height === null) this.mempool.add(txid);
    else this.mined.set(txid, height);
    return txid;
  }
  /** The transaction leaves the chain and the mempool (a reorg); its coins are gone. */
  vanish(txid) {
    this.txs.delete(txid);
    this.mempool.delete(txid);
    this.mined.delete(txid);
    for (const k of [...this.coins.keys()]) if (k.startsWith(`${txid}:`)) this.coins.delete(k);
  }
  async broadcast(raw) {
    this.calls.push(raw);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    const tx = txOf(raw);
    // Bitcoin Core 28+ answers a confirmed transaction this way (it was "Transaction already in block chain").
    if (this.mined.has(tx.id)) throw new Error('POST /tx: 400 sendrawtransaction RPC error: {"code":-27,"message":"Transaction outputs already in utxo set"}');
    if (this.mempool.has(tx.id)) throw new Error("sendrawtransaction RPC error: txn-already-in-mempool");
    for (let i = 0; i < tx.inputsLength; i++) {
      if (!this.coins.has(`${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`)) throw new Error("sendrawtransaction RPC error: bad-txns-inputs-missingorspent");
    }
    if (this.limits) this.checkLimits(tx);
    for (let i = 0; i < tx.inputsLength; i++) {
      const key = `${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`;
      this.spentBy.set(key, [tx.id, this.coins.get(key)]);
      this.coins.delete(key);
    }
    for (let v = 0; v < tx.outputsLength; v++) {
      const out = tx.getOutput(v);
      if (out.script[0] === 0x6a) continue; // OP_RETURN
      this.coins.set(`${tx.id}:${v}`, { value: Number(out.amount), script: out.script });
    }
    this.txs.set(tx.id, raw);
    this.mempool.add(tx.id);
    this.accepted.push(raw);
    if (this.loseAnswer) {
      const e = this.loseAnswer;
      this.loseAnswer = null;
      throw e;
    }
    return tx.id;
  }
  ancestors(tx) {
    const seen = new Set();
    const stack = [tx];
    while (stack.length) {
      const t = stack.pop();
      for (let i = 0; i < t.inputsLength; i++) {
        const id = hex(t.getInput(i).txid);
        if (this.mempool.has(id) && !seen.has(id)) {
          seen.add(id);
          stack.push(txOf(this.txs.get(id)));
        }
      }
    }
    return seen;
  }
  checkLimits(tx) {
    const anc = this.ancestors(tx);
    if (anc.size + 1 > 25) throw new Error("sendrawtransaction RPC error: too-long-mempool-chain, too many unconfirmed ancestors [limit: 25]");
    const below = new Map();
    for (const id of this.mempool) for (const a of this.ancestors(txOf(this.txs.get(id)))) below.set(a, (below.get(a) ?? 0) + 1);
    for (const a of anc) if ((below.get(a) ?? 0) + 2 > 25) throw new Error(`sendrawtransaction RPC error: too-long-mempool-chain, too many descendants for tx ${a} [limit: 25]`);
  }
  /**
   * GET /tx/<txid>/status, as mempool.space and electrs answer it: 200 { confirmed: false } for a
   * txid they have never seen, never a 404 (audit V2-15).
   */
  async txStatus(txid) {
    this.requests.push(["status", txid]);
    if (this.mined.has(txid)) return { confirmed: true, block_height: this.mined.get(txid) };
    return { confirmed: false };
  }
  /**
   * GET /tx/<txid>: the only lookup that answers 404 for an unknown txid. The status comes from
   * this.txStatus, so a test that takes txStatus down (an outage) takes this lookup down too.
   */
  async tx(txid) {
    const status = await this.txStatus(txid);
    if (!this.mined.has(txid) && !this.mempool.has(txid)) throw new Error(`GET /tx/${txid}: 404 Transaction not found`);
    return { txid, status };
  }
  async txHex(txid) {
    this.requests.push(["hex", txid]);
    const raw = this.txs.get(txid);
    if (!raw) throw new Error(`GET /tx/${txid}/hex: 404 Transaction not found`);
    return raw;
  }
  async rawTx(txid) {
    const bytes = unhex(await this.txHex(txid));
    parseRawTx(bytes, txid);
    return bytes;
  }
  /** Drops a mempool transaction (evicted): its outputs vanish and its inputs are unspent again. */
  evict(txid) {
    this.mempool.delete(txid);
    for (const k of [...this.coins.keys()]) if (k.startsWith(`${txid}:`)) this.coins.delete(k);
    for (const [k, [by, coin]] of this.spentBy) {
      if (by !== txid) continue;
      this.spentBy.delete(k);
      this.coins.set(k, coin);
    }
  }
  /** Moves mempool transactions into a block at `height`. */
  confirm(txids, height) {
    for (const txid of txids) {
      if (!this.mempool.has(txid)) continue;
      this.mempool.delete(txid);
      this.mined.set(txid, height);
    }
    this.tip = Math.max(this.tip, height);
  }
  /** Everything in the mempool, mined at `height`, as indexer block transactions. */
  mine(height) {
    const txs = [...this.mempool].map((id) => parseRawTx(this.txs.get(id)));
    this.confirm(txs.map((t) => t.txid), height);
    return txs;
  }
  /** Carriers (TRANSACT OP_RETURN outputs) in broadcast order. */
  carriers() {
    return this.accepted.map(txOf).filter((tx) => tx.getOutput(0).script[0] === 0x6a);
  }
}
export const makeFakeEsplora = (opts) => new FakeEsplora(opts);

/**
 * A paid relayer in a fresh temporary directory: new pool and change keys under
 * `<dir>/relay-balance`, the retired v1 files at `<dir>/relayer.key` and `<dir>/relayer.json`
 * (absent unless the test writes them). Not ticked yet. `relayer.harnessDir` is the directory.
 */
export async function makePaidRelayer({ idx, esplora, config = {}, dir = mkdtempSync(join(tmpdir(), "murkle-paid-")), log = silent, now, fastDelayMs = () => 60_000 } = {}) {
  const cfg = {
    enabled: true, relayMode: "balance", relayDir: "relay-balance", keyPath: "relayer.key", statePath: "relayer.json", fanoutTarget: 0, minMix: 0, ...config,
  };
  const relayer = await relayerMod.startPaidRelayer({ idx, esplora, config: cfg, root: dir, log, now, fastDelayMs });
  relayer.harnessDir = dir;
  return relayer;
}

/** A fresh relay account (BIP340 key from a random 32-byte seed). */
export const newAccount = (network = "signet") => accountMod.relayAccount(new Uint8Array(randomBytes(32)), network);

const anyIp = () => `198.19.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;

/**
 * Pays `sats` to deposit address `n` of `account` (mined at the relayer's tip: 1 confirmation)
 * and credits it through relayer.credit(). Returns { status, body, txid, outpoint, n }.
 */
export async function fundAccount({ relayer, esplora, account, sats = 7000, n, ip = anyIp(), height = relayer.topHeight() }) {
  const index = n ?? relayer.books.account(account.idHex).nextIndex;
  const dep = accountMod.depositAddress(relayer.Q, account.id, index, "signet");
  const txid = esplora.pay([{ script: dep.script, value: sats }], { height });
  const outpoint = `${txid}:0`;
  const out = await relayer.credit(JSON.stringify({ outpoint, accountPub: account.pubHex, n: index }), ip);
  return { ...out, txid, outpoint, n: index };
}

/** The fee of a merge of one deposit on its own at the relayer's current fee rate (maybeMerge). */
export const mergeFee = (relayer) => Math.ceil(relayer.cache.feeRate * Math.ceil(11 + 57.5 + 43));

/**
 * Pool coins at C of exactly `values` sats, as a relayer holds them: carriers never spend a
 * deposit, so each is a credited deposit of value + mergeFee to `account`, merged on its own
 * (maybeMerge) and, unless `confirmed` is false, mined and followed. Returns
 * { account, outpoints, merges } (outpoints are the C coins, merges their ledger entries).
 */
export async function poolCoins({ relayer, esplora, values, account = newAccount(), confirmed = true, height = relayer.topHeight() }) {
  if (relayer.cache.feeRate === null) await relayer.refreshCache();
  const outpoints = [];
  const merges = [];
  for (const v of values) {
    const f = await fundAccount({ relayer, esplora, account, sats: v + mergeFee(relayer), height });
    if (f.status !== 200) throw new Error(JSON.stringify(f.body));
    relayer.state.coins[f.outpoint].creditedAt = -1; // merged at once, not after the next block
    const before = relayer.state.ledger.length;
    await relayer.maybeMerge();
    const entry = relayer.state.ledger[before];
    if (entry?.kind !== "merge" || relayer.state.coins[`${entry.txid}:0`]?.value !== v) throw new Error("poolCoins: the deposit was not merged");
    outpoints.push(`${entry.txid}:0`);
    merges.push(entry);
    if (confirmed) esplora.confirm([entry.txid], height);
  }
  if (confirmed) {
    await relayer.reconcileFanouts();
    await relayer.followCoins();
  }
  return { account, outpoints, merges };
}

/** A signed submit body (JSON text) for `envelope` (bytes or hex) in `mode`, as a wallet sends it. */
export function signedSubmit(account, info, envelope, mode = "block", { now } = {}) {
  const env = typeof envelope === "string" ? envelope : hex(envelope);
  return JSON.stringify(accountMod.signRequest({
    account, endpoint: "/api/relay/submit", network: info.network, poolKey: info.balance.poolKey, fields: { envelope: env, mode }, ...(now ? { now } : {}),
  }));
}

/** A signed account read body (JSON text). */
export function signedAccount(account, info, { now } = {}) {
  return JSON.stringify(accountMod.signRequest({ account, endpoint: "/api/relay/account", network: info.network, poolKey: info.balance.poolKey, ...(now ? { now } : {}) }));
}

// ---------------------------------------------------------------- synthetic chain

/** First nullifier of a synthetic envelope -> the root its "proof" holds against. */
export const SYNTH = new Map();

/** The real indexer, except that synthetic envelopes skip Groth16 (every other rule still applies). */
export class TestIndexer extends Indexer {
  constructor(opts) {
    super({ vkey: VKEY, genesis: null, ...opts });
    this.proofChecks = 0;
  }
  async checkTx(env, tx, height) {
    this.proofChecks += 1;
    const bound = env.op === OP.TRANSACT ? SYNTH.get(String(env.nullifiers[0])) : undefined;
    if (bound === undefined) return super.checkTx(env, tx, height);
    if (env.publicAmount !== 0n || env.publicAsset !== 0n) return "TRANSACT must not move public value";
    if (env.anchor < height - ANCHOR_WINDOW || env.anchor > height - 1) return "anchor outside window";
    const root = this.roots.get(env.anchor);
    if (root === undefined) return "unknown anchor";
    const [n0, n1] = env.nullifiers.map(String);
    if (n0 === n1) return "duplicate nullifier in envelope";
    if (this.nullifiers.has(n0) || this.nullifiers.has(n1)) return "nullifier already spent";
    return String(root) === bound ? true : "proof does not verify";
  }
}

/** A TRANSACT envelope with fresh nullifiers, anchored at `anchor`, "valid" against R[anchor] only (or never, with bad). */
export function synth(idx, anchor = idx.height, { bad = false } = {}) {
  const nullifiers = [randomField(), randomField()];
  const body = encodeTxBody({
    op: OP.TRANSACT, anchor, nullifiers, commitments: [randomField(), randomField()],
    ciphertexts: [randomBytes(NOTE_CT_LEN), randomBytes(NOTE_CT_LEN)],
  });
  SYNTH.set(String(nullifiers[0]), bad ? "never" : String(idx.roots.get(anchor)));
  return concat(body, new Uint8Array(randomBytes(128)));
}

/** An indexer-form transaction carrying `envelope` (a user's own carrier, not a Bitcoin transaction). */
export const ownCarrier = (envelope, first = randomBytes(36)) => ({ txid: hash32(), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(envelope), value: 0n }] });

/**
 * A synthetic chain: `mine(txs)` applies one block (coinbase plus txs) and confirms them in every
 * fake in `fakes`; `mineCarriers(esplora)` mines what that esplora has in its mempool.
 */
export function chain({ start = 900_000, fakes = [] } = {}) {
  const idx = new TestIndexer({ startHeight: start });
  const mine = async (txs = []) => {
    const height = idx.height + 1;
    await idx.applyBlock({ height, hash: hash32(), txs: [{ txid: hash32(), inputs: [], outputs: [] }, ...txs] });
    for (const f of fakes) {
      f.confirm(txs.map((t) => t.txid), height);
      f.tip = Math.max(f.tip, height);
    }
    return height;
  };
  const mineCarriers = async (esplora) => {
    const height = idx.height + 1;
    const txs = [...esplora.mempool].map((id) => parseRawTx(esplora.txs.get(id)));
    return mine(txs).then((h) => (esplora.confirm(txs.map((t) => t.txid), h), h));
  };
  return { idx, fakes, mine, mineCarriers };
}

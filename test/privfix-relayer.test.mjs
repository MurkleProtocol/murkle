// Privacy fixes of the paid relayer after the signet trace test (docs/design/privacy-trace-test.md):
//
//   L1  pool lineage: no deposit is merged alone; merges take a pool coin of other accounts; a
//       carrier spends only a coin descending from minMix + 1 accounts, the same rule whoever
//       sends (so a carrier never says its sender is outside its coin's lineage); the merge the
//       published cover counts on is the merge that is signed; a thin pool answers 409 pool_thin
//       unless the signed request says linkable; /api/relay/info publishes balance.mix =
//       { k, coverOk, depositors } (coverOk false when k is 0).
//  L2  the relayer's files: a settled item keeps no cost, submit height, mode or anchor; the
//       books keep accounts under an opaque key, never the account id; a credit whose deposit
//       has left the pool is settled (no account on it) once wallets stop warning about it, so
//       credits − Σ costs = balance can no longer be formed, even with each carrier's cost
//       recomputed from its public fee; a state saved before this loads keyed; the retired v1
//       relayer.json is pruned of envelopes and nullifiers (in memory, and once at startup).
//  L5  relayer-built transactions: RBF on every input, one fee rule, random merge input order
//       and change slots; the OP_RETURN stays output 0.
//
// Fakes only (FakeEsplora, synthetic blocks, synthetic envelopes, temporary directories). Nothing
// is broadcast for real, and data/signet/ is only read (a copy is pruned, never the original).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import {
  accountMod, booksMod, chain, fundAccount, makeFakeEsplora, makePaidRelayer, newAccount, relayerMod, serverMod, signedSubmit, silent, synth, txOf,
} from "./fixtures/relay-harness.mjs";
import { hex, unhex } from "../src/bytes.mjs";
import { opReturnScript } from "../src/envelope.mjs";

const { ERROR_STATUS, MESSAGES, MISSED_REASON, RBF_SEQUENCE, feeAt, persistedItem, submitDigest, unionMix, withChangeAt, DEFAULTS, NETWORK_DEFAULTS, readConfig } = relayerMod;
const { costFor } = booksMod;
const { pruneV1File } = serverMod;
const { loadV1State, pruneV1State, v1NeedsPrune, v1Status, planSweep } = await import("../server/retired-relay.mjs");

const DIR = mkdtempSync(join(tmpdir(), "murkle-privfix-relayer-"));
const relayers = [];
after(() => {
  relayers.forEach((r) => r.close());
  rmSync(DIR, { recursive: true, force: true });
});
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
// The live files are only ever read here (and copied); they must come out of this file untouched.
const LIVE = ["data/signet/relayer.json", "data/signet/relay-balance/relayer.json"].filter((p) => existsSync(p));
const liveBefore = new Map(LIVE.map((p) => [p, statSync(p).mtimeMs]));
after(() => {
  // The live paid relayer may rewrite its own file meanwhile; the v1 file nobody writes.
  if (liveBefore.has("data/signet/relayer.json")) assert.equal(statSync("data/signet/relayer.json").mtimeMs, liveBefore.get("data/signet/relayer.json"), "data/signet/relayer.json untouched");
});

const anyIp = () => `198.51.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;
const code = (out) => out.body?.error?.code;

/** A chain, a fake esplora and a paid relayer after its first tick (minMix 3 unless given). */
async function world({ config = {}, fee = 1, start = 870_000 } = {}) {
  const esplora = makeFakeEsplora({ fee });
  const c = chain({ start, fakes: [esplora] });
  await c.mine();
  const r = await makePaidRelayer({ idx: c.idx, esplora, config: { minMix: 3, ...config } });
  relayers.push(r);
  const tick = (rr = r) => rr.onTick({ chainTip: c.idx.height });
  await tick();
  const owners = new Map(); // deposit txid -> account label (the test's own record, not the relayer's)
  const deposits = []; // { label, account, outpoint, value }: the test's own record
  return {
    esplora, c, idx: c.idx, r, tick, owners,
    step: async () => {
      await c.mine();
      await tick();
    },
    land: async () => {
      await c.mineCarriers(esplora);
      await tick();
    },
    deposits,
    fund: async (label, account = newAccount(), sats = 7000) => {
      const f = await fundAccount({ relayer: r, esplora, account, sats, ip: anyIp() });
      assert.equal(f.status, 200, JSON.stringify(f.body));
      owners.set(f.txid, label);
      deposits.push({ label, account, outpoint: f.outpoint, value: sats });
      return account;
    },
  };
}

/** A signed submit body that carries `linkable` (a boolean), signed over every field but sig. */
function linkableSubmit(account, info, envelope, mode, linkable, { signedAs = linkable } = {}) {
  const fields = { envelope: typeof envelope === "string" ? envelope : hex(envelope), mode, linkable: signedAs, accountPub: account.pubHex, t: Math.floor(Date.now() / 1000) };
  const sig = hex(schnorr.sign(submitDigest(unhex(info.balance.poolKey), fields), account.secret));
  return JSON.stringify({ ...fields, linkable, sig });
}

/**
 * The depositing accounts a relayer transaction's inputs descend from, read from the chain alone
 * (the fake esplora's raw transactions) and the test's own record of who paid which deposit.
 */
function chainLineage(w, txid, seen = new Set()) {
  const out = new Set();
  const tx = txOf(w.esplora.txs.get(txid));
  for (let i = 0; i < tx.inputsLength; i++) {
    const parent = hex(tx.getInput(i).txid);
    if (w.owners.has(parent)) out.add(w.owners.get(parent));
    else if (w.esplora.txs.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      for (const o of chainLineage(w, parent, seen)) out.add(o);
    }
  }
  return out;
}
const relayerTxs = (w) => w.esplora.accepted.map(txOf);
const carriersOf = (w) => relayerTxs(w).filter((tx) => tx.getOutput(0).script[0] === 0x6a);
const mergesOf = (w) => w.r.state.ledger.filter((l) => l.kind === "merge").map((l) => txOf(w.esplora.txs.get(l.txid)));

/* ------------------------------------------------------------------ L1: lineage and cover */

test("L1 config: minMix defaults to 3 on signet and 5 on mainnet, MURKLE_RELAY_MIN_MIX overrides it, 0..32 only", () => {
  assert.equal(NETWORK_DEFAULTS.signet.minMix, 3);
  assert.equal(NETWORK_DEFAULTS.mainnet.minMix, 5);
  assert.equal(DEFAULTS.minMix, 3, "this checkout runs signet");
  assert.equal(readConfig((n) => ({ RELAY_MIN_MIX: "7" })[n]).config.minMix, 7);
  assert.equal(relayerMod.balanceProblems({ ...DEFAULTS, minMix: 33 }).some((p) => /MURKLE_RELAY_MIN_MIX/.test(p)), true);
  assert.deepEqual(relayerMod.balanceProblems({ ...DEFAULTS, minMix: 0 }), []);
  assert.equal(ERROR_STATUS.pool_thin, 409);
  assert.match(MESSAGES.pool_thin, /tie it to your top-up address/);
  assert.match(MESSAGES.pool_thin, /Pay the fee yourself, or confirm to send it linkable\.$/);
  assert.match(MISSED_REASON.pool_thin, /nothing was charged$/);
  for (const text of [MESSAGES.pool_thin, MISSED_REASON.pool_thin]) assert.doesNotMatch(text, /anonymous|untraceable|trustless|mixer/i);
});

test("L1 a lone depositor: no 1-in-1-out merge, info says the pool is thin, a plain submit answers 409 pool_thin and reserves nothing", async () => {
  const w = await world();
  const a = await w.fund("A");
  await w.step();
  await w.step();
  assert.equal(w.r.state.ledger.filter((l) => l.kind === "merge").length, 0, "a lone account's deposit waits for company");
  assert.deepEqual(w.r.info().balance.mix, { k: 3, coverOk: false, depositors: 1 });
  const before = w.r.books.account(a.idHex);
  const out = await w.r.submit(signedSubmit(a, w.r.info(), synth(w.idx), "block"), anyIp());
  assert.equal(out.status, 409);
  assert.equal(code(out), "pool_thin");
  assert.equal(out.body.error.message, MESSAGES.pool_thin);
  assert.deepEqual([out.body.error.k, out.body.error.depositors], [3, 1]);
  assert.deepEqual(w.r.books.account(a.idHex), before, "nothing reserved or charged");
  assert.equal(Object.keys(w.r.state.items).length, 0);
  // An explicit linkable: false is the same as no field.
  const no = await w.r.submit(linkableSubmit(a, w.r.info(), synth(w.idx), "block", false), anyIp());
  assert.equal(code(no), "pool_thin");
});

test("L1 linkable: only a signed boolean counts; a thin pool then carries the send on the widest coin and says so", async () => {
  const w = await world();
  const a = await w.fund("A");
  await w.step();
  const info = w.r.info();
  // Tampered: the body says true, the signature covers false.
  const forged = await w.r.submit(linkableSubmit(a, info, synth(w.idx), "block", true, { signedAs: false }), anyIp());
  assert.equal(code(forged), "bad_signature");
  // Not a boolean: malformed.
  const body = JSON.parse(linkableSubmit(a, info, synth(w.idx), "block", true));
  const str = await w.r.submit(JSON.stringify({ ...body, linkable: "yes" }), anyIp());
  assert.equal(code(str), "malformed");
  const ok = await w.r.submit(linkableSubmit(a, info, synth(w.idx), "block", true), anyIp());
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.linkable, ok.body.thin], [true, true]);
  assert.equal(w.r.status(ok.body.id).linkable, true, "the queued status says it is linkable");
  await w.step();
  assert.equal(w.r.status(ok.body.id).status, "broadcast", "a queued linkable send has no coin without the lone merge, so it merges and goes");
  const [carrier] = carriersOf(w);
  assert.deepEqual([...chainLineage(w, carrier.id)], ["A"], "and its input does descend from A alone: the user was told");
});

test("L1 merges never take a deposit alone and fold in pool coins of other accounts; each carrier's input then descends from minMix accounts other than its sender", async () => {
  const w = await world();
  const accounts = {};
  for (const label of ["A", "B"]) accounts[label] = await w.fund(label);
  await w.step(); // the deposits of A and B merge together (two accounts)
  await w.land();
  for (const label of ["C", "D", "E"]) {
    accounts[label] = await w.fund(label);
    await w.step(); // C's deposit merges with the pool coin of A and B, and so on
    await w.land();
  }
  const merges = mergesOf(w);
  assert.ok(merges.length >= 4, `merges: ${merges.length}`);
  for (const m of merges) {
    assert.ok(m.inputsLength >= 2, "no merge spends one input to one output");
    assert.ok(chainLineage(w, m.id).size >= 2, "every merge mixes at least two accounts");
  }
  const later = merges.slice(1);
  assert.ok(later.every((m) => Array.from({ length: m.inputsLength }, (_, i) => hex(m.getInput(i).txid)).some((t) => !w.owners.has(t))), "each later merge also spends a pool coin");
  assert.deepEqual(w.r.info().balance.mix, { k: 3, coverOk: true, depositors: 5 });

  // Every account can now send without consenting to a linkable send.
  const sent = [];
  for (const [label, acct] of Object.entries(accounts)) {
    const out = await w.r.submit(signedSubmit(acct, w.r.info(), synth(w.idx), "block"), anyIp());
    assert.equal(out.status, 202, `${label}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.thin, undefined, "not thin");
    sent.push([label, out.body.id]);
  }
  await w.step();
  for (const [label, id] of sent) {
    const item = w.r.state.items[id];
    assert.equal(item.status, "broadcast", label);
    const others = [...chainLineage(w, item.txid)].filter((x) => x !== label);
    assert.ok(others.length >= 3, `${label}'s carrier descends from ${others.length} other accounts (chain view)`);
  }
  // The relayer's own bookkeeping agrees with the chain: the change of every carrier keeps the lineage.
  for (const tx of carriersOf(w)) {
    const coin = w.r.state.coins[`${tx.id}:1`];
    assert.ok(coin, "the carrier's change is in the coin set");
    assert.equal(coin.mix.length, chainLineage(w, tx.id).size, "the recorded lineage counts exactly the accounts the chain shows");
  }
});

test("L1 a non-linkable item whose cover is gone at release is missed (pool_thin), nothing charged; a linkable one takes the widest coin", async () => {
  const w = await world();
  const accounts = {};
  for (const label of ["A", "B", "C", "D"]) accounts[label] = await w.fund(label);
  await w.step();
  await w.land();
  const A = accounts.A;
  const out = await w.r.submit(signedSubmit(A, w.r.info(), synth(w.idx), "block"), anyIp());
  assert.equal(out.status, 202, JSON.stringify(out.body));
  const balance = w.r.books.account(A.idHex);
  // Every coin loses its recorded lineage (as a coin made before lineage was tracked): no cover.
  for (const c of Object.values(w.r.state.coins)) if (c.kind === "change") c.mix = [];
  await w.step();
  const st = w.r.status(out.body.id);
  assert.deepEqual([st.status, st.code], ["missed", "pool_thin"]);
  assert.equal(st.reason, MISSED_REASON.pool_thin);
  const after = w.r.books.account(A.idHex);
  assert.equal(after.balance, balance.balance + balance.reserved, "the reservation went back: nothing charged");
  // The same send, linkable: it goes on the widest coin there is.
  const ok = await w.r.submit(linkableSubmit(A, w.r.info(), synth(w.idx), "block", true), anyIp());
  assert.equal(ok.status, 202, JSON.stringify(ok.body));
  assert.equal(ok.body.thin, true);
  await w.step();
  assert.equal(w.r.status(ok.body.id).status, "broadcast");
});

test("L1 lineage tags are opaque: no account id is ever stored on a coin, and the union is capped and sorted", async () => {
  const w = await world();
  const ids = [];
  for (const label of ["A", "B", "C"]) ids.push((await w.fund(label)).idHex);
  await w.step();
  const text = readFileSync(w.r.config.statePath, "utf8");
  const saved = JSON.parse(text);
  const coinText = JSON.stringify(saved.coins);
  for (const id of ids) assert.equal(coinText.includes(id), false, "no account id next to a coin");
  const merged = Object.values(saved.coins).find((c) => c.kind === "change");
  assert.equal(merged.mix.length, 3);
  assert.ok(merged.mix.every((t) => /^[0-9a-f]{16}$/.test(t)));
  const many = Array.from({ length: 100 }, (_, i) => i.toString(16).padStart(16, "0"));
  assert.equal(unionMix([many, many.slice(0, 10)]).length, 64);
  assert.deepEqual(unionMix([["b", "a"], ["a", "c"]]), ["a", "b", "c"]);
});

/**
 * The relayer's own lineage of the coin a relayer transaction spends (state.coins is kept until
 * 6 confirmations after the spend; the coin's tags may already be dropped, so the chain view is
 * the reference) and the accounts the test knows funded it.
 */
const spentCoinOf = (w, txid) => {
  const tx = txOf(w.esplora.txs.get(txid));
  return `${hex(tx.getInput(0).txid)}:${tx.getInput(0).index}`;
};

test("L1 the cover rule is the same for every sender: a coin of exactly k accounts carries nobody's send, k + 1 carries everyone's, members and outsiders alike", async () => {
  const w = await world(); // k = 3
  const acct = {};
  for (const label of ["B", "C", "D"]) acct[label] = await w.fund(label);
  await w.step(); // B, C and D merge into one coin: lineage {B, C, D}, exactly k accounts
  await w.land();
  acct.A = await w.fund("A"); // credited this block: it merges at the next tick, not now
  assert.deepEqual(w.r.info().balance.mix, { k: 3, coverOk: false, depositors: 4 }, "k accounts are not cover: a member would have only k - 1 others");
  // The review's case: before, A (outside {B, C, D}) got 202 while B, C and D got 409, so a carrier
  // spending that coin named its sender as the one depositor outside it. Now all four get the same answer.
  for (const label of ["A", "B", "C", "D"]) {
    const out = await w.r.submit(signedSubmit(acct[label], w.r.info(), synth(w.idx), "block"), anyIp());
    assert.deepEqual([out.status, code(out)], [409, "pool_thin"], label);
  }
  assert.equal(Object.keys(w.r.state.items).length, 0, "nothing was queued for anyone");
  await w.step(); // A's deposit merges with the {B, C, D} coin: {A, B, C, D}, k + 1 accounts
  await w.land();
  assert.deepEqual(w.r.info().balance.mix, { k: 3, coverOk: true, depositors: 4 });
  // E tops up and sends before its own deposit merges (the margin pays no merge this block): E is
  // outside the coin's lineage, B is inside it.
  acct.E = await w.fund("E");
  const mergeRoom = w.r.mergeRoom;
  w.r.mergeRoom = () => 0;
  const sent = [];
  for (const label of ["E", "B"]) {
    const out = await w.r.submit(signedSubmit(acct[label], w.r.info(), synth(w.idx), "block"), anyIp());
    assert.equal(out.status, 202, `${label}: ${JSON.stringify(out.body)}`);
    assert.equal(out.body.thin, undefined);
    sent.push([label, out.body.id]);
  }
  await w.step();
  w.r.mergeRoom = mergeRoom;
  await w.land();
  const lineages = [];
  for (const [label, id] of sent) {
    const item = w.r.state.items[id];
    assert.equal(item.status, "accepted", label);
    const lineage = chainLineage(w, item.txid);
    lineages.push([label, lineage]);
    assert.ok(lineage.size >= 4, `${label}'s carrier spends a coin of at least k + 1 accounts (${[...lineage]})`);
  }
  // The outsider's carrier and the member's carrier spend coins of the same lineage: whether the
  // sender is in it says nothing, because both were eligible under one rule.
  const [[, ofE], [, ofB]] = lineages;
  assert.equal(ofE.has("E"), false, "E's carrier does not descend from E");
  assert.equal(ofB.has("B"), true, "B's carrier descends from B too");
  assert.deepEqual([...ofE].sort(), [...ofB].sort(), "and both descend from the same accounts");
  // Every carrier spent a coin the relayer counted as cover for any sender (k + 1 or more tags when spent).
  for (const tx of carriersOf(w)) assert.ok(chainLineage(w, tx.id).size >= 4);
  // Once a spender confirms, the spent coin keeps no tags (only unspent coins need a lineage).
  await w.step();
  const confirmed = new Set(w.r.state.ledger.filter((l) => l.height != null).map((l) => l.txid));
  let dropped = 0;
  for (const c of Object.values(w.r.state.coins)) {
    if (c.status !== "spent" || !confirmed.has(c.spentBy)) continue;
    assert.equal(c.mix, undefined, "a spent coin's lineage is dropped once its spender is in a block");
    dropped += 1;
  }
  assert.ok(dropped >= 1, "some spent coin was checked");
  for (const c of Object.values(w.r.state.coins)) if (c.kind === "change" && c.status === "unspent" && c.confirmed) assert.ok(Array.isArray(c.mix), "unspent coins keep theirs");
});

test("L1 the merge fundingCoins counts on is the merge maybeMerge signs: the same deposits and lineage, never every waiting deposit's accounts", async () => {
  const w = await world(); // k = 3
  for (const label of ["B", "C", "D", "E"]) await w.fund(label);
  // The margin pays for two merge inputs only (as when deposits are small and fees high).
  w.r.mergeRoom = (available, rate, extra = 0) => Math.max(0, Math.min(available, 2 - extra));
  const virtual = w.r.fundingCoins().find((u) => u.key === "(merge)");
  assert.ok(virtual, "a merge can go");
  assert.equal(virtual.mix.length, 2, "its lineage is the two deposits it can take, not all four accounts");
  assert.deepEqual(w.r.info().balance.mix, { k: 3, coverOk: false, depositors: 4 }, "two accounts are no cover, so nothing is promised");
  const A = await w.fund("A");
  const out = await w.r.submit(signedSubmit(A, w.r.info(), synth(w.idx), "block"), anyIp());
  assert.deepEqual([out.status, code(out)], [409, "pool_thin"], "a plain send is refused before anything is queued");
  const before = w.r.mergePlan(w.r.spendableCoins());
  await w.step();
  const merges = w.r.state.ledger.filter((l) => l.kind === "merge");
  assert.equal(merges.length, 1);
  const tx = txOf(w.esplora.txs.get(merges[0].txid));
  const spent = Array.from({ length: tx.inputsLength }, (_, i) => `${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`).sort();
  assert.deepEqual(spent, before.inputs.map((u) => u.key).sort(), "the merge spends exactly the planned coins");
  assert.deepEqual(w.r.state.coins[`${merges[0].txid}:0`].mix, before.mix, "and its output has the planned lineage");
  // The plan is deterministic: asked twice, the same answer (the published cover cannot flicker).
  const again = [w.r.mergePlan(), w.r.mergePlan()].map((p) => JSON.stringify(p && { inputs: p.inputs.map((u) => u.key), mix: p.mix }));
  assert.equal(again[0], again[1]);
});

/* ---------------------------------------------------------------------- L2: the files */

const SETTLED_FORBIDDEN = ["cost", "acceptedHeight", "mode", "releaseAt", "lastRelease", "reservation", "account", "envelope", "root", "outpoint", "attempts", "linkable", "vsize", "feeRate", "refHash", "powHash", "serviceOutputs"];

/**
 * The insider's attack on the relayer's files (privacy-trace-test.md L2, as the review ran it):
 * each carrier's charge is recomputed from its fee, which the saved ledger and the public chain
 * both show (costFor(fee) + service fees: the charge is a function of the fee, so dropping the
 * saved `cost` alone hides nothing); each account's debit is Σ its credits − balance −
 * reserved; then every subset of carriers whose charges add up to a debit is listed.
 * `credits` / `accounts` default to the saved books. -> Map(account -> [carrier txid sets])
 */
function attributeByFees(saved, { credits = saved.books.credits, accounts = saved.books.accounts } = {}) {
  const sums = new Map();
  for (const c of Object.values(credits)) {
    if (c.reversed || typeof c.id !== "string" || !Number.isSafeInteger(c.amount)) continue; // a settled credit names nobody
    sums.set(c.id, (sums.get(c.id) ?? 0) + c.amount);
  }
  const debits = new Map();
  for (const [id, total] of sums) if (accounts[id]) debits.set(id, total - accounts[id].balance - accounts[id].reserved);
  const carriers = saved.ledger.filter((l) => l.kind === "carrier" && l.outcome !== "dropped").map((l) => [l.txid, costFor(l.fee) + (l.serviceSats ?? 0)]);
  const found = new Map();
  for (const [id, d] of debits) {
    if (!(d > 0)) continue;
    for (let mask = 1; mask < 1 << carriers.length; mask++) {
      let sum = 0;
      for (let k = 0; k < carriers.length; k++) if (mask & (1 << k)) sum += carriers[k][1];
      if (sum === d) found.set(id, [...(found.get(id) ?? []), carriers.filter((_, k) => mask & (1 << k)).map(([t]) => t).sort()]);
    }
  }
  return found;
}

/** The insider's timing attack: a carrier submitted before an account's first credit is not that account's. */
function excludedByHeight(saved) {
  const first = new Map();
  for (const c of Object.values(saved.books.credits)) if (c.height != null) first.set(c.id, Math.min(first.get(c.id) ?? Infinity, c.height));
  let excluded = 0;
  for (const item of Object.values(saved.items)) {
    if (!Number.isSafeInteger(item.acceptedHeight)) continue;
    for (const h of first.values()) if (item.acceptedHeight < h) excluded += 1;
  }
  return excluded;
}

test("L2 a settled item is saved without cost, submit height, mode or anchor: the insider's sums and timing find nothing; a restart still answers its status", async () => {
  const w = await world({ config: { minMix: 0 } });
  const A = await w.fund("A");
  await w.step();
  const outA = await w.r.submit(signedSubmit(A, w.r.info(), synth(w.idx), "block"), anyIp());
  assert.equal(outA.status, 202);
  await w.step(); // A's carrier goes out
  const B = await w.fund("B", newAccount(), 9000); // B tops up only after A's submit
  await w.step();
  const S = w.idx.height - (w.idx.height % 6) + 6;
  while (w.idx.height < S) await w.step();
  const outB = await w.r.submit(signedSubmit(B, w.r.info(), synth(w.idx, S), "batch"), anyIp());
  assert.equal(outB.status, 202, JSON.stringify(outB.body));
  while (w.r.state.items[outB.body.id].status === "queued") await w.step();
  await w.land();
  // In memory the wallet's status answer still has the cost (until a restart).
  assert.equal(w.r.status(outA.body.id).cost, costFor(598));

  const saved = JSON.parse(readFileSync(w.r.config.statePath, "utf8"));
  for (const id of [outA.body.id, outB.body.id]) {
    const item = saved.items[id];
    assert.equal(item.status, "accepted");
    for (const k of SETTLED_FORBIDDEN) assert.equal(Object.hasOwn(item, k), false, `${k} is not saved for a settled item`);
  }
  assert.deepEqual([saved.books.reservations, saved.books.charges], [{}, {}], "no per-item record in the books");
  assert.equal(excludedByHeight(saved), 0, "no submit height to compare with credit heights");
  // The same attack on the old shape (the in-memory items as the old save() wrote them) did rule accounts out.
  const oldShape = { ...saved, items: JSON.parse(JSON.stringify(w.r.state.items)) };
  assert.ok(excludedByHeight(oldShape) >= 1, "submit heights ruled accounts out");

  // Once the carriers are 6 deep (raw bytes gone), nothing but the status answer is left.
  for (let i = 0; i < 6; i++) await w.step();
  const later = JSON.parse(readFileSync(w.r.config.statePath, "utf8"));
  for (const id of [outA.body.id, outB.body.id]) {
    assert.deepEqual(Object.keys(later.items[id]).sort().filter((k) => !["id", "status", "kind", "txid", "height", "broadcastHeight", "ledgerSeq", "finalHeight", "reason", "code"].includes(k)), []);
  }
  // A restart answers every id from what is left.
  const R2 = await makePaidRelayer({ idx: w.idx, esplora: w.esplora, dir: w.r.harnessDir, config: { minMix: 0 } });
  relayers.push(R2);
  const st = R2.status(outA.body.id);
  assert.deepEqual([st.status, st.txid, Number.isSafeInteger(st.height)], ["accepted", w.r.state.items[outA.body.id].txid, true]);
  assert.equal(Object.hasOwn(st, "cost"), false);
  assert.equal(Object.hasOwn(st, "deadline"), false);
});

test("L2 no combination of saved fields recomputes what each account paid: credits are settled, accounts are keyed, and the fee-based sum finds nothing", async () => {
  // The review's case: A sends twice and B once, at 2, 5 and 3 sat/vB, so every charge differs.
  const w = await world({ config: { minMix: 0, creditKeepBlocks: 6 } });
  const A = await w.fund("A");
  const B = await w.fund("B", newAccount(), 9000);
  await w.step();
  await w.land();
  const sendAt = async (acct, rate) => {
    w.esplora.fee = rate;
    await w.tick();
    const out = await w.r.submit(signedSubmit(acct, w.r.info(), synth(w.idx), "block"), anyIp());
    assert.equal(out.status, 202, JSON.stringify(out.body));
    await w.step();
    await w.land();
    return w.r.state.items[out.body.id].txid;
  };
  const truth = new Map([[await sendAt(A, 2), "A"], [await sendAt(A, 5), "A"], [await sendAt(B, 3), "B"]]);
  w.esplora.fee = 1;
  for (let i = 0; i < 8; i++) await w.step(); // the merge is 6 deep and pruned, the credits 6 deep
  const saved = JSON.parse(readFileSync(w.r.config.statePath, "utf8"));
  const carriers = saved.ledger.filter((l) => l.kind === "carrier");
  assert.equal(carriers.length, 3);
  assert.equal(new Set(carriers.map((l) => costFor(l.fee))).size, 3, "three different charges, each a function of its public fee");

  // 1. The attack still works on what the old code kept: the same ledger, with credits that name
  // their account and carry their amount (rebuilt here from the test's own record).
  const oldCredits = Object.fromEntries(w.deposits.map((d) => [d.outpoint, { id: d.account.idHex, amount: d.value - w.r.sweepCost() }]));
  const oldAccounts = Object.fromEntries([A, B].map((a) => [a.idHex, w.r.books.account(a.idHex)]));
  const old = attributeByFees(saved, { credits: oldCredits, accounts: oldAccounts });
  assert.equal(old.size, 2, "the old file attributed both accounts");
  for (const [id, sets] of old) {
    assert.equal(sets.length, 1, "uniquely");
    for (const txid of sets[0]) assert.equal(truth.get(txid), id === A.idHex ? "A" : "B", "and correctly");
  }

  // 2. What is saved now: every credit is settled, so no credit names an account or carries an amount.
  for (const [key, c] of Object.entries(saved.books.credits)) {
    assert.deepEqual(Object.keys(c).sort(), ["settled", "sweepCost", "value"], `credit ${key} keeps only value and sweep cost`);
  }
  assert.equal(attributeByFees(saved).size, 0, "no debit per account can be formed from the saved books");
  // 3. No account id anywhere in the file, so no deposit address can be derived from it and looked
  // up on chain: deriving addresses from the saved account keys finds none of the real deposits.
  const text = readFileSync(w.r.config.statePath, "utf8");
  for (const a of [A, B]) assert.equal(text.includes(a.idHex), false, "the account id is not in the file");
  const depositScripts = new Set(w.deposits.map((d) => hex(w.esplora.coins.get(d.outpoint)?.script ?? txOf(w.esplora.txs.get(d.outpoint.split(":")[0])).getOutput(0).script)));
  for (const [key, a] of Object.entries(saved.books.accounts)) {
    for (let n = 0; n <= a.nextIndex; n++) assert.equal(depositScripts.has(hex(accountMod.depositAddress(w.r.Q, unhex(key), n, "signet").script)), false, "a saved key derives no deposit address");
  }
  // 4. The books still add up, and a restart reads them.
  assert.equal(w.r.checkBooks().ok, true);
  const R2 = await makePaidRelayer({ idx: w.idx, esplora: w.esplora, dir: w.r.harnessDir, config: { minMix: 0, creditKeepBlocks: 6 } });
  relayers.push(R2);
  assert.equal(R2.checkBooks().ok, true);
  assert.deepEqual(R2.books.account(A.idHex), w.r.books.account(A.idHex), "balances are found by the account id, as before");
});

test("L2 a credit stays readable while wallets still warn about it: until 5 relayed transfers land after it, or creditKeepBlocks", async () => {
  const w = await world({ config: { minMix: 0, creditKeepBlocks: 30 } });
  const A = await w.fund("A");
  await w.step();
  await w.land();
  for (let i = 0; i < 8; i++) await w.step(); // the merge is pruned: only the warning keeps the credit
  const listed = () => w.r.books.credits(A.idHex).length;
  assert.equal(listed(), 1, "the account read still lists the top-up (the wallet's recent top-up warning needs its height)");
  // Five relayed transfers land after it: wallets stop warning, and the credit is settled.
  const B = await w.fund("B", newAccount(), 20_000);
  await w.step();
  await w.land();
  for (let i = 0; i < 5; i++) {
    const out = await w.r.submit(signedSubmit(B, w.r.info(), synth(w.idx), "block"), anyIp());
    assert.equal(out.status, 202, JSON.stringify(out.body));
    await w.step();
    await w.land();
  }
  await w.step();
  assert.equal(listed(), 0, "settled once 5 transfers landed after it");
  assert.equal(w.r.books.isCredited(w.deposits[0].outpoint).settled, true);
  assert.deepEqual(w.r.books.account(A.idHex).nextIndex, 1, "the account keeps its address counter");
  assert.equal(w.r.info().balance.mix.depositors, 2, "settled credits still count their depositors");
  // C tops up after those transfers: nothing lands after it, so it waits for creditKeepBlocks.
  const C = await w.fund("C");
  await w.step();
  await w.land();
  for (let i = 0; i < 20; i++) await w.step();
  assert.equal(w.r.books.credits(C.idHex).length, 1, "merged and pruned, but wallets still warn about it");
  for (let i = 0; i < 10; i++) await w.step();
  assert.equal(w.r.books.credits(C.idHex).length, 0, "settled at creditKeepBlocks at the latest");
});

test("L2 books: settleCredit keeps value and sweep cost only; restore, I2 and the dedupe key still work; a settled credit cannot be reversed; accounts sit under accountKey", () => {
  const keys = { network: "signet", poolKey: "a".repeat(64), changeKey: "b".repeat(64) };
  const tag = (id) => createHash("sha256").update(`k:${id}`).digest("hex");
  const b = new booksMod.RelayBooks({ ...keys, accountKey: tag });
  const id = "c".repeat(64);
  const key = `${"d".repeat(64)}:0`;
  b.credit({ key, id, n: 0, value: 7000, sweepCost: 288, height: 10 });
  assert.equal(b.account(id).balance, 6712, "found by the id");
  assert.deepEqual(Object.keys(b.toJSON().accounts), [tag(id)], "stored under the key, never the id");
  assert.equal(JSON.stringify(b.toJSON()).includes(id), false);
  b.reserve("r1", tag(id), 600, { byKey: true });
  b.settle("r1", { fee: 500 });
  b.confirmCharge("r1");
  assert.equal(b.settleCredit(key), true);
  assert.equal(b.settleCredit(key), false, "idempotent");
  assert.deepEqual(b.toJSON().credits[key], { value: 7000, sweepCost: 288, settled: true });
  assert.deepEqual(b.credits(id), [], "a settled credit is not listed");
  assert.equal(b.claim(key), false, "the outpoint is still never credited twice");
  assert.throws(() => b.reverseCredit(key), /settled/);
  assert.equal(b.checkI2({ poolUnspent: 1e9 }).ok, true);
  const back = booksMod.RelayBooks.restore(JSON.parse(JSON.stringify(b.toJSON())), { ...keys, accountKey: tag });
  assert.deepEqual(back.toJSON(), b.toJSON());
  assert.equal(back.account(id).balance, b.account(id).balance);
  assert.throws(() => booksMod.RelayBooks.restore({ ...b.toJSON(), credits: { [key]: { value: 7000, sweepCost: 288, settled: true, id } } }, keys), /malformed/, "a settled credit with an account is refused");
});

test("L2 a state saved before accounts were keyed loads keyed: the same books, coins and lineage, deposits still spendable, no account id left once saved", async () => {
  const w = await world();
  const acct = {};
  for (const label of ["A", "B", "C", "D"]) acct[label] = await w.fund(label);
  await w.step();
  await w.land();
  acct.E = await w.fund("E"); // unmerged: its coin must stay spendable after the load
  const queued = await w.r.submit(signedSubmit(acct.A, w.r.info(), synth(w.idx), "block"), anyIp());
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  w.r.save();
  const path = w.r.config.statePath;
  const now = JSON.parse(readFileSync(path, "utf8"));
  // The file as the code before this fix wrote it: account ids instead of keys, lineage tags
  // HMAC(mixKey, id), no deposit tweaks, no script list.
  const idOf = new Map(Object.values(acct).map((a) => [w.r.accountKeyOf(a.idHex), a.idHex]));
  const tagOf = new Map([...idOf].map(([k, id]) => [w.r.mixTag(k), w.r.mixTag(id)]));
  const old = JSON.parse(JSON.stringify(now));
  delete old.accountsKeyed;
  delete old.ownScripts;
  old.books.accounts = Object.fromEntries(Object.entries(old.books.accounts).map(([k, v]) => [idOf.get(k), v]));
  for (const part of ["credits", "reservations", "charges"]) for (const v of Object.values(old.books[part])) if (v.id) v.id = idOf.get(v.id);
  for (const c of Object.values(old.coins)) {
    delete c.tweak;
    if (c.mix) c.mix = c.mix.map((t) => tagOf.get(t)).sort();
  }
  for (const item of Object.values(old.items)) if (item.account) item.account = idOf.get(item.account);
  assert.ok(JSON.stringify(old).includes(acct.A.idHex), "the old shape names accounts");
  writeFileSync(path, JSON.stringify(old));
  w.r.close();
  const R2 = await makePaidRelayer({ idx: w.idx, esplora: w.esplora, dir: w.r.harnessDir, config: { minMix: 3 } });
  relayers.push(R2);
  assert.deepEqual(R2.books.toJSON(), w.r.books.toJSON(), "the same books, keyed");
  assert.deepEqual(R2.state.coins, now.coins, "the same coins: tweaks restored, tags renamed to the same values");
  assert.deepEqual(R2.state.items[queued.body.id].account, w.r.accountKeyOf(acct.A.idHex));
  assert.deepEqual([...R2.ownScripts].sort(), [...w.r.ownScripts].sort(), "the same deposit scripts count as the relayer's own");
  assert.deepEqual(R2.mixInfo(), w.r.mixInfo());
  for (const a of Object.values(acct)) assert.equal(readFileSync(path, "utf8").includes(a.idHex), false, "saved keyed at once");
  // E's deposit merges with its tweak alone, and A's queued send goes out.
  await R2.onTick({ chainTip: w.idx.height });
  await w.c.mine();
  await R2.onTick({ chainTip: w.idx.height });
  assert.equal(R2.state.halted, null);
  assert.ok(R2.state.ledger.some((l) => l.kind === "merge" && l.broadcastHeight > now.lastFlushHeight), "E's deposit was merged");
  assert.equal(R2.state.items[queued.body.id].status, "broadcast");
});

test("L2 persistedItem: queued and journaled items stay whole; a broadcast item keeps only what its re-send needs, all of it in its raw bytes", () => {
  const queued = { id: "a".repeat(32), status: "queued", account: "b".repeat(64), envelope: "00", cost: 1, mode: "batch", anchor: 5 };
  assert.equal(persistedItem(queued), queued);
  const signing = { ...queued, status: "signing", raw: "00", txid: "c".repeat(64) };
  assert.equal(persistedItem(signing), signing);
  const broadcast = {
    id: "a".repeat(32), status: "broadcast", txid: "c".repeat(64), raw: "00", nullifiers: ["1", "2"], anchor: 5, mode: "batch", releaseAt: 6, lastRelease: 30,
    cost: 700, acceptedHeight: 4, broadcastHeight: 6, fee: 600, vsize: 600, feeRate: 1, outpoint: "x:0", root: "9", ledgerSeq: 3, reservation: 0, attempts: 0, fanout: "f".repeat(64),
  };
  assert.deepEqual(persistedItem(broadcast), {
    id: broadcast.id, status: "broadcast", txid: broadcast.txid, broadcastHeight: 6, ledgerSeq: 3, raw: "00", nullifiers: ["1", "2"], anchor: 5, fee: 600, fanout: broadcast.fanout,
  });
  const final = { ...broadcast, status: "accepted", height: 7, finalHeight: 7 };
  delete final.raw;
  assert.deepEqual(persistedItem(final), { id: broadcast.id, status: "accepted", txid: broadcast.txid, height: 7, broadcastHeight: 6, ledgerSeq: 3, finalHeight: 7 });
});

test("L2 a copy of the live paid relayer's state: the report's sum works on it today; the fixed relayer loads it keyed, settles its old credit, and the sum finds nothing", { skip: !existsSync("data/signet/relay-balance/relayer.json") && "no live relay-balance state here" }, async () => {
  const live = JSON.parse(readFileSync("data/signet/relay-balance/relayer.json", "utf8"));
  // Written by the relayer before this fix (it keeps doing so until the owner restarts it): with
  // each carrier's charge recomputed from its fee, credits − balance names the account's carriers.
  const ids = Object.keys(live.books.accounts);
  if (live.accountsKeyed !== true && live.ledger.some((l) => l.kind === "carrier")) assert.ok(attributeByFees(live).size >= 1, "the old file re-attributes carriers to the account");
  // A copy of the whole relay-balance directory (keys included; nothing is shown or written back).
  const dir = mkdtempSync(join(DIR, "live-copy-"));
  mkdirSync(join(dir, "relay-balance"));
  for (const name of ["pool.key", "change.key", "relayer.json"]) copyFileSync(join("data/signet/relay-balance", name), join(dir, "relay-balance", name));
  const esplora = makeFakeEsplora({ fee: 1 });
  const c = chain({ start: 870_000, fakes: [esplora] });
  await c.mine();
  const r = await makePaidRelayer({ idx: c.idx, esplora, dir, config: { minMix: 3 } });
  relayers.push(r);
  assert.equal(r.checkBooks().ok, true, "the books add up after keying");
  for (const id of ids) {
    if (!/^[0-9a-f]{64}$/.test(id)) continue;
    const old = live.books.accounts[id];
    // A live file written since the fix is keyed already: its accounts are found by their stored key.
    const found = live.accountsKeyed === true ? r.books.accountByKey(id) : r.books.account(id);
    assert.deepEqual(found, { balance: old.balance, reserved: old.reserved, nextIndex: old.nextIndex }, "the same balance, found by the account id");
  }
  r.pruneCoins(); // its deposit left the pool long ago: the credit is settled
  r.save();
  const text = readFileSync(join(dir, "relay-balance", "relayer.json"), "utf8");
  // (A keyed file's account keys are opaque HMACs, which the file is meant to hold.)
  if (live.accountsKeyed !== true) for (const id of ids) assert.equal(text.includes(id), false, "no account id is left in the file");
  const saved = JSON.parse(text);
  assert.equal(saved.accountsKeyed, true);
  for (const item of Object.values(saved.items)) {
    if (item.status === "queued" || item.status === "signing") continue;
    for (const k of SETTLED_FORBIDDEN) assert.equal(Object.hasOwn(item, k), false, k);
  }
  assert.equal(attributeByFees(saved).size, 0, "credits − balance can no longer be formed");
});

/* ------------------------------------------------------------------ L2: the retired v1 file */

const vid = (c) => c.repeat(32).slice(0, 32);
function v1Fixture() {
  return {
    version: 1, day: "2026-10-03", spentToday: 598,
    items: {
      [vid("a")]: { id: vid("a"), status: "accepted", anchor: 100, mode: "fast", txid: "1".repeat(64), height: 103, nullifiers: ["11"], root: "5", outpoint: "x:0", fee: 598 },
      [vid("b")]: { id: vid("b"), status: "queued", anchor: 120, mode: "batch10", releaseAt: 180, lastRelease: 208, nullifiers: ["22", "23"], envelope: "6d726b00", acceptedHeight: 119, reservation: 597 },
      [vid("c")]: { id: vid("c"), status: "broadcast", anchor: 130, mode: "block", txid: "3".repeat(64), nullifiers: ["33"], raw: "0200" },
      [vid("e")]: { id: vid("e"), status: "expired", anchor: 80, mode: "batch", releaseAt: 86, lastRelease: 156, nullifiers: ["55"] },
    },
    ledger: [{ seq: 1, txid: "1".repeat(64), fee: 598 }],
  };
}

test("L2 v1 relayer.json: loaded pruned in memory (file untouched), rewritten once at startup without envelopes or nullifiers, every old id answers the same", () => {
  const path = join(DIR, "v1-relayer.json");
  const fixture = v1Fixture();
  writeFileSync(path, JSON.stringify(fixture));
  const before = sha(path);
  const mem = loadV1State(path, { log: silent });
  assert.equal(sha(path), before, "loading never writes");
  for (const item of mem.items.values()) {
    for (const k of ["envelope", "nullifiers", "raw", "root", "outpoint", "acceptedHeight", "reservation", "fee"]) assert.equal(Object.hasOwn(item, k), false, k);
  }
  const answers = Object.keys(fixture.items).map((id) => v1Status(mem, id));
  assert.equal(v1NeedsPrune(fixture), true);
  assert.equal(pruneV1File(path, { log: silent }), true);
  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(JSON.stringify(after).includes("6d726b00"), false, "the never-broadcast envelope is gone");
  for (const n of ["11", "22", "23", "33", "55"]) assert.equal(JSON.stringify(after.items).includes(`"${n}"`), false, `nullifier ${n} is gone`);
  assert.deepEqual(after.ledger, fixture.ledger, "the public carrier ledger stays");
  assert.deepEqual(Object.keys(fixture.items).map((id) => v1Status(loadV1State(path, { log: silent }), id)), answers, "old ids answer as before");
  assert.equal(pruneV1File(path, { log: silent }), false, "a pruned file is not written again");
  // A file with nothing secret (empty nullifier lists) is never rewritten.
  const plain = join(DIR, "v1-plain.json");
  writeFileSync(plain, JSON.stringify({ version: 1, items: { [vid("d")]: { id: vid("d"), status: "queued", anchor: 500, nullifiers: [] } }, ledger: [] }));
  const plainHash = sha(plain);
  assert.equal(pruneV1File(plain, { log: silent }), false);
  assert.equal(sha(plain), plainHash);
  assert.deepEqual(pruneV1State(fixture).items[vid("c")], { id: vid("c"), status: "broadcast", anchor: 130, mode: "block", txid: "3".repeat(64) });
});

test("L2 a copy of the live v1 relayer.json: the expired never-broadcast item loses its envelope and nullifiers; answers unchanged", { skip: !existsSync("data/signet/relayer.json") && "no data/signet/relayer.json here" }, () => {
  const path = join(DIR, "live-v1-copy.json");
  copyFileSync("data/signet/relayer.json", path);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const answers = Object.keys(saved.items).map((id) => v1Status(loadV1State(path, { log: silent }), id));
  pruneV1File(path, { log: silent });
  const after = JSON.parse(readFileSync(path, "utf8"));
  for (const item of Object.values(after.items)) {
    for (const k of ["envelope", "nullifiers", "raw", "account", "cost"]) assert.equal(Object.hasOwn(item, k), false, k);
  }
  assert.deepEqual(Object.keys(saved.items).map((id) => v1Status(loadV1State(path, { log: silent }), id)), answers);
});

/* ------------------------------------------------------------------------- L5: tx shape */

test("L5 every transaction the relayer builds signals RBF on every input; merges and carriers pay the one fee rule", async () => {
  const w = await world({ config: { minMix: 0 } });
  const a = await w.fund("A");
  await w.fund("B");
  await w.step();
  const out = await w.r.submit(signedSubmit(a, w.r.info(), synth(w.idx), "block"), anyIp());
  assert.equal(out.status, 202);
  await w.step();
  const txs = relayerTxs(w);
  assert.ok(txs.length >= 2, "a merge and a carrier");
  for (const tx of txs) for (let i = 0; i < tx.inputsLength; i++) assert.equal(tx.getInput(i).sequence, RBF_SEQUENCE, "nSequence 0xfffffffd");
  const rate = w.r.cache.feeRate;
  for (const entry of w.r.state.ledger) {
    const tx = txOf(w.esplora.txs.get(entry.txid));
    if (entry.kind === "merge") assert.equal(entry.fee, feeAt(rate, 11 + 57.5 * tx.inputsLength + 43));
    assert.ok(entry.fee >= rate * tx.vsize, "never below the rate");
    assert.ok(entry.fee <= rate * tx.vsize + rate * 2, "and only rounding above it");
  }
  assert.equal(feeAt(1.2, 100.5), 2 * 101, "a whole sat/vB (rounded up) times the vsize rounded up");
});

test("L5 withChangeAt moves the change, keeps inputs and amounts; assertOutputs takes the change anywhere after the OP_RETURN, never before it, fee outputs in order", async () => {
  const w = await world({ config: { minMix: 0 } });
  const r = w.r;
  const env = synth(w.idx);
  const fee = { script: btc.p2tr(schnorr.getPublicKey(randomBytes(32)), undefined, btc.TEST_NETWORK).script, amount: 500n };
  const fee2 = { script: btc.p2tr(schnorr.getPublicKey(randomBytes(32)), undefined, btc.TEST_NETWORK).script, amount: 600n };
  const C = { script: r.change.script, amount: 9000n };
  const build = (outs) => {
    const tx = new btc.Transaction({ allowUnknownOutputs: true });
    tx.addInput({ txid: randomBytes(32), index: 0, witnessUtxo: { script: r.change.script, amount: 20_000n }, tapInternalKey: r.change.pub, sequence: RBF_SEQUENCE });
    for (const o of outs) tx.addOutput(o);
    return tx;
  };
  const op = { script: opReturnScript(env), amount: 0n };
  r.assertOutputs(build([op, fee, C]), "carrier", env, [fee]);
  r.assertOutputs(build([op, C, fee]), "carrier", env, [fee]);
  r.assertOutputs(build([op, fee, C, fee2]), "carrier", env, [fee, fee2]);
  assert.throws(() => r.assertOutputs(build([op, fee2, C, fee]), "carrier", env, [fee, fee2]), /I1: output 1 is not the required service-fee output/);
  assert.throws(() => r.assertOutputs(build([C, op, fee]), "carrier", env, [fee]), /I1: output 0 is not the item's envelope/);
  assert.throws(() => r.assertOutputs(build([op, C]), "carrier", env, [fee]), /I1: a carrier without its service-fee outputs/);
  assert.throws(() => r.assertOutputs(build([op, fee, fee]), "carrier", env, [fee]), /I1: output 2 does not pay the change key/);
  const moved = withChangeAt(build([op, fee, fee2, C]), 3, 1);
  assert.deepEqual(Array.from({ length: moved.outputsLength }, (_, v) => moved.getOutput(v).amount), [0n, 9000n, 500n, 600n]);
  assert.equal(moved.getInput(0).sequence, RBF_SEQUENCE);
});

test("L5 planSweep (retire-free): inputs in a random order, every input RBF, fee = whole rate x vsize", () => {
  const key = new Uint8Array(randomBytes(32));
  const utxos = [5000, 6000, 7000].map((value, i) => ({ txid: String(i + 1).repeat(64), vout: 0, value }));
  const to = btc.Address(btc.TEST_NETWORK).encode({ type: "tr", pubkey: schnorr.getPublicKey(randomBytes(32)) });
  const orderOf = (plan) => {
    const tx = btc.Transaction.fromRaw(unhex(plan.hex));
    return Array.from({ length: tx.inputsLength }, (_, i) => hex(tx.getInput(i).txid)[0]);
  };
  // Deterministic stand-ins for the CSPRNG: always the last slot (no swap), always slot 0.
  const keep = planSweep({ key, utxos, to, feeRate: 1.5, random: (n) => n - 1 });
  const turn = planSweep({ key, utxos, to, feeRate: 1.5, random: () => 0 });
  assert.notDeepEqual(orderOf(keep), orderOf(turn), "the order comes from the random source, not from sorting");
  for (const plan of [keep, turn]) {
    const tx = btc.Transaction.fromRaw(unhex(plan.hex));
    for (let i = 0; i < tx.inputsLength; i++) assert.equal(tx.getInput(i).sequence, RBF_SEQUENCE);
    assert.equal(plan.fee, feeAt(1.5, 11 + 43 + 57.5 * 3), "1.5 sat/vB rounds up to 2, times the vsize rounded up");
    assert.ok(plan.fee >= 2 * plan.vsize, "never below the rate");
  }
});

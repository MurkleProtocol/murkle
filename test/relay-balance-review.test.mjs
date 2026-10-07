// Relay balance review fixes, server side (docs/design/relay-balance.md §3 I-PAY, §5 privacy):
// a carrier, fan-out or merge whose broadcast answer was lost is never refunded while it may be
// on the network; Bitcoin Core 28+'s answer for a confirmed transaction is "ok"; a deposit that
// a reorg put back in the mempool stays watched and frozen; no carrier spends a deposit; credit
// lookups are capped for all IPs together; the replay set expires in constant time.
//
// Fakes only: FakeEsplora (never broadcasts anything real), synthetic blocks and envelopes,
// temporary directories. Nothing touches data/signet/.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chain, fundAccount, hash32, makeFakeEsplora, makePaidRelayer, newAccount, signedSubmit, silent, synth, txOf,
} from "./fixtures/relay-harness.mjs";
import { hex } from "../src/bytes.mjs";
import { MAX_REPLAYS } from "../server/relayer.mjs";

const DIR = mkdtempSync(join(tmpdir(), "murkle-relay-review-"));
const relayers = [];
after(() => {
  relayers.forEach((r) => r.close());
  rmSync(DIR, { recursive: true, force: true });
});
const anyIp = () => `203.0.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;
const CORE28 = 'POST /tx: 400 sendrawtransaction RPC error: {"code":-27,"message":"Transaction outputs already in utxo set"}';

/** A chain, a fake esplora (whose answers a test can lose) and a paid relayer after its first tick. */
async function world({ start = 864_000, config = {}, dir, now } = {}) {
  const esplora = makeFakeEsplora();
  const c = chain({ start, fakes: [esplora] });
  await c.mine();
  const r = await makePaidRelayer({ idx: c.idx, esplora, config, log: silent, ...(dir ? { dir } : {}), ...(now ? { now } : {}) });
  relayers.push(r);
  const tick = (rr = r) => rr.onTick({ chainTip: c.idx.height });
  await tick();
  // statusDown: the explorer's status lookups fail (503), as during an outage.
  const flaky = { statusDown: false };
  const status = esplora.txStatus.bind(esplora);
  esplora.txStatus = async (txid) => {
    if (flaky.statusDown) throw new Error(`GET /tx/${txid}/status: 503 Service Unavailable`);
    return status(txid);
  };
  return {
    esplora, c, idx: c.idx, r, tick, flaky,
    step: async (rr = r) => (await c.mine(), tick(rr)),
    land: async (rr = r) => (await c.mineCarriers(esplora), tick(rr)),
  };
}
const send = (w, account, envelope, mode = "block") => w.r.submit(signedSubmit(account, w.r.info(), envelope, mode), anyIp());
async function funded(w, sats = 7000) {
  const a = newAccount();
  const f = await fundAccount({ relayer: w.r, esplora: w.esplora, account: a, sats });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  a.outpoint = f.outpoint;
  a.txid = f.txid;
  return a;
}
const bal = (w, a) => w.r.books.account(a.idHex);

/* ---------------------------------------------------------------- carriers whose answer was lost */

test("a carrier accepted by the network whose answer was lost is never refunded: it lands, the charge stays, the coins match the chain (Core 28 text)", async () => {
  const w = await world();
  const a = await funded(w);
  await funded(w, 20_000);
  await w.tick(); // the deposits are merged into C
  const out = await send(w, a, synth(w.idx));
  assert.equal(out.status, 202);
  await w.c.mine();
  // The node takes the carrier, the answer is lost (502) and the explorer gives no status either.
  w.esplora.loseAnswer = new Error("POST /tx: 502 Bad Gateway");
  w.flaky.statusDown = true;
  await w.tick();
  const item = w.r.state.items[out.body.id];
  assert.equal(item.status, "signing", "outcome unknown: journaled, not dropped");
  assert.equal(item.attempts, 0, "an unknown outcome is not an attempt");
  const charged = bal(w, a).balance;
  assert.equal(charged, 6712 - 658, "charged at signing (fee 598 + margin 60)");
  assert.equal(w.esplora.mempool.has(item.txid), true, "the carrier is on the network");
  // It is mined; every later resend gets Bitcoin Core 28+'s text for a confirmed transaction.
  await w.c.mineCarriers(w.esplora);
  assert.equal(await w.r.broadcastRaw(item.raw), "ok", CORE28);
  w.flaky.statusDown = false;
  await w.tick();
  assert.equal(w.r.status(out.body.id).status, "accepted");
  assert.equal(bal(w, a).balance, charged, "never refunded");
  const coin = w.r.state.coins[item.outpoint];
  assert.equal(coin.status, "spent", "its input is spent in the records, as on the chain");
  assert.ok(w.r.state.coins[`${item.txid}:1`], "its change output is tracked");
  assert.equal(w.r.checkBooks().ok, true);
  for (let i = 0; i < 3; i++) await w.step();
  assert.equal(w.r.status(out.body.id).status, "accepted");
  assert.equal(bal(w, a).balance, charged);
});

test("after a lost answer and a restart, the mined carrier is found again by its resend (Core 28 text) and by the indexer, never refunded", async () => {
  const dir = mkdtempSync(join(DIR, "restart-"));
  const w = await world({ dir });
  const a = await funded(w);
  await w.tick();
  const out = await send(w, a, synth(w.idx));
  await w.c.mine();
  w.esplora.loseAnswer = new Error("socket hang up");
  w.flaky.statusDown = true;
  await w.tick();
  const item = w.r.state.items[out.body.id];
  assert.equal(item.status, "signing");
  const charged = bal(w, a).balance;
  // The carrier is mined while the relayer is down.
  await w.c.mineCarriers(w.esplora);
  w.flaky.statusDown = false;
  w.r.close();
  const r2 = await makePaidRelayer({ idx: w.idx, esplora: w.esplora, dir });
  relayers.push(r2);
  assert.equal(r2.status(out.body.id).status, "broadcast", "recover(): the resend answered 'outputs already in utxo set', which is ok");
  await r2.onTick({ chainTip: w.idx.height });
  assert.equal(r2.status(out.body.id).status, "accepted");
  assert.equal(r2.books.account(a.idHex).balance, charged);
  assert.equal(r2.checkBooks().ok, true);
});

test("a journaled carrier the indexer saw landing is broadcast even when no answer said so", async () => {
  const w = await world();
  const a = await funded(w);
  await w.tick();
  const out = await send(w, a, synth(w.idx));
  await w.c.mine();
  w.esplora.loseAnswer = new Error("POST /tx: 504 Gateway Timeout");
  w.flaky.statusDown = true;
  await w.tick();
  assert.equal(w.r.state.items[out.body.id].status, "signing");
  await w.c.mineCarriers(w.esplora); // the explorer stays down: only the indexer's verdict says it landed
  w.esplora.failNext = new Error("POST /tx: 503 Service Unavailable");
  await w.tick();
  assert.equal(w.r.status(out.body.id).status, "accepted");
  assert.equal(w.r.checkBooks().ok, true);
});

test("answers that never came never drop a carrier; three explicit refusals of a txid the explorer does not know drop it, refunded, coins back", async () => {
  const w = await world();
  const a = await funded(w);
  await w.tick();
  const out = await send(w, a, synth(w.idx));
  const before = bal(w, a);
  for (let k = 0; k < 4; k++) {
    w.esplora.failNext = new Error(k % 2 ? "fetch failed" : "POST /tx: 502 Bad Gateway");
    await w.step();
    const item = w.r.state.items[out.body.id];
    assert.deepEqual([item.status, item.attempts], ["signing", 0], `block ${k}: kept journaled`);
  }
  await w.step();
  assert.equal(w.r.status(out.body.id).status, "broadcast", "sent once the network answers");

  // A node that refuses the carrier outright, three times, for a txid the explorer does not know.
  const b = await funded(w);
  await w.step(); // merged at the next block, so no merge takes the refusals below
  const o2 = await send(w, b, synth(w.idx));
  const b0 = bal(w, b);
  const refuse = () => (w.esplora.failNext = new Error('POST /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}'));
  refuse();
  await w.step();
  const item = w.r.state.items[o2.body.id];
  assert.deepEqual([item.status, item.attempts], ["signing", 1]);
  const coin = item.outpoint;
  refuse();
  await w.step();
  refuse();
  await w.step();
  assert.equal(w.r.status(o2.body.id).status, "dropped");
  assert.deepEqual(bal(w, b), { ...b0, balance: b0.balance + b0.reserved, reserved: 0 }, "refunded: it never reached the network");
  assert.equal(w.r.state.coins[coin].status, "unspent");
  assert.equal(w.r.checkBooks().ok, true);
  assert.ok(before.reserved > 0);
});

/* ---------------------------------------------------------------- fan-outs and merges */

test("a fan-out whose answer was lost stays pending (fee charged to the margin, outputs unsent) and is confirmed on the next tick; an explicit refusal drops it", async () => {
  const w = await world({ config: { fanoutTarget: 24, fanoutMinConfirmed: 2, fanoutMinCarriers: 30 } });
  for (let i = 0; i < 5; i++) await funded(w, 2500);
  await funded(w, 400_000);
  await w.step(); // one merge of the six deposits
  const margin0 = w.r.books.toJSON().margin;
  // The merge confirms; in the same tick the fan-out splits it, and its answer is lost.
  const broadcast = w.esplora.broadcast.bind(w.esplora);
  w.esplora.broadcast = async (raw) => {
    const id = await broadcast(raw);
    if (txOf(raw).outputsLength > 2) {
      w.flaky.statusDown = true;
      throw new Error("POST /tx: 502 Bad Gateway");
    }
    return id;
  };
  await w.land();
  w.esplora.broadcast = broadcast;
  const fan = w.r.state.ledger.find((l) => l.kind === "fanout");
  assert.ok(fan);
  assert.deepEqual([fan.outcome, fan.unsent, typeof fan.raw], ["pending", true, "string"], "kept pending: its bytes may be on the network");
  assert.equal(w.r.books.toJSON().margin, margin0 - fan.fee, "its fee is not given back");
  assert.equal(w.esplora.mempool.has(fan.txid), true);
  assert.ok(Object.entries(w.r.state.coins).filter(([k]) => k.startsWith(fan.txid)).every(([, c]) => c.unsent), "its outputs are not spent yet");
  assert.equal(w.r.checkBooks().ok, true);
  w.flaky.statusDown = false;
  await w.tick();
  assert.equal(fan.unsent, undefined, "found on the network: sent");
  assert.equal(w.r.state.ledger.filter((l) => l.kind === "fanout").length, 1, "never signed twice");
  await w.land();
  assert.equal(fan.outcome, "accepted");
  assert.equal(w.r.books.toJSON().margin, margin0 - fan.fee);
  assert.equal(w.r.checkBooks().ok, true);

  // A node that refuses a merge outright, for a txid the explorer does not know: dropped, coins and fee back.
  const v = await world();
  await funded(v, 9000);
  const m0 = v.r.books.toJSON().margin;
  v.esplora.failNext = new Error('POST /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}');
  await v.tick();
  const merge = v.r.state.ledger.find((l) => l.kind === "merge");
  assert.equal(merge.outcome, "dropped");
  assert.match(merge.reason, /refused/);
  assert.equal(v.r.books.toJSON().margin, m0);
  assert.ok(Object.values(v.r.state.coins).some((c) => c.kind === "deposit" && c.status === "unspent"));
});

/* ---------------------------------------------------------------- deposits back in the mempool */

test("a credited deposit a reorg puts back in the mempool is frozen and watched for as long as it stays there; reversed when it vanishes", async () => {
  const w = await world();
  const victim = await funded(w, 20_000);
  const attacker = await funded(w, 10_000);
  const queued = await send(w, attacker, synth(w.idx));
  assert.equal(queued.status, 202);
  // The attacker's deposit block is reorged away: the deposit is back in the mempool.
  w.esplora.mined.delete(attacker.txid);
  w.esplora.mempool.add(attacker.txid);
  await w.step();
  const coin = w.r.state.coins[attacker.outpoint];
  assert.deepEqual([coin.reorged, coin.confirmed, coin.status], [true, false, "unspent"], "frozen, never merged or spent");
  assert.equal(w.r.status(queued.body.id).status, "missed", "no signature for money that may not exist");
  assert.equal(w.r.status(queued.body.id).code, "balance_low");
  assert.equal(w.esplora.carriers().length, 0);
  assert.ok(w.r.state.coins[victim.outpoint].status === "spent", "the victim's deposit went to C in a merge");
  for (let i = 0; i < 7; i++) await w.step();
  w.esplora.requests.length = 0;
  await w.tick();
  assert.ok(w.esplora.requests.some(([, t]) => t === attacker.txid), "still looked up 8 blocks later");
  const refused = await send(w, attacker, synth(w.idx));
  assert.deepEqual([refused.status, refused.body.error.code, refused.body.error.balance], [402, "balance_low", 0], "the frozen credit does not count");
  // The attacker replaces it (it leaves the mempool): reversed after two 404s, nothing halts.
  w.esplora.vanish(attacker.txid);
  await w.tick();
  await w.tick();
  assert.equal(w.r.books.isCredited(attacker.outpoint).reversed, true);
  assert.deepEqual(w.r.books.account(attacker.idHex), { balance: 0, reserved: 0, nextIndex: 1 });
  assert.equal(w.r.state.halted, null);
  assert.equal(w.r.checkBooks().ok, true);
});

test("a deposit re-mined at a later height counts its depth from there and thaws once it has the credit's confirmations", async () => {
  const w = await world();
  const a = await funded(w, 10_000);
  w.esplora.mined.delete(a.txid);
  w.esplora.mempool.add(a.txid);
  await w.tick();
  assert.equal(w.r.state.coins[a.outpoint].reorged, true);
  for (let i = 0; i < 4; i++) await w.step();
  const h = w.idx.height + 1;
  await w.c.mineCarriers(w.esplora); // mined again, at h
  await w.tick();
  const coin = w.r.state.coins[a.outpoint];
  assert.equal(coin.height, h);
  assert.equal(coin.reorged, undefined, "1 confirmation, as a credit needs on signet: thawed");
  assert.equal(coin.confirmed, true);
  for (let i = 0; i < 3; i++) await w.step();
  w.esplora.requests.length = 0;
  await w.tick();
  assert.ok(w.esplora.requests.some(([, t]) => t === a.txid), "watched for 6 blocks from its new height, not its old one");
  assert.equal((await send(w, a, synth(w.idx))).status, 202);
});

/* ---------------------------------------------------------------- no carrier spends a deposit */

test("no carrier spends a deposit: Alice's send rides a C coin, and the saved state never ties her credit to her carrier", async () => {
  const dir = mkdtempSync(join(DIR, "privacy-"));
  const w = await world({ dir });
  const bob = await funded(w, 20_000);
  const alice = await funded(w, 7000);
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await send(w, alice, synth(w.idx))).body.id);
  await w.step();
  assert.ok(ids.every((id) => w.r.status(id).status === "broadcast"));
  const deposits = new Set([alice.outpoint, bob.outpoint]);
  for (const tx of w.esplora.carriers()) {
    const input = `${hex(tx.getInput(0).txid)}:${tx.getInput(0).index}`;
    assert.ok(!deposits.has(input), "a carrier input is never a deposit outpoint");
    assert.equal(w.r.books.isCredited(input), null);
  }
  const saved = JSON.parse(readFileSync(join(dir, "relay-balance", "relayer.json"), "utf8"));
  const carrierTxids = new Set(ids.map((id) => saved.items[id].txid));
  for (const d of deposits) {
    assert.ok(!carrierTxids.has(saved.coins[d].spentBy), "a deposit is spent by a merge, not a carrier");
    assert.equal(saved.ledger.find((l) => l.txid === saved.coins[d].spentBy)?.kind, "merge");
  }
  for (const id of ids) assert.ok(!deposits.has(saved.items[id].outpoint));
});

/* ---------------------------------------------------------------- credit lookups and the replay set */

test("unsigned credit calls with made-up txids cost at most creditLookupsPerMinute explorer lookups for all IPs together; an unknown txid is remembered for the block (at most a minute)", async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const w = await world({ now });
  const lookups = () => w.esplora.requests.filter(([k]) => k === "hex").length;
  const acct = newAccount();
  const credit = (txid, ip) => w.r.credit(JSON.stringify({ outpoint: `${txid}:0`, accountPub: acct.pubHex, n: 0 }), ip);
  const codes = {};
  for (let p = 0; p < 256; p++) {
    for (let k = 0; k < 4; k++) {
      const res = await credit(hash32(), `2001:db8:1:${p.toString(16)}00::${k + 1}`);
      codes[res.body.error.code] = (codes[res.body.error.code] ?? 0) + 1;
    }
  }
  assert.equal(lookups(), 30, "30 lookups a minute, whatever the number of IP prefixes");
  assert.equal(codes.deposit_unknown, 30);
  assert.equal(codes.busy, 256 * 4 - 30);
  assert.match((await credit(hash32(), "198.51.200.1")).body.error.message, /looking up many deposits/);
  // One unknown txid asked again from other networks in the same block: looked up once.
  t += 61_000;
  const same = hash32();
  for (let k = 0; k < 5; k++) assert.equal((await credit(same, `198.51.${k}.1`)).body.error.code, "deposit_unknown");
  assert.equal(lookups(), 31);
  t += 61_000; // a minute later it may have reached the explorer: looked up again
  assert.equal((await credit(same, "198.51.9.1")).body.error.code, "deposit_unknown");
  assert.equal(lookups(), 32);
  // An honest credit after the minute: credited.
  t += 61_000;
  const a = newAccount();
  const f = await fundAccount({ relayer: w.r, esplora: w.esplora, account: a, sats: 7000 });
  assert.equal(f.status, 200);
  // The setting is validated.
  const { balanceProblems, DEFAULTS } = await import("../server/relayer.mjs");
  assert.equal(DEFAULTS.creditLookupsPerMinute, 30);
  assert.ok(balanceProblems({ ...DEFAULTS, creditLookupsPerMinute: 0 }).some((p) => /MURKLE_RELAY_CREDIT_LOOKUPS_PER_MIN/.test(p)));
});

test("the replay set expires in insertion order, stopping at the first live entry; a full set answers busy", async () => {
  let t = 1_790_000_000_000;
  const now = () => t;
  const w = await world({ now });
  class Counting extends Map {
    walked = 0;
    *[Symbol.iterator]() {
      for (const e of super.entries()) {
        this.walked += 1;
        yield e;
      }
    }
  }
  const replays = new Counting();
  for (let i = 0; i < 20_000; i++) replays.set(`k${i}`, t + 1_200_000);
  w.r.replays = replays;
  for (let i = 0; i < 100; i++) w.r.checkReplay(`sig-${i}`);
  assert.ok(replays.walked <= 100, `walked ${replays.walked} entries for 100 calls`);
  // Half of them expire: one call removes exactly those, then stops.
  t += 1_200_001;
  for (let i = 0; i < 20_100; i++) replays.set(`late${i}`, t + 1_200_000);
  replays.walked = 0;
  w.r.checkReplay("sig-x");
  assert.equal(replays.walked, 20_100 + 1, "the 20,100 expired ones and the first live one");
  assert.equal(replays.size, 20_100 + 1);
  // Full: busy, and nothing recorded.
  const full = new Map();
  for (let i = 0; i < MAX_REPLAYS; i++) full.set(`f${i}`, t + 1_200_000);
  w.r.replays = full;
  const out = await w.r.submit(signedSubmit(newAccount(), w.r.info(), synth(w.idx), "block", { now }), anyIp());
  assert.deepEqual([out.status, out.body.error.code], [503, "busy"]);
  assert.equal(full.size, MAX_REPLAYS);
});

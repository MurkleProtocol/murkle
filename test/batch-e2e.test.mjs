// Batch relay timing end to end (docs/design/batch-contract.md, privacy-level2.md §5.1):
// the web wallet's Session proves against the epoch boundary S, submits over HTTP to the
// real paid relayer behind createApp (signed by the session's relay account, paid from its
// relay balance), the relayer holds the epoch until S + E and sends it in one flush, the
// indexer accepts the carriers at S + E + 1, and the wallet's history goes from Scheduled
// to landed with its notes unlocked. Then the epoch_closed path: the batch closes while
// the wallet proves, and it proves the same notes (same nullifiers) again for the next batch.
//
// Synthetic blocks, a fake esplora (test/fixtures/relay-harness.mjs) holding four credited
// deposits of the session's relay account (7,000 + 3 x 10,000 sats), real Groth16 proofs.
// Nothing touches a network and nothing is broadcast.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import * as btc from "@scure/btc-signer";

const api = await import("../web/src/api.js");
const S = await import("../web/src/session.js");
// These tests drive relayed batch sends, their phases and relay polling. The route opens
// when the wallet reads a relay-balance relayer's info; tests may also open it directly.
const { RELAY_ROUTE } = await import("../web/src/relay.js");
RELAY_ROUTE.open = true;
const { RelayPayer } = await import("../web/src/payers.js");
const { STORAGE_PREFIX } = await import("../web/src/config.js");
const { Indexer, assetIdOf } = await import("../src/indexer.mjs");
const { Wallet } = await import("../src/wallet.mjs");
const { deriveKeys, encodeAddress } = await import("../src/keys.mjs");
const { decodeEnvelope, encodeDeploy, opReturnPayload, opReturnScript } = await import("../src/envelope.mjs");
const { hex, unhex } = await import("../src/bytes.mjs");
const { addressOf } = await import("../src/btc/funding.mjs");
const { parseRawTx } = await import("../src/btc/block.mjs");
const { FakeEsplora, makePaidRelayer, poolCoins } = await import("./fixtures/relay-harness.mjs");
const { createApp } = await import("../server/indexer-server.mjs");

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const START = 899_990;
const B = 900_000; // a 60-block boundary, so both lengths start an epoch here
const h32 = () => randomBytes(32).toString("hex");
const silent = { warn() {}, error() {}, log() {} };
const DEPOSITS = [7_000, 10_000, 10_000, 10_000]; // the session's relay balance: four credited deposits

/* ---------- fetch: every request the wallet makes, and a hook for one ---------- */

const realFetch = globalThis.fetch;
const seen = []; // { url, method, body, answer }
let hook = null; // async (url, init) -> void, runs before the request goes out
globalThis.fetch = async (url, init = {}) => {
  seen.push({ url: String(url), method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : null });
  const rec = seen.at(-1);
  if (hook) await hook(String(url), init);
  const res = await realFetch(url, init);
  if (rec.method === "POST") rec.answer = { status: res.status, body: await res.clone().json() };
  return res;
};
const worlds = [];
after(async () => {
  globalThis.fetch = realFetch;
  api.setIndexerBase("");
  for (const w of worlds) await w.close();
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});
const statusCalls = () => seen.filter((r) => r.url.includes("/api/relay/status/"));
const posts = () => seen.filter((r) => r.url.endsWith("/api/relay/submit") && r.method === "POST");
const submits = () => posts().map((r) => JSON.parse(r.body));

/* ---------- the relayer's esplora: it only records ---------- */

const txOf = (raw) => btc.Transaction.fromRaw(unhex(raw), { allowUnknownOutputs: true });
/** TRANSACT carriers the relayer broadcast so far, as envelope hex. */
const carried = (esplora) => esplora.accepted.map(txOf).map((tx) => hex(opReturnPayload(tx.getOutput(0).script) ?? new Uint8Array())).filter((p) => p.length === 942);

/* ---------- a chain, the real relayer and a wallet, all in process ---------- */

const carrierOf = (payload, first = randomBytes(36)) => ({ txid: h32(), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(payload), value: 0n }] });

/** WAL deployed at START; a 500-unit mint to Alice in each block of `mints`; the relayer ticks every block. */
async function world(mints) {
  const s = new S.Session({ phrase: S.newPhrase() });
  s.relayPayer = new RelayPayer(); // the real HTTP client; the session signs with its relay account
  const bob = new Wallet(deriveKeys(randomBytes(32)));
  const idx = new Indexer({ vkey: VKEY, startHeight: START, genesis: null });
  const esplora = new FakeEsplora();
  const relayer = await makePaidRelayer({ idx, esplora, log: silent, fastDelayMs: () => 600_000 });
  const account = { id: unhex(s.relayAccount.idHex), idHex: s.relayAccount.idHex, pubHex: s.relayAccount.pubHex };
  // Carriers never spend a deposit: each pool coin is a deposit merged into C (not counted as a broadcast below).
  const { merges } = await poolCoins({ relayer, esplora, values: DEPOSITS, account, height: idx.height });
  const setup = new Set(merges.map((m) => esplora.txs.get(m.txid)));
  esplora.calls = esplora.calls.filter((raw) => !setup.has(raw));
  esplora.accepted = esplora.accepted.filter((raw) => !setup.has(raw));
  const app = createApp({ idx, relayer, log: silent });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  api.setIndexerBase(`http://127.0.0.1:${app.server.address().port}`);
  const minter = new Wallet(s.keys);
  const asset = assetIdOf(START, 1);

  /** One block: `txs` plus whatever the relayer has in the mempool when `carry` is set. */
  async function mine(txs = [], { carry = false } = {}) {
    const height = idx.height + 1;
    const all = [...txs, ...(carry ? esplora.mine(height) : [])];
    await idx.applyBlock({ height, hash: h32(), txs: [{ txid: h32(), inputs: [], outputs: [] }, ...all] });
    await relayer.onTick({ chainTip: idx.height });
    app.publish();
    return { height, txids: all.map((t) => t.txid) };
  }
  await mine([carrierOf(encodeDeploy({ ticker: "WAL", divisibility: 0, mintAmount: 500n, mintCap: 50, priceSats: 0n, treasury: new Uint8Array() }))]);
  const w = {
    s, bob, idx, esplora, relayer, account, app, asset, mine,
    bobAddr: encodeAddress(bob.address),
    /** Mines up to `h` (Alice's mints on their blocks); mempool carriers are only mined with `carry`. */
    async to(h, opts) {
      while (idx.height < h) {
        if (mints.includes(idx.height + 1)) {
          const bind = randomBytes(36);
          await mine([carrierOf(await minter.mint(idx, { asset, mintAmount: 500n, bindOutpoint: bind }), bind)], opts);
        } else await mine([], opts);
      }
    },
    close: () => new Promise((r) => app.server.close(r)),
  };
  worlds.push(w);
  return w;
}

const nullifiersOf = (body) => decodeEnvelope(unhex(body.envelope)).nullifiers.map(String);
const anchorOf = (body) => decodeEnvelope(unhex(body.envelope)).anchor;

/* ---------- 1. Hourly and 10-hour batches, from Send to landed ---------- */

test("hourly and 10-hour batches: Scheduled, released whole at S+6 / S+60, landed at S+7 / S+61, notes unlocked", async () => {
  for (const k of ["relayMode", "selfMode"]) S.storage.removeItem(`${STORAGE_PREFIX}.${k}`);
  const w = await world([899_991, 899_992, 899_993, 899_994]);
  const { s, relayer, esplora } = w;
  await w.to(B + 2);
  await s.sync();
  const asset = s.asset("WAL");
  assert.equal(s.available(asset.id), 2000n);
  assert.deepEqual(relayer.capacity(), 59, "four deposits fund 59 carriers in one block");
  assert.deepEqual(relayer.books.account(w.account.idHex), { balance: 37_000 + 4 * 112 - 4 * 288, reserved: 0, nextIndex: 4 });

  // Three sends from one network: a 10-hour payment, an hourly payment, and a merge
  // without a mode (self-transfers default to the hourly batch). All anchored at B.
  seen.length = 0;
  const e10 = await s.send({ asset, amount: 100n, to: w.bobAddr, via: "relay", mode: "batch10" });
  const e1 = await s.send({ asset, amount: 100n, to: w.bobAddr, via: "relay", mode: "batch" });
  const em = await s.send({ asset, amount: 1000n, to: s.address, via: "relay" });
  const bodies = submits();
  assert.deepEqual(bodies.map((b) => [b.mode, anchorOf(b)]), [["batch10", B], ["batch", B], ["batch", B]]);
  for (const [e, mode, releaseAt, lastRelease] of [[e10, "batch10", B + 60, B + 88], [e1, "batch", B + 6, B + 76], [em, "batch", B + 6, B + 76]]) {
    assert.deepEqual(
      [e.mode, e.anchor, e.releaseAt, e.lastRelease, e.deadline, e.status, S.batchPhase(e, s.view.height)],
      [mode, B, releaseAt, lastRelease, B + 100, "relaying", "scheduled"],
    );
    assert.equal(relayer.status(e.relayId).status, "queued");
    assert.ok(e.spends.every((n) => s.wallet.locked.has(n)), "W-1: the notes are reserved");
  }
  assert.deepEqual([e1.epochQueued, em.epochQueued, e10.epochQueued], [1, 1, 1], "the count published at this block (none yet), this one included: never a live count");
  assert.deepEqual([relayer.batchQueued("batch", B), relayer.batchQueued("batch10", B), relayer.queuedCount()], [2, 1, 0]);
  assert.equal(s.available(asset.id), 0n);

  // B+3 .. B+5: nothing is broadcast, and the wallet asks the relayer nothing about them.
  seen.length = 0;
  for (let h = B + 3; h <= B + 5; h++) {
    await w.to(h);
    await s.sync();
    assert.deepEqual(esplora.accepted, [], `nothing broadcast at block ${h}`);
    assert.ok([e1, em, e10].every((e) => S.batchPhase(e, s.view.height) === "scheduled"));
  }
  assert.deepEqual(statusCalls(), [], "no per-id status call before releaseAt");

  // B+6: one flush carries the whole hourly epoch; the 10-hour item stays.
  await w.to(B + 6);
  assert.deepEqual(carried(esplora).sort(), [e1.envelope, em.envelope].sort());
  assert.deepEqual([relayer.status(e1.relayId).status, relayer.status(em.relayId).status, relayer.status(e10.relayId).status], ["broadcast", "broadcast", "queued"]);
  seen.length = 0;
  await s.sync();
  assert.equal(statusCalls().length, 2, "polled from releaseAt: the two hourly entries only");
  assert.ok(statusCalls().every((r) => !r.url.includes(e10.relayId)));
  assert.deepEqual([e1.relayStatus, S.batchPhase(e1, s.view.height), S.batchPhase(e10, s.view.height)], ["broadcast", "releasing", "scheduled"]);

  // B+7: the indexer accepts both carriers; the wallet shows them landed and the notes unlock.
  const { height, txids } = await w.mine([], { carry: true });
  assert.equal(height, B + 7);
  assert.equal(txids.length, 2);
  for (const t of txids) assert.equal(w.idx.log.find((l) => l.txid === t)?.ok, true, "accepted by the indexer");
  await s.sync();
  for (const e of [e1, em]) {
    assert.deepEqual([e.status, e.height, S.batchPhase(e, s.view.height)], ["accepted", B + 7, "landed"]);
    assert.ok(e.spends.every((n) => !s.wallet.locked.has(n)), "unlocked once landed");
    assert.deepEqual([relayer.status(e.relayId).status, relayer.status(e.relayId).height], ["accepted", B + 7]);
  }
  assert.equal(s.available(asset.id), 1400n, "the merged 1,000 and the 400 change are spendable");
  assert.ok(e10.spends.every((n) => s.wallet.locked.has(n)), "the 10-hour transfer still holds its note");
  assert.equal(w.bob.scan(w.idx).balance(w.asset), 100n);
  assert.deepEqual(relayer.info().batch.recent, [{ mode: "batch", start: B, releaseAt: B + 6, released: 2, landed: [[B + 7, 2]] }]);

  // B+59: the 10-hour item is still held. B+60: it goes out; B+61: it lands.
  await w.to(B + 59);
  await s.sync();
  assert.equal(carried(esplora).length, 2);
  assert.deepEqual([e10.status, S.batchPhase(e10, s.view.height)], ["relaying", "scheduled"]);
  await w.to(B + 60);
  assert.deepEqual(carried(esplora).slice(2), [e10.envelope]);
  const late = await w.mine([], { carry: true });
  assert.equal(late.height, B + 61);
  assert.equal(w.idx.log.find((l) => l.txid === late.txids[0])?.ok, true);
  await s.sync();
  assert.deepEqual([e10.status, e10.height, S.batchPhase(e10, s.view.height)], ["accepted", B + 61, "landed"]);
  assert.ok(e10.spends.every((n) => !s.wallet.locked.has(n)));
  assert.equal(s.available(asset.id), 1800n);
  assert.equal(w.bob.scan(w.idx).balance(w.asset), 200n);
  assert.deepEqual(relayer.info().batch.recent, [
    { mode: "batch10", start: B, releaseAt: B + 60, released: 1, landed: [[B + 61, 1]] },
    { mode: "batch", start: B, releaseAt: B + 6, released: 2, landed: [[B + 7, 2]] },
  ]);
  assert.deepEqual([relayer.books.account(w.account.idHex).reserved, relayer.pending.size], [0, 0]);
  assert.equal(relayer.books.account(w.account.idHex).balance, 37_000 + 4 * 112 - 4 * 288 - 3 * 658, "three carriers, each charged its fee plus margin");
  assert.equal(relayer.checkBooks().ok, true);
});

/* ---------- 2. epoch_closed: prove again for the next batch, same notes ---------- */

test("epoch_closed: the batch closes while proving; the wallet proves the same nullifiers for the next batch, which lands", async () => {
  const w = await world([899_991]);
  const { s, relayer, esplora } = w;
  await w.to(B + 4);
  await s.sync();
  const asset = s.asset("WAL");

  // The first submit reaches the relayer only after the chain has moved to B+6.
  let fired = false;
  hook = async (url, init) => {
    if (fired || !url.endsWith("/api/relay/submit") || init.method !== "POST") return;
    fired = true;
    await w.to(B + 6);
  };
  const steps = [];
  seen.length = 0;
  let entry;
  try {
    entry = await s.send({ asset, amount: 100n, to: w.bobAddr, via: "relay", mode: "batch", onStep: (e) => steps.push(e) });
  } finally {
    hook = null;
  }
  const [first, second] = submits();
  assert.equal(submits().length, 2);
  assert.deepEqual([anchorOf(first), anchorOf(second)], [B, B + 6]);
  assert.equal(posts()[0].answer.status, 422);
  assert.deepEqual(
    (({ code, mode, epochStart, releaseAt }) => ({ code, mode, epochStart, releaseAt }))(posts()[0].answer.body.error),
    { code: "epoch_closed", mode: "batch", epochStart: B + 6, releaseAt: B + 12 },
    "the real relayer refused the first proof",
  );
  assert.equal(posts()[1].answer.status, 202);
  assert.ok(entry.spends.every((n) => nullifiersOf(first).includes(n) && nullifiersOf(second).includes(n)), "the same notes, so the same nullifiers");
  assert.ok(steps.some((e) => e.id === "prove" && e.detail === "The batch closed while proving. Proving again for the next batch."));
  assert.deepEqual(
    [entry.mode, entry.anchor, entry.releaseAt, entry.lastRelease, entry.status, entry.envelope],
    ["batch", B + 6, B + 12, B + 82, "relaying", second.envelope],
  );
  assert.deepEqual(relayer.status(entry.relayId), { status: "queued", anchor: B + 6, deadline: B + 106, mode: "batch", releaseAt: B + 12, lastRelease: B + 82 });
  assert.equal(relayer.items.length, 1, "the refused envelope was never queued");
  assert.ok(entry.spends.every((n) => s.wallet.locked.has(n)));

  // Nothing before B+12; one carrier at B+12; landed at B+13.
  await w.to(B + 11);
  assert.deepEqual(esplora.accepted, []);
  await w.to(B + 12);
  assert.deepEqual(carried(esplora), [second.envelope]);
  const { height, txids } = await w.mine([], { carry: true });
  assert.equal(height, B + 13);
  assert.equal(w.idx.log.find((l) => l.txid === txids[0])?.ok, true);
  await s.sync();
  assert.deepEqual([entry.status, entry.height, S.batchPhase(entry, s.view.height)], ["accepted", B + 13, "landed"]);
  assert.ok(entry.spends.every((n) => !s.wallet.locked.has(n) && w.idx.nullifiers.has(n)));
  assert.equal(s.available(asset.id), 400n);
  assert.equal(w.bob.scan(w.idx).balance(w.asset), 100n);
});

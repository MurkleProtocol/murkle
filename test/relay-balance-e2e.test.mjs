// Relay balance end to end (docs/design/relay-balance.md, contract docs/design/relay-balance-contract.md):
// the wallet's own client code (web/src/relay.js over web/src/api.js) talks over real HTTP to
// server/indexer-server.mjs, which runs the paid relayer on a synthetic chain with FakeEsplora.
//
//   1. A wallet derives its relay account from its 24 words (web and CLI agree) and its deposit
//      address from the relayer's published pool key; the relayer's account reply agrees.
//   2. A deposit confirms; two parallel credit calls credit it once.
//   3. A relayed Next-block send is charged exactly fee + margin; the carrier spends only
//      credited deposits or the relayer's own change, pays change to C only; the indexer accepts
//      it; the books satisfy I2.
//   4. A send with too little balance is refused (402 balance_low) before any proof check, and
//      nothing is signed or broadcast.
//   5. In one batch epoch, an item whose balance is short at release becomes missed while another
//      account's item goes out on time.
//   6. An operator's coin sent to any relayer key is never counted or spent (I0).
//   7. The retired free-relayer key is refused as a new pool or change key.
//
// Fakes only: nothing is broadcast, nothing touches data/signet/, the server binds port 0.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { generateMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import {
  accountMod, booksMod, chain, makeFakeEsplora, makePaidRelayer, relayerMod, serverMod, signedSubmit, silent, synth, txOf,
} from "./fixtures/relay-harness.mjs";
import { equal, hex } from "../src/bytes.mjs";
import { opReturnScript } from "../src/envelope.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { relayAccountOf } from "../bin/murkle.mjs";
import { setIndexerBase, relay as relayApi } from "../web/src/api.js";
import { accountBalance, creditDeposit, routeState, setRelayRoute, submitEnvelope } from "../web/src/relay.js";

const { DEFAULTS, MISSED_REASON, startPaidRelayer } = relayerMod;
const { depositAddress, relayAccount } = accountMod;
const { costFor, marginFor } = booksMod;

const DIR = mkdtempSync(join(tmpdir(), "murkle-relay-e2e-"));
const relayers = [];
const servers = [];
after(async () => {
  relayers.forEach((r) => r.close());
  for (const s of servers) await new Promise((r) => s.close(r));
  setIndexerBase("");
  rmSync(DIR, { recursive: true, force: true });
});

const PER = 598; // one carrier at 1 sat/vB: one P2TR input, the OP_RETURN, change to C
const QUOTE = costFor(PER);
const SWEEP = 288;

/** A wallet: 24 words, and the relay account the web session and the CLI derive from them. */
function newWallet() {
  const words = generateMnemonic(wordlist, 256);
  const entropy = mnemonicToEntropy(words, wordlist);
  const web = relayAccount(entropy, "signet"); // web/src/session.js: relayAccount(entropy, NETWORK)
  const cli = relayAccountOf({ seed: hex(entropy) }, accountMod); // bin/murkle.mjs: the wallet file's seed
  assert.equal(cli.pubHex, web.pubHex, "web and CLI derive the same relay account");
  return web;
}

/** A synthetic chain, a fake esplora, the paid relayer after its first tick, and the HTTP server in front of it. */
async function world({ start = 864_000 } = {}) {
  const esplora = makeFakeEsplora({ fee: 1 });
  const c = chain({ start, fakes: [esplora] });
  await c.mine();
  const dir = mkdtempSync(join(DIR, "w-"));
  const r = await makePaidRelayer({ idx: c.idx, esplora, dir });
  relayers.push(r);
  const tick = () => r.onTick({ chainTip: c.idx.height });
  await tick();
  const app = serverMod.createApp({ idx: c.idx, relayer: r, log: silent });
  servers.push(app.server);
  await new Promise((ok) => app.server.listen(0, "127.0.0.1", ok));
  setIndexerBase(`http://127.0.0.1:${app.server.address().port}`);
  return {
    esplora, c, idx: c.idx, r, tick, dir,
    step: async () => {
      await c.mine();
      await tick();
    },
    land: async () => {
      await c.mineCarriers(esplora);
      await tick();
    },
  };
}

/** Pays `sats` to `address` from someone else's wallet (a plain payment), mined at the tip. -> outpoint */
function pay(w, script, sats, { mined = true } = {}) {
  const txid = w.esplora.pay([{ script, value: sats }], { height: mined ? w.idx.height : null });
  return { txid, outpoint: `${txid}:0` };
}

const errCode = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return null;
};

/** I0 and I1 on every transaction the relayer broadcast: inputs credited or own change, outputs the envelope and C only. */
function assertOnlyPoolCoins(w, depositScripts) {
  const own = w.r.ownTxids();
  for (const raw of w.esplora.accepted) {
    const tx = txOf(raw);
    for (let i = 0; i < tx.inputsLength; i++) {
      const key = `${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`;
      // Spent coins are pruned 6 blocks after their spender confirms; the credit records and the journal stay.
      const credit = w.r.books.isCredited(key);
      if (credit) assert.equal(credit.reversed, undefined, "a credited deposit that was not reversed");
      else assert.ok(own.has(hex(tx.getInput(i).txid)), `${key} is change of the relayer's own transaction`);
    }
    for (let v = 0; v < tx.outputsLength; v++) {
      const script = tx.getOutput(v).script;
      if (v === 0 && script[0] === 0x6a) continue;
      assert.ok(equal(script, w.r.change.script), `output ${v} pays the change key C`);
      assert.ok(!depositScripts.some((d) => equal(d, script)), "never a deposit address");
    }
  }
}

test("a wallet tops up, is credited once, relays a Next-block send charged fee + margin, and the indexer accepts the carrier; I2 holds", async () => {
  const w = await world();
  const wallet = newWallet();

  // 1. The relay route opens from the server's info; the deposit address is the wallet's own derivation.
  const info = await relayApi.info();
  assert.equal(setRelayRoute(info), true, "a relay-balance relayer opens the route");
  assert.equal(info.balance.poolKey, w.r.poolHex);
  assert.equal(routeState(info, null), "unknown");
  const first = await accountBalance({ account: wallet, info });
  assert.deepEqual([first.balance, first.reserved, first.nextIndex, first.credits], [0, 0, 0, []], "a new account reads zeros, not 404");
  assert.equal(first.accountId, wallet.idHex);
  const dep0 = depositAddress(info.balance.poolKey, wallet.id, 0, info.network);
  assert.equal(first.depositAddress, dep0.address, "the relayer's deposit address #0 is the wallet's own");
  assert.match(dep0.address, /^tb1p/);
  assert.equal(routeState(info, first), "none");

  // 2. A plain payment to deposit address #0 (no OP_RETURN). Unconfirmed: not credited yet.
  const sats = 7000;
  const unconfirmed = pay(w, dep0.script, sats, { mined: false });
  const waiting = await errCode(creditDeposit({ outpoint: unconfirmed.outpoint, accountPub: wallet.pubHex, n: 0 }));
  assert.equal(waiting, "deposit_unconfirmed");
  w.esplora.confirm([unconfirmed.txid], w.idx.height); // one confirmation (signet)
  // Two tabs credit it at the same time: credited exactly once.
  const both = await Promise.allSettled([0, 1].map(() => creditDeposit({ outpoint: unconfirmed.outpoint, accountPub: wallet.pubHex, n: 0 })));
  const fresh = both.filter((x) => x.status === "fulfilled" && x.value.already === false);
  assert.equal(fresh.length, 1, "exactly one call credits it");
  assert.equal(fresh[0].value.amount, sats - SWEEP);
  for (const x of both) {
    if (x.status === "fulfilled") assert.equal(x.value.credited, true);
    else assert.equal(x.reason.code, "credit_in_progress", "the other one is told to try again");
  }
  const repeat = await creditDeposit({ outpoint: unconfirmed.outpoint, accountPub: wallet.pubHex, n: 0 });
  assert.deepEqual([repeat.credited, repeat.already], [true, true], "a retry returns the same credit");
  const funded = await accountBalance({ account: wallet, info });
  assert.deepEqual([funded.balance, funded.reserved, funded.nextIndex], [sats - SWEEP, 0, 1], "credited once: value minus the sweep cost");
  assert.equal(funded.depositAddress, depositAddress(info.balance.poolKey, wallet.id, 1, info.network).address, "the next top-up gets a fresh address");
  assert.equal(w.r.checkBooks().ok, true);

  // 3. A relayed Next-block send, signed by the wallet's client code.
  const envelope = synth(w.idx);
  const accepted = await submitEnvelope(envelope, { mode: "block", account: wallet });
  assert.equal(accepted.status, "queued");
  assert.equal(accepted.reservedSats, QUOTE, "a Next-block send reserves one quote");
  assert.equal(accepted.balance, sats - SWEEP - QUOTE);
  assert.equal(w.r.pending.size, 2, "its two nullifiers are pending at the relayer");
  assert.equal(w.esplora.accepted.length, 0, "Next block: nothing goes out before the next block");
  await w.step();
  const st = await relayApi.status(accepted.id);
  assert.equal(st.status, "broadcast");
  const tx = txOf(w.esplora.txs.get(st.txid));
  assert.ok(equal(tx.getOutput(0).script, opReturnScript(envelope)), "output 0 is the exact envelope");
  let inSum = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    inSum += Number(parseRawTx(w.esplora.txs.get(hex(inp.txid))).outputs[inp.index].value);
  }
  let outSum = 0;
  for (let v = 0; v < tx.outputsLength; v++) outSum += Number(tx.getOutput(v).amount);
  const fee = inSum - outSum;
  assert.equal(fee, PER);
  assert.equal(st.cost, fee + marginFor(fee), "charged the on-chain fee plus the margin");
  const after1 = await accountBalance({ account: wallet, info });
  assert.deepEqual([after1.balance, after1.reserved], [sats - SWEEP - (fee + marginFor(fee)), 0], "debited exactly fee + margin");
  assertOnlyPoolCoins(w, [dep0.script]);
  // The saved state forgot the account once the carrier was broadcast.
  const saved = readFileSync(join(w.dir, "relay-balance", "relayer.json"), "utf8");
  assert.equal(JSON.parse(saved).items[accepted.id].account, undefined);

  // The indexer accepts the carrier; the relayer reconciles it.
  await w.land();
  assert.equal((await relayApi.status(accepted.id)).status, "accepted");
  const env = (await import("../src/envelope.mjs")).decodeEnvelope(envelope);
  for (const n of env.nullifiers) assert.ok(w.idx.nullifiers.has(String(n)), "its nullifiers are spent on the indexer");
  assert.ok(w.idx.log.some((l) => l.txid === st.txid && l.ok === true), "the indexer accepted the carrier");
  const books = w.r.checkBooks();
  assert.equal(books.ok, true, books.problems.join("; "));
  assert.ok(w.r.poolUnspent() >= w.r.books.liabilities(), "the pool covers balances, reservations and margin");
  assert.equal(w.esplora.utxoCalls, 0, "no address was ever listed");
});

test("too little balance: 402 balance_low before any proof check, and nothing is signed or broadcast", async () => {
  const w = await world();
  const info = await relayApi.info();
  setRelayRoute(info);
  const broke = newWallet();
  const low = newWallet();
  // 2,000 sats credits 1,712; at 3 sat/vB one carrier costs about 1,974.
  const dep = depositAddress(info.balance.poolKey, low.id, 0, info.network);
  const p = pay(w, dep.script, 2000);
  assert.equal((await creditDeposit({ outpoint: p.outpoint, accountPub: low.pubHex, n: 0 })).amount, 1712);
  w.esplora.fee = 3;
  await w.step();
  const info3 = await relayApi.info();
  assert.ok(info3.balance.perSendSats > 1712);

  const before = { calls: w.esplora.calls.length, items: Object.keys(w.r.state.items).length, proofs: w.idx.proofChecks, books: JSON.stringify(w.r.books.toJSON()) };
  for (const account of [broke, low]) {
    for (const mode of ["block", "fast"]) {
      let err;
      try {
        await submitEnvelope(synth(w.idx), { mode, account });
      } catch (e) {
        err = e;
      }
      assert.equal(err?.code, "balance_low", `${mode}: refused`);
      assert.equal(err.status, 402);
      assert.equal(err.needed, info3.balance.perSendSats);
    }
  }
  await w.step();
  assert.equal(w.idx.proofChecks, before.proofs, "refused before any proof check");
  assert.equal(Object.keys(w.r.state.items).length, before.items, "nothing queued");
  assert.equal(w.esplora.calls.length, before.calls, "nothing signed or broadcast");
  assert.equal(JSON.stringify(w.r.books.toJSON()), before.books, "the books did not move");
  assert.equal(w.r.checkBooks().ok, true);
});

test("one batch epoch: an item whose balance is short at release becomes missed; another account's item goes out on time", async () => {
  const w = await world({ start: 864_000 });
  const S = w.idx.height;
  assert.equal(S % 6, 0, "an hourly epoch starts here");
  const info = await relayApi.info();
  setRelayRoute(info);
  const rich = newWallet();
  const short = newWallet();
  for (const [acct, sats] of [[rich, 7000], [short, 2000]]) {
    const dep = depositAddress(info.balance.poolKey, acct.id, 0, info.network);
    const p = pay(w, dep.script, sats);
    assert.equal((await creditDeposit({ outpoint: p.outpoint, accountPub: acct.pubHex, n: 0 })).credited, true);
  }
  const ids = {};
  for (const [name, acct] of [["rich", rich], ["short", short]]) {
    const out = await submitEnvelope(synth(w.idx, S), { mode: "batch", account: acct });
    assert.equal(out.reservedSats, 2 * QUOTE, "a batch send reserves twice the quote");
    assert.equal(out.releaseAt, S + 6);
    ids[name] = out.id;
  }
  while (w.idx.height < S + 5) await w.step();
  assert.equal(w.esplora.carriers().length, 0, "nothing before the release");
  w.esplora.fee = 3; // the carrier now costs about 1,974: more than the short account has
  await w.step();
  assert.equal(w.idx.height, S + 6);
  const rs = await relayApi.status(ids.rich);
  assert.equal(rs.status, "broadcast", "the other account's item went out at releaseAt");
  const ms = await relayApi.status(ids.short);
  assert.deepEqual([ms.status, ms.code, ms.reason], ["missed", "balance_low", MISSED_REASON.balance_low]);
  assert.equal(ms.txid, undefined);
  const shortNow = await accountBalance({ account: short, info });
  assert.deepEqual([shortNow.balance, shortNow.reserved], [1712, 0], "its reservation came back; nothing charged");
  const richNow = await accountBalance({ account: rich, info });
  assert.equal(richNow.balance, 6712 - rs.cost, "exact cost at release, the rest of the reservation returned");
  assert.equal(w.esplora.carriers().length, 1);
  // A top-up afterwards never sends the missed item.
  const dep1 = depositAddress(info.balance.poolKey, short.id, 1, info.network);
  const p = pay(w, dep1.script, 9000);
  w.esplora.fee = 1;
  assert.equal((await creditDeposit({ outpoint: p.outpoint, accountPub: short.pubHex, n: 1 })).credited, true);
  for (let i = 0; i < 4; i++) await w.land();
  assert.equal(w.esplora.carriers().length, 1);
  assert.equal((await relayApi.status(ids.short)).status, "missed");
  assert.equal(w.r.checkBooks().ok, true);
});

test("an operator's coin sent to Q, C or an uncredited deposit address is never counted or spent", async () => {
  const w = await world();
  const info = await relayApi.info();
  setRelayRoute(info);
  const wallet = newWallet();
  const dep0 = depositAddress(info.balance.poolKey, wallet.id, 0, info.network);
  const dep5 = depositAddress(info.balance.poolKey, wallet.id, 5, info.network);
  const poolBefore = w.r.poolUnspent();
  // The operator "funds the relayer" by paying its keys directly: large confirmed coins.
  const foreign = [
    pay(w, btc.p2tr(w.r.Q, undefined, btc.TEST_NETWORK).script, 1_000_000),
    pay(w, w.r.change.script, 1_000_000),
    pay(w, dep5.script, 1_000_000),
  ];
  await w.step();
  assert.equal(w.r.poolUnspent(), poolBefore, "foreign coins are not pool money");
  for (const f of foreign) assert.equal(w.r.state.coins[f.outpoint], undefined);
  for (const f of foreign) assert.throws(() => w.r.assertProvenance([{ txid: f.txid, vout: 0 }]), /^Error: I0: /);
  // Without a credited deposit nothing can be relayed, however much sits at the relayer's keys.
  assert.equal(await errCode(submitEnvelope(synth(w.idx), { mode: "block", account: wallet })), "balance_low");
  // The payment to C is not a deposit of any account.
  assert.equal(await errCode(creditDeposit({ outpoint: foreign[1].outpoint, accountPub: wallet.pubHex, n: 0 })), "deposit_mismatch");

  // A real top-up, then sends: every carrier spends the credited deposit or the relayer's own change.
  const p = pay(w, dep0.script, 12_000);
  assert.equal((await creditDeposit({ outpoint: p.outpoint, accountPub: wallet.pubHex, n: 0 })).credited, true);
  for (let i = 0; i < 4; i++) {
    const out = await submitEnvelope(synth(w.idx), { mode: "block", account: wallet });
    assert.equal(out.status, "queued");
    await w.step();
    await w.land();
  }
  assert.equal(w.esplora.carriers().length, 4);
  for (const f of foreign) assert.equal(w.esplora.spentBy.has(f.outpoint), false, "the operator's coin was never spent");
  assertOnlyPoolCoins(w, [dep0.script, dep5.script]);
  const books = w.r.checkBooks();
  assert.equal(books.ok, true, books.problems.join("; "));
  assert.equal(w.r.poolUnspent(), w.r.books.liabilities(), "the pool holds exactly what it owes, nothing of the operator's");
});

test("the retired free-relayer key is refused as a new pool or change key; the old files stay as they were", async () => {
  const root = mkdtempSync(join(DIR, "old-key-"));
  const old = hex(randomBytes(32));
  writeFileSync(join(root, "relayer.key"), old);
  writeFileSync(join(root, "relayer.json"), JSON.stringify({ version: 1, items: {}, ledger: [] }));
  const before = [readFileSync(join(root, "relayer.key"), "utf8"), readFileSync(join(root, "relayer.json"), "utf8")];
  const esplora = makeFakeEsplora();
  const c = chain({ fakes: [esplora] });
  await c.mine();
  const config = { ...DEFAULTS, enabled: true, relayMode: "balance", keyPath: "relayer.key", statePath: "relayer.json", fanoutTarget: 0 };
  for (const name of ["pool.key", "change.key"]) {
    const relayDir = `reuse-${name}`;
    mkdirSync(join(root, relayDir), { recursive: true });
    copyFileSync(join(root, "relayer.key"), join(root, relayDir, name));
    await assert.rejects(
      startPaidRelayer({ idx: c.idx, esplora, config: { ...config, relayDir }, root, log: silent }),
      /equals the retired relayer key; it is never pool money again/,
      name,
    );
    assert.equal(existsSync(join(root, relayDir, "relayer.json")), false, "no state was written");
  }
  // Pointing the new directory at the old files is refused too.
  await assert.rejects(startPaidRelayer({ idx: c.idx, esplora, config: { ...config, relayDir: "." }, root, log: silent }), /retired free relayer/);
  // A fresh directory starts with new keys that differ from the old one.
  const r = await startPaidRelayer({ idx: c.idx, esplora, config: { ...config, relayDir: "fresh" }, root, log: silent });
  relayers.push(r);
  assert.notEqual(readFileSync(join(root, "fresh", "pool.key"), "utf8"), old);
  assert.notEqual(readFileSync(join(root, "fresh", "change.key"), "utf8"), old);
  assert.deepEqual([readFileSync(join(root, "relayer.key"), "utf8"), readFileSync(join(root, "relayer.json"), "utf8")], before, "the retired key and v1 state are unchanged");
  // And the signed submit helper agrees with the wallet client on the wire format.
  const a = newWallet();
  const body = JSON.parse(signedSubmit(a, r.info(), synth(c.idx), "block"));
  assert.deepEqual(Object.keys(body).sort(), ["accountPub", "envelope", "mode", "sig", "t"]);
});

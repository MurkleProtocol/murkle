// Relay balance books (server/relay-books.mjs): contract
// docs/design/relay-balance-contract.md §2, §3 (I2) and §8 "shared".
// Pure bookkeeping; files only in a temporary directory.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  BOOKS_VERSION, BooksError, RelayBooks, costFor, loadBooks, marginFor, saveBooks, sweepCostFor,
} from "../server/relay-books.mjs";

const tmp = mkdtempSync(join(tmpdir(), "murkle-books-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const h64 = (s) => createHash("sha256").update(s).digest("hex");
const KEYS = Object.freeze({ network: "signet", poolKey: h64("pool"), changeKey: h64("change") });
const ALICE = h64("alice");
const BOB = h64("bob");
const txid = (s) => h64(`tx:${s}`);
const op = (s, vout = 0) => `${txid(s)}:${vout}`;
const SWEEP = sweepCostFor(5); // 288
const fresh = () => new RelayBooks({ ...KEYS });
const err = (code) => (e) => e instanceof BooksError && e.code === code;
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const POOL = (b) => b.checkI2({ poolUnspent: b.liabilities() });

test("fee arithmetic: margin floor and percentage, cost, sweep cost", () => {
  assert.equal(BOOKS_VERSION, 1);
  const cases = [[1, 50], [499, 50], [500, 50], [501, 51], [597, 60], [3000, 300]];
  for (const [fee, margin] of cases) {
    assert.equal(marginFor(fee), margin, `marginFor(${fee})`);
    assert.equal(costFor(fee), fee + margin, `costFor(${fee})`);
  }
  assert.equal(marginFor(597, { marginPct: 0, marginMinSats: 1 }), 1);
  assert.equal(marginFor(1000, { marginPct: 25, marginMinSats: 50 }), 250);
  assert.equal(costFor(597, { marginPct: 20, marginMinSats: 10 }), 597 + 120);
  assert.equal(sweepCostFor(5), 288);
  assert.equal(sweepCostFor(1), 58);
  assert.equal(sweepCostFor(2), 115);
});

test("constructor refuses an unknown network, malformed or equal keys and bad margin settings", () => {
  for (const bad of [
    { ...KEYS, network: "regtest" }, { ...KEYS, poolKey: KEYS.poolKey.toUpperCase() }, { ...KEYS, changeKey: "00" },
    { ...KEYS, changeKey: KEYS.poolKey }, { ...KEYS, marginPct: 101 }, { ...KEYS, marginPct: 1.5 }, { ...KEYS, marginMinSats: 0 },
  ]) {
    assert.throws(() => new RelayBooks(bad), err("invalid"), JSON.stringify(bad));
  }
  const b = new RelayBooks({ ...KEYS, marginPct: 20, marginMinSats: 10 });
  assert.deepEqual(b.marginOpts, { marginPct: 20, marginMinSats: 10 });
});

test("a credit: balance value − sweepCost, sweepCost to the margin, nextIndex, the record and the contract example", () => {
  const b = fresh();
  assert.deepEqual(b.account(ALICE), { balance: 0, reserved: 0, nextIndex: 0 });
  assert.deepEqual(b.toJSON().accounts, {}, "reading an unknown account creates nothing");
  const rec = b.credit({ key: op("d1"), id: ALICE, n: 0, value: 7000, sweepCost: SWEEP, height: 324700 });
  assert.deepEqual(rec, { outpoint: op("d1"), id: ALICE, n: 0, value: 7000, sweepCost: 288, amount: 6712, height: 324700 });
  assert.deepEqual(b.account(ALICE), { balance: 6712, reserved: 0, nextIndex: 1 });
  assert.equal(b.margin, 288);
  assert.deepEqual(b.totals, { credited: 7000, fees: 0 });
  assert.deepEqual(b.isCredited(op("d1")), rec);
  assert.equal(b.isCredited(op("d2")), null);
  assert.deepEqual(b.credits(ALICE), [{ outpoint: op("d1"), n: 0, value: 7000, amount: 6712, height: 324700 }]);
  assert.deepEqual(b.credits(BOB), []);

  // Batch send: reserve 2 × quote, settle the exact cost.
  const quote = costFor(597);
  assert.equal(quote, 657);
  b.reserve("item0001", ALICE, 2 * quote);
  assert.deepEqual(b.account(ALICE), { balance: 6712 - 1314, reserved: 1314, nextIndex: 1 });
  assert.deepEqual(b.settle("item0001", { fee: 597 }), { cost: 657, fee: 597, margin: 60 });
  assert.deepEqual(b.account(ALICE), { balance: 6055, reserved: 0, nextIndex: 1 });
  const j = b.toJSON();
  assert.equal(j.margin, 348);
  assert.deepEqual(j.totals, { credited: 7000, fees: 597 });
  assert.deepEqual(j.charges, { item0001: { id: ALICE, cost: 657, fee: 597 } });
  assert.deepEqual(j.reservations, {});
  assert.ok(POOL(b).ok);

  // Later and older deposit addresses: nextIndex is the highest paid n + 1.
  b.credit({ key: op("d2", 3), id: ALICE, n: 5, value: 2000, sweepCost: SWEEP, height: 324702 });
  b.credit({ key: op("d3"), id: ALICE, n: 2, value: 3000, sweepCost: SWEEP, height: 324701 });
  assert.equal(b.account(ALICE).nextIndex, 6);
  assert.deepEqual(b.credits(ALICE).map((c) => c.n), [5, 2, 0], "newest first");
  assert.deepEqual(b.credits(ALICE, { limit: 2 }).map((c) => c.n), [5, 2]);
  assert.ok(POOL(b).ok);
});

test("credit refuses bad inputs and never credits a deposit that does not cover its sweep cost", () => {
  const b = fresh();
  const base = { key: op("x"), id: ALICE, n: 0, value: 5000, sweepCost: SWEEP, height: 1 };
  for (const bad of [
    { id: ALICE.toUpperCase() }, { id: "ab" }, { n: -1 }, { n: 2 ** 31 }, { n: 1.5 }, { value: 0 }, { value: 288 }, { value: 1.5 },
    { value: "5000" }, { sweepCost: -1 }, { height: -1 }, { height: 1.5 },
  ]) {
    assert.throws(() => b.credit({ ...base, ...bad }), err("invalid"), JSON.stringify(bad));
  }
  assert.deepEqual(b.toJSON().credits, {});
  assert.equal(b.credit({ ...base, value: 289 }).amount, 1, "one sat over the sweep cost is credited");
  assert.equal(b.credit({ ...base, key: op("y"), height: undefined }).height, null, "height may be unknown");
});

test("20 parallel credit flows of one outpoint credit it once", async () => {
  const b = fresh();
  const key = op("parallel", 1);
  const outcomes = [];
  // The relayer's flow: idempotent check, claim before any await, explorer (await), credit, unclaim.
  const flow = async (i) => {
    if (b.isCredited(key)) return "already";
    if (!b.claim(key)) return "in_progress";
    try {
      await tick(1 + ((i * 7) % 5));
      if (b.isCredited(key)) return "already";
      b.credit({ key, id: ALICE, n: 0, value: 9000, sweepCost: SWEEP, height: 100 });
      return "credited";
    } finally {
      b.unclaim(key);
    }
  };
  outcomes.push(...(await Promise.all(Array.from({ length: 20 }, (_, i) => flow(i)))));
  assert.equal(outcomes.filter((o) => o === "credited").length, 1, outcomes.join(","));
  assert.equal(outcomes.filter((o) => o === "in_progress").length, 19);
  // A second wave after the first finished: every call sees the existing credit.
  const second = await Promise.all(Array.from({ length: 20 }, (_, i) => flow(i)));
  assert.deepEqual(new Set(second), new Set(["already"]));
  assert.equal(b.claim(key), false, "a credited key cannot be claimed");
  assert.throws(() => b.credit({ key, id: ALICE, n: 0, value: 9000, sweepCost: SWEEP, height: 100 }), err("already_credited"));
  assert.deepEqual(b.account(ALICE), { balance: 9000 - SWEEP, reserved: 0, nextIndex: 1 });
  assert.equal(b.totals.credited, 9000);
  assert.equal(Object.keys(b.toJSON().credits).length, 1);
  assert.ok(POOL(b).ok);
});

test("a failed flow releases its claim; claims are memory only", () => {
  const b = fresh();
  const key = op("claim");
  assert.equal(b.claim(key), true);
  assert.equal(b.claim(key), false);
  b.unclaim(key);
  assert.equal(b.claim(key), true, "claimable again after unclaim");
  assert.ok(!JSON.stringify(b.toJSON()).includes(txid("claim")), "a claim is never persisted");
  const restored = RelayBooks.restore(b.toJSON(), KEYS);
  assert.equal(restored.claim(key), true, "a restart drops claims (nothing was credited)");
  b.unclaim(op("never claimed")); // harmless
});

test("spelling variants of a credited outpoint are refused (bad_key) and never create a second credit", () => {
  const b = fresh();
  const t = txid("variants");
  b.credit({ key: `${t}:1`, id: ALICE, n: 0, value: 5000, sweepCost: SWEEP, height: 1 });
  const variants = [
    `${t.toUpperCase()}:1`, `${t.slice(0, t.search(/[a-f]/))}${t[t.search(/[a-f]/)].toUpperCase()}${t.slice(t.search(/[a-f]/) + 1)}:1`, `${t}:01`, `${t}:+1`, `${t}: 1`, `${t}:1 `, ` ${t}:1`,
    `${t}:1.0`, `${t}:1e0`, `${t}:0x1`, `${t}`, `${t}:1:1`, `${t}:4294967296`, "", null, 1,
  ];
  for (const v of variants) {
    assert.throws(() => b.credit({ key: v, id: BOB, n: 0, value: 5000, sweepCost: SWEEP, height: 1 }), err("bad_key"), String(v));
    assert.throws(() => b.claim(v), err("bad_key"), String(v));
    assert.throws(() => b.isCredited(v), err("bad_key"), String(v));
    assert.throws(() => b.reverseCredit(v), err("bad_key"), String(v));
  }
  assert.equal(Object.keys(b.toJSON().credits).length, 1);
  assert.deepEqual(b.account(BOB), { balance: 0, reserved: 0, nextIndex: 0 });
  assert.equal(b.totals.credited, 5000);
  assert.ok(POOL(b).ok);
});

test("a credit survives saveBooks / loadBooks and is not repeated after it", () => {
  const path = join(tmp, "survive", "books.json");
  assert.ok(!existsSync(path));
  const empty = loadBooks(path, KEYS);
  assert.deepEqual(empty.toJSON(), fresh().toJSON(), "a missing file gives new books");
  const b = fresh();
  b.credit({ key: op("s1"), id: ALICE, n: 0, value: 7000, sweepCost: SWEEP, height: 10 });
  b.reserve("pending1", ALICE, 1314);
  b.reserve("pending2", ALICE, 657);
  b.settle("pending2", { fee: 597 });
  saveBooks(path, b);
  assert.deepEqual(readdirSync(join(tmp, "survive")), ["books.json"], "no temporary file left behind");
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), b.toJSON());

  const r = loadBooks(path, KEYS);
  assert.deepEqual(r.toJSON(), b.toJSON());
  assert.deepEqual(r.account(ALICE), b.account(ALICE));
  assert.ok(r.isCredited(op("s1")));
  assert.equal(r.claim(op("s1")), false);
  assert.throws(() => r.credit({ key: op("s1"), id: ALICE, n: 0, value: 7000, sweepCost: SWEEP, height: 10 }), err("already_credited"));
  assert.throws(() => r.credit({ key: op("s1"), id: BOB, n: 3, value: 7000, sweepCost: SWEEP, height: 10 }), err("already_credited"));
  // The restored books keep working: the reservation and the charge are still there.
  r.release("pending1");
  r.confirmCharge("pending2");
  assert.deepEqual(r.account(ALICE), { balance: 6712 - 657, reserved: 0, nextIndex: 1 });
  assert.ok(POOL(r).ok);
  saveBooks(path, r);
  assert.deepEqual(loadBooks(path, KEYS).toJSON(), r.toJSON(), "a second save overwrites atomically");
  // The margin settings come from the caller, not the file.
  assert.equal(loadBooks(path, { ...KEYS, marginPct: 20, marginMinSats: 1 }).marginOpts.marginPct, 20);
});

test("reserve / settle / release: 2x reservation, exact charge, the rest returned; a short settle changes nothing", () => {
  const b = fresh();
  b.credit({ key: op("r1"), id: ALICE, n: 0, value: 3000, sweepCost: SWEEP, height: 1 }); // 2712
  assert.throws(() => b.reserve("big", ALICE, 2713), (e) => err("balance_low")(e) && e.extra.balance === 2712 && e.extra.needed === 2713);
  assert.throws(() => b.reserve("nobody", BOB, 1), (e) => err("balance_low")(e) && e.extra.balance === 0);
  assert.deepEqual(b.toJSON().accounts[BOB], undefined, "a refused reserve creates no account");
  assert.throws(() => b.reserve("zero", ALICE, 0), err("invalid"));
  assert.throws(() => b.reserve("bad ref!", ALICE, 10), err("invalid"));

  // Exact fee lower than the quote: the difference comes back.
  b.reserve("a1", ALICE, 1314);
  assert.throws(() => b.reserve("a1", ALICE, 10), err("invalid"), "one reservation per item");
  assert.deepEqual(b.settle("a1", { fee: 400 }), { cost: 450, fee: 400, margin: 50 });
  assert.deepEqual(b.account(ALICE), { balance: 2712 - 450, reserved: 0, nextIndex: 1 });
  assert.throws(() => b.reserve("a1", ALICE, 10), err("invalid"), "an item with a charge cannot reserve again");

  // Exact cost above the reservation: the rest comes from the available balance.
  b.reserve("a2", ALICE, 600);
  assert.deepEqual(b.settle("a2", { fee: 900 }), { cost: 990, fee: 900, margin: 90 });
  assert.deepEqual(b.account(ALICE), { balance: 2262 - 990, reserved: 0, nextIndex: 1 });

  // Short: reservation + balance below the cost. Nothing changes.
  b.reserve("a3", ALICE, 1000);
  const before = JSON.stringify(b.toJSON());
  assert.throws(() => b.settle("a3", { fee: 1200 }), (e) => err("balance_low")(e) && e.extra.balance === 1272 && e.extra.needed === 1320);
  assert.equal(JSON.stringify(b.toJSON()), before);
  // Release returns the whole reservation.
  assert.deepEqual(b.release("a3"), { id: ALICE, amount: 1000 });
  assert.deepEqual(b.account(ALICE), { balance: 1272, reserved: 0, nextIndex: 1 });
  assert.throws(() => b.release("a3"), err("unknown_ref"));
  assert.throws(() => b.settle("a3", { fee: 10 }), err("unknown_ref"));
  b.reserve("a4", ALICE, 100);
  for (const fee of [0, -1, 1.5, undefined]) assert.throws(() => b.settle("a4", { fee }), err("invalid"), String(fee));
  assert.ok(POOL(b).ok);
});

test("confirmCharge drops the only account link of an item; refundCharge undoes settle exactly", () => {
  const b = fresh();
  b.credit({ key: op("c1"), id: ALICE, n: 0, value: 7000, sweepCost: SWEEP, height: 1 });
  const ref = "0123456789abcdef0123456789abcdef";
  b.reserve(ref, ALICE, 1314);
  let s = JSON.stringify(b.toJSON());
  assert.ok(s.includes(ref) && s.includes(ALICE));
  b.settle(ref, { fee: 597 });
  assert.ok(JSON.stringify(b.toJSON()).includes(ref), "the charge links the item until it is broadcast");
  assert.deepEqual(b.confirmCharge(ref), { cost: 657, fee: 597 });
  s = JSON.stringify(b.toJSON());
  assert.ok(!s.includes(ref), "no item id after confirm");
  assert.throws(() => b.confirmCharge(ref), err("unknown_ref"));
  assert.throws(() => b.refundCharge(ref), err("unknown_ref"));

  const ref2 = "fedcba9876543210fedcba9876543210";
  b.reserve(ref2, ALICE, 657);
  b.release(ref2);
  assert.ok(!JSON.stringify(b.toJSON()).includes(ref2), "no item id after release");

  const ref3 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const before = b.toJSON();
  b.reserve(ref3, ALICE, 1314);
  b.settle(ref3, { fee: 700 });
  assert.deepEqual(b.refundCharge(ref3), { id: ALICE, cost: 770, fee: 700 });
  const afterRefund = b.toJSON();
  assert.deepEqual(afterRefund, before, "refund after a full-reservation release is the state before reserve");
  assert.ok(!JSON.stringify(afterRefund).includes(ref3));
  // Nothing in the books is a txid: every 64-hex string is an account id or keys, and outpoints only as credit keys.
  const j = b.toJSON();
  const strings = JSON.stringify(j).match(/[0-9a-f]{64}/g);
  const allowed = new Set([KEYS.poolKey, KEYS.changeKey, ALICE, txid("c1")]);
  for (const x of strings) assert.ok(allowed.has(x), x);
  assert.ok(POOL(b).ok);
});

test("housekeeping is paid from the margin only; penalties and reclaims move sats to the margin", () => {
  const b = fresh();
  b.credit({ key: op("h1"), id: ALICE, n: 0, value: 2500, sweepCost: SWEEP, height: 1 });
  assert.equal(b.margin, 288);
  assert.throws(() => b.payHousekeeping(289), (e) => err("margin_low")(e) && e.extra.margin === 288 && e.extra.needed === 289);
  assert.equal(b.margin, 288);
  assert.deepEqual(b.payHousekeeping(200), { fee: 200, margin: 88 });
  assert.equal(b.totals.fees, 200);
  assert.deepEqual(b.account(ALICE).balance, 2212, "housekeeping never touches a user balance");
  b.refundHousekeeping(200);
  assert.equal(b.margin, 288);
  assert.equal(b.totals.fees, 0);
  assert.throws(() => b.refundHousekeeping(1), err("invalid"), "never more than was paid");
  assert.throws(() => b.payHousekeeping(0), err("invalid"));

  assert.equal(b.penalize(ALICE, 50), 50);
  assert.equal(b.account(ALICE).balance, 2162);
  assert.equal(b.margin, 338);
  assert.equal(b.penalize(BOB, 50), 0, "no balance, nothing moved");
  assert.deepEqual(b.toJSON().accounts[BOB], undefined);
  assert.equal(b.penalize(ALICE, 10 ** 6), 2162, "never below zero");
  assert.equal(b.account(ALICE).balance, 0);
  assert.ok(POOL(b).ok);

  b.payHousekeeping(300);
  assert.deepEqual(b.reclaim(120), { sats: 120, margin: b.margin });
  assert.equal(b.totals.fees, 180);
  assert.throws(() => b.reclaim(181), err("invalid"));
  assert.ok(POOL(b).ok);
});

test("housekeeping never spends the margin of an unconfirmed charge, so a refund cannot push the margin below zero", () => {
  const b = fresh();
  b.credit({ key: op("m1"), id: ALICE, n: 0, value: 10000, sweepCost: SWEEP, height: 1 });
  b.reserve("pend", ALICE, 3300);
  b.settle("pend", { fee: 3000 }); // margin 288 + 300, of which 300 is pending
  assert.equal(b.margin, 588);
  assert.equal(b.availableMargin(), 288);
  assert.throws(() => b.payHousekeeping(289), (e) => err("margin_low")(e) && e.extra.margin === 288);
  b.payHousekeeping(288);
  assert.equal(b.availableMargin(), 0);
  b.refundCharge("pend");
  assert.equal(b.margin, 0);
  assert.deepEqual(b.account(ALICE).balance, 10000 - SWEEP, "the user gets the whole cost back");
  assert.ok(POOL(b).ok);
  // Once the charge is confirmed its margin is the operator's to spend on housekeeping.
  b.reserve("conf", ALICE, 3300);
  b.settle("conf", { fee: 3000 });
  assert.equal(b.availableMargin(), 0);
  b.confirmCharge("conf");
  assert.equal(b.availableMargin(), 300);
  b.payHousekeeping(300);
  assert.ok(POOL(b).ok);
});

test("reverseCredit: a vanished deposit is undone; a spent part comes out of the margin; the key is never credited again", () => {
  const b = fresh();
  b.credit({ key: op("v1"), id: ALICE, n: 0, value: 7000, sweepCost: SWEEP, height: 5 });
  b.credit({ key: op("v2"), id: BOB, n: 0, value: 20000, sweepCost: SWEEP, height: 5 });
  // Alice spends 3,000 + margin of it first.
  b.reserve("x1", ALICE, 3300);
  b.settle("x1", { fee: 3000 });
  b.confirmCharge("x1");
  assert.equal(b.account(ALICE).balance, 6712 - 3300);
  const marginBefore = b.margin; // 288 + 288 + 300
  const rec = b.reverseCredit(op("v1"));
  assert.equal(rec.reversed, true);
  assert.equal(b.account(ALICE).balance, 0);
  assert.equal(b.margin, marginBefore - 288 - 3300, "sweep cost back out, and the 3,300 Alice already spent");
  assert.equal(b.totals.credited, 20000);
  assert.deepEqual(b.reverseCredit(op("v1")), rec, "idempotent");
  assert.equal(b.totals.credited, 20000);
  assert.deepEqual(b.credits(ALICE), [], "reversed credits are not listed");
  assert.equal(b.isCredited(op("v1")).reversed, true);
  assert.equal(b.claim(op("v1")), false);
  assert.throws(() => b.credit({ key: op("v1"), id: ALICE, n: 0, value: 7000, sweepCost: SWEEP, height: 6 }), err("already_credited"));
  assert.throws(() => b.reverseCredit(op("never")), err("unknown_ref"));
  const r = b.checkI2({ poolUnspent: 10 ** 9 });
  // The identity still holds; the margin went negative, which I2 reports (the relayer halts).
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [`margin ${b.margin} < 0`]);
  assert.equal(r.credited - r.fees - r.balances - r.reserved, r.margin);

  // A reversal the balance covers leaves I2 holding.
  const c = fresh();
  c.credit({ key: op("w1"), id: ALICE, n: 0, value: 7000, sweepCost: SWEEP, height: 5 });
  c.credit({ key: op("w2"), id: ALICE, n: 1, value: 7000, sweepCost: SWEEP, height: 5 });
  c.reverseCredit(op("w2"));
  assert.deepEqual(c.account(ALICE), { balance: 6712, reserved: 0, nextIndex: 2 });
  assert.equal(c.margin, 288);
  assert.ok(POOL(c).ok);
  const saved = RelayBooks.restore(JSON.parse(JSON.stringify(c.toJSON())), KEYS);
  assert.equal(saved.isCredited(op("w2")).reversed, true, "the reversed mark is persisted");
  assert.ok(POOL(saved).ok);
});

test("checkI2 fails with a problem string for a tampered balance, a duplicated credit, a negative margin or a short pool", () => {
  const b = fresh();
  b.credit({ key: op("t1"), id: ALICE, n: 0, value: 7000, sweepCost: SWEEP, height: 1 });
  b.credit({ key: op("t2"), id: BOB, n: 0, value: 4000, sweepCost: SWEEP, height: 1 });
  b.reserve("r1", BOB, 1000);
  const good = b.toJSON();
  const ok = b.checkI2({ poolUnspent: 11000 });
  assert.equal(ok.ok, true, ok.problems.join("; "));
  assert.deepEqual(
    { credited: ok.credited, fees: ok.fees, balances: ok.balances, reserved: ok.reserved, margin: ok.margin, liabilities: ok.liabilities, poolUnspent: ok.poolUnspent },
    { credited: 11000, fees: 0, balances: 6712 + 2712, reserved: 1000, margin: 576, liabilities: 11000, poolUnspent: 11000 },
  );
  const check = (mutate, pool = 11000) => {
    const j = structuredClone(good);
    mutate(j);
    return RelayBooks.restore(j, KEYS).checkI2({ poolUnspent: pool });
  };
  const tampered = check((j) => { j.accounts[ALICE].balance += 1; });
  assert.equal(tampered.ok, false);
  assert.match(tampered.problems.join("\n"), /credited 11000 - fees 0 - balances 9425 - reserved 1000 != margin 576/);
  const dup = check((j) => { j.totals.credited += 7000; j.accounts[ALICE].balance += 6712; j.margin += 288; });
  assert.equal(dup.ok, false, "the identity balances, but credited is not the sum of distinct outputs");
  assert.match(dup.problems.join("\n"), /credited 18000 != sum of distinct credited outputs 11000/);
  const neg = check((j) => { j.margin = -1; j.accounts[ALICE].balance += 577; });
  assert.equal(neg.ok, false);
  assert.ok(neg.problems.includes("margin -1 < 0"), neg.problems.join("; "));
  const negBal = check((j) => { j.accounts[ALICE].balance = -5; j.margin += 6717; });
  assert.ok(negBal.problems.some((p) => /balance -5 < 0/.test(p)), negBal.problems.join("; "));
  const res = check((j) => { j.accounts[BOB].reserved = 0; j.accounts[BOB].balance += 1000; });
  assert.ok(res.problems.some((p) => /reserved 0 != its reservations 1000/.test(p)), res.problems.join("; "));
  const record = check((j) => { j.credits[op("t1")].amount = 7000; });
  assert.ok(record.problems.some((p) => /does not add up/.test(p)), record.problems.join("; "));
  const short = check(() => {}, 10999);
  assert.equal(short.ok, false);
  assert.deepEqual(short.problems, ["pool unspent 10999 < liabilities 11000"]);
  assert.deepEqual(b.checkI2({}).problems, ["pool unspent coins unknown"]);
});

test("restore refuses another version, network, pool key or change key, and malformed records", () => {
  const b = fresh();
  b.credit({ key: op("z"), id: ALICE, n: 0, value: 7000, sweepCost: SWEEP, height: 1 });
  const j = b.toJSON();
  assert.deepEqual(RelayBooks.restore(JSON.stringify(j), KEYS).toJSON(), j, "a JSON string works too");
  assert.throws(() => RelayBooks.restore({ ...j, version: 2 }, KEYS), err("invalid"));
  assert.throws(() => RelayBooks.restore({ ...j, version: undefined }, KEYS), err("invalid"));
  assert.throws(() => RelayBooks.restore(j, { ...KEYS, network: "testnet" }), err("invalid"));
  assert.throws(() => RelayBooks.restore({ ...j, network: "mainnet" }, KEYS), err("invalid"));
  assert.throws(() => RelayBooks.restore(j, { ...KEYS, poolKey: h64("other pool") }), /another pool key/);
  assert.throws(() => RelayBooks.restore(j, { ...KEYS, changeKey: h64("other change") }), /another change key/);
  const bad = [
    (x) => { x.accounts = []; },
    (x) => { x.accounts[ALICE].balance = "6712"; },
    (x) => { x.accounts[ALICE.toUpperCase()] = x.accounts[ALICE]; },
    (x) => { x.credits[op("z")].n = -1; },
    (x) => { x.credits[op("z")].id = "nope"; },
    (x) => { x.reservations = { r: { id: ALICE, amount: 1.5 } }; },
    (x) => { x.charges = { "bad ref": { id: ALICE, cost: 1, fee: 1 } }; },
    (x) => { x.margin = "288"; },
    (x) => { delete x.totals; },
  ];
  for (const mutate of bad) {
    const copy = structuredClone(j);
    mutate(copy);
    assert.throws(() => RelayBooks.restore(copy, KEYS), err("invalid"), mutate.toString());
  }
  const upper = structuredClone(j);
  upper.credits[op("z").toUpperCase()] = upper.credits[op("z")];
  assert.throws(() => RelayBooks.restore(upper, KEYS), err("bad_key"), "a non-canonical credit key");
  const path = join(tmp, "corrupt.json");
  writeFileSync(path, "{ not json");
  assert.throws(() => loadBooks(path, KEYS), SyntaxError, "a corrupt file throws, it is never replaced by empty books");
});

test("relay-books.mjs imports only node:fs, node:path and ../src/relay-account.mjs", () => {
  const src = readFileSync(new URL("../server/relay-books.mjs", import.meta.url), "utf8");
  const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["../src/relay-account.mjs", "node:fs", "node:path"]);
  assert.ok(!/relayer\.mjs/.test(src));
});

// ---------------------------------------------------------------------------
// I2 under random sequences
// ---------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("I2 holds after 2,000 random sequences of credits, reserves, settles, confirms, refunds, releases, penalties, housekeeping, reclaims and reorgs", () => {
  const ids = [ALICE, BOB, h64("carol")];
  let ops = 0;
  for (let seq = 0; seq < 2000; seq++) {
    const r = rng(seq + 1);
    const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    const pick = (xs) => xs[Math.floor(r() * xs.length)];
    const b = new RelayBooks({ ...KEYS, marginPct: pick([10, 10, 0, 25]), marginMinSats: pick([50, 1, 200]) });
    // The pool's recorded coins, simulated as their sum: deposits add their value,
    // a signed transaction removes its fee, an undone one returns it.
    let pool = 0;
    // An independent model of balances and reservations.
    const model = new Map(ids.map((id) => [id, { balance: 0, reserved: 0 }]));
    const res = new Map(); // ref -> { id, amount }
    const charged = new Map(); // ref -> { fee, cost, id }
    const confirmed = []; // fees of confirmed charges
    const credits = []; // keys
    let reorged = false; // a reversal can push the margin below zero (its sweep cost or a spent balance)
    let n = 0;
    const steps = int(5, 40);
    for (let s = 0; s < steps; s++, ops++) {
      const before = JSON.stringify(b.toJSON());
      const kind = pick(["credit", "credit", "reserve", "reserve", "settle", "settle", "confirm", "refund", "release", "penalize", "house", "reclaim", "reverse", "dup"]);
      const ctx = `seed ${seq + 1} step ${s} ${kind}`;
      let refused = false;
      const refuse = (fn, code) => {
        assert.throws(fn, err(code), ctx);
        refused = true;
      };
      try {
        if (kind === "credit") {
          const id = pick(ids);
          const value = int(289, 30000);
          const key = op(`s${seq}-${n++}`, int(0, 3));
          b.credit({ key, id, n: int(0, 5), value, sweepCost: 288, height: int(1, 1000) });
          model.get(id).balance += value - 288;
          pool += value;
          credits.push(key);
        } else if (kind === "dup" && credits.length) {
          refuse(() => b.credit({ key: pick(credits), id: pick(ids), n: 0, value: 5000, sweepCost: 288, height: 1 }), "already_credited");
        } else if (kind === "reserve") {
          const id = pick(ids);
          const amount = int(1, 8000);
          const ref = `ref${n++}`;
          if (model.get(id).balance < amount) {
            refuse(() => b.reserve(ref, id, amount), "balance_low");
          } else {
            b.reserve(ref, id, amount);
            model.get(id).balance -= amount;
            model.get(id).reserved += amount;
            res.set(ref, { id, amount });
          }
        } else if (kind === "settle" && res.size) {
          const ref = pick([...res.keys()]);
          const { id, amount } = res.get(ref);
          const fee = int(1, 4000);
          const cost = costFor(fee, b.marginOpts);
          if (amount + model.get(id).balance < cost) {
            refuse(() => b.settle(ref, { fee }), "balance_low");
          } else {
            assert.deepEqual(b.settle(ref, { fee }), { cost, fee, margin: cost - fee }, ctx);
            model.get(id).reserved -= amount;
            model.get(id).balance += amount - cost;
            res.delete(ref);
            charged.set(ref, { fee, cost, id });
            pool -= fee; // signed: the fee leaves the pool's coins
          }
        } else if (kind === "confirm" && charged.size) {
          const ref = pick([...charged.keys()]);
          b.confirmCharge(ref);
          confirmed.push(charged.get(ref).fee);
          charged.delete(ref);
        } else if (kind === "refund" && charged.size) {
          const ref = pick([...charged.keys()]);
          const { id, cost, fee } = charged.get(ref);
          b.refundCharge(ref);
          model.get(id).balance += cost;
          charged.delete(ref);
          pool += fee; // never broadcast: the inputs are unspent again
        } else if (kind === "release" && res.size) {
          const ref = pick([...res.keys()]);
          const { id, amount } = res.get(ref);
          b.release(ref);
          model.get(id).balance += amount;
          model.get(id).reserved -= amount;
          res.delete(ref);
        } else if (kind === "penalize") {
          const id = pick(ids);
          const moved = b.penalize(id, 50);
          assert.equal(moved, Math.min(50, Math.max(0, model.get(id).balance)), ctx);
          model.get(id).balance -= moved;
        } else if (kind === "house") {
          const fee = int(1, 600);
          const pendingMargins = [...charged.values()].reduce((t, c) => t + c.cost - c.fee, 0);
          assert.equal(b.availableMargin(), b.margin - pendingMargins, ctx);
          if (b.availableMargin() < fee) {
            refuse(() => b.payHousekeeping(fee), "margin_low");
          } else {
            b.payHousekeeping(fee);
            pool -= fee;
            if (r() < 0.3) {
              b.refundHousekeeping(fee); // the housekeeping tx failed the pool check: undone
              pool += fee;
            }
          }
        } else if (kind === "reclaim" && confirmed.length) {
          const fee = confirmed.splice(Math.floor(r() * confirmed.length), 1)[0];
          b.reclaim(fee);
          pool += fee; // the dropped carrier's inputs are unspent again
        } else if (kind === "reverse" && credits.length) {
          const key = pick(credits);
          const c = b.isCredited(key);
          if (!c.reversed) {
            const m = model.get(c.id);
            reorged = true;
            m.balance = Math.max(0, m.balance - c.amount);
            pool -= c.value; // the deposit coin vanished
          }
          b.reverseCredit(key);
        }
      } catch (e) {
        if (e instanceof assert.AssertionError) throw e;
        assert.fail(`${ctx}: unexpected ${e.code ?? ""} ${e.message}`);
      }
      if (refused) assert.equal(JSON.stringify(b.toJSON()), before, `${ctx}: a refusal changes nothing`);
      for (const id of ids) {
        const a = b.account(id);
        assert.equal(a.balance, model.get(id).balance, `${ctx}: balance`);
        assert.equal(a.reserved, model.get(id).reserved, `${ctx}: reserved`);
      }
      const i2 = b.checkI2({ poolUnspent: pool });
      const other = i2.problems.filter((p) => !/^margin -?\d+ < 0$/.test(p) && !/^pool unspent/.test(p));
      assert.deepEqual(other, [], `${ctx}: ${i2.problems.join("; ")}`);
      assert.equal(i2.credited - i2.fees - i2.balances - i2.reserved, i2.margin, ctx);
      assert.equal(pool, i2.liabilities, `${ctx}: the simulated pool equals the liabilities exactly`);
      // Without a reorg I2 always holds; after one, it holds exactly when the margin stayed >= 0.
      if (!reorged) assert.ok(i2.margin >= 0, ctx);
      assert.equal(i2.ok, i2.margin >= 0, `${ctx}: ${i2.problems.join("; ")}`);
    }
    // Round trip at the end of every sequence: the same books, the same verdict.
    const back = RelayBooks.restore(JSON.parse(JSON.stringify(b.toJSON())), { ...KEYS, ...b.marginOpts });
    assert.deepEqual(back.toJSON(), b.toJSON());
    assert.deepEqual(back.checkI2({ poolUnspent: pool }), b.checkI2({ poolUnspent: pool }));
  }
  assert.ok(ops > 20000, `${ops} operations`);
});

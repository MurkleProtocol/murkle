// Wallet views review fixes: the phrase sheet closes on lock, the 2-note send limit,
// streamer-mode masking on Send and Activity, payment links without a token, the
// relay-status copy, focus on the fee-route radios and the self-paid retry review.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Wallet } from "../src/wallet.mjs";
import { deriveKeys } from "../src/keys.mjs";
import { planCarrierTx, btcAccount } from "../src/btc/funding.mjs";

const session = await import("../web/src/session.js");
const { guardReveal } = await import("../web/src/views/app-settings.js");
const { startToken, checkAmount, maskError, sendText, keepFocus, mergeForm, restoreForm } = await import("../web/src/views/app-send.js");
const { parseRequest } = await import("../web/src/views/pay.js");
const { selfRetryReview } = await import("../web/src/views/app-activity.js");

const src = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const streamer = (on, fn) => {
  session.setStreamerMode(on);
  try {
    return fn();
  } finally {
    session.setStreamerMode(false);
  }
};

/* ---------- finding 3: the recovery-phrase sheet ---------- */

function fakeSheet() {
  const calls = [];
  return { calls, setBody: (b) => calls.push(`body:${b}`), close: () => calls.push("close") };
}

test("the phrase sheet is wiped and closed on idle lock, manual lock and streamer mode", async () => {
  const pw = "correct horse battery staple 42";
  await session.createWallet(session.newPhrase(), pw);

  const idle = fakeSheet();
  const g1 = guardReveal(idle);
  session.lock("idle");
  assert.deepEqual(idle.calls, ["body:", "close"], "words removed before the sheet closes");
  assert.equal(g1.wiped, true);

  await session.unlock(pw);
  const manual = fakeSheet();
  guardReveal(manual);
  session.lock("manual");
  assert.deepEqual(manual.calls, ["body:", "close"]);
  session.lock("manual");
  assert.equal(manual.calls.length, 2, "unsubscribed after the first wipe");

  const shown = fakeSheet();
  guardReveal(shown);
  streamer(true, () => assert.deepEqual(shown.calls, ["body:", "close"]));

  const closed = fakeSheet();
  const g2 = guardReveal(closed);
  g2.off(); // the user closed it
  streamer(true, () => {});
  assert.deepEqual(closed.calls, []);
  assert.equal(g2.wiped, false);
});

/* ---------- finding 4: one send spends at most 2 notes ---------- */

const note = (amount, nullifier, extra = {}) => ({ asset: 7n, amount, nullifier: BigInt(nullifier), spent: false, ...extra });

test("the wallet reports what one 2-input send can spend and says why a larger amount fails", () => {
  const w = new Wallet(deriveKeys(randomBytes(32)));
  w.notes = [note(1000n, 1), note(1000n, 2), note(1000n, 3), note(5000n, 4, { spent: true }), note(9n, 5, { asset: 8n })];
  assert.equal(w.maxSendable(7n), 2000n);
  assert.equal(w.selectNotes(7n, 2000n).picked.length, 2);
  assert.throws(() => w.selectNotes(7n, 2500n), (e) => e.code === "NOTE_LIMIT" && /at most 2 notes/.test(e.message));
  assert.throws(() => w.selectNotes(7n, 3001n), (e) => e.code === "INSUFFICIENT" && /^insufficient balance/.test(e.message));
  w.locked = new Set(["1", "2"]);
  assert.equal(w.maxSendable(7n), 1000n, "locked notes are not sendable");
  assert.equal(w.maxSendable(9n), 0n);
});

test("the send form checks the 2-note limit before proving", () => {
  const a = { ticker: "ABC", divisibility: 0, available: 3000n };
  assert.deepEqual(checkAmount("2000", a, 2000n), { value: 2000n, error: null });
  const over = checkAmount("3000", a, 2000n);
  assert.equal(over.value, 3000n);
  assert.match(over.error, /at most 2 notes, so up to 2,000 ABC.*own address/);
  assert.match(checkAmount("3001", a, 2000n).error, /More than your available 3,000 ABC/);
  assert.deepEqual(checkAmount("", a, 2000n), { value: null, error: null });
  streamer(true, () => assert.ok(!/2,000|3,000/.test(checkAmount("3000", a, 2000n).error), "no amount in streamer mode"));
  // A race past the form still reads as plain words, without base units.
  assert.equal(sendText("one transfer spends at most 2 notes: the largest two hold 2000 < 3000; send to yourself first to merge notes"), "One send spends at most 2 notes. Merge notes first by sending to your own address.");
  assert.ok(!/\d{3}/.test(sendText("insufficient balance: 2000 < 3000")));
  assert.match(src("web/src/views/app-send.js"), /units\(sendable\(as\), as\.divisibility\)/, "Max fills what one send can spend");
});

test("Merge notes sets a typed recipient and amount aside and brings them back", () => {
  const me = new session.Session({ phrase: session.newPhrase() }).address;
  const bob = new session.Session({ phrase: session.newPhrase() }).address;
  const start = { to: `${bob} `, amount: "2500", via: "relay", aside: null };
  const m = mergeForm(start, me, "2000");
  assert.deepEqual(m, { to: me, amount: "2000", via: "relay", modeTouched: false, aside: { to: `${bob} `, amount: "2500", mode: undefined, modeTouched: undefined, batchLen: undefined } });
  assert.deepEqual(mergeForm(m, me, "1999").aside, m.aside, "a second click keeps the first recipient");
  assert.deepEqual(restoreForm(m), { ...start, mode: undefined, modeTouched: undefined, batchLen: undefined }, "the recipient and amount (and timing) come back unchanged");
  assert.equal(mergeForm({ to: " ", amount: "", aside: null }, me, "2000").aside, null, "nothing typed, nothing kept");
  assert.equal(mergeForm({ to: me, amount: "5", aside: null }, me, "2000").aside, null, "already your own address");
  const plain = { to: bob, amount: "1", aside: null };
  assert.equal(restoreForm(plain), plain);

  const send = src("web/src/views/app-send.js");
  assert.match(send, /Object\.assign\(form, mergeForm\(form, s\.address, amount\)\)/);
  assert.match(send, /action: "restore-to"/, "the recipient caption offers to put it back");
  assert.match(send, /"restore-to"\) \{\s*const before = form\.mode;\s*Object\.assign\(form, restoreForm\(form\)\)/);
  assert.match(send, /if \(back\) Object\.assign\(form, restoreForm\(form\)\)/, "a sent merge brings the recipient back");
  assert.equal(send.match(/form\.aside = null;/g)?.length, 2, "typing or pasting a recipient drops the kept one");
  assert.ok(!/form\.to = s\.address/.test(send), "the recipient is never overwritten in place");
});

/* ---------- finding 6: streamer mode on Send and Activity ---------- */

test("streamer mode hides the Max amount and the payer address and sats in errors", () => {
  const send = src("web/src/views/app-send.js");
  assert.match(send, /<div data-slot="amount" data-mask><\/div>/, "the amount input is blurred like the recipient");
  let real;
  try {
    planCarrierTx({ account: btcAccount(new Uint8Array(32).fill(7)), utxos: [{ txid: "ab".repeat(32), vout: 0, value: 400 }], envelope: new Uint8Array(471), feeRate: 2 });
  } catch (e) {
    real = e.message;
  }
  assert.match(real, /not enough BTC at tb1p\w+: have 400 sats, need \d+/);
  const m = maskError(real);
  assert.ok(!/tb1|\d/.test(m), m);
  assert.match(m, /your Bitcoin address: have hidden sats, need hidden/);
  assert.equal(maskError("1,234 sats at 2 sat/vB"), "hidden sats at 2 sat/vB");
  assert.equal(maskError("root matches at #324,600"), "root matches at #324,600", "not every number is an amount");
  const me = new session.Session({ phrase: session.newPhrase() }).address;
  assert.ok(!maskError(`sent to ${me}`).includes(me));
  assert.equal(sendText(real), real, "unchanged with streamer mode off");
  streamer(true, () => assert.equal(sendText(real), m));
  assert.match(send, /sheet\.fail\(\{ message: sendText\(/);
  assert.match(send, /detail: sendText\(ev\.detail\)/);
  const act = src("web/src/views/app-activity.js");
  assert.match(act, /\$\{sendText\(h\.reason\)\}/, "a stored failure reason is masked too");
  assert.match(act, /sheet\.fail\(\{ message: sendText\(/);
});

/* ---------- finding 7: a payment link with an amount but no token ---------- */

test("a payment link with an amount but no token is refused and never lands on another token", () => {
  const me = new session.Session({ phrase: session.newPhrase() }).address;
  const assets = [{ ticker: "ABC", id: "7", divisibility: 2 }];
  assert.match(parseRequest(`#to=${me}&a=5000`, assets).errors[0], /amount but no token/);
  assert.deepEqual(parseRequest(`#to=${me}&t=ABC&a=5`, assets).errors, []);
  assert.deepEqual(parseRequest(`#to=${me}`, assets).errors, []);

  const list = [{ ticker: "BIG" }, { ticker: "ABC" }];
  assert.equal(startToken(list, null, true), null, "amount without a token: the user chooses");
  assert.equal(startToken(list, "NOPE", true), null, "unknown token in a link: the user chooses");
  assert.equal(startToken(list, "ABC", true), "ABC");
  assert.equal(startToken(list, null, false), "BIG", "a plain visit still starts on the first token");
  assert.equal(startToken([], null, false), null);
});

/* ---------- finding 8: relay status polling is disclosed ---------- */

test("Settings and Activity no longer claim that no request names your transactions", () => {
  const settings = src("web/src/views/app-settings.js");
  const activity = src("web/src/views/app-activity.js");
  assert.ok(!settings.includes("none of them names one of your transactions"));
  assert.ok(!activity.includes("no server learns which transactions are yours"));
  assert.match(settings, /until a relayed transfer lands or expires, each sync asks the relayer about it by its relay id/);
  assert.match(activity, /until one lands or expires, each sync asks the relayer about it by its relay id/);
  assert.ok(!activity.includes("Statuses come from bulk data only"), "the header comment agrees");
});

/* ---------- finding 45: focus stays on the fee-route radio ---------- */

test("re-rendering the route cards keeps focus on the chosen radio", (t) => {
  const prev = globalThis.document;
  t.after(() => (prev === undefined ? delete globalThis.document : (globalThis.document = prev)));
  const body = { name: "" };
  const doc = { activeElement: null };
  globalThis.document = doc;
  const fresh = { focus: (o) => ((doc.activeElement = fresh), (fresh.opts = o)) };
  const old = { name: "route", value: "self" };
  const queries = [];
  const el = {
    contains: (n) => n === old,
    set innerHTML(v) {
      this.html = v;
      doc.activeElement = body; // the browser drops focus with the removed node
    },
    querySelector: (sel) => (queries.push(sel), sel === 'input[name="route"][value="self"]' ? fresh : null),
  };
  doc.activeElement = old;
  keepFocus(el, "<cards>");
  assert.equal(el.html, "<cards>");
  assert.equal(doc.activeElement, fresh);
  assert.deepEqual(fresh.opts, { preventScroll: true });

  doc.activeElement = { name: "amount", value: "5" }; // focus elsewhere: left alone
  keepFocus(el, "<cards2>");
  assert.equal(queries.length, 1);
  assert.match(src("web/src/views/app-send.js"), /keepFocus\(slot\("route"\), cards\)/);
});

/* ---------- finding 46: a self-paid retry shows the Disclosure Preview first ---------- */

test("Pay the fee myself opens a review with payer and fee before anything is signed", () => {
  const addr = btcAccount(new Uint8Array(32).fill(9)).address;
  const out = String(selfRetryReview({ payerAddr: addr }));
  assert.match(out, /WHAT BECOMES PUBLIC · SEND/);
  assert.match(out, /Paid by/);
  assert.match(out, /data-fee/);
  assert.ok(out.includes(addr.slice(0, 8)) && out.includes(addr.slice(-6)), "the payer address is shown");
  assert.match(out, /data-action="go"/);
  assert.match(out, /can&#39;t be undone/);
  streamer(true, () => assert.ok(!String(selfRetryReview({ payerAddr: addr })).includes(addr.slice(-6)), "masked in streamer mode"));
  const blocked = String(selfRetryReview({ payerAddr: null, blocked: "Connect Unisat in Settings first." }));
  assert.match(blocked, /disabled/);
  assert.match(blocked, /Connect Unisat in Settings first/);
  const act = src("web/src/views/app-activity.js");
  assert.match(act, /"retry-self"\) reviewSelf\(entry\)/);
  assert.ok(!/"retry-self"\)\s*retry\(/.test(act), "no one-click broadcast");
});

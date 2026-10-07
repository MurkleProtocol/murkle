// Privacy fixes in the web wallet (docs/design/privacy-trace-test.md, "Status of fixes"):
//   L1  the relay pool's lineage: a thin pool refuses a relayed send unless the user confirms it
//       may go linkable ("pool_thin"); the wallet never lists the sender as hidden for a linkable
//       send; Settings shows the separate depositors.
//   L3  the effective crowd before a relayed or batch send: other people's value-bearing notes
//       at the proof's anchor, and the batch crowd from the published waiting count.
//   L4  nothing in the web wallet reads meaning into an output's position.
//   L5  every transaction the built-in keys build signals RBF on every input, uses the shared
//       fee rule and layout policy, and a top-up never assumes its deposit is output 0.
// Each test fails on the code before these fixes. Nothing is broadcast, no browser wallet is
// used, nothing is written outside memory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import * as funding from "../src/btc/funding.mjs";
import { OP, encodeTxBody, decodeEnvelope, opReturnPayload } from "../src/envelope.mjs";
import { hex } from "../src/bytes.mjs";
import { deriveKeys, encryptNote } from "../src/keys.mjs";
import { commitmentOf } from "../src/core.mjs";
import { relayAccount, requestDigest, parsePoolKey } from "../src/relay-account.mjs";

const PRIV = await import("../web/src/privacy.js");
const RELAY = await import("../web/src/relay.js");
const PAYERS = await import("../web/src/payers.js");
const SESSION = await import("../web/src/session.js");
const SHARED = await import("../web/src/views/app-shared.js");
const SEND = await import("../web/src/views/app-send.js");
const ACT = await import("../web/src/views/app-activity.js");
const SET = await import("../web/src/views/app-settings.js");
const MINE = await import("../web/src/views/app-mine.js");
const { myView } = await import("../web/src/verify/my-view.js");

const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const code = (f) => src(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

const POOL = Buffer.from(schnorr.getPublicKey(new Uint8Array(32).fill(9))).toString("hex");
const ACCOUNT = relayAccount(new Uint8Array(32).fill(3), "signet");
const balanceInfo = ({ mix } = {}) => ({
  enabled: true, mode: "balance", code: null, reason: null, network: "signet", address: "tb1prelayer",
  fees: { feeRate: 1, maxFeeRate: 5, carrierFeeSats: 597 },
  balance: { poolKey: POOL, perSendSats: 657, batchHeadroom: 2, minDepositSats: 2000, depositConfirmations: 1, ...(mix ? { mix } : {}) },
});
const THIN = { k: 3, coverOk: false, depositors: 1 };
const COVER = { k: 3, coverOk: true, depositors: 6 };

function transact() {
  const body = encodeTxBody({
    op: OP.TRANSACT, anchor: 100, publicAmount: 0n, nullifiers: [11n, 12n], commitments: [21n, 22n],
    ciphertexts: [new Uint8Array(95).fill(1), new Uint8Array(95).fill(2)],
  });
  const env = new Uint8Array(body.length + 128);
  env.set(body);
  return env;
}

function fakeRelay(info) {
  const calls = { submits: [] };
  return {
    calls,
    async info() {
      return info;
    },
    async submit(body) {
      calls.submits.push(body);
      return { id: "ab".repeat(16), status: "queued", anchor: 100, deadline: 200, flush: "next-block", reservedSats: 657, balance: 6055 };
    },
  };
}

/* ======================================================================== L3 */

// The signet trace's #3: an operator MINT (leaves 0-1: its note and the zero padding), then the
// operator sends. Anchored at a 2-leaf tree, nobody else's note is in it.
test("L3: the trace's #3 had no crowd at all: zero candidate notes, and the send warns", () => {
  const outputs = [{ txid: "mint-op", height: 324_600 }, { txid: "mint-op", height: 324_600 }];
  const log = new Map([["mint-op", { opName: "MINT" }]]);
  const k = PRIV.candidateNotes({ outputs, leaves: 2, log, own: [0] });
  assert.equal(k, 0, "the operator's own mint and its padding are not cover");
  const c = PRIV.crowdCheck({ candidates: k, mode: "batch", queued: 0 });
  assert.deepEqual(c, { candidates: 0, batchCrowd: 1, fewNotes: true, alone: true, thin: true });
  assert.equal(PRIV.CROWD_TEXT.few, "Few transfers to hide among: an observer can likely tell this came from you.");
  assert.equal(PRIV.CROWD_TEXT.alone, "A batch hides nothing while it holds only your transfer.");
});

test("L3: candidates are other people's value-bearing leaves at the anchor; padding never counts, wherever it sits", () => {
  const outputs = [
    { txid: "m1" }, { txid: "m1" }, // someone's MINT: one note + padding (pre-L4 order)
    { txid: "m2" }, { txid: "m2" }, // someone's MINE: padding first, note second (post-L4 order)
    { txid: "t1" }, { txid: "t1" }, // someone's transfer: payment + change, both can carry value
    { txid: "m3" }, { txid: "m3" }, // our own MINT_SCRIPT: neither its note nor its padding is cover
    { txid: "t2" }, { txid: "t2" }, // a transfer to us: our note does not count, the sender's change does
    { txid: "t3" }, { txid: "t3" }, // after the anchor: not in the proof's tree
  ];
  const log = new Map([["m1", { opName: "MINT" }], ["m2", { opName: "MINE" }], ["t1", { opName: "TRANSFER" }], ["m3", { opName: "MINT_SCRIPT" }], ["t2", { opName: "TRANSFER" }], ["t3", { opName: "TRANSFER" }]]);
  assert.equal(PRIV.candidateNotes({ outputs, leaves: 10, log, own: [7, 9] }), 1 + 1 + 2 + 0 + 1);
  // The bulk-log array form works the same; the anchor's tree size cuts the later leaves.
  assert.equal(PRIV.candidateNotes({ outputs, leaves: 12, log: [...log].map(([txid, v]) => ({ txid, ...v })), own: [7, 9] }), 7);
  assert.equal(PRIV.candidateNotes({ outputs, leaves: 4, log, own: [] }), 2);
  // An operation the log does not name counts conservatively: one note per transaction.
  assert.equal(PRIV.candidateNotes({ outputs: [{ txid: "x" }, { txid: "x" }], leaves: 2, log: new Map() }), 1);
});

test("L3: the warning fires below 8 candidates or with a batch crowd of 1, and never otherwise", () => {
  assert.equal(PRIV.CROWD_MIN_NOTES, 8);
  assert.equal(PRIV.crowdCheck({ candidates: 7, mode: "block" }).thin, true);
  assert.deepEqual(PRIV.crowdCheck({ candidates: 8, mode: "block" }), { candidates: 8, batchCrowd: null, fewNotes: false, alone: false, thin: false });
  assert.equal(PRIV.crowdCheck({ candidates: 50, mode: "batch", queued: 0 }).thin, true, "alone in the batch");
  assert.deepEqual(PRIV.crowdCheck({ candidates: 50, mode: "batch10", queued: 2 }), { candidates: 50, batchCrowd: 3, fewNotes: false, alone: false, thin: false });
  assert.equal(PRIV.crowdCheck({ candidates: 50, mode: "fast", queued: 0 }).batchCrowd, null, "only batch modes have a batch crowd");
});

test("L3: session.sendCrowd counts from the view, the bulk log and the wallet's own notes; the batch crowd from relay info", () => {
  const outputs = Array.from({ length: 20 }, (_, i) => ({ txid: `t${Math.floor(i / 2)}` }));
  const log = new Map(outputs.map((o) => [o.txid, { opName: "TRANSFER" }]));
  const fake = {
    view: { outputs, height: 500 },
    log,
    wallet: { notes: [{ leafIndex: 0 }, { leafIndex: 3 }] },
    relayInfo: { batch: { modes: { batch: { current: { start: 498, queued: 0 } } } } },
  };
  const c = SESSION.Session.prototype.sendCrowd.call(fake, { mode: "batch", leaves: 6 });
  assert.equal(c.candidates, 4, "6 leaves at the anchor, 2 of them ours");
  assert.equal(c.batchCrowd, 1);
  assert.equal(c.thin, true);
  const tip = SESSION.Session.prototype.sendCrowd.call(fake, { mode: "block" });
  assert.equal(tip.candidates, 18);
  assert.equal(tip.thin, false);
  assert.equal(SESSION.Session.prototype.sendCrowd.call({ ...fake, view: null }, {}), null);
});

test("L3: the Send screen shows the crowd before a relayed send and warns, without blocking", () => {
  const thin = String(SEND.relayPrivacyBlock({ mix: "ok", crowd: PRIV.crowdCheck({ candidates: 1, mode: "batch", queued: 0 }) }));
  assert.ok(thin.includes(PRIV.CROWD_TEXT.few));
  assert.ok(thin.includes(PRIV.CROWD_TEXT.alone));
  assert.ok(thin.includes(PRIV.CROWD_TEXT.notes(1).replace(/'/g, "&#39;")));
  assert.ok(!/disabled/.test(thin), "advice only");
  const fine = String(SEND.relayPrivacyBlock({ mix: "ok", crowd: PRIV.crowdCheck({ candidates: 40, mode: "block" }) }));
  assert.ok(!fine.includes(PRIV.CROWD_TEXT.few));
  assert.match(fine, /40 notes of other people/);
  // The batch timing notes say a lone batch hides nothing.
  const notes = String(SEND.timingNotes({ mode: "batch", plan: null, info: { enabled: true, batch: { modes: { batch: { enabled: true, maxPerEpoch: 50, current: { start: 10, queued: 0 } } } } } }));
  assert.ok(notes.includes(SHARED.BATCH_TEXT.alone));
  assert.ok(notes.includes(SHARED.BATCH_TEXT.thin));
  // The view wires it: a crowd slot, painted for relayed sends from session.sendCrowd.
  const send = code("web/src/views/app-send.js");
  assert.match(send, /data-slot="crowd"/);
  assert.match(send, /s\.sendCrowd\(\{ mode: form\.mode, leaves: plan\?\.leaves/);
});

/* ======================================================================== L1 */

test("L1: relay info's balance.mix is read strictly; unknown when a relayer publishes none", () => {
  assert.deepEqual(RELAY.poolMix(balanceInfo({ mix: THIN })), THIN);
  assert.equal(RELAY.mixState(balanceInfo({ mix: THIN })), "thin");
  assert.equal(RELAY.mixState(balanceInfo({ mix: COVER })), "ok");
  assert.equal(RELAY.mixState(balanceInfo()), "unknown");
  assert.equal(RELAY.mixState(balanceInfo({ mix: { k: 3, coverOk: "yes" } })), "unknown");
  assert.deepEqual(RELAY.poolMix(balanceInfo({ mix: { coverOk: true, k: -1, depositors: 1.5 } })), { k: null, coverOk: true, depositors: null });
});

const FUNDED = { balance: 100_000, reserved: 0 };

test("L1: a thin pool refuses a relayed send before anything is signed or sent, unless the user confirmed it may go linkable", async () => {
  RELAY.RELAY_ROUTE.open = true;
  const client = fakeRelay(balanceInfo({ mix: THIN }));
  await assert.rejects(RELAY.submitEnvelope(transact(), { client, account: ACCOUNT, balance: FUNDED }), (e) => {
    assert.equal(e.code, "pool_thin");
    assert.equal(e.message, "Too few people have topped up the relay pool, so this send's input would tie it to your top-up address. Pay the fee yourself, or confirm to send it linkable.");
    return true;
  });
  assert.equal(client.calls.submits.length, 0, "nothing reached the relayer");
  // The relayer's own 409 reads the same, and is not a silent retry.
  assert.deepEqual(RELAY.relayFailure({ code: "pool_thin" }), { code: "pool_thin", retryable: false, message: RELAY.FALLBACK.pool_thin });
  // The RelayPayer route refuses the same way.
  await assert.rejects(new PAYERS.RelayPayer({ client, account: ACCOUNT }).carry({ envelope: transact(), balance: FUNDED }), (e) => e.code === "pool_thin");
  assert.equal(client.calls.submits.length, 0);
  // A balance too low comes first, as at the relayer; without a balance read the relayer decides.
  await assert.rejects(RELAY.submitEnvelope(transact(), { client, account: ACCOUNT, balance: { balance: 10, reserved: 0 } }), (e) => e.code === "balance_low");
  await RELAY.submitEnvelope(transact(), { client, account: ACCOUNT });
  assert.equal(client.calls.submits.length, 1, "the relayer answers for itself (its 409 pool_thin)");
});

test("L1: with cover, a send is signed exactly as before: no linkable field", async () => {
  const client = fakeRelay(balanceInfo({ mix: COVER }));
  await RELAY.submitEnvelope(transact(), { client, account: ACCOUNT });
  assert.deepEqual(Object.keys(client.calls.submits[0]).sort(), ["accountPub", "envelope", "mode", "sig", "t"]);
});

test("L1: a confirmed linkable send carries the signed boolean field linkable, signed as the relayer checks it", async () => {
  const client = fakeRelay(balanceInfo({ mix: THIN }));
  const r = await new PAYERS.RelayPayer({ client, account: ACCOUNT }).carry({ envelope: transact(), linkable: true });
  assert.equal(r.relayId, "ab".repeat(16));
  const [body] = client.calls.submits;
  assert.deepEqual(Object.keys(body).sort(), ["accountPub", "envelope", "linkable", "mode", "sig", "t"]);
  assert.equal(body.linkable, true);
  const { sig, ...fields } = body;
  // The digest the contract names: the shared requestDigest, with linkable as JSON true.
  const digest = requestDigest({ endpoint: "/api/relay/submit", network: "signet", poolKey: POOL, fields });
  assert.equal(schnorr.verify(sig, digest, body.accountPub), true, "the signature covers linkable");
  // The relayer's own check, when its module loads here.
  const relayer = await import("../server/relayer.mjs").catch(() => null);
  if (typeof relayer?.submitDigest === "function") {
    assert.equal(schnorr.verify(sig, relayer.submitDigest(parsePoolKey(POOL), fields), body.accountPub), true, "the relayer accepts it");
  }
  // A plain send signs through the shared module exactly as before.
  const plain = RELAY.signSubmit({ account: ACCOUNT, poolKey: POOL, fields: { envelope: "00", mode: "block" } });
  assert.deepEqual(Object.keys(plain).sort(), ["accountPub", "envelope", "mode", "sig", "t"]);
});

test("L1: the wallet never lists the sender as hidden for a linkable, thin, unknown-lineage or self-paid send", () => {
  const ok = PRIV.crowdCheck({ candidates: 40, mode: "block" });
  assert.equal(SEND.senderHidden({ via: "relay", mix: "ok", crowd: ok }), true);
  assert.equal(SEND.senderHidden({ via: "relay", mix: "ok", linkable: true, crowd: ok }), false);
  assert.equal(SEND.senderHidden({ via: "relay", mix: "thin", crowd: ok }), false);
  assert.equal(SEND.senderHidden({ via: "relay", mix: "unknown", crowd: ok }), false);
  assert.equal(SEND.senderHidden({ via: "self", mix: "ok", crowd: ok }), false);
  assert.equal(SEND.senderHidden({ via: "relay", mix: "ok", crowd: PRIV.crowdCheck({ candidates: 2 }) }), false, "a thin crowd");
  const send = code("web/src/views/app-send.js");
  assert.match(send, /hidden: hiddenNow \? \["Token", "Amount", "Sender \(you\)"/);
  assert.ok(!/you and the recipient stay hidden/.test(send), "the page lead no longer says the sender is hidden");
  // A self-paid retry's review no longer lists the sender among what the proof hides.
  const review = String(ACT.selfRetryReview({ payerAddr: null }));
  assert.ok(!review.includes("Sender (you)"));
  assert.match(review, /tied to the paying address/);
});

test("L1: the Send form asks for an explicit linkable confirmation while the pool is thin, and passes it on", () => {
  const box = String(SEND.relayPrivacyBlock({ mix: "thin", k: 3 }));
  assert.match(box, /<input type="checkbox" name="linkable">/, "unticked by default");
  assert.ok(box.includes(SHARED.RELAY_TEXT.thin({ k: 3 }).replace(/'/g, "&#39;")));
  assert.ok(box.includes(SHARED.RELAY_TEXT.thinConfirm));
  assert.match(String(SEND.relayPrivacyBlock({ mix: "thin", k: 3, linkable: true })), /name="linkable" checked/);
  assert.ok(String(SEND.relayPrivacyBlock({ mix: "unknown" })).includes(SHARED.RELAY_TEXT.mixUnknown));
  const send = code("web/src/views/app-send.js");
  assert.match(send, /mixNow\(\) === "thin" && !form\.linkable\) reason = RELAY_TEXT\.thinConfirmFirst/, "Send stays disabled until the box is ticked");
  assert.match(send, /const linkable = via === "relay" && form\.linkable === true && mixNow\(\) === "thin";/);
  // Info's coverOk is an anonymous caller's view: after a pool_thin refusal for this account the
  // form treats the pool as thin, so the box can be ticked at all.
  assert.match(send, /const mixNow = \(\) => \(form\.poolThin \? "thin" : mixState\(s\.relayInfo\)\);/);
  assert.match(send, /if \(err\?\.code === "pool_thin"\) form\.poolThin = true;/);
  assert.match(send, /s\.send\(\{ asset: a, amount: p\.value, to: form\.to, via, mode, linkable, onStep \}\)/);
  // The tier of a thin-pool relayed send is Exposed, with the reason.
  const t = PRIV.noteTier({ notesAfter: 500, transfersSince: 100, blocks: 500, mint: false, leaves: 600 }, { route: "relay-linkable" });
  assert.equal(t.tier, "exposed");
  assert.ok(t.reasons.some((r) => /ties this transfer to the address you topped up from/.test(r)));
});

test("L1: the session threads linkable to the relayer and records it; Activity offers the linkable retry only on pool_thin", () => {
  const s = code("web/src/session.js");
  assert.match(s, /async send\(\{ asset, amount, to, via = this\.routePref, mode, linkable = false,/);
  assert.match(s, /payer\.carry\(\{\s*envelope: env, mode, linkable, signal,/);
  assert.match(s, /\.\.\.\(linkable \? \{ linkable: true \} : \{\}\)/);
  assert.match(s, /failCode: via === "relay" && e\?\.code === "pool_thin" \? "pool_thin" : null/);
  assert.match(s, /mode: "block", linkable: linkable === true, account: this\.#relay/, "relayed mining claims too");
  RELAY.RELAY_ROUTE.open = true;
  try {
    const entry = { id: "e1", kind: "send", via: "relay", mode: "block", status: "failed", anchor: 100, envelope: "00", failCode: "pool_thin" };
    const out = String(ACT.retryButtons(entry, 110));
    assert.ok(out.includes(ACT.RETRY_LINKABLE));
    assert.match(out, /data-action="retry-linkable"/);
    assert.ok(!String(ACT.retryButtons({ ...entry, failCode: null }, 110)).includes("retry-linkable"));
  } finally {
    RELAY.RELAY_ROUTE.open = false;
  }
  assert.match(code("web/src/views/app-activity.js"), /h\.linkable \? "via the relayer, linkable"/);
});

test("L1: Settings shows the separate depositors and whether carriers can avoid your own top-up", () => {
  const thin = String(SET.mixLine(balanceInfo({ mix: THIN })));
  assert.match(thin, /1 separate account has topped up/);
  assert.match(thin, /callout--warn/);
  assert.match(String(SET.mixLine(balanceInfo({ mix: COVER }))), /6 separate accounts have topped up\. A carrier spends only coins that descend from at least 4 depositors, so whoever sends, at least 3 others are among them\. Such coins exist now\./);
  assert.ok(String(SET.mixLine(balanceInfo())).includes(SHARED.RELAY_TEXT.mixUnknown));
  // Mining: a relayed claim in a thin pool needs the same consent.
  const m = String(MINE.mineMixBlock(balanceInfo({ mix: THIN })));
  assert.match(m, /name="mine-linkable"/);
  assert.equal(String(MINE.mineMixBlock(balanceInfo({ mix: COVER }))), "");
  assert.match(String(MINE.mineMixBlock(balanceInfo({ mix: COVER }), false, true)), /name="mine-linkable"/, "after a pool_thin refusal");
});

/* ======================================================================== L4 */

test("L4: a note is found by trial decryption at either output position; nothing reads the position", () => {
  const me = deriveKeys(new Uint8Array(32).fill(7));
  const other = deriveKeys(new Uint8Array(32).fill(8));
  const note = (keys, amount, blinding) => ({ asset: 5n, amount, blinding, vpk: keys.vpk, commitment: commitmentOf({ asset: 5n, amount, blinding, pubkey: keys.pk }) });
  const mine = note(me, 40n, 123n);
  const pad = note(other, 0n, 456n);
  for (const order of [[pad, mine], [mine, pad]]) {
    const env = { commitments: order.map((o) => o.commitment), ciphertexts: order.map((o) => encryptNote(o)), nullifiers: [] };
    const v = myView(env, "tx", { keys: me, wallet: { notes: [] }, history: [] });
    assert.deepEqual(v.outputs, [{ index: order.indexOf(mine), asset: 5n, amount: 40n }]);
  }
  // The wallet's note list marks a mint by its commitment, wherever the mint put it.
  const fake = {
    history: [{ kind: "mint", commitments: [String(pad.commitment), String(mine.commitment)] }],
    wallet: { notes: [{ leafIndex: 1, asset: 5n, amount: 40n, nullifier: 9n, spent: false }], locked: new Set() },
    view: { outputs: [{ commitment: pad.commitment, txid: "m", height: 1 }, { commitment: mine.commitment, txid: "m", height: 1 }] },
    assetList: [{ id: "5", ticker: "T", divisibility: 0 }],
  };
  assert.equal(SESSION.Session.prototype.notes.call(fake)[0].mint, true);
  assert.deepEqual(SESSION.Session.prototype.activity.call(fake).filter((x) => x.kind === "receive"), [], "an own mint is not a receive");
  for (const f of ["web/src/session.js", "web/src/verify/my-view.js", "web/src/views/receipt.js", "web/src/views/app-activity.js", "web/src/views/app-mine.js"]) {
    assert.ok(!/(commitments|ciphertexts|outputCommitment)\[[01]\]/.test(code(f)), `${f} reads an output by position`);
  }
});

/* ======================================================================== L5 */

const KEY = new Uint8Array(32).fill(11);
const utxo = (i, value) => ({ txid: i.toString(16).padStart(64, "0"), vout: i % 3, value });

test("L5: a top-up from the built-in key signals RBF on every input and records the deposit's real output", () => {
  const payer = new PAYERS.LocalPayer(KEY);
  const to = funding.btcAccount(new Uint8Array(32).fill(12)).address;
  const seen = new Set();
  for (let i = 0; i < 40; i++) {
    const plan = payer.planPay({ utxos: [utxo(1, 6000), utxo(2, 5000), utxo(3, 4000)], to, amount: 9000, feeRate: 2 });
    const tx = btc.Transaction.fromRaw(Buffer.from(plan.hex, "hex"));
    for (let j = 0; j < tx.inputsLength; j++) assert.equal(tx.getInput(j).sequence, 0xfffffffd);
    const out = tx.getOutput(plan.vout);
    assert.equal(hex(out.script), hex(funding.scriptOf(to)));
    assert.equal(out.amount, 9000n);
    seen.add(plan.vout);
  }
  assert.deepEqual([...seen].sort(), [0, 1], "the change position is random, so vout 0 is never assumed");
  const top = code("web/src/views/topup.js");
  assert.ok(!/vout: 0\b/.test(top), "top-up no longer records output 0");
  assert.match(top, /recordTopUp\(\{ n: r\.n, txid, vout: r\.vout, value: r\.amount \}\)/);
});

test("L5: a carrier from the built-in key: RBF on every input, envelope at output 0, a bound first input stays first, the rest in random order", async () => {
  const payer = new PAYERS.LocalPayer(KEY);
  const sent = [];
  const api = { broadcast: async (h) => (sent.push(h), "ff".repeat(32)) };
  const utxos = [1, 2, 3, 4, 5, 6].map((i) => utxo(i, 1000)); // about four inputs at 5 sat/vB
  const orders = new Set();
  for (let i = 0; i < 30; i++) {
    await payer.carry({ api, envelope: transact(), utxos, firstInput: utxos[3], feeRate: 5 });
    const tx = btc.Transaction.fromRaw(Buffer.from(sent.at(-1), "hex"), { allowUnknownOutputs: true });
    for (let j = 0; j < tx.inputsLength; j++) assert.equal(tx.getInput(j).sequence, 0xfffffffd);
    assert.equal(hex(tx.getInput(0).txid), utxos[3].txid, "the bound input is first");
    assert.equal(decodeEnvelope(opReturnPayload(tx.getOutput(0).script)).op, OP.TRANSACT);
    orders.add(Array.from({ length: tx.inputsLength }, (_, j) => hex(tx.getInput(j).txid)).join(","));
  }
  assert.ok(orders.size > 1, "the inputs after the bound one are not in a fixed order");
  // Every web route signs through the same planner with the same nSequence.
  assert.equal(PAYERS.RBF_SEQUENCE, 0xfffffffd);
  const s = code("web/src/session.js");
  assert.match(s, /firstInput, feeRate, sequence: RBF_SEQUENCE \}\)/, "a self-paid send");
  assert.match(s, /firstInput: coin, feeRate, sequence: RBF_SEQUENCE \}\)/, "a self-paid claim");
  assert.ok(!/order: "given"/.test(s) && !/order: "given"/.test(code("web/src/payers.js")), "the web wallet never pins a layout");
  if (funding.FEE_HEADROOM !== undefined) assert.equal(SESSION.MINE_FEE_HEADROOM, funding.FEE_HEADROOM, "one headroom for every route");
});

/* ============================================================== copy rules */

test("copy: the new strings make no claim the trace test disproved", () => {
  const strings = [
    ...Object.values(PRIV.CROWD_TEXT).map((v) => (typeof v === "function" ? [v(0), v(1), v(9)] : [v])).flat(),
    ...["thin", "thinChoice", "thinConfirm", "thinConfirmFirst", "thinCard", "mixUnknown", "linkableSent"].map((k) => {
      const v = SHARED.RELAY_TEXT[k];
      return typeof v === "function" ? v({ k: 5 }) : v;
    }),
    SHARED.RELAY_TEXT.mix({ depositors: 1, k: 3, coverOk: false }),
    SHARED.RELAY_TEXT.mix({ depositors: 9, k: 3, coverOk: true }),
    SHARED.BATCH_TEXT.alone, RELAY.FALLBACK.pool_thin, ACT.RETRY_LINKABLE, MINE.MINE_LINKABLE,
  ];
  for (const t of strings) {
    assert.equal(typeof t, "string");
    assert.ok(!/anonym|untraceable|trustless|\bmix(er|ers|ing|ed)?\b|unlinkable|sender (is |stays )?hidden/i.test(t), t);
  }
});

test("copy: no screen says a transfer's sender is hidden as a blanket claim", () => {
  const banned = [
    /you and the recipient stay hidden/i,
    /amount, sender and recipient are hidden/i,
    /both of you stay hidden/i,
    /proof hides who, what and how much/i,
    /Can't see who, what or how much/i,
  ];
  for (const f of ["web/src/views/app-send.js", "web/src/views/landing.js", "web/src/views/pay.js", "web/src/views/receipt.js", "web/src/views/app-activity.js"]) {
    for (const re of banned) assert.ok(!re.test(src(f)), `${f}: ${re}`);
  }
  assert.match(src("web/src/views/landing.js"), /Whether anyone can tell who sent one depends on who pays its fee and how many others use the pool/);
  assert.match(src("web/src/views/security.js"), /the relayer's coin itself descends from your top-up/);
  // The Crowd Meter on the portfolio grades a thin-pool relay route as linkable.
  assert.match(code("web/src/views/app-portfolio.js"), /mixState\(s\.relayInfo\) === "thin" \? "relay-linkable" : "relay"/);
});

/* ============================================================ review fixes */

test("L1 review: a relayer whose k is below the wallet's floor (0 turns its rule off) gives no cover: thin, the linkable box, a refusal before anything is sent", async () => {
  assert.equal(RELAY.MIN_COVER_K, 3);
  for (const k of [0, 1, 2]) {
    const info = balanceInfo({ mix: { k, coverOk: true, depositors: 9 } });
    assert.equal(RELAY.mixState(info), "thin", `k ${k}`);
    assert.match(String(SET.mixLine(info)), /callout--warn/, "Settings warns");
    assert.match(String(SEND.relayPrivacyBlock({ mix: RELAY.mixState(info), k })), /name="linkable"/, "Send asks for consent");
    assert.equal(SEND.senderHidden({ via: "relay", mix: RELAY.mixState(info), crowd: PRIV.crowdCheck({ candidates: 40, mode: "block" }) }), false, "the sender is never listed as hidden");
    assert.match(String(MINE.mineMixBlock(info)), /name="mine-linkable"/, "and so do relayed claims");
  }
  assert.equal(RELAY.mixState(balanceInfo({ mix: { k: null, coverOk: true, depositors: 9 } })), "thin", "an unreadable k is no cover either");
  assert.equal(RELAY.mixState(balanceInfo({ mix: { k: 3, coverOk: true, depositors: 9 } })), "ok");
  assert.match(SHARED.RELAY_TEXT.thin({ k: 0 }), /does not require its coins to descend from enough separate depositors/);
  assert.match(SHARED.RELAY_TEXT.mix({ k: 0, coverOk: true, depositors: 1 }), /too few to hide one/);
  assert.match(SHARED.RELAY_TEXT.thin({ k: 3 }), /at least 4 separate depositors/, "the rule is k + 1 depositors, whoever sends");
  RELAY.RELAY_ROUTE.open = true;
  const client = fakeRelay(balanceInfo({ mix: { k: 0, coverOk: true, depositors: 1 } }));
  await assert.rejects(RELAY.submitEnvelope(transact(), { client, account: ACCOUNT, balance: FUNDED }), (e) => e.code === "pool_thin");
  assert.equal(client.calls.submits.length, 0, "nothing reached the relayer");
  await RELAY.submitEnvelope(transact(), { client, account: ACCOUNT, balance: FUNDED, linkable: true });
  assert.equal(JSON.parse(JSON.stringify(client.calls.submits[0])).linkable, true, "with consent it goes, signed linkable");
});

test("L3 review: a copied envelope lists the sender as hidden only while the crowd at its anchor is known and not thin, and shows the crowd warning", () => {
  const ok = PRIV.crowdCheck({ candidates: 40, mode: "block" });
  const thin = PRIV.crowdCheck({ candidates: 3, mode: "block" });
  assert.equal(SEND.senderHidden({ via: "copy", crowd: ok }), true);
  assert.equal(SEND.senderHidden({ via: "copy", crowd: thin }), false, "the anchor alone can name the sender (trace test tx #3)");
  assert.equal(SEND.senderHidden({ via: "copy", crowd: null }), false, "not claimed while the crowd is unknown");
  assert.equal(SEND.senderHidden({ via: "relay", mix: "ok", crowd: null }), false);
  const block = String(SEND.relayPrivacyBlock({ mix: null, crowd: thin }));
  assert.ok(block.includes(PRIV.CROWD_TEXT.few), "the crowd warning");
  assert.ok(!block.includes(SHARED.RELAY_TEXT.mixUnknown) && !block.includes('name="linkable"'), "and nothing about a relayer");
  const send = code("web/src/views/app-send.js");
  assert.match(send, /const crowd = relay \|\| copy \? crowdNow\(\) : null;/, "the Disclosure Preview counts the crowd for a copied envelope");
  assert.match(send, /if \(form\.via === "copy"\) return s\.sendCrowd\(\{ mode: "block" \}\);/);
  assert.match(send, /form\.via === "copy"\s*\? relayPrivacyBlock\(\{ mix: null, crowd: crowdNow\(\) \}\)/, "and paints its warning");
});

test("L1 review: a relayed send the relayer missed for a thin pool says so, offers the linkable retry, and no top-up", () => {
  assert.match(RELAY.missedText("pool_thin"), /^Not sent: too few people had topped up the relay pool to send it without tying it to your top-up address\. Nothing was charged\.$/);
  assert.match(RELAY.missedText("balance_low"), /balance did not cover/);
  assert.match(RELAY.missedText("fee_high"), /above the relayer's cap/);
  const entry = { id: "e1", kind: "send", via: "relay", relayId: "ab".repeat(16), status: "relaying", mode: "block", anchor: 100, spends: ["1"], commitments: [], envelope: "00" };
  const st = SESSION.deriveStatus(entry, { height: 101, relay: { status: "missed", code: "pool_thin" } });
  assert.deepEqual([st.status, st.relayStatus, st.missedCode, st.failCode], ["failed", "missed", "pool_thin", "pool_thin"]);
  assert.equal(st.reason, RELAY.missedText("pool_thin"));
  RELAY.RELAY_ROUTE.open = true;
  const s = { relayBalance: { balance: 100_000, reserved: 0 }, relayInfo: balanceInfo({ mix: COVER }) };
  const buttons = String(ACT.retryButtons({ ...entry, ...st }, 101, s));
  assert.ok(buttons.includes(ACT.RETRY_LINKABLE.replace(/'/g, "&#39;")) || buttons.includes(ACT.RETRY_LINKABLE), "the explicit linkable retry");
  assert.ok(!buttons.includes("Top up"), "no top-up: the balance was fine");
  const low = SESSION.deriveStatus(entry, { height: 101, relay: { status: "missed", code: "balance_low" } });
  assert.deepEqual([low.missedCode, low.failCode], ["balance_low", undefined]);
  assert.ok(String(ACT.retryButtons({ ...entry, ...low }, 101, s)).includes("Top up"));
});

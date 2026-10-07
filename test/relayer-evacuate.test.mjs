// Emergency path of the paid relayer (docs/design/relay-balance.md §9, docs/OPERATIONS.md 10.4):
// `murkle relayer evacuate` (HOLD freezes a running relayer, every controlled coin swept to a cold
// address, nothing foreign; the fee an operator cost: margin first, then an operator liability;
// every balance kept), `--dry-run`, `--bump`, `rotate` (never an old key, the books carried over,
// I2 failing until `refund-pool`), late deposits to retired addresses (`sweep-retired`), and the
// wallets (CLI and web) switching to the new deposit addresses.
//
// Fakes only: FakeEsplora (nothing real is broadcast; it refuses to list the relayer's addresses),
// a synthetic chain, temporary directories, a fake DOM and a fake fetch that routes the web
// wallet's relay calls to the relayer under test. Nothing touches data/.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";

/* ---------- a minimal DOM for the web wallet (set before its modules load) ---------- */

class FakeEl {
  constructor() {
    this.dataset = {};
    this.ls = {};
    this.html = "";
    this.classList = { add() {}, remove() {}, contains: () => false, toggle() {} };
  }
  get innerHTML() {
    return this.html;
  }
  set innerHTML(v) {
    this.html = String(v);
  }
  querySelector() {
    return new FakeEl();
  }
  querySelectorAll() {
    return [];
  }
  addEventListener() {}
  removeEventListener() {}
  contains() {
    return false;
  }
  append() {}
  replaceChildren() {}
  remove() {}
  focus() {}
  setAttribute() {}
}
globalThis.Node = FakeEl;
globalThis.document = {
  createElement() {
    const t = { content: null };
    Object.defineProperty(t, "innerHTML", {
      set(v) {
        const el = new FakeEl();
        el.html = String(v);
        t.content = { childNodes: [el], firstChild: el };
      },
    });
    return t;
  },
  body: new FakeEl(), documentElement: new FakeEl(), activeElement: null, hidden: true,
  addEventListener() {}, removeEventListener() {}, getElementById: () => null, hasFocus: () => true,
};
globalThis.requestAnimationFrame = () => 0;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.location = { href: "https://murkle.example/app", origin: "https://murkle.example", pathname: "/app", search: "", hash: "" };
globalThis.history = { state: null, pushState() {}, replaceState() {} };

const {
  FakeEsplora, accountMod, booksMod, chain, fundAccount, makeFakeEsplora, makePaidRelayer, newAccount, poolCoins, relayerMod,
  signedAccount, signedSubmit, silent, synth, txOf,
} = await import("./fixtures/relay-harness.mjs");
const EV = await import("../server/relay-evacuate.mjs");
const CLI = await import("../bin/murkle.mjs");
const { hex, unhex } = await import("../src/bytes.mjs");
const { RBF_SEQUENCE, scriptOf } = await import("../src/btc/funding.mjs");
const S = await import("../web/src/session.js");
const R = await import("../web/src/relay.js");
const TOPUP = await import("../web/src/views/topup.js");
const { RELAY_TEXT } = await import("../web/src/views/app-shared.js");
const { esc } = await import("../web/src/ui/dom.js");

const { RELAY_FILES, MESSAGES, ERROR_STATUS, startPaidRelayer } = relayerMod;
const { depositAddress } = accountMod;
const { RelayBooks } = booksMod;

const DIR = mkdtempSync(join(tmpdir(), "murkle-evacuate-"));
const relayers = [];
after(() => {
  for (const r of relayers) r.close();
  rmSync(DIR, { recursive: true, force: true });
});
// Nothing under data/ is created, removed or rewritten by these tests (a live relayer may rewrite
// its own files meanwhile, so the file lists are compared).
const DATA_DIRS = ["data/signet", "data/signet/relay-balance"];
const list = (d) => (existsSync(d) ? readdirSync(d).filter((n) => !n.endsWith(".tmp")).sort() : null);
const dataBefore = DATA_DIRS.map(list);
after(() => assert.deepEqual(DATA_DIRS.map(list), dataBefore, "data/ untouched"));

const CFG = { relayDir: "relay-balance", keyPath: "relayer.key", statePath: "relayer.json", fanoutTarget: 0, minMix: 0 };
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const anyIp = () => `203.0.113.${1 + (randomBytes(1)[0] % 250)}`;
const code = (out) => out.body?.error?.code;
const quiet = () => {
  const lines = [];
  const print = (s) => lines.push(String(s));
  print.lines = lines;
  return print;
};
/** A cold address whose key never was on the relayer: { key, address, script }. */
function cold() {
  const key = new Uint8Array(randomBytes(32));
  const pay = btc.p2tr(schnorr.getPublicKey(key), undefined, btc.TEST_NETWORK);
  return { key, address: pay.address, script: pay.script };
}
const inputsOf = (raw) => {
  const tx = txOf(raw);
  return Array.from({ length: tx.inputsLength }, (_, i) => ({ key: `${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`, sequence: tx.getInput(i).sequence }));
};
/** Bitcoin Core's replacement, as far as these tests need it: a transaction spending an input of a mempool transaction evicts it. */
function withRbf(esplora) {
  const base = esplora.broadcast.bind(esplora);
  esplora.broadcast = async (raw) => {
    const tx = txOf(raw);
    for (let i = 0; i < tx.inputsLength; i++) {
      const by = esplora.spentBy.get(`${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`)?.[0];
      if (by && by !== tx.id && esplora.mempool.has(by)) esplora.evict(by);
    }
    return base(raw);
  };
  return esplora;
}
/** The cold wallet's coins (esplora's own listing; only the relayer itself never lists an address). */
function coldView(esplora) {
  const view = Object.create(esplora);
  view.utxos = async (address) => {
    const script = scriptOf(address);
    return [...esplora.coins].filter(([, c]) => Buffer.from(c.script).equals(Buffer.from(script))).map(([k, c]) => {
      const [txid, vout] = k.split(":");
      return { txid, vout: Number(vout), value: c.value, status: esplora.mined.has(txid) ? { confirmed: true, block_height: esplora.mined.get(txid) } : { confirmed: false } };
    });
  };
  return view;
}
/** The books equation I2 holds whatever the pool holds: credited + operatorIn − fees − serviceOut − balances − reserved = margin. */
function equationHolds(books) {
  const r = books.checkI2({ poolUnspent: Number.MAX_SAFE_INTEGER });
  return r.ok ? true : r.problems;
}

/** A chain, a fake esplora, a running paid relayer after its first tick, and its directory. */
async function world({ start = 880_000 } = {}) {
  const esplora = makeFakeEsplora({ fee: 1 });
  const c = chain({ start, fakes: [esplora] });
  await c.mine();
  const r = await makePaidRelayer({ idx: c.idx, esplora, config: CFG });
  relayers.push(r);
  await r.onTick({ chainTip: c.idx.height });
  const root = r.harnessDir;
  const w = {
    esplora, c, idx: c.idx, r, root,
    tick: (rr = w.r) => rr.onTick({ chainTip: c.idx.height }),
    step: async (rr = w.r) => {
      await c.mine();
      await rr.onTick({ chainTip: c.idx.height });
    },
    /** Mines every mempool transaction (sweeps, carriers, refunds) into the next block. */
    land: async () => c.mineCarriers(esplora),
    /** The relayer as startPaidRelayer starts it from the directory now (frozen while a HOLD is in place). */
    restart: async () => {
      const rr = await startPaidRelayer({ idx: c.idx, esplora, config: { ...relayerMod.DEFAULTS, enabled: true, relayMode: "balance", ...CFG }, root, log: silent });
      relayers.push(rr);
      return rr;
    },
    tool: { root, config: CFG, esplora },
  };
  return w;
}

/**
 * A relayer holding every kind of coin: change coins of A's merged deposits (confirmed), a
 * broadcast carrier's change (unconfirmed), credited deposits of B and C not merged yet, one
 * queued send of A, and foreign coins at C, at Q and at an uncredited deposit address.
 */
async function busyWorld() {
  const w = await world();
  const { account: a } = await poolCoins({ relayer: w.r, esplora: w.esplora, values: [20_000, 15_000] });
  const sent = await w.r.submit(signedSubmit(a, w.r.info(), synth(w.idx)), anyIp());
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  await w.step(); // the carrier goes out with the next block
  assert.equal(w.r.status(sent.body.id).status, "broadcast");
  const queued = await w.r.submit(signedSubmit(a, w.r.info(), synth(w.idx)), anyIp());
  assert.equal(queued.status, 202, JSON.stringify(queued.body));
  const b = newAccount();
  const cAcct = newAccount();
  for (const acct of [b, cAcct]) assert.equal((await fundAccount({ relayer: w.r, esplora: w.esplora, account: acct, sats: 9000 })).status, 200);
  const stranger = newAccount();
  const foreignTx = w.esplora.pay([
    { script: w.r.change.script, value: 50_000 },
    { script: w.r.poolScript, value: 40_000 },
    { script: depositAddress(w.r.Q, stranger.id, 0, "signet").script, value: 30_000 },
  ], { height: w.idx.height });
  return { w, a, b, c: cAcct, sentId: sent.body.id, queuedId: queued.body.id, foreign: [0, 1, 2].map((v) => `${foreignTx}:${v}`) };
}

/** runEvacuate against a running relayer that sees the HOLD at its next poll (here: every sleep). */
async function evacuateRunning(w, extra = {}) {
  const print = quiet();
  const out = await EV.runEvacuate({ ...w.tool, waitMs: 2000, sleep: async () => void (await w.r.checkHold()), print, ...extra });
  return { out, lines: print.lines };
}

/* ------------------------------------------------------------------ evacuation */

test("evacuate: HOLD freezes the running relayer (submits and credits refused, queued items released, nothing charged), every controlled coin is swept to the cold address and nothing foreign; the fee comes from the margin and every balance is kept", async () => {
  const { w, a, b, c, sentId, queuedId, foreign } = await busyWorld();
  const accounts = [a, b, c];
  const before = new Map(accounts.map((x) => [x.idHex, w.r.books.account(x.idHex)]));
  const margin0 = w.r.books.margin;
  const available0 = w.r.books.availableMargin();
  const owned = Object.entries(w.r.state.coins).filter(([, x]) => x.status === "unspent").map(([k]) => k).sort();
  assert.ok(owned.length >= 4, "change coins, the carrier's change and two deposits");
  const to = cold();
  const calls = w.esplora.calls.length;

  const { out, lines } = await evacuateRunning(w, { to: to.address });
  assert.equal(out.status, "evacuated");
  // The running relayer froze at once: no send, credit or write from it any more.
  assert.equal(w.r.frozen, true);
  assert.ok(existsSync(join(w.root, "relay-balance", RELAY_FILES.ack)), "HOLD.ack written");
  const refused = await w.r.submit(signedSubmit(a, w.r.info(), synth(w.idx)), anyIp());
  assert.deepEqual([refused.status, code(refused)], [503, "relayer_evacuating"]);
  assert.equal(refused.body.error.message, MESSAGES.relayer_evacuating);
  const d = newAccount();
  const credit = await fundAccount({ relayer: w.r, esplora: w.esplora, account: d });
  assert.deepEqual([credit.status, code(credit)], [503, "relayer_evacuating"]);
  const read = await w.r.account(signedAccount(a, w.r.info()), anyIp());
  assert.equal(read.status, 200, "a balance read is still answered");
  assert.equal(w.r.info().code, "relayer_evacuating");
  assert.equal(w.r.info().balance.depositsOpen, false);
  assert.deepEqual([w.r.health().halted, w.r.health().code], [true, "relayer_evacuating"]);

  // Sweeps: every input is a coin of the relayer's own records, every such coin is swept once, nothing foreign.
  const sweeps = w.esplora.accepted.slice(-out.sweeps.length);
  assert.equal(w.esplora.calls.length - calls, out.sweeps.length, "one broadcast per sweep");
  assert.ok(out.sweeps.length >= 2 && out.sweeps.length <= 3, "confirmed coins together, the unconfirmed change apart");
  const swept = sweeps.flatMap(inputsOf);
  assert.deepEqual(swept.map((i) => i.key).sort(), owned, "exactly the coins the relayer controls");
  for (const f of foreign) assert.ok(!swept.some((i) => i.key === f), `foreign coin ${f} is never touched`);
  for (const i of swept) assert.equal(i.sequence, RBF_SEQUENCE, "every input signals RBF");
  for (const raw of sweeps) {
    const tx = txOf(raw);
    assert.equal(tx.outputsLength, 1);
    assert.deepEqual(Buffer.from(tx.getOutput(0).script), Buffer.from(to.script), "one output, to the cold address");
  }
  assert.equal(w.esplora.utxoCalls, 0, "no address of the relayer was ever listed");

  // The books, from the files: every balance kept, the queued item released, the fee from the margin.
  const { r: back } = await EV.openRelayer({ ...w.tool, guard: false });
  for (const x of accounts) {
    const was = before.get(x.idHex);
    const now = back.books.account(x.idHex);
    assert.equal(now.balance + now.reserved, was.balance + was.reserved, "balance kept in full");
    assert.equal(now.reserved, 0, "no reservation left");
  }
  assert.equal(back.state.items[queuedId].status, "missed");
  assert.equal(back.state.items[queuedId].code, "relayer_evacuating");
  assert.equal(back.state.items[sentId].status, "broadcast", "a sent carrier keeps its status");
  const fee = out.fee;
  assert.ok(fee > 0 && fee <= available0, "the margin covered this fee");
  assert.equal(back.books.margin, margin0 - fee);
  assert.deepEqual(back.books.operator, { in: 0, owed: 0 });
  assert.equal(equationHolds(back.books), true);
  const i2 = back.books.checkI2({ poolUnspent: back.poolUnspent() });
  assert.equal(i2.ok, false, "the pool is empty: I2 fails until it is refilled");
  assert.ok(i2.problems.every((p) => /^pool unspent/.test(p)), i2.problems.join("; "));
  assert.ok(back.state.halted, "and the relayer records the halt");
  assert.ok(back.state.ledger.filter((l) => l.kind === "evacuation").length === out.sweeps.length, "the sweeps are in the public ledger");
  assert.ok(lines.some((l) => /every user's balance is kept in full/.test(l)));
  // A relayer started while the HOLD is in place starts frozen and writes nothing.
  const stateHash = sha(join(w.root, "relay-balance", "relayer.json"));
  const again = await w.restart();
  assert.equal(again.frozen, true);
  assert.equal(again.info().code, "relayer_evacuating");
  await again.onTick({ chainTip: w.idx.height });
  assert.equal(sha(join(w.root, "relay-balance", "relayer.json")), stateHash, "a frozen relayer writes nothing");
});

test("evacuate --dry-run: prints the plan, broadcasts nothing, writes nothing and does not stop the relayer", async () => {
  const { w, a } = await busyWorld();
  const state = join(w.root, "relay-balance", "relayer.json");
  const hash = sha(state);
  const calls = w.esplora.calls.length;
  const print = quiet();
  const out = await EV.runEvacuate({ ...w.tool, to: cold().address, dryRun: true, print });
  assert.equal(out.status, "dry-run");
  assert.ok(out.plans.length >= 1 && out.plans.every((p) => /^[0-9a-f]+$/.test(p.raw)));
  assert.equal(w.esplora.calls.length, calls, "nothing broadcast");
  assert.equal(sha(state), hash, "nothing written");
  assert.equal(existsSync(join(w.root, "relay-balance", RELAY_FILES.hold)), false, "no HOLD");
  assert.ok(print.lines.some((l) => /nothing was written or broadcast/.test(l)));
  await w.r.checkHold();
  assert.equal(w.r.frozen, false);
  const ok = await w.r.submit(signedSubmit(a, w.r.info(), synth(w.idx)), anyIp());
  assert.equal(ok.status, 202, "the relayer still takes sends");
});

test("evacuate --bump: the same coins signed again at a higher rate (RBF), the extra fee booked as an operator cost; a lower rate is refused; the rotation settles on the version that confirmed", async () => {
  const { w } = await busyWorld();
  withRbf(w.esplora);
  const to = cold();
  const { out } = await evacuateRunning(w, { to: to.address, feeRate: 3 });
  const first = out.sweeps.map((s) => s.versions.at(-1));
  const fees0 = (await EV.openRelayer({ ...w.tool, guard: false })).r.books.totals.fees;
  await assert.rejects(EV.runEvacuate({ ...w.tool, bump: true, feeRate: 3, waitMs: 0, print: quiet() }), /--fee-rate must be above the last rate/);
  const bumped = await EV.runEvacuate({ ...w.tool, bump: true, feeRate: 9, waitMs: 0, print: quiet() });
  assert.equal(bumped.status, "bumped");
  assert.equal(bumped.bumps.length, first.length);
  const { r: back } = await EV.openRelayer({ ...w.tool, guard: false });
  let extra = 0;
  for (const [k, sweep] of back.state.evacuation.sweeps.entries()) {
    const [v1, v2] = sweep.versions;
    assert.equal(v1.txid, first[k].txid);
    assert.ok(v2.fee > v1.fee && v2.feeRate === 9);
    assert.deepEqual(inputsOf(v2.raw).map((i) => i.key).sort(), inputsOf(v1.raw).map((i) => i.key).sort(), "the same coins");
    assert.ok(inputsOf(v2.raw).every((i) => i.sequence === RBF_SEQUENCE), "still replaceable");
    assert.ok(w.esplora.mempool.has(v2.txid) && !w.esplora.mempool.has(v1.txid), "the replacement took the old one's place");
    const entry = back.state.ledger.find((l) => l.seq === sweep.seq);
    assert.deepEqual([entry.txid, entry.fee, entry.replaces], [v2.txid, v2.fee, [v1.txid]]);
    extra += v2.fee - v1.fee;
  }
  assert.equal(back.books.totals.fees, fees0 + extra);
  assert.equal(equationHolds(back.books), true);
  await w.land();
  const rot = await EV.rotate({ ...w.tool, print: quiet() });
  assert.equal(rot.status, "rotated");
  const g0 = JSON.parse(readFileSync(join(rot.retiredDir, "relayer.json"), "utf8"));
  assert.ok(g0.evacuation.sweeps.every((s) => s.status === "confirmed" && s.versions.length === 2 && s.txid === s.versions[1].txid));
});

test("the fee beyond the margin is an operator liability, never a user's: balances untouched, refunded with the pool, then paid", async () => {
  const { w, a, b, c } = await busyWorld();
  const before = [a, b, c].map((x) => w.r.books.account(x.idHex));
  const available = w.r.books.availableMargin();
  const to = cold().address;
  const state = join(w.root, "relay-balance", "relayer.json");
  // A rate whose fees would take most of the coins reads as a typo: refused before anything is signed.
  await assert.rejects(evacuateRunning(w, { to, feeRate: 120 }), /refused: fees of .* would take \d+% .*--high-fee/);
  assert.equal(w.esplora.accepted.filter((raw) => txOf(raw).outputsLength === 1 && Buffer.from(txOf(raw).getOutput(0).script).equals(Buffer.from(scriptOf(to)))).length, 0, "nothing sent");
  assert.equal(JSON.parse(readFileSync(state, "utf8")).evacuation?.sweeps?.length ?? 0, 0, "nothing journaled");
  const { out } = await evacuateRunning(w, { to, feeRate: 120, highFee: true });
  assert.ok(out.fee > available, "this fee is larger than the margin");
  const { r: back } = await EV.openRelayer({ ...w.tool, guard: false });
  assert.equal(back.books.margin, w.r.books.margin - available, "the available margin paid first");
  assert.deepEqual(back.books.operator, { in: out.fee - available, owed: out.fee - available });
  [a, b, c].forEach((x, k) => {
    const now = back.books.account(x.idHex);
    assert.equal(now.balance + now.reserved, before[k].balance + before[k].reserved);
  });
  assert.equal(equationHolds(back.books), true);
  assert.equal(back.books.toJSON().operator.owed, out.fee - available, "written to the books file");
  // Rotate and refill: the refill covers balances, reservations and what is left of the margin.
  await w.land();
  const rot = await EV.rotate({ ...w.tool, print: quiet() });
  const refund = await EV.refundPool({ ...w.tool, outpoint: payTo(w, rot.address, rot.need), print: quiet() });
  assert.equal(refund.status, "funded");
  assert.equal(refund.owed, out.fee - available, "the liability is paid with the refill");
  const { r: after2 } = await EV.openRelayer({ ...w.tool, guard: false });
  assert.deepEqual(after2.books.operator, { in: out.fee - available, owed: 0 });
  assert.equal(after2.books.checkI2({ poolUnspent: after2.poolUnspent() }).ok, true);
});

/** The operator's payment to `address` of `sats` (a cold wallet paying by hand), mined: its outpoint. */
function payTo(w, address, sats) {
  const txid = w.esplora.pay([{ script: scriptOf(address), value: sats }], { height: w.idx.height });
  return `${txid}:0`;
}

/* ------------------------------------------------------------------ rotation */

test("rotate: refuses before the sweep confirms and never reuses a key (old pool, old change, the v1 key); then new keys, the books carried over, the old key retired and published, I2 failing until refund-pool and holding after", async () => {
  const { w, a, b, c } = await busyWorld();
  const before = [a, b, c].map((x) => w.r.books.account(x.idHex));
  const marginBefore = w.r.books.margin;
  const { out } = await evacuateRunning(w, { to: cold().address });
  await assert.rejects(EV.rotate({ ...w.tool, print: quiet() }), /not confirmed yet/);
  await w.land();
  const rb = join(w.root, "relay-balance");
  const keys = ["pool.key", "change.key", "relayer.json"].map((n) => sha(join(rb, n)));
  const oldPool = readFileSync(join(rb, "pool.key"), "utf8");
  const oldChange = readFileSync(join(rb, "change.key"), "utf8");
  const v1 = new Uint8Array(randomBytes(32));
  writeFileSync(join(w.root, "relayer.key"), hex(v1));
  for (const reuse of [unhex(oldPool), unhex(oldChange), v1]) {
    await assert.rejects(EV.rotate({ ...w.tool, newKey: () => reuse, print: quiet() }), /used before by this relayer; nothing was changed/);
    assert.deepEqual(["pool.key", "change.key", "relayer.json"].map((n) => sha(join(rb, n))), keys, "nothing changed");
    assert.equal(existsSync(join(rb, "retired")), false);
  }
  // The negation of an old key has the same x-only public key: refused too.
  const neg = (k) => {
    const N = schnorr.Point.Fn.ORDER;
    return unhex((N - BigInt(`0x${k}`)).toString(16).padStart(64, "0"));
  };
  await assert.rejects(EV.rotate({ ...w.tool, newKey: () => neg(oldPool), print: quiet() }), /used before/);

  const rot = await EV.rotate({ ...w.tool, print: quiet() });
  assert.equal(rot.generation, 1);
  assert.notEqual(readFileSync(join(rb, "pool.key"), "utf8"), oldPool);
  assert.notEqual(readFileSync(join(rb, "change.key"), "utf8"), oldChange);
  assert.equal(readFileSync(join(rb, "retired", "g0", "pool.key"), "utf8"), oldPool, "the old keys are kept for late deposits");
  assert.equal(readFileSync(join(rb, "retired", "g0", "change.key"), "utf8"), oldChange);
  assert.ok(existsSync(join(rb, RELAY_FILES.tags)), "the books keys of the first pool key are kept");
  assert.ok(existsSync(join(rb, RELAY_FILES.hold)), "the relayer stays held until the pool is refilled");

  // Restarted: frozen, the new pool key published with the old one retired, sends and credits refused, balances read.
  const r2 = await w.restart();
  const info = r2.info();
  assert.equal(info.balance.poolKey, rot.poolKey);
  assert.deepEqual(info.balance.retiredPoolKeys, [w.r.poolHex]);
  assert.deepEqual([info.code, info.balance.depositsOpen, info.balance.generation], ["pool_unfunded", false, 1]);
  assert.equal(info.reason, MESSAGES.pool_unfunded);
  assert.equal(ERROR_STATUS.pool_unfunded, 503);
  const sendNow = await r2.submit(signedSubmit(a, info, synth(w.idx)), anyIp());
  assert.deepEqual([sendNow.status, code(sendNow)], [503, "pool_unfunded"]);
  for (const [k, x] of [a, b, c].entries()) {
    const read = await r2.account(signedAccount(x, info), anyIp());
    assert.equal(read.status, 200);
    assert.equal(read.body.balance + read.body.reserved, before[k].balance + before[k].reserved, "every balance carried over, found by the same account");
    assert.equal(read.body.nextIndex, before[k].nextIndex);
    assert.equal(read.body.depositAddress, depositAddress(unhex(rot.poolKey), x.id, read.body.nextIndex, "signet").address, "addresses of the new key");
  }
  assert.equal(r2.books.margin, marginBefore - out.fee);
  assert.equal(r2.checkBooks().ok, false, "I2 fails: the new pool holds nothing yet");

  // refund-pool: a wrong output is refused; the cold wallet's payment of what is owed makes I2 hold.
  await assert.rejects(EV.refundPool({ ...w.tool, outpoint: payTo(w, cold().address, 5000), print: quiet() }), /does not pay the pool's change address/);
  await assert.rejects(EV.refundPool({ ...w.tool, print: quiet() }), /--from <cold key file> or --outpoint/);
  const refund = await EV.refundPool({ ...w.tool, outpoint: payTo(w, rot.address, rot.need), print: quiet() });
  assert.equal(refund.status, "funded");
  assert.equal(existsSync(join(rb, RELAY_FILES.hold)), false, "HOLD lifted");
  const r3 = await w.restart();
  assert.equal(r3.frozen, false);
  assert.equal(r3.checkBooks().ok, true, "I2 holds again");
  await w.step(r3);
  assert.equal(r3.info().code, null);
  assert.equal(r3.info().balance.depositsOpen, true);
  const resumed = await r3.submit(signedSubmit(a, r3.info(), synth(w.idx)), anyIp());
  assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
});

test("refund-pool --from: the cold wallet pays the shortfall to the new C (RBF), the coin is pool money once it confirms; --dry-run sends nothing", async () => {
  const { w } = await busyWorld();
  const to = cold();
  await evacuateRunning(w, { to: to.address });
  await w.land();
  const rot = await EV.rotate({ ...w.tool, print: quiet() });
  const keyFile = join(DIR, `cold-${randomBytes(4).toString("hex")}.key`);
  writeFileSync(keyFile, hex(to.key));
  // The sweep paid the cold address its coins less the fee; the operator adds the difference.
  w.esplora.pay([{ script: to.script, value: 5000 }], { height: w.idx.height });
  const view = coldView(w.esplora);
  const calls = w.esplora.calls.length;
  const dry = await EV.refundPool({ ...w.tool, esplora: view, fromKey: keyFile, dryRun: true, print: quiet() });
  assert.equal(dry.status, "dry-run");
  assert.equal(w.esplora.calls.length, calls, "nothing broadcast");
  await assert.rejects(EV.refundPool({ ...w.tool, esplora: view, fromKey: keyFile, amount: rot.need - 1, print: quiet() }), /--amount must cover the shortfall/);
  const out = await EV.refundPool({ ...w.tool, esplora: view, fromKey: keyFile, print: quiet() });
  // Broadcast and recorded, but an unconfirmed refill can still be replaced or evicted: it counts
  // only once it is in a block, so the pool stays unfunded (and the HOLD in place) until then.
  assert.equal(out.status, "unconfirmed");
  const tx = txOf(w.esplora.accepted.at(-1));
  assert.equal(Number(tx.getOutput(out.vout).amount), rot.need);
  for (let i = 0; i < tx.inputsLength; i++) assert.equal(tx.getInput(i).sequence, RBF_SEQUENCE);
  assert.ok(existsSync(join(w.root, "relay-balance", RELAY_FILES.hold)), "still held");
  await assert.rejects(EV.refundPool({ ...w.tool, esplora: view, fromKey: keyFile, print: quiet() }), /is waiting for a block: run murkle relayer refund-pool --outpoint/, "never paid twice");
  const key = `${out.txid}:${out.vout}`;
  assert.equal((await EV.refundPool({ ...w.tool, outpoint: key, print: quiet() })).status, "unconfirmed", "the same outpoint again: still waiting");
  let r3 = await w.restart();
  assert.equal(r3.info().code, "pool_unfunded");
  assert.equal(r3.checkBooks().ok, false, "I2 does not rest on an unconfirmed refill");
  await w.land();
  const done = await EV.refundPool({ ...w.tool, outpoint: key, print: quiet() });
  assert.equal(done.status, "funded");
  r3 = await w.restart();
  assert.equal(r3.checkBooks().ok, true);
  await w.tick(r3);
  assert.equal(r3.spendableCoins().length, 1);
});

/* ------------------------------------------------------- late deposits and wallets */

test("an old deposit address after the rotation: recorded (409 deposit_retired), never credited from the old key, swept into the new pool by sweep-retired and credited once that sweep confirms; the CLI keeps it pending meanwhile", async () => {
  const { w, a } = await busyWorld();
  await evacuateRunning(w, { to: cold().address });
  await w.land();
  const oldQ = w.r.Q;
  const rot = await EV.rotate({ ...w.tool, print: quiet() });
  await EV.refundPool({ ...w.tool, outpoint: payTo(w, rot.address, rot.need), print: quiet() });
  const r3 = await w.restart();
  await w.step(r3);
  const n = r3.books.account(a.idHex).nextIndex;
  const late = depositAddress(oldQ, a.id, n, "signet");
  const txid = w.esplora.pay([{ script: late.script, value: 8000 }], { height: w.idx.height });
  const body = JSON.stringify({ outpoint: `${txid}:0`, accountPub: a.pubHex, n });
  const first = await r3.credit(body, anyIp());
  assert.deepEqual([first.status, code(first), first.body.error.status], [409, "deposit_retired", "waiting"]);
  assert.equal(first.body.error.message, MESSAGES.deposit_retired);
  const again = await r3.credit(body, anyIp());
  assert.deepEqual([again.status, code(again)], [409, "deposit_retired"], "the same answer again");
  const other = newAccount();
  const stolen = await r3.credit(JSON.stringify({ outpoint: `${txid}:0`, accountPub: other.pubHex, n }), anyIp());
  assert.equal(code(stolen), "already_credited", "nobody else can claim it");
  const balance0 = r3.books.account(a.idHex).balance;

  // sweep-retired (the relayer stopped): into the new C, credited once it confirms.
  r3.close();
  const print = quiet();
  const swept = await EV.sweepRetired({ ...w.tool, waitMs: 0, relayerStopped: true, print });
  assert.equal(swept.status, "swept");
  const tx = txOf(w.esplora.accepted.at(-1));
  assert.deepEqual(inputsOf(w.esplora.accepted.at(-1)).map((i) => i.key), [`${txid}:0`]);
  assert.deepEqual(Buffer.from(tx.getOutput(0).script), Buffer.from(scriptOf(rot.address)), "into the new pool's change key");
  assert.equal(existsSync(join(w.root, "relay-balance", RELAY_FILES.hold)), false, "its maintenance HOLD is lifted");
  const r4 = await w.restart();
  assert.equal(r4.books.account(a.idHex).balance, balance0, "not credited before the sweep confirms");
  assert.equal(r4.spendableCoins().some((u) => u.key === `${tx.id}:0`), false, "not spent before it confirms");
  await w.land();
  await w.tick(r4);
  assert.equal(r4.books.account(a.idHex).balance, balance0 + 8000 - r4.sweepCost(), "credited as any deposit");
  assert.equal(r4.checkBooks().ok, true);
  const done = await r4.credit(body, anyIp());
  assert.deepEqual([done.status, done.body.already], [200, true], "the wallet's next try finds it credited");
});

test("CLI wallet: while the pool waits for its refill no top-up is offered; after the rotation the deposit address comes from the new pool key and the old ones are said to be retired", async () => {
  const { w } = await busyWorld();
  const seed = new Uint8Array(randomBytes(32));
  const file = { seed: hex(seed), relay: { depositIndex: 0 } };
  const acct = accountMod.relayAccount(seed, "signet");
  assert.equal((await fundAccount({ relayer: w.r, esplora: w.esplora, account: acct, sats: 12_000 })).status, 200);
  await evacuateRunning(w, { to: cold().address });
  await w.land();
  const oldQ = w.r.Q;
  const rot = await EV.rotate({ ...w.tool, print: quiet() });
  let r = await w.restart();
  const client = () => ({
    info: async () => r.info(),
    account: async (body) => r.account(JSON.stringify(body), anyIp()),
    credit: async (body) => r.credit(JSON.stringify(body), anyIp()),
  });
  const listing = coldView(w.esplora);
  const common = { name: "w", file, url: "http://127.0.0.1:8787", lib: accountMod, esplora: listing, save: () => {} };
  const print = quiet();
  const shown = await CLI.relayAccountCommand({ ...common, client: client(), print });
  assert.ok(shown.balance > 0, "the balance carried over");
  assert.ok(print.lines.some((l) => /no top-ups right now \(pool_unfunded\)/.test(l)));
  assert.ok(print.lines.some((l) => /every deposit address it showed before is retired/.test(l)));
  await assert.rejects(CLI.relayTopUpCommand({ ...common, client: client(), print: quiet() }), /takes no top-ups right now \(pool_unfunded\)/);
  await EV.refundPool({ ...w.tool, outpoint: payTo(w, rot.address, rot.need), print: quiet() });
  r = await w.restart();
  await w.step(r);
  const p2 = quiet();
  const top = await CLI.relayTopUpCommand({ ...common, client: client(), print: p2 });
  assert.equal(top.address, depositAddress(unhex(rot.poolKey), acct.id, top.n, "signet").address, "the new key's address");
  assert.notEqual(top.address, depositAddress(oldQ, acct.id, top.n, "signet").address);
  assert.ok(p2.lines.some((l) => /Never pay one again/.test(l)));
  // A payment to an old address of this wallet stays pending, with the reason, until the operator moves it.
  const oldDep = depositAddress(oldQ, acct.id, 1, "signet");
  const lateTx = w.esplora.pay([{ script: oldDep.script, value: 7000 }], { height: w.idx.height });
  const p3 = quiet();
  const credit = await CLI.relayCreditCommand({ ...common, client: client(), outpoint: `${lateTx}:0`, n: 1, print: p3 });
  assert.equal(credit.exit, 6, "waiting");
  assert.equal(credit.rows[0].state, "waiting");
  assert.match(credit.rows[0].text, /paid a retired deposit address: credited once the relayer's operator has moved it into the new pool/);
  // A payment from somewhere else (an exchange) to an address the wallet showed under the old key,
  // never recorded by this wallet: the plain `relay credit` looks there too and keeps it pending.
  const elsewhere = w.esplora.pay([{ script: depositAddress(oldQ, acct.id, 0, "signet").script, value: 5000 }], { height: w.idx.height });
  const p4 = quiet();
  const found = await CLI.relayCreditCommand({ ...common, client: client(), print: p4 });
  const row = found.rows.find((x) => x.outpoint === `${elsewhere}:0`);
  assert.deepEqual([row?.state, row?.retired, row?.n], ["waiting", true, 0]);
  assert.match(row.text, /paid a retired deposit address/);
  assert.ok(p4.lines.some((l) => l.startsWith("#0 (retired key)")));
  assert.ok(file.relay.pending.some((x) => x.outpoint === `${elsewhere}:0` && x.n === 0), "kept pending until it is credited");
  assert.equal(r.state.retiredDeposits[`${elsewhere}:0`].status, "waiting", "the relayer recorded it for sweep-retired");
  assert.deepEqual(CLI.rotationLines({ balance: { retiredPoolKeys: [] } }), []);
  assert.equal(CLI.depositsOpenAt({ code: "relayer_evacuating", balance: {} }), false);
  assert.equal(CLI.depositsOpenAt({ code: null, balance: {} }), true, "an older relayer that does not say: open");
});

test("web wallet: the balance is kept through the rotation, no address is shown while top-ups are closed, then addresses come from the new key with a warning; a payment to an old address is credited once swept", async () => {
  const { w } = await busyWorld();
  let r = w.r;
  const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(String(input), "http://indexer.test");
    const p = u.pathname;
    const m = p.match(/\/address\/([a-z0-9]+)\/utxo$/);
    if (m) return reply(200, await coldView(w.esplora).utxos(m[1]));
    if (p === "/api/relay/info") return reply(200, r.info());
    if (p === "/api/relay/account") {
      const out = await r.account(init.body, anyIp());
      return reply(out.status, out.body);
    }
    if (p === "/api/relay/credit") {
      const out = await r.credit(init.body, anyIp());
      return reply(out.status, out.body);
    }
    return reply(404, { error: { message: "Not found." } });
  };
  const s = new S.Session({ phrase: S.newPhrase() });
  const me = { id: unhex(s.relayAccount.idHex), idHex: s.relayAccount.idHex, pubHex: s.relayAccount.pubHex };
  await s.loadRelayInfo();
  const first = s.depositAddress(0);
  assert.equal(first.address, depositAddress(r.Q, me.id, 0, "signet").address);
  assert.equal((await fundAccount({ relayer: r, esplora: w.esplora, account: me, sats: 15_000, n: 0 })).status, 200);
  await s.loadRelayBalance();
  const kept = s.relayBalance.balance;
  assert.ok(kept > 0);
  // Paid to address #1 of the old key, still unconfirmed when the relayer evacuates.
  const oldQ = r.Q;
  const at1 = s.depositAddress(1);
  const lateTx = w.esplora.pay([{ script: scriptOf(at1.address), value: 9000 }]);
  s.recordTopUp({ n: 1, txid: lateTx, vout: 0, value: 9000 });

  await evacuateRunning(w, { to: cold().address });
  await s.loadRelayInfo();
  assert.equal(R.relayRotation(s.relayInfo).depositsOpen, false);
  assert.throws(() => s.depositAddress(), (e) => e.code === "relayer_evacuating");
  let body = String(TOPUP.topUpBody(s, {}));
  assert.ok(body.includes(esc(RELAY_TEXT.paused)), "top-ups are said to be closed");
  assert.ok(!body.includes(first.address) && !body.includes("data-topup-addr"), "no address at all");
  await w.land();
  const rot = await EV.rotate({ ...w.tool, print: quiet() });
  r = await w.restart();
  await s.loadRelayInfo();
  assert.equal(s.relayInfo.balance.poolKey, rot.poolKey);
  assert.deepEqual(R.relayRotation(s.relayInfo), { depositsOpen: false, code: "pool_unfunded", generation: 1, retired: [hex(oldQ)] });
  await s.loadRelayBalance();
  assert.equal(s.relayBalance.balance, kept, "the balance is read under the new key, unchanged");
  assert.deepEqual(await s.checkDeposits(), [], "nothing is looked up while top-ups are closed");

  await EV.refundPool({ ...w.tool, outpoint: payTo(w, rot.address, rot.need), print: quiet() });
  r = await w.restart();
  await w.step(r);
  await s.loadRelayInfo();
  const fresh = s.depositAddress();
  assert.equal(fresh.address, depositAddress(unhex(rot.poolKey), me.id, fresh.n, "signet").address, "addresses of the new key");
  body = String(TOPUP.topUpBody(s, {}));
  assert.ok(body.includes(esc(RELAY_TEXT.rotated)), "the rotation is said");
  assert.ok(body.includes("data-topup-addr") && !body.includes(at1.address) && !body.includes(first.address), "only the new address");
  // The old payment confirms: the wallet asks for it; the relayer records it and answers deposit_retired.
  // So does a payment someone made from elsewhere (an exchange) to the last address this wallet
  // showed under the old key, which the wallet never recorded.
  const elsewhere = w.esplora.pay([{ script: depositAddress(oldQ, me.id, 2, "signet").script, value: 6000 }]);
  await w.land();
  await w.tick(r);
  await s.loadRelayInfo(); // the block the wallet learns of (its tip) after a sync
  const rows = await s.checkDeposits();
  const row = rows.find((x) => x.outpoint === `${lateTx}:0`);
  assert.deepEqual([row?.state, row?.retired, row?.code], ["waiting", true, "deposit_retired"]);
  const other = rows.find((x) => x.outpoint === `${elsewhere}:0`);
  assert.deepEqual([other?.state, other?.retired, other?.code, other?.n], ["waiting", true, "deposit_retired", 2]);
  assert.ok(String(TOPUP.depositLine(row, TOPUP.topUpRules(s.relayInfo))).includes(esc(RELAY_TEXT.retiredWaiting)));
  r.close();
  await EV.sweepRetired({ ...w.tool, waitMs: 0, relayerStopped: true, print: quiet() });
  await w.land();
  r = await w.restart();
  await w.tick(r);
  const later = await s.checkDeposits();
  const done = later.find((x) => x.outpoint === `${lateTx}:0`);
  assert.equal(done?.state, "credited");
  assert.equal(later.find((x) => x.outpoint === `${elsewhere}:0`)?.state, "credited");
  assert.equal(s.relayBalance.balance, kept + 9000 + 6000 - 2 * r.sweepCost());
  assert.deepEqual((await s.checkDeposits()).filter((x) => x.retired), [], "it left the old key's pending list");
});

/* ------------------------------------------------------------------ guards and parsing */

test("a tool never overwrites a state file someone else wrote after it read it; HOLD reasons; the CLI flags are strict", async () => {
  const w = await world();
  const { r } = await EV.openRelayer({ ...w.tool });
  writeFileSync(join(w.root, "relay-balance", "relayer.json"), readFileSync(join(w.root, "relay-balance", "relayer.json"), "utf8").replace("{", '{"x":1,'));
  assert.throws(() => r.save(), /changed while the operator tool ran/);
  // A maintenance HOLD freezes with its own code; an evacuation upgrades it.
  const paths = EV.relayPaths(w.root, CFG);
  const h = EV.placeHold(paths, "maintenance");
  await w.r.checkHold();
  assert.equal(w.r.info().code, "maintenance");
  assert.equal(EV.placeHold(paths, "evacuate").nonce, h.nonce, "the same HOLD");
  assert.equal(JSON.parse(readFileSync(paths.hold, "utf8")).reason, "evacuate");
  EV.releaseHold(paths);
  assert.equal(existsSync(paths.hold), false);

  const P = CLI.parseRelayerArgs;
  const COLD = cold().address;
  assert.deepEqual(P("evacuate", ["--to", COLD, "--fee-rate", "20", "--dry-run"]), {
    sub: "evacuate", to: COLD, feeRate: 20, waitSecs: null, dryRun: true, bump: false, cancel: false, highFee: false, relayerStopped: false, acceptLost: false, from: null, outpoint: null, amount: null,
  });
  assert.equal(P("evacuate", ["--bump"]).bump, true);
  for (const bad of [["--to", COLD, "--dryrun"], ["--to", COLD, "--dry-run=1"], ["--to", COLD, "--fee-rate", "0"], ["--to", COLD, "--fee-rate", "1.5"], [], ["--bump", "--to", COLD], ["--to", COLD, "extra"]]) {
    assert.throws(() => P("evacuate", bad), /usage: murkle relayer evacuate/, bad.join(" "));
  }
  assert.throws(() => P("refund-pool", []), /--from <cold key file> or --outpoint/);
  assert.throws(() => P("refund-pool", ["--outpoint", "a:0", "--amount", "5"]), /go with --from/);
  assert.equal(P("rotate", ["--accept-lost"]).acceptLost, true);
  assert.throws(() => P("rotate", ["--force"]), /unknown flag --force/);
  assert.throws(() => P("nuke", []), /unknown relayer command "nuke"/);
  assert.ok(FakeEsplora);
});

/* ------------------------------------------------------- review fixes: late deposits */

/** busyWorld after an evacuation, a rotation and the refill: the running relayer of generation 1. */
async function rotatedWorld() {
  const ctx = await busyWorld();
  const { w } = ctx;
  await evacuateRunning(w, { to: cold().address });
  await w.land();
  const oldQ = w.r.Q;
  const rot = await EV.rotate({ ...w.tool, print: quiet() });
  assert.equal((await EV.refundPool({ ...w.tool, outpoint: payTo(w, rot.address, rot.need), print: quiet() })).status, "funded");
  const r = await w.restart();
  await w.step(r);
  return { ...ctx, oldQ, rot, r };
}

/** A confirmed payment of `value` to deposit address n of `acct` under the retired key `oldQ`, recorded by `r` (409 deposit_retired). */
async function lateDeposit(w, r, oldQ, acct, value, n = r.books.account(acct.idHex).nextIndex) {
  const txid = w.esplora.pay([{ script: depositAddress(oldQ, acct.id, n, "signet").script, value }], { height: w.idx.height });
  const body = JSON.stringify({ outpoint: `${txid}:0`, accountPub: acct.pubHex, n });
  const res = await r.credit(body, anyIp());
  assert.deepEqual([res.status, code(res)], [409, "deposit_retired"], JSON.stringify(res.body));
  return { txid, key: `${txid}:0`, body };
}

const total = (r, x) => r.books.account(x.idHex).balance + r.books.account(x.idHex).reserved;

test("a late deposit whose sweep fee the margin cannot pay: the relayer never halts (the deposit waits), refund-pool pays the liability after the first refill (under its own HOLD), and an unconfirmed sweep counts in the refill", async () => {
  const { w, a, b, oldQ, rot, r: r1 } = await rotatedWorld();
  const hold = join(w.root, "relay-balance", RELAY_FILES.hold);
  const a0 = total(r1, a);
  const b0 = total(r1, b);
  const d1 = await lateDeposit(w, r1, oldQ, a, 40_000);
  r1.close();
  const s1 = await EV.sweepRetired({ ...w.tool, waitMs: 0, relayerStopped: true, feeRate: 250, highFee: true, print: quiet() });
  assert.equal(s1.status, "swept");
  assert.ok(s1.sweep.owed > 0, "the margin could not pay all of this fee");
  // Its output is an output of the relayer's own records: never a refill.
  await assert.rejects(EV.refundPool({ ...w.tool, outpoint: `${s1.sweep.versions[0].txid}:0`, relayerStopped: true, waitMs: 0, print: quiet() }), /output of the relayer's own records/);
  assert.equal(existsSync(hold), false, "the maintenance HOLD it placed is lifted again");
  // 1. Refilled while the sweep waits for a block: the shortfall counts the deposit it brings.
  const { r: v1 } = await EV.openRelayer({ ...w.tool, guard: false });
  const need1 = EV.poolShortfall(v1);
  assert.ok(need1 > 0);
  assert.equal(need1, v1.books.liabilities() + 40_000 - (40_000 - s1.sweep.versions[0].fee) - v1.poolUnspent());
  const f1 = await EV.refundPool({ ...w.tool, outpoint: payTo(w, rot.address, need1), relayerStopped: true, waitMs: 0, print: quiet() });
  assert.equal(f1.status, "funded");
  assert.equal(f1.owed, s1.sweep.owed, "the liability is paid");
  assert.equal(existsSync(hold), false);
  await w.land();
  const r2 = await w.restart();
  await w.tick(r2);
  assert.equal(total(r2, a), a0 + 40_000 - r2.sweepCost(), "credited once its sweep confirmed");
  assert.equal(r2.checkBooks().ok, true, "I2 holds");
  assert.equal(r2.info().code, null);
  assert.equal(r2.state.retiredDeposits[d1.key].status, "credited");

  // 2. The sweep confirms before the refill: the deposit waits, nobody else is refused anything.
  const d2 = await lateDeposit(w, r2, oldQ, b, 30_000);
  r2.close();
  const s2 = await EV.sweepRetired({ ...w.tool, waitMs: 0, relayerStopped: true, feeRate: 250, highFee: true, print: quiet() });
  assert.ok(s2.sweep.owed > 0);
  await w.land();
  const r3 = await w.restart();
  await w.tick(r3);
  assert.equal(total(r3, b), b0, "not credited while the pool cannot cover it");
  assert.equal(r3.checkBooks().ok, true, "and the relayer does not halt");
  assert.equal(r3.info().code, null);
  assert.equal(r3.state.retiredDeposits[d2.key].status, "swept");
  const still = await r3.credit(d2.body, anyIp());
  assert.deepEqual([code(still), still.body.error.status], ["deposit_retired", "swept"]);
  const send = await r3.submit(signedSubmit(a, r3.info(), synth(w.idx)), anyIp());
  assert.equal(send.status, 202, "other users' sends go on");
  r3.close();
  const { r: v2 } = await EV.openRelayer({ ...w.tool, guard: false });
  const need2 = EV.poolShortfall(v2);
  assert.ok(need2 > 0 && need2 <= s2.sweep.owed);
  const f2 = await EV.refundPool({ ...w.tool, outpoint: payTo(w, rot.address, need2), relayerStopped: true, waitMs: 0, print: quiet() });
  assert.equal(f2.status, "funded");
  assert.equal(f2.owed, s2.sweep.owed);
  const r4 = await w.restart();
  await w.tick(r4);
  assert.equal(total(r4, b), b0 + 30_000 - r4.sweepCost());
  assert.equal(r4.checkBooks().ok, true);
  assert.deepEqual(r4.books.operator.owed, 0);
  const again = await EV.refundPool({ ...w.tool, outpoint: payTo(w, rot.address, 1000), relayerStopped: true, waitMs: 0, print: quiet() });
  assert.equal(again.status, "nothing", "nothing is owed: no refill is recorded");
});

test("a second evacuation never forgets a late deposit swept but not credited yet: the rotation credits it and the refill covers it", async () => {
  const { w, a, oldQ, r: r1 } = await rotatedWorld();
  const a0 = total(r1, a);
  const d = await lateDeposit(w, r1, oldQ, a, 8000);
  r1.close();
  const swept = await EV.sweepRetired({ ...w.tool, waitMs: 0, relayerStopped: true, print: quiet() });
  assert.equal(swept.status, "swept");
  // The new keys are suspected too, before that sweep confirmed: a second evacuation and rotation.
  const r2 = await w.restart();
  const w2 = { ...w, r: r2 };
  const to = cold().address;
  const { out } = await evacuateRunning(w2, { to });
  const sweepOut = `${swept.sweep.versions[0].txid}:0`;
  assert.ok(out.sweeps.some((s) => s.inputs.includes(sweepOut)), "the swept deposit's coin is evacuated with the rest");
  await w.land();
  const print = quiet();
  const rot2 = await EV.rotate({ ...w.tool, print });
  assert.equal(rot2.generation, 2);
  assert.ok(print.lines.some((l) => /credited 1 deposit\(s\) to retired addresses/.test(l)));
  const { r: v } = await EV.openRelayer({ ...w.tool, guard: false });
  assert.equal(v.state.retiredDeposits[d.key].status, "credited");
  assert.equal(total(v, a), a0 + 8000 - v.sweepCost(), "credited in full (less the usual sweep cost)");
  assert.equal(rot2.need, v.books.liabilities(), "the refill covers it");
  await EV.refundPool({ ...w.tool, outpoint: payTo(w, rot2.address, rot2.need), print: quiet() });
  const r3 = await w.restart();
  await w.step(r3);
  assert.equal(r3.checkBooks().ok, true);
  assert.equal(total(r3, a), a0 + 8000 - r3.sweepCost());
  const done = await r3.credit(d.body, anyIp());
  assert.deepEqual([done.status, done.body.already], [200, true]);
  assert.deepEqual(r3.info().balance.retiredPoolKeys, [hex(oldQ), r2.poolHex]);
  // A retired generation's own addresses are never a cold address.
  const oldC = btc.p2tr(unhex(v.state.retired[0].change), undefined, btc.TEST_NETWORK).address;
  await assert.rejects(EV.runEvacuate({ ...w.tool, to: oldC, dryRun: true, print: quiet() }), /of these keys or of retired ones/);
});

/* ------------------------------------------------------- review fixes: carriers and sweeps */

const isCarrier = (raw) => txOf(raw).getOutput(0).script[0] === 0x6a;

/** The next carrier's broadcasts fail: every one with `error` (no clear answer), or only the first with `once`. */
function failCarrier(esplora, { error = new Error("socket hang up"), once = false } = {}) {
  let target = null;
  const base = esplora.broadcast.bind(esplora);
  esplora.broadcast = async (raw) => {
    const id = txOf(raw).id;
    if (target === null && isCarrier(raw)) target = id;
    if (id === target) {
      esplora.calls.push(raw);
      if (once) esplora.broadcast = base;
      throw error;
    }
    return base(raw);
  };
}

test("a carrier whose broadcast answer was lost stays charged and holds the rotation until its window closes; then its coin, still under the old key, is swept (nothing refunded)", async () => {
  const { w, a, queuedId } = await busyWorld();
  failCarrier(w.esplora);
  await w.step(); // the queued carrier goes out, and its broadcast never gets an answer
  const item = w.r.state.items[queuedId];
  assert.deepEqual([item.status, item.unknownOutcome], ["signing", true]);
  const a0 = total(w.r, a);
  const input = Object.entries(w.r.state.coins).find(([, c]) => c.spentBy === item.txid)?.[0];
  assert.ok(input, "the carrier's input");
  const to = cold().address;
  const first = await evacuateRunning(w, { to });
  assert.ok(first.lines.some((l) => /may be on the network .* stays journaled and charged/.test(l)));
  assert.ok(!first.out.sweeps.some((s) => s.inputs.includes(input)));
  await w.land();
  await assert.rejects(EV.rotate({ ...w.tool, print: quiet() }), /still journaled or queued.*window closes, at block \d+/);
  const end = item.anchor + 100;
  while (w.idx.height < end) await w.c.mine();
  const second = await EV.runEvacuate({ ...w.tool, to, waitMs: 0, print: quiet() });
  assert.equal(second.status, "evacuated");
  assert.ok(second.sweeps.some((s) => s.inputs.includes(input)), "its coin is swept now");
  assert.ok(second.notes.some((n) => /never reached the network before its window closed/.test(n)));
  await w.land();
  const rot = await EV.rotate({ ...w.tool, print: quiet() }); // no --accept-lost needed
  assert.equal(rot.status, "rotated");
  const g0 = JSON.parse(readFileSync(join(rot.retiredDir, "relayer.json"), "utf8"));
  assert.equal(g0.items[queuedId].status, "dropped");
  const { r: back } = await EV.openRelayer({ ...w.tool, guard: false });
  assert.equal(total(back, a), a0, "its charge was kept: nothing refunded for a carrier that may have landed");
  assert.equal(equationHolds(back.books), true);
});

test("a journaled carrier is sent again by the evacuation, never refunded while it can land (I-PAY); its change is swept", async () => {
  const { w, a, queuedId } = await busyWorld();
  failCarrier(w.esplora, { once: true, error: new Error('POST /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}') });
  await w.step();
  const item = w.r.state.items[queuedId];
  assert.equal(item.status, "signing");
  assert.equal(item.unknownOutcome, undefined, "a clear refusal: its answer was not lost");
  const a0 = total(w.r, a);
  const { out } = await evacuateRunning(w, { to: cold().address });
  assert.ok(out.notes.some((n) => /was sent again: it keeps its charge/.test(n)));
  assert.ok(w.esplora.mempool.has(item.txid) || w.esplora.mined.has(item.txid), "the carrier was sent");
  const change = Object.entries((await EV.openRelayer({ ...w.tool, guard: false })).r.state.coins).filter(([, c]) => c.parent === item.txid).map(([k]) => k);
  assert.ok(change.length && change.every((k) => out.sweeps.some((s) => s.inputs.includes(k))), "its change went to the cold address");
  const { r: back } = await EV.openRelayer({ ...w.tool, guard: false });
  assert.equal(back.state.items[queuedId].status, "broadcast");
  assert.equal(total(back, a), a0, "charged, as it reached the network");
});

test("a bump whose broadcast got no answer while the earlier version is mined: the next run settles on that version; nothing is lost and no fee is refunded twice", async () => {
  const { w } = await busyWorld();
  const to = cold().address;
  const { out } = await evacuateRunning(w, { to, feeRate: 3 });
  const v1 = out.sweeps.map((s) => s.versions.at(-1).txid);
  const fees0 = (await EV.openRelayer({ ...w.tool, guard: false })).r.books.totals.fees;
  const base = w.esplora.broadcast.bind(w.esplora);
  w.esplora.broadcast = async (raw) => {
    w.esplora.calls.push(raw);
    throw new Error("socket hang up");
  };
  const bumped = await EV.runEvacuate({ ...w.tool, bump: true, feeRate: 9, waitMs: 0, print: quiet() });
  assert.equal(bumped.status, "bumped");
  w.esplora.broadcast = base;
  // The first versions are still in the mempool: sending the bump again is refused (their inputs
  // are spent there), which is not a theft: they are kept, not dropped.
  const mid = await EV.runEvacuate({ ...w.tool, to, waitMs: 0, print: quiet() });
  const { r: m } = await EV.openRelayer({ ...w.tool, guard: false });
  assert.ok(m.state.evacuation.sweeps.every((s) => s.status === "pending"), "still pending");
  assert.equal(Object.values(m.state.coins).filter((c) => c.status === "lost").length, 0);
  assert.equal(mid.sweeps.length, 0, "nothing new to sweep");
  await w.land(); // the first versions are mined
  await EV.runEvacuate({ ...w.tool, to, waitMs: 0, print: quiet() });
  const { r: back } = await EV.openRelayer({ ...w.tool, guard: false });
  for (const [k, sweep] of back.state.evacuation.sweeps.entries()) {
    assert.deepEqual([sweep.status, sweep.txid], ["confirmed", v1[k]]);
  }
  assert.equal(Object.values(back.state.coins).filter((c) => c.status === "lost").length, 0, "no coin recorded as lost");
  assert.equal(back.books.totals.fees, fees0, "the fee of the version that was mined, once");
  assert.equal(equationHolds(back.books), true);
  assert.equal((await EV.rotate({ ...w.tool, print: quiet() })).status, "rotated");
});

/* ------------------------------------------------------- review fixes: HOLD discipline */

test("a stray --bump or --cancel never freezes a healthy relayer; --cancel undoes a false alarm before any coin moved and is refused once coins moved", async () => {
  const { w, a } = await busyWorld();
  const hold = join(w.root, "relay-balance", RELAY_FILES.hold);
  await assert.rejects(EV.runEvacuate({ ...w.tool, bump: true, waitMs: 0, print: quiet() }), /nothing to bump.*Nothing was changed/);
  await assert.rejects(EV.runEvacuate({ ...w.tool, cancel: true, waitMs: 0, print: quiet() }), /no evacuation to cancel; nothing was changed/);
  assert.equal(existsSync(hold), false, "no HOLD");
  await w.r.checkHold();
  assert.equal(w.r.frozen, false);
  assert.equal((await w.r.submit(signedSubmit(a, w.r.info(), synth(w.idx)), anyIp())).status, 202);
  // A false alarm that stopped before any coin moved (here the fee guard refused the rate).
  await assert.rejects(evacuateRunning(w, { to: cold().address, feeRate: 120 }), /refused: fees of/);
  assert.equal(w.r.info().code, "relayer_evacuating");
  const c = await EV.runEvacuate({ ...w.tool, cancel: true, waitMs: 0, print: quiet() });
  assert.equal(c.status, "cancelled");
  assert.equal(existsSync(hold), false);
  const r2 = await w.restart();
  assert.equal(r2.frozen, false);
  await w.step(r2);
  assert.equal(r2.info().code, null, "it resumes");
  assert.equal(r2.state.evacuation, undefined);
  assert.equal((await r2.submit(signedSubmit(a, r2.info(), synth(w.idx)), anyIp())).status, 202);
  // Once a sweep moved coins, there is no going back.
  await evacuateRunning({ ...w, r: r2 }, { to: cold().address });
  await assert.rejects(EV.runEvacuate({ ...w.tool, cancel: true, waitMs: 0, print: quiet() }), /cannot be cancelled/);
});

test("no acknowledgement, no evacuation (unless the operator says the relayer is stopped); once a HOLD is in place a running relayer never overwrites what a tool wrote", async () => {
  const { w } = await busyWorld();
  w.r.close(); // its HOLD poll: this test drives it by hand
  const rb = join(w.root, "relay-balance");
  const state = join(rb, "relayer.json");
  const hash = sha(state);
  const calls = w.esplora.calls.length;
  await assert.rejects(EV.runEvacuate({ ...w.tool, to: cold().address, waitMs: 0, print: quiet() }), /no running relayer acknowledged HOLD.*--relayer-stopped/);
  assert.equal(sha(state), hash, "nothing written");
  assert.equal(w.esplora.calls.length, calls, "nothing sent");
  assert.ok(existsSync(join(rb, RELAY_FILES.hold)), "the HOLD stays in place");
  // The operator wrongly says the relayer is stopped: the evacuation writes its journal...
  const out = await EV.runEvacuate({ ...w.tool, to: cold().address, waitMs: 0, relayerStopped: true, print: quiet() });
  assert.equal(out.status, "evacuated");
  const written = sha(state);
  // ...and the relayer's next save (the end of its tick) is refused, and so is its freeze's save.
  w.r.save();
  await w.r.checkHold();
  assert.equal(w.r.frozen, true);
  assert.equal(sha(state), written, "the tool's journal is not overwritten");
  assert.equal(JSON.parse(readFileSync(state, "utf8")).evacuation.sweeps.length, out.sweeps.length);
});

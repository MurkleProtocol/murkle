// The paid relayer with relay balances (docs/design/relay-balance.md, binding contract
// docs/design/relay-balance-contract.md §3, §4 and §8 "server"): startup and keys, the
// real process, credits, coins tracked by outpoint (a dust flood changes nothing), I-PAY
// (outputs, provenance, charges, the books), signed submits, the fee cap, missed batch items,
// privacy of the saved state and the logs, and deposit reorgs.
//
// Fakes only: FakeEsplora (never broadcasts anything real, refuses to list addresses),
// synthetic blocks, synthetic TRANSACT envelopes the test indexer checks by every rule except
// Groth16, temporary directories and port 0. Nothing touches data/signet/.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import {
  FakeEsplora, accountMod, booksMod, chain, fundAccount, fundingMod, hash32, makeFakeEsplora, makePaidRelayer, newAccount, ownCarrier,
  relayerMod, serverMod, signedAccount, signedSubmit, silent, synth, txOf,
} from "./fixtures/relay-harness.mjs";
import { hex, unhex } from "../src/bytes.mjs";
import { opReturnScript } from "../src/envelope.mjs";
import { parseRawTx } from "../src/btc/block.mjs";

const { DEFAULTS, ERROR_STATUS, MESSAGES, MISSED_REASON, RETIRED_ENV, Relayer, relayerStartup, startPaidRelayer } = relayerMod;
const { depositAddress, signRequest } = accountMod;
const { marginFor, costFor } = booksMod;
const { createApp } = serverMod;
const { relayInfoOff, v1Status, loadV1State, RETIRED_REASON } = await import("../server/retired-relay.mjs");

const DIR = mkdtempSync(join(tmpdir(), "murkle-relay-balance-"));
const relayers = [];
const apps = [];
const fakes = [];
after(async () => {
  relayers.forEach((r) => r.close());
  for (const a of apps) await new Promise((r) => a.server.close(r));
  rmSync(DIR, { recursive: true, force: true });
});
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const LIVE = ["data/signet/relayer.key", "data/signet/relayer.json"].filter((p) => existsSync(p));
const liveBefore = LIVE.map((p) => [p, sha(p), statSync(p).mtimeMs]);
// A checkout that runs a paid relayer already has data/signet/relay-balance; a fresh clone has
// no data/ at all. Either way these tests must not add or remove anything there (a live relayer
// may rewrite its own files meanwhile, so only the file list is compared).
const RB_DIR = "data/signet/relay-balance";
const rbFiles = () => (existsSync(RB_DIR) ? readdirSync(RB_DIR).filter((n) => !n.endsWith(".tmp")).sort() : null);
const rbBefore = rbFiles();
after(() => {
  for (const [p, h, m] of liveBefore) assert.deepEqual([sha(p), statSync(p).mtimeMs], [h, m], `${p} untouched`);
  assert.deepEqual(rbFiles(), rbBefore, "data/signet/relay-balance was neither created nor given new files");
});
const anyIp = () => `203.0.${randomBytes(1)[0]}.${1 + (randomBytes(1)[0] % 250)}`;
const PER = 598; // one carrier at 1 sat/vB: 1 P2TR input, the OP_RETURN, change to C
const QUOTE = costFor(PER); // 658

/** A chain, a fake esplora and a paid relayer after its first tick. */
async function world({ start = 864_000, config = {}, fee = 1, log = silent, now, fastDelayMs, dir } = {}) {
  const esplora = makeFakeEsplora({ fee });
  fakes.push(esplora);
  const c = chain({ start, fakes: [esplora] });
  await c.mine();
  const r = await makePaidRelayer({ idx: c.idx, esplora, config, log, now, fastDelayMs, ...(dir ? { dir } : {}) });
  relayers.push(r);
  const tick = (rr = r) => rr.onTick({ chainTip: c.idx.height });
  await tick();
  return {
    esplora, c, idx: c.idx, r, tick,
    /** One empty block, then a tick. */
    step: async (rr = r) => {
      await c.mine();
      await tick(rr);
    },
    /** A block with every mempool transaction, then a tick. */
    land: async (rr = r) => {
      await c.mineCarriers(esplora);
      await tick(rr);
    },
  };
}
const send = (w, account, envelope, mode = "block", ip = anyIp(), r = w.r) => r.submit(signedSubmit(account, r.info(), envelope, mode), ip);
const code = (out) => out.body?.error?.code;
async function funded(w, sats = 7000, n) {
  const a = newAccount();
  const f = await fundAccount({ relayer: w.r, esplora: w.esplora, account: a, sats, n });
  assert.equal(f.status, 200, JSON.stringify(f.body));
  return a;
}
async function serve(app) {
  apps.push(app);
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return {
    base,
    get: async (p) => {
      const res = await fetch(base + p);
      return { status: res.status, body: await res.json() };
    },
    post: async (p, body) => {
      const res = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body });
      return { status: res.status, body: await res.json() };
    },
  };
}
/** Sum of a broadcast transaction's input values, read from the parents the fake esplora knows. */
function inputSum(esplora, tx) {
  let s = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const inp = tx.getInput(i);
    s += Number(parseRawTx(esplora.txs.get(hex(inp.txid))).outputs[inp.index].value);
  }
  return s;
}
const outSum = (tx) => Array.from({ length: tx.outputsLength }, (_, v) => Number(tx.getOutput(v).amount)).reduce((a, b) => a + b, 0);

/* ---------------------------------------------------------------- 1. startup and keys */

test("1a relayerStartup: MURKLE_RELAYER=1 alone is refused, RELAY_MODE alone starts nothing, each invalid value is named, a valid one starts", () => {
  const run = (vars) => relayerStartup((n) => vars[n]);
  const alone = run({ RELAYER: "1" });
  assert.deepEqual([alone.start, alone.requested], [false, true]);
  assert.match(alone.message, /^refusing to start the relayer: MURKLE_RELAYER=1 needs MURKLE_RELAY_MODE=balance and a valid relay balance configuration \(docs\/design\/relay-balance\.md\)\. There is no free mode\./);
  assert.match(alone.message, /The indexer keeps running\.$/);
  for (const mode of ["free", "Balance", "tickets", "1"]) assert.equal(run({ RELAYER: "1", RELAY_MODE: mode }).start, false, mode);
  const modeOnly = run({ RELAY_MODE: "balance" });
  assert.deepEqual([modeOnly.start, modeOnly.requested], [false, false]);
  assert.equal(modeOnly.message, "Relayer off. Wallets pay the fee themselves or copy the envelope.");

  const ok = run({ RELAYER: "1", RELAY_MODE: "balance" });
  assert.deepEqual([ok.start, ok.requested, ok.problems], [true, true, []]);
  assert.equal(ok.message, "Relayer on: relay balances (docs/design/relay-balance.md). Users prepay; the operator never pays a user's fee.");
  assert.equal(ok.config.relayDir, "data/signet/relay-balance");
  assert.deepEqual([ok.config.keyPath, ok.config.statePath], ["data/signet/relayer.key", "data/signet/relayer.json"], "the v1 paths keep naming the old files");

  const bad = [
    ["RELAY_MARGIN_PCT", "101", /MURKLE_RELAY_MARGIN_PCT must be a whole number from 0 to 100/],
    ["RELAY_MARGIN_PCT", "2.5", /MURKLE_RELAY_MARGIN_PCT/],
    ["RELAY_MARGIN_MIN_SATS", "0", /MURKLE_RELAY_MARGIN_MIN_SATS must be a whole number of at least 1/],
    ["RELAY_MIN_DEPOSIT_SATS", "618", /MURKLE_RELAY_MIN_DEPOSIT_SATS must be a whole number above 618/],
    ["RELAY_DEPOSIT_CONFS", "0", /MURKLE_RELAY_DEPOSIT_CONFS must be a whole number of at least 1 on signet/],
    ["RELAY_BATCH_HEADROOM", "11", /MURKLE_RELAY_BATCH_HEADROOM must be a whole number from 1 to 10/],
    ["RELAY_BATCH_HEADROOM", "0", /MURKLE_RELAY_BATCH_HEADROOM/],
    ["RELAY_SUGGEST_SENDS", "101", /MURKLE_RELAY_SUGGEST_SENDS must be a whole number from 1 to 100/],
    ["RELAY_INVALID_PROOF_SATS", "-1", /MURKLE_RELAY_INVALID_PROOF_SATS must be a non-negative number/],
    ["RELAY_INVALID_PER_HOUR", "0", /MURKLE_RELAY_INVALID_PER_HOUR must be a whole number of at least 1/],
    ["RELAY_ACCOUNT_PER_HOUR", "0", /MURKLE_RELAY_ACCOUNT_PER_HOUR must be a whole number of at least 1/],
    ["MAX_QUEUE", "lots", /MURKLE_MAX_QUEUE must be a non-negative number/],
    ["MAX_FEE_RATE", "0", /MURKLE_MAX_FEE_RATE must be above 0/],
    ["SAFETY_BLOCKS", "95", /MURKLE_SAFETY_BLOCKS must be a whole number from 1 to 94/],
    ["BATCH10_SAFETY_BLOCKS", "41", /MURKLE_BATCH10_SAFETY_BLOCKS must be a whole number from 1 to 40/],
  ];
  for (const [name, value, re] of bad) {
    const out = run({ RELAYER: "1", RELAY_MODE: "balance", [name]: value });
    assert.equal(out.start, false, name);
    assert.match(out.message, re, name);
    assert.ok(out.message.startsWith("refusing to start the relayer: MURKLE_RELAYER=1 needs MURKLE_RELAY_MODE=balance"), name);
    assert.ok(out.message.endsWith(". The indexer keeps running."), name);
  }
  assert.equal(run({ RELAYER: "1", RELAY_MODE: "balance", RELAY_MIN_DEPOSIT_SATS: "619" }).start, true, "just above the sweep cost plus dust");
  assert.equal(run({ RELAYER: "1", RELAY_MODE: "balance", RELAY_DEPOSIT_CONFS: "3" }).config.depositConfirmations, 3, "more confirmations are allowed");
  // The free relayer's settings change nothing and start nothing.
  const retired = Object.fromEntries(RETIRED_ENV.map((n) => [n, "1"]));
  assert.equal(run(retired).start, false);
  assert.deepEqual(RETIRED_ENV.includes("HOT_FLOOR_SATS"), true);
  for (const k of ["dailyBudgetSats", "powBaseBits", "powMaxExtra", "powBudgetExtra", "acceptPerHour", "acceptPerDay", "rejectPerHour", "hotFloorSats"]) {
    assert.equal(k in DEFAULTS, false, `${k} is gone`);
  }
});

test("1b startPaidRelayer: new keys in a new directory; the retired key (or its negation), equal keys and old paths are refused; v1 files stay byte-identical", async () => {
  const root = mkdtempSync(join(DIR, "keys-"));
  const old = new Uint8Array(randomBytes(32));
  writeFileSync(join(root, "relayer.key"), hex(old));
  writeFileSync(join(root, "relayer.json"), JSON.stringify({ version: 1, items: {}, ledger: [] }));
  const before = [sha(join(root, "relayer.key")), sha(join(root, "relayer.json"))];
  const esplora = makeFakeEsplora();
  const c = chain({ fakes: [esplora] });
  await c.mine();
  const cfg = (relayDir) => ({ ...DEFAULTS, enabled: true, relayMode: "balance", relayDir, keyPath: "relayer.key", statePath: "relayer.json", fanoutTarget: 0 });
  const start = (relayDir, extra = {}) => startPaidRelayer({ idx: c.idx, esplora, config: { ...cfg(relayDir), ...extra }, root, log: silent });

  const r = await start("rb");
  relayers.push(r);
  const pool = readFileSync(join(root, "rb", "pool.key"), "utf8");
  const change = readFileSync(join(root, "rb", "change.key"), "utf8");
  assert.match(pool, /^[0-9a-f]{64}$/);
  assert.match(change, /^[0-9a-f]{64}$/);
  assert.notEqual(pool, change);
  assert.notEqual(pool, hex(old));
  assert.equal(r.info().balance.poolKey, hex(schnorr.getPublicKey(unhex(pool))));
  assert.equal(r.address, btc.p2tr(schnorr.getPublicKey(unhex(change)), undefined, btc.TEST_NETWORK).address, "the published address is C");
  const saved = JSON.parse(readFileSync(join(root, "rb", "relayer.json"), "utf8"));
  assert.deepEqual([saved.version, saved.keys.pool, saved.network], [2, r.info().balance.poolKey, "signet"]);
  // Restart with the same directory: the same keys.
  const again = await start("rb");
  relayers.push(again);
  assert.equal(again.info().balance.poolKey, r.info().balance.poolKey);

  const refuse = async (relayDir, re, extra) => assert.rejects(start(relayDir, extra), re, relayDir);
  // The retired key copied in as the pool key or as the change key.
  for (const name of ["pool.key", "change.key"]) {
    mkdirSync(join(root, `copy-${name}`), { recursive: true });
    copyFileSync(join(root, "relayer.key"), join(root, `copy-${name}`, name));
    await refuse(`copy-${name}`, /equals the retired relayer key; it is never pool money again/);
  }
  // Its negation N - q has the same x-only key: refused too.
  const N = secp256k1.CURVE.n;
  const neg = (N - BigInt("0x" + hex(old))).toString(16).padStart(64, "0");
  mkdirSync(join(root, "neg"), { recursive: true });
  writeFileSync(join(root, "neg", "pool.key"), neg);
  await refuse("neg", /equals the retired relayer key/);
  // Pool key equal to change key.
  mkdirSync(join(root, "same"), { recursive: true });
  const k = hex(randomBytes(32));
  writeFileSync(join(root, "same", "pool.key"), k);
  writeFileSync(join(root, "same", "change.key"), k);
  await refuse("same", /the pool key and the change key are the same key/);
  // A directory that is the old key's directory, or a state path that is the old state file.
  await refuse(".", /relayer\.json is a file of the retired free relayer|holds the retired free relayer's files/);
  await refuse("rb", /is a file of the retired free relayer/, { statePath: "rb/relayer.json" });
  // A version-1 state at the new path; a version-2 state written for other keys.
  mkdirSync(join(root, "v1"), { recursive: true });
  writeFileSync(join(root, "v1", "relayer.json"), JSON.stringify({ version: 1, items: {}, ledger: [] }));
  await refuse("v1", /is a version 1 relayer state; the paid relayer reads only version 2/);
  mkdirSync(join(root, "swapped"), { recursive: true });
  copyFileSync(join(root, "rb", "relayer.json"), join(root, "swapped", "relayer.json"));
  await refuse("swapped", /was written for other keys than the key files next to it/);
  // A malformed key file.
  mkdirSync(join(root, "badkey"), { recursive: true });
  writeFileSync(join(root, "badkey", "pool.key"), "XYZ");
  await refuse("badkey", /must hold 64 lowercase hex chars/);

  assert.deepEqual([sha(join(root, "relayer.key")), sha(join(root, "relayer.json"))], before, "the v1 key and state are byte-identical");

  // The constructor itself never reads keyPath and needs both new keys.
  assert.throws(() => new Relayer({ idx: c.idx, esplora, config: { keyPath: join(root, "never.key") }, log: silent }), /needs its own pool key and change key/);
  assert.throws(() => new Relayer({ idx: c.idx, esplora, poolKey: unhex(pool), log: silent }), /needs its own pool key and change key/);
  assert.equal(existsSync(join(root, "never.key")), false);
  const kk = new Uint8Array(randomBytes(32));
  assert.throws(() => new Relayer({ idx: c.idx, esplora, poolKey: kk, changeKey: kk, log: silent }), /same key/);
  // A Relayer built with no statePath keeps its state in memory: it never defaults to the v1 file.
  const mem = new Relayer({ idx: c.idx, esplora, poolKey: new Uint8Array(randomBytes(32)), changeKey: new Uint8Array(randomBytes(32)), log: silent });
  assert.equal(mem.config.statePath, null);

  const src = readFileSync("server/indexer-server.mjs", "utf8");
  assert.doesNotMatch(src, /new Relayer\b/);
  const imports = src.match(/import \{([^}]*)\} from "\.\/relayer\.mjs"/)?.[1] ?? "";
  assert.doesNotMatch(imports, /(^|[\s,])Relayer([\s,]|$)/);
  assert.match(imports, /\bstartPaidRelayer\b/);
});

/* ---------------------------------------------------------------- 2. as a real process */

async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

async function runServer(extraEnv, check) {
  const dir = mkdtempSync(join(DIR, "proc-"));
  const old = new Uint8Array(randomBytes(32));
  writeFileSync(join(dir, "relayer.key"), hex(old));
  const v1 = { version: 1, items: { ["ab".repeat(16)]: { id: "ab".repeat(16), status: "queued", anchor: 500, nullifiers: [] } }, ledger: [] };
  writeFileSync(join(dir, "relayer.json"), JSON.stringify(v1));
  const hashes = [sha(join(dir, "relayer.key")), sha(join(dir, "relayer.json"))];
  const port = await freePort();
  const child = spawn(process.execPath, ["server/indexer-server.mjs"], {
    env: {
      ...process.env, MURKLE_INDEXER_PORT: String(port), MURKLE_STATE_PATH: join(dir, "state.json"),
      MURKLE_RELAY_STATE_PATH: join(dir, "relayer.json"), MURKLE_RELAY_KEY_PATH: join(dir, "relayer.key"),
      MURKLE_RELAY_DIR: join(dir, "relay-balance"), MURKLE_ESPLORA: "http://127.0.0.1:9/api", ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (err += d));
  try {
    const base = `http://127.0.0.1:${port}`;
    let info = null;
    for (let i = 0; i < 300 && !info; i++) {
      try {
        info = await (await fetch(`${base}/api/relay/info`)).json();
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(info, `the indexer answers (stdout: ${out}, stderr: ${err})`);
    await check({ base, info, dir, out: () => out, err: () => err });
    assert.deepEqual([sha(join(dir, "relayer.key")), sha(join(dir, "relayer.json"))], hashes, "the v1 key and state are read, never written");
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
}

test("2 as a real process: MURKLE_RELAYER=1 + MURKLE_RELAY_MODE=balance serves mode balance from new keys; without RELAY_MODE the stage-0 shape", { timeout: 90_000 }, async () => {
  await runServer({ MURKLE_RELAYER: "1", MURKLE_RELAY_MODE: "balance" }, async ({ base, info, dir, out }) => {
    assert.equal(info.mode, "balance");
    assert.equal(info.enabled, true);
    const pool = readFileSync(join(dir, "relay-balance", "pool.key"), "utf8");
    assert.equal(info.balance.poolKey, hex(schnorr.getPublicKey(unhex(pool))));
    assert.equal(info.pow, null);
    assert.equal(info.selfPay, true);
    assert.match(out(), /Relayer on: relay balances/);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.relay.mode, "balance");
    const st = await (await fetch(`${base}/api/relay/status/${"ab".repeat(16)}`)).json();
    assert.deepEqual([st.status, st.reason], ["dropped", RETIRED_REASON], "old v1 ids still answer");
    const res = await fetch(`${base}/api/relay/account`, { method: "POST", body: "{}" });
    assert.notEqual(res.status, 503, "the account endpoint is served by the paid relayer");
  });
  await runServer({ MURKLE_RELAYER: "1" }, async ({ base, info, dir, err }) => {
    assert.deepEqual(info, relayInfoOff());
    assert.match(err(), /refusing to start the relayer: MURKLE_RELAYER=1 needs MURKLE_RELAY_MODE=balance/);
    assert.equal(existsSync(join(dir, "relay-balance")), false, "no key was created");
    const res = await fetch(`${base}/api/relay/credit`, { method: "POST", body: "{}" });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, "disabled");
  });
});

/* ---------------------------------------------------------------- 3. credit */

test("3 credit: 20 parallel HTTP credits of one outpoint credit once; spelling variants, restart, another account, unconfirmed, mismatch, small, own change, unknown", async () => {
  const dir = mkdtempSync(join(DIR, "credit-"));
  const w = await world({ dir });
  const slow = w.esplora.rawTx.bind(w.esplora);
  w.esplora.rawTx = async (t) => {
    await new Promise((r) => setTimeout(r, 15));
    return slow(t);
  };
  const app = createApp({ idx: w.idx, relayer: w.r, log: silent });
  const http = await serve(app);
  const alice = newAccount();
  const dep0 = depositAddress(w.r.Q, alice.id, 0);
  const txid = w.esplora.pay([{ script: dep0.script, value: 7000 }], { height: w.idx.height });
  const body = (outpoint, n = 0, accountPub = alice.pubHex) => JSON.stringify({ outpoint, accountPub, n });

  const outs = await Promise.all(Array.from({ length: 20 }, () => http.post("/api/relay/credit", body(`${txid}:0`))));
  const fresh = outs.filter((o) => o.status === 200 && o.body.already === false);
  assert.equal(fresh.length, 1, JSON.stringify(outs.map((o) => [o.status, o.body.already ?? o.body.error?.code])));
  for (const o of outs) {
    assert.ok((o.status === 200 && o.body.credited === true) || (o.status === 409 && o.body.error.code === "credit_in_progress"), JSON.stringify(o.body));
    if (o.status === 409) assert.equal(o.body.error.retryAfter, 5);
  }
  assert.deepEqual(fresh[0].body, { credited: true, already: false, outpoint: `${txid}:0`, n: 0, value: 7000, sweepCost: 288, amount: 6712, height: w.idx.height });
  assert.equal("balance" in fresh[0].body, false, "the credit answer never holds a balance");
  assert.deepEqual(w.r.books.account(alice.idHex), { balance: 6712, reserved: 0, nextIndex: 1 });
  assert.equal(w.r.checkBooks().ok, true);

  // Spelling variants of the same output.
  for (const v of [`${txid.toUpperCase()}:0`, `${txid}:00`, `${txid}: 0`, `${txid}:0 `, `${txid}:+0`, `${txid}:-0`, `${txid}:0e0`, txid, `${txid}:0:0`, `${txid.slice(1)}:0`, `${txid}0:0`, `${txid}:4294967296`]) {
    const o = await http.post("/api/relay/credit", body(v));
    assert.deepEqual([o.status, o.body.error?.code], [400, "bad_outpoint"], v);
  }
  for (const bad of [
    JSON.stringify({ outpoint: `${txid}:0`, accountPub: alice.pubHex, n: 0, extra: 1 }),
    JSON.stringify({ outpoint: `${txid}:0`, accountPub: alice.pubHex }),
    body(`${txid}:0`, 1.5), body(`${txid}:0`, -1), body(`${txid}:0`, "0"), body(`${txid}:0`, 2 ** 31),
    body(`${txid}:0`, 0, alice.pubHex.toUpperCase()), "not json", "[]",
  ]) {
    const o = await http.post("/api/relay/credit", bad);
    assert.deepEqual([o.status, o.body.error?.code], [400, "malformed"], bad);
  }
  assert.equal(w.r.books.account(alice.idHex).balance, 6712, "still credited once");

  // Restart: the credit is remembered, and a repeat answers it again.
  w.r.close();
  const r2 = await makePaidRelayer({ idx: w.idx, esplora: w.esplora, dir });
  relayers.push(r2);
  const repeat = await r2.credit(body(`${txid}:0`), anyIp());
  assert.deepEqual([repeat.status, repeat.body.already, repeat.body.amount], [200, true, 6712]);
  assert.deepEqual(r2.books.account(alice.idHex), { balance: 6712, reserved: 0, nextIndex: 1 });
  // Another account, or another address number: refused.
  const bob = newAccount();
  assert.equal(code(await r2.credit(body(`${txid}:0`, 0, bob.pubHex), anyIp())), "already_credited");
  assert.equal(code(await r2.credit(body(`${txid}:0`, 1), anyIp())), "already_credited");
  await r2.onTick({ chainTip: w.idx.height });

  // Unconfirmed: 409 with the counts; then confirmed, credited.
  const dep1 = depositAddress(r2.Q, alice.id, 1);
  const pending = w.esplora.pay([{ script: dep1.script, value: 5000 }]);
  const unconf = await r2.credit(body(`${pending}:0`, 1), anyIp());
  assert.deepEqual([unconf.status, unconf.body.error.code, unconf.body.error.confirmations, unconf.body.error.needed], [409, "deposit_unconfirmed", 0, 1]);
  // Paid to deposit address 1 but claimed as number 2, or as another account's: mismatch.
  assert.deepEqual([(await r2.credit(body(`${pending}:0`, 2), anyIp())).status, code(await r2.credit(body(`${pending}:0`, 2), anyIp()))], [422, "deposit_mismatch"]);
  assert.equal(code(await r2.credit(body(`${pending}:0`, 1, bob.pubHex), anyIp())), "deposit_mismatch");
  w.esplora.confirm([pending], w.idx.height);
  assert.equal((await r2.credit(body(`${pending}:0`, 1), anyIp())).body.amount, 4712);

  // Below the minimum: never credited, the same answer again.
  const small = w.esplora.pay([{ script: depositAddress(r2.Q, alice.id, 2).script, value: 1999 }], { height: w.idx.height });
  for (let i = 0; i < 2; i++) {
    const o = await r2.credit(body(`${small}:0`, 2), anyIp());
    assert.deepEqual([o.status, o.body.error.code, o.body.error.minDepositSats], [422, "deposit_small", 2000]);
  }
  assert.equal(r2.books.isCredited(`${small}:0`), null);
  // Unknown to the explorer; vout out of range.
  assert.deepEqual([(await r2.credit(body(`${hash32()}:0`), anyIp())).status], [404]);
  assert.equal(code(await r2.credit(body(`${txid}:7`), anyIp())), "deposit_unknown");
  // An explorer that gives no answer: busy, and the key is not left claimed.
  const real = w.esplora.rawTx;
  w.esplora.rawTx = async () => {
    throw new Error("GET /tx: 502 Bad Gateway");
  };
  const third = w.esplora.pay([{ script: depositAddress(r2.Q, alice.id, 2).script, value: 3000 }], { height: w.idx.height });
  assert.equal(code(await r2.credit(body(`${third}:0`, 2), anyIp())), "busy");
  w.esplora.rawTx = real;
  assert.equal((await r2.credit(body(`${third}:0`, 2), anyIp())).status, 200, "the claim was released");

  // The relayer's own carrier change is never credited, even if it paid a deposit script (it cannot).
  const env = synth(w.idx);
  assert.equal((await send(w, alice, env, "block", anyIp(), r2)).status, 202);
  await w.step(r2);
  const carrier = r2.items.find((i) => i.status === "broadcast");
  assert.ok(carrier);
  const own = await r2.credit(body(`${carrier.txid}:1`, 0), anyIp());
  assert.deepEqual([own.status, own.body.error.code], [422, "deposit_own"]);
  assert.equal(r2.checkBooks().ok, true);
});

test("3b a deposit needs the configured confirmations (3 here), and 100 for a coinbase; credit and account calls are rate limited per IP prefix", async () => {
  const w = await world({ config: { depositConfirmations: 3, accountPerHour: 2 } });
  const a = newAccount();
  await w.c.mine();
  const t = w.esplora.pay([{ script: depositAddress(w.r.Q, a.id, 0).script, value: 5000 }], { height: w.idx.height });
  const body = JSON.stringify({ outpoint: `${t}:0`, accountPub: a.pubHex, n: 0 });
  const o = await w.r.credit(body, "192.0.2.1");
  assert.deepEqual([o.body.error.code, o.body.error.confirmations, o.body.error.needed], ["deposit_unconfirmed", 1, 3]);
  await w.c.mine();
  await w.c.mine();
  await w.tick();
  assert.equal((await w.r.credit(body, "192.0.2.2")).status, 200);
  assert.equal(w.r.info().balance.depositConfirmations, 3);
  // The same /24 a third time: 429.
  const limited = await w.r.credit(body, "192.0.2.3");
  assert.deepEqual([limited.status, code(limited)], [429, "rate_limited"]);
  assert.ok(limited.body.error.retryAfter > 0);
  assert.equal(code(await w.r.account(signedAccount(a, w.r.info()), "192.0.2.4")), "rate_limited");
  assert.equal((await w.r.account(signedAccount(a, w.r.info()), "198.51.100.4")).status, 200, "another /24 is not limited");

  // A coinbase output to a deposit address: 100 confirmations.
  const cb = newAccount();
  const script = depositAddress(w.r.Q, cb.id, 0).script;
  const parts = ["02000000", "01", "00".repeat(32), "ffffffff", "00", "ffffffff", "01", Buffer.from(new BigUint64Array([5000n]).buffer).toString("hex"), script.length.toString(16).padStart(2, "0"), hex(script), "00000000"];
  const raw = parts.join("");
  const { txid } = parseRawTx(raw);
  w.esplora.txs.set(txid, raw);
  w.esplora.mined.set(txid, w.idx.height - 10);
  const out = await w.r.credit(JSON.stringify({ outpoint: `${txid}:0`, accountPub: cb.pubHex, n: 0 }), "198.51.100.9");
  assert.deepEqual([out.body.error.code, out.body.error.needed], ["deposit_unconfirmed", 100]);
});

/* ---------------------------------------------------------------- account read and info */

test("account read: signed, zeros for a new account (not 404), the deposit address for nextIndex, newest credits first; info shape", async () => {
  const w = await world();
  const info = w.r.info();
  assert.deepEqual(
    { ...info.balance, poolKey: undefined, changeAddress: undefined },
    {
      poolKey: undefined, changeAddress: undefined, signTag: "murkle/relay/v1", marginPct: 10, marginMinSats: 50, perSendSats: QUOTE,
      batchHeadroom: 2, minDepositSats: 2000, depositConfirmations: 1, sweepCostSats: 288, suggestSends: 10, suggestedTopUpSats: 7000,
      // L1: the harness turns the pool-cover rule off (minMix 0), so no coin is promised cover:
      // coverOk is false (test/privfix-relayer.test.mjs covers the rule).
      mix: { k: 0, coverOk: false, depositors: 0 },
      // Emergencies (relay-balance.md §9): top-ups open, the first key generation, nothing retired.
      depositsOpen: true, generation: 0, retiredPoolKeys: [],
    },
  );
  assert.equal(info.balance.changeAddress, w.r.address);
  assert.deepEqual([info.enabled, info.mode, info.code, info.reason, info.pow, info.selfPay, info.docs], [true, "balance", null, null, null, true, "docs/design/relay-balance.md"]);
  assert.deepEqual(info.fees, { feeRate: 1, maxFeeRate: 5, estVsize: 597, carrierFeeSats: PER, maxFeePerTx: 3000 });
  assert.deepEqual(Object.keys(info.stats), ["relayed144", "landed144", "accepted", "rejected", "expired", "missed", "satsSpent"]);
  assert.equal("budget" in info, false);
  assert.equal("tickets" in info, false);

  const a = newAccount();
  const zero = await w.r.account(signedAccount(a, info), anyIp());
  assert.equal(zero.status, 200);
  assert.deepEqual(zero.body, { accountId: a.idHex, balance: 0, reserved: 0, nextIndex: 0, depositAddress: depositAddress(w.r.Q, a.id, 0).address, credits: [] });
  await fundAccount({ relayer: w.r, esplora: w.esplora, account: a, sats: 7000 });
  await w.c.mine();
  await w.tick();
  const f2 = await fundAccount({ relayer: w.r, esplora: w.esplora, account: a, sats: 3000 });
  const read = await w.r.account(signedAccount(a, w.r.info()), anyIp());
  assert.deepEqual([read.body.balance, read.body.reserved, read.body.nextIndex], [6712 + 2712, 0, 2]);
  assert.equal(read.body.depositAddress, depositAddress(w.r.Q, a.id, 2).address);
  assert.deepEqual(read.body.credits.map((x) => [x.outpoint, x.n, x.value, x.amount]), [[f2.outpoint, 1, 3000, 2712], [read.body.credits[1].outpoint, 0, 7000, 6712]]);
  // Bad requests.
  const signed = JSON.parse(signedAccount(a, w.r.info()));
  assert.equal(code(await w.r.account(JSON.stringify({ ...signed, sig: "00".repeat(64) }), anyIp())), "bad_signature");
  assert.equal(code(await w.r.account(JSON.stringify({ ...signed, extra: 1 }), anyIp())), "malformed");
  assert.equal(code(await w.r.account(signedAccount(a, w.r.info(), { now: () => Date.now() - 601_000 }), anyIp())), "stale_request");
  const asSubmit = signRequest({ account: a, endpoint: "/api/relay/submit", network: "signet", poolKey: info.balance.poolKey });
  assert.equal(code(await w.r.account(JSON.stringify(asSubmit), anyIp())), "bad_signature", "a signature for another endpoint");
  const otherNet = signRequest({ account: a, endpoint: "/api/relay/account", network: "testnet", poolKey: info.balance.poolKey });
  assert.equal(code(await w.r.account(JSON.stringify(otherNet), anyIp())), "bad_signature", "a signature for another network");
  const otherQ = signRequest({ account: a, endpoint: "/api/relay/account", network: "signet", poolKey: hex(schnorr.getPublicKey(randomBytes(32))) });
  assert.equal(code(await w.r.account(JSON.stringify(otherQ), anyIp())), "bad_signature", "a signature for another relayer");
  // Without a relayer the endpoints answer 503 disabled; GET is 405.
  const none = await serve(createApp({ idx: w.idx, log: silent }));
  for (const p of ["/api/relay/account", "/api/relay/credit", "/api/relay/submit"]) {
    const o = await none.post(p, "{}");
    assert.deepEqual([o.status, o.body.error.code], [503, "disabled"], p);
    assert.equal(o.body.error.message, MESSAGES.disabled);
    assert.equal((await fetch(none.base + p)).status, 405, p);
  }
  assert.deepEqual((await none.get("/api/relay/info")).body, relayInfoOff());
  assert.deepEqual((await none.get("/api/state")).body.relay, { enabled: false, mode: null, queued: 0, defaultMode: "block", batch: null });
  const live = await serve(createApp({ idx: w.idx, relayer: w.r, log: silent }));
  assert.deepEqual((await live.get("/api/state")).body.relay, { enabled: true, mode: "balance", queued: 0, defaultMode: "block", batch: w.r.batchSummary() });
  const opts = await fetch(live.base + "/api/relay/credit", { method: "OPTIONS" });
  assert.equal(opts.headers.get("access-control-allow-methods"), "GET, POST");
});

/* ---------------------------------------------------------------- 4. dust flood */

test("4 a dust flood of 600 outputs at Q's plain address, C and every deposit address changes nothing; no address is ever listed", async () => {
  const w = await world();
  const accounts = [await funded(w), await funded(w), await funded(w, 9000)];
  await w.step();
  const coinsBefore = JSON.stringify(w.r.state.coins);
  const capBefore = w.r.capacity();
  const poolBefore = w.r.poolUnspent();
  const booksBefore = JSON.stringify(w.r.books.toJSON());
  const targets = [
    btc.p2tr(w.r.Q, undefined, btc.TEST_NETWORK).script, // Q itself
    w.r.change.script, // C
    ...accounts.flatMap((a) => [0, 1, 2].map((n) => depositAddress(w.r.Q, a.id, n).script)),
  ];
  const outputs = Array.from({ length: 600 }, (_, i) => ({ script: targets[i % targets.length], value: 546 }));
  w.esplora.pay(outputs.slice(0, 300), { height: w.idx.height });
  w.esplora.pay(outputs.slice(300)); // half of it unconfirmed
  await w.step();
  await w.step();
  assert.equal(JSON.stringify(w.r.state.coins), coinsBefore);
  assert.equal(w.r.capacity(), capBefore);
  assert.equal(w.r.poolUnspent(), poolBefore);
  assert.equal(JSON.stringify(w.r.books.toJSON()), booksBefore);
  // Sends still go out from credited coins only.
  for (const a of accounts) assert.equal((await send(w, a, synth(w.idx))).status, 202);
  await w.step();
  assert.equal(w.r.items.filter((i) => i.status === "broadcast").length, 3);
  for (const tx of w.esplora.carriers()) {
    for (let i = 0; i < tx.inputsLength; i++) assert.ok(w.r.state.coins[`${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`], "every input is a recorded coin");
  }
  assert.equal(w.esplora.utxoCalls, 0, "esplora.utxos was never called");
  assert.equal(w.r.checkBooks().ok, true);
});

/* ---------------------------------------------------------------- 5. outputs (I1) */

test("5 every transaction the relayer signs pays only the OP_RETURN and C: never Q's script, never a deposit script; fan-outs are paid from the margin", async () => {
  const w = await world({ config: { fanoutTarget: 24, fanoutMinConfirmed: 2, fanoutMinCarriers: 30 } });
  const accounts = [];
  for (let i = 0; i < 5; i++) accounts.push(await funded(w, 2500));
  const big = await funded(w, 400_000);
  const marginBefore = w.r.books.toJSON().margin;
  assert.equal(marginBefore, 6 * 288, "sweep costs only so far");
  await w.step(); // the deposits go to C in one merge, paid from the margin: no deposit is ever split or carried
  const merge = w.r.state.ledger.find((l) => l.kind === "merge");
  assert.ok(merge, "a merge was made");
  assert.equal(txOf(merge.raw ?? w.esplora.txs.get(merge.txid)).inputsLength, 6);
  assert.equal(w.r.books.toJSON().margin, marginBefore - merge.fee, "its fee came out of the margin account");
  await w.land(); // the merge confirms; the fan-out splits the merged coin, paid from the margin
  const fan = w.r.state.ledger.find((l) => l.kind === "fanout");
  assert.ok(fan, "a fan-out was made");
  assert.equal(txOf(w.esplora.txs.get(fan.txid)).getInput(0).index, 0);
  assert.equal(hex(txOf(w.esplora.txs.get(fan.txid)).getInput(0).txid), merge.txid, "it splits the merged coin");
  assert.equal(w.r.books.toJSON().margin, marginBefore - merge.fee - fan.fee, "its fee came out of the margin account");
  assert.equal(w.r.books.account(big.idHex).balance, 400_000 - 288, "and from no user's balance");
  await w.land();
  for (const a of [...accounts, big]) assert.equal((await send(w, a, synth(w.idx))).status, 202);
  await w.step();
  await w.land();
  for (let i = 0; i < 3; i++) assert.equal((await send(w, big, synth(w.idx))).status, 202);
  await w.step();

  const credits = Object.entries(w.r.books.toJSON().credits);
  const depositScripts = credits.map(([, c]) => hex(depositAddress(w.r.Q, unhex(c.id), c.n).script));
  const qScript = hex(btc.p2tr(w.r.Q, undefined, btc.TEST_NETWORK).script);
  assert.ok(w.esplora.accepted.length >= 10);
  for (const raw of w.esplora.accepted) {
    const tx = txOf(raw);
    const isCarrier = tx.getOutput(0).script[0] === 0x6a;
    for (let v = 0; v < tx.outputsLength; v++) {
      const s = hex(tx.getOutput(v).script);
      if (isCarrier && v === 0) continue;
      assert.equal(s, hex(w.r.change.script), "every non-OP_RETURN output pays C");
      assert.notEqual(s, qScript);
      assert.ok(!depositScripts.includes(s));
    }
    if (!isCarrier) assert.ok(Array.from({ length: tx.outputsLength }, (_, v) => tx.getOutput(v).script[0] !== 0x6a).every(Boolean), "a merge or fan-out has no OP_RETURN");
    if (isCarrier) for (let i = 0; i < tx.inputsLength; i++) {
      assert.equal(w.r.books.isCredited(`${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`), null, "no carrier input is a deposit outpoint");
    }
  }
  assert.equal(w.r.checkBooks().ok, true);

  // A carrier that would spend a deposit is refused before anything is signed or charged.
  await funded(w, 5000);
  const dep = w.r.spendableCoins().find((c) => c.kind === "deposit");
  const env = synth(w.idx);
  const plan = fundingMod.planCarrierTx({ account: w.r.change, utxos: [w.r.utxoOf(dep)], envelope: env, feeRate: 1, changeScript: w.r.change.script, order: "given" });
  const fees0 = w.r.books.toJSON().totals.fees;
  assert.throws(() => w.r.signPoolTx({ tx: plan.tx, inputs: [dep], ref: "ab".repeat(16), kind: "carrier", envelope: env }), /I0: a carrier spends only change of C, never a deposit/);
  assert.equal(w.r.books.toJSON().totals.fees, fees0);

  // signPoolTx refuses anything else, before signing or charging.
  const coin = w.r.spendableCoins().find((c) => c.confirmed);
  const utxo = w.r.utxoOf(coin);
  const evil = new btc.Transaction();
  evil.addInput({ txid: utxo.txid, index: utxo.vout, witnessUtxo: { script: utxo.script, amount: BigInt(utxo.value) }, tapInternalKey: utxo.tapInternalKey });
  evil.addOutput({ script: depositAddress(w.r.Q, big.id, 9).script, amount: BigInt(utxo.value - 500) });
  const margin = w.r.books.toJSON().margin;
  assert.throws(() => w.r.signPoolTx({ tx: evil, inputs: [coin], ref: null, kind: "fanout" }), /I1: output 0 does not pay the change key/);
  const foreign = { key: `${hash32()}:0`, txid: hash32(), vout: 0, value: 50_000, kind: "change", confirmed: true };
  const tx2 = new btc.Transaction();
  tx2.addInput({ txid: foreign.txid, index: 0, witnessUtxo: { script: w.r.change.script, amount: 50_000n }, tapInternalKey: w.r.change.pub });
  tx2.addOutput({ script: w.r.change.script, amount: 49_000n });
  assert.throws(() => w.r.signPoolTx({ tx: tx2, inputs: [foreign], ref: null, kind: "fanout" }), /I0: .* is not an unspent pool coin/);
  assert.equal(w.r.books.toJSON().margin, margin, "nothing was charged");
});

/* ---------------------------------------------------------------- 6. signed submits */

test("6 balance_low (402) comes before any proof check; bad_signature, stale_request, replayed; a request signed for another mode or envelope is refused", async () => {
  const w = await world({ config: { invalidPerHour: 2 } });
  const checks = () => w.idx.proofChecks;
  const before = checks();
  const broke = newAccount();
  const low = await send(w, broke, synth(w.idx));
  assert.deepEqual([low.status, low.body.error], [402, { code: "balance_low", message: MESSAGES.balance_low, balance: 0, needed: QUOTE, perSend: QUOTE }]);
  const some = await funded(w, 2000); // 1,712 available
  const tight = await funded(w, 2000);
  w.r.books.penalize(tight.idHex, 1712 - 1000); // leaves 1,000: a Next-block send (658) fits, a batch send (2 x 658) does not
  const batchLow = await send(w, tight, synth(w.idx, w.idx.height - (w.idx.height % 6)), "batch");
  assert.deepEqual([batchLow.status, batchLow.body.error.needed, batchLow.body.error.perSend], [402, 2 * QUOTE, QUOTE]);
  assert.equal(checks(), before, "no proof was checked for a short balance");

  const env = synth(w.idx);
  const info = w.r.info();
  const good = JSON.parse(signedSubmit(some, info, env, "block"));
  const expect = async (body, status, c) => {
    const out = await w.r.submit(typeof body === "string" ? body : JSON.stringify(body), anyIp());
    assert.deepEqual([out.status, code(out)], [status, c], JSON.stringify(out.body));
    return out;
  };
  await expect({ ...good, sig: good.sig.replace(/^./, (x) => (x === "0" ? "1" : "0")) }, 401, "bad_signature");
  await expect({ ...good, mode: "fast" }, 401, "bad_signature"); // signed for "block"
  await expect({ ...good, envelope: hex(synth(w.idx)) }, 401, "bad_signature"); // signed for another envelope
  await expect({ ...good, accountPub: broke.pubHex }, 401, "bad_signature");
  await expect({ ...good, t: good.t + 1 }, 401, "bad_signature");
  const stale = await expect(signedSubmit(some, info, env, "block", { now: () => Date.now() - 601_000 }), 401, "stale_request");
  assert.ok(Math.abs(stale.body.error.serverTime - Date.now() / 1000) < 5);
  await expect(signedSubmit(some, info, env, "block", { now: () => Date.now() + 601_000 }), 401, "stale_request");
  const otherNet = signRequest({ account: some, endpoint: "/api/relay/submit", network: "testnet", poolKey: info.balance.poolKey, fields: { envelope: hex(env), mode: "block" } });
  await expect(otherNet, 401, "bad_signature");
  // Shapes: no mode, a retired mode, an extra key, a PoW field, uppercase hex.
  const { mode: _m, ...noMode } = good;
  await expect(noMode, 400, "malformed");
  await expect({ ...good, mode: "batch12" }, 400, "malformed");
  await expect({ ...good, pow: { block: hash32(), nonce: "00".repeat(8) } }, 400, "malformed");
  await expect({ ...good, envelope: good.envelope.toUpperCase() }, 400, "malformed");
  await expect("{", 400, "malformed");
  assert.equal(checks(), before, "none of these reached the proof check");

  const ok = await expect(good, 202, undefined);
  assert.deepEqual([ok.body.reservedSats, ok.body.balance, ok.body.flush], [QUOTE, 1712 - QUOTE, "next-block"]);
  await expect(good, 409, "replayed");
  assert.equal(checks(), before + 1);

  // An invalid proof costs 50 sats to the margin; after 2 in an hour, the account is limited before any proof check.
  const rich = await funded(w, 9000);
  const margin = w.r.books.toJSON().margin;
  for (let i = 0; i < 2; i++) {
    const out = await send(w, rich, synth(w.idx, w.idx.height, { bad: true }));
    assert.deepEqual([out.status, code(out)], [422, "proof_invalid"]);
  }
  assert.equal(w.r.books.toJSON().margin, margin + 100);
  assert.equal(w.r.books.account(rich.idHex).balance, 8712 - 100);
  const n = checks();
  const limited = await send(w, rich, synth(w.idx));
  assert.deepEqual([limited.status, code(limited)], [429, "rate_limited"]);
  assert.equal(checks(), n, "limited before the proof check");
  assert.equal(w.r.checkBooks().ok, true);
});

/* ---------------------------------------------------------------- 7. fee cap, fast */

test("7 above the fee cap, Fast, Next block and batch are refused at submit with fee_high, never queued; Fast otherwise goes out at once", async () => {
  const w = await world({ fastDelayMs: () => 0 });
  const a = await funded(w, 20_000);
  w.esplora.fee = 6;
  await w.tick();
  assert.equal(w.r.info().code, "fee_high");
  for (const mode of ["fast", "block", "batch", "batch10"]) {
    const anchor = mode.startsWith("batch") ? w.idx.height - (w.idx.height % (mode === "batch" ? 6 : 60)) : w.idx.height;
    const out = await send(w, a, synth(w.idx, anchor), mode);
    assert.deepEqual([out.status, out.body.error], [503, { code: "fee_high", message: MESSAGES.fee_high, feeRate: 6, maxFeeRate: 5 }], mode);
  }
  // A carrier above MAX_FEE_PER_TX is the same refusal.
  w.esplora.fee = 5;
  w.r.config.maxFeePerTx = 2000; // 5 x 598 = 2,990
  await w.tick();
  assert.equal(code(await send(w, a, synth(w.idx), "fast")), "fee_high");
  assert.deepEqual([w.r.items.length, w.r.books.account(a.idHex).reserved], [0, 0], "nothing queued, nothing reserved");
  w.r.config.maxFeePerTx = 3000;
  w.esplora.fee = 1;
  await w.tick();
  const out = await send(w, a, synth(w.idx), "fast");
  assert.equal(out.status, 202);
  for (let i = 0; i < 100 && w.r.status(out.body.id).status === "queued"; i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(w.r.status(out.body.id).status, "broadcast", "sent without waiting for a block or a random delay");
});

/* ---------------------------------------------------------------- 8. missed batch item */

test("8 one short batch item becomes missed (balance_low, reservation returned) while the rest of its epoch goes out at releaseAt; a top-up never sends it", async () => {
  const w = await world({ start: 864_000 });
  const S = w.idx.height;
  assert.equal(S % 6, 0);
  const A = await funded(w, 7000);
  const B = await funded(w, 7000);
  const C = await funded(w, 2000); // 1,712: covers the 2 x 658 reservation, not a carrier at 3 sat/vB
  const ids = {};
  for (const [name, acct] of [["A", A], ["B", B], ["C", C]]) {
    const out = await send(w, acct, synth(w.idx, S), "batch");
    assert.equal(out.status, 202, JSON.stringify(out.body));
    assert.equal(out.body.reservedSats, 2 * QUOTE);
    ids[name] = out.body.id;
  }
  assert.deepEqual(w.r.books.account(C.idHex), { balance: 1712 - 2 * QUOTE, reserved: 2 * QUOTE, nextIndex: 1 });
  while (w.idx.height < S + 5) await w.step();
  assert.equal(w.esplora.carriers().length, 0, "nothing before releaseAt");
  w.esplora.fee = 3; // 1,794 + 180 = 1,974 per carrier at release
  await w.step(); // S + 6: release
  assert.equal(w.idx.height, S + 6);
  const st = (id) => w.r.status(id);
  assert.deepEqual([st(ids.A).status, st(ids.B).status], ["broadcast", "broadcast"], "the rest of the epoch went out on time");
  assert.deepEqual(st(ids.C), {
    status: "missed", code: "balance_low", reason: MISSED_REASON.balance_low, anchor: S, deadline: S + 100, mode: "batch", releaseAt: S + 6, lastRelease: S + 76,
  });
  assert.deepEqual(w.r.books.account(C.idHex), { balance: 1712, reserved: 0, nextIndex: 1 }, "its reservation came back: nothing charged");
  for (const acct of [A, B]) assert.deepEqual(w.r.books.account(acct.idHex), { balance: 6712 - 1974, reserved: 0, nextIndex: 1 }, "exact cost at release, the rest returned");
  assert.equal(w.r.info().stats.missed, 1);
  // A top-up afterwards never sends it.
  w.esplora.fee = 1;
  await fundAccount({ relayer: w.r, esplora: w.esplora, account: C, sats: 9000 });
  const sent = w.esplora.carriers().length;
  for (let i = 0; i < 8; i++) await w.land();
  assert.equal(w.esplora.carriers().length, sent);
  assert.equal(st(ids.C).status, "missed");
  assert.equal(w.r.pending.size, 0, "its nullifiers left the pending set");
  assert.equal(w.r.checkBooks().ok, true);
});

test("9 batch at release above the cap: every item missed with fee_high, nothing charged; fee rate unknown or too few pool coins: the epoch is held whole and goes next block", async () => {
  const w = await world({ start: 864_000 });
  const S = w.idx.height;
  const acc = [await funded(w), await funded(w), await funded(w)];
  const ids = [];
  for (const a of acc) ids.push((await send(w, a, synth(w.idx, S), "batch")).body.id);
  const books = JSON.stringify(acc.map((a) => w.r.books.account(a.idHex)));
  while (w.idx.height < S + 5) await w.step();
  w.esplora.fee = 6;
  await w.step();
  for (const id of ids) assert.deepEqual([w.r.status(id).status, w.r.status(id).code], ["missed", "fee_high"]);
  for (const a of acc) assert.deepEqual(w.r.books.account(a.idHex), { balance: 6712, reserved: 0, nextIndex: 1 }, "nothing charged");
  assert.notEqual(JSON.stringify(acc.map((a) => w.r.books.account(a.idHex))), books);
  assert.equal(w.esplora.carriers().length, 0);
  const housekeeping = w.r.state.ledger.filter((l) => l.kind !== "carrier").reduce((s, l) => s + l.fee, 0);
  assert.equal(w.r.books.toJSON().totals.fees, housekeeping, "only the merge of the deposits into C, paid from the margin");

  // Too few pool coins: three 2,000-sat deposits (merged into one coin) fund fewer than three carriers at 4 sat/vB, so the epoch waits whole.
  const v = await world({ start: 870_000 });
  const S2 = v.idx.height;
  const small = [await funded(v, 2000), await funded(v, 2000), await funded(v, 2000)];
  const ids2 = [];
  for (const a of small) ids2.push((await send(v, a, synth(v.idx, S2), "batch")).body.id);
  while (v.idx.height < S2 + 5) await v.step();
  v.esplora.fee = 4;
  await v.step();
  assert.deepEqual(ids2.map((id) => v.r.status(id).status), ["queued", "queued", "queued"], "held whole");
  assert.ok(v.r.capacity() < 3);
  // The fee rate unknown at the next block: still held whole.
  v.esplora.fee = 1;
  await v.c.mine();
  v.r.cache.feeRate = null;
  v.r.perCache = null;
  await v.r.flush();
  assert.deepEqual(ids2.map((id) => v.r.status(id).status), ["queued", "queued", "queued"]);
  await v.tick(); // the fee rate is back: the whole epoch goes out together
  assert.deepEqual(ids2.map((id) => v.r.status(id).status), ["broadcast", "broadcast", "broadcast"]);
  assert.equal(v.r.checkBooks().ok, true);
});

/* ---------------------------------------------------------------- 10. charges and I2 */

test("10 each broadcast carrier is charged fee + marginFor(fee), the fee being the on-chain amount difference; I2 holds every tick; tampered books halt the relayer", async () => {
  const dir = mkdtempSync(join(DIR, "books-"));
  writeFileSync(join(dir, "relayer.json"), JSON.stringify({ version: 1, items: { ["cd".repeat(16)]: { id: "cd".repeat(16), status: "accepted", anchor: 10, txid: "ef".repeat(32), height: 12, nullifiers: [] } }, ledger: [] }));
  const w = await world({ dir });
  const accts = [await funded(w, 7000), await funded(w, 12_000), await funded(w, 3000)];
  const sent = [];
  for (let round = 0; round < 3; round++) {
    for (const a of accts) {
      const before = w.r.books.account(a.idHex).balance + w.r.books.account(a.idHex).reserved;
      const out = await send(w, a, synth(w.idx));
      if (out.status === 202) sent.push({ id: out.body.id, a, before });
    }
    if (round === 1) w.esplora.fee = 2;
    await w.step();
    assert.equal(w.r.checkBooks().ok, true, `I2 after round ${round}`);
    await w.land();
    assert.equal(w.r.checkBooks().ok, true);
  }
  assert.ok(sent.length >= 7);
  const byTxid = new Map(w.esplora.accepted.map((raw) => [txOf(raw).id, txOf(raw)]));
  for (const { id } of sent) {
    const item = w.r.state.items[id];
    const tx = byTxid.get(item.txid);
    const fee = inputSum(w.esplora, tx) - outSum(tx);
    assert.equal(item.fee, fee, "the recorded fee is the on-chain difference");
    assert.equal(w.r.status(id).cost, fee + marginFor(fee));
  }
  const totalCost = sent.reduce((s, x) => s + w.r.status(x.id).cost, 0);
  const totalFees = sent.reduce((s, x) => s + w.r.state.items[x.id].fee, 0);
  const balances = accts.reduce((s, a) => s + w.r.books.account(a.idHex).balance, 0);
  assert.equal(balances, 6712 + 11_712 + 2712 - totalCost, "the users paid exactly the costs");
  const j = w.r.books.toJSON();
  const housekeeping = w.r.state.ledger.filter((l) => l.kind !== "carrier" && l.outcome !== "dropped").reduce((s, l) => s + l.fee, 0);
  assert.ok(housekeeping > 0, "the deposits were merged into C");
  assert.equal(j.totals.fees, totalFees + housekeeping, "every carrier fee was charged to a balance; merges were paid from the margin");
  assert.equal(j.margin, 3 * 288 + totalCost - totalFees - housekeeping);
  assert.equal(w.r.poolUnspent(), w.r.books.liabilities(), "the pool holds exactly what it owes");

  // Tamper with the saved books: +1,000 sats for one account. The restarted relayer halts.
  w.r.close();
  const path = join(dir, "relay-balance", "relayer.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  // (L2: the books store accounts under an opaque key, never the account id.)
  saved.books.accounts[w.r.accountKeyOf(accts[0].idHex)].balance += 1000;
  writeFileSync(path, JSON.stringify(saved));
  const errors = [];
  const h = await makePaidRelayer({ idx: w.idx, esplora: w.esplora, dir, log: { ...silent, error: (m) => errors.push(m) } });
  relayers.push(h);
  await h.onTick({ chainTip: w.idx.height });
  assert.ok(h.state.halted);
  assert.ok(errors.some((m) => /relayer halted/.test(m)));
  const http = await serve(createApp({ idx: w.idx, relayer: h, v1StatePath: join(dir, "relayer.json"), log: silent }));
  const sub = await http.post("/api/relay/submit", signedSubmit(accts[1], h.info(), synth(w.idx)));
  assert.deepEqual([sub.status, sub.body.error.code, sub.body.error.message], [503, "halted", MESSAGES.halted]);
  assert.equal((await http.post("/api/relay/account", signedAccount(accts[1], h.info()))).body.error.code, "halted");
  assert.equal((await http.post("/api/relay/credit", JSON.stringify({ outpoint: `${hash32()}:0`, accountPub: accts[1].pubHex, n: 0 }))).body.error.code, "halted");
  const info = await http.get("/api/relay/info");
  assert.deepEqual([info.status, info.body.code, info.body.mode], [200, "halted", "balance"]);
  const v1 = await http.get(`/api/relay/status/${"cd".repeat(16)}`);
  assert.deepEqual([v1.status, v1.body.status], [200, "accepted"], "v1 status still answers");
  const carriers = w.esplora.accepted.length;
  await w.c.mine();
  await h.onTick({ chainTip: w.idx.height });
  assert.equal(w.esplora.accepted.length, carriers, "nothing new is signed while halted");
});

/* ---------------------------------------------------------------- 11. one signing site, no shared input */

test("11 signPoolTx is the only signing call site in server/relayer.mjs; no replacement path; no two signed transactions share an input", () => {
  const src = readFileSync("server/relayer.mjs", "utf8");
  const start = src.indexOf("\n  signPoolTx({");
  assert.ok(start > 0);
  const end = src.indexOf("\n  }\n", start);
  const body = src.slice(start, end);
  const outside = src.slice(0, start) + src.slice(end);
  for (const re of [/\bsignInputs\(/g, /\.sign\(/g, /\.signIdx\(/g, /\bsignLocal\(/g]) {
    assert.equal((outside.match(re) ?? []).length, 0, `${re} outside signPoolTx`);
  }
  assert.equal((body.match(/\bsignInputs\(/g) ?? []).length, 1, "signPoolTx signs through signInputs once");
  assert.doesNotMatch(src, /bump/i);
  // L5 signals RBF on every input (one nSequence policy for every route), but the relayer never
  // replaces or bumps what it sent: no CPFP, and a broadcast carrier is never signed again.
  assert.doesNotMatch(src, /cpfp/i);
  assert.match(src, /RBF_SEQUENCE/, "L5: the relayer's inputs signal RBF like every other route");
  assert.doesNotMatch(src, /esplora\.utxos|\.utxos\(/, "no address is ever listed");

  const seen = new Map(); // outpoint -> txid
  let n = 0;
  for (const f of fakes) {
    for (const raw of new Set(f.calls)) {
      const tx = txOf(raw);
      n += 1;
      for (let i = 0; i < tx.inputsLength; i++) {
        const k = `${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`;
        assert.ok(!seen.has(k) || seen.get(k) === tx.id, `${k} spent by two transactions`);
        seen.set(k, tx.id);
      }
    }
  }
  assert.ok(n > 20, `checked ${n} signed transactions`);
});

/* ---------------------------------------------------------------- 12. privacy of the saved state */

test("12 once broadcast, no saved relayer.json holds an account next to a carrier txid; the ledger view has no account, id or cost", async () => {
  const dir = mkdtempSync(join(DIR, "privacy-"));
  const w = await world({ dir });
  const S = w.idx.height - (w.idx.height % 6);
  const accts = [await funded(w), await funded(w), await funded(w)];
  const ids = [];
  for (const a of accts) ids.push((await send(w, a, synth(w.idx))).body.id);
  ids.push((await send(w, accts[0], synth(w.idx, S), "batch")).body.id);
  // While queued the item knows its account (its reservation needs it), by its opaque books key (L2).
  const queued = JSON.parse(readFileSync(join(dir, "relay-balance", "relayer.json"), "utf8"));
  assert.equal(queued.items[ids[0]].account, w.r.accountKeyOf(accts[0].idHex));
  assert.equal(JSON.stringify(queued).includes(accts[0].idHex), false, "never the account id itself");
  while (w.idx.height < S + 6) await w.step();
  await w.land();
  const saved = JSON.parse(readFileSync(join(dir, "relay-balance", "relayer.json"), "utf8"));
  const accountIds = accts.map((a) => a.idHex);
  for (const item of Object.values(saved.items)) {
    if (!item.txid) continue;
    assert.equal(item.account, undefined, "no account on a carrier item");
    for (const id of accountIds) assert.ok(!JSON.stringify(item).includes(id));
  }
  for (const l of saved.ledger) {
    assert.deepEqual(Object.keys(l).filter((k) => !["seq", "kind", "txid", "vsize", "fee", "feeRate", "broadcastHeight", "height", "outcome", "reason", "epoch", "raw", "unsent"].includes(k)), []);
    for (const id of accountIds) assert.ok(!JSON.stringify(l).includes(id));
  }
  assert.deepEqual(saved.books.charges, {}, "no charge links an item to an account once broadcast");
  assert.deepEqual(saved.books.reservations, {});
  const booksText = JSON.stringify(saved.books);
  for (const id of ids) assert.ok(!booksText.includes(id), "no item id in the books");
  for (const item of Object.values(saved.items)) if (item.txid) assert.ok(!booksText.includes(item.txid), "no txid in the books");
  const http = await serve(createApp({ idx: w.idx, relayer: w.r, log: silent }));
  const ledger = await http.get("/api/relay/ledger");
  const text = JSON.stringify(ledger.body);
  assert.equal(ledger.body.address, w.r.address);
  for (const id of [...ids, ...accountIds]) assert.ok(!text.includes(id));
  for (const row of ledger.body.items) assert.deepEqual(Object.keys(row).sort(), ["broadcastHeight", "fee", "feeRate", "height", "kind", "outcome", "reason", "seq", "txid", "vsize"]);
});

/* ---------------------------------------------------------------- 13. no request body is logged */

test("13 no request body is logged: credits, account reads, submits and failures leave no envelope, accountPub, sig or outpoint in any log line", async () => {
  const lines = [];
  const capture = { log: (...a) => lines.push(a.join(" ")), warn: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
  const w = await world({ log: capture });
  const http = await serve(createApp({ idx: w.idx, relayer: w.r, log: capture }));
  const a = newAccount();
  const secrets = [a.pubHex, a.idHex];
  const dep = depositAddress(w.r.Q, a.id, 0);
  const t1 = w.esplora.pay([{ script: dep.script, value: 7000 }], { height: w.idx.height });
  const tSmall = w.esplora.pay([{ script: depositAddress(w.r.Q, a.id, 1).script, value: 900 }], { height: w.idx.height });
  secrets.push(t1, tSmall);
  for (const b of [
    { outpoint: `${t1}:0`, accountPub: a.pubHex, n: 0 }, { outpoint: `${t1}:0`, accountPub: a.pubHex, n: 0 },
    { outpoint: `${tSmall}:0`, accountPub: a.pubHex, n: 1 }, { outpoint: `${t1}:0`, accountPub: a.pubHex, n: 5 },
    { outpoint: `${t1.toUpperCase()}:0`, accountPub: a.pubHex, n: 0 },
  ]) await http.post("/api/relay/credit", JSON.stringify(b));
  await http.post("/api/relay/account", signedAccount(a, w.r.info()));
  const envs = [synth(w.idx), synth(w.idx, w.idx.height, { bad: true }), synth(w.idx)];
  const bodies = envs.map((e) => signedSubmit(a, w.r.info(), e));
  for (const b of bodies) {
    secrets.push(JSON.parse(b).sig, JSON.parse(b).envelope.slice(0, 64), JSON.parse(b).envelope.slice(-64));
    await http.post("/api/relay/submit", b);
  }
  await http.post("/api/relay/submit", bodies[0]); // replayed
  await http.post("/api/relay/submit", bodies[0].replace(/"mode":"block"/, '"mode":"fast"'));
  // An internal error whose message quotes the request: only its name is logged.
  const env = synth(w.idx);
  secrets.push(hex(env).slice(0, 64));
  const real = w.idx.checkTx;
  w.idx.checkTx = async () => {
    throw new Error(`boom ${hex(env)} ${a.pubHex}`);
  };
  const boom = await http.post("/api/relay/submit", signedSubmit(a, w.r.info(), env));
  w.idx.checkTx = real;
  assert.deepEqual([boom.status, boom.body.error.code], [503, "busy"]);
  await w.step();
  await w.land();
  const all = lines.join("\n");
  assert.ok(lines.some((l) => /relay submit failed: internal error \(Error\)/.test(l)), all);
  for (const s of secrets) assert.ok(!all.includes(s), `a log line holds ${s.slice(0, 16)}…`);
});

/* ---------------------------------------------------------------- 14. deposit reorgs */

test("14 a credited deposit whose transaction vanishes for two ticks is reversed; one already spent halts the relayer for good", async () => {
  const w = await world();
  const a = newAccount();
  const f = await fundAccount({ relayer: w.r, esplora: w.esplora, account: a, sats: 7000 });
  w.esplora.vanish(f.txid);
  await w.tick();
  assert.equal(w.r.books.isCredited(f.outpoint).reversed, undefined, "one 404 is not enough");
  w.esplora.txs.set(f.txid, "back"); // answered again (in the mempool): the count starts over
  w.esplora.mempool.add(f.txid);
  await w.tick();
  w.esplora.vanish(f.txid);
  await w.tick();
  assert.ok(!w.r.books.isCredited(f.outpoint).reversed);
  await w.tick();
  assert.equal(w.r.books.isCredited(f.outpoint).reversed, true);
  assert.equal(w.r.state.coins[f.outpoint], undefined, "its coin is forgotten");
  assert.deepEqual(w.r.books.account(a.idHex), { balance: 0, reserved: 0, nextIndex: 1 });
  assert.equal(w.r.checkBooks().ok, true);
  assert.equal(w.r.state.halted, null);
  // The same outpoint is never credited again.
  assert.equal(code(await w.r.credit(JSON.stringify({ outpoint: f.outpoint, accountPub: a.pubHex, n: 0 }), anyIp())), "already_credited");

  // A deposit that funded a carrier, then vanished: halted for good.
  const v = await world();
  const b = newAccount();
  const g = await fundAccount({ relayer: v.r, esplora: v.esplora, account: b, sats: 7000 });
  assert.equal((await send(v, b, synth(v.idx))).status, 202);
  await v.step();
  assert.equal(v.r.state.coins[g.outpoint].status, "spent");
  v.esplora.vanish(g.txid);
  await v.tick();
  await v.tick();
  assert.ok(v.r.state.halted?.sticky);
  assert.ok(v.r.state.halted.problems.some((p) => p.startsWith("spent a reversed deposit")));
  assert.equal(v.r.gateCode(), "halted");
  await v.tick();
  assert.ok(v.r.state.halted, "a later tick does not clear it");
  // Deeper credits are no longer looked up.
  const u = await world();
  const c = newAccount();
  const h = await fundAccount({ relayer: u.r, esplora: u.esplora, account: c, sats: 5000 });
  for (let i = 0; i < 6; i++) await u.step();
  u.esplora.requests.length = 0;
  await u.tick();
  assert.equal(u.esplora.requests.some(([, t]) => t === h.txid), false);
});

/* ---------------------------------------------------------------- reorg of a carrier, restart */

test("a journaled carrier is resent with identical bytes after a restart, and charged once; a carrier the network refuses for a missing input is retried on another coin, unsent ones are refunded", async () => {
  const dir = mkdtempSync(join(DIR, "restart-"));
  const w = await world({ dir });
  const a = await funded(w, 7000);
  await funded(w, 7000);
  const out = await send(w, a, synth(w.idx));
  await w.tick(); // same height: the deposits are merged into C, nothing is flushed
  await w.c.mine();
  w.esplora.failNext = new Error("socket hang up");
  await w.tick();
  const item = w.r.state.items[out.body.id];
  assert.equal(item.status, "signing");
  assert.equal(w.r.status(out.body.id).status, "queued");
  const charged = w.r.books.account(a.idHex).balance;
  assert.equal(charged, 6712 - (PER + marginFor(PER)), "charged at signing");
  w.r.close();
  const r2 = await makePaidRelayer({ idx: w.idx, esplora: w.esplora, dir });
  relayers.push(r2);
  assert.equal(r2.status(out.body.id).status, "broadcast", "recover() resent it");
  assert.equal(w.esplora.calls.at(-1), item.raw, "the same bytes");
  assert.equal(r2.books.account(a.idHex).balance, charged, "charged once");
  assert.equal(r2.state.items[out.body.id].account, undefined);
  assert.equal(r2.checkBooks().ok, true);

  // The network says the input is missing: refunded, re-reserved, retried with another coin.
  const acct = newAccount();
  await fundAccount({ relayer: r2, esplora: w.esplora, account: acct, sats: 7000 });
  await r2.onTick({ chainTip: w.idx.height }); // prices fees (a restarted relayer answers busy until its first tick) and merges the deposit
  assert.equal(r2.checkBooks().ok, true);
  const o2 = await r2.submit(signedSubmit(acct, r2.info(), synth(w.idx)), anyIp());
  assert.equal(o2.status, 202);
  const gone = r2.spendableCoins().find((c) => c.kind === "change");
  w.esplora.coins.delete(gone.key); // the explorer no longer has that coin
  const pick = r2.pickCoin.bind(r2);
  let first = true;
  r2.pickCoin = (coins, need) => (first ? ((first = false), coins.find((c) => c.key === gone.key)) : pick(coins, need)); // it is picked first
  await w.c.mine();
  await r2.onTick({ chainTip: w.idx.height });
  assert.equal(first, false);
  assert.notEqual(r2.state.items[o2.body.id].outpoint, gone.key, "carried on another coin");
  assert.equal(r2.status(o2.body.id).status, "broadcast");
  assert.equal(r2.checkBooks().ok, true, "the refused carrier was refunded exactly");
  assert.deepEqual(r2.books.toJSON().charges, {});
});

test("a failed journal save stops the tick and leaves nothing signed in memory: refunded, re-reserved, coins back, nothing broadcast", async () => {
  const w = await world();
  const a = await funded(w, 7000);
  const out = await send(w, a, synth(w.idx));
  assert.equal(out.status, 202);
  const coins = JSON.stringify(w.r.state.coins);
  const books = JSON.stringify(w.r.books.toJSON());
  const save = w.r.save.bind(w.r);
  w.r.save = () => {
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  };
  await w.c.mine();
  await assert.rejects(w.tick(), /ENOSPC/);
  w.r.save = save;
  const item = w.r.state.items[out.body.id];
  assert.deepEqual([item.status, item.raw, item.txid], ["queued", undefined, undefined]);
  assert.equal(w.esplora.calls.length, 0, "nothing that is not on disk is ever broadcast");
  assert.equal(JSON.stringify(w.r.books.toJSON()), books, "the charge was undone exactly");
  assert.deepEqual(Object.keys(JSON.parse(coins)).sort(), Object.keys(w.r.state.coins).sort());
  // The disk works again: the next block carries it.
  w.r.suspect.clear();
  await w.step();
  assert.equal(w.r.status(out.body.id).status, "broadcast");
  assert.equal(w.r.checkBooks().ok, true);
});

test("info while the fee rate is unknown: busy, no per-send price; credit and account reads still work", async () => {
  const esplora = makeFakeEsplora();
  esplora.feeError = new Error("GET /fees: 503");
  fakes.push(esplora);
  const c = chain({ fakes: [esplora] });
  await c.mine();
  const r = await makePaidRelayer({ idx: c.idx, esplora });
  relayers.push(r);
  await r.onTick({ chainTip: c.idx.height });
  const info = r.info();
  assert.deepEqual([info.code, info.fees.feeRate, info.fees.carrierFeeSats, info.balance.perSendSats, info.balance.suggestedTopUpSats], ["busy", null, null, null, null]);
  const a = newAccount();
  const f = await fundAccount({ relayer: r, esplora, account: a, sats: 5000 });
  assert.equal(f.status, 200);
  assert.equal((await r.account(signedAccount(a, info), anyIp())).body.balance, 4712);
  assert.equal(code(await r.submit(signedSubmit(a, info, synth(c.idx)), anyIp())), "busy");
});

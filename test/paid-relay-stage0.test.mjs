// Stage 0 of paid relay (docs/design/paid-relay.md §1, §12, §15.1): the free relayer is retired.
// Stage 1 (docs/design/relay-balance-contract.md §4.1, rule R6) keeps every stage-0 answer
// unless the paid relayer is configured; test/relay-balance-relayer.test.mjs covers that one.
// - MURKLE_RELAYER=1 alone is refused (in process and as a real process): the paid relayer needs
//   MURKLE_RELAY_MODE=balance and a valid configuration. The free relayer's budget, proof-of-work
//   and accept-bucket settings are no longer read.
// - Without a relayer, /api/relay/info answers a stable "not available" shape, POST
//   /api/relay/submit, /account and /credit answer 503 "disabled", and v1 relay ids answer
//   "dropped" (accepted ones stay accepted) from a v1 relayer.json that is read and never written.
// - `murkle relayer retire-free` sweeps the old key's coins to the operator's address, refuses while a
//   v1 carrier may still land, broadcasts nothing on a dry run, and takes no flag it does not know.
// - `murkle pending` and `retry` look up every relayed entry, a batch one before its release too.
// Fakes and temporary copies only: nothing touches data/signet/ or a real network, nothing is broadcast.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { Indexer, ANCHOR_WINDOW } from "../src/indexer.mjs";
import { btcAccount } from "../src/btc/funding.mjs";
import { hex } from "../src/bytes.mjs";
import { DEFAULTS, RETIRED_ENV, configFromEnv, relayerStartup } from "../server/relayer.mjs";
import { RETIRED_REASON, UNAVAILABLE_REASON, loadV1State, planSweep, relayInfoOff, retireFree, v1Status } from "../server/retired-relay.mjs";
import { createApp } from "../server/indexer-server.mjs";

const { RETIRE_USAGE, listPending, parseRetireFlags, pickRetry, relayOpenAt } = await import("../bin/murkle.mjs");

const DIR = mkdtempSync(join(tmpdir(), "murkle-stage0-"));
after(() => rmSync(DIR, { recursive: true, force: true }));
const silent = { log() {}, warn() {}, error() {} };
const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const LIVE_V1 = "data/signet/relayer.json";
const liveBefore = existsSync(LIVE_V1) ? { hash: sha(LIVE_V1), mtime: statSync(LIVE_V1).mtimeMs } : null;
after(() => {
  if (liveBefore) assert.deepEqual({ hash: sha(LIVE_V1), mtime: statSync(LIVE_V1).mtimeMs }, liveBefore, "data/signet/relayer.json untouched");
});
const id = (c) => c.repeat(32 / c.length); // a 32-hex-char relay id
const txid = () => randomBytes(32).toString("hex");

/* ---------- the server never starts a relayer ---------- */

test("relayerStartup: MURKLE_RELAYER=1 alone is refused with a clear line; nothing else starts one either", () => {
  const asked = relayerStartup((n) => (n === "RELAYER" ? "1" : undefined));
  assert.equal(asked.start, false);
  assert.equal(asked.requested, true);
  assert.match(asked.message, /^refusing to start the relayer: MURKLE_RELAYER=1 needs MURKLE_RELAY_MODE=balance and a valid relay balance configuration \(docs\/design\/relay-balance\.md\)\. There is no free mode\./);
  assert.match(asked.message, /The indexer keeps running\.$/);
  const off = relayerStartup(() => undefined);
  assert.deepEqual([off.start, off.requested], [false, false]);
  assert.equal(off.message, "Relayer off. Wallets pay the fee themselves or copy the envelope.");
  // Every relayer variable at once, without MURKLE_RELAY_MODE=balance, still starts nothing.
  const all = Object.fromEntries([["RELAYER", "1"], ["TRUST_PROXY", "1"], ["MAX_FEE_RATE", "4"], ...RETIRED_ENV.map((n) => [n, "1"])]);
  assert.equal(relayerStartup((n) => all[n]).start, false);
  assert.equal(relayerStartup((n) => ({ ...all, RELAY_MODE: "free" })[n]).start, false);
});

test("the free relayer's budget, proof-of-work and accept-bucket settings are no longer read", () => {
  const keys = {
    DAILY_BUDGET_SATS: "dailyBudgetSats", POW_BASE_BITS: "powBaseBits", POW_MAX_EXTRA: "powMaxExtra", POW_BUDGET_EXTRA: "powBudgetExtra",
    ACCEPT_PER_HOUR: "acceptPerHour", ACCEPT_PER_DAY: "acceptPerDay", REJECT_PER_HOUR: "rejectPerHour", HOT_FLOOR_SATS: "hotFloorSats",
  };
  assert.deepEqual([...RETIRED_ENV].sort(), Object.keys(keys).sort());
  for (const [name, key] of Object.entries(keys)) {
    const cfg = configFromEnv((n) => (n === name ? "7" : undefined));
    assert.equal(key in DEFAULTS, false, `${key} is gone from the defaults`);
    assert.equal(cfg[key], undefined, `MURKLE_${name} changes nothing`);
    // Not even a bad value is looked at.
    assert.doesNotThrow(() => configFromEnv((n) => (n === name ? "lots" : undefined)), name);
  }
  assert.equal(configFromEnv((n) => (n === "MAX_QUEUE" ? "7" : undefined)).maxQueue, 7, "settings a paid relayer keeps are still read");
});

test("indexer-server.mjs never constructs the Relayer class: it imports startPaidRelayer, used only when relayerStartup() says start", () => {
  const src = readFileSync("server/indexer-server.mjs", "utf8");
  assert.doesNotMatch(src, /new Relayer\b/);
  const imports = src.match(/import \{([^}]*)\} from "\.\/relayer\.mjs"/)?.[1] ?? "";
  assert.doesNotMatch(imports, /(^|[\s,])Relayer([\s,]|$)/);
  assert.match(imports, /\bstartPaidRelayer\b/);
  assert.match(src, /relayerStartup\(\)/);
  assert.match(src, /if \(startup\.start\) \{\s*try \{\s*relayer = await startPaidRelayer\(/);
});

/** A free port for a child process (closed again before it starts). */
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

test("as a real process, MURKLE_RELAYER=1 logs the refusal, starts no relayer and the indexer keeps serving", { timeout: 60_000 }, async () => {
  const v1 = join(DIR, "proc-relayer.json");
  writeFileSync(v1, JSON.stringify({ version: 1, items: { [id("ab")]: { id: id("ab"), status: "queued", anchor: 500, nullifiers: [] } }, ledger: [] }));
  const v1Hash = sha(v1);
  const port = await freePort();
  const child = spawn(process.execPath, ["server/indexer-server.mjs"], {
    env: {
      ...process.env, MURKLE_RELAYER: "1", MURKLE_INDEXER_PORT: String(port), MURKLE_STATE_PATH: join(DIR, "proc-state.json"),
      MURKLE_RELAY_STATE_PATH: v1, MURKLE_RELAY_KEY_PATH: join(DIR, "no-such.key"), MURKLE_ESPLORA: "http://127.0.0.1:9/api",
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
    for (let i = 0; i < 200 && !info; i++) {
      try {
        info = await (await fetch(`${base}/api/relay/info`)).json();
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    assert.ok(info, `the indexer answers (stdout: ${out}, stderr: ${err})`);
    assert.match(err, /refusing to start the relayer: MURKLE_RELAYER=1 needs MURKLE_RELAY_MODE=balance and a valid relay balance configuration/);
    assert.equal(info.enabled, false);
    assert.equal(info.address, null, "no relayer key was loaded or created");
    assert.equal(existsSync(join(DIR, "no-such.key")), false, "no key file was created");
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.relay.enabled, false);
    const st = await (await fetch(`${base}/api/relay/status/${id("ab")}`)).json();
    assert.deepEqual([st.status, st.reason], ["dropped", RETIRED_REASON]);
    assert.equal(sha(v1), v1Hash, "the v1 state is read, never written");
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
  }
});

/* ---------- the relay endpoints without a relayer ---------- */

/** A v1 relayer.json with one item of every status the free relayer wrote. */
function v1Fixture() {
  const A = txid();
  return {
    accepted: A,
    state: {
      version: 1, day: "2026-10-03", spentToday: 598, reserved: 597,
      items: {
        [id("a1")]: { id: id("a1"), status: "accepted", anchor: 100, mode: "fast", txid: A, height: 103, nullifiers: ["1"] },
        [id("b2")]: { id: id("b2"), status: "queued", anchor: 120, mode: "batch10", releaseAt: 180, lastRelease: 208, nullifiers: ["2"], envelope: "00" },
        [id("c3")]: { id: id("c3"), status: "broadcast", anchor: 130, mode: "block", txid: txid(), nullifiers: ["3"] },
        [id("d4")]: { id: id("d4"), status: "rejected", anchor: 90, mode: "block", txid: txid(), reason: "proof invalid", height: 95, nullifiers: ["4"] },
        [id("e5")]: { id: id("e5"), status: "expired", anchor: 80, mode: "batch", releaseAt: 86, lastRelease: 156, nullifiers: ["5"] },
        [id("f6")]: { id: id("f6"), status: "signing", anchor: 140, mode: "fast", txid: txid(), nullifiers: ["6"] },
      },
      ledger: [], reservedOutpoints: [], badOutpoints: [], changeDepth: {}, changeRoot: {},
    },
  };
}

async function serve(app) {
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${app.server.address().port}`;
}

test("no relayer: info is a stable 'not available' shape, submit answers 503 disabled, v1 ids answer dropped, relayer.json is not modified", async () => {
  const { accepted, state } = v1Fixture();
  const path = join(DIR, "relayer.json");
  writeFileSync(path, JSON.stringify(state));
  const before = { hash: sha(path), mtime: statSync(path).mtimeMs };
  const app = createApp({ idx: new Indexer({ vkey: VKEY, startHeight: 5 }), v1StatePath: path, webDist: join(DIR, "no-dist"), log: silent });
  const base = await serve(app);
  try {
    const info = await (await fetch(`${base}/api/relay/info`)).json();
    assert.deepEqual(info, relayInfoOff());
    assert.deepEqual(
      { enabled: info.enabled, code: info.code, reason: info.reason, ops: info.ops, address: info.address, batch: info.batch },
      { enabled: false, code: "disabled", reason: "no relayer runs on this server", ops: [], address: null, batch: null },
    );
    assert.deepEqual([info.mode, info.pow, info.balance, info.selfPay, info.docs], [null, null, null, true, "docs/design/relay-balance.md"]);
    assert.equal("tickets" in info, false);
    assert.equal(UNAVAILABLE_REASON, "no relayer runs on this server");
    assert.equal(info.network, "signet");

    for (const path of ["/api/relay/submit", "/api/relay/account", "/api/relay/credit"]) {
      for (const body of [JSON.stringify({ envelope: "00", mode: "block" }), "x".repeat(10_000)]) {
        const res = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body });
        assert.equal(res.status, 503, path);
        const { error } = await res.json();
        assert.equal(error.code, "disabled");
        assert.equal(error.message, "No relayer runs on this server. Pay the fee yourself, or copy the envelope so anyone can carry it.");
        assert.doesNotMatch(error.message, /\bfree\b|sponsor|ticket/i);
      }
      assert.equal((await fetch(`${base}${path}`)).status, 405, `GET ${path} is refused`);
    }

    const status = async (x) => {
      const res = await fetch(`${base}/api/relay/status/${x}`);
      return { code: res.status, body: await res.json() };
    };
    const a = await status(id("a1"));
    assert.deepEqual([a.code, a.body], [200, { status: "accepted", txid: accepted, height: 103, anchor: 100, deadline: 100 + ANCHOR_WINDOW }]);
    for (const x of ["b2", "c3", "d4", "e5", "f6"]) {
      const r = await status(id(x));
      assert.equal(r.code, 200, x);
      assert.equal(r.body.status, "dropped", x);
      assert.equal(r.body.reason, RETIRED_REASON, x);
      assert.equal(r.body.deadline, state.items[id(x)].anchor + ANCHOR_WINDOW, x);
    }
    assert.equal(RETIRED_REASON, "The free relayer was retired. Pay the fee yourself, or copy the envelope.");
    assert.deepEqual(
      (await status(id("b2"))).body,
      { status: "dropped", reason: RETIRED_REASON, anchor: 120, deadline: 220, mode: "batch10", releaseAt: 180, lastRelease: 208 },
      "a batch item keeps its timing fields, as the wallet reads them",
    );
    assert.equal((await status(id("99"))).code, 404, "unknown id");
    assert.equal((await status("garbage")).code, 404);
    assert.deepEqual((await (await fetch(`${base}/api/state`)).json()).relay, { enabled: false, mode: null, queued: 0, defaultMode: "block", batch: null });
    const ledger = await (await fetch(`${base}/api/relay/ledger`)).json();
    assert.deepEqual([ledger.address, ledger.items], [null, []]);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
  assert.deepEqual({ hash: sha(path), mtime: statSync(path).mtimeMs }, before, "relayer.json is read, never written");
  assert.equal(existsSync(`${path}.tmp`), false);
});

test("the live v1 relayer.json, through a copy: every id that did not land answers dropped, accepted ones stay", { skip: !liveBefore && "no data/signet/relayer.json here" }, async () => {
  const path = join(DIR, "live-copy.json");
  copyFileSync(LIVE_V1, path);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const v1 = loadV1State(path, { log: silent });
  assert.equal(v1.items.size, Object.keys(saved.items).length);
  for (const [k, item] of Object.entries(saved.items)) {
    const st = v1Status(v1, k);
    if (item.status === "accepted") assert.deepEqual([st.status, st.txid ?? null], ["accepted", item.txid ?? null], k);
    else assert.deepEqual([st.status, st.reason], ["dropped", RETIRED_REASON], k);
  }
  assert.equal(sha(path), sha(LIVE_V1));
});

test("an unreadable or newer v1 state never stops the indexer: its ids are simply unknown", async () => {
  for (const [name, text] of [["bad.json", "{not json"], ["v2.json", JSON.stringify({ version: 2, items: { [id("a1")]: { status: "queued" } } })]]) {
    const path = join(DIR, name);
    writeFileSync(path, text);
    const warnings = [];
    const app = createApp({ idx: new Indexer({ vkey: VKEY, startHeight: 5 }), v1StatePath: path, webDist: join(DIR, "no-dist"), log: { ...silent, warn: (m) => warnings.push(m) } });
    const base = await serve(app);
    try {
      assert.equal((await fetch(`${base}/api/relay/status/${id("a1")}`)).status, 404, name);
      assert.equal(warnings.length, 1, name);
    } finally {
      await new Promise((r) => app.server.close(r));
    }
  }
  assert.equal(loadV1State(join(DIR, "missing.json")).items.size, 0);
});

/* ---------- murkle relayer retire-free ---------- */

const KEY = new Uint8Array(randomBytes(32));
const OLD = btcAccount(KEY).address;
const OPERATOR = btcAccount(new Uint8Array(randomBytes(32))).address;
const TIP = 330_000;

/** Esplora with coins of the old key, carrier statuses, and recorded (never real) broadcasts. */
function fakeEsplora({ coins = [7000, 10_000, 20_000], confirmed = true, statuses = {}, rate = 2 } = {}) {
  const utxos = coins.map((value, i) => ({ txid: txid(), vout: i % 3, value, status: { confirmed: Array.isArray(confirmed) ? confirmed[i] : confirmed } }));
  const e = {
    utxoRows: utxos, broadcasts: [], asked: [],
    tipHeight: async () => TIP,
    utxos: async (address) => (e.asked.push(address), address === OLD ? utxos : []),
    feeRate: async () => rate,
    txStatus: async (t) => {
      const s = statuses[t];
      if (s instanceof Error) throw s;
      return s ?? { confirmed: false };
    },
    broadcast: async (raw) => (e.broadcasts.push(raw), btc.Transaction.fromRaw(Buffer.from(raw, "hex")).id),
  };
  return e;
}
const carrier = (over) => ({ id: id("c3"), status: "broadcast", anchor: TIP - 10, txid: txid(), nullifiers: [], ...over });
const stateWith = (...items) => ({ version: 1, items: Object.fromEntries(items.map((x) => [x.id, x])) });
const quiet = () => {};

test("retire-free refuses while a v1 carrier may still land: unconfirmed, or unknown to the explorer, inside its anchor window", async () => {
  const pending = carrier();
  const e = fakeEsplora();
  await assert.rejects(retireFree({ key: KEY, state: stateWith(pending), esplora: e, to: OPERATOR, print: quiet }), (err) => {
    assert.match(err.message, /^refusing to sweep: 1 v1 carrier\(s\) may still land/);
    assert.ok(err.message.includes(pending.txid));
    assert.ok(err.message.includes(`may land until block ${TIP - 10 + ANCHOR_WINDOW}`));
    return true;
  });
  const unknown = carrier({ status: "signing" });
  const e2 = fakeEsplora({ statuses: { [unknown.txid]: new Error("GET /tx: 404") } });
  await assert.rejects(retireFree({ key: KEY, state: stateWith(unknown), esplora: e2, to: OPERATOR, print: quiet }), /unknown to the explorer/);
  // The last block it could land in is the next one.
  const edge = carrier({ anchor: TIP + 1 - ANCHOR_WINDOW });
  await assert.rejects(retireFree({ key: KEY, state: stateWith(edge), esplora: fakeEsplora(), to: OPERATOR, print: quiet }), /may still land/);
  for (const x of [e, e2]) assert.deepEqual([x.broadcasts, x.asked], [[], []], "not even the coins were fetched");
});

test("retire-free goes ahead once every v1 carrier is final: confirmed, past its window, or never signed", async () => {
  const done = carrier({ txid: txid() });
  const old = carrier({ id: id("d4"), anchor: TIP - ANCHOR_WINDOW });
  const queued = { id: id("b2"), status: "queued", anchor: TIP - 1, nullifiers: [] }; // never broadcast: no carrier
  const landed = { id: id("a1"), status: "accepted", anchor: TIP - 5, txid: txid(), nullifiers: [] };
  const e = fakeEsplora({ statuses: { [done.txid]: { confirmed: true, block_height: TIP - 2 } } });
  const out = await retireFree({ key: KEY, state: stateWith(done, old, queued, landed), esplora: e, to: OPERATOR, print: quiet });
  assert.equal(out.status, "broadcast");
  assert.equal(e.broadcasts.length, 1);
});

test("retire-free sweeps every coin to the operator's address in one transaction paid from that balance", async () => {
  const e = fakeEsplora({ coins: [7000, 10_000, 20_000], rate: 2 });
  const lines = [];
  const out = await retireFree({ key: KEY, state: stateWith(), esplora: e, to: OPERATOR, print: (l) => lines.push(l) });
  assert.equal(e.broadcasts.length, 1);
  const tx = btc.Transaction.fromRaw(Buffer.from(e.broadcasts[0], "hex"));
  assert.equal(out.txid, tx.id);
  assert.equal(tx.inputsLength, 3, "every coin");
  const spent = new Set(Array.from({ length: tx.inputsLength }, (_, i) => `${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`));
  assert.deepEqual(spent, new Set(e.utxoRows.map((u) => `${u.txid}:${u.vout}`)));
  for (let i = 0; i < tx.inputsLength; i++) assert.equal(tx.getInput(i).sequence, 0xfffffffd, "RBF, so the operator can bump it");
  assert.equal(tx.outputsLength, 1, "one output, no change");
  const o = tx.getOutput(0);
  assert.equal(btc.Address(btc.TEST_NETWORK).encode(btc.OutScript.decode(o.script)), OPERATOR);
  assert.equal(Number(o.amount) + out.fee, 37_000, "the fee comes out of the swept balance, nothing else");
  assert.ok(out.fee >= 2 * tx.vsize, "at least the asked fee rate");
  assert.ok(out.fee <= 2 * tx.vsize + 4, "and not more than rounding");
  assert.deepEqual([out.inputs, out.total, out.amount], [3, 37_000, Number(o.amount)]);
  assert.ok(lines.some((l) => l.startsWith(`sweep broadcast: ${tx.id}`)));
  assert.ok(lines.some((l) => /Nothing was archived/.test(l)), "it archives nothing");
});

test("retire-free --dry-run signs and prints the sweep but broadcasts nothing", async () => {
  const e = fakeEsplora({ coins: [5000, 6000] });
  const lines = [];
  const out = await retireFree({ key: KEY, state: stateWith(), esplora: e, to: OPERATOR, dryRun: true, print: (l) => lines.push(l) });
  assert.equal(out.status, "dry-run");
  assert.deepEqual(e.broadcasts, []);
  assert.equal(btc.Transaction.fromRaw(Buffer.from(out.hex, "hex")).id, out.txid);
  assert.ok(lines.some((l) => l.startsWith(`dry run, nothing broadcast: ${out.txid}`)));
});

test("retire-free refuses a bad or own --to, an empty key, unconfirmed coins and dust", async () => {
  const e = fakeEsplora();
  await assert.rejects(retireFree({ key: KEY, state: stateWith(), esplora: e, to: undefined, print: quiet }), /--to <address> is required/);
  await assert.rejects(retireFree({ key: KEY, state: stateWith(), esplora: e, to: "bc1qnotsignet", print: quiet }), /is not a signet Bitcoin address/);
  await assert.rejects(retireFree({ key: KEY, state: stateWith(), esplora: e, to: OLD, print: quiet }), /old relayer's own address/);
  await assert.rejects(retireFree({ key: KEY, state: stateWith(), esplora: fakeEsplora({ coins: [] }), to: OPERATOR, print: quiet }), /holds no coins; nothing to sweep/);
  await assert.rejects(retireFree({ key: KEY, state: stateWith(), esplora: fakeEsplora({ coins: [9000, 9000], confirmed: [true, false] }), to: OPERATOR, print: quiet }), /1 coin\(s\) of .* are unconfirmed/);
  assert.throws(() => planSweep({ key: KEY, utxos: [{ txid: txid(), vout: 0, value: 400 }], to: OPERATOR, feeRate: 1 }), /too little to sweep/);
  assert.deepEqual(e.broadcasts, []);
});

/** A local Esplora for the CLI process: the old key's coins, fees, and recorded broadcasts. */
async function esploraServer({ coins, statuses = {} }) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    seen.push(`${req.method} ${p}`);
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    let m;
    if (p === "/api/blocks/tip/height") return reply(200, String(TIP));
    if (p === `/api/address/${OLD}/utxo`) return reply(200, coins);
    if (p === "/api/v1/fees/recommended") return reply(200, { halfHourFee: 1 });
    if ((m = p.match(/^\/api\/tx\/([0-9a-f]{64})\/status$/))) return reply(200, statuses[m[1]] ?? { confirmed: false });
    if (p === "/api/tx" && req.method === "POST") return reply(500, "this test never broadcasts");
    return reply(404, "not found");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, seen, base: `http://127.0.0.1:${server.address().port}` };
}

test("the command: relayer retire-free --dry-run against a local esplora; a pending v1 carrier is refused; bad usage exits 1", { timeout: 60_000 }, async () => {
  const data = mkdtempSync(join(DIR, "cli-"));
  writeFileSync(join(data, "relayer.key"), hex(KEY));
  const coins = [{ txid: txid(), vout: 1, value: 12_000, status: { confirmed: true } }, { txid: txid(), vout: 0, value: 25_000, status: { confirmed: true } }];
  const pending = carrier();
  const { server, seen, base } = await esploraServer({ coins });
  const run = (args) =>
    new Promise((resolve) => {
      execFile(process.execPath, ["bin/murkle.mjs", ...args], { env: { ...process.env, MURKLE_DATA_DIR: data, MURKLE_ESPLORA: `${base}/api` }, timeout: 60_000 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
      });
    });
  try {
    const keyHash = sha(join(data, "relayer.key"));
    const dry = await run(["relayer", "retire-free", "--to", OPERATOR, "--dry-run"]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, new RegExp(`^old relayer ${OLD}: 2 coin\\(s\\), 37000 sats at block ${TIP}$`, "m"));
    assert.match(dry.stdout, new RegExp(`^sweep to ${OPERATOR}: \\d+ sats, fee \\d+ sats`, "m"));
    assert.match(dry.stdout, /^dry run, nothing broadcast: [0-9a-f]{64}$/m);
    assert.ok(!seen.some((s) => s.startsWith("POST")), "nothing broadcast");

    // A mistyped --dry-run is refused before the key is read or the explorer is asked.
    for (const typo of [["--dryrun"], ["--dry_run"], ["--dry-run=yes"], ["--dry-run", "please"]]) {
      const asked = seen.length;
      const r = await run(["relayer", "retire-free", "--to", OPERATOR, ...typo]);
      assert.equal(r.code, 1, typo.join(" "));
      assert.match(r.stderr, /^error: (unknown flag --dry(run|_run)|--dry-run takes no value|unexpected argument "please")\. usage: murkle relayer retire-free --to <address> \[--dry-run\]/, typo.join(" "));
      assert.equal(seen.length, asked, `${typo.join(" ")}: no request at all`);
    }

    writeFileSync(join(data, "relayer.json"), JSON.stringify(stateWith(pending)));
    const refused = await run(["relayer", "retire-free", "--to", OPERATOR]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /^error: refusing to sweep: 1 v1 carrier\(s\) may still land/);
    assert.ok(!seen.some((s) => s.startsWith("POST")), "still nothing broadcast");

    const usage = await run(["relayer", "retire-free"]);
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /usage: murkle relayer retire-free --to <address> \[--dry-run\]/);
    assert.equal(sha(join(data, "relayer.key")), keyHash, "the key file stays where it is: nothing is archived");
    assert.ok(existsSync(join(data, "relayer.json")));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("retire-free takes only --to, --dry-run and --fee-rate, strictly", () => {
  assert.deepEqual(parseRetireFlags(["--to", OPERATOR, "--dry-run"]), { to: OPERATOR, dryRun: true, feeRate: null });
  assert.deepEqual(parseRetireFlags([`--to=${OPERATOR}`, "--fee-rate=3"]), { to: OPERATOR, dryRun: false, feeRate: 3 });
  assert.deepEqual(parseRetireFlags(["--dry-run", "--fee-rate", "2", "--to", OPERATOR]), { to: OPERATOR, dryRun: true, feeRate: 2 });
  const cases = [
    [["--to", OPERATOR, "--dryrun"], /^unknown flag --dryrun\./],
    [["--to", OPERATOR, "--dry_run"], /^unknown flag --dry_run\./],
    [["--to", OPERATOR, "--dry-run=yes"], /^--dry-run takes no value\./],
    [["--to", OPERATOR, "--dry-run", "now"], /^unexpected argument "now"\./],
    [["--to", OPERATOR, "-n"], /^unexpected argument "-n"\./],
    [["--to", OPERATOR, "--force"], /^unknown flag --force\./],
    [["--to", OPERATOR, "--dry-run", "--dry-run"], /^--dry-run given twice\./],
    [["--to", OPERATOR, "--to", OLD], /^--to given twice\./],
    [["--to", "--dry-run"], /^--to needs a value\./],
    [["--to="], /^--to needs a value\./],
    [["--dry-run"], /^--to <address> is required\./],
    [[], /^--to <address> is required\./],
    [["--to", OPERATOR, "--fee-rate"], /^--fee-rate needs a value\./],
    [["--to", OPERATOR, "--fee-rate", "0"], /^--fee-rate must be a whole number of sat\/vB, at least 1\./],
    [["--to", OPERATOR, "--fee-rate", "1.5"], /^--fee-rate must be a whole number/],
    [["--to", OPERATOR, "--fee-rate", "-1"], /^--fee-rate must be a whole number/],
  ];
  for (const [args, re] of cases) {
    assert.throws(() => parseRetireFlags(args), (e) => re.test(e.message) && e.message.endsWith(RETIRE_USAGE), args.join(" ") || "(no flags)");
  }
  assert.equal(RETIRE_USAGE, "usage: murkle relayer retire-free --to <address> [--dry-run] [--fee-rate <sat/vB>]");
});

/* ---------- murkle pending and retry while relaying is closed ---------- */

test("murkle pending and retry look up a batch entry before its release: no relayer will send it, and the server says dropped", async () => {
  assert.equal(relayOpenAt(relayInfoOff()), false, "a server without a relayer is closed");
  // Like the live v1 item: a 10-hour batch queued at anchor 324,780, release 324,840, tip 324,811.
  const held = { via: "relay", relay: "http://r1", relayId: id("e5"), mode: "batch10", amount: "5", ticker: "GHOST", anchor: 324_780, releaseAt: 324_840, status: "relaying", spends: ["2"] };
  const calls = [];
  const clientFor = (url) => ({ status: async (rid) => (calls.push([url, rid]), { status: "dropped", reason: RETIRED_REASON, anchor: 324_780, deadline: 324_880 }) });
  const out = [];
  const rows = await listPending({ idx: { height: 324_811 }, file: { pending: [held] }, clientFor, print: (l) => out.push(l) });
  assert.deepEqual(calls, [["http://r1", held.relayId]], "looked up although its release block has not come");
  assert.deepEqual(rows.map((r) => r.status), [`dropped (${RETIRED_REASON})`]);
  assert.doesNotMatch(out.join("\n"), /scheduled|goes out after block/);
  calls.length = 0;
  assert.equal(await pickRetry({ file: { pending: [held] }, clientFor, height: 324_811, warn: quiet }), held, "the dropped entry is the one to retry");
  assert.deepEqual(calls, [["http://r1", held.relayId]]);
  // With relaying open (stage 1) the same entry would be scheduled and never looked up.
  calls.length = 0;
  const open = await listPending({ idx: { height: 324_811 }, file: { pending: [held] }, clientFor, print: quiet, open: true });
  assert.deepEqual([open[0].status, calls], ["scheduled, goes out after block 324840", []]);
});

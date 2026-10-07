// CLI relayed sends (batch-contract §6, §8 "cli", with the relay balance amendment of
// relay-balance-contract.md §6): relay flags, relaySend against an in-memory relayer that takes
// relay balances (FakeBalanceRelayer below: it queues, releases and carries envelopes on synthetic
// blocks the way batch-contract §3 describes), batch eligibility, waiting and exit codes, W-1
// locks, retry, the command run as a process against a local mock, help and README. The real
// relayer's own behaviour is tested in test/batch-relayer.test.mjs and
// test/relay-balance-relayer.test.mjs; signing against the real relay-account module in
// test/relay-balance-cli.test.mjs. Nothing touches a real network or wallet and nothing is
// broadcast; temporary files only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { deriveKeys, encodeAddress } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { ATTEST_KIND, decodeEnvelope, encodeAttest, encodeDeploy, opReturnScript } from "../src/envelope.mjs";
import { unhex } from "../src/bytes.mjs";
import { ACTIVATION_HEIGHT, EXPLORER, GENESIS, GENESIS_TXID, MANIFEST_SHA256, PRE_GENESIS } from "../src/params.mjs";
import { EPOCH_BLOCKS, isBatchMode } from "../src/relay-batch.mjs";

const DIR = mkdtempSync(join(tmpdir(), "murkle-batch-cli-"));
// The CLI reads these when it loads: wallets go to a temp dir, and any stray
// chain call would hit a closed local port instead of mempool.space.
process.env.MURKLE_DATA_DIR = DIR;
process.env.MURKLE_ESPLORA = "http://127.0.0.1:9/api";
delete process.env.MURKLE_RELAY_URL;
mkdirSync(join(DIR, "wallets"));
const { DEFAULT_RELAY, HELP, MIX_UNKNOWN, RELAY_OPEN, exitCodeFor, keepPending, listPending, parseRelayFlags, pickRetry, relaySend, relayUnavailable, waitForRelay } = await import("../bin/murkle.mjs");

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const START = ACTIVATION_HEIGHT ?? 324592;
const RELAY_URL = "http://relay.test";
const NOW = 1_790_000_000_000;
const hash32 = () => randomBytes(32).toString("hex");
const servers = [];

after(async () => {
  servers.forEach((s) => s.close());
  rmSync(DIR, { recursive: true, force: true });
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

/**
 * The parts of the relay-account module (contract §1) relaySend calls, as plain fakes: the
 * signature here is a placeholder that FakeBalanceRelayer checks by shape only. Real signing and
 * verification are tested in test/relay-balance-cli.test.mjs.
 */
const ACCOUNT = { network: "signet", pubHex: "a1".repeat(32), idHex: "b2".repeat(32), id: new Uint8Array(32).fill(0xb2), secret: new Uint8Array(32).fill(7) };
const SIG = "5a".repeat(64);
const lib = {
  RELAY_ENDPOINTS: { account: "/api/relay/account", submit: "/api/relay/submit" },
  parsePoolKey: (k) => k,
  depositAddress: (Q, id, n) => ({ n, address: `tb1p-deposit-${n}` }),
  relayAccount: () => ACCOUNT,
  signRequest: ({ account, fields = {}, now }) => ({ ...fields, accountPub: account.pubHex, t: Math.floor(now() / 1000), sig: SIG }),
};
const PER_SEND = 657;
const BALANCE = 1_000_000;

/**
 * A relayer that takes relay balances, in memory (batch-contract §3 timing, relay-balance-contract
 * §4.2 shapes): info with the published per-epoch snapshot, a signed-shape account read, submit
 * with nullifier dedup and the batch checks of step 6b, a release at the next block (block, fast)
 * or at releaseAt (batch), and carriers that land in the next mined block.
 */
class FakeBalanceRelayer {
  constructor(idx) {
    this.idx = idx;
    this.items = new Map();
    this.pending = new Set(); // nullifiers of items not final yet
    this.mempool = [];
    this.snapshot = { batch: 0, batch10: 0 };
    this.balance = BALANCE;
  }
  epoch(mode, h = this.idx.height) {
    const E = EPOCH_BLOCKS[mode];
    const start = h - (h % E);
    const safety = mode === "batch10" ? 12 : 24;
    return { start, releaseAt: start + E, lastRelease: start + 100 - safety };
  }
  info() {
    const h = this.idx.height;
    const mode = (m) => ({ epochBlocks: EPOCH_BLOCKS[m], maxPerEpoch: m === "batch" ? 40 : 120, safety: m === "batch10" ? 12 : 24, enabled: true, current: { ...this.epoch(m), queued: this.snapshot[m] } });
    return {
      enabled: true, mode: "balance", code: null, reason: null, network: "signet", ops: ["TRANSACT"], address: "tb1pchange", height: h, chainTip: h, pow: null, selfPay: true,
      anchor: { window: 100, safety: 24, minAnchor: h - 76 },
      fees: { feeRate: 1, maxFeeRate: 5, estVsize: 597, carrierFeeSats: 597, maxFeePerTx: 3000 },
      balance: { poolKey: "c3".repeat(32), perSendSats: PER_SEND, batchHeadroom: 2, minDepositSats: 2000, depositConfirmations: 1, sweepCostSats: 288, suggestSends: 10, suggestedTopUpSats: 7000 },
      queue: { queued: 0, max: 120 }, stats: { relayed144: 0, landed144: [] }, defaultMode: "block",
      batch: { perIp: 3, modes: { batch: mode("batch"), batch10: mode("batch10") }, recent: [] },
    };
  }
  account(body) {
    assert.deepEqual(Object.keys(body).sort(), ["accountPub", "sig", "t"]);
    return { status: 200, body: { accountId: ACCOUNT.idHex, balance: this.balance, reserved: 0, nextIndex: 0, depositAddress: "tb1p-deposit-0", credits: [] } };
  }
  submit(body) {
    const err = (status, code, extra = {}) => ({ status, body: { error: { code, message: `${code}.`, ...extra } } });
    if (Object.keys(body).sort().join() !== "accountPub,envelope,mode,sig,t" || body.sig !== SIG || body.accountPub !== ACCOUNT.pubHex) return err(400, "malformed");
    const env = decodeEnvelope(unhex(body.envelope));
    const nullifiers = env.nullifiers.map(String);
    if (nullifiers.some((n) => this.pending.has(n))) return err(409, "nullifier_pending");
    const batch = isBatchMode(body.mode);
    const id = randomBytes(16).toString("hex");
    const item = { id, status: "queued", anchor: env.anchor, deadline: env.anchor + 100, mode: body.mode, nullifiers, envelope: body.envelope };
    let extra = { flush: body.mode === "fast" ? "fast" : "next-block" };
    if (batch) {
      const E = EPOCH_BLOCKS[body.mode];
      if (env.anchor % E !== 0) return err(422, "anchor_not_boundary", { epochBlocks: E });
      const open = this.epoch(body.mode);
      if (this.idx.height >= env.anchor + E) return err(422, "epoch_closed", { mode: body.mode, epochStart: open.start, releaseAt: open.releaseAt });
      const { releaseAt, lastRelease } = this.epoch(body.mode, env.anchor);
      Object.assign(item, { releaseAt, lastRelease });
      extra = { flush: body.mode, mode: body.mode, epochBlocks: E, releaseAt, lastRelease, epochQueued: this.snapshot[body.mode] + 1 };
    }
    const reserved = PER_SEND * (batch ? 2 : 1);
    this.balance -= reserved;
    this.items.set(id, item);
    nullifiers.forEach((n) => this.pending.add(n));
    return { status: 202, body: { id, status: "queued", anchor: item.anchor, deadline: item.deadline, ...extra, reservedSats: reserved, balance: this.balance } };
  }
  status(id) {
    const it = this.items.get(id);
    if (!it) return null;
    const { status, anchor, deadline, mode, releaseAt, lastRelease, txid, height, cost } = it;
    return {
      status, anchor, deadline, ...(releaseAt != null ? { mode, releaseAt, lastRelease } : {}),
      ...(txid ? { txid } : {}), ...(height != null ? { height } : {}), ...(cost != null ? { cost } : {}),
    };
  }
  /** After a block: carriers seen in the log are final; due items go out (into the mempool for the next block). */
  onTick() {
    const h = this.idx.height;
    for (const it of this.items.values()) {
      if (it.status !== "broadcast") continue;
      const l = this.idx.log.find((x) => x.txid === it.txid);
      if (!l) continue;
      Object.assign(it, { status: l.ok ? "accepted" : "rejected", height: l.height });
      it.nullifiers.forEach((n) => this.pending.delete(n));
    }
    for (const it of this.items.values()) {
      if (it.status !== "queued" || (it.releaseAt != null && h < it.releaseAt)) continue;
      const tx = ownCarrier(unhex(it.envelope));
      Object.assign(it, { status: "broadcast", txid: tx.txid, cost: PER_SEND });
      this.mempool.push(tx);
    }
    for (const m of ["batch", "batch10"]) {
      const { start } = this.epoch(m);
      this.snapshot[m] = [...this.items.values()].filter((it) => it.mode === m && it.anchor === start && it.status === "queued").length;
    }
  }
}

// ------------------------------------------------------------------ chain

const idx = new Indexer({ vkey: VKEY, startHeight: START, genesis: GENESIS });
const seeds = { alice: randomBytes(32), dave: randomBytes(32), erin: randomBytes(32) };
const alice = new Wallet(deriveKeys(seeds.alice));
const dave = new Wallet(deriveKeys(seeds.dave));
const erin = new Wallet(deriveKeys(seeds.erin));
const BOB = encodeAddress(deriveKeys(randomBytes(32)));
const ASSET = assetIdOf(START + 1, 1);
let M; // height of Alice's notes: an hourly boundary
const R = new FakeBalanceRelayer(idx);

const coinbase = () => ({ txid: hash32(), inputs: [], outputs: [] });
const ownCarrier = (envelope, first = randomBytes(36)) => ({ txid: hash32(), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(envelope), value: 0n }] });

async function mine(txs = []) {
  const height = idx.height + 1;
  await idx.applyBlock({ height, hash: hash32(), txs: [coinbase(), ...txs] });
  return height;
}
const tick = () => R.onTick();
/** One block that carries whatever the relayer broadcast, then a relayer tick. */
async function step() {
  await mine(R.mempool.splice(0));
  tick();
}
async function mints(wallet, n) {
  const txs = [];
  for (let i = 0; i < n; i++) {
    const bind = randomBytes(36);
    txs.push(ownCarrier(await wallet.mint(idx, { asset: ASSET, mintAmount: 100n, bindOutpoint: bind }), bind));
  }
  return mine(txs);
}

const json = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

/** The relay client over the in-memory relayer; `before(body)` may answer instead of it. */
function inProcess({ before } = {}) {
  const calls = [];
  return {
    calls,
    async info() {
      calls.push("info");
      return json(R.info());
    },
    async state() {
      calls.push("state");
      return { height: idx.height };
    },
    async account(body) {
      calls.push("account");
      return json(R.account(body));
    },
    async submit(body) {
      calls.push("submit");
      const canned = await before?.(body, calls);
      if (canned) return canned;
      return json(R.submit(body));
    },
    async status(id) {
      calls.push("status");
      return json(R.status(id));
    },
  };
}

const walletPath = join(DIR, "wallets", "w.json");
let resyncs = 0;

/** relaySend for Alice (or `wallet`) with captured output and a wallet file on disk. */
async function send({ client, mode, file = { pending: [] }, wallet = alice, amount = "100", to = BOB, ticker = "GHOST", entry, resync }) {
  const out = [];
  const res = await relaySend({
    idx, wallet, file, name: "w", client, mode, url: RELAY_URL, ticker, amount, to, entry, lib, account: ACCOUNT,
    print: (s) => out.push(s), warn: (s) => out.push(`warn: ${s}`), now: () => NOW,
    save: () => writeFileSync(walletPath, JSON.stringify(file)),
    resync: resync ?? (async () => (resyncs += 1)),
    sleep: async () => {},
  });
  return { res, out, file };
}

const lines = (out, prefix) => out.filter((l) => l.startsWith(prefix));
/** The spends an envelope publishes (its other nullifier is a random zero-value padding input). */
const spent = (env, spends) => spends.filter((n) => env.nullifiers.map(String).includes(n));
const etaMin = (blocks) => `about ${Math.max(10, blocks * 10)} min`; // below 6 blocks
const int = (n) => n.toLocaleString("en-US");
/** The relay-balance lines every relayed send prints before it proves (relay-balance-contract §6.1). */
const balanceLines = (mode, balance = R.balance) => [
  `relay balance ${int(balance)} sats available; this send costs about ${PER_SEND} sats${isBatchMode(mode) ? `, and ${int(PER_SEND * 2)} are reserved until its batch goes out (the difference comes back)` : ""}`,
  "the relayer can link the address you top up from to every transfer you relay with this balance; Tor does not prevent this; it cannot see amounts, tokens or recipients",
  // L1: this fake relayer publishes no lineage, so the CLI says the carrier may be tied to the top-up.
  MIX_UNKNOWN,
];
const reservedLine = (mode, after) => `reserved ${int(PER_SEND * (isBatchMode(mode) ? 2 : 1))} sats of your relay balance (${int(after)} still available); the exact fee plus margin is charged when it goes out`;

// ------------------------------------------------------------------ tests

test("parseRelayFlags: URL from the flag, the env or localhost; one timing flag; --relay required; --no-wait and --wait-max", () => {
  const none = () => undefined;
  const p = (args, opts = {}) => parseRelayFlags(args, { read: none, ...opts });
  assert.deepEqual(p(["w", "GHOST", "5", "mrk1x"]), {
    args: ["w", "GHOST", "5", "mrk1x"], relay: false, url: null, urlGiven: false, timing: null, mode: null, wait: true, waitMaxMs: null, linkable: false,
  });
  assert.equal(DEFAULT_RELAY, "http://localhost:8787");
  assert.deepEqual(p(["w", "--relay"]), { args: ["w"], relay: true, url: DEFAULT_RELAY, urlGiven: false, timing: null, mode: "block", wait: true, waitMaxMs: null, linkable: false });
  assert.equal(p(["--relay"], { read: (n) => (n === "RELAY_URL" ? "https://relay.example/" : undefined) }).url, "https://relay.example", "MURKLE_RELAY_URL");
  // Plain http only to a loopback or .onion relayer (audit V2-34).
  process.env.MURKLE_RELAY_URL = "https://10.0.0.5:8787";
  try {
    assert.equal(parseRelayFlags(["--relay"]).url, "https://10.0.0.5:8787", "read from the process env by default");
    assert.equal(parseRelayFlags(["--relay", "http://127.0.0.1:1"]).url, "http://127.0.0.1:1", "an explicit URL wins over the env");
  } finally {
    delete process.env.MURKLE_RELAY_URL;
  }
  const explicit = p(["w", "GHOST", "--relay", "http://127.0.0.1:9000//", "--batch", "5", "mrk1x"]);
  assert.deepEqual(explicit, { args: ["w", "GHOST", "5", "mrk1x"], relay: true, url: "http://127.0.0.1:9000", urlGiven: true, timing: "batch", mode: "batch", wait: true, waitMaxMs: null, linkable: false });
  assert.equal(p(["--relay=https://x.example"]).url, "https://x.example");
  assert.deepEqual(p(["--relay", "w", "GHOST"]).args, ["w", "GHOST"], "a non-URL after --relay stays positional");
  assert.throws(() => p(["--relay=ftp://x"]), /--relay takes an http\(s\) URL/);

  assert.equal(p(["--relay", "--fast"]).mode, "fast");
  assert.equal(p(["--relay", "--batch10"]).mode, "batch10");
  assert.equal(p(["--relay", "--batch", "--batch"]).mode, "batch", "the same flag twice is still one choice");
  for (const two of [["--fast", "--batch"], ["--batch", "--batch10"], ["--fast", "--batch10"]]) {
    assert.throws(() => p(["--relay", ...two]), /^Error: choose one of --fast, --batch, --batch10$/);
  }
  for (const flag of ["--fast", "--batch", "--batch10"]) assert.throws(() => p(["w", flag]), new RegExp(`${flag} needs --relay`));
  assert.throws(() => p(["--relay", "--batch12"]), /unknown flag --batch12/, "the 12-hour batch is retired");
  assert.throws(() => p(["--no-wait"]), /need --relay/);
  assert.throws(() => p(["--wait-max", "5"]), /need --relay/);

  assert.equal(p(["--relay", "--no-wait"]).wait, false);
  assert.equal(p(["--relay", "--wait-max", "2"]).waitMaxMs, 120_000);
  assert.equal(p(["--relay", "--wait-max=0.5"]).waitMaxMs, 30_000);
  for (const bad of [["--wait-max", "0"], ["--wait-max", "-1"], ["--wait-max", "soon"], ["--wait-max"]]) {
    assert.throws(() => p(["--relay", ...bad]), /--wait-max takes a number of minutes above 0/, bad.join(" "));
  }
  assert.throws(() => p(["--relay", "--turbo"]), /unknown flag --turbo/);
  // L1: --linkable consents to a thin-pool send; it needs --relay.
  assert.equal(p(["--relay", "--linkable"]).linkable, true);
  assert.throws(() => p(["w", "--linkable"]), /--linkable needs --relay/);
  assert.throws(() => p(["--relay", "--linkable=yes"]), /unknown flag --linkable=yes/);

  // retry relays without --relay; its timing defaults to the entry's own (timing null).
  assert.deepEqual(p(["w", "--batch10"], { implied: true }), { args: ["w"], relay: true, url: DEFAULT_RELAY, urlGiven: false, timing: "batch10", mode: "batch10", wait: true, waitMaxMs: null, linkable: false });
  assert.equal(p(["w"], { implied: true }).timing, null);
});

test("relayClient: GET info and state, POST submit, account and credit answer { status, body }, status 404 is null, failures are errors", async () => {
  const seen = [];
  const answers = {
    "/api/relay/info": [200, { enabled: true }],
    "/api/state": [200, { height: 7 }],
    "/api/relay/submit": [409, { error: { code: "nullifier_pending", message: "These notes are already in the relay queue." } }],
    "/api/relay/account": [200, { balance: 5 }],
    "/api/relay/credit": [422, { error: { code: "deposit_small", message: "below", minDepositSats: 2000 } }],
    "/api/relay/status/aa": [200, { status: "queued" }],
    "/api/relay/status/gone": [404, { error: { code: "not_found" } }],
    "/api/relay/status/boom": [500, null],
  };
  const fetchFn = async (url, init) => {
    const path = url.slice("http://r.test".length);
    seen.push([init.method ?? "GET", path, init.body ?? null, init.headers?.["content-type"] ?? null, init.signal instanceof AbortSignal]);
    if (path === "/api/relay/status/down") throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    const [status, body] = answers[path];
    return { status, json: async () => (body === null ? Promise.reject(new SyntaxError("no json")) : body) };
  };
  const { relayClient } = await import("../bin/murkle.mjs");
  const c = relayClient("http://r.test", { fetchFn });
  assert.deepEqual(await c.info(), { enabled: true });
  assert.deepEqual(await c.state(), { height: 7 });
  const body = { envelope: "ab", mode: "batch", accountPub: "a1".repeat(32), t: 1, sig: SIG };
  assert.deepEqual(await c.submit(body), { status: 409, body: answers["/api/relay/submit"][1] });
  assert.deepEqual(seen[2], ["POST", "/api/relay/submit", JSON.stringify(body), "application/json", true]);
  const read = { accountPub: "a1".repeat(32), t: 1, sig: SIG };
  assert.deepEqual(await c.account(read), { status: 200, body: { balance: 5 } });
  assert.deepEqual(seen[3], ["POST", "/api/relay/account", JSON.stringify(read), "application/json", true]);
  const credit = { outpoint: `${"ab".repeat(32)}:0`, accountPub: "a1".repeat(32), n: 0 };
  assert.deepEqual(await c.credit(credit), { status: 422, body: answers["/api/relay/credit"][1] });
  assert.deepEqual(seen[4], ["POST", "/api/relay/credit", JSON.stringify(credit), "application/json", true]);
  assert.deepEqual(await c.status("aa"), { status: "queued" });
  assert.equal(await c.status("gone"), null);
  await assert.rejects(c.status("boom"), /HTTP 500/);
  await assert.rejects(c.status("down"), (e) => e.code === "unreachable" && /relayer at http:\/\/r\.test unreachable \(ECONNREFUSED\)/.test(e.message));
  answers["/api/relay/info"] = [503, { error: { code: "busy", message: "The relayer is busy." } }];
  await assert.rejects(c.info(), /HTTP 503 \(The relayer is busy\.\)/);
});

test("exitCodeFor maps every outcome (batch-contract §6.4)", () => {
  const codes = Object.fromEntries(
    ["accepted", "queued", "error", "not_eligible", "refused", "rejected", "expired", "dropped", "missed", "unknown", "timeout", "interrupted", "whatever"].map((s) => [s, exitCodeFor({ status: s })]),
  );
  assert.deepEqual(codes, {
    accepted: 0, queued: 0, error: 1, not_eligible: 3, refused: 4, rejected: 4, expired: 4, dropped: 4, missed: 4, unknown: 4, timeout: 5, interrupted: 130, whatever: 1,
  });
  assert.equal(exitCodeFor(undefined), 1);
});

test("setup: a free token, Alice's notes at an hourly boundary, Erin's one block later, a relayer with relay balances", async () => {
  const genesis = GENESIS
    ? [{ txid: GENESIS_TXID, inputs: [], outputs: [{ script: opReturnScript(encodeAttest({ kind: ATTEST_KIND.GENESIS, hash: MANIFEST_SHA256 })), value: 0n }] }]
    : [];
  await mine(genesis);
  await mine([ownCarrier(encodeDeploy({ ticker: "GHOST", divisibility: 0, mintAmount: 100n, mintCap: 1000, priceSats: 0n, treasury: new Uint8Array() }))]);
  while ((idx.height + 1) % 6 !== 0) await mine();
  M = await mints(alice, 8);
  assert.equal(M % 6, 0);
  await mints(erin, 2);
  alice.scan(idx);
  assert.equal(alice.balance(ASSET), 800n);
  tick();
  assert.equal(R.info().batch.modes.batch.current.start, M);
});

// Against a server that runs no relay balances (stage 0 or not configured), the command refuses every
// relayed send before syncing, proving, writing or handing anything over (relay-balance-contract §6.1).
test("the command itself: send --relay against a relayer without balances exits 1 with nothing handed over or written; pending still works", { skip: PRE_GENESIS && "the CLI fixtures need a pinned genesis" }, async () => {
  assert.equal(idx.height, M + 1);
  const cliDir = join(DIR, "spawn");
  mkdirSync(join(cliDir, "wallets"), { recursive: true });
  writeFileSync(join(cliDir, "state.json"), JSON.stringify(idx.snapshot()));
  const erinPath = join(cliDir, "wallets", "erin.json");
  writeFileSync(erinPath, JSON.stringify({ seed: seeds.erin.toString("hex"), btcKey: hash32(), pending: [] }));

  const seen = [];
  // GET /api/relay/info of a server without a relayer (server/retired-relay.mjs relayInfoOff).
  const off = { enabled: false, mode: null, code: "disabled", reason: "no relayer runs on this server", network: "signet", ops: [], address: null, pow: null, selfPay: true, balance: null, batch: null, docs: "docs/design/relay-balance.md" };
  const server = createServer(async (req, res) => {
    const p = new URL(req.url, "http://x").pathname;
    seen.push(`${req.method} ${p}`);
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": typeof body === "string" ? "text/plain" : "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    let m;
    if (p === "/api/blocks/tip/height") return reply(200, String(idx.height));
    if ((m = p.match(/^\/api\/block-height\/(\d+)$/))) return idx.hashes.has(Number(m[1])) ? reply(200, idx.hashes.get(Number(m[1]))) : reply(404, "not found");
    if (p === "/relay/api/relay/info") return reply(200, off);
    if (p === "/relay/api/state") return reply(200, { height: idx.height });
    if (p.startsWith("/relay/api/relay/status/")) return reply(200, { status: "dropped", reason: "The free relayer was retired. Pay the fee yourself, or copy the envelope." });
    if (p.startsWith("/relay/")) return reply(503, { error: { code: "disabled", message: "No relayer runs on this server." } });
    return reply(503, "unavailable");
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const relay = `${base}/relay`;
  const run = (args, env = {}) =>
    new Promise((resolve) => {
      execFile(process.execPath, ["bin/murkle.mjs", ...args], { env: { ...process.env, MURKLE_DATA_DIR: cliDir, MURKLE_ESPLORA: `${base}/api`, MURKLE_HEADERS: "off", ...env }, timeout: 120_000 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
      });
    });

  const help = await run([]);
  assert.equal(help.code, 0);
  assert.equal(help.stdout.trim(), HELP.join("\n"));
  const typo = await run(["send", "erin", "GHOST", "100", BOB, "--relay", "--turbo"]);
  assert.equal(typo.code, 1);
  assert.match(typo.stderr, /error: unknown flag --turbo/);

  assert.equal(RELAY_OPEN, false, "a relayer whose info was not read counts as closed");
  for (const args of [
    ["send", "erin", "GHOST", "100", BOB, "--relay", "--batch"],
    ["send", "erin", "GHOST", "100", BOB, "--relay", relay, "--no-wait"],
    ["send", "erin", "GHOST", "100", BOB, "--relay"],
    ["retry", "erin", "--relay", relay],
  ]) {
    const r = await run(args, { MURKLE_RELAY_URL: relay });
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stderr.trim(), `error: ${relayUnavailable(relay)}`, args.join(" "));
    assert.equal(r.stdout, "", `${args.join(" ")}: nothing proved or printed`);
  }
  assert.match(relayUnavailable(relay), /Nothing was handed over\./);
  assert.doesNotMatch(relayUnavailable(relay), /\bfree\b|sponsor|ticket/i);
  // retry without a URL first looks for an entry to retry; erin has none.
  const none = await run(["retry", "erin"], { MURKLE_RELAY_URL: relay });
  assert.equal(none.code, 1);
  assert.match(none.stderr, /error: no failed relayed transfer to retry in wallet "erin"/);
  assert.deepEqual(JSON.parse(readFileSync(erinPath, "utf8")).pending, [], "nothing written");
  assert.ok(!seen.some((s) => s.startsWith("POST")), "nothing was handed over");
  assert.ok(seen.filter((s) => s.startsWith("GET /relay/")).every((s) => s === "GET /relay/api/relay/info"), "only relay info was asked");

  const listed = await run(["pending", "erin", "--relay", relay]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.deepEqual(JSON.parse(readFileSync(erinPath, "utf8")).pending, [], "still nothing pending");
});

let blockEntry;

// L3: other people's value notes at block h, as an observer counts them: a mint adds one note (its
// padding never counts), a transfer two; Alice's own leaves are left out.
const crowdAt = (h) => {
  const ops = new Map(idx.log.filter((e) => e.ok && e.txid).map((e) => [e.txid, e.opName]));
  const own = new Set(alice.notes.map((n) => n.leafIndex));
  const seen = new Map();
  for (const o of idx.outputs) {
    if (o.height > h) continue;
    const list = seen.get(o.txid) ?? [];
    list.push(o.leafIndex);
    seen.set(o.txid, list);
  }
  let k = 0;
  for (const [txid, leaves] of seen) {
    const ours = leaves.filter((l) => own.has(l)).length;
    if (["MINT", "MINT_SCRIPT", "MINE", "MINE_SCRIPT"].includes(ops.get(txid))) k += ours ? 0 : 1;
    else k += leaves.length - ours;
  }
  return `${k} note${k === 1 ? "" : "s"}`;
};

test("next block: anchored at the lower tip, the entry is on disk before the hand-off, 202 queued", async () => {
  const h = idx.height;
  const bal = R.balance;
  let checked = false;
  const client = inProcess({
    before: (body) => {
      const p = JSON.parse(readFileSync(walletPath, "utf8")).pending.at(-1);
      assert.deepEqual([p.envelope, p.status, p.relayId, body.mode], [body.envelope, "relaying", null, "block"]);
      assert.deepEqual(Object.keys(body).sort(), ["accountPub", "envelope", "mode", "sig", "t"], "a signed request, no proof of work");
      checked = true;
    },
  });
  const { res, out, file } = await send({ client, mode: "block" });
  assert.equal(res.status, "queued");
  assert.equal(exitCodeFor(res), 0);
  assert.ok(checked, "the submit saw the written entry");
  blockEntry = file.pending[0];
  const { envelope, spends, relayId, ...rest } = blockEntry;
  assert.deepEqual(rest, { via: "relay", relay: RELAY_URL, mode: "block", ticker: "GHOST", amount: "100", to: BOB, anchor: h, status: "relaying", createdAt: NOW });
  assert.match(relayId, /^[0-9a-f]{32}$/);
  assert.equal(decodeEnvelope(unhex(envelope)).anchor, h);
  assert.equal(spends.length, 1);
  assert.ok(alice.locked.has(spends[0]));
  assert.deepEqual(JSON.parse(readFileSync(walletPath, "utf8")).pending[0].relayId, relayId, "the relay id is saved");
  assert.deepEqual(out, [
    `relay ${RELAY_URL} (signet), relayer height ${h}`,
    ...balanceLines("block", bal),
    `next block: anchor ${h}, notes reserved until ${h + 100}`,
    // L3: this test chain holds few notes of other people at the anchor.
    `Few transfers to hide among: an observer can likely tell this came from you. ${crowdAt(h)} of other people ${crowdAt(h) === "1 note" ? "is" : "are"} in the pool at block ${h}.`,
    `proving transfer of 100 GHOST against block ${h}…`,
    `proof checked locally against the root at ${h}`,
    `queued for the next block: relay id ${relayId.slice(0, 12)}…`,
    reservedLine("block", bal - PER_SEND),
  ]);
  assert.deepEqual(client.calls, ["info", "account", "submit"]);
  assert.equal(R.status(relayId).status, "queued");
});

test("--batch anchors at S; waitForRelay polls only the height before S+6, then the status until it lands at S+7", async () => {
  const h = idx.height;
  const S = h - (h % 6);
  assert.equal(S, M);
  assert.ok(h > S, "sent mid-batch");
  const bal = R.balance;
  const client = inProcess();
  const { res, out, file } = await send({ client, mode: "batch" });
  assert.equal(res.status, "queued");
  const e = file.pending[0];
  const id = `${e.relayId.slice(0, 12)}…`;
  assert.equal(decodeEnvelope(unhex(e.envelope)).anchor, S);
  assert.deepEqual([e.mode, e.anchor, e.releaseAt, e.lastRelease, e.epochQueued], ["batch", S, S + 6, S + 76, 1]);
  assert.deepEqual(json(R.status(e.relayId)), { status: "queued", anchor: S, deadline: S + 100, mode: "batch", releaseAt: S + 6, lastRelease: S + 76 });
  assert.deepEqual(out, [
    `relay ${RELAY_URL} (signet), relayer height ${h}`,
    ...balanceLines("batch", bal),
    `hourly batch: anchor ${S}, goes out after block ${S + 6}, relayer deadline ${S + 76}, notes reserved until ${S + 100}`,
    `Few transfers to hide among: an observer can likely tell this came from you. ${crowdAt(S)} of other people ${crowdAt(S) === "1 note" ? "is" : "are"} in the pool at block ${S}.`,
    "A batch hides nothing while it holds only your transfer.",
    "the relayer still sees your IP address and when you submitted; anyone can watch its waiting count, which changes once per block, so with few transfers the block you submitted in can be read from it",
    `proving transfer of 100 GHOST against block ${S}…`,
    `proof checked locally against the root at ${S}`,
    `scheduled: relay id ${id}  waiting for this batch: 1 including yours, as of the last block (reported by the relayer)`,
    "few transfers are waiting for this batch; with so few, it hides little",
    reservedLine("batch", bal - 2 * PER_SEND),
  ]);

  client.calls.length = 0;
  const wout = [];
  const sleeps = [];
  let saves = 0;
  const result = await waitForRelay({
    client, entry: e, name: "w", print: (s) => wout.push(s), warn: (s) => wout.push(`warn: ${s}`), save: () => (saves += 1),
    sleep: async (ms) => {
      sleeps.push(ms);
      await step();
    },
  });
  assert.equal(result.status, "accepted");
  assert.equal(exitCodeFor(result), 0);
  const first = client.calls.indexOf("status");
  assert.deepEqual(client.calls.slice(0, first), Array(S + 6 - h + 1).fill("state"), "one height poll per block until S+6");
  assert.ok(client.calls.slice(first).every((c) => c === "status"));
  assert.deepEqual(sleeps, [...Array(S + 6 - h).fill(30_000), 15_000]);
  const { txid } = R.status(e.relayId);
  assert.deepEqual(wout, [
    `waiting for block ${S + 6} (${etaMin(S + 6 - h)}); Ctrl+C stops waiting, the relayer keeps the transfer`,
    ...Array.from({ length: S + 5 - h }, (_, k) => `block ${h + 1 + k} (${S + 5 - h - k} to go)`),
    `released: carrier ${txid}`,
    `  ${EXPLORER}/tx/${txid}`,
    `landed in block ${S + 7}`,
    `charged ${PER_SEND} sats to your relay balance`,
  ]);
  assert.deepEqual([e.txid, e.status, e.height], [txid, "accepted", S + 7]);
  assert.ok(saves >= 2);
  assert.ok(idx.log.some((l) => l.txid === txid && l.ok && l.height === S + 7));
  assert.equal(keepPending([e], idx).length, 0, "landed: the lock ends");
  // The next-block transfer went out with the first block after it was queued.
  assert.equal(R.status(blockEntry.relayId).status, "accepted");
  assert.equal(R.status(blockEntry.relayId).height, M + 3);
});

test("epoch_closed: proved once more at the new boundary with the same spends; the entry follows", async () => {
  while (idx.height % 6 !== 5) await step();
  const S1 = idx.height - 5;
  const S2 = S1 + 6;
  const bodies = [];
  const client = inProcess({
    before: async (body) => {
      bodies.push(body);
      if (bodies.length === 1) await mine(); // block S2 arrives while proving: the batch closes
    },
  });
  const { res, out, file } = await send({ client, mode: "batch" });
  assert.equal(res.status, "queued", out.join("\n"));
  assert.deepEqual(client.calls, ["info", "account", "submit", "info", "submit"], out.join("\n"));
  const [a, b] = bodies.map((x) => decodeEnvelope(unhex(x.envelope)));
  assert.deepEqual([a.anchor, b.anchor], [S1, S2]);
  const e = file.pending[0];
  assert.equal(file.pending.length, 1);
  assert.deepEqual([e.envelope, e.anchor, e.releaseAt, e.lastRelease, e.status], [bodies[1].envelope, S2, S2 + 6, S2 + 76, "relaying"]);
  assert.equal(e.spends.length, 1);
  assert.deepEqual(spent(a, e.spends), e.spends, "same notes, same nullifiers");
  assert.deepEqual(spent(b, e.spends), e.spends);
  assert.equal(R.status(e.relayId).anchor, S2);
  assert.ok(out.includes("the batch closed while proving; proving again for the next batch"));
  assert.deepEqual(lines(out, "proving transfer"), [`proving transfer of 100 GHOST against block ${S1}…`, `proving transfer of 100 GHOST against block ${S2}…`]);
  assert.ok(out.includes(`hourly batch: anchor ${S2}, goes out after block ${S2 + 6}, relayer deadline ${S2 + 76}, notes reserved until ${S2 + 100}`));
});

test("a second epoch_closed fails the entry (exit 4) and keeps its notes locked", async () => {
  const closed = {
    status: 422,
    body: { error: { code: "epoch_closed", message: "This batch closed while your transfer was being proved. Prove it again for the next batch.", mode: "batch", epochStart: 1, releaseAt: 7 } },
  };
  const client = inProcess({ before: () => closed });
  const { res, out, file } = await send({ client, mode: "batch" });
  assert.equal(res.status, "refused");
  assert.equal(exitCodeFor(res), 4);
  assert.deepEqual(client.calls, ["info", "account", "submit", "info", "submit"]);
  const e = file.pending[0];
  assert.deepEqual([e.status, e.error, e.relayId], ["failed", "epoch_closed", null]);
  assert.equal(
    out.at(-1),
    `relay failed: epoch_closed (This batch closed while your transfer was being proved. Prove it again for the next batch.); notes stay reserved until block ${e.anchor + 100} unless it lands: murkle retry w`,
  );
  assert.deepEqual(JSON.parse(readFileSync(walletPath, "utf8")).pending[0].status, "failed");
  assert.ok(e.spends.every((n) => alice.locked.has(n)));
  assert.deepEqual(keepPending([e], idx), [e], "W-1: failed is not landed");
  assert.ok(alice.spendable(ASSET).every((n) => !e.spends.includes(String(n.nullifier))), "the note can't be picked again");
});

test("the hand-off waits out busy up to three times, each time with a freshly signed request; other refusals fail it (exit 4)", async () => {
  const busy = { status: 503, body: { error: { code: "busy", message: "The relayer is busy." } } };
  const bodies = [];
  let t = NOW;
  const client = inProcess({ before: (body) => (bodies.push(body), bodies.length <= 3 ? busy : null) });
  const out = [];
  const res = await relaySend({
    idx, wallet: alice, file: { pending: [] }, name: "w", client, mode: "block", url: RELAY_URL, ticker: "GHOST", amount: "100", to: BOB, lib, account: ACCOUNT,
    print: (s) => out.push(s), warn: (s) => out.push(`warn: ${s}`), now: () => (t += 5000), save: () => {}, resync: async () => {}, sleep: async () => {},
  });
  assert.equal(res.status, "queued", out.join("\n"));
  assert.deepEqual(client.calls, ["info", "account", "submit", "submit", "submit", "submit"]);
  assert.equal(new Set(bodies.map((b) => b.t)).size, 4, "each attempt is signed with its own time");
  assert.ok(bodies.every((b) => !("pow" in b)));
  assert.equal(lines(out, "warn: the relayer is busy").length, 3);
  assert.ok(!out.some((l) => /anti-spam|proof of work/i.test(l)));

  for (const [status, code] of [[503, "busy"], [409, "replayed"], [401, "stale_request"], [402, "balance_low"], [503, "fee_high"]]) {
    const always = inProcess({ before: () => ({ status, body: { error: { code, message: `${code}.` } } }) });
    const r = await send({ client: always, mode: "block" });
    assert.equal(r.res.status, "refused", code);
    assert.equal(r.res.code, code);
    assert.equal(exitCodeFor(r.res), 4, code);
    assert.equal(always.calls.filter((c) => c === "submit").length, code === "busy" ? 4 : 1, `${code}: retried only while busy`);
    assert.match(r.out.at(-1), new RegExp(`^relay failed: ${code} \\(${code}\\.\\); notes stay reserved until block \\d+ unless it lands: murkle retry w${code === "balance_low" ? "; to top up: murkle relay topup w, or send without --relay" : ""}$`));
    r.file.pending[0].spends.forEach((n) => alice.locked.delete(String(n))); // this test's entries are thrown away
  }
});

test("not in this batch: a note newer than S exits 3 with no submit and no entry; next block would take it", async () => {
  while ((idx.height + 1) % 6 === 0) await step();
  const h = await mints(dave, 1);
  await tick();
  const S = h - (h % 6);
  assert.ok(h > S);
  dave.scan(idx);
  let saves = 0;
  for (const mode of ["batch", "batch10"]) {
    const client = inProcess();
    const file = { pending: [] };
    const out = [];
    const res = await relaySend({
      idx, wallet: dave, file, name: "d", client, mode, url: RELAY_URL, ticker: "GHOST", amount: "100", to: BOB, lib, account: ACCOUNT,
      print: (s) => out.push(s), save: () => (saves += 1), resync: async () => {},
    });
    const E = mode === "batch" ? 6 : 60;
    const start = h - (h % E);
    // A 10-hour batch that starts before activation waits for the first boundary after it.
    const early = start < START - 1;
    const eligibleAt = early ? Math.ceil(START / E) * E : start + E;
    assert.deepEqual(res, { status: "not_eligible", mode, start, eligibleAt });
    assert.equal(exitCodeFor(res), 3);
    assert.deepEqual(client.calls, ["info", "account"], "the balance is read, nothing is submitted");
    assert.deepEqual(file.pending, []);
    const why = early ? `the pool started after block ${start}` : `the note this send needs arrived after block ${start}`;
    const wait = eligibleAt - h;
    const etaText = wait * 10 < 60 ? etaMin(wait) : wait * 10 < 48 * 60 ? `about ${Math.round(wait / 6)} h` : `about ${Math.round(wait / 144)} d`;
    assert.equal(out.at(-1), `not in this batch: ${why}; it can join the batch that starts at block ${eligibleAt} (${etaText}), or send without --${mode} now`);
  }
  assert.equal(saves, 0);
  assert.equal(dave.locked.size, 0);
  assert.doesNotThrow(() => dave.selectNotes(ASSET, 100n), "without a batch bound the note is spendable");
});

test("the batch that starts before activation: eligible from the first boundary after it", async () => {
  const small = new Indexer({ vkey: VKEY, startHeight: 75 });
  await small.applyBlock({ height: 75, hash: hash32(), txs: [coinbase(), ownCarrier(encodeDeploy({ ticker: "EDGE", divisibility: 0, mintAmount: 1n, mintCap: 1, priceSats: 0n, treasury: new Uint8Array() }))] });
  for (let h = 76; h <= 80; h++) await small.applyBlock({ height: h, hash: hash32(), txs: [coinbase()] });
  const client = {
    calls: [],
    info: async () => ({ ...json(R.info()), height: 80, batch: null }),
    account: async (body) => json(R.account(body)),
  };
  const args = { idx: small, wallet: new Wallet(deriveKeys(randomBytes(32))).scan(small), file: { pending: [] }, name: "x", client, url: RELAY_URL, ticker: "EDGE", amount: "1", to: BOB, print: () => {}, resync: async () => {}, lib, account: ACCOUNT };
  assert.deepEqual(await relaySend({ ...args, mode: "batch10" }), { status: "not_eligible", mode: "batch10", start: 60, eligibleAt: 120 });
  await assert.rejects(relaySend({ ...args, mode: "batch12" }), /unknown relay timing "batch12"/, "the retired id is not a timing");
  await assert.rejects(relaySend({ ...args, mode: "batch" }), /insufficient balance/, "the hourly batch at 78 is past activation: note selection runs");
});

test("a local index behind the relayer's batch start syncs once more, then refuses before proving", async () => {
  const ahead = idx.height + 7;
  const client = {
    calls: [],
    async info() {
      return { ...json(R.info()), height: ahead };
    },
    async account(body) {
      return json(R.account(body));
    },
    async submit() {
      this.calls.push("submit");
    },
  };
  const before = resyncs;
  const file = { pending: [] };
  await assert.rejects(send({ client, mode: "batch", file }), new RegExp(`^Error: local index is behind the relayer \\(local ${idx.height}, relayer ${ahead}\\); run sync$`));
  assert.equal(resyncs, before + 1, "one more sync first");
  assert.deepEqual(client.calls, []);
  assert.deepEqual(file.pending, []);
});

test("relay info that already refuses this timing stops before proving (exit 1, nothing written)", async () => {
  const off = (patch) => ({
    calls: [],
    async info() {
      const info = json(R.info());
      patch(info);
      return info;
    },
    async account(body) {
      this.calls.push("account");
      return json(R.account(body));
    },
  });
  const file = { pending: [] };
  await assert.rejects(send({ client: off((i) => (i.batch.modes.batch10.maxPerEpoch = 0)), mode: "batch10", file }), /not taking 10-hour batch transfers right now \(batch_disabled\)/);
  await assert.rejects(send({ client: off((i) => (i.batch.modes.batch.current.queued = i.batch.modes.batch.maxPerEpoch)), mode: "batch", file }), /\(batch_full\)/);
  await assert.rejects(send({ client: off((i) => (i.code = "halted")), mode: "batch", file }), /\(halted\); nothing was sent; send without --relay to pay the fee from this wallet's BTC fee key/);
  await assert.rejects(send({ client: off((i) => (i.code = "fee_high")), mode: "fast", file }), /not taking fast transfers right now \(fee_high\)/, "above the cap Fast is refused, never held");
  await assert.rejects(send({ client: off((i) => (i.code = "block_full")), mode: "block", file }), /\(block_full\)/);
  await assert.rejects(send({ client: off((i) => (i.enabled = false)), mode: "block", file }), /relaying is unavailable at http:\/\/relay\.test: no relayer with relay balances runs there/);
  await assert.rejects(send({ client: off((i) => (i.mode = null)), mode: "block", file }), /relaying is unavailable/);
  await assert.rejects(send({ client: off((i) => (i.network = "mainnet")), mode: "block", file }), /runs on mainnet, not signet/);
  assert.deepEqual(file.pending, []);
});

test("--batch and --batch10 at a 60-boundary share the anchor S: hourly lands at S+7, 10-hour at S+61; --wait-max exits 5", async () => {
  while (idx.height % 60 !== 1) await step();
  const S = idx.height - 1;
  const hourly = await send({ client: inProcess(), mode: "batch" });
  const client = inProcess();
  const ten = await send({ client, mode: "batch10" });
  const [h6, h60] = [hourly.file.pending[0], ten.file.pending[0]];
  assert.deepEqual([h6.anchor, h6.releaseAt, h6.lastRelease], [S, S + 6, S + 76]);
  assert.deepEqual([h60.anchor, h60.releaseAt, h60.lastRelease, h60.mode], [S, S + 60, S + 88, "batch10"]);
  assert.equal(decodeEnvelope(unhex(h60.envelope)).anchor, S);
  assert.ok(ten.out.includes(`10-hour batch: anchor ${S}, goes out after block ${S + 60}, relayer deadline ${S + 88}, notes reserved until ${S + 100}`));
  assert.ok(ten.out.includes(`a 10-hour batch is a separate crowd: it lands at block ${S + 61}, while hourly transfers anchored at block ${S} land at block ${S + 7}, so it only hides among other 10-hour transfers`));
  assert.ok(ten.out.includes(`scheduled: relay id ${h60.relayId.slice(0, 12)}…  waiting for this batch: 1 including yours, as of the last block (reported by the relayer)`));

  // --wait-max: the clock runs, the chain does not.
  let clock = 0;
  const tout = [];
  client.calls.length = 0;
  const stopped = await waitForRelay({ client, entry: h60, name: "w", print: (s) => tout.push(s), sleep: async (ms) => (clock += ms), now: () => clock, waitMaxMs: 60_000 });
  assert.equal(stopped.status, "timeout");
  assert.equal(exitCodeFor(stopped), 5);
  assert.ok(client.calls.every((c) => c === "state"), "no status call before releaseAt");
  assert.equal(tout.at(-1), `stopped waiting after 1 min; the relayer still holds it (relay id ${h60.relayId.slice(0, 12)}…); check later with: murkle pending w`);

  client.calls.length = 0;
  const result = await waitForRelay({ client, entry: h60, name: "w", print: () => {}, sleep: step });
  assert.equal(result.status, "accepted");
  assert.equal(result.height, S + 61);
  const first = client.calls.indexOf("status");
  assert.equal(first, 60, "heights S+1 .. S+60");
  assert.ok(client.calls.slice(first).every((c) => c === "status"));
  assert.deepEqual([R.status(h6.relayId).status, R.status(h6.relayId).height], ["accepted", S + 7]);
});

test("waitForRelay: dropped and rejected exit 4, an id the relayer forgot exits 4, Ctrl+C exits 130, a new carrier and errors are reported", async () => {
  const entryOf = (mode = "block") => ({ via: "relay", relayId: "ab".repeat(16), mode, anchor: 1000, spends: ["1"], status: "relaying", ...(mode === "batch" ? { releaseAt: 1006 } : {}) });
  const scripted = (seq, states = []) => {
    const calls = [];
    return {
      calls,
      async state() {
        calls.push("state");
        const s = states.shift();
        if (s instanceof Error) throw s;
        return { height: s };
      },
      async status() {
        calls.push("status");
        const s = seq.shift();
        if (s instanceof Error) throw s;
        return s;
      },
    };
  };
  const run = async (client, entry, extra = {}) => {
    const out = [];
    const res = await waitForRelay({ client, entry, name: "w", print: (s) => out.push(s), warn: (s) => out.push(`warn: ${s}`), sleep: async () => {}, ...extra });
    return { res, out };
  };
  const id = "abababababab…";
  const failLine = (status, reason) => `relay failed: ${status} (${reason}); notes stay reserved until block 1100 unless it lands: murkle retry w`;

  let e = entryOf();
  let c = scripted([{ status: "queued" }, new Error("relayer at x unreachable (ECONNREFUSED)"), { status: "dropped", reason: "nullifier already spent" }]);
  let r = await run(c, e);
  assert.equal(r.res.status, "dropped");
  assert.equal(exitCodeFor(r.res), 4);
  assert.deepEqual(c.calls, ["status", "status", "status"], "no height polls for next block");
  assert.deepEqual(r.out, [
    "waiting for the carrier; Ctrl+C stops waiting, the relayer keeps the transfer",
    "warn: relayer at x unreachable (ECONNREFUSED); still waiting",
    failLine("dropped", "nullifier already spent"),
  ]);
  assert.deepEqual([e.status, e.error], ["failed", "dropped"]);

  e = entryOf();
  r = await run(scripted([{ status: "broadcast", txid: "11".repeat(32) }, { status: "rejected", txid: "11".repeat(32), height: 1003, reason: "nullifier already spent" }]), e);
  assert.equal(r.res.status, "rejected");
  assert.equal(exitCodeFor(r.res), 4);
  assert.equal(r.out.at(-1), failLine("rejected", "nullifier already spent"));

  e = entryOf();
  r = await run(scripted([{ status: "broadcast", txid: "aa".repeat(32) }, { status: "broadcast", txid: "bb".repeat(32) }, { status: "accepted", txid: "bb".repeat(32), height: 1002 }]), e);
  assert.equal(exitCodeFor(r.res), 0);
  assert.deepEqual(r.out.slice(1), [
    `released: carrier ${"aa".repeat(32)}`, `  ${EXPLORER}/tx/${"aa".repeat(32)}`,
    `new carrier: carrier ${"bb".repeat(32)}`, `  ${EXPLORER}/tx/${"bb".repeat(32)}`,
    "landed in block 1002",
  ]);
  assert.deepEqual([e.txid, e.status, e.height], ["bb".repeat(32), "accepted", 1002]);

  e = entryOf();
  r = await run(scripted([null]), e);
  assert.equal(r.res.status, "unknown");
  assert.equal(exitCodeFor(r.res), 4);
  assert.equal(r.out.at(-1), `relay failed: unknown (the relayer no longer knows relay id ${id}); notes stay reserved until block 1100 unless it lands: murkle retry w`);
  assert.deepEqual([e.status, e.error], ["failed", "unknown"]);

  // Ctrl+C while a batch waits for its release: no status call, the relayer keeps it.
  e = entryOf("batch");
  const ac = new AbortController();
  c = scripted([], [new Error("relayer at x unreachable (ETIMEDOUT)"), 1003]);
  let naps = 0;
  r = await run(c, e, { signal: ac.signal, sleep: async () => ++naps === 2 && ac.abort() });
  assert.equal(r.res.status, "interrupted");
  assert.equal(exitCodeFor(r.res), 130);
  assert.deepEqual(c.calls, ["state", "state"]);
  assert.deepEqual(r.out, [
    "warn: relayer at x unreachable (ETIMEDOUT); still waiting",
    `waiting for block 1006 (${etaMin(3)}); Ctrl+C stops waiting, the relayer keeps the transfer`,
    `stopped waiting; the relayer still holds it (relay id ${id}); check later with: murkle pending w`,
  ]);
  assert.equal(e.status, "relaying", "an interrupted wait changes nothing");
});

test("W-1: a relayed entry without txid stays locked until its spends are spent or anchor + 100 has passed", () => {
  const view = (height, { nullifiers = [], log = [] } = {}) => ({ height, nullifiers: new Set(nullifiers), log });
  const e = { via: "relay", relay: RELAY_URL, relayId: null, mode: "batch10", spends: ["11", "12"], anchor: 480, releaseAt: 540, status: "relaying" };
  assert.deepEqual(keepPending([e], view(580)), [e], "until anchor + 100 inclusive");
  assert.deepEqual(keepPending([e], view(581)), []);
  assert.deepEqual(keepPending([e], view(550, { nullifiers: ["11"] })), [e], "one spend of two is not enough");
  assert.deepEqual(keepPending([e], view(550, { nullifiers: ["12", "11"] })), []);
  assert.deepEqual(keepPending([{ ...e, status: "failed", error: "batch_full" }], view(550)).length, 1, "a refusal does not unlock (the relayer saw the envelope)");
  assert.deepEqual(keepPending([e], view(550, { log: [{ txid: undefined }, { txid: "cc".repeat(32) }] })), [e], "no txid matches no log entry");
  const carried = { ...e, txid: "cc".repeat(32) };
  assert.deepEqual(keepPending([carried], view(550, { log: [{ txid: "cc".repeat(32), ok: true }] })), [], "the carrier has a verdict");
  assert.equal(e.anchorMax, undefined, "relayed entries always have an anchor");
});

test("retry: pickRetry takes the newest failed or forgotten entry; the retry reuses its nullifiers and keeps one entry", async () => {
  const file = { pending: [] };
  const full = { status: 503, body: { error: { code: "batch_full", message: "This batch is full. Send with the next block, or try the next batch.", releaseAt: 1 } } };
  const first = await send({ client: inProcess({ before: () => full }), mode: "batch", file });
  assert.equal(first.res.status, "refused");
  assert.equal(exitCodeFor(first.res), 4);
  const old = { ...file.pending[0] };
  assert.deepEqual([old.status, old.error, old.relayId], ["failed", "batch_full", null]);

  const picked = await pickRetry({ file, clientFor: () => inProcess() });
  assert.equal(picked, file.pending[0]);
  const again = await send({ client: inProcess(), mode: "block", file, entry: picked, ticker: picked.ticker, amount: picked.amount, to: picked.to });
  assert.equal(again.res.status, "queued", again.out.join("\n"));
  assert.equal(file.pending.length, 1);
  const e = file.pending[0];
  assert.equal(e, picked, "updated in place");
  const [a, b] = [old.envelope, e.envelope].map((x) => decodeEnvelope(unhex(x)));
  assert.notEqual(e.envelope, old.envelope);
  assert.deepEqual(e.spends, old.spends);
  assert.deepEqual(spent(a, old.spends), old.spends);
  assert.deepEqual(spent(b, old.spends), old.spends, "the retry publishes the same note nullifiers");
  assert.equal(b.anchor, idx.height);
  assert.deepEqual([e.mode, e.status, e.anchor, e.error, e.reason, e.releaseAt, e.lastRelease], ["block", "relaying", Math.max(old.anchor, b.anchor), undefined, undefined, undefined, undefined]);
  assert.equal(R.status(e.relayId).status, "queued");
  // A second try of the same notes while the first is queued is refused by nullifier.
  const twice = await send({ client: inProcess(), mode: "block", file: { pending: [] }, entry: { ...e }, ticker: e.ticker, amount: e.amount, to: e.to });
  assert.equal(twice.res.code, "nullifier_pending");

  // Which entry is picked: newest first, skipping queued, broadcast and landed ones.
  const status = { q: { status: "queued" }, b: { status: "broadcast", txid: "dd".repeat(32) }, x: { status: "expired" }, d: { status: "dropped" }, r: { status: "rejected" } };
  const clientFor = (url) => ({ status: async (id) => (url === "down" ? Promise.reject(new Error("relayer at down unreachable")) : (status[id] ?? null)) });
  const rows = [
    { via: "relay", relayId: null, status: "failed", n: 0 },
    { via: "relay", relayId: "q", status: "relaying", n: 1 },
    { via: "relay", relayId: "gone", status: "relaying", n: 2 },
    { via: "relay", relayId: "b", status: "relaying", n: 3 },
    { via: "relay", relayId: "x", status: "relaying", n: 4 },
    { txid: "ee".repeat(32), spends: [], anchor: 1, n: 5 },
    { via: "relay", relayId: "z", status: "accepted", n: 6 },
    { via: "relay", relayId: "q", relay: "down", status: "relaying", n: 7 },
  ];
  const warns = [];
  const pick = async (n) => (await pickRetry({ file: { pending: rows.slice(0, n) }, clientFor, warn: (s) => warns.push(s) }))?.n ?? null;
  assert.equal(await pick(8), 4, "expired; a relayer that is down is skipped");
  assert.equal(warns.length, 1);
  assert.equal(await pick(4), 2, "an id the relayer no longer knows");
  assert.equal(await pick(2), 0, "a refused entry, past a queued one");
  assert.equal(await pick(0), null);
  for (const k of ["d", "r"]) assert.equal((await pickRetry({ file: { pending: [{ via: "relay", relayId: k, status: "relaying" }] }, clientFor }))?.relayId, k);
});

test("retry: pickRetry never looks up a batch entry before its releaseAt (the relayer still holds it)", async () => {
  // Stage 1 behaviour (relaying open); while it is closed every entry is looked up (test/paid-relay-stage0.test.mjs).
  const open = true;
  const calls = [];
  const clientFor = (url) => ({ status: async (id) => (calls.push([url, id]), { status: id === "old" ? "expired" : "queued" }) });
  const file = {
    pending: [
      { via: "relay", relay: "http://r1", relayId: "old", mode: "block", anchor: 900, status: "relaying" },
      { via: "relay", relay: "http://r1", relayId: "held", mode: "batch10", anchor: 960, releaseAt: 1020, status: "relaying" },
    ],
  };
  assert.equal((await pickRetry({ file, clientFor, height: 1019, open }))?.relayId, "old");
  assert.deepEqual(calls, [["http://r1", "old"]], "no lookup of the scheduled 10-hour item");
  calls.length = 0;
  assert.equal((await pickRetry({ file, clientFor, open }))?.relayId, "old");
  assert.deepEqual(calls, [["http://r1", "old"]], "height unknown: still no lookup");
  calls.length = 0;
  assert.equal((await pickRetry({ file, clientFor, height: 1020, open }))?.relayId, "old");
  assert.deepEqual(calls, [["http://r1", "held"], ["http://r1", "old"]], "from its releaseAt on, as pending does");
  const cli = readFileSync("bin/murkle.mjs", "utf8");
  assert.match(cli, /pickRetry\(\{ file: ctx\.file, height: ctx\.idx\.height,/, "murkle retry passes the synced height");
});

test("pending: one status call per relayed entry that may have one; none before a batch's releaseAt; a learned txid is saved", async () => {
  // Stage 1 behaviour (relaying open); while it is closed every entry is looked up (test/paid-relay-stage0.test.mjs).
  const open = true;
  const T = "ff".repeat(32);
  const ids = { scheduled: "a1".repeat(16), released: "b2".repeat(16), block: "c3".repeat(16) };
  const pending = [
    { txid: "9".repeat(64), spends: ["1"], anchor: 990 },
    { via: "relay", relay: "http://r1", relayId: ids.scheduled, mode: "batch10", amount: "5", ticker: "GHOST", anchor: 960, releaseAt: 1020, status: "relaying", spends: ["2"] },
    { via: "relay", relay: "http://r1", relayId: ids.released, mode: "batch", amount: "6", ticker: "GHOST", anchor: 990, releaseAt: 996, status: "relaying", spends: ["3"] },
    { via: "relay", relay: "http://r2", relayId: ids.block, mode: "block", amount: "7", ticker: "GHOST", anchor: 999, status: "relaying", spends: ["4"] },
    { via: "relay", relay: "http://r1", relayId: null, mode: "batch", amount: "8", ticker: "GHOST", anchor: 996, releaseAt: 1002, status: "failed", error: "batch_full", spends: ["5"] },
    { via: "relay", relay: "http://r1", relayId: null, mode: "fast", amount: "9", ticker: "GHOST", anchor: 999, status: "relaying", spends: ["6"] },
  ];
  const calls = [];
  const clientFor = (url) => ({
    async status(id) {
      calls.push([url, id]);
      return id === ids.released ? { status: "broadcast", txid: T, anchor: 990 } : null;
    },
  });
  const out = [];
  let saves = 0;
  const rows = await listPending({ idx: { height: 1000 }, file: { pending }, clientFor, print: (s) => out.push(s), save: () => (saves += 1), open });
  assert.deepEqual(calls, [["http://r1", ids.released], ["http://r2", ids.block]]);
  assert.deepEqual(rows.map((r) => r.status), ["self-paid", "scheduled, goes out after block 1020", "broadcast", "unknown to the relayer", "failed (batch_full)", "not handed over"]);
  assert.equal(pending[2].txid, T);
  assert.equal(saves, 1);
  assert.equal(out[0], `self-paid  txid ${"9".repeat(64)}  anchor 990  notes reserved until 1090`);
  assert.equal(out[1], `10-hour batch  5 GHOST  anchor 960  release 1020  relay scheduled, goes out after block 1020  txid —  id ${ids.scheduled.slice(0, 12)}…  notes reserved until 1060`);
  assert.equal(out[2], `hourly batch  6 GHOST  anchor 990  release 996  relay broadcast  txid ${T}  id ${ids.released.slice(0, 12)}…  notes reserved until 1090`);
  const empty = [];
  assert.deepEqual(await listPending({ idx: { height: 1 }, file: { pending: [] }, clientFor, print: (s) => empty.push(s) }), []);
  assert.deepEqual(empty, ["no pending transfers"]);
});

test("a pending entry saved as batch12 (the retired 12-hour batch) lists, is picked for retry and retries with the 10-hour batch", async () => {
  const legacy = { via: "relay", relay: "http://r1", relayId: "d4".repeat(16), mode: "batch12", amount: "5", ticker: "GHOST", anchor: 936, releaseAt: 1008, status: "relaying", spends: ["2"] };
  const calls = [];
  const clientFor = (url) => ({ status: async (id) => (calls.push([url, id]), { status: "expired", reason: "the batch could not be sent before block 1024" }) });
  const out = [];
  const rows = await listPending({ idx: { height: 1000 }, file: { pending: [legacy] }, clientFor, print: (s) => out.push(s) });
  assert.deepEqual(calls, [["http://r1", legacy.relayId]], "no batch of today's: looked up like any relayed entry");
  assert.deepEqual(rows.map((r) => r.status), ["expired (the batch could not be sent before block 1024)"]);
  assert.match(out[0], /^12-hour batch \(retired\)  5 GHOST  anchor 936  release 1008  relay expired/, "a readable name, not the raw id");
  assert.equal(await pickRetry({ file: { pending: [legacy] }, clientFor, height: 1000 }), legacy);
  // murkle retry turns the saved id into today's before relaySend sees it.
  const cli = readFileSync("bin/murkle.mjs", "utf8");
  assert.match(cli, /const mode = f\.timing \?\? savedMode\(entry\.mode\) \?\? "block";/);
});

test("help text and README list the relay commands, flags and variables, in plain words", () => {
  const help = HELP.join("\n");
  for (const s of ["send <w> <ticker> <amount> <mrk1…> --relay [url]", "--fast", "--batch", "--batch10", "--no-wait", "--wait-max <minutes>", "pending <w>", "retry <w>", "relay topup <w>", "relay credit <w>", "relay account <w>", "MURKLE_RELAY_URL", "hourly batch", "10-hour batch", "divisible by 60", "sees your IP address"]) {
    assert.ok(help.includes(s), `help: ${s}`);
  }
  assert.doesNotMatch(help, /batch12|12-hour/);
  const readme = readFileSync("README.md", "utf8");
  const cliSection = readme.slice(readme.indexOf("## CLI"), readme.indexOf("## Reproduce the circuit"));
  for (const s of ["--relay", "--fast", "--batch", "--batch10", "--no-wait", "--wait-max", "pending alice", "retry alice", "relay topup alice", "relay credit alice", "MURKLE_RELAY_URL", "IP address", "separate crowds", "S+60", "S+61", "S+76", "S+88", "can't be cancelled", "missed"]) {
    assert.ok(cliSection.includes(s), `README CLI: ${s}`);
  }
  assert.doesNotMatch(cliSection, /--batch12|S\+7[23]\b/);
  for (const s of ["MURKLE_RELAY_URL", "MURKLE_RELAY_MODE", "MURKLE_MAX_BATCH_PER_EPOCH", "MURKLE_MAX_BATCH10_PER_EPOCH", "MURKLE_BATCH_PER_IP", "MURKLE_BATCH10_SAFETY_BLOCKS", "MURKLE_FANOUT_MIN_CARRIERS", "MURKLE_FANOUT_VALUE", ".relayMode", ".selfMode"]) {
    assert.ok(readme.includes(s), `README: ${s}`);
  }
  const src = readFileSync("bin/murkle.mjs", "utf8");
  // The relayer's API field balance.mix (L1, relay-balance contract) is a field name, not wording.
  const relayCode = src.slice(src.indexOf("relayed sends (batch-contract"), src.indexOf("const commands = {")).replace(/\bbalance\??\.mix\b/g, "balance.cover");
  for (const [where, text] of [["help", help], ["README CLI", cliSection], ["CLI relay code", relayCode]]) {
    assert.doesNotMatch(text, /level 2|mixer|\bmix(es|ed|ing)?\b|blend|ghost mode|anonymous|untraceable|\d\s*%|\d+\s+(users|people)\b|ticket|anti-spam/i, where);
  }
  const bytes = readFileSync("bin/murkle.mjs");
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) bytes[i - 1] === 13 ? crlf++ : lf++;
  assert.deepEqual({ lf, crlfAtLeast: crlf > 500 }, { lf: 0, crlfAtLeast: true }, "bin/murkle.mjs keeps CRLF");
});

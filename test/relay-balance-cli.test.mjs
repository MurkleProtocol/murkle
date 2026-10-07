// Relay balances in the CLI and the docs (docs/design/relay-balance-contract.md §6 and §8 "cli-docs"):
// - relayOpenAt, and `send --relay` / `retry --relay <url>` as real processes against a relayer that
//   runs no relay balances (stage-0 info, or nothing listening): exit 1, nothing handed over or written;
// - `relay account`, `relay topup` and `relay credit` against an injected relayer and explorer: the
//   output lines, every exit code (0, 1, 4, 6), and `relay.depositIndex` moving only after a payment
//   is seen or made;
// - relaySend: a short balance stops before proving, a 402 after hand-out exits 4, the submit body is
//   a signed request that verifyRequest accepts (no proof-of-work field), `missed` exits 4;
// - `relay topup --pay --dry-run` builds a plain payment to the deposit address and broadcasts nothing;
// - HELP, the source and the docs: the new commands are listed, nothing funds the relayer, every
//   relayer variable is in the README, the design docs carry their amendments, no "ticket" wording.
// The shared module (src/relay-account.mjs) and planPayment (src/btc/funding.mjs) are shared
// modules; if they are missing this file uses a stub written from the contract (§1, §1b).
// Fakes, temporary files and port 0 only: nothing touches data/signet/ or a real network, nothing is broadcast.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import { deriveKeys, encodeAddress } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { ATTEST_KIND, encodeAttest, encodeDeploy, opReturnScript } from "../src/envelope.mjs";
import * as funding from "../src/btc/funding.mjs";
import { btcAccount, dustLimit } from "../src/btc/funding.mjs";
import { hex, unhex } from "../src/bytes.mjs";
import { ACTIVATION_HEIGHT, GENESIS, GENESIS_TXID, MANIFEST_SHA256 } from "../src/params.mjs";

const DIR = mkdtempSync(join(tmpdir(), "murkle-relay-balance-cli-"));
// The CLI reads these when it loads: wallets go to a temp dir, and any stray chain call would hit
// a closed local port instead of mempool.space.
process.env.MURKLE_DATA_DIR = DIR;
process.env.MURKLE_ESPLORA = "http://127.0.0.1:9/api";
delete process.env.MURKLE_RELAY_URL;
mkdirSync(join(DIR, "wallets"));
const CLI = await import("../bin/murkle.mjs");
const {
  BATCH_ALONE, CROWD_FEW, HELP, LINKABLE_LINE, POOL_THIN, RECENT_DEPOSIT, RELAY_USAGE, exitCodeFor, depositIndexOf, parseRelayCommand, pendingOf, recentDepositWarning, relayAccountCommand,
  relayAccountOf, relayCreditCommand, relayOpenAt, relaySend, relayTopUpCommand, relayUnavailable, waitForRelay,
} = CLI;

const servers = [];
after(async () => {
  servers.forEach((s) => s.close());
  rmSync(DIR, { recursive: true, force: true });
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const NOW = 1_790_000_000_000;
const now = () => NOW;
const hash32 = () => randomBytes(32).toString("hex");
const URL_ = "http://relay.test";

/* ---------------------------------------------------------------- the shared module, or a contract stub */

/**
 * src/relay-account.mjs as the contract (§1) specifies it, for as long as the shared
 * module is not in the checkout. Only what the CLI and these tests use.
 */
function contractStub() {
  const N = secp256k1.CURVE.n;
  const enc = new TextEncoder();
  const fail = (code) => Object.assign(new Error(code), { code });
  const isHex = (s, n) => typeof s === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
  const xonly = (bytes) => {
    if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw fail("malformed");
    schnorr.utils.lift_x(schnorr.utils.bytesToNumberBE(bytes));
    return bytes;
  };
  const cat = (...parts) => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) out.set(p, (o += p.length) - p.length);
    return out;
  };
  const u32be = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const lp = (s) => cat(new Uint8Array([enc.encode(s).length]), enc.encode(s));
  const netOf = (network) => {
    if (network === "mainnet") return btc.NETWORK;
    if (network === "signet" || network === "testnet") return btc.TEST_NETWORK;
    throw fail("bad_network");
  };
  const lib = {
    RELAY_SIGN_TAG: "murkle/relay/v1",
    DEPOSIT_TAG: "murkle/relay-deposit/v1",
    MAX_DEPOSIT_INDEX: 2 ** 31 - 1,
    MAX_SKEW_SEC: 600,
    RELAY_ENDPOINTS: Object.freeze({ account: "/api/relay/account", submit: "/api/relay/submit" }),
    accountLabel: (network) => `murkle/relay-account/v1/${network}`,
    relayAccount(seed, network = "signet") {
      const secret = hkdf(sha256, seed, undefined, lib.accountLabel(network), 32);
      const pub = schnorr.getPublicKey(secret);
      const id = sha256(pub);
      return { network, secret, pub, pubHex: hex(pub), id, idHex: hex(id) };
    },
    parseAccountPub(text) {
      if (!isHex(text, 64)) throw fail("malformed");
      return xonly(unhex(text));
    },
    parsePoolKey: (k) => xonly(typeof k === "string" ? (isHex(k, 64) ? unhex(k) : new Uint8Array()) : k),
    depositTweak(Q, id, n) {
      if (!Number.isSafeInteger(n) || n < 0 || n > lib.MAX_DEPOSIT_INDEX) throw fail("malformed");
      const t = schnorr.utils.mod(schnorr.utils.bytesToNumberBE(schnorr.utils.taggedHash(lib.DEPOSIT_TAG, lib.parsePoolKey(Q), id, u32be(n))), N);
      if (t === 0n) throw fail("malformed");
      return t;
    },
    depositKey(Q, id, n) {
      const P = schnorr.utils.lift_x(schnorr.utils.bytesToNumberBE(lib.parsePoolKey(Q))).add(secp256k1.ProjectivePoint.BASE.multiply(lib.depositTweak(Q, id, n)));
      return P.toRawBytes(true).slice(1);
    },
    depositAddress(Q, id, n, network = "signet") {
      const key = lib.depositKey(Q, id, n);
      const pay = btc.p2tr(key, undefined, netOf(network));
      return { n, key, address: pay.address, script: pay.script };
    },
    parseOutpoint(text) {
      const m = typeof text === "string" ? text.match(/^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/) : null;
      if (!m || Number(m[2]) > 4294967295) throw fail("bad_outpoint");
      return { txid: m[1], vout: Number(m[2]), key: `${m[1]}:${Number(m[2])}` };
    },
    canonicalBody(fields) {
      if (!fields || Object.getPrototypeOf(fields) !== Object.prototype) throw fail("malformed");
      const out = {};
      for (const k of Object.keys(fields).sort()) {
        const v = fields[k];
        if (k === "sig" || !(typeof v === "string" || typeof v === "boolean" || (Number.isSafeInteger(v) && v >= 0))) throw fail("malformed");
        out[k] = v;
      }
      return JSON.stringify(out);
    },
    requestDigest: ({ endpoint, network, poolKey, fields }) =>
      schnorr.utils.taggedHash(lib.RELAY_SIGN_TAG, lp(endpoint), lp(network), lib.parsePoolKey(poolKey), sha256(enc.encode(lib.canonicalBody(fields)))),
    signRequest({ account, endpoint, network, poolKey, fields = {}, now = Date.now }) {
      const all = { ...fields, accountPub: account.pubHex, t: Math.floor(now() / 1000) };
      return { ...all, sig: hex(schnorr.sign(lib.requestDigest({ endpoint, network, poolKey, fields: all }), account.secret)) };
    },
    verifyRequest({ endpoint, network, poolKey, body, now = Date.now, maxSkewSec = 600 }) {
      try {
        const { sig, ...fields } = body ?? {};
        const pub = lib.parseAccountPub(fields.accountPub);
        if (!Number.isSafeInteger(fields.t) || !isHex(sig, 128)) return { ok: false, code: "malformed" };
        if (Math.abs(now() / 1000 - fields.t) > maxSkewSec) return { ok: false, code: "stale_request" };
        if (!schnorr.verify(unhex(sig), lib.requestDigest({ endpoint, network, poolKey, fields }), pub)) return { ok: false, code: "bad_signature" };
        const id = sha256(pub);
        return { ok: true, pub, id, idHex: hex(id), fields };
      } catch {
        return { ok: false, code: "malformed" };
      }
    },
  };
  return lib;
}

const SHARED = existsSync(new URL("../src/relay-account.mjs", import.meta.url));
const lib = SHARED ? await import("../src/relay-account.mjs") : contractStub();

/** planPayment (contract §1b), or a stub of it while funding.mjs has none: largest-first, change to the payer when >= 330. */
function planPaymentStub({ account, utxos, to, amount, feeRate }) {
  if (amount < dustLimit(to)) throw new Error("dust");
  const ordered = [...utxos].sort((a, b) => b.value - a.value);
  const outVb = (s) => 8 + 1 + s.length;
  const baseVb = 11 + outVb(to) + outVb(account.script);
  const picked = [];
  let total = 0n;
  let fee = 0n;
  for (const u of ordered) {
    picked.push(u);
    total += BigInt(u.value);
    fee = BigInt(feeRate) * BigInt(Math.ceil(baseVb + 57.5 * picked.length));
    if (total >= amount + fee) break;
  }
  if (!picked.length || total < amount + fee) throw new Error(`not enough BTC at ${account.address}: have ${total} sats, need ${amount + fee}`);
  const tx = new btc.Transaction();
  for (const u of picked) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: account.script, amount: BigInt(u.value) }, tapInternalKey: account.pub });
  tx.addOutput({ script: to, amount });
  const change = total - amount - fee;
  if (change >= 330n) tx.addOutput({ script: account.script, amount: change });
  return { tx, fee: change >= 330n ? fee : total - amount, change: change >= 330n ? change : 0n };
}
const planPayment = typeof funding.planPayment === "function" ? funding.planPayment : planPaymentStub;

/* ---------------------------------------------------------------- an explorer and a relayer in memory */

/** The explorer as the CLI sees it: payments to addresses, a fee rate, broadcasts recorded (never sent anywhere). */
class FakeExplorer {
  constructor() {
    this.outs = new Map(); // "txid:vout" -> { txid, vout, address, script, value, confs }
    this.listed = [];
    this.broadcasts = [];
  }
  pay(address, value, { confs = 1, txid = hash32(), vout = 0 } = {}) {
    const script = hex(btc.OutScript.encode(btc.Address(btc.TEST_NETWORK).decode(address)));
    const o = { txid, vout, address, script, value, confs };
    this.outs.set(`${txid}:${vout}`, o);
    return o;
  }
  async utxos(address) {
    this.listed.push(address);
    return [...this.outs.values()]
      .filter((o) => o.address === address)
      .map((o) => ({ txid: o.txid, vout: o.vout, value: o.value, status: o.confs > 0 ? { confirmed: true, block_height: 1000 - o.confs + 1 } : { confirmed: false } }));
  }
  async feeRate() {
    return 2;
  }
  async broadcast(raw) {
    this.broadcasts.push(raw);
    return btc.Transaction.fromRaw(unhex(raw)).id;
  }
}

const RULES = { minDepositSats: 2000, depositConfirmations: 1, sweepCostSats: 288, perSendSats: 657, batchHeadroom: 2, suggestSends: 10, suggestedTopUpSats: 7000 };

/**
 * The paid relayer's HTTP surface (contract §4.2) in memory: info, signed account reads, credits
 * checked against the FakeExplorer's outputs, and a scriptable submit / status. Every call is
 * recorded; signatures are checked with the same module the CLI signs with.
 */
class FakeRelay {
  constructor(chain) {
    this.chain = chain;
    this.poolSecret = randomBytes(32);
    this.Q = hex(schnorr.getPublicKey(this.poolSecret));
    this.accounts = new Map();
    this.credits = new Map(); // key -> { idHex, n, value, amount, height }
    this.own = new Set();
    this.calls = [];
    this.bodies = [];
    this.patch = (i) => i;
    this.submitAnswer = null;
    this.statuses = [];
    this.badDeposit = false;
  }
  infoBody() {
    return {
      enabled: true, mode: "balance", code: null, reason: null, network: "signet", ops: ["TRANSACT"], address: "tb1pchange", height: 1000, chainTip: 1000,
      pow: null, selfPay: true, anchor: { window: 100, safety: 24, minAnchor: 924 },
      fees: { feeRate: 1, maxFeeRate: 5, estVsize: 597, carrierFeeSats: 597, maxFeePerTx: 3000 },
      balance: { poolKey: this.Q, changeAddress: "tb1pchange", signTag: "murkle/relay/v1", marginPct: 10, marginMinSats: 50, ...RULES },
      queue: { queued: 0, max: 120 }, stats: { relayed144: 3, landed144: [], accepted: 0, rejected: 0, expired: 0, missed: 0, satsSpent: 0 },
      defaultMode: "block", batch: null, docs: "docs/design/relay-balance.md",
    };
  }
  acct(idHex) {
    if (!this.accounts.has(idHex)) this.accounts.set(idHex, { balance: 0, reserved: 0, nextIndex: 0, credits: [] });
    return this.accounts.get(idHex);
  }
  async info() {
    this.calls.push("info");
    return JSON.parse(JSON.stringify(this.patch(this.infoBody())));
  }
  async state() {
    this.calls.push("state");
    return { height: 1000 };
  }
  async account(body) {
    this.calls.push("account");
    this.bodies.push(["account", body]);
    assert.deepEqual(Object.keys(body).sort(), ["accountPub", "sig", "t"], "an account read carries exactly accountPub, t and sig");
    const v = lib.verifyRequest({ endpoint: "/api/relay/account", network: "signet", poolKey: lib.parsePoolKey(this.Q), body, now });
    if (!v.ok) return { status: 401, body: { error: { code: v.code, message: "bad request signature" } } };
    const a = this.acct(v.idHex);
    const n = a.nextIndex;
    const address = this.badDeposit ? this.chainAddress(lib.relayAccount(randomBytes(32), "signet"), n) : lib.depositAddress(lib.parsePoolKey(this.Q), v.id, n, "signet").address;
    return { status: 200, body: { accountId: v.idHex, balance: a.balance, reserved: a.reserved, nextIndex: n, depositAddress: address, credits: a.credits.slice().reverse() } };
  }
  chainAddress(account, n) {
    return lib.depositAddress(lib.parsePoolKey(this.Q), account.id, n, "signet").address;
  }
  async credit(body) {
    this.calls.push("credit");
    this.bodies.push(["credit", body]);
    const err = (status, code, extra = {}) => ({ status, body: { error: { code, message: `${code} message`, ...extra } } });
    if (this.creditAnswer) return this.creditAnswer;
    assert.deepEqual(Object.keys(body).sort(), ["accountPub", "n", "outpoint"], "a credit carries exactly outpoint, accountPub and n, unsigned");
    let key;
    try {
      key = lib.parseOutpoint(body.outpoint).key;
    } catch {
      return err(400, "bad_outpoint");
    }
    const pub = lib.parseAccountPub(body.accountPub);
    const idHex = hex(sha256(pub));
    const done = this.credits.get(key);
    if (done) return done.idHex === idHex && done.n === body.n ? { status: 200, body: { credited: true, already: true, outpoint: key, n: done.n, value: done.value, sweepCost: 288, amount: done.amount, height: done.height } } : err(409, "already_credited");
    if (this.own.has(key.split(":")[0])) return err(422, "deposit_own");
    const out = this.chain.outs.get(key);
    if (!out) return err(404, "deposit_unknown");
    if (out.script !== hex(lib.depositAddress(lib.parsePoolKey(this.Q), sha256(pub), body.n, "signet").script)) return err(422, "deposit_mismatch");
    if (out.value < RULES.minDepositSats) return err(422, "deposit_small", { minDepositSats: RULES.minDepositSats });
    if (out.confs < RULES.depositConfirmations) return err(409, "deposit_unconfirmed", { confirmations: out.confs, needed: RULES.depositConfirmations });
    const amount = out.value - RULES.sweepCostSats;
    const height = 1000 - out.confs + 1;
    this.credits.set(key, { idHex, n: body.n, value: out.value, amount, height });
    const a = this.acct(idHex);
    a.balance += amount;
    a.nextIndex = Math.max(a.nextIndex, body.n + 1);
    a.credits.push({ outpoint: key, n: body.n, value: out.value, amount, height });
    return { status: 200, body: { credited: true, already: false, outpoint: key, n: body.n, value: out.value, sweepCost: RULES.sweepCostSats, amount, height } };
  }
  async submit(body) {
    this.calls.push("submit");
    this.bodies.push(["submit", body]);
    return typeof this.submitAnswer === "function" ? this.submitAnswer(body) : this.submitAnswer;
  }
  async status() {
    this.calls.push("status");
    return this.statuses.shift() ?? null;
  }
}

const newFile = () => ({ seed: hash32(), btcKey: hash32(), pending: [] });
/** A command run with captured output and a counted save. */
async function run(fn, args) {
  const out = [];
  let saves = 0;
  const res = await fn({ url: URL_, lib, now, print: (s) => out.push(s), save: () => (saves += 1), ...args });
  return { res, out, saves };
}

/* ---------------------------------------------------------------- 1. open or not, and the command against a closed relayer */

test("relayOpenAt: only an enabled relayer in balance mode carries sends", () => {
  assert.equal(relayOpenAt({ enabled: true, mode: "balance" }), true);
  for (const info of [null, undefined, {}, { enabled: true }, { enabled: true, mode: null }, { enabled: true, mode: "tickets" }, { enabled: false, mode: "balance" }, { enabled: "true", mode: "balance" }]) {
    assert.equal(relayOpenAt(info), false, JSON.stringify(info));
  }
  assert.equal(
    relayUnavailable("http://r.test"),
    "relaying is unavailable at http://r.test: no relayer with relay balances runs there. Nothing was handed over. Send without --relay to pay the fee from this wallet's BTC fee key, which ties the transfer to that address on Bitcoin.",
  );
});

test("the command: send --relay and retry --relay <url> against a relayer without balances exit 1, hand nothing over and write nothing", { timeout: 120_000 }, async () => {
  const data = mkdtempSync(join(DIR, "spawn-"));
  mkdirSync(join(data, "wallets"));
  const walletFile = join(data, "wallets", "erin.json");
  const pending = [{ via: "relay", relay: "http://old.test", relayId: "ab".repeat(16), mode: "block", amount: "5", ticker: "GHOST", to: "mrk1x", anchor: 990, status: "failed", error: "dropped", spends: ["7"] }];
  writeFileSync(walletFile, JSON.stringify({ seed: hash32(), btcKey: hash32(), pending }));
  const before = readFileSync(walletFile);
  const seen = [];
  // What a stage-0 server answers (server/retired-relay.mjs relayInfoOff, contract §4.2).
  const off = { enabled: false, mode: null, code: "disabled", reason: "no relayer runs on this server", network: "signet", ops: [], address: null, pow: null, selfPay: true, balance: null, batch: null, docs: "docs/design/relay-balance.md" };
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${new URL(req.url, "http://x").pathname}`);
    const body = req.url === "/api/relay/info" ? off : { error: { code: "disabled", message: "No relayer runs on this server." } };
    res.writeHead(req.url === "/api/relay/info" ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const exec = (args, env = {}) =>
    new Promise((resolve) => {
      execFile(process.execPath, ["bin/murkle.mjs", ...args], { env: { ...process.env, MURKLE_DATA_DIR: data, MURKLE_ESPLORA: "http://127.0.0.1:9/api", ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
      });
    });
  const BOB = encodeAddress(deriveKeys(randomBytes(32)));
  const closed = "http://127.0.0.1:9"; // nothing listens: an unreachable relayer counts as closed
  for (const [args, url, env] of [
    [["send", "erin", "GHOST", "100", BOB, "--relay", base], base, {}],
    [["send", "erin", "GHOST", "100", BOB, "--relay", "--batch"], base, { MURKLE_RELAY_URL: base }],
    [["send", "erin", "GHOST", "100", BOB, "--relay", base, "--fast", "--no-wait"], base, {}],
    [["send", "erin", "GHOST", "100", BOB, "--relay", closed], closed, {}],
    [["retry", "erin", "--relay", base], base, {}],
  ]) {
    const r = await exec(args, env);
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stderr.trim(), `error: ${relayUnavailable(url)}`, args.join(" "));
    assert.equal(r.stdout, "", `${args.join(" ")}: nothing synced, proved or printed`);
  }
  assert.deepEqual(readFileSync(walletFile), before, "the wallet file is byte-identical");
  assert.ok(seen.length >= 4 && seen.every((s) => s === "GET /api/relay/info"), `only relay info was asked: ${seen.join(", ")}`);
  for (const args of [["relay", "account", "erin", "--relay", base], ["relay", "topup", "erin", "--relay", base], ["relay", "credit", "erin", "--relay", base]]) {
    const r = await exec(args);
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stderr.trim(), `error: ${relayUnavailable(base)}`, args.join(" "));
  }
  const usage = await exec(["relay", "fund", "erin"]);
  assert.equal(usage.code, 1);
  assert.match(usage.stderr, /^error: unknown relay command "fund"\nusage: murkle relay account/);
  assert.deepEqual(readFileSync(walletFile), before, "still byte-identical");
});

/* ---------------------------------------------------------------- 2. relay account, topup, credit */

test("parseRelayCommand: subcommands, the alias, strict flags", () => {
  const p = (args) => parseRelayCommand(args, { read: () => undefined });
  assert.deepEqual(p(["account", "alice"]), { sub: "account", name: "alice", url: "http://localhost:8787", pay: null, feeRate: null, dryRun: false, outpoint: null, n: null, older: false });
  assert.equal(p(["balance", "alice"]).sub, "account", "relay balance is an alias");
  assert.equal(parseRelayCommand(["account", "a"], { read: (n) => (n === "RELAY_URL" ? "https://r.example/" : undefined) }).url, "https://r.example");
  assert.deepEqual(p(["topup", "alice", "--relay", "https://r.test/", "--pay", "7000", "--fee-rate=2", "--dry-run"]), {
    sub: "topup", name: "alice", url: "https://r.test", pay: 7000, feeRate: 2, dryRun: true, outpoint: null, n: null, older: false,
  });
  const op = `${"ab".repeat(32)}:1`;
  assert.deepEqual(p(["credit", "alice", op, "3"]), { sub: "credit", name: "alice", url: "http://localhost:8787", pay: null, feeRate: null, dryRun: false, outpoint: op, n: 3, older: false });
  assert.equal(p(["credit", "alice", "--older"]).older, true);
  const bad = [
    [["fund", "alice"], /unknown relay command "fund"/],
    [[], /which relay command\?/],
    [["account"], /which wallet\?/],
    [["account", "alice", "extra"], /unexpected argument "extra"/],
    [["account", "alice", "--pay", "7000"], /unknown flag --pay for relay account/],
    [["credit", "alice", "--pay", "7000"], /unknown flag --pay for relay credit/],
    [["topup", "alice", "--dry-run"], /--fee-rate and --dry-run go with --pay/],
    [["topup", "alice", "--fee-rate", "2"], /--fee-rate and --dry-run go with --pay/],
    [["topup", "alice", "--pay", "0"], /--pay must be a whole number above 0/],
    [["topup", "alice", "--pay", "7e3"], /--pay must be a whole number above 0/],
    [["topup", "alice", "--pay", "-5"], /--pay must be a whole number above 0/],
    [["topup", "alice", "--pay", "1", "--pay", "2"], /--pay given twice/],
    [["topup", "alice", "--pay", "7000", "--dry-run=yes"], /--dry-run takes no value/],
    [["topup", "alice", "--dryrun"], /unknown flag --dryrun/],
    [["topup", "alice", "--relay", "ftp://x"], /--relay takes an http\(s\) URL/],
    [["topup", "alice", "--relay"], /--relay needs a value/],
    [["credit", "alice", op, "01"], /deposit address number must be a whole number, not "01"/],
    [["credit", "alice", op, "1", "2"], /unexpected argument "2"/],
    [["credit", "alice", op, "--older"], /--older looks up deposit addresses/],
    [["credit", "alice", "--fund"], /unknown flag --fund/],
  ];
  for (const [args, re] of bad) assert.throws(() => p(args), (e) => re.test(e.message) && e.message.endsWith(RELAY_USAGE), args.join(" ") || "(nothing)");
});

test("relay account: balance, next deposit address and price per send; the index follows the relayer's nextIndex only", async () => {
  const chain = new FakeExplorer();
  const relay = new FakeRelay(chain);
  const file = newFile();
  const account = relayAccountOf(file, lib);
  assert.equal(account.idHex, hex(sha256(account.pub)));
  const a0 = lib.depositAddress(lib.parsePoolKey(relay.Q), account.id, 0, "signet").address;
  let r = await run(relayAccountCommand, { file, client: relay });
  assert.deepEqual(r.out, [
    `account   ${account.idHex.slice(0, 4)}…${account.idHex.slice(-4)} (signet)`,
    "balance   0 sats available, 0 reserved",
    `next      deposit address #0  ${a0}`,
    `relayer   ${URL_}  per send ~657 sats (fee 597 + margin 60 at 1 sat/vB)`,
  ]);
  assert.match(a0, /^tb1p/);
  assert.equal(r.saves, 0, "a wallet that never paid writes nothing");
  assert.equal(file.relay, undefined);
  assert.deepEqual(relay.calls, ["info", "account"]);

  // The relayer credited deposits at #0 and #1 (paid from another device): the wallet moves on to #2.
  const acc = relay.acct(account.idHex);
  Object.assign(acc, { balance: 6055, reserved: 1314, nextIndex: 2 });
  r = await run(relayAccountCommand, { file, client: relay });
  assert.deepEqual(r.out.slice(1, 3), ["balance   6,055 sats available, 1,314 reserved", `next      deposit address #2  ${relay.chainAddress(account, 2)}`]);
  assert.deepEqual([depositIndexOf(file), r.saves], [2, 1]);
  // A wallet ahead of the relayer (a payment made, not credited yet) keeps its own index.
  file.relay.depositIndex = 4;
  r = await run(relayAccountCommand, { file, client: relay });
  assert.equal(r.out[2], `next      deposit address #4  ${relay.chainAddress(account, 4)}`);
  assert.equal(r.saves, 0);

  // Fee rate unknown, or the relayer halted: still readable, and said plainly.
  relay.patch = (i) => ({ ...i, code: "halted", fees: { ...i.fees, carrierFeeSats: null }, balance: { ...i.balance, perSendSats: null } });
  r = await run(relayAccountCommand, { file, client: relay });
  assert.equal(r.out[3], `relayer   ${URL_}  per send: not quoted yet (the relayer does not know the fee rate)`);
  assert.equal(r.out[4], "note      the relayer takes no sends right now (halted); your balance is kept");
  relay.patch = (i) => i;

  // A relayer whose deposit address is not this wallet's own derivation is refused: nothing is shown to pay.
  relay.badDeposit = true;
  await assert.rejects(run(relayAccountCommand, { file, client: relay }), /^Error: The relayer's deposit address doesn't match this wallet\. Nothing was paid\.$/);
  await assert.rejects(run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain }), /doesn't match this wallet/);
  relay.badDeposit = false;

  // Not in balance mode, another network, a broken pool key, a refused read: errors (exit 1).
  for (const [patch, re] of [
    [(i) => ({ ...i, mode: null }), /^Error: relaying is unavailable at http:\/\/relay\.test: no relayer with relay balances runs there/],
    [(i) => ({ ...i, enabled: false }), /relaying is unavailable/],
    [(i) => ({ ...i, network: "mainnet" }), /runs on mainnet, not signet/],
    [(i) => ({ ...i, balance: { ...i.balance, poolKey: "zz" } }), /published no valid pool key/],
  ]) {
    relay.patch = patch;
    await assert.rejects(run(relayAccountCommand, { file, client: relay }), re);
  }
  relay.patch = (i) => i;
  const refused = { info: () => relay.info(), account: async () => ({ status: 503, body: { error: { code: "halted", message: "The relayer stopped itself." } } }) };
  await assert.rejects(run(relayAccountCommand, { file, client: refused }), /^Error: the relayer refused the balance read: halted \(The relayer stopped itself\.\)$/);
});

test("relay topup: a fresh address and the rules; a seen payment moves the index on, nothing else does", async () => {
  const chain = new FakeExplorer();
  const relay = new FakeRelay(chain);
  const file = newFile();
  const account = relayAccountOf(file, lib);
  const addr = (n) => relay.chainAddress(account, n);
  const rules = (n) => [
    `deposit address #${n}: ${addr(n)}`,
    "minimum 2,000 sats; credited after 1 confirmation; suggested 7,000 sats (about 10 sends)",
    "a plain payment from any signet wallet, never real bitcoin; each top-up gets a new address, older ones are still credited",
    "the relayer can link the address you top up from to every transfer you relay with this balance; Tor does not prevent this",
    "288 sats of each top-up pay for the relayer to spend that coin later; a payment below the minimum is not credited and is not returned",
    "to pay it from this wallet's BTC fee key: murkle relay topup alice --pay 7000; then, once confirmed: murkle relay credit alice",
  ];
  let r = await run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain });
  assert.deepEqual(r.out, rules(0));
  assert.deepEqual([depositIndexOf(file), r.saves, file.relay], [0, 0, undefined], "showing an address is not a payment");
  r = await run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain });
  assert.equal(r.out[0], `deposit address #0: ${addr(0)}`, "the same address until it is paid");

  // Paid from an exchange (unconfirmed still counts as seen): the next top-up gets #1.
  chain.pay(addr(0), 7000, { confs: 0 });
  r = await run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain });
  assert.deepEqual(r.out, rules(1));
  assert.deepEqual([depositIndexOf(file), r.saves], [1, 1]);
  assert.deepEqual(chain.listed.slice(-2), [addr(0), addr(1)]);
  // Three confirmations needed on mainnet-like rules: said in the plural.
  relay.patch = (i) => ({ ...i, balance: { ...i.balance, depositConfirmations: 3 } });
  r = await run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain });
  assert.match(r.out[1], /credited after 3 confirmations;/);
  relay.patch = (i) => i;
  assert.ok(!relay.calls.includes("credit") && !relay.calls.includes("submit"), "topup never credits or submits");
  assert.deepEqual(chain.broadcasts, []);
});

test("relay topup --pay: a plain payment to the deposit address; --dry-run broadcasts nothing and keeps the index", async () => {
  const chain = new FakeExplorer();
  const relay = new FakeRelay(chain);
  const file = newFile();
  const btcKey = Buffer.from(file.btcKey, "hex");
  const payer = btcAccount(btcKey);
  const account = relayAccountOf(file, lib);
  const dep = (n) => lib.depositAddress(lib.parsePoolKey(relay.Q), account.id, n, "signet");
  chain.pay(payer.address, 20_000);
  chain.pay(payer.address, 3_000);

  const dry = await run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain, btcKey, pay: 7000, dryRun: true, planPayment });
  assert.equal(dry.res.dryRun, true);
  const tx = btc.Transaction.fromRaw(unhex(dry.res.hex));
  const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));
  assert.ok(outs.every((o) => o.script[0] !== 0x6a), "no OP_RETURN: a plain payment");
  // L5: the change takes a random slot, so the deposit output is found by its script.
  const di = outs.findIndex((o) => hex(o.script) === hex(dep(0).script));
  assert.ok(di >= 0, "pays deposit address #depositIndex");
  assert.equal(outs[di].amount, 7000n);
  const rest = outs.filter((_, i) => i !== di);
  assert.ok(rest.every((o) => hex(o.script) === hex(payer.script)), "change goes back to the BTC fee key");
  assert.equal(tx.inputsLength, 1, "largest coin first");
  assert.equal(hex(tx.getInput(0).txid), [...chain.outs.values()].find((o) => o.value === 20_000).txid);
  const fee = 20_000 - 7000 - Number(rest[0]?.amount ?? 0n);
  assert.equal(dry.res.fee, typeof dry.res.fee === "bigint" ? BigInt(fee) : fee);
  assert.deepEqual(dry.out.slice(0, 4), [
    `deposit address #0: ${dep(0).address}`,
    "minimum 2,000 sats; credited after 1 confirmation; suggested 7,000 sats (about 10 sends)",
    "a plain payment from any signet wallet, never real bitcoin; each top-up gets a new address, older ones are still credited",
    "the relayer can link the address you top up from to every transfer you relay with this balance; Tor does not prevent this",
  ]);
  assert.equal(dry.out[4], `paying 7,000 sats to deposit address #0 from ${payer.address}, fee ${fee} sats at 2 sat/vB`);
  assert.equal(dry.out[5], "the relayer sees which address paid: paying from this wallet's BTC fee key links your relay balance to that key's address, which your self-paid sends also use");
  assert.equal(dry.out[6], `dry run, nothing broadcast: ${tx.id}\n${dry.res.hex}`);
  assert.deepEqual(chain.broadcasts, [], "nothing broadcast");
  assert.deepEqual([depositIndexOf(file), dry.saves], [0, 0], "a dry run pays nothing, so the index stays");

  // Below the minimum: refused before anything is built.
  let built = 0;
  const counting = (a) => (built++, planPayment(a));
  await assert.rejects(run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain, btcKey, pay: 1999, planPayment: counting }), /^Error: --pay 1999 is below the 2,000-sat minimum: a smaller payment is not credited and is not returned\. Nothing was paid$/);
  assert.equal(built, 0);
  await assert.rejects(run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain, btcKey, pay: 7000, planPayment: null }), /no planPayment/);

  // A real (fake-broadcast) payment moves the index on to a fresh address.
  const paid = await run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain, btcKey, pay: 7000, feeRate: 1, planPayment });
  assert.equal(chain.broadcasts.length, 1, "broadcast once, to the fake explorer");
  const paidTx = btc.Transaction.fromRaw(unhex(chain.broadcasts[0]));
  assert.equal(paid.res.txid, paidTx.id);
  const pv = Array.from({ length: paidTx.outputsLength }, (_, i) => paidTx.getOutput(i)).findIndex((o) => hex(o.script) === hex(dep(0).script));
  assert.ok(pv >= 0, "the deposit output, wherever L5 put it");
  assert.deepEqual([depositIndexOf(file), paid.saves], [1, 1]);
  assert.equal(paid.out.at(-1), `after 1 confirmation: murkle relay credit alice  (or by outpoint: murkle relay credit alice ${paid.res.txid}:${pv} 0)`);
  assert.deepEqual(pendingOf(file), [{ n: 0, outpoint: `${paid.res.txid}:${pv}` }], "kept pending until credited");
  assert.match(paid.out[4], /at 1 sat\/vB$/);
});

test("relay credit: exit 0 credited or already, 4 refused, 6 waiting, 1 nothing found or an error; the index moves on a seen payment", async () => {
  const chain = new FakeExplorer();
  const relay = new FakeRelay(chain);
  const file = newFile();
  const account = relayAccountOf(file, lib);
  const addr = (n) => relay.chainAddress(account, n);
  const credit = (extra = {}) => run(relayCreditCommand, { file, client: relay, esplora: chain, ...extra });

  // Nothing paid yet: exit 1, nothing asked of the relayer but info and the account read.
  let r = await credit();
  assert.deepEqual([r.res.exit, r.out], [1, [
    `no payment found at deposit address #0: ${addr(0)}`,
    "a payment to an older deposit address: murkle relay credit <wallet> --older, or name it: murkle relay credit <wallet> <txid:vout> <n>",
  ]]);
  assert.deepEqual(relay.calls, ["info", "account"]);

  // #0 paid 7,000 and confirmed: credited (exit 0), and the wallet now shows #1.
  const p0 = chain.pay(addr(0), 7000);
  r = await credit();
  assert.deepEqual(r.out, [`#0 ${p0.txid}:0  7,000 sats  credited +6,712 (balance 6,712)`]);
  assert.equal(r.res.exit, 0);
  assert.deepEqual([depositIndexOf(file), relay.acct(account.idHex).balance], [1, 6712]);
  assert.deepEqual(relay.bodies.at(-1), ["credit", { outpoint: `${p0.txid}:0`, accountPub: account.pubHex, n: 0 }]);

  // #1 paid twice: one below the minimum (refused, exit 4), one unconfirmed (listed, not sent).
  const small = chain.pay(addr(1), 1500, { vout: 1 });
  const later = chain.pay(addr(1), 9000, { confs: 0 });
  const credits = relay.calls.filter((c) => c === "credit").length;
  r = await credit();
  assert.deepEqual(r.out, [`#1 ${small.txid}:1  1,500 sats  below the 2,000-sat minimum: not credited`, `#1 ${later.txid}:0  9,000 sats  waiting for confirmations (0 of 1)`]);
  assert.equal(r.res.exit, 4, "a refusal wins over waiting");
  assert.equal(relay.calls.filter((c) => c === "credit").length, credits + 1, "the unconfirmed payment is not sent to the relayer");
  assert.equal(depositIndexOf(file), 2);

  // #2 unconfirmed only: exit 6. Once confirmed: credited, the balance adds up, exit 0.
  const p2 = chain.pay(addr(2), 8000, { confs: 0 });
  r = await credit();
  // The unconfirmed payment at #1 stays pending and is asked about again (the relayer says it is waiting too).
  assert.deepEqual([r.res.exit, r.out], [6, [`#2 ${p2.txid}:0  8,000 sats  waiting for confirmations (0 of 1)`, `#1 ${later.txid}:0  —  waiting for confirmations (0 of 1)`]]);
  assert.equal(depositIndexOf(file), 3, "seen, not yet credited: the next top-up still gets a fresh address");
  p2.confs = 1;
  r = await credit({ outpoint: `${p2.txid}:0` });
  assert.deepEqual([r.res.exit, r.out], [0, [`#2 ${p2.txid}:0  8,000 sats  credited +7,712 (balance 14,424)`]], "n defaults to depositIndex − 1");

  // The relayer counts confirmations itself: 409 deposit_unconfirmed is waiting, with its numbers.
  const p3 = chain.pay(addr(3), 5000);
  p3.confs = 0; // the explorer of the CLI says confirmed below, the relayer's does not
  const lying = { ...chain, utxos: async (a) => (await chain.utxos(a)).map((u) => ({ ...u, status: { confirmed: true, block_height: 1000 } })) };
  r = await credit({ esplora: lying });
  assert.deepEqual([r.res.exit, r.out], [6, [`#3 ${p3.txid}:0  5,000 sats  waiting for confirmations (0 of 1)`, `#1 ${later.txid}:0  —  waiting for confirmations (0 of 1)`]]);

  // An explicit outpoint: already credited (same account and n) is exit 0; another account's is refused.
  r = await credit({ outpoint: `${p0.txid}:0`, n: 0 });
  assert.deepEqual([r.res.exit, r.out], [0, [`#0 ${p0.txid}:0  7,000 sats  already credited`]]);
  const other = newFile();
  r = await run(relayCreditCommand, { file: other, client: relay, esplora: chain, outpoint: `${p0.txid}:0`, n: 0 });
  assert.deepEqual([r.res.exit, r.out], [4, [`#0 ${p0.txid}:0  —  refused: already_credited (already_credited message)`]]);
  assert.equal(depositIndexOf(other), 0, "a refused credit moves nothing");
  // Another wallet's deposit address, the relayer's own change, an unknown txid.
  const theirs = chain.pay(relay.chainAddress(relayAccountOf(other, lib), 0), 4000);
  r = await credit({ outpoint: `${theirs.txid}:0`, n: 0 });
  assert.deepEqual([r.res.exit, r.out[0]], [4, `#0 ${theirs.txid}:0  —  refused: deposit_mismatch (deposit_mismatch message)`]);
  const change = hash32();
  relay.own.add(change);
  r = await credit({ outpoint: `${change}:1`, n: 0 });
  assert.deepEqual([r.res.exit, r.out[0]], [4, `#0 ${change}:1  —  refused: deposit_own (deposit_own message)`]);
  const unknown = hash32();
  r = await credit({ outpoint: `${unknown}:0`, n: 0 });
  assert.deepEqual([r.res.exit, r.out[0]], [6, `#0 ${unknown}:0  —  the relayer's explorer does not know it yet; run this again in a minute`]);

  // A misspelt outpoint is refused here, before the relayer is asked to credit anything.
  const asked = relay.calls.filter((c) => c === "credit").length;
  for (const bad of [`${p0.txid.toUpperCase()}:0`, `${p0.txid}:01`, `${p0.txid}: 0`, `${p0.txid}:+0`, `${p0.txid}:4294967296`, p0.txid, `${p0.txid}:0:0`]) {
    await assert.rejects(credit({ outpoint: bad }), /is not a deposit outpoint: it must be a 64-character lowercase txid, a colon and the output number/, bad);
  }
  assert.equal(relay.calls.filter((c) => c === "credit").length, asked);

  // A relayer error (halted, rate limited) is exit 1; credit_in_progress waits (6).
  relay.creditAnswer = { status: 503, body: { error: { code: "halted", message: "The relayer stopped itself because its books do not add up." } } };
  r = await credit({ outpoint: `${p0.txid}:0`, n: 0 });
  assert.deepEqual([r.res.exit, r.out[0]], [1, `#0 ${p0.txid}:0  —  not credited: halted (The relayer stopped itself because its books do not add up.)`]);
  relay.creditAnswer = { status: 409, body: { error: { code: "credit_in_progress", message: "busy", retryAfter: 5 } } };
  r = await credit({ outpoint: `${p0.txid}:0`, n: 0 });
  assert.deepEqual([r.res.exit, r.out[0]], [6, `#0 ${p0.txid}:0  —  being credited right now; run this again in a few seconds`]);
  relay.creditAnswer = null;

  // --older looks at every earlier address too; already credited ones answer "already".
  r = await credit({ older: true });
  assert.ok(chain.listed.slice(-5).includes(addr(0)), "address #0 looked up again");
  assert.ok(r.out.some((l) => l === `#0 ${p0.txid}:0  7,000 sats  already credited`), r.out.join("\n"));
  assert.ok(r.out.some((l) => l.startsWith(`#1 ${small.txid}:1`)));
  assert.equal(r.res.exit, 4, "the small deposit is still refused");
  assert.ok(relay.calls.every((c) => ["info", "account", "credit"].includes(c)), "credit never submits");
});

/* ---------------------------------------------------------------- 3. relaySend against a relay balance */

const VKEY = JSON.parse(readFileSync("build/dev/verification_key.json", "utf8"));
const START = ACTIVATION_HEIGHT ?? 324592;
const idx = new Indexer({ vkey: VKEY, startHeight: START, genesis: GENESIS });
const aliceSeed = randomBytes(32);
const alice = new Wallet(deriveKeys(aliceSeed));
const BOB = encodeAddress(deriveKeys(randomBytes(32)));
const ASSET = assetIdOf(START + 1, 1);
const coinbase = () => ({ txid: hash32(), inputs: [], outputs: [] });
const carrier = (envelope, first = randomBytes(36)) => ({ txid: hash32(), inputs: [{ outpoint: first }], outputs: [{ script: opReturnScript(envelope), value: 0n }] });
async function mine(txs = []) {
  await idx.applyBlock({ height: idx.height + 1, hash: hash32(), txs: [coinbase(), ...txs] });
}

test("relay credit with no outpoint finds the documented top-ups: after topup --pay, after a waiting row, after a payment seen by topup", async () => {
  const chain = new FakeExplorer();
  const relay = new FakeRelay(chain);
  const file = newFile();
  const btcKey = Buffer.from(file.btcKey, "hex");
  const account = relayAccountOf(file, lib);
  const addr = (n) => relay.chainAddress(account, n);
  chain.pay(btcAccount(btcKey).address, 20_000);

  // (a) relay topup --pay, then the printed next step, plain relay credit: credited (exit 0), not "no payment found at #1".
  const paid = await run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain, btcKey, pay: 7000, feeRate: 1, planPayment });
  assert.equal(depositIndexOf(file), 1);
  // L5: the deposit output may come after the change; the CLI records it by script.
  const pv = pendingOf(file)[0].outpoint.split(":")[1];
  const paidTx = btc.Transaction.fromRaw(unhex(chain.broadcasts.at(-1)));
  assert.equal(funding.addressOf(paidTx.getOutput(Number(pv)).script), addr(0), "the pending outpoint is the deposit output");
  chain.pay(addr(0), 7000, { txid: paid.res.txid, vout: Number(pv), confs: 0 }); // the explorer sees it, unconfirmed
  let r = await run(relayCreditCommand, { file, client: relay, esplora: chain });
  assert.deepEqual([r.res.exit, r.out], [6, [`#0 ${paid.res.txid}:${pv}  —  waiting for confirmations (0 of 1)`]], "the relayer is asked about the pending top-up");
  chain.outs.get(`${paid.res.txid}:${pv}`).confs = 1;
  r = await run(relayCreditCommand, { file, client: relay, esplora: chain });
  assert.deepEqual([r.res.exit, r.out], [0, [`#0 ${paid.res.txid}:${pv}  7,000 sats  credited +6,712 (balance 6,712)`]]);
  assert.deepEqual(pendingOf(file), [], "credited: it leaves the pending list");
  r = await run(relayCreditCommand, { file, client: relay, esplora: chain });
  assert.equal(r.res.exit, 1, "nothing left to credit");

  // (b) an unconfirmed payment at #1 (exit 6, the index moves to #2), then plain credit once it confirms: credited.
  const p1 = chain.pay(addr(1), 8000, { confs: 0 });
  r = await run(relayCreditCommand, { file, client: relay, esplora: chain });
  assert.deepEqual([r.res.exit, depositIndexOf(file)], [6, 2]);
  assert.deepEqual(pendingOf(file), [{ n: 1, outpoint: `${p1.txid}:0` }]);
  p1.confs = 1;
  r = await run(relayCreditCommand, { file, client: relay, esplora: chain });
  assert.deepEqual([r.res.exit, r.out], [0, [`#1 ${p1.txid}:0  8,000 sats  credited +7,712 (balance 14,424)`]]);

  // (c) paid from elsewhere at #2, then relay topup moves past it: a plain credit still finds it.
  const p2 = chain.pay(addr(2), 5000, { confs: 0 });
  r = await run(relayTopUpCommand, { name: "alice", file, client: relay, esplora: chain });
  assert.equal(r.out[0], `deposit address #3: ${addr(3)}`);
  p2.confs = 1;
  r = await run(relayCreditCommand, { file, client: relay, esplora: chain });
  assert.deepEqual([r.res.exit, r.out], [0, [`#2 ${p2.txid}:0  5,000 sats  credited +4,712 (balance 19,136)`]]);
  assert.deepEqual(pendingOf(file), []);
});

test("relay topup while the relayer cannot price a send: no 'suggested 0 sats', no '--pay null'", async () => {
  const chain = new FakeExplorer();
  const relay = new FakeRelay(chain);
  relay.patch = (i) => ({ ...i, code: "busy", fees: { ...i.fees, feeRate: null, carrierFeeSats: null }, balance: { ...i.balance, perSendSats: null, suggestedTopUpSats: null } });
  const r = await run(relayTopUpCommand, { name: "alice", file: newFile(), client: relay, esplora: chain });
  assert.equal(r.out[1], "minimum 2,000 sats; credited after 1 confirmation; suggested amount: not quoted yet (the relayer does not know the fee rate)");
  assert.equal(r.out.at(-1), "to pay it from this wallet's BTC fee key: murkle relay topup alice --pay <sats> (at least 2000); then, once confirmed: murkle relay credit alice");
  assert.ok(r.out.every((l) => !l.includes("null") && !l.includes("suggested 0")));
});

test("recentDepositWarning: only for a newest credit inside the 144-block window landed144 covers", () => {
  const info = (landed) => ({ height: 325_000, stats: { landed144: landed } });
  assert.equal(recentDepositWarning(info([[324_990, 1], [324_995, 1]]), 324_600), false, "a top-up 400 blocks old is not recent, whatever landed144 holds");
  assert.equal(recentDepositWarning(info([[324_990, 1], [324_995, 1]]), 324_900), true, "2 landed since a credit 100 blocks ago");
  assert.equal(recentDepositWarning(info([[324_990, 3], [324_995, 2]]), 324_900), false);
  assert.equal(recentDepositWarning(info([]), 324_856), true, "the window's edge is still exact");
  assert.equal(recentDepositWarning(info([]), 324_855), false);
  assert.equal(recentDepositWarning(info([]), null), false);
});

test("setup: a token and three of Alice's notes", { timeout: 120_000 }, async () => {
  const genesis = GENESIS ? [{ txid: GENESIS_TXID, inputs: [], outputs: [{ script: opReturnScript(encodeAttest({ kind: ATTEST_KIND.GENESIS, hash: MANIFEST_SHA256 })), value: 0n }] }] : [];
  await mine(genesis);
  await mine([carrier(encodeDeploy({ ticker: "GHOST", divisibility: 0, mintAmount: 100n, mintCap: 1000, priceSats: 0n, treasury: new Uint8Array() }))]);
  const txs = [];
  for (let i = 0; i < 3; i++) {
    const bind = randomBytes(36);
    txs.push(carrier(await alice.mint(idx, { asset: ASSET, mintAmount: 100n, bindOutpoint: bind }), bind));
  }
  await mine(txs);
  await mine();
  alice.scan(idx);
  assert.equal(alice.balance(ASSET), 300n);
});

/** relaySend for Alice against a FakeRelay whose info follows the local index. */
function relayFor({ balance = 10_000, credits = [], landed = [] } = {}) {
  const relay = new FakeRelay(new FakeExplorer());
  const base = relay.infoBody.bind(relay);
  relay.infoBody = () => ({ ...base(), height: idx.height, chainTip: idx.height, anchor: { window: 100, safety: 24, minAnchor: idx.height - 76 }, stats: { ...base().stats, landed144: landed } });
  const file = { seed: hex(aliceSeed), btcKey: hash32(), pending: [] };
  const account = relayAccountOf(file, lib);
  Object.assign(relay.acct(account.idHex), { balance, nextIndex: credits.length, credits });
  return { relay, file, account };
}
async function send({ relay, file, mode = "block", entry = null, unlock = false, linkable = false }) {
  if (unlock) alice.locked.clear(); // a fresh wallet file: no earlier entry holds Alice's notes
  const out = [];
  let saves = 0;
  const res = await relaySend({
    idx, wallet: alice, file, name: "alice", client: relay, mode, url: URL_, ticker: "GHOST", amount: "100", to: BOB, entry, lib, now, linkable,
    print: (s) => out.push(s), warn: (s) => out.push(`warn: ${s}`), save: () => (saves += 1), resync: async () => {}, sleep: async () => {},
  });
  return { res, out, saves };
}

test("relaySend preflight: a short balance stops before proving, writing or handing anything over (exit 1)", async () => {
  for (const [mode, balance, need] of [["block", 656, 657], ["fast", 0, 657], ["batch", 1313, 1314], ["batch10", 700, 1314]]) {
    const { relay, file } = relayFor({ balance });
    const locked = alice.locked.size;
    const { res, out, saves } = await send({ relay, file, mode });
    assert.deepEqual(res, { status: "error", code: "balance_low", balance, needed: need }, mode);
    assert.equal(exitCodeFor(res), 1);
    assert.deepEqual(out, [`relay ${URL_} (signet), relayer height ${idx.height}`, `relay balance ${balance.toLocaleString("en-US")} sats; this send needs about ${need.toLocaleString("en-US")}. Nothing was handed over. Top up: murkle relay topup alice`], mode);
    assert.deepEqual([file.pending, saves, alice.locked.size], [[], 0, locked], `${mode}: no pending entry, no lock`);
    assert.deepEqual(relay.calls, ["info", "account"], `${mode}: no submit`);
  }
  // Refusals in relay info come first, before the balance is read.
  const { relay, file } = relayFor();
  relay.patch = (i) => ({ ...i, code: "fee_high", reason: "Bitcoin fees are above the relayer's cap right now" });
  await assert.rejects(send({ relay, file, mode: "fast" }), /^Error: the relayer is not taking fast transfers right now \(fee_high\); nothing was sent; send without --relay to pay the fee from this wallet's BTC fee key$/);
  relay.patch = (i) => ({ ...i, fees: { ...i.fees, carrierFeeSats: null }, balance: { ...i.balance, perSendSats: null } });
  await assert.rejects(send({ relay, file }), /does not know the fee rate yet, so it cannot quote this send; nothing was sent/);
  relay.patch = (i) => ({ ...i, mode: null });
  await assert.rejects(send({ relay, file }), new RegExp(`^Error: ${relayUnavailable(URL_).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  assert.ok(!relay.calls.includes("account") && !relay.calls.includes("submit"));
  assert.deepEqual(file.pending, []);
});

test("relaySend: the submit is a signed request verifyRequest accepts, without proof of work; a 402 after hand-out exits 4", { timeout: 120_000 }, async () => {
  const { relay, file, account } = relayFor({ balance: 10_000 });
  relay.submitAnswer = { status: 402, body: { error: { code: "balance_low", message: "Your relay balance does not cover this send. Top up, or pay the fee yourself.", balance: 100, needed: 657, perSend: 657 } } };
  const { res, out } = await send({ relay, file });
  assert.equal(res.status, "refused");
  assert.equal(exitCodeFor(res), 4);
  const [, body] = relay.bodies.find(([k]) => k === "submit");
  assert.deepEqual(Object.keys(body).sort(), ["accountPub", "envelope", "mode", "sig", "t"], "exactly the contract's submit body");
  assert.ok(!("pow" in body));
  assert.deepEqual([body.mode, body.accountPub, body.t], ["block", account.pubHex, Math.floor(NOW / 1000)]);
  assert.match(body.envelope, /^[0-9a-f]{942}$/);
  const Q = lib.parsePoolKey(relay.Q);
  const verify = (b, extra = {}) => lib.verifyRequest({ endpoint: "/api/relay/submit", network: "signet", poolKey: Q, body: b, now, ...extra });
  const ok = verify(body);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.idHex, account.idHex);
  // The signature binds the mode, the envelope, the endpoint, the network and the pool key.
  assert.equal(verify({ ...body, mode: "fast" }).code, "bad_signature");
  assert.equal(verify({ ...body, envelope: `${body.envelope.slice(0, -2)}00` }).code, "bad_signature");
  assert.equal(lib.verifyRequest({ endpoint: "/api/relay/account", network: "signet", poolKey: Q, body, now }).ok, false, "not valid at another endpoint");
  assert.equal(lib.verifyRequest({ endpoint: "/api/relay/submit", network: "mainnet", poolKey: Q, body, now }).code, "bad_signature");
  assert.equal(verify(body, { now: () => NOW + 601_000 }).code, "stale_request");

  const e = file.pending[0];
  assert.deepEqual([e.status, e.error, e.relayId, e.envelope], ["failed", "balance_low", null, body.envelope], "the entry was written before the hand-out (W-1)");
  assert.ok(e.spends.every((n) => alice.locked.has(n)));
  assert.equal(
    out.at(-1),
    `relay failed: balance_low (Your relay balance does not cover this send. Top up, or pay the fee yourself.); notes stay reserved until block ${e.anchor + 100} unless it lands: murkle retry alice; to top up: murkle relay topup alice, or send without --relay`,
  );
  assert.ok(out.includes("relay balance 10,000 sats available; this send costs about 657 sats"));
  assert.ok(out.includes("the relayer can link the address you top up from to every transfer you relay with this balance; Tor does not prevent this; it cannot see amounts, tokens or recipients"));
  assert.ok(!out.some((l) => /anti-spam|proof of work/i.test(l)));
  assert.deepEqual(relay.calls, ["info", "account", "submit"], "one signed read, one submit");

  // The retry of the same entry: busy is retried with a freshly signed body, 202 queues it.
  let n = 0;
  relay.submitAnswer = () => (++n === 1 ? { status: 503, body: { error: { code: "busy", message: "The relayer is busy." } } } : { status: 202, body: { id: "cd".repeat(16), status: "queued", mode: "block", reservedSats: 657, balance: 9343 } });
  const again = await send({ relay, file, entry: e });
  assert.equal(again.res.status, "queued", again.out.join("\n"));
  assert.ok(again.out.includes("warn: the relayer is busy; trying again in 5 s"));
  assert.equal(again.out.at(-1), "reserved 657 sats of your relay balance (9,343 still available); the exact fee plus margin is charged when it goes out");
  const subs = relay.bodies.filter(([k]) => k === "submit").map(([, b]) => b);
  assert.equal(subs.length, 3);
  assert.notEqual(subs[1].sig, subs[2].sig, "each attempt is signed afresh");
  assert.ok(subs.every((b) => verify(b).ok));
  assert.deepEqual([e.status, e.relayId], ["relaying", "cd".repeat(16)]);
  assert.equal(file.pending.length, 1, "the retry updates the same entry");
});

test("relaySend L1/L3: a thin pool stops before proving unless --linkable; linkable is signed; a linkable 202 never reads as hidden; the crowd warning", async () => {
  const held = new Set(alice.locked);
  const thin = { k: 3, coverOk: false, depositors: 1 };
  const withMix = (r, mix) => (r.relay.patch = (i) => ({ ...i, balance: { ...i.balance, mix } }));
  // Thin, no consent: refused after the balance read, before anything is proved, written or handed over.
  let r = relayFor();
  withMix(r, thin);
  const locked = alice.locked.size;
  let { res, out, saves } = await send({ ...r });
  assert.deepEqual(res, { status: "error", code: "pool_thin", cover: thin });
  assert.equal(exitCodeFor(res), 1);
  assert.ok(out.includes(POOL_THIN));
  assert.equal(POOL_THIN, "Too few people have topped up the relay pool, so this send's input would tie it to your top-up address. Pay the fee yourself, or confirm to send it linkable.");
  assert.ok(out.includes("1 account has topped up this relay pool; a carrier needs coin history from at least 4 accounts (3 besides whoever sends). To relay this send anyway, add --linkable; to pay the fee yourself, send without --relay. Nothing was handed over"));
  assert.ok(!out.some((l) => l.startsWith("proving transfer")));
  assert.deepEqual(r.relay.calls, ["info", "account"], "no submit");
  assert.deepEqual([r.file.pending, saves, alice.locked.size], [[], 0, locked]);

  // Thin, --linkable: the signed body carries linkable: true; the 202's linkable/thin marks the entry.
  r = relayFor();
  withMix(r, thin);
  r.relay.submitAnswer = { status: 202, body: { id: "ef".repeat(16), status: "queued", mode: "block", reservedSats: 657, balance: 9343, linkable: true, thin: true } };
  ({ res, out } = await send({ ...r, unlock: true, linkable: true }));
  assert.equal(res.status, "queued", out.join("\n"));
  const body = r.relay.bodies.find(([k]) => k === "submit")[1];
  assert.equal(body.linkable, true);
  assert.deepEqual(Object.keys(body).sort(), ["accountPub", "envelope", "linkable", "mode", "sig", "t"]);
  const Q = lib.parsePoolKey(r.relay.Q);
  assert.equal(lib.verifyRequest({ endpoint: "/api/relay/submit", network: "signet", poolKey: Q, body, now }).ok, true, "the signature covers linkable");
  assert.equal(lib.verifyRequest({ endpoint: "/api/relay/submit", network: "signet", poolKey: Q, body: { ...body, linkable: false }, now }).ok, false);
  assert.equal(res.entry.linkable, true);
  assert.ok(out.includes(LINKABLE_LINE));
  assert.ok(!out.some((l) => /sender (is )?hidden|hides (who|the sender)/i.test(l)), "never claims the sender is hidden");
  // L3: this test chain holds few notes of other people at the anchor: the crowd warning shows, before proving.
  const few = out.findIndex((l) => l.startsWith(CROWD_FEW));
  assert.ok(few > 0 && few < out.findIndex((l) => l.startsWith("proving transfer")), "the crowd warning comes before proving");
  assert.match(out[few], /note(s)? of other people (is|are) in the pool at block \d+\.$/);

  // With cover: signed exactly as before, no linkable field, nothing marked.
  r = relayFor();
  withMix(r, { k: 3, coverOk: true, depositors: 9 });
  r.relay.submitAnswer = { status: 202, body: { id: "ab".repeat(16), status: "queued", mode: "block", reservedSats: 657, balance: 9343 } };
  ({ res, out } = await send({ ...r, unlock: true }));
  assert.equal(res.status, "queued");
  assert.deepEqual(Object.keys(r.relay.bodies.find(([k]) => k === "submit")[1]).sort(), ["accountPub", "envelope", "mode", "sig", "t"]);
  assert.equal(res.entry.linkable, undefined);
  assert.ok(!out.includes(LINKABLE_LINE) && !out.includes(POOL_THIN));

  // The relayer's own 409 pool_thin (cover was published, but not for this account): refused, with the way on.
  r = relayFor();
  r.relay.submitAnswer = { status: 409, body: { error: { code: "pool_thin", message: POOL_THIN } } };
  ({ res, out } = await send({ ...r, unlock: true }));
  assert.equal(res.code, "pool_thin");
  assert.match(out.at(-1), /^relay failed: pool_thin \(Too few people .*\); notes stay reserved until block \d+ unless it lands: murkle retry alice; to relay it anyway: murkle retry alice --linkable, or send without --relay$/);

  // A batch that holds only this transfer says so.
  r = relayFor();
  const base = r.relay.patch;
  r.relay.patch = (i) => {
    const o = base(i);
    const modes = { ...(o.batch?.modes ?? {}) };
    modes.batch = { ...(modes.batch ?? {}), current: { ...(modes.batch?.current ?? {}), queued: 0 } };
    return { ...o, batch: { ...(o.batch ?? {}), modes } };
  };
  r.relay.submitAnswer = { status: 402, body: { error: { code: "balance_low", message: "short" } } };
  ({ out } = await send({ ...r, unlock: true, mode: "batch" }));
  assert.ok(out.includes(BATCH_ALONE), out.join("\n"));
  alice.locked.clear();
  held.forEach((n) => alice.locked.add(n));
});

test("relaySend L1 review: a relayer with k below 3 (0 turns its rule off) is no cover, and one that publishes no lineage is said to be unknown", async () => {
  const held = new Set(alice.locked);
  const withMix = (r, mix) => (r.relay.patch = (i) => ({ ...i, balance: { ...i.balance, ...(mix ? { mix } : {}) } }));
  assert.equal(CLI.MIN_COVER_K, 3);
  for (const k of [0, 1, 2]) {
    const cover = { k, coverOk: true, depositors: 9 };
    assert.equal(CLI.coverThin(cover), true, `k ${k}`);
    const r = relayFor();
    withMix(r, cover);
    const { res, out } = await send({ ...r });
    assert.deepEqual([res.status, res.code], ["error", "pool_thin"], `k ${k}: refused without --linkable`);
    assert.ok(out.includes(POOL_THIN));
    assert.ok(out.some((l) => l.includes(`this relayer asks a carrier's coin to descend from only ${k} accounts besides the sender, too few to hide one.`)));
    assert.deepEqual(r.relay.calls, ["info", "account"], "nothing handed over");
  }
  assert.equal(CLI.coverThin({ k: 3, coverOk: true, depositors: 9 }), false);
  assert.equal(CLI.coverThin(null), false, "unknown is not thin");
  // No lineage published (the relayer before this fix): the send goes on, with the warning first.
  const r = relayFor();
  withMix(r, null);
  r.relay.submitAnswer = { status: 402, body: { error: { code: "balance_low", message: "short" } } };
  const { out } = await send({ ...r, unlock: true });
  assert.ok(out.includes(CLI.MIX_UNKNOWN), out.join(" | "));
  assert.ok(out.indexOf(CLI.MIX_UNKNOWN) < out.findIndex((l) => l.startsWith("proving transfer")), "before anything is proved");
  assert.ok(!out.some((l) => /sender (is )?hidden/i.test(l)));
  alice.locked.clear();
  held.forEach((n) => alice.locked.add(n));
});

test("relaySend: the recent top-up warning, shown while fewer than 5 relayed transfers landed since the newest credit", async () => {
  const credit = { outpoint: `${hash32()}:0`, n: 0, value: 7000, amount: 6712, height: idx.height - 2 };
  const stop = { status: 402, body: { error: { code: "balance_low", message: "short" } } };
  const held = new Set(alice.locked);
  let r = relayFor({ balance: 10_000, credits: [credit], landed: [[idx.height - 3, 9], [idx.height - 1, 2], [idx.height, 2]] });
  r.relay.submitAnswer = stop;
  let { out } = await send({ ...r, unlock: true });
  assert.ok(out.includes(RECENT_DEPOSIT), "4 landed since the credit: warn");
  assert.ok(out.indexOf(RECENT_DEPOSIT) < out.findIndex((l) => l.startsWith("proving transfer")), "before anything is proved");
  assert.equal(RECENT_DEPOSIT, "Your top-up confirmed recently and few people are relaying right now. Sending now can link this transfer to the address you paid from. A batch mode, or waiting, hides this better.");
  r = relayFor({ balance: 10_000, credits: [credit], landed: [[idx.height - 1, 3], [idx.height, 2]] });
  r.relay.submitAnswer = stop;
  ({ out } = await send({ ...r, unlock: true }));
  assert.ok(!out.includes(RECENT_DEPOSIT), "5 landed: no warning");
  r = relayFor({ balance: 10_000 });
  r.relay.submitAnswer = stop;
  ({ out } = await send({ ...r, unlock: true }));
  assert.ok(!out.includes(RECENT_DEPOSIT), "no credit known: no warning");
  r = relayFor({ balance: 0, credits: [credit] });
  ({ out } = await send({ ...r, unlock: true }));
  assert.equal(out.length, 2, "a short balance prints only the relayer and balance lines");
  alice.locked.clear();
  held.forEach((n) => alice.locked.add(n));
});

test("waitForRelay: missed is final, exits 4 and says nothing was charged; a landed send reports its charge", async () => {
  const entry = { via: "relay", relayId: "ef".repeat(16), mode: "block", anchor: 1000, spends: ["1"], status: "relaying" };
  const relay = new FakeRelay(new FakeExplorer());
  relay.statuses = [{ status: "queued" }, { status: "missed", code: "balance_low", reason: "Your relay balance did not cover the fee when it was due." }];
  const out = [];
  let saves = 0;
  const res = await waitForRelay({ client: relay, entry, name: "alice", print: (s) => out.push(s), sleep: async () => {}, save: () => (saves += 1) });
  assert.equal(res.status, "missed");
  assert.equal(exitCodeFor(res), 4);
  assert.deepEqual(out, [
    "waiting for the carrier; Ctrl+C stops waiting, the relayer keeps the transfer",
    "relay missed: balance_low (Your relay balance did not cover the fee when it was due.); nothing was charged: murkle retry alice",
  ]);
  assert.deepEqual([entry.status, entry.error, entry.missedCode, saves], ["failed", "missed", "balance_low", 1]);
  // A missed entry is one to retry.
  assert.equal(await CLI.pickRetry({ file: { pending: [{ ...entry, status: "relaying" }] }, clientFor: () => ({ status: async () => ({ status: "missed", code: "fee_high" }) }), open: true }) !== null, true);

  const landed = { ...entry, status: "relaying" };
  relay.statuses = [{ status: "broadcast", txid: "aa".repeat(32), cost: 657 }, { status: "accepted", txid: "aa".repeat(32), height: 1002, cost: 657 }];
  const lout = [];
  const ok = await waitForRelay({ client: relay, entry: landed, name: "alice", print: (s) => lout.push(s), sleep: async () => {} });
  assert.equal(exitCodeFor(ok), 0);
  assert.deepEqual(lout.slice(-2), ["landed in block 1002", "charged 657 sats to your relay balance"]);
  assert.equal(landed.cost, 657);
});

/* ---------------------------------------------------------------- 5, 6. help, source, docs */

test("HELP lists the relay balance commands; no command, flag or line funds the relayer", () => {
  const help = HELP.join("\n");
  for (const s of [
    "relay account <w> [--relay url]", "alias: relay balance <w>", "relay topup <w> [--relay url] [--pay <sats> [--fee-rate n] [--dry-run]]",
    "relay credit <w> [<txid:vout> [<n>]] [--older] [--relay url]", "relay balance you top up first", "network fee plus a margin",
    "can link the address you top up from", "cannot see amounts, tokens or recipients", "--fast     goes out at once", "4 refused, failed or missed", "6 when some still wait",
  ]) {
    assert.ok(help.includes(s), `help: ${s}`);
  }
  assert.doesNotMatch(help, /ticket|prepaid tickets|anti-spam|proof of work|within about a minute/i);
  const src = readFileSync("bin/murkle.mjs", "utf8");
  const FUND = /fund\w*\s+(the\s+)?(relayer|pool)/i;
  for (const [where, text] of [["HELP", help], ["RELAY_USAGE", RELAY_USAGE], ["bin/murkle.mjs", src]]) assert.doesNotMatch(text, FUND, where);
  assert.ok(FUND.test("fund the relayer") && FUND.test("Funds pool") && !FUND.test("funding.mjs"), "the guard itself");
  // The command table: the only relay subcommands are account (balance), topup and credit, and relayer has only retire-free.
  const table = src.slice(src.indexOf("const commands = {"), src.indexOf("/** True when this file is the script"));
  // The mining release (docs/design/mining-contract.md §11) adds `deploy-pow` (a quoted name, not
  // matched here) and `mine`; neither is a relay subcommand.
  assert.deepEqual([...table.matchAll(/^ {2}async (\w+)\(/gm)].map((m) => m[1]), ["new", "address", "sync", "balance", "assets", "log", "deploy", "mint", "mine", "send", "pending", "retry", "relay", "relayer", "attest", "audit"]);
  assert.doesNotMatch(table, FUND);
  assert.match(src, /\["account", "topup", "credit"\]\.includes\(sub\)/);
  // The retired relay proof of work (tickets) stays gone everywhere. Mining's Argon2 work is a
  // separate feature, so the wider pattern is checked over the relay code only.
  assert.doesNotMatch(src, /relay-pow|solvePow/, "no relay proof of work left in the CLI");
  const relayCode = src.slice(src.indexOf("// ------------------------------------------------- relayed sends"), src.indexOf("// ------------------------------------------------- mining"));
  assert.ok(relayCode.length > 10000, "the relay sections were found");
  assert.doesNotMatch(relayCode, /\bgrind\b|\bpow\b/, "no proof of work in the relay code");
  assert.doesNotMatch(src, /fee bumped/, "the relayer never bumps");
});

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js|json|md|html|css)$/.test(name)) out.push(p);
  }
  return out;
}

test("README lists every relayer variable of the contract, the new commands and exit codes; HOT_FLOOR_SATS is retired", () => {
  const readme = read("README.md");
  const ENV = [
    "MURKLE_RELAYER", "MURKLE_RELAY_MODE", "MURKLE_RELAY_DIR", "MURKLE_RELAY_MARGIN_PCT", "MURKLE_RELAY_MARGIN_MIN_SATS", "MURKLE_RELAY_MIN_DEPOSIT_SATS",
    "MURKLE_RELAY_DEPOSIT_CONFS", "MURKLE_RELAY_BATCH_HEADROOM", "MURKLE_RELAY_SUGGEST_SENDS", "MURKLE_RELAY_INVALID_PROOF_SATS", "MURKLE_RELAY_INVALID_PER_HOUR",
    "MURKLE_RELAY_ACCOUNT_PER_HOUR", "MURKLE_RELAY_KEY_PATH", "MURKLE_RELAY_STATE_PATH", "MURKLE_RELAY_URL", "MURKLE_MAX_FEE_RATE", "MURKLE_MAX_FEE_PER_TX",
    "MURKLE_MAX_RELAYS_PER_BLOCK", "MURKLE_MAX_QUEUE", "MURKLE_SAFETY_BLOCKS", "MURKLE_BATCH10_SAFETY_BLOCKS", "MURKLE_MAX_BATCH_PER_EPOCH", "MURKLE_MAX_BATCH10_PER_EPOCH",
    "MURKLE_BATCH_PER_IP", "MURKLE_MAX_INDEXER_LAG", "MURKLE_VERIFY_CONCURRENCY", "MURKLE_VERIFY_MAX_PER_SEC", "MURKLE_FANOUT_TARGET", "MURKLE_FANOUT_VALUE",
    "MURKLE_FANOUT_MIN_CONFIRMED", "MURKLE_FANOUT_MIN_CARRIERS", "MURKLE_TRUST_PROXY", "MURKLE_BODY_LIMIT", "MURKLE_EST_VSIZE",
  ];
  for (const name of ENV) assert.ok(readme.includes(`\`${name}\``) || readme.includes(name), `README: ${name}`);
  const limits = readme.slice(readme.indexOf("**Relayer limits**"), readme.indexOf("## Wallet storage"));
  const retired = limits.slice(limits.indexOf("no longer read"));
  assert.ok(retired.includes("MURKLE_HOT_FLOOR_SATS"), "HOT_FLOOR_SATS is listed as no longer read");
  assert.ok(!limits.slice(0, limits.indexOf("no longer read")).includes("MURKLE_HOT_FLOOR_SATS"));
  const cli = readme.slice(readme.indexOf("## CLI"), readme.indexOf("## Reproduce the circuit"));
  for (const s of ["relay topup alice", "relay credit alice", "relay account alice", "--pay", "--dry-run", "--older", "exit", "missed", "MURKLE_RELAY_MODE=balance"]) {
    assert.ok(cli.includes(s) || readme.includes(s), `README: ${s}`);
  }
  assert.match(readme, /operator never pays/i);
  assert.match(readme, /relay-balance\.md/);
});

test("design docs: paid-relay.md is superseded, batch-contract.md and relayer.md carry the amendment, the audit names I-PAY", () => {
  assert.ok(read("docs/design/paid-relay.md").startsWith("Superseded by relay-balance.md (2026-10-03)"), "paid-relay.md starts with the superseded line");
  const batch = read("docs/design/batch-contract.md");
  const amend = batch.slice(batch.indexOf("## Amendment 2026-10-03"));
  assert.ok(batch.includes("## Amendment 2026-10-03"), "batch-contract.md has the dated amendment");
  for (const s of ["fee_high", "missed", "never held", "cannot send at all", "proof of work", "relay-balance-contract.md"]) assert.ok(amend.includes(s), `amendment: ${s}`);
  const relayer = read("docs/design/relayer.md");
  assert.match(relayer.slice(0, 1500), /relay balances replace/i);
  assert.ok(relayer.slice(0, 1500).includes("relay-balance-contract.md"));
  assert.ok(relayer.split("\n").some((l) => l.startsWith("**Explorer errors.**")), "relayer.md keeps its Explorer errors paragraph");
  const report = read("audit/REPORT.md");
  for (const s of ["I-PAY", "I0", "I1", "I2", "signPoolTx", "assertProvenance", "checkBooks", "test/relay-balance-relayer.test.mjs", "test/relay-books.test.mjs"]) {
    assert.ok(report.includes(s), `REPORT.md: ${s}`);
  }
  const spec = read("SPEC.md");
  const s14 = spec.slice(spec.indexOf("## 14."));
  for (const s of ["murkle/relay-account/v1/<network>", "murkle/relay-deposit/v1", "murkle/relay/v1", "I-PAY", "4294967295", "canonical"]) assert.ok(s14.includes(s), `SPEC §14: ${s}`);
  const claims = read("docs/CLAIMS.md");
  const relay = claims.match(/[^\n]*relay balance[^\n]*/gi) ?? [];
  assert.ok(relay.some((s) => /prepa|top up|tops up/i.test(s)) && relay.some((s) => /link/i.test(s)) && relay.some((s) => /timing|right after/i.test(s)), "docs/CLAIMS.md describes relay balances honestly");
});

test("no ticket wording outside paid-relay.md and relay-balance*.md (README, SPEC, bin/, server/, web/src)", () => {
  const files = ["README.md", "SPEC.md", ...walk("bin"), ...walk("server"), ...walk(join("web", "src"))];
  const hits = files.filter((f) => /ticket/i.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, []);
});

test("my files keep their line endings: bin/murkle.mjs CRLF, the docs and this test LF; English only", () => {
  const ends = (p) => {
    const b = readFileSync(p);
    let lf = 0;
    let crlf = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 10) b[i - 1] === 13 ? crlf++ : lf++;
    return { lf, crlf };
  };
  assert.equal(ends("bin/murkle.mjs").lf, 0, "bin/murkle.mjs is CRLF throughout");
  for (const f of ["README.md", "SPEC.md", "docs/design/relayer.md", "docs/design/batch-contract.md", "docs/design/paid-relay.md", "docs/CLAIMS.md", "audit/REPORT.md", "test/relay-balance-cli.test.mjs", "test/batch-cli.test.mjs"]) {
    assert.equal(ends(f).crlf, 0, `${f} is LF`);
    assert.ok(![...readFileSync(f, "utf8")].some((c) => c.codePointAt(0) >= 0x400 && c.codePointAt(0) <= 0x4ff), `${f}: English only`);
  }
});

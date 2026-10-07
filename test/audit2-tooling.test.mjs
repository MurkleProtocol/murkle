// Audit 2, tooling fixes: V2-01 (vite and underscore advisories), V2-09 (scripts/send-btc.mjs),
// V2-33 (wallet files: owner-only, atomic, merged saves), V2-34 (plain http only to this
// machine or .onion), V2-35 (open is asked of each entry's own relayer), V2-36 (strict flags
// for deploy and attest), V2-37 (self-paid send: amount checked, W-1 entry before broadcast),
// V2-38 (.dockerignore and image ownership), V2-39 (capped powers-of-tau download).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import * as btc from "@scure/btc-signer";
import { encodeAddress, deriveKeys } from "../src/keys.mjs";
import { btcAccount, dustLimit, scriptOf } from "../src/btc/funding.mjs";
import { ACTIVATION_HEIGHT, PRE_GENESIS } from "../src/params.mjs";

const DIR = mkdtempSync(join(tmpdir(), "murkle-audit2-tooling-"));
// The CLI reads these when it loads: wallets go to a temp dir, and any stray chain call would
// hit a closed local port instead of mempool.space.
process.env.MURKLE_DATA_DIR = join(DIR, "imported");
process.env.MURKLE_ESPLORA = "http://127.0.0.1:9/api";
delete process.env.MURKLE_RELAY_URL;
const cli = await import("../bin/murkle.mjs");
const { checkRelayUrl, listPending, mergeWalletFile, openWalletFile, parseRelayCommand, parseRelayFlags, parseStrictFlags, pickRetry, withFileLock, writeFileDurable } = cli;
const { parseSendArgs, planSend } = await import("../scripts/send-btc.mjs");
const { downloadCapped } = await import("../scripts/artifacts-lib.mjs");

const POSIX = process.platform !== "win32";
const servers = [];
after(async () => {
  servers.forEach((s) => s.close());
  rmSync(DIR, { recursive: true, force: true });
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const hex32 = () => randomBytes(32).toString("hex");
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fresh = (name) => {
  const d = join(DIR, `${name}-${randomBytes(4).toString("hex")}`);
  mkdirSync(d, { recursive: true });
  return d;
};

/** A local HTTP server; `handler(req, res, path)`; resolves to its base URL. */
async function serve(handler) {
  const server = createServer((req, res) => handler(req, res, new URL(req.url, "http://x").pathname));
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

/** Runs bin/murkle.mjs with a data dir and explorer of the test's own. */
const run = (args, env) =>
  new Promise((resolve) => {
    execFile(process.execPath, ["bin/murkle.mjs", ...args], { env: { ...process.env, MURKLE_RELAY_URL: "", ...env }, timeout: 120_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
    });
  });

// ------------------------------------------------------------------ V2-33 wallet files

test("V2-33: mergeWalletFile keeps another command's entries and relay state; ours win only where we changed them", () => {
  const a = { relay: "https://r", relayId: "a1", spends: ["1", "2"], anchor: 10, status: "relaying" };
  const gone = { txid: "t0", spends: ["9"], anchor: 1 };
  const base = { seed: "s", btcKey: "k", pending: [a, gone], relay: { depositIndex: 2, pending: [{ n: 1, outpoint: `${"aa".repeat(32)}:0` }] } };
  // This command: `gone` landed (dropped), `a` was released (status changed), a top-up was credited.
  const mine = structuredClone(base);
  mine.pending = [{ ...a, status: "accepted", height: 12 }];
  mine.relay = { depositIndex: 2, pending: [] };
  // Meanwhile another command added a relayed send and a paid top-up, and moved the index on.
  const b = { relay: "https://r", relayId: "b1", spends: ["5"], anchor: 11, status: "relaying" };
  const disk = structuredClone(base);
  disk.pending.push(b);
  disk.relay = { depositIndex: 3, pending: [...base.relay.pending, { n: 2, outpoint: `${"bb".repeat(32)}:1` }] };

  const out = mergeWalletFile(base, mine, disk);
  assert.deepEqual(out.pending, [{ ...a, status: "accepted", height: 12 }, b], "ours updated, theirs kept, the landed one dropped");
  assert.deepEqual(out.relay, { depositIndex: 3, pending: [{ n: 2, outpoint: `${"bb".repeat(32)}:1` }] }, "the index never moves back");
  assert.equal(out.seed, "s");

  // An entry another command dropped (it landed) stays dropped when this command did not touch it.
  const disk2 = { ...structuredClone(base), pending: [gone] };
  assert.deepEqual(mergeWalletFile(base, structuredClone(base), disk2).pending, [gone]);
  // A new entry of ours (W-1) is added even when the file on disk lost every entry.
  const mine3 = structuredClone(base);
  mine3.pending.push(b);
  assert.deepEqual(mergeWalletFile(base, mine3, { ...structuredClone(base), pending: [] }).pending, [b]);
  // No file on disk: ours as it is.
  assert.deepEqual(mergeWalletFile(base, mine, null), mine);
});

test("V2-33: two commands on one wallet file never undo each other's saves (the batch-wait race)", () => {
  const dir = fresh("race");
  const path = join(dir, "alice.json");
  writeFileSync(path, JSON.stringify({ seed: hex32(), btcKey: hex32(), pending: [] }));
  // A: a 10-hour batch send that read the file at its start and saves on release, hours later.
  const A = openWalletFile(path, "alice");
  const entryA = { via: "relay", relay: "https://r", relayId: null, spends: ["11"], anchor: 100, status: "relaying" };
  A.file.pending.push(entryA);
  A.save();
  // B: another send and a top-up while A waits.
  const B = openWalletFile(path, "alice");
  B.file.pending.push({ via: "relay", relay: "https://r", relayId: "B-RELAY", spends: ["21", "22"], anchor: 101, status: "relaying" });
  B.file.relay = { depositIndex: 4, pending: [{ n: 3, outpoint: `${"cc".repeat(32)}:0` }] };
  B.save();
  // A learns its relay id and its final status, and saves its stale copy of everything else.
  entryA.relayId = "A-RELAY";
  A.save();
  entryA.status = "accepted";
  A.save();
  const disk = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(disk.pending.map((p) => [p.relayId, p.status]), [["A-RELAY", "accepted"], ["B-RELAY", "relaying"]], "B's W-1 entry survives A's save");
  assert.deepEqual(disk.relay, { depositIndex: 4, pending: [{ n: 3, outpoint: `${"cc".repeat(32)}:0` }] }, "B's relay state survives");
  assert.deepEqual(readdirSync(dir).sort(), ["alice.json"], "no temp or lock file is left behind");
});

test("V2-33: writes are atomic and owner-only; a held lock makes a save wait, a stale one is taken", () => {
  const dir = fresh("durable");
  const path = join(dir, "w.json");
  writeFileSync(path, "old");
  writeFileDurable(path, "new");
  assert.equal(readFileSync(path, "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["w.json"]);
  if (POSIX) assert.equal(statSync(path).mode & 0o777, 0o600);
  // A failed write (the target is a directory) leaves no temp file.
  const asDir = join(dir, "sub");
  mkdirSync(asDir);
  assert.throws(() => writeFileDurable(asDir, "x"));
  assert.deepEqual(readdirSync(dir).sort(), ["sub", "w.json"]);

  writeFileSync(`${path}.lock`, "");
  assert.throws(() => withFileLock(path, () => 1, { waitMs: 100 }), /is locked by another murkle command/);
  const old = new Date(Date.now() - 60_000);
  utimesSync(`${path}.lock`, old, old);
  assert.equal(withFileLock(path, () => 42, { waitMs: 100 }), 42, "a lock older than 30 s is stale");
  assert.ok(!existsSync(`${path}.lock`), "released");
});

test("V2-33: `murkle new` creates the wallet owner-only and exclusively; reads tighten an older 0644 file", async () => {
  const data = fresh("new");
  const env = { MURKLE_DATA_DIR: data, MURKLE_ESPLORA: "http://127.0.0.1:9/api" };
  const r = await run(["new", "alice"], env);
  assert.equal(r.code, 0, r.stderr);
  const path = join(data, "wallets", "alice.json");
  const first = readFileSync(path, "utf8");
  assert.equal(Object.keys(JSON.parse(first)).sort().join(), "btcKey,pending,seed");
  if (POSIX) {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(data, "wallets")).mode & 0o777, 0o700);
  }
  const again = await run(["new", "alice"], env);
  assert.equal(again.code, 1);
  assert.match(again.stderr, /wallet "alice" already exists/);
  assert.equal(readFileSync(path, "utf8"), first, "never overwritten");
  if (POSIX) {
    const { chmodSync } = await import("node:fs");
    chmodSync(path, 0o644);
    assert.equal((await run(["address", "alice"], env)).code, 0);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

// ------------------------------------------------------------------ V2-34 relay URLs

test("V2-34: plain http:// only to this machine or a .onion address, in both parsers and MURKLE_RELAY_URL", () => {
  for (const ok of [
    "https://relay.example.org", "https://relay.example.org:8443/", "http://localhost:8787", "http://LOCALHOST:1", "http://murkle.localhost",
    "http://127.0.0.1:8787", "http://127.9.9.9", "http://[::1]:8787", "http://abcdefghijklmnop.onion",
  ]) {
    assert.equal(checkRelayUrl(ok), ok.replace(/\/+$/, ""), ok);
  }
  for (const bad of ["http://relay.example.org", "http://10.0.0.5:8787", "http://192.168.1.2", "http://localhost@evil.example", "http://127.0.0.1.evil.example", "http://localhost.evil.example"]) {
    assert.throws(() => checkRelayUrl(bad), /plain http:\/\/ is allowed only for a relayer on this machine or a \.onion address; use https:\/\//, bad);
  }
  assert.throws(() => checkRelayUrl("ftp://x"), /takes an http\(s\) URL/);

  const none = () => undefined;
  assert.throws(() => parseRelayFlags(["w", "--relay", "http://relay.example.org"], { read: none }), /use https:\/\/ for relay\.example\.org/);
  assert.throws(() => parseRelayFlags(["w", "--relay=http://relay.example.org"], { read: none }), /plain http/);
  assert.throws(() => parseRelayFlags(["w", "--relay"], { read: (n) => (n === "RELAY_URL" ? "http://relay.example.org" : undefined) }), /^Error: MURKLE_RELAY_URL: plain http/);
  assert.equal(parseRelayFlags(["w", "--relay", "https://relay.example.org/"], { read: none }).url, "https://relay.example.org");
  assert.equal(parseRelayFlags(["w"], { read: (n) => (n === "RELAY_URL" ? "http://relay.example.org" : undefined) }).url, null, "a self-paid send reads no relayer");

  assert.throws(() => parseRelayCommand(["topup", "alice", "--relay", "http://relay.example.org", "--pay", "20000"], { read: none }), (e) => /plain http/.test(e.message) && e.message.endsWith(cli.RELAY_USAGE));
  assert.throws(() => parseRelayCommand(["account", "alice"], { read: (n) => (n === "RELAY_URL" ? "http://relay.example.org" : undefined) }), /MURKLE_RELAY_URL: plain http/);
  assert.equal(parseRelayCommand(["account", "alice"], { read: none }).url, "http://localhost:8787");
  assert.equal(parseRelayCommand(["account", "alice", "--relay=http://127.0.0.1:9"], { read: none }).url, "http://127.0.0.1:9");
  const src = read("bin/murkle.mjs");
  assert.doesNotMatch(src, /so a wrong pool key never\s+(\/\/|\*)?\s*leads to a payment/, "the overstated comment is corrected");
});

test("V2-34: `relay topup --pay` refuses a plain-http relayer elsewhere before reading any key or network", async () => {
  const data = fresh("topup");
  mkdirSync(join(data, "wallets"));
  writeFileSync(join(data, "wallets", "alice.json"), JSON.stringify({ seed: hex32(), btcKey: hex32(), pending: [] }));
  const r = await run(["relay", "topup", "alice", "--relay", "http://relay.example.org", "--pay", "20000"], { MURKLE_DATA_DIR: data, MURKLE_ESPLORA: "http://127.0.0.1:9/api" });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /error: --relay: plain http:\/\/ is allowed only/);
  assert.equal(r.stdout, "");
});

// ------------------------------------------------------------------ V2-35 open per relayer

test("V2-35: listPending and pickRetry ask whether relaying is open of each entry's own relayer, once it decides", async () => {
  const held = { via: "relay", relay: "https://open.example", relayId: "c3".repeat(16), mode: "batch10", amount: "5", ticker: "GHOST", anchor: 960, releaseAt: 1020, status: "relaying", spends: ["2"] };
  const closedHeld = { ...held, relay: "https://closed.example", relayId: "d4".repeat(16), spends: ["3"] };
  const block = { ...held, mode: "block", releaseAt: undefined, relayId: "e5".repeat(16), spends: ["4"] };
  const calls = [];
  const asked = [];
  const clientFor = (url) => ({ status: async (id) => (calls.push([url, id]), { status: "queued" }) });
  const open = async (url) => (asked.push(url), url === "https://open.example");
  await listPending({ idx: { height: 1000 }, file: { pending: [held, closedHeld, block] }, clientFor, print: () => {}, open });
  assert.deepEqual(asked, ["https://open.example", "https://closed.example"], "asked only for batch entries before their release, of their own relayer");
  assert.deepEqual(calls, [["https://closed.example", closedHeld.relayId], ["https://open.example", block.relayId]], "the open relayer's scheduled item is not looked up");

  calls.length = 0;
  asked.length = 0;
  const picked = await pickRetry({ file: { pending: [closedHeld, held] }, height: 1000, clientFor, warn: () => {}, open });
  assert.equal(picked, null);
  assert.deepEqual(calls, [["https://closed.example", closedHeld.relayId]], "no lookup of the item its open relayer still holds");
  // A plain boolean still works as before.
  calls.length = 0;
  await listPending({ idx: { height: 1000 }, file: { pending: [held] }, clientFor, print: () => {}, open: true });
  assert.deepEqual(calls, []);
});

test("V2-35: `murkle pending` and `retry` never look up a scheduled batch entry its open relayer holds, whatever runs on localhost", { skip: PRE_GENESIS && "needs a pinned genesis" }, async () => {
  const seen = [];
  let enabled = true;
  const relayer = await serve((req, res, p) => {
    seen.push(`${req.method} ${p}`);
    if (p === "/api/relay/info") return json(res, 200, { enabled, mode: enabled ? "balance" : null, network: "signet" });
    if (p.startsWith("/api/relay/status/")) return json(res, 200, { status: "queued" });
    return json(res, 404, {});
  });
  const tip = ACTIVATION_HEIGHT - 1;
  const esplora = await serve((req, res, p) => {
    if (p === "/api/blocks/tip/height") return res.end(String(tip));
    res.writeHead(404);
    res.end("not found");
  });
  const data = fresh("pending");
  mkdirSync(join(data, "wallets"));
  const entry = { via: "relay", relay: relayer, relayId: "f6".repeat(16), mode: "batch10", amount: "5", ticker: "GHOST", to: "mrk1x", anchor: tip, releaseAt: tip + 50, lastRelease: tip + 55, status: "relaying", spends: ["77"] };
  const path = join(data, "wallets", "w.json");
  writeFileSync(path, JSON.stringify({ seed: hex32(), btcKey: hex32(), pending: [entry] }));
  // MURKLE_RELAY_URL names a closed port: before the fix, `open` came from there (or localhost).
  const env = { MURKLE_DATA_DIR: data, MURKLE_ESPLORA: `${esplora}/api`, MURKLE_RELAY_URL: "http://127.0.0.1:9" };
  for (const args of [["pending", "w"], ["pending", "w", "--relay"], ["retry", "w"]]) {
    seen.length = 0;
    const r = await run(args, env);
    assert.ok(seen.includes("GET /api/relay/info"), `${args.join(" ")}: asked its own relayer`);
    assert.ok(!seen.some((s) => s.includes("/status/")), `${args.join(" ")}: no lookup before the release: ${seen.join(", ")}`);
    if (args[0] === "pending") {
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`relay scheduled, goes out after block ${tip + 50}`));
    } else assert.match(r.stderr, /no failed relayed transfer to retry/);
  }
  // Its relayer closed: nothing goes out, so the entry is looked up (the retired-relayer case).
  enabled = false;
  seen.length = 0;
  const r = await run(["pending", "w"], env);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(seen.some((s) => s.startsWith("GET /api/relay/status/")), seen.join(", "));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).pending, [entry], "pending wrote nothing it did not change");
});

// ------------------------------------------------------------------ V2-36 strict flags

test("V2-36: parseStrictFlags refuses unknown, repeated, valueless and value-carrying flags", () => {
  const spec = { values: ["price", "ticker"], booleans: ["dry-run", "force"], usage: "usage: x" };
  assert.deepEqual(parseStrictFlags(["--price", "5000", "--ticker=ABC", "--dry-run"], spec), { price: "5000", ticker: "ABC", "dry-run": true });
  for (const [args, re] of [
    [["--prcie", "5000"], /unknown flag --prcie/],
    [["--price=5000", "--price", "1"], /--price given twice/],
    [["--dryrun"], /unknown flag --dryrun/],
    [["--dry_run"], /unknown flag --dry_run/],
    [["--dry-run=1"], /--dry-run takes no value/],
    [["--price"], /--price needs a value/],
    [["--price", "--force"], /--price needs a value/],
    [["stray"], /unexpected argument "stray"/],
  ]) {
    assert.throws(() => parseStrictFlags(args, spec), (e) => re.test(e.message) && e.message.endsWith("usage: x"), args.join(" "));
  }
});

test("V2-36: deploy and attest refuse a mistyped flag before syncing, reading a key or broadcasting", async () => {
  const seen = [];
  const esplora = await serve((req, res, p) => {
    seen.push(`${req.method} ${p}`);
    res.writeHead(503);
    res.end("unavailable");
  });
  const data = fresh("flags");
  mkdirSync(join(data, "wallets"));
  writeFileSync(join(data, "wallets", "op.json"), JSON.stringify({ seed: hex32(), btcKey: hex32(), pending: [] }));
  const env = { MURKLE_DATA_DIR: data, MURKLE_ESPLORA: `${esplora}/api` };
  const treasury = btcAccount(randomBytes(32)).address;
  const deploy = ["deploy", "op", "--ticker", "TYPOX", "--amount", "100", "--cap", "1000"];
  for (const [args, re] of [
    [[...deploy, "--treasury", treasury, "--prcie", "5000"], /unknown flag --prcie/],
    [[...deploy, "--start", "330000", "--ned", "331000"], /unknown flag --ned/],
    [[...deploy, "--price", "5000", "--price", "6000", "--treasury", treasury], /--price given twice/],
    [[...deploy, "--treasury", treasury], /--treasury goes with --price/],
    [[...deploy, "extra"], /unexpected argument "extra"/],
    [["attest", "genesis", "op", "--dryrun", "--force"], /unknown flag --dryrun/],
    [["attest", "genesis", "op", "--dry-run=1", "--force"], /--dry-run takes no value/],
    [["attest", "genesis", "op", "--dry_run", "--force"], /unknown flag --dry_run/],
  ]) {
    const r = await run(args, env);
    assert.equal(r.code, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re, args.join(" "));
    assert.doesNotMatch(r.stdout, /broadcast/);
  }
  assert.deepEqual(seen, [], "nothing was fetched or broadcast");
  assert.ok(cli.HELP.includes("  attest genesis <w> [--dry-run] [--force]"));
});

// ------------------------------------------------------------------ V2-37 self-paid send

test("V2-37: a self-paid send checks its amount before syncing, and records its W-1 entry before the broadcast", async () => {
  const seen = [];
  const esplora = await serve((req, res, p) => {
    seen.push(p);
    res.writeHead(503);
    res.end("unavailable");
  });
  const data = fresh("send");
  mkdirSync(join(data, "wallets"));
  writeFileSync(join(data, "wallets", "w.json"), JSON.stringify({ seed: hex32(), btcKey: hex32(), pending: [] }));
  const to = encodeAddress(deriveKeys(randomBytes(32)));
  for (const amount of ["0", "0x10", "-5", "1e3", " 5", "", "5.0"]) {
    const r = await run(["send", "w", "GHOST", amount, to], { MURKLE_DATA_DIR: data, MURKLE_ESPLORA: `${esplora}/api` });
    assert.equal(r.code, 1, `"${amount}"`);
    assert.match(r.stderr, /amount must be a whole number above 0/, `"${amount}"`);
  }
  assert.deepEqual(seen, [], "refused before syncing");
  // The order in the command itself: the entry is saved, then the carrier is broadcast.
  const src = read("bin/murkle.mjs").replace(/\r\n/g, "\n");
  const send = src.slice(src.indexOf("  async send(args) {"), src.indexOf("  /** Lists pending envelopes"));
  const saveAt = send.indexOf("file.pending.push({ txid: tx.txid, spends: envelope.spends, anchor });\n    save();");
  assert.ok(saveAt > 0 && saveAt < send.indexOf('await broadcast(tx, "TRANSACT")'), "W-1 entry before the broadcast");
  assert.match(send, /may still have reached the network, so its notes stay reserved/);
});

// ------------------------------------------------------------------ V2-09 send-btc

test("V2-09: send-btc plans with planPayment: no dust change, the destination's dust limit, no early stop, a real fee rate", () => {
  const key = randomBytes(32);
  const account = btcAccount(key);
  const to = btcAccount(randomBytes(32)).address;
  const utxo = (value, i = 0) => ({ txid: randomBytes(32).toString("hex"), vout: i, value });
  const outs = (tx) => Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));

  // One 10,000-sat coin, send 9,700: the 145-sat remainder goes to the fee, never to a dust output.
  for (const amount of [9700n, 9845n]) {
    const plan = planSend({ account, utxos: [utxo(10_000)], to, amount, feeRate: 1 });
    assert.deepEqual(outs(plan.tx).map((o) => o.amount), [amount], `${amount}: no change output`);
    assert.equal(plan.fee, 10_000n - amount);
  }
  // Change of 330 sats or more is kept.
  const kept = planSend({ account, utxos: [utxo(20_000)], to, amount: 9000n, feeRate: 1 });
  assert.equal(outs(kept.tx).length, 2);
  assert.ok(outs(kept.tx).every((o) => o.amount >= dustLimit(o.script)));
  // A 400-sat payment to P2PKH (dust limit 546) is refused.
  const p2pkh = btc.Address(btc.TEST_NETWORK).encode({ type: "pkh", hash: new Uint8Array(20).fill(1) });
  assert.equal(dustLimit(scriptOf(p2pkh)), 546n);
  assert.throws(() => planSend({ account, utxos: [utxo(10_000)], to: p2pkh, amount: 400n, feeRate: 1 }), /below the 546-sat dust limit/);
  // 40 coins of 1,000 sats, send 15,000: priced input by input, no stop at total >= amount + 1000.
  const many = Array.from({ length: 40 }, (_, i) => utxo(1000, i));
  const big = planSend({ account, utxos: many, to, amount: 15_000n, feeRate: 1 });
  assert.ok(big.tx.inputsLength >= 17, `${big.tx.inputsLength} inputs`);
  // The fee follows the rate.
  const at5 = planSend({ account, utxos: [utxo(100_000)], to, amount: 10_000n, feeRate: 5 });
  assert.ok(at5.fee >= 5n * 154n, `fee ${at5.fee} at 5 sat/vB`);
  // A sweep is priced at the rate and refused below the dust limit.
  const sweep = planSend({ account, utxos: [utxo(10_000), utxo(5_000, 1)], to, amount: "max", feeRate: 2 });
  assert.equal(outs(sweep.tx).length, 1);
  assert.equal(sweep.fee, 2n * 169n);
  assert.equal(sweep.amount, 15_000n - sweep.fee);
  assert.throws(() => planSend({ account, utxos: [utxo(400)], to, amount: "max", feeRate: 1 }), /below the 330-sat dust limit/);
  // Signed, the planned sweep is exactly the size it was priced at.
  sweep.tx.sign(key);
  sweep.tx.finalize();
  assert.ok(sweep.tx.vsize <= 169);

  assert.deepEqual(parseSendArgs(["w", to, "max", "--fee-rate", "3"]), { wallet: "w", to, amount: "max", feeRate: 3 });
  assert.deepEqual(parseSendArgs(["w", to, "500"]), { wallet: "w", to, amount: 500n, feeRate: null });
  for (const bad of [["w", to, "0"], ["w", to, "1e3"], ["w", to], ["w", to, "5", "--fee-rate", "0"], ["w", to, "5", "--feerate", "2"]]) {
    assert.throws(() => parseSendArgs(bad), /usage: send-btc\.mjs/, bad.join(" "));
  }
  const src = read("scripts/send-btc.mjs");
  assert.match(src, /env\("DATA_DIR"\)/, "the wallet file honours MURKLE_DATA_DIR");
  assert.match(read("scripts/demo-a6-copy.mjs"), /envVar\("DATA_DIR"\)/);
});

// ------------------------------------------------------------------ V2-39 capped download

test("V2-39: downloadCapped refuses a declared oversize body and cuts an undeclared one at the cap", async () => {
  const base = await serve((req, res, p) => {
    if (p === "/declared") {
      res.writeHead(200, { "content-length": "5000" });
      return res.end(Buffer.alloc(5000));
    }
    if (p === "/exact") return res.end(Buffer.alloc(1000, 7));
    // No Content-Length, and far more than the cap: written in chunks until the client goes away.
    res.writeHead(200, { "transfer-encoding": "chunked" });
    let sent = 0;
    const push = () => {
      while (sent < 64 * 1024 * 1024 && res.write(Buffer.alloc(16 * 1024))) sent += 16 * 1024;
      if (sent < 64 * 1024 * 1024) res.once("drain", push);
      else res.end();
    };
    res.on("error", () => {});
    push();
  });
  const dir = fresh("download");
  const path = join(dir, "x.part");
  await assert.rejects(downloadCapped(`${base}/declared`, path, { maxBytes: 1000 }), /larger than 1000 bytes \(Content-Length 5000\)/);
  assert.ok(!existsSync(path), "nothing written");
  await assert.rejects(downloadCapped(`${base}/endless`, path, { maxBytes: 100_000 }), /larger than 100000 bytes/);
  assert.ok(!existsSync(path), "the partial file is removed");
  assert.equal(await downloadCapped(`${base}/exact`, path, { maxBytes: 1000 }), 1000);
  assert.equal(readFileSync(path).length, 1000);
  await assert.rejects(downloadCapped(`${base}/exact`, path, { maxBytes: 0 }), /needs maxBytes/);

  const build = read("scripts/build-circuit.mjs");
  assert.match(build, /downloadCapped\(url, part, \{ maxBytes: PTAU\.size/);
  assert.doesNotMatch(build, /pipeline\(Readable\.fromWeb/);
});

// ------------------------------------------------------------------ V2-38 image, V2-01 dependencies

test("V2-38: .dockerignore keeps every .gitignore secret pattern out; the image code is root-owned", () => {
  const docker = read(".dockerignore").split("\n");
  for (const p of ["**/mnemonic*", "**/seed*.txt", "**/*.swp", "**/*~", "**/*.key", "**/wallets", "**/relay-balance", "**/.env", "**/.env.*", "data", "build"]) {
    assert.ok(docker.includes(p), `.dockerignore: ${p}`);
  }
  const df = read("Dockerfile");
  assert.match(df, /^COPY --from=build \/app \/app$/m);
  assert.doesNotMatch(df, /--chown=node:node \/app \/app/);
  assert.match(df, /chown -R node:node \/app\/data \/app\/build/);
  assert.ok(df.indexOf("chown -R node:node") < df.indexOf("USER node"));
});

test("V2-01: vite is pinned at a patched 6.x (>= 6.4.3) and underscore at 1.13.8; npm audit has nothing high to report", () => {
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const ver = (v) => v.replace(/^[\^~]/, "").split(".").map(Number);
  const atLeast = (v, min) => {
    const [a, b] = [ver(v), ver(min)];
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
  };
  assert.ok(atLeast(pkg.devDependencies.vite, "6.4.3"), pkg.devDependencies.vite);
  assert.ok(atLeast(lock.packages["node_modules/vite"].version, "6.4.3"), lock.packages["node_modules/vite"].version);
  assert.equal(pkg.overrides?.underscore, "1.13.8");
  assert.equal(lock.packages["node_modules/underscore"].version, "1.13.8");
  assert.equal(lock.packages[""].devDependencies.vite, pkg.devDependencies.vite);
});

test("my files keep their line endings and are English only", () => {
  const crlf = ["bin/murkle.mjs", "scripts/build-circuit.mjs", "scripts/demo-a6-copy.mjs"];
  const lf = ["scripts/send-btc.mjs", "scripts/artifacts-lib.mjs", ".dockerignore", "Dockerfile", "package.json", "package-lock.json", "test/audit2-tooling.test.mjs"];
  for (const f of [...crlf, ...lf]) {
    const b = read(f);
    const lines = b.split("\n").length - 1;
    const crlfs = b.split("\r\n").length - 1;
    assert.equal(crlfs, crlf.includes(f) ? lines : 0, f);
    assert.ok(!/[\u0400-\u04FF]/.test(b), `${f}: English only`);
  }
});

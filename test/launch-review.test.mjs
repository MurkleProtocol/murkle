// Mainnet-launch review regressions (2026-10-06): the money paths and the copy that changed after
// the second review of the mainnet preparation. Header-chain, receipt-bound and ceremony regressions
// live next to their code's tests (test/headers.test.mjs, test/ceremony.test.mjs).
//
// Offline: fakes and temporary directories only. Nothing touches data/, nothing is broadcast.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256 } from "@noble/hashes/sha256";
import { Esplora } from "../src/btc/esplora.mjs";
import { decodeHeader, encodeHeader, targetFromBits } from "../src/btc/headers.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { concat, hex, unhex } from "../src/bytes.mjs";
import { accountMod, chain, makeFakeEsplora, makePaidRelayer, newAccount, rawPayment, relayerMod, silent } from "./fixtures/relay-harness.mjs";
import * as backup from "../deploy/bin/backup.mjs";
import * as monitor from "../deploy/bin/monitor.mjs";
import { cspEnforced, relayerRefusal } from "../server/indexer-server.mjs";
import { cardNetwork, poolCardText, receiptCardText } from "../web/src/verify/share-card.js";
import { checkWalletNetwork, walletNetworkOf } from "../bin/murkle.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const DIR = mkdtempSync(join(tmpdir(), "murkle-launch-review-"));
const relayers = [];
after(() => {
  relayers.forEach((r) => r.close?.());
  rmSync(DIR, { recursive: true, force: true });
});

function child(code, env = {}) {
  return new Promise((done, fail) => {
    execFile(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { ...process.env, ...env }, timeout: 120_000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) return fail(new Error(`${err.message}\n${stderr}`));
      done(JSON.parse(stdout.trim().split("\n").pop()));
    });
  });
}
function run(args, env = {}) {
  return new Promise((done) => {
    execFile(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, timeout: 120_000 }, (err, stdout, stderr) => done({ code: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}
async function withFetch(f, fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = saved;
  }
}
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/* ------------------------------------------------- Esplora fee estimates */

test("Esplora: an empty /fee-estimates is 1 sat/vB on signet only; mainnet refuses to guess (as the bitcoind source)", async () => {
  const quiet = async (url) => (String(url).endsWith("/fee-estimates") ? json({}) : new Response("nf", { status: 404 }));
  await withFetch(quiet, async () => {
    const sig = new Esplora("http://127.0.0.1:3002", { retries: 0, network: "signet" });
    assert.equal(await sig.feeRate(), 1);
    assert.equal(await sig.nextBlockFeeRate(), 1);
    const main = new Esplora("http://127.0.0.1:3002", { retries: 0, network: "mainnet" });
    await assert.rejects(main.feeRate(), /no fee estimate yet; refusing to guess a fee rate on mainnet/);
    await assert.rejects(main.nextBlockFeeRate(), /no fee estimate yet; refusing to guess a fee rate on mainnet/);
  });
  // With estimates, both networks read them the same way.
  await withFetch(async () => json({ 1: 31.2, 3: 12.5 }), async () => {
    assert.equal(await new Esplora("http://127.0.0.1:3002", { retries: 0, network: "mainnet" }).feeRate(), 13);
    assert.equal(await new Esplora("http://127.0.0.1:3002", { retries: 0, network: "mainnet" }).nextBlockFeeRate(), 32);
  });
  // This build's network is the default (signet here); the chain source factory passes its network.
  assert.equal(new Esplora().network, "signet");
  const src = readFileSync(join(ROOT, "src/btc/source.mjs"), "utf8");
  assert.match(src, /new Esplora\(esploraUrl \|\| esploraFor\(network\), \{ network \}\)/);
});

/* ------------------------------------------------- relayer deposits (verified) */

/** A one-transaction block header for `raw` on top of `prevHash`, at regtest difficulty. */
function blockFor(raw, prevHash) {
  const { txid } = parseRawTx(raw);
  for (let nonce = 0; ; nonce++) {
    const bytes = encodeHeader({ version: 4, prevHash, merkleRoot: txid, time: 1_800_000_000, bits: 0x207fffff, nonce });
    const d = decodeHeader(bytes);
    if (BigInt("0x" + d.hash) <= targetFromBits(0x207fffff).target) return { header: d, txid, block: concat(bytes, Uint8Array.of(1), unhex(raw)) };
  }
}

async function verifiedWorld() {
  const esplora = makeFakeEsplora({ fee: 1 });
  const c = chain({ start: 864_000, fakes: [esplora] });
  await c.mine();
  const r = await makePaidRelayer({ idx: c.idx, esplora, config: { verifyDeposits: true } });
  relayers.push(r);
  await r.onTick({ chainTip: c.idx.height });
  const blocks = new Map(); // hash -> { header, block }
  esplora.blockHeader = async (hash) => hex(blocks.get(hash).header.bytes);
  esplora.merkleProof = async (txid) => {
    const st = esplora.status.get(txid);
    return { block_height: st.block_height, merkle: [], pos: 0 };
  };
  esplora.status = new Map();
  esplora.txStatus = async (txid) => esplora.status.get(txid) ?? { confirmed: false };
  esplora.rawBlock = async (hash) => blocks.get(hash).block;
  /** A deposit to `dep` mined in its own block, applied by the indexer: returns { txid, height, hash }. */
  const mineDeposit = async (dep, value) => {
    const raw = rawPayment([{ script: dep.script, value }]);
    const height = c.idx.height + 1;
    const b = blockFor(raw, c.idx.hashes.get(c.idx.height));
    blocks.set(b.header.hash, b);
    await c.idx.applyBlock({ height, hash: b.header.hash, txs: [parseRawTx(raw)] });
    esplora.txs.set(b.txid, raw);
    esplora.mined.set(b.txid, height);
    esplora.status.set(b.txid, { confirmed: true, block_height: height, block_hash: b.header.hash });
    esplora.tip = Math.max(esplora.tip, height);
    return { txid: b.txid, height, hash: b.header.hash, raw };
  };
  return { esplora, c, r, mineDeposit };
}

const creditOf = (r, account, txid, n, ip = "203.0.113.20") => r.credit(JSON.stringify({ outpoint: `${txid}:0`, accountPub: account.pubHex, n }), ip);

test("relayer (verifyDeposits): credits only a deposit proven inside a block the indexer applied, depth from the indexer's height", async () => {
  const { esplora, c, r, mineDeposit } = await verifiedWorld();
  const a = newAccount();
  const dep0 = accountMod.depositAddress(r.Q, a.id, 0, "signet");
  const good = await mineDeposit(dep0, 7000);
  await r.onTick({ chainTip: c.idx.height });
  const ok = await creditOf(r, a, good.txid, 0);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.height, good.height);

  // A deposit that was never mined: the source claims a block at a height the indexer applied, but
  // it is another block (or the merkle path does not reach the applied header).
  const dep1 = accountMod.depositAddress(r.Q, a.id, 1, "signet");
  const forgedRaw = rawPayment([{ script: dep1.script, value: 50_000 }]);
  const forged = parseRawTx(forgedRaw).txid;
  esplora.txs.set(forged, forgedRaw);
  esplora.status.set(forged, { confirmed: true, block_height: good.height, block_hash: "ab".repeat(32) });
  let out = await creditOf(r, a, forged, 1);
  assert.equal(out.body?.error?.code, "deposit_unknown", JSON.stringify(out.body));
  esplora.status.set(forged, { confirmed: true, block_height: good.height, block_hash: good.hash });
  r.creditMiss?.clear?.();
  out = await creditOf(r, a, forged, 1, "203.0.113.21");
  assert.equal(out.body?.error?.code, "deposit_unknown", "the merkle path does not lead to the applied header");
  // Without a merkle-proof endpoint the raw block of the applied height decides: still refused.
  const savedProof = esplora.merkleProof;
  esplora.merkleProof = undefined;
  out = await creditOf(r, a, forged, 1, "203.0.113.22");
  assert.equal(out.body?.error?.code, "deposit_unknown");
  esplora.merkleProof = savedProof;
  // A height the indexer has not applied yet (the source's tip runs ahead): not confirmed, whatever the source's tip.
  esplora.status.set(forged, { confirmed: true, block_height: c.idx.height + 1, block_hash: "cd".repeat(32) });
  esplora.tip = c.idx.height + 50;
  out = await creditOf(r, a, forged, 1, "203.0.113.23");
  assert.deepEqual([out.body?.error?.code, out.body?.error?.confirmations], ["deposit_unconfirmed", 0]);
  assert.equal(r.books.isCredited(`${forged}:0`), null, "nothing was credited");

  // A real deposit via the raw-block path.
  esplora.merkleProof = undefined;
  const dep2 = accountMod.depositAddress(r.Q, a.id, 2, "signet");
  const viaBlock = await mineDeposit(dep2, 8000);
  const ok2 = await creditOf(r, a, viaBlock.txid, 2, "203.0.113.24");
  assert.equal(ok2.status, 200, JSON.stringify(ok2.body));

  // A credited deposit that the source later places in a block the indexer did not apply is frozen.
  esplora.status.set(good.txid, { confirmed: true, block_height: good.height, block_hash: "ef".repeat(32) });
  r.state.coins[`${good.txid}:0`].height = c.idx.height; // shallow: re-checked
  await r.checkCredits();
  assert.equal(r.state.coins[`${good.txid}:0`].reorged, true);
  assert.equal(r.state.coins[`${good.txid}:0`].confirmed, false);
});

test("relayer config: verifyDeposits is on by default off signet and cannot be turned off on mainnet; a relay dir of the other network is refused", async () => {
  const { DEFAULTS, balanceProblems, relayDirNetwork, NETWORK_DEFAULTS } = relayerMod;
  assert.equal(DEFAULTS.verifyDeposits, false, "signet keeps the earlier credit path unless switched on");
  assert.equal(relayDirNetwork("/var/lib/murkle/signet/relay-balance"), "signet");
  assert.equal(relayDirNetwork(["D:", "murkle", "mainnet", "relay-balance"].join(String.fromCharCode(92))), "mainnet");
  assert.equal(relayDirNetwork("data/relay-balance"), null);
  assert.deepEqual(balanceProblems({ ...DEFAULTS }), []);
  assert.match(balanceProblems({ ...DEFAULTS, relayDir: "/var/lib/murkle/mainnet/relay-balance" }).join(), /is a mainnet directory, but this relayer runs on signet/);
  const m = await child(`
    const R = await import("./server/relayer.mjs");
    console.log(JSON.stringify({
      verify: R.DEFAULTS.verifyDeposits,
      off: R.balanceProblems({ ...R.DEFAULTS, verifyDeposits: false }),
      signetDir: R.balanceProblems({ ...R.DEFAULTS, relayDir: "/var/lib/murkle/signet/relay-balance" }),
      ok: R.balanceProblems({ ...R.DEFAULTS, relayDir: "/var/lib/murkle/mainnet/relay-balance" }),
    }));`, { MURKLE_NETWORK: "mainnet" });
  assert.equal(m.verify, true);
  assert.match(m.off.join(), /cannot be turned off on mainnet/);
  assert.match(m.signetDir.join(), /is a signet directory, but this relayer runs on mainnet/);
  assert.deepEqual(m.ok, []);
  assert.equal(NETWORK_DEFAULTS.mainnet.minDepositSats, 70_000);
});

/* ------------------------------------------------- server: CSP and the pre-genesis relayer */

test("server: the CSP is enforced by default off signet; the relayer stays off on a network that has not launched", () => {
  const read = (v) => (name) => (name === "CSP_ENFORCE" ? v : undefined);
  assert.equal(cspEnforced({ read: read(undefined), test: true }), false, "signet: Report-Only, as before");
  assert.equal(cspEnforced({ read: read(undefined), test: false }), true, "mainnet: enforced unless turned off");
  assert.equal(cspEnforced({ read: read(""), test: false }), true, "an empty compose value is unset");
  assert.equal(cspEnforced({ read: read("0"), test: false }), false);
  assert.equal(cspEnforced({ read: read("1"), test: true }), true);
  assert.match(relayerRefusal({ network: "mainnet", test: false, preGenesis: true, allowRelayer: false }), /^relayer off: Murkle has not launched on mainnet/);
  assert.equal(relayerRefusal({ network: "mainnet", test: false, preGenesis: true, allowRelayer: true }), null);
  assert.equal(relayerRefusal({ network: "mainnet", test: false, preGenesis: false }), null);
  assert.equal(relayerRefusal({ network: "signet", test: true, preGenesis: true }), null);
  const compose = readFileSync(join(ROOT, "deploy/docker/docker-compose.yml"), "utf8");
  assert.match(compose, /MURKLE_CSP_ENFORCE: \$\{MURKLE_CSP_ENFORCE:-\}/);
  const env = readFileSync(join(ROOT, "deploy/docker/compose.env.example"), "utf8");
  assert.ok(!/^MURKLE_CSP_ENFORCE=0$/m.test(env), "the compose example does not force Report-Only");
  assert.match(env, /^# MURKLE_CSP_ENFORCE=1$/m, "the mainnet block names the switch");
});

/* ------------------------------------------------- backups and the monitor */

test("backup --require-relayer (or MURKLE_RELAYER=1) fails without the relayer's keys; the monitor alerts on a missing or old backup", () => {
  const data = join(DIR, "node");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "state.json"), "{}");
  const { pubText } = backup.generateKey();
  const out = join(DIR, "bk");
  assert.throws(() => backup.runBackup({ recipient: pubText, dataDir: data, outDir: out, network: "mainnet", requireRelayer: true }), /the paid relayer is on, but .* has no relay-balance\/pool\.key, relay-balance\/change\.key, relay-balance\/relayer\.json/);
  assert.equal(existsSync(out) ? backup.listBackups(out, "mainnet").length : 0, 0, "nothing written");
  const lines = [];
  assert.equal(backup.main(["backup", "--data", data, "--out", out, "--network", "mainnet"], { env: { MURKLE_BACKUP_RECIPIENT: pubText, MURKLE_RELAYER: "1" }, print: (s) => lines.push(s), error: (s) => lines.push(s) }), 1);
  assert.equal(backup.main(["backup", "--data", data, "--out", out, "--network", "mainnet", "--require-relayer"], { env: { MURKLE_BACKUP_RECIPIENT: pubText }, print: () => {}, error: () => {} }), 1);
  // Without the relayer it still backs up what is there.
  assert.equal(backup.main(["backup", "--data", data, "--out", out, "--network", "mainnet"], { env: { MURKLE_BACKUP_RECIPIENT: pubText }, print: () => {}, error: () => {} }), 0);
  mkdirSync(join(data, "relay-balance"));
  for (const f of ["pool.key", "change.key"]) writeFileSync(join(data, "relay-balance", f), "00".repeat(32));
  writeFileSync(join(data, "relay-balance", "relayer.json"), "{}");
  const r = backup.runBackup({ recipient: pubText, dataDir: data, outDir: out, network: "mainnet", requireRelayer: true });
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["relay-balance/change.key", "relay-balance/pool.key", "relay-balance/relayer.json", "state.json"]);

  const now = Date.parse("2026-10-06T12:00:00Z");
  const none = monitor.evaluateBackups({ dir: "/b", files: [], now, relayerOn: true });
  assert.deepEqual(none.alerts.map((a) => [a.level, a.code]), [["critical", "no_backup"]]);
  assert.equal(monitor.evaluateBackups({ dir: "/b", files: [], now, relayerOn: false }).alerts[0].level, "warning");
  const old = monitor.evaluateBackups({ dir: "/b", files: [{ name: "murkle-backup-mainnet-2026-10-06T06-00-00-000Z.mbk", mtimeMs: now - 6 * 3600_000 }], now, relayerOn: true });
  assert.deepEqual(old.alerts.map((a) => a.code), ["backup_old"]);
  const fresh = monitor.evaluateBackups({ dir: "/b", files: [{ name: "murkle-backup-mainnet-x.mbk", mtimeMs: now - 600_000 }, { name: "notes.txt", mtimeMs: now }], now, relayerOn: true });
  assert.deepEqual([fresh.alerts, fresh.summary.count], [[], 1]);
  assert.equal(monitor.parseOptions([], { MURKLE_BACKUP_DIR: "/var/backups/murkle" }).backupDir, "/var/backups/murkle");
  // The ceremony coordinator's stale chain is critical while its queue is open.
  const c = monitor.evaluateCeremony({ health: { ok: false, phase: "open", chain: { stale: true, lastOkAt: "2026-10-06T11:00:00.000Z" } } });
  assert.deepEqual(c.alerts.map((a) => [a.level, a.code]), [["critical", "ceremony_chain_stale"]]);
});

/* ------------------------------------------------- share cards per network */

test("share cards: signet keeps its words; mainnet never says signet, test coins or development keys", async () => {
  const receipt = { opName: "TRANSFER", verdict: "verified", rootSource: "replay", proofMs: 900 };
  assert.equal(receiptCardText({ ...receipt, network: "signet", notLaunched: false }).footer, "Signet: test coins with no value. Development proving keys (A-8). Bitcoin stores the proof; browsers check it.");
  assert.equal(receiptCardText({ ...receipt, opName: "DEPLOY", network: "signet", notLaunched: false }).footer, "Signet: test coins with no value. Bitcoin stores the envelope; browsers check it.");
  assert.equal(cardNetwork({ network: "signet" }).tag, "SIGNET");
  assert.doesNotMatch(cardNetwork({ network: "signet" }).poolFooter, /not checked yet/, "A-9 header checks exist on signet too");
  const pool = { proofs: 3, blocks: 10, seconds: 4, height: 900_010, digest: "ab".repeat(32), matched: true };
  assert.match(poolCardText({ ...pool, network: "signet", notLaunched: false }), /across 10 Bitcoin signet blocks \(test network, no value\) in 4 s/);
  for (const notLaunched of [false, true]) {
    const all = [
      receiptCardText({ ...receipt, network: "mainnet", notLaunched }).footer,
      receiptCardText({ ...receipt, opName: "DEPLOY", network: "mainnet", notLaunched }).footer,
      poolCardText({ ...pool, network: "mainnet", notLaunched }),
      cardNetwork({ network: "mainnet", notLaunched }).poolFooter,
      cardNetwork({ network: "mainnet", notLaunched }).tag,
    ].join("\n");
    assert.doesNotMatch(all, /signet|test coins|no value|Development proving keys|not checked yet/i, all);
  }
  assert.equal(cardNetwork({ network: "mainnet", notLaunched: true }).tag, "MAINNET · NOT LAUNCHED");
  assert.equal(cardNetwork({ network: "mainnet", notLaunched: false }).tag, "MAINNET");
  assert.match(receiptCardText({ ...receipt, network: "mainnet", notLaunched: false }).footer, /^Bitcoin mainnet, experimental software\. Proving keys from the public trusted-setup ceremony\./);
  // A mainnet build (pre-genesis) uses its own words by default.
  const m = await child(`
    const S = await import("./web/src/verify/share-card.js");
    console.log(JSON.stringify({ tag: S.cardNetwork().tag, footer: S.receiptCardText({ opName: "TRANSFER", verdict: "verified" }).footer, pool: S.poolCardText({ proofs: 1, blocks: 1, seconds: 1, height: 1, digest: "00", matched: true }) }));`, { MURKLE_NETWORK: "mainnet" });
  assert.equal(m.tag, "MAINNET · NOT LAUNCHED");
  assert.match(m.footer, /has not launched on Bitcoin mainnet/);
  assert.doesNotMatch(`${m.footer}\n${m.pool}`, /signet|test coins|no value/i);
});

/* ------------------------------------------------- the web wallet's indexer network */

test("web: an indexer of another network is refused by state(), useIndexer() and the connection test", async () => {
  const api = await import("../web/src/api.js");
  const { testIndexer } = await import("../web/src/ui/indexer.js");
  const mainnetState = { network: "mainnet", height: 950_000, outputs: 0, startHeight: 900_000 };
  try {
    await withFetch(async () => json(mainnetState), async () => {
      await assert.rejects(api.useIndexer("http://mainnet-indexer.test"), (e) => e.code === "wrong_network" && /serves Bitcoin mainnet, but this site is built for Bitcoin signet/.test(e.message));
      assert.equal(api.indexerBase(), "", "the old indexer is kept");
      api.setIndexerBase("http://stale-setting.test"); // a stored URL from before
      await assert.rejects(api.state({ fresh: true }), (e) => e.code === "wrong_network");
      const t = await testIndexer("http://mainnet-indexer.test", { getJson: async () => mainnetState, ourHeight: 1, ourRootAt: async () => "1" });
      assert.equal(t.ok, false);
      assert.match(t.text, /Can't use it: That indexer serves Bitcoin mainnet/);
    });
    // An indexer without the field is a signet one; the right network is taken.
    await withFetch(async () => json({ height: 5, outputs: 0, startHeight: 1 }), async () => {
      await api.useIndexer("http://old-signet-indexer.test");
      assert.equal(api.indexerBase(), "http://old-signet-indexer.test");
      assert.equal((await api.state({ fresh: true })).height, 5);
    });
  } finally {
    api.setIndexerBase("");
  }
  const settings = readFileSync(join(ROOT, "web/src/views/app-settings.js"), "utf8");
  assert.match(settings, /await api\.useIndexer\(/);
  assert.match(settings, /api\.checkStateNetwork\(theirs\)/);
});

/* ------------------------------------------------- CLI wallet files per network */

test("CLI: a new mainnet wallet file names its network; a file of another network is refused", async () => {
  assert.equal(walletNetworkOf({ seed: "00" }), "signet", "files from before the field are signet ones");
  assert.equal(walletNetworkOf({ network: "mainnet" }), "mainnet");
  assert.throws(() => checkWalletNetwork({ seed: "00" }, "alice", "mainnet"), /wallet "alice" belongs to Bitcoin signet, and this is mainnet/);
  assert.throws(() => checkWalletNetwork({ network: "mainnet" }, "bob", "signet"), /belongs to Bitcoin mainnet, and this is signet/);
  checkWalletNetwork({ seed: "00" }, "carol", "signet");
  // One data directory used for both networks (the failure the check exists for).
  const data = join(DIR, "cli-shared");
  const made = await run(["bin/murkle.mjs", "new", "dora"], { MURKLE_NETWORK: "mainnet", MURKLE_DATA_DIR: data });
  assert.equal(made.code, 0, made.stderr);
  assert.match(made.stdout, /BTC fee address: bc1p/);
  const file = JSON.parse(readFileSync(join(data, "wallets", "dora.json"), "utf8"));
  assert.equal(file.network, "mainnet");
  const onSignet = await run(["bin/murkle.mjs", "address", "dora"], { MURKLE_NETWORK: "signet", MURKLE_DATA_DIR: data });
  assert.equal(onSignet.code, 1);
  assert.match(onSignet.stderr, /wallet "dora" belongs to Bitcoin mainnet, and this is signet/);
  assert.doesNotMatch(onSignet.stdout, /tb1p/, "no signet address is printed for the mainnet key");
  const sig = await run(["bin/murkle.mjs", "new", "erin"], { MURKLE_NETWORK: "signet", MURKLE_DATA_DIR: data });
  assert.equal(sig.code, 0, sig.stderr);
  assert.equal(JSON.parse(readFileSync(join(data, "wallets", "erin.json"), "utf8")).network, undefined, "signet files keep their earlier shape");
  const onMain = await run(["bin/murkle.mjs", "address", "erin"], { MURKLE_NETWORK: "mainnet", MURKLE_DATA_DIR: data });
  assert.equal(onMain.code, 1);
  assert.match(onMain.stderr, /belongs to Bitcoin signet, and this is mainnet/);
});

/* ------------------------------------------------- files */

test("files changed by this review: line endings kept, English only, honest copy", () => {
  const crlf = ["src/verify-tx.mjs", "src/btc/esplora.mjs", "bin/murkle.mjs", "web/src/views/verify.js"];
  const lf = [
    "src/btc/headers.mjs", "server/relayer.mjs", "server/indexer-server.mjs", "server/ceremony-server.mjs", "web/src/api.js", "web/src/ui/indexer.js",
    "web/src/verify/share-card.js", "web/src/views/app-settings.js", "web/src/views/security.js", "web/src/ceremony/main.js", "web/src/ceremony/receipt.js",
    "scripts/ceremony/lib.mjs", "scripts/ceremony/verify.mjs", "scripts/ceremony/finalize.mjs", "scripts/ceremony/admin.mjs", "scripts/ceremony/contribute.mjs",
    "deploy/bin/backup.mjs", "deploy/bin/monitor.mjs", "deploy/systemd/murkle-backup@.path", "deploy/systemd/murkle-backup.service.d/relayer.conf.example",
    "test/launch-review.test.mjs",
  ];
  const banned = new RegExp(`\\b(${["anony" + "mous", "untrace" + "able", "trust" + "less", "mix" + "er", "audit" + "ed"].join("|")})\\b`, "i");
  for (const f of [...crlf, ...lf]) {
    const s = readFileSync(join(ROOT, f), "latin1");
    const n = (s.match(/\n/g) ?? []).length;
    const c = (s.match(/\r\n/g) ?? []).length;
    assert.equal(c, crlf.includes(f) ? n : 0, f);
    assert.doesNotMatch(readFileSync(join(ROOT, f), "utf8"), /[\u0400-\u04FF]/, f);
    // security.js states the copy rules themselves (it names the banned words in a comment).
    if (!f.startsWith("test/") && f !== "web/src/views/security.js") assert.doesNotMatch(s, banned, f);
  }
});

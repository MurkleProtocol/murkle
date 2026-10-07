// Server fixes (numbered tests refer to findings of an internal review): a malformed request
// target or a vanished file never crashes the process, bulk bodies are cached,
// the dev server serves only web/, src/ and node_modules/, and the relayer's
// coin handling, reorg reconcile, fan-out recovery, coin pruning and durable
// writes. The relayer is the paid one (relay balances): its coins are credited
// deposits and its own change, tracked by outpoint, never listed by address.
// Fake esplora and stub indexers: nothing touches a network and nothing is ever
// broadcast for real.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { Indexer } from "../src/indexer.mjs";
import { hex, unhex } from "../src/bytes.mjs";
import { createApp } from "../server/indexer-server.mjs";
import { Relayer, writeDurable } from "../server/relayer.mjs";
import { FakeEsplora, fundAccount, newAccount, poolCoins } from "./fixtures/relay-harness.mjs";

/** A free TCP port on localhost, from the OS (port 0), released before the caller binds it. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "localhost", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VKEY = JSON.parse(readFileSync(join(ROOT, "build/dev/verification_key.json"), "utf8"));
const DIR = mkdtempSync(join(tmpdir(), "murkle-fix-server-"));
const hash32 = () => randomBytes(32).toString("hex");
const silent = { warn() {}, error() {}, log() {} };
const relayers = [];

after(async () => {
  relayers.forEach((r) => r.close());
  rmSync(DIR, { recursive: true, force: true });
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

// ------------------------------------------------------------------ helpers

/** Just the indexer fields the relayer reads: heights, hashes, roots, nullifiers, log. */
function stubIdx(height) {
  const idx = { height, hashes: new Map(), roots: new Map(), nullifiers: new Set(), log: [] };
  for (let h = height - 3; h <= height; h++) {
    idx.hashes.set(h, hash32());
    idx.roots.set(h, BigInt(h));
  }
  return idx;
}

/** A paid relayer with new keys (kept in memory unless a statePath is given). `keys` reloads the same relayer. */
function newRelayer(idx, esplora, config = {}, keys = { poolKey: new Uint8Array(randomBytes(32)), changeKey: new Uint8Array(randomBytes(32)) }) {
  const r = new Relayer({ idx, esplora, ...keys, config: { statePath: null, fanoutTarget: 0, minMix: 0, ...config }, log: silent, fastDelayMs: () => 60_000 });
  r.keys = keys;
  relayers.push(r);
  return r;
}

/**
 * Pool coins at C of `values` for one relay account: deposits credited to it and merged into C
 * (carriers never spend a deposit), confirmed. Returns the account and the C coins' outpoints.
 */
async function fund(r, esplora, values) {
  const { account, outpoints, merges } = await poolCoins({ relayer: r, esplora, values, height: r.idx.height });
  r.payer = account;
  return { account, outpoints, merges };
}
const isCarrier = (raw) => btc.Transaction.fromRaw(unhex(raw), { allowUnknownOutputs: true }).getOutput(0).script[0] === 0x6a;

/** A queued item with a synthetic 471-byte envelope (carry() never decodes it), reserved from r.payer. */
function queue(r, idx, reservation = 658) {
  const id = randomBytes(16).toString("hex");
  r.books.reserve(id, r.payer.idHex, reservation);
  r.state.items[id] = {
    id, status: "queued", nullifiers: [hash32(), hash32()], anchor: idx.height, root: String(idx.roots.get(idx.height)),
    mode: "block", acceptedHeight: idx.height, envelope: hex(randomBytes(471)), account: r.payer.idHex, reservation, attempts: 0,
  };
  return r.state.items[id];
}

const txOf = (raw) => btc.Transaction.fromRaw(unhex(raw), { allowUnknownOutputs: true });

// ------------------------------------------------------------------ #11 crash on malformed requests

/** Sends raw bytes and returns the first response line (or "" if the socket closes first). */
function rawRequest(port, text) {
  return new Promise((done, fail) => {
    const sock = net.connect(port, "127.0.0.1", () => sock.write(text));
    let data = "";
    sock.on("data", (c) => {
      data += c;
      if (data.includes("\r\n")) {
        sock.destroy();
        done(data.split("\r\n")[0]);
      }
    });
    sock.on("close", () => done(data.split("\r\n")[0]));
    sock.on("error", fail);
  });
}

test("#11 a malformed request target is a 400 and a vanished file only drops that response; the process keeps serving", async () => {
  const idx = new Indexer({ vkey: VKEY, startHeight: 5 });
  const app = createApp({ idx, artifacts: { "dir.bin": join(ROOT, "test") }, log: silent });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  try {
    assert.match(await rawRequest(port, "GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 400/);
    assert.match(await rawRequest(port, "GET http://[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"), /^HTTP\/1\.1 400/);
    // A directory makes the read stream fail after the headers (as a file deleted by a rebuild would).
    await new Promise((done) => {
      const req = http.get(`http://127.0.0.1:${port}/artifacts/dir.bin`, (res) => {
        res.resume();
        res.on("end", done);
        res.on("error", done);
        res.on("aborted", done);
      });
      req.on("error", done);
    });
    const res = await fetch(`http://127.0.0.1:${port}/api/state`);
    assert.equal(res.status, 200, "still serving");
    assert.equal((await res.json()).startHeight, 5);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

// ------------------------------------------------------------------ #21 bulk bodies

test("#21 bulk outputs/commitments/nullifiers: same JSON as before, serialized once per output and once per view", async () => {
  const idx = new Indexer({ vkey: VKEY, startHeight: 5 });
  let reads = 0;
  const output = (leafIndex) => {
    const commitment = BigInt(1000 + leafIndex);
    return {
      leafIndex, ciphertext: randomBytes(95), height: 5, txid: hash32(),
      get commitment() {
        reads += 1;
        return commitment;
      },
    };
  };
  idx.outputs.push(output(0), output(1), output(2));
  idx.nullifiers.add("11").add("22");
  const app = createApp({ idx, log: silent });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const text = async (path) => {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get("content-type"), /application\/json/);
    return res.text();
  };
  const view = (o) => ({ leafIndex: o.leafIndex, commitment: o.commitment.toString(), ciphertext: hex(o.ciphertext), height: o.height, txid: o.txid });
  try {
    const expected = JSON.stringify(idx.outputs.map(view));
    const expectedCommitments = JSON.stringify(idx.outputs.map((o) => [o.commitment.toString(), o.height]));
    const expectedRange = JSON.stringify(idx.outputs.slice(1, 3).map(view));
    const expectedFirst = JSON.stringify([[idx.outputs[0].commitment.toString(), 5]]);
    reads = 0;
    assert.equal(await text("/api/outputs"), expected);
    assert.equal(await text("/api/commitments"), expectedCommitments);
    assert.equal(reads, 3, "each output is serialized once, for both endpoints");
    assert.equal(await text("/api/outputs"), expected);
    assert.equal(await text("/api/outputs?from=1&to=3"), expectedRange);
    assert.equal(await text("/api/commitments?to=1"), expectedFirst);
    assert.equal(await text("/api/outputs?from=9"), "[]");
    assert.equal(await text("/api/nullifiers"), JSON.stringify(["11", "22"]));
    assert.equal(reads, 3, "later requests, ranged ones included, reuse the cached JSON");
    const head = await fetch(base + "/api/outputs", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");

    // A new view (more outputs) is served fresh; old outputs keep their cached JSON.
    idx.outputs.push(output(3));
    idx.nullifiers.add("33");
    app.publish();
    reads = 0;
    const all = JSON.parse(await text("/api/outputs"));
    assert.deepEqual(all.map((o) => o.leafIndex), [0, 1, 2, 3]);
    assert.equal(reads, 1, "only the new output is serialized");
    assert.deepEqual(JSON.parse(await text("/api/nullifiers")), ["11", "22", "33"]);
  } finally {
    await new Promise((r) => app.server.close(r));
  }
});

// ------------------------------------------------------------------ #13 / #22 dev tooling

test("#13 the Vite dev server serves web/, src/ and node_modules/ only, never the repo root (data/)", async () => {
  const { default: config } = await import("../web/vite.config.mjs");
  const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const allow = config.server.fs.allow.map(norm);
  assert.deepEqual(allow, ["web", "src", "node_modules"].map((d) => norm(join(ROOT, d))));
  for (const secret of ["data/signet/relayer.key", "data/signet/wallets/x.json", "package.json"]) {
    const file = norm(join(ROOT, secret));
    assert.ok(!allow.some((dir) => file.startsWith(dir + "/")), `${secret} is under fs.allow`);
  }

  // The real thing: a separate Vite instance (own port, own cache dir) refuses a file outside the list.
  const { createServer } = await import("vite");
  // The config object itself, inline (a merged `watch: null` would be dropped and leave file watchers open).
  const server = await createServer({
    ...config, configFile: false, cacheDir: join(DIR, "vite-cache"), logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    // A port the OS just handed out (Vite turns port 0 into its default 5173, where a dev server may
    // run). A random high port is not safe: Windows reserves ranges there (Hyper-V, WinNAT) and
    // answers EACCES.
    server: { ...config.server, port: await freePort(), strictPort: true, hmr: false, watch: null },
  });
  const status = async (url) => {
    const res = await fetch(url);
    await res.arrayBuffer(); // an unread body keeps the socket, and the test process, alive
    return res.status;
  };
  try {
    await server.listen();
    const root = ROOT.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\//, "");
    const base = `http://localhost:${server.httpServer.address().port}/@fs/${root}`;
    assert.equal(await status(`${base}/package.json`), 403, "the repo root is outside fs.allow");
    assert.equal(await status(`${base}/src/params.mjs`), 200, "the protocol modules are served");
  } finally {
    await server.close();
  }
});

test("#22 the dev launcher no longer claims the Vite proxy ignores MURKLE_INDEXER_PORT; the proxy follows it", async () => {
  const src = readFileSync(join(ROOT, "scripts/dev.mjs"), "utf8");
  assert.ok(!/still points at 8787|will not reach/.test(src));
  const saved = process.env.MURKLE_INDEXER_PORT;
  process.env.MURKLE_INDEXER_PORT = "9123";
  try {
    const { default: config } = await import("../web/vite.config.mjs?port=9123");
    assert.equal(config.server.proxy["/api"], "http://localhost:9123");
    assert.equal(config.server.proxy["/artifacts"], "http://localhost:9123");
  } finally {
    if (saved === undefined) delete process.env.MURKLE_INDEXER_PORT;
    else process.env.MURKLE_INDEXER_PORT = saved;
  }
});

// ------------------------------------------------------------------ #14 coin reuse after a failed broadcast

test("#14 a failed broadcast keeps its coin: later items in the same flush use other coins, and the resend lands", async () => {
  const idx = stubIdx(100);
  const fake = new FakeEsplora();
  const R = newRelayer(idx, fake);
  await fund(R, fake, [25_000, 25_000, 25_000, 25_000]);
  await R.refreshCache();
  const items = [queue(R, idx), queue(R, idx), queue(R, idx)];
  fake.failNext = new Error("POST /tx: 503 Service Unavailable");
  await R.flush();

  const signing = items.filter((i) => i.status === "signing");
  assert.equal(signing.length, 1, "the first carrier failed and stays journaled");
  assert.equal(items.filter((i) => i.status === "broadcast").length, 2);
  const outpoints = items.map((i) => i.outpoint);
  assert.equal(new Set(outpoints).size, 3, "no two carriers spend the same coin");
  for (const k of outpoints) assert.equal(R.state.coins[k].status, "spent", "each coin is taken by its carrier, the journaled one too");
  assert.equal(R.checkBooks().ok, true);

  // Next block: the journaled bytes go out again and are accepted.
  await R.sendJournaled(signing[0]);
  assert.equal(signing[0].status, "broadcast");
  assert.equal(fake.mempool.size, 3);
});

test("#14 Bitcoin Core 28+'s answer for a confirmed transaction is ok; an explicit node refusal is told apart from an answer that never came", async () => {
  const R = newRelayer(stubIdx(100), new FakeEsplora());
  const failWith = (msg) => ({ broadcast: async () => { throw new Error(msg); } });
  R.esplora = failWith('POST /tx: 400 sendrawtransaction RPC error: {"code":-27,"message":"Transaction outputs already in utxo set"}');
  assert.equal(await R.broadcastRaw("00"), "ok");
  R.esplora = failWith('POST /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}');
  assert.match(await R.broadcastRaw("00"), /^refused: /);
  for (const msg of ["POST /tx: 502 Bad Gateway", "POST /tx: 429 Too Many Requests", "socket hang up", "fetch failed"]) {
    const r = await (R.esplora = failWith(msg), R.broadcastRaw("00"));
    assert.ok(!/^(ok|spent|chain|refused: )/.test(r), msg);
  }
});

test("#14 mempool conflicts and RBF rejections are classified as a spent input", async () => {
  const R = newRelayer(stubIdx(100), new FakeEsplora());
  const failWith = (msg) => ({ broadcast: async () => { throw new Error(msg); } });
  for (const msg of [
    'POST /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"txn-mempool-conflict"}',
    'POST /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"insufficient fee, rejecting replacement 00ab, not enough additional fees to relay"}',
    "POST /tx: 400 bad-txns-inputs-missingorspent",
  ]) {
    R.esplora = failWith(msg);
    assert.equal(await R.broadcastRaw("00"), "spent", msg);
  }
  R.esplora = failWith("POST /tx: 400 sendrawtransaction RPC error: txn-already-in-mempool");
  assert.equal(await R.broadcastRaw("00"), "ok");
  R.esplora = failWith("POST /tx: 503 Service Unavailable");
  assert.match(await R.broadcastRaw("00"), /503/);
});

// ------------------------------------------------------------------ #16 change output and coin choice

test("#16 coins are picked with the fee planCarrierTx charges: the change output is never lost and a band coin never stalls the queue", async () => {
  const idx = stubIdx(100);
  const fake = new FakeEsplora();
  const R = newRelayer(idx, fake);
  // 3,316 sats sits in the old band [597r+331, 598r+329]: no change, fee 3,316 > 3,000.
  const { outpoints: [band, big] } = await fund(R, fake, [3316, 25_000]);
  fake.fee = 5;
  await R.refreshCache();
  const envelope = randomBytes(471);
  assert.equal(R.carrierFee(envelope, 5), 2990, "ceil(597.5) vB at 5 sat/vB");
  assert.equal(R.carrierFee(envelope, 1), 598);

  const item = queue(R, idx);
  assert.equal(await R.carry(item), "sent");
  assert.equal(item.outpoint, big);
  assert.notEqual(item.outpoint, band);
  assert.equal(item.fee, 2990);
  assert.equal(item.cost, 2990 + 299, "charged the exact fee plus its margin");
  const tx = txOf(fake.txs.get(item.txid));
  assert.equal(tx.outputsLength, 2, "1 OP_RETURN + 1 change");
  assert.equal(Number(tx.getOutput(1).amount), 25_000 - 2990);

  // Every fee rate: the smallest coin that is picked still keeps a change output above dust.
  for (let rate = 1; rate <= 5; rate++) {
    const coins = [];
    for (let v = 597 * rate + 320; v <= 598 * rate + 340; v++) coins.push({ key: `${hash32()}:0`, value: v, confirmed: true, kind: "change" });
    const u = R.pickCoin(coins, R.carrierFee(envelope, rate) + 330);
    assert.ok(u.value - 598 * rate >= 330, `rate ${rate}: coin ${u.value} keeps its change`);
  }
});

test("#16 a fee rate planCarrierTx cannot price holds the items; the flush and the tick still run to the end", async () => {
  const idx = stubIdx(100);
  const fake = new FakeEsplora();
  const statePath = join(DIR, "fractional.json");
  const R = newRelayer(idx, fake, { statePath });
  await fund(R, fake, [25_000, 25_000]);
  await R.onTick({ chainTip: idx.height });
  const items = [queue(R, idx), queue(R, idx)];
  fake.fee = 1.5; // BigInt(1.5) throws inside planCarrierTx
  R.state.lastFlushHeight = idx.height - 1;
  await R.onTick({ chainTip: idx.height });
  assert.deepEqual(items.map((i) => i.status), ["queued", "queued"]);
  assert.equal(fake.accepted.filter(isCarrier).length, 0);
  assert.equal(R.gateCode(), "busy", "and no new submit is taken");
  assert.equal(R.state.lastFlushHeight, idx.height, "the flush finished");
  assert.equal(JSON.parse(readFileSync(statePath, "utf8")).lastFlushHeight, idx.height, "the tick saved");

  fake.fee = 2;
  R.state.lastFlushHeight = idx.height - 1;
  await R.onTick({ chainTip: idx.height });
  assert.deepEqual(items.map((i) => i.status), ["broadcast", "broadcast"]);
});

// ------------------------------------------------------------------ #17 reorg inside one sync

/** A relayer item plus its ledger entry, in the given status. */
function addCarrier(R, fields) {
  const id = randomBytes(16).toString("hex");
  const seq = R.nextSeq();
  R.state.items[id] = { id, nullifiers: [hash32(), hash32()], anchor: 95, ledgerSeq: seq, ...fields };
  R.state.ledger.push({ seq, kind: "carrier", txid: fields.txid, fee: 598, outcome: fields.status === "broadcast" ? "pending" : fields.status, height: fields.height ?? null });
  return R.state.items[id];
}

/** Replaces the blocks from `fork` + 1 up and applies one more, as one syncIndexer call does. */
function reorgInOneSync(idx, fork, entries) {
  idx.log = idx.log.filter((e) => e.height <= fork).concat(entries);
  for (let h = fork + 1; h <= idx.height + 1; h++) idx.hashes.set(h, hash32());
  idx.height += 1;
}

test("#17 a reorg rolled back and re-applied in one sync: a broadcast carrier mined in the replacement block is accepted", () => {
  const idx = stubIdx(100);
  const R = newRelayer(idx, new FakeEsplora());
  R.reconcile();
  assert.equal(R.state.lastReconciledHash, idx.hashes.get(100));
  const Y = addCarrier(R, { status: "broadcast", txid: hash32() });
  reorgInOneSync(idx, 99, [{ height: 100, txid: Y.txid, ok: true }]); // 100 -> 100' (with Y), then 101
  R.reconcile();
  assert.equal(Y.status, "accepted");
  assert.equal(Y.height, 100);
  assert.equal(R.ledgerEntry(Y).outcome, "accepted");
  assert.equal(R.state.lastReconciledHash, idx.hashes.get(101));
});

test("#17 an accepted carrier moved one block down by a reorg in one sync keeps its verdict and is not reopened", () => {
  const idx = stubIdx(105);
  const R = newRelayer(idx, new FakeEsplora());
  const Z = addCarrier(R, { status: "accepted", txid: hash32(), height: 105, raw: "00" });
  idx.log.push({ height: 105, txid: Z.txid, ok: true });
  R.reconcile();
  const reopened = [];
  R.reopen = (item) => reopened.push(item.txid);
  reorgInOneSync(idx, 103, [{ height: 104, txid: Z.txid, ok: true }]); // 104, 105 -> 104' (with Z), 105', then 106
  R.reconcile();
  assert.deepEqual(reopened, []);
  assert.equal(Z.status, "accepted");
  assert.equal(Z.height, 104);
  assert.equal(R.ledgerEntry(Z).height, 104);
});

// ------------------------------------------------------------------ #18 fan-out recovery

/** A coin too large for one chain of carriers (it gets split), plus four 2,000-sat ones. */
const FANOUT_FUNDS = [1_000_000, 2000, 2000, 2000, 2000];
/** As fund(), plus 1,000 sats moved to the margin account (margins pay fan-outs; here no carrier has paid one yet). */
async function fundFanout(r, esplora) {
  const out = await fund(r, esplora, FANOUT_FUNDS);
  r.books.penalize(out.account.idHex, 1000);
  return out;
}
const fanoutsOf = (r) => r.state.ledger.filter((l) => l.kind === "fanout");

test("#18 a pending fan-out unknown to the explorer is sent again, and dropped (coin returned, fee back to the margin) once its input is gone", async () => {
  const idx = stubIdx(100);
  const fake = new FakeEsplora();
  const R = newRelayer(idx, fake, { fanoutTarget: 24 });
  const { outpoints: [first] } = await fundFanout(R, fake);
  const margin = R.books.toJSON().margin;
  await R.onTick({ chainTip: idx.height });
  const fanouts = () => fanoutsOf(R);
  assert.equal(fanouts().length, 1);
  const [entry] = fanouts();
  const raw = entry.raw;
  assert.equal(entry.outcome, "pending");
  assert.equal(R.books.toJSON().margin, margin - entry.fee, "paid from the margin account");
  assert.equal(R.state.coins[first].spentBy, entry.txid);

  // Evicted (or never sent before a crash): the same bytes are broadcast again.
  fake.evict(entry.txid);
  await R.onTick({ chainTip: idx.height });
  assert.equal(entry.outcome, "pending");
  assert.deepEqual(fake.accepted.slice(-2), [raw, raw]);
  fake.confirm([entry.txid], 101);
  await R.onTick({ chainTip: idx.height });
  assert.equal(entry.outcome, "accepted");
  assert.ok(Object.entries(R.state.coins).filter(([k]) => k.startsWith(entry.txid)).every(([, c]) => c.confirmed), "its outputs are confirmed coins");

  // A second fan-out whose input is then gone: dropped, its coin returned, its fee back to the margin, fan-outs resume.
  const R2 = newRelayer(idx, fake, { fanoutTarget: 24, fanoutMinConfirmed: 99 });
  const { outpoints: [second] } = await fundFanout(R2, fake);
  await R2.onTick({ chainTip: idx.height });
  const [e2] = fanoutsOf(R2);
  assert.equal(e2.outcome, "pending");
  const marginBefore = R2.books.toJSON().margin + e2.fee;
  fake.evict(e2.txid);
  fake.coins.delete(second);
  // Crediting and merging a new deposit runs reconcileFanouts: the fan-out is resent, its input is gone, it is dropped.
  const { merges: [m3] } = await poolCoins({ relayer: R2, esplora: fake, values: [900_000], account: R2.payer, height: idx.height });
  const marginNew = R2.books.toJSON().margin;
  assert.equal(marginNew, marginBefore + 288 - m3.fee, "the dropped fee went back; the new deposit's sweep cost less its merge fee came in");
  await R2.onTick({ chainTip: idx.height });
  assert.equal(e2.outcome, "dropped");
  assert.match(e2.reason, /spent elsewhere/);
  assert.equal(R2.state.coins[second].status, "unspent", "its coin is returned");
  const [, e3] = fanoutsOf(R2);
  assert.ok(e3, "a new fan-out is no longer blocked");
  assert.equal(e3.outcome, "pending");
  assert.equal(R2.books.toJSON().margin, marginNew - e3.fee, "the new fan-out paid its own");
  assert.equal(R2.checkBooks().ok, true);
});

/** The relayer's `n`-th save throws, as if the process died there: after writing the file, or before. */
function crashAtSave(r, n, written) {
  const save = r.save.bind(r);
  r.save = () => {
    if (--n !== 0) return save();
    if (written) save();
    throw new Error("crash");
  };
}

test("#18 a fan-out cut short by a crash is counted once (margin and chain depth) when it is found again", async () => {
  // The journal save (1st) is written and the broadcast never happens; or the broadcast happens and the 2nd save is lost.
  for (const [at, written, label] of [[1, true, "before the broadcast"], [2, false, "after the broadcast, before the save"]]) {
    const idx = stubIdx(100);
    const fake = new FakeEsplora();
    const statePath = join(DIR, `fanout-crash-${at}.json`);
    const R = newRelayer(idx, fake, { statePath, fanoutTarget: 24 });
    const { merges } = await fundFanout(R, fake);
    R.save();
    const mergeFees = merges.reduce((s, m) => s + m.fee, 0);
    const sent = fake.accepted.length;
    const margin = R.books.toJSON().margin;
    crashAtSave(R, at, written);
    await assert.rejects(R.onTick({ chainTip: idx.height }), /crash/);
    assert.equal(fake.accepted.length - sent, at - 1, label);

    const again = newRelayer(idx, fake, { statePath, fanoutTarget: 24 }, R.keys);
    const [entry] = fanoutsOf(again);
    assert.equal(entry.unsent, true, label);
    assert.equal(again.books.toJSON().margin, margin - entry.fee, `${label}: the fee was charged to the margin with the journal`);
    await again.onTick({ chainTip: idx.height });
    assert.equal(fake.accepted.length - sent, 1, `${label}: sent exactly once`);
    assert.equal(entry.outcome, "pending");
    assert.equal(entry.unsent, undefined);
    assert.equal(again.books.toJSON().totals.fees, mergeFees + entry.fee, `${label}: counted once`);
    const outputs = txOf(entry.raw).outputsLength;
    for (let v = 0; v < outputs; v++) {
      const coin = again.state.coins[`${entry.txid}:${v}`];
      assert.deepEqual([coin.depth, coin.root, coin.unsent], [1, entry.txid, undefined], `${label}: output ${v} can be chained`);
    }

    await again.onTick({ chainTip: idx.height });
    fake.confirm([entry.txid], 101);
    await again.onTick({ chainTip: idx.height });
    assert.equal(entry.outcome, "accepted");
    assert.equal(again.books.toJSON().totals.fees, mergeFees + entry.fee, `${label}: counted once`);
    assert.equal(again.checkBooks().ok, true);
  }
});

test("#18 an explorer that gives no answer (429, 5xx, network) never drops a fan-out or a carrier; only a 404 does, and never for a carrier whose answer was lost", async () => {
  const R0 = newRelayer(stubIdx(100), new FakeEsplora());
  const statusWith = async (msg) => {
    R0.esplora = { txStatus: async () => { throw new Error(msg); } };
    return R0.statusOf(hash32());
  };
  assert.equal(await statusWith(`GET /tx/${hash32()}/status: 404 Transaction not found`), null);
  for (const msg of [`GET /tx/${"404".repeat(21)}a/status: 503 Service Unavailable`, "GET /tx/x/status: 429 Too Many Requests", "fetch failed", "getaddrinfo ENOTFOUND mempool.space"]) {
    assert.equal(await statusWith(msg), undefined, msg);
  }

  // A fan-out that confirmed and whose outputs are all spent: while the explorer is down it stays pending.
  const idx = stubIdx(100);
  const fake = new FakeEsplora();
  const R = newRelayer(idx, fake, { fanoutTarget: 24 });
  const { outpoints: [coin] } = await fundFanout(R, fake);
  await R.onTick({ chainTip: idx.height });
  const [entry] = fanoutsOf(R);
  fake.confirm([entry.txid], 101);
  for (const k of [...fake.coins.keys()]) if (k.startsWith(entry.txid)) fake.coins.delete(k);
  const down = (r) => {
    r.esplora = Object.create(fake);
    r.esplora.txStatus = async () => { throw new Error("GET /tx/x/status: 503 Service Unavailable"); };
  };
  down(R);
  await R.onTick({ chainTip: idx.height });
  await R.onTick({ chainTip: idx.height });
  assert.equal(entry.outcome, "pending", "no answer: not dropped");
  assert.equal(R.state.coins[coin].status, "spent");
  R.esplora = fake;
  await R.onTick({ chainTip: idx.height });
  assert.equal(entry.outcome, "accepted");
  assert.equal(entry.height, 101);

  // A confirmed carrier whose change is spent, resent while the explorer is down: kept.
  const C = newRelayer(idx, fake);
  await fund(C, fake, [25_000, 25_000]);
  await C.refreshCache();
  const [sent, lost, refused] = [queue(C, idx), queue(C, idx), queue(C, idx)];
  await C.flush({ only: [sent.id] });
  assert.equal(sent.status, "broadcast");
  fake.confirm([sent.txid], 101);
  fake.coins.delete(`${sent.txid}:1`);
  down(C);
  await C.sendJournaled(sent);
  assert.equal(sent.status, "broadcast");
  assert.equal(C.state.coins[sent.outpoint].status, "spent", "not finalized");

  // A carrier whose first answer was lost (503): its bytes may be in some mempool, so even
  // "input gone" with a 404 later keeps it journaled and charged (I-PAY, audit V2-17).
  fake.failNext = new Error("POST /tx: 503 Service Unavailable");
  C.esplora = fake;
  await C.flush({ only: [lost.id] });
  assert.equal(lost.status, "signing");
  assert.equal(lost.unknownOutcome, true);
  const charged = C.books.account(C.payer.idHex).balance;
  fake.coins.delete(lost.outpoint);
  down(C);
  await C.sendJournaled(lost);
  assert.equal(lost.status, "signing", "no answer: journaled until the next resend");
  C.esplora = fake;
  await C.sendJournaled(lost);
  assert.equal(lost.status, "signing", "an unknown outcome is never dropped, even on a 404");
  assert.equal(C.books.account(C.payer.idHex).balance, charged, "never refunded");
  assert.equal(C.checkBooks().ok, true);

  // A carrier the node only ever refused outright: once its input is gone it is dropped on the
  // explorer's 404 (never while the explorer is down), and refunded.
  fake.failNext = new Error('POST /tx: 400 sendrawtransaction RPC error: {"code":-26,"message":"min relay fee not met"}');
  await C.flush({ only: [refused.id] });
  assert.equal(refused.status, "signing");
  assert.equal(refused.unknownOutcome, undefined, "a refusal is a known outcome");
  const balance = C.books.account(C.payer.idHex).balance;
  fake.coins.delete(refused.outpoint);
  down(C);
  await C.sendJournaled(refused);
  assert.equal(refused.status, "signing", "no answer: journaled until the next resend");
  C.esplora = fake;
  await C.sendJournaled(refused);
  assert.equal(refused.status, "dropped");
  assert.equal(C.books.account(C.payer.idHex).balance, balance + refused.cost + 658 - refused.cost, "the charge was refunded and the reservation released");
  assert.equal(C.state.coins[refused.outpoint].status, "unspent");
  assert.equal(C.checkBooks().ok, true);
});

// ------------------------------------------------------------------ #19 coin pruning

test("#19 change confirms from its parent's status (never an address listing); a spent coin is forgotten once its spender is 6 deep", async () => {
  const idx = stubIdx(100);
  const fake = new FakeEsplora();
  const R = newRelayer(idx, fake);
  const { outpoints: [dep] } = await fund(R, fake, [25_000]);
  await R.refreshCache();
  const item = queue(R, idx);
  await R.flush({ only: [item.id] });
  assert.equal(item.status, "broadcast");
  const change = `${item.txid}:1`;
  assert.deepEqual([R.state.coins[dep].status, R.state.coins[change].confirmed, R.state.coins[change].depth], ["spent", false, 1]);
  fake.confirm([item.txid], 101);
  idx.height = 101;
  idx.hashes.set(101, hash32());
  idx.log.push({ height: 101, txid: item.txid, ok: true });
  await R.onTick({ chainTip: 101 });
  assert.equal(item.status, "accepted");
  assert.deepEqual([R.state.coins[change].confirmed, R.state.coins[change].depth], [true, 0]);
  assert.ok(R.state.coins[dep], "kept while its spender is shallow");
  for (let h = 102; h <= 106; h++) {
    idx.height = h;
    idx.hashes.set(h, hash32());
    await R.onTick({ chainTip: h });
  }
  assert.equal(R.state.coins[dep], undefined, "forgotten at 6 confirmations");
  assert.equal(R.state.coins[change].status, "unspent");
  assert.equal(fake.utxoCalls, 0);
  assert.equal(R.checkBooks().ok, true);
});

// ------------------------------------------------------------------ #20 durable writes

test("#20 the relayer state is written durably (tmp file, fsync, rename) and reloads", async () => {
  const path = join(DIR, "durable.json");
  writeDurable(path, '{"a":1}');
  assert.equal(readFileSync(path, "utf8"), '{"a":1}');
  assert.ok(!existsSync(path + ".tmp"));
  writeDurable(path, '{"a":2}');
  assert.equal(readFileSync(path, "utf8"), '{"a":2}');

  const idx = stubIdx(100);
  const statePath = join(DIR, "relayer.json");
  const fake = new FakeEsplora();
  const R = newRelayer(idx, fake, { statePath });
  await fund(R, fake, [7000]);
  const item = queue(R, idx);
  R.save();
  assert.ok(!existsSync(statePath + ".tmp"));
  const again = newRelayer(idx, fake, { statePath }, R.keys);
  assert.equal(again.state.items[item.id].envelope, item.envelope);
  assert.equal(again.pending.get(item.nullifiers[0]), item.id);
  assert.deepEqual(again.books.account(R.payer.idHex), R.books.account(R.payer.idHex), "the books come back with the state");
});

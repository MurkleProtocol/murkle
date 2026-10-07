// The Bitcoin Core JSON-RPC chain source (src/btc/bitcoind.mjs) and the source factory
// (src/btc/source.mjs), against a fake JSON-RPC server on port 0. No real node, no network.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bitcoind, RpcError, satPerVbyte } from "../src/btc/bitcoind.mjs";
import { openChainSource } from "../src/btc/source.mjs";
import { decodeHeader, HeaderChain } from "../src/btc/headers.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { hex } from "../src/bytes.mjs";

const SIG = readFileSync("test/fixtures/headers/signet-322550-324600.bin");
const sig = (h) => decodeHeader(new Uint8Array(SIG.subarray((h - 322550) * 80, (h - 322550 + 1) * 80)));
const BLOCK = new Uint8Array(readFileSync("test/fixtures/signet-324500.bin"));
const BLOCK_JSON = JSON.parse(readFileSync("test/fixtures/signet-324500.json", "utf8"));

const DIR = mkdtempSync(join(tmpdir(), "murkle-bitcoind-"));
after(() => rmSync(DIR, { recursive: true, force: true }));
const SECRET = "c2VjcmV0LWNvb2tpZS12YWx1ZQ";
const COOKIE = join(DIR, ".cookie");
writeFileSync(COOKIE, `__cookie__:${SECRET}\n`);
const PASSFILE = join(DIR, "rpc.pass");
writeFileSync(PASSFILE, "pass-from-file\n");

// A small raw transaction (a coinbase-style one from the fixture block is enough for txid checks).
function firstTxHex() {
  // The fixture block's first transaction: header (80) ‖ varint count ‖ tx… — parse it out by length.
  for (let end = 81 + 60; end <= BLOCK.length; end++) {
    try {
      const t = parseRawTx(BLOCK.subarray(81, end));
      if (t.txid === BLOCK_JSON.txids[0]) return { hex: hex(BLOCK.subarray(81, end)), txid: t.txid };
    } catch {
      // keep growing
    }
  }
  throw new Error("no first tx");
}
const TX = firstTxHex();

/**
 * A fake bitcoind. `handlers[method](params)` returns a result, or { __error: { code, message } }.
 * `auth` is the Authorization value it accepts. `drop(n)` makes the next n requests fail at the socket.
 */
async function fakeNode({ handlers, auth = `Basic ${Buffer.from(`__cookie__:${SECRET}`).toString("base64")}`, extra = null } = {}) {
  const state = { requests: [], drops: 0, auth };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (extra && req.method === "GET") return extra(req, res);
      state.requests.push({ auth: req.headers.authorization, body });
      if (state.drops > 0) {
        state.drops -= 1;
        req.socket.destroy();
        return;
      }
      if (req.headers.authorization !== state.auth) {
        res.writeHead(401);
        res.end();
        return;
      }
      const one = (call) => {
        const h = handlers[call.method];
        if (!h) return { result: null, error: { code: -32601, message: "Method not found" }, id: call.id };
        const r = h(call.params ?? []);
        if (r && r.__error) return { result: null, error: r.__error, id: call.id };
        return { result: r, error: null, id: call.id };
      };
      const parsed = JSON.parse(body);
      if (Array.isArray(parsed)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(parsed.map(one)));
        return;
      }
      const out = one(parsed);
      res.writeHead(out.error ? (out.error.code === -32601 ? 404 : 500) : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${server.address().port}`;
  state.close = () => new Promise((r) => server.close(r));
  state.methods = () => state.requests.flatMap((q) => {
    try {
      const p = JSON.parse(q.body);
      return Array.isArray(p) ? p.map((c) => c.method) : [p.method];
    } catch {
      return [];
    }
  });
  return state;
}

const chainHandlers = (over = {}) => ({
  getblockcount: () => 324600,
  getblockhash: ([h]) => (h >= 322550 && h <= 324600 ? sig(h).hash : { __error: { code: -8, message: "Block height out of range" } }),
  getblockheader: ([hash, verbose]) => {
    for (let h = 324600; h >= 322550; h--) {
      if (sig(h).hash === hash) return verbose === false ? hex(sig(h).bytes) : { hash, height: h, time: sig(h).time };
    }
    if (hash === BLOCK_JSON.hash) return verbose === false ? hex(BLOCK.subarray(0, 80)) : { hash, height: 324500, time: 1 };
    return { __error: { code: -5, message: "Block not found" } };
  },
  getblock: ([hash, v]) => (hash === BLOCK_JSON.hash && v === 0 ? hex(BLOCK) : { __error: { code: -5, message: "Block not found" } }),
  getrawtransaction: ([txid, verbose]) => {
    if (txid === TX.txid) return verbose ? { txid, hex: TX.hex, blockhash: BLOCK_JSON.hash, confirmations: 101, blocktime: 1790000000 } : TX.hex;
    if (txid === "cd".repeat(32)) return verbose ? { txid, hex: "00" } : "00";
    return { __error: { code: -5, message: "No such mempool or blockchain transaction. Use gettransaction for wallet transactions." } };
  },
  getmempoolentry: () => ({ __error: { code: -5, message: "Transaction not in mempool" } }),
  getrawmempool: () => ["ab".repeat(32)],
  estimatesmartfee: ([target]) => ({ feerate: target === 2 ? 0.00012345 : 0.00001, blocks: target }),
  sendrawtransaction: () => ({ __error: { code: -26, message: "txn-mempool-conflict" } }),
  getblockchaininfo: () => ({ chain: "signet", blocks: 324600, headers: 324600, initialblockdownload: false }),
  getindexinfo: () => ({ txindex: { synced: true, best_block_height: 324600 } }),
  ...over,
});

const opts = (node, more = {}) => ({ url: node.url, cookieFile: COOKIE, network: "signet", retries: 3, retryMs: 5, timeoutMs: 2000, ...more });

test("method mapping: the Esplora surface over JSON-RPC", async () => {
  const node = await fakeNode({ handlers: chainHandlers() });
  try {
    const api = new Bitcoind(opts(node));
    assert.equal(await api.tipHeight(), 324600);
    assert.equal(await api.blockHash(324592), sig(324592).hash);
    assert.equal(await api.blockHeader(sig(324592).hash), hex(sig(324592).bytes));
    assert.deepEqual(await api.rawBlock(BLOCK_JSON.hash), BLOCK);
    assert.equal(await api.txHex(TX.txid), TX.hex);
    assert.equal(hex(await api.rawTx(TX.txid)), TX.hex);
    assert.deepEqual(await api.tx(TX.txid), { txid: TX.txid, status: { confirmed: true, block_height: 324500, block_hash: BLOCK_JSON.hash, block_time: 1790000000 } });
    assert.deepEqual(await api.txStatus(TX.txid), { confirmed: true, block_height: 324500, block_hash: BLOCK_JSON.hash, block_time: 1790000000 });
    assert.deepEqual(await api.mempoolTxids(), ["ab".repeat(32)]);
    const outpoint = new Uint8Array([...Buffer.from(TX.txid, "hex").reverse(), 0, 0, 0, 0]);
    assert.deepEqual(await api.prevoutScript(outpoint), parseRawTx(TX.hex).outputs[0].script);
    await assert.rejects(api.rawTx("cd".repeat(32)), /bytes|truncated|mismatch/, "rawTx checks the txid");
    assert.deepEqual(node.methods(), [
      "getblockcount", "getblockhash", "getblockheader", "getblock", "getrawtransaction", "getrawtransaction",
      "getrawtransaction", "getblockheader", "getrawtransaction", "getblockheader", "getrawmempool", "getrawtransaction", "getrawtransaction",
    ]);
    assert.equal(api.base, node.url);
  } finally {
    await node.close();
  }
});

test("headers(): two batched requests, each header checked against its hash, stops at the tip (-8)", async () => {
  const node = await fakeNode({ handlers: chainHandlers() });
  try {
    const api = new Bitcoind(opts(node));
    const list = await api.headers(324590, 8);
    assert.equal(list.length, 8);
    list.forEach((b, i) => assert.deepEqual(b, sig(324590 + i).bytes));
    assert.equal(node.requests.length, 2, "one batch of getblockhash, one of getblockheader");
    const tail = await api.headers(324598, 10);
    assert.equal(tail.length, 3);
    // A HeaderChain fed by it verifies the real signet chain above the genesis checkpoint.
    const c = new HeaderChain({ network: "signet", startHeight: 324592 });
    await c.catchUp(api, 324600);
    assert.equal(c.hash, sig(324600).hash);
  } finally {
    await node.close();
  }
  const lying = await fakeNode({ handlers: chainHandlers({ getblockheader: () => hex(sig(324000).bytes) }) });
  try {
    await assert.rejects(new Bitcoind(opts(lying)).headers(324590, 2), /hashes to/);
  } finally {
    await lying.close();
  }
});

test("auth: cookie header, cookie re-read after a 401, user plus password file; secrets never in errors", async () => {
  const node = await fakeNode({ handlers: chainHandlers() });
  try {
    const api = new Bitcoind(opts(node));
    await api.tipHeight();
    assert.equal(node.requests[0].auth, `Basic ${Buffer.from(`__cookie__:${SECRET}`).toString("base64")}`);
    // Core restarted: a new cookie.
    const fresh = "bmV3LWNvb2tpZQ";
    writeFileSync(COOKIE, `__cookie__:${fresh}`);
    node.auth = `Basic ${Buffer.from(`__cookie__:${fresh}`).toString("base64")}`;
    assert.equal(await api.tipHeight(), 324600);
    writeFileSync(COOKIE, `__cookie__:${SECRET}\n`);
    node.auth = `Basic ${Buffer.from(`__cookie__:${SECRET}`).toString("base64")}`;
    // user + password file
    node.auth = `Basic ${Buffer.from("murkle:pass-from-file").toString("base64")}`;
    const byPass = new Bitcoind({ url: node.url, user: "murkle", passwordFile: PASSFILE, network: "signet" });
    assert.equal(await byPass.tipHeight(), 324600);
    // A wrong password: a clear error that names no secret.
    node.auth = "Basic nope";
    const err = await byPass.tipHeight().catch((e) => e);
    assert.match(err.message, /authentication failed \(HTTP 401\)/);
    assert.doesNotMatch(err.message, /pass-from-file|murkle:/);
    const err2 = await new Bitcoind(opts(node, { retries: 0 })).tipHeight().catch((e) => e);
    assert.doesNotMatch(err2.message, new RegExp(SECRET));
  } finally {
    await node.close();
  }
  const withUserinfo = new URL("http://127.0.0.1:8332");
  withUserinfo.username = "someone";
  withUserinfo.password = "x";
  assert.throws(() => new Bitcoind({ url: withUserinfo.href, cookieFile: COOKIE }), /not in the URL/);
  assert.throws(() => new Bitcoind({ url: "http://127.0.0.1:8332" }), /MURKLE_BITCOIND_COOKIE/);
  await assert.rejects(new Bitcoind({ url: "http://127.0.0.1:9", cookieFile: join(DIR, "missing") }).tipHeight(), /cannot read the cookie file/);
});

test("errors: RPC errors are 'RPC error <code>: <message>' with rpcCode and never retried; -5 says 404 not found", async () => {
  const node = await fakeNode({ handlers: chainHandlers() });
  try {
    const api = new Bitcoind(opts(node));
    const e = await api.broadcast("0200").catch((x) => x);
    assert.ok(e instanceof RpcError);
    assert.equal(e.message, "RPC error -26: txn-mempool-conflict");
    assert.equal(e.rpcCode, -26);
    assert.equal(node.requests.length, 1);
    // The relayer's broadcast classifier sees Core's text and the RPC error marker.
    assert.match(e.message, /RPC error/);
    assert.match(e.message, /txn-mempool-conflict/);
    node.requests.length = 0;
    const unknown = "ef".repeat(32);
    const nf = await api.tx(unknown).catch((x) => x);
    assert.match(nf.message, /: 404 not found/);
    assert.match(nf.message, /RPC error -5/);
    assert.equal(nf.rpcCode, -5);
    assert.match(String(nf.message), /\b404\b|not found|no such/i, "statusOf's test");
    await assert.rejects(api.txHex(unknown), /: 404\b/);
    assert.deepEqual(await api.txStatus(unknown), { confirmed: false });
    assert.equal(node.methods().filter((m) => m === "getrawtransaction").length, 3, "no retries of RPC errors");
    const missing = await api.rpc("nosuchmethod").catch((x) => x);
    assert.equal(missing.rpcCode, -32601);
    await assert.rejects(api.utxos("tb1qxyz"), /bitcoind source: utxos is not available; set MURKLE_ESPLORA for wallet lookups/);
    await assert.rejects(api.merkleProof(TX.txid), /merkleProof is not available/);
  } finally {
    await node.close();
  }
});

test("transport failures: reads retry with backoff, sendrawtransaction never does", async () => {
  const node = await fakeNode({ handlers: chainHandlers({ sendrawtransaction: () => TX.txid }) });
  try {
    const api = new Bitcoind(opts(node));
    node.drops = 2;
    assert.equal(await api.tipHeight(), 324600);
    assert.equal(node.requests.length, 3);
    node.requests.length = 0;
    node.drops = 1;
    const e = await api.broadcast(TX.hex).catch((x) => x);
    assert.ok(e instanceof Error);
    assert.doesNotMatch(e.message, /RPC error/, "a transport failure is not a node verdict");
    assert.equal(node.requests.length, 1, "never retried: the outcome is unknown");
    assert.equal(await api.broadcast(TX.hex), TX.txid);
    node.drops = 10;
    await assert.rejects(api.tipHeight(), (x) => x.transport === true && !/RPC error/.test(x.message));
  } finally {
    await node.close();
  }
  // Nothing listening: a transport error.
  const dead = new Bitcoind({ url: "http://127.0.0.1:9", cookieFile: COOKIE, retries: 1, retryMs: 1 });
  await assert.rejects(dead.tipHeight(), /connection failed/);
});

test("fee rates: BTC/kvB to whole sat/vB rounded up; no estimate is 1 on signet and an error on mainnet", async () => {
  assert.equal(satPerVbyte(0.00001), 1);
  assert.equal(satPerVbyte(0.0001), 10);
  assert.equal(satPerVbyte(0.00012345), 13);
  assert.equal(satPerVbyte(0.000011), 2);
  assert.equal(satPerVbyte(0), null);
  const node = await fakeNode({ handlers: chainHandlers() });
  try {
    const api = new Bitcoind(opts(node));
    assert.equal(await api.feeRate(), 1);
    assert.equal(await api.nextBlockFeeRate(), 13);
    const calls = node.requests.map((q) => JSON.parse(q.body).params);
    assert.deepEqual(calls, [[3, "ECONOMICAL"], [2, "CONSERVATIVE"]]);
  } finally {
    await node.close();
  }
  const empty = await fakeNode({ handlers: chainHandlers({ estimatesmartfee: () => ({ errors: ["Insufficient data or no feerate found"], blocks: 0 }) }) });
  try {
    assert.equal(await new Bitcoind(opts(empty)).feeRate(), 1);
    await assert.rejects(new Bitcoind(opts(empty, { network: "mainnet" })).feeRate(), /no fee estimate yet \(Insufficient data/);
    await assert.rejects(new Bitcoind(opts(empty, { network: "mainnet" })).nextBlockFeeRate(), /no fee estimate/);
  } finally {
    await empty.close();
  }
});

test("chainInfo and openChainSource: network mismatch, missing or unsynced txindex are refused; IBD warns", async () => {
  const env = (node, more = {}) => (name) => ({ BTC_SOURCE: "bitcoind", BITCOIND_URL: node.url, BITCOIND_COOKIE: COOKIE, ...more })[name];
  const node = await fakeNode({ handlers: chainHandlers() });
  try {
    assert.deepEqual(await new Bitcoind(opts(node)).chainInfo(), { chain: "signet", blocks: 324600, headers: 324600, ibd: false, txindex: { synced: true, best_block_height: 324600 } });
    const src = await openChainSource({ network: "signet", read: env(node), startHeight: 324592, log: null });
    assert.equal(src.kind, "bitcoind");
    assert.equal(src.headers.base.height, 324592);
    assert.equal(src.describe(), `bitcoind ${node.url} (txindex on), headers from checkpoint 324592 (signet block signatures not checked)`);
    await assert.rejects(openChainSource({ network: "mainnet", read: env(node), log: null }), /serves chain "signet", but this is mainnet/);
  } finally {
    await node.close();
  }
  const noIndex = await fakeNode({ handlers: chainHandlers({ getindexinfo: () => ({}) }) });
  try {
    await assert.rejects(openChainSource({ network: "signet", read: env(noIndex), log: null }), /no transaction index: set txindex=1/);
  } finally {
    await noIndex.close();
  }
  const building = await fakeNode({ handlers: chainHandlers({ getindexinfo: () => ({ txindex: { synced: false, best_block_height: 1000 } }) }) });
  try {
    await assert.rejects(openChainSource({ network: "signet", read: env(building), log: null }), /still building its transaction index \(at #1000/);
  } finally {
    await building.close();
  }
  const ibd = await fakeNode({ handlers: chainHandlers({ getblockchaininfo: () => ({ chain: "main", blocks: 900000, headers: 970000, initialblockdownload: true }) }) });
  try {
    const warned = [];
    const src = await openChainSource({ network: "mainnet", read: env(ibd), log: { warn: (m) => warned.push(m) } });
    assert.match(warned[0], /initial block download .*indexing only to #900000/);
    assert.equal(src.headers.network, "mainnet");
  } finally {
    await ibd.close();
  }
});

test("openChainSource: utxos and merkleProof go to Esplora when MURKLE_ESPLORA is set; MURKLE_HEADERS=off only on signet", async () => {
  const utxos = [{ txid: "aa".repeat(32), vout: 0, value: 1000, status: { confirmed: true } }];
  const node = await fakeNode({
    handlers: chainHandlers(),
    extra: (req, res) => {
      if (req.url === "/esplora/address/tb1qexample/utxo") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(utxos));
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    },
  });
  try {
    const read = (more = {}) => (name) => ({ BTC_SOURCE: "bitcoind", BITCOIND_URL: node.url, BITCOIND_COOKIE: COOKIE, ESPLORA: `${node.url}/esplora`, ...more })[name];
    const src = await openChainSource({ network: "signet", read: read(), log: null });
    assert.deepEqual(await src.api.utxos("tb1qexample"), utxos);
    const bare = await openChainSource({ network: "signet", read: read({ ESPLORA: undefined }), log: null });
    await assert.rejects(bare.api.utxos("tb1qexample"), /not available; set MURKLE_ESPLORA/);
    const off = await openChainSource({ network: "signet", read: read({ HEADERS: "off" }), log: null });
    assert.equal(off.headers, null);
    assert.match(off.describe(), /headers not verified \(MURKLE_HEADERS=off, signet only\)/);
    await assert.rejects(openChainSource({ network: "mainnet", read: read({ HEADERS: "off" }), log: null }), /header verification cannot be turned off on mainnet/);
    await assert.rejects(openChainSource({ network: "mainnet", read: () => undefined, verifyHeaders: false, log: null }), /cannot be turned off on mainnet/);
    await assert.rejects(openChainSource({ network: "signet", read: (n) => (n === "BTC_SOURCE" ? "electrum" : undefined), log: null }), /must be esplora or bitcoind/);
    await assert.rejects(openChainSource({ network: "signet", read: (n) => (n === "HEADERS" ? "maybe" : undefined), log: null }), /MURKLE_HEADERS must be on or off/);
    // The default: Esplora on the network's mempool.space, headers on.
    const def = await openChainSource({ network: "signet", read: () => undefined, log: null });
    assert.equal(def.kind, "esplora");
    assert.equal(def.api.base, "https://mempool.space/signet/api");
    assert.equal(def.headers.base.height, 324592);
    const mn = await openChainSource({ network: "mainnet", read: () => undefined, log: null });
    assert.equal(mn.api.base, "https://mempool.space/api");
    assert.equal(mn.headers.base.height, 969696);
  } finally {
    await node.close();
  }
});

test("openChainSource: headers persist through save() and load back; a corrupt file starts again from the base", async () => {
  const path = join(DIR, "headers.json");
  const read = () => undefined;
  const a = await openChainSource({ network: "signet", read, headersPath: path, startHeight: 324592, log: null });
  for (let h = 324593; h <= 324600; h++) a.headers.append(h, sig(h).bytes);
  a.save();
  const b = await openChainSource({ network: "signet", read, headersPath: path, startHeight: 324592, log: null });
  assert.equal(b.headers.hash, sig(324600).hash);
  writeFileSync(path, "{ not json");
  const warned = [];
  const c = await openChainSource({ network: "signet", read, headersPath: path, startHeight: 324592, log: { warn: (m) => warned.push(m) } });
  assert.equal(c.headers.height, 324592);
  assert.match(warned[0], /not usable/);
  // A mainnet process does not load a signet file.
  a.save();
  const warned2 = [];
  const d = await openChainSource({ network: "mainnet", read, headersPath: path, log: { warn: (m) => warned2.push(m) } });
  assert.equal(d.headers.base.height, 969696);
  assert.match(warned2[0], /is for signet, this is mainnet/);
});

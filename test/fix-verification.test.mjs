// Regression tests for the verification fixes (numbered tests refer to findings of an internal review):
// honest verdicts in the Proof X-ray engine, the receipt and share card that show them,
// the security page copy, privacy of the anchor-root lookup, and the pool comparison.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { sha256 } from "@noble/hashes/sha256";
import { deriveKeys } from "../src/keys.mjs";
import { Wallet } from "../src/wallet.mjs";
import { Indexer, assetIdOf } from "../src/indexer.mjs";
import { encodeAttest, encodeDeploy, ATTEST_KIND } from "../src/envelope.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { Esplora } from "../src/btc/esplora.mjs";
import { btcAccount, planCarrierTx, signLocal } from "../src/btc/funding.mjs";
import { concat, hex, outpointOf, u32le, unhex } from "../src/bytes.mjs";
import { verifyTx, headerFields } from "../src/verify-tx.mjs";

// Web modules import JSON without attributes and CSS (Vite handles both); teach Node the same.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (url.endsWith(".json") && !context.importAttributes?.type) return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
    return nextLoad(url, context);
  },
});

// A minimal IndexedDB for web/src/verify/idb.js (saved replays and results).
const idbData = new Map();
globalThis.indexedDB = {
  open() {
    const db = {
      transaction() {
        const t = {};
        const done = (result) => {
          setTimeout(() => t.oncomplete?.());
          return { result };
        };
        t.objectStore = () => ({
          get: (k) => done(idbData.has(k) ? structuredClone(idbData.get(k)) : undefined),
          put: (v, k) => (idbData.set(k, structuredClone(v)), done(k)),
          delete: (k) => (idbData.delete(k), done(undefined)),
        });
        return t;
      },
    };
    const req = {};
    setTimeout(() => {
      req.result = db;
      req.onsuccess?.();
    });
    return req;
  },
};

const VKEY_BYTES = new Uint8Array(readFileSync("build/dev/verification_key.json"));
const VKEY = JSON.parse(new TextDecoder().decode(VKEY_BYTES));
const BASE = "https://esplora.invalid/api";
const START = 300000;
const PRICE = 1000n;
const MINT_AMOUNT = 500n;
const dsha = (b) => sha256(sha256(b));
const rev = (b) => Uint8Array.from(b).reverse();
const randTxid = () => randomBytes(32).toString("hex");

/* ---------- a fake chain served over fetch (as in verify-tx.test.mjs) ---------- */

const idx = new Indexer({ vkey: VKEY, startHeight: START });
const served = new Map();
const where = new Map();
const blocks = [];
const overrides = { hex: new Map() };
let prevHash = new Uint8Array(32);

function merkleLevels(hashes) {
  const levels = [hashes];
  while (levels.at(-1).length > 1) {
    const l = levels.at(-1);
    const next = [];
    for (let i = 0; i < l.length; i += 2) next.push(dsha(concat(l[i], l[i + 1] ?? l[i])));
    levels.push(next);
  }
  return levels;
}

function proofFor(txid) {
  const w = where.get(txid);
  const levels = merkleLevels(blocks.find((b) => b.height === w.height).hashes);
  const merkle = [];
  let i = w.pos;
  for (const l of levels.slice(0, -1)) {
    merkle.push(hex(rev(l[i ^ 1] ?? l[i])));
    i = Math.floor(i / 2);
  }
  return { block_height: w.height, merkle, pos: w.pos };
}

async function mine(txs = []) {
  const height = idx.height + 1;
  const coinbase = randTxid();
  const hashes = [coinbase, ...txs.map((t) => t.txid)].map((id) => rev(unhex(id)));
  const root = merkleLevels(hashes).at(-1)[0];
  let header;
  for (let nonce = 0; ; nonce++) {
    header = concat(u32le(0x20000000), prevHash, root, u32le(1_700_000_000 + height), u32le(0x207fffff), u32le(nonce));
    if (headerFields(header).meetsTarget) break;
  }
  const hash = hex(rev(dsha(header)));
  prevHash = dsha(header);
  blocks.push({ height, hash, header: hex(header), hashes });
  txs.forEach((t, k) => {
    served.set(t.txid, t.hex);
    where.set(t.txid, { height, hash, pos: k + 1 });
  });
  await idx.applyBlock({ height, hash, txs: [{ txid: coinbase, inputs: [], outputs: [] }, ...txs.map((t) => parseRawTx(t.hex, t.txid))] });
}

function chainFetch(path) {
  const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
  const nf = () => new Response("Transaction not found", { status: 404 });
  let m;
  if (path === "/blocks/tip/height") return new Response(String(idx.height));
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/hex$/))) {
    const h = overrides.hex.get(m[1]) ?? served.get(m[1]);
    return h ? new Response(h) : nf();
  }
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/status$/))) {
    const w = where.get(m[1]);
    return w ? json({ confirmed: true, block_height: w.height, block_hash: w.hash, block_time: 1_700_000_000 }) : nf();
  }
  if ((m = path.match(/^\/tx\/([0-9a-f]{64})\/merkle-proof$/))) return where.has(m[1]) ? json(proofFor(m[1])) : nf();
  if ((m = path.match(/^\/block\/([0-9a-f]{64})\/header$/))) {
    const b = blocks.find((x) => x.hash === m[1]);
    return b ? new Response(b.header) : nf();
  }
  return nf();
}

// The web modules talk to "our indexer" on relative /api paths; each test installs a handler.
let web = () => new Response("{}", { status: 404 });
const webCalls = [];
const realFetch = globalThis.fetch;

const payerKey = randomBytes(32);
const payer = btcAccount(payerKey);
const TREASURY = btcAccount(randomBytes(32)).script;
const utxo = (value = 100_000) => ({ txid: randTxid(), vout: 0, value });
function carrier(envelope, { outputs = [], first = utxo() } = {}) {
  const { tx } = planCarrierTx({ account: payer, utxos: [first], envelope, outputs, feeRate: 1, firstInput: first });
  const signed = signLocal(tx, payerKey);
  return { hex: signed.hex, txid: signed.txid };
}

const alice = new Wallet(deriveKeys(randomBytes(32)));
const bob = new Wallet(deriveKeys(randomBytes(32)));
const T = {};

const logOf = (txid) => idx.log.find((l) => l.txid === txid) ?? null;
const ctx = (over = {}) => ({
  esplora: new Esplora(BASE),
  vkeyBytes: async () => VKEY_BYTES,
  pinnedVkeySha256: hex(sha256(VKEY_BYTES)),
  anchorRoot: async (h) => (idx.roots.has(h) ? { root: idx.roots.get(h), source: "YOU", kind: "replay", detail: "from your own replay" } : null),
  assetInfo: async (id) => {
    const a = idx.assets.get(id);
    return a ? { deployTxid: a.deployTxid, ticker: a.ticker } : null;
  },
  indexerVerdict: async (txid) => logOf(txid),
  ...over,
});
// An indexer that accepts everything: what a lying indexer would report.
const acceptsAll = async (txid) => ({ ...logOf(txid), ok: true, reason: undefined });
const stepOf = (r, id) => r.steps.find((s) => s.id === id);
const failedStep = (r) => r.steps.find((s) => s.status === "fail") ?? null;

before(async () => {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(BASE)) return chainFetch(u.slice(BASE.length));
    webCalls.push(u);
    return web(u, init);
  };

  T.deploy = carrier(encodeDeploy({ ticker: "FIXV", divisibility: 0, mintAmount: MINT_AMOUNT, mintCap: 10, priceSats: PRICE, treasury: TREASURY }));
  await mine([T.deploy]);
  const asset = assetIdOf(START, 1);

  // One valid MINT, and MINTs the indexer rejects for rules the browser checks itself.
  const bindMint = utxo();
  const mintEnv = await alice.mint(idx, { asset, mintAmount: MINT_AMOUNT, bindOutpoint: outpointOf(bindMint.txid, bindMint.vout) });
  T.mint = carrier(mintEnv, { outputs: [{ script: TREASURY, amount: PRICE }], first: bindMint });
  T.mintCopy = carrier(mintEnv, { outputs: [{ script: TREASURY, amount: PRICE }] });
  const bindWrong = utxo();
  const wrongEnv = await alice.mint(idx, { asset, mintAmount: MINT_AMOUNT + 1n, bindOutpoint: outpointOf(bindWrong.txid, bindWrong.vout) });
  T.wrongAmount = carrier(wrongEnv, { outputs: [{ script: TREASURY, amount: PRICE }], first: bindWrong });
  const bindUnder = utxo();
  const underEnv = await alice.mint(idx, { asset, mintAmount: MINT_AMOUNT, bindOutpoint: outpointOf(bindUnder.txid, bindUnder.vout) });
  T.underpaid = carrier(underEnv, { outputs: [{ script: TREASURY, amount: PRICE - 1n }], first: bindUnder });
  // A genesis-kind ATTEST naming some other manifest: anyone can post one.
  T.attestOther = carrier(encodeAttest({ kind: ATTEST_KIND.GENESIS, hash: randomBytes(32).toString("hex") }));
  await mine([T.mint, T.mintCopy, T.wrongAmount, T.underpaid, T.attestOther]);

  // A transfer proved now but mined more than 100 blocks later: its anchor left the window.
  alice.scan(idx);
  const lateEnv = await alice.transfer(idx, { asset, amount: 100n, to: bob.address });
  for (let i = 0; i < 100; i++) await mine();
  T.late = carrier(lateEnv);
  await mine([T.late]);
});

after(async () => {
  globalThis.fetch = realFetch;
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

test("fixture: the honest indexer's verdicts", () => {
  assert.equal(logOf(T.mint.txid).ok, true);
  assert.equal(logOf(T.attestOther.txid).ok, true, "every decodable ATTEST is logged as accepted");
  assert.match(logOf(T.mintCopy.txid).reason, /^MINT not bound/);
  assert.match(logOf(T.wrongAmount.txid).reason, /^mint amount differs/);
  assert.match(logOf(T.underpaid.txid).reason, /^underpaid/);
  assert.equal(logOf(T.late.txid).reason, "anchor outside window");
});

/* ---------- finding 29 ---------- */

test("29: a genesis ATTEST of another manifest is no rule break and never accuses the indexer", async () => {
  const r = await verifyTx(T.attestOther.txid, ctx());
  assert.equal(r.verdict, "verified", JSON.stringify(r.steps, null, 1));
  const s = stepOf(r, "attest");
  assert.equal(s.status, "ok");
  assert.equal(s.label, "Attestation names another manifest");
  assert.match(s.detail, /carries no authority/);
  assert.equal(r.attest.pinned, false);
  assert.equal(stepOf(r, "indexer").status, "ok");
  assert.doesNotMatch(stepOf(r, "indexer").detail, /Do not trust/);
});

/* ---------- finding 30 ---------- */

test("30: fetch, key and library failures are data problems: inconclusive, never a mismatch", async () => {
  const cases = {
    vkey: { vkeyBytes: async () => { throw new Error("Can't reach the indexer. Check your connection, then try again."); } },
    groth16: { groth16Verify: async () => { throw new TypeError("Failed to fetch dynamically imported module"); } },
    root: { anchorRoot: async () => null },
    terms: { assetInfo: async () => { throw new Error("Can't reach the indexer."); } },
  };
  for (const [at, over] of Object.entries(cases)) {
    const r = await verifyTx(T.mint.txid, ctx(over));
    assert.equal(r.verdict, "failed", at);
    assert.equal(failedStep(r).id, at);
    assert.equal(failedStep(r).fault, "data", at);
    const ix = stepOf(r, "indexer");
    assert.equal(ix.status, "skip", `${at}: the comparison is inconclusive`);
    assert.match(ix.detail, /inconclusive/);
    assert.doesNotMatch(ix.detail, /Do not trust/);
  }
  assert.match(failedStep(await verifyTx(T.mint.txid, ctx(cases.groth16))).detail, /Couldn't run the pairing check/);

  // Bytes of another transaction: mempool.space's fault, not the indexer's.
  overrides.hex.set(T.mint.txid, T.deploy.hex);
  try {
    const r = await verifyTx(T.mint.txid, ctx());
    assert.equal(r.verdict, "failed");
    assert.equal(failedStep(r).id, "txid");
    assert.equal(failedStep(r).fault, "data");
  } finally {
    overrides.hex.delete(T.mint.txid);
  }

  // An honest rejection plus a data failure is not "agreement" either.
  const rejected = await verifyTx(T.wrongAmount.txid, ctx(cases.vkey));
  assert.equal(stepOf(rejected, "indexer").status, "skip");
  assert.doesNotMatch(stepOf(rejected, "indexer").detail, /Agrees/);

  // A proof that really fails is still called out.
  const lying = await verifyTx(T.mint.txid, ctx({ groth16Verify: async () => false }));
  assert.equal(lying.verdict, "mismatch");
  assert.equal(failedStep(lying).fault, "rule");
});

/* ---------- finding 31 ---------- */

test("31: rule violations the browser finds itself expose an indexer that accepted them", async () => {
  for (const [name, at] of [["mintCopy", "bound"], ["wrongAmount", "terms"], ["underpaid", "treasury"], ["late", "root"]]) {
    const r = await verifyTx(T[name].txid, ctx({ indexerVerdict: acceptsAll }));
    assert.equal(r.verdict, "mismatch", `${name}: ${JSON.stringify(r.steps, null, 1)}`);
    assert.equal(failedStep(r).id, at, name);
    assert.equal(failedStep(r).fault, "rule", name);
    assert.match(stepOf(r, "indexer").detail, /Do not trust this indexer/, name);
  }
  const late = await verifyTx(T.late.txid, ctx({ indexerVerdict: acceptsAll }));
  // The block height is mempool.space's claim (A-9), so the row is BTC, never YOU or IDX.
  assert.equal(stepOf(late, "root").source, "BTC", "the window check uses mempool.space's height, no indexer data");

  // With the honest indexer the same failures agree with it.
  const honest = await verifyTx(T.late.txid, ctx());
  assert.equal(honest.verdict, "failed");
  assert.equal(stepOf(honest, "indexer").status, "ok");
  assert.match(stepOf(honest, "indexer").detail, /anchor outside window\. Agrees with your browser/);
});

/* ---------- finding 35 ---------- */

test("35: a pool-history rejection is the indexer's word: the comparison row is neutral", async () => {
  const capped = async (txid) => ({ ...logOf(txid), ok: false, reason: "mint cap reached" });
  const r = await verifyTx(T.mint.txid, ctx({ indexerVerdict: capped }));
  assert.equal(r.verdict, "rejected");
  assert.equal(r.ok, true);
  const ix = stepOf(r, "indexer");
  assert.equal(ix.ok, null);
  assert.equal(ix.status, "skip");
  assert.match(ix.detail, /pool history, which your browser can't see/);

  const { compareBody } = await import("../web/src/views/receipt.js");
  const body = String(compareBody(r));
  assert.doesNotMatch(body, /They agree/);
  assert.match(body, /rests on pool history your browser can't see/);
  assert.match(body, /data-prov="IDX"/);
  assert.doesNotMatch(body, /data-prov="YOU"/);
  // Accepted, with no replay of the user's own: the checked rules agree, the history rules are the
  // indexer's word (audit V2-30), so never a bare "They agree".
  const agreed = String(compareBody(await verifyTx(T.mint.txid, ctx())));
  assert.match(agreed, /Agrees on every rule your browser checked/);
  assert.doesNotMatch(agreed, /They agree/);
  assert.match(agreed, /data-prov="IDX"/);
});

/* ---------- receipt headline and seal (findings 29, 30, 31) ---------- */

test("receipt: the headline and seal follow rule vs data, not the provenance chip", async () => {
  const { heroText, sealFor } = await import("../web/src/views/receipt.js");
  const bound = await verifyTx(T.mintCopy.txid, ctx());
  assert.equal(heroText(bound)[0], "Breaks a protocol rule.");
  const window = await verifyTx(T.late.txid, ctx());
  assert.equal(heroText(window)[0], "Proof failed.");
  assert.equal(sealFor(window).state, "rejected");

  const noKey = await verifyTx(T.mint.txid, ctx({ vkeyBytes: async () => { throw new Error("offline"); } }));
  assert.equal(heroText(noKey)[0], "Couldn't finish the check.");
  assert.equal(sealFor(noKey).state, "accepted", "the indexer's claim, not a browser result");

  overrides.hex.set(T.mint.txid, T.deploy.hex);
  try {
    assert.equal(heroText(await verifyTx(T.mint.txid, ctx()))[0], "Bitcoin data failed a check.");
  } finally {
    overrides.hex.delete(T.mint.txid);
  }

  const attest = await verifyTx(T.attestOther.txid, ctx());
  assert.equal(heroText(attest)[0], "Attestation checked.");
  assert.match(heroText(attest)[1], /carries no authority/);
});

/* ---------- finding 32 ---------- */

test("32: the share card says what the receipt says", async () => {
  const { receiptCardText } = await import("../web/src/verify/share-card.js");
  const ok = receiptCardText({ opName: "TRANSFER", verdict: "verified", rootSource: "rebuild", proofMs: 412 });
  assert.equal(ok.title, "Proof on Bitcoin.");
  assert.equal(ok.line, "Verified in the browser.");
  assert.match(ok.rootLine, /rebuilt from the indexer's commitments/);
  assert.match(ok.footer, /no value/);
  assert.match(ok.footer, /A-8/);
  assert.match(receiptCardText({ opName: "MINT", verdict: "verified", rootSource: "indexer", proofMs: 9 }).rootLine, /reported by the indexer/);

  const rejected = receiptCardText({ opName: "MINT", verdict: "rejected" });
  assert.equal(rejected.line, "Rejected by the indexer.");
  assert.equal(rejected.tone, "danger");
  assert.equal(receiptCardText({ opName: "TRANSFER", verdict: "mismatch" }).line, "Browser and indexer disagree.");
  const noData = receiptCardText({ opName: "TRANSFER", verdict: "failed", fault: "data" });
  assert.equal(noData.line, "Couldn't be checked.");
  assert.equal(noData.tone, "neutral");
  assert.equal(receiptCardText({ opName: "TRANSFER", verdict: "failed", fault: "rule" }).line, "Failed in the browser.");

  for (const opName of ["DEPLOY", "ATTEST"]) {
    const c = receiptCardText({ opName, verdict: "verified", proofMs: null });
    assert.doesNotMatch(`${c.title} ${c.line} ${c.footer}`, /proof/i, opName);
    assert.equal(c.proofLine, null);
    assert.match(c.footer, /no value/);
  }

  // A genesis ATTEST of another manifest passes its checks but is no green result.
  const attest = await verifyTx(T.attestOther.txid, ctx());
  const other = receiptCardText({ opName: attest.opName, verdict: attest.verdict, pinned: attest.attest.pinned });
  assert.equal(other.line, "Names another manifest.");
  assert.equal(other.tone, "neutral");
  assert.match(other.note, /carries no authority/);
  assert.doesNotMatch(`${other.title} ${other.line} ${other.note} ${other.footer}`, /proof|checked in the browser/i);
  const pinned = receiptCardText({ opName: "ATTEST", verdict: "verified", pinned: true });
  assert.equal(pinned.line, "Checked in the browser.");
  assert.equal(pinned.tone, "proof");
  assert.equal(pinned.note, null);
  assert.match(readFileSync("web/src/views/receipt.js", "utf8"), /pinned: r\.attest\?\.pinned/, "the receipt passes it to the card");
});

/* ---------- findings 33 and 41 ---------- */

test("33, 41: the security page states what receipts trust and lists every review finding", async () => {
  const { render } = await import("../web/src/views/security.js");
  const root = {};
  render(root);
  const page = String(root.innerHTML);
  assert.doesNotMatch(page, /unless you replayed the pool/);
  assert.match(page, /even after you replay the pool/);
  assert.doesNotMatch(page, /A-1 to A-9/);

  const { auditFacts } = await import("../scripts/facts.mjs");
  const md = [
    "| ID | Severity | Where | Issue | Status |",
    "|---|---|---|---|---|",
    "| A-10 | Invariant | protocol | Validity never depends on the carrier. | documented |",
    "| W-1 | Invariant | wallet | Retries reuse the same notes. | implemented in the wallet; tested |",
    "| R-1 | Info | relayer | The relayer sees IP and timing. | documented in the UI and README |",
  ].join("\n");
  const a = auditFacts(md);
  assert.deepEqual(a.findings.map((f) => [f.id, f.state]), [["A-10", "documented"], ["W-1", "tested"], ["R-1", "documented"]]);
  const ids = auditFacts(readFileSync("audit/REPORT.md", "utf8")).findings.map((f) => f.id);
  for (const id of ["A-1", "A-9", "A-11", "W-1", "R-1"]) assert.ok(ids.includes(id), id);
});

/* ---------- finding 38 ---------- */

test("38: the receipt's anchor root never asks our indexer about one height", async () => {
  const { rootOfLeaves } = await import("../web/src/verify/rebuild.js");
  const rows = [["5", 1001], ["7", 1050]];
  const memo = new Map();
  const rootAt = (h) => {
    const n = rows.filter(([, x]) => x <= h).length;
    if (!memo.has(n)) memo.set(n, rootOfLeaves(rows.slice(0, n).map(([c]) => c)).toString());
    return memo.get(n);
  };
  let wrong = new Map();
  web = (url) => {
    const u = new URL(url, "http://x");
    const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/state") return json({ startHeight: 1000, height: 1150, outputs: rows.length, root: rootAt(1150) });
    if (u.pathname === "/api/commitments") return json(rows);
    if (u.pathname === "/api/roots") {
      const out = [];
      for (let h = Math.max(999, Number(u.searchParams.get("from"))); h <= Math.min(1150, Number(u.searchParams.get("to"))); h++) out.push([h, wrong.get(h) ?? rootAt(h)]);
      return json(out);
    }
    return new Response("{}", { status: 404 });
  };
  webCalls.length = 0;
  const { anchorRoot } = await import("../web/src/verify/engine.js");
  const { ROOTS_PAGE, rootsAll } = await import("../web/src/verify/pool-data.js");
  for (const h of [1100, 1020]) {
    const r = await anchorRoot(h);
    assert.equal(r.kind, "rebuild");
    assert.equal(r.root, rootAt(h));
    assert.ok(!r.mismatch);
  }
  const rootCalls = webCalls.filter((u) => u.startsWith("/api/roots"));
  assert.ok(rootCalls.length >= 1);
  for (const u of rootCalls) {
    const q = new URL(u, "http://x").searchParams;
    const from = Number(q.get("from"));
    assert.equal((from - 999) % ROOTS_PAGE, 0, `${u}: pages start at fixed boundaries`);
    assert.equal(Number(q.get("to")), from + ROOTS_PAGE - 1, u);
  }
  assert.ok(!webCalls.some((u) => /\b(1100|1020)\b/.test(u)), `no request names an anchor height: ${webCalls.join(" ")}`);

  // A stale cached page is re-read before anything is called a mismatch.
  wrong = new Map([[1100, "123"]]);
  await rootsAll({ fresh: true });
  wrong = new Map();
  assert.ok(!(await anchorRoot(1100)).mismatch);
  wrong = new Map([[1100, "123"]]);
  await rootsAll({ fresh: true });
  const bad = await anchorRoot(1100);
  assert.equal(bad.mismatch, true);
  assert.match(bad.detail, /Do not trust this indexer/);
  web = () => new Response("{}", { status: 404 });
});

/* ---------- finding 34 ---------- */

test("34: the pool comparison refreshes the indexer's log and never reads a failed request as a difference", async () => {
  const { compareReplay } = await import("../web/src/verify/replay.js");
  const { logAll } = await import("../web/src/verify/pool-data.js");
  const H = [...Array(11).keys()].map((i) => 500 + i);
  const entry = (seq, height) => ({ seq, height, txid: String(seq).repeat(64).slice(0, 64), ok: true, op: 1 });
  const snapshot = {
    height: 510,
    startHeight: 500,
    protocol: "test",
    digests: H.map((h) => [h, `d${h}`]),
    hashes: H.map((h) => [h, `hash${h}`]),
    roots: H.map((h) => [h, `root${h}`]),
    log: [entry(0, 505), entry(1, 508)],
  };
  idbData.set("fixv.replay", { snapshot, spentBy: [] });
  // The indexer differs from #508 on only in its nullifier set: same hashes, roots and log.
  const remoteDigest = (h) => (h < 508 ? `d${h}` : `x${h}`);
  let remoteLog = [entry(0, 505)];
  let failDigests = () => false;
  web = (url) => {
    const u = new URL(url, "http://x");
    const q = u.searchParams;
    const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/state") return json({ height: 510, startHeight: 500, protocol: "test" });
    if (u.pathname === "/api/digest") {
      const h = Number(q.get("height"));
      return json({ height: h, digest: remoteDigest(h), blockHash: `hash${h}`, root: `root${h}` });
    }
    if (u.pathname === "/api/digests") {
      const h = Number(q.get("from"));
      if (failDigests(h)) return new Response(JSON.stringify({ error: { message: "upstream error" } }), { status: 502 });
      return json([[h, remoteDigest(h)]]);
    }
    if (u.pathname === "/api/log") return json({ items: remoteLog.slice(Number(q.get("from") ?? 0)), next: null });
    return new Response("{}", { status: 404 });
  };
  try {
    // The page loaded the log before block #508 existed; the replay finished later.
    await logAll();
    remoteLog = [entry(0, 505), entry(1, 508)];
    const r = await compareReplay({ key: "fixv.replay" });
    assert.equal(r.ok, false);
    assert.equal(r.firstDivergence, 508);
    assert.equal(r.component, "nullifiers-or-assets", r.text);

    // One failed request during the binary search is retried, so the height stays right.
    const seen = new Map();
    failDigests = (h) => {
      seen.set(h, (seen.get(h) ?? 0) + 1);
      return h === 504 && seen.get(h) === 1;
    };
    const again = await compareReplay({ key: "fixv.replay" });
    assert.equal(seen.get(504), 2, "the failed request was retried");
    assert.equal(again.firstDivergence, 508);

    // An indexer that keeps failing: "couldn't compare", and no false result is saved.
    const saved = idbData.get("fixv.replay.result");
    failDigests = () => true;
    await assert.rejects(compareReplay({ key: "fixv.replay" }), /upstream error/);
    assert.deepEqual(idbData.get("fixv.replay.result"), saved);
  } finally {
    web = () => new Response("{}", { status: 404 });
  }
});

test("38: pool data cached from one indexer is never served for another", async () => {
  const api = await import("../web/src/api.js");
  const { rootsAll, logAll, verdictOf } = await import("../web/src/verify/pool-data.js");
  const OTHER = "http://other-indexer.invalid";
  const tagOf = (u) => (u.origin === OTHER ? "9" : "1");
  web = (url) => {
    const u = new URL(url, "http://x");
    const json = (v) => new Response(JSON.stringify(v), { headers: { "content-type": "application/json" } });
    if (u.pathname === "/api/state") return json({ startHeight: 1000, height: 1010, outputs: 0, root: "0" });
    if (u.pathname === "/api/roots") {
      const out = [];
      for (let h = Math.max(999, Number(u.searchParams.get("from"))); h <= Math.min(1010, Number(u.searchParams.get("to"))); h++) out.push([h, `${tagOf(u)}${h}`]);
      return json(out);
    }
    if (u.pathname === "/api/log") return json({ items: [{ seq: 0, height: 1005, txid: tagOf(u).repeat(64), ok: tagOf(u) === "1" }], next: null });
    return new Response("{}", { status: 404 });
  };
  try {
    assert.equal(api.indexerBase(), "");
    assert.equal((await rootsAll({ fresh: true })).roots.get(1005), "11005");
    await logAll();
    api.setIndexerBase(OTHER);
    webCalls.length = 0;
    // Within the 20 s cache window, and without asking for fresh data.
    const roots = await rootsAll();
    assert.equal(roots.roots.get(1005), "91005", "roots come from the indexer now in use");
    assert.ok(![...roots.roots.values()].some((r) => r.startsWith("1")), "no root of the previous indexer is kept");
    assert.deepEqual((await logAll()).map((e) => e.txid), ["9".repeat(64)]);
    assert.equal((await verdictOf("9".repeat(64))).ok, false);
    assert.ok(webCalls.length > 0 && webCalls.every((u) => u.startsWith(`${OTHER}/api/`)), webCalls.join(" "));
    api.setIndexerBase("");
    assert.equal((await rootsAll()).roots.get(1005), "11005", "switching back starts over too");
  } finally {
    api.setIndexerBase("");
    web = () => new Response("{}", { status: 404 });
  }
});

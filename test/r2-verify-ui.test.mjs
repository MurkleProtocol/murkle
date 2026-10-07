// Regression tests for the second review round, verification UI (numbered tests refer to findings of an internal review):
// the Proof Wall verdicts, the pool share text, the receipt's "My view" under
// streamer mode, the indexer links, the disclosure contact and the meta description.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { registerHooks } from "node:module";
import { sha256 } from "@noble/hashes/sha256";
import { encodeAttest, ATTEST_KIND } from "../src/envelope.mjs";
import { btcAccount, planCarrierTx, signLocal } from "../src/btc/funding.mjs";
import { concat, hex, u32le, unhex } from "../src/bytes.mjs";
import { verifyTx, headerFields } from "../src/verify-tx.mjs";
import { wallVerdict, wallSummary } from "../web/src/share/wall.js";
import { SECURITY_CONTACT } from "../src/params.mjs";

// Web modules import JSON without attributes and CSS (Vite handles both); teach Node the same.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (url.endsWith(".json") && !context.importAttributes?.type) return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
    return nextLoad(url, context);
  },
});

const read = (f) => readFileSync(f, "utf8");
const dsha = (b) => sha256(sha256(b));
const rev = (b) => Uint8Array.from(b).reverse();

/* ---------- a one-transaction chain for real engine results ---------- */

const payerKey = randomBytes(32);
const payer = btcAccount(payerKey);

function attestChain(hash32) {
  const first = { txid: randomBytes(32).toString("hex"), vout: 0, value: 100_000 };
  const { tx } = planCarrierTx({ account: payer, utxos: [first], envelope: encodeAttest({ kind: ATTEST_KIND.GENESIS, hash: hash32 }), feeRate: 1, firstInput: first });
  const signed = signLocal(tx, payerKey);
  const height = 400_000;
  const coinbase = randomBytes(32);
  const leaf = rev(unhex(signed.txid));
  const root = dsha(concat(coinbase, leaf));
  let header;
  for (let nonce = 0; ; nonce++) {
    header = concat(u32le(0x20000000), new Uint8Array(32), root, u32le(1_700_000_000), u32le(0x207fffff), u32le(nonce));
    if (headerFields(header).meetsTarget) break;
  }
  const blockHash = hex(rev(dsha(header)));
  const esplora = {
    base: "https://esplora.invalid/api",
    txHex: async (t) => {
      if (t !== signed.txid) throw new Error("Transaction not found: 404");
      return signed.hex;
    },
    txStatus: async () => ({ confirmed: true, block_height: height, block_hash: blockHash, block_time: 1_700_000_000 }),
    tipHeight: async () => height,
    merkleProof: async () => ({ block_height: height, merkle: [hex(rev(coinbase))], pos: 1 }),
    blockHeader: async () => hex(header),
  };
  // Every decodable ATTEST is logged as accepted by the production indexer.
  const entry = { seq: 1, height, txid: signed.txid, opName: "ATTEST", ok: true };
  return { txid: signed.txid, entry, esplora };
}

const checkAttest = (manifestSha256) => {
  const hash32 = randomBytes(32).toString("hex");
  const c = attestChain(hash32);
  return {
    c,
    run: (manifest = manifestSha256 ?? hash32) =>
      verifyTx(c.txid, { esplora: c.esplora, manifestSha256: manifest, genesisTxid: null, indexerVerdict: async () => c.entry }),
  };
};

/* ---------- wall.js: findings 29, 30, 31 ---------- */

test("#29 the wall shows a genesis ATTEST of another manifest as muted and doesn't count it as verified", async () => {
  const { c, run } = checkAttest("ab".repeat(32));
  const r = await run();
  assert.equal(r.verdict, "verified", JSON.stringify(r.steps, null, 1));
  assert.equal(r.attest.pinned, false);
  const v = wallVerdict(r, c.entry);
  assert.deepEqual([v.tone, v.title, v.prov, v.other], ["muted", "Other manifest", "YOU", true]);
  assert.match(v.detail, /carries no authority and never changes the pool/);
  assert.equal(wallSummary([v]), "0 verified in your browser · 1 names another manifest");

  const ok = wallVerdict({ verdict: "verified", proofMs: 23, steps: [] });
  assert.equal(wallSummary([ok, v, v]), "1 verified in your browser · 2 name another manifest");

  // The pinned manifest is still a green "Checked".
  const pinned = await checkAttest().run();
  assert.equal(pinned.attest.pinned, true);
  const pv = wallVerdict(pinned, null);
  assert.deepEqual([pv.tone, pv.title, pv.other], ["proof", "Checked", undefined]);
});

test("#30 a data fault on a YOU step reads \"Couldn't check\", never \"Failed in your browser\"", async () => {
  // A build without a pinned manifest: the attest step can't finish (a data fault, source YOU).
  const { c, run } = checkAttest();
  const r = await run("not-a-hash");
  assert.equal(r.verdict, "failed");
  const failed = r.steps.find((s) => s.status === "fail");
  assert.deepEqual([failed.id, failed.source, failed.fault], ["attest", "YOU", "data"]);
  const v = wallVerdict(r, c.entry);
  assert.deepEqual([v.tone, v.title], ["muted", "Couldn't check"]);

  // A vkey fetch or a snarkjs chunk that failed to load, as the engine reports them.
  const step = (id, source, fault, label = id) => ({ id, source, status: "fail", fault, label, detail: "offline" });
  for (const id of ["vkey", "groth16"]) {
    const w = wallVerdict({ verdict: "failed", steps: [step(id, "YOU", "data")] }, { ok: true });
    assert.deepEqual([w.tone, w.title], ["muted", "Couldn't check"], id);
  }
  // A rejected envelope keeps the indexer's reason in red, with the browser's honest "couldn't".
  const rej = wallVerdict({ verdict: "failed", steps: [step("vkey", "YOU", "data", "Verification key")] }, { ok: false, reason: "cap reached" });
  assert.deepEqual([rej.tone, rej.title, rej.prov], ["danger", "Rejected by indexer", "IDX"]);
  assert.match(rej.detail, /^cap reached\. Your browser couldn't re-check it: offline/);
});

test("#31 a rule fault is a real result whatever its chip: never \"Couldn't check\"", () => {
  const step = (id, source, label) => ({ id, source, status: "fail", fault: "rule", label, detail: "broken" });
  // Honest rejection: the browser saw the same rule broken.
  const window = wallVerdict({ verdict: "failed", steps: [step("root", "IDX", "Anchor root")] }, { ok: false, reason: "anchor outside window" });
  assert.deepEqual([window.tone, window.title, window.prov], ["danger", "Rejected", "YOU"]);
  assert.equal(window.detail, 'anchor outside window. Your browser agrees: the check "Anchor root" failed.');
  const terms = wallVerdict({ verdict: "failed", steps: [step("terms", "BTC", "Mint amount matches the terms")] }, { ok: false, reason: "mint amount differs" });
  assert.equal(terms.title, "Rejected");
  // No indexer verdict yet: the browser's own result stands.
  for (const [id, source] of [["terms", "BTC"], ["root", "IDX"], ["bound", "BTC"]]) {
    const v = wallVerdict({ verdict: "failed", steps: [step(id, source, id)] });
    assert.deepEqual([v.tone, v.title], ["danger", "Failed in your browser"], id);
  }
  // Results without a fault (older engines) keep the step-id fallback.
  const legacy = wallVerdict({ verdict: "failed", steps: [{ id: "root", source: "IDX", status: "fail", label: "Anchor root" }] }, { ok: true });
  assert.equal(legacy.tone, "muted");
});

/* ---------- share-card.js: finding 36 ---------- */

test("#36 the copied pool text says signet and no value", async () => {
  const { poolCardText } = await import("../web/src/verify/share-card.js");
  const base = { proofs: 12, blocks: 3, seconds: 4.2, height: 324600, digest: "deadbeefcafe" };
  for (const matched of [true, false]) {
    const t = poolCardText({ ...base, matched });
    assert.match(t, /^My browser verified 12 proofs across 3 Bitcoin signet blocks \(test network, no value\) in 4 s\./);
  }
  assert.match(poolCardText({ ...base, proofs: 1, blocks: 1, matched: true }), /1 proof across 1 Bitcoin signet block \(test network, no value\)/);
});

/* ---------- receipt.js: findings 6, 42, 44 ---------- */

test("#6 the receipt's My view masks amounts and addresses in streamer mode", async () => {
  const { myTransferRows } = await import("../web/src/views/receipt.js");
  const session = await import("../web/src/session.js");
  const to = "mrk1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqsnzs23v9ccr";
  const sent = { outputs: [{ index: 1, asset: 7n, amount: 4321n, ticker: "HEX", div: 2 }], spent: [{ index: 0, asset: 7n, amount: 98765n, ticker: "HEX", div: 2 }], history: { kind: "send", ticker: "HEX", amount: 55555n, div: 2, to } };
  const received = { outputs: [{ index: 0, asset: 7n, amount: 24680n, ticker: "HEX", div: 2 }], spent: [], history: null };
  const text = (rows) => rows.map(([k, v]) => `${k}: ${v}`).join("\n");
  const before = session.streamerMode();
  try {
    session.setStreamerMode(false);
    const open = text(myTransferRows(sent));
    for (const s of ["555.55", "987.65", "43.21", to.slice(4, 8)]) assert.ok(open.includes(s), s);
    assert.ok(text(myTransferRows(received)).includes("246.8"));

    session.setStreamerMode(true);
    const hidden = text(myTransferRows(sent)) + text(myTransferRows(received));
    for (const s of ["555.55", "987.65", "43.21", "246.8", to.slice(4, 8), to.slice(-6)]) assert.ok(!hidden.includes(s), `leaks ${s}`);
    assert.match(hidden, /class="redact redact--amount"/);
    assert.match(hidden, /mrk1…/);
    assert.match(hidden, /HEX/, "the token stays, as on the wallet screens");
  } finally {
    session.setStreamerMode(before);
  }
});

test("#42 spent-note bars carry the sender-only tip; a mint's next move gets a neutral tip", async () => {
  const { myTransferRows } = await import("../web/src/views/receipt.js");
  const { redactTip } = await import("../web/src/ui/redact.js");
  const spentRow = myTransferRows({ outputs: [{ index: 0, asset: 1n, amount: 5n }], spent: [], history: null }).find(([k]) => k === "Which notes were spent")[1];
  assert.ok(String(spentRow).includes(`data-tip="${redactTip("spent")}"`));
  const src = read("web/src/views/receipt.js");
  assert.ok(!src.includes('redact("address")'), "no spent-notes row uses the address tip");
  assert.match(src, /\["Which notes were spent", redact\("spent"\)\]/);
  assert.match(src, /\["What the owner does with it next", redact\("amount", \{ tip: NEXT_TIP \}\)\]/);
  const tip = src.match(/const NEXT_TIP = "([^"]+)"/)[1];
  assert.doesNotMatch(tip, /sender|recipient/i);
});

test("#44 the receipt's mismatch copy links to the public indexer switch", async () => {
  const { heroText } = await import("../web/src/views/receipt.js");
  const { INDEXER_HREF } = await import("../web/src/ui/indexer.js");
  const sub = String(heroText({ verdict: "mismatch", steps: [], opName: "TRANSFER", status: { confirmed: true, height: 5 } })[1]);
  assert.ok(sub.includes(`<a href="${INDEXER_HREF}" data-link>switch to your own</a>`), sub);
  assert.doesNotMatch(sub, /Settings/);
  // Other subs stay plain text, escaped when painted.
  const failed = heroText({ verdict: "failed", steps: [{ id: "fetch", status: "fail", fault: "data", source: "BTC", label: "L", detail: "<b>x</b>" }] })[1];
  assert.equal(typeof failed, "string");
  assert.match(read("web/src/views/receipt.js"), /sub\.innerHTML = html`\$\{T\[1\]\}`;/);
});

/* ---------- lookup.js and token.js: finding 44 ---------- */

test("#44 lookup and token pages send indexer switching to /verify#indexer", () => {
  for (const f of ["web/src/views/lookup.js", "web/src/views/token.js"]) {
    const src = read(f);
    assert.ok(!/in Settings/.test(src), f);
    assert.ok(!src.includes("/app/settings#indexer"), f);
    assert.match(src, /import \{ INDEXER_HREF \} from "\.\.\/ui\/indexer\.js";/, f);
    assert.ok(src.includes('<a href="${INDEXER_HREF}" data-link>'), f);
  }
  assert.ok(!read("web/src/views/token.js").includes("settingsHref"), "the seal's default is the public switch");
});

/* ---------- security.js and params.mjs: finding 37 ---------- */

test("#37 the disclosure text never dangles: a contact when set, a plain statement when not", async () => {
  const { disclosure, render } = await import("../web/src/views/security.js");
  const none = String(disclosure({ contact: null, repoUrl: null }));
  assert.doesNotMatch(none, /maintainers/);
  assert.match(none, /No private reporting channel is published yet\. One will be published on this page before any public launch\./);
  assert.match(none, /Signet coins have no value/);

  const mail = String(disclosure({ contact: "security@murkle.example", repoUrl: null }));
  assert.match(mail, /privately to <a href="mailto:security@murkle\.example">security@murkle\.example<\/a>, with steps to reproduce\./);
  const url = String(disclosure({ contact: "https://murkle.example/report", repoUrl: null }));
  assert.match(url, /<a href="https:\/\/murkle\.example\/report" target="_blank" rel="noopener noreferrer">murkle\.example\/report<\/a>/);
  const odd = String(disclosure({ contact: "javascript:alert(1)", repoUrl: null }));
  assert.doesNotMatch(odd, /href="javascript/);
  const repo = String(disclosure({ contact: null, repoUrl: "https://git.example/murkle" }));
  assert.match(repo, /private security advisory on the <a href="https:\/\/git\.example\/murkle"/);

  const root = {};
  render(root);
  const page = String(root.innerHTML);
  assert.doesNotMatch(page, /to the maintainers/);
  if (SECURITY_CONTACT == null) assert.match(page, /before any public launch/);
  else assert.ok(page.includes(SECURITY_CONTACT));
});

test("#37 params.mjs exports SECURITY_CONTACT (null until a channel is published)", () => {
  assert.ok(SECURITY_CONTACT === null || /^(https:\/\/\S+|[^\s@]+@[^\s@]+\.[^\s@]+)$/.test(SECURITY_CONTACT));
});

/* ---------- index.html: finding 43 ---------- */

test("#43 the meta description says mints are public, as the spec does", () => {
  const page = read("web/index.html");
  const meta = page.match(/<meta name="description" content="([^"]+)" \/>/)[1];
  assert.equal(meta, "Launch and mint tokens on Bitcoin L1 in public, then send them privately. Proofs are written to Bitcoin and verified in your browser. Signet testnet.");
  assert.equal(meta, read("docs/design/visual.md").match(/^- description: "([^"]+)"/m)[1]);
  assert.ok(!/mint and send private/i.test(page));
});

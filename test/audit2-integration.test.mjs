// Audit 2, integration of the cross-area follow-ups the area fixes left open:
// V2-29 the receipt headline for a proof that fails only against the indexer's root;
// V2-30 "They agree" only when the history rules were checked by the user's own replay, and the
//       browser passes ctx.replayVerdict from that replay;
// V2-10 the client frame guard; V2-15 the test explorer answers like mempool.space;
// V2-06 / V2-42 the treasury figure is labelled as gross; V2-41 the CLI keeps its own state file;
// V2-40 a failed audit names the last applied block; V2-18 / V2-31 / V2-15 / V2-16 docs follow the code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";

// Web modules import JSON without attributes and CSS (Vite handles both); teach Node the same.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (url.endsWith(".json") && !context.importAttributes?.type) return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
    return nextLoad(url, context);
  },
});

const read = (f) => readFileSync(f, "utf8");
const CYRILLIC = new RegExp(`[${String.fromCharCode(0x400)}-${String.fromCharCode(0x4ff)}]`);
const { compareBody, heroText } = await import("../web/src/views/receipt.js");
const { replayVerdictAt } = await import("../web/src/verify/replay.js");
const { isFramed, frameAllowed, EMBED_ROUTES } = await import("../web/src/frame-guard.js");
const { RELAY_TEXT } = await import("../web/src/views/app-shared.js");
const { FakeEsplora } = await import("./fixtures/relay-harness.mjs");
const { seedState } = await import("../bin/murkle.mjs");

const okStep = (detail) => ({ id: "indexer", status: "ok", ok: true, label: "Indexer", detail });

/* ---------- V2-30 receipt comparison ---------- */

test("V2-30: the comparison says 'They agree' only when the user's own replay judged the history rules", () => {
  const base = { verdict: "verified", opName: "MINT", steps: [okStep("Accepted at #5 · agrees with every rule your browser checked")] };
  const idx = String(compareBody({ ...base, historyFrom: "IDX" }));
  assert.doesNotMatch(idx, /They agree/);
  assert.match(idx, /Agrees on every rule your browser checked/);
  assert.match(idx, /Spent notes and the mint cap rest on the indexer's log/);
  assert.match(idx, /data-prov="YOU"/, "the checked rules are the browser's");
  assert.match(idx, /data-prov="IDX"/, "the history rules are the indexer's");
  const deploy = String(compareBody({ ...base, opName: "DEPLOY", historyFrom: "IDX" }));
  assert.match(deploy, /The free-ticker rule rests on the indexer's log/);

  const mine = String(compareBody({ ...base, historyFrom: "YOU" }));
  assert.match(mine, /They agree/);
  assert.doesNotMatch(mine, /data-prov="IDX"/);
  // ATTEST has no history rules: the field is absent and the browser checked everything.
  assert.match(String(compareBody({ ...base, opName: "ATTEST" })), /They agree/);
});

test("V2-30: the browser passes its own replay's verdict to the engine (receipt, wall and live checks)", () => {
  assert.match(read("web/src/verify/engine.js"), /indexerVerdict: \(t, \{ height \}\) => verdictOf\(t, \{ height \}\),\r?\n\s+replayVerdict,/);
  assert.match(read("web/src/share/live-check.js"), /import \{ anchorRoot, replayVerdict, vkeyBytes \} from "\.\.\/verify\/engine\.js";/);
  assert.match(read("web/src/share/live-check.js"), /^\s+replayVerdict,$/m);
});

test("V2-30: replayVerdictAt returns the replay's own entry only while it covers a block that is still the chain's", async () => {
  const H = "aa".repeat(32);
  const tx = "cd".repeat(32);
  const entry = { seq: 1, height: 100, index: 1, txid: tx, op: 2, opName: "MINT", ok: false, reason: "mint cap reached" };
  const replay = {
    snapshot: { startHeight: 90, height: 101, log: [{ seq: 0, height: 95, txid: "ef".repeat(32), ok: true }, entry, { seq: 2, height: 101, txid: tx, ok: true }] },
    hashes: new Map([[100, H], [101, "bb".repeat(32)]]),
  };
  const at = (hash) => async () => hash;
  assert.deepEqual(await replayVerdictAt(tx.toUpperCase(), { height: 100, replay, blockHash: at(H) }), entry);
  assert.equal(await replayVerdictAt(tx, { height: 100, replay, blockHash: at("bb".repeat(32)) }), null, "reorged since the replay");
  assert.equal(await replayVerdictAt(tx, { height: 100, replay, blockHash: async () => Promise.reject(new Error("offline")) }), null);
  assert.equal(await replayVerdictAt(tx, { height: 102, replay, blockHash: at(H) }), null, "past the replay");
  assert.equal(await replayVerdictAt(tx, { height: 89, replay, blockHash: at(H) }), null, "before the replay");
  assert.equal(await replayVerdictAt(tx, { height: null, replay, blockHash: at(H) }), null, "unconfirmed");
  assert.equal(await replayVerdictAt("12".repeat(32), { height: 100, replay, blockHash: at(H) }), null, "no entry in that block");
});

/* ---------- V2-29 receipt headline ---------- */

test("V2-29: a proof that fails only against the indexer's root gets its own headline and a link to Verify the Pool", () => {
  const steps = [{ id: "groth16", status: "fail", fault: "data", source: "YOU", label: "Groth16", detail: "x" }];
  const [head, sub] = heroText({ verdict: "failed", untrustedRootFail: true, steps, opName: "TRANSFER", status: { confirmed: true, height: 5 } });
  assert.equal(head, "Doesn't verify against the indexer's root.");
  assert.ok(String(sub).includes('<a href="/verify#pool" data-link>Verify the Pool</a>'), String(sub));
  assert.equal(heroText({ verdict: "failed", steps, opName: "TRANSFER" })[0], "Couldn't finish the check.", "other data faults keep the generic headline");
});

/* ---------- V2-10 frame guard ---------- */

test("V2-10: the client frame guard refuses every route inside a frame and runs before the app", () => {
  const top = {};
  assert.equal(isFramed(undefined), false, "no window (node)");
  assert.equal(isFramed({ top, self: top }), false);
  assert.equal(isFramed({ top: {}, self: {} }), true);
  const crossOrigin = { self: {}, get top() { throw new Error("SecurityError"); } };
  assert.equal(isFramed(crossOrigin), true, "an unreadable parent counts as framed");
  assert.equal(EMBED_ROUTES.length, 0, "no route may be framed until the /embed/t/:TICKER view exists");
  for (const p of ["/", "/app", "/app/send", "/embed/HEX", "/embed/t/ABC", "/tx/ab"]) assert.equal(frameAllowed(p), false, p);
  const app = read("web/src/app.js");
  const guard = app.indexOf('import "./frame-guard.js";');
  assert.ok(guard > 0, "app.js imports the guard");
  const firstScript = app.search(/^import (?!")/m);
  assert.ok(guard < firstScript, "the guard is imported before any module with code of its own");
  assert.match(read("web/src/frame-guard.js"), /throw new Error\("Refusing to run inside a frame/);
});

/* ---------- V2-15 the test explorer ---------- */

test("V2-15: the relay harness's explorer answers like mempool.space: /status never 404s, GET /tx does", async () => {
  const fake = new FakeEsplora();
  const unknown = "ab".repeat(32);
  assert.deepEqual(await fake.txStatus(unknown), { confirmed: false });
  await assert.rejects(fake.tx(unknown), /GET \/tx\/[0-9a-f]{64}: 404/);
  const paid = fake.pay([{ script: new Uint8Array([0x51]), value: 1000 }]);
  assert.deepEqual(await fake.tx(paid), { txid: paid, status: { confirmed: false } });
  fake.confirm([paid], 7);
  assert.deepEqual((await fake.tx(paid)).status, { confirmed: true, block_height: 7 });
  // A test that takes txStatus down takes tx() down with it.
  const down = Object.create(fake);
  down.txStatus = async () => { throw new Error("GET /tx/x/status: 503 Service Unavailable"); };
  await assert.rejects(down.tx(paid), /503/);
  assert.match(read("src/btc/esplora.mjs"), /answer 200 \{ confirmed: false \} for a txid\r?\n\s+\* they have never seen, never a 404/);
});

/* ---------- V2-06 / V2-42 treasury ---------- */

test("V2-06 / V2-42: the treasury figure is labelled gross, change included, in the token page, the CLI and the launch form", () => {
  const token = read("web/src/views/token.js");
  assert.doesNotMatch(token, /Treasury received/);
  assert.match(token, /eyebrow: "Sent to treasury address"/);
  assert.match(token, /Gross, change included · price × mints: /);
  const cli = read("bin/murkle.mjs");
  assert.doesNotMatch(cli, /treasury received/);
  assert.match(cli, /sent to treasury address \$\{a\.treasurySats\} sats \(gross, change included\)/);
  assert.match(read("web/src/views/app-launch.js"), /Mints paid from this same address send their change here too/);
});

/* ---------- V2-41 / V2-40 CLI ---------- */

test("V2-41: the CLI keeps its own state file, seeded once from a copy of state.json", () => {
  const cli = read("bin/murkle.mjs");
  assert.match(cli, /const STATE = join\(DATA, "cli-state\.json"\);/);
  assert.doesNotMatch(cli, /saveIndexer\(SHARED_STATE/);
  const dir = mkdtempSync(join(tmpdir(), "murkle-cli-state-"));
  try {
    const state = join(dir, "cli-state.json");
    const shared = join(dir, "state.json");
    assert.equal(seedState({ state, shared }), false, "nothing to seed from");
    writeFileSync(shared, '{"v":1}');
    assert.equal(seedState({ state, shared }), true);
    assert.equal(read(state), '{"v":1}');
    writeFileSync(shared, '{"v":2}');
    assert.equal(seedState({ state, shared }), false, "seeded once: the CLI's own file is never replaced");
    assert.equal(read(state), '{"v":1}');
    assert.equal(read(shared), '{"v":2}', "the shared file is only read");
    assert.deepEqual(readdirSync(dir).sort(), ["cli-state.json", "state.json"], "no temp file left");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.match(read("scripts/demo-a6-copy.mjs"), /\["cli-state\.json", "state\.json"\]/);
});

test("V2-40: a replay that stops on an error names the last block it applied", () => {
  assert.match(read("bin/murkle.mjs"), /throw new Error\(`replay stopped \(\$\{last\}\): \$\{e\.message\}`\);/);
});

/* ---------- docs follow the code ---------- */

test("docs: deposit wording, frame policy, rebuild provenance and explorer 404s match the code", () => {
  const contract = read("docs/design/relay-balance-contract.md");
  assert.ok(contract.includes(`anyWallet: ${JSON.stringify(RELAY_TEXT.anyWallet)},`), "the contract quotes the wallet's copy");
  assert.match(contract, /info\.network === NETWORK/);
  assert.match(contract, /prefs\.relayBy\[poolKey\]/);
  assert.match(contract, /mergeRoom/);
  assert.doesNotMatch(contract, /Merges \(`kind: "merge"`\) are not built yet/);
  assert.doesNotMatch(contract, /`txStatus` 404/);
  for (const f of ["README.md", "docs/design/relay-balance.md", "docs/design/relay-balance-contract.md"]) {
    assert.doesNotMatch(read(f), /exchange included/, f);
  }
  assert.match(read("README.md"), /Pay it from any signet wallet/);
  assert.doesNotMatch(read("README.md"), /from all published commitments/);
  assert.match(read("README.md"), /`cli-state\.json`/);
  const visual = read("docs/design/visual.md");
  assert.doesNotMatch(visual, /frame-ancestors \*/);
  assert.match(visual, /\/embed\/t\/:TICKER/);
  assert.doesNotMatch(visual, /State verified: root matches/);
  assert.match(visual, /Indexer consistent: root matches at/);
  assert.doesNotMatch(visual, /upgrades to YOU when the Worker rebuild/);
  assert.match(read("docs/design/relayer.md"), /`\/tx\/<txid>\/status` answers 200 `\{ confirmed: false \}`/);
  assert.match(read("Dockerfile"), /-e MURKLE_PUBLIC_URL=/);
  const apiDoc = read("docs/API.md");
  assert.match(apiDoc, /503 `unavailable`/);
  assert.match(apiDoc, /400 when `height` is empty or not an integer/);
});

test("my files keep their line endings and are English only", () => {
  const crlf = ["bin/murkle.mjs", "web/src/app.js", "web/src/views/receipt.js", "web/src/verify/engine.js", "web/src/share/live-check.js", "src/btc/esplora.mjs", "src/verify-tx.mjs", "web/src/views/app-launch.js", "scripts/demo-a6-copy.mjs"];
  const lf = ["web/src/frame-guard.js", "web/src/verify/replay.js", "web/src/views/token.js", "test/fixtures/relay-harness.mjs", "test/audit2-integration.test.mjs", "Dockerfile", "README.md", "docs/API.md", "docs/design/visual.md", "docs/design/relayer.md", "docs/design/relay-balance.md", "docs/design/relay-balance-contract.md"];
  for (const f of [...crlf, ...lf]) {
    const b = read(f);
    const lines = b.split("\n").length - 1;
    const crlfs = b.split("\r\n").length - 1;
    assert.equal(crlfs, crlf.includes(f) ? lines : 0, f);
    assert.ok(!CYRILLIC.test(b), `${f}: English only`);
  }
  assert.ok(existsSync("web/src/frame-guard.js"));
});

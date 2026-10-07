// Front-end foundation: router matching, config fallbacks, API client, shell status and
// the build-time facts (scripts/facts.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchPath, route, resolve } from "../web/src/router.js";
import * as config from "../web/src/config.js";
import * as params from "../src/params.mjs";
import { store, detectStoredWallet } from "../web/src/ui/status.js";
import { auditFacts, countTests, r1csConstraints, buildFacts } from "../scripts/facts.mjs";

test("router matches patterns, decodes params and falls back to *", () => {
  assert.deepEqual(matchPath("/", "/"), {});
  assert.deepEqual(matchPath("/t/:ticker", "/t/ABC"), { ticker: "ABC" });
  assert.deepEqual(matchPath("/t/:ticker", "/t/A%20B/"), { ticker: "A B" });
  assert.equal(matchPath("/t/:ticker", "/t"), null);
  assert.equal(matchPath("/t/:ticker", "/t/ABC/x"), null);
  assert.equal(matchPath("/tx/:txid", "/tx/%E0%A4%A"), null, "malformed escapes do not throw");
  assert.deepEqual(matchPath("/app/send", "/app/send?to=x#frag"), {});
  route("*", null, { name: "notfound" });
  route("/app", null, { name: "app-gate" });
  route("/app/send", null, { name: "app-send" });
  assert.equal(resolve("/app/send").route.meta.name, "app-send");
  assert.equal(resolve("/app").route.meta.name, "app-gate");
  assert.equal(resolve("/nope/at/all").route.meta.name, "notfound", "* matches last regardless of order");
});

test("config re-exports src/params.mjs", () => {
  assert.equal(config.BRAND, params.BRAND);
  assert.equal(config.PROTOCOL, params.PROTOCOL);
  assert.equal(config.NETWORK, params.NETWORK);
  assert.equal(config.ADDRESS_HRP, params.ADDRESS_HRP);
  assert.equal(config.STORAGE_PREFIX, params.STORAGE_PREFIX);
  assert.equal(config.MAGIC, "mrk", "MAGIC is text for display");
  assert.equal(config.label("spend"), "murkle/spend");
  assert.equal(config.PRE_GENESIS, params.PRE_GENESIS);
  assert.equal(config.ARTIFACT_SHA256.vkey, params.ARTIFACT_SHA256.vkey);
  assert.equal(config.ESPLORA_API, "https://mempool.space/signet/api");
});

test("API client maps server errors to ApiError and builds query strings", async () => {
  const realFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push([url, init?.method ?? "GET", init?.body ?? null]);
    if (url.startsWith("/api/relay/submit")) {
      return new Response(JSON.stringify({ error: { code: "pow_insufficient", message: "Not enough proof of work.", bits: 20 } }), { status: 422 });
    }
    if (url.startsWith("/api/assets/")) return new Response("nope", { status: 404 });
    if (url.startsWith("/artifacts/")) return new Response(new Uint8Array([1, 2, 3]));
    return new Response(JSON.stringify({ ok: true, url }), { status: 200 });
  };
  try {
    const api = await import("../web/src/api.js");
    assert.deepEqual(await api.log({ from: 10, limit: 500 }), { ok: true, url: "/api/log?from=10&limit=500" });
    await api.outputs({ from: 0 });
    assert.equal(seen.at(-1)[0], "/api/outputs?from=0");
    await api.digest(263104);
    assert.equal(seen.at(-1)[0], "/api/digest?height=263104");
    const s1 = await api.state();
    const s2 = await api.state();
    assert.equal(s1, s2, "state is cached briefly");
    assert.equal(seen.filter(([u]) => u === "/api/state").length, 1);
    await assert.rejects(api.relay.submit({ envelope: "00" }), (e) => e instanceof api.ApiError && e.status === 422 && e.code === "pow_insufficient" && e.bits === 20);
    assert.equal(seen.at(-1)[1], "POST");
    await assert.rejects(api.asset("abc"), (e) => e.status === 404 && /Not found on the indexer/.test(e.message));
    assert.equal(seen.at(-1)[0], "/api/assets/ABC");
    assert.deepEqual(await api.artifact("transaction.zkey"), new Uint8Array([1, 2, 3]));
    assert.throws(() => api.artifact("../etc/passwd"), /Unknown artifact/);
    assert.ok(api.esplora && typeof api.esplora.tx === "function");
    globalThis.fetch = async () => {
      throw new TypeError("network down");
    };
    await assert.rejects(api.nullifiers(), /Can't reach the indexer/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("shell status store notifies subscribers and detects stored wallets", () => {
  const s = store({ state: "none" });
  const seen = [];
  const off = s.subscribe((v) => seen.push(v.state));
  s.set({ state: "locked" });
  s.set((v) => ({ ...v, state: "unlocked" }));
  off();
  s.set({ state: "none" });
  assert.deepEqual(seen, ["locked", "unlocked"]);
  const saved = globalThis.localStorage;
  const data = new Map([["zkpool.signet.phrase", "x"]]);
  globalThis.localStorage = { getItem: (k) => (data.has(k) ? data.get(k) : null) };
  try {
    assert.equal(detectStoredWallet("murkle.signet", "zkpool.signet"), "locked");
    data.clear();
    assert.equal(detectStoredWallet("murkle.signet", "zkpool.signet"), "none");
  } finally {
    globalThis.localStorage = saved;
  }
});

test("facts: test count, audit table and r1cs header", () => {
  const dir = mkdtempSync(join(tmpdir(), "facts-"));
  mkdirSync(join(dir, "test"));
  writeFileSync(join(dir, "test", "a.test.mjs"), `test("x", () => /a/.test("a"));\ntest ("y", () => {});\n// re.test(z)\n`);
  writeFileSync(join(dir, "test", "helper.mjs"), `test("not counted")`);
  assert.equal(countTests(join(dir, "test")), 2);
  assert.equal(countTests(join(dir, "missing")), null);

  const md = [
    "## Findings",
    "| ID | Severity | Location | Description | Status |",
    "|---|---|---|---|---|",
    "| A-1 | Info (critical had the protections been absent) | envelope | **Public input aliasing.** Details | regression test |",
    "| A-3 | **Medium** | block parser | **Merkle root was not verified**: more | fixed + test |",
    "| A-7 | Low | design | Note encryption is not proven. More text | documented |",
    "| V2-02 | Low | indexer | **Ticker BOM** | open (owner decision): consensus change |",
    "| V2-01 | Low | supply | **Old vite** | partially fixed: lockfile only |",
    "| V2-15 | **Medium** | relayer | **Unknown txid** | fixed + test |",
    "## circomspect: 25 findings, no real issues",
  ].join("\n");
  const a = auditFacts(md);
  assert.equal(a.total, 6);
  assert.deepEqual(a.bySeverity, { Info: 1, Medium: 2, Low: 3 });
  assert.equal(a.fixed, 2);
  assert.equal(a.partial, 1);
  assert.equal(a.open, 1);
  assert.equal(a.mediumFixed, 2);
  assert.equal(a.circomspectFindings, 25);
  assert.deepEqual(a.findings.map((f) => [f.id, f.title, f.state]), [
    ["A-1", "Public input aliasing", "tested"],
    ["A-3", "Merkle root was not verified", "fixed"],
    ["A-7", "Note encryption is not proven", "documented"],
    ["V2-02", "Ticker BOM", "open"],
    ["V2-01", "Old vite", "partial"],
    ["V2-15", "Unknown txid", "fixed"],
  ]);

  // Minimal r1cs: magic, version 1, one header section with nConstraints = 18411.
  const prime = Buffer.alloc(32, 0xff);
  const header = Buffer.concat([u32(32), prime, u32(10), u32(1), u32(2), u32(3), u64(99), u32(18411)]);
  const file = Buffer.concat([Buffer.from("r1cs", "latin1"), u32(1), u32(1), u32(1), u64(header.length), header]);
  writeFileSync(join(dir, "x.r1cs"), file);
  assert.equal(r1csConstraints(join(dir, "x.r1cs")), 18411);
  assert.equal(r1csConstraints(join(dir, "none.r1cs")), null);

  const empty = buildFacts(dir);
  assert.equal(empty.testCount, 2);
  assert.equal(empty.circuit.constraints, null);
  assert.equal(empty.artifacts.vkey.sha256, null);
  assert.equal(empty.genesis.txid, null);
  assert.equal(empty.audit, null);
});

test("committed web/src/facts.json has the expected shape", () => {
  const f = JSON.parse(readFileSync(new URL("../web/src/facts.json", import.meta.url), "utf8"));
  assert.equal(f.schema, 1);
  for (const k of ["testCount", "circuit", "manifest", "artifacts", "genesis", "audit"]) assert.ok(k in f, k);
  for (const k of ["vkey", "zkey", "wasm"]) assert.ok("sha256" in f.artifacts[k] && "bytes" in f.artifacts[k]);
});

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
}
function u64(v) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}

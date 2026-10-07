// Audit round 2, docs area: the normative and operator docs must describe what the
// code actually does.
//  V2-05  SPEC §6 must not claim a pool[asset] withdrawal check the indexer lacks,
//         nor that a circuit bug cannot inflate supply.
//  V2-14 / V2-45  docs/API.md lists every field of /api/stats.
//  V2-43  README describes MURKLE_ALLOW_UNPINNED as the manifest.json bypass it is;
//         the verification key pin can never be bypassed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const read = (p) => readFileSync(p, "utf8");

/** The text of SPEC §6 (from its heading to the next section heading). */
function specSection6() {
  const spec = read("SPEC.md");
  const start = spec.indexOf("## 6. Indexer rules");
  assert.ok(start >= 0, "SPEC.md has a section 6");
  const end = spec.indexOf("\n## 7.", start);
  assert.ok(end > start, "SPEC.md has a section 7 after section 6");
  return spec.slice(start, end);
}

test("V2-05: SPEC §6 does not claim a withdrawal bound or a circuit-proof cap that the indexer lacks", () => {
  const s6 = specSection6();
  assert.doesNotMatch(s6, /rejects any withdrawal larger than/, "the old claim of an existing withdrawal check is gone");
  assert.doesNotMatch(s6, /still cannot exceed the cap/, "the old claim that a circuit bug cannot inflate supply is gone");
  assert.match(s6, /Until then this bound does not exist\./);
  assert.match(s6, /a withdrawal larger than\s+`pool\[asset\]` is rejected/, "the rule is stated as future work tied to withdrawals");
  assert.match(s6, /could create notes worth more\s+than was minted/, "private inflation by a circuit or setup break is disclosed");
  assert.match(s6, /cannot detect such\s+inflation/);
  assert.match(s6, /A-8/, "the single-party setup limitation is cross-referenced");
});

test("V2-05: SPEC §6 and the indexer agree on whether a pool bound exists", () => {
  const src = read("src/indexer.mjs");
  // Today every TRANSACT with public value is rejected, which is why no pool comparison exists.
  assert.match(src, /MVP: private pool only, value can neither enter nor leave via TRANSACT\./);
  // Nothing in the indexer compares a value against asset.pool yet. If someone adds that
  // check (withdrawals enabled), SPEC §6 must be updated to describe it as a live rule.
  const poolComparisons = src.match(/[<>]=?\s*[\w.]*\.pool\b|\.pool\s*[<>]=?/g) ?? [];
  const s6 = specSection6();
  if (poolComparisons.length === 0) {
    assert.match(s6, /no rule compares anything against it yet/);
  } else {
    assert.doesNotMatch(s6, /Until then this bound does not exist\./, "SPEC §6 still says the pool bound does not exist, but the indexer now checks it");
  }
});

/** The keys of the stats object built by the server's publish(). */
function serverStatsKeys() {
  const src = read("server/indexer-server.mjs");
  const start = src.indexOf("stats: {");
  assert.ok(start >= 0, "the server builds a stats view");
  const end = src.indexOf("\n      },", start);
  assert.ok(end > start);
  return [...src.slice(start + "stats: {".length, end).matchAll(/^\s*(\w+)\s*[:,]/gm)].map((m) => m[1]);
}

test("V2-14 / V2-45: docs/API.md lists every field the server returns from /api/stats", () => {
  const keys = serverStatsKeys();
  for (const k of ["deploys", "attests", "height", "series"]) assert.ok(keys.includes(k), `server stats has ${k}`);
  const row = read("docs/API.md").split("\n").find((l) => l.startsWith("| `/api/stats` |"));
  assert.ok(row, "docs/API.md has an /api/stats row");
  const shape = row.slice(row.indexOf("`{"), row.indexOf("}`") + 2);
  // Top-level field names of the documented shape (nested series tuple removed).
  const documented = shape.replace(/\[\[.*?\]\]/g, "").replace(/[`{}]/g, "").split(",").map((f) => f.split(":")[0].trim()).filter(Boolean);
  assert.deepEqual([...documented].sort(), [...keys].sort(), "documented /api/stats fields equal the server's fields");
});

test("V2-43: README describes MURKLE_ALLOW_UNPINNED as the manifest bypass, never a vkey bypass", () => {
  const row = read("README.md").split("\n").find((l) => l.startsWith("| `MURKLE_ALLOW_UNPINNED` |"));
  assert.ok(row, "README documents MURKLE_ALLOW_UNPINNED");
  assert.doesNotMatch(row, /start even if the verification key does not match the pin/);
  assert.match(row, /build\/manifest\.json/);
  assert.match(row, /manifestSha256/);
  assert.match(row, /never relaxes the verification key check/);

  // The code matches the doc: the variable is read once, next to the manifest refusal.
  const server = read("server/indexer-server.mjs");
  const uses = server.match(/env\("ALLOW_UNPINNED"\)/g) ?? [];
  assert.equal(uses.length, 1);
  const line = server.split("\n").find((l) => l.includes('env("ALLOW_UNPINNED")'));
  assert.match(line, /manifest\.json/);
  assert.doesNotMatch(read("src/store-node.mjs"), /ALLOW_UNPINNED/, "the vkey loader reads no bypass variable");
});

test("V2-43: MURKLE_ALLOW_UNPINNED=1 does not let a mismatched verification key load", async () => {
  const { loadPinnedVkey } = await import("../src/store-node.mjs");
  const { ARTIFACT_SHA256 } = await import("../src/params.mjs");
  assert.ok(ARTIFACT_SHA256.vkey, "a verification key is pinned");
  const dir = mkdtempSync(join(tmpdir(), "murkle-audit2-docs-"));
  const prev = process.env.MURKLE_ALLOW_UNPINNED;
  try {
    process.env.MURKLE_ALLOW_UNPINNED = "1";
    const fake = join(dir, "verification_key.json");
    writeFileSync(fake, JSON.stringify({ protocol: "groth16", curve: "bn128", nPublic: 0 }));
    assert.throws(() => loadPinnedVkey(fake), /does not match the pinned hash/);
  } finally {
    if (prev === undefined) delete process.env.MURKLE_ALLOW_UNPINNED;
    else process.env.MURKLE_ALLOW_UNPINNED = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

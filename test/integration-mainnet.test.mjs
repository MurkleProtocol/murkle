// Mainnet readiness, integration step (docs/design/mainnet-readiness.md §11 and §12 "As built"):
// the wiring between the four tracks that no single track's tests cover.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildFacts, factsFile } from "../scripts/facts.mjs";
import { privateValues } from "../scripts/prepublish-check.mjs";
import { MINE_FEES } from "../src/params.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");

function run(args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout, stderr });
    });
  });
}

test("the public verifier pages pass the A-9 header check and the network to the engine, like receipts", () => {
  const src = read("web/src/share/live-check.js");
  assert.match(src, /import \{ headerCheck \} from "\.\.\/verify\/engine\.js";/);
  const call = src.slice(src.indexOf("return verifyTx(txid, {"), src.indexOf("}).catch("));
  assert.match(call, /\n\s+headerCheck,\r?\n/);
  assert.match(call, /\n\s+network: NETWORK,\r?\n/);
});

test("facts per network: signet keeps web/src/facts.json and its shape; mainnet reads its own pins and writes its own file", () => {
  assert.equal(factsFile("/r", "signet"), join("/r", "web", "src", "facts.json"));
  assert.equal(factsFile("/r", "mainnet"), join("/r", "web", "src", "facts.mainnet.json"));

  const signet = buildFacts(ROOT, { network: "signet" });
  assert.equal("network" in signet, false, "signet facts keep their historical keys");
  const pins = JSON.parse(read("src/pins.json"));
  assert.equal(signet.genesis.txid, pins.genesisTxid);
  assert.equal(signet.artifacts.vkey.pinned, pins.artifacts.vkey);

  const mainnet = buildFacts(ROOT, { network: "mainnet" });
  const mpins = JSON.parse(read("src/pins.mainnet.json"));
  assert.equal(mainnet.network, "mainnet");
  assert.equal(mainnet.genesis.txid, mpins.genesisTxid ?? null);
  assert.equal(mainnet.manifest.sha256, mpins.manifestSha256 ?? null);
  assert.equal(mainnet.artifacts.vkey.pinned, mpins.artifacts?.vkey ?? null);

  // A ceremony manifest installed under build/mainnet gives /security its ceremony block.
  const dir = mkdtempSync(join(tmpdir(), "murkle-facts-"));
  try {
    mkdirSync(join(dir, "build", "mainnet"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "pins.mainnet.json"), JSON.stringify({ genesisTxid: null, activationHeight: null, manifestSha256: "ab".repeat(32), artifacts: {} }));
    writeFileSync(join(dir, "build", "mainnet", "manifest.json"), JSON.stringify({
      constraints: 18411, ceremony: { id: "murkle-mainnet-1", contributions: 7, transcriptSha256: "cd".repeat(32), beacon: { network: "mainnet", height: 950000, blockHash: "00".repeat(32), iterationsExp: 10 } },
    }));
    const f = buildFacts(dir, { network: "mainnet" });
    assert.deepEqual(f.manifest.ceremony, { id: "murkle-mainnet-1", contributions: 7, beacon: { height: 950000 } });
    assert.equal(f.manifest.sha256, "ab".repeat(32));
    assert.equal(f.circuit.constraints, 18411);
    assert.equal("ceremony" in buildFacts(dir, { network: "signet" }).manifest, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mainnet web build resolves facts.json to facts.mainnet.json; a signet build leaves it alone", async () => {
  const probe = `
    const cfg = (await import(${JSON.stringify(new URL("../web/vite.config.mjs", import.meta.url).href)})).default;
    const p = cfg.plugins.find((x) => x && x.name === "murkle-network-facts");
    let out;
    try { out = p.resolveId("../facts.json"); } catch (e) { out = "error: " + e.message; }
    console.log(JSON.stringify({ out, other: p.resolveId("./config.js") }));`;
  const signet = await run(["--input-type=module", "-e", probe], { MURKLE_NETWORK: "signet" });
  assert.equal(signet.code, 0, signet.stderr);
  assert.deepEqual(JSON.parse(signet.stdout), { out: null, other: null });
  const mainnet = await run(["--input-type=module", "-e", probe], { MURKLE_NETWORK: "mainnet" });
  assert.equal(mainnet.code, 0, mainnet.stderr);
  const m = JSON.parse(mainnet.stdout);
  assert.equal(m.other, null);
  if (existsSync(join(ROOT, "web", "src", "facts.mainnet.json"))) assert.match(m.out, /facts\.mainnet\.json$/);
  else assert.match(m.out, /^error: web\/src\/facts\.mainnet\.json is missing/);
});

test("prepublish: the pinned platform fee script is a public constant, other relayer identifiers stay private", () => {
  const script = MINE_FEES.signet.platformScript;
  const other = "ef".repeat(32);
  const dir = mkdtempSync(join(tmpdir(), "murkle-prepub-"));
  try {
    mkdirSync(join(dir, "data", "signet"), { recursive: true });
    writeFileSync(join(dir, "data", "signet", "relayer.json"), JSON.stringify({ serviceOutputs: [{ script, sats: 500 }], items: { [other]: { status: "queued" } } }));
    const values = privateValues(dir).values.map((v) => v.value);
    assert.ok(!values.some((v) => script.includes(v)), "the platform script is not an identifier");
    assert.ok(values.includes(other), "a relayer identifier is still private");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("artifacts:check follows MURKLE_NETWORK and names what mainnet has not pinned yet", async () => {
  const signet = await run(["scripts/fetch-artifacts.mjs", "--check", "--dest", join(tmpdir(), "murkle-no-artifacts-here")], { MURKLE_NETWORK: "signet" });
  assert.equal(signet.code, 1);
  assert.match(signet.stderr, /MISSING {2}build\/manifest\.json/);
  const mpins = JSON.parse(read("src/pins.mainnet.json"));
  if (mpins.artifacts?.zkey) return; // after the ceremony installs the keys this case no longer exists
  const mainnet = await run(["scripts/fetch-artifacts.mjs", "--check"], { MURKLE_NETWORK: "mainnet" });
  assert.equal(mainnet.code, 1);
  assert.match(mainnet.stderr, /UNPINNED build\/mainnet\/transaction\.zkey: src\/pins\.mainnet\.json pins no hash for it yet/);
  assert.match(mainnet.stderr, /the public ceremony installs them/);
});

test("copy-notices writes into a temp build directory with --dist", async () => {
  const dir = mkdtempSync(join(tmpdir(), "murkle-dist-"));
  try {
    const r = await run(["scripts/copy-notices.mjs", "--dist", dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(join(dir, "THIRD_PARTY_NOTICES.txt")));
    const missing = await run(["scripts/copy-notices.mjs", "--dist", join(dir, "nope")]);
    assert.equal(missing.code, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replay-compare and the as-built notes are wired: npm scripts, the exit after the replay, the design note", () => {
  const pkg = JSON.parse(read("package.json"));
  for (const k of ["ceremony", "ceremony:init", "ceremony:admin", "ceremony:contribute", "ceremony:finalize", "ceremony:verify", "headers:checkpoint", "replay:compare", "monitor", "backup"]) assert.ok(pkg.scripts[k], k);
  assert.match(read("scripts/replay-compare.mjs"), /process\.exit\(process\.exitCode \?\? 0\)/);
  const design = read("docs/design/mainnet-readiness.md");
  assert.match(design, /## 12\. As built/);
  for (const s of ["pass", "/ceremony/api/transcript.json", "facts.mainnet.json", "MURKLE_HEADERS=off"]) assert.ok(design.includes(s), s);
  for (const p of [".gitignore", ".dockerignore"]) {
    const t = read(p);
    for (const pat of ["deploy/**/*.env", "deploy/docker/compose.env", "*.mbk", "*.key.pub"]) assert.ok(t.includes(pat), `${p}: ${pat}`);
  }
});

// Publication tooling: the artifact fetcher (scripts/fetch-artifacts.mjs), the shared artifact
// list (scripts/artifacts-lib.mjs) and the pre-publication check (scripts/prepublish-check.mjs).
// Temporary directories and in-memory sources only: no network, nothing under build/ or data/.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { createBase58check } from "@scure/base";
import { sha256 } from "@noble/hashes/sha256";
import { schnorr } from "@noble/curves/secp256k1";
import { ARTIFACTS } from "../server/indexer-server.mjs";
import { ARTIFACT_FILES, runCommands } from "../web/src/ui/indexer.js";
import { ARTIFACT_SHA256, MANIFEST_SHA256 } from "../src/params.mjs";
import { DEFAULT_TAG, PINNED_ARTIFACTS, ROOT, sha256sums } from "../scripts/artifacts-lib.mjs";
import { fetchArtifacts, locate, parseArgs, resolveSource, UsageError } from "../scripts/fetch-artifacts.mjs";
import { check, findMnemonics, gitignoreMatcher, scanBinary, scanText } from "../scripts/prepublish-check.mjs";

const DIR = mkdtempSync(join(tmpdir(), "murkle-publish-tools-"));
after(() => rmSync(DIR, { recursive: true, force: true }));
const hash = (b) => createHash("sha256").update(b).digest("hex");

test("the artifact list matches what the server loads, the /verify steps name, and the pins", () => {
  const served = Object.fromEntries(Object.entries(ARTIFACTS).map(([k, v]) => [k, relative(ROOT, v).replace(/\\/g, "/")]));
  assert.deepEqual(Object.fromEntries(PINNED_ARTIFACTS.map((a) => [a.name, a.path])), served);
  assert.deepEqual(Object.fromEntries(ARTIFACT_FILES), served);
  const pin = { "manifest.json": MANIFEST_SHA256, "verification_key.json": ARTIFACT_SHA256.vkey, "transaction.wasm": ARTIFACT_SHA256.wasm, "transaction.zkey": ARTIFACT_SHA256.zkey };
  for (const a of PINNED_ARTIFACTS) assert.equal(a.sha256, pin[a.name], a.name);
  assert.equal(DEFAULT_TAG, `artifacts-${MANIFEST_SHA256.slice(0, 12)}`);
  const sums = sha256sums().trim().split("\n");
  assert.equal(sums.length, 4);
  for (const line of sums) assert.match(line, /^[0-9a-f]{64} {2}[a-z_.]+$/);
});

test("fetch-artifacts: source precedence, URL templates and arguments", () => {
  assert.equal(resolveSource({ from: "https://a.example/artifacts", env: { MURKLE_ARTIFACTS_URL: "https://b.example" } }), "https://a.example/artifacts");
  assert.equal(resolveSource({ env: { MURKLE_ARTIFACTS_URL: "https://b.example" }, repoUrl: "https://github.com/o/r" }), "https://b.example");
  assert.equal(resolveSource({ env: {}, repoUrl: "https://github.com/o/r/", tag: "artifacts-x" }), "https://github.com/o/r/releases/download/artifacts-x");
  assert.equal(resolveSource({ env: {}, repoUrl: "https://git.example/o/r", tag: "t" }), null, "only GitHub release URLs are derived");
  assert.equal(resolveSource({ env: {}, repoUrl: null }), null);
  assert.equal(locate("https://s.example/artifacts/", "manifest.json"), "https://s.example/artifacts/manifest.json");
  assert.equal(locate("https://h.example/{tag}/{name}", "transaction.zkey", "t1"), "https://h.example/t1/transaction.zkey");
  assert.equal(locate(DIR, "manifest.json"), join(DIR, "manifest.json"));
  assert.deepEqual(parseArgs(["--from", "x", "--force", "--check", "--quiet"]).from, "x");
  assert.throws(() => parseArgs(["--from"]), UsageError);
  assert.throws(() => parseArgs(["--nope"]), UsageError);
});

test("fetch-artifacts: writes only after every file matches its pin, and refuses any mismatch", async () => {
  const files = { "a.json": Buffer.from('{"a":1}\n'), "b.bin": Buffer.from([1, 2, 3, 4]) };
  const artifacts = [
    { name: "a.json", path: "build/a.json", sha256: hash(files["a.json"]) },
    { name: "b.bin", path: "build/dev/b.bin", sha256: hash(files["b.bin"]) },
  ];
  const served = new Map(Object.entries(files).map(([n, b]) => [`https://src.example/${n}`, b]));
  const read = async (where) => {
    if (!served.has(where)) throw new Error("HTTP 404");
    return served.get(where);
  };

  const bad = join(DIR, "bad");
  served.set("https://src.example/b.bin", Buffer.from([9, 9]));
  const refused = await fetchArtifacts({ source: "https://src.example", dest: bad, artifacts, read });
  assert.equal(refused.ok, false);
  assert.match(refused.problems.join("\n"), /b\.bin: sha256 [0-9a-f]{64} does not match the pin/);
  assert.ok(!existsSync(join(bad, "build/a.json")), "a good file is not written while another one differs");

  served.set("https://src.example/b.bin", files["b.bin"]);
  const good = join(DIR, "good");
  const ok = await fetchArtifacts({ source: "https://src.example", dest: good, artifacts, read });
  assert.deepEqual([ok.ok, ok.written], [true, ["a.json", "b.bin"]]);
  assert.deepEqual(readFileSync(join(good, "build/dev/b.bin")), files["b.bin"]);
  assert.ok(!existsSync(join(good, "build/dev/b.bin.part")));
  const again = await fetchArtifacts({ source: "https://src.example", dest: good, artifacts, read: async () => assert.fail("no download when the file already matches") });
  assert.deepEqual([again.ok, again.kept], [true, ["a.json", "b.bin"]]);

  const missing = await fetchArtifacts({ source: "https://src.example", dest: join(DIR, "none"), artifacts: [{ name: "c", path: "c", sha256: null }], read });
  assert.equal(missing.ok, false, "no pin, nothing to verify against");
});

test("the /verify steps fetch and check the artifacts from a clone, and keep plain downloads without one", () => {
  const clone = runCommands({ repoUrl: "https://git.example/o/murkle", origin: "https://site.example" }).split("\n");
  assert.deepEqual(clone, [
    "git clone https://git.example/o/murkle murkle && cd murkle",
    "npm ci",
    "npm run artifacts:fetch -- --from https://site.example/artifacts",
    "npm run web:build",
    "npm run indexer",
  ]);
  const plain = runCommands({ origin: "https://site.example" });
  assert.ok(!plain.includes("artifacts:fetch") && plain.includes("curl -fo build/dev/transaction.zkey https://site.example/artifacts/transaction.zkey"));
  const landing = readFileSync(new URL("../web/src/views/landing.js", import.meta.url), "utf8");
  assert.match(landing, /<pre>npm ci\r?\nnpm run artifacts:fetch -- --from \$\{[^}]+\}\/artifacts\r?\nnpm run web:build\r?\nnpm run indexer<\/pre>/);
});

test("prepublish-check: the .gitignore keeps private and generated files out", () => {
  const ignored = gitignoreMatcher(readFileSync(new URL("../.gitignore", import.meta.url), "utf8"));
  for (const [p, dir] of [["data", true], ["build", true], ["node_modules", true], ["web/dist", true], ["docs/internal", true], ["x/wallets", true], ["deep/relay-balance", true]]) assert.ok(ignored(p, dir), p);
  for (const p of ["pool.key", "a/b/relayer.key", ".env", ".env.local", "srv/relayer.json", "out.log", ".fixtures-tmp.mjs", "x-tmp.json", "k.pem", ".prepublish-deny"]) assert.ok(ignored(p, false), p);
  for (const p of ["README.md", "src/params.mjs", "test/fixtures/signet-324500.json", "docs/design/relay-balance.md", "web/src/views/app-send.js", ".gitattributes"]) assert.ok(!ignored(p, false), p);
  assert.ok(!ignored("docs/design", true) && !ignored("web/src", true));
});

test("prepublish-check: each detector fires on its case and stays quiet on public test vectors", () => {
  const kinds = (text, opts) => scanText(text, opts).map((f) => f.kind);
  const wif = createBase58check(sha256).encode(Uint8Array.from([0xef, ...new Uint8Array(32).fill(7), 1]));
  assert.ok(kinds(`key = "${wif}"`).some((k) => /WIF/.test(k)));
  assert.ok(kinds("-----BEGIN EC " + "PRIVATE KEY-----").some((k) => /PEM/.test(k)));
  const valid = "abandon ".repeat(11) + "about";
  assert.equal(findMnemonics(`const p = "${valid}";`).length, 1, "a valid phrase is found");
  const firstWords = "abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid acoustic acquire across act action actor actress actual";
  assert.equal(findMnemonics(firstWords).length, 0, "the public dummy of test/keystore.test.mjs has no valid checksum");
  assert.ok(kinds("see " + "C:" + "\\Users\\someone\\x.txt").some((k) => /Windows path/.test(k)));
  assert.ok(kinds("at " + "/home/" + "alice/project/x").some((k) => /home directory/.test(k)));
  assert.ok(kinds("mail me: a.person" + "@" + "gmail.com").includes("email address"));
  assert.ok(!kinds("security" + "@" + "murkle.example and git" + "@" + "github.com").includes("email address"));
  assert.ok(kinds("caf\u0435").includes("Cyrillic text"));
  assert.deepEqual(kinds("https://mempool.space/signet/api and node --test \"test/*.test.mjs\""), []);
  const key = "07".repeat(32);
  const addr = btc.p2tr(schnorr.getPublicKey(Buffer.from(key, "hex")), undefined, btc.TEST_NETWORK).address;
  const privates = { values: [{ value: key, kind: "k" }, { value: addr, kind: "a" }], deny: [{ prefix: "tb1pdeny", suffix: "zz9", line: 3 }] };
  assert.equal(scanText(`x ${key.toUpperCase()} y`, { privates }).length, 1, "secret values match case-insensitively");
  assert.equal(scanText(`to ${addr}`, { privates }).length, 1);
  assert.equal(scanText("pay tb1pdenyqqqqqqqqzz9 now", { privates })[0].kind, "deny-listed value (.prepublish-deny line 3)");
  for (const f of scanText(`x ${key}`, { privates })) assert.ok(!JSON.stringify(f).includes(key), "a finding never carries the value");
});

test("prepublish-check: unknown keys next to a secret name, shell-form paths, fragments and binaries", () => {
  const kinds = (text, opts) => scanText(text, opts).map((f) => f.kind);
  const named = (text) => kinds(text).some((k) => /next to a secret name/.test(k));
  const h = createHash("sha256").update("prepublish planted key").digest("hex");
  for (const text of [`export const priv = "${h}";`, `{ "privateKey": "${h}" }`, `Recovery seed: ${h}`, `const btcKey = Buffer.from("${h}", "hex");`, `const secretKey =\n  "${h}";`, `PRIVATE_KEY=0x${h}`]) assert.ok(named(text), text.slice(0, 20));
  for (const text of [`txid ${h}`, `privacy-scaling sha256 ${h}`, `skip ${h}`, `const seed = "${h}"; // prepublish-` + `ok: public vector`, `secret = "${"07".repeat(32)}"`]) assert.ok(!named(text), text.slice(0, 20));
  const paths = (text) => kinds(text).filter((k) => /path/.test(k)).length;
  for (const text of ["cd /e/" + "SOFT/zkpool/data", "D:" + "\\zkpool", "see /home/" + "alice", "/cygdrive/c/" + "Users/alice", "/c/" + "Users/alice"]) assert.ok(paths(text) > 0, text);
  assert.equal(paths(`matchPath("/t/:ticker", "/t/ABC/x")`), 0, "app routes are not drive paths");
  const fragments = new Map();
  for (let i = 0; i + 16 <= h.length; i++) fragments.set(h.slice(i, i + 16), "k");
  const privates = { values: [], secrets: [{ hex: h, kind: "k" }], fragments, deny: [{ prefix: "tb1pdeny", suffix: "zz9", line: 1 }] };
  assert.equal(scanText(`tail ${h.slice(-20)} end`, { privates }).length, 1, "a 20-digit fragment of a secret");
  assert.equal(scanText(`short ${h.slice(-15)} end`, { privates }).length, 0, "under 16 digits is noise");
  const raw = Buffer.concat([Buffer.from([0, 1]), Buffer.from(h, "hex").subarray(4, 24), Buffer.from([0])]);
  assert.equal(scanBinary(raw, { privates }).length, 1, "raw secret bytes in a binary file");
  assert.equal(scanBinary(Buffer.from("\0tEXt tb1pdenyqqqqzz9\0"), { privates }).length, 1, "deny list in a binary file");
  assert.deepEqual(scanBinary(Buffer.from([0, 1, 2, 3]), { privates }), []);
  const docker = readFileSync(join(ROOT, ".dockerignore"), "utf8").split("\n");
  for (const p of ["**/*.key", "**/*.pem", "**/.env", "**/.env.*", "**/wallets", "**/relay-balance", "**/relayer.json", "**/*.log", "data", "build"]) assert.ok(docker.includes(p), `.dockerignore: ${p}`);
});

test("prepublish-check: this checkout publishes nothing it must not", () => {
  const { files, errors } = check(ROOT);
  assert.deepEqual(errors, []);
  for (const p of files) assert.ok(!/^(data|build|node_modules|docs\/internal)\/|^web\/dist\//.test(p), p);
  for (const p of ["README.md", "SECURITY.md", "CONTRIBUTING.md", "THIRD_PARTY_NOTICES.md", ".gitattributes", "src/pins.json"]) assert.ok(files.includes(p), p);
});

test("new publication files are LF and English only", () => {
  const files = [".gitignore", ".gitattributes", ".dockerignore", ".nvmrc", "Dockerfile", "PUBLISHING.md", "SECURITY.md", "CONTRIBUTING.md", "LICENSE-CHOICE.md", "THIRD_PARTY_NOTICES.md", "docs/API.md", "docs/CLAIMS.md", "docs/design/README.md", ".github/workflows/test.yml", "scripts/artifacts-lib.mjs", "scripts/fetch-artifacts.mjs", "scripts/release-assets.mjs", "scripts/prepublish-check.mjs", "scripts/copy-notices.mjs", "test/publish-tools.test.mjs"];
  for (const f of files) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue; // LICENSE-CHOICE.md is deleted at publication
    const b = readFileSync(p, "utf8");
    assert.ok(!b.includes("\r"), `${f}: LF only`);
    assert.ok(!/[\u0400-\u04FF]/.test(b), `${f}: English only`);
  }
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.engines.node, ">=22");
  assert.ok(pkg.license, "package.json names a license (it must match LICENSE)");
  for (const s of ["artifacts:fetch", "artifacts:check", "release:assets", "prepublish:check"]) assert.ok(pkg.scripts[s], s);
});


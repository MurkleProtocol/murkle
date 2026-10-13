// The mainnet key tools (owner decision 2026-10-11: one party, no ceremony): scripts/mainnet-key.mjs builds
// the key, scripts/verify-key.mjs lets anyone check it.
//
// Offline and fast: a 5-constraint circuit (test/fixtures/key) and a tiny phase-1 file generated here.
// Nothing touches build/, src/pins*.json or the network. The temporary directories are left to the OS.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { blake2b } from "@noble/hashes/blake2b";
import * as snarkjs from "snarkjs";
import { MAINNET_CONTRIBUTION_NAME, MAINNET_PHASE2, MAINNET_SETUP, sha256, sha256File } from "../scripts/key-lib.mjs";
import { assertNoDebugger, assertOutputFree, buildMainnetKey, main as keyMain, readMainnetPins } from "../scripts/mainnet-key.mjs";
import { closeCurves, expectedContributionName, inspectZkey, parseArgs, parseContributions, verifyKey, zkeyContributionCount, zkeyContributionInfo } from "../scripts/verify-key.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const R1CS = join(ROOT, "test/fixtures/key/sanity_decoder.r1cs");
const WASM = join(ROOT, "test/fixtures/key/sanity_decoder.wasm");
const DIR = mkdtempSync(join(tmpdir(), "murkle-mainnet-key-"));

after(closeCurves);

/** floor(log2(n)) + 1 of the circuit's size, the smallest power snarkjs accepts (zkey_new.js). */
function smallestPower(r1csPath) {
  const b = readFileSync(r1csPath);
  let o = 12;
  for (let i = 0, n = b.readUInt32LE(8); i < n; i++) {
    const type = b.readUInt32LE(o);
    const size = Number(b.readBigUInt64LE(o + 4));
    if (type === 1) {
      const fieldSize = b.readUInt32LE(o + 12);
      const h = o + 12 + 4 + fieldSize;
      const nPubOut = b.readUInt32LE(h + 4);
      const nPubIn = b.readUInt32LE(h + 8);
      const nConstraints = b.readUInt32LE(h + 24);
      return Math.floor(Math.log2(nConstraints + nPubIn + nPubOut)) + 1;
    }
    o += 12 + size;
  }
  throw new Error("no r1cs header");
}

/** A tiny phase-1 file (new accumulator, one contribution, prepared for phase 2) and its pin. */
async function makePtau(name) {
  const curve = await snarkjs.curves.getCurveFromName("bn128");
  const p0 = join(DIR, `${name}_0.ptau`);
  const p1 = join(DIR, `${name}_1.ptau`);
  const path = join(DIR, `${name}.ptau`);
  await snarkjs.powersOfTau.newAccumulator(curve, smallestPower(R1CS), p0, null);
  await snarkjs.powersOfTau.contribute(p0, p1, `test ${name}`, `phase-1 entropy ${name} ${randomBytes(8).toString("hex")}`, null);
  await snarkjs.powersOfTau.preparePhase2(p1, path, null);
  const bytes = readFileSync(path);
  return { path, pin: { name: `${name}.ptau`, size: bytes.length, sha256: sha256(bytes), blake2b: Buffer.from(blake2b(bytes)).toString("hex") } };
}

const phase1 = await makePtau("a");
const phase1b = await makePtau("b");

/**
 * Runs buildMainnetKey in a child process with a known entropy and returns everything the child printed.
 * (A child, because hijacking this process's stdout would swallow the test runner's own reports.)
 */
function buildInChild(outDir, entropyHex) {
  const script = join(DIR, "child-build.mjs");
  writeFileSync(script, `
    import { buildMainnetKey } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/mainnet-key.mjs")).href)};
    import { closeCurves } from ${JSON.stringify(pathToFileURL(join(ROOT, "scripts/verify-key.mjs")).href)};
    const a = JSON.parse(process.argv[2]);
    const r = await buildMainnetKey({ ...a, log: (m) => console.log(m), testEntropy: a.entropy });
    console.log(JSON.stringify({ done: r.files }));
    console.error("stderr works");
    await closeCurves();
  `);
  const args = JSON.stringify({ r1cs: R1CS, ptau: phase1.path, wasm: WASM, outDir, ptauPin: phase1.pin, entropy: entropyHex });
  const r = spawnSync(process.execPath, [script, args], { cwd: ROOT, encoding: "buffer" });
  assert.equal(r.status, 0, r.stderr.toString());
  return { stdout: r.stdout, stderr: r.stderr, files: JSON.parse(r.stdout.toString().trim().split(/\r?\n/).at(-1)).done };
}

function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else out.push(p);
  }
  return out;
}

let n = 0;
const build = (over = {}) => {
  const outDir = over.outDir ?? join(DIR, `out${++n}`);
  return buildMainnetKey({
    r1cs: R1CS, ptau: phase1.path, wasm: WASM, outDir, ptauPin: phase1.pin,
    circuitSource: join(ROOT, "circuits/transaction.circom"), circom: "2.2.2", circomlib: "2.0.5",
    now: new Date("2026-10-11T12:00:00.000Z"), ...over,
  });
};
const pinsOf = (r) => ({ manifestSha256: r.manifestSha256, artifacts: { wasm: r.sha256.wasm, zkey: r.sha256.zkey, vkey: r.sha256.vkey } });
const verify = (r, over = {}) => verifyKey({
  r1cs: R1CS, ptau: phase1.path, zkey: r.files[0], vkey: r.files[1], manifest: r.files[2], wasm: WASM,
  pins: pinsOf(r), ptauPin: phase1.pin, ...over,
});

const first = await build();

test("the key tool makes a key that verifyFromR1cs accepts, with exactly one contribution", async () => {
  assert.equal(await snarkjs.zKey.verifyFromR1cs(R1CS, phase1.path, first.files[0], null), true);
  assert.equal(zkeyContributionCount(first.files[0]), 1);
  const info = await inspectZkey({ r1cs: R1CS, ptau: phase1.path, zkey: first.files[0] });
  assert.equal(info.valid, true);
  assert.deepEqual(info.contributions.map((c) => [c.index, c.name, c.hash]), [[1, MAINNET_CONTRIBUTION_NAME, first.contributionHash]]);
  assert.match(first.contributionHash, /^[0-9a-f]{128}$/);
});

test("the key works: a proof made with it verifies against the exported verification key", async () => {
  const vkey = JSON.parse(readFileSync(first.files[1], "utf8"));
  assert.equal(vkey.protocol, "groth16");
  assert.equal(sha256File(first.files[1]), first.sha256.vkey);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve({ inp: 1 }, WASM, first.files[0]);
  assert.deepEqual(publicSignals, ["0", "1", "0", "1"]); // Decoder(3): out = [0, 1, 0], success = 1
  assert.equal(await snarkjs.groth16.verify(vkey, publicSignals, proof), true);
  publicSignals[1] = "0";
  assert.equal(await snarkjs.groth16.verify(vkey, publicSignals, proof), false);
});

test("the manifest records the hashes, the provenance, the single party and the date", () => {
  const m = JSON.parse(readFileSync(first.files[2], "utf8"));
  assert.equal(sha256File(first.files[2]), first.manifestSha256);
  assert.deepEqual(m.sha256, {
    circuit: sha256File(join(ROOT, "circuits/transaction.circom")),
    r1cs: sha256File(R1CS), wasm: sha256File(WASM), zkey: sha256File(first.files[0]), vkey: sha256File(first.files[1]), ptau: phase1.pin.sha256,
  });
  assert.equal(m.phase1.file, phase1.pin.name);
  assert.equal(m.phase1.sha256, phase1.pin.sha256);
  assert.match(m.phase1.provenance, /54 contributions and a beacon/);
  assert.equal(m.phase2, MAINNET_PHASE2);
  assert.equal(m.phase2, "single-party (Murkle operator), 1 contribution");
  assert.deepEqual(m.contribution, { name: "Murkle mainnet key (single party)", hash: first.contributionHash });
  assert.equal(m.setup, MAINNET_SETUP);
  assert.equal(m.snarkjs, JSON.parse(readFileSync(join(ROOT, "node_modules/snarkjs/package.json"), "utf8")).version);
  assert.equal(m.date, "2026-10-11T12:00:00.000Z");
  assert.equal(m.constraints, 5);
  assert.equal(m.protocol, "murkle");
  // The intermediate 0000 key and the work folder are gone.
  assert.deepEqual(readdirSync(first.dir).sort(), ["manifest.json", "transaction.zkey", "verification_key.json"]);
});

test("the contribution entropy never reaches stdout, stderr or any written file", async () => {
  const entropy = randomBytes(64);
  const secret = entropy.toString("hex");
  const outDir = join(DIR, "entropy");
  const child = buildInChild(outDir, secret);
  assert.ok(child.stdout.length > 0 && child.stderr.length > 0, "the child's progress lines were captured");
  const needles = [["raw bytes", entropy], ["hex", Buffer.from(secret)], ["base64", Buffer.from(entropy.toString("base64"))], ["hex of the hex", Buffer.from(Buffer.from(secret).toString("hex"))]];
  const written = filesUnder(outDir).map((f) => [f, readFileSync(f)]);
  assert.equal(written.length, 3);
  for (const [what, bytes] of [["stdout", child.stdout], ["stderr", child.stderr], ...written]) {
    for (const [name, needle] of needles) assert.equal(bytes.includes(needle), false, `${name} found in ${what}`);
  }
  // Control: the scan does see the secret when something prints it.
  assert.ok(Buffer.from(`oops ${secret}`).includes(needles[1][1]));
  assert.equal(await snarkjs.zKey.verifyFromR1cs(R1CS, phase1.path, child.files[0], null), true);
});

test("the source keeps the entropy in one scope: one randomBytes(64), no child process, argv or env", () => {
  const src = readFileSync(join(ROOT, "scripts/mainnet-key.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.equal(src.match(/randomBytes\(/g).length, 1);
  assert.match(src, /randomBytes\(64\)/);
  assert.doesNotMatch(src, /\b(spawn|fork|execFile|execFileSync)\b/);
  assert.doesNotMatch(src, /process\.env(?!\.NODE_OPTIONS\b)/, "the only environment read is NODE_OPTIONS, for the debugger check");
  assert.deepEqual(src.match(/execSync\("[^"]*"/g), ['execSync("circom --version"', 'execSync("git rev-parse HEAD"'], "the only child processes are fixed strings: circom --version and git rev-parse");
});

test("two real runs make different keys (the secret is fresh every time)", async () => {
  const other = await build();
  assert.notEqual(other.contributionHash, first.contributionHash);
  assert.notEqual(other.sha256.zkey, first.sha256.zkey);
});

test("an existing key is refused without --force-new, and moved aside with it", async () => {
  const outDir = join(DIR, "existing");
  const made = await build({ outDir });
  const before = sha256File(made.files[0]);
  await assert.rejects(build({ outDir }), /already holds a key.*refusing to overwrite/);
  assert.throws(() => assertOutputFree(outDir), /already holds a key/);
  assert.equal(sha256File(made.files[0]), before, "the refused run left the key alone");
  // The command line refuses first, before it looks at anything else.
  await assert.rejects(keyMain(["--out", outDir]), /already holds a key/);
  assert.equal(sha256File(made.files[0]), before);

  const again = await build({ outDir, forceNew: true, pins: { genesisTxid: null } });
  assert.notEqual(sha256File(again.files[0]), before);
  const aside = readdirSync(outDir).filter((f) => f.startsWith("superseded-"));
  assert.equal(aside.length, 1);
  assert.equal(sha256File(join(outDir, aside[0], "transaction.zkey")), before, "the earlier key is kept, not deleted");
  assert.deepEqual(assertOutputFree(join(DIR, "never-made")), []);
});

test("every run is refused once the mainnet pins file has a genesis txid", async () => {
  const outDir = join(DIR, "after-genesis");
  const made = await build({ outDir });
  const before = sha256File(made.files[0]);
  const pinned = { genesisTxid: "ab".repeat(32) };
  const refused = /refused: .*already pins the genesis transaction/;
  assert.throws(() => assertOutputFree(outDir, true, pinned), refused);
  assert.throws(() => assertOutputFree(outDir, false, pinned), refused);
  assert.throws(() => assertOutputFree(join(DIR, "never-made"), true, pinned), refused, "refused even when no key is there");
  assert.throws(() => assertOutputFree(join(DIR, "never-made"), false, pinned), refused, "a clean machine or another --out too");
  await assert.rejects(build({ outDir, forceNew: true, pins: pinned }), refused);
  await assert.rejects(build({ outDir: join(DIR, "never-made"), pins: pinned }), refused);
  assert.equal(existsSync(join(DIR, "never-made")), false);
  assert.equal(sha256File(made.files[0]), before, "the key was not touched");
  assert.equal(readdirSync(outDir).filter((f) => f.startsWith("superseded-")).length, 0);
  // Before genesis --force-new moves the old key aside.
  assert.deepEqual(assertOutputFree(outDir, true, { genesisTxid: null }), ["transaction.zkey", "verification_key.json", "manifest.json"]);
  assert.equal(readMainnetPins().genesisTxid, null, "this checkout has not pinned a mainnet genesis yet");
});

test("the tool refuses to run under a debugger or heap snapshot option", () => {
  assert.doesNotThrow(() => assertNoDebugger([], "", undefined));
  assert.doesNotThrow(() => assertNoDebugger(["--max-old-space-size=4096"], "--no-warnings --max-old-space-size=4096", undefined));
  for (const flag of ["--inspect", "--inspect=127.0.0.1:9229", "--inspect-brk", "--inspect_brk=0", "--inspect-wait", "--heapsnapshot-signal=SIGUSR2", "--heapsnapshot-near-heap-limit=3", "--heap-prof"]) {
    assert.throws(() => assertNoDebugger([flag], "", undefined), /refusing to run with .*heap snapshot could read the secret/, `execArgv ${flag}`);
    assert.throws(() => assertNoDebugger([], `--no-warnings ${flag}`, undefined), /refusing to run/, `NODE_OPTIONS ${flag}`);
  }
  // A value in its own word counts the same; a bare value-taking option fails closed.
  assert.throws(() => assertNoDebugger(["--heapsnapshot-near-heap-limit", "3"], "", undefined), /--heapsnapshot-near-heap-limit/);
  assert.throws(() => assertNoDebugger([], "--heapsnapshot-signal SIGUSR2", undefined), /--heapsnapshot-signal/);
  assert.throws(() => assertNoDebugger(["--heapsnapshot-near-heap-limit"], "", undefined), /--heapsnapshot-near-heap-limit/);
  // The companions that switch nothing on, as Node 24's test runner passes them to every test file.
  const companions = ["--inspect-port=127.0.0.1:9229", "--inspect-publish-uid=stderr,http", "--heap-prof-interval=524288", "--heap-prof-dir=x", "--heapsnapshot-near-heap-limit=0"];
  assert.doesNotThrow(() => assertNoDebugger(companions, companions.join(" "), undefined));
  assert.doesNotThrow(() => assertNoDebugger(["--heapsnapshot-near-heap-limit", "0", "--inspect-port", "9229"], "", undefined));
  // Node strips double quotes inside NODE_OPTIONS words, so a quoted spelling is the same option.
  for (const quoted of ['--heap"-prof"', '"--heapsnapshot-near-heap-limit=3"', '--insp"ect"']) {
    assert.throws(() => assertNoDebugger([], quoted, undefined), /refusing to run with --/, `NODE_OPTIONS ${quoted}`);
  }
  assert.throws(() => assertNoDebugger([], "", "ws://127.0.0.1:9229/x"), /an open inspector/);
  // Wired into the command line, before it touches anything.
  const r = spawnSync(process.execPath, ["--inspect=0", join(ROOT, "scripts/mainnet-key.mjs"), "--out", join(DIR, "never-made-cli")], { cwd: ROOT, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /key:mainnet: refusing to run with --inspect/);
  assert.equal(existsSync(join(DIR, "never-made-cli")), false);
});

test("a missing input or a phase-1 file that is not the pinned one stops the run", async () => {
  await assert.rejects(build({ wasm: join(DIR, "nope.wasm") }), /wasm not found/);
  await assert.rejects(build({ ptauPin: phase1b.pin }), /hash mismatch/);
  assert.equal(existsSync(join(DIR, "never-made")), false);
});

test("key:verify passes on the tool's output", async () => {
  const r = await verify(first);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(r.contributions.map((c) => c.name), [MAINNET_CONTRIBUTION_NAME]);
  assert.equal(r.contributions[0].hash, first.contributionHash);
  assert.equal(r.sha256.zkey, first.sha256.zkey);
  assert.equal(r.sha256.vkey, first.sha256.vkey);
  assert.ok(r.notes.some((x) => /zkey: matches the pin/.test(x)));
  assert.ok(r.notes.some((x) => /manifest: matches the pin/.test(x)));
});

test("key:verify treats an unpinned hash as a note, and fails on it only with --require-pins", async () => {
  const none = { manifestSha256: null, artifacts: { zkey: null, vkey: null, wasm: null } };
  const r = await verify(first, { pins: none });
  assert.equal(r.ok, true);
  assert.ok(r.notes.some((x) => /zkey: not pinned yet/.test(x)));
  const strict = await verify(first, { pins: none, requirePins: true });
  assert.equal(strict.ok, false);
  assert.match(strict.problems.join("\n"), /no pin to compare with/);
});

test("key:verify fails on a key with two contributions", async () => {
  const two = join(DIR, "two.zkey");
  await snarkjs.zKey.contribute(first.files[0], two, "second party", `entropy ${randomBytes(8).toString("hex")}`, null);
  assert.equal(zkeyContributionCount(two), 2);
  const r = await verify(first, { zkey: two, pins: {} });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /carries 2 phase-2 contributions, expected exactly 1/);
  assert.equal(r.contributions.length, 2, "both are listed");
  const allowed = await verify(first, { zkey: two, pins: {}, expectContributions: 2, vkey: null, manifest: null });
  assert.equal(allowed.ok, true);
});

test("key:verify fails on a key built on another phase-1 file", async () => {
  const other = await build({ ptau: phase1b.path, ptauPin: phase1b.pin });
  const r = await verify(other, { pins: {} });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /does not derive from this r1cs and this phase-1 file/);
  // The same key checks out against the file it was made from.
  assert.equal((await verify(other, { pins: {}, ptau: phase1b.path, ptauPin: phase1b.pin })).ok, true);
});

test("key:verify fails when the phase-1 file is not the pinned one", async () => {
  const r = await verify(first, { ptau: phase1b.path });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /phase 1 file: .*hash mismatch/);
});

test("key:verify fails on a sha256 mismatch with the pins", async () => {
  const bad = (k, v) => ({ ...pinsOf(first), artifacts: { ...pinsOf(first).artifacts, ...(k === "manifestSha256" ? {} : { [k]: v }) }, ...(k === "manifestSha256" ? { manifestSha256: v } : {}) });
  for (const k of ["zkey", "vkey", "wasm", "manifestSha256"]) {
    const r = await verify(first, { pins: bad(k, "00".repeat(32)) });
    assert.equal(r.ok, false, k);
    assert.match(r.problems.join("\n"), /differs from the pinned 0{64}/, k);
  }
});

test("key:verify fails on a zkey or a vkey file that was swapped", async () => {
  const other = await build();
  const r1 = await verify(first, { vkey: other.files[1] });
  assert.equal(r1.ok, false);
  assert.match(r1.problems.join("\n"), /is not the verification key of this zkey/);
  const r2 = await verify(first, { zkey: other.files[0], pins: {} });
  assert.match(r2.problems.join("\n"), /manifest names another zkey/);
  const truncated = join(DIR, "truncated.zkey");
  writeFileSync(truncated, readFileSync(first.files[0]).subarray(0, 3000));
  const r3 = await verify(first, { zkey: truncated, pins: {} });
  assert.equal(r3.ok, false);
});

/** A key made from the circuit's initial zkey with the given contribution kind and name. */
async function makeKey(name, kind) {
  const zkey0 = join(DIR, `k0-${++n}.zkey`);
  const out = join(DIR, `k1-${n}.zkey`);
  await snarkjs.zKey.newZKey(R1CS, phase1.path, zkey0, null);
  if (kind === "beacon") await snarkjs.zKey.beacon(zkey0, out, name, "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20", 10, null);
  else await snarkjs.zKey.contribute(zkey0, out, name, `entropy ${randomBytes(8).toString("hex")}`, null);
  return out;
}

test("key:verify fails a key whose only contribution is a beacon, even under the mainnet name", async () => {
  const zkey = await makeKey(MAINNET_CONTRIBUTION_NAME, "beacon");
  assert.equal(await snarkjs.zKey.verifyFromR1cs(R1CS, phase1.path, zkey, null), true, "snarkjs itself accepts it");
  assert.equal(zkeyContributionCount(zkey), 1);
  assert.deepEqual(zkeyContributionInfo(zkey).map((c) => [c.index, c.type, c.name, c.beacon]), [[1, 1, MAINNET_CONTRIBUTION_NAME, true]]);
  const info = await inspectZkey({ r1cs: R1CS, ptau: phase1.path, zkey });
  assert.equal(info.valid, true);
  assert.deepEqual(info.beacons, [1]);
  for (const over of [{}, { expectName: MAINNET_CONTRIBUTION_NAME }]) {
    const r = await verifyKey({ r1cs: R1CS, ptau: phase1.path, zkey, pins: {}, ptauPin: phase1.pin, ...over });
    assert.equal(r.ok, false);
    assert.match(r.problems.join("\n"), /contribution #1 is a beacon \(public randomness/);
  }
  // A beacon on top of normal contributions fails too.
  const withBeacon = join(DIR, "with-beacon.zkey");
  await snarkjs.zKey.beacon(first.files[0], withBeacon, "b", "0a0b0c0d0e0f", 10, null);
  assert.deepEqual(zkeyContributionInfo(withBeacon).map((c) => c.beacon), [false, true]);
  const r2 = await verifyKey({ r1cs: R1CS, ptau: phase1.path, zkey: withBeacon, pins: {}, ptauPin: phase1.pin, expectContributions: 2 });
  assert.equal(r2.ok, false);
  assert.match(r2.problems.join("\n"), /contribution #2 is a beacon/);
});

test("key:verify on mainnet needs the exact contribution name the key tool writes", async () => {
  assert.equal(expectedContributionName("mainnet"), MAINNET_CONTRIBUTION_NAME);
  assert.equal(expectedContributionName("signet"), null);
  const zkey = await makeKey("someone else's key", "contribute");
  const wrong = await verifyKey({ r1cs: R1CS, ptau: phase1.path, zkey, pins: {}, ptauPin: phase1.pin, expectName: expectedContributionName("mainnet") });
  assert.equal(wrong.ok, false);
  assert.match(wrong.problems.join("\n"), /the contribution is named "someone else's key", expected "Murkle mainnet key \(single party\)"/);
  // The same key passes where no name is pinned (signet), and the tool's own output passes with the name.
  assert.equal((await verifyKey({ r1cs: R1CS, ptau: phase1.path, zkey, pins: {}, ptauPin: phase1.pin })).ok, true);
  assert.equal((await verify(first, { expectName: expectedContributionName("mainnet") })).ok, true);
  // Two contributions are refused under a name check even when told to allow two.
  const two = join(DIR, "two-named.zkey");
  await snarkjs.zKey.contribute(first.files[0], two, "second party", "entropy two", null);
  const r = await verify(first, { zkey: two, pins: {}, expectContributions: 2, vkey: null, manifest: null, expectName: MAINNET_CONTRIBUTION_NAME });
  assert.equal(r.ok, false);
  assert.match(r.problems.join("\n"), /expected exactly one contribution named/);
});

test("key:verify keeps the signet DEV key shape passing: one normal contribution with the DEV name", async () => {
  const zkey = await makeKey("murkle DEV phase 2, single party, not a ceremony", "contribute");
  assert.deepEqual(zkeyContributionInfo(zkey).map((c) => [c.type, c.name, c.beacon]), [[0, "murkle DEV phase 2, single party, not a ceremony", false]]);
  const r = await verifyKey({ r1cs: R1CS, ptau: phase1.path, zkey, pins: {}, ptauPin: phase1.pin, expectName: expectedContributionName("signet") });
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
  assert.deepEqual(zkeyContributionInfo(first.files[0]).map((c) => [c.type, c.name, c.beacon]), [[0, MAINNET_CONTRIBUTION_NAME, false]]);
});

test("key:verify parses snarkjs's contribution listing and its own arguments", () => {
  const hash = `\t\t${"0123abcd ".repeat(4).trim()}\n\t\t${"deadbeef ".repeat(4).trim()}\n\t\t${"00000000 ".repeat(4).trim()}\n\t\t${"ffffffff ".repeat(4).trim()}`;
  const got = parseContributions([`contribution #2 a: b 2:\n${hash}`, "-------------------------", `contribution #1 :\n${hash}`, "Beacon generator: ab"]);
  assert.deepEqual(got.map((c) => [c.index, c.name]), [[1, ""], [2, "a: b 2"]]);
  assert.equal(got[0].hash.length, 128);
  assert.deepEqual(parseArgs(["--network", "mainnet", "--require-pins"]), { network: "mainnet", "require-pins": true });
  assert.throws(() => parseArgs(["--bogus"]), /unknown argument/);
  assert.throws(() => parseArgs(["--zkey"]), /needs a value/);
});

test("the pins files and package.json wire the tools up; the signet DEV key is untouched", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["key:mainnet"], "node scripts/mainnet-key.mjs");
  assert.equal(pkg.scripts["key:verify"], "node scripts/verify-key.mjs");
  assert.equal(Object.keys(pkg.scripts).filter((k) => /ceremony/i.test(k)).length, 0);
  const signet = JSON.parse(readFileSync(join(ROOT, "src/pins.json"), "utf8"));
  assert.equal(signet.artifacts.zkey, "511df703529958a75ffb26b0e285aee902d8b4efe8d19617bf126372ba6915fa");
  assert.equal(signet.artifacts.vkey, "893e125967e305cedb1b2d6748ef906a2903779849ef51989ed74969d193a557");
  // The mainnet key was made and pinned on 2026-10-13: its own hashes, never the signet DEV key's.
  const mainnet = JSON.parse(readFileSync(join(ROOT, "src/pins.mainnet.json"), "utf8"));
  for (const v of [mainnet.artifacts.zkey, mainnet.artifacts.vkey, mainnet.manifestSha256]) assert.match(v, /^[0-9a-f]{64}$/);
  assert.notEqual(mainnet.artifacts.zkey, signet.artifacts.zkey);
  assert.notEqual(mainnet.artifacts.vkey, signet.artifacts.vkey);
  assert.equal(mainnet.artifacts.wasm, signet.artifacts.wasm, "the same circuit on both networks");
});

// The real signet DEV key against the real Hermez file: minutes of work, so opt in (MURKLE_KEY_REAL=1).
test("key:verify accepts the real signet DEV key", { skip: !process.env.MURKLE_KEY_REAL || !existsSync(join(ROOT, "build/dev/transaction.zkey")) }, async () => {
  const pins = JSON.parse(readFileSync(join(ROOT, "src/pins.json"), "utf8"));
  const r = await verifyKey({
    r1cs: join(ROOT, "build/transaction.r1cs"), ptau: join(ROOT, "build/ptau/powersOfTau28_hez_final_15.ptau"),
    zkey: join(ROOT, "build/dev/transaction.zkey"), vkey: join(ROOT, "build/dev/verification_key.json"),
    manifest: join(ROOT, "build/manifest.json"), wasm: join(ROOT, "build/transaction_js/transaction.wasm"), pins,
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.contributions.length, 1);
});

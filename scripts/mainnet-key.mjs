#!/usr/bin/env node
// Builds the mainnet proving key, once. Owner decision of 2026-10-11: the mainnet phase-2 key is made
// by one party, the Murkle operator, with no ceremony. This tool does exactly that and nothing else:
//
//   1. snarkjs zKey.newZKey from build/transaction.r1cs and the pinned Hermez phase-1 file
//      (size, sha256 and blake2b checked first);
//   2. ONE phase-2 contribution, named "Murkle mainnet key (single party)", made in this process
//      through the snarkjs JS API with entropy from crypto.randomBytes(64);
//   3. zKey.verifyFromR1cs on the result (the tool refuses to finish if it fails), the verification
//      key export, and build/mainnet/{transaction.zkey, verification_key.json, manifest.json}.
//
// The entropy is the secret that could forge proofs. It is created in one function scope, handed to
// snarkjs as a function argument and dropped; it is never printed, logged, written to a file, put into
// argv or env, or passed to a child process. JavaScript cannot wipe a string from memory, so run this on a
// clean machine, once, and close the process.
//
//   npm run key:mainnet                  (needs build/transaction.r1cs, build/transaction_js/transaction.wasm
//                                          and build/ptau/powersOfTau28_hez_final_15.ptau)
//   npm run key:mainnet -- --force-new   (moves an existing build/mainnet aside; only before genesis)
//
// Anyone can check the published key with `npm run key:verify -- --network mainnet`.
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { url as inspectorUrl } from "node:inspector";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { NETWORKS, VERSION, PROTOCOL } from "../src/params.mjs";
import {
  MAINNET_CONTRIBUTION_NAME, MAINNET_PHASE2, MAINNET_SETUP, PHASE1_PROVENANCE, PTAU,
  checkPtau, r1csConstraints, sha256, sha256File,
} from "./key-lib.mjs";
import { closeCurves, inspectZkey, vkeyBytes } from "./verify-key.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_FILES = ["transaction.zkey", "verification_key.json", "manifest.json"];

/**
 * The one contribution. `entropy` lives only in this function: a fresh 64 random bytes, in hex, given to
 * snarkjs (which mixes in 64 more random bytes of its own) and dropped on the way out. `testEntropy` exists
 * for the tests, which check that the value never shows up anywhere; the CLI never passes it.
 */
async function contributeOnce(zkeyIn, zkeyOut, testEntropy) {
  const raw = testEntropy === undefined ? randomBytes(64) : null;
  let entropy = testEntropy ?? raw.toString("hex");
  raw?.fill(0);
  try {
    // No logger: snarkjs would otherwise print progress lines, and none of them may sit near the secret.
    return await snarkjs.zKey.contribute(zkeyIn, zkeyOut, MAINNET_CONTRIBUTION_NAME, entropy, null);
  } finally {
    entropy = undefined;
  }
}

const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** The mainnet pins file as it is on disk now (read fresh: genesis may have been pinned since the process loaded params). */
export const readMainnetPins = () => JSON.parse(readFileSync(join(ROOT, NETWORKS.mainnet.pinsFile), "utf8"));

/**
 * Throws when outDir already holds a key and forceNew is off; otherwise returns the files that would be moved aside.
 * Every run is refused for good once the mainnet pins file names a genesis txid: after genesis this tool never
 * makes a key, here or elsewhere (a new key would need a consensus activation). `pins` is injected by the tests.
 */
export function assertOutputFree(outDir, forceNew = false, pins = readMainnetPins()) {
  if (pins?.genesisTxid) {
    throw new Error(`refused: ${NETWORKS.mainnet.pinsFile} already pins the genesis transaction ${pins.genesisTxid}; after genesis this tool never makes a key.`);
  }
  const held = OUT_FILES.filter((f) => existsSync(join(outDir, f)));
  if (held.length && !forceNew) {
    throw new Error(`${outDir} already holds a key (${held.join(", ")}); refusing to overwrite it. Pass --force-new to move it aside and make a new one (only before genesis).`);
  }
  return held;
}

/**
 * Builds and verifies the key, then writes the three files into `outDir`. All paths are injected.
 *   r1cs, ptau, wasm  inputs (the wasm is only fingerprinted into the manifest)
 *   ptauPin           the phase-1 pin (defaults to the Hermez file; tests pass their own tiny file)
 *   forceNew          an existing key in outDir is moved to outDir/superseded-<time>/ instead of refusing
 *                     (refused once the mainnet pins file has a genesis txid; `pins` replaces that file in tests)
 * Returns { dir, files, manifest, manifestSha256, sha256, contributionHash }.
 */
export async function buildMainnetKey({
  r1cs, ptau, wasm, outDir, ptauPin = PTAU, forceNew = false, circuitSource = null,
  circom = null, circomlib = null, gitCommit = null, now = new Date(), log = () => {}, testEntropy = undefined, pins = undefined,
}) {
  const final = (name) => join(outDir, name);
  const held = assertOutputFree(outDir, forceNew, pins);
  for (const [what, path] of [["r1cs", r1cs], ["phase-1 file", ptau], ["wasm", wasm]]) {
    if (!existsSync(path)) throw new Error(`${what} not found: ${path}`);
  }
  checkPtau(ptau, ptauPin);
  log(`phase 1: ${ptauPin.name} matches its pinned hashes`);

  mkdirSync(outDir, { recursive: true });
  if (held.length) {
    const aside = final(`superseded-${now.toISOString().replace(/[:.]/g, "-")}`);
    mkdirSync(aside);
    for (const f of held) renameSync(final(f), join(aside, f));
    log(`moved the earlier key to ${aside}`);
  }

  const work = mkdtempSync(join(outDir, ".work-"));
  const zkey0 = join(work, "transaction_0000.zkey");
  const zkeyNew = join(work, "transaction.zkey");

  log("snarkjs zKey.newZKey (the initial key, derived from the r1cs and the phase-1 file)");
  const init = await snarkjs.zKey.newZKey(r1cs, ptau, zkey0, null);
  if (init === -1) throw new Error("newZKey failed: the r1cs does not match the phase-1 curve");

  log("one phase-2 contribution, in this process");
  const contributionHash = hex(await contributeOnce(zkey0, zkeyNew, testEntropy));

  log("zKey.verifyFromR1cs (slow: minutes on the real circuit)");
  const check = await inspectZkey({ r1cs, ptau, zkey: zkeyNew });
  if (!check.valid) throw new Error(`the new key does not verify (${check.error}); nothing was published, the work files are in ${work}`);
  const [only] = check.contributions;
  if (check.contributions.length !== 1 || only.name !== MAINNET_CONTRIBUTION_NAME || only.hash !== contributionHash) {
    throw new Error(`the new key does not carry exactly the one expected contribution; nothing was published, the work files are in ${work}`);
  }

  const vkeyJson = vkeyBytes(await snarkjs.zKey.exportVerificationKey(zkeyNew));
  const sha = {
    circuit: circuitSource && existsSync(circuitSource) ? sha256File(circuitSource) : null,
    r1cs: sha256File(r1cs),
    wasm: sha256File(wasm),
    zkey: sha256File(zkeyNew),
    vkey: sha256(vkeyJson),
    ptau: ptauPin.sha256,
  };
  const manifest = {
    protocol: PROTOCOL,
    envelopeVersion: VERSION,
    circom,
    circomlib,
    constraints: r1csConstraints(r1cs),
    sha256: sha,
    phase1: { file: ptauPin.name, sha256: ptauPin.sha256, provenance: PHASE1_PROVENANCE },
    phase2: MAINNET_PHASE2,
    contribution: { name: MAINNET_CONTRIBUTION_NAME, hash: contributionHash },
    setup: MAINNET_SETUP,
    snarkjs: JSON.parse(readFileSync(join(ROOT, "node_modules/snarkjs/package.json"), "utf8")).version,
    date: now.toISOString(),
    gitCommit,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");

  renameSync(zkeyNew, final("transaction.zkey"));
  writeFileSync(final("verification_key.json"), vkeyJson);
  writeFileSync(final("manifest.json"), manifestBytes);
  // The initial key is public and worth nothing without the contribution; it only clutters the folder.
  rmSync(work, { recursive: true, force: true });

  return {
    dir: outDir,
    files: OUT_FILES.map(final),
    manifest,
    manifestSha256: sha256(manifestBytes),
    sha256: sha,
    contributionHash,
  };
}

/**
 * The options that switch on a debugger or a heap snapshot, by name, given their value (undefined when none
 * was given: fail closed). Their companions (--inspect-port, --inspect-publish-uid, --heap-prof-dir,
 * --heap-prof-interval) do nothing alone, and Node 24's test runner hands them, with
 * --heapsnapshot-near-heap-limit=0, to every test file.
 */
const ENABLES = {
  "--inspect": () => true,
  "--inspect-brk": () => true,
  "--inspect-wait": () => true,
  "--heap-prof": () => true,
  "--heapsnapshot-signal": (v) => v !== "",
  "--heapsnapshot-near-heap-limit": (v) => v === undefined || Number(v) !== 0,
};

/** [name, value] per option in an argument list; a value may be its own word ("--opt 3"). */
function optionsOf(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const eq = args[i].indexOf("=");
    const name = (eq < 0 ? args[i] : args[i].slice(0, eq)).replace(/_/g, "-");
    if (eq >= 0) out.push([name, args[i].slice(eq + 1)]);
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) out.push([name, args[++i]]);
    else out.push([name, undefined]);
  }
  return out;
}

/**
 * Throws when node was started with a debugger or heap-snapshot option, in execArgv or NODE_OPTIONS: either
 * could read the secret out of memory. `inspectorOpen` is the URL of an inspector that is already listening.
 */
export function assertNoDebugger(execArgv = process.execArgv, nodeOptions = process.env.NODE_OPTIONS ?? "", inspectorOpen = inspectorUrl()) {
  // Node drops double quotes anywhere in a NODE_OPTIONS word (--heap"-prof" is --heap-prof), so they go first.
  const words = nodeOptions.replace(/"/g, "").split(/\s+/).filter(Boolean);
  const flags = [...optionsOf(execArgv), ...optionsOf(words)].filter(([name, value]) => ENABLES[name]?.(value)).map(([name]) => name);
  if (flags.length || inspectorOpen) {
    throw new Error(`refusing to run with ${flags.length ? flags.join(", ") : "an open inspector"}: a debugger or heap snapshot could read the secret from memory. Start node without it.`);
  }
}

const FLAGS = ["--force-new", "--help"];
const OPTIONS = ["--out", "--r1cs", "--wasm", "--ptau"];

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.includes(a)) o[a.slice(2)] = true;
    else if (OPTIONS.includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument ${a} (try --help)`);
  }
  return o;
}

const USAGE = `usage: npm run key:mainnet -- [--force-new] [--out dir] [--r1cs file] [--wasm file] [--ptau file]
Defaults: build/mainnet, build/transaction.r1cs, build/transaction_js/transaction.wasm, build/ptau/${PTAU.name}.`;

export async function main(argv = process.argv.slice(2), out = console) {
  const o = parseArgs(argv);
  if (o.help) {
    out.log(USAGE);
    return 0;
  }
  assertNoDebugger();
  const at = (p) => resolve(ROOT, p);
  const outDir = o.out ? resolve(o.out) : at("build/mainnet");
  assertOutputFree(outDir, !!o["force-new"]); // before anything else: a key that exists is never touched silently
  const r1cs = o.r1cs ? resolve(o.r1cs) : at("build/transaction.r1cs");
  const wasm = o.wasm ? resolve(o.wasm) : at(NETWORKS.mainnet.artifacts.wasm);
  const ptau = o.ptau ? resolve(o.ptau) : at(`build/ptau/${PTAU.name}`);
  for (const [what, path, hint] of [
    ["r1cs", r1cs, "circom circuits/transaction.circom --O2 --r1cs --wasm --sym -o build (circom 2.2.2)"],
    ["wasm", wasm, "the same circom command with --wasm"],
    ["phase-1 file", ptau, `place the pinned ${PTAU.name} there (URLs in scripts/key-lib.mjs)`],
  ]) {
    if (!existsSync(path)) throw new Error(`${what} not found: ${path}; ${hint}`);
  }

  // The wasm and the circom version come from the signet build when it is the same circuit.
  const r1csSha = sha256File(r1cs);
  let built = null;
  try {
    built = JSON.parse(readFileSync(at("build/manifest.json"), "utf8"));
  } catch {}
  const same = built?.sha256?.r1cs === r1csSha;
  const pinnedWasm = JSON.parse(readFileSync(at(NETWORKS.mainnet.pinsFile), "utf8")).artifacts?.wasm;
  if (pinnedWasm && sha256File(wasm) !== pinnedWasm) throw new Error(`${wasm} does not match the wasm pinned in ${NETWORKS.mainnet.pinsFile}`);
  // On a clean machine there is no signet build manifest; the compiler itself then tells its version.
  let circom = same ? built.circom ?? null : null;
  if (!circom) {
    try {
      circom = execSync("circom --version", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim().split(/\s+/).pop() || null;
    } catch {}
  }
  let gitCommit = null;
  try {
    gitCommit = execSync("git rev-parse HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {}

  const r = await buildMainnetKey({
    r1cs, ptau, wasm, outDir, forceNew: !!o["force-new"],
    circuitSource: at("circuits/transaction.circom"),
    circom,
    circomlib: JSON.parse(readFileSync(at("node_modules/circomlib/package.json"), "utf8")).version,
    gitCommit,
    log: (m) => out.log(m),
  });

  out.log(`\nMainnet key written to ${r.dir}`);
  out.log(`  contribution "${MAINNET_CONTRIBUTION_NAME}"\n  hash ${r.contributionHash}`);
  out.log("\nPut these into src/pins.mainnet.json (leave genesisTxid, activationHeight and activations as they are):");
  out.log(`  "manifestSha256": "${r.manifestSha256}",`);
  out.log(`  "artifacts": { "wasm": "${r.sha256.wasm}", "zkey": "${r.sha256.zkey}", "vkey": "${r.sha256.vkey}" }`);
  out.log("\nNext (docs/MAINNET.md, G2): run `npm run key:verify -- --network mainnet`, publish the three files in a release");
  out.log("(`MURKLE_NETWORK=mainnet npm run release:assets`), pin the hashes above, and let the genesis ATTEST pin the manifest.");
  out.log("Do not run this tool again after genesis: a new key would need a consensus activation.");
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error(`key:mainnet: ${e.message}`);
  }
  await closeCurves();
  process.exitCode = code;
}

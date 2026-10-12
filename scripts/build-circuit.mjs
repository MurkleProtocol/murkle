// Compiles the circuit and runs the Groth16 setup, then fingerprints every
// artifact in build/manifest.json and pins the hashes in src/pins.json.
//
// Phase 1 is the public Perpetual Powers of Tau transcript (Hermez final,
// 2^15), checked against two pinned hashes and verified once with
// `snarkjs powersoftau verify`.
// Phase 2 is a DEV single-party contribution made on this machine (signet only).
// Whoever runs it could forge proofs (audit A-8), and every surface must say so.
// The mainnet key is built by scripts/mainnet-key.mjs.
//
//   npm run circuit:build            (needs circom 2.2.2 on PATH)
//   npm run circuit:build -- --force (rebuild even though a genesis is pinned)
import { execFileSync, execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROTOCOL, VERSION } from "../src/params.mjs";
import { downloadCapped } from "./artifacts-lib.mjs";
import { PTAU, checkPtau, r1csConstraints, sha256, sha256File } from "./key-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const CIRCOM_VERSION = "2.2.2";
const PATHS = {
  r1cs: "build/transaction.r1cs",
  wasm: "build/transaction_js/transaction.wasm",
  zkey0: "build/dev/transaction_0.zkey",
  zkey: "build/dev/transaction.zkey",
  vkey: "build/dev/verification_key.json",
  ptau: `build/ptau/${PTAU.name}`,
  manifest: "build/manifest.json",
  pins: "src/pins.json",
};
const PHASE2_NAME = `${PROTOCOL} DEV phase 2, single party, not a ceremony`;

const force = process.argv.includes("--force");
const SNARKJS = join(ROOT, "node_modules/snarkjs/build/cli.cjs");
function run(cmd, args) {
  // Never echo contribution entropy: with it, anyone could forge proofs.
  console.log(`$ ${cmd} ${args.map((a) => (a.startsWith("-e=") ? "-e=<random>" : a)).join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
}
const snarkjs = (...args) => run(process.execPath, [SNARKJS, ...args]);

function readPins() {
  return JSON.parse(readFileSync(PATHS.pins, "utf8"));
}

async function fetchPtau() {
  mkdirSync(dirname(PATHS.ptau), { recursive: true });
  const part = PATHS.ptau + ".part";
  for (const url of PTAU.urls) {
    try {
      console.log(`downloading ${PTAU.name} (${(PTAU.size / 2 ** 20).toFixed(1)} MiB) from ${url}`);
      // Capped at the pinned size: a source that sends more is cut off before it fills the disk.
      await downloadCapped(url, part, { maxBytes: PTAU.size, timeoutMs: 30 * 60_000 });
      checkPtau(part);
      renameSync(part, PATHS.ptau);
      return;
    } catch (e) {
      rmSync(part, { force: true });
      console.warn(`  failed: ${e.message}`);
    }
  }
  throw new Error(`could not fetch a ${PTAU.name} with the pinned hashes; place it at ${PATHS.ptau} by hand`);
}

/** Runs the (slow) transcript verification once per file; a marker records the verified hash. */
function verifyPtauOnce() {
  const marker = PATHS.ptau + ".verified";
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === PTAU.sha256) {
    console.log(`phase 1: ${PTAU.name} already verified (${marker})`);
    return;
  }
  snarkjs("powersoftau", "verify", PATHS.ptau);
  writeFileSync(marker, PTAU.sha256 + "\n");
}

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

// --- main ---------------------------------------------------------------
const before = readPins();
if (before.genesisTxid && !force) {
  throw new Error(
    `genesis ${before.genesisTxid} is pinned to manifest ${before.manifestSha256}. A rebuild makes a new zkey and breaks ` +
      "every replay; only a new re-genesis may do that (pass --force).",
  );
}

const circom = execSync("circom --version").toString().trim();
if (!circom.endsWith(CIRCOM_VERSION)) throw new Error(`need circom ${CIRCOM_VERSION} for a reproducible build, found "${circom}"`);

mkdirSync("build/dev", { recursive: true });
run("circom", ["circuits/transaction.circom", "--O2", "--r1cs", "--wasm", "--sym", "-o", "build"]);
snarkjs("r1cs", "info", PATHS.r1cs);

if (existsSync(PATHS.ptau)) checkPtau(PATHS.ptau);
else await fetchPtau();
verifyPtauOnce();

// The old single-party phase-1 files must not be mistaken for the public transcript.
for (const old of ["build/dev/pot_0.ptau", "build/dev/pot_1.ptau", "build/dev/pot15_final.ptau"]) {
  if (existsSync(old)) {
    rmSync(old);
    console.log(`removed obsolete single-party phase-1 file ${old}`);
  }
}

snarkjs("groth16", "setup", PATHS.r1cs, PATHS.ptau, PATHS.zkey0);
snarkjs("zkey", "contribute", PATHS.zkey0, PATHS.zkey, `--name=${PHASE2_NAME}`, `-e=${randomBytes(32).toString("hex")}`);
snarkjs("zkey", "verify", PATHS.r1cs, PATHS.ptau, PATHS.zkey);
snarkjs("zkey", "export", "verificationkey", PATHS.zkey, PATHS.vkey);

const artifacts = { wasm: sha256File(PATHS.wasm), zkey: sha256File(PATHS.zkey), vkey: sha256File(PATHS.vkey) };
const manifest = {
  protocol: PROTOCOL,
  envelopeVersion: VERSION,
  circom: CIRCOM_VERSION,
  circomlib: JSON.parse(readFileSync("node_modules/circomlib/package.json", "utf8")).version,
  constraints: r1csConstraints(PATHS.r1cs),
  sha256: { r1cs: sha256File(PATHS.r1cs), ...artifacts, ptau: PTAU.sha256 },
  setup: "phase1: PPoT hez_final_15; phase2: dev single-party",
  gitCommit: gitCommit(),
};
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
writeFileSync(PATHS.manifest, manifestBytes);

// Re-read so a concurrent edit of the genesis fields is preserved, not clobbered.
const pins = readPins();
pins.manifestSha256 = sha256(manifestBytes);
pins.artifacts = artifacts;
writeFileSync(PATHS.pins, JSON.stringify(pins, null, 2) + "\n");

console.log(`\nmanifest ${PATHS.manifest}  sha256 ${pins.manifestSha256}`);
console.log(`r1cs ${manifest.sha256.r1cs}\nwasm ${artifacts.wasm}\nzkey ${artifacts.zkey} (DEV phase 2)\nvkey ${artifacts.vkey}`);
console.log(`constraints ${manifest.constraints}; pins written to ${PATHS.pins}`);
if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();

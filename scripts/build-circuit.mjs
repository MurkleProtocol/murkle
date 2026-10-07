// Compiles the circuit and runs the Groth16 setup, then fingerprints every
// artifact in build/manifest.json and pins the hashes in src/pins.json.
//
// Phase 1 is the public Perpetual Powers of Tau transcript (Hermez final,
// 2^15), checked against two pinned hashes and verified once with
// `snarkjs powersoftau verify`.
// Phase 2 is a DEV single-party contribution made on this machine. Whoever
// runs it could forge proofs (audit A-8) until a public ceremony replaces it,
// and every surface must say so.
//
//   npm run circuit:build            (needs circom 2.2.2 on PATH)
//   npm run circuit:build -- --force (rebuild even though a genesis is pinned)
import { execFileSync, execSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blake2b } from "@noble/hashes/blake2b";
import { PROTOCOL, VERSION } from "../src/params.mjs";
import { downloadCapped } from "./artifacts-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const CIRCOM_VERSION = "2.2.2";
const PTAU = {
  name: "powersOfTau28_hez_final_15.ptau",
  // The original bucket answers 403 since September 2026; the mirrors serve
  // the identical file. Any source is accepted only if both hashes match.
  urls: [
    "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau",
    "https://github.com/MurkleProtocol/murkle/releases/download/artifacts-41d28d8899f3/powersOfTau28_hez_final_15.ptau",
    "https://github.com/hilawe/dash-mno-verify/releases/download/ptau-hermez-v1/powersOfTau28_hez_final_15.ptau",
  ],
  size: 37831832,
  sha256: "3ef2ecc5b75d687048cf2d59195119b42fb07c5af639c5f283d84bfa69829e7f",
  // Published in the snarkjs README next to the original download link.
  blake2b: "982372c867d229c236091f767e703253249a9b432c1710b4f326306bfa2428a17b06240359606cfe4d580b10a5a1f63fbed499527069c18ae17060472969ae6e",
};
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
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256File = (path) => sha256(readFileSync(path));
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

/** Both hashes must match: sha256 is our pin, blake2b is the one snarkjs publishes. */
function checkPtau(path) {
  const bytes = readFileSync(path);
  const s = sha256(bytes);
  const b = Buffer.from(blake2b(bytes)).toString("hex");
  if (bytes.length !== PTAU.size || s !== PTAU.sha256 || b !== PTAU.blake2b) {
    throw new Error(`${path}: hash mismatch (size ${bytes.length}, sha256 ${s}, blake2b ${b.slice(0, 16)}…)`);
  }
  return s;
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

/** nConstraints from the r1cs header section (iden3 r1cs binary format v1). */
function r1csConstraints(path) {
  const b = readFileSync(path);
  if (b.toString("latin1", 0, 4) !== "r1cs") throw new Error("not an r1cs file");
  let o = 12; // magic, version, nSections
  for (let i = 0, n = b.readUInt32LE(8); i < n; i++) {
    const type = b.readUInt32LE(o);
    const size = Number(b.readBigUInt64LE(o + 4));
    if (type === 1) {
      const fieldSize = b.readUInt32LE(o + 12);
      // fieldSize, prime, nWires, nPubOut, nPubIn, nPrvIn, nLabels (u64), nConstraints
      return b.readUInt32LE(o + 12 + 4 + fieldSize + 16 + 8);
    }
    o += 12 + size;
  }
  throw new Error("r1cs header not found");
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

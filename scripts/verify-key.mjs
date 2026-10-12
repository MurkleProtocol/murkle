#!/usr/bin/env node
// Checks a published proving key, so nobody has to take the operator's word for it.
//
//   npm run key:verify                       (this network's files; MURKLE_NETWORK or --network)
//   npm run key:verify -- --network mainnet
//
// What it proves, from the r1cs and the pinned phase-1 file alone:
//   1. the phase-1 file is the pinned Hermez powers of tau (size, sha256 and blake2b all match);
//   2. the zkey derives from that r1cs and that phase 1 (snarkjs zKey.verifyFromR1cs);
//   3. it carries exactly one phase-2 contribution (mainnet and signet both do), listed with its hash and name;
//      none may be a beacon (public randomness, so anyone could recompute the secret and forge proofs), and on
//      mainnet the one contribution must carry the name that scripts/mainnet-key.mjs writes;
//   4. the verification key is the one in the zkey, and the sha256 of the zkey and the vkey are the pinned ones.
//
// The r1cs comes from build/transaction.r1cs, from --r1cs <file>, or from --compile (circom 2.2.2 on circuits/).
// Exit status 0 only when every check passes; any mismatch exits 1.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { NETWORK, NETWORKS, resolveNetwork } from "../src/params.mjs";
import { MAINNET_CONTRIBUTION_NAME, PTAU, checkPtau, sha256, sha256File } from "./key-lib.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CIRCOM_VERSION = "2.2.2";

/** snarkjs logger that keeps what it is told instead of printing it. */
function captureLogger() {
  const info = [];
  const errors = [];
  return { info, errors, logger: { info: (m) => info.push(String(m)), error: (m) => errors.push(String(m)), warn: () => {}, debug: () => {} } };
}

/** The vkey file as `snarkjs zkey export verificationkey` writes it (one space of indent, no trailing newline). */
export const vkeyBytes = (vkey) => Buffer.from(JSON.stringify(vkey, null, 1));

/** Number of contributions, read straight from the zkey's MPC parameters section (10). */
export function zkeyContributionCount(zkeyPath) {
  const b = readFileSync(zkeyPath);
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "zkey") throw new Error(`${zkeyPath}: not a zkey file`);
  let o = 12;
  for (let i = 0, n = b.readUInt32LE(8); i < n; i++) {
    const type = b.readUInt32LE(o);
    const size = Number(b.readBigUInt64LE(o + 4));
    if (type === 10) return b.readUInt32LE(o + 12 + 64); // after the 64-byte circuit hash
    o += 12 + size;
  }
  throw new Error(`${zkeyPath}: no contribution section`);
}

/**
 * Every phase-2 contribution as the zkey stores it (section 10): its index (1-based), type (0 = a normal
 * contribute, 1 = a beacon), name, and whether it is a beacon. A contribution also counts as a beacon when
 * it carries beacon parameters (iteration exponent or beacon hash), whatever its type says.
 * bn128 layout: 64-byte G1 points, a 128-byte G2 point, 64-byte transcript, type, parameter block.
 */
export function zkeyContributionInfo(zkeyPath) {
  const b = readFileSync(zkeyPath);
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "zkey") throw new Error(`${zkeyPath}: not a zkey file`);
  let o = 12;
  for (let i = 0, n = b.readUInt32LE(8); i < n; i++) {
    const type = b.readUInt32LE(o);
    const size = Number(b.readBigUInt64LE(o + 4));
    if (type === 10) {
      const end = o + 12 + size;
      let p = o + 12 + 64; // after the 64-byte circuit hash
      const count = b.readUInt32LE(p);
      p += 4;
      const out = [];
      for (let c = 0; c < count; c++) {
        p += 64 * 3 + 128 + 64; // deltaAfter, g1_s, g1_sx, g2_spx, transcript
        const kind = b.readUInt32LE(p);
        const paramLength = b.readUInt32LE(p + 4);
        p += 8;
        const stop = p + paramLength;
        if (stop > end) throw new Error(`${zkeyPath}: contribution ${c + 1} overruns its section`);
        let name = "";
        let beaconParams = false;
        let last = 0;
        while (p < stop) {
          const t = b[p];
          if (t <= last) throw new Error(`${zkeyPath}: contribution ${c + 1} has unsorted parameters`);
          last = t;
          if (t === 1) {
            const len = b[p + 1];
            name = b.toString("utf8", p + 2, p + 2 + len);
            p += 2 + len;
          } else if (t === 2) {
            beaconParams = true;
            p += 2;
          } else if (t === 3) {
            beaconParams = true;
            p += 2 + b[p + 1];
          } else throw new Error(`${zkeyPath}: contribution ${c + 1} has an unknown parameter ${t}`);
        }
        if (p !== stop) throw new Error(`${zkeyPath}: contribution ${c + 1} parameters do not add up`);
        out.push({ index: c + 1, type: kind, name, beacon: kind !== 0 || beaconParams });
      }
      if (p !== end) throw new Error(`${zkeyPath}: the contribution section does not end where it should`);
      return out;
    }
    o += 12 + size;
  }
  throw new Error(`${zkeyPath}: no contribution section`);
}

/** snarkjs logs each contribution as "contribution #N <name>:" and four lines of hash words, last to first. */
export function parseContributions(infoLines) {
  const out = [];
  for (const line of infoLines) {
    const m = /^contribution #(\d+) (.*?):\n((?:\t\t[0-9a-f]{8}(?: [0-9a-f]{8})*\n?)+)$/s.exec(line);
    if (m) out.push({ index: Number(m[1]), name: m[2], hash: m[3].replace(/[^0-9a-f]/g, "") });
  }
  return out.sort((a, b) => a.index - b.index);
}

/** Stops the curve's worker threads; without it a script that used snarkjs does not exit. */
export async function closeCurves() {
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
}

/**
 * Re-derives the initial key from the r1cs and the phase-1 file and checks the zkey against it.
 * `valid` is snarkjs's verdict; `contributions` is what the zkey carries (only listed when valid).
 */
export async function inspectZkey({ r1cs, ptau, zkey }) {
  const cap = captureLogger();
  let valid = false;
  let error = null;
  try {
    valid = (await snarkjs.zKey.verifyFromR1cs(r1cs, ptau, zkey, cap.logger)) === true;
  } catch (e) {
    error = e.message;
  }
  const contributions = valid ? parseContributions(cap.info) : [];
  const count = zkeyContributionCount(zkey);
  const stored = zkeyContributionInfo(zkey);
  if (valid && contributions.length !== count) {
    valid = false;
    error = `snarkjs listed ${contributions.length} contributions but the zkey holds ${count}`;
  }
  const beacons = stored.filter((c) => c.beacon).map((c) => c.index);
  return { valid, error: error ?? (valid ? null : cap.errors.join("; ") || "snarkjs rejected the zkey"), count, contributions, beacons };
}

/**
 * Full check of a key. Never throws for a bad key: every failure lands in `problems`.
 *   pins: { manifestSha256, artifacts: { zkey, vkey, wasm } } as in src/pins*.json (null entries are not compared)
 *   ptauPin: the phase-1 pin; tests pass their own tiny file's description
 *   vkey, manifest, wasm: optional files next to the zkey; checked when given
 *   expectName: when set, the zkey must carry exactly one contribution and its name must be this one
 */
export async function verifyKey({
  r1cs, ptau, zkey, vkey = null, manifest = null, wasm = null,
  pins = {}, ptauPin = PTAU, expectContributions = 1, expectName = null, requirePins = false, log = () => {},
}) {
  const report = { ok: false, problems: [], notes: [], contributions: [], sha256: {} };
  const problem = (m) => report.problems.push(m);
  const compare = (what, actual, pinned) => {
    if (!pinned) {
      report.notes.push(`${what}: not pinned yet, nothing to compare`);
      if (requirePins) problem(`${what}: no pin to compare with (--require-pins)`);
    } else if (actual !== pinned) problem(`${what}: sha256 ${actual} differs from the pinned ${pinned}`);
    else report.notes.push(`${what}: matches the pin`);
  };

  try {
    checkPtau(ptau, ptauPin);
    report.notes.push(`phase 1: ${ptauPin.name} matches its pinned hashes`);
  } catch (e) {
    problem(`phase 1 file: ${e.message}`);
    return report;
  }

  log("re-deriving the initial key from the r1cs and the phase-1 file and checking the zkey (slow: minutes on the real circuit)");
  let info;
  try {
    info = await inspectZkey({ r1cs, ptau, zkey });
  } catch (e) {
    problem(`zkey: ${e.message}`);
    return report;
  }
  if (!info.valid) {
    problem(`zkey does not derive from this r1cs and this phase-1 file: ${info.error}`);
  } else {
    report.contributions = info.contributions;
    report.notes.push("zkey: derives from this r1cs and this phase-1 file (snarkjs verifyFromR1cs)");
  }
  if (info.count !== expectContributions) problem(`zkey carries ${info.count} phase-2 contributions, expected exactly ${expectContributions}`);
  if (info.beacons.length) {
    problem(`phase-2 contribution ${info.beacons.map((i) => `#${i}`).join(", ")} is a beacon (public randomness: anyone can recompute its secret and forge proofs)`);
  }
  if (expectName != null) {
    if (info.count !== 1) problem(`expected exactly one contribution named "${expectName}", the zkey carries ${info.count}`);
    else if (info.contributions[0] && info.contributions[0].name !== expectName) {
      problem(`the contribution is named "${info.contributions[0].name}", expected "${expectName}"`);
    }
  }

  report.sha256.zkey = sha256File(zkey);
  compare("zkey", report.sha256.zkey, pins.artifacts?.zkey);

  // The verification key: recomputed from the zkey, and the file (when given) must be that same key.
  const derived = await snarkjs.zKey.exportVerificationKey(zkey);
  report.sha256.vkey = sha256(vkeyBytes(derived));
  if (vkey) {
    const bytes = readFileSync(vkey);
    report.sha256.vkeyFile = sha256(bytes);
    let same = false;
    try {
      same = JSON.stringify(JSON.parse(bytes.toString("utf8"))) === JSON.stringify(derived);
    } catch {}
    if (!same) problem(`${vkey} is not the verification key of this zkey`);
    compare("vkey file", report.sha256.vkeyFile, pins.artifacts?.vkey);
  } else {
    compare("vkey (exported from the zkey)", report.sha256.vkey, pins.artifacts?.vkey);
  }

  if (wasm && existsSync(wasm)) {
    report.sha256.wasm = sha256File(wasm);
    compare("wasm", report.sha256.wasm, pins.artifacts?.wasm);
  }
  report.sha256.r1cs = sha256File(r1cs);

  if (manifest && existsSync(manifest)) {
    report.sha256.manifest = sha256File(manifest);
    compare("manifest", report.sha256.manifest, pins.manifestSha256);
    try {
      const m = JSON.parse(readFileSync(manifest, "utf8"));
      for (const [k, v] of [["r1cs", report.sha256.r1cs], ["zkey", report.sha256.zkey], ["vkey", report.sha256.vkeyFile ?? report.sha256.vkey], ["wasm", report.sha256.wasm]]) {
        if (v && m.sha256?.[k] && m.sha256[k] !== v) problem(`manifest names another ${k} (${m.sha256[k]}) than the one checked (${v})`);
      }
    } catch (e) {
      problem(`manifest: ${e.message}`);
    }
  }

  report.ok = report.problems.length === 0;
  return report;
}

/** The r1cs of circuits/transaction.circom, compiled into a fresh temp directory. */
function compileR1cs() {
  const version = execFileSync("circom", ["--version"]).toString().trim();
  if (!version.endsWith(CIRCOM_VERSION)) throw new Error(`need circom ${CIRCOM_VERSION} to rebuild the r1cs, found "${version}"`);
  const out = mkdtempSync(join(tmpdir(), "murkle-r1cs-"));
  execFileSync("circom", [join(ROOT, "circuits/transaction.circom"), "--O2", "--r1cs", "-o", out], { stdio: "inherit" });
  return join(out, "transaction.r1cs");
}

const FLAGS = { "--require-pins": "boolean", "--compile": "boolean", "--help": "boolean" };
const OPTIONS = ["--network", "--r1cs", "--ptau", "--zkey", "--vkey", "--manifest", "--wasm", "--expect-contributions"];

/** The contribution name a network's key must carry: mainnet is the one mainnet-key.mjs writes; signet's DEV key is not pinned by name. */
export const expectedContributionName = (network) => (network === "mainnet" ? MAINNET_CONTRIBUTION_NAME : null);

export function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS[a]) o[a.slice(2)] = true;
    else if (OPTIONS.includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      o[a.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument ${a} (try --help)`);
  }
  return o;
}

const USAGE = `usage: npm run key:verify -- [--network signet|mainnet] [--r1cs file | --compile] [--ptau file] [--zkey file]
         [--vkey file] [--manifest file] [--wasm file] [--expect-contributions N] [--require-pins]
Defaults: this network's files (build/dev or build/mainnet), build/transaction.r1cs, build/ptau/${PTAU.name}.`;

export async function main(argv = process.argv.slice(2), out = console) {
  const o = parseArgs(argv);
  if (o.help) {
    out.log(USAGE);
    return 0;
  }
  const network = resolveNetwork(o.network ?? NETWORK);
  const net = NETWORKS[network];
  const at = (p) => resolve(ROOT, p);
  const pins = JSON.parse(readFileSync(at(net.pinsFile), "utf8"));
  const files = {
    ptau: o.ptau ? resolve(o.ptau) : at(`build/ptau/${PTAU.name}`),
    zkey: o.zkey ? resolve(o.zkey) : at(net.artifacts.zkey),
    vkey: o.vkey ? resolve(o.vkey) : at(net.artifacts.vkey),
    manifest: o.manifest ? resolve(o.manifest) : at(net.artifacts.manifest),
    wasm: o.wasm ? resolve(o.wasm) : at(net.artifacts.wasm),
  };
  for (const k of ["ptau", "zkey"]) {
    if (!existsSync(files[k])) throw new Error(`${files[k]} not found${k === "ptau" ? `; place the pinned ${PTAU.name} there (URLs in scripts/key-lib.mjs)` : ""}`);
  }
  let r1cs = o.r1cs ? resolve(o.r1cs) : at("build/transaction.r1cs");
  if (o.compile) r1cs = compileR1cs();
  else if (!existsSync(r1cs)) throw new Error(`${r1cs} not found; pass --r1cs <file> or --compile (needs circom ${CIRCOM_VERSION})`);

  out.log(`network ${network}, pins ${net.pinsFile}`);
  const report = await verifyKey({
    r1cs, ptau: files.ptau, zkey: files.zkey,
    vkey: existsSync(files.vkey) ? files.vkey : null,
    manifest: existsSync(files.manifest) ? files.manifest : null,
    wasm: files.wasm,
    pins,
    expectContributions: o["expect-contributions"] == null ? 1 : Number(o["expect-contributions"]),
    expectName: expectedContributionName(network),
    requirePins: !!o["require-pins"],
    log: (m) => out.log(m),
  });
  for (const c of report.contributions) out.log(`contribution #${c.index}: ${c.name || "(no name)"}\n  hash ${c.hash}`);
  for (const n of report.notes) out.log(`  ${n}`);
  for (const [k, v] of Object.entries(report.sha256)) out.log(`  sha256 ${k.padEnd(9)} ${v}`);
  for (const p of report.problems) out.error(`FAIL ${p}`);
  out.log(report.ok ? "KEY OK: it derives from this circuit and the pinned phase 1, with the expected contributions." : "KEY NOT OK");
  return report.ok ? 0 : 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error(`key:verify: ${e.message}`);
  }
  await closeCurves();
  process.exitCode = code;
}

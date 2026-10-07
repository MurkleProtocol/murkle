#!/usr/bin/env node
// Finalizes a closed ceremony with the Bitcoin block beacon (docs/CEREMONY.md, "Finalisation").
//
//   node scripts/ceremony/finalize.mjs --dir D [--source esplora|bitcoind] [--esplora URL]
//     [--cross-check esplora|bitcoind|none] [--r1cs P] [--ptau P] [--wasm P] [--git-commit SHA]
//     [--install [--root R]] [--drop-late]
//
// Refuses unless the queue closed below the beacon height (or every contribution was accepted
// while the coordinator's chain tip was below the close height, recorded per entry) and the
// beacon block is at least 6 blocks deep. When the close came late and only the first k
// contributions were accepted below the close height, --drop-late finalizes with those k and
// records the rest in transcript.final.excluded (they are not in the final key). Reads the 80-byte header at the beacon height (checked: it hashes to the block
// hash and meets its own proof-of-work target), and with a second source configured checks that
// both serve the same block. Applies `snarkjs zkey beacon` with that block hash (2^10
// iterations), verifies the result from the r1cs and ptau, exports the verification key, and
// writes final/{transaction.zkey, verification_key.json, manifest.json} plus transcript.final.
//
// --install copies the three files to build/mainnet/ and writes artifacts.zkey, artifacts.vkey
// and manifestSha256 into src/pins.mainnet.json, only while its genesisTxid is null. It never
// touches src/pins.json. --root installs under another directory (rehearsals, tests).
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execSync } from "node:child_process";
import * as snarkjs from "snarkjs";
import {
  CONFIRMATIONS, DEFAULT_PATHS, ITERATIONS_EXP, PINNED, PROTOCOL, ROOT, beaconName, ceremonyPaths, closeCommitmentOf,
  contributionsTranscriptSha256, exportVkeyBytes, isMain, newInitialZkey, openBeaconSource, parseArgs, readBeaconBlock,
  readContributions, readJson, readJsonOr, runMain, serializeJson, sha256Hex, verifyFromInit, writeFileAtomic,
  writeJsonAtomic,
} from "./lib.mjs";

const MAINNET_FALLBACK = {
  artifacts: { manifest: "build/mainnet/manifest.json", vkey: "build/mainnet/verification_key.json", zkey: "build/mainnet/transaction.zkey" },
  pinsFile: "src/pins.mainnet.json",
};

function circomlibVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, "node_modules", "circomlib", "package.json"), "utf8")).version;
  } catch {
    return null;
  }
}

/** The close record: the coordinator's (transcript.closed), else control.json's when the coordinator was not running. */
export function closureOf(p, transcript) {
  if (transcript.closed) return transcript.closed;
  const c = readJsonOr(p.control, null);
  return c?.phase === "closed" ? { at: c.at, tipHeight: Number.isSafeInteger(c.tipHeight) ? c.tipHeight : null } : null;
}

/**
 * How many leading contributions may go into the final key: all of them when the close tip is
 * below the beacon height; otherwise those accepted while the coordinator's recorded chain tip
 * (entry.tipHeight) was below the close height. -> { usable, reason }
 */
export function usableContributions(transcript, closed, beacon) {
  const list = transcript.contributions;
  if (Number.isSafeInteger(closed?.tipHeight) && closed.tipHeight < beacon.height) return { usable: list.length, reason: "closed below the beacon height" };
  const closeBefore = beacon.height - beacon.closeBeforeBlocks;
  let k = 0;
  while (k < list.length && Number.isSafeInteger(list[k].tipHeight) && list[k].tipHeight < closeBefore) k++;
  return { usable: k, reason: `accepted while the recorded chain tip was below ${closeBefore}` };
}

/**
 * finalizeCeremony({ dir, r1csPath, ptauPath, wasmPath, sources, gitCommit, log, now, dropLate })
 *   sources: [primary, ...cross-checks], each { describe, tipHeight(), blockHash(h), blockHeader(hash) }
 * -> { manifest, final, transcript, already: boolean }
 */
export async function finalizeCeremony({
  dir, r1csPath = join(ROOT, DEFAULT_PATHS.r1cs), ptauPath = join(ROOT, DEFAULT_PATHS.ptau),
  wasmPath = join(ROOT, DEFAULT_PATHS.wasm), sources = [], gitCommit = null, log = console.log, now = Date.now, dropLate = false,
}) {
  const p = ceremonyPaths(dir);
  const ceremony = readJson(p.ceremony);
  let transcript = readJson(p.transcript);
  if (transcript.final) return { manifest: readJson(join(p.final, "manifest.json")), final: transcript.final, transcript, already: true };

  const H = ceremony.beacon.height;
  const network = ceremony.beacon.network;
  const closed = closureOf(p, transcript);
  if (!closed) throw new Error("the ceremony is not closed: run scripts/ceremony/admin.mjs close first");
  const all = transcript.contributions.length;
  const { usable: n, reason: usableWhy } = usableContributions(transcript, closed, ceremony.beacon);
  if (n < all) {
    const why = Number.isSafeInteger(closed.tipHeight) ? `the queue closed at tip ${closed.tipHeight}, not below the beacon height ${H}` : "the close did not record a chain tip";
    if (n === 0) throw new Error(`${why}, and no contribution has a recorded tip below the close height: this ceremony cannot use that beacon`);
    if (!dropLate) throw new Error(`${why}; the first ${n} of ${all} contributions were ${usableWhy}. Pass --drop-late to finalize with those ${n} (the others are recorded as excluded), or restart under a new id`);
    log(`${why}: finalizing with the first ${n} of ${all} contributions (${usableWhy}); #${n + 1}..#${all} are excluded`);
  }
  if (n < 1) throw new Error("no contributions: there is nothing to finalize");

  const r1csSha = sha256Hex(readFileSync(r1csPath));
  const ptauSha = sha256Hex(readFileSync(ptauPath));
  if (r1csSha !== ceremony.r1csSha256 || ptauSha !== ceremony.ptau.sha256) throw new Error("the r1cs or ptau is not the one this ceremony is pinned to");
  const last = p.zkey(n);
  if (!existsSync(last) || sha256Hex(readFileSync(last)) !== transcript.contributions[n - 1].zkeySha256) {
    throw new Error(`zkeys/${basename(last)} is missing or differs from the transcript`);
  }

  // The beacon block, from every source; they must agree.
  if (!sources.length) throw new Error("no Bitcoin data source for the beacon");
  const tip = await sources[0].tipHeight();
  if (tip < H + CONFIRMATIONS) throw new Error(`the tip must be at least ${H + CONFIRMATIONS} (beacon height + ${CONFIRMATIONS}); it is ${tip}: wait ${H + CONFIRMATIONS - tip} more blocks`);
  const blocks = [];
  for (const s of sources) {
    const b = await readBeaconBlock(s, H, network);
    blocks.push(b);
    log(`beacon block ${H} from ${s.describe}: ${b.hash} (header checked: ${b.checkedBy})`);
  }
  if (blocks.some((b) => b.hash !== blocks[0].hash)) throw new Error(`the sources disagree on block ${H}: ${blocks.map((b) => b.hash).join(" vs ")}`);
  const beacon = blocks[0];

  log(`applying the beacon (2^${ITERATIONS_EXP} iterations) to key #${n}`);
  const out = { type: "mem" };
  const errors = [];
  const logger = { info() {}, debug() {}, warn: (m) => errors.push(String(m)), error: (m) => errors.push(String(m)) };
  const beaconHash = await snarkjs.zKey.beacon(last, out, beaconName(network, H), beacon.hash, ITERATIONS_EXP, logger);
  if (!beaconHash || !(out.data instanceof Uint8Array)) throw new Error(`zkey beacon failed: ${errors.join("; ") || "unknown"}`);
  const finalZkey = out.data;

  log("verifying the final key from the r1cs and the ptau");
  const init = await newInitialZkey(r1csPath, ptauPath);
  if (sha256Hex(init) !== ceremony.initialZkeySha256) throw new Error("the recomputed initial key differs from ceremony.json");
  const v = await verifyFromInit(init, ptauPath, finalZkey);
  if (!v.ok) throw new Error(`the final key does not verify: ${v.reason}`);
  const { contributions } = await readContributions(finalZkey);
  if (contributions.length !== n + 1) throw new Error("the final key does not hold the transcript's contributions plus the beacon");
  for (let i = 0; i < n; i++) {
    if (contributions[i].contributionHash !== transcript.contributions[i].contributionHash) throw new Error(`contribution ${i + 1} differs from the transcript`);
  }
  const b = contributions[n];
  if (b.type !== 1 || b.beaconHash !== beacon.hash || b.numIterationsExp !== ITERATIONS_EXP) throw new Error("the beacon contribution is not the expected one");

  const vkeyBytes = await exportVkeyBytes(finalZkey);
  const wasmSha = existsSync(wasmPath) ? sha256Hex(readFileSync(wasmPath)) : null;
  if (ceremony.pinned && wasmSha !== PINNED.wasmSha256) throw new Error(`${wasmPath} is missing or is not the pinned wasm ${PINNED.wasmSha256}`);

  // A close recorded only in control.json (coordinator not running): the commitment is computed
  // now, so it shows nothing about the time before the beacon (docs/CEREMONY.md).
  transcript = { ...transcript, closed: transcript.closed ?? { at: closed.at, tipHeight: closed.tipHeight, ...closeCommitmentOf(transcript) } };
  const transcriptSha256 = contributionsTranscriptSha256(transcript);
  const P = await import("../../src/params.mjs").catch(() => ({}));
  const manifest = {
    protocol: PROTOCOL,
    envelopeVersion: P.VERSION ?? 0,
    circom: PINNED.circom,
    circomlib: circomlibVersion(),
    constraints: ceremony.constraints,
    sha256: { r1cs: ceremony.r1csSha256, wasm: wasmSha, zkey: sha256Hex(finalZkey), vkey: sha256Hex(vkeyBytes), ptau: ceremony.ptau.sha256 },
    setup: ceremony.pinned
      ? `phase1: PPoT hez_final_15; phase2: public MPC ceremony ${ceremony.id}, ${n} contributions, beacon Bitcoin block ${H}`
      : `phase1: ${ceremony.ptau.name} (rehearsal, not pinned); phase2: rehearsal ceremony ${ceremony.id}, ${n} contributions, beacon Bitcoin block ${H}`,
    ceremony: { id: ceremony.id, contributions: n, transcriptSha256, beacon: { network, height: H, blockHash: beacon.hash, iterationsExp: ITERATIONS_EXP } },
    network,
    gitCommit,
  };
  const manifestBytes = Buffer.from(serializeJson(manifest));
  mkdirSync(p.final, { recursive: true });
  writeFileAtomic(join(p.final, "transaction.zkey"), finalZkey);
  writeFileAtomic(join(p.final, "verification_key.json"), vkeyBytes);
  writeFileAtomic(join(p.final, "manifest.json"), manifestBytes);
  const final = {
    beaconHeight: H,
    beaconBlockHash: beacon.hash,
    beaconHeader: beacon.header,
    beaconContributionHash: b.contributionHash,
    zkeySha256: manifest.sha256.zkey,
    vkeySha256: manifest.sha256.vkey,
    manifestSha256: sha256Hex(manifestBytes),
    transcriptSha256,
    finalizedAt: new Date(now()).toISOString(),
    contributions: n,
    ...(n < all ? { excluded: transcript.contributions.slice(n).map((c) => c.index), excludedReason: `accepted when the recorded chain tip was not below the close height` } : {}),
  };
  transcript = { ...transcript, final };
  writeJsonAtomic(p.transcript, transcript);
  const st = readJsonOr(p.state, {});
  writeJsonAtomic(p.state, { ...st, phase: "finalized", queue: [], slot: null, closed: st.closed ?? { ...closed, by: "finalize" } });
  return { manifest, final, transcript, already: false };
}

/**
 * Copies the final files to <root>/build/mainnet/ and pins them in <root>/src/pins.mainnet.json.
 * -> { pins, pinsPath }
 */
export async function installFinal({ dir, root = ROOT, log = console.log }) {
  const p = ceremonyPaths(dir);
  const ceremony = readJson(p.ceremony);
  const transcript = readJson(p.transcript);
  if (!transcript.final) throw new Error("the ceremony is not finalized");
  const intoRepo = resolve(root) === resolve(ROOT);
  if (intoRepo && !ceremony.pinned) throw new Error("an unpinned rehearsal ceremony is never installed into this repository");
  if (intoRepo && ceremony.beacon.network !== "mainnet") throw new Error("only a ceremony with a mainnet beacon is installed for mainnet");
  const P = await import("../../src/params.mjs").catch(() => ({}));
  const net = P.NETWORKS?.mainnet ?? MAINNET_FALLBACK;
  const pinsPath = join(root, net.pinsFile ?? MAINNET_FALLBACK.pinsFile);
  if (basename(pinsPath) === "pins.json") throw new Error("refusing to write src/pins.json");
  if (!existsSync(pinsPath)) throw new Error(`${pinsPath} is missing: this build has no mainnet pins file`);
  const raw = readFileSync(pinsPath, "utf8");
  const pins = JSON.parse(raw);
  if (pins.genesisTxid !== null && pins.genesisTxid !== undefined) throw new Error(`mainnet genesis ${pins.genesisTxid} is pinned: the artifacts can no longer change`);

  const files = { zkey: "transaction.zkey", vkey: "verification_key.json", manifest: "manifest.json" };
  const sums = {};
  for (const [k, f] of Object.entries(files)) {
    const src = join(p.final, f);
    sums[k] = sha256Hex(readFileSync(src));
    const dst = join(root, net.artifacts?.[k] ?? MAINNET_FALLBACK.artifacts[k]);
    mkdirSync(join(dst, ".."), { recursive: true });
    copyFileSync(src, dst);
    if (sha256Hex(readFileSync(dst)) !== sums[k]) throw new Error(`copy of ${f} to ${dst} does not match`);
    log(`installed ${dst}`);
  }
  if (sums.zkey !== transcript.final.zkeySha256 || sums.vkey !== transcript.final.vkeySha256 || sums.manifest !== transcript.final.manifestSha256) {
    throw new Error("the final files differ from transcript.final");
  }
  const manifest = readJson(join(p.final, "manifest.json"));
  if (pins.artifacts?.wasm && manifest.sha256.wasm && pins.artifacts.wasm !== manifest.sha256.wasm) throw new Error("the manifest's wasm differs from the pinned wasm");
  pins.manifestSha256 = sums.manifest;
  pins.artifacts = { ...(pins.artifacts ?? {}), zkey: sums.zkey, vkey: sums.vkey };
  const text = JSON.stringify(pins, null, 2) + "\n";
  writeFileAtomic(pinsPath, raw.includes("\r\n") ? text.replace(/\n/g, "\r\n") : text);
  log(`pinned in ${pinsPath}:\n${JSON.stringify({ manifestSha256: pins.manifestSha256, artifacts: pins.artifacts }, null, 2)}`);
  return { pins, pinsPath };
}

function gitCommit() {
  try {
    return execSync("git rev-parse HEAD", { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/** Opens the primary source and the cross-check from flags and env. */
export async function sourcesFromArgs(a, network, env = process.env) {
  const primary = a.source ?? (env.MURKLE_BTC_SOURCE === "bitcoind" ? "bitcoind" : "esplora");
  const hasNode = !!(env.MURKLE_BITCOIND_URL || env.MURKLE_BITCOIND_COOKIE || env.MURKLE_BITCOIND_USER);
  const cross = a.crossCheck ?? (primary === "bitcoind" ? "esplora" : hasNode ? "bitcoind" : "none");
  const out = [await openBeaconSource({ kind: primary, network, env, esplora: a.esplora ?? null })];
  if (cross !== "none" && cross !== primary) out.push(await openBeaconSource({ kind: cross, network, env, esplora: a.esplora ?? null }));
  if (out.length === 1) console.warn("warning: one data source only; a second one (--cross-check) guards against a source that serves a fake block");
  return out;
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ["install", "dropLate"] });
  if (!a.dir) throw new Error("--dir is required");
  const p = ceremonyPaths(a.dir);
  const ceremony = readJson(p.ceremony);
  const transcript = readJson(p.transcript);
  if (!transcript.final) {
    const sources = await sourcesFromArgs(a, ceremony.beacon.network);
    const { manifest, final } = await finalizeCeremony({
      dir: a.dir,
      r1csPath: resolve(a.r1cs ?? join(ROOT, DEFAULT_PATHS.r1cs)),
      ptauPath: resolve(a.ptau ?? join(ROOT, DEFAULT_PATHS.ptau)),
      wasmPath: resolve(a.wasm ?? join(ROOT, DEFAULT_PATHS.wasm)),
      sources,
      gitCommit: a.gitCommit ?? gitCommit(),
      dropLate: !!a.dropLate,
    });
    console.log(`finalized ${ceremony.id}: ${manifest.ceremony.contributions} contributions, beacon block ${final.beaconHeight} ${final.beaconBlockHash}`);
    console.log(`  zkey sha256 ${final.zkeySha256}\n  vkey sha256 ${final.vkeySha256}\n  manifest sha256 ${final.manifestSha256}`);
    console.log(`Publish ${p.final}, every zkeys/*.zkey and transcript.json; ask independent people to run scripts/ceremony/verify.mjs.`);
  } else {
    console.log(`${ceremony.id} is already finalized (zkey ${transcript.final.zkeySha256})`);
  }
  if (a.install) await installFinal({ dir: a.dir, root: a.root ? resolve(a.root) : ROOT });
  return 0;
}

if (isMain(import.meta.url)) runMain(main);

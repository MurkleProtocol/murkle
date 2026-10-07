#!/usr/bin/env node
// Creates a ceremony directory: checks the circuit and phase-1 pins, writes the deterministic
// starting key zkeys/0000.zkey (`snarkjs zkey new`, anyone can recompute it), ceremony.json,
// the empty public transcript and the coordinator state. Never overwrites an existing ceremony.
//
//   node scripts/ceremony/init.mjs --dir data/ceremony/murkle-mainnet-1 --id murkle-mainnet-1 \
//     --beacon-height 975000 [--r1cs build/transaction.r1cs] [--ptau build/ptau/powersOfTau28_hez_final_15.ptau]
//     [--source esplora|bitcoind] [--esplora URL] [--tip N] [--min-blocks-ahead 1008]
//     [--beacon-network mainnet|signet] [--unpinned]
//
// The beacon height must lie in the future: by default at least 1008 blocks (about a week)
// above the current tip on mainnet. The tip comes from --source (default esplora, the public
// mempool.space API) unless --tip gives it. --unpinned accepts another circuit or ptau and marks
// the ceremony as a test everywhere (rehearsals and the test suite only).
import { basename, join, relative, resolve, sep } from "node:path";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import {
  CLOSE_BEFORE_BLOCKS, DEFAULT_PATHS, ITERATIONS_EXP, NAME_MAX, PINNED, PROTOCOL, ROOT, UPLOAD_SLACK,
  ceremonyPaths, isMain, newInitialZkey, openBeaconSource, parseArgs, r1csConstraints, requireFile, runMain,
  sha256Hex, writeFileAtomic, writeJsonAtomic,
} from "./lib.mjs";

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WEEK_BLOCKS = 1008;

/** Refuses a ceremony directory inside data/<network>/ (the indexer's and relayer's state). */
export function checkCeremonyDir(dir) {
  const rel = relative(resolve(ROOT, "data"), resolve(dir));
  if (!rel.startsWith("..") && !rel.startsWith(sep) && /^(signet|mainnet)([\\/]|$)/.test(rel)) {
    throw new Error(`refusing ${dir}: data/signet and data/mainnet hold indexer and relayer state; use data/ceremony/<id>`);
  }
}

/**
 * initCeremony({ dir, id, r1csPath, ptauPath, beaconHeight, beaconNetwork, tipHeight, unpinned,
 *                minBlocksAhead, now }) -> { ceremony, transcript }
 */
export async function initCeremony({
  dir, id, r1csPath = join(ROOT, DEFAULT_PATHS.r1cs), ptauPath = join(ROOT, DEFAULT_PATHS.ptau),
  beaconHeight, beaconNetwork = "mainnet", tipHeight, unpinned = false, minBlocksAhead = null, now = Date.now,
}) {
  if (!ID_RE.test(String(id ?? ""))) throw new Error("--id must be 1-63 characters of a-z, 0-9 and '-'");
  if (!dir) throw new Error("--dir is required");
  checkCeremonyDir(dir);
  const p = ceremonyPaths(dir);
  if (existsSync(p.ceremony) || existsSync(p.transcript)) throw new Error(`${p.dir} already holds a ceremony; it is never overwritten`);
  if (!["mainnet", "signet"].includes(beaconNetwork)) throw new Error("--beacon-network must be mainnet or signet");

  const r1cs = readFileSync(requireFile(r1csPath, "r1cs"));
  const r1csSha256 = sha256Hex(r1cs);
  const ptauSha256 = sha256Hex(readFileSync(requireFile(ptauPath, "ptau")));
  const pinned = r1csSha256 === PINNED.r1csSha256 && ptauSha256 === PINNED.ptau.sha256;
  if (!pinned && !unpinned) {
    const what = [];
    if (r1csSha256 !== PINNED.r1csSha256) what.push(`r1cs sha256 ${r1csSha256} is not the pinned ${PINNED.r1csSha256}`);
    if (ptauSha256 !== PINNED.ptau.sha256) what.push(`ptau sha256 ${ptauSha256} is not the pinned ${PINNED.ptau.sha256}`);
    throw new Error(`${what.join("; ")} (run npm run circuit:build, or pass --unpinned for a rehearsal)`);
  }
  if (pinned && unpinned) unpinned = false;
  const constraints = r1csConstraints(r1cs);

  const H = Number(beaconHeight);
  const tip = Number(tipHeight);
  if (!Number.isSafeInteger(H) || H <= 0) throw new Error("--beacon-height must be a positive block height");
  if (!Number.isSafeInteger(tip) || tip < 0) throw new Error("the current tip height is unknown");
  const ahead = minBlocksAhead ?? (beaconNetwork === "mainnet" ? WEEK_BLOCKS : CLOSE_BEFORE_BLOCKS + 1);
  if (H < tip + ahead) throw new Error(`beacon height ${H} must be at least ${ahead} blocks above the tip ${tip}`);

  const initial = await newInitialZkey(r1csPath, ptauPath);
  const initialZkeySha256 = sha256Hex(initial);
  mkdirSync(p.zkeys, { recursive: true });
  writeFileAtomic(p.zkey(0), initial);

  const createdAt = new Date(now()).toISOString();
  const ptau = { name: basename(ptauPath), sha256: ptauSha256 };
  const beacon = { network: beaconNetwork, height: H, closeBeforeBlocks: CLOSE_BEFORE_BLOCKS, iterationsExp: ITERATIONS_EXP };
  const ceremony = {
    v: 1, id, protocol: PROTOCOL, pinned: !unpinned, r1csSha256, constraints, ptau, initialZkeySha256,
    initialZkeyBytes: initial.length, beacon,
    limits: { uploadSlackBytes: UPLOAD_SLACK, nameMaxBytes: NAME_MAX },
    tipAtCreate: tip, createdAt,
  };
  const transcript = {
    version: 1, ceremony: id, protocol: PROTOCOL, pinned: !unpinned,
    circuit: { r1csSha256, constraints },
    ptau,
    initial: { zkeySha256: initialZkeySha256, bytes: initial.length },
    beacon: { network: beaconNetwork, height: H, closeBeforeHeight: H - CLOSE_BEFORE_BLOCKS, iterationsExp: ITERATIONS_EXP },
    contributions: [],
    closed: null,
    final: null,
  };
  writeJsonAtomic(p.ceremony, ceremony);
  writeJsonAtomic(p.transcript, transcript);
  writeJsonAtomic(p.state, { v: 1, phase: "open", queue: [], slot: null, done: [], expired: [], closed: null });
  return { ceremony, transcript };
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ["unpinned"] });
  const beaconNetwork = a.beaconNetwork ?? "mainnet";
  let tip = a.tip;
  if (tip === undefined) {
    const source = await openBeaconSource({ kind: a.source ?? "esplora", network: beaconNetwork, esplora: a.esplora ?? null });
    tip = await source.tipHeight();
    console.log(`tip ${tip} from ${source.describe}`);
  }
  const { ceremony } = await initCeremony({
    dir: a.dir,
    id: a.id,
    r1csPath: a.r1cs ? resolve(a.r1cs) : undefined,
    ptauPath: a.ptau ? resolve(a.ptau) : undefined,
    beaconHeight: a.beaconHeight,
    beaconNetwork,
    tipHeight: tip,
    unpinned: !!a.unpinned,
    minBlocksAhead: a.minBlocksAhead !== undefined ? Number(a.minBlocksAhead) : null,
  });
  console.log(`ceremony ${ceremony.id} created in ${resolve(a.dir)}`);
  console.log(`  circuit r1cs ${ceremony.r1csSha256} (${ceremony.constraints} constraints)${ceremony.pinned ? "" : "  UNPINNED: rehearsal only"}`);
  console.log(`  phase 1 ${ceremony.ptau.name} ${ceremony.ptau.sha256}`);
  console.log(`  initial zkey 0000.zkey sha256 ${ceremony.initialZkeySha256}`);
  console.log(`  beacon: Bitcoin ${ceremony.beacon.network} block ${ceremony.beacon.height}; the queue closes at ${ceremony.beacon.height - CLOSE_BEFORE_BLOCKS}`);
  console.log("Announce the beacon height now, before the first contribution.");
  return 0;
}

if (isMain(import.meta.url)) runMain(main);

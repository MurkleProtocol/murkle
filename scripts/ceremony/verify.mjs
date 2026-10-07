#!/usr/bin/env node
// Verifies a Murkle phase-2 ceremony from its public outputs. Anyone can run it.
//
//   node scripts/ceremony/verify.mjs --transcript <path|url> --zkey <final transaction.zkey>
//     [--r1cs build/transaction.r1cs] [--ptau build/ptau/powersOfTau28_hez_final_15.ptau]
//     [--expect-hash <your contribution hash>] [--beacon-source esplora|bitcoind|none] [--esplora URL]
//     [--zkeys-dir <dir with 0001.zkey ...>] [--vkey <verification_key.json>] [--manifest <manifest.json>]
//     [--expect-ceremony-id <id>] [--expect-beacon-height <H>] [--expect-close-commitment <hex>]
//     [--unpinned]
//
// The --expect-* values come from the announcement and from the close commitment the operator
// published before the beacon block: the transcript cannot vouch for them itself. Without them
// those checks print "skip" with what to compare by hand.
//
// Checks: the r1cs and ptau are the pinned ones (and the transcript's); the initial key is the
// deterministic `zkey new` of the two (recomputed here); the final key verifies from them
// (snarkjs verifyFromInit); its contribution list equals the transcript in order, plus one
// beacon contribution made with the hash of the announced Bitcoin block (header checked for its
// own proof of work and the difficulty bounds from a pinned checkpoint; the block hash at that
// height checked against a data source unless --beacon-source none); the coordinator's record
// that the queue closed below the beacon height, and its close commitment; the final key, the exported
// verification key and the manifest match transcript.final (and the mainnet pins when they name
// them); --expect-hash is in the transcript. Exit 0 only when every check holds.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_PATHS, GENESIS_HASH, ITERATIONS_EXP, PINNED, ROOT, checkBeaconHeader, closeCommitmentOf, contributionsTranscriptSha256,
  exportVkeyBytes, isMain, newInitialZkey, normalizeHash, openBeaconSource, parseArgs, readBeaconBlock, readContributions,
  requireFile, runMain, sha256Hex, verifyFromInit, zkeyName,
} from "./lib.mjs";

const MAX_TRANSCRIPT = 4 << 20;

export async function loadTranscript(where) {
  if (/^https?:\/\//.test(where)) {
    const res = await fetch(where, { cache: "no-store" });
    if (!res.ok) throw new Error(`${where}: HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_TRANSCRIPT) throw new Error("transcript is too large");
    return JSON.parse(text);
  }
  return JSON.parse(readFileSync(where, "utf8"));
}

/**
 * verifyCeremony({ transcript, zkeyPath, r1csPath, ptauPath, expectHash, source, zkeysDir, vkeyPath,
 *                  manifestPath, pinsPath, allowUnpinned, expectCeremonyId, expectBeaconHeight,
 *                  expectCloseCommitment }) -> { ok, checks: [{ name, status, detail }] }
 *   source: an opened beacon source or null (the chain lookup is then reported as skipped)
 */
export async function verifyCeremony({
  transcript: t, zkeyPath, r1csPath = join(ROOT, DEFAULT_PATHS.r1cs), ptauPath = join(ROOT, DEFAULT_PATHS.ptau),
  expectHash = null, source = null, zkeysDir = null, vkeyPath = null, manifestPath = null,
  pinsPath = join(ROOT, "src", "pins.mainnet.json"), allowUnpinned = false,
  expectCeremonyId = null, expectBeaconHeight = null, expectCloseCommitment = null,
}) {
  const checks = [];
  const check = (name, ok, detail = "") => checks.push({ name, status: ok ? "ok" : "FAIL", detail });
  const skip = (name, detail) => checks.push({ name, status: "skip", detail });
  const done = () => ({ ok: !checks.some((c) => c.status === "FAIL"), checks });

  // Shape.
  const list = Array.isArray(t?.contributions) ? t.contributions : null;
  const shapeOk = t?.version === 1 && list && list.every((c, i) => c.index === i + 1 && normalizeHash(c.contributionHash) === c.contributionHash);
  check("transcript format", !!shapeOk, shapeOk ? `${list.length} contributions` : "not a version-1 transcript with ordered contributions");
  if (!shapeOk) return done();
  if (!t.final) {
    check("finalized", false, "transcript.final is missing: the ceremony has not been finalized");
    return done();
  }
  // The announcement: the transcript names its own id and beacon height, so compare them with what was announced.
  if (expectCeremonyId !== null) check("announced ceremony id", t.ceremony === expectCeremonyId, `transcript ${JSON.stringify(t.ceremony)}, announced ${JSON.stringify(expectCeremonyId)}`);
  else skip("announced ceremony id", `compare ${JSON.stringify(t.ceremony)} with the announcement (--expect-ceremony-id)`);
  if (expectBeaconHeight !== null) check("announced beacon height", t.beacon?.height === Number(expectBeaconHeight), `transcript ${t.beacon?.height}, announced ${expectBeaconHeight}`);
  else skip("announced beacon height", `compare ${t.beacon?.height} with the height announced before the ceremony (--expect-beacon-height)`);
  // Contributions in the final key: all of them, or the first final.contributions when finalize dropped late ones.
  const used = Number.isSafeInteger(t.final.contributions) ? t.final.contributions : list.length;
  const excluded = list.slice(used).map((c) => c.index);
  const excludedOk = used >= 1 && used <= list.length && JSON.stringify(t.final.excluded ?? []) === JSON.stringify(excluded);
  check("contributions used", excludedOk, excluded.length ? `the first ${used} of ${list.length}; #${excluded.join(", #")} excluded (${t.final.excludedReason ?? "no reason given"})` : `all ${list.length}`);
  if (!excludedOk) return done();

  // Pins.
  const testRun = t.pinned === false;
  if (testRun && !allowUnpinned) check("pinned circuit", false, "the transcript says it is an unpinned rehearsal (pass --unpinned to check it anyway)");
  if (!testRun) {
    check("pinned r1cs", t.circuit?.r1csSha256 === PINNED.r1csSha256, `transcript r1cs ${t.circuit?.r1csSha256}`);
    check("pinned ptau", t.ptau?.sha256 === PINNED.ptau.sha256, `transcript ptau ${t.ptau?.name} ${t.ptau?.sha256}`);
  }
  const r1csSha = sha256Hex(readFileSync(requireFile(r1csPath, "r1cs")));
  const ptauSha = sha256Hex(readFileSync(requireFile(ptauPath, "ptau")));
  check("local r1cs", r1csSha === t.circuit?.r1csSha256, `${r1csPath} sha256 ${r1csSha}`);
  check("local ptau", ptauSha === t.ptau?.sha256, `${ptauPath} sha256 ${ptauSha}`);
  if (r1csSha !== t.circuit?.r1csSha256 || ptauSha !== t.ptau?.sha256) return done();

  // Initial key, recomputed.
  const init = await newInitialZkey(r1csPath, ptauPath);
  check("initial key", sha256Hex(init) === t.initial?.zkeySha256, `zkey new sha256 ${sha256Hex(init)}`);

  // Transcript-internal linkage and the intermediate keys when given.
  let prev = t.initial?.zkeySha256;
  let linked = true;
  for (const c of list) {
    if (c.prevZkeySha256 !== prev) linked = false;
    prev = c.zkeySha256;
  }
  check("transcript linkage", linked, "each contribution builds on the key before it");
  if (zkeysDir) {
    const bad = [];
    for (const c of list) {
      const f = join(zkeysDir, zkeyName(c.index));
      if (!existsSync(f) || sha256Hex(readFileSync(f)) !== c.zkeySha256) bad.push(zkeyName(c.index));
    }
    check("intermediate keys", bad.length === 0, bad.length ? `missing or different: ${bad.join(", ")}` : `${list.length} keys match the transcript`);
  }

  // The final key.
  const zkey = new Uint8Array(readFileSync(requireFile(zkeyPath, "final zkey")));
  check("final key hash", sha256Hex(zkey) === t.final.zkeySha256, `sha256 ${sha256Hex(zkey)}`);
  const v = await verifyFromInit(init, ptauPath, zkey);
  check("zkey verify", v.ok, v.ok ? "snarkjs verifyFromInit: every contribution is valid" : v.reason);
  if (!v.ok) return done();
  const { contributions } = await readContributions(zkey);
  const n = used;
  const sameList = contributions.length === n + 1 && list.slice(0, n).every((c, i) => contributions[i].contributionHash === c.contributionHash && contributions[i].name === c.name && contributions[i].type === 0);
  check("contribution hashes", sameList, sameList ? `${n} contributions, in transcript order` : "the key's contribution list differs from the transcript");
  const b = contributions.at(-1);
  const beaconOk = contributions.length === n + 1 && b.type === 1 && b.beaconHash === t.final.beaconBlockHash
    && b.numIterationsExp === ITERATIONS_EXP && t.beacon?.iterationsExp === ITERATIONS_EXP && b.contributionHash === t.final.beaconContributionHash;
  check("beacon contribution", beaconOk, beaconOk ? `block hash ${b.beaconHash}, 2^${b.numIterationsExp} iterations` : "missing, or not made with the published block hash");

  // The beacon block.
  const H = t.beacon?.height;
  const network = t.beacon?.network ?? "mainnet";
  // The coordinator's own record (it writes both the close and each entry's tip): it means
  // something only together with a close commitment that was published before block H.
  const closeBefore = Number.isSafeInteger(t.beacon?.closeBeforeHeight) ? t.beacon.closeBeforeHeight : H - 6;
  const closedBelow = Number.isSafeInteger(t.closed?.tipHeight) && t.closed.tipHeight < H;
  const entriesBelow = list.slice(0, n).every((c) => Number.isSafeInteger(c.tipHeight) && c.tipHeight < closeBefore);
  check("closed before the beacon", closedBelow || entriesBelow,
    `${closedBelow ? `closed at tip ${t.closed.tipHeight}` : `every contribution used was accepted at a recorded tip below ${closeBefore}`}, beacon height ${H}: the coordinator's own statement; it rules out a last contributor who saw block ${H} only with the close commitment published before that block`);
  const commitment = closeCommitmentOf({ ...t, contributions: list });
  if (t.closed?.commitment !== undefined) check("close commitment recorded", t.closed.commitment === commitment.commitment, `transcript.closed.commitment ${t.closed.commitment}; recomputed ${commitment.commitment}`);
  if (expectCloseCommitment !== null) {
    check("close commitment", String(expectCloseCommitment).trim().toLowerCase() === commitment.commitment, `recomputed ${commitment.commitment} (${list.length} contributions); published ${String(expectCloseCommitment).trim()}`);
  } else {
    skip("close commitment", `compare ${commitment.commitment} with the commitment published before block ${H} (--expect-close-commitment); without one, the beacon does not rule out a last contribution made after block ${H} was known`);
  }
  if (t.final.beaconHeader) {
    try {
      const h = await checkBeaconHeader({ header: t.final.beaconHeader, hash: t.final.beaconBlockHash, network, height: H });
      check("beacon header", true, `hashes to the block hash and meets ${h.bounds !== null && h.bounds !== undefined ? `the difficulty bounds from pinned checkpoint ${h.bounds}` : "its own proof-of-work target"} (${h.checkedBy}); a header alone does not show the block is on the chain: see the next check`);
    } catch (e) {
      check("beacon header", false, e.message);
    }
  } else check("beacon header", false, "transcript.final.beaconHeader is missing");
  if (source) {
    try {
      const blk = await readBeaconBlock(source, H, network);
      check("beacon block on chain", blk.hash === t.final.beaconBlockHash, `${source.describe} serves ${blk.hash} at ${H}`);
    } catch (e) {
      check("beacon block on chain", false, e.message);
    }
  } else skip("beacon block on chain", `not looked up (offline); check that Bitcoin ${network} block ${H} is ${t.final.beaconBlockHash}`);

  // Verification key and manifest.
  const vkeyBytes = await exportVkeyBytes(zkey);
  check("verification key", sha256Hex(vkeyBytes) === t.final.vkeySha256, `exported vkey sha256 ${sha256Hex(vkeyBytes)}`);
  if (vkeyPath) check("vkey file", sha256Hex(readFileSync(vkeyPath)) === t.final.vkeySha256, vkeyPath);
  if (manifestPath) {
    const bytes = readFileSync(manifestPath);
    const m = JSON.parse(bytes.toString("utf8"));
    const ok = sha256Hex(bytes) === t.final.manifestSha256 && m.sha256?.zkey === t.final.zkeySha256 && m.sha256?.vkey === t.final.vkeySha256
      && m.ceremony?.transcriptSha256 === contributionsTranscriptSha256(t) && m.ceremony?.contributions === used;
    check("manifest", ok, ok ? `sha256 ${t.final.manifestSha256}` : "the manifest does not match the transcript");
  }
  if (!testRun && network === "mainnet" && existsSync(pinsPath)) {
    const pins = JSON.parse(readFileSync(pinsPath, "utf8"));
    if (pins.artifacts?.vkey) {
      const ok = pins.artifacts.vkey === t.final.vkeySha256 && pins.artifacts.zkey === t.final.zkeySha256 && pins.manifestSha256 === t.final.manifestSha256;
      check("mainnet pins", ok, ok ? "src/pins.mainnet.json pins this ceremony's key" : "src/pins.mainnet.json pins a different key");
    } else skip("mainnet pins", "src/pins.mainnet.json does not pin a key yet");
  }

  if (expectHash !== null) {
    const h = normalizeHash(expectHash);
    const hit = h && list.find((c) => c.contributionHash === h);
    check("your contribution", !!hit, hit ? `#${hit.index} by ${JSON.stringify(hit.name)}` : "not in the transcript");
  }
  return done();
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ["unpinned", "json"] });
  if (!a.transcript || !a.zkey) throw new Error("--transcript and --zkey are required");
  const transcript = await loadTranscript(a.transcript);
  const network = transcript?.beacon?.network ?? "mainnet";
  if (!GENESIS_HASH[network]) throw new Error(`unknown beacon network ${network}`);
  const kind = a.beaconSource ?? "esplora";
  const source = kind === "none" ? null : await openBeaconSource({ kind, network, esplora: a.esplora ?? null });
  const r = await verifyCeremony({
    transcript,
    zkeyPath: a.zkey,
    r1csPath: resolve(a.r1cs ?? join(ROOT, DEFAULT_PATHS.r1cs)),
    ptauPath: resolve(a.ptau ?? join(ROOT, DEFAULT_PATHS.ptau)),
    expectHash: a.expectHash ?? null,
    source,
    zkeysDir: a.zkeysDir ?? null,
    vkeyPath: a.vkey ?? null,
    manifestPath: a.manifest ?? null,
    allowUnpinned: !!a.unpinned,
    expectCeremonyId: a.expectCeremonyId ?? null,
    expectBeaconHeight: a.expectBeaconHeight ?? null,
    expectCloseCommitment: a.expectCloseCommitment ?? null,
  });
  if (a.json) console.log(JSON.stringify(r));
  else {
    for (const c of r.checks) console.log(`${c.status.padEnd(4)} ${c.name}${c.detail ? `: ${c.detail}` : ""}`);
    console.log(r.ok ? `\nceremony ${transcript.ceremony}: every check holds` : `\nceremony ${transcript.ceremony}: VERIFICATION FAILED`);
  }
  return r.ok ? 0 : 1;
}

if (isMain(import.meta.url)) runMain(main);

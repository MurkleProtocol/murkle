#!/usr/bin/env node
// Prepares the files of a GitHub release that carries the pinned circuit artifacts: copies
// manifest.json, verification_key.json, transaction.wasm and transaction.zkey from build/
// into an output directory OUTSIDE the repository, checks each against src/pins.json, and
// writes SHA256SUMS and RELEASE-NOTES.md next to them. It uploads nothing.
//
// Usage: node scripts/release-assets.mjs --out <dir>      (npm run release:assets -- --out <dir>)
//   --out <dir>   where to put the files (or MURKLE_RELEASE_DIR); refused when inside the repository.
//                 Default: <os tmpdir>/murkle-release-assets
//
// Then attach every file in <dir> to a release whose tag is printed (DEFAULT_TAG), so that
// `npm run artifacts:fetch` finds them once REPO_URL is set (PUBLISHING.md).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { GENESIS_TXID, ACTIVATION_HEIGHT } from "../src/params.mjs";
import { DEFAULT_TAG, PINNED_ARTIFACTS, ROOT, checkFile, sha256sums } from "./artifacts-lib.mjs";

export function outDirFrom(argv, env = process.env) {
  const i = argv.indexOf("--out");
  const eq = argv.find((a) => a.startsWith("--out="));
  const raw = eq ? eq.slice(6) : i >= 0 ? argv[i + 1] : env.MURKLE_RELEASE_DIR || join(tmpdir(), "murkle-release-assets");
  if (!raw || raw.startsWith("--")) throw new Error("--out needs a directory");
  const out = resolve(raw);
  const rel = relative(ROOT, out);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new Error(`refusing to write release assets inside the repository (${out}); pick a directory outside it`);
  }
  return out;
}

export function releaseNotes({ tag = DEFAULT_TAG, license = null } = {}) {
  const rows = PINNED_ARTIFACTS.map((a) => `| \`${a.name}\` | \`${a.path}\` | \`${a.sha256}\` |`).join("\n");
  return `# Pinned circuit artifacts (${tag})

These are the proving and verification artifacts pinned by sha256 in \`src/pins.json\` and anchored on signet by the genesis ATTEST transaction \`${GENESIS_TXID ?? "(not pinned)"}\` (activation height ${ACTIVATION_HEIGHT ?? "(not pinned)"}).

| File | Path in a checkout | sha256 |
|---|---|---|
${rows}

Fetch and verify them in a clone with \`npm run artifacts:fetch\` (or \`sha256sum -c SHA256SUMS\` after a manual download). Every client checks them against the pins, so this download source does not need to be trusted.

- \`transaction.zkey\` comes from a DEV single-party phase-2 contribution (audit A-8). It cannot be rebuilt bit for bit, which is why it is published here; whoever made it could forge proofs until a public ceremony replaces it.
- \`transaction.wasm\`, the r1cs it implies and \`verification_key.json\` can be checked against the circuit sources of this repository (README, "Reproduce the circuit").
- The circuit includes circomlib (GPL-3.0-or-later), so these compiled artifacts are distributed under GPL-3.0-or-later terms${license ? ` (the repository is licensed ${license})` : ""}; their corresponding source is \`circuits/\` at the tagged commit plus circomlib 2.0.5 (see THIRD_PARTY_NOTICES.md).
`;
}

function main() {
  const out = outDirFrom(process.argv.slice(2));
  const problems = [];
  for (const a of PINNED_ARTIFACTS) {
    const r = checkFile(join(ROOT, a.path), a.sha256);
    if (!r.ok) problems.push(r.actual ? `${a.path}: sha256 ${r.actual} does not match the pin ${a.sha256}` : `${a.path}: missing`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`REFUSED  ${p}`);
    console.error("Nothing was copied. The release must carry exactly the pinned files.");
    return 1;
  }
  mkdirSync(out, { recursive: true });
  for (const a of PINNED_ARTIFACTS) {
    const target = join(out, a.name);
    copyFileSync(join(ROOT, a.path), target);
    if (!checkFile(target, a.sha256).ok) throw new Error(`${target}: the copy does not match the pin`);
    console.log(`copied   ${a.path} -> ${a.name}`);
  }
  let license = null;
  try {
    license = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).license ?? null;
  } catch {
    license = null;
  }
  writeFileSync(join(out, "SHA256SUMS"), sha256sums());
  writeFileSync(join(out, "RELEASE-NOTES.md"), releaseNotes({ license }));
  console.log(`wrote    SHA256SUMS, RELEASE-NOTES.md`);
  console.log(`\nRelease assets are in ${out}`);
  console.log(`Release tag: ${DEFAULT_TAG} (npm run artifacts:fetch looks for this tag under REPO_URL)`);
  return 0;
}

function isMain() {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? entry.toLowerCase() === self.toLowerCase() : entry === self;
}

if (isMain()) {
  try {
    process.exit(main());
  } catch (e) {
    console.error(`error: ${e.message}`);
    process.exit(1);
  }
}

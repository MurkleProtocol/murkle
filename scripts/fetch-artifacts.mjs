#!/usr/bin/env node
// Downloads the pinned circuit artifacts (manifest, verification key, wasm, zkey) and writes
// them where the indexer, the CLI and the tests load them (build/...). Every file is checked
// against src/pins.json before anything is written; one mismatch and nothing is written, so
// the download source never has to be trusted.
//
// Usage: node scripts/fetch-artifacts.mjs [--from <url | directory>] [--dest <dir>] [--force] [--check] [--quiet]
//   (npm run artifacts:fetch -- --from <url>)
//
// Source, first one set wins:
//   --from <url | dir>        a base URL or a local directory holding the four files
//   MURKLE_ARTIFACTS_URL      the same, from the environment (CI sets it from a repository variable)
//   REPO_URL in src/params.mjs, when it is a GitHub repository:
//                             <REPO_URL>/releases/download/<tag>/, tag = MURKLE_ARTIFACTS_TAG
//                             or "artifacts-" + the first 12 hex characters of manifestSha256
// A base is either a prefix ("https://site.example/artifacts", "<release download URL>") to
// which "/<name>" is appended, or a template containing "{name}" (and optionally "{tag}").
// Any running Murkle site or indexer serves the files at <origin>/artifacts/<name>.
//
//   --dest <dir>  write under this directory instead of the repository root (tests use a temp dir)
//   --force       download again even when a file on disk already matches its pin
//   --check       no network: report each file on disk against its pin; exit 1 if any is missing or differs
//   --quiet       print only problems
//
// Exit codes: 0 every file present and matching; 1 a download failed or a hash differed
// (nothing written); 2 usage error or no source configured.
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PINS_FILE, REPO_URL } from "../src/params.mjs";
import { DEFAULT_TAG, MAX_ARTIFACT_BYTES, PINNED_ARTIFACTS, ROOT, checkFile, sha256 } from "./artifacts-lib.mjs";

export class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { from: null, dest: ROOT, force: false, check: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "--from") opts.from = value();
    else if (a.startsWith("--from=")) opts.from = a.slice(7);
    else if (a === "--dest") opts.dest = resolve(value());
    else if (a.startsWith("--dest=")) opts.dest = resolve(a.slice(7));
    else if (a === "--force") opts.force = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--quiet") opts.quiet = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new UsageError(`unknown argument ${a}`);
  }
  return opts;
}

/** The configured source, or null: --from, then MURKLE_ARTIFACTS_URL, then the GitHub release of REPO_URL. */
export function resolveSource({ from = null, env = process.env, repoUrl = REPO_URL, tag = env.MURKLE_ARTIFACTS_TAG || DEFAULT_TAG } = {}) {
  if (from) return from;
  if (env.MURKLE_ARTIFACTS_URL) return env.MURKLE_ARTIFACTS_URL;
  if (repoUrl && tag && /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/.test(repoUrl.replace(/\/+$/, ""))) {
    return `${repoUrl.replace(/\/+$/, "")}/releases/download/${tag}`;
  }
  return null;
}

const isUrl = (s) => /^https?:\/\//i.test(s);

/** Where one artifact comes from: a URL, or a file path for a local directory source. */
export function locate(source, name, tag = process.env.MURKLE_ARTIFACTS_TAG || DEFAULT_TAG) {
  if (source.includes("{name}")) return source.replaceAll("{name}", name).replaceAll("{tag}", tag ?? "");
  if (isUrl(source)) return `${source.replace(/\/+$/, "")}/${name}`;
  return join(source.startsWith("file://") ? fileURLToPath(source) : source, name);
}

async function readSource(where) {
  if (!isUrl(where)) {
    if (!existsSync(where)) throw new Error(`not found: ${where}`);
    const size = statSync(where).size;
    if (size > MAX_ARTIFACT_BYTES) throw new Error(`larger than ${MAX_ARTIFACT_BYTES} bytes`);
    return readFileSync(where);
  }
  const res = await fetch(where, { redirect: "follow", signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_ARTIFACT_BYTES) throw new Error(`larger than ${MAX_ARTIFACT_BYTES} bytes`);
  const parts = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_ARTIFACT_BYTES) throw new Error(`larger than ${MAX_ARTIFACT_BYTES} bytes`);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

/** Reports each pinned file under `dest`: [{ name, path, ok, actual }]. */
export function checkAll(dest = ROOT, artifacts = PINNED_ARTIFACTS) {
  return artifacts.map((a) => ({ ...a, ...checkFile(join(dest, a.path), a.sha256) }));
}

/**
 * Downloads every artifact not already present and matching, verifies all of them, then
 * writes them (each through a .part file and a rename). Returns { ok, written, kept, problems }.
 */
export async function fetchArtifacts({ source, dest = ROOT, force = false, artifacts = PINNED_ARTIFACTS, read = readSource, log = () => {} }) {
  const problems = [];
  const fetched = [];
  const kept = [];
  for (const a of artifacts) {
    if (!a.sha256) {
      problems.push(`${a.name}: ${PINS_FILE} pins no hash for it, so there is nothing to check a download against`);
      continue;
    }
    const target = join(dest, a.path);
    if (!force && checkFile(target, a.sha256).ok) {
      kept.push(a.name);
      log(`ok       ${a.name} (already present, matches the pin)`);
      continue;
    }
    const where = locate(source, a.name);
    let bytes;
    try {
      bytes = await read(where);
    } catch (e) {
      problems.push(`${a.name}: download failed from ${where}: ${e.message}`);
      continue;
    }
    const actual = sha256(bytes);
    if (actual !== a.sha256) {
      problems.push(`${a.name}: sha256 ${actual} does not match the pin ${a.sha256} (source ${where})`);
      continue;
    }
    fetched.push({ a, bytes, target });
    log(`verified ${a.name} (${bytes.length.toLocaleString("en-US")} bytes, sha256 matches src/pins.json)`);
  }
  if (problems.length) return { ok: false, written: [], kept, problems };
  for (const { a, bytes, target } of fetched) {
    mkdirSync(dirname(target), { recursive: true });
    const part = `${target}.part`;
    try {
      writeFileSync(part, bytes);
      renameSync(part, target);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
    log(`wrote    ${a.path}`);
  }
  return { ok: true, written: fetched.map(({ a }) => a.name), kept, problems };
}

const HELP = `Usage: node scripts/fetch-artifacts.mjs [--from <url | directory>] [--dest <dir>] [--force] [--check] [--quiet]
Downloads the pinned circuit artifacts and checks each against src/pins.json before writing.
Source: --from, else MURKLE_ARTIFACTS_URL, else the GitHub release of REPO_URL (src/params.mjs).
Examples:
  npm run artifacts:fetch -- --from https://<a Murkle site>/artifacts
  npm run artifacts:fetch -- --from https://github.com/<owner>/<repo>/releases/download/${DEFAULT_TAG ?? "<tag>"}
  npm run artifacts:check`;

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`error: ${e.message}\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const say = opts.quiet ? () => {} : (l) => console.log(l);
  if (opts.check) {
    const rows = checkAll(opts.dest);
    for (const r of rows) {
      if (r.ok) say(`ok       ${r.path}`);
      else if (!r.sha256) console.error(`UNPINNED ${r.path}: ${PINS_FILE} pins no hash for it yet`);
      else console.error(r.actual ? `DIFFERS  ${r.path}: sha256 ${r.actual}, pinned ${r.sha256}` : `MISSING  ${r.path}`);
    }
    if (rows.every((r) => r.ok)) return 0;
    if (rows.some((r) => !r.sha256)) {
      console.error(`${PINS_FILE} does not pin every artifact yet: on mainnet the public ceremony installs them (docs/CEREMONY.md, docs/MAINNET.md G1-G2).`);
      return 1;
    }
    console.error("Fetch the pinned files with: npm run artifacts:fetch -- --from <url>");
    return 1;
  }
  const source = resolveSource({ from: opts.from });
  if (!source) {
    if (checkAll(opts.dest).every((r) => r.ok) && !opts.force) {
      say("All pinned artifacts are present and match src/pins.json; nothing to fetch.");
      return 0;
    }
    console.error(`error: no artifact source configured.\n${HELP}`);
    return 2;
  }
  if (!isAbsolute(opts.dest)) opts.dest = resolve(opts.dest);
  say(`source   ${source}`);
  const out = await fetchArtifacts({ source, dest: opts.dest, force: opts.force, log: say });
  if (!out.ok) {
    for (const p of out.problems) console.error(`REFUSED  ${p}`);
    console.error("Nothing was written. Use another source, or check that it serves the files pinned in src/pins.json.");
    return 1;
  }
  say(out.written.length ? `done: ${out.written.length} written, ${out.kept.length} already present` : "done: every file was already present");
  return 0;
}

/** True when this file is the process entry point (not imported by a test). */
function isMain() {
  const entry = process.argv[1] ? resolve(process.argv[1]) : "";
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? entry.toLowerCase() === self.toLowerCase() : entry === self;
}

// Set exitCode instead of calling process.exit(): after a failed download, fetch handles may
// still be closing, and exiting under them aborts Node on Windows (libuv assertion, wrong code).
if (isMain()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`error: ${e.message}`);
      process.exitCode = 1;
    },
  );
}

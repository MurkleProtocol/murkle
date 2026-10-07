#!/usr/bin/env node
// Writes the facts file of this network: the numbers the landing page, the footer and /security show.
// Facts are read from the repo at build time so the site never hardcodes a count that drifts.
// Every missing input becomes null, which the UI renders as "—".
//
// The network is MURKLE_NETWORK (src/params.mjs; default signet). Signet writes web/src/facts.json
// from the signet pins and the DEV artifacts, exactly as before; mainnet writes
// web/src/facts.mainnet.json from src/pins.mainnet.json and build/mainnet/*, and a mainnet web
// build reads that file instead (web/vite.config.mjs), so a mainnet build never rewrites the
// signet facts.
//
// Inputs (all optional; paths per network from src/params.mjs NETWORKS):
//   build/manifest.json | build/mainnet/manifest.json     circuit manifest (mainnet: from the ceremony)
//   src/pins.json | src/pins.mainnet.json                 pinned artifact hashes and the genesis anchor
//   build/transaction.r1cs                  constraint count (header section), if no manifest
//   verification key, zkey and build/transaction_js/transaction.wasm   sha256 and size of the served artifacts
//   test/*.test.mjs                         static count of test( calls
//   audit/REPORT.md                         the findings table and the circomspect heading
//
// Usage: node scripts/facts.mjs [--out path] [--root dir] [--network signet|mainnet] [--check]
//   --check  exits 1 when the written facts would differ from the file on disk (for CI)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync, openSync, readSync, closeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORK, NETWORKS, resolveNetwork } from "../src/params.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

function fileFact(p) {
  if (!existsSync(p)) return { sha256: null, bytes: null };
  const buf = readFileSync(p);
  return { sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

/** Number of constraints from the r1cs header section (type 1), reading only what it needs. */
export function r1csConstraints(path) {
  if (!existsSync(path)) return null;
  const fd = openSync(path, "r");
  try {
    const read = (pos, len) => {
      const b = Buffer.alloc(len);
      const n = readSync(fd, b, 0, len, pos);
      if (n !== len) throw new Error("truncated r1cs");
      return b;
    };
    const head = read(0, 12);
    if (head.toString("latin1", 0, 4) !== "r1cs") return null;
    const nSections = head.readUInt32LE(8);
    let pos = 12;
    for (let i = 0; i < nSections; i++) {
      const sh = read(pos, 12);
      const type = sh.readUInt32LE(0);
      const size = Number(sh.readBigUInt64LE(4));
      pos += 12;
      if (type === 1) {
        const fieldSize = read(pos, 4).readUInt32LE(0);
        // fieldSize, prime, nWires, nPubOut, nPubIn, nPrvIn (u32 each), nLabels (u64), nConstraints (u32)
        const off = pos + 4 + fieldSize + 16 + 8;
        return read(off, 4).readUInt32LE(0);
      }
      pos += size;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Static count of `test(` calls in test/*.test.mjs (not `.test(` method calls such as regex.test). */
export function countTests(dir) {
  if (!existsSync(dir)) return null;
  let n = 0;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".test.mjs")).sort()) {
    const src = readFileSync(join(dir, f), "utf8");
    n += (src.match(/(^|[^.\w$])test\s*\(/gm) ?? []).length;
  }
  return n;
}

const clean = (s) =>
  s
    .replace(/\*\*/g, "")
    .replace(/`/g, "")
    .replace(/\\\|/g, "|")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Parses the "| ID | Severity | Location | Description | Status |" tables of audit/REPORT.md
 * (A-, W-, R- ids, and V2- ids of internal audit v2). A status that starts with "open" is open,
 * one that says "partially fixed" is partial, and neither counts as fixed.
 */
export function auditFacts(md) {
  if (!md) return null;
  const findings = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([A-Z]\d*-\d+)\s*\|(.*)\|\s*$/);
    if (!m) continue;
    const cells = m[2].split(/(?<!\\)\|/).map((c) => c.trim());
    if (cells.length < 4) continue;
    const [sevRaw, location, desc, statusRaw] = [cells[0], cells[1], cells.slice(2, -1).join(" | "), cells[cells.length - 1]];
    const sevWord = clean(sevRaw).match(/^(Critical|High|Medium|Low|Info)/i)?.[1] ?? "Info";
    const severity = sevWord[0].toUpperCase() + sevWord.slice(1).toLowerCase();
    const bold = desc.match(/\*\*(.+?)\*\*/);
    let title = bold ? clean(bold[1]) : clean(desc).split(/(?<=\.)\s/)[0];
    title = title.replace(/\.$/, "");
    const status = clean(statusRaw);
    const open = /^open\b/i.test(status);
    const partial = !open && /\bpartially fixed\b/i.test(status);
    const fixed = !open && !partial && /\bfixed\b/i.test(status) && !/\bnot fixed\b/i.test(status);
    findings.push({
      id: m[1],
      severity,
      severityNote: clean(sevRaw) === severity ? null : clean(sevRaw),
      location: clean(location),
      title,
      description: clean(desc),
      status,
      state: open ? "open" : partial ? "partial" : fixed ? "fixed" : /regression test|\btested\b/i.test(status) ? "tested" : "documented",
    });
  }
  const bySeverity = {};
  for (const f of findings) bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
  const circom = md.match(/circomspect:\s*(\d+)\s+findings?/i);
  return {
    total: findings.length,
    bySeverity,
    fixed: findings.filter((f) => f.state === "fixed").length,
    partial: findings.filter((f) => f.state === "partial").length,
    open: findings.filter((f) => f.state === "open").length,
    mediumFixed: findings.filter((f) => f.severity === "Medium" && f.state === "fixed").length,
    circomspectFindings: circom ? Number(circom[1]) : null,
    findings,
  };
}

/** Default output of a network: signet keeps web/src/facts.json; mainnet has its own file. */
export function factsFile(root, network = NETWORK) {
  return join(root, "web", "src", network === "signet" ? "facts.json" : `facts.${network}.json`);
}

/** The manifest's ceremony block, reduced to what /security shows (mainnet; null without one). */
function ceremonyFacts(c) {
  if (!c || typeof c !== "object") return null;
  return {
    id: typeof c.id === "string" ? c.id : null,
    contributions: Number.isInteger(c.contributions) ? c.contributions : null,
    beacon: c.beacon && Number.isInteger(c.beacon.height) ? { height: c.beacon.height } : null,
  };
}

export function buildFacts(root, { network = NETWORK } = {}) {
  const net = NETWORKS[resolveNetwork(network)];
  const p = (...xs) => join(root, ...xs);
  const rel = (path) => p(...path.split("/"));
  const manifest = readJson(rel(net.artifacts.manifest));
  const pins = readJson(rel(net.pinsFile));
  const constraints = manifest?.constraints ?? r1csConstraints(p("build", "transaction.r1cs"));
  const art = {
    vkey: { file: "verification_key.json", ...fileFact(rel(net.artifacts.vkey)), pinned: pins?.artifacts?.vkey ?? null },
    zkey: { file: "transaction.zkey", ...fileFact(rel(net.artifacts.zkey)), pinned: pins?.artifacts?.zkey ?? null },
    wasm: { file: "transaction.wasm", ...fileFact(rel(net.artifacts.wasm)), pinned: pins?.artifacts?.wasm ?? null },
  };
  for (const a of Object.values(art)) a.matchesPin = a.sha256 && a.pinned ? a.sha256 === a.pinned : null;
  const md = existsSync(p("audit", "REPORT.md")) ? readFileSync(p("audit", "REPORT.md"), "utf8") : null;
  return {
    schema: 1,
    // Signet facts keep their historical shape; another network names itself.
    ...(net.name === "signet" ? {} : { network: net.name }),
    testCount: countTests(p("test")),
    circuit: {
      constraints: constraints ?? null,
      proofSystem: "Groth16",
      curve: "BN254",
      hash: "Poseidon",
      treeDepth: 32,
      inputs: 2,
      outputs: 2,
      circom: manifest?.circom ?? null,
      setup: manifest?.setup ?? null,
      gitCommit: manifest?.gitCommit ?? null,
    },
    manifest: {
      sha256: pins?.manifestSha256 ?? null,
      present: !!manifest,
      // Mainnet only: the public ceremony behind the pinned keys (signet's DEV manifest has none).
      ...(manifest?.ceremony ? { ceremony: ceremonyFacts(manifest.ceremony) } : {}),
    },
    artifacts: art,
    genesis: {
      txid: pins?.genesisTxid ?? null,
      height: pins?.activationHeight ?? null,
    },
    audit: auditFacts(md),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(arg("--root", join(here, "..")));
  const network = resolveNetwork(arg("--network", NETWORK));
  const out = resolve(arg("--out", factsFile(root, network)));
  const facts = buildFacts(root, { network });
  const text = JSON.stringify(facts, null, 2) + "\n";
  if (process.argv.includes("--check")) {
    const prev = existsSync(out) ? readFileSync(out, "utf8") : "";
    if (prev !== text) {
      console.error(`facts: ${out} is stale; run node scripts/facts.mjs`);
      process.exit(1);
    }
    console.log("facts: up to date");
  } else {
    writeFileSync(out, text);
    const a = facts.audit;
    console.log(
      `facts: ${facts.testCount ?? "-"} tests, ${facts.circuit.constraints ?? "-"} constraints, ` +
        `${a ? `${a.total} findings` : "no audit table"}, ${network} genesis ${facts.genesis.txid ? "pinned" : "not pinned"} -> ${out}`,
    );
  }
}

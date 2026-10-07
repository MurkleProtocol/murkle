#!/usr/bin/env node
// Contribute to the Murkle phase-2 ceremony from the command line (docs/CEREMONY.md).
//
// Online (join, wait, download, contribute, upload, print the receipt):
//   node scripts/ceremony/contribute.mjs --coordinator https://example.org --name alice
//     [--entropy-text "anything"] [--out my.zkey] [--receipt receipt.json] [--json]
//
// Air-gapped, in three steps within one slot:
//   1. --coordinator URL --name alice --join-only --download prev.zkey --pass-file pass.txt
//      waits for the slot (keep it running), downloads the key and writes the queue pass (0600)
//   2. --in prev.zkey --out next.zkey --name alice          (on the offline machine; also writes
//      next.zkey.contribution-hash, the hash snarkjs computed there)
//   3. --upload next.zkey --coordinator URL --pass-file pass.txt [--expect-hash <hash>] [--receipt receipt.json]
//      the receipt must carry the hash from step 2 (--expect-hash, else the .contribution-hash file
//      next to the key) and the sha256 of the uploaded key, or the command fails
//
// Entropy: 64 bytes from the operating system's random generator (plus --entropy-text), and
// snarkjs adds 64 more. It is never written anywhere. The machine must not be compromised
// while the contribution runs.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as snarkjs from "snarkjs";
import { CeremonyClient, sha256Hex } from "../../web/src/ceremony/client.js";
import { contributeZkey, freshEntropy } from "../../web/src/ceremony/core.js";
import { checkReceipt, formatHash, receiptText } from "../../web/src/ceremony/receipt.js";
import { cleanName, isMain, parseArgs, requireFile, runMain, writeFileAtomic } from "./lib.mjs";

const say = (log, s) => log?.(s);

/** Join and wait until the slot is ours. -> { pass, turn } */
export async function joinAndWait(client, name, { log = console.log, pollMs = null, signal = null } = {}) {
  const j = await client.join(name);
  say(log, `joined as "${name}"; ${j.position === 0 ? "you are next" : `${j.position} ahead of you`}`);
  let last = null;
  const turn = await client.waitForTurn(j.pass, {
    pollMs,
    signal,
    onUpdate: (u) => {
      if (u.state === "waiting" && u.position !== last) say(log, `waiting: ${u.position} ahead of you`);
      last = u.position;
    },
  });
  say(log, `your slot is open: build on key #${turn.base.index}; upload before ${turn.deadline}`);
  return { pass: j.pass, turn };
}

/** Contribute to a key in memory. -> { zkey, contributionHash } */
export async function contributeBytes(prev, name, extraText = "", { log = console.log } = {}) {
  let entropy = freshEntropy(extraText);
  try {
    return await contributeZkey(snarkjs, prev, { name, entropy, onLog: (m) => /Contribution Hash/i.test(m) || say(log, `  ${m}`) });
  } finally {
    entropy = null;
  }
}

/**
 * Upload and check the receipt against what is known locally: the contribution hash (a string or
 * { contributionHash, prevZkeySha256 }) and always the sha256 of the bytes uploaded.
 */
export async function uploadAndCheck(client, pass, zkey, local = null) {
  const mine = typeof local === "string" ? { contributionHash: local } : { ...(local ?? {}) };
  mine.zkeySha256 = await sha256Hex(zkey);
  const receipt = await client.upload(pass, zkey);
  const check = checkReceipt(receipt, mine);
  if (!check.ok) throw new Error(`receipt problem: ${check.problems.join("; ")}`);
  return receipt;
}

/** The whole online flow. -> { receipt, contributionHash, zkey } */
export async function contributeOnline({ coordinator, name, extraText = "", fetch = globalThis.fetch, log = console.log, pollMs = null }) {
  const n = cleanName(name);
  if (!n) throw new Error("--name must be 1-64 printable ASCII characters");
  const client = new CeremonyClient(coordinator, { fetch });
  const { pass, turn } = await joinAndWait(client, n, { log, pollMs });
  say(log, `downloading ${turn.base.url} (${turn.base.bytes} bytes)`);
  const prev = await client.download(turn.base.url, { expectSha256: turn.base.zkeySha256 });
  say(log, "contributing (this takes a while on the real circuit)");
  const { zkey, contributionHash } = await contributeBytes(prev, n, extraText, { log });
  say(log, `uploading ${zkey.length} bytes; the coordinator verifies it before answering`);
  const receipt = await uploadAndCheck(client, pass, zkey, { contributionHash, prevZkeySha256: turn.base.zkeySha256 });
  return { receipt, contributionHash, zkey };
}

function printReceipt(receipt, a, coordinator) {
  if (a.receipt) writeFileAtomic(a.receipt, JSON.stringify(receipt, null, 2) + "\n");
  if (a.json) console.log(JSON.stringify(receipt));
  else console.log("\n" + receiptText(receipt, { origin: coordinator ?? "" }));
}

async function main(argv) {
  const a = parseArgs(argv, { flags: ["json", "joinOnly"] });
  const log = a.json ? (s) => console.error(s) : (s) => console.log(s);

  if (a.in || (a.out && !a.coordinator)) {
    // Offline contribution.
    const name = cleanName(a.name);
    if (!name) throw new Error("--name must be the name you joined with (1-64 printable ASCII characters)");
    if (!a.out) throw new Error("--out is required");
    if (existsSync(a.out)) throw new Error(`${a.out} exists; choose a new file`);
    const prev = new Uint8Array(readFileSync(requireFile(a.in, "--in key")));
    const { zkey, contributionHash } = await contributeBytes(prev, name, a.entropyText ?? "", { log });
    writeFileSync(a.out, zkey);
    writeFileSync(`${a.out}.contribution-hash`, contributionHash + "\n");
    if (a.json) console.log(JSON.stringify({ out: a.out, contributionHash }));
    else console.log(`\nwrote ${a.out}\ncontribution hash:\n${formatHash(contributionHash)}\nUpload it with --upload ${a.out} --pass-file <file> before your slot's deadline.`);
    return 0;
  }

  if (!a.coordinator) throw new Error("--coordinator <url> is required (or --in/--out for an offline contribution)");
  const client = new CeremonyClient(a.coordinator);

  if (a.upload) {
    const pass = readFileSync(requireFile(a.passFile, "--pass-file")).toString("utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(pass)) throw new Error("--pass-file does not hold a queue pass");
    const zkey = new Uint8Array(readFileSync(requireFile(a.upload, "--upload key")));
    const hashFile = `${a.upload}.contribution-hash`;
    const expected = a.expectHash ?? (existsSync(hashFile) ? readFileSync(hashFile, "utf8").trim() : null);
    if (!expected) throw new Error(`--upload needs --expect-hash <the hash the offline step printed> (or ${hashFile}): without it a wrong receipt could not be noticed`);
    log(`uploading ${zkey.length} bytes; the coordinator verifies it before answering`);
    const receipt = await uploadAndCheck(client, pass, zkey, expected);
    rmSync(a.passFile, { force: true });
    printReceipt(receipt, a, a.coordinator);
    return 0;
  }

  const name = cleanName(a.name);
  if (!name) throw new Error("--name must be 1-64 printable ASCII characters");

  if (a.joinOnly) {
    if (!a.download || !a.passFile) throw new Error("--join-only needs --download <file> and --pass-file <file>");
    const { pass, turn } = await joinAndWait(client, name, { log });
    const prev = await client.download(turn.base.url, { expectSha256: turn.base.zkeySha256 });
    writeFileSync(a.download, prev);
    writeFileSync(a.passFile, pass + "\n", { mode: 0o600 });
    log(`saved key #${turn.base.index} to ${a.download} (sha256 ${turn.base.zkeySha256}) and the queue pass to ${a.passFile}`);
    log(`contribute offline with --in ${a.download} --out <new file> --name "${name}", then --upload before ${turn.deadline}`);
    if (a.json) console.log(JSON.stringify({ download: a.download, index: turn.index, deadline: turn.deadline }));
    return 0;
  }

  if (a.out && existsSync(a.out)) throw new Error(`${a.out} exists; choose a new file`);
  const { receipt, zkey } = await contributeOnline({ coordinator: a.coordinator, name, extraText: a.entropyText ?? "", log });
  if (a.out) writeFileSync(a.out, zkey);
  printReceipt(receipt, a, a.coordinator);
  return 0;
}

if (isMain(import.meta.url)) runMain(main);

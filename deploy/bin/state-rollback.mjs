#!/usr/bin/env node
// Rolls an indexer state file back to block H through its undo journal (the last 144 blocks),
// for the upgrade rollback in docs/OPERATIONS.md: an older release must not keep state that a
// newer release wrote under rules the older one does not know.
//
// Usage: node deploy/bin/state-rollback.mjs --state <state.json> --to <H> [--dry-run]
//
// Stop the indexer first. The state is restored under the activation table it was written with,
// rolled back so that H is its last block, and written to a new file that replaces the old one;
// the old file is moved to ./archive next to it (never deleted). The next start syncs the blocks
// above H again. The header chain file (headers.json) needs no change: the indexer re-aligns it.
//
// It refuses a height above the state's tip, below its start, or deeper than the undo journal
// (then archive the state and resync from genesis, docs/OPERATIONS.md "Reorg").
// Exit codes: 0 done (or the dry run would succeed); 1 refused or failed; 2 usage.
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Indexer } from "../../src/indexer.mjs";
import { archiveState } from "../../src/store-node.mjs";
import { ACTIVATIONS } from "../../src/params.mjs";

export class RollbackError extends Error {}

/** The activation table a snapshot was written with (version 2 predates every activation). */
export function snapshotActivations(snap) {
  if (Array.isArray(snap.activations)) return snap.activations.map((a) => ({ ...a }));
  return ACTIVATIONS.map((a) => ({ ...a, height: null }));
}

/** Rolls a parsed snapshot back to `to` -> { snapshot, from, to, digest }. Pure: nothing is written. */
export function rollbackSnapshot(snap, to) {
  if (!Number.isSafeInteger(to)) throw new RollbackError("--to must be a block height");
  let idx;
  try {
    idx = Indexer.restore(snap, { activations: snapshotActivations(snap) });
  } catch (e) {
    throw new RollbackError(`the state file does not load (${e.message})`);
  }
  if (to > idx.height) throw new RollbackError(`the state ends at ${idx.height}; nothing above ${to} to roll back`);
  if (to < idx.startHeight - 1) throw new RollbackError(`the state starts at ${idx.startHeight}; it cannot roll back below ${idx.startHeight - 1}`);
  const reach = idx.height - idx.undo.length;
  if (to < reach) throw new RollbackError(`the undo journal reaches back only to ${reach} (${idx.undo.length} blocks); archive the state and resync from genesis instead`);
  const from = idx.height;
  idx.rollbackTo(to);
  const snapshot = JSON.parse(JSON.stringify(idx.snapshot()));
  // The result must load as it is, under the same table.
  Indexer.restore(snapshot, { activations: snapshotActivations(snap) });
  return { snapshot, from, to, digest: idx.digests.get(to) ?? null };
}

/** Rolls the file back in place (the old one archived) -> { from, to, digest, archived }. */
export function rollbackFile(path, to, { dryRun = false } = {}) {
  if (!existsSync(path)) throw new RollbackError(`${path} does not exist`);
  let snap;
  try {
    snap = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RollbackError(`${path} does not parse (${e.message})`);
  }
  const r = rollbackSnapshot(snap, to);
  if (dryRun) return { from: r.from, to: r.to, digest: r.digest, archived: null, dryRun: true };
  const tmp = `${path}.rollback-${to}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(r.snapshot));
  let archived;
  try {
    archived = archiveState(path, `before rollback to ${to}`);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  renameSync(tmp, path);
  return { from: r.from, to: r.to, digest: r.digest, archived };
}

export function parseArgs(argv) {
  const o = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true;
    else if (a === "--state") o.state = argv[++i];
    else if (a === "--to") o.to = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.state || o.to === undefined) throw new Error("usage: state-rollback.mjs --state <state.json> --to <H> [--dry-run]");
  if (!/^\d+$/.test(String(o.to))) throw new Error("--to must be a block height");
  o.to = Number(o.to);
  return o;
}

export function main(argv, { print = (s) => console.log(s), error = (s) => console.error(s) } = {}) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    error(`state-rollback: ${e.message}`);
    return 2;
  }
  try {
    const r = rollbackFile(resolve(o.state), o.to, { dryRun: o.dryRun });
    print(JSON.stringify({ ok: true, ...r }));
    if (!o.dryRun) error(`state rolled back from ${r.from} to ${r.to}; the old file is in ${r.archived}. Start the indexer: it syncs the blocks above ${r.to} again.`);
    return 0;
  } catch (e) {
    error(`state-rollback: ${e.message}`);
    return 1;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  const a = resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
if (isMain()) process.exitCode = main(process.argv.slice(2));

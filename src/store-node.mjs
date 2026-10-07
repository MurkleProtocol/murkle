// Node-only persistence of indexer state (JSON snapshot, atomic replace) and
// pinned-artifact checks for Node entry points (server, CLI, scripts).
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { Indexer } from "./indexer.mjs";
import { ACTIVATION_HEIGHT, ARTIFACT_SHA256, GENESIS, IS_TESTNET, NETWORK, PINS_FILE, PRE_GENESIS } from "./params.mjs";

export const sha256File = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/**
 * Reads verification_key.json and refuses it unless it matches the pinned
 * hash (when one is pinned): a replay with another key would accept other proofs.
 * Off a test network an unpinned key is refused outright (mainnet before the ceremony).
 */
export function loadPinnedVkey(path, { pinned = ARTIFACT_SHA256.vkey, requirePin = !IS_TESTNET } = {}) {
  if (requirePin && !pinned) {
    throw new Error(`${NETWORK} artifacts are not pinned yet (${PINS_FILE} has no vkey): run the ceremony, see docs/MAINNET.md`);
  }
  const bytes = readFileSync(path);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (pinned && actual !== pinned) {
    throw new Error(`${basename(path)} does not match the pinned hash in ${PINS_FILE} (${actual.slice(0, 12)}… != ${pinned.slice(0, 12)}…)`);
  }
  return JSON.parse(bytes.toString("utf8"));
}

/** Moves a state file into ./archive next to it (never deletes it). Returns the new path. */
export function archiveState(path, reason = "archived") {
  const dir = join(dirname(path), "archive");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tag = String(reason).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  let dest = join(dir, `${basename(path, ".json")}-${stamp}-${tag}.json`);
  for (let n = 2; existsSync(dest); n++) dest = join(dir, `${basename(path, ".json")}-${stamp}-${tag}-${n}.json`);
  renameSync(path, dest);
  return dest;
}

const sameGenesis = (a, b) =>
  (a?.txid ?? null) === (b?.txid?.toLowerCase() ?? null) && (a?.manifestSha256 ?? null) === (b?.manifestSha256?.toLowerCase() ?? null);

/**
 * Loads persisted state, or starts a fresh indexer:
 * - at the pinned activation height with the genesis rule, once genesis is pinned;
 * - pre-genesis, at tip + 1 with no genesis check.
 * `startHeight` / `genesis` override the pins (tests, `murkle audit --from`).
 * A snapshot from another version, start height or genesis is archived, not used. One written
 * past an activation height this release pins (by the release before it) is rolled back to the
 * block before that height when its undo journal reaches back that far (Indexer.restoreRewound);
 * the caller's sync applies those blocks again under the new rules.
 */
export async function loadIndexer(path, { vkey, api, startHeight, genesis, onArchive, onRewind } = {}) {
  const pinned =
    startHeight !== undefined ? { startHeight, genesis: genesis ?? null }
    : PRE_GENESIS ? null
    : { startHeight: ACTIVATION_HEIGHT, genesis: GENESIS };

  if (existsSync(path)) {
    let idx = null;
    let reason = null;
    try {
      const snap = JSON.parse(readFileSync(path, "utf8"));
      idx = Indexer.restoreRewound(snap, { vkey });
      if (idx.height < snap.height) {
        (onRewind ?? console.warn)(`state at ${path} was written past an activation height of this release; rolled back from ${snap.height} to ${idx.height} to apply the blocks after it under the new rules`);
      }
      if (pinned && idx.startHeight !== pinned.startHeight) reason = "start height differs";
      else if (pinned && !sameGenesis(idx.genesis, pinned.genesis)) reason = "genesis differs";
    } catch (e) {
      reason = e.message;
    }
    if (!reason) return idx;
    const dest = archiveState(path, reason);
    (onArchive ?? console.warn)(`state at ${path} is incompatible (${reason}); archived to ${dest}`);
  }

  if (pinned) return new Indexer({ vkey, startHeight: pinned.startHeight, genesis: pinned.genesis });
  return new Indexer({ vkey, startHeight: (await api.tipHeight()) + 1 });
}

// Windows refuses a rename onto a file another process has open at that instant (EPERM,
// EACCES, EBUSY). Those windows last milliseconds, so a short retry rides them out.
const RENAME_RETRY = new Set(["EPERM", "EACCES", "EBUSY"]);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Atomically replaces `path` with the indexer's snapshot. The temp file is unique to this
 * call, so two processes saving the same state file (the CLI next to a running server)
 * never write into, or rename away, each other's temp file: the last rename wins whole.
 */
export function saveIndexer(path, idx) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(idx.snapshot()));
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path);
        return;
      } catch (e) {
        if (!RENAME_RETRY.has(e?.code) || attempt >= 20) throw e;
        pause(10 + attempt * 10);
      }
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// Node-only persistence of a HeaderChain (src/btc/headers.mjs): JSON snapshot, atomic replace.
// A missing, corrupt or other-network file gives a fresh chain from the base checkpoint (with a
// warning), never a crash: the chain is rebuilt from the data source on the next sync.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import * as P from "../params.mjs";
import { HeaderChain } from "./headers.mjs";

/**
 * Loads the header chain saved at `path`, or a fresh one from the base checkpoint for
 * `startHeight` (the indexer's start height; null: the newest base checkpoint).
 */
export function loadHeaderChain(path, { network = P.NETWORK ?? "signet", startHeight = null, log = console, ...opts } = {}) {
  if (path && existsSync(path)) {
    try {
      return HeaderChain.restore(JSON.parse(readFileSync(path, "utf8")), { network, startHeight, ...opts });
    } catch (e) {
      log?.warn?.(`header chain at ${path} is not usable (${e.message}); starting again from the base checkpoint`);
    }
  }
  return new HeaderChain({ network, startHeight, ...opts });
}

// Windows refuses a rename onto a file another process has open at that instant (EPERM,
// EACCES, EBUSY). Those windows last milliseconds, so a short retry rides them out
// (the same pattern as saveIndexer in src/store-node.mjs).
const RENAME_RETRY = new Set(["EPERM", "EACCES", "EBUSY"]);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Atomically replaces `path` with the chain's snapshot (a temp file unique to this call, then rename). */
export function saveHeaderChain(path, chain) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(chain.snapshot()));
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

// Relay timing (non-consensus): the mode names and the batch epoch arithmetic
// shared by the relayer, the web wallet, the CLI and the tests. Pure and
// dependency-free. Epoch lengths are fixed here, not relayer settings, so every
// wallet works out the same boundary. See docs/design/batch-contract.md §1.

export const ANCHOR_WINDOW = 100; // mirrors src/indexer.mjs (a test asserts equality)
export const MODES = Object.freeze(["fast", "block", "batch", "batch10"]);
export const BATCH_MODES = Object.freeze(["batch", "batch10"]);
export const EPOCH_BLOCKS = Object.freeze({ batch: 6, batch10: 60 });
export const DEFAULT_SAFETY = Object.freeze({ batch: 24, batch10: 12 });
export const DEFAULT_CAPS = Object.freeze({ batch: 40, batch10: 120 });
export const DEFAULT_PER_IP = 3;
export const OVERDUE_AFTER = 3; // blocks after releaseAt before the wallet calls a batch overdue

export const isMode = (m) => MODES.includes(m);
export const isBatchMode = (m) => m === "batch" || m === "batch10";

// Mode ids an older wallet may have saved (a preference, a history entry, a CLI pending
// entry): "batch12", the 12-hour batch, was replaced by the 10-hour batch. Wallets map
// them where a saved id picks a timing (the self-transfer preference, a retry); the
// relayer never does (it refuses "batch12" as malformed).
const LEGACY_MODES = new Map([["batch12", "batch10"]]);

/** Today's id for a mode id saved by an older wallet; any other value is returned as is. */
export const savedMode = (m) => LEGACY_MODES.get(m) ?? m;

/** Throws RangeError unless `h` is a non-negative safe integer; returns it. */
function height(h, what = "height") {
  if (!Number.isSafeInteger(h) || h < 0) throw new RangeError(`${what} must be a non-negative integer: ${h}`);
  return h;
}

/** Blocks per epoch: 6 (Hourly batch) or 60 (10-hour batch). */
export function epochBlocks(mode) {
  if (!isBatchMode(mode)) throw new TypeError(`not a batch mode: ${mode}`);
  return EPOCH_BLOCKS[mode];
}

/** First block of the epoch that contains `h` (the anchor of a batch send made at `h`). */
export function epochStart(h, mode = "batch") {
  const e = epochBlocks(mode);
  return height(h) - (h % e);
}

export function isBoundary(h, mode = "batch") {
  const e = epochBlocks(mode);
  return height(h) % e === 0;
}

/** Start of the epoch after the one containing `h`. */
export function nextBoundary(h, mode = "batch") {
  return epochStart(h, mode) + epochBlocks(mode);
}

/** The relayer releases an epoch once the indexer reaches anchor + E. */
export function releaseHeight(anchor, mode = "batch") {
  const e = epochBlocks(mode);
  return height(anchor, "anchor") + e;
}

/** Last block at which the relayer may still broadcast: anchor + 100 - safety. */
export function lastReleaseHeight(anchor, mode, safety = DEFAULT_SAFETY[mode]) {
  epochBlocks(mode);
  if (!Number.isSafeInteger(safety) || safety < 0 || safety > ANCHOR_WINDOW) throw new RangeError(`safety must be an integer in 0..${ANCHOR_WINDOW}: ${safety}`);
  return height(anchor, "anchor") + ANCHOR_WINDOW - safety;
}

/** Wallet invariant W-1: notes stay reserved until the transfer lands or until this block (any mode). */
export const deadlineHeight = (anchor) => height(anchor, "anchor") + ANCHOR_WINDOW;

export const epochKey = (mode, start) => `${mode}:${start}`;

/**
 * Leaves in the tree after block `h`: the number of outputs with o.height <= h.
 * `outputs` are in leaf order with non-decreasing heights (binary search).
 */
export function leafCountAt(outputs, h) {
  height(h);
  let lo = 0;
  let hi = outputs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (outputs[mid].height <= h) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Everything a wallet shows for a batch send made at `h`. */
export function batchSchedule(h, mode, { safety } = {}) {
  const e = epochBlocks(mode);
  const start = epochStart(h, mode);
  const releaseAt = start + e;
  return {
    mode,
    epochBlocks: e,
    start,
    releaseAt,
    landsAt: releaseAt + 1,
    lastRelease: lastReleaseHeight(start, mode, safety ?? DEFAULT_SAFETY[mode]),
    deadline: deadlineHeight(start),
  };
}

// The effective crowd of a private send (non-consensus; privacy-trace-test.md L3), shared by
// the web wallet (web/src/privacy.js) and the CLI. Pure: it reads only public data every
// wallet already has. Advice only: no wallet blocks a send on it.
//
// The proof's public anchor fixes the tree size, so an observer only has to look at the notes
// in the tree at that block; a batch that holds only your transfer hides nothing.
//
//   candidateNotes({ outputs, leaves, log, own }) -> number
//       Value-bearing leaves in the tree at the anchor (the first `leaves` outputs) that are
//       not this wallet's own. `outputs` are leaf rows { txid } in leaf order; `log` the
//       operation log ({ txid, opName }, an array or a Map by txid); `own` this wallet's leaf
//       indexes. A mint or a mining claim adds exactly one value-bearing note and one
//       zero-value padding note: the padding is never counted, whatever its position (the
//       two outputs are in a random order, L4). A mint or claim whose note is this wallet's
//       counts for nothing (its padding is ours too). Leaves of an operation the log does not
//       name count as one note per transaction.
//   crowdCheck({ candidates, mode, queued }) -> { candidates, batchCrowd, fewNotes, alone, thin }
//       batchCrowd = queued + 1 (the published waiting count plus this transfer) for a batch
//       mode, else null. thin when fewer than CROWD_MIN_NOTES candidates, or a batch crowd of 1.
import { isBatchMode } from "./relay-batch.mjs";

/** Below this many candidate notes a wallet warns before a relayed or batch send (L3). */
export const CROWD_MIN_NOTES = 8;

// Operations that add exactly one value-bearing note (plus one zero-value padding note).
const ONE_NOTE_OPS = new Set(["MINT", "MINT_SCRIPT", "MINE", "MINE_SCRIPT"]);

/** Value-bearing leaves of other people in the tree at the anchor (see above). */
export function candidateNotes({ outputs = [], leaves = outputs.length, log = [], own = [] } = {}) {
  const ops = log instanceof Map ? log : new Map((log ?? []).filter((e) => e?.txid).map((e) => [e.txid, e]));
  const mine = new Set([...own].map(Number));
  const n = Math.max(0, Math.min(Number(leaves) || 0, outputs.length));
  const groups = new Map(); // txid -> leaf indexes, in leaf order
  for (let i = 0; i < n; i++) {
    const t = outputs[i]?.txid ?? `leaf:${i}`;
    if (!groups.has(t)) groups.set(t, []);
    groups.get(t).push(i);
  }
  let count = 0;
  for (const [txid, idx] of groups) {
    const ours = idx.filter((i) => mine.has(i)).length;
    const op = ops.get(txid)?.opName;
    if (!op || ONE_NOTE_OPS.has(op)) count += ours ? 0 : Math.min(1, idx.length);
    else count += idx.length - ours;
  }
  return count;
}

/** The L3 warning inputs for one send: candidates from candidateNotes, queued from relay info. */
export function crowdCheck({ candidates = null, mode = "block", queued = null } = {}) {
  const batchCrowd = isBatchMode(mode) && Number.isSafeInteger(queued) && queued >= 0 ? queued + 1 : null;
  const fewNotes = Number.isFinite(candidates) && candidates < CROWD_MIN_NOTES;
  const alone = batchCrowd === 1;
  return { candidates, batchCrowd, fewNotes, alone, thin: fewNotes || alone };
}

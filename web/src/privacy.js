// Crowd Meter for a single note: a privacy tier with the
// plain-English reasons behind it. No percentages and no fake precision, on
// purpose: the leaf count is only an upper bound on the anonymity set, and
// timing, public mint data, the fee payer, IP and off-chain metadata all
// reduce real anonymity. The tier is advice; it never blocks a send.
//
// API
//   TIERS                          ["exposed", "weak", "fair", "strong"]
//   TIER_LABEL                     { exposed: "Exposed", ... }
//   UPPER_BOUND_TIP                the caveat sentence for tooltips
//   noteContext({ leafIndex, height, txid }, { leaves, height, log }) -> ctx
//       Counts from public data every wallet already has: notes added after this
//       one, private transfers since its block (from the bulk log), blocks elapsed,
//       and whether it was minted (its txid is a MINT in the log).
//   noteTier(ctx, { route, mode }) -> { tier, label, rank, reasons[], advice|null, hidesAmong }
//       route: "relay" (a relayer paid from the relay balance) | "relay-linkable" (the same while
//       the relay pool is thin: the carrier's input ties it to your top-up, always Exposed) | "self" (built-in key) |
//       "self-linked" (a key that also paid a mint) | "unisat" | "copy" (whoever
//       carries the copied envelope pays). mode: the relay timing ("fast" | "block" |
//       "batch" | "batch10"); a relayed send that is not batched gets the hourly
//       batch suggestion in its timing advice. The mode never changes the tier.
//   weakest(tiers[]) -> the lowest tier result (a send is as private as its weakest note)
//
// Effective crowd before a relayed or batch send (privacy-trace-test.md L3). The proof's
// public anchor fixes the tree size, so an observer only has to look at the notes in the
// tree at that block; a batch that holds only your transfer hides nothing.
//   (src/crowd.mjs, re-exported here and shared with the CLI)
//   candidateNotes({ outputs, leaves, log, own }) -> number
//       Value-bearing leaves in the tree at the anchor (the first `leaves` outputs) that are
//       not this wallet's own. A mint or a mining claim adds exactly one value-bearing note
//       and one zero-value padding note: the padding is never counted, whatever its position
//       (before the output-order shuffle it was always output 1; after it, either output).
//       A mint or claim whose note is this wallet's counts for nothing (its padding is ours
//       too). Leaves of an operation the log does not name count as one note per transaction.
//   crowdCheck({ candidates, mode, queued }) -> { candidates, batchCrowd, fewNotes, alone, thin }
//       batchCrowd = queued + 1 (the published waiting count plus this transfer) for a batch
//       mode, else null. thin when fewer than CROWD_MIN_NOTES candidates, or a batch crowd of 1.
//       Advice only: the wallet never blocks a send on it.
//   CROWD_TEXT                         the warning copy
import { isBatchMode } from "../../src/relay-batch.mjs";

export const TIERS = ["exposed", "weak", "fair", "strong"];
export const TIER_LABEL = { exposed: "Exposed", weak: "Weak", fair: "Fair", strong: "Strong" };
export const UPPER_BOUND_TIP =
  "An upper bound, not a guarantee. Timing, public mint data, the fee payer, your IP and anything you say off-chain can all narrow it down.";

const NF = new Intl.NumberFormat("en-US");
const n = (v) => NF.format(v);
const plural = (v, one, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** Public counts around one note. `log` is the bulk /api/log items (or a compatible list). */
export function noteContext(note, { leaves, height, log = [] }) {
  const noteHeight = Number(note.height);
  let transfersSince = 0;
  let mint = Boolean(note.mint);
  for (const e of log) {
    if (!e.ok) continue;
    if (e.height > noteHeight && (e.opName === "TRANSFER" || e.op === 1)) transfersSince++;
    if (!mint && note.txid && e.txid === note.txid && (e.opName === "MINT" || e.opName === "MINT_SCRIPT")) mint = true;
  }
  return {
    notesAfter: Math.max(0, Number(leaves) - 1 - Number(note.leafIndex)),
    transfersSince,
    blocks: Math.max(0, Number(height) - noteHeight),
    mint,
    leaves: Number(leaves),
  };
}

// Each factor scores 0..3; the tier is the weakest factor (privacy is a chain of links).
const crowdPts = (k) => (k < 5 ? 0 : k < 25 ? 1 : k < 100 ? 2 : 3);
const activityPts = (k) => (k < 2 ? 0 : k < 6 ? 1 : k < 20 ? 2 : 3);
const timePts = (b) => (b < 3 ? 0 : b < 12 ? 1 : b < 72 ? 2 : 3);

export function noteTier(ctx, { route = "relay", mode } = {}) {
  const { notesAfter, transfersSince, blocks, mint, leaves } = ctx;
  const reasons = [];
  let rank = Math.min(crowdPts(notesAfter), activityPts(transfersSince), timePts(blocks));

  reasons.push(
    notesAfter === 0
      ? "No notes were added to the pool after yours yet."
      : `${plural(notesAfter, "note")} ${notesAfter === 1 ? "was" : "were"} added to the pool after yours.`,
  );
  reasons.push(
    transfersSince === 0
      ? "No private transfers happened since it arrived."
      : `${plural(transfersSince, "private transfer")} happened since it arrived.`,
  );
  reasons.push(blocks === 0 ? "It arrived in the latest block." : `It arrived ${plural(blocks, "block")} ago.`);

  if (mint) {
    reasons.push("It came from a public mint: its token, amount and timing are on Bitcoin.");
    // A fresh mint output is easy to time: its leaf and block are public.
    if (blocks < 6) rank = Math.min(rank, 0);
  }

  if (route === "self-linked") {
    rank = Math.min(rank, 1);
    reasons.push("The fee would be paid by a Bitcoin address that also paid one of your mints, which links them.");
  } else if (route === "self") {
    rank = Math.min(rank, 2);
    reasons.push("The fee would be paid by your built-in Bitcoin address, which every self-paid transfer shares.");
  } else if (route === "unisat") {
    rank = Math.min(rank, 1);
    reasons.push("The fee would be paid by your Unisat address, which ties this transfer to it.");
  } else if (route === "copy") {
    rank = Math.min(rank, 2);
    reasons.push("Whoever carries the copied envelope pays the fee, and Bitcoin ties this transfer to their address.");
  } else if (route === "relay-linkable") {
    // L1: while the relay pool is thin, the relayer's coin descends from your own top-up.
    rank = 0;
    reasons.push("The relay pool is thin: the relayer's coin that carries it descends from your top-up, so Bitcoin ties this transfer to the address you topped up from.");
  } else {
    reasons.push("A relayer carries it, so none of your Bitcoin addresses appears on the transfer.");
    reasons.push("The relayer itself can link it to the address that topped up your relay balance.");
  }

  const tier = TIERS[rank];
  let advice = null;
  if (rank <= 1) {
    const what = mint ? `minted ${plural(blocks, "block")} ago` : `received ${plural(blocks, "block")} ago`;
    advice =
      route === "self-linked" || route === "unisat"
        ? "Pay from a key that never paid a mint, funded from a source not linked to your main wallet: paying from an address you already used links the two."
        : `This note was ${what} and only ${plural(transfersSince, "transfer")} happened since. Waiting makes the timing link weaker.`;
    if (route === "relay-linkable") advice = "Pay the fee yourself from a key funded apart from your main wallet, or wait until more people have topped up the relay pool.";
    else if (route === "relay" && !isBatchMode(mode)) advice += " Or send it with the hourly batch: it lands together with the other hourly-batch transfers from that hour.";
  }
  return { tier, label: TIER_LABEL[tier], rank, reasons, advice, hidesAmong: leaves };
}

// candidateNotes, crowdCheck and CROWD_MIN_NOTES live in src/crowd.mjs, shared with the CLI.
export { CROWD_MIN_NOTES, candidateNotes, crowdCheck } from "../../src/crowd.mjs";

export const CROWD_TEXT = {
  few: "Few transfers to hide among: an observer can likely tell this came from you.",
  alone: "A batch hides nothing while it holds only your transfer.",
  notes: (k) =>
    k === 0
      ? "No notes of other people are in the pool at this transfer's anchor block."
      : `${plural(k, "note")} of other people ${k === 1 ? "is" : "are"} in the pool at this transfer's anchor block: the notes it could be spending, as an observer sees them.`,
  batch: (k) =>
    k === 1
      ? "So far your transfer would be the only one in this batch."
      : `Expected in this batch: ${plural(k, "transfer")}, yours included (from the waiting count the relayer publishes).`,
  advice: "This is a warning only; you decide. Waiting for more activity in the pool lets the crowd grow.",
};

export function weakest(results) {
  return results.reduce((w, r) => (w === null || r.rank < w.rank ? r : w), null);
}

/**
 * Proof Wall and Live Verifier logic (visual.md section 10.2). Pure: picks what
 * to verify from the bulk public log and turns a verifier result into one honest line. The checks
 * themselves run in live-check.js (the verifier engine).
 *
 * Honesty rules applied here:
 *   - "Verified" only when this browser's checks all passed (result.verdict === "verified").
 *   - A rejected envelope is shown in red with the indexer's own reason, and with what this
 *     browser found ("your browser agrees" only when a browser-side check failed too).
 *   - Network trouble is "Couldn't check", never a failure of the proof.
 *   - A failed step's `fault` decides: "data" (input missing or bad) is "Couldn't check";
 *     "rule" (a rule this browser saw broken) is a real result, never "Couldn't check".
 *   - An attestation naming another manifest is muted "Other manifest", never counted as verified.
 *
 * API
 *   PROOF_OPS                         op names that carry a Groth16 proof
 *   wallEntries(entries, n = 12) -> entry[]          newest first, at most n
 *   verifierCandidates(entries, n = 50) -> entry[]   accepted proof-carrying entries, newest first
 *   pickDefault(candidates) -> entry | null          the latest private transfer, else the latest one
 *   candidateLabel(entry) -> "Latest private transfer" | "Latest mint" | ...
 *   wallVerdict(result, entry) -> { tone, title, detail, prov, ms, other? }
 *       tone: "proof" | "danger" | "muted" | "warn"
 *       other: true for an attestation of another manifest (checked, but proves nothing)
 *   wallSummary(verdicts) -> string   "9 verified in your browser · 1 rejected · 2 waiting"
 */
export const PROOF_OPS = new Set(["TRANSFER", "MINT", "MINT_SCRIPT"]);
// Steps whose failure means the data didn't arrive intact, not that a rule was broken.
// Only for results without a per-step `fault` (the engine sets it on every failed step).
const INCONCLUSIVE = new Set(["fetch", "txid", "status", "inclusion"]);

const newestFirst = (list) => [...(list ?? [])].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0) || (b.height ?? 0) - (a.height ?? 0));

export function wallEntries(entries, n = 12) {
  const seen = new Set();
  const out = [];
  for (const e of newestFirst(entries)) {
    if (!e?.txid || seen.has(e.txid)) continue;
    seen.add(e.txid);
    out.push(e);
    if (out.length >= n) break;
  }
  return out;
}

export function verifierCandidates(entries, n = 50) {
  return newestFirst(entries).filter((e) => e?.ok && PROOF_OPS.has(e.opName)).slice(0, n);
}

export function pickDefault(candidates) {
  const list = candidates ?? [];
  return list.find((e) => e.opName === "TRANSFER") ?? list[0] ?? null;
}

export function candidateLabel(entry) {
  if (!entry) return "No proofs yet";
  return { TRANSFER: "Latest private transfer", MINT: "Latest mint", MINT_SCRIPT: "Latest mint" }[entry.opName] ?? "Latest envelope";
}

export function wallVerdict(result, entry = null) {
  const v = verdictOf(result, entry);
  // A rejected envelope is always shown in red with the indexer's reason, even when this
  // browser couldn't fetch the transaction to compare.
  if (entry && entry.ok === false && v.tone === "muted") {
    return { tone: "danger", title: "Rejected by indexer", detail: `${entry.reason ?? "no reason given"}. Your browser couldn't re-check it: ${v.detail}`, prov: "IDX", ms: null };
  }
  return v;
}

function verdictOf(result, entry) {
  const reason = entry && entry.ok === false ? entry.reason ?? "no reason given" : null;
  if (!result || result.error) {
    const msg = result?.error?.message ?? "";
    return { tone: "muted", title: "Couldn't check", detail: msg ? `${msg}. Try again in a minute.` : "Try again in a minute.", prov: null, ms: null };
  }
  const failed = (result.steps ?? []).find((s) => s.status === "fail") ?? null;
  switch (result.verdict) {
    case "verified":
      // Anyone can post an attestation: one naming another manifest checks out but proves nothing.
      if (result.opName === "ATTEST" && result.attest?.pinned === false) {
        return { tone: "muted", title: "Other manifest", detail: "Names a manifest other than the pinned one; it carries no authority and never changes the pool", prov: "YOU", ms: null, other: true };
      }
      return result.proofMs != null
        ? { tone: "proof", title: "Verified", detail: "Groth16 proof checked in your browser", prov: "YOU", ms: result.proofMs }
        : { tone: "proof", title: result.opName === "ATTEST" ? "Checked" : "Terms checked", detail: "No proof in this operation; its bytes were checked in your browser", prov: "YOU", ms: null };
    case "rejected":
      return { tone: "danger", title: "Rejected by indexer", detail: `${reason ?? result.indexer?.reason ?? "no reason given"}. Your browser's checks passed; that rule depends on pool history.`, prov: "IDX", ms: result.proofMs ?? null };
    case "mismatch":
      return { tone: "danger", title: "Indexer disagrees", detail: "Your browser and our indexer reached different verdicts. Open the receipt for details.", prov: "YOU", ms: null };
    case "mempool":
      return { tone: "muted", title: "In the mempool", detail: "Checked again once it's in a block.", prov: "BTC", ms: result.proofMs ?? null };
    case "not-found":
      return { tone: "muted", title: "Couldn't check", detail: failed?.detail ?? "mempool.space doesn't have this transaction.", prov: "BTC", ms: null };
    case "not-protocol":
      return { tone: "muted", title: "No envelope", detail: "This transaction carries no protocol envelope.", prov: "YOU", ms: null };
    default: {
      // "failed": missing or inconsistent source data is inconclusive (it says nothing about the
      // proof); a rule that this browser checked and saw broken is a real result. The engine's
      // fault says which; the step-id guess is only for results without one.
      const dataProblem = failed && (failed.fault ? failed.fault === "data" : INCONCLUSIVE.has(failed.id) || failed.source === "IDX" || (failed.id === "terms" && !reason));
      if (dataProblem) {
        return { tone: "muted", title: "Couldn't check", detail: failed.detail ?? "The Bitcoin data didn't load.", prov: "BTC", ms: null };
      }
      if (reason) return { tone: "danger", title: "Rejected", detail: `${reason}. Your browser agrees: ${failed ? `the check "${failed.label}" failed` : "a check failed"}.`, prov: "YOU", ms: null };
      return { tone: "danger", title: "Failed in your browser", detail: failed ? `${failed.label}: ${failed.detail ?? "failed"}` : "A check failed.", prov: "YOU", ms: null };
    }
  }
}

export function wallSummary(verdicts) {
  const c = { verified: 0, rejected: 0, unchecked: 0, other: 0, waiting: 0 };
  for (const v of verdicts ?? []) {
    if (!v) c.waiting += 1;
    else if (v.other) c.other += 1;
    else if (v.tone === "proof") c.verified += 1;
    else if (v.tone === "danger") c.rejected += 1;
    else c.unchecked += 1;
  }
  const parts = [`${c.verified} verified in your browser`];
  if (c.rejected) parts.push(`${c.rejected} rejected or disputed`);
  if (c.unchecked) parts.push(`${c.unchecked} couldn't be checked`);
  if (c.other) parts.push(`${c.other} ${c.other === 1 ? "names" : "name"} another manifest`);
  if (c.waiting) parts.push(`${c.waiting} waiting`);
  return parts.join(" · ");
}

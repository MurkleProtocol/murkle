// Ceremony receipts and transcript lookups (docs/CEREMONY.md, "Receipt and transcript").
// Pure functions, used by the page and by scripts/ceremony/contribute.mjs.
//
// API
//   normalizeHash(text) -> 128 lowercase hex | null    accepts snarkjs' grouped print format
//   formatHash(hex) -> string                           4 lines of 4 groups of 8, as snarkjs prints it
//   checkReceipt(receipt, local) -> { ok, problems: string[] }
//       local: the contribution hash computed here (a string), or { contributionHash, zkeySha256,
//       prevZkeySha256 } known locally (the key uploaded and the key built on). Any difference
//       means the coordinator's answer is not about this contribution: not ok.
//   ownReceipt(receipt, local) -> the receipt with the locally known values in place of the
//       coordinator's (what the page saves and looks up)
//   findContribution(transcript, hash) -> transcript entry | null
//   receiptText(receipt, { origin }) -> string          what the page copies and saves

export const HASH_RE = /^[0-9a-f]{128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function normalizeHash(text) {
  const h = String(text ?? "").replace(/[\s:]/g, "").toLowerCase();
  return HASH_RE.test(h) ? h : null;
}

export function formatHash(hex) {
  const h = normalizeHash(hex);
  if (!h) return String(hex ?? "");
  const groups = h.match(/.{8}/g);
  const lines = [];
  for (let i = 0; i < 16; i += 4) lines.push(groups.slice(i, i + 4).join(" "));
  return lines.join("\n");
}

/** A receipt is consistent with itself and, when given, with what is known locally. */
export function checkReceipt(receipt, local = null) {
  const mine = typeof local === "string" ? { contributionHash: local } : local ?? {};
  const localHash = mine.contributionHash ?? null;
  const problems = [];
  if (!receipt || typeof receipt !== "object") return { ok: false, problems: ["no receipt"] };
  if (!Number.isSafeInteger(receipt.index) || receipt.index < 1) problems.push("index is missing");
  if (!normalizeHash(receipt.contributionHash)) problems.push("contribution hash is malformed");
  if (!HEX64.test(String(receipt.zkeySha256 ?? ""))) problems.push("zkey sha256 is malformed");
  if (!HEX64.test(String(receipt.prevZkeySha256 ?? ""))) problems.push("previous zkey sha256 is malformed");
  if (localHash && normalizeHash(localHash) !== normalizeHash(receipt.contributionHash)) {
    problems.push("the coordinator's contribution hash differs from the one computed here");
  }
  if (mine.zkeySha256 && String(receipt.zkeySha256 ?? "").toLowerCase() !== mine.zkeySha256) {
    problems.push("the coordinator's key hash differs from the key uploaded from here");
  }
  if (mine.prevZkeySha256 && String(receipt.prevZkeySha256 ?? "").toLowerCase() !== mine.prevZkeySha256) {
    problems.push("the coordinator says the contribution built on another key than the one downloaded here");
  }
  return { ok: problems.length === 0, problems };
}

export function ownReceipt(receipt, local = null) {
  const mine = typeof local === "string" ? { contributionHash: local } : local ?? {};
  const out = { ...receipt };
  for (const k of ["contributionHash", "zkeySha256", "prevZkeySha256"]) if (mine[k]) out[k] = k === "contributionHash" ? normalizeHash(mine[k]) ?? mine[k] : mine[k];
  return out;
}

export function findContribution(transcript, hash) {
  const h = normalizeHash(hash);
  if (!h || !Array.isArray(transcript?.contributions)) return null;
  return transcript.contributions.find((c) => normalizeHash(c.contributionHash) === h) ?? null;
}

export function receiptText(receipt, { origin = "" } = {}) {
  return [
    `Murkle trusted setup ceremony: ${receipt.ceremony}`,
    `Contribution #${receipt.index} by "${receipt.name}"`,
    `Accepted at ${receipt.acceptedAt}`,
    "",
    "Contribution hash (blake2b-512, as snarkjs prints it):",
    formatHash(receipt.contributionHash),
    "",
    `Key after your contribution, sha256: ${receipt.zkeySha256}`,
    `Key you built on, sha256:            ${receipt.prevZkeySha256}`,
    `Checked by the coordinator with ${receipt.verifiedWith}`,
    "",
    `Check that this hash is in the transcript: ${origin}/ceremony/api/transcript.json`,
    "and run scripts/ceremony/verify.mjs on the final key once it is published.",
    "",
  ].join("\n");
}

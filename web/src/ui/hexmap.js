/**
 * Envelope Anatomy `.hexmap` (visual.md section 6.5): every byte of a protocol envelope as a
 * colored cell, grouped by field. Ciphertext bytes are public but unreadable, so they are
 * drawn redacted. The grid width follows its container (container queries: 32/16/12/8 columns).
 *
 * API
 *   FIELD_INFO                      { color key: legend label }
 *   envelopeFields(bytes) -> [{ key, color, name, start, len, note }]
 *       Splits the bytes by the envelope layout (header 5 = magic 3, version 1, op 1). Works for
 *       TRANSACT (op 1), DEPLOY (2), MINT (3), MINT_SCRIPT (4), ATTEST (5), and the mining ops
 *       MINE (7), MINE_SCRIPT (8) and DEPLOY_POW (9). Unknown ops or truncated bytes fall back
 *       to one "unknown" field, never a throw.
 *   opName(bytes) -> "TRANSACT" | "DEPLOY" | "MINT" | "MINT_SCRIPT" | "ATTEST" | "MINE" | "MINE_SCRIPT"
 *       | "DEPLOY_POW" | "UNKNOWN"
 *   hexmap(bytes, { carrierVsize, compact, legend = true }) -> Safe <figure class="hexmap">
 *       Hover or tap a field (cell or legend chip) to dim the others and read its legend line;
 *       wired by the global behavior in ui/behaviors.js.
 */
import { esc, html, Safe } from "./dom.js";
import { int } from "./format.js";
import { MAGIC } from "../config.js";

const OPS = { 1: "TRANSACT", 2: "DEPLOY", 3: "MINT", 4: "MINT_SCRIPT", 5: "ATTEST", 7: "MINE", 8: "MINE_SCRIPT", 9: "DEPLOY_POW" };

export const FIELD_INFO = {
  header: "header",
  anchor: "anchor",
  public: "public values",
  bind: "binding",
  nullifier: "nullifiers",
  commitment: "commitments",
  cipher: "encrypted notes",
  proof: "proof",
};

const f = (key, color, name, start, len, note) => ({ key, color, name, start, len, note });

function toBytes(b) {
  if (b instanceof Uint8Array) return b;
  const s = String(b ?? "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new Error("hexmap needs bytes or hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function opName(bytes) {
  const b = toBytes(bytes);
  return OPS[b[4]] ?? "UNKNOWN";
}

export function envelopeFields(bytes) {
  const b = toBytes(bytes);
  const op = b[4];
  const fields = [f("header", "header", "header", 0, Math.min(5, b.length), `protocol tag "${MAGIC}", version and operation`)];
  let o = 5;
  const take = (key, color, name, len, note) => {
    fields.push(f(key, color, name, o, len, note));
    o += len;
  };
  try {
    if (op === 1 || op === 3 || op === 4) {
      take("anchor", "anchor", "anchor height", 4, "the pool root this proof was made against");
      take("asset", "public", "public asset", 8, op === 1 ? "zero for private transfers" : "the token being minted, public by design");
      take("amount", "public", "public amount", 8, op === 1 ? "zero for private transfers" : "the mint amount, public by design");
      if (op === 3) take("bind", "bind", "bound coin", 36, "the first input must spend this coin, so mempool copies get nothing");
      if (op === 4) take("bind", "bind", "bound address", 32, "hash of the payer's script, so mempool copies get nothing");
      take("n0", "nullifier", "nullifier[0]", 32, "public spend tag: shows that some note was spent, not which one");
      take("n1", "nullifier", "nullifier[1]", 32, "public spend tag: shows that some note was spent, not which one");
      take("c0", "commitment", "commitment[0]", 32, "a new note's sealed fingerprint; reveals nothing about it");
      take("c1", "commitment", "commitment[1]", 32, "a new note's sealed fingerprint; reveals nothing about it");
      take("e0", "cipher", "encrypted note[0]", 95, "only the recipient's view key opens it");
      take("e1", "cipher", "encrypted note[1]", 95, "only the recipient's view key opens it");
      take("proof", "proof", "proof", 128, "compressed Groth16 proof; it binds every byte above");
    } else if (op === 2) {
      const tl = b[o];
      take("ticker", "public", "ticker", 1 + tl, "length and ticker, public by design");
      take("terms", "public", "terms", 1 + 8 + 4 + 8, "decimals, amount per mint, mint cap and price in sats");
      const trl = b[o];
      take("treasury", "bind", "treasury", 1 + trl, "the script that receives every mint payment");
      take("schedule", "anchor", "schedule", 8, "start and end block of the mint window");
    } else if (op === 7 || op === 8) {
      take("anchor", "anchor", "reference block", 4, "the block whose hash the work commits to; also the pool root the proof was made against");
      take("asset", "public", "public asset", 8, "the mined token, public by design");
      take("amount", "public", "public amount", 8, "the reward, public by design");
      if (op === 7) take("bind", "bind", "bound coin", 36, "the first input must spend this coin, so copies in other transactions get nothing");
      if (op === 8) take("bind", "bind", "bound address", 32, "hash of the payer's script, so copies in other transactions get nothing");
      take("nonce", "public", "nonce", 8, "the miner's nonce: with the block hash, the reward and the new notes it gives the Argon2id work");
      take("n0", "nullifier", "nullifier[0]", 32, "public spend tag: shows that some note was spent, not which one");
      take("n1", "nullifier", "nullifier[1]", 32, "public spend tag: shows that some note was spent, not which one");
      take("c0", "commitment", "commitment[0]", 32, "a new note's sealed fingerprint; reveals nothing about it");
      take("c1", "commitment", "commitment[1]", 32, "a new note's sealed fingerprint; reveals nothing about it");
      take("e0", "cipher", "encrypted note[0]", 95, "only the recipient's view key opens it");
      take("e1", "cipher", "encrypted note[1]", 95, "only the recipient's view key opens it");
      take("proof", "proof", "proof", 128, "compressed Groth16 proof; it binds every byte above");
    } else if (op === 9) {
      const tl = b[o];
      take("ticker", "public", "ticker", 1 + tl, "length and ticker, public by design");
      take("terms", "public", "terms", 1 + 8 + 8 + 4, "decimals, reward per claim, supply cap and halving interval");
      take("difficulty", "public", "difficulty", 2 + 4 + 8 + 8, "retarget span, solutions per span, initial and floor difficulty");
      take("fee", "public", "claim fee", 8, "the deployer's per-claim fee in sats");
      const trl = b[o];
      take("treasury", "bind", "treasury", 1 + trl, "the script that receives the deployer's claim fee (empty when there is none)");
      take("schedule", "anchor", "schedule", 8, "start and end block of mining");
    } else if (op === 5) {
      take("kind", "public", "kind", 1, "1 = genesis, 2 = checkpoint, 3 = release");
      take("hash", "commitment", "hash", 32, "the fingerprint being attested, e.g. the circuit manifest");
    }
    if (o !== b.length) throw new Error("length mismatch");
  } catch {
    return [f("header", "header", "header", 0, Math.min(5, b.length), "protocol header"), ...(b.length > 5 ? [f("unknown", "cipher", "unparsed bytes", 5, b.length - 5, "does not match a known layout")] : [])];
  }
  return fields;
}

export function hexmap(bytes, { carrierVsize = null, compact = false, legend = true } = {}) {
  const b = toBytes(bytes);
  const fields = envelopeFields(b);
  const op = opName(b);
  let cells = "";
  for (const fl of fields) {
    for (let i = fl.start; i < fl.start + fl.len; i++) {
      const v = b[i].toString(16).padStart(2, "0");
      cells += `<span class="hx-c hx--${fl.color}" data-k="${fl.key}">${v}</span>`;
    }
  }
  const seen = new Set();
  const chips = fields
    .filter((fl) => (seen.has(fl.color) ? false : seen.add(fl.color)))
    .map((fl) => `<button type="button" class="hx-chip hx--${fl.color}" data-k="${fields.filter((x) => x.color === fl.color).map((x) => x.key).join(" ")}">${esc(FIELD_INFO[fl.color] ?? fl.name)}</button>`)
    .join("");
  const lines = fields.map((fl) => `<span data-line="${fl.key}" hidden>${esc(`${fl.name} · ${int(fl.len)} ${fl.len === 1 ? "byte" : "bytes"} · ${fl.note}`)}</span>`).join("");
  const opLabel = op === "TRANSACT" ? "TRANSACT" : op;
  const sum = `${opLabel} · ${int(b.length)} bytes${carrierVsize ? ` · carried in a ${int(carrierVsize)} vB transaction` : ""}`;
  return new Safe(
    html`<figure class="hexmap${compact ? " hexmap--compact" : ""}" data-hexmap>
      ${legend ? html`<div class="hx-legend">${new Safe(chips)}</div>` : ""}
      <div class="hx-wrap"><div class="hx-grid" role="img" aria-label="${sum}. Byte map of the envelope.">${new Safe(cells)}</div></div>
      <figcaption class="hx-foot">
        <span class="hx-line caption" aria-live="polite"><span data-line="" class="t-3">Tap a field to see what it is.</span>${new Safe(lines)}</span>
        <span class="hx-sum mono">${sum}</span>
      </figcaption>
    </figure>`.toString(),
  );
}

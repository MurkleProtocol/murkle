/**
 * "My view" on public pages (visual.md 6.7): what the unlocked wallet can say about a protocol
 * transaction, computed in this browser and never sent anywhere. Received outputs are found by
 * trial decryption; spent notes by matching nullifiers; sent transfers come from the wallet's
 * local history, because a sender can't decrypt their own outputs (visual.md section 1).
 *
 * API
 *   mySession() -> Session | null            the unlocked wallet session, if any
 *   myView(env, txid, session = mySession()) -> null | {
 *     outputs: [{ index, asset, amount }],    outputs this wallet can open ("decrypted in this browser")
 *     spent:   [{ index, asset, amount }],    notes of this wallet this transaction spent
 *     history: entry | null                   the wallet's own record of it ("from your history"):
 *                                             { kind, ticker, amount (base units), div, to }
 *   }
 */
import * as session from "../session.js";
import { tryDecryptNote } from "../../../src/keys.mjs";

export function mySession() {
  try {
    return typeof session.currentSession === "function" ? session.currentSession() : null;
  } catch {
    return null;
  }
}

export function myView(env, txid, s = mySession()) {
  if (!s || !env?.commitments) return null;
  const keys = s.keys ?? s.wallet?.keys ?? null;
  const outputs = [];
  if (keys) {
    env.commitments.forEach((c, i) => {
      const note = tryDecryptNote(env.ciphertexts[i], keys, c);
      // Zero-value padding notes are indistinguishable on chain and mean nothing to the owner.
      if (note && note.amount > 0n) outputs.push({ index: i, asset: note.asset, amount: note.amount });
    });
  }
  const notes = s.wallet?.notes ?? [];
  const spent = [];
  env.nullifiers.forEach((n, i) => {
    const note = notes.find((x) => String(x.nullifier) === String(n));
    if (note) spent.push({ index: i, asset: note.asset, amount: note.amount });
  });
  let history = null;
  try {
    const list = typeof s.history === "function" ? s.history() : s.history;
    // A relayed or retried send can carry several txids; any of them is this entry.
    history = Array.isArray(list) ? (list.find((h) => h?.txid === txid || (Array.isArray(h?.txids) && h.txids.includes(txid))) ?? null) : null;
  } catch {
    history = null;
  }
  if (!outputs.length && !spent.length && !history) return null;
  return { outputs, spent, history };
}

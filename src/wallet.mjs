// Wallet: note discovery against indexer state and envelope construction.
import * as snarkjs from "snarkjs";
import { x25519 } from "@noble/curves/ed25519";
import { buildTxInput, nullifierOf, pubkeyOf, randomField } from "./core.mjs";
import { encryptNote, tryDecryptNote } from "./keys.mjs";
import { OP, encodeTxBody, extDataHashOf } from "./envelope.mjs";
import { encodeProof } from "./proof-codec.mjs";
import { leafCountAt } from "./relay-batch.mjs";
import { challengeOf, NONCE_LEN } from "./mine.mjs";
import { ARTIFACT_PATHS, MINE_WINDOW } from "./params.mjs";
import { hex, unhex } from "./bytes.mjs";

// This network's proving artifacts (signet: the DEV setup; mainnet: the ceremony output).
export const DEFAULT_ARTIFACTS = {
  wasm: ARTIFACT_PATHS.wasm,
  zkey: ARTIFACT_PATHS.zkey,
};

/**
 * The tree as it stood after block `height`, for a batch send anchored at its
 * epoch start. `view` is anything with { tree, outputs, height } (the server or
 * CLI Indexer, the web view). Returns view.tree itself when nothing came after
 * `height`, else a truncated copy; never mutates view.tree.
 */
export function anchorAt(view, height) {
  const leaves = leafCountAt(view.outputs, height);
  if (height > view.height) throw new RangeError(`block ${height} is above the synced height ${view.height}`);
  if (Number.isSafeInteger(view.startHeight) && height < view.startHeight - 1) throw new RangeError(`block ${height} is before the pool started`);
  if (leaves > view.tree.size) throw new RangeError(`the tree holds ${view.tree.size} leaves, the outputs up to block ${height} ${leaves}`);
  const tree = leaves === view.tree.size ? view.tree : view.tree.copy().truncate(leaves);
  return { height, tree, leaves };
}

const U64 = (1n << 64n) - 1n;
const I64_MAX = (1n << 63n) - 1n;
const CLAIM_INPUT = Symbol("murkle.claimInput");

/**
 * W-M (mining.md §8.1): a claim and the notes rolled into it stay locked until it lands or until
 * its reference window ends: the last block that can include it is refHeight + MINE_WINDOW.
 */
export const claimLockUntil = (refHeight) => refHeight + MINE_WINDOW;

/** A uniform integer in [0, n) from the platform CSPRNG (rejection sampling: no modulo bias). */
function secureRandomBelow(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 0x100000000) throw new RangeError("n must be an integer from 1 to 2^32");
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/**
 * L4 (privacy-trace-test.md): the outputs of a TRANSACT, MINT / MINT_SCRIPT and MINE /
 * MINE_SCRIPT in a uniformly random order, so position never tells payment from change or a
 * real note from zero padding. Each output's commitment and ciphertext are both built from its
 * entry, so they move together. The circuit treats its two outputs symmetrically (one loop over
 * nOuts in circuits/lib.circom), so either order proves. `random(n)` (tests only) replaces the CSPRNG.
 */
export function shuffleOutputs(outs, random = secureRandomBelow) {
  const a = [...outs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = random(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new RangeError("random(n) must return an integer in [0, n)");
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const NOTE_TOO_NEW ="the notes that cover this amount arrived after the batch boundary";
const tooNew = () => Object.assign(new Error(NOTE_TOO_NEW), { code: "NOTE_TOO_NEW" });

/** Up to two notes of `spendable` (largest first) covering `amount`, or NOTE_LIMIT / INSUFFICIENT. */
function pick(spendable, amount) {
  const picked = [];
  let total = 0n;
  for (const n of spendable) {
    if (total >= amount || picked.length === 2) break;
    picked.push(n);
    total += n.amount;
  }
  if (total < amount) {
    if (spendable.reduce((s, n) => s + n.amount, 0n) >= amount) {
      throw Object.assign(new Error(`one transfer spends at most 2 notes: the largest two hold ${total} < ${amount}; send to yourself first to merge notes`), { code: "NOTE_LIMIT" });
    }
    throw Object.assign(new Error(`insufficient balance: ${total} < ${amount}`), { code: "INSUFFICIENT" });
  }
  return { picked, total };
}

export class Wallet {
  constructor(keys, artifacts = DEFAULT_ARTIFACTS) {
    this.keys = keys;
    this.artifacts = artifacts;
    this.notes = [];
    this.locked = new Set(); // nullifiers already used by unconfirmed envelopes
    // Output order source (L4); undefined = the CSPRNG. Tests may set random(n) -> [0, n).
    this.random = undefined;
  }

  get address() {
    return { pk: this.keys.pk, vpk: this.keys.vpk };
  }

  /** Full rescan of accepted outputs; marks notes whose nullifier is published. */
  scan(indexer) {
    this.notes = [];
    for (const out of indexer.outputs) {
      const note = tryDecryptNote(out.ciphertext, this.keys, out.commitment);
      if (!note || note.amount === 0n) continue;
      const nullifier = nullifierOf(out.commitment, BigInt(out.leafIndex), this.keys.sk);
      this.notes.push({ ...note, leafIndex: out.leafIndex, nullifier, spent: indexer.nullifiers.has(String(nullifier)) });
    }
    return this;
  }

  balance(asset) {
    return this.notes.filter((n) => !n.spent && n.asset === asset).reduce((s, n) => s + n.amount, 0n);
  }

  /** Unspent, unlocked notes of `asset`, largest first; `maxLeaf` keeps only leaves below it (a batch anchor). */
  spendable(asset, { maxLeaf } = {}) {
    return this.notes
      .filter((n) => !n.spent && n.asset === asset && !this.locked.has(String(n.nullifier)) && (maxLeaf == null || n.leafIndex < maxLeaf))
      .sort((a, b) => (b.amount > a.amount ? 1 : -1));
  }

  /** The most one transfer can spend: the two largest spendable notes (the circuit is 2-in). */
  maxSendable(asset, { maxLeaf } = {}) {
    return this.spendable(asset, { maxLeaf }).slice(0, 2).reduce((s, n) => s + n.amount, 0n);
  }

  /**
   * Picks up to two unspent notes of `asset` covering `amount` (largest first).
   * With `maxLeaf`, only notes below it; when only newer notes cover the amount,
   * throws NOTE_TOO_NEW (today's INSUFFICIENT / NOTE_LIMIT come first).
   */
  selectNotes(asset, amount, { maxLeaf } = {}) {
    const all = pick(this.spendable(asset), amount);
    if (maxLeaf == null) return all;
    try {
      return pick(this.spendable(asset, { maxLeaf }), amount);
    } catch {
      throw tooNew();
    }
  }

  /**
   * The notes behind `inputs` (nullifier strings/bigints or note objects), for
   * retrying a transfer with exactly the notes an earlier envelope spent.
   * Locked notes are allowed here on purpose: wallet invariant W-1 locks them
   * precisely so that only this retry may use them (same notes, same nullifiers).
   */
  notesFor(asset, amount, inputs, { maxLeaf } = {}) {
    if (!inputs.length || inputs.length > 2) throw new Error("a retry needs one or two input notes");
    const picked = inputs.map((ref) => {
      const nullifier = String(typeof ref === "object" ? ref.nullifier : ref);
      const note = this.notes.find((n) => String(n.nullifier) === nullifier);
      if (!note) throw new Error("retry input is not a note of this wallet; rescan and try again");
      if (note.spent) throw new Error("retry input is already spent; the earlier transfer has landed");
      if (note.asset !== asset) throw new Error("retry input holds a different token");
      return note;
    });
    if (new Set(picked.map((n) => String(n.nullifier))).size !== picked.length) throw new Error("retry inputs repeat a note");
    const total = picked.reduce((s, n) => s + n.amount, 0n);
    if (total < amount) throw new Error(`insufficient balance in retry inputs: ${total} < ${amount}`);
    if (maxLeaf != null && picked.some((n) => n.leafIndex >= maxLeaf)) throw tooNew();
    return { picked, total };
  }

  /**
   * Private transfer of `amount` to `to` ({ pk, vpk }), change back to self.
   * `inputs` (optional) overrides note selection with the notes of an earlier
   * attempt, so a retry publishes the same nullifiers and can never pay twice.
   * `anchor` (from anchorAt) proves against an older tree: a batch send anchored
   * at its epoch start, spending only notes that existed then.
   */
  async transfer(indexer, { asset, amount, to, inputs, anchor }) {
    const maxLeaf = anchor ? anchor.tree.size : undefined;
    const { picked, total } = inputs ? this.notesFor(asset, amount, inputs, { maxLeaf }) : this.selectNotes(asset, amount, { maxLeaf });
    const outputs = [{ amount, to }, { amount: total - amount, to: this.address }];
    const envelope = await this.buildEnvelope(indexer, { op: OP.TRANSACT, asset, inputs: picked, outputs, anchor });
    return Object.assign(envelope, { spends: picked.map((n) => String(n.nullifier)) });
  }

  /**
   * Mint of `mintAmount` units of `asset` into a private note for this wallet.
   * Bound either to `bindOutpoint` (the UTXO the carrier will spend first) or, when
   * the paying wallet picks inputs itself, to `bindScriptHash` (sha256 of its scriptPubKey).
   */
  async mint(indexer, { asset, mintAmount, bindOutpoint, bindScriptHash }) {
    return this.buildEnvelope(indexer, {
      op: bindScriptHash ? OP.MINT_SCRIPT : OP.MINT, asset, inputs: [], outputs: [{ amount: mintAmount, to: this.address }],
      publicAmount: mintAmount, publicAsset: asset, bindOutpoint, bindScriptHash,
    });
  }

  /**
   * Builds the outputs of one mining claim (mining.md §4.2, §12.1), before any work is done:
   * the PoW challenge commits to them, so they are fixed for the whole search. Synchronous.
   * - `view`: anything with { tree, outputs, height }; the proof is anchored at `refHeight`
   *   (default the view's tip), whose tree is `anchorAt(view, refHeight)`.
   * - `refHash`: the hash of block `refHeight` (display hex or its 32 bytes), from the caller's
   *   own Bitcoin backend.
   * - With `roll`, up to two spendable, unlocked notes of `asset` that are members of
   *   R[refHeight] (largest first) are spent as inputs, so the claim's own note carries their
   *   value plus the reward and a miner keeps one or two notes however many claims land. Lock
   *   them with lockClaim while the claim is pending (W-M).
   * - The own note and the zero-value padding are in a random order (L4: shuffleOutputs).
   * Every call draws fresh blindings, ephemeral keys and dummy inputs, so no two drafts share a
   * commitment or a nullifier: call it again on each new tip and after each found solution.
   * Returns { asset, reward, refHeight, refHash (hex), rolled (nullifier strings), rolledAmount,
   * nullifiers, commitments, ciphertexts, challenge }; the circuit input is kept on the draft as a
   * non-enumerable property for finalizeClaim.
   */
  prepareClaim(view, { asset, reward, refHeight = view?.height, refHash, roll = true } = {}) {
    const a = BigInt(asset);
    const r = BigInt(reward);
    if (a < 0n || a > U64) throw new RangeError("asset must be a u64 id");
    if (r <= 0n || r > I64_MAX) throw new RangeError("reward must be 1 .. 2^63 - 1");
    if (!Number.isSafeInteger(refHeight) || refHeight < 0) throw new RangeError("refHeight must be a block height");
    const refHex = typeof refHash === "string" ? refHash.trim().toLowerCase() : refHash instanceof Uint8Array && refHash.length === 32 ? hex(refHash) : "";
    if (!/^[0-9a-f]{64}$/.test(refHex)) throw new TypeError("refHash must be the 32-byte hash of the reference block");
    const { tree } = anchorAt(view, refHeight);
    const rolled = roll ? this.spendable(a, { maxLeaf: tree.size }).slice(0, 2) : [];
    const rolledAmount = rolled.reduce((s, n) => s + n.amount, 0n);
    if (rolledAmount + r > U64) throw new RangeError("the rolled notes plus the reward exceed one note's amount; claim without rolling");
    const outs = shuffleOutputs([
      { amount: rolledAmount + r, pubkey: this.keys.pk, vpk: this.keys.vpk, blinding: randomField() },
      // Zero-value padding encrypted to a throwaway key, as in buildEnvelope.
      { amount: 0n, pubkey: pubkeyOf(randomField()), vpk: x25519.getPublicKey(x25519.utils.randomSecretKey()), blinding: randomField() },
    ], this.random);
    const input = buildTxInput({
      tree, asset: a, publicAmount: r, publicAsset: a, extDataHash: 0n,
      inputs: rolled.map((n) => ({ amount: n.amount, sk: this.keys.sk, blinding: n.blinding, leafIndex: n.leafIndex })),
      outputs: outs,
    });
    const commitments = input.outputCommitment.map(BigInt);
    const ciphertexts = outs.map((o, i) => encryptNote({ asset: a, amount: o.amount, blinding: o.blinding, vpk: o.vpk, commitment: commitments[i] }));
    const draft = {
      asset: a,
      reward: r,
      refHeight,
      refHash: refHex,
      rolled: rolled.map((n) => String(n.nullifier)),
      rolledAmount,
      nullifiers: input.inputNullifier.map(BigInt),
      commitments,
      ciphertexts,
      challenge: challengeOf({ asset: a, refHeight, refHash: refHex, reward: r, commitments }),
    };
    Object.defineProperty(draft, CLAIM_INPUT, { value: input, enumerable: false });
    return draft;
  }

  /**
   * The claim envelope for a found `nonce` (8 bytes or 16 hex characters): MINE bound to
   * `bindOutpoint` (the coin its carrier spends first, 515 bytes) or MINE_SCRIPT bound to
   * `bindScriptHash` (sha256 of the paying script, 511 bytes). The bind is chosen after the
   * work, so this may run again on the same draft with another bind (a relayer's bind_stale):
   * the solution, and so its solutionId, stays the same. Proves with this.artifacts.
   */
  async finalizeClaim(draft, { bindOutpoint, bindScriptHash } = {}, nonce) {
    const input = draft?.[CLAIM_INPUT];
    if (!input) throw new TypeError("not a claim draft from prepareClaim");
    if (!bindOutpoint === !bindScriptHash) throw new TypeError("a claim needs exactly one bind: { bindOutpoint } or { bindScriptHash }");
    const n = typeof nonce === "string" && /^[0-9a-f]{16}$/i.test(nonce) ? unhex(nonce.toLowerCase()) : nonce;
    if (!(n instanceof Uint8Array) || n.length !== NONCE_LEN) throw new TypeError(`nonce must be ${NONCE_LEN} bytes`);
    const op = bindScriptHash ? OP.MINE_SCRIPT : OP.MINE;
    if (op === undefined) throw new Error("this build cannot encode mining claims");
    const body = encodeTxBody({
      op, anchor: draft.refHeight, publicAsset: draft.asset, publicAmount: draft.reward, bindOutpoint, bindScriptHash, nonce: n,
      nullifiers: draft.nullifiers, commitments: draft.commitments, ciphertexts: draft.ciphertexts,
    });
    const { proof } = await snarkjs.groth16.fullProve({ ...input, extDataHash: extDataHashOf(body).toString() }, this.artifacts.wasm, this.artifacts.zkey);
    const envelope = new Uint8Array(body.length + 128);
    envelope.set(body, 0);
    envelope.set(encodeProof(proof), body.length);
    return envelope;
  }

  /** W-M: the notes rolled into a pending claim stay out of every other spend until it lands or expires. */
  lockClaim(draft) {
    for (const n of draft?.rolled ?? []) this.locked.add(String(n));
    return this;
  }

  /** Releases a claim's rolled notes (it expired, was dropped, or was never submitted). */
  unlockClaim(draft) {
    for (const n of draft?.rolled ?? []) this.locked.delete(String(n));
    return this;
  }

  /**
   * Anchors at the indexer tip: Merkle paths come from the current tree,
   * whose root is exactly R[tip]. With `anchor` ({ height, tree } from
   * anchorAt) the paths and the header anchor come from that older tree.
   * The outputs (recipient and change, or the minted note and its padding) go in a random
   * order (L4: shuffleOutputs); nothing downstream reads meaning into an output's position.
   */
  async buildEnvelope(indexer, opts) {
    const { input, body } = this.draftEnvelope(indexer, opts);
    const { proof } = await snarkjs.groth16.fullProve(input, this.artifacts.wasm, this.artifacts.zkey);
    const envelope = new Uint8Array(body.length + 128);
    envelope.set(body, 0);
    envelope.set(encodeProof(proof), body.length);
    return envelope;
  }

  /**
   * Everything buildEnvelope does before proving, synchronously: -> { input (the circuit input,
   * extDataHash set), body (the envelope without its proof) }.
   */
  draftEnvelope(indexer, { op, asset, inputs, outputs, publicAmount = 0n, publicAsset = 0n, bindOutpoint, bindScriptHash, anchor }) {
    if (anchor && (!anchor.tree || !Number.isSafeInteger(anchor.height))) throw new TypeError("anchor must be { height, tree } from anchorAt");
    const tree = anchor?.tree ?? indexer.tree;
    // anchorAt may hand back the live tree itself: refuse it once a later block has grown it.
    if (anchor?.leaves != null && tree.size !== anchor.leaves) throw new Error(`the tree at block ${anchor.height} changed since it was taken; anchor again`);
    if (anchor && inputs.some((n) => n.leafIndex >= tree.size)) throw tooNew();
    const padded = outputs.map((o) => ({ amount: o.amount, pubkey: o.to.pk, vpk: o.to.vpk, blinding: randomField() }));
    while (padded.length < 2) {
      // Zero-value padding encrypted to a throwaway key: indistinguishable on chain.
      padded.push({ amount: 0n, pubkey: pubkeyOf(randomField()), vpk: x25519.getPublicKey(x25519.utils.randomSecretKey()), blinding: randomField() });
    }
    const outs = shuffleOutputs(padded, this.random);

    const input = buildTxInput({
      tree, asset, publicAmount, publicAsset, extDataHash: 0n,
      inputs: inputs.map((n) => ({ amount: n.amount, sk: this.keys.sk, blinding: n.blinding, leafIndex: n.leafIndex })),
      outputs: outs,
    });
    const ciphertexts = outs.map((o, i) =>
      encryptNote({ asset, amount: o.amount, blinding: o.blinding, vpk: o.vpk, commitment: BigInt(input.outputCommitment[i]) }),
    );
    const body = encodeTxBody({
      op, anchor: anchor?.height ?? indexer.height, publicAsset, publicAmount, bindOutpoint, bindScriptHash,
      nullifiers: input.inputNullifier.map(BigInt),
      commitments: input.outputCommitment.map(BigInt),
      ciphertexts,
    });
    input.extDataHash = extDataHashOf(body).toString();
    return { input, body };
  }
}

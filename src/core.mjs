// Note-pool primitives shared by the wallet, the indexer and the tests.
// Hash layout must match circuits/transaction.circom exactly.
import { poseidon1, poseidon2, poseidon3, poseidon4 } from "poseidon-lite";
import { bytesToBig, randomBytes } from "./bytes.mjs";

/** BN254 scalar field order (the circuit's native field). */
export const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const TREE_LEVELS = 32;
export const N_INS = 2;
export const N_OUTS = 2;

/** Uniform field element below 2^248 (always < FIELD). */
export const randomField = () => bytesToBig(randomBytes(31));

/** Maps a signed integer onto the field (negative -> FIELD - |x|). */
export const toField = (x) => ((BigInt(x) % FIELD) + FIELD) % FIELD;

export const pubkeyOf = (sk) => poseidon1([sk]);

export const commitmentOf = ({ asset, amount, pubkey, blinding }) =>
  poseidon4([asset, amount, pubkey, blinding]);

export const nullifierOf = (commitment, leafIndex, sk) =>
  poseidon3([commitment, leafIndex, poseidon3([sk, commitment, leafIndex])]);

/** Append-only sparse Poseidon Merkle tree; empty leaves are 0. */
export class MerkleTree {
  constructor(levels = TREE_LEVELS) {
    this.levels = levels;
    this.zeros = [0n];
    for (let i = 0; i < levels; i++) this.zeros.push(poseidon2([this.zeros[i], this.zeros[i]]));
    this.layers = Array.from({ length: levels + 1 }, () => new Map());
    this.size = 0;
  }

  node(level, index) {
    return this.layers[level].get(index) ?? this.zeros[level];
  }

  // Indices reach 2^32 - 1, beyond JS 32-bit bitwise ops, so use arithmetic.
  insert(leaf) {
    let index = this.size++;
    this.layers[0].set(index, leaf);
    for (let level = 0; level < this.levels; level++) {
      const left = index - (index % 2);
      const hash = poseidon2([this.node(level, left), this.node(level, left + 1)]);
      index = Math.floor(index / 2);
      this.layers[level + 1].set(index, hash);
    }
    return this.size - 1;
  }

  /** An independent copy (fresh layer maps, shared zeros): the tree at an older height is copy().truncate(n). */
  copy() {
    const t = Object.create(Object.getPrototypeOf(this));
    t.levels = this.levels;
    t.zeros = this.zeros;
    t.layers = this.layers.map((m) => new Map(m));
    t.size = this.size;
    return t;
  }

  /** Drops leaves >= size (reorg rollback). Returns this. */
  truncate(size) {
    if (size > this.size) throw new Error("cannot truncate forward");
    // Nodes whose subtree starts at or after `size` cover only removed leaves.
    for (let level = 0; level <= this.levels; level++) {
      const span = 2 ** level;
      for (const index of this.layers[level].keys()) if (index * span >= size) this.layers[level].delete(index);
    }
    this.size = size;
    if (size === 0) return this;
    // The remaining partially-covered nodes are exactly the ancestors of the last leaf.
    let index = size - 1;
    for (let level = 0; level < this.levels; level++) {
      const left = index - (index % 2);
      const hash = poseidon2([this.node(level, left), this.node(level, left + 1)]);
      index = Math.floor(index / 2);
      this.layers[level + 1].set(index, hash);
    }
    return this;
  }

  root() {
    return this.node(this.levels, 0);
  }

  path(leafIndex) {
    const elements = [];
    let index = leafIndex;
    for (let level = 0; level < this.levels; level++) {
      elements.push(this.node(level, index % 2 ? index - 1 : index + 1));
      index = Math.floor(index / 2);
    }
    return elements;
  }
}

/**
 * Builds the circuit input for one transaction.
 * inputs:  [{ amount, sk, blinding, leafIndex }]  (spent notes, padded with dummies)
 * outputs: [{ amount, pubkey, blinding }]          (padded with zero-value notes)
 */
export function buildTxInput({ tree, asset, inputs, outputs, publicAmount = 0n, publicAsset = 0n, extDataHash }) {
  const ins = [...inputs];
  while (ins.length < N_INS) ins.push({ amount: 0n, sk: randomField(), blinding: randomField(), leafIndex: 0 });
  const outs = [...outputs];
  while (outs.length < N_OUTS) outs.push({ amount: 0n, pubkey: pubkeyOf(randomField()), blinding: randomField() });

  const inCommitments = ins.map((n) => commitmentOf({ asset, amount: n.amount, pubkey: pubkeyOf(n.sk), blinding: n.blinding }));
  const input = {
    root: tree.root(),
    publicAmount: toField(publicAmount),
    publicAsset,
    extDataHash,
    inputNullifier: ins.map((n, i) => nullifierOf(inCommitments[i], BigInt(n.leafIndex), n.sk)),
    outputCommitment: outs.map((n) => commitmentOf({ asset, ...n })),
    asset,
    inAmount: ins.map((n) => n.amount),
    inPrivateKey: ins.map((n) => n.sk),
    inBlinding: ins.map((n) => n.blinding),
    inLeafIndex: ins.map((n) => BigInt(n.leafIndex)),
    inPathElements: ins.map((n) => tree.path(n.leafIndex)),
    outAmount: outs.map((n) => n.amount),
    outPubkey: outs.map((n) => n.pubkey),
    outBlinding: outs.map((n) => n.blinding),
  };
  return stringify(input);
}

const stringify = (v) =>
  Array.isArray(v) ? v.map(stringify) : typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stringify(x)])) : BigInt(v).toString();

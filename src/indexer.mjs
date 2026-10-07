// Deterministic replay of Murkle envelopes (SPEC.md §6). Blocks are fed in
// order as { height, hash?, txs: [{ txid, inputs, outputs: [{ script, value }] }] };
// the block source (bitcoind / esplora) is a separate adapter.
//
// Every check runs before any mutation, so a rejected envelope never changes
// pool state. Each block records an undo entry so reorgs can roll back, and
// each block ends with a state digest (SPEC.md §10) that independent replayers
// compare to prove they computed the same pool.
//
// Mining (SPEC.md §15) applies only at and above the "mining" activation height:
// below it ops 7, 8 and 9 stay "malformed: unknown op N" and the digest stays v1.
import * as snarkjs from "snarkjs";
import { sha256 } from "@noble/hashes/sha256";
import { MerkleTree, toField } from "./core.mjs";
import {
  ATTEST_KIND, MINING_OPS, OP, OP_NAME, decodeEnvelope, findEnvelope, headerOp, isMine, isMint, scriptHashOf,
} from "./envelope.mjs";
import { decodeProof } from "./proof-codec.mjs";
import { isNullOutpoint } from "./btc/block.mjs";
import { bigToBytes, concat, equal, hex, u32le, u64le, unhex } from "./bytes.mjs";
import {
  ACTIVATIONS, DIGEST_V, LABELS, MINE_FEE, MINE_WINDOW, PROTOCOL, SNAPSHOT_VERSION, STRICT_TICKER, VERSION, mineFeeReady,
  activationHeight, digestTag, digestVersionAt,
} from "./params.mjs";
import * as M from "./mine.mjs";

export const ANCHOR_WINDOW = 100; // W
export const MIN_ANCHOR_DEPTH = 1; // Kmin
export const UNDO_DEPTH = 144;

export const assetIdOf = (height, txIndex) => (BigInt(height) << 32n) | BigInt(txIndex);

/** Why a mint of `asset` at block `height` is refused by its terms, or null. Clients check it before paying. */
export function mintClosed(asset, height) {
  if (height < asset.startHeight || (asset.endHeight !== 0 && height > asset.endHeight)) return "mint closed";
  if (asset.minted >= asset.mintCap) return "mint cap reached";
  return null;
}

const ZERO32 = new Uint8Array(32);
const DIGEST_TAG = new TextEncoder().encode(LABELS.digest);
const HEX32 = /^[0-9a-f]{64}$/;
const STAT_KEY = {
  [OP.DEPLOY]: "deploy", [OP.MINT]: "mint", [OP.MINT_SCRIPT]: "mint", [OP.TRANSACT]: "transact", [OP.ATTEST]: "attest",
  [OP.MINE]: "mine", [OP.MINE_SCRIPT]: "mine", [OP.DEPLOY_POW]: "deploy",
};
// Per-asset fields restored from the undo log (minted/pool have their own journal).
const ASSET_STAT_FIELDS = ["firstMintHeight", "soldOutHeight", "treasurySats", "rejectedMints", "burnedSats"];
// Per mined asset, journaled on the first touch in a block (dPts copied).
const MINE_FIELDS = ["claims", "issued", "pool", "rejectedClaims", "burnedFeeSats", "feeSats", "firstClaimHeight", "minedOutHeight"];
const MINE_BIG_FIELDS = ["issued", "pool", "burnedFeeSats", "feeSats"];
const POW_TERM_BIG = ["reward", "maxSupply", "initialDifficulty", "minDifficulty", "claimFeeSats"];
// Snapshot format before mining (still written and read while no activation is at or below the height).
const SNAPSHOT_V2 = 2;

const emptyStats = () => ({
  accepted: { deploy: 0, mint: 0, transact: 0, attest: 0 },
  rejected: 0,
  outputsByHeight: [],
  transfersByHeight: [],
});

/** Adds `n` to the [height, count] series; series only ever grow at the tip. */
function bump(series, height, n = 1) {
  const last = series[series.length - 1];
  if (last && last[0] === height) last[1] += n;
  else series.push([height, n]);
}
/** Drops series entries above `height` (rollback). */
function trimSeries(series, height) {
  while (series.length && series[series.length - 1][0] > height) series.pop();
}

function txidBytes(txid) {
  if (!HEX32.test(txid)) throw new Error(`bad txid ${txid}`);
  return unhex(txid);
}

function checkGenesisOption(genesis) {
  if (!genesis) return null;
  const txid = String(genesis.txid ?? "").toLowerCase();
  const manifestSha256 = String(genesis.manifestSha256 ?? "").toLowerCase();
  if (!HEX32.test(txid) || !HEX32.test(manifestSha256)) throw new Error("genesis needs a 32-byte hex txid and manifestSha256");
  return { txid, manifestSha256 };
}

const copyPts = (pts) => pts.map(([h, d]) => [h, d]);
const powAsset = (a) => a?.kind === "pow";

export class Indexer {
  /**
   * @param startHeight first block that may contain envelopes (the activation height).
   * @param genesis { txid, manifestSha256 } that block must carry as ATTEST kind 1, or null (pre-genesis / tests).
   * @param activations consensus changes after v1 ([{ name, height, digestV }], src/pins.json by default).
   * @param pow Argon2 backend { hash(password), hashMany?(passwords) }: inlinePow, or a PowPool on the server.
   * @param mineFee the service-fee constants (MINE_FEE of this network).
   * @param strictTicker SPEC.md §7 ticker rule: raw ticker bytes (mainnet from genesis) or the historical decoder (signet).
   */
  constructor({ vkey, startHeight, genesis = null, activations = ACTIVATIONS, pow = M.inlinePow, mineFee = MINE_FEE, strictTicker = STRICT_TICKER }) {
    // Contract §2: activation heights lie strictly above the genesis activation height (this
    // indexer's genesis rule when it has one, else the pinned one). A replay may start above an
    // activation (murkle audit --from h): the table is not checked against startHeight.
    M.assertActivations(activations, { genesisHeight: genesis?.height ?? undefined });
    if (activationHeight("mining", activations) != null) {
      // A placeholder rule (mainnet before the owner sets it) is refused with its reason, not a type error.
      const missing = mineFee ? mineFeeReady(mineFee) : null;
      if (missing) throw new Error(`mining activation needs a complete MINE_FEE: ${missing}`);
      M.assertMineFee(mineFee);
    }
    this.vkey = vkey;
    this.startHeight = startHeight;
    this.genesis = checkGenesisOption(genesis);
    this.activations = activations.map((a) => Object.freeze({ ...a }));
    this.pow = pow;
    this.mineFee = mineFee;
    this.strictTicker = !!strictTicker;
    this.hashes = new Map(); // height -> block hash (display hex); kept for every height
    this.tree = new MerkleTree();
    this.nullifiers = new Set();
    this.roots = new Map([[startHeight - 1, this.tree.root()]]); // kept for every height
    this.assets = new Map(); // id -> deploy terms + { minted, pool } + stats (kind "mint" | "pow")
    this.tickers = new Map(); // ticker -> id
    this.outputs = []; // accepted outputs, index = leaf index (for wallet scanning)
    this.height = startHeight - 1;
    this.undo = [];
    this.log = []; // full log; entry.seq === its index
    this.digests = new Map(); // height -> digest hex, never pruned
    this.logAcc = ZERO32;
    this.nullAcc = ZERO32;
    this.stats = emptyStats();
    this.claimed = new Map(); // solutionId hex -> refHeight (pruned after MINE_WINDOW + UNDO_DEPTH)
    this.mineAcc = ZERO32;
  }

  // ---------------------------------------------------------------- activation

  /** The mining activation height of this replay, or null (mining off). */
  get miningHeight() {
    return activationHeight("mining", this.activations);
  }
  miningActive(height) {
    const h = this.miningHeight;
    return h != null && height >= h;
  }
  digestVersionAt(height) {
    return digestVersionAt(height, this.activations);
  }

  /** SPEC.md §15 activation gate, on the header before strict decoding: an op 7, 8 or 9 below activation. */
  gatedOp(payload, height) {
    return payload.length >= 5 && payload[3] === VERSION && MINING_OPS.has(payload[4]) && !this.miningActive(height);
  }

  async applyBlock(block) {
    if (block.height !== this.height + 1) throw new Error(`expected block ${this.height + 1}, got ${block.height}`);
    if (this.genesis && block.height === this.startHeight) this.checkGenesis(block);
    const H = block.height;
    const undo = {
      height: H,
      leaves: this.tree.size,
      nullifiers: [],
      assets: [],
      minted: [],
      logLen: this.log.length,
      logAcc: this.logAcc,
      nullAcc: this.nullAcc,
      stats: { accepted: { ...this.stats.accepted }, rejected: this.stats.rejected },
      assetStats: [],
      mine: [],
      mineAcc: this.mineAcc,
      claimed: [],
    };
    // Per-block PoW memo by solutionId (never across blocks) and the work counted per mined asset.
    const memo = new Map();
    const work = new Map();

    // All or nothing: a throw mid-block (a failed prevout lookup, an Argon2 error, a dead
    // worker) undoes the transactions already applied, so a retry starts from the same state.
    try {
      if (this.miningActive(H)) await this.prePass(block, memo);
      for (const [txIndex, tx] of block.txs.entries()) {
        const payload = findEnvelope(tx);
        if (!payload) continue;
        const at = { height: H, index: txIndex, txid: tx.txid };
        if (this.gatedOp(payload, H)) {
          this.record(at, payload[4], false, { reason: `malformed: unknown op ${payload[4]}` }, "UNKNOWN");
          continue;
        }
        let env;
        try {
          env = decodeEnvelope(payload, { strictTicker: this.strictTicker });
        } catch (e) {
          const op = headerOp(payload);
          this.record(at, op, false, { reason: `malformed: ${e.message}` }, MINING_OPS.has(op) && !this.miningActive(H) ? "UNKNOWN" : undefined);
          continue;
        }
        if (env.op === OP.ATTEST) {
          // A public statement only: it is logged and digested, never changes the pool.
          this.record(at, env.op, true, { kind: env.kind, hash: hex(env.hash) });
          continue;
        }
        if (env.op === OP.DEPLOY_POW) {
          const verdict = this.checkDeployPow(env, H);
          if (verdict !== true) {
            this.record(at, env.op, false, { reason: verdict, ...this.details(env) });
            continue;
          }
          const id = assetIdOf(H, txIndex);
          this.applyDeployPow(env, id, payload, at, undo);
          this.record(at, env.op, true, this.details(env, id));
          continue;
        }
        if (isMine(env.op)) {
          const verdict = await this.checkMine(env, tx, H, { memo });
          if (verdict !== true) {
            this.noteRejectedClaim(env, tx, undo);
            this.record(at, env.op, false, { reason: verdict, ...this.details(env) });
            continue;
          }
          const dEff = this.applyMine(env, tx, H, undo, work);
          this.record(at, env.op, true, { ...this.details(env), difficulty: dEff.toString() });
          continue;
        }
        const verdict = env.op === OP.DEPLOY ? this.checkDeploy(env) : await this.checkTx(env, tx, H);
        if (verdict !== true) {
          if (isMint(env.op)) this.noteRejectedMint(env, tx, undo);
          this.record(at, env.op, false, { reason: verdict, ...this.details(env) });
          continue;
        }
        const id = env.op === OP.DEPLOY ? assetIdOf(H, txIndex) : undefined;
        if (env.op === OP.DEPLOY) this.applyDeploy(env, id, payload, at, undo);
        else this.applyTx(env, tx, H, undo);
        this.record(at, env.op, true, this.details(env, id));
      }
      if (this.miningActive(H)) this.endBlockMining(H, work, undo);
    } catch (e) {
      this.revert(undo);
      throw e;
    }

    const root = this.tree.root();
    this.roots.set(H, root);
    if (block.hash) this.hashes.set(H, block.hash);
    this.digests.set(H, hex(this.computeDigest(H, block.hash, root)));
    this.height = H;
    this.undo.push(undo);
    if (this.undo.length > UNDO_DEPTH) this.undo.shift();
  }

  /**
   * Genesis rule: the activation block must contain the pinned genesis tx, and
   * it must carry ATTEST kind 1 over the pinned manifest hash. Anything else
   * means this replay runs against different artifacts or a different chain.
   */
  checkGenesis(block) {
    const tx = block.txs.find((t) => t.txid === this.genesis.txid);
    const payload = tx && findEnvelope(tx);
    let env = null;
    try {
      env = payload ? decodeEnvelope(payload, { strictTicker: this.strictTicker }) : null;
    } catch {
      env = null;
    }
    const ok = env?.op === OP.ATTEST && env.kind === ATTEST_KIND.GENESIS && hex(env.hash) === this.genesis.manifestSha256;
    if (!ok) throw new Error("genesis mismatch");
  }

  /** Appends a log entry and folds it into the log accumulator (rejections included). `opName` overrides the display name. */
  record(at, op, ok, extra = {}, opName = undefined) {
    const entry = { seq: this.log.length, ...at, op, opName: opName ?? OP_NAME[op] ?? "UNKNOWN", ok, ...extra };
    this.log.push(entry);
    this.logAcc = sha256(concat(this.logAcc, txidBytes(at.txid), new Uint8Array([ok ? 1 : 0, op & 0xff])));
    if (ok) this.stats.accepted[STAT_KEY[op]] = (this.stats.accepted[STAT_KEY[op]] ?? 0) + 1;
    else this.stats.rejected += 1;
  }

  /**
   * Public fields a log entry may show. TRANSACT shows nothing beyond its op:
   * its asset and amounts are private. `deployedId` is set for an accepted DEPLOY.
   * A MINE shows its token, reward and reference height, never a recipient.
   */
  details(env, deployedId) {
    if (env.op === OP.DEPLOY || env.op === OP.DEPLOY_POW) return { ...(deployedId !== undefined ? { asset: deployedId.toString() } : {}), ticker: env.ticker };
    if (isMint(env.op) || isMine(env.op)) {
      const asset = this.assets.get(env.publicAsset);
      return {
        asset: env.publicAsset.toString(), ...(asset ? { ticker: asset.ticker } : {}), amount: env.publicAmount.toString(),
        ...(isMine(env.op) ? { ref: env.refHeight } : {}),
      };
    }
    return {};
  }

  checkDeploy(env) {
    if (this.tickers.has(env.ticker)) return `ticker ${env.ticker} already deployed`;
    return true;
  }

  applyDeploy(env, id, payload, at, undo) {
    const asset = {
      ...env,
      kind: "mint",
      id,
      minted: 0,
      pool: 0n,
      bodyHash: hex(sha256(payload)),
      deployTxid: at.txid,
      deployHeight: at.height,
      firstMintHeight: null,
      soldOutHeight: null,
      treasurySats: 0n,
      rejectedMints: 0,
      burnedSats: 0n,
      mintsByHeight: [],
    };
    this.assets.set(id, asset);
    this.tickers.set(env.ticker, id);
    undo.assets.push(id);
  }

  /** DEPLOY_POW indexer rules (structure is checked by the decoder): true or a reason. */
  checkDeployPow(env, height) {
    const fee = M.checkFeePolicy(env.claimFeeSats, env.treasury, this.mineFee);
    if (fee) return fee;
    const mineStart = M.mineStartOf({ startHeight: env.startHeight, deployHeight: height });
    if (env.endHeight !== 0 && env.endHeight < mineStart) return "malformed: end before mining start";
    if (this.tickers.has(env.ticker)) return `ticker ${env.ticker} already deployed`;
    return true;
  }

  applyDeployPow(env, id, payload, at, undo) {
    const mineStart = M.mineStartOf({ startHeight: env.startHeight, deployHeight: at.height });
    const asset = {
      ...env,
      kind: "pow",
      id,
      bodyHash: hex(sha256(payload)),
      deployTxid: at.txid,
      deployHeight: at.height,
      mineStart,
      claims: 0,
      issued: 0n,
      pool: 0n,
      dPts: [[mineStart, env.initialDifficulty]],
      rejectedClaims: 0,
      burnedFeeSats: 0n,
      feeSats: 0n,
      firstClaimHeight: null,
      minedOutHeight: null,
      claimsByHeight: [],
    };
    this.assets.set(id, asset);
    this.tickers.set(env.ticker, id);
    undo.assets.push(id);
  }

  /**
   * Sats a transaction pays to an asset's treasury script (0 for a free mint): the gross sum
   * of those outputs, including any change a payer sends back to the treasury script, since
   * inputs are never resolved. The price rule and the treasurySats/burnedSats stats both use
   * it, so those stats count sats sent to the treasury address, not net revenue (SPEC section 11).
   */
  treasuryPaid(asset, tx) {
    if (!asset.treasury.length) return 0n;
    return tx.outputs.filter((o) => equal(o.script, asset.treasury)).reduce((sum, o) => sum + BigInt(o.value), 0n);
  }

  /** Saves an asset's stat fields in the block's undo entry the first time the block touches it. */
  touch(asset, undo) {
    if (undo.assetStats.some(([id]) => id === asset.id)) return;
    undo.assetStats.push([asset.id, Object.fromEntries(ASSET_STAT_FIELDS.map((k) => [k, asset[k]]))]);
  }

  /** Journals a mined asset's state (and a copy of its difficulty points) on the block's first touch. */
  touchMine(asset, undo) {
    if (undo.mine.some(([id]) => id === asset.id)) return;
    undo.mine.push([asset.id, { ...Object.fromEntries(MINE_FIELDS.map((k) => [k, asset[k]])), dPts: copyPts(asset.dPts) }]);
  }

  /** A rejected mint of a known asset still paid its treasury: those sats are burned, as with Runes. */
  noteRejectedMint(env, tx, undo) {
    const asset = this.assets.get(env.publicAsset);
    if (!asset || powAsset(asset)) return;
    this.touch(asset, undo);
    asset.rejectedMints += 1;
    asset.burnedSats += this.treasuryPaid(asset, tx);
  }

  /** A rejected claim of a known mined asset: its fee outputs are spent anyway. */
  noteRejectedClaim(env, tx, undo) {
    const asset = this.assets.get(env.publicAsset);
    if (!powAsset(asset)) return;
    this.touchMine(asset, undo);
    asset.rejectedClaims += 1;
    asset.burnedFeeSats += M.feeOutputsPaid(asset, tx, this.mineFee).paid;
  }

  /** Groth16 verification (a method so tests can spy on it). */
  verifyGroth16(publicSignals, proof) {
    return snarkjs.groth16.verify(this.vkey, publicSignals, proof);
  }

  /** Returns true or a rejection reason. Never mutates state. */
  async checkTx(env, tx, height) {
    if (isMine(env.op)) {
      if (!this.miningActive(height)) return `malformed: unknown op ${env.op}`;
      return this.checkMine(env, tx, height);
    }
    if (env.op === OP.TRANSACT) {
      // MVP: private pool only, value can neither enter nor leave via TRANSACT.
      if (env.publicAmount !== 0n || env.publicAsset !== 0n) return "TRANSACT must not move public value";
    } else if (isMint(env.op)) {
      // Audit A-6: a MINT is only valid in a transaction whose first input the minter
      // controls (a named outpoint, or any coin of a named scriptPubKey), so a copy
      // rebroadcast by someone else cannot burn the minter's payment.
      const first = tx.inputs?.[0]?.outpoint;
      if (!first) return "MINT not bound to this transaction";
      if (env.op === OP.MINT && !equal(first, env.bindOutpoint)) return "MINT not bound to this transaction";
      if (env.op === OP.MINT_SCRIPT) {
        // A coinbase spends no coin, so it has no payer: rejected without a prevout lookup.
        if (isNullOutpoint(first)) return "MINT not bound to this payer";
        // The prevout lookup (network I/O) runs last, after the Groth16 check below (mining.md
        // §13.1, SPEC §6): every rule must pass either way, so the order changes reasons, never
        // verdicts or the digest, and an envelope without a valid proof never costs a lookup.
      }
      const asset = this.assets.get(env.publicAsset);
      if (!asset) return "unknown asset";
      if (powAsset(asset)) return "asset is mined";
      if (env.publicAmount !== asset.mintAmount) return "mint amount differs from terms";
      const closed = mintClosed(asset, height);
      if (closed) return closed;
      const paid = this.treasuryPaid(asset, tx);
      if (paid < asset.priceSats) return `underpaid: ${paid} < ${asset.priceSats} sats`;
    } else {
      return "not a proof-carrying operation";
    }

    if (env.anchor < height - ANCHOR_WINDOW || env.anchor > height - MIN_ANCHOR_DEPTH) return "anchor outside window";
    const root = this.roots.get(env.anchor);
    if (root === undefined) return "unknown anchor";

    const [n0, n1] = env.nullifiers.map(String);
    if (n0 === n1) return "duplicate nullifier in envelope";
    if (this.nullifiers.has(n0) || this.nullifiers.has(n1)) return "nullifier already spent";

    let proof;
    try {
      proof = decodeProof(env.proof);
    } catch (e) {
      return `invalid proof encoding: ${e.message}`;
    }
    const publicSignals = [root, toField(env.publicAmount), env.publicAsset, env.extDataHash, ...env.nullifiers, ...env.commitments].map(String);
    if (!(await this.verifyGroth16(publicSignals, proof))) return "proof does not verify";
    if (env.op === OP.MINT_SCRIPT) {
      if (!this.prevoutScript) return "cannot resolve the spent output (no prevout resolver)";
      const spent = await this.prevoutScript(tx.inputs[0].outpoint);
      if (!equal(scriptHashOf(spent), env.bindScriptHash)) return "MINT not bound to this payer";
    }
    return true;
  }

  applyTx(env, tx, height, undo) {
    env.nullifiers.forEach((n) => {
      this.nullifiers.add(String(n));
      undo.nullifiers.push(String(n));
      this.nullAcc = sha256(concat(this.nullAcc, bigToBytes(n, 32)));
    });
    env.commitments.forEach((commitment, i) => {
      const leafIndex = this.tree.insert(commitment);
      this.outputs.push({ leafIndex, commitment, ciphertext: env.ciphertexts[i], height, txid: tx.txid });
    });
    bump(this.stats.outputsByHeight, height, env.commitments.length);
    if (env.op === OP.TRANSACT) bump(this.stats.transfersByHeight, height);
    if (isMint(env.op)) {
      const asset = this.assets.get(env.publicAsset);
      this.touch(asset, undo);
      asset.minted += 1;
      asset.pool += env.publicAmount;
      asset.treasurySats += this.treasuryPaid(asset, tx);
      asset.firstMintHeight ??= height;
      if (asset.minted === asset.mintCap) asset.soldOutHeight = height;
      bump(asset.mintsByHeight, height);
      undo.minted.push([env.publicAsset, env.publicAmount]);
    }
  }

  // ---------------------------------------------------------------- mining (SPEC.md §15)

  /** Helpers by asset id (pages, relayer, CLI). */
  difficultyAt(assetId, h) { return M.difficultyAt(this.minedAsset(assetId), h); }
  effectiveDifficulty(assetId, ref, height) { return M.effectiveDifficulty(this.minedAsset(assetId), ref, height); }
  rewardAt(assetId, ref) { return M.rewardAt(this.minedAsset(assetId), ref); }
  requiredFeeOutputs(assetId) { return M.requiredFeeOutputs(this.minedAsset(assetId), this.mineFee); }
  minedAsset(assetId) {
    const a = this.assets.get(BigInt(assetId));
    if (!powAsset(a)) throw new Error(`asset ${assetId} is not mined`);
    return a;
  }

  /** { challenge, password, solutionId, solutionIdHex } of a MINE envelope, or null (unknown reference block, or not a mined asset). */
  claimOf(env) {
    const asset = this.assets.get(env.publicAsset);
    if (!powAsset(asset)) return null;
    const refHash = this.hashes.get(env.refHeight);
    if (!refHash) return null;
    return M.claimPreimage({
      asset: env.publicAsset, refHeight: env.refHeight, refHash, reward: env.publicAmount, commitments: env.commitments, nonce: env.nonce,
    });
  }

  /** Rules 2-6: asset, window, reference block, reward, supply. Pure. */
  mineStatic(env, height) {
    const asset = this.assets.get(env.publicAsset);
    if (!asset) return "unknown asset";
    if (!powAsset(asset)) return "asset is not mined";
    const ref = env.refHeight;
    if (ref < height - MINE_WINDOW || ref > height - 1) return "reference outside window";
    if (ref < asset.mineStart) return "mining not started";
    if (asset.endHeight !== 0 && ref > asset.endHeight) return "mining closed";
    if (!this.hashes.has(ref) || !this.roots.has(ref)) return "unknown reference block";
    const r = M.rewardAt(asset, ref);
    if (r === 0n) return "mining ended";
    if (env.publicAmount !== r) return "reward differs from terms";
    if (asset.issued + r > asset.maxSupply) return "supply cap reached";
    return true;
  }

  /** Rules 7-8: service-fee outputs and the cheap part of the bind. Pure. */
  mineCarrier(env, tx) {
    const asset = this.assets.get(env.publicAsset);
    if (!powAsset(asset)) return "asset is not mined";
    const paid = M.feeOutputsPaid(asset, tx, this.mineFee);
    if (!paid.ok) {
      const s = paid.short[0];
      return `underpaid service fee: ${s.paid} < ${s.need} sats to ${s.script}`;
    }
    const first = tx.inputs?.[0]?.outpoint;
    if (!first) return "MINE not bound to this transaction";
    if (env.op === OP.MINE && !equal(first, env.bindOutpoint)) return "MINE not bound to this transaction";
    if (env.op === OP.MINE_SCRIPT && isNullOutpoint(first)) return "MINE not bound to this payer";
    return true;
  }

  /** Rules 9-10: nullifiers, claimed solutions. Pure. */
  mineState(env) {
    const [n0, n1] = env.nullifiers.map(String);
    if (n0 === n1) return "duplicate nullifier in envelope";
    if (this.nullifiers.has(n0) || this.nullifiers.has(n1)) return "nullifier already spent";
    const claim = this.claimOf(env);
    if (claim && this.claimed.has(claim.solutionIdHex)) return "solution already claimed";
    return true;
  }

  /** Argon2 of a claim through the per-block memo (one evaluation per solutionId). Errors propagate. */
  powOf(claim, memo) {
    let p = memo?.get(claim.solutionIdHex);
    if (!p) {
      p = Promise.resolve().then(() => this.pow.hash(claim.password));
      memo?.set(claim.solutionIdHex, p);
    }
    return p;
  }

  /** Rule 11: powHash <= target(D_eff). Any thrown error propagates (never a verdict). */
  async minePow(env, height, { memo } = {}) {
    const asset = this.assets.get(env.publicAsset);
    const claim = this.claimOf(env);
    if (!claim) return "unknown reference block";
    const dEff = M.effectiveDifficulty(asset, env.refHeight, height);
    const h = await this.powOf(claim, memo);
    if (!(h instanceof Uint8Array) || h.length !== 32) throw Object.assign(new Error("Argon2 backend returned a malformed hash"), { code: "POW_FAILED" });
    return M.meetsTarget(h, M.targetOf(dEff)) ? true : "insufficient work";
  }

  /** Rule 12: proof encoding and Groth16 with [R[ref], reward, asset, extDataHash, n0, n1, c0, c1]. */
  async mineProof(env) {
    let proof;
    try {
      proof = decodeProof(env.proof);
    } catch (e) {
      return `invalid proof encoding: ${e.message}`;
    }
    const root = this.roots.get(env.refHeight);
    if (root === undefined) return "unknown reference block";
    const publicSignals = [root, toField(env.publicAmount), env.publicAsset, env.extDataHash, ...env.nullifiers, ...env.commitments].map(String);
    if (!(await this.verifyGroth16(publicSignals, proof))) return "proof does not verify";
    return true;
  }

  /** Rule 13 (MINE_SCRIPT only): the prevout lookup. A throwing resolver propagates. */
  async mineBind(env, tx) {
    if (env.op !== OP.MINE_SCRIPT) return true;
    if (!this.prevoutScript) return "cannot resolve the spent output (no prevout resolver)";
    const spent = await this.prevoutScript(tx.inputs[0].outpoint);
    if (!equal(scriptHashOf(spent), env.bindScriptHash)) return "MINE not bound to this payer";
    return true;
  }

  /** Every MINE rule in order (cheap, Argon2, pairing, I/O); the first reason, or true. Never mutates. */
  async checkMine(env, tx, height, { memo } = {}) {
    for (const step of [
      () => this.mineStatic(env, height),
      () => this.mineCarrier(env, tx),
      () => this.mineState(env),
      () => this.minePow(env, height, { memo }),
      () => this.mineProof(env),
      () => this.mineBind(env, tx),
    ]) {
      const v = await step();
      if (v !== true) return v;
    }
    return true;
  }

  /**
   * Parallel pre-pass: the passwords of claims that pass the stateless rules and whose
   * nullifiers and solution are unused at the start of the block, distinct by solutionId,
   * evaluated in one hashMany call; seeds the block memo. Errors propagate (block retried).
   */
  async prePass(block, memo) {
    const H = block.height;
    const seen = new Map();
    for (const tx of block.txs) {
      const payload = findEnvelope(tx);
      if (!payload || payload.length < 5 || payload[3] !== VERSION || (payload[4] !== OP.MINE && payload[4] !== OP.MINE_SCRIPT)) continue;
      let env;
      try {
        env = decodeEnvelope(payload, { strictTicker: this.strictTicker });
      } catch {
        continue;
      }
      if (this.mineStatic(env, H) !== true || this.mineCarrier(env, tx) !== true || this.mineState(env) !== true) continue;
      const claim = this.claimOf(env);
      if (claim && !seen.has(claim.solutionIdHex)) seen.set(claim.solutionIdHex, claim.password);
    }
    if (!seen.size) return;
    const ids = [...seen.keys()];
    const passwords = [...seen.values()];
    const hashes = typeof this.pow.hashMany === "function"
      ? await this.pow.hashMany(passwords)
      : await Promise.all(passwords.map((p) => this.pow.hash(p)));
    ids.forEach((id, i) => memo.set(id, Promise.resolve(hashes[i])));
  }

  /** Applies an accepted claim; returns its D_eff (the work it counts). */
  applyMine(env, tx, height, undo, work) {
    const asset = this.assets.get(env.publicAsset);
    const claim = this.claimOf(env);
    const dEff = M.effectiveDifficulty(asset, env.refHeight, height);
    this.touchMine(asset, undo);
    this.applyTx(env, tx, height, undo);
    asset.claims += 1;
    asset.issued += env.publicAmount;
    asset.pool = asset.issued;
    asset.feeSats += M.feeOutputsPaid(asset, tx, this.mineFee).paid;
    asset.firstClaimHeight ??= height;
    if (asset.minedOutHeight == null && asset.issued + M.rewardAt(asset, height) > asset.maxSupply) asset.minedOutHeight = height;
    work.set(asset.id, (work.get(asset.id) ?? 0n) + dEff);
    this.claimed.set(claim.solutionIdHex, env.refHeight);
    undo.claimed.push(claim.solutionIdHex);
    this.mineAcc = sha256(concat(this.mineAcc, claim.solutionId));
    bump(asset.claimsByHeight, height);
    return dEff;
  }

  /** End of block (inside the revert scope): difficulty points, then pruning. */
  endBlockMining(H, work, undo) {
    for (const [id, w] of work) {
      if (w <= 0n) continue;
      const a = this.assets.get(id);
      this.touchMine(a, undo);
      const terms = { span: a.span, targetPerSpan: a.targetPerSpan, minDifficulty: a.minDifficulty };
      a.dPts.push([H, M.stepDifficulty(M.difficultyAt(a, H - 1), w, terms)]);
    }
    // Keep the newest point at or below H - MINE_WINDOW - 1 and everything after it (<= 14 points).
    const cut = H - MINE_WINDOW - 1;
    for (const [id] of undo.mine) {
      const a = this.assets.get(id);
      if (!a) continue;
      let keep = -1;
      for (let i = 0; i < a.dPts.length; i++) if (a.dPts[i][0] <= cut) keep = i;
      if (keep > 0) a.dPts = a.dPts.slice(keep);
    }
    // Claimed solutions can only matter while H <= ref + 12; the UNDO_DEPTH lag keeps pruning reorg-safe.
    const old = H - MINE_WINDOW - UNDO_DEPTH;
    for (const [id, ref] of this.claimed) if (ref < old) this.claimed.delete(id);
  }

  // ---------------------------------------------------------------- digest

  /** sha256 over the paid-mint asset table sorted by id: id u64 ‖ minted u32 ‖ pool u64 ‖ sha256(deploy body). */
  assetsHash() {
    const ids = [...this.assets.keys()].filter((id) => !powAsset(this.assets.get(id))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return sha256(concat(...ids.map((id) => {
      const a = this.assets.get(id);
      return concat(u64le(id), u32le(a.minted), u64le(a.pool), unhex(a.bodyHash));
    })));
  }

  /** sha256 over mined assets sorted by id: id u64 ‖ claims u64 ‖ issued u64 ‖ dHeight u32 ‖ dValue u64 ‖ sha256(deploy body). */
  minedHash() {
    const ids = [...this.assets.keys()].filter((id) => powAsset(this.assets.get(id))).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return sha256(concat(...ids.map((id) => {
      const a = this.assets.get(id);
      const [dHeight, dValue] = a.dPts[a.dPts.length - 1];
      return concat(u64le(id), u64le(a.claims), u64le(a.issued), u32le(dHeight), u64le(dValue), unhex(a.bodyHash));
    })));
  }

  /**
   * v1: sha256(tag ‖ h u32 LE ‖ blockHash ‖ root 32 BE ‖ nullAcc ‖ logAcc ‖ assetsHash);
   * v2 (mining): … ‖ assetsHash ‖ minedHash ‖ mineAcc with tag "murkle/digest/v2". SPEC.md §10.
   */
  computeDigest(height, blockHash, root) {
    const v = this.digestVersionAt(height);
    const common = [
      u32le(height),
      blockHash ? unhex(blockHash) : ZERO32,
      bigToBytes(root, 32),
      this.nullAcc,
      this.logAcc,
      this.assetsHash(),
    ];
    if (v === 1) return sha256(concat(DIGEST_TAG, ...common));
    return sha256(concat(new TextEncoder().encode(digestTag(v)), ...common, this.minedHash(), this.mineAcc));
  }

  /** Digest hex after block `height`, or null if that block is not applied. */
  digestAt(height) {
    return this.digests.get(height) ?? null;
  }

  /** Undoes the pool, log and stats changes journaled in undo entry `u` (a whole or a partial block). */
  revert(u) {
    this.tree.truncate(u.leaves);
    this.outputs.length = u.leaves;
    u.nullifiers.forEach((n) => this.nullifiers.delete(n));
    for (const [id, amount] of u.minted) {
      const asset = this.assets.get(id);
      asset.minted -= 1;
      asset.pool -= amount;
    }
    for (const [id, saved] of u.assetStats) {
      const asset = this.assets.get(id);
      if (!asset) continue;
      Object.assign(asset, saved);
      trimSeries(asset.mintsByHeight, u.height - 1);
    }
    for (const [id, saved] of u.mine ?? []) {
      const asset = this.assets.get(id);
      if (!asset) continue;
      Object.assign(asset, saved, { dPts: copyPts(saved.dPts) });
      trimSeries(asset.claimsByHeight, u.height - 1);
    }
    for (const id of u.claimed ?? []) this.claimed.delete(id);
    if (u.mineAcc) this.mineAcc = u.mineAcc;
    for (const id of u.assets) {
      this.tickers.delete(this.assets.get(id).ticker);
      this.assets.delete(id);
    }
    this.log.length = u.logLen;
    this.logAcc = u.logAcc;
    this.nullAcc = u.nullAcc;
    this.stats.accepted = { ...u.stats.accepted };
    this.stats.rejected = u.stats.rejected;
    trimSeries(this.stats.outputsByHeight, u.height - 1);
    trimSeries(this.stats.transfersByHeight, u.height - 1);
  }

  /** Rolls state back so that `height` is the last applied block. */
  rollbackTo(height) {
    while (this.height > height) {
      const u = this.undo.pop();
      if (!u || u.height !== this.height) throw new Error("reorg deeper than undo log; full resync needed");
      this.revert(u);
      this.roots.delete(this.height);
      this.hashes.delete(this.height);
      this.digests.delete(this.height);
      this.height -= 1;
    }
  }

  // ---------------------------------------------------------------- snapshot

  /**
   * JSON-safe state. The tree is rebuilt from the ordered output commitments. Version 3 (mining
   * state, activation table) once any activation is at or below the height; until then the
   * version 2 layout, which holds the whole state there (no mined asset can exist yet).
   */
  snapshot() {
    const s = (v) => v.toString();
    const statsOf = (st) => ({ ...st, treasurySats: s(st.treasurySats), burnedSats: s(st.burnedSats) });
    const v3 = this.digestVersionAt(this.height) >= 2 || this.claimed.size > 0 || [...this.assets.values()].some(powAsset);
    const mineOf = (st) => ({
      ...st, ...Object.fromEntries(MINE_BIG_FIELDS.map((k) => [k, s(st[k])])), dPts: st.dPts.map(([h, d]) => [h, s(d)]),
    });
    const assetOut = (a) => {
      if (powAsset(a)) {
        return {
          ...a,
          id: s(a.id),
          ...Object.fromEntries(POW_TERM_BIG.map((k) => [k, s(a[k])])),
          ...Object.fromEntries(MINE_BIG_FIELDS.map((k) => [k, s(a[k])])),
          treasury: hex(a.treasury),
          dPts: a.dPts.map(([h, d]) => [h, s(d)]),
          claimsByHeight: a.claimsByHeight.map((p) => [...p]),
        };
      }
      const { kind, ...rest } = a;
      return {
        ...(v3 ? a : rest),
        id: s(a.id),
        mintAmount: s(a.mintAmount),
        priceSats: s(a.priceSats),
        pool: s(a.pool),
        treasury: hex(a.treasury),
        treasurySats: s(a.treasurySats),
        burnedSats: s(a.burnedSats),
        mintsByHeight: a.mintsByHeight.map((p) => [...p]),
      };
    };
    const undoOut = (u) => {
      const { mine, mineAcc, claimed, ...rest } = u;
      const base = {
        ...rest,
        assets: u.assets.map(s),
        minted: u.minted.map(([id, amt]) => [s(id), s(amt)]),
        logAcc: hex(u.logAcc),
        nullAcc: hex(u.nullAcc),
        assetStats: u.assetStats.map(([id, st]) => [s(id), statsOf(st)]),
      };
      if (!v3) return base;
      return { ...base, mine: (mine ?? []).map(([id, st]) => [s(id), mineOf(st)]), mineAcc: hex(mineAcc ?? ZERO32), claimed: [...(claimed ?? [])] };
    };
    const snap = {
      version: v3 ? SNAPSHOT_VERSION : SNAPSHOT_V2,
      protocol: PROTOCOL,
      envelopeVersion: VERSION,
      digestVersion: v3 ? DIGEST_V : 1,
      genesis: this.genesis,
      startHeight: this.startHeight,
      height: this.height,
      outputs: this.outputs.map((o) => ({ ...o, commitment: s(o.commitment), ciphertext: hex(o.ciphertext) })),
      nullifiers: [...this.nullifiers],
      roots: [...this.roots].map(([h, r]) => [h, s(r)]),
      hashes: [...this.hashes],
      digests: [...this.digests],
      acc: { logAcc: hex(this.logAcc), nullAcc: hex(this.nullAcc) },
      assets: [...this.assets.values()].map(assetOut),
      stats: JSON.parse(JSON.stringify(this.stats)),
      undo: this.undo.map(undoOut),
      log: this.log,
    };
    if (v3) {
      snap.activations = this.activations.map((a) => ({ ...a }));
      snap.mine = { mineAcc: hex(this.mineAcc), claimed: [...this.claimed] };
    }
    return snap;
  }

  /**
   * Rebuilds an Indexer from snapshot(). Version 3 needs the same activation heights at or below
   * the snapshot height; version 2 loads (by a fixed migration) only when no activation is at or
   * below its height. Anything else throws, so callers archive it and resync from the activation height.
   */
  static restore(snap, { vkey, activations = ACTIVATIONS, pow = M.inlinePow, mineFee = MINE_FEE, strictTicker = STRICT_TICKER } = {}) {
    if (snap.version !== SNAPSHOT_VERSION && snap.version !== SNAPSHOT_V2) throw new Error("unsupported snapshot version");
    if (snap.protocol !== PROTOCOL || snap.envelopeVersion !== VERSION) throw new Error("snapshot is from another protocol");
    const v3 = snap.version === SNAPSHOT_VERSION;
    if (snap.digestVersion !== (v3 ? DIGEST_V : 1)) throw new Error("unsupported digest version");
    const later = (h) => h == null || h > snap.height;
    if (v3) {
      const theirs = new Map((snap.activations ?? []).map((a) => [a.name, a.height ?? null]));
      const names = new Set([...theirs.keys(), ...activations.map((a) => a.name)]);
      for (const name of names) {
        const a = theirs.get(name) ?? null;
        const b = activationHeight(name, activations);
        if (!(a === b || (later(a) && later(b)))) throw new Error("snapshot activations differ");
      }
    } else if (!activations.every((a) => later(a.height))) {
      throw new Error("snapshot activations differ");
    }
    const statsOf = (st) => ({ ...st, treasurySats: BigInt(st.treasurySats), burnedSats: BigInt(st.burnedSats) });
    const mineOf = (st) => ({
      ...st, ...Object.fromEntries(MINE_BIG_FIELDS.map((k) => [k, BigInt(st[k])])), dPts: st.dPts.map(([h, d]) => [h, BigInt(d)]),
    });
    const idx = new Indexer({ vkey, startHeight: snap.startHeight, genesis: snap.genesis, activations, pow, mineFee, strictTicker });
    idx.height = snap.height;
    for (const o of snap.outputs) {
      idx.tree.insert(BigInt(o.commitment));
      idx.outputs.push({ ...o, commitment: BigInt(o.commitment), ciphertext: unhex(o.ciphertext) });
    }
    idx.nullifiers = new Set(snap.nullifiers);
    idx.roots = new Map(snap.roots.map(([h, r]) => [h, BigInt(r)]));
    idx.hashes = new Map(snap.hashes);
    idx.digests = new Map(snap.digests);
    idx.logAcc = unhex(snap.acc.logAcc);
    idx.nullAcc = unhex(snap.acc.nullAcc);
    for (const a of snap.assets) {
      let asset;
      if (a.kind === "pow") {
        if (!v3) throw new Error("unsupported snapshot version");
        asset = {
          ...a,
          id: BigInt(a.id),
          ...Object.fromEntries(POW_TERM_BIG.map((k) => [k, BigInt(a[k])])),
          ...Object.fromEntries(MINE_BIG_FIELDS.map((k) => [k, BigInt(a[k])])),
          treasury: unhex(a.treasury),
          dPts: a.dPts.map(([h, d]) => [h, BigInt(d)]),
          claimsByHeight: a.claimsByHeight.map((p) => [...p]),
        };
      } else {
        // v2 assets carry no kind: insert it where applyDeploy puts it (before id), so state matches a fresh replay.
        const entries = Object.entries(a).filter(([k]) => k !== "kind");
        const at = entries.findIndex(([k]) => k === "id");
        entries.splice(at < 0 ? entries.length : at, 0, ["kind", "mint"]);
        asset = {
          ...Object.fromEntries(entries),
          id: BigInt(a.id),
          mintAmount: BigInt(a.mintAmount),
          priceSats: BigInt(a.priceSats),
          pool: BigInt(a.pool),
          treasury: unhex(a.treasury),
          treasurySats: BigInt(a.treasurySats),
          burnedSats: BigInt(a.burnedSats),
          mintsByHeight: a.mintsByHeight.map((p) => [...p]),
        };
      }
      idx.assets.set(asset.id, asset);
      idx.tickers.set(asset.ticker, asset.id);
    }
    idx.stats = JSON.parse(JSON.stringify(snap.stats));
    idx.undo = snap.undo.map((u) => ({
      ...u,
      assets: u.assets.map(BigInt),
      minted: u.minted.map(([id, amt]) => [BigInt(id), BigInt(amt)]),
      logAcc: unhex(u.logAcc),
      nullAcc: unhex(u.nullAcc),
      assetStats: u.assetStats.map(([id, st]) => [BigInt(id), statsOf(st)]),
      mine: v3 ? (u.mine ?? []).map(([id, st]) => [BigInt(id), mineOf(st)]) : [],
      mineAcc: v3 && u.mineAcc ? unhex(u.mineAcc) : ZERO32,
      claimed: v3 ? [...(u.claimed ?? [])] : [],
    }));
    idx.log = snap.log;
    if (v3) {
      idx.mineAcc = unhex(snap.mine?.mineAcc ?? hex(ZERO32));
      idx.claimed = new Map(snap.mine?.claimed ?? []);
    }
    if (idx.tree.root() !== idx.roots.get(idx.height)) throw new Error("snapshot root mismatch");
    if (idx.height >= idx.startHeight) {
      const again = hex(idx.computeDigest(idx.height, idx.hashes.get(idx.height), idx.roots.get(idx.height)));
      if (again !== idx.digests.get(idx.height)) throw new Error("snapshot digest mismatch");
    }
    return idx;
  }

  /**
   * restore(), or, for a snapshot written under a table that differs from `activations` at or
   * below its height (a node that ran past a newly pinned activation height on the release before
   * it), that state rolled back through its undo journal to the block before the first height
   * where the two tables differ. The caller then syncs those blocks again under the new rules.
   * Below that height both tables give the same rules, so the rolled-back state is exactly what a
   * fresh replay computes there. A version 2 snapshot was written with every activation not yet
   * reached. When the journal does not reach back that far this throws restore()'s error (the
   * caller archives the file and resyncs). Not consensus: a shortcut around a full resync.
   */
  static restoreRewound(snap, opts = {}) {
    try {
      return Indexer.restore(snap, opts);
    } catch (e) {
      if (e?.message !== "snapshot activations differ") throw e;
      const activations = opts.activations ?? ACTIVATIONS;
      const theirs = snap.version === SNAPSHOT_VERSION ? (snap.activations ?? []) : activations.map((a) => ({ ...a, height: null }));
      let to = Infinity;
      for (const name of new Set([...theirs, ...activations].map((a) => a.name))) {
        const a = activationHeight(name, theirs);
        const b = activationHeight(name, activations);
        if (a === b) continue;
        for (const h of [a, b]) if (h != null && h <= snap.height) to = Math.min(to, h - 1);
      }
      if (!Number.isSafeInteger(to) || to < snap.startHeight - 1 || snap.height - to > (snap.undo?.length ?? 0)) throw e;
      // Under its own table it must restore as it is: a damaged file fails here with its own error.
      const old = Indexer.restore(snap, { ...opts, activations: theirs });
      try {
        old.rollbackTo(to);
      } catch {
        throw e;
      }
      return Indexer.restore(JSON.parse(JSON.stringify(old.snapshot())), opts);
    }
  }
}

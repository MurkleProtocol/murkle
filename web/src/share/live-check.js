/**
 * Re-verification for the public pages: the verifier engine (src/verify-tx.mjs with the browser's
 * anchor-root, key and asset sources from web/src/verify) fed through a cached mempool.space
 * client, so the Proof Wall, the Live Verifier and the token page share raw data within a tab.
 *
 * Raw data still comes straight from mempool.space, never from us, and every byte is re-checked
 * against its hash by the engine; the cache only saves repeat downloads.
 *
 * API
 *   chain                                    the shared CachedEsplora (mempool.space, this build's network)
 *   planSteps(opName)                        the transcript rows a check will produce (re-export)
 *   checkTx(txid, { onStep, onPlan, entry }) -> Promise<result>   see src/verify-tx.mjs
 *       entry: the public log entry when the caller already has it (skips a log download)
 *       Mining claims recompute their Argon2id work in a Web Worker (engine.js powHashInWorker).
 *   readEnvelope(txid) -> Promise<{ payload, op, vsize, tx }>       raw tx -> envelope bytes
 *   runQueue(items, worker, { signal, gapMs }) -> Promise<void>     sequential, abortable
 */
import { verifyTx, txSizes } from "../../../src/verify-tx.mjs";
import { parseRawTx } from "../../../src/btc/block.mjs";
import { findEnvelope, headerOp, OP_NAME } from "../../../src/envelope.mjs";
import { unhex } from "../../../src/bytes.mjs";
import * as api from "../api.js";
import { ARTIFACT_SHA256, GENESIS_TXID, MANIFEST_SHA256, NETWORK, STORAGE_PREFIX } from "../config.js";
import { anchorRoot, replayVerdict, vkeyBytes } from "../verify/engine.js";
import { mineDifficulty, powHashInWorker } from "../verify/engine.js";
import { headerCheck } from "../verify/engine.js";
import { assetById, verdictOf } from "../verify/pool-data.js";
import { CachedEsplora } from "./cached-esplora.js";

export { planSteps } from "../../../src/verify-tx.mjs";

export const chain = new CachedEsplora(api.esplora, { prefix: `${STORAGE_PREFIX}.esplora.` });

export function checkTx(txid, { onStep, onPlan, entry = null } = {}) {
  return verifyTx(txid, {
    esplora: chain,
    vkeyBytes,
    pinnedVkeySha256: ARTIFACT_SHA256?.vkey ?? null,
    manifestSha256: MANIFEST_SHA256,
    genesisTxid: GENESIS_TXID,
    anchorRoot,
    assetInfo: (id) => assetById(id),
    // The caller found this entry in the bulk log it already holds; otherwise filter the whole
    // public log locally. Never a per-transaction question to our indexer.
    indexerVerdict: (t, opts) => (entry && entry.txid === t ? entry : verdictOf(t, opts)),
    // The user's own replay, when it covers the block: history rules become a browser result.
    replayVerdict,
    // Mining claims: Argon2id in a Web Worker, the reference block's hash straight from
    // mempool.space, D_eff from your own replay first and the indexer's log entry otherwise.
    powHash: (password) => powHashInWorker(password),
    blockHash: (h) => api.esplora.blockHash(h),
    mineDifficulty: (assetId, ref, height, opts = {}) => mineDifficulty(assetId, ref, height, { ...opts, entry }),
    // A-9: the block header behind the inclusion proof, checked against your replay's verified
    // chain first, else linked to mempool.space headers above it (src/verify-tx.mjs levels).
    headerCheck,
    network: NETWORK,
    onStep,
    onPlan,
  }).catch((error) => ({ txid, verdict: "error", error, steps: [] }));
}

export async function readEnvelope(txid) {
  const raw = unhex(String(await chain.txHex(txid)).trim().toLowerCase());
  const tx = parseRawTx(raw, txid);
  const payload = findEnvelope(tx);
  return { tx, payload, op: payload ? OP_NAME[headerOp(payload)] ?? "UNKNOWN" : null, vsize: txSizes(raw).vsize };
}

export async function runQueue(items, worker, { signal = null, gapMs = 120 } = {}) {
  for (let i = 0; i < items.length; i++) {
    if (signal?.aborted) return;
    await worker(items[i], i);
    if (gapMs && i < items.length - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
}

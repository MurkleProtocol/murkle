// Verify the Pool: a module Worker that rebuilds the whole pool from raw
// Bitcoin blocks with the production Indexer and syncIndexer, reading mempool.space directly.
// It checks every proof itself, saves its state to IndexedDB so a later run only downloads
// new blocks, and reports progress. It never talks to our indexer.
//
// Every block's header is verified before the block is applied (src/btc/headers.mjs, A-9):
// linkage, proof of work and the difficulty rules from the pinned base checkpoint, and a reorg
// is followed only to a branch with more work. On signet the block signature is not checked.
//
// Messages in:  { type: "start", key, startHeight, genesis, vkeyBytes, pin, esploraBase, network }
//               { type: "pause" }
// Messages out: { type: "progress", ...counters } | { type: "done", ...summary }
//               counters cover this run; `totals` adds every earlier resumed run
//               counters include mining claims next to proofs: claimsVerified, msPerClaim
//               (Argon2id plus the claim's proof check). This is a Worker already, so the
//               Indexer computes Argon2id inline (src/mine.mjs inlinePow), off the page's thread.
//               counters carry headers: { tipHeight, baseHeight, workHex, rules } (the verified chain)
//               { type: "paused", ...counters } | { type: "error", message, code }
//               code: the HeaderError code ("less-work", "pow", ...) or null for other failures
// Saved record: { v: 2, snapshot, spentBy, totals, savedAt, headers: HeaderSnapshot }; a v: 1
// record still resumes, and its header chain is rebuilt from the base checkpoint.
import { sha256 } from "@noble/hashes/sha256";
import { Indexer } from "../../../src/indexer.mjs";
import { syncIndexer } from "../../../src/sync.mjs";
import { Esplora } from "../../../src/btc/esplora.mjs";
import { HeaderChain, HeaderError } from "../../../src/btc/headers.mjs";
import { NETWORK } from "../../../src/params.mjs";
import { hex } from "../../../src/bytes.mjs";
import { kvGet, kvSet } from "./idb.js";

const CHUNK = 10; // blocks between pause checks and saves
const SAVE_MS = 3000;
let job = null;

self.onmessage = (e) => {
  const m = e.data ?? {};
  if (m.type === "start" && !job) start(m);
  else if (m.type === "pause" && job) job.paused = true;
};

const post = (msg) => self.postMessage(msg);

async function start(m) {
  job = { paused: false };
  const t0 = performance.now();
  try {
    if (hex(sha256(m.vkeyBytes)) !== m.pin) throw new Error("The served verification key doesn't match the fingerprint pinned in this build. The replay stops here.");
    const vkey = JSON.parse(new TextDecoder().decode(m.vkeyBytes));
    const saved = await kvGet(m.key).catch(() => undefined);
    let idx = null;
    let spentBy = new Map();
    if (saved?.snapshot && saved.snapshot.startHeight === m.startHeight) {
      try {
        // A replay saved past an activation height this release pins rolls back to the block before it.
        idx = Indexer.restoreRewound(saved.snapshot, { vkey });
        spentBy = new Map(saved.spentBy ?? []);
      } catch {
        idx = null; // an incompatible snapshot: start over from the activation height
      }
    }
    const network = m.network ?? NETWORK;
    let headers = null;
    if (idx && saved?.v >= 2 && saved.headers) {
      try {
        headers = HeaderChain.restore(saved.headers, { network, startHeight: m.startHeight });
      } catch {
        headers = null; // rebuilt below from the base checkpoint
      }
    }
    headers ??= new HeaderChain({ network, startHeight: m.startHeight });
    const resumedFrom = idx ? idx.height : null;
    // Totals across resumed runs, for the result card ("N proofs across M blocks in T s").
    const before = { ms: 0, blocks: 0, bytes: 0, proofs: 0, claims: 0, ...(idx && saved.totals ? saved.totals : {}) };
    idx ??= new Indexer({ vkey, startHeight: m.startHeight, genesis: m.genesis });

    // Count and time proof checks without touching the indexer's code.
    const c = { proofs: 0, proofMs: 0, claims: 0, claimMs: 0, blocks: 0, bytes: 0 };
    const check = idx.checkTx.bind(idx);
    idx.checkTx = async (env, tx, height) => {
      const t = performance.now();
      const r = await check(env, tx, height);
      if (r === true || r === "proof does not verify") {
        c.proofs += 1;
        c.proofMs += performance.now() - t;
      }
      return r;
    };
    // Mining claims: checks that reached the work (accepted, insufficient work, or a proof
    // failure) are counted and timed, with the Argon2id pre-pass of each block added in.
    if (typeof idx.checkMine === "function") {
      const checkMine = idx.checkMine.bind(idx);
      // Every argument is passed on: the block's PoW memo travels in the last one.
      idx.checkMine = async (...args) => {
        const t = performance.now();
        const r = await checkMine(...args);
        if (r === true || /^(insufficient work|invalid proof encoding|proof does not verify)/.test(String(r))) {
          c.claims += 1;
          c.claimMs += performance.now() - t;
        }
        return r;
      };
    }
    const pow = idx.pow;
    if (pow && typeof pow.hashMany === "function") {
      idx.pow = {
        hash: (password) => pow.hash(password),
        hashMany: async (passwords) => {
          const t = performance.now();
          try {
            return await pow.hashMany(passwords);
          } finally {
            c.claimMs += performance.now() - t;
          }
        },
      };
    }
    // Which transaction spent each nullifier, so /nullifier/ pages can answer from this replay
    // (an accepted claim's rolled notes too: applyMine applies through applyTx).
    const apply = idx.applyTx.bind(idx);
    idx.applyTx = (env, tx, height, undo) => {
      for (const n of env.nullifiers) spentBy.set(String(n), tx.txid);
      return apply(env, tx, height, undo);
    };

    const esplora = new Esplora(m.esploraBase);
    let tip = await esplora.tipHeight();
    const counters = () => ({
      height: idx.height,
      tip,
      startHeight: m.startHeight,
      resumedFrom,
      blocksScanned: c.blocks,
      bytes: c.bytes,
      envelopes: idx.log.length,
      accepted: idx.log.length - idx.stats.rejected,
      proofsVerified: c.proofs,
      rejected: idx.stats.rejected,
      msPerProof: c.proofs ? c.proofMs / c.proofs : null,
      claimsVerified: c.claims,
      msPerClaim: c.claims ? c.claimMs / c.claims : null,
      ms: performance.now() - t0,
      totals: totals(),
      headers: { tipHeight: headers.height, baseHeight: headers.base.height, workHex: headers.work.toString(16), rules: headers.rules.validity },
    });
    const totals = () => ({
      ms: before.ms + (performance.now() - t0),
      blocks: before.blocks + c.blocks,
      bytes: before.bytes + c.bytes,
      proofs: before.proofs + c.proofs,
      claims: before.claims + c.claims,
    });
    const save = () => kvSet(m.key, { v: 2, snapshot: idx.snapshot(), spentBy: [...spentBy], totals: totals(), savedAt: Date.now(), headers: headers.snapshot() }).catch(() => {});

    let lastPost = 0;
    let lastSave = performance.now();
    post({ type: "progress", ...counters() });
    while (idx.height < tip) {
      if (job.paused) {
        await save();
        post({ type: "paused", ...counters() });
        return;
      }
      tip = await syncIndexer(idx, esplora, {
        to: Math.min(idx.height + CHUNK, tip),
        headers,
        onBlock: (_h, t, { bytes }) => {
          c.blocks += 1;
          c.bytes += bytes;
          tip = Math.max(tip, t);
          if (performance.now() - lastPost > 150) {
            lastPost = performance.now();
            post({ type: "progress", ...counters() });
          }
        },
      });
      if (performance.now() - lastSave > SAVE_MS) {
        lastSave = performance.now();
        await save();
      }
    }
    await save();
    post({ type: "done", ...counters(), digest: idx.digestAt(idx.height) });
  } catch (e) {
    post({ type: "error", code: e instanceof HeaderError ? e.code : null, message: String(e?.message ?? e) });
  } finally {
    job = null;
  }
}

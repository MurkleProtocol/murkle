// The retired free relayer (docs/design/paid-relay.md §12, §15.1; relay-balance.md).
//
// It paid every private transfer's carrier from the operator's own BTC, and a
// zero-value transfer needs no tokens, so anyone could drain it. There is no free
// mode of any kind and the operator never pays for a user's transaction. The paid
// relayer (relay balances, server/relayer.mjs) starts only when it is configured
// (MURKLE_RELAYER=1 and MURKLE_RELAY_MODE=balance) and never loads the old key as
// pool money. Without it, this module answers for the relay endpoints:
//
//   relayInfoOff()                      GET /api/relay/info without a relayer
//   loadV1State(path)                   the v1 relayer.json, read only, its items pruned in memory
//   pruneV1State(saved), v1NeedsPrune   the v1 file cut down to what old ids are answered with:
//                                       no envelope, raw transaction, nullifier, account or cost
//                                       (privacy-trace-test.md L2); the server rewrites the file
//                                       once at startup when it still holds any of them
//   v1Status(v1, id)                    GET /api/relay/status/:id for a v1 id: accepted
//                                       stays accepted, everything else is "dropped"
//   retireFree({ key, state, esplora, to, dryRun })
//                                       `murkle relayer retire-free`: sweeps every coin of
//                                       the old relayer key to an address the operator names,
//                                       as the operator's own transaction paid from that balance
import { existsSync, readFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { RBF_SEQUENCE, btcAccount, dustLimit, feeFor, scriptOf } from "../src/btc/funding.mjs";
import { ANCHOR_WINDOW } from "../src/indexer.mjs";
import { isBatchMode } from "../src/relay-batch.mjs";
import { NETWORK } from "../src/params.mjs";
import { unhex } from "../src/bytes.mjs";

/** The reason every v1 relay id that did not land answers with. */
export const RETIRED_REASON = "The free relayer was retired. Pay the fee yourself, or copy the envelope.";
/** relay info `reason` while no relayer runs. */
export const UNAVAILABLE_REASON = "no relayer runs on this server";
/** POST /api/relay/submit, /account and /credit while no relayer runs (code "disabled", HTTP 503). */
export const SUBMIT_MESSAGE = "No relayer runs on this server. Pay the fee yourself, or copy the envelope so anyone can carry it.";

const V1_VERSION = 1;
const ID = /^[0-9a-f]{32}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const INPUT_VBYTES = 57.5; // one key-path P2TR input, witness discounted
const FINAL = new Set(["accepted", "rejected", "expired", "dropped"]);

/**
 * GET /api/relay/info with no relayer: a stable shape the web and the CLI read.
 * `enabled` is false, `code` is the machine reason, `reason` the plain one.
 */
export function relayInfoOff() {
  return {
    enabled: false,
    mode: null,
    code: "disabled",
    reason: UNAVAILABLE_REASON,
    network: NETWORK,
    ops: [],
    address: null,
    pow: null,
    selfPay: true,
    balance: null,
    batch: null,
    docs: "docs/design/relay-balance.md",
  };
}

// What a v1 item keeps (L2): what v1Status answers and retire-free checks, nothing else. A txid
// and a height only for a carrier that was signed (it is public once broadcast); never the
// envelope, the raw bytes, the nullifiers (they would identify a later spend of the same notes),
// an account, a cost or a coin.
const V1_KEEP = ["id", "status", "anchor", "mode", "releaseAt", "lastRelease", "txid", "height"];
const V1_SECRET = ["envelope", "raw", "nullifiers", "account", "cost", "reservation", "root", "outpoint", "acceptedHeight"];

/** One v1 item cut down to V1_KEEP. */
export function pruneV1Item(item) {
  const out = {};
  for (const k of V1_KEEP) if (item?.[k] !== undefined && item[k] !== null) out[k] = item[k];
  return out;
}

/** True when a v1 state still holds a field pruneV1Item drops with something in it (an empty list or null aside). */
export function v1NeedsPrune(saved) {
  for (const item of Object.values(saved?.items ?? {})) {
    if (!item || typeof item !== "object") continue;
    for (const k of V1_SECRET) {
      const v = item[k];
      if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
      return true;
    }
  }
  return false;
}

/** The v1 state with every item pruned (pruneV1Item); every other top-level field as it was. */
export function pruneV1State(saved) {
  const items = {};
  for (const [id, item] of Object.entries(saved?.items ?? {})) if (ID.test(id) && item && typeof item === "object") items[id] = pruneV1Item(item);
  return { ...saved, items };
}

/**
 * The v1 relayer state at `path`, read once and never written here (the server's startup
 * rewrites a file that still holds secrets, through pruneV1State). Its items are pruned in
 * memory as they are read: no envelope or nullifier of a transfer that never went out is
 * kept. A missing file is an empty state; an unreadable one too, with a warning (the indexer
 * keeps running). Returns { items: Map(id -> item) }.
 */
export function loadV1State(path, { log = console } = {}) {
  const items = new Map();
  if (!path || !existsSync(path)) return { items };
  try {
    const saved = JSON.parse(readFileSync(path, "utf8"));
    if (saved?.version !== V1_VERSION) throw new Error(`unsupported relayer state version ${saved?.version}`);
    for (const [id, item] of Object.entries(saved.items ?? {})) if (ID.test(id) && item && typeof item === "object") items.set(id, pruneV1Item(item));
  } catch (e) {
    log.warn?.(`${path}: v1 relay ids cannot be answered (${e.message})`);
  }
  return { items };
}

/**
 * The status of a v1 relay id, or null when it is unknown. An item the indexer
 * accepted stays "accepted"; every other one is "dropped" with RETIRED_REASON, so
 * the wallet offers paying the fee itself or copying the envelope.
 */
export function v1Status(v1, id) {
  if (!v1 || !ID.test(String(id))) return null;
  const item = v1.items.get(String(id));
  if (!item) return null;
  const anchor = Number(item.anchor);
  const batch = isBatchMode(item.mode) ? { mode: item.mode, releaseAt: item.releaseAt ?? null, lastRelease: item.lastRelease ?? null } : {};
  if (item.status === "accepted") {
    return {
      status: "accepted",
      ...(item.txid ? { txid: item.txid } : {}),
      ...(item.height != null ? { height: item.height } : {}),
      anchor,
      deadline: anchor + ANCHOR_WINDOW,
      ...batch,
    };
  }
  return { status: "dropped", reason: RETIRED_REASON, anchor, deadline: anchor + ANCHOR_WINDOW, ...batch };
}

/** Reads the old relayer key (64 hex chars). Never creates one. */
export function readRelayerKey(path) {
  if (!existsSync(path)) throw new Error(`no relayer key at ${path}`);
  const text = readFileSync(path, "utf8").trim();
  if (!HEX32.test(text)) throw new Error(`${path} must hold 64 lowercase hex chars`);
  return unhex(text);
}

/** The v1 relayer.json as saved, read only; a missing file is an empty state. */
export function readV1File(path) {
  if (!path || !existsSync(path)) return { version: V1_VERSION, items: {} };
  const saved = JSON.parse(readFileSync(path, "utf8"));
  if (saved?.version !== V1_VERSION) throw new Error(`${path}: unsupported relayer state version ${saved?.version}`);
  return pruneV1State(saved);
}

/**
 * v1 carriers that may still land: signed or broadcast, not final, with the next
 * block still inside their anchor window, and not confirmed on Bitcoin. A carrier
 * the explorer cannot answer for counts as pending. Returns [{ id, txid, anchor, why }].
 */
export async function pendingV1Carriers(state, { esplora, tip }) {
  const out = [];
  for (const item of Object.values(state?.items ?? {})) {
    if (!item?.txid || FINAL.has(item.status)) continue;
    const anchor = Number(item.anchor);
    if (Number.isFinite(anchor) && tip + 1 > anchor + ANCHOR_WINDOW) continue; // can never land now
    let why;
    try {
      const st = await esplora.txStatus(item.txid);
      if (st?.confirmed) continue;
      why = "unconfirmed";
    } catch (e) {
      why = `unknown to the explorer (${e.message})`;
    }
    out.push({ id: item.id, txid: item.txid, anchor, why });
  }
  return out;
}

/**
 * Signed sweep of every coin to `to`: all inputs, one output, RBF signalled so the
 * operator can bump it (0xfffffffd, the one nSequence every transaction this software
 * builds carries). The fee follows the one fee rule: a whole sat/vB rate (rounded up)
 * times the vsize rounded up (the estimate, or the signed size if that is larger), paid from
 * the swept balance. The inputs go in a random order
 * (CSPRNG), like every other route's (privacy-trace-test.md L5). Pure apart from signing
 * and that order; `utxos` are Esplora /address/:a/utxo rows; `random(n)` is for tests.
 */
export function planSweep({ key, utxos, to, feeRate, random = randomInt }) {
  const account = btcAccount(key);
  const script = scriptOf(to);
  const rate = BigInt(Math.max(1, Math.ceil(Number(feeRate))));
  const coins = [...utxos];
  for (let i = coins.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [coins[i], coins[j]] = [coins[j], coins[i]];
  }
  const total = coins.reduce((s, u) => s + BigInt(u.value), 0n);
  const build = (fee) => {
    const tx = new btc.Transaction();
    for (const u of coins) {
      tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: account.script, amount: BigInt(u.value) }, tapInternalKey: account.pub, sequence: RBF_SEQUENCE });
    }
    tx.addOutput({ script, amount: total - fee });
    tx.sign(key);
    tx.finalize();
    return tx;
  };
  const outVb = 8 + 1 + script.length;
  let fee = feeFor(rate, 11 + outVb + INPUT_VBYTES * coins.length);
  if (total - fee < dustLimit(script)) throw new Error(`the old relayer key holds ${total} sats, too little to sweep at ${rate} sat/vB`);
  let tx = build(fee);
  if (fee < feeFor(rate, tx.vsize)) {
    fee = feeFor(rate, tx.vsize);
    if (total - fee < dustLimit(script)) throw new Error(`the old relayer key holds ${total} sats, too little to sweep at ${rate} sat/vB`);
    tx = build(fee);
  }
  return { hex: tx.hex, txid: tx.id, vsize: tx.vsize, fee: Number(fee), amount: Number(total - fee), total: Number(total), inputs: coins.length, from: account.address };
}

/**
 * `murkle relayer retire-free --to <address> [--dry-run]` (paid-relay.md §12).
 * Refuses while any v1 carrier may still land, or while any coin of the key is
 * unconfirmed (the sweep never depends on an unconfirmed parent). Broadcasts
 * nothing on a dry run. Archives nothing: the operator moves the key file once the
 * sweep has confirmed. Returns { status: "dry-run" | "broadcast", ...plan }.
 */
export async function retireFree({ key, state, esplora, to, dryRun = false, feeRate = null, print = console.log }) {
  if (typeof to !== "string" || !to) throw new Error("--to <address> is required: the address the operator names for the old relayer's coins");
  try {
    scriptOf(to);
  } catch {
    throw new Error(`--to ${to} is not a ${NETWORK} Bitcoin address`);
  }
  const account = btcAccount(key);
  if (to === account.address) throw new Error("--to is the old relayer's own address; name another address");
  const tip = await esplora.tipHeight();
  const pending = await pendingV1Carriers(state, { esplora, tip });
  if (pending.length) {
    const list = pending.map((p) => `${p.txid} (${p.why}, anchor ${p.anchor}, may land until block ${p.anchor + ANCHOR_WINDOW})`).join("; ");
    throw new Error(`refusing to sweep: ${pending.length} v1 carrier(s) may still land: ${list}. Run it again once each is confirmed or past its anchor window.`);
  }
  const utxos = await esplora.utxos(account.address);
  if (!utxos.length) throw new Error(`the old relayer address ${account.address} holds no coins; nothing to sweep`);
  const unconfirmed = utxos.filter((u) => !u.status?.confirmed);
  if (unconfirmed.length) {
    throw new Error(`refusing to sweep: ${unconfirmed.length} coin(s) of ${account.address} are unconfirmed (${unconfirmed.map((u) => `${u.txid}:${u.vout}`).join(", ")}). Run it again once they confirm.`);
  }
  const rate = feeRate ?? (await esplora.feeRate());
  const plan = planSweep({ key, utxos, to, feeRate: rate });
  print(`old relayer ${plan.from}: ${plan.inputs} coin(s), ${plan.total} sats at block ${tip}`);
  print(`sweep to ${to}: ${plan.amount} sats, fee ${plan.fee} sats (${plan.vsize} vB at ${Math.max(1, Math.ceil(Number(rate)))} sat/vB), paid from that balance`);
  if (dryRun) {
    print(`dry run, nothing broadcast: ${plan.txid}\n${plan.hex}`);
    return { status: "dry-run", ...plan };
  }
  const txid = await esplora.broadcast(plan.hex);
  print(`sweep broadcast: ${txid}`);
  print("Nothing was archived. Once it confirms, move the old key file out of the data directory yourself; it is never loaded again.");
  return { status: "broadcast", ...plan, txid };
}

// Relay client (relayer.md §4.8, relay-balance-contract.md §5.2). A relayer carries
// a private transfer's envelope in its own Bitcoin transaction, so none of the
// user's BTC addresses appears on it. It is non-custodial over the transfer: the
// proof binds every byte, so it can delay or refuse an envelope but cannot change it.
//
// Relay balances (docs/design/relay-balance.md): the operator never pays any part of a
// user's transaction. A user who wants relaying tops up a prepaid relay balance with a
// plain BTC payment; each relayed send is charged the exact carrier fee plus a margin.
// Without a balance the wallet offers paying the fee yourself or copying the envelope,
// exactly as before. What the relayer sees: which balance paid, the address that topped
// it up, the IP and the timing; never the amount, token or recipient.
//
// Every request that touches a balance is signed by the wallet's relay account key
// (src/relay-account.mjs): the signature binds the endpoint, the network, the pool key
// and the exact body (for a submit: the envelope and the mode). No proof of work.
//
// API
//   RELAY_ROUTE { open, info }               open only while the server runs a relay-balance relayer
//   setRelayRoute(info)                      opens or closes the route from relay info
//   relayOpen()                              whether the wallet may offer the relay route
//   relayRotation(info) -> { depositsOpen, code, generation, retired }   top-ups open, and the retired pool keys
//   RELAY_OFF                                the line shown where the relay route would be
//   quoteFor(info, mode) -> { perSend, needed } | null   what a send in `mode` needs now
//   routeState(info, balance, mode) -> "off" | "unknown" | "none" | "fee_high" | "low" | "ok"
//   poolMix(info) -> { k, coverOk, depositors } | null      relay info balance.mix (privacy-trace-test.md L1)
//   mixState(info) -> "ok" | "thin" | "unknown"   whether a relayed send can avoid being tied to its top-up
//   MIN_COVER_K                              the smallest k the wallet accepts as cover (below it: "thin")
//   info({ client }) / status(id, { client })              GET /api/relay/info, /api/relay/status/:id
//   accountBalance({ account, info, client, signal })      signed POST /api/relay/account
//   creditDeposit({ outpoint, accountPub, n, client, signal })   POST /api/relay/credit (not signed)
//   submitEnvelope(envelope, { mode, linkable, account, balance, onStep, signal, client }) -> 202 body
//       linkable: true is the user's explicit consent to a send the thin pool ties to their top-up
//       address (signed field "linkable"); without it a thin pool refuses with "pool_thin".
//   missedText(code)                        why a relayed send was not sent (status "missed")
//   relayFailure(err) -> { code, retryable, message }  plain-English failure for the UI
//   auditRelayer({ address, txs, ledger, batch, mine }) / relayerTxs(esplora, address)   "Audit the relayer"
import { sha256 } from "@noble/hashes/sha256";
import { unhex, hex } from "../../src/bytes.mjs";
import { dustLimit, scriptOf } from "../../src/btc/funding.mjs";
import { OP, decodeEnvelope, opReturnPayload } from "../../src/envelope.mjs";
import { ANCHOR_WINDOW, EPOCH_BLOCKS, isBatchMode } from "../../src/relay-batch.mjs";
import { RELAY_ENDPOINTS, signRequest } from "../../src/relay-account.mjs";
import { relay as relayApi } from "./api.js";
import { NETWORK } from "./config.js";
import { int } from "./ui/format.js";

const POOL_KEY = /^[0-9a-f]{64}$/;

/** Open only while the server runs a relayer with relay balances (setRelayRoute). Tests may set .open directly. */
export const RELAY_ROUTE = { open: false, info: null };

/**
 * Opens the route for relay info from a relay-balance relayer on this wallet's network,
 * closes it for anything else. The network is pinned here (config.js), never taken from
 * the server: a relayer reporting another network, mainnet say, would otherwise have the
 * wallet derive and show real-value deposit addresses under a SIGNET heading.
 */
export function setRelayRoute(info) {
  RELAY_ROUTE.info = info ?? null;
  RELAY_ROUTE.open = info?.enabled === true && info.mode === "balance" && info.network === NETWORK && POOL_KEY.test(info.balance?.poolKey ?? "");
  return RELAY_ROUTE.open;
}
export const relayOpen = () => RELAY_ROUTE.open === true;

/**
 * The relayer's key rotation as relay info shows it (relay-balance.md §9): whether it takes top-ups
 * now (false while it evacuates its coins, is paused or waits for its new pool; an older relayer
 * does not say: open), its key generation and the pool keys it retired. A wallet derives deposit
 * addresses from the current pool key only, never shows one of a retired key, and keeps the
 * balance: it belongs to the account key, not to a pool key.
 */
export function relayRotation(info) {
  const b = info?.balance ?? {};
  const retired = Array.isArray(b.retiredPoolKeys) ? b.retiredPoolKeys.filter((k) => POOL_KEY.test(String(k))) : [];
  const paused = b.depositsOpen === false || STOPPED.has(info?.code);
  return { depositsOpen: !paused, code: paused ? (STOPPED.has(info?.code) ? info.code : "maintenance") : null, generation: Number.isSafeInteger(b.generation) ? b.generation : 0, retired };
}
const STOPPED = new Set(["relayer_evacuating", "pool_unfunded", "maintenance"]);
/** The line the wallet shows where the relay route would be, while no relayer runs. */
export const RELAY_OFF = "Relaying is off on this server. Pay the fee yourself, or copy the envelope.";

export const info = ({ client = relayApi, signal } = {}) => client.info({ signal });
export const status = (id, { client = relayApi, signal } = {}) => client.status(id, { signal });

const toHex = (envelope) => (typeof envelope === "string" ? envelope : hex(envelope));

/**
 * What one send in `mode` costs from the balance at today's fee rate: perSend (fee plus
 * margin) and needed (perSend times the batch headroom for a batch mode, which reserves
 * more until its batch goes out). null while the relayer doesn't know the fee rate.
 */
export function quoteFor(info, mode = "block") {
  const per = info?.balance?.perSendSats;
  if (!Number.isSafeInteger(per) || per <= 0) return null;
  const h = info.balance.batchHeadroom;
  const headroom = isBatchMode(mode) ? (Number.isSafeInteger(h) && h >= 1 ? h : 2) : 1;
  return { perSend: per, needed: per * headroom };
}

/**
 * Where the relay route stands for a send in `mode`:
 *   off       no relay-balance relayer (relayOpen() false, or no info)
 *   unknown   the balance has not been read (the wallet never topped up, or not yet)
 *   none      nothing on the balance and nothing reserved
 *   fee_high  Bitcoin fees are above the relayer's cap: it takes no sends now
 *   low       the available balance doesn't cover this send
 *   ok        the relay card can be chosen
 */
export function routeState(info, balance, mode = "block") {
  if (!relayOpen() || !info || info.enabled !== true) return "off";
  if (!balance) return "unknown";
  if (!(balance.balance > 0) && !(balance.reserved > 0)) return "none";
  if (info.code === "fee_high") return "fee_high";
  const q = quoteFor(info, mode);
  if (q && !(balance.balance >= q.needed)) return "low";
  return "ok";
}

/**
 * The relay pool's lineage summary (relay info balance.mix): k, the number of depositors besides
 * the sender a carrier coin must descend from (the coin descends from at least k + 1, whoever
 * sends); coverOk, whether such a coin exists now (the same for every sender); depositors, how
 * many accounts have had a deposit credited. null when the relayer publishes none (an older
 * relayer: nothing is known about its coins' lineage).
 */
export function poolMix(info) {
  const m = info?.balance?.mix;
  if (!m || typeof m !== "object" || typeof m.coverOk !== "boolean") return null;
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
  return { k: count(m.k), coverOk: m.coverOk, depositors: count(m.depositors) };
}

/**
 * The smallest k the wallet counts as cover. A relayer may publish less (MURKLE_RELAY_MIN_MIX=0
 * turns its rule off: one depositor's coins then carry that depositor's sends); the wallet then
 * treats every relayed send as linkable, whatever coverOk says.
 */
export const MIN_COVER_K = 3;

/**
 * "ok": a carrier coin descends from at least k + 1 depositors, k >= MIN_COVER_K; "thin": none
 * does, or the relayer's k is below MIN_COVER_K (or unreadable), so a relayed send now may be
 * tied to the address that topped up its balance (and needs consent); "unknown": the relayer
 * publishes no lineage. The wallet claims the sender is kept off Bitcoin only for "ok".
 */
export function mixState(info) {
  const m = poolMix(info);
  if (!m) return "unknown";
  if (!(m.k >= MIN_COVER_K)) return "thin";
  return m.coverOk ? "ok" : "thin";
}

const relayError = (code, extra = {}) => Object.assign(new Error(relayFailure({ code }).message), { code, ...extra });

/** Info is a relay-balance relayer's, else throws with the relayer's code (or "disabled"). */
function openInfo(i) {
  setRelayRoute(i);
  if (relayOpen()) return i;
  // `code` is the machine reason; an older relayer put it in `reason`.
  const code = typeof i?.code === "string" && i.code ? i.code : /^[a-z_]+$/.test(String(i?.reason ?? "")) ? i.reason : "disabled";
  throw relayError(code === "fee_high" || code === "halted" ? code : "disabled");
}

/** The signed balance read (POST /api/relay/account): { accountId, balance, reserved, nextIndex, depositAddress, credits }. */
export async function accountBalance({ account, info = RELAY_ROUTE.info, client = relayApi, signal, now } = {}) {
  if (!account) throw new Error("No relay account in this wallet session.");
  const i = openInfo(info);
  const body = signRequest({ account, endpoint: RELAY_ENDPOINTS.account, network: NETWORK, poolKey: i.balance.poolKey, ...(now ? { now } : {}) });
  return client.account(body, { signal });
}

/** Asks the relayer to credit one confirmed deposit (not signed: it can only credit the account it pays). */
export function creditDeposit({ outpoint, accountPub, n, client = relayApi, signal } = {}) {
  return client.credit({ outpoint, accountPub, n }, { signal });
}

// Gates the relayer reports for a Next-block submit (relay info `code`) that refuse every mode.
const REFUSE_ALL = new Set(["halted", "indexer_behind", "busy", "fee_high", "relayer_evacuating", "pool_unfunded", "maintenance"]);
const REFUSE_UNBATCHED = new Set(["block_full", "queue_full"]);

/**
 * Hands the envelope to the relayer, paid from the relay balance of `account`.
 * Refreshes relay info first and refuses locally, with the relayer's own code, when no
 * relay-balance relayer runs, when its gates refuse this mode, or when `balance` (the
 * last balance read, optional) doesn't cover the send. Then signs { envelope, mode }.
 * onStep({ id: "submit", status: "running" | "ok", detail, ms })
 */
export async function submitEnvelope(envelope, { mode = "block", linkable = false, account, balance = null, onStep = () => {}, signal, client = relayApi } = {}) {
  if (!account) throw new Error("No relay account in this wallet session.");
  const env = toHex(envelope);
  const i = openInfo(await client.info({ signal }));
  // A relayer not taking this batch length (or no batches at all) would refuse it: say so before the envelope leaves.
  if (isBatchMode(mode) && i.batch?.modes?.[mode]?.enabled !== true) throw relayError("batch_disabled");
  if (REFUSE_ALL.has(i.code) || (!isBatchMode(mode) && REFUSE_UNBATCHED.has(i.code))) {
    throw relayError(i.code, i.code === "fee_high" ? { feeRate: i.fees?.feeRate ?? null, maxFeeRate: i.fees?.maxFeeRate ?? null } : {});
  }
  const state = balance ? routeState(i, balance, mode) : "ok";
  if (state === "none" || state === "low") {
    const q = quoteFor(i, mode);
    throw relayError("balance_low", { balance: balance.balance, needed: q?.needed ?? null, perSend: q?.perSend ?? null });
  }
  // L1: a thin pool ties the carrier to this account's top-up; it goes only with explicit consent.
  // Refused here only once the balance is known to cover the send, so the relayer's own order
  // (balance_low before pool_thin) holds; without a balance read the relayer decides (409 pool_thin).
  if (state === "ok" && balance && mixState(i) === "thin" && linkable !== true) throw relayError("pool_thin", { mix: poolMix(i) });
  onStep({ id: "submit", status: "running", detail: "Handing the envelope to the relayer" });
  const fields = linkable === true ? { envelope: env, mode, linkable: true } : { envelope: env, mode };
  const body = signSubmit({ account, poolKey: i.balance.poolKey, fields });
  const t0 = Date.now();
  const res = await client.submit(body, { signal });
  const detail = isBatchMode(mode) ? `Scheduled for the batch after block ${int(res.releaseAt)}` : res.flush === "fast" ? "Queued: fast mode" : "Queued for the next block";
  onStep({ id: "submit", status: "ok", detail, ms: Date.now() - t0 });
  return res;
}

/**
 * Signs a submit body with the shared signRequest. The boolean `linkable` (L1) is one of its
 * optional signed fields (OPTIONAL_REQUEST_FIELDS), serialised as JSON true in the canonical body.
 */
export function signSubmit({ account, poolKey, fields, now = Date.now }) {
  return signRequest({ account, endpoint: RELAY_ENDPOINTS.submit, network: NETWORK, poolKey, fields, now });
}

/** Why the relayer did not send a transfer it held (relay status "missed"). Nothing was charged. */
export function missedText(code) {
  if (code === "fee_high") return "Not sent: fees were above the relayer's cap when it was due. Nothing was charged.";
  if (code === "pool_thin") return "Not sent: too few people had topped up the relay pool to send it without tying it to your top-up address. Nothing was charged.";
  return "Not sent: your relay balance did not cover the fee when it was due. Nothing was charged.";
}

// Codes whose cause is on the relayer's side or passes by itself: the same envelope can
// go again later, or be carried by the user's own wallet. balance_low needs a top-up first.
const RETRYABLE = new Set([
  "disabled", "indexer_behind", "block_full", "queue_full", "busy", "rate_limited", "network",
  "batch_full", "batch_disabled", "epoch_closed",
  "fee_high", "pool_low", "halted", "credit_in_progress", "deposit_unconfirmed", "stale_request",
]);

/** Plain-English text for every relayer code (relay-balance-contract.md §4.4), used when the server sent none. */
export const FALLBACK = {
  malformed: "The request is not a valid relay request. Update the wallet and try again.",
  bad_outpoint: "That is not a deposit outpoint. It must be a 64-character lowercase txid, a colon and the output number.",
  not_transact: "The relayer carries private transfers and mining claims bound to its change address. Mints and launches are paid from your own BTC wallet.",
  public_value: "This envelope moves public value, which a private transfer never does. Build the transfer again.",
  bad_signature: "The request signature does not match this account. Update the wallet and try again.",
  stale_request: "The request is too old or from the future. Check this device's clock and try again.",
  balance_low: "Your relay balance does not cover this send. Top up, or pay the fee yourself.",
  pool_thin: "Too few people have topped up the relay pool, so this send's input would tie it to your top-up address. Pay the fee yourself, or confirm to send it linkable.",
  deposit_unknown: "The explorer does not know this deposit yet. Wait a minute and try again.",
  already_credited: "This deposit was already credited to another relay account or address number.",
  credit_in_progress: "This deposit is being credited right now. Try again in a few seconds.",
  deposit_unconfirmed: "The deposit needs more confirmations before it is credited.",
  replayed: "This exact request was already received. Send it again from the wallet.",
  duplicate_nullifier: "The envelope spends the same note twice. Build the transfer again.",
  nullifier_spent: "These notes are already spent on Bitcoin. Sync your wallet; the transfer may already have landed.",
  nullifier_pending: "These notes are already in the relay queue. Wait for that transfer to settle.",
  too_large: "The request body is too large. Send only the signed envelope.",
  deposit_mismatch: "This output does not pay that deposit address of your relay account.",
  deposit_small: "This deposit is below the minimum, so it is not credited.",
  deposit_own: "This output belongs to the relayer's own transaction and is never credited.",
  anchor_unknown: "The envelope is anchored to a block the indexer does not know. Sync and prove again.",
  anchor_stale: "The envelope is anchored too far back to be carried safely. Prove it again from the current block.",
  proof_invalid: "The proof does not verify against this envelope. Build the transfer again.",
  anchor_not_boundary: "A batch transfer must be anchored to the block that opened its batch. Update the wallet and prove again.",
  epoch_closed: "This batch closed while your transfer was being proved. Prove it again for the next batch.",
  rate_limited: "Too many requests from your network. Wait and try again, or pay the fee yourself.",
  disabled: "No relayer runs on this server. Pay the fee yourself, or copy the envelope so anyone can carry it.",
  halted: "The relayer stopped itself because its books do not add up. Pay the fee yourself or copy the envelope; your balance is kept.",
  fee_high: "Bitcoin fees are above the relayer's cap right now, so it does not take sends. Pay the fee yourself or copy the envelope.",
  pool_low: "The relayer cannot fund more carriers in this block. Try the next block, or pay the fee yourself.",
  indexer_behind: "The relayer's indexer is catching up with Bitcoin. Try again in a few minutes.",
  busy: "The relayer is busy right now. Try again in a few seconds.",
  block_full: "The relayer has taken enough transfers for this block. Try after the next block.",
  queue_full: "The relay queue is full. Try again after the next block.",
  batch_full: "This batch is full. Send with the next block, or try the next batch.",
  batch_disabled: "The relayer is not taking this batch length right now. Send with the next block instead.",
  network: "Can't reach the relayer. Check your connection, or pay the fee yourself.",
  // Emergencies (relay-balance.md §9): the relayer moves its coins to new keys; balances are kept.
  relayer_evacuating: "The relayer is moving its coins to safety and takes no sends or top-ups right now. Your balance is kept in full. Pay the fee yourself, or copy the envelope.",
  pool_unfunded: "The relayer moved to new keys and takes no sends or top-ups until its operator has refilled the new pool. Your balance is kept in full. Pay the fee yourself, or copy the envelope.",
  maintenance: "The relayer is paused for maintenance. Your balance is kept. Try again later, or pay the fee yourself.",
  deposit_retired: "This top-up paid a deposit address the relayer has retired. It is credited once the operator has moved it into the new pool; you need to do nothing. Never pay an old deposit address again.",
  // Mining claims (mining-contract.md §9.4); the server's own text wins when it sends one.
  mine_mode: "A mining claim goes with the next block or at once. Batch modes land after the claim's 12-block window.",
  bind_stale: "The relayer's change address changed. Prove the claim again for the new address; your solution still counts.",
  solution_claimed: "This solution was already claimed. Mine a new one.",
  solution_pending: "This solution is already in the relay queue.",
  cap_reached: "The supply is mined out, counting claims already on their way. Nothing was charged.",
  expired: "This solution's 12-block window is too close to its end for the relayer to carry it. Mine a new one.",
  stale_work: "Difficulty jumped since this solution's block, so it no longer counts. Mine a new one.",
  pow_invalid: "The work in this claim does not meet the token's difficulty. A small penalty was taken from your relay balance.",
  mine_unsupported: "The relayer cannot carry claims of this token: a fee address belongs to the relayer. Pay the fee yourself.",
  mine_rejected: "This claim cannot land.",
  mine_disabled: "The relayer is not taking mining claims right now. Pay the fee yourself.",
};

/** Normalizes a relay error for the UI: { code, retryable, message }. */
export function relayFailure(err) {
  const code = err?.code ?? (err?.status === 0 || err?.name === "ApiError" ? "network" : "unknown");
  return {
    code,
    retryable: RETRYABLE.has(code),
    message: err?.message && err?.code ? err.message : (FALLBACK[code] ?? err?.message ?? "The relayer refused this transfer."),
  };
}

/**
 * "Audit the relayer" (relayer.md §4.8): classify the Bitcoin transactions of the relayer's
 * change address `address` (C), decoded locally from mempool.space data, and compare fees
 * with the published ledger. Only the relayer's public address is ever looked up, so this
 * leaks nothing about the user. Pure: `txs` is Esplora's /address/:a/txs JSON.
 *   carrier   exactly one OP_RETURN holding one private-transfer envelope, every other output
 *             paying C (its inputs may be deposit addresses or C)
 *   fanout / merge   no OP_RETURN, every output paying C (the ledger says which)
 *   mine      one OP_RETURN holding a MINE_SCRIPT claim bound to C (bindScriptHash = sha256(C)),
 *             every other output paying C or exactly the service-fee outputs of that asset
 *             (`mine`: GET /api/mine, its assets' feeOutputs), each at least its dust limit.
 *             The ledger fee is the miner fee only; the service sats are outputs, not fee.
 *   other     anything else touching C, flagged: the relayer never makes or spends such coins
 * @returns { rows: [{ txid, kind, ok, note, fee, confirmed }], matched, total, foreign, batches }
 *   total counts what the relayer made or what spends its coins; foreign counts coins others
 *   sent to C, which it never spends.
 *   batches: { rows: [{ mode, start, reported, onChain, ok, note }], matched, total, skipped }
 */
export function auditRelayer({ address, txs, ledger = [], batch = null, mine = null }) {
  const byTxid = new Map(ledger.map((l) => [l.txid, l]));
  const claimOf = mineCarrier(address, mine);
  const rows = [];
  const landed = []; // [anchor, block height] of every confirmed carrier
  let foreign = 0;
  for (const tx of txs) {
    const ins = (tx.vin ?? []).map((v) => v.prevout?.scriptpubkey_address ?? null);
    const outs = tx.vout ?? [];
    const opReturns = outs.filter((o) => o.scriptpubkey_type === "op_return");
    const rest = outs.filter((o) => o.scriptpubkey_type !== "op_return");
    const allToC = rest.every((o) => o.scriptpubkey_address === address);
    let kind;
    let ok = true;
    let note = null;
    const claim = opReturns.length === 1 ? claimOf(opReturns[0], rest) : null;
    if (claim) {
      kind = "mine";
      if (!claim.ok) {
        ok = false;
        note = claim.note;
      }
    } else if (opReturns.length === 1 && allToC) {
      kind = "carrier";
      let env = null;
      try {
        env = decodeEnvelope(opReturnPayload(unhex(opReturns[0].scriptpubkey)));
      } catch {
        env = null;
      }
      if (!env || env.op !== OP.TRANSACT) {
        ok = false;
        note = "Its OP_RETURN is not a single private-transfer envelope.";
      } else if (tx.status?.confirmed && Number.isSafeInteger(tx.status.block_height)) {
        landed.push([env.anchor, tx.status.block_height]);
      }
    } else if (byTxid.get(tx.txid)?.kind === "evacuation" && ins.includes(address)) {
      // relay-balance.md §9: the operator moved the relayer's coins to its cold address (a suspected key compromise).
      kind = "evacuation";
      note = "An emergency sweep of the relayer's coins to its operator's cold address, after a suspected key compromise.";
    } else if (byTxid.get(tx.txid)?.kind === "refund") {
      kind = "refund";
      note = "The operator refilled the pool of the relayer's new keys after a rotation.";
    } else if (!opReturns.length && rest.length > 0 && allToC) {
      const k = byTxid.get(tx.txid)?.kind;
      kind = k === "merge" || k === "retired-sweep" ? k : "fanout";
    } else {
      kind = "other";
      ok = false;
      if (ins.includes(address)) note = "Spends the relayer's coins to somewhere other than the relayer itself.";
      else {
        note = "Not made by the relayer; it never spends such coins.";
        foreign++;
      }
    }
    // A refill's fee is paid by the operator's cold wallet, so the ledger lists it without one.
    if (kind !== "other" && kind !== "refund") {
      const l = byTxid.get(tx.txid);
      if (!l) {
        ok = false;
        note ??= "Missing from the published ledger.";
      } else if (Number(l.fee) !== Number(tx.fee)) {
        ok = false;
        note ??= `Fee is ${tx.fee} sats on Bitcoin but ${l.fee} in the ledger.`;
      }
    }
    rows.push({ txid: tx.txid, kind, ok, note, fee: tx.fee, confirmed: Boolean(tx.status?.confirmed) });
  }
  const checked = rows.length - foreign;
  return { rows, matched: rows.filter((r) => r.ok).length, total: checked, foreign, batches: auditBatches(batch, landed, txs) };
}

const OP_MINE_SCRIPT = OP.MINE_SCRIPT ?? 8;

/**
 * A mining claim carrier of the relayer at `address` (C): (opReturn, otherOutputs) ->
 * null when the OP_RETURN is not a MINE_SCRIPT claim bound to C, else { ok, note }.
 * ok when every output that does not pay C is exactly one of the asset's service-fee
 * outputs (script and amount, raised to the dust limit), each present once.
 */
function mineCarrier(address, mine) {
  let bind = null;
  try {
    bind = hex(sha256(scriptOf(address)));
  } catch {
    return () => null;
  }
  const assets = new Map((Array.isArray(mine) ? mine : Array.isArray(mine?.assets) ? mine.assets : []).map((a) => [String(a.asset ?? a.id), a]));
  return (opReturn, rest) => {
    let env = null;
    try {
      env = decodeEnvelope(opReturnPayload(unhex(opReturn.scriptpubkey)));
    } catch {
      return null;
    }
    if (env?.op !== OP_MINE_SCRIPT || !env.bindScriptHash || hex(env.bindScriptHash) !== bind) return null;
    const a = assets.get(String(env.publicAsset));
    if (!a) return { ok: false, note: "A mining claim of a token the indexer does not list as mined." };
    const want = (a.feeOutputs ?? []).map((o) => {
      const script = String(o.script).toLowerCase();
      const need = BigInt(o.sats);
      let dust = 0n;
      try {
        dust = dustLimit(unhex(script));
      } catch {}
      return `${script}:${need < dust ? dust : need}`;
    });
    const got = rest.filter((o) => o.scriptpubkey_address !== address).map((o) => `${String(o.scriptpubkey).toLowerCase()}:${BigInt(o.value)}`);
    const same = want.length === got.length && [...want].sort().every((x, i) => x === [...got].sort()[i]);
    return same ? { ok: true, note: null } : { ok: false, note: "Its outputs are not exactly the relayer's change plus this token's service fee." };
  };
}

/**
 * Landing blocks that count for an epoch: 10-hour S+61 on; hourly S+7..S+60 when S also
 * opens a 10-hour epoch (so the two never overlap), else up to S+100 (a held epoch).
 */
function landingRange(mode, start) {
  const from = start + EPOCH_BLOCKS[mode] + 1;
  if (mode === "batch10") return [from, Infinity];
  return [from, start + (start % EPOCH_BLOCKS.batch10 === 0 ? EPOCH_BLOCKS.batch10 : ANCHOR_WINDOW)];
}

/**
 * Checks each epoch the relayer reports (`recent`: [{ mode, start, released, landed:
 * [[height, count]] }]) against the carriers on Bitcoin, grouped by decoded anchor and
 * landing block. ok iff the per-block counts are equal. Not checked (skipped): epochs
 * with nothing landed on either side, and epochs older than the oldest confirmed
 * transaction fetched (its block may be only partly fetched, so a shortfall there too).
 */
function auditBatches(batch, landed, txs) {
  const recent = Array.isArray(batch) ? batch : Array.isArray(batch?.recent) ? batch.recent : [];
  const heights = txs.filter((t) => t.status?.confirmed && Number.isSafeInteger(t.status.block_height)).map((t) => t.status.block_height);
  const oldest = heights.length ? Math.min(...heights) : null;
  const rows = [];
  let skipped = 0;
  for (const r of recent) {
    if (!isBatchMode(r?.mode) || !Number.isSafeInteger(r.start)) continue;
    const want = new Map();
    for (const [h, c] of r.landed ?? []) want.set(Number(h), (want.get(Number(h)) ?? 0) + Number(c));
    const [lo, hi] = landingRange(r.mode, r.start);
    const got = new Map();
    for (const [anchor, h] of landed) if (anchor === r.start && h >= lo && h <= hi) got.set(h, (got.get(h) ?? 0) + 1);
    const diff = [...new Set([...want.keys(), ...got.keys()])].filter((h) => (want.get(h) ?? 0) !== (got.get(h) ?? 0));
    const earliest = want.size ? Math.min(...want.keys()) : Infinity;
    const cut = diff.length === 1 && diff[0] === oldest && (got.get(oldest) ?? 0) < want.get(oldest);
    if ((!want.size && !got.size) || (want.size && (oldest === null || earliest < oldest)) || cut) {
      skipped++;
      continue;
    }
    const reported = [...want.values()].reduce((s, c) => s + c, 0);
    const onChain = [...got.values()].reduce((s, c) => s + c, 0);
    const ok = diff.length === 0;
    rows.push({ mode: r.mode, start: r.start, reported, onChain, ok, note: ok ? null : `Bitcoin shows ${onChain} carriers for this batch; the relayer reports ${reported}.` });
  }
  return { rows, matched: rows.filter((r) => r.ok).length, total: rows.length, skipped };
}

/** Downloads up to `pages` pages of the relayer address's history from mempool.space. */
export async function relayerTxs(esplora, address, { pages = 4 } = {}) {
  const out = [];
  let path = `/address/${address}/txs`;
  for (let i = 0; i < pages; i++) {
    const page = await (await esplora.request(path)).json();
    out.push(...page);
    const confirmed = page.filter((t) => t.status?.confirmed);
    if (page.length < 25 || !confirmed.length) break;
    path = `/address/${address}/txs/chain/${confirmed.at(-1).txid}`;
  }
  return out;
}

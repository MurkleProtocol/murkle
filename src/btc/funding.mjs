// Builds and funds the Bitcoin carrier transaction for an envelope, separately
// from signing, so the same plan can be signed by a local key (CLI, built-in
// web key). External wallets (Unisat) build and fund the transaction themselves.
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1";
import { opReturnScript } from "../envelope.mjs";
import { NETWORK as MURKLE_NETWORK } from "../params.mjs";

// The scure network object of MURKLE_NETWORK: tb1… addresses on signet (testnet, testnet4 and
// signet share them), bc1… on mainnet. Script bytes are the same; only the address text differs.
export const NETWORK = MURKLE_NETWORK === "mainnet" ? btc.NETWORK : btc.TEST_NETWORK;
const DUST = 330n;
// Witness-discounted size of one key-path P2TR input.
const INPUT_VBYTES = 57.5;

/* ------------------------------------------------- one fingerprint policy (L5) */
// Every transaction this software builds (CLI, web built-in key, relayer, retire and sweep tools)
// follows one policy, so the route that built it does not show (privacy-trace-test.md L5):
// - nSequence 0xfffffffd on every input (replacement signalled, uniformly);
// - fee = ceil(vsize) x a whole sat/vB rate (every rate source rounds up to a whole number), and
//   one headroom multiplier for every route that pays one (headroomRate);
// - input order and the change output's position are random where the protocol does not fix
//   them: a bound first input (MINT / MINE) stays first, the OP_RETURN envelope stays output 0.

/** The one nSequence every input carries: BIP-125 replacement signalled. */
export const RBF_SEQUENCE = 0xfffffffd;
/** The one fee-rate headroom: a deadline-sensitive carrier (a self-paid claim) pays rate x 1.25. */
export const FEE_HEADROOM = 1.25;

/** A whole sat/vB rate with the headroom applied: ceil(rate x FEE_HEADROOM), at least 1. */
export function headroomRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r) || r < 0) throw new RangeError("the fee rate must be a number of sat/vB");
  return Math.max(1, Math.ceil(r * FEE_HEADROOM));
}

/** The one fee rule: ceil(vsize) x feeRate (a whole sat/vB; a fractional rate throws). -> bigint sats. */
export function feeFor(feeRate, vsize) {
  const v = Number(vsize);
  if (!Number.isFinite(v) || v < 0) throw new RangeError("vsize must be a number of vbytes");
  return BigInt(feeRate) * BigInt(Math.ceil(v));
}

/** A uniform integer in [0, n) from the platform CSPRNG (rejection sampling: no modulo bias). */
export function secureRandomBelow(n) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 0x100000000) throw new RangeError("n must be an integer from 1 to 2^32");
  if (n === 1) return 0;
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

/** A copy of `items` in a uniformly random order (Fisher-Yates); `random(n)` returns an integer in [0, n). */
export function shuffled(items, random = secureRandomBelow) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = random(i + 1);
    if (!Number.isInteger(j) || j < 0 || j > i) throw new RangeError("random(n) must return an integer in [0, n)");
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Single-key P2TR account controlled by a local secret (CLI and built-in web key). */
export function btcAccount(btcKey) {
  const pub = schnorr.getPublicKey(btcKey);
  const pay = btc.p2tr(pub, undefined, NETWORK);
  return { type: "p2tr", address: pay.address, script: pay.script, pub };
}

export const scriptOf = (address) => btc.OutScript.encode(btc.Address(NETWORK).decode(address));
export const addressOf = (script) => btc.Address(NETWORK).encode(btc.OutScript.decode(script));

const outputVbytes = (script) => 8 + (script.length < 0xfd ? 1 : 3) + script.length;
const same = (a, b) => a.txid === b.txid && a.vout === b.vout;
const isWitnessProgram = (s) => s.length >= 4 && s.length <= 42 && (s[0] === 0 || (s[0] >= 0x51 && s[0] <= 0x60)) && s[1] === s.length - 2;
const isBytes = (b, len) => b instanceof Uint8Array && (len === undefined || b.length === len);
const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Bitcoin Core's dust threshold for an output to `script` at the default 3 sat/vB
 * dust relay fee: P2TR 330, P2WPKH 294, P2SH 540, P2PKH 546, OP_RETURN 0. Nodes
 * refuse to relay a transaction with a smaller output.
 */
export function dustLimit(script) {
  if (script[0] === 0x6a) return 0n;
  return BigInt(3 * (outputVbytes(script) + (isWitnessProgram(script) ? 67 : 148)));
}

/** The UTXO a MINT will be bound to: the largest spendable one. */
export function pickBindUtxo(utxos) {
  const [utxo] = [...utxos].sort((a, b) => b.value - a.value);
  if (!utxo) throw new Error("no UTXOs to pay with");
  return utxo;
}

/**
 * The script and internal key one input spends. A utxo may carry its own
 * `script` and `tapInternalKey` (the relayer's deposit and change coins);
 * otherwise the account's are used. An own script must be a key-path P2TR whose
 * output key is the internal key with the usual no-script-tree tweak.
 */
function inputKeys(u, account) {
  if (u.script === undefined && u.tapInternalKey === undefined) return { script: account.script, tapInternalKey: account.pub };
  const where = `input ${u.txid}:${u.vout}`;
  const script = u.script ?? account.script;
  const tapInternalKey = u.tapInternalKey ?? account.pub;
  if (!isBytes(script)) throw new Error(`${where}: script must be bytes`);
  let type = null;
  try {
    type = btc.OutScript.decode(script).type;
  } catch {
    type = null;
  }
  if (type !== "tr") throw new Error(`${where}: only key-path P2TR inputs can be spent here`);
  if (!isBytes(tapInternalKey, 32)) throw new Error(`${where}: tapInternalKey must be 32 bytes`);
  if (!sameBytes(btc.p2tr(tapInternalKey, undefined, NETWORK).script, script)) {
    throw new Error(`${where}: tapInternalKey does not match the input's script`);
  }
  return { script, tapInternalKey };
}

/**
 * Picks inputs for the outputs `all` (amounts final), adds change, and returns
 * the unsigned transaction. Shared by planCarrierTx, planPayment and planSplitTx.
 * Coins are chosen largest first (or in the given order), then laid out by the L5 policy:
 * every input carries RBF_SEQUENCE; with order "largest" the chosen inputs are shuffled (a
 * `firstInput` stays first) and the change output takes a random position, after an OP_RETURN
 * at output 0 (anywhere in a plain payment). With order "given" the caller fixes the layout:
 * inputs as given, change last (the relayer, whose I1 check pins outputs 1…k).
 * `random(n)` (tests only) replaces the CSPRNG.
 */
function fund({ account, utxos, all, feeRate, firstInput, sequence = RBF_SEQUENCE, changeScript, order = "largest", random = secureRandomBelow }) {
  if (order !== "largest" && order !== "given") throw new Error(`unknown input order "${order}"`);
  if (sequence !== RBF_SEQUENCE) throw new Error(`every input carries nSequence 0x${RBF_SEQUENCE.toString(16)}: one policy for every route`);
  if (changeScript !== undefined && !isBytes(changeScript)) throw new Error("changeScript must be bytes");
  const toChange = changeScript ?? account.script;
  // The account's own change keeps today's 330-sat floor; another script also respects its own dust limit.
  const changeMin = changeScript === undefined || dustLimit(toChange) < DUST ? DUST : dustLimit(toChange);
  let ordered = order === "given" ? [...utxos] : [...utxos].sort((a, b) => b.value - a.value);
  if (firstInput) {
    if (!ordered.some((u) => same(u, firstInput))) throw new Error("the bound UTXO is no longer available");
    ordered = [firstInput, ...ordered.filter((u) => !same(u, firstInput))];
  }
  const rate = BigInt(feeRate);
  const need = all.reduce((s, o) => s + o.amount, 0n);
  const baseVb = 11 + all.reduce((s, o) => s + outputVbytes(o.script), 0) + outputVbytes(toChange);
  const picked = [];
  let total = 0n;
  let fee = 0n;
  for (const u of ordered) {
    picked.push(u);
    total += BigInt(u.value);
    fee = feeFor(rate, baseVb + INPUT_VBYTES * picked.length);
    if (total >= need + fee) break;
  }
  // With no UTXOs the loop never prices an input, so the fee would read as 0.
  if (!picked.length || total < need + fee) {
    const needed = need + (fee || feeFor(rate, baseVb + INPUT_VBYTES));
    throw new Error(`not enough BTC at ${account.address}: have ${total} sats, need ${needed}`);
  }

  const shuffle = order === "largest";
  // A bound first input (MINT / MINE) keeps position 0; the rest go in a random order.
  const pinned = firstInput ? 1 : 0;
  const laid = shuffle ? [...picked.slice(0, pinned), ...shuffled(picked.slice(pinned), random)] : picked;
  const tx = new btc.Transaction({ allowUnknownOutputs: true });
  const inputs = [];
  for (const u of laid) {
    const { script, tapInternalKey } = inputKeys(u, account);
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script, amount: BigInt(u.value) }, tapInternalKey, sequence });
    inputs.push({ txid: u.txid, vout: u.vout, value: u.value, script, tapInternalKey });
  }
  const change = total - need - fee;
  if (change < changeMin) {
    for (const o of all) tx.addOutput({ script: o.script, amount: o.amount });
    return { tx, fee: total - need, change: 0n, changeIndex: null, inputs };
  }
  // The change takes a random slot among the outputs, never before an OP_RETURN envelope at 0.
  const lo = all.length && all[0].script[0] === 0x6a ? 1 : 0;
  const changeIndex = shuffle ? lo + random(all.length - lo + 1) : all.length;
  const outs = [...all.slice(0, changeIndex), { script: toChange, amount: change }, ...all.slice(changeIndex)];
  for (const o of outs) tx.addOutput({ script: o.script, amount: o.amount });
  return { tx, fee, change, changeIndex, inputs };
}

/**
 * Unsigned carrier transaction: output 0 is the OP_RETURN envelope, then `outputs`
 * ([{ script, amount }], in their order) with the change output at a random position among
 * them. An output below its dust limit is raised to it (a mint may overpay its price, never underpay).
 * - Inputs: coins chosen from `utxos` largest-first (or in the given order with
 *   `order: "given"`), then shuffled; `firstInput` (if given) is chosen first and stays input 0.
 *   A utxo may carry its own P2TR `script` and `tapInternalKey`; otherwise the account's are used.
 * - `order: "given"` keeps the caller's layout: inputs as given, change last.
 * - Change goes to `changeScript` (default: the account's script).
 * - Every input carries RBF_SEQUENCE (0xfffffffd); `sequence` may only repeat it.
 * - Fee: feeFor(feeRate, estimated vsize), a whole sat/vB rate.
 * Returns { tx, fee (bigint), change (bigint, 0n without a change output),
 * changeIndex (number | null), inputs ([{ txid, vout, value, script, tapInternalKey }] in input order) }.
 */
export function planCarrierTx({ account, utxos, envelope, outputs = [], feeRate, firstInput, sequence, changeScript, order = "largest", random }) {
  const paid = outputs.map((o) => ({ script: o.script, amount: o.amount < dustLimit(o.script) ? dustLimit(o.script) : o.amount }));
  const all = [{ script: opReturnScript(envelope), amount: 0n }, ...paid];
  return fund({ account, utxos, all, feeRate, firstInput, sequence, changeScript, order, random });
}

/**
 * A plain payment (no OP_RETURN) of `amount` sats to the output script `to`,
 * coins chosen largest-first, change to the account when at least 330 sats; the inputs and
 * the change position are random (as planCarrierTx). Refuses an amount below the dust limit
 * of `to`. Returns { tx, fee, change, paymentIndex (the payment's output index: read the
 * outpoint from it, never assume 0) } (plus changeIndex and inputs, as planCarrierTx).
 */
export function planPayment({ account, utxos, to, amount, feeRate, sequence, random }) {
  if (!isBytes(to) || !to.length) throw new Error("the payment needs an output script");
  if (to[0] === 0x6a) throw new Error("a payment cannot go to an OP_RETURN output");
  const sats = BigInt(amount);
  const dust = dustLimit(to);
  if (sats <= 0n || sats < dust) throw new Error(`the payment of ${sats} sats is below the ${dust}-sat dust limit of that address`);
  const plan = fund({ account, utxos, all: [{ script: to, amount: sats }], feeRate, sequence, random });
  // The payment's own output index: 0 or 1, since the change may come first (a top-up's outpoint).
  return { ...plan, paymentIndex: plan.changeIndex === 0 ? 1 : 0 };
}

/* ------------------------------------------------------------ mining carriers */

// Mining claim carriers (mining.md §4.1): one key-path P2TR input, the 515-byte MINE
// envelope in OP_RETURN (script 519 bytes, output 530 vB), P2TR fee output and change
// of 43 vB each. MINE_SCRIPT (511 bytes) is 4 vB smaller; quotes use the MINE size.
const TX_OVERHEAD_VB = 10.5; // version, locktime, two counts, segwit marker and flag
const MINE_OP_RETURN_VB = 530;
const P2TR_OUTPUT_VB = 43;
export const MINE_VSIZE = Object.freeze({ bare: 598, change: 641, feeOutputAndChange: 684 }); // one P2TR input

/**
 * Estimated virtual size of a claim carrier, for quotes: `inputs` key-path P2TR inputs,
 * `feeOutputs` service-fee outputs (sized as P2TR) and an optional change output.
 */
export function mineCarrierVsize({ feeOutputs = 1, change = true, inputs = 1 } = {}) {
  for (const [k, v, min] of [["feeOutputs", feeOutputs, 0], ["inputs", inputs, 1]]) {
    if (!Number.isSafeInteger(v) || v < min) throw new RangeError(`${k} must be an integer >= ${min}`);
  }
  return Math.ceil(TX_OVERHEAD_VB + INPUT_VBYTES * inputs + MINE_OP_RETURN_VB + P2TR_OUTPUT_VB * feeOutputs + (change ? P2TR_OUTPUT_VB : 0));
}

const scriptBytes = (script) => {
  if (script instanceof Uint8Array) return script;
  if (typeof script === "string" && /^([0-9a-f]{2})+$/i.test(script)) return Uint8Array.from(script.match(/../g), (b) => parseInt(b, 16));
  throw new TypeError("script must be bytes or hex");
};

/**
 * What a carrier pays a service-fee script: the required `sats`, raised to the script's
 * dust limit when below it (planCarrierTx raises an output the same way). Bigint.
 */
export function carrierAmountOf(script, sats) {
  const need = BigInt(sats);
  if (need < 0n) throw new RangeError("sats must not be negative");
  const dust = dustLimit(scriptBytes(script));
  return need < dust ? dust : need;
}

/**
 * "Prepare N coins": splits the account's coins into `n` outputs of `value` sats to the
 * account itself, plus change, so that many self-paid claims (each bound to its own first
 * input) can be in flight at once (mining.md §8.6). Returns what planCarrierTx returns.
 */
export function planSplitTx({ account, utxos, n, value, feeRate, random }) {
  if (!Number.isSafeInteger(n) || n < 1 || n > 500) throw new RangeError("n must be an integer from 1 to 500");
  const sats = BigInt(value);
  const dust = dustLimit(account.script);
  if (sats < dust) throw new Error(`each coin of ${sats} sats is below the ${dust}-sat dust limit of that address`);
  const all = Array.from({ length: n }, () => ({ script: account.script, amount: sats }));
  return fund({ account, utxos, all, feeRate, random });
}

/** The fee a planned or signed transaction pays: Σ input amounts − Σ output amounts, as a Number. */
export function feeOf(tx) {
  let fee = 0n;
  for (let i = 0; i < tx.inputsLength; i++) {
    const w = tx.getInput(i).witnessUtxo;
    if (!w) throw new Error(`input ${i} has no witnessUtxo, so its amount is unknown`);
    fee += BigInt(w.amount);
  }
  for (let i = 0; i < tx.outputsLength; i++) fee -= BigInt(tx.getOutput(i).amount);
  if (fee > BigInt(Number.MAX_SAFE_INTEGER) || fee < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error("fee out of range");
  return Number(fee);
}

/** Signs input i with secrets[i] (key-path P2TR), then finalizes. Throws if a secret does not sign its input. */
export function signInputs(tx, secrets) {
  if (!Array.isArray(secrets) || secrets.length !== tx.inputsLength) {
    throw new Error(`need one secret per input: ${tx.inputsLength} inputs, ${secrets?.length ?? 0} secrets`);
  }
  for (let i = 0; i < secrets.length; i++) {
    let signed = false;
    try {
      signed = tx.signIdx(secrets[i], i);
    } catch (e) {
      throw new Error(`secret ${i} does not sign input ${i}`, { cause: e });
    }
    if (!signed) throw new Error(`secret ${i} does not sign input ${i}`);
  }
  tx.finalize();
  return { hex: tx.hex, txid: tx.id, vsize: tx.vsize };
}

/** Signs and finalizes a planned transaction with a local key. */
export function signLocal(tx, btcKey) {
  tx.sign(btcKey);
  tx.finalize();
  return { hex: tx.hex, txid: tx.id, vsize: tx.vsize };
}

/** CLI path: plan from the account's UTXOs and sign with the local key. */
export async function buildCarrierTx({ api, btcKey, envelope, outputs = [], feeRate, firstInput, sequence, random }) {
  const account = btcAccount(btcKey);
  const { tx, fee } = planCarrierTx({
    account, utxos: await api.utxos(account.address), envelope, outputs, firstInput, sequence, random,
    feeRate: feeRate ?? (await api.feeRate()),
  });
  return { ...signLocal(tx, btcKey), fee };
}

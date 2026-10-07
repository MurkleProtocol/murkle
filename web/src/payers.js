// Who pays the Bitcoin side of an envelope (network fee, mint price).
//
// Every payer exposes: kind, address, carry({ ... }) -> { txid, fee, ... }.
//   LocalPayer   the built-in key derived from the 24 words. Pays mints, launches
//                and, if the user asks, private sends (which links them to one address).
//                It can also pay a relay balance top-up (pay(): a plain payment, no OP_RETURN).
//   UnisatPayer  the Unisat extension builds, funds and broadcasts the carrier itself.
//   RelayPayer   a relayer: carries TRANSACT only, in its own carrier, charged to the
//                user's prepaid relay balance (docs/design/relay-balance.md). Requests
//                are signed with the wallet's relay account key. Returns { relayId,
//                reservedSats } instead of a txid; the txid arrives later. Batch modes also
//                return releaseAt, lastRelease, epochBlocks and epochQueued. The operator
//                never pays any part of a user's transaction.
// Mints and launches are never relayed: a mint is bound to its payer (A-6) and a
// relayed launch would let anyone squat tickers at no cost to themselves.
//
// Fingerprints (privacy-trace-test.md L5): every transaction the built-in key builds goes
// through src/btc/funding.mjs, the same planner the CLI uses, with RBF_SEQUENCE on every
// input, the same fee rule (ceil(vsize) x a whole sat/vB rate) and a random input order and
// change position (a bound first input stays first, the OP_RETURN envelope stays output 0).
// The web wallet never asks for order "given", so nothing here pins a layout. Unisat builds
// its own transactions, so its sends carry Unisat's fingerprint, not this one.
import * as funding from "../../src/btc/funding.mjs";
import { OP, decodeEnvelope } from "../../src/envelope.mjs";
import { hex } from "../../src/bytes.mjs";
import { BRAND, NETWORK, PRE_GENESIS, UNISAT_CHAIN as NETWORK_UNISAT_CHAIN } from "../../src/params.mjs";

/**
 * Mainnet before its genesis is pinned: no payer carries anything (mainnet-readiness.md §4.8).
 * null on signet (pre-genesis signet runs as it always did) and on a launched mainnet.
 */
export const NOT_LAUNCHED_REASON = NETWORK !== "signet" && PRE_GENESIS
  ? `${BRAND} has not launched on Bitcoin mainnet. No genesis is pinned, so nothing here can move funds.`
  : null;
export function assertLaunched() {
  if (NOT_LAUNCHED_REASON) throw new Error(NOT_LAUNCHED_REASON);
}
import { submitEnvelope } from "./relay.js";

// sendBitcoin needs a recipient; envelopes without a payment send this to the payer itself.
const SELF_SATS = 546;

/** The one nSequence of every input the built-in keys sign (L5): BIP-125 replacement signalled. */
export const RBF_SEQUENCE = 0xfffffffd;

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The output of a planned payment that pays `script` exactly `sats`: never assume output 0,
 * the change can come first (L5). The change goes back to the payer, so it never matches a
 * payment to another script; a payment to the payer itself picks the first exact match.
 */
export function paymentVout(tx, script, sats) {
  for (let i = 0; i < tx.outputsLength; i++) {
    const o = tx.getOutput(i);
    if (o.amount === sats && sameBytes(o.script, script)) return i;
  }
  throw new Error("the planned payment has no output to that address");
}

// Signet only: Unisat's signet node runs an old relay policy. Elsewhere there is no notice (null).
export const UNISAT_SIGNET_NOTICE = NETWORK === "signet"
  ? "Unisat's signet node rejects large OP_RETURN outputs (old relay policy), so a 471-byte envelope may fail there. On signet, pay with the built-in key, or copy the envelope."
  : null;
// How the chain is named in Unisat's messages ("Signet" keeps today's wording).
const CHAIN_WORD = NETWORK === "signet" ? "Signet" : "mainnet";

export class LocalPayer {
  constructor(key) {
    this.kind = "local";
    this.key = key;
    this.account = funding.btcAccount(key);
  }
  get address() {
    return this.account.address;
  }
  utxos(api) {
    return api.utxos(this.address);
  }
  async balance(api) {
    return (await this.utxos(api)).reduce((s, u) => s + u.value, 0);
  }
  async carry({ api, envelope, outputs = [], utxos, firstInput, feeRate }) {
    assertLaunched();
    const { tx, fee } = funding.planCarrierTx({
      account: this.account, utxos: utxos ?? (await this.utxos(api)), envelope, outputs, firstInput, feeRate, sequence: RBF_SEQUENCE,
    });
    const signed = funding.signLocal(tx, this.key);
    return { txid: await api.broadcast(signed.hex), fee: Number(fee), vsize: signed.vsize };
  }

  /**
   * A plain payment of `amount` sats to `to` (an address): no OP_RETURN, change back to this
   * key. Used to top up a relay balance. Signed here; nothing is broadcast until pay().
   * The change takes a random position (L5), so `vout` says which output pays `to`.
   * -> { hex, txid, vsize, fee, to, amount, vout }
   */
  planPay({ utxos, to, amount, feeRate }) {
    const script = funding.scriptOf(to);
    const sats = BigInt(amount);
    const { tx, fee } = funding.planPayment({ account: this.account, utxos, to: script, amount: sats, feeRate, sequence: RBF_SEQUENCE });
    const vout = paymentVout(tx, script, sats);
    const signed = funding.signLocal(tx, this.key);
    return { ...signed, fee: Number(fee), to, amount: Number(amount), vout };
  }

  /** planPay(), then broadcast. -> { txid, fee, vsize, vout } */
  async pay({ api, to, amount, feeRate, utxos }) {
    assertLaunched();
    const plan = this.planPay({ utxos: utxos ?? (await this.utxos(api)), to, amount, feeRate: feeRate ?? (await api.feeRate()) });
    const txid = await api.broadcast(plan.hex);
    return { txid, fee: plan.fee, vsize: plan.vsize, vout: plan.vout };
  }
}

/**
 * Unisat builds, funds and broadcasts the carrier itself through sendBitcoin: it
 * picks spendable coins (no inscriptions or runes) and puts the envelope into an
 * OP_RETURN memo. Inputs are unknown in advance, so mints bind to the payer's
 * scriptPubKey (MINT_SCRIPT) instead of an outpoint.
 */
/** The only Unisat chain this wallet pays on: BITCOIN_SIGNET on signet, BITCOIN_MAINNET on mainnet. */
const UNISAT_CHAIN = NETWORK_UNISAT_CHAIN;

export class UnisatPayer {
  constructor() {
    this.kind = "unisat";
    this.account = null;
  }

  static installed() {
    return typeof window !== "undefined" && Boolean(window.unisat);
  }

  /** Must be called from a user gesture (Unisat rejects connection prompts on page load). */
  async connect() {
    const u = typeof window !== "undefined" ? window.unisat : undefined;
    if (!u) throw new Error("Unisat extension not found in this browser.");
    if (typeof u.getChain !== "function") throw new Error(NETWORK === "signet" ? "Update Unisat to 1.4 or later for signet support." : "Update Unisat to 1.4 or later: this wallet checks which network Unisat is on before it pays.");
    if ((await u.getChain())?.enum !== UNISAT_CHAIN) await u.switchChain(UNISAT_CHAIN);
    const [address] = await u.requestAccounts();
    this.account = { address, script: funding.scriptOf(address) };
    return this;
  }

  get address() {
    return this.account?.address;
  }

  /**
   * sendBitcoin spends from whichever account is active in Unisat, on whichever chain it
   * is on now. A mint is bound to the connected account's script, so refuse before paying
   * from another one. The chain is checked too: testnet, testnet4 and signet share the
   * same tb1 address, so an account check alone would let a payment go out on a testnet.
   */
  async checkAccount() {
    const u = window.unisat;
    const [active] = (await u.getAccounts()) ?? [];
    if (!this.address || active !== this.address) {
      throw new Error("Unisat is no longer on the account you connected (it was switched or locked). Nothing was paid. Switch back or unlock it in Unisat, or connect it again, then retry.");
    }
    const chain = typeof u.getChain === "function" ? (await u.getChain())?.enum : null;
    if (chain !== UNISAT_CHAIN) {
      throw new Error(`Unisat is no longer on Bitcoin ${CHAIN_WORD} (it was switched to another network). Nothing was paid. Switch Unisat back to ${CHAIN_WORD}, or connect it again, then retry.`);
    }
  }

  /** Calls fn when Unisat switches away from the connected account. Returns an unsubscribe function. */
  onAccountChange(fn) {
    const u = window.unisat;
    if (typeof u?.on !== "function") return () => {};
    const handler = (accounts) => {
      if (accounts?.[0] !== this.address) fn();
    };
    u.on("accountsChanged", handler);
    return () => (u.removeListener ?? u.off)?.call(u, "accountsChanged", handler);
  }

  async balance() {
    const b = await window.unisat.getBalance();
    return b.total ?? b.confirmed + b.unconfirmed;
  }

  async carry({ envelope, outputs = [], feeRate }) {
    if (outputs.length > 1) throw new Error("Unisat can pay only one output per transaction.");
    assertLaunched();
    await this.checkAccount();
    const [payment] = outputs;
    const to = payment ? funding.addressOf(payment.script) : this.address;
    // Like planCarrierTx: a payment below the dust limit goes out at that limit (nodes refuse less).
    const dust = payment ? funding.dustLimit(payment.script) : 0n;
    const sats = payment ? Number(payment.amount < dust ? dust : payment.amount) : SELF_SATS;
    try {
      const txid = await window.unisat.sendBitcoin(to, sats, { feeRate, memo: hex(envelope) });
      return { txid, fee: null };
    } catch (e) {
      // Unisat broadcasts through its own node; a pre-v30 node rejects OP_RETURN > 83 bytes.
      if (/scriptpubkey/i.test(e?.message ?? e)) {
        throw new Error(NETWORK === "signet"
          ? "Unisat's signet node rejected the large OP_RETURN (old relay policy). On signet, pay with the built-in key, or copy the envelope."
          : "Unisat's node rejected the large OP_RETURN (its relay policy). Nothing was paid. Pay with the built-in key, or copy the envelope.");
      }
      throw e;
    }
  }

  /**
   * A plain payment to `to` (a relay balance top-up): no memo, so no OP_RETURN. Unisat picks
   * the coins itself (no UTXO filtering here). -> { txid, fee: null }
   */
  async pay({ to, amount, feeRate }) {
    assertLaunched();
    await this.checkAccount();
    const txid = await window.unisat.sendBitcoin(to, Number(amount), feeRate ? { feeRate } : undefined);
    return { txid, fee: null };
  }
}

/**
 * A relayer with relay balances. TRANSACT only: the envelope is checked locally before
 * anything is sent, so a mint or a launch can never reach the relayer by mistake.
 * `account` is the wallet's relay account (src/relay-account.mjs relayAccount), which
 * signs the request; the session passes it per call. carry() resolves once the relayer
 * has queued the envelope (HTTP 202) and reserved its cost from the balance. linkable: true
 * is the user's consent to a send that a thin relay pool ties to their top-up (relay.js).
 */
export class RelayPayer {
  constructor({ client, account = null } = {}) {
    this.kind = "relay";
    this.client = client;
    this.account = account;
    this.address = null; // the relayer's change address, from info()
  }

  async carry({ envelope, mode = "block", linkable = false, onStep, signal, account = this.account, balance = null }) {
    assertLaunched();
    let env;
    try {
      env = decodeEnvelope(envelope);
    } catch (e) {
      throw new Error(`This envelope is malformed (${e.message}). Build the transfer again.`);
    }
    if (env.op !== OP.TRANSACT) {
      throw new Error("The relayer carries private transfers only. Mints and launches are paid from your own Bitcoin address.");
    }
    if (env.publicAmount !== 0n || env.publicAsset !== 0n) throw new Error("A private transfer never moves public value. Build the transfer again.");
    const res = await submitEnvelope(envelope, { mode, linkable, account, balance, onStep, signal, ...(this.client ? { client: this.client } : {}) });
    return {
      relayId: res.id, status: res.status, anchor: res.anchor, deadline: res.deadline, flush: res.flush, mode: res.mode,
      releaseAt: res.releaseAt, lastRelease: res.lastRelease, epochBlocks: res.epochBlocks, epochQueued: res.epochQueued,
      reservedSats: res.reservedSats ?? null, balance: res.balance ?? null, txid: null, fee: null,
    };
  }
}

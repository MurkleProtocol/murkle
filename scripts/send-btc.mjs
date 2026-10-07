// Signet dev utility: send sats from a CLI wallet's BTC fee key.
//   node scripts/send-btc.mjs <wallet> <address> <sats|max> [--fee-rate <sat/vB>]
// "max" sweeps every UTXO to the address (no change output). The wallet file is read from
// $MURKLE_DATA_DIR/wallets/<wallet>.json (default data/signet/wallets/), as the CLI does. The
// fee rate defaults to the explorer's estimate. A payment is planned by planPayment
// (src/btc/funding.mjs): the destination's own dust limit, change below 330 sats left out,
// and every input priced at the fee rate as it is added; a sweep is priced at the same rate.
// Both follow the one L5 policy of funding.mjs: nSequence 0xfffffffd on every input, fee =
// ceil(vsize) x a whole sat/vB rate, inputs in a random order (and the change, if any, at a
// random position).
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as btc from "@scure/btc-signer";
import { Esplora, SIGNET_API } from "../src/btc/esplora.mjs";
import { RBF_SEQUENCE, btcAccount, dustLimit, feeFor, planPayment, scriptOf, shuffled, signLocal } from "../src/btc/funding.mjs";
import { env } from "../src/params.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const USAGE = "usage: send-btc.mjs <wallet> <address> <sats|max> [--fee-rate <sat/vB>]";

/** Arguments, strictly: -> { wallet, to, amount: "max" | bigint, feeRate: number | null } */
export function parseSendArgs(argv) {
  const pos = [];
  let feeRate = null;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (!a.startsWith("--")) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const flag = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (flag !== "fee-rate") throw new Error(`unknown flag ${eq < 0 ? a : a.slice(0, eq)}\n${USAGE}`);
    if (feeRate !== null) throw new Error(`--fee-rate given twice\n${USAGE}`);
    const v = eq < 0 ? argv[++i] : a.slice(eq + 1);
    if (!/^[1-9]\d{0,5}$/.test(String(v ?? ""))) throw new Error(`--fee-rate must be a whole number of sat/vB, at least 1\n${USAGE}`);
    feeRate = Number(v);
  }
  if (pos.length !== 3) throw new Error(USAGE);
  const [wallet, to, amountArg] = pos;
  if (amountArg !== "max" && !/^[1-9]\d{0,15}$/.test(amountArg)) throw new Error(`amount must be a whole number of sats above 0, or max\n${USAGE}`);
  return { wallet, to, amount: amountArg === "max" ? "max" : BigInt(amountArg), feeRate };
}

/**
 * The unsigned transaction paying `amount` sats (or "max": every UTXO, no change) from `account`
 * to the address `to` at `feeRate` sat/vB. -> { tx, fee, amount } (bigints)
 * `random(n)` (tests only) replaces the CSPRNG that orders the inputs.
 */
export function planSend({ account, utxos, to, amount, feeRate, random }) {
  const script = scriptOf(to);
  if (amount !== "max") {
    const plan = planPayment({ account, utxos, to: script, amount, feeRate, random });
    return { tx: plan.tx, fee: plan.fee, amount: BigInt(amount) };
  }
  if (!utxos.length) throw new Error(`no UTXOs at ${account.address}`);
  const total = utxos.reduce((s, u) => s + BigInt(u.value), 0n);
  // Key-path P2TR inputs (57.5 vB each), one output, 11 vB of overhead: as planPayment counts.
  const fee = feeFor(feeRate, 11 + 57.5 * utxos.length + 8 + (script.length < 0xfd ? 1 : 3) + script.length);
  const sats = total - fee;
  const dust = dustLimit(script);
  if (sats <= 0n || sats < dust) {
    throw new Error(`not enough to sweep: ${total} sats minus a ${fee}-sat fee is below the ${dust}-sat dust limit of that address`);
  }
  const tx = new btc.Transaction();
  for (const u of shuffled(utxos, random)) {
    tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: account.script, amount: BigInt(u.value) }, tapInternalKey: account.pub, sequence: RBF_SEQUENCE });
  }
  tx.addOutput({ script, amount: sats });
  return { tx, fee, amount: sats };
}

async function main() {
  const { wallet, to, amount, feeRate } = parseSendArgs(process.argv.slice(2));
  const data = env("DATA_DIR") ?? join(ROOT, "data", "signet");
  const key = Buffer.from(JSON.parse(readFileSync(join(data, "wallets", `${wallet}.json`), "utf8")).btcKey, "hex");
  const account = btcAccount(key);
  const api = new Esplora(env("ESPLORA") ?? SIGNET_API);
  const rate = feeRate ?? (await api.feeRate());
  const plan = planSend({ account, utxos: await api.utxos(account.address), to, amount, feeRate: rate });
  const tx = signLocal(plan.tx, key);
  console.log("sent", await api.broadcast(tx.hex), `${plan.amount} sats -> ${to}, fee ${plan.fee} at ${rate} sat/vB`);
}

/** True when this file is the script node was started with (not an import, e.g. from a test). */
function isEntryScript() {
  try {
    const norm = (p) => {
      const real = realpathSync.native(p);
      return process.platform === "win32" ? real.toLowerCase() : real;
    };
    return Boolean(process.argv[1]) && norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryScript()) await main();

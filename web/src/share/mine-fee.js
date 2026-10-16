/**
 * What one mining claim costs, for the /mine page. Kept apart from mined.js on purpose: it imports funding.mjs
 * (the wallet's and the CLI's own fee rules, with the Bitcoin libraries behind them), and mined.js is also read by the
 * landing page and /mints, which have no use for them.
 *
 * API
 *   CLAIM_VSIZE                                    a claim's size in vB (the carrier the wallet and the CLI both build)
 *   feeEstimate({ rate }) -> { vsize, rate (paid), nextRate, networkSats, serviceSats, totalSats } | null
 */
import { MINE_VSIZE, headroomRate } from "../../../src/btc/funding.mjs";
import { serviceSats } from "./mined.js";

/** A mining claim's Bitcoin transaction is about 684 vB: one input, a service-fee output and change (the wallet and the CLI price claims with the same figure). */
export const CLAIM_VSIZE = MINE_VSIZE.feeOutputAndChange;

/**
 * Cost of one claim paid from the wallet's mining address, from the next-block rate (sat/vB). The wallet and the CLI
 * both pay headroomRate(next-block rate) = the rate plus 25%, rounded up to a whole sat/vB, up front:
 * `rate` is that paid rate, `nextRate` the next-block one.
 */
export function feeEstimate({ rate, service = serviceSats() } = {}) {
  const next = Math.ceil(Number(rate));
  if (!Number.isFinite(next) || next <= 0) return null;
  const paid = headroomRate(next);
  const networkSats = BigInt(CLAIM_VSIZE * paid);
  return { vsize: CLAIM_VSIZE, rate: paid, nextRate: next, networkSats, serviceSats: service, totalSats: networkSats + service };
}

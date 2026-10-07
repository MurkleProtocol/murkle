/**
 * Shell-wide status, shared between the shell (header, ledger strip) and the pages that know
 * more (the wallet session, the verifier). A tiny observable store; no framework.
 *
 * Wallet status: { state: "none" | "locked" | "unlocked", address?: string, lock?: () => void }
 *   The wallet (web/src/session.js) calls setWalletStatus() on unlock and lock, and passes
 *   `lock` so the header menu's "Lock now" can call it. Before that, the shell infers
 *   "locked" vs "none" from storage (detectStoredWallet).
 * Root status: see ui/rootmatch.js ({ state: "checking" | "match" | "indexer" | "mismatch", ... }).
 *   Whoever rebuilds the note tree in the browser (wallet sync, or the public-page verifier)
 *   calls setRootStatus() with the result.
 *
 * API
 *   store(initial) -> { get(), set(patch | fn), subscribe(fn) -> unsubscribe }
 *   walletStatus, rootStatus                    the two stores
 *   getWalletStatus(), setWalletStatus(patch), onWalletStatus(fn) -> unsubscribe
 *   getRootStatus(), setRootStatus(patch), onRootStatus(fn) -> unsubscribe
 *   detectStoredWallet(prefix, legacyPrefix) -> "locked" | "none"
 *   chainWritesBlocked() -> string | null       reason line while the root mismatches, or while
 *                                               mainnet has not launched (no genesis pinned)
 */
import { BRAND, NETWORK, PRE_GENESIS } from "../../../src/params.mjs";

const NOT_LAUNCHED = NETWORK !== "signet" && PRE_GENESIS;

export function store(initial) {
  let value = initial;
  const subs = new Set();
  return {
    get: () => value,
    set(patch) {
      const next = typeof patch === "function" ? patch(value) : { ...value, ...patch };
      value = next;
      for (const fn of [...subs]) {
        try {
          fn(value);
        } catch (e) {
          console.error(e);
        }
      }
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export const walletStatus = store({ state: "none" });
export const rootStatus = store({ state: "checking" });

export const getWalletStatus = () => walletStatus.get();
export const setWalletStatus = (patch) => walletStatus.set(patch);
export const onWalletStatus = (fn) => walletStatus.subscribe(fn);

export const getRootStatus = () => rootStatus.get();
export const setRootStatus = (patch) => rootStatus.set(patch);
export const onRootStatus = (fn) => rootStatus.subscribe(fn);

export function detectStoredWallet(prefix, legacyPrefix) {
  try {
    const keys = [`${prefix}.vault`, `${legacyPrefix}.phrase`, `${legacyPrefix}.vault`];
    return keys.some((k) => localStorage.getItem(k) !== null) ? "locked" : "none";
  } catch {
    return "none";
  }
}

export function chainWritesBlocked() {
  if (NOT_LAUNCHED) return `${BRAND} has not launched on Bitcoin mainnet: nothing can be sent yet`;
  return rootStatus.get().state === "mismatch" ? "Root mismatch: switch indexer or sync again" : null;
}

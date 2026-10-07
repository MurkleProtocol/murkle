// Node-only factory for the chain data source and the header chain (audit A-9).
//
//   MURKLE_BTC_SOURCE   esplora (default) | bitcoind
//   MURKLE_ESPLORA      Esplora API root (default: the network's mempool.space); with bitcoind it
//                       still serves utxos() and merkleProof() when set
//   MURKLE_BITCOIND_URL, MURKLE_BITCOIND_COOKIE, MURKLE_BITCOIND_USER, MURKLE_BITCOIND_PASSWORD_FILE
//   MURKLE_HEADERS      on (default) | off (signet only: header verification cannot be turned off on mainnet)
//
// Contract: docs/design/mainnet-readiness.md §3.3.
import * as P from "../params.mjs";
import { Bitcoind } from "./bitcoind.mjs";
import { Esplora } from "./esplora.mjs";
import { HeaderChain } from "./headers.mjs";
import { loadHeaderChain, saveHeaderChain } from "./headers-store.mjs";

const DEFAULTS = {
  signet: { esplora: "https://mempool.space/signet/api", rpcPort: 38332, chain: "signet" },
  mainnet: { esplora: "https://mempool.space/api", rpcPort: 8332, chain: "main" },
};

/** The Esplora root for `network`: params' per-network table when it has one, else the defaults above. */
export function esploraFor(network) {
  return P.NETWORKS?.[network]?.esplora ?? (network === P.NETWORK && P.ESPLORA_API ? P.ESPLORA_API : DEFAULTS[network]?.esplora);
}

/**
 * Opens the chain source the environment selects, checks it serves `network`, and loads the
 * header chain. Returns { kind, api, headers, save(), describe() }.
 *   startHeight  the indexer's start height (picks the base checkpoint; default: the pinned
 *                activation height when `network` is this build's network)
 *   fetch        test hook for the bitcoind source's HTTP (Esplora uses the global fetch)
 */
export async function openChainSource({
  network = P.NETWORK ?? "signet",
  read = P.env ?? ((name) => globalThis.process?.env?.[`MURKLE_${name}`]),
  headersPath = null,
  verifyHeaders = true,
  startHeight = network === P.NETWORK ? (P.ACTIVATION_HEIGHT ?? null) : null,
  log = console,
  fetch = null,
} = {}) {
  const net = DEFAULTS[network];
  if (!net) throw new Error(`unknown network ${network}: expected signet or mainnet`);
  const kind = (read("BTC_SOURCE") || "esplora").trim().toLowerCase();
  if (kind !== "esplora" && kind !== "bitcoind") throw new Error(`MURKLE_BTC_SOURCE must be esplora or bitcoind, not ${kind}`);

  const headersSetting = (read("HEADERS") || "on").trim().toLowerCase();
  if (headersSetting !== "on" && headersSetting !== "off") throw new Error(`MURKLE_HEADERS must be on or off, not ${headersSetting}`);
  const headersOff = headersSetting === "off" || verifyHeaders === false;
  if (headersOff && network === "mainnet") throw new Error("header verification cannot be turned off on mainnet (MURKLE_HEADERS=off is for signet only)");

  const esploraUrl = read("ESPLORA") || null;
  let api;
  let note = "";
  if (kind === "esplora") {
    api = new Esplora(esploraUrl || esploraFor(network), { network });
  } else {
    const walletSource = esploraUrl ? new Esplora(esploraUrl, { network }) : null;
    const node = new Bitcoind({
      url: read("BITCOIND_URL") || `http://127.0.0.1:${P.NETWORKS?.[network]?.rpcPort ?? net.rpcPort}`,
      cookieFile: read("BITCOIND_COOKIE") || null,
      user: read("BITCOIND_USER") || null,
      passwordFile: read("BITCOIND_PASSWORD_FILE") || null,
      network,
      walletSource,
      fetch,
    });
    const info = await node.chainInfo();
    if (info.chain !== net.chain) {
      throw new Error(`bitcoind at ${node.base} serves chain "${info.chain}", but this is ${network} (expects "${net.chain}"): point MURKLE_BITCOIND_URL at a ${network} node or set MURKLE_NETWORK`);
    }
    if (!info.txindex) throw new Error(`bitcoind at ${node.base} has no transaction index: set txindex=1 in bitcoin.conf (no pruning) and restart it`);
    if (!info.txindex.synced) {
      throw new Error(`bitcoind at ${node.base} is still building its transaction index (at #${info.txindex.best_block_height ?? "?"} of #${info.blocks}): start again when getindexinfo shows it synced`);
    }
    if (info.ibd) log?.warn?.(`bitcoind at ${node.base} is in initial block download (${info.blocks} of ${info.headers ?? "?"} headers): indexing only to #${info.blocks} until it catches up`);
    note = " (txindex on)";
    api = node;
  }

  const headers = headersOff ? null : headersPath ? loadHeaderChain(headersPath, { network, startHeight, log }) : new HeaderChain({ network, startHeight });

  return {
    kind,
    api,
    headers,
    save() {
      if (headers && headersPath) saveHeaderChain(headersPath, headers);
    },
    describe() {
      const h = headers ? `headers from checkpoint ${headers.base.height}${network === "signet" ? " (signet block signatures not checked)" : ""}` : "headers not verified (MURKLE_HEADERS=off, signet only)";
      return `${kind} ${api.base}${note}, ${h}`;
    },
  };
}


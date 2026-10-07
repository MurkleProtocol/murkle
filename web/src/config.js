// App-wide constants for the web app. src/params.mjs is the single source of truth
// for names and pins; this module re-exports it for the browser and falls back to the
// Murkle constants when it is missing, so the shell still builds without it.
//
// Under Vite, import.meta.glob resolves at build time and yields {} for a missing file.
// Under plain Node (tests), import.meta.glob does not exist, so we try a dynamic import
// whose specifier is built at runtime: Vite must not try to resolve that branch.

async function loadNode(file) {
  try {
    const spec = new URL(["..", "..", "src", file].join("/"), import.meta.url).href;
    return file.endsWith(".json")
      ? await import(/* @vite-ignore */ spec, { with: { type: "json" } })
      : await import(/* @vite-ignore */ spec);
  } catch {
    return {};
  }
}

const viteParams = import.meta.env ? import.meta.glob("../../src/params.mjs", { eager: true }) : null;
const P = viteParams ? (Object.values(viteParams)[0] ?? {}) : await loadNode("params.mjs");

const DEFAULT_PINS = {
  manifestSha256: null,
  artifacts: { wasm: null, zkey: null, vkey: null },
  genesisTxid: null,
  activationHeight: null,
};
// The network this build is for: params.mjs resolves it (MURKLE_NETWORK in Node, the Vite define
// __MURKLE_NETWORK__ in the web build); the fallbacks below follow the same value.
const BUILT_NETWORK = typeof __MURKLE_NETWORK__ !== "undefined" ? __MURKLE_NETWORK__ : undefined; // eslint-disable-line no-undef
export const NETWORK = P.NETWORK ?? globalThis.process?.env?.MURKLE_NETWORK ?? BUILT_NETWORK ?? "signet";
const PINS_NAME = NETWORK === "mainnet" ? "pins.mainnet.json" : "pins.json";
const vitePins = import.meta.env ? import.meta.glob(["../../src/pins.json", "../../src/pins.mainnet.json"], { eager: true, import: "default" }) : null;
const filePins = vitePins ? vitePins[`../../src/${PINS_NAME}`] : (await loadNode(PINS_NAME)).default;
const rawPins = P.PINS ?? P.pins ?? filePins ?? DEFAULT_PINS;

export const PARAMS = P;
export const PINS = {
  ...DEFAULT_PINS,
  ...rawPins,
  artifacts: { ...DEFAULT_PINS.artifacts, ...(rawPins.artifacts ?? {}) },
};

const text = (v, fallback) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : (v ?? fallback));

export const BRAND = P.BRAND ?? "Murkle";
export const PROTOCOL = P.PROTOCOL ?? "murkle";
export const MAGIC = text(P.MAGIC, "mrk");
export const VERSION = P.VERSION ?? 0;
export const IS_SIGNET = NETWORK === "signet";
export const IS_TESTNET = P.IS_TESTNET ?? IS_SIGNET;
export const ADDRESS_HRP = P.ADDRESS_HRP ?? (IS_SIGNET ? "mrk" : "murk");
export const BTC_HRP = P.BTC_HRP ?? (IS_SIGNET ? "tb" : "bc");
export const UNISAT_CHAIN = P.UNISAT_CHAIN ?? (IS_SIGNET ? "BITCOIN_SIGNET" : "BITCOIN_MAINNET");
export const STRICT_TICKER = P.STRICT_TICKER ?? !IS_SIGNET;
export const STORAGE_PREFIX = P.STORAGE_PREFIX ?? `${PROTOCOL}.${NETWORK}`;
// Keys written before the rename; the wallet migrates them once. Signet only: the zkpool-era
// wallet never ran anywhere else, so a mainnet build has nothing to migrate.
export const LEGACY_STORAGE_PREFIX = IS_SIGNET ? "zkpool.signet" : null;
export const label = typeof P.label === "function" ? P.label : (name) => `${PROTOCOL}/${name}`;

export const GENESIS_TXID = P.GENESIS_TXID ?? PINS.genesisTxid ?? null;
export const ACTIVATION_HEIGHT = P.ACTIVATION_HEIGHT ?? PINS.activationHeight ?? null;
export const MANIFEST_SHA256 = P.MANIFEST_SHA256 ?? PINS.manifestSha256 ?? null;
export const ARTIFACT_SHA256 = P.ARTIFACT_SHA256 ?? PINS.artifacts;
export const PRE_GENESIS = !GENESIS_TXID || ACTIVATION_HEIGHT === null || ACTIVATION_HEIGHT === undefined;

export const EXPLORER = P.EXPLORER ?? (IS_SIGNET ? "https://mempool.space/signet" : "https://mempool.space");
export const ESPLORA_API = P.ESPLORA_API ?? P.ESPLORA ?? `${EXPLORER}/api`;
// A faucet exists on signet only (null on mainnet: real bitcoin is bought, never given away here).
export const FAUCET = P.FAUCET !== undefined ? P.FAUCET : IS_SIGNET ? "https://signetfaucet.com" : null;

// Network wording for the UI. Signet renders exactly the strings it always did; mainnet names
// itself and never says "test", "no value" or "faucet".
export const NETWORK_NAME = IS_SIGNET ? "signet" : NETWORK;
/** "Bitcoin signet" / "Bitcoin mainnet" */
export const CHAIN_NAME = `Bitcoin ${NETWORK_NAME}`;
/** What the wallet's bitcoin is called in copy: "signet BTC" on signet, "BTC" on mainnet. */
export const BTC_WORD = IS_SIGNET ? "signet BTC" : "BTC";
/** Short uppercase network label for eyebrows and chips: "SIGNET" / "MAINNET". */
export const NETWORK_TAG = NETWORK_NAME.toUpperCase();
/** Mainnet before its genesis is pinned: nothing can move funds, and every surface says so. */
export const NOT_LAUNCHED = !IS_SIGNET && PRE_GENESIS;
export const MAINNET_NOT_LAUNCHED_TEXT = `${BRAND} has not launched on Bitcoin mainnet. No genesis is pinned, so nothing here can move funds.`;
export const REPO_URL = P.REPO_URL ?? null;

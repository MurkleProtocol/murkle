// Single source of truth for protocol names and pinned constants. Imported by
// the indexer, the server, the CLI, the scripts and the web app, so a rename or
// a re-genesis is one edit here (plus the network's pins file, written by the build).
import signetPins from "./pins.json" with { type: "json" };
import mainnetPins from "./pins.mainnet.json" with { type: "json" };

export const PROTOCOL = "murkle";
export const BRAND = "Murkle";

// ---------------------------------------------------------------- network (SPEC.md §1)
// One switch: MURKLE_NETWORK=signet|mainnet in Node (read once, at import), or the value the
// web build baked in (Vite define __MURKLE_NETWORK__). Unset means signet, which stays the
// default and keeps every value below byte for byte. Anything else refuses to load.
export const NETWORKS = Object.freeze({
  signet: Object.freeze({
    name: "signet", test: true, explorer: "https://mempool.space/signet",
    esplora: "https://mempool.space/signet/api", btcHrp: "tb", addressHrp: "mrk", faucet: "https://signetfaucet.com",
    rpcPort: 38332, unisatChain: "BITCOIN_SIGNET", strictTicker: false, pinsFile: "src/pins.json",
    artifacts: Object.freeze({
      manifest: "build/manifest.json", vkey: "build/dev/verification_key.json",
      zkey: "build/dev/transaction.zkey", wasm: "build/transaction_js/transaction.wasm",
    }),
  }),
  mainnet: Object.freeze({
    name: "mainnet", test: false, explorer: "https://mempool.space",
    esplora: "https://mempool.space/api", btcHrp: "bc", addressHrp: "murk", faucet: null,
    rpcPort: 8332, unisatChain: "BITCOIN_MAINNET", strictTicker: true, pinsFile: "src/pins.mainnet.json",
    artifacts: Object.freeze({
      manifest: "build/mainnet/manifest.json", vkey: "build/mainnet/verification_key.json",
      zkey: "build/mainnet/transaction.zkey", wasm: "build/transaction_js/transaction.wasm",
    }),
  }),
});

/** The network name for an env or build value: undefined or "" is signet; anything unknown throws. */
export function resolveNetwork(value) {
  if (value === undefined || value === null || value === "") return "signet";
  if (typeof value === "string" && Object.hasOwn(NETWORKS, value)) return value;
  throw new Error(`MURKLE_NETWORK must be "signet" or "mainnet", not ${JSON.stringify(value)}`);
}

// The web build replaces __MURKLE_NETWORK__ (web/vite.config.mjs); Node reads the env.
const BUILT_NETWORK = typeof __MURKLE_NETWORK__ !== "undefined" ? __MURKLE_NETWORK__ : undefined; // eslint-disable-line no-undef
const ENV_NETWORK = globalThis.process?.env?.MURKLE_NETWORK;
export const NETWORK = resolveNetwork(ENV_NETWORK !== undefined && ENV_NETWORK !== "" ? ENV_NETWORK : BUILT_NETWORK);
export const NET = NETWORKS[NETWORK];
export const IS_TESTNET = NET.test;
export const IS_MAINNET = NETWORK === "mainnet";
/** Bitcoin address HRP of this network: "tb" (tb1…) on signet, "bc" (bc1…) on mainnet. */
export const BTC_HRP = NET.btcHrp;
/** The chain name Unisat's getChain() must report for this network. */
export const UNISAT_CHAIN = NET.unisatChain;
export const FAUCET = NET.faucet;
/** SPEC.md §7: DEPLOY / DEPLOY_POW ticker checked on its raw bytes (V2-02). Mainnet from genesis; never on signet. */
export const STRICT_TICKER = NET.strictTicker;
/** Repo-relative artifact paths of this network (signet: the DEV setup; mainnet: the ceremony output). */
export const ARTIFACT_PATHS = NET.artifacts;
/** Repo-relative path of this network's pins file. */
export const PINS_FILE = NET.pinsFile;

// 3 ASCII bytes, the same length as the old placeholder, so envelope sizes stay
// TRANSACT 471, MINT 507, MINT_SCRIPT 503 (ATTEST is 38).
export const MAGIC_TEXT = "mrk";
export const MAGIC = new TextEncoder().encode(MAGIC_TEXT);
export const VERSION = 0;
// Shielded addresses: mrk1… on signet (unchanged), murk1… on mainnet (SPEC.md §2), so a
// wallet refuses an address of the other network instead of paying it.
export const ADDRESS_HRP = NET.addressHrp;

/** Domain-separation tag for every HKDF info string and protocol hash. */
export const label = (name) => `${PROTOCOL}/${name}`;
// Wallet key labels are network-separated on mainnet (murkle/mainnet/<name>), so one recovery
// phrase never gives the same keys (in particular the same Bitcoin fee key) on both networks.
// Signet keeps murkle/<name>. Protocol hashes (note, relay PoW, digest, mine) never change.
const keyLabel = (name) => (NETWORK === "signet" ? label(name) : label(`${NETWORK}/${name}`));
export const LABELS = Object.freeze({
  spend: keyLabel("spend"),
  view: keyLabel("view"),
  note: label("note"),
  btcFee: keyLabel("btc-fee"),
  relayPow: label("relay/pow/v1"),
  digest: label("digest/v1"),
  btcMineFee: keyLabel("btc-mine-fee"),
  mine: label("mine/v1"), // 14 bytes: the PoW challenge domain tag (SPEC.md §15)
});

/** Domain tag of state digest version `v`: digestTag(1) === LABELS.digest. */
export const digestTag = (v) => label(`digest/v${v}`);
/** Newest state digest format this code computes (SPEC.md §10). Bump on any change to its inputs. */
export const DIGEST_V = 2;
export const SNAPSHOT_VERSION = 3;

export const STORAGE_PREFIX = `${PROTOCOL}.${NETWORK}`;
export const ENV_PREFIX = "MURKLE_";
/** Reads MURKLE_<name> in Node; undefined in browsers. */
export const env = (name) => globalThis.process?.env?.[ENV_PREFIX + name];

export const EXPLORER = NET.explorer;
export const ESPLORA_API = NET.esplora;

// Private vulnerability reports: an email address or an https URL. null until a
// channel is published; /security then says one will be before any public launch.
export const SECURITY_CONTACT = "https://github.com/MurkleProtocol/murkle/security/advisories/new";

// The public source repository, e.g. "https://github.com/<owner>/<repo>" (no trailing
// slash). null until it is published; once set, the site shows the clone command on
// /verify, a Source link on /protocol and the private-advisory link on /security.
export const REPO_URL = "https://github.com/MurkleProtocol/murkle";

// Pins written by scripts/build-circuit.mjs (signet artifacts, manifest), by the ceremony's
// finalize --install (mainnet artifacts, manifest) and by the operator after the genesis
// ATTEST confirms (genesisTxid, activationHeight). One file per network (PINS_FILE).
const pins = NETWORK === "mainnet" ? mainnetPins : signetPins;
export const PINS = Object.freeze({ ...pins, artifacts: Object.freeze({ ...pins.artifacts }) });
export const MANIFEST_SHA256 = pins.manifestSha256 ?? null;
export const ARTIFACT_SHA256 = PINS.artifacts;
export const GENESIS_TXID = pins.genesisTxid ?? null;
export const ACTIVATION_HEIGHT = pins.activationHeight ?? null;

/**
 * Pre-genesis: no genesis ATTEST is pinned yet. Indexers start from saved
 * state or at tip + 1, skip the genesis check, and every surface says so.
 */
export const PRE_GENESIS = GENESIS_TXID == null || ACTIVATION_HEIGHT == null;

/** The genesis rule handed to `new Indexer({ genesis })`, or null before genesis. */
export const GENESIS = PRE_GENESIS ? null : Object.freeze({ txid: GENESIS_TXID, height: ACTIVATION_HEIGHT, manifestSha256: MANIFEST_SHA256 });

// ---------------------------------------------------------------- mining (SPEC.md §15)
// Consensus constants of DEPLOY_POW / MINE / MINE_SCRIPT. They apply only at and above
// the "mining" activation height (ACTIVATIONS below), which stays null until release.
export const MINE_WINDOW = 12; // H - 12 <= ref <= H - 1
export const STALE_FACTOR = 4; // D_eff = max(D(ref), D(H - 1) / 4)
export const MIN_DIFFICULTY = 256n;
export const SPAN_MIN = 12;
export const SPAN_MAX = 432;
export const MIN_SPAN_CLAIMS = 16; // targetPerSpan >= 16
export const MAX_PER_BLOCK = 100; // targetPerSpan <= 100 * span
export const MINE_SLACK = 2; // relayer: last signing tip = ref + 12 - 1 - 2
export const D_MAX = (1n << 63n) - 1n;
export const MINE_SALT_TEXT = "murkle/mine/salt"; // 16 ASCII bytes, the Argon2 salt
export const ARGON = Object.freeze({ type: "argon2id", version: 0x13, memoryKiB: 4096, passes: 1, lanes: 1, tagLength: 32 });
export const FEE_MIN_SATS = 546n; // smallest nonzero DEPLOYER claim fee
export const STANDARD_SCRIPTS = Object.freeze(["p2pkh", "p2sh", "p2wpkh", "p2wsh", "p2tr"]);

// Segwit address of a witness scriptPubKey (BIP 173 / BIP 350), for display. Kept here so the
// consensus constant below is the script alone and params.mjs needs no import.
const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
function bech32Polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}
/** "tb1p…" for "5120<32 bytes>" with hrp "tb"; v0 programs use bech32, v1+ bech32m. */
export function segwitAddress(hrp, scriptHex) {
  const s = scriptHex.match(/../g).map((b) => parseInt(b, 16));
  const version = s[0] === 0 ? 0 : s[0] - 0x50;
  if (version < 0 || version > 16 || s[1] !== s.length - 2) throw new Error("not a witness program");
  const words = [version];
  let acc = 0;
  let bits = 0;
  for (const b of s.slice(2)) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) { bits -= 5; words.push((acc >>> bits) & 31); }
  }
  if (bits) words.push((acc << (5 - bits)) & 31);
  const expand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = (bech32Polymod([...expand, ...words, 0, 0, 0, 0, 0, 0]) ^ (version === 0 ? 1 : 0x2bc830a3)) >>> 0;
  const check = [0, 1, 2, 3, 4, 5].map((i) => Math.floor(mod / 2 ** (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...check].map((w) => BECH32[w]).join("")}`;
}

// Per-claim service fee, per network. Consensus: fixed before activation; a change is a
// new rule with its own activation height. Owner decision: the platform only, 500 sats to
// the platform script (the signet MURK treasury, an operator key), no deployer fee (so a
// DEPLOY_POW must carry claimFeeSats = 0). Mainnet is a placeholder until the owner names the
// platform address (docs/MAINNET.md G5): mineFeeReady() says why mining cannot run, the Indexer
// refuses a mining activation with it, and the server and CLI refuse to mine.
const feeRule = ({ hrp, platformScript, ...rest }) => Object.freeze({ platformAddress: segwitAddress(hrp, platformScript), platformScript, ...rest });
export const TODO_PLATFORM_ADDRESS = "TODO_PLATFORM_ADDRESS";
export const MINE_FEES = Object.freeze({
  signet: feeRule({
    hrp: "tb",
    platformScript: "51203084846915ba86451221466028377de3bcf2ad8dc19ab8137684407dba6a9bab", // hex scriptPubKey (P2TR)
    platformSats: 500n,
    deployerMinSats: 0n,
    deployerMaxSats: 0n, // 0 forbids a deployer fee
  }),
  // TODO(owner): replace with feeRule({ hrp: "bc", platformScript: "<hex from murkle address-script>", ... }).
  mainnet: Object.freeze({
    placeholder: true,
    platformAddress: TODO_PLATFORM_ADDRESS,
    platformScript: null,
    platformSats: 1000n, // proposed; the owner confirms
    deployerMinSats: 0n,
    deployerMaxSats: 0n,
  }),
});
export const MINE_FEE = MINE_FEES[NETWORK] ?? null;

/**
 * Why mining cannot run with `fee` on this network, or null when the rule is complete.
 * Checks presence and the placeholder only; M.assertMineFee (src/mine.mjs) checks the values.
 */
export function mineFeeReady(fee = MINE_FEE) {
  if (!fee) return `mining is not configured on ${NETWORK}: there is no MINE_FEE rule`;
  if (fee.placeholder || fee.platformAddress === TODO_PLATFORM_ADDRESS || (BigInt(fee.platformSats ?? 0) > 0n && !fee.platformScript)) {
    return `mining is not configured on ${NETWORK}: the platform address is ${TODO_PLATFORM_ADDRESS}`;
  }
  return null;
}

// Consensus changes after v1 (SPEC.md §10), from src/pins.json: [{ name, height: number | null, digestV }].
export const ACTIVATIONS = Object.freeze((pins.activations ?? []).map((a) => Object.freeze({ ...a })));

/** Height at which the named rule set activates, or null (not scheduled). */
export function activationHeight(name, activations = ACTIVATIONS) {
  return activations.find((a) => a.name === name)?.height ?? null;
}

/** Digest version at `height`: the digestV of the newest activation with a non-null height <= height, else 1. */
export function digestVersionAt(height, activations = ACTIVATIONS) {
  let v = 1;
  let at = -Infinity;
  for (const a of activations) {
    if (a.height == null || a.height > height) continue;
    if (a.height > at || (a.height === at && a.digestV > v)) { v = a.digestV; at = a.height; }
  }
  return v;
}

export const MINING_HEIGHT = activationHeight("mining"); // null in this build: mining is off on the live chain

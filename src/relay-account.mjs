// Relay balance accounts (docs/design/relay-balance.md, contract §1), shared by
// the wallet, the CLI and the relayer. Browser-safe: no node:* imports.
//
// - The account key comes from the wallet's 32-byte seed with the label
//   murkle/relay-account/v1/<network>; the account id is sha256 of its x-only key.
// - Deposit address n of an account is a plain key-path P2TR whose internal key is
//   lift_x(Q) + t·G, t = taggedHash(DEPOSIT_TAG, Q ‖ id ‖ u32be(n)). Only the
//   relayer, who holds Q's secret, can spend it (depositSecret).
// - Requests to the relayer are signed with BIP340 over a digest that binds the
//   endpoint, the network, Q and the exact request fields.
import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { hkdf } from "@noble/hashes/hkdf";
import { NETWORK, label } from "./params.mjs";
import { bigToBytes, bytesToBig, concat, hex, unhex } from "./bytes.mjs";

export const RELAY_SIGN_TAG = label("relay/v1");
export const DEPOSIT_TAG = label("relay-deposit/v1");
export const accountLabel = (network) => label(`relay-account/v1/${network}`);
export const RELAY_NETWORKS = Object.freeze(["signet", "testnet", "mainnet"]);
export const DEPOSIT_CONFIRMATIONS = Object.freeze({ signet: 1, testnet: 1, mainnet: 3 });
export const MAX_DEPOSIT_INDEX = 2 ** 31 - 1;
export const MAX_SKEW_SEC = 600;
export const RELAY_ENDPOINTS = Object.freeze({ account: "/api/relay/account", submit: "/api/relay/submit" });
/** The modes a signed submit may name (src/relay-batch.mjs). */
export const RELAY_MODES = Object.freeze(["fast", "block", "batch", "batch10"]);
/** The exact key set of each signed request body, sig included. */
export const REQUEST_FIELDS = Object.freeze({
  [RELAY_ENDPOINTS.account]: Object.freeze(["accountPub", "sig", "t"]),
  [RELAY_ENDPOINTS.submit]: Object.freeze(["accountPub", "envelope", "mode", "sig", "t"]),
});
/**
 * Signed fields a body may add to its exact key set, each with its only allowed type. A submit
 * may carry the boolean `linkable` (L1): the sender accepts that a thin relay pool ties the
 * carrier's input to its own top-up. Absent means false.
 */
export const OPTIONAL_REQUEST_FIELDS = Object.freeze({
  [RELAY_ENDPOINTS.account]: Object.freeze({}),
  [RELAY_ENDPOINTS.submit]: Object.freeze({ linkable: "boolean" }),
});

const MAX_VOUT = 4294967295;
const N = schnorr.Point.Fn.ORDER;
const G = schnorr.Point.BASE;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX_SIG = /^[0-9a-f]{128}$/;
const OUTPOINT = /^([0-9a-f]{64}):(0|[1-9][0-9]{0,9})$/;
const utf8 = (s) => new TextEncoder().encode(s);

/** .code: "malformed" | "bad_outpoint" | "bad_signature" | "stale_request" | "bad_network" */
export class RelayAccountError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "RelayAccountError";
    this.code = code;
  }
}
const malformed = (message) => new RelayAccountError("malformed", message);

/** signet | testnet -> scure's TEST_NETWORK (tb1…), mainnet -> NETWORK (bc1…). */
export function btcNetwork(network) {
  if (network === "signet" || network === "testnet") return btc.TEST_NETWORK;
  if (network === "mainnet") return btc.NETWORK;
  throw new RelayAccountError("bad_network", `unknown network "${network}"`);
}

const isBytes = (b, len) => b instanceof Uint8Array && b.length === len;

/** The curve point with even y whose x coordinate is `x` (BIP340 lift_x); throws if there is none. */
function liftX(x) {
  try {
    return schnorr.utils.lift_x(bytesToBig(x));
  } catch {
    throw malformed("not a valid x-only public key");
  }
}

const xOnly = (point) => bigToBytes(point.toAffine().x, 32);

/**
 * The relay account of a wallet seed on a network.
 * -> { network, secret, pub (BIP340 x-only), pubHex, id = sha256(pub), idHex }
 */
export function relayAccount(seed, network = NETWORK) {
  btcNetwork(network);
  if (!isBytes(seed, 32)) throw malformed("the relay account needs the wallet's 32-byte seed");
  const secret = hkdf(sha256, seed, undefined, accountLabel(network), 32);
  if (!secp256k1.utils.isValidSecretKey(secret)) throw malformed("this seed gives an unusable relay account key");
  const pub = schnorr.getPublicKey(secret);
  const id = sha256(pub);
  return { network, secret, pub, pubHex: hex(pub), id, idHex: hex(id) };
}

/** The account id of an x-only account key: sha256(pub). */
export function accountIdOf(pub) {
  if (!isBytes(pub, 32)) throw malformed("an account key is 32 bytes");
  return sha256(pub);
}

/** 64 lowercase hex characters of a valid x-only key -> its 32 bytes. */
export function parseAccountPub(text) {
  if (typeof text !== "string" || !HEX64.test(text)) throw malformed("accountPub must be 64 lowercase hex characters");
  const pub = unhex(text);
  liftX(pub);
  return pub;
}

/** The pool key Q: 32 bytes or 64 lowercase hex characters of a valid x-only key -> a copy of its 32 bytes. */
export function parsePoolKey(keyOrHex) {
  let key;
  if (typeof keyOrHex === "string") {
    if (!HEX64.test(keyOrHex)) throw malformed("the pool key must be 64 lowercase hex characters");
    key = unhex(keyOrHex);
  } else if (isBytes(keyOrHex, 32)) {
    key = Uint8Array.from(keyOrHex);
  } else {
    throw malformed("the pool key must be 32 bytes");
  }
  liftX(key);
  return key;
}

function parseId(id) {
  if (typeof id === "string" && HEX64.test(id)) return unhex(id);
  if (isBytes(id, 32)) return id;
  throw malformed("an account id is 32 bytes");
}

function checkIndex(n) {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_DEPOSIT_INDEX) throw malformed(`deposit index must be an integer 0..${MAX_DEPOSIT_INDEX}`);
  return n;
}

const u32be = (n) => bigToBytes(BigInt(n), 4);

/** t = int(taggedHash(DEPOSIT_TAG, Q ‖ id ‖ u32be(n))) mod N, as a bigint. */
export function depositTweak(poolKey, id, n) {
  const Q = parsePoolKey(poolKey);
  const t = bytesToBig(schnorr.utils.taggedHash(DEPOSIT_TAG, Q, parseId(id), u32be(checkIndex(n)))) % N;
  if (t === 0n) throw malformed("deposit tweak is zero");
  return t;
}

/** The x-only internal key of deposit address n: lift_x(Q) + t·G. */
export function depositKey(poolKey, id, n) {
  return depositKeyOfTweak(poolKey, depositTweak(poolKey, id, n));
}

/**
 * lift_x(Q) + t·G for a deposit tweak t (depositTweak). The relayer keeps only t for a deposit
 * it still holds, never the account id: t is a hash of the id and cannot be turned back into it.
 */
export function depositKeyOfTweak(poolKey, t) {
  const tw = checkTweak(t);
  const P = liftX(parsePoolKey(poolKey)).add(G.multiply(tw));
  if (P.is0()) throw malformed("deposit key is the point at infinity");
  return xOnly(P);
}

function checkTweak(t) {
  const v = typeof t === "string" && HEX64.test(t) ? bytesToBig(unhex(t)) : t;
  if (typeof v !== "bigint" || v <= 0n || v >= N) throw malformed("a deposit tweak is an integer 1..N-1");
  return v;
}

/** A deposit tweak as 64 lowercase hex characters (how the relayer stores it). */
export const tweakHex = (t) => hex(bigToBytes(checkTweak(t), 32));

/**
 * Deposit address n of account `id` under pool key Q: a plain key-path P2TR
 * whose internal key is depositKey (the usual no-script-tree tweak on top).
 * -> { n, key, address, script }
 */
export function depositAddress(poolKey, id, n, network = NETWORK) {
  const net = btcNetwork(network);
  const key = depositKey(poolKey, id, n);
  const pay = btc.p2tr(key, undefined, net);
  return { n, key, address: pay.address, script: pay.script };
}

/**
 * Server side: the secret that spends deposit address n, d = (q' + t) mod N with
 * q' the even-y form of the pool secret q. schnorr.getPublicKey(d) equals
 * depositKey(Q, id, n).
 */
export function depositSecret(poolSecret, id, n) {
  if (!isBytes(poolSecret, 32) || !secp256k1.utils.isValidSecretKey(poolSecret)) throw malformed("the pool secret must be a valid 32-byte key");
  return depositSecretOfTweak(poolSecret, depositTweak(schnorr.getPublicKey(poolSecret), id, n));
}

/** The secret of the deposit key with tweak t (depositKeyOfTweak): (q' + t) mod N. */
export function depositSecretOfTweak(poolSecret, t) {
  if (!isBytes(poolSecret, 32) || !secp256k1.utils.isValidSecretKey(poolSecret)) throw malformed("the pool secret must be a valid 32-byte key");
  const q = bytesToBig(poolSecret);
  const even = G.multiply(q).toAffine().y % 2n === 0n;
  const qEven = even ? q : N - q;
  const d = (qEven + checkTweak(t)) % N;
  if (d === 0n) throw malformed("deposit secret is zero");
  return bigToBytes(d, 32);
}

/**
 * Strict outpoint: 64 lowercase hex, ":", a decimal vout with no sign, spaces or
 * leading zeros, at most 4294967295. -> { txid, vout, key: `${txid}:${vout}` }
 */
export function parseOutpoint(text) {
  const m = typeof text === "string" ? OUTPOINT.exec(text) : null;
  const vout = m ? Number(m[2]) : NaN;
  if (!m || !(vout <= MAX_VOUT)) throw new RelayAccountError("bad_outpoint", "an outpoint is a 64-character lowercase txid, a colon and the output number");
  return { txid: m[1], vout, key: `${m[1]}:${vout}` };
}

const isPlainObject = (o) => o !== null && typeof o === "object" && !Array.isArray(o)
  && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);

/**
 * The signed form of request fields: JSON with the keys sorted and no
 * whitespace. Values must be strings, booleans or safe integers >= 0; "sig",
 * nested objects, floats, negatives and non-plain objects are refused ("malformed").
 */
export function canonicalBody(fields) {
  if (!isPlainObject(fields)) throw malformed("request fields must be a plain object");
  const out = Object.create(null);
  for (const key of Object.keys(fields).sort()) {
    if (key === "sig") throw malformed("the signature is not part of the signed fields");
    const v = fields[key];
    const ok = typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isSafeInteger(v) && v >= 0);
    if (!ok) throw malformed(`field "${key}" must be a string, a boolean or a non-negative integer`);
    out[key] = Object.is(v, -0) ? 0 : v;
  }
  return JSON.stringify(out);
}

function lp(s, what) {
  if (typeof s !== "string") throw malformed(`${what} must be a string`);
  const b = utf8(s);
  if (!b.length || b.length > 255) throw malformed(`${what} must be 1 to 255 bytes`);
  return concat(Uint8Array.of(b.length), b);
}

/** taggedHash(RELAY_SIGN_TAG, lp(endpoint) ‖ lp(network) ‖ Q ‖ sha256(utf8(canonicalBody(fields)))) */
export function requestDigest({ endpoint, network, poolKey, fields }) {
  if (!RELAY_NETWORKS.includes(network)) throw new RelayAccountError("bad_network", `unknown network "${network}"`);
  return schnorr.utils.taggedHash(
    RELAY_SIGN_TAG, lp(endpoint, "endpoint"), lp(network, "network"), parsePoolKey(poolKey), sha256(utf8(canonicalBody(fields))),
  );
}

/** -> { ...fields, accountPub, t (seconds), sig (128 lowercase hex, BIP340) } */
export function signRequest({ account, endpoint, network, poolKey, fields = {}, now = Date.now }) {
  if (!account || !isBytes(account.secret, 32)) throw malformed("signing needs a relay account");
  if (!isPlainObject(fields)) throw malformed("request fields must be a plain object");
  if (Object.hasOwn(fields, "sig")) throw malformed("the fields already carry a signature");
  const pub = schnorr.getPublicKey(account.secret);
  const signed = { ...fields, accountPub: hex(pub), t: Math.floor(now() / 1000) };
  const digest = requestDigest({ endpoint, network, poolKey, fields: signed });
  return { ...signed, sig: hex(schnorr.sign(digest, account.secret)) };
}

const refuse = (code) => ({ ok: false, code });

/**
 * Checks a signed request body (the parsed JSON object) for `endpoint`: the
 * exact key set (plus any OPTIONAL_REQUEST_FIELDS of the right type), accountPub,
 * t, sig, the clock skew, then the signature.
 * -> { ok: true, pub, id, idHex, fields (every field but sig) }
 *  | { ok: false, code: "malformed" | "stale_request" | "bad_signature" }
 */
export function verifyRequest({ endpoint, network, poolKey, body, now = Date.now, maxSkewSec = MAX_SKEW_SEC }) {
  // The network and Q are the relayer's own configuration: a bad one throws instead of refusing the request.
  if (!RELAY_NETWORKS.includes(network)) throw new RelayAccountError("bad_network", `unknown network "${network}"`);
  const Q = parsePoolKey(poolKey);
  const keys = REQUEST_FIELDS[endpoint];
  if (!keys || !isPlainObject(body)) return refuse("malformed");
  const got = Object.keys(body).sort();
  const optional = OPTIONAL_REQUEST_FIELDS[endpoint] ?? {};
  const base = got.filter((k) => !Object.hasOwn(optional, k));
  if (base.length !== keys.length || base.some((k, i) => k !== keys[i])) return refuse("malformed");
  for (const k of got) if (Object.hasOwn(optional, k) && typeof body[k] !== optional[k]) return refuse("malformed");
  let pub;
  try {
    pub = parseAccountPub(body.accountPub);
  } catch {
    return refuse("malformed");
  }
  const { t, sig } = body;
  if (!Number.isSafeInteger(t) || t < 0) return refuse("malformed");
  if (typeof sig !== "string" || !HEX_SIG.test(sig)) return refuse("malformed");
  if (endpoint === RELAY_ENDPOINTS.submit) {
    if (typeof body.envelope !== "string" || !/^(?:[0-9a-f]{2})+$/.test(body.envelope)) return refuse("malformed");
    if (!RELAY_MODES.includes(body.mode)) return refuse("malformed");
  }
  if (Math.abs(Math.floor(now() / 1000) - t) > maxSkewSec) return refuse("stale_request");
  const fields = {};
  for (const k of got) if (k !== "sig") fields[k] = body[k];
  let ok = false;
  try {
    ok = schnorr.verify(unhex(sig), requestDigest({ endpoint, network, poolKey: Q, fields }), pub);
  } catch {
    ok = false;
  }
  if (!ok) return refuse("bad_signature");
  const id = sha256(pub);
  return { ok: true, pub, id, idHex: hex(id), fields };
}

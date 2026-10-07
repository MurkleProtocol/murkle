// Wallet keys, shielded addresses and output-note encryption (SPEC.md §2-3).
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { x25519 } from "@noble/curves/ed25519";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { bech32m } from "@scure/base";
import { FIELD, commitmentOf, pubkeyOf } from "./core.mjs";
import { bigToBytes, bytesToBig, concat as concatBytes, readU64le, u64le } from "./bytes.mjs";
import { ADDRESS_HRP, BRAND, LABELS, NETWORKS } from "./params.mjs";

export { ADDRESS_HRP };
export const NOTE_CT_LEN = 95; // epk 32 + plaintext 47 + tag 16

/** Derives spend and view keys from a 32-byte seed. */
export function deriveKeys(seed) {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const sk = bytesToBig(hkdf(sha256, seed, undefined, LABELS.spend, 64)) % FIELD;
  const vsk = hkdf(sha256, seed, undefined, LABELS.view, 32);
  return { sk, pk: pubkeyOf(sk), vsk, vpk: x25519.getPublicKey(vsk) };
}

/**
 * The built-in wallet's two Bitcoin fee keys from the wallet entropy. `feeKey` pays transfers and
 * relay top-ups (unchanged since v1); `mineFeeKey` pays self-paid mining claims only, so the
 * claims of one wallet never share an address with its transfers (mining.md §12.1).
 * Either may be an invalid secp256k1 secret (odds about 2^-128); callers check.
 */
export function feeKeysOf(entropy) {
  if (!(entropy instanceof Uint8Array) || entropy.length < 16) throw new Error("entropy must be at least 16 bytes");
  if (typeof LABELS.btcMineFee !== "string") throw new Error("this build has no mining fee label");
  return {
    feeKey: hkdf(sha256, entropy, undefined, LABELS.btcFee, 32),
    mineFeeKey: hkdf(sha256, entropy, undefined, LABELS.btcMineFee, 32),
  };
}

export function encodeAddress({ pk, vpk }) {
  return bech32m.encode(ADDRESS_HRP, bech32m.toWords(concatBytes(bigToBytes(pk, 32), vpk)), 200);
}

// A shielded address of another network (mrk1… is signet, murk1… mainnet): refused with a clear
// message instead of "not a Murkle address", so nobody pays across networks by mistake.
const OTHER_NETWORK_HRP = Object.values(NETWORKS).filter((n) => n.addressHrp !== ADDRESS_HRP);
const NETWORK_LABEL = { signet: "Bitcoin signet", mainnet: "Bitcoin mainnet" };
function otherNetworkOf(address) {
  const lower = typeof address === "string" ? address.trim().toLowerCase() : "";
  return OTHER_NETWORK_HRP.find((n) => lower.startsWith(`${n.addressHrp}1`)) ?? null;
}

export function decodeAddress(address) {
  const other = otherNetworkOf(address);
  if (other) {
    const here = Object.values(NETWORKS).find((n) => n.addressHrp === ADDRESS_HRP);
    throw new Error(`This is a ${BRAND} ${other.name} address (${other.addressHrp}1…). This wallet is on ${NETWORK_LABEL[here.name] ?? here.name}.`);
  }
  const { prefix, words } = bech32m.decode(address, 200);
  const data = bech32m.fromWords(words);
  if (prefix !== ADDRESS_HRP || data.length !== 64) throw new Error(`not a ${BRAND} address`);
  const pk = bytesToBig(data.slice(0, 32));
  if (pk >= FIELD) throw new Error("invalid spend key in address");
  return { pk, vpk: data.slice(32) };
}

const noteKey = (shared, epk, vpk) => hkdf(sha256, shared, concatBytes(epk, vpk), LABELS.note, 32);

/** Encrypts one output note to the recipient's view key; the AEAD is bound to the commitment. */
export function encryptNote({ asset, amount, blinding, vpk, commitment }) {
  const esk = x25519.utils.randomSecretKey();
  const epk = x25519.getPublicKey(esk);
  const key = noteKey(x25519.getSharedSecret(esk, vpk), epk, vpk);
  const pt = concatBytes(u64le(asset), u64le(amount), bigToBytes(blinding, 31));
  const ct = chacha20poly1305(key, new Uint8Array(12), bigToBytes(commitment, 32)).encrypt(pt);
  return concatBytes(epk, ct);
}

/**
 * Returns { asset, amount, blinding } if the ciphertext is addressed to `keys`
 * and opens to exactly the published commitment; otherwise null.
 */
export function tryDecryptNote(ciphertext, keys, commitment) {
  if (ciphertext.length !== NOTE_CT_LEN) return null;
  const epk = ciphertext.slice(0, 32);
  let pt;
  try {
    const key = noteKey(x25519.getSharedSecret(keys.vsk, epk), epk, keys.vpk);
    pt = chacha20poly1305(key, new Uint8Array(12), bigToBytes(commitment, 32)).decrypt(ciphertext.slice(32));
  } catch {
    return null;
  }
  const note = { asset: readU64le(pt, 0), amount: readU64le(pt, 8), blinding: bytesToBig(pt.slice(16)) };
  return commitmentOf({ ...note, pubkey: keys.pk }) === commitment ? note : null;
}

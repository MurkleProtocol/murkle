// Shared by the circuit build (scripts/build-circuit.mjs) and the mainnet key tools
// (scripts/mainnet-key.mjs, scripts/verify-key.mjs): the pinned phase-1 file, the hash helpers
// and the words the key's manifest and the site use for the single-party mainnet key.
// No snarkjs import here, so the facts script can read the constants cheaply.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { blake2b } from "@noble/hashes/blake2b";

export const PTAU = {
  name: "powersOfTau28_hez_final_15.ptau",
  // The original bucket answers 403 since September 2026; the mirrors serve
  // the identical file. Any source is accepted only if both hashes match.
  urls: [
    "https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_15.ptau",
    "https://github.com/MurkleProtocol/murkle/releases/download/artifacts-41d28d8899f3/powersOfTau28_hez_final_15.ptau",
    "https://github.com/hilawe/dash-mno-verify/releases/download/ptau-hermez-v1/powersOfTau28_hez_final_15.ptau",
  ],
  size: 37831832,
  sha256: "3ef2ecc5b75d687048cf2d59195119b42fb07c5af639c5f283d84bfa69829e7f",
  // Published in the snarkjs README next to the original download link.
  blake2b: "982372c867d229c236091f767e703253249a9b432c1710b4f326306bfa2428a17b06240359606cfe4d580b10a5a1f63fbed499527069c18ae17060472969ae6e",
};

/** What the phase-1 file is, in the words the manifest and the site use. */
export const PHASE1_PROVENANCE = "Perpetual Powers of Tau, Hermez final preparation: 54 contributions and a beacon";
/** The one phase-2 contribution of the mainnet key (snarkjs keeps at most 64 characters of a name). */
export const MAINNET_CONTRIBUTION_NAME = "Murkle mainnet key (single party)";
export const MAINNET_PHASE2 = "single-party (Murkle operator), 1 contribution";
/** The setup line of the mainnet manifest and facts (web/src/facts.mainnet.json). */
export const MAINNET_SETUP = "single-party (Murkle operator) on the public Hermez powers of tau";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const sha256File = (path) => sha256(readFileSync(path));

/** Both hashes must match: sha256 is our pin, blake2b is the one snarkjs publishes. */
export function checkPtau(path, pin = PTAU) {
  const bytes = readFileSync(path);
  const s = sha256(bytes);
  const b = Buffer.from(blake2b(bytes)).toString("hex");
  if (bytes.length !== pin.size || s !== pin.sha256 || b !== pin.blake2b) {
    throw new Error(`${path}: hash mismatch (size ${bytes.length}, sha256 ${s}, blake2b ${b.slice(0, 16)}…)`);
  }
  return s;
}

/** nConstraints from the r1cs header section (iden3 r1cs binary format v1). */
export function r1csConstraints(path) {
  const b = readFileSync(path);
  if (b.toString("latin1", 0, 4) !== "r1cs") throw new Error("not an r1cs file");
  let o = 12; // magic, version, nSections
  for (let i = 0, n = b.readUInt32LE(8); i < n; i++) {
    const type = b.readUInt32LE(o);
    const size = Number(b.readBigUInt64LE(o + 4));
    if (type === 1) {
      const fieldSize = b.readUInt32LE(o + 12);
      // fieldSize, prime, nWires, nPubOut, nPubIn, nPrvIn, nLabels (u64), nConstraints
      return b.readUInt32LE(o + 12 + 4 + fieldSize + 16 + 8);
    }
    o += 12 + size;
  }
  throw new Error("r1cs header not found");
}

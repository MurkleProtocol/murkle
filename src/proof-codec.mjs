// Groth16/BN254 proof wire format: A (G1, 32) ‖ B (G2, 64) ‖ C (G1, 32) = 128 bytes.
// Each point is its x coordinate, big-endian; bit 7 of the first byte carries the
// sign of y (noble's isOdd), bit 6 (infinity) must be clear. Decoding rejects
// anything that is not a canonical, on-curve, prime-order-subgroup point.
//
// This matters because snarkjs' verifier only checks that points are on the
// curve: it accepts the point at infinity and G2 points outside the r-torsion.
import { bn254 } from "@noble/curves/bn254";
import { bigToBytes, bytesToBig } from "./bytes.mjs";

const G1 = bn254.G1.ProjectivePoint ?? bn254.G1.Point;
const G2 = bn254.G2.ProjectivePoint ?? bn254.G2.Point;
const { Fp, Fp2 } = bn254.fields;
const P = Fp.ORDER;
const SIGN = 0x80;
const FLAGS = 0xc0;
export const PROOF_LEN = 128;

// y^2 = x^3 + b on each curve; b for G2 is recovered from the generator.
const B1 = 3n;
const B2 = (() => {
  const { x, y } = G2.BASE.toAffine();
  return Fp2.sub(Fp2.sqr(y), Fp2.mul(Fp2.sqr(x), x));
})();

const toBytes32 = (x) => bigToBytes(x, 32);
const fromBytes = bytesToBig;

function readCoord(bytes, withFlags) {
  const b = Uint8Array.from(bytes);
  if (withFlags) b[0] &= ~FLAGS;
  const v = fromBytes(b);
  if (v >= P) throw new Error("non-canonical coordinate");
  return v;
}

function flagsOf(byte) {
  if (byte & 0x40) throw new Error("point at infinity is not allowed");
  return (byte & SIGN) !== 0;
}

function encodeG1([x, y]) {
  const b = toBytes32(x);
  if (Fp.isOdd(BigInt(y))) b[0] |= SIGN;
  return b;
}

function decodeG1(bytes) {
  const odd = flagsOf(bytes[0]);
  const x = readCoord(bytes, true);
  let y = Fp.sqrt(Fp.add(Fp.mul(Fp.sqr(x), x), B1)); // throws if x is not on the curve
  if (Fp.isOdd(y) !== odd) y = Fp.neg(y);
  G1.fromAffine({ x, y }).assertValidity(); // cofactor 1: on-curve == in subgroup
  return [x, y];
}

function encodeG2([[x0, x1], [y0, y1]]) {
  const b = new Uint8Array(64);
  b.set(toBytes32(x0), 0);
  b.set(toBytes32(x1), 32);
  if (Fp2.isOdd(Fp2.fromBigTuple([BigInt(y0), BigInt(y1)]))) b[0] |= SIGN;
  return b;
}

function decodeG2(bytes) {
  const odd = flagsOf(bytes[0]);
  const x = Fp2.fromBigTuple([readCoord(bytes.slice(0, 32), true), readCoord(bytes.slice(32, 64), false)]);
  let y = Fp2.sqrt(Fp2.add(Fp2.mul(Fp2.sqr(x), x), B2));
  if (Fp2.isOdd(y) !== odd) y = Fp2.neg(y);
  const point = G2.fromAffine({ x, y });
  point.assertValidity();
  if (!point.isTorsionFree()) throw new Error("G2 point outside the prime-order subgroup");
  return [[x.c0, x.c1], [y.c0, y.c1]];
}

/** snarkjs proof object -> 128 bytes. */
export function encodeProof(proof) {
  const out = new Uint8Array(PROOF_LEN);
  out.set(encodeG1(proof.pi_a), 0);
  out.set(encodeG2(proof.pi_b), 32);
  out.set(encodeG1(proof.pi_c), 96);
  return out;
}

/** 128 bytes -> snarkjs proof object; throws on any invalid point. */
export function decodeProof(bytes) {
  if (bytes.length !== PROOF_LEN) throw new Error("bad proof length");
  const s = (v) => v.toString();
  const [ax, ay] = decodeG1(bytes.slice(0, 32));
  const [[bx0, bx1], [by0, by1]] = decodeG2(bytes.slice(32, 96));
  const [cx, cy] = decodeG1(bytes.slice(96, 128));
  return {
    pi_a: [s(ax), s(ay), "1"],
    pi_b: [[s(bx0), s(bx1)], [s(by0), s(by1)], ["1", "0"]],
    pi_c: [s(cx), s(cy), "1"],
    protocol: "groth16",
    curve: "bn128",
  };
}

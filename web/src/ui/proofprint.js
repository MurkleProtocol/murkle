/**
 * Proofprint (visual.md section 6.9): a deterministic guilloche rosette drawn from the first
 * 32 bytes of the compressed proof. A visual fingerprint only; it is not a security check.
 *
 * API
 *   proofprintParams(bytes) -> { n, L, inner, phi, twist }
 *   proofprintPaths(bytes, { R, cx, cy, lines }) -> string[]   one closed path "d" per line
 *   proofprint(proof, { size, mined, verified, half, cx, cy, R, bare })
 *       -> Safe <svg> (or a bare <g> with `bare: true`, for embedding in the seal emblem).
 *          `proof` is a Uint8Array or a hex string (at least 5 bytes are used).
 *          mined: line 0 is drawn in --btc; verified: line L-1 in --proof.
 *          half: draw only L/2 lines (24px activity rows).
 *   PROOFPRINT_TIP  tooltip sentence
 *
 * Line k uses the phase offset k·twist·2π/L. visual.md 6.9 writes k·twist·2π/(n·L); inside
 * sin(n·θ + …) the extra 1/n shrinks the spread to a few percent of one petal, so all lines
 * collapse into a single stroke at every size. Dropping it keeps every parameter and the
 * determinism, and spreads the lines over `twist` of a petal, which reads as engraving.
 */
import { Safe } from "./dom.js";

export const PROOFPRINT_TIP = "Visual fingerprint of the proof bytes. Not a security check; use Verify.";

function toBytes(proof) {
  if (proof instanceof Uint8Array) return proof;
  const s = String(proof ?? "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2) throw new Error("proofprint needs bytes or hex");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function proofprintParams(bytes) {
  const b = toBytes(bytes);
  if (b.length < 5) throw new Error("proofprint needs at least 5 bytes");
  return {
    n: 5 + (b[0] % 9),
    L: 8 + (b[1] % 9),
    inner: 0.35 + (b[2] / 255) * 0.35,
    phi: (b[3] / 255) * 2 * Math.PI,
    twist: 0.15 + (b[4] / 255) * 0.6,
  };
}

const r2 = (v) => Math.round(v * 100) / 100;

export function proofprintPaths(bytes, { R = 50, cx = 50, cy = 50, lines = null } = {}) {
  const { n, L, inner, phi, twist } = proofprintParams(bytes);
  const count = lines ?? L;
  const out = [];
  for (let k = 0; k < count; k++) {
    let d = "";
    // 144 samples, 2.5 degrees apart, closed.
    for (let i = 0; i < 144; i++) {
      const th = (i * 2.5 * Math.PI) / 180;
      const rho = R * (inner + (1 - inner) * (0.5 + 0.5 * Math.sin(n * th + phi + (k * twist * 2 * Math.PI) / L)));
      d += `${i ? "L" : "M"}${r2(cx + rho * Math.cos(th))} ${r2(cy + rho * Math.sin(th))}`;
    }
    out.push(d + "Z");
  }
  return out;
}

export function proofprint(proof, { size = 112, mined = false, verified = false, half = false, cx, cy, R, bare = false } = {}) {
  const { L } = proofprintParams(proof);
  const lines = half ? Math.max(1, Math.floor(L / 2)) : L;
  const c = cx ?? size / 2;
  const paths = proofprintPaths(proof, { R: R ?? size / 2 - 1, cx: c, cy: cy ?? c, lines });
  const last = lines - 1;
  const body = paths
    .map((d, k) => {
      const tone = k === 0 && mined ? "pp-btc" : k === last && verified && last > 0 ? "pp-proof" : "";
      return `<path class="pp-line${tone ? " " + tone : ""}" d="${d}"/>`;
    })
    .join("");
  const g = `<g class="proofprint-g" fill="none" stroke-width="${size <= 32 ? 0.8 : 0.6}">${body}</g>`;
  if (bare) return new Safe(g);
  return new Safe(
    `<svg class="proofprint" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Proofprint" data-tip="${PROOFPRINT_TIP}">${g}</svg>`,
  );
}

/**
 * Token sigil (visual.md section 6.10): a deterministic 5x5 mirrored identicon, so every token
 * has a logo without uploads or image hosting. Identity colors only (never orange/green/red).
 *
 * API
 *   sigilPattern(seed) -> { cells: boolean[25] (row-major), color: 1..6 }
 *       seed: the asset id (bigint, number or decimal string) or any string (e.g. an address).
 *       h = sha256(utf8(String(seed))); 15 cells (3 columns x 5 rows) come from the bits of h[0..1],
 *       at least 5 are forced on; color = 1 + h[2] % 6.
 *   sigil(seed, { size, label }) -> Safe <svg>   sizes 20, 32, 40, 56, 96 are the design sizes
 */
import { sha256 } from "@noble/hashes/sha256";
import { esc, Safe } from "./dom.js";

const enc = new TextEncoder();

export function sigilPattern(seed) {
  const h = sha256(enc.encode(String(seed)));
  const bits = (h[0] << 8) | h[1];
  // left[r][c] for c in 0..2 (c = 2 is the center column)
  const left = [];
  let on = 0;
  for (let i = 0; i < 15; i++) {
    const v = (bits >> (15 - i)) & 1;
    left.push(v === 1);
    on += v;
  }
  // Force at least 5 cells on, walking a hash-chosen order so it stays deterministic.
  for (let j = 0; on < 5 && j < 15; j++) {
    const idx = (h[3 + j] ?? j) % 15;
    if (!left[idx]) {
      left[idx] = true;
      on++;
    }
  }
  for (let idx = 0; on < 5 && idx < 15; idx++) {
    if (!left[idx]) {
      left[idx] = true;
      on++;
    }
  }
  const cells = new Array(25).fill(false);
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      const v = left[r * 3 + c];
      cells[r * 5 + c] = v;
      cells[r * 5 + (4 - c)] = v;
    }
  }
  return { cells, color: 1 + (h[2] % 6) };
}

export function sigil(seed, { size = 40, label = null } = {}) {
  const { cells, color } = sigilPattern(seed);
  // 5 cells in a 100-unit box with 16 units of inset, so the pattern breathes inside the tile.
  const pad = 16;
  const cell = (100 - 2 * pad) / 5;
  let rects = "";
  cells.forEach((v, i) => {
    if (!v) return;
    const x = pad + (i % 5) * cell;
    const y = pad + Math.floor(i / 5) * cell;
    rects += `<rect x="${x}" y="${y}" width="${cell + 0.3}" height="${cell + 0.3}"/>`;
  });
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : `aria-hidden="true"`;
  return new Safe(
    `<svg class="sigil" width="${size}" height="${size}" viewBox="0 0 100 100" ${a11y}>` +
      `<rect class="sigil-tile" x="0.5" y="0.5" width="99" height="99" rx="28" ry="28"/>` +
      `<g fill="var(--sg-${color})">${rects}</g></svg>`,
  );
}

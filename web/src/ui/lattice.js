/**
 * Merkle lattice (visual.md section 8): one SVG behind the landing and receipt heroes. A binary
 * tree rooted at the left middle fans out to 2^depth leaves at the right edge. Leaves map to
 * `leafIndex mod 2^depth` of the newest window of outputs: occupied leaves are filled dots,
 * empty ones hollow. New leaves flash --btc for 1.2s, then settle to --text-3.
 *
 * API
 *   windowLeaves(total, depth = 6) -> Set<number>      occupied leaf slots for `total` outputs
 *   latticeSVG({ depth = 6, occupied = [], fresh = [] }) -> Safe <svg class="lattice">
 *   mountLattice(container, { depth })                  -> { update(total), destroy() }
 *       Renders into `container` (position it absolutely behind the content). update(total)
 *       redraws the occupied leaves when the total changed; slots added since the previous
 *       total flash once.
 *       Depth drops to 5 on phones (under 768px); reduced motion keeps it static.
 */
import { Safe, reducedMotion } from "./dom.js";

const W = 1000;
const H = 600;
const PAD = 24;

export function windowLeaves(total, depth = 6) {
  const n = Math.max(0, Number(total) || 0);
  const size = 2 ** depth;
  const start = n === 0 ? 0 : Math.floor((n - 1) / size) * size;
  const out = new Set();
  for (let i = start; i < n; i++) out.add(i % size);
  return out;
}

export function latticeSVG({ depth = 6, occupied = [], fresh = [] } = {}) {
  const occ = new Set(occupied);
  const nw = new Set(fresh);
  const x = (d) => PAD + (d * (W - 2 * PAD)) / depth;
  const y = (d, i) => ((i + 0.5) * H) / 2 ** d;
  let lines = "";
  for (let d = 0; d < depth; d++) {
    for (let i = 0; i < 2 ** d; i++) {
      const x0 = x(d).toFixed(1);
      const y0 = y(d, i).toFixed(1);
      const x1 = x(d + 1).toFixed(1);
      const mx = ((x(d) + x(d + 1)) / 2).toFixed(1);
      for (const c of [2 * i, 2 * i + 1]) {
        const y1 = y(d + 1, c).toFixed(1);
        lines += `M${x0} ${y0}C${mx} ${y0} ${mx} ${y1} ${x1} ${y1}`;
      }
    }
  }
  const r = depth >= 6 ? 2.6 : 3.4;
  let leaves = "";
  const lx = x(depth).toFixed(1);
  for (let i = 0; i < 2 ** depth; i++) {
    const cls = occ.has(i) ? (nw.has(i) ? "lt-leaf is-on is-new" : "lt-leaf is-on") : "lt-leaf";
    leaves += `<circle class="${cls}" data-leaf="${i}" cx="${lx}" cy="${y(depth, i).toFixed(1)}" r="${r}"/>`;
  }
  return new Safe(
    `<svg class="lattice lattice--d${depth}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMaxYMid slice" aria-hidden="true" focusable="false">` +
      `<path class="lt-lines" d="${lines}"/>` +
      `<circle class="lt-root" cx="${x(0).toFixed(1)}" cy="${H / 2}" r="3.5"/>` +
      leaves +
      `</svg>`,
  );
}

export function mountLattice(container, { depth = null } = {}) {
  const pick = () => depth ?? (typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches ? 5 : 6);
  let d = pick();
  let last = null;
  let drawn = null; // depth and total of the SVG on screen
  const draw = (total, flash) => {
    const n = Number(total) || 0;
    if (drawn === `${d}:${n}`) return; // a poll that brings nothing new leaves the SVG alone
    drawn = `${d}:${n}`;
    const occ = windowLeaves(n, d);
    let fresh = [];
    if (flash && last !== null && n > last && !reducedMotion()) {
      for (let i = last; i < n; i++) fresh.push(i % 2 ** d);
    }
    container.innerHTML = latticeSVG({ depth: d, occupied: occ, fresh });
  };
  const onResize = () => {
    const nd = pick();
    if (nd !== d) {
      d = nd;
      draw(last, false);
    }
  };
  addEventListener("resize", onResize);
  draw(0, false);
  return {
    update(total) {
      draw(total, true);
      last = Number(total) || 0;
    },
    destroy() {
      removeEventListener("resize", onResize);
      container.innerHTML = "";
      drawn = null;
    },
  };
}

/**
 * Provenance chip `.prov` (visual.md section 6.1). Every check and every live number carries
 * one, naming what you still have to trust for that line:
 *   BTC  Bitcoin data served by mempool.space
 *   YOU  only your browser's math
 *   IDX  our indexer's claim
 *
 * API
 *   PROV                       { BTC|YOU|IDX: { label, glyph, tip } }
 *   prov(type, { tip })        -> Safe chip. `tip: false` drops the popover (e.g. inside a popover);
 *                                 a string replaces the type's sentence (REBUILD_TIP).
 *                                 The popover sentence is wired by the global [data-tip] behavior.
 *   REBUILD_TIP                the IDX sentence for a root or count rebuilt here from the indexer's
 *                                 own commitments: they agree with its root, nothing ties them to Bitcoin
 *   provTip(type) -> string    the one-sentence explanation
 *   upgrade(el, type)          IDX -> YOU (or any change): 300ms crossfade of glyph, label and
 *                                 border; instant with reduced motion. `el` is the chip element.
 *                                 A call during a crossfade retargets it (no second fade).
 */
import { esc, Safe, reducedMotion } from "./dom.js";
import { icon } from "./icons.js";

export const PROV = {
  BTC: {
    label: "BTC",
    glyph: "block",
    tip: "Bitcoin data fetched from mempool.space. Your browser checked it, but you still trust that source for the block header.",
  },
  YOU: {
    label: "YOU",
    glyph: "check",
    tip: "Computed in your browser. Nothing to trust but your own machine.",
  },
  IDX: {
    label: "IDX",
    glyph: "server",
    tip: "Reported by our indexer. Your browser hasn't checked this yet.",
  },
};

/**
 * A tree rebuilt in the browser from the commitments our indexer serves, matching the root
 * it reports, shows only that the indexer's list and root agree: a dishonest indexer can
 * serve a consistent fake list. So it stays IDX; Verify the Pool (a replay) is what checks it.
 */
export const REBUILD_TIP = "Rebuilt in your browser from our indexer's commitments, and it matches the root the indexer reports: its list and its root agree. Only Verify the Pool checks them against Bitcoin.";

const norm = (t) => {
  const k = String(t ?? "").toUpperCase();
  if (!PROV[k]) throw new Error(`unknown provenance: ${t}`);
  return k;
};

export const provTip = (type) => PROV[norm(type)].tip;

function inner(k) {
  return `${icon(PROV[k].glyph, { size: 9, inline: true })}<span class="prov-l">${PROV[k].label}</span>`;
}

export function prov(type, { tip = true } = {}) {
  const k = norm(type);
  const text = typeof tip === "string" && tip ? tip : PROV[k].tip;
  const t = tip ? ` data-tip="${esc(text)}" tabindex="0"` : "";
  return new Safe(`<span class="prov prov--${k.toLowerCase()}" data-prov="${k}" role="note" aria-label="${k}: ${esc(text)}"${t}>${inner(k)}</span>`);
}

export function upgrade(el, type) {
  if (!el) return;
  const k = norm(type);
  // dataset.provTo: the target of a crossfade under way. Repaints often call this twice
  // within its 150 ms; a second fade would blink the chip, and the older target could win.
  if ((el.dataset.provTo ?? el.dataset.prov) === k) return;
  const apply = (to) => {
    el.className = `prov prov--${to.toLowerCase()}`;
    el.dataset.prov = to;
    el.innerHTML = inner(to);
    el.setAttribute("aria-label", `${to}: ${PROV[to].tip}`);
    if (el.hasAttribute("data-tip")) el.dataset.tip = PROV[to].tip;
  };
  if (reducedMotion()) {
    delete el.dataset.provTo;
    return apply(k);
  }
  const busy = el.dataset.provTo !== undefined;
  el.dataset.provTo = k;
  if (busy) return;
  // Fade out over half the duration, swap, fade back in: reads as one crossfade.
  el.classList.add("prov--swap-out");
  setTimeout(() => {
    const to = el.dataset.provTo ?? k;
    delete el.dataset.provTo;
    apply(to);
    el.classList.add("prov--swap-in");
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove("prov--swap-in")));
  }, 150);
}

/**
 * Icon set (visual.md section 7): 20px grid, 1.5px stroke, round caps and joins, currentColor.
 * No emoji anywhere in the product; every glyph comes from here.
 *
 * API
 *   ICONS                         { name: "<svg inner markup>" } for all icons (used by canvas/PNG export too)
 *   ICON_NAMES                    sorted list of names
 *   icon(name, { size, label, cls, inline })
 *       -> Safe <svg>. By default it references the sprite (<use href="#i-name">), which the shell
 *          injects once with injectSprite(). `inline: true` embeds the paths instead (for markup
 *          that is serialized or rendered outside the page, e.g. share images).
 *          With `label` the icon is announced (role="img"); without it, it is aria-hidden.
 *   spriteMarkup() -> string      a hidden <svg> with one <symbol id="i-name"> per icon
 *   injectSprite(doc?)            inserts the sprite at the start of <body> once
 *   glyphSVG({ size, title })     the brand glyph: a rounded square holding a 3-node merkle branch
 *                                 whose root is the solid bitcoin-orange "sealed root".
 */
import { esc, Safe } from "./dom.js";

const dot = (x, y, r = 1) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;

export const ICONS = {
  seal: `<path d="M9 2.8a7.25 7.25 0 0 0 0 14.4"/><path d="M11 2.8a7.25 7.25 0 0 1 0 14.4"/><circle cx="10" cy="10" r="2.6"/>`,
  root: `<rect x="2.75" y="2.75" width="14.5" height="14.5" rx="3.5"/><path d="M7.3 13l2.1-3.6M12.7 13l-2.1-3.6"/><circle cx="6.5" cy="14" r="1.6"/><circle cx="13.5" cy="14" r="1.6"/>${dot(10, 7, 2.1)}`,
  nullifier: `<path d="M10.4 3H4.5A1.5 1.5 0 0 0 3 4.5v5.9l6.8 6.8a1.4 1.4 0 0 0 2 0l5.4-5.4a1.4 1.4 0 0 0 0-2z"/><circle cx="6.9" cy="6.9" r="1.1"/><path d="M8 15.5l7.5-7.5"/>`,
  commitment: `<rect x="2.75" y="4.75" width="14.5" height="10.5" rx="1.5"/><path d="M3.3 5.6l6.7 5.1 6.7-5.1"/>${dot(10, 12.6, 1.3)}`,
  proof: `<path d="M10 2.5l6.5 3.75v7.5L10 17.5l-6.5-3.75v-7.5z"/><path d="M7 10.2l2.1 2.1 4-4.4"/>`,
  block: `<path d="M10 2.5l6.5 3.6v7.8L10 17.5l-6.5-3.6V6.1z"/><path d="M3.5 6.1L10 9.7l6.5-3.6M10 9.7v7.8"/>`,
  lock: `<rect x="4.25" y="8.75" width="11.5" height="8.5" rx="1.75"/><path d="M6.75 8.75V6.5a3.25 3.25 0 0 1 6.5 0v2.25M10 12.25v1.75"/>`,
  unlock: `<rect x="4.25" y="8.75" width="11.5" height="8.5" rx="1.75"/><path d="M6.75 8.75V6.5a3.25 3.25 0 0 1 6.3-1.1M10 12.25v1.75"/>`,
  relayer: `<path d="M8.6 11.6l-1.9 1.9a2.6 2.6 0 0 1-3.7-3.7l1.9-1.9"/><path d="M11.4 8.4l1.9-1.9a2.6 2.6 0 0 1 3.7 3.7l-1.9 1.9"/><path d="M8 3.5v2M3.5 8h2M12 16.5v-2M16.5 12h-2"/>`,
  copy: `<rect x="7" y="7" width="10.25" height="10.25" rx="1.75"/><path d="M13 7V4.5A1.75 1.75 0 0 0 11.25 2.75h-6.5A1.75 1.75 0 0 0 3 4.5v6.75A1.75 1.75 0 0 0 4.75 13H7"/>`,
  external: `<path d="M11.5 3H17v5.5M17 3l-7.5 7.5"/><path d="M14.5 11.5v4A1.5 1.5 0 0 1 13 17H4.5A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5h4"/>`,
  qr: `<rect x="3" y="3" width="5.5" height="5.5" rx="1"/><rect x="11.5" y="3" width="5.5" height="5.5" rx="1"/><rect x="3" y="11.5" width="5.5" height="5.5" rx="1"/><path d="M11.5 11.5h2v2M17 11.5v.01M15.5 15.5H17V17M11.5 17h1.5"/>`,
  send: `<path d="M17 3L3.5 8.6l5.7 2.2 2.2 5.7z"/><path d="M9.2 10.8L17 3"/>`,
  receive: `<path d="M10 3v9M6.25 8.5L10 12.25l3.75-3.75"/><path d="M3.5 12.5v3A1.5 1.5 0 0 0 5 17h10a1.5 1.5 0 0 0 1.5-1.5v-3"/>`,
  mint: `<circle cx="10" cy="10" r="7.25"/><path d="M10 6.5v7M6.5 10h7"/>`,
  launch: `<path d="M10 2.6c2.7 1.9 4 4.7 3.6 8.4L12 13.2H8L6.4 11C6 7.3 7.3 4.5 10 2.6z"/><circle cx="10" cy="8.2" r="1.4"/><path d="M8 13.2l-2.2 2.3M12 13.2l2.2 2.3M10 13.2v4"/>`,
  search: `<circle cx="8.75" cy="8.75" r="5.5"/><path d="M12.75 12.75L17 17"/>`,
  server: `<rect x="3.25" y="3.25" width="13.5" height="5.5" rx="1.5"/><rect x="3.25" y="11.25" width="13.5" height="5.5" rx="1.5"/>${dot(6.5, 6, 0.9)}${dot(6.5, 14, 0.9)}`,
  eye: `<path d="M2.5 10s2.75-5.25 7.5-5.25S17.5 10 17.5 10 14.75 15.25 10 15.25 2.5 10 2.5 10z"/><circle cx="10" cy="10" r="2.4"/>`,
  "eye-off": `<path d="M8.1 4.95A7.6 7.6 0 0 1 10 4.75c4.75 0 7.5 5.25 7.5 5.25a13 13 0 0 1-2 2.6M12.4 13.9A7 7 0 0 1 10 15.25C5.25 15.25 2.5 10 2.5 10a13.2 13.2 0 0 1 3-3.5"/><path d="M8.3 8.3a2.4 2.4 0 0 0 3.4 3.4"/><path d="M3.5 3.5l13 13"/>`,
  shuffle: `<path d="M3 6h2.6c2.4 0 3.4 1.6 4.4 4s2 4 4.4 4H17"/><path d="M3 14h2.6c1.1 0 1.9-.35 2.5-.95M11.9 6.95c.6-.6 1.4-.95 2.5-.95H17"/><path d="M14.75 3.75L17 6l-2.25 2.25M14.75 11.75L17 14l-2.25 2.25"/>`,
  sun: `<circle cx="10" cy="10" r="3.25"/><path d="M10 2.5v1.75M10 15.75v1.75M2.5 10h1.75M15.75 10h1.75M4.7 4.7l1.25 1.25M14.05 14.05l1.25 1.25M4.7 15.3l1.25-1.25M14.05 5.95l1.25-1.25"/>`,
  moon: `<path d="M16.5 12.4A6.75 6.75 0 0 1 7.6 3.5a6.75 6.75 0 1 0 8.9 8.9z"/>`,
  monitor: `<rect x="2.75" y="3.75" width="14.5" height="9.5" rx="1.5"/><path d="M7 16.75h6M10 13.25v3.5"/>`,
  chevron: `<path d="M5.5 8l4.5 4.5L14.5 8"/>`,
  "chevron-right": `<path d="M8 5.5l4.5 4.5L8 14.5"/>`,
  check: `<path d="M4.5 10.5L8 14l7.5-8"/>`,
  cross: `<path d="M5 5l10 10M15 5L5 15"/>`,
  warn: `<path d="M10 3.2l7.3 13H2.7z"/><path d="M10 8.5v3.25"/>${dot(10, 14, 0.9)}`,
  info: `<circle cx="10" cy="10" r="7.25"/><path d="M10 9v4.75"/>${dot(10, 6.4, 0.9)}`,
  wallet: `<rect x="2.75" y="5.25" width="14.5" height="11" rx="2"/><path d="M5 5.25l7.2-2.4a1 1 0 0 1 1.3.95v1.45"/><path d="M17.25 9h-3.5a1.75 1.75 0 0 0 0 3.5h3.5"/>`,
  activity: `<path d="M2.5 10h3l2-5 4.5 10 2-5h3.5"/>`,
  settings: `<path d="M3.5 5.5h7M14.5 5.5h2M3.5 10h2M9.5 10h7M3.5 14.5h8M15.5 14.5h1"/><circle cx="12.5" cy="5.5" r="1.75"/><circle cx="7.5" cy="10" r="1.75"/><circle cx="13.5" cy="14.5" r="1.75"/>`,
  coins: `<circle cx="8" cy="8" r="4.75"/><path d="M12.4 6.3a4.75 4.75 0 1 1-6.1 6.1"/>`,
  more: `${dot(4.5, 10, 1.25)}${dot(10, 10, 1.25)}${dot(15.5, 10, 1.25)}`,
  menu: `<path d="M3.5 6h13M3.5 10h13M3.5 14h13"/>`,
  plus: `<path d="M10 4v12M4 10h12"/>`,
  "arrow-right": `<path d="M4 10h12M11.5 5.5L16 10l-4.5 4.5"/>`,
  "arrow-left": `<path d="M16 10H4M8.5 5.5L4 10l4.5 4.5"/>`,
  refresh: `<path d="M16.25 10a6.25 6.25 0 1 1-1.85-4.45"/><path d="M16.25 3.5v3.25H13"/>`,
  download: `<path d="M10 3v9.5M6.25 8.75L10 12.5l3.75-3.75M4 16.75h12"/>`,
  share: `<path d="M10 12.5V3M6.5 6.5L10 3l3.5 3.5"/><path d="M4.75 10v5.5a1.25 1.25 0 0 0 1.25 1.25h8a1.25 1.25 0 0 0 1.25-1.25V10"/>`,
  link: `<path d="M8.5 11.5a3 3 0 0 0 4.25 0l2.5-2.5a3 3 0 0 0-4.25-4.25l-.9.9"/><path d="M11.5 8.5a3 3 0 0 0-4.25 0l-2.5 2.5a3 3 0 0 0 4.25 4.25l.9-.9"/>`,
  code: `<path d="M7 6l-4 4 4 4M13 6l4 4-4 4"/>`,
  clock: `<circle cx="10" cy="10" r="7.25"/><path d="M10 6v4.25l2.75 1.75"/>`,
  home: `<path d="M3.5 9.5L10 3.75l6.5 5.75"/><path d="M5.25 8v8.25h9.5V8"/>`,
  notes: `<rect x="4.75" y="2.75" width="10.5" height="14.5" rx="1.5"/><path d="M7.5 6.5h5M7.5 9.5h5M7.5 12.5h3"/>`,
};

export const ICON_NAMES = Object.keys(ICONS).sort();

const SVG_ATTRS = `viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"`;

export function icon(name, { size = 20, label = null, cls = "", inline = false } = {}) {
  if (!ICONS[name]) throw new Error(`unknown icon: ${name}`);
  const a11y = label ? `role="img" aria-label="${esc(label)}"` : `aria-hidden="true" focusable="false"`;
  const body = inline ? ICONS[name] : `<use href="#i-${name}"></use>`;
  return new Safe(`<svg class="icon${cls ? " " + esc(cls) : ""}" width="${size}" height="${size}" ${SVG_ATTRS} ${a11y}>${body}</svg>`);
}

export function spriteMarkup() {
  const symbols = ICON_NAMES.map((n) => `<symbol id="i-${n}" viewBox="0 0 20 20">${ICONS[n]}</symbol>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" class="icon-sprite" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${symbols}</svg>`;
}

export function injectSprite(doc = document) {
  if (doc.getElementById("icon-sprite")) return;
  const wrap = doc.createElement("div");
  wrap.id = "icon-sprite";
  wrap.innerHTML = spriteMarkup();
  doc.body.prepend(wrap);
}

/** The brand glyph (visual.md section 5): stroke uses --text, the sealed root uses --btc. */
export function glyphSVG({ size = 20, title = null } = {}) {
  const a11y = title ? `role="img" aria-label="${esc(title)}"` : `aria-hidden="true" focusable="false"`;
  return new Safe(
    `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 20 20" fill="none" ${a11y}>` +
      `<rect x="0.75" y="0.75" width="18.5" height="18.5" rx="5" stroke="var(--text)" stroke-width="1.5"/>` +
      `<path d="M7.6 11.8L9 9M12.4 11.8L11 9" stroke="var(--text)" stroke-width="1.5" stroke-linecap="round"/>` +
      `<circle cx="6.5" cy="14" r="1.75" stroke="var(--text)" stroke-width="1.5" fill="none"/>` +
      `<circle cx="13.5" cy="14" r="1.75" stroke="var(--text)" stroke-width="1.5" fill="none"/>` +
      `<circle cx="10" cy="7" r="2.25" fill="var(--btc)"/>` +
      `</svg>`,
  );
}

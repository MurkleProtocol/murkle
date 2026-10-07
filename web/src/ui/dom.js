/**
 * DOM and HTML helpers shared by every component. Framework-free; importable in Node
 * (nothing touches `document` at import time).
 *
 * API
 *   esc(value) -> string
 *       HTML-escapes text for element content and attribute values.
 *   class Safe extends String
 *       Trusted markup. Every component returns a Safe, so html`` never double-escapes it.
 *       A Safe behaves like a string: `el.innerHTML = x`, `${x}` and `"" + x` all work.
 *   raw(markup) -> Safe
 *       Marks trusted markup as safe. Never pass indexer, chain or user data to it.
 *   html`...` -> Safe
 *       Tagged template. Interpolations are escaped unless they are Safe; arrays are joined;
 *       null, undefined and false render as nothing.
 *   attrs({ name: value }) -> Safe
 *       ` name="value"` pairs. false/null/undefined are skipped; true renders a bare attribute.
 *   cls(...names) -> string
 *       Joins the truthy class names.
 *   toNode(markup) -> Node
 *       Parses markup with a <template>; returns the single root element, or a fragment.
 *   setHTML(el, markup) -> boolean
 *       el.innerHTML = markup, skipped when the last setHTML on el wrote the same markup, so
 *       a poll that changes nothing leaves the DOM (hover, open details, animations) alone.
 *       Only for elements nothing else writes into. True when it wrote.
 *   on(root, type, selector, handler) -> off()
 *       Delegated listener: handler(event, matchedElement) runs for events inside `selector`.
 *   reducedMotion() -> boolean
 *   uid(prefix) -> string   unique id for aria wiring.
 */

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export class Safe extends String {}

export const raw = (markup) => new Safe(String(markup ?? ""));

function part(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Safe) return v.toString();
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Safe(out);
}

export function attrs(map) {
  let out = "";
  for (const [k, v] of Object.entries(map ?? {})) {
    if (v === false || v === null || v === undefined) continue;
    out += v === true ? ` ${k}` : ` ${k}="${esc(v)}"`;
  }
  return new Safe(out);
}

export const cls = (...names) => names.flat().filter(Boolean).join(" ");

export function toNode(markup) {
  const t = document.createElement("template");
  t.innerHTML = String(markup).trim();
  const c = t.content;
  return c.childNodes.length === 1 ? c.firstChild : c;
}

const written = new WeakMap();

export function setHTML(el, markup) {
  const s = String(markup);
  if (written.get(el) === s) return false;
  written.set(el, s);
  el.innerHTML = s;
  return true;
}

export function on(root, type, selector, handler, options) {
  const fn = (e) => {
    const el = e.target instanceof Element ? e.target.closest(selector) : null;
    if (el && root.contains(el)) handler(e, el);
  };
  root.addEventListener(type, fn, options);
  return () => root.removeEventListener(type, fn, options);
}

export function reducedMotion() {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

let seq = 0;
export const uid = (prefix = "u") => `${prefix}-${(++seq).toString(36)}`;

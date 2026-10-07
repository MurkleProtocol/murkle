/**
 * History-API router (visual.md section 9).
 *
 * View contract: a view module exports `render(root, params, query)`. It may return a cleanup
 * function (or a promise of one), which runs before the next route renders.
 *   root    the element to render into (the shell owns everything around it)
 *   params  path params, URI-decoded, e.g. { ticker: "ABC" } for /t/:ticker
 *   query   URLSearchParams of the current location
 * Fragments (#...) never reach the server; /pay reads location.hash itself.
 *
 * API
 *   route(pattern, loader, meta?)   register a route. pattern: "/", "/t/:ticker", "*".
 *                                   loader: () => Promise<module> or null (missing view).
 *                                   meta: { name, layout: "public" | "app", title }
 *   matchPath(pattern, path) -> params | null   (pure; exported for tests)
 *   resolve(path) -> { route, params } | null   first match in registration order ("*" last)
 *   start({ mount })                intercepts <a data-link>, listens to popstate, renders now.
 *                                   mount(match, url) is the shell's renderer (see app.js).
 *   navigate(path, { replace })     push (or replace) and render; same-path pushes are no-ops
 *                                   except for hash changes
 *   Back/forward (popstate) re-renders only when the pathname or search differs from the
 *   mounted view's: a fragment-only step, or a plain #link, keeps the view (and its input).
 *   currentPath() -> string
 *   setTitle(text?)                 "<text> · Murkle", or the default title
 *   onRouteChange(fn) -> unsubscribe   fn(path, match) after each render starts
 */
import { BRAND } from "./config.js";

const routes = [];
const listeners = new Set();
let mountFn = null;
let started = false;
// pathname + search the mounted view shows. Views may replaceState their own query
// (filters), so every click refreshes it before a native #fragment navigation.
let shown = null;
const here = () => location.pathname + location.search;

export function route(pattern, loader, meta = {}) {
  routes.push({ pattern, loader, meta, parts: pattern === "*" ? null : split(pattern) });
}

const split = (p) => p.replace(/\/+$/, "").split("/").filter(Boolean);

export function matchPath(pattern, path) {
  if (pattern === "*") return {};
  const pp = split(pattern);
  const xs = split(path.split(/[?#]/)[0]);
  if (pp.length !== xs.length) return null;
  const params = {};
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(":")) {
      let v;
      try {
        v = decodeURIComponent(xs[i]);
      } catch {
        return null;
      }
      if (!v) return null;
      params[pp[i].slice(1)] = v;
    } else if (pp[i] !== xs[i]) return null;
  }
  return params;
}

export function resolve(path) {
  const ordered = [...routes.filter((r) => r.pattern !== "*"), ...routes.filter((r) => r.pattern === "*")];
  for (const r of ordered) {
    const params = matchPath(r.pattern, path);
    if (params) return { route: r, params };
  }
  return null;
}

export const currentPath = () => location.pathname;

export function setTitle(text = null) {
  document.title = text ? `${text} · ${BRAND}` : `${BRAND} · Private tokens on Bitcoin`;
}

export function onRouteChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function saveScroll() {
  try {
    history.replaceState({ ...(history.state ?? {}), scrollY: scrollY }, "");
  } catch {}
}

function render(restoreY = null) {
  const url = new URL(location.href);
  shown = url.pathname + url.search;
  const match = resolve(url.pathname);
  for (const fn of [...listeners]) fn(url.pathname, match);
  const done = mountFn?.(match, url);
  Promise.resolve(done).then(() => {
    if (restoreY !== null) scrollTo(0, restoreY);
    else if (url.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
    else scrollTo(0, 0);
  });
}

export function navigate(path, { replace = false } = {}) {
  const next = new URL(path, location.href);
  if (next.origin !== location.origin) {
    location.href = next.href;
    return;
  }
  const same = next.pathname === location.pathname && next.search === location.search;
  if (same && next.hash === location.hash && !replace) return;
  if (same && next.hash !== location.hash) {
    history.pushState({}, "", next.href);
    // Fragment-only change: let the view react, and scroll to the anchor when it exists.
    dispatchEvent(new HashChangeEvent("hashchange"));
    document.getElementById(decodeURIComponent(next.hash.slice(1)))?.scrollIntoView();
    return;
  }
  saveScroll();
  if (replace) history.replaceState({}, "", next.href);
  else history.pushState({}, "", next.href);
  render();
}

function onPopState(e) {
  if (here() !== shown) return render(e.state?.scrollY ?? 0);
  // Only the fragment changed: no re-mount. The browser's hashchange lets the view react.
  try {
    if (location.hash) document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView();
  } catch {}
}

function onClick(e) {
  shown = here();
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest?.("a[data-link]");
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
  const href = a.getAttribute("href");
  if (!href || /^(https?:)?\/\//.test(href) || href.startsWith("mailto:")) return;
  e.preventDefault();
  navigate(href);
}

export function start({ mount }) {
  mountFn = mount;
  if (!started) {
    started = true;
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    document.addEventListener("click", onClick);
    addEventListener("popstate", onPopState);
    addEventListener("pagehide", saveScroll);
  }
  render(history.state?.scrollY ?? null);
}

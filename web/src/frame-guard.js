/**
 * Frame guard (audit V2-10). The server already denies framing on every HTML response
 * (X-Frame-Options: DENY and CSP frame-ancestors 'none'); this covers a host or proxy that
 * strips those headers. Inside a frame nothing mounts: no shell, no wallet, no polling, so no
 * button of ours can sit under another site's page (clickjacking). The page shows a notice
 * with a link that opens the same address in a tab of its own.
 *
 * app.js imports this module first, after its styles. Throwing here stops the module graph,
 * so app.js never runs. EMBED_ROUTES lists the paths that may render inside a frame: none
 * until the /embed/t/:TICKER widget view exists, and that view must render without in-app
 * (data-link) navigation.
 *
 * API
 *   isFramed(win) -> boolean          true when win is not the top window (or that can't be read)
 *   frameAllowed(pathname) -> boolean true for an EMBED_ROUTES path
 *   EMBED_ROUTES                      RegExp[]
 */
export const EMBED_ROUTES = [];

export function isFramed(win = globalThis.window) {
  if (!win) return false;
  try {
    return win.top !== win.self;
  } catch {
    return true; // a cross-origin parent: reading top threw, so we are framed
  }
}

export function frameAllowed(pathname) {
  return EMBED_ROUTES.some((re) => re.test(String(pathname ?? "")));
}

function notice(doc, href) {
  const root = doc.getElementById("app") ?? doc.body;
  const wrap = doc.createElement("div");
  wrap.className = "container section";
  const panel = doc.createElement("section");
  panel.className = "panel placeholder";
  panel.setAttribute("role", "alert");
  const h = doc.createElement("h1");
  h.className = "h1-app";
  h.textContent = "Open this page in its own tab.";
  const p = doc.createElement("p");
  p.textContent = "It is shown inside a frame, so the wallet and the explorer won't load here.";
  const a = doc.createElement("a");
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = "Open in a new tab";
  const line = doc.createElement("p");
  line.append(a);
  panel.append(h, p, line);
  wrap.append(panel);
  root.replaceChildren(wrap);
}

if (typeof window !== "undefined" && isFramed(window) && !frameAllowed(window.location.pathname)) {
  notice(window.document, window.location.href);
  throw new Error("Refusing to run inside a frame: open the page in its own tab.");
}

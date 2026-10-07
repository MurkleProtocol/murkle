/**
 * 404 (visual.md section 9): "Nothing at this path." plus a search that resolves locally, like
 * the global one: 64-hex values are matched against the public bulk lists, tickers against the
 * asset list, and a shielded address is never sent anywhere.
 */
import "../share/public.css";
import * as api from "../api.js";
import { html, on } from "../ui/dom.js";
import { icon, glyphSVG } from "../ui/icons.js";
import { button } from "../ui/components.js";
import { latticeSVG } from "../ui/lattice.js";
import { resolveSearch, classify, ADDRESS_MESSAGE } from "../ui/search.js";
import { navigate, setTitle } from "../router.js";
import { ADDRESS_HRP } from "../config.js";

export function render(root) {
  setTitle("Not found");
  const path = decodeSafe(location.pathname);
  root.innerHTML = html`<div class="section nf">
    <div class="nf-lattice" aria-hidden="true">${latticeSVG({ depth: 5, occupied: [] })}</div>
    <div class="container">
      <section class="panel panel--certified nf-card" aria-labelledby="nf-h">
        ${glyphSVG({ size: 40 })}
        <div class="nf-code">404 · NOT FOUND</div>
        <h1 class="h1-app" id="nf-h">Nothing at this path.</h1>
        <p class="t-2">Bitcoin never forgets, but this page never existed. Search for a transaction, a nullifier, a commitment or a ticker instead.</p>
        <p class="nf-path" title="${path}">${path.length > 120 ? `${path.slice(0, 117)}…` : path}</p>
        <form class="search nf-search" role="search" data-nf-search autocomplete="off">
          <span class="search-ic">${icon("search", { size: 16 })}</span>
          <input class="input search-input" type="search" name="q" placeholder="Search txid, nullifier, ticker" spellcheck="false" autocapitalize="off" aria-label="Search txid, nullifier, commitment or ticker">
          <div class="search-pop" hidden></div>
        </form>
        <div class="nf-links">
          ${button({ label: "Home", href: "/", kind: "secondary", icon: "home" })}
          ${button({ label: "Mints", href: "/mints", kind: "ghost" })}
          ${button({ label: "Explorer", href: "/explorer", kind: "ghost" })}
          ${button({ label: "Verify", href: "/verify", kind: "ghost" })}
        </div>
      </section>
    </div>
  </div>`;

  const form = root.querySelector("[data-nf-search]");
  const input = form.querySelector("input");
  const pop = form.querySelector(".search-pop");
  const say = (text, tone = "info") => {
    pop.hidden = false;
    pop.innerHTML = html`<div class="search-msg search-msg--${tone}">${icon(tone === "warn" ? "warn" : "info", { size: 16 })}<span>${text}</span></div>`;
  };

  const offs = [
    on(root, "input", "[data-nf-search] input", () => {
      const c = classify(input.value, { hrp: ADDRESS_HRP });
      if (c.kind === "address") say(ADDRESS_MESSAGE);
      else pop.hidden = true;
    }),
    on(root, "submit", "[data-nf-search]", async (e) => {
      e.preventDefault();
      const res = await resolveSearch(input.value, {
        hrp: ADDRESS_HRP,
        getNullifiers: () => api.nullifiers(),
        getCommitments: () => api.commitments(),
        getAssets: () => api.assets(),
      });
      if (res.path) navigate(res.path);
      else say(res.message, res.tone);
    }),
  ];
  return () => offs.forEach((off) => off());
}

function decodeSafe(p) {
  try {
    return decodeURIComponent(p);
  } catch {
    return p;
  }
}

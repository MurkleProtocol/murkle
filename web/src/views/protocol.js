/**
 * /protocol (visual.md section 9): SPEC.md, rendered at build time from the repository by the
 * in-repo Markdown renderer (share/markdown.js), so the published spec never drifts from the
 * code that runs. Above it, the envelope layouts drawn to scale; their totals come from
 * src/envelope.mjs, the same code the indexer uses.
 */
import "../share/public.css";
import spec from "../../../SPEC.md?raw";
import { html, raw, on } from "../ui/dom.js";
import { int } from "../ui/format.js";
import { button } from "../ui/components.js";
import { navigate, setTitle } from "../router.js";
import { REPO_URL } from "../config.js";
import { envelopeLen, OP } from "../../../src/envelope.mjs";
import { renderMarkdown } from "../share/markdown.js";

// [field, color key, bytes]; DEPLOY is shown for a 3-character ticker and a P2TR treasury.
const PROOF_BODY = (bind) => [
  ["header", "header", 5],
  ["anchor", "anchor", 4],
  ["public asset + amount", "public", 16],
  ...(bind ? [[bind[0], "bind", bind[1]]] : []),
  ["2 nullifiers", "nullifier", 64],
  ["2 commitments", "commitment", 64],
  ["2 encrypted notes", "cipher", 190],
  ["proof", "proof", 128],
];

export const LAYOUTS = [
  { name: "TRANSACT", note: "private transfer", op: OP.TRANSACT, fields: PROOF_BODY(null) },
  { name: "MINT", note: "bound to a coin", op: OP.MINT, fields: PROOF_BODY(["bound coin", 36]) },
  { name: "MINT_SCRIPT", note: "bound to an address", op: OP.MINT_SCRIPT, fields: PROOF_BODY(["bound address", 32]) },
  {
    name: "DEPLOY",
    note: "ticker ABC, P2TR treasury",
    op: OP.DEPLOY,
    fields: [["header", "header", 5], ["ticker", "public", 4], ["terms", "public", 21], ["treasury", "bind", 35], ["schedule", "anchor", 8]],
  },
  { name: "ATTEST", note: "public statement", op: OP.ATTEST, fields: [["header", "header", 5], ["kind", "public", 1], ["hash", "commitment", 32]] },
];

const LEGEND = [
  ["header", "header"],
  ["anchor", "anchor / schedule"],
  ["public", "public values"],
  ["bind", "binding / treasury"],
  ["nullifier", "nullifiers"],
  ["commitment", "commitments / hash"],
  ["cipher", "encrypted notes"],
  ["proof", "proof"],
];

function anatomy() {
  return html`<section class="panel pr-anat" aria-labelledby="pr-anat-h">
    <header class="panel-head" style="margin-bottom:0"><div class="panel-titles"><div class="eyebrow">ENVELOPE LAYOUTS</div><h2 class="h3" id="pr-anat-h">Every byte an operation writes to Bitcoin, to scale</h2></div></header>
    ${LAYOUTS.map((l) => {
      const sum = l.fields.reduce((s, f) => s + f[2], 0);
      // Proof-carrying and ATTEST lengths are fixed by the codec; DEPLOY varies with its ticker.
      const fixed = l.op === OP.DEPLOY ? null : envelopeLen(l.op);
      const total = fixed ?? sum;
      return html`<div class="pr-env">
        <div class="pr-env-name">${l.name}<span>${int(total)} bytes${fixed === null ? " (example)" : ""} · ${l.note}</span></div>
        <div class="pr-env-bar" role="img" aria-label="${l.name}: ${l.fields.map((f) => `${f[0]} ${f[2]} bytes`).join(", ")}">${l.fields.map(
          (f) => html`<span class="pr-seg hx--${f[1]}" style="flex:${f[2]} 1 0" title="${f[0]} · ${f[2]} bytes">${f[2] >= 28 ? html`${f[2]}` : ""}</span>`,
        )}</div>
      </div>`;
    })}
    <div class="pr-legend">${LEGEND.map(([k, label]) => html`<span class="hx--${k}"><i></i>${label}</span>`)}</div>
    <p class="caption t-3">Encrypted notes are public bytes that only the recipient's view key opens. Open any receipt to see a real envelope byte by byte.</p>
  </section>`;
}

export function render(root) {
  setTitle("Protocol");
  const { html: body, toc } = renderMarkdown(spec, { idPrefix: "s-" });
  const nav = toc.filter((t) => t.level === 2 || t.level === 3);
  root.innerHTML = html`<div class="container section">
    <header class="page-head">
      <div>
        <div class="eyebrow">PROTOCOL · SPEC.md</div>
        <h1 class="h1-app">Protocol specification</h1>
        <p class="lead">Rendered from SPEC.md in this build, so it never drifts from the code that runs. Bitcoin stores and orders the data; every replayer applies these rules and gets the same state.</p>
      </div>
      <div class="cluster">${REPO_URL ? button({ label: "Source", href: REPO_URL, kind: "secondary", icon: "code" }) : ""}${button({ label: "Verify the pool", href: "/verify#pool", kind: "ghost", icon: "proof" })}</div>
    </header>
    ${anatomy()}
    <div class="pr-layout">
      <nav class="pr-toc" aria-label="Specification sections">${nav.map((t) => html`<a class="lvl-${t.level}" href="#${t.id}" data-link>${t.text}</a>`)}</nav>
      <div>
        <label class="pr-jump"><span class="visually-hidden">Jump to a section</span><select class="input" data-jump><option value="">Jump to a section…</option>${nav.map((t) => html`<option value="${t.id}">${t.level === 3 ? "  " : ""}${t.text}</option>`)}</select></label>
        <article class="md" aria-label="Specification">${raw(body)}</article>
      </div>
    </div>
  </div>`;
  const off = on(root, "change", "[data-jump]", (e, el) => {
    if (el.value) navigate(`#${el.value}`);
  });
  return off;
}

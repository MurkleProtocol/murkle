/**
 * Verification transcript (visual.md section 6.4). The verifier engine (web/src/verify)
 * emits row events; this module renders them. There is never a fake success: a row is "ok"
 * only when the engine says so, and timings are the engine's measured ones.
 *
 * Row shape
 *   { id: string, prov: "BTC"|"YOU"|"IDX", label: string, detail?: string,
 *     status: "pending"|"running"|"ok"|"fail"|"skip", ms?: number }
 *
 * API
 *   transcriptRow(row) -> Safe <li>
 *   transcript(rows, { actions = true, source = true, title }) -> Safe <section class="transcript">
 *       actions adds [Copy transcript] (data-action="transcript-copy") and [Re-run]
 *       (data-action="transcript-rerun"); the view handles both.
 *   summary(rows) -> "7 of 10 checks ran in your browser · 2 rely on Bitcoin data from
 *       mempool.space · 1 relies on our indexer"
 *   copyText(rows, { title }) -> plain-text transcript
 *   class TranscriptView(sectionEl)
 *       .set(rows)              re-render all rows
 *       .update(id, patch)      patch one row; status changes are revealed with a minimum
 *                               60ms stagger (instant with reduced motion)
 *       .fail(id, detail)       marks the row failed and every later pending row skipped
 *       .rows                   current rows (copy)
 */
import { EXPLORER } from "../../../src/params.mjs";
import { html, toNode, reducedMotion } from "./dom.js";
import { icon } from "./icons.js";
import { prov, upgrade } from "./prov.js";
import { ms as fmtMs } from "./format.js";

const GLYPH = {
  pending: () => html`<span class="tr-g tr-g--pending" aria-label="Pending">○</span>`,
  running: () => html`<span class="tr-g" aria-label="Running"><span class="spinner spinner--12"></span></span>`,
  ok: () => html`<span class="tr-g tr-g--ok" aria-label="Passed">${icon("check", { size: 14 })}</span>`,
  fail: () => html`<span class="tr-g tr-g--fail" aria-label="Failed">${icon("cross", { size: 14 })}</span>`,
  skip: () => html`<span class="tr-g tr-g--skip" aria-label="Skipped">–</span>`,
};

export function transcriptRow(row) {
  const st = GLYPH[row.status] ? row.status : "pending";
  return html`<li class="tr-row tr--${st}" data-row="${row.id}">
    ${GLYPH[st]()}
    <span class="tr-chip">${prov(row.prov)}</span>
    <span class="tr-text"><span class="tr-label">${row.label}</span>${row.detail ? html`<span class="tr-detail mono">${row.detail}</span>` : ""}</span>
    <span class="tr-ms mono">${row.ms != null && (st === "ok" || st === "fail") ? fmtMs(row.ms) : ""}</span>
  </li>`;
}

export function summary(rows) {
  const n = rows.length;
  const c = { BTC: 0, YOU: 0, IDX: 0 };
  for (const r of rows) c[r.prov] = (c[r.prov] ?? 0) + 1;
  const rely = (k) => (k === 1 ? "relies" : "rely");
  return [
    `${c.YOU} of ${n} checks ran in your browser`,
    `${c.BTC} ${rely(c.BTC)} on Bitcoin data from mempool.space`,
    `${c.IDX} ${rely(c.IDX)} on our indexer`,
  ].join(" · ");
}

const DATA_LINE = `Data: ${EXPLORER.replace(/^https?:\/\//, "")}, independent of us.`;

export function copyText(rows, { title = "Verification transcript" } = {}) {
  const mark = { ok: "[ok]  ", fail: "[FAIL]", skip: "[skip]", pending: "[ .. ]", running: "[ .. ]" };
  const lines = rows.map((r) => {
    const t = r.ms != null && (r.status === "ok" || r.status === "fail") ? ` (${fmtMs(r.ms)})` : "";
    return `${mark[r.status] ?? "[ .. ]"} ${r.prov.padEnd(3)} ${r.label}${r.detail ? ` - ${r.detail}` : ""}${t}`;
  });
  return [title, ...lines, "", summary(rows), DATA_LINE].join("\n");
}

export function transcript(rows, { actions = true, source = true, title = null } = {}) {
  return html`<section class="transcript">
    ${title ? html`<div class="eyebrow tr-title">${title}</div>` : ""}
    <ol class="tr-rows" aria-live="polite">${rows.map(transcriptRow)}</ol>
    <footer class="tr-foot">
      <p class="tr-summary mono">${summary(rows)}</p>
      ${source ? html`<p class="tr-source caption">${DATA_LINE}</p>` : ""}
      ${actions
        ? html`<div class="cluster">
            <button type="button" class="btn btn--secondary btn--sm" data-action="transcript-copy">${icon("copy", { size: 16 })}Copy transcript</button>
            <button type="button" class="btn btn--ghost btn--sm" data-action="transcript-rerun">${icon("refresh", { size: 16 })}Re-run</button>
          </div>`
        : ""}
    </footer>
  </section>`;
}

export class TranscriptView {
  constructor(section) {
    this.el = section;
    this._rows = [];
    this.queue = Promise.resolve();
    this.last = 0;
  }

  get rows() {
    return this._rows.map((r) => ({ ...r }));
  }

  set(rows) {
    this._rows = rows.map((r) => ({ ...r }));
    const ol = this.el.querySelector(".tr-rows");
    ol.innerHTML = this._rows.map((r) => transcriptRow(r)).join("");
    this._summary();
  }

  update(id, patch) {
    const row = this._rows.find((r) => r.id === id);
    if (!row) return;
    const prevProv = row.prov;
    Object.assign(row, patch);
    const snapshot = { ...row };
    const paint = () => {
      const li = this.el.querySelector(`[data-row="${CSS.escape(id)}"]`);
      if (!li) return;
      const chip = li.querySelector(".prov");
      const next = toNode(transcriptRow(snapshot));
      // Keep the existing chip element so an IDX -> YOU change plays the crossfade.
      if (chip && snapshot.prov !== prevProv) {
        next.querySelector(".tr-chip").replaceWith(li.querySelector(".tr-chip"));
        upgrade(chip, snapshot.prov);
      }
      li.replaceWith(next);
      this._summary();
    };
    const settles = patch.status && patch.status !== "running" && patch.status !== "pending";
    if (!settles || reducedMotion()) return paint();
    // Settled rows appear with at least 60ms between them, for legibility only.
    this.queue = this.queue.then(async () => {
      const wait = Math.max(0, this.last + 60 - performance.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      paint();
      this.last = performance.now();
    });
  }

  fail(id, detail) {
    this.update(id, { status: "fail", detail });
    let after = false;
    for (const r of this._rows) {
      if (r.id === id) after = true;
      else if (after && (r.status === "pending" || r.status === "running")) this.update(r.id, { status: "skip" });
    }
  }

  _summary() {
    const s = this.el.querySelector(".tr-summary");
    if (s) s.textContent = summary(this._rows);
  }
}

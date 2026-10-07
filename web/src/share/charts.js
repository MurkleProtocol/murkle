/**
 * Small SVG charts for the public pages, drawn only from real API series (no smoothing, no
 * interpolation, no invented points). Pure functions: no DOM access, importable in Node.
 *
 * API
 *   windowCounts(pairs, tip, blocks) -> number[]
 *       pairs: [[height, n]] (any order, gaps allowed). Returns `blocks` counts, oldest first,
 *       for heights tip-blocks+1 .. tip. Missing heights are 0.
 *   mintsChart(pairs, tip, { blocks = 144, unit = "mint" }) -> Safe <figure>
 *       2px --btc bars on a hairline axis (visual.md section 9, token page). Empty: axis only.
 *   crowdSeries(series, { notes, tip, blocks = 1008 }) -> { cum: number[], transfers: number[], added, start }
 *       series: /api/stats series [[height, newNotes, transfers]]. cum[i] = notes in the pool
 *       after block start+i, walked back from the live total `notes`.
 *   crowdChart(series, { notes, tip, blocks = 1008 }) -> Safe <figure>
 *       pool size as a step line plus private-transfer ticks.
 *   blockStrip(rows) -> Safe
 *       /api/blocks rows (newest first) as a strip of squares, oldest on the left. Each square is a
 *       <button data-block="h"> with a data-tip listing its operations.
 *   blockOpsText(ops) -> string     "2 mints · 1 private transfer" / "No protocol operations"
 */
import { html, raw } from "../ui/dom.js";
import { int, heightText } from "../ui/format.js";

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export function windowCounts(pairs, tip, blocks) {
  const out = new Array(Math.max(0, blocks)).fill(0);
  if (!Number.isFinite(Number(tip))) return out;
  const lo = Number(tip) - blocks + 1;
  for (const [h, n] of pairs ?? []) {
    const i = Number(h) - lo;
    if (i >= 0 && i < blocks) out[i] += num(n);
  }
  return out;
}

export function mintsChart(pairs, tip, { blocks = 144, unit = "mint" } = {}) {
  const counts = windowCounts(pairs, tip, blocks);
  const total = counts.reduce((s, n) => s + n, 0);
  const max = Math.max(0, ...counts);
  const W = blocks * 3;
  const H = 56;
  const base = H - 0.5;
  let bars = "";
  counts.forEach((n, i) => {
    if (!n) return;
    const h = Math.max(2, (n / max) * (H - 8));
    bars += `<rect class="lp-bar" x="${i * 3}" y="${(base - h).toFixed(2)}" width="2" height="${h.toFixed(2)}"><title>${heightText(Number(tip) - blocks + 1 + i)} · ${int(n)} ${n === 1 ? unit : unit + "s"}</title></rect>`;
  });
  const label = Number.isFinite(Number(tip))
    ? `${int(total)} ${total === 1 ? unit : unit + "s"} in the last ${int(blocks)} blocks${max ? `, at most ${int(max)} in one block` : ""}`
    : "No data yet";
  return html`<figure class="lp-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}">
      <line class="lp-axis" x1="0" y1="${base}" x2="${W}" y2="${base}"/>${raw(bars)}
    </svg>
    <figcaption class="lp-chart-foot mono"><span>${Number.isFinite(Number(tip)) ? heightText(Number(tip) - blocks + 1) : "—"}</span><span>${label}</span><span>${Number.isFinite(Number(tip)) ? heightText(tip) : "—"}</span></figcaption>
  </figure>`;
}

export function crowdSeries(series, { notes, tip, blocks = 1008 } = {}) {
  const newNotes = windowCounts((series ?? []).map(([h, n]) => [h, n]), tip, blocks);
  const transfers = windowCounts((series ?? []).map(([h, , t]) => [h, t]), tip, blocks);
  const added = newNotes.reduce((s, n) => s + n, 0);
  let running = Math.max(0, num(notes) - added);
  const cum = newNotes.map((n) => (running += n));
  return { cum, transfers, added, start: Number(tip) - blocks + 1 };
}

export function crowdChart(series, { notes, tip, blocks = 1008 } = {}) {
  if (!Number.isFinite(Number(tip)) || notes === null || notes === undefined) {
    return html`<figure class="lp-chart lp-chart--crowd"><span class="skel" style="width:100%;height:96px"></span></figure>`;
  }
  const { cum, transfers, added: growth, start } = crowdSeries(series, { notes, tip, blocks });
  const W = 1000;
  const H = 120;
  const top = 10;
  const bottom = H - 22;
  const max = Math.max(1, ...cum);
  const x = (i) => (i / Math.max(1, blocks - 1)) * W;
  const y = (v) => bottom - (v / max) * (bottom - top);
  let d = "";
  cum.forEach((v, i) => {
    const px = x(i).toFixed(1);
    const py = y(v).toFixed(1);
    d += i === 0 ? `M${px} ${py}` : `H${px}V${py}`;
  });
  const area = `${d}V${bottom}H0Z`;
  const tmax = Math.max(1, ...transfers);
  let ticks = "";
  transfers.forEach((t, i) => {
    if (!t) return;
    const h = Math.max(2, (t / tmax) * 14);
    ticks += `<rect class="lp-tick" x="${x(i).toFixed(1)}" y="${(H - h).toFixed(1)}" width="2" height="${h.toFixed(1)}"/>`;
  });
  const totalT = transfers.reduce((s, n) => s + n, 0);
  const label = `Pool size over the last ${int(blocks)} blocks: ${int(growth)} new notes, ${int(totalT)} private transfers.`;
  return html`<figure class="lp-chart lp-chart--crowd">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${label}">
      <path class="lp-area" d="${area}"/>
      <path class="lp-line" d="${d}"/>
      <line class="lp-axis" x1="0" y1="${bottom + 0.5}" x2="${W}" y2="${bottom + 0.5}"/>
      ${raw(ticks)}
    </svg>
    <figcaption class="lp-chart-foot mono"><span>${heightText(start)}</span><span>${int(growth)} new notes · ${int(totalT)} private transfers</span><span>${heightText(tip)}</span></figcaption>
  </figure>`;
}

const OPS = [
  ["deploy", "launch", "launches"],
  ["mint", "mint", "mints"],
  ["transfer", "private transfer", "private transfers"],
  ["attest", "attestation", "attestations"],
  ["rejected", "rejected envelope", "rejected envelopes"],
];

export function blockOpsText(ops) {
  const parts = OPS.filter(([k]) => num(ops?.[k]) > 0).map(([k, one, many]) => `${int(num(ops[k]))} ${num(ops[k]) === 1 ? one : many}`);
  return parts.length ? parts.join(" · ") : "No protocol operations";
}

export const opsCount = (ops) => OPS.reduce((s, [k]) => s + num(ops?.[k]), 0);

export function blockStrip(rows, { selected = null } = {}) {
  const list = [...(rows ?? [])].sort((a, b) => a.height - b.height);
  return html`<div class="ex-blocks" role="list">${list.map((b) => {
    const n = opsCount(b.ops);
    const tip = `${heightText(b.height)} · ${blockOpsText(b.ops)}`;
    const cls = ["ex-block", n ? "has-ops" : "", num(b.ops?.rejected) ? "has-rej" : "", selected === b.height ? "is-on" : ""].filter(Boolean).join(" ");
    return html`<span role="listitem"><button type="button" class="${cls}" data-block="${b.height}" data-tip="${tip}" aria-label="${tip}" aria-pressed="${selected === b.height ? "true" : "false"}">${n ? html`<span class="mono">${n > 99 ? "99+" : n}</span>` : ""}</button></span>`;
  })}</div>`;
}

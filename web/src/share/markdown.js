/**
 * Minimal Markdown renderer for /protocol (visual.md section 9): SPEC.md is rendered from the
 * repository at build time, so the published spec never drifts from the code that runs.
 *
 * Supported: ATX headings, paragraphs, fenced code, block quotes, horizontal rules, pipe tables
 * (with alignment), nested ordered and unordered lists (multi-paragraph items, lazy continuation
 * lines), inline code, **bold**, *italic* / _italic_ and [links](url).
 *
 * Every piece of text is HTML-escaped before any markup is added, so the source can never inject
 * markup. Links keep only http(s), root-relative and #fragment targets; anything else renders as
 * plain text. External links open in a new tab without a referrer.
 *
 * API
 *   renderMarkdown(src, { idPrefix = "" }) -> { html: string, toc: [{ level, text, id }] }
 *   inline(text) -> string           inline formatting only (escaped)
 *   slugify(text) -> string
 */
import { esc } from "../ui/dom.js";

const LIST = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = (line) => line.match(/^\s*/)[0].replace(/\t/g, "    ").length;
const blank = (line) => !line || !line.trim();

export function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "section";
}

const SAFE_URL = /^(https?:\/\/[^\s"<>]+|\/[^\s"<>]*|#[^\s"<>]*)$/i;

/** Bold and italic on already-escaped text. */
function emphasis(s) {
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__(?=\S)([\s\S]*?\S)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?!\w)/g, "$1<em>$2</em>");
  // Underscore emphasis only at word boundaries, so snake_case identifiers stay intact.
  s = s.replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, "$1<em>$2</em>");
  return s;
}

/** Formats one text run (no code spans inside). Links are cut out first so emphasis never touches a URL. */
function format(text) {
  const links = [];
  // [label](url). A label with nested brackets ("[[alloc] init]") is not a link and stays text.
  const cut = String(text).replace(/\[([^[\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {
    links.push({ label, url, safe: SAFE_URL.test(url) });
    return `\u0000${links.length - 1}\u0000`;
  });
  return emphasis(esc(cut)).replace(/\u0000(\d+)\u0000/g, (_, k) => {
    const { label, url, safe } = links[Number(k)];
    const text = emphasis(esc(label));
    if (!safe) return text;
    const ext = /^https?:/i.test(url);
    // In-app paths and #fragments go through the router (no reload, no re-render for anchors).
    return `<a href="${esc(url)}"${ext ? ' target="_blank" rel="noopener noreferrer"' : " data-link"}>${text}</a>`;
  });
}

/** Inline formatting: code spans first (their content is never formatted), then the rest. */
export function inline(text) {
  const src = String(text ?? "");
  let out = "";
  let i = 0;
  while (i < src.length) {
    const tick = src.indexOf("`", i);
    if (tick < 0) {
      out += format(src.slice(i));
      break;
    }
    const run = src.slice(tick).match(/^`+/)[0];
    const close = src.indexOf(run, tick + run.length);
    if (close < 0) {
      out += format(src.slice(i));
      break;
    }
    out += format(src.slice(i, tick));
    out += `<code>${esc(src.slice(tick + run.length, close).replace(/^ (.*) $/, "$1"))}</code>`;
    i = close + run.length;
  }
  return out;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  // Split on pipes outside code spans.
  const cells = [];
  let cur = "";
  let inCode = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "`") inCode = !inCode;
    if (c === "|" && !inCode && s[k - 1] !== "\\") {
      cells.push(cur);
      cur = "";
    } else cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim().replace(/\\\|/g, "|"));
}

const isTableStart = (lines, i) => i + 1 < lines.length && lines[i].includes("|") && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-");

function startsBlock(lines, i) {
  const l = lines[i];
  return FENCE.test(l) || HEADING.test(l) || HR.test(l) || /^\s*>/.test(l) || isTableStart(lines, i) || LIST.test(l);
}

class Ctx {
  constructor(idPrefix) {
    this.idPrefix = idPrefix;
    this.ids = new Set();
    this.toc = [];
  }
  id(text) {
    const base = this.idPrefix + slugify(text);
    let id = base;
    for (let n = 2; this.ids.has(id); n++) id = `${base}-${n}`;
    this.ids.add(id);
    return id;
  }
}

/** Index just past the list block that starts at `start`. */
function listEnd(lines, start) {
  const base = indentOf(lines[start]);
  let i = start + 1;
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) {
      let j = i + 1;
      while (j < lines.length && blank(lines[j])) j++;
      if (j >= lines.length) return i;
      const next = lines[j];
      const m = next.match(LIST);
      if (indentOf(next) > base || (m && indentOf(next) >= base)) {
        i = j;
        continue;
      }
      return i;
    }
    const m = l.match(LIST);
    if (m && indentOf(l) < base) return i;
    if (indentOf(l) > base || m) {
      i++;
      continue;
    }
    // Lazy continuation: an unindented line right after list text, unless it starts a block.
    if (!blank(lines[i - 1]) && !startsBlock(lines, i)) {
      i++;
      continue;
    }
    return i;
  }
  return i;
}

function renderList(lines, ctx) {
  const first = lines[0].match(LIST);
  const base = indentOf(lines[0]);
  const ordered = /\d/.test(first[2]);
  const items = [];
  let cur = null;
  for (const l of lines) {
    const m = l.match(LIST);
    if (m && indentOf(l) <= base + 1 && (/\d/.test(m[2]) === ordered)) {
      cur = { text: m[3], offset: indentOf(l) + m[2].length + 1, rest: [] };
      items.push(cur);
    } else if (cur) {
      cur.rest.push(l);
    }
  }
  const start = ordered ? parseInt(first[2], 10) : 1;
  const body = items
    .map((it) => {
      // The item's first paragraph: its marker line plus continuation lines up to a blank
      // line or a nested block.
      const para = [it.text];
      let k = 0;
      while (k < it.rest.length && !blank(it.rest[k]) && !LIST.test(it.rest[k]) && !FENCE.test(it.rest[k]) && !isTableStart(it.rest, k)) {
        para.push(it.rest[k].trim());
        k++;
      }
      const restLines = it.rest.slice(k);
      const nonBlank = restLines.filter((l) => !blank(l));
      const dedent = nonBlank.length ? Math.min(it.offset, ...nonBlank.map(indentOf)) : 0;
      const nested = restLines.map((l) => (blank(l) ? "" : l.replace(/\t/g, "    ").slice(dedent)));
      const inner = nested.some((l) => !blank(l)) ? blocks(nested, ctx) : "";
      return `<li>${inline(para.join(" "))}${inner}</li>`;
    })
    .join("");
  return ordered ? `<ol class="md-ol"${start !== 1 ? ` start="${start}"` : ""}>${body}</ol>` : `<ul class="md-ul">${body}</ul>`;
}

function renderTable(lines, i) {
  const head = splitRow(lines[i]);
  const align = splitRow(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : null));
  const rows = [];
  let j = i + 2;
  while (j < lines.length && !blank(lines[j]) && lines[j].includes("|")) rows.push(splitRow(lines[j++]));
  const cell = (tag, text, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(text)}</${tag}>`;
  const html =
    `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map((h, k) => cell("th", h, k)).join("")}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${head.map((_, k) => cell("td", r[k] ?? "", k)).join("")}</tr>`).join("")}</tbody></table></div>`;
  return { html, next: j };
}

function blocks(lines, ctx) {
  let out = "";
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }
    let m;
    if ((m = line.match(FENCE))) {
      const fence = m[1];
      const lang = m[2];
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) code.push(lines[i++]);
      i++;
      out += `<pre class="md-pre"${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(code.join("\n"))}</code></pre>`;
      continue;
    }
    if ((m = line.match(HEADING))) {
      const level = m[1].length;
      const text = m[2];
      const id = ctx.id(text);
      ctx.toc.push({ level, text: text.replace(/`/g, ""), id });
      out += `<h${level} id="${esc(id)}" class="md-h md-h${level}">${inline(text)}</h${level}>`;
      i++;
      continue;
    }
    if (HR.test(line)) {
      out += `<hr class="md-hr">`;
      i++;
      continue;
    }
    if (isTableStart(lines, i)) {
      const t = renderTable(lines, i);
      out += t.html;
      i = t.next;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      out += `<blockquote class="md-quote">${blocks(quote, ctx)}</blockquote>`;
      continue;
    }
    if (LIST.test(line)) {
      const end = listEnd(lines, i);
      out += renderList(lines.slice(i, end), ctx);
      i = end;
      continue;
    }
    const para = [];
    while (i < lines.length && !blank(lines[i]) && (para.length === 0 || !startsBlock(lines, i))) para.push(lines[i++].trim());
    out += `<p>${inline(para.join(" "))}</p>`;
  }
  return out;
}

export function renderMarkdown(src, { idPrefix = "" } = {}) {
  const ctx = new Ctx(idPrefix);
  // NUL is the link placeholder marker in format(); it never belongs in a document.
  const lines = String(src ?? "").replace(/\u0000/g, "").replace(/\r\n?/g, "\n").split("\n");
  const html = blocks(lines, ctx);
  return { html, toc: ctx.toc };
}

/**
 * Operations feed helpers for /explorer, /t/:ticker and the landing page (visual.md section 9).
 * The log is read in bulk pages (docs/API.md: there is no per-transaction filter on the
 * indexer, by design) and filtered here.
 *
 * Public data shows only what Bitcoin shows: a private transfer is three redaction bars, a mint
 * is "+1,000 ABC -> [hidden recipient]", a launch is its public terms. No addresses, ever.
 *
 * API
 *   logTail(api, { count = 60, before = null }) -> Promise<{ items, from, total }>
 *       items oldest first; `before` is the `from` of the previous call ("Load older").
 *   FEED_FILTERS                                 [{ value, label }]
 *   matchesFilter(entry, filter) -> boolean      all | launches | mints | transfers | rejected
 *   opDisplay(entry) -> "DEPLOY" | "MINT" | "MINE" | "TRANSFER" | "ATTEST" | "UNKNOWN"
 *       MINE and MINE_SCRIPT claims show as MINE (token, reward, reference block, difficulty;
 *       never a recipient); a DEPLOY_POW is a launch (DEPLOY) with mined terms.
 *   publicData(entry, assetsById) -> Safe
 *   entrySeal(entry) -> seal input for sealPill   accepted -> IDX outline, rejected -> REJ
 *   assetIndex(list) -> Map(id -> asset)
 *   EMPTY_TEXT                                   per-filter empty-state sentences
 */
import { html } from "../ui/dom.js";
import { units, short, int, heightText, DASH } from "../ui/format.js";
import { redact } from "../ui/redact.js";
import { tag } from "../ui/components.js";

export async function logTail(api, { count = 60, before = null } = {}) {
  let total = null;
  if (before === null) {
    const head = await api.log({ from: 0, limit: 1 });
    total = Number.isFinite(Number(head?.total)) ? Number(head.total) : null;
    if (total === null) {
      // An indexer without `total`: walk the pages to the end once.
      const all = [];
      let from = 0;
      for (let guard = 0; guard < 10_000; guard++) {
        const page = await api.log({ from, limit: 500 });
        all.push(...(page.items ?? []));
        if (page.next === null || page.next === undefined || !(page.items ?? []).length) break;
        from = page.next;
      }
      const start = Math.max(0, all.length - count);
      return { items: all.slice(start), from: start, total: all.length };
    }
  }
  const end = before === null ? total : Math.max(0, Number(before));
  const from = Math.max(0, end - count);
  if (end <= from) return { items: [], from, total };
  const page = await api.log({ from, limit: end - from });
  return { items: page.items ?? [], from, total: total ?? (Number.isFinite(Number(page.total)) ? Number(page.total) : null) };
}

export const FEED_FILTERS = [
  { value: "all", label: "All" },
  { value: "launches", label: "Launches" },
  { value: "mints", label: "Mints" },
  { value: "transfers", label: "Transfers" },
  { value: "rejected", label: "Rejected" },
];

export const EMPTY_TEXT = {
  all: "No envelopes on this pool yet. The first launch will appear here.",
  launches: "No launches in this range. Load older entries, or launch the first token.",
  mints: "No mints in this range. Load older entries to look further back.",
  transfers: "No private transfers in this range. Load older entries to look further back.",
  rejected: "Nothing rejected. Every envelope followed the rules.",
};

export function opDisplay(e) {
  const n = e?.opName;
  if (n === "MINT_SCRIPT") return "MINT";
  if (n === "TRANSACT") return "TRANSFER";
  if (n === "MINE" || n === "MINE_SCRIPT") return "MINE";
  if (n === "DEPLOY_POW") return "DEPLOY";
  return ["DEPLOY", "MINT", "TRANSFER", "ATTEST"].includes(n) ? n : "UNKNOWN";
}

export function matchesFilter(e, filter = "all") {
  switch (filter) {
    case "launches":
      return opDisplay(e) === "DEPLOY";
    case "mints":
      return opDisplay(e) === "MINT";
    case "transfers":
      return opDisplay(e) === "TRANSFER";
    case "rejected":
      return e?.ok === false;
    default:
      return true;
  }
}

export const assetIndex = (list) => new Map((list ?? []).map((a) => [String(a.id), a]));

export function publicData(e, assets = new Map()) {
  const op = opDisplay(e);
  const reason = e.ok === false ? html`<span class="ex-reason">${e.reason ?? "rejected"}</span>` : "";
  if (op === "TRANSFER") {
    return html`<span class="ex-pub">${redact("token")}${redact("amount")}${redact("recipient")}</span>${reason}`;
  }
  if (op === "MINT") {
    const a = e.asset !== undefined ? assets.get(String(e.asset)) : null;
    const ticker = e.ticker ?? a?.ticker ?? null;
    const amount = e.amount !== undefined && e.amount !== null ? units(e.amount, a?.divisibility ?? 0) : DASH;
    return html`<span class="ex-pub"><span class="mono">+${amount}</span>${ticker ? html` <a class="ticker" href="/t/${encodeURIComponent(ticker)}" data-link>${ticker}</a>` : html` <span class="t-3">unknown token</span>`}<span class="t-3" aria-hidden="true">→</span>${redact("recipient")}</span>${reason}`;
  }
  if (op === "MINE") {
    const a = e.asset !== undefined ? assets.get(String(e.asset)) : null;
    const ticker = e.ticker ?? a?.ticker ?? null;
    const amount = e.amount !== undefined && e.amount !== null ? units(e.amount, a?.divisibility ?? 0) : DASH;
    return html`<span class="ex-pub"><span class="mono">+${amount}</span>${ticker ? html` <a class="ticker" href="/t/${encodeURIComponent(ticker)}" data-link>${ticker}</a>` : html` <span class="t-3">unknown token</span>`}<span class="t-3" aria-hidden="true">→</span>${redact("recipient")}${e.ref != null ? html`<span class="mono t-2">ref ${heightText(e.ref)}${e.difficulty != null ? ` · D ${int(e.difficulty)}` : ""}</span>` : ""}</span>${reason}`;
  }
  if (op === "DEPLOY" && e.opName === "DEPLOY_POW") {
    const a = e.asset !== undefined ? assets.get(String(e.asset)) : null;
    if (a && e.ok) {
      return html`<span class="ex-pub"><a class="ticker" href="/t/${encodeURIComponent(a.ticker)}" data-link>${a.ticker}</a><span class="mono t-2">mined · ${units(a.baseReward ?? a.reward, a.divisibility ?? 0)} per claim · max ${units(a.maxSupply, a.divisibility ?? 0)}</span></span>`;
    }
    return html`<span class="ex-pub"><span class="ticker">${e.ticker ?? a?.ticker ?? DASH}</span><span class="t-3">mined launch terms</span></span>${reason}`;
  }
  if (op === "DEPLOY") {
    const a = e.asset !== undefined ? assets.get(String(e.asset)) : null;
    if (a && e.ok) {
      return html`<span class="ex-pub"><a class="ticker" href="/t/${encodeURIComponent(a.ticker)}" data-link>${a.ticker}</a><span class="mono t-2">${units(a.mintAmount, a.divisibility)} × ${units(a.mintCap, 0)} · ${a.priceSats === "0" ? "free" : `${units(a.priceSats, 0)} sats`}</span></span>`;
    }
    return html`<span class="ex-pub"><span class="ticker">${e.ticker ?? DASH}</span><span class="t-3">launch terms</span></span>${reason}`;
  }
  if (op === "ATTEST") {
    const kind = { 1: "genesis", 2: "checkpoint", 3: "release" }[e.kind] ?? "attestation";
    return html`<span class="ex-pub">${tag(kind, "neutral")}<span class="mono t-2">${e.hash ? short(e.hash, 8, 4) : DASH}</span></span>${reason}`;
  }
  return html`<span class="ex-pub t-3">unreadable envelope</span>${reason}`;
}

export function entrySeal(e) {
  return e.ok ? { state: "accepted", height: e.height } : { state: "rejected", height: e.height, reason: e.reason ?? null };
}

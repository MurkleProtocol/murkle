/**
 * Launchpad helpers shared by the landing board, /mints and /t/:ticker (visual.md section 9).
 * Tokens only, never people: nothing here takes or shows an address that
 * minted, and there is no holder count anywhere, by design.
 *
 * Assets are /api/assets rows: { id, ticker, divisibility, mintAmount, mintCap, minted, supply,
 * maxSupply, priceSats, treasury, treasuryAddress, startHeight, endHeight, status
 * ("live" | "upcoming" | "sold-out" | "ended"), deployTxid, deployHeight, firstMintHeight,
 * soldOutHeight, treasurySats, rejectedMints, burnedSats, mints144 }. `height` is the indexer
 * height; the next block is height + 1.
 *
 * API
 *   PILL_KIND                               server status -> statusPill kind
 *   blocksUntilOpen(a, height) -> number | null    blocks before the first mintable block
 *   blocksLeft(a, height) -> number | null         mintable blocks left (null: no end block)
 *   pillFor(a, height) -> Safe                     status pill ("OPENS IN 37 BLOCKS" when known)
 *   scheduleText(a, height) -> string              one plain sentence about the mint window
 *   FILTERS, SORTS                                 [{ value, label }]
 *   filterAssets(list, { filter, query }) -> list
 *   sortAssets(list, sort, height) -> list (new array)
 *   boardGroups(list, height) -> { live, upcoming, soldout }   ranked for the landing board
 *   priceText(a) -> string, perMintText(a) -> string, maxSupplyText(a) -> string
 *   mintLabel(a) -> "Mint · 1,000 sats + fee"
 *   launchCard(a, { height, walletReady }) -> Safe <article>
 *   supplyCheck(a) -> { minted, perMint, expected, supply, equal } (bigints)
 *   recountMints(entries, assetId) -> { accepted, rejected, units }   from the bulk public log
 *   termsDiff(decoded, a) -> string[]              fields where the DEPLOY bytes and the indexer differ
 */
import { html } from "../ui/dom.js";
import { int, units, sats, heightText, eta, short, pct } from "../ui/format.js";
import { button, progress, statusPill } from "../ui/components.js";
import { sigil } from "../ui/sigil.js";

export const PILL_KIND = { live: "open", upcoming: "upcoming", "sold-out": "soldout", ended: "ended" };

const known = (h) => h !== null && h !== undefined && Number.isFinite(Number(h));
const big = (v) => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};

export function blocksUntilOpen(a, height) {
  if (!known(height) || !a?.startHeight) return null;
  return Math.max(0, Number(a.startHeight) - (Number(height) + 1));
}

export function blocksLeft(a, height) {
  if (!known(height) || !a?.endHeight) return null;
  return Math.max(0, Number(a.endHeight) - Number(height));
}

export function pillFor(a, height = null) {
  const kind = PILL_KIND[a?.status] ?? "ended";
  if (kind === "upcoming") {
    const n = blocksUntilOpen(a, height);
    if (n === 0) return statusPill("upcoming", "OPENS NEXT BLOCK");
    if (n !== null) return statusPill("upcoming", `OPENS IN ${int(n)} ${n === 1 ? "BLOCK" : "BLOCKS"}`);
  }
  return statusPill(kind);
}

export function scheduleText(a, height = null) {
  const plural = (n, w) => `${int(n)} ${n === 1 ? w : w + "s"}`;
  switch (a?.status) {
    case "upcoming": {
      const n = blocksUntilOpen(a, height);
      if (n === null) return `Opens at block ${heightText(a.startHeight)}.`;
      if (n === 0) return `Opens with the next block, ${heightText(a.startHeight)}.`;
      return `Opens at ${heightText(a.startHeight)}, in ${plural(n, "block")} (${eta(n)}).`;
    }
    case "live": {
      const left = blocksLeft(a, height);
      const remaining = Math.max(0, Number(a.mintCap) - Number(a.minted));
      const cap = `${plural(remaining, "mint")} left before the cap`;
      if (left === null) return `Open now, no end block: ${cap}.`;
      return `Open now, closes after ${heightText(a.endHeight)}: ${plural(left, "block")} left (${eta(left)}), ${cap}.`;
    }
    case "sold-out": {
      if (!known(a.soldOutHeight)) return "Minted out: every mint under the cap is taken.";
      const from = known(a.firstMintHeight) ? Number(a.firstMintHeight) : Number(a.deployHeight);
      const span = Number(a.soldOutHeight) - from;
      return `Minted out at ${heightText(a.soldOutHeight)}${Number.isFinite(span) ? `, ${plural(Math.max(0, span), "block")} after the first mint` : ""}.`;
    }
    case "ended":
      return `Ended after ${heightText(a.endHeight)} with ${int(a.minted)} of ${int(a.mintCap)} mints.`;
    default:
      return "";
  }
}

export const FILTERS = [
  { value: "open", label: "Open" },
  { value: "upcoming", label: "Upcoming" },
  { value: "soldout", label: "Minted out" },
  { value: "all", label: "All" },
];

export const SORTS = [
  { value: "trending", label: "Trending" },
  { value: "newest", label: "Newest" },
  { value: "closing", label: "Closing soon" },
  { value: "cheapest", label: "Cheapest" },
];

const FILTER_STATUS = { open: ["live"], upcoming: ["upcoming"], soldout: ["sold-out"], ended: ["ended"] };

export function filterAssets(list, { filter = "all", query = "" } = {}) {
  const q = String(query ?? "").trim().replace(/^\$/, "").toUpperCase();
  const allowed = FILTER_STATUS[filter] ?? null;
  return (list ?? []).filter((a) => (!allowed || allowed.includes(a.status)) && (!q || String(a.ticker).toUpperCase().includes(q)));
}

const byBig = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const remainingRatio = (a) => (Number(a.mintCap) ? (Number(a.mintCap) - Number(a.minted)) / Number(a.mintCap) : 1);

export function sortAssets(list, sort = "trending", height = null) {
  const out = [...(list ?? [])];
  const newest = (x, y) => Number(y.deployHeight ?? 0) - Number(x.deployHeight ?? 0) || byBig(big(y.id), big(x.id));
  switch (sort) {
    case "newest":
      return out.sort(newest);
    case "cheapest":
      return out.sort((x, y) => byBig(big(x.priceSats), big(y.priceSats)) || String(x.ticker).localeCompare(String(y.ticker)));
    case "closing": {
      // Open tokens first, nearest end block first, then the fewest mints left; the rest by status.
      const rank = (a) => (a.status === "live" ? 0 : a.status === "upcoming" ? 1 : 2);
      const ends = (a) => blocksLeft(a, height) ?? (a.endHeight ? Number(a.endHeight) : Infinity);
      return out.sort((x, y) => rank(x) - rank(y) || ends(x) - ends(y) || remainingRatio(x) - remainingRatio(y) || newest(x, y));
    }
    default:
      return out.sort((x, y) => Number(y.mints144 ?? 0) - Number(x.mints144 ?? 0) || Number(y.minted ?? 0) - Number(x.minted ?? 0) || newest(x, y));
  }
}

/** Landing board: trending open mints, soonest upcoming, fastest sell-outs. */
export function boardGroups(list, height = null) {
  const all = list ?? [];
  const live = sortAssets(all.filter((a) => a.status === "live"), "trending", height);
  const upcoming = all.filter((a) => a.status === "upcoming").sort((x, y) => Number(x.startHeight) - Number(y.startHeight));
  const speed = (a) => (known(a.soldOutHeight) ? Number(a.soldOutHeight) - Number(known(a.firstMintHeight) ? a.firstMintHeight : a.deployHeight) : Infinity);
  const soldout = all.filter((a) => a.status === "sold-out").sort((x, y) => speed(x) - speed(y) || Number(y.soldOutHeight ?? 0) - Number(x.soldOutHeight ?? 0));
  return { live, upcoming, soldout };
}

export const priceText = (a) => (big(a?.priceSats) === 0n ? "Free mint" : sats(a.priceSats));
export const perMintText = (a) => `${units(a.mintAmount, a.divisibility)} ${a.ticker}`;
export const maxSupplyText = (a) => `${units(a.maxSupply ?? big(a.mintAmount) * big(a.mintCap), a.divisibility)} ${a.ticker}`;
export const mintLabel = (a) => (big(a?.priceSats) > 0n ? `Mint · ${sats(a.priceSats)} + fee` : "Mint · fee only");

/** The card footer: a mint button while open, otherwise one plain reason line. */
function cardFoot(a, { height, walletReady }) {
  if (a.status === "live") {
    return button({ label: mintLabel(a), href: `/app/mint?t=${encodeURIComponent(a.ticker)}`, kind: walletReady ? "btc" : "neutral", icon: "mint", block: true });
  }
  return html`<p class="lp-card-reason caption">${scheduleText(a, height)}</p>`;
}

export function launchCard(a, { height = null, walletReady = false } = {}) {
  const sold = a.status === "sold-out";
  return html`<article class="panel lp-card" data-ticker="${a.ticker}">
    <div class="lp-card-top">
      ${sigil(a.id, { size: 40 })}
      <a class="ticker ticker--card lp-card-name" href="/t/${encodeURIComponent(a.ticker)}" data-link>${a.ticker}</a>
      ${pillFor(a, height)}
    </div>
    <div class="lp-card-meta mono">Launched ${heightText(a.deployHeight)} · ${short(a.deployTxid)}</div>
    ${progress({ value: a.minted, max: a.mintCap, soldOut: sold })}
    <dl class="lp-card-dl">
      <div><dt>Per mint</dt><dd class="mono">${units(a.mintAmount, a.divisibility)}</dd></div>
      <div><dt>Price</dt><dd class="mono t-btc">${priceText(a)}</dd></div>
      <div><dt>Supply</dt><dd class="mono">${units(a.maxSupply, a.divisibility)}</dd></div>
    </dl>
    <div class="lp-card-foot">${cardFoot(a, { height, walletReady })}</div>
  </article>`;
}

export function supplyCheck(a) {
  const minted = big(a?.minted);
  const perMint = big(a?.mintAmount);
  const expected = minted * perMint;
  const supply = big(a?.supply);
  return { minted, perMint, expected, supply, equal: expected === supply };
}

export function recountMints(entries, assetId) {
  const id = String(assetId);
  let accepted = 0;
  let rejected = 0;
  let unitsSum = 0n;
  for (const e of entries ?? []) {
    if ((e.opName !== "MINT" && e.opName !== "MINT_SCRIPT") || String(e.asset) !== id) continue;
    if (e.ok) {
      accepted += 1;
      unitsSum += big(e.amount);
    } else rejected += 1;
  }
  return { accepted, rejected, units: unitsSum };
}

const hexOf = (b) => (b instanceof Uint8Array ? Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") : String(b ?? "").toLowerCase());

export function termsDiff(d, a) {
  if (!d || !a) return ["terms"];
  const out = [];
  if (d.ticker !== a.ticker) out.push("ticker");
  if (Number(d.divisibility) !== Number(a.divisibility)) out.push("decimals");
  if (big(d.mintAmount) !== big(a.mintAmount)) out.push("per mint");
  if (Number(d.mintCap) !== Number(a.mintCap)) out.push("mint cap");
  if (big(d.priceSats) !== big(a.priceSats)) out.push("price");
  if (hexOf(d.treasury) !== hexOf(a.treasury)) out.push("treasury");
  if (Number(d.startHeight) !== Number(a.startHeight)) out.push("start block");
  if (Number(d.endHeight) !== Number(a.endHeight)) out.push("end block");
  return out;
}

export const progressText = (a) => `${int(a.minted)} / ${int(a.mintCap)} mints · ${pct(a.minted, a.mintCap)}`;

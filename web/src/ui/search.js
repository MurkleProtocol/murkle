/**
 * Global search, resolved locally (visual.md section 9). Nothing typed here is sent anywhere
 * as a lookup key: 64-hex values are matched against bulk lists every wallet downloads anyway
 * (nullifiers, commitments), tickers against the public asset list, and shielded addresses
 * are never sent at all.
 *
 * API
 *   classify(query, { hrp }) -> { kind, value }
 *       kind: "empty" | "hex64" | "address" | "ticker" | "height" | "unknown"
 *   resolveSearch(query, { hrp, getNullifiers, getCommitments, getAssets })
 *       -> Promise<{ path } | { message, tone }>
 *       64-hex: nullifier -> /nullifier/:hex, commitment -> /commitment/:hex, otherwise /tx/:hex
 *       (the receipt page asks mempool.space, never our indexer). Tickers -> /t/:TICKER.
 *       Shielded addresses -> an inline message. The getters are injected (api.js in the app,
 *       fakes in tests).
 *   suggestTickers(query, assets, limit = 5) -> [{ ticker, assetId }]
 *   ADDRESS_MESSAGE
 */

export const ADDRESS_MESSAGE = "Shielded addresses never appear on Bitcoin, so there's nothing to look up.";

export function classify(query, { hrp = "mrk" } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return { kind: "empty", value: "" };
  const lower = q.toLowerCase();
  if (lower.startsWith(`${hrp}1`) && lower.length > hrp.length + 8) return { kind: "address", value: lower };
  const hex = lower.replace(/^0x/, "");
  if (/^[0-9a-f]{64}$/.test(hex)) return { kind: "hex64", value: hex };
  if (/^#?\d{1,7}$/.test(q) && q.startsWith("#")) return { kind: "height", value: Number(q.slice(1)) };
  if (/^\$?[A-Za-z0-9]{1,16}$/.test(q)) return { kind: "ticker", value: q.replace(/^\$/, "").toUpperCase() };
  return { kind: "unknown", value: q };
}

/** Field elements may come as decimal strings or hex; compare them as numbers. */
function toBig(v) {
  try {
    const s = String(v).trim().toLowerCase();
    if (/^\d+$/.test(s)) return BigInt(s);
    return BigInt("0x" + s.replace(/^0x/, ""));
  } catch {
    return null;
  }
}

export function suggestTickers(query, assets, limit = 5) {
  const q = String(query ?? "").trim().replace(/^\$/, "").toUpperCase();
  if (!q || !Array.isArray(assets)) return [];
  return assets
    .filter((a) => typeof a?.ticker === "string" && a.ticker.toUpperCase().startsWith(q))
    .sort((a, b) => a.ticker.length - b.ticker.length || a.ticker.localeCompare(b.ticker))
    .slice(0, limit)
    .map((a) => ({ ticker: a.ticker, assetId: a.assetId ?? a.id ?? a.asset ?? a.ticker }));
}

export async function resolveSearch(query, { hrp = "mrk", getNullifiers, getCommitments, getAssets } = {}) {
  const c = classify(query, { hrp });
  switch (c.kind) {
    case "empty":
      return { message: "Type a txid, nullifier, commitment or ticker.", tone: "info" };
    case "address":
      return { message: ADDRESS_MESSAGE, tone: "info" };
    case "hex64": {
      const want = toBig(c.value);
      const [nulls, comms] = await Promise.all([
        getNullifiers ? getNullifiers().catch(() => []) : [],
        getCommitments ? getCommitments().catch(() => []) : [],
      ]);
      if (nulls.some((n) => toBig(n) === want)) return { path: `/nullifier/${c.value}` };
      if (comms.some((row) => toBig(Array.isArray(row) ? row[0] : (row?.commitment ?? row)) === want)) return { path: `/commitment/${c.value}` };
      return { path: `/tx/${c.value}` };
    }
    case "ticker": {
      const list = getAssets ? await getAssets().catch(() => null) : null;
      if (list === null) return { path: `/t/${c.value}` };
      const hit = list.find((a) => String(a?.ticker ?? "").toUpperCase() === c.value);
      if (hit) return { path: `/t/${hit.ticker}` };
      return { message: `No token with the ticker ${c.value}. Check the spelling, or browse all mints.`, tone: "warn" };
    }
    case "height":
      return { message: "Block pages aren't available yet. Open the Explorer for recent blocks.", tone: "info" };
    default:
      return { message: "Not a txid, nullifier, commitment or ticker. Paste a 64-character hex value or a ticker.", tone: "warn" };
  }
}

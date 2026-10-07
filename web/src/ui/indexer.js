/**
 * Your own indexer: the steps to run one from a copy of the source, and the connection check
 * behind the public switch on /verify#indexer. The indexer URL is a setting of this browser
 * (api.setIndexerBase), so switching needs no wallet.
 *
 * API
 *   INDEXER_HREF                       "/verify#indexer": where any visitor can switch indexer
 *   ARTIFACT_FILES                     [served name, path in a copy of the source]
 *   runCommands({ repoUrl, origin }) -> string
 *       shell steps: get the source (a clone line only when repoUrl is set), fetch the pinned
 *       artifacts from `origin` (the zkey can't be rebuilt; a clone checks them with
 *       npm run artifacts:fetch), build the site, start the indexer
 *   testIndexer(url, { getJson, ourHeight, ourRootAt }) -> Promise<{ ok, text }>
 *       reads <url>/api/state, then compares its root with ours at the lower of the two heights.
 *       ok: true match, false the tested indexer failed or differs, null this site's side failed
 *       It refuses an indexer for another network than this build's (`network` in /api/state;
 *       an indexer without the field is a signet one).
 *   switchIndexer(url, { setBase, refresh, session }) points this browser at url ("" = this
 *       site), refreshes the chain state now and resyncs an unlocked wallet, as Settings does.
 *       setBase may be async (api.useIndexer checks the network first): then it returns a promise
 *   networkOfState(state) -> "signet" | "mainnet" | ...   wrongNetworkText(theirs) -> string
 */
import { heightText } from "./format.js";
import { NETWORK } from "../config.js";

/** The network an indexer's /api/state reports; an indexer older than the field serves signet. */
export const networkOfState = (s) => (typeof s?.network === "string" && s.network ? s.network : "signet");

export const wrongNetworkText = (theirs, ours = NETWORK) =>
  `That indexer serves Bitcoin ${theirs}, but this site is built for Bitcoin ${ours}. Use a ${ours} indexer, or this site's own.`;

export const INDEXER_HREF = "/verify#indexer";

// What server/indexer-server.mjs loads and serves; it checks each against src/pins.json.
export const ARTIFACT_FILES = [
  ["verification_key.json", "build/dev/verification_key.json"],
  ["manifest.json", "build/manifest.json"],
  ["transaction.zkey", "build/dev/transaction.zkey"],
  ["transaction.wasm", "build/transaction_js/transaction.wasm"],
];

export function runCommands({ repoUrl = null, origin = "https://<this-site>" } = {}) {
  // From a clone, the fetch script downloads the pinned files and checks each against
  // src/pins.json before writing anything; a copy without it gets the plain downloads.
  const fetch = repoUrl
    ? [`npm run artifacts:fetch -- --from ${origin}/artifacts`]
    : ["mkdir -p build/dev build/transaction_js", ...ARTIFACT_FILES.map(([name, path]) => `curl -fo ${path} ${origin}/artifacts/${name}`)];
  return [
    repoUrl ? `git clone ${repoUrl} murkle && cd murkle` : "# in your copy of the source",
    repoUrl ? "npm ci" : "npm install",
    ...fetch,
    "npm run web:build",
    "npm run indexer",
  ].join("\n");
}

export async function testIndexer(url, { getJson, ourHeight = null, ourRootAt }) {
  const base = String(url ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/.test(base)) return { ok: false, text: "Can't use it: use a full address such as http://localhost:8787." };
  const fail = (err) => ({ ok: false, text: `Can't use it: ${err.message}` });
  let height;
  try {
    const st = await getJson(`${base}/api/state`);
    if (networkOfState(st) !== NETWORK) return { ok: false, text: `Can't use it: ${wrongNetworkText(networkOfState(st))}` };
    height = Number(st?.height);
    if (!Number.isFinite(height)) throw new Error("it didn't report a block height.");
  } catch (err) {
    return fail(err);
  }
  // A failure on this site's side says nothing about the tested indexer.
  const unknown = { ok: null, text: `Connected at ${heightText(height)}, but the indexer this site uses now didn't answer, so the roots weren't compared. Try again in a minute.` };
  if (ourHeight == null) return unknown;
  const h = Math.min(height, ourHeight);
  const [a, b] = await Promise.allSettled([getJson(`${base}/api/roots?height=${h}`), (async () => ourRootAt(h))()]);
  if (a.status === "rejected") return fail(a.reason);
  if (b.status === "rejected" || b.value == null) return unknown;
  const same = Boolean(a.value?.root) && String(a.value.root) === String(b.value);
  return {
    ok: same,
    text: same
      ? `Connected. Its root at ${heightText(h)} matches the indexer this site uses now.`
      : `Connected, but its root at ${heightText(h)} differs from the indexer this site uses now. One of them is wrong or on another network.`,
  };
}

export function switchIndexer(url, { setBase, refresh, session = null }) {
  const done = () => {
    if (session) {
      session.view = null;
      session.sync().catch(() => {});
    }
    refresh();
  };
  const r = setBase(url);
  if (r && typeof r.then === "function") return r.then(done);
  done();
}

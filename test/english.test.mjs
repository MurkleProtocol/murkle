// Repo-wide guards: English only, and no claims the protocol cannot back up
// (docs/CLAIMS.md, docs/design/visual.md section 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const SKIP_DIRS = new Set(["node_modules", "build", "data", "dist", ".vite", ".git"]);
const TEXT = /\.(mjs|js|json|md|circom|css|html|sh|svg|txt)$/;

function files(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files(path, out);
    else if (TEXT.test(name) && !name.endsWith("package-lock.json")) out.push(path);
  }
  return out;
}

test("no Cyrillic anywhere in the repository", () => {
  const hits = files(ROOT)
    .filter((f) => /[\u0400-\u04FF]/.test(readFileSync(f, "utf8")))
    .map((f) => relative(ROOT, f));
  assert.deepEqual(hits, []);
});

// Phrases a metaprotocol cannot honestly claim. Bitcoin orders and stores the data;
// replayers (and your browser) check the proofs.
const BANNED = [
  /\btrustless\b/i,
  /bitcoin\s+(verifies|validates|enforces)\s+(the\s+|every\s+|each\s+)?proofs?/i,
  /secured by bitcoin consensus/i,
  /fully anonymous/i,
  /\buntraceable\b/i,
  /military[- ]grade/i,
  /mainnet[- ]ready/i,
];

test("user-facing copy makes no banned claims", () => {
  const ui = files(join(ROOT, "web")).filter((f) => /\.(js|html)$/.test(f));
  const hits = [];
  for (const f of ui) {
    // Comments may quote the rules themselves; only strings that can reach users count.
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const re of BANNED) if (re.test(code)) hits.push(`${relative(ROOT, f)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

// Paid relay stage 0 (docs/design/paid-relay.md §1, §12): there is no free mode of any kind and the
// operator never pays for a user's transaction, so no user-facing string in web/ may promise free,
// sponsored or operator-paid relaying, or say that private sends need no BTC.
const FREE_RELAY = [
  /\bfree[- ]relay/i,
  /\brelay\w*[^.\n]{0,24}\bfree\b/i,
  /\bsponsor/i,
  /\bneeds? no BTC\b/i,
  /\bno BTC at all\b/i,
  /\bzero[- ]BTC\b/i,
  /\bfor free\b/i,
  /\bfree on signet\b/i,
  /\bfree (sends?|transfers?|fees?|relaying)\b/i,
  /\brelays? left\b/i,
  /\bGhost Relay\b/i,
  /\brelayer pays\b/i,
  /\bpaid by the relayer\b/i,
  /\bproof of sponsorship\b/i,
  /\bdaily (relay )?budget\b/i,
  /\bbudget is used up\b/i,
];

test("user-facing copy in web/ promises no free or sponsored relaying", () => {
  const ui = files(join(ROOT, "web")).filter((f) => /\.(js|html)$/.test(f));
  const hits = [];
  for (const f of ui) {
    const code = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
    for (const re of FREE_RELAY) if (re.test(code)) hits.push(`${relative(ROOT, f)}: ${re}`);
  }
  assert.deepEqual(hits, []);
  // The guard itself catches what it is meant to.
  for (const s of ["Private relay: free, your BTC wallet is not used", "Free relays left this block", "Private sends through Ghost Relay need no BTC at all.", "Proof of sponsorship", "Free on signet · relayer pays ~597 sats"]) {
    assert.ok(FREE_RELAY.some((re) => re.test(s)), s);
  }
  // A free mint (price 0) is a token's terms, not relaying.
  assert.ok(!FREE_RELAY.some((re) => re.test("Free mint")));
});

// The indexer serves web/dist on its own port (server/indexer-server.mjs WEB_DIST): a build made
// before stage 0 would bring the retired copy back. The build also bundles SPEC.md and the audit
// findings, which name the retired free relayer, Ghost Relay and the sponsored-relayer finding on
// purpose, so this list holds the retired UI copy itself. Rebuild with `npm run web:build`; a
// checkout without a build skips this.
const DIST = join(ROOT, "web", "dist");
const RETIRED_UI = [
  /\bFree relays left\b/i,
  /\bProof of sponsorship\b/i,
  /\bfree on signet\b/i,
  /\bneeds? no BTC\b/i,
  /\bno BTC at all\b/i,
  /\bPrivate relay: free\b/i,
  /\brelayer pays\b/i,
  /\bpaid by the relayer\b/i,
  /\bdaily relay budget\b/i,
  /\bbudget is used up\b/i,
  /\bGhost Relay \(default\)/i,
  /\bvia Ghost Relay\b/i,
  /\bsponsored sat/i,
];
test("a built web/dist carries none of the retired relay copy", { skip: !existsSync(DIST) && "no web/dist build" }, () => {
  const hits = [];
  for (const f of files(DIST).filter((p) => /\.(js|html)$/.test(p))) {
    const code = readFileSync(f, "utf8");
    for (const re of RETIRED_UI) if (re.test(code)) hits.push(`${relative(ROOT, f)}: ${re}`);
  }
  assert.deepEqual(hits, [], "web/dist is stale: rebuild it with npm run web:build");
  // Every one of these is also caught in the sources.
  for (const s of ["Free relays left this block", "Proof of sponsorship", "Free on signet", "need no BTC at all", "Private relay: free", "relayer pays", "paid by the relayer", "Daily relay budget used", "budget is used up", "Ghost Relay (default)", "via Ghost Relay", "Every sponsored sat"]) {
    assert.ok(RETIRED_UI.some((re) => re.test(s)), s);
    assert.ok(FREE_RELAY.some((re) => re.test(s)), s);
  }
});

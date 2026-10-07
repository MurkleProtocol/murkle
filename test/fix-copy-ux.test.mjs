// Copy and UX fixes (numbered tests refer to findings of an internal review).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { shareText } from "../web/src/share/launch-card.js";
import { redact, redactTip, REDACT_TIP } from "../web/src/ui/redact.js";
import { popoverKey } from "../web/src/ui/sheet.js";
import { rootDetails } from "../web/src/ui/rootmatch.js";
import { sealBlock } from "../web/src/ui/seal.js";
import { INDEXER_HREF, ARTIFACT_FILES, runCommands, testIndexer, switchIndexer } from "../web/src/ui/indexer.js";
import { ARTIFACTS } from "../server/indexer-server.mjs";
import facts from "../web/src/facts.json" with { type: "json" };

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

test("#36 the launch share text says signet and that mints are public", () => {
  const t = shareText({ ticker: "ABC" }, "https://murkle.example/t/ABC");
  assert.ok(!/privately/i.test(t), "a mint is a public purchase");
  assert.match(t, /^Mint \$ABC on Bitcoin \(signet test network, no value\)\./);
  assert.match(t, /mints are public/);
  assert.ok(t.length - "https://murkle.example/t/ABC".length + 23 <= 280, "fits a post");
});

test("#42 redaction tooltips never say the recipient sees the sender or the spent notes", () => {
  for (const k of ["amount", "token", "recipient"]) assert.equal(redactTip(k), REDACT_TIP);
  for (const k of ["sender", "spent"]) {
    assert.ok(!/recipient can see|sender and recipient/i.test(redactTip(k)), k);
    assert.match(redactTip(k), /Only the sender knows/);
  }
  assert.match(String(redact("sender")), new RegExp(`data-tip="${redactTip("sender").replace("'", "&#39;")}"`));
  assert.match(String(redact("spent")), /redact--address/);
  assert.match(String(redact("address")), /data-tip="Not readable on Bitcoin\."/, "a generic bar claims nothing about who reads it");
  assert.match(String(redact("amount", { tip: "Your own balance." })), /data-tip="Your own balance\."/);
});

test("#39 popover keyboard model: focus goes in, Tab leaves past the ends, menus take arrows", () => {
  assert.deepEqual(popoverKey("Escape", { index: 1, count: 3 }), { close: true, prevent: false });
  assert.deepEqual(popoverKey("Tab", { index: -1, count: 3 }), { focus: 0, prevent: true }, "focus outside: Tab enters");
  assert.equal(popoverKey("Tab", { index: 0, count: 3 }), null, "inside: native Tab");
  assert.deepEqual(popoverKey("Tab", { index: 2, count: 3 }), { close: true, prevent: false }, "past the end: back to the anchor, then on");
  assert.deepEqual(popoverKey("Tab", { index: 0, count: 3, shift: true }), { close: true, prevent: true });
  assert.deepEqual(popoverKey("ArrowDown", { index: 2, count: 3, menu: true }), { focus: 0, prevent: true });
  assert.deepEqual(popoverKey("ArrowUp", { index: 0, count: 3, menu: true }), { focus: 2, prevent: true });
  assert.deepEqual(popoverKey("ArrowUp", { index: -1, count: 3, menu: true }), { focus: 2, prevent: true });
  assert.deepEqual(popoverKey("End", { index: 0, count: 3, menu: true }), { focus: 2, prevent: true });
  assert.equal(popoverKey("ArrowDown", { index: 0, count: 3, menu: false }), null, "a readout keeps native arrows");
  assert.match(String(rootDetails({ state: "match" })), /data-action="root-rebuild" data-autofocus/, "Rebuild now gets focus first");
  const src = read("web/src/ui/sheet.js");
  assert.match(src, /\.focus\(\{ preventScroll: true \}\);\r?\n\s+return api;/, "openPopover moves focus inside");
});

test("#40 the skip link moves focus without a fragment navigation", () => {
  const src = read("web/src/app.js");
  assert.match(src, /<a class="skip" href="#main">/);
  assert.match(src, /\$\("\.skip"\)\.addEventListener\("click", \(e\) => \{\s+e\.preventDefault\(\);\s+main\.focus\(\);/);
});

test("#44 indexer links lead to the public switch, not the wallet-gated Settings", () => {
  assert.equal(INDEXER_HREF, "/verify#indexer");
  const details = String(rootDetails({ state: "mismatch", root: "1", localRoot: "2" }));
  assert.ok(details.includes(`href="${INDEXER_HREF}"`) && !details.includes("/app/settings"));
  const seal = String(sealBlock({ state: "mismatch" }));
  assert.ok(seal.includes(`href="${INDEXER_HREF}"`) && !/in Settings/.test(seal));
  const verify = read("web/src/views/verify.js");
  assert.match(verify, /<section id="indexer"/);
  assert.match(verify, /switchIndexer\([^)]*setBase: api\.useIndexer/, "the switch works without a wallet session and checks the indexer's network first");
  assert.ok(!/in Settings/.test(verify));
  const nav = verify.match(/<nav class="vf-jump[\s\S]*?<\/nav>/)[0];
  assert.ok(nav.includes(`href="#indexer"`), "the jump nav reaches the switch");
  const kit = read("web/src/ui/kit-view.js");
  assert.ok(!/indexer in Settings/.test(kit));
  assert.match(kit, /action: \{ label: "Switch indexer", href: INDEXER_HREF \}/);
});

test("#44 switching on /verify resyncs an unlocked wallet and refreshes the chain state now", () => {
  const calls = [];
  const setBase = (u) => {
    if (u && !/^https?:\/\//.test(u)) throw new Error("bad");
    calls.push(["base", u]);
  };
  const refresh = () => calls.push(["refresh"]);
  const session = { view: { outputs: [1] }, sync: () => (calls.push(["sync"]), Promise.reject(new Error("offline"))) };
  switchIndexer("http://localhost:8787", { setBase, refresh, session });
  assert.equal(session.view, null, "the old indexer's view is dropped, as Settings does");
  assert.deepEqual(calls, [["base", "http://localhost:8787"], ["sync"], ["refresh"]]);
  calls.length = 0;
  switchIndexer("", { setBase, refresh });
  assert.deepEqual(calls, [["base", ""], ["refresh"]], "no wallet: still refreshes");
  calls.length = 0;
  const kept = { view: 1, sync: () => calls.push(["sync"]) };
  assert.throws(() => switchIndexer("ftp://x", { setBase, refresh, session: kept }));
  assert.deepEqual(calls, [], "a rejected URL changes nothing");
  assert.equal(kept.view, 1);
  const verify = read("web/src/views/verify.js");
  assert.match(verify, /\(await import\("\.\.\/session\.js"\)\)\.currentSession\(\)/, "verify passes the unlocked session");
  assert.ok(!/from "\.\.\/session\.js"/.test(verify), "no static wallet import on a public page");
});

test("#44 the connection test blames this site, not the tested indexer, when ours fails", async () => {
  const theirs = async (u) => (u.endsWith("/api/state") ? { height: 12 } : { root: "7" });
  const downOurs = await testIndexer("http://localhost:8787", { getJson: theirs, ourHeight: null, ourRootAt: async () => "7" });
  assert.equal(downOurs.ok, null);
  assert.ok(!/Can't use it/.test(downOurs.text) && /this site uses now didn't answer/.test(downOurs.text), downOurs.text);
  assert.match(downOurs.text, /^Connected at #12/);
  const rootsDown = await testIndexer("http://localhost:8787", { getJson: theirs, ourHeight: 12, ourRootAt: async () => { throw new Error("Can't reach the indexer."); } });
  assert.equal(rootsDown.ok, null);
  assert.equal((await testIndexer("http://localhost:8787", { getJson: theirs, ourHeight: 12, ourRootAt: async () => null })).ok, null);
  const theirRootsDown = async (u) => { if (u.endsWith("/api/state")) return { height: 12 }; throw new Error("it answered HTTP 404."); };
  assert.deepEqual(await testIndexer("http://localhost:8787", { getJson: theirRootsDown, ourHeight: 12, ourRootAt: async () => "7" }), { ok: false, text: "Can't use it: it answered HTTP 404." });
  assert.match(read("web/src/views/verify.js"), /result\.ok === null \? "t-warn"/, "an unanswered comparison is a warning, not a failure");
});

test("#37 the run steps have no placeholder repo and fetch the pinned artifacts the server loads", () => {
  const plain = runCommands({ origin: "https://site.example" });
  assert.ok(!plain.includes("git clone") && !plain.includes("<repository-url>"), "no clone line without a public repo");
  assert.match(runCommands({ repoUrl: "https://git.example/murkle", origin: "x" }), /^git clone https:\/\/git\.example\/murkle murkle && cd murkle\n/);
  const served = Object.fromEntries(Object.entries(ARTIFACTS).map(([k, v]) => [k, relative(ROOT, v).replace(/\\/g, "/")]));
  assert.deepEqual(Object.fromEntries(ARTIFACT_FILES), served, "every file the server loads, at the path it loads it from");
  for (const [name, path] of ARTIFACT_FILES) assert.ok(plain.includes(`curl -fo ${path} https://site.example/artifacts/${name}`), name);
  const lines = plain.split("\n");
  assert.ok(lines.indexOf("npm run indexer") > lines.findLastIndex((l) => l.startsWith("curl")), "download before start");
  assert.ok(lines.includes("npm run web:build"));
  const verify = read("web/src/views/verify.js");
  assert.ok(!verify.includes("<repository-url>"));
  assert.ok(!/Settings → Indexer/.test(verify + read("web/src/views/landing.js")));
});

test("#37 the connection test compares roots at the lower height", async () => {
  const roots = { 10: "7", 12: "9" };
  const theirs = (height, root) => async (u) => (u.endsWith("/api/state") ? { height } : { height: Number(u.split("=")[1]), root });
  const ourRootAt = async (h) => roots[h] ?? null;
  const same = await testIndexer("http://localhost:8787/", { getJson: theirs(12, "7"), ourHeight: 10, ourRootAt });
  assert.equal(same.ok, true);
  assert.match(same.text, /at #10 matches/);
  const differs = await testIndexer("http://localhost:8787", { getJson: theirs(12, "8"), ourHeight: 12, ourRootAt });
  assert.equal(differs.ok, false);
  assert.match(differs.text, /differs/);
  const down = await testIndexer("http://localhost:1", { getJson: async () => { throw new Error("Failed to fetch"); }, ourRootAt });
  assert.deepEqual(down, { ok: false, text: "Can't use it: Failed to fetch" });
  assert.equal((await testIndexer("localhost:8787", { getJson: async () => ({}), ourRootAt })).ok, false);
  assert.match((await testIndexer("http://x.example", { getJson: async () => ({}), ourRootAt })).text, /block height/);
});

test("#43 leads scope the hiding to transfers; README states the pinned genesis", () => {
  const readme = read("README.md");
  const lead = readme.split("\n").find((l) => l.startsWith("**Private tokens"));
  assert.ok(!/Launch, mint and send tokens with/.test(lead));
  assert.match(lead, /Launch and mint tokens in public/);
  assert.match(readme, /Launches and mints are public/);
  assert.ok(!/^\d+\. Signet genesis\.$/m.test(readme), "genesis is done");
  const pins = JSON.parse(read("src/pins.json"));
  if (pins.genesisTxid) assert.ok(readme.includes(pins.genesisTxid));
  assert.ok(!/npm run circuit:build {2,}#/.test(readme), "Quick start no longer rebuilds the pinned keys");
  for (const f of ["web/src/views/landing.js", "web/src/ui/kit-view.js", "docs/design/visual.md"]) {
    assert.ok(!/Launch, mint and send tokens on Bitcoin L1 with/.test(read(f)), f);
  }
  const meta = read("docs/design/visual.md").match(/^- description: "([^"]+)"/m)[1];
  assert.ok(!/mint and send private/.test(meta), "the meta spec doesn't call mints private");
  assert.match(meta, /in public, then send them privately/);
  assert.ok(meta.length <= 160 && /Signet/.test(meta), meta);
});

test("#28 #47 the audit report's constraint count matches the pinned build", () => {
  const report = read("audit/REPORT.md");
  const scope = report.split("\n").find((l) => l.startsWith("- **Circuit:**"));
  const n = facts.circuit.constraints.toLocaleString("en-US");
  assert.ok(scope.includes(`${n} constraints as pinned`), scope);
  assert.match(scope, /18,633 non-linear constraints at circom's default `--O1`/, "the other number is labelled");
  assert.ok(!/once it is pinned/.test(report));
});

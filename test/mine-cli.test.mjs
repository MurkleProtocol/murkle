// Mining in the CLI (docs/design/mining-contract.md §11, §12, §13 "cli"):
// - `deploy-pow`: the terms and their defaults (LAUNCH_DEFAULTS), the envelope it builds, strict flags,
//   the fee policy (a claim fee or a treasury is refused under the platform-only policy), the end
//   height against the earliest mining start, the activation gate, and --dry-run;
// - `mine` against a fake chain, end to end: self-pay with the separate mining key (the carrier, its fee
//   outputs, RBF, the W-M entry written before the broadcast, landing) and relay (a signed submit,
//   bind_stale re-proved with the same nonce, landing by relay status, never a self-pay fallback);
//   a new challenge on each new tip and after each solution; refusal before paying when the claim
//   cannot land; the reference re-check; --prepare-coins; the mining key;
// - W-M in the wallet file (keepPending, merges, pending, retry);
// - `audit --compare` names a digest version change;
// - README, docs/CLAIMS.md and audit/REPORT.md carry the new sections and none of the banned words.
// src/mine.mjs, src/pow-pool.mjs and the client track's wallet and funding additions are other tracks'
// files: until they are in the checkout this file uses stubs written from the contract, and the tests
// that need the real modules are skipped. Fakes, temporary files and no network: nothing touches
// data/signet/, nothing is broadcast.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as btc from "@scure/btc-signer";
import { sha256 } from "@noble/hashes/sha256";
import { concat, hex, unhex } from "../src/bytes.mjs";
import * as envelopeLib from "../src/envelope.mjs";
import * as funding from "../src/btc/funding.mjs";
import { btcAccount, dustLimit } from "../src/btc/funding.mjs";
import * as params from "../src/params.mjs";
import { auditFacts } from "../scripts/facts.mjs";

const DIR = mkdtempSync(join(tmpdir(), "murkle-mine-cli-"));
process.env.MURKLE_DATA_DIR = DIR;
process.env.MURKLE_ESPLORA = "http://127.0.0.1:9/api";
delete process.env.MURKLE_RELAY_URL;
const CLI = await import("../bin/murkle.mjs");
const {
  DEPLOY_POW_USAGE, HELP, MINE_COPY, MINE_USAGE, claimRefusal, deployPowCommand, deployPowTerms, digestVersionLine, keepPending, listPending,
  mergeWalletFile, mineKeyOf, minedAssetLines, parseMineArgs, pickRetry, prepareCoinsCommand, runMiner,
} = CLI;
const relayLib = await import("../src/relay-account.mjs");

after(async () => {
  rmSync(DIR, { recursive: true, force: true });
  if (globalThis.curve_bn128) await globalThis.curve_bn128.terminate();
});

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const HAS_MINE = existsSync(new URL("../src/mine.mjs", import.meta.url));
const HAS_DEPLOY_POW = typeof envelopeLib.encodeDeployPow === "function";
const FEE = params.MINE_FEE;
const PLATFORM = unhex(FEE.platformScript);
const te = new TextEncoder();
const sha = (x) => sha256(typeof x === "string" ? te.encode(x) : x);
const quiet = () => {};
const hasCyrillic = (s) => [...s].some((c) => c.codePointAt(0) >= 0x400 && c.codePointAt(0) <= 0x4ff);

/* ------------------------------------------------------------------ src/mine.mjs, or a contract stub */

const DEFAULTS = Object.freeze({
  span: 24, perBlock: 1, launchHashrate: 2000, floorDivisor: 16, browserThreadHs: 250, lowFloorRatio: 1000, halvingInterval: 0, claimFeeSats: 0n, start: "now", startAfter: 144,
});

/**
 * The parts of src/mine.mjs the CLI calls, as mining-contract.md §3 specifies them. The hash is a
 * stand-in (sha256, not Argon2): these tests check the CLI's flow, the vectors are the core track's.
 */
function stubLib(over = {}) {
  const lib = {
    LAUNCH_DEFAULTS: DEFAULTS,
    suggestInitialDifficulty: ({ hashrate, span, targetPerSpan }) => {
      const d = BigInt(Math.floor((hashrate * 600 * span) / targetPerSpan));
      return d < 256n ? 256n : d;
    },
    suggestFloor: (d) => (d / 16n < 256n ? 256n : d / 16n),
    checkFeePolicy(claimFeeSats, treasury, fee) {
      if (fee.deployerMinSats > 0n) return claimFeeSats < fee.deployerMinSats || claimFeeSats > fee.deployerMaxSats ? `malformed: claim fee ${claimFeeSats} outside ${fee.deployerMinSats}..${fee.deployerMaxSats}` : null;
      if (claimFeeSats === 0n) return null;
      if (fee.deployerMaxSats === 0n) return "malformed: deployer claim fee not allowed";
      if (claimFeeSats < 546n) return "malformed: claim fee below 546 sats";
      return claimFeeSats > fee.deployerMaxSats ? `malformed: claim fee ${claimFeeSats} outside 0..${fee.deployerMaxSats}` : null;
    },
    mineStartOf: (a) => Math.max(a.startHeight ?? 0, a.deployHeight),
    startHeightFor: ({ start, after, tip }) => (start === "now" ? 0 : tip + 1 + after),
    challengeOf: ({ asset, refHeight, refHash, reward, commitments }) => sha(JSON.stringify([String(asset), refHeight, refHash, String(reward), commitments.map(String)])),
    passwordOf: (challenge, nonce) => concat(challenge, nonce),
    powHashReference: (password) => sha(concat(te.encode("pow"), password)),
    solutionIdOf: (challenge, nonce) => sha(concat(challenge, nonce)),
    targetOf: (d) => ((1n << 256n) - 1n) / BigInt(d),
    meetsTarget: () => true,
    effectiveDifficulty: () => 1000n,
    difficultyAt: () => 1000n,
    rewardAt: (asset) => asset.reward,
    mineStatus: (asset, tip) => (tip < asset.mineStart ? "mining-soon" : asset.issued + asset.reward > asset.maxSupply ? "mined-out" : "mining"),
    requiredFeeOutputs: (asset, fee) => [{ script: unhex(fee.platformScript), sats: fee.platformSats, role: "platform" }],
    disabled: null,
    disableFastPath(reason) {
      lib.disabled = reason;
    },
  };
  return Object.assign(lib, over);
}

/* ------------------------------------------------------------------ deploy-pow */

test("deploy-pow terms: defaults from LAUNCH_DEFAULTS, suggested difficulty and floor, strict bounds", () => {
  const lib = stubLib();
  const { terms, hashrate, perBlock, feeRate, dryRun } = deployPowTerms(["--ticker", "dig", "--reward", "1000", "--max-supply", "21000000"], { lib });
  assert.equal(terms.ticker, "DIG");
  assert.equal(terms.span, 24);
  assert.equal(terms.targetPerSpan, 24, "S = perBlock x span");
  assert.equal(perBlock, 1);
  assert.equal(hashrate, 2000);
  assert.equal(terms.initialDifficulty, 1_200_000n, "2,000 H/s x 600 s x 24 / 24");
  assert.equal(terms.minDifficulty, 75_000n, "floor = initial / 16");
  assert.equal(terms.claimFeeSats, 0n);
  assert.equal(terms.treasury.length, 0);
  assert.deepEqual([terms.halvingInterval, terms.startHeight, terms.endHeight, terms.divisibility], [0, 0, 0, 0]);
  assert.equal(feeRate, null);
  assert.equal(dryRun, false);

  const custom = deployPowTerms(
    ["--ticker=ABC", "--reward", "50", "--max-supply", "5000", "--span", "12", "--per-block", "2", "--difficulty", "4096", "--min-difficulty", "256", "--halving", "100", "--start-after", "100", "--end", "3000", "--fee-rate", "3", "--dry-run"],
    { lib, tip: 1899 },
  );
  assert.equal(custom.startAfter, 100);
  assert.equal(custom.terms.targetPerSpan, 24);
  assert.equal(custom.terms.initialDifficulty, 4096n);
  assert.equal(custom.terms.minDifficulty, 256n);
  assert.equal(custom.hashrate, null, "no suggestion behind an explicit difficulty");
  assert.deepEqual([custom.terms.halvingInterval, custom.terms.startHeight, custom.terms.endHeight, custom.feeRate, custom.dryRun], [100, 2000, 3000, 3, true], "--start-after 100 at tip 1899: block 1899 + 1 + 100");
  // The two start choices: --start now (the default) and --start-after N.
  const base0 = ["--ticker", "A", "--reward", "1", "--max-supply", "1"];
  const now = deployPowTerms([...base0, "--start", "now"], { lib, tip: 500 });
  assert.deepEqual([now.terms.startHeight, now.startAfter], [0, 0], "--start now: startHeight 0, mining opens at the launch block");
  assert.deepEqual([deployPowTerms(base0, { lib }).terms.startHeight, deployPowTerms(base0, { lib }).startAfter], [0, 0], "now is the default");
  const later = deployPowTerms([...base0, "--start-after=10"], { lib });
  assert.deepEqual([later.terms.startHeight, later.startAfter], [null, 10], "without a tip only the flags are checked");
  assert.equal(deployPowTerms([...base0, "--start-after", "10"], { lib, tip: 500 }).terms.startHeight, 511);
  assert.throws(() => deployPowTerms([...base0, "--start-after", "10", "--end", "510"], { lib, tip: 500 }), /--end must be 0 \(no end\) or at least the start block 511/);
  assert.equal(deployPowTerms([...base0, "--start-after", "10", "--end", "511"], { lib, tip: 500 }).terms.endHeight, 511);
  assert.ok(DEPLOY_POW_USAGE.includes("[--start now | --start-after N]"));
  assert.equal(deployPowTerms(["--ticker", "A", "--reward", "1", "--max-supply", "1", "--hashrate", "1"], { lib }).terms.initialDifficulty, 600n, "1 H/s x 600 s per solution");
  // A low hashrate never suggests less than MIN_DIFFICULTY: 1 x 600 x 24 / 2,400 = 6.
  const low = deployPowTerms(["--ticker", "A", "--reward", "1", "--max-supply", "1", "--hashrate", "1", "--per-block", "100"], { lib }).terms;
  assert.deepEqual([low.initialDifficulty, low.minDifficulty], [256n, 256n]);

  const bad = [
    [["--reward", "1", "--max-supply", "1"], /required/],
    [["--ticker", "toolongtickername17", "--reward", "1", "--max-supply", "1"], /1 to 16/],
    [["--ticker", "A-B", "--reward", "1", "--max-supply", "1"], /1 to 16/],
    [["--ticker", "A", "--reward", "0", "--max-supply", "1"], /--reward must be from 1/],
    [["--ticker", "A", "--reward", String(1n << 63n), "--max-supply", String(1n << 63n)], /--reward must be from 1/],
    [["--ticker", "A", "--reward", "10", "--max-supply", "9"], /at least --reward/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--span", "11"], /--span must be from 12 to 432/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--span", "433"], /--span must be from 12 to 432/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--span", "12"], /at least 16 solutions per span/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--per-block", "101"], /at most 100/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--difficulty", "1000", "--hashrate", "5"], /not both/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--difficulty", "1000", "--min-difficulty", "255"], /at least 256/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--difficulty", "300", "--min-difficulty", "400"], /from the floor 400/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--difficulty", String(1n << 63n)], /9223372036854775807/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--divisibility", "9"], /--divisibility must be at most 8/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--start", "50"], /--start takes only "now"; to start later, give --start-after N/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--start", "later"], /--start takes only "now"/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--start", "now", "--start-after", "5"], /--start now or --start-after N, not both/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--start-after", "0"], /--start-after must be at least 1 block/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--start-after", "-1"], /needs a value|whole number/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--start-after", "1.5"], /whole number/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--start-after"], /--start-after needs a value/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--start-after", "4294967296"], /--start-after must be at most/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--fee-rate", "0"], /at least 1 sat\/vB/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--difficulty", "-5"], /whole number/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--dryrun"], /unknown flag --dryrun/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "--dry-run=1"], /takes no value/],
    [["--ticker", "A", "--ticker", "B", "--reward", "1", "--max-supply", "1"], /given twice/],
    [["--ticker", "A", "--reward", "1", "--max-supply", "1", "stray"], /unexpected argument/],
  ];
  for (const [args, re] of bad) assert.throws(() => deployPowTerms(args, { lib }), re, args.join(" "));
  assert.ok(DEPLOY_POW_USAGE.includes("--difficulty D | --hashrate H"));
});

test("deploy-pow refuses a claim fee and a treasury under the platform-only fee policy, before anything is built", () => {
  const lib = stubLib();
  const tb = btcAccount(randomBytes(32)).address;
  const base = ["--ticker", "DIG", "--reward", "10", "--max-supply", "100"];
  assert.throws(() => deployPowTerms([...base, "--claim-fee", "1000", "--treasury", tb], { lib }), (e) => {
    assert.match(e.message, /^refused: malformed: deployer claim fee not allowed/);
    assert.match(e.message, new RegExp(`every claim pays a service fee of 500 sats to the platform address ${FEE.platformAddress}`));
    assert.match(e.message, /no deployer claim fee is allowed\); nothing was broadcast$/);
    return true;
  });
  assert.throws(() => deployPowTerms([...base, "--claim-fee", "1000"], { lib }), /deployer claim fee not allowed/);
  assert.throws(() => deployPowTerms([...base, "--treasury", tb], { lib }), /--treasury receives only a deployer claim fee/);
  assert.equal(deployPowTerms([...base, "--claim-fee", "0"], { lib }).terms.claimFeeSats, 0n, "an explicit zero is the policy itself");
  // The owner's constants: platform only, 500 sats, no deployer fee.
  assert.equal(FEE.platformSats, 500n);
  assert.equal(FEE.deployerMinSats, 0n);
  assert.equal(FEE.deployerMaxSats, 0n);
  assert.equal(hex(funding.scriptOf(FEE.platformAddress)), FEE.platformScript);
  // Under a policy that allows a deployer fee, the same flags pass and the policy's own reason refuses the rest.
  const open = { ...FEE, deployerMaxSats: 10_000n };
  const ok = deployPowTerms([...base, "--claim-fee", "1000", "--treasury", tb], { lib, fee: open });
  assert.equal(ok.terms.claimFeeSats, 1000n);
  assert.equal(hex(ok.terms.treasury), hex(funding.scriptOf(tb)));
  assert.throws(() => deployPowTerms([...base, "--claim-fee", "100", "--treasury", tb], { lib, fee: open }), /below 546 sats/);
  assert.throws(() => deployPowTerms(base, { lib, fee: null }), /no service-fee policy/);
});

function deployFixture({ height = 1000, active = true, tickers = [] } = {}) {
  const calls = { encode: [], build: [], broadcast: [] };
  const idx = { height, tickers: new Map(tickers.map((t) => [t, 1n])), miningActive: () => active, miningHeight: active ? 900 : null };
  const esplora = { broadcast: async (h) => (calls.broadcast.push(h), "ab".repeat(32)) };
  const encode = (terms) => (calls.encode.push(terms), te.encode(`DEPLOY_POW ${terms.ticker}`));
  const build = async ({ envelope, feeRate }) => (calls.build.push({ envelope, feeRate }), { txid: "cd".repeat(32), hex: "beef", vsize: 180, fee: 360 });
  const out = [];
  return { calls, idx, esplora, encode, build, out, print: (s) => out.push(s) };
}

test("deploy-pow prints the terms and the disclosures, then pays; --dry-run broadcasts nothing", async () => {
  const lib = stubLib();
  const f = deployFixture();
  const args = ["--ticker", "DIG", "--reward", "1000", "--max-supply", "21000000", "--fee-rate", "2"];
  const r = await deployPowCommand({ args, idx: f.idx, esplora: f.esplora, lib, encode: f.encode, build: f.build, print: f.print });
  assert.equal(r.status, "broadcast");
  assert.equal(r.mineStart, 1001, "--start now (the default): mining starts at the launch block itself");
  assert.equal(f.calls.encode.length, 1);
  assert.deepEqual(f.calls.encode[0], r.terms, "the envelope is built from exactly the printed terms");
  assert.deepEqual(f.calls.build, [{ envelope: te.encode("DEPLOY_POW DIG"), feeRate: 2 }]);
  assert.deepEqual(f.calls.broadcast, ["beef"]);
  const text = f.out.join("\n");
  for (const s of [
    "DEPLOY_POW DIG: reward 1000 per claim, max supply 21000000", "initial 1200000 (suggested for 2,000 H/s), floor 75000", "span 24 blocks, 24 solutions per span (1 per block)",
    "mining starts now: the first usable block is the launch block itself (block 1001 if it lands in the next block)", MINE_COPY.start, "halving: none", MINE_COPY.fee(FEE), MINE_COPY.noise, MINE_COPY.quiet, MINE_COPY.hardware, MINE_COPY.censor,
    MINE_COPY.testCoins, "service fee: on signet every claim pays a service fee of 500 sats to the platform address", `DEPLOY_POW broadcast: ${"ab".repeat(32)}`,
  ]) {
    assert.ok(text.includes(s), s);
  }
  assert.ok(f.out.indexOf(MINE_COPY.fee(FEE)) < f.out.findIndex((l) => l.startsWith("DEPLOY_POW broadcast")), "disclosed before paying");

  const dry = deployFixture({ active: false });
  const d = await deployPowCommand({ args: [...args, "--dry-run"], idx: dry.idx, esplora: dry.esplora, lib, encode: dry.encode, build: dry.build, print: dry.print });
  assert.equal(d.status, "dry-run");
  assert.deepEqual(dry.calls.broadcast, [], "a dry run broadcasts nothing");
  assert.ok(dry.out.some((l) => l.startsWith("DEPLOY_POW (not broadcast): " + "cd".repeat(32))));
  assert.ok(dry.out.some((l) => /mining is not active at block 1001 \(no activation height is set in this release\)/.test(l)));

  // --start-after N counts from the current tip (1000): mining opens at block 1000 + 1 + N.
  const after = deployFixture();
  const a = await deployPowCommand({ args: [...args, "--start-after", "10"], idx: after.idx, esplora: after.esplora, lib, encode: after.encode, build: after.build, print: after.print });
  assert.deepEqual([a.terms.startHeight, a.mineStart], [1011, 1011]);
  assert.deepEqual(after.calls.encode[0], a.terms);
  const atext = after.out.join("\n");
  assert.ok(atext.includes("mining starts at block 1011, 10 blocks after block 1001 if the launch lands there (counted from the current tip 1000"), atext);
  assert.ok(atext.includes("a launch at or after block 1011 starts mining at its own block"));
  assert.ok(atext.includes(MINE_COPY.start));
  assert.equal(MINE_COPY.start, "Starting now favours whoever is ready first; a delay gives everyone time to see the terms.");
});

test("deploy-pow refuses before paying: mining not active, a taken ticker, an end before the earliest mining start", async () => {
  const lib = stubLib();
  const args = ["--ticker", "DIG", "--reward", "1", "--max-supply", "10"];
  const off = deployFixture({ active: false });
  await assert.rejects(
    deployPowCommand({ args, idx: off.idx, esplora: off.esplora, lib, encode: off.encode, build: off.build, print: off.print }),
    /mining is not active on signet at block 1001 \(no activation height is set in this release\): the launch would be rejected as unknown op 9 and its fee spent; nothing was broadcast/,
  );
  const taken = deployFixture({ tickers: ["DIG"] });
  await assert.rejects(deployPowCommand({ args, idx: taken.idx, esplora: taken.esplora, lib, encode: taken.encode, build: taken.build, print: taken.print }), /ticker DIG is taken/);
  const late = deployFixture();
  await assert.rejects(
    deployPowCommand({ args: [...args, "--end", "1000"], idx: late.idx, esplora: late.esplora, lib, encode: late.encode, build: late.build, print: late.print }),
    /--end 1000 is before mining can start \(block 1001 if the launch lands in block 1001\)/,
  );
  for (const f of [off, taken, late]) {
    assert.deepEqual(f.calls.build, [], "nothing built");
    assert.deepEqual(f.calls.broadcast, [], "nothing broadcast");
  }
  const edge = deployFixture();
  await deployPowCommand({ args: [...args, "--end", "1001"], idx: edge.idx, esplora: edge.esplora, lib, encode: edge.encode, build: edge.build, print: edge.print });
  assert.ok(edge.out.includes("  the launch must land by block 1001, or it is rejected (end before mining start) and its fee is spent"));
  // A checkout without the mining envelope refuses instead of building something else.
  await assert.rejects(deployPowCommand({ args, idx: edge.idx, esplora: edge.esplora, lib, encode: null, build: edge.build, print: quiet }), /no encodeDeployPow/);
});

test("deploy-pow builds the DEPLOY_POW envelope of the real encoder, and it decodes to the same terms", { skip: !(HAS_MINE && HAS_DEPLOY_POW) && "core track (src/mine.mjs, encodeDeployPow) not in this checkout yet" }, async () => {
  const lib = await import("../src/mine.mjs");
  const f = deployFixture();
  const r = await deployPowCommand({
    args: ["--ticker", "DIG", "--reward", "1000", "--max-supply", "21000000", "--halving", "52560", "--start-after", "999", "--end", "9000"], idx: f.idx, esplora: f.esplora, lib, build: f.build, print: quiet,
  });
  assert.equal(r.envelope.length, 66 + 3, "66 + ticker bytes, no treasury");
  assert.equal(r.terms.startHeight, 2000, "--start-after 999 at tip 1000");
  assert.equal(r.mineStart, 2000);
  assert.deepEqual(r.envelope, envelopeLib.encodeDeployPow(r.terms));
  const env = envelopeLib.decodeEnvelope(r.envelope);
  assert.equal(env.op, envelopeLib.OP.DEPLOY_POW);
  for (const k of ["ticker", "divisibility", "reward", "maxSupply", "halvingInterval", "span", "targetPerSpan", "initialDifficulty", "minDifficulty", "claimFeeSats", "startHeight", "endHeight"]) {
    assert.equal(String(env[k]), String(r.terms[k]), k);
  }
  assert.equal(r.terms.initialDifficulty, lib.suggestInitialDifficulty({ hashrate: lib.LAUNCH_DEFAULTS.launchHashrate, span: 24, targetPerSpan: 24 }));
  assert.equal(r.terms.minDifficulty, lib.suggestFloor(r.terms.initialDifficulty));
  assert.throws(() => deployPowTerms(["--ticker", "DIG", "--reward", "1", "--max-supply", "1", "--claim-fee", "600"], { lib }), /deployer claim fee not allowed/);
});

/* ------------------------------------------------------------------ the fake chain */

const hashOf = (h) => hex(sha(`block ${h}`));
const coin = (value, i = 0) => ({ txid: randomBytes(32).toString("hex"), vout: i, value, status: { confirmed: true } });

/**
 * A chain, an indexer view of it, a Bitcoin backend, a wallet and a worker pool, all fake, around one
 * mined token DIG. Claims broadcast (self-pay) or carried by the relayer land in the next block the
 * fake indexer applies. `onGrind(call)` runs before each slice (it may move the tip).
 */
function fakeChain({ tip = 1000, reward = 50n, maxSupply = 10_000n, issued = 0n, mineStart = 990, findOn = 2, lib = stubLib(), onGrind = () => {}, pendingClaims = null } = {}) {
  const asset = {
    id: (846n << 32n) | 3n, kind: "pow", ticker: "DIG", reward, maxSupply, issued, claims: 0, mineStart, deployHeight: 846, startHeight: 0, endHeight: 0, claimsByHeight: [],
    span: 24, targetPerSpan: 24, minDifficulty: 256n, initialDifficulty: 256n, halvingInterval: 0, dPts: [[mineStart, 256n]],
  };
  const events = [];
  const chain = { tip, mempool: [] };
  const byTxid = new Map(); // carrier txid -> the claim's draft and nonce (from the local check)
  const idx = {
    height: tip, hashes: new Map(), assets: new Map([[asset.id, asset]]), tickers: new Map([["DIG", asset.id]]), claimed: new Set(), nullifiers: new Set(), log: [], outputs: [],
    miningHeight: 900,
    miningActive: (h) => h >= 900,
    checks: [],
    async checkMine(env, tx, H) {
      idx.checks.push({ env, tx, H });
      byTxid.set(tx.txid, env);
      return true;
    },
    mineStatic: (env, H) => (idx.checks.push({ env, H, part: "static" }), true),
    mineState: () => true,
    minePow: async () => true,
    mineProof: async () => true,
  };
  for (let h = tip - 30; h <= tip; h++) idx.hashes.set(h, hashOf(h));
  const land = (h) => {
    for (const c of chain.mempool) {
      idx.log.push({ txid: c.txid, ok: true, height: h, op: c.op, ticker: "DIG", amount: String(asset.reward) });
      idx.claimed.add(c.solutionId);
      asset.issued += asset.reward;
      asset.claims += 1;
      for (const n of c.spends ?? []) idx.nullifiers.add(n);
    }
    chain.mempool = [];
  };
  const resync = async () => {
    events.push(`resync ${chain.tip}`);
    while (idx.height < chain.tip) {
      idx.height += 1;
      idx.hashes.set(idx.height, hashOf(idx.height));
      land(idx.height);
    }
  };

  const mineKey = randomBytes(32);
  const account = btcAccount(mineKey);
  let utxos = [coin(40_000, 0), coin(9_000, 1)];
  const esplora = {
    broadcasts: [],
    fees: [],
    tipHeight: async () => chain.tip,
    blockHash: async (h) => hashOf(h),
    utxos: async (address) => (address === account.address ? utxos.map((u) => ({ ...u })) : []),
    feeRate: async () => 2,
    async broadcast(txHex) {
      events.push("broadcast");
      const tx = btc.Transaction.fromRaw(unhex(txHex), { allowUnknownOutputs: true });
      esplora.broadcasts.push(tx);
      const spent = new Set(Array.from({ length: tx.inputsLength }, (_, i) => `${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`));
      const paid = utxos.filter((u) => spent.has(`${u.txid}:${u.vout}`)).reduce((t, u) => t + BigInt(u.value), 0n);
      esplora.fees.push(Number(paid - Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i).amount).reduce((t, a) => t + a, 0n)));
      utxos = utxos.filter((u) => !spent.has(`${u.txid}:${u.vout}`));
      for (let i = 0; i < tx.outputsLength; i++) {
        const o = tx.getOutput(i);
        if (hex(o.script) === hex(account.script)) utxos.push({ txid: tx.id, vout: i, value: Number(o.amount), status: { confirmed: false } });
      }
      const env = byTxid.get(tx.id);
      chain.mempool.push({ txid: tx.id, solutionId: env.solutionId, spends: env.spends, op: 7 });
      return tx.id;
    },
  };

  let drafts = 0;
  const wallet = {
    locked: new Set(),
    notes: [],
    drafts: [],
    finals: [],
    scans: 0,
    scan() {
      wallet.scans += 1;
      return wallet;
    },
    prepareClaim(view, { asset: id, reward: r, refHeight, refHash }) {
      drafts += 1;
      const commitments = [BigInt(`0x${randomBytes(31).toString("hex")}`), BigInt(`0x${randomBytes(31).toString("hex")}`)];
      const nullifiers = [BigInt(`0x${randomBytes(31).toString("hex")}`), BigInt(`0x${randomBytes(31).toString("hex")}`)];
      const rolled = wallet.roll ? [String(nullifiers[0])] : [];
      const draft = {
        id: drafts, asset: id, reward: r, refHeight, refHash, rolled, rolledAmount: 0n, nullifiers, commitments, ciphertexts: [new Uint8Array(95), new Uint8Array(95)],
        challenge: lib.challengeOf({ asset: id, refHeight, refHash, reward: r, commitments }),
      };
      wallet.drafts.push(draft);
      events.push(`draft ${refHeight}`);
      return draft;
    },
    async finalizeClaim(draft, bind, nonce) {
      wallet.finals.push({ draft: draft.id, bind, nonce: hex(nonce) });
      const envelope = new Uint8Array(bind.bindOutpoint ? 515 : 511);
      envelope.set(te.encode(`mine ${draft.id}`));
      byDraft.set(hex(envelope), { draft, nonce, bind });
      return envelope;
    },
    lockClaim(draft) {
      draft.rolled.forEach((n) => wallet.locked.add(n));
    },
  };
  const byDraft = new Map();
  const decode = (envelope) => {
    const { draft, nonce, bind } = byDraft.get(hex(envelope));
    return { op: bind.bindOutpoint ? 7 : 8, draft, nonce, bind, spends: draft.rolled, solutionId: hex(lib.solutionIdOf(draft.challenge, nonce)) };
  };

  const perChallenge = new Map();
  const pool = {
    size: 2,
    calls: [],
    async grind({ challenge, target, nonceStart, count }) {
      const key = hex(challenge);
      pool.calls.push({ challenge: key, target, nonceStart, count });
      await onGrind(pool.calls.length, { chain, pool, key });
      const n = (perChallenge.get(key) ?? 0) + 1;
      perChallenge.set(key, n);
      if (n !== findOn) return { nonce: null, powHash: null, tried: count };
      const nonce = new Uint8Array(8);
      new DataView(nonce.buffer).setBigUint64(0, BigInt(nonceStart), true);
      return { nonce, powHash: (pool.wrong ? (b) => sha(b) : lib.powHashReference)(lib.passwordOf(challenge, nonce)), tried: 7 };
    },
  };
  const file = { seed: randomBytes(32).toString("hex"), btcKey: randomBytes(32).toString("hex"), mineKey: hex(mineKey), pending: [] };
  const save = () => events.push(`save ${file.pending.length}`);
  const relay = pendingClaims === null ? null : { client: { mineAsset: async () => ({ pendingClaims }) }, url: "http://relay.test" };
  return { lib, asset, chain, idx, resync, esplora, wallet, pool, file, save, mineKey, account, events, decode, relay };
}

const run = (fx, opts = {}) => {
  const out = [];
  const p = runMiner({
    idx: fx.idx, wallet: fx.wallet, file: fx.file, save: fx.save, name: "erin", ticker: "dig", lib: fx.lib, pool: fx.pool, esplora: fx.esplora, resync: fx.resync,
    mineKey: fx.mineKey, decode: fx.decode, relay: fx.relay, print: (s) => out.push(s), warn: (s) => out.push(`warn: ${s}`), pollMs: 0, statsMs: 1e9, slice: 64,
    sleep: async () => {}, ...opts,
  });
  return p.then((r) => ({ ...r, out }));
};

/* ------------------------------------------------------------------ mine: self-pay, end to end */

test("mine --pay key against a fake chain: a new challenge per tip and per solution, the carrier, W-M before broadcast, landing", async () => {
  // Slice 1 (challenge of block 1000) moves the tip to 1001; slice 4 (the third challenge) moves it to 1002.
  const fx = fakeChain({ onGrind: (n, { chain }) => void ((n === 1 || n === 4) && (chain.tip += 1)) });
  fx.pool.size = 1;
  const r = await run(fx, { maxClaims: 2, threads: 1 });
  assert.equal(r.status, "done", r.out.join("\n"));
  assert.deepEqual([r.solutions, r.sent, r.landed], [2, 2, 1]);

  // Four drafts: block 1000 (dropped at the new tip), 1001 (solved), 1001 again (dropped at the next tip), 1002 (solved).
  assert.deepEqual(fx.wallet.drafts.map((d) => d.refHeight), [1000, 1001, 1001, 1002]);
  const challenges = fx.wallet.drafts.map((d) => hex(d.challenge));
  assert.equal(new Set(challenges).size, 4, "every draft has its own challenge");
  assert.deepEqual([...new Set(fx.pool.calls.map((c) => c.challenge))], challenges, "the workers always grind the newest draft");
  const all = fx.wallet.drafts.flatMap((d) => [...d.commitments, ...d.nullifiers].map(String));
  assert.equal(new Set(all).size, all.length, "no two drafts share a commitment or a nullifier");
  assert.ok(fx.pool.calls.every((c) => c.count === 64 && typeof c.nonceStart === "bigint" && typeof c.target === "bigint"));
  assert.notEqual(fx.pool.calls[0].nonceStart, fx.pool.calls[1].nonceStart, "random nonce starts");

  // The carriers: bound to the coin chosen after the solution, OP_RETURN first, the platform fee, RBF, change to the mining key.
  assert.equal(fx.esplora.broadcasts.length, 2);
  const [tx] = fx.esplora.broadcasts;
  const fin = fx.wallet.finals[0];
  assert.ok(fin.bind.bindOutpoint, "self-pay binds an outpoint (MINE)");
  const first = tx.getInput(0);
  assert.equal(hex(fin.bind.bindOutpoint), hex(concat(Uint8Array.from(first.txid).reverse(), Uint8Array.of(first.index, 0, 0, 0))), "first input is the bound coin");
  assert.equal(first.sequence, 0xfffffffd, "RBF signalled");
  assert.equal(tx.getOutput(0).script[0], 0x6a);
  // L5: the change takes a random slot after the OP_RETURN; the fee output is the other one.
  assert.equal(tx.outputsLength, 3);
  const changeAt = [1, 2].filter((v) => hex(tx.getOutput(v).script) === hex(fx.account.script));
  assert.equal(changeAt.length, 1, "change goes back to the mining key");
  assert.equal(hex(tx.getOutput(3 - changeAt[0]).script), FEE.platformScript);
  assert.equal(tx.getOutput(3 - changeAt[0]).amount, 500n);
  const btcFeeScript = hex(btcAccount(Buffer.from(fx.file.btcKey, "hex")).script);
  for (const t of fx.esplora.broadcasts) for (let i = 0; i < t.outputsLength; i++) assert.notEqual(hex(t.getOutput(i).script), btcFeeScript, "the BTC fee key never pays a claim");
  const fee = fx.esplora.fees[0];
  assert.ok(fee / tx.vsize > 2.9 && fee / tx.vsize < 3.2, `next-block rate 2 x 1.25 -> 3 sat/vB (${fee} sats for ${tx.vsize} vB)`);
  assert.equal(fx.idx.checks.filter((c) => !c.part).length, 2, "each claim passed the local indexer check");
  assert.equal(fx.idx.checks[0].H, 1002, "checked for the next block");

  // W-M: the entry is saved before its carrier leaves; the landed one is dropped, the other stays locked until ref + 12.
  const firstBroadcast = fx.events.indexOf("broadcast");
  assert.ok(fx.events.slice(0, firstBroadcast).some((e) => e === "save 1"), fx.events.join(", "));
  assert.equal(fx.file.pending.length, 1);
  const e = fx.file.pending[0];
  assert.equal(e.kind, "mine");
  assert.equal(e.via, "self");
  assert.equal(e.ref, 1002);
  assert.equal(e.lockUntil, 1014);
  assert.equal(e.reward, "50");
  assert.equal(e.ticker, "DIG");
  assert.equal(e.asset, String(fx.asset.id));
  assert.equal(e.txid, fx.esplora.broadcasts[1].id);
  assert.equal(e.solutionId, hex(fx.lib.solutionIdOf(fx.wallet.drafts[3].challenge, unhex(fx.wallet.finals[1].nonce))));
  assert.deepEqual(e.commitments, fx.wallet.drafts[3].commitments.map(String));
  assert.equal(e.status, "submitted");
  // The output: H/s line aside, solutions, landing and the totals; the route copy before any work.
  const text = r.out.join("\n");
  assert.ok(text.includes(`landed: 50 DIG in block 1002 (${fx.esplora.broadcasts[0].id})`), text);
  assert.ok(text.includes(`claim broadcast: ${fx.esplora.broadcasts[0].id}`));
  assert.match(text, /\(684 vB, fee [\d,]+ sats \+ service fee 500 sats\)/);
  assert.match(text, /mined 2 solutions, sent 2 claims, 1 landed; fees spent \d[\d,]* sats/);
  for (const s of [MINE_COPY.key, MINE_COPY.fee(FEE), MINE_COPY.hardware, MINE_COPY.censor, MINE_COPY.window, MINE_COPY.bump, MINE_COPY.testCoins]) assert.ok(text.includes(s), s);
  assert.ok(r.out.indexOf(MINE_COPY.key) < r.out.findIndex((l) => l.startsWith("block 1000")), "disclosed before mining");
  assert.ok(!text.includes("relay"), "the self-pay route never mentions or calls a relayer");
  const spent = fx.esplora.fees.reduce((s, x) => s + x + 500, 0);
  assert.equal(r.feesSats, spent, "fees spent = Bitcoin fees + service fees");
});

test("mine prints its hashrate, rolls notes under W-M, and stops on Ctrl+C after the current slice", async () => {
  const ac = new AbortController();
  let t = 0;
  const fx = fakeChain({ findOn: 1, onGrind: () => void (t += 1000) });
  fx.wallet.roll = true;
  const r = await run(fx, { maxClaims: 1, threads: 2, statsMs: 500, now: () => t, signal: ac.signal });
  assert.equal(r.sent, 1);
  assert.ok(r.out.some((l) => /^\d[\d,]* H\/s {2}solutions \d+ {2}claims sent \d+ {2}landed \d+ {2}fees spent \d[\d,]* sats$/.test(l)), r.out.join("\n"));
  assert.equal(r.hashes, 7 + 64, "two threads: the slice that found it (7 tries) and a full slice");
  const rolled = fx.wallet.drafts[0].rolled;
  assert.equal(rolled.length, 1);
  assert.deepEqual(fx.file.pending[0].spends, rolled);
  assert.ok(fx.wallet.locked.has(rolled[0]), "rolled notes stay locked while the claim is pending");

  const stop = fakeChain({ findOn: 99, onGrind: (n) => void (n === 3 && ac.abort()) });
  const s = await run(stop, { signal: ac.signal, threads: 1 });
  assert.equal(s.status, "stopped");
  assert.equal(stop.pool.calls.length, 3);
  assert.equal(stop.esplora.broadcasts.length, 0);
});

test("mine refuses before paying when the claim cannot land: cap with claims in flight, a stale bound, a reorged reference, a disagreeing fast path", async () => {
  // The cap, counting the relayer's in-flight claims (pendingClaims), checked after the solution and before any proof.
  const ac = new AbortController();
  const cap = fakeChain({ issued: 9_900n, pendingClaims: 2, onGrind: (n) => void (n === 3 && ac.abort()) });
  const r1 = await run(cap, { signal: ac.signal, threads: 1 });
  assert.ok(r1.out.includes("solution not paid: the supply cap would be reached, counting 2 claims already on the way"), r1.out.join("\n"));
  assert.deepEqual([cap.wallet.finals.length, cap.esplora.broadcasts.length, cap.file.pending.length], [0, 0, 0], "nothing proved, paid or locked");

  // Difficulty jumped past the stale bound between the reference and the next block.
  const ac2 = new AbortController();
  const lib = stubLib({ meetsTarget: () => false });
  const stale = fakeChain({ lib, onGrind: (n) => void (n === 3 && ac2.abort()) });
  const r2 = await run(stale, { signal: ac2.signal, threads: 1 });
  assert.ok(r2.out.some((l) => l.startsWith(`solution not paid: ${MINE_COPY.surge}`)), r2.out.join("\n"));
  assert.equal(stale.esplora.broadcasts.length, 0);

  // The miner's own backend reports another hash for the reference block.
  const ac3 = new AbortController();
  const reorg = fakeChain({ onGrind: (n) => void (n === 3 && ac3.abort()) });
  reorg.esplora.blockHash = async () => "ff".repeat(32);
  const r3 = await run(reorg, { signal: ac3.signal, threads: 1 });
  assert.ok(r3.out.some((l) => /block 1000 has another hash at the Bitcoin backend/.test(l)));
  assert.equal(reorg.esplora.broadcasts.length, 0);

  // The fast path disagrees with the reference: it is disabled and mining stops, nothing paid.
  const wrong = fakeChain();
  wrong.pool.wrong = true;
  const r4 = await run(wrong, { threads: 1 });
  assert.equal(r4.status, "error");
  assert.match(r4.reason, /fast Argon2 path disagreed with the reference/);
  assert.ok(wrong.lib.disabled);
  assert.deepEqual([wrong.wallet.finals.length, wrong.esplora.broadcasts.length], [0, 0]);

  // A fee rate above --max-fee-rate is not paid.
  const ac5 = new AbortController();
  const dear = fakeChain({ onGrind: (n) => void (n === 3 && ac5.abort()) });
  dear.esplora.feeRate = async () => 40;
  const r5 = await run(dear, { signal: ac5.signal, threads: 1, maxFeeRate: 20 });
  assert.ok(r5.out.includes("solution not paid: the claim fee rate would be 50 sat/vB, above --max-fee-rate 20"));
  assert.equal(dear.esplora.broadcasts.length, 0);

  // The local indexer check fails: nothing written, nothing paid.
  const ac6 = new AbortController();
  const bad = fakeChain({ onGrind: (n) => void (n === 3 && ac6.abort()) });
  bad.idx.checkMine = async () => "underpaid service fee: 0 < 500 sats to 5120…";
  const r6 = await run(bad, { signal: ac6.signal, threads: 1 });
  assert.ok(r6.out.includes("solution not paid: the claim fails the local check (underpaid service fee: 0 < 500 sats to 5120…)"));
  assert.deepEqual([bad.esplora.broadcasts.length, bad.file.pending.length], [0, 0]);
});

test("mine refuses before any work: a paid-mint token, mining not active, no coins at the mining key, a mined-out token", async () => {
  const fx = fakeChain();
  fx.asset.kind = "mint";
  await assert.rejects(run(fx), /DIG is not a mined token; mint it with: murkle mint erin DIG/);
  const off = fakeChain();
  off.idx.miningActive = () => false;
  off.idx.miningHeight = null;
  await assert.rejects(run(off), /mining is not active on signet at block 1001 \(no activation height is set in this release\); nothing was mined/);
  const broke = fakeChain();
  broke.esplora.utxos = async () => [];
  const r = await run(broke);
  assert.equal(r.status, "error");
  assert.match(r.reason, /no coins at the mining fee address tb1p\w+; fund it with signet coins/);
  const done = fakeChain({ issued: 9_990n });
  const d = await run(done);
  assert.equal(d.status, "ended");
  for (const f of [off, broke, done]) assert.equal(f.pool.calls.length, 0, "no hashing");
});

const HAS_POOL = existsSync(new URL("../src/pow-pool.mjs", import.meta.url));

test("mine with the real src/mine.mjs and a real worker pool: real Argon2id at difficulty 256, re-checked by the reference, paid once", { skip: !(HAS_MINE && HAS_POOL) && "core track (src/mine.mjs, src/pow-pool.mjs) not in this checkout yet", timeout: 120_000 }, async () => {
  const lib = await import("../src/mine.mjs");
  const { createNodePowPool } = await import("../src/pow-pool.mjs");
  const fx = fakeChain({ lib });
  const pool = await createNodePowPool({ size: 1 });
  try {
    const ready = await pool.ready();
    assert.ok(ready.impl === "hash-wasm" || ready.impl === "noble", ready.impl);
    const r = await run({ ...fx, pool }, { maxClaims: 1, slice: 128, threads: 1 });
    assert.equal(r.status, "done", r.out.join("\n"));
    assert.deepEqual([r.solutions, r.sent], [1, 1]);
    assert.ok(r.hashes >= 1);
    const [fin] = fx.wallet.finals;
    const draft = fx.wallet.drafts.find((d) => d.id === fin.draft);
    // The paid solution meets the target with the reference implementation, against the challenge of its own block.
    assert.equal(hex(draft.challenge), hex(lib.challengeOf({ asset: fx.asset.id, refHeight: draft.refHeight, refHash: hashOf(draft.refHeight), reward: 50n, commitments: draft.commitments })));
    const h = lib.powHashReference(lib.passwordOf(draft.challenge, unhex(fin.nonce)));
    assert.ok(lib.meetsTarget(h, lib.targetOf(lib.effectiveDifficulty(fx.asset, draft.refHeight, draft.refHeight + 1))));
    assert.equal(fx.file.pending[0].solutionId, hex(lib.solutionIdOf(draft.challenge, unhex(fin.nonce))));
    const tx = fx.esplora.broadcasts[0];
    const feeOuts = Array.from({ length: tx.outputsLength }, (_, v) => tx.getOutput(v)).slice(1).filter((o) => hex(o.script) === FEE.platformScript);
    assert.equal(feeOuts.length, 1, "the fee outputs of the real requiredFeeOutputs");
    assert.equal(feeOuts[0].amount, 500n);
  } finally {
    await pool.close();
  }
});

/* ------------------------------------------------------------------ mine: relay */

function relayFixture(fx, { balance = 50_000, enabled = true, answers = [] } = {}) {
  const pool = randomBytes(32);
  const poolKey = hex(btcAccount(pool).pub);
  const account = relayLib.relayAccount(new Uint8Array(Buffer.from(fx.file.seed, "hex")), "signet");
  const C = btcAccount(randomBytes(32)).script;
  const bind1 = hex(sha256(C));
  const bind2 = hex(sha256(btcAccount(randomBytes(32)).script));
  const submits = [];
  const statuses = new Map();
  const mine = { enabled, code: enabled ? null : "mine_disabled", bindScriptHash: bind1, modes: ["fast", "block"], slack: 2, estVsize: 684, feeRate: 2, carrierFeeSats: 1368, marginSats: 137, invalidPowSats: 20 };
  const info = { enabled: true, mode: "balance", network: "signet", height: fx.chain.tip, balance: { poolKey }, mine };
  const client = {
    info: async () => ({ ...info, mine: { ...mine } }),
    async account(body) {
      assert.equal(relayLib.verifyRequest({ endpoint: relayLib.RELAY_ENDPOINTS.account, network: "signet", poolKey, body }).ok, true);
      return { status: 200, body: { balance, reserved: 0, nextIndex: 0, depositAddress: relayLib.depositAddress(relayLib.parsePoolKey(poolKey), account.id, 0, "signet").address } };
    },
    async submit(body) {
      const v = relayLib.verifyRequest({ endpoint: relayLib.RELAY_ENDPOINTS.submit, network: "signet", poolKey, body });
      submits.push({ body, ok: v.ok });
      const a = answers.shift() ?? { status: 202 };
      if (a.status === 409 && a.code === "bind_stale") {
        mine.bindScriptHash = bind2;
        return { status: 409, body: { error: { code: "bind_stale", message: "changed" }, bindScriptHash: bind2 } };
      }
      if (a.status !== 202) return { status: a.status, body: { error: { code: a.code, message: a.message ?? a.code } } };
      const id = randomBytes(16).toString("hex");
      statuses.set(id, { status: "queued" });
      return { status: 202, body: { id, status: "queued", kind: "mine", ref: 1000, lastBroadcast: 1009, deadline: 1012, reservedSats: 2005, serviceSats: "500", balance: balance - 2005 } };
    },
    status: async (id) => statuses.get(id) ?? null,
    mineAsset: async () => ({ pendingClaims: 0 }),
  };
  return { relay: { client, url: "http://relay.test", lib: relayLib, account }, submits, statuses, bind1, bind2, poolKey };
}

test("mine --pay relay: a signed MINE_SCRIPT submit bound to the relayer, bind_stale re-proved with the same nonce, landing by status, no self-pay", async () => {
  const fx = fakeChain({ onGrind: (n, { chain }) => void (n === 3 && (chain.tip += 1)) });
  const rf = relayFixture(fx, { answers: [{ status: 409, code: "bind_stale" }, { status: 202 }, { status: 202 }] });
  fx.esplora.broadcast = async () => assert.fail("a relayed claim is never paid from the mining key");
  fx.idx.checkMine = async () => assert.fail("the relayer builds the carrier");
  const statusOf = rf.relay.client.status;
  rf.relay.client.status = async (id) => {
    const st = await statusOf(id);
    return st && { status: "accepted", height: 1001, txid: "ee".repeat(32), cost: 2005 };
  };
  const r = await run(fx, { pay: "relay", relay: rf.relay, mineKey: null, maxClaims: 2, threads: 1 });
  assert.equal(r.status, "done", r.out.join("\n"));
  assert.deepEqual([r.solutions, r.sent, r.landed, r.feesSats], [2, 2, 1, 2005]);
  // First solution: proved for bind1, refused bind_stale, proved again for bind2 with the same nonce.
  assert.equal(rf.submits.length, 3);
  assert.ok(rf.submits.every((s) => s.ok), "every submit is a request the relayer's verifyRequest accepts");
  assert.ok(rf.submits.every((s) => s.body.mode === "fast"), "a claim goes out at once");
  const [f1, f2, f3] = fx.wallet.finals;
  assert.equal(hex(f1.bind.bindScriptHash), rf.bind1);
  assert.equal(hex(f2.bind.bindScriptHash), rf.bind2);
  assert.equal(f1.nonce, f2.nonce, "same solution, same nonce");
  assert.equal(f1.draft, f2.draft);
  assert.notEqual(f3.draft, f1.draft, "the next solution has its own draft");
  const fake = new Uint8Array(511);
  fake.set(te.encode(`mine ${f2.draft}`));
  assert.equal(rf.submits[1].body.envelope, hex(fake), "the envelope proved for the new bind is the one handed over");
  // W-M entries: via relay, with the relay id; the landed one is reported and dropped once its solution is claimed.
  const text = r.out.join("\n");
  assert.ok(text.includes(MINE_COPY.relay("DIG", 50n)), "the relay route's own copy");
  assert.ok(!/cannot see amounts, tokens/.test(text), "never the transfer copy");
  assert.ok(!text.includes(MINE_COPY.key));
  assert.ok(text.includes("about 2,005 sats of relay balance per claim (Bitcoin fee 1,368 + service fee + margin 137)"), text);
  assert.ok(text.includes(`landed: 50 DIG in block 1001 (carrier ${"ee".repeat(32)}, charged 2,005 sats)`), text);
  const entries = [...fx.file.pending];
  assert.ok(entries.every((p) => p.kind === "mine" && p.via === "relay" && typeof p.relayId === "string" && p.relay === "http://relay.test"));
});

test("mine --pay relay refuses before mining on a short balance or a relayer that takes no claims, and never falls back to self-pay", async () => {
  const low = fakeChain();
  const rl = relayFixture(low, { balance: 1000 });
  const r1 = await run(low, { pay: "relay", relay: rl.relay, mineKey: null });
  assert.equal(r1.status, "error");
  assert.match(r1.reason, /relay balance 1,000 sats; a claim needs about 2,005\. Nothing was paid\. Top up: murkle relay topup erin/);
  assert.equal(low.pool.calls.length, 0, "no hashing for a claim that cannot be paid");

  const off = fakeChain();
  const ro = relayFixture(off, { enabled: false });
  const r2 = await run(off, { pay: "relay", relay: ro.relay, mineKey: null });
  assert.match(r2.reason, /not taking mining claims right now \(mine_disabled\); a relayed claim is never paid from your own key/);
  assert.equal(off.pool.calls.length, 0);

  // Refused after the hand-out: the entry stays locked (W-M), mining stops, and nothing is paid from the mining key.
  const late = fakeChain();
  const rr = relayFixture(late, { answers: [{ status: 503, code: "mine_disabled", message: "The relayer is not taking mining claims right now. Pay the fee yourself." }] });
  late.esplora.broadcast = async () => assert.fail("no self-pay fallback");
  const r3 = await run(late, { pay: "relay", relay: rr.relay, mineKey: null, threads: 1 });
  assert.equal(r3.status, "error");
  assert.ok(r3.out.some((l) => l.startsWith("relay refused: mine_disabled") && l.endsWith("is never paid from your own key")), r3.out.join("\n"));
  assert.equal(late.file.pending.length, 1);
  assert.deepEqual([late.file.pending[0].status, late.file.pending[0].error, late.file.pending[0].lockUntil], ["failed", "mine_disabled", 1012]);

  // A refusal about this solution only (stale work) keeps mining.
  const ac = new AbortController();
  const one = fakeChain({ onGrind: (n) => void (n === 3 && ac.abort()) });
  const rs = relayFixture(one, { answers: [{ status: 422, code: "stale_work" }] });
  const r4 = await run(one, { pay: "relay", relay: rs.relay, mineKey: null, threads: 1, signal: ac.signal });
  assert.equal(r4.status, "stopped");
  assert.equal(one.pool.calls.length, 3, "kept hashing after the refusal");
});

/* ------------------------------------------------------------------ claimRefusal */

test("claimRefusal: the window with the relayer's slack, reward, claimed, rolled notes, stale bound, cap with claims in flight", () => {
  const lib = stubLib();
  const asset = { id: 5n, kind: "pow", reward: 10n, maxSupply: 100n, issued: 50n, mineStart: 990 };
  const draft = { refHeight: 1000, reward: 10n, rolled: ["7"] };
  const idx = { claimed: new Set(), nullifiers: new Set() };
  const base = { lib, idx, asset, draft, powHash: new Uint8Array(32), solutionIdHex: "aa", inflight: 0 };
  assert.equal(claimRefusal({ ...base, tip: 1000 }), null);
  assert.equal(claimRefusal({ ...base, tip: 1009 }), null, "ref + 9 is the last tip a claim is paid at");
  assert.match(claimRefusal({ ...base, tip: 1010 }), /reference block 1000 is too old to pay for now \(tip 1010, last safe tip 1009\)\. A claim must land within 12 blocks/);
  assert.match(claimRefusal({ ...base, draft: { ...draft, refHeight: 980 }, tip: 985 }), /mining had not started/);
  assert.match(claimRefusal({ ...base, draft: { ...draft, reward: 9n }, tip: 1000 }), /reward differs/);
  assert.match(claimRefusal({ ...base, idx: { ...idx, claimed: new Set(["aa"]) }, tip: 1000 }), /already claimed/);
  assert.match(claimRefusal({ ...base, idx: { ...idx, nullifiers: new Set(["7"]) }, tip: 1000 }), /rolled into this claim was spent/);
  const seen = [];
  const strict = stubLib({ effectiveDifficulty: (a, ref, h) => (seen.push([ref, h]), 5000n), meetsTarget: () => false });
  assert.match(claimRefusal({ ...base, lib: strict, tip: 1003 }), /^Difficulty jumped\. .* \(difficulty for the next block: 5000\)$/);
  assert.deepEqual(seen, [[1000, 1004]], "the stale bound is taken at the next block");
  assert.equal(claimRefusal({ ...base, inflight: 4, tip: 1000 }), null, "50 + 10 x 5 = 100: still fits");
  assert.match(claimRefusal({ ...base, inflight: 5, tip: 1000 }), /supply cap would be reached, counting 5 claims already on the way/);
  assert.match(claimRefusal({ ...base, asset: { ...asset, issued: 95n }, tip: 1000 }), /supply is mined out/);
  assert.match(claimRefusal({ ...base, lib: stubLib({ mineStatus: () => "mining-ended" }), tip: 1000 }), /mining has ended/);
});

/* ------------------------------------------------------------------ --prepare-coins, the mining key, flags */

test("mine --prepare-coins splits the mining key's coins into coins that each pay one claim", async () => {
  const lib = stubLib();
  const fx = fakeChain();
  const seen = [];
  const fundingLib = {
    mineCarrierVsize: (o) => (seen.push(["vsize", o]), 684),
    planSplitTx(args) {
      seen.push(["split", args]);
      return funding.planPayment({ account: args.account, utxos: args.utxos, to: args.account.script, amount: args.value, feeRate: args.feeRate });
    },
  };
  const out = [];
  const broadcast = [];
  const esplora = { ...fx.esplora, broadcast: async (h) => (broadcast.push(h), "12".repeat(32)) };
  const r = await prepareCoinsCommand({ n: 5, asset: fx.asset, lib, mineKey: fx.mineKey, esplora, fundingLib, print: (s) => out.push(s) });
  const split = seen.find(([k]) => k === "split")[1];
  assert.deepEqual(seen[0], ["vsize", { feeOutputs: 1, change: true }]);
  assert.equal(split.n, 5);
  assert.equal(split.value, BigInt(684 * 3) + 500n + 330n, "carrier at 2 x 1.25 -> 3 sat/vB, the service fee, change");
  assert.equal(split.feeRate, 2);
  assert.equal(split.account.address, fx.account.address, "the mining key, never the BTC fee key");
  assert.equal(split.utxos.length, 2);
  assert.equal(broadcast.length, 1);
  assert.equal(r.txid, "12".repeat(32));
  assert.ok(out[0].includes(`mining fee address ${fx.account.address}: 5 coins of 2,882 sats`));
  // With --max-fee-rate the coins are sized for that rate.
  seen.length = 0;
  await prepareCoinsCommand({ n: 2, asset: fx.asset, lib, mineKey: fx.mineKey, esplora, fundingLib, maxFeeRate: 10, print: quiet });
  assert.equal(seen.find(([k]) => k === "split")[1].value, 6840n + 830n);
  await assert.rejects(prepareCoinsCommand({ n: 2, asset: fx.asset, lib, mineKey: fx.mineKey, esplora, fundingLib: {}, print: quiet }), /no planSplitTx/);
  // With the client track's planSplitTx and mineCarrierVsize: n coins of that value to the mining key, plus change.
  if (typeof funding.planSplitTx === "function" && typeof funding.mineCarrierVsize === "function") {
    broadcast.length = 0;
    const real = await prepareCoinsCommand({ n: 4, asset: fx.asset, lib, mineKey: fx.mineKey, esplora, print: quiet });
    const tx = btc.Transaction.fromRaw(unhex(broadcast[0]), { allowUnknownOutputs: true });
    const outs = Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i));
    assert.ok(outs.every((o) => hex(o.script) === hex(fx.account.script)), "every output pays the mining key itself");
    assert.equal(outs.filter((o) => o.amount === real.value).length, 4);
    assert.equal(real.value, BigInt(Math.ceil(funding.mineCarrierVsize({ feeOutputs: 1, change: true }) * 3)) + 500n + 330n);
  }
});

test("the mining key: created once in the wallet file, 32 bytes, never the BTC fee key", () => {
  const file = { seed: "11".repeat(32), btcKey: "22".repeat(32), pending: [] };
  let saves = 0;
  const k = mineKeyOf(file, () => saves++);
  assert.equal(saves, 1);
  assert.match(file.mineKey, /^[0-9a-f]{64}$/);
  assert.notEqual(file.mineKey, file.btcKey);
  assert.equal(hex(k), file.mineKey);
  assert.equal(hex(mineKeyOf(file, () => saves++)), file.mineKey);
  assert.equal(saves, 1, "kept, not replaced");
  assert.throws(() => mineKeyOf({ btcKey: "22".repeat(32), mineKey: "22".repeat(32) }), /equals its BTC fee key/);
  assert.throws(() => mineKeyOf({ btcKey: "22".repeat(32), mineKey: "zz" }), /not 32 bytes/);
});

test("mine flags, strictly: defaults, routes, relayer URLs, --prepare-coins only with the mining key", () => {
  const none = () => undefined;
  assert.deepEqual(parseMineArgs(["erin", "dig"], { read: none }), {
    name: "erin", ticker: "DIG", pay: "key", threads: null, maxClaims: null, maxFeeRate: null, prepareCoins: null, esplora: null, relay: null, linkable: false,
  });
  const r = parseMineArgs(["erin", "DIG", "--pay", "relay", "--threads", "3", "--max-claims", "4", "--max-fee-rate=9"], { read: none });
  assert.deepEqual([r.pay, r.threads, r.maxClaims, r.maxFeeRate, r.relay], ["relay", 3, 4, 9, "http://localhost:8787"]);
  assert.equal(parseMineArgs(["erin", "DIG", "--pay", "relay"], { read: (n) => (n === "RELAY_URL" ? "https://relay.example.org/" : undefined) }).relay, "https://relay.example.org");
  assert.equal(parseMineArgs(["erin", "DIG", "--relay", "https://r.example"], { read: none }).relay, "https://r.example", "read for claims in flight");
  // L1: --linkable consents to relayed claims while the pool is thin; only with --pay relay.
  assert.equal(parseMineArgs(["erin", "DIG", "--pay", "relay", "--linkable"], { read: none }).linkable, true);
  assert.throws(() => parseMineArgs(["erin", "DIG", "--linkable"], { read: none }), /--linkable goes with --pay relay/);
  assert.equal(parseMineArgs(["erin", "DIG", "--esplora", "https://mempool.space/signet/api/"], { read: none }).esplora, "https://mempool.space/signet/api");
  assert.equal(parseMineArgs(["erin", "DIG", "--prepare-coins", "8"], { read: none }).prepareCoins, 8);
  const bad = [
    [["erin"], /usage: murkle mine/],
    [["--pay", "key"], /usage: murkle mine/],
    [["erin", "DIG", "--pay", "unisat"], /--pay takes key or relay/],
    [["erin", "DIG", "--threads", "0"], /--threads must be a whole number above 0/],
    [["erin", "DIG", "--max-claims", "1.5"], /whole number/],
    [["erin", "DIG", "--turbo"], /unknown flag --turbo/],
    [["erin", "DIG", "--pay", "relay", "--prepare-coins", "3"], /does not go with --pay relay/],
    [["erin", "DIG", "--pay", "relay", "--relay", "http://relay.example.org"], /plain http:\/\/ is allowed only/],
    [["erin", "DIG", "--esplora", "http://esplora.example.org/api"], /--esplora: plain http/],
    [["erin", "DIG", "--pay", "relay"], /MURKLE_RELAY_URL: plain http/, (n) => (n === "RELAY_URL" ? "http://relay.example.org" : undefined)],
  ];
  for (const [args, re, read = none] of bad) assert.throws(() => parseMineArgs(args, { read }), re, args.join(" "));
  assert.ok(MINE_USAGE.includes("[--pay key|relay]"));
});

/* ------------------------------------------------------------------ W-M in the wallet file */

test("W-M: a claim entry stays until its carrier has a verdict, its solution is claimed, or block ref + 12", () => {
  const e = { kind: "mine", via: "self", ticker: "DIG", asset: "5", reward: "50", ref: 1000, solutionId: "ab".repeat(32), commitments: ["1", "2"], spends: [], lockUntil: 1012, status: "submitted", txid: "cc".repeat(32) };
  const view = (height, { log = [], claimed = [], nullifiers = [] } = {}) => ({ height, log, claimed: new Set(claimed), nullifiers: new Set(nullifiers) });
  assert.deepEqual(keepPending([e], view(1001)), [e], "no spends is not 'all spent'");
  assert.deepEqual(keepPending([e], view(1011)), [e]);
  assert.deepEqual(keepPending([e], view(1012)), [], "block ref + 12 indexed: it can no longer land");
  assert.deepEqual(keepPending([e], view(1005, { log: [{ txid: "cc".repeat(32), ok: false }] })), [], "the carrier has a verdict");
  assert.deepEqual(keepPending([e], view(1005, { claimed: ["ab".repeat(32)] })), [], "the solution is claimed (another carrier)");
  const relayed = { ...e, via: "relay", txid: undefined, relayId: "dd".repeat(16), spends: ["9"] };
  assert.deepEqual(keepPending([relayed], view(1005, { nullifiers: ["9"] })), [relayed], "a spent rolled note alone does not end the lock");
  assert.equal(relayed.anchorMax, undefined, "no anchor bookkeeping for a claim");
  // Transfers keep W-1 exactly as before.
  const t = { txid: "ee".repeat(32), spends: ["1"], anchor: 950 };
  assert.deepEqual(keepPending([t, e], view(1001)), [t, e]);
});

test("W-M entries merge by solution across commands, are listed, and are never retried", async () => {
  const claim = { kind: "mine", via: "relay", ticker: "DIG", asset: "5", reward: "50", ref: 1000, solutionId: "ab".repeat(32), spends: [], lockUntil: 1012, status: "relaying", relayId: null, createdAt: 1 };
  const base = { seed: "s", pending: [claim] };
  const mine = { seed: "s", pending: [{ ...claim, status: "submitted", relayId: "ff".repeat(16), txid: "11".repeat(32) }] };
  const disk = { seed: "s", pending: [claim, { kind: "mine", solutionId: "cd".repeat(32), spends: [], lockUntil: 1013, status: "submitted", txid: "22".repeat(32), createdAt: 2 }] };
  const merged = mergeWalletFile(base, mine, disk);
  assert.equal(merged.pending.length, 2, "one entry per solution, the other command's claim kept");
  assert.equal(merged.pending[0].relayId, "ff".repeat(16), "this command's change wins for its own solution");
  const out = [];
  await listPending({ idx: { height: 1003 }, file: { pending: [mine.pending[0]] }, clientFor: () => assert.fail("no lookup"), print: (s) => out.push(s) });
  assert.match(out[0], /^mine relay {2}50 DIG {2}ref 1000 {2}submitted {2}txid 1{64} {2}id f{12}… {2}locked until 1012$/);
  const failed = { ...claim, status: "failed", error: "stale_work" };
  assert.equal(await pickRetry({ file: { pending: [failed] }, clientFor: () => assert.fail("no lookup") }), null, "a claim is never retried");
});

/* ------------------------------------------------------------------ audit --compare */

test("audit --compare names a digest version change instead of a transaction", () => {
  const at = (h) => (h >= 5000 ? 2 : 1);
  const upgraded = { digestVersionAt: at };
  assert.equal(digestVersionLine(upgraded, 5000, 1), "digest version changes at 5000 (v1 -> v2): the other side runs a different release");
  assert.equal(digestVersionLine({ digestVersionAt: () => 1 }, 5000, 2), "digest version changes at 5000 (v1 -> v2): the other side runs a different release", "the remote switched");
  assert.equal(digestVersionLine({ digestVersionAt: () => 1 }, 5000, 1), null, "same release: point at the component");
  assert.equal(digestVersionLine({ digestVersionAt: () => 1 }, 5000, null), null, "remote unknown");
  assert.equal(digestVersionLine(upgraded, 5001, 2), null, "inside v2 a divergence is a transaction");
  assert.equal(digestVersionLine({}, 7, 1), null, "an indexer without versions is v1");
  const src = read("bin/murkle.mjs").replace(/\r\n/g, "\n");
  const audit = src.slice(src.indexOf("  async audit(args) {"));
  assert.ok(audit.indexOf("digestVersionLine(idx, res.height, remoteVersion)") > 0);
  assert.ok(audit.indexOf("digestVersionLine(idx, res.height, remoteVersion)") < audit.indexOf("await diagnose(idx, res.height, getJson)"));
  assert.match(audit, /\(await getJson\(`\/api\/digest\?height=\$\{res\.height\}`\)\)\.version \?\? 1/, "an absent version is v1 (D4)");
});

/* ------------------------------------------------------------------ assets, help, copy */

test("murkle assets prints a mined token's issuance, terms and fees", () => {
  const lines = minedAssetLines(
    { id: (846n << 32n) | 3n, ticker: "DIG", issued: 150n, maxSupply: 21_000n, claims: 3, deployHeight: 846, deployTxid: "ab".repeat(32), mineStart: 990, endHeight: 0, span: 24, targetPerSpan: 24, minDifficulty: 256n, halvingInterval: 0, feeSats: 1500n, rejectedClaims: 1, burnedFeeSats: 500n, reward: 50n },
    1000,
    stubLib({ mineStatus: () => "mining" }),
  );
  assert.equal(lines[0], "DIG              id 846:3  mined 150/21000 in 3 claims  reward 50  difficulty 1000  mining");
  assert.match(lines[1], /deployed at 846 in abababababab… {2}mining from block 990 {2}span 24, 24 solutions per span {2}floor 256$/);
  assert.equal(lines[2], "  service fees paid by accepted claims 1500 sats (gross)  rejected claims 1 (their fees spent: 500 sats)");
});

test("HELP lists deploy-pow and mine and says who sees what; the copy is the contract's", () => {
  const help = HELP.filter((l) => /deploy-pow|mine <w>|^Mining/.test(l)).join("\n");
  assert.equal(help.split("\n").length, 3);
  for (const s of [
    "deploy-pow <w> --ticker T --reward N --max-supply N", "[--difficulty D | --hashrate H]", "mine <w> <TICKER> [--threads N] [--pay key|relay]", "--prepare-coins n", "--esplora url",
    "service fee of 500 sats to the Murkle platform address", "the token, the reward and that address are public", "the relayer sees the token and the reward of every claim it carries for you",
  ]) {
    assert.ok(help.includes(s), `help: ${s}`);
  }
  assert.doesNotMatch(help, /anonymous|untraceable|trustless|mixer|\bfree\b|sponsor|fair launch|proof of work|ticket|12-hour/i);
  // The exact strings of mining-contract.md §12 (the CLI says "this miner" where the page says "this tab").
  assert.equal(
    MINE_COPY.relay("DIG", 50n),
    "The reward goes to a private note. Chain observers see relay claims of DIG for 50 each, not who received them. The relayer can link the address you top up from to every claim it carries for you, including the token and the reward. While few people relay claims, the claims right after your top-up are easy to tie to it. Top up before you start mining.",
  );
  assert.equal(MINE_COPY.key, "Claims are public: token, reward and the paying address. Anyone can add up what this address mined, and the transfers it pays for later.");
  assert.equal(MINE_COPY.fee(FEE), "Every claim pays a Bitcoin fee and a service fee of 500 sats to the Murkle platform address. Its own claims cost it 500 sats less.");
  assert.equal(MINE_COPY.censor, "Bitcoin miners choose what goes into blocks and in what order. They can delay a claim until it expires.");
  assert.equal(MINE_COPY.nearCap, "Supply is nearly mined out. A claim that lands after the cap is rejected; its Bitcoin fee and its service fee are still spent.");
  assert.equal(MINE_COPY.window, "A claim must land within 12 blocks of the block it references.");
  assert.equal(MINE_COPY.surge, "Difficulty jumped. Solutions found before the jump may no longer count; the wallet checks before paying.");
  assert.equal(MINE_COPY.bump, "The fee recipient can block a fee bump, so the wallet pays a next-block rate up front.");
  assert.equal(MINE_COPY.noise, "Difficulty is noisy: with few solutions per span, emission runs a few percent above target.");
  assert.equal(MINE_COPY.quiet, "After a quiet period or a hashrate jump, the first block can carry many claims.");
  assert.equal(MINE_COPY.hardware, "A single GPU or a server miner can be thousands of times faster than this miner. Anyone can rent many computers.");
  const copy = Object.values(MINE_COPY).map((v) => (typeof v === "function" ? v.length === 2 ? v("DIG", 50n) : v(FEE) : v)).join("\n");
  assert.doesNotMatch(copy, /anonymous|untraceable|trustless|mixer|\bfree\b|sponsor|fair launch guaranteed/i);
});

/* ------------------------------------------------------------------ docs */

const BANNED = /anonymous|untraceable|trustless|\bmixer\b|\bfree\b|sponsored|fair launch guaranteed/i;

test("README documents deploy-pow and mine, the routes, the disclosures and the mining variables", () => {
  const readme = read("README.md");
  const cli = readme.slice(readme.indexOf("## CLI"), readme.indexOf("## Reproduce the circuit"));
  const mining = cli.slice(cli.indexOf("### Mining"));
  assert.ok(cli.includes("### Mining"), "README has a Mining section under CLI");
  for (const s of [
    "deploy-pow alice --ticker", "--dry-run", "mine alice", "--pay relay", "--pay key", "--prepare-coins", "--max-fee-rate", "--max-claims", "--threads", "--esplora", "mineKey",
    "500 sats", "platform address", "no deployer", "claim fee", "--treasury", "activation height", "--start now", "--start-after N", MINE_COPY.start, "12 blocks", "W-M", "ref + 12", "GPU", "rent", "Bitcoin miners",
    "relayer", "token and the reward", "Test coins", "digest version changes at",
  ]) {
    assert.ok(mining.includes(s), `README mining: ${s}`);
  }
  assert.doesNotMatch(mining, BANNED);
  for (const s of ["MURKLE_POW_THREADS", "MURKLE_RELAY_MINE_ENABLED", "MURKLE_RELAY_MINE_FEE_HEADROOM", "MURKLE_RELAY_MINE_EST_VSIZE", "MURKLE_RELAY_INVALID_POW_SATS", "MURKLE_RELAY_POW_QUEUE", "MURKLE_RELAY_MEMPOOL_LOOKUPS"]) {
    assert.ok(readme.includes(s), `README: ${s}`);
  }
  assert.ok(cli.includes("node bin/murkle.mjs deploy-pow alice"));
  assert.ok(cli.includes("node bin/murkle.mjs mine alice"));
});

test("docs/CLAIMS.md carries the mining disclosures and the never-say list", () => {
  const claims = read("docs/CLAIMS.md");
  const mining = claims.slice(claims.indexOf("## Mining"));
  assert.ok(claims.includes("## Mining"));
  for (const s of [
    MINE_COPY.relay("TICKER", "R"), MINE_COPY.key, "A single GPU or a server miner can be thousands of times faster than this tab. Anyone can rent many computers.",
    MINE_COPY.fee(FEE), MINE_COPY.censor, MINE_COPY.nearCap, MINE_COPY.window, MINE_COPY.surge, MINE_COPY.bump, MINE_COPY.testCoins, MINE_COPY.noise, MINE_COPY.quiet, MINE_COPY.start,
    "It cannot see amounts, tokens or recipients", "the reward goes to a private note",
  ]) {
    assert.ok(mining.includes(s), `CLAIMS mining: ${s}`);
  }
  const never = mining.slice(mining.indexOf("Never say"));
  for (const w of ["anonymous", "untraceable", "trustless", "mixer", "free", "sponsored", "fair launch guaranteed", "GPU-resistant", "no head start"]) assert.ok(never.includes(`"${w}"`), `never say: ${w}`);
  // Outside the never-say list the section uses none of them.
  assert.doesNotMatch(mining.slice(0, mining.indexOf("Never say")), BANNED);
});

test("audit/REPORT.md has the Mining addendum with every invariant and its tests", () => {
  const report = read("audit/REPORT.md");
  const add = report.slice(report.indexOf("## Mining addendum"));
  assert.ok(report.includes("## Mining addendum"));
  for (const id of ["W-M", "I-PAY extended", "M-ACT", "M-ERR", "M-ORD", "M-POOL", "M-FEE"]) {
    const row = add.split("\n").find((l) => l.startsWith(`| ${id} |`));
    assert.ok(row, `REPORT: a row for ${id}`);
    assert.match(row, /test\/mine-[a-z]+\.test\.mjs/, `${id} names its tests`);
  }
  for (const s of ["serviceOut", "I0", "I1", "I2", "signPoolTx", "requiredFeeOutputs", "worker_threads", "byte-identical", "v1-chain.json", "insufficient work", "verifyGroth16", "prevoutScript"]) {
    assert.ok(add.includes(s), `REPORT addendum: ${s}`);
  }
  assert.doesNotMatch(add, BANNED);
  // The findings parser counts only A-, W-, R- and V2- ids with a number, so the addendum changes no counts on the site.
  assert.equal(auditFacts(report).findings.filter((f) => /^M-/.test(f.id)).length, 0);
});

/* ------------------------------------------------------------------ files */

test("line endings and English: bin/murkle.mjs CRLF, my docs and this test LF, no Cyrillic", () => {
  const ends = (p) => {
    const b = readFileSync(new URL(`../${p}`, import.meta.url));
    let lf = 0;
    let crlf = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 10) b[i - 1] === 13 ? crlf++ : lf++;
    return { lf, crlf, last: b[b.length - 1] };
  };
  const cli = ends("bin/murkle.mjs");
  assert.equal(cli.lf, 0, "bin/murkle.mjs is CRLF throughout");
  assert.equal(cli.last, 10);
  for (const f of ["README.md", "docs/CLAIMS.md", "audit/REPORT.md", "test/mine-cli.test.mjs"]) {
    const e = ends(f);
    assert.equal(e.crlf, 0, `${f} is LF`);
    assert.equal(e.last, 10, `${f} ends with a newline`);
    assert.ok(!hasCyrillic(read(f)), `${f}: English only`);
  }
  assert.ok(!hasCyrillic(read("bin/murkle.mjs")));
});

test("the CLI never funds anyone and never pays a claim from the BTC fee key", () => {
  const src = read("bin/murkle.mjs").replace(/\r\n/g, "\n");
  const mining = src.slice(src.indexOf("// ------------------------------------------------- mining"), src.indexOf("const DEPLOY_FLAGS = ["));
  assert.doesNotMatch(mining, /fund\w*\s+(the\s+)?(relayer|pool)/i);
  for (const [fn, end] of [["export async function runMiner(", "\n}\n"], ["export async function prepareCoinsCommand(", "\n}\n"], ["  async mine(args) {", "\n  },\n"]]) {
    const at = src.indexOf(fn);
    assert.ok(at > 0, fn);
    assert.doesNotMatch(src.slice(at, src.indexOf(end, at)), /btcKey/, `${fn}: claims are paid by the mining key or the relay balance only`);
  }
  assert.doesNotMatch(mining, /\bsleep\(\s*(Math\.random|random)/, "no forced random waits");
  assert.ok(dustLimit(PLATFORM) <= FEE.platformSats, "500 sats clear the P2TR dust limit (D2)");
});

/* ------------------------------------------------------------------ fix round (mining review) */

const powFail = (code, message = "Argon2 worker did not answer in time") => Object.assign(new Error(message), { name: "PowError", code });

test("mine sizes its slices from the measured rate and retries a timed-out or crashed worker instead of stopping", async () => {
  // A machine at 68 ms per hash (the noble reference): slices of about 2 s, and the round that times out is retried.
  const fx = fakeChain({ findOn: 4 });
  let t = 0;
  let n = 0;
  const seen = [];
  const pool = {
    size: 1,
    async grind(a) {
      n += 1;
      seen.push({ count: a.count, timeoutMs: a.timeoutMs });
      if (n === 2) throw powFail("POW_TIMEOUT");
      t += a.count * 68;
      return fx.pool.grind(a);
    },
  };
  const r = await run({ ...fx, pool }, { maxClaims: 1, threads: 1, slice: null, now: () => t });
  assert.equal(r.status, "done", r.out.join("\n"));
  assert.equal(r.sent, 1);
  assert.ok(r.out.some((l) => /^warn: Argon2 worker did not answer in time \(POW_TIMEOUT\); retrying with a smaller slice$/.test(l)), r.out.join("\n"));
  assert.equal(seen[0].count, 16, "the first slice is small");
  assert.equal(seen[0].timeoutMs, undefined, "the pool's default timeout until a rate is measured");
  assert.equal(seen[1].count, Math.round(2000 / 68), "then about 2 s per slice");
  assert.equal(seen[2].count, Math.floor(Math.round(2000 / 68) / 2), "halved after the failure");
  assert.ok(seen.slice(1).every((s) => s.timeoutMs >= 30_000));

  // A very slow machine: the timeout grows with the slice (4 x its expected time).
  const slowFx = fakeChain({ findOn: 3 });
  let t2 = 0;
  const seen2 = [];
  const slow = {
    size: 1,
    async grind(a) {
      seen2.push({ count: a.count, timeoutMs: a.timeoutMs });
      t2 += a.count * 9000; // 9 s per hash
      return slowFx.pool.grind(a);
    },
  };
  const r2 = await run({ ...slowFx, pool: slow }, { maxClaims: 1, threads: 1, slice: null, now: () => t2 });
  assert.equal(r2.status, "done", r2.out.join("\n"));
  assert.equal(seen2[1].count, 1, "one hash per slice");
  assert.equal(seen2[1].timeoutMs, 36_000, "1 x 9 s x 4");

  // Workers that keep failing: mining stops with a reason after 10 rounds, never a verdict on the work.
  const dead = fakeChain({ findOn: 1 });
  const broken = { size: 2, grind: async () => { throw powFail("POW_WORKER_FAILED", "Argon2 worker exited"); } };
  const r3 = await run({ ...dead, pool: broken }, { maxClaims: 1, threads: 2, slice: null });
  assert.equal(r3.status, "error");
  assert.match(r3.reason, /the Argon2 workers failed 10 rounds in a row \(Argon2 worker exited\); nothing more was mined/);
  assert.equal(dead.esplora.broadcasts.length, 0);
  // A closed pool ends the run at once.
  const closed = { size: 1, grind: async () => { throw powFail("POW_CLOSED", "the Argon2 pool is closed"); } };
  const r4 = await run({ ...fakeChain(), pool: closed }, { maxClaims: 1, threads: 1, slice: null });
  assert.equal(r4.status, "error");
  assert.match(r4.reason, /the Argon2 pool is closed/);
  // Any other error is a bug, not a retry.
  const buggy = { size: 1, grind: async () => { throw new TypeError("boom"); } };
  await assert.rejects(run({ ...fakeChain(), pool: buggy }, { maxClaims: 1, threads: 1 }), /boom/);
});

test("mine --threads is bounded by this machine's logical processors", () => {
  const none = () => undefined;
  assert.equal(parseMineArgs(["erin", "DIG", "--threads", "8"], { read: none, processors: 8 }).threads, 8);
  assert.throws(() => parseMineArgs(["erin", "DIG", "--threads", "9"], { read: none, processors: 8 }), /--threads must be 1 to 8 \(this machine's logical processors\)\nusage: murkle mine/);
  assert.throws(() => parseMineArgs(["erin", "DIG", "--threads", "5000"], { read: none }), /--threads must be 1 to \d+/);
  assert.equal(parseMineArgs(["erin", "DIG", "--threads", "1"], { read: none, processors: 0 }).threads, 1, "at least one thread");
});

test("the cap counts claims in flight at their own rewards (pendingReward) when the relayer reports it", async () => {
  const lib = stubLib();
  const asset = { id: 5n, kind: "pow", reward: 10n, maxSupply: 100n, issued: 50n, mineStart: 990 };
  const draft = { refHeight: 1000, reward: 10n, rolled: [] };
  const base = { lib, idx: { claimed: new Set(), nullifiers: new Set() }, asset, draft, powHash: new Uint8Array(32), solutionIdHex: "aa", tip: 1000 };
  // Two claims from before a halving (20 each) in flight: 50 + 40 + 10 = 100 fits, 50 + 41 + 10 does not.
  assert.equal(claimRefusal({ ...base, inflight: 2, inflightReward: 40n }), null);
  assert.match(claimRefusal({ ...base, inflight: 2, inflightReward: 41n }), /supply cap would be reached, counting 2 claims already on the way/);

  // In a run: the relayer reports 1 claim worth 200 in flight; 9,800 + 200 + 50 > 10,000 (1 x 50 would have fit).
  const ac = new AbortController();
  const fx = fakeChain({ issued: 9_800n, pendingClaims: 1, onGrind: (n) => void (n === 3 && ac.abort()) });
  fx.relay = { client: { mineAsset: async () => ({ pendingClaims: 1, pendingReward: "200" }) }, url: "http://relay.test" };
  const r = await run(fx, { signal: ac.signal, threads: 1 });
  assert.ok(r.out.includes("solution not paid: the supply cap would be reached, counting 1 claim already on the way"), r.out.join("\n"));
  assert.equal(fx.esplora.broadcasts.length, 0);
});

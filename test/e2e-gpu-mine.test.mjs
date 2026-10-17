// The pure parts of the browser mining E2E (scripts/e2e-gpu-mine.mjs) and its fake payer (test/fixtures/fake-mine-payer.mjs):
// request routing (the mining key's listing and POST /tx go to the fake, signet reads pass, anything else is forbidden), the
// fake's listing after broadcasts, confirm-all on a new block, the configurable chain limit, the arguments and guards, the carrier
// check and the scenario verdicts. No browser, no GPU, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as btc from "@scure/btc-signer";
import { FakeMinePayer } from "./fixtures/fake-mine-payer.mjs";
import { scriptOf, addressOf } from "../src/btc/funding.mjs";
import { concat, hex, u32le, u64le, unhex } from "../src/bytes.mjs";
import { ACTIVITY_MS, BAD_ENDS, CPU_SETTLE_MS, GOOD_ENDS, activityPoint, checkCarrier, cpuJudged, guardE2e, parseE2eArgs, phaseOfText, scenarioVerdict } from "../scripts/e2e-gpu-mine.mjs";

const BASE = "https://mempool.space/signet/api";
const KEY = new Uint8Array(32).fill(7);
const ADDRESS = addressOf(btc.p2tr(btc.utils.pubSchnorr(KEY), undefined, btc.TEST_NETWORK).script);
const OTHER = addressOf(btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(9)), undefined, btc.TEST_NETWORK).script);

const varint = (n) => new Uint8Array([n]); // every count here is below 253
/** A legacy-serialized transaction (no real signature) spending `coins` ([{ txid, vout, value }]) to `outputs` ([{ script, value }]): hex. */
function spend(coins, outputs) {
  const parts = [u32le(2), varint(coins.length)];
  for (const c of coins) parts.push(unhex(c.txid).reverse(), u32le(c.vout), varint(1), new Uint8Array([0x51]), u32le(0xfffffffd)); // a one-byte scriptSig: "finalized" to the parser
  parts.push(varint(outputs.length));
  for (const o of outputs) parts.push(u64le(BigInt(o.value)), varint(o.script.length), o.script);
  parts.push(u32le(0));
  return hex(concat(...parts));
}
const payer = (over = {}) => new FakeMinePayer({ miningAddress: ADDRESS, ...over });

test("route: the mining key's listing, POST /tx and the fake txids' lookups are fake; signet reads and this origin pass; everything else is forbidden", async () => {
  const p = payer();
  const [seed] = [p.seed([50_000])];
  assert.equal(p.route(`${BASE}/address/${ADDRESS}/utxo`, "GET"), "fake");
  assert.equal(p.route(`${BASE}/address/${OTHER}/utxo`, "GET"), "pass", "another address is a read that may pass");
  assert.equal(p.route(`${BASE}/tx`, "POST"), "fake");
  assert.equal(p.route(`${BASE}/tx/${seed}`, "GET"), "fake");
  assert.equal(p.route(`${BASE}/tx/${seed}/status`, "GET"), "fake");
  assert.equal(p.route(`${BASE}/tx/${seed}/hex`, "GET"), "fake");
  assert.equal(p.route(`${BASE}/tx/${"ab".repeat(32)}`, "GET"), "pass", "a txid the fake does not know is a signet read");
  assert.equal(p.route(`${BASE}/blocks/tip/height`, "GET"), "pass");
  assert.equal(p.route(`${BASE}/v1/fees/recommended`, "GET"), "pass");
  assert.equal(p.route(`${BASE}/block-height/330000`, "GET"), "pass");
  assert.equal(p.route("http://127.0.0.1:8787/api/state", "GET"), "pass");
  assert.equal(p.route("http://127.0.0.1:8787/api/mine", "GET"), "pass");
  assert.equal(p.route("http://localhost:4173/artifacts/transaction.zkey", "GET"), "pass");
  assert.equal(p.route("data:text/plain,hi", "GET"), "pass");
  assert.equal(p.route("blob:http://127.0.0.1:8787/abc", "GET"), "pass");
  // a mainnet path, another host, another write
  assert.equal(p.route("https://mempool.space/api/tx", "POST"), "forbid");
  assert.equal(p.route("https://mempool.space/api/address/bc1qxyz/utxo", "GET"), "forbid");
  assert.equal(p.route("https://mempool.space/api/v1/fees/recommended", "GET"), "forbid");
  assert.equal(p.route("https://blockstream.info/api/tx", "POST"), "forbid");
  assert.equal(p.route("https://example.com/x.js", "GET"), "forbid");
  assert.equal(p.route(`${BASE}/tx/push`, "POST"), "forbid");
  assert.equal(p.route(`${BASE}/blocks/tip/height`, "PUT"), "forbid");
  assert.equal(p.route("not a url", "GET"), "forbid");
  assert.equal(p.route("https://mempool.space.evil.example/signet/api/tx", "POST"), "forbid");
});

test("listing: seeded coins, then a broadcast shows its change unconfirmed and the spent coin gone; confirmAll confirms them", async () => {
  const p = payer();
  p.seed([200_000, 100_000], { height: 5 });
  const l0 = p.listing();
  assert.equal(l0.length, 2);
  assert.ok(l0.every((c) => c.status.confirmed === true && c.status.block_height === 5));
  const big = l0.find((c) => c.value === 200_000);
  const raw = spend([big], [{ script: scriptOf(OTHER), value: 500 }, { script: scriptOf(ADDRESS), value: 190_000 }]);
  const txid = await p.broadcast(raw);
  const l1 = p.listing();
  assert.equal(l1.length, 2);
  assert.ok(!l1.some((c) => c.txid === big.txid && c.vout === big.vout), "the spent coin is gone");
  const change = l1.find((c) => c.txid === txid);
  assert.deepEqual([change.value, change.status], [190_000, { confirmed: false }]);
  assert.equal(l1.some((c) => c.value === 500), false, "the other address's output is not listed");
  assert.deepEqual(p.confirmAll(6), [txid]);
  const l2 = p.listing();
  assert.deepEqual(l2.find((c) => c.txid === txid).status, { confirmed: true, block_height: 6 });
  assert.equal(p.tip, 6);
  assert.deepEqual(p.confirmAll(7), [], "nothing left in the mempool");
  // a coin the fake does not hold is refused
  await assert.rejects(p.broadcast(spend([{ txid: "cd".repeat(32), vout: 0, value: 1 }], [{ script: scriptOf(ADDRESS), value: 1 }])), /bad-txns-inputs-missingorspent/);
});

test("the chain limit is configurable: a chain of limit transactions goes out, the next is refused with too-long-mempool-chain, and a block frees it", async () => {
  for (const limit of [3, 6, 25]) {
    const p = payer({ limit });
    p.seed([1_000_000], { height: 1 });
    let n = 0;
    let refused = null;
    for (; n < limit + 2; n++) {
      const coin = p.listing().sort((a, b) => b.value - a.value)[0];
      const raw = spend([coin], [{ script: scriptOf(OTHER), value: 500 }, { script: scriptOf(ADDRESS), value: coin.value - 1000 }]);
      try {
        await p.broadcast(raw);
      } catch (e) {
        refused = e.message;
        break;
      }
    }
    assert.equal(n, limit, `limit ${limit}: ${limit} transactions are accepted`);
    assert.match(refused, /too-long-mempool-chain/);
    p.confirmAll(2);
    const coin = p.listing().sort((a, b) => b.value - a.value)[0];
    assert.equal(coin.status.confirmed, true);
    await p.broadcast(spend([coin], [{ script: scriptOf(OTHER), value: 500 }, { script: scriptOf(ADDRESS), value: coin.value - 1000 }]));
  }
  assert.equal(payer().limit, 25, "the default is Bitcoin Core's 25");
});

test("answer: the Esplora endpoints as the page's client reads them (listing JSON, POST /tx text, a refusal is a 400 with the node's words)", async () => {
  const p = payer({ limit: 2 });
  const seed = p.seed([500_000], { height: 3 });
  const list = await p.answer(`${BASE}/address/${ADDRESS}/utxo`, "GET");
  assert.equal(list.status, 200);
  assert.equal(JSON.parse(list.body)[0].txid, seed);
  assert.equal(p.listings, 1);
  const send = async () => {
    const coin = p.listing().sort((a, b) => b.value - a.value)[0];
    return p.answer(`${BASE}/tx`, "POST", spend([coin], [{ script: scriptOf(OTHER), value: 500 }, { script: scriptOf(ADDRESS), value: coin.value - 1000 }]));
  };
  const a = await send();
  assert.equal(a.status, 200);
  assert.match(a.body, /^[0-9a-f]{64}$/);
  await send();
  const c = await send();
  assert.equal(c.status, 400);
  assert.match(c.body, /too-long-mempool-chain/);
  assert.deepEqual(p.broadcasts.map((b) => b.ok), [true, true, false]);
  assert.ok(p.broadcasts[2].txid, "the refused carrier's txid is recorded");
  const st = await p.answer(`${BASE}/tx/${a.body}/status`, "GET");
  assert.deepEqual(JSON.parse(st.body), { confirmed: false });
  assert.equal((await p.answer(`${BASE}/tx/${a.body}/hex`, "GET")).status, 200);
  assert.equal((await p.answer(`${BASE}/tx/${a.body}`, "GET")).status, 200);
  assert.equal((await p.answer(`${BASE}/tx/${"ee".repeat(32)}`, "GET")).status, 404);
  assert.equal((await p.answer(`${BASE}/blocks/tip/height`, "GET")).status, 404, "only the fake routes are answered here");
});

test("arguments: --url must be local, the scenario is 1 to 4, the chain limit defaults to 25 (6 for scenario 2)", () => {
  assert.deepEqual(parseE2eArgs(["--url", "http://127.0.0.1:8787/"]), { url: "http://127.0.0.1:8787", chrome: null, scenario: 1, limit: 25, solutions: 8, minutes: 45, ticker: null, state: null, out: "results-e2e.json", shots: null });
  const o = parseE2eArgs(["--url", "http://localhost:8787", "--scenario", "2", "--chrome", "/x/chrome", "--ticker", "murk", "--solutions", "3", "--minutes", "5", "--out", "o.json", "--shots", "s", "--state", "st.json"]);
  assert.deepEqual([o.scenario, o.limit, o.ticker, o.solutions, o.minutes, o.out, o.shots, o.state, o.chrome], [2, 6, "MURK", 3, 5, "o.json", "s", "st.json", "/x/chrome"]);
  assert.equal(parseE2eArgs(["--url", "http://127.0.0.1:1", "--scenario", "2", "--limit", "3"]).limit, 3);
  for (const bad of [[], ["--url", "https://murklebtc.com"], ["--url", "http://example.com:8787"], ["--url", "http://127.0.0.1:1", "--scenario", "5"], ["--url", "http://127.0.0.1:1", "--scenario", "0"], ["--url", "http://127.0.0.1:1", "--limit", "1"], ["--url", "http://127.0.0.1:1", "--nope"], ["--url"]]) {
    assert.throws(() => parseE2eArgs(bad), Error, JSON.stringify(bad));
  }
});

test("guard: it refuses mainnet and an environment without MURKLE_WEBGPU=gpu, before anything is imported", () => {
  assert.throws(() => guardE2e({ MURKLE_WEBGPU: "gpu", MURKLE_NETWORK: "mainnet" }, "linux"), /mainnet/);
  assert.throws(() => guardE2e({ MURKLE_WEBGPU: "gpu", MURKLE_NETWORK: "MAINNET" }, "linux"), /mainnet/);
  assert.throws(() => guardE2e({}, "linux"), /WebGPU is disabled here/);
  assert.throws(() => guardE2e({ MURKLE_WEBGPU: "fallback" }, "linux"), /WebGPU is disabled here/);
  assert.doesNotThrow(() => guardE2e({ MURKLE_WEBGPU: "gpu" }, "linux"));
  assert.doesNotThrow(() => guardE2e({ MURKLE_WEBGPU: "gpu", MURKLE_NETWORK: "signet" }, "linux"));
});

test("checkCarrier: a transaction that is not a bound MINE carrier is described, not accepted", () => {
  const coin = { txid: "ab".repeat(32), vout: 1, value: 10_000 };
  const plain = checkCarrier(spend([coin], [{ script: scriptOf(OTHER), value: 500 }]));
  assert.equal(plain.ok, false);
  assert.ok(plain.problems.some((x) => /not an OP_RETURN/.test(x)));
  assert.ok(plain.problems.some((x) => /platform script/.test(x)));
  assert.equal(plain.firstInput, `${coin.txid}:1`);
  const junk = checkCarrier(spend([coin], [{ script: new Uint8Array([0x6a, 0x01, 0x02]), value: 0 }]));
  assert.equal(junk.ok, false);
  assert.ok(junk.problems.some((x) => /envelope/.test(x)));
});

const ev = (e, extra = {}) => ({ ev: e, t: 0, ...extra });
const good1 = () => [
  ...["starting", "selftest", "ready", "mining"].map((phase) => ev("state", { phase })),
  ev("cpu-start", { cpu: 900, ms: 2500 }),
  ev("rates", { cpu: 900, gpu: 70_000 }), ev("rates", { cpu: 1000, gpu: 72_000 }),
  ...[1, 2, 3].map((i) => ev("sol", { key: `row${i}`, end: "broadcast" })),
  ev("post", { ok: true, carrier: { ok: true, problems: [] } }), ev("checkMine", { txid: "a", result: true }),
];

test("verdicts: scenario 1 passes on a clean run and names every failed criterion", () => {
  assert.equal(GOOD_ENDS.has("held"), true);
  assert.equal(BAD_ENDS.has("dropped"), true);
  const ok = scenarioVerdict(1, good1(), { benchHs: 95_000 });
  assert.deepEqual(ok.failures, []);
  assert.equal(ok.pass, true);
  assert.equal(ok.facts.gpuHsMax, 72_000);
  const slow = scenarioVerdict(1, good1(), { benchHs: 200_000 });
  assert.match(slow.failures.join("|"), /under 50% of the bench/);
  // the tick: a gpu-worker request before it fails, one after it passes; a script that calls requestAdapter before it fails
  const at = (t, e, extra) => ({ ...ev(e, extra), t });
  const worker = "http://127.0.0.1:8787/assets/gpu-worker-abc.js";
  const timed = (reqT) => [at(1000, "tick"), at(1500, "state", { phase: "starting" }), at(reqT, "req", { url: worker }), ...good1().slice(1)];
  assert.equal(scenarioVerdict(1, timed(1200)).pass, true, "after the tick");
  assert.match(scenarioVerdict(1, timed(500)).failures.join("|"), /requested before the tick/);
  assert.match(scenarioVerdict(1, [...good1().filter((e) => !(e.ev === "state" && e.phase === "starting")), at(5, "req", { url: worker })]).failures.join("|"), /without a tick/);
  assert.match(scenarioVerdict(1, [...timed(1200), at(3, "jsscan", { url: "http://127.0.0.1:8787/assets/app.js", requestAdapter: true })]).failures.join("|"), /call requestAdapter/);
  assert.equal(scenarioVerdict(1, [...timed(1200), at(3, "jsscan", { url: "http://127.0.0.1:8787/assets/app.js", requestAdapter: false })]).pass, true);
  const dropped = scenarioVerdict(1, [...good1(), ev("sol", { key: "row9", end: "dropped" })]);
  assert.match(dropped.failures.join("|"), /ended badly: row9=dropped/);
  const shape = scenarioVerdict(1, [...good1(), ev("post", { ok: true, carrier: { ok: false, problems: ["output 0 is not an OP_RETURN"] } })]);
  assert.match(shape.failures.join("|"), /shape check/);
  const idx = scenarioVerdict(1, [...good1(), ev("checkMine", { txid: "b", result: "MINE not bound to this payer" })]);
  assert.match(idx.failures.join("|"), /checkMine/);
  const cpu0 = scenarioVerdict(1, [...good1(), ev("rates", { cpu: 0, gpu: 70_000 })]);
  assert.match(cpu0.failures.join("|"), /0 H\/s/);
  // the CPU lanes must report H/s after Start (the first non-zero reading is recorded with its delay)
  assert.match(scenarioVerdict(1, good1().filter((e) => e.ev !== "cpu-start")).failures.join("|"), /never reported H\/s after Start/);
  assert.match(scenarioVerdict(1, [...good1().filter((e) => e.ev !== "cpu-start"), ev("cpu-start", { cpu: 0, ms: 60000 })]).failures.join("|"), /never reported H\/s after Start/);
  assert.equal(scenarioVerdict(1, good1()).facts.cpuStartMs, 2500);
  const net = scenarioVerdict(1, [...good1(), ev("net", { url: "https://mempool.space/api/tx", verdict: "forbid" })]);
  assert.match(net.failures.join("|"), /forbidden request/);
  const never = scenarioVerdict(1, good1().filter((e) => !(e.ev === "state" && e.phase === "mining")));
  assert.match(never.failures.join("|"), /never reached mining/);
});

test("verdicts: scenario 2 needs a refused broadcast and a held carrier sent again after a block; 3 needs the ban, the disabled box and a working processor; 4 the unsupported text and no worker request", () => {
  const two = [...good1(), ev("post", { ok: false, error: "POST /tx: 400 sendrawtransaction RPC error: too-long-mempool-chain" }), ev("resent", { txid: "c" })];
  assert.equal(scenarioVerdict(2, two).pass, true);
  assert.match(scenarioVerdict(2, good1()).failures.join("|"), /refused for chain length/);
  assert.match(scenarioVerdict(2, [...good1(), ev("post", { ok: false, error: "too-long-mempool-chain" })]).failures.join("|"), /accepted after a block/);

  const three = [
    ...["starting", "ready", "mining", "banned"].map((phase) => ev("state", { phase })),
    ev("cpu-start", { cpu: 900, ms: 2000 }),
    ev("rates", { cpu: 1000, gpu: 0 }),
    ev("check", { name: "banned-disabled", ok: true }), ev("check", { name: "cpu-after-ban", ok: true }), ev("check", { name: "stop-start", ok: true }),
  ];
  assert.equal(scenarioVerdict(3, three).pass, true);
  assert.match(scenarioVerdict(3, [...three, ev("post", { ok: true, afterFault: true, fromGpu: null })]).failures.join("|"), /after the ban of a GPU-lane solution/);
  assert.equal(scenarioVerdict(3, [...three, ev("post", { ok: true, afterFault: true, fromGpu: false })]).pass, true, "a processor solution after the fault is fine");
  assert.match(scenarioVerdict(3, three.filter((e) => e.phase !== "banned")).failures.join("|"), /never became banned/);
  assert.match(scenarioVerdict(3, three.filter((e) => e.name !== "stop-start")).failures.join("|"), /Stop \/ Start/);

  const four = [ev("state", { phase: "unsupported" }), ev("check", { name: "box-disabled", ok: true }), ev("rates", { cpu: 1000, gpu: 0 }), ev("req", { url: "http://127.0.0.1:8787/assets/mine-worker-x.js" })];
  assert.equal(scenarioVerdict(4, four).pass, true);
  assert.match(scenarioVerdict(4, [...four, ev("req", { url: "http://127.0.0.1:8787/assets/gpu-worker-abc.js" })]).failures.join("|"), /gpu-worker file was requested/);
  assert.match(scenarioVerdict(4, four.filter((e) => e.ev !== "rates")).failures.join("|"), /no H\/s/);
});

test("a block makes the fake payer's carriers confirmed on every route the page reads: status, the transaction view, and the coin listing", async () => {
  const p = payer();
  p.seed([300_000], { height: 5 });
  const coin = p.listing()[0];
  const send = async (c) => p.answer(`${BASE}/tx`, "POST", spend([c], [{ script: scriptOf(OTHER), value: 500 }, { script: scriptOf(ADDRESS), value: c.value - 1000 }]));
  const ids = [];
  let c = coin;
  for (let i = 0; i < 3; i++) {
    const a = await send(c);
    ids.push(a.body);
    c = p.listing().find((x) => x.txid === a.body);
  }
  for (const id of ids) assert.deepEqual(JSON.parse((await p.answer(`${BASE}/tx/${id}/status`, "GET")).body), { confirmed: false });
  assert.deepEqual(p.confirmAll(9).sort(), [...ids].sort());
  for (const id of ids) {
    assert.deepEqual(JSON.parse((await p.answer(`${BASE}/tx/${id}/status`, "GET")).body), { confirmed: true, block_height: 9 }, "the spent change's carrier too: no listing shows it, its status does");
    assert.deepEqual(JSON.parse((await p.answer(`${BASE}/tx/${id}`, "GET")).body).status, { confirmed: true, block_height: 9 });
    assert.equal(p.route(`${BASE}/tx/${id}/status`, "GET"), "fake", "the page's lookup is answered by the fake, not sent to signet");
  }
  assert.deepEqual(p.listing().map((x) => x.status), [{ confirmed: true, block_height: 9 }]);
});

test("verdicts: the lane of each claim comes from its row (data-lane, matched by the carrier's nonce); a GPU-lane solution found after the ban must not be posted, one found before it may", () => {
  const at = (t, e, extra) => ({ ...ev(e, extra), t });
  const base = () => [
    ...["starting", "ready", "mining", "banned"].map((phase) => ev("state", { phase })),
    ev("cpu-start", { cpu: 900, ms: 2000 }), ev("rates", { cpu: 1000, gpu: 0 }),
    ev("check", { name: "banned-disabled", ok: true }), ev("check", { name: "cpu-after-ban", ok: true }), ev("check", { name: "stop-start", ok: true }),
    at(1000, "fault-seen"),
  ];
  const post = (t, nonce, extra = {}) => at(t, "post", { ok: true, afterFault: t > 1000, carrier: { ok: true, problems: [], nonce }, ...extra });
  const row = (t, nonce, lane) => at(t, "row", { key: `330000:${nonce}`, nonce, lane, text: "x" });
  // a processor solution posted after the ban: fine
  assert.equal(scenarioVerdict(3, [...base(), row(900, "01", "cpu"), post(1500, "01")]).pass, true);
  // a GPU solution found before the ban (its row was seen before 1000) and posted after it: the lane had passed its checks then; allowed, and counted
  const early = scenarioVerdict(3, [...base(), row(900, "02", "gpu"), post(1500, "02")]);
  assert.equal(early.pass, true);
  assert.equal(early.facts.gpuPostsAfterBan, 1);
  // a GPU solution whose row first appears after the ban came from the banned lane: never posted
  const late = scenarioVerdict(3, [...base(), row(1200, "03", "gpu"), post(1500, "03")]);
  assert.match(late.failures.join("|"), /1 POST \/tx after the ban of a GPU-lane solution found after it/);
  // when the ban event lists the rows on the page at that moment, that set decides (not the sample times)
  const withSet = (nonces) => [...base().filter((e) => e.ev !== "fault-seen"), at(1000, "fault-seen", { nonces })];
  assert.equal(scenarioVerdict(3, [...withSet(["07"]), row(1200, "07", "gpu"), post(1500, "07")]).pass, true, "on the page at the ban");
  assert.match(scenarioVerdict(3, [...withSet(["07"]), row(900, "08", "gpu"), post(1500, "08")]).failures.join("|"), /after the ban/, "not on the page at the ban, whatever its sample time says");
  // a post that matches no row has no known lane: it counts as a GPU one
  assert.match(scenarioVerdict(3, [...base(), post(1500, "04")]).failures.join("|"), /after the ban/);
  // a post made before the ban is not looked at
  assert.equal(scenarioVerdict(3, [...base(), row(500, "05", "gpu"), post(600, "05", { afterFault: false })]).pass, true);
  // the page's own claim says where it came from when the harness knows it
  assert.equal(scenarioVerdict(3, [...base(), post(1500, "06", { fromGpu: false })]).pass, true);
});

test("verdicts: after a block that confirmed carriers, as many waiting claims as the chain room allows must go out before the next block (measured against the fake payer's confirmations)", () => {
  const at = (t, e, extra) => ({ ...ev(e, extra), t });
  const run = (sent, { waiting = 20, confirmed = 24, next = true } = {}) => [
    ...good1(),
    at(1000, "block", { height: 10, confirmed }), at(1100, "block-rows", { rows: 50, waiting }),
    ...Array.from({ length: sent }, (_, i) => at(1200 + i, "post", { ok: true, carrier: { ok: true, problems: [] } })),
    ...(next ? [at(5000, "block", { height: 11, confirmed: sent })] : []),
  ];
  assert.deepEqual(scenarioVerdict(1, run(12)).failures, []);
  assert.deepEqual(scenarioVerdict(1, run(30)).failures, []);
  const slow = scenarioVerdict(1, run(2));
  assert.match(slow.failures.join("|"), /after block 10 \(24 carriers confirmed, 20 claims waiting\) only 2 claim\(s\) went out before the next block, expected at least 12/);
  assert.deepEqual(slow.facts.afterBlock, [{ height: 10, confirmed: 24, waiting: 20, sent: 2 }]);
  // fewer waiting than 12: all of them
  assert.deepEqual(scenarioVerdict(1, run(5, { waiting: 5 })).failures, []);
  assert.match(scenarioVerdict(1, run(4, { waiting: 5 })).failures.join("|"), /expected at least 5/);
  // nothing waiting, or nothing confirmed, or an interval that has no next block yet: not judged
  assert.deepEqual(scenarioVerdict(1, run(0, { waiting: 0 })).failures, []);
  assert.deepEqual(scenarioVerdict(1, run(0, { confirmed: 0 })).failures, []);
  assert.deepEqual(scenarioVerdict(1, run(0, { next: false })).failures, []);
  // a refused broadcast is not a claim that went out
  const refused = [...run(12), ...Array.from({ length: 12 }, (_, i) => at(1300 + i, "post", { ok: false, error: "too-long-mempool-chain" }))];
  assert.deepEqual(scenarioVerdict(1, refused).failures, []);
  assert.match(scenarioVerdict(1, [...run(0), ...Array.from({ length: 12 }, (_, i) => at(1300 + i, "post", { ok: false, error: "too-long-mempool-chain" }))]).failures.join("|"), /only 0 claim/);
});

test("checkCarrier reports the claim's nonce, which is how a POST is tied to a solution row", () => {
  const coin = { txid: "ab".repeat(32), vout: 1, value: 10_000 };
  assert.equal(checkCarrier(spend([coin], [{ script: scriptOf(OTHER), value: 500 }])).nonce, null, "no envelope, no nonce");
});

test("the harness source: the box click retries, the threads variable, the 50 ms poll for starting, the CPU sample after Start and the lane attributes are there", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(new URL("../scripts/e2e-gpu-mine.mjs", import.meta.url), "utf8");
  assert.ok(text.includes("for (let k = 0; k < 5 && !(await page.$eval(box, (e) => e.checked)"), "click again until the box is ticked");
  assert.ok(text.includes("process.env.E2E_THREADS"));
  assert.ok(/"box ready", 50\)/.test(text), "polled every 50 ms while the box starts");
  assert.ok(text.includes('emit("cpu-start"'));
  assert.ok(text.includes("data-lane") || text.includes("dataset.lane"));
  assert.ok(/payer\.confirmAll\(s\.height\)/.test(text));
  assert.ok(/await sleep\(1000\);\s*\}\s*\};\s*blockTimer = pollBlocks\(\)/.test(text), "blocks are polled every second");
});

test("E2E: the phase of every caption, including the 'starting' text and the pause", () => {
  const cases = [
    ["WebGPU is not available in this browser, so the graphics card cannot be used here.", "unsupported"],
    ["Starting the graphics card…", "starting"],
    ["Checking RTX 4090 against known answers. This takes a few seconds.", "selftest"],
    ["RTX 4090 passed its check. It mines when you start mining.", "ready"],
    ["RTX 4090: 72.3 kH/s", "mining"],
    ["Graphics card paused: 61 solutions are waiting to be paid. It searches again when the wallet has caught up.", "paused"],
    ["The graphics card stopped: x. Untick the box and tick it again to retry.", "failed"],
    ["The graphics card is off for this page: x.", "banned"],
    ["Off. The graphics card is used only after you tick the box.", "off"],
    ["", null],
  ];
  for (const [t, phase] of cases) assert.equal(phaseOfText(t), phase, t);
});

test("E2E: the processor is judged only outside proofs (it pauses while a claim is proved with the GPU on), and the pointer is nudged to keep the wallet unlocked", () => {
  const at = (r) => ev("rates", r);
  // a sample taken during a proof reads 0 for the processor: not a failure
  const inProof = [...good1(), at({ cpu: 0, gpu: 70_000, proving: true, sinceProofMs: 0 })];
  assert.deepEqual(scenarioVerdict(1, inProof).failures, []);
  assert.equal(scenarioVerdict(1, inProof).facts.cpuSamplesInProofs, 1);
  // 2 s after a proof the workers are still starting again: not judged; 6 s after: judged
  assert.deepEqual(scenarioVerdict(1, [...good1(), at({ cpu: 0, gpu: 70_000, proving: false, sinceProofMs: 2_000 })]).failures, []);
  assert.match(scenarioVerdict(1, [...good1(), at({ cpu: 0, gpu: 70_000, proving: false, sinceProofMs: 6_000 })]).failures.join("|"), /0 H\/s at some sample outside a proof/);
  assert.match(scenarioVerdict(1, [...good1(), at({ cpu: 0, gpu: 70_000, proving: false, sinceProofMs: null })]).failures.join("|"), /outside a proof/, "no proof seen yet: judged");
  // a sample without the flags (an older log) is judged
  assert.match(scenarioVerdict(1, [...good1(), at({ cpu: 0, gpu: 70_000 })]).failures.join("|"), /0 H\/s/);
  // nothing outside a proof to judge is a failure of its own, not a pass
  const only = good1().filter((e) => e.ev !== "rates");
  assert.match(scenarioVerdict(1, [...only, at({ cpu: 0, gpu: 70_000, proving: true })]).failures.join("|"), /no processor sample outside a proof to judge/);
  assert.equal(CPU_SETTLE_MS, 5000);
  assert.equal(cpuJudged({ cpu: 0, proving: true }), false);
  assert.equal(cpuJudged({ cpu: 0, proving: false, sinceProofMs: 5000 }), true);
  // scenario 3 follows the same rule
  const three = [
    ...["starting", "ready", "mining", "banned"].map((phase) => ev("state", { phase })), ev("cpu-start", { cpu: 900, ms: 2000 }),
    ev("check", { name: "banned-disabled", ok: true }), ev("check", { name: "cpu-after-ban", ok: true }), ev("check", { name: "stop-start", ok: true }),
  ];
  assert.equal(scenarioVerdict(3, [...three, at({ cpu: 1000, gpu: 0 }), at({ cpu: 0, gpu: 0, proving: true })]).pass, true);
  assert.match(scenarioVerdict(3, [...three, at({ cpu: 0, gpu: 0, proving: false })]).failures.join("|"), /outside a proof/);
  // the activity nudge: two alternating points, well inside the 1280 x 900 viewport, every 20 s (the wallet locks after 5 to 60 minutes of silence)
  assert.deepEqual([activityPoint(0), activityPoint(1), activityPoint(2)], [{ x: 600, y: 400 }, { x: 640, y: 420 }, { x: 600, y: 400 }]);
  assert.equal(ACTIVITY_MS, 20_000);
});

test("the harness source: a MutationObserver keeps every caption of the box, the pointer is nudged, and the processor sample says whether a proof runs", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(new URL("../scripts/e2e-gpu-mine.mjs", import.meta.url), "utf8");
  assert.ok(text.includes("new MutationObserver(note).observe(document.body, { subtree: true, childList: true, characterData: true })"), "no phase is missed between two reads");
  assert.ok(text.indexOf("new MutationObserver") < text.indexOf("emit(\"tick\")"), "installed before the tick");
  assert.ok(text.includes("window.__gpuTexts.splice(0)"));
  assert.ok(text.includes("page.mouse.move(x, y)") && text.includes("clearInterval(keepAwake)"));
  assert.ok(text.includes("proving, sinceProofMs"), "rates carry the proof flag");
  assert.ok(!/emit\("rates", await ratesNow\(\)\)/.test(text), "every rates sample goes through ratesSample");
  // the wallet's own rule the nudge answers: pointermove is activity, and the default is 15 minutes
  const session = readFileSync(new URL("../web/src/session.js", import.meta.url), "utf8");
  assert.ok(/ACTIVITY_EVENTS = \["pointerdown", "pointermove"/.test(session));
});

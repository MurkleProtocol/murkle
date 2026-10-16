// The GPU miner's Node side without a GPU (docs/design/mining.md section 12.2): the protocol with
// the murkle-gpu binary, spoken to a Node stand-in (test/fixtures/fake-gpu.mjs) that can lie, stall
// and crash; binary discovery; the start-up self-test; the vector file; and the release fetcher.
// Nothing here needs CUDA. The real binary is exercised by test/gpu-device.test.mjs when it exists.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { argon2id as nobleArgon2id } from "@noble/hashes/argon2";
import { argon2id as wasmArgon2id } from "hash-wasm";
import { equal, hex, unhex } from "../src/bytes.mjs";
import { GPU_SELF_TEST_VECTORS, GpuError, gpuBinaryPath, gpuSelfTest, listGpus, openGpu } from "../src/gpu.mjs";
import { MINE_SALT, SELF_TEST_VECTORS, nonceOf, passwordOf } from "../src/mine.mjs";
import { createNodePowPool } from "../src/pow-pool.mjs";
import { FAKE_GPU, alive, fakeSpawn, until } from "./fixtures/fake-gpu-spawn.mjs";
import { binaryName, checkGpuBinary, fetchGpuBinary, parseArgs, pinFor } from "../scripts/gpu-fetch.mjs";
import { acceptance, parseBenchArgs, runBench } from "../scripts/gpu-bench.mjs";

const TMP = mkdtempSync(join(tmpdir(), "murkle-gpu-protocol-"));
const BIN = "murkle-gpu-fake"; // never executed: fakeSpawn ignores it
const sha = (...parts) => Uint8Array.from(createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest());
const opened = [];
const open = async (extra = [], opts = {}) => {
  const children = [];
  const dev = await openGpu({ bin: BIN, device: 0, spawn: fakeSpawn(extra, { children, ...opts }), ...(opts.open ?? {}) });
  opened.push(dev);
  return Object.assign(dev, { children });
};
after(async () => {
  await Promise.all(opened.map((d) => d.close().catch(() => {})));
});

const CH = new Uint8Array(32).fill(7);
const searchArgs = (over = {}) => ({ challenge: CH, target: (1n << 256n) - 1n, nonceStart: 100n, count: 64, probe: 3, ...over });
const fakeHash = (counter) => sha(passwordOf(CH, nonceOf(counter)));

/* ------------------------------------------------------------------ hello, hash, search */

test("hello is parsed into info; a wrong protocol, an early exit and no device are refused with their codes", async () => {
  const dev = await open(["--slots", "32", "--name", 'Quote " Name']);
  assert.deepEqual(dev.info, { device: 0, name: 'Quote " Name', cc: "8.9", sms: 4, vramMiB: 1024, slots: 32, hashesPerBlock: 4, version: "1.0.0-fake" });
  await dev.close();

  await assert.rejects(open(["--mode", "bad-protocol"]), (e) => e instanceof GpuError && e.code === "GPU_PROTOCOL" && /speaks protocol 2/.test(e.message));
  await assert.rejects(
    open(["--mode", "early-exit"]),
    (e) => e.code === "GPU_EXITED" && /exited \(3\)/.test(e.message) && /cannot initialise the driver/.test(e.message) && e.stderrTail.length === 1,
  );
  await assert.rejects(open(["--mode", "no-device"]), (e) => e.code === "GPU_NO_DEVICE" && e.message === "no CUDA device found (driver 525 or newer is needed); nothing was mined");
  await assert.rejects(openGpu({ bin: BIN, device: -1, spawn: fakeSpawn() }), RangeError);
});

test("listGpus parses the device lines; no device is GPU_NO_DEVICE; a missing program is GPU_START", async () => {
  assert.deepEqual(await listGpus({ bin: BIN, spawn: fakeSpawn() }), [
    { index: 0, name: "Fake GPU 0", cc: "8.9", vramMiB: 24564 },
    { index: 1, name: "Fake GPU 1", cc: "8.9", vramMiB: 24564 },
  ]);
  await assert.rejects(listGpus({ bin: BIN, spawn: fakeSpawn(["--mode", "no-device"]) }), (e) => e.code === "GPU_NO_DEVICE" && /driver 525 or newer/.test(e.message));
  await assert.rejects(listGpus({ bin: BIN, spawn: fakeSpawn(["--count", "0"]) }), (e) => e.code === "GPU_NO_DEVICE");
  await assert.rejects(listGpus({ bin: join(TMP, "no-such-program"), spawn }), (e) => e.code === "GPU_START");
});

test("hash returns the tags in request order, in chunks of 4096 passwords", async () => {
  const dev = await open(["--slots", "64"]);
  const pws = Array.from({ length: 5000 }, (_, i) => passwordOf(CH, nonceOf(BigInt(i))));
  const tags = await dev.hash(pws);
  assert.equal(tags.length, 5000);
  for (const i of [0, 1, 4095, 4096, 4999]) assert.equal(hex(tags[i]), hex(sha(pws[i])), `tag ${i}`);
  await assert.rejects(dev.hash([new Uint8Array(39)]), TypeError);
  assert.deepEqual(await dev.hash([]), []);
});

test("search: contiguous nonces from the start (mod 2^64), the first batch with a hit ends it, candidates in nonce order, the probe tag", async () => {
  const dev = await open(["--slots", "16"]);
  const r = await dev.search(searchArgs({ count: 100, probe: 5 }));
  assert.equal(r.done, 16n, "stopped after the first batch");
  assert.equal(r.cancelled, false);
  assert.equal(r.candidates.length, 16);
  assert.equal(r.more, 0);
  r.candidates.forEach((c, i) => {
    assert.deepEqual([...c.nonce], [...nonceOf(100n + BigInt(i))]);
    assert.equal(hex(c.hash), hex(fakeHash(100n + BigInt(i))));
  });
  assert.deepEqual([...r.probe.nonce], [...nonceOf(105n)]);
  assert.equal(hex(r.probe.hash), hex(fakeHash(105n)));

  // a miss runs the whole range; the probe lies in a later batch
  const miss = await dev.search(searchArgs({ target: 0n, count: 40, probe: 39 }));
  assert.equal(miss.done, 40n);
  assert.equal(miss.candidates.length, 0);
  assert.equal(hex(miss.probe.hash), hex(fakeHash(139n)));

  // nonces wrap at 2^64
  const wrap = await dev.search(searchArgs({ nonceStart: (1n << 64n) - 2n, count: 4, probe: 3 }));
  assert.deepEqual([...wrap.candidates[3].nonce], [...nonceOf(1n)]);
  assert.deepEqual([...wrap.candidates[0].nonce], [...nonceOf((1n << 64n) - 2n)]);

  // more than 64 hits: the first 64 are listed, the rest counted
  const big = await open(["--slots", "100"]);
  const b = await big.search(searchArgs({ count: 500, probe: 0 }));
  assert.equal(b.done, 100n);
  assert.equal(b.candidates.length, 64);
  assert.equal(b.more, 36);

  // equality is a hit, one less is not
  const exact = BigInt(`0x${hex(fakeHash(100n))}`);
  assert.equal((await dev.search(searchArgs({ target: exact, count: 1, probe: 0 }))).candidates.length, 1);
  assert.equal((await dev.search(searchArgs({ target: exact - 1n, count: 1, probe: 0 }))).candidates.length, 0);
});

test("search refuses bad arguments before sending anything", async () => {
  const sent = [];
  const dev = await open([], { sent });
  const before = sent.length;
  await assert.rejects(dev.search(searchArgs({ probe: 64 })), RangeError);
  await assert.rejects(dev.search(searchArgs({ count: 0, probe: 0 })), RangeError);
  await assert.rejects(dev.search(searchArgs({ count: 1n << 53n })), RangeError);
  await assert.rejects(dev.search(searchArgs({ nonceStart: 1n << 64n })), RangeError);
  await assert.rejects(dev.search(searchArgs({ target: 1n << 256n })), RangeError);
  await assert.rejects(dev.search(searchArgs({ challenge: new Uint8Array(31) })), TypeError);
  assert.equal(sent.length, before);
});

/* ------------------------------------------------------------------ protocol violations */

test("a line that is not JSON, an unknown type, a wrong id or an oversized line is GPU_PROTOCOL and the child is killed", async () => {
  for (const [mode, re] of [
    ["garbage", /not JSON/],
    ["unknown-type", /unknown line type "banana"/],
    ["wrong-id", /answered request 1001 but request 1 is pending/],
    ["oversized", /over 1 MiB/],
  ]) {
    const dev = await open(["--mode", mode]);
    const pid = dev.children[0].pid;
    await assert.rejects(dev.search(searchArgs()), (e) => e.code === "GPU_PROTOCOL" && re.test(e.message), mode);
    await until(() => !alive(pid));
    await assert.rejects(dev.search(searchArgs()), (e) => e.code === "GPU_PROTOCOL", `${mode}: stays failed`);
  }
});

test("a malformed search answer (a candidate beyond done, out of order, a missing probe) is GPU_PROTOCOL", async () => {
  // The stand-in cannot say these, so a tiny script does: it answers every request with the same line.
  const lines = {
    beyond: { done: "10", candidates: [{ nonce: "150", hash: "00".repeat(32) }], more: 0, probe: null },
    order: { done: "10", candidates: [{ nonce: "103", hash: "00".repeat(32) }, { nonce: "102", hash: "00".repeat(32) }], more: 0, probe: null },
    probe: { done: "10", candidates: [], more: 0, probe: null },
    over: { done: "999", candidates: [], more: 0, probe: null },
  };
  for (const [name, body] of Object.entries(lines)) {
    const script = `const rl = require("node:readline").createInterface({ input: process.stdin });
      console.log(JSON.stringify({ type: "hello", protocol: 1, device: 0, name: "x", cc: "8.9", sms: 1, vramMiB: 1, slots: 10, hashesPerBlock: 4 }));
      rl.on("line", (l) => { const id = Number(l.split(" ")[1]); console.log(JSON.stringify({ type: "search", id, ok: true, ms: 1, cancelled: false, ...${JSON.stringify(body)} })); });
      rl.on("close", () => process.exit(0));`;
    const dev = await openGpu({ bin: BIN, device: 0, spawn: (_b, _a, o) => spawn(process.execPath, ["-e", script], o) });
    opened.push(dev);
    await assert.rejects(dev.search(searchArgs({ nonceStart: 100n, count: 20, probe: 5 })), (e) => e.code === "GPU_PROTOCOL", name);
  }
});

test("a silent child is GPU_TIMEOUT and is killed; a crash is GPU_EXITED with the stderr tail", async () => {
  const quiet = await open(["--mode", "silent"]);
  const pid = quiet.children[0].pid;
  await assert.rejects(quiet.search(searchArgs({ timeoutMs: 300 })), (e) => e.code === "GPU_TIMEOUT" && /within 300 ms/.test(e.message));
  await until(() => !alive(pid));

  const crashy = await open(["--mode", "crash-after=1"]);
  assert.equal((await crashy.search(searchArgs())).done, 64n);
  await assert.rejects(crashy.search(searchArgs()), (e) => e.code === "GPU_EXITED" && /exited \(1\)/.test(e.message) && /crashing as asked/.test(e.message) && e.stderrTail.at(-1) === "fake gpu: crashing as asked");
});

test("close sends quit and leaves no child running; end of input also ends the child", async () => {
  const dev = await open();
  const pid = dev.children[0].pid;
  assert.ok(alive(pid));
  await dev.close();
  assert.ok(!alive(pid), "the child is gone after close()");
  await assert.rejects(dev.hash([passwordOf(CH, nonceOf(1n))]), (e) => e.code === "GPU_CLOSED");
  await dev.close(); // closing twice is fine

  const child = spawn(process.execPath, [FAKE_GPU, "--device", "0"], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise((r) => child.once("exit", (code) => r(code)));
  await until(() => alive(child.pid));
  child.stdin.end();
  assert.equal(await exited, 0, "stdin EOF means quit");
});

/* ------------------------------------------------------------------ cancellation */

test("aborting a search sends cancel and returns the partial result; aborting before sending sends nothing", async () => {
  const sent = [];
  const dev = await open(["--mode", "slow"], { sent });
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 150);
  const t0 = Date.now();
  const r = await dev.search(searchArgs({ target: 0n, count: 100_000, probe: 0, signal: ac.signal }));
  assert.ok(Date.now() - t0 < 3000, "returns promptly");
  assert.equal(r.cancelled, true);
  assert.ok(r.done > 0n && r.done < 100_000n);
  assert.equal(r.done % 16n, 0n, "whole batches only");
  assert.deepEqual(r.candidates, []);
  assert.ok(sent.some((l) => /^cancel \d+$/.test(l)));
  assert.ok(r.probe && equal(r.probe.nonce, nonceOf(100n)), "the probe nonce was hashed in the first batch");

  const before = sent.length;
  const stale = new AbortController();
  stale.abort();
  const none = await dev.search(searchArgs({ signal: stale.signal }));
  assert.equal(none.done, 0n);
  assert.equal(none.cancelled, true);
  assert.equal(sent.length, before, "nothing was sent");

  // the device is still good afterwards
  assert.equal((await dev.search(searchArgs({ count: 16, probe: 0 }))).done, 16n);
});

/* ------------------------------------------------------------------ self-test */

// Vectors for the stand-in's sha256 "hash": the self-test takes any list of known answers.
const FAKE_VECTORS = Array.from({ length: 6 }, (_, i) => {
  const password = passwordOf(new Uint8Array(32).fill(i + 1), nonceOf(BigInt(i * 1000)));
  return { name: `fake-${i}`, password: hex(password), powHash: hex(sha(password)) };
});
const verifySha = async (pws) => pws.map((p) => sha(p));
const seq = () => {
  let n = 0;
  return (len) => Uint8Array.from({ length: len }, () => (n += 37) & 0xff);
};

test("the self-test passes an honest device and names what a faulty one gets wrong", async () => {
  const good = await open(["--slots", "70"]);
  assert.deepEqual(await gpuSelfTest(good, { verifyMany: verifySha, vectors: FAKE_VECTORS, randomBytes: seq() }), { vectors: 6, slots: 70 });

  const wrongVector = await open(["--mode", "wrong-vector"]);
  await assert.rejects(gpuSelfTest(wrongVector, { verifyMany: verifySha, vectors: FAKE_VECTORS, randomBytes: seq() }), (e) => e.code === "GPU_SELF_TEST" && /vector fake-0/.test(e.message));

  const strict = await open(["--mode", "strict-target"]);
  await assert.rejects(gpuSelfTest(strict, { verifyMany: verifySha, vectors: FAKE_VECTORS, randomBytes: seq() }), (e) => e.code === "GPU_SELF_TEST" && /boundary: a target equal to the hash/.test(e.message));

  // a wrong hash on a found nonce is caught by the batch search (the reference disagrees)
  const wrongHash = await open(["--mode", "wrong-hash"]);
  await assert.rejects(gpuSelfTest(wrongHash, { verifyMany: verifySha, vectors: FAKE_VECTORS, randomBytes: seq() }), (e) => e.code === "GPU_SELF_TEST");

  // a device that is not the announced size
  const small = await open(["--slots", "70"]);
  small.info.slots = 71;
  await assert.rejects(gpuSelfTest(small, { verifyMany: verifySha, vectors: FAKE_VECTORS, randomBytes: seq() }), (e) => e.code === "GPU_SELF_TEST" && /full batch: 70 nonces were done where 71/.test(e.message));
});

test("one honest run of the self-test through the real Argon2 pool on three vectors", async () => {
  const pool = await createNodePowPool({ size: 2 });
  try {
    assert.equal((await pool.ready()).workers, 2);
    const vectors = GPU_SELF_TEST_VECTORS.slice(0, 3);
    const dev = await open(["--hash", "argon2", "--slots", "8"]);
    const r = await gpuSelfTest(dev, { verifyMany: (p) => pool.hashMany(p), vectors });
    assert.deepEqual(r, { vectors: 3, slots: 8 });
  } finally {
    await pool.close();
  }
});

/* ------------------------------------------------------------------ discovery */

test("binary discovery: MURKLE_GPU_BIN, the default path per platform, and the exact refusals", () => {
  const root = join(TMP, "repo");
  mkdirSync(join(root, "gpu", "bin"), { recursive: true });
  const none = (platform, arch) => gpuBinaryPath({ env: {}, platform, arch, root });
  assert.throws(
    () => none("linux", "x64"),
    (e) => e instanceof GpuError && e.code === "GPU_NO_BINARY" && e.message === "no GPU miner binary for linux-x64: run npm run gpu:fetch, build it (gpu/README.md), or set MURKLE_GPU_BIN; nothing was mined",
  );
  assert.throws(() => none("darwin", "arm64"), /^GpuError: no GPU miner binary for darwin-arm64: run npm run gpu:fetch/);
  writeFileSync(join(root, "gpu", "bin", "murkle-gpu-linux-x64"), "x");
  writeFileSync(join(root, "gpu", "bin", "murkle-gpu-win32-x64.exe"), "x");
  assert.equal(none("linux", "x64"), join(root, "gpu", "bin", "murkle-gpu-linux-x64"));
  assert.equal(none("win32", "x64"), join(root, "gpu", "bin", "murkle-gpu-win32-x64.exe"));
  assert.throws(() => none("linux", "arm64"), /no GPU miner binary for linux-arm64/);

  const own = join(TMP, "mine-gpu");
  writeFileSync(own, "x");
  assert.equal(gpuBinaryPath({ env: { MURKLE_GPU_BIN: own }, platform: "linux", arch: "x64", root }), own);
  const gone = join(TMP, "no-such-file");
  assert.throws(
    () => gpuBinaryPath({ env: { MURKLE_GPU_BIN: gone }, platform: "linux", arch: "x64", root }),
    (e) => e.code === "GPU_NO_BINARY" && e.message === `MURKLE_GPU_BIN is set to "${gone}", but there is no file there; nothing was mined`,
  );
  assert.throws(() => gpuBinaryPath({ env: { MURKLE_GPU_BIN: TMP }, platform: "linux", arch: "x64", root }), /there is no file there/, "a directory is not a binary");
});

/* ------------------------------------------------------------------ vectors */

const FILE = JSON.parse(readFileSync(new URL("./fixtures/gpu-vectors.json", import.meta.url), "utf8"));
const wasm = async (pw) => Uint8Array.from(await wasmArgon2id({ password: pw, salt: MINE_SALT, parallelism: 1, iterations: 1, memorySize: 4096, hashLength: 32, outputType: "binary" }));

test("gpu-vectors.json: 32 deterministic entries covering the nonce edges, all-zero and all-ones, each tag from noble and from hash-wasm", async () => {
  assert.equal(FILE.format, "murkle-gpu-vectors/1");
  assert.deepEqual(FILE.argon2, { type: "argon2id", version: 19, memoryKiB: 4096, passes: 1, lanes: 1, tagLength: 32, salt: "murkle/mine/salt" });
  const v = FILE.vectors;
  assert.equal(v.length, 32);
  const nonceOfEntry = (x) => new DataView(unhex(x.password).buffer).getBigUint64(32, true);
  const nonces = new Set(v.map(nonceOfEntry));
  for (const n of [0n, 1n, 0xffffffffn, 1n << 32n, 1n << 63n, (1n << 64n) - 1n]) assert.ok(nonces.has(n), `nonce ${n}`);
  assert.ok(v.some((x) => x.password === "00".repeat(40)), "all zeros");
  assert.ok(v.some((x) => x.password === "ff".repeat(40)), "all ones");
  assert.equal(new Set(v.map((x) => x.password)).size, 32);
  for (const x of v) {
    assert.match(x.password, /^[0-9a-f]{80}$/);
    assert.match(x.tag, /^[0-9a-f]{64}$/);
  }
  // every tag again, with both implementations
  for (const x of v) {
    const pw = unhex(x.password);
    assert.equal(hex(nobleArgon2id(pw, MINE_SALT, { t: 1, m: 4096, p: 1, dkLen: 32 })), x.tag, `noble ${x.name}`);
    assert.equal(hex(await wasm(pw)), x.tag, `hash-wasm ${x.name}`);
  }
});

test("GPU_SELF_TEST_VECTORS are entries of gpu-vectors.json; the default self-test list adds the 40-byte SELF_TEST_VECTORS", () => {
  assert.equal(GPU_SELF_TEST_VECTORS.length, 16);
  assert.ok(Object.isFrozen(GPU_SELF_TEST_VECTORS));
  GPU_SELF_TEST_VECTORS.forEach((g, i) => {
    assert.deepEqual({ name: g.name, password: g.password, powHash: g.powHash }, { name: FILE.vectors[i].name, password: FILE.vectors[i].password, powHash: FILE.vectors[i].tag });
  });
  assert.equal(SELF_TEST_VECTORS.filter((x) => !x.salt && x.password.length === 80).length, 4);
});

/* ------------------------------------------------------------------ gpu:fetch */

test("gpu:fetch refuses an unpinned platform and a sha256 mismatch, and installs a matching download", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const good = createHash("sha256").update(bytes).digest("hex");
  const pins = { version: "1.0.0", files: { "linux-x64": { sha256: good, url: "https://example.org/murkle-gpu-linux-x64" } } };
  const answer = (body, ok = true, status = 200) => async () => ({ ok, status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) });
  const dest = join(TMP, "fetch");

  assert.throws(() => pinFor({ files: {} }, "linux", "x64"), /pins no binary for linux-x64 yet/);
  assert.throws(() => pinFor(pins, "darwin", "arm64"), /only linux-x64 and win32-x64 are supported/);
  assert.throws(() => pinFor({ files: { "linux-x64": { sha256: "zz", url: "http://x" } } }, "linux", "x64"), /malformed/);
  await assert.rejects(fetchGpuBinary({ pins, platform: "linux", arch: "x64", dest, fetchImpl: answer(new Uint8Array([9, 9])) }), /sha256 mismatch.*nothing was written/);
  assert.equal(checkGpuBinary({ pins, platform: "linux", arch: "x64", dest }).sha256, null, "nothing was written");
  await assert.rejects(fetchGpuBinary({ pins, platform: "linux", arch: "x64", dest, fetchImpl: answer(bytes, false, 404) }), /HTTP 404/);
  await assert.rejects(fetchGpuBinary({ pins, platform: "linux", arch: "x64", dest, fetchImpl: async () => { throw new Error("offline"); } }), /could not download .*offline/);

  const r = await fetchGpuBinary({ pins, platform: "linux", arch: "x64", dest, fetchImpl: answer(bytes) });
  assert.equal(r.status, "downloaded");
  assert.equal(r.path, join(dest, binaryName("linux", "x64")));
  assert.deepEqual([...readFileSync(r.path)], [...bytes]);
  assert.equal(checkGpuBinary({ pins, platform: "linux", arch: "x64", dest }).matches, true);
  const again = await fetchGpuBinary({ pins, platform: "linux", arch: "x64", dest, fetchImpl: async () => { throw new Error("must not download"); } });
  assert.equal(again.status, "present");
  assert.equal(binaryName("win32", "x64"), "murkle-gpu-win32-x64.exe");
  assert.deepEqual(parseArgs(["--force", "--dest", dest]).force, true);
  assert.throws(() => parseArgs(["--nope"]), /unknown argument/);

  const shipped = JSON.parse(readFileSync(new URL("../gpu/pins.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(shipped), ["version", "files"]);
  assert.equal(shipped.version, "1.0.0");
  for (const [k, p] of Object.entries(shipped.files)) {
    assert.match(k, /^(linux|win32)-x64$/);
    assert.match(p.sha256, /^[0-9a-f]{64}$/);
    assert.match(p.url, /^https:\/\//);
  }
});

test("gpu:fetch from the command line reads the pins file it is given (the --check path, no network)", () => {
  const bytes = new Uint8Array([7, 7, 7]);
  const dir = join(TMP, "fetch-cli");
  mkdirSync(dir, { recursive: true });
  const pinsFile = join(dir, "pins.json");
  const pins = { version: "1.0.0", files: { "linux-x64": { sha256: createHash("sha256").update(bytes).digest("hex"), url: "https://example.org/x" } } };
  writeFileSync(pinsFile, JSON.stringify(pins));
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL("../scripts/gpu-fetch.mjs", import.meta.url)), "--pins", pinsFile, "--dest", dir, "--platform", "linux", "--arch", "x64", "--check"], { encoding: "utf8" });
  let r = run();
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /murkle-gpu-linux-x64 is missing/);
  writeFileSync(join(dir, binaryName("linux", "x64")), bytes);
  r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /matches its pin/);
});

/* ------------------------------------------------------------------ gpu:bench */

test("gpu:bench runs end to end against the stand-in: correctness, sweep, lane, and the acceptance table", async () => {
  const o = parseBenchArgs(["--fake", "--only", "correctness,sweep,lane", "--random", "64", "--noble", "4", "--seconds", "0.3", "--runs", "1", "--lane-seconds", "1", "--difficulty", "2", "--workers", "2"]);
  const report = await runBench(o, { log: () => {} });
  assert.equal(report.correctness.mismatches, 0, report.correctness.notes.join(", "));
  assert.equal(report.correctness.vectors, 32);
  assert.equal(report.correctness.boundary, 32);
  assert.equal(report.correctness.noble, 4);
  assert.equal(report.sweep.rows.length, 12, "3 fractions x 4 values of W");
  assert.deepEqual(report.sweep.rows.map((r) => r.hashesPerBlock), [1, 2, 4, 8, 1, 2, 4, 8, 1, 2, 4, 8]);
  assert.ok(report.sweep.rows.every((r) => r.runs.length === 1 && r.runs[0].hs > 0 && r.runs[0].cancelMs < 2000));
  assert.equal(report.lane.gpuWrong, 0);
  assert.ok(report.lane.verified >= 1 && report.lane.reportedHits >= report.lane.verified);
  assert.ok(report.acceptance.every((r) => r.ok !== false), JSON.stringify(report.acceptance));

  // the acceptance figures of the plan
  const fast = { sweep: { best: { meanHs: 60_000, best: { util: 97, gpuProcessCpuPct: 10, nodeCpuPct: 5 } }, rows: [{ runs: [{ cancelMs: 100, startMs: 3000 }] }] }, correctness: { mismatches: 0, selfTestMs: 1000 } };
  assert.ok(acceptance(fast, "NVIDIA GeForce RTX 4090").every((r) => r.ok));
  assert.equal(acceptance({ ...fast, sweep: { ...fast.sweep, best: { ...fast.sweep.best, meanHs: 40_000 } } }, "NVIDIA GeForce RTX 4090").find((r) => /4090/.test(r.measure)).ok, false);
  assert.equal(acceptance({ ...fast, correctness: { mismatches: 1 } }, "").find((r) => r.measure === "Correctness mismatches").ok, false);
  // against the stand-in the hardware rows are informational: on Linux it hashes on the CPU and would read 130 % of a core
  const hot = { ...fast, sweep: { ...fast.sweep, best: { ...fast.sweep.best, best: { util: 10, gpuProcessCpuPct: 130, nodeCpuPct: 5 } } } };
  assert.equal(acceptance(hot, "NVIDIA GeForce RTX 4090").find((r) => r.measure === "Host CPU per GPU").ok, false);
  const standIn = acceptance(hot, "NVIDIA GeForce RTX 4090", { fake: true });
  assert.ok(standIn.every((r) => r.ok !== false));
  assert.ok(standIn.filter((r) => r.note === "stand-in").length >= 4);
  assert.equal(acceptance({ ...hot, correctness: { mismatches: 1 } }, "", { fake: true }).find((r) => r.measure === "Correctness mismatches").ok, false);
  assert.throws(() => parseBenchArgs(["--only", "nope"]), /unknown step/);
  assert.throws(() => parseBenchArgs(["--bogus"]), /unknown argument/);
});

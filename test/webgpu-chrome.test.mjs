// scripts/webgpu-chrome.mjs without Chrome or a GPU: the argument parser, the refusal (exit code 2 before puppeteer is
// imported or any browser starts), the launch flags, and the whole run over a stand-in browser and page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CHROME_FLAGS, chromeLabOk, launchOptions, parseChromeArgs, runChromeLab } from "../scripts/webgpu-chrome.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/webgpu-chrome.mjs", import.meta.url));
const URL_OK = "http://127.0.0.1:4173/lab-gpu.html";

test("argument parsing: the page must be local, numbers and refusals", () => {
  const o = parseChromeArgs(["--url", URL_OK, "--chrome", "/opt/chrome/chrome", "--memory", "2048", "--hpw", "4", "--seconds", "30", "--correct", "500", "--hidden", "0", "--out", "r.jsonl", "--keep-swiftshader"]);
  assert.deepEqual([o.url, o.chrome, o.memory, o.hpw, o.seconds, o.correct, o.hidden, o.out, o.keepSwiftshader], [URL_OK, "/opt/chrome/chrome", 2048, 4, 30, 500, 0, "r.jsonl", true]);
  const d = parseChromeArgs(["--url", "http://localhost:5173/lab-gpu.html"]);
  assert.deepEqual([d.memory, d.hpw, d.seconds, d.correct, d.hidden, d.keepSwiftshader], [1024, 2, 60, 2000, 60, false]);
  assert.throws(() => parseChromeArgs([]), /--url is needed/);
  assert.throws(() => parseChromeArgs(["--url", "https://example.com/lab-gpu.html"]), /127\.0\.0\.1 or localhost/);
  assert.throws(() => parseChromeArgs(["--url", "http://127.0.0.1.evil.example/x"]), /127\.0\.0\.1 or localhost/);
  assert.throws(() => parseChromeArgs(["--url", URL_OK, "--hpw", "3"]), /hpw/);
  assert.throws(() => parseChromeArgs(["--url", URL_OK, "--seconds", "0"]), /seconds/);
  assert.throws(() => parseChromeArgs(["--url", URL_OK, "--nope"]), /unknown argument/);
  assert.throws(() => parseChromeArgs(["--url"]), /needs a value/);
});

test("without MURKLE_WEBGPU=gpu the script exits with code 2 and names the reason, before it imports puppeteer", () => {
  const env = { ...process.env };
  delete env.MURKLE_WEBGPU;
  delete env.VK_ICD_FILENAMES;
  delete env.VK_DRIVER_FILES;
  const r = spawnSync(process.execPath, [SCRIPT, "--url", URL_OK], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /WebGPU is disabled here/);
  assert.equal(r.stdout, "");
  const fallback = spawnSync(process.execPath, [SCRIPT, "--url", URL_OK], { env: { ...env, MURKLE_WEBGPU: "fallback" }, encoding: "utf8", timeout: 30_000 });
  assert.equal(fallback.status, 2, "fallback is not the mode of this script");
  const noUrl = spawnSync(process.execPath, [SCRIPT], { env: { ...env, MURKLE_WEBGPU: "gpu" }, encoding: "utf8", timeout: 30_000 });
  assert.equal(noUrl.status, 2);
  assert.match(noUrl.stderr, /--url is needed/);
});

test("launch options: the Chrome flags of the spec, and every default SwiftShader flag dropped", () => {
  assert.ok(CHROME_FLAGS.includes("--headless=new") && CHROME_FLAGS.includes("--no-sandbox") && CHROME_FLAGS.includes("--enable-unsafe-webgpu"));
  assert.ok(CHROME_FLAGS.includes("--enable-features=Vulkan") && CHROME_FLAGS.includes("--use-angle=vulkan") && CHROME_FLAGS.includes("--disable-vulkan-surface"));
  assert.ok(CHROME_FLAGS.includes("--enable-dawn-features=allow_unsafe_apis,disable_adapter_blocklist"));
  assert.equal(CHROME_FLAGS.some((f) => /swiftshader/i.test(f)), false);
  const defaults = ["--disable-extensions", "--enable-unsafe-swiftshader", "--use-gl=swiftshader", "--mute-audio"];
  const o = launchOptions({ chrome: "/c/chrome", keepSwiftshader: false }, defaults);
  assert.deepEqual(o.ignoreDefaultArgs, ["--enable-unsafe-swiftshader", "--use-gl=swiftshader"]);
  assert.equal(o.executablePath, "/c/chrome");
  assert.deepEqual(o.args, [...CHROME_FLAGS]);
  assert.equal(launchOptions({ chrome: null, keepSwiftshader: true }, defaults).ignoreDefaultArgs, false);
});

function fakeBrowser({ open = { ok: true, name: "NVIDIA GeForce RTX 4090", info: { vendor: "nvidia", architecture: "ada", name: "NVIDIA GeForce RTX 4090", fallback: false } }, mismatches = 0, hasLab = true } = {}) {
  const calls = [];
  const lab = {
    open: async (o) => (calls.push(["open", o]), open),
    selfTest: async () => (calls.push(["selfTest"]), { vectors: 20, slots: 4096, ms: 900 }),
    bench: async (s) => (calls.push(["bench", s]), { seconds: s, hashes: 100 * s, hs: 100, ticks: [{ second: 1, hs: 100, visibility: "visible" }] }),
    correct: async (n) => (calls.push(["correct", n]), { n, mismatches, first: [] }),
    hidden: async (s) => (calls.push(["hidden", s]), { seconds: s, hashes: 1, hs: 1, ticks: [{ second: 1, hs: 50, visibility: "hidden" }], visibleSeconds: 3, hiddenSeconds: 3, hsVisible: 100, hsHidden: 50, ratio: 0.5 }),
    close: async () => (calls.push(["close"]), { closed: true }),
  };
  const newPage = async () => ({
    on() {},
    goto: async (u) => calls.push(["goto", u]),
    evaluate: async (fn, name, args) => (name === undefined ? hasLab : lab[name](...args)),
    bringToFront: async () => calls.push(["front"]),
    close: async () => {},
  });
  return { browser: { newPage }, calls };
}

test("runChromeLab: open, self-test, benchmark, correctness, the hidden-tab test with a second tab in front, then close", async () => {
  const { browser, calls } = fakeBrowser();
  const emitted = [];
  const results = await runChromeLab({ url: URL_OK, memory: 1024, hpw: 2, seconds: 5, correct: 100, hidden: 6 }, { browser, emit: (a, d) => emitted.push([a, d]), log: () => {}, settleMs: 0 });
  assert.deepEqual(emitted.map(([a]) => a), ["open", "selfTest", "bench", "correct", "hidden"]);
  assert.equal(results.open.adapterIsNvidia, true);
  assert.equal(results.open.vendor, "nvidia");
  assert.equal(results.bench.hs, 100);
  assert.equal(results.correct.mismatches, 0);
  assert.equal(results.hidden.ratio, 0.5);
  assert.deepEqual(calls.find(([n]) => n === "open")[1], { memoryMiB: 1024, hpw: 2 });
  assert.deepEqual(calls.filter(([n]) => ["bench", "correct", "hidden"].includes(n)), [["bench", 5], ["correct", 100], ["hidden", 6]]);
  assert.ok(calls.filter(([n]) => n === "front").length >= 2, "the second tab came to the front, then the lab tab again");
  assert.equal(calls.at(-1)[0], "close");
  assert.equal(chromeLabOk(results), true);
});

test("runChromeLab: a page that is not a lab build, a GPU that will not open, and a mismatch each fail the verdict", async () => {
  const quick = { url: URL_OK, memory: 1, hpw: 2, seconds: 1, correct: 1, hidden: 0 };
  const none = fakeBrowser({ hasLab: false });
  const r1 = await runChromeLab(quick, { browser: none.browser, log: () => {} });
  assert.match(r1.open.reason, /not a MURKLE_LAB=1 build/);
  assert.equal(chromeLabOk(r1), false);
  const off = fakeBrowser({ open: { ok: false, reason: "This browser has no WebGPU." } });
  const r2 = await runChromeLab(quick, { browser: off.browser, log: () => {} });
  assert.equal(r2.open.ok, false);
  assert.equal(r2.selfTest, undefined, "nothing else runs on a lane that did not open");
  assert.equal(chromeLabOk(r2), false);
  const bad = fakeBrowser({ mismatches: 2 });
  const r3 = await runChromeLab({ ...quick, correct: 10 }, { browser: bad.browser, log: () => {} });
  assert.equal(r3.correct.mismatches, 2);
  assert.equal(r3.hidden, undefined, "--hidden 0 skips the hidden-tab test");
  assert.equal(chromeLabOk(r3), false);
});

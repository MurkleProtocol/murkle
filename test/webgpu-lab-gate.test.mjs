// The hidden WebGPU lab stays hidden: the guard's verdicts, the Vite plugin (stub or real module, lab page only
// when asked for), MURKLE_LAB in the Vite config and the build marker, the server's refusal of a lab dist on
// mainnet, and a default build that carries no WebGPU code (proved on the module graph of the page, and by one real
// build when MURKLE_SLOW_TESTS=1). The GPU lane of MineController is driven with fake workers.
// No GPU, no navigator.gpu, no `webgpu` package, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "./fixtures/lab-virtual-register.mjs"; // "virtual:murkle-lab" (imported by app-mine.js) is the stub outside Vite
import { mergeConfig } from "vite";
import { assertWebGpuAllowed } from "../src/webgpu/guard.mjs";
import { LAB_INDEX, LAB_MODULE, LAB_PAGE, LAB_STUB, murkleLab } from "../web/lab-plugin.mjs";
import { checkWebBuild } from "../server/indexer-server.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB = join(ROOT, "web");
const SLOW = process.env.MURKLE_SLOW_TESTS === "1";
const read = (p) => readFileSync(join(ROOT, p), "utf8");
// scratch directories live under the repo's gitignored .tmp/, not in the OS temp dir; they are never deleted by a test
const scratch = (name) => {
  const base = join(ROOT, ".tmp", "test-scratch");
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `murkle-${name}-`));
};

/* ---------- the guard ---------- */

test("guard: an empty environment is refused, and so are win32 + fallback and a fallback with an NVIDIA ICD", () => {
  const refused = (args) => assert.throws(() => assertWebGpuAllowed({ browser: false, ...args }), (e) => e.code === "GPU_NO_DEVICE" && /WebGPU is disabled here/.test(e.message));
  refused({ env: {}, platform: "linux", mode: "gpu" });
  refused({ env: {}, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: "lvp_icd.x86_64.json" }, platform: "win32", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/nvidia_icd.json" }, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json:/usr/share/vulkan/icd.d/nvidia_icd.json" }, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback" }, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json" }, platform: "linux", mode: "gpu" });
});

test("guard: a Linux fallback pinned to a lavapipe ICD is allowed, and gpu with MURKLE_WEBGPU=gpu; a browser always passes", () => {
  assert.doesNotThrow(() => assertWebGpuAllowed({ browser: false, env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json" }, platform: "linux", mode: "fallback" }));
  assert.doesNotThrow(() => assertWebGpuAllowed({ browser: false, env: { MURKLE_WEBGPU: "gpu" }, platform: "linux", mode: "gpu" }));
  assert.doesNotThrow(() => assertWebGpuAllowed({ browser: false, env: { MURKLE_WEBGPU: "gpu" }, platform: "win32", mode: "gpu" }));
  assert.doesNotThrow(() => assertWebGpuAllowed({ browser: true, env: {}, platform: "win32", mode: "gpu" }));
});

/* ---------- the plugin ---------- */

test("plugin off: virtual:murkle-lab is the empty stub, nothing is added to the build, the lab page answers 404 in the dev server", async () => {
  const p = murkleLab(false);
  assert.equal(p.name, "murkle-lab");
  const id = p.resolveId(LAB_MODULE);
  assert.ok(typeof id === "string" && id.startsWith("\0"), "a virtual id");
  assert.equal(p.load(id), "export const labGpu = null;\n");
  assert.equal(p.load(id), LAB_STUB);
  assert.equal(p.resolveId("./other.js"), null);
  assert.equal(p.load("/some/file.js"), null);
  assert.equal(p.config(), null, "no build input is added");

  let middleware = null;
  p.configureServer({ middlewares: { use: (fn) => (middleware = fn) } });
  assert.ok(middleware, "the dev server gets a guard");
  const res = (() => {
    const r = { statusCode: 200, headers: {}, body: null, setHeader(k, v) { r.headers[k] = v; }, end(b) { r.body = b; } };
    return r;
  })();
  let passed = 0;
  middleware({ url: "/lab-gpu.html?x=1" }, res, () => passed++);
  assert.equal(res.statusCode, 404);
  assert.equal(passed, 0);
  middleware({ url: "/index.html" }, res, () => passed++);
  middleware({ url: "/app/mine?gpu=1" }, res, () => passed++);
  assert.equal(passed, 2, "other pages pass through");
});

test("plugin on: virtual:murkle-lab is web/src/lab/index.js and lab-gpu.html joins the build inputs next to index.html", () => {
  const p = murkleLab(true);
  assert.equal(p.resolveId(LAB_MODULE), LAB_INDEX);
  assert.equal(LAB_INDEX, join(WEB, "src", "lab", "index.js"));
  assert.ok(existsSync(LAB_INDEX) && existsSync(LAB_PAGE));
  assert.equal(p.load(LAB_INDEX), null, "the real file is loaded by Vite itself");
  const added = p.config();
  assert.deepEqual(added, { build: { rollupOptions: { input: { lab: LAB_PAGE } } } });
  // Vite merges it with the config's own input rather than replacing it
  const merged = mergeConfig({ build: { rollupOptions: { input: { index: join(WEB, "index.html") } } } }, added);
  assert.deepEqual(Object.keys(merged.build.rollupOptions.input).sort(), ["index", "lab"]);
  let used = false;
  p.configureServer({ middlewares: { use: () => (used = true) } });
  assert.equal(used, false, "the dev server serves the lab page when the lab is on");
});

/* ---------- MURKLE_LAB in the Vite config and the build marker ---------- */

const child = (code, env = {}) =>
  new Promise((done, fail) => {
    execFile(process.execPath, ["--input-type=module", "-e", code], { cwd: ROOT, env: { ...process.env, MURKLE_NETWORK: "", ...env }, timeout: 120_000, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) return fail(new Error(`${err.message}\n${stderr}`));
      try {
        done(JSON.parse(stdout.trim().split("\n").pop()));
      } catch {
        fail(new Error(`bad child output: ${stdout}\n${stderr}`));
      }
    });
  });

test("Vite config: MURKLE_LAB is 1, or unset, or empty; anything else refuses to build; the marker records lab", async () => {
  const dir = scratch("lab-marker");
  const code = `
    import { resolveConfig } from "vite";
    import { readFileSync } from "node:fs";
    const cfg = await resolveConfig({ configFile: "web/vite.config.mjs", root: ${JSON.stringify(dir)} }, "build");
    const names = cfg.plugins.map((p) => p.name);
    const marker = cfg.plugins.find((p) => p.name === "murkle-build-marker");
    marker.configResolved(cfg);
    marker.closeBundle();
    console.log(JSON.stringify({ names, input: Object.keys(cfg.build.rollupOptions.input), marker: JSON.parse(readFileSync(${JSON.stringify(join(dir, "dist", "murkle-build.json"))}, "utf8")) }));`;
  const off = await child(code, { MURKLE_LAB: "" });
  assert.ok(off.names.includes("murkle-lab"));
  assert.deepEqual(off.input, ["index"], "a default build has the app page only");
  assert.equal(off.marker.lab, false);
  const unset = await child(code.replace("MURKLE_LAB", "MURKLE_LAB"), {});
  assert.equal(unset.marker.lab, false);
  const on = await child(code, { MURKLE_LAB: "1" });
  assert.deepEqual(on.input.sort(), ["index", "lab"], "a lab build adds the lab page");
  assert.equal(on.marker.lab, true);
  assert.equal(on.marker.network, "signet");
  for (const bad of ["0", "true", "yes", "2", " 1"]) {
    await assert.rejects(child(code, { MURKLE_LAB: bad }), /MURKLE_LAB must be "1" or unset/, `MURKLE_LAB=${JSON.stringify(bad)}`);
  }
});

/* ---------- the server's refusal ---------- */

test("server: a dist whose marker says lab: true is refused on mainnet unless MURKLE_ALLOW_LAB=1; signet and non-lab builds are served", () => {
  const dist = scratch("lab-dist");
  const marker = (m) => writeFileSync(join(dist, "murkle-build.json"), JSON.stringify({ manifestSha256: null, genesisTxid: null, ...m }));
  marker({ network: "mainnet", lab: true });
  const refused = checkWebBuild(dist, "mainnet", { allowLab: false });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /lab build/);
  assert.match(refused.message, /MURKLE_ALLOW_LAB=1/);
  assert.deepEqual(checkWebBuild(dist, "mainnet", { allowLab: true }), { ok: true, network: "mainnet", message: null });
  marker({ network: "mainnet", lab: false });
  assert.equal(checkWebBuild(dist, "mainnet", { allowLab: false }).ok, true);
  marker({ network: "mainnet" });
  assert.equal(checkWebBuild(dist, "mainnet", { allowLab: false }).ok, true, "a marker from before the lab has no lab key");
  marker({ network: "signet", lab: true });
  assert.equal(checkWebBuild(dist, "signet", { allowLab: false }).ok, true, "a lab build runs on signet");
  marker({ network: "signet", lab: true });
  assert.equal(checkWebBuild(dist, "mainnet", { allowLab: true }).ok, false, "the network check still applies");
  // The default reads MURKLE_ALLOW_LAB at call time.
  marker({ network: "mainnet", lab: true });
  const saved = process.env.MURKLE_ALLOW_LAB;
  try {
    delete process.env.MURKLE_ALLOW_LAB;
    assert.equal(checkWebBuild(dist, "mainnet").ok, false);
    process.env.MURKLE_ALLOW_LAB = "1";
    assert.equal(checkWebBuild(dist, "mainnet").ok, true);
    process.env.MURKLE_ALLOW_LAB = "true";
    assert.equal(checkWebBuild(dist, "mainnet").ok, false, "only the value 1 allows it");
  } finally {
    if (saved === undefined) delete process.env.MURKLE_ALLOW_LAB;
    else process.env.MURKLE_ALLOW_LAB = saved;
  }
});

/* ---------- a default build carries no WebGPU code ---------- */

// The module graph of a page, the way Vite follows it: imports, dynamic imports, `new URL("./x.js", import.meta.url)`
// workers and import.meta.glob. Bare specifiers (packages) and CSS are not followed; "virtual:murkle-lab" resolves
// to what the plugin gives (the stub, or the lab index).
function graph(entries, lab) {
  const seen = new Map();
  const queue = [...entries];
  // a block comment starts at a line start or after a space ("./views/*.js" in a glob string is not one)
  const strip = (t) => t.replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  while (queue.length) {
    const file = resolve(queue.pop());
    if (seen.has(file)) continue;
    const text = readFileSync(file, "utf8");
    seen.set(file, text);
    if (!/\.(m?js)$/.test(file)) continue;
    const code = strip(text);
    const specs = new Set();
    for (const m of code.matchAll(/(?:^|[;\s}])(?:import|export)\s[^"'`;]*?from\s*["']([^"']+)["']/g)) specs.add(m[1]);
    for (const m of code.matchAll(/(?:^|[;\s])import\s*["']([^"']+)["']/g)) specs.add(m[1]);
    for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.add(m[1]);
    for (const m of code.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) specs.add(m[1]);
    for (const m of code.matchAll(/import\.meta\.glob\(\s*["']([^"']+)["']\s*\)/g)) {
      const dir = dirname(join(dirname(file), m[1]));
      for (const f of readdirSync(dir)) if (/\.js$/.test(f)) specs.add(`./${join(dirname(m[1]), f).replace(/\\/g, "/")}`);
    }
    for (const s of specs) {
      if (s === LAB_MODULE) {
        if (lab) queue.push(LAB_INDEX);
        continue;
      }
      if (!s.startsWith(".")) continue;
      const target = join(dirname(file), s);
      if (/\.(css|json|wasm|png|svg)$/.test(target) || !existsSync(target) || !statSync(target).isFile()) continue;
      queue.push(target);
    }
  }
  return seen;
}

const WEBGPU_WORDS = /requestAdapter|murkle-webgpu-kernel|lab-gpu|navigator\.gpu|[\\/]webgpu[\\/]/;

test("a default build carries no WebGPU code: nothing the app page reaches mentions the adapter, the kernel or the lab page", () => {
  const app = graph([join(WEB, "src", "app.js")], false);
  assert.ok(app.size > 60, `the app graph was followed (${app.size} files)`);
  assert.ok([...app.keys()].some((f) => f.endsWith(join("views", "app-mine.js"))), "the mine view is part of the app");
  const bad = [...app].filter(([, text]) => WEBGPU_WORDS.test(text)).map(([f]) => f.replace(ROOT, ""));
  assert.deepEqual(bad, [], "no file of the default graph mentions WebGPU");
  assert.equal([...app.keys()].some((f) => /[\\/]lab[\\/]|[\\/]webgpu[\\/]|gpu-gate|lab-gpu/.test(f)), false, "no lab, webgpu or gate module is reachable");
  const html = read("web/index.html");
  assert.equal(/lab-gpu|webgpu/i.test(html), false, "index.html does not name the lab page");
});

test("a lab build carries it: through virtual:murkle-lab the app page reaches the worker, the engine and the kernel", () => {
  const lab = graph([join(WEB, "src", "app.js")], true);
  const files = [...lab.keys()].map((f) => f.replace(ROOT, "").replace(/\\/g, "/"));
  for (const f of ["web/src/lab/index.js", "web/src/lab/gpu-worker.js", "src/webgpu/engine.mjs", "src/webgpu/argon2.wgsl.mjs", "src/webgpu/guard.mjs", "src/gpu-gate.mjs"]) {
    assert.ok(files.some((x) => x.endsWith(f)), `${f} is reachable`);
  }
  const all = [...lab.values()].join("\n");
  assert.match(all, /requestAdapter/);
  assert.match(all, /murkle-webgpu-kernel/);
  // the standalone lab page reaches the lab controller, the pool worker and the page script
  const page = graph([join(WEB, "src", "lab", "lab-gpu.js"), join(WEB, "src", "lab", "lab-style.js")], true);
  const pageFiles = [...page.keys()].map((f) => f.replace(ROOT, "").replace(/\\/g, "/"));
  assert.ok(pageFiles.some((f) => f.endsWith("web/src/lab/pow-pool-worker.js")));
  assert.ok(pageFiles.some((f) => f.endsWith("web/src/lab/gpu-worker.js")));
  const html = read("web/lab-gpu.html");
  assert.match(html, /\/src\/lab\/lab-gpu\.js/);
  assert.match(html, /Prototype\. Uses this device's GPU only after you press a button\./);
  assert.equal(/<script[^>]*>[^<]/.test(html), false, "no inline script (the CSP forbids it)");
});

test("a real default signet build in a scratch directory has no file with requestAdapter, murkle-webgpu-kernel or lab-gpu", { skip: !SLOW && "MURKLE_SLOW_TESTS=1 runs a real vite build" }, async () => {
  const out = scratch("lab-build");
  const dist = join(out, "dist");
  await new Promise((done, fail) => {
    const env = { ...process.env };
    delete env.MURKLE_LAB;
    env.MURKLE_NETWORK = "";
    execFile(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "web/vite.config.mjs", "--outDir", dist, "--emptyOutDir"], { cwd: ROOT, env, timeout: 600_000, maxBuffer: 1 << 26 }, (err, _o, stderr) => (err ? fail(new Error(`${err.message}\n${stderr}`)) : done()));
  });
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) (f.isDirectory() ? walk(join(d, f.name)) : files.push(join(d, f.name)));
  };
  walk(dist);
  assert.ok(files.length > 10);
  assert.equal(files.some((f) => f.endsWith("lab-gpu.html")), false);
  for (const f of files) {
    if (!/\.(js|html|css|json|mjs)$/.test(f)) continue;
    assert.equal(/requestAdapter|murkle-webgpu-kernel|lab-gpu/.test(readFileSync(f, "utf8")), false, `${f} is free of WebGPU code`);
  }
  assert.equal(JSON.parse(readFileSync(join(dist, "murkle-build.json"), "utf8")).lab, false);
});

/* ---------- the app-mine view: an optional GPU lane that never disturbs the CPU lanes ---------- */

const MINEVIEW = await import("../web/src/views/app-mine.js");
const SHARED = await import("../web/src/views/app-shared.js");

const tick = () => new Promise((r) => setImmediate(r));
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};
function fakeWorkers() {
  const all = [];
  const spawn = () => {
    const w = { posts: [], terminated: false, onmessage: null, postMessage(m) { this.posts.push(m); }, terminate() { this.terminated = true; } };
    w.emit = (data) => w.onmessage({ data });
    all.push(w);
    return w;
  };
  return { all, spawn };
}
function lanes({ gpu = true } = {}) {
  const cpu = fakeWorkers();
  const g = fakeWorkers();
  const found = [];
  const changes = [];
  let n = 0;
  let clock = 0;
  const prepared = [];
  const ctl = new MINEVIEW.MineController({
    spawn: cpu.spawn,
    gpuSpawn: gpu ? g.spawn : null,
    prepare: async () => {
      n += 1;
      const p = { draft: { n }, challenge: String(n).padStart(2, "0").repeat(32), target: "0f".repeat(32) };
      prepared.push(p);
      return p;
    },
    onFound: (f) => found.push(f),
    onChange: (t) => changes.push(t),
    now: () => clock,
  });
  return { ctl, cpu, g, found, changes, prepared, setClock: (t) => (clock = t) };
}
const startsOf = (w) => w.posts.filter((m) => m.type === "start");

test("MineController without a GPU spawn behaves as before: enableGpu does nothing", async () => {
  const { ctl, cpu, g } = lanes({ gpu: false });
  ctl.enableGpu(true);
  assert.equal(ctl.gpu, null);
  assert.equal(g.all.length, 0);
  await ctl.start(2);
  assert.equal(cpu.all.length, 2);
  assert.deepEqual(ctl.hashrateByLane(), { cpu: 0, gpu: 0 });
  ctl.enableGpu(false);
  ctl.terminate();
});

test("enableGpu: the worker is spawned and told to open; it joins the challenge in progress once it is ready, outside the thread count", async () => {
  const { ctl, cpu, g, prepared } = lanes();
  await ctl.start(2);
  ctl.enableGpu(true);
  assert.equal(g.all.length, 1);
  assert.deepEqual(g.all[0].posts, [{ type: "open" }]);
  assert.equal(ctl.gpu.state, "opening");
  assert.equal(startsOf(g.all[0]).length, 0, "no start before ready");
  ctl.enableGpu(true);
  assert.equal(g.all.length, 1, "a second enable does not spawn again");
  assert.equal(ctl.workers.length, 2, "the thread count is CPU only");
  assert.equal(cpu.all.length, 2);

  g.all[0].emit({ type: "gpu-info", info: { name: "Fake GPU 9000", slots: 64 } });
  assert.equal(ctl.gpu.name, "Fake GPU 9000");
  g.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake GPU 9000" });
  assert.equal(ctl.gpu.state, "ready");
  const s = startsOf(g.all[0]);
  assert.equal(s.length, 1);
  assert.equal(s[0].challenge, prepared[0].challenge);
  assert.equal(s[0].target, prepared[0].target);
  assert.equal(s[0].id, ctl.job.id);
  assert.match(s[0].nonceStart, /^[0-9a-f]{16}$/);
  assert.equal(s[0].progressMs, 1000);
  // the CPU workers never saw the GPU's ready: their own state is untouched
  assert.equal(ctl.ready, null);
  assert.equal(ctl.note, null);
  ctl.setThreads(3);
  assert.equal(ctl.workers.length, 3);
  assert.equal(startsOf(g.all[0]).length, 1, "a thread change does not touch the GPU lane");
  ctl.terminate();
});

test("the GPU lane's messages never reach ready or note: lane-off and errors leave the CPU lanes mining", async () => {
  const { ctl, cpu, g } = lanes();
  await ctl.start(2);
  cpu.all[0].emit({ type: "ready", ok: true, impl: "hash-wasm" });
  const before = { ready: ctl.ready, note: ctl.note };
  ctl.enableGpu(true);
  g.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake" });
  g.all[0].emit({ type: "error", message: "some GPU problem" });
  assert.equal(ctl.gpu.note, "some GPU problem");
  g.all[0].emit({ type: "lane-off", reason: "GPU 0 (Fake) disabled: it reported a nonce whose Argon2 hash differs from the reference" });
  assert.equal(ctl.gpu.state, "off");
  assert.match(ctl.gpu.note, /disabled/);
  assert.deepEqual({ ready: ctl.ready, note: ctl.note }, before, "the CPU refusal text and the slow-mode state are not the GPU's to set");
  assert.equal(ctl.running, true, "the CPU lanes go on");
  assert.equal(ctl.job !== null, true);
  assert.equal(cpu.all.every((w) => !w.terminated), true);
  // after a restart a lane that is off gets no start
  const starts = startsOf(g.all[0]).length;
  await ctl.restart();
  assert.equal(startsOf(g.all[0]).length, starts);
  // an earlier GPU worker's late messages are ignored
  ctl.enableGpu(false);
  g.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "late" });
  assert.equal(ctl.gpu, null);
  ctl.terminate();
});

test("GPU progress joins the samples as lane gpu: hashrate() is the total, hashrateByLane() the split; an unknown id is dropped", async () => {
  const { ctl, cpu, g } = lanes();
  await ctl.start(1);
  ctl.enableGpu(true);
  g.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake" });
  const id = ctl.job.id;
  cpu.all[0].emit({ type: "progress", hashes: 300, ms: 1000, id });
  g.all[0].emit({ type: "progress", hashes: 40_000, ms: 1000, id, lane: "gpu" });
  assert.equal(ctl.hashrate(), 40_300);
  assert.deepEqual(ctl.hashrateByLane(), { cpu: 300, gpu: 40_000 });
  assert.equal(ctl.total, 40_300);
  g.all[0].emit({ type: "progress", hashes: 999, ms: 1000, id: 99, lane: "gpu" });
  assert.equal(ctl.hashrate(), 40_300, "a progress for a challenge this controller never issued");
  ctl.terminate();
});

test("a GPU solution goes through the same path as a CPU one: stale ids ignored, all lanes stop, onFound gets lane gpu, then a new challenge", async () => {
  const { ctl, cpu, g, found, prepared } = lanes();
  await ctl.start(2);
  ctl.enableGpu(true);
  g.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake" });
  const id1 = ctl.job.id;
  g.all[0].emit({ type: "found", id: id1 + 50, nonce: "0000000000000001", powHash: "bb".repeat(32), hashes: 1, lane: "gpu" });
  assert.equal(found.length, 0, "a solution of another challenge is ignored");
  g.all[0].emit({ type: "found", id: id1, nonce: "0102030405060708", powHash: "aa".repeat(32), hashes: 5000, lane: "gpu" });
  assert.equal(found.length, 1);
  assert.deepEqual(found[0], { draft: prepared[0].draft, nonce: "0102030405060708", powHash: "aa".repeat(32), hashes: 5000, lane: "gpu" });
  assert.ok(cpu.all.every((w) => w.posts.some((m) => m.type === "stop")), "the CPU workers stopped");
  assert.ok(g.all[0].posts.some((m) => m.type === "stop"), "and the GPU worker");
  await settle();
  assert.equal(prepared.length, 2);
  assert.equal(startsOf(g.all[0]).at(-1).challenge, prepared[1].challenge, "the GPU restarts on the new challenge");
  assert.ok(cpu.all.every((w) => startsOf(w).at(-1).challenge === prepared[1].challenge));
  // a CPU solution has no lane key (today's shape) and also stops the GPU
  cpu.all[1].emit({ type: "found", id: ctl.job.id, nonce: "0a0b0c0d0e0f1011", powHash: "cc".repeat(32), hashes: 9 });
  assert.deepEqual(found[1], { draft: prepared[1].draft, nonce: "0a0b0c0d0e0f1011", powHash: "cc".repeat(32), hashes: 9 });
  assert.ok(g.all[0].posts.filter((m) => m.type === "stop").length >= 2);
  ctl.terminate();
});

test("stop, enableGpu(false) and terminate reach the GPU worker; the caption note survives a switch-off", async () => {
  const { ctl, g } = lanes();
  await ctl.start(1);
  ctl.enableGpu(true);
  g.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake" });
  ctl.stop();
  assert.ok(g.all[0].posts.at(-1).type === "stop");
  ctl.enableGpu(false);
  assert.equal(g.all[0].terminated, true);
  assert.equal(ctl.gpu, null);
  ctl.enableGpu(true, null);
  assert.equal(g.all.length, 2, "it can be switched on again");
  g.all[1].emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake" });
  ctl.enableGpu(false, "GPU lane off: because");
  assert.deepEqual({ w: ctl.gpu.w, state: ctl.gpu.state, note: ctl.gpu.note }, { w: null, state: "off", note: "GPU lane off: because" });
  ctl.enableGpu(true);
  assert.equal(g.all.length, 3, "a lane that was switched off with a note can be tried again");
  ctl.terminate();
  assert.equal(g.all[2].terminated, true);
  assert.equal(ctl.gpu, null);
});

test("verify() still uses the CPU worker; the GPU worker is never asked", async () => {
  const { ctl, cpu, g } = lanes();
  await ctl.start(1);
  ctl.enableGpu(true);
  g.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake" });
  const p = ctl.verify("ab".repeat(40));
  const req = cpu.all[0].posts.find((m) => m.type === "verify");
  assert.ok(req);
  assert.equal(g.all[0].posts.some((m) => m.type === "verify"), false);
  cpu.all[0].emit({ type: "verified", id: req.id, powHash: "cd".repeat(32) });
  assert.equal(await p, "cd".repeat(32));
  ctl.terminate();
});

test("a pow_mismatch on a GPU solution also switches the GPU lane off, with the note; on a CPU solution it does not", async () => {
  const { ctl, g } = lanes();
  await ctl.start(1);
  ctl.enableGpu(true);
  g.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake" });
  const err = Object.assign(new Error("disagreed"), { code: "pow_mismatch" });
  MINEVIEW.onClaimError(err, ctl, { lane: "cpu" });
  assert.equal(ctl.gpu.state, "ready", "a CPU solution's mismatch leaves the GPU lane alone");
  const r = MINEVIEW.onClaimError(err, ctl, { lane: "gpu" });
  assert.equal(r.status, "failed");
  assert.equal(MINEVIEW.GPU_OFF_NOTE, "GPU lane off: its verifier disagreed with the reference");
  assert.deepEqual({ w: ctl.gpu.w, state: ctl.gpu.state, note: ctl.gpu.note }, { w: null, state: "off", note: MINEVIEW.GPU_OFF_NOTE });
  assert.equal(g.all[0].terminated, true);
  assert.equal(ctl.note, SHARED.MINE_TEXT.slow, "the existing disableFast still ran");
  // old callers pass two arguments
  assert.equal(MINEVIEW.onClaimError(err, ctl).status, "failed");
  assert.equal(MINEVIEW.onClaimError(err, null, { lane: "gpu" }).status, "failed");
  ctl.terminate();
});

test("a wrong GPU answer bans the lane for the life of the page: it cannot be ticked again, the caption stays", async () => {
  // 1. a pow_mismatch on a GPU solution
  const a = lanes();
  await a.ctl.start(1);
  a.ctl.enableGpu(true);
  a.g.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake" });
  MINEVIEW.onClaimError(Object.assign(new Error("x"), { code: "pow_mismatch" }), a.ctl, { lane: "gpu" });
  a.ctl.enableGpu(true);
  assert.equal(a.g.all.length, 1, "no new worker after the ban");
  a.ctl.enableGpu(false);
  assert.equal(a.ctl.gpu.note, MINEVIEW.GPU_OFF_NOTE, "the caption survives an untick");
  a.ctl.enableGpu(true);
  assert.equal(a.g.all.length, 1);
  a.ctl.terminate();
  // 2. a worker that reports lane-off with wrong: true; a plain lane-off (no adapter) is not a ban
  const b = lanes();
  await b.ctl.start(1);
  b.ctl.enableGpu(true);
  b.g.all[0].emit({ type: "lane-off", reason: "This browser has no WebGPU." });
  b.ctl.enableGpu(false);
  b.ctl.enableGpu(true);
  assert.equal(b.g.all.length, 2, "a lane that merely failed to start may be tried again");
  b.g.all[1].emit({ type: "lane-off", reason: "GPU 0 disabled: it reported a nonce whose Argon2 hash differs from the reference", wrong: true });
  b.ctl.enableGpu(false);
  assert.match(b.ctl.gpu.note, /differs from the reference/);
  b.ctl.enableGpu(true);
  assert.equal(b.g.all.length, 2);
  b.ctl.terminate();
});

test("the mine view's source: the toggle is behind labGpu and ?gpu=1, its words live in the lab module, nothing else changed its imports", () => {
  const text = read("web/src/views/app-mine.js");
  assert.match(text, /import \{ labGpu \} from "virtual:murkle-lab";/);
  assert.match(text, /query\?\.get\?\.\("gpu"\) === "1"/);
  assert.match(text, /gpuSpawn: gpuUi \? lab\.spawnGpuWorker : null/);
  assert.equal(/Use GPU/.test(text), false, "the toggle's label comes from LAB_TEXT, so a default build has none of it");
  assert.equal(/requestAdapter|navigator\.gpu|webgpu/i.test(text), false);
  const labText = read("web/src/lab/index.js");
  assert.match(labText, /toggle: "Use GPU \(prototype\)"/);
  assert.match(labText, /export const labGpu = Object\.freeze\(\{ spawnGpuWorker, LAB_TEXT \}\);/);
});

test("lab files: English only, no banned public words, GPL header on the new source files", () => {
  const files = ["web/lab-plugin.mjs", "web/lab-gpu.html", "web/src/lab/index.js", "web/src/lab/lab-gpu.js", "web/src/lab/gpu-worker.js", "web/src/lab/pow-pool-worker.js", "web/src/lab/lab-style.js", "scripts/webgpu-chrome.mjs"];
  for (const f of files) {
    const text = read(f);
    assert.equal(/[^\x00-\x7f]/.test(text), false, `${f} is ASCII`);
    assert.equal(/\r/.test(text), false, `${f} is LF`);
    assert.equal(/\b(anonymous|trustless|untraceable|audited|mixer|secure|invisible)\b/i.test(text), false, `${f} has a banned word`);
    if (f !== "web/src/lab/lab-style.js") assert.match(text, /SPDX-License-Identifier: GPL-3\.0-or-later/, `${f} has the GPL header`);
  }
});

test("the view shows the GPU toggle only with a lab module and ?gpu=1 in the address; ticking it drives the controller and the caption", async () => {
  const els = new Map();
  const el = (sel) => {
    if (!els.has(sel)) els.set(sel, { innerHTML: "", textContent: "", replaceWith() {}, querySelectorAll: () => [], querySelector: () => null, dataset: {} });
    return els.get(sel);
  };
  const root = { innerHTML: "", ls: {}, querySelector: el, querySelectorAll: () => [], addEventListener(t, f) { (this.ls[t] ??= []).push(f); }, removeEventListener(t, f) { this.ls[t] = (this.ls[t] ?? []).filter((x) => x !== f); }, contains: () => true };
  // a session with just what the page reads before a token is picked
  const s = { history: [], relayInfo: null, view: null, state: null, closed: false, sync: async () => {}, loadRelayInfo: async () => {}, relayBalance: null, minePayer: null, mineBtc: null, unisat: null, linkage: () => [], holdDraft() {}, releaseDraft() {} };
  const gpuWorkers = fakeWorkers();
  const LAB = { spawnGpuWorker: gpuWorkers.spawn, LAB_TEXT: { toggle: "Use GPU (prototype)", opening: "Opening the GPU.", ready: "GPU lane on:", idle: "waiting" } };
  const shown = (query, lab) => {
    els.clear();
    const off = MINEVIEW.mineView(root, s, new URLSearchParams(query), { spawn: () => ({ postMessage() {}, terminate() {} }), lab });
    const controls = String(el("[data-mine-controls]").innerHTML);
    off();
    return { toggle: controls.includes('name="mine-gpu"'), label: controls.includes("Use GPU (prototype)"), caption: controls.includes("data-mine-gpu") };
  };
  assert.deepEqual(shown("", null), { toggle: false, label: false, caption: false }, "a default build: the page is as it was");
  assert.deepEqual(shown("gpu=1", null), { toggle: false, label: false, caption: false }, "?gpu=1 alone does nothing");
  assert.deepEqual(shown("", LAB), { toggle: false, label: false, caption: false }, "a lab build without ?gpu=1 shows nothing either");
  assert.deepEqual(shown("gpu=0", LAB), { toggle: false, label: false, caption: false });
  assert.deepEqual(shown("gpu=1", LAB), { toggle: true, label: true, caption: true });
  assert.equal(gpuWorkers.all.length, 0, "no GPU worker exists until the box is ticked");

  // tick the box: the worker is spawned and told to open; the caption follows its messages
  els.clear();
  const off = MINEVIEW.mineView(root, s, new URLSearchParams("gpu=1"), { spawn: () => ({ postMessage() {}, terminate() {} }), lab: LAB });
  const controls = String(el("[data-mine-controls]").innerHTML);
  assert.equal(/name="mine-gpu"[^>]*checked/.test(controls), false, "unticked by default");
  root.ls.change[0]({ target: { name: "mine-gpu", checked: true } });
  assert.equal(gpuWorkers.all.length, 1);
  assert.deepEqual(gpuWorkers.all[0].posts, [{ type: "open" }]);
  assert.equal(el("[data-mine-gpu]").textContent, "Opening the GPU.");
  assert.equal(/name="mine-gpu"[^>]*checked/.test(String(el("[data-mine-controls]").innerHTML)), true);
  gpuWorkers.all[0].emit({ type: "gpu-info", info: { name: "Fake GPU 9000" } });
  gpuWorkers.all[0].emit({ type: "ready", ok: true, impl: "webgpu", name: "Fake GPU 9000" });
  assert.match(el("[data-mine-gpu]").textContent, /^GPU lane on: Fake GPU 9000, waiting$/);
  gpuWorkers.all[0].emit({ type: "lane-off", reason: "GPU 0 (Fake GPU 9000) disabled: it reported a nonce whose Argon2 hash differs from the reference" });
  assert.match(el("[data-mine-gpu]").textContent, /disabled: it reported a nonce/);
  root.ls.change[0]({ target: { name: "mine-gpu", checked: false } });
  assert.equal(gpuWorkers.all[0].terminated, true);
  assert.equal(el("[data-mine-gpu]").textContent, "", "switched off by the user: the caption is gone");
  off();
});

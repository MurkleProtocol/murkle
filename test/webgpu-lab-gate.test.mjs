// What a default build guarantees about WebGPU: the guard's verdicts, the Vite plugin (stub or lab module, lab page only
// when asked for), MURKLE_LAB in the Vite config and the build marker, the server's refusal of a lab dist on
// mainnet, no WebGPU code in any eager chunk, the GPU worker fetched only on the tick, and no lab page or stub worker
// (proved on the module graph, and by one real build when MURKLE_SLOW_TESTS=1). The GPU lane of MineController is
// driven with fake workers.
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

/* ---------- what a default build guarantees about WebGPU code ---------- */

// The module graph of a page, the way Vite follows it. Bare specifiers (packages) and CSS are not followed;
// "virtual:murkle-lab" resolves to what the plugin gives (the stub, or the lab index).
//   lazy true   everything Vite bundles for the page: imports, dynamic imports, `new URL("./x.js", import.meta.url)` workers
//               and import.meta.glob
//   lazy false  the eager graph: only static `import ... from` / `import "x"` (nothing a click or a route loads later)
function graph(entries, lab, { lazy = true } = {}) {
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
    if (lazy) {
      for (const m of code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) specs.add(m[1]);
      for (const m of code.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)) specs.add(m[1]);
      for (const m of code.matchAll(/import\.meta\.glob\(\s*["']([^"']+)["']\s*\)/g)) {
        const dir = dirname(join(dirname(file), m[1]));
        for (const f of readdirSync(dir)) if (/\.js$/.test(f)) specs.add(`./${join(dirname(m[1]), f).replace(/\\/g, "/")}`);
      }
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
const rel = (f) => f.replace(ROOT, "").replace(/\\/g, "/");
const GPU_PATHS = /web\/src\/(gpu|lab)\/|src\/webgpu\/|src\/gpu-gate\.mjs/;

test("(a) no WebGPU code in any eager chunk: the entries of the app page and of the public and mine views reach no WebGPU file, adapter call or kernel", () => {
  const entries = ["app.js", "views/landing.js", "views/mints.js", "views/mine.js", "views/app-mine.js"];
  for (const e of entries) {
    const eager = graph([join(WEB, "src", e)], false, { lazy: false });
    assert.ok(eager.size > 5, `${e}: the eager graph was followed (${eager.size} files)`);
    const bad = [...eager].filter(([, text]) => WEBGPU_WORDS.test(text)).map(([f]) => rel(f));
    assert.deepEqual(bad, [], `${e}: no eager file mentions the adapter, the kernel, the lab page or navigator's gpu`);
    assert.deepEqual([...eager.keys()].map(rel).filter((f) => GPU_PATHS.test(f)), [], `${e}: no file of web/src/gpu, web/src/lab, src/webgpu or src/gpu-gate.mjs is eager`);
    // a lab build adds the lab index to the eager graph of the mine view, and it too holds no WebGPU word
    const eagerLab = graph([join(WEB, "src", e)], true, { lazy: false });
    assert.deepEqual([...eagerLab].filter(([, text]) => WEBGPU_WORDS.test(text)).map(([f]) => rel(f)), [], `${e}: nor does a lab build's eager graph`);
  }
  const mine = graph([join(WEB, "src", "views", "app-mine.js")], false, { lazy: false });
  assert.ok([...mine.keys()].some((f) => f.endsWith(join("web", "src", "session.js"))), "the mine view's eager graph includes the wallet session");
  const html = read("web/index.html");
  assert.equal(/lab-gpu|webgpu|gpu-worker/i.test(html), false, "index.html names neither the lab page nor the GPU worker (no preload)");
});

test("(b) app-mine.js has exactly one worker edge into web/src/gpu/, and that worker reaches the engine, the shader and the gate", () => {
  const text = read("web/src/views/app-mine.js").replace(/\r\n/g, "\n");
  const edges = [...text.matchAll(/new URL\(\s*["']([^"']+)["']\s*,\s*import\.meta\.url\s*\)/g)].map((m) => m[1]);
  const gpu = edges.filter((e) => /(^|\/)gpu\//.test(e));
  assert.deepEqual(gpu, ["../gpu/gpu-worker.js"]);
  assert.equal(text.split("../gpu/gpu-worker.js").length - 1, 1, "the file name appears once");
  assert.match(text, /const spawnGpuWorker = \(\) => new Worker\(new URL\("\.\.\/gpu\/gpu-worker\.js", import\.meta\.url\), \{ type: "module" \}\);/);
  const worker = graph([join(WEB, "src", "gpu", "gpu-worker.js")], false);
  const files = [...worker.keys()].map(rel);
  for (const f of ["src/webgpu/engine.mjs", "src/webgpu/argon2.wgsl.mjs", "src/gpu-gate.mjs"]) assert.ok(files.some((x) => x.endsWith(f)), `${f} is reachable from the worker`);
  const all = [...worker.values()].join("\n");
  assert.match(all, /requestAdapter/);
  assert.match(all, /murkle-webgpu-kernel/);
  // the whole app graph reaches the worker through that one edge, and only that file of web/src/gpu/
  const app = graph([join(WEB, "src", "app.js")], false);
  const gpuFiles = [...app.keys()].map(rel).filter((f) => f.includes("web/src/gpu/"));
  assert.deepEqual(gpuFiles, ["web/src/gpu/gpu-worker.js"]);
});

test("(c) without the lab, no file in the app's lazy graph is under web/src/lab/ and none mentions the stub or the lab page", () => {
  const app = graph([join(WEB, "src", "app.js")], false);
  assert.ok(app.size > 60, `the app graph was followed (${app.size} files)`);
  assert.deepEqual([...app.keys()].map(rel).filter((f) => f.includes("web/src/lab/")), []);
  assert.equal([...app.values()].some((t) => /gpu-stub-worker|lab-gpu/.test(t)), false);
});

test("(d) with the lab, the app page reaches the stub worker and the lab index, and the lab page reaches the lab controller, the pool worker and the GPU worker", () => {
  const lab = graph([join(WEB, "src", "app.js")], true);
  const files = [...lab.keys()].map(rel);
  for (const f of ["web/src/lab/index.js", "web/src/lab/gpu-stub-worker.js", "web/src/gpu/gpu-worker.js", "src/webgpu/engine.mjs", "src/webgpu/guard.mjs"]) {
    assert.ok(files.some((x) => x.endsWith(f)), `${f} is reachable`);
  }
  assert.equal(files.some((x) => x.endsWith("web/src/lab/lab-gpu.js")), false, "the lab page is not part of the app page");
  // the standalone lab page reaches the lab controller, the pool worker and the page script
  const page = graph([join(WEB, "src", "lab", "lab-gpu.js"), join(WEB, "src", "lab", "lab-style.js")], true);
  const pageFiles = [...page.keys()].map(rel);
  assert.ok(pageFiles.some((f) => f.endsWith("web/src/lab/lab-gpu.js")));
  assert.ok(pageFiles.some((f) => f.endsWith("web/src/lab/pow-pool-worker.js")));
  assert.ok(pageFiles.some((f) => f.endsWith("web/src/gpu/gpu-worker.js")));
  const html = read("web/lab-gpu.html");
  assert.match(html, /\/src\/lab\/lab-gpu\.js/);
  assert.match(html, /Prototype\. Uses this device's GPU only after you press a button\./);
  assert.equal(/<script[^>]*>[^<]/.test(html), false, "no inline script (the CSP forbids it)");
  // the lab index holds only the stub and the fault hook
  const index = read("web/src/lab/index.js");
  assert.match(index, /export const labGpu = Object\.freeze\(\{ spawnStub, faultOf \}\);/);
  assert.equal(/LAB_TEXT|spawnGpuWorker/.test(index), false);
});

test("a real default signet build in a scratch directory: WebGPU code only in the GPU worker, fetched only on the tick; no lab page, no stub worker", { skip: !SLOW && "MURKLE_SLOW_TESTS=1 runs a real vite build" }, async () => {
  const out = scratch("lab-build");
  const dist = join(out, "dist");
  await new Promise((done, fail) => {
    const env = { ...process.env };
    delete env.MURKLE_LAB;
    env.MURKLE_NETWORK = "";
    execFile(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--config", "web/vite.config.mjs", "--outDir", dist, "--emptyOutDir", "--manifest"], { cwd: ROOT, env, timeout: 600_000, maxBuffer: 1 << 26 }, (err, _o, stderr) => (err ? fail(new Error(`${err.message}\n${stderr}`)) : done()));
  });
  const files = [];
  const walk = (d) => {
    for (const f of readdirSync(d, { withFileTypes: true })) (f.isDirectory() ? walk(join(d, f.name)) : files.push(join(d, f.name)));
  };
  walk(dist);
  assert.ok(files.length > 10);
  const name = (f) => f.slice(dist.length + 1).replace(/\\/g, "/");
  // 3. no lab page and no stub worker; the marker says lab: false
  assert.equal(files.some((f) => f.endsWith("lab-gpu.html")), false);
  assert.equal(files.some((f) => /gpu-stub-worker/.test(f)), false);
  assert.equal(JSON.parse(readFileSync(join(dist, "murkle-build.json"), "utf8")).lab, false);
  const text = (f) => readFileSync(f, "utf8");
  const code = files.filter((f) => /\.(js|html|css|json|mjs)$/.test(f));
  // 1. the static closure of the entries holds none of the three words
  const manifest = JSON.parse(readFileSync(join(dist, ".vite", "manifest.json"), "utf8"));
  const closure = new Set();
  const add = (key) => {
    const m = manifest[key];
    if (!m || closure.has(m.file)) return;
    closure.add(m.file);
    for (const i of m.imports ?? []) add(i);
  };
  const entries = ["index.html", "src/views/landing.js", "src/views/mints.js", "src/views/mine.js", "src/views/app-mine.js"];
  for (const e of entries) {
    assert.ok(manifest[e], `${e} is a manifest entry`);
    add(e);
  }
  assert.ok(closure.size > 3);
  for (const f of closure) assert.equal(/requestAdapter|murkle-webgpu-kernel|navigator\.gpu/.test(text(join(dist, f))), false, `${f} (eager) is free of WebGPU code`);
  // exactly the worker file (and chunks only it imports) holds the kernel
  const workers = code.filter((f) => /^gpu-worker/.test(name(f).split("/").pop()));
  assert.equal(workers.length, 1, `one gpu-worker file: ${workers.map(name)}`);
  const holders = code.filter((f) => /murkle-webgpu-kernel/.test(text(f))).map(name);
  assert.ok(holders.length >= 1);
  const workerRoot = name(workers[0]);
  const importsOf = (f) => [...text(join(dist, f)).matchAll(/from\s*["']\.\/([^"']+\.js)["']|import\s*["']\.\/([^"']+\.js)["']/g)].map((m) => join(dirname(f), m[1] ?? m[2]).replace(/\\/g, "/"));
  const workerClosure = new Set([workerRoot]);
  for (const f of workerClosure) for (const i of importsOf(f)) if (existsSync(join(dist, i))) workerClosure.add(i);
  for (const h of holders) assert.ok(workerClosure.has(h), `${h} holding the kernel is the worker or a chunk it imports`);
  // 2. the app-mine chunk names the worker file; index.html does not preload it
  const appMine = text(join(dist, manifest["src/views/app-mine.js"].file));
  assert.ok(appMine.includes(workerRoot.split("/").pop()), "the app-mine chunk contains the worker's file name");
  const index = text(join(dist, "index.html"));
  assert.equal(/modulepreload[^>]*gpu-worker|gpu-worker[^>]*modulepreload/.test(index), false, "index.html has no preload of the worker");
  assert.equal(index.includes("gpu-worker"), false);
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

  assert.equal(ctl.gpu.checked, false, "the GPU has not opened yet: the box says it is starting");
  g.all[0].emit({ type: "gpu-info", info: { name: "Fake GPU 9000", slots: 64 } });
  assert.equal(ctl.gpu.name, "Fake GPU 9000");
  assert.equal(ctl.gpu.checked, true, "gpu-info means the GPU opened and its self-test runs");
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

test("the mine view's source: the box is in every build, its worker is created in one place, and no WebGPU word is in the view", () => {
  const text = read("web/src/views/app-mine.js");
  assert.ok(text.includes('import { labGpu } from "virtual:murkle-lab";'));
  assert.ok(text.includes('export const gpuSupported = (nav = globalThis.navigator) => Boolean(nav) && typeof nav === "object" && "gpu" in nav;'));
  assert.equal(text.split("spawnGpuWorker(").length - 1, 0, "spawnGpuWorker is passed as a default, never called at render");
  assert.ok(text.includes("gpuSpawn = spawnGpuWorker, gpuDetect = gpuSupported, lab = labGpu"));
  assert.equal(["requestAdapter", "navigator.gpu", "murkle-webgpu-kernel", "lab-gpu"].some((w) => text.includes(w)), false, "no WebGPU call or lab page name in the view");
  assert.equal(["localStorage", "sessionStorage", ".setItem("].some((w) => text.includes(w)), false, "the view itself stores nothing: the box is never stored");
  // the only thing remembered is the graphics-memory number, by its own module, under its own key; it holds no WebGPU word either
  const mem = read("web/src/share/gpu-memory.js");
  assert.ok(text.includes('from "../share/gpu-memory.js"'));
  assert.equal(mem.split(".setItem(").length - 1, 1, "one write, of the memory choice");
  assert.ok(mem.includes("storage.setItem(GPU_MEMORY_KEY, String(mib))"));
  assert.equal(["requestAdapter", "navigator.gpu", "murkle-webgpu-kernel", "lab-gpu", "/webgpu/"].some((w) => mem.includes(w)), false);
  assert.equal(/mine-gpu["'`]/.test(mem), false, "the box's name is not in the storage module");
  assert.ok(read("web/src/lab/index.js").includes("export const labGpu = Object.freeze({ spawnStub, faultOf });"));
});

test("lab files: English only, no banned public words, GPL header on the new source files", () => {
  const files = ["web/lab-plugin.mjs", "web/lab-gpu.html", "web/src/lab/index.js", "web/src/lab/lab-gpu.js", "web/src/lab/gpu-stub-worker.js", "web/src/gpu/gpu-worker.js", "web/src/lab/pow-pool-worker.js", "web/src/lab/lab-style.js", "scripts/webgpu-chrome.mjs"];
  for (const f of files) {
    const text = read(f);
    assert.equal(/[^\x00-\x7f]/.test(text), false, `${f} is ASCII`);
    assert.equal(/\r/.test(text), false, `${f} is LF`);
    assert.equal(/\b(anonymous|trustless|untraceable|audited|mixer|secure|invisible)\b/i.test(text), false, `${f} has a banned word`);
    if (f !== "web/src/lab/lab-style.js") assert.match(text, /SPDX-License-Identifier: GPL-3\.0-or-later/, `${f} has the GPL header`);
  }
});

#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Drives the hidden WebGPU lab page (web/lab-gpu.html, a MURKLE_LAB=1 build) in headless Chrome with Puppeteer,
// and records what the browser's WebGPU does next to what Node's Dawn does (scripts/webgpu-bench.mjs).
// NOT for the owner's workstation: it opens the machine's GPU in a browser and hashes flat out. It runs on a
// labelled rented box (MURKLE_WEBGPU=gpu); without that variable it exits with code 2 before it imports
// Puppeteer or starts a browser. The box holds no wallet and no mainnet keys; the lab page has none either.
//
// Setup on the box (best effort; stop after 30 minutes of trouble and report why):
//   MURKLE_LAB=1 npm run web:build, then serve web/dist with `npx vite preview --config web/vite.config.mjs --host 127.0.0.1`
//   npx @puppeteer/browsers install chrome@stable      (prints the path of the Chrome binary)
//   npm i --no-save puppeteer-core                     (never --save)
//
// Usage: MURKLE_WEBGPU=gpu node scripts/webgpu-chrome.mjs --url http://127.0.0.1:4173/lab-gpu.html --chrome <path> [options]
//   --memory MiB (1024)  --hpw 1|2|4|8 (2)  --seconds S (60)  --correct N (2000)  --hidden S (60, 0 skips)
//   --out file   (every result is also appended to it as one JSON line)
//   --keep-swiftshader   do not drop Puppeteer's default SwiftShader flags (they would hide the real GPU)
// What it does: opens the page, __murkleLab.open / selfTest / bench(S) / correct(N), then runs a hidden-tab test:
// the first tab benchmarks while a second tab is brought to the front, and the first tab's rate is logged with
// its document.visibilityState. Records whether requestAdapter was the NVIDIA GPU (info.vendor).
// Each result is one JSON line on stdout: { action, ... }. Exit code: 0 all good, 1 a failed check (open, self-test,
// a mismatch), 2 refused (environment or arguments).
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertWebGpuAllowed } from "../src/webgpu/guard.mjs";

export const CHROME_FLAGS = Object.freeze([
  "--headless=new",
  "--no-sandbox",
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-angle=vulkan",
  "--disable-vulkan-surface",
  "--enable-dawn-features=allow_unsafe_apis,disable_adapter_blocklist",
]);

const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?\//;
const SWIFTSHADER = /swiftshader/i;

export function parseChromeArgs(argv) {
  const o = { url: null, chrome: null, memory: 1024, hpw: 2, seconds: 60, correct: 2000, hidden: 60, out: null, keepSwiftshader: false };
  const whole = (name, v, min = 1) => {
    if (!/^\d+$/.test(String(v)) || Number(v) < min) throw new Error(`--${name} needs a whole number of at least ${min}`);
    return Number(v);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--url") o.url = value();
    else if (a === "--chrome") o.chrome = value();
    else if (a === "--memory") o.memory = whole("memory", value(), 8);
    else if (a === "--hpw") {
      o.hpw = whole("hpw", value());
      if (![1, 2, 4, 8].includes(o.hpw)) throw new Error("--hpw must be 1, 2, 4 or 8");
    } else if (a === "--seconds") o.seconds = whole("seconds", value());
    else if (a === "--correct") o.correct = whole("correct", value());
    else if (a === "--hidden") o.hidden = whole("hidden", value(), 0);
    else if (a === "--out") o.out = value();
    else if (a === "--keep-swiftshader") o.keepSwiftshader = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.url) throw new Error("--url is needed (the lab page of a MURKLE_LAB=1 build served on 127.0.0.1)");
  if (!LOCAL.test(o.url)) throw new Error("--url must be a page on 127.0.0.1 or localhost");
  return o;
}

/** The launch options of puppeteer-core: the flags above, with every default SwiftShader flag dropped. */
export function launchOptions(o, defaultArgs = []) {
  return {
    executablePath: o.chrome ?? process.env.CHROME_PATH ?? undefined,
    headless: true,
    args: [...CHROME_FLAGS],
    ignoreDefaultArgs: o.keepSwiftshader ? false : defaultArgs.filter((a) => SWIFTSHADER.test(a)),
  };
}

const round = (x, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** page: a Puppeteer page showing the lab; browser: the browser (for the second tab). Injectable for tests. */
export async function runChromeLab(o, { browser, emit = () => {}, log = console.error, settleMs = 5000 }) {
  const results = {};
  const record = (action, data) => {
    results[action] = data;
    emit(action, data);
    return data;
  };
  const page = await browser.newPage();
  page.on?.("pageerror", (e) => log(`  page error: ${e?.message ?? e}`));
  page.on?.("console", (m) => {
    if (m.type?.() === "error") log(`  page console: ${m.text?.()}`);
  });
  await page.goto(o.url, { waitUntil: "load" });
  if (!(await page.evaluate(() => Boolean(window.__murkleLab)))) {
    record("open", { ok: false, reason: "this page has no window.__murkleLab: it is not a MURKLE_LAB=1 build" });
    return results;
  }
  const call = (name, ...args) => page.evaluate((n, a) => window.__murkleLab[n](...a), name, args);

  log("opening the GPU in the page");
  const opened = await call("open", { memoryMiB: o.memory, hpw: o.hpw });
  const info = opened?.info ?? null;
  record("open", { ...opened, vendor: info?.vendor ?? null, architecture: info?.architecture ?? null, adapterIsNvidia: /nvidia/i.test(`${info?.vendor ?? ""} ${info?.name ?? ""}`), fallback: info?.fallback ?? null });
  if (!opened?.ok) return results;

  record("selfTest", await call("selfTest"));
  const bench = await call("bench", o.seconds);
  record("bench", { seconds: round(bench.seconds, 1), hashes: bench.hashes, hs: round(bench.hs), ticks: bench.ticks?.length ?? 0 });
  record("correct", await call("correct", o.correct));

  if (o.hidden > 0) {
    log(`hidden-tab test: ${o.hidden} s, a second tab in front after 5 s`);
    const running = call("hidden", o.hidden);
    await sleep(settleMs);
    const other = await browser.newPage();
    await other.goto("about:blank");
    await other.bringToFront();
    const h = await running;
    await other.close().catch(() => {});
    await page.bringToFront().catch(() => {});
    record("hidden", {
      seconds: round(h.seconds, 1), hsVisible: round(h.hsVisible), hsHidden: round(h.hsHidden), ratio: round(h.ratio, 3),
      visibleSeconds: h.visibleSeconds, hiddenSeconds: h.hiddenSeconds, ticks: h.ticks,
    });
  }
  await call("close").catch(() => {});
  return results;
}

/** The verdict: true when every check that ran passed. */
export function chromeLabOk(results) {
  return Boolean(results.open?.ok) && results.selfTest?.error === undefined && results.correct?.mismatches === 0 && results.correct?.error === undefined;
}

async function main() {
  let o;
  try {
    o = parseChromeArgs(process.argv.slice(2));
    assertWebGpuAllowed({ mode: "gpu" }); // before anything is imported or started
  } catch (e) {
    console.error(`webgpu-chrome: ${e.message}`);
    process.exit(2);
  }
  const emit = (action, data) => {
    const line = JSON.stringify({ action, ...data }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    console.log(line);
    if (o.out) appendFileSync(o.out, `${line}\n`);
  };
  let browser;
  try {
    const puppeteer = (await import("puppeteer-core")).default; // only after the guard has passed
    browser = await puppeteer.launch(launchOptions(o, puppeteer.defaultArgs?.({ headless: true }) ?? []));
    const results = await runChromeLab(o, { browser, emit });
    process.exitCode = chromeLabOk(results) ? 0 : 1;
  } catch (e) {
    console.error(`webgpu-chrome: ${e?.message ?? e}`);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

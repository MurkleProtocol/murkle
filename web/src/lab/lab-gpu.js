// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner prototype: the lab bench page (web/lab-gpu.html).
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// A standalone page for measuring the WebGPU Argon2 miner in a real browser: no wallet, no indexer, no app
// shell. It is built only with MURKLE_LAB=1 (web/lab-plugin.mjs). Nothing here touches navigator.gpu: the
// engine runs in web/src/gpu/gpu-worker.js, which is spawned and told to open the GPU only after a click on
// "Open GPU". The Argon2 reference for the self-test and the correctness run is a PowPool of
// web/src/lab/pow-pool-worker.js workers, hash-wasm in Web Workers.
//
// window.__murkleLab = { open(opts), selfTest(), bench(seconds), correct(n), info() } (plus hidden(seconds) and
// close()) returns plain JSON objects, for scripts/webgpu-chrome.mjs. Every result also goes to the <pre> as JSON.
import { PowPool } from "../../../src/pow-pool.mjs";
import { hex, unhex } from "../../../src/bytes.mjs";

const MAX_LISTED = 5;
const CORRECT_CHUNK = 256;

/** Pool size on this machine: min(4, hardwareConcurrency - 1), at least 1. */
export const poolSizeOf = (hc = globalThis.navigator?.hardwareConcurrency) => Math.max(1, Math.min(4, (Number.isFinite(hc) ? hc : 2) - 1));

/**
 * The lab's logic, independent of the page (tests drive it with fake workers).
 *   spawnGpu()   -> a worker-like object running web/src/gpu/gpu-worker.js
 *   spawnPow()   -> a worker-like object running web/src/lab/pow-pool-worker.js
 *   visibility() -> "visible" | "hidden" (document.visibilityState)
 *   random(n)    -> n random bytes
 */
export class LabController {
  constructor({ spawnGpu, spawnPow, visibility = () => globalThis.document?.visibilityState ?? "unknown", random = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)), poolSize = poolSizeOf(), onLog = () => {}, onTick = () => {}, now = () => performance.now() } = {}) {
    Object.assign(this, { spawnGpu, spawnPow, visibility, random, poolSize, onLog, onTick, now });
    this.w = null;
    this.pool = null;
    this.state = "closed"; // closed | opening | ready | off
    this.reason = null;
    this.gpuInfo = null;
    this.seq = 0;
    this.pending = new Map();
    this.openWait = null;
    this.ticks = null; // collector of a running bench
  }

  #send(m) {
    this.w.postMessage(m);
  }

  #message(m) {
    switch (m?.type) {
      case "gpu-info":
        this.gpuInfo = m.info;
        return;
      case "ready":
        this.state = "ready";
        return this.openWait?.({ ok: true, name: m.name, impl: m.impl, info: this.gpuInfo });
      case "lane-off":
        this.state = "off";
        this.reason = m.reason;
        for (const p of this.pending.values()) p.reject(new Error(m.reason));
        this.pending.clear();
        return this.openWait?.({ ok: false, reason: m.reason });
      case "lab-result": {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        return m.ok ? p.resolve(m.result) : p.reject(Object.assign(new Error(m.error), { code: m.code }));
      }
      case "lab-bench-tick":
        this.ticks?.push({ second: m.second, hs: m.hs, visibility: this.visibility() });
        return this.onTick({ second: m.second, hs: m.hs, visibility: this.visibility() });
      case "lab-verify":
        return this.#verify(m);
      case "error":
        return this.onLog(`worker error: ${m.message}`);
    }
  }

  // The worker asks the page's pool to hash for its self-test.
  async #verify({ rid, passwords }) {
    try {
      const out = await this.pool.hashMany(passwords.map((p) => unhex(p)));
      this.#send({ type: "lab-verified", rid, hashes: out.map((h) => hex(h)) });
    } catch (e) {
      this.#send({ type: "lab-verified", rid, error: e?.message ?? String(e) });
    }
  }

  #call(type, payload = {}) {
    if (!this.w || this.state === "closed") return Promise.reject(new Error("The GPU is not open. Press Open GPU first."));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.#send({ type, id, ...payload });
    });
  }

  /** -> { ok: true, name, info } | { ok: false, reason }. The first thing that can reach navigator.gpu (inside the worker). */
  async open({ memoryMiB = 1024, hpw = 2, targetDispatchMs = 50 } = {}) {
    if (this.state === "ready") return { ok: true, name: this.gpuInfo?.name, info: this.gpuInfo };
    if (this.state === "opening") throw new Error("The GPU is already opening.");
    this.state = "opening";
    this.reason = null;
    // a second open after a failed one: release the first worker and pool before making new ones
    const oldW = this.w;
    const oldPool = this.pool;
    this.w = null;
    this.pool = null;
    oldW?.terminate?.();
    await oldPool?.close().catch(() => {});
    this.pool = new PowPool({ size: this.poolSize, spawn: this.spawnPow });
    try {
      await this.pool.ready();
    } catch (e) {
      this.state = "off";
      this.reason = `The Argon2 reference workers did not start: ${e?.message ?? e}`;
      await this.pool.close().catch(() => {});
      return { ok: false, reason: this.reason };
    }
    this.w = this.spawnGpu();
    this.w.onmessage = (e) => this.#message(e?.data ?? e);
    const done = new Promise((resolve) => (this.openWait = resolve));
    this.#send({ type: "open", memoryMiB: Number(memoryMiB), hpw: Number(hpw), targetDispatchMs: Number(targetDispatchMs), verifyVia: "page" });
    const r = await done;
    this.openWait = null;
    return r;
  }

  info() {
    return this.#call("lab-info");
  }

  selfTest() {
    return this.#call("lab-selftest");
  }

  /** N seconds of search with target 0 (no hits). -> { seconds, hashes, hs, ticks: [{ second, hs, visibility }] } */
  async bench(seconds = 10) {
    this.ticks = [];
    try {
      const r = await this.#call("lab-bench", { seconds });
      return { ...r, ticks: this.ticks };
    } finally {
      this.ticks = null;
    }
  }

  /** As bench, summarised by tab visibility: the rate while the tab was visible and while it was hidden. */
  async hidden(seconds = 30) {
    const r = await this.bench(seconds);
    const mean = (list) => (list.length ? list.reduce((a, t) => a + t.hs, 0) / list.length : null);
    const visible = r.ticks.filter((t) => t.visibility === "visible");
    const hidden = r.ticks.filter((t) => t.visibility === "hidden");
    const hs = { visible: mean(visible), hidden: mean(hidden) };
    return { ...r, visibleSeconds: visible.length, hiddenSeconds: hidden.length, hsVisible: hs.visible, hsHidden: hs.hidden, ratio: hs.visible && hs.hidden ? hs.hidden / hs.visible : null };
  }

  /** N random passwords: the GPU's hash against the reference pool. -> { n, mismatches, first: [{ password, gpu, reference }] } */
  async correct(n = 1000) {
    const total = Math.max(1, Math.floor(Number(n)));
    let mismatches = 0;
    const first = [];
    for (let done = 0; done < total; done += CORRECT_CHUNK) {
      const size = Math.min(CORRECT_CHUNK, total - done);
      const pws = Array.from({ length: size }, () => this.random(40));
      const [gpu, ref] = await Promise.all([this.#call("lab-hash", { passwords: pws.map((p) => hex(p)) }), this.pool.hashMany(pws)]);
      pws.forEach((p, i) => {
        if (gpu.hashes[i] !== hex(ref[i])) {
          mismatches++;
          if (first.length < MAX_LISTED) first.push({ password: hex(p), gpu: gpu.hashes[i], reference: hex(ref[i]) });
        }
      });
    }
    return { n: total, mismatches, first };
  }

  async close() {
    if (this.w && this.state === "ready") await this.#call("lab-close").catch(() => {});
    this.w?.terminate?.();
    await this.pool?.close().catch(() => {});
    this.w = null;
    this.pool = null;
    this.state = "closed";
    return { closed: true };
  }
}

/* ---------- the page ---------- */

function wirePage(doc) {
  const $ = (id) => doc.getElementById(id);
  const out = $("lab-out");
  const status = $("lab-status");
  const log = (text) => {
    status.textContent = text;
  };
  const show = (name, value) => {
    const entry = { at: new Date().toISOString(), action: name, result: value };
    out.textContent += `${JSON.stringify(entry, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)}\n`;
    out.scrollTop = out.scrollHeight;
    return value;
  };
  const lab = new LabController({
    spawnGpu: () => new Worker(new URL("../gpu/gpu-worker.js", import.meta.url), { type: "module" }),
    spawnPow: () => new Worker(new URL("./pow-pool-worker.js", import.meta.url), { type: "module" }),
    onLog: log,
    onTick: (t) => log(`${t.second} s: ${Math.round(t.hs)} H/s (${t.visibility})`),
  });
  const secs = (id, dflt) => Math.max(1, Number($(id).value) || dflt);
  const run = async (name, fn) => {
    log(`${name}...`);
    try {
      const r = show(name, await fn());
      log(`${name}: done`);
      return r;
    } catch (e) {
      const r = show(name, { error: e?.message ?? String(e), code: e?.code ?? null });
      log(`${name}: ${e?.message ?? e}`);
      return r;
    }
  };
  const api = {
    open: (opts) => run("open", () => lab.open(opts ?? { memoryMiB: $("lab-memory").value, hpw: $("lab-hpw").value, targetDispatchMs: $("lab-dispatch").value })),
    selfTest: () => run("selfTest", () => lab.selfTest()),
    bench: (s) => run("bench", () => lab.bench(s ?? secs("lab-seconds", 10))),
    correct: (n) => run("correct", () => lab.correct(n ?? secs("lab-n", 1000))),
    info: () => run("info", () => lab.info()),
    hidden: (s) => run("hidden", () => lab.hidden(s ?? secs("lab-seconds", 30))),
    close: () => run("close", () => lab.close()),
  };
  const click = (id, fn) => $(id).addEventListener("click", () => fn());
  click("lab-open", () => api.open());
  click("lab-selftest", () => api.selfTest());
  click("lab-bench", () => api.bench());
  click("lab-correct", () => api.correct());
  click("lab-hidden", () => api.hidden());
  click("lab-info", () => api.info());
  click("lab-close", () => api.close());
  click("lab-copy", async () => {
    try {
      await globalThis.navigator.clipboard.writeText(out.textContent);
      log("Copied.");
    } catch {
      log("Copy failed: select the text and copy it by hand.");
    }
  });
  globalThis.__murkleLab = api;
  return api;
}

if (typeof document !== "undefined" && document.getElementById?.("lab-out")) wirePage(document);

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner: a stand-in for the GPU lane worker that makes no WebGPU call at all.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// Lab builds only (web/lab-plugin.mjs). For visual checks of the GPU (beta) box on a machine whose GPU must not be used.
// It speaks the protocol of web/src/gpu/gpu-worker.js:
//   in  { type: "open", mode?: "ok" | "fail" | "wrong" }   after 300 ms { type: "gpu-info", info: { name } }, after 700 ms more
//                                                          "ok": { type: "ready", ok: true, impl: "webgpu", name }
//                                                          "fail": { type: "lane-off", reason }
//                                                          "wrong": { type: "lane-off", reason, wrong: true }
//   in  { type: "start", id }                              a { type: "progress", hashes: 40000, ms: 1000, id, lane: "gpu" } every 1000 ms
//   in  { type: "stop" }
// It never posts "found".
export const STUB_NAME = "Stub GPU (no WebGPU call)";
const STUB_HASHES = 40_000;

/** The stub's logic, independent of the worker global. post: (message) => void; timers: { setTimeout, clearTimeout, setInterval, clearInterval }. */
export function createStubWorker({ post, timers = globalThis } = {}) {
  let opened = false;
  let ready = false;
  let ticker = null;
  const pending = [];
  const stopTicker = () => {
    if (ticker !== null) timers.clearInterval(ticker);
    ticker = null;
  };
  return {
    onMessage(msg) {
      switch (msg?.type) {
        case "open": {
          if (opened) return;
          opened = true;
          const mode = msg.mode === "fail" || msg.mode === "wrong" ? msg.mode : "ok";
          pending.push(timers.setTimeout(() => post({ type: "gpu-info", info: { name: STUB_NAME } }), 300));
          pending.push(
            timers.setTimeout(() => {
              if (mode === "ok") {
                ready = true;
                post({ type: "ready", ok: true, impl: "webgpu", name: STUB_NAME });
              } else post({ type: "lane-off", reason: "the stub was told to fail.", ...(mode === "wrong" ? { wrong: true } : {}) });
            }, 1000),
          );
          return;
        }
        case "start": {
          stopTicker();
          if (!ready) return;
          ticker = timers.setInterval(() => post({ type: "progress", hashes: STUB_HASHES, ms: 1000, lane: "gpu", ...(msg.id != null ? { id: msg.id } : {}) }), 1000);
          return;
        }
        case "stop":
          return stopTicker();
      }
    },
    close() {
      stopTicker();
      for (const t of pending) timers.clearTimeout(t);
    },
  };
}

if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  const stub = createStubWorker({ post: (m) => globalThis.postMessage(m) });
  globalThis.addEventListener("message", (e) => stub.onMessage(e.data));
}

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner: the lab-only seams of /app/mine (the stub GPU worker and the fault hook).
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// web/src/views/app-mine.js reads it through the virtual module "virtual:murkle-lab" (web/lab-plugin.mjs),
// which is `export const labGpu = null;` in every build that is not a lab build. The GPU (beta) toggle itself
// is in every build and does not need this module; it is only for visual checks that must never call WebGPU
// (?gpu=stub, stub-fail, stub-wrong, stub-none) and for the forced-wrong-answer run (?gpufault=n).

/**
 * A module worker that speaks the GPU lane's protocol and makes no WebGPU call (web/src/lab/gpu-stub-worker.js).
 * mode: "ok" | "fail" | "wrong".
 */
export const spawnStub = (mode = "ok") => {
  const w = new Worker(new URL("./gpu-stub-worker.js", import.meta.url), { type: "module" });
  const post = w.postMessage.bind(w);
  w.postMessage = (m) => post(m?.type === "open" ? { ...m, mode } : m);
  return w;
};

/** ?gpufault=n -> { afterBatches: n } for a whole n from 1 to 1000, else null. */
export function faultOf(query) {
  const raw = query?.get?.("gpufault");
  if (!/^\d{1,4}$/.test(String(raw ?? ""))) return null;
  const n = Number(raw);
  return n >= 1 && n <= 1000 ? { afterBatches: n } : null;
}

export const labGpu = Object.freeze({ spawnStub, faultOf });

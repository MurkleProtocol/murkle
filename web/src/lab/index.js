// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner prototype: what the hidden /app/mine toggle imports in a lab build.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// web/src/views/app-mine.js reads it through the virtual module "virtual:murkle-lab" (web/lab-plugin.mjs),
// which is `export const labGpu = null;` in every build that is not a lab build. All the words of the
// toggle live here, so a default build carries none of them.

/** The words of the /app/mine toggle. */
export const LAB_TEXT = Object.freeze({
  toggle: "Use GPU (prototype)",
  opening: "Opening the GPU and checking it against the reference. This takes a few seconds.",
  ready: "GPU lane on:",
  idle: "waiting for a challenge",
});

/** A module worker running the GPU lane (web/src/lab/gpu-worker.js); the page sends it { type: "open" } after a click. */
export const spawnGpuWorker = () => new Worker(new URL("./gpu-worker.js", import.meta.url), { type: "module" });

export const labGpu = Object.freeze({ spawnGpuWorker, LAB_TEXT });

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner prototype: no real GPU on developer machines.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// In Node, every entry point that could create a WebGPU adapter calls assertWebGpuAllowed() first, before
// anything is imported or enumerated, and refuses unless the environment says so on purpose:
//   MURKLE_WEBGPU=gpu        a real GPU, meant for rented boxes only;
//   MURKLE_WEBGPU=fallback   Linux only, with the Vulkan loader pinned to a CPU driver (lavapipe / SwiftShader)
//                            through VK_ICD_FILENAMES or VK_DRIVER_FILES, so no physical GPU can be picked.
// In a browser the page only gets here after an explicit click, and the lab code exists only in lab builds.
// Isomorphic.
import { GpuError } from "../gpu-gate.mjs";

const CPU_ICD = /(lvp|lavapipe|swiftshader|vk_swiftshader)[^/\\]*\.json$/i;
const CPU_ADAPTER = /swiftshader|llvmpipe|lavapipe/i;

const REFUSED =
  "WebGPU is disabled here; set MURKLE_WEBGPU=gpu on a rented GPU box (never on a workstation), or MURKLE_WEBGPU=fallback on Linux with a CPU Vulkan driver in VK_ICD_FILENAMES; nothing was started";

/**
 * Throws GpuError GPU_NO_DEVICE unless a WebGPU adapter may be created here. mode: "gpu" | "fallback".
 * browser: true in a page or worker (no process object); then it always passes.
 */
export function assertWebGpuAllowed({ env = globalThis.process?.env, platform = globalThis.process?.platform, mode, browser = !globalThis.process } = {}) {
  if (mode !== undefined && mode !== "gpu" && mode !== "fallback") throw new TypeError('mode must be "gpu" or "fallback"');
  if (browser) return;
  const refuse = (why) => {
    throw new GpuError(`${REFUSED} (${why})`, "GPU_NO_DEVICE");
  };
  const flag = env?.MURKLE_WEBGPU;
  if (mode === "gpu") {
    if (flag !== "gpu") refuse(flag ? `MURKLE_WEBGPU=${flag}, but mode gpu needs MURKLE_WEBGPU=gpu` : "MURKLE_WEBGPU is not set");
    return;
  }
  if (mode === "fallback") {
    if (flag !== "fallback") refuse(flag ? `MURKLE_WEBGPU=${flag}, but mode fallback needs MURKLE_WEBGPU=fallback` : "MURKLE_WEBGPU is not set");
    if (platform !== "linux") refuse(`fallback mode is Linux only, this is ${platform}`);
    // every variable that is set must name CPU drivers only (the loader may read either), and nothing may add more
    const sets = ["VK_ICD_FILENAMES", "VK_DRIVER_FILES"].map((k) => env?.[k]).filter(Boolean);
    if (!sets.length) refuse("VK_ICD_FILENAMES or VK_DRIVER_FILES must point at a CPU Vulkan driver");
    if (env?.VK_ADD_DRIVER_FILES) refuse("VK_ADD_DRIVER_FILES adds Vulkan drivers and must not be set");
    for (const icd of sets) {
      const paths = String(icd).split(":").filter(Boolean);
      if (!paths.length || !paths.every((p) => CPU_ICD.test(p))) refuse("every Vulkan driver file must be a CPU driver (lvp, lavapipe or swiftshader)");
    }
    return;
  }
  refuse("no mode was given");
}

/** Fallback mode only: the adapter must be a CPU implementation, checked before requestDevice. */
export function checkAdapterIsCpu(adapter) {
  const info = adapter?.info ?? {};
  if (info.isFallbackAdapter === true || adapter?.isFallbackAdapter === true) return;
  const text = info.description || info.device || info.architecture || "";
  if (CPU_ADAPTER.test(text)) return;
  throw new GpuError(`the WebGPU adapter is not a CPU implementation (${text || info.vendor || "unknown"}); fallback mode refuses it`, "GPU_NO_DEVICE");
}

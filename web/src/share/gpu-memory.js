/**
 * The "Graphics memory" choice beside the GPU (beta) box on /app/mine: 2, 4 or 8 GiB, remembered in this browser.
 * Only this number is stored, under its own key. The box itself is never stored: it is unticked on every page load.
 * The default is 4 GiB (measured on NVIDIA); 8 GiB was faster on the cards measured but asks for all of an 8 GB card.
 * The page sends the choice to the GPU worker as memoryUpToMiB, a request the engine never lifts a vendor above its own
 * default for (the engine in the GPU worker's graph). This file holds no WebGPU call.
 *
 * API
 *   GPU_MEMORY_CHOICES, GPU_MEMORY_DEFAULT, GPU_MEMORY_KEY
 *   readGpuMemory(storage?) -> MiB      the stored choice, else the default (also for a missing, unreadable or odd value)
 *   saveGpuMemory(mib, storage?) -> boolean   false for a number that is not a choice, or when the browser refuses the write
 *   gpuMemoryLabel(mib) -> "4 GiB"
 */
import { STORAGE_PREFIX } from "../config.js";

export const GPU_MEMORY_CHOICES = Object.freeze([2048, 4096, 8192]);
export const GPU_MEMORY_DEFAULT = 4096;
export const GPU_MEMORY_KEY = `${STORAGE_PREFIX}.gpuMemoryMiB`;

/** localStorage, or null where the page cannot reach it (blocked site data, tests). */
function defaultStorage() {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function readGpuMemory(storage = defaultStorage()) {
  try {
    const n = Number(storage?.getItem(GPU_MEMORY_KEY));
    return GPU_MEMORY_CHOICES.includes(n) ? n : GPU_MEMORY_DEFAULT;
  } catch {
    return GPU_MEMORY_DEFAULT;
  }
}

export function saveGpuMemory(mib, storage = defaultStorage()) {
  if (!GPU_MEMORY_CHOICES.includes(mib) || !storage) return false;
  try {
    storage.setItem(GPU_MEMORY_KEY, String(mib));
    return true;
  } catch {
    return false;
  }
}

export const gpuMemoryLabel = (mib) => `${mib / 1024} GiB`;

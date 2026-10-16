// The guard that keeps the WebGPU engine away from real GPUs on developer machines (src/webgpu/guard.mjs, spec section 6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { assertWebGpuAllowed, checkAdapterIsCpu } from "../src/webgpu/guard.mjs";

const LVP = "/usr/share/vulkan/icd.d/lvp_icd.x86_64.json";
const NV = "/usr/share/vulkan/icd.d/nvidia_icd.json";
const refused = (args) => assert.throws(() => assertWebGpuAllowed({ browser: false, ...args }), (e) => e.code === "GPU_NO_DEVICE" && /WebGPU is disabled here; set MURKLE_WEBGPU=gpu on a rented GPU box/.test(e.message));
const allowed = (args) => assert.doesNotThrow(() => assertWebGpuAllowed({ browser: false, ...args }));

test("an empty environment is refused, in both modes and with no mode", () => {
  refused({ env: {}, platform: "linux", mode: "gpu" });
  refused({ env: {}, platform: "linux", mode: "fallback" });
  refused({ env: {}, platform: "linux" });
  refused({ env: undefined, platform: "win32", mode: "gpu" });
});

test("mode gpu needs MURKLE_WEBGPU=gpu exactly", () => {
  allowed({ env: { MURKLE_WEBGPU: "gpu" }, platform: "linux", mode: "gpu" });
  allowed({ env: { MURKLE_WEBGPU: "gpu" }, platform: "win32", mode: "gpu" });
  refused({ env: { MURKLE_WEBGPU: "fallback" }, platform: "linux", mode: "gpu" });
  refused({ env: { MURKLE_WEBGPU: "1" }, platform: "linux", mode: "gpu" });
  refused({ env: { MURKLE_WEBGPU: "GPU" }, platform: "linux", mode: "gpu" });
});

test("mode fallback needs MURKLE_WEBGPU=fallback, Linux, and CPU Vulkan drivers only", () => {
  const ok = { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: LVP };
  allowed({ env: ok, platform: "linux", mode: "fallback" });
  allowed({ env: { MURKLE_WEBGPU: "fallback", VK_DRIVER_FILES: "/opt/swiftshader/vk_swiftshader_icd.json" }, platform: "linux", mode: "fallback" });
  refused({ env: ok, platform: "win32", mode: "fallback" });
  refused({ env: ok, platform: "darwin", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: NV }, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: `${LVP}:${NV}` }, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: LVP, VK_DRIVER_FILES: NV }, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: NV, VK_DRIVER_FILES: LVP }, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: LVP, VK_ADD_DRIVER_FILES: NV }, platform: "linux", mode: "fallback" });
  allowed({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: LVP, VK_DRIVER_FILES: LVP }, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback" }, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "gpu", VK_ICD_FILENAMES: LVP }, platform: "linux", mode: "fallback" });
  refused({ env: { MURKLE_WEBGPU: "fallback", VK_ICD_FILENAMES: "/tmp/lvp/../nvidia.txt" }, platform: "linux", mode: "fallback" });
});

test("a browser (no process object) is always allowed; a bad mode is a TypeError", () => {
  assert.doesNotThrow(() => assertWebGpuAllowed({ browser: true, env: undefined, platform: undefined, mode: "gpu" }));
  assert.doesNotThrow(() => assertWebGpuAllowed({ browser: true, mode: "fallback" }));
  assert.throws(() => assertWebGpuAllowed({ browser: true, mode: "turbo" }), TypeError);
});

test("checkAdapterIsCpu: fallback flag in info or on the adapter, or a CPU name; anything else is refused", () => {
  assert.doesNotThrow(() => checkAdapterIsCpu({ info: { isFallbackAdapter: true } }));
  assert.doesNotThrow(() => checkAdapterIsCpu({ isFallbackAdapter: true, info: {} }));
  assert.doesNotThrow(() => checkAdapterIsCpu({ info: { description: "llvmpipe (LLVM 15.0.7, 256 bits)" } }));
  assert.doesNotThrow(() => checkAdapterIsCpu({ info: { device: "SwiftShader Device (LLVM 10.0.0)" } }));
  assert.doesNotThrow(() => checkAdapterIsCpu({ info: { architecture: "lavapipe" } }));
  const refuse = (a) => assert.throws(() => checkAdapterIsCpu(a), (e) => e.code === "GPU_NO_DEVICE");
  refuse({ info: { vendor: "nvidia", description: "NVIDIA GeForce RTX 4090", isFallbackAdapter: false } });
  refuse({ info: {} });
  refuse({});
  refuse(null);
});

test("the webgpu package is never a dependency of this repository (it is installed with --no-save on CI and rented boxes only)", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    assert.equal(Object.keys(pkg[field] ?? {}).some((k) => /webgpu|dawn/i.test(k)), false, field);
  }
  const lock = readFileSync(new URL("../package-lock.json", import.meta.url), "utf8");
  assert.equal(/"node_modules\/webgpu"/.test(lock), false);
});

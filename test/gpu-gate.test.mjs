// The GPU safety gate was moved out of src/gpu.mjs into the isomorphic src/gpu-gate.mjs so that the CUDA
// child-process device and the WebGPU engine share it. gpu.mjs re-exports the four public names.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { hex, unhex } from "../src/bytes.mjs";
import * as gate from "../src/gpu-gate.mjs";
import * as gpu from "../src/gpu.mjs";

test("src/gpu.mjs re-exports the very same objects as src/gpu-gate.mjs", () => {
  for (const name of ["GpuError", "GPU_SELF_TEST_VECTORS", "gpuSelfTest", "GpuLane"]) {
    assert.ok(gate[name], `${name} is exported by the gate`);
    assert.equal(gpu[name], gate[name], `${name} is the same object through both modules`);
  }
});

test("src/gpu.mjs keeps the rest of its public surface", () => {
  for (const name of ["GPU_PROTOCOL_VERSION", "gpuBinaryPath", "listGpus", "openGpu"]) assert.ok(gpu[name] !== undefined, name);
  assert.equal(Object.hasOwn(gate, "openGpu"), false, "the CUDA child-process side stays in gpu.mjs");
});

test("src/gpu-gate.mjs imports nothing from Node", () => {
  const text = readFileSync(new URL("../src/gpu-gate.mjs", import.meta.url), "utf8");
  assert.equal(/(?:from|import)\s*\(?\s*["']node:/.test(text), false, "no node: import");
  assert.equal(/\brequire\s*\(/.test(text), false);
  // the only imports are the isomorphic modules of this repository
  const specs = [...text.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gms)].map((m) => m[1]);
  assert.deepEqual(specs.sort(), ["./bytes.mjs", "./mine.mjs"]);
});

test("gpuSelfTest runs without a randomBytes option: the default is the platform CSPRNG, and the call reaches step (b)", async (t) => {
  const known = new Map(gate.GPU_SELF_TEST_VECTORS.map((v) => [v.password, v.powHash]));
  const tagOf = (pw) => known.has(hex(pw)) ? unhex(known.get(hex(pw))) : Uint8Array.from(createHash("sha256").update(pw).digest());
  const randomCalls = t.mock.method(globalThis.crypto, "getRandomValues");
  let searched = 0;
  const dev = {
    info: { device: 0, name: "stand-in", slots: 8 },
    async hash(list) {
      return list.map(tagOf);
    },
    async search() {
      searched++;
      throw new gate.GpuError("stop after step (b)", "GPU_START");
    },
  };
  const vectors = gate.GPU_SELF_TEST_VECTORS.map((v) => ({ name: v.name, password: v.password, powHash: v.powHash }));
  await assert.rejects(
    gate.gpuSelfTest(dev, { verifyMany: async (list) => list.map(tagOf), vectors }),
    (e) => e instanceof gate.GpuError && e.code === "GPU_START",
  );
  assert.equal(searched, 1, "steps (a) and (b) passed and the boundary search of step (c) was reached");
  assert.ok(randomCalls.mock.callCount() >= 32, "the 32 random passwords of step (b) came from crypto.getRandomValues");
});

test("the self-test vectors are frozen and unchanged in size", () => {
  assert.equal(gate.GPU_SELF_TEST_VECTORS.length, 16);
  assert.ok(Object.isFrozen(gate.GPU_SELF_TEST_VECTORS));
});

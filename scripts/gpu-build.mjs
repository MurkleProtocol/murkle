#!/usr/bin/env node
// npm run gpu:build: builds the GPU miner with nvcc (gpu/README.md). Runs gpu/build.ps1 on Windows and
// gpu/build.sh elsewhere; both need the CUDA Toolkit 12.8.1, neither needs a GPU.
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const gpu = join(dirname(fileURLToPath(import.meta.url)), "..", "gpu");
const windows = process.platform === "win32";
const cmd = windows ? "powershell" : "bash";
const args = windows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(gpu, "build.ps1")] : [join(gpu, "build.sh")];
const r = spawnSync(cmd, args, { stdio: "inherit" });
if (r.error) console.error(`could not run ${cmd}: ${r.error.message}`);
process.exitCode = r.status ?? 1;

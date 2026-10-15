#!/usr/bin/env node
// Downloads the prebuilt GPU miner (murkle-gpu) for this platform into gpu/bin/ and refuses it
// unless its sha256 equals the pin in gpu/pins.json. Nothing is written on a mismatch, so the
// download source never has to be trusted. The pins stay empty until the owner publishes the
// release (gpu/README.md); until then build the binary yourself (npm run gpu:build).
//
// Usage: node scripts/gpu-fetch.mjs [--pins <file>] [--dest <dir>] [--platform p] [--arch a] [--force] [--check]
//   (npm run gpu:fetch)
//
//   --pins <file>   the pins file (default gpu/pins.json): { version, files: { "<platform>-<arch>": { sha256, url } } }
//   --dest <dir>    write under this directory instead of gpu/bin (tests use a temp dir)
//   --platform/--arch   fetch for another platform (linux or win32, x64); default this machine
//   --force         download again even when the file on disk already matches its pin
//   --check         no network: report whether the file on disk matches its pin
//
// Exit codes: 0 the binary is present and matches its pin; 1 nothing pinned, a download failed or
// the hash differed (nothing written); 2 usage error.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PINS_PATH = join(ROOT, "gpu", "pins.json");
export const BIN_DIR = join(ROOT, "gpu", "bin");
export const MAX_BINARY_BYTES = 200 * 1024 * 1024;
const SUPPORTED = ["linux-x64", "win32-x64"];

export class FetchError extends Error {}

export const binaryName = (platform, arch) => `murkle-gpu-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseArgs(argv) {
  const opts = { pins: PINS_PATH, dest: BIN_DIR, platform: process.platform, arch: process.arch, force: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new FetchError(`${a} needs a value`);
      return v;
    };
    if (a === "--pins") opts.pins = resolve(value());
    else if (a === "--dest") opts.dest = resolve(value());
    else if (a === "--platform") opts.platform = value();
    else if (a === "--arch") opts.arch = value();
    else if (a === "--force") opts.force = true;
    else if (a === "--check") opts.check = true;
    else if (a === "--help" || a === "-h") opts.help = true;
    else throw new FetchError(`unknown argument ${a}`);
  }
  return opts;
}

/** The pin for this platform, or a FetchError that says what to do instead. */
export function pinFor(pins, platform, arch) {
  const key = `${platform}-${arch}`;
  if (!SUPPORTED.includes(key)) throw new FetchError(`there is no GPU miner for ${key}: only ${SUPPORTED.join(" and ")} are supported`);
  const pin = pins?.files?.[key];
  if (!pin) {
    throw new FetchError(`gpu/pins.json pins no binary for ${key} yet: build it with npm run gpu:build (gpu/README.md) or set MURKLE_GPU_BIN`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(pin.sha256 ?? "")) || !/^https:\/\//.test(String(pin.url ?? ""))) {
    throw new FetchError(`the pin for ${key} in gpu/pins.json is malformed (it needs a 64-hex sha256 and an https url)`);
  }
  return pin;
}

/**
 * Downloads the pinned binary of this platform into `dest` (unless the file there already matches).
 * fetchImpl: fetch (a test passes a stand-in). -> { path, sha256, status: "present" | "downloaded" }
 */
export async function fetchGpuBinary({ pins, platform = process.platform, arch = process.arch, dest = BIN_DIR, fetchImpl = fetch, force = false } = {}) {
  const pin = pinFor(pins, platform, arch);
  const path = join(dest, binaryName(platform, arch));
  if (!force && existsSync(path) && sha256(readFileSync(path)) === pin.sha256) return { path, sha256: pin.sha256, status: "present" };
  let res;
  try {
    res = await fetchImpl(pin.url, { redirect: "follow" });
  } catch (e) {
    throw new FetchError(`could not download ${pin.url}: ${e.message}`);
  }
  if (!res.ok) throw new FetchError(`could not download ${pin.url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BINARY_BYTES) throw new FetchError(`${pin.url} is larger than ${MAX_BINARY_BYTES} bytes; refused`);
  const got = sha256(bytes);
  if (got !== pin.sha256) throw new FetchError(`sha256 mismatch for ${pin.url}: expected ${pin.sha256}, got ${got}; nothing was written`);
  mkdirSync(dest, { recursive: true });
  const part = `${path}.part`;
  writeFileSync(part, bytes);
  if (process.platform !== "win32") chmodSync(part, 0o755);
  renameSync(part, path);
  return { path, sha256: got, status: "downloaded" };
}

/** The same check without the network: -> { path, sha256 | null, matches } */
export function checkGpuBinary({ pins, platform = process.platform, arch = process.arch, dest = BIN_DIR } = {}) {
  const pin = pinFor(pins, platform, arch);
  const path = join(dest, binaryName(platform, arch));
  const have = existsSync(path) ? sha256(readFileSync(path)) : null;
  return { path, sha256: have, matches: have === pin.sha256 };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
      console.log("usage: node scripts/gpu-fetch.mjs [--pins <file>] [--dest <dir>] [--platform p] [--arch a] [--force] [--check]");
    } else {
      const pins = JSON.parse(readFileSync(opts.pins, "utf8"));
      if (opts.check) {
        const r = checkGpuBinary({ pins, ...opts });
        console.log(r.matches ? `${r.path} matches its pin` : r.sha256 ? `${r.path} does NOT match its pin (sha256 ${r.sha256})` : `${r.path} is missing`);
        process.exitCode = r.matches ? 0 : 1;
      } else {
        const r = await fetchGpuBinary({ pins, ...opts });
        console.log(r.status === "present" ? `${r.path} already matches its pin` : `downloaded ${r.path} (sha256 ${r.sha256})`);
      }
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = e instanceof FetchError && /needs a value|unknown argument/.test(e.message) ? 2 : 1;
  }
}

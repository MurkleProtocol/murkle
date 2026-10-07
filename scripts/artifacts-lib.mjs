// The pinned circuit artifacts: where the indexer, the CLI and the tests load them from, and
// the sha256 each must have (the network's pins file: src/pins.json on signet, src/pins.mainnet.json
// on mainnet; MURKLE_NETWORK picks it). Shared by fetch-artifacts.mjs and
// release-assets.mjs; test/publish-tools.test.mjs checks it against server/indexer-server.mjs.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { ARTIFACT_PATHS, ARTIFACT_SHA256, MANIFEST_SHA256 } from "../src/params.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** [published name, path in a checkout, pinned sha256]; the names are those /artifacts/ serves. */
export const PINNED_ARTIFACTS = Object.freeze([
  Object.freeze({ name: "manifest.json", path: ARTIFACT_PATHS.manifest, sha256: MANIFEST_SHA256 }),
  Object.freeze({ name: "verification_key.json", path: ARTIFACT_PATHS.vkey, sha256: ARTIFACT_SHA256.vkey }),
  Object.freeze({ name: "transaction.wasm", path: ARTIFACT_PATHS.wasm, sha256: ARTIFACT_SHA256.wasm }),
  Object.freeze({ name: "transaction.zkey", path: ARTIFACT_PATHS.zkey, sha256: ARTIFACT_SHA256.zkey }),
]);

/** No artifact is anywhere near this; a bigger answer is refused before it fills the disk. */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/**
 * Release tag the artifacts are published under, derived from the pins so a tag can only
 * ever hold one set of files: "artifacts-" + the first 12 hex characters of manifestSha256.
 */
export const DEFAULT_TAG = MANIFEST_SHA256 ? `artifacts-${MANIFEST_SHA256.slice(0, 12)}` : null;

/**
 * Streams `url` into the file `path`, refusing more than `maxBytes`: a declared Content-Length
 * above it fails before anything is written, and the stream is cut as soon as the running total
 * passes it, so a misbehaving source cannot fill the disk before the caller checks the hashes.
 * `timeoutMs` bounds the whole download. The file is removed on any error. Returns the byte count.
 */
export async function downloadCapped(url, path, { maxBytes, timeoutMs = 600_000, fetchFn = fetch } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("downloadCapped needs maxBytes");
  const res = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`larger than ${maxBytes} bytes (Content-Length ${declared})`);
  }
  let total = 0;
  const cap = new Transform({
    transform(chunk, _encoding, done) {
      total += chunk.length;
      if (total > maxBytes) done(new Error(`larger than ${maxBytes} bytes`));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), cap, createWriteStream(path));
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  }
  return total;
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** { ok, actual } for a file on disk against its pin; actual is null when the file is missing. */
export function checkFile(file, expected) {
  if (!existsSync(file)) return { ok: false, actual: null };
  const actual = sha256(readFileSync(file));
  return { ok: actual === expected, actual };
}

/** The SHA256SUMS text (sha256sum format, sorted by name) for the pinned artifacts. */
export function sha256sums(artifacts = PINNED_ARTIFACTS) {
  return [...artifacts].sort((a, b) => a.name.localeCompare(b.name)).map((a) => `${a.sha256}  ${a.name}\n`).join("");
}

// The GPU miner's Node side (docs/design/mining.md section 12.2, gpu/README.md): one child
// process `murkle-gpu` per CUDA device, spoken to over stdin (plain text commands) and stdout
// (JSON lines). Nothing the GPU says is trusted: GpuLane.grind hands out a nonce only after the
// Argon2 pool (hash-wasm, else noble) has recomputed its hash and the target check has passed on
// that value, and claim() in bin/murkle.mjs checks it once more with the reference. A wrong
// answer disables the lane for the run (GPU_WRONG); a crash, a stall or a protocol slip restarts
// it (a new child and a full self-test) a bounded number of times and is never a "no solution".
// Node only (child_process); the mining primitives it uses are the isomorphic ones of ./mine.mjs.
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { bigToBytes, bytesToBig, equal, hex, unhex } from "./bytes.mjs";
import { CHALLENGE_LEN, NONCE_LEN, PASSWORD_LEN, SELF_TEST_VECTORS, counterOf, meetsTarget, nonceOf, passwordOf } from "./mine.mjs";

export const GPU_PROTOCOL_VERSION = 1;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const U64 = (1n << 64n) - 1n;
const MAX_TARGET = (1n << 256n) - 1n;
const MAX_COUNT = (1n << 53n) - 1n;
const MAX_LINE = 1 << 20; // a longer stdout line is a protocol error
const MAX_HASH_REQUEST = 4096; // passwords per `hash` request
const MAX_CANDIDATES = 64; // candidates per `search` answer
const HASH_TIMEOUT_MS = 30_000;
const SEARCH_TIMEOUT_MS = 120_000;
const LIST_TIMEOUT_MS = 30_000;
const CLOSE_WAIT_MS = 2000;
const STDERR_LINES = 20;
const TAG_RE = /^[0-9a-f]{64}$/;
const DECIMAL_RE = /^(0|[1-9]\d{0,19})$/;

/** code: GPU_NO_BINARY | GPU_NO_DEVICE | GPU_START | GPU_SELF_TEST | GPU_PROTOCOL | GPU_TIMEOUT | GPU_EXITED | GPU_WRONG | GPU_CLOSED */
export class GpuError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = "GpuError";
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * Sixteen passwords with their Argon2id tags, hashed by a GPU right before it mines (together with
 * the four 40-byte ones of SELF_TEST_VECTORS). Copied from test/fixtures/gpu-vectors.json
 * (node scripts/gpu-vectors.mjs --print-embedded); a core test checks every entry is in the file.
 * Runtime code never reads test/.
 */
export const GPU_SELF_TEST_VECTORS = Object.freeze([
  Object.freeze({
    name: "nonce-0",
    password: "241f844bc274aa6cfffa62b3ffd0e9eaf14143ee4b1e0f5af8ffbfdd03efdbbf0000000000000000",
    powHash: "a44f4d805a58aec3c7cbe71a16cedd2473b56fec45b1d49c10529b8712d2c2eb",
  }),
  Object.freeze({
    name: "nonce-1",
    password: "84405fc7aa4b7151a9b6a0bd6029d457d21599e69fdf9130951e287ff932ec670100000000000000",
    powHash: "e863ce0bb9560e2dc6f08bb5958bf18576a03ce16e2c864571b0858419f791ba",
  }),
  Object.freeze({
    name: "nonce-u32-max",
    password: "3d0c92a9698908d353fc165ac1549d6a3e6dbd5b175ea2f5c7d26b8de27d0f7bffffffff00000000",
    powHash: "3a61b3277559b87c77cf2b50ba6e72b8ded350b505e5b69aa935d6196cdf6ca0",
  }),
  Object.freeze({
    name: "nonce-2^32",
    password: "11c43e4c995dee3a66a9e01548cad15fe227a5a9dac72d6084dc7a5d8cb2d0b50000000001000000",
    powHash: "8fe80b9fbc98a0f17d0a629967cbca051ca204c57a820830c3e3bd48e20027c0",
  }),
  Object.freeze({
    name: "nonce-2^63",
    password: "94ef3100f49fceb1ca070cb975f1763f0cb9fb0c86b1efd1041aab61f9ffbcbe0000000000000080",
    powHash: "0b1918094f556e8d478edfafa0226770f1ed298e29fc736a73103aba2934cf62",
  }),
  Object.freeze({
    name: "nonce-u64-max",
    password: "ccab20b18423eae3e8a82ea3f40e427f8b5282f2cd4478bb93962376a91cc9d8ffffffffffffffff",
    powHash: "4b8f17bc4072060a3c981e6a4973fccf85d5dc3704a6b0365f0db3cd6078625f",
  }),
  Object.freeze({
    name: "all-zero",
    password: "00000000000000000000000000000000000000000000000000000000000000000000000000000000",
    powHash: "c036d79a07e899416ab7be0987b3672005f5c436d385444583d9327e6d205d9f",
  }),
  Object.freeze({
    name: "all-ones",
    password: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    powHash: "94e702cfe7583f554b9fa572aa9be072d098858321ff3567490b19714907448f",
  }),
  Object.freeze({
    name: "random-0",
    password: "1b96a7d094312e3bfbb448aa3d0c32a9ef5fdd0ce2eaa1ff6030f2e56e80cfc76d4bad27233ab3b5",
    powHash: "2c83a9a7f38160ddb94b8d272013221f6846a1d9347886eb4b8de9025473266b",
  }),
  Object.freeze({
    name: "random-1",
    password: "feba393dcb8a68ea9491585bb8d4c5b7d11fa4b06149268a1da9d56cd20326c6395ec74db3238832",
    powHash: "7b73236690dcba732f5ff700432f64c110fdd5ca3213299e18582c8cbc6c6583",
  }),
  Object.freeze({
    name: "random-2",
    password: "e08ddd191e219c22aa273a2115ca739f9c0f132116415e35b79a87482dcc97c1054bf93519e572a7",
    powHash: "5a1a53c56336a4609ba3d06398fb89be620929dffff0f820462f5f61448cc133",
  }),
  Object.freeze({
    name: "random-3",
    password: "de32f1940fd54587754fe1458e606984a7323783e7aae56886b518029966365946407859a58d1770",
    powHash: "1385d7817d2d9f5e5b373756f4d2c025b7a728c00e88b89cb4d7dd945d6085c6",
  }),
  Object.freeze({
    name: "random-4",
    password: "82bdc53ebf7d156347a6e500edf3eed84f2f048ad04ec56106de51931b27d3d9834e1c3dca180314",
    powHash: "1d58f5fc6f9fd5b54b98959c19699526f1425673e927e97220ac9d617a8644a8",
  }),
  Object.freeze({
    name: "random-5",
    password: "c570e3d8f58c6aa17686bbc595eb65704bd10db9656ee7294251ae254a1d4b6de4c394c11483d647",
    powHash: "acbf7e0273c958710d8e0c8e89443828b0c941856e3d598199fc9ff393482f0f",
  }),
  Object.freeze({
    name: "random-6",
    password: "f90a7eb59cab383ed1176fd711c5394d31006d9ffb2ddfd3c7b60d76e3d4828c01bcf15689356b5f",
    powHash: "a69b67f2e1e453c218f4124963972ae1fc81377554d206f76802d9f7fb51e88b",
  }),
  Object.freeze({
    name: "random-7",
    password: "e55c0b97cbb2aeee97fb7a0ecc137338c03bdce39c1afc7f0aefaa36bdd50de524b14ba5071ceaf6",
    powHash: "1de56cea92de4e2964ef43c4a052d75fdb55bfb7a2fb191fd1b8abea1ef48f17",
  }),
]);

// ---------------------------------------------------------------- binary discovery

const NO_BINARY = (platform, arch) =>
  `no GPU miner binary for ${platform}-${arch}: run npm run gpu:fetch, build it (gpu/README.md), or set MURKLE_GPU_BIN; nothing was mined`;
const NO_DEVICE = "no CUDA device found (driver 525 or newer is needed); nothing was mined";

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** MURKLE_GPU_BIN, else gpu/bin/murkle-gpu-<platform>-<arch>[.exe] under the repository. Throws GPU_NO_BINARY. */
export function gpuBinaryPath({ env = process.env, platform = process.platform, arch = process.arch, root = ROOT } = {}) {
  const override = env.MURKLE_GPU_BIN;
  if (override) {
    if (!isFile(override)) throw new GpuError(`MURKLE_GPU_BIN is set to "${override}", but there is no file there; nothing was mined`, "GPU_NO_BINARY");
    return override;
  }
  const file = join(root, "gpu", "bin", `murkle-gpu-${platform}-${arch}${platform === "win32" ? ".exe" : ""}`);
  if (!existsSync(file) || !isFile(file)) throw new GpuError(NO_BINARY(platform, arch), "GPU_NO_BINARY");
  return file;
}

// ---------------------------------------------------------------- children

const LIVE = new Set();
let exitHook = false;
function track(child) {
  if (!exitHook) {
    exitHook = true;
    process.on("exit", () => {
      for (const c of LIVE) {
        try {
          c.kill();
        } catch {
          // already gone
        }
      }
    });
  }
  LIVE.add(child);
  child.once("exit", () => LIVE.delete(child));
}

function spawnChild(spawn, bin, args) {
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  track(child);
  return child;
}

/** Keeps the last STDERR_LINES lines of a child's stderr. */
function tailOf(child) {
  const lines = [];
  if (child.stderr) {
    createInterface({ input: child.stderr }).on("line", (l) => {
      lines.push(l);
      if (lines.length > STDERR_LINES) lines.shift();
    });
  }
  return lines;
}

const withTail = (message, tail) => (tail.length ? `${message}; last stderr lines: ${tail.join(" | ")}` : message);

/** Lists the CUDA devices: -> [{ index, name, cc, vramMiB }]. GPU_NO_DEVICE when there is none. */
export async function listGpus({ bin, spawn = nodeSpawn, timeoutMs = LIST_TIMEOUT_MS }) {
  const child = spawnChild(spawn, bin, ["--list"]);
  const tail = tailOf(child);
  const devices = [];
  let count = null;
  let fatal = null;
  let bad = null;
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      bad ??= `an unreadable line from ${bin} --list`;
      return;
    }
    if (m?.type === "device" && Number.isSafeInteger(m.index) && typeof m.name === "string" && typeof m.cc === "string" && Number.isSafeInteger(m.vramMiB)) {
      devices.push({ index: m.index, name: m.name, cc: m.cc, vramMiB: m.vramMiB });
    } else if (m?.type === "list" && Number.isSafeInteger(m.count)) count = m.count;
    else if (m?.type === "fatal") fatal = m;
    else bad ??= "an unexpected line from --list";
  });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // already gone
      }
      reject(new GpuError(withTail(`${bin} --list did not answer within ${timeoutMs} ms`, tail), "GPU_TIMEOUT"));
    }, timeoutMs);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(new GpuError(`could not start ${bin}: ${e.message}`, "GPU_START"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  if (fatal?.code === "NO_DEVICE") throw new GpuError(NO_DEVICE, "GPU_NO_DEVICE");
  if (fatal) throw new GpuError(withTail(`${bin} --list failed (${fatal.code}): ${fatal.error}`, tail), "GPU_START");
  if (bad) throw new GpuError(withTail(bad, tail), "GPU_PROTOCOL");
  if (count === null) throw new GpuError(withTail(`${bin} --list ended (exit ${exit}) without a device list`, tail), "GPU_START");
  if (count !== devices.length) throw new GpuError(`${bin} --list announced ${count} devices but described ${devices.length}`, "GPU_PROTOCOL");
  if (!devices.length) throw new GpuError(NO_DEVICE, "GPU_NO_DEVICE");
  return devices;
}

// ---------------------------------------------------------------- one device

const emptySearch = () => ({ done: 0n, ms: 0, cancelled: true, candidates: [], more: 0, probe: null });
const asBig = (v, what) => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new TypeError(`${what} must be a whole number`);
};
const challengeBytes = (c) => {
  const b = typeof c === "string" ? unhex(c) : c;
  if (!(b instanceof Uint8Array) || b.length !== CHALLENGE_LEN) throw new TypeError(`challenge must be ${CHALLENGE_LEN} bytes`);
  return b;
};
const counterBig = (n) => (n instanceof Uint8Array || typeof n === "string" ? counterOf(n) : asBig(n, "nonceStart"));

class GpuDevice {
  /** info: the hello line, parsed: { device, name, cc, sms, vramMiB, slots, hashesPerBlock, version } */
  info = null;
  #child;
  #tail;
  #pending = null;
  #starting = null;
  #error = null; // why the process is no longer usable
  #closing = false;
  #exited;
  #chain = Promise.resolve();
  #nextId = 1;
  #lineLen = 0;

  constructor(child) {
    this.#child = child;
    this.#tail = tailOf(child);
    this.#exited = new Promise((resolve) => child.once("exit", resolve));
    child.stdin.on("error", () => {}); // EPIPE: the exit handler reports the real cause
    child.stdout.on("data", (chunk) => {
      // readline only emits whole lines; a line that never ends must not grow without bound.
      const nl = chunk.lastIndexOf(10);
      this.#lineLen = nl < 0 ? this.#lineLen + chunk.length : chunk.length - nl - 1;
      if (this.#lineLen > MAX_LINE) this.#fail(new GpuError("the GPU process wrote a line over 1 MiB", "GPU_PROTOCOL"));
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(line));
    child.once("error", (e) => this.#fail(new GpuError(`could not run the GPU process: ${e.message}`, "GPU_START")));
    child.once("exit", (code, signal) => {
      if (this.#closing) return;
      this.#fail(new GpuError(`the GPU process exited (${code ?? signal})`, "GPU_EXITED"));
    });
  }

  /** Waits for the hello line. */
  start(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(new GpuError(`the GPU process did not start within ${timeoutMs} ms`, "GPU_TIMEOUT")), timeoutMs);
      this.#starting = {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      if (this.#error) this.#starting.reject(this.#error);
    });
  }

  get closed() {
    return this.#closing;
  }

  /** Records the failure once, rejects what is waiting and kills the child. */
  #fail(err) {
    if (this.#error || this.#closing) return;
    const full = Object.assign(err, { stderrTail: [...this.#tail] });
    full.message = withTail(full.message, this.#tail);
    this.#error = full;
    const p = this.#pending;
    this.#pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(full);
    }
    const s = this.#starting;
    this.#starting = null;
    s?.reject(full);
    try {
      this.#child.kill();
    } catch {
      // already gone
    }
  }

  #onLine(line) {
    if (this.#error || this.#closing) return;
    if (line.length > MAX_LINE) return this.#fail(new GpuError("the GPU process wrote a line over 1 MiB", "GPU_PROTOCOL"));
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      return this.#fail(new GpuError(`the GPU process wrote a line that is not JSON: ${line.slice(0, 80)}`, "GPU_PROTOCOL"));
    }
    if (!m || typeof m !== "object" || Array.isArray(m)) return this.#fail(new GpuError("the GPU process wrote a JSON line that is not an object", "GPU_PROTOCOL"));
    if (m.type === "fatal") {
      const text = `the GPU process stopped (${m.code}): ${m.error}`;
      return this.#fail(m.code === "NO_DEVICE" ? new GpuError(NO_DEVICE, "GPU_NO_DEVICE") : new GpuError(text, m.code === "BAD_ARGS" || m.code === "BAD_DEVICE" ? "GPU_START" : "GPU_EXITED"));
    }
    if (m.type === "hello") return this.#onHello(m);
    if (!this.info) return this.#fail(new GpuError(`the GPU process sent "${m.type}" before its hello`, "GPU_PROTOCOL"));
    if (m.type !== "hash" && m.type !== "search" && m.type !== "error") return this.#fail(new GpuError(`the GPU process sent an unknown line type "${m.type}"`, "GPU_PROTOCOL"));
    const p = this.#pending;
    if (!p || m.id !== p.id) {
      return this.#fail(new GpuError(`the GPU process answered request ${m.id} but ${p ? `request ${p.id}` : "none"} is pending`, "GPU_PROTOCOL"));
    }
    if (m.type === "error") return this.#fail(new GpuError(`the GPU process refused request ${p.id} (${m.code}): ${m.error}`, "GPU_PROTOCOL"));
    if (m.type !== p.kind) return this.#fail(new GpuError(`the GPU process answered a ${p.kind} request with a ${m.type} line`, "GPU_PROTOCOL"));
    let value;
    try {
      value = p.parse(m);
    } catch (e) {
      return this.#fail(e instanceof GpuError ? e : new GpuError(`bad ${p.kind} answer: ${e.message}`, "GPU_PROTOCOL"));
    }
    this.#pending = null;
    clearTimeout(p.timer);
    p.resolve(value);
  }

  #onHello(m) {
    if (this.info) return this.#fail(new GpuError("the GPU process sent a second hello", "GPU_PROTOCOL"));
    const ok = (k) => Number.isSafeInteger(m[k]) && m[k] >= 0;
    if (m.protocol !== GPU_PROTOCOL_VERSION) return this.#fail(new GpuError(`the GPU process speaks protocol ${m.protocol}, this CLI speaks ${GPU_PROTOCOL_VERSION}`, "GPU_PROTOCOL"));
    if (!ok("device") || typeof m.name !== "string" || typeof m.cc !== "string" || !ok("sms") || !ok("vramMiB") || !ok("slots") || m.slots < 1 || !ok("hashesPerBlock")) {
      return this.#fail(new GpuError("the GPU process sent a malformed hello", "GPU_PROTOCOL"));
    }
    this.info = { device: m.device, name: m.name, cc: m.cc, sms: m.sms, vramMiB: m.vramMiB, slots: m.slots, hashesPerBlock: m.hashesPerBlock, version: String(m.version ?? "") };
    const s = this.#starting;
    this.#starting = null;
    s?.resolve(this);
  }

  #send(text) {
    try {
      this.#child.stdin.write(`${text}\n`);
    } catch (e) {
      this.#fail(new GpuError(`could not write to the GPU process: ${e.message}`, "GPU_EXITED"));
    }
  }

  /** One request at a time: calls queue up behind each other. */
  #queue(fn) {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.then(() => {}, () => {});
    return run;
  }

  #request(kind, text, id, parse, timeoutMs, onSent) {
    return new Promise((resolve, reject) => {
      if (this.#closing) return reject(new GpuError("the GPU device is closed", "GPU_CLOSED"));
      if (this.#error) return reject(this.#error);
      const timer = setTimeout(
        () => this.#fail(new GpuError(`the GPU process did not answer ${kind} request ${id} within ${timeoutMs} ms`, "GPU_TIMEOUT")),
        timeoutMs,
      );
      this.#pending = { id, kind, parse, resolve, reject, timer };
      this.#send(text);
      onSent?.();
    });
  }

  /** Argon2id of each 40-byte password, in order: -> Uint8Array(32)[] */
  async hash(passwords) {
    for (const p of passwords) {
      if (!(p instanceof Uint8Array) || p.length !== PASSWORD_LEN) throw new TypeError(`password must be ${PASSWORD_LEN} bytes`);
    }
    const out = [];
    for (let i = 0; i < passwords.length; i += MAX_HASH_REQUEST) {
      const chunk = passwords.slice(i, i + MAX_HASH_REQUEST);
      const got = await this.#queue(() => {
        const id = this.#nextId++;
        return this.#request("hash", `hash ${id} ${chunk.map(hex).join(" ")}`, id, (m) => {
          if (m.ok !== true || !Array.isArray(m.hashes) || m.hashes.length !== chunk.length || !m.hashes.every((h) => typeof h === "string" && TAG_RE.test(h))) {
            throw new GpuError("the GPU process answered a malformed hash line", "GPU_PROTOCOL");
          }
          return m.hashes.map((h) => unhex(h));
        }, HASH_TIMEOUT_MS);
      });
      out.push(...got);
    }
    return out;
  }

  /**
   * Hashes nonceStart, nonceStart + 1, … (mod 2^64, the counter encoding of nonceOf) until a batch
   * holds a hash <= target, `count` nonces are done, or `signal` aborts (then the binary is told to
   * cancel and the partial result comes back, cancelled: true).
   * -> { done: bigint, ms, cancelled, candidates: [{ nonce: Uint8Array(8), hash }], more, probe: { nonce, hash } | null }
   */
  async search({ challenge, target, nonceStart, count, probe = 0, signal, timeoutMs = SEARCH_TIMEOUT_MS }) {
    const ch = challengeBytes(challenge);
    const tgt = typeof target === "string" ? BigInt(`0x${target}`) : asBig(target, "target");
    if (tgt < 0n || tgt > MAX_TARGET) throw new RangeError("target must be 0 .. 2^256 - 1");
    const start = counterBig(nonceStart);
    if (start < 0n || start > U64) throw new RangeError("nonceStart must be 0 .. 2^64 - 1");
    const n = asBig(count, "count");
    if (n < 1n || n > MAX_COUNT) throw new RangeError("count must be 1 .. 2^53 - 1");
    const pr = asBig(probe, "probe");
    if (pr < 0n || pr >= n) throw new RangeError("probe must be 0 .. count - 1");
    if (signal?.aborted) return emptySearch();
    return this.#queue(() => {
      if (signal?.aborted) return emptySearch();
      const id = this.#nextId++;
      const text = `search ${id} ${hex(ch)} ${tgt.toString(16).padStart(64, "0")} ${start} ${n} ${pr}`;
      let cancelled = false;
      const cancel = () => {
        if (cancelled || !this.#pending || this.#pending.id !== id) return;
        cancelled = true;
        this.#send(`cancel ${id}`);
      };
      const parse = (m) => parseSearch(m, { start, n, pr });
      const run = this.#request("search", text, id, parse, timeoutMs, () => {
        if (signal?.aborted) cancel();
        else signal?.addEventListener("abort", cancel, { once: true });
      });
      return run.finally(() => signal?.removeEventListener("abort", cancel));
    });
  }

  /** `quit`, then up to 2 s for the process to leave, then a kill. */
  async close() {
    if (this.#closing) return this.#exited;
    this.#closing = true;
    const closed = new GpuError("the GPU device is closed", "GPU_CLOSED");
    const p = this.#pending;
    this.#pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(closed);
    }
    this.#starting?.reject(closed);
    this.#starting = null;
    try {
      this.#child.stdin.write("quit\n");
      this.#child.stdin.end();
    } catch {
      // the process is already gone
    }
    let timer;
    await Promise.race([this.#exited, new Promise((r) => (timer = setTimeout(r, CLOSE_WAIT_MS)))]);
    clearTimeout(timer);
    try {
      this.#child.kill();
    } catch {
      // gone
    }
    return undefined;
  }
}

/** Checks one `search` line against the request; throws GPU_PROTOCOL on anything the binary should never say. */
function parseSearch(m, { start, n, pr }) {
  const bad = (why) => new GpuError(`the GPU process answered a malformed search line (${why})`, "GPU_PROTOCOL");
  if (m.ok !== true) throw bad("ok is not true");
  if (typeof m.done !== "string" || !DECIMAL_RE.test(m.done)) throw bad("done");
  const done = BigInt(m.done);
  if (done > n) throw bad("done is above count");
  if (typeof m.ms !== "number" || !Number.isFinite(m.ms) || m.ms < 0) throw bad("ms");
  if (typeof m.cancelled !== "boolean") throw bad("cancelled");
  if (!Array.isArray(m.candidates) || m.candidates.length > MAX_CANDIDATES) throw bad("candidates");
  if (!Number.isSafeInteger(m.more) || m.more < 0 || BigInt(m.candidates.length + m.more) > done) throw bad("more");
  let last = -1n;
  const candidates = m.candidates.map((c) => {
    if (!c || typeof c.nonce !== "string" || !DECIMAL_RE.test(c.nonce) || typeof c.hash !== "string" || !TAG_RE.test(c.hash)) throw bad("a candidate");
    const nonce = BigInt(c.nonce);
    if (nonce > U64) throw bad("a candidate nonce");
    const at = (nonce - start) & U64; // its distance from the start; candidates lie in the finished range, in order
    if (at >= done || at <= last) throw bad("a candidate outside the finished range or out of order");
    last = at;
    return { nonce: nonceOf(nonce), hash: unhex(c.hash) };
  });
  let probe = null;
  if (pr < done) {
    if (typeof m.probe !== "string" || !TAG_RE.test(m.probe)) throw bad("the probe tag is missing though its nonce was hashed");
    probe = { nonce: nonceOf((start + pr) & U64), hash: unhex(m.probe) };
  } else if (m.probe !== null) throw bad("a probe tag for a nonce that was not hashed");
  return { done, ms: m.ms, cancelled: m.cancelled, candidates, more: m.more, probe };
}

/** Starts murkle-gpu for one device and waits for its hello. -> GpuDevice (with .info) */
export async function openGpu({ bin, device, spawn = nodeSpawn, startTimeoutMs = 30_000, args = [] }) {
  if (!Number.isSafeInteger(device) || device < 0) throw new RangeError("device must be a whole number");
  const child = spawnChild(spawn, bin, ["--device", String(device), ...args]);
  const dev = new GpuDevice(child);
  try {
    await dev.start(startTimeoutMs);
  } catch (e) {
    await dev.close().catch(() => {});
    throw e;
  }
  return dev;
}

// ---------------------------------------------------------------- self-test

const sameBytes = (a, b) => equal(a, b);

/**
 * What a device must pass before it mines (gpu/README.md): (a) the reference vectors, (b) 32 random
 * passwords against `verifyMany`, (c) the boundary of the target comparison (equality counts, one
 * less does not), (d) a search over slots + 7 nonces stops after exactly one full batch with the
 * first 64 nonces as candidates, 8 of which are re-hashed by `verifyMany`. Throws GPU_SELF_TEST.
 * vectors: [{ name, password: hex80, powHash: hex64 }], default SELF_TEST_VECTORS (40-byte ones) + GPU_SELF_TEST_VECTORS.
 */
export async function gpuSelfTest(device, { verifyMany, vectors = defaultVectors(), randomBytes = nodeRandomBytes } = {}) {
  const fail = (detail) => {
    throw new GpuError(detail, "GPU_SELF_TEST");
  };
  const rand = (n) => Uint8Array.from(randomBytes(n));
  const short = (b) => `${hex(b).slice(0, 16)}…`;
  const slots = device.info.slots;

  // (a) the known answers
  const known = vectors.map((v) => ({ name: v.name, password: unhex(v.password), want: v.powHash }));
  const got = await device.hash(known.map((v) => v.password));
  known.forEach((v, i) => {
    if (hex(got[i]) !== v.want) fail(`vector ${v.name}: the GPU hashed ${short(got[i])} where the reference has ${v.want.slice(0, 16)}…`);
  });

  // (b) random passwords against the pool
  const random = Array.from({ length: 32 }, () => rand(PASSWORD_LEN));
  const [fromGpu, fromRef] = [await device.hash(random), await verifyMany(random)];
  random.forEach((_, i) => {
    if (!sameBytes(fromGpu[i], fromRef[i])) fail(`random password ${i}: the GPU hashed ${short(fromGpu[i])} where the reference has ${short(fromRef[i])}`);
  });

  // (c) the boundary of the target comparison, on a vector whose tag can be lowered by one
  const v = known.find((k) => BigInt(`0x${k.want}`) > 0n);
  if (!v) fail("no vector to test the target boundary with");
  const challenge = v.password.slice(0, CHALLENGE_LEN);
  const nonceStart = counterOf(v.password.slice(CHALLENGE_LEN));
  const tag = BigInt(`0x${v.want}`);
  const equalHit = await device.search({ challenge, target: tag, nonceStart, count: 1, probe: 0 });
  if (equalHit.done !== 1n || equalHit.candidates.length !== 1 || hex(equalHit.candidates[0].hash) !== v.want || !equal(equalHit.candidates[0].nonce, nonceOf(nonceStart))) {
    fail(`boundary: a target equal to the hash of ${v.name} did not return that nonce`);
  }
  const lowerMiss = await device.search({ challenge, target: tag - 1n, nonceStart, count: 1, probe: 0 });
  if (lowerMiss.done !== 1n || lowerMiss.candidates.length !== 0) fail(`boundary: a target one below the hash of ${v.name} still returned a nonce`);

  // (d) a full-batch search with the loosest target
  const batchChallenge = rand(CHALLENGE_LEN);
  const start = bytesToBig(rand(8));
  const total = BigInt(slots) + 7n;
  const probe = Number(bytesToBig(rand(4)) % total);
  const r = await device.search({ challenge: batchChallenge, target: MAX_TARGET, nonceStart: start, count: total, probe });
  const want = Math.min(MAX_CANDIDATES, slots);
  if (r.done !== BigInt(slots)) fail(`full batch: ${r.done} nonces were done where ${slots} slots were announced`);
  if (r.candidates.length !== want) fail(`full batch: ${r.candidates.length} candidates where ${want} were expected`);
  if (r.more !== slots - want) fail(`full batch: "more" is ${r.more} where ${slots - want} was expected`);
  r.candidates.forEach((c, i) => {
    if (!equal(c.nonce, nonceOf((start + BigInt(i)) & U64))) fail(`full batch: candidate ${i} is not nonce start + ${i}`);
  });
  // 8 random candidates (a partial Fisher-Yates shuffle) hashed again by the reference
  const order = [...r.candidates.keys()];
  const picks = Math.min(8, order.length);
  for (let i = 0; i < picks; i++) {
    const j = i + Number(bytesToBig(rand(4)) % BigInt(order.length - i));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const chosen = order.slice(0, picks).map((i) => r.candidates[i]);
  const again = await verifyMany(chosen.map((c) => passwordOf(batchChallenge, c.nonce)));
  chosen.forEach((c, i) => {
    if (!sameBytes(c.hash, again[i])) fail(`full batch: the GPU reported ${short(c.hash)} for nonce ${counterOf(c.nonce)} where the reference has ${short(again[i])}`);
  });
  return { vectors: known.length, slots };
}

function defaultVectors() {
  return [...SELF_TEST_VECTORS.filter((v) => !v.salt && v.password.length === PASSWORD_LEN * 2), ...GPU_SELF_TEST_VECTORS];
}

// ---------------------------------------------------------------- the lane

// Every device failure but a wrong answer (which disables the lane at once) restarts the lane: bounded
// by maxRestarts, then the lane is disabled, so no GPU_* code can leave a dead lane spinning.
const NO_RESTART_CODES = new Set(["GPU_WRONG"]);

/**
 * One GPU as a mining lane for runMiner: grind() has the pool's signature and the safety gate of
 * docs/design/mining.md section 12.2 built in. device: an opened GpuDevice that passed
 * gpuSelfTest. verifyMany: the Argon2 pool's hashMany. reopen(): a new device, self-tested (used
 * after a crash, a stall or a protocol error, at most maxRestarts times per run, then the lane is
 * disabled). disabled: null, or the sentence to print once the lane is out for the run.
 */
export class GpuLane {
  disabled = null;
  restarts = 0;
  hashed = 0; // nonces its searches finished, and
  hits = 0; // hashes at or below the target they reported (the first of each search is the one that is verified and returned)
  #probe = null; // the previous round's probe check: resolves to null (fine) or a reason
  #code = "GPU_WRONG";

  constructor({ device, verifyMany, label, reopen = null, maxRestarts = 3, randomBytes = nodeRandomBytes }) {
    this.device = device;
    this.verifyMany = verifyMany;
    this.reopen = reopen;
    this.maxRestarts = maxRestarts;
    this.randomBytes = randomBytes;
    this.index = device.info.device;
    this.name = device.info.name;
    this.label = label ?? `GPU ${this.index}`;
  }

  #disable(reason, code) {
    this.disabled = `GPU ${this.index} (${this.name}) disabled: ${reason}`;
    this.#code = code;
    this.device.close().catch(() => {});
    return new GpuError(this.disabled, code);
  }

  /** The lane is out because the GPU said something the reference does not confirm. */
  #wrong(what) {
    return this.#disable(`it reported a nonce whose Argon2 hash ${what}; nothing was paid for it. Check overclocking, temperature and drivers.`, "GPU_WRONG");
  }

  /** Awaits the previous round's probe check; a mismatch disables the lane. */
  async #settleProbe() {
    const p = this.#probe;
    this.#probe = null;
    if (p && (await p)) throw this.#wrong("differs from the reference");
  }

  #startProbe(challenge, probe) {
    this.#probe = this.verifyMany([passwordOf(challenge, probe.nonce)]).then(
      ([h]) => (equal(h, probe.hash) ? null : "mismatch"),
      () => null, // a pool failure is the pool's to report; the candidate check below still stands
    );
  }

  async #restart(cause) {
    try {
      await this.device.close();
    } catch {
      // already gone
    }
    let last = cause;
    while (this.reopen && this.restarts < this.maxRestarts) {
      this.restarts += 1;
      try {
        this.device = await this.reopen();
        return;
      } catch (e) {
        last = e;
      }
    }
    const why = this.reopen ? `${last.message}; it was restarted ${this.restarts} time${this.restarts === 1 ? "" : "s"} and failed again` : last.message;
    this.disabled = `GPU ${this.index} (${this.name}) disabled: ${why}`;
    this.#code = cause.code;
  }

  /**
   * -> { nonce, powHash, tried } like PowPool.grind; nonce is null when the range held none.
   * A candidate is returned only when the pool's own Argon2 of it equals the GPU's hash and meets
   * the target; powHash is the pool's value. Rejects GPU_WRONG (lane disabled), or a GPU_* error
   * after a restart (lane alive again, or disabled when the restarts ran out).
   */
  async grind({ challenge, target, nonceStart, count, timeoutMs, signal }) {
    if (this.disabled) throw new GpuError(this.disabled, this.#code);
    const ch = challengeBytes(challenge);
    const tgt = typeof target === "string" ? BigInt(`0x${target}`) : asBig(target, "target");
    const n = asBig(count, "count");
    await this.#settleProbe();
    const probe = Number(bytesToBig(Uint8Array.from(this.randomBytes(6))) % n);
    let res;
    try {
      res = await this.device.search({ challenge: ch, target: tgt, nonceStart: counterBig(nonceStart), count: n, probe, signal, timeoutMs });
    } catch (e) {
      if (e instanceof GpuError && !NO_RESTART_CODES.has(e.code)) await this.#restart(e);
      throw e;
    }
    if (res.probe) this.#startProbe(ch, res.probe);
    const tried = Number(res.done);
    this.hashed += tried;
    this.hits += res.candidates.length + res.more;
    const first = res.candidates[0];
    if (!first) return { nonce: null, powHash: null, tried };
    const [h] = await this.verifyMany([passwordOf(ch, first.nonce)]);
    if (!equal(h, first.hash)) throw this.#wrong("differs from the reference");
    if (!meetsTarget(h, tgt)) throw this.#wrong("does not meet the target");
    return { nonce: first.nonce, powHash: h, tried };
  }

  /** Stops the child process. */
  async close() {
    await this.device.close();
  }
}

// The GPU miner's Node side (docs/design/mining.md section 12.2, gpu/README.md): one child
// process `murkle-gpu` per CUDA device, spoken to over stdin (plain text commands) and stdout
// (JSON lines). Nothing the GPU says is trusted: GpuLane.grind hands out a nonce only after the
// Argon2 pool (hash-wasm, else noble) has recomputed its hash and the target check has passed on
// that value, and claim() in bin/murkle.mjs checks it once more with the reference. A wrong
// answer disables the lane for the run (GPU_WRONG); a crash, a stall or a protocol slip restarts
// it (a new child and a full self-test) a bounded number of times and is never a "no solution".
// Node only (child_process); the mining primitives it uses are the isomorphic ones of ./mine.mjs.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { hex, unhex } from "./bytes.mjs";
import { PASSWORD_LEN, counterOf, nonceOf } from "./mine.mjs";
import { GpuError, asBig, challengeBytes, counterBig } from "./gpu-gate.mjs";

// The device-independent safety gate (GpuError, the self-test vectors, gpuSelfTest, GpuLane) lives in
// ./gpu-gate.mjs, which is isomorphic and shared with the WebGPU engine. These four names are
// re-exported so that every existing import of ./gpu.mjs keeps working.
export { GPU_SELF_TEST_VECTORS, GpuError, GpuLane, gpuSelfTest } from "./gpu-gate.mjs";

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


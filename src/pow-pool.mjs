// Bounded Argon2 worker pool (mining.md §8.5, SPEC.md §15). Every Argon2 evaluation on
// the server runs here, never on the event loop. A worker failure, a timeout or a closed
// pool rejects with PowError: it is an error, never an "insufficient work" verdict.
// No top-level node: import; Node modules load inside createNodePowPool / defaultPowThreads.
import { hex, unhex } from "./bytes.mjs";
import { PASSWORD_LEN } from "./mine.mjs";

export class PowError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PowError";
    this.code = code; // POW_SELF_TEST | POW_WORKER_FAILED | POW_TIMEOUT | POW_BUSY | POW_CLOSED
  }
}

const MAX_CHUNK = 64; // passwords per hashMany task
const MAX_START_FAILURES = 3; // consecutive crashes before a slot's ready message stops being awaited

/** Attaches a message / error / exit listener to a Node Worker or a Web Worker. */
function listen(w, onMessage, onError, onExit) {
  if (typeof w.on === "function") {
    w.on("message", onMessage);
    w.on("error", onError);
    w.on("exit", onExit);
  } else {
    w.onmessage = (ev) => onMessage(ev?.data);
    w.onerror = (ev) => { ev?.preventDefault?.(); onError(ev?.error ?? new Error(ev?.message ?? "worker error")); };
    w.onmessageerror = () => onError(new Error("worker message could not be read"));
  }
}

export class PowPool {
  /**
   * spawn(): a worker-like object { postMessage, on | onmessage, terminate } running the
   * pow-worker protocol: it posts { type: "ready", ok, impl } after its self-test, then answers
   * { id, type: "hash", passwords: [hex] } and { id, type: "grind", … } with { id, ok, … }.
   */
  constructor({ size, spawn, maxQueue = 4096, timeoutMs = 30_000 } = {}) {
    if (!Number.isSafeInteger(size) || size < 1) throw new RangeError("pool size must be a positive integer");
    if (typeof spawn !== "function") throw new TypeError("spawn must be a function");
    this.spawnWorker = spawn;
    this.maxQueue = maxQueue;
    this.timeoutMs = timeoutMs;
    this.queue = [];
    this.slots = [];
    this.nextId = 1;
    this.closed = false;
    this.impl = null;
    for (let i = 0; i < size; i++) this.slots.push(this.startSlot({ failures: 0 }));
  }

  startSlot(slot) {
    slot.state = "starting"; // starting | ready | failed
    slot.task = null;
    slot.retired = false;
    let resolveReady;
    slot.ready = new Promise((r) => { resolveReady = r; });
    slot.resolveReady = resolveReady;
    let w;
    try {
      w = this.spawnWorker();
    } catch (e) {
      slot.state = "failed";
      slot.error = e;
      resolveReady({ ok: false, impl: null });
      return slot;
    }
    slot.worker = w;
    slot.startTimer = setTimeout(() => this.workerDied(slot, w, new PowError("worker did not start in time", "POW_TIMEOUT")), this.timeoutMs);
    slot.startTimer.unref?.();
    listen(
      w,
      (msg) => this.onMessage(slot, w, msg),
      (err) => this.workerDied(slot, w, new PowError(`Argon2 worker failed: ${err?.message ?? err}`, "POW_WORKER_FAILED")),
      (code) => this.workerDied(slot, w, new PowError(`Argon2 worker exited (${code})`, "POW_WORKER_FAILED")),
    );
    return slot;
  }

  onMessage(slot, w, msg) {
    if (slot.worker !== w || !msg || typeof msg !== "object") return;
    if (msg.type === "ready") {
      clearTimeout(slot.startTimer);
      slot.failures = 0;
      slot.state = msg.ok ? "ready" : "failed";
      if (msg.ok) this.impl = this.impl === "noble" ? "noble" : msg.impl;
      slot.resolveReady({ ok: !!msg.ok, impl: msg.impl ?? null });
      if (!msg.ok) this.failIfNoneUsable();
      this.dispatch();
      return;
    }
    const task = slot.task;
    if (!task || msg.id !== task.id) return;
    clearTimeout(task.timer);
    slot.task = null;
    if (msg.ok) task.resolve(msg);
    else task.reject(new PowError(`Argon2 worker error: ${msg.error ?? "unknown"}`, "POW_WORKER_FAILED"));
    this.dispatch();
  }

  /** A worker exited, errored or timed out: reject what it held, replace it, carry on. */
  workerDied(slot, w, err) {
    if (slot.worker !== w || slot.retired) return;
    slot.retired = true;
    clearTimeout(slot.startTimer);
    try { w.terminate?.(); } catch { /* already gone */ }
    const task = slot.task;
    slot.task = null;
    if (task) {
      clearTimeout(task.timer);
      task.reject(err);
    }
    const wasStarting = slot.state === "starting";
    if (this.closed) return;
    slot.failures = wasStarting ? (slot.failures ?? 0) + 1 : 0;
    if (wasStarting && slot.failures >= MAX_START_FAILURES) {
      slot.state = "failed";
      slot.resolveReady({ ok: false, impl: null });
      this.failIfNoneUsable();
      return;
    }
    const oldResolve = slot.resolveReady;
    this.startSlot(slot);
    // A ready() caller that was waiting on the dead worker waits on its replacement.
    if (wasStarting) slot.ready.then(oldResolve);
    this.dispatch();
  }

  failIfNoneUsable() {
    if (this.slots.some((s) => s.state !== "failed")) return;
    const err = new PowError("Argon2 self-test failed in every worker", "POW_SELF_TEST");
    for (const t of this.queue.splice(0)) t.reject(err);
  }

  /** Waits until every worker has reported; -> { impl, workers }. Throws POW_SELF_TEST if any failed its self-test. */
  async ready() {
    if (this.closed) throw new PowError("the Argon2 pool is closed", "POW_CLOSED");
    const results = await Promise.all(this.slots.map((s) => s.ready));
    if (this.closed) throw new PowError("the Argon2 pool is closed", "POW_CLOSED");
    if (results.some((r) => !r.ok)) throw new PowError("Argon2 self-test failed", "POW_SELF_TEST");
    const impl = results.some((r) => r.impl === "noble") ? "noble" : "hash-wasm";
    return { impl, workers: this.slots.length };
  }

  submit(msg, { bounded, timeoutMs }) {
    if (this.closed) return Promise.reject(new PowError("the Argon2 pool is closed", "POW_CLOSED"));
    if (this.slots.every((s) => s.state === "failed")) return Promise.reject(new PowError("Argon2 self-test failed in every worker", "POW_SELF_TEST"));
    if (bounded && this.queue.length >= this.maxQueue) return Promise.reject(new PowError("the Argon2 queue is full", "POW_BUSY"));
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextId++, msg, resolve, reject, timeoutMs: timeoutMs ?? this.timeoutMs });
      this.dispatch();
    });
  }

  dispatch() {
    for (const slot of this.slots) {
      if (!this.queue.length) return;
      if (slot.state !== "ready" || slot.task || slot.retired) continue;
      const task = this.queue.shift();
      slot.task = task;
      const w = slot.worker;
      task.timer = setTimeout(() => this.workerDied(slot, w, new PowError("Argon2 worker did not answer in time", "POW_TIMEOUT")), task.timeoutMs);
      task.timer.unref?.();
      try {
        w.postMessage({ id: task.id, ...task.msg });
      } catch (e) {
        this.workerDied(slot, w, new PowError(`Argon2 worker failed: ${e.message}`, "POW_WORKER_FAILED"));
      }
    }
  }

  /** One Argon2id evaluation of a 40-byte password. Rejects POW_BUSY beyond maxQueue waiting tasks. */
  async hash(password) {
    const [h] = await this.run([password], true);
    return h;
  }

  /** Argon2id of every password, in input order; equal passwords are evaluated once. Never refused for queue length. */
  async hashMany(passwords) {
    return this.run(passwords, false);
  }

  async run(passwords, bounded) {
    const keys = passwords.map((p) => {
      if (!(p instanceof Uint8Array) || p.length !== PASSWORD_LEN) throw new TypeError(`password must be ${PASSWORD_LEN} bytes`);
      return hex(p);
    });
    const unique = [...new Set(keys)];
    if (!unique.length) return [];
    const workers = Math.max(1, this.slots.filter((s) => s.state !== "failed").length);
    const per = Math.min(MAX_CHUNK, Math.max(1, Math.ceil(unique.length / workers)));
    const chunks = [];
    for (let i = 0; i < unique.length; i += per) chunks.push(unique.slice(i, i + per));
    const answers = await Promise.all(chunks.map((c) => this.submit({ type: "hash", passwords: c }, { bounded })));
    const memo = new Map();
    answers.forEach((a, i) => {
      if (!Array.isArray(a.hashes) || a.hashes.length !== chunks[i].length) throw new PowError("Argon2 worker answered malformed hashes", "POW_WORKER_FAILED");
      chunks[i].forEach((k, j) => {
        const h = a.hashes[j];
        if (typeof h !== "string" || !/^[0-9a-f]{64}$/.test(h)) throw new PowError("Argon2 worker answered a malformed hash", "POW_WORKER_FAILED");
        memo.set(k, unhex(h));
      });
    });
    return keys.map((k) => Uint8Array.from(memo.get(k)));
  }

  /** Grinds `count` nonces from nonceStart (8 bytes or a bigint counter) in one worker (the CLI miner). */
  async grind({ challenge, target, nonceStart, count, timeoutMs }) {
    const t = typeof target === "string" ? target : BigInt(target).toString(16).padStart(64, "0");
    const n = nonceStart instanceof Uint8Array ? hex(nonceStart)
      : typeof nonceStart === "string" ? nonceStart
        : (() => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(nonceStart ?? 0n), true); return hex(b); })();
    const a = await this.submit({ type: "grind", challenge: typeof challenge === "string" ? challenge : hex(challenge), target: t, nonceStart: n, count }, { bounded: true, timeoutMs });
    return { nonce: a.nonce ? unhex(a.nonce) : null, powHash: a.powHash ? unhex(a.powHash) : null, tried: a.tried };
  }

  get size() { return this.slots.length; }
  get busy() { return this.slots.filter((s) => s.task).length; }
  get queued() { return this.queue.length; }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const err = new PowError("the Argon2 pool is closed", "POW_CLOSED");
    for (const t of this.queue.splice(0)) t.reject(err);
    await Promise.all(this.slots.map(async (slot) => {
      slot.retired = true;
      clearTimeout(slot.startTimer);
      slot.resolveReady?.({ ok: false, impl: null });
      if (slot.task) {
        clearTimeout(slot.task.timer);
        slot.task.reject(err);
        slot.task = null;
      }
      try { await slot.worker?.terminate?.(); } catch { /* gone */ }
    }));
  }
}

/** max(1, min(4, availableParallelism - 1)); MURKLE_POW_THREADS overrides. */
export function defaultPowThreads() {
  const env = globalThis.process?.env?.MURKLE_POW_THREADS;
  if (env != null && env !== "") {
    const n = Number(env);
    if (Number.isSafeInteger(n) && n >= 1) return n;
  }
  const os = globalThis.process?.getBuiltinModule?.("node:os");
  const cores = os?.availableParallelism?.() ?? os?.cpus?.().length ?? globalThis.navigator?.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(4, cores - 1));
}

/** A PowPool of worker_threads running ./pow-worker.mjs. Call ready() before relying on it. */
export async function createNodePowPool({ size = defaultPowThreads(), ...opts } = {}) {
  const { Worker } = await import("node:worker_threads");
  const url = new URL("./pow-worker.mjs", import.meta.url);
  return new PowPool({ size, spawn: () => new Worker(url), ...opts });
}

// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle GPU safety gate (shared by the CUDA and WebGPU devices).
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// The GPU safety gate (docs/design/mining.md section 12.2), the part that does not care what kind of
// GPU is behind a device: GpuError, the self-test vectors, gpuSelfTest and GpuLane. It was moved out of
// ./gpu.mjs unchanged so that the CUDA child-process device (./gpu.mjs, Node only) and the WebGPU engine
// (./webgpu/engine.mjs, Node and browsers) share one gate. ./gpu.mjs re-exports the four names.
// Isomorphic: it imports nothing from the Node built-in modules. A device is any object with the GpuDevice contract of ./gpu.mjs
// (info.slots / info.device / info.name, hash(passwords), search({...}), close()).
import { bytesToBig, equal, hex, unhex } from "./bytes.mjs";
import { CHALLENGE_LEN, PASSWORD_LEN, SELF_TEST_VECTORS, counterOf, meetsTarget, nonceOf, passwordOf } from "./mine.mjs";

const U64 = (1n << 64n) - 1n;
const MAX_TARGET = (1n << 256n) - 1n;
const MAX_CANDIDATES = 64; // candidates per `search` answer

/** The default randomness: the platform CSPRNG (Node and browsers). */
const defaultRandomBytes = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

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

// ---------------------------------------------------------------- shared argument helpers (also used by ./gpu.mjs)

export const asBig = (v, what) => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  throw new TypeError(`${what} must be a whole number`);
};
export const challengeBytes = (c) => {
  const b = typeof c === "string" ? unhex(c) : c;
  if (!(b instanceof Uint8Array) || b.length !== CHALLENGE_LEN) throw new TypeError(`challenge must be ${CHALLENGE_LEN} bytes`);
  return b;
};
export const counterBig = (n) => (n instanceof Uint8Array || typeof n === "string" ? counterOf(n) : asBig(n, "nonceStart"));

// ---------------------------------------------------------------- self-test

const sameBytes = (a, b) => equal(a, b);

/**
 * What a device must pass before it mines (gpu/README.md): (a) the reference vectors, (b) 32 random
 * passwords against `verifyMany`, (c) the boundary of the target comparison (equality counts, one
 * less does not), (d) a search over slots + 7 nonces stops after exactly one full batch with the
 * first 64 nonces as candidates, 8 of which are re-hashed by `verifyMany`. Throws GPU_SELF_TEST.
 * vectors: [{ name, password: hex80, powHash: hex64 }], default SELF_TEST_VECTORS (40-byte ones) + GPU_SELF_TEST_VECTORS.
 */
export async function gpuSelfTest(device, { verifyMany, vectors = defaultVectors(), randomBytes = defaultRandomBytes } = {}) {
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

  constructor({ device, verifyMany, label, reopen = null, maxRestarts = 3, randomBytes = defaultRandomBytes }) {
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
    // The random probe: one uniformly random nonce of every round (random % count) comes back with the GPU's tag and
    // is re-hashed on the CPU. Every nonce is equally likely to be the one, so a GPU that gets a fraction f of its
    // hashes wrong is caught in a round with probability f. The probe rate therefore depends on the round size: one
    // probe per round, so up to about 60 a minute in the browser (rounds of about 1 s) and about 30 a minute in the bench's
    // lane run (rounds of about 2 s). The probe check of round N is awaited AFTER round N + 1's search returns, not
    // before it starts: waiting before it left the GPU idle for the whole Argon2 re-hash (15-23 ms per round on a
    // rented RTX 4090). Measured at the live difficulty (3,600,000): +0.8% in the verify run and about +2% in the
    // profile run with an idle CPU, the same size as the run-to-run noise of about 1.7% (kernel 91,371 vs 92,934); with 22 busy CPU threads about 5-8% of the rate was recovered. The detection rate is the same;
    // only the verdict arrives one round later, and the settle below still runs before this method returns anything
    // (a candidate or "none").
    const probe = Number(bytesToBig(Uint8Array.from(this.randomBytes(6))) % n);
    let res;
    try {
      res = await this.device.search({ challenge: ch, target: tgt, nonceStart: counterBig(nonceStart), count: n, probe, signal, timeoutMs });
    } catch (e) {
      if (e instanceof GpuError && !NO_RESTART_CODES.has(e.code)) {
        // the previous round's probe is still unjudged: a wrong one bans the lane (GPU_WRONG, no restart) instead of being lost with the old device
        await this.#settleProbe();
        await this.#restart(e);
      }
      throw e;
    }
    await this.#settleProbe(); // the previous round's probe: a mismatch disables the lane and this round's answer is dropped
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


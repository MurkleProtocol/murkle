// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner prototype: Argon2 reference workers for the lab page.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// The browser port of src/pow-worker.mjs (ready and hash only), so a PowPool (src/pow-pool.mjs) can run
// hash-wasm in Web Workers on the lab page. It runs the Argon2 self-test on start, then answers one task at a time:
//   out { type: "ready", ok, impl: "hash-wasm" | "noble" | null }
//   in  { id, type: "hash", passwords: [hex80, ...] }   -> { id, ok: true, hashes: [hex64, ...] }
//   any failure                                          -> { id, ok: false, error }
import { hex, unhex } from "../../../src/bytes.mjs";
import * as mineLib from "../../../src/mine.mjs";

/**
 * The worker's logic, independent of the worker global (tests drive it directly).
 * Returns { ready: Promise<{ ok, impl }>, onMessage(msg) }.
 */
export function createPowPoolWorker({ post, mine = mineLib } = {}) {
  let st = { ok: false, impl: null };
  const ready = Promise.resolve()
    .then(() => mine.selfTest())
    .then(
      (r) => (st = { ok: Boolean(r?.ok), impl: r?.ok ? r.impl : null }),
      () => (st = { ok: false, impl: null }),
    )
    .then((r) => {
      post({ type: "ready", ok: r.ok, impl: r.impl });
      return r;
    });

  let chain = ready.then(() => {});

  async function handle(msg) {
    const id = msg?.id;
    try {
      if (!st.ok) throw new Error("Argon2 self-test failed");
      if (msg.type !== "hash") throw new Error(`unknown task ${msg?.type}`);
      const hashes = [];
      for (const p of msg.passwords) hashes.push(hex(await mine.powHash(unhex(p))));
      post({ id, ok: true, hashes });
    } catch (e) {
      post({ id, ok: false, error: String(e?.message ?? e) });
    }
  }

  return {
    ready,
    onMessage(msg) {
      chain = chain.then(() => handle(msg));
    },
  };
}

if (typeof WorkerGlobalScope !== "undefined" && globalThis instanceof WorkerGlobalScope) {
  const worker = createPowPoolWorker({ post: (m) => globalThis.postMessage(m) });
  globalThis.addEventListener("message", (e) => worker.onMessage(e.data));
}

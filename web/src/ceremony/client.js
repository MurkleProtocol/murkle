// HTTP client for the ceremony coordinator (server/ceremony-server.mjs, docs/CEREMONY.md).
// Runs in the browser (web/ceremony.html) and in Node (scripts/ceremony/contribute.mjs):
// it uses only fetch, URL and crypto.subtle.
//
// API
//   new CeremonyClient(base = "", { fetch })   base: coordinator origin, "" for the page's own
//   status(), health(), transcript()
//   join(name) -> { pass, position, heartbeatSecs }      the pass is the queue credential: keep it
//                                                         in memory only, it is never shown or stored
//   turn(pass) -> { state: "waiting" | "active" | "done" | "expired" | "unknown", ... }
//   leave(pass)
//   waitForTurn(pass, { onUpdate, signal, pollMs }) -> the "active" turn
//   download(url, { expectSha256, onProgress, signal }) -> Uint8Array (sha256 checked)
//   upload(pass, bytes) -> receipt
//   CeremonyError: .code (the coordinator's error code), .status, .detail

export const API_PATH = "/ceremony/api";

export class CeremonyError extends Error {
  constructor(code, status = 0, detail = {}) {
    super(detail.reason ? `${code}: ${detail.reason}` : code);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

const sleep = (ms, signal) =>
  new Promise((done, fail) => {
    if (signal?.aborted) return fail(new CeremonyError("aborted"));
    const t = setTimeout(done, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(t);
      fail(new CeremonyError("aborted"));
    }, { once: true });
  });

export async function sha256Hex(bytes) {
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class CeremonyClient {
  constructor(base = "", { fetch: f = globalThis.fetch } = {}) {
    this.base = String(base).replace(/\/+$/, "");
    // Called as a plain function: browsers throw "Illegal invocation" for fetch called on another object.
    this.fetch = (...args) => f(...args);
  }

  url(path) {
    if (/^https?:\/\//.test(path)) return path;
    return this.base ? new URL(path, this.base + "/").toString() : path;
  }

  async call(method, path, { pass = null, json = undefined, body = undefined, headers = {} } = {}) {
    const h = { ...headers };
    if (pass) h.authorization = `Bearer ${pass}`;
    if (json !== undefined) h["content-type"] = "application/json";
    let res;
    try {
      res = await this.fetch(this.url(API_PATH + path), {
        method,
        headers: h,
        body: json !== undefined ? JSON.stringify(json) : body,
        cache: "no-store",
        credentials: "omit",
      });
    } catch (e) {
      throw new CeremonyError("network", 0, { reason: e?.message ?? String(e) });
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) throw new CeremonyError(data?.error ?? `http_${res.status}`, res.status, data ?? {});
    return data;
  }

  status() {
    return this.call("GET", "/status");
  }

  health() {
    return this.call("GET", "/health");
  }

  transcript() {
    return this.call("GET", "/transcript.json");
  }

  join(name) {
    return this.call("POST", "/join", { json: { name } });
  }

  turn(pass) {
    return this.call("GET", "/turn", { pass });
  }

  leave(pass) {
    return this.call("POST", "/leave", { pass });
  }

  /** Polls until the slot is ours; every poll is the heartbeat. Throws on expired, done or unknown. */
  async waitForTurn(pass, { onUpdate = () => {}, signal = null, pollMs = null } = {}) {
    for (;;) {
      if (signal?.aborted) throw new CeremonyError("aborted");
      let t;
      try {
        t = await this.turn(pass);
      } catch (e) {
        if (e.code !== "network" && !(e.status >= 500)) throw e;
        onUpdate({ state: "retrying", reason: e.message });
        await sleep(3000, signal);
        continue;
      }
      onUpdate(t);
      if (t.state === "active") return t;
      if (t.state !== "waiting") throw new CeremonyError(`turn_${t.state}`);
      const every = pollMs ?? Math.max(1000, Math.floor(((t.heartbeatSecs ?? 60) * 1000) / 4));
      await sleep(every, signal);
    }
  }

  /** Downloads a key and checks its sha256 before anything uses it. */
  async download(url, { expectSha256 = null, onProgress = () => {}, signal = null } = {}) {
    let res;
    try {
      res = await this.fetch(this.url(url), { cache: "no-store", credentials: "omit", signal });
    } catch (e) {
      throw new CeremonyError("network", 0, { reason: e?.message ?? String(e) });
    }
    if (!res.ok) throw new CeremonyError(`http_${res.status}`, res.status);
    const total = Number(res.headers.get("content-length")) || 0;
    let bytes;
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      const parts = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        got += value.length;
        onProgress(got, total);
      }
      bytes = new Uint8Array(got);
      let o = 0;
      for (const p of parts) {
        bytes.set(p, o);
        o += p.length;
      }
    } else {
      bytes = new Uint8Array(await res.arrayBuffer());
      onProgress(bytes.length, total);
    }
    if (expectSha256) {
      const got = await sha256Hex(bytes);
      if (got !== expectSha256) throw new CeremonyError("bad_download", 0, { reason: `sha256 ${got}, expected ${expectSha256}` });
    }
    return bytes;
  }

  upload(pass, bytes) {
    return this.call("POST", "/contribution", {
      pass,
      body: bytes,
      // fetch sets Content-Length itself for a byte body (the coordinator requires it).
      headers: { "content-type": "application/octet-stream" },
    });
  }
}

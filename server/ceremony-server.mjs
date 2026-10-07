#!/usr/bin/env node
// Coordinator of the Murkle phase-2 trusted-setup ceremony (audit A-8, docs/CEREMONY.md).
// A separate process from the indexer; the reverse proxy sends /ceremony/api/* and
// /ceremony/files/* here.
//
// One contributor at a time: people join a queue, the head of the queue gets the slot,
// downloads the latest key, adds their contribution and uploads the result. Every upload is
// verified against the r1cs and the phase-1 ptau (snarkjs `zkey verifyFromInit` from the
// deterministic 0000.zkey, in a child process with a timeout) before it is accepted, and the
// public transcript lists each accepted contribution's hash. The coordinator can refuse or
// delay people; it cannot forge a contribution, because anyone can re-run the verification
// (scripts/ceremony/verify.mjs) and every contributor checks their own hash in the transcript.
//
// Queue passes are 32 random bytes sent as `Authorization: Bearer <hex>`; only their sha256
// is stored, and they are never logged. No cookies, no CORS.
//
//   node server/ceremony-server.mjs   (env: MURKLE_CEREMONY_*, docs/CEREMONY.md "Operator runbook")
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PATHS, ROOT, UPLOAD_SLACK, VERIFIED_WITH, ceremonyPaths, cleanName, closeCommitmentOf, openBeaconSource, readJson,
  readJsonOr, sha256Hex, writeJsonAtomic, zkeyName,
} from "../scripts/ceremony/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFY_ONE = join(HERE, "..", "scripts", "ceremony", "verify-one.mjs");
const RESULT_PREFIX = "@@murkle-verify ";
const API = "/ceremony/api";
const PASS_RE = /^Bearer ([0-9a-f]{64})$/;
const MAX_JSON_BODY = 1024;
const MAX_REMEMBERED = 2000; // done/expired passes kept so their holders get a clear answer
const GiB = 2 ** 30;

/**
 * Runs scripts/ceremony/verify-one.mjs in a child process.
 * verifyInChildProcess({ init, ptau, zkey, timeoutMs, signal }) -> { ok, reason?, contributions? }
 */
export function verifyInChildProcess({ init, ptau, zkey, timeoutMs = 600_000, signal = null }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [VERIFY_ONE, "--init", init, "--ptau", ptau, "--zkey", zkey], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      done(r);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: `verification timed out after ${Math.round(timeoutMs / 1000)} s` });
    }, timeoutMs);
    const onAbort = () => {
      child.kill("SIGKILL");
      finish({ ok: false, reason: "coordinator is shutting down", aborted: true });
    };
    signal?.addEventListener?.("abort", onAbort);
    child.stdout.on("data", (d) => {
      if (out.length < 4 << 20) out += d;
    });
    child.stderr.on("data", (d) => {
      if (err.length < 64 << 10) err += d;
    });
    child.on("error", (e) => finish({ ok: false, reason: `verifier did not start: ${e.message}`, internal: true }));
    child.on("close", (code) => {
      const line = out.split("\n").find((l) => l.startsWith(RESULT_PREFIX));
      if (code === 0 && line) {
        try {
          return finish(JSON.parse(line.slice(RESULT_PREFIX.length)));
        } catch {
          /* fall through */
        }
      }
      finish({ ok: false, reason: `verifier failed (exit ${code})${err ? `: ${err.trim().split("\n").at(-1)}` : ""}`, internal: true });
    });
  });
}

/**
 * The rate-limit key of a client address: the /24 of an IPv4 address (also when written as
 * IPv4-mapped IPv6), the /48 of an IPv6 address (a common allocation to one customer or VPS,
 * so one holder cannot spread over many keys).
 */
export function ipPrefix(address) {
  let ip = String(address ?? "").trim().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (!ip.includes(":")) return "unknown";
  ip = ip.toLowerCase();
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  if (tail === null && h.length !== 8) return "unknown";
  const groups = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return "unknown";
  const n = groups.map((g) => parseInt(g, 16));
  return `${n[0].toString(16)}:${n[1].toString(16)}:${n[2].toString(16)}::/48`;
}

const passHash = (pass) => createHash("sha256").update(pass, "utf8").digest("hex");
const freeBytes = (dir) => {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
};

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/**
 * createCeremonyServer(options) -> { server, state(), close(), tick(), pollChain() }
 *   dir                 ceremony directory made by scripts/ceremony/init.mjs
 *   r1csPath, ptauPath  the files the ceremony is pinned to (checked against ceremony.json)
 *   slotSecs            time an active contributor has to start the upload (900)
 *   heartbeatSecs       a waiting pass not polled for this long is dropped (60)
 *   maxQueue            waiting places (200)
 *   joinPerHour         joins per address prefix per hour (6)
 *   maxPerPrefix        queue places (waiting plus the active slot) one address prefix may hold at once (2)
 *   trustProxy          read the client address from X-Forwarded-For (the proxy overwrites it)
 *   verify              verification function (default: child process)
 *   chain               { tipHeight() } for the automatic close before the beacon height. While its last
 *                       successful read is older than chainStaleSecs (5 polls), no slot is given out
 *                       and no upload is accepted, and /health says so: nothing is accepted that cannot
 *                       be shown to precede the beacon. Each accepted entry records the tip seen.
 *   now, log            clock (ms) and logger
 *   minFreeDiskBytes, uploadTimeoutMs, verifyTimeoutMs, maxAttempts, chainPollSecs, tickMs
 */
export function createCeremonyServer({
  dir, r1csPath = join(ROOT, DEFAULT_PATHS.r1cs), ptauPath = join(ROOT, DEFAULT_PATHS.ptau),
  slotSecs = 900, heartbeatSecs = 60, maxQueue = 200, joinPerHour = 6, maxPerPrefix = 2, trustProxy = false,
  verify = verifyInChildProcess, chain = null, now = Date.now, log = console,
  minFreeDiskBytes = 2 * GiB, uploadTimeoutMs = 600_000, verifyTimeoutMs = 600_000, maxAttempts = 3,
  chainPollSecs = 60, chainStaleSecs = null, tickMs = 1000,
} = {}) {
  const P = ceremonyPaths(dir);
  const ceremony = readJson(P.ceremony);
  let transcript = readJson(P.transcript);
  if (transcript.ceremony !== ceremony.id) throw new Error("transcript.json belongs to another ceremony");
  if (!existsSync(P.zkey(0)) || sha256Hex(readFileSync(P.zkey(0))) !== ceremony.initialZkeySha256) {
    throw new Error("zkeys/0000.zkey is missing or is not the key ceremony.json names");
  }
  for (const c of transcript.contributions) {
    if (!existsSync(P.zkey(c.index))) throw new Error(`zkeys/${zkeyName(c.index)} is missing`);
  }
  if (!existsSync(r1csPath) || !existsSync(ptauPath)) throw new Error("the r1cs or ptau file is missing");
  if (sha256Hex(readFileSync(ptauPath)) !== ceremony.ptau.sha256) throw new Error(`${ptauPath} is not the ptau this ceremony is pinned to`);
  if (sha256Hex(readFileSync(r1csPath)) !== ceremony.r1csSha256) throw new Error(`${r1csPath} is not the r1cs this ceremony is pinned to`);
  mkdirSync(P.uploads, { recursive: true });
  for (const f of readdirSync(P.uploads)) rmSync(join(P.uploads, f), { force: true }); // leftovers of a crash

  const st = Object.assign({ v: 1, phase: "open", queue: [], slot: null, done: [], expired: [], closed: null, actionsDone: [] }, readJsonOr(P.state, {}));
  if (st.slot) st.slot.uploading = false; // an upload cut by a restart is gone
  const save = () => writeJsonAtomic(P.state, st);
  // Address prefixes are kept only as an HMAC under this ceremony's own salt (never the address).
  if (!/^[0-9a-f]{64}$/.test(String(st.prefixSalt ?? ""))) st.prefixSalt = randomBytes(32).toString("hex");
  const prefixKey = (prefix) => createHmac("sha256", st.prefixSalt).update(prefix).digest("hex").slice(0, 32);
  // A crash after transcript.json was written and before state.json: the restored slot's
  // contribution is already in the transcript. Its holder is done; the slot is free.
  if (st.slot && st.slot.index <= transcript.contributions.length) {
    st.done.push({ passHash: st.slot.passHash, at: now(), index: st.slot.index });
    st.slot = null;
  }
  save();
  const joins = new Map(); // ip prefix -> [ms]
  const staleMs = (chainStaleSecs ?? 5 * chainPollSecs) * 1000;
  const chainSeen = { okAt: null, tipHeight: null, error: null }; // the last successful chain read
  const chainStale = () => Boolean(chain) && (chainSeen.okAt === null || now() - chainSeen.okAt > staleMs);
  let verifying = false;
  let lastError = null;
  const aborter = new AbortController();
  const sizes = new Map();
  const sizeOf = (i) => {
    if (!sizes.has(i)) sizes.set(i, statSync(P.zkey(i)).size);
    return sizes.get(i);
  };

  const latest = () => {
    const c = transcript.contributions.at(-1);
    const index = c ? c.index : 0;
    return {
      index,
      contributionHash: c ? c.contributionHash : null,
      zkeySha256: c ? c.zkeySha256 : ceremony.initialZkeySha256,
      bytes: sizeOf(index),
      url: `/ceremony/files/${zkeyName(index)}`,
    };
  };
  const remember = (list, h, extra = {}) => {
    list.push({ passHash: h, at: now(), ...extra });
    if (list.length > MAX_REMEMBERED) list.splice(0, list.length - MAX_REMEMBERED);
  };
  const closeBeforeHeight = ceremony.beacon.height - ceremony.beacon.closeBeforeBlocks;

  function close(tipHeight, by) {
    if (st.closed) return;
    st.closed = { at: new Date(now()).toISOString(), tipHeight: Number.isSafeInteger(tipHeight) ? tipHeight : null, by };
    st.phase = "closed";
    for (const q of st.queue) remember(st.expired, q.passHash);
    st.queue = [];
    if (st.slot && !st.slot.uploading) {
      remember(st.expired, st.slot.passHash);
      st.slot = null;
    }
    // What the operator publishes at once, somewhere independently timestamped, before block H:
    // it fixes the contribution list before anyone knows the beacon (docs/CEREMONY.md).
    const commitment = closeCommitmentOf(transcript);
    transcript = { ...transcript, closed: { at: st.closed.at, tipHeight: st.closed.tipHeight, ...commitment } };
    writeJsonAtomic(P.transcript, transcript);
    save();
    log.log?.(`ceremony closed (${by}) at tip ${st.closed.tipHeight ?? "unknown"}; publish the close commitment ${commitment.commitment} now, before the beacon block`);
  }

  /** control.json (scripts/ceremony/admin.mjs) and a finalized transcript set the phase. */
  function applyControl() {
    const onDisk = readJsonOr(P.transcript, transcript);
    if (onDisk?.final) {
      transcript = onDisk;
      if (st.phase !== "finalized") {
        st.phase = "finalized";
        save();
      }
      return;
    }
    if (st.closed) return;
    const c = readJsonOr(P.control, null);
    applyActions(c?.actions);
    const want = c?.phase === "closed" ? "closed" : c?.phase === "paused" ? "paused" : "open";
    if (want === "closed") return close(c.tipHeight, "admin");
    if (st.phase !== want) {
      st.phase = want;
      save();
      log.log?.(`ceremony ${want}`);
    }
  }

  /**
   * admin.mjs actions, each applied once: { id, kind: "drop-slot" } ends the active slot (not
   * during an upload); { id, kind: "drop-prefix", value: <address> } removes every queue place
   * of that address's prefix, and its slot.
   */
  function applyActions(actions) {
    if (!Array.isArray(actions)) return;
    let changed = false;
    for (const a of actions) {
      if (!a || typeof a.id !== "string" || st.actionsDone.includes(a.id)) continue;
      if (a.kind === "drop-slot") {
        if (st.slot?.uploading) continue; // after the upload finishes
        if (st.slot) {
          remember(st.expired, st.slot.passHash);
          log.log?.(`slot ${st.slot.index} dropped by the operator`);
          st.slot = null;
        }
      } else if (a.kind === "drop-prefix") {
        const pk = prefixKey(ipPrefix(a.value));
        const before = st.queue.length;
        st.queue = st.queue.filter((q) => {
          if (q.pk !== pk) return true;
          remember(st.expired, q.passHash);
          return false;
        });
        if (st.slot && st.slot.pk === pk && !st.slot.uploading) {
          remember(st.expired, st.slot.passHash);
          st.slot = null;
        }
        log.log?.(`dropped ${before - st.queue.length} queue places of one address prefix (operator)`);
      }
      st.actionsDone.push(a.id);
      if (st.actionsDone.length > MAX_REMEMBERED) st.actionsDone.splice(0, st.actionsDone.length - MAX_REMEMBERED);
      changed = true;
    }
    if (changed) save();
  }

  /** Drops silent waiting passes, expires the slot, gives the free slot to the head of the queue. */
  function tick() {
    applyControl();
    const t = now();
    let changed = false;
    const keep = [];
    for (const q of st.queue) {
      if (t - q.lastSeen > heartbeatSecs * 1000) {
        remember(st.expired, q.passHash);
        changed = true;
      } else keep.push(q);
    }
    st.queue = keep;
    if (st.slot && !st.slot.uploading && t > st.slot.deadline) {
      remember(st.expired, st.slot.passHash);
      log.log?.(`slot ${st.slot.index} expired`);
      st.slot = null;
      changed = true;
    }
    // A slot whose holder never polled /turn after getting it (gone, or a pass that only held a
    // place) ends after one heartbeat instead of the whole slot time.
    if (st.slot && !st.slot.uploading && st.slot.acked === false && t - st.slot.startedAt > heartbeatSecs * 1000) {
      remember(st.expired, st.slot.passHash);
      log.log?.(`slot ${st.slot.index} not taken up within ${heartbeatSecs} s`);
      st.slot = null;
      changed = true;
    }
    if (!st.slot && st.phase === "open" && st.queue.length && !chainStale()) {
      const q = st.queue.shift();
      st.slot = { passHash: q.passHash, name: q.name, pk: q.pk ?? null, index: transcript.contributions.length + 1, startedAt: t, deadline: t + slotSecs * 1000, attempts: 0, uploading: false, acked: false };
      log.log?.(`slot ${st.slot.index} started`);
      changed = true;
    }
    if (changed) save();
  }

  async function pollChain() {
    if (!chain || st.closed || st.phase === "finalized") return;
    try {
      const tip = Number(await chain.tipHeight());
      if (!Number.isSafeInteger(tip) || tip < 0) throw new Error(`not a block height: ${tip}`);
      chainSeen.okAt = now();
      chainSeen.tipHeight = tip;
      chainSeen.error = null;
      if (tip >= closeBeforeHeight) close(tip, "chain");
    } catch (e) {
      chainSeen.error = String(e?.message ?? e).slice(0, 200);
      log.warn?.(`chain tip unavailable: ${chainSeen.error}${chainStale() ? " (stale: no slots, no uploads until it answers)" : ""}`);
    }
  }

  const clientAddress = (req) => {
    if (trustProxy) {
      const xff = req.headers["x-forwarded-for"];
      if (typeof xff === "string" && xff.trim()) return xff.split(",").at(-1).trim();
    }
    return req.socket.remoteAddress;
  };

  const authPass = (req) => {
    const m = PASS_RE.exec(String(req.headers.authorization ?? ""));
    if (!m) throw new HttpError(401, "unauthorized");
    return passHash(m[1]);
  };

  const turnOf = (h) => {
    if (st.slot?.passHash === h) {
      const base = latest();
      return {
        state: "active",
        index: st.slot.index,
        base: { index: base.index, zkeySha256: base.zkeySha256, bytes: base.bytes, url: base.url },
        deadline: new Date(st.slot.deadline).toISOString(),
        secondsLeft: Math.max(0, Math.floor((st.slot.deadline - now()) / 1000)),
        maxUploadBytes: base.bytes + UPLOAD_SLACK,
        uploading: !!st.slot.uploading,
      };
    }
    const at = st.queue.findIndex((q) => q.passHash === h);
    if (at >= 0) return { state: "waiting", position: at + (st.slot ? 1 : 0), heartbeatSecs };
    const d = st.done.find((x) => x.passHash === h);
    if (d) return { state: "done", index: d.index };
    if (st.expired.some((x) => x.passHash === h)) return { state: "expired" };
    return { state: "unknown" };
  };

  function status() {
    return {
      id: ceremony.id,
      phase: st.phase,
      pinned: ceremony.pinned,
      circuit: { r1csSha256: ceremony.r1csSha256, constraints: ceremony.constraints },
      ptau: ceremony.ptau,
      initial: { zkeySha256: ceremony.initialZkeySha256 },
      contributions: transcript.contributions.length,
      latest: latest(),
      waiting: st.queue.length,
      slot: { active: !!st.slot, deadline: st.slot ? new Date(st.slot.deadline).toISOString() : null },
      beacon: { network: ceremony.beacon.network, height: ceremony.beacon.height, closeBeforeHeight },
      closed: st.closed ? { at: st.closed.at, tipHeight: st.closed.tipHeight } : null,
      heartbeatSecs,
      slotSecs,
    };
  }

  function chainHealth() {
    if (!chain) return { configured: false, stale: false, tipHeight: null, lastOkAt: null };
    return { configured: true, stale: chainStale(), tipHeight: chainSeen.tipHeight, lastOkAt: chainSeen.okAt === null ? null : new Date(chainSeen.okAt).toISOString(), error: chainSeen.error };
  }

  function health() {
    const free = freeBytes(P.dir);
    const ch = chainHealth();
    const open = st.phase === "open" || st.phase === "paused";
    return {
      ok: (free === null || free >= minFreeDiskBytes) && !(open && ch.stale),
      phase: st.phase,
      contributions: transcript.contributions.length,
      waiting: st.queue.length,
      slotActive: !!st.slot,
      verifying,
      freeDiskBytes: free,
      lastError,
      chain: ch,
    };
  }

  /* --------------------------------------------------------------- handlers */

  async function readJsonBody(req) {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > MAX_JSON_BODY) throw new HttpError(413, "too_large");
    }
    try {
      return body ? JSON.parse(body) : {};
    } catch {
      throw new HttpError(400, "bad_json");
    }
  }

  async function joinQueue(req) {
    const body = await readJsonBody(req);
    if (st.phase === "closed" || st.phase === "finalized") throw new HttpError(503, "closed");
    if (st.phase === "paused") throw new HttpError(503, "paused");
    const name = cleanName(body?.name);
    if (!name) throw new HttpError(400, "bad_name");
    const taken = transcript.contributions.some((c) => c.name === name) || st.queue.some((q) => q.name === name) || st.slot?.name === name;
    if (taken) throw new HttpError(409, "name_taken");
    const free = freeBytes(P.dir);
    if (free !== null && free < minFreeDiskBytes) throw new HttpError(503, "low_disk");
    const key = ipPrefix(clientAddress(req));
    const t = now();
    const recent = (joins.get(key) ?? []).filter((x) => t - x < 3600_000);
    if (recent.length >= joinPerHour) {
      joins.set(key, recent);
      throw new HttpError(429, "rate_limited");
    }
    const pk = prefixKey(key);
    const held = st.queue.filter((q) => q.pk === pk).length + (st.slot?.pk === pk ? 1 : 0);
    if (held >= maxPerPrefix) throw new HttpError(429, "prefix_busy", { maxPerPrefix });
    if (st.queue.length >= maxQueue) throw new HttpError(503, "queue_full");
    recent.push(t);
    joins.set(key, recent);
    const pass = randomBytes(32).toString("hex");
    const h = passHash(pass);
    st.queue.push({ passHash: h, name, joinedAt: t, lastSeen: t, pk });
    save();
    tick();
    const turn = turnOf(h);
    return [201, { pass, position: turn.state === "active" ? 0 : turn.position, heartbeatSecs }];
  }

  function turn(req) {
    const h = authPass(req);
    const q = st.queue.find((x) => x.passHash === h);
    if (q) q.lastSeen = now(); // every poll is the heartbeat
    tick();
    if (st.slot?.passHash === h && st.slot.acked === false) {
      st.slot.acked = true; // the holder knows it is its turn
      save();
    }
    return [200, turnOf(h)];
  }

  function leave(req) {
    const h = authPass(req);
    const at = st.queue.findIndex((x) => x.passHash === h);
    if (at >= 0) st.queue.splice(at, 1);
    else if (st.slot?.passHash === h) {
      if (st.slot.uploading) throw new HttpError(409, "upload_in_progress");
      st.slot = null;
    } else return [200, { ok: true, state: turnOf(h).state }];
    remember(st.expired, h);
    save();
    tick();
    return [200, { ok: true }];
  }

  async function upload(req) {
    const h = authPass(req);
    tick();
    if (st.phase === "closed" || st.phase === "finalized") throw new HttpError(503, "closed");
    if (st.slot?.passHash !== h) {
      throw new HttpError(409, st.expired.some((x) => x.passHash === h) ? "slot_expired" : "not_your_turn");
    }
    const slot = st.slot;
    if (slot.uploading) throw new HttpError(409, "upload_in_progress");
    // Without a fresh chain tip nothing is accepted: it could not be shown to precede the beacon.
    if (chainStale()) throw new HttpError(503, "chain_unavailable");
    if (String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/octet-stream") {
      throw new HttpError(415, "bad_content_type");
    }
    const lenHeader = req.headers["content-length"];
    if (lenHeader === undefined || !/^\d+$/.test(String(lenHeader))) throw new HttpError(411, "length_required");
    const declared = Number(lenHeader);
    const base = latest();
    const maxBytes = base.bytes + UPLOAD_SLACK;
    if (declared > maxBytes) throw new HttpError(413, "too_large", { maxUploadBytes: maxBytes });
    if (declared < 64) throw new HttpError(400, "too_small");

    slot.uploading = true;
    const tmp = join(P.uploads, `${slot.index}-${randomBytes(6).toString("hex")}.part`);
    let received = 0;
    try {
      await new Promise((done, fail) => {
        const out = createWriteStream(tmp, { mode: 0o644 });
        const timer = setTimeout(() => {
          req.destroy();
          fail(new HttpError(408, "upload_timeout"));
        }, uploadTimeoutMs);
        const stop = (e) => {
          clearTimeout(timer);
          out.destroy();
          fail(e);
        };
        req.on("data", (chunk) => {
          received += chunk.length;
          if (received > declared) {
            req.destroy();
            stop(new HttpError(413, "too_large", { maxUploadBytes: maxBytes }));
            return;
          }
          if (!out.write(chunk)) {
            req.pause();
            out.once("drain", () => req.resume());
          }
        });
        req.on("aborted", () => stop(new HttpError(400, "upload_aborted")));
        req.on("error", (e) => stop(e instanceof HttpError ? e : new HttpError(400, "upload_aborted")));
        req.on("end", () => {
          clearTimeout(timer);
          out.end(() => (received === declared ? done() : fail(new HttpError(400, "incomplete_upload"))));
        });
        out.on("error", (e) => stop(e));
      });
    } catch (e) {
      rmSync(tmp, { force: true });
      slot.uploading = false;
      tick();
      throw e;
    }

    verifying = true;
    let result;
    try {
      result = await verify({ init: P.zkey(0), ptau: ptauPath, zkey: tmp, timeoutMs: verifyTimeoutMs, signal: aborter.signal });
    } finally {
      verifying = false;
    }
    const reason = (() => {
      if (!result?.ok) return result?.reason ?? "verification failed";
      const list = result.contributions ?? [];
      const have = transcript.contributions;
      if (list.length !== have.length + 1) {
        return list.length <= have.length
          ? `the upload has ${list.length} contributions; the latest key already has ${have.length}: contribute on ${base.url}`
          : `the upload adds ${list.length - have.length} contributions; exactly one is allowed`;
      }
      for (let i = 0; i < have.length; i++) {
        if (list[i].contributionHash !== have[i].contributionHash) return `contribution ${i + 1} differs from the transcript: contribute on ${base.url}`;
      }
      if (list.some((c) => c.type !== 0)) return "the upload contains a beacon contribution";
      const mine = list.at(-1);
      if (mine.name !== slot.name) return `the contribution is named ${JSON.stringify(mine.name ?? "")}, not ${JSON.stringify(slot.name)} as joined`;
      return null;
    })();
    if (result?.internal) lastError = { at: new Date(now()).toISOString(), message: result.reason };

    if (reason || st.phase === "closed" || st.phase === "finalized" || st.slot !== slot) {
      rmSync(tmp, { force: true });
      slot.uploading = false;
      if (result?.aborted) throw new HttpError(503, "shutting_down");
      if (!reason) {
        // Closed while this upload was verified: nothing is accepted after the close.
        if (st.slot === slot) {
          remember(st.expired, slot.passHash);
          st.slot = null;
          save();
        }
        throw new HttpError(503, "closed");
      }
      slot.attempts++;
      if (st.slot === slot && (slot.attempts >= maxAttempts || now() > slot.deadline)) {
        remember(st.expired, slot.passHash);
        st.slot = null;
      }
      save();
      tick();
      log.log?.(`slot ${slot.index}: upload rejected: ${reason}`);
      throw new HttpError(422, "rejected", { reason, attemptsLeft: st.slot === slot ? maxAttempts - slot.attempts : 0 });
    }

    const index = transcript.contributions.length + 1;
    if (slot.index !== index) {
      // Never reuse an index the transcript already holds (a crash between its write and state.json).
      rmSync(tmp, { force: true });
      remember(st.expired, slot.passHash);
      if (st.slot === slot) st.slot = null;
      save();
      tick();
      throw new HttpError(409, "slot_expired");
    }
    if (chainStale()) {
      rmSync(tmp, { force: true });
      slot.uploading = false;
      throw new HttpError(503, "chain_unavailable");
    }
    const bytes = readFileSync(tmp);
    const zkeySha256 = sha256Hex(bytes);
    renameSync(tmp, P.zkey(index));
    sizes.set(index, bytes.length);
    const mine = result.contributions.at(-1);
    const entry = {
      index,
      name: slot.name,
      contributionHash: mine.contributionHash,
      zkeySha256,
      prevZkeySha256: base.zkeySha256,
      bytes: bytes.length,
      acceptedAt: new Date(now()).toISOString(),
      // The chain tip the coordinator last read (null without a chain source): finalize can tell
      // which contributions were accepted below the close height even if the close came late.
      tipHeight: chain ? chainSeen.tipHeight : null,
    };
    transcript = { ...transcript, contributions: [...transcript.contributions, entry] };
    writeJsonAtomic(P.transcript, transcript);
    remember(st.done, slot.passHash, { index });
    st.slot = null;
    save();
    tick();
    log.log?.(`accepted contribution ${index} (${entry.contributionHash.slice(0, 16)}...)`);
    return [200, {
      ceremony: ceremony.id,
      index,
      name: entry.name,
      contributionHash: entry.contributionHash,
      zkeySha256,
      prevZkeySha256: entry.prevZkeySha256,
      acceptedAt: entry.acceptedAt,
      verifiedWith: VERIFIED_WITH,
    }];
  }

  function serveFile(req, res, name) {
    const m = /^(\d{4})\.zkey$/.exec(name);
    const index = m ? Number(m[1]) : -1;
    if (index < 0 || index > transcript.contributions.length) throw new HttpError(404, "not_found");
    const path = P.zkey(index);
    const size = statSync(path).size;
    res.writeHead(200, {
      ...BASE_HEADERS,
      "content-type": "application/octet-stream",
      "content-length": size,
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": `attachment; filename="${ceremony.id}-${name}"`,
    });
    if (req.method === "HEAD") return res.end();
    createReadStream(path).pipe(res);
  }

  const routes = {
    [`GET ${API}/health`]: () => [200, health()],
    [`GET ${API}/status`]: () => [200, status()],
    [`GET ${API}/transcript.json`]: () => [200, readJsonOr(P.transcript, transcript)],
    "GET /ceremony/transcript.json": () => [200, readJsonOr(P.transcript, transcript)],
    [`POST ${API}/join`]: joinQueue,
    [`GET ${API}/turn`]: turn,
    [`POST ${API}/contribution`]: upload,
    [`POST ${API}/leave`]: leave,
  };

  const server = createServer(async (req, res) => {
    const send = (status, body, extra = {}) => {
      if (res.headersSent) return res.destroy();
      const text = JSON.stringify(body);
      res.writeHead(status, { ...BASE_HEADERS, "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra });
      res.end(text);
    };
    try {
      const url = new URL(req.url, "http://coordinator.invalid");
      const path = url.pathname.replace(/\/+$/, "") || "/";
      if (req.method === "GET" || req.method === "HEAD" || req.method === "POST") applyControl();
      if ((req.method === "GET" || req.method === "HEAD") && path.startsWith("/ceremony/files/")) {
        return serveFile(req, res, path.slice("/ceremony/files/".length));
      }
      const handler = routes[`${req.method} ${path}`];
      if (!handler) {
        const known = Object.keys(routes).some((k) => k.endsWith(` ${path}`));
        throw new HttpError(known ? 405 : 404, known ? "method_not_allowed" : "not_found");
      }
      const [status, body] = await handler(req);
      send(status, body);
    } catch (e) {
      if (e instanceof HttpError) {
        // An upload refused before its body was read: answer, then close the connection.
        const closeIt = req.method === "POST" && !req.readableEnded;
        send(e.status, { error: e.code, ...e.extra }, closeIt ? { connection: "close" } : {});
        if (closeIt) req.resume();
        return;
      }
      lastError = { at: new Date(now()).toISOString(), message: String(e?.message ?? e).slice(0, 300) };
      log.error?.(`internal error: ${lastError.message}`);
      send(500, { error: "internal" });
    }
  });
  server.requestTimeout = uploadTimeoutMs + 60_000;
  server.headersTimeout = 30_000;
  // Longer than the proxy keeps an idle upstream connection (deploy/caddy: 60 s).
  server.keepAliveTimeout = 65_000;

  const timer = setInterval(() => {
    try {
      tick();
    } catch (e) {
      log.error?.(`tick: ${e?.message ?? e}`);
    }
  }, tickMs);
  timer.unref?.();
  let chainTimer = null;
  if (chain) {
    pollChain();
    chainTimer = setInterval(pollChain, chainPollSecs * 1000);
    chainTimer.unref?.();
  }
  tick();

  return {
    server,
    state: () => JSON.parse(JSON.stringify({ ...st, transcript, chain: chainHealth() })),
    tick,
    pollChain,
    close: () =>
      new Promise((done) => {
        clearInterval(timer);
        if (chainTimer) clearInterval(chainTimer);
        aborter.abort();
        server.close(() => done());
        server.closeAllConnections?.();
      }),
  };
}

const BASE_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cross-origin-resource-policy": "same-origin",
  "x-frame-options": "DENY",
};

/* ------------------------------------------------------------------ main */

function envInt(env, name, fallback) {
  const v = env[name];
  if (v === undefined || v === "") return fallback;
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a whole number`);
  return Number(v);
}

/** The ceremony directory: MURKLE_CEREMONY_DIR, else data/ceremony/<MURKLE_CEREMONY_ID>, else the only one there. */
export function ceremonyDirFromEnv(env = process.env) {
  if (env.MURKLE_CEREMONY_DIR) return resolve(env.MURKLE_CEREMONY_DIR);
  const base = join(ROOT, "data", "ceremony");
  if (env.MURKLE_CEREMONY_ID) return join(base, env.MURKLE_CEREMONY_ID);
  const found = existsSync(base) ? readdirSync(base).filter((d) => existsSync(join(base, d, "ceremony.json"))) : [];
  if (found.length === 1) return join(base, found[0]);
  throw new Error("set MURKLE_CEREMONY_DIR (the directory scripts/ceremony/init.mjs created)");
}

export async function main(env = process.env) {
  const dir = ceremonyDirFromEnv(env);
  const ceremony = readJson(join(dir, "ceremony.json"));
  let chain = null;
  if (env.MURKLE_CEREMONY_CHAIN !== "off") {
    const kind = env.MURKLE_BTC_SOURCE === "bitcoind" ? "bitcoind" : "esplora";
    chain = await openBeaconSource({ kind, network: ceremony.beacon.network, env });
    console.log(`automatic close at height ${ceremony.beacon.height - ceremony.beacon.closeBeforeBlocks} from ${chain.describe}`);
  } else {
    console.warn("MURKLE_CEREMONY_CHAIN=off: close the queue by hand (scripts/ceremony/admin.mjs close) before the beacon height");
  }
  const app = createCeremonyServer({
    dir,
    r1csPath: resolve(env.MURKLE_CEREMONY_R1CS ?? join(ROOT, DEFAULT_PATHS.r1cs)),
    ptauPath: resolve(env.MURKLE_CEREMONY_PTAU ?? join(ROOT, DEFAULT_PATHS.ptau)),
    slotSecs: envInt(env, "MURKLE_CEREMONY_SLOT_SECS", 900),
    heartbeatSecs: envInt(env, "MURKLE_CEREMONY_HEARTBEAT_SECS", 60),
    maxQueue: envInt(env, "MURKLE_CEREMONY_MAX_QUEUE", 200),
    joinPerHour: envInt(env, "MURKLE_CEREMONY_JOIN_PER_HOUR", 6),
    maxPerPrefix: envInt(env, "MURKLE_CEREMONY_MAX_PER_PREFIX", 2),
    verifyTimeoutMs: envInt(env, "MURKLE_CEREMONY_VERIFY_SECS", 600) * 1000,
    trustProxy: env.MURKLE_CEREMONY_TRUST_PROXY === "1",
    chain,
  });
  const host = env.MURKLE_CEREMONY_HOST ?? "127.0.0.1";
  const port = envInt(env, "MURKLE_CEREMONY_PORT", 8790);
  await new Promise((ok, fail) => {
    app.server.once("error", fail);
    app.server.listen(port, host, ok);
  });
  console.log(`ceremony ${ceremony.id} coordinator on http://${host}:${port}${API}/status (state ${dir})`);
  const stop = () => app.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`ceremony coordinator: ${e?.message ?? e}`);
    process.exit(1);
  });
}

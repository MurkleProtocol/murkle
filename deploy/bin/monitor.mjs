#!/usr/bin/env node
// A simple monitor for a Murkle node: indexer lag and sync age, sync and header errors, the
// relayer's books check (I2: a halted relayer), the pinned artifacts, the ceremony coordinator,
// free disk and the age of the newest encrypted backup. Run it every minute (deploy/systemd/murkle-monitor.timer). docs/OPERATIONS.md
// says what to do for each alert.
//
// Usage: node deploy/bin/monitor.mjs [--url U] [--ceremony-url U] [--data-dir D] [--max-lag N]
//                                    [--min-free-gb G] [--webhook URL] [--state <file>] [--timeout-ms MS]
//                                    [--backup-dir D] [--max-backup-age-hours H]
// Defaults: MURKLE_MONITOR_URL (http://127.0.0.1:8787), MURKLE_MONITOR_CEREMONY_URL (none),
// MURKLE_MONITOR_DATA_DIR (/var/lib/murkle), MURKLE_MONITOR_MAX_LAG (3), MURKLE_MONITOR_MIN_FREE_GB (20),
// MURKLE_MONITOR_WEBHOOK (none), MURKLE_MONITOR_BACKUP_DIR (MURKLE_BACKUP_DIR, else none: no backup check),
// MURKLE_MONITOR_MAX_BACKUP_AGE_HOURS (3). A missing or old backup is critical while the relayer runs.
//
// It reads GET /api/health?strict=1 (the body is read on 200 and on 503) and falls back to
// /api/state plus /api/relay/info on an indexer without that endpoint. It prints one JSON line:
//   { time, level: "ok" | "warning" | "critical", alerts: [{ level, code, message }], indexer, disk, ceremony? }
// and exits 0 (ok), 1 (warning) or 2 (critical). With a webhook it POSTs that same line, and
// nothing else, when the level is not ok; with --state it posts only when the level or the set
// of alerts changed since the last run (including the return to ok). The webhook URL is never printed.
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULTS = Object.freeze({
  url: "http://127.0.0.1:8787",
  ceremonyUrl: null,
  dataDir: "/var/lib/murkle",
  maxLag: 3,
  minFreeGb: 20,
  webhook: null,
  state: null,
  timeoutMs: 10_000,
  backupDir: null,
  maxBackupAgeHours: 3,
});
export const MAX_SYNC_AGE_SECS = 600;
// Header errors a later tick may clear on its own (Core's 2-hour future limit, a source failure).
const RETRYABLE_HEADER = new Set(["time-too-new", "source"]);
const RANK = { ok: 0, warning: 1, critical: 2 };
const GB = 1024 ** 3;

const alert = (level, code, message) => ({ level, code, message });
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The indexer part of a check, from /api/health or (fallback) /api/state and /api/relay/info.
 * -> { alerts, summary }
 */
export function evaluateIndexer({ health = null, state = null, relayInfo = null, now = Date.now(), maxLag = DEFAULTS.maxLag }) {
  const alerts = [];
  let summary;
  if (health) {
    const lag = num(health.lagBlocks);
    const age = num(health.syncAgeSecs);
    summary = {
      via: "health", network: health.network ?? null, height: num(health.height), chainTip: num(health.chainTip), lagBlocks: lag,
      syncAgeSecs: age, source: health.source ?? null, headersTip: num(health.headers?.tipHeight), preGenesis: health.preGenesis ?? null,
    };
    if (lag !== null && lag > maxLag) alerts.push(alert("warning", "lag", `the indexer is ${lag} blocks behind the chain tip (limit ${maxLag})`));
    if (age === null) alerts.push(alert("warning", "never_synced", "the indexer has not finished a sync since it started"));
    else if (age > MAX_SYNC_AGE_SECS) alerts.push(alert("critical", "stale", `no sync for ${Math.floor(age / 60)} minutes`));
    const hErr = health.headers?.lastError ?? null;
    if (hErr) {
      const code = String(hErr.code ?? "");
      if (code === "less-work") alerts.push(alert("critical", "less_work", `the data source served a chain with less work${hErr.height != null ? ` at ${hErr.height}` : ""}; the indexer kept its chain (switch to your own node)`));
      else alerts.push(alert(RETRYABLE_HEADER.has(code) ? "warning" : "critical", "header_error", `header check failed (${code || "error"}${hErr.height != null ? ` at ${hErr.height}` : ""}): ${hErr.message ?? ""}`.trim()));
    }
    // The sync error usually repeats the header error when there is one: report it once.
    const lastError = health.lastError ? String(health.lastError) : null;
    const lessWork = lastError !== null && /less-work|less work/i.test(lastError);
    const sameAsHeader = hErr && lastError !== null && (lessWork || (hErr.message && lastError.includes(String(hErr.message))));
    if (lastError && !sameAsHeader) {
      alerts.push(lessWork ? alert("critical", "less_work", `sync error: ${lastError}`) : alert("warning", "sync_error", `sync error: ${lastError}`));
    }
    if (health.headers && health.headers.verified === false) alerts.push(alert("warning", "headers_off", "header verification is off"));
    // An operator's evacuation, pause or unfunded rotation (docs/OPERATIONS.md 10.4) halts it too, with its own code.
    const held = ["relayer_evacuating", "pool_unfunded", "maintenance"].includes(health.relayer?.code);
    if (health.relayer?.halted) {
      alerts.push(alert("critical", "relayer_halted", held
        ? `the relayer is held by its operator (${health.relayer.code}): no sends or top-ups until it resumes`
        : `the relayer halted itself (books check I2)${health.relayer.problems?.length ? `: ${health.relayer.problems.join("; ")}` : ""}`));
    }
    if (health.artifacts && health.artifacts.ok === false) alerts.push(alert("critical", "artifacts", "the artifacts on disk do not match the pins"));
    if (health.ok === false && !alerts.length) alerts.push(alert("warning", "health_not_ok", "/api/health reports ok: false"));
  } else if (state) {
    const height = num(state.height);
    const tip = num(state.chainTip);
    const lag = height !== null && tip !== null ? Math.max(0, tip - height) : null;
    const age = num(state.lastSync) !== null ? Math.max(0, Math.round((now - state.lastSync) / 1000)) : null;
    summary = { via: "state", network: state.network ?? null, height, chainTip: tip, lagBlocks: lag, syncAgeSecs: age, source: null, headersTip: null, preGenesis: state.preGenesis ?? null };
    if (lag !== null && lag > maxLag) alerts.push(alert("warning", "lag", `the indexer is ${lag} blocks behind the chain tip (limit ${maxLag})`));
    if (age === null) alerts.push(alert("warning", "never_synced", "the indexer has not finished a sync since it started"));
    else if (age > MAX_SYNC_AGE_SECS) alerts.push(alert("critical", "stale", `no sync for ${Math.floor(age / 60)} minutes`));
    if (state.lastError) {
      const lessWork = /less-work|less work/i.test(String(state.lastError));
      alerts.push(lessWork ? alert("critical", "less_work", `sync error: ${state.lastError}`) : alert("warning", "sync_error", `sync error: ${state.lastError}`));
    }
    if (state.artifacts && state.artifacts.ok === false) alerts.push(alert("critical", "artifacts", "the artifacts on disk do not match the pins"));
    if (relayInfo?.code === "halted") alerts.push(alert("critical", "relayer_halted", "the relayer halted itself (books check I2)"));
  } else {
    summary = { via: null };
  }
  return { alerts, summary };
}

/** Free space of the data disk -> { alerts, summary }. `stat` is fs.statfsSync's result or an Error. */
export function evaluateDisk({ path, stat, minFreeGb = DEFAULTS.minFreeGb }) {
  if (!stat || stat instanceof Error) {
    return { alerts: [alert("warning", "disk_unknown", `cannot read free space of ${path}${stat instanceof Error ? ` (${stat.code ?? stat.message})` : ""}`)], summary: { path, freeGb: null } };
  }
  const free = Number(stat.bavail) * Number(stat.bsize);
  const freeGb = Math.round((free / GB) * 10) / 10;
  const alerts = [];
  if (free < (minFreeGb * GB) / 4) alerts.push(alert("critical", "disk_low", `${freeGb} GB free on ${path} (limit ${minFreeGb} GB)`));
  else if (free < minFreeGb * GB) alerts.push(alert("warning", "disk_low", `${freeGb} GB free on ${path} (limit ${minFreeGb} GB)`));
  return { alerts, summary: { path, freeGb } };
}

/**
 * The newest backup in the backup directory -> { alerts, summary }. `files` is [{ name, mtimeMs }]
 * (or an Error when the directory cannot be read); `relayerOn`: the indexer reports a relayer,
 * whose keys and books hold users' deposits, so a missing or old backup is critical then.
 */
export function evaluateBackups({ dir, files, now = Date.now(), maxAgeHours = DEFAULTS.maxBackupAgeHours, relayerOn = false }) {
  const level = relayerOn ? "critical" : "warning";
  if (!files || files instanceof Error) {
    return { alerts: [alert(level, "backup_unknown", `cannot read the backup directory ${dir}${files instanceof Error ? ` (${files.code ?? files.message})` : ""}`)], summary: { dir, newestAgeHours: null } };
  }
  const mine = files.filter((x) => /^murkle-backup-(signet|mainnet)-.+\.mbk$/.test(x.name));
  if (!mine.length) return { alerts: [alert(level, "no_backup", `no backup in ${dir}`)], summary: { dir, newestAgeHours: null } };
  const newest = Math.max(...mine.map((x) => x.mtimeMs));
  const ageHours = Math.round(((now - newest) / 3_600_000) * 10) / 10;
  const alerts = ageHours > maxAgeHours ? [alert(level, "backup_old", `the newest backup in ${dir} is ${ageHours} hours old (limit ${maxAgeHours})`)] : [];
  return { alerts, summary: { dir, newestAgeHours: ageHours, count: mine.length } };
}

/** The ceremony coordinator's health -> { alerts, summary }. */
export function evaluateCeremony({ health, error = null }) {
  if (error || !health) return { alerts: [alert("warning", "ceremony_down", `the ceremony coordinator did not answer${error ? ` (${error})` : ""}`)], summary: { reachable: false } };
  const alerts = [];
  const open = health.phase === "open" || health.phase === "paused";
  if (open && health.chain?.stale) alerts.push(alert("critical", "ceremony_chain_stale", `the ceremony coordinator has no fresh chain tip${health.chain.lastOkAt ? ` since ${health.chain.lastOkAt}` : ""}: no slots or uploads until it answers, and the close before the beacon height is at risk`));
  else if (health.ok === false) alerts.push(alert("warning", "ceremony_not_ok", `the ceremony coordinator reports ok: false (phase ${health.phase ?? "unknown"})`));
  return { alerts, summary: { reachable: true, phase: health.phase ?? null, contributions: health.contributions ?? null, waiting: health.waiting ?? null } };
}

export const levelOf = (alerts) => alerts.reduce((l, a) => (RANK[a.level] > RANK[l] ? a.level : l), "ok");
export const exitCodeOf = (level) => RANK[level] ?? 2;

async function getJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const base = (u) => String(u).replace(/\/+$/, "");
const why = (e) => (e?.name === "TimeoutError" ? "timeout" : e?.cause?.code ?? e?.code ?? e?.message ?? String(e));

/** Fetches what the indexer exposes -> { health, state, relayInfo, error }. */
export async function readIndexer(url, timeoutMs = DEFAULTS.timeoutMs) {
  try {
    const h = await getJson(`${base(url)}/api/health?strict=1`, timeoutMs);
    if ((h.status === 200 || h.status === 503) && h.body && typeof h.body === "object" && "ok" in h.body) return { health: h.body };
    if (h.status !== 404) return { error: `/api/health answered HTTP ${h.status}` };
    const s = await getJson(`${base(url)}/api/state`, timeoutMs);
    if (s.status !== 200 || !s.body) return { error: `/api/state answered HTTP ${s.status}` };
    const r = await getJson(`${base(url)}/api/relay/info`, timeoutMs).catch(() => ({ status: 0, body: null }));
    return { state: s.body, relayInfo: r.status === 200 ? r.body : null };
  } catch (e) {
    return { error: why(e) };
  }
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeState(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
}

/** Whether to post this result, given the last one recorded in the state file (or none). */
export function shouldPost(result, last, { stateful }) {
  if (!stateful) return result.level !== "ok";
  const key = (r) => `${r?.level ?? "ok"}|${(r?.codes ?? []).join(",")}`;
  const now = { level: result.level, codes: result.alerts.map((a) => a.code).sort() };
  return key(now) !== key(last ?? { level: "ok", codes: [] });
}

/** One check -> { line, level, code, posted }. */
export async function runMonitor(opts = {}, { now = Date.now, statfs = statfsSync, listBackups = listBackupFiles, post = null, error = (s) => console.error(s) } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const alerts = [];
  const out = { time: new Date(now()).toISOString() };

  const idx = await readIndexer(o.url, o.timeoutMs);
  if (idx.error) {
    alerts.push(alert("critical", "indexer_down", `the indexer at ${base(o.url)} did not answer (${idx.error})`));
    out.indexer = { via: null };
  } else {
    const r = evaluateIndexer({ ...idx, now: now(), maxLag: o.maxLag });
    alerts.push(...r.alerts);
    out.indexer = r.summary;
  }

  let stat;
  try {
    stat = statfs(o.dataDir);
  } catch (e) {
    stat = e;
  }
  const disk = evaluateDisk({ path: o.dataDir, stat, minFreeGb: o.minFreeGb });
  alerts.push(...disk.alerts);
  out.disk = disk.summary;

  if (o.backupDir) {
    let files;
    try {
      files = listBackups(o.backupDir);
    } catch (e) {
      files = e;
    }
    const relayerOn = Boolean(idx.health?.relayer?.enabled ?? idx.relayInfo?.enabled);
    const b = evaluateBackups({ dir: o.backupDir, files, now: now(), maxAgeHours: o.maxBackupAgeHours, relayerOn });
    alerts.push(...b.alerts);
    out.backups = b.summary;
  }

  if (o.ceremonyUrl) {
    let c;
    try {
      const r = await getJson(`${base(o.ceremonyUrl)}/ceremony/api/health`, o.timeoutMs);
      c = r.status === 200 && r.body ? evaluateCeremony({ health: r.body }) : evaluateCeremony({ health: null, error: `HTTP ${r.status}` });
    } catch (e) {
      c = evaluateCeremony({ health: null, error: why(e) });
    }
    alerts.push(...c.alerts);
    out.ceremony = c.summary;
  }

  const level = levelOf(alerts);
  const result = { time: out.time, level, alerts, indexer: out.indexer, disk: out.disk, ...(out.backups ? { backups: out.backups } : {}), ...(out.ceremony ? { ceremony: out.ceremony } : {}) };
  const line = JSON.stringify(result);

  // A post that is due and fails leaves the state file as it was, so the next run tries again.
  let due = false;
  let posted = false;
  if (o.webhook) {
    due = shouldPost(result, o.state ? readState(o.state) : null, { stateful: Boolean(o.state) });
    if (due) {
      const send = post ?? ((url, body) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(o.timeoutMs) }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      }));
      try {
        await send(o.webhook, line);
        posted = true;
      } catch (e) {
        error(`monitor: the webhook did not take the alert (${why(e)})`);
      }
    }
  }
  if (o.state && (!due || posted)) {
    try {
      writeState(o.state, { level, codes: alerts.map((a) => a.code).sort(), time: out.time });
    } catch (e) {
      error(`monitor: cannot write ${o.state} (${why(e)})`);
    }
  }
  return { line, level, code: exitCodeOf(level), posted, result };
}

/** Backup file names and times in `dir` (throws when it cannot be read). */
export function listBackupFiles(dir) {
  return readdirSync(dir).map((name) => ({ name, mtimeMs: statSync(join(dir, name)).mtimeMs }));
}

const NAMES = { "--url": "url", "--ceremony-url": "ceremonyUrl", "--data-dir": "dataDir", "--max-lag": "maxLag", "--min-free-gb": "minFreeGb", "--webhook": "webhook", "--state": "state", "--timeout-ms": "timeoutMs", "--backup-dir": "backupDir", "--max-backup-age-hours": "maxBackupAgeHours" };
const NUMERIC = new Set(["maxLag", "minFreeGb", "timeoutMs", "maxBackupAgeHours"]);
const ENV = { url: "MURKLE_MONITOR_URL", ceremonyUrl: "MURKLE_MONITOR_CEREMONY_URL", dataDir: "MURKLE_MONITOR_DATA_DIR", maxLag: "MURKLE_MONITOR_MAX_LAG", minFreeGb: "MURKLE_MONITOR_MIN_FREE_GB", webhook: "MURKLE_MONITOR_WEBHOOK", backupDir: "MURKLE_MONITOR_BACKUP_DIR", maxBackupAgeHours: "MURKLE_MONITOR_MAX_BACKUP_AGE_HOURS" };

/** argv and env -> options; throws a usage message. */
export function parseOptions(argv, env = process.env) {
  const o = {};
  for (const [k, name] of Object.entries(ENV)) if (env[name] !== undefined && env[name] !== "") o[k] = env[name];
  // The backup service's own setting, from the same env file, when the monitor has none.
  if (o.backupDir === undefined && env.MURKLE_BACKUP_DIR) o.backupDir = env.MURKLE_BACKUP_DIR;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const k = NAMES[flag];
    if (!k) throw new Error(`unknown argument ${a}`);
    const v = inline ?? argv[++i];
    if (v === undefined) throw new Error(`${flag} needs a value`);
    o[k] = v;
  }
  for (const k of NUMERIC) {
    if (o[k] === undefined) continue;
    const n = Number(o[k]);
    if (!/^\d+(\.\d+)?$/.test(String(o[k])) || !Number.isFinite(n)) throw new Error(`${k} must be a non-negative number`);
    o[k] = n;
  }
  return o;
}

function isMain() {
  if (!process.argv[1]) return false;
  const a = resolve(process.argv[1]);
  const b = fileURLToPath(import.meta.url);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

if (isMain()) {
  let opts;
  try {
    opts = parseOptions(process.argv.slice(2));
  } catch (e) {
    console.error(`monitor: ${e.message}`);
    process.exit(2);
  }
  const r = await runMonitor(opts);
  console.log(r.line);
  process.exitCode = r.code;
}

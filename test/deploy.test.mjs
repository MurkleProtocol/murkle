// Deployment kit (docs/design/mainnet-readiness.md §6): deploy/ (systemd units, env examples,
// compose, proxies, Bitcoin Core), the operator tools in deploy/bin (backup, monitor,
// state-rollback, check-books), the Dockerfile and .dockerignore, docs/OPERATIONS.md, the A-8 and
// A-9 copy of /security and /verify per network, the audit report's status cells and the
// package.json script names. Everything runs offline: fake HTTP servers listen on port 0 and
// every file is written to a temp dir.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import { schnorr } from "@noble/curves/secp256k1";
import * as backup from "../deploy/bin/backup.mjs";
import * as monitor from "../deploy/bin/monitor.mjs";
import * as rollback from "../deploy/bin/state-rollback.mjs";
import * as books from "../deploy/bin/check-books.mjs";
import { RelayBooks } from "../server/relay-books.mjs";
import { Indexer } from "../src/indexer.mjs";
import { encodeDeploy, opReturnScript } from "../src/envelope.mjs";
import { saveIndexer } from "../src/store-node.mjs";
import { auditFacts } from "../scripts/facts.mjs";
import { scanText } from "../scripts/prepublish-check.mjs";

// Web modules import JSON without attributes and CSS (Vite handles both); teach Node the same.
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (url.endsWith(".json") && !context.importAttributes?.type) return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: "json" } });
    return nextLoad(url, context);
  },
});

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), "utf8");
const TMP = mkdtempSync(join(tmpdir(), "murkle-deploy-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let tmpN = 0;
const tmp = (name = "t") => {
  const d = join(TMP, `${name}-${++tmpN}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const POSIX = process.platform !== "win32";
const modeOf = (p) => statSync(p).mode & 0o777;
const nodeRun = (args, opts = {}) => spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 60_000, ...opts });

function walk(dir, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}
const DEPLOY_FILES = walk("deploy");

/* ------------------------------------------------------------------ systemd */

/** A systemd unit file -> { Section: { Key: [values] } } (comments and blank lines skipped). */
function parseUnit(text) {
  const out = {};
  let sec = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const m = line.match(/^\[([A-Za-z]+)\]$/);
    if (m) {
      sec = out[m[1]] ??= {};
      continue;
    }
    const kv = line.match(/^([A-Za-z]+)=(.*)$/);
    assert.ok(kv && sec, `not a unit line: ${line}`);
    (sec[kv[1]] ??= []).push(kv[2]);
  }
  return out;
}
const unit = (name) => parseUnit(read(`deploy/systemd/${name}`));
const one = (sec, key) => {
  assert.ok(sec?.[key], `missing ${key}`);
  return sec[key][sec[key].length - 1];
};

const HARDENING = { NoNewPrivileges: "yes", ProtectSystem: "strict", ProtectHome: "yes", PrivateTmp: "yes", User: "murkle", Group: "murkle" };

test("systemd services: sections, EnvironmentFile, hardening, restart policy, memory cap", () => {
  const services = {
    "murkle-indexer.service": { env: "/etc/murkle/murkle.env", exec: "server/indexer-server.mjs", rw: "/var/lib/murkle", type: "simple" },
    "murkle-ceremony.service": { env: "/etc/murkle/ceremony.env", exec: "server/ceremony-server.mjs", rw: "/var/lib/murkle/ceremony", type: "simple" },
    "murkle-monitor.service": { env: "/etc/murkle/murkle.env", exec: "deploy/bin/monitor.mjs", rw: "/var/lib/murkle", type: "oneshot" },
    "murkle-backup.service": { env: "/etc/murkle/murkle.env", exec: "deploy/bin/backup.mjs backup", rw: "/var/backups/murkle", type: "oneshot" },
  };
  for (const [name, want] of Object.entries(services)) {
    const u = unit(name);
    assert.ok(one(u.Unit, "Description"), name);
    const s = u.Service;
    for (const [k, v] of Object.entries(HARDENING)) assert.equal(one(s, k), v, `${name}: ${k}`);
    assert.equal(one(s, "EnvironmentFile"), want.env, name);
    assert.equal(one(s, "WorkingDirectory"), "/opt/murkle/current", name);
    assert.equal(one(s, "Type"), want.type, name);
    assert.ok(one(s, "ExecStart").startsWith("/usr/bin/node ") && one(s, "ExecStart").includes(want.exec), `${name}: ExecStart`);
    assert.ok(s.ReadWritePaths.join(" ").split(/\s+/).includes(want.rw), `${name}: ReadWritePaths ${want.rw}`);
    assert.match(one(s, "MemoryMax"), /^\d+[MG]$/, name);
    assert.equal(one(s, "CapabilityBoundingSet"), "", `${name}: no capabilities`);
    assert.ok(!s.MemoryDenyWriteExecute, `${name}: Node's JIT and WebAssembly need W^X off`);
    if (want.type === "simple") {
      assert.equal(one(s, "Restart"), "on-failure", name);
      assert.equal(one(s, "RestartSec"), "5", name);
      assert.equal(one(u.Install, "WantedBy"), "multi-user.target", name);
    }
    // The script each unit runs is in the repository (the coordinator comes from the ceremony track).
    const script = one(s, "ExecStart").split(/\s+/)[1];
    if (!script.startsWith("server/ceremony")) assert.ok(existsSync(join(ROOT, script)), `${name}: ${script} exists`);
  }
  assert.ok(unit("murkle-indexer.service").Service.ExecStartPre.some((l) => l.includes("scripts/fetch-artifacts.mjs --check")), "the indexer checks its artifacts before it starts");
  assert.ok(unit("murkle-backup.service").Service.ReadOnlyPaths.includes("/var/lib/murkle"), "backups only read the data");
  assert.match(one(unit("murkle-backup.service").Service, "ExecStart"), /--min-interval 300/);
  assert.match(one(unit("murkle-monitor.service").Service, "ExecStart"), /--state \/var\/lib\/murkle\//);
});

test("systemd timers, path unit and relayer drop-in", () => {
  const mt = unit("murkle-monitor.timer");
  assert.equal(one(mt.Timer, "OnUnitActiveSec"), "1min");
  assert.equal(one(mt.Timer, "Unit"), "murkle-monitor.service");
  assert.equal(one(mt.Install, "WantedBy"), "timers.target");
  const bt = unit("murkle-backup.timer");
  assert.equal(one(bt.Timer, "OnCalendar"), "hourly");
  assert.equal(one(bt.Timer, "Persistent"), "true");
  assert.equal(one(bt.Timer, "Unit"), "murkle-backup.service");
  // A template (murkle-backup@<network>.path): the instance names the network, never a hand edit.
  const bp = unit("murkle-backup@.path");
  assert.equal(one(bp.Path, "PathChanged"), "/var/lib/murkle/%i/relay-balance/relayer.json");
  assert.ok(!existsSync(join(ROOT, "deploy/systemd/murkle-backup.path")), "no per-network path unit to edit");
  assert.equal(one(bp.Path, "Unit"), "murkle-backup.service");
  for (const u of ["murkle-monitor.timer", "murkle-backup.timer", "murkle-backup@.path"]) {
    assert.ok(existsSync(join(ROOT, "deploy/systemd", one(unit(u)[u.endsWith(".path") ? "Path" : "Timer"], "Unit"))), u);
  }
  const drop = parseUnit(read("deploy/systemd/murkle-indexer.service.d/relayer.conf.example"));
  const env = Object.fromEntries(drop.Service.Environment.map((e) => e.split("=")));
  assert.equal(env.MURKLE_RELAYER, "1");
  assert.equal(env.MURKLE_RELAY_MODE, "balance");
  assert.match(env.MURKLE_RELAY_DIR, /^\/var\/lib\/murkle\/(signet|mainnet)\/relay-balance$/);
  assert.match(read("deploy/systemd/murkle-indexer.service.d/relayer.conf.example"), /never pays a user's fee/);
  // The backup drop-in that goes with it: a backup without the relayer's keys fails.
  const bdrop = parseUnit(read("deploy/systemd/murkle-backup.service.d/relayer.conf.example"));
  assert.deepEqual(bdrop.Service.Environment, ["MURKLE_BACKUP_REQUIRE_RELAYER=1"]);
});

test("journald and logrotate keep logs bounded; proxies log no access lines", () => {
  const j = parseUnit(read("deploy/journald/murkle.conf"));
  assert.match(one(j.Journal, "SystemMaxUse"), /^\d+[GM]$/);
  assert.match(one(j.Journal, "MaxRetentionSec"), /day/);
  const lr = read("deploy/logrotate/murkle");
  for (const k of ["rotate 14", "compress", "missingok", "maxsize"]) assert.ok(lr.includes(k), k);
});

/* ------------------------------------------------------------------ env examples */

/** Every MURKLE_* name the contract (§8) or the code knows. */
function knownNames() {
  const names = new Set();
  const doc = read("docs/design/mainnet-readiness.md");
  const s8 = doc.slice(doc.indexOf("## 8. Environment variables"), doc.indexOf("## 9."));
  for (const row of s8.split("\n").filter((l) => l.startsWith("| `"))) {
    const cell = row.split("|")[1];
    const full = [...cell.matchAll(/`(MURKLE_[A-Z0-9_]+)`/g)].map((m) => m[1]);
    const prefix = full[0]?.match(/^MURKLE_[A-Z0-9]+/)?.[0];
    full.forEach((n) => names.add(n));
    for (const m of cell.matchAll(/`(_[A-Z0-9_]+)`/g)) names.add(prefix + m[1]);
  }
  const code = ["src", "server", "bin", "scripts"].flatMap((d) => (existsSync(join(ROOT, d)) ? walk(d) : [])).filter((f) => /\.m?js$/.test(f));
  for (const f of code) {
    const t = read(f);
    for (const m of t.matchAll(/\benv\("([A-Z0-9_]+)"\)/g)) names.add(`MURKLE_${m[1]}`);
    for (const m of t.matchAll(/\bMURKLE_[A-Z0-9_]+/g)) names.add(m[0]);
  }
  const relayer = read("server/relayer.mjs");
  const block = relayer.slice(relayer.indexOf("const ENV_NAMES = {"), relayer.indexOf("};", relayer.indexOf("const ENV_NAMES = {")));
  for (const m of block.matchAll(/:\s*"([A-Z0-9_]+)"/g)) names.add(`MURKLE_${m[1]}`);
  return names;
}

/** KEY=VALUE lines of an env file, commented-out examples included (flag commented). */
function envLines(text) {
  return text.split("\n").map((l) => l.trim()).filter((l) => /^(#\s*)?[A-Z][A-Z0-9_]*=/.test(l)).map((l) => {
    const commented = l.startsWith("#");
    const body = l.replace(/^#\s*/, "");
    const i = body.indexOf("=");
    return { name: body.slice(0, i), value: body.slice(i + 1), commented };
  });
}

const SECRETISH = [
  /-----BEGIN/, /\b[0-9a-f]{64}\b/i, /\b[xt]prv[1-9A-Za-z]{20,}/, /\brpcpassword\b/i, /\brpcuser\b/i,
  /:\/\/[^\s/:@]+:[^\s/@]+@/, /\b(5|K|L|c)[1-9A-HJ-NP-Za-km-z]{50,51}\b/,
];

test("env examples: only known MURKLE_* names, no secrets, the per-network switches", () => {
  const known = knownNames();
  for (const n of ["MURKLE_NETWORK", "MURKLE_BTC_SOURCE", "MURKLE_BITCOIND_COOKIE", "MURKLE_MONITOR_MAX_LAG", "MURKLE_CEREMONY_TRUST_PROXY", "MURKLE_BACKUP_RECIPIENT", "MURKLE_RELAY_DIR", "MURKLE_CSP_ENFORCE"]) {
    assert.ok(known.has(n), `the known-name list is built correctly (${n})`);
  }
  const files = ["deploy/env/murkle.signet.env.example", "deploy/env/murkle.mainnet.env.example", "deploy/env/ceremony.env.example"];
  for (const f of files) {
    const text = read(f);
    const lines = envLines(text);
    assert.ok(lines.length > 5, f);
    for (const { name, value } of lines) {
      assert.ok(name.startsWith("MURKLE_"), `${f}: ${name} is a MURKLE_ name`);
      assert.ok(known.has(name), `${f}: ${name} is a known name (contract §8 or the code)`);
      assert.ok(!/PASSWORD$/.test(name), `${f}: ${name}: passwords only as files (_PASSWORD_FILE)`);
      if (name === "MURKLE_BACKUP_RECIPIENT") assert.match(value, /^murkle-backup-pub:/, "a public key placeholder, never a private key");
    }
    for (const re of SECRETISH) assert.ok(!re.test(text), `${f}: nothing secret-like (${re})`);
    // EnvironmentFile= values override the drop-in's Environment=, so the relayer switch is never here.
    for (const n of ["MURKLE_RELAYER", "MURKLE_RELAY_MODE", "MURKLE_RELAY_DIR"]) assert.ok(!lines.some((l) => l.name === n && !l.commented), `${f}: ${n} is set by the drop-in only`);
  }
  const val = (f, n) => envLines(read(f)).find((l) => l.name === n && !l.commented)?.value;
  assert.equal(val(files[0], "MURKLE_NETWORK"), "signet");
  assert.equal(val(files[1], "MURKLE_NETWORK"), "mainnet");
  assert.equal(val(files[0], "MURKLE_CSP_ENFORCE"), "0", "signet keeps the CSP Report-Only, as today");
  assert.equal(val(files[1], "MURKLE_CSP_ENFORCE"), "1", "mainnet enforces it");
  assert.equal(val(files[1], "MURKLE_BTC_SOURCE"), "bitcoind", "mainnet indexes from the operator's own node");
  assert.notEqual(val(files[1], "MURKLE_HEADERS"), "off");
  for (const f of files.slice(0, 2)) {
    const net = val(f, "MURKLE_NETWORK");
    for (const n of ["MURKLE_STATE_PATH", "MURKLE_HEADERS_PATH", "MURKLE_RELAY_KEY_PATH", "MURKLE_RELAY_STATE_PATH"]) {
      assert.ok(val(f, n).startsWith(`/var/lib/murkle/${net}/`), `${f}: ${n} lives in the data directory, outside the read-only code`);
    }
    assert.equal(val(f, "MURKLE_TRUST_PROXY"), "1");
  }
  assert.match(read(files[1]), /has not launched/);
  // The compose env file: no MURKLE_ name outside the known list either.
  for (const { name } of envLines(read("deploy/docker/compose.env.example"))) {
    if (name.startsWith("MURKLE_")) assert.ok(known.has(name), `compose.env.example: ${name}`);
  }
});

/* ------------------------------------------------------------------ compose, proxies, Bitcoin Core */

/** The service blocks of the compose file -> { name: text }. */
function composeServices(text) {
  const start = text.indexOf("\nservices:\n");
  const end = text.indexOf("\nvolumes:\n");
  const body = text.slice(start + 11, end);
  const out = {};
  let cur = null;
  for (const line of body.split("\n")) {
    const m = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (m) out[(cur = m[1])] = "";
    else if (cur) out[cur] += line + "\n";
  }
  return out;
}

test("docker-compose: services, profiles, volumes, healthchecks, log limits, the RPC source", () => {
  const text = read("deploy/docker/docker-compose.yml");
  const svc = composeServices(text);
  assert.deepEqual(Object.keys(svc).sort(), ["bitcoind", "caddy", "electrs", "murkle-ceremony", "murkle-indexer"]);
  const profile = (s) => svc[s].match(/^ {4}profiles: \[(.*)\]$/m)?.[1] ?? null;
  assert.equal(profile("bitcoind"), null, "Bitcoin Core is on the default path");
  assert.equal(profile("murkle-indexer"), null);
  assert.equal(profile("caddy"), null);
  assert.equal(profile("murkle-ceremony"), '"ceremony"');
  assert.equal(profile("electrs"), '"electrs"');
  for (const [name, body] of Object.entries(svc)) {
    assert.match(body, /^ {4}healthcheck:\n {6}test:/m, `${name}: healthcheck`);
    assert.match(body, /^ {4}logging: \*logging$/m, `${name}: json-file log limits`);
    assert.match(body, /^ {4}restart: unless-stopped$/m, name);
  }
  assert.match(text, /x-logging: &logging\n {2}driver: json-file\n {2}options:\n {4}max-size: "\d+m"\n {4}max-file: "\d+"/);
  const vols = text.slice(text.indexOf("\nvolumes:\n")).split("\n").filter((l) => /^ {2}[a-z-]+:$/.test(l)).map((l) => l.trim().slice(0, -1));
  for (const v of ["bitcoin-data", "murkle-data", "ceremony-data", "caddy-data"]) assert.ok(vols.includes(v), `volume ${v}`);
  for (const [name, body] of Object.entries(svc)) {
    for (const m of body.matchAll(/^ {6}- ([a-z][a-z0-9-]*):\//gm)) assert.ok(vols.includes(m[1]), `${name}: volume ${m[1]} is declared`);
  }
  const idx = svc["murkle-indexer"];
  assert.match(idx, /MURKLE_BTC_SOURCE: bitcoind/);
  assert.match(idx, /MURKLE_BITCOIND_URL: http:\/\/bitcoind:/);
  assert.match(idx, /MURKLE_BITCOIND_COOKIE: /);
  assert.match(idx, /- bitcoin-data:\/bitcoin:ro/, "the cookie is read from a shared read-only volume");
  assert.match(idx, /MURKLE_RELAYER: "0"/);
  assert.match(idx, /MURKLE_NETWORK: \$\{MURKLE_NETWORK:-signet\}/);
  assert.match(idx, /\/api\/health/);
  const btc = svc.bitcoind;
  for (const flag of ["-txindex=1", "-prune=0", "-disablewallet=1", "-server=1", "-rpccookieperms=group"]) assert.ok(btc.includes(`- ${flag}`), flag);
  assert.doesNotMatch(btc, /"8332:|"38332:|rpcpassword|rpcuser/, "the RPC port is never published and there is no RPC password");
  assert.match(btc, /BITCOIN_SHA256: \$\{BITCOIN_SHA256:\?/, "a Bitcoin Core build needs its tarball hash");
  assert.match(svc["murkle-ceremony"], /server\/ceremony-server\.mjs/);
  assert.match(svc["murkle-ceremony"], /MURKLE_CEREMONY_TRUST_PROXY: "1"/);
  assert.match(svc.caddy, /\.\.\/caddy\/Caddyfile:\/etc\/caddy\/Caddyfile:ro/);
});

test("docker compose accepts the file (when the docker CLI is installed)", (t) => {
  const v = spawnSync("docker", ["compose", "version"], { encoding: "utf8", timeout: 20_000 });
  if (v.status !== 0) return t.skip("no docker compose CLI here");
  const r = spawnSync("docker", ["compose", "-f", "deploy/docker/docker-compose.yml", "--env-file", "deploy/docker/compose.env.example", "--profile", "ceremony", "--profile", "electrs", "config", "--quiet"], { cwd: ROOT, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
});

test("bitcoind.Dockerfile builds only a pinned, hash-checked release", () => {
  const df = read("deploy/docker/bitcoind.Dockerfile");
  assert.match(df, /^ARG BITCOIN_VERSION$/m);
  assert.match(df, /^ARG BITCOIN_SHA256$/m);
  assert.match(df, /test -n "\$BITCOIN_VERSION" && test -n "\$BITCOIN_SHA256"/);
  assert.match(df, /https:\/\/bitcoincore\.org\/bin\/bitcoin-core-\$\{BITCOIN_VERSION\}\//);
  assert.match(df, /sha256sum -c -/);
  assert.match(df, /^USER bitcoin$/m);
  const conf = read("deploy/bitcoin/bitcoin.conf.example");
  const set = Object.fromEntries(conf.split("\n").filter((l) => /^[a-z]+=/.test(l)).map((l) => l.split("=")));
  assert.equal(set.txindex, "1");
  assert.equal(set.prune, "0");
  assert.equal(set.server, "1");
  assert.equal(set.disablewallet, "1");
  assert.equal(set.rpcbind, "127.0.0.1");
  assert.ok(!/^\s*rpc(password|user)\s*=/m.test(conf), "cookie authentication only");
  assert.match(conf, /\[main\][\s\S]*rpcport=8332/);
  assert.match(conf, /\[signet\][\s\S]*rpcport=38332/);
});

test("Caddyfile and nginx: HTTPS, HSTS, ceremony routes to the coordinator, X-Forwarded-For overwritten, no access log", () => {
  const caddy = read("deploy/caddy/Caddyfile");
  assert.match(caddy, /@ceremony path \/ceremony\/api\/\* \/ceremony\/files\/\* \/ceremony\/transcript\.json/);
  assert.match(caddy, /handle @ceremony \{[\s\S]*?max_size 32MB[\s\S]*?reverse_proxy \{\$CEREMONY_UPSTREAM:127\.0\.0\.1:8790\}[\s\S]*?header_up X-Forwarded-For \{remote_host\}[\s\S]*?read_timeout 600s/);
  assert.match(caddy, /handle \{[\s\S]*?reverse_proxy \{\$INDEXER_UPSTREAM:127\.0\.0\.1:8787\} \{\s*#[^\n]*\n\s*header_up X-Forwarded-For \{remote_host\}/);
  assert.match(caddy, /Strict-Transport-Security "max-age=31536000"/);
  const code = caddy.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  assert.doesNotMatch(code, /^\s*log\b/m, "no access log");
  assert.doesNotMatch(code, /trusted_proxies/, "Caddy is the edge: no incoming X-Forwarded-For is believed");

  const nginx = read("deploy/nginx/murkle.conf");
  assert.match(nginx, /location ~ \^\/ceremony\/\(api\|files\)\/ \{[^}]*client_max_body_size 32m;[^}]*proxy_read_timeout 6\d0s;[^}]*proxy_pass http:\/\/127\.0\.0\.1:8790;/);
  assert.match(nginx, /location = \/ceremony\/transcript\.json \{\s*proxy_pass http:\/\/127\.0\.0\.1:8790;/);
  assert.match(nginx, /location \/ \{\s*proxy_pass http:\/\/127\.0\.0\.1:8787;/);
  assert.match(nginx, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(nginx, /\$proxy_add_x_forwarded_for/, "never append to a client-supplied header");
  assert.match(nginx, /add_header Strict-Transport-Security "max-age=31536000" always;/);
  assert.match(nginx, /access_log off;/);
  assert.match(nginx, /listen 443 ssl;/);
  assert.match(nginx, /return 301 https:\/\/\$host\$request_uri;/);
});

/* ------------------------------------------------------------------ Dockerfile and .dockerignore */

test("Dockerfile: the network build argument, the per-network check and a liveness healthcheck", () => {
  const df = read("Dockerfile");
  const stages = df.split(/^FROM /m).slice(1);
  assert.equal(stages.length, 2);
  for (const s of stages) assert.match(s, /^ARG MURKLE_NETWORK=signet$/m, "both stages take the network");
  assert.match(stages[0], /^ENV MURKLE_NETWORK=\$MURKLE_NETWORK$/m, "the web build and the artifact fetch see it");
  assert.ok(stages[0].indexOf("ENV MURKLE_NETWORK") < stages[0].indexOf("npm run web:build"));
  assert.match(stages[1], /MURKLE_NETWORK=\$MURKLE_NETWORK/);
  assert.match(df, /^HEALTHCHECK .*\\\n {2}CMD node -e "[^"]*\/api\/health[^"]*"$/m);
  assert.match(df, /fetch-artifacts\.mjs --check --quiet/);
  // Existing invariants (V2-38, publish tests) still hold.
  assert.match(df, /-e MURKLE_PUBLIC_URL=/);
  assert.match(df, /^COPY --from=build \/app \/app$/m);
  assert.ok(df.indexOf("chown -R node:node /app/data /app/build") < df.indexOf("USER node"));
  assert.match(df, /MURKLE_RELAYER=0/);
});

test("the Dockerfile healthcheck: 200 from /api/health, /api/state on an older indexer, 1 otherwise", async () => {
  // spawnSync blocks this event loop, so the fake server answers from a child process instead.
  const serverJs = `const http=require("http");const routes=JSON.parse(process.argv[1]);http.createServer((q,s)=>{s.writeHead(routes[q.url.split("?")[0]]??404);s.end("{}")}).listen(0,"127.0.0.1",function(){console.log(this.address().port)});`;
  const js = read("Dockerfile").match(/CMD node -e "([^"]+)"/)[1];
  const { spawn } = await import("node:child_process");
  async function run(routes) {
    const srv = spawn(process.execPath, ["-e", serverJs, JSON.stringify(routes)], { stdio: ["ignore", "pipe", "inherit"] });
    const port = await new Promise((r) => srv.stdout.once("data", (d) => r(String(d).trim())));
    const child = spawn(process.execPath, ["-e", js], { env: { ...process.env, MURKLE_INDEXER_PORT: port }, stdio: "ignore" });
    const code = await new Promise((r) => child.on("exit", r));
    srv.kill();
    return code;
  }
  assert.equal(await run({ "/api/health": 200 }), 0);
  assert.equal(await run({ "/api/health": 503 }), 1, "a strict 503 is not a liveness failure, but a plain 503 is");
  assert.equal(await run({ "/api/state": 200 }), 0, "an indexer without /api/health is alive when /api/state answers");
  assert.equal(await run({}), 1);
  const dead = spawn(process.execPath, ["-e", js], { env: { ...process.env, MURKLE_INDEXER_PORT: "9" }, stdio: "ignore" });
  assert.equal(await new Promise((r) => dead.on("exit", r)), 1, "nothing listening");
});

test(".dockerignore keeps env files, backups and backup keys out; the old patterns stay", () => {
  const lines = read(".dockerignore").split("\n");
  for (const p of ["deploy/**/*.env", "deploy/docker/compose.env", "**/*.mbk", "**/*.key", "**/*.key.pub", "**/.env", "**/.env.*", "**/relay-balance", "**/relayer.json", "**/state.json", "data", "build", "**/mnemonic*", "**/seed*.txt", "**/wallets"]) {
    assert.ok(lines.includes(p), `.dockerignore: ${p}`);
  }
  assert.ok(!lines.some((l) => l === "deploy" || l === "deploy/" || l === "**/*.example"), "the examples and the deploy tools stay in the context");
});

/* ------------------------------------------------------------------ backup.mjs */

function dataDir() {
  const d = tmp("data");
  mkdirSync(join(d, "relay-balance"), { recursive: true });
  writeFileSync(join(d, "relay-balance", "pool.key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  writeFileSync(join(d, "relay-balance", "change.key"), randomBytes(32).toString("hex"), { mode: 0o600 });
  writeFileSync(join(d, "relay-balance", "relayer.json"), JSON.stringify({ version: 2, network: "signet", n: randomBytes(8).toString("hex") }));
  writeFileSync(join(d, "state.json"), JSON.stringify({ version: 3, height: 1234, big: "x".repeat(50_000) }));
  return d;
}

test("backup: keygen, backup, verify and restore round trip, byte for byte", () => {
  const keys = tmp("keys");
  const keyPath = join(keys, "murkle-backup.key");
  const k = backup.runKeygen({ out: keyPath });
  assert.match(k.pubText, /^murkle-backup-pub:[A-Za-z0-9_-]{43}$/);
  assert.equal(readFileSync(`${keyPath}.pub`, "utf8").trim(), k.pubText);
  if (POSIX) assert.equal(modeOf(keyPath), 0o600, "the private key file is 0600");
  assert.throws(() => backup.runKeygen({ out: keyPath }), /never overwrites/);

  const data = dataDir();
  const out = tmp("out");
  const r = backup.runBackup({ recipient: k.pubText, dataDir: data, outDir: out, network: "signet" });
  assert.match(r.file, /murkle-backup-signet-\d{4}-\d{2}-\d{2}T[0-9-]+Z\.mbk$/);
  assert.deepEqual(r.files.map((f) => f.path).sort(), ["relay-balance/change.key", "relay-balance/pool.key", "relay-balance/relayer.json", "state.json"]);
  assert.deepEqual(r.skipped, ["headers.json"], "a missing file is listed, not fatal");
  if (POSIX) assert.equal(modeOf(r.file), 0o600);
  const sealed = readFileSync(r.file);
  assert.equal(sealed.subarray(0, 4).toString(), "MBK1");
  for (const f of ["pool.key", "change.key"]) {
    const secret = readFileSync(join(data, "relay-balance", f), "utf8");
    assert.ok(!sealed.includes(Buffer.from(secret)), `${f} is not in the file in clear`);
  }

  const v = backup.openBackup({ keyPath, inPath: r.file });
  assert.equal(v.network, "signet");
  assert.equal(v.files.length, 4);

  const to = join(tmp("restore"), "data");
  const res = backup.runRestore({ keyPath, inPath: r.file, toDir: to });
  for (const f of res.files) {
    assert.deepEqual(readFileSync(join(to, f.path)), readFileSync(join(data, f.path)), f.path);
    if (POSIX) assert.equal(modeOf(join(to, f.path)), modeOf(join(data, f.path)), `${f.path}: mode restored`);
  }
  assert.throws(() => backup.runRestore({ keyPath, inPath: r.file, toDir: to }), /not empty/);
  writeFileSync(join(to, "state.json"), "changed");
  backup.runRestore({ keyPath, inPath: r.file, toDir: to, force: true });
  assert.deepEqual(readFileSync(join(to, "state.json")), readFileSync(join(data, "state.json")), "--force overwrites");
});

test("backup: a modified file, a wrong key, a damaged JSON and an unsafe path all fail", () => {
  const keys = tmp("keys");
  const a = backup.runKeygen({ out: join(keys, "a.key") });
  backup.runKeygen({ out: join(keys, "b.key") });
  const data = dataDir();
  const out = tmp("out");
  const r = backup.runBackup({ recipient: a.pubText, dataDir: data, outDir: out, network: "mainnet" });

  const bytes = readFileSync(r.file);
  for (const at of [10, 80, bytes.length - 1, 200]) {
    const bad = Buffer.from(bytes);
    bad[at] ^= 1;
    const p = join(out, `tampered-${at}.mbk`);
    writeFileSync(p, bad);
    assert.throws(() => backup.openBackup({ keyPath: join(keys, "a.key"), inPath: p }), /modified or is damaged|another key/, `byte ${at}`);
  }
  assert.throws(() => backup.openBackup({ keyPath: join(keys, "b.key"), inPath: r.file }), /encrypted for another key/);
  writeFileSync(join(out, "short.mbk"), "MBK1");
  assert.throws(() => backup.openBackup({ keyPath: join(keys, "a.key"), inPath: join(out, "short.mbk") }), /not a Murkle backup/);

  writeFileSync(join(data, "headers.json"), "{ torn");
  assert.throws(() => backup.runBackup({ recipient: a.pubText, dataDir: data, outDir: out, network: "mainnet" }), /does not parse as JSON/);
  assert.throws(() => backup.runBackup({ recipient: "murkle-backup-pub:nope", dataDir: data, outDir: out, network: "mainnet" }), /not a backup public key/);
  assert.throws(() => backup.runBackup({ recipient: a.pubText, dataDir: tmp("empty"), outDir: out, network: "mainnet" }), /nothing to back up/);
  assert.throws(() => backup.collect(data, ["../outside.json"]), /unsafe path/);

  // An archive that names a path outside the target is refused before anything is written.
  const pub = backup.parsePublicKey(a.pubText);
  const evil = backup.seal(backup.packArchive({ network: "signet", files: [{ path: "../evil.txt", mode: 0o600, sha256: "00", b64: "" }] }), pub);
  writeFileSync(join(out, "evil.mbk"), evil);
  const target = tmp("target");
  assert.throws(() => backup.runRestore({ keyPath: join(keys, "a.key"), inPath: join(out, "evil.mbk"), toDir: target }), /unsafe path/);
  assert.ok(!existsSync(join(target, "..", "evil.txt")));
  // A record whose bytes do not match its sha256 is refused.
  const lie = backup.seal(backup.packArchive({ network: "signet", files: [{ path: "state.json", mode: 0o600, sha256: "0".repeat(64), b64: Buffer.from("{}").toString("base64") }] }), pub);
  writeFileSync(join(out, "lie.mbk"), lie);
  assert.throws(() => backup.openBackup({ keyPath: join(keys, "a.key"), inPath: join(out, "lie.mbk") }), /sha256 does not match/);
});

test("backup: --min-interval skips, pruning keeps the newest N and one per day", () => {
  const k = backup.runKeygen({ out: join(tmp("keys"), "k.key") });
  const data = dataDir();
  const out = tmp("out");
  let t = Date.parse("2026-10-01T00:00:00Z");
  const now = () => new Date(t);
  const first = backup.runBackup({ recipient: k.pubText, dataDir: data, outDir: out, network: "signet", now });
  utimesSync(first.file, new Date(t), new Date(t));
  t += 60_000;
  const skipped = backup.runBackup({ recipient: k.pubText, dataDir: data, outDir: out, network: "signet", now, minIntervalSecs: 300 });
  assert.equal(skipped.skipped, true);
  assert.match(skipped.reason, /60 s old/);

  const names = [];
  for (let d = 1; d <= 20; d++) for (const h of ["01", "13"]) names.push(`murkle-backup-signet-2026-09-${String(d).padStart(2, "0")}T${h}-00-00-000Z.mbk`);
  const name = (day, h) => `murkle-backup-signet-2026-09-${day}T${h}-00-00-000Z.mbk`;
  const keptBy = (opts) => {
    const del = backup.pruneList(names, { ...opts, network: "signet" });
    return names.filter((n) => !del.includes(n));
  };
  assert.deepEqual(keptBy({ keep: 5, keepDaily: 3 }), [name(18, "13"), name(19, "01"), name(19, "13"), name(20, "01"), name(20, "13")], "the newest 5 already hold the newest of the last 3 days");
  assert.deepEqual(keptBy({ keep: 2, keepDaily: 5 }), [name(16, "13"), name(17, "13"), name(18, "13"), name(19, "13"), name(20, "01"), name(20, "13")], "the newest 2 plus the newest of each of the last 5 days");
  assert.ok(backup.pruneList(["murkle-backup-mainnet-2026-09-01T00-00-00-000Z.mbk", "other.mbk"], { keep: 0, keepDaily: 0, network: "signet" }).length === 0, "only this network's backups are pruned");

  // Real pruning on disk.
  for (let i = 0; i < 4; i++) {
    t += 3_600_000;
    backup.runBackup({ recipient: k.pubText, dataDir: data, outDir: out, network: "signet", now, keep: 2, keepDaily: 0 });
  }
  assert.equal(backup.listBackups(out, "signet").length, 2);
});

test("backup CLI: exit codes, env defaults, the private key never printed", () => {
  const keyPath = join(tmp("keys"), "cli.key");
  const kg = nodeRun(["deploy/bin/backup.mjs", "keygen", "--out", keyPath]);
  assert.equal(kg.status, 0, kg.stderr);
  const pub = kg.stdout.trim();
  assert.match(pub, /^murkle-backup-pub:/);
  const secret = readFileSync(keyPath, "utf8").trim().split(":")[1];
  assert.ok(!kg.stdout.includes(secret) && !kg.stderr.includes(secret));
  const data = dataDir();
  const out = tmp("out");
  const b = nodeRun(["deploy/bin/backup.mjs", "backup", "--data", data], { env: { ...process.env, MURKLE_NETWORK: "mainnet", MURKLE_BACKUP_RECIPIENT: pub, MURKLE_BACKUP_DIR: out } });
  assert.equal(b.status, 0, b.stderr);
  const res = JSON.parse(b.stdout);
  assert.match(res.file, /murkle-backup-mainnet-/);
  const v = nodeRun(["deploy/bin/backup.mjs", "verify", "--key", keyPath, "--in", res.file]);
  assert.equal(v.status, 0, v.stderr);
  assert.equal(JSON.parse(v.stdout).network, "mainnet");
  assert.ok(!v.stdout.includes(readFileSync(join(data, "relay-balance", "pool.key"), "utf8")), "verify prints hashes, not contents");
  const other = join(tmp("keys"), "other.key");
  nodeRun(["deploy/bin/backup.mjs", "keygen", "--out", other]);
  assert.equal(nodeRun(["deploy/bin/backup.mjs", "verify", "--key", other, "--in", res.file]).status, 1);
  assert.equal(nodeRun(["deploy/bin/backup.mjs", "backup", "--data", data], { env: { ...process.env, MURKLE_BACKUP_RECIPIENT: "" } }).status, 2, "no recipient");
  assert.equal(nodeRun(["deploy/bin/backup.mjs", "nope"]).status, 2);
  assert.equal(nodeRun(["deploy/bin/backup.mjs", "backup", "--network", "testnet3", "--recipient", pub]).status, 2);
  assert.equal(nodeRun(["deploy/bin/backup.mjs", "--help"]).status, 0);
});

/* ------------------------------------------------------------------ monitor.mjs */

/** A fake indexer: answers each path with the given [status, body] (or 404). */
async function fakeServer(routes) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const key = req.method === "POST" ? `POST ${req.url}` : req.url;
      const r = typeof routes === "function" ? routes(req, body) : routes[key] ?? routes[req.url.split("?")[0]];
      if (!r) {
        res.writeHead(404);
        return res.end("not found");
      }
      res.writeHead(r[0], { "content-type": "application/json" });
      res.end(JSON.stringify(r[1] ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const NOW = Date.parse("2026-10-06T12:00:00Z");
const BIG_DISK = () => ({ bavail: 1000n * 1024n, bsize: 1024n * 1024n });
const health = (over = {}) => ({
  ok: true, network: "mainnet", height: 970210, chainTip: 970211, lagBlocks: 1, lastSync: NOW - 12_000, syncAgeSecs: 12, lastError: null,
  source: "bitcoind", headers: { verified: true, tipHeight: 970210, baseHeight: 969696, lastError: null },
  relayer: { enabled: true, halted: false, code: null }, artifacts: { ok: true }, preGenesis: false, ...over,
});
const runAt = (url, opts = {}, deps = {}) => monitor.runMonitor({ url, dataDir: TMP, timeoutMs: 5000, ...opts }, { now: () => NOW, statfs: BIG_DISK, error: () => {}, ...deps });

test("monitor: each alert from /api/health and its exit code", async () => {
  const cases = [
    [health(), "ok", []],
    [health({ lagBlocks: 5, ok: false }), "warning", ["lag"]],
    [health({ syncAgeSecs: 900, ok: false }), "critical", ["stale"]],
    [health({ syncAgeSecs: null, lastSync: null }), "warning", ["never_synced"]],
    [health({ ok: false, lastError: "fetch failed" }), "warning", ["sync_error"]],
    [health({ ok: false, lastError: "less-work: the source's branch has less work", headers: { verified: true, tipHeight: 1, baseHeight: 0, lastError: { code: "less-work", message: "the source's branch has less work", height: 970200 } } }), "critical", ["less_work"]],
    [health({ ok: false, lastError: "x", headers: { verified: true, lastError: { code: "pow", message: "hash above target", height: 5 } } }), "critical", ["header_error", "sync_error"]],
    [health({ ok: false, headers: { verified: true, lastError: { code: "time-too-new", message: "later", height: 5 } } }), "warning", ["header_error"]],
    [health({ ok: false, relayer: { enabled: true, halted: true, code: "halted", problems: ["margin -5 < 0"] } }), "critical", ["relayer_halted"]],
    [health({ ok: false, artifacts: { ok: false } }), "critical", ["artifacts"]],
    [health({ ok: false }), "warning", ["health_not_ok"]],
    [health({ headers: { verified: false } }), "warning", ["headers_off"]],
  ];
  for (const [body, level, codes] of cases) {
    const srv = await fakeServer({ "/api/health": [body.ok === false ? 503 : 200, body] });
    const r = await runAt(srv.url);
    await srv.close();
    assert.equal(r.level, level, JSON.stringify(body).slice(0, 120));
    assert.deepEqual(r.result.alerts.map((a) => a.code).sort(), [...codes].sort(), r.line);
    assert.equal(r.code, { ok: 0, warning: 1, critical: 2 }[level]);
    assert.ok(srv.seen.every((u) => u === "/api/health?strict=1"), "one strict health read");
    const parsed = JSON.parse(r.line);
    assert.equal(parsed.level, level);
    assert.ok(!r.line.includes("\n"), "one line");
  }
  const halted = monitor.evaluateIndexer({ health: health({ relayer: { halted: true, problems: ["pool unspent 1 < liabilities 2"] } }) });
  assert.match(halted.alerts[0].message, /pool unspent 1 < liabilities 2/);
});

test("monitor: the /api/state fallback, an indexer that is down, disk and the coordinator", async () => {
  const state = { network: "signet", height: 100, chainTip: 108, lastSync: NOW - 30_000, lastError: null, artifacts: { ok: true }, preGenesis: false };
  let srv = await fakeServer({ "/api/state": [200, state], "/api/relay/info": [200, { code: "halted" }] });
  let r = await runAt(srv.url);
  await srv.close();
  assert.deepEqual(r.result.alerts.map((a) => a.code).sort(), ["lag", "relayer_halted"]);
  assert.equal(r.result.indexer.via, "state");
  assert.equal(r.result.indexer.lagBlocks, 8);
  assert.equal(r.code, 2);
  assert.deepEqual(srv.seen, ["/api/health?strict=1", "/api/state", "/api/relay/info"]);

  srv = await fakeServer({ "/api/state": [200, { ...state, chainTip: 100, lastSync: NOW - 3_600_000, lastError: "reorg deeper than undo log; full resync needed" }], "/api/relay/info": [200, { code: "disabled" }] });
  r = await runAt(srv.url);
  await srv.close();
  assert.deepEqual(r.result.alerts.map((a) => a.code).sort(), ["stale", "sync_error"]);

  srv = await fakeServer({ "/api/state": [200, { ...state, chainTip: 100, lastError: "HeaderError less-work at 99" }] });
  r = await runAt(srv.url);
  await srv.close();
  assert.deepEqual(r.result.alerts.map((a) => a.code), ["less_work"]);

  srv = await fakeServer({ "/api/health": [500, { error: "x" }] });
  r = await runAt(srv.url);
  await srv.close();
  assert.equal(r.result.alerts[0].code, "indexer_down");
  const dead = await fakeServer({});
  const deadUrl = dead.url;
  await dead.close();
  r = await runAt(deadUrl);
  assert.deepEqual(r.result.alerts.map((a) => a.code), ["indexer_down"]);
  assert.equal(r.code, 2);

  srv = await fakeServer({ "/api/health": [200, health()] });
  const GB = 1024n ** 3n;
  r = await runAt(srv.url, { minFreeGb: 20 }, { statfs: () => ({ bavail: 10n * GB, bsize: 1n }) });
  assert.deepEqual(r.result.alerts.map((a) => [a.code, a.level]), [["disk_low", "warning"]]);
  r = await runAt(srv.url, { minFreeGb: 20 }, { statfs: () => ({ bavail: 4n * GB, bsize: 1n }) });
  assert.deepEqual(r.result.alerts.map((a) => [a.code, a.level]), [["disk_low", "critical"]]);
  r = await runAt(srv.url, {}, { statfs: () => { throw Object.assign(new Error("no"), { code: "ENOENT" }); } });
  assert.deepEqual(r.result.alerts.map((a) => a.code), ["disk_unknown"]);

  const cer = await fakeServer({ "/ceremony/api/health": [200, { ok: true, phase: "open", contributions: 3, waiting: 1 }] });
  r = await runAt(srv.url, { ceremonyUrl: cer.url });
  assert.equal(r.level, "ok");
  assert.deepEqual(r.result.ceremony, { reachable: true, phase: "open", contributions: 3, waiting: 1 });
  await cer.close();
  r = await runAt(srv.url, { ceremonyUrl: cer.url });
  assert.deepEqual(r.result.alerts.map((a) => a.code), ["ceremony_down"]);
  assert.equal(r.code, 1);
  await srv.close();
});

test("monitor: the webhook gets the same line, once per change with --state, and a failed post retries", async () => {
  let body = health();
  const posts = [];
  let hookStatus = 200;
  const srv = await fakeServer((req, b) => {
    if (req.method === "POST") {
      posts.push(b);
      return [hookStatus, {}];
    }
    return req.url.startsWith("/api/health") ? [200, body] : null;
  });
  const hook = `${srv.url}/hook/secret-token`;
  const errors = [];
  const run = (opts) => monitor.runMonitor({ url: srv.url, dataDir: TMP, webhook: hook, ...opts }, { now: () => NOW, statfs: BIG_DISK, error: (s) => errors.push(s) });

  await run({});
  assert.equal(posts.length, 0, "nothing to post when ok");
  body = health({ lagBlocks: 9 });
  const r1 = await run({});
  assert.deepEqual(posts, [r1.line], "the exact printed line, nothing else");
  await run({});
  assert.equal(posts.length, 2, "without --state every non-ok run posts");

  const stateFile = join(tmp("mon"), "monitor-last.json");
  posts.length = 0;
  await run({ state: stateFile });
  await run({ state: stateFile });
  assert.equal(posts.length, 1, "with --state only a change posts");
  body = health({ lagBlocks: 9, relayer: { halted: true } });
  await run({ state: stateFile });
  assert.equal(posts.length, 2, "a new alert is a change");
  body = health();
  await run({ state: stateFile });
  assert.equal(posts.length, 3, "the return to ok is posted");
  assert.equal(JSON.parse(posts[2]).level, "ok");
  await run({ state: stateFile });
  assert.equal(posts.length, 3);

  body = health({ artifacts: { ok: false } });
  hookStatus = 500;
  await run({ state: stateFile });
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).level, "ok", "a failed post leaves the state as it was");
  hookStatus = 200;
  await run({ state: stateFile });
  assert.equal(posts.length, 5, "so the next run posts again");
  assert.equal(JSON.parse(readFileSync(stateFile, "utf8")).level, "critical");
  assert.ok(errors.length >= 1 && errors.every((e) => !e.includes("secret-token")), "the webhook URL is never printed");
  await srv.close();
});

test("monitor CLI: one JSON line and the exit code; env defaults; bad options are usage errors", async () => {
  const srv = await fakeServer({ "/api/health": [503, health({ ok: false, lagBlocks: 7 })] });
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["deploy/bin/monitor.mjs", "--data-dir", TMP], { cwd: ROOT, env: { ...process.env, MURKLE_MONITOR_URL: srv.url, MURKLE_MONITOR_MAX_LAG: "3" } });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const code = await new Promise((r) => child.on("exit", r));
  await srv.close();
  assert.equal(code, 1);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]).alerts.map((a) => a.code), ["lag"]);
  assert.equal(nodeRun(["deploy/bin/monitor.mjs", "--max-lag", "lots"]).status, 2);
  assert.equal(nodeRun(["deploy/bin/monitor.mjs", "--bogus", "1"]).status, 2);
  assert.deepEqual(monitor.parseOptions(["--min-free-gb=5"], { MURKLE_MONITOR_WEBHOOK: "https://h.example/x", MURKLE_MONITOR_MAX_LAG: "4" }), { webhook: "https://h.example/x", maxLag: 4, minFreeGb: 5 });
});

/* ------------------------------------------------------------------ state-rollback.mjs */

const coinbase = { txid: "00".repeat(32), inputs: [], outputs: [] };
const deployTx = (ticker) => ({
  txid: randomBytes(32).toString("hex"),
  inputs: [{ outpoint: randomBytes(36) }],
  outputs: [{ script: opReturnScript(encodeDeploy({ ticker, divisibility: 0, mintAmount: 10n, mintCap: 5, priceSats: 0n, treasury: new Uint8Array() })), value: 0n }],
});

/** A synthetic chain from `start`: empty blocks with DEPLOYs at the given heights. */
async function chain(start, blocks, deploys = {}) {
  const idx = new Indexer({ vkey: null, startHeight: start });
  for (let h = start; h < start + blocks; h++) {
    await idx.applyBlock({ height: h, hash: randomBytes(32).toString("hex"), txs: [coinbase, ...(deploys[h] ? [deployTx(deploys[h])] : [])] });
  }
  return idx;
}

test("state-rollback: rolls a state back through its undo journal, archives the old file, and matches the original digest", async () => {
  const idx = await chain(1000, 10, { 1003: "ALPHA", 1007: "BETA" });
  const dir = tmp("state");
  const path = join(dir, "state.json");
  saveIndexer(path, idx);
  const before = readFileSync(path, "utf8");

  const dry = rollback.rollbackFile(path, 1005, { dryRun: true });
  assert.deepEqual([dry.from, dry.to, dry.digest, dry.archived], [1009, 1005, idx.digests.get(1005), null]);
  assert.equal(readFileSync(path, "utf8"), before, "a dry run writes nothing");

  const r = rollback.rollbackFile(path, 1005);
  assert.equal(r.digest, idx.digests.get(1005));
  assert.ok(existsSync(r.archived) && readFileSync(r.archived, "utf8") === before, "the old file is archived whole, never deleted");
  assert.match(relative(dir, r.archived).replace(/\\/g, "/"), /^archive\/state-.*before-rollback-to-1005\.json$/);
  const back = Indexer.restore(JSON.parse(readFileSync(path, "utf8")), {});
  assert.equal(back.height, 1005);
  assert.equal(back.digests.get(1005), idx.digests.get(1005));
  assert.deepEqual([...back.tickers.keys()], ["ALPHA"], "BETA (block 1007) is gone, ALPHA stays");
  assert.equal(back.digests.get(1006), undefined);

  assert.throws(() => rollback.rollbackFile(path, 1006), /ends at 1005/);
  assert.throws(() => rollback.rollbackFile(path, 998), /starts at 1000/);
  rollback.rollbackFile(path, 999);
  assert.equal(Indexer.restore(JSON.parse(readFileSync(path, "utf8")), {}).height, 999, "down to the block before the start");
});

test("state-rollback: refuses a height deeper than the 144-block journal; the CLI's exit codes", async () => {
  const idx = await chain(2000, 150);
  const path = join(tmp("deep"), "state.json");
  saveIndexer(path, idx);
  assert.throws(() => rollback.rollbackFile(path, 2002), /reaches back only to 2005 \(144 blocks\)/);
  assert.equal(rollback.rollbackFile(path, 2005, { dryRun: true }).to, 2005);
  const bad = nodeRun(["deploy/bin/state-rollback.mjs", "--state", path, "--to", "2002"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /resync from genesis/);
  assert.equal(nodeRun(["deploy/bin/state-rollback.mjs", "--state", path]).status, 2);
  assert.equal(nodeRun(["deploy/bin/state-rollback.mjs", "--state", path, "--to", "x"]).status, 2);
  const ok = nodeRun(["deploy/bin/state-rollback.mjs", "--state", path, "--to", "2140"]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).to, 2140);
  const broken = join(tmp("broken"), "state.json");
  writeFileSync(broken, JSON.stringify({ version: 99 }));
  assert.equal(nodeRun(["deploy/bin/state-rollback.mjs", "--state", broken, "--to", "1"]).status, 1);
});

/* ------------------------------------------------------------------ check-books.mjs */

const HEX = () => randomBytes(32).toString("hex");

/** A synthetic paid-relayer state: one deposit credited, one carrier charged and confirmed. */
function relayerState(dir) {
  const pool = HEX();
  const change = HEX();
  writeFileSync(join(dir, "pool.key"), pool);
  writeFileSync(join(dir, "change.key"), change);
  const keys = { pool: Buffer.from(schnorr.getPublicKey(pool)).toString("hex"), change: Buffer.from(schnorr.getPublicKey(change)).toString("hex") };
  const b = new RelayBooks({ network: "signet", poolKey: keys.pool, changeKey: keys.change });
  const id = HEX();
  b.credit({ key: `${HEX()}:0`, id, n: 0, value: 10_000, sweepCost: 288, height: 5 });
  b.reserve("item-1", id, 1500);
  b.settle("item-1", { fee: 600 });
  b.confirmCharge("item-1");
  b.reserve("item-2", id, 700);
  const liabilities = b.liabilities();
  return {
    version: 2, network: "signet", keys, books: b.toJSON(),
    coins: { [`${HEX()}:1`]: { status: "unspent", value: liabilities, kind: "change" }, [`${HEX()}:0`]: { status: "spent", value: 10_000, kind: "deposit" } },
    items: {}, ledger: [], lastReconciled: 5, lastReconciledHash: null, lastFlushHeight: 5, halted: null,
  };
}

test("check-books: I2 holds on consistent books; tampering, short coins, wrong keys and a halt are reported", async () => {
  const { STATE_VERSION } = await import("../server/relayer.mjs");
  const dir = tmp("relay");
  const saved = relayerState(dir);
  assert.equal(STATE_VERSION, 2, "check-books reads the paid relayer's state version");
  const ok = books.checkBooks(saved, { keysDir: dir });
  assert.equal(ok.ok, true, ok.problems.join("; "));
  assert.equal(ok.keyFiles, "match");
  assert.equal(ok.credited, 10_000);
  assert.equal(ok.fees, 600);
  assert.equal(ok.slack, 0);
  assert.equal(ok.credited - ok.fees - ok.balances - ok.reserved, ok.margin);

  const short = structuredClone(saved);
  Object.values(short.coins)[0].value -= 1;
  assert.match(books.checkBooks(short).problems.join(), /pool unspent .* < liabilities/);
  const tampered = structuredClone(saved);
  tampered.books.margin += 7;
  assert.match(books.checkBooks(tampered).problems.join(), /!= margin/);
  const halted = structuredClone(saved);
  halted.halted = { height: 9, problems: ["x"] };
  assert.match(books.checkBooks(halted).problems.join(), /records a halt at 9/);
  const otherNet = structuredClone(saved);
  otherNet.network = "mainnet";
  assert.match(books.checkBooks(otherNet).problems.join(), /books do not load/);
  assert.match(books.checkBooks({ ...saved, version: 1 }).problems.join(), /state version 1/);
  writeFileSync(join(dir, "pool.key"), HEX());
  const wrong = books.checkBooks(saved, { keysDir: dir });
  assert.equal(wrong.keyFiles, "mismatch");
  assert.match(wrong.problems.join(), /pool\.key does not belong to this state/);
  assert.equal(books.checkBooks(saved, { keysDir: tmp("nokeys") }).keyFiles, "absent");

  // The CLI: one JSON line, no key material, exit 0 / 1 / 2.
  const good = tmp("relay");
  const state = relayerState(good);
  writeFileSync(join(good, "relayer.json"), JSON.stringify(state));
  const r = nodeRun(["deploy/bin/check-books.mjs", "--state", join(good, "relayer.json")]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  for (const f of ["pool.key", "change.key"]) assert.ok(!r.stdout.includes(readFileSync(join(good, f), "utf8")), `${f} is never printed`);
  writeFileSync(join(good, "relayer.json"), JSON.stringify({ ...state, coins: {} }));
  assert.equal(nodeRun(["deploy/bin/check-books.mjs", "--state", join(good, "relayer.json")]).status, 1);
  assert.equal(nodeRun(["deploy/bin/check-books.mjs"]).status, 2);
  assert.equal(nodeRun(["deploy/bin/check-books.mjs", "--state", join(good, "missing.json")]).status, 1);
});

/* ------------------------------------------------------------------ copy: /security and /verify */

const strip = (s) => String(s).replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/\s+/g, " ");
const SIGNET_A9 = "Headers are checked for proof of work and the difficulty rules from a pinned checkpoint. Signet blocks are valid by a signature that is not checked, and signet proof of work is nearly free.";
const MAINNET_A9 = "the chain with the most work wins among those the data source serves. The source can still hide or delay blocks; your own node removes it.";

test("/security states A-8 and A-9 per network; mainnet is not launched before genesis", async () => {
  const sec = await import("../web/src/views/security.js");
  const root = {};
  sec.render(root);
  const signet = strip(root.innerHTML);
  assert.ok(signet.includes(SIGNET_A9), "signet A-9 copy (contract §6.7)");
  assert.match(signet, /Signet test network\. Test coins only, with no value\./);
  assert.match(signet, /Signet keeps it by design: its genesis attestation pins these keys/);
  assert.match(signet, /single-party development setup/);
  assert.doesNotMatch(signet, /proof-of-work is not checked|isn't checked yet|not checked yet/, "the old A-9 wording is gone");
  // Phrases existing tests assert.
  assert.match(signet, /Without a replay, the anchor root comes from our indexer/);
  assert.match(signet, /even after you replay the pool/);
  assert.doesNotMatch(signet, /A-1 to A-9/);

  const pre = strip(sec.renderPage(sec.pageContext({ network: "mainnet", preGenesis: true, ceremony: null })));
  assert.match(pre, /Murkle has not launched on Bitcoin mainnet\. No genesis is pinned, so nothing here can move funds\./);
  assert.ok(pre.includes(MAINNET_A9), "mainnet A-9 copy");
  assert.match(pre, /The public phase-2 ceremony has not run yet/);
  assert.doesNotMatch(pre, /Signet test network|no value|Signet coins/, "no signet disclosure on mainnet");
  assert.doesNotMatch(pre, /signature that is not checked/);
  assert.doesNotMatch(pre, /Posted on mainnet|BITCOIN MAINNET/);

  const post = strip(sec.renderPage(sec.pageContext({ network: "mainnet", preGenesis: false, genesisTxid: "ab".repeat(32), activationHeight: 975100, ceremony: { id: "murkle-mainnet-1", contributions: 12, beacon: { height: 975000 } } })));
  assert.match(post, /public ceremony murkle-mainnet-1, 12 contributions, beacon block #975,000/);
  assert.match(post, /secure if at least one contributor discarded their secret/);
  assert.match(post, /tokens may be worth money and can be lost to bugs/);
  assert.match(post, /no external audit yet/i);
  assert.doesNotMatch(post, /has not launched/);
  // The ceremony line only once the mainnet pins name it.
  assert.doesNotMatch(strip(sec.renderPage(sec.pageContext({ network: "mainnet", preGenesis: true, ceremony: null }))), /contributions, beacon block/);
  assert.equal(sec.setupTrust({ network: "signet", ceremony: { id: "x" } }).status, "single-party development setup", "signet never claims a ceremony");

  assert.match(strip(sec.disclosure({ contact: null, repoUrl: null, network: "mainnet" })), /report privately first/);
  assert.match(strip(sec.disclosure({ contact: null, repoUrl: null })), /Signet coins have no value/);
  assert.deepEqual(sec.receiptLevels().map(([l]) => l), ["checkpoint", "linked", "bounded", "own-target"], "the receipt levels of contract §3.6");
});

test("/verify takes its A-8 and A-9 copy from security.js, per network", async () => {
  const sec = await import("../web/src/views/security.js");
  const s = sec.verifyCopy(sec.pageContext({ network: "signet" }));
  const m = sec.verifyCopy(sec.pageContext({ network: "mainnet", preGenesis: true, ceremony: null }));
  assert.equal(s.limitsTitle, "What is still trusted on signet");
  assert.equal(m.limitsTitle, "What is still trusted on mainnet");
  assert.match(s.caveats.join(" "), /signet proof of work is nearly free/);
  assert.match(m.caveats.join(" "), /most work among the chains mempool\.space serves/);
  assert.doesNotMatch(m.caveats.concat(m.limits.map((l) => l[2])).join(" "), /signet|no value/i);
  assert.deepEqual(s.limits.map((l) => l[0]), ["SETUP", "CHAIN DATA", "REVIEW", "NETWORK"]);
  assert.match(s.limits[1][2], /\(A-9\)/);
  assert.match(m.limits[0][2], /\(A-8\)/);
  assert.deepEqual(s.setupTag, ["single-party development setup", "danger"]);
  assert.equal(m.setupTag[1], "danger", "no mainnet key before the ceremony");

  const src = read("web/src/views/verify.js");
  assert.match(src, /import \{ verifyCopy \} from "\.\/security\.js";/);
  for (const use of ["COPY.caveats", "COPY.limits", "COPY.limitsTitle", "COPY.setupTag", "COPY.headerLevels"]) assert.ok(src.includes(use), use);
  assert.doesNotMatch(src, /proof-of-work isn't checked yet|are not checked yet \(A-9\)/, "the old A-9 wording is gone");
  assert.match(src, /headerStopText/, "a header error ends the replay with its own message, never a verdict");
  assert.match(src, /"less-work"/);
  assert.match(src, /p\.headers\?\.tipHeight/, "the progress shows the verified header tip");
  // Phrases existing tests assert stay.
  assert.match(src, /<section id="indexer"/);
  assert.match(src, /result\.ok === null \? "t-warn"/);
  assert.match(src, /\(await import\("\.\.\/session\.js"\)\)\.currentSession\(\)/);
});

/* ------------------------------------------------------------------ audit report, scripts, docs */

test("audit/REPORT.md: the A-8, A-9 and V2-02 status cells and the closing status line", () => {
  const report = read("audit/REPORT.md");
  const f = Object.fromEntries(auditFacts(report).findings.map((x) => [x.id, x]));
  assert.equal(f["A-9"].state, "partial");
  assert.match(f["A-9"].status, /linkage, proof of work, retarget, MTP, version, checkpoints, most work/);
  assert.match(f["A-9"].status, /a single source can withhold blocks; the signet signature \(BIP325\) is not checked/);
  assert.match(f["A-8"].status, /^mainnet: public ceremony tooling ready .*open until the ceremony runs; signet: DEV setup by design/);
  assert.equal(f["V2-02"].state, "fixed");
  assert.match(f["V2-02"].status, /mainnet from genesis .*signet keeps the historical rule/);
  assert.doesNotMatch(report, /block headers come from mempool\.space without a proof-of-work check/);
  assert.match(report, /\*\*A-8 and A-9 remain \(status 2026-10-06, mainnet readiness\):\*\*/);
  assert.doesNotMatch(report, /\| for mainnet — our own bitcoind \|/);
});

test("package.json has the script names other tracks and the docs use (and no dependency change)", () => {
  const pkg = JSON.parse(read("package.json"));
  const want = {
    ceremony: "node server/ceremony-server.mjs",
    "ceremony:contribute": "node scripts/ceremony/contribute.mjs",
    "ceremony:verify": "node scripts/ceremony/verify.mjs",
    "headers:checkpoint": "node scripts/checkpoint.mjs",
    "replay:compare": "node scripts/replay-compare.mjs",
    monitor: "node deploy/bin/monitor.mjs",
    backup: "node deploy/bin/backup.mjs",
  };
  for (const [k, v] of Object.entries(want)) assert.equal(pkg.scripts[k], v, k);
  assert.equal(pkg.scripts.test, 'node --test "test/*.test.mjs"');
  assert.ok(!pkg.dependencies["@noble/ciphers"].startsWith("2"), "no dependency changes");
});

test("docs/OPERATIONS.md covers install, upgrade, restart, backups, the drill and the incident playbook", () => {
  const ops = read("docs/OPERATIONS.md");
  for (const h of ["## 3. Install (host, systemd)", "## 4. Install (Docker Compose)", "## 5. Upgrade and rollback", "## 6. Restarts", "## 7. Backups and the restore drill", "## 8. Monitoring and alerts", "### 10.1 Relayer halt", "### 10.2 Reorg", "### 10.3 Header errors and `less-work`", "### 10.4 Key compromise", "### 10.5 Ceremony coordinator"]) {
    assert.ok(ops.includes(h), h);
  }
  for (const s of ["state-rollback.mjs", "check-books.mjs", "backup.mjs verify", "Never start a relayer from a drill copy", "Never move pool coins by hand", "MURKLE_RELAYER", "npm ci", "fetch-artifacts.mjs --check", "txindex=1", "MURKLE_CSP_ENFORCE=1", "never pays a user's fee"]) {
    assert.ok(ops.includes(s), `OPERATIONS.md: ${s}`);
  }
  // Every monitor alert code is documented.
  const codes = new Set();
  for (const f of ["deploy/bin/monitor.mjs"]) for (const m of read(f).matchAll(/alert\("(?:warning|critical)", "([a-z_]+)"/g)) codes.add(m[1]);
  for (const m of read("deploy/bin/monitor.mjs").matchAll(/"(?:warning|critical)", "([a-z_]+)"/g)) codes.add(m[1]);
  assert.ok(codes.size >= 12, [...codes].join());
  for (const c of codes) assert.ok(ops.includes(`\`${c}\``), `OPERATIONS.md documents alert ${c}`);
  // Every file the README lists exists.
  const readme = read("deploy/README.md");
  for (const m of readme.matchAll(/^\| `([^`]+)`/gm)) {
    const first = m[1].split(",")[0].trim();
    assert.ok(existsSync(join(ROOT, "deploy", first)), `deploy/README.md: ${first}`);
  }
});

const BANNED = [/\btrustless\b/i, /\banonymous\b/i, /\buntraceable\b/i, /\bmixer\b/i, /(?<!internally )\baudited\b/i, /mainnet[- ]ready/i, /live on mainnet/i, /\bmainnet is live\b/i, /\bhas launched on (Bitcoin )?mainnet\b/i];

test("no banned words or launch claims in the new docs, the deploy kit and the per-network copy", async () => {
  const files = ["docs/OPERATIONS.md", ...DEPLOY_FILES];
  for (const f of files) {
    const text = read(f);
    for (const re of BANNED) assert.ok(!re.test(text), `${f}: ${re}`);
  }
  const sec = await import("../web/src/views/security.js");
  for (const ctx of [{ network: "signet" }, { network: "mainnet", preGenesis: true, ceremony: null }, { network: "mainnet", preGenesis: false, ceremony: {} }]) {
    const text = strip(sec.renderPage(sec.pageContext(ctx))) + JSON.stringify(sec.verifyCopy(sec.pageContext(ctx)));
    for (const re of BANNED) assert.ok(!re.test(text), `${JSON.stringify(ctx)}: ${re}`);
  }
});

test("my files: line endings kept, English only, nothing the publish check refuses", () => {
  const ends = (p) => {
    const b = readFileSync(join(ROOT, p));
    let lf = 0;
    let crlf = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 10) b[i - 1] === 13 ? crlf++ : lf++;
    return { lf, crlf, last: b[b.length - 1] };
  };
  assert.equal(ends("web/src/views/verify.js").lf, 0, "verify.js stays CRLF");
  const lf = ["Dockerfile", ".dockerignore", "package.json", "audit/REPORT.md", "docs/CLAIMS.md", "docs/OPERATIONS.md", "web/src/views/security.js", "test/deploy.test.mjs", ...DEPLOY_FILES];
  for (const f of lf) {
    const e = ends(f);
    assert.equal(e.crlf, 0, `${f} is LF`);
    assert.equal(e.last, 10, `${f} ends with a newline`);
  }
  for (const f of [...lf, "web/src/views/verify.js"]) {
    const text = read(f);
    assert.ok(![...text].some((c) => c.codePointAt(0) >= 0x400 && c.codePointAt(0) <= 0x4ff), `${f}: English only`);
    // Absolute local paths, emails, secret-like values (the publish check's text rules).
    if (f !== "test/deploy.test.mjs") assert.deepEqual(scanText(text, { path: f }), [], f);
  }
});

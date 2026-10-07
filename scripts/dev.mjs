// Starts the indexer API and the Vite dev server together; Ctrl+C stops both.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Both children inherit MURKLE_INDEXER_PORT: the indexer listens on it and
// web/vite.config.mjs proxies /api and /artifacts to it (default 8787).
const procs = [
  spawn(process.execPath, ["server/indexer-server.mjs"], { cwd: ROOT, stdio: "inherit" }),
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--config", "web/vite.config.mjs"], { cwd: ROOT, stdio: "inherit" }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
procs.forEach((p) => p.on("exit", (code) => code && (stop(), process.exit(code))));

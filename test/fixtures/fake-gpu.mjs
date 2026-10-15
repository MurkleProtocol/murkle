// A Node stand-in for the murkle-gpu binary (gpu/src/murkle-gpu.cu): the same command line and the
// same text protocol, with a cheap hash (sha256 of the password, or sha256("pow" || password) like
// the contract stub of the CLI tests, or the real Argon2id). Tests run it as a child process and
// make it lie, stall or crash by --mode.
//
//   node fake-gpu.mjs --list
//   node fake-gpu.mjs --device N [--slots S] [--hashes-per-block W] [--mode M] [--hash H] [--delay MS] [--name TEXT]
//
// --mode  honest (default) | wrong-candidate | wrong-hash | wrong-probe | wrong-vector | crash-after=N |
//         silent | garbage | slow | wrong-id | oversized | unknown-type | early-exit | no-device | bad-protocol |
//         strict-target (compares with < instead of <=)
// --hash  sha256 (default) | pow-prefix | argon2
// --delay milliseconds per batch (slow mode: 40)
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const mode = opt("mode", "honest");
const hashKind = opt("hash", "sha256");
const device = Number(opt("device", 0));
const name = opt("name", `Fake GPU ${device}`);
const slots = Number(opt("slots", mode === "slow" ? 16 : 64));
const delayMs = Number(opt("delay", mode === "slow" ? 40 : 0));
const crashAfter = mode.startsWith("crash-after=") ? Number(mode.split("=")[1]) : Infinity;
const U64 = (1n << 64n) - 1n;

const out = (obj) => process.stdout.write(`${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`);
const sha = (...parts) => createHash("sha256").update(Buffer.concat(parts.map((p) => Buffer.from(p)))).digest();

let argon = null;
async function hashOf(pw) {
  if (hashKind === "sha256") return sha(pw);
  if (hashKind === "pow-prefix") return sha(Buffer.from("pow"), pw);
  argon ??= (await import("../../src/mine.mjs")).powHash;
  return Buffer.from(await argon(Uint8Array.from(pw)));
}
const flip = (buf) => {
  const b = Buffer.from(buf);
  b[0] ^= 1;
  return b;
};
const passwordOf = (challenge, counter) => {
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(counter & U64);
  return Buffer.concat([challenge, n]);
};

if (argv.includes("--list")) {
  if (mode === "no-device") {
    out({ type: "fatal", code: "NO_DEVICE", error: "no CUDA device" });
    process.exit(2);
  }
  const count = Number(opt("count", 2));
  for (let i = 0; i < count; i++) out({ type: "device", index: i, name: `Fake GPU ${i}`, cc: "8.9", vramMiB: 24564 });
  out({ type: "list", count });
  process.exit(0);
}

if (mode === "early-exit") {
  process.stderr.write("fake gpu: cannot initialise the driver\n");
  process.exit(3);
}
if (mode === "no-device") {
  out({ type: "fatal", code: "NO_DEVICE", error: "no CUDA device" });
  process.exit(2);
}
out({
  type: "hello", protocol: mode === "bad-protocol" ? 2 : 1, version: "1.0.0-fake", device, name, cc: "8.9", sms: 4, vramMiB: 1024, slots, hashesPerBlock: 4,
});

let cancelId = null;
let quit = false;
let served = 0;
let chain = Promise.resolve();
const finish = (code = 0) => process.exit(code);

const rl = createInterface({ input: process.stdin });
rl.on("close", () => finish(0)); // end of input: never outlive the parent
rl.on("line", (line) => {
  if (line === "quit") {
    quit = true;
    finish(0);
    return;
  }
  if (line.startsWith("cancel ")) {
    cancelId = Number(line.slice(7));
    return;
  }
  chain = chain.then(() => handle(line));
});

async function handle(line) {
  const t = line.split(" ");
  const id = Number(t[1]);
  if (served >= crashAfter) {
    process.stderr.write("fake gpu: crashing as asked\n");
    finish(1);
  }
  served += 1;
  if (mode === "silent") return;
  if (mode === "garbage") return out("this is not json");
  if (mode === "oversized") return process.stdout.write(`${"x".repeat((1 << 20) + 10)}\n`);
  if (mode === "unknown-type") return out({ type: "banana", id });
  if (mode === "wrong-id") return out({ type: t[0], id: id + 1000, ok: true, hashes: [] });
  if (t[0] === "hash") {
    const hashes = [];
    for (const h of t.slice(2)) {
      const tag = await hashOf(Buffer.from(h, "hex"));
      hashes.push((mode === "wrong-vector" ? flip(tag) : tag).toString("hex"));
    }
    return out({ type: "hash", id, ok: true, hashes });
  }
  if (t[0] === "search") return search(id, Buffer.from(t[2], "hex"), BigInt(`0x${t[3]}`), BigInt(t[4]), BigInt(t[5]), BigInt(t[6]));
  out({ type: "error", id: Number.isFinite(id) ? id : null, code: "BAD_REQUEST", error: "unknown request" });
}

async function search(id, challenge, target, start, count, probe) {
  const t0 = Date.now();
  let done = 0n;
  let total = 0;
  const found = [];
  let probeTag = null;
  let cancelled = false;
  while (done < count) {
    if (quit || cancelId === id) {
      cancelled = true;
      break;
    }
    await new Promise((r) => (delayMs ? setTimeout(r, delayMs) : setImmediate(r))); // lets `cancel` and `quit` lines in between batches
    const n = BigInt(Math.min(slots, Number(count - done)));
    for (let k = 0n; k < n; k++) {
      const nonce = (start + done + k) & U64;
      const tag = await hashOf(passwordOf(challenge, nonce));
      const value = BigInt(`0x${tag.toString("hex")}`);
      if (mode === "strict-target" ? value < target : value <= target) {
        total += 1;
        if (found.length < 64) found.push({ nonce, tag });
      }
      if (done + k === probe) probeTag = mode === "wrong-probe" ? flip(tag) : tag;
    }
    done += n;
    if (mode === "wrong-candidate" && !found.length) {
      // claims the first nonce of the batch although its hash is above the target
      const nonce = (start + done - n) & U64;
      found.push({ nonce, tag: await hashOf(passwordOf(challenge, nonce)) });
      total += 1;
    }
    if (total > 0) break;
  }
  if (cancelId === id) cancelId = null;
  out({
    type: "search", id, ok: true, done: String(done), ms: Date.now() - t0, cancelled,
    candidates: found.map((c, i) => ({ nonce: String(c.nonce), hash: (mode === "wrong-hash" && i === 0 ? flip(c.tag) : c.tag).toString("hex") })),
    more: total - found.length, probe: probeTag ? probeTag.toString("hex") : null,
  });
}

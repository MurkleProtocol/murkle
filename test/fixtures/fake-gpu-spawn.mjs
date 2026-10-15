// A `spawn` for src/gpu.mjs that runs test/fixtures/fake-gpu.mjs instead of the murkle-gpu binary.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const FAKE_GPU = fileURLToPath(new URL("./fake-gpu.mjs", import.meta.url));

/**
 * fakeSpawn(["--mode", "wrong-hash"], { sent, children }) -> spawn(bin, args, options) like child_process.spawn.
 * `extra` follows the arguments the CLI passes; every line written to a child's stdin is pushed to `sent`
 * and every child to `children` when given.
 */
export function fakeSpawn(extra = [], { sent = null, children = null } = {}) {
  return (_bin, args, options) => {
    const child = spawn(process.execPath, [FAKE_GPU, ...args, ...extra], options);
    children?.push(child);
    if (sent) {
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (data, ...rest) => {
        sent.push(String(data).trim());
        return write(data, ...rest);
      };
    }
    return child;
  };
}

/** True while a process with this pid exists. */
export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits (up to timeoutMs) until fn() is true. */
export async function until(fn, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting for a condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

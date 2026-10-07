#!/usr/bin/env node
// Verifies one ceremony upload in a child process of the coordinator (server/ceremony-server.mjs),
// so a slow or hostile file can be killed on a timeout without taking the server down.
//
//   node scripts/ceremony/verify-one.mjs --init zkeys/0000.zkey --ptau <ptau> --zkey <upload>
//
// Prints one line `@@murkle-verify {json}` with { ok, reason?, contributions? } (lib.mjs
// verifyUpload) and exits 0; any other exit means the verification itself failed to run.
import { isMain, parseArgs, requireFile, terminateCurve, verifyUpload } from "./lib.mjs";

export const RESULT_PREFIX = "@@murkle-verify ";

async function main(argv) {
  const a = parseArgs(argv);
  const init = requireFile(a.init, "initial zkey");
  const ptau = requireFile(a.ptau, "ptau");
  const zkey = requireFile(a.zkey, "uploaded zkey");
  const result = await verifyUpload({ init, ptau, zkey });
  process.stdout.write(RESULT_PREFIX + JSON.stringify(result) + "\n");
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then(() => terminateCurve())
    .then(() => process.exit(0))
    .catch((e) => {
      process.stderr.write(`verify-one: ${e?.message ?? e}\n`);
      process.exit(2);
    });
}

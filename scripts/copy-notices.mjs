#!/usr/bin/env node
// Copies the legal notices into the built site (run by `npm run web:build` after vite build),
// so every host of web/dist also serves them: /THIRD_PARTY_NOTICES.txt always, and
// /LICENSE.txt once a LICENSE file exists. The bundle inlines GPL-3.0-or-later code
// (snarkjs and the iden3 libraries) and OFL-1.1 fonts, whose licenses ask for their notices
// to travel with every copy.
//
// Usage: node scripts/copy-notices.mjs [--dist <dir>]   (default web/dist; a temp build passes its --outDir)
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const at = process.argv.indexOf("--dist");
const DIST = at > 0 && process.argv[at + 1] ? resolve(process.argv[at + 1]) : join(ROOT, "web", "dist");
const SHOWN = at > 0 ? DIST : "web/dist";

if (!existsSync(DIST)) {
  console.error(`copy-notices: ${SHOWN} does not exist; run vite build first`);
  process.exit(1);
}
const copies = [
  ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.txt", true],
  ["LICENSE", "LICENSE.txt", false],
];
for (const [from, to, required] of copies) {
  if (!existsSync(join(ROOT, from))) {
    if (required) {
      console.error(`copy-notices: ${from} is missing`);
      process.exit(1);
    }
    console.warn(`copy-notices: no ${from} yet, so ${SHOWN} has no /${to}`);
    continue;
  }
  copyFileSync(join(ROOT, from), join(DIST, to));
  console.log(`copy-notices: ${SHOWN}/${to}`);
}

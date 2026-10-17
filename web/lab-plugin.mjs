// SPDX-License-Identifier: GPL-3.0-or-later
//
// Murkle WebGPU miner: the build gate of the lab.
// Copyright (C) the Murkle contributors.
//
// This program is free software: you can redistribute it and/or modify it under the terms of the
// GNU General Public License as published by the Free Software Foundation, either version 3 of
// the License, or (at your option) any later version. It is distributed WITHOUT ANY WARRANTY; see
// the GNU General Public License for more details (LICENSE in the repository root).
//
// murkleLab(enabled) is the only door through which lab code can enter a build:
//   - the virtual module "virtual:murkle-lab" (imported by web/src/views/app-mine.js) is an empty stub,
//     `export const labGpu = null;`, unless the build was made with MURKLE_LAB=1; then it is
//     web/src/lab/index.js, which carries only the stub GPU worker and the fault hook (the GPU (beta) box itself
//     is in every build: its worker is web/src/gpu/gpu-worker.js, fetched only when the box is ticked);
//   - the standalone lab page web/lab-gpu.html is added to the build inputs only then;
//   - in the dev server the lab page answers 404 unless the lab is on.
// The lab code lives in web/src/lab/, never in web/src/views/ (app.js globs ./views/*.js).
// The build marker (web/vite.config.mjs) records `lab`, and the indexer refuses a lab dist on mainnet
// unless MURKLE_ALLOW_LAB=1 (server/indexer-server.mjs).
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export const LAB_MODULE = "virtual:murkle-lab";
export const LAB_STUB = "export const labGpu = null;\n";
export const LAB_INDEX = here("src/lab/index.js");
export const LAB_PAGE = here("lab-gpu.html");
const RESOLVED_STUB = `\0${LAB_MODULE}`;

/** enabled: true only for MURKLE_LAB=1 (web/vite.config.mjs validates the variable). */
export function murkleLab(enabled) {
  return {
    name: "murkle-lab",
    enforce: "pre",
    config() {
      return enabled ? { build: { rollupOptions: { input: { lab: LAB_PAGE } } } } : null;
    },
    resolveId(source) {
      if (source !== LAB_MODULE) return null;
      return enabled ? LAB_INDEX : RESOLVED_STUB;
    },
    load(id) {
      return id === RESOLVED_STUB ? LAB_STUB : null;
    },
    configureServer(server) {
      if (enabled) return;
      server.middlewares.use((req, res, next) => {
        if (String(req.url ?? "").split(/[?#]/)[0] !== "/lab-gpu.html") return next();
        res.statusCode = 404;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.end("Not found");
      });
    },
  };
}

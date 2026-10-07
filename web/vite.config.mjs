import { defineConfig } from "vite";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const INDEXER = `http://localhost:${process.env.MURKLE_INDEXER_PORT ?? 8787}`;
const CEREMONY = `http://localhost:${process.env.MURKLE_CEREMONY_PORT ?? 8790}`;
const here = (p) => fileURLToPath(new URL(p, import.meta.url));

// The network is fixed at build time (mainnet-readiness.md D1): src/params.mjs reads the
// __MURKLE_NETWORK__ define in the browser and its workers. Validated like params: unset or ""
// is signet, anything else but "mainnet" refuses to build.
const NETWORK = (() => {
  const v = process.env.MURKLE_NETWORK;
  if (v === undefined || v === "") return "signet";
  if (v === "signet" || v === "mainnet") return v;
  throw new Error(`MURKLE_NETWORK must be "signet" or "mainnet", not ${JSON.stringify(v)}`);
})();
const PINS = JSON.parse(readFileSync(here(NETWORK === "mainnet" ? "../src/pins.mainnet.json" : "../src/pins.json"), "utf8"));
const DEFINE = { __MURKLE_NETWORK__: JSON.stringify(NETWORK) };

// The ceremony page is a separate entry, built only once its file exists (ceremony track).
const INPUTS = { index: here("index.html"), ...(existsSync(here("ceremony.html")) ? { ceremony: here("ceremony.html") } : {}) };

/**
 * Writes murkle-build.json ({ network, manifestSha256, genesisTxid }) into the output dir. The
 * indexer refuses to serve a dist built for another network (server/indexer-server.mjs).
 */
function buildMarker() {
  let outDir = null;
  return {
    name: "murkle-build-marker",
    apply: "build",
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const file = join(outDir, "murkle-build.json");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ network: NETWORK, manifestSha256: PINS.manifestSha256 ?? null, genesisTxid: PINS.genesisTxid ?? null }, null, 2)}\n`);
    },
  };
}

/**
 * index.html carries signet wording in its static description tags. A mainnet build replaces it
 * with neutral text (no "testnet", no value claims); a signet build is left byte for byte.
 */
function networkHtml() {
  return {
    name: "murkle-network-html",
    transformIndexHtml: {
      order: "pre",
      handler(html) {
        if (NETWORK === "signet") return html;
        const status = PINS.genesisTxid ? "Experimental software." : "Not launched on Bitcoin mainnet yet.";
        return html
          .replace(" Signet testnet.\" />", ` ${status}" />`)
          .replaceAll("Private tokens on Bitcoin L1, signet testnet.", `Private tokens on Bitcoin L1. ${status}`);
      },
    },
  };
}

/**
 * Facts per network (scripts/facts.mjs): signet modules import web/src/facts.json; a mainnet build
 * reads web/src/facts.mainnet.json instead (MURKLE_NETWORK=mainnet node scripts/facts.mjs writes
 * it), so building mainnet never rewrites the signet facts the dev server shows.
 */
function networkFacts() {
  const file = here("src/facts.mainnet.json");
  return {
    name: "murkle-network-facts",
    enforce: "pre",
    resolveId(source) {
      if (NETWORK === "signet" || !/(^|\/)facts\.json$/.test(source)) return null;
      if (!existsSync(file)) throw new Error("web/src/facts.mainnet.json is missing: run MURKLE_NETWORK=mainnet node scripts/facts.mjs");
      return file;
    },
  };
}

// Fonts used above the fold: preload them so text doesn't reflow (visual.md section 4).
const PRELOAD_FONTS = [
  "instrument-serif-latin-400-normal",
  "instrument-sans-latin-400-normal",
  "instrument-sans-latin-500-normal",
  "jetbrains-mono-latin-400-normal",
];

/** Injects <link rel="preload"> for the hashed font files Vite emits (build only). */
function preloadFonts(names) {
  return {
    name: "murkle-preload-fonts",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const tags = [];
        for (const file of Object.values(ctx.bundle ?? {})) {
          if (file.type !== "asset" || !file.fileName.endsWith(".woff2")) continue;
          if (!names.some((n) => file.fileName.includes(`${n}-`) || file.fileName.endsWith(`${n}.woff2`))) continue;
          tags.push({
            tag: "link",
            attrs: { rel: "preload", as: "font", type: "font/woff2", href: `/${file.fileName}`, crossorigin: true },
            injectTo: "head",
          });
        }
        return tags;
      },
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  // History-API routing: unknown paths fall back to index.html in dev and preview.
  appType: "spa",
  plugins: [networkFacts(), preloadFonts(PRELOAD_FONTS), networkHtml(), buildMarker()],
  define: DEFINE,
  server: {
    port: 5173,
    strictPort: true,
    // No hot reload by default: the modules take no hot updates, so every saved file would
    // reload (and lock) every open tab. Reload by hand to pick up edits; MURKLE_HMR=1 restores it.
    hmr: process.env.MURKLE_HMR === "1",
    // The ceremony coordinator is its own process (server/ceremony-server.mjs, port 8790).
    proxy: { "/api": INDEXER, "/artifacts": INDEXER, "/ceremony/api": CEREMONY, "/ceremony/files": CEREMONY },
    // The wallet imports the protocol modules from ../src and fonts from node_modules.
    // Never the repo root: /@fs/ would then serve data/ (relayer key, CLI wallets).
    fs: { allow: [".", "../src", "../node_modules"].map((p) => fileURLToPath(new URL(p, import.meta.url))) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    // The CSP allows fonts from 'self' only, so font files are never inlined as data: URIs.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/i.test(file) ? false : undefined),
    rollupOptions: { input: INPUTS },
  },
  // The define reaches pre-bundled dependencies too (none read it today).
  optimizeDeps: { esbuildOptions: { target: "es2022", define: DEFINE } },
  // Workers (proof, PoW, replay) import src/params.mjs as well: the define applies to them too.
  worker: { format: "es" },
});

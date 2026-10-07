#!/usr/bin/env node
// Prints a header-chain base checkpoint (src/btc/checkpoints.json entry) for a height, after
// checking linkage, proof of work, the difficulty bits and the median-time-past rule over the
// headers it reads. Read-only: it never writes a file.
//
//   node scripts/checkpoint.mjs --network signet|mainnet --height H [--source esplora|bitcoind] [--label TEXT]
//
// It reads headers from H - (H % 2016) (the period start, whose time the next retarget needs)
// and the 10 headers below H (the median time past of H + 1). Prefer a retarget boundary
// (H % 2016 === 0): then only 11 headers are read. Cross-check the printed hash against a
// second source (your own node and mempool.space) before committing it (docs/MAINNET.md G3).
import { RULES, checkPow, decodeHeader, fetchHeaders, medianTimePast } from "../src/btc/headers.mjs";
import { openChainSource } from "../src/btc/source.mjs";
import * as P from "../src/params.mjs";
import { pathToFileURL } from "node:url";

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

export async function makeCheckpoint({ network, height, source, label = null, log = () => {} }) {
  const rules = RULES[network];
  if (!rules) throw new Error(`--network must be signet or mainnet, not ${network}`);
  if (!Number.isInteger(height) || height < 11) throw new Error("--height must be an integer of at least 11");
  const periodStart = height - (height % rules.interval);
  const from = Math.min(periodStart, height - 10);
  const count = height - from + 1;
  log(`reading ${count} headers #${from}..#${height}`);
  const list = [];
  for (let h = from; h <= height; h += 200) {
    const page = await fetchHeaders(source, h, Math.min(200, height - h + 1));
    if (!page.length) throw new Error(`the source served no header at #${h}`);
    list.push(...page);
  }
  if (list.length !== count) throw new Error(`expected ${count} headers, got ${list.length} (is #${height} above the tip?)`);
  const hs = list.map((b) => decodeHeader(b));
  for (let i = 0; i < hs.length; i++) {
    const h = from + i;
    checkPow(hs[i], rules);
    if (i > 0) {
      if (hs[i].prevHash !== hs[i - 1].hash) throw new Error(`header #${h} does not link to #${h - 1}`);
      // No retarget inside the range except possibly at `height` itself (when it is a boundary).
      if (h % rules.interval !== 0 && hs[i].bits !== hs[i - 1].bits) throw new Error(`header #${h} changes nBits inside a retarget period`);
      const prev = hs.slice(Math.max(0, i - 11), i).map((x) => x.time);
      if (prev.length === 11 && hs[i].time <= medianTimePast(prev)) throw new Error(`header #${h} is not above the median time past`);
    }
  }
  const tip = hs.at(-1);
  const prevTimes = hs.slice(-11, -1).map((x) => x.time);
  return {
    height,
    hash: tip.hash,
    label: label ?? `${network === "mainnet" ? "Bitcoin mainnet" : "Bitcoin signet"} block ${height}`,
    base: { bits: tip.bits, time: tip.time, periodStartTime: hs[periodStart - from].time, prevTimes },
  };
}

async function main() {
  const a = args(process.argv.slice(2));
  const network = String(a.network ?? P.NETWORK ?? "signet");
  const height = Number(a.height);
  const kind = a.source ? String(a.source) : null;
  if (network !== (P.NETWORK ?? "signet")) {
    throw new Error(`this process runs for ${P.NETWORK ?? "signet"}; run it with MURKLE_NETWORK=${network}`);
  }
  const read = (name) => (name === "BTC_SOURCE" && kind ? kind : name === "HEADERS" ? (network === "signet" ? "off" : "on") : P.env?.(name));
  const src = await openChainSource({ network, read, log: console });
  const cp = await makeCheckpoint({ network, height, source: src.api, label: a.label ? String(a.label) : null, log: (m) => console.error(m) });
  console.error(`source: ${src.api.base}`);
  console.log(JSON.stringify(cp, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`checkpoint: ${e.message}`);
    process.exit(1);
  });
}

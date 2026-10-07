#!/usr/bin/env node
// Operator commands for a running ceremony (docs/CEREMONY.md, "Operator runbook").
//
//   node scripts/ceremony/admin.mjs --dir D status
//   node scripts/ceremony/admin.mjs --dir D pause      no new slots or joins; an active slot may finish
//   node scripts/ceremony/admin.mjs --dir D resume
//   node scripts/ceremony/admin.mjs --dir D close [--tip N | --source esplora|bitcoind [--esplora URL]]
//   node scripts/ceremony/admin.mjs --dir D drop-slot             ends the active slot (a squatter, a stuck client)
//   node scripts/ceremony/admin.mjs --dir D drop-prefix <address> removes every queue place of that address's
//                                                                  prefix (/24 IPv4, /48 IPv6) and its slot
//
// The coordinator reads control.json on every request. `close` is final: it records the chain
// tip at the close (finalize requires it to be below the beacon height) and the coordinator
// refuses every later upload. With a chain source configured the coordinator also closes
// itself at the announced height. At the close it records the close commitment in
// transcript.json (`status` prints it): publish it at once, somewhere independently timestamped,
// before the beacon block exists (docs/CEREMONY.md, "The beacon").
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { ceremonyPaths, isMain, openBeaconSource, parseArgs, readJson, readJsonOr, runMain, writeJsonAtomic } from "./lib.mjs";

export function writeControl(dir, control, now = Date.now) {
  const p = ceremonyPaths(dir);
  if (!existsSync(p.ceremony)) throw new Error(`${p.dir} is not a ceremony directory`);
  const current = readJsonOr(p.control, null);
  if (current?.phase === "closed") throw new Error("the ceremony is closed; that cannot be undone");
  // Merged: a pause keeps queued actions, an action keeps the phase.
  writeJsonAtomic(p.control, { ...(current ?? {}), ...control, at: new Date(now()).toISOString() });
}

/** Queues a one-time action for the coordinator (applied on its next request or tick). */
export function addAction(dir, action, now = Date.now) {
  const current = readJsonOr(ceremonyPaths(dir).control, null);
  const actions = [...(current?.actions ?? []), { id: randomBytes(8).toString("hex"), ...action, at: new Date(now()).toISOString() }].slice(-100);
  writeControl(dir, { actions }, now);
  return actions.at(-1);
}

export function statusLines(dir) {
  const p = ceremonyPaths(dir);
  const c = readJson(p.ceremony);
  const t = readJson(p.transcript);
  const s = readJsonOr(p.state, {});
  const ctl = readJsonOr(p.control, null);
  const lines = [
    `ceremony ${c.id}${c.pinned ? "" : " (UNPINNED rehearsal)"}`,
    `phase ${s.phase ?? "unknown"}${ctl ? ` (control: ${ctl.phase} at ${ctl.at})` : ""}`,
    `contributions ${t.contributions.length}; waiting ${s.queue?.length ?? 0}; slot ${s.slot ? `#${s.slot.index} until ${new Date(s.slot.deadline).toISOString()}` : "free"}`,
    `beacon Bitcoin ${c.beacon.network} block ${c.beacon.height}; close at ${c.beacon.height - c.beacon.closeBeforeBlocks}`,
    `closed ${t.closed ? `${t.closed.at} at tip ${t.closed.tipHeight}` : "no"}`,
    ...(t.closed?.commitment ? [`close commitment ${t.closed.commitment} (${t.closed.contributions} contributions): publish it before block ${c.beacon.height}`] : []),
    `final ${t.final ? `zkey ${t.final.zkeySha256}` : "no"}`,
  ];
  for (const x of t.contributions) lines.push(`  #${x.index} ${JSON.stringify(x.name)} ${x.contributionHash.slice(0, 32)}... ${x.acceptedAt}`);
  return lines;
}

async function main(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  if (!a.dir) throw new Error("--dir is required");
  if (cmd === "status") {
    for (const l of statusLines(a.dir)) console.log(l);
    return 0;
  }
  if (cmd === "pause" || cmd === "resume") {
    writeControl(a.dir, { phase: cmd === "pause" ? "paused" : "open" });
    console.log(`control: ${cmd === "pause" ? "paused" : "open"}`);
    return 0;
  }
  if (cmd === "close") {
    const c = readJson(ceremonyPaths(a.dir).ceremony);
    let tip = a.tip !== undefined ? Number(a.tip) : null;
    if (tip === null) {
      const src = await openBeaconSource({ kind: a.source ?? "esplora", network: c.beacon.network, esplora: a.esplora ?? null });
      tip = await src.tipHeight();
      console.log(`tip ${tip} from ${src.describe}`);
    }
    if (!Number.isSafeInteger(tip) || tip < 0) throw new Error("--tip must be a block height");
    if (tip >= c.beacon.height) console.warn(`warning: the tip ${tip} is at or above the beacon height ${c.beacon.height}; finalize will refuse this ceremony`);
    writeControl(a.dir, { phase: "closed", tipHeight: tip });
    console.log(`control: closed at tip ${tip}`);
    console.log("The coordinator records the close commitment in transcript.json; print it with `status` and publish it now, before the beacon block.");
    return 0;
  }
  if (cmd === "drop-slot") {
    const act = addAction(a.dir, { kind: "drop-slot" });
    console.log(`control: drop the active slot (action ${act.id})`);
    return 0;
  }
  if (cmd === "drop-prefix") {
    const address = a._[1];
    if (!address) throw new Error("drop-prefix needs an address, e.g. 2001:db8:1:2::5 or 203.0.113.7");
    const act = addAction(a.dir, { kind: "drop-prefix", value: address });
    console.log(`control: drop the queue places of ${address}'s prefix (action ${act.id})`);
    return 0;
  }
  throw new Error("command: status | pause | resume | close | drop-slot | drop-prefix <address>");
}

if (isMain(import.meta.url)) runMain(main);

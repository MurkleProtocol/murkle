// Emergency tools for the paid relayer (docs/design/relay-balance.md §9, docs/OPERATIONS.md 10.4):
// what the operator does when the pool key Q or the change key C may be known to someone else.
//
//   evacuate      `murkle relayer evacuate --to <cold address>`: freezes the relayer (HOLD), releases
//                 every queued item (nothing charged), then sweeps every coin the relayer's own
//                 records say it controls (credited deposits not merged yet, which spend through Q's
//                 tweaks, and the change coins of its own journaled transactions; never a foreign
//                 coin: no address is ever listed) to the cold address, in as few transactions as
//                 the standard size and mempool ancestor limits allow, at a high fee rate, every
//                 input signalling RBF. `--bump` signs the same sweep again at a higher rate;
//                 `--cancel` undoes a false alarm before any coin moved.
//   rotate        `murkle relayer rotate`: new Q and C (never a key used before), the books carried
//                 over unchanged under the new keys, the old keys kept in retired/g<N>/ for late
//                 deposits, and the relayer refusing every send and credit (pool_unfunded) until
//                 the new pool is refilled.
//   refund-pool   `murkle relayer refund-pool --from <key file> | --outpoint <txid:vout>`: records the
//                 operator's payment to the new C (from the cold wallet); once it is in a block and
//                 I2 holds again, the HOLD is lifted and the relayer resumes at its next restart.
//                 Later, the same command pays any further operator liability.
//   sweep-retired `murkle relayer sweep-retired`: moves deposits that paid a retired address after the
//                 rotation into the pool; each is credited once that sweep confirms and the pool
//                 covers it.
//   status        `murkle relayer status`: what the files say, read only.
//
// The operator never pays a user's transaction (I-PAY) and no user pays for an evacuation: its fees
// are an operator cost, paid from the margin account first, the rest recorded as an operator
// liability (relay-books.mjs payOperatorCost). Every balance and reservation stays as it was.
//
// Concurrency: these tools write the relayer's files, so a running relayer must not. HOLD in the
// relay directory freezes it (server/relayer.mjs checkHold, within a second): it refuses sends and
// credits, saves once, writes HOLD.ack and never writes again until it is restarted without HOLD.
// A relayer started while HOLD is in place starts frozen. A tool goes on only after that
// acknowledgement, or when the operator says the relayer is stopped (--relayer-stopped). On top of
// that every write here first checks that the state file is still the one this tool read
// (saveGuard), and a running relayer never writes over a tool's write while HOLD is in place
// (Relayer.save).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve as resolvePath } from "node:path";
import * as btc from "@scure/btc-signer";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { RBF_SEQUENCE, btcAccount, dustLimit, planPayment, scriptOf, shuffled, signInputs, signLocal } from "../src/btc/funding.mjs";
import { parseRawTx } from "../src/btc/block.mjs";
import { NETWORK } from "../src/params.mjs";
import { equal, hex, unhex } from "../src/bytes.mjs";
import { depositKeyOfTweak, depositSecretOfTweak, parseOutpoint } from "../src/relay-account.mjs";
import { DEFAULTS, RELAY_FILES, Relayer, STATE_VERSION, feeAt, persistedItem, readTagKeys, unionMix, writeDurable } from "./relayer.mjs";
import { readRelayerKey } from "./retired-relay.mjs";

/** Inputs per sweep: about 86 kvB, under the 100 kvB standard transaction limit. */
export const MAX_SWEEP_INPUTS = 1500;
/** Unconfirmed ancestors one sweep may have (Bitcoin Core: 25 including itself). */
export const ANCESTOR_LIMIT = 24;
/** Seconds an operator tool waits for a running relayer to acknowledge its HOLD. */
export const DEFAULT_WAIT_SECS = 10;
/** The largest share of the swept value a sweep's fees may take without --high-fee (a mistyped --fee-rate). */
export const MAX_FEE_SHARE = 0.5;

const HEX32 = /^[0-9a-f]{64}$/;
const QUIET = { log() {}, warn() {}, error() {} };
const ALREADY = /already known|already in (the )?(mempool|block ?chain)|txn-already|already have|already in (the )?utxo ?set|outputs already/i;
const sha = (data) => createHash("sha256").update(data).digest("hex");
const hashOf = (path) => (existsSync(path) ? sha(readFileSync(path)) : null);
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const int = (n) => Number(n).toLocaleString("en-US");
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- files

/** The relay directory's files for `config` (DEFAULTS plus overrides), resolved against `root`. */
export function relayPaths(root, config = {}) {
  const c = { ...DEFAULTS, ...config };
  const dir = resolvePath(root, c.relayDir);
  return {
    dir,
    pool: join(dir, "pool.key"),
    change: join(dir, "change.key"),
    state: join(dir, "relayer.json"),
    hold: join(dir, RELAY_FILES.hold),
    ack: join(dir, RELAY_FILES.ack),
    tags: join(dir, RELAY_FILES.tags),
    retired: join(dir, RELAY_FILES.retired),
    v1Key: resolvePath(root, c.keyPath),
  };
}

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/** A key file (64 lowercase hex characters) -> its 32 bytes. Never creates one. */
export function readKeyFile(path) {
  if (!existsSync(path)) throw new Error(`no key at ${path}`);
  const text = readFileSync(path, "utf8").trim();
  if (!HEX32.test(text) || !secp256k1.utils.isValidSecretKey(unhex(text))) throw new Error(`${path} must hold a valid key as 64 lowercase hex characters`);
  return unhex(text);
}

/** Secrets (keys, the books keys) are written durably and readable by the owner only. */
const writeSecret = (path, text) => writeDurable(path, text, 0o600);
const writeKey = (path, key) => writeSecret(path, hex(key));

/**
 * Places the HOLD (reason "evacuate" or "maintenance"). An existing HOLD is kept with its nonce;
 * an evacuation upgrades a maintenance HOLD. -> { nonce, created }
 */
export function placeHold(paths, reason) {
  const existing = existsSync(paths.hold) ? readJson(paths.hold) ?? {} : null;
  if (existing) {
    const nonce = typeof existing.nonce === "string" ? existing.nonce : randomBytes(16).toString("hex");
    if ((reason === "evacuate" && existing.reason !== "evacuate") || existing.nonce !== nonce) {
      writeDurable(paths.hold, JSON.stringify({ ...existing, reason: reason === "evacuate" ? "evacuate" : existing.reason ?? "maintenance", nonce }));
    }
    return { nonce, created: false };
  }
  mkdirSync(paths.dir, { recursive: true });
  const nonce = randomBytes(16).toString("hex");
  writeDurable(paths.hold, JSON.stringify({ reason, nonce, at: new Date().toISOString() }));
  return { nonce, created: true };
}

/** The running relayer's HOLD.ack for `nonce`, or null after `waitMs`. */
export async function waitForAck(paths, nonce, { waitMs = DEFAULT_WAIT_SECS * 1000, pollMs = 200, sleep = sleepMs } = {}) {
  const end = Date.now() + waitMs;
  for (;;) {
    const ack = readJson(paths.ack);
    if (ack && ack.nonce === nonce) return ack;
    if (Date.now() >= end) return null;
    await sleep(pollMs);
  }
}

/**
 * Places the HOLD and waits for the running relayer's acknowledgement (it has frozen: saved once and
 * never writes again). No acknowledgement: refused unless the operator says the relayer is stopped
 * (`relayerStopped`), since a relayer that has not frozen would overwrite what the tool writes. The
 * HOLD stays in place either way (a relayer that sees it later freezes and acknowledges it, with
 * the same nonce, which a run of the command again finds). -> the HOLD ({ nonce, created })
 */
export async function holdFor(paths, reason, { waitMs = DEFAULT_WAIT_SECS * 1000, sleep, relayerStopped = false, print = console.log } = {}) {
  const hold = placeHold(paths, reason);
  const ack = await waitForAck(paths, hold.nonce, { waitMs, sleep });
  if (ack) {
    print(`the running relayer froze (pid ${ack.pid}${ack.height != null ? `, height ${ack.height}` : ""})${reason === "evacuate" ? "; its queued items were released" : ""}`);
    return hold;
  }
  if (relayerStopped) {
    print("no running relayer answered; --relayer-stopped: working on the files as they are (a relayer started now starts frozen)");
    return hold;
  }
  throw new Error(
    `no running relayer acknowledged ${RELAY_FILES.hold} within ${Math.round(waitMs / 1000)} s; nothing was signed or sent. ` +
    "The HOLD stays in place: if the relayer runs, run this again once its log says it froze (or with a longer --wait); " +
    "if it is stopped, run this again with --relayer-stopped. Never --relayer-stopped while it runs: a relayer that has not frozen would overwrite what this command writes.",
  );
}

/** Removes HOLD and HOLD.ack: the relayer resumes at its next restart. */
export function releaseHold(paths) {
  rmSync(paths.hold, { force: true });
  rmSync(paths.ack, { force: true });
}

/** The indexer fields a relayer reads, for a relayer opened by an operator tool (no sync). */
function offlineIndex(height) {
  return { height, hashes: new Map(), log: [], nullifiers: new Set(), roots: new Map(), miningActive: () => false, outputs: [] };
}

/**
 * The relayer of `root`'s relay directory, opened from its files for an operator tool: never
 * started, never ticked, at the chain source's tip. With `guard`, every save first checks that the
 * state file is still the one read here (or last written here), so a relayer that was not frozen
 * cannot have written it meanwhile. -> { r, paths }
 */
export async function openRelayer({ root = process.cwd(), config = {}, esplora, log = QUIET, now, guard = true, tool = "the operator tool" } = {}) {
  const c = { ...DEFAULTS, ...config };
  const paths = relayPaths(root, c);
  for (const p of [paths.pool, paths.change, paths.state]) {
    if (!existsSync(p)) throw new Error(`${p} does not exist: is MURKLE_RELAY_DIR (${c.relayDir}) this relayer's directory?`);
  }
  const tip = await esplora.tipHeight();
  if (!Number.isSafeInteger(tip) || tip < 0) throw new Error("the chain source gave no tip height");
  const r = new Relayer({
    idx: offlineIndex(tip), esplora, poolKey: readKeyFile(paths.pool), changeKey: readKeyFile(paths.change), tagKeys: readTagKeys(paths.tags),
    config: { ...c, enabled: true, statePath: paths.state }, log, ...(now ? { now } : {}),
  });
  r.chainTip = tip;
  if (guard) {
    r.saveGuard = {
      expect: hashOf(paths.state),
      before(path) {
        if (hashOf(path) !== this.expect) {
          throw new Error(`${path} changed while ${tool} ran: another process wrote it (a relayer that is not frozen?). Nothing more was signed or sent; stop the relayer and run the command again.`);
        }
      },
      after(path, text) {
        this.expect = sha(Buffer.from(text, "utf8"));
      },
    };
  }
  return { r, paths };
}

// ---------------------------------------------------------------- sweeps

/** A coin of the relayer's own records as a sweep input (its script, internal key and secret). */
function poolInput(r, key) {
  const coin = r.state.coins[key];
  const at = key.lastIndexOf(":");
  const info = r.spendInfo(key, coin);
  return { key, txid: key.slice(0, at), vout: Number(key.slice(at + 1)), value: coin.value, script: info.script, tapInternalKey: info.tapInternalKey, secret: info.secret };
}

/**
 * One signed sweep of `inputs` ([{ key, txid, vout, value, script, tapInternalKey, secret() }]) to
 * `outScript`: one output, inputs in a random order (L5), every input RBF (0xfffffffd), the fee by
 * the one rule (a whole sat/vB rate times the vsize rounded up, the signed size if larger), paid
 * from the swept value. null when the value does not cover the fee plus the output's dust limit.
 */
export function buildSweepTx({ inputs, outScript, rate, random }) {
  if (!Number.isSafeInteger(rate) || rate < 1) throw new Error("a sweep's fee rate is a whole number of sat/vB, at least 1");
  if (!inputs.length) return null;
  const order = shuffled(inputs, random);
  const total = sum(order.map((u) => u.value));
  const dust = Number(dustLimit(outScript));
  const build = (fee) => {
    const tx = new btc.Transaction();
    for (const u of order) {
      tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: u.script, amount: BigInt(u.value) }, tapInternalKey: u.tapInternalKey, sequence: RBF_SEQUENCE });
    }
    tx.addOutput({ script: outScript, amount: BigInt(total - fee) });
    return signInputs(tx, order.map((u) => u.secret()));
  };
  let fee = feeAt(rate, 11 + 9 + outScript.length + 57.5 * order.length);
  if (total - fee < dust) return null;
  let signed = build(fee);
  if (feeAt(rate, signed.vsize) > fee) {
    fee = feeAt(rate, signed.vsize);
    if (total - fee < dust) return null;
    signed = build(fee);
  }
  return { inputs: order.map((u) => u.key), total, fee, feeRate: rate, vsize: signed.vsize, txid: signed.txid, raw: signed.hex, amount: total - fee };
}

/**
 * Broadcast of a sweep: "ok" (accepted, or already known), "contested" (a conflicting transaction is
 * in the mempool, a thief's perhaps: bump above it), "missing" (an input is gone: spent in a block,
 * or its parent left the mempool) or "failed: <text>" (no clear answer: send it again).
 */
export async function broadcastSweep(esplora, raw) {
  try {
    await esplora.broadcast(raw);
    return "ok";
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (ALREADY.test(msg)) return "ok";
    if (/txn-mempool-conflict|rejecting replacement|insufficient fee|replacement/i.test(msg)) return "contested";
    if (/missingorspent|missing-inputs|missing inputs|inputs-missing/i.test(msg)) return "missing";
    return `failed: ${msg.slice(0, 160)}`;
  }
}

/**
 * A mistyped --fee-rate must not burn the pool: sweeps whose fees together take more than
 * MAX_FEE_SHARE of the value they move are refused unless the operator says so (--high-fee).
 */
export function checkFeeShare(plans, { highFee = false, flag = "--fee-rate" } = {}) {
  const fee = sum(plans.map((p) => p.fee));
  const total = sum(plans.map((p) => p.total));
  if (highFee || !total || fee <= MAX_FEE_SHARE * total) return;
  throw new Error(`refused: fees of ${int(fee)} sats would take ${Math.round((100 * fee) / total)}% of the ${int(total)} sats swept (more than ${Math.round(100 * MAX_FEE_SHARE)}%). A typo in ${flag}? Choose a lower rate, or add --high-fee when this is meant (a thief bidding that high). Nothing was signed or sent`);
}

/** The evacuation's fee rate: --fee-rate, else twice the higher of the next-block rate and the relayer's rate, at least 2 sat/vB. */
export async function evacuationRate(r, feeRate = null) {
  if (feeRate !== null && feeRate !== undefined) {
    if (!Number.isSafeInteger(feeRate) || feeRate < 1) throw new Error("--fee-rate must be a whole number of sat/vB, at least 1");
    return feeRate;
  }
  const rates = [];
  for (const read of [() => r.nextBlockRate(), () => r.esplora.feeRate()]) {
    try {
      const v = Number(await read());
      if (Number.isFinite(v) && v > 0) rates.push(v);
    } catch {}
  }
  return Math.max(2, Math.ceil(2 * Math.max(1, ...rates)));
}

/**
 * The two kinds of sweep share one life cycle (journal, send, split, bump, settle); a context says
 * what each step means for its records.
 *   evacuation  pool coins -> the cold address (state.evacuation.sweeps)
 *   retired     deposits to retired addresses -> the current change key C (state.retiredSweeps)
 */
function evacuationContext(r) {
  const ev = r.state.evacuation;
  return {
    kind: "evacuation",
    sweeps: ev.sweeps,
    outScript: () => scriptOf(ev.to),
    input: (key) => poolInput(r, key),
    usable: (key) => r.state.coins[key]?.status === "unspent",
    journal(plan) {
      const paid = r.books.payOperatorCost(plan.fee);
      const mix = unionMix(plan.inputs.map((k) => r.mixOf(k, r.state.coins[k])));
      for (const k of plan.inputs) Object.assign(r.state.coins[k], { status: "spent", spentBy: plan.txid, evacuated: true });
      ev.mix = unionMix([ev.mix ?? [], mix]);
      const seq = r.nextSeq();
      r.state.ledger.push({ seq, kind: "evacuation", txid: plan.txid, vsize: plan.vsize, fee: plan.fee, feeRate: plan.feeRate, broadcastHeight: r.idx.height, height: null, outcome: "pending", reason: null });
      const sweep = { seq, to: ev.to, inputs: plan.inputs, total: plan.total, status: "pending", versions: [version(plan)], fromMargin: paid.fromMargin, owed: paid.owed };
      ev.sweeps.push(sweep);
      return sweep;
    },
    replace(sweep, plan) {
      for (const k of sweep.inputs) if (r.state.coins[k]) r.state.coins[k].spentBy = plan.txid;
    },
    undo(sweep) {
      const last = sweep.versions.at(-1);
      const ids = new Set(sweep.versions.map((v) => v.txid));
      for (const k of sweep.inputs) {
        const c = r.state.coins[k];
        if (c?.status === "spent" && ids.has(c.spentBy)) {
          c.status = "unspent";
          delete c.spentBy;
          delete c.evacuated;
        }
      }
      r.books.refundOperatorCost(last.fee);
    },
    lose(key, why) {
      const c = r.state.coins[key];
      if (c) Object.assign(c, { status: "lost", lost: why });
    },
    confirmed(sweep, v) {
      for (const k of sweep.inputs) if (r.state.coins[k]) r.state.coins[k].spentBy = v.txid;
    },
  };
}

function retiredContext(r, secrets) {
  r.state.retiredSweeps ??= [];
  const recs = () => (r.state.retiredDeposits ??= {});
  const outCoin = (plan, recsOf) => ({
    value: plan.amount, kind: "change", parent: plan.txid, status: "unspent", confirmed: false, depth: 1, root: null,
    mix: unionMix(recsOf.map((rec) => [r.mixTag(rec.account)])), hold: true,
  });
  return {
    kind: "retired",
    sweeps: r.state.retiredSweeps,
    outScript: () => r.change.script,
    input(key) {
      const rec = recs()[key];
      const g = (r.state.retired ?? []).find((x) => x.generation === rec.generation);
      const secret = secrets.get(rec.generation);
      if (!g || !secret) throw new Error(`the retired key of generation ${rec.generation} is not available`);
      const internal = depositKeyOfTweak(unhex(g.pool), rec.tweak);
      const at = key.lastIndexOf(":");
      return {
        key, txid: key.slice(0, at), vout: Number(key.slice(at + 1)), value: rec.value,
        script: btc.p2tr(internal, undefined, btc.TEST_NETWORK).script, tapInternalKey: internal, secret: () => depositSecretOfTweak(secret, rec.tweak),
      };
    },
    usable: (key) => recs()[key]?.status === "waiting",
    journal(plan) {
      const paid = r.books.payOperatorCost(plan.fee);
      const list = plan.inputs.map((k) => recs()[k]);
      r.state.coins[`${plan.txid}:0`] = outCoin(plan, list);
      for (const rec of list) Object.assign(rec, { status: "swept", sweepTxid: plan.txid });
      const seq = r.nextSeq();
      r.state.ledger.push({ seq, kind: "retired-sweep", txid: plan.txid, vsize: plan.vsize, fee: plan.fee, feeRate: plan.feeRate, broadcastHeight: r.idx.height, height: null, outcome: "pending", reason: null });
      const sweep = { seq, inputs: plan.inputs, total: plan.total, status: "pending", versions: [version(plan)], fromMargin: paid.fromMargin, owed: paid.owed };
      r.state.retiredSweeps.push(sweep);
      return sweep;
    },
    replace(sweep, plan) {
      const old = sweep.versions.at(-1);
      delete r.state.coins[`${old.txid}:0`];
      const list = sweep.inputs.map((k) => recs()[k]);
      r.state.coins[`${plan.txid}:0`] = outCoin(plan, list);
      for (const rec of list) rec.sweepTxid = plan.txid;
    },
    undo(sweep) {
      const last = sweep.versions.at(-1);
      for (const v of sweep.versions) delete r.state.coins[`${v.txid}:0`];
      for (const k of sweep.inputs) {
        const rec = recs()[k];
        if (rec?.status === "swept") {
          rec.status = "waiting";
          delete rec.sweepTxid;
        }
      }
      r.books.refundOperatorCost(last.fee);
    },
    lose(key, why) {
      const rec = recs()[key];
      if (rec) Object.assign(rec, { status: "lost", lost: why });
    },
    confirmed(sweep, v, height) {
      const last = sweep.versions.at(-1);
      const list = sweep.inputs.map((k) => recs()[k]);
      if (v.txid !== last.txid) {
        delete r.state.coins[`${last.txid}:0`];
        r.state.coins[`${v.txid}:0`] = outCoin({ txid: v.txid, amount: v.amount }, list);
        for (const rec of list) rec.sweepTxid = v.txid;
      }
      Object.assign(r.state.coins[`${v.txid}:0`] ?? {}, { confirmed: true, depth: 0, height });
    },
  };
}

const version = (plan) => ({ txid: plan.txid, raw: plan.raw, fee: plan.fee, feeRate: plan.feeRate, vsize: plan.vsize, amount: plan.amount });

function ledgerOf(r, sweep) {
  return r.state.ledger.find((l) => l.seq === sweep.seq) ?? null;
}

/** A sweep that never reached a block: its coins come back (or are lost), its fee is refunded. */
function dropSweep(r, ctx, sweep, reason) {
  ctx.undo(sweep);
  sweep.status = "dropped";
  sweep.reason = reason;
  for (const v of sweep.versions) delete v.raw;
  const entry = ledgerOf(r, sweep);
  if (entry) Object.assign(entry, { outcome: "dropped", reason });
}

/**
 * Sends a journaled sweep's newest version. "missing" splits a sweep of several inputs into one
 * sweep per input (so one stolen coin does not hold the others back); a lone input that is missing
 * is recorded as lost. -> the broadcast outcome
 */
async function sendSweep(r, ctx, sweep, print) {
  const v = sweep.versions.at(-1);
  const res = await broadcastSweep(r.esplora, v.raw);
  if (res === "ok") {
    sweep.sent = true;
    delete sweep.contested;
    print(`  sent ${v.txid}: ${int(sweep.total)} sats in ${sweep.inputs.length} coin(s), fee ${int(v.fee)} (${v.feeRate} sat/vB)`);
    return res;
  }
  if (res === "contested") {
    sweep.contested = true;
    print(`  CONTESTED ${v.txid}: a conflicting transaction spends these coins in the mempool (a thief?). Bump now: murkle relayer ${ctx.kind === "retired" ? "sweep-retired" : "evacuate"} --bump --fee-rate <higher than its rate>`);
    return res;
  }
  if (res === "missing") {
    // Any version of this sweep the network knows (an earlier one may have won after a bump whose
    // own broadcast failed): it was sent, and settleSweeps finds the one that confirms.
    let noAnswer = false;
    for (const ver of [...sweep.versions].reverse()) {
      const st = await r.statusOf(ver.txid);
      if (st) {
        sweep.sent = true;
        if (ver !== v) print(`  ${v.txid} was refused: an earlier version of this sweep (${ver.txid}) is on the network`);
        return "ok";
      }
      if (st === undefined) noAnswer = true;
    }
    if (noAnswer) {
      print(`  ${v.txid} was refused (an input is missing) and the explorer did not answer for every version; it stays journaled: run the command again`);
      return "failed: no answer from the explorer";
    }
    const why = "spent by someone else before the sweep, or its parent left the mempool";
    dropSweep(r, ctx, sweep, `an input was missing (${why})`);
    if (sweep.inputs.length === 1) {
      ctx.lose(sweep.inputs[0], why);
      print(`  LOST ${sweep.inputs[0]}: ${why}`);
      r.save();
      return res;
    }
    print(`  ${v.txid} was refused: an input is missing; sweeping its ${sweep.inputs.length} coins one by one`);
    r.save();
    for (const key of sweep.inputs) {
      if (!ctx.usable(key)) continue;
      const plan = buildSweepTx({ inputs: [ctx.input(key)], outScript: ctx.outScript(), rate: v.feeRate });
      if (!plan) {
        print(`  ${key} is too small to sweep on its own at ${v.feeRate} sat/vB; it is left where it is`);
        continue;
      }
      const one = ctx.journal(plan);
      r.save();
      await sendSweep(r, ctx, one, print);
    }
    return res;
  }
  print(`  ${v.txid} not confirmed sent (${res}); it stays journaled: run the command again to send it again`);
  return res;
}

/**
 * Pending sweeps against the chain: a version in a block confirms the sweep (when an earlier, cheaper
 * version won, the difference goes back to the books); none known anywhere and `acceptLost`: lost
 * (its fee refunded, its coins recorded as lost). -> { confirmed, pending, unknown, lost }
 */
async function settleSweeps(r, ctx, { acceptLost = false } = {}) {
  const out = { confirmed: [], pending: [], unknown: [], lost: [] };
  for (const sweep of ctx.sweeps) {
    if (sweep.status !== "pending") continue;
    let found = null;
    let seen = false;
    for (const v of [...sweep.versions].reverse()) {
      const st = await r.statusOf(v.txid);
      if (st?.confirmed) {
        found = { v, height: st.block_height ?? null };
        break;
      }
      if (st) seen = true;
    }
    if (found) {
      const last = sweep.versions.at(-1);
      if (last.fee > found.v.fee) r.books.refundOperatorCost(last.fee - found.v.fee);
      ctx.confirmed(sweep, found.v, found.height);
      Object.assign(sweep, { status: "confirmed", txid: found.v.txid, fee: found.v.fee, height: found.height });
      for (const v of sweep.versions) delete v.raw;
      const entry = ledgerOf(r, sweep);
      if (entry) Object.assign(entry, { txid: found.v.txid, fee: found.v.fee, feeRate: found.v.feeRate, vsize: found.v.vsize, outcome: "accepted", height: found.height });
      out.confirmed.push(sweep);
    } else if (seen) out.pending.push(sweep);
    else if (acceptLost) {
      dropSweep(r, ctx, sweep, "never confirmed: its coins were taken by another transaction");
      for (const k of sweep.inputs) ctx.lose(k, "taken by another transaction before the sweep confirmed");
      out.lost.push(sweep);
    } else out.unknown.push(sweep);
  }
  return out;
}

/** Signs every pending sweep again at a higher rate (RBF); the extra fee is booked like the first. */
async function bumpSweeps(r, ctx, { feeRate = null, dryRun = false, highFee = false, print }) {
  await settleSweeps(r, ctx);
  const pending = ctx.sweeps.filter((s) => s.status === "pending");
  if (!pending.length) throw new Error("nothing to bump: no sweep is waiting for a block");
  const current = await evacuationRate(r, null);
  const plans = [];
  for (const sweep of pending) {
    const last = sweep.versions.at(-1);
    const rate = feeRate ?? Math.max(2 * last.feeRate, current);
    if (!Number.isSafeInteger(rate) || rate <= last.feeRate) throw new Error(`--fee-rate must be above the last rate of ${last.txid} (${last.feeRate} sat/vB)`);
    const plan = buildSweepTx({ inputs: sweep.inputs.map((k) => ctx.input(k)), outScript: ctx.outScript(), rate });
    if (!plan) throw new Error(`${last.txid} cannot pay ${rate} sat/vB: its coins hold ${int(sweep.total)} sats`);
    plans.push({ sweep, last, plan });
    print(`bump ${last.txid} (${last.feeRate} sat/vB, fee ${int(last.fee)}) -> ${plan.txid} (${rate} sat/vB, fee ${int(plan.fee)})`);
  }
  checkFeeShare(plans.map((x) => x.plan), { highFee, flag: feeRate === null ? "the default bump (twice the last rate)" : "--fee-rate" });
  if (dryRun) {
    print("dry run: nothing signed was kept or sent");
    return { status: "dry-run", bumps: plans.map(({ last, plan }) => ({ from: last.txid, txid: plan.txid, fee: plan.fee, feeRate: plan.feeRate, raw: plan.raw })) };
  }
  for (const { sweep, last, plan } of plans) {
    const extra = plan.fee - last.fee;
    if (extra > 0) r.books.payOperatorCost(extra);
    else if (extra < 0) r.books.refundOperatorCost(-extra);
    ctx.replace(sweep, plan);
    sweep.versions.push(version(plan));
    delete sweep.sent;
    const entry = ledgerOf(r, sweep);
    if (entry) Object.assign(entry, { txid: plan.txid, fee: plan.fee, feeRate: plan.feeRate, vsize: plan.vsize, replaces: [...(entry.replaces ?? []), last.txid] });
  }
  r.checkBooks();
  r.save();
  for (const { sweep } of plans) await sendSweep(r, ctx, sweep, print);
  r.save();
  return { status: "bumped", bumps: plans.map(({ last, plan }) => ({ from: last.txid, txid: plan.txid, fee: plan.fee, feeRate: plan.feeRate })) };
}

// ------------------------------------------------------------- evacuation

/**
 * Journaled carriers and housekeeping, before the sweep, by the relayer's own rules (they are the
 * users' paid transactions and the operator's housekeeping, signed before the HOLD):
 * - a carrier the explorer knows reached the network: broadcast, its charge final, its change swept
 *   once it is known;
 * - any other journaled carrier is sent again (Relayer.sendJournaled): accepted, it counts as sent;
 *   refused with its input gone, it is dropped and nothing is charged; one whose earlier answer was
 *   lost stays journaled and charged (I-PAY: never refunded while it may still land) until it is
 *   known or its anchor window closes. Past the window and unknown to the network, it can no longer
 *   count: it keeps its charge (as the relayer does), and its coin, still under the old key, comes
 *   back and is swept (Relayer.dropSent: its fee goes to the margin);
 * - a merge or fan-out is sent again (Relayer.reconcileFanouts); one the network refuses, or one
 *   with no bytes left that the explorer does not know, is dropped (its coins come back and are swept).
 * A dry run sends nothing: it only reads what the explorer knows.
 */
async function settleInFlight(r, notes, { dryRun = false } = {}) {
  for (const item of r.items.filter((i) => i.status === "signing")) {
    const st = await r.statusOf(item.txid);
    if (st) {
      r.markBroadcast(item);
      notes.push(`carrier ${item.txid} is on the network: it keeps its status and its charge`);
      continue;
    }
    if (dryRun) {
      notes.push(`carrier ${item.txid} is journaled and not known to the explorer: the evacuation sends it again first (its coin is not in this plan)`);
      continue;
    }
    const lost = Boolean(item.unknownOutcome);
    const closed = isWindowed(item) && r.idx.height >= r.windowEnd(item);
    await r.sendJournaled(item);
    if (item.status === "signing") {
      notes.push(`carrier ${item.txid} may be on the network (an answer was lost): it stays journaled and charged until it is known or its window closes (block ${r.windowEnd(item)}); run this again then (rotate waits for it)`);
    } else if (item.status === "broadcast" && lost && closed && (await r.statusOf(item.txid)) === null && !Object.values(r.state.coins).some((c) => c.parent === item.txid && c.status !== "unspent")) {
      r.dropSent(item, "its anchor window closed and it never reached the network; its coin was evacuated");
      notes.push(`carrier ${item.txid} never reached the network before its window closed: it keeps its charge, and its coin is swept with the others`);
    } else if (item.status === "broadcast") {
      notes.push(`carrier ${item.txid} was sent again: it keeps its charge; its change is swept`);
    } else {
      notes.push(`carrier ${item.txid} never reached the network: ${item.status}, nothing charged; its coin is swept`);
    }
  }
  if (!dryRun) await r.reconcileFanouts();
  for (const entry of r.state.ledger.filter((l) => (l.kind === "merge" || l.kind === "fanout") && l.outcome === "pending")) {
    const st = await r.statusOf(entry.txid);
    if (st) {
      if (entry.unsent) r.fanoutSent(entry);
      if (st.confirmed) Object.assign(entry, { outcome: "accepted", height: st.block_height ?? null });
    } else if (st === null && (dryRun || !entry.raw)) {
      r.dropHousekeeping(entry, `the ${entry.kind} never reached the network; its coins were evacuated instead`);
    } else {
      notes.push(`the ${entry.kind} ${entry.txid} could not be sent again (no clear answer): it stays pending; run this again`);
    }
  }
  await r.followCoins();
}

/** Whether an item has an anchor window (a claim: ref; any other carrier: anchor). */
const isWindowed = (item) => Number.isSafeInteger(item.ref) || Number.isSafeInteger(item.anchor);

/**
 * Every coin the relayer's own records say it controls (I0: a credited deposit, or change of its own
 * journaled transaction), split into confirmed and unconfirmed (a parent the explorer knows), and the
 * ones that cannot be swept now with the reason. Foreign coins are never in these records.
 */
async function sweepableCoins(r) {
  const out = { confirmed: [], unconfirmed: [], skipped: [] };
  const parents = new Map();
  for (const [key, c] of Object.entries(r.state.coins)) {
    if (c.status !== "unspent") continue;
    const at = key.lastIndexOf(":");
    const u = { key, txid: key.slice(0, at), vout: Number(key.slice(at + 1)), ...c };
    try {
      r.assertProvenance([u]);
    } catch {
      out.skipped.push({ key, value: c.value, why: "not provably the relayer's own coin (I0)" });
      continue;
    }
    if (c.unsent) {
      out.skipped.push({ key, value: c.value, why: "its transaction is journaled but not known to be on the network" });
      continue;
    }
    if (c.kind === "deposit" ? c.confirmed && !c.reorged : c.confirmed) {
      out.confirmed.push(u);
      continue;
    }
    const parent = c.kind === "deposit" ? u.txid : c.parent;
    if (!parents.has(parent)) parents.set(parent, await r.statusOf(parent));
    const st = parents.get(parent);
    if (st?.confirmed) out.confirmed.push(u);
    else if (st) out.unconfirmed.push({ ...u, parent, depth: c.kind === "deposit" ? 1 : Math.max(1, c.depth ?? 1) });
    else out.skipped.push({ key, value: c.value, why: st === null ? "its parent transaction is not on the network" : "the explorer did not answer for its parent" });
  }
  return out;
}

/** Confirmed coins in chunks of MAX_SWEEP_INPUTS; unconfirmed ones grouped so no sweep has more than ANCESTOR_LIMIT unconfirmed ancestors. */
export function groupCoins(confirmed, unconfirmed) {
  const groups = [];
  for (let i = 0; i < confirmed.length; i += MAX_SWEEP_INPUTS) groups.push(confirmed.slice(i, i + MAX_SWEEP_INPUTS));
  let cur = null;
  for (const u of [...unconfirmed].sort((a, b) => a.depth - b.depth)) {
    const extra = cur && !cur.parents.has(u.parent) ? u.depth : 0;
    if (!cur || cur.coins.length >= MAX_SWEEP_INPUTS || cur.ancestors + extra > ANCESTOR_LIMIT) {
      cur = { coins: [], parents: new Set(), ancestors: 0 };
      groups.push(cur.coins);
    }
    if (!cur.parents.has(u.parent)) {
      cur.parents.add(u.parent);
      cur.ancestors += u.depth;
    }
    cur.coins.push(u);
  }
  return groups;
}

/** What the books owe (they never change in an evacuation, apart from its fee). */
export function booksSummary(r) {
  const accounts = [...r.books.accounts.values()];
  return {
    accounts: accounts.length,
    balances: sum(accounts.map((a) => a.balance)),
    reserved: sum(accounts.map((a) => a.reserved)),
    margin: r.books.margin,
    liabilities: r.books.liabilities(),
    poolUnspent: r.poolUnspent(),
    operatorIn: r.books.operator.in,
    operatorOwed: r.books.operator.owed,
  };
}

function coldScript(r, to) {
  if (typeof to !== "string" || !to) throw new Error("--to <cold address> is required: the address the relayer's coins go to");
  let script;
  try {
    script = scriptOf(to);
  } catch {
    throw new Error(`--to ${to} is not a ${NETWORK} Bitcoin address`);
  }
  const retired = (r.state.retired ?? []).flatMap((g) => [g.pool, g.change]).map((pub) => btc.p2tr(unhex(pub), undefined, btc.TEST_NETWORK).script);
  if (equal(script, r.change.script) || equal(script, r.poolScript) || r.isOwnScript(script) || retired.some((x) => equal(script, x))) {
    throw new Error("--to is one of the relayer's own addresses (of these keys or of retired ones): name a cold address whose key never was on this server");
  }
  return script;
}

/**
 * The evacuation itself, on a relayer opened by openRelayer (the CLI has placed the HOLD). Idempotent:
 * a second run sends journaled sweeps again and sweeps whatever is still unswept. Never a dry run's
 * mutation: with `dryRun` the caller passes a frozen relayer (nothing is written) and nothing is sent.
 */
export async function evacuate(r, { to, feeRate = null, dryRun = false, highFee = false, print = console.log } = {}) {
  const outScript = coldScript(r, to);
  const prev = r.state.evacuation?.to;
  if (prev && prev !== to) throw new Error(`this evacuation already sweeps to ${prev}; run it again with --to ${prev}`);
  r.enterEvacuation();
  r.state.evacuation.to = to;
  const ctx = evacuationContext(r);
  const notes = [];
  await settleInFlight(r, notes, { dryRun });
  for (const n of notes) print(`note: ${n}`);
  // Sweeps of an earlier run: those in a block are settled first (the version that won, after a
  // bump), then the ones not known to be on the network are sent again, the same bytes.
  const settled = await settleSweeps(r, ctx);
  for (const sweep of settled.confirmed) print(`  sweep ${sweep.txid} is in block ${sweep.height ?? "?"}`);
  if (!dryRun) {
    for (const sweep of ctx.sweeps.filter((s) => s.status === "pending" && !s.sent)) await sendSweep(r, ctx, sweep, print);
  }
  const rate = await evacuationRate(r, feeRate);
  const coins = await sweepableCoins(r);
  const skipped = [...coins.skipped];
  const plans = [];
  for (const group of groupCoins(coins.confirmed, coins.unconfirmed)) {
    const plan = buildSweepTx({ inputs: group.map((u) => poolInput(r, u.key)), outScript, rate });
    if (plan) plans.push(plan);
    else skipped.push(...group.map((u) => ({ key: u.key, value: u.value, why: `too little to pay its own sweep at ${rate} sat/vB` })));
  }
  checkFeeShare(plans, { highFee });
  const before = booksSummary(r);
  const fee = sum(plans.map((p) => p.fee));
  print(`evacuation to ${to} at ${rate} sat/vB: ${plans.length} sweep(s), ${sum(plans.map((p) => p.inputs.length))} coin(s), ${int(sum(plans.map((p) => p.total)))} sats, fee ${int(fee)} sats`);
  print(`books: ${before.accounts} account(s), balances ${int(before.balances)} + reserved ${int(before.reserved)} sats (unchanged by the evacuation), margin ${int(before.margin)}`);
  for (const s of skipped) print(`not swept: ${s.key} (${int(s.value)} sats): ${s.why}`);
  if (dryRun) {
    for (const p of plans) print(`dry run ${p.txid}: ${p.inputs.length} input(s), ${int(p.total)} sats -> ${int(p.amount)} to ${to}, fee ${int(p.fee)} (${p.vsize} vB)\n${p.raw}`);
    print("dry run: nothing was written or broadcast, and the relayer was not stopped");
    return { status: "dry-run", rate, plans, skipped, notes, books: before };
  }
  const sweeps = plans.map((p) => ctx.journal(p));
  r.checkBooks();
  r.save(); // every sweep (and every settled carrier) is on disk before the first broadcast
  for (const s of sweeps) await sendSweep(r, ctx, s, print);
  r.checkBooks();
  r.save();
  const after = booksSummary(r);
  const paidFee = sum(sweeps.map((s) => s.versions.at(-1).fee));
  print(`fee ${int(paidFee)} sats: ${int(before.margin - after.margin)} from the margin account, ${int(after.operatorOwed - before.operatorOwed)} recorded as the operator's liability (never a user's)`);
  print(`balances ${int(after.balances)} + reserved ${int(after.reserved)} sats: every user's balance is kept in full`);
  print(`next: once the sweep confirms, murkle relayer rotate (bump a slow sweep with: murkle relayer evacuate --bump --fee-rate <n>)`);
  return { status: "evacuated", rate, sweeps, skipped, notes, books: after, fee: paidFee };
}

/** `evacuate --bump`: every sweep still waiting for a block, signed again at a higher rate. */
export async function bumpEvacuation(r, { feeRate = null, dryRun = false, highFee = false, print = console.log } = {}) {
  if (!r.state.evacuation?.sweeps?.length) throw new Error("nothing to bump: no evacuation sweep was made (murkle relayer evacuate --to <cold address>)");
  return bumpSweeps(r, evacuationContext(r), { feeRate, dryRun, highFee, print });
}

/**
 * `evacuate --cancel`: a false alarm, before any coin moved. Only an evacuation none of whose sweeps
 * reached the network (none journaled, or every one dropped) is cancelled: its record goes, the
 * HOLD is lifted and the relayer resumes when restarted. Items it released stay released (nothing
 * was charged for them). An evacuation that moved coins is finished instead (rotate, refund-pool).
 */
export function cancelEvacuation(r, paths, { print = console.log } = {}) {
  const ev = r.state.evacuation;
  if (!ev) throw new Error("no evacuation to cancel; nothing was changed");
  const moved = ev.sweeps.filter((x) => x.status !== "dropped");
  if (moved.length) {
    throw new Error(`${moved.length} sweep(s) of this evacuation moved or may have moved the relayer's coins (${moved.map((x) => x.txid ?? x.versions.at(-1).txid).join(", ")}): it cannot be cancelled. Finish it: murkle relayer rotate, then refund-pool`);
  }
  delete r.state.evacuation;
  r.checkBooks();
  r.save();
  releaseHold(paths);
  print("evacuation cancelled: no coin had moved. HOLD lifted: restart the relayer to resume (the items it released stay released; nothing was charged for them)");
  return { status: "cancelled" };
}

// ----------------------------------------------------------------- rotation

const pubOf = (k) => hex(schnorr.getPublicKey(k));

/** Every key this relay directory (and the retired v1 relayer) ever used, as x-only public keys. */
function usedKeys(r, paths) {
  const used = new Set([r.poolHex, r.changeHex]);
  for (const g of r.state.retired ?? []) {
    used.add(g.pool);
    used.add(g.change);
  }
  if (existsSync(paths.retired)) {
    for (const g of (r.state.retired ?? []).map((x) => join(paths.retired, `g${x.generation}`))) {
      for (const f of ["pool.key", "change.key"]) if (existsSync(join(g, f))) used.add(pubOf(readKeyFile(join(g, f))));
    }
  }
  if (existsSync(paths.v1Key)) used.add(pubOf(readRelayerKey(paths.v1Key)));
  return used;
}

/** Finishes a rotation a crash interrupted after its files were written (the `.next` files). -> whether it did */
export function finishRotation(paths) {
  const next = (p) => `${p}.next`;
  if (!existsSync(next(paths.state))) return false;
  for (const p of [paths.pool, paths.change]) if (existsSync(next(p))) renameSync(next(p), p);
  renameSync(next(paths.state), paths.state);
  return true;
}

/**
 * `murkle relayer rotate`: after an evacuation whose sweeps are all settled. New pool and change keys
 * (refused if either was ever used here, or is the retired v1 key), the books carried over unchanged
 * under them, the old keys and state kept in retired/g<N>/, the old pool key published as retired,
 * and the relayer refusing sends and credits (pool_unfunded) until refund-pool. HOLD stays in place.
 */
export async function rotate({ root = process.cwd(), config = {}, esplora, acceptLost = false, newKey = () => new Uint8Array(randomBytes(32)), print = console.log, log } = {}) {
  const paths = relayPaths(root, config);
  if (finishRotation(paths)) {
    print("finished a rotation that was interrupted after its files were written");
    return { status: "finished" };
  }
  if (!existsSync(paths.hold)) throw new Error(`no ${RELAY_FILES.hold} in ${paths.dir}: rotate runs after murkle relayer evacuate, which freezes the relayer`);
  const { r } = await openRelayer({ root, config, esplora, log, tool: "murkle relayer rotate" });
  const ev = r.state.evacuation;
  if (!ev) throw new Error("nothing was evacuated from these keys: run murkle relayer evacuate --to <cold address> first");
  if (r.items.some((i) => i.status === "queued" || i.status === "signing")) {
    const ends = r.items.filter((i) => i.status === "signing" && isWindowed(i)).map((i) => r.windowEnd(i));
    throw new Error(`a carrier is still journaled or queued: run murkle relayer evacuate again to settle it${ends.length ? ` (one whose broadcast answer was lost is settled once its window closes, at block ${Math.max(...ends)})` : ""}`);
  }
  if (r.state.ledger.some((l) => (l.kind === "merge" || l.kind === "fanout") && l.outcome === "pending")) throw new Error("a merge or fan-out is still pending: run murkle relayer evacuate again to settle it");
  const ctx = evacuationContext(r);
  const s = await settleSweeps(r, ctx, { acceptLost });
  if (s.pending.length) throw new Error(`${s.pending.length} sweep(s) are not confirmed yet (${s.pending.map((x) => x.versions.at(-1).txid).join(", ")}): wait for a block, or bump: murkle relayer evacuate --bump`);
  if (s.unknown.length) {
    r.save();
    throw new Error(`${s.unknown.length} sweep(s) are not on the network (${s.unknown.map((x) => x.versions.at(-1).txid).join(", ")}): run murkle relayer evacuate again to send them, or rotate with --accept-lost if their coins were taken`);
  }
  // Deposits to addresses of earlier generations that sweep-retired moved into these keys' pool:
  // their sweep must be settled, and each one in a block is credited now (its coin went to the cold
  // address with the rest, so the refill of the new pool covers it; rotate never forgets a deposit).
  const rs = await settleSweeps(r, retiredContext(r, new Map()), { acceptLost });
  for (const sweep of rs.lost) print(`lost: ${sweep.inputs.join(", ")} (deposits to retired addresses taken before their sweep confirmed; not credited)`);
  if (rs.pending.length || rs.unknown.length) {
    r.save();
    const ids = [...rs.pending, ...rs.unknown].map((x) => x.versions.at(-1).txid).join(", ");
    throw new Error(`a sweep of deposits to retired addresses is not in a block yet (${ids}): wait for a block, or bump it (murkle relayer sweep-retired --bump); rotate with --accept-lost if its coins were taken`);
  }
  await r.followCoins();
  const lateCredits = r.creditRetired({ force: true });
  if (lateCredits) print(`credited ${lateCredits} deposit(s) to retired addresses whose sweep confirmed`);
  const left = Object.entries(r.state.coins).filter(([, c]) => c.status === "unspent");
  if (left.length && !acceptLost) {
    r.save();
    throw new Error(`${left.length} coin(s) were not swept (${left.map(([k]) => k).join(", ")}): run murkle relayer evacuate again, or rotate with --accept-lost to leave them`);
  }
  for (const [, c] of left) Object.assign(c, { status: "lost", lost: "left under the retired keys at the rotation" });

  // New keys, never one used before (nor its negation: the x-only keys are compared).
  const used = usedKeys(r, paths);
  const fresh = (what) => {
    const k = newKey();
    if (!(k instanceof Uint8Array) || k.length !== 32 || !secp256k1.utils.isValidSecretKey(k)) throw new Error(`the new ${what} key is not a valid key`);
    const pub = pubOf(k);
    if (used.has(pub)) throw new Error(`refusing to rotate: the new ${what} key was used before by this relayer; nothing was changed`);
    used.add(pub);
    return k;
  };
  const pool = fresh("pool");
  const change = fresh("change");
  const gen = (r.state.generation ?? 0) + 1;
  const old = { generation: gen - 1, pool: r.poolHex, change: r.changeHex, at: r.idx.height };

  // 1. The retired generation: its keys (for late deposits) and its last state, never overwritten.
  const gdir = join(paths.retired, `g${old.generation}`);
  mkdirSync(gdir, { recursive: true });
  for (const [name, key] of [["pool.key", r.poolSecret], ["change.key", r.changeSecret]]) {
    const p = join(gdir, name);
    if (existsSync(p)) {
      if (readFileSync(p, "utf8").trim() !== hex(key)) throw new Error(`${p} exists and holds another key; nothing was changed`);
    } else writeKey(p, key);
  }
  r.save(); // the settled sweeps, in the state that is retired with these keys
  writeDurable(join(gdir, "relayer.json"), readFileSync(paths.state, "utf8"));
  // 2. The books and lineage keys stay those of the first pool key: every account keeps its stored key.
  if (!existsSync(paths.tags)) writeSecret(paths.tags, JSON.stringify({ account: hex(r.accountKeyKey), mix: hex(r.mixKey) }));
  // 3. The new state: the same books under the new keys; no coin (the pool is refilled by refund-pool).
  const books = r.books.rekeyed({ poolKey: pubOf(pool), changeKey: pubOf(change) });
  const items = {};
  for (const id of Object.keys(r.state.items).sort()) items[id] = persistedItem(r.state.items[id]);
  const sweeps = ev.sweeps.map((x) => ({ txid: x.txid ?? x.versions.at(-1).txid, fee: x.fee ?? x.versions.at(-1).fee, total: x.total, status: x.status, height: x.height ?? null }));
  const state = {
    version: STATE_VERSION, network: NETWORK, keys: { pool: pubOf(pool), change: pubOf(change) },
    books: books.toJSON(), coins: {}, items, ledger: r.state.ledger,
    lastReconciled: r.state.lastReconciled, lastReconciledHash: r.state.lastReconciledHash ?? null, lastFlushHeight: r.state.lastFlushHeight, halted: null,
    ownScripts: [...r.ownScripts].sort(), accountsKeyed: true,
    generation: gen,
    retired: [...(r.state.retired ?? []), old],
    retiredDeposits: r.state.retiredDeposits ?? {},
    retiredSweeps: r.state.retiredSweeps ?? [],
    refunds: [],
    rotation: { generation: gen, at: r.idx.height, funded: false, mix: ev.mix ?? [], evacuatedTo: ev.to },
    rotations: [...(r.state.rotations ?? []), { generation: old.generation, pool: old.pool, at: r.idx.height, to: ev.to, sweeps }],
  };
  // 4. Written next to the old files first, then renamed into place (finishRotation completes a crash).
  writeKey(`${paths.pool}.next`, pool);
  writeKey(`${paths.change}.next`, change);
  writeDurable(`${paths.state}.next`, JSON.stringify(state));
  finishRotation(paths);
  const need = books.liabilities();
  const address = btcAccount(change).address;
  print(`rotated to generation ${gen}: new pool key ${pubOf(pool)}, new change address ${address}`);
  print(`retired generation ${old.generation} (pool key ${old.pool}): its keys are in ${gdir}; wallets stop showing its deposit addresses`);
  print(`every balance carried over: ${books.accounts.size} account(s); the new pool must hold ${int(need)} sats (balances, reservations and margin)`);
  print(`next: restart the relayer (it starts frozen and publishes the new pool key), then refill the pool: murkle relayer refund-pool --from <cold key file> (or pay ${int(need)} sats to ${address} and run refund-pool --outpoint <txid:vout>)`);
  return { status: "rotated", generation: gen, poolKey: pubOf(pool), changeKey: pubOf(change), address, need, retiredDir: gdir };
}

// ------------------------------------------------------------- refund-pool

/**
 * What the operator still has to pay into the pool (sats; 0 or less: nothing): the books' liabilities
 * plus the deposits to retired addresses swept but not credited yet (each is credited at its full
 * value), less what the pool holds in a block and what those sweeps bring once they confirm.
 */
export function poolShortfall(r) {
  const late = r.retiredOutstanding();
  return r.books.liabilities() + late.value - late.incoming - r.poolUnspent();
}

/**
 * `murkle relayer refund-pool`: the operator refills the pool of a rotated relayer from the cold
 * wallet: a payment to the current change key C (`fromKey`: built, signed and broadcast here from
 * the cold key's coins; `outpoint`: a payment made by hand, checked on the chain). The coin is
 * recorded as pool money with the lineage of the evacuated coins (refund it from the sweep's own
 * output) and counts only once it is in a block (poolUnspent): a refill that is replaced or evicted
 * never makes I2 hold. Run it again with the same --outpoint once it confirms. Once the pool covers
 * every balance, reservation, the margin and every swept deposit to a retired address, what the
 * operator owed is paid, the pool of this generation is funded, the HOLD is lifted and the relayer
 * resumes when restarted.
 *
 * After the first refill it serves every later operator liability too (a sweep of retired deposits
 * whose fee the margin could not pay: those deposits wait for it). Then no evacuation HOLD is in
 * place, so it freezes the running relayer with a maintenance HOLD first (acknowledged, or
 * `relayerStopped`) and lifts it at the end.
 */
export async function refundPool({
  root = process.cwd(), config = {}, esplora, fromKey = null, outpoint = null, amount = null, feeRate = null, dryRun = false,
  relayerStopped = false, waitMs, sleep, print = console.log, log,
} = {}) {
  if (Boolean(fromKey) === Boolean(outpoint)) throw new Error("refund-pool takes --from <cold key file> or --outpoint <txid:vout>, one of them");
  const paths = relayPaths(root, config);
  const hold = !dryRun && !existsSync(paths.hold) ? await holdFor(paths, "maintenance", { waitMs, sleep, relayerStopped, print }) : null;
  try {
    return await refill({ root, config, esplora, paths, fromKey, outpoint, amount, feeRate, dryRun, print, log });
  } finally {
    if (hold?.created && existsSync(paths.hold)) {
      releaseHold(paths);
      print("HOLD lifted: restart the relayer to resume (a relayer frozen by it stays frozen until then)");
    }
  }
}

async function refill({ root, config, esplora, paths, fromKey, outpoint, amount, feeRate, dryRun, print, log }) {
  const { r } = await openRelayer({ root, config, esplora, log, guard: !dryRun, tool: "murkle relayer refund-pool" });
  if (dryRun) r.frozen = true;
  const rot = r.state.rotation;
  if (!rot) throw new Error("refund-pool refills a pool after a rotation (murkle relayer rotate); these keys were never rotated in");
  await r.followCoins();
  r.settleOwnEntries();
  r.creditRetired();
  const report = () => {
    const need = poolShortfall(r);
    print(`the pool holds ${int(r.poolUnspent())} sats in a block and must hold ${int(r.poolUnspent() + need)}: ${int(Math.max(0, need))} sats short${r.books.operator.owed ? ` (the operator owes ${int(r.books.operator.owed)})` : ""}`);
    return need;
  };
  const covered = () => poolShortfall(r) <= 0 && r.books.checkI2({ poolUnspent: r.poolUnspent() }).ok;
  const funded = () => {
    r.creditRetired(); // deposits to retired addresses that waited for this refill
    const owed = r.books.operatorPaid();
    rot.funded = true;
    rot.fundedAt ??= r.idx.height;
    r.checkBooks();
    r.save();
    if (existsSync(paths.hold)) releaseHold(paths);
    print(`the books add up again (I2)${owed ? `; the operator's liability of ${int(owed)} sats is paid` : ""}`);
    print("HOLD lifted: restart the relayer to resume");
    return owed;
  };
  const pendingRefill = Object.entries(r.state.coins).find(([, c]) => c.refund && c.status === "unspent" && !c.confirmed);
  const need = report();
  if (covered()) {
    if (dryRun) return { status: "dry-run", need };
    if (rot.funded && !r.books.operator.owed) {
      print("the pool covers the books: nothing to refill");
      r.checkBooks();
      r.save();
      return { status: "nothing", need };
    }
    return { status: "funded", owed: funded() };
  }
  let txid;
  let vout;
  let value;
  let st = null;
  if (outpoint) {
    let op;
    try {
      op = parseOutpoint(outpoint);
    } catch {
      throw new Error("--outpoint must be a 64-character lowercase txid, a colon and the output number");
    }
    if ((r.state.refunds ?? []).some((x) => x.txid === op.txid && x.vout === op.vout)) {
      // Recorded by an earlier run and not in a block yet (else the pool would cover the books now).
      const coin = r.state.coins[op.key];
      if (!dryRun) r.save();
      print(coin && !coin.confirmed
        ? `${op.key} is recorded already and waits for a block: it counts once it confirms; run this again then`
        : `${op.key} is recorded already; the pool is still ${int(need)} sats short: refill the rest with another payment`);
      return { status: coin && !coin.confirmed ? "unconfirmed" : "short", txid: op.txid, vout: op.vout, need };
    }
    if (r.state.coins[op.key] || r.ownTxids().has(op.txid)) {
      throw new Error(`${op.key} is an output of the relayer's own records (a sweep or a transaction of its own): a refill is a new payment from the cold wallet`);
    }
    const tx = parseRawTx(await esplora.rawTx(op.txid), op.txid);
    const out = tx.outputs[op.vout];
    if (!out || !equal(out.script, r.change.script)) throw new Error(`${op.key} does not pay the pool's change address ${r.address}`);
    st = await r.statusOf(op.txid);
    if (!st) throw new Error(`${op.txid} is not on the network`);
    ({ txid, vout } = op);
    value = Number(out.value);
  } else {
    if (pendingRefill) {
      throw new Error(`the refill ${pendingRefill[0]} is waiting for a block: run murkle relayer refund-pool --outpoint ${pendingRefill[0]} once it confirms (paying again now would pay twice)`);
    }
    const key = fromKey instanceof Uint8Array ? fromKey : readKeyFile(fromKey);
    const account = btcAccount(key);
    if (account.address === r.address) throw new Error("--from is the pool's own key");
    const want = amount ?? need;
    if (!Number.isSafeInteger(want) || want < Math.max(need, 1)) throw new Error(`--amount must cover the shortfall of ${int(need)} sats`);
    const utxos = await esplora.utxos(account.address);
    const rate = await evacuationRate(r, feeRate);
    const plan = planPayment({ account, utxos, to: r.change.script, amount: want, feeRate: rate });
    const signed = signLocal(plan.tx, key);
    print(`refund ${int(want)} sats from ${account.address} to ${r.address}: fee ${int(Number(plan.fee))} sats (${rate} sat/vB), paid by the cold wallet`);
    if (dryRun) {
      print(`dry run, nothing broadcast or written: ${signed.txid}\n${signed.hex}`);
      return { status: "dry-run", txid: signed.txid, raw: signed.hex, amount: want, need };
    }
    await esplora.broadcast(signed.hex);
    ({ txid } = signed);
    vout = plan.paymentIndex;
    value = want;
    st = { confirmed: false };
  }
  if (dryRun) {
    print(`dry run: ${txid}:${vout} would be recorded (${int(value)} sats)`);
    return { status: "dry-run", txid, vout, value, need };
  }
  r.state.refunds = [...(r.state.refunds ?? []), { txid, vout, value, at: r.idx.height }];
  // Public, like every transaction the relayer's coins come from; its fee was the cold wallet's (0 here).
  r.state.ledger.push({
    seq: r.nextSeq(), kind: "refund", txid, vsize: null, fee: 0, feeRate: null, broadcastHeight: r.idx.height,
    height: st?.confirmed ? st.block_height ?? null : null, outcome: st?.confirmed ? "accepted" : "pending", reason: null,
  });
  r.state.coins[`${txid}:${vout}`] = {
    value, kind: "change", parent: txid, status: "unspent", confirmed: Boolean(st?.confirmed), depth: st?.confirmed ? 0 : 1, root: null,
    mix: rot.mix ?? [], refund: true, hold: true, ...(st?.confirmed ? { height: st.block_height ?? null } : {}),
  };
  if (!st?.confirmed) {
    r.save();
    print(`recorded ${txid}:${vout} (${int(value)} sats): it counts once it is in a block. Then run: murkle relayer refund-pool --outpoint ${txid}:${vout}`);
    return { status: "unconfirmed", txid, vout, value, need };
  }
  if (!covered()) {
    r.save();
    const left = report();
    print(`recorded ${txid}:${vout} (${int(value)} sats); still ${int(left)} sats short`);
    return { status: "short", txid, vout, value, need: left };
  }
  print(`recorded ${txid}:${vout} (${int(value)} sats)`);
  return { status: "funded", txid, vout, value, owed: funded() };
}

// ----------------------------------------------------------- sweep-retired

/** The secret keys of the retired generations that `records` need, checked against the state. */
function retiredSecrets(r, paths, records) {
  const out = new Map();
  for (const rec of records) {
    if (out.has(rec.generation)) continue;
    const g = (r.state.retired ?? []).find((x) => x.generation === rec.generation);
    if (!g) throw new Error(`no retired generation ${rec.generation} in the state`);
    const key = readKeyFile(join(paths.retired, `g${g.generation}`, "pool.key"));
    if (pubOf(key) !== g.pool) throw new Error(`retired/g${g.generation}/pool.key does not belong to that generation`);
    out.set(rec.generation, key);
  }
  return out;
}

/**
 * `murkle relayer sweep-retired`: deposits that paid a retired deposit address after a rotation (the
 * relayer recorded them, 409 deposit_retired) are swept with the retired key into the current pool
 * (change key C) at a high rate, RBF. The sweep's fee is an operator cost (margin first, the rest a
 * liability). Each deposit is credited (value − sweepCost, as any deposit) once its sweep confirms
 * and the pool covers it: a fee the margin could not pay waits for refund-pool, so I2 never fails
 * for it. One a thief took first is recorded as lost and is not credited. Runs on a frozen or
 * stopped relayer: it places a maintenance HOLD when none is in place (acknowledged by the running
 * relayer, or `relayerStopped`) and lifts it at the end. During an evacuation (C itself may be in
 * someone else's hands) it sends, settles and bumps its earlier sweeps, but starts no new one.
 */
export async function sweepRetired({
  root = process.cwd(), config = {}, esplora, feeRate = null, dryRun = false, bump = false, acceptLost = false, highFee = false,
  relayerStopped = false, waitMs, sleep, print = console.log, log,
} = {}) {
  const paths = relayPaths(root, config);
  const hold = dryRun ? null : await holdFor(paths, "maintenance", { waitMs, sleep, relayerStopped, print });
  try {
    const { r } = await openRelayer({ root, config, esplora, log, guard: !dryRun, tool: "murkle relayer sweep-retired" });
    if (dryRun) r.frozen = true;
    const recs = r.state.retiredDeposits ?? {};
    const needed = Object.values(recs).filter((x) => x.status === "waiting" || x.status === "swept");
    const ctx = retiredContext(r, retiredSecrets(r, paths, needed));
    await r.followCoins();
    const settled = await settleSweeps(r, ctx, { acceptLost });
    for (const sweep of settled.lost) print(`lost: ${sweep.inputs.join(", ")} (taken before the sweep confirmed; not credited)`);
    await r.followCoins();
    const credited = r.creditRetired();
    if (credited) print(`credited ${credited} deposit(s) whose sweep confirmed`);
    const short = Object.values(recs).filter((x) => x.status === "swept" && x.short);
    if (short.length) print(`${short.length} swept deposit(s) wait for the pool to cover them (${int(Math.max(0, poolShortfall(r)))} sats short): murkle relayer refund-pool --from <cold key file> | --outpoint <txid:vout>`);
    if (bump) return await bumpSweeps(r, ctx, { feeRate, dryRun, highFee, print });
    if (!dryRun) for (const sweep of ctx.sweeps.filter((s) => s.status === "pending" && !s.sent)) await sendSweep(r, ctx, sweep, print);
    const waiting = Object.keys(recs).filter((k) => recs[k].status === "waiting");
    if (waiting.length && r.state.evacuation) {
      print(`${waiting.length} deposit(s) to retired addresses wait: they are swept after the rotation (the relayer is evacuating; its change key may not be its own any more)`);
    }
    if (!waiting.length || r.state.evacuation) {
      if (!waiting.length) print("no deposit to a retired address waits for a sweep");
      if (!dryRun) {
        r.checkBooks();
        r.save();
      }
      return { status: "nothing", credited };
    }
    const rate = await evacuationRate(r, feeRate);
    const plan = buildSweepTx({ inputs: waiting.slice(0, MAX_SWEEP_INPUTS).map((k) => ctx.input(k)), outScript: ctx.outScript(), rate });
    if (!plan) throw new Error(`the ${waiting.length} deposit(s) hold too little to pay their sweep at ${rate} sat/vB`);
    checkFeeShare([plan], { highFee });
    print(`sweep ${plan.inputs.length} deposit(s) of retired addresses, ${int(plan.total)} sats, into the pool (${r.address}) at ${rate} sat/vB: fee ${int(plan.fee)} sats (an operator cost)`);
    if (dryRun) {
      print(`dry run, nothing written or broadcast: ${plan.txid}\n${plan.raw}`);
      return { status: "dry-run", plan, credited };
    }
    const sweep = ctx.journal(plan);
    r.checkBooks();
    r.save();
    await sendSweep(r, ctx, sweep, print);
    r.save();
    if (sweep.owed) {
      print(`the margin paid ${int(sweep.fromMargin)} sats of the fee; ${int(sweep.owed)} sats are the operator's liability. These deposits are credited once their sweep confirms AND the pool covers them: refill it with murkle relayer refund-pool --from <cold key file> | --outpoint <txid:vout> (no user's send is refused meanwhile)`);
    } else print("each deposit is credited once this sweep confirms (the relayer does it at its next tick, or run sweep-retired again)");
    return { status: "swept", sweep, credited };
  } finally {
    if (hold?.created) {
      releaseHold(paths);
      print("HOLD lifted: restart the relayer to resume (a relayer frozen by it stays frozen until then)");
    }
  }
}

// ----------------------------------------------------------------- CLI glue

/**
 * `murkle relayer evacuate`: places the HOLD (a running relayer freezes within a second: no new
 * sends or credits, queued items released), waits up to `waitMs` for its acknowledgement (refused
 * without one, unless `relayerStopped`), then evacuates from the files. `dryRun`: no HOLD, nothing
 * written or broadcast. `bump` and `cancel` first check, read only, that there is something to bump
 * or cancel, so a stray one never freezes a relayer that is not evacuating.
 */
export async function runEvacuate({
  root = process.cwd(), config = {}, esplora, to = null, feeRate = null, dryRun = false, bump = false, cancel = false, highFee = false,
  relayerStopped = false, waitMs, sleep, print = console.log, log,
} = {}) {
  if (dryRun) {
    const { r } = await openRelayer({ root, config, esplora, log, guard: false });
    r.frozen = true; // a dry run writes nothing
    return bump ? bumpEvacuation(r, { feeRate, dryRun, highFee, print }) : evacuate(r, { to, feeRate, dryRun, highFee, print });
  }
  const paths = relayPaths(root, config);
  if (!bump && !cancel) coldCheckEarly(to);
  for (const p of [paths.pool, paths.change, paths.state]) {
    if (!existsSync(p)) throw new Error(`${p} does not exist: is MURKLE_RELAY_DIR this relayer's directory? Nothing was changed`);
  }
  if (bump || cancel) {
    const { r } = await openRelayer({ root, config, esplora, log, guard: false });
    r.frozen = true;
    const ev = r.state.evacuation;
    if (cancel && !ev) throw new Error("no evacuation to cancel; nothing was changed");
    if (bump && !ev?.sweeps?.some((s) => s.status === "pending")) {
      throw new Error("nothing to bump: no evacuation sweep is waiting for a block (murkle relayer evacuate --to <cold address> starts one). Nothing was changed");
    }
  }
  const had = existsSync(paths.hold);
  await holdFor(paths, "evacuate", { waitMs, sleep, relayerStopped, print });
  if (!had) print(`${RELAY_FILES.hold} placed in ${paths.dir}: the relayer takes no sends or top-ups from now on`);
  const { r } = await openRelayer({ root, config, esplora, log, tool: "murkle relayer evacuate" });
  if (cancel) return cancelEvacuation(r, paths, { print });
  return bump ? bumpEvacuation(r, { feeRate, highFee, print }) : evacuate(r, { to, feeRate, highFee, print });
}

function coldCheckEarly(to) {
  if (typeof to !== "string" || !to) throw new Error("--to <cold address> is required: the address the relayer's coins go to");
  try {
    scriptOf(to);
  } catch {
    throw new Error(`--to ${to} is not a ${NETWORK} Bitcoin address`);
  }
}

/** `murkle relayer status`: the hold, the generation, the evacuation, the rotation and the books, read only. */
export async function relayerStatus({ root = process.cwd(), config = {}, esplora, print = console.log, log } = {}) {
  const paths = relayPaths(root, config);
  const { r } = await openRelayer({ root, config, esplora, log, guard: false });
  r.frozen = true;
  const hold = existsSync(paths.hold) ? readJson(paths.hold) : null;
  const ack = existsSync(paths.ack) ? readJson(paths.ack) : null;
  const b = booksSummary(r);
  const ev = r.state.evacuation;
  const out = {
    generation: r.state.generation ?? 0, poolKey: r.poolHex, address: r.address, hold: hold ? { reason: hold.reason ?? null, acknowledged: Boolean(ack && ack.nonce === hold.nonce) } : null,
    stop: r.stopCode(), evacuation: ev ? { to: ev.to ?? null, sweeps: ev.sweeps.map((s) => ({ txid: s.versions.at(-1).txid, status: s.status, fee: s.versions.at(-1).fee, feeRate: s.versions.at(-1).feeRate, contested: Boolean(s.contested) })) } : null,
    rotation: r.state.rotation ?? null, retired: (r.state.retired ?? []).map((g) => g.pool),
    retiredDeposits: Object.values(r.state.retiredDeposits ?? {}).reduce((m, x) => ({ ...m, [x.status]: (m[x.status] ?? 0) + 1 }), {}),
    books: b, shortfall: Math.max(0, poolShortfall(r)),
  };
  print(JSON.stringify(out, (k, v) => (k === "mix" ? undefined : v), 2));
  return out;
}

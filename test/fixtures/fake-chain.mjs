// A fake chain for the miner tests (test/mine-cli.test.mjs, test/gpu-lane.test.mjs): a mined token DIG, an indexer
// view of it, a Bitcoin backend, a wallet and a worker pool, all fake, plus the contract stub of src/mine.mjs.
import { randomBytes } from "node:crypto";
import * as btc from "@scure/btc-signer";
import { sha256 } from "@noble/hashes/sha256";
import { concat, hex, unhex } from "../../src/bytes.mjs";
import { btcAccount } from "../../src/btc/funding.mjs";
import { capRisk, capWarningText } from "../../src/mine.mjs";

export const te = new TextEncoder();
export const sha = (x) => sha256(typeof x === "string" ? te.encode(x) : x);

export const DEFAULTS = Object.freeze({
  span: 24, perBlock: 1, launchHashrate: 2000, floorDivisor: 16, browserThreadHs: 250, lowFloorRatio: 1000, halvingInterval: 0, claimFeeSats: 0n, start: "now", startAfter: 144,
});

/**
 * The parts of src/mine.mjs the CLI calls, as mining-contract.md §3 specifies them. The hash is a
 * stand-in (sha256, not Argon2): these tests check the CLI's flow, the vectors are the core track's.
 */
export function stubLib(over = {}) {
  const lib = {
    LAUNCH_DEFAULTS: DEFAULTS,
    suggestInitialDifficulty: ({ hashrate, span, targetPerSpan }) => {
      const d = BigInt(Math.floor((hashrate * 600 * span) / targetPerSpan));
      return d < 256n ? 256n : d;
    },
    suggestFloor: (d) => (d / 16n < 256n ? 256n : d / 16n),
    checkFeePolicy(claimFeeSats, treasury, fee) {
      if (fee.deployerMinSats > 0n) return claimFeeSats < fee.deployerMinSats || claimFeeSats > fee.deployerMaxSats ? `malformed: claim fee ${claimFeeSats} outside ${fee.deployerMinSats}..${fee.deployerMaxSats}` : null;
      if (claimFeeSats === 0n) return null;
      if (fee.deployerMaxSats === 0n) return "malformed: deployer claim fee not allowed";
      if (claimFeeSats < 546n) return "malformed: claim fee below 546 sats";
      return claimFeeSats > fee.deployerMaxSats ? `malformed: claim fee ${claimFeeSats} outside 0..${fee.deployerMaxSats}` : null;
    },
    mineStartOf: (a) => Math.max(a.startHeight ?? 0, a.deployHeight),
    startHeightFor: ({ start, after, tip }) => (start === "now" ? 0 : tip + 1 + after),
    challengeOf: ({ asset, refHeight, refHash, reward, commitments }) => sha(JSON.stringify([String(asset), refHeight, refHash, String(reward), commitments.map(String)])),
    passwordOf: (challenge, nonce) => concat(challenge, nonce),
    powHashReference: (password) => sha(concat(te.encode("pow"), password)),
    solutionIdOf: (challenge, nonce) => sha(concat(challenge, nonce)),
    targetOf: (d) => ((1n << 256n) - 1n) / BigInt(d),
    meetsTarget: () => true,
    effectiveDifficulty: () => 1000n,
    difficultyAt: () => 1000n,
    rewardAt: (asset) => asset.reward,
    mineStatus: (asset, tip) => (tip < asset.mineStart ? "mining-soon" : asset.issued + asset.reward > asset.maxSupply ? "mined-out" : "mining"),
    requiredFeeOutputs: (asset, fee) => [{ script: unhex(fee.platformScript), sats: fee.platformSats, role: "platform" }],
    capRisk,
    capWarningText,
    disabled: null,
    disableFastPath(reason) {
      lib.disabled = reason;
    },
  };
  return Object.assign(lib, over);
}

export const hashOf = (h) => hex(sha(`block ${h}`));
export const coin = (value, i = 0) => ({ txid: randomBytes(32).toString("hex"), vout: i, value, status: { confirmed: true } });

/**
 * A chain, an indexer view of it, a Bitcoin backend, a wallet and a worker pool, all fake, around one
 * mined token DIG. Claims broadcast (self-pay) or carried by the relayer land in the next block the
 * fake indexer applies. `onGrind(call)` runs before each slice (it may move the tip).
 */
export function fakeChain({ tip = 1000, reward = 50n, maxSupply = 10_000n, issued = 0n, mineStart = 990, findOn = 2, lib = stubLib(), onGrind = () => {}, pendingClaims = null } = {}) {
  const asset = {
    id: (846n << 32n) | 3n, kind: "pow", ticker: "DIG", reward, maxSupply, issued, claims: 0, mineStart, deployHeight: 846, startHeight: 0, endHeight: 0, claimsByHeight: [],
    span: 24, targetPerSpan: 24, minDifficulty: 256n, initialDifficulty: 256n, halvingInterval: 0, dPts: [[mineStart, 256n]],
  };
  const events = [];
  const chain = { tip, mempool: [] };
  const byTxid = new Map(); // carrier txid -> the claim's draft and nonce (from the local check)
  const idx = {
    height: tip, hashes: new Map(), assets: new Map([[asset.id, asset]]), tickers: new Map([["DIG", asset.id]]), claimed: new Set(), nullifiers: new Set(), log: [], outputs: [],
    miningHeight: 900,
    miningActive: (h) => h >= 900,
    checks: [],
    async checkMine(env, tx, H) {
      idx.checks.push({ env, tx, H });
      byTxid.set(tx.txid, env);
      return true;
    },
    mineStatic: (env, H) => (idx.checks.push({ env, H, part: "static" }), true),
    mineState: () => true,
    minePow: async () => true,
    mineProof: async () => true,
  };
  for (let h = tip - 30; h <= tip; h++) idx.hashes.set(h, hashOf(h));
  const land = (h) => {
    for (const c of chain.mempool) {
      idx.log.push({ txid: c.txid, ok: true, height: h, op: c.op, ticker: "DIG", amount: String(asset.reward) });
      idx.claimed.add(c.solutionId);
      asset.issued += asset.reward;
      asset.claims += 1;
      for (const n of c.spends ?? []) idx.nullifiers.add(n);
    }
    chain.mempool = [];
  };
  const resync = async () => {
    events.push(`resync ${chain.tip}`);
    while (idx.height < chain.tip) {
      idx.height += 1;
      idx.hashes.set(idx.height, hashOf(idx.height));
      land(idx.height);
    }
  };

  const mineKey = randomBytes(32);
  const account = btcAccount(mineKey);
  let utxos = [coin(40_000, 0), coin(9_000, 1)];
  const esplora = {
    broadcasts: [],
    fees: [],
    tipHeight: async () => chain.tip,
    blockHash: async (h) => hashOf(h),
    utxos: async (address) => (address === account.address ? utxos.map((u) => ({ ...u })) : []),
    feeRate: async () => 2,
    async broadcast(txHex) {
      events.push("broadcast");
      const tx = btc.Transaction.fromRaw(unhex(txHex), { allowUnknownOutputs: true });
      esplora.broadcasts.push(tx);
      const spent = new Set(Array.from({ length: tx.inputsLength }, (_, i) => `${hex(tx.getInput(i).txid)}:${tx.getInput(i).index}`));
      const paid = utxos.filter((u) => spent.has(`${u.txid}:${u.vout}`)).reduce((t, u) => t + BigInt(u.value), 0n);
      esplora.fees.push(Number(paid - Array.from({ length: tx.outputsLength }, (_, i) => tx.getOutput(i).amount).reduce((t, a) => t + a, 0n)));
      utxos = utxos.filter((u) => !spent.has(`${u.txid}:${u.vout}`));
      for (let i = 0; i < tx.outputsLength; i++) {
        const o = tx.getOutput(i);
        if (hex(o.script) === hex(account.script)) utxos.push({ txid: tx.id, vout: i, value: Number(o.amount), status: { confirmed: false } });
      }
      const env = byTxid.get(tx.id);
      chain.mempool.push({ txid: tx.id, solutionId: env.solutionId, spends: env.spends, op: 7 });
      return tx.id;
    },
  };

  let drafts = 0;
  const wallet = {
    locked: new Set(),
    notes: [],
    drafts: [],
    finals: [],
    scans: 0,
    scan() {
      wallet.scans += 1;
      return wallet;
    },
    prepareClaim(view, { asset: id, reward: r, refHeight, refHash }) {
      drafts += 1;
      const commitments = [BigInt(`0x${randomBytes(31).toString("hex")}`), BigInt(`0x${randomBytes(31).toString("hex")}`)];
      const nullifiers = [BigInt(`0x${randomBytes(31).toString("hex")}`), BigInt(`0x${randomBytes(31).toString("hex")}`)];
      const rolled = wallet.roll ? [String(nullifiers[0])] : [];
      const draft = {
        id: drafts, asset: id, reward: r, refHeight, refHash, rolled, rolledAmount: 0n, nullifiers, commitments, ciphertexts: [new Uint8Array(95), new Uint8Array(95)],
        challenge: lib.challengeOf({ asset: id, refHeight, refHash, reward: r, commitments }),
      };
      wallet.drafts.push(draft);
      events.push(`draft ${refHeight}`);
      return draft;
    },
    async finalizeClaim(draft, bind, nonce) {
      wallet.finals.push({ draft: draft.id, bind, nonce: hex(nonce) });
      const envelope = new Uint8Array(bind.bindOutpoint ? 515 : 511);
      envelope.set(te.encode(`mine ${draft.id}`));
      byDraft.set(hex(envelope), { draft, nonce, bind });
      return envelope;
    },
    lockClaim(draft) {
      draft.rolled.forEach((n) => wallet.locked.add(n));
    },
  };
  const byDraft = new Map();
  const decode = (envelope) => {
    const { draft, nonce, bind } = byDraft.get(hex(envelope));
    return { op: bind.bindOutpoint ? 7 : 8, draft, nonce, bind, spends: draft.rolled, solutionId: hex(lib.solutionIdOf(draft.challenge, nonce)) };
  };

  const perChallenge = new Map();
  const pool = {
    size: 2,
    calls: [],
    async grind({ challenge, target, nonceStart, count }) {
      const key = hex(challenge);
      pool.calls.push({ challenge: key, target, nonceStart, count });
      await onGrind(pool.calls.length, { chain, pool, key });
      const n = (perChallenge.get(key) ?? 0) + 1;
      perChallenge.set(key, n);
      if (n !== findOn) return { nonce: null, powHash: null, tried: count };
      const nonce = new Uint8Array(8);
      new DataView(nonce.buffer).setBigUint64(0, BigInt(nonceStart), true);
      return { nonce, powHash: (pool.wrong ? (b) => sha(b) : lib.powHashReference)(lib.passwordOf(challenge, nonce)), tried: 7 };
    },
  };
  const file = { seed: randomBytes(32).toString("hex"), btcKey: randomBytes(32).toString("hex"), mineKey: hex(mineKey), pending: [] };
  const save = () => events.push(`save ${file.pending.length}`);
  const relay = pendingClaims === null ? null : { client: { mineAsset: async () => ({ pendingClaims }) }, url: "http://relay.test" };
  return { lib, asset, chain, idx, resync, esplora, wallet, pool, file, save, mineKey, account, events, decode, relay };
}

/** `run(fx, opts)` over the CLI's runMiner: collects every printed and warned line in `out`. */
export const makeRun = (runMiner) => (fx, opts = {}) => {
  const out = [];
  const p = runMiner({
    idx: fx.idx, wallet: fx.wallet, file: fx.file, save: fx.save, name: "erin", ticker: "dig", lib: fx.lib, pool: fx.pool, esplora: fx.esplora, resync: fx.resync,
    mineKey: fx.mineKey, decode: fx.decode, relay: fx.relay, print: (s) => out.push(s), warn: (s) => out.push(`warn: ${s}`), pollMs: 0, statsMs: 1e9, slice: 64,
    sleep: async () => {}, ...opts,
  });
  return p.then((r) => ({ ...r, out }));
};

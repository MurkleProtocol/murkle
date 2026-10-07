# Mining: build contract for five parallel tracks

Status: **binding for the mining build**, written 2026-10-05 from `mining.md` (§13.1 above all) and the code as it stands in this checkout. Where this file and `mining.md` differ, this file wins; §0.3 lists every difference and why. Where this file and `SPEC.md` differ, `SPEC.md` wins once the core track has folded these rules into it.

Scope: one consensus release on signet that adds DEPLOY_POW (op 9), MINE (op 7) and MINE_SCRIPT (op 8). **No circuit change, no new trusted setup, no change to `build/` or the pinned artifacts.** The mining activation height stays `null` in this build: on the live chain every op 7, 8 and 9 stays `malformed: unknown op N` and every digest stays v1, byte for byte. Every test uses an explicit test activation height.

## 0. Decisions

### 0.1 Owner decisions (final)

| Topic | Decision |
|---|---|
| Service-fee recipient | The **platform only**. `MINE_FEE = { platformSats: 500n, platformScript: P2TR of the signet operator address (`MINE_FEE.platformAddress`, derived from the script below), deployerMinSats: 0n, deployerMaxSats: 0n }`. A DEPLOY_POW must therefore carry `claimFeeSats = 0` (and so an empty treasury is allowed). |
| Platform script | `51203084846915ba86451221466028377de3bcf2ad8dc19ab8137684407dba6a9bab` (witness v1 program of the address above). It is the MURK treasury script on signet, so it is the operator's key, not the relayer's change key C. |
| Release order | Mining ships before BATCH: mining is digest **v2**, BATCH (when it ships) is v3 and includes the mining fields. |
| Constants | `MINE_WINDOW = 12`, `STALE_FACTOR = 4`, `MIN_DIFFICULTY = 256`, span 12 … 432, `16 ≤ S ≤ 100 × span`. |
| Start (2026-10-06) | **No mandatory lead**: `MINE_LEAD` (144) is removed and `mineStart = max(startHeight, deployHeight)`. The deployer picks one of two starts at launch: "Start mining now" (startHeight 0: the first usable reference is the launch block itself, whose hash nobody knows before it is mined) or "Start after N blocks" (startHeight = tip + 1 + N, counted from the current tip). The DEPLOY_POW byte layout is unchanged. A reference before the launch block is never valid. Copy next to the choice: "Starting now favours whoever is ready first; a delay gives everyone time to see the terms." (`mining.md` §0 item 6) |
| Argon2 | `hash-wasm` **4.12.0** (MIT, exact pin) is the primary implementation on every side; `@noble/hashes` (exact pin 1.8.0) is the reference and fallback. |
| Launch form | span 24, floor = initial / 16 (never below 256), suggested launch hashrate and the "Low floor" threshold as in §3.3 (`LAUNCH_DEFAULTS`). |
| Activation height | `null` in `src/pins.json` in this build. The owner sets it at release. |

### 0.2 Hard rules carried into every track

- **I-PAY.** The operator never pays any part of a user's transaction. A relayed claim is debited (miner fee + service fee + margin) and the debit is recorded durably before anything is signed. No free mode, no sponsored claim, no budget the operator funds.
- **No forced random waits** anywhere (no artificial delays before a claim is carried or broadcast).
- **Past verdicts and pre-activation digests stay byte-identical.** Proven by the v1-identity test (§7.2).
- **Errors are never verdicts.** A thrown Argon2, a dead or silent worker, a failed prevout lookup: the block is reverted and retried, never "insufficient work".
- **Never on the server's main loop.** Every Argon2 evaluation in `server/` runs in the `worker_threads` pool (§4). Browser pages run Argon2 only inside Web Workers.
- Do not start, stop or kill the dev server (indexer :8787, Vite :5173). Do not read-modify-write anything under `data/`; no test writes there (CLI tests set `MURKLE_DATA_DIR` to a temp dir). Nothing is broadcast. No browser wallets; no recovery phrase or password is ever written to a file or a log.
- English only, no Cyrillic. Honest copy (§12): never "anonymous", "untraceable", "trustless", "mixer"; say "Mine" and "the reward goes to a private note".
- Unisat: no UTXO filtering (Unisat picks and funds its own inputs).
- The only network install allowed is `npm install --save-exact hash-wasm@4.12.0` (core track, once).

### 0.3 Differences from `mining.md` (this file wins)

| # | `mining.md` says | This contract | Why |
|---|---|---|---|
| D1 | Both libraries reproduce the RFC 9106 §5.3 vector | Only noble can: `hash-wasm` 4.12.0 has no associated-data input. noble must reproduce the RFC vector (`0d640df5…6b01e659`); hash-wasm must reproduce the same inputs **without X** (`0034de3c8a75efc1148100eaf5ba9b1ce6d50ba5cdf6ae4018c54a4fc03ac10d`, computed by noble, which passes the RFC vector) and every mine vector | Checked during this contract: hash-wasm's `IArgon2Options` has a key input but no associated-data input |
| D2 | `platformSats ≥ FEE_MIN_SATS` (546) | `platformSats ≥ dustLimit(platformScript)` (330 for P2TR). `FEE_MIN_SATS` stays the floor for a deployer fee only | The owner chose 500 sats; 500 ≥ the P2TR dust limit, so every carrier stays relayable |
| D3 | `restore()` refuses older snapshot versions | Snapshot v3. `restore()` also accepts a v2 snapshot when no activation height is at or below its height, by a fixed migration (§6.10) | The state of a v1 replay below activation is exactly what v3 code computes; the live server then restarts without a resync. The restore digest check still runs |
| D4 | `/api/digest` returns `{ height, version, digest }` | `version` is present only when it is ≥ 2; absent means 1 | `test/server.test.mjs` pins the v1 shape with `deepEqual` |
| D5 | (silent) | Pinned JSON shapes only gain keys when the value is non-zero: `stats.accepted.mine`, `/api/blocks` `ops.mine`, books `serviceOut`, `settle()`/charge `service` | Existing tests `deepEqual` these objects; no existing test file may be edited |
| D6 | Activation rule "right after decoding" | The rule is applied to the **header** before strict decoding: magic ‖ version 0 ‖ op ∈ {7, 8, 9} below activation is `malformed: unknown op N` even when the body would not decode | A truncated op-9 payload must keep its v1 reason (`test/server.test.mjs` posts one) |
| D7 | Pre-pass memo by `solutionId` is optional | A per-block memo by `solutionId` is **required** in the sequential path too; the parallel pre-pass is required on the server | 1,700 failing copies of one solution must cost one Argon2, whatever the path |
| D8 | `/api/mine` lists open mined assets | `/api/mine` lists all mined assets with a `status`; `/api/assets` keeps paid-mint assets only (now with `kind: "mint"`); `/api/assets/:ticker` returns either kind | Unchanged views (`mints.js`, `share/launch.js`, `app-mint.js`, `pay.js`) read `/api/assets` as mint rows |
| D9 | Mined statuses unnamed | `"mining-soon" \| "mining" \| "mined-out" \| "mining-ended"` | Must not collide with the paid-mint statuses `live`, `upcoming`, `sold-out`, `ended` that unchanged views filter on |
| D10 | "never broadcast after ref + 11" next to `deadlineOf = ref + 9` | A MINE carrier is **signed** only while `tip ≤ ref + 9`; journaled bytes may be **re-broadcast** while `tip ≤ ref + 11`; never after | Makes the two numbers in §9 consistent |
| D11 | Relay error codes listed loosely | Adds `pow_invalid`, `solution_claimed`, `solution_pending`, `mine_disabled`, `mine_rejected` (§9.4) | Every refusal needs a code |
| D12 | `web/src/relay.js`, `web/src/api.js`, `web/src/views/app-activity.js` not listed | The web track owns narrow additions to them (§10.9) | The public relayer audit would flag every MINE carrier as "spends the relayer's coins to somewhere else"; the views need `/api/mine` |

## 1. Tracks, files and working rules

### 1.1 Ownership

A track edits **only** its own files. A file not listed here is not edited by anyone in this build (including `src/store-node.mjs`, `src/sync.mjs`, `src/btc/esplora.mjs`, `src/btc/block.mjs`, `web/src/keystore.js`, `web/src/payers.js`, `web/src/views/mints.js`, `web/src/share/launch.js`, `web/src/views/pay.js`, `docs/design/*.md` other than those listed, every existing test file).

| Track | Files (new files marked *) | Its tests |
|---|---|---|
| **core** | `src/params.mjs`, `src/pins.json`, `src/mine.mjs`*, `src/pow-pool.mjs`*, `src/pow-worker.mjs`*, `src/envelope.mjs`, `src/indexer.mjs`, `SPEC.md` (consensus sections), `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md`, `test/fixtures/mine-vectors.json`*, `test/fixtures/v1-chain.json`* | `test/mine-vectors.test.mjs`*, `test/mine-indexer.test.mjs`* |
| **client** | `src/wallet.mjs`, `src/keys.mjs`, `src/btc/funding.mjs`, `src/verify-tx.mjs`, `web/src/verify/*` (including the new `web/src/verify/pow.worker.js`*), `web/src/share/live-check.js` | `test/mine-client.test.mjs`* |
| **relayer** | `server/relayer.mjs`, `server/relay-books.mjs`, `server/indexer-server.mjs`, `docs/API.md`, `docs/design/relay-balance.md` | `test/mine-relayer.test.mjs`* |
| **web** | `web/src/session.js`, `web/src/mine-worker.js`*, `web/src/views/app-mine.js`*, `web/src/views/app-launch.js`, `web/src/views/token.js`, `web/src/views/explorer.js`, `web/src/views/app-shared.js`, `web/src/app.js` (routing, nav), `web/src/router.js` (only if needed), `web/src/styles/*`, and the narrow additions of §10.9 to `web/src/api.js`, `web/src/relay.js`, `web/src/views/app-activity.js` | `test/mine-web.test.mjs`* |
| **cli** | `bin/murkle.mjs`, `README.md`, `docs/CLAIMS.md`, `audit/REPORT.md` | `test/mine-cli.test.mjs`* |

### 1.2 Line endings (count bytes with node before and after each edit)

CRLF: `src/indexer.mjs`, `src/envelope.mjs`, `src/keys.mjs`, `src/verify-tx.mjs`, `bin/murkle.mjs`, `web/src/app.js`, `web/src/session.js`, `web/src/views/app-launch.js`, `web/src/views/explorer.js`, `web/src/views/app-shared.js`, `web/src/share/live-check.js`, `web/src/verify/replay.worker.js`, `web/src/verify/engine.js`.
LF: `src/params.mjs`, `src/pins.json`, `src/wallet.mjs`, `src/btc/funding.mjs`, `server/*.mjs`, `web/src/router.js`, `web/src/views/token.js`, `web/src/verify/replay.js`, `web/src/relay.js`, `web/src/api.js`, `SPEC.md`, `README.md`, `docs/*.md`, `audit/REPORT.md`, `THIRD_PARTY_NOTICES.md`, `package.json`.
Every other existing file: keep what it has. New files: LF. Every file ends with a newline.

### 1.3 Compatibility rules

- **Every existing test stays green** and no existing test file is edited. Run the whole suite (`npm test`) before declaring a track done; run a single file with `node --test test/<name>.test.mjs` from the repository root.
- Additive shapes: a key that an existing test pins with `deepEqual` is never renamed or removed, and a new key inside a pinned object appears only when its value is non-zero (D5).
- The dev server runs from this checkout. Vite serves `web/` live (no HMR), so every saved web file must parse; the indexer process keeps the code it started with until the owner restarts it.
- No track depends on another track's unmerged code to **compile**; tests that need consensus code run once core has landed. A test may inject a fake `pow` (`{ hash: async () => new Uint8Array(32) }`, which meets every target) to avoid grinding, except where §13 asks for real Argon2.

### 1.4 Merge order

core → client and relayer → web and cli. Each track codes against this contract from the start.

## 2. Constants: `src/params.mjs` and `src/pins.json` (core)

`src/params.mjs` stays light (it is imported by the web config): no new imports besides `pins.json`.

```js
// existing exports unchanged, plus:
export const LABELS = Object.freeze({
  spend, view, note, btcFee, relayPow, digest,       // unchanged ("murkle/digest/v1" stays)
  btcMineFee: label("btc-mine-fee"),                 // "murkle/btc-mine-fee"
  mine: label("mine/v1"),                            // "murkle/mine/v1" (14 bytes), challenge domain tag
});
export const digestTag = (v) => label(`digest/v${v}`);   // digestTag(1) === LABELS.digest
export const DIGEST_V = 2;            // the newest digest version this code computes
export const SNAPSHOT_VERSION = 3;

export const MINE_WINDOW = 12;        // H - 12 <= ref <= H - 1
export const STALE_FACTOR = 4;
export const MIN_DIFFICULTY = 256n;
export const SPAN_MIN = 12;
export const SPAN_MAX = 432;
export const MIN_SPAN_CLAIMS = 16;    // targetPerSpan >= 16
export const MAX_PER_BLOCK = 100;     // targetPerSpan <= 100 * span
export const MINE_SLACK = 2;          // relayer: last signing tip = ref + 12 - 1 - 2
export const D_MAX = (1n << 63n) - 1n;
export const MINE_SALT_TEXT = "murkle/mine/salt";   // 16 ASCII bytes, the Argon2 salt
export const ARGON = Object.freeze({ type: "argon2id", version: 0x13, memoryKiB: 4096, passes: 1, lanes: 1, tagLength: 32 });
export const FEE_MIN_SATS = 546n;     // smallest nonzero DEPLOYER fee (D2)
export const STANDARD_SCRIPTS = Object.freeze(["p2pkh", "p2sh", "p2wpkh", "p2wsh", "p2tr"]);

// Service fee per network. Consensus: fixed before activation; a change is a new rule with its
// own activation height. Mainnet is one more line here.
export const MINE_FEES = Object.freeze({
  signet: Object.freeze({
    platformAddress: segwitAddress("tb", platformScript), // derived at load time (the literal address is not written in the repository)
    platformScript: "51203084846915ba86451221466028377de3bcf2ad8dc19ab8137684407dba6a9bab", // hex
    platformSats: 500n,
    deployerMinSats: 0n,
    deployerMaxSats: 0n,            // 0 forbids a deployer fee
  }),
});
export const MINE_FEE = MINE_FEES[NETWORK] ?? null;

// Consensus changes after v1 (SPEC §10). Each { name, height: number | null, digestV }.
export const ACTIVATIONS = Object.freeze((pins.activations ?? []).map((a) => Object.freeze({ ...a })));
export function activationHeight(name, activations = ACTIVATIONS)   // -> number | null
export function digestVersionAt(height, activations = ACTIVATIONS)  // digestV of the newest activation with a non-null height <= height, else 1
export const MINING_HEIGHT = activationHeight("mining");            // null in this build
```

`src/pins.json` gains one key (keep two-space indentation, LF, final newline; `scripts/build-circuit.mjs` keeps unknown keys):

```json
"activations": [
  { "name": "mining", "height": null, "digestV": 2 }
]
```

The BATCH release adds `{ "name": "batch", "height": null, "digestV": 3 }` later. Validity (checked by `assertActivations(activations)` in `src/mine.mjs`, called by the `Indexer` constructor, and by a core test): names unique, `digestV` values are 2, 3, … in table order, heights `null` or integers greater than the genesis `activationHeight`, and heights non-decreasing in `digestV` order among the non-null ones. An `Indexer` with a non-null mining height and `MINE_FEE === null` throws `mining activation needs MINE_FEE for this network`.

`package.json`: `"hash-wasm": "4.12.0"` (via `npm install --save-exact hash-wasm@4.12.0`), and `"@noble/hashes": "1.8.0"` (exact; edit `package.json` and the lockfile's root `packages[""].dependencies` entry by hand, no network; the lockfile already resolves 1.8.0). `engines` stays `>=22`. `THIRD_PARTY_NOTICES.md` gains the hash-wasm MIT notice in the file's existing format.

## 3. `src/mine.mjs` (core, new, LF)

Pure and isomorphic (Node, browser main thread, Web Workers). Imports only `./params.mjs`, `./bytes.mjs`, `@noble/hashes/sha256`, `@noble/hashes/argon2` and, lazily (`await import("hash-wasm")`), hash-wasm. It must **not** import `envelope.mjs`, `indexer.mjs`, `core.mjs`, snarkjs or any `node:` module.

### 3.1 Exports

Types: heights are safe integers; amounts, difficulties, targets and sats are `bigint`; hashes are `Uint8Array`; "hex" means lowercase hex.

```js
export const NONCE_LEN = 8, CHALLENGE_LEN = 32, PASSWORD_LEN = 40;
export const MINE_SALT;                       // Uint8Array, ASCII "murkle/mine/salt"

// -- preimage (mining.md §4.3)
export function challengeOf({ asset, refHeight, refHash, reward, commitments })   // -> Uint8Array(32)
//   sha256("murkle/mine/v1" ‖ asset u64 LE ‖ refHeight u32 LE ‖ refHash 32 ‖ reward u64 LE ‖ c0 32 BE ‖ c1 32 BE)
//   refHash: 64-char display hex or 32 bytes (the display bytes, as the digest uses them)
export function passwordOf(challenge, nonce)  // -> Uint8Array(40) = challenge ‖ nonce
export function solutionIdOf(challenge, nonce) // -> Uint8Array(32) = sha256(password)
export function claimPreimage({ asset, refHeight, refHash, reward, commitments, nonce })
//   -> { challenge, password, solutionId, solutionIdHex }
export function nonceOf(counter)              // bigint 0..2^64-1 -> 8 bytes, u64 LE (miners' counter encoding; consensus treats the nonce as raw bytes)
export function counterOf(nonce)              // inverse of nonceOf

// -- Argon2id (RFC 9106 v1.3, ARGON params, salt MINE_SALT, no secret, no associated data)
export async function powHash(password)       // -> Uint8Array(32). Fast path after its self-test, else the reference.
export function powHashReference(password)    // -> Uint8Array(32), noble, synchronous
export async function selfTest()              // -> { ok: boolean, impl: "hash-wasm" | "noble" | null }
export function fastPathState()               // -> { impl: "hash-wasm" | "noble", tested: boolean, disabled: string | null }
export function disableFastPath(reason)       // the reference is used from now on, in this process / worker
export const SELF_TEST_VECTORS;               // frozen [{ name, password (hex), powHash (hex) }] plus the D1 no-AD vector
export const inlinePow;                       // { hash: powHash, hashMany: async (passwords) => [...] } (dedups by password)

// -- targets
export function targetOf(D)                   // floor((2^256 - 1) / D); throws RangeError unless 1 <= D <= D_MAX
export function targetHex(D)                  // 64-char hex
export function meetsTarget(hash, target)     // int_BE(hash) <= target (equality is valid)
export async function grindRange({ challenge, target, nonceStart, count })
//   -> { nonce: Uint8Array | null, powHash: Uint8Array | null, tried }; tries nonceStart, nonceStart+1, … (mod 2^64)

// -- terms, reward, difficulty (mining.md §3, §6)
export function mineStartOf(asset)            // max(asset.startHeight, asset.deployHeight): never before the launch block
export function rewardAt(asset, ref)          // §6.3; 0n once the shift reaches 63
export function nextHalving(asset, tip)       // height | null
export function stepDifficulty(prev, work, { span, targetPerSpan, minDifficulty })
//   min(D_MAX, max(minDifficulty, (prev*(span-1)*S + work*span) / (span*S)))   (BigInt floor)
export function difficultyAt(asset, h)        // D(h) from asset.dPts: the w = 0 step iterated from the newest point <= h,
                                              // stopping early at minDifficulty; initialDifficulty for h <= mineStart
export function effectiveDifficulty(asset, refHeight, height)
//   D_eff = max(D(refHeight), D(height - 1) / STALE_FACTOR)      (height = inclusion height)
export function mineStatus(asset, tip)
//   "mining-soon" (tip < mineStart) | "mining-ended" (endHeight != 0 && tip > endHeight, or rewardAt(tip) = 0)
//   | "mined-out" (issued + rewardAt(tip) > maxSupply) | "mining"

// -- service fee (mining.md §7)
export function isStandardScript(script)      // "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr" | null (exact templates)
export function requiredFeeOutputs(asset, fee = MINE_FEE)
//   -> [{ script: Uint8Array, sats: bigint, role: "deployer" | "platform" | "both" }]
//   [treasury, claimFeeSats] if claimFeeSats > 0, then [platformScript, platformSats] if platformSats > 0;
//   grouped by script in order of first appearance, amounts summed.
export function feeOutputsPaid(asset, tx, fee = MINE_FEE)
//   -> { ok: boolean, paid: bigint (gross sats to every required script), short: [{ script, need, paid }] }
//   tx: { outputs: [{ script, value }] }, value Number | bigint; gross sum per script, as treasuryPaid counts
export function checkFeePolicy(claimFeeSats, treasury, fee = MINE_FEE)  // -> null | reason (D2 and mining.md §7)
export function assertActivations(activations)

// -- non-consensus helpers shared by the server, the web and the CLI
export const LAUNCH_DEFAULTS;   // §3.3
export function suggestInitialDifficulty({ hashrate, span, targetPerSpan })
//   max(MIN_DIFFICULTY, floor(hashrate * 600 * span / targetPerSpan))
export function suggestFloor(initialDifficulty)       // max(MIN_DIFFICULTY, initial / 16)
export function hashrateEstimate(entries, tip)        // Σ D_eff of accepted MINE log entries with height > tip - 144, / 86,400 s -> Number (H/s)
export function difficultySeries(asset, entries, { from, to })  // [[h, D(h)]] recomputed from the log (chart; not consensus)
export function floorEmission(asset, hashrate)        // claims per block at minDifficulty for this hashrate, capped at 1,700 -> Number
export function lowFloor(asset, hashrate)             // §3.3 flag -> boolean
```

### 3.2 Fast path and self-test

- `powHash` awaits `selfTest()` once per process or worker (memoized promise). The self-test computes every `SELF_TEST_VECTORS` entry with hash-wasm and compares; a mismatch or a throw disables the fast path (`disabled: "self-test failed"`). Then it runs the reference over the same vectors **and** the RFC 9106 §5.3 vector; if the reference fails, `selfTest()` returns `{ ok: false, impl: null }` and `powHash` throws `Error("Argon2 self-test failed")` with `code = "POW_SELF_TEST"`.
- A hash-wasm call that throws after the self-test disables the fast path for that process and `powHash` retries the same password once with the reference. If the reference throws, `powHash` throws (`code = "POW_FAILED"`). **`powHash` never returns a substitute value.**
- hash-wasm call: `argon2id({ password, salt: MINE_SALT, parallelism: 1, iterations: 1, memorySize: 4096, hashLength: 32, outputType: "binary" })`. Reference: `argon2id(password, MINE_SALT, { t: 1, m: 4096, p: 1, dkLen: 32 })`. Node's `crypto.argon2` is not used in this build.
- `SELF_TEST_VECTORS` is a copy of at least three entries of `test/fixtures/mine-vectors.json` (including the equality vector) plus the D1 no-AD vector; a core test asserts each one is in the file. Runtime code never reads `test/`.

### 3.3 `LAUNCH_DEFAULTS`

```js
export const LAUNCH_DEFAULTS = Object.freeze({
  span: 24, perBlock: 1,              // S = perBlock * span
  launchHashrate: 2000,               // H/s, "a few browsers"; the form's default expected launch hashrate
  floorDivisor: 16,                   // floor = initial / 16, never below MIN_DIFFICULTY
  browserThreadHs: 250,               // one hash-wasm browser thread (mining.md §4.4)
  lowFloorRatio: 1000,                // explorer flag
  halvingInterval: 0, claimFeeSats: 0n,
  start: "now", startAfter: 144,     // the launch form: "Start mining now", or this many blocks after the next one
});
export function startHeightFor({ start, after, tip })  // "now" -> 0; "after" -> tip + 1 + after (after >= 1, tip known); not consensus
```

`lowFloor(asset, hashrate)`: with `ref = max(suggestInitialDifficulty({ hashrate, span, S }), suggestInitialDifficulty({ hashrate: browserThreadHs, span, S }))`, the flag is set when `minDifficulty * 1000 < ref` or `initialDifficulty * 1000 < ref`.

## 4. Argon2 worker pool (core)

### 4.1 `src/pow-pool.mjs` (new, LF)

No top-level `node:` import (Node modules are loaded inside `createNodePowPool` only).

```js
export class PowError extends Error {}      // .code: "POW_SELF_TEST" | "POW_WORKER_FAILED" | "POW_TIMEOUT" | "POW_BUSY" | "POW_CLOSED"

export class PowPool {
  constructor({ size, spawn, maxQueue = 4096, timeoutMs = 30_000 })
  //   spawn(): a worker-like object { postMessage(msg), on/onmessage, terminate() } running the §4.2 protocol
  async ready()                               // -> { impl, workers }: every worker has passed its self-test; throws PowError POW_SELF_TEST
  hash(password)                              // -> Promise<Uint8Array(32)>
  hashMany(passwords)                         // -> Promise<Uint8Array[]> in input order; equal passwords evaluated once
  grind({ challenge, target, nonceStart, count })   // -> Promise<{ nonce, powHash, tried }> (CLI miner)
  get size(); get busy(); get queued()        // workers; tasks running; tasks waiting
  async close()
}
export async function createNodePowPool({ size = defaultPowThreads(), ...opts } = {})  // worker_threads running ./pow-worker.mjs
export function defaultPowThreads()           // max(1, min(4, os.availableParallelism() - 1)); env MURKLE_POW_THREADS overrides
```

Rules:
- A worker that exits, errors, or does not answer within `timeoutMs` rejects every task it held with `PowError` (`POW_WORKER_FAILED` / `POW_TIMEOUT`) and is replaced. **A failure is never turned into an "invalid" result.**
- `hash()` beyond `maxQueue` waiting tasks rejects `POW_BUSY` (the relayer maps it to `busy`); `hashMany()` from the indexer is never refused for queue length.
- After `close()`, calls reject `POW_CLOSED`.

### 4.2 `src/pow-worker.mjs` (new, LF): Node worker protocol

```
on start   -> runs selfTest(); posts { type: "ready", ok: boolean, impl: "hash-wasm" | "noble" | null }
in  { id, type: "hash",  passwords: [hex80, …] }                       -> { id, ok: true, hashes: [hex64, …] }
in  { id, type: "grind", challenge: hex64, target: hex64, nonceStart: hex16, count } -> { id, ok: true, nonce: hex16 | null, powHash: hex64 | null, tried }
any failure                                                             -> { id, ok: false, error: "message" }
```

## 5. Envelope (`src/envelope.mjs`, core)

`decodeEnvelope` stays free of height. New and changed exports:

```js
export const OP = { TRANSACT: 1, DEPLOY: 2, MINT: 3, MINT_SCRIPT: 4, ATTEST: 5, MINE: 7, MINE_SCRIPT: 8, DEPLOY_POW: 9 };
export const OP_NAME = { …, 7: "MINE", 8: "MINE_SCRIPT", 9: "DEPLOY_POW" };   // op 6 stays reserved (BATCH)
export const MINING_OPS = new Set([7, 8, 9]);
export const isMine = (op) => op === OP.MINE || op === OP.MINE_SCRIPT;          // isMint unchanged (3, 4)
export const NONCE_LEN = 8;
envelopeLen(OP.MINE) === 515; envelopeLen(OP.MINE_SCRIPT) === 511;              // bodies 387 / 383
export const DEPLOY_POW_MIN_LEN = 66, DEPLOY_POW_MAX_LEN = 116;
export function encodeTxBody({ op, anchor, publicAsset, publicAmount, bindOutpoint, bindScriptHash, nonce, nullifiers, commitments, ciphertexts })
//   ops 7/8: anchor = refHeight; nonce: 8 bytes, written after the bind (mining.md §4.1 order)
export function encodeDeployPow({ ticker, divisibility, reward, maxSupply, halvingInterval = 0, span, targetPerSpan,
  initialDifficulty, minDifficulty, claimFeeSats = 0n, treasury = new Uint8Array(), startHeight = 0, endHeight = 0 })
```

Decoded shapes:
- MINE / MINE_SCRIPT: `{ op, anchor, refHeight (=== anchor), publicAsset, publicAmount, bindOutpoint | bindScriptHash, nonce (8 bytes), nullifiers, commitments, ciphertexts, proof, extDataHash }`, where `extDataHash = sha256(body) >> 8`, body = every byte before the proof.
- DEPLOY_POW: `{ op, ticker, divisibility, reward, maxSupply, halvingInterval, span, targetPerSpan, initialDifficulty, minDifficulty, claimFeeSats, treasury, startHeight, endHeight }`.

`validateDeployPow` (encode and decode, structural only; the error text becomes `malformed: <text>`):
`[A-Z0-9]{1,16}`; divisibility ≤ 8; `1 ≤ reward ≤ 2^63 − 1`; `reward ≤ maxSupply`; span 12 … 432; `16 ≤ S ≤ 100 × span`; `MIN_DIFFICULTY ≤ minDifficulty ≤ initialDifficulty ≤ D_MAX`; treasury empty or one of `STANDARD_SCRIPTS` (`isStandardScript`); `claimFeeSats > 0` requires a treasury; `endHeight = 0` or `endHeight ≥ startHeight`; no trailing bytes. The fee **policy** (`MINE_FEE`) and `endHeight ≥ mineStart` are indexer rules (§6.3), so that a later fee rule can carry its own activation height.

## 6. Indexer (`src/indexer.mjs`, core, CRLF)

### 6.1 Constructor, properties, restore

```js
new Indexer({ vkey, startHeight, genesis = null, activations = ACTIVATIONS, pow = inlinePow, mineFee = MINE_FEE })
Indexer.restore(snap, { vkey, activations = ACTIVATIONS, pow = inlinePow, mineFee = MINE_FEE })
```
- `idx.pow` and `idx.prevoutScript` are public writable properties: the server sets `idx.pow = pool` after `loadIndexer()` (which this build does not change).
- `idx.verifyGroth16(publicSignals, proof)` is a method (default `snarkjs.groth16.verify(this.vkey, …)`) used by `checkTx` and the MINE checks, so tests can spy on it.
- New state: `idx.claimed: Map<solutionIdHex, refHeight>`, `idx.mineAcc: Uint8Array(32)` (zeros), `idx.activations`, `idx.mineFee`.
- Helpers: `miningHeight` (getter), `miningActive(height)`, `digestVersionAt(height)`, `difficultyAt(assetId, h)`, `effectiveDifficulty(assetId, ref, height)`, `rewardAt(assetId, ref)`, `requiredFeeOutputs(assetId)`, `claimOf(env)` → `{ challenge, password, solutionId, solutionIdHex } | null` (null when `hashes[refHeight]` is unknown or the asset is not mined), `minedHash()`.

### 6.2 Activation gate (D6)

In `applyBlock`, for each payload found, **before** `decodeEnvelope`: if `payload.length ≥ 5`, `payload[3] === VERSION`, `payload[4] ∈ MINING_OPS` and not `miningActive(H)`, record `(at, payload[4], false, { reason: "malformed: unknown op N" })` with `opName: "UNKNOWN"`, and continue. No asset or stat other than `stats.rejected` is touched. `record()` gains an optional `opName` override so `OP_NAME[7]` does not leak into a pre-activation entry. The v1 log, `logAcc` and digest are byte-identical.

### 6.3 DEPLOY_POW

`checkDeployPow(env, height)` → `true` or reason, in this order:
1. `checkFeePolicy(env.claimFeeSats, env.treasury, this.mineFee)`: with the owner's constants any `claimFeeSats ≠ 0` is `malformed: deployer claim fee not allowed`; otherwise `malformed: claim fee N outside A..B` / `malformed: claim fee below 546 sats`.
2. `endHeight ≠ 0 && endHeight < mineStart` → `malformed: end before mining start`.
3. `ticker X already deployed` (shared namespace with DEPLOY).

`applyDeployPow(env, id, payload, at, undo)`: the asset record (in memory):
```
{ ...env, kind: "pow", id, bodyHash: hex(sha256(payload)), deployTxid, deployHeight, mineStart,
  claims: 0, issued: 0n, pool: 0n (always === issued), dPts: [[mineStart, initialDifficulty]],
  rejectedClaims: 0, burnedFeeSats: 0n, feeSats: 0n, firstClaimHeight: null, minedOutHeight: null,
  claimsByHeight: [] }            // claimsByHeight: non-consensus series, like mintsByHeight
```
Paid-mint assets gain `kind: "mint"`. MINT / MINT_SCRIPT against a `pow` asset: `asset is mined` (right after `unknown asset`).

### 6.4 MINE / MINE_SCRIPT checks, reasons (exact strings), in order

`checkMine(env, tx, H)` runs the parts below in order and returns the first reason; nothing mutates. The parts are public so the relayer and verify-tx reuse them.

| Part | Rule (mining.md §5.2) | Reason on failure |
|---|---|---|
| `mineStatic(env, H)` | 2 | `unknown asset`, `asset is not mined` |
| | 3 | `reference outside window`, `mining not started`, `mining closed` |
| | 4 | `unknown reference block` |
| | 5 | `mining ended`, `reward differs from terms` |
| | 6 | `supply cap reached` |
| `mineCarrier(env, tx)` | 7 | `underpaid service fee: P < N sats to <script hex>` (first short group) |
| | 8 | `MINE not bound to this transaction` (no first input; MINE first input ≠ bindOutpoint), `MINE not bound to this payer` (MINE_SCRIPT first input is the null outpoint) |
| `mineState(env)` | 9 | `duplicate nullifier in envelope`, `nullifier already spent` |
| | 10 | `solution already claimed` |
| `minePow(env, H)` | 11 | `insufficient work` (any thrown error propagates) |
| `mineProof(env)` | 12 | `invalid proof encoding: …`, `proof does not verify` (public signals `[R[ref], reward, asset, extDataHash, n0, n1, c0, c1]`) |
| `mineBind(env, tx)` | 13 (MINE_SCRIPT only) | `cannot resolve the spent output (no prevout resolver)`, `MINE not bound to this payer`; a throwing resolver propagates |

Verdict-neutral cleanup in the same release: MINT_SCRIPT's prevout lookup moves after its Groth16 check (the null-outpoint shortcut stays first); reasons of existing tests are unchanged because their proofs verify.

### 6.5 PoW memo and parallel pre-pass (D7)

- `applyBlock` keeps a per-block `Map<solutionIdHex, Promise<Uint8Array>>`; rule 11 always reads through it. It is discarded at the end of the block (also on revert).
- Pre-pass, at the top of the `try` of `applyBlock` when `miningActive(H)`: for every payload that passes the gate and decodes as MINE/MINE_SCRIPT and passes rules 2–5, 7, 8 and "nullifiers distinct and not in `N` at block start", collect its password (distinct by `solutionId`) and call `this.pow.hashMany(passwords)` (or `Promise.all(hash)` when `hashMany` is absent); seed the memo. Errors propagate (block reverted, retried).
- `D_eff` is never memoized across blocks; it is computed at rule 11 from `dPts` (fixed before block H).

### 6.6 Apply, end of block, journal

- Accepted claim: commitments appended to the tree and `outputs` (as MINT); nullifiers to `N` and `nullAcc`; `claims += 1`, `issued += r`, `pool = issued`, `feeSats += feeOutputsPaid(asset, tx).paid`, `firstClaimHeight ??= H`, `minedOutHeight` set when `issued + rewardAt(asset, H) > maxSupply`; block work `w[asset] += D_eff`; `claimed.set(solutionIdHex, ref)`; `mineAcc = sha256(mineAcc ‖ solutionId)`; `bump(claimsByHeight, H)`; `bump(stats.outputsByHeight, H, 2)`.
- Rejected claim of a known mined asset: `rejectedClaims += 1`, `burnedFeeSats += feeOutputsPaid(asset, tx).paid`.
- End of block, **inside the `try`** (a throw reverts the whole block): for each asset with `w > 0`, append `[H, stepDifficulty(difficultyAt(asset, H − 1), w, terms)]` to `dPts`; prune each touched asset's `dPts` (drop entries older than the newest entry at or below `H − MINE_WINDOW − 1`; at most 14 remain); prune `claimed` entries with `ref < H − MINE_WINDOW − UNDO_DEPTH` (not journaled). Then the existing root / hash / digest code.
- Undo entry gains: `mine: [[id, { claims, issued, pool, rejectedClaims, burnedFeeSats, feeSats, firstClaimHeight, minedOutHeight, dPts: copy }]]` (first touch in the block), `mineAcc` (before), `claimed: [solutionIdHex, …]` (added this block). `revert()` restores them and trims `claimsByHeight` above `H − 1`.

### 6.7 Log entries and stats

- Accepted MINE / MINE_SCRIPT: `{ seq, height, index, txid, op, opName, ok: true, asset, ticker, amount: r (string), ref, difficulty: D_eff (string) }`. Never a recipient.
- Rejected (post-activation): `{ …, ok: false, reason, asset, ticker? , amount: publicAmount (string), ref }`.
- DEPLOY_POW: `{ asset?, ticker }` exactly as DEPLOY.
- `STAT_KEY`: 7, 8 → `"mine"`, 9 → `"deploy"`. `stats.accepted.mine` is created on the first accepted claim (D5); readers use `?? 0`. `emptyStats()` is unchanged.

### 6.8 Digest (SPEC §10, versioned)

`computeDigest(h, blockHash, root)` uses `v = digestVersionAt(h, this.activations)`:
- v1: unchanged.
- v2: `sha256(digestTag(2) ‖ h u32 LE ‖ blockHash 32 ‖ root 32 BE ‖ nullAcc ‖ logAcc ‖ assetsHash ‖ minedHash ‖ mineAcc)`, where `assetsHash` is the v1 formula over `kind: "mint"` assets only and
  `minedHash = sha256(concat over kind "pow" assets sorted by id of: id u64 LE ‖ claims u64 LE ‖ issued u64 LE ‖ dHeight u32 LE ‖ dValue u64 LE ‖ unhex(bodyHash))` (`sha256("")` when none), `[dHeight, dValue]` = the newest `dPts` entry.
- The switch is unconditional at the activation height, with or without mining ops. Per-asset `minedHash` lines may be cached; the result must equal the formula.

### 6.9 Snapshot v3

`snapshot()` adds, next to the v2 fields: `activations` (the table in effect), `digestVersion: DIGEST_V`, `mine: { mineAcc: hex, claimed: [[solutionIdHex, ref], …] }`; mined assets with bigints as decimal strings (`reward`, `maxSupply`, `initialDifficulty`, `minDifficulty`, `claimFeeSats`, `issued`, `pool`, `burnedFeeSats`, `feeSats`), `treasury` hex, `dPts: [[h, "D"]]`, `claimsByHeight`; undo entries with `mine`, `mineAcc` (hex) and `claimed`. `restore()` rebuilds them and re-checks root and tip digest as today.

### 6.10 Restore compatibility (D3)

- `version 3`: accepted when `protocol` and `envelopeVersion` match, `digestVersion === DIGEST_V`, and for every activation name, the snapshot's height and the caller's height are equal **or** both are `null` or greater than `snap.height`. Otherwise `throw new Error("snapshot activations differ")` (store-node archives it and resyncs, as today).
- `version 2` (`digestVersion 1`): accepted only when every caller activation height is `null` or greater than `snap.height`. Migration: each asset gets `kind: "mint"`; `claimed` empty; `mineAcc` zeros; each undo entry gets `mine: []`, `mineAcc: zeros`, `claimed: []`; `stats` unchanged. Then the normal root and digest checks run (the digest at `snap.height` is v1 by construction).
- Any other version: `unsupported snapshot version` as today.

## 7. Test vectors and the v1-identity fixture (core)

### 7.1 `test/fixtures/mine-vectors.json`

```json
{
  "format": "murkle-mine-vectors/1",
  "argon2": { "type": "argon2id", "version": 19, "memoryKiB": 4096, "passes": 1, "lanes": 1, "tagLength": 32, "salt": "murkle/mine/salt" },
  "label": "murkle/mine/v1",
  "rfc9106": { "password": "01…(32 bytes)", "salt": "02…(16)", "secret": "03…(8)", "ad": "04…(12)", "memoryKiB": 32, "passes": 3, "lanes": 4, "tagLength": 32,
               "tag": "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659" },   // RFC 9106 public test vector, prepublish-ok
  "rfc9106NoAd": { "…same without ad…": true, "tag": "0034de3c8a75efc1148100eaf5ba9b1ce6d50ba5cdf6ae4018c54a4fc03ac10d" },
  "vectors": [
    { "name": "illustrative", "asset": "1395864371200007", "refHeight": 325100,
      "refHash": "0000000000000000000000000000000000000000000000000000000000000abc", "reward": "1000",
      "commitments": ["1", "2"], "nonce": "0000000000000000",
      "challenge": "f9181c09f98cb253ed91f856cc42eab177a0639e22df4de67f8d5d9176121661",
      "password": "<challenge ‖ nonce, 80 hex>",
      "solutionId": "1bb0f3380801d593ed3d3ae627ce16a8209f228bceea9e7d6ca2921fcc2008f4",
      "powHash": "8ce2b336274d4c3a60b8c69f8902776ea6e657318fb1bd8d44edcfad4d44c372",
      "difficulty": "1000", "target": "<targetHex(1000)>", "valid": false }
  ]
}
```
- All hex lowercase; bigints as decimal strings; `rfc9106NoAd` written out in full (all fields, no `ad`).
- At least 16 vectors: nonce `0000000000000000` and `ffffffffffffffff`; zero and random ref hashes; field-max commitments (`FIELD − 1`); asset `0` and `2^64 − 1`; reward `1` and `2^63 − 1`; difficulties 1, 256, 1000, `D_MAX`; one vector with `"difficulty": null` and `target` = its own `powHash` (`valid: true`, the equality case) and one with `target = powHash − 1` (`valid: false`).
- Generated by noble (the reference) and checked against hash-wasm before writing. The illustrative values above were re-computed for this contract with both libraries and match.

### 7.2 `test/fixtures/v1-chain.json` and the identity test

Shape: `{ "format": "murkle-v1-chain/1", "startHeight", "prevouts": { outpointHex: scriptHex }, "blocks": [{ "height", "hash", "txs": [{ "txid", "inputs": [{ "outpoint": hex72 }], "outputs": [{ "script": hex, "value": "decimal" }] }] }], "digests": [[h, hex]], "log": [entries], "generatedBy": "pre-mining src/indexer.mjs" }`.

Contents (proofs against `build/dev`): a DEPLOY, paid MINTs (one underpaid), a MINT_SCRIPT (resolver from `prevouts`), a TRANSACT, an ATTEST, a malformed payload, and **below activation**: a valid-looking DEPLOY_POW, a MINE, a MINE_SCRIPT (built with the new encoders), a truncated op-9 payload `mrk 00 09 01 02`, and an op-7 payload with version byte 1. At least 8 blocks.

Generation (once, by the core builder, not committed as a script): build the blocks, copy the pre-mining snapshot's `src/` (a scratch copy outside the repository) into `node_modules/.cache/murkle-pre-mining/src/` (bare imports then resolve to the project's `node_modules`), replay with **that** `Indexer`, and write its digests and log into the fixture.

`test/mine-indexer.test.mjs` then asserts, with the current code and no network:
1. activations `[{ mining, height: null }]`: every digest and the whole log equal the fixture;
2. activation height = last block + 1: the same;
3. activation height = a block after the last mining op: digests equal below it, v2 (and different) from it on, with no mining op at or above it;
4. when `MURKLE_PRE_MINING_SRC` names an old `src/` dir reachable as above, the old `Indexer` is replayed live and compared too (skipped otherwise).

## 8. Client track

### 8.1 `src/keys.mjs` (CRLF)

```js
export function feeKeysOf(entropy)   // -> { feeKey: hkdf(sha256, entropy, undefined, LABELS.btcFee, 32),
                                     //      mineFeeKey: hkdf(sha256, entropy, undefined, LABELS.btcMineFee, 32) }
```
The web session derives both from it (the transfer key stays byte-identical to today's).

### 8.2 `src/wallet.mjs` (LF)

```js
wallet.prepareClaim(view, { asset, reward, refHeight = view.height, refHash, roll = true })   // -> ClaimDraft (sync)
await wallet.finalizeClaim(draft, { bindOutpoint } | { bindScriptHash }, nonce)               // -> Uint8Array envelope (515 / 511)
wallet.lockClaim(draft); wallet.unlockClaim(draft)       // W-M: rolled notes' nullifiers in/out of wallet.locked
export const claimLockUntil = (refHeight) => refHeight + MINE_WINDOW;
```
- `view`: anything with `{ tree, outputs, height }`; for `refHeight < view.height` the tree comes from `anchorAt(view, refHeight)`.
- `ClaimDraft`: `{ asset, reward, refHeight, refHash (hex), rolled: [nullifier strings], rolledAmount, nullifiers: [bigint, bigint], commitments: [bigint, bigint], ciphertexts: [Uint8Array, Uint8Array], challenge: Uint8Array(32) }` plus a private, non-enumerable circuit input. Inputs: up to two spendable, unlocked notes of `asset` (largest first) when `roll`, padded with dummies. One output: `rolledAmount + reward` to self; the other: zero-value padding to a throwaway key. The two (each commitment with its ciphertext) are in a random order (`shuffleOutputs`, a CSPRNG; privacy-trace-test.md L4), and the challenge commits to that order. The circuit treats both outputs alike. **Every call draws fresh blindings, ephemeral keys and dummy inputs**, so no two drafts share a commitment or a nullifier.
- `finalizeClaim` may be called again on the same draft with another bind (relayer `bind_stale`); the same nonce keeps the same `solutionId`. It encodes the body (op MINE with `bindOutpoint`, MINE_SCRIPT with `bindScriptHash`), sets `extDataHash`, proves with `this.artifacts`, and returns the envelope.

### 8.3 `src/btc/funding.mjs` (LF)

```js
export const MINE_VSIZE = Object.freeze({ bare: 598, change: 641, feeOutputAndChange: 684 });   // one P2TR input
export function mineCarrierVsize({ feeOutputs = 1, change = true, inputs = 1 })               // estimate for quotes
export function carrierAmountOf(script, sats)   // max(sats, dustLimit(script)): what a carrier pays a fee script
export function planSplitTx({ account, utxos, n, value, feeRate })   // "prepare N coins": n outputs of `value` to the account + change
```
`planCarrierTx`: claims pass `outputs` = the fee outputs (in `requiredFeeOutputs` order, `carrierAmountOf` amounts) and `firstInput` = the bound coin for MINE. Every input carries nSequence `0xfffffffd` (one policy for every route, L5), the bound coin stays input 0 while the other inputs are shuffled, and the change takes a random position after the OP_RETURN at output 0, so the fee outputs keep their order among the other outputs.

### 8.4 `src/verify-tx.mjs` (CRLF)

New `ctx` fields (all optional): `powHash(password) -> Promise<Uint8Array>` (default `mine.powHash`), `blockHash(height) -> Promise<hex>` (default `esplora.blockHash`), `mineDifficulty(assetId, ref, height) -> { dEff: bigint, source: "YOU" | "IDX", detail? } | null` (own replay first, else the indexer's log entry `difficulty`, labelled IDX with a trust note).

`planSteps("MINE")` / `planSteps("MINE_SCRIPT")` rows, in order (ids are stable):
HEAD rows, `extdata`, `points`, `vkey`, `["terms", "Mining terms read from the deploy transaction", "BTC"]`, `["window", "Reference block inside the 12-block window", "YOU"]`, `["refhash", "Reference block hash", "BTC"]`, `["work", "Work recomputed (Argon2id)", "YOU"]`, `["difficulty", "Difficulty the work must meet", "IDX"]` (source becomes YOU with a replay), `["bound", "First input is the bound coin" | "Spends from the bound address", "BTC"]`, `["fees", "Service fee paid in this transaction", "BTC"]`, `root`, `groth16`, `indexer`. `planSteps("DEPLOY_POW")`: HEAD + `["deploy", "Terms valid", "YOU"]` + indexer. `classifyReason` treats `insufficient work`, `reference outside window`, `underpaid service fee`, `MINE not bound …` as checked.

### 8.5 `web/src/verify/*` and `web/src/share/live-check.js`

- `web/src/verify/pow.worker.js` (new, LF): `{ id, password: hex80 }` → `{ id, powHash: hex64 }` or `{ id, error }`; `engine.js` and `live-check.js` pass a worker-backed `ctx.powHash` (never Argon2 on the page's main thread) and `ctx.mineDifficulty`.
- `replay.worker.js`: the `Indexer` uses `inlinePow` (it already is a worker); claims are counted next to proofs (`claims`, `claimMs`) and `/verify` shows ms per claim.
- `replay.js`: the key already includes `DIGEST_V` (now 2), so saved replays restart once; `/verify` says why ("The verifier's digest format changed in this release; the replay starts over once.").
- `pool-data.js`: `assetById(id)` falls back to `api.mine()` assets (web track adds it, §10.9) and returns rows with `kind`.

## 9. Relayer track

### 9.1 Config (`server/relayer.mjs` `DEFAULTS`, env names)

```js
mineEnabled: true,          // RELAY_MINE_ENABLED   (still off until mining is active at idx.height + 1)
mineFeeHeadroom: 1.25,      // RELAY_MINE_FEE_HEADROOM: carrier rate = ceil(next-block rate x headroom)
mineEstVsize: 684,          // RELAY_MINE_EST_VSIZE
invalidPowSats: 20,         // RELAY_INVALID_POW_SATS: margin penalty for refused work
powQueueMax: 64,            // RELAY_POW_QUEUE: pool tasks queued before "busy"
mempoolLookupsPerTick: 50,  // RELAY_MEMPOOL_LOOKUPS
```
Next-block rate: `GET {base}/v1/fees/recommended` `fastestFee` when the client is mempool.space-like (`esplora.requestUrl` exists and `base` ends in `/api`), else `esplora.feeRate()`. The `fee_high` cap applies to that rate. `STATE_VERSION` stays 2 and `BOOKS_VERSION` stays 1: new fields are optional on load.

### 9.2 `GET /api/relay/info` gains `mine`

```json
"mine": { "enabled": false, "code": "mine_disabled", "bindScriptHash": "<hex sha256(C.script)> | null",
          "modes": ["fast", "block"], "slack": 2, "estVsize": 684, "feeRate": 2, "carrierFeeSats": 1368,
          "marginSats": 137, "invalidPowSats": 20 }
```
`info.fees`, `info.stats` and every other existing key are unchanged. A claim's quote = `carrierFeeSats + Σ service sats of the asset + marginSats`.

### 9.3 Submit pipeline for MINE_SCRIPT (`POST /api/relay/submit`, same signed body)

`parseSubmit` accepts envelope hex of 471 or 511 bytes. Steps, first failure answers, nothing mutates before acceptance except the replay record and penalties:
0. parse; 1. gate (`gateCode(mode)`, plus `mine_disabled` when mining is not active at `idx.height + 1` or `mineEnabled` is false); 2. signature, replay.
3. header op: `TRANSACT` → today's path; `MINE_SCRIPT` → this path; anything else → `not_transact` (message updated, §9.4).
4. balance ≥ claim quote, else 402 `balance_low` (`{ balance, needed, perSend }`).
5. limits: invalid (proof or PoW) count ≥ `invalidPerHour` → `rate_limited`; one PoW check already in flight for this account → `busy`; `pool.queued ≥ powQueueMax` → `busy`.
6. decode → `malformed`; mode `fast`/`block`, else `mine_mode`; `bindScriptHash ≠ sha256(C.script)` → `bind_stale` (with `bindScriptHash` in the body); any `requiredFeeOutputs` script equal to C or a deposit script of any account → `mine_unsupported`.
7. `idx.mineStatic(env, idx.height + 1)` and `idx.mineState(env)` → codes by §9.4; `tip > ref + 9` → `expired`; the solution's id pending in this relayer → `solution_pending`; in-flight cap (`issued + reward × (1 + pendingClaims(asset)) > maxSupply`) → `cap_reached`; nullifier pending → `nullifier_pending`.
8. PoW: `idx.minePow(env, idx.height + 1)` through the pool. `insufficient work` → `pow_invalid`, `books.penalize(account, invalidPowSats)`, counted as invalid. A `PowError` → `busy`, no penalty. Stale bound failure counts as `stale_work` when `D(ref)` alone would pass.
9. Proof: `idx.mineProof(env)` under the existing `verified()` limits; failure → `proof_invalid` with the existing penalty.
10. Re-check after the awaits (nullifiers, claimed, root at ref, gates, cap), reserve the quote, persist, answer 202:
```json
{ "id": "…", "status": "queued", "kind": "mine", "ref": 330000, "lastBroadcast": 330009, "deadline": 330012,
  "solutionId": "<hex>", "reservedSats": 2005, "serviceSats": "500", "balance": 4995, "flush": "next-block" | "fast" }
```
`deadline` is the W-M end (`ref + 12`), as `deadline` is the W-1 end for transfers.

### 9.4 Error codes (`ERROR_STATUS`, `MESSAGES`, `codeForReason`)

| Code | HTTP | Indexer reasons | Message |
|---|---|---|---|
| `mine_mode` | 400 | | A mining claim goes with the next block or at once. Batch modes land after the claim's 12-block window. |
| `bind_stale` | 409 | | The relayer's change address changed. Prove the claim again for the new address; your solution still counts. |
| `solution_claimed` | 409 | `solution already claimed` | This solution was already claimed. Mine a new one. |
| `solution_pending` | 409 | | This solution is already in the relay queue. |
| `cap_reached` | 409 | `supply cap reached` | The supply is mined out, counting claims already on their way. Nothing was charged. |
| `expired` | 422 | `reference outside window` | This solution's 12-block window is too close to its end for the relayer to carry it. Mine a new one. |
| `stale_work` | 422 | `insufficient work` against the stale bound only | Difficulty jumped since this solution's block, so it no longer counts. Mine a new one. |
| `pow_invalid` | 422 | `insufficient work` | The work in this claim does not meet the token's difficulty. A small penalty was taken from your relay balance. |
| `mine_unsupported` | 422 | | The relayer cannot carry claims of this token: a fee address belongs to the relayer. Pay the fee yourself. |
| `mine_rejected` | 422 | `unknown asset`, `asset is not mined`, `mining not started`, `mining closed`, `mining ended`, `reward differs from terms`, `unknown reference block` | This claim cannot land: REASON. (extra `{ reason }`) |
| `mine_disabled` | 503 | | The relayer is not taking mining claims right now. Pay the fee yourself. |
| `not_transact` | 400 | | The relayer carries private transfers and mining claims bound to its change address. Mints and launches are paid from your own BTC wallet. |

Existing codes keep their texts.

### 9.5 Items, deadlines, precheck

MINE item: `{ id, kind: "mine", status, mode, anchor: ref, ref, root, asset (string), solutionId, powHash (hex), nullifiers, serviceOutputs: [{ script (hex), sats (number) }], serviceSats (number), acceptedHeight, envelope, account, reservation, attempts }`. Transfer items have no `kind`.
- `deadlineOf(mine item) = ref + MINE_WINDOW − 1 − MINE_SLACK` (= ref + 9): last tip at which a carrier is **signed**. Journaled (`signing`) bytes are re-broadcast only while `tip ≤ ref + 11`; after that the item is `expired` (charge refunded only if it never reached the network, per today's `failedBroadcast` rules).
- `precheck(mine item)`, before signing, drops (`finalize(item, "dropped" | "expired")`, reservation released) when: past `deadlineOf`; nullifiers spent; `solutionId` in `idx.claimed`; cap reached counting in-flight claims; root at `ref` changed and `minePow` now fails; `meetsTarget(powHash, effectiveDifficulty(asset, ref, idx.height + 1))` is false (`stale_work`).
- `GET /api/relay/status/:id` for a MINE item adds `kind`, `ref`, `lastBroadcast`, `deadline`, `solutionId`, `serviceSats`.
- `pendingClaims(assetId)`: this relayer's MINE items in `queued | signing | broadcast` without a verdict, plus mempool claims of that asset not carried by it (`esplora.mempoolTxids()` when the client has it, else `GET /mempool/txids`; at most `mempoolLookupsPerTick` new `txHex` lookups per tick; cache txid → `{ asset, solutionIdHex } | null`; best effort).

### 9.6 Carriers and I-PAY (I0, I1, I2)

- Carrier layout: output 0 OP_RETURN; the outputs after it that do not pay C are exactly `requiredFeeOutputs(asset)` from **its own indexer's asset terms and `MINE_FEE`**, in that order, amounts `carrierAmountOf(script, sats)`; the change to C sits at a random position after output 0 (L5). Never from the request. The indexer's fee check matches outputs by script, so the position does not matter for validity.
- Funding: confirmed C coins only (`coin.confirmed === true`). The change of a MINE carrier is recorded with `thirdParty: true` and is not spendable until confirmed (`spendableCoins` excludes `thirdParty && !confirmed`). Fee rate: `ceil(nextBlockRate × mineFeeHeadroom)`. Never bumped.
- `assertOutputs(tx, kind, envelope, feeOutputs = [])`: output 0 is the envelope; the outputs after it that do not pay C equal `feeOutputs` exactly and in order (script and amount); the change to C may sit anywhere after output 0.
- `signPoolTx({ …, feeOutputs })`: `fee = feeOf(tx)`, `service = Σ feeOutputs`, `spent = Σinputs − Σ outputs to C`; refuse unless `spent === fee + service`; `books.settle(ref, { fee, service })` before signing.
- Books (`server/relay-books.mjs`):
  - `settle(ref, { fee, service = 0 })` → `cost = fee + service + marginFor(fee)`; returns `{ cost, fee, margin }` plus `service` only when `> 0`; the charge record gains `service` only when `> 0`.
  - `refundCharge(ref)` reverses `service` too (`serviceOut −= service`); `reclaim(sats, { service = 0 })` moves a reached-network-then-vanished carrier's fee **and** service back to the margin.
  - `availableMargin()` counts pending margins as `cost − fee − (service ?? 0)`.
  - New property `serviceOut` (outside `totals`); `toJSON()` writes `serviceOut` only when non-zero; `restore()` reads `data.serviceOut ?? 0` (a safe integer ≥ 0, else `invalid`).
  - `checkI2`: `credited − fees − serviceOut − Σ balance − Σ reserved = margin ≥ 0`; the result gains `serviceOut`; existing problem strings are unchanged when `serviceOut` is 0.
- Ledger entries of MINE carriers gain `serviceSats`; transfer rows are unchanged.

### 9.7 `server/indexer-server.mjs`

- `main()` creates the pool with `createNodePowPool()` and sets `idx.pow = pool` after `loadIndexer()`, before the first sync; the relayer uses the same indexer and pool. A pool that fails its self-test is logged and left in place: blocks that need PoW then fail and retry (never a verdict), all else keeps working.
- `/api/assets`: `kind: "mint"` rows only (unchanged shape plus `kind`). `/api/assets/:ticker`: either kind (`kind: "pow"` rows have the mined view below).
- `/api/blocks`: `ops.mine` only on rows with at least one accepted claim; DEPLOY_POW counts as `deploy`.
- `/api/digest`: `version` key only when `digestVersionAt(height) ≥ 2` (D4).
- `GET /api/mine`: `{ activation: { height, active }, tip: { height, hash }, assets: [MinedView] }`.
- `GET /api/mine/:asset` (`:asset` = decimal id or ticker; 400 `bad_request` for neither, 404 `not_found` for unknown or not mined):
```
MinedView + { tip: { height, hash }, window: 12, staleFactor: 4, pendingClaims: number | null,
  hashrateEstimate: number, series: { difficulty: [[h, "D"]], claims: [[h, n]] } }   // last 144 blocks
MinedView = { asset, kind: "pow", ticker, divisibility, status, deployTxid, deployHeight, bodyHash,
  mineStart, startHeight, endHeight, span, targetPerSpan, reward: rewardAt(tip), baseReward, halvingInterval,
  nextHalving, difficulty: D(tip), staleFloor: D(tip)/4, target: targetHex(D(tip)), initialDifficulty,
  minDifficulty, issued, maxSupply, claims, rejectedClaims, feeSats, burnedFeeSats, claimFeeSats,
  treasury, treasuryAddress, feeOutputs: [{ script, address, sats, role }], firstClaimHeight,
  claims144, flags: { lowFloor, recipientDiscount } }
```
Bigints are decimal strings; `recipientDiscount` is true whenever any fee output exists (the platform mines cheaper). Pending claims come from `relayer.pendingClaims(asset)` (null without a relayer). Views are computed once per published view.

### 9.8 Docs

`docs/API.md`: the endpoints above, `info.mine`, the submit body and errors. `docs/design/relay-balance.md`: I-PAY extended (service-fee outputs are user-debited before signing), I0/I1/I2 as in §9.6, the mining privacy paragraph of §12.

## 10. Web track

### 10.1 `web/src/session.js` (CRLF)

- Keys from `feeKeysOf(entropy)`: `localPayer` (transfers, unchanged) and a separate `minePayer` (LocalPayer over `mineFeeKey`). Mining coins never pay transfers or top-ups; moving coins between the two keys asks first.
- `assetList` merges `/api/assets` with `/api/mine` assets (`kind` kept), so balances, portfolio and send work for mined tokens.
- Claim lifecycle: `prepareClaim` on each new tip and after each solution; found → reference re-check (`powHashReference` against the block hash at `ref` from its own esplora client, and `D_eff` from its own replay when present) → window, stale and cap checks (cap with `pendingClaims` from `/api/mine/:asset`) → bind (`outpoint` of a coin of the mining key chosen now | `sha256(Unisat payer script)` | `info.mine.bindScriptHash`) → prove → submit → track.
- W-M: history entry `{ kind: "mine", id, via: "relay" | "self" | "unisat", ticker, assetId, reward, ref, solutionId, commitments, spends (rolled nullifiers), lockUntil: ref + 12, status: "proving" | "submitted" | "landed" | "expired" | "rejected" | "dropped", txid?, relayId?, at }`; a solution is submitted once by one route; rolled notes stay locked until it lands or `ref + 12` passes. A relayed claim offers no "pay the fee myself" fallback while pending.
- `prepareCoins(n)`: `planSplitTx` with the mining key.

### 10.2 `web/src/mine-worker.js` (new, module worker)

```
in  { type: "start", challenge: hex64, target: hex64, nonceStart: hex16, step: 1, progressMs: 1000 }
in  { type: "stop" }
out { type: "ready", ok, impl: "hash-wasm" | "noble" | null }        // after selfTest()
out { type: "progress", hashes, ms }
out { type: "found", nonce: hex16, powHash: hex64, hashes }           // then it idles until the next "start"
out { type: "error", message }
```
Uses `grindRange` from `src/mine.mjs` in slices; each worker starts at a random 8-byte nonce. `impl: "noble"` → page says "Slow mode: this browser's fast hash failed its test." (about 10× slower); `ok: false` → "This browser computed a test hash wrong; mining is off."

### 10.3 `web/src/views/app-mine.js` (new), route `/app/mine`

Token picker (`status === "mining"`), panel (reward, difficulty, network hashrate estimate, issued / max, reference block, cost per claim = `684 vB × next-block rate` + service fee (+ relay margin)), Start / Stop, threads slider `1 … hardwareConcurrency − 1` (default half), auto-submit (on), route selector (relay default when the balance covers a claim; built-in mining key; Unisat). Live figures: tab H/s (10 s average), expected time per solution `D / H`, chance in the next block `1 − exp(−600 × H / D)`, solutions with status, reward earned. Polls `/api/mine/:asset` every 15 s. Copy from §12.

### 10.4 `web/src/views/app-launch.js` (CRLF)

A "Mined" option: reward, max supply, solutions per block (`S = perBlock × span`), span (default 24), expected launch hashrate (default 2,000 H/s) → suggested initial difficulty, floor (default initial / 16, ≥ 256), optional halving, the start as exactly two choices ("Start mining now", or "Start after N blocks" with N ≥ 1, encoded as startHeight = tip + 1 + N; the start hint sits next to them) and end (the launch must confirm by the end block). The claim fee field is shown fixed at 0 with the platform fee stated (D2 policy). Disclosures: noise, surge, recipient discount (§12). Builds `encodeDeployPow`.

### 10.5 `web/src/views/token.js` (LF) and `explorer.js` (CRLF)

Token page for `kind: "pow"`: reward now, next halving, issued / max (progress), claims, difficulty, stale floor, span and target per block, hashrate estimate (labelled estimate), difficulty and claims charts from `series`, rejected claims, `feeSats`, `burnedFeeSats`, mining start, flags ("Low floor", "Recipient mines cheaper") and the fairness copy. Explorer: MINE entries show token, reward, reference height and difficulty, never a recipient; DEPLOY_POW as a launch.

### 10.6 `web/src/views/app-shared.js` (CRLF)

The relay copy "It cannot see amounts, tokens or recipients" is never shown for mining; the mining relay copy of §12 is. The top-up warning ("fewer than 5 relayed items since your deposit confirmed") counts relayed claims.

### 10.7 Routing and nav (`web/src/app.js`, CRLF; `router.js` only if needed)

Route `["/app/mine", "app-mine", "app", "Mine"]`; nav and tab bar gain Mine next to Mint.

### 10.8 Styles (`web/src/styles/*`)

Use existing tokens and components; new classes are prefixed `mine-`.

### 10.9 Narrow additions outside the brief (D12)

- `web/src/api.js`: `export const mine = ({ signal, fresh = false } = {}) => cached("mine", 15000, () => request("/api/mine", { signal }), { fresh })` and `export const mineAsset = (idOrTicker, { signal } = {}) => request(`/api/mine/${encodeURIComponent(String(idOrTicker).toUpperCase())}`, { signal })`, both also on the `api` object.
- `web/src/relay.js` `auditRelayer`: a carrier whose OP_RETURN decodes as MINE_SCRIPT bound to the relayer's address and whose other outputs are C plus the fee outputs of that asset (from `/api/mine`) is a `"mine"` row and `ok`; its ledger `fee` excludes the service sats. Nothing else in `relay.js` changes.
- `web/src/views/app-activity.js`: `KIND.mine = "Mined"`, `KIND_ICON.mine = "mint"`.

## 11. CLI track (`bin/murkle.mjs`, CRLF)

- `murkle deploy-pow <wallet> --ticker T --reward N --max-supply N [--divisibility d] [--span 24] [--per-block 1] [--difficulty D | --hashrate H] [--min-difficulty D] [--halving n] [--start now | --start-after N] [--end h] [--fee-rate r] [--dry-run]`: defaults from `LAUNCH_DEFAULTS`; `--start now` (the default) opens mining at the launch block, `--start-after N` (N ≥ 1) encodes startHeight = tip + 1 + N, `--start` takes no other value and the two flags exclude each other; `--claim-fee` / `--treasury` are refused under the current fee policy with the D2 reason; prints the terms, `mineStart`, the platform fee and the disclosures before paying with the wallet's BTC fee key.
- `murkle mine <wallet> <TICKER> [--threads N] [--pay key|relay] [--max-claims n] [--max-fee-rate r] [--prepare-coins n] [--esplora url] [--relay url]`:
  - `worker_threads` through `createNodePowPool({ size: threads })` `grind` tasks, after the self-test;
  - a new `prepareClaim` on each new tip and after each solution; the same reference re-check, window, stale and cap checks as the page (block hash from its own esplora client);
  - `--pay key` uses a separate mining key: wallet file field `mineKey` (32 random bytes, created on the first `mine` or `--prepare-coins`), never `btcKey`; `--pay relay` uses the relay balance (`info.mine`), never falling back to self-pay for a pending relayed claim;
  - W-M entries in the wallet file's `pending` list with `kind: "mine"` and `lockUntil`;
  - prints H/s, solutions, claims landed and fees spent; refuses before paying when the claim cannot land.
- `murkle audit --compare`: when the first differing height is where `digestVersionAt` changes, print `digest version changes at H (vA -> vB): the other side runs a different release` instead of pointing at a transaction.
- `README.md`: both commands. `docs/CLAIMS.md`: the mining disclosures and never-say list of §12. `audit/REPORT.md` (a "Mining addendum"): invariants **W-M** (wallet), **I-PAY extended** (I0/I1/I2 with service outputs and `serviceOut`), **M-ACT** (pre-activation byte identity), **M-ERR** (errors never verdicts), **M-ORD** (bad PoW never reaches Groth16 or a prevout lookup; a bad proof never reaches a prevout lookup), **M-POOL** (no Argon2 on the server's event loop), **M-FEE** (fee outputs from the relayer's own indexer terms, never from the request), each with its tests.

## 12. Copy (exact strings; every surface uses them)

- Relay route: "The reward goes to a private note. Chain observers see relay claims of TICKER for R each, not who received them. The relayer can link the address you top up from to every claim it carries for you, including the token and the reward. While few people relay claims, the claims right after your top-up are easy to tie to it. Top up before you start mining."
- Built-in key or Unisat: "Claims are public: token, reward and the paying address. Anyone can add up what this address mined, and the transfers it pays for later."
- "A single GPU or a server miner can be thousands of times faster than this tab. Anyone can rent many computers."
- "Every claim pays a Bitcoin fee and a service fee of 500 sats to the Murkle platform address. Its own claims cost it 500 sats less." (amount and recipient from `MINE_FEE`)
- "Bitcoin miners choose what goes into blocks and in what order. They can delay a claim until it expires."
- Near the cap: "Supply is nearly mined out. A claim that lands after the cap is rejected; its Bitcoin fee and its service fee are still spent."
- "A claim must land within 12 blocks of the block it references."
- "Difficulty jumped. Solutions found before the jump may no longer count; the wallet checks before paying."
- "The fee recipient can block a fee bump, so the wallet pays a next-block rate up front."
- "Test coins, no value." Phones: "Mining keeps the processor busy: expect battery drain and heat."
- Launch: "Difficulty is noisy: with few solutions per span, emission runs a few percent above target." and "After a quiet period or a hashrate jump, the first block can carry many claims."
- Never: "anonymous", "untraceable", "trustless", "mixer", "free", "sponsored", "fair launch guaranteed".

## 13. Tests (each track's file; every case is required)

**core** `test/mine-vectors.test.mjs`: noble reproduces RFC 9106 §5.3; hash-wasm reproduces the no-AD variant; every vector of `mine-vectors.json` with noble and hash-wasm (challenge, solutionId, powHash, target, valid); 64 concurrent hash-wasm calls equal sequential noble; `SELF_TEST_VECTORS` ⊂ the file; a forced hash-wasm mismatch disables the fast path; a throwing reference makes `powHash` throw (never a value); `PowPool`: `ready()`, `hash`, `hashMany` dedup, a killed worker rejects with `PowError` and is replaced, `POW_BUSY`, `POW_CLOSED`; `stepDifficulty` / `difficultyAt` vectors (0, 1, n quiet blocks lazy = eager; one claim; 1,700 claims; floor; `D_MAX`; equilibrium); `rewardAt` halving to 0; `requiredFeeOutputs` for the three policies and same-script summing; `checkFeePolicy` with the owner's constants; params: platform address decodes to `platformScript`, `ACTIVATIONS` valid, `MINING_HEIGHT === null`.

**core** `test/mine-indexer.test.mjs`: the §7.2 identity cases; encode/decode lengths 515 / 511, DEPLOY_POW bounds and trailing bytes; the D6 gate (truncated op 9, version-1 op 7); a claim lands and the reward is found by `scan`; two rolled inputs (issued grows by the reward only; old nullifiers spent); a rejected claim spends nothing; copy in another transaction rejected and nothing consumed; re-proved same solution rejected (`solution already claimed`); verbatim duplicate rejected by nullifiers before Argon2; window edges (ref = H − 12 accepted; H − 13 and H rejected; ref < mineStart rejected); the start: a claim referencing the launch block itself accepted when starting now, a reference before the launch block rejected, with a delay N references before launch + N rejected and at launch + N accepted; stale bound accept/reject; cap reached mid-block in tx order with `burnedFeeSats`; MINT on a mined asset and MINE on a paid asset rejected; shared ticker namespace; spies: bad PoW never calls `verifyGroth16` or `prevoutScript`, a bad proof never calls `prevoutScript`; a throwing `pow.hash` and a dead pool worker: the block is retried, not rejected; pre-pass: 1,000 copies of one solution evaluate Argon2 once; randomized reorgs restore every mining field, `dPts` and `claimed`; pruning across a 144-block rollback; digest v2 golden vectors (before `mineStart` and in a block with claims); snapshot v3 round trip; v2 → v3 migration equals a fresh replay; `restore()` refuses differing activations at or below the snapshot height.

**client** `test/mine-client.test.mjs`: two drafts on one tip share no commitment or nullifier; `finalizeClaim` with two binds keeps the `solutionId`; W-M lock and unlock of rolled notes; `feeKeysOf` keeps `feeKey` byte-identical to today's derivation and `mineFeeKey` differs; `planSplitTx`, `carrierAmountOf`, `mineCarrierVsize`; `verifyTx` on a MINE carrier (all rows ok; a wrong ref hash fails `work` as a rule; a missing fee output fails `fees`); `planSteps("MINE")` ids; the replay key changes with `DIGEST_V`.

**relayer** `test/mine-relayer.test.mjs`: only the current C bind accepted (`bind_stale`); batch modes refused (`mine_mode`); fee script = C or a deposit script refused (`mine_unsupported`) before any debit; fee outputs taken from its indexer, not the request; the debit covers fee + service + margin before signing; I2 with `serviceOut` under random sequences including a refused broadcast on a MINE carrier (refund reverses `serviceOut`); `signPoolTx` refuses any other output; bad PoW refused before proof verification, penalized, rate-limited; PoW never runs on the main loop (the pool is called, `powHash` is not); `cap_reached` with in-flight claims, `expired`, `stale_work`, `solution_pending`, `solution_claimed`; an item retried across blocks is never signed after `ref + 9` nor broadcast after `ref + 11`; MINE carriers use confirmed coins only and their change is not spent before confirmation; `info.mine`; `/api/mine`, `/api/mine/:asset`, `/api/digest` with and without `version`; books load a file without `serviceOut`.

**web** `test/mine-web.test.mjs`: the worker protocol (start, progress, found, stop; noble fallback message; refusal message); workers restart on a new tip and after each solution; the reference re-check disables a fast path that disagrees; W-M persisted in history; the mining key differs from the transfer key and mining coins never pay transfers; route copy per route (relay copy never says "cannot see … tokens"); every new string passes the `english.test.mjs` lists; `/app/mine` routed; launch form defaults and suggested difficulty; token page renders a `kind: "pow"` row; `auditRelayer` accepts a MINE carrier.

**cli** `test/mine-cli.test.mjs`: `deploy-pow` builds the expected envelope and refuses a claim fee; `mine` against a fake chain end to end (self-pay with `mineKey` and relay), new challenge per tip and per solution, W-M entries, refusal before paying when the claim cannot land, `--prepare-coins`; `audit --compare` prints the version-change line; README, CLAIMS and REPORT contain the new sections and no banned words.

## 14. Done means

All six new test files pass, `npm test` passes, line endings are as in §1.2, no file outside §1.1 changed (diff against the pre-mining snapshot), `src/pins.json` still has `"height": null` for mining, and the live digests (v1) are unchanged.

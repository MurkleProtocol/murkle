# Mainnet readiness: design and build contract

Status: **contract for four parallel build tracks** (headers, network, ceremony, deploy). Nothing here says mainnet is live. Signet stays the default network and must behave byte for byte as before.

Precedence: `SPEC.md` (consensus) first, then this contract for the interfaces it defines, then the other design notes. Where this file and the code disagree after the build, the code and its tests win and this file gets an "as built" note.

Contents

1. Ground rules for every track
2. Shared decisions (summary)
3. Workstream A-9: verify the chain (track **headers**)
4. Workstream mainnet configuration and V2-02 (track **network**)
5. Workstream A-8: trusted-setup ceremony (track **ceremony**)
6. Workstream deployment kit (track **deploy**)
7. Consensus implications and the proof that signet stays identical
8. Environment variables (complete list of new and changed names)
9. Strict file ownership
10. Cross-track hooks (who implements what for whom)
11. Integration step (after all tracks)

---

## 1. Ground rules for every track

These repeat the owner's hard rules and add the ones parallel work needs.

- A dev server runs live from this checkout on signet (indexer `:8787` with the paid relayer, Vite `:5173`). Do **not** start, stop or kill it. Do not bind ports 8787 or 5173; tests listen on port 0.
- Do **not** write to `data/signet/` (read-only copies into a temp dir are fine), `web/dist/` (the live indexer serves it: never run `npm run web:build` without `--outDir <temp dir>`), `build/` (read only; the real ceremony dry run reads `build/` and writes to a temp dir), `src/pins.json` (byte-identical, see §7), or `web/src/facts.json` (regenerated only in the integration step; `scripts/facts.mjs` has `--out`).
- Vite on `:5173` serves `web/src` and `src` from disk. A page reload picks up whatever is on disk, so write whole, working files; never leave a half-edited module longer than one edit.
- Nothing is broadcast, on any network. No mainnet transactions. Read-only GETs to mempool.space (signet and mainnet) are allowed, for fixtures only; tests must run offline from committed fixtures.
- No browser wallets. Never write recovery phrases, passwords or private keys into files, logs or fixtures (tests generate throwaway keys in temp dirs).
- English only. Copy never says "trustless", "anonymous", "untraceable", "mixer", "audited" (use "internally reviewed" / "no external audit yet"), "mainnet-ready", "live on mainnet". Mainnet is described as "not launched" until a genesis is pinned for it (and §4.9 copy rules after that).
- Keep each file's line endings. Before editing, check with node: `node -e "const b=require('fs').readFileSync(p);console.log(b.includes(13)?'CRLF':'LF')"`. New files use LF.
- Do not change the circuit (`circuits/`), `package-lock.json`, or add dependencies. Everything here is built with what is installed (`@noble/*`, `@scure/*`, `snarkjs` 0.7.5, `vite`).
- **Existing tests are frozen.** A track never edits an existing `test/*.test.mjs`. If an intentional change (for example the A-9 copy) breaks an existing assertion, the track lists it in its final report (file, test name, assertion, why) and the integration step updates it. Keep the token `A-9` in the receipt's inclusion detail so `test/verify-tx.test.mjs` keeps passing (§3.6).
- Cross-track symbols that may not exist yet are imported defensively: `import * as P from "./params.mjs"; const STRICT = P.STRICT_TICKER ?? false;` or a dynamic `await import(...).catch(() => null)` with the legacy behaviour as fallback. A named import of a symbol another track has not written yet is a link error that breaks every test, so never do that across tracks.
- Each track runs its own new test file plus the full `npm test` (with `MURKLE_PRE_MINING_SRC=node_modules/.cache/murkle-pre-mining/src`) before it reports done.

---

## 2. Shared decisions (summary)

| # | Decision | Why |
|---|---|---|
| D1 | `MURKLE_NETWORK=signet\|mainnet`, default `signet`. Node reads the env at import of `src/params.mjs`; the web build bakes it in through a Vite `define` (`__MURKLE_NETWORK__`). An unknown value throws at import. | One switch, fail closed, signet untouched when unset. |
| D2 | Per-network pins: `src/pins.json` stays signet and byte-identical; new `src/pins.mainnet.json` (genesis `null`). | Signet tooling (`build-circuit.mjs`, CI cache key) keeps working; no shared mutable file. |
| D3 | Per-network artifact paths: signet keeps `build/dev/*` and `build/manifest.json`; mainnet uses `build/mainnet/{transaction.zkey,verification_key.json,manifest.json}`; the wasm is shared (`build/transaction_js/transaction.wasm`, same circuit). | Signet artifacts never move; the ceremony output never overwrites the DEV setup. |
| D4 | Shielded address HRP: signet keeps `mrk` (`mrk1…`, every existing address keeps working); mainnet uses **`murk`** (`murk1…`). | Same convention as Bitcoin (`bc`/`tb`): a wallet refuses an address of the other network with a clear message instead of paying it. |
| D5 | Mainnet key derivation is network-separated: on mainnet the HKDF labels for the spend, view and both fee keys are `murkle/mainnet/<name>`; signet keeps `murkle/<name>`. Protocol hashes (digest tags, `mine/v1`, relay tags, note encryption label) do not change. | One recovery phrase used on both networks must not give the same Bitcoin fee key (`tb1p…`/`bc1p…` with the same output key would link signet and mainnet activity publicly). Signet derivations stay identical. |
| D6 | Envelope magic `mrk`, version 0, sizes and all wire formats are the same on both networks. | No circuit or format change; chains are separate anyway. |
| D7 | V2-02 strict ticker applies on mainnet from genesis; signet keeps the historical decoder forever (no activation). | No signet DEPLOY depends on the difference (proved in the integration step, §7); an activation would change `src/pins.json` and the snapshot activation table for no gain. |
| D8 | Header verification (A-9) lives in a new isomorphic module and is wired into the server, the CLI and the browser replay through one `syncIndexer(..., { headers })` option. It never changes block data, so it cannot change a verdict or a digest; it can only refuse a block. | Consensus stays where it is; the check is additive. |
| D9 | On signet the same retarget rules are checked as on mainnet (Bitcoin Core's signet params: 2016-block retarget, no min-difficulty blocks, its own `powLimit`); the BIP325 block signature is **not** checked, and every surface says so. | Matches Core; if the signet fixture at a retarget boundary disproves it, the headers track sets `retarget: false` for signet and documents why. |
| D10 | Checkpoints live in `src/btc/checkpoints.json` (owned by headers), not in the pins files. | No change to `src/pins.json`; one owner. |
| D11 | Bitcoin Core RPC source `src/btc/bitcoind.mjs` with the same method surface as `Esplora`; selected by `MURKLE_BTC_SOURCE=esplora\|bitcoind`. Bitcoin Core needs `txindex=1` (prevout lookups of arbitrary transactions for `MINT_SCRIPT`/`MINE_SCRIPT`), so it cannot be pruned. | Operators index from their own node; Esplora stays the default. |
| D12 | Mainnet `MINE_FEE` entry is a placeholder (`TODO_PLATFORM_ADDRESS`, script `null`); mining refuses to start on mainnet until it is set, and a mining activation height cannot be pinned on mainnet before that. | Consensus fee rule must be complete before it can activate. |
| D13 | Mainnet server refuses to start pre-genesis or with an unpinned verification key (`vkey: null`), unless `MURKLE_ALLOW_PRE_GENESIS=1` for a staging run (still refuses an unpinned vkey). Header verification cannot be switched off on mainnet. | Fail closed on real money. |
| D14 | The ceremony starts from the deterministic phase-2 initial zkey (`snarkjs zkey new` of the pinned r1cs and ptau), not from the DEV contribution. Phase 1 stays the pinned Perpetual Powers of Tau file. Final beacon: the hash of a Bitcoin mainnet block at a pre-announced height, 2^10 iterations. | Anyone can recompute the starting point; the DEV entropy is not in the chain at all. |
| D15 | Signet keeps its DEV phase-2 setup (its genesis ATTEST pins that manifest). A-8 is resolved for mainnet only, by the ceremony. Copy says so per network. | A new signet zkey would break the pinned signet genesis. |
| D16 | Relayer economics on mainnet: same model (prepaid balances, I-PAY: the operator never pays a user's fee, no free mode), per-network defaults (§4.7). | Mainnet fee levels are 1 to 3 orders of magnitude above signet. |

---

## 3. Workstream A-9: verify the chain (track **headers**)

### 3.1 What is verified, and what is still trusted

Verified from the data actually fetched, by the server, the CLI and the browser replay:

- **Linkage**: each header's `prevHash` is the hash of the header below it, from a pinned checkpoint upward.
- **Proof of work**: `hash <= target(nBits)`, with Bitcoin Core's `DeriveTarget`/`CheckProofOfWork` rules (negative, zero, overflow or above-`powLimit` targets are invalid).
- **Difficulty rule** (`GetNextWorkRequired`): at heights that are not multiples of 2016, `nBits` equals the previous header's `nBits`; at a multiple of 2016 it equals Core's `CalculateNextWorkRequired` (actual timespan = time(h-1) - time(h-2016), clamped to [timespan/4, timespan*4], `new = old * actual / 1209600` computed as Core does on 256 bits (product truncated mod 2^256), capped at `powLimit`, re-encoded with `GetCompact` and compared exactly).
- **Timestamps**: `time > median of the previous 11 times` (time-too-old, consensus). `time <= now + 7200` (time-too-new, Core's acceptance rule): a header beyond it is a **retryable** error, never a permanent rejection.
- **Version**: `nVersion >= 2/3/4` above the BIP34/BIP66/BIP65 heights (mainnet 227931/363725/388381; signet 1/1/1), as Core's `ContextualCheckBlockHeader`.
- **Checkpoints**: a header at a checkpoint height must have the pinned hash; verification starts at a pinned base checkpoint.
- **Most work**: when the data source serves a different block at a height already verified, the new branch is fetched from the fork point, verified, and accepted only if its cumulative work is **strictly greater** than the branch already held (Core keeps the first-seen chain on ties). Otherwise the sync refuses to roll back and reports `less-work`.

Still trusted, stated on every surface that shows a chain check:

- A single data source can **withhold** blocks or a better chain, or delay them. It cannot forge mainnet proof of work cheaply. Running your own node (the bitcoind source) removes the third party; the server can be pointed at one, the browser cannot.
- **Signet**: a signet block is valid because of the signet operator's signature (BIP325), which is **not** checked. Signet proof of work is nearly free, so on signet the header check mainly catches broken or inconsistent data, not a determined forger.
- Blocks below the base checkpoint are not header-checked (nothing Murkle cares about is there: the base is at or below the genesis activation height).

### 3.2 `src/btc/headers.mjs` (new, isomorphic, depends only on `@noble/hashes`, `../bytes.mjs`, `../params.mjs`)

```js
export const RULES = {
  mainnet: { network: "mainnet", powLimit: 0x00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffffn,
             interval: 2016, targetTimespan: 1209600, targetSpacing: 600, retarget: true,
             versionFloor: [[227931, 2], [363725, 3], [388381, 4]], maxFutureSecs: 7200,
             validity: "pow" },
  signet:  { network: "signet",  powLimit: 0x00000377ae000000000000000000000000000000000000000000000000000000n,
             interval: 2016, targetTimespan: 1209600, targetSpacing: 600, retarget: true,
             versionFloor: [[1, 4]], maxFutureSecs: 7200,
             validity: "pow+signet-signature-unchecked" },
};

/** 80 bytes (Uint8Array or hex) -> header fields; throws HeaderError("data") on length. */
export function decodeHeader(bytesOrHex) -> {
  bytes: Uint8Array(80), hash: string /* display hex */, prevHash: string, merkleRoot: string /* display hex */,
  version: number /* int32, signed */, time: number, bits: number, nonce: number }

export function targetFromBits(bits) -> { target: bigint, negative: boolean, overflow: boolean }   // Core SetCompact
export function bitsFromTarget(target: bigint) -> number                                          // Core GetCompact
export function workOf(bits) -> bigint            // 2^256 / (target + 1), 0n for an invalid target
export function medianTimePast(times: number[]) -> number   // median of up to 11 values, as Core (sorted, middle)
export function nextBits(rules, { height, prevBits, prevTime, firstTime }) -> number
  // height = height of the header being checked; firstTime = time at height - 2016 (only read at boundaries)
export function checkPow(header, rules) -> void   // throws HeaderError("pow" | "bits-range")
export function maxTargetAt(rules, checkpoint, height) -> bigint
  // min(powLimit, target(checkpoint.bits) * 4^ceil(|height - checkpoint.height| / 2016)): the easiest
  // target any valid header at `height` can have given the pinned checkpoint (receipts, §3.6)

export class HeaderError extends Error {
  // code: "data" | "linkage" | "pow" | "bits-range" | "bad-diffbits" | "time-too-old" | "time-too-new"
  //       | "bad-version" | "checkpoint" | "conflict" | "less-work" | "below-base" | "source"
  constructor(code, message, { height = null, retryable = false } = {})
}

export const CHECKPOINTS;   // the parsed src/btc/checkpoints.json: { signet: Checkpoint[], mainnet: Checkpoint[] }

export class HeaderChain {
  constructor({ network = NETWORK, rules = RULES[network], checkpoints = CHECKPOINTS[network],
                base = null /* a Checkpoint; default: baseFor(startHeight) */, startHeight = null,
                now = () => Math.floor(Date.now() / 1000), keep = 2400 })
  static baseFor(network, height) -> Checkpoint   // highest base-capable checkpoint at or below height; throws "below-base"
  get network(); get base();             // the base checkpoint
  get height(); get hash();              // verified tip (base.height before anything is appended)
  get work();                            // bigint, cumulative work from base (exclusive) to tip
  has(height); hashAt(height); timeAt(height)
  append(height, header) -> decoded      // header: Uint8Array(80) | hex. Rules:
     // height === base.height: hash must equal base.hash (no other check), no-op if already there
     // height <= this.height:  hash must equal hashAt(height) (no-op) else HeaderError("conflict")
     // height === this.height + 1: full verification (§3.1), then appended
     // otherwise HeaderError("linkage")
  async catchUp(source, toHeight, { onProgress } = {})   // fetches and appends this.height+1 .. toHeight
  async alignTo(idx, source)             // see §3.4: makes the chain cover idx's tip with the same hashes
  async offer(source, forkHeight)        // see §3.4: most-work switch or HeaderError("less-work")
  rollbackTo(height)                     // drops headers above height (never below base)
  status() -> HeaderStatus               // §3.5
  snapshot() -> HeaderSnapshot           // §3.5
  static restore(snap, opts) -> HeaderChain   // throws on network/base mismatch or bad data (caller rebuilds)
}
```

Retention: the chain keeps at least the last `interval + 11 + 144` headers (2171; default `keep = 2400`), enough for the next retarget, the MTP and a reorg of `UNDO_DEPTH`. When the window slides, the timestamps the next checks need are kept as context, so verification never needs a header that was dropped.

`Checkpoint` (one entry of `src/btc/checkpoints.json`):

```json
{
  "height": 324592,
  "hash": "0000000418f25af53b4ddd1b227ce058f27672d3352dec005466dcacf38cf715",
  "label": "Murkle signet genesis (ATTEST 4c324438…)",
  "base": {
    "bits": 487902130,
    "time": 1790913499,
    "periodStartTime": 1790905711,
    "prevTimes": [ /* 10 timestamps, heights height-10 .. height-1, ascending by height */ ]
  }
}
```

- `base` is present only on checkpoints that can start a chain. `periodStartTime` is the time of the header at `height - height % 2016` (for 324592 that is block 324576, `0000000141d60082…c3ca`, time 1790905711). `prevTimes` plus `time` give the 11 times for the MTP of `height + 1`. A later checkpoint without `base` only pins `{ height, hash }`.
- Signet: the base is the Murkle genesis block 324592 (hash above, fetched from mempool.space). The headers track fills `prevTimes` from mempool.space and a test checks the whole entry against the committed signet header fixture.
- Mainnet: one pre-launch base at a recent retarget boundary (a height that is a multiple of 2016, e.g. 969696, where `periodStartTime == time`), fetched by `scripts/checkpoint.mjs`. At launch the Murkle mainnet genesis block is added as a second base checkpoint (docs/MAINNET.md step G4).

### 3.3 Data sources

Both sources expose the same surface; everything consensus-relevant is fetched as raw bytes and checked against its hash.

```ts
interface ChainSource {
  // existing Esplora surface, unchanged signatures
  tipHeight(): Promise<number>
  blockHash(height): Promise<string>
  rawBlock(hash): Promise<Uint8Array>
  blockHeader(hash): Promise<string>                  // 80-byte header hex
  txHex(txid): Promise<string>; rawTx(txid): Promise<Uint8Array>   // rawTx checks the txid
  prevoutScript(outpoint36): Promise<Uint8Array>      // cached, txid-checked
  tx(txid): Promise<{ txid, status: { confirmed, block_height?, block_hash?, block_time? } }>  // throws "404 ... not found" when unknown
  txStatus(txid): Promise<{ confirmed, block_height?, block_hash?, block_time? }>               // { confirmed:false } for unknown, as Esplora
  feeRate(): Promise<number>                          // whole sat/vB, >= 1, ~3 blocks
  broadcast(hex): Promise<string>                     // see error contract below
  utxos(address): Promise<Utxo[]>                     // Esplora only (bitcoind: throws "not available")
  merkleProof(txid)                                   // Esplora only (browser receipts)
  // new
  headers(fromHeight, count): Promise<Uint8Array[]>   // consecutive 80-byte headers, ascending; may return fewer at the tip
  nextBlockFeeRate(): Promise<number>                 // whole sat/vB for the next block
  mempoolTxids(): Promise<string[]>
  chainInfo(): Promise<{ chain: "main" | "signet" | string, blocks: number, headers: number | null, ibd: boolean | null }>
}
```

**Esplora (`src/btc/esplora.mjs`, edited)**: adds `headers(from, count)` built from `GET /blocks/:start_height` (Esplora answers up to 10 blocks per call, descending from `start_height`; mempool.space serves the same path). Each header is rebuilt from the JSON fields (`version`, `previousblockhash`, `merkle_root`, `timestamp`, `bits`, `nonce`) and refused unless its double-SHA256 equals `id`, so the JSON view cannot inject a header. Adds `nextBlockFeeRate()` (mempool.space `/api/v1/fees/recommended` `fastestFee`, else `/fee-estimates` target 1 or 2), `mempoolTxids()` (`GET /mempool/txids`), `chainInfo()` (`{ chain: <from the base URL or null>, blocks: tipHeight, headers: null, ibd: null }`). `SIGNET_API` stays exported (it equals `ESPLORA_API`, which becomes per-network). Existing behaviour of every existing method is unchanged.

**Bitcoin Core (`src/btc/bitcoind.mjs`, new)**:

```js
export class Bitcoind {
  constructor({ url, cookieFile = null, user = null, passwordFile = null, timeoutMs = 30_000, retries = 4, retryMs = 500 })
  rpc(method, params = []) ; batch([[method, params], ...])
}
```

| ChainSource method | RPC |
|---|---|
| `tipHeight` | `getblockcount` |
| `blockHash(h)` | `getblockhash h` |
| `rawBlock(hash)` | `getblock hash 0` (hex to bytes) |
| `blockHeader(hash)` | `getblockheader hash false` |
| `headers(from, n)` | batched `getblockhash` then `getblockheader <hash> false` |
| `txHex`, `rawTx`, `prevoutScript` | `getrawtransaction txid false` (needs `txindex=1` for confirmed transactions) |
| `tx`, `txStatus` | `getrawtransaction txid true` (blockhash, confirmations) then `getblockheader` for the height; else `getmempoolentry` (unconfirmed); else unknown |
| `feeRate` | `estimatesmartfee 3 "ECONOMICAL"`: `ceil(feerate * 1e5)` sat/vB; on signet with no estimate: 1; on mainnet with no estimate: throw (never guess) |
| `nextBlockFeeRate` | `estimatesmartfee 2 "CONSERVATIVE"`, same conversion and fallback rules |
| `broadcast(hex)` | `sendrawtransaction hex` (never retried) |
| `mempoolTxids` | `getrawmempool false` |
| `chainInfo` | `getblockchaininfo` (`chain`, `blocks`, `headers`, `initialblockdownload`) plus `getindexinfo` |
| `utxos`, `merkleProof` | throw `Error("bitcoind source: <method> is not available; set MURKLE_ESPLORA for wallet lookups")` |

Error contract (the relayer's `broadcastRaw` classifies by message text, so this is binding):

- A JSON-RPC error object from the node (any HTTP status, Core answers 500 for RPC errors) throws `Error("RPC error <code>: <message>")` with `err.rpcCode = <code>`. It is never retried. So Core's texts ("txn-already-known", "bad-txns-inputs-missingorspent", "too-long-mempool-chain", …) reach `broadcastRaw` inside a message that also matches its `RPC error` branch.
- `getrawtransaction` code -5 ("No such mempool or blockchain transaction") throws a message containing `404 not found` for `tx()`, so `statusOf`'s `/\b404\b|not found|no such/` test works.
- Transport failures (connection refused, timeout, no answer) throw messages **without** `RPC error`; reads retry them with backoff, `sendrawtransaction` never does (unknown outcome, I-PAY journal rules apply).
- Auth: cookie file (preferred) or user plus a password **file**. No password is ever read from an environment variable value, logged or echoed in an error.

**Factory (`src/btc/source.mjs`, new, Node only)**:

```js
export async function openChainSource({ network = NETWORK, read = env, headersPath = null, verifyHeaders = true,
                                        log = console } = {}) -> {
  kind: "esplora" | "bitcoind",
  api,          // the ChainSource; for bitcoind with MURKLE_ESPLORA set, utxos/merkleProof are routed to Esplora
  headers,      // HeaderChain | null (null only on signet with MURKLE_HEADERS=off)
  save(),       // atomically writes headers to headersPath (no-op when null); safe to call every tick
  describe(),   // one line for logs, e.g. "bitcoind http://127.0.0.1:8332 (txindex on), headers from checkpoint 324592"
}
```

- Startup checks for bitcoind: `chainInfo().chain` must match the network (`main` for mainnet, `signet` for signet), `getindexinfo` must show `txindex` synced; otherwise it throws a message naming the fix. During initial block download it logs a warning and indexes only to `blocks`.
- `MURKLE_HEADERS=off` is honoured on signet only; on mainnet it throws ("header verification cannot be turned off on mainnet").
- Headers persistence: `src/btc/headers-store.mjs` (new, Node only): `loadHeaderChain(path, { network, startHeight }) -> HeaderChain` (a missing, corrupt or other-network file gives a fresh chain from the base, with a warning, never a crash) and `saveHeaderChain(path, chain)` (temp file plus rename, the same retry pattern as `saveIndexer`). Default path `data/<network>/headers.json` (`MURKLE_HEADERS_PATH`).

### 3.4 Sync integration (`src/sync.mjs`, `src/btc/block.mjs`)

`parseBlock(raw)` additionally returns `header: Uint8Array(80)` (the first 80 bytes, already hashed there). Nothing else in its result changes.

```js
export async function syncIndexer(idx, api, { onBlock, to, headers = null } = {})
```

With `headers === null` the function behaves exactly as today (byte-for-byte the same calls and results). With a `HeaderChain`:

1. `await headers.alignTo(idx, api)`: if the chain is empty or behind `idx.height`, `catchUp` from its tip to `idx.height`; then for the heights both hold (at most the last `keep`), the hashes must agree with `idx.hashes`. A disagreement is treated as a reorg at that height (step 2).
2. Reorg: the existing walk-back finds the fork `h` (highest height whose hash the source still serves). Before `idx.rollbackTo(h)`, `await headers.offer(api, h)` fetches the source's branch from `h + 1` to its tip, verifies it as in §3.1 from the header at `h`, and switches only if its work is strictly greater than the held branch above `h`. If not, `offer` throws `HeaderError("less-work")` and the indexer is **not** rolled back (the server logs it as `lastError`; the monitor alerts).
3. For each new height: fetch the raw block, `parseBlock`, check `block.hash === hash` and the `prevHash` linkage as today, then `headers.append(height, block.header)` **before** `idx.applyBlock`. A `HeaderError` stops the run (the block is not applied); `retryable` errors (time-too-new, source failures) are retried on the next tick.
4. `onBlock(height, tip, { hash, bytes, envelopes })` is unchanged; the server calls `source.save()` after `saveIndexer`.

`compareDigests` is unchanged.

### 3.5 Shapes

```ts
HeaderStatus = {
  verified: true, network: "signet" | "mainnet", rules: "pow" | "pow+signet-signature-unchecked",
  base: { height, hash }, tipHeight, tipHash, headers: number /* held */, workHex: string /* since base */,
  lastError: { code, message, height } | null
}
HeaderSnapshot = { v: 1, network, base: { height, hash }, height, hash, workHex,
                   from: number /* first held height */, headersHex: string /* concatenated 80-byte headers */,
                   context: { periodStartTimes: { [boundaryHeight]: time }, prevTimes: number[] } }
```

### 3.6 In-browser verification (`src/verify-tx.mjs`, `web/src/verify/*`)

**Pool replay** (`replay.js`, `replay.worker.js`): the worker builds a `HeaderChain` for `NETWORK` from the base checkpoint and calls `syncIndexer(idx, esplora, { to, onBlock, headers })`, so every block the replay applies has its header verified from the pinned checkpoint. The IndexedDB record becomes `{ v: 2, snapshot, spentBy, totals, savedAt, headers: HeaderSnapshot }`; a `v: 1` record is still loaded and its header chain rebuilt with `catchUp` (Esplora `headers()` pages of 10). Progress messages gain `headers: { tipHeight, baseHeight, workHex, rules }` and a `less-work` or other `HeaderError` ends the run with `{ type: "error", code, message }` (never a verdict). New export from `replay.js`:

```js
export async function replayHeaderAt(height) -> { hash, baseHeight } | null   // covered by the user's own verified header chain
export function replayHeaderStatus() -> HeaderStatus | null
```

**Receipts** (`verifyTx` in `src/verify-tx.mjs`): no new step row (plans and existing tests stay as they are). New optional context field:

```js
ctx.headerCheck?: async ({ height, hash, header /* headerFields result */ }) => ({
  level: "checkpoint" | "linked" | "bounded" | "own-target",
  source: "YOU" | "BTC",
  linkedAbove: number,      // headers above it that were checked to link and meet their targets
  detail: string,           // one clause for the inclusion row
})
```

`web/src/verify/engine.js` supplies it, best first:

1. `checkpoint` (source `YOU`): the user's replay covers `height` and its verified hash equals `hash`: "header chain verified by your replay from pinned checkpoint #N (proof of work and difficulty rules)".
2. `linked` (source `BTC`): fetch `k = min(6, tip - height)` headers above it with `esplora.headers(height + 1, k)`; each links to the one below, meets its own target and is at most `maxTargetAt(rules, base, h)`; within one retarget period the bits must be equal, across a boundary the change must stay within the ×4 clamp.
3. `bounded`: the header's own target is at most `maxTargetAt(rules, base, height)` (a forged header needs at least that much work).
4. `own-target`: today's check only (no data for more).

The inclusion row's detail becomes: `merkle path of N hashes rebuilds the header's merkle root · <headerCheck.detail> · A-9: <what is still trusted>`, where the last clause is per network: mainnet "the data source can hide blocks but cannot cheaply forge proof of work; your own node removes it" only for a replay-verified header or bounds that demand at least 2^72 hashes (`hc.strong`), else "the difficulty bounds this far from a pinned checkpoint are weak, so the data source could forge this block with about 2^N hashes; your own node or your replay of the pool removes it" (or, with no header check, "only the header's own proof of work was checked, which the data source can forge cheaply; ..."); signet "signet blocks are valid by a signature that is not checked, and signet proof of work is nearly free". The token `A-9` stays (existing test). Without `ctx.headerCheck` the engine keeps today's wording plus that clause. The `refhash` row of mining claims uses the same `headerCheck` for the reference block.

`headerFields` and the bits-to-target code in `verify-tx.mjs` may be replaced by imports from `headers.mjs` (same owner), provided `headerFields`' exported shape stays.

### 3.7 Tools (headers track)

- `scripts/checkpoint.mjs --network signet|mainnet --height H [--source esplora|bitcoind]`: fetches headers `H - (H % 2016)` .. `H` (and the 10 before `H`), verifies linkage, PoW and bits over that range, prints a `Checkpoint` JSON entry with `base`. Read-only.
- `scripts/replay-compare.mjs --network signet --snapshot <copy of state.json> --out <temp dir> [--headers on|off] [--to H]`: replays from the activation height with the new code into a temp state, compares the digest at every height with the snapshot's digests, prints the first divergence or `identical through H`. Also counts DEPLOY/DEPLOY_POW envelopes whose raw ticker bytes fail the strict rule (V2-02 evidence for §7). Never writes outside `--out`.

### 3.8 Tests (headers track)

`test/headers.test.mjs` (offline, fixtures in `test/fixtures/headers/`):

- mainnet headers around a real retarget boundary (B-1, B, B+1, with a checkpoint whose `base` is B-1's context) and a contiguous run of at least 30 real headers; signet headers covering 324576..324600 (the signet boundary 324576 and the genesis checkpoint), and one signet boundary checked with full context (fixture of at most ~200 KB, binary or hex).
- `bitsFromTarget(targetFromBits(b)) === b` for real bits; Core edge cases (negative bit, overflow, zero, above powLimit).
- every failure code: broken linkage, hash above target, wrong bits mid-period, wrong retarget (off by one in bits), time equal to MTP, time beyond now+2h (retryable), version 3 above BIP65 height, wrong checkpoint hash.
- most work: an equal-work branch is refused, a lower-work branch is refused with `less-work` and the indexer is not rolled back, a higher-work branch is accepted and the indexer is rolled back (fake source).
- `syncIndexer` with and without `headers` gives identical digests on the existing signet fixture block and on synthetic chains.
- snapshot round trip, window sliding across a boundary, restore of another network refused.
- receipt levels: `headerCheck` from a fake replay (`checkpoint`), linked, bounded; the detail keeps `A-9` and the per-network clause.

`test/bitcoind.test.mjs` (a fake JSON-RPC server on port 0): method mapping, batching, cookie auth header, RPC error message format and `rpcCode`, `-5` mapping to `not found`, no retry of `sendrawtransaction`, transport retry of reads, fee conversion (BTC/kvB to sat/vB, ceil, signet fallback 1, mainnet throws), `chainInfo` network mismatch refused by `openChainSource`, `txindex` missing refused, `utxos` routed to Esplora when `MURKLE_ESPLORA` is set.

---

## 4. Workstream mainnet configuration and V2-02 (track **network**)

### 4.1 `src/params.mjs`

Every existing export keeps its name and, on signet, its exact value. New exports:

```js
export const NETWORKS = Object.freeze({
  signet: Object.freeze({ name: "signet", test: true, explorer: "https://mempool.space/signet",
    esplora: "https://mempool.space/signet/api", btcHrp: "tb", addressHrp: "mrk", faucet: "https://signetfaucet.com",
    rpcPort: 38332, unisatChain: "BITCOIN_SIGNET", strictTicker: false, pinsFile: "src/pins.json",
    artifacts: { manifest: "build/manifest.json", vkey: "build/dev/verification_key.json",
                 zkey: "build/dev/transaction.zkey", wasm: "build/transaction_js/transaction.wasm" } }),
  mainnet: Object.freeze({ name: "mainnet", test: false, explorer: "https://mempool.space",
    esplora: "https://mempool.space/api", btcHrp: "bc", addressHrp: "murk", faucet: null,
    rpcPort: 8332, unisatChain: "BITCOIN_MAINNET", strictTicker: true, pinsFile: "src/pins.mainnet.json",
    artifacts: { manifest: "build/mainnet/manifest.json", vkey: "build/mainnet/verification_key.json",
                 zkey: "build/mainnet/transaction.zkey", wasm: "build/transaction_js/transaction.wasm" } }),
});
// Resolution: Node env MURKLE_NETWORK, else the build-time define, else "signet"; anything else throws.
//   const built = typeof __MURKLE_NETWORK__ !== "undefined" ? __MURKLE_NETWORK__ : undefined;
export const NETWORK;                     // "signet" | "mainnet" (existing name, now resolved)
export const NET = NETWORKS[NETWORK];
export const IS_TESTNET = NET.test;
export const BTC_HRP = NET.btcHrp;
export const UNISAT_CHAIN = NET.unisatChain;
export const FAUCET = NET.faucet;
export const STRICT_TICKER = NET.strictTicker;
export const ARTIFACT_PATHS = NET.artifacts;   // repo-relative paths
export const PINS_FILE = NET.pinsFile;
export function mineFeeReady(fee = MINE_FEE) -> null | string   // reason mining cannot run, e.g. "TODO_PLATFORM_ADDRESS"
```

Changed values (mainnet only): `ADDRESS_HRP = NET.addressHrp`, `EXPLORER = NET.explorer`, `ESPLORA_API = NET.esplora`, `STORAGE_PREFIX = "murkle.mainnet"`, the pins (both JSON files imported statically with `with { type: "json" }`, the active one picked by network), `LABELS.spend/view/btcFee/btcMineFee` = `murkle/mainnet/<name>` (D5; `LABELS.note`, `relayPow`, `digest`, `mine` and `digestTag()` never change). `MINE_FEES.mainnet`:

```js
mainnet: Object.freeze({ placeholder: true, platformAddress: "TODO_PLATFORM_ADDRESS", platformScript: null,
  platformSats: 1000n /* proposed; owner confirms */, deployerMinSats: 0n, deployerMaxSats: 0n }),
```

`feeRule` is not applied to a placeholder. `mineFeeReady()` returns `"mining is not configured on mainnet: the platform address is TODO_PLATFORM_ADDRESS"` for it, `null` for a complete rule. The Indexer constructor already calls `assertMineFee` when a mining activation is pinned, so a mainnet build with a mining height and the placeholder cannot start; the server and CLI check `mineFeeReady()` first to print the clear reason.

### 4.2 Pins (`src/pins.mainnet.json`, new)

```json
{
  "manifestSha256": null,
  "artifacts": {
    "wasm": "7b9f73d4c5eccdb982f0a132979f5ceedd0bc08b569b94c022dcf0718ca0fe7d",
    "zkey": null,
    "vkey": null
  },
  "genesisTxid": null,
  "activationHeight": null,
  "activations": [
    { "name": "mining", "height": null, "digestV": 2 }
  ]
}
```

The wasm pin is the signet one (same circuit, same compiler). `zkey`, `vkey` and `manifestSha256` are written by the ceremony's finalize step (`--install`, §5.6) and only while `genesisTxid` is null. `genesisTxid`, `activationHeight` and the mining height are written by hand at launch (docs/MAINNET.md).

### 4.3 Consensus: V2-02 strict ticker (`src/envelope.mjs`, `src/indexer.mjs`)

```js
export function decodeEnvelope(bytes, { strictTicker = STRICT_TICKER } = {})
```

With `strictTicker`, the DEPLOY and DEPLOY_POW ticker field is checked on its raw bytes before any text decoding: length 1..16 and every byte in `0x30..0x39` or `0x41..0x5A`, else `Error("ticker bytes must be 1-16 of A-Z0-9")` (the indexer records `malformed: ticker bytes must be 1-16 of A-Z0-9`). Without it, today's path runs unchanged (TextDecoder, which strips a leading UTF-8 BOM, then the regex). The default follows the network, so every call site (indexer, verify-tx, relayer, wallet) agrees without edits; the Indexer takes `strictTicker` as a constructor option (default `STRICT_TICKER`) and passes it to its three `decodeEnvelope` calls, so tests can run both rules in one process. The only byte strings the two rules judge differently are tickers that start with `EF BB BF` (a BOM) followed by 1..16 valid characters.

### 4.4 Bitcoin addresses and keys

- `src/btc/funding.mjs`: `export const NETWORK` becomes `btc.NETWORK` on mainnet and stays `btc.TEST_NETWORK` on signet (same export name, same meaning: the scure network object).
- `server/relayer.mjs`: the one direct `btc.TEST_NETWORK` (pool script) uses the funding network (the script bytes are the same; only addresses differ).
- `src/keys.mjs`: `decodeAddress` on mainnet given `mrk1…` throws `"This is a Murkle signet address (mrk1…). This wallet is on Bitcoin mainnet."`, and the signet build given `murk1…` the mirror message. Everything else as today.
- `src/wallet.mjs`: `DEFAULT_ARTIFACTS` from `ARTIFACT_PATHS`.
- `web/src/session.js` line 713 derives the fee key with `LABELS.btcFee` instead of `label("btc-fee")` (identical on signet).
- `web/src/keystore.js` and `web/src/config.js`: the legacy `zkpool.signet.*` migration runs on signet only; `LEGACY_STORAGE_PREFIX` is `null` on mainnet.

### 4.5 Server (`server/indexer-server.mjs`) and store (`src/store-node.mjs`)

- `ARTIFACTS` from `ARTIFACT_PATHS`; `DEFAULT_STATE = data/<network>/state.json` (unchanged on signet).
- `loadPinnedVkey`: on mainnet a `null` vkey pin refuses ("mainnet artifacts are not pinned yet: run the ceremony", docs/MAINNET.md).
- Mainnet start refusals (D13): pre-genesis unless `MURKLE_ALLOW_PRE_GENESIS=1`; unpinned vkey always; `mineFeeReady()` reason when a mining height is pinned.
- Chain source and headers (hook H1): `openChainSource({ network: NETWORK, read: env, headersPath })` replaces `new Esplora(env("ESPLORA") || undefined)`; `createApp({ ..., headers, source })`; `tick()` calls `syncIndexer(idx, api, { headers })` and `source.save()` after `saveIndexer`. If `src/btc/source.mjs` is missing (headers track not merged yet) fall back to today's Esplora with `headers = null`.
- `/api/state` gains `chain: { source: "esplora" | "bitcoind", headers: HeaderStatus | null }`.
- `GET /api/health` (new), always 200 while the process serves (liveness; Docker uses it), body:

```json
{
  "ok": true,
  "network": "mainnet",
  "height": 970210, "chainTip": 970211, "lagBlocks": 1,
  "lastSync": 1790913499000, "syncAgeSecs": 12, "lastError": null,
  "source": "bitcoind",
  "headers": { "verified": true, "tipHeight": 970210, "baseHeight": 969696, "lastError": null },
  "relayer": { "enabled": true, "halted": false, "code": null },
  "artifacts": { "ok": true },
  "preGenesis": false
}
```

`ok` is false when `lastError` is set, `lagBlocks > MURKLE_HEALTH_MAX_LAG` (default 3), `syncAgeSecs > 600`, artifacts mismatch, or the relayer is halted. `GET /api/health?strict=1` answers 503 when `ok` is false (for the monitor and load balancers, never for container restarts). `relayer` comes from a new `relayer.health() -> { enabled, halted: boolean, code, problems: string[] }`.
- Web build marker: the server reads `web/dist/murkle-build.json` (`{ network, manifestSha256, genesisTxid }`, written by the Vite plugin, hook H4). A dist built for another network is not served (a plain 503 page naming the mismatch); a dist without the marker counts as signet (today's builds).
- Ceremony page (hook H12b): `GET /ceremony` and `/ceremony/` serve `web/dist/ceremony.html` with the normal headers and CSP when the file exists, else 404. `/ceremony/api/*` and `/ceremony/files/*` are **not** served by the indexer (the reverse proxy sends them to the coordinator; the indexer answers 404 for them).
- Link-preview descriptions: "signet test network, no value" only on signet; mainnet uses neutral text without value claims.

### 4.6 CLI (`bin/murkle.mjs`)

- `DATA = MURKLE_DATA_DIR ?? data/<network>`; artifact paths from `ARTIFACT_PATHS`; `api` from `openChainSource` (CLI headers file `data/<network>/cli-headers.json`), with the same fallback.
- `nextBlockRate(esplora)` prefers `esplora.nextBlockFeeRate()` when present.
- Address output says the network (`(signet; fund it …)` stays verbatim on signet).
- Mainnet pre-genesis: only `new`, `address`, `attest genesis` and read-only commands run; the rest refuse with the pre-genesis reason. `mine` and `launch --pow` refuse with `mineFeeReady()`'s reason.
- New read-only helper `murkle address-script <address>`: prints the scriptPubKey hex of a Bitcoin address of the current network (the owner uses it to fill `MINE_FEES.mainnet.platformScript`).

### 4.7 Relayer economics (`server/relayer.mjs`, `server/relay-books.mjs`)

Defaults become per network; every `MURKLE_*` override still applies; I-PAY, books, journals and invariants are unchanged; there is no free mode.

| Setting | signet (unchanged) | mainnet | Reason |
|---|---|---|---|
| `maxFeeRate` (sat/vB) | 5 | 50 | above it sends answer `fee_high` instead of charging users spike fees |
| `maxFeePerTx` (sats) | 3000 | 45000 | a claim carrier: 684 vB × ceil(50 × 1.25) |
| `minDepositSats` | 2000 | 70000 | `sweepCostFor(50)` (2875) plus two transfer carriers at the 50 sat/vB cap (2 x 32,835): a minimum deposit always pays two sends |
| `marginMinSats` | 50 | 300 | housekeeping (merges, fan-outs) is paid from the margin at mainnet rates |
| `marginPct` | 10 | 10 | |
| `fanoutValue` | 13000 | 130000 | one chain of 21 carriers at about 10 sat/vB |
| `fanoutTarget` / `fanoutMinCarriers` | 24 / 120 | 8 / 40 | less user money parked in fan-out coins |
| `invalidProofSats` / `invalidPowSats` | 50 / 20 | 500 / 200 | the penalty stays meaningful against verification cost |
| `depositConfirmations` | 1 | 3 (existing `DEPOSIT_CONFIRMATIONS`) | |
| fee source | `feeRate()` (~3 blocks); claims: `nextBlockFeeRate()` if the source has it, else today's mempool.space detection | same | bitcoind: `estimatesmartfee` |

`relay-books.mjs` keeps its formulas; only its network validation and messages may change. The relayer's state file already records `network` and refuses another one.

### 4.8 Web build and UI

- `web/vite.config.mjs` (hook H4): `define: { __MURKLE_NETWORK__: JSON.stringify(process.env.MURKLE_NETWORK ?? "signet") }` (validated like params); `build.rollupOptions.input` = `index.html` plus `ceremony.html` **only when that file exists**; dev proxy adds `"/ceremony/api"` and `"/ceremony/files"` to `http://localhost:${MURKLE_CEREMONY_PORT ?? 8790}`; a small plugin writes `murkle-build.json` into the output dir. The define applies to workers too.
- `web/src/config.js`: re-exports `NETWORK`, `IS_TESTNET`, `FAUCET`, `BTC_HRP`, `UNISAT_CHAIN`, `STRICT_TICKER` and the network pins (its fallbacks follow the network too).
- `web/src/payers.js`: `UNISAT_CHAIN` from config; the signet relay-policy notice and its copy only on signet; the mismatch message names the network ("Unisat is no longer on Bitcoin mainnet …").
- Banners and chips: the `SIGNET` chip, faucet links and "no value" disclosures appear only on signet. Mainnet shows its own status:
  - pre-genesis: chip `MAINNET · NOT LAUNCHED`; banner "Murkle has not launched on Bitcoin mainnet. No genesis is pinned, so nothing here can move funds."; wallet actions are disabled (create/import stay possible).
  - after genesis: chip `MAINNET`; disclosures: experimental software, tokens may be worth money and can be lost to bugs; the phase-2 setup from the manifest (`public ceremony <id>, N contributions, beacon block H`: secure if at least one contributor discarded their secret); internal review only, no external audit yet (until one exists); headers checked from a pinned checkpoint, the data source can still hide blocks; mints are public; small anonymity set early on.
  - mining views: "Mining is not configured on mainnet yet." while `mineFeeReady()` returns a reason.
- `web/src/ui/transcript.js` and share texts use `EXPLORER` and the network name instead of literal "mempool.space/signet".
- Signet renders exactly today's strings (existing copy tests must pass untouched).

### 4.9 Documents (network track)

- `SPEC.md`: §1 network selection; §2 mainnet HRP and labels (D4, D5); §7 the strict ticker rule per network (§4.3); §9 per-network pins and genesis; new **§16 Chain data and header verification (non-consensus)** with the rules of §3.1 and the honest limits; §13 drops "light client … not checked yet" for what remains (BIP325, withholding).
- `README.md`: network selection, the new env names (§8), mainnet "not launched" status, A-9 wording per §3.1, link to docs/MAINNET.md, docs/CEREMONY.md, docs/OPERATIONS.md.
- `docs/API.md`: `/api/health`, `/api/state.chain`.
- `docs/design/README.md`: one row for this file.
- `docs/MAINNET.md` (new): the launch checklist below, written out as steps with commands.

**Launch sequence** (each step names its evidence):

- G0 Code freeze: tag the release; `npm test` green; signet replay identity (§7) green.
- G1 Ceremony (docs/CEREMONY.md): announce the schedule and the beacon height; run; close before the beacon height; finalize with the beacon; publish the transcript and every zkey; at least two people outside the project run `scripts/ceremony/verify.mjs` and publish their output.
- G2 Artifacts: `finalize --install` writes `build/mainnet/*` and the mainnet pins (`artifacts.zkey`, `artifacts.vkey`, `manifestSha256`); publish the artifacts release for the mainnet tag (`release-assets` with `MURKLE_NETWORK=mainnet`).
- G3 Header checkpoint: `scripts/checkpoint.mjs --network mainnet --height <recent boundary>` from the owner's node, cross-checked against mempool.space; commit to `src/btc/checkpoints.json`.
- G4 Genesis: the owner (own funds; this is the platform's transaction, not a user's) runs `MURKLE_NETWORK=mainnet murkle attest genesis <wallet>`; after 6 confirmations pin `genesisTxid` and `activationHeight` in `src/pins.mainnet.json` and add the genesis block as a base checkpoint.
- G5 Mining (optional at launch): set `MINE_FEES.mainnet` (platform script from `murkle address-script`, `platformSats`), then pin a mining height above the genesis height. Without it, mining stays off and says so.
- G6 Build and deploy: `MURKLE_NETWORK=mainnet` web build, `deploy/` units, CSP enforced, monitor and backups running, restore drill done.
- G7 Smoke: a browser replay from genesis matches the server digest; receipts for the genesis ATTEST; an owner-paid transfer; a small relay deposit and send; the monitor alert path fires on a stopped indexer.
- G8 Announce with honest copy.

**What the owner must provide**: platform address (P2TR recommended) and the platform fee amount; servers (indexer host: 4+ vCPU, 16 GB RAM, 1.5 TB+ SSD for an unpruned Bitcoin Core with `txindex=1`; ceremony coordinator: small host, 50 GB disk); domain and TLS; Bitcoin Core 30 or later (its default `datacarriersize` relays 471-515 byte OP_RETURN carriers; older or filtering nodes do not); a security contact and the public repository URL (`SECURITY_CONTACT`, `REPO_URL`); the offline backup key; ceremony participants and the announcement; an external audit (go/no-go item, or the copy keeps saying there is none).

**Go/no-go list**: ceremony done with at least one contributor outside the project and an independently verified transcript; `src/pins.mainnet.json` complete and the served artifacts match it; header verification on with the owner's own node; one real mainnet carrier of each size confirmed (OP_RETURN relay policy) before announcement; I-PAY review of relayer settings at current fee levels; backups encrypted, off-site, restore drill passed; monitor alerts tested; CSP enforced; security contact and repository published; copy review (no live claims before G4, no banned words); external audit or an explicit "no external audit" disclosure; signet stays up and unchanged.

---

## 5. Workstream A-8: trusted-setup ceremony (track **ceremony**)

### 5.1 Model

Groth16 phase 2 for the existing circuit. Phase 1 is the pinned public file `powersOfTau28_hez_final_15.ptau` (sha256 `3ef2ecc5…7e7f`, blake2b pinned in `scripts/build-circuit.mjs`). The r1cs must hash to the signet manifest's `sha256.r1cs` (`382e5c0a…335e`). The chain starts at `0000.zkey = snarkjs zKey.newZKey(r1cs, ptau)` (deterministic; anyone recomputes it). Each contribution must be verified against the r1cs and ptau before it is accepted. Security: the final key is sound if at least one contributor generated fresh entropy and discarded it. The coordinator can refuse or delay people (censor) but cannot forge a contribution; every contributor checks that their hash is in the final transcript.

### 5.2 Coordinator (`server/ceremony-server.mjs`, separate process)

```js
export function createCeremonyServer({ dir, r1csPath, ptauPath, slotSecs = 900, heartbeatSecs = 60, maxQueue = 200,
  joinPerHour = 6, trustProxy = false, verify = verifyInChildProcess, chain = null /* { tipHeight() } */,
  now = Date.now, log = console }) -> { server, state(), close() }
// main(): reads MURKLE_CEREMONY_* (§8), listens on MURKLE_CEREMONY_HOST:MURKLE_CEREMONY_PORT (127.0.0.1:8790)
```

State directory (`MURKLE_CEREMONY_DIR`, default `data/ceremony/<id>`; never `data/signet`):

```
ceremony.json     { id, protocol: "murkle", r1csSha256, constraints, ptau: { name, sha256 }, initialZkeySha256,
                    beacon: { height, closeBeforeBlocks: 6, iterationsExp: 10 }, limits: {...}, createdAt }
transcript.json   public, atomic writes (shape in 5.4)
state.json        { queue: [{ ticketHash, name, joinedAt, lastSeen }], slot: { ticketHash, index, deadline } | null,
                    phase: "open" | "paused" | "closed" | "finalized", closed: { at, tipHeight } | null }
control.json      written by scripts/ceremony/admin.mjs: { phase } (read on every request)
zkeys/0000.zkey, 0001.zkey, ...   every accepted key is kept
final/            written by finalize
```

HTTP API (all JSON unless noted; tickets are 32 random bytes as hex, sent only as `Authorization: Bearer <ticket>`, stored as sha256, never logged):

| Method and path | Result |
|---|---|
| `GET /ceremony/api/health` | `{ ok, phase, contributions, waiting, slotActive, verifying, freeDiskBytes }` |
| `GET /ceremony/api/status` | `{ id, phase, circuit, ptau, initial, contributions, latest: { index, contributionHash, zkeySha256, bytes, url }, waiting, slot: { active, deadline }, beacon: { height, closeBeforeHeight } }` |
| `POST /ceremony/api/join` `{ name }` | 201 `{ ticket, position, heartbeatSecs }`; 400 `bad_name`; 429 `rate_limited`; 503 `queue_full` / `closed` / `paused` / `low_disk` |
| `GET /ceremony/api/turn` (Bearer) | `{ state: "waiting", position }` / `{ state: "active", index, base: { index, zkeySha256, bytes, url }, deadline, maxUploadBytes }` / `{ state: "expired" \| "done" \| "unknown" }`. Each call is the heartbeat. |
| `POST /ceremony/api/contribution` (Bearer, `application/octet-stream`, `Content-Length` required) | 200 receipt (5.4) after verification; 422 `{ error: "rejected", reason }`; 409 `not_your_turn` / `slot_expired`; 413 `too_large` |
| `POST /ceremony/api/leave` (Bearer) | 200 |
| `GET /ceremony/transcript.json` | the public transcript |
| `GET /ceremony/files/NNNN.zkey` | the accepted key, `application/octet-stream`, immutable cache headers |

Rules: one active slot at a time; the head of the queue becomes active when the slot is free; the active slot expires at `deadline = start + slotSecs` (default 900 s) unless an upload has started; a waiting ticket that does not poll within `heartbeatSecs` is dropped. An upload is accepted only from the active ticket, only if `Content-Length <= previous size + 65536`, streamed to a temp file with a hard cap and a 10-minute request timeout. Verification (child process `scripts/ceremony/verify-one.mjs`, one at a time, timeout `MURKLE_CEREMONY_VERIFY_SECS` default 600): `snarkjs zKey.verifyFromInit(0000.zkey, ptau, upload)` must pass; the contribution list must equal the transcript's list plus exactly one new contribution, whose name equals the joined name; the coordinator computes the new contribution hash itself (from snarkjs's verification output or by recomputing `blake2b-512(csHash ‖ pubkeys)` with the pinned snarkjs 0.7.5 internals) and the receipt carries it. Abuse limits: joins per IP prefix (/24 IPv4, /56 IPv6) per hour, queue cap, name 1..64 printable ASCII after trim, refuse joins when free disk < 2 GB, `trustProxy` reads only the proxy's `X-Forwarded-For`, generic 500s, no cookies, no CORS. When `chain` is configured (`MURKLE_BTC_SOURCE`/`MURKLE_ESPLORA`, mainnet), the coordinator closes itself when the tip reaches `beacon.height - closeBeforeBlocks` and records `closed.tipHeight`; uploads after close are refused.

### 5.3 Contributors

- Browser: `web/ceremony.html` plus `web/src/ceremony/` (`main.js` page, `client.js` API client usable from Node too, `contribute.worker.js` running `snarkjs.zKey.contribute` in a Web Worker on in-memory files, `receipt.js`). Entropy: 64 bytes from `crypto.getRandomValues` (plus optional typed text) passed to snarkjs; never stored, sent or shown. The page states that the contributor's computer must not be compromised during the contribution, shows the receipt and a "check my hash" link to the transcript.
- Node: `scripts/ceremony/contribute.mjs --coordinator <url> --name <name>` (join, wait, download, contribute, upload, print receipt); offline mode `--in a.zkey --out b.zkey --name N` and `--upload b.zkey --coordinator <url>` for people who compute on an air-gapped machine within the slot.

### 5.4 Receipt and transcript

```json
{ "ceremony": "murkle-mainnet-1", "index": 3, "name": "alice", "contributionHash": "<128 hex: blake2b-512 as snarkjs prints it>",
  "zkeySha256": "<64 hex>", "prevZkeySha256": "<64 hex>", "acceptedAt": "2026-10-20T12:00:00.000Z",
  "verifiedWith": "snarkjs 0.7.5 zkey verifyFromInit" }
```

```json
{ "version": 1, "ceremony": "murkle-mainnet-1", "protocol": "murkle",
  "circuit": { "r1csSha256": "382e5c0a…", "constraints": 18411 },
  "ptau": { "name": "powersOfTau28_hez_final_15.ptau", "sha256": "3ef2ecc5…" },
  "initial": { "zkeySha256": "<sha256 of 0000.zkey>" },
  "beacon": { "height": 975000, "closeBeforeHeight": 974994, "iterationsExp": 10 },
  "contributions": [ { "index": 1, "name": "…", "contributionHash": "…", "zkeySha256": "…", "prevZkeySha256": "…", "acceptedAt": "…" } ],
  "closed": { "at": "…", "tipHeight": 974990 },
  "final": { "beaconBlockHash": "…", "zkeySha256": "…", "vkeySha256": "…", "manifestSha256": "…" } }
```

### 5.5 Finalisation and verification

- `scripts/ceremony/init.mjs --dir D --id ID --r1cs build/transaction.r1cs --ptau build/ptau/powersOfTau28_hez_final_15.ptau --beacon-height H` checks both pins, writes `0000.zkey`, `ceremony.json`, the empty transcript. `H` must be in the future (at least ~1 week ahead on mainnet).
- `scripts/ceremony/admin.mjs --dir D pause|resume|close|status`.
- `scripts/ceremony/finalize.mjs --dir D [--source esplora|bitcoind] [--install]`: refuses unless closed with `closed.tipHeight < H`, and the tip is at least `H + 6`; reads the 80-byte header at `H` (bitcoind preferred), checks its hash and its own proof of work (`headers.mjs` `decodeHeader`/`checkPow`, imported defensively), and, with both sources available, that they agree; runs `zKey.beacon(last, final, "murkle mainnet beacon: Bitcoin block H <hash>", <hash as display hex>, 10)`; verifies the result from the r1cs; exports the vkey; writes `final/{transaction.zkey, verification_key.json, manifest.json}` and `transcript.final`. The manifest:

```json
{ "protocol": "murkle", "envelopeVersion": 0, "circom": "2.2.2", "circomlib": "2.0.5", "constraints": 18411,
  "sha256": { "r1cs": "382e5c0a…", "wasm": "7b9f73d4…", "zkey": "<final>", "vkey": "<final>", "ptau": "3ef2ecc5…" },
  "setup": "phase1: PPoT hez_final_15; phase2: public MPC ceremony murkle-mainnet-1, N contributions, beacon Bitcoin block H",
  "ceremony": { "id": "murkle-mainnet-1", "contributions": N, "transcriptSha256": "…",
                "beacon": { "height": H, "blockHash": "…", "iterationsExp": 10 } },
  "network": "mainnet", "gitCommit": null }
```

  `--install` copies the three files to `build/mainnet/` and writes `artifacts.zkey`, `artifacts.vkey`, `manifestSha256` into `src/pins.mainnet.json` only when its `genesisTxid` is null (it never touches `src/pins.json`). It prints the new pins.
- `scripts/ceremony/verify.mjs --transcript <path|url> --zkey <final.zkey> [--r1cs] [--ptau] [--expect-hash <mine>] [--beacon-source esplora|bitcoind]`: anyone can run it; checks the r1cs and ptau pins, recomputes `0000.zkey`, runs `zkey verify` from the r1cs, checks every transcript hash in order, the beacon block hash at `H` and its proof of work, the exported vkey's sha256 against `transcript.final` (and against the mainnet pins when present), and `--expect-hash` membership. Exit 0 only when everything holds.

### 5.6 Documents and tests (ceremony track)

- `docs/CEREMONY.md`: why phase 2 needs a ceremony (A-8), the 1-of-N assumption in plain words, timeline and beacon, how to contribute (browser, CLI, offline), what is published, how to verify, the operator runbook, and what the coordinator can and cannot do.
- `test/ceremony.test.mjs`: a real small ceremony end to end in Node on a tiny circuit committed in `test/fixtures/ceremony/` (an r1cs compiled once from `circuits/audit/sanity_decoder.circom`; the ptau of power ≤ 8 generated in the test with the snarkjs CLI into a temp dir): init, three contributions over HTTP (two through `scripts/ceremony` Node code, one through `web/src/ceremony/client.js` plus the worker's core function run in Node), receipts match the transcript, beacon with a fixture block header, final verify passes; rejections: tampered upload, upload from a waiting ticket, expired slot, oversize body, duplicate name mismatch, rate limit, queue cap, closed phase. Real circuit dry run: one contribution on `build/dev/transaction_0.zkey` (the deterministic initial key, read-only) verified with `verifyFromInit`, skipped unless `build/transaction.r1cs`, the ptau and that zkey exist and `MURKLE_CEREMONY_REAL=1`.

---

## 6. Workstream deployment kit (track **deploy**)

### 6.1 Layout

```
deploy/
  README.md                       what each file is for (short; the procedures live in docs/OPERATIONS.md)
  env/murkle.signet.env.example   env files (no secrets inside; paths to secret files only)
  env/murkle.mainnet.env.example
  systemd/murkle-indexer.service  indexer + API (+ relayer when its env says so)
  systemd/murkle-indexer.service.d/relayer.conf.example   MURKLE_RELAYER=1, MURKLE_RELAY_MODE=balance, relay paths
  systemd/murkle-ceremony.service
  systemd/murkle-monitor.service + murkle-monitor.timer   every minute
  systemd/murkle-backup.service + murkle-backup.timer + murkle-backup.path   hourly, and on relayer.json change
  journald/murkle.conf            journal size and retention
  logrotate/murkle                for proxy or file logs if any
  caddy/Caddyfile                 HTTPS, HSTS, routes: /ceremony/api/* and /ceremony/files/* -> coordinator, rest -> indexer
  nginx/murkle.conf               the same for nginx + certbot
  bitcoin/bitcoin.conf.example    server=1, txindex=1, disablewallet=1, no prune, rpc on localhost/compose network, cookie auth
  docker/docker-compose.yml       bitcoind (profile default), murkle-indexer, murkle-ceremony (profile ceremony),
                                  electrs (profile electrs, optional), caddy; json-file log limits; healthchecks
  docker/bitcoind.Dockerfile      Bitcoin Core from the official release tarball; ARG BITCOIN_VERSION and BITCOIN_SHA256 required
  bin/backup.mjs                  keygen | backup | restore | verify (encrypted, §6.3)
  bin/monitor.mjs                 health checks (§6.4)
  bin/state-rollback.mjs          --state P --to H (undo journal, writes a new file, archives the old one)
  bin/check-books.mjs             offline books identity from a relayer.json (restore drill)
```

Install layout used by the units: code in `/opt/murkle/current` (a symlink to a release dir, root-owned, read-only), data in `/var/lib/murkle/<network>/` (`state.json`, `headers.json`, `relay-balance/`), env in `/etc/murkle/murkle.env` (0640), secrets as files under `/etc/murkle/secrets/` (RPC cookie path or password file). Units run as user `murkle` with `NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/murkle`, `PrivateTmp`, `ProtectHome`, `Restart=on-failure`, `RestartSec=5`, `MemoryMax`. The relayer is optional: it runs inside the indexer process when the drop-in sets `MURKLE_RELAYER=1` and `MURKLE_RELAY_MODE=balance`.

### 6.2 Proxy and CSP

The server already sends its CSP (Report-Only by default) and security headers. The proxy adds HSTS (`max-age=31536000`), terminates TLS, overwrites `X-Forwarded-For` with the client address (Caddy's default; nginx `proxy_set_header X-Forwarded-For $remote_addr;`), and logs no access lines by default (privacy). `MURKLE_TRUST_PROXY=1` and `MURKLE_CEREMONY_TRUST_PROXY=1` only behind it. The CSP switch is `MURKLE_CSP_ENFORCE`: unset, the server enforces the CSP on mainnet and keeps it Report-Only on signet (as before); the signet example sets it off, the mainnet example sets it on (go/no-go), and a mainnet server running Report-Only logs a warning. Ceremony uploads: body limit 32 MB and read timeout 600 s on the ceremony routes only.

### 6.3 Encrypted backups (`deploy/bin/backup.mjs`, no new dependency)

- `keygen --out <path>`: run on an offline machine; writes an X25519 private key file (0600) and prints the public key (`murkle-backup-pub:<base64url>`). The private key never goes on the server.
- `backup --recipient <pub> --data /var/lib/murkle/<network> --out <dir> [--keep 48]`: collects `relay-balance/{pool.key,change.key,relayer.json}`, `state.json`, `headers.json` (each read once; files are replaced atomically by the services, so each is whole), builds a JSON archive `{ v: 1, network, createdAt, files: [{ path, mode, sha256, b64 }] }`, encrypts it (ephemeral X25519, HKDF-SHA256 with info `murkle/backup/v1`, XChaCha20-Poly1305 from `@noble/ciphers`), writes `murkle-backup-<network>-<iso>.mbk` (0600), prunes beyond `--keep`. Off-site copying is the operator's (documented).
- `restore --key <path> --in <file> --to <dir> [--force]`: refuses a non-empty target without `--force`, checks every sha256.
- `verify --key <path> --in <file>`: decrypts and checks without writing (the drill).

### 6.4 Monitor (`deploy/bin/monitor.mjs`)

Reads `GET /api/health?strict=1` (falls back to `/api/state` and `/api/relay/info` when the endpoint is missing), optional ceremony `GET /ceremony/api/health`, and the data disk (`fs.statfsSync`). Alerts: indexer lag above `MURKLE_MONITOR_MAX_LAG` (3), no sync for 10 minutes, `lastError` set (a `less-work` header error is critical), relayer `halted`, artifacts mismatch, free disk below `MURKLE_MONITOR_MIN_FREE_GB` (20). Prints one JSON line; exit 0 ok, 1 warning, 2 critical; optional `MURKLE_MONITOR_WEBHOOK` (POST of that line, nothing else).

### 6.5 Dockerfile and compose

`Dockerfile` gains `ARG MURKLE_NETWORK=signet` (passed to the web build and set as `ENV`), uses the per-network artifact check, and a `HEALTHCHECK` with `node -e` fetching `/api/health` (liveness only, so a halted relayer never causes a restart loop). The compose file's default path is Bitcoin Core plus the RPC source (`MURKLE_BTC_SOURCE=bitcoind`, cookie from a shared volume); electrs is an optional profile for operators who want an Esplora API. `.dockerignore` keeps `deploy/**/*.env` (not the examples), `*.mbk` and backup keys out of the context.

### 6.6 `docs/OPERATIONS.md`

Install (Node 22 with a checked tarball, user and directories, `npm ci --omit=dev`, artifacts fetch and check, network web build, Bitcoin Core with `txindex`, units, proxy), upgrade (backup, new release dir, verify artifacts, build, switch the symlink, restart, health; rollback = old symlink, plus `state-rollback.mjs` when the new release had already applied blocks under a new activation; `loadIndexer`'s undo-journal rewind covers the reverse case automatically), restart semantics, backup and restore drill (quarterly: `verify` the newest backup, restore into a scratch dir, `check-books.mjs`, never start a second relayer with production keys), incident playbook:

- **Relayer halt** (I2 failed): do not restart in a loop; read the halt problems; compare relayer coins with the chain; set `MURKLE_RELAYER=0` if it cannot be resolved quickly (wallets self-pay or copy envelopes); balances are kept; never move pool coins by hand.
- **Reorg**: depth up to 144 is automatic; deeper: stop, archive state, resync from genesis; a `less-work` error means the data source served a lower-work chain: switch to the own node, keep the indexer where it is.
- **Key compromise**: relayer keys hold users' prepaid deposits: halt the relayer, publish a notice, plan the key rotation and balance migration (owner decision, users' balances are owed in full); platform fee address: it only receives fees, a change needs a new consensus fee rule with its own activation; backup key: rotate and re-encrypt; TLS or domain: revoke, rotate, remind users that artifacts and vkey fingerprints are pinned in the code.
- **Ceremony coordinator**: it cannot forge contributions; on compromise pause, verify the transcript from scratch, resume or restart the ceremony.

### 6.7 Copy and audit report (deploy track)

- `web/src/views/security.js` and `web/src/views/verify.js`: the A-9 rows and lists per §3.1 and per network (use `NETWORK` from `../config.js`, which exists today). Signet: "Headers are checked for proof of work and the difficulty rules from a pinned checkpoint. Signet blocks are valid by a signature that is not checked, and signet proof of work is nearly free." Mainnet: "… the chain with the most work wins among those the data source serves; the source can still hide or delay blocks; your own node removes it." Receipts: say which level (§3.6) applies. The `A-8` row: signet keeps the DEV single-party setup (by design, pinned by its genesis); mainnet uses the public ceremony (shown only once mainnet pins name it). Keep phrases existing tests assert unless they became false (then list them for integration).
- `docs/CLAIMS.md`: the A-8 and A-9 lines per network.
- `audit/REPORT.md`, status cells and the closing status lines only: A-9 "partly fixed: headers verified (linkage, proof of work, retarget, MTP, version, checkpoints, most work among what the source serves) in the indexer, CLI and browser replay; receipts check linked or bounded headers; open: a single source can withhold blocks; the signet signature is not checked"; A-8 "mainnet: public ceremony tooling ready, open until the ceremony runs; signet: DEV setup by design"; V2-02 "fixed on mainnet from genesis (raw ticker bytes); signet keeps the historical rule, no signet DEPLOY affected (integration replay)".
- `package.json`, `scripts` entries only (no dependency changes): `"ceremony": "node server/ceremony-server.mjs"`, `"ceremony:contribute": "node scripts/ceremony/contribute.mjs"`, `"ceremony:verify": "node scripts/ceremony/verify.mjs"`, `"headers:checkpoint": "node scripts/checkpoint.mjs"`, `"replay:compare": "node scripts/replay-compare.mjs"`, `"monitor": "node deploy/bin/monitor.mjs"`, `"backup": "node deploy/bin/backup.mjs"`.

### 6.8 Tests (deploy track)

`test/deploy.test.mjs`: unit files parse (sections, required keys, hardening options, `EnvironmentFile`, no secret values); env examples contain no secrets and only known `MURKLE_*` names (§8); compose services, volumes, profiles and healthchecks present; Caddyfile and nginx route the ceremony paths and overwrite `X-Forwarded-For`; backup keygen/backup/restore/verify round trip in a temp dir, tamper and wrong-key failures, permissions; monitor against a fake health server for each alert and exit code, and the `/api/state` fallback; `state-rollback.mjs` on a temp snapshot built by a small synthetic chain; `check-books.mjs` on a synthetic `relayer.json`; Dockerfile has the network arg and healthcheck; no banned words in the new docs.

---

## 7. Consensus implications and the proof that signet stays identical

What changes consensus:

- Mainnet only: the strict ticker rule (§4.3) from genesis; the mainnet pins, HRP and key labels (not consensus, but network identity); `MINE_FEES.mainnet` once set and activated.
- Nothing changes consensus on signet. Header verification (both networks) only accepts or refuses blocks from the source; it never alters the block bytes, so for any block sequence it accepts, the verdicts and digests are exactly those of the code without it. If it refuses a block the indexer stops (no verdict), it never judges differently.

Signet invariants and how each is proved:

| Invariant | Proof |
|---|---|
| `src/pins.json` unchanged | byte comparison with the pre-mainnet snapshot (integration) |
| Every `params.mjs` export on signet has its old value (LABELS, digest tags, HRP, magic, MINE_FEES.signet, PINS, ACTIVATIONS, STORAGE_PREFIX, EXPLORER, ESPLORA_API) | `test/network.test.mjs` compares with the snapshot's `src/params.mjs` when `MURKLE_PRE_MAINNET_SRC` points at a copy, else with frozen literals |
| Envelope decoding on signet is unchanged | `test/network.test.mjs`: every op's fixture plus the ticker byte corpus (BOM, lowercase, 0xFF, overlong UTF-8, NUL, 0 and 17 bytes) decode identically with the old and new `envelope.mjs`; mainnet differs only on the BOM case |
| Indexer verdicts and digests on signet | the full `npm test` with `MURKLE_PRE_MINING_SRC=node_modules/.cache/murkle-pre-mining/src` (existing v1 identity and mining tests) |
| The live signet chain replays to the same digests, with and without header verification | `scripts/replay-compare.mjs --network signet --snapshot <copy of data/signet/state.json>` twice (`--headers on`, `--headers off`): identical at every height (integration step; network GETs to mempool.space only) |
| No signet DEPLOY or DEPLOY_POW depends on V2-02 | the same replay reports zero envelopes whose raw ticker bytes fail the strict rule |
| Mainnet behaviour | `test/network.test.mjs` runs mainnet assertions in child processes with `MURKLE_NETWORK=mainnet` (params, HRP, labels, strict ticker in the Indexer, MINE_FEE placeholder refusal, server start refusals, relayer defaults, Unisat chain, web config) |

---

## 8. Environment variables (new and changed)

| Variable | Default | Read by | Meaning |
|---|---|---|---|
| `MURKLE_NETWORK` | `signet` | everything (Node at import; the web build at build time) | `signet` or `mainnet`; anything else refuses to start |
| `MURKLE_BTC_SOURCE` | `esplora` | server, CLI, ceremony finalize | `esplora` or `bitcoind` |
| `MURKLE_ESPLORA` | network's mempool.space API | same | existing; with bitcoind, still used for `utxos`/`merkleProof` when set |
| `MURKLE_BITCOIND_URL` | `http://127.0.0.1:38332` (signet), `:8332` (mainnet) | same | JSON-RPC endpoint |
| `MURKLE_BITCOIND_COOKIE` | — | same | path to Core's `.cookie` (preferred) |
| `MURKLE_BITCOIND_USER`, `MURKLE_BITCOIND_PASSWORD_FILE` | — | same | rpcauth user and a file holding the password |
| `MURKLE_HEADERS` | `on` | server, CLI | `off` only on signet |
| `MURKLE_HEADERS_PATH` | `data/<network>/headers.json` | server | header chain file (CLI: `cli-headers.json` in its data dir) |
| `MURKLE_ALLOW_PRE_GENESIS` | off | server (mainnet) | staging only |
| `MURKLE_ALLOW_PRE_GENESIS_RELAYER` | off | server (mainnet) | lets a pre-genesis staging run start the paid relayer (otherwise it stays off: deposits could not be used or withdrawn) |
| `MURKLE_CSP_ENFORCE` | unset: enforced off signet, Report-Only on signet | server | `1` / `0` override |
| `MURKLE_RELAY_VERIFY_DEPOSITS` | on off signet (cannot be turned off on mainnet), off on signet | relayer | credit deposits only from header-verified blocks with a merkle proof |
| `MURKLE_HEALTH_MAX_LAG` | 3 | server | `/api/health` lag threshold |
| `MURKLE_STATE_PATH`, `MURKLE_DATA_DIR`, `MURKLE_RELAY_DIR`, … | `data/<network>/…` | existing | defaults follow the network |
| `MURKLE_CEREMONY_HOST`, `MURKLE_CEREMONY_PORT` | `127.0.0.1`, `8790` | coordinator, Vite dev proxy | |
| `MURKLE_CEREMONY_DIR` | `data/ceremony/<id>` | coordinator, admin, finalize | |
| `MURKLE_CEREMONY_R1CS`, `MURKLE_CEREMONY_PTAU` | `build/transaction.r1cs`, `build/ptau/powersOfTau28_hez_final_15.ptau` | coordinator | |
| `MURKLE_CEREMONY_SLOT_SECS`, `_HEARTBEAT_SECS`, `_MAX_QUEUE`, `_JOIN_PER_HOUR`, `_MAX_PER_PREFIX`, `_VERIFY_SECS`, `_TRUST_PROXY` | 900, 60, 200, 6, 2, 600, off | coordinator | |
| `MURKLE_MONITOR_URL`, `_MAX_LAG`, `_MIN_FREE_GB`, `_WEBHOOK`, `_CEREMONY_URL`, `_DATA_DIR`, `_BACKUP_DIR`, `_MAX_BACKUP_AGE_HOURS` | `http://127.0.0.1:8787`, 3, 20, —, —, `/var/lib/murkle`, `MURKLE_BACKUP_DIR`, 3 | monitor | |
| `MURKLE_BACKUP_RECIPIENT`, `MURKLE_BACKUP_DIR`, `MURKLE_BACKUP_KEEP`, `MURKLE_BACKUP_REQUIRE_RELAYER` | —, `/var/backups/murkle`, 48, off (on with `MURKLE_RELAYER=1`) | backup | required: a backup without the relayer's keys fails |
| `MURKLE_CEREMONY_REAL` | off | ceremony test | run the real-circuit dry contribution |
| `MURKLE_PRE_MAINNET_SRC` | — | network test | a copy of the pre-mainnet `src/` for identity checks |

---

## 9. Strict file ownership

A file belongs to exactly one track. A track edits only its own files; "new" means the track creates it. Any file not listed is **frozen** (changed only in the integration step, §11).

### Track headers (A-9)

- new: `src/btc/headers.mjs`, `src/btc/headers-store.mjs`, `src/btc/bitcoind.mjs`, `src/btc/source.mjs`, `src/btc/checkpoints.json`, `scripts/checkpoint.mjs`, `scripts/replay-compare.mjs`, `test/headers.test.mjs`, `test/bitcoind.test.mjs`, `test/fixtures/headers/**`, `test/fixtures/bitcoind/**`
- edit: `src/btc/esplora.mjs`, `src/btc/block.mjs`, `src/sync.mjs`, `src/verify-tx.mjs`, `web/src/verify/*` (every file in that folder, including `verify.css` and `share-card.js`)

### Track network (mainnet configuration, V2-02)

- new: `src/pins.mainnet.json`, `docs/MAINNET.md`, `test/network.test.mjs`, `test/fixtures/network/**`
- edit: `src/params.mjs`, `src/indexer.mjs`, `src/envelope.mjs`, `src/keys.mjs`, `src/wallet.mjs`, `src/btc/funding.mjs`, `src/store-node.mjs`, `server/indexer-server.mjs`, `server/relayer.mjs`, `server/relay-books.mjs`, `server/retired-relay.mjs`, `bin/murkle.mjs`, `scripts/artifacts-lib.mjs`, `scripts/fetch-artifacts.mjs`, `scripts/release-assets.mjs`, `scripts/facts.mjs` (the generator only, never `web/src/facts.json`), `scripts/dev.mjs`, `web/index.html`, `web/vite.config.mjs`, `web/src/config.js`, `web/src/payers.js`, `web/src/session.js`, `web/src/keystore.js`, `web/src/app.js`, `web/src/api.js`, `web/src/relay.js`, `web/src/privacy.js`, `web/src/router.js`, `web/src/ui/*`, `web/src/share/*`, `web/src/styles/*`, `web/src/views/*` **except** `security.js` and `verify.js`, `SPEC.md`, `README.md`, `docs/API.md`, `docs/design/README.md`
- owned but must stay byte-identical: `src/pins.json`

### Track ceremony (A-8)

- new: `server/ceremony-server.mjs`, `web/ceremony.html`, `web/src/ceremony/**`, `scripts/ceremony/**`, `docs/CEREMONY.md`, `test/ceremony.test.mjs`, `test/fixtures/ceremony/**`

### Track deploy

- new: `deploy/**`, `docs/OPERATIONS.md`, `test/deploy.test.mjs`, `test/fixtures/deploy/**`
- edit: `Dockerfile`, `.dockerignore`, `audit/REPORT.md` (A-8, A-9 and V2-02 status cells and the closing status lines only), `web/src/views/security.js`, `web/src/views/verify.js`, `docs/CLAIMS.md`, `package.json` (only the `scripts` entries listed in §6.7)

### Frozen (integration step only)

Every existing `test/*.test.mjs` and existing fixture, `web/src/facts.json`, `package-lock.json`, `.github/**`, `.gitignore`, `circuits/**`, `src/mine.mjs`, `src/relay-account.mjs`, `src/core.mjs`, `src/bytes.mjs`, `src/proof-codec.mjs`, `src/pow-*.mjs`, `src/relay-*.mjs`, `web/src/mine-worker.js`, `web/src/pow-worker.js`, `web/src/frame-guard.js`, `scripts/build-circuit.mjs`, `scripts/prepublish-check.mjs`, `scripts/send-btc.mjs`, `PUBLISHING.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/design/*` except this file and `docs/design/README.md`.

---

## 10. Cross-track hooks

| Hook | Owner implements | For | Contract |
|---|---|---|---|
| H1 chain source in the server | network (`indexer-server.mjs`) | headers | §4.5: `openChainSource`, `syncIndexer(..., { headers })`, `source.save()`, `/api/state.chain`, fallback when `source.mjs` is absent |
| H2 chain source in the CLI | network (`bin/murkle.mjs`) | headers | §4.6 |
| H3 next-block fee rate | network (`relayer.mjs`, `bin/murkle.mjs`) | headers | prefer `api.nextBlockFeeRate()` when it is a function, else today's code |
| H4 Vite define, ceremony entry, dev proxy, build marker | network (`vite.config.mjs`) | network, ceremony, deploy | §4.8 |
| H5 params exports | network (`params.mjs`) | all | §4.1 names; consumers import defensively until merged |
| H6 `syncIndexer` headers option | headers (`sync.mjs`) | network, browser replay | §3.4 |
| H7 `parseBlock().header` | headers (`block.mjs`) | headers | §3.4 |
| H8 `Esplora.headers/nextBlockFeeRate/mempoolTxids/chainInfo` | headers (`esplora.mjs`) | network, ceremony | §3.3 |
| H9 `ctx.headerCheck` and its wording | headers (`verify-tx.mjs`, `web/src/verify/engine.js`) | deploy (copy) | §3.6 |
| H10 `replayHeaderAt`, `replayHeaderStatus`, progress `headers` field | headers (`web/src/verify/replay.js`) | deploy (`views/verify.js`) | §3.6 |
| H11 `/api/health` and `relayer.health()` | network | deploy (monitor, Docker healthcheck) | §4.5 |
| H12a coordinator process, env and health | ceremony | deploy (units, compose, proxy, monitor) | §5.2, §8 |
| H12b `/ceremony` page served by the indexer | network (`indexer-server.mjs`) | ceremony | §4.5 |
| H13 `decodeHeader`/`checkPow` for the beacon block | headers (`headers.mjs`) | ceremony (finalize, verify) | §3.2, dynamic import with a sha256d-only fallback that says so |
| H14 ceremony install target | network (`ARTIFACT_PATHS`, `PINS_FILE`) | ceremony (`finalize --install`) | §4.1, §4.2 |
| H15 `package.json` script names | deploy | ceremony, headers | §6.7 |

---

## 11. Integration step (after all tracks)

1. Byte-check `src/pins.json` against the snapshot; line endings of every edited file against the snapshot.
2. `npm test` with `MURKLE_PRE_MINING_SRC=node_modules/.cache/murkle-pre-mining/src` and `MURKLE_PRE_MAINNET_SRC=<snapshot>/src`; update the existing tests each track listed as intentionally broken (copy only), and nothing else.
3. Replay identity (§7): copy `data/signet/state.json` to a temp dir, run `scripts/replay-compare.mjs` with headers on and off; both identical; the V2-02 count is zero.
4. Web builds into temp dirs for both networks (`MURKLE_NETWORK=signet` and `mainnet`, `--outDir <temp>`), check `murkle-build.json`, the signet bundle's copy, the mainnet pre-launch banner; regenerate `web/src/facts.json` with `scripts/facts.mjs`.
5. English and banned-word tests over every new file; the ceremony real dry run with `MURKLE_CEREMONY_REAL=1` if the build files are present.
6. Report: what is done, what the owner must provide (docs/MAINNET.md), and the remaining open items (A-8 until the ceremony runs; A-9 withholding and the signet signature; external audit).

---

## 12. As built (integration step, 2026-10-06)

Where the code differs from the contract above, the code and its tests win (see the precedence note at the top).

Headers (A-9)

- `HeaderChain` below every base checkpoint starts at the lowest base and does not check blocks below it (`baseFor` still throws). Extra API: `from`, `workAt(h)`, `lastError`, `baseCheckpoint`, `catchUp({ pageSize, onHeader })`, `alignTo` returns `{ mismatchAt }` and resets to the base when the indexer is below the held window.
- `HeaderSnapshot.context.prevTimes` holds up to 11 times below `from`; `restore` re-verifies every saved header after the first.
- `openChainSource` also takes `startHeight` and a test-only `fetch`. `Bitcoind.tx()` returns `{ txid, status }` only. `Esplora.headers` makes one extra `tipHeight` call past the tip.
- `verify-tx` exports `makeHeaderCheck` and `chainTrustClause`; results carry `headerCheck` and `refHeaderCheck`; compact `nBits` decode as Bitcoin Core does (an overflowing value has target 0). The public verifier pages (`web/src/share/live-check.js`) pass `headerCheck` and `network` like receipts do.
- D9 confirmed on real data: signet retargets follow Core's rules, so `retarget` stays true for signet.

Network (mainnet configuration, V2-02)

- The strict ticker check runs after the envelope parses whole and before `validateDeploy*`; it accepts and rejects the same byte strings as §4.3.
- `MURKLE_NETWORK=""` is signet. The indexer also answers 404 for `/ceremony/transcript.json`.
- Facts per network: `scripts/facts.mjs` writes `web/src/facts.json` on signet (shape unchanged) and `web/src/facts.mainnet.json` on mainnet (with `network` and, once the ceremony manifest is installed, `manifest.ceremony = { id, contributions, beacon: { height } }`); a mainnet Vite build resolves `facts.json` imports to the mainnet file, so a mainnet build never rewrites the signet facts.
- `scripts/fetch-artifacts.mjs --check` follows `MURKLE_NETWORK` and reports `UNPINNED` for artifacts the network's pins file does not pin yet (mainnet until the ceremony).

Ceremony (A-8)

- The queue credential is a **pass** (API field `pass`, `passHash` in `state.json`, CLI `--pass-file`), not a ticket.
- The transcript is served at `GET /ceremony/api/transcript.json` (no-store); `/ceremony/transcript.json` is an alias that both proxies route to the coordinator.
- Extra answers: 409 `name_taken`, 400 `bad_json`, 411 `length_required`, 415 `bad_content_type`, 408 `upload_timeout`, 409 `upload_in_progress`, 400 `too_small`/`incomplete_upload`; 422 bodies carry `attemptsLeft`; a slot ends after 3 rejected uploads.
- The beacon contribution is named `murkle <network> beacon: Bitcoin block H` (snarkjs truncates names to 64 bytes); the block hash is in the beacon parameters and `transcript.final`.
- `transcript.final` holds `beaconHeight`, `beaconBlockHash`, `beaconHeader`, `beaconContributionHash`, `zkeySha256`, `vkeySha256`, `manifestSha256`, `transcriptSha256` and `finalizedAt`; `transcriptSha256` is the sha256 of the transcript with `final: null` (`JSON.stringify(t, null, 2) + "\n"`).
- `MURKLE_CEREMONY_CHAIN=off` disables the automatic close; finalize needs the tip at `H + 6` or more.

Deploy

- Extra files: `deploy/env/ceremony.env.example`, `deploy/docker/compose.env.example` (compose-only names have no `MURKLE_` prefix).
- `backup.mjs` gzips before encrypting; the file is `MBK1 | recipient pub | ephemeral pub | nonce | ciphertext` with the header as associated data; extra options `--keep-daily`, `--min-interval`, `--include`.
- `monitor.mjs --state` posts to the webhook only when the alerts change; alert `header_error` covers header errors other than `less-work`.
- The env examples never set `MURKLE_RELAYER`, `MURKLE_RELAY_MODE` or `MURKLE_RELAY_DIR` (the relayer drop-in does).
- `prepublish-check` treats the pinned `MINE_FEES` platform scripts as public constants, not as identifiers from the relayer state (a relayer state legitimately repeats the platform fee output).

Integration evidence (§11)

- `src/pins.json` is byte-identical to the pre-mainnet snapshot; edited files keep their line endings.
- The live signet chain (`#324592` to the saved tip) replays to identical digests at every height with header verification on and off, and no signet DEPLOY or DEPLOY_POW fails the strict ticker rule (`scripts/replay-compare.mjs`).
- The CLI tests that serve synthetic blocks at the pinned signet heights run with `MURKLE_HEADERS=off` (signet only), because those blocks cannot match the genesis header checkpoint.

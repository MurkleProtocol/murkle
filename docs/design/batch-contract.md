# Batch relay timing: interfaces (as built, stage 1 and 1b)

Status: as built. The interface specification for batch relay timing, written 2026-10-02 from `privacy-level2.md` (§5.1, §5.2, §6, §8, §10), `relayer.md` and the code. Where this file and `privacy-level2.md` differ, this file wins.

Amended 2026-10-03: the long length is the **10-hour batch** (`"batch10"`, 60-block epochs, released at S+60), replacing the 12-hour batch (`"batch12"`, 72 blocks). Carriers with large OP_RETURNs confirmed 3 to 29 blocks after broadcast in a live signet test; a release at S+72 left only 28 blocks before the anchor window ends at S+100, a release at S+60 leaves 40. `privacy-level2.md` §9 records the decision. This file describes the amended build.

Amended again 2026-10-03 (relay balances): Fast and Next block above the fee cap are refused, never held; at release a batch item its balance or the cap cannot pay becomes `missed`; an epoch is held whole only when the relayer cannot send at all; no proof of work. See "Amendment 2026-10-03: relay balances" at the end; it overrides §3.2, §3.5, §3.6, §6.2 and §6.4 where they differ.

Scope: relay timing only. **No consensus change, no circuit change**: the indexer rules, `src/pins.json` and the circuit artifacts are untouched. No test broadcasts or touches a real wallet.

## 0. Decisions in one place

| Topic | Decision |
|---|---|
| Mode ids | Plain strings, used everywhere (HTTP body, relayer state, history entries, CLI, prefs): `"fast"`, `"block"`, `"batch"` (Hourly batch), `"batch10"` (10-hour batch). No `{ mode, epoch }` objects. The retired `"batch12"` is `malformed` at the relayer; wallets read a saved one as `"batch10"` (`savedMode`, §1). |
| Epochs | `batch`: 6 blocks, epochs start at heights `h % 6 === 0`. `batch10`: 60 blocks, epochs start at `h % 60 === 0`. Absolute heights, public, **not configurable** (every wallet must compute the same boundary). |
| Anchor | A batch envelope is anchored at its epoch start `S` (the tree at `S`). Next-block and fast sends keep the tip anchor (leak 6 of privacy-level2 §4). |
| Release | The relayer broadcasts a batch item at the first flush with `idx.height >= S + E` (`releaseAt`). Expected landing block: `releaseAt + 1`. |
| Relayer deadline | `lastRelease = S + 100 − safety`; `safety` is `SAFETY_BLOCKS` (24) for `batch` and `BATCH10_SAFETY_BLOCKS` (12) for `batch10`. Hourly: release S+6, deadline S+76 (70 blocks of slack). 10-hour: release S+60, deadline S+88 (28 blocks of slack, instead of 16 under the shared 24), and 40 blocks between the release and the end of the anchor window (S+100) for a slow carrier to confirm. Past `lastRelease` the whole epoch expires unbroadcast. |
| W-1 | Unchanged: notes stay reserved until the transfer lands or until `anchor + 100` (S+100 for both lengths). |
| Caps (signet) | `MAX_BATCH_PER_EPOCH` 40 (hourly), `MAX_BATCH10_PER_EPOCH` 120 (10-hour), `BATCH_PER_IP` 3 per epoch per IP prefix, per length. A cap of 0 turns that length off (`batch_disabled`). |
| Why 120 | A 10-hour epoch spans 10 hourly epochs; 3x (not 10x) the hourly cap keeps a full 10-hour release (about 71,700 sats of carrier fees at 1 sat/vB) to what the relayer's coins can fund in one block: 6 parallel coin chains of 21 carriers each, which the fan-out below produces. The cap was first sized against the retired free relayer's daily budget; under relay balances each item pays its own fee (see the amendment at the end). |
| Defaults | Payments: Next block. Self-transfers (merge, refresh): Hourly batch. A batch choice for a payment is never remembered. |
| Crowds | Hourly and 10-hour items with the same anchor S land at S+7 and S+61: separate crowds. Disclosed in the UI (§5.3). |
| Fan-out | `FANOUT_VALUE` 13,000 (one full 21-carrier chain at 1 sat/vB); split only a coin that one chain cannot use up in a block; trigger on release capacity below `FANOUT_MIN_CARRIERS` (120). For example, 4 coins of 7,000 + 3 x 10,000 sats give 59 carriers without any split. |

## 1. `src/relay-batch.mjs` (new)

Pure, dependency-free (no snarkjs, no indexer import), safe for server, browser, CLI and tests. LF line endings.

```js
export const ANCHOR_WINDOW = 100;                 // mirrors src/indexer.mjs (a test asserts equality)
export const MODES = Object.freeze(["fast", "block", "batch", "batch10"]);
export const BATCH_MODES = Object.freeze(["batch", "batch10"]);
export const EPOCH_BLOCKS = Object.freeze({ batch: 6, batch10: 60 });
export const DEFAULT_SAFETY = Object.freeze({ batch: 24, batch10: 12 });
export const DEFAULT_CAPS = Object.freeze({ batch: 40, batch10: 120 });
export const DEFAULT_PER_IP = 3;
export const OVERDUE_AFTER = 3;                   // blocks after releaseAt before the wallet calls a batch overdue

export const isMode = (m) => MODES.includes(m);
export const isBatchMode = (m) => m === "batch" || m === "batch10";
export const savedMode = (m) => …                 // "batch12" (saved by an older wallet) -> "batch10"; anything else as is
export function epochBlocks(mode)                 // 6 | 60; throws TypeError(`not a batch mode: ${mode}`)
export function epochStart(height, mode = "batch")   // height - (height % E)
export function isBoundary(height, mode = "batch")   // height % E === 0
export function nextBoundary(height, mode = "batch") // epochStart(height, mode) + E
export function releaseHeight(anchor, mode = "batch")            // anchor + E
export function lastReleaseHeight(anchor, mode, safety = DEFAULT_SAFETY[mode]) // anchor + ANCHOR_WINDOW - safety
export const deadlineHeight = (anchor) => anchor + ANCHOR_WINDOW;  // W-1 end, any mode
export const epochKey = (mode, start) => `${mode}:${start}`;
export function leafCountAt(outputs, height)      // number of outputs with o.height <= height; outputs are in
                                                  // leaf order with non-decreasing heights; binary search
export function batchSchedule(height, mode, { safety } = {})
  // -> { mode, epochBlocks, start, releaseAt, landsAt: releaseAt + 1, lastRelease, deadline }
  //    start = epochStart(height, mode); deadline = start + 100
```
- Heights must be non-negative safe integers; anything else throws `RangeError`.
- Example at tip 324,700: `batch` start 324,696, releaseAt 324,702, lastRelease 324,772, deadline 324,796. `batch10` start 324,660, releaseAt 324,720, lastRelease 324,748, deadline 324,760.
- `savedMode` is for wallets only (the self-transfer preference, the retry of a saved entry); `isMode` and `isBatchMode` stay strict, so the relayer refuses `"batch12"`.

## 2. `src/core.mjs` and `src/wallet.mjs`

### 2.1 `MerkleTree`
- `copy()`: a new `MerkleTree` with the same `levels`, `size`, shared `zeros` and a fresh `Map` per layer. Mutating either never affects the other.
- `truncate(size)`: unchanged semantics, now returns `this` (the indexer ignores the return value).

### 2.2 `src/wallet.mjs`
```js
export function anchorAt(view, height)
  // view: { tree, outputs, height } (the server Indexer, the CLI Indexer or the web view all qualify).
  // -> { height, tree, leaves } where leaves = leafCountAt(view.outputs, height) and
  //    tree = leaves === view.tree.size ? view.tree : view.tree.copy().truncate(leaves).
  // RangeError if height > view.height or leaves > view.tree.size. Never mutates view.tree.
```
`Wallet` changes (defaults keep today's behaviour exactly):
- `spendable(asset, { maxLeaf = Infinity } = {})`, `maxSendable(asset, { maxLeaf } = {})`: only notes with `leafIndex < maxLeaf`.
- `selectNotes(asset, amount, { maxLeaf } = {})`: first runs today's selection without the bound and throws its `INSUFFICIENT` / `NOTE_LIMIT` errors unchanged. If that succeeds but the bounded selection fails, throws `code: "NOTE_TOO_NEW"`, message `the notes that cover this amount arrived after the batch boundary`.
- `notesFor(asset, amount, inputs, { maxLeaf } = {})`: as today, plus `NOTE_TOO_NEW` when a picked note has `leafIndex >= maxLeaf`.
- `transfer(indexer, { asset, amount, to, inputs, anchor })`: `anchor` is the object from `anchorAt`. When present, selection uses `maxLeaf = anchor.tree.size` and the envelope is built against it.
- `buildEnvelope(indexer, { ..., anchor })`: `tree = anchor?.tree ?? indexer.tree`, header `anchor = anchor?.height ?? indexer.height`.

### 2.3 How a wallet gets the tree and root at S
- Leaf count at S: `leafCountAt(view.outputs, S)`. Every output already carries `height` (server `Indexer.outputs`, `/api/outputs` rows, the CLI replay).
- Tree at S: `anchorAt(view, S).tree`.
- Root check, web wallet: one request, `GET /api/roots?from=${max(view.startHeight - 1, view.height - 143)}&to=${view.height}`, the same request for both lengths and for any S in the window (144 >= 60), so it does not single out S. The entry for S must equal `anchor.tree.root().toString()` before proving, and the finished proof is verified against that root (`verifyEnvelope(envelope, rootAtS)`).
- Root check, CLI: `idx.roots.get(S)` from its own replay; no request.
- If `S < view.startHeight - 1` (just after genesis) the send is not eligible; `eligibleAt` is the next boundary at or above `startHeight`.

## 3. `server/relayer.mjs`, `server/indexer-server.mjs`

### 3.1 Config (`DEFAULTS` key / env `MURKLE_<NAME>` / default)
| Key | Env | Default |
|---|---|---|
| `maxBatchPerEpoch` | `MAX_BATCH_PER_EPOCH` | 40 |
| `maxBatch10PerEpoch` | `MAX_BATCH10_PER_EPOCH` | 120 |
| `batchPerIp` | `BATCH_PER_IP` | 3 |
| `batch10SafetyBlocks` | `BATCH10_SAFETY_BLOCKS` | 12; the constructor throws unless `1 <= v <= 40` (the deadline S + 100 − v must not come before the release at S + 60) |
| `fanoutValue` | `FANOUT_VALUE` | **13000** (was 25000) |
| `fanoutMinCarriers` | `FANOUT_MIN_CARRIERS` | 120 |
| `fanoutTarget`, `fanoutMinConfirmed`, `hotFloorSats`, `safetyBlocks` | unchanged | 24, 6, 3000, 24 |

Epoch lengths are not config (§0). `safetyFor(mode)` = `batch10SafetyBlocks` for `batch10`, else `safetyBlocks`. `capFor(mode)` = `maxBatchPerEpoch` / `maxBatch10PerEpoch`. The 12-hour names (`MAX_BATCH12_PER_EPOCH`, `BATCH12_SAFETY_BLOCKS`) are no longer read.

### 3.2 Submit body and validation order
Body: `{ "envelope": "<942 hex>", "pow": { "block": "<64 hex>", "nonce": "<16 hex>" }, "mode": "block" | "fast" | "batch" | "batch10" }`, `mode` optional (default `"block"`). Any other mode, the retired `"batch12"` included: 400 `malformed`.

Order (first failure answers; nothing mutates before step 9):
0. `parseSubmit` (now accepts the four modes).
1. `gateCode(mode)`: `disabled`, `indexer_behind`, `busy` (first tick not done), `hot_wallet_low` when `hotBalance − reservedSats − estFee < hotFloorSats` (all modes), `budget_exhausted`; non-batch only: `block_full`, `queue_full`; batch only: `batch_disabled` when `!enabled || capFor(mode) === 0`; then `fee_too_high`.
2. Rate-limit buckets (unchanged).
3. PoW. 4. Decode. 5. Nullifier reservation. 6. Freshness (`anchor_unknown`, `anchor_stale`), with `minAnchor(mode) = topHeight() − (ANCHOR_WINDOW − safetyFor(mode))`: unchanged for `block`, `fast` and `batch`; `batch10` uses `BATCH10_SAFETY_BLOCKS`, so a 10-hour submit at S+59 passes whatever `SAFETY_BLOCKS` is.
6b. Batch modes only, in this order:
   - `anchor % E !== 0` → 422 `anchor_not_boundary`
   - `idx.height >= anchor + E` → 422 `epoch_closed`
   - `batchQueued(mode, anchor) >= capFor(mode)` → 503 `batch_full`
   - this bucket's count for `epochKey(mode, anchor)` `>= batchPerIp` → 429 `rate_limited`
   - `queuedAll + 1 > capacity()` → 503 `hot_wallet_low` (coin capacity, §3.6)
7. Full check (unchanged).
8. Re-check: nullifiers, root, `gateCode(mode)`; batch modes also re-run the `epoch_closed`, `batch_full` and capacity checks.
9. Accept and persist (§3.4), then answer 202.

A 4xx after step 2 charges the reject bucket, as today (so `anchor_not_boundary`, `epoch_closed` and the per-IP `rate_limited` do; `batch_full` and `hot_wallet_low` do not).

### 3.3 Error codes, statuses, messages, extras
| Code | HTTP | `message` | Extra fields |
|---|---|---|---|
| `anchor_not_boundary` | 422 | A batch transfer must be anchored to the block that opened its batch. Update the wallet and prove again. | `epochBlocks` |
| `epoch_closed` | 422 | This batch closed while your transfer was being proved. Prove it again for the next batch. | `mode`, `epochStart` (= `epochStart(idx.height, mode)`), `releaseAt` (= epochStart + E) |
| `batch_full` | 503 | This batch is full. Send with the next block, or try the next batch. | `releaseAt` of the full epoch |
| `batch_disabled` | 503 | The relayer is not taking this batch length right now. Send with the next block instead. | none |
| `rate_limited` (batch per-IP) | 429 | Your network has sent the most transfers allowed in this batch. Try the next batch, or send with the next block. | `retryAfter` = `(anchor + E − idx.height) × 600` |
| `hot_wallet_low` | 503 | unchanged text | none |

`ERROR_STATUS` gains the four new codes. `codeForReason` is unchanged.

### 3.4 Responses and persisted items
202 for `block` / `fast`: unchanged. 202 for a batch mode:
```json
{ "id": "<32 hex>", "status": "queued", "anchor": 324696, "deadline": 324796, "flush": "batch",
  "mode": "batch", "epochBlocks": 6, "releaseAt": 324702, "lastRelease": 324772, "epochQueued": 4 }
```
`flush` equals the mode for batch items; `epochQueued` is the published count for this epoch (the snapshot of §3.8, as of this block) plus this one, never a live count. `lastRelease` is the epoch's deadline: the earliest `lastRelease` already promised to a waiting item of this epoch, if a restart changed the safety settings since.

`GET /api/relay/status/:id` adds, for batch items only: `mode`, `releaseAt`, `lastRelease`. Status stays `"queued"` until broadcast.

Item in `relayer.json` (state `version` stays 1; fields are additive):
`{ id, status, nullifiers, anchor, root, mode, acceptedHeight, envelope, reservation, attempts, releaseAt?, lastRelease? }`, the last two for batch items only (on load, a batch item missing them gets them recomputed from `anchor` and `mode`). Carrier ledger entries of batch items gain an internal `epoch: epochKey(mode, anchor)`; `ledgerView()` never outputs it. No IP, bucket key or relay id is ever persisted or published, as today.

### 3.5 Release, fee hold, deadline
`flush({ only })`:
1. Resend journaled `signing` items (unchanged). The `only` path (fast timers) never touches batch items.
2. Candidates: queued non-batch items, and queued batch items with `idx.height >= item.releaseAt`. "Batch item" here means any item with a `releaseAt` (`isHeld`): an item an older relayer accepted as `"batch12"` and saved with `releaseAt` S+72 and its `lastRelease` is held, grouped, released and expired by those saved fields like a batch item, never sent with a Next-block flush and not counted in `MAX_QUEUE`; its carrier gets no `epoch`, so `recent` leaves it out.
3. Per item, before any fee logic: nullifier already spent → `dropped`; root changed → re-check, invalid → `dropped`; `topHeight() > deadlineOf(item)` → `expired`, reason for batch items: `the batch could not be sent before block ${deadline}`. `deadlineOf` is `anchor + 100 − SAFETY_BLOCKS` for non-batch items; for a batch item it is the persisted `lastRelease` (the one its 202 promised; a restart with other settings does not move it), lowered to the earliest `lastRelease` of the epoch's waiting items, so an epoch expires whole.
4. Group the remaining batch candidates by `epochKey`, oldest anchor first. A group is **held whole** (stays queued, retried next block) when any of: fee rate unknown or above `MAX_FEE_RATE`; `estFee > MAX_FEE_PER_TX`; `spentToday + (reserved − Σ group reservations) + n × estFee > DAILY_BUDGET_SATS`; `n > capacityLeft`. Otherwise `capacityLeft −= n` and the group is released.
5. Non-batch candidates keep today's per-item fee hold.
6. Shuffle (crypto RNG) the released groups and the passing non-batch items together, then `carry()` each as today. A carry that still fails inside a released group leaves a split batch; it is logged, never retried out of turn.

Eligibility uses `idx.height` (the flush trigger); deadlines use `topHeight()` (as `minAnchor`). The wallet shows the same numbers from the 202 body.

### 3.6 Reservations, caps, hot wallet, capacity
- Reservation = `estFee()` at acceptance for every mode, released at broadcast or finalize; it survives the UTC day change (as today).
- `queuedCount()` (used by `queue_full`, `info().queue`, `/api/state relay.queued`) counts **non-batch** queued/signing items only. `batchQueued(mode, start)` counts queued/signing items of that mode and anchor. `queuedAll` counts every queued/signing item.
- `blockCount()` resets `acceptedThisBlock` and a new `batchThisBlock` per tip, and takes the published snapshot (§3.8). Batch acceptances increment only `batchThisBlock`; `block_full` uses `acceptedThisBlock`; PoW bits use `acceptedThisBlock + batchLastBlock` (the batch acceptances of the previous tip) and the published reserved sats, so nothing public moves with a batch acceptance until the next block.
- Per-IP: each bucket gains `batch: { [epochKey]: count }`, charged at step 9; keys whose epoch has closed are dropped on access. Buckets are in memory only and reset with the daily key at UTC midnight (document: at most 2 x `BATCH_PER_IP` across midnight).
- `capacity(utxos = cache.utxos, feeRate = cache.feeRate)`: with `per = carrierFee(TRANSACT-sized envelope, feeRate)` and `run(v, d) = max(0, min(21 − d, floor((v − 330) / per)))`, the sum of `run(value, 0)` over confirmed spendable coins plus `run(value, depth)` over our own unconfirmed change with known depth (unknown unconfirmed coins count 0). Coins that descend from one unconfirmed fan-out (`changeRoot`) share Bitcoin Core's descendant limit: together they count at most `24 − carriers already sent below it`. `pickUtxo` applies the same budget, and a broadcast refused for mempool chain limits (`too-long-mempool-chain`) stays `signing` and is resent next flush without using an attempt (dropped only once the anchor window has closed). 0 when the cache is empty.

### 3.7 Fan-out (`maybeFanout`)
1. Skip as today (target < 2, fee rate unknown or above cap, a fan-out pending).
2. `fewCoins` = fewer than `fanoutMinConfirmed` confirmed coins hold `>= 2 × maxFeePerTx` (today's trigger). Fan out only when `fewCoins || capacity(confirmed coins) < fanoutMinCarriers`.
3. Split only the largest confirmed coin, and only if `floor((value − 330) / per) > 21` (one chain cannot use it in one block, so splitting adds capacity). Output count `n` as today but down to 1, outputs of `fanoutValue`; with `n = 1` only when the change still funds a carrier (`change >= per + 330`), so a 25,000-sat coin becomes 13,000 + 11,845 (40 carriers once confirmed, not 21). Budget check, journal and broadcast unchanged.

Existing tests that assumed the 25,000 default (`test/relayer.test.mjs` "24 x 25,000") pin `fanoutValue: 25_000` in their config.

### 3.8 `info().batch` and `/api/state`
```json
"batch": {
  "perIp": 3,
  "modes": {
    "batch":   { "epochBlocks": 6,  "maxPerEpoch": 40,  "safety": 24, "enabled": true,
                 "current": { "start": 324696, "releaseAt": 324702, "lastRelease": 324772, "queued": 2 } },
    "batch10": { "epochBlocks": 60, "maxPerEpoch": 120, "safety": 12, "enabled": true,
                 "current": { "start": 324660, "releaseAt": 324720, "lastRelease": 324748, "queued": 0 } }
  },
  "recent": [ { "mode": "batch", "start": 324690, "releaseAt": 324696, "released": 3, "landed": [[324697, 3]] } ]
}
```
- `current` is the epoch containing `idx.height`; `queued` = `batchQueued(mode, start)` as of the moment the relayer first saw that tip (`snapshot()`, taken in `blockCount()` before any submit at the new tip). It never moves within a block: a live count, polled through these public endpoints, would time every batch submit. `budget.reservedSats` leaves out batch reservations made since the snapshot, and `reason` is computed from that figure.
- `recent`: from carrier ledger entries with an `epoch`; per epoch `released` = entries not `dropped`, `landed` = `[height, count]` of entries with a confirmed height (accepted or rejected), ascending. Newest first, at most 24 epochs per mode, only epochs with `released >= 1`; ledger entries of a retired length (`batch12`) are left out. May be cached per tick.
- New method `batchSummary()` → `{ batch: { start, releaseAt, queued }, batch10: { start, releaseAt, queued } }`. `/api/state` `relay` becomes `{ enabled, queued, defaultMode: "block", batch: relayer?.batchSummary?.() ?? null }` (the optional call keeps the stub relayer in `test/server.test.mjs` working).

### 3.9 Docs
`docs/design/relayer.md` §4.2 (config rows), §4.4 (modes, 202 body, codes), §4.5 (step 6b), §4.6 (release, hold, fan-out). `SPEC.md` §14 (non-consensus): the four modes, the epoch rule, the unchanged indexer rules, and that a batch envelope is an ordinary TRANSACT with an older anchor.

## 4. `web/src/session.js`, `relay.js`, `payers.js`, `privacy.js`, `api.js`

### 4.1 Preferences (plain, non-secret; same pattern as `.route`)
- `${STORAGE_PREFIX}.relayMode`: `"block" | "fast"`, default `"block"` (payments). Getter/setter `session.relayModePref`; a batch value is ignored on write.
- `${STORAGE_PREFIX}.selfMode`: any mode, default `"batch"` (merge, refresh). Getter/setter `session.selfModePref`; a stored `"batch12"` reads as `"batch10"`, and the setter never writes it.
- `session.defaultMode(to)`: `selfModePref` when `String(to).trim() === session.address`, else `relayModePref`.

### 4.2 New exports and methods (exact names)
```js
export const NOT_IN_BATCH = "NOT_IN_BATCH";      // error code
export function batchPhase(entry, height)        // pure
export function retryChoices(entry, height)      // pure
Session.prototype.batchPlan(mode, { asset, amount } = {})
Session.prototype.defaultMode(to)
```
`batchPlan` (no network, current view): `{ mode, epochBlocks, start, releaseAt, lastRelease, deadline, leaves, eligible, eligibleAt, reason }` where `reason` is `null`, `"too-new"` (`selectNotes` throws `NOTE_TOO_NEW` with `maxLeaf = leaves`) or `"short"` (any other selection error); `eligibleAt = releaseAt` (the next boundary). `lastRelease` uses `DEFAULT_SAFETY`; the 202 value replaces it in the entry.

`batchPhase(entry, height)`: `null` unless `entry.kind === "send"` and `isBatchMode(entry.mode)`. Then: `"landed"` if status `accepted`; `"failed"` if status is `failed`, `rejected`, `expired` or `dropped`; `null` unless status `relaying`; `"scheduled"` if `height < releaseAt`; `"releasing"` if `relayStatus` is `broadcast`/`accepted` or `height < releaseAt + OVERDUE_AFTER`; `"overdue"` if `height <= lastRelease`; else `"missed"`.

`retryChoices(entry, height)` returns ids from `"relay" | "next-batch" | "next-block" | "self" | "copy"`:
- non-batch, status `failed`: `["relay", "self", "copy"]` (today's three buttons)
- batch phase `failed` with status `failed`, or phase `missed`: `["next-batch", "next-block", "self", "copy"]`
- batch phase `overdue`: `["self", "copy"]` (the relayer still holds it, so a relay retry would get `nullifier_pending`)
- otherwise `[]`. Views drop `"copy"` when `entry.envelope` is gone.

### 4.3 `session.send({ asset, amount, to, via = routePref, mode, onStep, signal })`
- `mode ??= this.defaultMode(to)`; when `via !== "relay"` the mode is recorded as `"block"` (self-paid sends ignore timing, as today).
- Batch modes, after `#prepare` (keys, sync):
  1. `plan = batchPlan(mode, { asset, amount })`. Not eligible because of note age: throw `Object.assign(new Error(text), { code: NOT_IN_BATCH, mode, start, eligibleAt })`, nothing recorded. `text` = `The note this send needs arrived after block ${int(start)}, so it can join the batch that starts at block ${int(eligibleAt)} (${eta(eligibleAt − height)}). Or send it with the next block now.` (`int`, `eta` from `ui/format.js`).
  2. `anchor = anchorAt(view, plan.start)`; fetch roots as in §2.3; mismatch: throw `Error("The pool at block ${int(start)} doesn't match the indexer's root. Sync again, or switch indexer (Settings, or /verify#indexer).")`, nothing recorded.
  3. Steps: `select` detail `${n} notes · tree at block ${int(start)}`; `prove` with `transfer(view, { ..., anchor })`; `verify` against the root at S.
  4. `record({ kind: "send", via: "relay", mode, epochBlocks, releaseAt, lastRelease, anchor: S, spends, commitments, envelope, status: "relaying", ... })` before anything leaves the browser (W-1).
  5. Carry with `mode`. On 202: `update(entry, { relayId, deadline, releaseAt, lastRelease, epochQueued, status: "relaying" })`; step `queued` ok with detail `Scheduled for the batch after block ${int(releaseAt)}`.
  6. `epoch_closed`: exactly once per send, sync, re-plan the same mode, re-prove with `inputs: entry.spends` and the new anchor (step `prove` runs again with detail `The batch closed while proving. Proving again for the next batch.`), `update(entry, { envelope, anchor: max(old, new), commitments: union, releaseAt, lastRelease })`, carry again. A second `epoch_closed`, or any other failure after the first hand-off, marks the entry `failed` and keeps it (W-1).
- Non-batch modes: unchanged; entries record `mode` and no `releaseAt`.

### 4.4 History, polling, retry
- New entry fields: `mode`, and for batch sends `epochBlocks`, `releaseAt`, `lastRelease`, `epochQueued`. `status` stays `relaying` until landed or failed, so `LOCK_STATUSES` and `lockedNullifiers` are unchanged. "Scheduled" is a display of `batchPhase`, not a status.
- `refreshHistory`: no `/api/relay/status/:id` call for a batch entry while `view.height < entry.releaseAt` (bulk data only); from `releaseAt` on, polls as today until bulk data shows the spends.
- `retry(entry, { via, mode = savedMode(entry.mode) ?? "block", onStep, signal })` (an entry saved as `"batch12"` retries with `"batch10"`; until then it has no batch phase and shows as a plain relayed send):
  - relay + batch mode: plan at the current boundary; reuse `entry.envelope` only if its decoded anchor equals `plan.start` and `entry.mode === mode`; otherwise re-prove with `inputs: entry.spends` at `plan.start`. A second `epoch_closed` handling as in §4.3.
  - relay + `block`/`fast`: today's rule (reuse the envelope when its age `<= 70`, else re-prove at the tip with the same notes).
  - self: unchanged.
  - Updates `mode`, and sets `epochBlocks`/`releaseAt`/`lastRelease` (or `null` for non-batch).
- Choice id → call: `relay` and `next-batch` → `retry(entry, { via: "relay" })`; `next-block` → `retry(entry, { via: "relay", mode: "block" })`; `self` → `retry(entry, { via: "self" })`.

### 4.5 Events
Unchanged types plus one: `loadRelayInfo()` emits `"relay"` after it sets `relayInfo` (success or failure). No other new event.

### 4.6 `relay.js`, `payers.js`, `api.js`, `privacy.js`
- `api.js`: `ApiError` keeps every field of the server's `error` object except `message` (adds `epochStart`, `releaseAt`, `mode`, `epochBlocks` to today's `code`, `retryAfter`, `bits`). `roots` already exists.
- `relay.js`: `submitEnvelope` passes `mode` unchanged; submit step detail for batch modes `Scheduled for the batch after block ${int(res.releaseAt)}`. `RETRYABLE` adds `batch_full`, `batch_disabled`, `epoch_closed`. `FALLBACK` adds the §3.3 messages. `auditRelayer({ address, txs, ledger, batch = null })` also returns `batches: { rows, matched, total, skipped }` with rows `{ mode, start, reported, onChain, ok, note }`: on-chain carriers are grouped by decoded anchor and `status.block_height`; an hourly epoch S counts carriers with anchor S landing in `[S+7, S+60]` when S is also a 60-boundary, else `[S+7, S+100]`; a 10-hour epoch S counts anchor S landing at `>= S+61`; a reported row of another mode (`batch12`) is not checked; `ok` iff the per-height counts equal `landed`; epochs older than the oldest confirmed fetched transaction are `skipped`. Notes: `Bitcoin shows ${onChain} carriers for this batch; the relayer reports ${reported}.`
- `payers.js`: `RelayPayer.carry` returns `{ relayId, status, anchor, deadline, flush, mode, releaseAt, lastRelease, epochBlocks, epochQueued, txid: null, fee: null }` (absent fields `undefined`).
- `privacy.js`: `noteTier(ctx, { route, mode })`. When `rank <= 1`, the route is `relay` and `!isBatchMode(mode)`, the timing advice gains ` Or send it with the hourly batch: it lands together with the other hourly-batch transfers from that hour.` Tiers never change because of the mode.

## 5. Views

### 5.1 Relay timing control (`app-send.js`)
- Layout: a `mode-row` holding the label "Relay timing", a `segmented()` with three stops, left to right `Fast (~1 min)` (`fast`), `Next block` (`block`), `Batch` (`batch`), `name: "timing"`, `label: "Relay timing"`. When `Batch` is selected a second `segmented()` follows with `Hourly batch` (`batch`) and `10-hour batch` (`batch10`), `name: "batchlen"`, `label: "Batch length"`, `size: "sm"`. Both are radiogroups with arrow keys and roving tabindex (`behaviors.js`) and the `<select>` fallback below 360 px; at 375 px the three stops take about 290 px of the 343 px column. CSS: `.mode-row { display: flex; flex-direction: column; align-items: flex-start; gap: 8px }` and `.mode-row .seg-wrap { max-width: 100% }`.
- Self-paid route hides the whole control (as today).
- `form.mode` starts at `s.defaultMode(form.to)`; until the user touches the control, a recipient change re-applies `defaultMode` (so Merge notes and a typed own address switch to Hourly batch). A touched control stays. Picking a mode stores it: self-transfer → `selfModePref`; payment → `relayModePref` (batch picks not stored).
- Merge notes sets the typed payment aside with its timing (`mode`, `modeTouched`, `batchLen`) and starts the merge untouched, on the self-transfer default; when the merge goes out (or on Put it back now) the payment comes back with its own timing. A pick made for the merge never carries over to the payment.
- The `Send with the next block` button sits in the lines under the control, which repaint without it: focus then moves to the `Next block` stop (or the `<select>` below 360 px), and a polite live region outside the repainted slots says `Relay timing: Next block.`
- The "Privacy of this send" hint grades the notes the send would spend: for a batch mode, the selection bounded by `maxLeaf` (the leaves at S), as the session selects; no hint when only too-new notes cover the amount.
- `SEND_STEPS(via, payerKind, mode)`: for relay with a batch mode the last step is `{ id: "queued", label: "Scheduled for the batch" }`.
- While a batch mode is selected, relay info is refreshed at most once per new block (`sync` event), for the crowd line.

### 5.2 Copy (`app-shared.js` exports `BATCH_TEXT`; every batch string lives there)
Numbers through `int()`, waits through `eta()`. `name(mode)`: `hourly batch` / `10-hour batch`.

| Key | Text |
|---|---|
| `label` | `{ fast: "Fast (~1 min)", block: "Next block", batch: "Hourly batch", batch10: "10-hour batch" }` |
| `caption.batch` | Hourly batch waits for the next batch. People watching Bitcoin see it land together with the other hourly-batch transfers from that hour, not when you pressed Send. |
| `caption.batch10` | 10-hour batch waits for the next 10-hour batch. People watching Bitcoin see it land together with the other 10-hour-batch transfers from those 10 hours, not when you pressed Send. Use it only when the recipient can wait. |
| `ip` (Tor line, both lengths) | The relayer still sees your IP address and when you submitted. Tor Browser hides your IP. Anyone can watch the waiting count, which changes once per block, so with few transfers the block you submitted in can be read from it. |
| `crowd(n)` | Waiting for this batch: ${n} (reported by the relayer). |
| `thin` (n < 3) | Few transfers are waiting for this batch. With so few, it hides little. |
| `tooNew({ start, eligibleAt, wait })` | The note this send needs arrived after block ${start}, so it can join the batch that starts at block ${eligibleAt} (${wait}). Or send it with the next block now. (followed by a `Send with the next block` button that sets `block`) |
| `time({ mode, releaseAt, wait })` (review row "Time") | With the ${name} after block ${releaseAt} (${wait}) |
| `scheduled({ releaseAt, deadline })` (after submit) | Scheduled. It goes out with the batch after block ${releaseAt}. Your notes stay reserved until it lands, or until block ${deadline} at the latest. |
| `recipientWait.batch` | The recipient sees it when it lands: usually within an hour, at most about two. |
| `recipientWait.batch10` | The recipient sees it when it lands: usually within 10 hours, at most about 15. |
| `noCancel` (under the control and after submit) | A scheduled transfer can't be cancelled: the relayer holds it, and anyone holding it could still carry it. |
| `long10.reserve({ deadline, wait })` | Your notes stay reserved until it lands, about 10 hours, or until block ${deadline} (${wait}) if it never does. |
| `long10.crowd` | The 10-hour batch is a separate crowd: it lands about 10 hours after its anchor block, so it only hides among other 10-hour transfers, and there are fewer of those than in the hourly batches. |
| `long10.stall({ lastRelease })` | If the relayer stalls, it has until block ${lastRelease} to send it. After that it won't, and Activity offers other ways to send it. |
| `selfDefault` (self-transfer, any mode) | Merges and refreshes go with the hourly batch by default: nobody waits for them, and they add real transfers to the batch. |
| `scheduledLine({ mode, releaseAt, wait, deadline })` (Activity) | Scheduled. It goes out with the ${name} after block ${releaseAt} (${wait}). Your notes stay reserved until it lands, or until block ${deadline} at the latest. |
| `landed({ height, count })` | Landed in block ${height}. The relayer reports ${count} ${count === 1 ? "transfer" : "transfers"} in this batch, yours included. Check it with Audit the relayer. |
| `landedNoCount({ height, mode, releaseAt })` | Landed in block ${height} with the ${name} after block ${releaseAt}. |
| `landedThin` (count < 3) | Few transfers were in this batch. With so few, it hid little. |
| `split(n)` | n = 1: Landed one block after the rest of its batch, so its timing stands out. n > 1: Landed ${n} blocks after the rest of its batch, so its timing stands out. |
| `overdue({ releaseAt, lastRelease, deadline })` | The batch after block ${releaseAt} should have gone out by now. The relayer has until block ${lastRelease} to send it. You can pay the fee yourself or copy the envelope; your notes stay reserved until it lands, or until block ${deadline}. |
| `missed({ lastRelease })` | The relayer did not send it by block ${lastRelease}. Retry in the next batch, send at the next block, or pay the fee yourself. Same notes, so it can't pay twice. |
| `nextBlockNote` | Sending at the next block reuses this envelope when it is recent enough; its anchor then shows it missed a batch. |
| `settingsCaption` | Counts are reported by the relayer. Audit the relayer checks them against Bitcoin. |
| `auditLine({ matched, total })` | Batch sizes match Bitcoin: ${matched}/${total} |

Where they show:
- Send, batch selected: `caption[mode]`, `ip`, `crowd(n)` with `n = relayInfo.batch.modes[mode].current.queued` (omitted when unknown), `thin` when `n < 3`, `noCancel`; for `batch10` also the three `long10` lines; for a self-transfer `selfDefault`. A not-eligible plan replaces the crowd line with `tooNew` and the CTA reason. Disclosure row "Time" uses `time(...)`; the sheet's done body uses `scheduled`, `recipientWait[mode]`, `noCancel`; toast title `Transfer scheduled.`
- Activity (`app-activity.js`, `statusChip(h, tip)` in `app-shared.js`): chip `Scheduled` (phase scheduled), `Going out with the batch` (releasing), `Needs attention` (overdue, missed, failed); lines `scheduledLine`, `overdue`, `missed`, and `missed` again (instead of the relayer's raw reason) for a send the relayer expired past its `lastRelease` (status `failed`, relay status `expired`); the `Failed` filter and the portfolio's "need attention" callout include overdue and missed batch sends (`batchLate`), which keep status `relaying` (W-1); for `landed` the count is `Σ landed` of the matching `relayInfo.batch.recent` row (`mode` and `start === entry.anchor`), else `landedNoCount`; `landedThin` when count < 3; `split(n)` when that row's earliest landed height is below the entry's height (`n` = the difference). Buttons from `retryChoices`: `Retry in the next batch`, `Send at the next block` (with `nextBlockNote` under it), `Pay the fee myself (links this transfer to your BTC address)`, `Copy envelope hex`; the non-batch `relay` id keeps `Retry with the same notes`. The activity view calls `s.loadRelayInfo()` once when a landed batch entry is shown.
- Settings, Relayer books (called Proof of sponsorship before stage 0 of docs/design/paid-relay.md): a "Batches" block (relay info reloaded at most once per new block while the page is open, repainting only Relayer books) with kv rows `Hourly batch now` and `10-hour batch now` (`${queued} waiting · goes out after block ${releaseAt}`), a table "Recent batches" (columns Batch, Anchor block, Sent, Landed in; at most 12 rows from `recent`), `settingsCaption`, and in the audit result `auditLine` plus each mismatch note. The Network activity caption adds: `Scheduled batch transfers are not looked up until their batch goes out.`
- Never: "Level 2", "mixer", "mix", "blend", "ghost mode", "anonymous", "untraceable", percentages, or counts of people. Every existing disclosure stays (signet with no value, DEV setup A-8, mempool.space without PoW A-9, mints are public, the relayer sees IP and timing, a small anonymity set).

### 5.3 Docs
`docs/design/privacy-level2.md` §1, §5.1, §5.2, §6, §8 and §10 follow this file (two lengths, per-length deadlines, control layout, copy); its §9 is kept as recorded.

## 6. `bin/murkle.mjs`, `README.md`

### 6.1 Command and flags
`murkle send <w> <ticker> <amount> <mrk1…> --relay [url] [--fast | --batch | --batch10] [--no-wait] [--wait-max <minutes>]`
- `--relay` without a value: `MURKLE_RELAY_URL`, else `http://localhost:8787`. Without `--relay`, today's self-paid path is unchanged and any timing flag is an error.
- More than one timing flag: error `choose one of --fast, --batch, --batch10`. Default timing with `--relay`: `block`. `--batch12` is an unknown flag.
- `murkle pending <w> [--relay url]`: lists pending entries (mode, anchor, releaseAt, relay status, txid); one status call per relayed entry, and none for a batch entry before its `releaseAt`.
- `murkle retry <w> [--relay [url]] [--fast | --batch | --batch10]`: the newest pending relayed entry whose relay status is failed (or that the relayer no longer knows) is proved again with `inputs: spends` (same nullifiers) to the same recipient and amount, and handed to the relayer with the given timing (default: its own; an entry saved as `batch12` goes with `batch10`).

### 6.2 Flow
1. Sync the local replay (`synced()`), open the wallet (W-1 locks), `GET <url>/api/relay/info`; refuse when `!enabled` or `network !== "signet"`.
2. Anchor height: batch `S = epochStart(info.height, mode)`; otherwise `min(idx.height, info.height)`. Local `idx.height < S`: sync once more, then error `local index is behind the relayer (local ${a}, relayer ${b}); run sync`. `anchor = anchorAt(idx, h)`; its root must equal `idx.roots.get(h)`.
3. Select with `maxLeaf = anchor.tree.size`; `NOTE_TOO_NEW` → exit 3 with the eligibility line below, nothing written.
4. Prove (`wallet.transfer(idx, { ..., anchor })`), check `await idx.checkTx(env, { inputs: [], outputs: [] }, idx.height + 1) === true`.
5. Write the pending entry **before** submitting: `{ via: "relay", relay: url, relayId: null, mode, ticker, amount, to, spends, anchor, releaseAt, lastRelease, envelope, status: "relaying" }`. `openWallet` keeps an entry without `txid` locked until its spends are spent or `idx.height > anchor + 100`.
6. PoW with `grind()` from `src/relay-pow.mjs` on `info.pow.blocks[0]` at `info.pow.bits`; POST. `pow_insufficient` regrinds once with `bits`; `pow_stale` refetches info once; `epoch_closed` re-proves once at the new boundary with the same spends (pending entry updated).
7. On 202 store `relayId`, `releaseAt`, `lastRelease`; on refusal mark the entry `failed` with the code (it stays locked, W-1) and exit 4.

### 6.3 Output (stdout; progress to stderr as today)
```
relay ${url} (signet), relayer height ${info.height}
hourly batch: anchor ${S}, goes out after block ${releaseAt}, relayer deadline ${lastRelease}, notes reserved until ${deadline}
proving transfer of ${amount} ${ticker} against block ${anchor}…
proof checked locally against the root at ${anchor}
anti-spam proof: ${bits} bits (${tries} hashes)
scheduled: relay id ${id.slice(0, 12)}…  waiting for this batch: ${epochQueued} including yours, as of the last block (reported by the relayer)
waiting for block ${releaseAt} (${eta}); Ctrl+C stops waiting, the relayer keeps the transfer
block ${h} (${releaseAt - h} to go)
released: carrier ${txid}
  ${EXPLORER}/tx/${txid}
landed in block ${height}
```
- 10-hour: the second line starts `10-hour batch:`, and a line says it is a separate crowd: it lands at block ${S + 61}, while hourly transfers anchored at S land at S + 7. Next block: `next block: anchor ${a}, notes reserved until ${a + 100}` and `queued for the next block: relay id …`; fast: `queued (fast): relay id …`.
- Not eligible: `not in this batch: the note this send needs arrived after block ${S}; it can join the batch that starts at block ${eligibleAt} (${eta}), or send without --batch now`.
- Failure: `relay failed: ${status} (${reason}); notes stay reserved until block ${anchor + 100} unless it lands: murkle retry ${w}`.

### 6.4 Waiting and exit codes
- Before `releaseAt`: poll `GET <url>/api/state` every 30 s (height only; no per-id call). From `releaseAt` (immediately for block/fast): `GET /api/relay/status/:id` every 15 s, printing each change, until a final status.
- `--no-wait`: exit 0 right after the `scheduled`/`queued` line. `--wait-max N`: stop after N minutes. SIGINT: print `stopped waiting; the relayer still holds it (relay id …); check later with: murkle pending ${w}` and exit 130.
- Exit codes: 0 landed (status `accepted`) or queued with `--no-wait`; 1 usage or local error, nothing handed out; 3 not eligible for this batch, nothing handed out; 4 relayer refused the submission, or final `rejected`/`expired`/`dropped`; 5 `--wait-max` reached, still pending; 130 interrupted.

### 6.5 Testability
The command dispatch runs only when the file is the entry script. Export `parseRelayFlags(args)`, `relaySend({ idx, wallet, file, name, client, mode, print, now })`, `waitForRelay({ client, entry, mode, print, sleep, waitMaxMs })` and `exitCodeFor(result)`, with `client = { info(), state(), submit(body), status(id) }` injectable. README: the CLI section shows the new commands and flags; the env table adds `MURKLE_RELAY_URL` and the §3.1 variables; the wallet-storage list adds `.relayMode` and `.selfMode`.

## 7. Test conventions

- CRLF files (keep CRLF; count bytes with node): `web/src/session.js`, `web/src/relay.js`, `web/src/views/app-send.js`, `web/src/views/app-shared.js`, `bin/murkle.mjs`. Every other file listed here is LF.
- Tests bind port 0 (never 8787 or 5173), never read or write `data/signet/`, never broadcast and never call real wallets; they use `FakeEsplora`, synthetic blocks, fake storage and a fake DOM, with low PoW bits where PoW still applies.
- English only; short comments; match the surrounding style.

## 8. Tests

**core** (`test/batch-core.test.mjs`)
1. `ANCHOR_WINDOW` equals `src/indexer.mjs`; `EPOCH_BLOCKS`; every 60-boundary is a 6-boundary; `savedMode("batch12") === "batch10"` while `isMode("batch12")` is false.
2. `epochStart`, `isBoundary`, `nextBoundary`, `releaseHeight`, `lastReleaseHeight` at 0, 5, 6, 59, 60, 61, 72, 119, 120, 324,659, 324,660, 324,661, 324,696, 324,700, 324,719, 324,720, both modes; non-batch modes (`"batch12"` included) and bad heights throw.
3. `leafCountAt`: empty, repeated heights, below the first and above the last output.
4. `batchSchedule(324700, …)` equals the §1 example for both modes.
5. `MerkleTree.copy` is independent both ways; `copy().truncate(n)` root equals a tree of the first n leaves; `truncate` returns `this`.
6. `anchorAt` on a synthetic `Indexer` with outputs at several heights: root equals `idx.roots.get(S)`; returns `view.tree` itself when nothing came after S; `view.tree` unchanged.
7. `selectNotes` / `spendable` / `maxSendable` with `maxLeaf`; `NOTE_TOO_NEW` versus `INSUFFICIENT` and `NOTE_LIMIT` precedence; `notesFor` with `maxLeaf`.
8. Real proofs: a transfer anchored at an hourly S passes `checkTx` at S+7 and is applied; one anchored at a 60-boundary passes at S+61 and S+100 and is refused at S+101 (`anchor outside window`); no `anchor` gives today's tip anchor; `inputs` plus `anchor` reproduces the nullifiers.

**relayer** (`test/batch-relayer.test.mjs`)
1. `parseSubmit` accepts the four modes, refuses others (`"batch12"` included, also as a full submit: 400 `malformed`, nothing reserved); `configFromEnv` reads the new names, not the 12-hour ones; `batch10SafetyBlocks` outside 1..40 throws.
2. Each code with its status and extras: `anchor_not_boundary`, `epoch_closed`, `batch_full` (cap 1), `batch_disabled` (cap 0), per-IP `rate_limited` (cap 1; another /24 succeeds; the same IP succeeds in the other length), `hot_wallet_low` from reservations and from coin capacity; for both lengths.
3. Batch items do not count toward `MAX_QUEUE` or `block_full`; a Next-block submit succeeds while the batch is full.
4. 202 bodies and `status(id)` fields for `batch` and `batch10`.
5. No broadcast before `releaseAt` (hourly S+1..S+5, 10-hour through S+59); at `releaseAt` every item of the epoch and the queued Next-block items go in one flush; carriers have today's 1-in / OP_RETURN / change shape.
6. Same anchor S (S % 60 === 0): hourly items go at S+6, 10-hour items at S+60.
7. Fee above the cap at release holds the whole epoch; all of it goes on the next tick under the cap. A tight budget and a coin shortage hold the whole epoch while Next-block items still go.
8. Deadlines: an hourly epoch held past S+76 and a 10-hour epoch held past S+88 expire whole, unbroadcast.
9. Restart between acceptance and release: items reload from `relayer.json` with `mode`, `releaseAt`, `lastRelease` and go at the right height. An item an older relayer saved as `"batch12"` (anchor at a 72-boundary, `releaseAt` S+72, `lastRelease` S+88) is not in the Next-block queue, is not sent before S+72 while a Next-block item goes at S+1, goes out whole at S+72, and, held by the fee cap, is still queued at S+88 and expired whole at S+89, unbroadcast.
10. Reorg of block S: precheck re-verifies; an invalid item is `dropped`.
11. `info().batch` and `batchSummary()` match queued and broadcast items; `recent` `released`/`landed` match mined heights; `/api/state` through `createApp` (port 0) shows `relay.batch`, and a stub relayer without `batchSummary` still serves `/api/state`.
12. Fan-out: coins 7,000 + 3 x 10,000 give capacity 59 and no fan-out; a 10,000-sat coin is never split; one 100,000-sat coin is split into 13,000-sat outputs; existing fan-out tests pass with their pinned config.
13. Privacy: no response and no `relayer.json` contains the test IP; `ledgerView()` has no `epoch`.

**cli** (`test/batch-cli.test.mjs`)
1. `parseRelayFlags`: default URL (env, then localhost), explicit URL, exclusive timing flags, timing flags without `--relay`, `--no-wait`, `--wait-max`.
2. `relaySend` with an in-process `Relayer` (FakeEsplora, synthetic blocks, low bits) behind the injected client: block and batch submits; batch anchor is S; the pending entry is written before the submit; `epoch_closed` re-proves once with the same spends.
3. Not eligible: exit code 3, no submit, no pending entry.
4. `waitForRelay`: only `state()` calls before `releaseAt`, status calls after; accepted → 0, dropped → 4, `--wait-max` → 5; output lines as in §6.3.
5. A relayed pending entry without `txid` keeps its notes locked until its spends are spent or `anchor + 100` passes.
6. `retry` reuses the same nullifiers.
7. Help text and README list the new flags and variables.

**wallet** (`test/batch-session.test.mjs`)
1. `batchPlan` for both modes: boundaries, `eligible`, `too-new` with `eligibleAt`, `short`.
2. `send({ mode: "batch" })` and `"batch10"`: exactly one roots request with the §2.3 range; proof verified against the root at S; a root mismatch sends nothing and records nothing.
3. Note too new: `NOT_IN_BATCH` with `eligibleAt` and the exact text; nothing recorded.
4. `epoch_closed`: one re-prove with the same spends, anchor is the max; a second `epoch_closed` leaves a `failed` entry whose notes stay locked.
5. Entry fields; `lockedNullifiers` covers the spends; `refreshHistory` makes no relay-status call before `releaseAt` and one after.
6. `batchPhase` and `retryChoices` across heights and statuses; retry `next-batch` re-proves at the current boundary with the same nullifiers; `next-block` reuses the envelope when its age is at most 70.
7. `defaultMode`, `relayModePref`, `selfModePref` (a batch pick for a payment is not stored; a stored `"batch12"` reads as `"batch10"`, and an entry saved as `"batch12"` retries with the 10-hour batch).
8. `relayFailure` for the new codes; `submitEnvelope` passes `mode` and the step detail; `RelayPayer.carry` fields; `ApiError` carries `epochStart` and `releaseAt`.
9. `auditRelayer` batches: matching counts, a mismatch flagged with its note, hourly and 10-hour epochs with the same anchor told apart by landing height, older epochs skipped.
10. Privacy nudge present for non-batch relay sends, absent for batch modes; tiers unchanged. `loadRelayInfo` emits `"relay"`.

**views** (`test/batch-views.test.mjs`)
1. Control: three stops, the sub-choice only under Batch, radiogroup labels, the `<select>` fallback, the `.mode-row` CSS rules; hidden on the self-paid route.
2. Defaults: a payment starts on Next block; Merge notes and a typed own address switch to Hourly batch; a touched control stays.
3. Every `BATCH_TEXT` string for both lengths appears in its state (caption, Tor line, crowd, thin, 10-hour lines, too new with its button, review Time, after submit, recipient wait, cannot cancel, self default).
4. Activity: Scheduled chip and line before `releaseAt`; overdue and missed buttons; landed with count, thin, split; non-batch rows unchanged.
5. Settings: batch rows, recent table, audit batch line.
6. `BATCH_TEXT` and the batch UI contain none of the §5.2 never-words, no `%` and no "users"/"people" counts; `test/english.test.mjs` passes; the README roadmap does not list "Privacy delay".

## Amendment 2026-10-03: relay balances

Payment for relaying is now the prepaid relay balance (`docs/design/relay-balance.md`, binding interfaces in `docs/design/relay-balance-contract.md`, which wins where it and this file differ). The epochs, anchors, release heights, relayer deadlines, caps and W-1 above are unchanged. What changes:

1. **No proof of work.** The submit body is `{ envelope, mode, accountPub, t, sig }`: a request signed by the wallet's relay account over the endpoint, the network, the pool key and the body (contract §1). The `pow` field, `pow_stale` and `pow_insufficient` are gone, and so are the daily budget, `budget_exhausted`, `hot_wallet_low` and `fee_too_high`. A submit the balance cannot cover is refused at once with 402 `balance_low`, before any proof check.
2. **Fast and Next block above the fee cap are refused, never held.** When the fee rate is above `MAX_FEE_RATE` or the exact carrier fee above `MAX_FEE_PER_TX`, a submit of any mode answers 503 `fee_high` and the wallet offers to pay the fee itself. Nothing is queued to wait for fees to drop. Fast goes out at once: the 10 to 40 s random delay is removed (no forced random or scheduled waits).
3. **Reservation and charge.** At submit the relayer reserves the per-send cost (fee plus margin) from the account's balance, twice that for a batch item (`batchHeadroom` 2). At release it charges the exact fee of the final carrier plus the margin, first from the reservation, then from the available balance, and returns the rest.
4. **A short or over-cap item becomes `missed`, the epoch goes out.** At release, an item whose balance cannot cover its exact cost (`balance_low`), or every item when the fee rate is above the cap (`fee_high`), becomes `missed` with that `code`: nothing is charged, its reservation is returned, and its nullifiers leave the pending set. The other items of the epoch are released in the same flush, on time. A `missed` item is final: it is never sent later on its own, and a top-up never releases it (a lone late carrier with an old batch anchor would stand out and tie the top-up to that transfer). The wallet offers Retry in the next batch, Send at the next block, Pay the fee myself, or Copy envelope.
5. **An epoch is held whole only when the relayer cannot send at all**: the fee rate is unknown, or its own coins (credited deposits and journaled change, never coins found by listing an address) cannot fund the epoch's carriers in this block (`pool_low` at submit). It is never held because of one account. §3.5 step 4 is replaced by this rule and step 4 above; the budget term is gone.
6. **No bump.** The relayer never replaces or child-pays a carrier (no RBF, no CPFP). A stuck relayed send is fixed by the user with Pay the fee myself (the envelope does not depend on its carrier); the relayed fee stays spent if the relayer's carrier is also mined.
7. **Status and CLI.** `GET /api/relay/status/:id` may answer `missed` with `code` `balance_low` or `fee_high`, plus `broadcastHeight` and `cost` once broadcast. In the CLI (§6), `send --relay` first reads the account (signed) and exits 1 with nothing handed over when the balance is short; `waitForRelay` treats `missed` as final and exits 4 with `relay missed: <code> (<reason>); nothing was charged: murkle retry <w>`; `pickRetry` picks a `missed` entry. Tests: `test/relay-balance-cli.test.mjs`, `test/relay-balance-relayer.test.mjs`.

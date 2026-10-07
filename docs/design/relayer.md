**Historical: v1 sponsored relayer (retired). Relayer decision and implementation spec (signet, then mainnet)**

> **Status: historical.** Kept as the record of the v1 design. Names of that time (`zkpool`, the `zkp` CLI, `zp1…` addresses) are now `murkle`, `murkle` and `mrk1…`. The notes below say what still applies.

> **Relay balances replace the free design (2026-10-03).** Payment is now the prepaid relay balance of `docs/design/relay-balance.md`; the binding interfaces are in `docs/design/relay-balance-contract.md`, which wins wherever this file differs. The sponsored ("free, capped") relayer this file chose in §1, its free-tier lines in §3, the budget and proof-of-work settings of §4.2 and §4.3, and §7.2 no longer apply: a relayer that pays carriers from the operator's BTC can be drained by anyone, because zero-value transfers need no tokens (audit R-2). Stage 0 deleted the free path. The ticket design of `paid-relay.md` that was to follow it was rejected (it forced scheduled sweeps and random holds) and is kept only as a record.
>
> - A user tops up a per-account balance with a plain BTC payment to a fresh deposit address; after one confirmation on signet (three on mainnet) the relayer credits it, less the cost of later spending that coin. Each relayed send is charged its exact carrier fee plus a margin (by default 10%, at least 50 sats), debited before the carrier is signed. The operator never pays any part of a user's transaction (invariant I-PAY, contract §3; audit R-3).
> - The relayer starts only with `MURKLE_RELAYER=1`, `MURKLE_RELAY_MODE=balance`, a valid balance configuration and new keys in `MURKLE_RELAY_DIR` (default `data/signet/relay-balance/`) that differ from the retired `relayer.key`. Otherwise the stage-0 behaviour stays: `GET /api/relay/info` answers `enabled: false`, submit answers 503 `disabled`, and old relay ids answer `dropped` from the read-only v1 `relayer.json`.
> - Fast goes out at once (the 10 to 40 s random delay is gone). Above the fee cap, Fast and Next block are refused with `fee_high`, never held; a batch item that its balance or the cap cannot pay at release becomes `missed`. The relayer never bumps a carrier, and there is no proof of work.
> - The rest of §4 (submit pipeline, journaling, reorg handling, W-1) stays in force with the changes noted in §4.2, §4.4 and §4.5.
> - As built (contract §9): `pool_low` is refused at submit for every mode, so a Fast or Next-block send the pool coins cannot fund in this block is refused, not queued; `too_large` now reads "The request body is too large. Send only the envelope and its signature."; a deposit reversed by a reorg is never credited again (`already_credited`); a halt caused by spending a reversed deposit is sticky and needs the operator; merge transactions are not built yet (fan-outs only); a failed fee-rate fetch keeps the last known rate.

## 1. Decision

Implement **Design 1, "Sponsored Relay v1"**, now on signet. It is free for the user, non-custodial, needs no consensus or circuit change, and is protected by hard budget caps. Five parts are grafted from the other two designs (section 2). Before mainnet, payment moves to **Design 3's blind tickets bought on-chain**, with corrections listed in section 7. **Design 2 is rejected.**

Why Design 1 now:
- The code confirms that TRANSACT does not depend on its carrier. `Indexer.checkTx` never reads `tx` for OP.TRANSACT, and `extDataHash` = sha256 of every body byte. So a relayer is purely a server-side job: the circuit, the dev setup, the Picus/circomspect results and the indexer rules all stay as they are.
- A zero-value TRANSACT is free to make and is valid. So any free relayer can be drained. On signet the BTC is worthless, so a drained free tier is a denial of service, not a loss. That makes a free, capped relayer the right signet product.
- It removes the biggest real leak today: the seed-derived fee key links every transfer to one BTC address. It also lets Unisat users send privately on signet, which they cannot do now (Unisat's signet node rejects 471-byte OP_RETURNs).

Why Design 3 is not built now:
- It needs 2 new consensus ops, blind BLS signatures, a public signature bulletin, a refund path and ticket recovery from the seed. Realistically that is 25–35 hours plus audit, not 13.
- It should ship in the release after the rename, so signet state is reset only once.

Why Design 2 is rejected, including for mainnet:
- It puts cross-asset slot logic into the circuit, which is the part soundness depends on. There is no unshield, so the per-asset pool fuse never triggers. A slot bug would therefore silently inflate any token inside the pool, and nothing would detect it.
- Tickets keep every relayer failure limited to the relayer's own hot wallet.
- Any circuit change (for example 3 inputs to merge notes) is a separate decision. It must be made before the MPC ceremony.

## 2. What is grafted

1. **From Design 3: invariant A-10 in audit/REPORT.md.**
   - TRANSACT validity must never depend on its carrier.
   - Any future unshield must put its BTC destination and any relayer fee inside the body covered by `extDataHash`.
2. **From Design 3: an anonymity-set meter** that anyone can count on-chain: "N relayed transfers in the last 144 blocks".
3. **From Design 2: an `expiry` field**, deferred to the rename release (section 7). It needs no circuit change because the body is already in `extDataHash`.
4. **From Design 2: a transparency ledger** showing the indexer verdict for every carrier.
5. **New: wallet invariant W-1.** None of the three designs got this right.
   - An envelope that has been handed to anyone (the relayer, or the public mempool) stays valid until block `anchor+100`, because anyone can re-carry it.
   - Until that block, or until its nullifiers are spent, the notes it spends may only be used to retry that same transfer (same notes, so the same nullifiers).
   - Design 1 says "unlock and prove again", and the current `refreshHistory` unlocks notes as soon as a self-paid tx is "dropped". Both can pay twice: the old envelope spends notes A and B, the retry picks a newer note C, and both land.

## 3. Trust model (state it this way in docs and UI)

- **Custody: none.** The relayer cannot alter, redirect or steal anything. Any changed byte breaks `extDataHash` or the proof; the existing tamper tests show this. It cannot see sender, recipient, amount or token: `publicAsset=0`, and nullifiers need `sk` to link to leaves.
- **Liveness is trusted.** The relayer can delay, drop, or censor by IP or at random. It cannot censor by content. The user can always fall back to paying the fee themselves or to "Copy envelope". Notes are never lost; at worst they stay reserved until `anchor+100` (about 16 hours on signet; about 3 hours once `expiry` exists).
- **The operator can see:** IP, user agent, timing, and the envelope a few minutes before it is public. It can group several submissions from one IP. IPs are not logged or persisted by our code, but a reverse proxy in front may log them; that is operator configuration and users must trust it. Tor works.
- **Public observers can see:** that a TRANSACT was carried by the relayer address, with fee and time (rounded to the block in default mode). They cannot see the user's BTC wallet.
- **The free tier can be exhausted by anyone.** It is a capped subsidy, not a guarantee.
- **The largest trust point is unchanged:** the same server serves the wallet JS. Pinning the relayer address in `config.js` adds nothing while the same origin serves the code, so do not present it as a security feature.

## 4. Implementation spec (signet)

### 4.1 Files

**New:**
- `server/relayer.mjs`
- `src/relay-pow.mjs` (shared by server, browser worker, CLI and tests)
- `web/src/pow-worker.js`
- `web/src/relay.js`
- `test/relayer.test.mjs`

**Edited:**
- `server/indexer-server.mjs`
- `src/btc/funding.mjs`: `planCarrierTx` gains an optional `sequence`, passed to `addInput`. (Superseded by the L5 policy of privacy-trace-test.md: every input of every transaction this software builds now carries `0xfffffffd`, and any other value throws.)
- `src/wallet.mjs`: `transfer` gains an optional `inputs` override, used for retries.
- `web/src/session.js`
- `web/src/main.js`
- `bin/zkp.mjs`
- `SPEC.md`, `audit/REPORT.md`, `README.md`

**Unchanged:** the circuit, the envelope format, and the indexer's consensus rules.

### 4.2 Config (environment variables, signet defaults)

Every variable is read with the `MURKLE_` prefix (for example `MURKLE_MAX_QUEUE`); `server/relayer.mjs` `DEFAULTS` holds the values.

> **Relay balances (2026-10-03, `relay-balance-contract.md` §4.1).** New: `RELAY_MODE` (must be `balance` to start), `RELAY_DIR` (`data/signet/relay-balance`: `pool.key`, `change.key` and the version-2 `relayer.json`), `RELAY_MARGIN_PCT` (10), `RELAY_MARGIN_MIN_SATS` (50), `RELAY_MIN_DEPOSIT_SATS` (2000), `RELAY_DEPOSIT_CONFS` (the network default: 1 on signet, 3 on mainnet; upward only), `RELAY_BATCH_HEADROOM` (2), `RELAY_SUGGEST_SENDS` (10), `RELAY_INVALID_PROOF_SATS` (50), `RELAY_INVALID_PER_HOUR` (10), `RELAY_ACCOUNT_PER_HOUR` (120), `RELAY_CREDIT_LOOKUPS_PER_MIN` (30: explorer lookups by credit calls per minute, all IPs together). `RELAYER=1` alone starts nothing. `RELAY_KEY_PATH` and `RELAY_STATE_PATH` now name the retired v1 files, read only: the key only to refuse a new key equal to it, the state only to answer old relay ids. No longer read: `DAILY_BUDGET_SATS`, `HOT_FLOOR_SATS`, `POW_BASE_BITS`, `POW_MAX_EXTRA`, `POW_BUDGET_EXTRA`, `ACCEPT_PER_HOUR`, `ACCEPT_PER_DAY`, `REJECT_PER_HOUR`. Above `MAX_FEE_RATE` or `MAX_FEE_PER_TX`, submits of every mode are refused with `fee_high` instead of staying queued. The table below is the original v1 table, kept for the settings that still apply.

| Variable | Default | Meaning |
|---|---|---|
| `RELAYER` | `1` | enables the relayer |
| `RELAY_KEY_PATH` | `data/signet/relayer.key` | 64 hex chars; generated on first start if missing, mode 0600; `data/` is already gitignored and never served |
| `RELAY_STATE_PATH` | `data/signet/relayer.json` | persisted state |
| `MAX_FEE_RATE` | 5 sat/vB | market rate above this: items stay queued |
| `MAX_FEE_PER_TX` | 3000 sats | per-carrier cap |
| `DAILY_BUDGET_SATS` | 100000 | per UTC day (v1 build plan) |
| `MAX_RELAYS_PER_BLOCK` | 40 | Next-block and fast items accepted per tip (batch items have their own caps) |
| `MAX_QUEUE` | 120 | cap on waiting Next-block and fast items (batch items do not count) |
| `HOT_FLOOR_SATS` | 3000 | stop accepting (any mode) when hot balance − reserved − one carrier's fee is below this (v1 build plan) |
| `SAFETY_BLOCKS` | 24 | so `minAnchor = max(idx.height, chainTip) − 76`; also the Hourly batch deadline, S + 76; must be a whole number from 1 to 94, or the relayer refuses to start |
| `BATCH10_SAFETY_BLOCKS` | 12 | 10-hour batch deadline, S + 88; must be a whole number from 1 to 40 (above 40 the deadline would come before the release at S + 60), or the relayer refuses to start |
| `MAX_BATCH_PER_EPOCH` | 40 | waiting items per Hourly batch epoch; 0 turns the Hourly batch off |
| `MAX_BATCH10_PER_EPOCH` | 120 | waiting items per 10-hour batch epoch; 0 turns it off |
| `BATCH_PER_IP` | 3 | batch items per IP prefix, per epoch, per length (on top of the hourly and daily buckets) |
| `MAX_INDEXER_LAG` | 2 | blocks behind the chain tip before refusing |
| `POW_BASE_BITS` | 18 | see 4.3 for the measured cost |
| `POW_MAX_EXTRA` | 6 | adaptive bits from block load |
| `POW_BUDGET_EXTRA` | 2 | added past half the daily budget |
| `ACCEPT_PER_HOUR` / `ACCEPT_PER_DAY` | 10 / 50 | per IP prefix, counts accepted submits |
| `REJECT_PER_HOUR` | 60 | per IP prefix, counts rejected submits |
| IP prefix | IPv4 /24, IPv6 /56 | IPv4-mapped IPv6 is treated as v4 |
| `VERIFY_CONCURRENCY` | 2 | parallel Groth16 checks |
| `VERIFY_MAX_PER_SEC` | 10 | above this: 503 `busy` |
| `FANOUT_TARGET` / `FANOUT_VALUE` / `FANOUT_MIN_CONFIRMED` | 24 / 13000 / 6 | UTXO fan-out (4.6); 13,000 sats is one full chain of 21 carriers at 1 sat/vB |
| `FANOUT_MIN_CARRIERS` | 120 | fan out when the confirmed coins fund fewer carriers than this in one block (4.6) |
| `TRUST_PROXY` | `0` | if `1`, the client IP is the last hop of X-Forwarded-For; otherwise `socket.remoteAddress` |
| `BODY_LIMIT` | 4096 bytes | request body cap |
| `EST_VSIZE` | 597 | carrier size estimate |

### 4.3 PoW (`src/relay-pow.mjs`)

- `TAG = utf8("zkpool/relay/pow/v1")`
- `digest = sha256(TAG ‖ blockHash(32 bytes, from esplora hex) ‖ sha256(envelope) ‖ nonce(8 bytes))`
- Valid iff `leadingZeroBits(digest) ≥ bits` and `blockHash` is the indexer hash at `idx.height`, `−1` or `−2`.
- `bits = 18 + min(6, floor(log2(1 + acceptedThisBlock/8))) + (spentToday + reserved > budget/2 ? 2 : 0)`.
- Exports `powDigest`, `leadingZeroBits`, `checkPow`, and `grind({envelope, block, bits, start, step})`. `grind` clones the prefix hash state.
- **Measured:** noble sha256 runs at about 0.68 MH/s in Node. So 18 bits ≈ 0.4 s on desktop and 1–2 s on phones; 26 bits (under attack) ≈ 100 s.
- This is honestly a speed bump only: GPUs make it trivial. The real limit is the money cap.

### 4.4 HTTP API (added to `indexer-server.mjs`, same origin; Vite already proxies `/api`)

> **Relay balances (2026-10-03, `relay-balance-contract.md` §4.2 to §4.4).** `GET /api/relay/info` gains `mode: "balance"`, `code` (the first failing gate) with `reason` (its message), and a `balance` block (`poolKey`, `perSendSats`, `minDepositSats`, `depositConfirmations`, `sweepCostSats`, `suggestedTopUpSats`, …) in place of `pow` (now `null`) and `budget`; `address` is the pool change address. New: `POST /api/relay/account` (signed balance read) and `POST /api/relay/credit` (unsigned; it can only credit a deposit to the account it pays). The submit body is `{ envelope, mode, accountPub, t, sig }`, a BIP340 signature by the relay account over the endpoint, network, pool key and the body; `pow` is gone. New codes: `bad_outpoint`, `bad_signature`, `stale_request` (401), `balance_low` (402), `deposit_unknown` (404), `already_credited`, `credit_in_progress`, `deposit_unconfirmed`, `replayed` (409), `deposit_mismatch`, `deposit_small`, `deposit_own` (422), `halted`, `fee_high`, `pool_low` (503). Never returned again: `pow_stale`, `pow_insufficient`, `hot_wallet_low`, `budget_exhausted`, `fee_too_high`. Status gains `missed` (with `code` `balance_low` or `fee_high`), `broadcastHeight` and `cost`; the ledger never shows an account, a relay id or a cost per row. The shapes below are the v1 originals.

**`GET /api/state`** gains:
```json
{ "tipHash": "<hex>", "recentHashes": ["<h>", "<h-1>", "<h-2>"], "chainTip": 324812,
  "relay": { "enabled": true, "queued": 3, "defaultMode": "block",
             "batch": { "batch":   { "start": 324810, "releaseAt": 324816, "queued": 2 },
                        "batch10": { "start": 324780, "releaseAt": 324840, "queued": 0 } } } }
```
`queued` counts Next-block and fast items only. `batch` is the epoch of each length that contains the indexer tip (`batchSummary()`), or `null` without a relayer. Its `queued` is a snapshot taken when the relayer first saw that tip, never a live count (see 4.4).

**`GET /api/relay/info`:**
```json
{ "enabled": true, "reason": null, "network": "signet", "ops": ["TRANSACT"],
  "address": "tb1p…", "height": 324812, "chainTip": 324812,
  "pow": { "alg": "sha256", "tag": "zkpool/relay/pow/v1", "bits": 18, "blocks": ["<h>", "<h-1>", "<h-2>"] },
  "anchor": { "window": 100, "safety": 24, "minAnchor": 324736 },
  "fees": { "feeRate": 1, "maxFeeRate": 5, "estVsize": 597, "estFeeSats": 597 },
  "budget": { "day": "2026-10-02", "capSats": 300000, "spentSats": 12345, "reservedSats": 1791,
              "relaysLeftThisBlock": 37, "hotBalanceSats": 410000 },
  "stats": { "relayed144": 17, "accepted": 120, "rejected": 1, "expired": 0, "satsSpent": 71640 },
  "batch": { "perIp": 3,
             "modes": { "batch":   { "epochBlocks": 6,  "maxPerEpoch": 40,  "safety": 24, "enabled": true,
                                     "current": { "start": 324810, "releaseAt": 324816, "lastRelease": 324886, "queued": 2 } },
                        "batch10": { "epochBlocks": 60, "maxPerEpoch": 120, "safety": 12, "enabled": true,
                                     "current": { "start": 324780, "releaseAt": 324840, "lastRelease": 324868, "queued": 0 } } },
             "recent": [ { "mode": "batch", "start": 324804, "releaseAt": 324810, "released": 3, "landed": [[324811, 3]] } ] } }
```
Fee rate and hot balance are cached once per tick, never fetched per request. Nothing in this answer or in `/api/state` moves with a batch acceptance until the next block: `batch.modes[mode].current.queued` is the snapshot taken when the relayer first saw the tip, `pow.bits` counts batch acceptances from the next block on, `budget.reservedSats` (and the `reason` computed from it) leaves out batch reservations made since the snapshot. Both endpoints are public and polled by every wallet; a live count would tell anyone when each batch transfer was submitted. What remains public is the block it was submitted in.

`batch.recent` comes from the carrier ledger: per released epoch, newest first (at most 24 per length), `released` counts its carriers that went out (not `dropped`) and `landed` the `[height, count]` of those with a verdict (accepted or rejected). These counts are what the relayer reports; Audit the relayer checks them against Bitcoin. The audit groups carriers by decoded anchor and landing block (`auditRelayer` in `web/src/relay.js`); a Next-block retry that reuses an envelope anchored at a boundary S and lands from S+7 on is counted in the hourly epoch S, because public data can't tell it apart, and shows as a mismatch. `enabled` is false for a length whose cap is 0.

**`POST /api/relay/submit`**, body:
```json
{ "envelope": "<942 hex>", "pow": { "block": "<64 hex>", "nonce": "<16 hex>" }, "mode": "block" }
```
`mode` (relay timing) is one of:
- `"block"` (default): Next block. Anchored at the tip when proved; sent at the next block.
- `"fast"`: sent 10–40 s after acceptance.
- `"batch"`: Hourly batch. Epochs start at every height divisible by 6. The envelope must be anchored at the start S of the epoch that is open now (the tree at S); it is sent once the indexer reaches S + 6, together with every other item of that epoch, and lands at about S + 7.
- `"batch10"`: 10-hour batch. The same with epochs of 60 blocks: sent at S + 60, lands at about S + 61. It replaced the 12-hour batch (`"batch12"`, 72 blocks, sent at S + 72) on 2026-10-03: carriers with large OP_RETURNs have confirmed 3 to 29 blocks after broadcast on signet, and S + 72 left only 28 blocks before the anchor window closes at S + 100; S + 60 leaves 40. `"batch12"` is now `malformed`.

The epoch lengths are fixed protocol-wide in `src/relay-batch.mjs`, not relayer settings, so every wallet computes the same boundary. Hourly and 10-hour items with the same S land 54 blocks apart: they are separate crowds, and the 10-hour crowd is thinner.

- **202:** `{"id":"<32 hex random>","status":"queued","anchor":324810,"deadline":324910,"flush":"next-block"|"fast"}`
- **202, batch modes:** `{"id":"…","status":"queued","anchor":324810,"deadline":324910,"flush":"batch","mode":"batch","epochBlocks":6,"releaseAt":324816,"lastRelease":324886,"epochQueued":4}`. `flush` equals the mode; `lastRelease` is the relayer's deadline (4.6); `epochQueued` is the published (snapshot) count for this epoch plus this one, never a live count.
- **Error:** `{"error":{"code":"…","message":"…","retryAfter":600,"bits":20}}`. Codes by status:
  - 400: `malformed` (also any other `mode`), `not_transact`, `public_value`
  - 409: `duplicate_nullifier`, `nullifier_spent`, `nullifier_pending`
  - 413: `too_large`
  - 422: `pow_stale`, `pow_insufficient` (returns `bits`), `anchor_unknown`, `anchor_stale`, `proof_invalid`, `anchor_not_boundary` (returns `epochBlocks`), `epoch_closed` (returns `mode`, `epochStart` and `releaseAt` of the epoch open now)
  - 429: `rate_limited`; from the per-epoch batch bucket it says "Your network has sent the most transfers allowed in this batch…" and `retryAfter` is the seconds until the epoch closes, `(S + E − height) × 600`
  - 503: `disabled`, `indexer_behind`, `hot_wallet_low`, `budget_exhausted`, `block_full`, `queue_full`, `fee_too_high`, `busy`, `batch_full` (returns the full epoch's `releaseAt`), `batch_disabled`
- `OPTIONS` returns 204 with allow-methods `GET, POST` and allow-headers `content-type`.

**`GET /api/relay/status/:id`:**
```json
{ "status": "queued|broadcast|accepted|rejected|expired|dropped", "txid": "…", "height": 324813, "reason": "…",
  "anchor": 324810, "deadline": 324910, "mode": "batch", "releaseAt": 324816, "lastRelease": 324886 }
```
`mode`, `releaseAt` and `lastRelease` appear for batch items only; a batch item stays `queued` until its carrier is broadcast. Unknown id returns 404.

**`GET /api/relay/ledger?limit=100&before=<seq>`:**
```json
{ "address": "tb1p…", "totals": { "carriers": 0, "accepted": 0, "wasted": 0, "satsSpent": 0, "fanoutSats": 0 },
  "items": [ { "seq": 41, "kind": "carrier|fanout", "txid": "…", "vsize": 597, "fee": 597, "feeRate": 1,
               "broadcastHeight": 324812, "height": 324813, "outcome": "pending|accepted|rejected|expired", "reason": null } ] }
```
Relay ids are never included in the ledger, and IPs never appear anywhere.

### 4.5 Submit pipeline (in order; first failure rejects; nothing mutates until step 9)

> **Relay balances (2026-10-03, `relay-balance-contract.md` §4.2 submit, §4.5).** The order is now: parse (exact key set) → gates, with `halted` and `fee_high` for every mode → `verifyRequest` and the replay set → the balance check (`balance_low`, 402, before any proof work) → rate limits per IP prefix and per account → decode → nullifiers → freshness and batch step 6b (`pool_low` in place of `hot_wallet_low`) → proof check (an invalid proof costs the account a small penalty) → re-checks → `reserve` (the per-send cost, twice that for a batch) → accept. Steps 2 (accept and reject buckets) and 3 (proof of work) below are gone. At release, `signPoolTx` charges the exact fee plus margin from the reservation before any signature; an item that cannot be paid becomes `missed` and its reservation goes back.

0. **Request shape.** Body read with the 4 KB cap and a 10 s timeout (413 if larger). Parse JSON. Check the regexes `^[0-9a-f]{942}$`, `^[0-9a-f]{64}$` and `^[0-9a-f]{16}$`, and the `mode` value. Any failure: 400 `malformed`.
1. **Global gates**, for the requested mode. Enabled; `idx.height ≥ chainTip − 2`; the first tick has priced fees and counted coins (`busy`); `hotBalance − reserved − estFee ≥ HOT_FLOOR_SATS` (any mode: batch reservations are held for hours); `spentToday + reserved + estFee ≤ budget`; Next-block and fast only: `acceptedThisBlock < 40` (`block_full`) and waiting Next-block and fast items `< 120` (`queue_full`); batch modes only: that length's cap is not 0 (`batch_disabled`); cached fee rate ≤ `MAX_FEE_RATE`. Otherwise 503. Batch items count toward neither `block_full` nor `queue_full`, so a batch flood cannot block Next-block users.
2. **Rate limit.** Bucket key = `HMAC-SHA256(dayKey, ipPrefix)`. `dayKey` is 32 random bytes, kept in memory only and rotated at UTC midnight (buckets are cleared then). Check the accept bucket and the reject bucket. Every later 4xx charges the reject bucket.
3. **PoW.** Is the block hash recent (`pow_stale`)? Are there enough zero bits (`pow_insufficient`, returning the current `bits`)?
4. **Decode.** Strict `decodeEnvelope`, else `malformed`. Require `op === TRANSACT` (`not_transact`) and `publicAmount === 0n && publicAsset === 0n` (`public_value`).
5. **Nullifiers.** `n0 ≠ n1`; neither in `idx.nullifiers`; neither in the pending map (queued, validating, or broadcast and not yet final). Then **reserve both synchronously in the pending map with state "validating"**, so two concurrent identical submits cannot both pass. Release them if any later step fails. Deduplication is by nullifier, not by envelope bytes, so a malleated or re-proven copy is also caught.
6. **Freshness.** `idx.roots.has(anchor) && anchor ≤ idx.height`, else `anchor_unknown`. `anchor ≥ max(idx.height, chainTip) − (100 − safety)`, else `anchor_stale`, with the safety of the requested length: `SAFETY_BLOCKS` (76 blocks back by default) for Next-block, fast and the Hourly batch, `BATCH10_SAFETY_BLOCKS` (88 blocks back by default) for the 10-hour batch, whose submits run until S + 59 whatever `SAFETY_BLOCKS` is.
6b. **Batch modes only** (E = 6 or 60), in this order:
   - `anchor % E ≠ 0`: 422 `anchor_not_boundary`.
   - `idx.height ≥ anchor + E` (the epoch has closed, for example while the wallet was proving): 422 `epoch_closed`, naming the epoch open now.
   - Waiting items of this epoch (same mode and anchor) `≥` the cap (40 hourly, 120 10-hour): 503 `batch_full`.
   - This IP prefix's batch items in this epoch `≥ BATCH_PER_IP` (3): 429 `rate_limited`. The count lives in the same in-memory bucket as the hourly and daily ones (`batch: { "<mode>:<S>": n }`, dropped once the epoch closes) and is cleared with the daily key at UTC midnight, so one network can place at most 2 × `BATCH_PER_IP` items in an epoch that spans midnight.
   - Every waiting item of any mode plus this one would need more carriers than the coins fund in one block (`capacity()`, 4.6): 503 `hot_wallet_low`.
7. **Full check.** Under the semaphore (2) and the 10/s limit: `await idx.checkTx(env, {inputs:[], outputs:[]}, idx.height + 1)` must return `true`. A message matching "verify" or "proof" maps to `proof_invalid`; anything else maps to its own code.
8. Re-check step 5 against `idx.nullifiers`, because a block may have landed during the await; the root at the anchor; the gates of step 1; and, for batch modes, all of step 6b (the epoch may have closed, or concurrent submits may have filled it).
9. **Accept.**
   - Create `id = randomBytes(16)`.
   - Store the item `{id, envelopeHex, nullifiers, anchor, root: idx.roots.get(anchor), mode, acceptedHeight}`, plus `releaseAt` and `lastRelease` for batch items, and set the pending entries to `id`.
   - Reserve `feeRate × 597` against the daily budget (any mode); increment `acceptedThisBlock` (Next-block, fast) or `batchThisBlock` (batch; PoW bits count both, batch acceptances from the next block on); charge the accept bucket, and for batch items the bucket's count for this epoch.
   - **Persist durably (tmp file, fsync, rename, and an fsync of the directory on POSIX), then return 202.**

A 4xx after step 2 charges the reject bucket, as before: so `anchor_not_boundary`, `epoch_closed` and the per-epoch `rate_limited` do; `batch_full` and `hot_wallet_low` (503) do not.

### 4.6 Flush, broadcast, reconcile, persistence

`tick()` in `indexer-server.mjs` becomes: sync, then save the indexer, then `await relayer.onTick({chainTip})`, then publish. Fast-mode timers take the same async lock as `tick`.

**`reconcile()`** runs every tick, before flushing. For each item that is broadcast or accepted, look up its txid in `idx.log` entries above `lastReconciled`:
- `ok` → `accepted`, with height; ledger outcome `accepted`; release the pending nullifiers.
- `!ok` → `rejected`, with reason; ledger outcome `rejected` (wasted); release.
- No verdict and `chainTip > anchor + 100` → `expired` (wasted only if it confirms later); release.
- Reorg: the state stores `lastReconciledHash`, the block hash at `lastReconciled`. A sync can roll back and re-apply in one tick, so `idx.height` need not drop below `lastReconciled`; a changed hash at that height (or a lower `idx.height`) means blocks were replaced. Reconcile then rescans the indexer's whole undo window (`UNDO_DEPTH` = 144 blocks below `lastReconciled`), so a carrier mined into a replacement block gets its verdict instead of expiring. Accepted items whose verdict is gone go back to `broadcast` and their raw tx is rebroadcast; an item whose verdict moved to another height keeps it with the new height. Keep raw tx hex until the carrier has 6 confirmations.

**`flush()`** runs when `idx.height` has increased (block mode), or per item at acceptance + a random 10–40 s (fast mode; that timer path never touches a batch item):
1. Candidates: every queued Next-block and fast item, and every queued batch item with `idx.height ≥ releaseAt` (S + 6, or S + 60). Eligibility uses `idx.height`, the height the flush runs at; deadlines use `max(idx.height, chainTip)`, as `minAnchor` does.
2. For each candidate:
   - If a nullifier is now in `idx.nullifiers`: `dropped` ("notes already spent by another transaction"). Nothing is broadcast and nothing is paid.
   - If `idx.roots.get(anchor) ≠ item.root` (reorg): run `checkTx` again; on failure, `dropped`. A reorg of the boundary block S drops every item of the epoch whose proof no longer holds; the wallet proves again for the next batch with the same notes.
   - Deadline: if `anchor < max(idx.height, chainTip) − (100 − safety)`: `expired`, free. `safety` is `SAFETY_BLOCKS` (24) for Next-block, fast and the Hourly batch, and `BATCH10_SAFETY_BLOCKS` (12) for the 10-hour batch, so the last block a batch may go out at is `lastRelease = S + 76` (Hourly) or `S + 88` (10-hour); the reason reads "the batch could not be sent before block `lastRelease`". A batch item keeps the `lastRelease` stored when it was accepted (the one its 202 promised), so a restart with other safety settings never moves it; an epoch uses the earliest `lastRelease` of its waiting items, and a new item joining it is promised that block, so an epoch expires whole.
   - Next-block and fast: if the market fee rate is unknown or above the cap, or the fee would exceed the per-tx cap or the daily budget (`spentToday + other reservations + fee`): leave the item queued. It expires by the previous rule if this lasts.
3. **Whole-epoch rule.** Batch candidates are grouped by epoch (mode and anchor), oldest anchor first. An epoch is held whole (stays queued, tried again at the next block) when the fee rate is unknown or above the cap, one carrier would cost more than the per-tx cap, `spentToday + (reserved − the epoch's reservations) + n × estFee` exceeds the daily budget, or `n` exceeds the carriers the coins can still fund in this flush (`capacity()` minus the Next-block and fast items going now, which take their coins first). Otherwise the whole epoch is released. It is never sent in part on purpose: a straggler that lands a block after its batch, with the batch's anchor, stands out.
4. Shuffle the released epochs and the passing Next-block and fast items together with a cryptographic RNG; every carrier below is built the same way, so batch carriers look like any other. A carrier that still fails inside a released epoch (a broadcast error) leaves a split batch: it is logged and the item goes out with the next flush, by the journal resend below or as a held item.
5. **Pick a UTXO.** Fetch `esplora.utxos(address)` and exclude outpoints reserved by our own in-flight carriers. Take the smallest confirmed UTXO with value ≥ the fee `planCarrierTx` charges (⌈597.5 vB⌉ = 598 vB × fee rate) + 330, so the change output is always kept. Otherwise take our own unconfirmed change with tracked chain depth ≤ 20. Every carrier has exactly 1 input, 1 OP_RETURN and 1 change output, so all carriers look the same, whatever their timing.
6. **Build.** `planCarrierTx({account, utxos:[u], envelope, feeRate, sequence: 0xfffffffd})`, then `signLocal`.
7. **Journal, then broadcast.** Set status `signing` and store `raw`, `txid` and the spent outpoint, then persist durably (tmp file, fsync, rename, and an fsync of the directory on POSIX). Broadcast through esplora (the server's IP, never the user's). On success: status `broadcast`, a ledger entry with outcome `pending`, `spentToday += fee` minus the reservation, and the change output `txid:1` becomes available at depth+1. An "already known" error counts as success. "missingorspent", "txn-mempool-conflict" and an RBF "rejecting replacement" error all mean the input is spent: the UTXO is marked bad and the item retries once with another coin. A refusal for mempool chain limits ("too-long-mempool-chain", too many ancestors or descendants, cluster limits) means the carrier is valid but its unconfirmed parents must confirm first: it stays journaled and is resent on the next tick without using an attempt, until its anchor window closes. Other errors resend the same journaled bytes on the next tick, up to 3 times, then `dropped` and release. Whatever the result, the coin leaves this flush's UTXO list, so a later item in the same flush never reuses the coin of a carrier whose broadcast failed.
8. Persist after each item. A batch carrier's ledger entry also keeps an internal `epoch` (`"<mode>:<S>"`) for `batch.recent`; `/api/relay/ledger` never shows it.

The 10-hour deadline is S + 88, not S + 76, because the shared safety of 24 would leave only 16 blocks between the release at S + 60 and the deadline; 12 leaves 28 blocks if the relayer stalls, and 12 blocks for the carrier to confirm before the anchor window closes at S + 100. A carrier sent at the release has 40 blocks to confirm. Wallet invariant W-1 is unchanged for both lengths: the notes stay reserved until the transfer lands or until S + 100.

**Coin capacity.** `capacity()` is the number of carriers the hot wallet can fund in one block: with `per` the fee of one carrier at the current rate (598 sats at 1 sat/vB), a coin at chain depth `d` funds `min(21 − d, floor((value − 330) / per))` carriers in a chain (depths 0 to 20, the mempool's ancestor limit allowing). Confirmed coins are depth 0, our own unconfirmed change counts at its tracked depth, unconfirmed coins of unknown depth and reserved or bad outpoints count 0. Every output of an unconfirmed fan-out, and every chain on them, descends from that one transaction, and Bitcoin Core accepts at most 25 transactions in such a family: together they count at most 24 carriers, minus those already sent below it, and coin selection stops chaining on them at 24. Today's hot wallet (7,000 + 3 × 10,000 sats) funds 59 carriers; a full 10-hour release of 120 needs about 80,000 sats spread over 6 coins. Independently, the balance gate (4.5 step 1) stops acceptance at about 56 waiting items with 37,000 sats.

**Fan-out.** At the start of a tick, fan out when fewer than 6 confirmed UTXOs have value ≥ 2×`MAX_FEE_PER_TX`, or when the confirmed coins fund fewer than `FANOUT_MIN_CARRIERS` (120) carriers in one block. Only the largest confirmed coin is split, and only if one chain of 21 carriers cannot use it up in a block (`floor((value − 330) / per) > 21`): splitting a smaller coin adds a fee and no capacity, so a 10,000-sat coin is never split. It becomes up to 24 × 13,000 sats (one full chain each) plus change. A coin worth one to two chains (about 13,500 to 26,500 sats at 1 sat/vB) becomes one 13,000-sat output and its change, if that change still funds a carrier: a 25,000-sat top-up then funds 40 carriers in a block, not 21. It appears in the ledger as `kind: "fanout"`, journaled with its raw bytes before the broadcast.
- Each tick, a pending fan-out the explorer does not know is rebroadcast with the same bytes. If its input is gone and the explorer still does not know it, it is marked `dropped` and its coin unreserved.
- A fan-out whose broadcast result was lost in a crash is counted against the daily budget once, and its outputs become chainable at depth 1, as soon as the explorer knows it or the resend succeeds.

**Startup.** Load state, then rebroadcast the raw tx of every `signing` or `broadcast` item. If the resend reports a spent input, ask the explorer about its txid: a known transaction counts as sent; only an explorer answer that it does not know the txid (see Explorer errors) marks the item `dropped` and releases it. Queued batch items simply wait in the state file and go out at their `releaseAt`, as if nothing had happened.

**Explorer errors.** A lookup counts as "not found" only when the explorer says so: an error that reads 404, "not found" or "no such". The relayer reads GET `/tx/<txid>` for this (`statusOf`), which answers an unknown txid with 404 "Transaction not found"; `/tx/<txid>/status` answers 200 `{ confirmed: false }` for a txid it has never seen, never a 404, so it is used only by a client without `tx()`. Any other failed lookup (429, 5xx, network) never drops anything: a pending fan-out or a journaled carrier stays as it is until the next tick or resend.

**State file** (`data/signet/relayer.json`):
```
{ "version": 1, "day": "…", "spentToday": 0, "reserved": 0, "lastReconciled": 0, "lastReconciledHash": "…",
  "items": { "<id>": { "status": "…", "nullifiers": [], "anchor": 0, "root": "…", "mode": "…",
                       "acceptedHeight": 0, "envelope?": "…", "txid?": "…", "raw?": "…",
                       "fee?": 0, "height?": 0, "reason?": "…", "releaseAt?": 0, "lastRelease?": 0 } },
  "ledger": [ … ], "reservedOutpoints": [ … ] }
```
- `envelope` is kept only while the item is queued.
- `releaseAt` and `lastRelease` exist for batch items only (`mode` `"batch"` or `"batch10"`); an item saved without them gets them back from its anchor and mode on load. The state `version` stays 1: the fields are additive.
- Items in a final status are pruned after 1008 blocks. The ledger is kept.
- The file never contains an IP, a bucket key or a per-IP count. A test checks this.

### 4.7 Indexer and circuit

- **Consensus changes: none.** Only the documentation changes: A-10 in `audit/REPORT.md`, and a non-consensus "Relayer" section in `SPEC.md`.
- **Optional:** if a profile shows the relayer's log scan is slow, add a read-only `txid → verdict` helper. It must not change any rule.

### 4.8 Wallet and UI (`web/`, all text in English)

**`web/src/relay.js`:**
- `info()`
- `submit(envelope, {mode})`: grinds the PoW in `pow-worker.js` (a module worker; falls back to grinding on the main thread in chunks), then POSTs. On `pow_insufficient` it grinds again once with the returned `bits`. On `pow_stale` it fetches info again and grinds again.
- `status(id)`

**`session.send(asset, amount, to, onStep, {via: "relay"|"self", mode})`** steps:
1. Sync.
2. Fail early if notes are short.
3. Prove; `anchor = view.height`.
4. **Verify the proof locally** with snarkjs (about 20 ms) and show "Proof verified in your browser".
5. Relay path: grind, submit, then `record({kind:"send", via:"relay", relayId, spends, anchor, status:"relaying"})`.
6. Self-paid path: as today.

**`refreshHistory`, for relay entries:**
- If every spend is in `view.nullifiers`, mark the entry `accepted`. This holds whoever carried it.
- Otherwise call `/api/relay/status/:id` only.
  - `queued` or `broadcast` → `relaying`.
  - `rejected`, `expired` or `dropped` → `failed`, with the reason.
- **Never call mempool.space for a relayed txid.**

**W-1 lock rule** (a pure exported function `lockedNullifiers(history, height, nullifierSet)`):
- An entry's spends stay locked while all of these hold:
  - its status is `mempool`, `relaying`, `failed` or `dropped`;
  - `height ≤ entry.anchor + 100`;
  - its spends are not yet all in the nullifier set.
- This also applies to self-paid `dropped` entries; it fixes the double-pay case in today's code.
- Failed entries offer:
  - [Retry with the same notes]: `Wallet.transfer` with an `inputs` override, the same recipient and amount, and `retryOf` linking it to the failed entry.
  - [Pay the fee myself (links this transfer to your BTC address)]
  - [Copy envelope hex]
  - "Notes unlock at block X (~N h)"

**Send form:**
- Route choice:
  - "Private relay: free, your BTC wallet is not used" (default)
  - "Pay the fee myself: links this transfer to your BTC address"
- "Relay timing" under the relay route (hidden for self-paid sends), three stops: "Fast (~1 min)" | "Next block" (default for payments) | "Batch", and under Batch a "Batch length" row: "Hourly batch" (default for merges and refreshes) | "10-hour batch". The control, its defaults and every line under it are specified in `docs/design/privacy-level2.md` §6.1 to §6.3; the strings live in `BATCH_TEXT` (`web/src/views/app-shared.js`), not here.
- Proving steps end on "Queued for the next block" (Next block, Fast) or "Scheduled for the batch" (both batch lengths).
- Activity chips: "Queued at relayer", "Broadcast by relayer", "Accepted"; for batch sends "Scheduled", "Going out with the batch" and "Needs attention" (overdue, missed or failed).
- If a mint from this wallet confirmed less than 3 blocks ago: "You minted from your BTC address recently; wait a few blocks for better privacy."

**"Relayer" panel** (titled "Proof of sponsorship"):
- Relayer address with a mempool.space link.
- Today's budget meter, ledger table and totals.
- Meter: "Relayed transfers in the last 24 h: N". Below 5: "Few relayed transfers right now; timing can still link you."
- **[Audit the relayer]**: the browser fetches `/address/<relayer>/txs` from mempool.space. It decodes each OP_RETURN locally and checks that every transaction is a single-TRANSACT carrier, a fan-out or a top-up, and that every fee matches the ledger. Result: "Ledger matches Bitcoin: 128/128". This page only touches the public relayer address, so it leaks nothing about the user.

**Unchanged:** mint and deploy stay self-paid.

**Storage:** relay ids are capabilities. Keep them in history sealed by `keystore.js`, which is roadmap step 1.

### 4.9 CLI (`bin/zkp.mjs`)

- `zkp send <w> TICKER amt zp1… --relay [url] [--fast]`: grinds in Node, submits, polls status.
- `zkp relayer status`: address, balance, queue, totals.
- `zkp relayer ledger`
- `zkp relayer fanout`: operator command; reads the local key.

### 4.10 Docs

- `SPEC.md`: a "Relayer (non-consensus)" section with the API, PoW formula, statuses, trust table and W-1.
- `audit/REPORT.md`: add A-10 (carrier independence; unshield must bind destination and fee) and A-11 (W-1). The wallet invariant is classed Medium, because today's self-paid "dropped" path can pay twice.
- `README.md`: claims from section 6 only.

### 4.11 Tests (`test/relayer.test.mjs`)

Uses the synthetic-block harness from `indexer.test.mjs`. Blocks must carry `hash`, because the PoW challenge uses it. Uses a `FakeEsplora` (utxos, feeRate, broadcast that records raw hex, tipHeight, txStatus) and `bits = 4` for speed.

1. `relay-pow`: a valid round trip passes; a wrong block, wrong envelope or too few bits fails; `leadingZeroBits` edge cases.
2. A valid transfer gets 202 and both nullifiers are pending.
3. The same envelope again gets 409 `nullifier_pending`. **A different envelope that re-proves the same notes** also gets `nullifier_pending`.
4. Two concurrent submits with the same notes: exactly one 202.
5. Each of these returns its own code:
   - a MINT envelope (1014 hex): `malformed`
   - an altered `publicAmount` byte: `public_value`, raised before proof verification
   - an anchor field patched to `idx.height+5`: `anchor_unknown`
   - 80 empty blocks after proving: `anchor_stale`
   - a flipped ciphertext byte: `proof_invalid`
   - an old block hash: `pow_stale`
   - too few zero bits: `pow_insufficient` with `bits`
   - after the transfer lands: `nullifier_spent`
   - a tiny budget: `budget_exhausted`
   - a per-block cap of 1: `block_full`
   - `ACCEPT_PER_HOUR=1`: `rate_limited`, while a different /24 still succeeds
   - an indexer that is behind: `indexer_behind`
6. Flush after a new block:
   - Exactly one broadcast. It has 1 input from the relayer, `output[0]` is the exact envelope as OP_RETURN, there is 1 change output, and the input sequence is `0xfffffffd`.
   - Parse the raw tx with `btc.Transaction.fromRaw`, mine it, and reconcile: status `accepted`, ledger `accepted`.
   - Bob's scan finds the note.
   - The relayed carrier shares no input or output script with Alice's built-in BTC address.
7. The user self-carries a same-notes envelope that is mined first: the item becomes `dropped` and **broadcast is never called**.
8. The fee rate stays above the cap for 77 blocks: `expired`, no broadcast.
9. A conflicting envelope is mined ahead of the carrier in the same block: `rejected`, ledger outcome wasted.
10. Restart:
    - The queue and pending nullifiers are restored from `relayer.json`.
    - An item an older relayer queued as `"batch12"` keeps its saved `releaseAt` and `lastRelease`: it waits for its release and expires at its promised deadline, never going out with the next block.
    - A `signing` journal entry is rebroadcast with identical raw hex.
11. Privacy: responses and `relayer.json` do not contain the test IP string.
12. Wallet:
    - `lockedNullifiers`: a failed entry stays locked until `anchor+100`; an accepted entry unlocks.
    - `transfer({inputs})` reproduces the same nullifiers.
13. Reorg: the carrier's block is rolled back, the status returns to `broadcast` and the tx is rebroadcast.

Relay timing (the Hourly and 10-hour batch) is tested in `test/batch-relayer.test.mjs`, following `batch-contract.md` §8.

### 4.12 Live acceptance on signet (manual)

1. Fund the relayer from a faucet, then run fanout.
2. Send privately from a wallet whose built-in BTC address holds **0 sats**. Confirm on mempool.space that the carrier spends from the relayer address, and that the wallet's address has no new transaction.
3. A Unisat-connected user can now send.
4. "Audit the relayer" shows a ledger that matches the chain.

**Effort:** about 12–14 hours.

## 5. Changes to Design 1 as proposed

- PoW base lowered from 22 to 18 bits, based on the measured hash rate.
- RBF bumps deferred: signet fees are flat and every carrier has at least 76 blocks of runway. Carriers still signal RBF with sequence `0xfffffffd` (scure's default `0xffffffff` does not).
- Decoys dropped: they inflate statistics dishonestly.
- Phase-B blind RSA credits claimed over HTTP replaced by on-chain tickets. A claim over HTTP ties the claimant's IP to the mint, and an RSA key per user cannot be ruled out without an on-chain key pin.
- Added: the W-1 invariant, a verification-rate cap so Groth16 checks cannot flood the event loop, reserving nullifiers before the await, write-ahead journaling around broadcast, and the `indexer_behind` gate.

## 6. Claims

**May say:**
- "Your BTC wallet never touches your private transfers."
- "The relayer can't see who, what or how much, and can't change a byte: the zero-knowledge proof locks it."
- "Every sponsored sat is on Bitcoin. Audit the relayer from your browser."
- "If we disappear, anyone can carry your envelope."
- "Every rule is re-checked by replaying Bitcoin data with open-source code."

**Must not say:**
- "untraceable"
- "fully anonymous"
- "the relayer learns nothing" (it sees IP and timing)
- "trustless relayer" (say "non-custodial")
- "Bitcoin verifies the proofs"

## 7. Pre-mainnet plan (in order)

1. **Rename release** (new name and magic bytes; one signet reset).
   - Add `expiry u32` to every proof-carrying body, covered by `extDataHash`, so **no circuit change**.
   - Indexer rule: `height ≤ expiry ≤ anchor+100`.
   - Wallet uses one uniform policy, `expiry = anchor+18`, so the field leaks nothing.
   - Effects: the relayer's hold time and the W-1 lock shrink to about 3 hours.
   - Batching is optional, and only if signet is first shown to relay a transaction with 2 OP_RETURNs. Rule: if every zkp OP_RETURN in a transaction is TRANSACT (at most 16), apply them all in output order; otherwise apply the first only, as today.
2. **Paid relaying with blind tickets (Design 3), with three corrections.**
   - **1 ticket per send, fixed per epoch in the on-chain RELAYER announcement.** Design 3's off-chain `ticketsPerSend` is a channel for tagging users. Above `feeCap` the relayer holds sends and refunds them through the refund points.
   - Effort is about 30 hours, not 13.
   - The relayer explicitly rejects the BLS identity point (noble's `fromHex` accepts it).

   Other parts:
   - Issuance after k confirmations.
   - Tickets derived from the seed.
   - The bulletin is downloaded in full.

   On mainnet the free lane becomes an optional marketing budget that anyone can exhaust, or is turned off.

   Built on tickets later:
   - **Stealth mints:** MINT_SCRIPT bound to the relayer's script, paid in tickets, refused when the cap margin is thin.
   - **Gas drops:** launch teams buy ticket packs and hand them to holders. The team can see when those tickets are spent, and the UI says so.
3. **Broadcast robustness.**
   - RBF at `expiry − 6`, capped; CPFP as a fallback.
   - Our own bitcoind (A-9) plus broadcasting to several endpoints.
   - Skip envelopes whose nullifiers are already in the mempool.
4. **Hardening.**
   - Groth16 verification in a worker thread.
   - An argon2id PoW option.
   - A `.onion` endpoint.
   - A hot-wallet cap with automatic sweep and alerts.
   - The signer split into its own process. It accepts only the 1-in / OP_RETURN / change template under the fee cap, so remote code execution in the HTTP layer cannot sweep the hot wallet.
5. **Wallet JS integrity**: reproducible builds, published hashes and a mirror. This is the main remaining trust point.
6. **Circuit decisions before the MPC ceremony.** Decide any arity change, such as 3 inputs to merge notes, on its own merits; Design 2's slot logic is not adopted. Then run the external audit (circuit, indexer, relayer, tickets) and the MPC ceremony.
7. **Legal review** before operating a mainnet relayer for a privacy protocol (Tornado and Samourai are the precedents). Open-source the relayer so the RELAYER registry can list independent operators. More relayers split the anonymity set; document that.
8. **Unshield, later.** It must put the destination and relayer fee inside `extDataHash` and respect A-5's |publicAmount| < 2^63 bound.

Main files: `src/indexer.mjs` (checkTx carrier-independence, line 81), `src/btc/funding.mjs` (planCarrierTx, needs `sequence`), `server/indexer-server.mjs`, `web/src/session.js` (refreshHistory, W-1 fix), `src/wallet.mjs`, `web/src/keystore.js`.
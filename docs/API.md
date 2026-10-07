# Indexer HTTP API

`npm run indexer` (`server/indexer-server.mjs`) serves the pool data, the pinned circuit artifacts, the optional relay endpoints and the built web app from one origin (default port 8787, `MURKLE_INDEXER_PORT`).

Conventions:
- Bigints are decimal strings and bytes are lowercase hex, unless noted.
- Errors are `{ "error": { "code", "message", ... } }` with an HTTP status; `message` says what happened and what to do.
- `OPTIONS` answers CORS preflights for `/api/*` (`GET, POST`, any origin).
- **Bulk only.** There is no per-transaction lookup: asking an indexer about one txid or nullifier would tell it which transactions are yours. Every endpoint serves data every wallet downloads anyway. `GET /api/log?txid=…` and `?nullifier=…` answer 400.

## Pool data (GET)

| Endpoint | Answer |
|---|---|
| `/api/state` | `{ protocol, brand, network, height, startHeight, chainTip, tipHash, recentHashes, root, digest, outputs, nullifiers, genesis: { txid, height, manifestSha256 } \| null, preGenesis, warning?, anchorWindow, syncing, lastError, lastSync, artifacts, relay: { enabled, mode, queued, defaultMode, batch }, chain: { source, headers } }`. `outputs` and `nullifiers` are counts; `warning` is present only before genesis. `tipHash` and `recentHashes` belong to the same published snapshot as `height`: `recentHashes` is the block hashes at `[height, height - 1, height - 2]`, cut at the first height with no known hash (never filtered across a gap). `artifacts` is the pin check of the served circuit files, rechecked whenever one of them changes on disk. `network` is `signet` or `mainnet` (`MURKLE_NETWORK`). `chain.source` is `esplora` or `bitcoind`; `chain.headers` is the header chain's status (`{ verified, network, rules, base: { height, hash }, tipHeight, tipHash, headers, workHex, lastError }`, SPEC.md §16) or `null` when headers are not verified (signet with `MURKLE_HEADERS=off`, or a build without the header module). |
| `/api/health` | Liveness and the checks a monitor alerts on: `{ ok, network, height, chainTip, lagBlocks, lastSync, syncAgeSecs, lastError, source, headers: { verified, tipHeight, baseHeight, lastError } \| null, relayer: { enabled, halted, code }, artifacts: { ok }, preGenesis }`. Always 200 while the process serves (container health checks). With `?strict=1` it answers 503 when `ok` is false: `lastError` set, `lagBlocks` above `MURKLE_HEALTH_MAX_LAG` (3), no sync for 600 s, an artifact mismatch, a header error, or a halted relayer. |
| `/api/outputs?from&to` | `[{ leafIndex, commitment, ciphertext, height, txid }]` for leaves `[from, to)`. `to` lets a wallet fetch exactly the outputs of the snapshot whose root it checks. |
| `/api/commitments?from&to` | `[[commitment, height]]`, the same range as `/api/outputs`, for cheap tree rebuilds. |
| `/api/nullifiers` | `[decimal string…]`, every spent nullifier. |
| `/api/log?from=<seq>&limit=<1..500>` | `{ items: [entry…], next, total }`. An entry is `{ seq, height, index, txid, op, opName, ok, reason?, asset?, ticker?, amount?, kind?, hash?, ref?, difficulty? }`; `opName` is DEPLOY, MINT, MINT_SCRIPT, TRANSFER, ATTEST, DEPLOY_POW, MINE, MINE_SCRIPT or UNKNOWN. Transfer entries never carry `asset` or `amount`. A mining claim (MINE, MINE_SCRIPT) shows the token, the reward (`amount`), the reference height `ref` and, when accepted, the difficulty it met (`difficulty`, D_eff); never a recipient. Below the mining activation height, ops 7, 8 and 9 are `UNKNOWN` with reason `malformed: unknown op N`, exactly as before. |
| `/api/roots?from&to` | `[[height, root]]`, at most 2000 heights. |
| `/api/roots?height=H` | `{ height, root }`, 404 for a height the indexer has not applied, 400 when `height` is empty or not an integer. Wallets should prefer the range form: one height would single out a transaction. |
| `/api/digest?height=H` | `{ height, version?, digest, blockHash, root }` (default: the indexer height). The state digest is defined in SPEC.md §10. `version` is present only from digest version 2 on (from the mining activation height); absent means version 1. |
| `/api/digests?from&to` | `[[height, digest]]`, at most 2000. |
| `/api/assets` | `[asset + stats]`: paid-mint tokens only, each with `kind: "mint"`. Mined tokens are listed by `/api/mine`. |
| `/api/assets/:ticker` | One token of either kind: a paid-mint token with its stats and `mintsByHeight`, or a mined token's `MinedView` (`kind: "pow"`, below); 400 for a malformed ticker, 404 for an unknown one. |
| `/api/mine` | `{ activation: { height, active }, tip: { height, hash }, assets: [MinedView] }`: every mined token with its `status`. `activation.height` is the mining activation height (`null` while mining is off); `active` says whether the mining rules apply to the next block. |
| `/api/mine/:asset` | One mined token by ticker or decimal asset id (a string of digits is tried as an id first): `MinedView` plus `{ tip: { height, hash }, window: 12, staleFactor: 4, pendingClaims, pendingReward, hashrateEstimate, series: { difficulty: [[height, "D"]], claims: [[height, n]] } }` over the last 144 blocks. `pendingClaims` is the relayer's count of claims on their way (its own queue and the mempool claims it can see that pay the service fee and meet the difficulty, best effort), `null` without a relayer; `pendingReward` is the sum of their rewards as a decimal string (each at its own reference block, so a halving between them counts right), `null` without a relayer. The difficulty series is rebuilt from the log (a chart, not consensus). 400 when `:asset` is neither a ticker nor an id, 404 for an unknown or paid-mint token. |
| `/api/stats` | `{ notes, nullifiers, privateTransfers, transfers144, transfers1008, mints, tokens, deploys, attests, rejected, height, series: [[height, newNotes, transfers]] }`. `deploys` and `attests` count accepted DEPLOY and ATTEST operations; `height` is the indexer height the statistics were computed at; `series` covers the last 1008 blocks. Once a mining claim has been accepted, the object also carries `mines` (accepted MINE and MINE_SCRIPT claims); before that the key is absent. |
| `/api/blocks?limit=<1..144>` | `[{ height, hash, ops: { deploy, mint, transfer, attest, rejected, mine? } }]`, newest first (default 24). `mine` (accepted mining claims) appears only on a block with at least one; a DEPLOY_POW counts as a `deploy`. |

`MinedView` (bigints as decimal strings): `{ asset, kind: "pow", ticker, divisibility, status, deployTxid, deployHeight, bodyHash, mineStart, startHeight, endHeight, span, targetPerSpan, reward, baseReward, halvingInterval, nextHalving, difficulty, staleFloor, target, initialDifficulty, minDifficulty, issued, maxSupply, claims, rejectedClaims, feeSats, burnedFeeSats, claimFeeSats, treasury, treasuryAddress, feeOutputs: [{ script, address, sats, role }], firstClaimHeight, claims144, flags: { lowFloor, recipientDiscount } }`.
- `status` is `mining-soon`, `mining`, `mined-out` or `mining-ended` (names that never collide with the paid-mint statuses `live`, `upcoming`, `sold-out`, `ended`).
- `reward` is the reward of a claim referencing the tip (after halvings); `difficulty` is D at the tip, `staleFloor` D / 4 and `target` the 64-character hex target for D.
- `feeOutputs` are the service-fee outputs every claim's carrier must pay (`role` `platform`, `deployer` or `both`). `flags.recipientDiscount` is true whenever one exists: the fee recipient's own claims cost it that fee less. `flags.lowFloor` marks a floor or initial difficulty far below an honest browser launch at the estimated hashrate.
- `feeSats` counts the gross sats paid to the fee scripts by accepted claims, `burnedFeeSats` the same for rejected claims of the token (their fees are spent anyway).
- The hashrate (`hashrateEstimate` on `/api/mine/:asset`) is an estimate: the difficulty met by the accepted claims of the last 144 blocks, per second.

`murkle audit --compare <indexer url>` replays the chain locally and compares its digests with these endpoints.

## Circuit artifacts (GET)

`/artifacts/transaction.wasm`, `/artifacts/transaction.zkey`, `/artifacts/verification_key.json`, `/artifacts/manifest.json`: the files pinned by sha256 in `src/pins.json`. A client checks each one against the pins before using it, so the source does not need to be trusted (`npm run artifacts:fetch` does this; see the README). The server rechecks the files whenever one changes on disk: a file that no longer matches its pin answers 503 `unavailable` (`Cache-Control: no-store`) until it matches again, and `/api/state` `artifacts` reports the mismatch.

## Relay (optional, non-consensus)

A server runs the paid relayer only with `MURKLE_RELAYER=1 MURKLE_RELAY_MODE=balance` and a valid configuration (README, "Relaying: prepaid relay balances"). Otherwise these endpoints answer "not available".

| Endpoint | Answer |
|---|---|
| `GET /api/relay/info` | The relayer's settings, prices, batch epochs and pool key; `{ enabled: false, code: "disabled", ... }` when no relayer runs. `docs` names `docs/design/relay-balance.md`. `mine` describes mining claims (below). `balance.mix` = `{ k, coverOk, depositors }` (pool cover, below). |
| `POST /api/relay/submit` | A signed `{ envelope, mode, accountPub, t, sig }`, optionally with the signed boolean `linkable`; 202 when queued. The envelope is a private transfer (471 bytes) or a MINE_SCRIPT mining claim (511 bytes). |
| `POST /api/relay/account` | A signed `{ accountPub, t, sig }`; the balance, reservations and next deposit index. |
| `POST /api/relay/credit` | `{ outpoint, accountPub, n }` (not signed: it can only credit a deposit to the account it pays). |
| `GET /api/relay/status/:id` | The status of one relayed item (the id is the wallet's own; the relayer already holds the envelope). A mining claim adds `{ kind: "mine", ref, lastBroadcast, solutionId, serviceSats }`, and its `deadline` is `ref + 12`. A queued item sent as linkable adds `linkable: true`. Once a carrier is settled the relayer no longer saves its `cost`, anchor or mode, so after a restart the answer for a settled item leaves out `cost`, `anchor`, `deadline`, `mode`, `releaseAt` and `lastRelease` (it keeps `status`, `txid`, `height`, `broadcastHeight`, `reason`, `code`). |
| `GET /api/relay/ledger?limit&before` | The carrier ledger: txids and fees, with no account or relay id. A mining claim's carrier also shows `serviceSats`, the service-fee outputs it paid besides the miner fee `fee`. |

The request formats, error codes and invariants are in SPEC.md §14 and `docs/design/relay-balance-contract.md` §1 and §4; batch timing in `docs/design/batch-contract.md`.

### Compromised keys: evacuation and rotation

When the relayer's keys may be known to someone else, its operator freezes it, sweeps its coins to a cold address, rotates to new keys and refills the new pool (`docs/design/relay-balance.md` §9, `docs/OPERATIONS.md` 10.4.1). Balances are kept in full throughout: they belong to the account key, not to a pool key.

- `info.balance.depositsOpen` (boolean): false while the relayer takes no top-ups (evacuating, paused, or waiting for its new pool). A wallet then shows and pays no deposit address. Absent (an older relayer): open.
- `info.balance.generation` (integer): the key generation, 0 until the first rotation.
- `info.balance.retiredPoolKeys` (array of 64-hex x-only keys): the pool keys of earlier generations. Deposit addresses are derived from `poolKey` only; an address derived from a retired key must never be shown or paid again. A wallet may still look up the addresses it showed under a retired key and ask `POST /api/relay/credit` for a payment found there (from an exchange, say): the relayer records it (`deposit_retired`).
- `info.code` and `/api/health` `relayer.code` carry the codes below; `relayer.halted` is true while any of them applies.
- `POST /api/relay/account` (a balance read) is still answered during an evacuation and before the refill, under the current `poolKey`.
- `/api/relay/ledger` lists the emergency transactions too, each with its `kind`: `evacuation` (a sweep of the relayer's coins to the operator's cold address; `fee` is its fee, paid from the margin and the operator's own funds, never from a balance), `refund` (the operator's refill of the new pool; `fee` 0, the cold wallet paid it) and `retired-sweep` (deposits to retired addresses moved into the pool).

| Code | HTTP | When |
|---|---|---|
| `relayer_evacuating` | 503 | The relayer is moving its coins to safety: no sends, credits or top-ups. Queued sends become `missed` with this code, nothing charged. Pay the fee yourself or copy the envelope; the balance is kept. |
| `pool_unfunded` | 503 | The relayer rotated to new keys and takes no sends or credits until its operator has refilled the new pool (I2 holds again). `poolKey` is already the new key. |
| `maintenance` | 503 | An operator tool holds the relayer for a moment (for example while it sweeps late deposits). Try again later. |
| `deposit_retired` | 409 | The deposit paid an address of a retired pool key. It is recorded (`{ status: "waiting" \| "swept", value }`) and credited, as any deposit, once the operator has swept it into the new pool and the pool covers it (`swept` can last until the operator's next refill); ask again later (a credited one then answers 200 `already: true`). Another account asking for the same output gets `already_credited`. |

### Pool cover and linkable sends

A carrier's input is a pool coin, and the chain shows which deposits that coin's value came from. The relayer records, per pool coin, how many different depositing accounts it descends from (as opaque tags, never account ids). A carrier spends only a coin that descends from at least `k + 1` accounts, whoever sends (`MURKLE_RELAY_MIN_MIX` = `k`: 3 on signet, 5 on mainnet; 0 turns the rule off and is refused on mainnet), so every sender has at least `k` others there and the coin a carrier spends does not show whether its sender is among them. Merges mix each new deposit with a pool coin of other accounts when there is one; a lone account's deposit is never merged on its own unless a queued send needs it.

- `info.balance.mix` = `{ k, coverOk, depositors }`: `coverOk` is true when a coin descending from at least `k + 1` accounts can fund a carrier now, counting only the merge the relayer will actually sign (the same answer for every sender; always false when `k` is 0); `depositors` is the number of accounts that have had a deposit credited. Wallets treat a `k` below 3 as no cover.
- When no coin covers a send, the pool is thin: submit answers 409 `pool_thin` with `{ k, depositors }`, before any proof check and with nothing reserved. Pay the fee yourself, or sign the same submit again with `linkable: true`.
- With `linkable: true` (inside the signed fields; any other value is `malformed`) a thin pool still takes the send, and its carrier spends the coin with the widest history there is: its input can then tie it to your top-up address. The 202 adds `linkable: true`, and `thin: true` when no coin covered the sender at acceptance. A wallet must never show such a send as hiding its sender.
- A queued item whose cover is gone when it is due (not linkable) becomes `missed` with `code: "pool_thin"`; nothing is charged.
- Signature: `linkable` is signed like every other field (keys sorted, no whitespace, JSON `true` / `false`).

| Code | HTTP | When |
|---|---|---|
| `pool_thin` | 409 | Too few people have topped up the relay pool, so this send's input would tie it to your top-up address. Pay the fee yourself, or confirm to send it linkable. |

Every transaction the relayer builds (carriers, merges, fan-outs) signals replacement (nSequence `0xfffffffd`) on every input, as every other route of this software does, although the relayer never replaces one; fees are a whole sat/vB rate, rounded up, times the vsize, rounded up. Merge inputs go in a random order; a fan-out's or a claim carrier's change takes a random position (after the OP_RETURN, which stays output 0).

### Mining claims through the relayer

Mining (`docs/design/mining.md` §9, `docs/design/mining-contract.md` §9) is off until the owner pins its activation height; until then `info.mine.code` is `mine_disabled` and every claim answers it.

`info.mine` = `{ enabled, code, bindScriptHash, modes: ["fast", "block"], slack: 2, estVsize: 684, feeRate, carrierFeeSats, marginSats, invalidPowSats }`.
- `bindScriptHash` is `sha256` of the relayer's change script C (null while claims are off). A relayed claim is a MINE_SCRIPT bound to it; the relayer's carrier spends C coins only, so a copy is invalid anywhere else.
- `feeRate` is the carrier's rate: the next-block rate (mempool.space `fastestFee`) times `MURKLE_RELAY_MINE_FEE_HEADROOM` (1.25), rounded up. A claim's carrier is never accelerated after it is sent, so it pays this rate up front.
- One claim costs `carrierFeeSats + Σ service fees of the token + marginSats` from the relay balance. On signet the service fee is 500 sats to the Murkle platform address, the same for every mined token.

Submitting a claim: the same signed body as a transfer. The relayer checks, in this order, and the first failure answers: the gates (`mine_disabled` when mining is not active at the next block or the relayer runs no Argon2 worker pool); the signature; the balance (402 `balance_low` with `{ balance, needed, perSend }`); pool cover (409 `pool_thin` unless `linkable: true`); the per-account limits; the decode, the mode, the bind and the fee scripts; the cheap mining rules against its own indexer, its deadline, the queue and the supply cap counting claims in flight; the work, in the worker pool; the proof. A 202 answers `{ id, status: "queued", kind: "mine", ref, lastBroadcast, deadline, solutionId, reservedSats, serviceSats, balance, flush }`: the carrier is signed only while the tip is at most `lastBroadcast` (`ref + 9`), re-sent only while it is at most `ref + 11`, and `deadline` (`ref + 12`) is the last block it can land in.

| Code | HTTP | When |
|---|---|---|
| `mine_mode` | 400 | A batch mode: it would land after the claim's 12-block window. Use `block` or `fast`. |
| `bind_stale` | 409 | The claim is bound to another change script; the body names the current `bindScriptHash`. Prove again; the solution still counts. |
| `solution_claimed` | 409 | This solution was already claimed on chain. |
| `solution_pending` | 409 | This solution is already in the relay queue. |
| `cap_reached` | 409 | The supply is mined out, counting claims already on their way. Nothing was charged. |
| `expired` | 422 | The tip is past `ref + 9`, or the reference is outside the 12-block window. |
| `stale_work` | 422 | The work meets the reference block's difficulty but not the stale bound (the difficulty jumped more than 4x). No penalty. |
| `pow_invalid` | 422 | The work does not meet the difficulty. `invalidPowSats` (20) moves from the balance to the margin, and it counts toward the per-account invalid limit. |
| `mine_unsupported` | 422 | A fee output of this token pays the relayer's own key or a deposit address. Pay the fee yourself. |
| `mine_rejected` | 422 | Another indexer rule refuses it; the body names the `reason` (unknown asset, asset is not mined, mining not started, mining closed, mining ended, reward differs from terms, unknown reference block). |
| `mine_disabled` | 503 | The relayer is not taking claims (mining inactive, `MURKLE_RELAY_MINE_ENABLED=0`, or no worker pool). |
| `not_transact` | 400 | Any other operation (a MINE bound to an outpoint, a mint, a launch). |

`busy` (503) also answers a claim when the account already has a work check in flight, when the Argon2 queue holds `MURKLE_RELAY_POW_QUEUE` (64) tasks, or when a worker fails (never a verdict, nothing charged). `pool_low` answers when no confirmed pool coin is free for one more claim's carrier: a claim's carrier spends a confirmed coin, and its change is not spent until it confirms.

## Web app

Any other `GET` serves a file from `web/dist` (built by `npm run web:build`) or falls back to `index.html` for client-side routes. `/t/:ticker` gets escaped OG/Twitter meta. HTML responses carry the security headers of `docs/design/visual.md` §11; the CSP is enforced on mainnet and sent Report-Only on signet unless `MURKLE_CSP_ENFORCE` (`1` or `0`) says otherwise. A `web/dist` built for another network (its `murkle-build.json` names the network; a build without one counts as signet) is not served: every such request answers a plain 503 that names the mismatch. `GET /ceremony` and `/ceremony/` serve `web/dist/ceremony.html` when it is built (404 otherwise); `/ceremony/api/*`, `/ceremony/files/*` and `/ceremony/transcript.json` belong to the separate ceremony coordinator and answer 404 here (the reverse proxy routes them).

# Relay balance: interfaces and invariants (as built)

Status: as built, 2026-10-03. This is the interface specification behind `relay-balance.md`: request formats, the books, the relayer's rules, and the wallet and CLI behaviour. Where this file and `relay-balance.md` differ, this file wins. Where the code differs from §1 to §6, §9 records what ships.

Scope: a prepaid **relay balance**. The user tops up a per-account balance with a plain BTC payment; the relayer carries that user's private transfers and charges the exact carrier fee plus a margin to that balance. **No consensus change, no circuit change**: the indexer rules, `src/pins.json` and the circuit artifacts are untouched. Nothing is broadcast by any test (FakeEsplora, temporary state, port 0).

## 0. Rules R1 to R6 and fixed numbers

| # | Rule | Where it is enforced |
|---|---|---|
| R1 | The operator never pays any part of a user's transaction. No free mode, no daily subsidy, no "fund the relayer" command. | I-PAY (§3): `RelayBooks` (§2), `Relayer.signPoolTx` (§4.6), tests in every area (§8) |
| R2 | No forced random or scheduled waits. Only one deposit confirmation, and the Hourly / 10-hour batch when the user picks it. Fast goes out at once (the 10 to 40 s random delay is removed). | §4.7 |
| R3 | Self-pay (built-in key or Unisat) and "Copy envelope" stay available and stay the default. The relay balance is an option the user turns on by topping up. With no balance the Send form looks as after stage 0 plus one quiet "Top up a relay balance" entry. | §5.4 |
| R4 | The retired key `data/signet/relayer.key` is never loaded as pool money. The paid relayer generates new keys in a new directory and refuses to start if any new key equals the old one. The v1 `relayer.json` stays read-only, for status of old ids. | §4.1 |
| R5 | Margin 10% with a 50-sat floor per carrier; deposit confirmations 1 on signet, 3 on mainnet; minimum deposit 2,000 sats; batch reservation 2x at submit, exact fee at release, a short item becomes `missed`; above the fee cap Fast and Next block are refused with `fee_high` (self-pay offered); the relayer never bumps; the top-up screen suggests about 10 sends; a fresh deposit address per top-up, older ones still credited. | §2, §4, §5 |
| R6 | The paid relayer starts only when `MURKLE_RELAYER=1` **and** `MURKLE_RELAY_MODE=balance` **and** the balance configuration is valid **and** the key checks pass. Otherwise stage-0 behaviour stays (retired endpoints answer). | §4.1 |

Fixed numbers (signet defaults; all integers are satoshis unless named otherwise):

| Name | Value |
|---|---|
| Margin per carrier | `max(50, ceil(fee × 10 / 100))` |
| `sweepCost` of a deposit | `ceil(57.5 × maxFeeRate)` = 288 at the 5 sat/vB cap |
| Credited amount | `value − sweepCost`; `sweepCost` goes to the margin account |
| Minimum deposit | 2,000 (below: refused `deposit_small`, never credited, never returned) |
| Deposit confirmations | signet 1, testnet 1, mainnet 3 (configurable upward only) |
| Batch headroom | 2 (reserve `2 × quote` at submit) |
| Fee cap | `MAX_FEE_RATE` 5 sat/vB and `MAX_FEE_PER_TX` 3,000 |
| Suggested top-up | `max(minDeposit, ceil((10 × perSend + sweepCost) / 1000) × 1000)` |
| Request clock skew | 600 s |
| Invalid-proof penalty | 50 sats to the margin account, at most 10 invalid proofs per account per hour |

Words: user-facing copy says "relay balance", "top up", "available balance", never "tickets", "free", "sponsored", "anonymous", "untraceable", "mixer", "trustless". The regex `/\brelay\w*[^.\n]{0,24}\bfree\b/i` in `test/english.test.mjs` forbids "free" within 24 characters after any "relay…" word: write "available balance", not "free balance".

## 1. `src/relay-account.mjs` (new, LF)

Pure, browser-safe (no `node:*` imports): `@noble/curves/secp256k1`, `@noble/hashes/sha256`, `@noble/hashes/hkdf`, `@scure/btc-signer`, `./params.mjs`, `./bytes.mjs`. Used by the server, the web wallet and the CLI.

```js
export const RELAY_SIGN_TAG = "murkle/relay/v1";                 // = label("relay/v1")
export const DEPOSIT_TAG = "murkle/relay-deposit/v1";            // = label("relay-deposit/v1")
export const accountLabel = (network) => `murkle/relay-account/v1/${network}`;
export const RELAY_NETWORKS = Object.freeze(["signet", "testnet", "mainnet"]);
export const DEPOSIT_CONFIRMATIONS = Object.freeze({ signet: 1, testnet: 1, mainnet: 3 });
export const MAX_DEPOSIT_INDEX = 2 ** 31 - 1;
export const MAX_SKEW_SEC = 600;
export const RELAY_ENDPOINTS = Object.freeze({ account: "/api/relay/account", submit: "/api/relay/submit" });
export const RELAY_MODES = Object.freeze(["fast", "block", "batch", "batch10"]);
export const REQUEST_FIELDS = Object.freeze({ "/api/relay/account": ["accountPub", "sig", "t"], "/api/relay/submit": ["accountPub", "envelope", "mode", "sig", "t"] }); // exact key sets, by endpoint path
export const OPTIONAL_REQUEST_FIELDS = Object.freeze({ "/api/relay/account": {}, "/api/relay/submit": { linkable: "boolean" } }); // signed fields a body may add (L1)

export class RelayAccountError extends Error { /* .code: "malformed" | "bad_outpoint" | "bad_signature" | "stale_request" | "bad_network" */ }

export function btcNetwork(network)            // signet|testnet -> btc.TEST_NETWORK (tb1…), mainnet -> btc.NETWORK; else RelayAccountError("bad_network")
export function relayAccount(seed, network = NETWORK)
  // seed: the wallet's 32-byte seed (web: BIP-39 entropy of the 24 words; CLI: wallet file `seed`).
  // secret = hkdf(sha256, seed, undefined, accountLabel(network), 32); throws if not a valid secp256k1 secret.
  // -> { network, secret: Uint8Array(32), pub: Uint8Array(32) /* BIP340 x-only */, pubHex, id: Uint8Array(32), idHex }
export function accountIdOf(pub)               // sha256(pub) for a 32-byte x-only key -> Uint8Array(32)
export function parseAccountPub(text)          // 64 lowercase hex, a valid x-only point -> Uint8Array(32); else RelayAccountError("malformed")
export function parsePoolKey(keyOrHex)         // Uint8Array(32) or 64 lowercase hex, a valid x-only point -> Uint8Array(32)
export function depositTweak(poolKey, id, n)   // bigint t = int(taggedHash(DEPOSIT_TAG, Q ‖ id ‖ u32be(n))) mod N; throws if t === 0n
export function depositKey(poolKey, id, n)     // x-only bytes of lift_x(Q) + t·G -> Uint8Array(32)
export function depositAddress(poolKey, id, n, network = NETWORK)
  // -> { n, key, address, script } with btc.p2tr(key, undefined, btcNetwork(network)): a plain key-path P2TR
  //    whose internal key is depositKey (the usual BIP341 tweak with no script tree is applied on top).
export function depositSecret(poolSecret, id, n)
  // Server side: d = (q' + t) mod N where q' = q if lift_x(Q) is schnorr.getPublicKey(q) with even y, else N − q.
  // schnorr.getPublicKey(depositSecret(...)) equals depositKey(Q, id, n) (x-only). -> Uint8Array(32)
export function parseOutpoint(text)
  // Strict: /^[0-9a-f]{64}:(0|[1-9][0-9]{0,9})$/ and vout <= 4294967295. -> { txid, vout, key: `${txid}:${vout}` }
  // Anything else (uppercase, leading zeros, spaces, signs, "+1", "1e2", missing part): RelayAccountError("bad_outpoint").
export function canonicalBody(fields)
  // JSON.stringify of a new object with the keys sorted (default sort), no whitespace. Values must be strings,
  // booleans (JSON true / false) or safe integers >= 0; a key "sig", a nested object, a float, a negative or a
  // non-plain object throws "malformed". Bodies without a boolean give the same bytes as before.
export function requestDigest({ endpoint, network, poolKey, fields })
  // taggedHash(RELAY_SIGN_TAG, lp(endpoint) ‖ lp(network) ‖ Q ‖ sha256(utf8(canonicalBody(fields))))
  // lp(s) = u8(byteLength) ‖ utf8(s). `fields` includes accountPub and t, never sig.
export function signRequest({ account, endpoint, network, poolKey, fields = {}, now = Date.now })
  // -> { ...fields, accountPub: account.pubHex, t: Math.floor(now() / 1000), sig: 128 lowercase hex (BIP340) }
export function verifyRequest({ endpoint, network, poolKey, body, now = Date.now, maxSkewSec = MAX_SKEW_SEC })
  // body: the parsed JSON object. Checks the key set (REQUEST_FIELDS, plus any OPTIONAL_REQUEST_FIELDS of the
  // right type), accountPub (parseAccountPub), t (safe integer), sig (/^[0-9a-f]{128}$/),
  // |now()/1000 − t| <= maxSkewSec, then schnorr.verify over requestDigest of every field except sig.
  // -> { ok: true, pub, id, idHex, fields } | { ok: false, code: "malformed" | "stale_request" | "bad_signature" }
```

Rules:
- `Q` is always the 32-byte x-only pool key published in relay info (`balance.poolKey`); `id` is the 32-byte account id; `n` is an integer `0..MAX_DEPOSIT_INDEX` (else `RelayAccountError("malformed")`). `u32be(n)` is 4 big-endian bytes.
- `taggedHash` is BIP340's (`schnorr.utils.taggedHash`).
- `network` strings are exactly `"signet" | "testnet" | "mainnet"`; `NETWORK` from `src/params.mjs` is `"signet"`. Signet and mainnet accounts differ because the label differs.
- Signed request bodies (exact key sets; an extra or missing key is `malformed`):
  - account read: `{ accountPub, t, sig }`, endpoint `/api/relay/account`.
  - submit: `{ envelope, mode, accountPub, t, sig }`, endpoint `/api/relay/submit`; `envelope` is the 942-char lowercase hex TRANSACT, `mode` one of `"fast" | "block" | "batch" | "batch10"` (required). Optionally the signed boolean `linkable` (L1, relay-balance.md "Pool cover"): the sender accepts that a thin pool ties the carrier's input to its top-up; any other type is `malformed`. The signature therefore binds endpoint, network, `Q`, envelope, mode and that consent.
- Credit is not signed: `{ outpoint, accountPub, n }`. It can only credit a deposit to the account it pays.
- Replay: every signed request must have `t` within 600 s of the relayer's clock. Submit also keeps an in-memory set of `sha256(sig)` for 1,200 s; a repeat is 409 `replayed`. The set expires in insertion order (which is expiry order), stopping at the first live entry, and holds at most 100,000 entries; a full set answers 503 `busy`. Nullifier dedup stops the same envelope twice while it is pending. The account read has no replay set (it changes nothing).

## 1b. `src/btc/funding.mjs` (LF)

`planCarrierTx` gains options. Since the L5 fix (privacy-trace-test.md) every input carries nSequence `0xfffffffd` (`RBF_SEQUENCE`; any other `sequence` throws), the fee is `feeFor(rate, vsize)` = a whole sat/vB rate times the vsize rounded up, and with order `"largest"` the chosen inputs are shuffled (a `firstInput` stays first) and the change takes a random position (after an OP_RETURN at output 0). `random(n)` replaces the CSPRNG in tests; `random: (n) => n - 1` gives the stage-0 layout, which then differs from stage-0 only in nSequence. `planPayment` also returns `paymentIndex`, the payment's output index.

```js
export function planCarrierTx({ account, utxos, envelope, outputs = [], feeRate, firstInput, sequence,
                                changeScript /* new */, order = "largest" /* new: "largest" | "given" */ })
  // Each utxo may carry `script` (Uint8Array, must be P2TR, else throws) and `tapInternalKey` (Uint8Array(32)),
  // used for that input's witnessUtxo and tapInternalKey; defaults: account.script and account.pub.
  // Change goes to `changeScript` (default account.script); baseVb counts outputVbytes(changeScript).
  // order "given": spend utxos in the given order (no sort); "largest" is today's largest-first.
  // -> { tx, fee, change /* bigint, 0n when no change output */, changeIndex /* number | null */,
  //      inputs /* [{ txid, vout, value, script, tapInternalKey }] in input order */ }
export function signInputs(tx, secrets)          // secrets[i] signs input i (tx.signIdx), then finalize -> { hex, txid, vsize }
export function feeOf(tx)                       // Σ witnessUtxo.amount − Σ output amounts, as a Number; throws if an input lacks witnessUtxo
export function planPayment({ account, utxos, to, amount, feeRate, sequence })
  // A plain payment (no OP_RETURN): `to` is an output script, amount >= dustLimit(to) else throws;
  // largest-first, change to account.script when >= 330. -> { tx, fee, change }
  // Same "not enough BTC at <address>: have X sats, need Y" error as planCarrierTx.
```

## 2. `server/relay-books.mjs` (new, LF)

Pure bookkeeping, no network, no keys, synchronous. All amounts are safe-integer satoshis. Imports only `node:fs`, `node:path` (for its own durable save) and `../src/relay-account.mjs` (for `parseOutpoint`). It does **not** import `server/relayer.mjs` (no cycle); it carries its own copy of the tmp, fsync, rename write.

```js
export const BOOKS_VERSION = 1;
export class BooksError extends Error { /* .code, .extra */ }
// codes: "balance_low" { balance, needed } | "already_credited" | "bad_key" | "unknown_ref" | "margin_low" { margin, needed } | "invalid"

export function marginFor(fee, { marginPct = 10, marginMinSats = 50 } = {})   // Math.max(marginMinSats, Math.ceil(fee * marginPct / 100))
export function costFor(fee, opts)                                          // fee + marginFor(fee, opts)
export function sweepCostFor(maxFeeRate)                                    // Math.ceil(57.5 * maxFeeRate)

export class RelayBooks {
  constructor({ network, poolKey, changeKey, marginPct = 10, marginMinSats = 50 })  // keys: 64-hex x-only strings
  static restore(json, { network, poolKey, changeKey, marginPct, marginMinSats })   // throws on version, network or key mismatch
  toJSON()                                       // the persisted shape below; never includes an item's txid
  account(id)                                    // { balance, reserved, nextIndex } (zeros for an unknown id; never creates one)
  credits(id, { limit = 50 } = {})               // this account's credits, newest first: [{ outpoint, n, value, amount, height }]
  isCredited(key)                                // the credit record, or null
  claim(key)                                     // false if credited or already claimed, else true (in memory, not persisted)
  unclaim(key)
  credit({ key, id, n, value, sweepCost, height })
    // key must equal parseOutpoint(key).key ("bad_key"); already credited -> "already_credited" (callers check isCredited first
    // for the idempotent answer); value − sweepCost must be > 0 ("invalid"). balance += value − sweepCost; margin += sweepCost;
    // totals.credited += value; account.nextIndex = max(nextIndex, n + 1). -> credit record
  reverseCredit(key)
    // A credited deposit vanished in a reorg: totals.credited −= value; margin −= sweepCost; balance −= amount; any negative
    // balance is set to 0 and the deficit taken from margin. Marks the credit { reversed: true } (kept, so it is never
    // credited again by the same key). -> credit record
  reserve(ref, id, amount)                       // balance −= amount, reserved += amount, reservations[ref] = { id, amount }; "balance_low" if balance < amount
  release(ref)                                   // returns the reservation to the balance (missed, expired, dropped before signing)
  settle(ref, { fee })
    // Exact charge before a signature: cost = costFor(fee). Taken from reservations[ref] first, then the available balance;
    // the rest of the reservation goes back. "balance_low" (and nothing changes) if reservation + balance < cost.
    // margin += cost − fee; totals.fees += fee; charges[ref] = { id, cost, fee }; deletes reservations[ref]. -> { cost, fee, margin }
  confirmCharge(ref)                             // the carrier reached the network: delete charges[ref] (the account link is gone)
  refundCharge(ref)                              // never broadcast: undo settle exactly (balance += cost; margin −= cost − fee; fees −= fee)
  payHousekeeping(fee)                           // fan-out / merge: margin −= fee; totals.fees += fee; "margin_low" if availableMargin() < fee
  penalize(id, sats)                             // moves min(balance, sats) from the account to margin
  reclaim(sats)                                  // a charged carrier never reached the chain after its charge was confirmed: fees −= sats; margin += sats
  refundHousekeeping(fee)                        // undo payHousekeeping for a housekeeping tx never signed or never sent: margin += fee; fees −= fee
  availableMargin()                              // margin − Σ (cost − fee) of charges not yet confirmed; payHousekeeping spends only this
  liabilities()                                  // Σ balance + Σ reserved + margin
  checkI2({ poolUnspent })
    // -> { ok, problems: [string], credited, fees, balances, reserved, margin, liabilities, poolUnspent }
    // ok iff: credited === Σ value over distinct non-reversed credits; credited − fees − balances − reserved === margin;
    // margin >= 0; every balance and reservation >= 0; poolUnspent >= liabilities.
}
export function saveBooks(path, books)           // durable write of JSON.stringify(books.toJSON())
export function loadBooks(path, keys)            // RelayBooks.restore(JSON.parse(file), keys); a missing file -> new RelayBooks(keys)
```

Persisted shape (`toJSON()`), version 1:

```json
{ "version": 1, "network": "signet", "poolKey": "<64 hex>", "changeKey": "<64 hex>",
  "accounts": { "<id 64 hex>": { "balance": 4741, "reserved": 1314, "nextIndex": 1 } },
  "credits": { "<txid>:<vout>": { "id": "<64 hex>", "n": 0, "value": 7000, "sweepCost": 288, "amount": 6712, "height": 324700 } },
  "reservations": { "<item id 32 hex>": { "id": "<64 hex>", "amount": 1314 } },
  "charges": { "<item id>": { "id": "<64 hex>", "cost": 657, "fee": 597 } },
  "margin": 348, "totals": { "credited": 7000, "fees": 597 } }
```

- The example is one account after a 7,000-sat deposit (6,712 credited, 288 sweep cost to the margin), one carrier charged 657 (fee 597, margin 60) and one batch send reserving 2 × 657: 6,712 − 657 − 1,314 = 4,741 available; margin 288 + 60 = 348; 7,000 − 597 − 4,741 − 1,314 = 348 (I2).
- `reservations` and `charges` are the only places an item id sits next to an account id, and only until the reservation is released or the charge is confirmed (broadcast) or refunded. Nothing in the books ever holds a txid.
- The relayer persists the books inside its own state file (§4.3) so that a credit, its coin and the claim release are one durable write. `saveBooks` / `loadBooks` exist for the shared tests and tools.

## 3. I-PAY: the invariant and the exact functions that enforce it

I-PAY: every satoshi the relayer spends as a miner fee is covered by user money that was deposited, confirmed and credited to the account that caused the spend (or to the margin account, which only margins and sweep costs fill), before the signature is released.

- **I0 provenance**: `Relayer.assertProvenance(inputs)` (server). Every input outpoint must be in the relayer's coin set (§4.3) with `status: "unspent"`, and be either a `deposit` coin whose credit exists and is not reversed, or a `change` coin whose `parent` txid is in the relayer's journal (ledger or items). Anything else throws `I0` and nothing is signed. The relayer never lists an address (`esplora.utxos` is never called by the paid relayer); coins anyone else sends to its keys are invisible.
- **I1 coverage**: `Relayer.signPoolTx({ tx, inputs, ref })` (server) is the **only** function in `server/relayer.mjs` that calls `signInputs`, `tx.sign`, `tx.signIdx` or `signLocal` (a test greps for this). In order:
  1. `assertOutputs(tx, kind)`: a carrier has output 0 = OP_RETURN with exactly the item's envelope, and every other output pays `C` (the change key's P2TR script); a housekeeping tx has no OP_RETURN and every output pays `C`. `C` must not equal `Q` or any credited deposit script.
  2. `assertProvenance(inputs)` (I0).
  3. `fee = feeOf(tx)` from the final transaction's amounts; refuse if `fee <= 0` or `fee > maxFeePerTx`.
  4. Carrier: `books.settle(ref, { fee })` (throws `balance_low`: the item becomes `missed`, nothing signed). Housekeeping (`ref === null`): `books.payHousekeeping(fee)` (throws `margin_low`: skipped).
  5. Pool check in memory: `poolUnspentAfter = poolUnspent − Σ inputs + Σ outputs to C`; refuse unless `poolUnspentAfter >= books.liabilities()`. On refusal: undo step 4 (`refundCharge` / reverse housekeeping), set `halted`, sign nothing.
  6. Sign input `i` with `depositSecret(poolSecret, id, n)` (deposit coin) or the change secret (change coin), via `signInputs`.
  7. Mark inputs `spent` with `spentBy: txid`, add the change coin(s), journal the raw tx, and `save()` (one durable write) **before** broadcasting.
- **I2 books**: `Relayer.checkBooks()` calls `books.checkI2({ poolUnspent })` with `poolUnspent` = Σ value of coins with `status` `unspent` or `reserved`. It runs after every `onTick` that saw a new block, after every credit, and at startup. A failure sets `this.state.halted = { height, problems }`: `gateCode` then answers `halted` (503) for submit, account and credit; no new pool transaction is signed. Journaled carriers already signed are still re-sent (they are paid). A later tick that finds I2 holding clears `halted`. Self-pay and copy keep working (they never touch the relayer).

There is no function, endpoint, CLI command or config value that adds coins to the pool other than `credit` (R1). No code path builds a transaction spending an input of a transaction the relayer already broadcast (no RBF, no CPFP bump, R5). Chaining a new carrier on an earlier carrier's unconfirmed change is allowed (it pays only its own fee at its own build rate).

## 4. `server/relayer.mjs`, `server/indexer-server.mjs`, `server/retired-relay.mjs` (all LF)

### 4.1 Startup, enablement, config, keys

`relayerStartup(read = env)` → `{ start, requested, config, problems: [string], message }`:
- `MURKLE_RELAYER` unset or `0`: `start: false, requested: false`, message `Relayer off. Wallets pay the fee themselves or copy the envelope.`
- `MURKLE_RELAYER=1` without `MURKLE_RELAY_MODE=balance` (unset or any other value): `start: false, requested: true`, message starting `refusing to start the relayer: MURKLE_RELAYER=1 needs MURKLE_RELAY_MODE=balance and a valid relay balance configuration (docs/design/relay-balance.md). There is no free mode.` and ending `The indexer keeps running.`
- Both set but a value is invalid: same prefix, then the problems joined with `; `, then `The indexer keeps running.`
- Valid: `start: true`, message `Relayer on: relay balances (docs/design/relay-balance.md). Users prepay; the operator never pays a user's fee.`

Config (`DEFAULTS` key / env `MURKLE_<NAME>` / default). New keys:

| Key | Env | Default | Valid |
|---|---|---|---|
| `relayMode` | `RELAY_MODE` | `null` | must be `"balance"` to start |
| `relayDir` | `RELAY_DIR` | `data/signet/relay-balance` | any path; resolved against the repo root |
| `marginPct` | `RELAY_MARGIN_PCT` | 10 | integer 0..100 |
| `marginMinSats` | `RELAY_MARGIN_MIN_SATS` | 50 | integer >= 1 |
| `minDepositSats` | `RELAY_MIN_DEPOSIT_SATS` | 2000 | integer > `sweepCostFor(maxFeeRate)` + 330 |
| `depositConfirmations` | `RELAY_DEPOSIT_CONFS` | `null` (= `DEPOSIT_CONFIRMATIONS[NETWORK]`) | integer >= the network default |
| `batchHeadroom` | `RELAY_BATCH_HEADROOM` | 2 | integer 1..10 |
| `suggestSends` | `RELAY_SUGGEST_SENDS` | 10 | integer 1..100 |
| `invalidProofSats` | `RELAY_INVALID_PROOF_SATS` | 50 | integer >= 0 |
| `invalidPerHour` | `RELAY_INVALID_PER_HOUR` | 10 | integer >= 1 |
| `accountPerHour` | `RELAY_ACCOUNT_PER_HOUR` | 120 | integer >= 1 (account and credit calls per IP prefix per hour) |
| `creditLookupsPerMinute` | `RELAY_CREDIT_LOOKUPS_PER_MIN` | 30 | integer 1..600 (explorer lookups by credit calls per minute, all IPs together) |

Kept as today: `maxFeeRate` (5), `maxFeePerTx` (3000), `maxRelaysPerBlock`, `maxQueue`, `safetyBlocks`, `batch10SafetyBlocks`, `maxBatchPerEpoch`, `maxBatch10PerEpoch`, `batchPerIp`, `maxIndexerLag`, `verifyConcurrency`, `verifyMaxPerSec`, `fanoutTarget`, `fanoutValue`, `fanoutMinConfirmed`, `fanoutMinCarriers`, `trustProxy`, `bodyLimit`, `bodyTimeoutMs`, `estVsize`. `keyPath` (`RELAY_KEY_PATH`, default `data/signet/relayer.key`) and `statePath` (`RELAY_STATE_PATH`, default `data/signet/relayer.json`) keep naming the **old v1** files: read-only, the key only to refuse equality, the state only for v1 status. Removed from `DEFAULTS` and never read: `dailyBudgetSats`, `powBaseBits`, `powMaxExtra`, `powBudgetExtra`, `acceptPerHour`, `acceptPerDay`, `rejectPerHour`, `hotFloorSats`; `RETIRED_ENV` = the stage-0 seven plus `HOT_FLOOR_SATS`.

`startPaidRelayer({ idx, esplora, config, root, lock, log })` (exported from `relayer.mjs`; `indexer-server.mjs` imports this, never the `Relayer` class) → a started `Relayer`, or throws with a one-line reason:
1. Paths: `dir = resolve(root, config.relayDir)`; files `dir/pool.key`, `dir/change.key`, `dir/relayer.json`. Refuse if any of them resolves to the old `keyPath` or `statePath`, or if `dir` is the old key's directory **and** a file there is named `relayer.key` or `relayer.json`.
2. Keys: `loadOrCreateKey(path)` for each (64 lowercase hex, created with `randomBytes(32)`, mode 0600, flag `wx`). Refuse if pool secret equals change secret, or either secret or x-only public key equals the old key's (read with `readRelayerKey` when the old file exists; a missing old file is fine).
3. State: `relayer.json` version 2 (§4.3). Refuse a version-1 file at the new path, and refuse if its `keys.pool` / `keys.change` differ from the key files.
4. `new Relayer({ idx, esplora, poolKey, changeKey, config: { ...config, statePath: dir/relayer.json }, lock, log })`, then `await relayer.recover()` and one `checkBooks()`.

`main()` in `indexer-server.mjs`: `relayerStartup()`; if `start`, `try { relayer = await startPaidRelayer(...) } catch (e) { console.error(`refusing to start the relayer: ${e.message} The indexer keeps running.`) }`; `createApp({ relayer, v1StatePath, ... })` as today. The `Relayer` constructor itself never reads `keyPath`, never calls `loadOrCreateKey`, and throws without `poolKey` and `changeKey`.

### 4.2 Endpoints

All bodies are read with today's `readBody` limits; malformed JSON is 400 `malformed`. With no relayer (stage-0 behaviour), `POST /api/relay/submit`, `/account` and `/credit` answer 503 `disabled` with `SUBMIT_MESSAGE`. OPTIONS allows `GET, POST`. The server and the relayer **never log a request body** or any field of it (envelope, accountPub, sig, outpoint, n); a failure is logged by code only.

`GET /api/relay/info` (balance mode):
```json
{ "enabled": true, "mode": "balance", "code": null, "reason": null, "network": "signet", "ops": ["TRANSACT"],
  "address": "<C's tb1p address>", "height": 324700, "chainTip": 324700, "pow": null, "selfPay": true,
  "anchor": { "window": 100, "safety": 24, "minAnchor": 324624 },
  "fees": { "feeRate": 1, "maxFeeRate": 5, "estVsize": 597, "carrierFeeSats": 597, "maxFeePerTx": 3000 },
  "balance": { "poolKey": "<64 hex>", "changeAddress": "<tb1p…>", "signTag": "murkle/relay/v1",
               "marginPct": 10, "marginMinSats": 50, "perSendSats": 657, "batchHeadroom": 2,
               "minDepositSats": 2000, "depositConfirmations": 1, "sweepCostSats": 288,
               "suggestSends": 10, "suggestedTopUpSats": 7000 },
  "queue": { "queued": 0, "max": 120 },
  "stats": { "relayed144": 0, "landed144": [[324698, 2]], "accepted": 0, "rejected": 0, "expired": 0, "missed": 0, "satsSpent": 0 },
  "defaultMode": "block", "batch": { "perIp": 3, "modes": { }, "recent": [ ] },
  "docs": "docs/design/relay-balance.md" }
```
- `code` is the first failing gate for a Next-block submit (`null` when open): `halted`, `indexer_behind`, `busy` (fee rate unknown or first tick not done), `fee_high`, `block_full`, `queue_full`; `reason` its message. `carrierFeeSats` and `perSendSats` are `null` while the fee rate is unknown. `landed144` is `[height, count]` of accepted carriers in the last 144 blocks, ascending. `batch` is today's shape (batch-contract §3.8).
- No relayer: `relayInfoOff()` = `{ enabled: false, mode: null, code: "disabled", reason: "no relayer runs on this server", network, ops: [], address: null, pow: null, selfPay: true, balance: null, batch: null, docs: "docs/design/relay-balance.md" }` (the `tickets` key is gone).
- `/api/state` `relay` = `{ enabled, mode: relayer ? "balance" : null, queued, defaultMode: "block", batch }`.

`POST /api/relay/account` body `{ accountPub, t, sig }` (signed, §1) → 200:
```json
{ "accountId": "<64 hex>", "balance": 6055, "reserved": 0, "nextIndex": 1,
  "depositAddress": "<address for nextIndex>", "credits": [ { "outpoint": "<txid>:0", "n": 0, "value": 7000, "amount": 6712, "height": 324700 } ] }
```
An account never credited answers zeros, `nextIndex` 0 and `credits: []` (not 404).

`POST /api/relay/credit` body `{ outpoint, accountPub, n }` (not signed). In this order, the first failure answers:
1. Strict parse (`parseOutpoint`, `parseAccountPub`, `n` a JSON integer `0..MAX_DEPOSIT_INDEX`, no other keys): 400 `bad_outpoint` for the outpoint, else 400 `malformed`.
2. Gate: `disabled`, `halted` (503); per-IP `accountPerHour` (429 `rate_limited`).
3. `books.isCredited(key)`: same account id and `n` → 200 with `already: true`; otherwise 409 `already_credited`.
4. `books.claim(key)` synchronously, before any `await`; false → 409 `credit_in_progress` `{ retryAfter: 5 }`. Everything below runs in `try { … } finally { books.unclaim(key) }`.
5. The txid is one of the relayer's own transactions (ledger, items or a `change` coin's parent): 422 `deposit_own`.
6. `esplora.rawTx(txid)` (bytes checked against the txid); explorer 404 or `vout` out of range → 404 `deposit_unknown`; any other explorer error → 503 `busy`. A txid the explorer answered 404 for in this block, within the last minute, answers `deposit_unknown` from memory. Every explorer lookup of a credit (this one and step 9) takes a token from one bucket of `creditLookupsPerMinute` for all IPs together; none left → 503 `busy` `{ retryAfter }` ("The relayer is looking up many deposits right now. Try again in a minute."), so unsigned credits with made-up txids cannot use up the explorer quota the indexer syncs with.
7. Output script ≠ `depositAddress(Q, sha256(accountPub), n).script` → 422 `deposit_mismatch`.
8. Value < `minDepositSats` → 422 `deposit_small` `{ minDepositSats }` (nothing recorded; a repeat answers the same).
9. `esplora.txStatus(txid)`; confirmations = `max(idx.height, chainTip) − block_height + 1` when confirmed, else 0; needed = `depositConfirmations` (100 for a coinbase tx). Short → 409 `deposit_unconfirmed` `{ confirmations, needed }`.
10. `books.credit(...)`, add the `deposit` coin, `save()`: one durable write. Then 200 `{ credited: true, already: false, outpoint, n, value, sweepCost, amount, height }`. The response never contains a balance.

`POST /api/relay/submit` body `{ envelope, mode, accountPub, t, sig }`. Order (first failure answers; nothing mutates before step 9):
0. `parseSubmit`: exact key set, envelope hex, mode one of the four (missing or `"batch12"`: 400 `malformed`).
1. `gateCode(mode)`: `disabled`, `halted`, `indexer_behind`, `busy` (fee rate unknown), `fee_high` (`feeRate > maxFeeRate` or the exact carrier fee `> maxFeePerTx`; **all four modes**), non-batch: `block_full`, `queue_full`; batch: `batch_disabled`.
2. `verifyRequest` (endpoint `/api/relay/submit`): 401 `bad_signature` / `stale_request`; then the replay set: 409 `replayed`.
3. Balance before any proof work: `quote = costFor(carrierFee(feeRate))`, `need = quote × (batch ? batchHeadroom : 1)`; `account(id).balance < need` → 402 `balance_low` `{ balance, needed: need, perSend: quote }`.
4. Rate limits: per IP prefix (today's batch per-IP bucket), per account `invalidPerHour` (429 `rate_limited`).
5. Strict decode, `not_transact`, `public_value`; nullifier dedup and in-memory claim (as today).
6. Freshness; batch step 6b (as today, but the coin check is `pool_low`, §4.5).
7. Proof check. `proof_invalid` also calls `books.penalize(id, invalidProofSats)` and counts toward `invalidPerHour`.
8. Re-checks after the await (as today), then `books.reserve(itemId, id, need)` (may still throw `balance_low`: a parallel submit took the balance).
9. Accept: item with `account: idHex` and `reservation: need`; `save()`; reply 202 (today's body plus `reservedSats: need` and `balance` after the reservation). Fast: `flush({ only: [id] })` runs under the lock right away (`fastDelayMs` default `() => 0`).

`GET /api/relay/status/:id`: today's fields, plus `status: "missed"` with `code` (`"balance_low"` or `"fee_high"`) and `reason`; `broadcastHeight` once broadcast; `cost` (sats charged) once broadcast. Unknown ids fall back to `v1Status` (unchanged).

`GET /api/relay/ledger`: today's shape, `address` = `C`'s address; kinds `carrier`, `fanout`, `merge`; no account, no relay id, no cost per row.

### 4.3 State, coins, items, ledger

`dir/relayer.json`, `STATE_VERSION = 2`:
```json
{ "version": 2, "network": "signet", "keys": { "pool": "<Q 64 hex>", "change": "<C x-only 64 hex>" },
  "books": { "...": "RelayBooks.toJSON()" },
  "coins": { "<txid>:<vout>": { "value": 7000, "kind": "deposit", "status": "unspent", "confirmed": true } ,
             "<txid>:1": { "value": 5000, "kind": "change", "parent": "<txid>", "status": "unspent", "confirmed": false, "depth": 1, "root": null } },
  "items": { }, "ledger": [ ], "lastReconciled": 0, "lastReconciledHash": null, "lastFlushHeight": 0, "halted": null }
```
- Coin `status`: `unspent` → `reserved` (picked for a tx being built) → `spent` (`spentBy: txid`, kept until that tx has 6 confirmations, then deleted). A deposit coin's signing data (`id`, `n`) comes from `books.credits[key]`; it is not copied into the coin. Confirmation of a change coin comes from `txStatus` of its parent (one call per own unconfirmed tx per tick), never from an address listing. The fields `day`, `spentToday`, `reserved`, `reservedOutpoints`, `badOutpoints`, `changeDepth`, `changeRoot` of v1 are gone (depth and root live on the coin).
- Item while waiting: `{ id, status, nullifiers, anchor, root, mode, acceptedHeight, envelope, account, reservation, attempts, releaseAt?, lastRelease? }`. At signing (`signPoolTx` step 4) the reservation becomes a charge; `account` stays until the carrier reaches the network. At `markBroadcast`: `books.confirmCharge(id)`, `delete item.account`, `item.cost = cost`. At `missed`, `expired` or `dropped` before signing: `books.release(id)`, `delete item.account`. A carrier dropped after signing but before any broadcast succeeded: `books.refundCharge(id)`, `delete item.account`. So **no saved file ever holds an account id next to a carrier txid**.
- Ledger entry: `{ seq, kind, txid, vsize, fee, feeRate, broadcastHeight, height, outcome, reason, epoch? }`, never an account. `epoch` stays internal (ledgerView never outputs it).
- A carrier whose charge was confirmed but which never reaches a block and is finally `dropped` with its inputs unspent: inputs return to `unspent`, and `books.reclaim(fee)` moves its fee to the margin ("once broadcast, the fee is spent" for the user).

### 4.4 Error codes

| Code | HTTP | Message ("what happened. what to do.") | Extra |
|---|---|---|---|
| `malformed` | 400 | The request is not a valid relay request. Update the wallet and try again. | |
| `bad_outpoint` | 400 | That is not a deposit outpoint. It must be a 64-character lowercase txid, a colon and the output number. | |
| `not_transact`, `public_value` | 400 | unchanged | |
| `bad_signature` | 401 | The request signature does not match this account. Update the wallet and try again. | |
| `stale_request` | 401 | The request is too old or from the future. Check this device's clock and try again. | `serverTime` |
| `balance_low` | 402 | Your relay balance does not cover this send. Top up, or pay the fee yourself. | `balance`, `needed`, `perSend` |
| `deposit_unknown` | 404 | The explorer does not know this deposit yet. Wait a minute and try again. | |
| `already_credited` | 409 | This deposit was already credited to another relay account or address number. | |
| `credit_in_progress` | 409 | This deposit is being credited right now. Try again in a few seconds. | `retryAfter` |
| `deposit_unconfirmed` | 409 | The deposit needs more confirmations before it is credited. | `confirmations`, `needed` |
| `replayed` | 409 | This exact request was already received. Send it again from the wallet. | |
| `pool_thin` | 409 | Too few people have topped up the relay pool, so this send's input would tie it to your top-up address. Pay the fee yourself, or confirm to send it linkable. | `k`, `depositors` |
| `duplicate_nullifier`, `nullifier_spent`, `nullifier_pending` | 409 | unchanged | |
| `too_large` | 413 | unchanged | |
| `deposit_mismatch` | 422 | This output does not pay that deposit address of your relay account. | |
| `deposit_small` | 422 | This deposit is below the minimum, so it is not credited. | `minDepositSats` |
| `deposit_own` | 422 | This output belongs to the relayer's own transaction and is never credited. | |
| `anchor_unknown`, `anchor_stale`, `proof_invalid`, `anchor_not_boundary`, `epoch_closed` | 422 | unchanged | unchanged |
| `rate_limited` | 429 | unchanged | `retryAfter` |
| `disabled` | 503 | No relayer runs on this server. Pay the fee yourself, or copy the envelope so anyone can carry it. | |
| `halted` | 503 | The relayer stopped itself because its books do not add up. Pay the fee yourself or copy the envelope; your balance is kept. | |
| `fee_high` | 503 | Bitcoin fees are above the relayer's cap right now, so it does not take sends. Pay the fee yourself or copy the envelope. | `feeRate`, `maxFeeRate` |
| `pool_low` | 503 | The relayer cannot fund more carriers in this block. Try the next block, or pay the fee yourself. | |
| `indexer_behind`, `busy`, `block_full`, `queue_full`, `batch_full`, `batch_disabled` | 503 | unchanged | unchanged |

Removed codes (never returned again): `pow_stale`, `pow_insufficient`, `hot_wallet_low`, `budget_exhausted`, `fee_too_high`. `ERROR_STATUS` and `MESSAGES` hold exactly the table above. No message mentions tickets.

### 4.5 Release, missed items, no bump

`flush({ only })`:
1. Resend journaled `signing` items (unchanged; they are already charged).
2. Candidates: queued non-batch items; queued batch items with `idx.height >= releaseAt`. Prechecks (nullifier spent, root changed, deadline) unchanged.
3. Hold whole (stay queued, retried next block) **only** when the relayer cannot send at all: fee rate unknown, or the pool cannot fund the candidates' carriers in this block (`capacity`). Never because of one account.
4. Fee rate above `maxFeeRate` or exact carrier fee above `maxFeePerTx`: every candidate becomes `missed` with `code: "fee_high"`, `books.release(id)`. (Fast and Next-block submits above the cap never get here: refused at submit.)
5. Shuffle the remaining candidates (crypto RNG) and `carry()` each: build the carrier at the current rate from the coin set (`order: "given"`, one **change coin of `C`** chosen uniformly at random among the confirmed ones that cover the fee, else among our own shallow unconfirmed change), then `signPoolTx`. `balance_low` from `settle` → that item becomes `missed` with `code: "balance_low"` (its reservation released), the others go on. The rest of the epoch goes out in the same flush. An item of an account with a credit whose deposit went back to the mempool (below) is `missed` with `balance_low` when its balance and reservation without that credit do not cover one send.
6. A `missed` item is final: its nullifiers leave the pending set, it is never sent later on its own, and a top-up never releases it.

Capacity (`fundingCoins()`) counts coins from the coin set only, with today's depth and descendant rules: change coins of `C`, plus one virtual merge output (depth 1) built from the smallest mergeable confirmed deposits, as many as `mergeRoom()` allows now (at most `MAX_MERGE_INPUTS`, within `maxFeePerTx` at the current rate, and only as many as `books.availableMargin()` pays the merge fee for). A confirmed deposit therefore counts only through a merge the margin can pay now; when nothing else funds the carrier, submit answers 503 `pool_low` at once instead of a 202 that would later expire (audit V2-16). Fan-out and merges are `kind: "fanout" | "merge"`, built only from coin-set coins, outputs all to `C`, paid through `signPoolTx(..., ref: null)` (margin). There is no bump, RBF replacement or CPFP code path; a test asserts no two transactions the relayer signs share an input.

**No carrier spends a deposit** (relay-balance.md §5, review fix 2026-10-03). `signPoolTx` refuses a carrier with any input that is not a change coin of `C` (`I0`). Deposits reach `C` only through a **merge** (`maybeMerge`, each tick before the fan-out and, for a cold pool, at the start of a flush): credited, confirmed deposit coins in random order, at most 50, no more than `maxFeePerTx` allows at the current rate and no more than the available margin pays for now (`mergeRoom`), into one output to `C`, paid from the margin (each credit put its `sweepCost` there). With margin for only some deposits, the merge takes that many; it never fails `margin_low` with none taken. A deposit is merged at the first tick after the block it was credited in (deposits of one block share a merge), or at once while change coins fund fewer than the waiting carriers plus 10. A Fast item held for want of a coin goes right after the merge in the same tick. The fan-out splits only change coins.

**Broadcast outcomes (I-PAY).** `broadcastRaw` answers `ok` (accepted, or already known: in the mempool, in a block, or Bitcoin Core 28+'s `Transaction outputs already in utxo set`), `spent`, `chain`, `refused: <text>` (the node answered and refused it: a 4xx other than 429, or an RPC error) or the text of an answer that never came (5xx, 429, a dropped connection, a timeout). Only a transaction proven never to have reached the network is refunded: for a journaled carrier, `spent` with an explorer 404, or three `refused` answers with an explorer 404 (dropped, `refundCharge`, coins back); for a fan-out or merge, `spent` or `refused` with an explorer 404 (`dropHousekeeping`). The 404 comes from `statusOf`, which reads GET `/tx/<txid>`: `/tx/<txid>/status` answers 200 `{ confirmed: false }` for a txid the explorer has never seen, never a 404, so it is used only by a client without `tx()` (audit V2-15). A carrier whose earlier broadcast answer was lost (`unknownOutcome`: 5xx, 429, a dropped connection) is never dropped or refunded, even on a later refusal or 404, since its bytes may be in another node's mempool: it stays journaled and charged, is marked broadcast once the explorer knows it or its anchor window has closed, and `reconcile` then accepts or expires it with the charge kept (audit V2-17). A txid the explorer knows is broadcast. Any other answer keeps the carrier journaled and charged (resent with the same bytes each block, no attempt counted) and the fan-out or merge pending with its bytes and its outputs unsent (`reconcileFanouts` decides next tick). `reconcile` also watches journaled carriers: a verdict in the indexer log means it reached the network.

Reorgs: a credit is re-checked each tick with `txStatus` while it is less than 6 blocks deep, counted from the height its deposit is confirmed at now (`coin.height`, updated when it is re-mined elsewhere), and for as long as the deposit is back in the mempool. Back in the mempool (`{ confirmed: false }`): the coin is marked `reorged` and `confirmed: false`, is never spent or merged, and its amount does not count toward the account's balance at submit (`balance_low` when the rest does not cover the send) until the deposit is confirmed again with the confirmations a credit needs. A deposit tx the explorer answers 404 on two consecutive ticks is reversed (`books.reverseCredit`, coin deleted). If that coin was already spent by a journaled tx, set `halted` with problem `spent a reversed deposit`.

### 4.6 `retired-relay.mjs`

`RETIRED_REASON` = "The free relayer was retired. Pay the fee yourself, or copy the envelope." `UNAVAILABLE_REASON` = "no relayer runs on this server". `SUBMIT_MESSAGE` = the `disabled` message of §4.4. `relayInfoOff()` as §4.2. `loadV1State`, `v1Status`, `readRelayerKey`, `readV1File`, `retireFree`, `planSweep` unchanged.

## 5. Web wallet

### 5.1 `web/src/api.js` (LF)

`relay.account(body, { signal })` → POST `/api/relay/account`; `relay.credit(body, { signal })` → POST `/api/relay/credit`. `ApiError` keeps `code`, `status` and the extra fields of the error body.

### 5.2 `web/src/relay.js` (CRLF)

```js
export const RELAY_ROUTE = { open: false, info: null };   // tests may still set .open directly
export function setRelayRoute(info)        // open = info?.enabled === true && info.mode === "balance" && info.network === NETWORK && /^[0-9a-f]{64}$/.test(info.balance?.poolKey ?? "")
export const relayOpen = () => RELAY_ROUTE.open === true;
export const RELAY_OFF = "Relaying is off on this server. Pay the fee yourself, or copy the envelope.";   // replaces RELAY_LATER
export function quoteFor(info, mode = "block") // { perSend, needed } from info.balance.perSendSats × (batch ? batchHeadroom : 1), or null
export function routeState(info, balance, mode = "block")
  // "off" (relayOpen() false or info missing) | "unknown" (balance not loaded) | "fee_high" (info.code === "fee_high")
  // | "none" (balance.balance === 0 and balance.reserved === 0) | "low" (balance.balance < needed) | "ok"
export async function accountBalance({ account, info, client, signal })   // signs { } for /api/relay/account
export async function creditDeposit({ outpoint, accountPub, n, client, signal })
export async function submitEnvelope(envelope, { mode, account, onStep, signal, client })
  // No proof of work. Refreshes info; refuses locally with the relayer's code when relayOpen() is false or routeState is
  // not "ok" for this mode. onStep({ id: "submit", status: "running" | "ok", detail }); signs with signRequest
  // (endpoint "/api/relay/submit", network NETWORK from config.js, never info.network; poolKey info.balance.poolKey).
  // Returns the 202 body.
export function relayFailure(err)           // as today, with FALLBACK texts for every §4.4 code
export function auditRelayer({ address, txs, ledger, batch })
  // `address` is C: carrier = exactly one OP_RETURN with one TRANSACT envelope and every other output paying C (inputs may
  // be any deposit address or C); fanout/merge = no OP_RETURN, all outputs to C; anything else touching C is "other",
  // flagged "Not made by the relayer; it never spends such coins." The "top-up" kind is gone.
```
`grindPow` and the PoW worker are no longer called (the files may stay). `RETRYABLE` gains `fee_high`, `pool_low`, `halted`, `credit_in_progress`, `deposit_unconfirmed`, `stale_request`; `balance_low` is not retryable without a top-up.

### 5.3 `web/src/session.js` (CRLF) and `payers.js`

- Constructor: `this.#relay = relayAccount(entropy, NETWORK)` before `entropy.fill(0)`. Public: `s.relayAccount` → `{ pubHex, idHex }` (never the secret).
- `loadRelayInfo()` also calls `setRelayRoute(info)`, then emits `"relay"`.
- `s.relayBalance` → `null | { balance, reserved, nextIndex, credits, at }`; `s.loadRelayBalance({ signal })` signs the account read, checks that `depositAddress` equals the wallet's own derivation for `nextIndex` (else throws "The relayer's deposit address doesn't match this wallet. Nothing was paid."), stores and emits `"relay-balance"`.
- Network: the wallet fixes it itself. The relay route opens only when `info.network` equals the wallet's own `NETWORK`; account reads, submits and deposit addresses always sign and derive with `NETWORK`, never with the relayer's `info.network`, and a deposit address without the signet bech32 prefix (`tb1`) is refused (audit V2-18).
- Prefs (sealed in the vault): `prefs.relay = { poolKey, depositIndex, pending: [{ n, outpoint, value }] }`. Records are kept per relayer: `prefs.relay` belongs to the relayer whose pool key is `poolKey`, and the records for other relayers wait in `prefs.relayBy[poolKey]`; a record without `poolKey` (written before this rule) belongs to the relayer in use. A deposit made to one relayer is never checked, credited or dropped at another. Switching the indexer clears the relay info, balance, deposits and the cached log (audit V2-20, V2-21). `s.depositIndex` = max(`prefs.relay.depositIndex`, `relayBalance.nextIndex`, highest paid `n` seen + 1). `s.depositAddress(n = s.depositIndex)` → `{ n, address }` (needs relay info).
- `s.checkDeposits({ older = false })` → `[{ n, outpoint, value, confirmations, needed, state: "waiting" | "credited" | "small" | "refused", code? }]`. Looks up address `depositIndex` (and `0..depositIndex − 1` when `older`) with `api.esplora.utxos`; a payment seen at `depositIndex` advances `prefs.relay.depositIndex` to `n + 1` and is added to `pending`; each pending output with enough confirmations is sent to `creditDeposit`; `credited`, `already` and `small` leave `pending`; then `loadRelayBalance()`. Emits `"relay-balance"`.
- Auto-credit: on `"sync"`, at most once per new block, only while relay is open **and** (`pending` is not empty **or** the top-up sheet is open, `s.topUpOpen === true`). The account read runs on unlock only when `prefs.relay` exists, after a credit, after a relayed send, and once per new block while `balance + reserved > 0`. A wallet that never topped up makes no account or deposit lookups.
- `routePref`: default `"self"` always; a stored `"relay"` reads as `"relay"` only while `relayOpen()`, else `"self"`.
- `send({ via: "relay" })` and `retry` pass `{ account: this.#relay }` to `RelayPayer.carry`; `RelayPayer` takes `{ client, account }`, calls `submitEnvelope(envelope, { mode, account, ... })` and returns today's fields plus `reservedSats`.
- `deriveStatus`: relay status `missed` → `{ status: "failed", relayStatus: "missed", missedCode, reason: RELAY_TEXT.missed(code) }`.
- `retryChoices`: a `missed` entry → `["next-batch" (batch modes only), "next-block", "self", "copy"]`. A relayed entry with `relayStatus: "broadcast"` and `view.height >= (broadcastHeight ?? sentHeight) + 6` ("stuck") → `["self", "copy"]`.
- `linkage("relay")` adds `{ kind: "recent-deposit", height, landedSince }` when the newest credit height is known, lies inside the 144 blocks `landed144` covers (`height >= info.height − 144`, so the count is exact), and fewer than 5 relayed transfers (`info.stats.landed144` entries above that height) have landed since. The CLI applies the same rule (`recentDepositWarning`).
- `checkDeposits`: a pending payment the relayer has already credited (`relayBalance.credits`, by another device or tab) leaves `pending` without a credit call.
- First sync after a page load: when `/api/state` says a relayer with balances runs (`relay.enabled`, `mode: "balance"`) and the history holds a relayed send still in flight, relay info is loaded before the history is read; a scheduled batch send is never looked up per id before its `releaseAt`, nor shown as stranded, because the route has not opened yet.
- Events: `"relay"` (info), `"relay-balance"` (balance, deposits, pending).

### 5.4 Send form states (`app-send.js`, CRLF)

`state = routeState(s.relayInfo, s.relayBalance, form.mode)`:
- `off`: exactly the stage-0 cards (Pay the fee myself, Copy envelope) and notes, with `RELAY_OFF` in place of the old `RELAY_LATER` line.
- `none` / `unknown`: the stage-0 cards plus one quiet line under them: a ghost small button `RELAY_TEXT.entry` (`data-action="relay-topup"`). No relay card, no timing control.
- `ok`: cards in order Pay the fee myself, Copy envelope, Relay from my balance. The relay card: title `RELAY_TEXT.cardTitle`, status `RELAY_TEXT.cardStatus`, fee `RELAY_TEXT.cardFee`, link level 3 with `LINK_TEXT.relayer` (revised, §5.7). Timing control as today when the relay card is chosen.
- `low`: the relay card shown disabled with reason `RELAY_TEXT.low` (+ `RELAY_TEXT.lowBatch` for a batch mode) and a Top up button.
- `fee_high`: the relay card disabled with reason `RELAY_TEXT.feeHigh`.
- The form starts on `s.routePref`; if that is `"relay"` and the state is not `ok`, the form uses `"self"` without changing the stored preference.
- Relay chosen: steps `{ id: "submit", label: "Hand to the relayer, paid from your relay balance" }`, then `queued` (no `pow` step). Disclosure rows: Bitcoin fee `~N sats from your relay balance`, Paid by `Relayer coins, charged to your relay balance`, note `RELAY_TEXT.operator`. Hint: `RELAY_TEXT.recentDeposit` (warn callout) while `linkage("relay")` has `recent-deposit`; the user can still send.

### 5.5 Top-up sheet: `web/src/views/topup.js` (new, LF)

`openTopUp(s)` opens a sheet like `deposit.js` (Add BTC). `app.js` (CRLF) handles `data-action="relay-topup"` anywhere in the wallet, loading the module on first use, and lists "Relay balance" in the More menu only while `relayOpen()`. While open, `s.topUpOpen = true`. Contents, in order:
1. Title `Top up your relay balance`; lead `RELAY_TEXT.topUpOnce`.
2. Balance now (`available`, `reserved`) and `RELAY_TEXT.meter(stats.relayed144)`.
3. `RELAY_TEXT.suggested`, `RELAY_TEXT.minimum`, `RELAY_TEXT.confirmations`.
4. Deposit address `n = s.depositIndex` in full, QR (`qrSVG`), Copy button; `RELAY_TEXT.fresh`, `RELAY_TEXT.anyWallet`. Streamer mode masks address and QR until revealed.
5. Optional pay buttons: `Pay from the built-in key` (uses `planPayment` + `signLocal` + `api.esplora.broadcast`, after a confirm step showing amount, fee and `RELAY_TEXT.payFromKey`) and `Pay with Unisat` when connected (`sendBitcoin(address, sats)`, no memo, no UTXO filtering). Amount field defaults to the suggested amount, refuses below the minimum.
6. Deposits list from `checkDeposits()`: `RELAY_TEXT.waiting`, `credited`, `small`, refused message. Button `Check older addresses` (`older: true`).
7. Privacy box: `RELAY_TEXT.operator`, `RELAY_TEXT.timing`, `RELAY_TEXT.lookup`, `RELAY_TEXT.sweep`, `RELAY_TEXT.noWithdraw`.
8. After a credit: button `Use my relay balance for private sends` sets `routePref = "relay"`.

### 5.6 Settings, portfolio, activity

- Settings `#fees`: the relay card (`RELAY_TEXT.cardTitle`) only while `relayOpen()`, disabled unless state is `ok`/`low`. New panel `#relay-balance` while `relayOpen()`: balance, reserved, deposits count, next address number, Top up button, `RELAY_TEXT.operator`, `RELAY_TEXT.meter`. "Relayer books": address = `C`, no budget rows, ledger as today, audit per §5.2. Network note mentions the account read and deposit lookups.
- Portfolio fee card: `Private sends go via the relayer, charged to your relay balance` when `routePref === "relay"`; a `Relay balance N sats` line with a Top up link only when `prefs.relay` exists; otherwise nothing new.
- Activity: `missed` rows show `RELAY_TEXT.missed(code)` and the §5.3 choices; stuck rows show `RELAY_TEXT.stuck` and Pay the fee myself / Copy envelope. Every "tickets" string (app-shared `BATCH_TEXT.stranded`, landing, security, kit-view, `web/src/facts.json`) is rewritten without tickets.

### 5.7 Copy (`app-shared.js` exports `RELAY_TEXT`; every relay-balance string lives there)

```js
export const RELAY_TEXT = {
  entry: "Top up a relay balance",
  cardTitle: "Relay from my balance: my BTC address is not on the transfer",
  cardStatus: ({ balance }) => `Balance ${int(balance)} sats`,
  // marginPct, marginMinSats and the headroom come from info.balance; the defaults read as shown.
  cardFee: ({ perSend, marginPct = 10, marginMinSats = 50 }) => `~${int(perSend)} sats from your relay balance (network fee plus a ${int(marginPct)}% margin, at least ${int(marginMinSats)} sats)`,
  low: ({ balance, needed }) => `Your relay balance is ${int(balance)} sats; this send needs about ${int(needed)}. Top up, or pay the fee yourself.`,
  lowBatch: ({ headroom = 2 } = {}) => `A batch send reserves ${headroom === 1 ? "the fee" : headroom === 2 ? "twice the fee" : `${int(headroom)} times the fee`} until its batch goes out; the difference comes back.`,
  feeHigh: ({ feeRate, maxFeeRate }) => `Bitcoin fees (${feeRate} sat/vB) are above the relayer's cap of ${maxFeeRate} sat/vB, so it does not take sends right now. Pay the fee yourself or copy the envelope.`,
  topUpOnce: "Top up once, it lasts many sends.",
  meter: (n) => `Relayed transfers in the last 144 blocks: ${int(n)}`,
  suggested: ({ sats, sends }) => `Suggested: ${int(sats)} sats, about ${sends} sends at today's fees.`,
  minimum: ({ min }) => `Minimum ${int(min)} sats. A smaller payment is not credited and is not returned.`,
  confirmations: (n) => `Credited after ${n} confirmation${n === 1 ? "" : "s"}, about ${n * 10} minutes on average.`,
  fresh: "Each top-up gets a new address. Payments to an older one are still credited.",
  anyWallet: "Pay it from any signet wallet: a plain payment, nothing else. Never send real bitcoin to it.",
  sweep: ({ sweep }) => `${int(sweep)} sats of each top-up pay for the relayer to spend that coin later.`,
  noWithdraw: "The balance does not expire on signet. Withdrawing what is left is not available yet.",
  recentDeposit: "Your top-up confirmed recently and few people are relaying right now. Sending now can link this transfer to the address you paid from. A batch mode, or waiting, hides this better.",
  operator: "The relayer can link the address you top up from to every transfer you relay with this balance. Tor does not prevent this. It cannot see amounts, tokens or recipients.",
  timing: "Topping up ahead of time hides this better: a send made right after a top-up confirms is easier to link to the address that paid.",
  lookup: "To notice your payment, this browser asks mempool.space about the deposit address while this sheet is open or a payment is waiting; mempool.space sees your IP and that address.",
  payFromKey: "The relayer sees which address paid. Paying from the built-in key links your relay balance to that key's address, which your self-paid sends also use.",
  waiting: ({ confirmations, needed }) => `Payment seen, waiting for confirmation (${confirmations} of ${needed}).`,
  credited: ({ amount }) => `Credited: +${int(amount)} sats.`,
  small: ({ min }) => `Below the ${int(min)}-sat minimum: not credited.`,
  missed: (code) => code === "fee_high"
    ? "Not sent: fees were above the relayer's cap when it was due. Nothing was charged."
    : "Not sent: your relay balance did not cover the fee when it was due. Nothing was charged.",
  stuck: "The relayer's carrier is not confirmed yet. You can pay the fee yourself with the same envelope; if the relayer's carrier is also mined, its fee stays spent.",
};
```
`recentDeposit`, `operator` and `topUpOnce` are the approved sentences of `relay-balance.md` §5 and must stay word for word. Next to `recentDeposit`, the web wallet and the CLI add "A batch hides nothing while it holds only your transfer." while no other transfer waits for the hourly batch (privacy-trace-test.md L3). `LINK_TEXT.relayer` (`web/src/ui/meter.js`) becomes: "On Bitcoin, relayer coins carry the transfer, not yours. The relayer knows which balance paid and the address you topped up from. It can't read or change the contents: the proof binds every byte."

## 6. `bin/murkle.mjs` (CRLF) and docs

### 6.1 Commands

```
relay account <w> [--relay url]                  (alias: relay balance <w>)
relay topup <w> [--relay url] [--pay <sats> [--fee-rate n] [--dry-run]]
relay credit <w> [<txid:vout> [<n>]] [--older] [--relay url]
send <w> <ticker> <amount> <mrk1…> --relay [url] [--fast | --batch | --batch10] [--no-wait] [--wait-max <minutes>]
retry <w> [--relay [url]] [...] | pending <w> [--relay url]
relayer retire-free --to <address> [--dry-run] [--fee-rate n]     (unchanged)
```
- The account: `relayAccount(Buffer.from(file.seed, "hex"), NETWORK)`. The wallet file gains `relay: { depositIndex, pending: [{ n, outpoint }] }` (written with `writeWalletFile`; older files without it read as 0 and an empty list). `pending` holds top-ups paid but not credited yet, as the web wallet's `prefs.relay.pending` does.
- `relayClient(url)` gains `account(body)` and `credit(body)`; `info`, `submit`, `status` as today.
- `export const relayOpenAt = (info) => info?.enabled === true && info?.mode === "balance";` replaces `RELAY_OPEN`. `relayed()` fetches info first; not open → `error: relaying is unavailable at <url>: no relayer with relay balances runs there. Nothing was handed over. Send without --relay to pay the fee from this wallet's BTC fee key, which ties the transfer to that address on Bitcoin.` exit 1. `listPending` / `pickRetry` take `open` from `relayOpenAt(info)` (an unreachable relayer counts as closed).
- `relaySend`: no PoW (`solvePow` and the `pow` body are gone); before proving it reads the account (signed) and, when `balance < perSendSats × (batch ? batchHeadroom : 1)`, prints `relay balance <b> sats; this send needs about <need>. Nothing was handed over. Top up: murkle relay topup <w>` and exits 1. It submits `signRequest(...)` bodies. A 402 `balance_low`, 503 `fee_high` or any refusal after hand-out is status `refused` (exit 4). `waitForRelay` treats `missed` as final: prints `relay missed: <code> (<reason>); nothing was charged: murkle retry <w>` and exits 4.
- `relay topup` without `--pay` prints the address and rules (while the relayer quotes no price: `suggested amount: not quoted yet (the relayer does not know the fee rate)` and `--pay <sats> (at least N)`); with `--pay <sats>` builds `planPayment` from the BTC fee key to that address (refuses below the minimum), prints the txid, broadcasts unless `--dry-run`, adds the payment to `relay.pending`, then advances `relay.depositIndex`. A payment `relay topup` sees at an address it moves past is added to `relay.pending` too.
- `relay credit` with an outpoint credits it (index `n` defaults to the wallet's `depositIndex − 1`, else 0); without one it looks up the wallet's deposit addresses (`depositIndex`, and all older ones with `--older`) with `api.utxos`, adds every `relay.pending` entry, and credits each output. Credited, already credited and refused ones leave `relay.pending`; waiting ones stay.

### 6.2 Output (stdout) and exit codes

```
relay account alice
account   3f9a…c2d1 (signet)
balance   6,055 sats available, 0 reserved
next      deposit address #1  tb1p…
relayer   http://localhost:8787  per send ~657 sats (fee 597 + margin 60 at 1 sat/vB)

relay topup alice
deposit address #1: tb1p…
minimum 2,000 sats; credited after 1 confirmation; suggested 7,000 sats (about 10 sends)
a plain payment from any signet wallet, never real bitcoin; each top-up gets a new address, older ones are still credited
the relayer can link the address you top up from to every transfer you relay with this balance; Tor does not prevent this

relay credit alice
#0 <txid>:0  7,000 sats  credited +6,712 (balance 6,712)
#1 <txid>:1  1,500 sats  below the 2,000-sat minimum: not credited
#2 <txid>:0  9,000 sats  waiting for confirmations (0 of 1)
```
Exit codes: `relay account` / `topup`: 0 ok, 1 error (unreachable, not in balance mode, usage). `relay credit`: 0 every found deposit credited or already credited, 1 error or nothing found, 4 any deposit refused (`deposit_small`, `deposit_mismatch`, `deposit_own`, `already_credited`), 6 none refused but some still unconfirmed. `send --relay` / `retry`: today's table (0, 1, 3, 4, 5, 130) with `missed` → 4. There is no command that funds the relayer.

### 6.3 Docs

- `README.md`: the relay section (top-up, credit, send, exit codes) and the environment table with every §4.1 variable.
- `SPEC.md` §14 (non-consensus): the account label, deposit tweak, outpoint format, signed-request digest and I-PAY.
- `docs/design/relayer.md` (historical, the retired v1 relayer) and `docs/design/paid-relay.md` (superseded) carry notes at the top that point here.
- `docs/design/batch-contract.md`: the dated amendment (Fast and Next block above the cap are refused with `fee_high`, never held; at release a short or over-cap item becomes `missed`; an epoch is held whole only when the relayer cannot send at all; no proof of work).
- `docs/CLAIMS.md`: the relay-balance disclosure (prepaid, operator linkage, timing).
- `audit/REPORT.md`: the v2 addendum recording I-PAY (I0, I1, I2) with the enforcing functions of §3 and the test files of §8.

## 7. Test conventions

- The test harness `test/fixtures/relay-harness.mjs` exports `makeFakeEsplora()` (feeRate, broadcast, txStatus, txHex, rawTx, tipHeight, mine, and a `utxos` that throws "the paid relayer never lists addresses"), `makePaidRelayer({ idx, esplora, config })` (temp dir, fresh keys), `fundAccount({ relayer, esplora, account, sats, n })` (a deposit tx paying `depositAddress`, mined, credited through `relayer.credit`) and `signedSubmit(account, info, envelope, mode)`.
- CRLF files (keep CRLF; count bytes with node): `web/src/session.js`, `web/src/relay.js`, `web/src/app.js`, `web/src/views/app-send.js`, `web/src/views/app-shared.js`, `web/src/views/landing.js`, `web/src/ui/kit-view.js`, `web/src/styles/components.css`, `web/src/styles/pages.css`, `bin/murkle.mjs`, `src/keys.mjs`. New files are LF. Every other listed file is LF.
- Tests bind port 0, use temporary copies of any state, never read or write `data/signet/`, never broadcast and never use a browser wallet. English only.

## 8. Tests

**shared** `test/relay-account.test.mjs`
1. `relayAccount`: deterministic per seed; signet, testnet and mainnet accounts differ; label is `murkle/relay-account/v1/<network>`; `id === sha256(pub)`; the secret differs from the web fee key (`murkle/btc-fee`) for the same seed.
2. Deposit address `n` is the same computed "wallet side" (`depositAddress(Q, id, n)`) and "server side" (`schnorr.getPublicKey(depositSecret(q, id, n))` equals `depositKey`), for even- and odd-y `Q` and n in {0, 1, 2^31 − 1}; different n, id or Q give different addresses; n outside range throws; mainnet gives `bc1p`, signet `tb1p`.
3. A key-path spend of a deposit output signed with `depositSecret` via `planCarrierTx` (per-input script and key) + `signInputs` verifies (scure finalize and a schnorr check of the witness).
4. `parseOutpoint` accepts canonical forms and refuses: uppercase hex, 63/65 hex chars, leading zeros (`:01`), `:+1`, `:-1`, `: 1`, `:1 `, `:1e2`, `:4294967296`, no colon, two colons.
5. `canonicalBody` sorts keys and refuses `sig`, floats, negatives, nested objects; booleans are JSON `true` / `false`; the same fields in another order give the same digest. A submit may add the signed boolean `linkable`; dropping, flipping or adding it after signing is `bad_signature`, any other type `malformed`.
6. `verifyRequest`: a valid request passes; changing endpoint, network, `Q`, envelope, mode, accountPub or t fails with `bad_signature`; t 601 s off is `stale_request`; a missing or extra key is `malformed`.
7. `planCarrierTx` with only today's arguments produces byte-identical hex to the stage-0 implementation (fixed fixtures); `changeScript` moves change to it and the fee accounts for its size; `order: "given"` keeps order; a non-P2TR per-input script throws; `feeOf` equals inputs minus outputs; `planPayment` has no OP_RETURN, refuses dust and shortfalls.

**shared** `test/relay-books.test.mjs`
1. 20 parallel async credit flows of one outpoint (claim, await, credit, unclaim) credit once; the others see `claim() === false` or `isCredited`.
2. Spelling variants of a credited outpoint are refused (`bad_key`) and never create a second credit.
3. A credit survives `saveBooks` / `loadBooks` and is not repeated after it; a repeat `credit` throws `already_credited`.
4. `reserve` / `settle` / `release`: batch 2x reservation, exact charge at settle, the rest returned; settle with reservation + balance short throws `balance_low` and changes nothing; `marginFor` floor and percentage at fees 1, 499, 500, 597, 3000.
5. `confirmCharge` removes the only account link of an item; `toJSON()` holds no item id after confirm or release.
6. I2 holds (`checkI2().ok`) after 2,000 random sequences of credits, reserves, settles, confirms, refunds, releases, penalties, housekeeping, reclaims and reverse credits (reorgs), with `poolUnspent` simulated as the coin sum; a tampered balance, a duplicated credit value or a negative margin fails I2 with a problem string.
7. `restore` refuses another version, network, pool key or change key.

**server** `test/relay-balance-relayer.test.mjs`
1. Startup: `MURKLE_RELAYER=1` alone is refused; `RELAY_MODE=balance` alone starts nothing; each invalid value is refused with its problem; valid config starts. `startPaidRelayer` creates new keys under a temp `relayDir`; a pool or change key equal to the old key (copied to temp) is refused; a state file whose keys differ is refused; the old key and v1 state files are byte-identical afterwards.
2. As a real process with `MURKLE_RELAYER=1 MURKLE_RELAY_MODE=balance` and temp paths, the server serves `/api/relay/info` with `mode: "balance"`; without `RELAY_MODE` it serves the stage-0 shape.
3. Credit: 20 parallel HTTP credits of one outpoint credit once (others 200 `already` or 409 `credit_in_progress`); spelling variants 400 `bad_outpoint`; restart, then repeat → 200 `already: true`; another account or n → 409 `already_credited`; unconfirmed → 409 with counts; mismatched address → 422; below 2,000 → 422 `deposit_small`; the relayer's own change outpoint → 422 `deposit_own`.
4. A dust flood of 600 outputs at `Q`'s plain address, `C`'s address and every deposit address changes nothing: `esplora.utxos` is never called, capacity and coins are unchanged.
5. No output of any transaction the relayer signs equals a deposit script or `Q`'s script; every non-OP_RETURN output pays `C`.
6. `balance_low` (402) before any proof check (a counting `checkTx` spy stays at 0); `bad_signature`, `stale_request`, `replayed`; a submit signed for another mode or envelope is refused.
7. Above the cap, Fast and Next block are refused with `fee_high` at submit, never queued or held.
8. One short batch item becomes `missed` (`balance_low`, reservation returned) while the rest of its epoch is broadcast at `releaseAt`; a top-up afterwards never sends it; status shows `missed` with `code`.
9. Batch at release above the cap: every item `missed` with `fee_high`, nothing charged. Fee rate unknown or too few pool coins: the epoch is held whole and goes next block.
10. Charges: each broadcast carrier charged `fee + marginFor(fee)`, fee equal to the on-chain amount difference; I2 holds after every tick; a corrupted books file halts the relayer (503 `halted`) while `/api/relay/info` and v1 status still answer.
11. `signPoolTx` is the only signing call site in `server/relayer.mjs` (source grep); no two signed transactions share an input; no bump/RBF/CPFP path (source grep for `bump`).
12. The saved `relayer.json` holds no account id next to any carrier txid once broadcast (scan every item and ledger entry); `/api/relay/ledger` has no account, id or cost.
13. No request body is logged: a capturing logger over a run of credits, account reads, submits and failures contains no envelope hex, accountPub, sig or outpoint.
14. Deposit reorg: a credit whose tx vanishes for two ticks is reversed; a reversed coin already spent halts.

Updated existing server tests: stage-0 assertions changed to the R6 rules (refusal text, `relayInfoOff` shape, `indexer-server.mjs` imports `startPaidRelayer` and not the `Relayer` class); relayer and batch tests fund accounts through the harness instead of a hot address and sign instead of grinding PoW; budget and `hot_wallet_low` tests are replaced by balance and `pool_low` tests.

**web** `test/relay-balance-web.test.mjs` (fake storage, fake DOM, stubbed relay client and esplora)
1. `setRelayRoute` / `routeState` for every state (off, unknown, none, low, low batch with headroom, fee_high, ok).
2. Session derives the same account and deposit addresses as `src/relay-account.mjs` for the same 24 words; a mismatching `depositAddress` from the relayer throws and nothing is paid.
3. `checkDeposits`: a payment at `depositIndex` advances the index; an unconfirmed one stays pending; a confirmed one is credited once; `small` and refused codes map to their states; `older` scans older addresses. No deposit or account request is made by a wallet without `prefs.relay` when the sheet is closed.
4. Send form: with no balance it renders exactly the stage-0 cards plus the `RELAY_TEXT.entry` button; `ok` shows the relay card last and keeps "Pay the fee myself" checked by default; `low` and `fee_high` render disabled cards with their texts; a stored `"relay"` with state `low` falls back to self for the form.
5. `submitEnvelope` sends `{ envelope, mode, accountPub, t, sig }` that `verifyRequest` accepts, never a `pow` field; `relayFailure` texts for every §4.4 code.
6. `deriveStatus` and `retryChoices` for `missed` (batch and non-batch) and stuck broadcast entries; Activity renders `RELAY_TEXT.missed` and `RELAY_TEXT.stuck`.
7. `linkage("relay")` gives `recent-deposit` below 5 landed carriers since the newest credit, and the send hint shows `RELAY_TEXT.recentDeposit`.
8. Top-up sheet: address, QR, suggested amount, minimum, confirmations, all privacy lines; streamer masking; pay-from-key builds a plain payment without OP_RETURN through a stubbed broadcast.
9. `RELAY_TEXT.recentDeposit`, `operator`, `topUpOnce` equal the sentences in `relay-balance.md` §5; no web file contains "ticket" (case-insensitive) or a `FREE_RELAY` pattern; `test/english.test.mjs` passes.

**cli-docs** `test/relay-balance-cli.test.mjs`
1. `relayOpenAt`; `send --relay` against a stage-0 server (info off) exits 1 with the unavailable line and writes nothing.
2. `relay account`, `relay topup` and `relay credit` against an injected client: the output lines of §6.2 and every exit code (0, 1, 4, 6); the wallet file's `relay.depositIndex` advances only after a payment is seen or made.
3. `relaySend` preflight: a short balance exits 1 before proving (no pending entry written); a 402 after hand-out exits 4; `missed` in `waitForRelay` exits 4 with the retry hint; the submit body verifies with `verifyRequest` and has no `pow`.
4. `relay topup --pay --dry-run` builds a plain payment to deposit address `depositIndex` with no OP_RETURN and broadcasts nothing.
5. HELP lists the new commands; no command, flag or help line funds the relayer (`/fundw*s+(thes+)?(relayer|pool)/i` matches nothing in `HELP`, the command table or `bin/murkle.mjs`).
6. Docs: README lists every §4.1 env name; `paid-relay.md` starts with the superseded line; `batch-contract.md` has the amendment; `audit/REPORT.md` names I-PAY, I0, I1, I2 and `signPoolTx`; no "ticket" wording outside `paid-relay.md` and `relay-balance*.md` in `README.md`, `SPEC.md`, `server/`, `bin/` and `web/src`.

## 9. As built (2026-10-03)

Where the code differs from §1 to §6, the code below is what ships; each point was checked against rules R1 to R6 and none adds a wait or makes the operator pay.

**Shared** (`src/relay-account.mjs`, `server/relay-books.mjs`, `src/btc/funding.mjs`)
- `REQUEST_FIELDS` and `RELAY_MODES` are exported; `verifyRequest` enforces the exact key set per endpoint path (an unknown endpoint or an extra or missing key is `malformed`) and, for submit, a mode in `RELAY_MODES` and a non-empty even-length lowercase hex envelope. The relayer takes its key sets from `REQUEST_FIELDS`. A bad `network` or `poolKey` passed to `verifyRequest` throws (that is the relayer's own configuration, not a request fault). Skew is compared in whole seconds.
- `RelayBooks.payHousekeeping` spends only `availableMargin()` (the margin minus the margins of charges not yet confirmed), so a later `refundCharge` can never push the margin below zero. `refundHousekeeping(fee)` undoes a housekeeping charge for a transaction that was never signed or never reached the network; `reclaim(fee)` stays for a broadcast carrier that was finally dropped.
- `claim`, `isCredited`, `credit` and `reverseCredit` throw `bad_key` for a non-canonical outpoint key (callers parse with `parseOutpoint` first). `isCredited` returns reversed credits marked `reversed: true`; `credits(id)` leaves them out.
- `RelayBooks.restore` throws `invalid` or `bad_key` on a structurally broken file; a well-formed file with tampered numbers loads and then fails `checkI2`, which halts the relayer. A structurally broken state file therefore stops `startPaidRelayer` (the indexer logs the refusal and keeps running with the stage-0 endpoints); a tampered one starts halted.
- `planCarrierTx` with a custom `changeScript` keeps change only at or above `max(330, dustLimit(changeScript))`; a per-input `script` must equal `p2tr(tapInternalKey).script`.

**Server** (`server/relayer.mjs`, `server/indexer-server.mjs`, `server/retired-relay.mjs`)
- `pool_low` is checked at submit for every mode, not only batch: a Fast or Next-block send the pool coins cannot fund in this block is refused at once, never queued to wait.
- `too_large` says "The request body is too large. Send only the envelope and its signature." (the old text named a proof of work that no longer exists).
- A reversed deposit answers 409 `already_credited`, even to its own account and `n`: an outpoint is never credited twice.
- The "spent a reversed deposit" halt is sticky: a later tick where I2 holds does not clear it. Clearing it needs the operator; there is no command for it. Every other I2 halt clears as §3 says.
- Coins go from `unspent` to `spent` in one synchronous step inside `signPoolTx` (status `reserved` is not used). Change of a transaction that has not reached the network yet (`unsent`) is not spendable. A coin a broadcast reported missing is skipped until the next block.
- Merges (`kind: "merge"`, `maybeMerge`) take as many deposits as the available margin pays for (`mergeRoom`), and capacity counts deposits only through such a merge (`fundingCoins`; audit V2-16). The ledger and the audit accept the kind.
- A failed fee-rate fetch keeps the last known rate; "fee rate unknown" means never fetched, or a rate that cannot be priced.
- If the journal save inside `signPoolTx` fails, the signature is undone in memory (refund, re-reserve, coins back, the unsaved fan-out entry removed) and the error is rethrown: nothing that is not on disk is ever broadcast.
- Account reads check, in order: parse, gate (`disabled`, `halted`), per-IP limit, signature. Unexpected errors in an endpoint are logged only as `relay <endpoint> failed: internal error (<name>)`.
- Extra exports: `readConfig`, `balanceProblems`, `MESSAGES`, `MISSED_REASON`.

**Web** (`web/src/*`)
- `routeState` precedence is `off`, `unknown`, `none`, `fee_high`, `low`, `ok`: a wallet with nothing on its balance sees only the quiet top-up entry, never a disabled relay card, even while fees are high (R3). A balance of 0 with something reserved is `low`.
- The relay card is also disabled in state `ok` while relay info reports `halted`, `indexer_behind` or `busy`.
- `submitEnvelope` takes an optional `balance` for a local `balance_low` refusal; the session does not pass it (the relayer decides, so a stale balance never blocks a send).
- `auditRelayer` reports coins others sent to `C` as `foreign` and leaves them out of the total.
- `prefs.relay.pending` entries also carry `height` and `since`; a Unisat top-up whose output number is not known yet is kept as `{ n, outpoint: null, txid }` until seen; entries not seen within 144 blocks are dropped. A balance read that finds a balance or `nextIndex > 0` on a wallet without `prefs.relay` (restored from its words) stores `prefs.relay`.
- `RELAY_TEXT.missed` is `relay.js` `missedText` (same strings), so the session does not import a view.

**CLI** (`bin/murkle.mjs`)
- `relayOpenAt(info)` decides whether relaying is open; `RELAY_OPEN` stays exported as `false`, the default `open` of `listPending` / `pickRetry` when no info was read.
- `relayUnavailable(url)` is a function (the message names the URL).
- `relay topup` skips deposit addresses the explorer already shows paid, so each top-up gets a fresh address; `relay credit` lists unconfirmed payments as waiting without asking the relayer. Exit precedence when outcomes mix: 1 > 4 > 6 > 0.
- `send --relay` also prints the balance and cost, the operator line, the recent-deposit warning (fewer than 5 relayed transfers landed since the newest credit), `reserved N sats` after a 202 and `charged N sats` after landing.

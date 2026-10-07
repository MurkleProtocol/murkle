# Batch relay timing: Hourly batch and 10-hour batch (design, signet now, then mainnet)

Status: stages 1 and 1b are **built** for signet (interfaces: `docs/design/batch-contract.md`). Stages 2 to 4 (sections 5.3 to 5.5) are **proposals, not built**. Written 2026-10-02 against the signet deployment of that day (genesis at 324,592, one token, one mint, the free relayer "Ghost Relay" still running); section 9 records the decisions, including the change from the 12-hour to the 10-hour batch on 2026-10-03. The product never uses the name "level 2" (section 6.4).

**Since 2026-10-03, batches are paid from relay balances.** The free relayer ("Ghost Relay") that carried batches is retired: anyone could drain it with zero-value transfers (audit R-2). Batch sends are now carried by the paid relayer and paid from the user's prepaid relay balance (`relay-balance.md`; the amendment at the end of `batch-contract.md`). Where this file says Ghost Relay pays, the free tier is capped, or users will pay with blind tickets (sections 1, 5.4, 7.1 and 7.3), `relay-balance.md` replaces it.

## 1. Decision

Build **batch relay timing**: a third stop, "Batch", in the existing "Relay timing" control on the Send form, next to "Fast (~1 min)" and "Next block", with two lengths under it, **"Hourly batch"** (6 blocks) and **"10-hour batch"** (60 blocks). It needs **no consensus change and no circuit change**:
- The wallet proves against the block that opened the current batch (the epoch start S: a height divisible by 6, or by 60), not the tip.
- Ghost Relay holds batch envelopes until the batch closes (block S+6, or S+60), then sends all of them in one shuffled burst together with that block's Next-block sends. They land together (normally in block S+7, or S+61), with one shared anchor.
- People watching Bitcoin then see "one of the N batch transfers sent that hour" (or in those 10 hours), not the moment you pressed Send. Next-block and Fast sends of that hour land in their own blocks with their own anchors, so they are not part of that crowd. No BTC address of yours appears, exactly as today.
- The relayer publishes each batch's waiting count once per block (a snapshot, never live). Anyone polling it can still see in which block each batch transfer was submitted; with few transfers, that is the block you submitted in. The Tor line on the form says so (section 4, item 11).
- The two lengths are **separate crowds**. An hourly and a 10-hour transfer with the same anchor land 54 blocks apart, so each hides only among transfers of its own length, and the 10-hour crowd is the thinner one. The form says so.

Later, in one consensus release: a **BATCH op** carries a whole epoch in one transaction (up to about 19% fewer bytes per transfer, and the batch lands all at once), bundled with the planned `expiry` field (with the 10-hour batch, a uniform `expiry` no longer shortens the W-1 lock; section 9, decision 2). Before mainnet, users pay with **blind tickets** (relayer.md §7.2), which is the unlinkable form of "pay with your own wallet".

**Not built, at any stage:** a user-paid encrypted submission transaction, batches or balance diffs that need an operator key, piggybacking on random users' transactions, and decoys made by the operator.

Why this shape:
- What a TRANSACT still leaks is **who paid the carrier and when it landed**, not its content. The proof already hides token, amount, sender, recipient and the spent notes (SPEC §4–5), and validity does not depend on the carrier (A-10).
- Ghost Relay already removed the payer. What is left is timing, and timing is hidden only by batching **plus** anchor rounding. Delay alone does little, because the public anchor gives the proving block away (section 2.2, point 4).
- The user's mechanism puts the user's BTC address back on chain next to a Murkle action. That is strictly worse than today's default route.

The biggest privacy lever is still **more independent holders**. When this was written (height 324,650, from `GET /api/stats` and `/api/relay/info`) the pool held 2 notes from 1 mint, with no private transfer and nothing relayed in the last 144 blocks. No batching, delay or carrier trick changes that; they only stop the crowd from shrinking further. The copy must say so.

## 2. The idea as proposed

The proposal that started this design: a toggle on Send turns on "level 2 protection". The user pays, from their own relay wallet, for a transaction with an encrypted OP_RETURN. The indexer registers it. Then **either (a)** an indexer master wallet posts, every few hours, one big OP_RETURN transaction recording the balance changes, **or (b)** the transfer is added at random to one of the next transactions of another random user.

### 2.1 What it gets right

1. **It targets the right layer.** After the proof, the remaining leaks are timing and carrier linkage. Separating "when I sent" from "when it landed", and landing many transfers together, is the right lever.
2. **A speed/privacy control is a legible product.** Users understand "slower but more private".
3. **"The user pays" is the right instinct for mainnet.** A free relayer is a subsidy anyone can drain (relayer.md §1).
4. **Variant (b) aims at a real property:** a carrier should not mean "its payer wrote this transfer". Murkle already lets anyone carry anyone's envelope (A-10, W-1), so the property is reachable.
5. **Batching saves bytes**, though less than it looks (section 7.2).

### 2.2 What would hurt

1. **The self-paid submission brings back the leak Ghost Relay removed.** A transaction from address P with a recognisable OP_RETURN of about 500 bytes tells everyone, permanently, "P took part in a Murkle transfer at block T". Encryption hides the content, which the proof already hides. It does not hide the payer, the time, the size or the format. Worse, the submissions before each batch form a **public roster of senders** for that batch.
2. **"The indexer registers it" breaks replay.** Only the key holder can read an encrypted payload. Either the operator's key becomes a consensus authority (one point of censorship and failure, and a key leak links every past payer to its envelope), or the batch must carry the full proofs anyway, and then the encrypted submission was only a payment that still links P.
3. **"Recording balance changes" does not fit the model.** Murkle has notes and nullifiers, not balances. A state diff without per-transfer proofs is a rollup with no validity proof: replayers cannot check it, recipients cannot find their notes, and the master key could write anything. With proofs, it is the multi-envelope carrier of section 5.3.
4. **The public anchor undoes the delay.** `h_anchor` is public and today equals the wallet's tip at proving time (`anchor: indexer.height`, `src/wallet.mjs:137`). A transfer held for hours lands with an old anchor that tells everyone when it was proved.
5. **"Every few hours" collides with the anchor window and W-1.** Notes stay reserved until the transfer lands or until `anchor+100` (W-1). The relayer refuses anchors older than tip−76 (live `minAnchor` 324,574 at 324,650). The planned uniform `expiry = anchor+18` caps any hold at about 3 hours.
6. **The user pays twice** (the submission, then a share of the batch) for little saving: the 471-byte envelope dominates every carrier.
7. **Unisat users could not take part.** Unisat's signet node rejects OP_RETURNs over 83 bytes (`web/src/payers.js:116`).
8. **Variant (b) has its own problems:**
   - It needs a multi-envelope consensus rule. Today only the first `mrk` OP_RETURN counts (`findEnvelope`, `src/envelope.mjs:226`).
   - A coordinator must hold the pending envelopes and pick hosts. It sees both users' IPs and can pick the host to hurt you; that is a relayer anyway.
   - Strangers pay for your bytes with no reason to, and their BTC address ends up on your transfer.
   - It depends on strangers' activity. With one self-paid transaction a day, 59% of transfers would find no host inside the relayer's 76-block window. With Ghost Relay almost nobody self-pays, so there are no hosts.
   - Unisat cannot host: `sendBitcoin` carries one memo, and hosting through `signPsbt` would mean choosing inputs, which the project ruled out (no UTXO filtering).
   - Riding on MINT or DEPLOY carriers makes the public minter look like the author, and `Indexer.treasuryPaid` (`src/indexer.mjs:221`) sums every treasury output of a transaction.

### 2.3 Facts checked in the code

| Claim | Where | Result |
|---|---|---|
| TRANSACT validity ignores the carrier | `Indexer.checkTx`, `src/indexer.mjs:242` | Confirmed: `tx` is only read for mints (A-10). |
| `extDataHash` covers the header | `encodeTxBody` + `extDataHashOf`, `src/envelope.mjs:85,104` | Confirmed: magic, version and op are in the hashed body, so an envelope can be nested verbatim. |
| The anchor is the proving tip | `Wallet.buildEnvelope`, `src/wallet.mjs:121,137` | Confirmed. Paths come from `indexer.tree`, whose root is R[tip]. |
| A tree at an older height can be rebuilt | `MerkleTree.truncate`, `src/core.mjs:54` | Exists (rollback). It mutates in place, so the wallet needs a copy first. |
| Roots of past heights are available | `GET /api/roots`, `server/indexer-server.mjs:485` | Yes, all roots are kept (no pruning). |
| Only the first `mrk` OP_RETURN counts | `findEnvelope`, `src/envelope.mjs:226` | Confirmed. Any multi-envelope carrier is a consensus change. |
| Zero-value inputs skip Merkle membership | `circuits/lib.circom:125-128` | Confirmed: `ForceEqualIfEnabled` with `enabled <== inAmount[i]`. `buildTxInput` pads with a random `sk` and `leafIndex 0` (`src/core.mjs:95`). See 3.3. |
| Relayer modes | `parseSubmit`, `server/relayer.mjs:1153` | `"block"` (flush when the indexer height rises) and `"fast"` (10–40 s timer). |
| Unisat cannot post a large OP_RETURN on signet | `web/src/payers.js:116` | Confirmed (pre-v30 node, 83 bytes). |

## 3. Who sees what

### 3.1 By observer and option

"Content" (token, amount, sender, recipient, spent notes) is hidden by the proof in every column. The table covers what is left.

| Observer | Next block (today, default) | Idea (a): self-paid submission + operator batch | Idea (b): piggyback | **Hourly batch (stage 1)** | Hourly batch + BATCH op (stage 2) |
|---|---|---|---|---|---|
| **Anyone reading Bitcoin** | Relayer address, block, anchor. Send time to about one block. Hidden among transfers in the same block. | Your address P, the time and "a Murkle transfer", permanently. Which batched transfer is yours: 1 of k. | Host Q's address on your transfer; Q gets 1-of-2 deniability. Your own submission link as in (a). | Relayer address and the batch block. Send time hidden within the hour, among k batch members. No address of yours. The rounded anchor marks it as a batch transfer, so it hides among batch members only. | Same as stage 1, in one transaction that lands all at once. |
| **Network observer** (ISP, Wi-Fi) | A POST to the relayer at t: "one of the next block's transfers". | P's broadcast through mempool.space or Unisat, who also get your IP. | Same as (a), plus the coordinator traffic. | A POST at t: "one of this hour's batch". | Same as stage 1. |
| **Relayer / indexer operator** | IP (unless Tor), user agent, submit time, the envelope minutes before it is public. | Everything at left, plus P (a durable identity instead of a changeable IP), plus a decryption key that decides consensus. | The mapping guest → host, and the choice of host. | Same as today, for up to an hour longer. Batching gives **nothing** against the operator. | Same as stage 1. |
| **Anyone polling the relayer's API** (`/api/state`, `/api/relay/info`) | The Next-block queue count, so about when a Next-block send was submitted (it lands in the next block anyway). | — | — | Each batch's waiting count, the PoW bits and the reserved sats, published once per block: the block each batch transfer was submitted in, not the minute. With k = 1, the block you submitted in. | Same as stage 1. |
| **Recipient** | Amount, token, carrier txid. Not your address. | The possible senders are the payers of the k submissions; with k = 1 they read your address. | The host's address, which may be mistaken for yours. | Amount, token, carrier txid. Not your address. | Same. |

Only Tor (or a `.onion` endpoint) helps against the operator and the network observer at the same time.

### 3.2 How big the crowd is at low volume

Model transfers as a Poisson stream of λ per day. In a release window of E blocks, your release holds on average k = 1 + λE/144 transfers, yours included. "Alone" is the chance that nobody else is in it.

| Transfers per day | Next block (E = 1) | **Hourly batch (E = 6)** | **10-hour batch (E = 60)** |
|---|---|---|---|
| 1 | k 1.01, alone 99% | k 1.04, alone 96% | k 1.4, alone 66% |
| 5 | k 1.03, alone 97% | k 1.21, alone 81% | k 3.1, alone 12% |
| 20 | k 1.14, alone 87% | k 1.83, alone 43% | k 9.3, alone under 1% |
| 100 | k 1.69, alone 50% | k 5.2, alone 2% | k 43 |

λ is the traffic that uses that length: the two lengths are separate crowds, so a 10-hour batch only gains from traffic that chose it. Today λ is 0. The batch becomes meaningful at tens of transfers a day. Until then it hides little: Bitcoin no longer shows the block you sent in, but the relayer's public waiting count does (section 4, item 11), and the UI says how thin the batch was (before sending and after landing). These percentages are for this document only; the UI shows none.

### 3.3 Cover traffic: possible, not now

- **It is valid.** An input with `inAmount = 0` skips the Merkle check (`ForceEqualIfEnabled`), its nullifier comes from a random `sk`, and both outputs can be zero-value notes to throwaway keys. A transfer with no notes behind it is valid and looks the same as a real one, on chain and to the relayer.
- **It is also the attack.** The same property is why a free relayer can be drained, and why one actor can fill a batch with its own transfers and learn which one is yours (the n−1 attack, section 8).
- **Operator decoys stay rejected** (rejected in the feature review): they give nothing against the operator and inflate the public counters and the Crowd Meter.
- **Wallet cover waits.** Each cover transfer costs every replayer 2 leaves, 2 nullifiers and one Groth16 check forever, and drains the free budget. The honest substitute now is real traffic that has to happen anyway: "merge notes" and "refresh notes" self-transfers that default to the batch (stage 1b).

## 4. Leaks to avoid

1. **A BTC address of the user on chain next to a Murkle action.** No user-paid step in any privacy mode.
2. **An operator key that decides validity.** Every byte that changes state must be checkable by any replayer with no key (A-10, SPEC §1).
3. **A delay without anchor rounding.** It gives false privacy: the anchor states when the envelope was proved.
4. **Mode-dependent fields.** One uniform `expiry` for everyone; prices fixed per timing class and published, never per user (relayer.md §7.2).
5. **Split batches.** A straggler that lands one block after its batch, with the batch's anchor, stands out. Release an epoch whole or hold it whole (section 5.1, step 4).
6. **Rounding the anchor of Next-block sends.** If every relayed send used the boundary anchor, a send that has to use the tip (because its note is newer than the boundary) would reveal "spends a note added in the last hour", which is a tiny set at low volume. Only batch sends are rounded; Next-block sends keep the tip anchor, which says nothing new.
7. **Per-transfer lookups while waiting.** Status stays bulk plus the existing relay-status poll (the server refuses per-txid lookups, `docs/API.md`).
8. **Inflated or precise-looking numbers.** Count real carriers only, label them as transfers (not people), no percentages, no decoys.
9. **IP records.** The relayer holds envelopes longer, so it must still never log or persist IPs (relayer.md §4.6 test). A live compromise of the relayer would see IP-to-envelope links for the queued hour.
10. **Guests on mint carriers.** Never: it attributes the transfer to the public minter and touches the per-transaction treasury sum.
11. **A live public count.** `/api/state` and `/api/relay/info` are public and polled every 20 s by every wallet. A waiting count, PoW bits or reserved sats that moved with each batch acceptance would tell anyone polling them when each batch transfer was submitted, to the second. They are published as a snapshot taken when the relayer first sees each new block (`Relayer.snapshot()`); batch acceptances raise the PoW bits from the next block on; the 202 `epochQueued` is the published count plus your own. What is left: the count changes once per block, so the block you submitted in can be read from it when few transfers wait. The Tor line discloses this.

## 5. Recommended design

### 5.1 Stage 1: Hourly batch and 10-hour batch (no consensus change, no circuit change)

**Epochs.** Two lengths, fixed protocol-wide constants in `src/relay-batch.mjs`, not relayer settings, so every wallet computes the same boundary: `"batch"` (Hourly batch) with E = 6, epochs starting at heights `h % 6 === 0`, and `"batch10"` (10-hour batch) with E = 60, epochs starting at `h % 60 === 0`. Every 60-boundary is also a 6-boundary. Mode ids are plain strings everywhere (HTTP body, relayer state, history entries, CLI, saved preferences): `"fast"`, `"block"`, `"batch"`, `"batch10"`. A `"batch12"` (the retired 12-hour batch, section 9) saved by an older wallet reads as `"batch10"` where it chooses a timing (`savedMode`: the self-transfer preference, the retry of a history or CLI pending entry); the relayer refuses `"batch12"` as `malformed`. The module exports `epochStart(h, mode)`, `releaseHeight(anchor, mode)`, `lastReleaseHeight(anchor, mode)`, `leafCountAt(outputs, h)` and `batchSchedule(h, mode)` (contract §1).

**Window arithmetic, per length.** `ANCHOR_WINDOW` is 100 (`src/indexer.mjs`); the relayer refuses or drops an item whose anchor is below `topHeight − (100 − safety)`.

| | Hourly batch | 10-hour batch |
|---|---|---|
| Anchor S | `S % 6 === 0` | `S % 60 === 0` |
| Release: first flush with indexer height ≥ | S+6 | S+60 |
| Expected landing block | S+7 | S+61 |
| Relayer safety | 24 (`SAFETY_BLOCKS`) | 12 (`BATCH10_SAFETY_BLOCKS`, 1..40) |
| Relayer deadline `lastRelease = S + 100 − safety` | S+76 | S+88 |
| Slack if the relayer stalls at release | 70 blocks | 28 blocks |
| Blocks from release to the end of the anchor window (S+100) | 94 | 40 |
| The wallet calls it overdue from (`OVERDUE_AFTER` 3) | S+9 | S+63 |
| Notes reserved (W-1) until it lands, or until | S+100 | S+100 |
| Longest wait for a send made right after S | about 7 blocks | about 61 blocks |

Example at tip 324,700: hourly S 324,696, release 324,702, relayer deadline 324,772, notes reserved until 324,796; 10-hour S 324,660, release 324,720, relayer deadline 324,748, notes reserved until 324,760.

- **Why 60 blocks and not 72.** Carriers with a large OP_RETURN have confirmed 3 to 29 blocks after broadcast on signet. A release at S+60 leaves 40 blocks for that before the anchor leaves the window at S+100; the 12-hour batch first chosen (72-block epochs, release at S+72) left only 28 (section 9).
- **Why a per-length safety.** Under the shared 24, a 10-hour item released at S+60 would have to be broadcast by S+76: 16 blocks of slack. With 12 it has 28, and a carrier broadcast as late as S+88 still has 12 blocks to confirm before its anchor leaves the window at S+100. `BATCH10_SAFETY_BLOCKS` above 40 is refused at start: the deadline would come before the release.
- **Eligibility and deadline use different heights.** Release eligibility uses the indexer height (the flush trigger); the deadline uses the relayer's `topHeight()`, as `minAnchor` does. Past `lastRelease` the whole epoch expires unbroadcast; items with the same anchor and mode share the deadline, so an epoch never expires in part.
- **The freshness gate is per length.** At submit, step 6 refuses an anchor below `topHeight − (100 − safety)` with the length's own safety (`minAnchor(mode)`), that is, once `lastRelease` has passed. A 10-hour submit at S+59 therefore passes whatever `SAFETY_BLOCKS` is (1..94); only `BATCH10_SAFETY_BLOCKS` (1..40) governs the 10-hour batch.
- **The deadline is the one promised.** Each item keeps the `lastRelease` its 202 carried; a restart with other safety settings does not move it. An epoch shares the earliest `lastRelease` of its waiting items (a later item in that epoch is promised that same block), so it still expires whole.
- **What the user is told.** The 202 body carries `releaseAt` and `lastRelease`; the wallet shows "Scheduled" until `releaseAt`, "Going out with the batch" for 3 blocks, then "Needs attention" (overdue) until `lastRelease`, and offers the next batch or the next block after it (missed). The W-1 date shown is always `anchor + 100`.

**1. Wallet: prove against the boundary.**
- `S = epochStart(view.height, mode)`. The leaves at S are the outputs with `height ≤ S` (`leafCountAt`); the tree at S is `anchorAt(view, S)`, a copy of the view's tree (`MerkleTree.copy()`) truncated to that count, so the live view is never touched.
- The root at S comes from one request, `GET /api/roots?from=max(startHeight−1, h−143)&to=h`. It is the same request for both lengths and for any S in the window (144 ≥ 60), so it does not single out S. The tree at S must match R[S] before proving, and the finished proof is verified against R[S]. The CLI uses its own replayed roots and makes no request.
- Note selection only uses notes with `leafIndex` below the leaf count at S (`maxLeaf`). A note received after S can join the next batch, at S+6 (or S+60). The form says so before proving and offers Next block; at send time the same case is the `NOT_IN_BATCH` error, with nothing recorded.
- `Wallet.transfer` and `buildEnvelope` take an optional `anchor` (from `anchorAt`). Without it, nothing changes.
- `epoch_closed` (the indexer reached `S + E` while proving): one automatic re-prove at the new boundary with the same notes (`inputs` override), so the nullifiers are the same and at most one version can land.

**2. Relayer: modes `"batch"` and `"batch10"`.** `POST /api/relay/submit` takes `mode` (default `"block"`). After the existing freshness step (relayer.md §4.5 step 6), batch items also pass:

| Check | Failure |
|---|---|
| `anchor % E === 0` | 422 `anchor_not_boundary` |
| `idx.height < anchor + E` (the epoch is still open) | 422 `epoch_closed` |
| items queued for this mode and epoch `<` `MAX_BATCH_PER_EPOCH` (40, hourly) or `MAX_BATCH10_PER_EPOCH` (120, 10-hour); a cap of 0 turns that length off (`batch_disabled`) | 503 `batch_full` |
| this IP prefix's items for this epoch `< BATCH_PER_IP` (3, per length), on top of the hourly and daily buckets | 429 `rate_limited` |
| coin capacity for every queued item, and `hotBalance − reserved − estFee ≥ HOT_FLOOR_SATS` (all modes) | 503 `hot_wallet_low` |

- Batch items have their own caps and do not count toward `MAX_QUEUE` or `block_full`, so a batch flood cannot block Next-block users.
- 202 body: `{ id, status: "queued", anchor, deadline: anchor + 100, flush, mode, epochBlocks, releaseAt, lastRelease, epochQueued }`, with `flush` equal to the mode; `epochQueued` is the published count (as of this block) plus this one, never a live count.
- The budget is reserved at acceptance, as today, so a release never runs out of budget halfway.
- Why 120 for the 10-hour cap: a 10-hour epoch spans 10 hourly ones; 3 times (not 10 times) the hourly cap keeps a full 10-hour release (about 71,700 sats at 1 sat/vB) inside one day's 100,000-sat budget with about 28,000 left for Next-block sends, and needs 6 parallel coin chains of 21 carriers. A day holds 2.4 10-hour epochs (144 / 60; 72-block epochs gave exactly 2), so two or three long releases can fall in one UTC day. Two full ones (about 143,300 sats) never fit the budget under either length; the budget is reserved at acceptance, so a later epoch stops taking transfers (`budget_exhausted`) once the day's budget is spoken for.

**3. Release.** `flush()` treats a batch item as eligible once `idx.height ≥ releaseAt`. At that tick every queued item of the epoch goes out in the same cryptographically shuffled pass as the Next-block items, one carrier each, identical in shape to today's carriers. They normally land in block `releaseAt + 1`, so every member of a batch shares its anchor and its landing block. Hourly and 10-hour items with the same anchor S go out at S+6 and S+60 respectively.

**4. Whole-epoch rule.** A batch is released whole or held whole:
- An epoch is held (and retried at the next block, until `lastRelease`) when the fee rate is unknown or above the cap, the carrier fee is above `MAX_FEE_PER_TX`, the day's budget would be exceeded, or the coins can't carry all of it. Next-block items keep today's per-item rules and still go.
- Coins: fan-out is sized for a small hot wallet. `FANOUT_VALUE` is 13,000 (one full chain of 21 carriers at 1 sat/vB); only a coin that one chain cannot use up in a block is split; fan-out runs when release capacity is below `FANOUT_MIN_CARRIERS` (120). A coin worth one to two chains (about 13,500 to 26,500 sats) becomes one 13,000-sat output and its change when that change still funds a carrier: a 25,000-sat top-up gives 40 carriers instead of 21. For example, 4 coins (7,000 confirmed plus 3 x 10,000) fund about 59 carriers without a split.
- Mempool limits: every output of an unconfirmed fan-out, and every chain on them, descends from that one transaction, and Bitcoin Core takes at most 25 transactions in such a family. Capacity therefore counts at most 24 carriers below one unconfirmed fan-out, coin selection stops chaining on it at 24, and a broadcast refused for chain limits (`too-long-mempool-chain`) stays journaled and is resent later without using one of its 3 attempts.
- If something still splits a batch (a carry fails inside a released group, or a miner leaves carriers out), it is logged and never retried out of turn, and the landed line says so (section 6.3). Stage 2 removes this case, because a BATCH lands atomically.

**5. Wallet history.**
- The entry records `mode`, and for batch sends `epochBlocks`, `releaseAt`, `lastRelease` and `epochQueued`. Its status stays `relaying` until it lands or fails, so `lockedNullifiers` (W-1) is unchanged; "Scheduled" is a display of `batchPhase`, not a status.
- Before `releaseAt` the wallet makes no per-transfer call (bulk data only); from `releaseAt` on it polls `/api/relay/status/:id` as today until the bulk nullifier list shows the spends.
- Recovery (`retryChoices`): a missed or failed batch send offers [Retry in the next batch] (re-prove at the current boundary, same notes), [Send at the next block] (the same envelope while its age is at most 70 blocks, else a new proof at the tip with the same notes; its anchor then shows it missed a batch), [Pay the fee myself (links this transfer to your BTC address)] and [Copy envelope hex]. An overdue one offers only the last two: the relayer still holds it and would refuse a relay retry (`nullifier_pending`).

**6. Crowd numbers, honest and checkable.**
- `GET /api/relay/info` gains `batch: { perIp, modes: { batch, batch10 }, recent }`: per length `{ epochBlocks, maxPerEpoch, safety, enabled, current: { start, releaseAt, lastRelease, queued } }`, and `recent` as `[{ mode, start, releaseAt, released, landed: [[height, count], …] }]` (at most 24 epochs per length). `/api/state` gains the `current` summary.
- Before sending, the form shows `current.queued` for the batch it would join, labelled "reported by the relayer", and only when the relayer's current epoch is the wallet's (otherwise no number rather than the wrong one). `current.queued` is the snapshot taken at the relayer's last new block (section 4, item 11), so it does not include transfers submitted since.
- After landing, the activity entry shows the relayer's count for that epoch. **[Audit the relayer]** decodes every carrier's envelope locally (`auditRelayer`, `web/src/relay.js`); it also groups carriers by decoded anchor and landing block (an hourly epoch S counts landings S+7 to S+60 when S is also a 60-boundary and S+7 to S+100 otherwise, a 10-hour epoch from S+61 on) and checks every `recent` count against the chain. Public data can't tell a batch carrier from a Next-block retry that reuses an envelope anchored at a boundary, so such a retry is counted in that hourly epoch and shows as a mismatch.

Why one shared boundary and not random delays: the roadmap item proposed "a randomized older anchor". Random anchors spread users over many anchors and thin every crowd. A shared boundary puts every batch member on the same anchor and the same block, which is the largest set the traffic allows. A second length splits the traffic once more, which is why the 10-hour batch is offered only for people who want the most timing privacy and is not a default.

### 5.2 Stage 1b: network layer and real traffic (no consensus change)

1. **Tor.** The batch copy recommends Tor Browser under both lengths: "The relayer still sees your IP address and when you submitted. Tor Browser hides your IP. Anyone can watch the waiting count, which changes once per block, so with few transfers the block you submitted in can be read from it." A `.onion` endpoint (relayer.md §7.4) is not in scope now (section 9, decision 8); it would be the only measure in this document that helps against the operator as well.
2. **Merge and refresh notes, through the batch.** A self-transfer that merges two notes (a transfer spends at most 2) or re-randomizes a freshly minted note defaults to Hourly batch (`selfModePref`, any mode, remembered). Nobody waits on these, they are real traffic, and they fill batches. Payments stay on Next block (`relayModePref` holds only `block` or `fast`; a batch pick for a payment is never remembered).
3. **Flood limits.** Signet caps: 40 per hourly epoch, 120 per 10-hour epoch, 3 per IP prefix per epoch and length (at most twice that across UTC midnight, when the in-memory buckets reset). Tune from live data; the argon2id PoW option (relayer.md §7.4) later.
4. **Not now:** a two-hop submit (a forwarder that sees the IP but not the envelope). It only helps once a second, independent operator exists.

### 5.3 Stage 2: BATCH op and `expiry` (one consensus release)

Ship once, at a pinned activation height (or with a re-genesis; section 9, still open (7)), bundled with relayer.md §7.1's `expiry` field so signet changes rules only once.

**Format.** One OP_RETURN output. Payload, with pushes of at most 520 bytes concatenated as `opReturnPayload` already does:
`mrk ‖ version ‖ 0x06 ‖ n u8 (2..16) ‖ n verbatim TRANSACT envelopes`.
- Inner envelopes keep their own headers, because `extDataHash` covers them.
- Why one output and not several (the relayer.md §7.1 sketch): nodes before Core v30 reject any second OP_RETURN whatever its size, while a single large OP_RETURN only extends the dependency the 471-byte envelope already has. `findEnvelope` (first `mrk` OP_RETURN) stays as it is.

**Rules.**
1. Before activation, op 6 is an unknown op and rejected, exactly as today.
2. Strict container decode: n outside 2..16, an inner op other than TRANSACT, an inner decode error or trailing bytes make the whole container malformed (one rejected log entry). The poster builds the container, so this cannot hurt anyone else's envelope.
3. Each inner TRANSACT goes through `checkTx` at the block height on its own and is applied in order; later items see earlier items' nullifiers. One bad item never sinks the others.
4. No MINT, MINT_SCRIPT or DEPLOY inside a batch (A-6 binding and the per-transaction treasury sum).
5. Anyone may post a BATCH. No key is recognised, so A-10 holds and replay stays key-independent.
6. Log entries gain `sub` (the item index). From activation, `logAcc = sha256(logAcc ‖ txid ‖ sub u8 ‖ ok u8 ‖ op u8)`: `DIGEST_V` 2, snapshot v3. All replayers upgrade together: the server, the CLI, the browser replay, `src/verify-tx.mjs` and `web/src/share/live-check.js`. `murkle audit --compare` catches any that lag.
7. `expiry u32` in every proof-carrying body (inside `extDataHash`, no circuit change), with `height ≤ expiry ≤ anchor+100`. Wallets use **one uniform value**: `anchor+18` if only the hourly batch exists, larger if a longer mode is ever offered (section 9, decision 2). A per-mode expiry would reveal the mode.

**Relayer.** One BATCH per released epoch, in chunks of 16, journaled before broadcast. If the node refuses it for policy and the explorer confirms the txid is unknown (the existing "Explorer errors" rule), the same envelopes fall back to single carriers. A batch is never grown by RBF, since each replacement would timestamp when each envelope joined. Reconcile by `(txid, sub)`; `relayed144` counts inner items. Self-carry stays single-envelope.

**Prerequisite.** An approved live signet test that a 2-envelope (about 1 kB) and a 16-envelope (about 7.6 kB) BATCH are accepted by the broadcast path and mined. Without it, stage 2 does not ship.

### 5.4 Stage 3: mainnet payment (consensus change, already planned)

- **Blind tickets** (relayer.md §7.2, Design 3): the user buys tickets in advance, from their own wallet, and spends one per send. The relayer pays the carrier. The payment cannot be linked to the transfer. This is the form of "the user pays" that does not leak.
- **Price per timing class** (section 9, still open (8)): if classes are priced differently, the prices are fixed per epoch and published in the on-chain RELAYER announcement. The batch can honestly be the cheapest: it shares bytes (stage 2) and the relayer can pick a cheap block within the hour.
- **Rejected:** per-send BTC payments by the user (they relink the address). A fee note inside the proof waits for circuit v1 (roadmap); it would show the relayer the token and the fee.

### 5.5 Stage 4, optional: hosted guests (variant b, done safely)

Built on the stage 2 rule. A wallet that pays its own fee with the built-in key may post a BATCH with its own TRANSACT first and up to 15 guest envelopes, leased from the relayer **at release time only** (an earlier public pool would publish submit times).
- What it buys: "this address paid a Murkle carrier" stops meaning "this address wrote that transfer", and carriage no longer rests on one relayer.
- Limits: not for Unisat; never on MINT or DEPLOY carriers; the lease prevents duplicate carriage; on mainnet hosts are paid in tickets; the coordinator (the relayer) still sees guest IPs.

### 5.6 Not built, at any stage

- A user-paid encrypted submission transaction.
- Payloads only the operator can decrypt, or balance diffs posted by a master key.
- Piggybacking on random users' transactions without the stage 2 rule and a lease.
- Batches grown by RBF.
- Decoy traffic made by the operator.

## 6. Toggle UX and honest copy

### 6.1 The control

The existing "Relay timing" control on Send (`web/src/views/app-send.js`, `timingControl`) gets a third stop, "Batch", and a length choice under it. It is the speed/privacy control the proposal asked for:

```
Relay timing   [ Fast (~1 min) | Next block | Batch ]
               [ Hourly batch | 10-hour batch ]        (only under Batch, small)
```

| Option | Lands | Default for |
|---|---|---|
| Fast (~1 min) | about a minute, on its own | nothing |
| Next block | the next block, with that block's other transfers | payments |
| Batch, Hourly batch | the block after the next 6-block boundary: usually within an hour, at most about two | merges and refreshes |
| Batch, 10-hour batch | the block after the next 60-block boundary: usually within 10 hours, at most about 15 | nothing |

- Both rows are radiogroups ("Relay timing", "Batch length") with arrow keys and a roving tabindex (`ui/behaviors.js`), and a `<select>` below 360 px. They sit in a column (`.mode-row`: `flex-direction: column; align-items: flex-start`), and at 375 px the three stops take about 290 px of the 343 px column.
- Self-paid routes hide the whole control, as today. Batch is relay-only. Unisat users get it too: the relay path does not use Unisat.
- Until the user touches the control, a change of recipient re-applies the default (so Merge notes, or typing your own address, switches to Hourly batch). A touched control stays.
- While a batch is selected, the form reloads relay info at most once per new block, for the crowd line. Settings does the same for its "Hourly batch now" and "10-hour batch now" rows.
- Merge notes sets the typed payment aside with its own timing; the merge starts on the self-transfer default, and a pick made for it never carries over to the payment when it comes back.
- The "Privacy of this send" hint grades the notes a batch send would really spend (those in the tree at S).
- "Send with the next block" (offered under the control) moves keyboard focus to the Next block stop and announces the change, since the line it sat in is repainted without it.
- Before proving, the form checks what the relayer reports: a length it is not taking, or a full batch, blocks the Send button with the relayer's own sentence and offers Next block; so does a note newer than the boundary.

### 6.2 Defaults

- **Payments stay on Next block.** Recipients and payment links must not silently wait an hour, or 10. A payment's Fast or Next block pick is remembered; a batch pick for a payment is not.
- **Merge and refresh self-transfers default to Hourly batch** (stage 1b); a self-transfer's pick, a batch length included, is remembered.
- **Nudge:** when a note's tier is Exposed or Weak because of timing (`web/src/privacy.js`), the advice for a relayed Next-block or Fast send adds: "Or send it with the hourly batch: it lands together with the other hourly-batch transfers from that hour." The tier itself does not improve automatically, because a thin batch hides little.

### 6.3 Copy

Every batch string lives in one place, `BATCH_TEXT` in `web/src/views/app-shared.js` (contract §5.2); numbers are shown with thousands separators and waits as "about N min / N h". The main lines:

| Where | Text |
|---|---|
| Caption, hourly | "Hourly batch waits for the next batch. People watching Bitcoin see it land together with the other hourly-batch transfers from that hour, not when you pressed Send." |
| Caption, 10-hour | "10-hour batch waits for the next 10-hour batch. People watching Bitcoin see it land together with the other 10-hour-batch transfers from those 10 hours, not when you pressed Send. Use it only when the recipient can wait." |
| Tor line (both) | "The relayer still sees your IP address and when you submitted. Tor Browser hides your IP. Anyone can watch the waiting count, which changes once per block, so with few transfers the block you submitted in can be read from it." |
| Crowd line | "Waiting for this batch: N (reported by the relayer)." |
| Thin batch, N < 3 | "Few transfers are waiting for this batch. With so few, it hides little." |
| 10-hour only | "Your notes stay reserved until it lands, about 10 hours, or until block D (about N h) if it never does." / "The 10-hour batch is a separate crowd: it lands about 10 hours after its anchor block, so it only hides among other 10-hour transfers, and there are fewer of those than in the hourly batches." / "If the relayer stalls, it has until block L to send it. After that it won't, and Activity offers other ways to send it." |
| Self-transfer | "Merges and refreshes go with the hourly batch by default: nobody waits for them, and they add real transfers to the batch." |
| Note too new | "The note this send needs arrived after block S, so it can join the batch that starts at block S+E (about N min). Or send it with the next block now." plus [Send with the next block] |
| Review row "Time" | "With the hourly batch after block X (about N min)" / "With the 10-hour batch after block X (about N h)" |
| After submit | "Scheduled. It goes out with the batch after block X. Your notes stay reserved until it lands, or until block Y at the latest." |
| Recipient wait | "The recipient sees it when it lands: usually within an hour, at most about two." / "…usually within 10 hours, at most about 15." |
| Cannot cancel | "A scheduled transfer can't be cancelled: the relayer holds it, and anyone holding it could still carry it." |
| Activity chips | "Scheduled", "Going out with the batch", "Needs attention"; the Failed filter and the portfolio's "need attention" callout include overdue and missed batch sends |
| Activity, overdue | "The batch after block X should have gone out by now. The relayer has until block L to send it. You can pay the fee yourself or copy the envelope; your notes stay reserved until it lands, or until block Y." |
| Activity, missed | "The relayer did not send it by block L. Retry in the next batch, send at the next block, or pay the fee yourself. Same notes, so it can't pay twice." Also shown, instead of the relayer's raw reason, once the relayer reports the batch expired past L. |
| Landed | "Landed in block B. The relayer reports K transfers in this batch, yours included. Check it with Audit the relayer." |
| Landed, thin | "Few transfers were in this batch. With so few, it hid little." |
| Landed, split | "Landed one block after the rest of its batch, so its timing stands out." (or "N blocks") |
| Settings | "Hourly batch now" / "10-hour batch now": "N waiting · goes out after block X"; table "Recent batches"; "Counts are reported by the relayer. Audit the relayer checks them against Bitcoin."; audit "Batch sizes match Bitcoin: M/T" with each mismatch |
| Network activity | adds "Scheduled batch transfers are not looked up until their batch goes out." |

Every existing disclosure stays: signet with no value, the DEV setup (A-8), mempool.space without PoW checks (A-9), mints are public, the relayer sees IP and timing, a small anonymity set.

### 6.4 Never say

"Level 2", "level 2 protection", "mixer", "mix", "blend", "ghost mode", "anonymous", "untraceable", "fully anonymous", "the relayer learns nothing", any percentage, or "N users" (count transfers, not people). `test/english.test.mjs` already bans the worst of these in `web/`.

### 6.5 Adjacent: funding advice

The proposal also suggested telling users to fund the built-in wallet from an exchange "for more anonymity". The deposit sheet (`web/src/views/deposit.js`, `ADVICE` and `SIGNET_NOTE`) already says the honest version: fund it from a source not linked to your main wallet, for example an exchange withdrawal, and the exchange itself knows where it sent the coins; on signet, use a faucet. Keep that wording. Do not promise anonymity: since Ghost Relay pays private sends, this key only pays mints and launches, which are public anyway.

## 7. Fees and relayer economics

### 7.1 Signet (free, capped; retired 2026-10-03)

The free tier described here is retired: a capped subsidy is still a subsidy anyone can drain, so there is no free relaying of any kind (`paid-relay.md` §1, §12). Kept as the record of what ran until then.

- Batch items spend the same daily budget (live cap 100,000 sats, about 167 carriers at 1 sat/vB) and are reserved at acceptance.
- A full hourly batch of 40 costs about 24,000 sats at 1 sat/vB, a full 10-hour batch of 120 about 71,700. The free relayer's hot wallet was small (a few tens of thousands of signet sats, about 59 carriers of chain capacity without a fan-out). The hot-wallet gate stopped acceptance before the wallet could run dry, and the fan-out (section 5.1, step 4) only split coins once one chain could not use them up.
- The free tier stays a capped subsidy that anyone can exhaust (relayer.md §3).

### 7.2 Carrier sizes

| Carrier | vB | Per transfer | Saving |
|---|---|---|---|
| Single carrier (today): 10.5 overhead + 57.5 P2TR input + 43 change + 486 OP_RETURN | 597 | 597 | — |
| BATCH, 2 envelopes | 1,077 | 539 | 10% |
| BATCH, 4 envelopes | 2,025 | 506 | 15% |
| BATCH, 8 envelopes | 3,920 | 490 | 18% |
| BATCH, 16 envelopes | 7,710 | 482 | 19% |

The 471-byte envelope dominates, so the saving is modest. A witness-based carrier (commit/reveal, envelope at a quarter of the weight) could reach about 136 vB per transfer, but it is a larger consensus change and meets inscription filters; it is not proposed here.

### 7.3 Mainnet

- The relayer always pays carriers in BTC and recovers costs through blind tickets (5.4). On mainnet the free lane becomes an optional, exhaustible marketing budget or is turned off (relayer.md §7.2).
- Sponsor packs ("gas drops", relayer.md §7.2): the sponsoring team can see when its tickets are spent, and the UI says so.
- Legal review before operating a mainnet relayer that delays and batches transfers (relayer.md §7.7). Avoid mixer naming.

## 8. Failure modes

| What happens | Effect | User sees | Mitigation |
|---|---|---|---|
| Relayer down or stalled during the hold | Nothing lands | "Scheduled", then "Going out with the batch", then "Needs attention" from `releaseAt + 3` | Until `lastRelease` (S+76 hourly, S+88 10-hour): pay the fee yourself or copy the envelope. After it: retry in the next batch, send at the next block, or pay yourself (5.1 step 5). W-1 keeps the notes reserved until S+100 in both cases. |
| 10-hour batch and a relayer stall | 28 blocks of slack between release and deadline | Same, after about 10 hours | Its own safety (12, not 24); the form says up front how long the relayer has ("If the relayer stalls, it has until block L…"). |
| A carrier confirms slowly (large OP_RETURNs took 3 to 29 blocks on signet) | It may land well after its batch, or not before S+100 | "Going out with the batch" for longer; past S+100 the transfer fails and the notes come free (W-1) | Release at S+60 leaves 40 blocks before S+100 (the 12-hour batch left 28); a deadline release at S+88 still leaves 12. |
| Relayer restarts | None | Nothing | Items are persisted with `mode`, `releaseAt` and `lastRelease` in `relayer.json` (recomputed from the anchor if missing); they keep waiting, and keep the `lastRelease` they were promised even if the safety settings changed. Tested. |
| Boundary block S reorganised | R[S] changes; proofs may fail | "Needs attention" with the reason | The existing precheck re-verifies; a dropped item is retried in the next batch with the same notes. |
| Boundary block S reorganised, its transactions mined again a block later | The tip root is unchanged, so the wallet's incremental sync keeps the old output heights and its tree at S counts the wrong leaves | Nothing | The wallet's check against R[S] fails, it rebuilds its view from scratch once and proves again; only a second mismatch is shown. |
| Fees above the cap at release (mainnet) | The whole epoch waits | "Scheduled", then "Going out with the batch" a little longer | Whole-epoch hold; past `lastRelease` the epoch expires whole, never part of a batch. |
| Not enough coins for the burst | The epoch waits whole | Same | Accept gate counts coin capacity; fan-out sized for a small wallet (13,000-sat coins, 21-carrier chains); stage 2 lands atomically. |
| A fan-out still unconfirmed at release | Core takes at most 24 descendants of it | Nothing | Capacity and coin selection count at most 24 carriers below an unconfirmed fan-out, so the accept gate and the whole-epoch check never plan more; a chain-limit refusal is resent later without using an attempt. |
| A carry fails inside a released epoch, or a miner leaves carriers out | A split batch | "Landed one block after the rest of its batch…" | Logged, never retried out of turn; stage 2. |
| Tip reaches the boundary while proving | 422 `epoch_closed` | Nothing; it proves again | One automatic re-prove at the new boundary, same notes. |
| Note newer than S | Not eligible | "Can join the batch that starts at block S+E", the Send button waits | Offer Next block. |
| Batch full, or a length turned off (cap 0) | 503 `batch_full` / `batch_disabled` | Said on the form before proving, from the relayer's report | Offer Next block, or the next batch. |
| The relayer reports another epoch than the wallet's | The count would be wrong | No crowd number | Shown again once both agree. |
| Thin batch (k = 1) | Hides little: Bitcoin shows only the batch, but the relayer's public count shows the block you submitted in | The thin-batch line, before and after; the Tor line names the public count | Shown before and after; the 10-hour crowd line says it is thinner. |
| Anyone polls the relayer's waiting count | Learns the block each batch transfer was submitted in, not the minute | The Tor line says so | Published once per block as a snapshot, never live (section 4, item 11). |
| Flood: one actor fills the epoch (n−1) | k is effectively 1 for the target | Nothing visible | Per-epoch and per-IP caps for each length, PoW; disclosure. On mainnet each slot costs a ticket. |
| Budget runs out mid-epoch | New submits refused | `budget_exhausted` | Reservation at acceptance guarantees the queued release. |
| Relayer compromised while holding | Live attacker links IP to envelope for the queued hour (10 hours for the 10-hour batch) | Nothing | No IP storage; Tor Browser; a `.onion` endpoint later. |
| Stage 2: node refuses the BATCH | Delay | Nothing | Single-carrier fallback after the explorer confirms the txid is unknown. |
| Stage 2: a replayer not upgraded | Digest mismatch from activation | "Indexers disagree" | `murkle audit --compare`; lockstep release. |

## 9. Decisions (final, 2026-10-02)

The interfaces for stage 1 and 1b are in `docs/design/batch-contract.md`; where it and this document differ, that file wins.

1. **Build stage 1 now:** batch relay timing with no consensus change and no circuit change.
2. **Two batch lengths** in the "Relay timing" control: **"Hourly batch"** (6 blocks; epochs start at heights divisible by 6) and **"10-hour batch"** (60 blocks; epochs start at heights divisible by 60; amended 2026-10-03, see below) for people who want the most timing privacy. Epoch lengths are fixed protocol-wide constants, not relayer settings, so every wallet computes the same boundary.
   - 10-hour consequences, all disclosed in the UI: notes stay reserved for up to about 17 hours (W-1, until anchor+100); the batch lands at S+61 while an hourly batch with the same anchor lands at S+7, so the two lengths are separate crowds and the 10-hour crowd is thinner; the relayer must send it by S+88.
   - Relayer deadline per length: `lastRelease = anchor + 100 − safety`, safety 24 for the hourly batch (S+76) and 12 for the 10-hour batch (S+88), so a stalled relayer has 28 blocks of slack instead of 16. Past it the whole epoch expires unbroadcast.
   - Stage 2 note: a uniform `expiry` must then cover the 10-hour deadline plus confirmation time, about anchor+100, so `expiry` would no longer shorten the W-1 lock. Revisit when stage 2 is planned.
3. **Names:** "Hourly batch" and "10-hour batch". Never "Level 2", "mixer", "mix", "blend", "ghost mode", "anonymous", "untraceable", percentages, or "N users" (count transfers).
4. **Defaults:** payments on Next block; note merges and refreshes on the Hourly batch (stage 1b). A batch choice for a payment is not remembered.
5. **Signet caps:** `MAX_BATCH_PER_EPOCH` 40 (hourly), `MAX_BATCH10_PER_EPOCH` 120 (10-hour: a full release, about 71,700 sats at 1 sat/vB, fit the retired free relayer's 100,000-sat daily budget with room left for Next-block sends), `BATCH_PER_IP` 3 per epoch for each length.
6. **Live count before sending:** shown, as "Waiting for this batch: N (reported by the relayer)".
7. **Funding:** the relayer's coins were few (the free relayer of the time held a few tens of thousands of signet sats), about 600 sats per carrier at 1 sat/vB. Fan-out defaults are sized for a small wallet: `FANOUT_VALUE` 13,000 (one full chain of 21 carriers), a split only of a coin one chain cannot use up in a block, triggered when release capacity is below 120 carriers. For example, 4 coins of 7,000 + 3 x 10,000 fund about 59 carriers without a split; the hot-wallet gate (balance minus reservations) stopped acceptance before the wallet could run dry.
8. **Stage 1b in scope:** the Tor Browser recommendation copy and the merge/refresh defaults. A `.onion` endpoint is not in scope now.
9. **CLI:** relayed sends with `murkle send <w> <ticker> <amount> <mrk1…> --relay [--fast | --batch | --batch10]` (default timing: next block). It waits and reports, so an operator can run a live end-to-end test without a browser wallet.

**Amended 2026-10-03: the long batch is 10 hours, not 12.** Decision 2 first chose a "12-hour batch": 72-block epochs at heights divisible by 72 (mode id `"batch12"`, CLI flag `--batch12`), released at S+72. A live signet test then showed carriers with large OP_RETURNs confirming 3 to 29 blocks after broadcast. With 72-block epochs only 28 blocks remained between the release (S+72) and the end of the anchor window (S+100), so one slow confirmation could leave a whole batch outside the window. It was replaced with the "10-hour batch": 60-block epochs starting at heights divisible by 60 (mode id `"batch10"`, CLI flag `--batch10`), released at S+60, which leaves 40 blocks. Unchanged: the relayer safety of the long length stays 12 (deadline S+88, now 28 blocks of stall slack; `BATCH10_SAFETY_BLOCKS` from 1 to 40), the cap stays 120 per epoch, and the disclosures stay (a separate and thinner crowd, notes reserved until S+100, about 17 hours, the relayer sees IP and timing, the Tor line). Nothing was queued in the 12-hour mode on signet: the relayer refuses `"batch12"` as `malformed` (an item an older relayer had already queued in it would keep its saved release S+72 and deadline, never going out with the next block), the `MURKLE_*_BATCH12_*` variables are no longer read, and a wallet reads a saved `"batch12"` as the 10-hour batch where it chooses a timing (the self-transfer preference, and the retry of a history or CLI pending entry).

Still open: stage 2 format, maximum n and the live broadcast test (former decision 6); stage 2 activation and the uniform `expiry` value (7); mainnet pricing per timing class (8); cover traffic stays as recommended, no operator decoys and no wallet cover until tickets exist (9); hosted guests (10); when to operate a `.onion` endpoint (11).

## 10. Implementation plan

### 10.1 Stage 1 files

Stage 1 touched these files (interfaces in `docs/design/batch-contract.md`):

| File | Change |
|---|---|
| `src/relay-batch.mjs` (new) | Mode ids, `EPOCH_BLOCKS` { batch: 6, batch10: 60 }, `DEFAULT_SAFETY` { 24, 12 }, `DEFAULT_CAPS` { 40, 120 }, `OVERDUE_AFTER`, `epochStart`, `releaseHeight`, `lastReleaseHeight`, `leafCountAt`, `batchSchedule`, `savedMode` (a saved `"batch12"` reads as `"batch10"`). Shared by server, wallet, CLI and tests. |
| `src/core.mjs` | `MerkleTree.copy()`; `truncate` returns `this`. Not consensus. |
| `src/wallet.mjs` | `anchorAt(view, height)`; `transfer` and `buildEnvelope` take an optional `anchor`; `spendable`, `maxSendable`, `selectNotes` and `notesFor` take `maxLeaf` (`NOTE_TOO_NEW`). Defaults unchanged. |
| `server/relayer.mjs` | Modes `batch` and `batch10`; the step 6b checks and their codes; per-length caps, per-IP epoch buckets, per-length safety; whole-epoch release and hold; coin capacity; fan-out sized for a small wallet; `info().batch`, `batchSummary()`. |
| `server/indexer-server.mjs` | The new config; `/api/state` relay `batch`. |
| `web/src/session.js` | `batchPlan`, `defaultMode`, `relayModePref`, `selfModePref`; batch `send` (boundary anchor, root check against R[S], `NOT_IN_BATCH`, one re-prove on `epoch_closed`); entry fields; no status poll before `releaseAt`; `batchPhase`, `retryChoices`, batch `retry`. |
| `web/src/relay.js`, `payers.js`, `api.js`, `privacy.js` | Submit with `mode`; the new refusal texts; `auditRelayer` batch check; `carry` returns the batch fields; `ApiError` keeps the extras; the hourly-batch nudge. |
| `web/src/views/app-send.js` | The control (three stops plus the length), defaults that follow the recipient, the lines under it, the review row Time, the after-submit sheet. |
| `web/src/views/app-activity.js` | Chips and lines per phase, landed with the relayer's count (thin, split), the recovery buttons. |
| `web/src/views/app-settings.js` | "Batches" in Proof of sponsorship (now, Recent batches), the audit batch line, the Network activity note. |
| `web/src/views/app-shared.js` | `BATCH_TEXT` (every batch string), batch-aware `statusChip`, the `.mode-row` layout. |
| `bin/murkle.mjs`, `README.md` | `murkle send … --relay` with `--fast`, `--batch` or `--batch10`, `murkle pending`, `murkle retry`; waits and reports. |
| `docs/design/relayer.md`, `SPEC.md` §14 | Modes, codes, release and fan-out; a short non-consensus section on relay timing. |

### 10.2 Stage 1 tests

One test file per area, with the synthetic-block harness and `FakeEsplora` (`test/relayer.test.mjs`), low PoW bits, and fake storage, a fake DOM and a fake indexer for the wallet. No browser wallets, nothing broadcast.
1. `test/batch-core.test.mjs`: epoch arithmetic at the edges for both lengths, `leafCountAt`, `MerkleTree.copy`, `anchorAt`, `maxLeaf` selection, and real proofs anchored at an hourly S (accepted at S+7) and at a 60-boundary (accepted at S+61 and S+100, refused at S+101).
2. `test/batch-relayer.test.mjs`: every new code with its status and extras for both lengths; caps independent of `MAX_QUEUE`; no broadcast before `releaseAt`, whole-epoch release with the Next-block items; hourly at S+6 and 10-hour at S+60 for the same S; whole-epoch fee, budget and coin holds; expiry past S+76 and S+88; restart; reorg of S; `info().batch`; fan-out with today's coins; no IP in any response or file.
3. `test/batch-session.test.mjs`: `batchPlan`, the one roots request, `NOT_IN_BATCH`, `epoch_closed`, W-1 locks, no status call before `releaseAt`, `batchPhase` and `retryChoices`, defaults and preferences, the audit's batch check, the nudge.
4. `test/batch-cli.test.mjs`: flags, relayed sends against an in-process relayer, the pending entry written before the submit, waiting and exit codes, `retry` with the same nullifiers.
5. `test/batch-views.test.mjs`: the control and its defaults, every `BATCH_TEXT` line in its state for both lengths, the Activity phases and buttons, the Settings block and audit line, no never-words, no percentages and no counts of people; `english.test.mjs` passes.

### 10.3 Stage 2 files (one consensus release)

`src/envelope.mjs` (encode and strict decode of op 6), `src/indexer.mjs` (activation, ordered inner apply, `sub`, `logAcc`, `expiry` rule), `src/params.mjs` (`DIGEST_V` 2, `SNAPSHOT_VERSION` 3), `src/pins.json` (activation height, in that release only), `src/verify-tx.mjs`, `web/src/share/live-check.js`, the browser replay in `web/src/verify/`, `src/btc/funding.mjs` (a batch carrier plan), `server/relayer.mjs` (one BATCH per epoch, fallback), `web/src/relay.js` (audit accepts BATCH carriers), `SPEC.md` §5–§12, `audit/REPORT.md` (a new invariant: inner items are independent), and tests for strict decoding, independent verdicts, digest v2 and resync.

### 10.4 Effort

- Stage 1 and 1b: built (`batch-contract.md`); `.onion` is operations, not in scope now.
- Stage 2: about 2–3 days plus the live test and a review of the new rules, best done together with `expiry`.
- Stage 3: as relayer.md §7.2 (about 30 hours plus audit).

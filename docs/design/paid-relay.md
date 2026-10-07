Superseded by relay-balance.md (2026-10-03). **Status: rejected design, not built** (only stage 0, section 15.1, which retired the free relayer, shipped). The ticket design below was rejected because it forced scheduled sweeps and random holds (a new buyer waited 3 to 8 hours). What is built instead is the prepaid relay balance of `docs/design/relay-balance.md`, with the binding interfaces in `docs/design/relay-balance-contract.md`: the user tops up a balance with a plain BTC payment, waits one deposit confirmation, and each relayed send is charged its exact carrier fee plus a margin. The rules of section 1 still hold (no free mode; the operator never pays any part of a user's transaction). The body is kept unchanged as the record of the rejected design; where it and `relay-balance-contract.md` differ, the contract wins.

**Paid relay decision and implementation spec: prepaid relay tickets (Murkle, signet now, then mainnet)**

Status: recommended design, revision 2 (2026-10-03). Revision 1 was written after the free relayer was switched off; an internal adversarial review then reported 37 findings against it (section 16). All 37 are real or spec gaps, and revision 2 closes each one, mostly by making the design smaller: no orders before payment, no per-item status calls, no top-ups, no carrier chains, no coins found by address, one ticket count for every mode, and every issuance published once per block.

This file replaces the sponsored ("free, capped") relayer of `relayer.md` §1, §3 (the free-tier lines), §4.2 (budget and PoW variables), §4.3 (PoW), §4.6 (the broadcast-failure, coin-selection and fan-out rules named in 15.2) and §7.2, and `privacy-level2.md` §5.4, §7.1 and §7.3. The rest of `relayer.md` §4 (submit pipeline, journaling, reorg handling, W-1) and all of `batch-contract.md` stay in force except where this file says otherwise (section 10 lists the batch changes). No consensus change and no circuit change at any stage.

## 1. The rule

1. **There is no free mode.** No free lane, no daily budget, no sponsored quota, no faucet tickets, no admin grant, no "first send free", no marketing budget. A relayer carries an envelope only when the person who submitted it has already paid, in BTC confirmed on chain, for the full fee of every version of that carrier.
2. **The operator never pays for a user's transaction**, not even partly or for a moment: not through fee spikes, failed or rejected carriers, reorgs, rounding, refunds, races, crashes or bugs.
3. These are enforced by construction (section 2), not by limits. Caps and per-IP buckets cannot meet this rule: they only cap the loss and turn it into a denial of service. Those that survive are liveness hygiene and never protect money.

Why the free relayer had to go: it paid every carrier from the operator's own BTC. Zero-value transfers are valid (an input with `inAmount = 0` skips the Merkle check, `circuits/lib.circom` `ForceEqualIfEnabled`), so an attacker needs no tokens, only CPU for proofs, to make it pay without end.

## 2. The invariant and how the code enforces it

### 2.1 Notation

| Symbol | Meaning |
|---|---|
| `U` | face value of one ticket, in sats of carrier fee. **One constant per network, never changed** (signet 200, mainnet 1,000). |
| `P` | price of one ticket, set per key period (signet 220); `m = P − U` is the margin |
| `capRate` | the period's fee-rate cap for sweeps (signet 2 sat/vB) |
| `c_in` | sweep-input charge per credited payment output: `⌈57.5 × capRate⌉` (signet 115) |
| `K` | confirmations before a payment output may be claimed, and again before a sweep's tickets are released (signet 2) |
| `M` | age in blocks before a pool coin may fund a carrier (6) |
| `R` | receipts: value of credited invoice outputs whose sweep has `K` confirmations |
| `L` | ticket liability: issued, unspent, unlapsed tickets × `U` |
| `E` | escrow: Σ over open items of `credit(i)` (the whole credit, until the item is final) |
| `O` | overhead account: sweep overhead only; funded from margin up to a target `O_max` |
| `Q` | reserve: margin, sub-ticket remainders and cancellation fees not yet matured |
| `I` | income: `Q` entries matured (100 confirmations of the sweep that produced them), minus withdrawals |
| `F` | miner fees of every confirmed transaction signed by the pool or invoice keys |
| `W` | income withdrawn to the operator's pinned cold address |
| `B` | face value of provenance coins (I0): confirmed, unspent, journaled |

Bookkeeping identity, rebuilt from the journal on every load: `R = L + E + O + Q + I + F + W`, and `B + B_pending = R − F − W`, where `B_pending` is the pool value locked in signed but unconfirmed transactions, counted at their worst version (the smallest pool output).

### 2.2 The invariant (audit R-3, "I-PAY")

> Every satoshi the relayer's software spends as a miner fee comes out of BTC that users paid in, that was claimed by its payer, and whose sweep into the pool had `K` confirmations before any ticket backed by it existed. A carrier's fee comes only out of the credit handed in for that same item, and every signed version of that carrier, including a cancelling one, spends the same single coin and fits inside that credit. Every other fee (a sweep) comes only out of the per-output sweep charges and the overhead account, which only margin funds. No operator money is ever in a wallet the relayer can sign from, and nothing is ever booked against the operator's matured income. In numbers: `F ≤ R − W` always, every account in 2.1 stays `≥ 0`, and no single signature is released for a fee its paying account does not already cover.

Two independent walls enforce it. Either one alone keeps the operator's money safe.

- **Wall 1, provenance (I0):** the pool and invoice keys hold only user money, found only through the journal. There is no operator float, so a bug has no operator money to spend.
- **Wall 2, coverage (I1 to I8):** every signature is checked against the account that pays for it, from the exact bytes being signed, and journaled before it is released; a signed transaction stays a debt of its item until the coin it spends is settled 6 blocks deep.

### 2.3 Rules and where they live

All signing goes through one function, `signCovered(tx, purpose)` in `server/ledger.mjs`. All ticket consumption goes through `spendSerials(keyId, serials, effect)` and all issuance through `issue(keyId, blinded, cause)`, both in the same module, under one ledger mutex. No other code holds the pool key, the invoice key, the ticket key or the spent-serial set. Before mainnet the module moves into a separate signer process (stage 3).

**I0. Provenance: no operator money, no coin found by address.**
- The relayer never asks an explorer "what coins does this address hold". Its coin set is built only from the journal: invoice outpoints credited by `txid:vout` (6.3), and outputs of its own journaled transactions. Each one is checked by outpoint (`/tx/:txid/outspend/:vout`, `/tx/:txid/status`, or the operator's own node).
- Every pool output (sweep outputs, carrier change, cancel outputs) goes to a fresh key `poolPub + t·G` with `t = taggedHash("murkle/pool", poolPub ‖ counter)`, the counter journaled. There is no static pool address and none is published.
- Anything else sent to any key of ours (an operator top-up, a stray payment, a dust flood) is invisible: never looked up, never selected, never counted, never returned. A dust flood therefore cannot break coin discovery, capacity or reconcile.
- There is no "fund", "top up" or "float" command. Before the first sale the relayer can carry nothing, and that is correct.
- The paid relayer generates new keys and refuses to start if any equals the retired free relayer key (section 12).

**I1. Issuance only against money received, claimed and swept.**
- Credit is per payment output, never per address: an output of value `v` to a valid invoice address credits `n = min(400, floor((v − c_in) / P))` tickets, and only if `v ≥ c_in + P`. The rest of `v − c_in − n × P` goes to `Q`. A smaller output is not credited (it stays where it is; 6.2).
- Each outpoint can be credited once, ever: a permanent credited-outpoint set (36 bytes per entry, kept forever, never pruned). The invoice key is per period and the claim must name an output confirmed at or after that period's announcement height, so an old payment can never be presented again under a new order or a new period.
- Claims are authenticated by a BIP340 signature of the order key (6.3). The outpoint is reserved **synchronously** in the ledger's reservation table before any `await`; a second claim of the same outpoint is refused while the first is pending or after it succeeded (an identical retry returns the same 202).
- Evaluations are released only after the sweep that spends that outpoint has `K` confirmations, and only inside a per-block snapshot (6.5), never in an HTTP response.
- Before releasing a snapshot the ledger checks, per key: `issued_k ≤ paid_k + change_k + swappedIn_k` (all in units of `U`). A breach halts issuance.
- No endpoint issues a ticket without a payment. Change (I6) and swaps (6.10) re-issue value already paid; they never create it.

**I2. A serial is redeemed at most once.**
- `spendSerials` is the only writer of the spent set. It checks and reserves every `(keyId, serial)` synchronously in one shared in-memory table before any `await`, and commits the spend in the same durable write (tmp file, fsync, rename, directory fsync) as its effect: the new item (submit) or the queued swap (6.10). Submit and swap both call it; there is no third consumer (top-ups are gone, 5.4).
- A crash can never leave an accepted item without spent tickets, or spent tickets without an item. A journal replay that meets a duplicate serial halts.
- Every request carries tickets of exactly one `keyId` (`ticket_mixed` otherwise).

**I3. One coin per item, every version covered.**
- At its first signature an item is bound to exactly one pool coin (its outpoint), durably, for its whole life. It never moves to another coin.
- Every version signed for the item spends that outpoint and nothing else: the carrier, a uniform fee bump (stage 3), or a cancel (I4). `signCovered` refuses any version whose `fee = Σ inputs − Σ outputs` (from the bytes being signed) exceeds `credit(i)`. Versions conflict, so at most one confirms, and the item's cost is at most its largest version fee, which is at most its credit.
- Carrier template: 1 input (the bound outpoint), `output[0]` = OP_RETURN with this item's stored envelope, `output[1]` = change of at least 330 sats to a fresh pool key. Cancel template: 1 input (the bound outpoint), 1 output to a fresh pool key. A change that would be dust is refused, never folded into the fee.
- The bound coin must be confirmed at least `M` blocks deep when first bound, and of value `≥ credit(i) + 330`, so every version fits. **No carrier ever spends unconfirmed change**, so no carrier has an unconfirmed ancestor or descendant of another item, and there is no CPFP of any kind.
- Each version is journaled durably (item, version number, outpoint, fee, raw bytes) as a **signature record** before the signature leaves `signCovered`. A resend of identical bytes signs nothing.
- `maxFeePerTx` stays as a sanity cap on top.

**I4. A signed transaction is a live debt until its coin is settled.**
- Once any version exists, the item's raw bytes, credit and coin reservation are kept until the bound outpoint is spent by a confirmed transaction at least 6 blocks deep. Nothing deletes them earlier: not a broadcast error, a missing-inputs answer, an explorer 404, a retry limit, the anchor window or a restart.
- An item whose carrier cannot be sent (refused for min fee, evicted, 404) becomes **pending-dead**: still journaled, still reserved, still escrowed. It may only be revived by a version on the same outpoint.
- After `anchor + 100` (the envelope can no longer be accepted), a pending-dead or unconfirmed item gets a **cancel version**: the bound coin back to a fresh pool key, at the current rate, with `fee ≤ credit(i)`. If a node still holds the carrier and refuses the cancel, the relayer retries each block; either the carrier confirms (its fee was always covered) or the cancel does.
- Settlement: whichever version is confirmed 6 deep fixes the item's cost (that version's fee). A spend of the outpoint by a transaction not in the journal halts the ledger (I8).
- "No version was ever signed" is a durable journal fact (no signature record exists), never inferred from item fields.

**I5. Settlement and change.**
- Cost of an item:
  - a version settled 6 deep: that version's fee;
  - no signature record, and the item ended for a relayer-side reason (epoch held to `lastRelease`, relayer halted or stalled, uncovered until its deadline): 0;
  - no signature record, and the item's nullifiers were spent by some other transaction (the sender cancelled, for example by self-carrying): the cancellation fee `c_cancel × U` (5.5), unless the item was uncovered at the last published rate when that transaction was first seen, then 0.
- Change: `floor((credit(i) − cost) / U)` tickets; the remainder below one ticket goes to `Q`. Rounding always favours money already received.
- Change is evaluated once, at settlement, against the change elements stored at submit time, under the key fixed by 6.10, and published in that block's snapshot. Nothing is returned per item.
- Nothing is ever paid back in BTC. No code path builds an output to any key other than a fresh pool key, or the pinned cold address (withdrawals only).

**I6. Sweeps: paid by the outputs they sweep.**
- A sweep is the only transaction that is neither a carrier version nor a withdrawal. Its fee must satisfy `fee ≤ Σ c_in(credited invoice inputs) + o`, with `o ≤ O` the shared part (transaction overhead, outputs, old small pool coins being consolidated), and its rate must be `≤ capRate`. Otherwise it waits, and so do the tickets behind it (6.4).
- `O` is funded only by margin, up to `O_max`; margin beyond that goes to `Q`. `O` never pays for any carrier version.

**I7. Income matures; losses never reach the operator's capital.**
- Margin, remainders and cancellation fees go to `Q` and mature into `I` only when the sweep (or settlement) that produced them has 100 confirmations.
- A credited purchase reversed by a reorg deeper than the claim and sweep confirmations is a loss of money never received. It is booked against `Q` (revenue the operator has not earned yet), then against future margin: while a shortfall is open, ticket sales and withdrawals pause and the books show the shortfall. It is never booked against `I`, never against escrow of open items, and the operator never adds money.
- Withdrawals: `murkle relayer withdraw <sats>` is signed only if `w ≤ I` and the stress check passes: `B_eff − fee − w ≥ L + E + O + Q + (I − w)`, where `B_eff` counts each confirmed coin at `max(0, value − 330 − 57.5 × 2 × capRate)` and excludes every coin spent by a journaled transaction not yet 6 deep (their outputs count only once confirmed). Uneconomic coins count as 0, so a withdrawal can never leave tickets backed by dust.

**I8. Reconcile every tick, fail closed.**
- For every journaled outpoint, check its spend by outpoint. A spend by a transaction not in the journal, a confirmed fee that differs from the journaled version's fee, or a face-value shortfall (`B + B_pending < L + E + O + Q + I` while no reorg shortfall is open) puts the ledger in **halt**: no issuance, no signatures, no withdrawals, an alert in the log and in `/api/relay/info`. A bug or a theft stops relaying; it never spends.
- An explorer error or timeout is "retry", never "mismatch". Two explorers, or the operator's node, must agree before a halt on mainnet.
- Halt state is durable; only `murkle relayer resume` after a clean reconcile clears it.

### 2.4 Case by case

| Case | What happens | Who pays |
|---|---|---|
| Fee spike before signing | The item waits uncovered (5.4). It does not count toward queue or capacity limits. At its deadline it ends with cost 0; the user may self-carry with no cancellation fee | nobody, or the user's own BTC |
| Fee spike after broadcast | The carrier waits in the mempool; on mainnet a uniform bump (stage 3) may replace it on the same coin if the credit covers it | the user's credit |
| Broadcast refused, evicted, 404, missing-inputs | Pending-dead; same bytes resent; never re-carried on another coin; after `anchor + 100` a cancel on the same coin; cost = the fee of whichever version settles | the user's credit |
| Someone saved the carrier bytes and rebroadcasts them later | It confirms or conflicts with the cancel; either way its fee was escrowed and stays escrowed until settled | the user's credit |
| Carrier confirmed but rejected (notes spent elsewhere first, anchor window closed) | The fee is consumed | the user's credit |
| Sender cancels a covered item by spending its nullifiers elsewhere | Cancellation fee kept, rest returned | the sender |
| Crash between journal and broadcast | Identical bytes resent; one signature record | the user's credit |
| Reorg of a carrier | Identical bytes rebroadcast; settlement waits for 6 deep | nothing new |
| Rounding | Issuance floors, change floors, the carrier fee is exact | never the operator |
| Two concurrent requests spending one serial (submit and submit, submit and swap) | Exactly one succeeds | — |
| Two concurrent claims of one payment | Exactly one succeeds | — |
| Lost 202 | A resubmit with the same tickets (each `y` verified) and the same nullifiers returns 202 again | — |
| Many outputs to one invoice address | Each output is credited on its own claim and pays its own `c_in`; outputs below `c_in + P` are not credited | the payer |
| Purchase reorged out before the claim or the sweep reaches `K` | Not credited; no tickets exist yet | — |
| Purchase double-spent by a reorg deeper than that | Shortfall booked against `Q`, then future margin; sales and withdrawals pause | unearned revenue; never operator capital, never escrow |
| Bug in the HTTP layer | `signCovered` refuses anything uncovered; the keys hold no operator money anyway | nobody |

The one residual risk is the deep reorg of a purchase: ordinary payment-finality risk on a sale, bounded by two rounds of `K` confirmations and the 400-ticket cap per output. On signet only the signet block signers can reorg.

### 2.5 Tests that guard the invariant

- Property test (`test/tickets-invariant.test.mjs`): random sequences of buy (one or many outputs, dust outputs), claim, concurrent claims, sweep, submit, concurrent submit and swap on one serial, flush, fee change up to 100x, broadcast refusals of every class, eviction, rebroadcast of an old raw carrier after its item was cancelled, multi-endpoint "missing-inputs" followed by confirmation of the first version, cancel, reorg (shallow and deeper than `K`), crash between any two journal writes, restart, key rotation and retirement, and a dust flood at every key in `FakeEsplora`. After every step: each account `≥ 0`, `F ≤ R − W`, every signed version has `fee ≤ credit`, each item's versions all spend one outpoint, no carrier input is unconfirmed or younger than `M`, a foreign coin is never an input, `issued_k ≤ paid_k + change_k + swappedIn_k`, and an unjournaled spend halts.
- `signCovered` refuses: a fee of `credit + 1`; a change of 329 sats; a second OP_RETURN; an output to any key that is not a fresh journaled pool key; a second outpoint for an item; an unconfirmed input.
- Concurrency tests: 50 parallel claims of one outpoint with different blinded sets give one success; swap during submit on the same serials gives one success; 100 concurrent submits at batch cap minus 1 give one acceptance and at most one Groth16 run beyond the cap.
- Static tests: no module except `server/ledger.mjs` imports `signLocal`, reads the key files, or writes the spent set; `web/src/session.js` `refreshHistory` makes zero `/api/relay/status` calls.
- Restart replays the journal with no second debit and no lost signature record.

## 3. Recommended design in one paragraph

Users buy **prepaid relay tickets** with one plain BTC payment to an invoice address their wallet derives itself (built-in purchase key, Unisat `sendBitcoin`, any wallet, an exchange withdrawal). Nothing is registered before the payment. After `K` confirmations the wallet claims that exact output with a signature and its blinded ticket requests. The relayer sweeps claimed payments on a fixed public schedule, and when a sweep has `K` confirmations it evaluates the requests with an **RFC 9497 VOPRF** (ristretto255-SHA512, verifiable mode) and publishes the evaluations in that block's sorted public snapshot, so it cannot tell which purchase a ticket came from and no request returns anything that times a user. A relayed send hands in one published number of tickets, the same for every mode in that block; they become that item's escrow. Each item is bound to one aged pool coin, and every version of its carrier fits inside its escrow; a signed carrier stays escrowed until its coin is settled 6 blocks deep. Unused credit comes back as change published in the snapshot, never as BTC. The ticket key, the invoice key and the terms are announced on chain once per key period in a chain of announcements, so a relayer cannot give one user a private key to tag them. Self-pay stays available with no relayer involved. Hourly and 10-hour batches keep their epochs, anchors and whole-epoch release.

## 4. Primitive

**RFC 9497 VOPRF, mode 0x01 (verifiable), suite ristretto255-SHA512.**
- Implemented in `src/tickets/voprf.mjs` on `@noble/curves` (ristretto255, `expand_message_xmd`), already a dependency; about 250 lines. It ships only if it reproduces the RFC 9497 Appendix A test vectors for this suite exactly. If the installed `@noble/curves` provides an RFC 9497 module, use it instead.
- Client: picks input `x` (32 bytes, the serial), blind `r`; sends `B = r·H(x)`. Server: `Z = k·B`, published in a snapshot with one batched DLEQ proof per key per snapshot that every `Z` in it was made with that key. Client: verifies the proof over the whole snapshot list, unblinds, keeps `y = Finalize(x, r⁻¹·Z)` (64 bytes).
- Spend: reveals `(keyId, x, y)`. The relayer recomputes `Finalize(x, k·H(x))` and compares in constant time.
- Why: issuer and verifier are the same party, so private verifiability is enough. One round, so the ROS attack on concurrent blind Schnorr does not apply. Small tokens. Deterministic given `(x, r)`, so tickets come back from the 24 words. Blinding is information-theoretic.
- Fallbacks if review rejects the noble implementation: `@cloudflare/voprf-ts` (P-384), or Cashu-style BDHKE on secp256k1 with DLEQ (NUT-00/NUT-12 vectors).
- Rejected: blind Schnorr (ROS), blind BLS (no RFC), hand-written blind RSA over BigInt (large tokens, no batched proof, needs a modulus well-formedness proof).

## 5. Pricing and fee rates

### 5.1 Parameters

| Parameter | Signet | Mainnet (example) | Changes |
|---|---|---|---|
| `U` (credit per ticket) | 200 sats | 1,000 sats | **never** (a constant of the network) |
| `P` (price per ticket) | 220 sats | 1,100 sats | per key period, announced |
| `capRate` (sweep fee-rate cap) | 2 sat/vB | announced per period | per period |
| `c_in` per credited output | 115 sats | `⌈57.5 × capRate⌉` | per period |
| Packs | 25, 100, 400 | decision (section 14) | per period |
| Pack price | 5,615 / 22,115 / 88,115 sats | `n × P + c_in` | per period |
| `K` confirmations | 2 | 6 (section 14) | fixed |
| Max tickets per output | 400 | 400 | fixed |
| Max tickets per item | 64 (12,800 sats) | 64 | fixed |
| Sweep schedule | every 12 blocks (about 2 h) | every 144 blocks (about a day) | fixed per network |
| Spend hold after issuance (wallet) | random 6 to 36 blocks | random 6 to 144 blocks | wallet rule |
| Coin age `M` | 6 blocks | 6 blocks | fixed |
| Floor fee rate | 1 sat/vB | the mempool minimum | — |

Because `U` never changes, `credit = k × U` is exact for any key, and a swap is one ticket for one ticket. If `U` ever had to change, it would be a new network constant with its own keys, never a period parameter.

### 5.2 One published ticket count per block, for every mode

The carrier is 598 vB (`planCarrierTx` charges `⌈597.5⌉`). Once per block, when the relayer first sees tip `h`, it publishes `r_h = max(floor, nextBlockEstimate)` and **one** count for all modes:

`k_h = ⌈598 × max(r_h, r_{h−1}) × 2 / U⌉`

- Next block and Fast items attach `k_h` of the current tip, and only that (402 `ticket_count` with the expected number otherwise; the wallet retries once).
- Hourly and 10-hour items attach `k_S`, the count of the epoch's opening block `S`, fixed for the whole epoch.
- At 1 sat/vB on signet `k = 6` for every mode. The carrier then costs 598 sats, change is `floor((1,200 − 598) / 200) = 3`, so a send consumes 3 tickets (3 × 220 = 660 sats paid, 598 of them to the miner, 2 to `Q`).

One count and one headroom (2x) for every mode means the change count no longer depends on the mode, and a lower stale count is never accepted, so nobody can park cheap items (holes 20 and 27).

### 5.3 Fee rate at broadcast

- At each flush the relayer prices every carrier at one market rate `r_m`, uniform across the flush, never at the user's coverage.
- An item goes out only if `fee(r_m) ≤ credit(i)` and a coin of value `≥ credit(i) + 330`, at least `M` blocks old, is free; coins are picked uniformly at random among those, never smallest-first.
- **The gap is never covered by the operator.** There is no code path that adds operator money to an item, and I0 means there is none to add.

### 5.4 When fees rise above what the tickets cover

- The item waits. While uncovered it holds no coin and does not count toward `queue_full`, the batch caps or coin capacity, so waiting items cannot block anyone.
- The wallet computes "uncovered" itself from the public per-block rate and its own `k`; nothing is polled per item. It offers [Pay the fee myself] (self-carry the same envelope: because the item is uncovered, no cancellation fee is kept) or waiting.
- At its deadline (`anchor + 76`, or the epoch's `lastRelease`) the item ends with cost 0 and every ticket comes back as change in that block's snapshot.
- **No top-ups**, before or after broadcast, in any mode: a per-item payment after submit is a per-item request that times the user and splits batches by fee rate. The 2x headroom makes waits rare.
- **After broadcast** (stage 3, mainnet only): at each flush the relayer may pick one replacement rate for all in-flight carriers older than 2 blocks and bump, on the same coin, exactly those whose credit covers it; batch members are bumped all or none per epoch. Never per item, never to an item's own ceiling. Signet has no bumps.

### 5.5 Cancellation fee

`c_cancel = ⌈598 × r / U⌉` tickets, with `r` the rate behind the item's `k` (3 tickets at 1 sat/vB on signet). It is kept when an item's nullifiers are spent by another transaction while the item was covered (I5), and goes to `Q`. Shown at submit: "If you cancel this send by sending the same notes another way, 3 tickets are kept." It makes filling a batch and then cancelling every slot cost the attacker real money (hole 19).

## 6. Payment mechanism, step by step

### 6.1 Key announcements (anti-tagging, non-consensus)

- Once per key period (4,320 blocks, about 30 days; signet 1,008 blocks, about 7 days) the relayer posts one announcement transaction from its announcement key with a 73-byte OP_RETURN:
  `"MRKT" ‖ version u8 ‖ period u32 ‖ ticketKey (32) ‖ sha256(terms) (32)`.
  Uppercase `MRKT` never matches the indexer's lowercase magic; it fits even the pre-v30 83-byte limit.
- **The announcements form a chain.** Announcement `p` spends output 1 (a 330-sat marker) of announcement `p − 1`, and the first one spends a genesis outpoint pinned in the wallet build and the CLI config. The wallet follows `/tx/:txid/outspend/1` from genesis to the head: a constant number of requests per period, unaffected by anything else sent to the announcement address. Only announcements on that chain count. A second chain would need a second genesis, which wallets do not accept, so equivocation stays public.
- `terms` is a canonical byte string at `GET /api/tickets/keys`: suite id, the period's invoice public key, `U`, `P`, `capRate`, `c_in`, packs, `K`, caps, sweep schedule, the period boundaries and the key schedule of 6.10. No pool address.
- Every DLEQ proof is checked against the key that the deterministic rules of 6.10 require for that snapshot height and cause, never just "an announced key".
- The announcement key is funded by the operator: about one small transaction per period, the operator's own cost of publishing its own key. It is never a user's transaction and never signs a carrier or touches the pool.

### 6.2 Purchase (nothing is registered before payment)

1. The wallet derives purchase `j` of period `p`: `orderKey_j = HKDF(seed, "murkle/tickets/order" ‖ j)`, `orderPub_j` its x-only public key.
2. `invoiceAddress = P2TR(invoicePub_p + t·G)` with `t = taggedHash("murkle/ticket-invoice", invoicePub_p ‖ orderPub_j)`. The wallet computes it locally from the announced invoice key. There is no order endpoint, no server row and nothing to flood.
3. The user pays the exact pack price, in one output:
   - built-in purchase key: `LocalPayer.pay(address, sats)`, a new `planPaymentTx` in `src/btc/funding.mjs`, from a key on its own seed path `murkle/tickets/pay`, never the fee key that mints and self-pays (hole 37);
   - Unisat: `UnisatPayer.pay(address, sats)`, `sendBitcoin` with no memo, which works on signet; the sheet notes that this Unisat address may be the one your mints are public under;
   - any other wallet or exchange: address, exact amount and a QR code; "the exact amount, in one payment" is stated.
4. The wallet records `{j, period, address, amount}` in the vault. It never asks the relayer about the payment; it reads the payment's confirmations from the explorer by its own txid, which the paying path already told the explorer.
5. Disclosed at purchase: "Pay the exact amount. A payment below one ticket is not credited and can't be returned. Tickets are released with the next scheduled sweep, then held by your wallet for a while before use."

### 6.3 Claim

- After `K` confirmations, at a random time 1 to 12 hours later (a background job, never within 30 minutes of any send by this wallet), the wallet calls `POST /api/tickets/claim` with body `{period, txid, vout, orderPub, blinded[n], sig}`, where `sig` is a BIP340 signature by `orderKey_j` over `"murkle/tickets/claim" ‖ network ‖ period ‖ txid ‖ vout ‖ sha256(blinded[])`. Order data travels only in POST bodies and is never logged.
- The server, in order, with no crypto before the free checks: shape; period's invoice key is claimable (6.10); outpoint not in the credited set or reserved; then fetch the transaction by txid, check that output `vout` pays `invoicePub_p + t·G`, has `K` confirmations and was confirmed at or after the period's announcement height; check `v ≥ c_in + P` and `n = min(400, floor((v − c_in)/P))` exactly; verify `sig`. Reserve the outpoint synchronously, then write the claim durably (outpoint added to the credited set, blinded elements stored). Answer 202 with no evaluations.
- Several outputs to one address are several claims; each pays its own `c_in`.
- An identical retry (same outpoint, same blinded list, valid signature) gets the same 202. Any other claim of a credited outpoint is 409 `claimed`.

### 6.4 Sweep and issuance

- Every 12 blocks on signet (144 on mainnet), at a height divisible by that number, the relayer signs one sweep: all claimed invoice outputs not yet swept, plus optionally old small pool coins to consolidate, into fresh pool outputs sized for carriers (signet 13,500 sats each, enough for any item's credit), with the remainder in one larger output. Fee rate `≤ capRate`, fee paid per I6. If the rate is above `capRate` the sweep waits, and so do those tickets; the wallet shows "Waiting for the next sweep".
- When the sweep has `K` confirmations, every claim it swept is issued in that block's snapshot. All purchases in one sweep are issued together, and their payment outputs and amounts are visible on chain in the sweep anyway, so the snapshot adds nothing per purchase.
- Pool coins created by a sweep can fund carriers only once `M` blocks old, and are picked at random (5.3), so the first carriers after a purchase are not the buyer's coin by construction (hole 30).

### 6.5 Per-block snapshots (the only place issuance and spends are published)

- When the relayer moves past tip `h`, it writes one immutable file per redeemable key, `GET /api/tickets/snapshot/:keyId/:h`:
  - `spent`: the serials `x` spent during `h`, sorted;
  - `issued`: every `(B, Z)` evaluated during `h` (claims of sweeps that reached `K`, change of items settled, swaps), sorted by `B`, with no grouping, no cause and no timestamp;
  - one batched DLEQ proof over `issued`.
- No live list exists. Evaluations are computed eagerly at the event (sweep at `K`, settlement, swap), never lazily at a request.
- The wallet downloads every snapshot while online (and the missed ones on unlock), as every wallet does, and finds its own `B` values locally. It verifies the DLEQ against the key that 6.10 requires for that height and cause.
- What a poller learns: per block and key, how many serials were spent (submits × the public `k`) and how many evaluations were made. Issuance from sweeps equals what the sweep transaction already shows. Change is the sum over the items settled in that block, never per item.
- Files are static and cacheable; a later version groups old blocks into ranges.

### 6.6 Storage

- Wallet: tickets `{keyId, x, y, state}` with state `unspent | held-until:<height> | handed:<itemId> | spent`, pending claims, pending change elements, and counters, inside the vault sealed by `web/src/keystore.js`. Never in plain `localStorage`.
- **Rule T-1** (like W-1): a ticket handed to the relayer counts as spent until the item's change appears in a snapshot or the item is otherwise final. A wallet never offers the same ticket twice.
- Relayer: the credited-outpoint set (permanent), claims, snapshots, the spent-serial set per redeemable key, items, signature records and the books journal, all under `data/<network>/paid-relay/` with the durable-write rule. No IP is ever stored.

### 6.7 Spending (`POST /api/relay/submit`)

Body: `{ envelope, mode, keyId, tickets: [{x, y}] × k, change: [B'] × k }`; body cap 16 KB. Submits leave the browser only at the wallet's regular 20-second poll tick, never at the moment the button is pressed.

Order. Every free check runs before any crypto; nothing changes durable state until step 10.
0. Shape and mode; `k ≤ 64`; one `keyId`.
1. Global gates: enabled, not halted, indexer lag, coin capacity (`relay_busy`). No ticket is touched.
2. `k` equals the published count for this mode (5.2), else 402 `ticket_count`.
3. `keyId` known and redeemable (`key_unknown`, `key_retired`); every serial neither spent nor reserved (`ticket_spent`), a hash lookup. Reserve the serials synchronously through `spendSerials`.
4. Decode; `op = TRANSACT` and zero public value.
5. Nullifiers not spent or pending; reserve them synchronously.
6. Freshness and the batch rules of `batch-contract.md` §3.2 step 6b. The batch slot and the block slot are **reserved synchronously** here, like nullifiers, and released only on a later failure, so requests beyond a cap fail before any crypto.
7. Idempotency: if an item with exactly these nullifiers exists, continue to step 8 and answer its 202 after step 8 passes; never earlier.
8. Ticket check, in a worker under a global token bucket: verify each `y` in turn and stop at the first failure (`ticket_invalid`). If any ticket fails, every ticket of the request is burned: an honest wallet never holds an invalid ticket, so a failure is either an attack or a broken wallet.
9. Groth16 check under the existing semaphore and rate cap. Re-check 1, 5 and 6 after the await.
10. Accept: one durable write through `spendSerials` records the serials as spent, the item with `credit = k × U`, the change elements, and moves `k × U` from `L` to `E`. Then 202.

Burn rule: a failure at step 4 after decode (`malformed`, `not_transact`, `public_value`), step 8 or step 9 (`proof_invalid`) burns the reserved tickets (to `Q`). Every other failure releases them unspent. Rejected requests carrying tickets are counted per ticket, per IP prefix and globally.

The relay id in the 202 carries no capability: there is no status call, no top-up and no per-item request after submit.

### 6.8 Carriage lifecycle

- Flush as in `relayer.md` §4.6 and `batch-contract.md`, with `signCovered` as the only signer and the coverage test of 5.3 replacing the daily budget and per-transaction fee hold.
- First signature: bind a random eligible coin (5.3), journal the signature record, broadcast. Broadcast results:
  - accepted or already known: broadcast;
  - anything else (min fee, mempool full, missing inputs, conflict, 404, chain limits): pending-dead (I4). Resend the identical bytes each block. Never a fresh coin, never back to queued, never dropped.
- Status of an item is followed by outpoint: the bound coin's spend. When a version confirms 6 deep, the item settles (I5) and its change goes into that block's snapshot. A spend by a transaction not in the journal halts (I8).
- Cancel after `anchor + 100` as in I4.

### 6.9 How the wallet follows a relayed send (no per-item calls)

- Landed or rejected: from the indexer's bulk data, which the wallet already syncs (its own nullifiers and envelope).
- Waiting for fees: from the public per-block rate and its own `k`.
- Batch held, released, landed: from the existing once-per-block batch counts.
- Returned tickets: its change elements in a snapshot.
- `refreshHistory` makes no `/api/relay/status` calls. `GET /api/relay/status/:id` remains only to answer retired v1 ids (section 12).

### 6.10 Keys, expiry and swaps

Each key period `p` has one ticket key with a one-way durable state, written once per transition and never derived from the current height:

| State | Periods | Issues | Redeems |
|---|---|---|---|
| issuing | `p` | claims of sweeps reaching `K` in period `p`; change of its own tickets | yes |
| redeem-only | `p + 1` to `p + 4` | change of its own tickets | yes |
| final | `p + 5` | nothing (change goes under the current issuing key) | yes; swaps out |
| retired | after `p + 5` | nothing | no |

- Deterministic key rules, checked by the wallet: claims are issued under the key whose issuing period contains the snapshot height; change is issued under the key of the spent tickets unless that key is final, then under the issuing key; swaps go to the issuing key. A snapshot within one block of a period boundary is accepted only after the boundary block has 6 confirmations. An evaluation under any other key is refused and reported.
- Retirement: inside the ledger mutex, after every reservation for that key has drained, in one durable write: set the state to retired, compute the lapse `(issued_k − redeemed_k − swappedOut_k) × U` into `Q`, drop the spent-serial table, and destroy the key scalar. With the scalar gone no code path can verify or evaluate under that key, so a reorg, a resync or a restored snapshot cannot reopen it.
- Swaps: `POST /api/tickets/swap {keyId, tickets[n], blinded[n − 1]}` only for a key in its final state, at least 5 tickets, one ticket kept as the swap fee. It goes through `spendSerials` like a submit; evaluations appear in the next snapshot. A ticket can be swapped at most once per key lifetime. The wallet swaps at a random time during the final period, never within 30 minutes of a send, all its tickets of that key in one call.
- Disclosed at purchase: tickets stay usable for about 6 periods (signet about 6 weeks, mainnet about 6 months); a wallet opened at least once per period never loses one.
- Key compromise: the period's key stops issuing and redeeming at once, a new key is announced, holders swap. Reconcile checks `redeemed_k ≤ issued_k` per key; a breach halts that key.

### 6.11 Recovery from the 24 words

Everything is derived: `HKDF(seed, "murkle/tickets/…")`.
- Purchase `j`: `orderKey_j`; ticket `i` of purchase `j`: `x_{j,i}`, `r_{j,i}`.
- Change of an item: from its first ticket's serial, `x' = HKDF(seed, "murkle/tickets/change" ‖ x_first ‖ i)` with its blind likewise. Swaps: `HKDF(seed, "murkle/tickets/swap" ‖ x_first ‖ i)`.

Restore:
1. Download every snapshot of every redeemable key. Never a per-ticket or per-purchase query to the relayer.
2. For `j = 0, 1, …` with a gap limit of 20, regenerate `B_{j,0}` and look it up; if present, regenerate the purchase and unblind.
3. For each recovered serial seen in a `spent` list, regenerate change and swap element 0; if present, regenerate the rest.
4. Paid but unclaimed purchases (the vault was lost between paying and claiming): only purchases after the last recovered one, at most 20 addresses, are checked against the explorer by address, one per request at random intervals over an hour, through a fresh Tor circuit where the CLI has a SOCKS proxy. Copy: "Checking your last purchases with mempool.space. It can see these lookups come from one device."
5. Report "N tickets recovered". Tickets handed to an item that is still open come back when it settles.

## 7. Anti-spam by construction

- **Every carrier is paid in advance by whoever caused it.** A zero-value transfer needs the same published `k` tickets as any other send. Flooding through the relayer costs the attacker the full carrier fee plus margin per carrier; the operator collects the margin and spends nothing of its own.
- **Draining is impossible:** the pool holds only users' prepaid credit and margin (I0); `signCovered` never signs a version past its item's credit (I3); a signed version stays escrowed until settled (I4); sweeps are paid by the outputs they sweep (I6).
- **Nothing is free to create.** No order exists before a payment; claims need a confirmed payment output and the order key's signature; swaps cost a ticket and are allowed once per key lifetime; submits need valid unspent tickets.
- **CPU:** every free check runs before crypto (6.7). Ticket verification stops at the first bad ticket and burns the request's tickets. Groth16 runs only for requests whose tickets verified, and a failed proof burns them. Batch and block slots are reserved before crypto, so a crowd of concurrent requests at a cap costs one Groth16 run at most.
- **Parking:** uncovered items hold no coin and count toward no cap. A count from an older, lower rate is never accepted.
- **Batch flooding (n−1):** the per-epoch caps stay; filling an hourly epoch costs 39 covered sends, and cancelling them costs the cancellation fee each. `BATCH_PER_IP` stays (section 14, item 8). The batch counts gain a per-epoch "dropped by the sender" number, so a mass cancel is visible.
- **Dust:** payment outputs below one ticket are not credited; foreign coins are never discovered (I0); credit is per output, each paying its own sweep input.
- **Ticket forgery** needs the VOPRF key or a break of one-more gap-DH on ristretto255.
- **Removed from the money path:** `DAILY_BUDGET_SATS`, `MAX_FEE_RATE` as a budget gate, `POW_*`, `ACCEPT_PER_HOUR`/`ACCEPT_PER_DAY`, the order endpoint, top-ups, carrier chains. Tor users stop being penalised for shared exit IPs.
- On signet, BTC comes from faucets, so paid spam costs the spammer faucet time, not value. The operator's money is still never at risk; liveness is bounded by the caps.

## 8. What each observer learns

Content (token, amount, sender, recipient, spent notes) stays hidden by the proof on every route.

| Observer | Ticket purchase | Relayed send (tickets) | Self-pay |
|---|---|---|---|
| **Anyone reading Bitcoin** | Address A paid a pack amount to a fresh address that a scheduled sweep later spent together with the other purchases of that window: "A bought N relay tickets at block t", permanently, for anyone who recognises the sweeps. | A carrier spending a pool coin at least 6 blocks old, picked at random, at the flush's uniform rate. No address of the user. The coin descends from sweeps of all buyers so far; at low volume that is few buyers. | The paying address, block and fee of this transfer, permanently; it links to every mint and send paid from that address. |
| **Relayer operator** | A, the output, `orderPub` (fresh per purchase), the claim's time and IP, the blinded elements (which reveal nothing). | IP, user agent, time (aligned to the wallet's poll tick), the envelope minutes early, the mode, the key and serials, the change elements. Not which purchase the tickets came from. Requests of one browser session close in time can be joined (see below). | Nothing beyond the chain, unless the same session also used the relayer (see self-carry below). |
| **Network observer** (ISP, Wi-Fi) | Connections to the relayer at claim time; the payment's broadcast through the paying wallet's server. | A connection to the relayer, then in quiet periods one new pool carrier 10 to 40 seconds later (Fast) or in the next block: in that case it names your carrier. Tor hides the destination, not the moment. | The broadcast through mempool.space or Unisat. |
| **Anyone polling the relayer** | Per block: how many tickets were issued, which equals what the sweep shows on chain. | Per block: the rate, the one ticket count, the batch counts, the number of serials spent (so the number of submits that block), the total change of items settled that block. Nothing per item. | — |
| **Paying wallet / explorer** (Unisat, mempool.space) | A plain payment to an address, and the IP that sent it; the wallet's confirmation reads of that txid. | Announcement-chain reads (the same for every user). | The carrier and the IP. |
| **Recipient** | — | Amount, token, carrier txid. Not the sender's address. | Amount, token, and the sender's paying address. |

What can still link a ticket to its purchase, and the defences:
- **One session.** Tor Browser sends every request to one site over the same circuit for about 10 minutes, and user agent and timing can join sessions. Defence: claims and swaps run as background jobs at random times, never within 30 minutes of a send; the CLI uses a separate SOCKS identity per request type. Copy: "Tor hides your IP. It does not hide which requests come from one browser session, so your wallet spaces purchases and sends apart."
- **Timing.** Tickets exist only after the next scheduled sweep has `K` confirmations, and the wallet then holds them for a random 6 to 36 blocks (signet; 6 to 144 on mainnet) before use. Buying from the Send form only queues the purchase; that send goes by self-pay or waits. Copy: "Tickets bought just now would link this send to your payment, so they become usable after block H."
- **A small crowd.** The crowd of a ticket is the purchases issued under its key before it, whose tickets are not yet all spent. Submits use one key, oldest first; change stays under the spent tickets' key. The wallet shows a meter computed from public snapshots: distinct spends under that key in the last period. The operator could inflate it only by making real paid sends of its own, and the copy calls it an upper bound. Below 5, the wallet says "hides little" and preselects the 10-hour batch.
- **A per-user key, price or issuance moment:** impossible without public equivocation (6.1) or a rule the wallet checks (6.10). The wallet also reads the sweep that spent its own payment and says "Your purchase was released with N others" (also an upper bound).
- **Change and status:** nothing is fetched per item; change appears among everyone's in the block snapshot.
- **Self-carry fallback:** if you pay the fee yourself for a send the relayer already holds, the operator can tie your fee address to that session's other requests. Copy on that button says so.
- **Restore:** links your purchase addresses only in the rare step 4 of 6.11, and only for the explorer.

Remaining trust point, unchanged: the same origin serves the wallet JS, so a malicious build could skip the checks or leak ticket secrets (`relayer.md` §7.5).

Copy may say: "Your BTC address is not on relayed transfers." "Tickets are blind-signed: the relayer can't tell which purchase a ticket came from." "The relayer sees your IP and timing; Tor Browser hides your IP." "Every carrier is paid from the tickets handed in for it: check it in Relayer books." Never "free", never "the relayer learns nothing", and none of the words banned by `english.test.mjs`.

## 9. Self-pay, always available

- `LocalPayer` (the seed-derived fee key) and `UnisatPayer` carry the envelope themselves, as today. No relayer, no tickets, no operator involvement at all. "Copy envelope" also stays.
- Copy: "Pay the fee myself: Bitcoin shows this transfer was made by your BTC address, permanently." The linkage warning naming earlier mints from that address stays.
- Fee-key hygiene is advice, not a feature: a fresh key per transfer only moves the link to whatever funded it, unless each key is funded from an unrelated source. The deposit sheet keeps its honest funding advice (`privacy-level2.md` §6.5). The ticket purchase key is a different key from the fee key (6.2).
- Mints and launches stay self-paid and are never relayed (A-6).
- On signet Unisat still cannot carry a 471-byte envelope (`UNISAT_SIGNET_NOTICE`); Unisat users send privately with tickets bought through a plain Unisat payment.

## 10. Batch timing

Unchanged: epochs (6 and 60 blocks), anchors at S, `releaseAt`, `lastRelease` (S+76, S+88), W-1 until S+100, the whole-epoch release, the shuffled burst, the once-per-block published counts, the per-epoch caps and `BATCH_PER_IP`. Changed:
- `k` for an epoch is `k_S` (5.2), fixed when the epoch opens. Every member has the same coverage.
- At release the epoch goes out whole if `fee(r_m) ≤ k_S × U` and the pool has an eligible coin for every member; otherwise it is held whole. Past `lastRelease` it ends whole with cost 0 and every member's tickets come back.
- No top-ups. Uniform bumps on mainnet apply to an epoch all or none.
- Batch carriers spend aged coins only and never chain; a 10-hour epoch of 120 needs 120 eligible coins, which the sweep schedule sizes for (capacity is published per block, as today).
- Batch and block slots are reserved synchronously at submit (6.7 step 6).
- The per-epoch counts gain `droppedBySender`.
- `batchPhase` takes "releasing" from the published `recent` counts instead of a per-item relay status.

## 11. Unisat and signet

- Purchase: a plain `sendBitcoin(invoiceAddress, amount)` with no memo. Signet's old OP_RETURN policy does not matter.
- Carriage by Unisat on signet: still refused by its node; the existing notice stays.
- Announcements: 73 bytes, posted by the operator through its own broadcast path.
- Mainnet: if Unisat's node relays large OP_RETURNs, `UnisatPayer.carry` works for self-pay as on any v30 node; nothing in this design depends on it.

## 12. Migration from the free relayer

**Now (already done):** `configFromEnv` sets `enabled: false`; the live server runs no relayer.

**Stage 0 removes the free path from the code**, so it cannot be turned back on by an environment variable: `MURKLE_RELAYER=1` without a ticket configuration refuses to start, and the budget, PoW and accept-bucket settings are no longer read.

**The free relayer's wallet (the operator's remaining signet coins, under the retired key, `data/signet/relayer.key` by default):**
- It never becomes pool money (I0). The paid relayer generates new keys and refuses to start if any equals the old key.
- `murkle relayer retire-free --to <address>` sweeps every coin of the old key to an address the operator names, as the operator's own transaction paid from that balance. It runs only once every v1 carrier is final (confirmed, or past its anchor window), so it never conflicts with a carrier already broadcast.
- The operator may use those coins to fund the announcement key (6.1).
- The old key file is then archived and never loaded again.

**Items queued before the switch-off:**
- They are never broadcast. A v1 carrier that was already broadcast is left alone.
- The server loads the v1 `relayer.json` read-only and answers `GET /api/relay/status/:id` for v1 ids with `dropped` and the reason "The free relayer was retired. Pay the fee yourself, copy the envelope, or send again later with tickets." The wallet then shows its retry buttons.
- While relaying is closed, the wallet (`session.refreshHistory`) and `murkle pending` look every such id up at once, a batch item before its release block too, since no batch goes out. Until that answer arrives (or when the server does not know the id), the wallet already shows the item as needing attention, never as scheduled, and offers paying the fee yourself or copying the envelope (`relayStranded` in `web/src/session.js`); a carrier already broadcast is left as it is, since it may still land.
- The paid relayer's state is `version: 2` in a new path; a v1 file is never upgraded in place.

**Copy:** "Private relay: free, your BTC wallet is not used" becomes "Relay with tickets: your BTC address is not on the transfer". "Free on signet" and "Free relays left this block" go (`app-send.js`, `app-settings.js`, `app-portfolio.js`, `kit-view.js`, `relay.js` `budget_exhausted`). "Proof of sponsorship" becomes "Relayer books". Until stage 1 ships, the Send form offers only "Pay the fee myself" and "Copy envelope", and says that private relaying returns with tickets.

## 13. Failure modes

| What happens | Effect | User sees | Handling |
|---|---|---|---|
| Relayer down after payment | Payment safe on chain | "Your payment is safe on Bitcoin; your wallet claims it when the relayer is back." | Claims work while the period's invoice key is claimable (6 periods) |
| Underpaid / overpaid | Floor of whole tickets; remainder to the relayer | "You paid for 3 tickets; 3 will be released." | Per output; disclosed |
| Payment below one ticket | Not credited, not returned | "Not credited: below one ticket." | Disclosed at purchase |
| Sweep rate above the cap | Tickets wait | "Waiting for the next sweep (fees are high)." | 6.4 |
| Fee spike, Next block | Item waits, holds nothing | "Waiting: network fees are above what your tickets cover. Pay the fee yourself or wait. If it can't go by block L, your tickets come back." | 5.4 |
| Fee spike, batch | Epoch held whole, may end whole | "This batch is held until fees drop or block L; if it can't go, your tickets come back." | Section 10 |
| Carrier refused or evicted | Pending-dead, resent, cancelled after the anchor window | "The relayer could not get this carrier into a block. It is being cancelled; your tickets minus the fee actually paid come back." | I4 |
| Carrier rejected (notes spent elsewhere first) | Fee consumed | "The carrier was paid from your tickets; nothing else was spent." | I5 |
| User self-carries a covered item | Cancellation fee kept | "3 tickets were kept for the cancelled relay; the rest came back." | 5.5 |
| User self-carries an uncovered item | Nothing kept | "Your tickets came back." | 5.4 |
| Relayer crash or restart | None | Nothing | Journal replay; identical resends |
| Ticket key compromised | Forged tickets would spend users' credit | Key rotation notice; automatic swap | 6.10; per-key check halts the key |
| Ledger mismatch | Relayer halts | "The relayer is paused." | I8; self-pay and copy stay available |
| Deep reorg of a credited purchase | Shortfall in unearned revenue | Possibly "Ticket sales are paused." | I7 |
| Relayer shuts down for good | Unspent tickets cannot be used | "Tickets are prepaid service at this relayer; if it stops, pay the fee yourself." | Small packs; notice period in the terms |
| Vault lost | — | "Recovering relay tickets…" then "Found N tickets." | 6.11 |
| Announcement chain broken or forked | Purchase refused | "This relayer's ticket key isn't announced on Bitcoin; not buying." | 6.1 |
| Evaluation under an unexpected key | Refused | "The relayer issued tickets under the wrong key; they were not accepted. Report this." | 6.10 |

## 14. Decisions open at the time (each with a recommendation)

1. **Primitive.** Recommend RFC 9497 VOPRF ristretto255 on `@noble/curves`, gated on the RFC vectors; fallback `@cloudflare/voprf-ts`.
2. **Signet prices.** Recommend `U` 200 (fixed forever), `P` 220, `capRate` 2 sat/vB, `c_in` 115, packs 25/100/400, max 64 tickets per send.
3. **One count for every mode with 2x headroom.** Recommend it (hides the mode in change, makes waits rare). Cost: Next-block users lock twice the fee for about an hour and get the rest back.
4. **Confirmations.** Recommend `K` 2 on signet, 6 on mainnet, applied twice (claim, then sweep).
5. **Sweep schedule and spend hold.** Recommend every 12 blocks with a 6 to 36 block hold on signet (a new buyer waits about 3 to 8 hours), every 144 blocks with a 6 to 144 block hold on mainnet. Shorter means faster first use and a smaller crowd.
6. **Refunds.** Recommend tickets only, never BTC; payments below one ticket are neither credited nor returned.
7. **Cancellation fee.** Recommend one carrier's worth of tickets for cancelling a covered item, kept as revenue.
8. **`BATCH_PER_IP`.** Recommend keeping 3 per epoch. Remove the hourly and daily accept buckets and PoW.
9. **Expiry.** Recommend 6-period lifetime with one swap in the final period (fee one ticket), so only abandoned wallets lose tickets.
10. **Burns.** Recommend burning a request's tickets on any invalid ticket or invalid proof.
11. **Announcement key.** Recommend a separate key, funded by the operator, posting a chained announcement once per period.
12. **Fee bumps.** Recommend none on signet; uniform bumps on the same coin on mainnet.
13. **Default relay mode for new users.** Recommend the hourly batch as the default timing for relayed sends (a network observer cannot match a submit to the next block's carrier).
14. **Old hot wallet.** Recommend `retire-free` to an operator address once v1 carriers are final; never reused as pool money.
15. **v1 queued items.** Recommend answering them as `dropped` with the retirement reason.
16. **Signer process.** Recommend the single ledger module in-process on signet and a separate signer process before mainnet.
17. **Self-pay default.** Recommend no silent default when the wallet holds no usable tickets: the Send button offers [Buy tickets for later] and [Pay the fee myself].
18. **Lightning purchase rail (mainnet).** Recommend later, optional, issued only after the swapped-in coins are swept with `K` confirmations (I1 still holds).
19. **Gift packs.** Recommend deferring.
20. **Legal review** before any mainnet relayer: prepaid service credit, closed loop, no cash-out, published terms, disclosure that payments below one ticket and lapsed tickets are not returned.

## 15. Implementation plan

### 15.1 Stage 0, now (about 3 h, no new crypto)
Status: built 2026-10-03 (`server/retired-relay.mjs`, `relayerStartup()` in `server/relayer.mjs`, `murkle relayer retire-free`, `RELAY_ROUTE` in `web/src/relay.js`; tests in `test/paid-relay-stage0.test.mjs`).
- `server/relayer.mjs`: delete the free path (daily budget, PoW gate, accept buckets); refuse to start without a ticket configuration. `server/indexer-server.mjs`: read-only v1 status for old relay ids.
- `web/src/views/app-send.js`, `app-settings.js`, `app-portfolio.js`, `ui/kit-view.js`, `web/src/relay.js`: remove every "free" string; Send offers self-pay and copy only, with the linkage line.
- Tests: no "free" string in the relay copy (`english.test.mjs` extension); v1 ids answer `dropped`; `MURKLE_RELAYER=1` alone does not start a relayer.

### 15.2 Code paths in `server/relayer.mjs` that stage 1 replaces
- `carry()`, the `"spent"` branch (about L1361-1371: deletes raw, txid, fee and outpoint, re-queues the item and re-carries it on another coin): becomes pending-dead on the same coin.
- `sendJournaled()`, `"spent"` plus explorer 404 (about L1436-1445) and the `"chain"` expiry (about L1446-1450): become pending-dead and the cancel rule.
- `bumpAttempt()` (about L1421-1425): no retry limit ever finalizes a signed item.
- `finalize()` (about L1007-1021): no longer deletes raw or unreserves the outpoint of a signed item; settlement replaces it for signed items.
- `pickUtxo()`, `changeDepth`, `changeRoot` and the fan-out (about L589-610, L1171-1180, L1500-1540): replaced by random selection among aged confirmed journaled coins, and by the scheduled sweep.
- `esplora.utxos(this.address)` (about L981 and L1157): removed; coins come from the journal and are checked by outpoint.
- `markBroadcast()`'s `spentToday`: removed.

### 15.3 Stage 1, paid relay on signet (about 85 h)
New:
- `src/tickets/voprf.mjs` with `test/fixtures/voprf-rfc9497.json` (6 h).
- `src/tickets/tickets.mjs`: seed derivation, encoding, the `k` formula, pack table, announcement chain and terms encoding, invoice and pool tweaks, claim signature (5 h).
- `server/ledger.mjs`: books journal, `signCovered`, signature records, `spendSerials`, `issue`, reservation table and mutex, provenance by outpoint, settlement and cancel, reconcile and halt, key states, withdraw (16 h).
- `server/tickets.mjs`: claim, credited-outpoint set, scheduled sweep, snapshots with batched DLEQ, swap, announcement (12 h).
- `web/src/tickets.js`: vault store, buy, background claim and swap jobs with spacing, snapshot scan, spend hold, attach, T-1, restore, meter (9 h).
Edited:
- `server/relayer.mjs`: ticket redemption in submit with the new order, synchronous slot reservation, the code paths of 15.2, batch `k_S`, state v2 (12 h).
- `server/indexer-server.mjs`: `/api/tickets/*` routes, `/api/relay/info` price and capacity block, worker for ticket checks.
- `src/btc/funding.mjs`: `planPaymentTx`, `planSweepTx`, `planCancelTx`.
- `web/src/payers.js`: `LocalPayer.pay` on the purchase key, `UnisatPayer.pay`, `RelayPayer.carry` with tickets at the poll tick. `web/src/session.js`: send with tickets, status from bulk data and snapshots (no relay status calls), T-1. `web/src/keystore.js`: sealed ticket store.
- Views: buy sheet, cost lines, hold and wait states, cancellation-fee line, meter, "Relayer books" with the solvency audit (6 h).
- `bin/murkle.mjs`: `murkle tickets buy|claim|list|recover`, `murkle send --relay` with tickets, `murkle relayer books|withdraw|announce|resume|retire-free` (3 h).
- Docs: `SPEC.md` §14 ("carriage is paid with tickets, non-consensus"), `relayer.md` pointer to this file, `privacy-level2.md` §5.4 and §7, `batch-contract.md` section 10 changes, `audit/REPORT.md` A-13 (I-PAY), T-1 (3 h).
Tests (FakeEsplora, synthetic blocks, `mock-unisat.mjs`, port 0; nothing touches :8787, :5173 or `data/signet/`; about 13 h):
- `tickets-core`: RFC vectors, round trip, wrong key, DLEQ tamper over a snapshot, seed reproducibility, claim signature.
- `tickets-issuer`: invoice address recomputed; exact, under, over, dust and many-output payments; reorg before `K`; claim before `K`; replayed outpoint, re-used order key in a new period; 50 parallel claims; sweep waits above the cap; issuance only after the sweep has `K`; snapshot sorted and complete; key rules.
- `tickets-relayer`: free checks before any crypto (spy on hash-to-curve and Groth16); concurrent double spend gives one 202; swap during submit; `ticket_mixed`; `ticket_count` for a stale lower count; burn on an invalid ticket and on `proof_invalid`; slot reservation at the cap; idempotent resubmit only after `y` checks; cancellation fee covered and uncovered.
- `tickets-carriage`: every broadcast failure class leaves the item pending-dead with raw and reservation kept; rebroadcast of an old raw after cancel; cancel after the anchor window; settlement only at 6 deep; no carrier input unconfirmed.
- `tickets-invariant`: the property test of 2.5, plus the static tests.
- `tickets-batch`: an epoch covered at release goes out whole; uncovered is held whole and ends with full returns; all existing `batch-*.test.mjs` pass.
- `tickets-session` and `tickets-views`: buying through the purchase key, mock Unisat and an external wallet; background job spacing; spend hold; T-1; restore makes no per-ticket request (fetch spy); zero relay status calls; the announcement chain check; every new string in English; none of the banned words.
- Migration: a v1 state file never broadcasts; the old key never signs; `retire-free` waits for in-flight v1 carriers.
Live acceptance on signet (operator): buy 25 tickets with Unisat; see them released after the next sweep and hold; relay a send and check on mempool.space that the carrier spends an aged pool coin and no wallet address appears; Relayer books match the chain.

### 15.4 Stage 2, rotation and network privacy (about 14 h)
- Key states, swaps in the final period, retirement with scalar destruction, the meter.
- `.onion` endpoint; the Tor recommendation and the session copy on the buy sheet.
- Snapshot range files for restore.

### 15.5 Stage 3, mainnet gates (about 20 h plus external work)
- The ledger module in a separate signer process with its own journal and key files.
- `K` 6, two-explorer agreement for halts, multi-endpoint broadcast, uniform bumps on the same coin.
- External review of the VOPRF code, the books and the signer; legal review.
- Mainnet prices per period; optional Lightning purchase rail; open-source relayer so independent operators can run one, each with its own keys and announcement chain (more relayers split the crowd; documented).
- Optional, already planned and not required here: the `expiry` field and the BATCH op (`privacy-level2.md` §5.3) to cut cost per transfer.

## 16. Adversarial review (revision 1, 37 findings)

Every finding was checked against revision 1 and the code it would have reused. All are real (several duplicate each other); none was dismissed. "Changed" names where revision 2 closes it.

| # | Finding (team) | Real? | Resolution |
|---|---|---|---|
| 1 | A signed carrier can be treated as unsigned; its debit is erased while the bytes stay valid (make-operator-pay) | Real: `carry()` "spent", `sendJournaled()` 404, `bumpAttempt()` and the "chain" expiry all finalize or re-queue and delete raw (checked in `server/relayer.mjs`) | I3, I4, 6.8, 15.2: one coin per item for life; signed versions are a debt until the coin is settled 6 deep; pending-dead instead of drop; cancel on the same coin after the anchor window; "never signed" is a durable journal fact; property test rebroadcasts an old raw |
| 2 | Many outputs to one invoice: `c_inv` once per order, sweep cost per output (make-operator-pay) | Real | I1, I6, 6.3: credit per output, each paying its own `c_in` at the cap; outputs below `c_in + P` not credited; tickets issued only after the sweep has `K`; sweeps wait above the cap |
| 3 | Re-creating a pruned order id re-credits the old payment (make-operator-pay) | Real | I1, 6.2, 6.3: no orders at all; permanent credited-outpoint set; invoice key per period; only outputs confirmed after the period's announcement |
| 4 | Concurrent claims with different blinded sets issue twice (make-operator-pay) | Real | I1, 6.3: synchronous per-outpoint reservation; one ledger mutex; per-key issuance check; 50-parallel-claim test |
| 5 | Swap or top-up spends a serial outside submit's reservation (make-operator-pay) | Real | I2: single `spendSerials` shared by submit and swap; top-ups removed; static and concurrency tests |
| 6 | `U` varies by period, so credit and swaps create value (make-operator-pay) | Real | 2.1, 5.1: `U` is a network constant, never a period parameter |
| 7 | RBF of a carrier with chained descendants evicts other users' carriers (make-operator-pay) | Real | I3, 5.4: carriers spend only confirmed coins at least `M` old, never another item's change; bumps only on the same coin, uniform, mainnet only |
| 8 | Key retirement derived from height; replay after rollback; lapse races (make-operator-pay) | Real | 6.10: one-way durable key states; scalar destroyed at retirement; lapse inside the mutex after reservations drain |
| 9 | Deep-reorg shortfall booked against income; CPFP from overhead (make-operator-pay) | Real | I6, I7: shortfall against unmatured `Q` then future margin, never `I`; income matures after 100 confirmations; no CPFP exists |
| 10 | Solvency counts coins that cost more to spend than they hold (make-operator-pay) | Real | I7: withdrawals use `B_eff` at a stress rate, uneconomic coins count 0, coins in unsettled transactions excluded |
| 11 | Returning foreign coins has no paying account (make-operator-pay) | Real | I0, 6.2: foreign coins are never discovered and never returned; disclosed at purchase |
| 12 | Concurrent claim, swap or top-up issues tickets twice (drain-dos) | Real (duplicate of 4 and 5) | As 4 and 5; evaluations leave only through snapshots after the durable write |
| 13 | Dust flood on the static pool address breaks UTXO lookups (drain-dos) | Real: `esplora.utxos(this.address)` at about L981 and L1157 | I0, I8: coins come only from the journal and are checked by outpoint; fresh key per pool output; no pool address published; explorer error is retry |
| 14 | Free unpaid orders fill the global cap (drain-dos) | Real | 6.2: nothing is registered before payment; the wallet derives the invoice address; claim pulls the paid output |
| 15 | Spamming the announcement address makes wallets refuse to buy (drain-dos) | Real | 6.1: announcements form a chain from a pinned genesis outpoint, followed by outspend |
| 16 | Splitting payments into dust outputs drains overhead (drain-dos) | Real (duplicate of 2) | As 2 |
| 17 | Re-creating a pruned order id (drain-dos) | Real (duplicate of 3) | As 3 |
| 18 | Free swaps grow the spent set and bulletin without limit (drain-dos) | Real | 6.10: swaps only from a key in its final period, once per key lifetime, minimum 5, one ticket fee; static snapshot files |
| 19 | Fill a batch, then cancel every slot for a full refund (drain-dos) | Real | 5.5, I5: cancellation fee for a covered item cancelled by its sender; `droppedBySender` published |
| 20 | Submitting with the previous snapshot's lower `k` parks items for free (drain-dos) | Real | 5.2, 5.4: one count from `max(r_h, r_{h−1})`, exact match only; uncovered items count toward no cap and hold no coin |
| 21 | `ticket_count` checked after full ticket verification: unpaid CPU loop (drain-dos) | Real | 6.7: every free check before crypto; verification in a worker, stops at the first failure, burns the request's tickets; global budget counted per ticket |
| 22 | Claiming needs only the order id, which leaks through URLs and logs (drain-dos) | Real | 6.3: claim signed by the order key over the outpoint and the blinded list; ids only in POST bodies, never logged |
| 23 | Post-await recheck failures give Groth16 work for free (drain-dos) | Real | 6.7 step 6: batch and block slots reserved synchronously before crypto |
| 24 | Per-item status polling links all of a user's relayed transfers (deanonymize) | Real: `refreshHistory()` polls `api.relay.status` per entry (`web/src/session.js` about L700) | 6.5, 6.9: no per-item calls; status from bulk data and public counts; change in the block snapshot; test asserts zero status calls |
| 25 | Order polling, claim, swap and send share one session (deanonymize) | Real; only partly fixable in a browser | 6.3, 6.10, section 8: no polling at all; claim and swap as spaced background jobs; CLI SOCKS isolation; honest Tor copy |
| 26 | Buying inside the Send flow makes the timing link the default (deanonymize) | Real | 6.4, section 8: issuance at the scheduled sweep; wallet-enforced random hold; the Send form only queues a purchase |
| 27 | Public bulletin and spent list are live per-event feeds (deanonymize) | Real | 6.5: immutable per-block sorted snapshots, eager evaluation, one count for every mode so change does not reveal it |
| 28 | Key-period crowd is small; a mixed-key submit is a fingerprint (deanonymize) | Real | I2, 6.10, section 8: one key per submit, oldest first, change under the spent key, honest meter, 10-hour batch preselected below 5 |
| 29 | Operator tags a target by issuing under the previous key (deanonymize) | Real | 6.10: deterministic key per cause and height, checked by the wallet; issuance only in public snapshots |
| 30 | Sweep timing plus smallest-coin selection puts the buyer's coin in the next carrier (deanonymize) | Real: `pickUtxo` sorts by value | 6.4, 5.3: scheduled sweeps of all claims; coins at least `M` old; uniform random selection |
| 31 | RBF and top-ups make a carrier's fee rate reveal its mode (deanonymize) | Real | 5.4: no top-ups; bumps only at one uniform rate, batch all or none, mainnet only |
| 32 | Restore's order-id request links all of a user's paying addresses (deanonymize) | Real | 6.11: restore uses public snapshots; only the rare unclaimed-after-vault-loss case touches the explorer, spaced out, disclosed |
| 33 | Crowd meter can be inflated by operator self-purchases (deanonymize) | Real | Section 8: meter counts distinct paid spends from public snapshots, called an upper bound; privacy rests on holds and batches, not the meter |
| 34 | Self-carry fallback ties the session to a BTC address (deanonymize) | Real | Section 8: disclosed on the button; fixes 24 and 25 limit the spread |
| 35 | Network observer matches a connection to the carrier seconds later (deanonymize) | Real; not fully fixable without cover traffic | Section 8 discloses it; submits leave only at the regular poll tick; hourly batch recommended as default (decision 13); Tor recommended |
| 36 | Idempotent resubmit may hand relay ids to third parties (deanonymize) | Real as a spec gap | 6.7 step 7: idempotency answers only after every `y` verifies; the relay id carries no capability and there is no status call |
| 37 | Buying with the built-in fee key ties purchases to the mint identity (deanonymize) | Real | 6.2: purchases use their own seed path `murkle/tickets/pay`; the Unisat sheet warns |

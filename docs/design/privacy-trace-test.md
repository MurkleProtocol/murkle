# Murkle signet privacy trace: report

Date: 2026-10-06. Scope: all 12 Murkle transactions on signet, from genesis (height 324592) to 325149. No repo file was changed, nothing was broadcast, and no key or wallet file was read.

## 1. Method
- **Four analysts.** All had the public tx list, the repo docs and code, and read-only access to mempool.space.
  - **flow:** coin flow and grouping addresses by owner.
  - **timing:** block heights, anchors, batch epochs (height % 6) and same-block coincidences.
  - **envelope:** decoded the `mrk` OP_RETURN data. Looked at output order, padding notes, anchors, the binding fields, nSequence and fee patterns.
  - **insider:** the same public data plus the relayer's own files (relayer.json and the relay-balance books). This simulates a leaked or seized relayer.
- **Judging.** A judge compared every claim with the hidden ground truth. A finding counted as a real leak only if it breaks a promise in SPEC.md, relay-balance.md or mining.md, or goes beyond what they disclose. Artifacts of how the test personas were set up were listed separately.

## 2. Per-transaction results
| # | Tx | Truth | Sender | Recipient | Amount | How |
|---|---|---|---|---|---|---|
| 0–2 | 4c324438, 05258083, 65abd11e | Operator: ATTEST, DEPLOY, MINT 1000 | Yes (public by design) | Inferred: the minter | Public | Input address, bindOutpoint |
| 3 | 9b3c965f | Operator → bob, 200, Hourly batch, old free relayer | **Yes, all 4** | No | No | The anchor (324690) fixes the tree at leaves 0–1, and leaf 1 is padding, so only one note had value. Nobody else was in the batch. **L3** |
| 4 | d90f4794 | Bob → operator, 50, fast | No. Narrowed to 2 candidates. One analyst guessed the operator (wrong). | No (2 wrong guesses) | No | Anchor 324791 covers leaves 0–3. Funding txs in the same block led analysts to a wrong story. **Promise held.** |
| 5–6 | 611a4ab6, 634ff5b6 | User mints | Yes by address, but labeled as the operator | Inferred | Public | Change chain in the same block |
| 7 | 6254847f | Alice mint | Yes by address, but labeled as the operator | Inferred | Public | |
| 8 | 1fa45657 | Alice → bob, 300, via relay balance | **Yes, all 4** (address right; 3 of 4 called her the operator) | No | No | Alice paid 7000 to deposit address D (4b9ad594). D was merged one input to one output into pool key F (71d391c4), and #8 spends that output. Insider check: 6712 − 658 − 1999 = 4055, the stored balance. **L1, L2** |
| 9 | fa45928c | Alice DEPLOY_POW | Yes (public) | n/a | Public | |
| 10 | 0c9b1928 | Alice MINE_SCRIPT via relay balance | **Yes, all 4** | Inferred | Public | bindScriptHash = sha256(F's script) marks it as relayed. It spends #8's change, which descends from alice's deposit. **L1** |
| 11 | 0c3d67a3 | Alice self-paid MINE from mining key W | Yes (public by design). W was linked to her main key through funding tx bf05a448. | Inferred | Public | nSequence 0xfffffffd and the 2.0 sat/vB rate showed it came from the CLI. **L5** |

**Score.** Transfer senders: 2 of 3 named. Recipients: 0 of 3. Amounts: 0 of 3, insider included. The judge counted 16 wrong claims, nearly all of them because the analysts merged every persona into "the operator".

## 3. Real leaks and fixes

### L1. HIGH: the relay pool's coin history ties carriers to the depositor
A carrier is the Bitcoin tx that carries a relayed action. While only one person has money in the pool, every carrier and its change descend publicly from that person's deposit. All four analysts named alice for #8 and #10 from public data alone.

This breaks relay-balance.md:79: "a carrier is not tied to A by its input". The advice to top up ahead or to wait does not help.

Fixes:
- **Relayer:**
  - Never merge a deposit one input to one output. Merge deposits only together with existing pool coins from other accounts.
  - Track, for every pool coin, how many different depositors it descends from.
  - Let a carrier spend only coins that descend from at least k different accounts (start with k ≥ 5). Below that, refuse to relay or wait.
- **Wallet:**
  - Below k, show a hard warning and do not send unless the user opts in: "you are the only funder of the pool; this send is tied to your top-up address by its input".
  - Show the pool's count of separate depositors in Settings and /api/relay.
- **Docs and copy:** delete line 79 or make it conditional. Update CLAIMS.md and the contract text to match.
- **Constraint:** do not fix this by having the operator fund carriers. That breaks the no-operator-subsidies rule.
- **Test:** check that every carrier input descends from at least k different depositors.

### L2. MEDIUM: the relayer's files can still show who sent what
After settlement the relayer deletes the account field from each item. It keeps each item's `cost`, `acceptedHeight` and mode, plus the `credits` and `balances`. Credits minus the sum of costs equals the balance, and each cost is a unique number, so matching costs to accounts is easy. The insider did it: 6712 − 658 − 1999 = 4055.

The retired v1 relayer.json still holds the full envelope and both nullifiers of an expired transfer that was never broadcast (item ef536b70). Those nullifiers would identify any later spend of the same notes.

This breaks relay-balance.md:82: "A leak of the relayer's files shows who topped up, not who sent what." In code, server/relayer.mjs around line 2126 still returns `cost`. `account` is deleted around lines 2388 and 2961, but `cost` stays.

Fixes:
- At settlement, drop the per-item cost, acceptedHeight, mode and anchor. Keep only total sums plus (txid, fee).
- Round or group service fees so costs are not unique.
- Cut the v1 file down to {id, status, txid} and delete expired envelopes and nullifiers.
- Add a test that no combination of the saved fields lets anyone recompute what each account paid.
- Until this ships, change line 82 to say that a file leak can show who sent what.

### L3. MEDIUM: the anchor plus a batch of one names the sender
The proof's public anchor fixes the tree size. Mints pad the odd leaf with a known zero note. So #3 had exactly one candidate note, and the Hourly batch it waited for held only that transfer. No warning fired, because the old free relayer took no deposits to measure against. For #4 the same method left 2 candidates.

Fixes:
- **Wallet:** before every relayed send, compute and show the anonymity set: the number of other people's notes with value in the tree at the anchor, plus the expected batch size. Warn below about 10 and block below 2 unless the user overrides.
- **Protocol and wallet:** let a send pick an anchor or epoch with more cover.
- **Copy:** say "a batch hides nothing while it holds only your transfer". Make "A batch mode, or waiting, hides this better" depend on the batch size. That string is in bin/murkle.mjs:561, web/src/views/app-shared.js:662/664, relay-balance-contract.md:464/466 and the matching tests.

### L4. LOW: outputs are always in the same order
In a transfer, output [0] is always the recipient and [1] the sender's change. In MINT and MINE, [0] is the real note and [1] the zero padding (src/wallet.mjs). Observers can drop padding and tell payment from change, which shrinks the L3 candidate sets.

Fix: shuffle the two output commitments, and their encrypted notes with them, using a secure random source in buildEnvelope. The circuit does not change.

### L5. LOW: transactions show which software and route made them
nSequence 0xfffffffd marks the retired relayer and the CLI `mine --pay key` route, while web and the paid relayer use 0xffffffff. The fixed fee rounding (2.0 sat/vB) and planSweep's exact fee and input order also identify the client.

Fix: use one nSequence policy and one fee rule across CLI, web and relayer, and randomize input order where the protocol allows.

## 4. What held, by design, and test artifacts
**Held:**
- No recipient or amount of any transfer leaked, insider included.
- No transfer has an output to the receiver.
- Nullifiers, commitments and ephemeral keys never repeated, and every encrypted note was a fixed 95 bytes.
- The sender of #4 was not named.

**Public by design or already disclosed (keep disclosing):**
- Who pays for mints, deploys and claims, plus the token and amount.
- A self-paid claim shows the payer's address. Funding a separate mining key links it to the user, so warn at the moment of funding, not only when moving coins.
- Timing between a top-up and a send.
- Relayed claims can be recognized through bindScriptHash.
- Merged deposit addresses can be recognized as relay deposits, and the ledger and batch waiting counts are public.
- The relayer operator sees which account paid for which carrier.
- The sweep of the old relayer key when it was retired.

**Test-setup artifacts, not protocol leaks:**
- All personas were funded from shared or older wallets. That caused most of the 16 wrong claims, including "alice is the operator".
- The flow analyst used the local, gitignored `.prepublish-deny` file, which is not public data.

## 5. What the copy must say
1. Mints, deploys and claims are public: payer, token and amount. Rewards land in private notes, but the reward amount is public.
2. Self-pay puts the sender's Bitcoin address on chain.
3. Sender privacy depends on how many people use it. On signet today it is thin, and the anchor alone can name a sender.
4. A relay balance links your top-up address to your sends. Until L1 is fixed, everyone can see that link on chain.
5. A batch hides nothing while it holds only your transfer.
6. Until L2 is fixed, a leak of the relayer's files can show who sent what.
7. A separate mining key has to be funded from somewhere, and that funding links it to you.

## 6. Verdict on the proposed tweet
The claim that a private transfer leaves no receiver output, address, sats or inscription, only a ZK proof your browser checks, is **accurate for transfers**. This run confirms that part. Caveats:
1. The browser check exists in code (web/src/session.js:636, `snarkjs.groth16.verify`), but this run did not test it. Run it on 9b3c965f in a clean browser before posting.
2. The tweet must not suggest the sender is hidden. Two of three transfer senders were named.
3. It covers transfers only. Mints and mines are public.

The draft thread in brand/x/README.md needs two changes:
- **Tweet 2 is wrong:** "hides the token, the amount, the sender and the recipient". Remove "the sender".
- **Tweet 3's image is tx 9b3c965f (#3).** That is the one transfer whose sender every analyst named with certainty. Its text is accurate, but consider showing #4 instead.

Corrected Tweet 2:
> How it works:
> 1. Launch in public. Mint for sats, or open it to proof-of-work mining.
> 2. Send privately. A zero-knowledge proof hides the token, the amount and the recipient.
> 3. Verify yourself. Your browser fetches the proof from Bitcoin data and checks it.

Transfer tweet:
> A private Murkle transfer pays nothing to the receiver on chain: no address, no sats, no inscription. Just an encrypted note and a zero-knowledge proof your browser checks.
>
> Mints are public, and sender privacy grows with use. On signet today it is thin.

Optional reply:
> What stays visible: who mints, deploys and pays fees, and when. With few users, timing and the proof's anchor can point to a sender. Recipient and amount stay hidden.

## 7. Bottom line
The core promise holds: no recipient or amount leaked. Relayed transfers do not hide the sender today. Fix L1 before making any claim that relayed sends hide you, then L2, then add the L3 anonymity-set warning, then the small L4 and L5 fixes. Post only the corrected wording.

## 8. Status of fixes
Updated 2026-10-07. The fixes were made in three tracks against one contract (relayer, core wallet, web wallet), then integrated: the shared signing module, the CLI and the docs were brought in line, and the full test suite passes. Nothing was broadcast. The live signet server was not restarted, so it runs the code it started with until the owner restarts it. Verdicts, digests and the circuit are unchanged.

| Leak | Where | Status |
|---|---|---|
| **L1** pool lineage | relayer | Lineage per pool coin, multi-input merges, the `MURKLE_RELAY_MIN_MIX` rule (k = 3 on signet, 5 on mainnet), 409 `pool_thin`, and `relay.balance.mix = { k, coverOk, depositors }` in `/api/relay/info`, in `server/relayer.mjs`. After review: a carrier's coin must descend from at least k + 1 accounts, the same rule for every sender. The first rule ("k accounts other than the sender") let a coin of exactly k accounts carry only the sends of accounts outside it, so its carrier named its sender by exclusion. The published cover now counts only the merge the relayer will actually sign: the first version counted every waiting deposit's account. `coverOk` is false when k is 0, and mainnet refuses k = 0. A spent coin's tags are dropped once its spender confirms. I-PAY is unchanged: housekeeping is paid from margin and sweep charges only. |
| L1 | web wallet | **Fixed.** While `coverOk` is false, the Send form shows the warning, and Send stays disabled until the user ticks "Send it linkable". Only then is the signed field `linkable: true` added. The relay client refuses before signing or sending anything. `coverOk` is the same for every sender, but coins can move between reading it and sending. After a 409 `pool_thin`, the form treats the pool as thin and shows the box. A relayer whose k is below 3 (k = 0 turns its rule off) counts as thin, whatever `coverOk` says. A send the relayer later misses for a thin pool says so in Activity and offers the same "Send it linkable" retry, not a top-up. In Activity, the failed send offers a "Send it linkable" retry. Relayed mining claims need the same box. A linkable send is labeled linkable in Activity. Settings shows the number of separate depositors and whether cover exists. |
| L1 | wallet copy | **Fixed.** No screen lists the sender among what the proof hides for a send that is linkable, sent while the pool is thin, routed through a relayer that publishes no lineage, or self-paid. The Send page lead, the landing FAQ, the payment-link page and the public receipt no longer say the sender is hidden. The receipt now hides the sender's *shielded address*. The Security page discloses the thin-pool link. A thin-pool relayed send is graded Exposed, both on Send and in the portfolio's Crowd Meter. |
| **L2** relayer files | relayer | Settled items are saved through `persistedItem`, with no per-item cost, height, mode or anchor. The retired v1 file is pruned when it is loaded. **That first fix was not enough**, and review proved it: each charge is a fixed function of the carrier's public fee, and the books still held every credit with its account and amount, so credits − balance gave each account's spend and the fees named its carriers. Now the books keep accounts under an opaque key (an HMAC of the account id), never the id, so the files give no deposit address to look up on chain. A credit keeps its account and amount only while its deposit is in the pool or wallets still warn about it as recent (until 5 relayed transfers land after it, at most 144 blocks); then it keeps only its value. A state saved in the old shape is converted when it loads (tested on a copy of the live signet state). Nothing in `data/` was changed by hand. **Still open:** balances stay per account, so an account whose top-ups are all recent can still be matched to its carriers, and with a handful of accounts the balances, public deposit values and public fees can be fitted together. The more people relay, the more ways the numbers fit. |
| **L3** anonymity set | web wallet | **Fixed (advice, never blocking).** Before a relayed or batch send, or a copied envelope (after review: the anchor names the crowd whoever carries it, and "Sender (you)" is listed as hidden only while that crowd is known and not thin), the wallet counts the candidate notes: other people's notes with value in the tree at the proof's anchor. A mint or claim counts once (its zero padding never counts, wherever it sits), and the wallet's own notes are excluded. It also shows the expected batch crowd: the published waiting count plus this transfer. Below 8 candidates, or with a batch crowd of 1, it warns: "Few transfers to hide among: an observer can likely tell this came from you." The batch notes add: "A batch hides nothing while it holds only your transfer." Choosing an anchor or epoch with more cover is not built. |
| L1, L3 | CLI | **Fixed.** `murkle send --relay` and `retry` refuse a thin-pool send (or one through a relayer whose k is below 3) before anything is proved or handed over, and say how to go on: `--linkable` (signed into the request) or self-pay. When the relayer publishes no lineage, they print that the carrier may be tied to the top-up address. A 409 `pool_thin` from the relayer says the same. A linkable send prints that its input can tie it to the top-up address. `mine --pay relay` takes the same `--linkable`. Before proving, the CLI prints the crowd warning below 8 candidate notes (the same count as the web, `src/crowd.mjs`) and, when the batch would hold only this transfer, "A batch hides nothing while it holds only your transfer.", also next to the recent top-up warning. |
| L1 | shared module | `src/relay-account.mjs` signs and checks the optional boolean `linkable` (`OPTIONAL_REQUEST_FIELDS`; the canonical body writes JSON `true` / `false`). Bodies without it sign the same bytes as before. The relayer and the wallet both use it. |
| **L4** output order | core | `src/wallet.mjs` shuffles the two outputs, with their ciphertexts, using a CSPRNG for TRANSACT, MINT and MINE. The circuit is unchanged. |
| L4 | web wallet | **Checked, no change needed.** History, the note list, Activity and the receipt's "my view" find notes by commitment and trial decryption, never by position. A regression test guards this. |
| **L5** fingerprints | core and relayer | One policy is set in `src/btc/funding.mjs`: nSequence 0xfffffffd on every input, fee = ceil(vsize) × a whole sat/vB rate, one 1.25 headroom, inputs shuffled with a bound first input kept first, and the change in a random slot after the OP_RETURN at output 0. The relayer follows the same shape. |
| L5 | web wallet | **Fixed.** Every transaction the built-in keys build goes through that planner with RBF on every input: sends, mints, launches, claims, coin splits, top-ups and moves between keys. A top-up now records the deposit's real output, because the change can come first; it used to assume output 0. Unisat builds its own transactions, so Unisat-paid sends still carry Unisat's fingerprint. |

Tests: `test/privfix-relayer.test.mjs` (relayer), `test/privfix-wallet.test.mjs` (core wallet and funding) and `test/privfix-web.test.mjs` (web) cover the fixes, including the review fixes (the exclusion leak, the fee-based re-attribution, the old-shape load, the copy route, a k below 3, and a send missed for a thin pool); each fails on the code from before them, except a few guards that already passed (L4's position check in the web, and the check that a send with cover is signed with no `linkable` field). The CLI and shared-module parts are covered in `test/relay-balance-cli.test.mjs`, `test/batch-cli.test.mjs`, `test/mine-cli.test.mjs` and `test/relay-account.test.mjs`.

Until the relayer change is live, the copy rules of section 5 stand as written. A thin pool still ties a relayed send to its top-up address. The difference is that the wallet now says so and asks before sending.

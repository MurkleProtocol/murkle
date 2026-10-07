# Murkle (formerly zkpool) — internal audit v0 (2026-10-01), v1 addendum (2026-10-02), v2 addendum (2026-10-03), internal audit v2 (2026-10-04)

This is a self-review, not an independent audit. An external audit of the circuit
and the indexer is required before mainnet.

## Scope and methods
- **Circuit:** `circuits/transaction.circom` (circom 2.2.2, circomlib 2.0.5), 18,411 constraints as pinned (`--O2`, `build/transaction.r1cs`, the count in `build/manifest.json`). The same source gives 18,633 non-linear constraints at circom's default `--O1`; Picus ran on unoptimised `--O0` harnesses (`build/audit/tx_d32.r1cs`: 59,478).
- **Code:** `src/` — indexer, envelope, proof codec, block parser, wallet, keys.
- **Methods:**
  - circomspect 0.9.0, INFO level, output in `circomspect.txt` / `.sarif` (paths repo-relative; a re-run on `circuits/lib.circom` after the templates moved there gives the same 25 findings at the same lines);
  - Picus (Veridise) + cvc5, strong mode, formal underconstraint check;
  - manual review against the SPEC;
  - adversarial tests;
  - `snarkjs zkey verify`.

## Findings
| ID | Severity | Location | Description | Status |
|---|---|---|---|---|
| A-1 | Info (critical had the protections been absent) | envelope / indexer | **Public input aliasing.** Nullifier `n + r` is the same field element but a different string in the nullifier set, i.e. a double spend of the same note. Two protections: strict parsing (field < r) and the check in snarkjs 0.7.5 | regression test |
| A-2 | Low | DEPLOY | `mintAmount > 2^63−1` passed validation, but MINT (`publicAmount` as i64) cannot carry it: the token could never be minted | fixed + test |
| A-3 | **Medium** | block parser | **Merkle root was not verified**: the data source (API) could add, remove or alter transactions in a block while keeping a valid header. A duplicate check (CVE-2012-2459) was added as well | fixed + test |
| A-4 | **Medium** | proof verification | snarkjs accepts the point at infinity and G2 points outside the subgroup (it only checks that points lie on the curve). Found while developing the codec | fixed in `proof-codec.mjs` + test |
| A-5 | Info | circuit ↔ indexer | **Cross-layer invariant.** The circuit does not range-check `publicAmount`; the balance is sound only when `\|publicAmount\| < 2^63`. This is currently enforced by the indexer: i64 in the envelope, TRANSACT = 0, MINT = mintAmount | documented. **Any new operation (unshield) must preserve this invariant** |
| A-6 | Low (economic) | MINT | Someone else's MINT envelope from the mempool could be copied into one's own transaction with a treasury payment. The note still went to the original recipient, but if the copy was included in a block first, the original transaction was rejected and its payment was burned | **fixed**: the MINT body contains `bindOutpoint`, and the indexer requires it to be the first input. Test A-6 + live check on signet. For wallets that select inputs themselves (Unisat), MINT_SCRIPT was added: binding to the payer's scriptPubKey. Test + live check. A mint over the cap still burns the payment — by design, as with Runes |
| A-7 | Info | design | Note encryption is not proven in the circuit. A sender can send a garbage ciphertext, in which case the recipient will not find the note and the payment is effectively burned. Deliberate trade-off (SPEC §1) | documented |
| A-8 | Info | setup | `build/dev` is a single-participant dev setup; `zkey verify` — OK | mainnet: public ceremony tooling ready (docs/CEREMONY.md), open until the ceremony runs; signet: DEV setup by design (its genesis pins it) |
| A-9 | Info | sync | The indexer takes the header chain from the API on trust (does not verify PoW) | partially fixed: headers verified (linkage, proof of work, retarget, MTP, version, checkpoints, most work among what the source serves) in the indexer, CLI and browser replay; receipts check linked or bounded headers, refuse heights above what the chain can have reached and headers that contradict a pinned checkpoint, and say when the bounds are too weak to rule out a cheap forgery (far from a checkpoint); the relayer credits deposits only from header-verified blocks with a merkle proof; a Bitcoin Core RPC source lets an operator index from their own node; open: a single source can withhold blocks; the signet signature (BIP325) is not checked; a receipt far from a checkpoint without the user's replay trusts the source for proof of work (it says so) |

## circomspect: 25 findings, no real issues
| Finding | Count | Verdict |
|---|---|---|
| Arithmetic or comparison on `var` loop counters (`i++`, `i < levels`, `levels - 1`) | 21 | false positive: compile-time integers |
| `sumIns += inAmount`, `sumOuts += outAmount` | 2 | safe: each amount < 2^64 (`Num2Bits(64)`), sum < 2^65 |
| `sumIns + publicAmount === sumOuts` | 1 (included in the 23 above) | safe under invariant A-5 |
| `publicAmount * (asset − publicAsset) === 0` | 1 (included in the 23 above) | safe: a field has no zero divisors |
| WARNING: `Num2Bits(levels)` and aliasing | 1 | false positive: aliasing is only possible at widths ≥ 254 bits, ours is 32 |
| WARNING: `extDataSquare` in a single constraint | 1 | intentional: Tornado pattern, keeps `extDataHash` in the constraint system |

## Manual circuit review (SPEC §4)
- **Nullifier is bound to the position.** `leafIndex` is decomposed with `Num2Bits(32)`, and the same bits
  drive the Merkle path, so a different number with the same position cannot be supplied.
- **Zero inputs (dummies).** Tree membership is skipped only when
  `amount = 0` (`ForceEqualIfEnabled`). The dummy's nullifier is still constrained
  and published. The nullifier of someone else's note cannot be derived without its `sk` and full amount.
- **A single `asset` signal for all notes of a transaction.** Mixing tokens within a transaction is impossible.
  On deposit or withdrawal, `asset = publicAsset`.
- `Switcher.sel` is boolean (bits from `Num2Bits`).
- Outputs: the commitment equals the public value, amount < 2^64.
- Nullifiers are pairwise distinct within a transaction; global uniqueness is checked by the indexer.
- `extDataHash` < 2^248 < r; the circuit only binds it, while the indexer computes it from the envelope bytes.

## Picus: formal underconstraint verification
Picus (Veridise, QED²), using the cvc5 SMT solver over a finite field, proves that the circuit's signals
are uniquely determined by its inputs. To reproduce: `npm run audit:picus`
(`scripts/audit-picus.sh`, ~40 s, requires the `picus:v0` image).

The harnesses in `circuits/audit/` include the same templates from `circuits/lib.circom` as the production circuit.
The production circuit's R1CS is byte-identical (sha256) after the templates were extracted.

| Target | Mode | Result |
|---|---|---|
| `Decoder(3)` from circomlib (known-bad, tool sanity check) | weak | **underconstrained**, counterexample found — the tool works |
| `Keypair` | weak (outputs) | properly constrained |
| `Signature` | weak | properly constrained |
| `MerkleProof(32)` | weak | properly constrained |
| `Transaction(4, 2, 2)` | **strong** (all signals) | properly constrained* |
| `Transaction(32, 2, 2)` — production depth | **strong** | properly constrained* |

\* Without preconditions, Picus resolved 16,090 of 16,095 signals (same picture at d32). The only
unresolved signals were circomlib `IsZero` signals:
- `inCheckRoot[0..1].isz.inv` and `.isz.out` (in `ForceEqualIfEnabled`);
- `sameNullifiers[0].isz.inv` (in `IsEqual`).

`IsZero`: `inv <-- in≠0 ? 1/in : 0; out <== 1 − in·inv; in·out === 0`.
- When `in ≠ 0`, we get `out = 0` and `inv = 1/in` — both unique.
- When `in = 0`, we get `out = 1`, and `inv` is arbitrary. But `inv` is not used anywhere else, so
  the freedom of this auxiliary signal is not a vulnerability.
- In `sameNullifiers`, the case `in = 0` is ruled out by the constraint `out === 0`.

With a precondition assuming uniqueness of only the three `inv` signals, Picus **itself proved** the uniqueness of all other
signals, including `isz.out`. Conclusion: **apart from the auxiliary `inv` signals in `IsZero`,
there are no underconstrained signals in the circuit.**

What Picus does not prove:
- it checks uniqueness, not correctness of the formulas: fully constrained but incorrect
  logic would pass. Logical correctness is covered by the manual review and adversarial tests;
- it does not cover cross-layer invariants (A-5).

## What this audit does NOT prove
- Correctness of the circomlib templates themselves is taken on trust: they are widely used and audited.
  Picus confirmed the uniqueness of their signals as we use them.
- **Groth16 proof malleability.** From someone else's proof, a different proof can be derived
  for the same public inputs. This does not enable a double spend (the nullifiers are the same);
  it only affects the copy's txid (see A-6).
- Network-level privacy and linkage through the wallet that pays the fees (a relay balance removes the payer address from the transfer, but the relayer links the top-up address; see the v2 addendum).

## v1 addendum (2026-10-02)
The protocol was renamed (magic `mrk`, addresses `mrk1…`, labels `murkle/*`). The circuit did not change: the r1cs is byte-identical, so the Picus and circomspect results above still apply.

- **Phase 1.** The setup now uses the public Perpetual Powers of Tau transcript `powersOfTau28_hez_final_15.ptau`.
  - It is accepted only when its sha256 and the blake2b-512 published in the snarkjs README match, and `snarkjs powersoftau verify` passed.
  - Phase 2 is still a DEV single-party contribution (A-8 unchanged).
  - The setup script never prints contribution entropy. A first build that did print it was discarded and rebuilt.
- **Genesis anchor.** Artifact hashes are pinned in `src/pins.json`. The server and CLI refuse a verification key that does not match the pin. Replays require the ATTEST genesis transaction, which is live and pinned: `4c32443828131fe142d899007c1b8885aef7e62da3034c6f03e4ff7096c6dfad`, mined at activation height 324,592 on signet.
- **Digest v1.** A versioned state digest per height (root, nullifier and log accumulators, asset table) lets anyone compare an independent replay with the indexer, height by height.

| ID | Severity | Where | Issue | Status |
|---|---|---|---|---|
| A-10 | Invariant | protocol / relayer | TRANSACT validity must never depend on its carrier transaction: `extDataHash` covers only the envelope body. Any future unshield must put its BTC destination and any relayer fee inside the body bound by `extDataHash`. | documented; relied on by anyone who carries an envelope (copy envelope and the paid relayer) |
| A-11 | Low | prevout lookup | `prevoutScript` (used by MINT_SCRIPT) now reads raw transaction hex and checks its txid before using the output script, instead of trusting the explorer's JSON. | fixed (v1) |
| A-12 | Medium | indexer / MINT_SCRIPT | **A MINT_SCRIPT carried in a coinbase halted every replayer.** The binding check looked up the output spent by the first input, but a coinbase's only input is the null outpoint, which no data source can serve, so the server, the CLI and the browser all retried that block forever. Such a MINT_SCRIPT is now rejected as `MINT not bound to this payer` with no lookup (SPEC §7). Only block producers can build one; none exists on signet since activation height 324,592, so no past verdict changes. Blocks also apply all or nothing, so a failed lookup never leaves a half-applied block. | fixed (v1 review round) + test |
| W-1 | Invariant | wallet | An envelope handed to anyone (relayer or mempool) stays valid until `anchor + 100`, because anyone can re-carry it. Its notes may only be used to retry that same transfer until then, or until its nullifiers are spent, so a retry can never double-pay. | implemented in the wallet; tested |
| R-1 | Info | relayer | A relayer cannot alter or redirect a transfer and sees no plaintext, but it sees the submitter's IP and timing. Liveness and censorship by IP are trusted. The free relayer this row first described ("Ghost Relay") is retired, see R-2. | documented in the UI and README |
| R-2 | High (operator funds) | relayer | **A sponsored relayer can be drained by anyone.** The free relayer ("Ghost Relay") paid every private transfer's carrier from the operator's own BTC. A zero-value transfer is valid and needs no tokens (an input with `inAmount = 0` skips the Merkle check, `ForceEqualIfEnabled`), so anyone with CPU for proofs could make it pay carrier fees without end. Budget caps, rate limits and the proof-of-work only capped the loss per day and turned it into a denial of service. | fixed: the free relayer is retired (stage 0 of `docs/design/paid-relay.md`); the server refuses to start a relayer without a relay balance configuration, and relaying is paid only from prepaid relay balances, in confirmed BTC credited before carriage (R-3). Test: `test/paid-relay-stage0.test.mjs` |

## v2 addendum (2026-10-03): relay balances
Relaying returns as an option paid from a prepaid **relay balance** (`docs/design/relay-balance.md`, binding interfaces in `docs/design/relay-balance-contract.md`). A user tops up with a plain BTC payment to a fresh deposit address of their relay account; after the deposit confirmations (1 on signet, 3 on mainnet) the relayer credits it, less the cost of later spending that coin; each relayed send is charged its exact carrier fee plus a margin before the carrier is signed. No consensus change and no circuit change: the circuit, `build/`, `src/pins.json` and the indexer rules are untouched, and the Picus and circomspect results above still apply.

**I-PAY (operator-funds invariant):** every satoshi the relayer spends as a miner fee is covered by user money that was deposited, confirmed and credited to the account that caused the spend (or to the margin account, which only margins and deposit sweep costs fill), before the signature is released. Three parts, each enforced by one function in `server/relayer.mjs` or `server/relay-books.mjs`:
- **I0, provenance** (`Relayer.assertProvenance`): every input must be a coin in the relayer's own coin set, either a credited, non-reversed deposit or a `change` output of a transaction in its journal. The relayer never lists an address, so coins anyone else sends to its keys (a dust flood, an operator top-up) are never counted or spent. There is no command, endpoint or setting that funds the relayer; only `credit` adds coins.
- **I1, coverage** (`Relayer.signPoolTx`, the only signing call site in `server/relayer.mjs`): checks the outputs (output 0 is the item's own OP_RETURN, every other output pays the change key `C`, never a deposit address), applies I0, computes the fee from the final transaction's amounts, charges it with `RelayBooks.settle` (fee plus margin, from the item's reservation, else the available balance; `balance_low` makes the item `missed` and nothing is signed) or `payHousekeeping` (fan-outs and merges, from the margin), checks that the pool's recorded unspent coins still cover all balances, reservations and the margin, and only then signs and journals the transaction before broadcasting it. No path bumps a carrier (no RBF, no CPFP).
- **I2, books** (`Relayer.checkBooks` over `RelayBooks.checkI2`): after every credit, every tick that saw a new block and at startup, Σ credited deposits − Σ fees paid − Σ balances − Σ reservations = margin ≥ 0, and the pool's recorded unspent coins ≥ balances + reservations + margin. On any mismatch the relayer sets `halted`: it answers 503 `halted` and signs nothing new, while self-pay and copy keep working.

Other review points of the relay balance design (`relay-balance.md` §7, ten findings from an internal adversarial review, all closed): one deposit can be credited only once (strict outpoint parsing to one key, an in-memory claim before any network call, one durable write; a repeat answers the existing credit); request signatures bind the endpoint, network, pool key and body; carrier change never goes to a deposit address and the relayer's own outputs are never credited; a batch item its balance cannot pay at release becomes `missed` and the rest of its epoch goes out, so one account never holds an epoch; a saved state file holds no account id next to a carrier txid once the carrier is settled. Privacy limits are disclosed, not fixed: the operator can link the address that topped up a balance to every transfer relayed with it, and a send right after a top-up confirms is easy to link by timing while few people relay.

| ID | Severity | Where | Issue | Status |
|---|---|---|---|---|
| R-3 | Invariant | relayer | **I-PAY: the operator never pays any part of a user's transaction.** I0 provenance (`assertProvenance`), I1 coverage (`signPoolTx`, the only signing call site, which charges the exact fee before any signature) and I2 books (`checkBooks` / `RelayBooks.checkI2`, which halts the relayer on any mismatch). | implemented in the relayer; tested in `test/relay-books.test.mjs`, `test/relay-balance-relayer.test.mjs`, `test/relay-account.test.mjs`, `test/relay-balance-cli.test.mjs` and end to end in `test/relay-balance-e2e.test.mjs` |

## Internal audit v2 (2026-10-04)
A second internal audit of every system of the project, run on 2026-10-04 against this checkout and the live signet deployment. It is not the "v2 addendum" above, which documents the relay balance design. Like the rest of this report it is a self-review, not an independent audit.

### Scope
Nine areas, each with its own auditor:
1. **Circuit:** `circuits/transaction.circom` and `circuits/lib.circom`, the build and its pins, the setup, the proof codec and the public-signal order.
2. **Indexer and protocol:** `src/envelope.mjs`, `src/indexer.mjs`, the digest, genesis, snapshots, `src/sync.mjs`, keys and note encryption, all against SPEC.md.
3. **Bitcoin data layer:** `src/btc/*` (block and transaction parsing, the Esplora client, funding and fee math, deposit derivation) and `scripts/send-btc.mjs`.
4. **Server and API:** `server/indexer-server.mjs` (static files, headers, query validation, relay endpoints, link-preview tags), `server/retired-relay.mjs` and `docs/API.md`.
5. **Relayer:** `server/relayer.mjs`, `server/relay-books.mjs`, `src/relay-account.mjs`, I-PAY (I0, I1, I2) and batch timing.
6. **Web wallet:** `web/src` (vault, session, keystore, the payers: built-in key, Unisat, Copy envelope and relay balance; behaviour across tabs; markup escaping).
7. **In-browser verification:** `src/verify-tx.mjs` and `web/src/verify/*` (receipts, pool replay, Root Match) and the provenance chips and wording that report them.
8. **CLI and supply chain:** `bin/murkle.mjs`, the publish tooling (`scripts/prepublish-check.mjs`, `fetch-artifacts`, `release-assets`, `build-circuit`), the lockfile, `npm audit`, the Dockerfile and CI.
9. **Live consistency:** the running deployment compared with Bitcoin and with the repository.

Live checks, all read-only: the indexer API on :8787 (paid relayer on, balance mode), the Vite server on :5173 and the relay balance state in `data/signet/relay-balance/`, which holds real signet deposits. Nothing was written to `data/`, no server was stopped or restarted, nothing was broadcast, and no key, wallet file or recovery phrase was printed or copied.

### Method
- One independent auditor per area, working against a snapshot of the sources taken before the audit. Reproductions were written as scratch tests and scripts outside the repository.
- Two skeptics reviewed every candidate finding and tried to refute it (a misread of the code, an unreachable path, a case already handled). Of 65 candidates, 20 were rejected and 45 confirmed. Three issues were reported by two areas and keep both IDs (V2-26 = V2-10, V2-42 = V2-06, V2-45 = V2-14), so there are 42 distinct issues.
- Five fix groups (protocol, server and relayer, web, CLI and tooling, docs) and one integration pass. Every fix has regression tests in `test/audit2-*.test.mjs`. The protocol group also ran its new tests against the pre-audit sources: each fails there, and the V2-08 test hangs, which is the bug.
- Consensus and circuit changes were not made; they are owner decisions (below).
- After the integration pass the full suite (`npm test`) passed: 606 tests, 0 failures.

### Findings
No critical or high findings; 3 medium, 34 low and 8 info. 42 are fixed, 2 partially fixed, 1 open (owner decision). Test files are `test/audit2-<name>.test.mjs`.

| ID | Severity | Area | Finding | Status |
|---|---|---|---|---|
| V2-01 | Low | supply chain (found by the circuit auditor) | **Vite 6.3.5 dev server and underscore (via snarkjs, bfj, jsonpath) have known advisories; npm audit reported 4 high** | partially fixed: vite ^6.4.3 and an underscore 1.13.8 override in package.json and the lockfile (`npm audit --package-lock-only`: 0) + test `audit2-tooling`; the installed packages and the running Vite stay old until the owner runs `npm ci` and restarts |
| V2-02 | Low | indexer | **A DEPLOY ticker with a UTF-8 BOM decodes to a plain ASCII ticker, so a SPEC-conformant replayer would diverge** | fixed on mainnet from genesis (raw ticker bytes must be 1-16 of A-Z0-9); signet keeps the historical rule, and the integration replay checks that no signet DEPLOY is affected |
| V2-03 | Low | indexer | **SPEC omitted two DEPLOY rules the decoder enforces (mintAmount at most 2^63-1, endHeight not before startHeight)** | fixed (SPEC §7) + test `audit2-protocol` |
| V2-04 | Low | indexer | **The OP_RETURN payload extraction rule was under-specified** | fixed (SPEC §6 rule 1 states the exact rule; code unchanged) + test `audit2-protocol` |
| V2-05 | Low | indexer | **SPEC claimed a pool withdrawal bound that does not exist and overstated what the cap guarantees** | fixed (SPEC §6 corrected; the check ships with withdrawals) + test `audit2-docs` |
| V2-06 | Info | indexer | **treasurySats counts the minter's change paid back to the treasury script** | fixed: defined as gross sats in SPEC §11, relabelled on the token page and in the CLI + test `audit2-protocol`, `audit2-integration` |
| V2-07 | Low | bitcoin | **Esplora.feeRate() worked only against mempool.space, so MURKLE_ESPLORA broke the relayer and every CLI carrier command** | fixed + test `audit2-protocol` |
| V2-08 | Low | bitcoin | **txSizes() looped without bound on hostile raw-tx hex and hung the in-browser verifier** | fixed + test `audit2-protocol` |
| V2-09 | Low | bitcoin | **scripts/send-btc.mjs built non-relayable transactions (dust change, early stop, fixed 1 sat/vB)** | fixed + test `audit2-tooling` |
| V2-10 | Low | server | **Any /embed/* path made the whole wallet app frameable** | fixed (headers deny framing everywhere; client frame guard) + test `audit2-server`, `audit2-integration` |
| V2-11 | Low | server | **/api/state tipHash and recentHashes read the live indexer, not the published view** | fixed + test `audit2-server` |
| V2-12 | Info | server | **/api/roots?height= with an empty value answered 404 instead of 400** | fixed + test `audit2-server` |
| V2-13 | Info | server | **og:image and twitter:image were relative when MURKLE_PUBLIC_URL is unset** | fixed + test `audit2-server` |
| V2-14 | Info | server | **docs/API.md left deploys, attests and height out of /api/stats** | fixed + test `audit2-docs` |
| V2-15 | **Medium** | relayer | **The real explorer answers 200 {confirmed:false} for an unknown txid, so the relayer's "explorer does not know this txid" branches never ran in production** | fixed + test `audit2-server`, `audit2-integration`; the test explorer now answers like mempool.space |
| V2-16 | Low | relayer | **A lone deposit was never merged at 3 sat/vB or more, yet sends were accepted with 202 and then expired** | fixed + test `audit2-server` |
| V2-17 | Low | relayer | **item.unknownOutcome was write-only: a carrier whose first answer was lost could later be refunded and still be mined** | fixed for carriers + test `audit2-server`; see the residuals below for merges and fan-outs |
| V2-18 | Low | wallet | **The relay deposit address used the network the server reported, so a hostile relayer could show a mainnet address labelled SIGNET** | fixed + test `audit2-web` |
| V2-19 | Low | wallet | **With localStorage full, a vault write went to memory and the next pull deleted the new W-1 entry** | fixed + test `audit2-web` |
| V2-20 | Low | wallet | **After an indexer switch, top-ups derived deposit addresses from the old relayer's pool key** | fixed + test `audit2-web` |
| V2-21 | Low | wallet | **An indexer switch kept the old indexer's log and verdicts** | fixed + test `audit2-web` |
| V2-22 | Low | wallet | **The W-1 reservation started only after proving, so two tabs could spend the same notes** | fixed + test `audit2-web` |
| V2-23 | Low | wallet | **Lock in one tab left every other tab unlocked** | fixed + test `audit2-web` |
| V2-24 | Low | wallet | **Streamer mode in one tab did not mask other open tabs** | fixed + test `audit2-web` |
| V2-25 | Low | wallet | **Unisat payments never re-checked that Unisat was still on signet** | fixed + test `audit2-web` |
| V2-26 | Low | wallet | **Every /embed/* path served the full wallet app without framing protection (same issue as V2-10)** | fixed with V2-10 + test `audit2-server` |
| V2-27 | Low | wallet | **The Settings phrase reveal stayed visible when the window lost focus** | fixed + test `audit2-web` |
| V2-28 | Low | verification | **A rebuild-root mismatch (indexer caught inconsistent) was reported as a failed proof that agreed with the browser** | fixed + test `audit2-protocol` |
| V2-29 | **Medium** | verification | **A pairing failure against an untrusted anchor root counted as a rule violation and agreed with an indexer rejection** | fixed + test `audit2-protocol`, `audit2-integration` |
| V2-30 | Low | verification | **An indexer that accepts a double spend or an over-cap mint got "They agree" with a YOU chip** | fixed (history rules labelled IDX unless a local replay covers them) + test `audit2-protocol`, `audit2-integration` |
| V2-31 | Low | verification | **A root rebuilt from indexer-served commitments was labelled YOU, as were Root Match and "State verified"** | fixed + test `audit2-web` |
| V2-32 | Low | verification | **A saved replay's root was used without checking the anchor block was still on the active chain** | fixed + test `audit2-web` |
| V2-33 | Low | cli-supply | **CLI wallet files were written world-readable, non-atomically, and last writer wins across concurrent commands** | fixed + test `audit2-tooling` |
| V2-34 | Low | cli-supply | **Relay commands accepted plain http:// to any host, so a network attacker could redirect top-ups** | fixed + test `audit2-tooling` |
| V2-35 | Low | cli-supply | **pending and retry asked the wrong relayer whether relaying was open, then looked up batch entries before release** | fixed + test `audit2-tooling` |
| V2-36 | Low | cli-supply | **deploy and attest genesis silently ignored unknown or mistyped flags** | fixed + test `audit2-tooling` |
| V2-37 | Low | cli-supply | **Self-paid send wrote its W-1 entry only after broadcast and did not validate the amount** | fixed + test `audit2-tooling` |
| V2-38 | Info | cli-supply | **.dockerignore missed secret patterns, the runtime code was writable by the service user, images and actions are pinned by tag** | partially fixed: secret patterns added and code copied as root + test `audit2-tooling`; image and action digests are not pinned |
| V2-39 | Info | cli-supply | **The powers-of-tau download was not size-capped before hashing** | fixed + test `audit2-tooling` |
| V2-40 | **Medium** | live-consistency | **murkle audit stopped on the first network reset and threw away the whole replay** | fixed + test `audit2-protocol`, `audit2-integration`; confirmed live (below) |
| V2-41 | Low | live-consistency | **The CLI and the live server wrote the same state.json through the same temp path** | fixed (unique temp files; the CLI keeps cli-state.json) + test `audit2-protocol`, `audit2-integration` |
| V2-42 | Low | live-consistency | **"Treasury received" counted the minter's change (same issue as V2-06)** | fixed with V2-06 + test `audit2-integration` |
| V2-43 | Low | live-consistency | **README said MURKLE_ALLOW_UNPINNED relaxes the verification key check; it only relaxes the manifest check** | fixed + test `audit2-docs` |
| V2-44 | Info | live-consistency | **/api/state.artifacts was a startup snapshot, never rechecked against the files served** | fixed + test `audit2-server` |
| V2-45 | Info | live-consistency | **docs/API.md left fields out of /api/stats (same issue as V2-14)** | fixed with V2-14 + test `audit2-docs` |

**V2-15 (Medium, relayer): unknown txids looked "known" in production.** `Relayer.statusOf()` returned null only when the explorer's `/tx/<txid>/status` answered 404, but Esplora and mempool.space answer `200 {"confirmed":false}` for a txid they have never seen (checked live). The test explorer threw a 404 instead, so the suite never exercised the real behaviour. In production a carrier the node refused once became "broadcast" with a final charge and no refund, its real input was marked spent, and a phantom change coin entered the coin set; a merge or fan-out whose broadcast was lost stayed pending forever with spendable phantom outputs; a deposit double-spent by a reorg was never reversed. Because the phantom coins counted toward the pool, the I2 check could not see a real shortfall. Reproduced with the project's harness. Fix: `statusOf()` reads `GET /tx/<txid>`, which does answer 404 for an unknown txid, and the test explorer now answers like mempool.space, so the whole relay suite runs against the real behaviour. The fix makes the refund and reversal paths reachable; V2-17 closes the one that could refund a carrier that may still be mined. The live books match the chain (below).

**V2-29 (Medium, verification): a dishonest indexer could make an honest payment look invalid with the browser's apparent backing.** When the receipt's anchor root came from the indexer (IDX) or from a rebuild of the indexer's own commitment list, a failed pairing check was still reported as a rule violation by the transaction, and an indexer rejection was shown as "Agrees with your browser", with "Proof failed" and a red seal. A failure there only shows that the proof does not verify against the root the indexer supplied. Fix: only a root from the user's own replay turns a pairing failure into a rule violation; with an IDX or rebuilt root the step is inconclusive (fault `data`), an indexer rejection is not reported as agreement, an indexer acceptance becomes a mismatch, and the receipt says "Doesn't verify against the indexer's root" and links to Verify the Pool. V2-28 (an inconsistent indexer root) and V2-31 (rebuilt roots labelled YOU) are the related low findings.

**V2-40 (Medium, live consistency): the documented terminal check could not finish.** `Esplora.request()` retried only HTTP 429, so one connection reset or 5xx aborted `murkle audit`, which replays in memory, and lost all progress. In this audit `murkle audit --compare http://localhost:8787` failed 2 runs out of 2 (`fetch failed`, ECONNRESET, at blocks 324,878 and 324,894 of 324,917). Fix: reads (GET and HEAD) retry network errors and 5xx with exponential backoff; a broadcast (POST) is never retried, because it may have reached the node; `audit` now reports the last block applied when it stops. After the fix the same command finished on the first try (below).

### Owner decisions (not fixed)
- **V2-02, consensus change.** Rejecting a ticker whose raw bytes are not `[A-Z0-9]{1,16}` (or decoding with `ignoreBOM: true` plus a byte-length check) changes which DEPLOYs are valid. No BOM or malformed DEPLOY exists on signet (one DEPLOY, plain ASCII), so applying it now would change no past verdict, but it must be announced as a protocol change with a regression test. Decided 2026-10-06: the strict rule applies on mainnet from its genesis; signet keeps the historical decoder.
- **V2-05, future consensus rule.** When withdrawals (negative `publicAmount`) are enabled, `checkTx` must reject a withdrawal larger than `pool[asset]` and lower the pool, in the same change that updates SPEC §6. `test/audit2-docs.test.mjs` fails if the check is added while SPEC still says the bound does not exist.
- **No circuit change** was found necessary.
- **Operations** (not consensus, but they need the owner because the audit could not restart servers): restart the indexer on :8787, which still serves the pre-fix code (framing headers, relayer V2-15/16/17, artifact recheck, `/api/state` hashes) until then; run `npm ci` so the installed vite and underscore match the lockfile (V2-01), optionally with `server.ws: false` unless `MURKLE_HMR=1`; pin `node:22-alpine` and the GitHub actions by digest (V2-38); optionally pin the relayer pool key in the CLI (V2-34); relax framing only for `/embed/t/:TICKER` once that view exists (V2-10).

Known residuals, not confirmed as separate findings: a merge or fan-out whose first answer was lost and that is then refused has the same gap as V2-17 had for carriers (`reconcileFanouts`); a broadcast carrier that expires without being mined leaves its change coin spendable in the coin set (pre-existing); `treasurySats` stays a gross figure (5,904 sats live against 2,000 sats of price × mints), now documented and labelled as such; `murkle audit` cannot resume a stopped replay.

### Live-system results
- **Replay audit.** Before the fix, `node bin/murkle.mjs audit --compare http://localhost:8787` failed 2 of 2 runs (V2-40); with a scratch fetch-retry preload it matched the live indexer at every height up to 324,917 (326 heights; digest at the tip `b65b5afb…f0b1` equal to `/api/state.digest`). After the fix, with no preload: `OK up to 324924 (333 heights compared)`, 54 s, 37.6 MiB, 9 envelopes (9 accepted, 0 rejected), 14 notes, 14 nullifiers, digest at 324,924 `e890e753…7600`, equal to `/api/state.digest` at that height.
- **Artifacts.** The files served at `/artifacts/*` hash to `src/pins.json`: wasm `7b9f73d4…`, zkey `511df703…`, vkey `893e1259…`, manifest `41d28d88…`; `/api/state.artifacts` reports ok. A rebuild with circom 2.2.2 `--O2` in scratch gives the same r1cs (`382e5c0a…`, 18,411 constraints) and wasm; `snarkjs zkey verify` against the pinned powers of tau answers `ZKey Ok!` with one DEV contribution (A-8).
- **I2 books against the chain.** `data/signet/relay-balance/relayer.json` (read only): credited 7,000 − fees 710 − balances 6,054 − reserved 0 = 236 = margin, margin ≥ 0, liabilities 6,290. On chain (mempool.space signet, tip 324,917): the change key holds exactly one coin of 6,290 sats, confirmed; the deposit of 7,000 sats was merged (fee 112) and one carrier paid 598, so on-chain fees 112 + 598 = 710 equal the books. Pool coins 6,290 ≥ liabilities 6,290: I2 holds, with zero slack. Deposit addresses n=1 and n=2 and the pool key's own address have no history; the retired v1 key's address has 0 unspent outputs. No key was printed.
- **State.** The depth-32 tree rebuilt from `/api/commitments` equals `/api/state.root`; `/api/roots`, `/api/digest`, `/api/stats`, `/api/assets` and `/api/log` agree; `tipHash` equals mempool.space's block hash. MURK supply 4,000 = 4 mints × 1,000, and all 4 mints are confirmed and pay at least 500 sats to the treasury. The genesis ATTEST is log entry 0 at 324,592. CLI wallet balances from the live API equal those from the saved state (2,000 of 4,000 MURK). Live relay parameters (margin, per-send fee, minimum deposit, sweep cost, caps, epochs, safety windows) match README, SPEC §14.2 and the relay design docs.

### Checks that passed, per area
- **Circuit:** reproducible build (r1cs and wasm byte-identical); `zkey verify` OK and the exported vkey equals the pinned one; public-signal order matches SPEC §4 and every verifier call site; public inputs are canonical (decoder and snarkjs both reject values ≥ r); the proof codec rejects infinity, non-canonical and off-curve points and G2 points outside the subgroup (fuzzed); manual soundness review of nullifiers, membership, asset binding, ranges, conservation and `extDataHash`; circomspect gives the same 25 results; the six Picus harnesses rebuild byte-identical to the ones Picus proved, so those results still apply.
- **Indexer:** fixed lengths, canonical fields and i64 amounts in the decoder; anchor window, nullifier rules within and across blocks, mint binding, window, cap and treasury rules; atomic block apply and `rollbackTo` restore every component; digest v1 matches SPEC §10 byte for byte; genesis rule; snapshot versioning and archiving; sync checks block hashes, linkage and merkle roots.
- **Bitcoin:** live blocks parse with matching block hashes and txids; prevouts are re-hashed against their txid (A-9 limits); fee planning never underpays across 48 cases; dust limits match Bitcoin Core; deposit key derivation matches for random pool keys; outpoint parsing is strict.
- **Server:** no path traversal (including Windows forms) in static files or artifacts; query validation and range caps; the per-transaction privacy rule (`/api/log?txid=` refused); escaped link-preview tags; body limits, slow-request cutoff, generic 500s; headers and methods as documented.
- **Relayer:** I2 holds live; the books keep their identity under every operation; one deposit is credited once; request signatures bind endpoint, network, pool key and body; I1 checks outputs, fee bounds and coverage before the only signing call; I0 provenance; journal before broadcast; carriers are re-sent with the same bytes and never re-signed; housekeeping is paid from the margin only.
- **Wallet:** all markup goes through the escaping `html` template; links are fixed or validated; the keystore (scrypt, fresh XChaCha20 nonce per seal, NFKC passwords) and legacy migration; W-1 hand-out order and retries with the same notes; deposit addresses derived locally and compared with the server's; built-in key top-ups reviewed before broadcast.
- **Verification:** a live receipt for a signet transfer verified end to end with correct provenance on every step; raw bytes re-hashed to the txid; merkle inclusion and its honest wording about proof of work; vkey pinned before use; data failures stay inconclusive; the pool replay reads only mempool.space and compares a cumulative digest; no per-transaction requests to the indexer; required disclosures present.
- **CLI and supply chain:** lockfile integrity and exact pins for circomlib and snarkjs; only esbuild and fsevents have install scripts; CI permissions are read-only with no expression injection; `fetch-artifacts` and `release-assets` check every hash; `build-circuit` refuses to rebuild a pinned genesis; `prepublish-check` reads secrets without printing them; I-PAY holds in the CLI (no command funds the relayer).
- **Live consistency:** replay audit, artifacts, circuit rebuild, stats, supply, root, genesis, wallets, relay books and parameters as listed above.

### Limits of this audit
- **Internal only.** The auditors, skeptics and fixers are the project's own; this is not an external audit, and none has been done yet.
- **A-8 and A-9 remain (status 2026-10-06, mainnet readiness):** on signet the phase-2 setup stays a single-party DEV contribution by design, and mainnet has no proving key until the public ceremony runs (its tooling is ready, docs/CEREMONY.md). Headers are now verified from pinned checkpoints (proof of work, difficulty rules, timestamps, most work), but a single data source can still withhold blocks, and the signet block signature is not checked.
- Picus was not re-run (Docker was not running); its earlier results apply because the harnesses rebuild byte-identical.
- The live servers were not restarted, so the deployment was checked as it runs, on the pre-fix code; the fixes are verified by tests, a production build in scratch and the dev server.
- Nothing was broadcast and no browser wallet was used: broadcast, Unisat and fee paths were tested with fakes, and the relayer with an explorer fake modelled on mempool.space.
- The 20 rejected candidates are not listed. Network-level privacy and the internals of circomlib and snarkjs were out of scope.

## Tests
The suite runs with `npm test`; the current count is generated into `web/src/facts.json` on every web build, not hardcoded here.
Regression tests for the findings:
- A-1…A-3 in `test/envelope.test.mjs`;
- A-6 in `test/indexer.test.mjs`;
- A-12 in `test/r2-protocol-docs.test.mjs`, and all-or-nothing block application in `test/fix-protocol.test.mjs`;
- relayer behaviour in `test/relayer.test.mjs`;
- R-3 (I-PAY) in `test/relay-books.test.mjs` (the books and I2 under random sequences), `test/relay-balance-relayer.test.mjs` (I0 and I1 at the relayer: dust floods, outputs, single signing call site, missed items, halting) and `test/relay-account.test.mjs` (accounts, deposit addresses, outpoints, request signatures); the CLI and docs in `test/relay-balance-cli.test.mjs`; end to end (wallet client over HTTP to the relayer on a synthetic chain: credit once, exact charge, provenance, missed batch item, foreign coins never spent, retired key refused) in `test/relay-balance-e2e.test.mjs`;
- the verification engine in `test/verify-tx.test.mjs`;
- internal audit v2 (V2-01…V2-45) in `test/audit2-protocol.test.mjs`, `test/audit2-server.test.mjs`, `test/audit2-web.test.mjs`, `test/audit2-tooling.test.mjs`, `test/audit2-docs.test.mjs` and `test/audit2-integration.test.mjs`; the findings table parser (V2 ids, open and partially fixed states) in `test/web-shell.test.mjs`;
- the mining invariants (W-M, I-PAY extended, M-ACT, M-ERR, M-ORD, M-POOL, M-FEE) in `test/mine-vectors.test.mjs`, `test/mine-indexer.test.mjs`, `test/mine-client.test.mjs`, `test/mine-relayer.test.mjs`, `test/mine-web.test.mjs` and `test/mine-cli.test.mjs` (see the Mining addendum);
- the privacy trace fixes (P-1…P-5, `docs/design/privacy-trace-test.md` section 8) in `test/privfix-relayer.test.mjs`, `test/privfix-wallet.test.mjs` and `test/privfix-web.test.mjs`;
- English-only and claims guards in `test/english.test.mjs`.

## Mining addendum (2026-10-05)
Mining (`docs/design/mining.md`; binding interfaces in `docs/design/mining-contract.md`) adds DEPLOY_POW (op 9), MINE (op 7) and MINE_SCRIPT (op 8): tokens issued by Argon2id proof of work, each reward in a private note. There is no circuit change and no new trusted setup: a MINE claim reuses the MINT proof shape, so the Picus and circomspect results above still apply. The rules apply only at and above the `mining` activation height in `src/pins.json`, which is `null` in this release: on the live chain ops 7, 8 and 9 stay `malformed: unknown op N` and every digest stays v1.

Owner decisions: the service fee goes to the platform only (500 sats per claim to the signet operator's address, `MINE_FEE.platformAddress` in `src/params.mjs`, the same key as the MURK treasury; no deployer fee, so a DEPLOY_POW must carry a claim fee of 0); mining ships before BATCH, so it is digest v2; `hash-wasm` 4.12.0 (MIT, exact pin) is the Argon2 implementation on every side, with `@noble/hashes` as the reference and fallback; the constants of `mining.md` §14 (`MINE_WINDOW` 12, `STALE_FACTOR` 4, `MIN_DIFFICULTY` 256, span 12 to 432, 16 ≤ S ≤ 100 × span). On 2026-10-06 the owner removed the 144-block lead (`MINE_LEAD`) between a launch and the first usable reference block: the deployer starts mining now (the first usable reference is the launch block itself, whose hash nobody knows before it is mined) or after N blocks, `mineStart = max(startHeight, deployHeight)`, so no reference before the launch block is valid, and the copy says that starting now favours whoever is ready first while a delay gives everyone time to see the terms. The operator pays no part of any claim. Like the rest of this report it is a self-review.

| ID | Severity | Where | Invariant | Status |
|---|---|---|---|---|
| W-M | Invariant | wallet / CLI | **A solution is submitted once, by one route, and stays locked until it lands or block ref + 12.** The web wallet and `murkle mine` write the claim's entry before it leaves the machine; the notes rolled into it stay locked for the same time; each new tip and each found solution gets a fresh draft (new commitments, nullifiers and ciphertexts), so no two claims share either; a relayed claim is never paid from the user's own key. | implemented in the wallet and the CLI; tested in `test/mine-client.test.mjs`, `test/mine-web.test.mjs` and `test/mine-cli.test.mjs` |
| I-PAY extended | Invariant | relayer | **Every satoshi that leaves the pool, as a miner fee or as a service-fee output, is covered by a recorded debit of the account that caused it before the signature is released.** I0: every output except the OP_RETURN pays the change key C or is a required service-fee output of the carried envelope with exactly the required script and amount. I1: `signPoolTx` refuses unless the coins spent equal fee + service and `settle(ref, { fee, service })` charged them. I2: credited − fees − serviceOut − Σ balances − Σ reserved = margin ≥ 0, and a refunded carrier reverses its `serviceOut`. MINE carriers spend confirmed coins only, their change is not spent before it confirms, and they are never bumped. | implemented in the relayer; tested in `test/mine-relayer.test.mjs` |
| M-ACT | Invariant | indexer | **Below the activation height nothing changes: verdicts and digests stay byte-identical.** Ops 7, 8 and 9 are `malformed: unknown op N` from the header alone, even when the body would not decode, and the digest stays v1. A replay of `test/fixtures/v1-chain.json` (a DEPLOY_POW, a MINE, a MINE_SCRIPT, a truncated op 9 and more, all below activation) gives the log and the digests of the pre-mining indexer with the activation height unset, past the last block, and after the last mining op. | implemented in the indexer; tested in `test/mine-indexer.test.mjs` |
| M-ERR | Invariant | indexer / relayer | **Errors are never verdicts.** A throwing Argon2, a dead or silent worker or a failed prevout lookup reverts the block, which is retried; it never becomes `insufficient work`. A hash-wasm fast path that fails its self-test or throws is disabled for that process and the reference is used; `powHash` never returns a substitute value. The CLI miner stops when its fast path disagrees with the reference on a found solution. | implemented in `src/mine.mjs`, `src/pow-pool.mjs` and the indexer; tested in `test/mine-vectors.test.mjs`, `test/mine-indexer.test.mjs` and `test/mine-cli.test.mjs` |
| M-ORD | Invariant | indexer | **Bad work never reaches a pairing check or a prevout lookup, and a bad proof never reaches a prevout lookup.** Cheap checks come first (terms, window, reward, cap, fee outputs, bind, nullifiers, the claimed set), then Argon2 (`insufficient work`), then Groth16 (`verifyGroth16`), then the MINE_SCRIPT prevout (`prevoutScript`). The order changes reasons, never verdicts; MINT_SCRIPT's lookup moved after its Groth16 check the same way. | implemented in the indexer; tested with spies in `test/mine-indexer.test.mjs` |
| M-POOL | Invariant | server / web | **No Argon2 on the server's event loop or on a page's main thread.** Every evaluation in `server/` runs in the `worker_threads` pool of `src/pow-pool.mjs`, pages run it only in Web Workers, and copies of one solution in one block cost one Argon2 (a per-block memo by solution id). | implemented in the pool, the server and the web workers; tested in `test/mine-vectors.test.mjs`, `test/mine-relayer.test.mjs` and `test/mine-web.test.mjs` |
| M-FEE | Invariant | relayer / CLI | **A carrier's service-fee outputs come from its builder's own indexer terms and `MINE_FEE`, never from the request.** The relayer computes `requiredFeeOutputs` from its own indexer's asset and refuses a fee script that is its change key or a deposit script (`mine_unsupported`, before any debit); the CLI's self-paid carrier uses the same function on its own synced index, and checks the claim with the indexer's rules before paying. | implemented in the relayer and the CLI; tested in `test/mine-relayer.test.mjs` and `test/mine-cli.test.mjs` |

Disclosed, not fixed (the copy is in `docs/CLAIMS.md`): a GPU is roughly 300 to 500 times one browser thread, and grinding can be rented; the fee recipient (the platform) mines 500 sats per claim cheaper than everyone else; Bitcoin miners and the relayer can delay or reorder claims, so a claim can expire unmined; the relayer sees the token and the reward of every claim it carries and can link them to the top-up address, which the relay copy says, and the transfer sentence "cannot see amounts, tokens or recipients" is never shown for mining; near the supply cap, claims race and the late ones lose their fees.

## Privacy trace addendum (2026-10-07)
A blind deanonymization test of the 12 signet transactions (`docs/design/privacy-trace-test.md`) found five leaks. No recipient or amount was revealed. Transfer senders were named through L1 and L3. The fixes were built in three tracks against one contract. Section 8 of that document has the full status. No consensus rule and no circuit changed, and signet verdicts and digests are identical. I-PAY is unchanged: the operator still pays nothing, and housekeeping is paid only from margin and sweep charges. Nothing is live until the owner restarts the server.

| ID | Severity | Where | Finding | Status |
|---|---|---|---|---|
| P-1 | High | relayer / wallet | **Relay pool lineage tied carriers to the depositor (L1).** While one account funded the pool, every carrier and its change descended publicly from that account's deposit. | fixed in code: the relayer tracks lineage, merges deposits with other accounts' coins, and spends only coins that descend from at least `MURKLE_RELAY_MIN_MIX` + 1 accounts, the same rule for every sender, else answers 409 `pool_thin`. Review found that the first rule ("k accounts other than the sender") named a sender by exclusion, and that the published cover counted deposits no merge would take; both are fixed. The web wallet and the CLI (`--linkable`) send only on the user's explicit "linkable" consent, signed into the request, never list the sender as hidden for such a send, and treat a relayer whose k is below 3 as no cover. Tests: `test/privfix-relayer.test.mjs`, `test/privfix-web.test.mjs`, `test/relay-balance-cli.test.mjs` |
| P-2 | **Medium** | relayer | **Relayer files re-attributed carriers to accounts (L2).** Per-item costs, heights and modes stayed after settlement, so credits minus costs gave each balance. | fixed in code, with a disclosed remainder. Settled items keep no per-item cost, height, mode or anchor, and the retired v1 file is pruned when loaded. Review showed that was not enough: each charge follows from the carrier's public fee. Now the books keep accounts under an opaque key, never the account id, and a credit forgets its account once its deposit has left the pool and it is no longer recent. Remainder (in `docs/CLAIMS.md`): balances stay per account, so recent top-ups, or a handful of accounts, can still be matched to carriers. `data/` was not changed by hand; an old state is converted when it loads. Tests: `test/privfix-relayer.test.mjs` |
| P-3 | **Medium** | wallet | **The anchor plus a batch of one named the sender (L3).** The proof's anchor fixes the tree size, and no warning said how few notes were in it. | fixed in the web wallet and the CLI (one count, `src/crowd.mjs`): before a relayed or batch send, or a copied envelope, it shows other people's candidate notes at the anchor (padding and own notes excluded) and the expected batch crowd, and warns below 8 candidates or with a batch crowd of 1. It is advice only and never blocks. Tests: `test/privfix-web.test.mjs`, `test/relay-balance-cli.test.mjs`, `test/batch-cli.test.mjs` |
| P-4 | Low | wallet core | **Output order told payment from change and a note from its padding (L4).** | fixed in code: `src/wallet.mjs` shuffles the two outputs with their ciphertexts, and the circuit is unchanged. The web wallet never read positions, and a test guards that. Tests: `test/privfix-wallet.test.mjs`, `test/privfix-web.test.mjs` |
| P-5 | Low | CLI / web / relayer | **nSequence, fee rounding and input and output order identified the route (L5).** | fixed in code for everything this software builds: one planner (`src/btc/funding.mjs`) sets RBF on every input, uses one fee rule and one headroom, shuffles inputs (a bound first input stays first), and puts the change in a random slot after the OP_RETURN at output 0. The web top-up now records the deposit's real output. Unisat-built transactions keep Unisat's own shape. Tests: `test/privfix-wallet.test.mjs`, `test/privfix-relayer.test.mjs`, `test/privfix-web.test.mjs` |

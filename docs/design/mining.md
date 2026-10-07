# Mining: tokens issued by proof of work (design, not built)

Status: **built and activated on signet at height 325138** (pinned 2026-10-06). The rules are implemented per `docs/design/mining-contract.md` and folded into `SPEC.md` §15; the owner pinned the mining activation height in `src/pins.json` at 325138 (a restart rolls a saved state back to 325137 through the undo journal; SPEC §12). Owner decisions since this note: the service fee goes to the platform only (500 sats, no deployer fee; `MINE_FEE` in `src/params.mjs`), mining ships before BATCH (digest v2), and there is no mandatory lead between a launch and the first usable block: the deployer starts mining now or after N blocks (§0 item 6, 2026-10-06). Written 2026-10-05 against the live signet deployment (genesis 324,592, `src/pins.json`), revised the same day after the red-team review (§16). When this note and `SPEC.md` disagree, `SPEC.md` wins until the release folds these rules into it (§15).

Internal name: "anonymous mining". The product never says "anonymous" (`docs/CLAIMS.md`, `privacy-level2.md` §6.4, `test/english.test.mjs`). Pages and copy say **Mine** and "the reward goes to a private note".

## 0. Owner decisions (final) and one clarification

1. PoW mining is a second way to issue a token, next to paid mints. The reward lands in a shielded note. A claim can be carried by the relay balance (no miner BTC address on chain) or self-paid with the built-in key or Unisat.
2. **Unlimited solutions per Bitcoin block.** Every valid solution earns the full fixed reward. Rewards are never shared or split, and there is no "K per block" race. Emission is controlled only by difficulty retargeting (§6).
3. Hash: Argon2id (RFC 9106), 4 MiB, t = 1, p = 1 (§4.4 justifies the numbers and pins the implementation).
4. A per-claim service fee exists. Its recipient is still open (deployer's treasury, the platform's fixed address, or both). §7 makes it one parameterized rule.
5. The operator never pays any user's transaction (I-PAY). There is no free mode.
6. **No mandatory lead (2026-10-06).** The draft's `MINE_LEAD` (144 blocks between a DEPLOY_POW and the first usable reference block) is removed. The deployer picks one of two starts at launch: **Start mining now** (startHeight 0: the first usable reference is the launch block itself) or **Start after N blocks** (startHeight = the current tip + 1 + N). `mineStart = max(startHeight, deployHeight)`, so no reference before the launch block is ever valid. Reason: the owner wants mining to be able to open right after the launch; a forced day-long wait was a cost every launch paid for a fairness gain the deployer can choose instead. Nothing can be precomputed either way, since the launch block's hash is unknown until it is mined. The copy says what each choice favours: starting now favours whoever is ready first; a delay gives everyone time to see the terms (§8.6).

**Who loses a fee, and when.** Two miners never compete for a slot: every valid solution in a block earns the full reward, whatever else lands in that block. A claim's fees (Bitcoin fee plus service fee) are lost only in these cases:
- the same solution is carried twice (your own mistake, such as two tabs; §8.1). The first copy to land pays you; the second is rejected. The wallet prevents this (W-M);
- the claim lands after the token's supply cap is reached (§6.4). Near the cap this is a real race; the wallet and the relayer count claims already in flight and refuse early;
- the claim lands too late, after its 12-block window (§5.2);
- the difficulty rose more than 4× inside the claim's window, which only happens during a hashrate surge (§6.1, stale bound). The wallet and the relayer re-check right before paying;
- a reorg replaces the block the claim references (§8.4).

A third party cannot copy your claim into their own transaction (§8.1). The relayer drops a relayed claim that is certain to fail before signing it, and refunds the balance (§9).

## 1. What changes

| Item | Today | With mining |
|---|---|---|
| Issuance | DEPLOY (op 2) + paid MINT / MINT_SCRIPT (ops 3, 4) | adds DEPLOY_POW (op 9) + MINE / MINE_SCRIPT (ops 7, 8) |
| Circuit, setup, vkey | unchanged | **unchanged**: MINE reuses the MINT proof shape (§4.2) |
| Digest | v1 | v1 below the mining activation height, the next version from it (§10) |
| Relayer | carries TRANSACT | also carries MINE_SCRIPT bound to its change key, with service-fee outputs paid from the miner's balance (§9) |
| Dependencies | `@noble/hashes` | adds `hash-wasm` 4.12.0 (MIT, exact pin) as the default Argon2 for every side; noble stays the reference (§4.4) |
| Web | Mint page | adds a Mine page, a mining option in Launch, mining stats on the token page (§12) |

Op 6 stays reserved for the BATCH proposal (`privacy-level2.md` §5.3). MINE claims are never allowed inside a BATCH.

## 2. Constants

All of these live in `src/params.mjs`, except the activation heights, which go in `src/pins.json` (§10).

| Name | Value | Note |
|---|---|---|
| `OP.MINE` | `0x07` | bound to the first input's outpoint |
| `OP.MINE_SCRIPT` | `0x08` | bound to the first input's scriptPubKey hash |
| `OP.DEPLOY_POW` | `0x09` | mining terms |
| `MINE_WINDOW` (W_m) | 12 blocks | `H − 12 ≤ ref ≤ H − 1` |
| `STALE_FACTOR` | 4 | stale-reference bound, §6.1 |
| `MIN_DIFFICULTY` | 256 | protocol floor for `minDifficulty` (§3, §8.5) |
| `SPAN` range (τ) | 12 … 432 blocks | retarget averaging span (§6.2) |
| `MIN_SPAN_CLAIMS` | 16 | `targetPerSpan ≥ 16` (noise bound, §6.2) |
| `MAX_PER_BLOCK` | 100 | `targetPerSpan ≤ 100 × span` (§6.2) |
| `LABELS.mine` | `murkle/mine/v1` (14 bytes) | challenge domain tag |
| `MINE_SALT` | ASCII `murkle/mine/salt` (16 bytes) | Argon2 salt, fixed |
| `ARGON` | Argon2id, version 0x13, m = 4096 KiB, t = 1, p = 1, tag length 32, no secret K, no associated data X | consensus |
| `D_MAX` | 2^63 − 1 | difficulty bound |
| `FEE_MIN_SATS` | 546 | smallest nonzero service-fee amount (at or above the dust limit of every standard script type) |
| `STANDARD_SCRIPTS` | P2PKH, P2SH, P2WPKH, P2WSH, P2TR (exact templates) | allowed treasury and platform scripts |
| `MINE_FEE` | `{ platformScript, platformSats, deployerMinSats, deployerMaxSats }` | per network, pinned before activation (§7) |
| `pins.activations` | table, `mining.height: null` until release | §10 |

## 3. DEPLOY_POW (op 0x09), no proof

Strict, little-endian, no trailing bytes. 66 + ticker + treasury bytes, at most 116.

| Field | Type | Rule |
|---|---|---|
| magic `mrk` ‖ version `0x00` ‖ op `0x09` | 5 | |
| ticker | u8 length + ASCII | `[A-Z0-9]{1,16}`. The namespace is shared with DEPLOY: the first valid DEPLOY or DEPLOY_POW claims the ticker |
| divisibility | u8 | ≤ 8 |
| reward | u64 | 1 … 2^63 − 1 (MINE carries it as i64, audit A-2/A-5) |
| maxSupply | u64 | reward ≤ maxSupply ≤ 2^64 − 1 |
| halvingInterval | u32 | blocks; 0 = no halving |
| span (τ) | u16 | 12 … 432 |
| targetPerSpan (S) | u32 | 16 ≤ S ≤ 100 × span: solutions wanted per `span` blocks (the launch form asks "per block") |
| initialDifficulty | u64 | minDifficulty … D_MAX |
| minDifficulty | u64 | MIN_DIFFICULTY … D_MAX |
| claimFeeSats | u64 | deployer's per-claim service fee, see §7 |
| treasury | u8 length + scriptPubKey | length 0, or exactly one of `STANDARD_SCRIPTS`; required (length > 0) when claimFeeSats > 0 |
| startHeight | u32 | 0 (or any height at or below the launch block) = mining opens at the launch block; a later height delays it |
| endHeight | u32 | 0 = unbounded; otherwise ≥ startHeight (decoder) and ≥ mineStart (indexer) |

- Asset id: `(height << 32) | txIndex`, as for DEPLOY. The asset table holds both kinds: `kind: "mint" | "pow"`.
- `mineStart = max(startHeight, deployHeight)`. A reference block must be at or after `mineStart`, so never before the launch block.
  - Nobody, the deployer included, can precompute: the first usable block hash exists only after `mineStart` is mined. When starting now, that block is the launch block itself, and the first claims land in the block after it.
  - Two starts, the deployer's choice (§0 item 6): **now** (startHeight 0) or **after N blocks**. The launch form and the CLI encode the second as startHeight = tip + 1 + N, counted from the current tip; the field is absolute, so a launch that confirms later keeps the same start block (a shorter delay), and one that confirms at or after it starts mining at its own block.
  - Starting now favours whoever is ready first, the deployer included, who knows the terms before anyone else; a delay gives everyone time to see the terms and start miners (§8.6).
- A DEPLOY_POW that breaks a rule is `malformed: …`, claims no ticker and adds no asset (SPEC §6 rule 1), exactly as for DEPLOY.
- No premine by consensus: a mined token can only be issued by MINE claims. MINT and MINT_SCRIPT against a mined asset are rejected (`asset is mined`); MINE against a paid-mint asset is rejected (`asset is not mined`). Hybrid tokens are out of scope. How fair the start is still depends on the terms (floor, fee recipient), and the token page shows them (§11).

## 4. MINE (op 0x07) and MINE_SCRIPT (op 0x08)

### 4.1 Layout

| Field | Bytes | Note |
|---|---|---|
| magic ‖ version ‖ op | 5 | |
| `refHeight` u32 LE | 4 | the referenced block; **also the proof anchor** (`root = R[refHeight]`) |
| `publicAsset` u64 LE | 8 | the mined asset |
| `publicAmount` i64 LE | 8 | must equal `reward(refHeight)` |
| `bindOutpoint` (MINE) / `bindScriptHash` (MINE_SCRIPT) | 36 / 32 | as MINT / MINT_SCRIPT (A-6) |
| `nonce` | 8 | raw bytes |
| `nullifier[2]` | 64 | input nullifiers: dummies, or up to two of the miner's own notes of this asset (§4.2) |
| `commitment[2]` | 64 | the output notes |
| `noteCiphertext[2]` | 190 | |
| proof | 128 | |

**MINE is 515 bytes, MINE_SCRIPT 511.** The body (all bytes before the proof) is 387 or 383 bytes. `extDataHash = sha256(body) >> 8`, as for every proof-carrying op.

Carrier sizes (one P2TR input): about 598 vB with no fee output and no change, 641 vB with change, 684 vB with one service-fee output and change. At most about **1,670 claims fit in a block** (4,000,000 WU / ~2,392 WU). Every bound below uses 1,700.

### 4.2 What the proof binds

The proof is the existing 2-in/2-out circuit with the MINT shape: `publicAmount = reward`, `publicAsset = asset`, `Σout = Σin + reward`, `root = R[refHeight]`, `extDataHash` over the body. No circuit change, no new setup.

- **Inputs.** Each input is either a dummy (amount 0, membership skipped) or a real note of the same asset that the miner owns, proved a member of `R[refHeight]` (the circuit enforces membership for every nonzero input, `ForceEqualIfEnabled` with `enabled = inAmount`). Consensus needs no new rule: the nullifiers are checked against `N` like any other (§5.2 rule 10), and `issued` grows by the reward only.
- **Why real inputs are allowed.** Each claim would otherwise create one more note, and a transfer spends at most two notes (`maxSendable`, `src/wallet.mjs`). A miner with 50 claims would need 49 merge transfers, each costing about as much as a claim. With real inputs the wallet rolls each new reward into the previous note (§12.1), so a miner holds one or two notes however many claims land.
- **Rejected claims spend nothing.** A rejected envelope never mutates state, so its input nullifiers are not recorded.

The circuit computes each output commitment from its private opening `(asset, amount, pk, blinding)`. Anyone who does not know both openings cannot prove a claim for those commitments. That is what keeps a reward with the miner: a copier cannot keep the miner's commitments and swap in their own bind, because that needs a new proof.

### 4.3 The PoW preimage

```
challenge  = sha256( "murkle/mine/v1"
                   ‖ asset u64 LE ‖ refHeight u32 LE ‖ refHash 32
                   ‖ reward u64 LE ‖ commitment[0] 32 BE ‖ commitment[1] 32 BE )
password   = challenge ‖ nonce (8)                       // 40 bytes
powHash    = Argon2id(password, salt = "murkle/mine/salt", m = 4096 KiB, t = 1, p = 1, v = 0x13, tagLen = 32)
solutionId = sha256(password)
valid      ⇔ int_BE(powHash) ≤ target(D_eff),   target(D) = floor((2^256 − 1) / D)
D_eff      = max( D(refHeight), floor(D(H − 1) / STALE_FACTOR) )      // §6.1; H = inclusion height
```

- `refHash` is the 32 bytes of the block hash's display hex, the same convention as the digest (SPEC §10). The indexer takes it from its own chain (`hashes[refHeight]`); the envelope does not carry it. If the replay has no hash for that height, the claim is rejected (`unknown reference block`). Synthetic test blocks must carry hashes.
- The challenge binds the solution to:
  - the asset;
  - a recent block (no precomputation);
  - the reward;
  - both output commitments, so the reward cannot be redirected. With rolled inputs, `commitment[0]` is the rolled note: the inputs are chosen before mining starts.
- The challenge leaves out the bind and the nullifiers on purpose. The miner finds a solution first, then picks a route (self-pay or relay), then writes the bind and proves. The proof's `extDataHash` covers the bind and the nonce, so neither can be changed after proving.
- `solutionId` is cheap to compute (one sha256) and identical for every claim of the same solution, however it is bound or re-proved. Duplicates are therefore rejected **before** any Argon2 work.
- Equality with the target is valid. `MIN_DIFFICULTY = 256` means no token accepts every hash.
- **Every challenge is used once by the wallet.** After each found solution and on each new tip, the wallet builds new outputs with new blindings, new ciphertexts and new dummy inputs (§12.1). Two claims from one wallet never share a commitment or a nullifier.

Illustrative vector (computed with `@noble/hashes` 1.8.0 and matched by `hash-wasm` 4.12.0; the fixture file regenerates it):
asset `1395864371200007` (= `325000 << 32 | 7`), refHeight 325100, refHash `00…0abc`, reward 1000, commitments 1 and 2, nonce `0000000000000000`.
- challenge = `f9181c09f98cb253ed91f856cc42eab177a0639e22df4de67f8d5d9176121661`
- solutionId = `1bb0f3380801d593ed3d3ae627ce16a8209f228bceea9e7d6ca2921fcc2008f4`
- powHash = `8ce2b336274d4c3a60b8c69f8902776ea6e657318fb1bd8d44edcfad4d44c372` (not valid at D = 1000)

Both libraries reproduce the RFC 9106 §5.3 Argon2id test vector (`0d640df5…6b01e659`).

### 4.4 Argon2 parameters and the pinned implementation

Measured on the dev machine (Ryzen 9 7950X, Node 24.4, one thread, 4 MiB unless noted). Times vary with machine load; ranges are from several runs by the author and the red team.

| Implementation | m, t | ms per hash | H/s per thread |
|---|---|---|---|
| `@noble/hashes` 1.8.0 (pure JS) | 1 MiB, 1 | 10 | |
| same | 2 MiB, 1 | 16 | |
| same | **4 MiB, 1** | **35 – 53** | **19 – 28** |
| same | 8 MiB, 1 | 73 | |
| `hash-wasm` 4.12.0 (WASM) | **4 MiB, 1** | **3.6 – 4.7** | **210 – 280** |

`hash-wasm` matched noble on 264 random inputs, including 64 concurrent calls interleaved with other hash-wasm calls. Phone figures are not measured yet; expect 3 – 5× slower than this desktop (step 1 of §13.3 measures a mid-range Android phone and an iPhone).

**noble's `argon2idAsync` does not yield.** Its `nextTick` is `async () => {}`, so it only awaits microtasks: a 1 ms `setInterval` fired 0 times during 10 hashes. It blocks the event loop exactly like the sync call. Every Argon2 call outside a miner therefore runs in a worker (§8.5).

Why 4 MiB, t = 1, p = 1:
- **Verification cost.** Each claim costs every replayer one Argon2 evaluation: about 4 ms with `hash-wasm`, a fifth of a Groth16 verification (~20 ms, `relayer.md`). 8 MiB doubles that for little gain.
- **Browser and phone memory.** 4 MiB per worker is safe in every browser and on phones, even with 8 workers.
- **p = 1** keeps each hash single-threaded; parallelism comes from many nonces.
- **GPU resistance, stated honestly.** Memory capacity gives none: 4 MiB fits a GPU's L2 cache, and 24 GB of VRAM holds about 6,000 instances. The only limit is memory bandwidth. Each hash moves roughly 8 – 12 MiB, so a 1 TB/s GPU is bandwidth-bound near 80k – 120k H/s. That is about 300 – 500× one `hash-wasm` browser thread, and 3,000× one noble thread. A 16-core native miner is about 16× one tab. ASICs are absent because the token has no value, not because of the parameters. The challenge carries no secret, so grinding can be farmed out to rented GPUs, botnets or scripts on other people's pages. The copy says so (§12.1).

**Consensus is the function, not a library:** RFC 9106 Argon2id v1.3 with the parameters above.
- **Default implementation everywhere:** `hash-wasm` 4.12.0 (MIT), exact version pinned in `package.json` and `package-lock.json`, for miners (web worker, CLI) **and** verifiers (indexer, relayer, CLI, browser replay, `verify-tx`). Verifiers must not be slower than miners.
- **Reference and fallback:** `@noble/hashes` `argon2id` (already a dependency), exact version pinned.
- **Agreement guarantee.** `hash-wasm` must pass the vector file `test/fixtures/mine-vectors.json` at startup in each process and each worker (a few hashes). On a failure or any runtime error it is disabled for that process, the reference is used, and the work is retried (§5.2). A fast path never produces a verdict without having passed its self-test in that process.
- Node's built-in `crypto.argon2` (newer Node releases) may be used by the CLI miner on the same terms. `engines` stays `>=22`.
- `THIRD_PARTY_NOTICES.md` gains `hash-wasm`.

## 5. Indexer rules

### 5.1 Activation gating

`decodeEnvelope` stays free of height: it decodes ops 7, 8 and 9 for every caller (relayer, wallet, `verify-tx`, live-check). Activation is an **explicit indexer rule applied right after decoding**:

- if `op ∈ {7, 8, 9}` and (`pins.activations.mining.height` is `null` or `H < height`), the envelope is recorded exactly as today's unknown op: rejected, reason `malformed: unknown op N`, `opName` `UNKNOWN`, `headerOp` in `logAcc`, `stats.rejected += 1`, no asset touched.
- The reason string is not in the digest, and `logAcc` folds only the txid, the ok flag and the header op. A pre-activation DEPLOY_POW or MINE therefore leaves the same digest as v1, byte for byte.
- Regression fixture: a DEPLOY_POW, a MINE and a MINE_SCRIPT posted below activation; the replay must match the live v1 digests at every height.

### 5.2 MINE / MINE_SCRIPT checks, in this order (all before any mutation)

Cheap checks first; then Argon2; then pairing; then I/O.

1. Activation (§5.1), then strict decode (exact length, canonical field elements).
2. `asset = assets[publicAsset]` exists → else `unknown asset`; `asset.kind = "pow"` → else `asset is not mined`.
3. Window: `H − MINE_WINDOW ≤ refHeight ≤ H − 1` → else `reference outside window`. Then `refHeight ≥ mineStart` → else `mining not started`, and `endHeight = 0 or refHeight ≤ endHeight` → else `mining closed`.
4. `refHash = hashes[refHeight]` is known → else `unknown reference block`. `root = R[refHeight]` exists (it always does in the window).
5. `r = reward(refHeight)` (§6.3): `r > 0` → else `mining ended`; `publicAmount = r` → else `reward differs from terms`.
6. Supply: `issued + r ≤ maxSupply` → else `supply cap reached`.
7. Service fee: the carrier's outputs pay the required amounts (§7) → else `underpaid service fee: …`.
8. Bind, cheap part: MINE needs first input = `bindOutpoint`; MINE_SCRIPT needs a first input that is not the null outpoint (A-12) → else `MINE not bound to this transaction` / `… payer`.
9. Nullifiers: distinct, and not in `N`.
10. `solutionId` not in the claimed set (§5.4) → else `solution already claimed`.
11. **PoW:** compute `challenge`, `D_eff` (§6.1) and `powHash`; require `≤ target(D_eff)` → else `insufficient work`.
12. Proof decode with strict point validation, then Groth16 verify with `[R[refHeight], reward, asset, extDataHash, n0, n1, c0, c1]`.
13. Bind, I/O part (MINE_SCRIPT only): prevout lookup, as for MINT_SCRIPT, with the same raw-tx re-hash and the same all-or-nothing retry → else `MINE not bound to this payer`.

Invalid PoW never reaches a pairing check, and a network lookup needs a valid proof, which takes seconds to make. Every rule must pass either way, so this order changes reasons, never verdicts. Claims are processed in block transaction order, so the order inside a block decides which claims fit under the cap.

**Errors are never verdicts.** A PoW evaluation that throws (an allocation failure, a WASM error), a worker that crashes or does not answer, and a failed prevout lookup all abort the block. The block is reverted through the journal and retried, as SPEC §6 rule 10 already requires for lookups. A `hash-wasm` failure switches that process to the reference implementation before the retry. Test: an injected throwing `powHash` leaves the block retried, not rejected.

**Parallel pre-pass (optional).** A replayer may compute PoW in a worker pool before the sequential apply, under three conditions:
- only for claims that pass rules 1 – 5, 7 and 8 and whose nullifiers are not in `N` at the start of the block;
- memoized by `solutionId`: each distinct `solutionId` is evaluated at most once per block (`powHash` depends only on the challenge and the nonce; `D_eff` depends only on the reference height and on `D(H − 1)`, both fixed before block H);
- the sequential apply still runs every rule in order and uses the memoized result at rule 11.

A block of 1,700 copies of one solution therefore costs one Argon2, as in the sequential order.

### 5.3 Apply

- Commitments are appended to the tree and to `outputs` (so wallets discover the reward by trial decryption, as with MINT). Nullifiers go into `N` and `nullAcc`.
- `asset.claims += 1`, `asset.issued += r` (`pool` = `issued` for a mined asset), `blockWork[asset] += D_eff`.
- `claimed.set(solutionId, refHeight)`; `mineAcc = sha256(mineAcc ‖ solutionId)`.
- Log entry: `{ op: 7|8, opName: "MINE"|"MINE_SCRIPT", asset, ticker, amount: r, ref: refHeight, difficulty: D_eff }`. It never names a recipient.
- A rejected claim of a known mined asset: `rejectedClaims += 1`, `burnedFeeSats += Σ` the outputs the fee rule counts.

### 5.4 Claimed-solution set

`claimed: Map<solutionId hex, refHeight>`. A solution can only be included while `H ≤ ref + 12`, so after each block entries with `ref < H − MINE_WINDOW − UNDO_DEPTH` are pruned. The lag of 144 blocks makes pruning reorg-safe: a rollback of at most `UNDO_DEPTH` blocks never needs a pruned entry, so pruning is not journaled. Additions are journaled per block and removed on rollback. The set is in the snapshot. The digest covers it through `mineAcc`.

### 5.5 End of block

After all transactions, still **inside the block's revert scope** (the `try` of `applyBlock`, so a throw here reverts the whole block):
1. for each mined asset with `blockWork > 0`, append the difficulty point of §6.2;
2. prune each touched asset's difficulty points (§6.2) and the claimed set;
3. compute `R[H]` and the digest.

Assets without claims in the block are not touched: their difficulty is evaluated lazily (§6.2). Per-block work is proportional to the claims in the block, not to the number of mined assets.

### 5.6 Undo journal

The block's undo entry records, for each mined asset the block touches (a claim accepted or rejected, or a point appended): `claims`, `issued`, `rejectedClaims`, `burnedFeeSats`, `feeSats`, and a copy of its difficulty points as they were before the block. It also records `mineAcc` and the list of `claimed` additions. `revert` and `rollbackTo` restore all of them. The randomized-reorg test crosses blocks with and without claims and a stale-bound rejection.

## 6. Difficulty, reward and supply

### 6.1 Difficulty per reference height, and the stale bound

- `D(h)` is the difficulty for claims that reference block `h`. It is fixed at the end of block `h`, before any claim can reference `h` (a reference must be ≤ H − 1).
- `D(h) = initialDifficulty` for `h ≤ mineStart`. Claims land from block `mineStart + 1`.
- **The target of a claim is the one at its reference height, with a stale bound:** `D_eff = max(D(refHeight), floor(D(H − 1) / STALE_FACTOR))`.
  - In normal operation the difficulty moves by a few percent per block (§6.2), so `D(refHeight)` decides and in-window work is never invalidated by a retarget.
  - Only when the difficulty rose more than 4× between the reference and the freshest block, which takes a hashrate surge, does the bound bite. Without it a surge miner would keep grinding the pre-surge reference at the old low difficulty for 12 more blocks.
  - The wallet and the relayer check `D_eff` right before paying (§9, §12.1), so an honest claim is caught there, not on chain, unless the surge starts after it was broadcast.
- Work is counted as `D_eff`, the difficulty the solution actually met.

### 6.2 Retarget: a per-block moving average (deterministic, BigInt)

Each block's counted work feeds an exponential moving average. With `τ = span`, `S = targetPerSpan` and `w_h = Σ D_eff` over the claims of this asset accepted in block `h`, for `h > mineStart`:

```
D(h) = min(D_MAX, max(minDifficulty, floor( (D(h−1)·(τ−1)·S + w_h·τ) / (τ·S) )))
```

All values are BigInt; `w_h ≤ 1,700 × D_MAX < 2^74`.

Properties:
- **Equilibrium.** With a steady hashrate of `X` hashes per block, `w ≈ X` and `D` settles at `X·τ/S`: `S/τ` solutions per block on average.
- **Upward, fast.** One block with F times the target rate multiplies `D` by `(τ − 1 + F)/τ`. There is no upward clamp, because counted work cannot be forged: each unit of `D_eff` costs that many expected hashes. Only `D_MAX` and block space bound it.
- **Downward, smooth.** A block with no claims multiplies `D` by `(τ − 1)/τ` (floored), so the difficulty halves in about `0.7·τ` quiet blocks and stops at `minDifficulty`.
- **Noise.** One claim moves `D` by at most `1/S ≤ 1/16`. Simulated at steady hashrate: the relative spread of `D` is about 15 % with `S = 24`, and emission runs 2 – 3 % above target from Poisson noise (1 % or less with `S ≥ 100`). The launch form says so.
- **Hopping does not pay.** A miner who leaves lets `D` decay with time constant `τ`; when they return, one block of their work raises it again. Withheld solutions expire after 12 blocks and keep their own reference difficulty, so saving them for later gains nothing.

**Lazy evaluation and state.** Blocks with no claims apply the step with `w = 0`, which is `D ← max(minDifficulty, floor(D·(τ − 1)/τ))`. An implementation evaluates them lazily by iterating that step from the last stored point; the iteration stops early at `minDifficulty`, where the step is the identity, so it takes at most about `38·τ` steps (≈ 16,000 at τ = 432). The asset stores:
- `dPts`: the list of `[height, D(height)]` for blocks with claims of this asset, starting with `[mineStart, initialDifficulty]`;
- after each block, points older than the newest point at or below `H − MINE_WINDOW − 1` are dropped, so `dPts` holds at most `MINE_WINDOW + 2` entries;
- `D(r)` for any `r` in the window = iterate the `w = 0` step from the newest point at or below `r`.

There is no per-epoch history in consensus state. The difficulty chart is a non-consensus series rebuilt from the log (§11). Mined assets that nobody mines cost nothing per block.

Behaviour:
- **Genesis of a token.** `D = initialDifficulty` until the first claims. The launch form computes it from an expected hashrate.
- **Low or no hashrate.** The difficulty decays to `minDifficulty` and stays there. With τ = 24 a quiet day divides it by about 460, so the floor decides what a returning or arriving miner can emit (§8.7). The launch form suggests a floor of `initialDifficulty / 16` (never below `MIN_DIFFICULTY`), and the explorer flags tokens whose floor or initial difficulty is far below an honest browser launch (§11).
- **A hashrate surge** emits about F × the target per block in its first block (block space permitting), then a short tail. §8.7 gives the numbers. That first block is the price of "no per-block cap" (decision 2).
- **Why `S ≤ 100 × τ`.** Block space holds about 1,700 claims, so a token asking for many more per block could never raise its difficulty from the floor.
- Default span: 24 blocks (~4 h). Shorter spans react faster but are noisier at small `S`.

### 6.3 Reward and optional halving

```
reward(ref) = halvingInterval = 0 ? reward
            : (s = floor((ref − mineStart) / halvingInterval)) ≥ 63 ? 0 : reward >> s
```

The reward is fixed per reference height and is never split. A claim with `reward(ref) = 0` is rejected (`mining ended`).

### 6.4 Supply cap

- A claim is accepted only if `issued + reward(ref) ≤ maxSupply`. There is no partial last reward: the proof fixes `publicAmount` before the miner can know where in the block the claim lands. Up to `reward − 1` units can stay unmined forever. The launch form suggests a `maxSupply` that is a multiple of the reward when there is no halving.
- With halving, the cap may never be reached; mining then ends when the reward reaches 0.
- **Near the cap there is a race**, and it is the only one. Claims beyond the cap are rejected and their fees are spent (`burnedFeeSats`, as `burnedSats` for MINT). Their service fees still go to the fee recipient; the copy says so.
- **In flight counts.** `remaining = maxSupply − issued − pendingReward`, where `pendingReward` = reward × (claims of this asset in the mempool and in the relayer's own queue).
  - The relayer computes it from its own in-flight items plus the mempool claims of that asset it can see (`getrawmempool` with bitcoind; the esplora mempool listing otherwise; best effort). It refuses `cap_reached` when `remaining < reward`, at submit and again right before signing (§9).
  - The wallet applies the same count before a self-pay, and warns when `remaining < reward × (claims in the last 3 blocks + 1)`.
- What the cap does and does not bound is as for MINT (SPEC §6): public issuance is bounded by `maxSupply` whatever the circuit does; private value relies on circuit soundness and the phase-2 setup (A-8).

## 7. Service-fee output rule (parameterized recipient)

One function decides the required outputs of a claim's carrier. It is used by the indexer (rule 7), the relayer, the wallet and the CLI:

```
requiredFeeOutputs(asset) =
    [ (asset.treasury, asset.claimFeeSats)        if asset.claimFeeSats > 0 ]
  ++ [ (MINE_FEE.platformScript, MINE_FEE.platformSats)  if MINE_FEE.platformSats > 0 ]
```

- Entries are grouped by script and their amounts summed (a deployer whose treasury is the platform script pays both amounts to it).
- For each group, the sum of the carrier's outputs paying that script must be ≥ the amount. Outputs are counted gross, as `treasuryPaid` counts them for MINT. Any carrier may add other outputs.
- DEPLOY_POW validation of `claimFeeSats`:
  - when `MINE_FEE.deployerMinSats > 0`: `deployerMinSats ≤ claimFeeSats ≤ deployerMaxSats`;
  - otherwise: `claimFeeSats = 0`, or `FEE_MIN_SATS ≤ claimFeeSats ≤ deployerMaxSats`.
  
  `deployerMaxSats = 0` forbids a deployer fee.
- The treasury must be one of `STANDARD_SCRIPTS` (§3), so every carrier is relayable by mempools. `FEE_MIN_SATS` is at or above the dust limit of every one of them.
- `platformSats`, when > 0, is ≥ `FEE_MIN_SATS`, and `platformScript` is one of `STANDARD_SCRIPTS`.

**The owner's open choice is four constants:**

| Choice | `platformSats` | `platformScript` | `deployerMinSats` | `deployerMaxSats` |
|---|---|---|---|---|
| Deployer's treasury only | 0 | null | 546 (fee required) or 0 (deployer may set 0) | e.g. 10,000 |
| Platform only | e.g. 1,000 | platform P2TR | 0 | 0 |
| Both | e.g. 500 | platform P2TR | 0 or 546 | e.g. 10,000 |

The constants are consensus.
- They must be fixed before the activation height.
- Changing them later (a new platform key, a new amount) is a new rule with its own activation height (§10). Old claims keep their verdicts.
- With a platform recipient, the platform key is a consensus constant: losing it means fees go to an unspendable script until a new rule activates.
- **The recipient mines at a discount.** Its own claims pay the service fee back to itself, so they cost only the Bitcoin fee; everyone else pays both. When a claim is worth between those two costs, only the recipient mines at a profit. A low `deployerMaxSats` (a few thousand sats) keeps this edge small. The token page, the Mine page and the Launch form disclose it (§8.6).

## 8. Attacks and limits

### 8.1 Copy, rebroadcast and duplicate claims

- **Verbatim copy in another transaction.** The bind fails (the first input is not the miner's outpoint or script), so the copy is rejected and **consumes nothing**. The original still lands.
- **Why the bind is required (it extends A-6 to mining).** Without it, a copier who pays the service fee could make the miner's own carrier land second and be rejected. That is pure griefing for most people, but **profitable for the fee recipient**: a deployer (or the platform) copying claims gets their own service fee back and makes the victim's fee land in their treasury. With the bind, no third party can do this.
- **Re-proved claim of the same solution.** Only the miner knows the openings, so only the miner can re-prove. A miner who submits one solution twice gets paid once: the second is rejected by `solutionId`, and its fees are spent.
  - Wallet invariant **W-M**: a solution is submitted once, by one route, and stays locked until it lands or until `ref + 12` passes. Notes rolled into a pending claim stay locked for the same time.
  - Each challenge is built once (§4.3), so two tabs or two solutions never share commitments or nullifiers.
- **Verbatim repeat that passes the bind.** It is rejected by its nullifiers (rule 9) before Argon2 runs.
- **RBF.** A self-paid claim (MINE, built-in key) can be fee-bumped by RBF: the replacement spends the same first input, so the bind still holds. The fee recipient can block a bump by hanging descendants on its output (§8.8), so the wallet pays a deadline-safe fee rate up front. Relayed claims are never bumped (`relay-balance.md` §2).

### 8.2 Mempool racing

- Between different miners there is no race: unlimited claims per block (decision 2).
- The only race is near the supply cap (§6.4), where block order decides; in-flight claims are counted before anyone pays.
- A claim that misses its 12-block window is rejected if it is mined later, and its fees are spent. The wallet always references the tip, so the full window is available. On mainnet, a wallet may reference `tip − 1` to survive one-block reorgs, at the cost of one block of window.

### 8.3 Bitcoin miner censorship and ordering (disclose)

- Claims are recognisable (`mrk`, op 7/8). A Bitcoin miner, or the signet block signers, can:
  - censor claims until they expire;
  - order claims inside a block, which matters near the cap;
  - include their own claims at no Bitcoin fee (they still pay the service fee).
- The relayer operator can likewise delay or reorder the claims it carries, and it sees relayed claims before the chain does.
- They cannot redirect a reward or forge work.
- On signet a few signers produce every block. Copy for the Mine page: "Bitcoin miners choose what goes into blocks and in what order. They can delay a claim until it expires."

### 8.4 Reorgs

A claim depends on the hash of its reference block. If a reorg replaces that block, the claim fails `insufficient work` against the new hash when the indexer replays (rollback per SPEC §6 rule 9, then re-evaluation). Claims referencing older, unaffected blocks are re-applied as before. Difficulty points are restored from the journal (§5.6).

### 8.5 DoS and verification cost

- **Cost to the attacker.** Every claim that reaches Argon2 (rule 11) has paid a Bitcoin fee and the full service fee (rule 7). Every claim that reaches Groth16 has also done `D_eff ≥ 256` expected hashes. Every claim that reaches a prevout lookup also carries a valid proof. When the fee goes back to the attacker (they are the deployer, under the deployer-treasury policy), only the Bitcoin fee and the `MIN_DIFFICULTY` work remain, so a junk claim costs the attacker at least as much CPU as it costs a verifier.
- **Bound per block.** At most about 1,700 claims fit in a block (§4.1). Worst case per full block, one thread:

  | Check | Per claim | Per full block |
  |---|---|---|
  | Argon2, `hash-wasm` (default) | ~4 ms | ~7 s |
  | Argon2, noble (fallback only) | 35 – 53 ms | 60 – 90 s |
  | Groth16 verify | ~20 ms | ~34 s |
  | Phone, `hash-wasm` + Groth16 (estimate, 3 – 5×) | ~70 – 120 ms | 2 – 3.5 min |

  A block of junk TRANSACTs with invalid proofs already costs the Groth16 line today; mining adds the much smaller Argon2 line and requires real work to reach Groth16.
- **Never on the main loop.** The indexer server runs sync, the HTTP API and the relayer in one process (`server/indexer-server.mjs`). Every Argon2 evaluation outside a miner runs in a bounded `worker_threads` pool (Node) or Web Worker pool (browser), never on the event loop. noble's async variant does not yield (§4.4).
- **Browser replay.** History with N claims costs about N × (4 ms + 20 ms) on a desktop thread, less with workers. `/verify` shows a per-claim time figure next to its ms-per-proof figure. MINE_SCRIPT adds one cached raw-transaction fetch per distinct previous transaction, as MINT_SCRIPT does; relay carriers share fan-out parents, so the cache hits often. A sustained flood would slow phone replay to minutes per block; the replay keeps working through it in the background.
- **Relayer.** It refuses before any proof work:
  1. signature;
  2. a balance that covers the claim (the existing rule: no balance means refused before any proof check);
  3. per-account limits: one PoW check in flight per account; `busy` when the worker queue is full; the existing `invalidPerHour` count includes refused PoW;
  4. decode;
  5. rules 2 – 10 against its indexer;
  6. PoW, in the worker pool. A refused PoW debits `invalidPowSats` (a small fixed amount to the margin, like `invalidProofSats`) and counts toward the per-account limit;
  7. proof.

### 8.6 Fairness disclosures

- **Launch.** The deployer picks the start (§3): now, at the launch block itself, or after N blocks. Starting now favours whoever is ready first, and the deployer knows the terms before anyone else; a delay gives everyone time to see the terms. The token page shows which one the launch chose and how many blocks the terms were public before the first usable block. With an honest initial difficulty the first blocks decide little.
- **Fee recipient.** "The claim fee of N sats goes to RECIPIENT. Their own claims cost them N sats less." (§7)
- **Hardware.** Faster hardware finds more. A GPU is roughly 300 – 500× one browser thread (§4.4); anyone can rent many computers.
- **Coins and block space.** Self-paid claims each spend a coin, and one coin can carry at most about 25 unconfirmed claims in a chain. At low difficulty, coin count and block space limit a miner, not only hashrate. The wallet and the CLI offer a "prepare N coins" split.
- The hashrate shown is an estimate from counted work.
- **Signet coins have no value.**

### 8.7 Emission after a quiet period or a surge

Expected-value simulation, τ = 24, S = 24 (1 claim per block), 200 blocks after the hashrate jumps to F × what the difficulty is set for, with miners always using the most favourable reference the stale bound allows:

| F | Claims, per-block average (this design) | Claims, epoch design of the first draft (36 blocks, ×4 clamps) | Scheduled |
|---|---|---|---|
| 10 | 357 | 686 | 200 |
| 228 (one GPU after a quiet day, floor = initial/16) | 779 | 13,681 | 200 |
| 1,000 | 1,562 | 59,961 | 200 |
| 3,700 (block space binds) | 2,416 | 125,855 | 200 |

Most of the excess lands in the first block of the surge (F × target, up to block space); the difficulty is back in range within a few blocks. A stale factor of 16 instead of 4 would roughly double the F = 1,000 figure (1,751 → 3,108 at τ = 36). The deployer's floor bounds the quiet-period case; the explorer flags low floors.

### 8.8 Third-party outputs and mempool pinning

A carrier with a service-fee output gives the fee recipient a spendable output while the carrier is unconfirmed. The recipient can hang large low-feerate descendants on it, filling the mempool's descendant or cluster limits, and so:
- stall any transaction chained on that carrier's change;
- block an RBF bump of a self-paid claim.

Therefore the relayer never spends the change of a carrier with third-party outputs until that carrier confirms: MINE carriers are leaves funded from confirmed C coins (§9). The wallet pays a deadline-safe fee rate up front and says that a bump can be blocked.

## 9. Relay balance carriage under I-PAY

Relayed claims are MINE_SCRIPT bound to the relayer's pool change key: `bindScriptHash = sha256(C.script)`.
- Every carrier's inputs are C coins (`relay-balance.md` §2 Pool coins), so the first input spends C.
- No one else can spend C, so a copy is invalid anywhere else.
- The wallet needs no interactive step: `GET /api/relay/info` gains `mine: { enabled, bindScriptHash, modes: ["fast", "block"], slack: 2 }`.

Submit (`POST /api/relay/submit`, body `{ envelope, mode, accountPub, t, sig }`, same signing):
1. Header op `MINE_SCRIPT` is accepted next to `TRANSACT`. `bindScriptHash ≠ sha256(current C)` → `bind_stale` (the wallet re-proves; the solution is unchanged). The relayer does not rotate C while mining items are pending; it stops taking MINE first and waits at least 12 blocks.
2. Mode must be `fast` or `block` → else `mine_mode`. Batch modes land after the 12-block window.
3. The asset's treasury must not be one of the relayer's deposit scripts or C → else `mine_unsupported`, before any debit.
4. Pre-checks in the §8.5 order. It refuses:
   - `expired` when `tip > ref + MINE_WINDOW − 1 − MINE_SLACK` (`MINE_SLACK = 2`): the carrier must be broadcast while `tip + 1 ≤ ref + 9`;
   - `cap_reached` with in-flight claims counted (§6.4);
   - `stale_work` when `D_eff` at the next block fails the stale bound;
   - a `solutionId` already pending or claimed.
5. Carrier: OP_RETURN, then the `requiredFeeOutputs(asset)` computed from **its own indexer's asset terms and the pinned constants, never from the request**, then change to C. Inputs: confirmed C coins only, never unconfirmed change; the carrier's own change is not spent until it confirms (§8.8). Fee rate: the next-block estimate with headroom (`mineFeeHeadroom`, e.g. 1.25×), charged to the user.
6. `cost = minerFee + Σ serviceFee + margin` (the margin is on the miner fee, `marginFor`). The account is debited and the debit recorded durably, **before** the signature (I1). If the balance is short: 402 `balance_low`.

In flight:
- `deadlineOf(item)` for MINE items is `ref + MINE_WINDOW − 1 − MINE_SLACK`, not the 100-block anchor deadline.
- `precheck` drops the item with a refund, before signing, when it is past that deadline, its `solutionId` is claimed, the asset's cap is reached counting in-flight claims, or `D_eff` fails the stale bound. A retried broadcast follows the same rule: an item is never broadcast after `ref + 11`.
- `refundCharge` and `rereserve` reverse `serviceOut` together with the fee and the margin.

Invariant changes (`relay-balance.md` §3, `relay-balance-contract.md` §3):
- **I-PAY, extended.** Every satoshi that leaves the pool, as a miner fee **or as a service-fee output**, is covered by a recorded debit of the account that caused it before the signature is released. The relayer pays a treasury or platform output from pool coins only against such a covered debit.
- **I0.** Every output except the OP_RETURN pays C, **or** is a required service-fee output of the envelope being carried, with exactly the required script and amount. Outputs to deposit addresses stay refused.
- **I1.** `signPoolTx` computes `spent = Σinputs − change` from the final transaction and refuses unless the debit covers `spent` in full. It rejects any non-C, non-OP_RETURN output not produced by `requiredFeeOutputs` for that envelope.
- **I2.** `credited − fees − serviceOut − Σbalance − Σreserved = margin ≥ 0`, with `serviceOut` a new book total. A refunded carrier reverses its `serviceOut`.
- Once broadcast, both the fee and the service fee are spent, even if the claim later loses at the cap or expires. The relayer never refunds from operator money and never bumps.

**Privacy on the relay route.** The existing copy "It cannot see amounts, tokens or recipients" is true for transfers only; it is not shown for mining.
- The operator learns account → token → number of claims × reward, the top-up address, IP and timing.
- Chain observers see relay carriers with claims of TICKER. While few people relay claims, the claims right after a top-up confirms are easy to tie to the top-up address. Waiting does not help: a solution must land within 12 blocks, and batch modes are refused. Topping up before mining starts helps.

## 10. Activation and versioning

- **Activation heights.** `pins.json` gains one table for every consensus change after v1:
  ```
  "activations": [
    { "name": "mining", "height": null, "digestV": N },
    { "name": "batch",  "height": null, "digestV": M }
  ]
  ```
  The owner pins `mining.height` in the release, at a future height (at least one day after the release is public). All rules of this note apply only at and above it.
  - Below it, nothing changes: ops 7 – 9 stay `malformed: unknown op N` (§5.1), and the digest stays v1 byte for byte. No past verdict can change, because the height is in the future.
- **Digest.** The digest version for height `h` is the `digestV` of the newest activation with `height ≤ h`, or 1. Versions are numbered in activation order, and each later version includes every field of the earlier ones. If mining activates first it is v2 and a later BATCH is v3 (with the mining fields), or the reverse; the table decides. For mining:
  ```
  digest(h) = sha256("murkle/digest/vN" ‖ h u32 LE ‖ blockHash 32 ‖ root 32 BE ‖ nullAcc ‖ logAcc
                     ‖ assetsHash ‖ minedHash ‖ mineAcc)
  assetsHash  = v1 formula, over DEPLOY (paid-mint) assets only        // identical to v1 while no mined asset exists
  minedHash   = sha256(concat over mined assets sorted by id of:
                  id u64 LE ‖ claims u64 LE ‖ issued u64 LE ‖ dHeight u32 LE ‖ dValue u64 LE
                  ‖ sha256(deploy envelope))                           // sha256("") when none
                  where [dHeight, dValue] = the newest entry of dPts (§6.2)
  mineAcc     = 32 zero bytes at activation; sha256(mineAcc ‖ solutionId) per accepted claim
  ```
  - Every field is stored state, never derived from the height, so it is defined for an asset before `mineStart` (`[mineStart, initialDifficulty]`) and at every block. Older `dPts` entries were the newest entry at an earlier height, so the digest at that height covered them.
  - `minedHash` is recomputed only in blocks that change a mined asset or add one (cache the per-asset lines).
  - Below the activation height the v1 formula applies, so `murkle audit --compare` keeps matching every past height.
  - **The digest switches at the activation height unconditionally**, whether or not any mining op ever lands. A replayer that has not upgraded diverges exactly at that height, and `--compare` reports "digest version changes at H" there rather than pointing at a transaction.
  - `/api/digest` returns `{ height, version, digest }`.
- **Snapshot.** The next `SNAPSHOT_VERSION`. It adds mined asset state, `dPts`, `claimed`, `mineAcc` and the §5.6 undo fields. `restore()` refuses older versions; callers resync and archive (SPEC §9).
- **Browser replay.** The replay key includes `DIGEST_V`, so saved replays restart once after the upgrade. `/verify` says why.
- **Lockstep.** The server, the CLI, the browser replay, `src/verify-tx.mjs`, `web/src/share/live-check.js` and the relayer upgrade in one release.

## 11. Explorer, stats and API

- **Per mined token:**
  - reward now, next halving height, issued / maxSupply (progress bar), claims;
  - current difficulty `D(tip)`, the stale floor `D(tip)/4`, span and target per block;
  - estimated network hashrate (`Σ D_eff` over the last 144 blocks / (144 × 600 s), labelled "estimate");
  - difficulty chart (per block, rebuilt from the log; not consensus), claims-per-block chart;
  - rejectedClaims, `feeSats` (gross sats to the fee scripts in accepted claims, with the `treasurySats` caveat of SPEC §11), `burnedFeeSats`;
  - terms that shape fairness: the floor and the worst-case emission per block at the floor for the current hashrate, the fee recipient and the sentence of §8.6, the mining start height.
  - **Flags:** "Low floor" when `minDifficulty` or `initialDifficulty` is far below what a browser launch would set (for example, under 1 / 1,000 of the difficulty that the current network estimate gives); "Recipient mines cheaper" when `claimFeeSats > 0`.
- **Log entries** show the token, reward, reference height and difficulty, never a recipient. Global stats gain `accepted.mine`.
- **API:**
  - `GET /api/mine` lists mined assets with mining open.
  - `GET /api/mine/:asset` returns `{ asset, ticker, mineStart, span, targetPerSpan, difficulty, staleFloor, target (hex), reward, nextHalving, issued, maxSupply, pendingClaims, feeOutputs: [{ script, sats }], tip: { height, hash }, window: 12, hashrateEstimate }`.
  - Values are decimal strings for bigints.

## 12. Wallet and UX

### 12.1 Mine page (`/app/mine`)

- **Token picker:** mined tokens with mining open. The panel shows:
  - reward, current difficulty, estimated network hashrate, issued / max;
  - the current reference block;
  - cost per claim: Bitcoin fee estimate (~684 vB × a next-block rate) + service fee (+ relay margin).
- **Controls:** Start / Stop; a threads slider (1 … `hardwareConcurrency − 1`, default half); auto-submit (on); a route selector:
  - **Relay balance**, the default when it covers a claim;
  - **Pay with built-in key** (a separate mining fee key, below);
  - **Unisat**.
- **Live figures:**
  - this tab's measured hashrate (10 s average), next to the network estimate;
  - expected time per solution `D / hashrate`;
  - chance of at least one solution in the next block `1 − exp(−600 × hashrate / D)`;
  - solutions found, with status: checking, proving, submitted, landed, expired, rejected;
  - reward earned.
- **Workers:**
  - `web/src/mine-worker.js` is a module worker per thread, using `hash-wasm`. It takes `{ challenge, target, nonceStart, step }` and posts progress and solutions.
  - It runs the vector self-test first. On a mismatch it falls back to noble and the page says "Slow mode: this browser's fast hash failed its test" (about 10× slower), or refuses with "This browser computed a test hash wrong; mining is off".
  - Each worker starts at a random 8-byte nonce.
  - The page polls `/api/mine/:asset` every 15 s.
- **One challenge per solution.** On each new tip, and right after each found solution, the page calls `prepareClaim` again: new output blindings, new ciphertexts, new dummy inputs, new commitments. Then it restarts the workers. No two claims from one wallet share a commitment or a nullifier.
- **Rolling rewards into one note.** `prepareClaim` takes up to two of the wallet's confirmed notes of this asset (members of `R[refHeight]`) as real inputs, so `commitment[0]` carries their value plus the reward. The inputs are locked under W-M until the claim lands or expires. A rejected claim spends nothing.
- **Solution lifecycle:**
  1. **Found.** The page re-verifies the solution once with the reference noble implementation (~40 ms), against the block hash at `refHeight` from its own Bitcoin backend and, when it has a local replay, against its own `D_eff`. If the fast path and the reference disagree, the fast path is disabled. It checks the window, the stale bound and the cap with in-flight claims counted.
  2. **Bind** for the chosen route: the outpoint of a coin chosen now for the built-in key, `sha256(payer script)` for Unisat, `sha256(C)` for relay.
  3. **Prove.** A prover worker runs snarkjs, a few seconds.
  4. **Submit**, then track.

  Invariant W-M (§8.1) applies throughout. Built-in-key claims pay a deadline-safe fee rate (next-block estimate with headroom). A relayed claim has no "Pay the fee myself" fallback while it is pending: paying it yourself would publish the same commitments and nonce from your address and link the two. If the relayer drops it, the solution is usually expired anyway.
- **Mining fee key.** Self-paid claims use a separate built-in key, `hkdf(…, label("btc-mine-fee"))`, never the transfer fee key (`label("btc-fee")`, `session.js`). Mining coins are never used for transfer fees or relay top-ups, and the wallet warns before moving coins between the two.
- **"Prepare coins".** For self-pay, a button splits the mining key's balance into N coins, so many claims can be in flight at once (§8.6).
- **Copy** (honest, no banned words), by route:
  - Relay balance: "The reward goes to a private note. Chain observers see relay claims of TICKER for R each, not who received them. The relayer can link the address you top up from to every claim it carries for you, including the token and the reward. While few people relay claims, the claims right after your top-up are easy to tie to it. Top up before you start mining." The send-screen warning of `relay-balance.md` §5 ("fewer than 5 relayed items since your deposit confirmed") counts relayed claims too.
  - Pay with built-in key or Unisat: "Claims are public: token, reward and the paying address. Anyone can add up what this address mined, and the transfers it pays for later."
  - All routes:
    - "A single GPU or a server miner can be thousands of times faster than this tab. Anyone can rent many computers."
    - "Every claim pays a Bitcoin fee and a service fee of N sats to RECIPIENT. Their own claims cost them N sats less."
    - Near the cap: "Supply is nearly mined out. A claim that lands after the cap is rejected; its Bitcoin fee and its service fee are still spent."
    - Expiry: "A claim must land within 12 blocks of the block it references."
    - Surge: "Difficulty jumped. Solutions found before the jump may no longer count; the wallet checks before paying."
    - Bump: "The fee recipient can block a fee bump, so the wallet pays a next-block rate up front."
    - Signet: "Test coins, no value."
    - Battery and heat note on phones.
- **Launch** (`app-launch.js`) gains "Mined":
  - reward, max supply, solutions per block, span (default 24), expected launch hashrate → suggested initial difficulty, floor (default initial / 16, never below 256), optional halving, claim fee and treasury (per the §7 policy, a standard address only), the start as exactly two choices ("Start mining now" or "Start after N blocks", with the one-line trade-off next to them) and end;
  - the disclosures of §6.2 (noise, surge) and §8.6 (recipient discount).

### 12.2 CLI miner

- `murkle deploy-pow --ticker … --reward … --max-supply … --span 24 --per-block 1 --difficulty … [--min-difficulty …] [--halving …] [--claim-fee … --treasury …] [--start now | --start-after N] [--end h]`. `--start now` is the default.
- `murkle mine <TICKER> [--threads N] [--pay key|relay] [--max-claims n] [--max-fee-rate r] [--prepare-coins n] [--wallet path]`:
  - `worker_threads`, one Argon2 instance per thread, `hash-wasm` (or `crypto.argon2`) after its self-test;
  - a new challenge on each new tip and after each solution;
  - the same reference re-check, stale, window and cap checks as the page, with the block hash from its own backend;
  - proves and submits each solution, printing H/s, solutions, claims landed, and the fees spent.

## 13. Implementation plan

### 13.1 Files

| File | Change |
|---|---|
| `src/params.mjs`, `src/pins.json` | ops 7 – 9 names, `MINE_WINDOW`, `STALE_FACTOR`, `MIN_DIFFICULTY`, span and S bounds, `ARGON`, `MINE_SALT`, `LABELS.mine`, `MINE_FEE`, `STANDARD_SCRIPTS`; the `activations` table (mining height null until release); next `DIGEST_V` / `SNAPSHOT_VERSION` |
| `src/mine.mjs` (new) | `challengeOf`, `solutionIdOf`, `powHash` (hash-wasm after self-test, noble fallback), `targetOf`, `difficultyAt(dPts, h)`, `stepDifficulty`, `effectiveDifficulty`, `rewardAt`, `requiredFeeOutputs`, `isStandardScript`; pure and shared by every side |
| `src/pow-pool.mjs` (new) | bounded worker pool for Argon2 (worker_threads / Web Workers), memoized by `solutionId`; a worker failure rejects the promise, never returns "invalid" |
| `src/envelope.mjs` | encode and strict decode of MINE, MINE_SCRIPT, DEPLOY_POW; **no** height parameter |
| `src/indexer.mjs` | activation rule (§5.1); asset `kind`; `checkMine` in the §5.2 order; `applyMine`; end-of-block difficulty points inside the revert scope; §5.6 journal; digest by activation table; snapshot; stats; log fields |
| `src/wallet.mjs` | `prepareClaim({ rollNotes })` (outputs, inputs, commitments, ciphertexts; fresh each call), `finalizeClaim({ bind, nonce })` (body, extDataHash, proof); W-M locks for solutions and rolled notes |
| `src/verify-tx.mjs`, `web/src/verify/*`, `web/src/share/live-check.js` | MINE receipts: PoW recomputed in the browser; `D_eff` from your own replay when present, otherwise from the indexer with a trust note; replay key and digest version |
| `server/indexer-server.mjs` | `/api/mine`, `/api/mine/:asset`, `/api/digest` version field; PoW through the pool |
| `server/relayer.mjs`, `server/relay-books.mjs`, `src/btc/funding.mjs` | MINE_SCRIPT intake; fee outputs; I0/I1/I2 changes; `serviceOut` in `refundCharge` / `rereserve`; MINE `deadlineOf` and `precheck`; confirmed-only funding and leaf carriers; in-flight cap count; `bind_stale`, `mine_mode`, `mine_unsupported`, `expired`, `stale_work`, `cap_reached`, `busy`; invalid-PoW penalty |
| `bin/murkle.mjs` | `deploy-pow`, `mine` |
| `web/src/session.js` | `btc-mine-fee` key, kept apart from `btc-fee` |
| `web/src/mine-worker.js`, `web/src/views/app-mine.js`, `app-launch.js`, `token.js`, `explorer.js`, `app-shared.js` (relay copy), router | §11, §12 |
| `package.json`, `THIRD_PARTY_NOTICES.md` | `hash-wasm` 4.12.0 exact |
| `SPEC.md`, `docs/API.md`, `relay-balance*.md`, `audit/REPORT.md`, `docs/CLAIMS.md` | in the release, after sign-off (this note changes none of them) |

Same-release cleanup, verdict-neutral: MINT_SCRIPT today fetches the prevout before the asset lookup and before Groth16 (`checkTx`). Moving that fetch after Groth16 changes reasons only, never verdicts or the digest, and closes the same I/O-before-proof gap for free mints.

### 13.2 Tests

- `test/mine-vectors.test.mjs`:
  - the RFC 9106 §5.3 Argon2id vector;
  - `test/fixtures/mine-vectors.json` (≥ 16 entries: nonce 0 and `ff…ff`, zero and random ref hashes, field-max commitments, a hash exactly equal to the target), passed by noble and by hash-wasm in Node;
  - 64 concurrent hash-wasm calls give the same results as sequential noble.
  - The same file runs in the worker self-test. `scripts/check-mine-vectors-browser.mjs` runs it in headless Chromium in CI when available.
- Envelope:
  - lengths 515 / 511, DEPLOY_POW bounds (span, S, `MIN_DIFFICULTY`, standard treasury) and trailing bytes.
- Indexer:
  - **activation:** a DEPLOY_POW, a MINE and a MINE_SCRIPT below activation are `unknown op`, and the digests match the live v1 digests; the digest version switches at the activation height with no mining op present;
  - a claim lands and the reward note is found by scan;
  - a claim with two rolled inputs: `issued` grows by the reward only, the old notes' nullifiers are spent; a rejected one spends nothing;
  - copy in another transaction rejected and nothing consumed;
  - re-proved same solution rejected (`solutionId`);
  - verbatim duplicate rejected;
  - window edges: ref = H − 12 accepted, H − 13 and H rejected; ref < mineStart (= max(startHeight, deployHeight)) rejected; ref = deployHeight accepted when starting now, ref < deployHeight always rejected;
  - difficulty vectors: no claims for 0, 1, n blocks (lazy = eager), one claim, a block at block-space capacity, floor, D_MAX, equilibrium;
  - stale bound: a claim at `D(ref)` accepted when `D(H − 1) ≤ 4·D(ref)` and rejected when above;
  - halving to 0;
  - cap reached mid-block in tx order, with `burnedFeeSats`;
  - fee rule for all three policies and same-script summing;
  - MINT on a mined asset and MINE on a paid asset rejected; shared ticker namespace;
  - **bad PoW never calls `snarkjs.groth16.verify` or the prevout resolver; a bad proof never calls the prevout resolver** (spies);
  - a throwing `powHash` and a dead worker: the block is retried, not rejected;
  - pre-pass: 1,000 copies of one solution evaluate Argon2 once;
  - randomized reorgs restore every mining field, `dPts` and `claimed`;
  - pruning across a 144-block rollback;
  - digest vN golden vectors, including one before `mineStart` and one in a block with claims;
  - snapshot round trip.
- Relayer:
  - only the current C bind accepted; batch modes refused; treasury = deposit script or C refused;
  - exact fee outputs taken from its indexer, not the request;
  - the debit covers fee + service + margin before signing;
  - I2 with `serviceOut` under random sequences, including a 4xx on a MINE carrier (refund reverses `serviceOut`);
  - `signPoolTx` refuses any other output;
  - bad PoW refused before proof verification, penalized and rate-limited; PoW never runs on the main loop;
  - `cap_reached` with in-flight claims, `expired`, `stale_work`, pending `solutionId` dedupe;
  - an item retried across blocks is never broadcast after `ref + 11`; MINE carriers use confirmed coins only and their change is not spent before confirmation.
- Wallet, web and CLI:
  - two solutions on one tip produce no shared commitment or nullifier;
  - workers restart on a new tip and after each solution; W-M lock for solutions and rolled notes;
  - the reference re-check disables a fast path that disagrees;
  - mining fee key separate from the transfer fee key;
  - copy strings pass `english.test.mjs`;
  - CLI `mine` against a fake chain end to end.
- Live signet (approved run): deploy a mined token, mine from a browser and the CLI, claim by self-pay and by relay, roll rewards into one note, then `murkle audit --compare` OK.

### 13.3 Effort (dev-days)

| Step | Days |
|---|---|
| 1. `src/mine.mjs`, PoW pool, vectors, hash-wasm pin, phone measurements | 1.5 |
| 2. Envelope, indexer, activation rule, difficulty, journal, digest, snapshot, tests | 3.5 |
| 3. Wallet claim build (fresh challenges, rolled inputs), CLI deploy-pow and miner | 2.5 |
| 4. Relayer intake, I-PAY changes, deadlines, in-flight cap, tests | 2.5 |
| 5. Mine page, workers, Launch, token page, explorer, copy | 3 |
| 6. Receipts and browser replay | 1.5 |
| 7. SPEC, API, audit addendum, internal adversarial review | 1.5 |
| **Total** | **≈ 16** (plus the live signet run) |

## 14. Open owner decisions

1. **Service-fee recipient** (§7): deployer's treasury, the platform address, or both. Also the amounts (`platformSats`, `deployerMinSats`, `deployerMaxSats`) and the platform script. Needed before the activation height. Whoever receives the fee mines a little cheaper (§7); a low `deployerMaxSats` keeps that small.
2. **Activation height**, and whether mining or BATCH (stage 2) ships first. The `activations` table then decides digest v2 or v3.
3. **Consensus constants to confirm now:** `MINE_WINDOW = 12`, `STALE_FACTOR = 4`, `MIN_DIFFICULTY = 256`, span 12 … 432, `16 ≤ S ≤ 100 × span`. (`MINE_LEAD = 144` was dropped on 2026-10-06, §0 item 6.)
4. `hash-wasm` 4.12.0 is pinned as the default Argon2 for every side (§4.4). It is a new dependency (MIT, no transitive dependencies); confirm.
5. Launch-form defaults: span 24, floor = initial / 16, suggested launch hashrate, explorer "Low floor" threshold.

## 15. Not in this release

- Hybrid tokens (paid mint and mining together).
- Pooled mining with shared payouts. Every claim pays one note; a pool would be an off-chain arrangement.
- MINE inside BATCH.
- A native-code miner.
- A per-claim mining fee on DEPLOY_POW itself.

## 16. Red team review (2026-10-05)

Three lenses (money, consensus-DoS, privacy-fairness) reviewed the first draft. Every finding was checked against the code and, where it made a measurable claim, re-measured: noble Argon2id at 4 MiB took 35 ms per hash and hash-wasm 4.12.0 took 3.6 ms with identical output; noble's `argon2idAsync` let a 1 ms timer fire 0 times; `nextTick` in `@noble/hashes/utils.js` is `async () => {}`; `applyBlock`'s revert scope covers only the transaction loop; MINT_SCRIPT fetches the prevout before Groth16; `maxSendable` takes the two largest notes; the relayer spends unconfirmed change. Emission figures come from an expected-value simulation (§8.7).

| # | Finding | Lens | Severity (red team → judged) | Verdict | Resolution |
|---|---|---|---|---|---|
| 1 | Emission runs away after a quiet period, a low launch difficulty or a surge (×4 clamps, floor, 12-block stale lag) | money | high → high | Real. Simulated ~60k claims vs 200 scheduled at F = 1,000 | Per-block moving-average retarget with no upward clamp (§6.2); stale bound `D(H−1)/4` (§6.1); `MIN_DIFFICULTY`, floor default initial/16, explorer flag (§6.2, §11); figures in §8.7 |
| 2 | Each reward is a separate note; a 2-in circuit makes moving earnings cost one carrier per note | money | medium → medium | Real (`maxSendable`) | MINE may spend up to two own notes of the asset; no circuit change (§4.2, §12.1) |
| 3 | Near the cap, the relayer and wallet ignore in-flight claims and charge for certain failures | money | medium → medium | Real | In-flight `pendingReward` counted at submit and before signing; drop with refund; copy (§6.4, §9) |
| 4 | Relayer deadline built for a 100-block anchor, not a 12-block window; no re-check before broadcast | money | medium → medium | Real (`deadlineOf`, `precheck`) | MINE `deadlineOf = ref + 9`; `precheck` drops on deadline, claimed, cap, stale; next-block fee rate; confirmed coins only (§9) |
| 5 | Service-fee outputs let the recipient pin the relayer's unconfirmed chain and block self-pay RBF | money | low → low | Real (relayer spends unconfirmed change) | MINE carriers are leaves on confirmed coins; deadline-safe fee up front; disclosed (§8.8, §9, §12.1) |
| 6 | Treasury script unconstrained; refunds must reverse service-fee outputs | money | low → low | Real | Treasury must be a standard type; `mine_unsupported` for deposit scripts or C; `serviceOut` reversed in `refundCharge` / `rereserve`; I2 test (§3, §7, §9) |
| 7 | A self-paid claim can burn fees on a solution only a diverging fast path or a stale server believed in | money | low → low | Real | Reference re-check with own-backend block hash before proving; fast path disabled on disagreement (§12.1, §12.2) |
| 8 | Junk PoW is free CPU for any funded relay account and blocks the event loop | money | low → low | Real | Invalid-PoW penalty and rate limit; one check in flight per account; worker pool (§8.5) |
| 9 | Argon2 is 35 – 53 ms with noble, the async variant never yields, a full block freezes the server; verifiers slower than miners | consensus-DoS | high → high | Real (re-measured) | hash-wasm pinned as the default for every side, noble as reference; worker pools only; cost tables redone, phone estimate added (§4.4, §8.5) |
| 10 | Difficulty-1 tokens and fees paid to oneself hollow the work gate; MINE_SCRIPT reaches the prevout fetch before Groth16 | consensus-DoS | medium → medium | Real | Groth16 moved before the fetch (verdict-neutral); `MIN_DIFFICULTY = 256`; §8.5 wording fixed; same reorder for MINT_SCRIPT (§5.2, §13.1) |
| 11 | A naive parallel pre-pass multiplies duplicate claims | consensus-DoS | medium → medium | Real | Pre-pass only after stateless checks, memoized by `solutionId` (§5.2) |
| 12 | An exception inside Argon2 can become an "insufficient work" verdict and split replayers | consensus-DoS | medium → medium | Real as a spec gap | Errors abort and retry the block, never a verdict; test (§5.2) |
| 13 | Gating activation inside `decodeEnvelope` with an optional height can change past verdicts | consensus-DoS | medium → medium | Real | Decoder height-free; explicit indexer rule after decoding; regression fixture (§5.1) |
| 14 | Digest field `epochIndex` undefined before `mineStart` and ambiguous at a retarget | consensus-DoS | medium → medium | Real for the draft | Epochs removed; digest uses stored `[dHeight, dValue]`, defined from the deploy on (§10) |
| 15 | Mining state grows forever and is scanned every block; mined assets are cheap to create | consensus-DoS | low → low | Real | No history in consensus; `dPts` ≤ 14 entries; lazy difficulty; per-block work only for assets with claims; cached `minedHash` lines (§5.5, §6.2, §10) |
| 16 | Undo journal for mining state unspecified; retarget outside the revert scope | consensus-DoS | low → low | Real (`applyBlock`) | §5.5 runs inside the revert scope; §5.6 lists the journaled fields |
| 17 | The ×4 upward clamp lets one hashrate jump fill blocks for several epochs | consensus-DoS | low → low | Real; same root as #1 | No upward clamp (§6.2) |
| 18 | Digest-version text wrong; order with the BATCH release unsettled | consensus-DoS | low → low | Real | Digest switches at activation unconditionally; one `activations` table, cumulative versions (§10) |
| 19 | Solutions found against one tip share commitments: public link and nullifier reuse | consensus-DoS | low → high (merged into #20) | Real | Fresh `prepareClaim` after each solution and each tip; test (§4.3, §12.1) |
| 20 | Reward commitments reused across a session publicly link one miner's claims | privacy-fairness | high → high | Real | Same as #19 |
| 21 | Self-pay links every claim to one address, and the same key pays transfers and top-ups | privacy-fairness | medium → medium | Real (`label("btc-fee")`) | Route-specific copy; relay default; separate `btc-mine-fee` key (§12.1) |
| 22 | Relay route: "cannot see tokens or amounts" becomes false; the timing remedy does not work for claims | privacy-fairness | medium → medium | Real | MINE-specific relay copy; top-up warning counts claims; that sentence not shown for mining (§9, §12.1) |
| 23 | "Pay the fee myself" on a pending relayed claim links the user's address to it | privacy-fairness | medium → medium | Real | Fallback removed while a relayed copy is pending (§12.1) |
| 24 | The fee recipient mines at a discount; "no head start" overstated fairness | privacy-fairness | medium → medium | Real | Disclosed on token page, Mine page and Launch; low `deployerMaxSats` suggested; relayer ordering power disclosed (§7, §8.3, §8.6) |
| 25 | Insiders win a low-difficulty start through readiness, coins and block space | privacy-fairness | medium → medium | Real | `MINE_LEAD = 144` (removed 2026-10-06 by owner decision, §0 item 6: the deployer chooses now or a delay, and the copy says what each favours); `S ≤ 100 × span`; `MIN_DIFFICULTY`; "prepare coins"; "no premine by consensus" wording (§3, §8.6) |
| 26 | Browser vs GPU gap understated; GPU-resistance wording overclaims | privacy-fairness | medium → medium | Real | WASM fast path required in browsers; measured figures; bandwidth-only argument; concrete copy (§4.4, §12.1) |

Result: 26 findings, all real (two pairs share a root cause: #1/#17 and #19/#20), none rejected. None of the fixes changes an owner decision: claims stay unlimited per block, rewards stay fixed and unsplit, the hash stays Argon2id 4 MiB t = 1 p = 1, the operator still pays nothing, and the service-fee recipient stays open (§14 item 1).
